/**
 * studio/agent/eval/census/fixture — THE CENSUS CAMPAIGN (PR 16, R-1/R-6). Synthetic from end to end.
 *
 * Two mechanisms, because nonces don't work on enums:
 *
 *   NONCE   every free-text field carries a unique token, ZQ001, ZQ002, … A token that never appears
 *           downstream of where it was set is a dead field, by measurement.
 *   MEMBER  every closed-vocabulary field takes a deliberately NON-default member, and names the words
 *           that member must produce in the artifact that is supposed to carry it (`MEMBERS`).
 *
 * The token map is DERIVED by walking these objects (`noncesIn`), never listed beside them, so the
 * fixture and the map cannot drift. No real person, brand or place is named anywhere in this file.
 */

/** A census nonce. Case-insensitive: some doors lower-case what they carry (the reference door's tone). */
export const TOKEN = /ZQ\d{3}/gi;

// ─── The brief she confirms ──────────────────────────────────────────────────────────────────────

const reading = (n: number, what: string, tags: string[] = []) => ({
  summary: `ZQ${String(n).padStart(3, "0")} ${what}.`,
  tags,
  basis: "inferred" as const,
});

/** Every leaf set; every free-text leaf a token; every enum off its default. */
export const CENSUS_CAMPAIGN = {
  schema: "campaign-brief/1",
  objective: { type: "ad", goal: "recap" },
  story: "ZQ001 the morning she broke the club record",
  brand: {
    name: "Qorvane ZQ002",
    brand_attributes: ["ZQ003 fearless"],
    profile: "zqprofile_4",
  },
  subject: { identity_priority: "maximum", sport: "ZQ004 netball" },
  product: {
    ref: "product_1",
    fidelity: "standard",
    line: "ZQ005 the carbon plate spike",
  },
  creative_direction: {
    tone: ["ZQ006 hushed"],
    style: "documentary",
    energy: "ZQ007 simmering",
  },
  references: [
    {
      ref: "ref_1",
      role: "composition_reference",
      intent: {
        composition: reading(10, "a subject held off-centre", [
          "rule_of_thirds",
        ]),
        camera: reading(11, "a low tracking shot", ["low_angle", "tracking"]),
        lens_perspective: reading(12, "a long lens compressing the lanes"),
        lighting: reading(13, "raking late light", ["golden_hour"]),
        color: reading(14, "muted teal and rust"),
        environment: reading(15, "an empty outdoor court", ["street"]),
        subject_placement: reading(16, "the athlete low in the frame"),
        wardrobe: reading(17, "a plain training vest"),
        motion: reading(18, "a slow jog into a sprint", ["running"]),
        editing_rhythm: reading(19, "long takes with a fast cut on the beat"),
        typography: reading(20, "one small sans-serif word"),
        emotional_tone: reading(21, "quiet determination"),
      },
    },
  ],
  output: { type: "video", aspect_ratio: "4:5", platform: "tiktok" },
  constraints: ["do not show ZQ040 any stopwatch"],
} as const;

/** Her own words and feel on the ask — the plan row remembers these (PR 13). */
export const CENSUS_ASK = {
  prompt: "ZQ041 a thank-you video for my partner",
  aesthetic: "ZQ042 grainy and warm",
  objective: "thank-partner",
} as const;

/** The concept she picked (PR 6, 6c) — the shape of a PlanConcept. */
export const CENSUS_CONCEPT = {
  id: "A",
  angle: "ZQ043 the unseen hour",
  feeling: "ZQ044 steady",
  line: "ZQ045 she trains before anyone arrives",
} as const;

/** The confirm step's flags (PR 13) — stored on the plan row. */
export const CENSUS_CONFIRM = [
  { path: "story", basis: "literal", quote: "ZQ046 the club record" },
  {
    path: "creative_direction.energy",
    basis: "inferred",
    because: "ZQ047 the brief reads calm",
  },
] as const;

// ─── Her library, as the tagger would have written it ────────────────────────────────────────────

/** Her photo of HER — every tagger field set, every enum off its default. */
export const VISION_HER = {
  athlete_present: true,
  subject: "the_athlete",
  athlete_prominence: 0.71,
  shot_type: "lifestyle",
  description: "ZQ101 she ties her laces on the court line",
  brands_visible: ["Zq102brand"],
  aesthetic_quality: 0.83,
  brand_safe: true,
  content_flags: {
    hateful: false,
    sexual: false,
    violence_or_weapons: false,
    drugs_or_alcohol: false,
    self_harm: false,
    obscene_gesture: false,
  },
  setting: "ZQ103 an outdoor court at dawn",
  attire: "ZQ104 a netball bib and vest",
  vibe: "ZQ105 patient",
  hero_suitability: 0.77,
  disposition: "enhance",
  edit_note: "ZQ106 lift the shadows",
  reason: "ZQ107 her face is clear and the light is kind",
  face_visibility: "clear",
  role: "identity",
} as const;

/** A second photo of her, for the held still. */
export const VISION_HELD = {
  ...VISION_HER,
  description: "ZQ108 she stretches against the post",
  setting: "ZQ109 the court fence",
  vibe: "ZQ110 loose",
  edit_note: "ZQ111 none needed",
  reason: "ZQ112 a calm frame",
  brands_visible: [],
} as const;

/** Her product photo. */
export const VISION_PRODUCT = {
  ...VISION_HER,
  athlete_present: false,
  subject: "nobody",
  shot_type: "other",
  description: "ZQ113 a pair of spikes on a bench",
  setting: "ZQ114 a changing-room bench",
  vibe: "ZQ115 still",
  attire: "none",
  edit_note: "ZQ116 none",
  reason: "ZQ117 the product fills the frame",
  brands_visible: [],
  face_visibility: "none",
  role: "product",
} as const;

/** Her clip, read into beats (video tagger shape). */
export const VISION_CLIP = {
  ...VISION_HER,
  description: "ZQ118 she sprints the length of the court",
  setting: "ZQ119 the court at dawn",
  vibe: "ZQ120 driving",
  brands_visible: [],
  beats: [
    {
      start_s: 0,
      end_s: 3,
      description: "ZQ121 she sets off from the baseline",
      camera: "wide",
      motion: "running",
      shot_type: "action",
      athlete_present: true,
      athlete_prominence: 0.6,
      aesthetic_quality: 0.7,
      hero_suitability: 0.6,
      setting: "ZQ122 the baseline",
      attire: "ZQ123 the bib",
      vibe: "ZQ124 urgent",
      brands_visible: [],
    },
    {
      start_s: 3,
      end_s: 6,
      description: "ZQ125 she slows and turns to camera",
      camera: "close_up",
      motion: "turning",
      shot_type: "portrait",
      athlete_present: true,
      athlete_prominence: 0.9,
      aesthetic_quality: 0.8,
      hero_suitability: 0.8,
      setting: "ZQ126 mid-court",
      attire: "ZQ127 the bib",
      vibe: "ZQ128 proud",
      brands_visible: [],
    },
  ],
  video: {
    source: "census",
    model: "census",
    sampled_fps: 1,
    duration_s: 6,
    tagged_at: "2026-09-24T00:00:00Z",
  },
} as const;

// ─── The planner's answer (the model, mocked — the reply is fixture, not a field) ────────────────

/**
 * Every capability axis on the b-roll item takes a non-default member; the i2v takes a movement;
 * `reason.entry` must be one the library entry list offers (studio/agent/entryPrompt.ts).
 */
export const PLAN_CAPS = {
  camera: "low_angle",
  movement: "orbit",
  lighting: "rim_light",
  composition: "negative_space",
  motion: "jumping",
} as const;

// ─── MEMBER expectations: the words a chosen member must produce, where ──────────────────────────

export interface MemberExpectation {
  /** Census row id. */
  row: string;
  /** The words that member produces; case-insensitive. */
  words: string;
}

/**
 * The closed-vocabulary rows and the words their chosen member produces in whatever carries it. The
 * census asks where these words land; a member that lands nowhere downstream is dead like a nonce.
 * Only rows whose member has a phrase are here — the rest are DECIDES (a branch, cited) or DEAD.
 */
/** Each reading dimension's tags and basis, as `campaignBlock` renders them beside its summary. */
const READING_MEMBERS: MemberExpectation[] = Object.entries(
  CENSUS_CAMPAIGN.references[0].intent,
).flatMap(([dim, r]) => {
  const tags = r.tags.length ? ` [${r.tags.join(", ")}]` : "";
  return [
    ...(r.tags.length
      ? [
          {
            row: `campaignBrief:references[].intent.${dim}.tags`,
            words: `${r.summary}${tags}`,
          },
        ]
      : []),
    {
      row: `campaignBrief:references[].intent.${dim}.basis`,
      words: `${r.summary}${tags} (${r.basis})`,
    },
  ];
});

export const MEMBERS: readonly MemberExpectation[] = [
  // As the planner's campaign block words them (studio/agent/plan.ts `campaignBlock`) and the carrier's
  // feel line (studio/campaign/carrier.ts `feelLine`). Her ask's own objective is thank-partner, so
  // the brief's goal (recap) is told apart from it.
  { row: "campaignBrief:objective.type", words: "objective: ad" },
  { row: "campaignBrief:objective.goal", words: "ad — recap" },
  { row: "campaignBrief:subject.identity_priority", words: "identity maximum" },
  { row: "campaignBrief:product.ref", words: "her product photo p1" },
  { row: "campaignBrief:product.fidelity", words: "fidelity standard" },
  { row: "campaignBrief:creative_direction.style", words: "documentary" },
  { row: "campaignBrief:references[].role", words: "composition_reference" },
  { row: "campaignBrief:output.type", words: "deliver as: video" },
  { row: "campaignBrief:output.aspect_ratio", words: "video, 4:5" },
  { row: "campaignBrief:output.platform", words: "4:5, tiktok" },
  { row: "campaignBrief:brand.profile", words: "profile zqprofile_4" },
  // The reading, as the planner's campaign block renders it: `ref_1 (role) reads as — dim: summary [tags] (basis)`.
  {
    row: "campaignBrief:references[].ref",
    words: "ref_1 (composition_reference) reads as",
  },
  ...READING_MEMBERS,
  // The tagger's closed fields and numbers, as the library line labels them (plan.ts `tagWords`,
  // `libraryLine`) — the labels exist only with STUDIO_LIBRARY_FIELDS on, except shot and person.
  { row: "assetTags:athlete_present", words: "person_in_frame: yes" },
  { row: "assetTags:subject", words: "who: the_athlete" },
  { row: "assetTags:athlete_prominence", words: "prominence: 0.7" },
  { row: "assetTags:shot_type", words: "shot: lifestyle" },
  { row: "assetTags:aesthetic_quality", words: "quality: 0.8" },
  { row: "assetTags:brand_safe", words: "brand_safe: yes" },
  { row: "assetTags:hero_suitability", words: "hero: 0.8" },
  { row: "assetTags:disposition", words: "disposition: enhance" },
  { row: "assetTags:face_visibility", words: "face: clear" },
  { row: "assetTags:role", words: "role: identity" },
  { row: "libraryEntry:shotType", words: "shot: lifestyle" },
  { row: "libraryEntry:athletePresent", words: "person_in_frame: yes" },
  { row: "libraryEntry:picked", words: "her pick: yes" },
  { row: "libraryEntry:mediaType", words: "| clip 6s |" },
  { row: "libraryEntry:durationSeconds", words: "clip 6s" },
  { row: "libraryEntry:beats[].index", words: "[1] 3-6s" },
  { row: "libraryEntry:beats[].startSec", words: "[1] 3-6s" },
  { row: "libraryEntry:beats[].endSec", words: "[1] 3-6s" },
  { row: "libraryEntry:tags.subject", words: "who: the_athlete" },
  { row: "libraryEntry:tags.prominence", words: "prominence: 0.7" },
  { row: "libraryEntry:tags.quality", words: "quality: 0.8" },
  { row: "libraryEntry:tags.hero", words: "hero: 0.8" },
  { row: "libraryEntry:tags.brandSafe", words: "brand_safe: yes" },
  { row: "libraryEntry:tags.flags", words: "flags: none" },
  { row: "libraryEntry:tags.disposition", words: "disposition: enhance" },
  { row: "libraryEntry:tags.face", words: "face: clear" },
  { row: "libraryEntry:tags.role", words: "role: identity" },
  // The ad's goal is a member of the brief's goals, rendered in the ad's CAMPAIGN block.
  { row: "opParams:ad.campaign.goal", words: "goal: recap" },
  { row: "opParams:ad.headline", words: "relay record" },
  // The carrier's style, as its feel line words it (carrier.ts `feelLine`).
  { row: "jobCampaign:style", words: "documentary" },
  // The carrier's tone, told apart from her feel line (which copies it): the feel line's own shape.
  { row: "jobCampaign:tone", words: "zq006 hushed · documentary" },
  { row: "opParams:product.place.preposition", words: "beside" },
  { row: "opParams:garment.brand", words: "qorvane" },
];

// ─── The derived token map ───────────────────────────────────────────────────────────────────────

/**
 * Every leaf path of `obj` whose value carries a token, keyed `<prefix>:<path>`, with the tokens it
 * carries. Arrays of objects walk as `path[]`, matching the census row paths (census/rows.ts).
 */
export function noncesIn(prefix: string, obj: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (path: string, v: string) => {
    const found = v.match(TOKEN)?.map((t) => t.toUpperCase());
    if (!found) return;
    const id = `${prefix}:${path}`;
    out.set(id, [...new Set([...(out.get(id) ?? []), ...found])]);
  };
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") return add(path, v);
    if (Array.isArray(v)) {
      const objects = v.some(
        (x) => x && typeof x === "object" && !Array.isArray(x),
      );
      for (const x of v) walk(x, objects ? `${path}[]` : path);
      return;
    }
    if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v))
        walk(x, path ? `${path}.${k}` : k);
  };
  walk(obj, "");
  return out;
}

/** The fixture's own token map for the sources it sets directly. */
export function fixtureNonces(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const merge = (m: Map<string, string[]>) => {
    for (const [k, v] of m)
      out.set(k, [...new Set([...(out.get(k) ?? []), ...v])]);
  };
  merge(noncesIn("campaignBrief", CENSUS_CAMPAIGN));
  // The readings, by dimension: a reading dimension's tokens are its summary's.
  for (const [dim, r] of Object.entries(CENSUS_CAMPAIGN.references[0].intent))
    merge(
      new Map([
        [
          `readingDimension:${dim}`,
          (r.summary.match(TOKEN) ?? []).map((t) => t.toUpperCase()),
        ],
      ]),
    );
  merge(noncesIn("assetTags", VISION_HER));
  merge(opNonces());
  return out;
}

// ─── The typed edit ops (PR 9) — every param a token, set through the doors that send them ───────

/** The op params the census sends, by op. `productAssetId` is filled with her product's id at run time. */
export const OP_PARAMS = {
  recolour: { target: "ZQ131 bib", colour: "ZQ132 teal" },
  garment: { garment: "ZQ135 vest", brand: "Qorvane" },
  garmentDesign: { garment: "ZQ135 vest", design: "ZQ140 a thin stripe" },
  productPlace: {
    mode: "place",
    thing: "ZQ136 spikes",
    place: { preposition: "beside", place: "ZQ137 bench" },
  },
  productAdd: {
    mode: "add",
    thing: "ZQ144 ball",
    place: { preposition: "beside", place: "ZQ137 bench" },
  },
  productRemove: { mode: "remove", target: "ZQ138 cone" },
  backgroundClean: { setting: "ZQ139 an empty court" },
  // The ad's own tokens — never the brief's, so a brief line reaching an ad is measured only through the
  // carousel batch (which carries the brief's lines), not through this fixture.
  ad: {
    brand: "Qorvane ZQ145",
    // A headline may only say what the campaign says (ops.ts headline grounding): words from its story.
    headline: "Relay record",
    setting: "ZQ130 a sunlit track",
    campaign: {
      product: "ZQ146 the road flat",
      story: "ZQ147 the relay record, broken at dawn",
      goal: "recap",
    },
    instruction: "ZQ143 keep it simple",
  },
} as const;

/** The op params' token map, keyed as census rows (`opParams:<op>.<path>`). */
export function opNonces(): Map<string, string[]> {
  const o = OP_PARAMS;
  return noncesIn("opParams", {
    recolour: o.recolour,
    garment: { ...o.garment, design: o.garmentDesign.design },
    product: { ...o.productPlace, target: o.productRemove.target },
    background_clean: o.backgroundClean,
    ad: o.ad,
  });
}
