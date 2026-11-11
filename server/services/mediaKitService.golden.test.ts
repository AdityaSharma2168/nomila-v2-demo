/**
 * mediaKitService.golden.test.ts — CHARACTERIZATION test for the deck assembler.
 *
 * Written BEFORE the getAthleteContext() extraction and deliberately asserting on the assembler's
 * FULL OUTPUT rather than on any internal seam, so it survives code moving underneath it. Its whole
 * job is to prove the extraction is behaviour-preserving: snapshot before, refactor, snapshot after,
 * byte-identical.
 *
 * Determinism: the DB is PGlite (real SQL, synthetic rows) and every model / network boundary is
 * stubbed with a canned response — Gemini (shot list), the Narrator, the embedder, and GCS signing.
 * `meta.generatedAt` is the only clock-dependent field and is normalised out.
 *
 * The fixture MIRRORS THE SHAPE of the real spike athlete's record (counts, tag distribution, rate
 * card structure — see docs/studio-inventory-findings.md §11) but every value is invented. No real
 * athlete data is in this file.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

// ── Model + network boundaries ────────────────────────────────────────────────
// The shot list is the only Gemini call the assembler makes directly (via deriveDeckPlan).
const SHOT_LIST = {
  facets: ["elite competitor", "national-team athlete", "the person off the field"],
  shots: [
    { card: "cover",    role: "establishing", facet: "elite competitor",      mood: "hard evening light", beat: "she arrives",     searchQuery: "action shot in match kit" },
    { card: "audience", role: "portrait",     facet: "the person off the field", mood: "warm",           beat: "meet her",        searchQuery: "warm candid portrait" },
    { card: "content",  role: "action",       facet: "elite competitor",      mood: "kinetic",           beat: "she performs",    searchQuery: "mid-action on the field" },
    { card: "fit",      role: "portrait",     facet: "the person off the field", mood: "soft daylight",  beat: "she belongs",     searchQuery: "off-field everyday portrait" },
    { card: "video",    role: "action",       facet: "national-team athlete", mood: "broadcast",         beat: "see it live",     searchQuery: "in-action clip" },
  ],
};

// Every prompt sent to Gemini is recorded, so the shot-list PROMPT is part of the golden too.
// Without this a change to what the Strategist is told would be invisible to a snapshot of the deck.
const mockPrompts: string[] = [];
jest.mock("../lib/models", () => ({
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI: { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
  genai: () => ({
    models: {
      generateContent: async (req: any) => {
        mockPrompts.push(req?.contents?.[0]?.parts?.[0]?.text ?? "");
        return { text: JSON.stringify(SHOT_LIST) };
      },
    },
  }),
}));

// The Narrator is a whole multi-model fan-out of its own; canned here so the assembler's pick()
// seam and copyAlternates are exercised with stable values.
jest.mock("./narrator", () => {
  const actual = jest.requireActual("./narrator");
  const slot = (card: string, s: string) => [`${card}-${s}-A`, `${card}-${s}-B`];
  return {
    ...actual,
    narrateKit: jest.fn(async () => ({
      cards: ["cover", "index", "audience", "content", "video", "rates", "fit", "payments", "achievements", "story", "values", "whyFits"].map((card) => ({
        card, eyebrow: slot(card, "eyebrow"), tagline: slot(card, "tagline"), extra: slot(card, "extra"),
      })),
    })),
    narrateWhyFits: jest.fn(async () => ({
      audience: "wf-audience", credibility: "wf-credibility", whitespace: "wf-whitespace",
    })),
    narrateCampaignConcept: jest.fn(async () => ({
      title: "cc-title", line: "cc-line", lineEmphasis: "cc-emph", facets: ["cc-f1", "cc-f2"], note: "cc-note",
    })),
    narrateActivationPlan: jest.fn(async () => ({
      lead: "ap-lead", buckets: [{ label: "In season", audience: "fans", line: "ap-line" }], close: "ap-close",
    })),
  };
});

// Deterministic embeddings: a stable pseudo-vector per input string, so cosine ordering is fixed.
jest.mock("../lib/mediaEmbed", () => {
  const actual = jest.requireActual("../lib/mediaEmbed");
  const vec = (seed: string): number[] => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return Array.from({ length: 8 }, (_, i) => (((h >>> i) & 0xff) / 255) || 0.01);
  };
  return { ...actual, embedText: jest.fn(async (t: string) => vec(t)), embedImageGcs: jest.fn(async (p: string) => vec(p)) };
});

// Her M.I.A. read (legacy retirement P2-2): the index card and the prompts' mia_strengths come from the ledger read
// My Intelligence shows. Canned here — the deck assembler only consumes the projected assessment.
jest.mock("./intelligence/views/myIntelligence", () => ({
  buildMyIntelligence: jest.fn(async () => ({
    assessment: {
      score: 612,
      dimensions: [
        { key: "audience_scale", state: "strength", score: 78 },
        { key: "commercial_proof", state: "gap", score: 31 },
        { key: "athletic_authority", state: "strength", score: 84 },
        { key: "momentum", state: "neutral", score: 55 },
      ],
    },
  })),
}));

// The proof card's per-frame text check is a Gemini vision call on the stored image (frameText.ts): the provider
// boundary, so it is stubbed — every fixture frame is clean.
jest.mock("./frameText", () => ({ frameHasText: jest.fn(async () => false), cachedFrameText: () => null }));

jest.mock("../lib/mediaStore", () => ({
  ...jest.requireActual("../lib/mediaStore"),
  signedUrl: jest.fn(async (p: string) => `signed:${p}`),
}));

import { assembleMediaKit } from "./mediaKitService";
import { athletes, athletesCurrent, athleteSnapshots, socialAnalyticsSnapshots, mediaAssets, inboxBrands } from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

// Research confirmed on the brand's own domain (BRAND_IDENTITY_GATE): fit copy is served only in this state.
const CONFIRMED_IDENTITY = { status: "confirmed", domain: "brand.example", own_sources: ["brand.example"], basis: "own_domain_source", checked_at: "2026-10-01T00:00:00.000Z" };

// Fixed so the snapshot is byte-stable across runs (the column defaults to gen_random_uuid()).
const ATHLETE_ID = "11111111-2222-4333-8444-555555555555";
let athleteId: string;
let brandId: number;

// ── Synthetic fixture ─────────────────────────────────────────────────────────
const RATE_CARD = {
  pav: { low: 14000, mid: 22000, high: 31000 },
  social: [
    { platform: "instagram", followers: 22000, ratePerPost: { low: 300, mid: 470, high: 700 } },
    { platform: "tiktok",    followers: 15000, ratePerPost: { low: 500, mid: 833, high: 1200 } },
  ],
  headlineSocial: { ratePerPost: { low: 500, mid: 833, high: 1200 } },
  ambassador:  { monthlyRetainer: { low: 2000, mid: 3200, high: 4800 } },
  appearance:  { ratePerEvent: { low: 1500, mid: 2400, high: 3600 } },
};

const RESEARCH = {
  achievements: [
    { name: "Youth National Team call-up", year: "2024", level: "national" },
    { name: "All-Conference First Team",   year: "2025", level: "conference" },
    { name: "Team captain",                year: "2026", level: "team" },
    { name: "Academic honour roll",        year: "2023", level: "academic" },
    { name: "Regional champion",           year: "2022", level: "regional" },
  ],
  brand_mentions: [
    { brand: "Northwind Apparel", type: "partnership", confidence: 0.7 },
    { brand: "Beacon Nutrition",  type: "gifted",      confidence: 0.4 },
  ],
  press_mentions: [{ outlet: "Example Wire", headline: "A breakout season", date: "2026-03-01" }],
  values: [
    { name: "Access to the game", line: "Every kid deserves a field." },
    { name: "Study hard",         line: "The classroom counts too." },
  ],
  story_arc: "A regional standout who grew into a national-team call-up. Now the face of her programme.",
};

/** Vision tags shaped like the real distribution: a few as_is heroes, some rejects, one video. */
function vision(i: number, kind: "hero" | "portrait" | "reject" | "video") {
  const base = { brand_safe: true, setting: "field", attire: "kit", vibe: "focused", edit_note: "", reason: "r" };
  if (kind === "reject")
    return { ...base, subject: "nobody", athlete_present: false, athlete_prominence: 0.1, shot_type: "text_graphic", description: `graphic ${i}`, brands_visible: [], aesthetic_quality: 0.2, hero_suitability: 0.1, disposition: "reject" };
  if (kind === "portrait")
    return { ...base, subject: "the_athlete", athlete_present: true, athlete_prominence: 0.9, shot_type: "portrait", description: `portrait ${i}`, brands_visible: ["Northwind"], aesthetic_quality: 0.85, hero_suitability: 0.8, disposition: "as_is" };
  if (kind === "video")
    return { ...base, subject: "the_athlete", athlete_present: true, athlete_prominence: 0.8, shot_type: "action", description: `clip ${i}`, brands_visible: [], aesthetic_quality: 0.7, hero_suitability: 0.75, disposition: "as_is" };
  return { ...base, subject: "the_athlete", athlete_present: true, athlete_prominence: 0.85, shot_type: "action", description: `action ${i}`, brands_visible: ["Northwind"], aesthetic_quality: 0.9, hero_suitability: 0.92, disposition: "as_is" };
}

beforeAll(async () => {
  await initTestDb();

  const [a] = await db.insert(athletes).values({
    id: ATHLETE_ID,
    full_name: "Test Spike Athlete", sport: "soccer", school: "Example University",
    division: "D1", conference: "Example Conference", segment: "college",
  } as any).returning({ id: athletes.id });
  athleteId = a.id;

  await db.insert(athletesCurrent).values({
    athlete_id: athleteId,
    story_arc: RESEARCH.story_arc,
  } as any);

  await db.insert(athleteSnapshots).values({
    athlete_id: athleteId, trigger: "manual", research: RESEARCH,
    google_trends_score: "40", gdelt_article_count: 3, social: {}, deals: [],
  } as any);

  await db.insert(socialAnalyticsSnapshots).values([
    {
      athlete_id: athleteId, platform: "instagram", source: "connected", followers: 22000,   // the substrate (P2-3)
      snapshot_date: new Date("2026-08-01T00:00:00Z"), snapshot_day: "2026-08-01",
      top_audience_gender: "F", top_audience_age_range: "18-24", top_audience_city: "Exampleton",
      raw_metrics: {
        demographics: {
          country: [{ key: "US", pct: 61 }, { key: "GB", pct: 9 }, { key: "CA", pct: 6 }, { key: "MX", pct: 4 }],
          gender:  [{ key: "F", pct: 63 }, { key: "M", pct: 37 }],
        },
      },
    },
    {
      athlete_id: athleteId, platform: "tiktok", source: "connected", followers: 15000,
      snapshot_date: new Date("2026-08-01T00:00:00Z"), snapshot_day: "2026-08-01",
      top_audience_gender: "F", top_audience_age_range: "18-24", top_audience_city: "Exampleton",
      raw_metrics: {},
    },
  ] as any);

  // 14 assets: 5 action heroes, 4 portraits, 4 rejects, 1 playable video.
  const kinds: Array<"hero" | "portrait" | "reject" | "video"> = [
    "hero", "hero", "hero", "hero", "hero",
    "portrait", "portrait", "portrait", "portrait",
    "reject", "reject", "reject", "reject",
    "video",
  ];
  await db.insert(mediaAssets).values(kinds.map((kind, i) => ({
    athlete_id: athleteId,
    platform: "instagram",
    origin: "connected",
    source_media_id: `src-${i}`,
    media_type: kind === "video" ? "VIDEO" : "IMAGE",
    permalink: `https://example.test/p/${i}`,
    caption: `caption ${i}`,
    posted_at: new Date(Date.UTC(2026, 0, 1 + i)),
    like_count: 100 + i * 10,
    comments_count: 5 + i,
    insights: { video_views: 10000 - i * 300, reach: 20000 - i * 400, saved: 50 + i, shares: 10 + i },
    gcs_path: kind === "video" ? `athletes/x/${i}.mp4` : `athletes/x/${i}.jpg`,
    gcs_thumb_path: kind === "video" ? `athletes/x/${i}-poster.jpg` : null,
    content_type: kind === "video" ? "video/mp4" : "image/jpeg",
    status: "stored",
    metadata: { vision: vision(i, kind), embedding: Array.from({ length: 8 }, (_, k) => ((i + 1) * (k + 1)) % 7 / 7) },
  })) as any);

  const [b] = await db.insert(inboxBrands).values({
    name: "Northwind Apparel", normalized_name: "northwind apparel", is_agency: false,
    category: "Sportswear", brand_tier: "established",
    audience_summary: "Young performance-minded shoppers",
    sport_categories: ["soccer", "running"],
    known_athlete_partnerships: ["Some Runner"],
    logo_url: "https://example.test/logo.png",
    enriched_at: new Date("2026-08-01T00:00:00Z"),
    enrichment: { identity: CONFIRMED_IDENTITY,
      industry: "Sportswear", content_style: "clean functional",
      competitors: ["Southgale", "Eastbrook"],
      recent_campaigns: ["Spring Kit Drop", "Trail Series"],
      brand_values: "earned, understated, technical",
      product_categories: ["training tops", "cleats"],
    },
  } as any).returning({ id: inboxBrands.id });
  brandId = b.id;
});

afterAll(async () => { await closeTestDb(); });

/** generatedAt is the only clock-dependent field in the kit. */
function stable(kit: any) {
  return { ...kit, meta: { ...kit.meta, generatedAt: "<generatedAt>" } };
}

describe("assembleMediaKit — golden output (characterization)", () => {
  it("public deck (no brand) is unchanged", async () => {
    const kit = await assembleMediaKit(athleteId);
    expect(stable(kit)).toMatchSnapshot("public-deck");
  });

  it("brand deck is unchanged", async () => {
    const kit = await assembleMediaKit(athleteId, { brandId });
    expect(stable(kit)).toMatchSnapshot("brand-deck");
  });

  it("sends the Strategist an unchanged shot-list prompt", async () => {
    mockPrompts.length = 0;
    await assembleMediaKit(athleteId);
    expect(mockPrompts).toHaveLength(1);
    expect(mockPrompts[0]).toMatchSnapshot("shotlist-prompt-public");

    mockPrompts.length = 0;
    await assembleMediaKit(athleteId, { brandId });
    expect(mockPrompts).toHaveLength(1);
    expect(mockPrompts[0]).toMatchSnapshot("shotlist-prompt-brand");
  });

  it("emits the same ordered step labels the Studio timeline matches on", async () => {
    const steps: string[] = [];
    await assembleMediaKit(athleteId, { brandId, onStep: (l) => steps.push(l) });
    expect(steps).toMatchSnapshot("build-steps");
  });
});
