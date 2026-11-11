/**
 * studioDirectRequest.ts — Case 5 (Direct Creative Request), offline: an athlete-originated ask routed to Studio's own
 * door WITHOUT Opportunity → Objective → Recommendation → Plan → Campaign. Maps the ask onto the `BriefInput` Studio
 * already requires and records what it establishes, what it leaves to the athlete in Studio, and what a Creative
 * Intelligence seam would add. No provider, no DB, no Studio call.
 *   npx tsx server/scripts/intelligence/studioDirectRequest.ts --ask "Create a post about today's win" --out <file.json>
 */
import { writeFileSync } from "node:fs";
import type { BriefInput } from "../../studio/brief";
const argv = process.argv.slice(2); const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const ask = arg("--ask")!;

// What the ask itself establishes, read plainly — never inferred beyond its words.
const partial: Partial<BriefInput> & { athleteId: "<from req.athleteId — never a body>" } = {
  athleteId: "<from req.athleteId — never a body>",
  origin: "system",               // Studio's enum has no `athlete` origin: her own ask is not `inbound` (untrusted brand text); it is the system acting on her words
  objective: "recap",             // "about today's win" — Studio's own creative-intent enum; the athlete confirms or changes it in Studio
  deliverable: "post",            // "a post" — Studio's format enum
  mode: "generate",
  brandId: null,                  // no brand named → untailored
};
const record = {
  version: "studio-direct-request/0.1.0-exp",
  ask,
  established_by_the_ask: partial,
  left_to_studio_and_her: ["references (her own media_assets — 'never generate from scratch'); a priced preview she approves for spend; clearance of the asset; publish mode"],
  strategic_loop_touched: { opportunity: false, objective: false, recommendation: false, plan: false, campaign: false },
  attachable_later: "to a Campaign if one exists (#570 §3 'freeform attach', reversible) — never required",
  creative_intelligence_seam: {
    receives: ["athlete intent (the ask, verbatim)", "the moment (today's match/result — Context, if supplied)", "her voice/brand layer (Athlete Record)", "references"],
    does_not_receive: ["a Recommendation", "an Objective", "a Campaign spec", "any Brain judgment"],
    would_add_before_studio: ["a creative interpretation the athlete confirms (angle, feeling, line — the direction tools' BriefProposal shape)", "asset intents below the brief (AssetSpec/ShotSpec — not frozen here)"],
  },
};
writeFileSync(arg("--out")!, JSON.stringify(record, null, 1), "utf8");
console.log(JSON.stringify(record, null, 1));
