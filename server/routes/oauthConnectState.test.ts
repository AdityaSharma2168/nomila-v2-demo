/**
 * oauthConnectState.test.ts — the OAuth connect state is single-use and bound to the browser that started it
 * (lib/oauthConnectState.ts), through the real connect route (POST /me/connect/:platform) and the real callback, on
 * Express + PGlite. The provider is mocked at the registry: getAuthUrl builds a URL with the real signed state,
 * handleCallback is a mock, so nothing is reached.
 *
 *   O1 happy path (browser): the connect response sets an HttpOnly, Secure, SameSite=Lax cookie on the callback path;
 *      the callback carrying it connects once
 *   O2 replay: the same state a second time is refused, the provider is not called again
 *   O3 missing or mismatched cookie: refused, and the row stays usable by the starting browser (a victim opening the
 *      starter's link cannot attach her account to the starter's athlete)
 *   O4 the landing's returnOrigin behaviour is kept: a landing connect returns to the landing page
 *   O5 a signed state that was never recorded (or another athlete's / platform's) is refused
 *   O6 native (no clientPlatform): no cookie; the state is accepted once, a replay is refused
 *   O7 the error page shows a fixed message, never the provider's ?error= text
 */
process.env.SESSION_SECRET = "test-session-secret";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/auth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); } }));
const handleCallback = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/integrations/registry", () => {
  const { signOAuthState } = jest.requireActual("../lib/oauthState");
  const provider = {
    getAuthUrl: (athleteId: string, alias?: string, _hint?: string, clientPlatform?: string) =>
      `https://provider.example/authorize?state=${encodeURIComponent(signOAuthState(athleteId, alias, clientPlatform))}`,
    handleCallback: (...a: unknown[]) => handleCallback(...a),
  };
  return { OAUTH: { instagram: provider, gmail: provider }, INBOX: {} };
});
jest.setTimeout(120_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { signOAuthState } from "../lib/oauthState";
import connectionsRouter from "./connections";
import oauthCallbackRouter, { PROVIDER_ERROR_MESSAGE } from "./oauthCallback";

let server: Server; let base = "";

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json());
  app.use("/api/v1/me", connectionsRouter);
  app.use("/api/v1/auth", oauthCallbackRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { handleCallback.mockClear(); delete process.env.OAUTH_BROWSER_BINDING; });

/** Start a connect as `athleteId`; returns the state the provider would echo and the binding cookie (name=value), if any. */
async function start(athleteId: string, body: Record<string, unknown>, platform = "instagram") {
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me/connect/${platform}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  const { redirectUrl } = await r.json() as { redirectUrl: string };
  const setCookie = r.headers.get("set-cookie");
  return { state: new URL(redirectUrl).searchParams.get("state")!, setCookie, cookie: setCookie ? setCookie.split(";")[0] : null };
}
const callback = (state: string, cookie?: string | null, platform = "instagram", extra = "code=abc") =>
  fetch(`${base}/api/v1/auth/callback/${platform}?${extra}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

test("O1 + O2: a browser connect sets the binding cookie, connects once with it, and a replay is refused", async () => {
  const a = await seedAthlete("Web Connector");
  const { state, setCookie, cookie } = await start(a, { clientPlatform: "web" });
  expect(setCookie).toMatch(/^nomila_oauth_instagram=[A-Za-z0-9_-]{20,};/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/v1/auth/callback", "Max-Age=600"]) expect(setCookie).toContain(attr);
  expect(setCookie).not.toMatch(/Domain=/i);                                                    // host-only: the API host

  const ok = await callback(state, cookie);
  expect(ok.status).toBe(302);
  expect(ok.headers.get("location")).toMatch(/\/\?connected=instagram$/);
  expect(handleCallback).toHaveBeenCalledTimes(1);
  expect(handleCallback.mock.calls[0][1]).toBe(a);

  const replay = await callback(state, cookie);
  expect(replay.headers.get("location")).toMatch(/\/\?connected_error=instagram$/);
  expect(handleCallback).toHaveBeenCalledTimes(1);
});

test("O3: a missing or mismatched cookie is refused, and the starting browser can still finish", async () => {
  const a = await seedAthlete("Starter");
  const { state, cookie } = await start(a, { clientPlatform: "web" });
  const missing = await callback(state, null);                                                  // the victim's browser: no cookie
  expect(missing.headers.get("location")).toMatch(/connected_error=instagram/);
  const wrong = await callback(state, "nomila_oauth_instagram=not-the-one");
  expect(wrong.headers.get("location")).toMatch(/connected_error=instagram/);
  const other = await start(await seedAthlete("Someone Else"), { clientPlatform: "web" });        // a real cookie, another connect
  expect((await callback(state, other.cookie)).headers.get("location")).toMatch(/connected_error=instagram/);
  expect(handleCallback).not.toHaveBeenCalled();
  expect((await callback(state, cookie)).headers.get("location")).toMatch(/\?connected=instagram$/);
  expect(handleCallback).toHaveBeenCalledTimes(1);
});

test("O4: a landing connect (allowlisted returnOrigin) still returns to the landing page", async () => {
  const a = await seedAthlete("Landing Connector");
  const { state, cookie } = await start(a, { clientPlatform: "web", returnOrigin: "https://nomila.co" });
  expect(cookie).toBeTruthy();
  const r = await callback(state, cookie);
  expect(r.headers.get("location")).toBe("https://nomila.co/?connected=instagram");
});

test("O5: a signed state never recorded, or recorded for another athlete or platform, is refused", async () => {
  const a = await seedAthlete("Unrecorded");
  const r = await callback(signOAuthState(a));                                                  // valid signature, no row
  expect(r.status).toBe(400);
  const { state } = await start(a, {}, "gmail");                                                // recorded for gmail …
  expect((await callback(state, null, "instagram")).status).toBe(400);                          // … not for instagram
  expect(handleCallback).not.toHaveBeenCalled();
});

test("O6: a native connect sets no cookie; its state is accepted once", async () => {
  const a = await seedAthlete("Native Connector");
  const { state, setCookie } = await start(a, {});
  expect(setCookie).toBeNull();
  expect((await callback(state)).status).toBe(200);
  expect((await callback(state)).status).toBe(400);
  expect(handleCallback).toHaveBeenCalledTimes(1);
});

test("O7: the error page shows a fixed message, never the provider's error text", async () => {
  const a = await seedAthlete("Error Page");
  const { state } = await start(a, {});
  const r = await callback(state, null, "instagram", `error=${encodeURIComponent("<b>evil</b> phish text")}`);
  const html = await r.text();
  expect(r.status).toBe(400);
  expect(html).toContain("The connection was cancelled or not allowed.");
  expect(html).not.toContain("phish");
  expect(PROVIDER_ERROR_MESSAGE).toMatch(/try connecting again/);
});
