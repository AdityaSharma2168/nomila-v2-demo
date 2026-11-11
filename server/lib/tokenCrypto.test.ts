/**
 * tokenCrypto — envelope encryption of OAuth tokens. KMS is the in-memory fake; nothing reaches Cloud KMS.
 */
import {
  __setKmsForTests, decodeEnvelope, decryptToken, dekCacheSize, DEK_CACHE_MAX, DEK_CACHE_TTL_MS,
  encodeEnvelope, encryptToken, ENVELOPE_PREFIX, isSealed, openToken, openTokenFields, sealTokenFields,
  TokenCryptoError, type TokenEnvelope,
} from "./tokenCrypto";
import { createFakeKms, TEST_KMS_KEY, type FakeKms } from "../testUtils/fakeKms";

const PLAIN = "ya29.a0-test-access-token-value-1234567890";
let kms: FakeKms;

beforeEach(() => {
  kms = createFakeKms();
  __setKmsForTests(kms);
  process.env.KMS_TOKEN_KEY = TEST_KMS_KEY;
  delete process.env.TOKEN_KMS;
});
afterAll(() => {
  __setKmsForTests(null);
  delete process.env.KMS_TOKEN_KEY;
  delete process.env.TOKEN_KMS;
});

const flip = (b64: string) => {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0x01;
  return buf.toString("base64");
};

describe("round trip", () => {
  it("encrypts to a v1 envelope and decrypts back", async () => {
    const env = await encryptToken(PLAIN);
    expect(env).toMatchObject({ v: 1, kid: TEST_KMS_KEY });
    expect(Buffer.from(env.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(env.tag, "base64")).toHaveLength(16);
    expect(JSON.stringify(env)).not.toContain(PLAIN);
    expect(await decryptToken(env)).toBe(PLAIN);
    expect(await decryptToken(encodeEnvelope(env))).toBe(PLAIN);
  });

  it("uses a fresh DEK and IV per value", async () => {
    const a = await encryptToken(PLAIN), b = await encryptToken(PLAIN);
    expect(a.dek_wrapped).not.toBe(b.dek_wrapped);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(kms.calls.wrap).toBe(2);
  });

  it("the stored string form is prefixed and carries no plaintext", async () => {
    const s = encodeEnvelope(await encryptToken(PLAIN));
    expect(s.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(isSealed(s)).toBe(true);
    expect(s).not.toContain(PLAIN);
    expect(decodeEnvelope(s).v).toBe(1);
  });
});

describe("tamper detection", () => {
  let env: TokenEnvelope;
  beforeEach(async () => { env = await encryptToken(PLAIN); });

  it.each([
    ["ciphertext", (e: TokenEnvelope) => ({ ...e, ct: flip(e.ct) })],
    ["auth tag",   (e: TokenEnvelope) => ({ ...e, tag: flip(e.tag) })],
    ["iv",         (e: TokenEnvelope) => ({ ...e, iv: flip(e.iv) })],
    ["wrapped DEK", (e: TokenEnvelope) => ({ ...e, dek_wrapped: Buffer.concat([Buffer.from("fake:"), Buffer.alloc(32, 7)]).toString("base64") })],
    ["key id",     (e: TokenEnvelope) => ({ ...e, kid: TEST_KMS_KEY.replace("test-key", "other-key") })],
  ])("an edited %s fails authentication", async (_name, edit) => {
    await expect(decryptToken(edit(env))).rejects.toThrow(TokenCryptoError);
  });

  it("a malformed envelope is refused, and no error message carries the token", async () => {
    await expect(decryptToken({ ...env, v: 2 as any })).rejects.toThrow("malformed");
    await expect(decryptToken(`${ENVELOPE_PREFIX}not-json`)).rejects.toThrow("malformed");
    await expect(decryptToken({ ...env, kid: "https://evil.example/x" })).rejects.toThrow("malformed");
    const err = await decryptToken({ ...env, ct: flip(env.ct) }).catch((e) => e);
    expect(String(err.message)).not.toContain(PLAIN);
  });
});

describe("legacy plain text stays readable", () => {
  it("openToken passes plain text and null through, and opens envelopes", async () => {
    expect(await openToken(PLAIN)).toBe(PLAIN);
    expect(await openToken(null)).toBeNull();
    expect(await openToken(undefined)).toBeUndefined();
    expect(await openToken(encodeEnvelope(await encryptToken(PLAIN)))).toBe(PLAIN);
  });

  it("openTokenFields handles mixed rows and missing rows, without KMS for plain rows", async () => {
    const plainRow = { id: "1", access_token: PLAIN, refresh_token: "1//legacy-refresh" };
    expect(await openTokenFields(plainRow)).toBe(plainRow);
    expect(await openTokenFields(undefined)).toBeUndefined();
    expect(kms.calls.unwrap).toBe(0);

    const mixed = { id: "2", access_token: encodeEnvelope(await encryptToken(PLAIN)), refresh_token: "1//legacy-refresh" };
    expect(await openTokenFields(mixed)).toEqual({ id: "2", access_token: PLAIN, refresh_token: "1//legacy-refresh" });
  });

  it("reads open envelopes even with TOKEN_KMS off (rollback never strands a sealed row)", async () => {
    process.env.TOKEN_KMS = "true";
    const sealed = await sealTokenFields({ access_token: PLAIN });
    process.env.TOKEN_KMS = "false";
    expect(await openToken(sealed.access_token)).toBe(PLAIN);
  });
});

describe("sealTokenFields (the write gate)", () => {
  it("flag off: returns the write unchanged and never calls KMS", async () => {
    const patch = { access_token: PLAIN, refresh_token: "1//r", token_expires_at: null };
    expect(await sealTokenFields(patch)).toBe(patch);
    expect(kms.calls.wrap).toBe(0);
  });

  it("flag on: seals both tokens with ONE KMS call, leaves other fields and empty tokens alone", async () => {
    process.env.TOKEN_KMS = "true";
    const when = new Date();
    const out = await sealTokenFields({ access_token: PLAIN, refresh_token: "1//r", token_expires_at: when });
    expect(isSealed(out.access_token)).toBe(true);
    expect(isSealed(out.refresh_token)).toBe(true);
    expect(out.token_expires_at).toBe(when);
    expect(kms.calls.wrap).toBe(1);
    expect(await openTokenFields(out)).toMatchObject({ access_token: PLAIN, refresh_token: "1//r" });

    const cleared = await sealTokenFields({ access_token: null, refresh_token: null });
    expect(cleared).toEqual({ access_token: null, refresh_token: null });
    const onlyAccess = await sealTokenFields({ access_token: PLAIN });
    expect("refresh_token" in onlyAccess).toBe(false);
  });

  it("flag on without KMS_TOKEN_KEY fails loudly instead of storing plain text", async () => {
    process.env.TOKEN_KMS = "true";
    delete process.env.KMS_TOKEN_KEY;
    await expect(sealTokenFields({ access_token: PLAIN })).rejects.toThrow("KMS_TOKEN_KEY");
    process.env.KMS_TOKEN_KEY = "not-a-key";
    await expect(sealTokenFields({ access_token: PLAIN })).rejects.toThrow("cryptoKey resource name");
  });

  it("an already-sealed value is not sealed twice", async () => {
    process.env.TOKEN_KMS = "true";
    const once = await sealTokenFields({ access_token: PLAIN });
    const twice = await sealTokenFields(once);
    expect(twice.access_token).toBe(once.access_token);
  });
});

describe("DEK cache", () => {
  it("a write's DEK is cached, so reading it back costs no KMS decrypt", async () => {
    const env = await encryptToken(PLAIN);
    await decryptToken(env);
    await decryptToken(env);
    expect(kms.calls.unwrap).toBe(0);
  });

  it("a cold cache unwraps once per DEK, and concurrent reads share the call", async () => {
    const env = await encryptToken(PLAIN);
    __setKmsForTests(kms); // clears the cache
    await Promise.all([decryptToken(env), decryptToken(env), decryptToken(env)]);
    await decryptToken(env);
    expect(kms.calls.unwrap).toBe(1);
  });

  it("entries expire after the TTL", async () => {
    const env = await encryptToken(PLAIN);
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + DEK_CACHE_TTL_MS + 1);
    try {
      await decryptToken(env);
      expect(kms.calls.unwrap).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("is bounded", async () => {
    for (let i = 0; i < DEK_CACHE_MAX + 5; i++) await encryptToken("t");
    expect(dekCacheSize()).toBe(DEK_CACHE_MAX);
  });
});

describe("the real KMS client", () => {
  it("refuses to run under jest", async () => {
    __setKmsForTests(null);
    await expect(encryptToken(PLAIN)).rejects.toThrow("tests must not reach Cloud KMS");
  });
});
