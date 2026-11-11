/**
 * oauthCallback.ts — Server-side OAuth callback handler for all direct integrations.
 *
 * GET /api/v1/auth/callback/:platform?code=...&state=<athleteId[:alias]>
 *
 * 1. Exchanges the authorization code for tokens (platform-specific handleCallback)
 * 2. Kicks off fetchSocialData in the background (fire-and-forget)
 * 3. Redirects to co.nomila.app://connect/callback?platform=X&success=true
 *    (or shows HTML for browser testing when the deep link can't open)
 *
 * State encoding:
 *   All platforms:  state = athleteId
 *   Gmail only:     state = athleteId:alias  (alias may be empty string)
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { OAUTH, INBOX } from "../lib/integrations/registry";
import { verifyOAuthState } from "../lib/oauthState";
import { htmlEscape, makeCspNonce, setOauthCallbackCsp } from "../lib/securityHeaders";
import { webAppUrl } from "../lib/baseUrls";
import { landingOriginOf } from "../lib/landingReturn";
import { clearBindingCookie, consumeConnectState } from "../lib/oauthConnectState";

const logger = createLogger("oauth-callback");

/** Send an HTML page with a per-response nonce'd CSP (no unsafe-inline). */
function sendHtml(res: Response, status: number, html: string, nonce: string): void {
  setOauthCallbackCsp(res, nonce);
  res.status(status).type("html").send(html);
}
const router = Router();

const DEEP_LINK = "co.nomila.app://connect/callback";
/** The social accounts whose handle is identity evidence (a connect re-checks a held identity). */
const IDENTITY_EVIDENCE_PLATFORMS = new Set(["instagram", "tiktok", "youtube"]);

// `?.trim() ||` (matches notify.ts) so a blank/whitespace value also falls back in
// dev; production requires this to be set — see envGuards.checkEnv().
const WEB_APP_URL = webAppUrl();

// All interpolated values are HTML-escaped (platform comes from the URL path). The error page only ever shows one of
// our own fixed messages: the provider's ?error= is logged, never echoed. Inline <script>/<style> carry the CSP nonce
// so we avoid 'unsafe-inline'.

/** The fixed text the error page shows for a provider-side error (the provider's own words are logged only). */
export const PROVIDER_ERROR_MESSAGE = "The connection was cancelled or not allowed. Please try connecting again.";
function successHtml(platform: string, nonce: string): string {
  const safePlatform = htmlEscape(platform);
  const deepLink  = `${DEEP_LINK}?platform=${encodeURIComponent(platform)}&success=true`;
  const webReturn = `${WEB_APP_URL}/`;
  const title = safePlatform.charAt(0).toUpperCase() + safePlatform.slice(1);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safePlatform} connected — Nomila</title>
<style nonce="${nonce}">
  body { font-family: -apple-system, sans-serif; background: #FAF8F5; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 20px; padding: 40px 32px; max-width: 360px;
          width: 90%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 20px; font-weight: 700; color: #1A1A1A; margin: 0 0 8px; }
  p  { font-size: 14px; color: #767676; margin: 0 0 24px; line-height: 1.5; }
  .pill { display: inline-block; background: #2DC87C20; color: #1A9960; font-size: 12px;
          font-weight: 600; padding: 4px 12px; border-radius: 999px; margin-bottom: 24px; }
  a.btn { display: block; background: #E84591; color: #fff; text-decoration: none;
          padding: 14px; border-radius: 999px; font-size: 15px; font-weight: 600; }
  .close { margin-top: 12px; font-size: 13px; color: #9C968D; }
</style>
<script nonce="${nonce}">
  // 1. Try to open the native app via deep link.
  // 2. If the app doesn't open (mobile web browser), redirect to the web app after 2s.
  setTimeout(function() {
    window.location.href = ${JSON.stringify(deepLink)};
    // Deep link doesn't navigate away in a web browser — schedule web-app fallback.
    setTimeout(function() { window.location.href = ${JSON.stringify(webReturn)}; }, 2000);
  }, 300);
</script>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <span class="pill">Connected</span>
    <h2>${title} connected</h2>
    <p>Nomila will now scan this inbox for brand deals and surface them in Opportunities.</p>
    <a class="btn" href="${htmlEscape(deepLink)}">Return to Nomila</a>
    <p class="close">Redirecting you back automatically…</p>
  </div>
</body></html>`;
}

function errorHtml(platform: string, message: string, nonce: string): string {
  const deepLink  = `${DEEP_LINK}?platform=${encodeURIComponent(platform)}&success=false&error=${encodeURIComponent(message)}`;
  const webReturn = `${WEB_APP_URL}/`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connection failed — Nomila</title>
<style nonce="${nonce}">
  body { font-family: -apple-system, sans-serif; background: #FAF8F5; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 20px; padding: 40px 32px; max-width: 360px;
          width: 90%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 20px; font-weight: 700; color: #1A1A1A; margin: 0 0 8px; }
  p  { font-size: 14px; color: #767676; margin: 0 0 24px; line-height: 1.5; }
  a.btn { display: block; background: #1A1A1A; color: #fff; text-decoration: none;
          padding: 14px; border-radius: 999px; font-size: 15px; font-weight: 600; }
  .close { margin-top: 12px; font-size: 13px; color: #9C968D; }
</style>
<script nonce="${nonce}">
  setTimeout(function() {
    window.location.href = ${JSON.stringify(deepLink)};
    setTimeout(function() { window.location.href = ${JSON.stringify(webReturn)}; }, 2000);
  }, 300);
</script>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h2>Connection failed</h2>
    <p>${htmlEscape(message)}</p>
    <a class="btn" href="${htmlEscape(deepLink)}">Return to Nomila</a>
    <p class="close">Redirecting you back automatically…</p>
  </div>
</body></html>`;
}

/**
 * The workflow idempotency key for one connect. The row id is permanent per provider account (0071), so the id
 * alone would make every later reconnect silently reuse the first run; connected_at is the connect generation —
 * a real reconnect starts a fresh run, a replayed callback for the same connect still dedupes.
 */
export function connectIdempotencyKey(connectionId: string, connectedAt: Date): string {
  return `connect:${connectionId}:${connectedAt.getTime()}`;
}

// ─── GET /callback/:platform ──────────────────────────────────────────────────

router.get("/callback/:platform", async (req: Request, res: Response): Promise<void> => {
  const { platform } = req.params;
  const { code, state, error: oauthError } = req.query as Record<string, string>;
  const nonce = makeCspNonce();

  // Verify the signed, expiring state (CSRF protection). verifyOAuthState returns
  // the decoded payload or null for a forged/tampered/expired state.
  const verified       = verifyOAuthState(state);
  const athleteId      = verified?.athleteId;
  const alias          = verified?.alias;
  const clientPlatform = verified?.clientPlatform;   // "web" | "landing:<origin>" | undefined (native)
  // A connect started from the landing page returns there (allowlisted origin, re-checked here); other web connects → the app.
  const landingOrigin  = landingOriginOf(clientPlatform);
  const isWeb          = clientPlatform === "web" || landingOrigin !== null;
  const webBase        = landingOrigin ?? WEB_APP_URL;

  if (oauthError) {
    logger.warn({ platform, error: String(oauthError).slice(0, 200) }, "OAuth error returned from provider");
    if (isWeb) {
      res.redirect(302, `${webBase}/?connected_error=${encodeURIComponent(platform)}`);
    } else {
      sendHtml(res, 400, errorHtml(platform, PROVIDER_ERROR_MESSAGE, nonce), nonce);
    }
    return;
  }

  if (!code || !state) {
    if (isWeb) {
      res.redirect(302, `${webBase}/?connected_error=${encodeURIComponent(platform)}`);
    } else {
      sendHtml(res, 400, errorHtml(platform, "Missing code or state parameter", nonce), nonce);
    }
    return;
  }

  // Reject any request whose state we didn't sign (or that expired) — this is the
  // OAuth CSRF / account-linking-abuse guard. Do it before touching the provider.
  if (!verified || !athleteId) {
    logger.warn({ platform }, "OAuth callback rejected: invalid or expired state");
    sendHtml(res, 400, errorHtml(platform, "Invalid or expired request — please try connecting again.", nonce), nonce);
    return;
  }

  const provider = OAUTH[platform];
  if (!provider) {
    if (isWeb) {
      res.redirect(302, `${webBase}/?connected_error=${encodeURIComponent(platform)}`);
    } else {
      sendHtml(res, 400, errorHtml(platform, "This connection isn't supported. Please try again from the app.", nonce), nonce);
    }
    return;
  }

  // Single-use, and only from the browser that started it (lib/oauthConnectState.ts): a replayed state, a state that
  // was never recorded, or a browser connect finished without the starting browser's cookie is refused before the
  // provider is touched, so a link started by one person can never attach another person's account.
  let consumed: Awaited<ReturnType<typeof consumeConnectState>>;
  try {
    consumed = await consumeConnectState(req, { nonce: verified.nonce, athleteId, platform });
  } catch (err: any) {
    logger.error({ platform, athleteId, error: String(err?.message ?? err).slice(0, 200) }, "OAuth callback: connect state lookup failed");
    consumed = "unknown_or_used";
  }
  clearBindingCookie(res, platform);
  if (consumed !== "ok") {
    logger.warn({ platform, athleteId, outcome: consumed }, "OAuth callback rejected: connect state not usable here (replayed, unknown, or another browser)");
    if (isWeb) res.redirect(302, `${webBase}/?connected_error=${encodeURIComponent(platform)}`);
    else sendHtml(res, 400, errorHtml(platform, "Invalid or expired request — please try connecting again.", nonce), nonce);
    return;
  }

  try {
    // handleCallback returns THE row it activated (the account's one row — reused on a reconnect). Every
    // follow-up below uses that id; nothing re-derives it (the old "newest active row" lookup could pick
    // a sibling row when an athlete had two).
    const activated    = await provider.handleCallback(code, athleteId, alias);
    const connectionId = activated?.connectionId;
    const connectKey   = activated ? connectIdempotencyKey(activated.connectionId, activated.connectedAt) : undefined;

    logger.info({ platform, athleteId, alias, clientPlatform, connectionId, reactivated: activated?.reactivated }, "OAuth callback handled");

    // Mila hears it at the top of the athlete's next message (agent/engine/events.ts): one event per
    // connect, nothing while MILA_TF_CHAT is off. Not awaited, never fatal.
    if (activated && connectKey) {
      void import("../agent/engine/events.js")
        .then(({ noteAccountConnected }) => noteAccountConnected(athleteId, { platform, reconnected: !!activated.reactivated, connectKey }))
        .catch(() => undefined);
    }

    // A connected social account is identity evidence (its handle anchors the identity queries): a held identity (an
    // open "#identity" verdict) is re-checked with it (agent/researchRefresh/identityRecheck.ts; a no-op without one,
    // at most once a day). Inbox and music accounts say nothing about which public athlete she is. Not awaited.
    if (activated && IDENTITY_EVIDENCE_PLATFORMS.has(platform)) {
      void import("../agent/researchRefresh/identityRecheck.js")
        .then(({ recheckIdentityInBackground }) => recheckIdentityInBackground(athleteId, "account", `connect:${platform}`))
        .catch(() => undefined);
    }

    // Background: inbox providers run their own onConnected (push/webhook + backfill);
    // everything else fetches social data for scoring.

    if (connectionId) {
      // A first-look run: fetch social (awaited, retried, traced), backfill thirty posts with
      // captions, compute what the posts say. Idempotent on the connect (id + connected_at), so a
      // repeated callback returns the same run and a real reconnect starts a new one. Replaces the
      // fire-and-forget fetch that swallowed every token and permission error. Started for all three
      // social platforms — Instagram included (decided Oct 2026: captions matter most there).
      // See server/workflow/definitions/firstLook.ts.
      const startFirstLook = () =>
        import("../workflow/runner.js").then(({ startRun }) =>
          startRun({
            process: "first_look", athleteId, createdBy: "connect",
            input: { connectionId, platform }, idempotencyKey: connectKey!,
          }).catch((err: any) => logger.error({ athleteId, platform, error: err.message }, "first_look start threw")),
        );

      // Phase A Step 2b: a social connection is an EVENT for the research planner (identity + handles due).
      // requestRefresh is a queued request, never a call, and a no-op unless BOTH execution flags are true.
      const requestResearchRefresh = () =>
        import("../services/intelligence/research/triggers.js").then(({ requestRefresh }) =>
          requestRefresh(athleteId, ["identity", "social_handles"], "event", `connect:${platform}`)
            .catch((err: any) => logger.error({ athleteId, platform, error: err.message }, "research refresh request threw")),
        );

      const inbox = INBOX[platform];
      if (inbox?.onConnected) {
        inbox.onConnected(connectionId, athleteId).catch((err: any) =>
          logger.error({ athleteId, platform, error: err.message }, "Provider onConnected threw"),
        );
        // Instagram is BOTH an inbox provider (DM ingestion, above) and a social platform, so it
        // also gets the first look and the research refresh request. Its scoring fetch now runs inside first_look's fetch_social step
        // (instagram.onConnected no longer calls fetchSocialData), exactly as for TikTok/YouTube.
        if (platform === "instagram") {
          startFirstLook(); requestResearchRefresh();
          // A waitlisted athlete the "real athlete?" check held (ATHLETE_FOOTPRINT_CHECK): re-check with this account
          // (a real one with posts), then the full research when found. Not awaited, never fatal.
          void import("../agent/onboarding/footprintCheck.js").then(({ recheckAfterInstagram }) => recheckAfterInstagram(athleteId))
            .catch((err: any) => logger.warn({ athleteId, error: err.message }, "footprint re-check not started"));
        }
      } else if (platform === "tiktok" || platform === "youtube") {
        // Instagram is in INBOX, so it never reaches this branch; it starts its first look above.
        startFirstLook();
        requestResearchRefresh();
      } else {
        // Spotify and any other non-social platform keep the identity-only fetch.
        import("../skills/fetchSocialData.js").then(({ fetchSocialData }) => {
          fetchSocialData(athleteId, platform, connectionId).catch((err: any) =>
            logger.error({ athleteId, platform, error: err.message }, "fetchSocialData threw"),
          );
        });
      }

      // Connect-triggered substrate sync (server/workflow/definitions/socialSync.ts): independent
      // of the branch above, because Instagram is BOTH an inbox provider (its onConnected runs
      // in the branch above) and a social platform whose substrate needs a sync of its
      // own — without this, the first substrate write for a newly connected account waited for
      // the 04:30 nightly cron (up to 24h after connect). Never blocks this response: enqueued,
      // not awaited. Idempotent on the connect (id + connected_at): a repeated callback returns the same
      // run, a real reconnect starts a fresh one;
      // a clean no-op when SOCIAL_SUBSTRATE_WRITE is off (collectSocialAnalytics/ingestNative
      // check the flag themselves).
      if (platform === "instagram" || platform === "tiktok" || platform === "youtube") {
        import("../workflow/runner.js").then(({ startRun }) =>
          startRun({
            process: "social_sync", athleteId, createdBy: "connect",
            input: { connectionId, platform }, idempotencyKey: connectKey!,
          }).catch((err: any) => logger.error({ athleteId, platform, error: err.message }, "social_sync start threw")),
        );
      }
    } else {
      logger.warn({ athleteId, platform }, "handleCallback returned no connection — skipping background fetch");
    }

    if (isWeb) {
      // Web-initiated flow: redirect straight to the app — no deep-link attempt so iOS
      // never sees the "Open in app?" prompt.
      res.redirect(302, `${webBase}/?connected=${encodeURIComponent(platform)}`);
    } else {
      sendHtml(res, 200, successHtml(platform, nonce), nonce);
    }
  } catch (err: any) {
    logger.error({ platform, athleteId, error: err.message }, "OAuth callback failed");
    if (isWeb) {
      res.redirect(302, `${webBase}/?connected_error=${encodeURIComponent(platform)}`);
    } else {
      sendHtml(res, 500, errorHtml(platform, "Connection failed — please try again", nonce), nonce);
    }
  }
});

export default router;
