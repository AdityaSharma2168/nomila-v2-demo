// Tracing first, before anything that can produce a span. Nothing below monkey-patches on
// import — the Kimi path wraps its client explicitly and the Gemini path uses explicit
// spans — so a late start would lose traces rather than break calls; it goes first anyway,
// because losing the first request of a deploy is exactly when you want the trace.
// No-op unless LANGFUSE_TRACING=true. See server/lib/tracing.ts.
import { runsBackgroundWork } from "./lib/backgroundHost";
import { startTracing } from "./lib/tracing";
startTracing();

import express from "express";
// Patches Express 4 so async route-handler rejections propagate to the central
// error middleware instead of hanging the request. MUST be imported before routes.
import "express-async-errors";
import crypto from "crypto";
import cron from "node-cron";
import { createLogger, requestLoggerMiddleware } from "./logger";
import { refreshInstagramToken, statusForRefreshError, IgTokenRefreshError } from "./lib/igTokenRefresh";
import { containsPattern } from "./lib/likePattern";
import { renewGmailWatches } from "./lib/gmailWatchRenew";
import { archiveStaleDeals } from "./skills/archiveStaleDeals";
import { installRunnerShutdown, tick as workflowTick } from "./workflow/runner";
import { workflowAthleteRouter } from "./workflow/routes";
import { agentOnboardingEnabled, agentOnboardingRouter } from "./agent/onboarding/routes";
import { onboardingFrontRouter } from "./agent/onboarding/front";
import { agentGoalsRouter, agentPlanEnabled } from "./agent/plan/routes";
import { momentsCronRouter } from "./agent/moments/routes";
import { researchRefreshCronRouter, suggestionsRouter } from "./agent/researchRefresh/routes";
import { agentPostKitRouter, agentPostKitsEnabled } from "./agent/postKit/routes";
import { agentStudioRouter, agentV3Enabled as agentStudioV3Enabled } from "./agent/studio/routes";
import { readyRouter, contentReadyQueueEnabled } from "./agent/ready/routes";
import { playbookCronRouter } from "./agent/playbook/routes";
import { previewCleanupCronRouter } from "./agent/postKit/render/cleanupRoutes";
import { agentSpendCronRouter } from "./agent/spendCron";
// Registers every workflow definition (onboarding, first_look, research_refresh) before the
// first tick or startRun. See server/workflow/definitions/index.ts.
import "./workflow/definitions";
import { withAdvisoryLock as withWorkflowTickLock } from "./lib/pgAdvisoryLock";
import { checkEnv, type EnvHealth } from "./lib/envGuards";
import authRouter from "./routes/auth";
import { authEmailCodeRouter } from "./routes/authEmailCode";
import connectionsRouter from "./routes/connections";
import oauthCallbackRouter from "./routes/oauthCallback";
import webhooksRouter from "./routes/webhooks";
import outlookWebhooksRouter from "./routes/webhooks.outlook";
import dealsRouter from "./routes/deals";
import dealContractsRouter from "./routes/dealContracts";
import inboxRouter from "./routes/inbox";
import pendingActionsRouter from "./routes/pendingActions";
import milaCardsRouter from "./routes/milaCards";
import askTermsRouter from "./routes/askTerms";
import agentActionsRouter from "./routes/agentActions";
import waitlistRouter from "./routes/waitlist";
import waitlistMilaRouter from "./routes/waitlistMila";
import adminRouter from "./routes/admin";
import chatRouter from "./routes/chat";
import { mountChatV2 } from "./routes/chatV2";
import conversationsRouter from "./routes/conversations";
import pushRouter, { pushReceiptsCronRouter } from "./routes/push";
import milaVoiceSettingsRouter from "./routes/milaVoiceSettings";
import profileRouter from "./routes/profile";
import recordRouter from "./routes/record";
import meKnowledgeRouter from "./routes/meKnowledge";
import meIntelligenceRouter from "./routes/meIntelligence";
import meMiaPreviewRouter from "./routes/meMiaPreview";
import meAtmosphereRouter from "./routes/meAtmosphere";
import meMemoryRouter from "./routes/meMemory";
import meStoryRouter from "./routes/meStory";
import meIdentityRouter from "./routes/meIdentity";
import meBrandsRouter from "./routes/meBrands";
import meRatesRouter from "./routes/meRates";
import meBrandBookRouter from "./routes/meBrandBook";
import searchRouter from "./routes/search";
import indexRouter from "./routes/index";
import identityClaimsRouter from "./routes/identityClaims";
import analyticsRouter from "./routes/analytics";
import mediaRouter from "./routes/media";
import studioRouter from "./routes/studio";
import studioSessionsRouter from "./routes/studioSessions";
import accountRouter from "./routes/account";
import accountDeletePageRouter from "./routes/accountDeletePage";
import milaChoicesRouter from "./routes/milaChoices";
import connectRouter from "./routes/connect";
import paymentsRouter from "./routes/payments";
import financialsRouter from "./routes/financials";
import whatMattersNextRouter from "./routes/whatMattersNext";
import adminPaymentsRouter from "./routes/adminPayments";
import bookingsRouter from "./routes/bookings";
import bookingsPublicRouter from "./routes/bookingsPublic";
import bookingStatusPageRouter from "./routes/bookingStatusPage";
import { createShortLinkRouter } from "./routes/shortLink";
import adminBookingsRouter from "./routes/adminBookings";
import payRouter from "./routes/pay";
import confirmRouter from "./routes/confirm";
import depositRouter from "./routes/deposit";
import connectReturnRouter from "./routes/connectReturn";
import cardRouter from "./routes/card";
import { createPublicPageRouter } from "./routes/publicPage";
import publicPageLikeRouter from "./routes/publicPageLike";
import { recordView as recordPageView } from "./services/publicPage/stats";
import { createAskMilaPublicRouter } from "./routes/askMilaPublic";
import askMilaChatsRouter from "./routes/askMilaChats";
import { createPublicBookingsPort } from "./services/bookings/publicPort";
import { createPartnerIntakePort } from "./services/partner/milaPort";
import type { PublicMilaPorts } from "./mila/public/ports";
import { loadView as loadPublicCardView } from "./services/publicCard/snapshotAdapter";
import { frontDoorStylesheet } from "./services/nomiDeck/index";
import shopRouter from "./routes/shop";
import { athleteSessionRouter, buyerSessionRouter, livekitWebhookRouter, bookingSessionCronRouter } from "./routes/bookingSession";
import { BOOKINGS } from "./services/bookings/config";
import shopRedirectRouter from "./routes/shopRedirect";
import { shopEnabled } from "./services/shop/config";
import publicCardRouter from "./routes/publicCard";
import { publicCardEnabled } from "./services/publicCard/config";
import mePublicCardRouter from "./routes/mePublicCard";
import shopBrandsRouter from "./routes/shopBrands";
import { partnerApiRouter, partnerConfirmRouter } from "./routes/partnerPublic";
import { partnerRequestsRouter, partnerStatusRouter } from "./routes/partnerStatus";
import { partnerAthleteRouter } from "./routes/partnerAthlete";
import { adminRelayRouter } from "./routes/adminRelay";
import { partnerInboundMailEnabled, partnerIntakeEnabled } from "./services/partner/config";
import { setPublishedCardSource } from "./services/partner/publishedCard";
import { publicCardReaderSource } from "./services/partner/publishedCardSource";
import { shopifyAppRouter } from "./routes/shopifyApp";
import { shopifyWebhooksRouter } from "./routes/shopifyWebhooks";
import { createDevTestEmailRouter } from "./routes/devTestEmail";
import { shopifyAppEnabled, shopifyConfig, WEBHOOK_PATH } from "./services/shopify/config";
import voiceScoreRouter from "./voice/scoreRoute";
import voiceWebSearchRouter from "./voice/webSearchRoute";
import voiceShareSignalsRouter from "./voice/shareSignalsRoute";
import voiceDealRouter from "./voice/dealRoutes";
import voiceThreadRouter from "./voice/threadRoutes";
import voiceBrandKnowledgeRouter from "./voice/brandKnowledgeRoute";
import voiceBrandBriefRouter from "./voice/brandBriefRoute";
import voiceDealBriefRouter from "./voice/dealBriefRoute";
import voiceTranscriptRouter from "./voice/transcriptRoute";
import voiceSeedRouter from "./voice/seedRoute";
import voiceContextRouter from "./voice/voiceContextRoute";
import { tokenRouter as voiceTokenRouter } from "./voice/webTokenRoute";
import { MILA } from "./mila/config";
import voiceDraftIntentRouter from "./voice/draftIntentRoute";
import voiceProfileRouter from "./voice/profileRoute";
import voiceOnboardingRouter from "./voice/onboardingRoute";
import { oneMilaRouter as voiceOneMilaRouter } from "./voice/oneMila/routes";
import { db } from "./db";
import {
  athletes,
  inboxBrands,
  inboxThreads,
  mediaKits,
  cardShares,
  cardShareViews,
  deals,
} from "../shared/schema";
import {
  and,
  eq,
  ne,
  isNotNull,
  inArray,
  sql,
  count,
  max,
  ilike,
} from "drizzle-orm";
import { requireAuth } from "./lib/auth";
import {
  securityHeaders,
  notFoundHandler,
} from "./lib/securityHeaders";

import { trustProxyHops } from "./lib/trustProxy";

const logger = createLogger("server");
const app = express();
const PORT = process.env.PORT ?? 8080;

// Behind Cloud Run's front end: trust exactly its hop(s), so req.ip is the client address the proxy saw, never a
// value the client wrote into X-Forwarded-For itself (`true` trusted the left-most entry, which anyone can set).
// Every per-IP rate limit keys on it. See lib/trustProxy.ts.
app.set("trust proxy", trustProxyHops());
// Security headers (HSTS, CSP, CORP, X-Frame-Options, nosniff, Referrer-Policy,
// upgrade-insecure-requests, no X-Powered-By) on EVERY response — mounted first so
// JSON, OAuth-callback HTML, webhooks, and error/404 responses all carry them.
app.use(securityHeaders);
// Internal/cron endpoint shared secret. Cloud Run maps the `INTERNAL_CRON_SECRET`
// secret to env `CRON_SECRET` (gcp/cloud-run-dev.yaml); local .env only has
// `INTERNAL_CRON_SECRET` — accept either so the guard behaves the same everywhere.
const CRON_SECRET =
  process.env.CRON_SECRET?.trim() || process.env.INTERNAL_CRON_SECRET?.trim();

// Constant-time comparison of the x-cron-secret header against the shared secret,
// so the internal/cron endpoints don't leak the secret via response-timing.
function cronSecretValid(req: express.Request): boolean {
  const provided = req.headers["x-cron-secret"];
  if (!CRON_SECRET || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(CRON_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Browser origins allowed to call this API. From ALLOWED_ORIGINS (comma-separated) —
// set per environment in gcp/cloud-run-{dev,prod}.yaml. The literal list below is the
// development default and is what dev ran on before the variable existed; in
// production envGuards logs an error if the variable is missing, because falling back
// to it there would mean prod quietly trusting dev's origins.
const DEV_ORIGINS = [
  "https://nomila-dev.web.app",
  "https://nomila.web.app",
  "https://nomila.co",
  "https://www.nomila.co",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:8083",
];
const configuredOrigins: string[] = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o: string) => o.trim())
  .filter((o: string) => o.length > 0);
const ALLOWED_ORIGINS = new Set<string>(configuredOrigins.length ? configuredOrigins : DEV_ORIGINS);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      // X-Firebase-AppCheck: the landing's App Check token on account creation (lib/appCheck.ts).
      "Content-Type, Authorization, X-Firebase-AppCheck",
    );
    // Credentials for the allowed origins only: the OAuth connect start sets its HttpOnly binding cookie
    // (lib/oauthConnectState.ts). Nothing else here authenticates by cookie (bearer tokens throughout).
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Bookings v2: LiveKit's signed webhook (attendance evidence). Its OWN raw parser — the signature covers the exact
// body bytes — mounted before the generic /api/webhooks parser so it reaches the route untouched. BOOKINGS_ENABLED only
// (read once at boot; the route re-checks it).
if (BOOKINGS.enabled) app.use(livekitWebhookRouter);

// Gmail Pub/Sub webhook needs raw body for potential future HMAC verification
app.use(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  webhooksRouter,
);
// Microsoft Graph change notifications (OUTLOOK_PUSH). Its own JSON parser for every content type: the
// validation handshake arrives as text/plain with an empty body, notifications as application/json.
// Always mounted — with the flag off a verified notification is ignored (202), so a subscription that
// outlived a flag flip expires quietly instead of being retried and throttled.
app.use(
  "/api/v1/webhooks/outlook",
  express.json({ type: () => true, limit: "1mb" }),
  outlookWebhooksRouter,
);

// The catalog-only Shopify app's webhooks (docs/design/shop-her-picks.md §12): their own RAW parser — the HMAC is over
// the exact bytes — so they mount before express.json. SHOP_SHOPIFY_APP (+ SHOP_V1) only.
if (shopifyAppEnabled()) app.use(WEBHOOK_PATH, shopifyWebhooksRouter());

app.use(express.json());
app.use(requestLoggerMiddleware);

// Sensitive, per-user responses (Gmail-derived inbox/deals, auth, admin PII) must
// not be stored by browsers or intermediary caches. SSE routes set their own
// Cache-Control: no-cache and are unaffected.
app.use(["/api/v1/me", "/api/v1/admin", "/api/v1/auth"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api/v1/auth", authRouter);
// Sign in with a 6-digit email code (design "Sign in with email"): 404 unless EMAIL_CODE_SIGNIN is exactly "true".
app.use("/api/v1/auth/email-code", authEmailCodeRouter());
// Phase A Step 2c: the Athlete Index candidates endpoint (pre-link guard; dark until the Step 3 UI).
app.use("/api/v1/index", indexRouter);
// Phase A Step 3b: the claim lifecycle ("Is this you?"); dark unless ATHLETE_INDEX_CLAIM.
app.use("/api/v1/identity", identityClaimsRouter);
app.use("/api/v1/auth", oauthCallbackRouter);
// Payouts (Stripe Connect): /me/connect/onboard and /me/connect/status. Mounted BEFORE connectionsRouter, whose
// POST /connect/:platform would otherwise take "onboard" as a platform and answer 400 "Unsupported platform".
app.use("/api/v1/me", connectRouter);
app.use("/api/v1/me", connectionsRouter);
app.use("/api/v1/me", accountRouter);
app.use("/api/v1/me", milaChoicesRouter);
app.use("/api/v1/me", dealsRouter);
app.use("/api/v1/me", dealContractsRouter);
app.use("/api/v1/me", inboxRouter);
app.use("/api/v1/me", pendingActionsRouter);
// The card system v2's taps (MILA_CARDS_V2; answers 404 while the flag is off).
app.use("/api/v1/me", milaCardsRouter);
app.use("/api/v1/me", askTermsRouter);
app.use("/api/v1/me", agentActionsRouter);
// Workflow runner — athlete surface (each route applies requireAuth itself). The admin surface
// is mounted INSIDE adminRouter so it sits behind requireAdmin (see routes/admin.ts).
app.use("/api/v1/me", workflowAthleteRouter);
// Agent rebuild (Week 1): the new onboarding — research, understand, the adaptive conversation. Off unless exactly "true".
if (agentOnboardingEnabled()) app.use("/api/v1/me", agentOnboardingRouter);
// The onboarding front's public read (no sign-in, no athlete data): whether the agent onboarding runs here, and the
// sign-in photos. Always mounted; it answers { agentOnboarding: false } while AGENT_ONBOARDING is off.
app.use("/api/v1/public", onboardingFrontRouter());
// The plan step: GET /me/agent/goals (+ results and the goal writes). Off unless exactly "true"; the client falls back to
// the onboarding goals on 404.
if (agentPlanEnabled()) app.use("/api/v1/me", agentGoalsRouter);
// Mila's suggestions from the agent research refresh: her open one, and her answer (Update · Keep mine · Edit it).
// Always mounted: with AGENT_RESEARCH_REFRESH off nothing is ever suggested, so the read is { card: null }.
app.use("/api/v1/me", suggestionsRouter);
// Track E's post kits: read a post action's kit, build it, swap an asset, edit the caption. Off unless exactly "true".
if (agentPostKitsEnabled()) app.use("/api/v1/me", agentPostKitRouter);
// The Studio library's real data (today's decks + every built post kit). Off unless AGENT_V3 is exactly "true"; while
// dark the client's listStudioItems 404s and falls back to the pitches list, same as before this route existed.
if (agentStudioV3Enabled()) app.use("/api/v1/me", agentStudioRouter);
// "Ready for you" (content engine step 2): the made posts waiting on the athlete's tap, and "I posted it". Off unless
// CONTENT_READY_QUEUE and AGENT_POST_KITS are both exactly "true" (agent/ready/config.ts).
if (contentReadyQueueEnabled()) app.use("/api/v1/me", readyRouter);
// Mila hosts the waitlist join flow (MILA_TF_WAITLIST, dev only; routes/waitlistMila.ts). Mounted first: its own paths.
app.use("/api/v1/waitlist/mila", waitlistMilaRouter);
app.use("/api/v1/waitlist", waitlistRouter);
// The relay's review queue for held messages (requireAdmin). PUBLIC_CARD + PARTNER_INTAKE only.
if (partnerIntakeEnabled()) app.use("/api/v1/admin/relay", adminRelayRouter);
app.use("/api/v1/admin/payments", adminPaymentsRouter);   // admin refund / dispute / reversal actions (requireAdmin; human tap only)
app.use("/api/v1/admin/bookings", adminBookingsRouter);   // Bookings v2: the review queue + resolve (requireAdmin; 404 while BOOKINGS_ENABLED is off)
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/me", chatRouter);
// Mila chat v2: the Mastra turn as the AI SDK UI message stream (MILA_CHAT_V2, dev only; routes/chatV2.ts). Off = not mounted.
mountChatV2(app);
app.use("/api/v1/me", conversationsRouter);
app.use("/api/v1/me", pushRouter);
// Mila's voice and language (Me): GET/PUT /me/mila/voice-language (services/milaVoice).
app.use("/api/v1/me", milaVoiceSettingsRouter);
app.use("/api/v1/me", profileRouter);
// The athlete record: everything Nomila holds about them, with provenance (PR A).
app.use("/api/v1/me", recordRouter);
// Concept 0.4 Slice 1: the Me identity header + "What Nomila Knows", read from the canonical context directly.
app.use("/api/v1/me", meKnowledgeRouter);
app.use("/api/v1/me", meIntelligenceRouter);   // Concept 0.4 Slice 2: GET /me/intelligence (my-intelligence/0.1), read-only
app.use("/api/v1/me", meMiaPreviewRouter);    // M.I.A. preview from the new agent memory: GET (read) / POST (compute) /me/mia-preview
app.use("/api/v1/me", meAtmosphereRouter);     // atmosphere imagery picker: POST /me/atmosphere/pick (DESIGN.md §9); 404 unless ATMOSPHERE_IMAGERY
app.use("/api/v1/me", meMemoryRouter);        // Me on the agent memory: GET /me/scouting (scouting/1) + /me/facts (knows/1) and its edits; "no_memory" for athletes without memory facts
app.use("/api/v1/me", meStoryRouter);          // Concept 0.4 My Story: GET /me/story (identity-intelligence/0.2), read-only; IDENTITY_INTELLIGENCE_ENABLED
app.use("/api/v1/me", meIdentityRouter);       // PR E T6/T8: her own public-identity confirm / reject (athlete-authenticated)
app.use("/api/v1/me", meBrandsRouter);         // Brand imagery pipeline: "Confirm this is [brand]" — candidate / confirm / not_this
app.use("/api/v1/me", meRatesRouter);          // Your rates: GET/PUT /me/rates (suggested ranges, private minimums, public booking prices)
app.use("/api/v1/me", meBrandBookRouter);      // Brand book: GET/POST /me/brand-book, /line, /reel (services/brandBook)
app.use("/api/v1/me", searchRouter);
app.use("/api/v1/me", analyticsRouter);
app.use("/api/v1/me", mediaRouter);
// Studio Content Engine. Every route inside is gated on studioEnabled() and 404s with the flag off.
app.use("/api/v1/me", studioRouter);
// Create Anything threads. 404s unless STUDIO_ENABLED and STUDIO_SESSIONS are both on.
app.use("/api/v1/me", studioSessionsRouter);
app.use("/api/v1/me", paymentsRouter);
// Bookings v2, her side: offers, slots, requests, accept/decline … Every route 404s unless BOOKINGS_ENABLED and she is on
// BOOKINGS_PILOT_ATHLETE_IDS (server/services/bookings/config.ts).
app.use("/api/v1/me", bookingsRouter);
// Bookings v2, the buyer's side (account-less JSON for the public booking page): private token + email code, rate-limited.
// 404 while BOOKINGS_ENABLED is off. See server/routes/bookingsPublic.ts.
app.use("/api/v1/book", bookingsPublicRouter);
// App layout B: her money (Financials, the Opportunities strip) and her bookings at a glance — read-only.
app.use("/api/v1/me", financialsRouter);
// App layout B: Home's "What matters next" candidates across every tab — read-only; the client ranks.
app.use("/api/v1/me", whatMattersNextRouter);
app.use("/api/v1/me", askMilaChatsRouter);       // "Chats on your card": her public Mila transcripts (PUBLIC_CARD; read + delete her own)
// Her picks (docs/design/shop-her-picks.md): her shelf of her own links. Off unless SHOP_V1 is exactly "true".
if (shopEnabled()) app.use("/api/v1/me", shopRouter);
// Her public card (design-public-card-v3 PR 2): draft, preview, publish, unpublish, switches, handle. PUBLIC_CARD only.
if (publicCardEnabled()) app.use("/api/v1/me", mePublicCardRouter);
// "From your brands": her approved brands' Shopify catalogs. SHOP_SHOPIFY_APP (+ SHOP_V1) only.
if (shopifyAppEnabled()) app.use("/api/v1/me", shopBrandsRouter);
// Bookings v2, the session: her join token, Session done, Buyer didn't show, Report a problem, I'm OK. BOOKINGS_ENABLED
// only; every route also 404s by itself with the flag off (server/routes/bookingSession.ts).
if (BOOKINGS.enabled) app.use("/api/v1/me", athleteSessionRouter);
app.use("/pay", payRouter);
app.use("/confirm", confirmRouter);
app.use("/deposit", depositRouter);
app.use("/connect", connectReturnRouter);   // Stripe Connect onboarding return/refresh pages (public; re-read the account from Stripe)
// The public "delete your account" page (Google Play's web deletion link): a request form to hello@nomila.co, never a
// delete; in-app delete stays behind sign-in. See server/routes/accountDeletePage.ts.
app.use("/account", express.urlencoded({ extended: false, limit: "4kb" }), accountDeletePageRouter);
// The Partner door of her public profile (brand + press requests, the visitor's status page). PUBLIC_CARD + PARTNER_INTAKE
// only. The JSON door is for the public page and public Mila; the HTML pages are what the visitor's emails link to.
if (partnerIntakeEnabled()) {
  // What the Partner door may know about her: her PUBLISHED card, through the one public reader.
  setPublishedCardSource(publicCardReaderSource);
  app.use("/api/v1/public/cards", partnerApiRouter);
  app.use("/partner", partnerConfirmRouter);
  app.use("/r", express.urlencoded({ extended: false, limit: "16kb" }), partnerStatusRouter);
  app.use("/requests", express.urlencoded({ extended: false, limit: "4kb" }), partnerRequestsRouter);
  app.use("/api/v1/me", partnerAthleteRouter);   // her side: the request + thread, Decline, Agree (requireAuth)
}

// Informational only — never gated on config, so the liveness probe can't flap.
let envHealth: EnvHealth = { gmailPush: "missing" };

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", gmail_push: envHealth.gmailPush });
});

// GET /api/v1/athletes/:id/score — DELETED (legacy retirement P2-3, 8 Oct 2026). It served the legacy athletes_current
// row (sent as nulls since phase 1) and no app build calls it: the score is GET /me/overview's M.I.A.

// GET  /api/internal/voice/athletes/:id/score
// GET  /api/internal/voice/athletes/:id/deals[/:dealId]
// POST /api/internal/voice/athletes/:id/brand-knowledge  (POST only because the
//      key is a free-text brand name, not an id — still a pure, cache-only read.
//      NOTE: :id does no scoping work there — see that file's header.)
// POST /api/internal/voice/athletes/:id/brand-brief      (the RICH answer: same
//      cache-only brand read plus an app-generated fit narrative, read from a
//      precomputed store rather than generated on the request — fast, no model
//      call on any path. Unlike brand-knowledge its :id IS the tenancy boundary:
//      it scopes both the store key and the fill. See that file's header.)
// GET  /api/internal/voice/athletes/:id/voice-seed      (one line of context a
//      new session opens knowing, built from the STRUCTURED artifact and our own
//      template — never from chat_messages, which holds brand/email prose and
//      would be spoken aloud. `seed: null` when there is nothing to say.)
// POST /api/internal/voice/athletes/:id/voice-context   (the worker recording
//      what a turn DISCUSSED — ids and enums only. Handed the raw tool result;
//      the serializers in voiceContext.ts decide what survives, so there is one
//      place the jsonb invariant lives.)
// POST /api/internal/voice/athletes/:id/transcript      (the only WRITE in this
//      group: appends one spoken turn to the athlete's chat thread, so voice and
//      text share one transcript. source='voice', role unchanged. Writing here
//      does NOT make these rows readable by a later voice session — that is
//      seeded from structure. See that file's header.)
// POST /api/internal/voice/athletes/:id/deal-brief       (the DEAL-AWARE answer,
//      keyed by brand NAME with no id of any kind. Precedence deal > inbox >
//      none: a brand the athlete has a deal with is one we know something about
//      even when inbox_brands never enriched it. See that file's header.)
// Read-only lookups for the voice worker (trusted infra, not a user). Protected
// by their OWN secret + header (VOICE_SERVICE_SECRET / x-voice-secret),
// deliberately NOT CRON_SECRET — see server/voice/auth.ts. Fail-closed: with the
// env var unset every request is 401. Each route also checks the athlete-bound
// session grant (x-voice-grant, VOICE_GRANT_SECRET) via `voiceAuthorized` —
// logged only until VOICE_GRANT_ENFORCE=true, then 401/403 — and the account-deletion
// fence: an athlete being deleted gets 410 account_deleting on every route.
app.use("/api/internal/voice", voiceScoreRouter);
app.use("/api/internal/voice", voiceShareSignalsRouter);
app.use("/api/internal/voice", voiceDealRouter);
// The only voice route that carries brand-authored email text. The worker wraps
// every string it returns in <external_content> — see ./voice/threadRoutes.
app.use("/api/internal/voice", voiceThreadRouter);
// The only voice route that carries WEB text, and the only one that leaves our
// network. Dark behind MILA_VOICE_WEB_SEARCH; the worker wraps every string it
// returns in <external_content>, same as the thread route above.
app.use("/api/internal/voice", voiceWebSearchRouter);
app.use("/api/internal/voice", voiceBrandKnowledgeRouter);
app.use("/api/internal/voice", voiceBrandBriefRouter);
app.use("/api/internal/voice", voiceDealBriefRouter);
app.use("/api/internal/voice", voiceTranscriptRouter);
app.use("/api/internal/voice", voiceSeedRouter);
app.use("/api/internal/voice", voiceContextRouter);
app.use("/api/internal/voice", voiceDraftIntentRouter);
app.use("/api/internal/voice", voiceProfileRouter);
// GET  /api/internal/voice/athletes/:id/onboarding                       (the first-entry block
//      the chat loop also uses, so voice opens with the same facts and rules)
// POST /api/internal/voice/athletes/:id/onboarding/steps/:step/complete  (the voice twin of the
//      complete_onboarding_step tool; mode='voice' on the receipt)
app.use("/api/internal/voice", voiceOnboardingRouter);
// POST /api/internal/voice/session  (ONE MILA FOR VOICE, MILA_VOICE_ONE: Mila's one definition for voice, the chat's
//      CONTEXT and the registry's tools as Gemini Live declarations)
// POST /api/internal/voice/tool     (every voice tool call through the chat's guarded path, callPassTool; the athlete
//      comes from the REQUIRED grant). Both 404 while the flag is off. See server/voice/oneMila/routes.ts.
app.use("/api/internal/voice", voiceOneMilaRouter);

// POST /voice/token — the browser's join token for a LiveKit room the voice
// worker is dispatched into. Unlike the internal routers above, the caller here
// is a USER, not infrastructure: it is guarded by `requireAuth` + a per-athlete
// rate limit, and the athlete it mints for comes from the verified session and
// never from the request. Gated on MILA_VOICE_WEB (default off) so voice can be
// switched on — or killed — by config rather than by deploy; the flag is
// re-checked in the route's own middleware and again inside its handler.
if (MILA.VOICE_WEB) {
  app.use(voiceTokenRouter);
  logger.info("Mila web voice enabled: POST /voice/token");
}

// POST /api/internal/dev/test-email  { to }
// One-off check of the transactional email channel (EMAIL_PROVIDER) using the runtime service account's identity.
// CRON_SECRET guarded AND dev-only: 404 on any non-dev deployment (server/routes/devTestEmail.ts).
app.use(createDevTestEmailRouter({ secretValid: cronSecretValid }));

// POST /api/internal/ig-token-refresh
// Called by Cloud Scheduler every 50 days. Protected by CRON_SECRET header.
app.post("/api/internal/ig-token-refresh", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await refreshInstagramToken();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    // Every failure has a name (PR 7, G2): the kind and its token-free detail on the log line, and a
    // status Scheduler can tell apart — 424 token_expired, 502 secret_write_failed, 503 transient,
    // 500 misconfigured. The message's innards stay in the log.
    const kind = err instanceof IgTokenRefreshError ? err.kind : "unknown";
    const detail = err instanceof IgTokenRefreshError ? err.detail : {};
    logger.error({ kind, ...detail, error: err.message }, "IG token refresh failed");
    const { status, body } = statusForRefreshError(err);
    res.status(status).json(body);
  }
});

// POST /api/internal/stories-sweep and /api/internal/stories-last-look
// Phase A Step 1b. The same two jobs the in-process crons run, exposed for Cloud Scheduler
// (prod enablement, decision O6). No-ops unless SOCIAL_STORIES_WRITE=true. CRON_SECRET guarded.
app.post("/api/internal/stories-sweep", async (req, res) => {
  if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { runStorySweep } = await import("./skills/collectInstagramStories.js");
    res.json({ ok: true, summary: await runStorySweep() });
  } catch (err: any) {
    logger.error({ error: err.message }, "Story sweep endpoint failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
app.post("/api/internal/stories-last-look", async (req, res) => {
  if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { runStoryLastLookTick } = await import("./skills/collectInstagramStories.js");
    res.json({ ok: true, summary: await runStoryLastLookTick() });
  } catch (err: any) {
    logger.error({ error: err.message }, "Story last-look endpoint failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/research-planner-cron[?dryRun=true]
// Phase A Step 2b: the nightly research planner pass (Cloud Scheduler → this route → advisory lock).
// Dry-run (writes only its research_planner_runs row) unless BOTH RESEARCH_REFRESH_ENABLED and
// RESEARCH_SUBSTRATE_WRITE are true; ?dryRun=true forces dry-run. Bounded under the Scheduler deadline.
app.post("/api/internal/research-planner-cron", async (req, res) => {
  if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { runResearchPlanner } = await import("./services/intelligence/research/planner.js");
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    res.json({ ok: true, summary: await runResearchPlanner({ dryRun, budgetMs: 540_000 }) });
  } catch (err: any) {
    logger.error({ error: err.message }, "Research planner endpoint failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/shopify-reconcile-cron
// Cloud Scheduler, daily: a full catalog sync of every installed Shopify store (the catalog-only app,
// docs/design/shop-her-picks.md §12). A no-op answer while SHOP_SHOPIFY_APP is off. Protected by CRON_SECRET header.
app.post("/api/internal/shopify-reconcile-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const cfg = shopifyConfig();
  if (!shopifyAppEnabled() || !cfg) { res.json({ ok: true, skipped: true }); return; }
  try {
    const { reconcileAll } = await import("./services/shopify/catalog");
    res.json({ ok: true, ...(await reconcileAll(cfg)) });
  } catch (err: any) {
    logger.error({ error: err.message }, "Shopify reconcile failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/archive-stale-cron
// Called by Cloud Scheduler daily. Archives dormant, untouched deal-threads (no
// activity in 45+ days, still detected/pending) — reversible via the Last-30 receipt. With MILA_WELCOME on it
// files only for athletes who turned on auto_archive (welcome/gate.ts); off, every athlete as before.
// Protected by CRON_SECRET header.
app.post("/api/internal/archive-stale-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await archiveStaleDeals();
    // Phase A Step 3b: the 7-day identity-claim sweep rides the same daily cron (plan P-8)
    const expiredClaims = await import("./services/intelligence/identity/claims").then(({ expireStale }) => expireStale()).catch((err: any) => { logger.warn({ error: err.message }, "identity claim sweep failed"); return -1; });
    // MAILBOX_ZERO_RETENTION: pending / failed / draft reply-text TTLs ride the same daily cron
    // (a no-op with the flag off). Its failure never fails the deal sweep.
    const mailboxRetention = await import("./services/mailboxRetentionSweep").then(({ sweepMailboxRetention }) => sweepMailboxRetention()).catch((err: any) => { logger.warn({ error: err.message }, "mailbox retention sweep failed"); return null; });
    res.json({ ok: true, ...result, expiredClaims, mailboxRetention });
  } catch (err: any) {
    logger.error({ error: err.message }, "Stale-deal archive sweep failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/plan-refresh-cron
// Called by Cloud Scheduler daily. The plan step's sweep: a weekly plan refresh for every athlete with a current Brief
// and none in the last 7 days, and an event refresh when a dated event is 3–14 days out with nothing due before it. Also
// the after-event wake-up: a game that passed 1–2 days ago becomes one "event_passed" app event (MILA_PROACTIVE + GAME_DAY_SIGNALS).
// Only starts plan_refresh runs (the workflow tick runs them); a no-op unless AGENT_PLAN is "true".
// Protected by CRON_SECRET header.
app.post("/api/internal/plan-refresh-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { sweepPlanRefresh } = await import("./agent/plan/triggers");
    const planned = await sweepPlanRefresh();
    // The after-event wake-up (agent/events/games.ts): a game of theirs that just passed is one app event for Mila to
    // think about (MILA_PROACTIVE; a no-op while it is off). Never fails the plan sweep.
    let passedGames: { athletes: number; events: number } | null = null;
    try {
      const [{ milaProactiveEnabled }, { gameDaySignalsEnabled }] = await Promise.all([import("./agent/proactive/config"), import("./agent/events/config")]);
      if (milaProactiveEnabled() && gameDaySignalsEnabled()) {
        const { dbPassedGamesDeps, sweepPassedGames } = await import("./agent/events/games");
        passedGames = await sweepPassedGames(await dbPassedGamesDeps());
      }
    } catch (err: any) {
      logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "passed-games sweep failed");
    }
    res.json({ ok: true, enabled: agentPlanEnabled(), ...planned, passedGames });
  } catch (err: any) {
    logger.error({ error: err.message }, "Plan refresh sweep failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/moments-scan-cron (server/agent/moments/routes.ts)
// Called by Cloud Scheduler daily at 12:00 UTC (moments 12:00 → post ideas 13:00 → plan 14:00). The weekly moments
// sweep: a scan for every athlete with a current Brief and none in the last 7 days. Only starts moments_scan runs (the workflow tick
// runs them); a no-op unless AGENT_MOMENTS is "true". Protected by CRON_SECRET header.
app.use(momentsCronRouter(cronSecretValid));
// POST /api/internal/agent-research-refresh-cron (server/agent/researchRefresh/routes.ts)
// The agent research refresh's daily sweep: stale athletes (no agent research in 30 days) and anchor edits, at most 5
// a sweep under a daily cost cap. Starts nothing unless AGENT_RESEARCH_REFRESH AND AGENT_RESEARCH_REFRESH_COHORT are
// both "true" (owner, 12 Oct 2026: Mia first, by hand; the cohort after her result is checked). CRON_SECRET header.
app.use(researchRefreshCronRouter(cronSecretValid));
// POST /api/internal/post-ideas-cron
// Called by Cloud Scheduler daily. The post-kit builder's reverse pass (design "Moments → post kits" §10): for athletes
// with a current Brief and new tagged media, one cheap-tier call proposes post ideas from new, unused assets into the
// idea bank (memory_decisions kind other, detail.kind idea). A no-op unless AGENT_POST_KITS is "true".
// Protected by CRON_SECRET header.
app.post("/api/internal/post-ideas-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    if (!agentPostKitsEnabled()) {
      res.json({ ok: true, enabled: false });
      return;
    }
    const [{ sweepPostIdeas }, { dbPostKitDeps }] = await Promise.all([import("./agent/postKit/ideas"), import("./agent/postKit/deps")]);
    res.json({ ok: true, ...(await sweepPostIdeas(dbPostKitDeps())) });
  } catch (err: any) {
    logger.error({ error: err.message }, "Post ideas sweep failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/playbook-refresh-cron (server/agent/playbook/routes.ts)
// Called by Cloud Scheduler daily. The shared content playbook's sweep (design "Moments → post kits" §5): refresh
// every (sport, stage, platform) key in the live roster whose active row is missing or STALE — one fast-tier +
// web_search call per stale key, shared across every athlete at that key; a given key is refreshed only roughly
// once a month (triggers.ts isStale). A no-op unless AGENT_PLAYBOOK is "true". Protected by CRON_SECRET header.
app.use(playbookCronRouter(cronSecretValid));
// POST /api/internal/post-kit-preview-cleanup-cron (server/agent/postKit/render/cleanupRoutes.ts)
// Called by Cloud Scheduler daily at 03:30 UTC. Superseded post-kit preview renders: a preview row whose key is no longer
// its kit's is soft-deleted after 24 h, and its files are deleted from storage 7 days later; per athlete, preview rows
// only. A no-op unless AGENT_POST_KIT_PREVIEW_CLEANUP is "true". Protected by CRON_SECRET header.
app.use(previewCleanupCronRouter(cronSecretValid));
// POST /api/internal/agent-spend-cron (server/agent/spendCron.ts)
// Called by Cloud Scheduler hourly. Today's (UTC) agent_runs spend by provider as log lines for the spend metric and
// alert (scripts/monitoring/prod-release-monitoring.sh). Read-only, $0. Protected by CRON_SECRET header.
app.use(agentSpendCronRouter(cronSecretValid));
// POST /api/internal/push-receipts-cron (server/routes/push.ts)
// Called by Cloud Scheduler every 30 minutes (declared, not yet provisioned). Expo's delivery receipts for recent pushes:
// a token Expo no longer knows is removed, other error codes are recorded on the send row. A no-op unless
// PUSH_NOTIFICATIONS is "true". Protected by CRON_SECRET header.
app.use(pushReceiptsCronRouter(cronSecretValid));

// POST /api/internal/workflow-tick
// Called by Cloud Scheduler every minute. One consumer pass of the workflow runner: expire
// dead leases, claim up to WORKFLOW_TICK_BATCH ready steps (SKIP LOCKED), run each inside its
// own trace, advance the runs. The advisory lock keeps three Cloud Run instances from ticking
// at once; a skipped tick is correct, the next minute picks the work up. The kick path inside
// start/complete handles the latency-sensitive steps, so this can stay lazy.
// Protected by CRON_SECRET header. See server/workflow/runner.ts.
const WORKFLOW_TICK_LOCK_KEY = 0x574b464c4f5701n; // "WKFLOW" + 01
app.post("/api/internal/workflow-tick", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!runsBackgroundWork()) {
    res.json({ ok: true, skipped: true, reason: "background work runs on Cloud Run only (lib/backgroundHost)" });
    return;
  }
  try {
    const outcome = await withWorkflowTickLock(WORKFLOW_TICK_LOCK_KEY, async () => {
      // The daily research cap (agent/onboarding/dailyCap.ts): start queued sign-up research while there is budget,
      // before the tick claims, so a released run starts in this same pass. Never fails the tick.
      try {
        const { releaseQueuedOnboardings } = await import("./agent/onboarding/dailyCap");
        await releaseQueuedOnboardings();
      } catch (err: any) { logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "daily research cap release failed"); }
      return workflowTick();
    });
    if (!outcome.ran) {
      res.json({ ok: true, skipped: true, reason: "another instance is ticking" });
      return;
    }
    res.json({ ok: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "Workflow tick failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/media-poster-cron
// Called by Cloud Scheduler every few minutes. Generates a poster (+ best-effort 1080p
// transcode via ffmpeg) for uploaded videos that have none yet, so they render in the
// library grid. Runs as a full-CPU request (fire-and-forget wouldn't finish on Cloud Run).
// Protected by CRON_SECRET header.
app.post("/api/internal/media-poster-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { processPosterBatch } = await import("./services/videoPoster.js");
    const result = await processPosterBatch();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ error: err.message }, "media-poster cron failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/studio-video-tick
// The consumer for detached video generation jobs (A6.1). Called by Cloud Scheduler, and kicked
// inline by POST /studio/generate so a clip starts immediately rather than at the next tick.
//
// One pass: reap expired leases · claim queued jobs · submit-once or resume-poll · store · close.
// Under the advisory lock for the same reason the workflow tick is — SKIP LOCKED already stops two
// ticks claiming the same row, so this only stops three instances burning CPU on an empty queue.
//
// ⚠️  MONEY PATH. A job here has already had its approval consumed. It must never be re-submitted to
// the provider — see the submit-once pair in server/studio/videoJobs.ts. Protected by CRON_SECRET.
// The edit-batch tick (studio/edit/batch.ts, PR 9 Lane 4) — the same shape as the video tick, its own lock,
// its own claim (`mode = 'edit'`; the video tick takes `mode <> 'edit'`). One owner per job — rider 1.
const STUDIO_EDIT_TICK_LOCK_KEY = 0x53544544_4f01n; // "STED" + 01
app.post("/api/internal/studio-edit-tick", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    // D6 (PR 20, studio/tickGate.ts): a tick whose flag is off does nothing and spends nothing —
    // asked before the lock and before the runner loads.
    const { tickGate } = await import("./studio/tickGate.js");
    const gate = tickGate("edit");
    if (!gate.run) {
      res.json({ ok: true, skipped: true, reason: gate.reason });
      return;
    }
    const { editTick } = await import("./studio/edit/batch.js");
    const outcome = await withWorkflowTickLock(STUDIO_EDIT_TICK_LOCK_KEY, () => editTick());
    if (!outcome.ran) {
      res.json({ ok: true, skipped: true, reason: "another instance is ticking" });
      return;
    }
    res.json({ ok: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "studio edit tick failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const STUDIO_VIDEO_TICK_LOCK_KEY = 0x53545644_4f01n; // "STVD" + 01
app.post("/api/internal/studio-video-tick", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!runsBackgroundWork()) {
    res.json({ ok: true, skipped: true, reason: "background work runs on Cloud Run only (lib/backgroundHost)" });
    return;
  }
  try {
    // D6 (PR 20, studio/tickGate.ts): a tick whose flag is off does nothing and spends nothing —
    // asked before the lock and before the runner loads.
    const { tickGate } = await import("./studio/tickGate.js");
    const gate = tickGate("video");
    if (!gate.run) {
      res.json({ ok: true, skipped: true, reason: gate.reason });
      return;
    }
    const { videoTick } = await import("./studio/videoRunner.js");
    const outcome = await withWorkflowTickLock(STUDIO_VIDEO_TICK_LOCK_KEY, () => videoTick());
    if (!outcome.ran) {
      res.json({ ok: true, skipped: true, reason: "another instance is ticking" });
      return;
    }
    res.json({ ok: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "studio video tick failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/studio-stitch-tick
// The consumer for detached STITCH jobs (video V7). Called by Cloud Scheduler, and kicked inline by
// POST /studio/stitch so a timeline starts immediately rather than at the next tick.
//
// One pass: reap expired leases · claim up to this instance's remaining capacity · START each ·
// return. IT DOES NOT WAIT FOR ffmpeg — cpu-throttling is off (gcp/cloud-run-*.yaml), so work begun
// after the response keeps its CPU, and returning immediately hands `withAdvisoryLock` its pooled
// PG client back in milliseconds instead of holding one for a ten-minute encode.
//
// ⚠️  DELIBERATELY SEPARATE FROM /api/internal/studio-video-tick, AND NOT A MONEY PATH. That one
// submits to Vertex and carries a submit-once pair because a lost handle may already have been paid
// for. This one runs ffmpeg: $0 by construction, no provider, no model, and studio_stitch_jobs has
// no cost column. Its reaper therefore requeues a lapsed job ALWAYS, where the video reaper fails
// it closed. Two endpoints and two lock keys so neither posture can be applied to the other queue
// by editing one function. Protected by CRON_SECRET.
//
// The advisory lock only stops several instances burning CPU on an empty queue; the bound that
// matters — one workspace at a time per instance, because /tmp is RAM — is held in the runner.
const STUDIO_STITCH_TICK_LOCK_KEY = 0x53545644_4f02n; // "STVD" + 02 — must differ from the video key above
app.post("/api/internal/studio-stitch-tick", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    // D6 (PR 20, studio/tickGate.ts): a tick whose flag is off does nothing and spends nothing —
    // asked before the lock and before the runner loads.
    const { tickGate } = await import("./studio/tickGate.js");
    const gate = tickGate("stitch");
    if (!gate.run) {
      res.json({ ok: true, skipped: true, reason: gate.reason });
      return;
    }
    const { stitchTick } = await import("./studio/stitchRunner.js");
    const outcome = await withWorkflowTickLock(STUDIO_STITCH_TICK_LOCK_KEY, () => stitchTick());
    if (!outcome.ran) {
      res.json({ ok: true, skipped: true, reason: "another instance is ticking" });
      return;
    }
    res.json({ ok: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "studio stitch tick failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/studio-publish-tick
// The consumer for detached PUBLISH jobs (studio/publish). Called by Cloud Scheduler, and kicked
// inline by POST /studio/publish so a post starts immediately rather than at the next tick.
//
// One pass: reap expired leases · claim up to this instance's remaining capacity · START each ·
// return. It does not wait for Instagram — same reasoning as the stitch tick above.
//
// ⚠️  NOT A MONEY PATH, AND WORSE TO GET WRONG THAN ONE. It makes public posts on real people's
// accounts. The guarantee — Instagram's publish is called at most once per job row, ever — is NOT
// held here or by this lock: it is one compare-and-set in server/studio/publish/jobs.ts
// (recordPublishAttempt). This endpoint may be called twice, concurrently, by three instances, and
// the number of posts does not change.
//
// STUDIO_PUBLISH_MODE (off | dry | live, default off) is read by the runner, not here: with it off
// the tick still runs, to CLOSE what was waiting, and makes no call to Meta. A third endpoint and a
// third lock key so neither of the other two queues' postures can be applied to this one by editing
// one function. Protected by CRON_SECRET.
const STUDIO_PUBLISH_TICK_LOCK_KEY = 0x53545644_4f03n; // "STVD" + 03 — must differ from both keys above
app.post("/api/internal/studio-publish-tick", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { publishTick } = await import("./studio/publish/runner.js");
    const outcome = await withWorkflowTickLock(STUDIO_PUBLISH_TICK_LOCK_KEY, () => publishTick());
    if (!outcome.ran) {
      res.json({ ok: true, skipped: true, reason: "another instance is ticking" });
      return;
    }
    res.json({ ok: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "studio publish tick failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/gmail-backfill
// Trigger a 90-day inbox backfill for a specific Gmail connection.
// Body: { connectionId: string, athleteId: string, windowDays?: number }
app.post("/api/internal/gmail-backfill", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { connectionId, athleteId, windowDays } = req.body ?? {};
  if (!connectionId || !athleteId) {
    res.status(400).json({ error: "connectionId and athleteId required" });
    return;
  }
  // Respond immediately — backfill can take minutes
  res.json({
    ok: true,
    message: "Backfill started — check server logs for progress",
  });
  import("./skills/gmailBackfill.js").then(({ runGmailBackfill }) => {
    runGmailBackfill({ connectionId, athleteId, windowDays }).catch(
      (err: any) =>
        logger.error(
          { connectionId, athleteId, error: err.message },
          "Manual gmail backfill threw",
        ),
    );
  });
});

// POST /api/internal/gmail-cron-sync
// The inbox polling fallback across all active connections — the PRIMARY ingestion
// trigger (Cloud Scheduler job `inbox-cron-sync`, see scripts/provision-schedulers.sh).
// Route name kept for backward-compat; now syncs all inbox providers.
//
// AWAITs the work within the request, per #177 (media-enrich-cron): the previous
// respond-then-run shape returned 200 for a tick that may never have finished, so a
// silently-failing poll was indistinguishable from a healthy one. Bounded by a
// wall-clock budget that stays under the Scheduler attempt deadline (1800s) and the
// Cloud Run request timeout (3600s); syncRecent is idempotent, so the next tick resumes.
//
// Advisory-locked: minScale 1 / maxScale 3 means the in-process cron below already runs
// on up to 3 instances, and Scheduler adds a 4th caller. Overlapping runs would push the
// same messages through detectDeal several times at once.
app.post("/api/internal/gmail-cron-sync", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { withAdvisoryLock, LOCK_INBOX_SYNC } = await import(
      "./lib/pgAdvisoryLock.js"
    );
    const { runInboxCronSync } = await import("./skills/inboxCronSync.js");
    const outcome = await withAdvisoryLock(LOCK_INBOX_SYNC, () =>
      runInboxCronSync({ budgetMs: 1_500_000 }),
    );
    if (!outcome.ran) {
      // 200, not an error: another instance is doing the work right now.
      res.json({
        ok: true,
        ran: false,
        reason: "another instance holds the inbox sync lock",
      });
      return;
    }
    res.json({ ok: true, ran: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "gmail-cron-sync threw");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/instagram-sync
// Trigger Instagram DM sync for a specific connection.
// Body: { connectionId: string, athleteId: string }
app.post("/api/internal/instagram-sync", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { connectionId, athleteId } = req.body ?? {};
  if (!connectionId || !athleteId) {
    res.status(400).json({ error: "connectionId and athleteId required" });
    return;
  }
  res.json({
    ok: true,
    message: "Instagram sync started — check server logs for progress",
  });
  import("./lib/integrations/instagramSync.js").then(({ syncInstagramDMs }) => {
    syncInstagramDMs({ connectionId, athleteId }).catch((err: any) =>
      logger.error(
        { connectionId, athleteId, error: err.message },
        "Manual instagram sync threw",
      ),
    );
  });
});

// POST /api/internal/social-analytics-cron
// Capture a fresh social_analytics_snapshots row for every active connection on a
// supported platform (Instagram, TikTok). Bounded concurrency inside the skill.
// Display/trend layer only — never touches scoring (kept as a separate job).
app.post("/api/internal/social-analytics-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    ok: true,
    message:
      "Social analytics collection started — check server logs for progress",
  });
  import("./skills/collectSocialAnalytics.js").then(
    ({ collectAllAnalyticsSnapshots }) => {
      collectAllAnalyticsSnapshots().catch((err: any) =>
        logger.error(
          { error: err.message },
          "Manual social-analytics-cron threw",
        ),
      );
    },
  );
});

// POST /api/internal/media-enrich-cron
// Enrich the media library (vision tags + multimodal embeddings) for the Media Intelligence Layer.
// Resumable + idempotent (skips already-enriched) + background: drains UN-enriched assets in bounded
// chunks so a new athlete's whole library gets indexed without holding up the user or agents; a failed
// run is safely resumed on the next tick. Body: { athleteId?, chunk?, maxTicks? }.
app.post("/api/internal/media-enrich-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { athleteId, chunk, maxTicks } = req.body ?? {};
  try {
    // AWAIT the work within the request. Cloud Run throttles CPU to ~zero after the
    // response is sent, so the previous fire-and-forget loop here stalled and never
    // drained — which is why every asset stayed enriched=false. Bounded by a wall-clock
    // budget that stays under the Cloud Run request timeout AND the scheduler deadline;
    // the 15-min cron resumes the rest (UNENRICHED is resumable + idempotent).
    const { enrichNextChunk } = await import("./services/mediaEnrichment.js");
    // CAMERA_ROLL_INTAKE: scored-preview rows older than the purge window go (media_review_items, 0131) — everyone's,
    // one cheap DELETE per tick. Best effort: enrichment never waits on it.
    const { cameraRollIntakeEnabled, intakeConfig } = await import("./lib/cameraRollIntake.js");
    if (cameraRollIntakeEnabled()) {
      const { purgeOld } = await import("./services/reviewItems.js");
      await purgeOld(intakeConfig().purgeAfterHours).catch((e: any) => logger.warn({ error: e?.message }, "review-item purge failed"));
    }
    const cap = Number(maxTicks ?? 60);
    const BUDGET_MS = 160_000;
    const started = Date.now();
    let tagged = 0,
      embedded = 0,
      failed = 0,
      skipped = 0,
      abandoned = 0,
      raced = 0,
      remaining = 0,
      ticks = 0;
    for (let tick = 0; tick < cap; tick++) {
      const r = await enrichNextChunk({
        athleteId,
        chunk: chunk ? Number(chunk) : undefined,
      });
      tagged += r.tagged;
      embedded += r.embedded;
      failed += r.failed;
      skipped += r.skipped;
      // Set down (no retry coming) and read-twice are not failures, and a response that hid them
      // read `failed:0 remaining:0` over a row that had just been abandoned (22 Sep 2026).
      abandoned += r.abandoned;
      raced += r.raced;
      remaining = r.remaining;
      ticks++;
      if (r.remaining === 0 || r.total === 0) break;
      if (Date.now() - started > BUDGET_MS) break; // leave the rest for the next tick
    }
    // CAMERA_ROLL_INTAKE: the transcript backfill — one bounded pass over her older clips, only with time left in this
    // request (services/mediaEnrichment.ts backfillTranscripts; null with the flag off).
    let transcripts: unknown = null;
    if (Date.now() - started < BUDGET_MS) {
      const { backfillTranscripts } = await import("./services/mediaEnrichment.js");
      transcripts = await backfillTranscripts({ athleteId }).then(
        (r) => (r ? { tagged: r.tagged, failed: r.failed, remaining: r.remaining, spentUsd: r.spentUsd } : null),
        (e: any) => { logger.warn({ error: e?.message }, "transcript backfill failed"); return null; },
      );
    }
    res.json({ ok: true, ticks, tagged, embedded, failed, skipped, abandoned, raced, remaining, transcripts });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "media-enrich-cron threw");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/brand-refresh-cron
// Keep the shared Brand Intelligence layer fresh (Spec 9): re-research STALE + PIPELINE
// brands only (is_agency=false AND attributed to a thread/sender) so per-brand cards +
// deal scoring read up-to-date profiles. SELECTIVE (never touches junk/agency rows) and
// bounded (a limit per tick; the next tick resumes). Body: { limit?, staleDays? }.
app.post("/api/internal/brand-refresh-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { limit, staleDays } = req.body ?? {};
  res.json({
    ok: true,
    message: "Brand refresh started — check server logs for progress",
  });
  import("./services/brandIntel.js").then(async ({ refreshStaleBrands }) => {
    try {
      await refreshStaleBrands({
        limit: limit != null ? Number(limit) : undefined,
        staleDays: staleDays != null ? Number(staleDays) : undefined,
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "brand-refresh-cron threw");
    }
  });
});

// The Nomi Card read routes — /card/:athleteId (owner preview), /api/card/themes,
// /api/card/:athleteId (requireAuth + ownership) and the public share /c/:shareId.
// See server/routes/card.ts (security fix A1).
app.use(cardRouter);

// The PUBLIC athlete page /p/:handle (public profile v2). PUBLIC_CARD only, read per request: off → every /p route 404s.
// See server/routes/publicPage.ts.
// The page reads the published snapshot through publicCardReader (snapshotAdapter.loadView); nothing else.
// Public Mila mode on that page: POST /p/:handle/ask (+ the visitor's booking / partner taps). ASK_MILA_PUBLIC and
// PUBLIC_CARD, read per request: off → 404. The two ports are null until their tracks wire them — bookings
// (feat/bookings-flow, the buyer API) and partner intake (feat/partner-intake-relay); null hides their tools and taps.
// See server/routes/askMilaPublic.ts.
// Bookings: the booking service's PublicBookingsPort (#879): read-only open slots, and one pending request on the
// visitor's own tap. It answers nothing while BOOKINGS_ENABLED is off, and is not offered to Mila for an athlete off the
// pilot list. Partner: the Partner door's PartnerIntakePort — a request-kind tap continues on her card's Partner page
// (/p/:handle/partner?kind=…), which files through the door's own draft → email confirm path; closed while
// PARTNER_INTAKE is off.
const askMilaPorts: PublicMilaPorts = { bookings: createPublicBookingsPort(), partner: partnerIntakeEnabled() ? createPartnerIntakePort() : null };
app.use(createAskMilaPublicRouter(askMilaPorts));
// The Front Door's counts (0121): each page view is counted per day (no visitor data), and the visitor's heart posts to
// POST /p/:handle/like (one like per visitor, a keyed hash of the visitor's own token). See server/routes/publicPageLike.ts.
app.use(publicPageLikeRouter);
app.use(createPublicPageRouter({
  loadView: loadPublicCardView,
  // The page in the brand book's engine (front door v2.1); null → the classic snapshot page.
  renderEngine: async (view, paths) => (await import("./services/nomiDeck/publicPage.js")).renderEnginePublicPage(view, paths),
  engineCss: () => frontDoorStylesheet(),
  askTaps: { booking: !!askMilaPorts.bookings, partner: !!askMilaPorts.partner },
  onView: (handle) => recordPageView(handle),
}));

// Bookings v2: the buyer's session page /s/:token (the call, "How did it go?") and the check-in page /ok/:token, at the
// root like /c/:shareId. BOOKINGS_ENABLED only.
if (BOOKINGS.enabled) app.use(buyerSessionRouter);
// The buyer's private booking page /b/:token (every booking email links here). BOOKINGS_ENABLED only.
if (BOOKINGS.enabled) app.use(bookingStatusPageRouter);

// Her picks: the public click redirect /go/:code, at the root like /c/:shareId (never under /me). SHOP_V1 only.
if (shopEnabled()) app.use(shopRedirectRouter);
// The public Nomi Card read, GET /api/public/cards/:handle (design-public-card-v3 §11). PUBLIC_CARD only; reads only
// through publicCardReader (the published snapshot, nothing else).
if (publicCardEnabled()) app.use(publicCardRouter);
// The Shopify app's own pages (/shopify/app, /shopify/callback, the brand page). SHOP_SHOPIFY_APP (+ SHOP_V1) only.
if (shopifyAppEnabled()) app.use(shopifyAppRouter());

// GET /api/v1/athletes/:id/pitches — the athlete's brand-specific pitches with DERIVED status
// (ready/sent/opened + stale). See docs/studio-pitches-plan.md. The Studio hub + Pitches list read this.
app.get("/api/v1/athletes/:id/pitches", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const { listPitches } = await import("./services/pitches.js");
    res.json({ pitches: await listPitches(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: "failed to list pitches" });
  }
});

// POST /api/v1/athletes/:id/pitches/:brandId/rebuild — force a fresh brand-tailored build.
app.post(
  "/api/v1/athletes/:id/pitches/:brandId/rebuild",
  requireAuth,
  async (req, res) => {
    if (req.athleteId !== req.params.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const brandId = Number(req.params.brandId) || 0;
    if (!brandId) {
      res.status(400).json({ error: "brandId required" });
      return;
    }
    try {
      const { buildAndCacheKit } = await import("./services/kitCache.js");
      await buildAndCacheKit(req.params.id, { brandId });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "rebuild failed" });
    }
  },
);

// GET /api/v1/athletes/:id/pitch-insights?brandId=N — the "confirm the angle" insights (Studio
// Gate 2): the brand's current campaigns (already researched) + grounded fit angles.
app.get(
  "/api/v1/athletes/:id/pitch-insights",
  requireAuth,
  async (req, res) => {
    if (req.athleteId !== req.params.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const brandId = Number(req.query.brandId) || 0;
    if (!brandId) {
      res.status(400).json({ error: "brandId required" });
      return;
    }
    try {
      const { pitchInsights } = await import("./services/pitches.js");
      const insights = await pitchInsights(req.params.id, brandId);
      if (!insights) {
        res.status(404).json({ error: "brand not found" });
        return;
      }
      res.json(insights);
    } catch (err: any) {
      res.status(500).json({ error: "insights failed" });
    }
  },
);

// GET /api/v1/athletes/:id/pitch-insights-stream?brandId=N — SSE variant of pitch-insights: streams
// the research step timeline (Studio Gate 2's approach), then returns the insights in the done event.
app.get(
  "/api/v1/athletes/:id/pitch-insights-stream",
  requireAuth,
  async (req, res) => {
    if (req.athleteId !== req.params.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const brandId = Number(req.query.brandId) || 0;
    if (!brandId) {
      res.status(400).json({ error: "brandId required" });
      return;
    }
    const { openSSEStream } = await import("./lib/sse.js");
    const { pitchInsights } = await import("./services/pitches.js");
    const sse = openSSEStream(res, req);
    try {
      const insights = await pitchInsights(req.params.id, brandId, (label) =>
        sse.status(label),
      );
      if (!insights) sse.error("brand not found");
      else sse.done({ insights });
    } catch (err: any) {
      sse.error("insights failed");
    } finally {
      sse.close();
    }
  },
);

// GET /api/v1/athletes/:id/pitches/:brandId/build-stream — SSE: build the tailored deck and stream
// the agent's step timeline (Studio Gate 3). Reuses the chat SSE transport (server/lib/sse.ts).
app.get(
  "/api/v1/athletes/:id/pitches/:brandId/build-stream",
  requireAuth,
  async (req, res) => {
    if (req.athleteId !== req.params.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const brandId = Number(req.params.brandId) || 0;
    if (!brandId) {
      res.status(400).json({ error: "brandId required" });
      return;
    }
    const { openSSEStream } = await import("./lib/sse.js");
    const { buildAndCacheKit } = await import("./services/kitCache.js");
    const { parseFocus } = await import("./services/pitchConcept.js");
    // The angles and campaigns she kept in the pitch flow (?focus=<JSON array of strings>, capped) — they reach the concept.
    const angles = parseFocus(req.query.focus);
    const sse = openSSEStream(res, req);
    try {
      sse.status("Gathering your profile");
      await buildAndCacheKit(req.params.id, {
        brandId,
        angles,
        onStep: (label) => sse.status(label),
      });
      sse.done({ ok: true, brandId });
    } catch (err: any) {
      sse.error("build failed");
    } finally {
      sse.close();
    }
  },
);

// ── The editor (docs/media-kit-specs.md Spec 8) — compose the deck + pick the copy/photo ──
const CARD_TITLES: Record<string, string> = {
  cover: "Cover",
  index: "Marketability",
  mix: "Sub-scores",
  audience: "Audience",
  content: "Top content",
  video: "In motion",
  rates: "Rate card",
  payments: "Book her",
  whyFits: "Why she fits",
  story: "The story",
  values: "Values",
  achievements: "The record",
  fit: "Brand fit",
  campaignConcept: "The concept",
  activationPlan: "All year",
  signatureIdea: "The idea",
};

// GET /api/v1/athletes/:id/card-editor?brandId=0 — the raw (un-edited) base kit shaped for the editor:
// each card with its editable copy slots (value + Narrator alternates), a signed photo, the current
// deck + library split, saved overrides, and the signed image-swap pool.
app.get("/api/v1/athletes/:id/card-editor", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const brandId = Number(req.query.brandId) || 0;
  try {
    const { getOrBuildKit, signKit } = await import("./services/kitCache.js");
    const { getOverrides, editableFields } = await import(
      "./services/cardOverrides.js"
    );
    const { signedUrl } = await import("./lib/mediaStore.js");
    const base = await getOrBuildKit(req.params.id, { brandId, raw: true });
    const signed = await signKit(base);
    const baseById = new Map((base.cards as any[]).map((c) => [c.id, c])); // unsigned → carries gcs paths
    const cards = signed.cards.map((c: any) => {
      const b: any = baseById.get(c.id) ?? {};
      return {
        id: c.id,
        type: c.type,
        title: CARD_TITLES[c.type] ?? c.type,
        editable: editableFields(c.type).map(({ field, slot }) => ({
          field,
          value: c[field] ?? "",
          alternates: base.copyAlternates?.[c.id]?.[slot] ?? [],
        })),
        image: "image" in c ? (c.image ?? null) : null,
        mediaGcsPath: b.image ?? b.bg ?? b.videoUrl ?? null, // durable path of the card's current media → picker "On card"
      };
    });
    const deck = base.deck?.length ? base.deck : cards.map((c) => c.id);
    const library = cards
      .filter((c) => !deck.includes(c.id))
      .map((c) => ({ id: c.id, type: c.type, title: c.title }));
    const imagePool = await Promise.all(
      (base.imagePool ?? []).map(async (p) => ({
        gcsPath: p.gcsPath,
        shotType: p.shotType,
        hero: p.hero,
        url: await signedUrl(p.gcsPath),
      })),
    );
    res.json({
      deck,
      library,
      cards,
      overrides: (await getOverrides(req.params.id, brandId)) ?? {},
      imagePool,
    });
  } catch (err: any) {
    logger.error(
      { athleteId: req.params.id, brandId, error: err?.message },
      "card-editor failed",
    );
    res.status(404).json({ error: "not found" });
  }
});

// PUT /api/v1/athletes/:id/card-overrides?brandId=0 — save the athlete's edits (applied at serve).
app.put(
  "/api/v1/athletes/:id/card-overrides",
  requireAuth,
  async (req, res) => {
    if (req.athleteId !== req.params.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const brandId = Number(req.query.brandId) || 0;
    const b = req.body ?? {};
    const { getOverrides, saveOverrides } = await import(
      "./services/cardOverrides.js"
    );
    const existing = await getOverrides(req.params.id, brandId); // preserve fields the editor doesn't send (theme)
    const ov = {
      order: Array.isArray(b.order) ? b.order.map(String) : undefined,
      removed: Array.isArray(b.removed) ? b.removed.map(String) : undefined,
      added: Array.isArray(b.added) ? b.added.map(String) : undefined,
      copy: b.copy && typeof b.copy === "object" ? b.copy : undefined,
      images: b.images && typeof b.images === "object" ? b.images : undefined,
      theme: existing?.theme,
    };
    await saveOverrides(req.params.id, brandId, ov);
    res.json({ ok: true });
  },
);

// PUT /api/v1/athletes/:id/card-theme[?brandId=N] — persist the athlete's chosen look. Without brandId it is her
// card's look (the generic, brandId 0 overrides). With brandId it is the look of her pitch to THAT brand, stored on
// that brand's overrides; until she picks one, a pitch wears the look recommended from the brand's category
// (kitCache.brandLookAdvice). Either way the look flows to the app and every share. Body: { theme }.
app.put("/api/v1/athletes/:id/card-theme", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const theme = String((req.body ?? {}).theme ?? "");
  // A missing brandId is her card (0); a present but malformed one is a 400, never a silent write to her card's look.
  const brandId = req.query.brandId === undefined ? 0 : Number(req.query.brandId);
  const { listPickableThemes } = await import("./services/kitRenderer.js");
  if (!listPickableThemes().includes(theme) || !Number.isInteger(brandId) || brandId < 0) {
    res.status(400).json({ error: "unknown theme" });
    return;
  }
  const { getOverrides, saveOverrides } = await import(
    "./services/cardOverrides.js"
  );
  const existing = (await getOverrides(req.params.id, brandId)) ?? {};
  await saveOverrides(req.params.id, brandId, { ...existing, theme });
  res.json({ ok: true, theme, brandId });
});

// POST /api/internal/kit-refresh — re-assemble + cache a Nomi Card (call on data-change / athlete
// edit). Body: { athleteId }. Fire-and-forget: the expensive DAG runs in the background.
app.post("/api/internal/kit-refresh", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { athleteId } = req.body ?? {};
  if (!athleteId) {
    res.status(400).json({ error: "athleteId required" });
    return;
  }
  res.json({
    ok: true,
    message: "Kit refresh started — check server logs for progress",
  });
  import("./services/kitCache.js").then(({ buildAndCacheKit }) =>
    buildAndCacheKit(athleteId).catch((err: any) =>
      logger.error({ athleteId, error: err.message }, "kit-refresh threw"),
    ),
  );
});

// ── Nomi Card SHARE layer + analytics (docs/media-kit-specs.md Spec 6) ──
// GET /c/:shareId (the shared card itself) lives in server/routes/card.ts.

// GET /c/:shareId/cover — the first inline image out of a hand-built deck's stored HTML, so a
// pitch tile can show the deck's OWN cover card instead of a placeholder gradient. A shared deck's
// html is immutable, so the decoded bytes are cached in-process.
const deckCoverCache = new Map<string, { ct: string; buf: Buffer } | null>();
app.get("/c/:shareId/cover", async (req, res) => {
  const id = req.params.shareId;
  try {
    let hit = deckCoverCache.get(id);
    if (hit === undefined) {
      const [row] = await db
        .select({ html: cardShares.custom_html, revoked: cardShares.revoked })
        .from(cardShares)
        .where(eq(cardShares.id, id))
        .limit(1);
      // The FIRST data-uri in the document is usually a preload/og image, not card 1 — anchor on the
      // first card's background so this is genuinely "the cover card".
      let m: RegExpExecArray | null = null;
      if (row?.html && !row.revoked) {
        const anchor = row.html.indexOf('class="card__bg');
        const from = anchor >= 0 ? anchor : 0;
        m = /data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)/.exec(row.html.slice(from));
      }
      hit = m
        ? { ct: `image/${m[1] === "jpg" ? "jpeg" : m[1]}`, buf: Buffer.from(m[2], "base64") }
        : null;
      deckCoverCache.set(id, hit);
    }
    if (!hit) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "public, max-age=86400");
    // Helmet's global CORP is same-origin, which makes the browser DROP this image whenever the app
    // is served from a different origin than the API (always true in dev: :8083 page vs :8080 api).
    // It's a public share's cover, so cross-origin is correct here.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.type(hit.ct).send(hit.buf);
  } catch {
    res.status(500).end();
  }
});

// POST /c/:shareId/beat — dwell beacon (fetch keepalive from the card). Public, best-effort.
app.post("/c/:shareId/beat", async (req, res) => {
  try {
    const { updateDwell } = await import("./services/kitShare.js");
    const { viewId, dwellMs } = req.body ?? {};
    if (viewId && typeof dwellMs === "number")
      await updateDwell(String(viewId), dwellMs);
  } catch {
    /* best-effort */
  }
  res.status(204).end();
});

// POST /api/v1/athletes/:id/shares — create a share (athlete-authed). Body = CreateShareOpts.
// GET /api/v1/athletes/:id/brands — the athlete's pipeline brands (already researched) for the picker.
app.get("/api/v1/athletes/:id/brands", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const rows = await db
      .selectDistinct({
        brandId: inboxBrands.id,
        name: inboxBrands.name,
        category: inboxBrands.category,
        tier: inboxBrands.brand_tier,
        logoUrl: inboxBrands.logo_url,
        domain: inboxBrands.domain,
        description: inboxBrands.description,
        enriched: inboxBrands.enriched_at,
      })
      .from(inboxBrands)
      .innerJoin(inboxThreads, eq(inboxThreads.brand_id, inboxBrands.id))
      .where(
        and(
          eq(inboxThreads.athlete_id, req.params.id),
          ne(inboxBrands.is_agency, true),
        ),
      );
    const tailored = await db
      .select({ brand_id: mediaKits.brand_id })
      .from(mediaKits)
      .where(eq(mediaKits.athlete_id, req.params.id));
    const haveCard = new Set(tailored.map((t) => t.brand_id));

    // Deal-warmth ranking: which brands is she most likely to pitch next? Rank by the best deal
    // status (negotiating hottest) + recency. deals link to brands by name (no FK), so match normalized.
    const dealRows = await db
      .select({
        brand: deals.brand_name,
        status: deals.status,
        at: deals.detected_at,
        created: deals.created_at,
      })
      .from(deals)
      .where(eq(deals.athlete_id, req.params.id));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const WARMTH: Record<string, number> = {
      negotiating: 100,
      pending: 80,
      detected: 60,
      accepted: 40,
      completed: 20,
      rejected: 0,
    };
    const dealByBrand = new Map<string, { warmth: number; activity: number }>();
    for (const d of dealRows) {
      const k = norm(d.brand ?? "");
      if (!k) continue;
      const w = WARMTH[d.status ?? "detected"] ?? 10;
      const a = Math.max(
        new Date(d.at ?? 0).getTime() || 0,
        new Date(d.created ?? 0).getTime() || 0,
      );
      const prev = dealByBrand.get(k);
      if (!prev || w > prev.warmth || (w === prev.warmth && a > prev.activity))
        dealByBrand.set(k, { warmth: w, activity: a });
    }
    const scored = rows.map((r) => {
      const d = dealByBrand.get(norm(r.name)) ?? { warmth: 10, activity: 0 }; // in inbox, no deal → baseline lead
      return { r, ...d };
    });
    scored.sort(
      (x, y) =>
        y.warmth - x.warmth ||
        y.activity - x.activity ||
        x.r.name.localeCompare(y.r.name),
    );
    res.json({
      brands: scored.map(({ r }) => ({
        brandId: r.brandId,
        name: r.name,
        category: r.category,
        tier: r.tier,
        logoUrl: r.logoUrl,
        domain: r.domain,
        description: r.description,
        enriched: !!r.enriched,
        hasTailoredCard: haveCard.has(r.brandId),
      })),
    });
  } catch (err: any) {
    logger.error(
      { athleteId: req.params.id, error: err.message },
      "brands list failed",
    );
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/v1/brands/search?q= — global brand suggestions from the shared brand-intelligence store
// (already-researched brands, any athlete). Powers the "Other brands we know" section of the create
// picker so a known brand is one tap (no re-research). Excludes agencies + un-researched stubs.
app.get("/api/v1/brands/search", requireAuth, async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json({ brands: [] });
    return;
  }
  try {
    const rows = await db
      .select({
        brandId: inboxBrands.id,
        name: inboxBrands.name,
        category: inboxBrands.category,
        tier: inboxBrands.brand_tier,
        logoUrl: inboxBrands.logo_url,
        domain: inboxBrands.domain,
        description: inboxBrands.description,
      })
      .from(inboxBrands)
      .where(
        and(
          ilike(inboxBrands.name, containsPattern(q)),
          ne(inboxBrands.is_agency, true),
          isNotNull(inboxBrands.enriched_at),
        ),
      )
      .limit(8);
    res.json({ brands: rows });
  } catch (err: any) {
    res.status(500).json({ error: "search failed" });
  }
});

// POST /api/v1/brands/resolve — dedup/add a brand the athlete picks → the shared getOrResearchBrand.
app.post("/api/v1/brands/resolve", requireAuth, async (req, res) => {
  const { name, domain } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    const { getOrResearchBrand } = await import("./services/brandIntel.js");
    const r = await getOrResearchBrand(
      String(name),
      domain ? String(domain) : null,
      { athletePicked: true },
    );
    if (!r) {
      res.status(404).json({ error: "could not resolve" });
      return;
    }
    const p: any = r.profile;
    // Rich identity for the "Is this the brand?" confirm card (Studio create Gate 1).
    res.json({
      brandId: r.brandId,
      name: p.name,
      logo: p.logo_url ?? null,
      category: p.category ?? null,
      tier: p.brand_tier ?? null,
      audience: p.audience_summary ?? null,
      description: p.description ?? null,
      domain: p.domain ?? null,
      researching: !p.enriched_at,
    });
  } catch (err: any) {
    logger.error({ error: err.message }, "brand resolve failed");
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/v1/athletes/:id/shares", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const { createShare } = await import("./services/kitShare.js");
    res.json(await createShare(req.params.id, req.body ?? {}));
  } catch (err: any) {
    logger.error(
      { athleteId: req.params.id, error: err.message },
      "share create failed",
    );
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/v1/athletes/:id/shares — the athlete's shares + open counts (the "Track opens" list).
app.get("/api/v1/athletes/:id/shares", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const { listAthleteShares } = await import("./services/kitShare.js");
  res.json(await listAthleteShares(req.params.id));
});

// GET /api/v1/athletes/:id/card-opens?days=14 — exact per-day open counts across all the
// athlete's shares (the precise 14-day overview strip; no last-open-day approximation).
app.get("/api/v1/athletes/:id/card-opens", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const { athleteOpensByDay } = await import("./services/kitShare.js");
  res.json({ days, byDay: await athleteOpensByDay(req.params.id, days) });
});

// Editorial "reading you closely" headline from an open count — reuses ordinal words
// ("came back for thirds"), mirroring the Fable CardSignalCard copy.
const SIGNAL_ORDINALS = [
  "",
  "firsts",
  "seconds",
  "thirds",
  "fourths",
  "fifths",
  "sixths",
  "sevenths",
  "eighths",
  "ninths",
];
function cardSignalHeadline(brand: string, opens: number): string {
  if (opens <= 1) return `${brand} just opened your card.`;
  if (opens < SIGNAL_ORDINALS.length)
    return `${brand} came back for ${SIGNAL_ORDINALS[opens]}.`;
  return `${brand} keeps coming back — ${opens} opens.`;
}

// GET /api/v1/athletes/:id/card-signals — the "Opportunities bridge" (Spec 9).
// Aggregates the athlete's BRAND-TAILORED card shares (card_shares.brand_id set) with
// their opens (card_share_views), surfaces only "hot" brands (≥2 opens OR a recent
// re-open), joins inbox_brands for name/logo, and best-effort matches a deal by brand
// name so the feed card can jump straight to it.
app.get("/api/v1/athletes/:id/card-signals", requireAuth, async (req, res) => {
  if (req.athleteId !== req.params.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    // One row per tailored brand: total opens, last open, forwards — across every share
    // the athlete sent that brand (they may have sent several links to the same brand).
    const agg = await db
      .select({
        brandId: cardShares.brand_id,
        opens: count(cardShareViews.id),
        lastOpened: max(cardShareViews.opened_at),
        forwards: sql<number>`count(*) filter (where ${cardShareViews.is_forward})`,
      })
      .from(cardShares)
      .leftJoin(cardShareViews, eq(cardShareViews.share_id, cardShares.id))
      .where(
        and(
          eq(cardShares.athlete_id, req.params.id),
          isNotNull(cardShares.brand_id),
          eq(cardShares.revoked, false),
        ),
      )
      .groupBy(cardShares.brand_id);

    const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // "Hot": opened at least twice, or opened at all within the last 3 days.
    const hot = agg.filter((r) => {
      const opens = Number(r.opens);
      const last = r.lastOpened ? new Date(r.lastOpened).getTime() : 0;
      return opens >= 2 || (opens >= 1 && now - last <= RECENT_MS);
    });
    if (hot.length === 0) {
      res.json({ signals: [] });
      return;
    }

    // brand_id is the numeric inbox_brands.id stored as text — resolve names/logos.
    const brandIds = hot
      .map((r) => Number(r.brandId))
      .filter((n) => Number.isFinite(n));
    const brands = brandIds.length
      ? await db
          .select({
            id: inboxBrands.id,
            name: inboxBrands.name,
            logoUrl: inboxBrands.logo_url,
          })
          .from(inboxBrands)
          .where(inArray(inboxBrands.id, brandIds))
      : [];
    const brandById = new Map(brands.map((b) => [b.id, b]));

    // Best-effort deal match by brand name (case-insensitive) among this athlete's deals.
    const athleteDeals = await db
      .select({ id: deals.id, brandName: deals.brand_name })
      .from(deals)
      .where(eq(deals.athlete_id, req.params.id));
    const dealByBrand = new Map<string, string>();
    for (const d of athleteDeals) {
      const key = d.brandName?.trim().toLowerCase();
      if (key && !dealByBrand.has(key)) dealByBrand.set(key, d.id);
    }

    const signals = hot
      .map((r) => {
        const brand = brandById.get(Number(r.brandId));
        if (!brand) return null;
        const opens = Number(r.opens);
        return {
          brandId: brand.id,
          brandName: brand.name,
          logoUrl: brand.logoUrl ?? null,
          dealId: dealByBrand.get(brand.name.trim().toLowerCase()) ?? null,
          opens,
          lastOpened: r.lastOpened
            ? new Date(r.lastOpened).toISOString()
            : new Date().toISOString(),
          forwards: Number(r.forwards) || 0,
          headline: cardSignalHeadline(brand.name, opens),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort(
        (a, b) =>
          b.opens - a.opens ||
          new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime(),
      );

    res.json({ signals });
  } catch (err: any) {
    logger.error(
      { athleteId: req.params.id, error: err.message },
      "card-signals failed",
    );
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/v1/shares/:shareId/analytics — per-share analytics (owner only).
app.get("/api/v1/shares/:shareId/analytics", requireAuth, async (req, res) => {
  const { shareAnalytics, shareOwner } = await import("./services/kitShare.js");
  if ((await shareOwner(req.params.shareId)) !== req.athleteId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(await shareAnalytics(req.params.shareId));
});

// POST /api/v1/shares/:shareId/revoke — turn a share off (owner only).
app.post("/api/v1/shares/:shareId/revoke", requireAuth, async (req, res) => {
  const { revokeShare, shareOwner } = await import("./services/kitShare.js");
  if ((await shareOwner(req.params.shareId)) !== req.athleteId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await revokeShare(req.params.shareId, req.athleteId!);
  res.json({ ok: true });
});

// POST /api/internal/score-refresh-cron — DELETED (legacy retirement P2-4, 8 Oct 2026): it re-ran the legacy /850 score
// and the v3 rate card. Neither is computed any more; the athlete's score is M.I.A.

// POST /api/internal/discovery-collect-cron[?dryRun=true]
// Fetch public social data (IG Business Discovery + YouTube API) for athletes with
// a handle but no active connection on that platform → source='discovery' rows.
// dryRun returns the per-athlete/platform plan synchronously (no fetch, no write);
// a real run is fire-and-forget. NOT yet on a cron — scoring won't prefer/label
// discovery rows until the precedence resolver lands (next milestone).
app.post("/api/internal/discovery-collect-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
  const { collectAllDiscoveryAnalytics } = await import(
    "./skills/collectDiscoveryAnalytics.js"
  );
  if (dryRun) {
    const r = await collectAllDiscoveryAnalytics({ dryRun: true });
    res.json({
      ok: true,
      dryRun: true,
      summary: { athletes: r.athletes, planned: r.results.length },
      results: r.results,
    });
    return;
  }
  res.json({
    ok: true,
    message: "Discovery collection started — check server logs for progress",
  });
  collectAllDiscoveryAnalytics().catch((err: any) =>
    logger.error({ error: err.message }, "Manual discovery-collect-cron threw"),
  );
});

// POST /api/internal/summarize-threads
// Backfill conversation_state for all threads of an athlete that don't have it yet.
// Body: { athleteId: string }
app.post("/api/internal/summarize-threads", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { athleteId } = req.body ?? {};
  if (!athleteId) {
    res.status(400).json({ error: "athleteId required" });
    return;
  }

  res.json({
    ok: true,
    message: "Summarization started — check logs for progress",
  });

  const { db: database } = await import("./db.js");
  const { inboxThreads } = await import("../shared/schema.js");
  const { summarizeThread } = await import("./skills/threadSummarizer.js");
  const { isNull, eq, and } = await import("drizzle-orm");

  const threads = await database
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.athlete_id, athleteId),
        isNull(inboxThreads.conversation_state),
      ),
    );

  logger.info(
    { athleteId, count: threads.length },
    "Thread summarization backfill starting",
  );

  for (const t of threads) {
    await summarizeThread(t.id).catch((err: any) =>
      logger.warn(
        { threadId: t.id, err: err.message },
        "summarizeThread threw in backfill",
      ),
    );
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info(
    { athleteId, count: threads.length },
    "Thread summarization backfill complete",
  );
});

// POST /api/internal/gmail-watch-renew
// Called by Cloud Scheduler every 6 days (Gmail watches expire after 7 days).
app.post("/api/internal/gmail-watch-renew", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await renewGmailWatches();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ error: err.message }, "Gmail watch renewal failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/outlook-subscriptions-cron
// Cloud Scheduler every 12 h (OUTLOOK_PUSH): renews Graph subscriptions expiring within 48 h,
// finishes lifecycle work a dead instance left behind (reauthorize / recreate), and drains
// "sync now" signals whose in-process timer was lost. A no-op ({ enabled: false }) with the flag off.
// Advisory-locked so a Scheduler retry overlapping a slow run never recreates a subscription twice.
app.post("/api/internal/outlook-subscriptions-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { withAdvisoryLock, LOCK_OUTLOOK_SUBSCRIPTIONS } = await import("./lib/pgAdvisoryLock.js");
    const { runOutlookSubscriptionCron } = await import("./lib/integrations/outlookPush.js");
    const outcome = await withAdvisoryLock(LOCK_OUTLOOK_SUBSCRIPTIONS, () => runOutlookSubscriptionCron());
    if (!outcome.ran) {
      res.json({ ok: true, ran: false, reason: "another instance holds the outlook subscription lock" });
      return;
    }
    res.json({ ok: true, ran: true, ...outcome.result });
  } catch (err: any) {
    logger.error({ error: err.message }, "outlook-subscriptions-cron threw");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/booking-session-cron — every 5 minutes (Cloud Scheduler): join notices, the no-show grace check
// (records + notifies only), after-session review + "How did it go?", the check-in nudge, and release (buyer said it
// happened, or end + 48h with nothing open). Answers {skipped:true} while BOOKINGS_ENABLED is off.
app.use(bookingSessionCronRouter(cronSecretValid, async (fn) => {
  const { withAdvisoryLock, LOCK_BOOKING_SESSION } = await import("./lib/pgAdvisoryLock.js");
  return withAdvisoryLock(LOCK_BOOKING_SESSION, fn);
}));

// POST /api/internal/partner-intake-cron — hourly Partner-door housekeeping: expire unconfirmed requests (72h), redact
// brand contact details past their retention, prune rate counters and email codes. { skipped: true } while the flags are off.
app.post("/api/internal/partner-intake-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { runPartnerSweep } = await import("./services/partner/sweep.js");
    res.json({ ok: true, ...(await runPartnerSweep()) });
  } catch (err: any) {
    logger.error({ error: err.message }, "partner-intake-cron failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/email-code-purge-cron — hourly: delete sign-in codes past their keep window (email_signin_codes,
// server/routes/authEmailCode.ts; /start also purges after each send). Runs whatever EMAIL_CODE_SIGNIN says: old rows go.
app.post("/api/internal/email-code-purge-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { purgeEmailSigninCodes } = await import("./routes/authEmailCode.js");
    res.json({ ok: true, purged: await purgeEmailSigninCodes() });
  } catch (err: any) {
    logger.error({ error: err.message }, "email-code-purge-cron failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/payments-cron — hourly payments sweep: auto-release funded deals
// whose confirmation window elapsed (Phase 4) + deposit re-auth/expiry (Phase 5).
app.post("/api/internal/payments-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { runPaymentsCron } = await import(
      "./services/payments/paymentsCron.js"
    );
    const r = await runPaymentsCron();
    res.json({ ok: true, ...r });
  } catch (err: any) {
    logger.error({ error: err.message }, "payments-cron failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/bookings-cron — the bookings clock, every 5 minutes (Cloud Scheduler `bookings-cron`): lapsed
// unverified holds, the 72h respond_by (releases the card hold), the session end → review, and the 48h release with
// nothing open. Answers { skipped: true } while BOOKINGS_ENABLED is off. See server/services/bookings/sweeper.ts.
app.post("/api/internal/bookings-cron", async (req, res) => {
  if (!cronSecretValid(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { runBookingsCron } = await import("./services/bookings/sweeper.js");
    res.json({ ok: true, ...(await runBookingsCron()) });
  } catch (err: any) {
    logger.error({ error: err.message }, "bookings-cron failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// The short link {host}/{handle} → /p/{handle}, only on SHORT_LINK_HOSTS (dev: api-dev.nomila.co) and only for a
// published handle; everything else passes through to the 404 below. Mounted last so it can never shadow a route.
app.use(createShortLinkRouter());

// 404 for anything unmatched (kept off the default HTML "Cannot GET" page).
app.use(notFoundHandler);

// Central error handler — LAST. Returns a generic message + request id to the
// client and logs the real error server-side, so stack traces / internal paths /
// framework versions never leak to a caller or a DAST scan.
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const reqId =
      (req.headers["x-request-id"] as string | undefined) ?? undefined;
    logger.error(
      {
        err: err?.message,
        stack: err?.stack,
        method: req.method,
        path: req.path,
        reqId,
      },
      "Unhandled error",
    );
    if (res.headersSent) {
      next(err);
      return;
    }
    res
      .status(500)
      .json({ error: "Internal server error", ...(reqId ? { reqId } : {}) });
  },
);

async function start() {
  // Fail-fast on unsafe production config (open admin, missing app URL); warn on
  // degraded config. Throwing here is caught by start().catch → process.exit(1).
  envHealth = checkEnv();
  // (The legacy scoring weights load that ran here went with the v7.2 engine — legacy retirement P2-5.)

  // Belt-and-suspenders in-process cron: also fires every 50 days from server start.
  // Cloud Scheduler is the primary trigger; this catches cases where Scheduler is misconfigured.
  // 0 3 */50 * * = 03:00 UTC every 50 days (approximate — cron can't express exact day intervals)
  if (process.env.NODE_ENV === "production") {
    // Payments sweep — hourly at :15. Auto-releases funded deals past the confirmation
    // window (Cloud Scheduler → /api/internal/payments-cron is the primary trigger).
    cron.schedule("15 * * * *", async () => {
      logger.info("In-process cron: payments sweep");
      import("./services/payments/paymentsCron.js").then(
        ({ runPaymentsCron }) =>
          runPaymentsCron().catch((err: any) =>
            logger.error(
              { error: err.message },
              "In-process payments sweep failed",
            ),
          ),
      );
    });

    // Bookings v2 session sweep — every 5 minutes, only with bookings on (Cloud Scheduler's booking-session-cron is
    // the primary trigger). The same advisory lock as the endpoint, so instances never run it twice at once.
    // Partner email replies (PARTNER_INBOUND_MAIL): poll the partner Workspace mailbox every 2 minutes
    // (services/partner/inboundMail.ts). Advisory-locked so the instances never read the same message at once; the relay
    // is idempotent on the Gmail message id anyway.
    if (partnerInboundMailEnabled()) {
      cron.schedule("*/2 * * * *", async () => {
        try {
          const { withAdvisoryLock, LOCK_PARTNER_INBOX } = await import("./lib/pgAdvisoryLock.js");
          const { pollPartnerInbox } = await import("./services/partner/inboundMail.js");
          await withAdvisoryLock(LOCK_PARTNER_INBOX, () => pollPartnerInbox());
        } catch (err: any) {
          logger.error({ error: err.message }, "In-process partner inbox poll failed");
        }
      });
    }

    if (BOOKINGS.enabled) {
      cron.schedule("*/5 * * * *", async () => {
        try {
          const { withAdvisoryLock, LOCK_BOOKING_SESSION } = await import("./lib/pgAdvisoryLock.js");
          const { runBookingSessionSweep } = await import("./services/bookings/session/sessionSweep.js");
          await withAdvisoryLock(LOCK_BOOKING_SESSION, () => runBookingSessionSweep());
        } catch (err: any) {
          logger.error({ error: err.message }, "In-process booking session sweep failed");
        }
      });
    }

    cron.schedule("0 3 1 */2 *", async () => {
      logger.info("In-process cron: starting IG token refresh");
      refreshInstagramToken().catch((err: any) =>
        logger.error(
          {
            kind: err instanceof IgTokenRefreshError ? err.kind : "unknown",
            ...(err instanceof IgTokenRefreshError ? err.detail : {}),
            error: err.message,
          },
          "In-process IG token refresh failed",
        ),
      );
    });

    // Renew Gmail watches every 6 days (watches expire after 7 days)
    cron.schedule("0 2 */6 * *", async () => {
      logger.info("In-process cron: renewing Gmail watches");
      renewGmailWatches().catch((err: any) =>
        logger.error(
          { error: err.message },
          "In-process Gmail watch renewal failed",
        ),
      );
    });

    // Outlook push (OUTLOOK_PUSH): the minute sweep for "sync now" signals whose debounce timer died
    // with its instance. Registered only with the flag on; the claim is atomic, so all instances may run it.
    if (process.env.OUTLOOK_PUSH?.trim().toLowerCase() === "true") {
      cron.schedule("* * * * *", async () => {
        try {
          const { drainPendingSyncs } = await import("./lib/integrations/outlookPush.js");
          await drainPendingSyncs();
        } catch (err: any) {
          logger.error({ error: err.message }, "In-process Outlook push sweep failed");
        }
      });
    }

    // Inbox polling fallback — catches any push/webhook gaps, runs every 6 hours.
    // Cloud Scheduler (`inbox-cron-sync` → /api/internal/gmail-cron-sync) is the primary
    // trigger; this is the belt-and-suspenders copy for a misconfigured Scheduler.
    //
    // Advisory-locked on the SAME key as the endpoint: this callback fires on all three
    // Cloud Run instances, so without the lock a single 06:00 tick meant three concurrent
    // full inbox syncs racing each other's writes.
    cron.schedule("0 */6 * * *", async () => {
      logger.info("In-process cron: starting inbox cron sync");
      try {
        const { withAdvisoryLock, LOCK_INBOX_SYNC } = await import(
          "./lib/pgAdvisoryLock.js"
        );
        const { runInboxCronSync } = await import("./skills/inboxCronSync.js");
        const outcome = await withAdvisoryLock(LOCK_INBOX_SYNC, () =>
          runInboxCronSync({ budgetMs: 1_500_000 }),
        );
        if (!outcome.ran) {
          logger.info(
            "In-process inbox cron sync: lock held elsewhere — skipped",
          );
        } else {
          logger.info(
            { ...outcome.result },
            "In-process inbox cron sync complete",
          );
        }
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process inbox cron sync failed",
        );
      }
    });

    // Social analytics snapshots — daily at 04:30 UTC, staggered off the inbox sync
    // (0,6,12,18:00) and the 02:00/03:00 jobs so they don't burst the shared API quota.
    // (The legacy re-score that followed collection was retired in the legacy retirement, P2-4.)
    cron.schedule("30 4 * * *", async () => {
      logger.info("In-process cron: starting social analytics collection");
      try {
        const { collectAllAnalyticsSnapshots } = await import(
          "./skills/collectSocialAnalytics.js"
        );
        await collectAllAnalyticsSnapshots();
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process social analytics collection failed",
        );
      }
      // Discovery for athletes with a handle but no connection on a platform.
      try {
        const { collectAllDiscoveryAnalytics } = await import(
          "./skills/collectDiscoveryAnalytics.js"
        );
        const d = await collectAllDiscoveryAnalytics();
        logger.info(
          {
            written: d.written,
            notFound: d.notFound,
            skipped: d.skipped,
            failed: d.failed,
          },
          "In-process discovery collection complete",
        );
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process discovery collection failed",
        );
      }
      // (The legacy re-score that ran here — refreshAllScores — was retired in the legacy retirement, P2-4.)
      // Re-host recent post media → GCS while the just-written snapshot URLs are freshest.
      try {
        const { rehostAllAthletesMedia } = await import(
          "./skills/rehostAthleteMedia.js"
        );
        const m = await rehostAllAthletesMedia();
        logger.info(
          { athletes: m.athletes },
          "In-process media re-host complete",
        );
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process media re-host failed");
      }
      // Full-history media backfill — one throttled, resumable tick per athlete/platform.
      try {
        const { backfillAllAthletes } = await import(
          "./skills/mediaBackfill.js"
        );
        const b = await backfillAllAthletes();
        logger.info(
          { athletes: b.athletes },
          "In-process media backfill tick complete",
        );
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process media backfill failed",
        );
      }
      // Enrich top posts with richer per-post insights (reach/saves/shares/views) for media kit + analysis.
      try {
        const { enrichAllAthletesTopPosts } = await import(
          "./skills/enrichTopPostInsights.js"
        );
        const e = await enrichAllAthletesTopPosts();
        logger.info(
          { athletes: e.athletes },
          "In-process top-post insights enrichment complete",
        );
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process top-post insights enrichment failed",
        );
      }
      // Fetch the actual mp4 for top IG videos (playable reels for the media kit) — after enrichment,
      // which populates the views this ranks on.
      try {
        const { fetchAllTopVideoFiles } = await import(
          "./skills/fetchTopVideoFiles.js"
        );
        const v = await fetchAllTopVideoFiles();
        logger.info(
          { athletes: v.athletes },
          "In-process top video file fetch complete",
        );
      } catch (err: any) {
        logger.error(
          { error: err.message },
          "In-process top video file fetch failed",
        );
      }
      // Social substrate (Phase A Step 1a, flag-gated): feature vectors for every athlete with an
      // identity, then raw-payload retention. Runs after every writer above has finished.
      try {
        const { runSubstrateNightlyPass } = await import(
          "./skills/collectSocialAnalytics.js"
        );
        await runSubstrateNightlyPass();
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process substrate nightly pass failed");
      }
      // First Look refresh from the posts the steps above just stored (no new fetching): per
      // athlete × connected platform, recompute when the latest look is older than
      // FIRST_LOOK_REFRESH_DAYS (30) or FIRST_LOOK_REFRESH_MIN_NEW_POSTS (10) newer posts exist.
      // Capped at FIRST_LOOK_REFRESH_MAX_PER_NIGHT (50) athletes; one model call per platform.
      try {
        const { refreshDueFirstLooks } = await import("./skills/firstLook.js");
        const f = await refreshDueFirstLooks();
        logger.info(f, "In-process first look refresh complete");
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process first look refresh failed");
      }
      // Strip secret-like strings and signed CDN query strings from stored raw_metrics rows
      // (Phase A decision D7). Runs LAST and keeps each platform's newest row: the Growth tab
      // and the re-host above read that row's URLs inside the CDN expiry window.
      try {
        const { scrubStoredRawMetrics } = await import(
          "./services/rawMetricsSanitizer.js"
        );
        const s = await scrubStoredRawMetrics({ apply: true, keepLatest: true });
        logger.info(s, "In-process raw_metrics scrub complete");
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process raw_metrics scrub failed");
      }
    });

    // ── Phase A Step 1b: Instagram Stories (no-ops unless SOCIAL_STORIES_WRITE=true) ──
    // Sweep every 8 h at :20 (00:20, 08:20, 16:20 UTC — clear of the 04:30 nightly), and an hourly
    // last-look tick at :40 for Stories aged ≥ 22 h without a successful insight reading.
    cron.schedule("20 */8 * * *", async () => {
      try {
        const { runStorySweep } = await import("./skills/collectInstagramStories.js");
        await runStorySweep();
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process story sweep failed");
      }
    });
    cron.schedule("40 * * * *", async () => {
      try {
        const { runStoryLastLookTick } = await import("./skills/collectInstagramStories.js");
        await runStoryLastLookTick();
      } catch (err: any) {
        logger.error({ error: err.message }, "In-process story last-look tick failed");
      }
    });
  }

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "nomila-v2 server started");
  });

  // SIGTERM (Cloud Run replacing this instance): the workflow runner stops claiming, lets in-flight steps finish for a
  // few seconds and hands the rest back as ready (server/workflow/runner.ts drainRunner); in parallel the HTTP server
  // stops accepting connections and lets open requests finish. The process exits when both are done, or at the hard
  // limit inside Cloud Run's 10 s.
  installRunnerShutdown({
    closeHttp: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();   // idle keep-alive sockets would otherwise hold close() open
    }),
  });
}

start().catch((err) => {
  logger.error(err, "Server failed to start");
  process.exit(1);
});

export default app;
