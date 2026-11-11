/**
 * read.test.ts — the read API the plan step can use later (design "Moments → post kits" §5/§7):
 *   - getPlaybook: the active row per requested platform, null config when none exists yet, sport folded to
 *     lower(trim()) before the lookup
 *   - cadenceFor: ALWAYS returns the playbook's own default (review fix, PR #929 — it used to be nulled out by any
 *     active standing_rule, whatever it was about), plus her active style/standing_rule statements verbatim
 *     alongside it; it never decides which one wins
 *   - getPlaybookForAthlete: the two combined, with the (sport, stage) pair derived from HER OWN roster row (never
 *     trusted from the caller), against a real (PGlite) Postgres
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { seedAthlete } from "../../testUtils/pgliteDb";
import type { Preference } from "../../../shared/agent";
import type { PlaybookConfig, PlaybookKey } from "../../../shared/playbook";
import { addPreference } from "../memory";
import { dbStore } from "../research/dbStore";
import { activatePlaybook, insertDraftPlaybook } from "./store";
import { cadenceFor, getPlaybook, getPlaybookForAthlete } from "./read";

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

const brief = (id: string, band: string) => dbStore.writeBrief(id, {
  summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] },
  display: { stage: { label: "l", band, confidence: 0.8, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] } } as any,
  runId: null,
});

describe("getPlaybook", () => {
  it("returns the active row per platform, and a null config for a platform with no key on file", async () => {
    const key: PlaybookKey = { sport: "rowing", stage: "developing", platform: "instagram" };
    await insertDraftPlaybook({ key, version: "v1", config: config() });
    await activatePlaybook(key, "v1");

    const rows = await getPlaybook("rowing", "developing", ["instagram", "tiktok"]);
    expect(rows).toEqual([
      { platform: "instagram", config: expect.objectContaining({ cadence: { postsPerWeek: { min: 2, max: 4 } } }), version: "v1", activatedAt: expect.any(String) },
      { platform: "tiktok", config: null, version: null, activatedAt: null },
    ]);
  });

  it("folds sport to lower(trim()) before looking up — a differently-cased/spaced caller still finds the same row", async () => {
    const [row] = await getPlaybook(" ROWING ", "developing", ["instagram"]);
    expect(row.config).not.toBeNull();
    expect(row.version).toBe("v1");
  });

  it("a DRAFT row (never activated) is never returned", async () => {
    const key: PlaybookKey = { sport: "fencing", stage: "elite", platform: "youtube" };
    await insertDraftPlaybook({ key, version: "v1", config: config() });
    const [row] = await getPlaybook("fencing", "elite", ["youtube"]);
    expect(row.config).toBeNull();
  });
});

describe("cadenceFor", () => {
  const pref = (over: Partial<Pick<Preference, "kind" | "status" | "statement">> = {}): Pick<Preference, "kind" | "status" | "statement"> =>
    ({ kind: "standing_rule", status: "active", statement: "I only want to post twice a week.", ...over });

  it("the default is returned even with no preferences at all", () => {
    expect(cadenceFor(config(), [])).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: [] });
  });
  it("null postsPerWeek, empty statements, when there is no playbook row and nothing said", () => {
    expect(cadenceFor(null, [])).toEqual({ postsPerWeek: null, preferenceStatements: [] });
  });
  it("her active standing_rule statement travels ALONGSIDE the default, never replacing it", () => {
    expect(cadenceFor(config(), [pref()])).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: ["I only want to post twice a week."] });
  });
  it("an unrelated standing_rule (about anything, not frequency) still travels alongside the default — this function never reads the words, only the kind/status", () => {
    const out = cadenceFor(config(), [pref({ statement: "Decline betting and alcohol brands." })]);
    expect(out).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: ["Decline betting and alcohol brands."] });
  });
  it("a STYLE preference counts too — the usual home for 'post twice a week'", () => {
    const out = cadenceFor(config(), [pref({ kind: "style", statement: "Keep it to two posts a week." })]);
    expect(out).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: ["Keep it to two posts a week."] });
  });
  it("a RETIRED preference, or one of another kind (voice/avoid), never appears", () => {
    expect(cadenceFor(config(), [pref({ status: "retired" })])).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: [] });
    expect(cadenceFor(config(), [pref({ kind: "avoid" })])).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: [] });
    expect(cadenceFor(config(), [pref({ kind: "voice" })])).toEqual({ postsPerWeek: { min: 2, max: 4 }, preferenceStatements: [] });
  });
  it("multiple active statements (style AND standing_rule) all travel together", () => {
    const out = cadenceFor(config(), [pref({ kind: "style", statement: "Twice a week." }), pref({ kind: "standing_rule", statement: "No posts on competition days." })]);
    expect(out.preferenceStatements.sort()).toEqual(["No posts on competition days.", "Twice a week."]);
    expect(out.postsPerWeek).toEqual({ min: 2, max: 4 });
  });
});

describe("getPlaybookForAthlete", () => {
  it("derives (sport, stage) from HER OWN roster row, combines it with the active playbook and her preferences", async () => {
    const athleteId = await seedAthlete("Has a standing rule", { sport: " Swimming " });
    await brief(athleteId, "established");
    const key: PlaybookKey = { sport: "swimming", stage: "established", platform: "instagram" };
    await insertDraftPlaybook({ key, version: "v1", config: config({ min: 3, max: 5 }) });
    await activatePlaybook(key, "v1");
    await addPreference(athleteId, { kind: "standing_rule", statement: "No posts on competition days.", source: "said" });

    const [row] = await getPlaybookForAthlete(athleteId, ["instagram"]);
    expect(row.config?.cadence.postsPerWeek).toEqual({ min: 3, max: 5 });
    expect(row.cadence).toEqual({ postsPerWeek: { min: 3, max: 5 }, preferenceStatements: ["No posts on competition days."] });
  });

  it("an athlete with no current Brief, no sport, or an unclear stage yet gets [] — never an error, and never a guess at her key", async () => {
    const noBrief = await seedAthlete("No brief for read", { sport: "swimming" });
    expect(await getPlaybookForAthlete(noBrief, ["instagram"])).toEqual([]);

    const noSport = await seedAthlete("No sport for read");
    await brief(noSport, "established");
    expect(await getPlaybookForAthlete(noSport, ["instagram"])).toEqual([]);

    const unclear = await seedAthlete("Unclear for read", { sport: "swimming" });
    await brief(unclear, "unclear");
    expect(await getPlaybookForAthlete(unclear, ["instagram"])).toEqual([]);
  });
});
