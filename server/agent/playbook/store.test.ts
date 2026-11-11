/**
 * store.test.ts — the shared content playbook's store (content_playbooks, migration 0125), against a real (PGlite)
 * Postgres. Same pins as server/services/intelligence/params.test.ts (model_params), keyed by
 * (sport, stage, platform) instead of a single `family`: drafts are invisible to the active lookup; one active row
 * per key is enforced by the DATABASE; activation is atomic and deliberate; a version is immutable on re-insert; the
 * hash is key-order-insensitive; an unknown stage is refused.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { contentPlaybooks } from "../../../shared/schema";
import type { PlaybookConfig, PlaybookKey } from "../../../shared/playbook";
import { activatePlaybook, canonicalJson, FAILURE_VERSION_PREFIX, getActivePlaybook, getLatestPlaybookRow, hashConfig, insertDraftPlaybook, listPlaybookVersions, PlaybookStoreError, recordPlaybookFailure } from "./store";

beforeAll(async () => { await initTestDb(); });
afterAll(closeTestDb);

const config = (postsPerWeek = { min: 2, max: 4 }): PlaybookConfig => ({
  formats: [{ name: "a short vertical video", postFormat: "reel", whenToUse: "the default for this platform" }],
  hooks: ["ask a question the viewer already has an opinion on"],
  idealLengthSec: { min: 8, max: 25 },
  cadence: { postsPerWeek },
  crossPlatformReuse: [],
  sources: [],
  refreshedAt: "2026-10-01",
});

const keyA: PlaybookKey = { sport: "rowing", stage: "developing", platform: "instagram" };
const keyB: PlaybookKey = { sport: "rowing", stage: "developing", platform: "tiktok" };

describe("hashConfig", () => {
  it("is key-order-insensitive and 12 hex chars", () => {
    const a = hashConfig({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = hashConfig({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("insertDraftPlaybook", () => {
  it("writes a draft with hash; a version is immutable — dedupe and versioning", async () => {
    const first = await insertDraftPlaybook({ key: keyA, version: "v1", config: config(), note: "test" });
    expect(first.created).toBe(true);
    expect(first.row.status).toBe("draft");
    expect(first.row.hash).toBe(hashConfig(config()));

    // Same key, same version, same config → the existing row comes back (a re-seed is a no-op, not a second row).
    const again = await insertDraftPlaybook({ key: keyA, version: "v1", config: config() });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);

    // Same key, same version, a DIFFERENT config → refused. A version is immutable.
    await expect(insertDraftPlaybook({ key: keyA, version: "v1", config: config({ min: 5, max: 7 }) })).rejects.toThrow(/immutable/);
    const [row] = await db.select().from(contentPlaybooks).where(eq(contentPlaybooks.id, first.row.id));
    expect((row.config as PlaybookConfig).cadence.postsPerWeek).toEqual({ min: 2, max: 4 });

    // A different PLATFORM is a different key: no collision with keyA's v1.
    const other = await insertDraftPlaybook({ key: keyB, version: "v1", config: config() });
    expect(other.created).toBe(true);
    expect(other.row.id).not.toBe(first.row.id);
  });

  it("refuses an unknown stage, a blank sport/platform and a blank version", async () => {
    await expect(insertDraftPlaybook({ key: { sport: "rowing", stage: "unclear" as any, platform: "instagram" }, version: "v1", config: config() })).rejects.toBeInstanceOf(PlaybookStoreError);
    await expect(insertDraftPlaybook({ key: { sport: "", stage: "developing", platform: "instagram" }, version: "v1", config: config() })).rejects.toBeInstanceOf(PlaybookStoreError);
    await expect(insertDraftPlaybook({ key: { sport: "rowing", stage: "developing", platform: "" }, version: "v1", config: config() })).rejects.toBeInstanceOf(PlaybookStoreError);
    await expect(insertDraftPlaybook({ key: keyA, version: "", config: config() })).rejects.toBeInstanceOf(PlaybookStoreError);
  });
});

describe("getActivePlaybook / activatePlaybook", () => {
  const keyC: PlaybookKey = { sport: "fencing", stage: "elite", platform: "youtube" };

  it("never returns a draft; activation is explicit and atomic; one active per key", async () => {
    await insertDraftPlaybook({ key: keyC, version: "v1", config: config({ min: 1, max: 2 }) });
    await insertDraftPlaybook({ key: keyC, version: "v2", config: config({ min: 3, max: 4 }) });
    expect(await getActivePlaybook(keyC)).toBeNull();

    const active = await activatePlaybook(keyC, "v1");
    expect(active.status).toBe("active");
    expect(active.activated_at).toBeTruthy();
    expect((await getActivePlaybook(keyC))?.version).toBe("v1");

    // Swapping to the next version archives the old one in the same transaction.
    await activatePlaybook(keyC, "v2");
    const rows = await listPlaybookVersions(keyC);
    expect(rows.map((r) => [r.version, r.status]).sort()).toEqual([["v1", "archived"], ["v2", "active"]]);
    expect((await getActivePlaybook(keyC))?.version).toBe("v2");

    // Activating the already-active version is a no-op.
    expect((await activatePlaybook(keyC, "v2")).version).toBe("v2");
  });

  it("the database itself refuses a second active row per key", async () => {
    const key: PlaybookKey = { sport: "fencing", stage: "elite", platform: "x" };
    await insertDraftPlaybook({ key, version: "a", config: config() });
    await insertDraftPlaybook({ key, version: "b", config: config() });
    await activatePlaybook(key, "a");
    // Bypass the helper on purpose: this is the partial unique index doing the work.
    await expect(
      db.update(contentPlaybooks).set({ status: "active" }).where(eq(contentPlaybooks.version, "b")),
    ).rejects.toThrow();
  });

  it("refuses unknown and archived versions", async () => {
    const key: PlaybookKey = { sport: "fencing", stage: "early", platform: "instagram" };
    await expect(activatePlaybook(key, "nope")).rejects.toBeInstanceOf(PlaybookStoreError);
    await insertDraftPlaybook({ key, version: "old", config: config() });
    await db.update(contentPlaybooks).set({ status: "archived" }).where(eq(contentPlaybooks.version, "old"));
    await expect(activatePlaybook(key, "old")).rejects.toBeInstanceOf(PlaybookStoreError);
  });

  it("a key with no rows is unaffected by another key's status", async () => {
    const key: PlaybookKey = { sport: "fencing", stage: "retired", platform: "instagram" };
    expect(await getActivePlaybook(key)).toBeNull();
    expect(await listPlaybookVersions(key)).toEqual([]);
  });
});

describe("recordPlaybookFailure / getLatestPlaybookRow", () => {
  it("records a draft row noted 'failed: <reason>', never visible to getActivePlaybook, and leaves a prior active row untouched", async () => {
    const key: PlaybookKey = { sport: "diving", stage: "elite", platform: "youtube" };
    await insertDraftPlaybook({ key, version: "v1", config: config() });
    await activatePlaybook(key, "v1");

    await recordPlaybookFailure({ key, reason: "invalid_output", now: new Date("2026-10-11T00:00:00Z") });

    expect((await getActivePlaybook(key))?.version).toBe("v1");   // untouched
    const latest = await getLatestPlaybookRow(key);
    expect(latest).toMatchObject({ status: "draft", note: "failed: invalid_output" });
    expect(latest!.version.startsWith(FAILURE_VERSION_PREFIX)).toBe(true);   // the field recentlyFailed/activatePlaybook actually key off
  });

  it("getLatestPlaybookRow returns the newest row whatever its status, and null for a key with none", async () => {
    const key: PlaybookKey = { sport: "diving", stage: "developing", platform: "instagram" };
    expect(await getLatestPlaybookRow(key)).toBeNull();
    await insertDraftPlaybook({ key, version: "v1", config: config() });
    await recordPlaybookFailure({ key, reason: "error", now: new Date("2026-10-12T00:00:00Z") });
    const latest = await getLatestPlaybookRow(key);
    expect(latest?.note).toBe("failed: error");
  });
});

describe("activatePlaybook and failure markers", () => {
  it("refuses to activate a 'failed-…' version outright — a failure marker is never a real playbook", async () => {
    const key: PlaybookKey = { sport: "surfing", stage: "developing", platform: "tiktok" };
    await recordPlaybookFailure({ key, reason: "invalid_output", now: new Date("2026-10-11T00:00:00Z") });
    const marker = await getLatestPlaybookRow(key);
    await expect(activatePlaybook(key, marker!.version)).rejects.toBeInstanceOf(PlaybookStoreError);
    await expect(activatePlaybook(key, marker!.version)).rejects.toThrow(/failure marker/);
  });

  it("a successful activation archives every failure marker on file for that key — they stop piling up in listPlaybookVersions", async () => {
    const key: PlaybookKey = { sport: "surfing", stage: "elite", platform: "youtube" };
    await recordPlaybookFailure({ key, reason: "error", now: new Date("2026-10-09T00:00:00Z") });
    await recordPlaybookFailure({ key, reason: "invalid_output", now: new Date("2026-10-10T00:00:00Z") });
    await insertDraftPlaybook({ key, version: "v1", config: config() });

    let rows = await listPlaybookVersions(key);
    expect(rows.filter((r) => r.version.startsWith(FAILURE_VERSION_PREFIX) && r.status === "draft")).toHaveLength(2);

    await activatePlaybook(key, "v1");

    rows = await listPlaybookVersions(key);
    const markers = rows.filter((r) => r.version.startsWith(FAILURE_VERSION_PREFIX));
    expect(markers).toHaveLength(2);
    expect(markers.every((r) => r.status === "archived")).toBe(true);
    expect((await getActivePlaybook(key))?.version).toBe("v1");
  });

  it("another key's failure markers are never touched by an unrelated key's activation", async () => {
    const keyA: PlaybookKey = { sport: "surfing", stage: "early", platform: "instagram" };
    const keyB: PlaybookKey = { sport: "surfing", stage: "early", platform: "tiktok" };
    await recordPlaybookFailure({ key: keyA, reason: "error", now: new Date("2026-10-09T00:00:00Z") });
    await insertDraftPlaybook({ key: keyB, version: "v1", config: config() });
    await activatePlaybook(keyB, "v1");

    const stillFailed = await getLatestPlaybookRow(keyA);
    expect(stillFailed?.status).toBe("draft");
    expect(stillFailed?.version.startsWith(FAILURE_VERSION_PREFIX)).toBe(true);
  });
});
