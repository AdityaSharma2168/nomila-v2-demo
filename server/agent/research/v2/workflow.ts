/**
 * agent/research/v2/workflow.ts — research_v2_shadow: the narrow pipeline run BESIDE today's sign-up research, for
 * comparison only. Started by the sign-up research's merge step when RESEARCH_PIPELINE_V2_SHADOW is on (dev).
 *
 * It never writes the athlete's record, facts, identity or score. Its whole output — the plan, the passages' URLs, the
 * facts it would have kept and the measurements — stays on this workflow run's step output, next to the sign-up run it
 * shadows (input.signup_run_id), where server/scripts/research/compareV2.ts reads both side by side.
 */
import { defineWorkflow } from "../../../workflow/registry";
import type { StepCtx } from "../../../workflow/types";
import { dbStore } from "../dbStore";
import { loadConnectedChannels } from "../connected";
import { readLegacyRow } from "../../../services/intelligence/context/legacyAdapter";
import { discoverProviderOf } from "./config";
import { openaiDiscover } from "./discover";
import { runNarrowResearch } from "./pipeline";
import type { ResearchMoment } from "./plan";

export const RESEARCH_V2_SHADOW_PROCESS = "research_v2_shadow";

interface ShadowInput { name: string; sport: string; signup_run_id?: string; moment?: ResearchMoment }

/** Small cost cap for one shadow run (micro-dollars): discovery plus one extract call never needs more than this. */
export const SHADOW_CAP_MICRO_USD = 750_000;

export async function shadowStep(ctx: StepCtx) {
  const athleteId = ctx.athleteId!;
  const input = (ctx.runInput ?? {}) as Partial<ShadowInput>;
  if (!input.name || !input.sport) throw new Error("research_v2_shadow needs a name and a sport");
  const known = await dbStore.listFacts(athleteId, ["active", "disputed"]);
  const channels = await loadConnectedChannels(athleteId).catch(() => []);
  // The team/school the athlete gave at sign-up, through the one sanctioned reader of that column (sourceGuard G5).
  const team = (await readLegacyRow(athleteId).catch(() => null))?.school ?? null;
  const provider = discoverProviderOf();
  const prefix = `shadow:${ctx.runId}`;
  const spent = await dbStore.costByParentPrefix(athleteId, prefix);
  const out = await runNarrowResearch(
    { store: dbStore, athleteId, parentPrefix: prefix, budget: { spentMicroUsd: spent.microUsd, capMicroUsd: SHADOW_CAP_MICRO_USD } },
    { athlete: { name: input.name, sport: input.sport }, team, handles: channels.map((c) => c.handle).filter((h): h is string => !!h), known, today: new Date().toISOString().slice(0, 10), moment: input.moment === "refresh" ? "refresh" : "signup" },
    { provider, discoverQuery: openaiDiscover() },
    prefix,
  );
  return {
    signup_run_id: input.signup_run_id ?? null,
    provider,
    plan: out.plan.map((p) => ({ aim: p.aim, q: p.q })),
    sources: [...new Set(out.passages.map((p) => p.url))].slice(0, 40),
    wrong_person: out.wrongPerson.slice(0, 20),
    extract_run_id: out.result?.runId ?? null,
    identity: out.result?.identity ?? null,
    outcome: out.metrics.outcome,
    unconfirmed_reason: out.metrics.unconfirmedReason,
    identity_question: out.identityQuestion,
    facts: (out.result?.facts ?? []).map((f) => ({ claim: f.claim.slice(0, 300), topic: f.topic, source_url: f.source_url, source_type: f.source_type, date: f.date, confidence: f.confidence, care: f.care })),
    gaps: (out.result?.gaps ?? []).slice(0, 20).map((g) => g.slice(0, 200)),
    metrics: out.metrics,
  };
}

export const RESEARCH_V2_SHADOW = defineWorkflow({
  process: RESEARCH_V2_SHADOW_PROCESS,
  version: 1,
  activeScope: () => RESEARCH_V2_SHADOW_PROCESS,
  steps: [{ name: "shadow", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 1 }, run: shadowStep }],
});
