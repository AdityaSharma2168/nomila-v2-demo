/**
 * mediaKitService — Phase 1 of the brand-engine (see docs/brand-engine-roadmap.md §8,
 * docs/media-kit-specs.md). Assembles a theme-agnostic `MediaKitData` object from real,
 * owned data: profile + her M.I.A. score + audience + top content (owned media) + research. A template renders this; the engine never renders per-athlete layout.
 *
 * v1 = data spine + a rules-based Strategist + the confidence layer. Notably: it tells the
 * truth about Commercial — if research found partnerships (e.g. Adidas) it surfaces them as
 * `inferred` rather than showing a bare `0`. The narrative model + per-brand tailoring come later.
 */
import { getAthleteContext, compact, titleCase, rankOf, marqueeScore } from "./athleteContext";
import { curateAthleteMedia } from "./curator";
import { loadCopyBrief } from "./copyContext";
import { copywriterEnabled, narrateKit, defaultCardBriefs, narrateWhyFits, narrateCampaignConcept, narrateActivationPlan, usesAvoided, BEAT_SEP, type CardBrief, type NarratorContext, type WhyFitsReasons, type CampaignConcept, type ActivationPlan } from "./narrator";
import type { BrandVoice } from "../mila/profileFields";
import { deriveDeckPlan, getBrandContext } from "./shotList";
import { loadConnectedChannels, type ConnectedChannel } from "../agent/research/connected";
import { pitchConceptEnabled, loadBrandResearch, writePitchConcept, writeSignatureIdea, usableAccent } from "./pitchConcept";
import { dedupeClaims, loadAudienceBreakdown } from "./deckFacts";
import { createLogger } from "../logger";

const logger = createLogger("media-kit");

// ─── Types (mirror docs/media-kit-specs.md, v1 subset) ──────────────────────────
type Provenance = "verified" | "self_reported" | "inferred" | "unknown";
interface Confidence { level: Provenance; score: number }
type Emphasis = "hero" | "standard" | "quiet";

export interface MediaKitData {
  athleteId: string;
  identity: { name: string; sport: string; school: string; hook: string };
  // theme: the look (shared/deckLooks — nomila | luxe | broadcast; a retired one renders as nomila). lookAdvice: on a
  // brand deck only, the look recommended from the brand's category and why (kitCache.brandLookAdvice).
  tokens: { theme: string; accent: string; lookAdvice?: import("../../shared/deckLooks").LookAdvice };
  cards: Card[];
  deck?: string[];             // ordered card ids shown by default; cards NOT here are the "library" (addable in the editor)
  copyAlternates?: Record<string, { eyebrow?: string[]; tagline?: string[]; extra?: string[] }>;  // Narrator options per card, for the editor's copy-picker
  imagePool?: Array<{ gcsPath: string; shotType: string; hero: number }>;  // atmospheric bg candidates — themes draw per mood
  meta: { generatedAt: string; overallConfidence: number };
}
interface CardBase { id: string; type: string; emphasis: Emphasis; confidence: Confidence; eyebrow: string; bg?: string | null }
type FitBasis = "audience" | "credibility" | "whitespace" | "values";
type Card =
  | (CardBase & { type: "cover"; image: string | null; nameLines: string[]; meta: string; hook: string; stats: Array<{ value: string; label: string }> })
  // index = her M.I.A. score (scale "mia"). No tier word, no rings, and no "mix" card (owner decision 1, 8 Oct 2026).
  | (CardBase & { type: "index"; value: number; max: number; scale: "mia"; verdict: string })
  // ages / genders / platforms: the audience chart (deckFacts.audienceBreakdownFrom) — additive; a card cached before
  // has none and renders as it did.
  | (CardBase & { type: "audience"; headline: string; sub: string; share: number | null; geo: Array<{ label: string; pct: number | null }>; stats: Array<{ n: string; k: string }>;
      ages?: Array<{ label: string; pct: number }>; genders?: Array<{ label: string; pct: number }>; platforms?: Array<{ label: string; n: number; pct: number }>;
      // brandAudience: a tailored pitch's brand, as its research describes who it sells to (the overlap read). Additive.
      brandAudience?: { brand: string; text: string } })
  // stats: MEASURED channel numbers (connected accounts) — the proof block; additive, a cached card has none.
  | (CardBase & { type: "content"; heroStat: { value: string; label: string }; tiles: Array<{ image: string | null; stat: string }>; note: string; stats?: Array<{ value: string; label: string }> })
  | (CardBase & { type: "video"; posterUrl: string | null; videoUrl: string; note: string })
  // ── card library (Spec 8/9) ──
  | (CardBase & { type: "whyFits"; brand: { id: number; name: string; category: string; logo?: string | null }; lead: string; reasons: Array<{ head: string; insight: string; basis: FitBasis }> })
  | (CardBase & { type: "story"; beats: Array<{ year: string; where: string; line: string; current?: boolean }>; close: string })
  | (CardBase & { type: "values"; statement: string; planks: Array<{ name: string; line: string; provenance: Provenance }>; note: string })
  // story / heroStory: the copywriter's third-person line per honour (the honour stays as the small fact line). Additive.
  | (CardBase & { type: "achievements"; heroEntry: { year: string; name: string; badge: string; detail: string }; entries: Array<{ year: string; name: string; level: string; story?: string }>; footnote: string; heroStory?: string })
  | (CardBase & { type: "fit"; image: string | null; lead: string; body: string; tags: string[] })
  // ── Brand-tailored creative cards (gorjana template, Phase 2) — brand kits only ──
  // brandImage (PITCH_CONCEPT_V1): the brand's own imagery from its research — a source URL, never signed.
  | (CardBase & { type: "campaignConcept"; brand: { id: number; name: string; category: string; logo?: string | null }; title: string; line: string; lineEmphasis: string; facets: string[]; note: string; image: string | null; brandImage?: string | null })
  | (CardBase & { type: "activationPlan"; lead: string; buckets: Array<{ label: string; audience: string; line: string }>; close: string; brandImage?: string | null })
  // signatureIdea (PITCH_CONCEPT_V1): the generic card's own creative platform — the public card's answer to a brand concept.
  | (CardBase & { type: "signatureIdea"; title: string; line: string; lineEmphasis: string; facets: string[]; note: string; image: string | null });


// compact / titleCase / schoolShort / countryName / rankOf / marqueeScore / credentialTag +
// deckRateFigures all moved behind athleteContext.ts, so every consumer of an athlete brief reads
// and formats the same facts identically. This file keeps only deck-level formatting.

// Brand-fit categories, DERIVED (not hardcoded) — sport + audience gender + (brand deck) the brand's
// category. Generalizes across sports/genders vs. the old fixed Apparel/Wellness/Beverage/Beauty.
function deriveFitCategories(sport: string, gender: string | undefined, brandCategory?: string | null): string[] {
  const s = (sport || "").toLowerCase();
  const out: string[] = [];
  if (brandCategory?.trim()) out.push(titleCase(brandCategory.trim()));   // brand deck LEADS with the brand's category
  out.push("Apparel");                                                    // near-universal for athletes
  if (/soccer|basketball|football|tennis|track|run|volleyball|hockey|rugby|lacrosse|golf|softball|baseball/.test(s)) out.push("Footwear");
  out.push("Sports Nutrition", "Beverage");
  if (gender === "F")      out.push("Beauty", "Wellness");
  else if (gender === "M") out.push("Grooming", "Tech");
  else                     out.push("Wellness", "Tech");
  return Array.from(new Set(out)).slice(0, 5);
}
/**
 * The proof block: measured numbers only, from her connected accounts (the same read the brand book's "who's listening"
 * uses) — average reach and views per post, engagement rate, followers. Never a computed "conversion" figure. Pure.
 */
export function proofStats(channels: Array<Pick<ConnectedChannel, "platform" | "followers" | "avgEngagementRate" | "avgReachPerPost" | "avgViewsPerPost">>): Array<{ value: string; label: string }> {
  const name = (p: string) => ({ instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as Record<string, string>)[p] ?? p;
  const out: Array<{ value: string; label: string }> = [];
  const byReach = [...channels].filter((c) => c.avgReachPerPost).sort((a, b) => (b.avgReachPerPost ?? 0) - (a.avgReachPerPost ?? 0))[0];
  if (byReach?.avgReachPerPost) out.push({ value: compact(byReach.avgReachPerPost), label: `${name(byReach.platform)} reach per post` });
  const byViews = [...channels].filter((c) => c.avgViewsPerPost).sort((a, b) => (b.avgViewsPerPost ?? 0) - (a.avgViewsPerPost ?? 0))[0];
  if (byViews?.avgViewsPerPost) out.push({ value: compact(byViews.avgViewsPerPost), label: `${name(byViews.platform)} views per post` });
  const byEng = [...channels].filter((c) => c.avgEngagementRate != null && c.avgEngagementRate > 0).sort((a, b) => (b.avgEngagementRate ?? 0) - (a.avgEngagementRate ?? 0))[0];
  if (byEng?.avgEngagementRate != null) {
    const r = byEng.avgEngagementRate; // stored as a percentage (connected.ts: "a 5.2% engagement rate")
    out.push({ value: `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}%`, label: `${name(byEng.platform)} engagement` });
  }
  return out.slice(0, 3);
}

export async function assembleMediaKit(
  athleteId: string,
  opts: { brandId?: number; onStep?: (label: string) => void; angles?: string[] } = {},
): Promise<MediaKitData> {
  const step = opts.onStep ?? (() => {});

  // 1. The athlete brief — ONE read, shared with generation (see athleteContext.ts). This used to be
  //    ~90 lines inline here; it is the same code, moved. Locals below are destructured rather than
  //    referenced as ` athlete.x ` so the card-binding body underneath is byte-for-byte unchanged.
  const athlete = await getAthleteContext(athleteId);
  const {
    combinedFollowing,
    causes, brandMentions,
    geoCountry, audienceShare, gender,
    confirmedPartners, commercialState,
    identityLine, signalHighlights, audienceFacts, signals,
  } = athlete;
  const topIns = athlete.topPostInsights;
  // One fact said several ways ("First Indian-American to represent US…", "first player of Indian descent…") is ONE
  // line: the record, the story and the marquee all read the deduplicated, still prestige-ranked list (deckFacts.ts).
  const ranked = dedupeClaims(athlete.ranked);
  const marquee = ranked[0] ?? athlete.marquee;
  const achievementsRaw = dedupeClaims(athlete.achievementsRaw);
  // The record's honours as story lines (22 Oct 2026): the copywriter writes ONE line per honour, in the third person,
  // about what it meant — the honour itself stays as the small fact line. Same narrator call (a "beats" slot), no extra.
  const recordRows = ranked.length ? [ranked[0], ...ranked.slice(1, 5)] : [];
  const recordBrief: CardBrief | null = recordRows.length >= 2 ? {
    card: "record", label: "The record (story lines)", slots: ["beats"], count: recordRows.length,
    factsShown: recordRows.map((a) => `${a.year ?? ""} ${a.name}`.trim()),
    intent: `beats = ONE crafted line per honour below, in order, in the third person (the athlete's first name or the pronouns the context gives) — what that honour meant or opened, not what happened (the honour and its year already sit under the line). Read together they are chapters, not a list. Never repeat the honour's own words or its year. Honours: ${recordRows.map((a, i) => `[${i}] ${a.year ?? ""} — ${a.name}`).join("; ")}`,
  } : null;
  // `cur` keeps the assembler's original shape so every card binding below reads unchanged.
  const cur = {
    name: athlete.name, sport: athlete.sport, school: athlete.school,
    storyArc: athlete.storyArc,
    achievements: athlete.achievementsCount, press: athlete.pressCount,
  };
  // `ig` likewise — the audience demo row, flattened onto the context.
  const ig = { gender: athlete.gender, age: athlete.audienceAge, city: athlete.audienceCity };

  // 2. Brand context (Spec 9) — derived ONCE; it tailors BOTH the shot list (image facets) AND the
  //    Narrator copy (esp. whyFits), so a brand kit rebuilds every card FOR that brand, not beside it.
  const brand = opts.brandId ? await getBrandContext(opts.brandId) : null;
  step("Finding your fit");

  // Brand-fit categories. On a BRAND deck the brand is already known → FOCUS on its own category
  // (a known-brand pitch shouldn't advertise other lanes — whyFits already makes the brand case). On
  // a PUBLIC deck, show the derived RANGE — her breadth of fit is the point.
  // Phase A Step 2d-4 (D6, user's decision): on the canonical path (`athlete.brandFitTags` present) the public-deck
  // lanes are the versioned `brand_fit_tags` inference or nothing — deriveFitCategories never manufactures them there.
  // The legacy reader leaves the field undefined and keeps today's rule byte for byte (parity).
  const voice = (athlete.asserted ?? []).find((a) => a.field === "brand_voice")?.raw as BrandVoice | undefined;
  const brandFitTags = brand
    ? [titleCase((brand.category ?? "").trim() || "premium consumer")]
    : athlete.brandFitTags !== undefined ? athlete.brandFitTags : deriveFitCategories(cur.sport ?? "", gender);

  const narratorCtx: NarratorContext = {
    name: cur.name, sport: cur.sport ?? "", school: cur.school ?? "",
    miaStrengths: athlete.mia?.strengths ?? [],
    storyArc: cur.storyArc ?? "", signalHighlights, brandFitTags, commercial: commercialState,
    brand: brand ? { name: brand.name, category: brand.category ?? "", audience: brand.audience ?? undefined } : undefined,
    identityFacts: identityLine, audienceFacts, gender: gender ?? undefined,
    // Her confirmed wording (athlete_asserted brand_voice), already on the context this assembler reads.
    ...(voice ? { voice } : {}),
    // The current Brief and her own facts: the copy's angle source (copyContext.ts). Null = no Brief yet, legacy fields.
    brief: copywriterEnabled() ? await loadCopyBrief(athleteId).catch(() => null) : null,
  };
  // Derive the shot list ONCE (Spec 8) and feed it to BOTH the Curator (image casting) and the
  // Narrator (copy) so pictures and words show the same facets — one coherent, art-directed story.
  // The Strategist owns the DECK PLAN (Spec 8/10) — composition (which cards + order), each card's
  // image role, the backdrop demand, and the facet art-direction — in ONE place. The assembler below
  // only binds FACTS into the cards; kit.deck = the plan's order.
  const plan = await deriveDeckPlan(athleteId, brand, signals, athlete);
  const shotList = { facets: plan.facets, shots: plan.shots };
  step("Choosing shots for their audience");

  // whyFits reasons go through the Narrator too (Spec 10) — grounded, brand-aware, not templated.
  // Run in parallel with the other agents; falls back to templates if it fails.
  // Identity gate: no "why she fits" for a brand whose research isn't confirmed to be about this company.
  const fitConfirmed = !!brand?.researchConfirmed;
  const wfInput = brand && fitConfirmed ? {
    athleteName: cur.name, sport: cur.sport ?? "",
    brand: { name: brand.name, category: brand.category ?? "premium consumer", audience: brand.audience ?? undefined },
    audienceDesc: [
      ig?.gender === "F" ? "young, women-led" : ig?.gender === "M" ? "young, men-led" : "young, highly engaged",
      audienceShare ? `(${Math.round(audienceShare)}% ${ig?.gender === "F" ? "women" : ig?.gender === "M" ? "men" : "core"})` : "",
    ].filter(Boolean).join(" "),
    facts: signalHighlights.slice(0, 4),
  } : null;
  // Brand-tailored CREATIVE cards (Phase 2) — generated only for brand kits, skipped (null) on failure.
  const ccInput = brand ? {
    athleteName: cur.name, sport: cur.sport ?? "", school: cur.school ?? undefined,
    brand: { name: brand.name, category: brand.category ?? "premium consumer", audience: brand.audience ?? undefined, positioning: brand.brandValues ?? undefined },
    facets: [cur.sport ? "Athlete" : null, cur.school ? "Scholar" : null].filter((s): s is string => !!s),
    facts: signalHighlights.slice(0, 4),
  } : null;
  const apInput = brand ? {
    athleteName: cur.name, sport: cur.sport ?? "", school: cur.school ?? undefined,
    brand: { name: brand.name, category: brand.category ?? "premium consumer" },
    facts: signalHighlights.slice(0, 4),
  } : null;
  step("Writing your pitch");
  // PITCH_CONCEPT_V1: the creative core (concept + calendar + fit reasons, or her signature idea) is ONE package from
  // the copywriter, grounded in the brand's confirmed research (pitchConcept.ts) — replacing the three Gemini calls.
  const conceptV1 = pitchConceptEnabled();
  const brandResearch = conceptV1 && brand && fitConfirmed && opts.brandId ? await loadBrandResearch(opts.brandId).catch(() => null) : null;
  const [media, copy, wfReasons, cc, ap, pkg, sig] = await Promise.all([
    curateAthleteMedia(athleteId, {
      shotList, galleryTarget: plan.galleryTarget, brand: brand ? { name: brand.name } : null,
      // The generic card shows no partner's branded content: it is the card every brand sees.
      avoidBrands: brand ? undefined : [...confirmedPartners, ...(athlete.inferredPartners ?? []), ...(narratorCtx.brief?.partners ?? [])],
    }),
    // Degrade like its three siblings below. narrateKit already RETURNS null when every model
    // fails ("templated fallback"), and the assembler handles null copy — but that safety net
    // is inside the function, so anything throwing before it reached the caller as a rejected
    // Promise.all and failed the whole kit build. A deck with templated copy beats no deck.
    //
    // The async wrapper is load-bearing, not ceremony: defaultCardBriefs() is evaluated as an
    // ARGUMENT, so it runs during array construction and a throw there would escape a plain
    // .catch() on narrateKit. Wrapping turns that synchronous throw into a rejection too.
    (async () => narrateKit(narratorCtx, [...defaultCardBriefs(narratorCtx, shotList), ...(recordBrief ? [recordBrief] : [])]))()
      .catch((e: any) => { logger.warn({ error: e?.message?.slice(0, 200) }, "narrator threw — templating copy"); return null; }),
    !conceptV1 && wfInput ? narrateWhyFits(wfInput).catch(() => null as WhyFitsReasons | null) : Promise.resolve(null as WhyFitsReasons | null),
    !conceptV1 && ccInput ? narrateCampaignConcept(ccInput).catch(() => null as CampaignConcept | null) : Promise.resolve(null as CampaignConcept | null),
    !conceptV1 && apInput ? narrateActivationPlan(apInput).catch(() => null as ActivationPlan | null) : Promise.resolve(null as ActivationPlan | null),
    conceptV1 && brandResearch ? writePitchConcept(narratorCtx, brandResearch, opts.angles ?? []) : Promise.resolve(null),
    conceptV1 && !brand ? writeSignatureIdea(narratorCtx) : Promise.resolve(null),
  ]);
  const why = pkg?.whyFits ?? wfReasons;
  const concept = pkg?.concept ?? cc;
  const calendar = pkg?.activation ?? ap;
  step("Composing the looks");
  // The kit stores GCS PATHS (not signed URLs) so it can be CACHED — signKit() signs fresh at serve
  // time (1h URLs would otherwise break an hour after caching). See kitCache.signKit.
  const heroImg = media.hero?.gcsPath ?? null;
  const tiles = media.proof.map((p) => ({ image: p.gcsPath, stat: compact(p.views) }));
  // Distinct backgrounds for the data cards (index/audience) — pulled from the Curator's
  // gallery so no photo repeats. When the queue runs dry a card renders photo-less (clean dark card).
  const bgQueue = (media.gallery ?? []).map((g) => g.gcsPath).filter(Boolean) as string[];
  const nextBg = (): string | null => bgQueue.shift() ?? null;
  // whyFits (brand card) is image-LED like fit/cover — reserve a distinct, prominent shot for it up
  // front (on a brand kit the pool is already brand-biased via the shot list). Other library cards
  // take an image backdrop from the pool below (like index) — the deck is never photo-less.
  const whyFitsImg = brand ? (bgQueue.shift() ?? media.hero?.gcsPath ?? null) : null;
  // Full pool (with shot type) so each THEME can draw different atmospheric backgrounds per its mood.
  const imagePool = (media.gallery ?? []).map((g) => ({ gcsPath: g.gcsPath, shotType: g.tags?.shot_type ?? "other", hero: g.hero }));

  // Copy accessor — the Narrator emits N options per slot; the assembled default takes the first
  // (the athlete picks alternates later). Falls back to templated copy if the Narrator failed.
  const pick = (card: string, slot: "eyebrow" | "tagline" | "extra", fallback: string): string =>
    (copy?.cards?.find((c) => c.card === card)?.[slot]?.[0]) || fallback;
  const recordLines: string[] = (copy?.cards?.find((c) => c.card === "record")?.beats?.[0] ?? "").split(BEAT_SEP).filter(Boolean);

  // ── Confidence per dimension (the layer that keeps us honest) ──
  const commercialProv: Provenance = commercialState === "active" ? "verified" : commercialState === "undisclosed" ? "inferred" : "unknown";
  const conf = (level: Provenance, score = level === "verified" ? 1 : level === "inferred" ? 0.6 : 0.3): Confidence => ({ level, score });

  // ── Cards (rules-based Strategist v1: Established + audience-strong → content/index hero) ──
  const cards: Card[] = [];
  const coverStats = [
    { value: compact(combinedFollowing), label: "Combined following" },
    topIns.video_views ? { value: compact(Number(topIns.video_views)), label: "Top post views" } : null,
    cur.achievements ? { value: String(cur.achievements), label: "Achievements" } : null,
  ].filter(Boolean) as Array<{ value: string; label: string }>;
  cards.push({ id: "cover", type: "cover", emphasis: "hero", confidence: conf("verified"), eyebrow: "Nomila · Athlete Media Kit",
    image: heroImg, nameLines: cur.name.split(" "), meta: identityLine,
    hook: pick("cover", "tagline", (() => { const lead = (cur.storyArc ?? "").split(". ")[0]; return (lead && !usesAvoided(lead, voice?.avoid) ? lead : "") || "An elite performer with a young, highly engaged audience."; })()), stats: coverStats });

  // index — her M.I.A. score, the number My Intelligence shows (owner decision 1, 8 Oct 2026): no tier word, no rings,
  // and the "Inside the score" mix card is gone with the four capitals. No assessed M.I.A. ⇒ no index card.
  const mia = athlete.mia ?? null;
  if (mia) {
    cards.push({ id: "index", type: "index", emphasis: "hero", confidence: conf("verified"), eyebrow: pick("index", "eyebrow", "M.I.A."), bg: nextBg(),
      value: mia.score, max: mia.max, scale: "mia",
      verdict: pick("index", "tagline", "How ready she is for brands, in one number.") });
  }

  // The chart and the big number come from ONE read (her latest connected Instagram demographics + follower counts):
  // the share is the largest known gender's, labelled as that gender alone (an age band beside it read as one segment).
  const breakdown = await loadAudienceBreakdown(athleteId).catch(() => null);
  const topGender = breakdown?.genders.find((g) => g.label !== "Undisclosed") ?? null;
  cards.push({ id: "audience", type: "audience", emphasis: "standard", confidence: conf("verified"), eyebrow: pick("audience", "eyebrow", "Who's watching"), bg: media.audience?.gcsPath ?? nextBg(),
    headline: topGender ? topGender.label : [ig?.gender === "F" ? "Women" : ig?.gender === "M" ? "Men" : "Audience", ig?.age].filter(Boolean).join(", "),
    share: topGender ? topGender.pct : audienceShare,
    ...(breakdown && (breakdown.ages.length || breakdown.platforms.length) ? { ages: breakdown.ages, genders: breakdown.genders, platforms: breakdown.platforms } : {}),
    sub: pick("audience", "tagline", ig?.city ? `Centered on ${ig.city}` : ""),
    geo: geoCountry.length ? geoCountry.map((g) => ({ label: g.key, pct: g.pct })) : [{ label: ig?.city ?? "Top market", pct: null }],
    stats: [{ n: compact(combinedFollowing), k: "Combined following" }, { n: String(cur.achievements ?? 0), k: "Achievements" }, { n: String(cur.press ?? 0), k: "Press features" }],
    ...(brand && brandResearch?.audience ? { brandAudience: { brand: brand.name, text: brandResearch.audience.slice(0, 220) } } : {}) });

  // No clean proof tile (every candidate frame carried text, or none was her own) still leaves her top post's views on
  // record — the big number never reads "0" because a tile was filtered out.
  // ONE source of truth for the number (22 Oct 2026): her measured top post (the athlete context) on every edition and
  // the cover alike — never whichever tile this edition's photo filter happened to keep.
  const topViews = Number(topIns?.video_views) || media.proof[0]?.views || 0;
  const measured = await loadConnectedChannels(athleteId).catch(() => []);
  cards.push({ id: "content", type: "content", emphasis: "hero", confidence: conf("verified"), eyebrow: pick("content", "eyebrow", "How her posts perform"),
    heroStat: { value: compact(topViews), label: "views on her top post" }, tiles,
    ...(proofStats(measured).length ? { stats: proofStats(measured) } : {}),
    note: pick("content", "tagline", `${media.proof.length ? "Her top posts" : "Content"} across Instagram & TikTok — the audience a partner steps into.`) });

  // VIDEO ("see in action") — only when a playable clip exists (most of the library is stills).
  if (media.video) {
    cards.push({ id: "video", type: "video", emphasis: "hero", confidence: conf("verified"), eyebrow: pick("video", "eyebrow", "In Motion"),
      posterUrl: media.video.posterPath, videoUrl: media.video.videoPath, note: pick("video", "tagline", "Not a still frame. The real thing.") });
  }

  // Legacy retirement, phase 1 (owner decision 8 Oct 2026): no "rates" card and no "payments" card. Both were
  // priced off the retired v3 rate card (labelled "verified"); they return when a new rate model exists.
  // kitCache.withoutRetiredCards drops them from kits cached before this change.

  cards.push({ id: "fit", type: "fit", emphasis: "hero", confidence: conf("verified"), eyebrow: pick("fit", "eyebrow", "Why brands partner"),
    image: media.fit?.gcsPath ?? null,
    lead: pick("fit", "tagline", "A trusted voice for the young women who define what's next."),
    body: brandFitTags.length
      ? `A credible voice for the ${brandFitTags.slice(0, 3).map((t) => t.toLowerCase()).join(", ")} categories — with engagement well above benchmark.`
      : "A credible voice — with engagement well above benchmark.",   // no brand-fit inference yet: the lanes are omitted, not invented
    tags: brandFitTags });

  // ── Card library (Spec 8/9). Built from existing pipes only — no new research surface. Each
  //    card that has real data is assembled; `deck` (below) decides which show by default; the
  //    rest sit in the library for the editor to add. Copy uses the pick() Narrator seam. ──

  // achievements ("The Record") — one hero honor at size + a ledger, PRESTIGE-ranked (marquee first,
  // so the signature credential wins over a level tie). Reuses `ranked`/`marquee` computed above.
  if (achievementsRaw.length && marquee) {
    cards.push({ id: "achievements", type: "achievements", emphasis: "hero", confidence: conf("verified"), eyebrow: pick("achievements", "eyebrow", "The Record"), bg: nextBg(),
      heroEntry: { year: String(marquee.year ?? ""), name: marquee.name,
        badge: marqueeScore(marquee.name) >= 6 ? "History-maker" : rankOf(marquee.level) >= 3 ? "Elite" : marquee.level ? titleCase(marquee.level) : "Honor",
        detail: marquee.level ? `${titleCase(marquee.level)} level` : "" },
      entries: ranked.slice(1, 5).map((a, i) => ({ year: String(a.year ?? ""), name: a.name, level: a.level ? titleCase(a.level) : "", ...(recordLines[i + 1] ? { story: recordLines[i + 1] } : {}) })),
      ...(recordLines[0] ? { heroStory: recordLines[0] } : {}),
      footnote: `Every line nomila-verified${cur.press ? ` · ${cur.press} press features` : ""}` });
  }

  // story ("The Story") — the arc in dated beats (chronological) + one close line. Opt-in.
  const dated = achievementsRaw.filter((a) => a.year).sort((x, y) => Number(x.year) - Number(y.year));
  if (dated.length >= 3) {
    const beatsSrc = dated.slice(-5);
    const beats = beatsSrc.map((a, i) => ({ year: String(a.year), where: a.level ? titleCase(a.level) : titleCase(cur.sport ?? ""), line: a.name, current: i === beatsSrc.length - 1 }));
    cards.push({ id: "story", type: "story", emphasis: "standard", confidence: conf("verified"), eyebrow: pick("story", "eyebrow", "The Story"), bg: nextBg(),
      beats, close: pick("story", "tagline", "Some athletes have highlights. She has chapters.") });
  }

  // values ("What she stands for") — athlete-authored; only when research surfaced causes. Opt-in.
  // `causes` comes from the athlete context (the same `values ?? causes` read it always made; D5: empty on the deck view).
  if (causes.length) {
    cards.push({ id: "values", type: "values", emphasis: "standard", confidence: conf("self_reported"), eyebrow: pick("values", "eyebrow", "What She Stands For"), bg: nextBg(),
      statement: pick("values", "tagline", causes[0].line || "Worth isn't negotiable."),
      planks: causes.slice(0, 3).map((c) => ({ name: c.name, line: c.line ?? "", provenance: "self_reported" as Provenance })),
      note: "Partners join these commitments — they don't rent them." });
  }

  // whyFits ("Why she fits you") — brand-tailored kits only (Spec 9). Auto-enters the deck after cover.
  // Only when the brand's research is CONFIRMED (researchConfirmed): fit copy about the wrong company is worse
  // than no card. kitCache strips the card from kits cached before that rule as well.
  if (brand && fitConfirmed) {
    const cat = brand.category?.trim() ? brand.category.trim().toLowerCase() : "premium consumer";
    const audNoun = ig?.gender === "F" ? "young, women-led" : ig?.gender === "M" ? "young, men-led" : "young, highly engaged";
    const audShareBit = audienceShare ? ` (${Math.round(audienceShare)}% ${ig?.gender === "F" ? "women" : ig?.gender === "M" ? "men" : "core"})` : "";
    cards.push({ id: "whyFits", type: "whyFits", emphasis: "hero", confidence: conf("inferred"), eyebrow: pick("whyFits", "eyebrow", `Why she fits ${brand.name}`), bg: whyFitsImg,
      brand: { id: opts.brandId ?? 0, name: brand.name, category: brand.category ?? "", logo: brand.logo ?? null },
      lead: pick("whyFits", "tagline", `The audience ${brand.name} is trying to reach already follows.`),
      reasons: [
        { head: "The audience overlap", insight: why?.audience ?? `A ${audNoun} following${audShareBit} — exactly who ${cat} brands compete for.`, basis: "audience" },
        { head: "Credibility that can't be cast", insight: why?.credibility ?? `${cur.sport ? titleCase(cur.sport) + " credentials carry" : "A real résumé carries"} an endorsement weight a lookalike creator can't buy.`, basis: "credibility" },
        { head: "Category whitespace", insight: why?.whitespace ?? `Not already saturated with ${cat} deals — ${brand.name} gets a clean association, not a shared one.`, basis: "whitespace" },
      ] });
  }

  // campaignConcept ("Laws of Layering"-style poster) — brand kits only, and only if the generator
  // produced one (a templated creative concept is worse than none, so we skip on null).
  if (brand && concept) {
    cards.push({ id: "campaignConcept", type: "campaignConcept", emphasis: "hero", confidence: conf("inferred"),
      eyebrow: pick("campaignConcept", "eyebrow", "Campaign concept"), bg: null,
      brand: { id: opts.brandId ?? 0, name: brand.name, category: brand.category ?? "", logo: brand.logo ?? null },
      title: concept.title, line: concept.line, lineEmphasis: concept.lineEmphasis, facets: concept.facets, note: concept.note,
      image: heroImg ?? whyFitsImg ?? null, ...(brandResearch?.image ? { brandImage: brandResearch.image } : {}) });
  }
  // activationPlan (the year-round calendar) — brand kits only, only if generated.
  if (brand && calendar) {
    cards.push({ id: "activationPlan", type: "activationPlan", emphasis: "standard", confidence: conf("inferred"),
      eyebrow: pick("activationPlan", "eyebrow", "How this works all year"), bg: nextBg(),
      lead: calendar.lead, buckets: calendar.buckets, close: calendar.close, ...(brandResearch?.image ? { brandImage: brandResearch.image } : {}) });
  }
  // signatureIdea — the generic card's own creative platform (PITCH_CONCEPT_V1), only if written.
  if (!brand && sig) {
    cards.push({ id: "signatureIdea", type: "signatureIdea", emphasis: "hero", confidence: conf("inferred"),
      eyebrow: "The idea", bg: null, title: sig.idea.title, line: sig.idea.line, lineEmphasis: sig.idea.lineEmphasis,
      facets: sig.idea.facets, note: sig.idea.note, image: nextBg() ?? heroImg ?? null });   // a pool shot: the fit shot can be a partner's poster, wrong on the generic card
  }

  // ── Deck composition comes from the Strategist's plan (Spec 8/10). The assembler no longer decides
  //    the deck; it just PRUNES any planned card whose data turned out absent (e.g. `video` with no
  //    playable clip). Cards built but not in the deck stay in the library (editor adds them). ──
  const deck = plan.order.filter((id) => cards.some((c) => c.id === id));

  // Narrator alternates per card (the ~5 gated options per slot) — surfaced so the editor's
  // copy-picker can offer them; the assembled default already took [0] via pick().
  const copyAlternates: Record<string, { eyebrow?: string[]; tagline?: string[]; extra?: string[] }> = {};
  for (const cc of copy?.cards ?? []) {
    const e: { eyebrow?: string[]; tagline?: string[]; extra?: string[] } = {};
    if (cc.eyebrow?.length) e.eyebrow = cc.eyebrow;
    if (cc.tagline?.length) e.tagline = cc.tagline;
    if (cc.extra?.length)   e.extra = cc.extra;
    if (Object.keys(e).length) copyAlternates[cc.card] = e;
  }

  const kit: MediaKitData = {
    athleteId,
    identity: { name: cur.name, sport: cur.sport ?? "", school: cur.school ?? "", hook: "" },
    // A confirmed brand's own colour (measured from its logo) is the tailored deck's accent when it reads on a dark card.
    tokens: { theme: "nomila", accent: usableAccent(brandResearch?.color) ?? "#E0243E" },
    cards,
    deck,
    copyAlternates,
    imagePool,
    meta: { generatedAt: new Date().toISOString(), overallConfidence: 0.85 },
  };
  logger.info({ athleteId, cards: cards.length, deck: deck.length, commercialProv, brandMentions: brandMentions.map((b) => b.brand) }, "media kit assembled");
  return kit;
}

// Phase A Step 2d-4 (design D6, locked): the second Narrator-context builder (own athletes_current ⨝ athletes read,
// own blob read, hard-coded brandFitTags) is deleted. NarratorContext is built above from the ONE athlete context.
