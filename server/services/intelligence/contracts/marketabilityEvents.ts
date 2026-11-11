/**
 * marketabilityEvents.ts — the MARKETABILITY_ASSESSED publishing contract.
 *
 * WHAT THIS IS: a named boundary, published after an assessment is durably persisted and supersession resolved. It
 * exists so a future consumer — Rates recomputing, Mila mentioning a move, an API/MCP surface pushing an update —
 * attaches to a stable seam rather than to the orchestrator's internals or to a schema it would then depend on.
 *
 * WHAT THIS IS NOT, and must not be mistaken for: delivery. There is no bus, no subscriber registry, no outbox, no
 * retry, no ordering, and no at-least-once guarantee. `publishMarketabilityAssessed` records the fact and returns.
 * If the process dies immediately afterwards the event is simply gone, and nothing downstream will ever learn of it.
 * That is a DELIBERATE deferral, not an oversight: delivery semantics chosen before a real consumer exists are
 * chosen with nothing to check them against, and the wrong choice is expensive to unpick once something depends on
 * it. When the first consumer arrives (likely Rate or Mila) we choose in-process delivery vs a durable outbox vs
 * Pub/Sub against its actual requirements. Until then, no caller may assume an event was received by anyone.
 *
 * THE DURABLE RECORD IS THE LEDGER. intelligence_ledger is append-only and supersession-marked; it already answers
 * "what is current, what did we believe before, and when" by query, and it is the only thing anything should rely on
 * for history. The ledger is durable history; this seam is future notification. They solve different problems, and
 * duplicating assessments into a generic events table would create a second source of truth for the first one.
 *
 * THE PAYLOAD IS A REFERENCE, NEVER INTELLIGENCE. No score, no composite, no dimensions, no judgements. A consumer
 * that wants the assessment reads it through getMarketability() or by ledger id — so there is exactly one way to
 * learn what an athlete's marketability IS, and an event can never drift from it or be acted on after it goes stale.
 */

/** Every event this engine publishes. One today; the union is the point — a consumer can switch on `kind`. */
export type MarketabilityEventKind = "MARKETABILITY_ASSESSED";

export interface MarketabilityAssessedEvent {
  kind: "MARKETABILITY_ASSESSED";
  athleteId: string;
  /** The ledger entry this announces. The only handle a consumer needs to read the assessment itself. */
  ledgerEntryId: string;
  /** The evaluation run behind it, for a consumer that needs provenance rather than the result. */
  evaluationRunId: string;
  /**
   * Whether this entry became the score OF RECORD, or was filed already superseded because newer evidence had
   * already been assessed (jobs finish out of order).
   *
   * Carried rather than inferred so the reference is self-describing: without it, every consumer woken by this event
   * would have to query the ledger just to find out whether anything it cares about actually changed, and they would
   * all write the same round-trip. It is NOT filtered here, because this seam does not get to decide which of the two
   * facts a future consumer cares about — an audit surface may want both.
   */
  becameCurrent: boolean;
  /** The evidence state assessed. Supersession orders on this, never on completion time. */
  evidenceAsOf: string;
  /** Every parameter set in force, so a consumer can tell a methodology change from an evidence change. */
  versions: { methodology: string; evaluator: string; params: string };
  /** When the entry was written. Distinct from evidenceAsOf, and never a substitute for it. */
  createdAt: string;
}

export type MarketabilityEvent = MarketabilityAssessedEvent;
