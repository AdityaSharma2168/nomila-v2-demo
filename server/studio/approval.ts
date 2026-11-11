/**
 * studio/approval — content clearance. The one door that may change `media_assets.approval_status`.
 *
 * THREE DIFFERENT STATE CONCEPTS LIVE IN THIS SYSTEM AND MUST NOT BE MERGED:
 *
 *   generation_jobs.status        did the work run?          (studio/jobs.ts — lifecycle)
 *   media_assets.approval_status  may this be published?     (THIS FILE — clearance)
 *   spend approval                may we spend to run it?    (U2 — not persisted anywhere yet)
 *
 * Merging any two of them produces a system where "the render finished" reads as "the athlete
 * cleared it", which is how unapproved content reaches a brand.
 *
 * STATES
 *   NULL      ungated. Ingested/connected content. Not in the machine at all — 561 live rows are
 *             here, and 0022 is explicit that they must stay that way (no retroactive gating).
 *   draft     generated content exists but is not cleared. The initial state of every generated asset.
 *   approved  cleared for embed and publish.
 *   rejected  refused. The row stays; content is never deleted to express a decision.
 *
 * WHY THE FORBIDDEN TRANSITIONS ARE FORBIDDEN
 *   * → NULL          un-gating is not a transition. NULL means "was never gated"; letting content
 *                     leave the machine would make the audit trail lie about what was decided.
 *   NULL → *          an ingested IG photo does not need clearance. Allowing entry would silently
 *                     gate every existing asset the moment someone touched it.
 *   approved → draft  no silent un-approval. Withdrawing clearance is approved → rejected, which
 *                     reads as a decision someone made. Getting back to work is then rejected → draft.
 *   rejected → approved  no one-step rehabilitation. A refused asset returns to draft and is cleared
 *                     deliberately, so approving something previously refused is always two acts.
 *
 * ONE RULE THAT IS NOT ABOUT THE TRANSITION TABLE: clearance cannot be withdrawn while the asset is
 * EMBEDDED IN A PITCH DECK. A placed asset is in front of a brand right now, so un-approving it in
 * place would leave the deck rendering content whose clearance was revoked. Withdrawal is therefore
 * ordered — un-embed, then reject — and generationGuards.sql §4 enforces it in the database, where
 * it cannot be bypassed. See the check in setApprovalStatus.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { kitContent, mediaAssets, mediaKits } from "../../shared/schema";
import { createLogger } from "../logger";
import { GenerationError } from "./types";

const logger = createLogger("studio/approval");

export type ApprovalStatus = "draft" | "approved" | "rejected";

/** The transition table, as data. Anything not listed here is refused. */
const LEGAL: Record<ApprovalStatus, ApprovalStatus[]> = {
  draft: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["draft"],
};

export const isLegalTransition = (from: ApprovalStatus, to: ApprovalStatus): boolean =>
  (LEGAL[from] ?? []).includes(to);

/** What a given asset may legally become right now — for a UI that renders only the real buttons. */
export function allowedNext(from: ApprovalStatus | null): ApprovalStatus[] {
  return from === null ? [] : (LEGAL[from] ?? []);
}

/**
 * Move one asset through the clearance machine.
 *
 * Every refusal is a `GenerationError("invalid_input")` naming both states, so a caller can render
 * the reason rather than guessing from a failed update.
 *
 * TENANCY: `athleteId` must come from `req.athleteId`, never from a client body or a model tool
 * call. It is part of both the read and the write predicate, so a borrowed asset id resolves to
 * nothing rather than to someone else's content.
 */
export async function setApprovalStatus(
  athleteId: string,
  assetId: string,
  next: ApprovalStatus,
): Promise<{ assetId: string; from: ApprovalStatus; to: ApprovalStatus }> {
  const [row] = await db
    .select({ id: mediaAssets.id, origin: mediaAssets.origin, status: mediaAssets.approval_status })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);

  if (!row) {
    throw new GenerationError(`No asset ${assetId} for this athlete`, "invalid_input");
  }
  if (row.status === null) {
    throw new GenerationError(
      `Asset ${assetId} is ungated (origin "${row.origin}") and is not in the approval machine — ` +
        "ingested content is not gated, and cannot be moved into the machine after the fact",
      "invalid_input",
    );
  }

  const from = row.status as ApprovalStatus;
  if (from === next) {
    throw new GenerationError(`Asset ${assetId} is already "${next}"`, "invalid_input");
  }
  if (!isLegalTransition(from, next)) {
    throw new GenerationError(
      `Illegal approval transition "${from}" → "${next}" for asset ${assetId}. ` +
        `From "${from}" the only legal moves are: ${allowedNext(from).join(", ") || "(none)"}`,
      "invalid_input",
    );
  }

  // Clearance cannot be withdrawn out from under a LIVE EMBED. An asset placed in a pitch deck is
  // in front of a brand right now, so silently un-approving it would leave the deck rendering
  // content whose clearance was revoked — the §3 guard's failure mode reached from the other side.
  //
  // The retraction is explicit and ordered: remove it from the deck (studio/concept.ts's
  // unembedConceptFromDeck), then reject. This check exists so the caller gets a sentence naming the
  // decks it has to clear; generationGuards.sql §4 is the copy that cannot be bypassed.
  if (next !== "approved") {
    const embeds = await db
      .select({ brandId: mediaKits.brand_id })
      .from(kitContent)
      .innerJoin(mediaKits, eq(mediaKits.id, kitContent.media_kit_id))
      .where(and(eq(kitContent.asset_id, assetId), eq(mediaKits.athlete_id, athleteId)));

    if (embeds.length) {
      throw new GenerationError(
        `Asset ${assetId} is embedded in ${embeds.length} pitch deck(s) (brand ${embeds.map((e) => e.brandId).join(", ")}) ` +
          `and cannot be moved to "${next}" while it is placed. Remove it from the deck first, then withdraw clearance.`,
        "invalid_input",
      );
    }
  }

  // Guarded write: the CURRENT status is part of the predicate, so two concurrent transitions cannot
  // both succeed. Zero rows updated means someone else moved it between the read and the write.
  const updated = await db
    .update(mediaAssets)
    .set({ approval_status: next })
    .where(and(
      eq(mediaAssets.id, assetId),
      eq(mediaAssets.athlete_id, athleteId),
      eq(mediaAssets.approval_status, from),
    ))
    .returning({ id: mediaAssets.id });

  if (!updated.length) {
    throw new GenerationError(
      `Asset ${assetId} changed underneath this approval (expected "${from}") — re-read and retry`,
      "invalid_input",
    );
  }

  logger.info({ athleteId, assetId, from, to: next }, "approval transition");
  return { assetId, from, to: next };
}
