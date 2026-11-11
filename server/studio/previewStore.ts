/**
 * studio/previewStore — the record of a pre-generation check the athlete was SHOWN, and the proof
 * that it authorizes a spend.
 *
 * ─── WHY A RECORD RATHER THAN AN ARGUMENT ───────────────────────────────────────────────────────
 *
 * Generation is gated on `quoted cost <= the ceiling she approved` (studio/concept.ts's
 * `approvedCostUsd`). Until U2 that ceiling was a bare function argument with nowhere to live, and
 * a route that read it from a request body would hand the CLIENT authority over what she agreed to:
 * a body carrying `approvedCostUsd: 999` authorizes a spend nobody ever saw.
 *
 * THE DANGEROUS DIRECTION IS UP, not down. A lowballed ceiling fails safe — the quote exceeds it
 * and the job is refused. An INFLATED one is the forgery that costs money, because it passes a
 * check that was supposed to represent a human decision.
 *
 * So the ceiling is never sent. `POST /studio/generate` carries `{ previewId }` and no number at
 * all; `loadPreview` reads the figure back off the row written by the preview she looked at. There
 * is nothing in the request to forge, and any `approvedCostUsd`/`cost` field a client invents is
 * simply not read.
 *
 * Re-deriving alone would NOT be enough, and that is the other half of the design. A server that
 * re-derives its own estimate and then spends up to it has no human in the loop — it invented the
 * number. Both halves are required: the cost comes from the server (never the client), and the
 * ceiling comes from a record of what a person was shown (never from the server's imagination).
 *
 * ─── CONSUMPTION IS THE IDEMPOTENCY MECHANISM ───────────────────────────────────────────────────
 *
 * `consumePreview` is ONE atomic guarded UPDATE — `SET consumed_at WHERE consumed_at IS NULL`. That
 * is correct across all three Cloud Run instances (gcp/cloud-run-dev.yaml `maxScale: 3`) with no
 * advisory lock and no leasing, because Postgres serialises the two writers and exactly one sees a
 * row come back. The loser reads `consumed_by_job_id` and answers with the WINNER's job, so a
 * double-tapped Generate returns the same jobId twice and bills once.
 *
 * This is the column that closes the hole, and it is worth being precise about what the hole was:
 * `claimJob` does NOT prevent a double-tap. `createGenerationJob` INSERTs a fresh row every call,
 * so two taps produce two DIFFERENT job ids, each of which claims its own row successfully and
 * calls the model. The guard has to sit on the thing there is only one of — the approval — not on
 * the job, of which there are two.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { studioGenerationPreviews } from "../../shared/schema";
import { createLogger } from "../logger";
import type { CreativeBrief } from "./brief";
import type { GenerationPreview } from "./preview";
import { GenerationError } from "./types";

const logger = createLogger("studio/previewStore");

/**
 * How long an approval stays good.
 *
 * Bounded so a preview cannot be banked and spent much later against a price list that has since
 * moved. Thirty minutes is long enough to read a verdict, think about it, and tap — and short
 * enough that the quote she saw is still the quote we would give her.
 */
export const PREVIEW_TTL_MS = 30 * 60_000;

export interface StoredPreview {
  id: string;
  athleteId: string;
  brief: CreativeBrief;
  /** The figure she was SHOWN, and the only ceiling generation may spend against. Null ⇒ unpriced. */
  approvedCostUsd: number | null;
  unpriced: boolean;
  status: "ready" | "blocked";
  consumedByJobId: string | null;
  expiresAt: Date;
  /**
   * The model this check ROUTED to, off the advisory `plan` column.
   *
   * ⚠️ NAMED IN REFUSALS, AND USED TO DECIDE NOTHING. The money decisions are `approvedCostUsd` and
   * `unpriced`, exactly as before; this exists so a refusal can say WHICH model it has no price for
   * when several checks are being judged at once (studio/spendCaps.ts `assertPlanWithinCaps`) —
   * "no price is configured for item 2" is a sentence nobody can act on.
   *
   * Null when nothing routed: `plan` is null on a blocked check, and on any row frozen before the
   * column carried a model. Read it as "we do not know", never as a default.
   */
  routedModel: string | null;
}

/**
 * Persist a rendered preview. Called by the preview route for EVERY verdict, including a blocked
 * one — a blocked preview is a real thing that happened and the generate route needs to be able to
 * say "that check said no" rather than "no such preview".
 */
export async function savePreview(athleteId: string, preview: GenerationPreview): Promise<string> {
  const [row] = await db
    .insert(studioGenerationPreviews)
    .values({
      athlete_id: athleteId,
      brief: preview.brief as unknown as Record<string, unknown>,
      plan: (preview.plan ?? null) as unknown as Record<string, unknown> | null,
      // Stored as quoted, basis carried verbatim — a preview holds an estimate and must never be
      // read back as a billed figure (studio/preview.ts).
      cost_usd: preview.cost ? String(preview.cost.amountUsd) : null,
      cost_basis: preview.cost?.basis ?? null,
      unpriced: preview.unpriced,
      status: preview.status,
      expires_at: new Date(Date.now() + PREVIEW_TTL_MS),
    } as never)
    .returning({ id: studioGenerationPreviews.id });

  logger.info(
    { previewId: row.id, athleteId, status: preview.status, quotedUsd: preview.cost?.amountUsd ?? null, unpriced: preview.unpriced },
    "preview persisted",
  );
  return row.id;
}

function shape(row: typeof studioGenerationPreviews.$inferSelect): StoredPreview {
  return {
    id: row.id,
    athleteId: row.athlete_id,
    brief: row.brief as unknown as CreativeBrief,
    approvedCostUsd: row.cost_usd == null ? null : Number(row.cost_usd),
    unpriced: row.unpriced,
    status: row.status as "ready" | "blocked",
    consumedByJobId: row.consumed_by_job_id,
    expiresAt: row.expires_at,
    // Defensive on every hop: `plan` is untyped jsonb, so a row written by an older shape (or a
    // blocked check, which has no plan at all) must read as null rather than throw on a surface.
    routedModel:
      typeof (row.plan as { model?: unknown } | null)?.model === "string"
        ? ((row.plan as { model: string }).model)
        : null,
  };
}

/**
 * One preview, under the authenticated athlete.
 *
 * TENANCY: `athleteId` is part of the PREDICATE, not a check afterwards — another athlete's
 * previewId resolves to no row rather than to their brief, which would otherwise leak the storage
 * paths in `brief.job.source` and the whole of their brand context.
 */
export async function loadPreview(athleteId: string, previewId: string): Promise<StoredPreview | null> {
  const [row] = await db
    .select()
    .from(studioGenerationPreviews)
    .where(and(eq(studioGenerationPreviews.id, previewId), eq(studioGenerationPreviews.athlete_id, athleteId)))
    .limit(1);
  return row ? shape(row) : null;
}

export type ConsumeOutcome =
  /** This caller won the race and owns the spend. */
  | { claimed: true }
  /** Someone else already spent this approval — `jobId` is THEIR job, and the answer to return. */
  | { claimed: false; jobId: string | null };

/**
 * Claim the right to spend against this preview, exactly once.
 *
 * The guard is `consumed_at IS NULL` inside the UPDATE itself, so the check and the write are one
 * statement and cannot be interleaved. Two concurrent callers — same process or different instances
 * — both run it; Postgres serialises them; one gets a row back and one gets zero.
 *
 * MUST be called BEFORE the router. Consuming after a successful generation would leave the window
 * that matters wide open: both taps would pass the check, both would call the model, and only then
 * would one of them lose.
 */
export async function consumePreview(
  athleteId: string,
  previewId: string,
  jobId: string,
): Promise<ConsumeOutcome> {
  const claimed = await db
    .update(studioGenerationPreviews)
    .set({ consumed_at: new Date(), consumed_by_job_id: jobId })
    .where(and(
      eq(studioGenerationPreviews.id, previewId),
      eq(studioGenerationPreviews.athlete_id, athleteId),
      isNull(studioGenerationPreviews.consumed_at),
      // An expired approval is not an approval. Checked here as well as in the route so the
      // atomic claim itself cannot be won by a stale preview.
      sql`${studioGenerationPreviews.expires_at} > now()`,
    ))
    .returning({ id: studioGenerationPreviews.id });

  if (claimed.length) return { claimed: true };

  // Lost the race, or expired. Re-read to tell those apart and to find the winner's job.
  const existing = await loadPreview(athleteId, previewId);
  logger.info(
    { previewId, athleteId, winnerJobId: existing?.consumedByJobId ?? null },
    "preview was already consumed — not spending again",
  );
  return { claimed: false, jobId: existing?.consumedByJobId ?? null };
}

/**
 * Release a claim taken for a job that never opened.
 *
 * Only for the narrow case where the caller consumed and then failed BEFORE any billable call —
 * there is nothing to be idempotent about yet, and leaving the approval burnt would force her to
 * re-run a check that cost nothing and said yes. A failure AFTER the router keeps the claim: that
 * spend happened, and a re-run is a new preview and a new cost line (the rule studio/jobs.ts states
 * for jobs, held to here for approvals).
 */
export async function releasePreview(athleteId: string, previewId: string): Promise<void> {
  await db
    .update(studioGenerationPreviews)
    .set({ consumed_at: null, consumed_by_job_id: null })
    .where(and(
      eq(studioGenerationPreviews.id, previewId),
      eq(studioGenerationPreviews.athlete_id, athleteId),
    ));
}

/**
 * "Not what I meant" — she refuses the interpreter's reading of her sentence (the interpreter, I.5; plan
 * v1 A6). The rejection is written where A6 put it, into the row's advisory `plan` column
 * (`interpretation_rejected_at`), and the row is BLOCKED, so the approval it carried can no longer be
 * spent: what she refused must not stay one tap from running. Accepting needs no write — accepted is the
 * row being consumed by Generate.
 *
 * ONE guarded UPDATE, and every condition is in the predicate — hers (`athlete_id`), an interpreted
 * preview, not yet spent — so another athlete's preview id, and a preview Generate already claimed, change
 * nothing. A miss is re-read, under her athlete id, only to say which of those it was.
 */
export type RejectOutcome =
  | "rejected"
  | "not_found"
  | "not_interpreted"
  | "consumed";

export async function rejectInterpretation(
  athleteId: string,
  previewId: string,
): Promise<RejectOutcome> {
  const rejected = await db
    .update(studioGenerationPreviews)
    .set({
      status: "blocked",
      plan: sql`coalesce(${studioGenerationPreviews.plan}, '{}'::jsonb) || jsonb_build_object('interpretation_rejected_at', now())`,
    })
    .where(
      and(
        eq(studioGenerationPreviews.id, previewId),
        eq(studioGenerationPreviews.athlete_id, athleteId),
        isNull(studioGenerationPreviews.consumed_at),
        sql`${studioGenerationPreviews.brief} -> 'job' -> 'interpretation' IS NOT NULL`,
      ),
    )
    .returning({ id: studioGenerationPreviews.id });
  if (rejected.length) {
    logger.info(
      { previewId, athleteId },
      "interpretation rejected — preview blocked",
    );
    return "rejected";
  }
  const existing = await loadPreview(athleteId, previewId);
  if (!existing) return "not_found";
  if (!existing.brief.job.interpretation) return "not_interpreted";
  // Hers and interpreted, so the one condition left is the claim: Generate already spent it.
  return "consumed";
}

/** Why a stored approval may not be spent against right now. Null ⇒ it may. */
export function approvalRefusal(stored: StoredPreview): string | null {
  if (stored.status !== "ready") {
    return "That check said this can't run yet. Run the check again to see what's missing.";
  }
  if (stored.expiresAt.getTime() <= Date.now()) {
    return "That estimate has expired — check the cost again before generating.";
  }
  if (stored.unpriced || stored.approvedCostUsd == null) {
    // Never spend as if unknown were $0 — the rule studio/pricing.ts exists to keep.
    return "We don't have a price for this model, so there's no approved figure to generate against.";
  }
  return null;
}

/** The refusal a fresh quote above the approved figure earns. Kept here so the route reads one line. */
export function overCeiling(freshUsd: number, approvedUsd: number): GenerationError {
  return new GenerationError(
    `Refusing to generate — this now quotes $${freshUsd.toFixed(4)}, above the $${approvedUsd.toFixed(4)} ` +
      "you approved. Check the cost again to approve the new figure.",
    "invalid_input",
  );
}
