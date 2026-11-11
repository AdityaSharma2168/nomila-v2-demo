/**
 * marketabilityBeta1Snapshot.ts — the evidence snapshot: everything Nomila supplies to the M.I.A. evaluator, captured
 * and digested BEFORE the provider call, so what was sent is recoverable independently of what came back.
 *
 * The evaluator's entire Nomila-supplied input is three things: the athlete's name, their sport, and the authoritative
 * social block. Everything else in the prompt is the frozen rubric, which is digest-pinned in
 * marketabilityBeta1EvaluatorSpec.ts. The evaluator researches the athlete itself and never reads our research
 * substrate — which is why a research refresh is not a trigger (see the design note, §0).
 *
 * 4 Nov 2026: the legacy builder (buildEvidenceSnapshot, the search-enabled evaluator's input for athletes with no
 * memory) is deleted with that evaluator. Snapshots are built from memory (miaPreview/memoryAdapter.ts
 * buildMemoryFactsSnapshot); this module keeps the shared types, the digest and promptFor (the quick score's prompt).
 *
 * TWO CLOCKS, DELIBERATELY DIFFERENT:
 *   digest         drives IDEMPOTENCY — has what we would send actually changed?
 *   evidenceAsOf   drives SUPERSESSION — which of two results was built on newer evidence?
 * They are separate because a row can change for reasons that alter neither the prompt nor the evidence's age. Keying
 * idempotency on the digest means an unchanged snapshot never pays for a re-run, and that matters: the evaluator is
 * non-deterministic, so a repeat on identical input samples drift (measured at a mean of 20.5 MIA points) rather than
 * learning anything.
 *
 * THE TRIGGER NEVER CROSSES THIS BOUNDARY. `triggerReason` is recorded on the snapshot and never enters the prompt. An
 * orchestration fact is not evidence: if it reached the evaluator, an athlete who had just connected an account would
 * score differently from an identical athlete who had not — which is the bonus ADR-002 forbids, arriving by a side
 * channel. `promptFor()` below is the only path to a prompt, and its signature has nowhere to put a trigger.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { blindEvalPromptV02 } from "./marketabilityBeta1EvaluatorSpec";
import { connectedBlock, citedHandles, discoveryBlock, renderBlock, type SocialAccountBlock, type SocialBlockRecord } from "./marketabilityBeta1SocialBlock";

/** Why an evaluation was requested. Recorded, never sent. */
export const TRIGGER_REASONS = [
  "IDENTITY_RESOLVED",
  "SOCIAL_BLOCK_CHANGED",
  "USER_REQUESTED_REFRESH",
  "ADMIN_REQUESTED_REFRESH",
] as const;
export type TriggerReason = (typeof TRIGGER_REASONS)[number];

export interface SnapshotSource {
  platform: string;
  accountId: string;
  observedAt: string;
  sourceClass: string;
}

/** Everything the evaluator receives from Nomila, plus the provenance of how it was assembled. */
export interface EvidenceSnapshot {
  athleteId: string;
  name: string;
  sport: string;
  /** The AUTHORITATIVE SOCIAL DATA block verbatim, or null when no platform data resolved. */
  socialBlock: string | null;
  socialSources: SnapshotSource[];
  /** Max observation date of the Nomila-supplied evidence. Never the trigger, job start or completion time. */
  evidenceAsOf: string;
  digest: string;
  triggerReason: TriggerReason;
  /** Free text for admin cases only. Recorded, never sent, and never part of the digest. */
  triggerDetail?: string | null;
  builtAt: string;
}

/** The digest input: exactly what the evaluator receives, which is exactly what promptFor() consumes. */
type DigestInput = Pick<EvidenceSnapshot, "name" | "sport" | "socialBlock"> & {
  /**
   * The evaluator the question is for, when it is not the frozen one (facts-eval-spec, miaPreview/factsOnlySpec.ts).
   * Omitted for the frozen evaluator, so every existing digest is byte-identical (JSON.stringify drops undefined).
   */
  evaluator?: string;
};

/**
 * sha256 over the complete semantic evaluator input — and nothing else.
 *
 * THE INVARIANT: an identical digest means we would be asking the evaluator the same question from the same
 * information. Not "nothing in the database changed"; not "no provenance moved". Only what is actually sent.
 *
 * So the digest is over precisely the three things promptFor() takes: name, sport, and the block text. It is
 * deliberately NOT over socialSources — that is provenance, and the parts of it the evaluator actually sees are
 * already IN the block text, which renders each account as `… observed 2026-09-14; identity: … (HIGH)`. A freshly
 * observed but unchanged metric therefore still changes the digest, because the date genuinely changes the prompt —
 * and "22,040 followers observed today" is a stronger claim than the same number observed six months ago. Carrying
 * the dates separately as well would encode the same fact twice and let the digest drift from the prompt it exists
 * to represent.
 *
 * The frozen rubric is excluded for the opposite reason: it is identical for every athlete and has its own pinned
 * digest (BLIND_EVAL_SPEC_V02_CANONICAL_SHA256), so folding it in here would conflate two independent guards.
 *
 * triggerReason and triggerDetail are excluded because they never reach the prompt at all: two requests differing
 * only in why they were made are asking the same question and must be idempotent-equal.
 */
export function snapshotDigest(i: DigestInput): string {
  const canonical = JSON.stringify({ name: i.name, sport: i.sport, socialBlock: i.socialBlock ?? null, evaluator: i.evaluator });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The prompt for a snapshot — the ONLY path from a snapshot to a provider call.
 *
 * It delegates to the frozen builder, so the canonical-text digest guard in marketabilityBeta1Freeze.test.ts covers
 * this path too: adding anything to the prompt here would change that digest and fail the freeze. The signature has
 * no trigger parameter by design.
 */
export function promptFor(snapshot: Pick<EvidenceSnapshot, "name" | "sport" | "socialBlock">): string {
  return blindEvalPromptV02({ key: "snapshot", name: snapshot.name, sport: snapshot.sport }, snapshot.socialBlock);
}

/** The evidence age of an assembled block: the freshest platform observation, or the athlete record's own age. */
export function evidenceAsOfFor(sources: SnapshotSource[], fallback: Date): string {
  const latest = sources.map((s) => Date.parse(s.observedAt)).filter((n) => Number.isFinite(n)).sort((a, b) => b - a)[0];
  return new Date(latest ?? fallback.getTime()).toISOString();
}
