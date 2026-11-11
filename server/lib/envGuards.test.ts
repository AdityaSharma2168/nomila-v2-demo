import { checkEnv } from "./envGuards";

const KEYS = ["NODE_ENV", "WEB_APP_URL", "API_BASE_URL", "ALLOWED_ORIGINS", "GMAIL_PUBSUB_TOPIC", "PUBSUB_PUSH_SA"];
const saved: Record<string, string | undefined> = {};

beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** The smallest config production accepts. Tests override one thing at a time. */
function safeProd() {
  process.env.NODE_ENV = "production";
  process.env.WEB_APP_URL = "https://app.example.com";
  process.env.API_BASE_URL = "https://api.example.com";
}

describe("checkEnv", () => {
  it("never throws outside production, even with unsafe values", () => {
    process.env.NODE_ENV = "development";
    expect(() => checkEnv()).not.toThrow();
  });

  it("throws in production when WEB_APP_URL is missing/blank", () => {
    safeProd();
    process.env.WEB_APP_URL = "   ";
    expect(() => checkEnv()).toThrow(/WEB_APP_URL/);
  });

  it("throws in production when API_BASE_URL is missing — no dev-host fallback", () => {
    safeProd();
    delete process.env.API_BASE_URL;
    expect(() => checkEnv()).toThrow(/API_BASE_URL/);
  });

  it("names every fatal problem at once", () => {
    safeProd();
    delete process.env.API_BASE_URL;
    delete process.env.WEB_APP_URL;
    expect(() => checkEnv()).toThrow(/API_BASE_URL[\s\S]*WEB_APP_URL|WEB_APP_URL[\s\S]*API_BASE_URL/);
  });

  it("does not throw on degraded (missing Pub/Sub, missing origins) prod config, but reports gmailPush missing", () => {
    safeProd();
    expect(() => checkEnv()).not.toThrow();
    expect(checkEnv().gmailPush).toBe("missing");
  });

  it("reports gmailPush configured when topic + SA are both set", () => {
    safeProd();
    process.env.GMAIL_PUBSUB_TOPIC = "projects/x/topics/gmail";
    process.env.PUBSUB_PUSH_SA = "push@x.iam.gserviceaccount.com";
    expect(checkEnv()).toEqual({ gmailPush: "configured" });
  });
});
