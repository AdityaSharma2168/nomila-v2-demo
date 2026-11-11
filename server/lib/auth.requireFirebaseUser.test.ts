/**
 * auth.requireFirebaseUser.test.ts — the Step 2c pre-link guard: verifies the identity-provider token and
 * exposes uid / email / email_verified WITHOUT requiring an athlete row or setting req.athleteId.
 */

jest.mock("../db", () => ({ db: {}, pool: { end: async () => {} } }));   // the guard never touches the database
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
const verifyIdToken = jest.fn();
jest.mock("firebase-admin/auth", () => ({ getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
    verifyIdToken: (t: string) => verifyIdToken(t) }) }));

import { requireFirebaseUser } from "./auth";

const run = async (authorization?: string) => {
  const req: any = { headers: authorization ? { authorization } : {} };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await requireFirebaseUser(req, res, next);
  return { req, res, next };
};

beforeEach(() => verifyIdToken.mockReset());

it("a valid token passes with uid/email/email_verified set and NO athlete lookup (req.athleteId stays unset)", async () => {
  verifyIdToken.mockResolvedValue({ uid: "uid-1", email: "a@example.com", email_verified: true });
  const { req, next } = await run("Bearer tok");
  expect(next).toHaveBeenCalled();
  expect(req).toMatchObject({ authUid: "uid-1", authEmail: "a@example.com", authEmailVerified: true });
  expect(req.athleteId).toBeUndefined();
});

it("an unverified or absent email is reported as unverified", async () => {
  verifyIdToken.mockResolvedValue({ uid: "uid-2" });
  const { req } = await run("Bearer tok");
  expect(req).toMatchObject({ authUid: "uid-2", authEmail: null, authEmailVerified: false });
});

it("a missing header or an invalid token is 401", async () => {
  expect((await run()).res.status).toHaveBeenCalledWith(401);
  verifyIdToken.mockRejectedValue(new Error("expired"));
  const { res, next } = await run("Bearer bad");
  expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
});
