/**
 * dealAttachmentScope.ts — which threads' files count as "on this deal" (docs/design/brand-page-deals.md D3, D4).
 *
 * The deal's own thread; a paperwork thread matched to it (an e-sign "Completed" carries the signed PDF); or a
 * thread of another deal in the SAME opportunity (a pre-#777 e-sign pseudo-deal holds it). Every branch is hers:
 * the thread and both deals are filtered by athlete. Callers also filter the message by athlete.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { inboxThreads } from "../../shared/schema";

export function threadOnDeal(athleteId: string, dealId: string): SQL {
  return and(
    eq(inboxThreads.athlete_id, athleteId),
    or(
      eq(inboxThreads.deal_id, dealId),
      sql`${inboxThreads.classification} -> 'paperwork' ->> 'deal_id' = ${dealId}`,
      sql`${inboxThreads.deal_id} IN (
        SELECT sib.id FROM deals sib
        JOIN deals self ON self.opportunity_id = sib.opportunity_id
        WHERE self.id = ${dealId}::uuid AND self.athlete_id = ${athleteId}::uuid AND sib.athlete_id = ${athleteId}::uuid)`,
    ),
  )!;
}
