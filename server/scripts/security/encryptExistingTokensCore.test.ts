/**
 * encryptExistingTokensCore — sealing existing tokens and emptying revoked rows. Real SQL on PGlite,
 * the fake KMS; nothing reaches a database server, a provider or Cloud KMS.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { connectedAccounts } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { __setKmsForTests, encodeEnvelope, encryptToken, isSealed, openToken } from "../../lib/tokenCrypto";
import { createFakeKms, TEST_KMS_KEY, type FakeKms } from "../../testUtils/fakeKms";
import { countTokens, runEncryptExistingTokens } from "./encryptExistingTokensCore";

let kms: FakeKms;
const ids: Record<string, string> = {};
const SECRET = (k: string) => `tok-${k}-SECRETVALUE-0123456789`;
const SECRETS: string[] = [];

async function seed(key: string, status: string, access: string | null, refresh: string | null, platform = "gmail") {
  const athleteId = await seedAthlete(`Tokens ${key}`);
  const id = await seedConnection({ athleteId, platform, status: status === "revoked" ? "active" : status });
  await db.update(connectedAccounts).set({ status, access_token: access, refresh_token: refresh }).where(eq(connectedAccounts.id, id));
  ids[key] = id;
  for (const v of [access, refresh]) if (v) SECRETS.push(v);
}

const snapshot = async () =>
  (await db.select().from(connectedAccounts).orderBy(connectedAccounts.id)).map((r) => JSON.stringify(r));
const row = async (k: string) =>
  (await db.select({ a: connectedAccounts.access_token, r: connectedAccounts.refresh_token })
    .from(connectedAccounts).where(eq(connectedAccounts.id, ids[k])))[0];

beforeAll(async () => {
  await initTestDb();
  process.env.KMS_TOKEN_KEY = TEST_KMS_KEY;
  kms = createFakeKms();
  __setKmsForTests(kms);
  await seed("active", "active", SECRET("a1"), SECRET("r1"));
  await seed("expired", "expired", SECRET("a2"), null, "outlook");
  await seed("sealed", "active", encodeEnvelope(await encryptToken(SECRET("a3"))), null, "instagram");
  await seed("revokedIg1", "revoked", SECRET("a4"), null, "instagram");
  await seed("revokedIg2", "revoked", SECRET("a5"), SECRET("r5"), "instagram");
  await seed("empty", "revoked", null, null);
  kms.calls.wrap = 0;
});
afterAll(async () => {
  __setKmsForTests(null);
  delete process.env.KMS_TOKEN_KEY;
  await closeTestDb();
});

describe("dry run", () => {
  it("counts, writes nothing, never calls KMS, and never logs token material", async () => {
    const before = await snapshot();
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      const code = await runEncryptExistingTokens(db, { apply: false, log: (l) => lines.push(l) });
      expect(code).toBe(0);
      const consoleOut = spies.flatMap((s) => s.mock.calls.map((c) => c.join(" ")));
      const everything = [...lines, ...consoleOut].join("\n");
      for (const s of SECRETS) expect(everything).not.toContain(s);
      expect(everything).not.toContain("kms1:");
      expect(everything).not.toContain("SECRETVALUE");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(lines.join("\n")).toContain("DRY-RUN");
    expect(await snapshot()).toEqual(before);
    expect(kms.calls.wrap).toBe(0);
    expect(kms.calls.unwrap).toBe(0);
  });

  it("counts what --apply would do", async () => {
    expect(await countTokens(db)).toMatchObject({
      plainLiveRows: 2, plainAccess: 2, plainRefresh: 1, sealedRows: 1, revokedWithTokens: 2,
    });
  });
});

describe("--apply", () => {
  it("seals plain tokens on live rows and empties revoked rows; the log stays free of tokens", async () => {
    const lines: string[] = [];
    const code = await runEncryptExistingTokens(db, { apply: true, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    for (const s of SECRETS) expect(lines.join("\n")).not.toContain(s);

    const active = await row("active");
    expect(isSealed(active.a) && isSealed(active.r)).toBe(true);
    expect(await openToken(active.a)).toBe(SECRET("a1"));
    expect(await openToken(active.r)).toBe(SECRET("r1"));

    const expired = await row("expired");
    expect(isSealed(expired.a)).toBe(true);
    expect(expired.r).toBeNull();

    expect(await row("revokedIg1")).toEqual({ a: null, r: null });
    expect(await row("revokedIg2")).toEqual({ a: null, r: null });
    expect(await openToken((await row("sealed")).a)).toBe(SECRET("a3"));

    expect(await countTokens(db)).toMatchObject({ plainLiveRows: 0, revokedWithTokens: 0, sealedRows: 3 });
  });

  it("is idempotent: a second run seals nothing and calls KMS zero times", async () => {
    const sealedSealed = await row("sealed");
    kms.calls.wrap = 0;
    await runEncryptExistingTokens(db, { apply: true, log: () => {} });
    expect(kms.calls.wrap).toBe(0);
    expect(await row("sealed")).toEqual(sealedSealed);
  });

  it("skips a row whose token changed mid-run (compare-and-set)", async () => {
    await seed("racy", "active", SECRET("a6"), null);
    const lines: string[] = [];
    await runEncryptExistingTokens(db, {
      apply: true,
      log: (l) => lines.push(l),
      seal: async (patch) => {
        // A refresh lands between the read and the write.
        await db.update(connectedAccounts).set({ access_token: "refreshed-plain" }).where(eq(connectedAccounts.id, ids.racy));
        return { ...patch, access_token: encodeEnvelope(await encryptToken(String(patch.access_token))) };
      },
    });
    expect((await row("racy")).a).toBe("refreshed-plain");
    expect(lines.join("\n")).toContain("1 skipped");
  });
});
