/**
 * copyContext — what the copywriter (narrator.ts) reads about an athlete from the CURRENT memory: the Brief (narrative,
 * thesis, positioning, stage, content pillars, brand now/next, current sponsors) and the athlete's own facts (dated
 * milestones, the latest measured numbers). It replaces the legacy story_arc as the copy's angle source; an athlete with
 * no current Brief gets null and the copy keeps the legacy fields.
 *
 * For ANGLE only: the copywriter is told never to list any of it back (narrator.ts SYSTEM).
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { memoryBriefs, memoryFacts } from "../../shared/schema";

export interface CopyBrief {
  /** Brief narrative + big idea + verdict, one line. */
  storyArc: string;
  /** Dated milestones, newest first ("2025: …"). */
  signals: string[];
  /** Brand now/next lines ("So what" first). */
  lanes: string[];
  /** Current sponsors' names. */
  partners: string[];
  stage: string;
  positioning: { from?: string; to?: string; statement?: string; pillars: Array<{ name: string; line: string }> };
  contentPillars: string[];
  /** The latest measured numbers (followers, reach, engagement, views, audience by country). */
  headline: string[];
}

export interface CopyFact { claim: string; type: string; topic: string | null; date: string | null; precision: string | null; sensitive: boolean }
export interface CopyBriefRow { summary: string; sections: unknown; internal: unknown; display: unknown }

const one = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Milestones and honours, by generic marker words — no sport, league or athlete terms.
const MARKERS = [/\bfirst\b/i, /\bcaptain(ed|cy)?\b/i, /\bAll-[A-Z]/, /\bchampion(ship)?s?\b/i, /\bhonou?rs?\b/i, /\baward/i, /\bnamed\b/i, /\bnational[- ]team\b/i, /\bfellows?\b/i, /\bwon\b/i, /\bcall-up\b/i, /\brecord\b/i, /\bmedal/i, /\btitle\b/i];
// Topics that are not career milestones.
const SKIP_TOPICS = new Set(["conversation", "media", "sponsor", "business", "cause", "social"]);
const HEADLINE = [/has [\d,.]+[km]? followers/i, /posts reach [\d,.]+/i, /average an? [\d.]+% engagement/i, /average [\d,.]+[km]? views/i, /audience by country/i];

export function copyBriefFrom(brief: CopyBriefRow | null, facts: CopyFact[]): CopyBrief | null {
  if (!brief) return null;
  const sections = Array.isArray(brief.sections) ? (brief.sections as Array<{ key?: string; text?: string }>) : [];
  const sec = (k: string) => String(sections.find((s) => s?.key === k)?.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const internal = (brief.internal ?? {}) as { narrative?: string; currentSponsors?: Array<{ name?: string }> };
  const display = (brief.display ?? {}) as {
    positioning?: { from?: string; to?: string; statement?: string; pillars?: Array<{ name?: string; line?: string }> };
    stage?: { label?: string; band?: string };
    contentPillars?: Array<{ name?: string }>;
  };
  const thesis = sec("thesis");
  const nowNext = sec("brand_now_next");
  const storyArc = [one(internal.narrative || brief.summary, 700), thesis[0] ? `big idea: ${one(thesis[0], 300)}` : "", thesis[1] ? `verdict: ${one(thesis[1], 400)}` : ""]
    .filter(Boolean).join(" | ");

  const milestones = facts
    .filter((f) => (f.type === "found" || f.type === "said") && f.date && !f.sensitive && !SKIP_TOPICS.has(f.topic ?? "") && !/unclear|unverified/i.test(f.claim))
    .map((f) => ({ claim: f.claim, date: f.date!, score: MARKERS.filter((r) => r.test(f.claim)).length + (f.precision === "day" ? 0.5 : 0) }))
    .filter((f) => f.score >= 1)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, 6)
    .sort((a, b) => b.date.localeCompare(a.date));

  const measured = facts.filter((f) => f.type === "measured" && f.date).sort((a, b) => b.date!.localeCompare(a.date!));
  const latest = measured.filter((f) => f.date === measured[0]?.date).map((f) => f.claim);
  const headline = HEADLINE.flatMap((re) => latest.filter((c) => re.test(c)));

  const pos = display.positioning ?? {};
  return {
    storyArc,
    signals: milestones.map((m) => `${m.date.slice(0, 4)}: ${one(m.claim, 200)}`),
    lanes: [nowNext.find((l) => /^so what/i.test(l)), nowNext[1]].filter((l): l is string => !!l).map((l) => one(l, 220)),
    partners: (internal.currentSponsors ?? []).map((s) => one(s?.name, 60)).filter(Boolean),
    stage: display.stage?.label ? `${one(display.stage.label, 160)}${display.stage.band ? ` (${one(display.stage.band, 30)})` : ""}` : "",
    positioning: {
      from: pos.from ? one(pos.from, 200) : undefined, to: pos.to ? one(pos.to, 200) : undefined, statement: pos.statement ? one(pos.statement, 300) : undefined,
      pillars: (pos.pillars ?? []).filter((p) => p?.name).map((p) => ({ name: one(p.name, 60), line: one(p.line, 200) })),
    },
    contentPillars: (display.contentPillars ?? []).map((p) => one(p?.name, 60)).filter(Boolean),
    headline,
  };
}

/** The athlete's current Brief and own facts, as copy context; null when there is no current Brief. */
export async function loadCopyBrief(athleteId: string): Promise<CopyBrief | null> {
  const [brief] = await db.select({ summary: memoryBriefs.summary, sections: memoryBriefs.sections, internal: memoryBriefs.internal, display: memoryBriefs.display })
    .from(memoryBriefs).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
  if (!brief) return null;
  // Milestones (found/said) and the latest measured numbers, read apart so many measured rows never crowd out milestones.
  const read = (types: string[], limit: number) => db.select({
    claim: memoryFacts.claim, type: memoryFacts.type, topic: memoryFacts.topic, date: memoryFacts.observed_on,
    precision: memoryFacts.date_precision, sensitive: memoryFacts.sensitive,
  }).from(memoryFacts).where(and(
    eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, "active"), eq(memoryFacts.subject_kind, "athlete"),
    inArray(memoryFacts.type, types), isNotNull(memoryFacts.observed_on),
  )).orderBy(desc(memoryFacts.observed_on)).limit(limit);
  const rows = [...(await read(["found", "said"], 500)), ...(await read(["measured"], 60))];
  return copyBriefFrom(brief, rows.map((r) => ({ ...r, date: r.date ? String(r.date).slice(0, 10) : null })));
}
