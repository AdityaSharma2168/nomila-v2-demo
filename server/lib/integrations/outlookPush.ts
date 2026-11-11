/**
 * outlookPush.ts — Microsoft Graph change notifications for Outlook (OUTLOOK_PUSH, default off).
 *
 * A notification is a "sync now" SIGNAL, never a payload: the webhook (routes/webhooks.outlook.ts)
 * verifies clientState, stamps outlook_subscriptions.sync_requested_at and returns 202. A debounced
 * per-connection worker then runs the EXISTING delta sync (outlook.syncRecent). All ingest stays on
 * that one path; the @odata.deltaLink in connected_accounts.sync_cursor stays the only sync position.
 *
 *   ensureSubscription      create (or replace) a connection's subscription — called from outlook.onConnected
 *   deleteSubscriptionFor   DELETE the Graph subscription + its row — called on disconnect
 *   acceptNotifications     the webhook's fast path: verify, record, schedule (no Graph call, no message read)
 *   runOutlookSubscriptionCron  renew anything expiring within 48 h, finish lifecycle work, drain lost signals
 *   drainPendingSyncs       run syncs whose in-process timer was lost (instance recycled) — minute sweep
 *   pushCoveredConnectionIds  connections the 6h poll may skip (push healthy + synced within 23 h)
 *
 * Basic notifications only (no resource data, no certificate). changeType is `created` only: a new
 * message is what can start a deal; `updated` fires on every read/flag/categorise and would turn
 * routine triage into delta runs that detectDeal then skips. The daily backstop delta catches anything
 * `created` misses (moves into the Inbox, edits).
 *
 * Duplicate / retried notifications are harmless by construction: the first one in a burst sets
 * sync_requested_at (COALESCE keeps it), every later one is a no-op on the same column, and the worker
 * claims the signal atomically — one delta run per burst, on one instance at a time (sync_started_at lease).
 */

import crypto from "node:crypto";
import { and, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts, outlookSubscriptions, type OutlookSubscription } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";

const logger = createLogger("integrations/outlookPush");

const GRAPH = "https://graph.microsoft.com/v1.0";
/** The subscribed resource. Messages created in the Inbox only — the same folder the delta query reads. */
export const OUTLOOK_RESOURCE = "me/mailFolders('inbox')/messages";
const CHANGE_TYPE = "created";
/** Graph's max for Outlook messages is 10,080 min (7 days); stay a little under it. */
const LIFETIME_MIN = 10_000;
/** Renewal window: the 12-hourly cron renews anything expiring within this. */
const RENEW_WITHIN_HOURS = 48;
/** A worker owns a connection's sync for at most this long; a crashed worker's lease then lapses. */
const LEASE_MINUTES = 10;
/** The minute sweep only takes signals older than this (the in-process timer gets first go). */
const SWEEP_MIN_AGE_SECONDS = 30;
/** With push healthy, the poll still runs a connection whose last sync is older than this (daily backstop). */
const BACKSTOP_HOURS = 23;

let debounceMs = 5_000;
/** Tests only. */
export function configureOutlookPush(opts: { debounceMs?: number }): void {
  if (opts.debounceMs !== undefined) debounceMs = opts.debounceMs;
}

export function outlookPushEnabled(): boolean {
  return process.env.OUTLOOK_PUSH?.trim().toLowerCase() === "true";
}

export const notificationUrl = (): string => `${apiBaseUrl()}/api/v1/webhooks/outlook`;
export const lifecycleUrl    = (): string => `${apiBaseUrl()}/api/v1/webhooks/outlook/lifecycle`;

// ─── clientState ─────────────────────────────────────────────────────────────
// Minted per subscription as HMAC(OUTLOOK_WEBHOOK_SECRET, row id); only its sha256 is stored. Verifying
// against the stored hash means a secret rotation never invalidates a live subscription.

export function mintClientState(subscriptionRowId: string): string {
  const secret = process.env.OUTLOOK_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("OUTLOOK_WEBHOOK_SECRET not set");
  // base64url of a SHA-256 MAC: 43 characters, inside Graph's 128 limit.
  return crypto.createHmac("sha256", secret).update(`outlook-subscription:${subscriptionRowId}`).digest("base64url");
}

export function hashClientState(clientState: string): string {
  return crypto.createHash("sha256").update(clientState).digest("hex");
}

/** Constant-time: sha256(provided) vs the stored hash (both fixed 32 bytes). */
export function clientStateMatches(provided: unknown, storedHash: string): boolean {
  if (typeof provided !== "string" || provided.length === 0 || provided.length > 128) return false;
  const a = Buffer.from(hashClientState(provided), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Graph ───────────────────────────────────────────────────────────────────

export class GraphSubscriptionError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

interface GraphSubscription {
  id:                 string;
  resource?:          string;
  changeType?:        string;
  notificationUrl?:   string;
  expirationDateTime: string;
}

async function graph<T>(token: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
      // Immutable ids in the subscription's resource paths. Never read by us (a notification is only a
      // signal), so this cannot disturb the ids the delta query stores — see outlook.ts.
      Prefer:         'IdType="ImmutableId"',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null) as any;
  if (!res.ok) throw new GraphSubscriptionError(json?.error?.message ?? `Graph ${res.status}`, res.status);
  return json as T;
}

async function tokenFor(connectionId: string): Promise<string> {
  const { getAccessToken } = await import("./outlook.js");
  return getAccessToken(connectionId);
}

const newExpiry = (): Date => new Date(Date.now() + LIFETIME_MIN * 60_000);
const normResource = (r?: string): string => (r ?? "").toLowerCase().replace(/['"()\s]/g, "").replace(/^\/+/, "");

/** DELETE a Graph subscription; an already-gone one (404) counts as deleted. */
async function deleteGraphSubscription(token: string, graphId: string): Promise<void> {
  try {
    await graph(token, "DELETE", `/subscriptions/${encodeURIComponent(graphId)}`);
  } catch (err) {
    if (err instanceof GraphSubscriptionError && err.status === 404) return;
    throw err;
  }
}

/**
 * POST /subscriptions. A 409 means this mailbox already holds a subscription with our changeType + resource
 * (e.g. a row lost to a reconnect or a crashed create). We cannot reuse it — its clientState is unknown to us —
 * so an ORPHAN (no row owns it) is deleted and the create retried once. One owned by ANOTHER connection (two
 * athletes on one mailbox) is left alone: this connection stays on the poll.
 */
async function createGraphSubscription(token: string, clientState: string, connectionId: string): Promise<GraphSubscription> {
  const body = {
    changeType:               CHANGE_TYPE,
    notificationUrl:          notificationUrl(),
    lifecycleNotificationUrl: lifecycleUrl(),
    resource:                 OUTLOOK_RESOURCE,
    expirationDateTime:       newExpiry().toISOString(),
    clientState,
  };
  try {
    return (await graph<GraphSubscription>(token, "POST", "/subscriptions", body))!;
  } catch (err) {
    if (!(err instanceof GraphSubscriptionError && err.status === 409)) throw err;
  }

  const listed = await graph<{ value?: GraphSubscription[] }>(token, "GET", "/subscriptions");
  const dupes = (listed?.value ?? []).filter((s) =>
    normResource(s.resource) === normResource(OUTLOOK_RESOURCE) && s.notificationUrl === notificationUrl());
  const owned = dupes.length
    ? await db.select({ graph_subscription_id: outlookSubscriptions.graph_subscription_id, connected_account_id: outlookSubscriptions.connected_account_id })
        .from(outlookSubscriptions)
        .where(inArray(outlookSubscriptions.graph_subscription_id, dupes.map((d) => d.id)))
    : [];
  const ownedByOther = owned.find((o) => o.connected_account_id !== connectionId);
  if (ownedByOther) {
    throw new GraphSubscriptionError(`mailbox already subscribed by connection ${ownedByOther.connected_account_id}`, 409);
  }
  for (const d of dupes) await deleteGraphSubscription(token, d.id);
  logger.warn({ connectionId, removed: dupes.length }, "Outlook push: 409 on create — removed the duplicate and retried");
  return (await graph<GraphSubscription>(token, "POST", "/subscriptions", body))!;
}

// ─── Subscription lifecycle ──────────────────────────────────────────────────

async function rowFor(connectionId: string): Promise<OutlookSubscription | undefined> {
  const [row] = await db.select().from(outlookSubscriptions)
    .where(eq(outlookSubscriptions.connected_account_id, connectionId)).limit(1);
  return row;
}

/**
 * Create this connection's subscription, replacing any earlier one (a reconnect). No-op with the flag off.
 * Graph validates notificationUrl AND lifecycleNotificationUrl synchronously during this POST, so the
 * webhook routes must be reachable at apiBaseUrl() when this runs.
 */
export async function ensureSubscription(connectionId: string): Promise<OutlookSubscription | null> {
  if (!outlookPushEnabled()) return null;
  const token = await tokenFor(connectionId);

  const existing = await rowFor(connectionId);
  if (existing) {
    await deleteGraphSubscription(token, existing.graph_subscription_id).catch((err: any) =>
      logger.warn({ connectionId, error: err.message }, "Outlook push: could not delete the previous subscription — it will expire"),
    );
  }

  const rowId       = existing?.id ?? crypto.randomUUID();
  const clientState = mintClientState(rowId);
  const created     = await createGraphSubscription(token, clientState, connectionId);

  const values = {
    graph_subscription_id: created.id,
    resource:              OUTLOOK_RESOURCE,
    expires_at:            new Date(created.expirationDateTime),
    client_state_hash:     hashClientState(clientState),
    status:                "active",
    updated_at:            new Date(),
  };
  const [row] = await db.insert(outlookSubscriptions)
    .values({ id: rowId, connected_account_id: connectionId, ...values })
    .onConflictDoUpdate({ target: outlookSubscriptions.connected_account_id, set: values })
    .returning();

  logger.info({ connectionId, expiresAt: values.expires_at }, "Outlook push: subscription created");
  return row;
}

/** PATCH a new expirationDateTime (also the answer to reauthorizationRequired). A gone subscription is recreated. */
async function renewSubscription(row: OutlookSubscription): Promise<"renewed" | "recreated"> {
  if (row.resource !== OUTLOOK_RESOURCE) {
    await recreateAndSync(row.connected_account_id);
    return "recreated";
  }
  const token = await tokenFor(row.connected_account_id);
  try {
    const patched = await graph<GraphSubscription>(token, "PATCH", `/subscriptions/${encodeURIComponent(row.graph_subscription_id)}`,
      { expirationDateTime: newExpiry().toISOString() });
    await db.update(outlookSubscriptions).set({
      expires_at: patched?.expirationDateTime ? new Date(patched.expirationDateTime) : newExpiry(),
      status:     "active",
      updated_at: new Date(),
    }).where(eq(outlookSubscriptions.id, row.id));
    return "renewed";
  } catch (err) {
    if (err instanceof GraphSubscriptionError && err.status === 404) {
      await recreateAndSync(row.connected_account_id);
      return "recreated";
    }
    throw err;
  }
}

/** subscriptionRemoved / expired: recreate, then run delta — anything that arrived in the gap was never notified. */
async function recreateAndSync(connectionId: string): Promise<void> {
  await ensureSubscription(connectionId);
  await requestSync(connectionId);
}

/** Disconnect: DELETE the Graph subscription (best-effort; it would expire anyway) and drop the row. Flag-independent. */
export async function deleteSubscriptionFor(connectionId: string): Promise<boolean> {
  const row = await rowFor(connectionId);
  if (!row) return false;
  try {
    const token = await tokenFor(connectionId);
    await deleteGraphSubscription(token, row.graph_subscription_id);
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message }, "Outlook push: Graph DELETE failed on disconnect — it will expire");
  }
  await db.delete(outlookSubscriptions).where(eq(outlookSubscriptions.id, row.id));
  logger.info({ connectionId }, "Outlook push: subscription deleted");
  return true;
}

// ─── The signal → debounced worker ───────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Record "sync this connection soon". The first signal in a burst sets the time; the rest are no-ops. */
async function requestSync(connectionId: string, notified = false): Promise<void> {
  await db.update(outlookSubscriptions).set({
    sync_requested_at: sql`COALESCE(${outlookSubscriptions.sync_requested_at}, now())`,
    ...(notified ? { last_notification_at: sql`now()` } : {}),
  }).where(eq(outlookSubscriptions.connected_account_id, connectionId));
  scheduleSync(connectionId);
}

/** One timer per connection per instance: every notification inside the window rides the same run. */
function scheduleSync(connectionId: string): void {
  if (timers.has(connectionId)) return;
  const t = setTimeout(() => {
    timers.delete(connectionId);
    runPendingSync(connectionId).catch((err: any) =>
      logger.error({ connectionId, error: err.message }, "Outlook push: sync worker threw"));
  }, debounceMs);
  t.unref?.();
  timers.set(connectionId, t);
}

/**
 * Claim the connection's pending signal (atomically: clears it and takes the lease) and run the existing delta
 * sync. Returns false when there was nothing to claim — no signal, or another worker holds the lease (it
 * re-checks for a fresh signal when it finishes, so nothing is dropped).
 */
export async function runPendingSync(connectionId: string): Promise<boolean> {
  const [claimed] = await db.update(outlookSubscriptions).set({
    sync_requested_at: null,
    sync_started_at:   sql`now()`,
  }).where(and(
    eq(outlookSubscriptions.connected_account_id, connectionId),
    isNotNull(outlookSubscriptions.sync_requested_at),
    or(
      sql`${outlookSubscriptions.sync_started_at} IS NULL`,
      lt(outlookSubscriptions.sync_started_at, sql`now() - interval '${sql.raw(String(LEASE_MINUTES))} minutes'`),
    ),
  )).returning({ id: outlookSubscriptions.id });
  if (!claimed) return false;

  try {
    const [conn] = await db.select({ athlete_id: connectedAccounts.athlete_id, status: connectedAccounts.status })
      .from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1);
    if (conn?.status !== "active") {
      logger.info({ connectionId, status: conn?.status }, "Outlook push: connection not active — signal dropped");
      return true;
    }
    const { syncRecent } = await import("./outlook.js");
    const r = await syncRecent(connectionId, conn.athlete_id);
    logger.info({ connectionId, ...r }, "Outlook push: delta sync complete");
  } catch (err: any) {
    // The daily backstop (and the next notification) will pick it up; the cursor only advances on success.
    logger.warn({ connectionId, error: err.message }, "Outlook push: delta sync failed");
  } finally {
    await db.update(outlookSubscriptions).set({ sync_started_at: null }).where(eq(outlookSubscriptions.id, claimed.id));
    const [after] = await db.select({ pending: outlookSubscriptions.sync_requested_at })
      .from(outlookSubscriptions).where(eq(outlookSubscriptions.id, claimed.id)).limit(1);
    if (after?.pending) scheduleSync(connectionId);   // mail arrived while we were syncing
  }
  return true;
}

/** Signals whose timer died with its instance. Run by the in-process minute sweep and the 12-hourly cron. */
export async function drainPendingSyncs(): Promise<number> {
  if (!outlookPushEnabled()) return 0;
  const rows = await db.select({ connectionId: outlookSubscriptions.connected_account_id }).from(outlookSubscriptions)
    .where(lt(outlookSubscriptions.sync_requested_at, sql`now() - interval '${sql.raw(String(SWEEP_MIN_AGE_SECONDS))} seconds'`));
  let ran = 0;
  for (const r of rows) if (await runPendingSync(r.connectionId)) ran++;
  return ran;
}

// ─── Webhook fast path ───────────────────────────────────────────────────────

export interface GraphNotificationItem {
  subscriptionId?: string;
  clientState?:    string | null;
  changeType?:     string;
  lifecycleEvent?: string;
}

export interface AcceptOutcome {
  accepted: number;
  /** clientState missing or wrong for a subscription we know: forged or misrouted. Nothing recorded. */
  rejected: number;
  /** A subscription id we have no row for (deleted on disconnect, still alive at Graph until it expires). */
  unknown:  number;
}

/**
 * Verify and record a batch; never calls Graph and never reads a message, so the route can answer within
 * Graph's 3 s budget. Lifecycle work that needs Graph is recorded durably (status) and then started
 * without being awaited; the cron retries it if this instance dies first.
 */
export async function acceptNotifications(items: GraphNotificationItem[], kind: "change" | "lifecycle"): Promise<AcceptOutcome> {
  const out: AcceptOutcome = { accepted: 0, rejected: 0, unknown: 0 };
  const ids = [...new Set(items.map((i) => i.subscriptionId).filter((x): x is string => typeof x === "string" && x.length > 0))];
  const rows = ids.length
    ? await db.select().from(outlookSubscriptions).where(inArray(outlookSubscriptions.graph_subscription_id, ids))
    : [];
  const byGraphId = new Map(rows.map((r) => [r.graph_subscription_id, r]));

  for (const item of items) {
    const row = item.subscriptionId ? byGraphId.get(item.subscriptionId) : undefined;
    if (!row) { out.unknown++; continue; }
    if (!clientStateMatches(item.clientState, row.client_state_hash)) { out.rejected++; continue; }
    out.accepted++;
    // Flag off: verified but ignored — the poll is in charge, and the subscription simply expires.
    if (!outlookPushEnabled()) continue;
    if (kind === "change") await requestSync(row.connected_account_id, true);
    else await acceptLifecycle(row, item.lifecycleEvent);
  }
  return out;
}

async function acceptLifecycle(row: OutlookSubscription, event: string | undefined): Promise<void> {
  const connectionId = row.connected_account_id;
  await db.update(outlookSubscriptions).set({ last_notification_at: sql`now()` }).where(eq(outlookSubscriptions.id, row.id));
  switch (event) {
    case "missed":
      await requestSync(connectionId);
      return;
    case "reauthorizationRequired":
      // PATCH only (never also /reauthorize — Graph refuses both within 10 minutes).
      await setStatus(row.id, "reauthorize_required");
      void renewSubscription(row).catch((err: any) =>
        logger.warn({ connectionId, error: err.message }, "Outlook push: reauthorize (PATCH) failed — cron retries"));
      return;
    case "subscriptionRemoved":
      await setStatus(row.id, "removed");
      void recreateAndSync(connectionId).catch((err: any) =>
        logger.warn({ connectionId, error: err.message }, "Outlook push: recreate failed — cron retries"));
      return;
    default:
      logger.warn({ connectionId, event }, "Outlook push: unknown lifecycle event ignored");
  }
}

async function setStatus(id: string, status: "reauthorize_required" | "removed"): Promise<void> {
  await db.update(outlookSubscriptions).set({ status, updated_at: new Date() }).where(eq(outlookSubscriptions.id, id));
}

// ─── Cron: renew, finish lifecycle work, drain ───────────────────────────────

export interface OutlookSubscriptionCronResult {
  enabled:   boolean;
  renewed:   number;
  recreated: number;
  removed:   number;
  failed:    number;
  drained:   number;
}

export async function runOutlookSubscriptionCron(): Promise<OutlookSubscriptionCronResult> {
  const result: OutlookSubscriptionCronResult = { enabled: outlookPushEnabled(), renewed: 0, recreated: 0, removed: 0, failed: 0, drained: 0 };
  if (!result.enabled) return result;

  const due = await db.select({ sub: outlookSubscriptions, connStatus: connectedAccounts.status })
    .from(outlookSubscriptions)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, outlookSubscriptions.connected_account_id))
    .where(or(
      lt(outlookSubscriptions.expires_at, sql`now() + interval '${sql.raw(String(RENEW_WITHIN_HOURS))} hours'`),
      ne(outlookSubscriptions.status, "active"),
    ));

  for (const { sub, connStatus } of due) {
    try {
      if (connStatus !== "active") {
        // Disconnected/expired connection whose row outlived it: stop the subscription instead of renewing it.
        await deleteSubscriptionFor(sub.connected_account_id);
        result.removed++;
      } else if (sub.status === "removed" || sub.expires_at.getTime() <= Date.now()) {
        await recreateAndSync(sub.connected_account_id);
        result.recreated++;
      } else {
        const r = await renewSubscription(sub);
        if (r === "renewed") result.renewed++; else result.recreated++;
      }
    } catch (err: any) {
      result.failed++;
      logger.warn({ connectionId: sub.connected_account_id, error: err.message }, "Outlook push: renewal failed");
    }
  }

  result.drained = await drainPendingSyncs();
  logger.info({ ...result }, "Outlook subscription cron complete");
  return result;
}

// ─── Sync position: the poll becomes a daily backstop ────────────────────────

/**
 * Outlook connections the 6h poll may skip this tick: push is on, the subscription is active and unexpired,
 * and the connection's delta ran within BACKSTOP_HOURS. Everything else polls exactly as before — so with the
 * flag off this returns an empty set without touching the database.
 */
export async function pushCoveredConnectionIds(): Promise<Set<string>> {
  if (!outlookPushEnabled()) return new Set();
  const rows = await db.select({ id: outlookSubscriptions.connected_account_id })
    .from(outlookSubscriptions)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, outlookSubscriptions.connected_account_id))
    .where(and(
      eq(outlookSubscriptions.status, "active"),
      sql`${outlookSubscriptions.expires_at} > now()`,
      sql`${connectedAccounts.last_fetched_at} > now() - interval '${sql.raw(String(BACKSTOP_HOURS))} hours'`,
    ));
  return new Set(rows.map((r) => r.id));
}
