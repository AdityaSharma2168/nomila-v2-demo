/**
 * pass.test.ts — the athlete pass on its own (issue → verify, and every way it must fail), plus the size helper a
 * pass tool's result goes through (compactJson). Pure: no database, no network.
 */
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { issueAthletePass, PassError, verifyAthletePass } from "./pass";
import { compactJson } from "./compact";

const KEY = "unit-key-0123456789-0123456789-0123456789";
const A = randomUUID();
const now = 1_800_000_000;
const issue = (over: Partial<Parameters<typeof issueAthletePass>[0]> = {}) =>
  issueAthletePass({ athleteId: A, sessionId: "conv", runId: randomUUID(), skillId: "chat", scopes: ["read", "draft"], nowSeconds: now, ...over }, KEY);
const code = (fn: () => unknown): string => { try { fn(); return "ok"; } catch (e) { return e instanceof PassError ? e.code : `other:${(e as Error).message}`; } };

describe("athlete pass", () => {
  it("round-trips: the athlete, session, run, skill and scopes come from the pass", () => {
    const runId = randomUUID();
    expect(verifyAthletePass(issue({ runId }), KEY, now + 60)).toMatchObject({ athleteId: A, sessionId: "conv", runId, skillId: "chat", scopes: ["read", "draft"], expiresAt: now + 600 });
  });

  it("expires after 10 minutes", () => {
    expect(code(() => verifyAthletePass(issue(), KEY, now + 590))).toBe("ok");
    expect(code(() => verifyAthletePass(issue(), KEY, now + 700))).toBe("expired");
  });

  it("refuses a wrong audience, a wrong issuer, another key, alg none, a long-lived or malformed pass", () => {
    const claims = { sub: A, sid: "s", rid: randomUUID(), skill: "chat", scp: ["read"], iat: now, exp: now + 300, aud: "nomila-mcp", iss: "nomila-api", jti: "j" };
    const sign = (c: object, k = KEY) => jwt.sign(c, k, { algorithm: "HS256" });
    expect(code(() => verifyAthletePass(sign({ ...claims, aud: "other" }), KEY, now))).toBe("wrong_audience");
    expect(code(() => verifyAthletePass(sign({ ...claims, iss: "trueforge" }), KEY, now))).toBe("wrong_issuer");
    expect(code(() => verifyAthletePass(sign(claims, "another-key-0123456789-0123456789-01"), KEY, now))).toBe("invalid");
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect(code(() => verifyAthletePass(none, KEY, now))).toBe("invalid");
    expect(code(() => verifyAthletePass(sign({ ...claims, exp: now + 3600 }), KEY, now))).toBe("bad_claims");
    expect(code(() => verifyAthletePass(sign({ ...claims, sub: "not-a-uuid" }), KEY, now))).toBe("bad_claims");
    expect(code(() => verifyAthletePass(sign({ ...claims, scp: ["admin"] }), KEY, now))).toBe("bad_claims");
    expect(code(() => verifyAthletePass(sign(claims), KEY, now))).toBe("ok");
  });

  it("fails closed without a key, and without a pass", () => {
    expect(code(() => verifyAthletePass(issue(), null, now))).toBe("unconfigured");
    expect(code(() => issueAthletePass({ athleteId: A, sessionId: "s", runId: randomUUID(), skillId: "chat", scopes: ["read"] }, null))).toBe("unconfigured");
    expect(code(() => verifyAthletePass(undefined, KEY, now))).toBe("missing");
  });

  it("will not issue a pass with bad claims (no athlete, unknown scope, bad skill id)", () => {
    expect(code(() => issue({ athleteId: "" }))).toBe("bad_claims");
    expect(code(() => issue({ scopes: [] }))).toBe("bad_claims");
    expect(code(() => issue({ skillId: "../etc" }))).toBe("bad_claims");
  });
});

describe("compactJson", () => {
  it("leaves a result under budget unchanged", () => {
    expect(compactJson({ status: "ok", a: [1, 2] }, 1000)).toBe('{"status":"ok","a":[1,2]}');
  });

  it("shortens the longest list first and says how many were shown of how many", () => {
    const out = JSON.parse(compactJson({ status: "ok", rows: Array.from({ length: 200 }, (_, i) => `row-${i}-xxxxxxxxxx`), small: [1, 2] }, 1000));
    expect(out.rows.length).toBeLessThan(200);
    expect(out.truncated.rows).toEqual({ shown: out.rows.length, total: 200 });
    expect(out.small).toEqual([1, 2]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1000);
  });

  it("clips one huge text with a marker", () => {
    const s = compactJson({ status: "ok", text: "x".repeat(5000) }, 500);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain("[truncated:");
  });
});
