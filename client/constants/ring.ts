// Ring — the M.I.A. ring's spec: the ONE place the dimension → capital mapping and the ring colours live (DESIGN.md §10,
// look B, Oct 2026). React-free and react-native-free on purpose: lib/myIntelligenceLogic reads it under plain node.
// theme.ts re-exports it for the components.
//
// Eight bands from 12 o'clock clockwise, Audience → Commercial → Brand → Performance (the logo's outer-to-inner order),
// two tones per capital, each band's length its stored contribution (of 100), 2.6° gaps, butt caps, stroke ≈ 9% of the
// diameter, a neutral track for the unfilled share. The ring colours are DATA ONLY: nowhere else in look B is a colour
// anything but ink, paper, grey or the one blue.
//
// The pairings are a PROPOSAL pending the athlete's confirmation: Audience = scale · engagement, Commercial = proof ·
// brand fit, Brand = narrative · cultural relevance, Performance = athletic authority · momentum.

export const Ring = {
  capitals: [
    { key: "audience",    name: "Audience",    tones: ["#2D8EFF", "#7DB8FF"], dimensions: ["audience_scale", "engagement_quality"], sub: "scale · engagement" },
    { key: "commercial",  name: "Commercial",  tones: ["#2DC87C", "#7FDDB0"], dimensions: ["commercial_proof", "brand_fit"],        sub: "proof · brand fit" },
    { key: "brand",       name: "Brand",       tones: ["#E84591", "#F28DBB"], dimensions: ["narrative_power", "cultural_relevance"], sub: "narrative · culture" },
    { key: "performance", name: "Performance", tones: ["#E8A215", "#F2C76A"], dimensions: ["athletic_authority", "momentum"],       sub: "authority · momentum" },
  ],
  gapDeg: 2.6,
  strokeRatio: 0.09,
} as const;

export type RingCapital = (typeof Ring.capitals)[number]["key"];
