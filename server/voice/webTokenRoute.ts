/**
 * webTokenRoute.ts — the join token for the Track B web pipe.
 *
 * POST /voice/token  → { wsUrl, room, identity, token }
 *
 * ── THE SECURITY INVARIANT: identity comes from the session, never the request ─
 * `requireAuth` (server/lib/auth.ts) verifies the caller's Firebase ID token and
 * resolves the athlete row behind it — the same guard the text chat and every
 * /api/v1/me route use. The athlete id minted into this token is `req.athleteId`
 * and nothing else. It is NEVER read from the body, the query string or the path,
 * because whatever this endpoint stamps into the dispatch metadata is what the
 * worker will read every athlete-scoped tool against. A body-supplied id would be
 * a request to be somebody else.
 *
 * That is the whole boundary, and it holds because of where the value ends up:
 * the metadata rides INSIDE the LiveKit access token, which is signed with
 * LIVEKIT_API_SECRET. A browser can neither forge one nor edit the one it is
 * handed — LiveKit validates the signature before it will create the room or
 * dispatch the job. So the chain is: Firebase verifies the human → we decide the
 * athlete → we sign it → LiveKit enforces the signature → the worker reads a
 * value no client could have chosen.
 *
 * The CONVERSATION id is the one thing a client may ask for, and it is not taken
 * on trust either: `resolveVoiceConversation` (server/mila/conversations.ts)
 * returns an id this athlete demonstrably owns — claiming an unclaimed one,
 * and quietly substituting a fresh one for an id that belongs to somebody else.
 *
 * ── The gate ─────────────────────────────────────────────────────────────────
 * `tokenRouter` (POST /voice/token) authenticates, scopes per athlete, and ships
 * to production behind `MILA.VOICE_WEB`, a flag (default off), so voice can be
 * switched on or killed by config rather than by deploy. (The August dev demo
 * page, GET /voice behind ENABLE_VOICE_WEB_DEMO, was deleted 2 Nov 2026.)
 *
 * The gate runs as middleware AHEAD of `requireAuth` and is re-checked inside
 * the handler. Ordering is a security property: when the endpoint is off it
 * must be indistinguishable from one that does not exist, and authenticating
 * first would answer 401 to an anonymous caller and 404 to a signed-in one —
 * a difference that is itself the disclosure. Gate first, then auth.
 *
 * ── What "ungated" does and does not mean ────────────────────────────────────
 * Turning `MILA_VOICE_WEB` on exposes an AUTHENTICATED, per-athlete, rate-limited
 * token minter. It does not weaken anything: the identity is still the verified
 * session's (never the request's), the conversation is still ownership-resolved,
 * and the token still grants mic-only publishing into one freshly-minted room.
 * What the flag buys is the ability to turn all of that off again in one config
 * change, without a deploy, if voice needs to stop.
 *
 * ── Why the room name is generated and not hardcoded ─────────────────────────
 * The worker sets `agentName: 'mila-voice'` (mila-voice/src/main.ts), which opts
 * it into EXPLICIT DISPATCH: it joins no room on its own and must be told. We
 * tell it through the token's `roomConfig`, and the LiveKit docs are precise
 * about the limit of that mechanism — "agent dispatch from the token only occurs
 * when the room is first created. If the room already exists, the token's
 * dispatch configuration is ignored."
 *
 * A fixed room name would therefore work exactly once. The second page load
 * inside the room's empty-timeout window would join a room that already exists,
 * the dispatch clause would be ignored, and the page would connect perfectly and
 * sit in silence with no agent and no error anywhere. A fresh room per token
 * makes the create-time dispatch fire every time. The PREFIX is hardcoded so the
 * rooms are recognisable in the LiveKit dashboard; only the suffix moves.
 *
 * ── The worker end of this ───────────────────────────────────────────────────
 * `mila-voice/src/main.ts` reads these ids back off `ctx.job.metadata` (via its
 * `parseJobMetadata`) and puts them on the session's `userData`, which is where
 * every tool takes its scope from. A job whose metadata carries no usable
 * athlete id is REFUSED there rather than run with a blank identity.
 *
 * The two sides are coupled by this metadata shape and nothing else, so a change
 * to the object below is a change to the worker's contract: keep the key names
 * in step, and remember the worker may be running an older build than this one.
 */

import crypto from "crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
  TrackSource,
} from "livekit-server-sdk";
import { requireAuth } from "../lib/auth";
import { voiceTokenLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { MILA } from "../mila/config";
import { resolveVoiceConversation } from "../mila/conversations";
import { mintVoiceGrant } from "./auth";
import { readMilaVoiceSettings, voiceDispatchFields } from "../services/milaVoice/settings";
import { PLATFORM_CAP_MESSAGE, platformBudget } from "../lib/platformSpend";
import { voiceAllowance, VOICE_MINUTES_MESSAGE, type VoiceAllowance } from "./voiceMinutes";
import { AGENT } from "../agent/config";
import { STOP_MESSAGES } from "../agent/engine/stopMessages";
import { spentTodayMicroUsd } from "../agent/trace";

/**
 * The LiveKit participant identity: an opaque per-athlete pseudonym, NOT her athlete id. LiveKit Cloud keeps
 * session / analytics logs by participant identity that Nomila cannot delete, so the identity must not be an id
 * that names her anywhere else. HMAC-SHA256 of the athlete id keyed by LIVEKIT_API_SECRET: stable per athlete (the
 * LiveKit dashboard still groups her sessions), unlinkable without the secret, and meaningless once her account is
 * deleted. Nothing reads it back as an athlete id: the worker (mila-voice) takes the athlete from the dispatch
 * metadata below and the client only compares it with its own localParticipant.identity.
 */
export function voiceIdentityFor(athleteId: string): string {
  const key = process.env.LIVEKIT_API_SECRET?.trim() ?? "";
  return "a_" + crypto.createHmac("sha256", key).update(`livekit-identity:${athleteId}`).digest("hex").slice(0, 32);
}

const logger = createLogger("voice/webToken");

/**
 * The worker's DISPATCH name — `ServerOptions.agentName` in
 * mila-voice/src/main.ts. If that string changes, this one must change with it:
 * a mismatch is silent. LiveKit accepts the dispatch, finds no worker registered
 * under the name, and the room simply never gets an agent.
 *
 * Env-overridable ONLY to make local worker testing deterministic. A locally-run
 * worker otherwise registers under the same "mila-voice" as the DEPLOYED one,
 * LiveKit load-balances between them, and roughly half of local calls are served
 * by the cloud build — which looks like a flaky change rather than the wrong
 * worker answering. Override this and `MILA_VOICE_AGENT_NAME` on the worker to
 * the same value to pin a session to your laptop.
 *
 * The default is unchanged, so production behaviour does not move. Keep it unset
 * everywhere except a local shell: a stray value in a deployed environment is
 * the silent-mismatch failure above.
 *
 * A FUNCTION rather than a const, for the same read-at-call-time reason the flags
 * in ../mila/config.ts are getters. Production cannot tell the difference — Cloud
 * Run fixes the environment at boot, so every call resolves to the same string
 * forever. A test can: a module-level const is captured when the static import
 * evaluates, which is before any jest hook runs, so a developer's exported
 * override was already baked in and no amount of clearing it in `beforeEach`
 * could reach it. See the ENV_KEYS note in ./webTokenRoute.test.ts.
 */
const agentName = (): string =>
  process.env.MILA_VOICE_AGENT_NAME ?? "mila-voice";

/** Hardcoded so demo rooms are identifiable; only the suffix varies. */
const ROOM_PREFIX = "mila-web";

/**
 * Short-lived on purpose. The token is only ever used for the single connect
 * that immediately follows the fetch, so anything longer is a credential lying
 * around in a browser tab for no benefit.
 */
const TOKEN_TTL = "15m";

/**
 * Env vars this route cannot run without. Reported by NAME only, never value.
 *
 * MILA_TEST_ATHLETE_ID is gone as of Stage 2 — identity now comes from the
 * authenticated session, so there is no environment fallback to be missing. What
 * remains is only the LiveKit credential set.
 */
const REQUIRED_ENV = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

function missingEnv(): string[] {
  return REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
}

// ─── The token endpoint (flag-gated, ships to production) ─────────────────────

export const tokenRouter = Router();

/**
 * The flag gate as middleware, so it can run BEFORE `requireAuth`.
 *
 * Ordering is the point, and it is a security property rather than a style
 * choice: with voice off, this endpoint must be indistinguishable from one that
 * does not exist. Authenticating first would answer 401 to an anonymous caller
 * and 404 to a signed-in one, and that difference is itself the disclosure. Gate
 * first, then auth — the same shape the dev gate had, now keyed on the flag.
 *
 * `Cache-Control: no-store` is set here rather than only in the handler so that
 * EVERY answer this route can give carries it — including the 404 below, the 401
 * `requireAuth` writes, and the 429 from the limiter, none of which reach the
 * handler.
 */
function voiceWebGate(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");

  if (!MILA.VOICE_WEB) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  next();
}

// POST /voice/token — mint one join token for one fresh room.
//
// POST rather than GET because it is not idempotent in the way that matters: a
// room name is created and an agent dispatch is committed to the token. A GET
// would be prefetched by the browser and speculatively dispatch a worker job.
//
// The middleware order is load-bearing in both directions:
//   voiceWebGate  — before auth, so a disabled endpoint discloses nothing
//   requireAuth   — Firebase ID token in, `req.athleteId` out, 401 otherwise
//   voiceTokenLimiter — AFTER auth, because it keys on `req.athleteId`; keying by
//                 IP would let one athlete's bursts exhaust everyone's budget,
//                 and an unauthenticated caller never reaches it anyway
tokenRouter.post(
  "/voice/token",
  voiceWebGate,
  requireAuth,
  voiceTokenLimiter,
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    // Re-checked inside the handler, not only at the gate and the mount. Three
    // independent reads of the same flag, fail-closed at each: the cost of a
    // stale mount or a reordered middleware chain is a public token minter.
    if (!MILA.VOICE_WEB) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const missing = missingEnv();
    if (missing.length) {
      // Names only. These are the things a developer needs to add to .env, and
      // naming them saves a debugging session; the VALUES never appear here or
      // in the log.
      logger.warn({ missing }, "Voice web demo not configured");
      res.status(503).json({
        error: "Voice demo not configured",
        missing,
      });
      return;
    }

    const wsUrl = process.env.LIVEKIT_URL!.trim();

    // ── The invariant, in one line ───────────────────────────────────────────
    // The ONLY source of athlete identity on this route. `req.body`,
    // `req.query` and `req.params` are never consulted for it, here or anywhere
    // below — see the header. If a future edit makes this read anything a client
    // can set, that edit is a tenancy break, not a feature.
    const athleteId = req.athleteId!;

    // Spend guards, checked before anything is minted: the platform-wide day ceiling (lib/platformSpend.ts) and the athlete's
    // daily voice minutes (./voiceMinutes.ts). A failed read refuses (500 below), never grants unbounded time.
    let allowance: VoiceAllowance;
    try {
      if ((await platformBudget()).over) {
        res.status(429).json({ error: PLATFORM_CAP_MESSAGE, code: "platform_spend_cap" });
        return;
      }
      allowance = await voiceAllowance(athleteId);
    } catch (err: any) {
      logger.error({ error: err?.message }, "Voice minutes check failed");
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    if (!allowance.allowed) {
      logger.info({ athleteId, usedMinutes: Math.round(allowance.usedMinutes), capMinutes: allowance.capMinutes }, "Voice refused: daily minutes cap");
      res.status(429).json({ error: VOICE_MINUTES_MESSAGE, code: "voice_minutes_cap" });
      return;
    }
    // The athlete's day spend cap (AGENT_DAY_COST_CAP_USD), the one her text turns are held to. Her total includes her
    // voice today, ESTIMATED (agent/trace.ts spentTodayMicroUsd), so a day of talking reaches it too. At or over it, no
    // session, with the same message a text turn gets at the cap. A failed read refuses, never an uncapped session.
    let spentMicroUsd: number;
    try {
      spentMicroUsd = await spentTodayMicroUsd(athleteId);
    } catch (err: any) {
      logger.error({ error: err?.message }, "Voice day spend check failed");
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    if (spentMicroUsd >= AGENT.DAY_COST_CAP_MICRO_USD) {
      logger.info({ athleteId, spentMicroUsd, capMicroUsd: AGENT.DAY_COST_CAP_MICRO_USD }, "Voice refused: athlete day spend cap");
      res.status(429).json({ error: STOP_MESSAGES.cost_cap_day, code: "cost_cap_day" });
      return;
    }

    // The one value the client MAY influence, and it is resolved rather than
    // trusted: this returns an id `athleteId` demonstrably owns, substituting a
    // fresh one for anything unowned-by-them or malformed.
    const conversationId = await resolveVoiceConversation(
      athleteId,
      (req.body as Record<string, unknown> | undefined)?.conversationId,
    );

    // The voice and language the athlete picked in Me (services/milaVoice). Fail-open: a failed read dispatches the
    // session with no voice or language keys, which is the worker's default voice and "follow the athlete" — the call
    // must never be lost over a preference.
    const voiceFields = await readMilaVoiceSettings(athleteId).then(voiceDispatchFields).catch((err) => {
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "Voice settings not read — default voice and language");
      return {};
    });

    const room = `${ROOM_PREFIX}-${crypto.randomUUID().slice(0, 8)}`;

    try {
      const at = new AccessToken(
        process.env.LIVEKIT_API_KEY!.trim(),
        process.env.LIVEKIT_API_SECRET!.trim(),
        { identity: voiceIdentityFor(athleteId), ttl: TOKEN_TTL },
      );

      // The narrowest grant that still makes a voice call work.
      // `canPublishSources` pins publishing to the microphone, so a token
      // leaking out of this page cannot be used to push a camera or a screen
      // share into the room. `canPublishData` is transport-level (LiveKit's data
      // channel) and unrelated to Mila's app-level "cannot send on the athlete's
      // behalf" rule, which is enforced by the agent's own tools, not by this
      // grant.
      at.addGrant({
        roomJoin: true,
        room,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: true,
      });

      // The athlete-bound session grant (./auth.ts). The worker echoes it as
      // `x-voice-grant` on every /api/internal/voice call, which is what lets
      // those routes check the PATH athlete against the athlete this session was
      // opened for — rather than trusting any id a secret holder puts in a URL.
      // Minted from `athleteId` above and nothing else. It rides inside the
      // signed LiveKit token, so a browser can read it but not alter it, and it
      // is useless without the service secret, which only the worker holds.
      // Null when VOICE_GRANT_SECRET is unset: the session still runs (observe
      // mode), and enforce mode refuses it — fail-closed.
      const minted = mintVoiceGrant(athleteId, conversationId, Date.now(), allowance.remainingMs);
      if (!minted) {
        logger.warn("VOICE_GRANT_SECRET unset — voice session has no grant");
      }

      // The dispatch. Without this the worker never joins — see the header.
      at.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({
            agentName: agentName(),
            // voice / grokVoice / conversationLanguage only when the athlete set them (voiceDispatchFields), so an
            // older worker, which ignores unknown keys, and an athlete on the defaults both see exactly the old shape.
            // Spread FIRST, so a preference field can never overwrite an identity key.
            metadata: JSON.stringify(
              minted
                ? { ...voiceFields, athleteId, conversationId, grant: minted.grant }
                : { ...voiceFields, athleteId, conversationId },
            ),
          }),
        ],
      });

      const token = await at.toJwt();

      logger.info(
        { room, agentName: agentName(), athleteId },
        "Voice token issued",
      );
      // `conversationId` is returned because the SERVER decided it and the
      // client cannot know the outcome otherwise: an id that was malformed, or
      // that turned out to belong to someone else, comes back as a different
      // (fresh) one. Echoing the resolved value is what lets the caller write
      // into the same thread it is about to hear from.
      res.json({ wsUrl, room, identity: voiceIdentityFor(athleteId), conversationId, token });
    } catch (err: any) {
      // Never echo err.message to the client: it can quote the API key on a
      // malformed-credential failure.
      logger.error({ error: err.message }, "Voice web demo token mint failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// No default export on purpose: callers name the router they mount.
