/**
 * connections.ts — OAuth connection endpoints (direct integrations, no Composio).
 *
 * POST   /api/v1/me/connect/:platform   → build auth URL, insert pending row, return redirectUrl
 * GET    /api/v1/me/connections         → list all non-revoked connections
 * DELETE /api/v1/me/connect/:connectionId → mark revoked locally
 *
 * Status lifecycle:
 *   pending  → inserted here before the athlete completes OAuth
 *   active   → set by oauthCallback.ts after token exchange succeeds
 *   expired  → set by fetchSocialData when an API call returns 401/403
 *   revoked  → set by DELETE /connect/:id
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { GMAIL_DRAFT_SCOPE, GMAIL_SEND_SCOPE } from "../lib/connectionScopes";
import { inboxCapability } from "../services/threadInbox";
import { db } from "../db";
import { connectedAccounts } from "../../shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { createLogger } from "../logger";
import { OAUTH, INBOX } from "../lib/integrations/registry";
import { revokeProviderToken } from "../lib/oauthRevoke";
import { selfUserOf } from "../services/intelligence/identity/users";
import { withLandingReturn } from "../lib/landingReturn";
import { verifyOAuthState } from "../lib/oauthState";
import { recordConnectState } from "../lib/oauthConnectState";

const logger = createLogger("connections");
const router = Router();

/**
 * MILA_WELCOME: the athlete disconnected an account, so every capability they had on it is turned off (mila_choices,
 * with history; reconnecting does not turn them back on). Best-effort: the disconnect itself already happened, and
 * isAllowed refuses a revoked connection anyway. A no-op while the flag is off.
 */
async function revokeChoicesFor(athleteId: string, connectionId: string): Promise<void> {
  try {
    const { revokeForAccount } = await import("../agent/welcome/choices");
    await revokeForAccount(athleteId, connectionId, "settings");
  } catch (err: any) {
    logger.warn({ athleteId, connectionId, error: err?.message }, "disconnect: capability choices not turned off");
  }
}

/** Best-effort: a failure here must never block the disconnect (the subscription expires within 7 days anyway). */
async function stopOutlookPush(connectionId: string): Promise<void> {
  try {
    const { deleteSubscriptionFor } = await import("../lib/integrations/outlookPush.js");
    await deleteSubscriptionFor(connectionId);
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message }, "Outlook push: subscription cleanup on disconnect failed");
  }
}

/**
 * Connectors whose web connect used to end on the deep-link return page (their auth URL never carried clientPlatform).
 * They return straight to the web app's `/?connected=<platform>` only when the client sends `webReturn: true` — the dev
 * web build's same-tab connect (EXPO_PUBLIC_WEB_V2) — so today's web and native clients see exactly today's flow.
 */
const OPT_IN_WEB_RETURN = new Set(["tiktok", "spotify"]);

/** The clientPlatform signed into the OAuth state for this connect. */
export function returnPlatformFor(platform: string, clientPlatform: string | undefined, webReturn: unknown): string | undefined {
  if (OPT_IN_WEB_RETURN.has(platform) && webReturn !== true) return undefined;
  return clientPlatform;
}

// ─── POST /api/v1/me/connect/:platform ───────────────────────────────────────

router.post("/connect/:platform", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const platform  = req.params.platform.toLowerCase();
  const athleteId = req.athleteId!;
  const { alias, loginHint, clientPlatform: askedPlatform, webReturn, returnOrigin } = req.body as { alias?: string; loginHint?: string; clientPlatform?: string; webReturn?: unknown; returnOrigin?: unknown };
  // A web connect from the landing page (allowlisted returnOrigin) returns to the landing page — server/lib/landingReturn.ts.
  const clientPlatform = withLandingReturn(returnPlatformFor(platform, askedPlatform, webReturn), returnOrigin);

  const provider = OAUTH[platform];
  if (!provider) {
    res.status(400).json({
      error: `Unsupported platform: ${platform}. Valid: ${Object.keys(OAUTH).join(", ")}`,
    });
    return;
  }

  let redirectUrl: string;
  try {
    redirectUrl = provider.getAuthUrl(athleteId, alias, loginHint, clientPlatform);
  } catch (err: any) {
    logger.error({ athleteId, platform, error: err.message }, "Failed to build auth URL");
    res.status(500).json({ error: "Failed to initiate OAuth flow" });
    return;
  }

  // The state, held server-side: single-use, for this athlete and platform, and for a browser connect bound to this
  // browser by an HttpOnly cookie set on THIS response (lib/oauthConnectState.ts). No state ⇒ no connect.
  try {
    const nonce = verifyOAuthState(new URL(redirectUrl).searchParams.get("state") ?? undefined)?.nonce;
    if (!nonce) throw new Error("auth URL carries no signed state");
    await recordConnectState(res, { nonce, athleteId, platform, clientPlatform });
  } catch (err: any) {
    logger.error({ athleteId, platform, error: String(err?.message ?? err).slice(0, 200) }, "Failed to record the connect state");
    res.status(500).json({ error: "Failed to initiate OAuth flow" });
    return;
  }

  // Clean up any stale pending rows for this platform before creating a new one.
  // A new Add click means the previous attempt was abandoned.
  await db
    .delete(connectedAccounts)
    .where(and(
      eq(connectedAccounts.athlete_id, athleteId),
      eq(connectedAccounts.platform,   platform),
      eq(connectedAccounts.status,     "pending"),
    ));

  // Insert pending row — flipped to active in oauthCallback.ts after the athlete completes OAuth
  // Phase A Step 3a: who performs the OAuth (req.userId with the read flag on; else the athlete's self user — today's caller by construction).
  const connectedBy = req.userId ?? (await selfUserOf(athleteId).catch(() => null));
  const [inserted] = await db
    .insert(connectedAccounts)
    .values({ athlete_id: athleteId, platform, alias: alias ?? null, status: "pending", connected_by_user_id: connectedBy })
    .returning({ id: connectedAccounts.id });

  logger.info({ athleteId, platform, localId: inserted.id }, "Connection pending — OAuth redirect");
  res.json({ connectionId: inserted.id, redirectUrl, platform });
});

// ─── DELETE /api/v1/me/disconnect/:platform ──────────────────────────────────
// Convenience route: revoke by platform name (client doesn't need to know the UUID).

router.delete("/disconnect/:platform", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const platform  = req.params.platform.toLowerCase();
  const athleteId = req.athleteId!;

  try {
    const rows = await db
      .select({
        id:            connectedAccounts.id,
        access_token:  connectedAccounts.access_token,
        refresh_token: connectedAccounts.refresh_token,
      })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform,   platform),
        eq(connectedAccounts.status,     "active"),
      ))
      .limit(2);

    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: `No active ${platform} connection found` });
      return;
    }
    // An athlete may hold several inboxes on one platform (two Gmail mailboxes, two Instagram accounts);
    // the platform name alone cannot say which one to revoke. Refuse instead of picking one — the client
    // disconnects by id via DELETE /connect/:connectionId.
    if (rows.length > 1 && INBOX[platform]) {
      res.status(400).json({
        error: `More than one ${platform} account is connected — disconnect by connection id (DELETE /connect/:connectionId).`,
        code:  "CONNECTION_ID_REQUIRED",
      });
      return;
    }

    // Outlook push: stop the Graph subscription while the token still works (no-op without one).
    if (platform === "outlook") await stopOutlookPush(row.id);
    // Revoke provider-side, then drop the stored tokens locally (don't retain a
    // dead but still-sensitive credential on a revoked row).
    await revokeProviderToken(platform, row.refresh_token ?? row.access_token);
    await db.update(connectedAccounts)
      .set({ status: "revoked", access_token: null, refresh_token: null })
      .where(eq(connectedAccounts.id, row.id));
    logger.info({ athleteId, platform, connectionId: row.id }, "Connection revoked");
    await revokeChoicesFor(athleteId, row.id);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ athleteId, platform, error: err.message }, "Failed to disconnect");
    res.status(500).json({ error: "Failed to disconnect account" });
  }
});

// ─── GET /api/v1/me/connections ──────────────────────────────────────────────

router.get("/connections", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;

  try {
    const rows = await db
      .select({
        id:              connectedAccounts.id,
        platform:        connectedAccounts.platform,
        alias:           connectedAccounts.alias,
        status:          connectedAccounts.status,
        platform_username: connectedAccounts.platform_username,
        last_fetched_at: connectedAccounts.last_fetched_at,
        created_at:      connectedAccounts.created_at,
        scopes:          connectedAccounts.scopes,
      })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id, athleteId),
        // Never return revoked rows. Before 0071 every reconnect created a NEW row and
        // revoked history piled up dozens of stale "inactive" entries per athlete; now a
        // reconnect reactivates the account's one row in place (activateConnection), and a
        // revoked row is simply a disconnected account. (active/pending/expired stay —
        // 'expired' is a real "token died, reconnect" state.)
        ne(connectedAccounts.status, "revoked"),
        // Hide orphaned in-progress connects: pending with no username = OAuth never completed.
        sql`NOT ("status" = 'pending' AND "platform_username" IS NULL)`,
      ));

    // can_send: whether this connection can SEND (not just read). Gmail only gains
    // send ability when its OAuth grant includes a send-capable scope (older
    // read-only grants can't send until the user re-connects). Instagram's
    // messaging permission is implicit in an active connection.
    //
    // can_draft: whether "save draft" can mirror into a real Gmail Draft. This is a
    // DIFFERENT scope set — gmail.send authorises sending only, and the Gmail API
    // rejects drafts.create on a send-only grant. Every active Gmail connection in prod
    // as of 2026-08-09 was authorised before gmail.compose was added to GMAIL_SCOPES
    // (lib/integrations/gmail.ts), so drafts.create 403'd and the failure was swallowed
    // as a warn — 43 threads had a draft and not one had a gmail_draft_id. Surfacing the
    // capability lets the UI ask for a reconnect instead of silently doing nothing.
    const connections = rows.map(({ scopes, ...r }) => ({
      ...r,
      // Gmail keeps its strict reading here (a NULL grant shows "can't send" in Settings); every other
      // platform reads the reply-platform table, so Outlook can send only with OUTLOOK_SEND on and Mail.Send granted.
      can_send:
        r.status === "active" &&
        (r.platform === "gmail"
          ? GMAIL_SEND_SCOPE.test(scopes ?? "")
          : inboxCapability({ platform: r.platform, status: r.status, scopes }).can_send),
      can_draft:
        r.status === "active" &&
        r.platform === "gmail" &&
        GMAIL_DRAFT_SCOPE.test(scopes ?? ""),
    }));

    res.json({ connections });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "Failed to list connections");
    res.status(500).json({ error: "Failed to list connections" });
  }
});

// ─── POST /api/v1/me/connect/instagram/sync (dev only) ───────────────────────
// Pull the caller's Instagram DMs through the deal-detection pipeline on demand
// and return the counts. Gated to non-production so we can validate IG ingestion
// against our own accounts in Meta Development Mode (added as Instagram testers) BEFORE
// requesting App Review for instagram_business_manage_messages. In prod, ingestion runs
// via onConnected backfill + the inbox polling cron instead.
router.post("/connect/instagram/sync", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const athleteId = req.athleteId!;
  const [conn] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.athlete_id, athleteId),
      eq(connectedAccounts.platform,   "instagram"),
      eq(connectedAccounts.status,     "active"),
    ))
    .limit(1);

  if (!conn) {
    res.status(404).json({ error: "No active Instagram connection for this athlete" });
    return;
  }

  try {
    const { syncRecent } = await import("../lib/integrations/instagram.js");
    const result = await syncRecent(conn.id, athleteId);
    logger.info({ athleteId, connectionId: conn.id, ...result }, "Dev Instagram sync complete");
    res.json({ ok: true, connectionId: conn.id, ...result });
  } catch (err: any) {
    logger.error({ athleteId, connectionId: conn.id, error: err.message }, "Dev Instagram sync failed");
    res.status(500).json({ error: "Instagram sync failed" });
  }
});

// ─── DELETE /api/v1/me/connect/:connectionId ─────────────────────────────────

router.delete("/connect/:connectionId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { connectionId } = req.params;
  const athleteId = req.athleteId!;

  try {
    const [row] = await db
      .select({
        platform:      connectedAccounts.platform,
        status:        connectedAccounts.status,
        access_token:  connectedAccounts.access_token,
        refresh_token: connectedAccounts.refresh_token,
      })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.id,         connectionId),
        eq(connectedAccounts.athlete_id, athleteId),
      ))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Outlook push: stop the Graph subscription while the token still works (no-op without one).
    if (row.platform === "outlook") await stopOutlookPush(connectionId);
    // Revoke provider-side, then drop the stored tokens locally.
    await revokeProviderToken(row.platform, row.refresh_token ?? row.access_token);
    await db
      .update(connectedAccounts)
      .set({ status: "revoked", access_token: null, refresh_token: null })
      .where(eq(connectedAccounts.id, connectionId));

    logger.info({ athleteId, connectionId, platform: row.platform }, "Connection revoked");
    await revokeChoicesFor(athleteId, connectionId);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ athleteId, connectionId, error: err.message }, "Failed to disconnect account");
    res.status(500).json({ error: "Failed to disconnect account" });
  }
});

// ─── PATCH /api/v1/me/connections/:connectionId ───────────────────────────────
// Update alias label on an existing connection.

router.patch("/connections/:connectionId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { connectionId } = req.params;
  const athleteId = req.athleteId!;
  const { alias } = req.body as { alias?: string };

  try {
    const [row] = await db
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.id,         connectionId),
        eq(connectedAccounts.athlete_id, athleteId),
      ))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    await db
      .update(connectedAccounts)
      .set({ alias: alias?.trim() || null })
      .where(eq(connectedAccounts.id, connectionId));

    logger.info({ athleteId, connectionId, alias }, "Connection alias updated");
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ athleteId, connectionId, error: err.message }, "Failed to update alias");
    res.status(500).json({ error: "Failed to update alias" });
  }
});

export default router;
