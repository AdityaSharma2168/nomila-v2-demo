/**
 * params.test.ts — the parameter store's rules, against a real (PGlite) Postgres.
 *
 * Pins: drafts are invisible to the active lookup; one active row per family is enforced by
 * the DATABASE (not by application care); activation is atomic and deliberate; a version is
 * immutable on re-insert; the hash is key-order-insensitive; unknown families are refused.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { modelParams } from "../../../shared/schema";
import { activateParams, canonicalJson, getActiveParams, hashConfig, insertDraftParams, listParams, ParamsError } from "./params";

beforeAll(async () => { await initTestDb(); });
afterAll(closeTestDb);

describe("hashConfig", () => {
  it("is key-order-insensitive and 12 hex chars", () => {
    const a = hashConfig({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = hashConfig({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("insertDraftParams", () => {
  it("writes a draft with hash and schema version; a version is immutable", async () => {
    const first = await insertDraftParams({ family: "research_freshness", version: "v0.1-alpha", schemaVersion: "research-freshness-config/1", config: { press_days: 30 }, note: "test" });
    expect(first.created).toBe(true);
    expect(first.row.status).toBe("draft");
    expect(first.row.schema_version).toBe("research-freshness-config/1");
    expect(first.row.hash).toBe(hashConfig({ press_days: 30 }));

    // Same version, same config → the existing row comes back (a re-seed is a no-op).
    const again = await insertDraftParams({ family: "research_freshness", version: "v0.1-alpha", schemaVersion: "research-freshness-config/1", config: { press_days: 30 } });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    // Same version, different config or schema version → refused. A version is immutable.
    await expect(insertDraftParams({ family: "research_freshness", version: "v0.1-alpha", schemaVersion: "research-freshness-config/1", config: { press_days: 999 } })).rejects.toThrow(/immutable/);
    await expect(insertDraftParams({ family: "research_freshness", version: "v0.1-alpha", schemaVersion: "research-freshness-config/2", config: { press_days: 30 } })).rejects.toThrow(/immutable/);
    const [row] = await db.select().from(modelParams).where(eq(modelParams.id, first.row.id));
    expect(row.config).toEqual({ press_days: 30 });
  });

  it("refuses an unknown family and a missing schema version", async () => {
    await expect(insertDraftParams({ family: "vibes" as any, version: "v1", schemaVersion: "x/1", config: {} })).rejects.toBeInstanceOf(ParamsError);
    await expect(insertDraftParams({ family: "rates", version: "v1", schemaVersion: "", config: {} })).rejects.toBeInstanceOf(ParamsError);
  });
});

describe("getActiveParams / activateParams", () => {
  it("never returns a draft; activation is explicit and atomic; one active per family", async () => {
    await insertDraftParams({ family: "marketability", version: "v1.0-beta.1", schemaVersion: "marketability-config/1", config: { weights: { momentum: 0.1 } } });
    await insertDraftParams({ family: "marketability", version: "v1.0-beta.2", schemaVersion: "marketability-config/1", config: { weights: { momentum: 0.2 } } });
    expect(await getActiveParams("marketability")).toBeNull();

    const active = await activateParams("marketability", "v1.0-beta.1");
    expect(active.status).toBe("active");
    expect(active.activated_at).toBeTruthy();
    expect((await getActiveParams("marketability"))?.version).toBe("v1.0-beta.1");

    // Swapping to the next version deactivates the old one in the same transaction.
    await activateParams("marketability", "v1.0-beta.2");
    const rows = await listParams("marketability");
    expect(rows.map((r) => [r.version, r.status]).sort()).toEqual([["v1.0-beta.1", "inactive"], ["v1.0-beta.2", "active"]]);
    expect((await getActiveParams("marketability"))?.version).toBe("v1.0-beta.2");

    // Activating the already-active version is a no-op.
    expect((await activateParams("marketability", "v1.0-beta.2")).version).toBe("v1.0-beta.2");
  });

  it("the database itself refuses a second active row per family", async () => {
    await insertDraftParams({ family: "priors", version: "a", schemaVersion: "priors-config/1", config: {} });
    await insertDraftParams({ family: "priors", version: "b", schemaVersion: "priors-config/1", config: {} });
    await activateParams("priors", "a");
    // Bypass the helper on purpose: this is the partial unique index doing the work.
    await expect(
      db.update(modelParams).set({ status: "active" }).where(eq(modelParams.version, "b")),
    ).rejects.toThrow();
  });

  it("refuses unknown and archived versions", async () => {
    await expect(activateParams("rates", "nope")).rejects.toBeInstanceOf(ParamsError);
    await insertDraftParams({ family: "rates", version: "old", schemaVersion: "rates-config/1", config: {} });
    await db.update(modelParams).set({ status: "archived" }).where(eq(modelParams.version, "old"));
    await expect(activateParams("rates", "old")).rejects.toBeInstanceOf(ParamsError);
  });

  it("a family with no rows in another family's status is unaffected", async () => {
    expect(await getActiveParams("earnings")).toBeNull();
    expect(await listParams("earnings")).toEqual([]);
  });
});
