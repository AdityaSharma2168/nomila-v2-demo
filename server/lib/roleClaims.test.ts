/**
 * roleClaims.test.ts — sign-up adds its role to the login's roles claim without dropping others (prod, 25 Oct 2026:
 * every app sign-in overwrote ["athlete","admin"] with ["athlete"], so admins lost the admin page).
 */
const getUser = jest.fn();
const setCustomUserClaims = jest.fn(async () => {});
const auth = { getUser: (u: string) => getUser(u), setCustomUserClaims: (u: string, c: Record<string, unknown>) => (setCustomUserClaims as any)(u, c) };
import { setRoleClaimKeepingOthers } from "../lib/roleClaims";

beforeEach(() => { getUser.mockReset(); setCustomUserClaims.mockClear(); });

test("keeps admin when sign-up sets athlete", async () => {
  getUser.mockResolvedValue({ customClaims: { roles: ["admin"], other: 1 } });
  await setRoleClaimKeepingOthers(auth, "u1", "athlete");
  expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { roles: ["admin", "athlete"], other: 1 });
});

test("no write when the role is already there", async () => {
  getUser.mockResolvedValue({ customClaims: { roles: ["athlete", "admin"] } });
  await setRoleClaimKeepingOthers(auth, "u1", "athlete");
  expect(setCustomUserClaims).not.toHaveBeenCalled();
});

test("a new login gets the role", async () => {
  getUser.mockResolvedValue({ customClaims: undefined });
  await setRoleClaimKeepingOthers(auth, "u1", "athlete");
  expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { roles: ["athlete"] });
});

test("unreadable claims: sets the role alone, as before", async () => {
  getUser.mockRejectedValue(new Error("boom"));
  await setRoleClaimKeepingOthers(auth, "u1", "athlete");
  expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { roles: ["athlete"] });
});
