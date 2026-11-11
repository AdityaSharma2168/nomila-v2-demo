/**
 * auth.revocation.test.ts — the auth middleware honours revokeRefreshTokens and disabled users (verifyIdTokenChecked):
 * a token issued before the user's tokensValidAfterTime is refused, a disabled user is refused, a failed lookup fails
 * closed, and one user's state is read at most once per REVOCATION_CACHE_MS on an instance (forgetRevocationState
 * makes a revocation on this instance bite at once); a lookup that fails answers 503 (try again), not 401. Also
 * authenticateRequest's 503. Firebase Admin is mocked: nothing reaches a provider.
 */
jest.mock("../db", () => ({ db: {}, pool: { end: async () => {} } }));
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
const verifyIdToken = jest.fn();
const getUser = jest.fn();
jest.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken: (t: string) => verifyIdToken(t), getUser: (u: string) => getUser(u) }) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVOCATION_CACHE_MS, authenticateRequest, forgetRevocationState, requireFirebaseUser, tokenFailure, verifyIdTokenChecked } from "./auth";

const T0 = Date.parse("2026-10-12T12:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);
const run = async () => {
  const req: any = { headers: { authorization: "Bearer tok" } };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await requireFirebaseUser(req, res, next);
  return { res, next };
};

beforeEach(() => { verifyIdToken.mockReset(); getUser.mockReset(); forgetRevocationState(); });

it("a token from before the revocation is refused; one from after it passes", async () => {
  getUser.mockResolvedValue({ disabled: false, tokensValidAfterTime: new Date(T0).toUTCString() });
  verifyIdToken.mockResolvedValue({ uid: "u1", auth_time: sec(T0) - 60 });
  await expect(verifyIdTokenChecked("tok", T0)).rejects.toMatchObject({ code: "auth/id-token-revoked" });
  verifyIdToken.mockResolvedValue({ uid: "u1", auth_time: sec(T0) });
  await expect(verifyIdTokenChecked("tok", T0)).resolves.toMatchObject({ uid: "u1" });
});

it("the middleware answers 401 for a revoked token, a disabled or deleted user; 503 when the lookup itself fails", async () => {
  verifyIdToken.mockResolvedValue({ uid: "u2", auth_time: sec(Date.now()) - 3600 });
  getUser.mockResolvedValue({ disabled: false, tokensValidAfterTime: new Date().toUTCString() });
  let r = await run(); expect(r.res.status).toHaveBeenCalledWith(401); expect(r.next).not.toHaveBeenCalled();
  forgetRevocationState();
  getUser.mockResolvedValue({ disabled: true });
  r = await run(); expect(r.res.status).toHaveBeenCalledWith(401);
  forgetRevocationState();
  getUser.mockRejectedValue(new Error("network"));   // the check could not run: 503 (try again), never 401
  r = await run(); expect(r.res.status).toHaveBeenCalledWith(503); expect(r.next).not.toHaveBeenCalled();
  expect(r.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "AUTH_UNAVAILABLE" }));
  forgetRevocationState();
  getUser.mockRejectedValue(Object.assign(new Error("gone"), { code: "auth/user-not-found" }));   // deleted user: 401
  r = await run(); expect(r.res.status).toHaveBeenCalledWith(401);
  forgetRevocationState();
  getUser.mockResolvedValue({ disabled: false });   // never revoked
  r = await run(); expect(r.next).toHaveBeenCalled();
});

it("reads one user's state once per REVOCATION_CACHE_MS; forgetRevocationState makes a revocation bite at once", async () => {
  verifyIdToken.mockResolvedValue({ uid: "u3", auth_time: sec(T0) });
  getUser.mockResolvedValue({ disabled: false });
  await verifyIdTokenChecked("tok", T0);
  await verifyIdTokenChecked("tok", T0 + REVOCATION_CACHE_MS - 1);
  expect(getUser).toHaveBeenCalledTimes(1);
  await verifyIdTokenChecked("tok", T0 + REVOCATION_CACHE_MS + 1);
  expect(getUser).toHaveBeenCalledTimes(2);
  // revoked on this instance after the session started: the cache is dropped, the next check refuses
  getUser.mockResolvedValue({ disabled: false, tokensValidAfterTime: new Date(T0 + 5000).toUTCString() });
  forgetRevocationState("u3");
  await expect(verifyIdTokenChecked("tok", T0 + REVOCATION_CACHE_MS + 2)).rejects.toMatchObject({ code: "auth/id-token-revoked" });
});

it("authenticateRequest (requireAuth's check) and tokenFailure carry the same 503", async () => {
  verifyIdToken.mockResolvedValue({ uid: "u4", auth_time: sec(Date.now()) });
  getUser.mockRejectedValue(new Error("network"));
  const f = await authenticateRequest({ headers: { authorization: "Bearer tok" } } as any);
  expect(f?.status).toBe(503);
  expect(tokenFailure(new Error("bad signature")).status).toBe(401);
});

it("every Firebase ID-token check outside lib/auth goes through verifyIdTokenChecked (/signup, the waitlist)", () => {
  for (const f of ["routes/auth.ts", "routes/waitlist.ts"]) {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    expect(src).not.toMatch(/firebaseAuth\.verifyIdToken\(/);
    expect(src).toMatch(/verifyIdTokenChecked\(/);
  }
});
