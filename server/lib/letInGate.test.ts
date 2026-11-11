/**
 * letInGate.test.ts — launch board f14: an athlete still on the waitlist reaches only what the waitlist uses; every
 * other status, admins, and the escape hatch pass. Pure (no database).
 */
import { gatePath, refuseNotLetIn, waitlistApiGateEnabled, waitlistedMayCall } from "./letInGate";

const refuse = (path: string, over: Partial<Parameters<typeof refuseNotLetIn>[0]> = {}) =>
  refuseNotLetIn({ status: "waitlisted", roles: ["athlete"], path, env: {}, ...over });

describe("waitlisted athletes reach the waitlist's own endpoints", () => {
  it.each([
    "/api/v1/auth/me", "/api/v1/auth/signup", "/api/v1/auth/email-code/verify", "/api/v1/auth/callback/instagram",
    "/api/v1/waitlist", "/api/v1/waitlist/progress", "/api/v1/waitlist/rank", "/api/v1/waitlist/hero-photo",
    "/api/v1/identity/claims/abc", "/api/v1/public/onboarding-front", "/api/v1/admin/waitlist",
    "/api/v1/me/account", "/api/v1/me/export", "/api/v1/me/connections", "/api/v1/me/connections/123",
    "/api/v1/me/connect/instagram", "/api/v1/me/disconnect/instagram", "/api/v1/me/push/devices", "/api/v1/me/atmosphere/pick",
  ])("%s is open", (path) => {
    expect(refuse(path)).toBe(false);
  });
});

describe("and nothing else", () => {
  it.each([
    "/api/v1/me/chat", "/api/v1/me/conversations", "/api/v1/me/brand-book", "/api/v1/me/deals", "/api/v1/me/studio/jobs",
    "/api/v1/me/agent/goals", "/api/v1/me/agent/onboarding/turn", "/api/v1/me/mia-preview", "/api/v1/me/rates",
    "/api/v1/athletes/abc/pitches", "/api/card/abc", "/api/v1/me/accounts", "/api/v1/me/exporter", "/api/v1/authx",
    "/api/v1/waitlistx", "/api/v1/me/atmosphere/pick/extra",
  ])("%s is refused", (path) => {
    expect(refuse(path)).toBe(true);
  });
});

describe("who the gate applies to", () => {
  it("only status 'waitlisted'", () => {
    for (const status of ["active", "raw", "enriched", "claimed", null, undefined]) expect(refuse("/api/v1/me/chat", { status })).toBe(false);
  });
  it("admins always pass", () => {
    expect(refuse("/api/v1/me/chat", { roles: ["athlete", "admin"] })).toBe(false);
  });
  it("the in-app agent onboarding stays closed to a waitlisted athlete (the JOIN_WAITLIST join flow is gone)", () => {
    expect(refuse("/api/v1/me/agent/onboarding")).toBe(true);
    expect(refuse("/api/v1/me/agent/onboarding/turn")).toBe(true);
  });
  it("WAITLIST_API_GATE=false turns it off; anything else keeps it on", () => {
    expect(refuse("/api/v1/me/chat", { env: { WAITLIST_API_GATE: "false" } })).toBe(false);
    expect(refuse("/api/v1/me/chat", { env: { WAITLIST_API_GATE: " FALSE " } })).toBe(false);
    expect(waitlistApiGateEnabled({})).toBe(true);
    expect(waitlistApiGateEnabled({ WAITLIST_API_GATE: "true" })).toBe(true);
    expect(waitlistApiGateEnabled({ WAITLIST_API_GATE: "0" })).toBe(true);
  });
});

describe("paths", () => {
  it("drop the query string and trailing slashes", () => {
    expect(gatePath("/api/v1/me/chat?x=1")).toBe("/api/v1/me/chat");
    expect(gatePath("/api/v1/waitlist/")).toBe("/api/v1/waitlist");
    expect(gatePath("")).toBe("/");
    expect(waitlistedMayCall(gatePath("/api/v1/me/export?format=json"))).toBe(true);
  });
});
