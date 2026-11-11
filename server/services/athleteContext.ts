/**
 * athleteContext — the athlete half of a deck/generation brief, read ONCE from the real tables.
 *
 * Mirrors `getBrandContext(brandId)` (shotList.ts): a pure READ that returns a typed context object
 * and makes no model call. It exists because the same athlete facts were being derived in three
 * places, differently — inline in `assembleMediaKit`, again in `deriveShotList`, and a third time in
 * `buildNarratorContext` — so a fix in one never reached the others. Generation is the fourth
 * consumer, and adding a fourth copy is what this replaces.
 *
 * SCOPE: athlete-only. Anything that depends on the BRAND a deck is tailored for (brand-fit tags,
 * whyFits inputs, the narrator's brand block) stays with the caller — this module never reads
 * inbox_brands. Nothing here is deck-specific either; the card/copy decisions stay in the assembler.
 *
 * The extraction is behaviour-preserving by construction: the code below was MOVED from
 * mediaKitService, not rewritten. See mediaKitService.golden.test.ts for the proof.
 */
import { latestAssertions, type AssertedFact } from "../mila/onboarding";
import { db } from "../db";
import { listAffiliations, type Affiliation } from "./affiliations";
import { athletes, athletesCurrent, athleteSnapshots, socialAnalyticsSnapshots, mediaAssets } from "../../shared/schema";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { readFollowers, combinedFollowing as combinedFollowingOf } from "./followers";
import { confirmedPartnersFor } from "./snapshotDeals";
import { createLogger } from "../logger";

const logger = createLogger("athlete-context");

// ─── Shared pure helpers (moved here so every consumer formats facts identically) ───────────────

/** 12345 → "12.3K", 1_200_000 → "1.2M". <100K keeps 1 dp (38.4K). */
export function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}
// A word starts after a space or punctuation, never after an apostrophe ("women's" → "Women's", not "Women'S").
export const titleCase = (s: string) => s.replace(/(^|[^\w'’])(\w)/g, (_m, pre: string, c: string) => pre + c.toUpperCase());
export const schoolShort = (s: string) => s.replace(/\s+(University|College)$/i, "");

// ISO-3166 alpha-2 → display name for audience geo (the demographics feed returns codes).
const COUNTRY: Record<string, string> = { US: "US", GB: "UK", IN: "India", CA: "Canada", AU: "Australia", MX: "Mexico", BR: "Brazil", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "Netherlands", JP: "Japan", KR: "South Korea", PH: "Philippines", NG: "Nigeria", AE: "UAE", SA: "Saudi Arabia", ZA: "South Africa", IE: "Ireland", NZ: "New Zealand", SE: "Sweden", PT: "Portugal" };
export const countryName = (code: string) => COUNTRY[code?.toUpperCase()] ?? code;

const LEVEL_RANK: Record<string, number> = { international: 4, olympic: 4, national: 3, professional: 3, conference: 2, regional: 2, collegiate: 1, state: 1 };
export const rankOf = (lvl?: string) => LEVEL_RANK[(lvl ?? "").toLowerCase()] ?? 0;

/** Prestige-rank honors so an athlete's SIGNATURE credential (World Cup / national team / captain /
 *  Olympic / Player of the Year) anchors the cover + achievements hero, instead of losing a level tie
 *  to a routine award. Sport-agnostic (works for any athlete). */
export function marqueeScore(name: string): number {
  const s = (name || "").toLowerCase();
  let v = 0;
  if (/world cup|olympic/.test(s)) v += 6;
  if (/national team|team usa|youth national|national player of the year|senior national|\bu-?1[5-9]\b/.test(s)) v += 4;
  if (/\bcaptain\b/.test(s)) v += 3;
  if (/\bfirst\b.*(to|american|player|woman|man|athlete)/.test(s)) v += 3;   // "first Indian-American to…"
  if (/player of the year|hermann|heisman|first team all-?america|all-?america|gold medal|\bmvp\b/.test(s)) v += 3;
  if (/champion|title/.test(s)) v += 1;
  return v;
}

/** A SHORT identity tag distilled from the marquee credential (goes on the cover fact line). */
export function credentialTag(name: string): string | null {
  const s = (name || "").toLowerCase();
  if (/world cup/.test(s) && /captain/.test(s)) return "World Cup Captain";
  if (/world cup/.test(s))                       return "World Cup";
  if (/olympic/.test(s))                          return "Olympian";
  if (/national team|team usa|senior national/.test(s)) return "National Team";
  if (/national player of the year/.test(s))     return "National POY";
  if (/heisman/.test(s))                          return "Heisman";
  if (/all-?america/.test(s))                     return "All-American";
  if (/\bcaptain\b/.test(s))                      return "Captain";
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────────────────────────

export interface Achievement { name: string; year?: string | number; level?: string }
export interface BrandMention { brand: string; type?: string; confidence?: number }
export interface Cause { name: string; line?: string }

/** Commercial truth state. "undisclosed" = a partner is INFERRED from research but not
 *  athlete-confirmed, so we neither claim a bare 0 nor name a partner she didn't confirm. */
export type CommercialState = "none" | "undisclosed" | "active";

/** Data signals the deck composer needs to decide which cards exist. Mirrors shotList.DeckSignals. */
export interface AthleteDeckSignals {
  achievementsCount: number; nationalPlus: number;
  datedAchievements: number; hasCauses: boolean;
}

/**
 * Her M.I.A. read for the deck and generation inputs (legacy retirement P2-2, owner decisions 1 + 6, 8 Oct 2026): the
 * same number My Intelligence shows, and the M.I.A. dimensions marked as strengths / room to grow (strongest first,
 * plain words). Replaces the legacy tier word and the four capitals as inputs. Null when there is no assessed read
 * (or the page withholds it): the deck then has no index card and the prompts carry no score line.
 */
export interface AthleteMia {
  score: number;
  max: 850;
  strengths: string[];
  roomToGrow: string[];
}

export interface AthleteContext {
  athleteId: string;

  // ── identity ──
  name: string; firstName: string; nameLines: string[];
  sport: string; school: string; org: string;
  division: string | null; conference: string | null; segment: string | null;
  /** Teams as dated facts (0041): current first, primary first. `school/division/conference` above
   *  are the projection of affiliations[0] when it is current. Read THIS for anything new. */
  affiliations: Affiliation[];
  /** Declared by the athlete: active · between_teams · out_this_season · retired. */
  careerStatus: string;
  /** The cover fact row: sport · org · marquee credential. Never restated in crafted copy. */
  identityLine: string;

  // ── research counts (derived from the research itself; legacy retirement P2-3) ──
  achievementsCount: number | null; pressCount: number | null;

  // ── following (the social substrate: services/followers.ts) ──
  // The legacy score (displayScore / tier / capitals) and the v3 rate card (rateCard / pav / per-post rates) are gone
  // from the context (legacy retirement P2-3, owner decisions 8 Oct 2026); her score is `mia` below.
  combinedFollowing: number;

  // ── research ──
  /** The legacy blob passthrough. No reader consumes it since 2d-4 (the shot list reads achievementsRaw /
   *  brandMentions; the values card reads `causes`); the deck view rebuilds it from the contract. Removed in Step 4. */
  research: any;
  storyArc: string;
  brandMentions: BrandMention[];
  achievementsRaw: Achievement[];
  /** achievementsRaw prestige-ranked; [0] is the marquee credential. */
  ranked: Achievement[];
  marquee: Achievement | undefined;
  marqueeTag: string | null;
  causes: Cause[];

  // ── audience ──
  gender: string | undefined;
  audienceAge: string | null; audienceCity: string | null;
  audienceShare: number | null;
  geoCountry: Array<{ key: string; pct: number }>;
  /** Real audience descriptor for the Narrator (replaces the old hardcoded "women 18-24"). */
  audienceFacts: string;

  // ── owned media ──
  topPostInsights: any;

  // ── commercial ──
  confirmedPartners: string[];
  inferredPartners: string[];
  commercialState: CommercialState;

  // ── narrative inputs ──
  signalHighlights: string[];

  // ── what the athlete told us (athlete_asserted; onboarding first) ──
  asserted: AssertedFact[];

  // ── deck composition inputs ──
  signals: AthleteDeckSignals;

  // ── M.I.A. (the ledger read; set by getAthleteContext on both paths) ──
  mia?: AthleteMia | null;

  // ── provenance (Phase A Step 2d): present on the deck view; the legacy reader reports "legacy" ──
  sourceMode?: "canonical" | "legacy" | "mixed";
  coverage?: Record<string, string>;
  /** Brand-fit lanes on the deck view: the canonical `brand_fit_tags` inference or [] (D6 — never manufactured there).
   *  Undefined on the legacy reader, whose assembler path still derives them by rule (parity). */
  brandFitTags?: string[];
}

// ─── The read ───────────────────────────────────────────────────────────────────────────────────

/**
 * Assemble one athlete's brief from the real tables. Throws if the athlete has no
 * `athletes_current` row (i.e. has never been scored) — same contract the assembler had.
 */
/**
 * The deck's athlete half: the pre-2d reader (blob + projection). It needs no athletes_current row any more (legacy
 * retirement P2-3): an athlete whose research has not run gets a thin context. It throws only for an unknown athlete id.
 */
export async function getAthleteContext(athleteId: string): Promise<AthleteContext> {
  const ctx = await getAthleteContextLegacy(athleteId);
  const mia = await readAthleteMia(athleteId);
  // Absent (not null) when she has no M.I.A. read, so a context without one is the pre-P2-2 object exactly.
  return mia ? { ...ctx, mia } : ctx;
}

/** "athletic_authority" → "athletic authority". */
const dimensionWords = (key: string): string => key.replace(/_/g, " ");

/** Her M.I.A. read (see AthleteMia), or null. Never throws: a failed read is "no score", never a broken deck. */
export async function readAthleteMia(athleteId: string): Promise<AthleteMia | null> {
  try {
    const { buildMyIntelligence } = await import("./intelligence/views/myIntelligence");
    const a = (await buildMyIntelligence(athleteId)).assessment;
    if (!a || typeof a.score !== "number") return null;
    const inState = (state: string) => a.dimensions
      .filter((d) => d.state === state && typeof d.score === "number")
      .sort((x, y) => (y.score as number) - (x.score as number))
      .map((d) => dimensionWords(d.key));
    return { score: a.score, max: 850, strengths: inState("strength"), roomToGrow: inState("gap") };
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "M.I.A. read failed — no score on the deck");
    return null;
  }
}

/** The pre-2d reader (blob + projection). */
export async function getAthleteContextLegacy(athleteId: string): Promise<AthleteContext> {
  // 1. Athlete identity + the non-score athletes_current fields. LEFT join (legacy retirement P2-3): an athlete with no
  //    athletes_current row yet (signed up, research not run) still gets a context — thin, never a throw.
  const [cur] = await db.select({
    name: athletes.full_name, sport: athletes.sport, school: athletes.school,
    division: athletes.division, conference: athletes.conference, segment: athletes.segment,
    careerStatus: athletes.career_status,
    storyArc: athletesCurrent.story_arc,
  }).from(athletes).leftJoin(athletesCurrent, eq(athletesCurrent.athlete_id, athletes.id))
    .where(eq(athletes.id, athleteId)).limit(1);
  if (!cur) throw new Error(`No athlete ${athleteId}`);
  const affiliations = await listAffiliations(athleteId).catch(() => [] as Affiliation[]);

  // 2. Research (brand_mentions → the Commercial-truth fix; achievements)
  const [snap] = await db.select({ research: athleteSnapshots.research })
    .from(athleteSnapshots)
    .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.research} IS NOT NULL`))
    .orderBy(desc(athleteSnapshots.created_at)).limit(1);
  const research      = (snap?.research ?? {}) as any;
  const brandMentions = (research.brand_mentions ?? []) as BrandMention[];

  // 3. Audience demographics (latest connected snapshot per platform)
  const demos = await db.select({
    platform: socialAnalyticsSnapshots.platform,
    gender: socialAnalyticsSnapshots.top_audience_gender, age: socialAnalyticsSnapshots.top_audience_age_range,
    city: socialAnalyticsSnapshots.top_audience_city,
  }).from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "connected")))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(6);
  const ig = demos.find((d) => d.platform === "instagram") ?? demos[0];

  // richer geo (country %) from raw metrics
  const [igRaw] = await db.select({ raw: socialAnalyticsSnapshots.raw_metrics }).from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, "instagram"), eq(socialAnalyticsSnapshots.source, "connected")))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(1);
  const geoCountry = (((igRaw?.raw as any)?.demographics?.country ?? []) as Array<{ key: string; pct: number }>)
    .slice(0, 4).map((c) => ({ ...c, key: countryName(c.key) }));
  // Share of the top audience segment — the giant "%" on the audience card (e.g. 38% women).
  const genderDemo = (((igRaw?.raw as any)?.demographics?.gender ?? []) as Array<{ key: string; pct: number }>);
  const audienceShare = genderDemo.find((g) => g.key === ig?.gender)?.pct ?? genderDemo[0]?.pct ?? null;

  // ── Following (also feeds the Narrator facts): the social substrate, not the retired rate card's copy ──
  const combinedFollowing = combinedFollowingOf(await readFollowers(athleteId));

  // Top post stats (proof card + Narrator facts)
  const [topPost] = await db.select({ insights: mediaAssets.insights }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), eq(mediaAssets.platform, "instagram")))
    .orderBy(sql`coalesce((${mediaAssets.insights}->>'video_views')::bigint, 0) DESC`).limit(1);
  const topIns = (topPost?.insights ?? {}) as any;

  // ── Commercial state: confirmed deals vs INFERRED partners (research). A researched partner shows
  //    up in brand_mentions but the athlete hasn't confirmed it — so it's "undisclosed", NOT "active":
  //    we neither claim a bare 0 (undersells) nor name a partner she didn't confirm (over-claims,
  //    and it goes to competing brands). Confirmed-deal flow is TODO → today confirmed = none. ──
  // Real, at last. This TODO waited on "athlete-confirmed deals"; that flow has landed — she
  // can hand us a contract and confirm it — so it is a query rather than a placeholder. The
  // empty array was not inert: it pinned commercialState to "undisclosed", which instructs the
  // Narrator to say brands are "already taking notice, without naming anyone" — a hedge it
  // could never stop making, because it waited on a flag nothing could flip.
  //
  // NAMES ONLY. The deck is sent TO BRANDS, sometimes to a competitor of the one being named.
  // Naming a partner is a credential; naming what that partner pays discloses her terms to the
  // party she will negotiate with next. See confirmedPartnersFor.
  const confirmedPartners: string[] = await confirmedPartnersFor(athleteId);
  const inferredPartners = brandMentions.map((b) => b.brand);
  const commercialState: CommercialState =
    confirmedPartners.length ? "active" : inferredPartners.length ? "undisclosed" : "none";

  const gender = ig?.gender ?? undefined;

  // All honors, prestige-ranked so the SIGNATURE credential anchors the cover + achievements hero.
  const achievementsRaw = ((research.achievements ?? []) as Achievement[]).filter((a) => a?.name);
  const ranked = [...achievementsRaw].sort((a, b) => (marqueeScore(b.name) - marqueeScore(a.name)) || (rankOf(b.level) - rankOf(a.level)));
  const marquee = ranked[0];
  const marqueeTag = marquee && marqueeScore(marquee.name) >= 3 ? credentialTag(marquee.name) : null;

  // Identity line (cover fact row) — data-driven: sport · org · marquee. `school` holds the club/team
  // for pros (segment='pro'); college → school; a national-team credential surfaces via the marquee tag.
  // The org a brand reads first: the primary current team when there is one (a pro club or a national
  // programme outranks the school column it projects onto); else the projected column as before.
  const primaryTeam = affiliations.find((a) => a.current && a.primary) ?? affiliations.find((a) => a.current) ?? null;
  const org = primaryTeam ? (primaryTeam.kind === "school" ? schoolShort(primaryTeam.org) : primaryTeam.org) : schoolShort(cur.school ?? "");
  const identityLine = [cur.sport ? titleCase(cur.sport) : "", org, marqueeTag].filter(Boolean).join(" · ");

  const achievements = achievementsRaw.slice(0, 5).map((a) => a.name);
  const signalHighlights = [
    combinedFollowing ? `${compact(combinedFollowing)} combined following` : null,
    topIns.video_views ? `top post reached ${compact(Number(topIns.video_views))} views` : null,
    topIns.reach ? `${compact(Number(topIns.reach))} reach on that post` : null,
    ig?.age ? `audience skews ${gender === "F" ? "women" : gender === "M" ? "men" : "audience"} ${ig.age}` : null,
    geoCountry[0]?.key ? `top geography ${geoCountry[0].key}` : null,
    ...achievements.slice(0, 2),
  ].filter(Boolean) as string[];
  // Real audience descriptor for the Narrator (replaces the hardcoded "women 18-24" placeholder).
  const audienceFacts = [gender === "F" ? "women" : gender === "M" ? "men" : "core", ig?.age].filter(Boolean).join(" ")
    + (geoCountry[0]?.key ? ` · top market ${geoCountry[0].key}` : "");

  const causes = ((research.values ?? research.causes ?? []) as Cause[]).filter((c) => c?.name);

  const signals: AthleteDeckSignals = {
    achievementsCount: achievementsRaw.length,
    nationalPlus: achievementsRaw.filter((a) => rankOf(a.level) >= 3).length,
    datedAchievements: achievementsRaw.filter((a) => a.year).length,
    hasCauses: causes.length > 0,
  };

  // What the athlete told Mila in their own words (position, class year, hometown, …). Wins over
  // research for the same fact wherever a reader chooses to use it; today the Narrator may cite it.
  const asserted = await latestAssertions(athleteId);

  const name = cur.name;
  const ctx: AthleteContext = {
    athleteId,
    affiliations, careerStatus: cur.careerStatus ?? "active",
    asserted,
    name, firstName: name.split(" ")[0] || name, nameLines: name.split(" "),
    sport: cur.sport ?? "", school: cur.school ?? "", org,
    division: cur.division ?? null, conference: cur.conference ?? null, segment: cur.segment ?? null,
    identityLine,
    achievementsCount: achievementsRaw.length, pressCount: ((research.press_mentions ?? []) as unknown[]).length,
    combinedFollowing,
    research, storyArc: cur.storyArc ?? "", brandMentions,
    achievementsRaw, ranked, marquee, marqueeTag, causes,
    gender, audienceAge: ig?.age ?? null, audienceCity: ig?.city ?? null,
    audienceShare, geoCountry, audienceFacts,
    topPostInsights: topIns,
    confirmedPartners, inferredPartners, commercialState,
    signalHighlights, signals,
    sourceMode: "legacy",
  };
  logger.debug({ athleteId, achievements: achievementsRaw.length, commercialState, marqueeTag }, "athlete context read");
  return ctx;
}

