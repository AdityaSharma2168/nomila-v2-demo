// Concept 0.4 · My Story S1 — the composition of GET /me/story into the screen's sections (pure, no fetch, no JSX).
//
// THE RULE: My Story may select, order, label, and compose what the server serves; it never paraphrases, embellishes,
// derives a claim or infers meaning from the text. Every string a function here returns is either served text, exactly,
// or one of the fixed UI labels below. II decides meaning once; this module decides what to show; the screen decides
// how it feels.
//
//   hero        the first non-null of throughline.short → essence.short → positioning.current.short, plus ONE short
//               supporting line (essence.short) when the statement is the throughline — never a paragraph
//   pillars     "What defines you": each pillar with its proof keys resolved against proofPoints / signatureMoments
//   chapters    "Your story so far": the non-null chapters in origin → rise → defining → now, each with a fixed label,
//               and one of her verbatim statements beneath it only when one relates (cited by the chapter, else the
//               chapter's fixed topic) — never an intent, never the same statement twice, and only a QUOTABLE one:
//               a published statement (provenance source_read: an interview, article or video the research read) or a
//               written form answer she gave Nomila, labelled as such. What she said to Mila in chat or by voice, her
//               captions and her bios are never featured as quotes on the face (the projection still carries them).
//   standsFor   "What you stand for", with her related statement beneath it on the same rule
//   headed      "Where you're headed": positioning.desired verbatim as the lead, then the other direction items
//               deduplicated against it by objective id (and by identical wording), each with a fixed domain label
//   sees        "What Nomila sees": imageGap, exactly
//   why         "Why Nomila sees this": the strength and the basis in fixed words (counts by kind), plus the quotable
//               statements the object cites — the only place established / reported is spoken, and only in a sheet
//   imagery     her eligible photos — hers (subject the_athlete), never a group shot; the hero needs a clear face and
//               prefers a portrait frame; ONE picker per screen hands photos out by slot in a fixed order, a photo at
//               most once per screen; neighbouring screens prefer different heroes (by rank, only when another photo
//               meets the hero bar); light, text-led tiles when the pool runs out. Fields the library does not serve
//               (flag off) fall back to today's behaviour.

import type { MeStory, MeStoryBasisRef, MeStoryChapter, MeStoryForm, MeStoryPillar, MeStoryProof, MeStoryStatement, MeStorySynth } from "./meStoryLogic";

// ── fixed labels ──────────────────────────────────────────────────────────────

// Eyebrows are sentence case in copy; the eyebrow role sets them in capitals.
export const SECTION = {
  hero:      { eyebrow: "My story" },
  pillars:   { title: "What defines you", sub: "The territories your story is told in." },
  chapters:  { title: "Your story so far", sub: "How it has unfolded, as Nomila holds it." },
  standsFor: { title: "What you stand for" },
  headed:    { title: "Where you're headed", sub: "Your goals, in your words.", lead: "From you", more: (n: number) => `More of your goals (${n})` },
  sees:      { title: "What Nomila sees", sub: "How you are seen today, next to where you are going." },
  why:       "Why Nomila sees this",
  inHerWords: "In your words",
  proof:     "Proof",
} as const;

export type ChapterKey = "origin" | "rise" | "defining" | "now";
export const CHAPTER_ORDER: readonly ChapterKey[] = ["origin", "rise", "defining", "now"];
export const CHAPTER_LABEL: Record<ChapterKey, string> = { origin: "Where it started", rise: "A bigger stage", defining: "A defining moment", now: "Now" };
/** The statement topics a slot may draw a quote from when nothing cites it. Fixed and generic; most slots rely on citation only. */
const SLOT_TOPICS: Record<string, readonly string[]> = { "chapters.origin": ["origin"], standsFor: ["values"] };

/** A fixed label for a direction item's domain: a known word, else the domain token itself with its underscores spaced. */
const DOMAIN_LABEL: Record<string, string> = {
  impact: "Impact", audience: "Audience", positioning: "Positioning", commercial: "Commercial", athletic: "Athletic", content: "Content",
  owned_venture: "Venture", education: "Education", community: "Community",
};
export function domainLabel(domain: string | null | undefined): string | null {
  if (!domain) return null;
  if (DOMAIN_LABEL[domain]) return DOMAIN_LABEL[domain];
  const words = domain.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

const nonEmpty = (s: string | null | undefined): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

// ── hero ──────────────────────────────────────────────────────────────────────

export interface HeroModel {
  /** ONE strong statement: throughline.short (else the next slot). */
  text: string;
  slot: "throughline" | "essence" | "positioningCurrent";
  form: MeStoryForm;
  /** ONE short supporting line under it: essence.short, only when the statement is the throughline and it differs. Never a paragraph. */
  support: string | null;
}

export function heroModel(s: MeStory): HeroModel | null {
  const pick: Array<[HeroModel["slot"], MeStoryForm | null]> = [["throughline", s.throughline], ["essence", s.essence], ["positioningCurrent", s.positioning.current]];
  for (const [slot, form] of pick) {
    const text = form ? nonEmpty(form.short) ?? nonEmpty(form.long) : null;
    if (form && text) {
      const essence = slot === "throughline" ? nonEmpty(s.essence?.short) : null;
      return { text, slot, form, support: essence && essence.toLowerCase() !== text.toLowerCase() ? essence : null };
    }
  }
  return null;
}

// ── her words ─────────────────────────────────────────────────────────────────

/**
 * What the screen may feature as a quote: a published statement (source_read) or a written form answer. Captions,
 * bios, chat and voice messages to Mila stay provenance only (product constraint, S1; open question for the owner).
 */
export function isQuotable(st: MeStoryStatement): boolean {
  return st.provenance === "source_read" || (st.provenance === "her_own" && st.medium === "form");
}

/**
 * The statement that relates to a slot: cited by it first (in the served rank order), else one carrying the slot's
 * fixed topic. Only a quotable one; never an intent (her goals belong to "Where you're headed"), never one already
 * placed, never one whose words are the object's own text.
 */
export function relatedStatement(statements: MeStoryStatement[], slot: string, objectText: string | null, used: Set<string>): MeStoryStatement | null {
  const ok = (st: MeStoryStatement) => isQuotable(st) && !st.intent && !used.has(st.id) && st.text.trim().toLowerCase() !== (objectText ?? "").trim().toLowerCase();
  const cited = statements.find((st) => ok(st) && st.citedBy.includes(slot));
  if (cited) return cited;
  const topics = SLOT_TOPICS[slot] ?? [];
  return topics.length ? statements.find((st) => ok(st) && st.topics.some((t) => topics.includes(t))) ?? null : null;
}

/** Where a statement is from, in fixed words around the served names: "Instagram caption", "Outlet One · video", "Told Nomila". */
export function statementSourceLine(st: MeStoryStatement): string {
  const platform = st.source.platform ? st.source.platform.charAt(0).toUpperCase() + st.source.platform.slice(1) : null;
  switch (st.medium) {
    case "caption": return platform ? `${platform} caption` : "Your caption";
    case "bio": return platform ? `${platform} bio` : "Your bio";
    case "conversation": return "Said to Nomila";
    case "form": return "Written to Nomila, in a form";
    case "objective": return "Your goal";
    case "objective_review": return "Your words on a goal";
    default: return [st.source.outlet ?? st.source.title, st.medium !== "other" ? st.medium : null].filter(Boolean).join(" · ") || "Interview";
  }
}

// ── pillars ───────────────────────────────────────────────────────────────────

export interface PillarModel { key: string; label: string; definition: string; proof: MeStoryProof[]; basis: MeStoryBasisRef[]; strength: string | null }
export const PILLAR_PROOF_MAX = 3;

export function pillarModel(s: MeStory): PillarModel[] {
  const byKey = new Map<string, MeStoryProof>();
  for (const p of [...s.proofPoints, ...s.signatureMoments]) if (!byKey.has(p.key)) byKey.set(p.key, p);
  return s.pillars.map((p: MeStoryPillar) => ({
    key: p.key, label: p.label, definition: p.definition, basis: p.basis, strength: p.strength,
    proof: p.proof.map((k) => byKey.get(k)).filter((x): x is MeStoryProof => !!x).slice(0, PILLAR_PROOF_MAX),
  }));
}

// ── chapters ──────────────────────────────────────────────────────────────────

export interface ChapterModel { key: ChapterKey; label: string; text: string; basis: MeStoryBasisRef[]; strength: string | null; quote: MeStoryStatement | null }

export function chapterModel(s: MeStory, used: Set<string> = new Set()): ChapterModel[] {
  const out: ChapterModel[] = [];
  for (const key of CHAPTER_ORDER) {
    const c: MeStoryChapter | null = s.chapters[key];
    const text = c ? nonEmpty(c.text) : null;
    if (!c || !text) continue;
    const quote = relatedStatement(s.athleteStatements, `chapters.${key}`, text, used);
    if (quote) used.add(quote.id);
    out.push({ key, label: CHAPTER_LABEL[key], text, basis: c.basis, strength: c.strength, quote });
  }
  return out;
}

// ── what you stand for ────────────────────────────────────────────────────────

export interface StandsForModel { short: string; long: string | null; basis: MeStoryBasisRef[]; strength: string | null; quote: MeStoryStatement | null }

export function standsForModel(s: MeStory, used: Set<string> = new Set()): StandsForModel | null {
  const f = s.standsFor;
  const short = f ? nonEmpty(f.short) ?? nonEmpty(f.long) : null;
  if (!f || !short) return null;
  const long = nonEmpty(f.long);
  const quote = relatedStatement(s.athleteStatements, "standsFor", short, used);
  if (quote) used.add(quote.id);
  return { short, long: long && long !== short ? long : null, basis: f.basis ?? [], strength: f.strength ?? null, quote };
}

// ── where you're headed ───────────────────────────────────────────────────────

export interface HeadedModel { lead: { text: string; objectiveId: string | null } | null; others: Array<{ text: string; label: string | null; objectiveId: string | null }> }

export function headedModel(s: MeStory): HeadedModel | null {
  const d = s.positioning.desired;
  const leadText = d ? nonEmpty(d.value) : null;
  const leadObjective = d?.basis?.find((b) => b.kind === "objective")?.id ?? null;
  const lead = leadText ? { text: leadText, objectiveId: leadObjective } : null;
  const seenIds = new Set<string>(leadObjective ? [leadObjective] : []);
  const seenText = new Set<string>(leadText ? [leadText.toLowerCase()] : []);
  const others: HeadedModel["others"] = [];
  for (const item of s.direction) {
    const text = nonEmpty(item.value);
    if (!text) continue;
    if ((item.objectiveId && seenIds.has(item.objectiveId)) || seenText.has(text.toLowerCase())) continue;
    if (item.objectiveId) seenIds.add(item.objectiveId);
    seenText.add(text.toLowerCase());
    others.push({ text, label: domainLabel(item.domain), objectiveId: item.objectiveId });
  }
  return lead || others.length ? { lead, others } : null;
}

// ── what Nomila sees ──────────────────────────────────────────────────────────

export function seesModel(s: MeStory): MeStorySynth | null {
  return s.imageGap && nonEmpty(s.imageGap.text) ? s.imageGap : null;
}

// ── why Nomila sees this ──────────────────────────────────────────────────────

export interface WhyTarget { title: string; slot: string; text: string; basis: MeStoryBasisRef[]; strength: string | null }
export interface WhyModel { strengthLine: string | null; basisLine: string | null; quotes: MeStoryStatement[] }

/** Fixed words for the strength. Spoken only in the sheet, never on the face of the screen. */
const STRENGTH_LINE: Record<string, string> = {
  established: "Nomila holds this as established: it rests on sources it could confirm.",
  reported: "Nomila holds this as reported: it rests on what sources say, not yet confirmed.",
  athlete_approved: "You approved this wording.",
};
/** Fixed nouns for a basis kind, singular and plural. `state_finding` is salience only and is never counted. */
const BASIS_NOUN: Record<string, [string, string]> = {
  fact: ["fact", "facts"], evidence: ["source", "sources"], assertion: ["thing you told Nomila", "things you told Nomila"], said: ["thing you said", "things you said"],
  objective: ["goal", "goals"], media_asset: ["post", "posts"], first_look: ["look at your accounts", "looks at your accounts"], social_feature: ["account signal", "account signals"], deal: ["deal", "deals"],
};

export function whyModel(target: WhyTarget, statements: MeStoryStatement[]): WhyModel {
  const counts = new Map<string, number>();
  for (const b of target.basis) if (BASIS_NOUN[b.kind]) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${BASIS_NOUN[kind][n === 1 ? 0 : 1]}`);
  const basisLine = parts.length ? `Built from ${parts.join(", ")}.` : null;
  return { strengthLine: target.strength ? STRENGTH_LINE[target.strength] ?? null : null, basisLine, quotes: statements.filter((st) => isQuotable(st) && st.citedBy.includes(target.slot)) };
}

// ── imagery ───────────────────────────────────────────────────────────────────

/**
 * The fields of the media library's item that decide eligibility (hooks/use-media-library MediaItem). `subject`,
 * `shot_type` and `face` ride the item only with the server's library fields on; `width` / `height` are not served by
 * the list today (the detail read has them), so the portrait preference applies only when a row carries them.
 */
export interface StoryPhoto {
  asset_id: string; url: string | null; thumb_url: string | null; origin: string;
  subject?: string | null; shot_type?: string | null; face?: string | null; reject?: boolean; madeHereNotHer?: boolean;
  width?: number | null; height?: number | null;
  /** The platform a connected post came from (the library row carries it); read by the goal channel strip. */
  platform?: string | null;
}
export interface StoryImagery { hero: string | null; pillars: Array<string | null> }

/**
 * Her own photo or an upload she attested rights to; never generated, never found on the web; never a reject; and HER:
 * when the library says who is in it, only `the_athlete` passes (another person, nobody and unknown do not). A row the
 * library has not read (subject absent / null) still passes, so a server with the fields off shows what it shows today.
 */
export function eligibleStoryPhotos(photos: StoryPhoto[]): StoryPhoto[] {
  const seen = new Set<string>();
  return photos.filter((p) => {
    if (!(p.url || p.thumb_url) || p.reject || p.madeHereNotHer) return false;
    if (p.origin !== "connected" && p.origin !== "upload") return false;
    if (p.subject != null && p.subject !== "the_athlete") return false;
    // A poster or a captioned frame is not a photo of her, however hers the account: never on a hero, a tile or an avatar.
    if (p.shot_type === "text_graphic") return false;
    if (seen.has(p.asset_id)) return false;
    seen.add(p.asset_id);
    return true;
  });
}

/**
 * The screens that open on a photo hero, in the order they prefer DIFFERENT heroes: Home takes the best candidate,
 * My Story the next, My Intelligence the next, Knows the next. Me (opened from the avatar) is Home's screen and shares
 * its hero, so the avatar — the face of the Home hero — is the one allowed repeat.
 */
export type HeroScreen = "home" | "story" | "intelligence" | "knows";
const HERO_RANK: Record<HeroScreen, number> = { home: 0, story: 1, intelligence: 2, knows: 3 };

/** Never a group shot where the library knows the shot type — a teammate in a group photo is not her territory. */
const notGroup = (p: StoryPhoto) => p.shot_type !== "group";
/** The hero needs her face clearly visible when the library has read it. */
const heroFace = (p: StoryPhoto) => p.face == null || p.face === "clear";
/** A pillar may show her face clear or partial, never none. */
const pillarFace = (p: StoryPhoto) => p.face == null || p.face === "clear" || p.face === "partial";
const portrait = (p: StoryPhoto) => typeof p.width === "number" && typeof p.height === "number" && p.height > p.width;

/**
 * Every photo that meets the hero bar (a clear face, not a group shot), best first: portrait frames in the library's
 * order, then the rest in the library's order. The library's hero-first order breaks every tie.
 */
export function heroCandidates(pool: ReadonlyArray<StoryPhoto>): StoryPhoto[] {
  const ok = pool.filter((p) => notGroup(p) && heroFace(p));
  return [...ok.filter(portrait), ...ok.filter((p) => !portrait(p))];
}

/**
 * The hero for one screen: the candidate at the screen's rank, so neighbouring screens show different photos — but
 * ONLY when that many photos meet the hero bar. With fewer, every screen reuses the best one: suitability is never
 * traded for variety.
 */
export function heroFor(pool: ReadonlyArray<StoryPhoto>, screen: HeroScreen): StoryPhoto | null {
  const c = heroCandidates(pool);
  return c[HERO_RANK[screen]] ?? c[0] ?? null;
}

export interface MeImagery {
  /** The screen's hero (the hero bar, by the screen's rank); Home's is also the avatar's photo. */
  hero: StoryPhoto | null;
  /** The rest of the eligible pool, distinct, never the hero: the strip and the row tiles, in a fixed order. */
  others: StoryPhoto[];
  /** hero first, then the others — what `useMePhotos` serves, so index 0 is the hero everywhere. */
  ordered: StoryPhoto[];
}

/**
 * Her imagery for one screen, from ONE pool and ONE hero rule: the hero, then every other eligible photo once, in the
 * library's order. A screen draws its slots from `others` front to back (the strip, then the doors), so no photo
 * appears twice on it; when `others` runs out the slot shows its icon tile.
 */
export function meImagery(photos: StoryPhoto[], screen: HeroScreen = "home"): MeImagery {
  const pool = eligibleStoryPhotos(photos);
  const hero = heroFor(pool, screen);
  const others = pool.filter((p) => p !== hero);
  return { hero, others, ordered: hero ? [hero, ...others] : others };
}

/** A hero-size image: the full photo (its thumbnail only when there is no full one). */
export const photoUri = (p: StoryPhoto | null | undefined): string | null => (p ? p.url ?? p.thumb_url ?? null : null);
/** A tile-size image (a door, a pillar, a strip cell): the thumbnail first, so a small slot never waits on a full-size file. */
export const thumbUri = (p: StoryPhoto | null | undefined): string | null => (p ? p.thumb_url ?? p.url ?? null : null);

/**
 * The avatar: the SAME photo the Home hero shows (her best eligible library photo), at thumbnail size; else
 * `athletes.photo_url`, else null — and only then the initial. The record's photo comes second because it is usually the
 * sign-in account's picture (a 96px default letter avatar for many accounts), not a photo of her. `photos` is the
 * hero-first list `useMePhotos` serves.
 */
export function avatarPhotoUrl(identityPhotoUrl: string | null | undefined, photos: ReadonlyArray<StoryPhoto>): string | null {
  const fromRecord = typeof identityPhotoUrl === "string" && identityPhotoUrl.trim() ? identityPhotoUrl : null;
  return thumbUri(photos[0]) ?? fromRecord ?? null;
}

/** A small stable hash of a recommendation id, so a screen's choice never depends on list order or a render. */
export function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Home's door rows take the first five of `others`; recommendation photos come after them on EVERY screen, so a card
 * never repeats a door and keeps one photo wherever it appears. A pool too small to skip them uses all of `others`.
 */
export const CARD_PHOTO_SKIP = 5;


function cardPool(pool: ReadonlyArray<StoryPhoto>): StoryPhoto[] {
  const others = meImagery([...pool], "home").others;
  const rest = others.slice(CARD_PHOTO_SKIP);
  return rest.length ? rest : others;
}

/**
 * ONE photo per recommendation, the same on Home's rail, the Strategy list, a priority's list and the detail deck's
 * first page. `ids` is the whole open list (every screen passes the same one), sorted, so a card's photo depends only
 * on its id and that list — never on which screen draws it or the list's order. Each id starts at a stable hash of
 * itself and steps to the next free photo, so no two open cards share one; past the pool a card gets null → the
 * category default tile. Never Home's hero. Thumbnail-size slots; the caller reads `thumbUri`.
 */
export function cardPhotos(pool: ReadonlyArray<StoryPhoto>, ids: ReadonlyArray<string>): Map<string, StoryPhoto | null> {
  const photos = cardPool(pool);
  const used = new Set<number>();
  const out = new Map<string, StoryPhoto | null>();
  for (const id of [...new Set(ids)].sort()) {
    if (used.size >= photos.length) { out.set(id, null); continue; }
    let i = stableHash(id) % photos.length;
    while (used.has(i)) i = (i + 1) % photos.length;
    used.add(i);
    out.set(id, photos[i]);
  }
  return out;
}

/**
 * The recommendation deck's images (the density pass): up to `n` DISTINCT photos of hers, page 1 being the card's own
 * photo (`cardPhotos` over the same open list) and the rest walking on from it; fewer when the pool has fewer. Empty
 * when the pool has nothing → the category default alone. A record no longer in the open list takes its hash pick.
 */
export function detailPhotos(pool: ReadonlyArray<StoryPhoto>, id: string, n = 3, ids: ReadonlyArray<string> = []): StoryPhoto[] {
  const photos = cardPool(pool);
  if (!photos.length) return [];
  const first = cardPhotos(pool, ids.includes(id) ? ids : [...ids, id]).get(id) ?? null;
  const start = first ? photos.indexOf(first) : stableHash(id) % photos.length;
  const out: StoryPhoto[] = [];
  for (let k = 0; k < Math.min(n, photos.length); k++) out.push(photos[(start + k) % photos.length]);
  return out;
}

/** The detail header's single photo: the deck's first page. */
export function detailPhoto(pool: ReadonlyArray<StoryPhoto>, id: string, ids: ReadonlyArray<string> = []): StoryPhoto | null {
  return detailPhotos(pool, id, 1, ids)[0] ?? null;
}

/**
 * My Story's imagery: the hero by the story screen's rank, then one distinct photo per pillar (clear or partial face,
 * not a group shot), in order, never the hero; a pillar with none goes text-led (a light tile with its initial).
 */
export function storyImagery(photos: StoryPhoto[], pillarCount: number, screen: HeroScreen = "story"): StoryImagery {
  const pool = eligibleStoryPhotos(photos);
  const heroPhoto = heroFor(pool, screen);
  const rest = pool.filter((p) => p !== heroPhoto && notGroup(p) && pillarFace(p)).map((p) => thumbUri(p)!);
  return { hero: heroPhoto ? heroPhoto.url ?? heroPhoto.thumb_url! : null, pillars: Array.from({ length: pillarCount }, (_, i) => rest[i] ?? null) };
}

// ── page ──────────────────────────────────────────────────────────────────────

export type StoryPage = "unavailable" | "learning" | "ready";
export function storyPage(s: MeStory | null | undefined): StoryPage {
  if (!s || s.pageState === "unavailable") return "unavailable";
  return s.pageState === "ready" ? "ready" : "learning";
}
