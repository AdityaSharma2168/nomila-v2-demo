/**
 * views/deck.ts — the deck view (design §2.3, 2d-4): today's `AthleteContext` field names, built from
 * the contract so the brief, the kit, the narrator context and the shot list see the same shape.
 * Research-derived fields come from the contract (never the blob); following/top post/audience are the deck's own
 * inputs (KEEP sources). The legacy score, tier, capitals and v3 rate card are no longer read (legacy retirement P2-3):
 * her score is the M.I.A. read getAthleteContext attaches, and an athlete with no athletes_current row gets a deck view. D7 locked: `commercialState` from confirmed deals only —
 * `inferredPartners` is kept as an always-empty field for shape compatibility until Step 4.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { mediaAssets } from "../../../../../shared/schema";
import { readFollowers, combinedFollowing as combinedFollowingOf, type Followers } from "../../../followers";
import { compact, credentialTag, marqueeScore, rankOf, schoolShort, titleCase, type Achievement, type AthleteContext, type BrandMention, type Cause } from "../../../athleteContext";
import type { BuiltContext } from "../build";

export interface DeckExtras { followers: Followers | null; topInsights: any }

/** The deck's own inputs (following, top post). Never throws for an athlete with no athletes_current row. */
export async function readDeckExtras(athleteId: string): Promise<DeckExtras> {
  const [followers, [topPost]] = await Promise.all([
    readFollowers(athleteId),
    db.select({ insights: mediaAssets.insights }).from(mediaAssets)
      .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), eq(mediaAssets.platform, "instagram")))
      .orderBy(sql`coalesce((${mediaAssets.insights}->>'video_views')::bigint, 0) DESC`).limit(1),
  ]);
  return { followers, topInsights: (topPost?.insights ?? {}) as any };
}

/** Blob keys that belong to a research domain: they are NEVER passed through raw (G5b) — the contract's sections stand in. */
const DOMAIN_KEYS = ["achievements", "brand_mentions", "press_mentions", "story_arc", "sentiment", "profile", "position", "class_year", "hometown", "social_handles", "values", "causes", "aliases", "nationality"];

/**
 * The `research` passthrough today's deck consumers still read (shotList). Rebuilt from the contract:
 * the domain keys come from the contract's sections (so a `confirmed_empty` domain is empty whatever
 * the blob holds); any other blob key passes through only in legacy sourceMode. Retired in 2d-4.
 */
function researchPassthrough(b: BuiltContext, achievements: Achievement[], brandMentions: BrandMention[]): Record<string, unknown> {
  const { ctx, legacy } = b;
  const rest: Record<string, unknown> = {};
  if (ctx.sourceMode === "legacy" && legacy.blob.raw) for (const [k, v] of Object.entries(legacy.blob.raw)) if (!DOMAIN_KEYS.includes(k)) rest[k] = v;
  return {
    ...rest,
    achievements, brand_mentions: brandMentions,
    press_mentions: ctx.press.map((p) => ({ outlet: p.value.outlet, headline: p.value.headline })),
    story_arc: ctx.inferences.storyArc?.value ?? null,
    profile: { position: ctx.profile.position?.value.text ?? null, class_year: ctx.profile.classYear?.value.label ?? null, hometown: ctx.identity.hometown ? [ctx.identity.hometown.value.city, ctx.identity.hometown.value.region, ctx.identity.hometown.value.country].filter(Boolean).join(", ") || null : null },
    social_handles: Object.fromEntries(Object.entries(ctx.social.handles).map(([p, h]) => [p, h.handle])),
  };
}

/** The deck view. Needs no athletes_current row (legacy retirement P2-3). */
export function deckView(b: BuiltContext, extras: DeckExtras): AthleteContext {
  const { ctx, legacy } = b;
  const combinedFollowing = extras.followers ? combinedFollowingOf(extras.followers) : 0;
  const topIns = extras.topInsights ?? {};

  const brandMentions: BrandMention[] = ctx.brandMentions.map((m) => ({ brand: m.value.brand, ...(m.value.type != null ? { type: m.value.type } : {}), ...(m.value.confidence != null ? { confidence: m.value.confidence } : {}) }));
  const achievementsRaw: Achievement[] = ctx.achievements.map((a) => ({ name: a.value.name, ...(a.value.year != null ? { year: a.value.year } : {}), ...(a.value.level != null ? { level: a.value.level } : {}) })).filter((a) => a.name);
  const ranked = [...achievementsRaw].sort((a, b) => (marqueeScore(b.name) - marqueeScore(a.name)) || (rankOf(b.level) - rankOf(a.level)));
  const marquee = ranked[0];
  const marqueeTag = marquee && marqueeScore(marquee.name) >= 3 ? credentialTag(marquee.name) : null;
  const primaryTeam = ctx.affiliations.current;
  const org = primaryTeam ? (primaryTeam.kind === "school" ? schoolShort(primaryTeam.org) : primaryTeam.org) : schoolShort(legacy.row.school ?? "");
  const sport = ctx.identity.sport?.value.sport ?? "";
  const identityLine = [sport ? titleCase(sport) : "", org, marqueeTag].filter(Boolean).join(" · ");
  const au = ctx.audience;
  const gender = au.gender ?? undefined;
  const achievements = achievementsRaw.slice(0, 5).map((a) => a.name);
  const signalHighlights = [
    combinedFollowing ? `${compact(combinedFollowing)} combined following` : null,
    topIns.video_views ? `top post reached ${compact(Number(topIns.video_views))} views` : null,
    topIns.reach ? `${compact(Number(topIns.reach))} reach on that post` : null,
    au.ageRange ? `audience skews ${gender === "F" ? "women" : gender === "M" ? "men" : "audience"} ${au.ageRange}` : null,
    au.geoCountry[0]?.key ? `top geography ${au.geoCountry[0].key}` : null,
    ...achievements.slice(0, 2),
  ].filter(Boolean) as string[];
  const audienceFacts = [gender === "F" ? "women" : gender === "M" ? "men" : "core", au.ageRange].filter(Boolean).join(" ") + (au.geoCountry[0]?.key ? ` · top market ${au.geoCountry[0].key}` : "");
  const causes: Cause[] = [];   // D5: `values/causes` never existed in the blob; a values fact key is a registry change, not 2d
  const name = ctx.identity.name.value.full;
  return {
    athleteId: ctx.athleteId,
    affiliations: ctx.affiliations.all as any, careerStatus: ctx.identity.careerStatus.value.status,
    asserted: ctx.assertions as any,
    name, firstName: name.split(" ")[0] || name, nameLines: name.split(" "),
    sport, school: legacy.row.school ?? "", org,
    division: ctx.affiliations.level.division ?? null, conference: ctx.affiliations.level.conference ?? null, segment: ctx.affiliations.level.segment ?? null,
    identityLine,
    achievementsCount: achievementsRaw.length, pressCount: ctx.press.length,
    combinedFollowing,
    research: researchPassthrough(b, achievementsRaw, brandMentions), storyArc: ctx.inferences.storyArc?.value ?? "", brandMentions,
    achievementsRaw, ranked, marquee, marqueeTag, causes,
    gender, audienceAge: au.ageRange, audienceCity: au.topCity, audienceShare: au.share, geoCountry: au.geoCountry, audienceFacts,
    topPostInsights: topIns,
    confirmedPartners: ctx.commercial.confirmedPartners, inferredPartners: [], commercialState: ctx.commercial.commercialState,
    signalHighlights,
    signals: { achievementsCount: achievementsRaw.length, nationalPlus: achievementsRaw.filter((a) => rankOf(a.level) >= 3).length, datedAchievements: achievementsRaw.filter((a) => a.year).length, hasCauses: false },
    sourceMode: ctx.sourceMode, coverage: ctx.coverage,
    // D6 (user's decision, 2d-4 review): on the canonical path brand-fit comes ONLY from the versioned inference; [] = omit
    brandFitTags: ctx.inferences.brandFitTags?.value.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) ?? [],
  };
}
