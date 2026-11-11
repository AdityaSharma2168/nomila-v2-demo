/**
 * miaPreview.db.test.ts — the M.I.A. preview end to end on PGlite, with EVERY RETIRING TABLE DROPPED.
 *
 * The retiring tables (athlete_facts, research_*, athlete_research_state, athlete_inferences, identity_intelligence_*)
 * are dropped before anything runs, so a single query against any of them fails the suite. Then, for made-up athletes:
 *
 *   1. getMiaPreview: memory (said name/sport + found facts) → the memory adapter → the REAL evaluator path (frozen
 *      params, parser, facts-only enforcement, scorer, ledger; only callEvaluator is replaced by a made-up answer that
 *      cites the prompt's own fact ids) → score, four groups, preliminary, public inputs, "connect to sharpen". The
 *      prompt is the facts-only one (the only evaluator since 4 Nov 2026: M.I.A. never searches).
 *   2. Unchanged memory ⇒ the answer is reused: no second provider call.
 *   3. A disputed identity fact ⇒ withheld: no provider call, no score; My Intelligence withholds it too (from memory,
 *      not athlete_research_state).
 *   4. Connected data arrives (the social_sync hook) ⇒ measured facts are synced into memory, the EXISTING refresh path
 *      (requestEvaluation → mia_evaluation workflow) re-evaluates through the adapter, and the read is no longer
 *      preliminary.
 *   5. Any sport, any stage: a youth and a pro athlete in different sports go through the same code.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

const callEvaluator = jest.fn();
jest.mock("../marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, closeTestDb, db, initTestDb, seedConnection } from "../../testUtils/pgliteDb";
import { athletes, memoryFactReviews, memoryFacts, miaEvaluationRuns, miaEvidenceSnapshots, socialAnalyticsSnapshots, socialFeatures } from "../../../shared/schema";
import { FEATURE_CALCULATION_VERSION } from "../intelligence/social/metrics";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../marketabilityBeta1Params";
import { BETA1_GOLDENS_PATH } from "../marketabilityBeta1Freeze";
import { MIA_DEBOUNCE_MS } from "../marketabilityBeta1Orchestrator";
import { buildMyIntelligence, myIntelligenceEntry } from "../intelligence/views/myIntelligence";
import { configureRunner, getRun, resetRunnerConfig, tick } from "../../workflow/runner";
import "../../workflow/definitions/index";
import { getMiaPreview, readMiaPreview, requestMemoryRecompute } from "./preview";
import { FACTS_HEADING, factRefs } from "./factsOnlySpec";
import { factsEvaluatorChoice, setFactsEvaluatorTransport } from "./factsOnlyOpenAI";

jest.setTimeout(180_000);

/** Every table the switch map retires. Dropped, so the preview path cannot read one without failing. */
const RETIRING = /^(research_|identity_intelligence)|^(athlete_facts|athlete_inferences|athlete_research_state)$/;

const bundle = JSON.parse(readFileSync(BETA1_GOLDENS_PATH, "utf8")) as { athletes: { key: string }[] };
const ARTIFACTS = join(__dirname, "..", "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini");
/** A frozen raw evaluator response (its text is the judgements; the athlete it was about is irrelevant here). */
function frozenCall(i = 0) {
  const raw = JSON.parse(readFileSync(join(ARTIFACTS, `${bundle.athletes[i].key}.dev37.raw.json`), "utf8").replace(/\r\n/g, "\n"));
  return {
    model: raw.model, modelVersion: raw.modelVersion ?? null, responseId: raw.responseId ?? null,
    latencyMs: raw.latencyMs ?? 0, finishReason: raw.finishReason ?? null, truncated: !!raw.truncated,
    usage: raw.usage ?? { promptTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null, searchCalls: null },
    costUsd: raw.costUsd ?? 0, text: raw.text, native: raw.native ?? {},
  };
}

/** A made-up facts-only answer: every signal scored from the prompt's first fact reference (F1 as the prompt shows it; care and context lines aside). */
function factsAnswerFor(prompt: string) {
  const id = /^- \[(F\d+|[0-9a-f-]{36})\]/m.exec(prompt)?.[1];
  const dims: any = {};
  for (const [d, sw] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
    dims[d] = {};
    for (const k of Object.keys(sw)) dims[d][k] = id ? { status: "scored", score: 62, confidence: "MEDIUM", evidence_ids: [id], rationale: "From the facts." } : { status: "missing" };
  }
  const json = { athlete: { identity_confidence: "HIGH" }, marketability_summary: "From the facts.", evidence: id ? [{ id, claim: "c", source_url: "https://example.org/x" }] : [], dimensions: dims };
  return { ...frozenCall(), text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, native: { groundingChunks: [], groundingSupports: [], webSearchQueries: [] }, costUsd: 0.17 };
}

async function seedMemoryAthlete(name: string, sport: string, found: Array<{ claim: string; url: string; confidence?: number; kind?: string; subject?: string }>) {
  const [row] = await db.insert(athletes).values({ full_name: name, sport } as any).returning({ id: athletes.id });
  const base = { athlete_id: row.id, subject_kind: "athlete", subject_name: name, confidence: 1 };
  await db.insert(memoryFacts).values([
    { ...base, claim: `The athlete's name is ${name}.`, type: "said", source_ref: "onboarding/run#name", source_title: "You told us" },
    { ...base, claim: `${name}'s sport is ${sport}.`, type: "said", source_ref: "onboarding/run#sport", source_title: "You told us" },
    ...found.map((f) => ({ ...base, subject_kind: f.kind ?? "athlete", subject_name: f.subject ?? name, claim: f.claim, type: "found", source_url: f.url, source_title: "Public page", confidence: f.confidence ?? 0.8, observed_on: "2026-09-20" })),
  ] as any);
  return row.id;
}

let now = new Date("2026-10-09T10:00:00.000Z");

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({
    engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0,
    priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "mia-preview-test",
  });
  const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename);
  const retiring = tables.filter((t) => RETIRING.test(t));
  expect(retiring).toEqual(expect.arrayContaining(["athlete_facts", "athlete_research_state", "research_evidence", "research_runs", "athlete_inferences", "identity_intelligence_attempts"]));
  for (const t of retiring) await client.exec(`DROP TABLE "${t}" CASCADE`);
});
afterAll(closeTestDb);

beforeEach(() => {
  callEvaluator.mockReset();
  callEvaluator.mockImplementation(async (prompt: string) => factsAnswerFor(prompt));
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
});

describe("the preview from public memory", () => {
  let athleteId = "";

  test("computes a preliminary M.I.A. from found facts through the existing evaluator and scorer", async () => {
    athleteId = await seedMemoryAthlete("Rowan Vale", "Track and field", [
      { claim: "Won the 400m at a national junior championship.", url: "https://example.org/results", confidence: 0.9 },
      { claim: "Has about 3,200 public Instagram followers.", url: "https://example.org/profile", confidence: 0.6 },
      { claim: "Signed a partnership with a regional running store.", url: "https://example.org/news", kind: "brand", subject: "Run Shop" },
    ]);
    const p = await getMiaPreview(athleteId);

    expect(callEvaluator).toHaveBeenCalledTimes(1);
    const prompt = callEvaluator.mock.calls[0][0] as string;
    expect(prompt).not.toContain("RESEARCH PROCESS");   // facts only: the evaluator never researches
    expect(prompt).toContain("Rowan Vale");
    expect(prompt).toContain(FACTS_HEADING);
    expect(prompt).toContain("Won the 400m at a national junior championship.");
    expect(prompt).not.toContain("The athlete's name is");   // said facts are never evaluator input

    expect(p).toMatchObject({ contract: "mia-preview/1", status: "ready", computed: "evaluated", preliminary: true, label: "Preliminary — connect to sharpen" });
    expect(typeof p.score).toBe("number");
    expect(p.score!).toBeGreaterThan(0);
    expect(p.score!).toBeLessThanOrEqual(850);
    expect(p.groups.map((g) => g.key)).toEqual(["audience", "commercial", "brand", "performance"]);
    expect(p.groups.some((g) => (g.contribution ?? 0) > 0)).toBe(true);
    // The same shape Home's ring reads: dimensions with stored contributions.
    expect(p.assessment!.dimensions.some((d) => typeof d.contribution === "number")).toBe(true);
    expect(p.confidence.level === null || ["HIGH", "MEDIUM", "LOW"].includes(p.confidence.level)).toBe(true);
    expect(p.inputs.public).toHaveLength(2);   // the partner's own fact (about Run Shop) is CONTEXT in the facts-only input
    expect(p.inputs.measured).toHaveLength(0);
    expect(p.sharpen.filter((s) => s.kind === "connect").map((s) => s.connector)).toEqual(["instagram", "tiktok", "youtube"]);
    expect(p.provenance).toMatchObject({ ledgerEntryId: expect.any(String), snapshotId: expect.any(String), digest: expect.any(String) });

    // Reproducible: the snapshot holds exactly what was sent, and which facts went in.
    const [snap] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, p.provenance!.snapshotId!));
    // The prompt shows each fact under a short reference (F1 …); the snapshot keeps the full fact ids.
    expect(prompt).toContain(factRefs(snap.social_block!).block);
    expect(snap.social_block!).toMatch(/^- \[[0-9a-f-]{36}\] /m);
    expect(prompt).not.toMatch(/^- \[[0-9a-f-]{36}\] /m);
    expect((snap.social_sources as any[]).filter((s) => s.platform === "memory")).toHaveLength(3);
  });

  test("unchanged memory ⇒ the answered evaluation is reused, never re-asked", async () => {
    const p = await getMiaPreview(athleteId);
    expect(callEvaluator).not.toHaveBeenCalled();
    expect(p.computed).toBe("reused");
    expect((await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId)))).toHaveLength(1);
  });

  test("Home's read (My Intelligence) shows it, labelled preliminary", async () => {
    const view = await buildMyIntelligence(athleteId);
    expect(view.identity).toBeNull();
    expect(view.assessment?.score).toBe((await readMiaPreview(athleteId)).score);
    expect(view.preview).toMatchObject({ preliminary: true, label: "Preliminary — connect to sharpen", inputs: { public: 2, measured: 0 } });
    expect(myIntelligenceEntry(view)).toMatchObject({ preliminary: true, score: view.assessment!.score });
  });

  test("the onboarding reveal gets the real preview through the seam (registered on load), read only", async () => {
    const { getMiaPreview: revealSeam } = await import("../../agent/onboarding/miaPreview");
    const card = await revealSeam(athleteId);
    expect(callEvaluator).not.toHaveBeenCalled();
    // The card carries the API's own shape: 0–850, the four groups, the ring's assessment, the label and sharpen steps.
    expect(card).toEqual(await readMiaPreview(athleteId));
    expect(card).toMatchObject({ scale: { min: 0, max: 850 }, preliminary: true, label: "Preliminary — connect to sharpen" });
    expect(card!.assessment!.dimensions.some((d) => typeof d.contribution === "number")).toBe(true);
    expect(card!.sharpen.filter((s) => s.kind !== "evidence").every((s) => typeof s.connector === "string")).toBe(true);
  });

  test("connected data arrives ⇒ measured facts synced, the existing refresh path re-evaluates via the adapter, not preliminary", async () => {
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rowan.runs" });
    await db.insert(socialAnalyticsSnapshots).values({
      athlete_id: athleteId, connected_account_id: connectionId, source: "connected", platform: "instagram",
      snapshot_day: "2026-10-09", followers: 3412, avg_engagement_rate: 4.1, posts_last_30d: 9,
    } as any);

    const req = await requestMemoryRecompute(athleteId);
    expect(req).not.toBeNull();
    const measured = await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId));
    expect(measured.filter((f) => f.type === "measured").map((f) => f.claim)).toEqual(expect.arrayContaining(["Instagram (@rowan.runs) has 3,412 followers."]));

    now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
    for (let i = 0; i < 10 && (await getRun(req!.runId))!.run.status === "running"; i++) await tick();
    const run = (await getRun(req!.runId))!;
    expect(run.run.status).toBe("done");
    expect((run.run.input as any).trigger).toBe("SOCIAL_BLOCK_CHANGED");
    expect(run.steps.find((s) => s.step === "evaluate")!.output).toMatchObject({ status: "ok" });
    expect(callEvaluator).toHaveBeenCalledTimes(1);
    const prompt = callEvaluator.mock.calls[0][0] as string;
    expect(prompt).toContain("- instagram @rowan.runs — source: connected verified");
    expect(prompt).toContain(FACTS_HEADING);

    const p = await readMiaPreview(athleteId);
    expect(p).toMatchObject({ status: "ready", preliminary: false, label: null });
    expect(p.inputs.measured.map((m) => m.platform)).toEqual(expect.arrayContaining(["instagram"]));
    expect(p.sharpen.some((s) => s.kind === "connect" && s.connector === "instagram")).toBe(false);
    expect((await buildMyIntelligence(athleteId)).preview?.preliminary).toBe(false);
  });
});

describe("identity from memory", () => {
  test("a disputed identity fact withholds: no provider call, no score — on the preview and on Home", async () => {
    const athleteId = await seedMemoryAthlete("Kai Morrow", "Volleyball", [{ claim: "Plays for a club team.", url: "https://example.org/club" }]);
    const [record] = await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Kai Morrow", type: "made", status: "disputed", confidence: 0.5,
      claim: "Research could not yet confirm which public profile belongs to Kai Morrow (Volleyball): two people share the name.",
      source_ref: "agent_runs/r1#identity", source_title: "Nomila research",
    } as any).returning({ id: memoryFacts.id });

    const p = await getMiaPreview(athleteId);
    expect(callEvaluator).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: "withheld_identity", score: null, computed: "withheld", identity: { uncertain: true, factIds: [record.id] } });
    const view = await buildMyIntelligence(athleteId);
    expect(view.pageState).toBe("identity_ambiguous");
    expect(view.identity).toMatchObject({ value: "ambiguous", reason: "disputed_identity_fact" });
    expect(view.assessment).toBeNull();

    // She confirms it in the facts review ⇒ settled ⇒ the preview runs.
    await db.insert(memoryFactReviews).values({ athlete_id: athleteId, fact_id: record.id, action: "confirm" } as any);
    const after = await getMiaPreview(athleteId);
    expect(callEvaluator).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("ready");
  });

  test("a score of record, THEN an unresolved identity (a research refresh could not confirm her profile): the last score stays shown, flagged — never hidden — and no new read is made", async () => {
    // Her score of record (the ledger entry Home shows), then a refresh's research leaves a disputed identity fact.
    const athleteId = await seedMemoryAthlete("Ada Brightwater", "Rowing", [{ claim: "Rows in a university eight.", url: "https://example.org/crew" }]);
    const before = await getMiaPreview(athleteId);
    expect(before.status).toBe("ready");
    expect(callEvaluator).toHaveBeenCalledTimes(1);
    const [identity] = await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Ada Brightwater", type: "made", status: "disputed", confidence: 0.5,
      claim: "Research could not yet confirm which public profile belongs to Ada Brightwater (Rowing): two people share the name.",
      source_ref: "agent_runs/r2#identity", source_title: "Nomila research",
    } as any).returning({ id: memoryFacts.id });
    await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Ada Brightwater", type: "found", confidence: 0.8,
      claim: "Rows in a different university eight.", source_url: "https://example.org/crew-2", source_title: "Public page",
    } as any);

    // The preview: the LAST score, flagged (identity uncertain); the evaluation gate makes no new read.
    const p = await getMiaPreview(athleteId);
    expect(callEvaluator).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ status: "ready", score: before.score, identity: { uncertain: true, factIds: [identity.id] } });

    // Home and My Intelligence: shown, never withheld, and flagged.
    const view = await buildMyIntelligence(athleteId);
    expect(view.pageState).not.toBe("identity_ambiguous");
    expect(view.assessment?.score).toBe(before.score);
    expect(view.identityUnconfirmed).toMatchObject({ reason: "disputed_identity_fact" });
    expect(myIntelligenceEntry(view)).toMatchObject({ score: before.score, identityUnconfirmed: true });
  });
});

describe("the facts-only evaluator (default provider gemini): M.I.A. from our facts, no web search", () => {
  const OLD_PROVIDER = process.env.MIA_FACTS_EVALUATOR_PROVIDER;
  // The provider setting is UNSET here: the default is the Gemini facts-only call (facts-eval-spec/0.4.0). The OpenAI
  // opt-in has its own block below.
  beforeAll(() => { delete process.env.MIA_FACTS_EVALUATOR_PROVIDER; });
  afterAll(() => {
    if (OLD_PROVIDER === undefined) delete process.env.MIA_FACTS_EVALUATOR_PROVIDER; else process.env.MIA_FACTS_EVALUATOR_PROVIDER = OLD_PROVIDER;
  });

  /**
   * A made-up answer that cites the prompt's own fact references (F1 …): every signal from the first plain fact;
   * brand_safety from the personal care fact AND the conduct fact; one momentum signal from the personal care fact.
   */
  function factsAnswer(prompt: string, careClaim: string, conductClaim: string) {
    const ids = [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]);
    const refOf = (claim: string) => new RegExp(`^- \\[(F\\d+)\\] ${claim}`, "m").exec(prompt)![1];
    const careId = refOf(careClaim), conductId = refOf(conductClaim);
    const plain = ids.find((id) => id !== careId && id !== conductId)!;
    const dims: any = {};
    for (const [d, s] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
      dims[d] = {};
      for (const k of Object.keys(s)) {
        const cite = d === "brand_fit" && k === "brand_safety" ? [careId, conductId] : d === "momentum" && k === "athletic_trajectory" ? [careId] : [plain];
        dims[d][k] = { status: "scored", score: 62, confidence: "MEDIUM", evidence_ids: cite, rationale: "From the facts." };
      }
    }
    const json = { athlete: { identity_confidence: "HIGH" }, marketability_summary: "From the facts.", evidence: [plain, careId, conductId].map((id) => ({ id, claim: "c", source_url: "https://example.org/x" })), dimensions: dims };
    return { ...frozenCall(), text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, native: { groundingChunks: [], groundingSupports: [], webSearchQueries: [] }, costUsd: 0.17 };
  }

  test("no search tool, no RESEARCH PROCESS; personal care momentum-only, conduct may inform brand_safety; care_kind stored; new versions", async () => {
    const athleteId = await seedMemoryAthlete("Sol Arden", "Rowing", [
      { claim: "Rows in the first boat for a college team.", url: "https://example.org/roster", confidence: 0.9 },
      { claim: "Was selected for a national under-23 squad.", url: "https://example.org/squad" },
    ]);
    const [care] = await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Sol Arden", type: "found", confidence: 0.9, sensitive: true, care_kind: "personal",
      claim: "Missed the spring season with a back injury.", source_url: "https://example.org/injury", source_title: "Public page", observed_on: "2026-09-25",
    } as any).returning({ id: memoryFacts.id });
    const [conduct] = await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Sol Arden", type: "found", confidence: 0.9, sensitive: true, care_kind: "conduct",
      claim: "Was suspended for one race after an official review.", source_url: "https://example.org/review", source_title: "Public page", observed_on: "2026-09-26",
    } as any).returning({ id: memoryFacts.id });
    // The column holds its check: only personal | conduct.
    await expect(db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Sol Arden", type: "found", confidence: 0.9, sensitive: true, care_kind: "other",
      claim: "x", source_url: "https://example.org/x",
    } as any)).rejects.toThrow();
    callEvaluator.mockImplementation(async (prompt: string) => factsAnswer(prompt, "Missed the spring season", "Was suspended for one race"));

    const p = await getMiaPreview(athleteId);
    expect(callEvaluator).toHaveBeenCalledTimes(1);
    const [prompt, opts] = callEvaluator.mock.calls[0];
    expect(opts).toBeUndefined();   // the one call there is: no tools (there is no search option any more)
    expect(prompt).not.toContain("RESEARCH PROCESS");
    expect(prompt).toContain("Score only from the FACTS provided; mark a sub-signal missing when the facts don't support it.");
    expect(prompt).toMatch(/^- \[F\d+\] Missed the spring season/m);
    expect(prompt).not.toContain(care.id);
    expect(prompt.indexOf("Missed the spring season")).toBeGreaterThan(prompt.indexOf("CARE FACTS — PERSONAL (MOMENTUM ONLY)\n"));
    expect(prompt.indexOf("Was suspended for one race")).toBeGreaterThan(prompt.indexOf("CARE FACTS — CONDUCT (MAY INFORM BRAND SAFETY AND MOMENTUM)\n"));
    expect(prompt).toContain("Do not infer private commercial values unless explicitly published.");
    expect(prompt).not.toContain("The athlete's name is");   // said facts are still never evaluator input

    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
    expect(run).toMatchObject({ status: "ok", evaluator_version: "facts-eval-spec/0.4.1" });
    const j = (run.judgements as any).judgements as Array<{ dimension: string; key: string; status: string; evidenceIds: string[] }>;
    expect(j.find((x) => x.key === "brand_safety")).toMatchObject({ status: "scored", evidenceIds: [conduct.id] });
    expect(j.find((x) => x.dimension === "momentum" && x.key === "athletic_trajectory")).toMatchObject({ status: "scored", evidenceIds: [care.id] });
    expect((run.raw as any).enforcement.careRemoved).toEqual({ "brand_fit.brand_safety": [care.id] });

    expect(p).toMatchObject({ status: "ready", computed: "evaluated" });
    expect(p.inputs.public).toHaveLength(2);                                  // care facts are never shown as inputs
    expect(p.inputs.public.some((i) => i.factId === care.id || i.factId === conduct.id)).toBe(false);
    const record = await readMiaPreview(athleteId);
    expect(record.assessment).not.toBeNull();
    const { getMarketability } = await import("../marketabilityBeta1Orchestrator");
    expect((await getMarketability(athleteId))!.versions).toMatchObject({ evaluator: "facts-eval-spec/0.4.1", methodology: "v1.0.1-beta.1+facts.1" });
    // The summary came back as one untagged string: 0.4.0 cannot check it, so it is not kept.
    expect((run.raw as any).enforcement.notesDropped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "untagged_summary" })]));
  });

  test("facts about others go under CONTEXT; ONE measured place (memory, latest per metric) that also holds the derived features", async () => {
    const athleteId = await seedMemoryAthlete("Tam Ridley", "Lacrosse", [
      { claim: "Tam Ridley is a starting midfielder for a college team.", url: "https://example.org/roster", confidence: 0.9 },
      { claim: "Casey Teammate joined a footwear brand's NIL roster.", url: "https://example.org/nil", kind: "person", subject: "Casey Teammate" },
      { claim: "Example College lists a drinks brand as an athletics sponsor.", url: "https://example.org/sponsors", kind: "organization", subject: "Example College" },
    ]);
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "tam.lax" });
    // A derived feature (a median engagement rate): it reaches the M.I.A. only through memory.
    await db.insert(socialFeatures).values({
      athlete_id: athleteId, platform: "instagram", feature_key: "engagement_per_follower_median", value: "0.0620", unit: "ratio", window_days: 30,
      as_of: new Date("2026-10-08T00:00:00.000Z"), source_class: "connected_verified", confidence: "0.90", calculation_version: FEATURE_CALCULATION_VERSION, inputs: {},
    } as any);
    // Two readings of the same metric in memory: only the newest is evaluator input.
    const measured = (claim: string, snap: string, day: string) => ({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: "Tam Ridley", type: "measured", confidence: 1, claim,
      source_ref: `social_analytics_snapshots/${snap}#instagram.avg_engagement_rate`, source_title: "Connected Instagram account", observed_on: day,
    });
    await db.insert(memoryFacts).values([measured("Instagram (@tam.lax) posts average a 4.10% engagement rate.", "s-old", "2026-09-01"), measured("Instagram (@tam.lax) posts average a 4.80% engagement rate.", "s-new", "2026-10-09")] as any);
    expect(connectionId).toBeTruthy();
    callEvaluator.mockImplementation(async (prompt: string) => {
      const ids = [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]);
      const dims: any = {};
      for (const [d, s] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
        dims[d] = {};
        for (const k of Object.keys(s)) dims[d][k] = { status: "scored", score: 55, confidence: "MEDIUM", evidence_ids: [ids[0]], rationale: "r" };
      }
      const json = {
        dimensions: dims, evidence: [{ id: ids[0], claim: "c" }],
        key_strengths: [{ text: "A starting role on a college team.", dimension: "athletic_authority", evidence_ids: [ids[0]] }],
        marketability_summary: [{ text: "A college starter.", dimension: "athletic_authority", evidence_ids: [ids[0]] }],
      };
      return { ...frozenCall(), text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, native: { groundingChunks: [], groundingSupports: [], webSearchQueries: [] } };
    });

    const p = await getMiaPreview(athleteId);
    expect(p.status).toBe("ready");
    const prompt = callEvaluator.mock.calls[0][0] as string;
    const contextAt = prompt.indexOf("CONTEXT — ABOUT OTHERS: never a fact about this athlete\n");
    expect(contextAt).toBeGreaterThan(prompt.indexOf("FACTS NOMILA HOLDS\n"));
    expect(prompt.indexOf("Casey Teammate joined")).toBeGreaterThan(contextAt);
    expect(prompt.indexOf("athletics sponsor")).toBeGreaterThan(contextAt);
    expect(prompt.slice(0, contextAt)).toContain("Tam Ridley is a starting midfielder");
    // One PLACE, no loss: memory's newest snapshot reading (not the older one), and the derived social-features median
    // reaches the M.I.A. too — as a measured memory fact the preview synced first, pointing back to its source row.
    expect(prompt).toContain("4.80% engagement rate");
    expect(prompt).not.toContain("4.10% engagement rate");
    expect(prompt).toContain("median engagement per follower (30 days): 6.20%");
    const derived = (await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId))).filter((f) => f.type === "measured" && /^social_features\//.test(f.source_ref ?? ""));
    expect(derived.map((f) => f.claim)).toEqual(["Instagram (@tam.lax) median engagement per follower (30 days): 6.20%."]);
    const [snap] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.athlete_id, athleteId));
    expect((snap.social_sources as any[]).filter((s) => s.sourceClass === "web_researched_context")).toHaveLength(2);
    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
    expect((run.judgements as any).keyStrengths).toEqual(["A starting role on a college team."]);
    expect((run.judgements as any).summary).toBe("A college starter.");
  });

  test("the evaluator's evidence echo left out a cited fact: the run's list is completed from the snapshot, nothing dangles", async () => {
    const athleteId = await seedMemoryAthlete("Kit Moreno", "Fencing", [
      { claim: "Fences sabre for a college team.", url: "https://example.org/team" },
      { claim: "Won a national junior title in sabre.", url: "https://example.org/title" },
    ]);
    const found = await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId));
    const team = found.find((f) => f.claim.startsWith("Fences"))!, title = found.find((f) => f.claim.startsWith("Won"))!;
    await db.update(memoryFacts).set({ source_type: "major_media" } as any).where(eq(memoryFacts.id, title.id));
    callEvaluator.mockImplementation(async () => {
      const dims: any = {};
      for (const [d, s] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
        dims[d] = {};
        for (const k of Object.keys(s)) dims[d][k] = { status: "scored", score: 57, confidence: "MEDIUM", evidence_ids: [team.id, title.id], rationale: "From the facts." };
      }
      // The echo carries the first cited fact only; a made-up id it also lists is not something Nomila sent.
      const json = {
        athlete: { identity_confidence: "HIGH" }, dimensions: dims,
        evidence: [{ id: team.id, claim: "Echoed wording.", source_url: "https://example.org/team", source_type: "secondary" }, { id: "00000000-0000-4000-8000-0000000000ff", claim: "x" }],
        marketability_summary: [{ text: "A national junior champion.", dimension: "athletic_authority", evidence_ids: [title.id] }],
        key_strengths: [], key_constraints: [], important_missing_data: [], identity_or_evidence_risks: [],
      };
      return { ...frozenCall(), text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, native: { groundingChunks: [], groundingSupports: [], webSearchQueries: [] }, costUsd: 0.17 };
    });

    const p = await getMiaPreview(athleteId);
    expect(p).toMatchObject({ status: "ready", computed: "evaluated" });
    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
    expect(run).toMatchObject({ status: "ok", evaluator_version: "facts-eval-spec/0.4.1" });
    expect((run.raw as any).evidenceCompleted).toBe(1);
    const evidence = (run.judgements as any).evidence as Array<{ id: string; claim: string; sourceUrl: string | null; sourceType: string | null }>;
    // The echoed item as it came; the omitted fact from the snapshot (its own claim, URL and outlet type); no made-up id.
    expect(evidence).toEqual([
      expect.objectContaining({ id: team.id, claim: "Echoed wording.", sourceType: "secondary" }),
      expect.objectContaining({ id: title.id, claim: "Won a national junior title in sabre.", sourceUrl: "https://example.org/title", sourceType: "major_media" }),
    ]);
    const { getMarketability } = await import("../marketabilityBeta1Orchestrator");
    const value = (await getMarketability(athleteId))!.value as any;
    expect(value.findings.length).toBeGreaterThan(0);
    expect(value.findings.some((f: any) => f.danglingEvidence?.length)).toBe(false);
    expect(value.findings.every((f: any) => f.citedEvidence.includes(title.id))).toBe(true);
  });
});

describe("the facts-only evaluator on OpenAI (opt-in: MIA_FACTS_EVALUATOR_PROVIDER=openai, facts-eval-spec/0.5.0)", () => {
  const OLD_PROVIDER = process.env.MIA_FACTS_EVALUATOR_PROVIDER;
  beforeAll(() => { process.env.MIA_FACTS_EVALUATOR_PROVIDER = "openai"; });
  afterAll(() => {
    setFactsEvaluatorTransport(null);
    if (OLD_PROVIDER === undefined) delete process.env.MIA_FACTS_EVALUATOR_PROVIDER; else process.env.MIA_FACTS_EVALUATOR_PROVIDER = OLD_PROVIDER;
  });

  test("the same prompt goes to OpenAI with no tools and the strict schema; the run records provider, model, effort and 0.5.0; Gemini is never called", async () => {
    const athleteId = await seedMemoryAthlete("Ivo Marr", "Cycling", [
      { claim: "Won a national under-23 road title.", url: "https://example.org/u23", confidence: 0.9 },
    ]);
    const requests: Array<Record<string, any>> = [];
    setFactsEvaluatorTransport({
      create: async (params) => {
        requests.push(params);
        const ids = [...String(params.input).matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]);
        const dims: any = {};
        for (const [d, sub] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
          dims[d] = {};
          for (const k of Object.keys(sub)) dims[d][k] = { status: "scored", score: 58, confidence: "MEDIUM", evidence_ids: [ids[0]], rationale: "From the facts." };
        }
        const json = {
          athlete: { name: "Ivo Marr", sport: "Cycling", identity_confidence: "HIGH" }, dimensions: dims,
          evidence: [{ id: ids[0], claim: "c", source_title: null, source_url: "https://example.org/u23", source_type: "secondary", published_or_observed_date: null, retrieved_at: null, notes: null }],
          marketability_summary: [{ text: "A national under-23 champion.", dimension: "athletic_authority", evidence_ids: [ids[0]] }],
          key_strengths: [], key_constraints: [], important_missing_data: [], identity_or_evidence_risks: [],
        };
        const response = {
          id: "resp_test", model: "gpt-test", status: "completed",
          output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(json) }] }],
          usage: { input_tokens: 20000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 6000, output_tokens_details: { reasoning_tokens: 2000 }, total_tokens: 26000 },
        };
        return (async function* () { yield { type: "response.completed", response }; })();
      },
    });

    const p = await getMiaPreview(athleteId);
    expect(p.status).toBe("ready");
    expect(callEvaluator).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(requests[0].reasoning).toEqual({ effort: "low" });
    expect(requests[0].input).toContain("Score only from the FACTS provided; mark a sub-signal missing when the facts don't support it.");
    expect(requests[0].input).toContain("FACTS-ONLY ADDITIONS (facts-eval-spec/0.4.0)");

    const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
    expect(run).toMatchObject({ status: "ok", evaluator_version: "facts-eval-spec/0.5.1", provider: "openai" });
    expect(run.model).toBe(factsEvaluatorChoice().model);
    expect((run.raw as any).conditions).toMatch(/^openai responses; model=.+; effort=low; no-tools \(facts only\); strict json_schema$/);
    expect((run.raw as any).native.config).toMatchObject({ provider: "openai", effort: "low", tools: [] });
    expect((run.judgements as any).summary).toBe("A national under-23 champion.");
    const { getMarketability } = await import("../marketabilityBeta1Orchestrator");
    expect((await getMarketability(athleteId))!.versions).toMatchObject({ evaluator: "facts-eval-spec/0.5.1", methodology: "v1.0.1-beta.1+facts.1" });
  });
});

describe("no hard-coding: any sport, any stage", () => {
  test.each([
    ["Ari Quinn", "Swimming", "Set a state age-group record at 14."],
    ["Dana Ilves", "Basketball", "Plays in a professional league and has a signature shoe."],
  ])("%s (%s)", async (name, sport, claim) => {
    const athleteId = await seedMemoryAthlete(name, sport, [{ claim, url: "https://example.org/x" }]);
    const p = await getMiaPreview(athleteId);
    expect(p.status).toBe("ready");
    expect(p.groups).toHaveLength(4);
    expect(callEvaluator.mock.calls[0][0]).toContain(name);
    expect(callEvaluator.mock.calls[0][0]).toContain(sport);
  });
});

