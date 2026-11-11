/**
 * creative/toBriefInput.ts — the LAST adapter: CreativeIntent + the athlete's CONFIRMED interpretation (a BriefProposal,
 * and the studio plan it became) → Studio's existing BriefInput. This is where `objective` is filled, and only here,
 * from the confirmed interpretation — never from the intent, the Commission, the contract or the ask. Direction and
 * references ride the existing JobCampaign carrier from the plan; nothing creative is invented here. Test-only for now:
 * it consumes types Studio already exports and mutates nothing.
 */
import type { BriefDeliverable, BriefInput, BriefObjective } from "../../../studio/brief";
import type { JobCampaign } from "../../../studio/campaign/carrier";
import type { CreativeIntent } from "./contract";

/** What the adapter needs from a confirmed interpretation: the goal the athlete confirmed, and the plan's carrier. */
export interface ConfirmedInterpretation {
  proposal: { brief: { objective: { goal: BriefObjective } } };
  confirmedAt: string;
  /** The studio plan the confirmed interpretation became, through Studio's own carrierFromPlan. Null before a plan exists. */
  carrier: JobCampaign | null;
}

const STUDIO_DELIVERABLES: readonly BriefDeliverable[] = ["post", "story", "reel", "carousel", "ad", "clip"];

export type AdapterResult = { ok: true; input: BriefInput; notes: string[] } | { ok: false; refused: string };

export function briefInputFrom(i: CreativeIntent, confirmed: ConfirmedInterpretation | null): AdapterResult {
  if (i.withdrawnAt) return { ok: false, refused: "the intent was withdrawn" };
  if (!confirmed) return { ok: false, refused: "no confirmed interpretation — `objective` is chosen at confirmation, never by the intent" };
  const cls = i.format.class;
  if (!cls) return { ok: false, refused: "no format class on the intent — the confirmed interpretation must fix one before a brief exists" };
  if (!STUDIO_DELIVERABLES.includes(cls as BriefDeliverable)) return { ok: false, refused: `format class "${cls}" is not a Studio deliverable (post | story | reel | carousel | ad | clip) — a written or other piece has no Studio job` };
  const notes: string[] = [];
  let origin: BriefInput["origin"] = i.source.kind === "athlete" ? "athlete" : "system"; let ask: BriefInput["ask"];
  const contractQuote = i.source.kind === "campaign" && i.constraints.some((c) => c.source === "contract") ? i.purpose : null;
  if (i.source.kind === "campaign" && contractQuote) { origin = "inbound"; ask = { ask: contractQuote }; }
  const input: BriefInput = {
    athleteId: i.athleteId, brandId: i.brandId, origin,
    objective: confirmed.proposal.brief.objective.goal,
    deliverable: cls as BriefDeliverable, mode: "generate",
    ...(ask ? { ask } : {}),
    ...(confirmed.carrier ? { campaign: confirmed.carrier } : {}),
  };
  return { ok: true, input, notes };
}
