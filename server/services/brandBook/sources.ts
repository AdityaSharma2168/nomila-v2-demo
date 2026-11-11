/**
 * brandBook/sources — reads everything the brand book is built from, for ONE athlete, from her own records:
 *
 *   found                the read of record (buildMyIntelligence: score, eight dimensions, its strengths/constraints)
 *   opportunity          the current Brief's biggest upside (riskUpsideOf)
 *   positioning, now/next, milestones   the current Brief and her facts (copyContext.loadCopyBrief, as the Nomi Card copy)
 *   channels, countries  her connected channels' latest snapshot (loadConnectedChannels)
 *   posts                her own strongest posts that stand as proof of HER (visionTag isProofOfHer), by likes
 *   captions             her own recent captions — the voice chapter's register, data only
 *   images               the Curator over her own library (only photos of her; no model call to cast)
 *   palette              measured from those same photos (pitch greens left out)
 *   guardrails           her own avoid preferences, exclusivity conflicts on file, the Brief's biggest risk
 *   partners             her current partners, as our brand research describes them
 *   inbound              the kinds of brands behind her open opportunities
 *   goals, moments       her goals and the moments the moments step chose (readGoals) — the plan line's context only
 *
 * Every query carries her id. Nothing here names an athlete, sport, school or brand.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, inboxBrands, mediaAssets, opportunities } from "../../../shared/schema";
import { readObject } from "../../lib/mediaStore";
import { tonedBackdrop, treatBookImages, type CastLike } from "./treat";
import { notAPreview } from "../../lib/previewAsset";
import { isProofOfHer } from "../../lib/visionTag";
import { brandDisplayLogo } from "../../lib/brandIdentity";
import { normalizeBrand } from "../../lib/brandName";
import { readGoals } from "../../agent/plan/goals";
import { riskUpsideOf } from "../../agent/plan/input";
import { guardrailsFrom } from "../../agent/guardrails";
import { listPreferences } from "../../agent/memory";
import { dbStore } from "../../agent/research/dbStore";
import { loadConnectedChannels } from "../../agent/research/connected";
import { buildMyIntelligence } from "../intelligence/views/myIntelligence";
import { loadRateRanges, loadMinimumRates } from "../rates";
import { castBriefs } from "../curator";
import { fillFromAtmosphere } from "../atmosphere/documentFill";
import type { CopyBrief } from "../copyContext";
import type { BookChannel, BookGuardrail, BookPartner, BookPost } from "../../../shared/brandBook";
import { photoBriefsFor, type BookSources } from "./pages";
import { paletteFromImages } from "./palette";

const OWN = ["connected", "discovery"];
const DRAWABLE = /\.(jpe?g|png|webp)$/i;
const one = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** "2025: claim" (copyContext signals, newest first) → dated milestones, oldest first, at most five. */
export function milestonesFrom(signals: string[]): Array<{ date: string; fact: string }> {
  return signals
    .map((s) => /^(\d{4})(?:-\d{2})?:\s*(.+)$/.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ date: m[1], fact: one(m[2], 200) }))
    .reverse()
    .slice(-5);
}

/** "US 69%" buckets → { label, share }, largest first; anything without a share is dropped. Pure. */
export function countriesFrom(buckets: string[]): Array<{ label: string; share: number }> {
  return buckets
    .map((b) => /^(.+?)\s+([\d.]+)%$/.exec(b.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ label: one(m[1], 40), share: Number(m[2]) }))
    .filter((c) => c.label && Number.isFinite(c.share) && c.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, 4);
}

/** The Brief's brand now → next: its first line is now, its first line about the next step is next. Pure. */
export function nowNextFrom(lines: string[]): { now: string | null; next: string | null } {
  const clean = lines.map((l) => humaniseDurations(one(l, 320))).filter(Boolean);
  const now = clean[0] ?? null;
  const next = clean.find((l) => l !== now && /\bnext\b/i.test(l)) ?? clean.find((l) => l !== now) ?? null;
  return { now, next };
}

/**
 * Durations a person reads: "573.3 days" → "over a year and a half", "45 days" → "6 weeks". Under two weeks stays
 * as written. Applied to every read line the book shows (20 Oct 2026: "inactive for 573.3 days"). Pure.
 */
export function humanDuration(days: number): string {
  if (days < 14) return `${Math.round(days)} days`;
  // No "about" for weeks and months: the phrase must read inside "in the last …" as well as "for …".
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30.4)} months`;
  const years = days / 365;
  const whole = Math.floor(years);
  const half = years - whole >= 0.5;
  const unit = whole === 1 ? (half ? "a year and a half" : "a year") : (half ? `${whole} and a half years` : `${whole} years`);
  return `over ${unit}`;
}
export function humaniseDurations(text: string): string {
  return text.replace(/\b(\d+(?:\.\d+)?)\s*days\b/gi, (m, n) => (Number(n) >= 14 ? humanDuration(Number(n)) : m));
}

/**
 * A line kept whole: the first sentence when it fits, else as many words as fit, closed with "…". Never cut mid-word
 * (a guardrail read "…not e" on 20 Oct 2026). Pure.
 */
export function sentenceCut(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const first = /^.+?[.!?](?=\s|$)/.exec(t)?.[0];
  if (first && first.length <= max) return first;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,;:—–-]+$/, "")}…`;
}

/** Her guardrails, in her own words first, then contracts, then the read's biggest risk. Pure. */
export function guardrailsOf(input: {
  avoid: string[]; voiceAvoid: string[]; conflicts: Array<{ what: string }>; risk: string | null;
}): BookGuardrail[] {
  const out: BookGuardrail[] = [];
  const seen = new Set<string>();
  const add = (text: string, from: BookGuardrail["from"]) => {
    const t = sentenceCut(humaniseDurations(text), 240);
    const k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push({ text: t, from }); }
  };
  input.avoid.forEach((t) => add(t, "you"));
  input.voiceAvoid.forEach((t) => add(`Never say: ${t}`, "you"));
  input.conflicts.forEach((c) => add(c.what, "contract"));
  if (input.risk) add(input.risk, "read");
  return out.slice(0, 6);
}

export async function readBookSources(
  athleteId: string,
  input: { firstName: string; brief: CopyBrief | null; voice: { tone?: string; phrases?: string[]; avoid?: string[] } | null },
): Promise<BookSources> {
  const brief = input.brief;
  const stored = await dbStore.currentBrief(athleteId).catch(() => null);
  const internal = stored ? await dbStore.currentBriefInternal(athleteId).catch(() => null) : null;

  // 2 · the read of record. Withheld (identity) or absent → no "what we found" chapter.
  const intel = await buildMyIntelligence(athleteId).catch(() => null);
  const a = intel?.assessment ?? null;
  const found = a ? {
    score: a.score ?? null,
    asOf: a.evidenceAsOf ?? null,
    dimensions: a.dimensions.map((d) => ({ key: d.key, score: d.score, contribution: d.contribution ?? null })),
    strengths: (a.notes?.strengths ?? []).map((x) => humaniseDurations(one(x, 200))).filter(Boolean).slice(0, 4),
    thin: (a.notes?.constraints ?? []).map((x) => humaniseDurations(one(x, 200))).filter(Boolean).slice(0, 4),
  } : null;
  const ru = riskUpsideOf(stored as any);

  const nowNextLines = (stored?.sections.find((x) => x.key === "brand_now_next")?.lines ?? []).map((l) => l.text);

  // 6 · who's listening: her connected channels, where her audience is, her own strongest posts.
  const connected = await loadConnectedChannels(athleteId).catch(() => []);
  const channels: BookChannel[] = connected.map((c) => ({
    platform: c.platform, handle: c.handle, followers: c.followers, engagementRate: c.avgEngagementRate,
    avgReach: c.avgReachPerPost, avgViews: c.avgViewsPerPost,
  })).filter((c) => c.followers != null || c.avgReach != null || c.avgViews != null);
  const biggest = [...connected].sort((x, y) => (y.followers ?? 0) - (x.followers ?? 0))[0];
  const countries = countriesFrom(biggest?.audience?.country ?? []);

  const postRows = await db.select({
    path: sql<string>`coalesce(${mediaAssets.gcs_thumb_path}, ${mediaAssets.gcs_path})`,
    platform: mediaAssets.platform, likes: mediaAssets.like_count, comments: mediaAssets.comments_count,
    postedAt: mediaAssets.posted_at, permalink: mediaAssets.permalink, metadata: mediaAssets.metadata,
  }).from(mediaAssets).where(and(
    eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.origin, OWN), isNull(mediaAssets.deleted_at), notAPreview(),
    isNotNull(mediaAssets.gcs_path), isNotNull(mediaAssets.like_count), isNotNull(mediaAssets.permalink),
  )).orderBy(sql`${mediaAssets.like_count} desc nulls last`).limit(30);
  // Only her own posts that are proof of HER: tagged as her, about her, no group shot, no burned-in text from another
  // account (the shared predicate every proof surface uses), drawable on every phone.
  const posts: BookPost[] = postRows
    .filter((r) => r.path && DRAWABLE.test(r.path) && isProofOfHer((r.metadata as any)?.vision))
    .slice(0, 3)
    .map((r) => ({
      image: r.path, platform: r.platform ?? null, likes: r.likes ?? null, comments: r.comments ?? null,
      postedAt: r.postedAt ? new Date(r.postedAt).toISOString().slice(0, 10) : null, permalink: r.permalink ?? null,
    }));

  const captionRows = await db.select({ caption: mediaAssets.caption }).from(mediaAssets).where(and(
    eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.origin, OWN), isNull(mediaAssets.deleted_at), isNotNull(mediaAssets.caption),
  )).orderBy(sql`${mediaAssets.posted_at} desc nulls last`).limit(12);
  const captions = captionRows.map((r) => one(r.caption, 240)).filter((c) => c.length >= 20).slice(0, 8);

  // Read early: the partners (kept off brand-led photos) and her goals (the plan photo's theme) feed the photo briefs.
  const prefs = await listPreferences(athleteId).catch(() => []);
  const g = guardrailsFrom(prefs, internal);
  const partnerNames = g.partners;
  const goalsRead = await readGoals(athleteId, { store: dbStore }).catch(() => null);
  const earlyGoals = (goalsRead?.goals ?? []).map((x) => one(x.text, 160)).filter(Boolean).slice(0, 4);

  // Her own library, cast per page: each photo slot's brief is written from that page's own words (photoBriefsFor, no
  // model) and matched against the library's embeddings, behind the hard gates (only her, clean, good enough). A slot
  // nothing passes stays empty: that page is drawn type-led.
  const drawable = (p: string | null | undefined): string | null => (p && DRAWABLE.test(p) ? p : null);
  const briefSources = {
    positioning: { statement: brief?.positioning.statement, from: brief?.positioning.from, to: brief?.positioning.to, pillars: brief?.positioning.pillars ?? [] },
    milestones: milestonesFrom(brief?.signals ?? []),
    nowNext: nowNextFrom(nowNextLines),
    goals: earlyGoals,
  };
  const briefs = photoBriefsFor(briefSources);
  const cast = await castBriefs(athleteId, briefs, { avoidBrands: partnerNames }).catch(() => ({} as Record<string, { gcsPath: string; tier: "strong" | "decent" } | null>));
  const images: Record<string, string | null> = Object.fromEntries(Object.entries(cast).map(([k, v]) => [k, drawable(v?.gcsPath)]));
  const imageTiers: Record<string, "strong" | "decent" | "atmosphere"> = Object.fromEntries(
    Object.entries(cast).filter(([k, v]) => v && images[k]).map(([k, v]) => [k, (v as { tier?: "strong" | "decent" }).tier ?? "strong"]));
  // The atmosphere tier (22 Oct 2026): a slot her own library could not fill takes a place from the shared sport library
  // (pitch, court, track — never a person). Slots ABOUT her never do; the cover / big idea take it only as a backdrop.
  const sportRow = await db.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1).catch(() => []);
  const atmos = await fillFromAtmosphere(sportRow[0]?.sport ?? null, briefs.map((b) => ({ key: b.key, query: b.query, filled: !!images[b.key] })));
  for (const [k, p] of Object.entries(atmos.images)) { images[k] = p; imageTiers[k] = "atmosphere"; }
  const forPalette = [images.cover, images.big_idea, images["voice.0"], images["voice.1"], images["voice.2"]].filter((p): p is string => !!p).slice(0, 5);
  const buffers = (await Promise.all(forPalette.map((p) => readObject(p, 15_000_000).catch(() => null)))).filter((x): x is { buf: Buffer; contentType: string } => !!x);
  const palette = await paletteFromImages(buffers.map((b) => b.buf));

  // The treatment step (21 Oct 2026): every cast photo cropped to its slot around her face and graded in the book's look
  // (the neutral "campaign" grade); statement pages also get a toned version behind their line; a decent or busy cover is cut out on ink when
  // PHOTO_CUTOUT_V1 is on and a mask exists. Cached per photo + treatment, $0; any failure keeps the original.
  const treated = await treatBookImages(cast as Record<string, CastLike | null>, images);
  // A type-led cover / big idea over a toned place (never the athlete's likeness).
  const atmosBackdrops: Record<string, string> = {};
  await Promise.all(Object.entries(atmos.backdrops).map(async ([k, p]) => { atmosBackdrops[k] = await tonedBackdrop(p); }));

  // 8 · guardrails: her own words, contracts on file, the read's biggest risk.
  const guardrails = guardrailsOf({ avoid: g.avoid, voiceAvoid: input.voice?.avoid ?? [], conflicts: g.conflicts, risk: ru?.risk ?? null });

  // 9 · commercial: partners as our research describes them; the kinds of brands behind her open opportunities.
  // A partner is often a program of a brand ("<brand> Sports Club"): match the brand row on the longest leading run of
  // the partner's words, so the research of the company behind it is used. No match → the name alone, never a guess.
  const prefixesOf = (name: string): string[] => {
    const words = normalizeBrand(name).split(" ").filter(Boolean);
    return words.map((_, i) => words.slice(0, i + 1).join(" "));
  };
  const allPrefixes = [...new Set(g.partners.flatMap(prefixesOf))];
  const partnerRows = allPrefixes.length ? await db.select({
    name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url, enrichment: inboxBrands.enrichment,
    category: inboxBrands.category, tier: inboxBrands.brand_tier, audience: inboxBrands.audience_summary, normalized: inboxBrands.normalized_name,
  }).from(inboxBrands).where(inArray(inboxBrands.normalized_name, allPrefixes)) : [];
  const partners: BookPartner[] = g.partners.map((name) => {
    const r = prefixesOf(name).reverse().map((k) => partnerRows.find((x) => x.normalized === k)).find(Boolean);
    return {
      name, logoUrl: r ? brandDisplayLogo({ domain: r.domain, logo_url: r.logo_url, enrichment: r.enrichment }) : null,
      category: r?.category ? one(r.category, 60) : null, tier: r?.tier ?? null, audience: r?.audience ? one(r.audience, 180) : null,
    };
  });
  const inboundRows = await db.select({ category: inboxBrands.category, n: sql<number>`count(*)::int` })
    .from(opportunities).innerJoin(inboxBrands, eq(inboxBrands.id, opportunities.brand_id))
    .where(and(eq(opportunities.athlete_id, athleteId), eq(opportunities.status, "open"), isNotNull(inboxBrands.category)))
    .groupBy(inboxBrands.category).orderBy(desc(sql`count(*)`)).limit(5);
  const inbound = inboundRows.map((r) => ({ category: one(r.category, 60), count: Number(r.n) })).filter((r) => r.category);
  const hasRates = (await loadRateRanges(athleteId).catch(() => new Map())).size > 0
    || Object.keys(await loadMinimumRates(athleteId).catch(() => ({}))).length > 0;

  const goals = earlyGoals;
  const moments = (goalsRead?.moments ?? []).slice(0, 4).map((m) => ({ date: m.date, name: one(m.name, 120) }));

  return {
    firstName: input.firstName,
    found,
    opportunity: ru?.upside ? humaniseDurations(one(ru.upside, 320)) : null,
    positioning: {
      statement: brief?.positioning.statement, from: brief?.positioning.from, to: brief?.positioning.to,
      pillars: brief?.positioning.pillars ?? [],
    },
    nowNext: nowNextFrom(nowNextLines),
    milestones: milestonesFrom(brief?.signals ?? []),
    channels,
    countries,
    posts,
    palette,
    voice: input.voice ? { tone: input.voice.tone, phrases: input.voice.phrases } : null,
    captions,
    guardrails,
    partners,
    inbound,
    hasRates,
    goals,
    moments,
    images: treated.images,
    imageTiers,
    backdrops: { ...atmosBackdrops, ...treated.backdrops },
  };
}
