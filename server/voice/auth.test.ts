/**
 * auth.test.ts — the voice authorization boundary in isolation: grant mint /
 * verify (expiry, tamper, wrong secret, wrong athlete) and `voiceAuthorized`'s
 * two modes (observe: allow + log; enforce: 401 / 403), then its path-id check
 * (400) and deletion fence (410). Pure; no DB (the fence read is injected), no network.
 */

const mockWarn = jest.fn();
jest.mock("../logger", () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// The deletion-fence read is injected per call below (authz); this only keeps the
// real DB module from loading. Nothing here touches a database.
jest.mock("../db", () => ({ db: {} }));

import type { Request } from "express";
import {
  VOICE_GRANT_BUFFER_MS,
  VOICE_GRANT_HEADER,
  VOICE_SESSION_MAX_MS,
  mintVoiceGrant,
  verifyVoiceGrant,
  VOICE_ACCOUNT_DELETING,
  voiceAuthorized,
  voiceGrantEnforced,
} from "./auth";

/** voiceAuthorized with the deletion fence injected: by default the athlete is NOT being deleted. */
const notDeleting = async () => false;
const authz = (r: Request, id: string | undefined, isDeleting: (id: string) => Promise<boolean> = notDeleting) =>
  voiceAuthorized(r, id, { isDeleting });

const SERVICE_SECRET = "voice-service-secret-0123456789";
const GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

const ENV = [
  "VOICE_SERVICE_SECRET",
  "VOICE_GRANT_SECRET",
  "VOICE_GRANT_ENFORCE",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  process.env.VOICE_SERVICE_SECRET = SERVICE_SECRET;
  process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
  delete process.env.VOICE_GRANT_ENFORCE;
  mockWarn.mockReset();
});

function req(headers: Record<string, string | undefined>): Request {
  return {
    headers: Object.fromEntries(
      Object.entries(headers).filter(([, v]) => v !== undefined),
    ),
    method: "GET",
    route: { path: "/athletes/:id/score" },
  } as unknown as Request;
}

const grantFor = (athleteId: string, now?: number): string =>
  mintVoiceGrant(athleteId, CONV, now)!.grant;

// ─── mint / verify ────────────────────────────────────────────────────────────

describe("mintVoiceGrant / verifyVoiceGrant", () => {
  it("round-trips the athlete, conversation and expiry", () => {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const minted = mintVoiceGrant(A, CONV, now)!;
    expect(minted.exp).toBe(
      Math.floor((now + VOICE_SESSION_MAX_MS + VOICE_GRANT_BUFFER_MS) / 1000),
    );
    const v = verifyVoiceGrant(minted.grant, now);
    expect(v).toEqual({
      ok: true,
      claims: { athleteId: A, conversationId: CONV, exp: minted.exp },
    });
  });

  it("expires at session max + buffer, not before", () => {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const g = grantFor(A, now);
    const life = VOICE_SESSION_MAX_MS + VOICE_GRANT_BUFFER_MS;
    expect(verifyVoiceGrant(g, now + life - 1_000).ok).toBe(true);
    expect(verifyVoiceGrant(g, now + life)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a tampered payload (athlete swapped, signature kept)", () => {
    const [v, , sig] = grantFor(A).split(".");
    const forged = Buffer.from(
      JSON.stringify({ athleteId: B, conversationId: CONV, exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(verifyVoiceGrant(`${v}.${forged}.${sig}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered signature", () => {
    const g = grantFor(A);
    const flipped = g.slice(0, -2) + (g.endsWith("AA") ? "BB" : "AA");
    expect(verifyVoiceGrant(flipped)).toMatchObject({ ok: false });
  });

  it("rejects a grant signed with a different secret", () => {
    const g = grantFor(A);
    process.env.VOICE_GRANT_SECRET = "a-completely-different-grant-secret-xx";
    expect(verifyVoiceGrant(g)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects missing, malformed and wrong-version grants", () => {
    expect(verifyVoiceGrant(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyVoiceGrant("")).toEqual({ ok: false, reason: "missing" });
    expect(verifyVoiceGrant(["x"])).toEqual({ ok: false, reason: "missing" });
    expect(verifyVoiceGrant("garbage")).toEqual({
      ok: false,
      reason: "malformed",
    });
    const [, body, sig] = grantFor(A).split(".");
    expect(verifyVoiceGrant(`v2.${body}.${sig}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("is fail-closed when VOICE_GRANT_SECRET is unset: no mint, no verify", () => {
    const g = grantFor(A);
    delete process.env.VOICE_GRANT_SECRET;
    expect(mintVoiceGrant(A, CONV)).toBeNull();
    expect(verifyVoiceGrant(g)).toEqual({ ok: false, reason: "unconfigured" });
  });
});

// ─── voiceAuthorized ──────────────────────────────────────────────────────────

describe("voiceAuthorized — the secret is always required", () => {
  it.each([false, true])("401s without the secret (enforce=%s)", async (on) => {
    if (on) process.env.VOICE_GRANT_ENFORCE = "true";
    const r = await authz(req({ [VOICE_GRANT_HEADER]: grantFor(A) }), A);
    expect(r).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("401s when VOICE_SERVICE_SECRET is unset, even with a valid grant", async () => {
    delete process.env.VOICE_SERVICE_SECRET;
    const r = await authz(
      req({
        "x-voice-secret": SERVICE_SECRET,
        [VOICE_GRANT_HEADER]: grantFor(A),
      }),
      A,
    );
    expect(r.ok).toBe(false);
  });
});

describe("voiceAuthorized — observe mode (VOICE_GRANT_ENFORCE unset)", () => {
  it("is off by default", async () => {
    expect(voiceGrantEnforced()).toBe(false);
  });

  it("passes silently with the secret and a matching grant", async () => {
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grantFor(A) }),
      A,
    );
    expect(r).toEqual({ ok: true });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("ALLOWS a missing grant, and logs it", async () => {
    const r = await authz(req({ "x-voice-secret": SERVICE_SECRET }), A);
    expect(r).toEqual({ ok: true });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatchObject({
      reason: "missing",
      enforced: false,
      pathAthleteId: A,
    });
    expect(mockWarn.mock.calls[0][1]).toBe("Voice grant check failed");
  });

  it("ALLOWS a mismatched athlete, and logs both ids — never the grant", async () => {
    const g = grantFor(A);
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: g }),
      B,
    );
    expect(r).toEqual({ ok: true });
    expect(mockWarn.mock.calls[0][0]).toMatchObject({
      reason: "athlete_mismatch",
      enforced: false,
      pathAthleteId: B,
      grantAthleteId: A,
    });
    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).not.toContain(g);
    expect(logged).not.toContain(SERVICE_SECRET);
    expect(logged).not.toContain(GRANT_SECRET);
  });
});

describe("voiceAuthorized — enforce mode (VOICE_GRANT_ENFORCE=true)", () => {
  beforeEach(() => {
    process.env.VOICE_GRANT_ENFORCE = "true";
  });

  it("passes with the secret and a grant for the path athlete", async () => {
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grantFor(A) }),
      A,
    );
    expect(r).toEqual({ ok: true });
  });

  it("403s a secret holder naming another athlete in the path", async () => {
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grantFor(A) }),
      B,
    );
    expect(r).toEqual({ ok: false, status: 403, error: "Forbidden" });
    expect(mockWarn.mock.calls[0][0]).toMatchObject({
      reason: "athlete_mismatch",
      enforced: true,
    });
  });

  it("401s the secret alone (no grant)", async () => {
    const r = await authz(req({ "x-voice-secret": SERVICE_SECRET }), A);
    expect(r).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("401s an expired grant", async () => {
    const old = grantFor(A, Date.now() - VOICE_SESSION_MAX_MS - VOICE_GRANT_BUFFER_MS - 1_000);
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: old }),
      A,
    );
    expect(r).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("401s everything when VOICE_GRANT_SECRET is unset (fail-closed)", async () => {
    const g = grantFor(A);
    delete process.env.VOICE_GRANT_SECRET;
    const r = await authz(
      req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: g }),
      A,
    );
    expect(r).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("treats anything but 'true' as off", async () => {
    process.env.VOICE_GRANT_ENFORCE = "1";
    expect(voiceGrantEnforced()).toBe(false);
    process.env.VOICE_GRANT_ENFORCE = " TRUE ";
    expect(voiceGrantEnforced()).toBe(true);
  });
});

// ─── the deletion fence (after the secret and the grant) ─────────────────────

describe("voiceAuthorized — the deletion fence", () => {
  const ok = () => req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grantFor(A) });

  it.each([false, true])("410s an athlete being deleted, with a plain message (enforce=%s)", async (on) => {
    if (on) process.env.VOICE_GRANT_ENFORCE = "true";
    const seen: string[] = [];
    const r = await authz(ok(), A, async (id) => { seen.push(id); return true; });
    expect(r).toEqual(VOICE_ACCOUNT_DELETING);
    expect(r).toEqual({
      ok: false,
      status: 410,
      error: "account_deleting",
      message: expect.stringContaining("being deleted"),
    });
    expect(seen).toEqual([A]);   // the PATH athlete is the one checked
  });

  it("fails closed: a fence read that throws counts as deleting", async () => {
    const r = await authz(ok(), A, async () => { throw new Error("db down"); });
    expect(r).toEqual(VOICE_ACCOUNT_DELETING);
  });

  it("checks the secret and the grant BEFORE the fence (no DB read for a stranger)", async () => {
    process.env.VOICE_GRANT_ENFORCE = "true";
    const isDeleting = jest.fn(async () => true);
    expect(await authz(req({ [VOICE_GRANT_HEADER]: grantFor(A) }), A, isDeleting)).toMatchObject({ status: 401 });
    expect(await authz(req({ "x-voice-secret": SERVICE_SECRET }), A, isDeleting)).toMatchObject({ status: 401 });
    expect(await authz(ok(), B, isDeleting)).toMatchObject({ status: 403 });
    expect(isDeleting).not.toHaveBeenCalled();
  });

  it("400s a malformed path id without reading the fence", async () => {
    const isDeleting = jest.fn(async () => false);
    const bad = "not-a-uuid";
    const r = await authz(req({ "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grantFor(bad) }), bad, isDeleting);
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid athlete id" });
    expect(isDeleting).not.toHaveBeenCalled();
  });

  it("lets a live athlete through", async () => {
    expect(await authz(ok(), A, async () => false)).toEqual({ ok: true });
  });
});

// ─── the live worker's request shape (nomila-co/mila-voice src/voiceAuth.ts) ──

describe("voiceAuthorized — the mila-voice worker's real request", () => {
  // What the worker sends on every /api/internal/voice call: voiceHeaders(grant, extra) =
  // { ...extra, "x-voice-secret": VOICE_SERVICE_SECRET, "x-voice-grant": grant }, where grant and the path athlete
  // both come from the same signed dispatch metadata that POST /voice/token wrote ({athleteId, conversationId,
  // grant}). The grant is minted exactly as webTokenRoute mints it: for the session's conversation, bounded by what is
  // left of the athlete's voice day.
  const workerHeaders = (grant: string, extra: Record<string, string> = {}) =>
    req({ ...extra, "x-voice-secret": SERVICE_SECRET, [VOICE_GRANT_HEADER]: grant });

  beforeEach(() => {
    process.env.VOICE_GRANT_ENFORCE = "true";
  });

  it.each([
    ["a full session", VOICE_SESSION_MAX_MS],
    ["the last 2 minutes of her day", 2 * 60_000],
  ])("passes under enforcement (%s)", async (_label, remainingMs) => {
    const { grant } = mintVoiceGrant(A, CONV, Date.now(), remainingMs)!;
    expect(await authz(workerHeaders(grant), A)).toEqual({ ok: true });
    expect(await authz(workerHeaders(grant, { "content-type": "application/json" }), A)).toEqual({ ok: true });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("passes for a session with no conversation (conversationId '')", async () => {
    const { grant } = mintVoiceGrant(A, "")!;
    expect(await authz(workerHeaders(grant), A)).toEqual({ ok: true });
  });

  it("is refused once the grant has run out (the worker's callLimit ends the call on this 401)", async () => {
    const { grant } = mintVoiceGrant(A, CONV, Date.now() - 2 * 60 * 60_000, 2 * 60_000)!;
    expect(await authz(workerHeaders(grant), A)).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });
});
