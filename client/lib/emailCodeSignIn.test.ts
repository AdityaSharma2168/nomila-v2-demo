/**
 * emailCodeSignIn.test — the email code's two calls turned into the front's outcomes (fetch injected; no network), and
 * the small rules: the address check matches the server's, a pasted code keeps its digits, the countdown and the wait.
 * "Sent" is only ever a 202: every other answer, and no answer, is not.
 */
jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test" }));
import { codeDigits, countdown, looksLikeEmail, minutesToWait, startEmailCode, verifyEmailCode } from "./emailCodeSignIn";

const reply = (status: number, body: unknown) => jest.fn(async () => ({ status, json: async () => body }) as unknown as Response);

describe("start", () => {
  it("posts the normalised address to /auth/email-code/start", async () => {
    const f = reply(202, { resendAfterSec: 60 });
    expect(await startEmailCode("  Jordan.Lee@Example.com ", f)).toEqual({ kind: "sent", resendAfterSec: 60 });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/auth/email-code/start");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "jordan.lee@example.com" });
  });

  it("maps every refusal, and never says sent when nothing was sent", async () => {
    expect(await startEmailCode("a@b.co", reply(429, { error: "too_soon", retryAfterSec: 42 }))).toEqual({ kind: "too_soon", retryAfterSec: 42 });
    expect(await startEmailCode("a@b.co", reply(429, { error: "too_many", retryAfterSec: 3000 }))).toEqual({ kind: "too_many", retryAfterSec: 3000 });
    // the per-IP limiter answers 429 without a wait: the design's 15 minutes
    expect(await startEmailCode("a@b.co", reply(429, { error: "too_many" }))).toEqual({ kind: "too_many", retryAfterSec: 900 });
    expect(await startEmailCode("a@b.co", reply(400, { error: "invalid_email" }))).toEqual({ kind: "invalid" });
    expect(await startEmailCode("a@b.co", reply(503, { error: "busy" }))).toEqual({ kind: "busy" });
    for (const [status, body] of [[503, { error: "email_unavailable" }], [503, { error: "send_failed" }], [500, {}], [404, {}], [200, {}]] as const) {
      expect(await startEmailCode("a@b.co", reply(status, body))).toEqual({ kind: "failed" });
    }
    expect(await startEmailCode("a@b.co", jest.fn(async () => { throw new Error("offline"); }))).toEqual({ kind: "failed" });
  });
});

describe("verify", () => {
  it("posts the address and the code; a match carries the custom token", async () => {
    const f = reply(200, { customToken: "tok" });
    expect(await verifyEmailCode("A@B.co", "482913", f)).toEqual({ kind: "ok", customToken: "tok" });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/auth/email-code/verify");
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@b.co", code: "482913" });
  });

  it("wrong (with the tries left), expired, locked; anything else is a failure", async () => {
    expect(await verifyEmailCode("a@b.co", "1", reply(400, { error: "wrong_code", triesLeft: 2 }))).toEqual({ kind: "wrong", triesLeft: 2 });
    expect(await verifyEmailCode("a@b.co", "1", reply(410, { error: "expired" }))).toEqual({ kind: "expired" });
    expect(await verifyEmailCode("a@b.co", "1", reply(423, { error: "locked" }))).toEqual({ kind: "locked" });
    expect(await verifyEmailCode("a@b.co", "1", reply(403, { error: "account_disabled" }))).toEqual({ kind: "failed" });
    expect(await verifyEmailCode("a@b.co", "1", reply(200, {}))).toEqual({ kind: "failed" });
    expect(await verifyEmailCode("a@b.co", "1", jest.fn(async () => { throw new Error("offline"); }))).toEqual({ kind: "failed" });
  });
});

describe("rules", () => {
  it("the address check is the server's", () => {
    for (const ok of ["jordan.lee@gmail.com", " a@b.co ", "x+tag@sub.example.org"]) expect(looksLikeEmail(ok)).toBe(true);
    for (const bad of ["", "jordan.lee@gmail", "no-at.example.com", "a b@example.com", "a@@b.co", `${"a".repeat(250)}@b.co`]) expect(looksLikeEmail(bad)).toBe(false);
  });

  it("a pasted code keeps its first six digits", () => {
    expect(codeDigits("482 913")).toBe("482913");
    expect(codeDigits("Code: 4829131")).toBe("482913");
    expect(codeDigits("48a2")).toBe("482");
  });

  it("countdown and minutes", () => {
    expect([countdown(42), countdown(60), countdown(0), countdown(-3), countdown(125)]).toEqual(["0:42", "1:00", "0:00", "0:00", "2:05"]);
    expect([minutesToWait(900), minutesToWait(901), minutesToWait(5), minutesToWait(0)]).toEqual([15, 16, 1, 1]);
  });
});
