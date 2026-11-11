// goalLogic — what a goal looks like (Goals PR, approved 5 Oct 2026, docs: "Goals in your words" §2). Pure: no React.
// The imagery TYPE and the domain capital live here; the legacy picker that chose it for the Strategy screens was removed
// with them (3 Nov 2026), and lib/agent/goalsLogic builds it for the Goals tab. The rule it was written to:
//
// A goal is a direction, not a moment, so it shows what it is ABOUT, and her face carries it only when the goal is about
// her own content or her performance. First match wins:
//
//   1 subject       a named brand (organisation, team, event): that subject's image — today the brand cover a move under
//                   the goal already carries (`visual.kind === "brand"`, confirmed research only). Never invented.
//   2 channel       an audience or content goal that names a platform: a strip of HER posts from that platform, with the
//                   platform's mark
//   3 performance   a career or athletic goal: one of her action shots — the only kind where her face carries the goal
//   4 typographic   none of those: the domain's mark on black and a mini eight-band ring with only this goal's capital lit
//
// Organisations and events plug into (1) when the view carries their image; nothing here changes.

import type { HorizonPeriod, ObjectiveHorizon } from "../hooks/use-objectives";
import type { RingCapital } from "../constants/ring";

/** Domain → the M.I.A. capital it moves (the mini ring lights that capital's two bands). */
export const GOAL_CAPITAL: Record<string, RingCapital> = {
  audience: "audience", content: "audience",
  commercial: "commercial", owned_venture: "commercial",
  positioning: "brand", impact: "brand",
  career: "performance", athletic: "performance", relationships: "performance",
};
export const goalCapital = (domain: string | null | undefined): RingCapital => GOAL_CAPITAL[domain ?? ""] ?? "brand";

export type GoalImagery =
  | { kind: "subject"; image: string }
  | { kind: "channel"; platform: string; images: string[] }
  | { kind: "performance"; image: string }
  | { kind: "typographic"; capital: RingCapital };

/** The horizon chips her sheets offer: This season · Next 12 months · Longer. The reason is hers by construction. */
export const HORIZON_CHOICES: ReadonlyArray<{ period: HorizonPeriod; label: string }> = [
  { period: "this_season", label: "This season" },
  { period: "next_12_months", label: "Next 12 months" },
  { period: "multi_year", label: "Longer" },
];
export const herHorizon = (period: HorizonPeriod): ObjectiveHorizon => ({ kind: "period", period, why: "she chose this horizon" });
