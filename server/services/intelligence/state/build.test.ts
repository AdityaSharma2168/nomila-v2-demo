/**
 * build.test.ts — Athlete State composition.
 *
 * These tests assert SHAPE, PROVENANCE and REFUSAL. None of them asserts a strategic conclusion, and none names an
 * athlete's expected findings. A test that said "Mia has narrative power as a strength" would encode her profile
 * into the contract and make the suite pass for exactly one athlete.
 *
 * What is actually protected here:
 *   - State composes and never judges — no value it owns may be EVALUATED
 *   - absence stays absent: no fabricated trajectory, no invented economics, no default strength
 *   - an evidence-poor dimension is `unknown`, never a `gap` (P-8)
 *   - confidence cannot exceed the weakest material input (P-3)
 *   - every finding is traceable back to the row that produced it
 *   - an athlete with nothing still produces a valid state that says so
 */
import { describe, expect, it } from "@jest/globals";
import {
  bandConfidence,
  commercialPositionFrom,
  competitionContextFrom,
  constraintsFrom,
  findingsFromMia,
  IMPUTED_SHARE_FOR_UNKNOWN,
  preferencesFrom,
  STATE_BANDS,
  audienceTrajectoryFrom,
  audienceFrom,
  datesFrom,
  inboundFrom,
  onboardingPreferencesFrom,
  representationFrom,
} from "./build";
import { ENGINE_EMITS } from "../contracts/provenance";

const T0 = new Date("2026-09-01T00:00:00.000Z");
const NOW = "2026-09-21T00:00:00.000Z";

/** A M.I.A. ledger row in the shape the database actually stores, not the shape commercial.ts declares. */
function miaRow(dimensions: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "11111111-1111-1111-1111-111111111111", evidence_as_of: T0, value: { dimensions, ...extra } };
}
const signal = (key: string, imputed: boolean) => ({ key, imputed, asOf: T0.toISOString() });

describe("Athlete State — composition never becomes judgment", () => {
  it("athlete_state may not emit EVALUATED", () => {
    // The whole boundary rests on this. If State may judge, it is a second marketability engine with no rubric.
    expect(ENGINE_EMITS.athlete_state).toEqual(["MEASURED", "MISSING"]);
    expect(ENGINE_EMITS.athlete_state).not.toContain("EVALUATED");
    expect(ENGINE_EMITS.athlete_state).not.toContain("ASSUMED");
  });

  it("a dimension score keeps marketability as its owner, not athlete_state", () => {
    const [f] = findingsFromMia(miaRow([
      { dimension: "athletic_authority", score: 80, confidence: 90, signals: [signal("a", false)] },
    ]));
    expect(f!.basis.owner).toBe("marketability");
    expect(f!.basis.evidenceClass).toBe("MEASURED");
  });

  it("only counted facts are owned by athlete_state", () => {
    const cp = commercialPositionFrom(
      [{ id: "d1", brand_name: "B", status: "accepted", amount: 1000, amount_cash: 600 }],
      [], NOW,
    );
    expect(cp.closedDeals.owner).toBe("athlete_state");
    expect(cp.closedDeals.evidenceClass).toBe("MEASURED");
  });
});

describe("Athlete State — evidence poverty is not weakness (P-8)", () => {
  it("a low score on mostly imputed signals is unknown, not a gap", () => {
    const [f] = findingsFromMia(miaRow([{
      dimension: "audience_scale", score: 10, confidence: 40,
      signals: [signal("a", true), signal("b", true), signal("c", false)],
    }]));
    expect(f!.imputedShare).toEqual({ imputed: 2, total: 3 });
    expect(2 / 3).toBeGreaterThanOrEqual(IMPUTED_SHARE_FOR_UNKNOWN);
    expect(f!.direction).toBe("unknown");
  });

  it("the same low score on measured signals IS a gap", () => {
    const [f] = findingsFromMia(miaRow([{
      dimension: "audience_scale", score: 10, confidence: 90,
      signals: [signal("a", false), signal("b", false), signal("c", false)],
    }]));
    expect(f!.direction).toBe("gap");
  });

  it("a dimension with no score at all is MISSING and unknown", () => {
    const [f] = findingsFromMia(miaRow([{ dimension: "cultural_relevance", confidence: 50, signals: [] }]));
    expect(f!.basis.evidenceClass).toBe("MISSING");
    expect(f!.direction).toBe("unknown");
  });

  it("reports every dimension, not only the extremes", () => {
    // Opportunity needs the middling ones to decide what to MAINTAIN. A diagnosis of extremes only hides the fact
    // that most of an athlete is unremarkable.
    const mid = (STATE_BANDS.strengthAtOrAbove + STATE_BANDS.gapAtOrBelow) / 2;
    const fs = findingsFromMia(miaRow([
      { dimension: "a", score: 90, confidence: 90, signals: [signal("s", false)] },
      { dimension: "b", score: mid, confidence: 90, signals: [signal("s", false)] },
      { dimension: "c", score: 10, confidence: 90, signals: [signal("s", false)] },
    ]));
    expect(fs).toHaveLength(3);
    expect(fs.map((f) => f.direction)).toEqual(["strength", "neutral", "gap"]);
  });

  it("a measured mid-band score is NEUTRAL, never unknown", () => {
    // The C-1 regression. A score of 50 on four fully measured signals is knowledge, not absence. Reporting it as
    // `unknown` made an evaluator write "her audience scale is unmeasured", which was false, and made another
    // evaluator override the label entirely by reading the raw score. A label a consumer must either disbelieve or
    // ignore is worse than no label.
    const [f] = findingsFromMia(miaRow([{
      dimension: "audience_scale", score: 50, confidence: 90,
      signals: [signal("a", false), signal("b", false), signal("c", false), signal("d", false)],
    }]));
    expect(f!.direction).toBe("neutral");
    expect(f!.basis.evidenceClass).toBe("MEASURED");
    expect(f!.imputedShare).toEqual({ imputed: 0, total: 4 });
  });

  it("the SAME mid-band score is unknown once the evidence is mostly imputed", () => {
    // neutral and unknown are separated by evidence quality, not by score. This pair is the whole distinction.
    const [f] = findingsFromMia(miaRow([{
      dimension: "audience_scale", score: 50, confidence: 40,
      signals: [signal("a", true), signal("b", true), signal("c", true), signal("d", false)],
    }]));
    expect(f!.direction).toBe("unknown");
  });

  it("keeps all four states distinguishable", () => {
    const fs = findingsFromMia(miaRow([
      { dimension: "s", score: 90, confidence: 90, signals: [signal("x", false)] },
      { dimension: "n", score: 60, confidence: 90, signals: [signal("x", false)] },
      { dimension: "g", score: 20, confidence: 90, signals: [signal("x", false)] },
      { dimension: "u", score: 60, confidence: 20, signals: [signal("x", true), signal("y", true)] },
    ]));
    expect(fs.map((f) => f.direction)).toEqual(["strength", "neutral", "gap", "unknown"]);
    expect(new Set(fs.map((f) => f.direction)).size).toBe(4);
  });

  it("every finding carries at least one evidence pointer back to its source row", () => {
    const fs = findingsFromMia(miaRow([{ dimension: "d", score: 50, confidence: 50, signals: [] }]));
    expect(fs[0]!.evidence.length).toBeGreaterThan(0);
    expect(fs[0]!.evidence[0]!.source).toBe("mia");
    expect(fs[0]!.evidence[0]!.locator).toContain("11111111");
  });
});

describe("Athlete State — absence stays absent", () => {
  it("no growth measurement means no audience trajectory, not a steady one", () => {
    const t = audienceTrajectoryFrom([], NOW);
    expect(t).toMatchObject({ evidenceClass: "MISSING", value: null });
  });

  it("audience trajectory is read from measurement, in both directions", () => {
    const f = (v: number) => [{ platform: "instagram", feature_key: "followers_growth_pct", value: v, as_of: T0 }];
    expect(audienceTrajectoryFrom(f(9), NOW).value).toBe("rising");
    expect(audienceTrajectoryFrom(f(-9), NOW).value).toBe("cooling");
    expect(audienceTrajectoryFrom(f(0), NOW).value).toBe("steady");
  });

  it("reads follower growth ONLY, so the name cannot outrun the measurement", () => {
    // The field is `audienceTrajectory` because that is all it can see. An athlete whose audience is cooling may be
    // having the best season of their career, and a strategy layer reading this as whole-athlete decline would
    // diagnose from a quiet posting month.
    const others = [
      { platform: "instagram", feature_key: "followers_latest", value: 1_000_000, as_of: T0 },
      { platform: "instagram", feature_key: "reach_median", value: 500_000, as_of: T0 },
      { platform: "instagram", feature_key: "posts_per_week", value: 7, as_of: T0 },
    ];
    expect(audienceTrajectoryFrom(others, NOW)).toMatchObject({ evidenceClass: "MISSING" });
  });

  it("an athlete with no deals gets zero and none, never an empty confident range", () => {
    const cp = commercialPositionFrom([], [], NOW);
    expect(cp.closedDeals.value).toBe(0);
    expect(cp.demonstratedEconomics.evidenceClass).toBe("MISSING");
    expect(cp.pricingEvidence).toBe("none");
    expect(cp.cashShare).toBeUndefined();
  });

  it("an unpriced deal does not manufacture economics", () => {
    const cp = commercialPositionFrom(
      [{ id: "d1", brand_name: "B", status: "accepted", amount: null, amount_cash: null }], [], NOW,
    );
    expect(cp.closedDeals.value).toBe(1);
    expect(cp.demonstratedEconomics.evidenceClass).toBe("MISSING");
  });

  it("connected measurement without transactions is reported as such", () => {
    const cp = commercialPositionFrom([], [{ feature_key: "followers_latest" }], NOW);
    expect(cp.pricingEvidence).toBe("connected_measurement");
  });

  it("only earned statuses count as commercial position", () => {
    // A detected inbound email is not a transaction. This is the same discipline Rate's Block 5 enforces.
    const cp = commercialPositionFrom([
      { id: "d1", brand_name: "X", status: "detected", amount: 50_000, amount_cash: 50_000 },
      { id: "d2", brand_name: "Y", status: "negotiating", amount: 9_000, amount_cash: 9_000 },
    ], [], NOW);
    expect(cp.closedDeals.value).toBe(0);
    expect(cp.activeRelationships.value).toEqual([]);
    expect(cp.demonstratedEconomics.evidenceClass).toBe("MISSING");
  });
});

describe("Athlete State — confidence obeys its weakest input (P-3)", () => {
  it("bands M.I.A.'s 0-100 confidence onto the shared ordinal vocabulary", () => {
    expect(bandConfidence(90)).toBe("HIGH");
    expect(bandConfidence(60)).toBe("MEDIUM");
    expect(bandConfidence(10)).toBe("LOW");
    expect(bandConfidence(null)).toBe("LOW");
    expect(bandConfidence(undefined)).toBe("LOW");
  });

  it("accepts a 0-1 confidence as well as 0-100, because the sources disagree", () => {
    expect(bandConfidence(0.9)).toBe("HIGH");
  });

  it("reads the object and string forms M.I.A. actually persists", () => {
    // Regression. The ledger stores dimension confidence as 0-100, identityConfidence as the bare string "HIGH",
    // and overallConfidence as { level, explanation }. Assuming a number returned LOW for every athlete in the
    // ledger — a whole-cohort error that no type check catches, because the column is jsonb.
    expect(bandConfidence({ level: "HIGH", explanation: "..." })).toBe("HIGH");
    expect(bandConfidence({ level: "MEDIUM", explanation: "..." })).toBe("MEDIUM");
    expect(bandConfidence("HIGH")).toBe("HIGH");
    expect(bandConfidence({ explanation: "no level" })).toBe("LOW");
    expect(bandConfidence("not a level")).toBe("LOW");
  });
});

describe("Athlete State — athlete-agnostic", () => {
  it("competition context is whatever the affiliation says, never a division or a league", () => {
    expect(competitionContextFrom([
      { org_name: "Some Club", level: "senior", is_primary: true, ended_on: null },
    ])).toBe("Some Club · senior");
  });

  it("an athlete with no affiliation has no competition context, and that is valid", () => {
    expect(competitionContextFrom([])).toBeNull();
  });

  it("an ended affiliation is not competition context", () => {
    const ended = [{ id: "a1", org_name: "Old Club", org_kind: "club", level: null, is_primary: true, ended_on: "2024-01-01" }];
    expect(competitionContextFrom(ended as any)).toBeNull();
  });

  it("an affiliation is context, never a constraint", () => {
    // Being at a university, on a roster or at a club does not bound what Nomila may recommend. The constraints it
    // might imply — a season window, an eligibility rule, a sponsor exclusivity — are not represented in Nomila, and
    // an empty list is the truthful report of that rather than an invented restriction PR4 would then act on.
    expect(constraintsFrom([], NOW)).toHaveLength(0);
  });

  it("a constraint comes only from something explicitly recorded as one", () => {
    const out = constraintsFrom(
      [{ id: "x1", field: "availability_window", value: "off-season only", created_at: T0 }], NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("availability_window");
    expect(out[0]!.evidence[0]!.source).toBe("assertion");
  });

  it("records an athlete's stance without reconciling it against anything", () => {
    // Nomila recommends; the athlete decides. Keeping these apart is what lets a surface say "this could be
    // valuable, but you told me you don't want it" rather than silently dropping or silently overriding.
    const prefs = preferencesFrom([
      { field: "avoids_activities", value: "coaching", said: "I don't want to coach", created_at: T0 },
      { field: "wants_categories", value: ["apparel"], said: null, created_at: T0 },
    ]);
    expect(prefs.map((p) => p.stance)).toEqual(["avoids", "wants"]);
    expect(prefs[0]!.note).toBe("I don't want to coach");
    expect(prefs[0]!.source.source).toBe("assertion");
  });

  it("ignores assertions that are not preferences", () => {
    expect(preferencesFrom([{ field: "height_cm", value: 170, said: null, created_at: T0 }])).toHaveLength(0);
  });

  it("the band edges are declared constants, applied identically to everyone", () => {
    expect(STATE_BANDS.strengthAtOrAbove).toBeGreaterThan(STATE_BANDS.gapAtOrBelow);
    expect(IMPUTED_SHARE_FOR_UNKNOWN).toBeGreaterThan(0);
    expect(IMPUTED_SHARE_FOR_UNKNOWN).toBeLessThanOrEqual(1);
  });

  it("an athlete with no M.I.A. row yields no findings rather than default ones", () => {
    expect(findingsFromMia(miaRow([]))).toEqual([]);
  });
});

describe("Athlete State 1.2 — what Nomila already held, projected without judgment", () => {
  it("an onboarding goal is labelled a fixed-set choice with its time, never an assertion", () => {
    const [p] = onboardingPreferencesFrom({ goal_archetype: "g1", secondary_goals: [], claimed_at: new Date("2026-06-01T00:00:00.000Z") });
    expect(p!.source.source).toBe("onboarding");
    expect(p!.recordedAs).toEqual({ method: "onboarding_v1_choice", at: "2026-06-01T00:00:00.000Z" });
    expect(p!.stance).toBe("wants");
  });

  it("no onboarding goal means no preference, not a default one", () => {
    expect(onboardingPreferencesFrom({ goal_archetype: null, secondary_goals: null })).toEqual([]);
    expect(onboardingPreferencesFrom({ goal_archetype: "  ", secondary_goals: [42] })).toEqual([]);
  });

  it("the pipeline counts every status distinctly and only earned ones close", () => {
    const rows = ["detected", "detected", "negotiating", "rejected", "accepted", "completed"].map((status, i) => ({ id: `d${i}`, brand_name: "B", status, amount: null, amount_cash: null }));
    const cp = commercialPositionFrom(rows, [], T0.toISOString());
    expect(cp.pipeline.value).toEqual({ detected: 2, negotiating: 1, rejected: 1, accepted: 1, completed: 1 });
    expect(cp.closedDeals.value).toBe(2);
    expect(cp.pipeline.owner).toBe("athlete_state");
    expect(cp.pipeline.evidenceClass).toBe("MEASURED");
  });

  it("inbound is capped, most recent first, and drops unclassified threads", () => {
    const threads = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, classification: i % 5 === 0 ? null : { category: "PAID", advertiser: `A${i}` }, last_message_at: new Date(2026, 0, 20 - i), status: "read" }));
    const out = inboundFrom(threads, 12);
    expect(out).toHaveLength(12);
    expect(out[0]!.evidence).toEqual(expect.objectContaining({ source: "inbox", locator: "t1" }));
    expect(out.every((i) => !("amount" in i))).toBe(true);
  });

  it("audience takes the latest observation per platform and the top bucket per dimension", () => {
    const d = (platform: string, dimension: string, bucket: string, pct: string, day: number) => ({ id: `${platform}${dimension}${bucket}${day}`, platform, dimension, bucket, pct, observed_at: new Date(2026, 8, day) });
    const out = audienceFrom([d("ig", "country", "US", "50", 1), d("ig", "country", "BR", "20", 1), d("ig", "country", "BR", "90", 0), d("tt", "age", "13-17", "80", 3)], []);
    expect(out.map((a) => a.platform)).toEqual(["ig", "tt"]);
    expect(out[0]!.topCountry).toEqual({ bucket: "US", pct: 50 });
    expect(out[0]!.followers.evidenceClass).toBe("MISSING");
    expect(out[1]!.topAge).toEqual({ bucket: "13-17", pct: 80 });
  });

  it("representation is null when nothing is stated; a floor of zero is not a floor", () => {
    expect(representationFrom({ deal_preferences: null }, "x")).toBeNull();
    expect(representationFrom({ deal_preferences: { minimum_rates: { a: 0 } } }, "x")).toBeNull();
    expect(representationFrom({ deal_preferences: { agency_name: "Q", minimum_rates: { a: 100 } } }, "x")!.floors).toEqual([{ key: "a", amount: 100 }]);
  });

  it("dates carry meaning, include only what is populated, and never a detected deal's term", () => {
    const out = datesFrom(
      [{ id: "d1", brand_name: "A", status: "accepted", term_end: "2026-12-31" }, { id: "d2", brand_name: "B", status: "detected", term_end: "2026-11-30" }, { id: "d3", brand_name: "C", status: "completed", term_end: null }],
      [{ id: "f1", org_name: "Club", started_on: "2025-08-01", ended_on: null }, { id: "f2", org_name: "Old", started_on: "2020-01-01", ended_on: "2021-01-01" }],
      [], "x",
    );
    expect(out.map((d) => [d.kind, d.date, d.subject])).toEqual([["affiliation_started", "2025-08-01", "Club"], ["deal_term_end", "2026-12-31", "A (accepted)"]]);
  });
});
