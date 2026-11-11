/**
 * build.test.ts — the canonical context contract on PGlite (design §3.4 gates G2, G3, G4, G5, G5b; §3.2 coverage).
 *
 *   coverage    the pure rules: unavailable | populated | confirmed_empty | disputed; legacy only for unavailable
 *   G5b         Brand X in the blob + confirmed_empty ⇒ empty everywhere; populated ⇒ only Brand Y; unavailable ⇒ legacy-marked
 *   G2          assertions override for display only; legacy values unclassed; inferences stay in `inferences`; suspect never surfaces
 *   G3          handles by authority (connected > platform_public > web_researched; entered last); level confirmed > found
 *   G4          a connection changes connectionStatus and nothing in freshness; stale is stale whatever the connection
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { initTestDb, closeTestDb, seedConnection } from "../../../testUtils/pgliteDb";
import { buildCanonicalContext, type BuiltContext } from "./build";
import { coverageFor, aggregateSourceMode, legacyAllowed } from "./coverage";
import { recordView, readRecordExtras } from "./views/record";
import { promptView } from "./views/prompt";
import { deckView, readDeckExtras } from "./views/deck";
import { searchView } from "./views/search";
import { identityView } from "./views/identity";
import { structuralDiff, shadowCompare } from "./shadow";
import { seedLegacyAthlete, seedCanonicalAthlete, textOf, T1 } from "./testFixtures";

const ids: Record<string, string> = {};
const must = async (id: string): Promise<BuiltContext> => { const b = await buildCanonicalContext(id, { asOf: new Date("2026-09-11T00:00:00Z") }); if (!b) throw new Error("no context"); return b; };
const allViews = async (b: BuiltContext) => ({ record: recordView(b, await readRecordExtras(b.ctx.athleteId)), prompt: promptView(b, "narrator"), deck: deckView(b, await readDeckExtras(b.ctx.athleteId)), search: searchView(b), identity: identityView(b) });

jest.setTimeout(180_000);   // PGlite schema push + the fixtures exceed the 30 s default on a cold worker

beforeAll(async () => {
  await initTestDb();
  ids.legacy = await seedLegacyAthlete();
  ids.empty = await seedCanonicalAthlete({ brandDomain: "confirmed_empty" });
  ids.populated = await seedCanonicalAthlete({ brandDomain: "populated", name: "Popu Pat" });
});
afterAll(closeTestDb);

describe("coverage (§3.2)", () => {
  it("maps state + rows to the four coverages; legacy is admissible only for unavailable", () => {
    expect(coverageFor(undefined, 0)).toBe("unavailable");
    expect(coverageFor(undefined, 2)).toBe("populated");
    expect(coverageFor({ outcome: "confirmed_empty" }, 0)).toBe("confirmed_empty");
    expect(coverageFor({ outcome: "confirmed_empty" }, 1)).toBe("populated");
    expect(coverageFor({ outcome: "refreshed" }, 0)).toBe("populated");
    expect(coverageFor({ status: "disputed", outcome: "refreshed" }, 1)).toBe("disputed");
    expect(coverageFor({ outcome: "failed" }, 0)).toBe("unavailable");
    expect(["populated", "confirmed_empty", "disputed"].map((c) => legacyAllowed(c as any))).toEqual([false, false, false]);
    expect(legacyAllowed("unavailable")).toBe(true);
    const base = { identity: "populated", profile: "populated", affiliations: "unavailable", achievements: "populated", press: "confirmed_empty", brand_mentions: "confirmed_empty", narrative: "disputed", social_handles: "populated", signals: "unavailable" } as const;
    expect(aggregateSourceMode(base as any, ["identity", "press", "narrative"])).toBe("canonical");
    expect(aggregateSourceMode(base as any, ["affiliations", "signals"])).toBe("legacy");
    expect(aggregateSourceMode(base as any, ["identity", "signals"])).toBe("mixed");
  });

  it("an athlete with no research state is entirely legacy; a research_complete one is canonical", async () => {
    const l = await must(ids.legacy);
    expect(l.ctx.sourceMode).toBe("legacy");
    expect(Object.values(l.ctx.coverage).every((c) => c === "unavailable")).toBe(true);
    const c = await must(ids.empty);
    expect(c.ctx.sourceMode).toBe("canonical");
    expect(c.ctx.coverage).toMatchObject({ identity: "populated", profile: "populated", achievements: "populated", press: "populated", brand_mentions: "confirmed_empty", narrative: "populated", social_handles: "populated" });
  });
});

describe("G5b canonical-empty never falls back", () => {
  it("confirmed_empty ⇒ brandMentions = [] though the blob holds Brand X; Brand X in no view", async () => {
    const b = await must(ids.empty);
    expect(b.ctx.brandMentions).toEqual([]);
    expect(b.ctx.coverage.brand_mentions).toBe("confirmed_empty");
    const v = await allViews(b);
    for (const [name, view] of Object.entries(v)) expect([name, textOf(view).includes("Brand X")]).toEqual([name, false]);
    expect(textOf(b.ctx).includes("Brand X")).toBe(false);
    // the populated achievements domain never shows the blob's achievement either
    expect(textOf(v).includes("Blob Achievement")).toBe(false);
    expect(textOf(v).includes("Blob story")).toBe(false);
    expect(textOf(v).includes("Blob position")).toBe(false);
    expect(v.deck.brandMentions).toEqual([]); expect(v.deck.commercialState).toBe("none"); expect(v.deck.inferredPartners).toEqual([]);
  });

  it("populated ⇒ only the canonical Brand Y, never the blob's Brand X", async () => {
    const b = await must(ids.populated);
    expect(b.ctx.coverage.brand_mentions).toBe("populated");
    expect(b.ctx.brandMentions.map((m) => m.value.brand)).toEqual(["Brand Y"]);
    expect(b.ctx.brandMentions[0]).toMatchObject({ sourceClass: "web_researched", lineage: "cited", sourceDomain: "daily.example" });
    const v = await allViews(b);
    expect(textOf(v).includes("Brand X")).toBe(false);
    expect(textOf(v).includes("Brand Y")).toBe(true);
  });

  it("unavailable ⇒ Brand X from the blob, marked origin legacy_blob / sourceClass null / lineage legacy / authorityTier null", async () => {
    const b = await must(ids.legacy);
    expect(b.ctx.coverage.brand_mentions).toBe("unavailable");
    expect(b.ctx.brandMentions).toEqual([expect.objectContaining({ value: { brand: "Brand X", type: "tagged", confidence: null }, sourceClass: null, lineage: "legacy", retrievedAt: "2026-08-01T12:00:00.000Z" })]);
    expect(b.ctx.achievements[0]).toMatchObject({ origin: "legacy_blob", sourceClass: null, authorityTier: null, freshness: "unknown", status: "historical" });
    expect(b.ctx.profile.position).toMatchObject({ value: { text: "Forward" }, origin: "legacy_blob" });   // D4: read from profile.*
    expect(b.ctx.provenanceSummary.legacyFacts).toBeGreaterThan(0);
    expect(b.ctx.provenanceSummary.canonicalFacts).toBe(0);
  });
});

describe("G2 provenance", () => {
  it("an assertion appears in `assertions` and overrides a single fact for DISPLAY without touching the fact, press or achievements", async () => {
    const b = await must(ids.empty);
    expect(b.ctx.assertions).toEqual([expect.objectContaining({ field: "position", value: "Striker", said: "I play striker", source: "onboarding" })]);
    expect(b.ctx.profile.position?.value).toEqual({ text: "Forward" });   // the contract keeps the research fact
    const rec = recordView(b, await readRecordExtras(ids.empty));
    const who = rec.groups.find((g) => g.key === "who")!.entries;
    expect(who.find((e) => e.field === "position")).toMatchObject({ value: "Striker", kind: "said", source: "you told Mila" });
    expect(who.find((e) => e.field === "class_year")).toMatchObject({ value: "Junior", kind: "found" });
    expect(b.ctx.press.map((p) => p.value.headline)).toEqual(["Cole wins"]);
    expect(b.ctx.achievements.map((a) => a.value.name)).toEqual(["National Champion", "All-Conference"]);
    const p = promptView(b, "onboarding");
    expect(p.facts.position).toBe("Forward");                 // the fact, tagged by origin
    expect(p.block).toContain("TOLD US: position = Striker"); // the athlete's word, in its own line
  });

  it("a legacy value never carries an authority tier ≤ 2; a canonical fact carries its real tier", async () => {
    const l = await must(ids.legacy);
    for (const f of [...l.ctx.achievements, l.ctx.profile.position!, l.ctx.profile.classYear!, l.ctx.identity.hometown!]) expect(f.authorityTier).toBeNull();
    const c = await must(ids.empty);
    expect(c.ctx.achievements.find((a) => a.value.name === "National Champion")!.authorityTier).toBe(1);
  });

  it("an inference never appears outside `inferences`; suspect evidence never reaches the contract or any view", async () => {
    const b = await must(ids.empty);
    const { inferences, ...rest } = b.ctx;
    expect(inferences.storyArc).toMatchObject({ value: "Canonical story arc", producer: "narrative_v1", legacy: false });
    expect(textOf(rest).includes("Canonical story arc")).toBe(false);
    const v = await allViews(b);
    expect(textOf(v).includes("SUSPECT HEADLINE")).toBe(false);
    expect(textOf(b.ctx).includes("SUSPECT HEADLINE")).toBe(false);
    // the prompt keeps inferences in their own sub-block, never among the fact lines
    const p = promptView(b, "narrator");
    const infIdx = p.lines.indexOf("INFERENCES:");
    expect(infIdx).toBeGreaterThan(0);
    expect(p.lines.slice(0, infIdx).some((l) => l.includes("Canonical story arc"))).toBe(false);
    expect(p.lines[infIdx + 1]).toMatch(/^ {2}story_arc: Canonical story arc \[inference · narrative_v1/);
  });
});

describe("G3 authority", () => {
  it("handles: connected_verified > platform_public > web_researched; entered last; blob handles only when the domain is unavailable", async () => {
    const before = await must(ids.populated);
    expect(before.ctx.social.handles.instagram).toMatchObject({ handle: "cole_public", sourceClass: "platform_public", origin: "social_identity" });
    expect(before.ctx.social.handles.tiktok).toMatchObject({ handle: "cole_tt", sourceClass: "web_researched" });
    expect(before.ctx.social.handles.x).toMatchObject({ handle: "cole_x", sourceClass: "entered", origin: "entered" });
    expect(before.ctx.social.handles.youtube).toBeUndefined();   // the blob's youtube handle: social_handles is populated
    const row = recordView(before, await readRecordExtras(ids.populated)).groups[0].entries.find((e) => e.field === "handles")!;
    expect(row).toMatchObject({ value: "@cole_x (X)", source: "signup" });                        // the Facts row: typed or connected only, never an identity under "signup"
    expect(searchView(before).knownHandles).toEqual({ instagram: "cole_public", tiktok: "cole_tt", x: "cole_x" });   // the search view: identities by authority
    await seedConnection({ athleteId: ids.populated, platform: "instagram", email: "cole_ig" });
    const after = await must(ids.populated);
    expect(after.ctx.social.handles.instagram).toMatchObject({ handle: "cole_ig", sourceClass: "connected_verified", connected: true, origin: "connected_account" });
    expect(searchView(after).knownHandles).toEqual({ instagram: "cole_ig", tiktok: "cole_tt", x: "cole_x" });
    const legacy = await must(ids.legacy);
    expect(legacy.ctx.social.handles.tiktok).toMatchObject({ handle: "legacy_tt", origin: "legacy_blob", sourceClass: null });
    expect(searchView(legacy).knownHandles).toEqual({ instagram: "legacy_ig", x: "legacy_x" });     // blob handles never in knownHandles
    expect(searchView(legacy).legacyBlobHandles).toEqual({ tiktok: "legacy_tt" });
  });

  it("affiliations.level: the athlete's said row decides over a found row; the projection is only a fallback", async () => {
    const b = await must(ids.empty);
    expect(b.ctx.affiliations.level).toMatchObject({ org: "Canon University", division: "D1", conference: "Big Ten", segment: "college" });
    expect(b.ctx.affiliations.current?.org).toBe("Canon University");
    expect(identityView(b)).toMatchObject({ currentTeam: "Canon University", legacySchool: "Stale School (projection)", level: { division: "D1", conference: "Big Ten", segment: "college" } });
  });
});

describe("G4 freshness ⟂ connection", () => {
  it("adding a connection changes connectionStatus and nothing in freshness; a stale domain stays stale", async () => {
    const before = await must(ids.empty);
    expect(before.ctx.social.connectionStatus).toBe("none");
    expect(before.ctx.profile.classYear?.freshness).toBe("stale");
    expect(before.ctx.profile.position?.freshness).toBe("fresh");
    await seedConnection({ athleteId: ids.empty, platform: "instagram", email: "cole_ig" });
    const after = await must(ids.empty);
    expect(after.ctx.social.connectionStatus).toBe("active");
    expect(after.ctx.social.connectedPlatforms).toEqual(["instagram"]);
    expect(structuralDiff(before.ctx.freshness, after.ctx.freshness)).toEqual([]);
    expect(after.ctx.profile.classYear?.freshness).toBe("stale");
    expect(after.ctx.freshness.researchAsOf).toBe(T1.toISOString());
  });
});

describe("G5 boundary", () => {
  it("sourceMode and coverage are present on every view; a mixed context is marked", async () => {
    const b = await must(ids.empty);
    const v = await allViews(b);
    expect(v.identity.sourceMode).toBe("canonical"); expect(v.identity.coverage.brand_mentions).toBe("confirmed_empty");
    expect(v.prompt.facts.source_mode).toBe("canonical");
    expect(v.prompt.block.startsWith("<<<ATHLETE_CONTEXT purpose=narrator sourceMode=canonical>>>")).toBe(true);
    const mixed = { ...b, ctx: { ...b.ctx, coverage: { ...b.ctx.coverage, press: "unavailable" as const } } };
    expect(promptView(mixed as any, "chat").facts.source_mode).toBe("canonical");   // the view reports the builder's aggregate…
    expect(structuralDiff(b.ctx.coverage, mixed.ctx.coverage)).toEqual([{ path: "press", legacy: "populated", canonical: "unavailable" }]);   // …and coverage stays inspectable per domain
  });

  it("shadowCompare: a structural diff with documented exceptions ignored", () => {
    const r = shadowCompare("record", "a", { x: 1, y: [1, 2], z: { k: "a" } }, { x: 1, y: [1, 3], z: { k: "b" } }, ["z.k"]);
    expect(r.equal).toBe(false);
    expect(r.diffs).toEqual([{ path: "y[1]", legacy: 2, canonical: 3 }]);
    expect(r.ignored).toEqual(["z.k"]);
    expect(shadowCompare("deck", "a", { d: new Date("2026-01-01T00:00:00Z") }, { d: "2026-01-01T00:00:00.000Z" }).equal).toBe(true);
  });
});
