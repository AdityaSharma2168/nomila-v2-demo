/**
 * webTokenRoute.test.ts — GET /voice and POST /voice/token, the Track B web pipe.
 *
 * This route touches a credential, so the weight of this suite is on the three
 * things that would hurt:
 *
 *  1. THE GATE. Every way this endpoint can be reachable when it should not be —
 *     flag off, flag unset, NODE_ENV=production with the flag left on — is
 *     asserted to 404, because a single hole here is a token minter. The gate is
 *     also asserted to outrank auth in BOTH directions: gated off, an anonymous
 *     caller and a signed-in one get the same 404, so a 401 never becomes the
 *     tell that there is something here to authenticate against.
 *  2. THE AUTH (Stage 1 of Track 2). No token, a malformed header, a token
 *     Firebase rejects, and a valid token whose uid maps to no athlete row all
 *     get 401 and no minted token. A valid token gets 200.
 *  3. THE DISPATCH. `agentName` in the token's roomConfig is the entire reason
 *     the worker joins. A typo there fails silently at runtime: the room works,
 *     the page connects, and nobody ever speaks. So the token is decoded and the
 *     claim is asserted rather than trusted.
 *
 * The token is verified with the SDK's own TokenVerifier (real HS256 against the
 * test secret) so a malformed token cannot pass.
 *
 * ── Why the REAL requireAuth runs here ───────────────────────────────────────
 * Every other route suite in this repo stubs `../lib/auth` with a pass-through
 * that sets `req.athleteId`. That is right for suites testing what a handler
 * does with an identity it already has — but this suite's subject IS the guard,
 * and a stubbed guard would only ever prove the stub. So `../lib/auth` is NOT
 * mocked. Instead its two boundaries are: `firebase-admin/auth` (so no real
 * token verification or network) and `../db` (PGlite, so the auth_id → athlete
 * lookup is real SQL against the real schema). Everything between them — header
 * parsing, the 401 paths, the athlete resolution — is production code.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

// Already-initialized, so requireAuth's module-load `initializeApp()` is skipped
// (it would otherwise reach for Application Default Credentials).
jest.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  initializeApp: () => ({}),
}));

// The ONLY thing stubbed inside the auth path: the signature check itself.
// A token is "valid" iff the suite has registered a uid for it; anything else
// throws, which is exactly how firebase-admin reports a bad token.
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
   
    verifyIdToken: async (idToken: string) => {
      const uid = (globalThis as any).__TEST_UID_BY_TOKEN?.[idToken];
      if (!uid) throw new Error("Firebase ID token has invalid signature.");
      return { uid };
    },
  }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TokenVerifier } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tokenRouter, voiceIdentityFor } from "./webTokenRoute";
import {
  VOICE_GRANT_BUFFER_MS,
  VOICE_SESSION_MAX_MS,
  verifyVoiceGrant,
} from "./auth";
import { agentRuns, athletes, chatMessages, conversations, milaVoiceSettings } from "../../shared/schema";
import { VOICE_CATALOGUE } from "../services/milaVoice/catalogue";
import * as milaVoice from "../services/milaVoice/settings";
import { STOP_MESSAGES } from "../agent/engine/stopMessages";
import { voiceTokenLimiter } from "../lib/rateLimit";
import { setPlatformSpendReaderForTests } from "../lib/platformSpend";
import { voiceDayMinutesCap, VOICE_DAY_MINUTES_DEFAULT, VOICE_DAY_MINUTES_MAX } from "./voiceMinutes";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const API_KEY = "APItestkey";
const API_SECRET = "test-secret-at-least-32-bytes-long-xxxxx";
const WS_URL = "wss://mila-test.livekit.cloud";

/**
 * The pre-Stage-2 env athlete. Still SET in the environment on every test, so
 * the suite can prove the route no longer reads it — an id that is absent proves
 * nothing.
 */
const ENV_ATHLETE_ID = "11111111-2222-3333-4444-555555555555";
const ENV_CONVERSATION_ID = "99999999-8888-7777-6666-555555555555";

/** A Firebase ID token the mocked verifier accepts, for a real athlete row. */
const VALID_TOKEN = "valid-firebase-id-token";
const FIREBASE_UID = "firebase-uid-with-an-athlete-row";
/** A SECOND real signed-in athlete — the "somebody else" in every tenancy test. */
const SECOND_TOKEN = "valid-firebase-id-token-second-athlete";
const SECOND_UID = "firebase-uid-second-athlete";
/** Verifies fine, but its uid maps to no athlete — requireAuth's last 401. */
const ORPHAN_TOKEN = "valid-firebase-id-token-no-athlete";
const ORPHAN_UID = "firebase-uid-with-no-athlete-row";

let server: Server;
let base: string;
/** The signed-in caller's athlete row. Deliberately NOT the env athlete. */
let callerAthleteId: string;
/** A conversation the caller owns, for the honour-what-is-mine case. */
let callerConversationId: string;
/** Another athlete, and a conversation only they own. */
let secondAthleteId: string;
let secondConversationId: string;

/**
 * `auth` is the bearer token to send: the valid one by default, `null` for no
 * Authorization header at all, or any string to send that instead. `body` is the
 * JSON payload — the suite uses it to prove which of its fields are read and
 * which are ignored.
 */
async function post(
  path: string,
  auth: string | null = VALID_TOKEN,
  body?: unknown,
): Promise<{
  status: number;
  body: any;
  cacheControl: string | null;
}> {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => undefined),
    cacheControl: res.headers.get("cache-control"),
  };
}

/**
 * `post` with the rate limiter cleared first.
 *
 * For tests that mint several tokens in ONE `it` to sweep a set of inputs — the
 * subject there is what the route does with each payload, and hitting the 5/min
 * ceiling partway through would fail them for a reason that has nothing to do
 * with what they assert. The limiter's own behaviour is tested deliberately in
 * its own block, against the real ceiling.
 */
async function postUnthrottled(
  path: string,
  auth: string | null = VALID_TOKEN,
  body?: unknown,
): Promise<{ status: number; body: any; cacheControl: string | null }> {
  for (const id of [callerAthleteId, secondAthleteId]) {
    voiceTokenLimiter.resetKey(id);
  }
  return post(path, auth, body);
}

/** For the malformed-header cases, where the scheme itself is the subject. */
async function postWithRawAuthHeader(
  path: string,
  authorization: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** Decodes the JWT payload without verifying — for asserting claim CONTENT. */
function decode(token: string): any {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

const ENV_KEYS = [
  "MILA_VOICE_WEB",
  "NODE_ENV",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "MILA_TEST_ATHLETE_ID",
  "MILA_TEST_CONVERSATION_ID",
  // Saved/restored so this suite cannot LEAK a developer's local dispatch-name
  // override into whatever runs after it. See the beforeEach on why deleting it
  // is necessary but not sufficient for the dispatch assertion itself.
  "MILA_VOICE_AGENT_NAME",
  "VOICE_GRANT_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  await initTestDb();

  // Two real athletes, each keyed by the Firebase uid the mocked verifier
  // returns. Neither is the env athlete — keeping all three distinct is what
  // lets this suite tell "minted for the caller" apart from "minted for a
  // constant" apart from "minted for whoever asked".
  const [caller] = await db
    .insert(athletes)
    .values({ full_name: "Voice Caller", auth_id: FIREBASE_UID } as any)
    .returning({ id: athletes.id });
  callerAthleteId = caller.id;

  const [second] = await db
    .insert(athletes)
    .values({ full_name: "Other Athlete", auth_id: SECOND_UID } as any)
    .returning({ id: athletes.id });
  secondAthleteId = second.id;

  // One conversation each, owned outright.
  callerConversationId = randomUUID();
  await db
    .insert(conversations)
    .values({ id: callerConversationId, athlete_id: callerAthleteId } as any);

  secondConversationId = randomUUID();
  await db
    .insert(conversations)
    .values({ id: secondConversationId, athlete_id: secondAthleteId } as any);

  (globalThis as any).__TEST_UID_BY_TOKEN = {
    [VALID_TOKEN]: FIREBASE_UID,
    [SECOND_TOKEN]: SECOND_UID,
    // Registered, so it passes verification — but no athlete row carries it.
    [ORPHAN_TOKEN]: ORPHAN_UID,
  };

  const app = express();
  app.use(express.json());
  // Mounted unconditionally on purpose: index.ts gates the mount on MILA_VOICE_WEB,
  // and this suite must be able to prove the route ALSO refuses on its own.
  app.use(tokenRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete (globalThis as any).__TEST_UID_BY_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Re-armed per test so a test that disables the gate cannot leak into the next.
beforeEach(() => {
  // The token endpoint's own flag.
  process.env.MILA_VOICE_WEB = "true";
  process.env.NODE_ENV = "development";
  process.env.LIVEKIT_URL = WS_URL;
  process.env.LIVEKIT_API_KEY = API_KEY;
  process.env.LIVEKIT_API_SECRET = API_SECRET;
  // Deliberately still set. The route must no longer read either, and the only
  // way to prove that is to leave a plausible value sitting there for it to pick
  // up if the wiring ever regresses.
  process.env.MILA_TEST_ATHLETE_ID = ENV_ATHLETE_ID;
  process.env.MILA_TEST_CONVERSATION_ID = ENV_CONVERSATION_ID;
  // Cleared so the dispatch assertion below tests the DEFAULT name rather than
  // whatever a developer has exported to pin a local worker. Necessary — it stops
  // the value leaking onward — but NOT sufficient on its own: `AGENT_NAME` in
  // webTokenRoute.ts is a module-level const, captured when the static import at
  // the top of this file evaluated, which is before any hook runs. With the var
  // exported in the shell the const has already taken it, and the assertion still
  // fails. Making it read-at-call-time (the getter pattern ../mila/config.ts uses
  // for exactly this reason) is what would close that, and is a route change.
  delete process.env.MILA_VOICE_AGENT_NAME;

  // The limiter is REAL here, not mocked — it is part of the middleware chain
  // under test. But its counters are per-athlete and live for a 60s window, so
  // without this every suite that mints more than 5 tokens would start 429ing
  // itself partway through and the failures would look like route bugs.
  // Cleared per test rather than raised, so the ceiling under test is production's.
  for (const id of [callerAthleteId, secondAthleteId]) {
    voiceTokenLimiter.resetKey(id);
  }
});

describe("the MILA_VOICE_WEB flag (the token endpoint's gate)", () => {
  it("404s when the flag is unset (fail-closed — the default is off)", async () => {
    delete process.env.MILA_VOICE_WEB;
    const res = await post("/voice/token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("404s when the flag is any value but exactly 'true'", async () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true", ""]) {
      process.env.MILA_VOICE_WEB = value;
      const res = await post("/voice/token");
      expect(res.status).toBe(404);
    }
  });

  it("200s in PRODUCTION when the flag is on — the NODE_ENV gate is gone", async () => {
    // The whole point of Stage 4. Before it, this was a 404 by construction.
    process.env.NODE_ENV = "production";
    const res = await post("/voice/token");
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
  });

  it("404s in production when the flag is off — production is not the gate, the flag is", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MILA_VOICE_WEB;
    const res = await post("/voice/token");
    expect(res.status).toBe(404);
  });

  it("never returns a token on any gated-off response", async () => {
    delete process.env.MILA_VOICE_WEB;
    const res = await post("/voice/token");
    expect(JSON.stringify(res.body)).not.toContain("eyJ");
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("wsUrl");
  });

  it("sets Cache-Control: no-store on both the allowed and refused paths", async () => {
    const ok = await post("/voice/token");
    expect(ok.cacheControl).toBe("no-store");

    delete process.env.MILA_VOICE_WEB;
    const denied = await post("/voice/token");
    expect(denied.cacheControl).toBe("no-store");
  });

  it("sets Cache-Control: no-store on the 401 too", async () => {
    // The 401 is written by requireAuth and never reaches the handler, so the
    // header has to come from the gate middleware ahead of it.
    const res = await post("/voice/token", null);
    expect(res.status).toBe(401);
    expect(res.cacheControl).toBe("no-store");
  });

  it("outranks auth: flag off, anonymous and signed-in get the SAME 404", async () => {
    // The disclosure test. The gate must run BEFORE requireAuth — if auth went
    // first, an anonymous caller would get 401 where a signed-in one gets 404,
    // and that difference tells an unauthenticated stranger the endpoint exists.
    delete process.env.MILA_VOICE_WEB;

    const anonymous = await post("/voice/token", null);
    const signedIn = await post("/voice/token");
    const badToken = await post("/voice/token", "garbage");

    expect(anonymous.status).toBe(404);
    expect(signedIn.status).toBe(404);
    expect(badToken.status).toBe(404);
    expect(anonymous.body).toEqual(signedIn.body);
    expect(anonymous.body).toEqual(badToken.body);
    expect(anonymous.cacheControl).toBe(signedIn.cacheControl);
  });

  it("the three states, end to end", async () => {
    // flag off → 404 (anon and signed-in alike)
    delete process.env.MILA_VOICE_WEB;
    expect((await post("/voice/token", null)).status).toBe(404);
    expect((await post("/voice/token")).status).toBe(404);

    // flag on + no auth → 401
    process.env.MILA_VOICE_WEB = "true";
    expect((await post("/voice/token", null)).status).toBe(401);

    // flag on + auth → 200
    const ok = await post("/voice/token");
    expect(ok.status).toBe(200);
    expect(ok.body.identity).toBe(voiceIdentityFor(callerAthleteId));
  });
});

describe("the per-athlete rate limit", () => {
  it("cuts a caller off after the ceiling, and says so without minting", async () => {
    // A mint dispatches a worker job and opens a billable realtime session, so
    // the ceiling is the cheapest protection against a stuck retry loop.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await post("/voice/token")).status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);

    const blocked = await post("/voice/token");
    expect(blocked.status).toBe(429);
    expect(blocked.body).not.toHaveProperty("token");
    expect(blocked.body.error).toMatch(/voice too often/i);
  });

  it("is per-athlete — one caller's burst does not block another", async () => {
    // Keying by athlete rather than IP is the whole reason the limiter sits
    // AFTER requireAuth. If it keyed by IP, two athletes behind one NAT (or one
    // Cloud Run load balancer) would share a budget.
    for (let i = 0; i < 6; i++) await post("/voice/token", VALID_TOKEN);
    expect((await post("/voice/token", VALID_TOKEN)).status).toBe(429);

    // The second athlete is untouched.
    expect((await post("/voice/token", SECOND_TOKEN)).status).toBe(200);
  });

  it("runs after auth — an anonymous flood gets 401, never 429", async () => {
    // An unauthenticated caller has no athlete to key on. It must be turned away
    // by requireAuth before it can consume anyone's budget.
    for (let i = 0; i < 8; i++) {
      expect((await post("/voice/token", null)).status).toBe(401);
    }
    // And the real caller's budget is untouched by that flood.
    expect((await post("/voice/token")).status).toBe(200);
  });

  it("runs after the gate — a flood against a disabled endpoint stays 404", async () => {
    delete process.env.MILA_VOICE_WEB;
    for (let i = 0; i < 8; i++) {
      expect((await post("/voice/token")).status).toBe(404);
    }
  });
});

describe("authentication", () => {
  it("401s with no Authorization header, and mints nothing", async () => {
    const res = await post("/voice/token", null);
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("wsUrl");
    expect(JSON.stringify(res.body)).not.toContain("eyJ");
  });

  it("401s on a token Firebase rejects", async () => {
    const res = await post("/voice/token", "not-a-real-firebase-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired token" });
    expect(res.body).not.toHaveProperty("token");
  });

  it("401s on a malformed Authorization header", async () => {
    // The scheme matters: requireAuth only accepts "Bearer ". A raw token, the
    // wrong scheme, or the right scheme with nothing after it are all refused.
    for (const header of [
      VALID_TOKEN,
      `Basic ${VALID_TOKEN}`,
      `bearer ${VALID_TOKEN}`,
      "Bearer",
      "Bearer ",
    ]) {
      const res = await postWithRawAuthHeader("/voice/token", header);
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty("token");
    }
  });

  it("401s on a verifiable token whose uid has no athlete row", async () => {
    // Signed in to Firebase is not the same as being an athlete here. This is
    // requireAuth's last gate and it is the one a brand-new Google account hits.
    const res = await post("/voice/token", ORPHAN_TOKEN);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "No athlete account found for this token",
    });
    expect(res.body).not.toHaveProperty("token");
  });

  it("200s and mints a real token for a valid caller", async () => {
    const res = await post("/voice/token");
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    // Not merely present — actually valid against the configured secret.
    await expect(
      new TokenVerifier(API_KEY, API_SECRET).verify(res.body.token),
    ).resolves.toBeDefined();
  });

  it("refuses before reading configuration — an anonymous caller learns nothing", async () => {
    // The 503 names missing env vars. Auth runs first, so that list is only ever
    // shown to someone signed in.
    delete process.env.LIVEKIT_API_KEY;

    const anonymous = await post("/voice/token", null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toHaveProperty("missing");

    const signedIn = await post("/voice/token");
    expect(signedIn.status).toBe(503);
    expect(signedIn.body.missing).toContain("LIVEKIT_API_KEY");
  });

  it("mints for the AUTHENTICATED caller — the env athlete is gone", async () => {
    // The Stage-1 assertion, inverted. It used to prove the token carried the
    // env athlete and NOT the caller; Stage 2 is exactly the change that flips
    // it, and the env athlete must no longer appear anywhere.
    const res = await post("/voice/token");
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));

    const metadata = JSON.parse(
      decode(res.body.token).roomConfig.agents[0].metadata,
    );
    expect(metadata.athleteId).toBe(callerAthleteId);
    expect(JSON.stringify(res.body)).not.toContain(ENV_ATHLETE_ID);
  });

  it("mints for the caller who actually presented the token, not a fixed one", async () => {
    // Two different signed-in athletes, two different identities. A single
    // hardcoded id would satisfy every other assertion in this file.
    const a = await post("/voice/token", VALID_TOKEN);
    const b = await post("/voice/token", SECOND_TOKEN);

    expect(a.body.identity).toBe(voiceIdentityFor(callerAthleteId));
    expect(b.body.identity).toBe(voiceIdentityFor(secondAthleteId));
    expect(a.body.identity).not.toBe(b.body.identity);

    expect(
      JSON.parse(decode(a.body.token).roomConfig.agents[0].metadata).athleteId,
    ).toBe(callerAthleteId);
    expect(
      JSON.parse(decode(b.body.token).roomConfig.agents[0].metadata).athleteId,
    ).toBe(secondAthleteId);
  });
});

// ─── The athlete-bound session grant (server/voice/auth.ts) ───────────────────
describe("the voice session grant in the dispatch metadata", () => {
  const metaOf = (res: { body: any }) =>
    JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata);

  it("carries a grant that verifies to the CALLER, this conversation, a fresh day's voice time (capped at session max) + buffer", async () => {
    process.env.VOICE_GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";
    const before = Date.now();
    const res = await post("/voice/token", VALID_TOKEN, {
      athleteId: secondAthleteId,
    });
    expect(res.status).toBe(200);

    const meta = metaOf(res);
    const v = verifyVoiceGrant(meta.grant);
    if (!v.ok) throw new Error(`grant did not verify: ${v.reason}`);
    expect(v.claims.athleteId).toBe(callerAthleteId);
    expect(v.claims.conversationId).toBe(res.body.conversationId);
    // No voice yet today: the grant is the whole daily allowance (default 20 min), never more than the session max.
    const life = (Math.min(VOICE_SESSION_MAX_MS, VOICE_DAY_MINUTES_DEFAULT * 60_000) + VOICE_GRANT_BUFFER_MS) / 1000;
    expect(v.claims.exp).toBeGreaterThanOrEqual(Math.floor(before / 1000 + life) - 1);
    expect(v.claims.exp).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000 + life));
  });

  it("omits the grant (and still mints) when VOICE_GRANT_SECRET is unset", async () => {
    delete process.env.VOICE_GRANT_SECRET;
    const res = await post("/voice/token", VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(metaOf(res).grant).toBeUndefined();
  });
});

// ─── Mila's voice and language (services/milaVoice) in the dispatch metadata ──
describe("the athlete's voice and language in the dispatch metadata", () => {
  const metaOf = (res: { body: any }) =>
    JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata);
  const VOICE_KEYS = ["voice", "grokVoice", "conversationLanguage"];
  afterEach(async () => {
    await db.delete(milaVoiceSettings);
    jest.restoreAllMocks();
  });

  it("carries no voice or language keys for an athlete on the defaults (the old shape)", async () => {
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(200);
    for (const k of VOICE_KEYS) expect(metaOf(res)).not.toHaveProperty(k);
  });

  it("carries the CALLER's resolved Gemini and Grok voice and fixed language, never another athlete's or the body's", async () => {
    const kore = VOICE_CATALOGUE.find((v) => v.id === "kore")!;
    await db.insert(milaVoiceSettings).values({ athlete_id: callerAthleteId, voice: "kore", conversation_language: "es" });
    await db.insert(milaVoiceSettings).values({ athlete_id: secondAthleteId, voice: "charon", conversation_language: "en" });
    const res = await postUnthrottled("/voice/token", VALID_TOKEN, { athleteId: secondAthleteId, voice: "Charon", conversationLanguage: "en" });
    expect(res.status).toBe(200);
    expect(metaOf(res)).toMatchObject({ athleteId: callerAthleteId, voice: kore.geminiVoice, grokVoice: kore.grokVoice, conversationLanguage: "es" });
  });

  it("an 'auto' language sends no language key; a voice alone still goes", async () => {
    const sulafat = VOICE_CATALOGUE.find((v) => v.id === "sulafat")!;
    await db.insert(milaVoiceSettings).values({ athlete_id: callerAthleteId, voice: "sulafat" });
    const meta = metaOf(await postUnthrottled("/voice/token"));
    expect(meta).toMatchObject({ voice: sulafat.geminiVoice, grokVoice: sulafat.grokVoice });
    expect(meta).not.toHaveProperty("conversationLanguage");
  });

  it("still mints, on the defaults, when the setting cannot be read (fail-open)", async () => {
    jest.spyOn(milaVoice, "readMilaVoiceSettings").mockRejectedValue(new Error("db down"));
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(200);
    const meta = metaOf(res);
    expect(meta.athleteId).toBe(callerAthleteId);
    for (const k of VOICE_KEYS) expect(meta).not.toHaveProperty(k);
  });
});

// ─── The invariant this whole stage exists to hold ───────────────────────────
//
// Identity comes from the verified session and from nowhere else. These tests
// try, from the outside, every way a client could ask to be somebody else.
describe("the body is never a source of identity", () => {
  it("ignores an athleteId in the body", async () => {
    const res = await post("/voice/token", VALID_TOKEN, {
      athleteId: secondAthleteId,
    });

    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
    expect(
      JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
        .athleteId,
    ).toBe(callerAthleteId);
    expect(JSON.stringify(res.body)).not.toContain(secondAthleteId);
  });

  it("ignores every spelling and casing of an athlete id a client might try", async () => {
    for (const payload of [
      { athleteId: secondAthleteId },
      { athlete_id: secondAthleteId },
      { identity: secondAthleteId },
      { sub: secondAthleteId },
      { athleteID: secondAthleteId },
      { AthleteId: secondAthleteId },
      { metadata: { athleteId: secondAthleteId } },
      { athleteId: ENV_ATHLETE_ID },
    ]) {
      const res = await postUnthrottled("/voice/token", VALID_TOKEN, payload);
      expect(res.status).toBe(200);
      expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
      expect(
        JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
          .athleteId,
      ).toBe(callerAthleteId);
    }
  });

  it("ignores an athleteId in the query string", async () => {
    const res = await post(
      `/voice/token?athleteId=${secondAthleteId}`,
      VALID_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
  });

  it("never mints for anyone else when the body is hostile or not an object", async () => {
    // Scalars are refused by express.json()'s strict mode (400) before the
    // handler runs; an array reaches it and has no conversationId to read. Both
    // are acceptable — what is NOT acceptable is a token for another athlete, so
    // that is what this asserts, rather than pinning a status code that belongs
    // to body parsing rather than to this route.
    for (const payload of [null, "athleteId", 42, [secondAthleteId]]) {
      const res = await postUnthrottled("/voice/token", VALID_TOKEN, payload);

      expect(res.status).not.toBe(500);
      if (res.status === 200) {
        expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
        expect(
          JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
            .athleteId,
        ).toBe(callerAthleteId);
      } else {
        // A parser rejection has no JSON body at all, which is itself proof
        // nothing was minted.
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body?.token).toBeUndefined();
      }
      expect(JSON.stringify(res.body ?? "")).not.toContain(secondAthleteId);
    }
  });

  it("cannot be talked into another athlete by BOTH ids at once", async () => {
    // The combined attempt: claim the identity and the thread in one request.
    const res = await post("/voice/token", VALID_TOKEN, {
      athleteId: secondAthleteId,
      conversationId: secondConversationId,
    });

    expect(res.status).toBe(200);
    const metadata = JSON.parse(
      decode(res.body.token).roomConfig.agents[0].metadata,
    );
    expect(metadata.athleteId).toBe(callerAthleteId);
    expect(metadata.conversationId).not.toBe(secondConversationId);
    expect(JSON.stringify(res.body)).not.toContain(secondAthleteId);
    expect(JSON.stringify(res.body)).not.toContain(secondConversationId);
  });
});

describe("the conversation id is resolved, not trusted", () => {
  it("honours an id the caller owns", async () => {
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: callerConversationId,
    });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe(callerConversationId);
    expect(
      JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
        .conversationId,
    ).toBe(callerConversationId);
  });

  it("claims a fresh id the caller has never used, so ownership precedes the write", async () => {
    const unused = randomUUID();
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: unused,
    });
    expect(res.body.conversationId).toBe(unused);

    const [row] = await db
      .select({ athlete_id: conversations.athlete_id })
      .from(conversations)
      .where(eq(conversations.id, unused));
    expect(row.athlete_id).toBe(callerAthleteId);
  });

  it("does NOT adopt another athlete's conversation, and does not say so", async () => {
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: secondConversationId,
    });

    // 200, not 4xx: an error would confirm the guessed id exists and is owned.
    expect(res.status).toBe(200);
    expect(res.body.conversationId).not.toBe(secondConversationId);
    expect(
      JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
        .conversationId,
    ).not.toBe(secondConversationId);

    // And the other athlete's row is untouched.
    const [row] = await db
      .select({ athlete_id: conversations.athlete_id })
      .from(conversations)
      .where(eq(conversations.id, secondConversationId));
    expect(row.athlete_id).toBe(secondAthleteId);
  });

  it("mints a usable thread when the client sends none or sends junk", async () => {
    for (const payload of [
      {},
      { conversationId: null },
      { conversationId: "not-a-uuid" },
    ]) {
      const res = await postUnthrottled("/voice/token", VALID_TOKEN, payload);
      expect(res.status).toBe(200);
      // Always a real uuid — the worker's transcript write requires one.
      expect(res.body.conversationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(
        JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
          .conversationId,
      ).toBe(res.body.conversationId);
    }
  });

  it("returns the resolved id, so the client can follow the thread it got", async () => {
    // The response is authoritative, not an echo: the client learns here that it
    // did not get what it asked for.
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: secondConversationId,
    });
    expect(res.body.conversationId).toBe(
      JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata)
        .conversationId,
    );
  });
});

describe("configuration errors", () => {
  it("503s naming every missing var, and names only — never values", async () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_URL;

    const res = await post("/voice/token");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Voice demo not configured");
    expect(res.body.missing.sort()).toEqual(["LIVEKIT_API_KEY", "LIVEKIT_URL"]);
    // The secret that IS set must not be echoed back alongside the ones missing.
    expect(JSON.stringify(res.body)).not.toContain(API_SECRET);
  });

  it("treats a whitespace-only var as missing", async () => {
    process.env.LIVEKIT_URL = "   ";
    const res = await post("/voice/token");
    expect(res.status).toBe(503);
    expect(res.body.missing).toContain("LIVEKIT_URL");
  });

  it("requires only the LiveKit credentials — identity is no longer configuration", async () => {
    // MILA_TEST_ATHLETE_ID was a required var until Stage 2. Its absence must
    // now be a non-event: the athlete comes from the session.
    delete process.env.MILA_TEST_ATHLETE_ID;
    delete process.env.MILA_TEST_CONVERSATION_ID;

    const res = await post("/voice/token");
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
  });
});

describe("the minted token", () => {
  it("returns the wire shape the page needs and nothing else", async () => {
    const res = await post("/voice/token");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "conversationId",
      "identity",
      "room",
      "token",
      "wsUrl",
    ]);
    expect(res.body.wsUrl).toBe(WS_URL);
    expect(res.body.identity).toBe(voiceIdentityFor(callerAthleteId));
    // LiveKit Cloud logs the participant identity and we cannot delete them: it must not be her athlete id.
    expect(res.body.identity).not.toContain(callerAthleteId);
    expect(decode(res.body.token).sub).toBe(res.body.identity);
  });

  it("reports the conversation voice will write into, matching the dispatch metadata", async () => {
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: callerConversationId,
    });
    // The SERVER decided this value; the response and the metadata are the same
    // resolution, so the client can trust what it is told.
    expect(res.body.conversationId).toBe(callerConversationId);
    const claims = decode(res.body.token);
    expect(
      JSON.parse(claims.roomConfig.agents[0].metadata).conversationId,
    ).toBe(res.body.conversationId);
  });

  it("never returns the API secret to the browser", async () => {
    const res = await post("/voice/token");
    expect(JSON.stringify(res.body)).not.toContain(API_SECRET);
    // The key is the JWT issuer and is not secret, but it has no business in
    // the response body either.
    expect(res.body.wsUrl).not.toContain(API_KEY);
  });

  it("verifies against the API secret with the API key as issuer", async () => {
    const res = await post("/voice/token");
    const payload = await new TokenVerifier(API_KEY, API_SECRET).verify(
      res.body.token,
    );
    expect(payload.sub).toBe(voiceIdentityFor(callerAthleteId));
  });

  it("does not verify against a different secret", async () => {
    const res = await post("/voice/token");
    await expect(
      new TokenVerifier(API_KEY, "a-completely-different-secret-value").verify(
        res.body.token,
      ),
    ).rejects.toThrow();
  });

  it("dispatches the worker by its agentName — the claim the room depends on", async () => {
    const res = await post("/voice/token");
    const claims = decode(res.body.token);

    // If this name drifts from ServerOptions.agentName in mila-voice/src/main.ts,
    // the page connects fine and no agent ever joins.
    expect(claims.roomConfig.agents).toHaveLength(1);
    expect(claims.roomConfig.agents[0].agentName).toBe("mila-voice");
  });

  it("carries the athlete and conversation ids as dispatch metadata", async () => {
    // This is the payload Stage 3's worker will read as its entire identity, so
    // the exact shape matters as much as the values.
    const res = await post("/voice/token", VALID_TOKEN, {
      conversationId: callerConversationId,
    });
    const claims = decode(res.body.token);
    expect(JSON.parse(claims.roomConfig.agents[0].metadata)).toEqual({
      athleteId: callerAthleteId,
      conversationId: callerConversationId,
    });
  });

  it("grants join on exactly the room it returns, and mic-only publishing", async () => {
    const res = await post("/voice/token");
    const claims = decode(res.body.token);

    expect(claims.video.room).toBe(res.body.room);
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.video.canPublish).toBe(true);
    expect(claims.video.canSubscribe).toBe(true);
    // Mic only: a leaked token cannot push a camera or a screen share.
    expect(claims.video.canPublishSources).toEqual(["microphone"]);
    // Nothing that would let the browser administer the room.
    expect(claims.video.roomAdmin).toBeUndefined();
    expect(claims.video.roomCreate).toBeUndefined();
    expect(claims.video.roomList).toBeUndefined();
  });

  it("issues a fresh room every time, so token dispatch always fires at creation", async () => {
    const rooms = new Set<string>();
    for (let i = 0; i < 5; i++)
      rooms.add((await postUnthrottled("/voice/token")).body.room);
    expect(rooms.size).toBe(5);
    for (const room of rooms) expect(room).toMatch(/^mila-web-[0-9a-f]{8}$/);
  });

  it("expires — a token left in a tab does not stay valid", async () => {
    const claims = decode((await post("/voice/token")).body.token);
    const ttl = claims.exp - claims.nbf;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });
});

describe("the daily voice-minutes cap (spend guards)", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  /** Voice turns for the caller: one session spanning `span` minutes, ending now (so it is today in UTC unless the
   *  suite runs in the first minutes after midnight; the span stays inside today by starting no earlier than midnight). */
  async function voiceSession(span: number) {
    const midnight = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const start = new Date(Math.max(midnight.getTime() + 1000, minutesAgo(span).getTime()));
    const times: Date[] = [];
    for (let t = start.getTime(); t <= Date.now(); t += 5 * 60_000) times.push(new Date(t));
    times.push(new Date());
    await db.insert(chatMessages).values(times.map((created_at) => ({
      athlete_id: callerAthleteId, role: "user", content: "spoken turn", conversation_id: callerConversationId, source: "voice", created_at,
    })) as any);
  }
  afterEach(async () => {
    delete process.env.MILA_VOICE_DAY_MINUTES;
    delete process.env.AGENT_DAY_COST_CAP_USD;
    await db.delete(chatMessages).where(eq(chatMessages.athlete_id, callerAthleteId));
    await db.delete(agentRuns).where(eq(agentRuns.athlete_id, callerAthleteId));
  });

  it("refuses at grant time once today's voice minutes reach the cap, with a clear message", async () => {
    // Any voice session today counts at least one minute, so a 1-minute cap is always reached (whatever the clock).
    process.env.MILA_VOICE_DAY_MINUTES = "1";
    await voiceSession(10);
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("voice_minutes_cap");
    expect(res.body.error).toMatch(/voice time/i);
    expect(res.body.token).toBeUndefined();
  });

  it("grants under the cap, and the grant is no longer than what is left of the day", async () => {
    process.env.VOICE_GRANT_SECRET = "voice-grant-secret-for-tests-xxxxxxxxxx";
    process.env.MILA_VOICE_DAY_MINUTES = "30";
    await voiceSession(0);
    const before = Date.now();
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(200);
    const meta = JSON.parse(decode(res.body.token).roomConfig.agents[0].metadata);
    const v = verifyVoiceGrant(meta.grant);
    expect(v.ok).toBe(true);
    // ≤ 30 minutes left (one counted for the session above) + the buffer, never the 60-minute maximum.
    if (v.ok) expect(v.claims.exp * 1000).toBeLessThanOrEqual(before + 30 * 60_000 + VOICE_GRANT_BUFFER_MS + 2_000);
    if (v.ok) expect(v.claims.exp * 1000).toBeLessThan(before + VOICE_SESSION_MAX_MS);
  });

  it("an override that is not a number is the default (20), never no cap; one above the maximum is clamped", () => {
    // Owner, 5 Nov 2026: default 20 minutes a day, hard maximum 300.
    expect([VOICE_DAY_MINUTES_DEFAULT, VOICE_DAY_MINUTES_MAX]).toEqual([20, 300]);
    delete process.env.MILA_VOICE_DAY_MINUTES;
    expect(voiceDayMinutesCap()).toBe(20);
    process.env.MILA_VOICE_DAY_MINUTES = "lots";
    expect(voiceDayMinutesCap()).toBe(VOICE_DAY_MINUTES_DEFAULT);
    process.env.MILA_VOICE_DAY_MINUTES = "100000";
    expect(voiceDayMinutesCap()).toBe(VOICE_DAY_MINUTES_MAX);
    process.env.MILA_VOICE_DAY_MINUTES = "-5";
    expect(voiceDayMinutesCap()).toBe(VOICE_DAY_MINUTES_DEFAULT);
  });

  it("refuses at the athlete's day spend cap (AGENT_DAY_COST_CAP_USD) with the same message a text turn gets", async () => {
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    await db.insert(agentRuns).values({
      athlete_id: callerAthleteId, skill_id: "t", skill_version: "1", trigger: "test", provider: "openai", model: "m", effort: "low",
      status: "completed", ended_at: new Date(), cost_micro_usd: 1_000_000,
    } as any);
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("cost_cap_day");
    expect(res.body.error).toBe(STOP_MESSAGES.cost_cap_day);
    expect(res.body.token).toBeUndefined();
  });

  it("voice alone counts toward the athlete's day cap: enough talking today refuses the next session", async () => {
    // 10 minutes of talk (+1) × the $0.15 estimate = $1.65, past a $1 day cap; well under the 60-minute voice cap.
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    await voiceSession(10);
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("cost_cap_day");
  });

  it("under the athlete's day cap, a session is granted", async () => {
    process.env.VOICE_GRANT_SECRET = "voice-grant-secret-for-tests-xxxxxxxxxx";
    process.env.AGENT_DAY_COST_CAP_USD = "1";
    await voiceSession(0); // 1 minute × $0.15
    const res = await postUnthrottled("/voice/token");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("the platform-wide day ceiling refuses voice for everyone", async () => {
    setPlatformSpendReaderForTests(async () => 10_000 * 1_000_000);
    try {
      const res = await postUnthrottled("/voice/token");
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("platform_spend_cap");
    } finally {
      setPlatformSpendReaderForTests(null);
    }
  });
});
