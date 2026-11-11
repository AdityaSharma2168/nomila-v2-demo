/**
 * studio/agent/eval/briefs — the fixed brief set the plan eval runs on every planner-touching merge.
 *
 * Thirteen briefs (eleven from the doctrine eval and the acceptance pair), written the way an athlete types them, spanning the objectives the Agent tab
 * offers (studio/brief.ts `BriefObjective` — there is no "hype" or "ad" objective, so those briefs
 * carry their intent in the sentence and sit under the nearest code). Two are meant to come back
 * mostly REAL (her clips and held photos), two mostly GENERATED, the rest a mix. Each carries what
 * the judge should expect — shown only on reveal, never on the blind sheet.
 *
 * SYNTHETIC. No name, handle, brand deal or photo of anyone is in this file; the library they run
 * against is recorded locally and never committed (docs/probes/plan-eval.md).
 *
 * ⚠️ FIXED ON PURPOSE. A brief edited after a baseline is a new brief; the baseline numbers for it
 * are void. Add a brief with a new id rather than rewording one, and re-baseline when you do.
 */
import type { BriefObjective } from "../../brief";

/** Which way the mix should lean, if the planner reads the brief and the library right. */
export type Lean = "real" | "generated" | "mix";

export interface EvalBrief {
  /** Stable id — the key every run, sheet and scoresheet uses. Never renumbered. */
  id: string;
  objective: BriefObjective;
  /** Her sentence. */
  prompt: string;
  /** How it should feel — optional, like the form. */
  aesthetic?: string;
  /** This brief picks a product: the runner takes one from --product, and says so when none is given. */
  product: boolean;
  lean: Lean;
  /** What the judge should expect — the doctrine criterion each one speaks to. Reveal only. */
  expect: string[];
}

export const EVAL_BRIEFS: readonly EvalBrief[] = [
  {
    id: "adidas-ad",
    objective: "showcase-product",
    prompt:
      "an adidas ad — me in the three stripes, on the pitch, that feels like a real spot",
    aesthetic: "clean, confident, big-brand",
    product: false,
    lean: "mix",
    expect: [
      "broll_earned: any b-roll is tied to adidas or the pitch, never a generic spinning ball (the device brief)",
      "relevance: every shot serves the ad; a photo showing a rival brand is not chosen",
    ],
  },
  {
    id: "training-recap",
    objective: "recap",
    prompt: "a recap of this week's training, using what I actually filmed",
    product: false,
    lean: "real",
    expect: [
      "real_clips_used: her clips as they are or cut to a beat, where the library has them",
      "overall_mix: mostly real; a generation only where no footage covers a beat",
    ],
  },
  {
    id: "product-drop",
    objective: "showcase-product",
    prompt:
      "the drop — my new boots are out, show them off and then me wearing them",
    aesthetic: "punchy",
    product: true,
    lean: "mix",
    expect: [
      "product_rules: one product item per product she picked, about that product, never an invented one",
      "stills_where_carried: a product close-up she already has is held, not animated",
    ],
  },
  {
    id: "announce",
    objective: "announce",
    prompt: "announce the partnership — a short, proud reveal that I've signed",
    product: false,
    lean: "mix",
    expect: [
      "relevance: no invented logos, banners or on-screen text; the reveal is in the beats",
      "i2v_reserved: a look-to-camera or a smile, not a signing ceremony no photo shows",
    ],
  },
  {
    id: "hype",
    objective: "grow-following",
    prompt:
      "season-opener hype — cinematic, loud, get people excited for the first game",
    aesthetic: "cinematic, high energy",
    product: false,
    lean: "generated",
    expect: [
      "overall_mix: mostly generated is acceptable here; b-roll of the stadium or the pitch earns its place",
      "i2v_reserved: each shot of her is one simple moment",
    ],
  },
  {
    id: "thank-partner",
    objective: "thank-partner",
    prompt:
      "a thank-you to my sponsor for the season — warm, personal, not an ad",
    aesthetic: "warm",
    product: false,
    lean: "mix",
    expect: [
      "stills_where_carried: a photo that already says thank-you is held",
      "broll_earned: b-roll only if it is about the partner or the season",
    ],
  },
  {
    id: "real-footage",
    objective: "recap",
    prompt:
      "use my real footage — nothing made up, just my own clips cut together",
    product: false,
    lean: "real",
    expect: [
      "real_clips_used: only her camera clips; no i2v, no b-roll",
      "provenance: a stitched compilation never appears as one of her clips (the trust brief)",
    ],
  },
  {
    id: "day-in-life",
    objective: "grow-following",
    prompt: "a day in my life — morning, training, downtime, in my own photos",
    product: false,
    lean: "real",
    expect: [
      "stills_where_carried: held photos carry the beats a photo already tells",
      "overall_mix: a board of six is not six generations",
    ],
  },
  {
    id: "concept",
    objective: "concept",
    prompt:
      "an idea for a night-match reel — floodlights, rain, the walk out of the tunnel",
    aesthetic: "moody",
    product: false,
    lean: "generated",
    expect: [
      "broll_earned: the floodlights and the tunnel are the brief, so b-roll of them earns its place",
      "relevance: shots of her stay true to what her photos show — no rain on a sunny photo",
    ],
  },
  {
    id: "boots-then-match",
    objective: "recap",
    prompt: "me tying my boots before the game, then the game itself",
    product: false,
    lean: "mix",
    expect: [
      "i2v_reserved: tying a boot is one simple animatable beat; the match is a clip, not an i2v",
      "real_clips_used: match footage from her clips if the library has it",
    ],
  },
  {
    id: "complex-i2v-trap",
    objective: "grow-following",
    prompt: "me beating three defenders, cutting inside and scoring top corner",
    product: false,
    lean: "mix",
    expect: [
      "i2v_reserved: never an i2v — a multi-action sequence is not animatable from one photo; a clip, b-roll of the goal, or left out",
    ],
  },
  // ── The acceptance pair (22 Sep 2026, C3 doctrine 2). Brief 12 is PR 1's acceptance brief — 10/10
  // camera on 8f6c17e at 11:22, 2/5 on f1df568 at 13:09 with D2's $0 stills in play. Brief 13 is
  // its exclusivity control: the same ask with the footage made exclusive in her words. Added, never
  // reworded, so the eleven above keep their baselines.
  {
    id: "acceptance-recap",
    objective: "recap",
    prompt: "recap my training, use live footage",
    product: false,
    lean: "real",
    expect: [
      "real_clips_used: her camera beats are the material; a generated still or shot only for a moment no camera beat covers",
      "provenance: nothing made here stands in for footage she filmed",
    ],
  },
  {
    id: "acceptance-only",
    objective: "recap",
    prompt: "only use my real footage, recap my training",
    product: false,
    lean: "real",
    expect: [
      "real_clips_used: only her camera clips; no i2v, no b-roll, no made-here still",
      "provenance: the exclusivity control for brief 12 — the same ask, her footage made exclusive",
    ],
  },
];

export const briefById = (id: string): EvalBrief | undefined =>
  EVAL_BRIEFS.find((b) => b.id === id);
