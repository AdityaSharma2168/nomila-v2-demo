/**
 * identityIntelligence.integration.test.ts — Identity Intelligence 0.2 end to end on PGlite (contract approved 3 Oct).
 *
 *   S1 athleteStatements(): the union of her words — source_read quotes (never a search-grounded one), connected
 *      captions (never an upload's), the LATEST bio per platform, live asserted `said`, Objective-event `said`, the
 *      wording of an Objective she wrote — each with its provenance; ranking and per-topic caps; the topic filter
 *   S2 (0.7) partner content: a caption made under a deal, tagged to a brand or carrying a disclosure marker is flagged
 *   I1 envelope 0.2: sections A–I and tiers; First Look is the latest snapshot PER PLATFORM (not the newest N rows)
 *      with interests / recurring phrases / causes; M.I.A. compact only; inputVersion stable
 *   I2 EXCLUDED: retiring sources (story_arc, the research blob, legacy found affiliations), M.I.A.
 *      prose and citations, Unconfirmed items, suspect evidence, uploads, search-grounded quotes
 *   I3 rules parts computed before the call: athletic identity, proof points, signature moments, voice, audience,
 *      associations, causes, interests, direction / desired positioning / chapters.next, guardrails, unresolved
 *   I4 a 0.1 row is read by /me/story (identity statement → essence) until the first 0.2 recompute supersedes it
 *   I5 run: the prompt carries the approved text and the sections; an invalid first answer is repaired once and the
 *      0.2 record persisted (owner identity_intelligence, ASSESSMENT, versions 0.2) superseding the 0.1 row
 *   I6 unchanged inputVersion skips; a change supersedes · a draft failing twice persists nothing · a cut-off answer
 *   I7 a sparse athlete is below sufficiency: no provider call, /me/story `learning`
 *   I8 /me/story 0.2: unavailable with the flag off; ready with essence + desired positioning; her approved essence is
 *      pinned (0.1 target identityStatement → essence); a part citing something she since denied is withheld
 *   I9 governance writes (unchanged from 0.1) · I10 the admin seam
 * Providers are never reached: the synthesis provider module is mocked and lib/models throws. Fixtures are fictional.
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));
jest.mock("../../../lib/models", () => ({ genai: () => { throw new Error("provider reached from a test"); }, GEMINI: { flash: "never" } }));
jest.mock("../../identityIntelligenceProvider", () => ({ callIdentitySynthesis: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  athleteAffiliations, athleteAsserted, athleteFacts, athleteSnapshots, athletesCurrent, contentBrands, deals, identityIntelligenceAttempts, inboxBrands, intelligenceLedger,
  mediaAssets, objectiveEvents, researchEvidence, researchRuns, socialFeatures, users,
} from "../../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import meStoryRouter from "../../../routes/meStory";
import adminIntelligenceRouter from "../../../routes/adminIntelligence";
import { latestAssertions, recordAssertions } from "../../../mila/onboarding";
import { callIdentitySynthesis } from "../../identityIntelligenceProvider";
import { createAthleteObjective } from "../objective/store";
import { buildIdentityEnvelope, inputVersionOf } from "./envelope";
import { failedBefore, promptFor, runIdentityIntelligence } from "./run";
import { athleteStatements, gatherStatements } from "./statements";
import { PROMPT_TEXT, type SynthesisProvider } from "./synthesize";
import type { IdentityIntelligenceRecord, IdentityIntelligenceView } from "./contract";

jest.setTimeout(180_000);

const g = globalThis as any;
const T0 = new Date("2025-01-01T00:00:00.000Z");
const T1 = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-10-01T00:00:00.000Z");
const ids: Record<string, string> = {};
let server: Server; let base = "";

/** The short id (E1, W2, P1…) the prompt gave the line containing `needle`. */
function aliasIn(prompt: string, needle: string): string {
  const line = prompt.split("\n").find((l) => /^[A-Z]\d+ \[/.test(l) && l.includes(needle));
  if (!line) throw new Error(`no item line contains ${needle}`);
  return line.split(" ")[0];
}

function validAnswer(prompt: string) {
  const sport = aliasIn(prompt, "Sport: Rowing"); const team = aliasIn(prompt, "Lakeside College");
  const caption = aliasIn(prompt, "dawn on the water"); const quote = aliasIn(prompt, "quiet of the water");
  const national = aliasIn(prompt, "National U23"); const signature = aliasIn(prompt, "winning crew");
  const home = aliasIn(prompt, "Harbor Town");
  return JSON.stringify({
    essence: { short: "Lakeside College rower and crew captain", long: "A Lakeside College rower and crew captain, at home on the water.", basis: [sport, team] },
    positioningCurrent: { short: "A crew-minded rower from a harbour town", long: "A crew-minded rower whose own posts show the dawn sessions behind the results.", basis: [caption, sport, home] },
    standsFor: null,
    pillars: [
      { key: "competitor", label: "Competitor", definition: "Races at national level and in big finals.", proof: [national, signature], basis: [sport] },
    ],
    differentiators: [{ text: "A harbour-town rower on a national squad.", basis: [home, national] }],
    throughline: { short: "The water, from the harbour to the national squad", long: "From the harbour to the national squad, the water is the constant.", basis: [home, national] },
    chapters: { origin: { text: "Grew up on the harbour.", basis: [home] }, rise: null, defining: { text: "The regional final.", basis: [signature] }, now: { text: "Rowing for Lakeside College.", basis: [team] } },
    athleticStyle: null, origin: { text: "A harbour town.", basis: [home] },
    values: [{ text: "Teamwork", basis: [caption, sport] }], personality: [{ text: "Calm", basis: [quote] }],
    motivation: { text: "The quiet of the water.", basis: [quote] },
    communities: [], mediaFraming: null, imageGap: null,
  });
}

/** First answer breaks the superlative rule; the repair (prompt carries the rejection) is valid. */
const repairingProvider: SynthesisProvider = async ({ prompt }) => {
  if (prompt.includes("YOUR PREVIOUS ANSWER WAS REJECTED")) return { text: validAnswer(prompt), model: "stub-model", modelVersion: "stub-1" };
  const bad = JSON.parse(validAnswer(prompt));
  bad.essence = { ...bad.essence, basis: ["E99"] };   // a citation that was never supplied: a contract failure
  return { text: JSON.stringify(bad), model: "stub-model" };
};
const alwaysBad: SynthesisProvider = async ({ prompt }) => {
  const bad = JSON.parse(validAnswer(prompt));
  bad.motivation = { text: "The greatest captain ever.", basis: [aliasIn(prompt, "Sport: Rowing")] };
  return { text: JSON.stringify(bad), model: "stub-model" };
};

const attemptRows = async (runId: string) => (await db.select().from(identityIntelligenceAttempts).where(eq(identityIntelligenceAttempts.run_id, runId)))
  .sort((a, b) => a.attempt - b.attempt).map((a) => ({ ...a, errors: a.errors as string[] }));
const ledgerRows = (athleteId: string) => db.select().from(intelligenceLedger).where(and(eq(intelligenceLedger.subject_id, athleteId), eq(intelligenceLedger.owner, "identity_intelligence")));
const story = async (athleteId: string | null) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me/story`);
  return { status: r.status, body: (await r.json()) as IdentityIntelligenceView };
};
const withFlag = async <T>(on: boolean, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.IDENTITY_INTELLIGENCE_ENABLED;
  if (on) process.env.IDENTITY_INTELLIGENCE_ENABLED = "true"; else delete process.env.IDENTITY_INTELLIGENCE_ENABLED;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.IDENTITY_INTELLIGENCE_ENABLED; else process.env.IDENTITY_INTELLIGENCE_ENABLED = saved; }
};

beforeAll(async () => {
  await initTestDb();
  const a = ids.full = await seedAthlete("Avery Quill");
  ids.sparse = await seedAthlete("Sparse Example");
  const [u] = await db.insert(users).values({ provider: "firebase", provider_uid: "uid-identity-1" } as any).returning({ id: users.id });

  const fact = (key: string, value: unknown, valueText: string, status = "current") =>
    db.insert(athleteFacts).values({ athlete_id: a, fact_key: key, value: value as any, value_text: valueText, status, retrieved_at: T1, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: { evidenceIds: [], domains: ["lakeside.example"] } as any, freshness_family: "identity", resolver_version: "v1", registry_version: "v2" } as any).returning({ id: athleteFacts.id });
  ids.sportFact = (await fact("sport", { sport: "Rowing" }, "rowing"))[0].id;
  ids.teamFact = (await fact("affiliation", { org: "Lakeside College", orgKind: "school", level: "varsity", role: "captain" }, "lakeside college school"))[0].id;
  ids.nationalFact = (await fact("national_team_participation", { team: "National U23", level: "u23", year: 2025 }, "national u23 u23 2025"))[0].id;
  ids.awardFact = (await fact("award", { name: "First Lakeside rower named athlete of the year", year: 2025 }, "first lakeside rower 2025"))[0].id;
  ids.tierFact = (await fact("award", { name: "All-Conference First Team", year: 2024 }, "all conference first team 2024"))[0].id;
  ids.nameFact =(await fact("name", { full: "Avery Quill" }, "avery quill"))[0].id;
  ids.disputedFact = (await fact("award", { name: "Contested Medal", year: 2025 }, "contested medal 2025", "disputed"))[0].id;

  const [run] = await db.insert(researchRuns).values({ athlete_id: a, domain: "press", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
  const evidence = (kind: string, claim: Record<string, unknown>, sourceType: string, lineage: string, domain: string, over: Record<string, unknown> = {}) =>
    db.insert(researchEvidence).values({ athlete_id: a, run_id: run.id, kind, claim: claim as any, lineage_status: lineage, source_url: `https://${domain}/${kind}`, source_domain: domain, source_type: sourceType, retrieved_at: T1, confidence: "0.7", source_class: "web_researched", suspect: false, dedupe_key: `${kind}|${JSON.stringify(claim)}|${domain}`, ...over } as any).returning({ id: researchEvidence.id });
  const press = (headline: string, sourceType: string, lineage: string, domain: string, over: Record<string, unknown> = {}) => evidence("press_mention", { headline, outlet: domain }, sourceType, lineage, domain, over);
  ids.outletOne = (await press("Harbor Town rower makes the national squad", "major_news", "asserted_only", "outlet-one.example"))[0].id;
  ids.outletTwo = (await press("Harbor Town rower makes the national squad", "regional_news", "asserted_only", "news.outlet-two.example"))[0].id;
  ids.blog = (await press("Rumoured transfer to Example Club", "aggregator_or_blog", "native_supported", "fanblog.example"))[0].id;
  await press("SUSPECT SENTINEL headline", "major_news", "native_supported", "suspect.example", { suspect: true });
  ids.quote = (await evidence("athlete_statement", { text: "I row because the quiet of the water clears my head before anything else", topics: ["motivation"], medium: "video", speaker: "athlete", timestampSeconds: 95, sourceTitle: "Morning interview", outlet: "Outlet One", readSpec: "source-read/1" }, "major_news", "source_read", "outlet-one.example", { published_at: T1 }))[0].id;
  await evidence("athlete_statement", { text: "NO SPEAKER QUOTE SENTINEL", topics: ["values"], medium: "article" }, "major_news", "source_read", "outlet-four.example");
  await evidence("athlete_statement", { text: "UNKNOWN SPEAKER QUOTE SENTINEL", topics: ["values"], medium: "article", speaker: "unknown" }, "major_news", "source_read", "outlet-five.example");
  await evidence("athlete_statement", { text: "GROUNDED QUOTE SENTINEL", topics: ["values"], medium: "article", speaker: "athlete" }, "major_news", "asserted_only", "outlet-three.example");
  ids.signature = (await evidence("career_event", { eventKind: "signature", event: "Stroked the winning crew at the regional final", date: "2025-05-01" }, "official_team_or_school", "native_supported", "lakeside.example"))[0].id;
  ids.values = (await evidence("narrative_claim", { topic: "values_causes", text: "Volunteers with a youth rowing programme", organization: "Harbor Youth Rowing" }, "major_news", "native_retrieved", "outlet-one.example"))[0].id;
  ids.association = (await evidence("narrative_claim", { topic: "association", text: "Often linked with the harbour clean-up campaign" }, "major_news", "native_retrieved", "outlet-one.example"))[0].id;

  // her assertions (through the real writer, so the shapes are the stored ones)
  const say = (field: any, value: any, said?: string) => recordAssertions({ athleteId: a, runId: null, mode: "form", source: "settings", corrections: [{ field, value, ...(said ? { said } : {}) }] });
  await say("hometown", "Harbor Town", "I grew up rowing on the harbour every single morning");
  await say("brand_voice", { tone: "warm", phrases: ["row on"], avoid: ["prodigy"] });
  await say("never_post", ["family"]);
  await say("direction", "Be understood as a builder of young rowers");
  ids.hometown = (await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, a), eq(athleteAsserted.field, "hometown"))))[0].id;

  const objective = await createAthleteObjective(db as any, { athleteId: a, desiredState: "Start a coaching business for young rowers", domain: "owned_venture", observableCondition: "A first paying client", start: "now" }, { userId: u!.id, role: "athlete" });
  ids.objective = objective.id;
  const positioning = await createAthleteObjective(db as any, { athleteId: a, desiredState: "Be known as the rower who builds the next crew", domain: "positioning", observableCondition: "Coverage names the coaching work", start: "now" }, { userId: u!.id, role: "athlete" });
  ids.positioning = positioning.id;
  ids.event = (await db.insert(objectiveEvents).values({ objective_id: objective.id, athlete_id: a, at: T1, actor_user_id: u!.id, actor_role: "athlete", action: "accept", said: "Coaching is what I want my next chapter to be" } as any).returning({ id: objectiveEvents.id }))[0].id;

  ids.caption = (await db.insert(mediaAssets).values({ athlete_id: a, platform: "instagram", origin: "connected", media_type: "IMAGE", status: "stored", caption: "Another dawn on the water with the crew", posted_at: T1, permalink: "https://instagram.example/p/1" } as any).returning({ id: mediaAssets.id }))[0].id;
  await db.insert(mediaAssets).values({ athlete_id: a, platform: "instagram", origin: "upload", media_type: "IMAGE", status: "stored", caption: "UPLOADED NOT AUTHORED SENTINEL", posted_at: T1 } as any);

  const bio = (text: string, asOf: Date) => db.insert(socialFeatures).values({ athlete_id: a, platform: "instagram", feature_key: "profile.bio", value: null, value_json: { text }, unit: "text", window_days: 0, as_of: asOf, source_class: "platform_public", confidence: "0.70", calculation_version: "profile_bio/1", inputs: {} } as any);
  await bio("OLD BIO SENTINEL", T0);
  await bio("Rower. Coach in the making.", T1);

  // First Look: one old TikTok look, then MORE than twenty newer Instagram looks — the latest per platform must win both.
  ids.tiktokLook = (await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "first_look", created_at: T0, first_look: { platform: "tiktok", computed_at: T0.toISOString(), posts_read: 8, themes: ["race day"], tone: ["playful"] } } as any).returning({ id: athleteSnapshots.id }))[0].id;
  for (let n = 0; n < 21; n++) {
    const at = new Date(T1.getTime() - (21 - n) * 3_600_000);
    await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "first_look", created_at: at, first_look: { platform: "instagram", computed_at: at.toISOString(), posts_read: 12, themes: [`OLDER THEME ${n}`], tone: ["earnest"] } } as any);
  }
  ids.instaLook = (await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "first_look", created_at: T1, first_look: { platform: "instagram", computed_at: T1.toISOString(), posts_read: 12, themes: ["training", "teammates"], tone: ["earnest"], interests: ["woodworking"], recurring_phrases: ["row on"], causes_mentioned: ["clean water access"] } } as any).returning({ id: athleteSnapshots.id }))[0].id;
  await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "manual", research: { story: "LEGACY RESEARCH BLOB SENTINEL" } } as any);
  await db.insert(athletesCurrent).values({ athlete_id: a, story_arc: "LEGACY STORY ARC SENTINEL" } as any);
  await db.insert(athleteAffiliations).values({ athlete_id: a, org_name: "LEGACY FOUND ORG SENTINEL", org_kind: "club", kind: "found" } as any);

  await db.insert(socialFeatures).values({ athlete_id: a, platform: "instagram", feature_key: "followers_latest", value: "4200", unit: "count", window_days: 0, as_of: T1, source_class: "connected_verified", confidence: "1.00", calculation_version: "v1", inputs: {} } as any);
  await db.insert(socialFeatures).values({ athlete_id: a, platform: "instagram", feature_key: "audience_country_distribution", value: null, value_json: [{ bucket: "US", pct: 40 }, { bucket: "CA", pct: 20 }, { bucket: "GB", pct: 10 }, { bucket: "FR", pct: 5 }], unit: "json", window_days: 0, as_of: T1, source_class: "connected_verified", confidence: "1.00", calculation_version: "v1", inputs: {} } as any);
  ids.deal = (await db.insert(deals).values({ athlete_id: a, brand_name: "Brand Oak", status: "accepted", raw_data: { contract: { exclusivity: { exists: true, scope: "No competing water-sports brands" } } } } as any).returning({ id: deals.id }))[0].id;
  await db.insert(deals).values({ athlete_id: a, brand_name: "Brand Detected", status: "detected" } as any);
  await db.insert(intelligenceLedger).values({ subject_type: "athlete", subject_id: a, owner: "marketability", kind: "ASSESSMENT", evidence_as_of: T1, value: {
    dimensions: [{ dimension: "narrative_power", score: 90, signals: [{ key: "s1", imputed: false }] }, { dimension: "audience_scale", score: 20, signals: [{ key: "s2", imputed: false }] }],
    summary: "MIA SUMMARY PROSE SENTINEL", findings: [{ key: "narrative_power", rationale: "MIA RATIONALE PROSE SENTINEL", citedEvidence: ["c1"] }], evidence: [{ id: "c1", claim: "MIA CITATION SENTINEL" }],
    notes: { strengths: ["A clear story arc"], constraints: ["A small audience"] },
  } } as any);

  // A 0.1 row, current before the first 0.2 recompute.
  ids.v01 = (await db.insert(intelligenceLedger).values({ subject_type: "athlete", subject_id: a, owner: "identity_intelligence", kind: "ASSESSMENT", evidence_as_of: T1, value: {
    contract: "identity-intelligence/0.1", identityStatement: { value: "A rower at Lakeside College.", basis: [{ kind: "fact", id: ids.sportFact }], strength: "established" },
    positioningStatement: { value: "Building toward coaching.", basis: [{ kind: "objective", id: ids.objective }] }, themes: [], differentiators: [], inputVersion: "v01-input", generatedAt: T1.toISOString(), overallConfidence: "MEDIUM",
  } } as any).returning({ id: intelligenceLedger.id }))[0].id;

  const app = express(); app.use(express.json());
  app.use("/api/v1/me", meStoryRouter);
  app.use("/api/v1/admin/intelligence", adminIntelligenceRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

describe("S1 athleteStatements()", () => {
  it("unions her words with provenance, never a search-grounded quote, an upload or an old bio", async () => {
    const all = await athleteStatements(ids.full, { now: NOW });
    const by = (id: string) => all.find((s) => s.id === id);
    expect(by(`evidence:${ids.quote}`)).toMatchObject({ provenance: "source_read", medium: "video", topics: ["motivation"], acquisition: expect.objectContaining({ outlet: "Outlet One", timestampSeconds: 95, sourceTitle: "Morning interview", sourceUrl: "https://outlet-one.example/athlete_statement" }) });
    expect(by(`media_asset:${ids.caption}`)).toMatchObject({ provenance: "her_own", medium: "caption", acquisition: { platform: "instagram", permalink: "https://instagram.example/p/1" } });
    expect(by("social_feature:instagram.profile.bio")).toMatchObject({ provenance: "her_own", medium: "bio", text: "Rower. Coach in the making.", acquisition: { platform: "instagram", sourceClass: "platform_public" } });
    expect(by(`said:assertion:${ids.hometown}`)).toMatchObject({ provenance: "her_own", medium: "form", topics: ["origin"], text: "I grew up rowing on the harbour every single morning" });
    expect(by(`said:objective_event:${ids.event}`)).toMatchObject({ provenance: "her_own", medium: "objective_review", intent: true });
    expect(by(`said:objective:${ids.positioning}`)).toMatchObject({ provenance: "her_own", medium: "objective", text: "Be known as the rower who builds the next crew", intent: true });
    const text = JSON.stringify(all);
    // a research quote counts only when its speaker is explicitly the athlete
    for (const s of ["GROUNDED QUOTE SENTINEL", "UPLOADED NOT AUTHORED SENTINEL", "OLD BIO SENTINEL", "NO SPEAKER QUOTE SENTINEL", "UNKNOWN SPEAKER QUOTE SENTINEL"]) expect(text).not.toContain(s);
    expect(all.every((s) => s.provenance === "her_own" || s.provenance === "source_read")).toBe(true);
    // ranked: a recent read quote outranks a caption
    expect(all.findIndex((s) => s.id === `evidence:${ids.quote}`)).toBeLessThan(all.findIndex((s) => s.id === `media_asset:${ids.caption}`));
  });

  it("filters by topic and caps per topic", async () => {
    const ambition = await athleteStatements(ids.full, { topics: ["ambition"], now: NOW });
    expect(ambition.length).toBeGreaterThan(1);
    expect(ambition.every((s) => s.topics.includes("ambition"))).toBe(true);
    expect(await athleteStatements(ids.full, { topics: ["ambition"], limitPerTopic: 1, now: NOW })).toHaveLength(1);
  });
});

describe("S2 partner content (0.7)", () => {
  it("flags a caption made under a deal, tagged to a brand, or carrying #ad / #sponsored / paid partnership; never a plain one", async () => {
    const p = await seedAthlete("Partner Example");
    const [deal] = await db.insert(deals).values({ athlete_id: p, brand_name: "Brand Elm", status: "accepted" } as any).returning({ id: deals.id });
    const [brand] = await db.insert(inboxBrands).values({ name: "Brand Elm", normalized_name: "brand elm partner example" } as any).returning({ id: inboxBrands.id });
    const caption = async (text: string, over: Record<string, unknown> = {}) => (await db.insert(mediaAssets).values({ athlete_id: p, platform: "instagram", origin: "connected", media_type: "IMAGE", status: "stored", caption: text, posted_at: T1, ...over } as any).returning({ id: mediaAssets.id }))[0].id;
    const plain = await caption("Back on the water this morning");
    const underDeal = await caption("Race day kit sorted", { deal_id: deal.id });
    const tagged = await caption("New season, new gear");
    await db.insert(contentBrands).values({ asset_id: tagged, brand_id: brand.id } as any);
    const ad = await caption("Recovery routine with my favourite drink #AD");
    const sponsored = await caption("Loving these shoes #Sponsored");
    const paid = await caption("Paid Partnership with a local gym");
    const lookalike = await caption("Proud of my #adventure and the #advice I got");
    const flags = new Map((await gatherStatements(p, NOW)).map((s) => [s.ref.kind === "media_asset" ? s.ref.id : s.id, s.partner ?? false]));
    expect([plain, underDeal, tagged, ad, sponsored, paid, lookalike].map((id) => flags.get(id))).toEqual([false, true, true, true, true, true, false]);

    // The envelope carries the flag on the HER WORDS item, and it is part of the input hash.
    // (Captions bucket by medium and are capped, so which ones are shown is not asserted.)
    const env = await buildIdentityEnvelope(p, NOW);
    expect(env.statements.length).toBeGreaterThan(0);
    for (const s of env.statements) expect(env.items.find((i) => i.key === s.id)?.statement?.partner ?? false).toBe(s.partner ?? false);
    const { inputVersion, ...rest } = env;
    expect(inputVersionOf(rest)).toBe(inputVersion);
    const flipped = { ...rest, statements: rest.statements.map((s, n) => (n === 0 ? { ...s, partner: !s.partner } : s)) };
    expect(inputVersionOf(flipped)).not.toBe(inputVersion);
  });
});

describe("I1–I2 the envelope 0.2", () => {
  it("lays items out in sections A–I with tiers per policy", async () => {
    const env = await buildIdentityEnvelope(ids.full, NOW);
    const at = (k: string) => env.items.find((i) => i.key === k);
    expect(at(`fact:${ids.sportFact}`)).toMatchObject({ tier: "established", section: "established" });
    expect(at(`fact:${ids.disputedFact}`)!.tier).toBe("unconfirmed");
    expect(at(`fact:${ids.disputedFact}`)!.section).toBeUndefined();
    expect(at(`evidence:${ids.outletOne}`)).toMatchObject({ tier: "reported", section: "reported", sourceTier: "unconfirmed" });
    expect(at(`evidence:${ids.blog}`)!.tier).toBe("unconfirmed");
    expect(at(`evidence:${ids.quote}`)).toMatchObject({ tier: "reported", section: "her_words", statement: expect.objectContaining({ provenance: "source_read", timestampSeconds: 95 }) });
    expect(at(`said:assertion:${ids.hometown}`)).toMatchObject({ tier: "established", section: "her_words" });
    expect(at(`objective:${ids.positioning}`)).toMatchObject({ section: "direction", intent: true });
    expect(env.items.find((i) => i.section === "direction" && i.ref.kind === "assertion")!.text).toMatch(/builder of young rowers/);
    expect(at("social_feature:instagram.followers_latest")!.section).toBe("pre_assembled");   // measured audience is a proof point
    expect(at("social_feature:instagram.audience_country_distribution")).toMatchObject({ section: "audience", text: "instagram audience, top geographies: US 40%, CA 20%, GB 10%" });
    expect(at("state_finding:mia.narrative_power")).toMatchObject({ tier: "salience", section: "marketability" });
    expect(at("state_finding:mia.note.strength.1")!.text).toBe("Key strength (assessment): A clear story arc");
    expect(at("state_finding:mia.note.constraint.1")!.text).toBe("Key constraint (assessment): A small audience");
    expect(at(`fact:${ids.nameFact}`)).toBeUndefined();
    expect((await buildIdentityEnvelope(ids.full, NOW)).inputVersion).toBe(env.inputVersion);
  });

  it("First Look is the latest snapshot per platform, with interests, phrases and causes", async () => {
    const env = await buildIdentityEnvelope(ids.full, NOW);
    expect(env.firstLooks.map((f) => [f.platform, f.snapshotId])).toEqual([["instagram", ids.instaLook], ["tiktok", ids.tiktokLook]]);
    expect(env.firstLooks[0]).toMatchObject({ interests: ["woodworking"], recurringPhrases: ["row on"], causesMentioned: ["clean water access"] });
    const fl = env.items.find((i) => i.key === `first_look:${ids.instaLook}:instagram`)!;
    expect(fl).toMatchObject({ section: "self_presentation", tier: "reported" });
    expect(fl.text).toContain("interests woodworking");
    expect(JSON.stringify(env.items)).not.toContain("OLDER THEME");
  });

  it("never carries retiring sources, M.I.A. prose or citations, suspect evidence, uploads or grounded quotes — into the envelope or the prompt", async () => {
    const env = await buildIdentityEnvelope(ids.full, NOW);
    const text = JSON.stringify(env) + promptFor(env).prompt;
    for (const s of ["LEGACY STORY ARC SENTINEL", "LEGACY RESEARCH BLOB SENTINEL", "LEGACY FOUND ORG SENTINEL", "SUSPECT SENTINEL",
      "UPLOADED NOT AUTHORED SENTINEL", "GROUNDED QUOTE SENTINEL", "MIA SUMMARY PROSE SENTINEL", "MIA RATIONALE PROSE SENTINEL", "MIA CITATION SENTINEL", "Brand Detected"]) {
      expect(text).not.toContain(s);
    }
    const { prompt } = promptFor(env);
    expect(prompt).not.toContain("Rumoured transfer");   // Unconfirmed never shown
    expect(prompt).not.toContain("Avery");               // the athlete is never named
  });
});

describe("I3 the rules parts, before the call", () => {
  it("assembles identity, proof, moments, voice, audience, direction and guardrails deterministically", async () => {
    const r = (await buildIdentityEnvelope(ids.full, NOW)).rules;
    expect(r.athleticIdentity).toMatchObject({ sport: { value: "Rowing" }, team: { value: "Lakeside College" }, level: { value: "varsity" }, role: { value: "captain" } });
    expect(r.signatureMoments.map((m) => m.key).sort()).toEqual([`evidence:${ids.signature}`, `fact:${ids.awardFact}`].sort());
    const kinds = Object.fromEntries(r.proofPoints.map((p) => [p.key, p.kind]));
    // "All-Conference First Team" is an honour tier, not a historic first: a proof point, never a signature moment
    expect(kinds[`fact:${ids.tierFact}`]).toBe("honour");
    expect(kinds).toMatchObject({ [`fact:${ids.nationalFact}`]: "national_team", [`fact:${ids.teamFact}`]: "captaincy", [`deal:${ids.deal}`]: "partnership", "social_feature:instagram.followers_latest": "audience" });
    expect(r.voice).toMatchObject({ hers: { tone: "warm", phrases: ["row on"], avoid: ["prodigy"] }, observed: { tone: ["earnest", "playful"] }, signatureCues: ["row on"] });
    expect(r.voice.contentThemes).toEqual(["training", "teammates", "race day"]);
    expect(r.audience.platforms[0]).toMatchObject({ platform: "instagram", followers: 4200, topGeographies: [{ bucket: "US", pct: 40 }, { bucket: "CA", pct: 20 }, { bucket: "GB", pct: 10 }] });
    expect(r.interests.map((i) => i.text)).toContain("woodworking");
    expect(r.causes.map((c) => c.text)).toEqual(expect.arrayContaining(["clean water access", "Harbor Youth Rowing"]));
    expect(r.valuesEvidence.map((v) => v.text)).toContain("Volunteers with a youth rowing programme");
    expect(r.associations.map((v) => v.text)).toEqual(expect.arrayContaining(["Often linked with the harbour clean-up campaign", "Brand partnership: Brand Oak"]));
    expect(r.positioningDesired).toEqual({ value: "Be known as the rower who builds the next crew", source: "objective", basis: [{ kind: "objective", id: ids.positioning }] });
    expect(r.chaptersNext).toMatchObject({ text: "Be known as the rower who builds the next crew", framing: "intent" });
    expect(r.howToBeUnderstood!.value).toBe("Be understood as a builder of young rowers");
    expect(r.ambitions.map((x) => x.source)).toEqual(expect.arrayContaining(["objective", "direction", "statement"]));
    expect(r.guardrails.map((x) => [x.kind, x.text])).toEqual(expect.arrayContaining([["never_post", "family"], ["avoid_language", "prodigy"], ["exclusivity", "Brand Oak: No competing water-sports brands"]]));
    expect(r.unresolved.map((x) => x.reason)).toEqual(["disputed", "unconfirmed"]);
  });
});

describe("I4–I6 run, persistence, supersession", () => {
  it("I4 before the first 0.2 recompute, /me/story reads the 0.1 row as essence", async () => {
    const s = await withFlag(true, () => story(ids.full));
    expect(s.body).toMatchObject({ contract: "identity-intelligence/0.2", pageState: "ready" });
    expect(s.body.essence).toMatchObject({ short: "A rower at Lakeside College.", long: "A rower at Lakeside College." });
    expect(s.body.positioning.desired!.value).toBe("Be known as the rower who builds the next crew");
  });

  it("I5 the prompt carries the approved text and sections; repaired once; persisted as 0.2, superseding the 0.1 row", async () => {
    const provider = jest.fn(repairingProvider);
    const r = await runIdentityIntelligence(ids.full, { synthesize: provider, now: NOW });
    expect(r.validation.map((v) => v.errors)).toEqual([expect.arrayContaining([expect.stringMatching(/essence cites E99, which is not a supplied item id/)]), []]);
    expect(r.outcome).toBe("persisted");
    expect(r.supersededEntryId).toBe(ids.v01);
    const prompt = provider.mock.calls[0][0].prompt;
    expect(prompt.startsWith(PROMPT_TEXT)).toBe(true);
    expect(prompt).toMatch(/\nW\d+ \[source_read · video · Outlet One · 2026-09-01 · at 1:35 · topics motivation\] "I row because the quiet/);
    expect(prompt).toMatch(/\nP\d+ \[signature moment\] Stroked the winning crew/);
    expect(prompt).toMatch(/\nD\d+ \[goal\] The athlete's positioning goal \(intent, not a title\): Be known as the rower/);
    expect(prompt).toContain('Never use: "prodigy"');
    expect(provider.mock.calls[1][0].prompt).toMatch(/CHECKS IT FAILED[\s\S]*E99/);

    // every model answer is kept with its errors; the prompt on attempt 0 only
    const attempts = await attemptRows(r.runId!);
    expect(attempts.map((a) => [a.attempt, a.passed, a.errors.length > 0])).toEqual([[0, false, true], [1, true, false]]);
    expect(attempts[0]).toMatchObject({ athlete_id: ids.full, input_version: r.inputVersion, prompt_version: "identity-synthesis-prompt/0.7", validation_version: "identity-validation/1", model: "stub-model" });
    expect(attempts[0].prompt!.startsWith(PROMPT_TEXT)).toBe(true);
    expect(attempts[0].response).toContain('"E99"');
    expect(attempts[1].prompt).toBeNull();

    const rows = await ledgerRows(ids.full);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.id === ids.v01)!.superseded_by).toBe(r.entryId);
    const row = rows.find((x) => x.id === r.entryId)!;
    expect(row).toMatchObject({ subject_type: "athlete", kind: "ASSESSMENT", superseded_by: null, confidence: null });
    expect(row.versions).toMatchObject({ contract: "identity-intelligence/0.2", policy: "identity-admissibility/0.2", prompt: "identity-synthesis-prompt/0.7", validation: "identity-validation/1", model: "stub-model", modelVersion: "stub-1" });
    expect(row.inputs).toEqual([expect.objectContaining({ owner: "marketability", path: "marketability.assessment" })]);
    const v = row.value as unknown as IdentityIntelligenceRecord;
    expect(v.contract).toBe("identity-intelligence/0.2");
    expect(v.essence).toMatchObject({ short: "Lakeside College rower and crew captain", strength: "established" });
    expect(v.motivation).toMatchObject({ text: "The quiet of the water.", basis: [{ kind: "evidence", id: ids.quote }], strength: "reported" });
    expect(v.pillars[0]).toMatchObject({ key: "competitor", proof: [`fact:${ids.nationalFact}`, `evidence:${ids.signature}`] });
    expect(v.positioning.desired!.value).toBe("Be known as the rower who builds the next crew");
    expect(v.chapters.next).toMatchObject({ framing: "intent" });
    expect(v.chapters.origin).toMatchObject({ text: "Grew up on the harbour." });
    expect(v.chapters.now).toMatchObject({ text: "Rowing for Lakeside College.", strength: "established" });
    expect(v.standsFor).toBeNull();
    expect(v.proofPoints.length).toBeGreaterThan(2);
    expect(v.inputVersion).toBe(r.inputVersion);
    expect(v.claims.length).toBeGreaterThan(5);
  });

  it("I6 skips an unchanged inputVersion without calling the provider; a change supersedes", async () => {
    const provider = jest.fn(repairingProvider);
    const skipped = await runIdentityIntelligence(ids.full, { synthesize: provider, now: NOW });
    expect(skipped.outcome).toBe("skipped_unchanged");
    expect(provider).not.toHaveBeenCalled();

    const [first] = (await ledgerRows(ids.full)).filter((x) => x.superseded_by === null);
    await recordAssertions({ athleteId: ids.full, runId: null, mode: "form", source: "settings", corrections: [{ field: "hobbies", value: ["woodworking"] }] });
    const again = await runIdentityIntelligence(ids.full, { synthesize: provider, now: NOW });
    expect(again.outcome).toBe("persisted");
    expect(again.supersededEntryId).toBe(first.id);
    expect((await ledgerRows(ids.full)).filter((x) => x.superseded_by === null).map((x) => x.id)).toEqual([again.entryId]);
  });

  it("I6 a draft that still fails after one repair persists nothing and keeps the previous row", async () => {
    const before = await ledgerRows(ids.full);
    const provider = jest.fn(alwaysBad);
    const r = await runIdentityIntelligence(ids.full, { synthesize: provider, now: NOW, force: true });
    expect(r.outcome).toBe("validation_failed");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(r.reason).toMatch(/motivation must cite at least one HER WORDS item/);
    expect(await ledgerRows(ids.full)).toEqual(before);
    // the record is atomic, but both rejected answers are kept for inspection
    const attempts = await attemptRows(r.runId!);
    expect(attempts.map((a) => [a.attempt, a.passed])).toEqual([[0, false], [1, false]]);
    expect(attempts[1].errors).toEqual(r.validation[1].errors);
  });

  it("I6 an answer cut off by the output budget says so in the validation report", async () => {
    const before = await ledgerRows(ids.full);
    const provider = jest.fn(async () => ({ text: '{"essence": {"short": "An ath', model: "m", finishReason: "MAX_TOKENS" }));
    const r = await runIdentityIntelligence(ids.full, { synthesize: provider, now: NOW, force: true });
    expect(r.outcome).toBe("validation_failed");
    expect(r.validation[0].errors).toContain("the answer is not a JSON object");
    expect(r.validation[0].errors.join(" ")).toMatch(/stopped with MAX_TOKENS after \d+ characters/);
    expect(await ledgerRows(ids.full)).toEqual(before);
  });
});

describe("I7 sufficiency", () => {
  it("a sparse athlete gets no generated statement and the learning state", async () => {
    const provider = jest.fn(repairingProvider);
    const r = await runIdentityIntelligence(ids.sparse, { synthesize: provider, now: NOW });
    expect(r.outcome).toBe("insufficient");
    expect(provider).not.toHaveBeenCalled();
    const s = await withFlag(true, () => story(ids.sparse));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ contract: "identity-intelligence/0.2", pageState: "learning", essence: null, positioning: { current: null, desired: null }, pillars: [] });
    expect(s.body.sufficiency!.reasons.join(" ")).toMatch(/says who the athlete is as an athlete/);
  });
});

describe("I8 GET /me/story 0.2", () => {
  it("401 without a session; unavailable with the flag off", async () => {
    expect((await story(null)).status).toBe(401);
    const s = await withFlag(false, () => story(ids.full));
    expect(s.body).toMatchObject({ contract: "identity-intelligence/0.2", pageState: "unavailable", essence: null, pillars: [], proofPoints: [] });
  });

  it("ready: synthesised parts from the ledger row, rules parts live", async () => {
    const s = await withFlag(true, () => story(ids.full));
    expect(s.body.pageState).toBe("ready");
    expect(s.body.essence).toMatchObject({ short: "Lakeside College rower and crew captain", long: "A Lakeside College rower and crew captain, at home on the water.", strength: "established" });
    expect(s.body.positioning.current!.short).toBe("A crew-minded rower from a harbour town");
    expect(s.body.positioning.desired!.value).toBe("Be known as the rower who builds the next crew");
    expect(s.body.pillars[0].label).toBe("Competitor");
    expect(s.body.signatureMoments.length).toBe(2);
    expect(s.body.direction.map((d) => d.value)).toEqual(expect.arrayContaining(["Start a coaching business for young rowers"]));
    expect(s.body.voice.contentThemes).toContain("training");
    expect(s.body.unresolved.length).toBe(2);
    expect(JSON.stringify(s.body)).not.toMatch(/verified/i);

    // athleteStatements: HER WORDS as the envelope selected them, verbatim, with the source and what cites each one.
    const byId = Object.fromEntries(s.body.athleteStatements.map((x) => [x.id, x]));
    expect(byId[`evidence:${ids.quote}`]).toMatchObject({
      text: "I row because the quiet of the water clears my head before anything else", truncated: false, provenance: "source_read", medium: "video", topics: ["motivation"],
      source: { outlet: "Outlet One", title: "Morning interview", url: `https://outlet-one.example/athlete_statement` },
    });
    expect(byId[`evidence:${ids.quote}`].citedBy).toEqual(expect.arrayContaining(["motivation", "personality:0"]));
    expect(byId[`said:assertion:${ids.hometown}`]).toMatchObject({ text: "I grew up rowing on the harbour every single morning", provenance: "her_own", medium: "form", topics: ["origin"], citedBy: expect.arrayContaining(["chapters.origin", "origin"]) });
    expect(byId[`said:objective:${ids.positioning}`]).toMatchObject({ intent: true, medium: "objective", citedBy: ["positioningDesired"] });
    expect(byId[`media_asset:${ids.caption}`]).toMatchObject({ medium: "caption", source: { platform: "instagram", url: "https://instagram.example/p/1" }, citedBy: expect.arrayContaining(["positioningCurrent", "value:0"]) });
    const texts = s.body.athleteStatements.map((x) => x.text).join("\n");
    expect(texts).not.toMatch(/SENTINEL/);
  });

  it("her approved essence is pinned while its basis stands; a part citing a denied item is withheld", async () => {
    await recordAssertions({ athleteId: ids.full, runId: null, mode: "form", source: "settings", corrections: [{ field: "identity.approved_statement", value: { target: "identityStatement", text: "Lakeside rower, crew captain.", basis: [{ kind: "fact", id: ids.teamFact }] } as any }] });
    await recordAssertions({ athleteId: ids.full, runId: null, mode: "form", source: "settings", corrections: [{ field: "claim_confirmation", value: { ref: { kind: "media_asset", id: ids.caption }, answer: "no" } }] });
    const s = await withFlag(true, () => story(ids.full));
    expect(s.body.essence).toMatchObject({ short: "Lakeside rower, crew captain.", long: "Lakeside rower, crew captain.", pinned: true, strength: "athlete_approved" });
    expect(s.body.approved).toHaveProperty("essence");
    expect(s.body.positioning.current).toBeNull();                       // it cited the caption she denied
    expect(s.body.values).toEqual([]);                                   // so did the only value
    expect(s.body.guardrails.map((x) => x.kind)).toContain("denied");

    await recordAssertions({ athleteId: ids.full, runId: null, mode: "form", source: "settings", corrections: [{ field: "dispute", value: { entryRef: { kind: "fact", id: ids.teamFact }, said: "not the captain any more" } }] });
    const after = await withFlag(true, () => story(ids.full));
    expect(after.body.essence?.pinned ?? false).toBe(false);             // the pin's basis was denied
    expect(after.body.essence).toBeNull();                               // and the synthesised essence cited it too
  });
});

describe("I9 governance writes", () => {
  it("a dispute or confirmation supersedes only the earlier one about the same target, and never reaches latestAssertions", async () => {
    const a = await seedAthlete("Governance Example");
    const write = (field: any, value: any) => recordAssertions({ athleteId: a, runId: null, mode: "form", source: "settings", corrections: [{ field, value }] });
    await write("claim_confirmation", { ref: { kind: "fact", id: "f-1" }, answer: "yes" });
    await write("claim_confirmation", { ref: { kind: "fact", id: "f-2" }, answer: "no" });
    await write("claim_confirmation", { ref: { kind: "fact", id: "f-1" }, answer: "no" });
    const live = await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, a), eq(athleteAsserted.field, "claim_confirmation")));
    const current = live.filter((r) => r.superseded_by === null).map((r) => (r.value as any).object);
    expect(current).toHaveLength(2);
    expect(current).toEqual(expect.arrayContaining([{ ref: { kind: "fact", id: "f-1" }, answer: "no" }, { ref: { kind: "fact", id: "f-2" }, answer: "no" }]));
    await expect(write("claim_confirmation", { ref: { kind: "nope" }, answer: "yes" })).rejects.toThrow(/ref is required/);
    await write("identity.avoid_language", ["prodigy"]);
    expect((await latestAssertions(a)).map((x) => x.field)).toEqual([]);
    const env = await buildIdentityEnvelope(a, NOW);
    expect(env.directives.avoidLanguage).toEqual(["prodigy"]);
    expect([...env.verdicts.denied].sort()).toEqual(["fact:f-1", "fact:f-2"]);
  });
});

describe("I10 the admin seam", () => {
  it("runs once synchronously and returns the result with its validation report", async () => {
    (callIdentitySynthesis as jest.Mock).mockImplementation(repairingProvider);
    const full = await fetch(`${base}/api/v1/admin/intelligence/athletes/${ids.full}/identity-intelligence/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) });
    expect(full.status).toBe(200);
    const fb = await full.json();
    expect(fb).toMatchObject({ athleteId: ids.full, sufficiency: { met: true } });
    expect(Array.isArray(fb.validation)).toBe(true);
    expect(callIdentitySynthesis).toHaveBeenCalled();
    const r = await fetch(`${base}/api/v1/admin/intelligence/athletes/${ids.sparse}/identity-intelligence/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "insufficient", entryId: null, validation: [], sufficiency: { met: false } });
    const missing = await fetch(`${base}/api/v1/admin/intelligence/athletes/00000000-0000-4000-8000-000000000000/identity-intelligence/recompute`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("I3b (Oct 2026) a role belongs to its team", () => {
  it("her said team carries no role, so another affiliation's role is never borrowed", async () => {
    const a = await seedAthlete("Rowan Example");
    await db.insert(athleteFacts).values({ athlete_id: a, fact_key: "affiliation", value: { org: "Summer Program", orgKind: "school", role: "camp counselor", season: 2026 } as any, value_text: "summer program school 2026", status: "current", retrieved_at: T1, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: { evidenceIds: [], domains: ["lakeside.example"] } as any, freshness_family: "affiliations", resolver_version: "v3", registry_version: "v3" } as any);
    await recordAssertions({ athleteId: a, runId: null, mode: "chat", source: "chat", corrections: [{ field: "affiliations", value: [{ org: "Lakeside College", kind: "school", level: "varsity", from: "2023", primary: true }] as any }] });
    const r = (await buildIdentityEnvelope(a, NOW)).rules;
    expect(r.athleticIdentity.team).toMatchObject({ value: "Lakeside College" });
    expect(r.athleticIdentity.level).toMatchObject({ value: "varsity" });
    expect(r.athleticIdentity.role).toBeNull();
  });
});

describe("I3c (Oct 2026) the automatic refresh's retry cap", () => {
  it("inputs already answered with no passing attempt are not re-asked; any passing attempt, or new inputs, re-open them", async () => {
    const a = await seedAthlete("Cap Example");
    const attempt = (inputVersion: string, passed: boolean) => db.insert(identityIntelligenceAttempts).values({ run_id: crypto.randomUUID(), athlete_id: a, attempt: 0, input_version: inputVersion, prompt_version: "p", validation_version: "v", response: "{}", errors: passed ? [] : ["x"], passed } as any);
    expect(await failedBefore(a, "in-1")).toBe(false);   // never tried
    await attempt("in-1", false);
    expect(await failedBefore(a, "in-1")).toBe(true);
    expect(await failedBefore(a, "in-2")).toBe(false);   // her next change re-opens it
    await attempt("in-1", true);
    expect(await failedBefore(a, "in-1")).toBe(false);   // a repair passed
  });
});
