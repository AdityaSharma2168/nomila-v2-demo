/**
 * deckFacts — the Nomi Card's fact hygiene, in code (no model):
 *   - dedupeClaims: one fact said three ways ("First Indian-American to represent US…", "first player of Indian
 *     descent…") is ONE line on the record card. Collapsed by meaning — content words after normalising spelling
 *     variants (U.S./US/United States/American, -ed/-s endings) — never across different years.
 *   - unbackedUniqueness: a crafted line that claims she is the only / the first is kept only when one of her own facts
 *     makes that kind of claim.
 *   - audienceBreakdown: the audience card's chart data (age, gender, top countries, platform split) from ONE source —
 *     her latest connected Instagram demographics and her follower counts.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { socialAnalyticsSnapshots } from "../../shared/schema";
import { readFollowers } from "./followers";

// ─── Record: collapse near-identical claims ─────────────────────────────────────────────────────────────────────

const STOP = new Set(["a", "an", "the", "at", "to", "of", "in", "on", "for", "and", "or", "any", "as", "by", "with", "her", "she", "his", "he", "their",
  "player", "team", "tournament", "athlete", "member", "women", "womens", "men", "mens"]);
const SPELLINGS: Array<[RegExp, string]> = [
  [/\bu\.\s?s\.?(?=\W|$)|\bu\.s\.a\.?|\busa\b|\bunited states\b|\bamerican\b|\bamerica\b/g, " us "],
  [/\bindian[- ]american\b|\bof indian descent\b|\bindian descent\b|\bindian heritage\b/g, " indian "],
  [/\bco[- ]?captain(?:ed|s|cy)?\b|\bcaptain(?:ed|s|cy)?\b/g, " captain "],
];

/** The content words of a claim, spelling variants normalised. */
export function claimWords(text: string): Set<string> {
  let t = ` ${String(text ?? "").toLowerCase()} `;
  for (const [re, to] of SPELLINGS) t = t.replace(re, to);
  const words = t.replace(/[^a-z0-9\- ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .map((w) => (w.length > 4 ? w.replace(/(?:ed|s)$/, "") : w))
    .filter((w) => w && !STOP.has(w));
  return new Set(words);
}

/** Do two claims say the same thing? Overlap of content words ≥ 0.75 of the shorter, and never different years. */
export function sameClaim(a: { name: string; year?: string | number }, b: { name: string; year?: string | number }): boolean {
  if (a.year != null && b.year != null && String(a.year) !== String(b.year)) return false;
  const wa = claimWords(a.name), wb = claimWords(b.name);
  const min = Math.min(wa.size, wb.size);
  if (min < 3) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / min >= 0.75;
}

/** Keep the first of each group of same-meaning claims (the list is prestige-ranked, so the first is the best one). */
export function dedupeClaims<T extends { name: string; year?: string | number }>(list: T[]): T[] {
  const out: T[] = [];
  for (const x of list) if (!out.some((k) => sameClaim(k, x))) out.push(x);
  return out;
}

// ─── Uniqueness claims must be backed ───────────────────────────────────────────────────────────────────────────

const ONLY = /\b(?:the only|only one|no one else|nobody else|no other|unlike any|unmatched|unrivall?ed)\b/i;
const FIRST = /\b(?:the first|first[- ]ever|first (?:to|of|player|athlete|woman|indian))\b/i;

/** True when the text claims she is the only / the first and none of her facts makes that kind of claim. */
export function unbackedUniqueness(text: string, facts: string[]): boolean {
  const t = String(text ?? "");
  const said = facts.join(" \n ");
  if (ONLY.test(t) && !ONLY.test(said)) return true;     // backed only by a fact that itself makes that claim
  if (FIRST.test(t) && !FIRST.test(said)) return true;
  return false;
}

// ─── Audience: one source, one number ───────────────────────────────────────────────────────────────────────────

export interface AudienceBreakdown {
  ages: Array<{ label: string; pct: number }>;
  genders: Array<{ label: string; pct: number }>;
  platforms: Array<{ label: string; n: number; pct: number }>;
}

const GENDER: Record<string, string> = { F: "Women", M: "Men", U: "Undisclosed" };
const PLATFORM: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X" };
const pctList = (v: unknown): Array<{ key: string; pct: number }> =>
  (Array.isArray(v) ? v : []).map((x: any) => ({ key: String(x?.key ?? ""), pct: Number(x?.pct) }))
    .filter((x) => x.key && Number.isFinite(x.pct) && x.pct > 0);

/** The chart data from the stored demographics + follower counts (pure; tested). */
export function audienceBreakdownFrom(demographics: any, counts: Record<string, number | null>): AudienceBreakdown {
  const ageOrder = (k: string) => parseInt(k, 10) || 999;
  const ages = pctList(demographics?.age).sort((a, b) => ageOrder(a.key) - ageOrder(b.key)).map((a) => ({ label: a.key, pct: Math.round(a.pct) }));
  const genders = pctList(demographics?.gender).sort((a, b) => b.pct - a.pct).map((g) => ({ label: GENDER[g.key] ?? g.key, pct: Math.round(g.pct) }));
  const raw = Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0) as Array<[string, number]>;
  const total = raw.reduce((s, [, n]) => s + n, 0);
  const platforms = raw.sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: PLATFORM[k] ?? k, n, pct: total ? Math.round((n / total) * 100) : 0 }));
  return { ages, genders, platforms };
}

export async function loadAudienceBreakdown(athleteId: string): Promise<AudienceBreakdown> {
  const [[snap], followers] = await Promise.all([
    db.select({ raw: socialAnalyticsSnapshots.raw_metrics }).from(socialAnalyticsSnapshots)
      .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, "instagram"), eq(socialAnalyticsSnapshots.source, "connected")))
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(1),
    readFollowers(athleteId),
  ]);
  return audienceBreakdownFrom((snap?.raw as any)?.demographics, followers.counts as Record<string, number | null>);
}
