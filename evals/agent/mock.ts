/**
 * evals/agent/mock.ts — the --mock run: the whole eval pipeline with NO provider and NO database.
 *
 * The model is the test fake (server/testUtils/agentModel.ts fakeResponses): each skill gets a schema-valid answer
 * built from the case file itself (research "finds" the case's expected facts at their source URLs; merge keeps each
 * pass fact; understand and the onboarding turns cite those facts). Memory is the in-memory store. The M.I.A. preview
 * and the judge are stubs. So a mock run proves the plumbing (stages, traces, graders, budget, report, diff) — it says
 * nothing about the model's quality, and its "cost" is the fake token usage priced like the real thing.
 */
import { fakeResponses, skillOf, type FakeAnswer } from "../../server/testUtils/agentModel";
import type { JudgeCaller } from "./judge";
import type { EvalCase, RecordedMia } from "./types";

const keysIn = (input: string, re: RegExp) => [...input.matchAll(re)].map((m) => m[1]);

function researchAnswer(c: EvalCase, pass: "a" | "b"): FakeAnswer {
  const disputed = c.expected.identity === "disputed";
  const facts = disputed ? [] : c.expected.facts.filter((_, i) => (i % 2 === 0) === (pass === "a") || i < 2);
  return {
    queries: Array.from({ length: 8 }, (_, i) => `${c.input.name} ${c.input.sport} ${pass}${i + 1}`),
    sources: [...new Set(c.expected.facts.map((f) => f.source_url))].map((url) => ({ url, title: "source" })),
    usage: { input: 60_000, cached: 4_000, output: 9_000, reasoning: 5_000 },
    json: {
      identity: disputed
        ? { resolved: false, description: "", ambiguity: `Several athletes named ${c.input.name} play ${c.input.sport}.` }
        : { resolved: true, description: `${c.input.name}, ${c.input.sport}`, ambiguity: "" },
      facts: facts.map((f) => ({
        subject_kind: "athlete", subject_name: c.input.name, claim: f.fact, topic: "career", source_url: f.source_url,
        source_title: "source", source_type: "official", date: "", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none",
      })),
      gaps: ["eligibility rules for this athlete's school/association"],
      narrative: `${c.input.name} (${c.input.sport}).`,
    },
  };
}

function mergeAnswer(input: string): FakeAnswer {
  // Pass fact lines: "a1 | athlete: Name | claim | topic … | source …"
  const lines = [...input.matchAll(/^([ab]\d+) \| [^|]+ \| ([^|]+) \|/gm)];
  const seen = new Set<string>();
  const facts = lines.filter((l) => !seen.has(l[2].trim()) && seen.add(l[2].trim())).map((l) => ({
    from: lines.filter((x) => x[2].trim() === l[2].trim()).map((x) => x[1]), subject_kind: "athlete", subject_name: "", claim: l[2].trim(),
    topic: "career", date: "", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "",
    field: "none", field_value: "",
  }));
  return { usage: { input: 14_000, output: 5_000, reasoning: 2_000 }, json: { facts, dropped: [], narrative: "Merged." } };
}

function understandAnswer(c: EvalCase, input: string): FakeAnswer {
  const keys = keysIn(input, /^(f\d+) \| found/gm);
  const refs = keys.slice(0, 3);
  const SECTION_KEYS = ["brand_now_next", "commercial_readiness", "rate_logic", "context_timing", "content_direction", "risks_upside", "could_not_confirm", "refresh_cadence"];
  // understand 1.11.0: no web search (the timing reads the dated moments already in the facts).
  return {
    usage: { input: 30_000, cached: 2_000, output: 10_000, reasoning: 6_000 },
    json: {
      stage: { label: c.tags.stage ?? "unclear", band: "established", confidence: 0.7, why: "From the facts.", refs },
      thesis: { big_idea: "A proven competitor with a clear story.", verdict: "Marketable today on the strength of the record." },
      sections: SECTION_KEYS.map((key) => ({
        key, title: key, so_what: "This shapes the partners you should approach first.",
        lines: [{ text: refs.length ? "The record is documented by the sources." : "Little is documented yet.", kind: refs.length ? "fact" : "inference", refs }],
      })),
      positioning: {
        from: "Known for results.", to: "Known for results and the story behind them.", statement: "A competitor brands can trust.",
        pillars: [1, 2, 3].map((n) => ({ name: `Pillar ${n}`, line: "Rests on the record.", refs })), refs,
      },
      content_pillars: refs.length ? [
        { key: "P1", name: "Training and the work behind results", why_this_athlete: "The record is built in training the sources document.", refs: refs.slice(0, 1) },
        { key: "P2", name: "Competition days", why_this_athlete: "Each documented result is a moment followers can share.", refs: refs.slice(0, 2) },
      ] : [],
      internal: { current_sponsors: [], past_sponsors: [], exclusivity_conflicts: [] },
      narrative: "You have a documented record that brands can build on.",
      // understand 1.13.0: the suggested ranges (wide and low-confidence with no measured facts).
      rate_ranges: refs.length ? [
        { rate_type: "ig_post", low: 300, high: 900, currency: "USD", confidence: "low", drivers: ["level", "audience not measured yet"], refs: refs.slice(0, 1) },
      ] : [],
      // understand 1.12.0: no CURRENT BRIEF in an onboarding run, so no carry-forward answer.
      carry_forward: null,
    },
  };
}

function turnAnswer(input: string): FakeAnswer {
  const keys = keysIn(input, /^(f\d+) \| found/gm);
  const insightsTurn = /EVENT: The Brief is ready/.test(input);
  const reveal = !insightsTurn && keys.length
    ? { headline: "Your record is your pitch.", highlights: keys.slice(0, 4).map((k) => ({ text: "A documented result brands notice.", refs: [k] })), standing: { text: "Established in your sport.", refs: keys.slice(0, 1) }, windows: [] }
    : null;
  return {
    usage: { input: 9_000, output: 1_500, reasoning: 600 },
    json: {
      message: insightsTurn ? "Here is what stands out now that the Brief is ready." : "Here is what I found. Tell me if anything's off.",
      cards: {
        quick_questions: [], reveal, rate_ranges: false,
        insights: insightsTurn ? keys.slice(0, 2).map((k) => ({ angle: "brand", text: "Your results give brands a clear reason to say yes.", refs: [k], mia_dimension: null })) : [],
        fact_review: null, show_recommended_goals: false, connect: [], capabilities: [], consent: false, age_band: false, order: [],
      },
      checkpoints_addressed: reveal ? ["reveal"] : [],
      path_note: insightsTurn ? "insights after the Brief" : "opened with the reveal",
    },
  };
}

/** The plan step: two recommended goals resting on the first facts, a game plan each, a post and a connect action. */
function planAnswer(input: string): FakeAnswer {
  const keys = keysIn(input, /^(F\d+) \| found/gm);
  const refs = keys.slice(0, 2);
  const today = /^TODAY: (\d{4}-\d{2}-\d{2})/m.exec(input)?.[1] ?? "2026-10-09";
  const offer = /^- (\w+) \| [^|]+ \| social \| not connected \| can offer now: yes/m.exec(input)?.[1] ?? null;
  const value = { text: "A first deal on record, and a story brands can follow.", low: null, high: null, currency: null, drivers: [] };
  return {
    usage: { input: 13_000, cached: 2_500, output: 2_500, reasoning: 4_000 },
    json: {
      contract: "plan/1",
      stage_read: { band: "established", why: "From the record in the facts." },
      recommended_goals: refs.length ? [
        { key: "R1", goal: "Land a first local partner this season", horizon: "next", domain: "commercial", why_now: "Your record gives brands a clear reason to say yes now.", value, value_confidence: "low", next_decision: "Pick two local brands to approach.", repeats: "once", fact_keys: refs, similar_to_goal_id: null },
        { key: "R2", goal: "Share one training story a week", horizon: "now", domain: "content", why_now: "Your results are documented; the story behind them is not yet.", value, value_confidence: "low", next_decision: "Choose the day you post.", repeats: "weekly", fact_keys: refs.slice(0, 1), similar_to_goal_id: null },
      ] : [],
      game_plans: refs.length ? [
        { goal_ref: "R1", domain: "commercial", lines: ["Lead with your record; pitch two brands that already back your sport locally."], kept_athlete_text: false },
        { goal_ref: "R2", domain: "content", lines: ["One short clip a week from training you already film."], kept_athlete_text: false },
      ] : [],
      actions: refs.length ? [
        { goal_ref: "R2", kind: "post", what: "A training clip with your result", why: "It turns the record into a story.", due_on: today, event_ref: null, button: "post",
          deliverable: { type: "post_brief", title: "Training clip", body: "Caption: The work behind the result.\nShots: warm-up, one hard set, the finish.", target: null, platform: "instagram", thread_ref: null, connector: null,
            caption: "The work behind the result.", hashtags: ["#training"], shots: ["warm-up", "one hard set", "the finish"] }, fact_keys: refs.slice(0, 1),
          post: { hook: "The work behind the result.", format: "reel", show: "Warm-up, one hard set, the finish.", caption_angle: "The result came from the work.", avoid: "Anything staged.", media_needs: "a training clip" },
          idea_ref: null, pillar_ref: null },
        ...(offer ? [{ goal_ref: "R1", kind: "connect", what: `Connect ${offer}`, why: "So your real audience backs the pitch.", due_on: null, event_ref: null, button: "connect",
          deliverable: { type: "connect_request", title: `Connect ${offer}`, body: "Measured reach makes a pitch credible.", target: null, platform: null, thread_ref: null, connector: offer, caption: null, hashtags: [], shots: [] }, fact_keys: refs.slice(0, 1),
          post: null, idea_ref: null, pillar_ref: null }] : []),
      ] : [],
      goal_notes: [],
      missing: [],
      idea_moves: [],
      // plan 1.5.0: the week's one number (no playbook in the eval: no target).
      week: { posts: refs.length ? 1 : 0, target: null, stories: 0, why: "No playbook and no limit of the athlete's yet: one post where it serves a goal." },
      path_note: "planned from the record",
    },
  };
}

/** The fake transport for one case (pass it to setResponsesTransport). */
export function mockTransportFor(c: EvalCase) {
  return fakeResponses((body) => {
    const skill = skillOf(body);
    const input = String(body.input ?? "");
    if (skill === "research") return researchAnswer(c, /You are PASS B/.test(input) ? "b" : "a");
    if (skill === "research/merge") return mergeAnswer(input);
    if (skill === "understand") return understandAnswer(c, input);
    if (skill === "onboarding") return turnAnswer(input);
    if (skill === "plan") return planAnswer(input);
    throw new Error(`mock: no answer for skill ${skill}`);
  });
}

/** Stub M.I.A.: ready unless the case expects a disputed identity (then withheld), like the real gate. */
export function mockMia(c: EvalCase): (athleteId: string) => Promise<RecordedMia> {
  return async () => c.expected.identity === "disputed"
    ? { status: "withheld_identity", score: null, preliminary: true, computed: "withheld", costMicroUsd: 0, latencyMs: 0 }
    : { status: "ready", score: 500, preliminary: true, computed: "mock", costMicroUsd: 0, latencyMs: 0 };
}

/** Stub judge: passes both criteria. */
export const mockJudge: JudgeCaller = async () => ({
  json: { positioning_supported: { pass: true, reason: "mock judge" }, no_unsupported_facts: { pass: true, reason: "mock judge", statements: [] } },
  provider: "mock", model: "mock", inputTokens: 0, outputTokens: 0, costMicroUsd: 0,
});
