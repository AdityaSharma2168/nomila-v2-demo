/**
 * services/push/push.ts — phone notifications through Expo's push service (expo-server-sdk), behind PUSH_NOTIFICATIONS
 * (off unless "true"). Design "Goals tab post details + plan ready", PR D (owner, 12 Oct 2026: build push now).
 *
 *   registerDevice / removeDevice / removeAllDevices   the Expo push token her app registers on sign-in (POST
 *                                                      /me/push/devices) and removes on sign-out; at most 10 phones per
 *                                                      athlete (the oldest goes); a token Expo reports gone is removed
 *   readPreferences / writePreferences                 her choices: on/off, each kind, quiet hours, brand names (Settings)
 *   sendPush                                           one notification to her phones, ONCE per dedupe key:
 *     - nothing while the switch is off, the kind is off, or no phone is registered;
 *     - coalesced: an event with a `coalesce` prefix is skipped when one with that prefix went out within its window
 *       (a burst of brand replies on one deal is one notification per 3 hours);
 *     - capped: at most PUSH_DAILY_CAP (default 8) notifications per athlete in any 24 hours, all kinds together;
 *     - in quiet hours (her phone's time zone) it still arrives, but quietly: no sound, iOS "passive" (Notification
 *       Centre only, the screen does not light), Android's low-importance "quiet" channel;
 *     - lock-screen privacy: a brand's name shows only when she turned "Show brand names in notifications" on;
 *     - the text is fixed copy built by code (events.ts), never a model's; it carries the screen a tap opens and
 *       nothing else (no email text, no amounts);
 *     - a send that fails after its dedupe row was claimed records an error code on the row and may be retried once.
 *   checkReceipts                                      the receipts cron: Expo's delivery receipts for recent sends;
 *                                                      DeviceNotRegistered removes the phone, any other error code
 *                                                      (InvalidCredentials, …) is recorded on the send row; the tickets
 *                                                      (Expo ticket id + the phone's row id, never a token) are cleared
 *                                                      once read
 *   retryFailedSends                                   the same cron: the one retry, for real (events.ts rebuilds the
 *                                                      event from its key)
 *
 * Web (the dev web build, EXPO_PUBLIC_WEB_V2): a browser registers its Firebase Cloud Messaging token with platform
 * "web", and sendPush sends to it through FCM (firebase-admin, the app's existing Application Default Credentials) as a
 * data-only message the site's service worker shows — same words, same target, quiet hours as a silent notification.
 * FCM answers per token at once (no receipts): a token FCM says is gone is removed on the spot. Phones are unchanged.
 *
 * A notification only tells her something: it never sends, posts, accepts or pays anything on her behalf (tap-to-send).
 * Never throws: a failed push must never fail the work that caused it. Tests inject the Expo client and the FCM client
 * (never reach Expo or Google).
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { pushDevices, pushPreferences, pushSends } from "../../../shared/schema";
import { createLogger } from "../../logger";

const logger = createLogger("services/push");
const HOUR = 3_600_000;

export const pushEnabled = (): boolean => process.env.PUSH_NOTIFICATIONS === "true";

/** At most this many notifications per athlete in any 24 hours, every kind together (PUSH_DAILY_CAP, default 8). */
export const pushDailyCap = (): number => {
  const n = Number(process.env.PUSH_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : 8;
};
/** At most this many phones per athlete: a new one past it drops the one used longest ago. */
export const MAX_DEVICES = 10;

// payment_received rides her "A brand replied" switch (brand news about a deal): no new preference column.
// mila_message (MILA_PROACTIVE, agent/proactive): a message Mila started from an app event; the athlete's switch it obeys
// is the event's own (PushEvent.pref), so no new preference column.
// mila_reply (agent/engine/replyPush.ts): the reply she asked for is ready after she left the chat. She asked for it, so
// it obeys only her "all notifications" switch (no kind switch, and no Mila pacing).
export const PUSH_KINDS = ["plan_ready", "brand_reply", "waiting", "mila_suggestion", "booking", "payment_received", "mila_message", "mila_reply"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * Where a tap lands: a semantic screen the app maps (client/lib/agent/navigate.ts routeFor), never a route name. For
 * "mila", `id` is the conversation and `messageId` the message the app opens on (a Mila-started message).
 */
export interface PushTarget { screen: "goals" | "opportunities" | "mila" | "booking"; id?: string; messageId?: string }

export interface PushEvent {
  kind: PushKind;
  /** One event, one push: a plan run, a message, an approval item. */
  dedupeKey: string;
  /** The words with no name in them: what shows unless she turned brand names on. */
  title: string;
  body: string;
  /** The same with the brand's name, shown only when she turned "Show brand names in notifications" on. */
  named?: { title: string; body?: string };
  /** Skip this event when one whose dedupe key starts with `prefix` went out within `withinMs`. */
  coalesce?: { prefix: string; withinMs: number };
  target: PushTarget;
  /** The athlete's switch this event obeys, when not its kind's own (a Mila message obeys the event's switch). */
  pref?: PushPrefKey;
  /**
   * One live notification per thing (Expo push fields): `collapseId` replaces an earlier notification with the same id
   * on the lock screen (Android `tag` too); `threadId` groups them on iOS. Built from the event's key.
   */
  collapseId?: string;
  threadId?: string;
}

export type PushPrefKey = "planReady" | "brandReply" | "waiting" | "milaSuggestion";

export interface PushPreferencesView {
  enabled: boolean;
  planReady: boolean;
  brandReply: boolean;
  waiting: boolean;
  /** "Mila's suggestions": a suggested change to her strategy from a research refresh (0135; default on). */
  milaSuggestion: boolean;
  quietHours: boolean;
  /** Minutes after local midnight. */
  quietStart: number;
  quietEnd: number;
  /** Lock-screen privacy: a brand's name in a notification only when on (default off). */
  showBrandNames: boolean;
}

export const DEFAULT_PREFERENCES: PushPreferencesView = {
  enabled: true, planReady: true, brandReply: true, waiting: true, milaSuggestion: true, quietHours: true, quietStart: 22 * 60, quietEnd: 8 * 60, showBrandNames: false,
};

/** The switch each kind obeys besides "all notifications"; null: that switch alone. */
const KIND_PREF: Record<PushKind, PushPrefKey | null> = {
  mila_reply: null,
  // A Mila-started message without an event switch of its own rides "Mila's suggestions".
  mila_message: "milaSuggestion",
  plan_ready: "planReady", brand_reply: "brandReply", waiting: "waiting", mila_suggestion: "milaSuggestion",
  // Bookings wait on her tap like approvals do: the same switch ("Waiting on your tap") covers them.
  booking: "waiting",
  payment_received: "brandReply",
};

/** The parts of expo-server-sdk this uses (tests pass a fake: tests never reach Expo). */
export interface PushClient {
  chunkPushNotifications(messages: PushMessage[]): PushMessage[][];
  sendPushNotificationsAsync(messages: PushMessage[]): Promise<PushTicket[]>;
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, PushReceipt>>;
}
export interface PushMessage {
  to: string; title: string; body: string; data: Record<string, unknown>;
  sound: "default" | null; priority: "default" | "high"; interruptionLevel: "active" | "passive"; channelId: string;
  collapseId?: string; threadId?: string; tag?: string;
}
export type PushTicket = { status: "ok"; id: string } | { status: "error"; message: string; details?: { error?: string } };
export type PushReceipt = { status: "ok" } | { status: "error"; message: string; details?: { error?: string } };

let client: PushClient | null = null;
/** Tests: inject the Expo client (null → the real one, built lazily). */
export function setPushClient(c: PushClient | null): void { client = c; }
async function pushClient(): Promise<PushClient> {
  if (client) return client;
  const { Expo } = await import("expo-server-sdk");
  // EXPO_ACCESS_TOKEN only when the project turns on Expo's enhanced push security; absent is fine otherwise.
  client = new Expo(process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {}) as unknown as PushClient;
  return client;
}

/** An Expo push token, by shape (ExponentPushToken[…] / ExpoPushToken[…]). */
export const isPushToken = (t: unknown): t is string => typeof t === "string" && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(t);

/** A browser's FCM registration token, by shape (long, URL-safe characters and colons; never an Expo token). */
export const isWebPushToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_:-]{100,4096}$/.test(t);

const PLATFORMS = new Set(["ios", "android"]);
/** A device row this service can send to: a phone's Expo token, or a browser's FCM token. */
const sendable = (d: { platform: string; token: string }): boolean => (d.platform === "web" ? isWebPushToken(d.token) : isPushToken(d.token));

// ─── FCM for web ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One browser notification as FCM takes it: data only (every value a string); the service worker shows it. */
export interface WebPushMessage {
  token: string;
  data: { title: string; body: string; kind: string; target: string; quiet: "1" | "0" };
  webpush: { headers: { Urgency: "high" | "normal"; TTL: string } };
}
export type WebPushResult = { ok: true } | { ok: false; code: string };
/** The part of firebase-admin messaging this uses (tests pass a fake: tests never reach Google). */
export interface WebPushClient { sendEach(messages: WebPushMessage[]): Promise<WebPushResult[]> }

/** FCM's answers that mean the browser's token is gone for good: the row is removed. */
const FCM_GONE = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

let webClient: WebPushClient | null = null;
/** Tests: inject the FCM client (null → the real one, built lazily on the app's Firebase Admin). */
export function setWebPushClient(c: WebPushClient | null): void { webClient = c; }
async function webPushClient(): Promise<WebPushClient> {
  if (webClient) return webClient;
  const [{ getApps, initializeApp }, { getMessaging }] = await Promise.all([import("firebase-admin/app"), import("firebase-admin/messaging")]);
  if (getApps().length === 0) initializeApp();
  const messaging = getMessaging();
  webClient = {
    async sendEach(messages) {
      const out: WebPushResult[] = [];
      for (let i = 0; i < messages.length; i += 500) {
        const batch = await messaging.sendEach(messages.slice(i, i + 500));
        for (const r of batch.responses) out.push(r.success ? { ok: true } : { ok: false, code: r.error?.code ?? "error" });
      }
      return out;
    },
  };
  return webClient;
}
const zoneOk = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

// ─── Devices ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Register (or refresh) this phone for the athlete the app has selected. A token another athlete held moves to this one:
 * the same phone signing in as someone else, or switching between the profiles of one account (the app re-registers on
 * every switch), must follow whoever is using it.
 *
 * Accepted risk (owner review, 12 Oct): a caller who somehow held ANOTHER phone's Expo token could move it to their own
 * account, so that phone would get the caller's notifications and stop getting its owner's. Tokens are issued by Expo to
 * the app on the phone itself and are never returned by any Nomila API or export, notifications carry no private text,
 * and the route is rate-limited — so this is accepted rather than proven by a device attestation.
 */
export async function registerDevice(athleteId: string, input: { token: unknown; platform: unknown; timeZone?: unknown }): Promise<boolean> {
  // A phone sends its Expo token with ios/android; a browser (the dev web build) its FCM token with "web".
  if (typeof input.token !== "string" || typeof input.platform !== "string") return false;
  const phone = PLATFORMS.has(input.platform) && isPushToken(input.token);
  const browser = input.platform === "web" && isWebPushToken(input.token);
  if (!phone && !browser) return false;
  const timeZone = zoneOk(input.timeZone) ? input.timeZone : null;
  await db.insert(pushDevices).values({ athlete_id: athleteId, token: input.token, platform: input.platform, time_zone: timeZone })
    .onConflictDoUpdate({ target: pushDevices.token, set: { athlete_id: athleteId, platform: input.platform, time_zone: timeZone, last_seen_at: new Date() } });
  // At most MAX_DEVICES phones: the ones used longest ago go.
  const keep = (await db.select({ id: pushDevices.id }).from(pushDevices).where(eq(pushDevices.athlete_id, athleteId))
    .orderBy(desc(pushDevices.last_seen_at), desc(pushDevices.created_at)).limit(MAX_DEVICES)).map((r) => r.id);
  if (keep.length >= MAX_DEVICES) await db.delete(pushDevices).where(and(eq(pushDevices.athlete_id, athleteId), notInArray(pushDevices.id, keep)));
  return true;
}

/** Sign-out: this phone stops getting her notifications. Only her own row can go. */
export async function removeDevice(athleteId: string, token: unknown): Promise<number> {
  if (typeof token !== "string" || !token) return 0;
  const gone = await db.delete(pushDevices).where(and(eq(pushDevices.athlete_id, athleteId), eq(pushDevices.token, token))).returning({ id: pushDevices.id });
  return gone.length;
}

export async function removeAllDevices(athleteId: string): Promise<number> {
  return (await db.delete(pushDevices).where(eq(pushDevices.athlete_id, athleteId)).returning({ id: pushDevices.id })).length;
}

// ─── Preferences ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function readPreferences(athleteId: string): Promise<PushPreferencesView> {
  const [r] = await db.select().from(pushPreferences).where(eq(pushPreferences.athlete_id, athleteId)).limit(1);
  if (!r) return { ...DEFAULT_PREFERENCES };
  return {
    enabled: r.enabled, planReady: r.plan_ready, brandReply: r.brand_reply, waiting: r.waiting, milaSuggestion: r.mila_suggestion, quietHours: r.quiet_hours,
    quietStart: r.quiet_start, quietEnd: r.quiet_end, showBrandNames: r.show_brand_names,
  };
}

const minutes = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1440 ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Change her choices (only the fields given, each checked); answers the whole set. */
export async function writePreferences(athleteId: string, patch: Record<string, unknown>): Promise<PushPreferencesView> {
  const cur = await readPreferences(athleteId);
  const next: PushPreferencesView = {
    enabled: bool(patch.enabled) ?? cur.enabled,
    planReady: bool(patch.planReady) ?? cur.planReady,
    brandReply: bool(patch.brandReply) ?? cur.brandReply,
    waiting: bool(patch.waiting) ?? cur.waiting,
    milaSuggestion: bool(patch.milaSuggestion) ?? cur.milaSuggestion,
    quietHours: bool(patch.quietHours) ?? cur.quietHours,
    quietStart: minutes(patch.quietStart) ?? cur.quietStart,
    quietEnd: minutes(patch.quietEnd) ?? cur.quietEnd,
    showBrandNames: bool(patch.showBrandNames) ?? cur.showBrandNames,
  };
  const row = {
    enabled: next.enabled, plan_ready: next.planReady, brand_reply: next.brandReply, waiting: next.waiting, mila_suggestion: next.milaSuggestion,
    quiet_hours: next.quietHours, quiet_start: next.quietStart, quiet_end: next.quietEnd, show_brand_names: next.showBrandNames,
    updated_at: new Date(),
  };
  await db.insert(pushPreferences).values({ athlete_id: athleteId, ...row }).onConflictDoUpdate({ target: pushPreferences.athlete_id, set: row });
  return next;
}

// ─── Quiet hours ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Minutes after midnight on the phone's clock (UTC when the zone is unknown). */
export function localMinutes(now: Date, timeZone: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone ?? "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch { return now.getUTCHours() * 60 + now.getUTCMinutes(); }
}

/** Inside [start, end), a window that may cross midnight (22:00–08:00). Equal ends: never quiet. */
export function inQuietHours(p: Pick<PushPreferencesView, "quietHours" | "quietStart" | "quietEnd">, at: number): boolean {
  if (!p.quietHours || p.quietStart === p.quietEnd) return false;
  return p.quietStart < p.quietEnd ? at >= p.quietStart && at < p.quietEnd : at >= p.quietStart || at < p.quietEnd;
}

// ─── Send ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SendResult {
  status: "off" | "opted_out" | "no_device" | "coalesced" | "capped" | "duplicate" | "sent" | "failed";
  devices?: number;
  quiet?: boolean;
}

/** A send row that went out, or is going out now (a failed one does not count toward a window or the cap). */
const live = () => or(gt(pushSends.devices, 0), isNull(pushSends.error));

/** Claim the dedupe row; a failed first attempt may be claimed once more (attempts 1 → 2). Null: already done. */
async function claim(athleteId: string, event: PushEvent, quiet: boolean): Promise<string | null> {
  const key = event.dedupeKey.slice(0, 200);
  const [fresh] = await db.insert(pushSends).values({ athlete_id: athleteId, kind: event.kind, dedupe_key: key, quiet })
    .onConflictDoNothing().returning({ id: pushSends.id });
  if (fresh) return fresh.id;
  const [retry] = await db.update(pushSends).set({ attempts: 2, error: null, devices: 0, quiet, tickets: null })
    .where(and(eq(pushSends.athlete_id, athleteId), eq(pushSends.dedupe_key, key), eq(pushSends.attempts, 1), eq(pushSends.devices, 0), isNotNull(pushSends.error)))
    .returning({ id: pushSends.id });
  return retry?.id ?? null;
}

export async function sendPush(athleteId: string, event: PushEvent, opts: { now?: Date } = {}): Promise<SendResult> {
  if (!pushEnabled()) return { status: "off" };
  const now = opts.now ?? new Date();
  let claimed: string | null = null;
  try {
    const prefs = await readPreferences(athleteId);
    const kindPref = event.pref ?? KIND_PREF[event.kind];
    if (!prefs.enabled || (kindPref && !prefs[kindPref])) return { status: "opted_out" };
    const all = (await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, athleteId))).filter(sendable);
    if (!all.length) return { status: "no_device" };
    const devices = all.filter((d) => d.platform !== "web");
    const browsers = all.filter((d) => d.platform === "web");

    if (event.coalesce) {
      const [recent] = await db.select({ id: pushSends.id }).from(pushSends).where(and(
        eq(pushSends.athlete_id, athleteId), sql`${pushSends.dedupe_key} LIKE ${`${event.coalesce.prefix}%`}`,
        gt(pushSends.created_at, new Date(now.getTime() - event.coalesce.withinMs)), live(),
      )).limit(1);
      if (recent) return { status: "coalesced" };
    }
    // The daily cap, every kind together (idx_push_sends_athlete: athlete_id, created_at).
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(pushSends)
      .where(and(eq(pushSends.athlete_id, athleteId), gt(pushSends.created_at, new Date(now.getTime() - 24 * HOUR)), live()));
    if (n >= pushDailyCap()) return { status: "capped" };

    // The phone (or browser) she used last tells the clock quiet hours are read on.
    const latest = [...all].sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())[0];
    const quiet = inQuietHours(prefs, localMinutes(now, latest.time_zone));

    // Once per event: the row is claimed BEFORE anything is sent (a retry, or two instances, send nothing new).
    claimed = await claim(athleteId, event, quiet);
    if (!claimed) return { status: "duplicate" };

    const words = prefs.showBrandNames && event.named ? { title: event.named.title, body: event.named.body ?? event.body } : { title: event.title, body: event.body };
    const messages: PushMessage[] = devices.map((d) => ({
      to: d.token, title: words.title.slice(0, 120), body: words.body.slice(0, 240),
      data: { kind: event.kind, target: event.target },
      sound: quiet ? null : "default", priority: quiet ? "default" : "high", interruptionLevel: quiet ? "passive" : "active",
      channelId: quiet ? "quiet" : "default",
      ...(event.collapseId ? { collapseId: event.collapseId.slice(0, 64), tag: event.collapseId.slice(0, 64) } : {}),
      ...(event.threadId ? { threadId: event.threadId.slice(0, 64) } : {}),
    }));
    const tickets: PushTicket[] = [];
    if (messages.length) {
      const c = await pushClient();
      for (const chunk of c.chunkPushNotifications(messages)) tickets.push(...(await c.sendPushNotificationsAsync(chunk)));
    }

    // A phone Expo no longer knows is removed; the first other error is kept on the send row (a code, no text). The ok
    // tickets are kept until the receipts cron has read them.
    const gone: string[] = [];
    let error: string | null = null;
    // Tickets hold the phone's row id, never its token (push_sends is exported; a token is a device credential).
    const okTickets: Array<{ id: string; deviceId: string }> = [];
    tickets.forEach((t, i) => {
      if (t.status === "ok") { if (devices[i]) okTickets.push({ id: t.id, deviceId: devices[i].id }); return; }
      if (t.details?.error === "DeviceNotRegistered" && messages[i]) gone.push(messages[i].to);
      else error = error ?? (t.details?.error ?? "error");
    });
    // Browsers (FCM): answered per token at once — a gone token is removed now, any other code kept like Expo's.
    let webOk = 0;
    if (browsers.length) {
      const webMessages: WebPushMessage[] = browsers.map((d) => ({
        token: d.token,
        data: { title: words.title.slice(0, 120), body: words.body.slice(0, 240), kind: event.kind, target: JSON.stringify(event.target), quiet: quiet ? "1" : "0" },
        webpush: { headers: { Urgency: quiet ? "normal" : "high", TTL: String(24 * 3600) } },
      }));
      const results = await (await webPushClient()).sendEach(webMessages);
      results.forEach((r, i) => {
        if (r.ok) { webOk++; return; }
        if (FCM_GONE.has(r.code) && webMessages[i]) gone.push(webMessages[i].token);
        else error = error ?? r.code;
      });
    }
    if (gone.length) await db.delete(pushDevices).where(and(eq(pushDevices.athlete_id, athleteId), inArray(pushDevices.token, gone)));
    const ok = okTickets.length + webOk;
    await db.update(pushSends).set({ devices: ok, error: ok ? error : error ?? "no_device_took_it", tickets: okTickets.length ? okTickets : null }).where(eq(pushSends.id, claimed));
    return { status: ok ? "sent" : "failed", devices: ok, quiet };
  } catch (err: any) {
    logger.warn({ athleteId, kind: event.kind, error: String(err?.message ?? err).slice(0, 200) }, "push failed (the work that caused it is unaffected)");
    // The claimed row says it failed, so the event may be tried once more.
    if (claimed) await db.update(pushSends).set({ error: "send_failed", devices: 0 }).where(eq(pushSends.id, claimed)).catch(() => undefined);
    return { status: "failed" };
  }
}

/** Fire and forget, for callers on a hot path (the inbox sync, the approval queue). */
export function pushSoon(athleteId: string, event: PushEvent): void {
  if (!pushEnabled()) return;
  void sendPush(athleteId, event).catch(() => undefined);
}

// ─── Receipts (the push-receipts-cron) ────────────────────────────────────────────────────────────────────────────

/** Expo keeps receipts for a day and has them ready within minutes: read sends 15 minutes to 24 hours old. */
const RECEIPT_MIN_AGE_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 2 * HOUR;

/**
 * One pass of the receipts cron: for recent sends with tickets, Expo's receipts. DeviceNotRegistered removes that token
 * (the athlete's own row only); any other error code (InvalidCredentials, MessageRateExceeded, …) is recorded on the send
 * row when it has none. A row is done once every ticket answered, or 2 hours after it was sent.
 */
export async function checkReceipts(opts: { now?: Date; limit?: number } = {}): Promise<{ sends: number; receipts: number; removed: number; errors: number }> {
  const now = opts.now ?? new Date();
  const out = { sends: 0, receipts: 0, removed: 0, errors: 0 };
  const rows = await db.select().from(pushSends).where(and(
    isNotNull(pushSends.tickets), isNull(pushSends.receipts_checked_at),
    lt(pushSends.created_at, new Date(now.getTime() - RECEIPT_MIN_AGE_MS)), gt(pushSends.created_at, new Date(now.getTime() - 24 * HOUR)),
  )).limit(Math.max(1, Math.min(opts.limit ?? 300, 1000)));
  if (!rows.length) return out;
  const ticketsOf = (r: (typeof rows)[number]) => (Array.isArray(r.tickets) ? (r.tickets as Array<{ id: string; deviceId: string }>) : []);
  const ids = rows.flatMap((r) => ticketsOf(r).map((t) => t.id));
  const c = await pushClient();
  const receipts: Record<string, PushReceipt> = {};
  for (const chunk of c.chunkPushNotificationReceiptIds(ids)) Object.assign(receipts, await c.getPushNotificationReceiptsAsync(chunk));
  for (const r of rows) {
    out.sends++;
    const tickets = ticketsOf(r);
    let error: string | null = null;
    const gone: string[] = [];
    for (const t of tickets) {
      const rc = receipts[t.id];
      if (!rc) continue;
      out.receipts++;
      if (rc.status !== "error") continue;
      if (rc.details?.error === "DeviceNotRegistered") gone.push(t.deviceId);
      else error = error ?? (rc.details?.error ?? "error");
    }
    if (gone.length) out.removed += (await db.delete(pushDevices).where(and(eq(pushDevices.athlete_id, r.athlete_id), inArray(pushDevices.id, gone))).returning({ id: pushDevices.id })).length;
    if (error) out.errors++;
    const answered = tickets.every((t) => !!receipts[t.id]);
    const done = answered || now.getTime() - r.created_at.getTime() >= RECEIPT_GIVE_UP_MS;
    if (error || done) {
      // Done: the tickets go (nothing about the phone stays on the row once its receipts are read).
      await db.update(pushSends).set({ ...(error && !r.error ? { error } : {}), ...(done ? { receipts_checked_at: now, tickets: null } : {}) }).where(eq(pushSends.id, r.id));
    }
  }
  if (out.errors) logger.warn(out, "push receipts: errors recorded");
  return out;
}
