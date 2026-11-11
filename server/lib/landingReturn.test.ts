/**
 * landingReturn.test — a web connect started from the landing page returns to the landing page, never anywhere else.
 *
 *   - only allowlisted origins (nomila.co, www.nomila.co; localhost outside production) are accepted, exact match
 *   - the OAuth callback redirects a landing state to <origin>/?connected=<platform>, other web states to WEB_APP_URL
 *   - an unlisted origin is dropped at the connect route, so it never reaches the state (no open redirect)
 *
 * No provider is reached: the registry is mocked and handleCallback returns no connection (no background work).
 */
process.env.SESSION_SECRET = "test-session-secret";

jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const handleCallback = jest.fn().mockResolvedValue(undefined);
// The single-use, browser-bound state check (oauthConnectState.ts) has its own suite (routes/oauthConnectState.test.ts).
jest.mock("./oauthConnectState", () => ({ consumeConnectState: jest.fn(async () => "ok"), clearBindingCookie: () => {} }));
jest.mock("./integrations/registry", () => ({
  OAUTH: { instagram: { handleCallback: (...a: unknown[]) => handleCallback(...a) } },
  INBOX: {},
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedLandingOrigin, landingOriginOf, withLandingReturn } from "./landingReturn";
import { signOAuthState } from "./oauthState";
import oauthCallbackRouter from "../routes/oauthCallback";

describe("allowlist", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = env; });

  it("accepts only the exact landing origins", () => {
    expect(allowedLandingOrigin("https://nomila.co")).toBe("https://nomila.co");
    expect(allowedLandingOrigin("https://www.nomila.co")).toBe("https://www.nomila.co");
    for (const bad of ["http://nomila.co", "https://nomila.co/", "https://nomila.co.evil.com", "https://evil.com", "https://evil.com#https://nomila.co",
      "https://nomila.co:444", "//nomila.co", "javascript:alert(1)", "", null, undefined, 42]) {
      expect(allowedLandingOrigin(bad)).toBeNull();
    }
  });

  it("accepts localhost only outside production", () => {
    process.env.NODE_ENV = "test";
    expect(allowedLandingOrigin("http://localhost:8000")).toBe("http://localhost:8000");
    expect(allowedLandingOrigin("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(allowedLandingOrigin("http://localhost.evil.com")).toBeNull();
    process.env.NODE_ENV = "production";
    expect(allowedLandingOrigin("http://localhost:8000")).toBeNull();
    expect(allowedLandingOrigin("https://nomila.co")).toBe("https://nomila.co");
  });

  it("only a web connect with an allowed origin becomes a landing return", () => {
    expect(withLandingReturn("web", "https://nomila.co")).toBe("landing:https://nomila.co");
    expect(withLandingReturn("web", "https://evil.com")).toBe("web");
    expect(withLandingReturn("web", undefined)).toBe("web");
    expect(withLandingReturn(undefined, "https://nomila.co")).toBeUndefined();   // native stays native
    expect(landingOriginOf("landing:https://www.nomila.co")).toBe("https://www.nomila.co");
    expect(landingOriginOf("landing:https://evil.com")).toBeNull();               // re-checked at the callback
    expect(landingOriginOf("web")).toBeNull();
  });
});

describe("OAuth callback return", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const app = express();
    app.use("/", oauthCallbackRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const callback = (state: string, extra = "code=abc") =>
    fetch(`${base}/callback/instagram?${extra}&state=${encodeURIComponent(state)}`, { redirect: "manual" });

  it("a landing connect returns to the landing page", async () => {
    const r = await callback(signOAuthState("ath-1", undefined, withLandingReturn("web", "https://nomila.co")));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://nomila.co/?connected=instagram");
  });

  it("a landing connect that fails returns to the landing page with connected_error", async () => {
    const r = await callback(signOAuthState("ath-1", undefined, "landing:https://www.nomila.co"), "error=access_denied");
    expect(r.headers.get("location")).toBe("https://www.nomila.co/?connected_error=instagram");
  });

  it("any other web connect still returns to the app", async () => {
    const r = await callback(signOAuthState("ath-1", undefined, "web"));
    const loc = r.headers.get("location") ?? "";
    expect(loc.endsWith("/?connected=instagram")).toBe(true);
    expect(loc).not.toContain("nomila.co");
  });

  it("a signed state carrying an unlisted origin never redirects there", async () => {
    const r = await callback(signOAuthState("ath-1", undefined, "landing:https://evil.com"));
    expect(r.headers.get("location") ?? "").not.toContain("evil.com");
  });
});
