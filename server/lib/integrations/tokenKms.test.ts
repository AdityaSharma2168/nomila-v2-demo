/**
 * TOKEN_KMS through the real write and read paths — activateConnection (every provider's callback),
 * Gmail's refresh read, and Outlook's rotating refresh token (read sealed → refresh → re-store sealed).
 * PGlite for connected_accounts, the fake KMS, global fetch mocked: no provider or KMS is reached.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { connectedAccounts } from "../../../shared/schema";
import { __setKmsForTests, isSealed, openToken, sealTokenFields } from "../tokenCrypto";
import { createFakeKms, TEST_KMS_KEY, type FakeKms } from "../../testUtils/fakeKms";
import { activateConnection } from "./activateConnection";

const ACCESS  = "ya29.test-access-token-abcdefghijklmnop";
const REFRESH = "1//test-refresh-token-abcdefghijklmnop";

let kms: FakeKms;
let athleteId: string;
let gmailRefresh: (id: string) => Promise<string>;
let outlookAccess: (id: string) => Promise<string>;
const realFetch = global.fetch;

const stored = async (id: string) =>
  (await db.select({ a: connectedAccounts.access_token, r: connectedAccounts.refresh_token })
    .from(connectedAccounts).where(eq(connectedAccounts.id, id)))[0];

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Token KMS");
  process.env.KMS_TOKEN_KEY = TEST_KMS_KEY;
  process.env.MICROSOFT_CLIENT_ID = "test-ms-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-ms-secret";
  ({ refreshTokenIfNeeded: gmailRefresh } = await import("./gmail"));
  ({ getAccessToken: outlookAccess } = await import("./outlook"));
});
afterAll(async () => {
  global.fetch = realFetch;
  __setKmsForTests(null);
  delete process.env.TOKEN_KMS;
  delete process.env.KMS_TOKEN_KEY;
  await closeTestDb();
});
beforeEach(() => {
  kms = createFakeKms();
  __setKmsForTests(kms);
  delete process.env.TOKEN_KMS;
  global.fetch = jest.fn(async () => { throw new Error("unexpected network call"); }) as any;
});

const activate = (platformUserId: string) => activateConnection({
  athleteId, platform: "gmail", platformUserId, platformUsername: "a@example.com",
  accessToken: ACCESS, refreshToken: REFRESH, tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: "s",
});

describe("activateConnection", () => {
  it("TOKEN_KMS off: stores the tokens exactly as before", async () => {
    const { connectionId } = await activate("google-sub-off");
    expect(await stored(connectionId)).toEqual({ a: ACCESS, r: REFRESH });
    expect(kms.calls.wrap).toBe(0);
  });

  it("TOKEN_KMS on: stores sealed envelopes that open to the tokens", async () => {
    process.env.TOKEN_KMS = "true";
    const { connectionId } = await activate("google-sub-on");
    const row = await stored(connectionId);
    expect(isSealed(row.a)).toBe(true);
    expect(isSealed(row.r)).toBe(true);
    expect(row.a).not.toContain(ACCESS);
    expect(await openToken(row.a)).toBe(ACCESS);
    expect(await openToken(row.r)).toBe(REFRESH);
    expect(kms.calls.wrap).toBe(1);
  });

  it("TOKEN_KMS on: a reconnect of the same account re-stores sealed", async () => {
    process.env.TOKEN_KMS = "true";
    const first = await activate("google-sub-again");
    const again = await activate("google-sub-again");
    expect(again.connectionId).toBe(first.connectionId);
    expect(isSealed((await stored(again.connectionId)).a)).toBe(true);
  });
});

describe("Gmail read path", () => {
  it("returns the plaintext token from a sealed row (no refresh needed)", async () => {
    const id = await seedConnection({ athleteId, platform: "gmail" });
    process.env.TOKEN_KMS = "true";
    const sealed = await sealTokenFields({ access_token: ACCESS });
    await db.update(connectedAccounts).set(sealed).where(eq(connectedAccounts.id, id));
    expect(await gmailRefresh(id)).toBe(ACCESS);
  });

  it("still returns a legacy plain-text token with the flag on", async () => {
    process.env.TOKEN_KMS = "true";
    const id = await seedConnection({ athleteId, platform: "gmail" });
    expect(await gmailRefresh(id)).toBe("test-access-token");
  });
});

describe("Outlook rotating refresh token", () => {
  it("reads the sealed refresh token, refreshes, and re-stores BOTH new tokens sealed", async () => {
    process.env.TOKEN_KMS = "true";
    const id = await seedConnection({ athleteId, platform: "outlook" });
    await db.update(connectedAccounts).set({
      ...(await sealTokenFields({ access_token: "old-access", refresh_token: REFRESH })),
      token_expires_at: new Date(Date.now() - 60_000),
    }).where(eq(connectedAccounts.id, id));

    let sentRefresh: string | null = null;
    global.fetch = jest.fn(async (_url: any, init: any) => {
      sentRefresh = new URLSearchParams(String(init.body)).get("refresh_token");
      return { ok: true, status: 200, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) } as any;
    }) as any;

    expect(await outlookAccess(id)).toBe("new-access");
    expect(sentRefresh).toBe(REFRESH); // the provider got the decrypted token, not the envelope
    const row = await stored(id);
    expect(isSealed(row.a) && isSealed(row.r)).toBe(true);
    expect(await openToken(row.a)).toBe("new-access");
    expect(await openToken(row.r)).toBe("new-refresh");
  });

  it("keeps (and seals) the old refresh token when the provider does not rotate it", async () => {
    process.env.TOKEN_KMS = "true";
    const id = await seedConnection({ athleteId, platform: "outlook" });
    await db.update(connectedAccounts).set({ refresh_token: REFRESH, token_expires_at: new Date(Date.now() - 60_000) })
      .where(eq(connectedAccounts.id, id)); // legacy plain text
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "new-access-2", expires_in: 3600 }) })) as any;

    expect(await outlookAccess(id)).toBe("new-access-2");
    const row = await stored(id);
    expect(isSealed(row.r)).toBe(true);
    expect(await openToken(row.r)).toBe(REFRESH);
  });
});
