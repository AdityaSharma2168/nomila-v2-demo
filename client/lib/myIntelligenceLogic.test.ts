/**
 * myIntelligenceLogic.test.ts — the pure presentation helpers behind Concept 0.4 Slice 2 My Intelligence + the Me card.
 *
 * Pinned:
 *   • the answer is templated from State's strength / gap conclusions as served (O-1); canonical order, never by score
 *   • "thinnest" ≠ "weakest": an unknown dimension is never listed as thinnest; neutral is never named
 *   • labels are State's conclusions as words + glyph; neutral gets none; unknown shows "—" (O-2 / O-3)
 *   • HIGH/MEDIUM/LOW → Confident / Fairly confident / Less certain (O-8)
 *   • the evidence sheet groups the server's buckets in order, not_support collapsed and never counted (O-5)
 *   • every pageState and every identity reason has its frozen copy; no identity action exists (D-2 / D-3)
 *   • the Me card shows a number only when the overview entry carries one (parity with the page, O-6 / O-10)
 */

import {
  ANSWER_INSUFFICIENT, ANSWER_NOTHING_SHARP, CITATION_GROUPS, COPY, DIMENSIONS, HEALTH_SENSITIVE_SIGNALS, HELP_COPY, HIDDEN_CITATION_STRENGTHS,
  MARKETABLE_ROW_MAX, MEASUREMENT_QUALITY_SIGNALS,
  answerFor, answerText, arcFraction, bridgeModel, componentLabel, confidenceLine, confidenceWord, connectGaps, dimensionIcon,
  dimensionName, dimensionPosition, dimensionScoreText, evidenceClassLabel, evidenceGroups, goalsFor, helpRows, identityCopy,
  marketableRows, meAnswer, meCardModel, nextCount, pageModel, readDate, resolvableByHer, ringArcs, ringBands, signalPicks, stateLabel, storyProvenance, supportingSourceCount,
} from "./myIntelligenceLogic";
import { Ring } from "../constants/ring";
import type { MyIntelligenceSignal, MyIntelligenceWaitingItem } from "../hooks/use-me-intelligence";
import type { MeStory } from "./meStoryLogic";
import type {
  CitationStrength, FindingDirection, MarketabilityDimension, MyIntelligenceAssessment, MyIntelligenceDimension,
  MyIntelligenceEvidence, MyIntelligenceView,
} from "../hooks/use-me-intelligence";
import type { MyIntelligenceEntry, MyIntelligencePageState } from "../hooks/use-me-knowledge";

const KEYS = DIMENSIONS.map((d) => d.key);
const noSources = (): Record<CitationStrength, string[]> => ({ grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] });

const dim = (key: MarketabilityDimension, state: FindingDirection, score: number | null = state === "unknown" ? null : 60): MyIntelligenceDimension => ({
  key, state, score, confidence: "HIGH", confidenceReason: null, rationale: null, components: [], sources: noSources(),
});
/** Eight dimensions, all neutral unless overridden. */
const dims = (over: Partial<Record<MarketabilityDimension, FindingDirection>> = {}): MyIntelligenceDimension[] =>
  KEYS.map((k) => dim(k, over[k] ?? "neutral"));

const assessment = (over: Partial<MyIntelligenceAssessment> = {}): MyIntelligenceAssessment => ({
  entryId: "e1", evidenceAsOf: "2026-09-29T00:00:00.000Z", createdAt: "2026-09-29T00:00:00.000Z",
  versions: { methodology: "v1", evaluator: "ev", params: "p" }, score: 600, readState: "assessed",
  overall: { level: "HIGH", explanation: "x" }, confidenceBand: null, summary: null, hasReasons: true,
  dimensions: dims({ narrative_power: "strength", brand_fit: "strength", audience_scale: "gap" }), evidence: [],
  notes: { strengths: [], constraints: [], missingEvidence: [], evaluationRisks: [] }, ...over,
});

const view = (over: Partial<MyIntelligenceView> = {}): MyIntelligenceView => ({
  contract: "my-intelligence/0.1", athleteId: "a1", asOf: "2026-10-01T00:00:00.000Z", pageState: "assessed",
  identity: null, inProgress: false, assessment: assessment(),
  movement: { displayable: false, reason: "no_governed_stability_threshold" },
  bridge: { waitingOnYou: null, goals: null, reviewCount: null }, ...over,
});

const ev = (id: string, strength: CitationStrength): MyIntelligenceEvidence => ({
  id, claim: `claim ${id}`, sourceTitle: `title ${id}`, sourceUrl: `https://${id}.example.org/p`, sourceType: null, observedAt: null, strength, domain: `${id}.example.org`,
});

// ── names / icons ──────────────────────────────────────────────────────────

test("eight dimensions, canonical order, O-12 names; Momentum uses the wind icon", () => {
  expect(KEYS).toEqual(["athletic_authority", "audience_scale", "engagement_quality", "cultural_relevance", "narrative_power", "brand_fit", "commercial_proof", "momentum"]);
  expect(dimensionName("brand_fit")).toBe("Brand fit");
  expect(dimensionIcon("momentum")).toBe("wind");
  expect(dimensionIcon("narrative_power")).toBe("book-open");
  expect(dimensionPosition("narrative_power")).toBe(5);
});

// ── the answer (O-1) ──────────────────────────────────────────────────────

test("answer: strongest and thinnest from State's conclusions, in canonical order", () => {
  const a = answerFor(dims({ brand_fit: "strength", athletic_authority: "strength", narrative_power: "strength", audience_scale: "gap" }));
  expect(a.text).toBe("Strongest in athletic authority, narrative power and brand fit. Thinnest in audience scale.");
});

test("answer: list grammar for one and two names", () => {
  expect(answerFor(dims({ brand_fit: "strength" })).text).toBe("Strongest in brand fit.");
  expect(answerFor(dims({ brand_fit: "gap", momentum: "gap" })).text).toBe("Thinnest in brand fit and momentum.");
});

test("answer: is not sorted by score — a higher-scored dimension does not move first", () => {
  const d = dims({ athletic_authority: "strength", brand_fit: "strength" });
  d.find((x) => x.key === "brand_fit")!.score = 99;
  d.find((x) => x.key === "athletic_authority")!.score = 76;
  expect(answerFor(d).strongest).toBe("Strongest in athletic authority and brand fit.");
});

test("unknown is never thinnest; it gets its own sentence", () => {
  const a = answerFor(dims({ narrative_power: "strength", engagement_quality: "unknown", audience_scale: "gap" }));
  expect(a.thinnest).toBe("Thinnest in audience scale.");
  expect(a.thinnest).not.toContain("engagement");
  expect(a.unknown).toBe("Not enough evidence yet on engagement quality.");
  expect(a.text).toBe("Strongest in narrative power. Thinnest in audience scale. Not enough evidence yet on engagement quality.");
  // only unknowns and neutrals: nothing is thinnest
  const b = answerFor(dims({ commercial_proof: "unknown" }));
  expect(b.thinnest).toBeNull();
  expect(b.text).toBe(`${ANSWER_NOTHING_SHARP} Not enough evidence yet on commercial proof.`);
});

test("neutral is never named; the copy never says weak/low/poor", () => {
  const a = answerFor(dims());
  expect(a.text).toBe(ANSWER_NOTHING_SHARP);
  const all = [answerFor(dims({ audience_scale: "gap", momentum: "unknown" })).text, ...Object.values(COPY)].join(" ").toLowerCase();
  expect(all).not.toMatch(/\bweak|\blow\b|\bpoor/);
});

test("answerText uses the server's readState for S3, never a client count", () => {
  expect(answerText(assessment({ readState: "insufficient", dimensions: dims({ brand_fit: "strength" }) }))).toBe(ANSWER_INSUFFICIENT);
  expect(answerText(assessment())).toBe("Strongest in narrative power and brand fit. Thinnest in audience scale.");
});

test("meAnswer: strongest + thinnest only; none for an insufficient read", () => {
  expect(meAnswer(assessment({ dimensions: dims({ brand_fit: "strength", momentum: "unknown" }) }))).toBe("Strongest in brand fit.");
  expect(meAnswer(assessment({ readState: "insufficient" }))).toBeNull();
});

// ── labels ─────────────────────────────────────────────────────────────────

test("labels are State's conclusions as words + a glyph; neutral gets none", () => {
  expect(stateLabel("strength")).toEqual({ text: "A strength", glyph: "strength" });
  expect(stateLabel("gap")).toEqual({ text: "A gap", glyph: "gap" });
  expect(stateLabel("unknown")).toEqual({ text: "Not enough evidence", glyph: "unknown" });
  expect(stateLabel("neutral")).toBeNull();
});

test("an unknown dimension shows — ; others show their served number", () => {
  expect(dimensionScoreText({ state: "unknown", score: null })).toBe("—");
  expect(dimensionScoreText({ state: "unknown", score: 50 })).toBe("—");
  expect(dimensionScoreText({ state: "strength", score: 86 })).toBe("86");
  expect(dimensionScoreText({ state: "neutral", score: 52.4 })).toBe("52");
});

test("confidence wording map (O-8)", () => {
  expect(confidenceWord("HIGH")).toBe("Confident");
  expect(confidenceWord("MEDIUM")).toBe("Fairly confident");
  expect(confidenceWord("LOW")).toBe("Less certain");
  expect(confidenceWord(null)).toBeNull();
  expect(confidenceLine("HIGH")).toBe("Nomila is confident in this read");
  expect(confidenceLine("MEDIUM")).toBe("Nomila is fairly confident in this read");
  expect(confidenceLine("LOW")).toBe("Nomila is less certain about this read");
  expect(confidenceLine(null)).toBeNull();
});

test("component chips carry status words, and labels come from the copy table", () => {
  expect(evidenceClassLabel("EVALUATED")).toBe("Researched");
  expect(evidenceClassLabel("MEASURED")).toBe("Measured");
  expect(evidenceClassLabel("ASSUMED")).toBe("Assumed — no evidence");
  expect(evidenceClassLabel("MISSING")).toBe("Looked, not found");
  expect(componentLabel("audience_scale.audience_growth")).toBe("Audience growth");
  expect(componentLabel("narrative_power.story_depth")).toBe("Story depth");
  expect(componentLabel("some_dim.new_signal_key")).toBe("New signal key");
});

// ── evidence sheet (O-5) ───────────────────────────────────────────────────

test("evidence groups follow the server's buckets in display order; empty groups are dropped; an ungrounded (not_support) cite is never drawn", () => {
  const evidence = [ev("g", "grounded"), ev("s", "site_only"), ev("n", "nomila_supplied"), ev("u", "unrecorded"), ev("x", "not_support")];
  const groups = evidenceGroups({ grounded: ["g"], site_only: ["s"], nomila_supplied: ["n"], not_support: ["x"], unrecorded: ["u"] }, evidence);
  expect(groups.map((g) => g.title)).toEqual([
    "Checked sources", "Site found, page not confirmed", "From your connected accounts", "Recorded before source checks",
  ]);
  expect(groups.find((g) => g.strength === "site_only")!.weaker).toBe(true);
  expect(groups.some((g) => g.strength === "not_support")).toBe(false);
  expect(JSON.stringify(groups)).not.toContain("x.example.org");                 // the ungrounded link (possibly fabricated) never reaches the sheet
  expect(HIDDEN_CITATION_STRENGTHS).toEqual(["not_support"]);
  // Even an id the server filed under a shown bucket is dropped when the evidence row itself is not_support.
  expect(evidenceGroups({ ...noSources(), grounded: ["x"] }, evidence)).toEqual([]);
  expect(evidenceGroups({ ...noSources(), unrecorded: ["u"] }, evidence).map((g) => g.strength)).toEqual(["unrecorded"]);
});

test("the bucket comes from the server's sources map, not the evidence row; unknown ids are not rendered", () => {
  // the server put "g" under unrecorded for this dimension: the client shows it there
  const groups = evidenceGroups({ ...noSources(), unrecorded: ["g", "missing-id"] }, [ev("g", "grounded")]);
  expect(groups).toHaveLength(1);
  expect(groups[0].strength).toBe("unrecorded");
  expect(groups[0].items.map((i) => i.id)).toEqual(["g"]);
});

test("not_support is never counted as a source", () => {
  expect(supportingSourceCount({ grounded: ["a"], site_only: ["b"], nomila_supplied: ["c"], unrecorded: ["d"], not_support: ["e", "f"] })).toBe(4);
  expect(CITATION_GROUPS.map((g) => g.strength)).toEqual(["grounded", "site_only", "nomila_supplied", "unrecorded"]);
});

// ── states ─────────────────────────────────────────────────────────────────

test("identity copy (D-3): one heading for ambiguous reasons, the reason-specific body underneath", () => {
  const amb = (reason: string | null, basis: "q1" | "athlete_rejected" | null = "q1") =>
    identityCopy("identity_ambiguous", { value: "ambiguous", basis, reason, determinedAt: "2026-10-01T00:00:00.000Z" });
  expect(amb("namesakes_unseparated")).toEqual({ title: "Confirming your public identity", body: "We found more than one person who could be you." });
  expect(amb("namesakes_uncorroborated").body).toBe("We found more than one person who could be you.");
  expect(amb("uncertain").body).toBe("We found information that may be about you, but we're not certain yet.");
  expect(amb("conflicts_athlete_statement").body).toBe("Some of what we found doesn't match what you've told us.");
  expect(amb(null, "athlete_rejected")).toEqual({ title: "Confirming your public identity", body: "The profile we found wasn't you." });
  expect(identityCopy("identity_failed", { value: "failed", basis: "q1", reason: "no_public_match", determinedAt: null }))
    .toEqual({ title: "We couldn't confirm your public identity", body: "We couldn't confidently match you to a public profile." });
  // never the 0.2 heading, never the retired wording
  const all = JSON.stringify([amb("uncertain"), amb("namesakes_unseparated"), amb(null, "athlete_rejected")]);
  expect(all).not.toContain("Is this you?");
  expect(all).not.toContain("isn't sure it found you");
});

test("withheld states: a message, no number, no identity action (D-2, O-6)", () => {
  for (const s of ["identity_ambiguous", "identity_failed"] as const) {
    const m = pageModel(view({ pageState: s, assessment: null, identity: { value: s === "identity_failed" ? "failed" : "ambiguous", basis: "q1", reason: "uncertain", determinedAt: null } }));
    expect(m.mode).toBe("message");
    expect(JSON.stringify(m)).not.toMatch(/Confirm it's you|Add your team|Tell Mila/);
  }
});

test("every no-read pageState has its frozen copy", () => {
  const msg = (pageState: MyIntelligencePageState) => {
    const m = pageModel(view({ pageState, assessment: null }));
    if (m.mode !== "message") throw new Error("expected a message");
    return { title: m.title, body: m.body.join(" ") };
  };
  expect(msg("updating")).toEqual({ title: "Nomila is assessing your marketability.", body: "Your M.I.A. will appear here when it's done. You can leave this screen." });
  expect(msg("updating").body).not.toMatch(/minute|second|hour|usually/);   // O-13: no duration
  expect(msg("no_assessment")).toEqual({ title: "Your M.I.A. isn't ready yet", body: "Nomila reads your public profile and your connected accounts to judge how marketable you are, and why. Your first read will appear here." });
  expect(msg("identity_not_started")).toEqual({ title: "Your M.I.A. isn't ready yet", body: "Nomila hasn't started reading your marketability yet." });
  expect(msg("identity_pending").body).toBe("Nomila checks your identity before assessing your marketability.");
});

test("read states: S1, S2 unknown group, S3 early read, S7 reasons missing", () => {
  const s1 = pageModel(view());
  expect(s1).toMatchObject({ mode: "read", early: false, showUnknownGroup: false, reasonsMissing: false, lines: [] });
  const s2 = pageModel(view({ pageState: "assessed_partial", assessment: assessment({ readState: "assessed_partial", dimensions: dims({ momentum: "unknown" }) }) }));
  expect(s2).toMatchObject({ mode: "read", showUnknownGroup: true });
  const s3 = pageModel(view({ pageState: "insufficient", assessment: assessment({ readState: "insufficient", dimensions: KEYS.map((k) => dim(k, "unknown")) }) }));
  expect(s3).toMatchObject({ mode: "read", early: true, answer: ANSWER_INSUFFICIENT, insufficientBody: COPY.insufficientBody });
  const s7 = pageModel(view({ assessment: assessment({ hasReasons: false }) }));
  expect(s7).toMatchObject({ mode: "read", reasonsMissing: true });
});

test("quiet lines on a shown read: identity first, then D-1's checking line", () => {
  const m = pageModel(view({ pageState: "identity_pending", inProgress: true, identity: { value: "pending", basis: null, reason: null, determinedAt: null } }));
  expect(m.mode === "read" && m.lines).toEqual([
    "Nomila is re-checking it's found the right you. This read may change.",
    "Nomila is checking for a newer read.",
  ]);
  const u = pageModel(view({ inProgress: true }));
  expect(u.mode === "read" && u.lines).toEqual(["Nomila is checking for a newer read."]);
});

// ── bridge (O-7, O-9) ──────────────────────────────────────────────────────

test("bridge: null slots render nothing; goals carry 'Set using an earlier assessment' when served so", () => {
  expect(bridgeModel(view())).toEqual([]);
  const rows = bridgeModel(view({
    bridge: {
      waitingOnYou: { count: 1, items: [] },
      goals: [
        { objectiveId: "o1", domain: "audience", text: "Grow my audience", buildsOn: ["audience_scale", "engagement_quality"], fromEarlierRead: true },
        { objectiveId: "o2", domain: "impact", text: "Build impact", buildsOn: [], fromEarlierRead: false },
      ],
      reviewCount: 2,
    },
    assessment: assessment({ notes: { strengths: [], constraints: [], missingEvidence: ["Video retention metrics.", "Deal values.", "Third"], evaluationRisks: [] } }),
  }));
  expect(rows).toEqual([
    { kind: "waiting", title: "1 thing is waiting on you" },
    { kind: "goal", objectiveId: "o1", title: "Grow my audience", meta: "Your goal · builds on Audience scale · Engagement quality", earlier: "Set using an earlier assessment" },
    { kind: "goal", objectiveId: "o2", title: "Build impact", meta: "Your goal", earlier: null },
    { kind: "review", title: "Nomila has 2 ideas for you to review" },
    { kind: "sharpen", title: "What would sharpen this read", body: "Video retention metrics. · Deal values.", meta: "Nomila's note on what it couldn't find" },
  ]);
  expect(JSON.stringify(rows)).not.toContain("Ask Mila");
  expect(bridgeModel(view({ bridge: { waitingOnYou: { count: 0, items: [] }, goals: [], reviewCount: 0 } }))).toEqual([]);
});

test("goalsFor lists only the goals whose served buildsOn names that dimension", () => {
  const v = view({ bridge: { waitingOnYou: null, reviewCount: null, goals: [
    { objectiveId: "o1", domain: "d", text: "A", buildsOn: ["brand_fit"], fromEarlierRead: false },
    { objectiveId: "o2", domain: "d", text: "B", buildsOn: ["momentum"], fromEarlierRead: true },
  ] } });
  expect(goalsFor(v, "brand_fit").map((g) => g.kind === "goal" && g.objectiveId)).toEqual(["o1"]);
  expect(goalsFor(v, "audience_scale")).toEqual([]);
});

// ── Me card parity (O-6 / O-10) ────────────────────────────────────────────

test("Me card shows a number exactly when the page would show the read", () => {
  const entry = (pageState: MyIntelligencePageState, score: number | null): MyIntelligenceEntry => ({ status: "ready", pageState, score, evidenceAsOf: score == null ? null : "2026-09-29T00:00:00.000Z" });
  const ALL: MyIntelligencePageState[] = ["identity_ambiguous", "identity_failed", "identity_pending", "identity_not_started", "updating", "no_assessment", "insufficient", "assessed_partial", "assessed"];
  for (const s of ALL) {
    // the page model, for a view served with this state and (when the page shows one) a read
    const withRead = !["identity_ambiguous", "identity_failed", "identity_not_started", "updating", "no_assessment"].includes(s);
    const pageShowsNumber = pageModel(view({ pageState: s, assessment: withRead ? assessment() : null })).mode === "read";
    const card = meCardModel(entry(s, withRead ? 600 : null));
    expect({ s, shows: card.score !== null }).toEqual({ s, shows: pageShowsNumber });
  }
  // even if a score leaked into a withheld entry, the card would not draw it
  expect(meCardModel(entry("identity_ambiguous", 600)).score).toBeNull();
  expect(meCardModel(entry("identity_failed", 600)).line).toBe("We couldn't confirm your public identity");
  expect(meCardModel(entry("identity_pending", null)).score).toBeNull();
  expect(meCardModel(null)).toEqual({ score: null, early: false, meta: null, line: null });
});

test("Me card: score + one-line answer from the page view only when the view agrees with the entry", () => {
  const e: MyIntelligenceEntry = { status: "ready", pageState: "assessed", score: 600, evidenceAsOf: "2026-09-29T00:00:00.000Z" };
  expect(meCardModel(e, view())).toEqual({ score: "600", early: false, meta: "Read 29 Sep 2026", line: "Strongest in narrative power and brand fit. Thinnest in audience scale." });
  expect(meCardModel(e).line).toBeNull();
  expect(meCardModel(e, view({ pageState: "assessed_partial" })).line).toBeNull();
  expect(meCardModel({ ...e, pageState: "insufficient" }).early).toBe(true);
  expect(meCardModel({ status: "ready", pageState: "updating", score: null, evidenceAsOf: null }).line).toBe("Nomila is assessing your marketability.");
});

// ── formatting ─────────────────────────────────────────────────────────────

test("read date and the hero arc proportion", () => {
  expect(readDate("2026-09-29T21:00:00.000Z")).toBe("29 Sep 2026");
  expect(readDate(null)).toBe("");
  expect(readDate("nope")).toBe("");
  expect(arcFraction(425)).toBe(0.5);
  expect(arcFraction(900)).toBe(1);
  expect(arcFraction(null)).toBe(0);
});

// ── 6b: the landing's selection rules (over the 0.2 view) ──────────────────────

const sig = (key: string, value: number | null, over: Partial<MyIntelligenceSignal> = {}): MyIntelligenceSignal =>
  ({ key, value, source: value == null ? "imputed" : "web_researched", imputed: value == null, ...over });
/** Eight dimensions with stored contributions and a spread of signals; momentum carries the health-sensitive one. */
const scored = (): MyIntelligenceAssessment => assessment({
  dimensions: [
    { ...dim("athletic_authority", "strength", 75), weight: 0.15, contribution: 11.25, signals: [sig("athletic_authority.competition_level", 88), sig("athletic_authority.role_importance", 70)] },
    { ...dim("audience_scale", "gap", 40), weight: 0.15, contribution: 6, signals: [sig("audience_scale.cross_platform_effective_reach", 35), sig("audience_scale.audience_growth", 25), sig("audience_scale.platform_breadth", null)] },
    { ...dim("engagement_quality", "strength", 78), weight: 0.15, contribution: 11.7, signals: [sig("engagement_quality.engagement_percentile", 81), sig("engagement_quality.video_retention", null), sig("engagement_quality.story_efficiency", null)] },
    { ...dim("cultural_relevance", "neutral", 57), weight: 0.10, contribution: 5.7, signals: [sig("cultural_relevance.search_interest", 38, { source: "platform_public" })] },
    { ...dim("narrative_power", "strength", 90), weight: 0.10, contribution: 9, signals: [sig("narrative_power.distinctiveness", 92), sig("narrative_power.evidence_authenticity", 94)] },
    { ...dim("brand_fit", "strength", 84), weight: 0.10, contribution: 8.4, signals: [sig("brand_fit.brand_safety", 98), sig("brand_fit.identity_values_coherence", 92)] },
    { ...dim("commercial_proof", "neutral", 69), weight: 0.15, contribution: 10.35, signals: [sig("commercial_proof.brand_quality", 90), sig("commercial_proof.campaign_performance", null)] },
    { ...dim("momentum", "gap", 34), weight: 0.10, contribution: 3.4, signals: [sig("momentum.athletic_trajectory", 12), sig("momentum.audience_growth", 20), sig("momentum.search_social_trajectory", 38)] },
  ],
});

test("ring bands (look B): one per dimension with a stored contribution, in the ring's capital order — Audience → Commercial → Brand → Performance, two tones per capital — never recomputed from score", () => {
  const bands = ringBands(scored());
  expect(bands.map((b) => b.key)).toEqual(["audience_scale", "engagement_quality", "commercial_proof", "brand_fit", "narrative_power", "cultural_relevance", "athletic_authority", "momentum"]);
  expect(bands.map((b) => b.capital)).toEqual(["audience", "audience", "commercial", "commercial", "brand", "brand", "performance", "performance"]);
  // The two tones per capital come from the ONE constant; the band's length is the stored contribution, as served.
  expect(bands.map((b) => b.color)).toEqual(Ring.capitals.flatMap((c) => [...c.tones]));
  expect(bands.map((b) => b.contribution)).toEqual([6, 11.7, 10.35, 8.4, 9, 5.7, 11.25, 3.4]);
  // A 0.1 server (no contributions) ⇒ no bands: the ring draws its single arc.
  expect(ringBands(assessment())).toEqual([]);
  // A dimension without a contribution simply has no band; the others keep their place and their tone.
  const partial = scored(); partial.dimensions[7].contribution = null;
  expect(ringBands(partial).map((b) => b.key)).not.toContain("momentum");
  expect(ringBands(partial).find((b) => b.key === "athletic_authority")?.color).toBe(Ring.capitals[3].tones[0]);
  expect(ringBands(null)).toEqual([]);
});

test("ring arcs: degrees clockwise from 12 o'clock, each band its contribution's share of 360 minus the gap, the neutral track for the unfilled share", () => {
  const { arcs, track, filled } = ringArcs(ringBands(scored()));
  expect(filled).toBeCloseTo(65.8, 9);
  expect(arcs[0].key).toBe("audience_scale");
  expect(arcs[0].start).toBeCloseTo(1.3, 9);
  expect(arcs[0].end).toBeCloseTo((6 / 100) * 360 - 1.3, 9);
  expect(arcs[1].start).toBeCloseTo((6 / 100) * 360 + 1.3, 9);
  expect(arcs[7].end).toBeCloseTo((65.8 / 100) * 360 - 1.3, 9);
  expect(track?.start).toBeCloseTo((65.8 / 100) * 360 + 1.3, 9);
  expect(track?.end).toBeCloseTo(360 - 1.3, 9);
  for (const a of arcs) expect(a.end).toBeGreaterThan(a.start);
  // A sliver thinner than the gap keeps zero length rather than drawing backwards; a full ring has no track.
  const sliver = ringArcs([{ key: "momentum", color: "#000", contribution: 0.2 }]).arcs[0];
  expect(sliver.end).toBe(sliver.start);
  expect(ringArcs([{ key: "momentum", color: "#000", contribution: 100 }]).track).toBeNull();
  expect(ringArcs([]).track).toEqual({ start: 1.3, end: 358.7 });
});

test("6b picks: strongest and weakest NON-IMPUTED sub-signals, three each, health-sensitive and measurement-quality ones never, one row per label", () => {
  const { strengths, growth } = signalPicks(scored());
  // 94 (evidence authenticity) grades the EVIDENCE, not her: excluded by config, so the 92s take its place in canonical order.
  expect(strengths.map((p) => [p.label, p.value, p.sourceWord])).toEqual([["Brand safety", 98, "researched"], ["Distinctiveness", 92, "researched"], ["Identity and values coherence", 92, "researched"]]);
  expect(MEASUREMENT_QUALITY_SIGNALS).toEqual(["narrative_power.evidence_authenticity"]);
  for (const p of [...strengths, ...growth]) expect(MEASUREMENT_QUALITY_SIGNALS).not.toContain(p.key);
  // 12 (athletic trajectory) is the lowest value on the row and is excluded by config; "Audience growth" appears once
  // (two dimensions hold it: 20 and 25 — the weaker is the one listed under growth).
  expect(growth.map((p) => [p.label, p.value])).toEqual([["Audience growth", 20], ["Reach across platforms", 35], ["Search interest", 38]]);
  expect(growth.find((p) => p.label === "Search interest")!.sourceWord).toBe("measured");
  expect(HEALTH_SENSITIVE_SIGNALS).toContain("momentum.athletic_trajectory");
  for (const p of [...strengths, ...growth]) expect(p.key).not.toBe("momentum.athletic_trajectory");
  // Imputed signals (value withheld) are never picked, even when nothing else is low.
  const onlyImputedLow = assessment({ dimensions: [{ ...dim("engagement_quality", "unknown"), signals: [sig("engagement_quality.video_retention", null), sig("engagement_quality.engagement_percentile", 81)] }] });
  expect(signalPicks(onlyImputedLow).growth.map((p) => p.key)).toEqual([]);     // 81 is the one strength; nothing left to grow
  expect(signalPicks(onlyImputedLow).strengths.map((p) => p.key)).toEqual(["engagement_quality.engagement_percentile"]);
  // A 0.1 server (no signals) ⇒ nothing, so the card does not draw.
  expect(signalPicks(assessment())).toEqual({ strengths: [], growth: [] });
});

test("6b growth areas are never framed against her: labels and values only, no 'holding back' words", () => {
  const { growth } = signalPicks(scored());
  for (const p of growth) expect(`${p.label} ${p.sourceWord}`).not.toMatch(/hold|back|weak|poor|bad/i);
});

const story = (over: Partial<MeStory> = {}): MeStory => ({
  pageState: "ready", essence: null, positioning: { current: null, desired: null }, throughline: null,
  standsFor: { short: "Rowing opened to every kid on the harbour.", long: "", basis: [], strength: "reported" },
  pillars: [], proofPoints: [], signatureMoments: [],
  differentiators: [
    { text: "Races at national level while coaching the next crew.", basis: [{ kind: "fact", id: "f1" }, { kind: "evidence", id: "e1" }], strength: "established" },
    { text: "Opens the sport to kids who could not pay for it.", basis: [{ kind: "assertion", id: "a1" }], strength: "reported" },
    { text: "  ", basis: [], strength: null },
    { text: "Tells the harbour's story on two platforms.", basis: [{ kind: "evidence", id: "e2" }], strength: "reported" },
    { text: "A fourth one, past the cap.", basis: [], strength: "reported" },
  ],
  chapters: { origin: null, rise: null, defining: { text: "Stroked the winning crew at the regional final.", basis: [], strength: "established" }, now: null },
  direction: [], imageGap: null, athleteStatements: [], ...over,
});

test("6b marketable rows: Identity Intelligence's differentiators, up to three, with their provenance — no M.I.A. number, no brand paired with a score, nothing invented", () => {
  const rows = marketableRows(story());
  expect(MARKETABLE_ROW_MAX).toBe(3);
  expect(rows.map((r) => r.text)).toEqual([
    "Races at national level while coaching the next crew.",
    "Opens the sport to kids who could not pay for it.",
    "Tells the harbour's story on two platforms.",
  ]);
  // Where each comes from: her own words when an assertion / something she said is its basis; else the story, with the
  // strength as a glyph only (established = document, else magnifier) — never the strength word on the face.
  expect(rows.map((r) => [r.sourceLine, r.glyph])).toEqual([["From your story", "document"], ["From what you told Nomila", "you"], ["From your story", "search"]]);
  expect(storyProvenance([{ kind: "said", id: "s1" }], "established")).toEqual({ sourceLine: "From what you told Nomila", glyph: "you" });
  expect(storyProvenance(null, null)).toEqual({ sourceLine: "From your story", glyph: "search" });
  for (const r of rows) {
    expect(r).not.toHaveProperty("value");
    expect(r).not.toHaveProperty("brand");
    expect(JSON.stringify(r)).not.toMatch(/established|reported|\b\d{2,3}\b/);
  }
  // No differentiators ⇒ no rows ⇒ the section does not draw. An assessment is not consulted at all.
  expect(marketableRows(story({ differentiators: [] }))).toEqual([]);
  expect(marketableRows(null)).toEqual([]);
});

const waiting = (over: Partial<MyIntelligenceWaitingItem> = {}): MyIntelligenceWaitingItem =>
  ({ requestId: "r1", status: "open", nomilaSays: "You asked me to prompt you for your contract.", sheAsked: "prompt me for my contract", cta: { kind: "add_contract", label: "Add contract" }, sourceClass: "athlete", ...over });

test("6b help rows: only what she can resolve — her own requests (athlete-class), never a counterparty's, never health; imputed connect gaps once", () => {
  const v = view({
    assessment: scored(),
    bridge: { reviewCount: 2, goals: null, waitingOnYou: { count: 6, items: [
      waiting(),
      waiting({ requestId: "r2", cta: { kind: "add_document", label: "Add document" }, sheAsked: "my performance data", nomilaSays: "You asked me to prompt you for your performance data." }),
      // The counterparty's terms and profile (the deferred objective's requests): not hers to resolve ⇒ never shown.
      waiting({ requestId: "r3", sourceClass: "connected", sheAsked: null, nomilaSays: "You asked me to prompt you for the counterparty's proposed terms." }),
      waiting({ requestId: "r4", sourceClass: "external", cta: null, sheAsked: null, nomilaSays: "Who they are." }),
      // Hers to answer, no document: Mila.
      waiting({ requestId: "r5", cta: null, sheAsked: "my floor for ambassador deals", nomilaSays: "You asked me to prompt you for your rate floor. I can't take this one in the app yet." }),
      // Health: never, whatever the request says.
      waiting({ requestId: "r6", cta: { kind: "add_document", label: "Add document" }, sheAsked: "my return-to-play date after the injury" }),
      waiting({ requestId: "r7", status: "acquired" }),
    ] } },
  });
  const rows = helpRows(v);
  expect(rows.map((r) => [r.kind, r.requestId, r.action])).toEqual([
    ["add_contract", "r1", "Add contract"],
    ["connect", null, "Connect"],
    ["tell_mila", "r2", "Tell Mila"],
    ["tell_mila", "r5", "Tell Mila"],
  ]);
  // The contract row names what SHE did, never a brand and never a contradiction ("Nomila asked for" + "You asked").
  expect(rows[0]).toMatchObject({ title: "Share the contract you mentioned", meta: "You asked Nomila to remind you" });
  expect(HELP_COPY.contractTitle).not.toMatch(/Nomila asked/);
  expect(rows[1]).toMatchObject({ title: "Connect your account insights", meta: "Platform breadth, Video retention and Stories reach are missing from this read" });
  // An insights account already connected: the connect row is not offered (its button would only open Settings); the rest stay.
  expect(helpRows(v, ["instagram"]).map((r) => r.kind)).toEqual(["add_contract", "tell_mila", "tell_mila"]);
  expect(helpRows(v, ["gmail"]).map((r) => r.kind)).toEqual(["add_contract", "connect", "tell_mila", "tell_mila"]);
  expect(rows[3].draft).toContain("my floor for ambassador deals");
  expect(JSON.stringify(rows)).not.toMatch(/injur|return-to-play|counterparty|Who they are/);
  // The health-sensitive signal is never a connect gap even if it were imputed and listed.
  expect(connectGaps(scored())).toEqual(["Platform breadth", "Video retention", "Stories reach"]);
  // The pure predicate, on its own.
  expect(resolvableByHer(waiting({ sourceClass: undefined, cta: null }))).toBe(false);          // 0.1 server: no way in ⇒ not shown
  expect(resolvableByHer(waiting({ sourceClass: undefined }))).toBe(true);                        // 0.1 server: a mounted CTA
  expect(resolvableByHer(waiting({ status: "evidenced" }))).toBe(false);
  // Flags off ⇒ no request rows; no imputed connect gap ⇒ nothing at all, so the card does not draw.
  expect(helpRows(view({ assessment: assessment() }))).toEqual([]);
});

test("6b what to do next: the served review count, 0 when the flag is off", () => {
  expect(nextCount(view({ bridge: { waitingOnYou: null, goals: null, reviewCount: 3 } }))).toBe(3);
  expect(nextCount(view())).toBe(0);
  expect(nextCount(null)).toBe(0);
});
