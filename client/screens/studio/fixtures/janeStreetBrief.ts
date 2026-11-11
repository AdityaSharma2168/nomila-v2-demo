/**
 * The simulated Jane Street campus brief, as summarize_brief read it on Adi's walk (23 Sep 2026) and she
 * confirmed it — the fixture the composed ask, the hand-off and the claim-lexicon check are held against.
 * Synthetic: the PDF says so on its own page 2.
 */
export const JANE_STREET_STORY =
  "Draw the parallel between athletic preparation and the way Jane Street approaches problems — deliberately, iteratively, without theatrics.";

export const JANE_STREET_WIRE = {
  brief: {
    schema: "campaign-brief/1",
    objective: { type: "brand_campaign", goal: "announce" },
    story: JANE_STREET_STORY,
    brand: {
      name: "Jane Street",
      brand_attributes: ["global", "research-driven"],
      profile: null,
    },
    subject: { identity_priority: "high", sport: null },
    product: { ref: null, fidelity: "high", line: "campus internship program" },
    creative_direction: {
      tone: ["understated", "precise", "quietly confident"],
      style: "ugc",
      energy: null,
    },
    references: [],
    output: { type: "video", aspect_ratio: "9:16", platform: "instagram" },
  },
  flags: [
    {
      path: "brand.name",
      basis: "literal",
      quote: "Jane Street is a global research-driven trading firm.",
    },
    {
      path: "brand.brand_attributes",
      basis: "literal",
      quote: "Jane Street is a global research-driven trading firm.",
    },
    {
      path: "subject.identity_priority",
      basis: "inferred",
      because: "a training-day film in the athlete's own footage style",
    },
    {
      path: "product.line",
      basis: "literal",
      quote:
        "The campaign objective is awareness of Jane Street's campus internship program among STEM-inclined college students.",
    },
    {
      path: "product.fidelity",
      basis: "inferred",
      because: "not stated in the document; the brand flow's default",
    },
    {
      path: "objective.type",
      basis: "inferred",
      because: "the campaign aims to build awareness",
    },
    {
      path: "objective.goal",
      basis: "inferred",
      because: "timed ahead of spring internship applications opening",
    },
    { path: "story", basis: "literal", quote: JANE_STREET_STORY },
    {
      path: "creative_direction.tone",
      basis: "literal",
      quote: "The tone should be understated, precise, and quietly confident.",
    },
    {
      path: "creative_direction.style",
      basis: "inferred",
      because: "a training-day film in the athlete's own footage style",
    },
    {
      path: "output.type",
      basis: "literal",
      quote: "Format: one vertical video (9:16) for Instagram Reels.",
    },
    {
      path: "output.aspect_ratio",
      basis: "literal",
      quote: "Format: one vertical video (9:16) for Instagram Reels.",
    },
    {
      path: "output.platform",
      basis: "literal",
      quote: "Format: one vertical video (9:16) for Instagram Reels.",
    },
    {
      path: "extras.constraints.0",
      basis: "literal",
      quote:
        "Tag @janestreet and include #JaneStreetPartner and #ad in the caption.",
    },
    {
      path: "extras.constraints.1",
      basis: "literal",
      quote:
        "Do not offer financial or investment advice, and make no claims about trading returns or compensation.",
    },
    {
      path: "extras.constraints.2",
      basis: "literal",
      quote:
        "Mention the campus internship program by name once, verbally or on screen.",
    },
    {
      path: "extras.constraints.3",
      basis: "literal",
      quote: "No competitor firms named or shown.",
    },
  ],
  sourceTool: "summarize_brief",
  extras: {
    constraints: [
      "Tag @janestreet and include #JaneStreetPartner and #ad in the caption.",
      "Do not offer financial or investment advice, and make no claims about trading returns or compensation.",
      "Mention the campus internship program by name once, verbally or on screen.",
      "No competitor firms named or shown.",
    ],
    extraction: "text",
    notes: [
      "The document is a simulated brief for product testing and not an actual Jane Street document, as noted on page 2.",
    ],
  },
};
