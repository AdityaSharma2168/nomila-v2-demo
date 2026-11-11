/**
 * revokeGrantForDeletion — the per-provider revoke on account deletion. fetch is mocked: no provider is reached.
 * Covers TikTok (POST /v2/oauth/revoke/) and that a sealed token is opened before it is sent anywhere.
 */

jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const openTokenFields = jest.fn(async (row: any) => row);
jest.mock("../tokenCrypto", () => ({ openTokenFields: (row: any) => openTokenFields(row) }));

import { revokeGrantForDeletion } from "./revokeGrants";

const fetchMock = jest.fn();
const realFetch = global.fetch;
const ENV = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  fetchMock.mockReset();
  openTokenFields.mockClear();
  (global as any).fetch = fetchMock;
  for (const k of ENV) saved[k] = process.env[k];
  process.env.TIKTOK_CLIENT_KEY = "ck";
  process.env.TIKTOK_CLIENT_SECRET = "cs";
});
afterEach(() => {
  (global as any).fetch = realFetch;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const tiktok = { id: "c1", platform: "tiktok", access_token: "act.123", refresh_token: "rft.456" };

describe("revokeGrantForDeletion — tiktok", () => {
  it("POSTs client_key, client_secret and the access token to TikTok's revoke endpoint", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    expect(await revokeGrantForDeletion(tiktok)).toEqual({ connection_id: "c1", platform: "tiktok", outcome: "revoked" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/revoke/");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ client_key: "ck", client_secret: "cs", token: "act.123" });
  });

  it("reports failed when TikTok answers with an error body or a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_request", error_description: "x" }), { status: 200 }));
    expect((await revokeGrantForDeletion(tiktok)).outcome).toBe("failed");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await revokeGrantForDeletion(tiktok)).toMatchObject({ outcome: "failed", detail: "tiktok revoke 500" });
  });

  it("treats the v2 envelope's error code 'ok' as success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "ok", message: "" } }), { status: 200 }));
    expect((await revokeGrantForDeletion(tiktok)).outcome).toBe("revoked");
  });

  it("does not call TikTok without a token or without client credentials", async () => {
    expect((await revokeGrantForDeletion({ ...tiktok, access_token: null })).outcome).toBe("no_token");
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect((await revokeGrantForDeletion(tiktok)).outcome).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: a network error is a failed outcome", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    expect(await revokeGrantForDeletion(tiktok)).toMatchObject({ outcome: "failed", detail: "ECONNRESET" });
  });
});

describe("revokeGrantForDeletion — sealed tokens", () => {
  it("opens the stored tokens before sending them (Google revoke gets the plain refresh token)", async () => {
    openTokenFields.mockImplementationOnce(async () => ({ access_token: "plain-access", refresh_token: "plain-refresh" }));
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    const r = await revokeGrantForDeletion({ id: "g1", platform: "gmail", access_token: "kms1:aaa", refresh_token: "kms1:bbb" });
    expect(r.outcome).toBe("revoked");
    expect(openTokenFields).toHaveBeenCalledWith({ access_token: "kms1:aaa", refresh_token: "kms1:bbb" });
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).get("token")).toBe("plain-refresh");
  });

  it("reports failed (and sends nothing) when a sealed token cannot be opened", async () => {
    openTokenFields.mockImplementationOnce(async () => { throw new Error("token could not be decrypted"); });
    const r = await revokeGrantForDeletion({ id: "g1", platform: "gmail", access_token: "kms1:aaa", refresh_token: null });
    expect(r.outcome).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
