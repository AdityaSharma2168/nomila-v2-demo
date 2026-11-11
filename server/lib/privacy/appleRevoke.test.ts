/**
 * appleRevoke.test.ts — Sign in with Apple revocation with Apple's REST API faked (never reached): the client secret is
 * a valid ES256 JWT for the app, the code is exchanged and the refresh token revoked, missing config and Apple errors
 * are outcomes (never throws), and no code or token is sent anywhere but appleid.apple.com.
 */
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));

import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { appleClientSecret, appleRevokeConfig, appleRevokeMissingConfig, revokeAppleSignIn, type AppleRevokeConfig } from "./appleRevoke";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const CFG: AppleRevokeConfig = {
  teamId: "TEAM123456", keyId: "KEY1234567", clientId: "co.nomila.app",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

type Call = { url: string; form: Record<string, string> };
function fakeApple(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init.body))) });
    const a = answers.shift() ?? { status: 500 };
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  };
  return { fetch, calls };
}

it("signs an ES256 client secret for the app: iss team, sub bundle id, aud appleid, kid, five minutes", () => {
  const now = 1_800_000_000;
  const token = appleClientSecret(CFG, now);
  const decoded = jwt.verify(token, publicKey.export({ type: "spki", format: "pem" }).toString(), { algorithms: ["ES256"], clockTimestamp: now, complete: true }) as any;
  expect(decoded.header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
  expect(decoded.payload).toMatchObject({ iss: "TEAM123456", sub: "co.nomila.app", aud: "https://appleid.apple.com", iat: now, exp: now + 300 });
});

it("exchanges the code, then revokes the refresh token", async () => {
  const apple = fakeApple([{ status: 200, body: { refresh_token: "r-tok", access_token: "a-tok" } }, { status: 200 }]);
  expect(await revokeAppleSignIn("the-code", { config: CFG, fetch: apple.fetch })).toEqual({ outcome: "revoked" });
  expect(apple.calls.map((c) => c.url)).toEqual(["https://appleid.apple.com/auth/token", "https://appleid.apple.com/auth/revoke"]);
  expect(apple.calls[0].form).toMatchObject({ client_id: "co.nomila.app", code: "the-code", grant_type: "authorization_code" });
  expect(apple.calls[0].form.client_secret.split(".")).toHaveLength(3);
  expect(apple.calls[1].form).toMatchObject({ client_id: "co.nomila.app", token: "r-tok", token_type_hint: "refresh_token" });
});

it("reports an expired or used code as failed, and never calls revoke", async () => {
  const apple = fakeApple([{ status: 400, body: { error: "invalid_grant" } }]);
  expect(await revokeAppleSignIn("old-code", { config: CFG, fetch: apple.fetch })).toEqual({ outcome: "failed", detail: "apple token 400 invalid_grant" });
  expect(apple.calls).toHaveLength(1);
});

it("reports a failed revoke and a network error as failed, never throwing", async () => {
  const apple = fakeApple([{ status: 200, body: { refresh_token: "r" } }, { status: 503 }]);
  expect(await revokeAppleSignIn("c", { config: CFG, fetch: apple.fetch })).toEqual({ outcome: "failed", detail: "apple revoke 503" });
  const down = async () => { throw new Error("ECONNRESET"); };
  expect(await revokeAppleSignIn("c", { config: CFG, fetch: down })).toEqual({ outcome: "failed", detail: "ECONNRESET" });
});

it("without the Apple key config it is not_configured and names the missing env vars (names only)", async () => {
  const env = { APPLE_TEAM_ID: "T" } as unknown as NodeJS.ProcessEnv;
  expect(appleRevokeMissingConfig(env)).toEqual(["APPLE_SIGN_IN_KEY_ID", "APPLE_SIGN_IN_PRIVATE_KEY"]);
  expect(appleRevokeConfig(env)).toBeNull();
  const apple = fakeApple([]);
  const r = await revokeAppleSignIn("c", { config: null, fetch: apple.fetch });
  expect(r.outcome).toBe("not_configured");
  expect(apple.calls).toHaveLength(0);
});

it("reads the key with \\n escapes and defaults the client id to the bundle id", () => {
  const cfg = appleRevokeConfig({ APPLE_TEAM_ID: "T", APPLE_SIGN_IN_KEY_ID: "K", APPLE_SIGN_IN_PRIVATE_KEY: CFG.privateKey.replace(/\n/g, "\\n") } as unknown as NodeJS.ProcessEnv)!;
  expect(cfg.clientId).toBe("co.nomila.app");
  expect(cfg.privateKey).toBe(CFG.privateKey.trim());
  expect(() => appleClientSecret(cfg)).not.toThrow();
});
