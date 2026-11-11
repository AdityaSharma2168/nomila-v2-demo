/**
 * miaPreview/preview.ts — the M.I.A. PREVIEW for the new agent's onboarding reveal (agent build plan v2, 9 Oct 2026).
 *
 * WHAT IT IS: the existing M.I.A. — the same frozen evaluator prompt, model, parser, params, scorer and ledger — run on
 * evidence from the athlete's new memory through THE adapter (memoryAdapter.ts): her public FOUND facts plus any
 * MEASURED data from connected accounts. Nothing here judges or scores; it orchestrates the existing steps:
 *
 *   requestEvaluation({ immediate }) → the mia_evaluation workflow, unchanged in shape: snapshot (identity gate, from
 *   memory; buildMemoryFactsSnapshot) → evaluate (the one paid model call; skipped for an unchanged digest) →
 *   score (ledger, owner 'marketability') → read back
 *
 * REPRODUCIBLE without new tables: the snapshot row holds exactly what was sent (name, sport, block, digest) and which
 * facts went in; the evaluation run holds what came back; the ledger holds the score. The preview's labels
 * (preliminary, inputs, sharpen) are recovered from that lineage by previewMeta.ts.
 *
 * COST: one evaluator call per distinct evidence state. Re-asking an unchanged digest reuses the answered evaluation
 * (no call); concurrent requests for one athlete share one computation (and one workflow run).
 *
 * Generic: nothing names an athlete, sport, level, school, league or brand. Youth to pro, any sport — stage is the
 * evaluator's judgement from the evidence, as it already is for every M.I.A.
 */
import { createLogger } from "../../logger";
import { getMarketability, requestEvaluation, type CurrentMarketability } from "../marketabilityBeta1Orchestrator";
import { getRun, kick } from "../../workflow/runner";
import { setMiaPreviewProvider } from "../../agent/onboarding/miaPreview";
import type { MiaAssessment, MiaPreview, MiaPreviewGroup } from "../../../shared/agent";
import type { TriggerReason } from "../marketabilityBeta1Snapshot";
import { projectAssessment, type MyIntelligenceAssessment } from "../intelligence/views/myIntelligence";
import type { MarketabilityDimension } from "../intelligence/types";
import { isMemoryAthlete, readMemoryIdentity } from "./memoryAdapter";
import { readPreviewMeta, type PreviewMeta } from "./previewMeta";
import { syncMemoryMeasuredFacts } from "../../agent/research/measuredSync";

const log = createLogger("mia:preview");

export const MIA_PREVIEW_CONTRACT = "mia-preview/1" as const;
/** The contract (one shape for the API and the onboarding reveal card) lives in shared/agent.ts. */
export type { MiaPreview, MiaPreviewGroup } from "../../../shared/agent";
export type MiaPreviewStatus = MiaPreview["status"];

/**
 * The four groups of Home's ring, by dimension (client/constants/ring.ts is the design's source of truth; this list is
 * pinned to it by miaPreview.test.ts). Keys and names only: colours are the client's.
 */
export const MIA_GROUPS: ReadonlyArray<{ key: "audience" | "commercial" | "brand" | "performance"; name: string; dimensions: readonly [MarketabilityDimension, MarketabilityDimension] }> = [
  { key: "audience", name: "Audience", dimensions: ["audience_scale", "engagement_quality"] },
  { key: "commercial", name: "Commercial", dimensions: ["commercial_proof", "brand_fit"] },
  { key: "brand", name: "Brand", dimensions: ["narrative_power", "cultural_relevance"] },
  { key: "performance", name: "Performance", dimensions: ["athletic_authority", "momentum"] },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: the four groups from an assessment's dimensions (stored numbers only; nothing is recomputed). */
export function groupsFrom(assessment: Pick<MyIntelligenceAssessment | MiaAssessment, "dimensions"> | null): MiaPreviewGroup[] {
  return MIA_GROUPS.map((g) => {
    const dims = g.dimensions.map((key) => {
      const d = assessment?.dimensions.find((x) => x.key === key);
      return { key, score: d?.score ?? null, weight: d?.weight ?? null, contribution: d?.contribution ?? null, state: d?.state ?? "unknown" };
    });
    const contributions = dims.map((d) => d.contribution).filter((c): c is number => typeof c === "number");
    const weighted = dims.filter((d) => typeof d.score === "number" && typeof d.weight === "number" && d.weight > 0);
    const weightSum = weighted.reduce((s, d) => s + d.weight!, 0);
    return {
      key: g.key, name: g.name, dimensions: dims,
      contribution: contributions.length ? round1(contributions.reduce((s, c) => s + c, 0)) : null,
      score: weightSum > 0 ? round1(weighted.reduce((s, d) => s + d.score! * d.weight!, 0) / weightSum) : null,
    };
  });
}

function assemble(athleteId: string, status: MiaPreviewStatus, record: CurrentMarketability | null, meta: PreviewMeta, identity: { uncertain: boolean; factIds: string[] }): MiaPreview {
  // Typed as the shared contract: the server projection must stay assignable to what the client reads.
  const assessment: MiaAssessment | null = record && status === "ready" ? projectAssessment(record) : null;
  return {
    contract: MIA_PREVIEW_CONTRACT, athleteId, status,
    score: assessment?.score ?? null,
    scale: { min: 0, max: 850 },
    groups: groupsFrom(assessment),
    assessment,
    preliminary: meta.preliminary,
    label: meta.label,
    confidence: { level: assessment?.overall.level ?? null, explanation: assessment?.overall.explanation ?? null },
    inputs: meta.inputs,
    sharpen: meta.sharpen,
    evidenceAsOf: assessment?.evidenceAsOf ?? null,
    identity,
    provenance: assessment ? meta.provenance : null,
  };
}

/**
 * READ the preview of record. SELECTs only, no provider call. While memory holds an unsettled disputed identity fact
 * no NEW score is made (the evaluation gate holds it), and:
 *   - with no score of record: withheld (no score);
 *   - with a score of record (an older athlete's first research refresh could not confirm her public profile, say):
 *     that LAST score stays shown, flagged — `identity.uncertain` is true on a ready preview — never hidden silently.
 * The same rule as Home and My Intelligence (views/myIntelligence.ts buildMyIntelligence).
 */
export async function readMiaPreview(athleteId: string): Promise<MiaPreview> {
  const identity = await readMemoryIdentity(athleteId);
  const record = await getMarketability(athleteId);
  if (identity.uncertain && !record) return assemble(athleteId, "withheld_identity", null, await readPreviewMeta(athleteId, null), identity);
  const meta = await readPreviewMeta(athleteId, record);
  return assemble(athleteId, record ? "ready" : "not_assessed", record, meta, identity);
}

const inFlight = new Map<string, Promise<MiaPreview>>();

/**
 * COMPUTE (or reuse) the preview, then read it back. The one entry point that may spend an evaluator call — and it
 * spends it ONLY through the existing mia_evaluation workflow (requestEvaluation → snapshot [identity gate + memory
 * adapter] → evaluate → score), the single gated path every M.I.A. evaluation takes. `immediate` skips the debounce
 * (someone is waiting on the reveal) but keeps the digest skip, so unchanged memory never pays twice. The run is
 * executed here (kick), so the caller gets the read when it returns; a run still retrying comes back `in_flight`.
 * `trigger` is recorded on the snapshot and never sent (ADR-002).
 */
export function getMiaPreview(athleteId: string, opts: { trigger?: TriggerReason; reason?: string | null } = {}): Promise<MiaPreview> {
  const running = inFlight.get(athleteId);
  if (running) return running;
  const p = computePreview(athleteId, opts).finally(() => inFlight.delete(athleteId));
  inFlight.set(athleteId, p);
  return p;
}

const COMPUTED: Record<string, NonNullable<MiaPreview["computed"]>> = {
  ok: "evaluated", skipped_unchanged: "reused", blocked_identity: "withheld", skipped_no_identity: "skipped", skipped_no_facts: "skipped", failed_validation: "declined",
};

async function computePreview(athleteId: string, opts: { trigger?: TriggerReason; reason?: string | null }): Promise<MiaPreview> {
  // The preview is defined over the new memory: someone with no memory yet has nothing to preview from.
  if (!(await isMemoryAthlete(athleteId))) return { ...(await readMiaPreview(athleteId)), computed: "skipped" };
  // Her measured memory facts are the preview's one measured source: bring them up to date with her connected accounts
  // first (code, no provider call; a failure leaves the last reading in place and never blocks the preview).
  await syncMemoryMeasured(athleteId).catch((err: any) => log.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "measured memory sync before preview failed"));
  const { runId } = await requestEvaluation({
    athleteId, trigger: opts.trigger ?? "USER_REQUESTED_REFRESH", immediate: true, reason: opts.reason ?? "mia preview", createdBy: "mia_preview",
  });
  await kick(runId);
  const run = await getRun(runId);
  const evaluate = run?.steps.find((s) => s.step === "evaluate" && s.status === "done")?.output as { status?: string } | undefined;
  const snapshot = run?.steps.find((s) => s.step === "snapshot" && s.status === "done")?.output as Record<string, unknown> | undefined;
  const computed = evaluate?.status ? COMPUTED[evaluate.status] ?? "declined" : snapshot && "skipped" in snapshot ? "skipped" : "in_flight";
  const read = await readMiaPreview(athleteId);
  if (computed === "skipped" && read.status === "not_assessed") return { ...read, status: "missing_identity", computed };
  log.info({ athleteId, runId, computed, status: read.status }, "mia preview");
  return { ...read, computed };
}

// ── connected data arrives ────────────────────────────────────────────────────

/**
 * For a new-agent athlete, refresh her MEASURED memory facts from her connected accounts (the same code-written facts
 * the onboarding merge writes; a newer reading supersedes the older one). No-op, returning false, for anyone else.
 */
export async function syncMemoryMeasured(athleteId: string): Promise<boolean> {
  return (await syncMemoryMeasuredFacts(athleteId)) !== null;
}

/**
 * Connected-account data arrived (social_sync): sync her measured facts, then ask for a recompute through the EXISTING
 * M.I.A. refresh path (requestEvaluation → the debounced mia_evaluation workflow), which builds its snapshot through
 * the memory adapter for her. Returns null for an athlete who is not on the new memory.
 */
export async function requestMemoryRecompute(athleteId: string): Promise<{ runId: string; created: boolean } | null> {
  if (!(await syncMemoryMeasured(athleteId))) return null;
  return requestEvaluation({ athleteId, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" });
}

/**
 * Better audience data arrived OUTSIDE social_sync (which asks for itself): a handle she confirmed was read through the
 * platform's public API, or the nightly collection (connected accounts, the substrate pass, public discovery) brought
 * a reading that is new or moved ≥ 10% (research.syncMeasured `moved`). Ask for a recompute through the EXISTING path:
 * requestEvaluation, debounced and NOT forced — a burst of readings joins one run, and the run's digest skip makes
 * unchanged evidence free. The caller has already written the measured facts. Never throws; returns null when nothing
 * was asked (not a memory athlete, or her sign-up run will score these readings itself — agent/onboarding/
 * signupWillScore.ts, one score per sign-up).
 */
export async function requestRescoreForReadings(athleteId: string, why: { reason: string; createdBy: string }): Promise<{ runId: string; created: boolean } | null> {
  try {
    if (!(await isMemoryAthlete(athleteId))) return null;
    const { signupRunWillScore } = await import("../../agent/onboarding/signupWillScore");
    if (await signupRunWillScore(athleteId)) return null;
    return await requestEvaluation({ athleteId, trigger: "SOCIAL_BLOCK_CHANGED", reason: why.reason, createdBy: why.createdBy });
  } catch (err: any) {
    log.warn({ athleteId, createdBy: why.createdBy, error: String(err?.message ?? err).slice(0, 200) }, "M.I.A. rescore request failed after new readings");
    return null;
  }
}

/**
 * The nightly collections' trigger (skills/collectSocialAnalytics.ts, skills/collectDiscoveryAnalytics.ts): ask for a
 * recompute only when a reading is NEW or MOVED ≥ 10% (research.syncMeasured `moved`, the threshold the plan's events
 * already use) — not for each day's small drift, which would pay for an evaluation per athlete per night. Never throws.
 */
export async function rescoreIfMoved(athleteId: string, synced: { moved?: number } | null | undefined, createdBy: string): Promise<boolean> {
  if (!synced?.moved) return false;
  return !!(await requestRescoreForReadings(athleteId, { reason: `${synced.moved} measured reading(s) new or moved ≥ 10%`, createdBy }));
}

// ── the onboarding reveal ─────────────────────────────────────────────────────

/**
 * The preview for the onboarding reveal card — the same MiaPreview the API serves — or null when there is no read to
 * show (none yet, withheld for identity, not a memory athlete). READ ONLY: the onboarding workflow's mia_preview step
 * computes it; the reveal never waits on, or pays for, a model call.
 */
export async function revealMiaPreview(athleteId: string): Promise<MiaPreview | null> {
  if (!(await isMemoryAthlete(athleteId))) return null;
  const p = await readMiaPreview(athleteId);
  return p.status === "ready" && p.score != null ? p : null;
}

// Registered on load: the onboarding seam (agent/onboarding/miaPreview.ts) serves THIS implementation to the reveal.
setMiaPreviewProvider(revealMiaPreview);
