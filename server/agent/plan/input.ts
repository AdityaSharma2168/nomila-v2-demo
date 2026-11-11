/**
 * agent/plan/input.ts — everything the plan call reads, rendered into ONE input block with stable keys (design
 * "Inputs"), and the context the code checks need to resolve those keys afterwards.
 *
 *   BRIEF        the current Brief: summary and sections (no refresh cadence), each line with its F-keys; and, from the
 *                internal read, the current sponsors and the exclusivity and category conflicts (what each blocks).
 *                Model input, never an athlete route. No strengths section and no 0–10 criteria: those come from the
 *                M.I.A.
 *   M.I.A.       the ONLY source of strengths, constraints and missing data, each with its dimension; each dimension's
 *                state and rationale; the preliminary flag. Never the score as a number.
 *   INTENT       where the athlete said they want to start (the onboarding capability tap, a said fact)
 *   GOALS        not dropped (≤ 8): id, text, status, horizon, domain, priority, who wrote it and its game plan, and
 *                (plan 1.5.0) what it repeats on when it is a standing goal (its recommendation's detail.repeats, read
 *                through memory_goals.decision_id); each with its last 30 days of actions
 *   DECISIONS    the last 60 days (≤ 40): suggested, kind, response, reason, outcome, goal — skipped recommendations
 *                included, so they are not repeated (the moments scan's candidate posts are not decisions here: they
 *                are MOMENTS)
 *   PREFERENCES  active voice / avoid / standing rule / style (≤ 30) and the never-use names
 *   CONNECTED    the onboarding connectors: connected, last read, can offer now
 *   EVENTS       dated upcoming facts in the next 60 days (≤ 24), keyed E1…En, each date as precise as it is known (a
 *                month-only date reads "2026-12 (month only)")
 *   MOMENTS      the weekly moments scan's candidate posts (agent/moments; ≤ 12, best first), each under the E-key of its
 *                moment: why now, its hook and its one angle (moments 1.2.0; a row from before shows its old idea, brief
 *                and media needs) — strategist input the plan may turn into this week's post action, citing the E-key.
 *                With the idea bank on, a moment's own bank entry rides on its line as an I-key, and a moment whose entry
 *                is spent (used, skipped, adapted) is not offered again
 *   CONTENT PILLARS  (plan 1.3.0, idea bank on) the Brief's 2–4 pillars, P-keyed, each with when it last had a post (the
 *                last 30 days of post actions), for the rotation
 *   IDEA BANK    (plan 1.3.0, idea bank on) ideas on file not used yet (agent/ideaBank/bank.ts planBank), I-keyed:
 *                timely ones under their event's E-key, evergreen ones under their pillar
 *   MISSED IDEAS (plan 1.3.0, idea bank on) timely ideas whose moment went before they were used, X-keyed: adaptable
 *   PLAYBOOK     (plan 1.3.0, idea bank on) the shared playbook (agent/playbook read API) for the athlete's sport, stage
 *                and each active platform: the target posts a week (playbook 1.2.0: never stories), its format mix, the
 *                stories a week, formats, ideal length, hooks. Our recommendation: only a limit the athlete set in
 *                PREFERENCES overrides it (the model judges them; code never parses them)
 *   POSTING PACE (plan 1.5.0) what the athlete actually posts now, per platform: posts a week over 30 and 90 days from
 *                their measured facts, and the format split their connected account shows (sources.postingFormats).
 *                An input the plan may phase in from, never a cap
 *   RATES        (plan 1.5.0) the suggested rate ranges the athlete has (athlete_rate_ranges via sources.rates, else the
 *                Brief's internal read): what a goal's money value is read from, never invented
 *   WHAT WORKS FOR THIS ATHLETE (plan 1.6.0) how the athlete's own posts did against their usual (agent/learning
 *                summarise), by platform × format, pillar, event timing and weekday: only lines resting on 3 or more
 *                posts, each marked "leads" (8 or more: their data outweighs the playbook) or "early sign". "(none)"
 *                while the learning loop is off. The digest reads only each line's label, mark and direction, so the
 *                nightly drift of a ratio does not re-plan an unchanged week
 *   POST KIT LIMITS (plan 1.5.0) what a post kit can build (agent/postKit/config.ts), so no post asks for more
 *   THREADS      open threads waiting on the athlete (≤ 8), keyed T1…Tn
 *   FACTS        active and disputed facts (≤ 80), never removed; care facts marked (care); most-cited, then newest
 *
 * Keys only ever appear in fact_keys / refs; the athlete never reads them (validate.ts strips any that leak).
 * The idea bank is always on (AGENT_IDEA_BANK retired 2 Nov 2026).
 */
import { createHash } from "node:crypto";
import type { DatePrecision, Decision, EvidenceRef, Goal, GoalRepeats, MemoryFact, MiaPreview, Preference } from "../../../shared/agent";
import type { ActionDecisionDetail, MomentDecisionDetail } from "../../../shared/plan";
import { IDEA_BANK } from "../ideaBank/config";
import { listBank, planBank, planPillars, reclaimForPlan, rewindForDigest, spentMomentIds, type BankIdea } from "../ideaBank/bank";
import type { PlaybookCadence, PlaybookForPlatform } from "../playbook/read";
import { ageBandFrom } from "../ageBand";
import { neverTermsFrom } from "../neverTerms";
import { conflictsOf } from "../guardrails";
import { CONNECTORS } from "../onboarding/catalog";
import { miaStrengthsGaps } from "../onboarding/miaPreview";
import { isEventFact, notEnded } from "../moments/facts";
import { MOMENTS_SKILL_ID } from "../moments/config";
import type { AgentStore, BriefInternal, StoredBrief } from "../research/store";
import { IDEAS_SKILL_ID, POST_KIT } from "../postKit/config";
import { LEARNING } from "../learning/config";
import { median, whatWorksHeading, whatWorksLine, whatWorksShown, type WhatWorks } from "../learning/core";
import { PLAN, PLAN_SKILL_ID, repeatsOf } from "./config";
import { type OpenThread, type PlanCheckContext, type PlanEvent } from "./validate";

/** Where the plan's non-memory inputs come from (sources.ts reads them from the database; tests pass their own). */
export interface PlanSources {
  /** The current M.I.A. read (read only; never computes one). */
  mia(athleteId: string): Promise<MiaPreview | null>;
  /** Connected onboarding connectors, with when each was last read. */
  connected(athleteId: string): Promise<Array<{ id: string; lastReadAt: string | null }>>;
  /** Threads waiting on the athlete (the deal pipeline's needs-you list). */
  openThreads(athleteId: string): Promise<OpenThread[]>;
  /** Active preferences. */
  preferences(athleteId: string): Promise<Preference[]>;
  /**
   * The shared playbook for the athlete's sport and stage, per active platform (agent/playbook/read.ts
   * getPlaybookForAthlete): empty when the athlete has no key yet. Read only while the idea bank is on.
   */
  playbook(athleteId: string): Promise<Array<PlaybookForPlatform & { cadence: PlaybookCadence }>>;
  /**
   * plan 1.5.0: the athlete's suggested rate ranges as stored (athlete_rate_ranges). Optional: absent, the Brief's
   * internal read is used.
   */
  rates?(athleteId: string): Promise<PlanRate[]>;
  /**
   * plan 1.5.0: the share of the athlete's own posts by format, per platform and window (social_features format_mix,
   * connected accounts only). Optional: absent or empty, POSTING PACE shows posts a week only.
   */
  postingFormats?(athleteId: string): Promise<PostingFormatMix[]>;
  /**
   * plan 1.6.0: the athlete's "what works for you" (agent/learning). Optional: absent or null (the learning loop off),
   * WHAT WORKS FOR THIS ATHLETE reads "(none)".
   */
  whatWorks?(athleteId: string): Promise<WhatWorks | null>;
}

/** A suggested rate range the plan reads (plan 1.5.0). */
export interface PlanRate {
  rateType: string;
  low: number;
  high: number;
  currency: string;
  confidence: string;
  drivers: string[];
}

/** One platform's split of posts by format over a window, as shares (0–1) per format the platform reports. */
export interface PostingFormatMix {
  platform: string;
  windowDays: number;
  mix: Record<string, number>;
}

export interface PlanInput {
  /** The rendered block the model reads. */
  input: string;
  /** A digest of everything but the day (the week stands in for it): an unchanged digest reuses the last plan. */
  digest: string;
  check: PlanCheckContext;
  evidence: EvidenceRef[];
  brief: StoredBrief | null;
  athleteName: string;
}

const DAY = 86_400_000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
/** The Monday of the day's week (YYYY-MM-DD). */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/** A dated upcoming event fact (agent/moments/facts.ts, the one moments store's predicate): re-exported for readers here. */
export { isEventFact };

/**
 * Dated event facts that have not ended by today and start by the horizon, soonest first. A month- or year-only date
 * stands for its whole period: "2026-10" is still coming up on 11 October (it runs to the 31st).
 */
export function upcomingEvents(facts: MemoryFact[], today: string, days: number = PLAN.HORIZON_DAYS): MemoryFact[] {
  const until = addDays(today, days);
  return facts.filter((f) => isEventFact(f) && notEnded(f, today) && f.date! <= until)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.createdAt.localeCompare(b.createdAt));
}

/** The event's label: the fact's subject when it names the event, else the claim, shortened. */
export function eventLabel(f: MemoryFact): string {
  const subject = oneLine(f.subject.name);
  return clip(f.subject.kind === "event" && subject ? subject : oneLine(f.claim).replace(/\.$/, ""), 80);
}

/** A decision that is the moments scan's candidate post (skill moments, detail.kind moment). */
export function isMomentDecision(d: Pick<Decision, "skillId" | "kind" | "detail">): boolean {
  return d.skillId === MOMENTS_SKILL_ID && (d.kind ?? "other") === "other" && (d.detail as { kind?: unknown } | undefined)?.kind === "moment";
}

/**
 * The MOMENTS block: each pending candidate post whose moment is one of the plan's events, under that event's E-key,
 * the newest scan first, then best first by that scan's rank, at most `cap`. A candidate whose moment is not among the
 * events (past the horizon or the events cap) is left out: the plan could not time an action to it.
 */
export function momentLines(decisions: Decision[], events: ReadonlyMap<string, PlanEvent>, cap: number): string[] {
  return shownMoments(decisions, events, cap, new Set()).map((m) => momentLine(m, null));
}

/** A moment the MOMENTS block shows: its decision, its detail and its event's E-key. */
export interface ShownMoment {
  decisionId: string;
  d: MomentDecisionDetail;
  key: string;
}

/**
 * The moments the MOMENTS block shows, in order: pending candidate posts whose moment is one of the plan's events, not
 * `spent` (their bank entry used, skipped or adapted), the newest scan first, then best first by that scan's rank.
 */
export function shownMoments(decisions: Decision[], events: ReadonlyMap<string, PlanEvent>, cap: number, spent: ReadonlySet<string>): ShownMoment[] {
  const keyOf = new Map([...events].map(([k, e]) => [e.factId, k]));
  return decisions.filter((d) => d.response === "pending" && isMomentDecision(d) && !spent.has(d.id))
    .map((d) => ({ decisionId: d.id, d: d.detail as unknown as MomentDecisionDetail, key: keyOf.get(String((d.detail as { factId?: unknown }).factId ?? "")) }))
    .filter((x): x is ShownMoment => !!x.key && !!x.d.idea && !!x.d.idea.hook)
    // The newest scan first (a rank is only comparable within one scan), then its rank.
    .sort((a, b) => String(b.d.scannedAt ?? "").localeCompare(String(a.d.scannedAt ?? "")) || (a.d.rank ?? 99) - (b.d.rank ?? 99) || a.key.localeCompare(b.key, undefined, { numeric: true }))
    .slice(0, cap);
}

/**
 * One MOMENTS entry; `ideaKey` is the I-key of the moment's own bank entry, when the idea bank has one. A moment carries
 * its hook and one angle (moments 1.2.0); a row written before shows its old idea, brief and media needs instead.
 */
export function momentLine({ d, key }: ShownMoment, ideaKey: string | null): string {
  const legacy = !d.idea.angle && (d.idea.format || d.brief);
  return [
    `${key} | ${oneLine(d.name)} | ${d.category} | why now: ${oneLine(d.whyNow)}${ideaKey ? ` | idea ${ideaKey}` : ""}`,
    ...(legacy ? [
      `  idea: ${oneLine(d.idea.hook)} | ${d.idea.format ?? "-"} on ${oneLine(d.idea.platform ?? "") || "-"} | timing: ${oneLine(d.idea.timing ?? "") || "-"}`,
      `  brief: show ${oneLine(d.brief?.show ?? "") || "-"} | caption angle: ${oneLine(d.brief?.captionAngle ?? "") || "-"} | avoid: ${oneLine(d.brief?.avoid ?? "") || "-"}`,
      `  media it needs: ${oneLine(d.mediaNeeds ?? "") || "-"}`,
    ] : [
      `  hook: ${oneLine(d.idea.hook)} | angle: ${oneLine(d.idea.angle ?? "") || "-"}`,
    ]),
  ].join("\n");
}

const range = (r: { min: number; max: number } | null | undefined) => (r ? (r.min === r.max ? `${r.min}` : `${r.min}-${r.max}`) : "-");

/**
 * One PLAYBOOK entry per platform: the target posts a week (never stories), the format mix toward it, the stories a
 * week, formats, ideal length and hooks — or that none exists yet. A playbook written before 1.2.0 has no mix or
 * stories range: those read "-".
 */
export function playbookLines(rows: ReadonlyArray<PlaybookForPlatform & { cadence: PlaybookCadence }>): string[] {
  return rows.map((r) => {
    const c = r.config;
    if (!c) return `- ${r.platform} | no playbook yet`;
    const mix = c.cadence?.formatMix;
    const mixWords = mix ? Object.entries(mix).map(([f, n]) => `${f} ${n}`).join(", ") : "-";
    return [
      `- ${r.platform} | target posts a week (feed posts, reels, carousels; never stories): ${range(r.cadence.postsPerWeek)} | format mix a week: ${mixWords} | stories a week: ${range(c.cadence?.storiesPerWeek)} | ideal length ${c.idealLengthSec.min}-${c.idealLengthSec.max}s`,
      `  formats: ${c.formats.length ? c.formats.map((f) => `${f.postFormat} (${oneLine(f.name)}: ${oneLine(f.whenToUse)})`).join("; ") : "-"}`,
      `  hooks: ${c.hooks.length ? c.hooks.map(oneLine).join("; ") : "-"}`,
    ].join("\n");
  });
}

/** A measured posts-a-week fact's platform and window: "…#instagram.posts_per_week_30d" → instagram, 30. */
const PACE_REF = /#([a-z_]+)\.posts_per_week_(\d+)d$/;
/** A snapshot's posts in the last 30 days: "…#instagram.posts_last_30d". */
const LAST30_REF = /#([a-z_]+)\.posts_last_30d$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * POSTING PACE (plan 1.5.0): what the athlete actually posts now, per platform — posts a week over the last 30 and 90
 * days from their measured facts (the derived posts-a-week reading; else the snapshot's posts in the last 30 days), and
 * the format split their connected account shows, when known. Measured numbers only: nothing is estimated.
 */
export function postingPaceLines(facts: readonly MemoryFact[], formats: readonly PostingFormatMix[] = []): string[] {
  const pace = new Map<string, Map<number, number>>();
  const add = (platform: string, window: number, perWeek: number) => {
    const p = pace.get(platform) ?? new Map<number, number>();
    if (!p.has(window)) p.set(window, perWeek);
    pace.set(platform, p);
  };
  const measured = facts.filter((f) => f.type === "measured" && f.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const numberIn = (claim: string, label: RegExp) => {
    const m = label.exec(claim);
    return m ? Number(m[1].replace(/,/g, "")) : NaN;
  };
  for (const f of measured) {
    const ref = f.source.ref ?? "";
    const p = PACE_REF.exec(ref);
    if (p) {
      const v = numberIn(f.claim, /:\s*([\d.,]+)\s*per week/i);
      if (Number.isFinite(v)) add(p[1], Number(p[2]), v);
      continue;
    }
    const l = LAST30_REF.exec(ref);
    if (l && !pace.get(l[1])?.has(30)) {
      const v = numberIn(f.claim, /published\s+([\d.,]+)\s+posts/i);
      if (Number.isFinite(v)) add(l[1], 30, round1(v / (30 / 7)));
    }
  }
  const mixOf = (platform: string, window: number) => formats.find((m) => m.platform === platform && m.windowDays === window)?.mix;
  const lines: string[] = [];
  for (const platform of [...new Set([...pace.keys(), ...formats.map((m) => m.platform)])].sort()) {
    const p = pace.get(platform) ?? new Map<number, number>();
    const mix = mixOf(platform, 30) ?? mixOf(platform, 90);
    const mixWords = mix ? Object.entries(mix).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([f, s]) => `${f} ${Math.round(s * 100)}%`).join(", ") : "";
    lines.push(`- ${platform} | posts a week, last 30 days: ${p.has(30) ? p.get(30) : "-"} | last 90 days: ${p.has(90) ? p.get(90) : "-"}${mixWords ? ` | by format: ${mixWords}` : ""}`);
  }
  return lines;
}

/** RATES (plan 1.5.0): the suggested ranges the athlete has, one line each; what a goal's money value is read from. */
export function rateLines(rates: readonly PlanRate[]): string[] {
  return rates.map((r) => `- ${r.rateType} | ${r.low}-${r.high} ${r.currency} | confidence ${r.confidence} | drivers: ${r.drivers.map(oneLine).join("; ") || "-"}`);
}

/** POST KIT LIMITS (plan 1.5.0): what a post kit can build, from its own config, so no post asks for more. */
export function postKitLimitLines(): string[] {
  return [
    `- formats a kit builds: reel, carousel, story, feed — from the athlete's own photos and clips only; nothing is generated`,
    `- a carousel holds at most ${POST_KIT.MAX_ASSETS} photos or clips; a reel or story at most ${POST_KIT.VIDEO_MAX_ASSETS}; a feed post one photo`,
    `- a video is at most ${POST_KIT.TOTAL_MAX_SEC} seconds in all, each clip at most ${POST_KIT.MAX_CLIP_SEC} seconds`,
  ];
}

/**
 * WHAT WORKS FOR THIS ATHLETE (plan 1.6.0): the lines resting on 3 or more of the athlete's own posts, each marked
 * "leads" or "early sign" (learning/core.ts whatWorksLine). For the digest, each line's label, mark and direction only
 * (above, around or below the athlete's usual, by the judge's bands): a ratio drifting overnight does not re-plan.
 */
export function whatWorksBlockLines(w: WhatWorks | null | undefined, forDigest = false): string[] {
  const shown = whatWorksShown(w, PLAN.CAPS.whatWorks);
  if (!forDigest) return shown.map(whatWorksLine);
  return shown.map((l) => {
    const m = median(Object.values(l.metrics).map((x) => x!.ratio));
    const dir = m >= LEARNING.WORKED_AT ? "above" : m <= LEARNING.DID_NOT_WORK_AT ? "below" : "around";
    return `- ${l.dimension}|${l.key} | ${dir} | ${l.leads ? "leads" : "early"}`;
  });
}

export { repeatsOf };

/** The athlete's name: their said #name fact. */
export function athleteNameFrom(facts: MemoryFact[]): string {
  return facts.find((f) => f.type === "said" && (f.source.ref ?? "").endsWith("#name"))?.subject.name ?? "";
}

/** The event's date as the plan reads it: as precise as it is known ("2026-12 (month only)", "2027 (year only)"). */
export function eventDateWords(date: string, precision: DatePrecision | null | undefined): string {
  if (precision === "month") return `${date.slice(0, 7)} (month only)`;
  if (precision === "year") return `${date.slice(0, 4)} (year only)`;
  return date;
}

/**
 * The exclusivity and category conflicts the pitch check reads: Understand's internal read (1.9.0), each with what it
 * blocks. A Brief written before 1.9.0 has none (the plan then relies on current partners and the avoid-list). ONE
 * definition, shared with moments and post-kit/ideas (agent/guardrails.ts).
 */
export { conflictsOf };

/** The biggest risk and upside: the current Brief's risks_upside, first risk line and first upside line. */
export function riskUpsideOf(brief: StoredBrief | null): { risk: string; upside: string } | null {
  const ru = riskUpsideLines(brief);
  const strip = (t: string) => t.replace(/^(biggest\s+)?(risk|upside)\s*[:—–-]\s*/i, "").trim();
  return ru ? { risk: strip(ru.risk.text), upside: strip(ru.upside.text) } : null;
}

/** The fact ids the Brief's biggest-risk line (the one riskUpsideOf returns) rests on; [] when there is none. */
export function riskFactIdsOf(brief: StoredBrief | null): string[] {
  return riskUpsideLines(brief)?.risk.factIds ?? [];
}

type BriefLine = { text: string; factIds: string[] };
function riskUpsideLines(brief: StoredBrief | null): { risk: BriefLine; upside: BriefLine } | null {
  const s = brief?.sections.find((x) => x.key === "risks_upside");
  if (!s) return null;
  const lines: BriefLine[] = (s.lines ?? []).map((l) => ({ text: oneLine(l.text), factIds: l.factIds ?? [] })).filter((l) => l.text);
  const risk = lines.find((l) => /\brisk/i.test(l.text)) ?? lines[0];
  const upside = lines.find((l) => /\bupside|opportunit/i.test(l.text) && l.text !== risk?.text) ?? lines.find((l) => l.text !== risk?.text);
  return risk && upside ? { risk, upside } : null;
}

export async function buildPlanInput(store: AgentStore, sources: PlanSources, athleteId: string, now: Date, opts: { reason?: string | null; focusGoalId?: string | null } = {}): Promise<PlanInput> {
  const today = isoDay(now);
  const facts = await store.listFacts(athleteId, ["active", "disputed"]);
  const athleteName = athleteNameFrom(facts);
  const brief = await store.currentBrief(athleteId);
  const internal: BriefInternal | null = brief ? await store.currentBriefInternal(athleteId) : null;
  const conflicts = conflictsOf(internal);
  const goalsAll = await store.listGoals(athleteId, { includeDropped: true });
  const decisions90 = (await store.listDecisions(athleteId, { since: new Date(now.getTime() - PLAN.QUIET_DAYS * DAY).toISOString() })).filter((d) => !isMomentDecision(d));
  const momentDecisions = await store.listDecisions(athleteId, { skillId: MOMENTS_SKILL_ID, kinds: ["other"], responses: ["pending"] });
  const [mia, connected, threadsAll, prefs, playbook, bank, storedRates, postingFormats, whatWorks] = await Promise.all([
    sources.mia(athleteId).catch(() => null),
    sources.connected(athleteId).catch(() => []),
    sources.openThreads(athleteId).catch(() => []),
    sources.preferences(athleteId).catch(() => []),
    sources.playbook(athleteId).catch(() => []),
    listBank(store, athleteId),
    sources.rates ? sources.rates(athleteId).catch(() => [] as PlanRate[]) : Promise.resolve([] as PlanRate[]),
    sources.postingFormats ? sources.postingFormats(athleteId).catch(() => [] as PostingFormatMix[]) : Promise.resolve([] as PostingFormatMix[]),
    sources.whatWorks ? sources.whatWorks(athleteId).catch(() => null) : Promise.resolve(null),
  ]);
  // The rates a goal's money value is read from: the stored suggested ranges, else the Brief's own (plan 1.5.0).
  const rates: PlanRate[] = storedRates.length ? storedRates : (internal?.rateRanges ?? []).map((r) => ({
    rateType: r.rateType, low: r.low, high: r.high, currency: r.currency, confidence: r.confidence, drivers: r.drivers,
  }));
  // A held goal's standing trigger lives on the recommendation it was kept from (memory_goals.decision_id).
  const goalRepeats = new Map<string, GoalRepeats>();
  for (const g of goalsAll) {
    if (!g.decisionId || g.status === "dropped") continue;
    const r = repeatsOf(await store.getDecision(athleteId, g.decisionId).catch(() => null));
    if (r) goalRepeats.set(g.id, r);
  }

  // ── keys ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const cited = new Map<string, number>();
  for (const s of brief?.sections ?? []) for (const l of s.lines ?? []) for (const id of l.factIds) cited.set(id, (cited.get(id) ?? 0) + 1);
  const keyedFacts = [...facts].sort((a, b) => (cited.get(b.id) ?? 0) - (cited.get(a.id) ?? 0) || b.createdAt.localeCompare(a.createdAt)).slice(0, PLAN.CAPS.facts);
  const factKey = new Map<string, string>();
  const factsByKey = new Map<string, MemoryFact>();
  keyedFacts.forEach((f, i) => { factKey.set(f.id, `F${i + 1}`); factsByKey.set(`F${i + 1}`, f); });
  const keysOf = (ids: string[]) => ids.map((id) => factKey.get(id)).filter(Boolean).join(", ");

  const events = new Map<string, PlanEvent>();
  upcomingEvents(facts, today).slice(0, PLAN.CAPS.events).forEach((f, i) => {
    events.set(`E${i + 1}`, { fact: f, factId: f.id, label: eventLabel(f), date: f.date!, precision: f.datePrecision ?? "day" });
  });
  const threads = new Map<string, OpenThread>();
  threadsAll.slice(0, PLAN.CAPS.threads).forEach((t, i) => threads.set(`T${i + 1}`, t));

  // ── blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const briefBlock = brief ? clip([
    `Summary: ${oneLine(brief.summary)}`,
    ...(brief.display?.stage ? [`Stage: ${brief.display.stage.label} (band ${brief.display.stage.band})`] : []),
    ...brief.sections.filter((s) => s.key !== "refresh_cadence").map((s) => [
      `## ${s.title}${s.key ? ` [${s.key}]` : ""}`,
      ...(s.lines ?? []).map((l) => `- ${oneLine(l.text)}${l.factIds.length ? ` [${keysOf(l.factIds)}]` : ""}`),
      ...(s.soWhat ? [`So what: ${oneLine(s.soWhat)}`] : []),
    ].join("\n")),
    `## Current sponsors (internal)`,
    ...((internal?.currentSponsors ?? []).length ? internal!.currentSponsors.map((x) => `- ${x.name}${x.factIds.length ? ` [${keysOf(x.factIds)}]` : ""}`) : ["- (none confirmed)"]),
    `## Exclusivity and category conflicts (internal)`,
    ...(conflicts.length ? conflicts.map((c) => `- ${oneLine(c.what)} | blocks: ${c.blocks.map(oneLine).join("; ")}${c.factIds.length ? ` [${keysOf(c.factIds)}]` : ""}`) : ["- (none known)"]),
  ].join("\n"), PLAN.CAPS.briefChars) : "(no Brief yet)";

  const sg = mia ? miaStrengthsGaps(mia) : null;
  const miaBlock = mia && sg ? clip([
    `Read: ${mia.preliminary ? "preliminary (built from public information; connected accounts sharpen it)" : "built with connected-account data"}; confidence ${mia.confidence.level ?? "unknown"}`,
    `Strengths:`, ...(sg.key_strengths.length ? sg.key_strengths.map((x) => `- [${x.dimension}] ${oneLine(x.text) || "(no rationale)"}`) : ["- (none)"]),
    `Constraints:`, ...(sg.key_constraints.length ? sg.key_constraints.map((x) => `- [${x.dimension}] ${oneLine(x.text) || "(no rationale)"}`) : ["- (none)"]),
    `Missing data:`, ...(sg.important_missing_data.length ? sg.important_missing_data.map((x) => `- [${x.dimension}] ${oneLine(x.text)}`) : ["- (none)"]),
    `Dimensions:`, ...(mia.assessment?.dimensions ?? []).map((d) => `- ${d.key}: ${d.state}${d.rationale ? ` — ${clip(oneLine(d.rationale), 300)}` : ""}`),
    ...(sg.evaluator_notes.key_strengths.length || sg.evaluator_notes.key_constraints.length || sg.evaluator_notes.important_missing_data.length ? [
      `Evaluator notes (context, not tied to a dimension):`,
      ...sg.evaluator_notes.key_strengths.map((t) => `- strength: ${oneLine(t)}`),
      ...sg.evaluator_notes.key_constraints.map((t) => `- constraint: ${oneLine(t)}`),
      ...sg.evaluator_notes.important_missing_data.map((t) => `- missing: ${oneLine(t)}`),
    ] : []),
  ].join("\n"), PLAN.CAPS.miaChars) : "(no M.I.A. read yet)";

  const intent = facts.filter((f) => f.type === "said" && /#capability:/.test(f.source.ref ?? "")).map((f) => `- ${oneLine(f.claim)}`);

  const shownGoals = goalsAll.filter((g) => g.status !== "dropped")
    .sort((a, b) => ["active", "paused", "done"].indexOf(a.status) - ["active", "paused", "done"].indexOf(b.status)).slice(0, PLAN.CAPS.goals);
  const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
  // The digest leaves out what the plan itself wrote and nobody has answered yet (its own pending decisions, and the
  // game plans it wrote): otherwise every plan would change the next one's input, and nothing could ever be reused.
  const ownPending = (d: Decision) => d.skillId === "plan" && d.response === "pending";
  const goalBlockOf = (forDigest: boolean) => (shownGoals.length ? shownGoals.map((g: Goal) => [
    `G:${g.id} | ${g.status} | horizon ${g.horizon ?? "-"} | domain ${g.domain ?? "-"} | priority ${g.priority ?? "-"} | ${g.source === "said" ? "typed by the athlete" : "kept from a recommendation"}${goalRepeats.has(g.id) ? ` | repeats: ${goalRepeats.get(g.id)}` : ""} | ${oneLine(g.text)}`,
    `  game plan (${g.gamePlanBy === "athlete" ? "written by the athlete: echo it, never rewrite" : "Mila's"}): ${forDigest && g.gamePlanBy !== "athlete" ? "-" : g.gamePlan ? oneLine(g.gamePlan) : "(none yet)"}`,
    ...decisions90.filter((d) => d.goalId === g.id && (d.kind ?? "other") === "action" && d.createdAt >= since30 && !(forDigest && ownPending(d)))
      .map((d) => `  - action: ${oneLine(d.suggested)} | ${d.response}${d.responseReason ? ` (${oneLine(d.responseReason)})` : ""} | outcome ${d.outcome}${d.outcomeNote ? ` (${oneLine(d.outcomeNote)})` : ""}`),
    ...(!forDigest && opts.focusGoalId === g.id ? ["  (this run was asked for because of this goal)"] : []),
  ].join("\n")).join("\n") : "- (no goals yet)");

  const since60 = new Date(now.getTime() - PLAN.CAPS.decisionDays * DAY).toISOString();
  // Idea-bank rows (agent/ideaBank) are not decisions anyone made: they never show here. With the idea bank on, the plan
  // reads them in their own blocks (MOMENTS, IDEA BANK, MISSED IDEAS; design "Moments → post kits" §6–§7).
  const isIdea = (d: Decision) => d.skillId === IDEAS_SKILL_ID || d.detail?.kind === "idea";
  const decisionBlockOf = (forDigest: boolean) => {
    const recent = decisions90.filter((d: Decision) => d.createdAt >= since60 && !((d.kind ?? "other") === "action" && d.goalId) && !(forDigest && ownPending(d)) && !isIdea(d))
      .slice(-PLAN.CAPS.decisions).reverse();
    return recent.length ? recent.map((d) => `- ${(d.kind ?? "other")} | ${d.skillId} | ${oneLine(d.suggested)} | ${d.response}${d.responseReason ? ` (${oneLine(d.responseReason)})` : ""} | outcome ${d.outcome} | ${forDigest ? "" : d.createdAt.slice(0, 10)}`).join("\n") : "- (none)";
  };

  const activePrefs = prefs.filter((p) => p.status === "active").slice(0, PLAN.CAPS.preferences);
  const neverTerms = neverTermsFrom(activePrefs);
  const avoid = activePrefs.filter((p) => p.kind === "avoid").map((p) => p.statement);
  const prefBlock = [
    ...(activePrefs.length ? activePrefs.map((p) => `- ${p.kind}: ${oneLine(p.statement)}`) : ["- (none)"]),
    ...(neverTerms.length ? [`Never use these names anywhere: ${neverTerms.join(", ")}`] : []),
  ].join("\n");

  const connectedIds = new Map(connected.map((c) => [c.id, c.lastReadAt]));
  const offerable = CONNECTORS.filter((c) => !connectedIds.has(c.id)).map((c) => c.id);
  const connBlock = CONNECTORS.map((c) => `- ${c.id} | ${c.service} | ${c.kind} | ${connectedIds.has(c.id) ? `connected, last read ${connectedIds.get(c.id)?.slice(0, 10) ?? "not yet"}` : "not connected"} | can offer now: ${offerable.includes(c.id) ? "yes" : "no"}`).join("\n");

  const eventBlock = events.size ? [...events].map(([k, e]) => `${k} | ${eventDateWords(e.date, e.precision)} | ${e.label} | ${oneLine(e.fact.claim)}${factKey.get(e.factId) ? ` [${factKey.get(e.factId)}]` : ""}`).join("\n") : "- (no dated events in the next 60 days)";
  // The idea bank (plan 1.3.0): the model's view, and the digest's — the bank with the plan's own unanswered effects
  // undone (rewindForDigest), so a plan never changes the next one's input on its own.
  const ownPendingIds = new Set(decisions90.filter(ownPending).map((d) => d.id));
  const pillarsAll = brief?.display?.contentPillars ?? [];
  const pillarSince = new Date(now.getTime() - IDEA_BANK.PILLAR_LOOKBACK_DAYS * DAY).toISOString();
  const postActions = decisions90.filter((d) => d.skillId === PLAN_SKILL_ID && (d.kind ?? "other") === "action" && d.response !== "expired" && d.createdAt >= pillarSince
    && (d.detail as Partial<ActionDecisionDetail> | undefined)?.kind === "post");
  // The live view offers again an idea one of the plan's own pending actions holds (the plan may reword or replace that
  // action: apply.ts lets a new action take an idea from one this run expires); the digest also undoes every skip a
  // plan run made (the row carries skippedByRunId).
  const bankViewOf = (forDigest: boolean) => {
    const rows = forDigest ? rewindForDigest(bank, ownPendingIds) : reclaimForPlan(bank, ownPendingIds);
    const shown = shownMoments(momentDecisions, events, PLAN.CAPS.moments, spentMomentIds(rows));
    const pillars = planPillars(pillarsAll, forDigest ? postActions.filter((d) => !ownPending(d)) : postActions, keysOf);
    const view = planBank(rows, { today, events, shownMomentIds: shown.map((m) => m.decisionId), pillars: pillars.pillars });
    return { shown, pillars, view };
  };
  const views = { live: bankViewOf(false), digest: bankViewOf(true) };
  const orNone = (lines: string[], none = "- (none)") => (lines.length ? lines.join("\n") : none);
  const playbookBlock = orNone(playbookLines(playbook));
  const threadBlock = threads.size ? [...threads].map(([k, t]) => `${k} | ${oneLine(t.brand)} | ${oneLine(t.line)}${t.since ? ` | waiting since ${t.since.slice(0, 10)}` : ""}`).join("\n") : "- (none waiting on the athlete)";
  const factBlock = keyedFacts.length ? keyedFacts.map((f) => `${factKey.get(f.id)} | ${f.type}${f.status === "disputed" ? " (disputed)" : ""}${f.sensitive ? ` (care${f.careKind === "conduct" ? ": conduct" : ""})` : ""} | ${f.subject.kind}: ${oneLine(f.subject.name)} | ${oneLine(f.claim)} | date ${f.date ?? "-"}`).join("\n") : "- (none)";
  const hasMeasured = facts.some((f) => f.type === "measured" && f.status === "active");

  const bodyOf = (forDigest: boolean) => {
    const v = forDigest ? views.digest : views.live;
    return [
      `ATHLETE: ${athleteName || "(name not given)"}`,
      `AGE BAND (self-declared): ${ageBandFrom(facts) ?? "not told"}`,
      `MEASURED DATA FROM CONNECTED ACCOUNTS: ${hasMeasured ? "yes" : "none yet"}`,
      ...(opts.reason && !forDigest ? [`WHY THIS RUN: ${oneLine(opts.reason)}`] : []),
      ``, `BRIEF`, briefBlock,
      ``, `M.I.A. (the only source of strengths, constraints and missing data)`, miaBlock,
      ``, `WHERE THE ATHLETE WANTS TO START`, ...(intent.length ? intent : ["- (not said)"]),
      ``, `GOALS`, goalBlockOf(forDigest),
      ``, `DECISIONS AND OUTCOMES (last 60 days, newest first)`, decisionBlockOf(forDigest),
      ``, `PREFERENCES AND AVOID-LIST`, prefBlock,
      ``, `CONNECTED ACCOUNTS`, connBlock,
      ``, `DATED EVENTS (next 60 days)`, eventBlock,
      ``, `MOMENTS (candidate posts from the weekly moments scan, best first, under their event's E-key)`,
      orNone(v.shown.map((m) => momentLine(m, v.view.momentKeys.get(m.decisionId) ?? null)), "- (no candidate posts for the events above)"),
      ``, `CONTENT PILLARS (themes the athlete can always post about; last post = the newest post action that served it)`, orNone(v.pillars.lines),
      ``, `IDEA BANK (ideas on file, not used yet: reuse before inventing)`, orNone(v.view.bankLines),
      ``, `MISSED IDEAS (timely ideas whose moment went before they were used: adaptable to a later event)`, orNone(v.view.missedLines),
      ``, `PLAYBOOK (research-based best practice for athletes at this sport and stage, per platform: our recommendation)`, playbookBlock,
      ``, `POSTING PACE (what the athlete actually posts now, from their connected accounts)`, orNone(postingPaceLines(facts, postingFormats), "- (no measured posting data yet)"),
      ``, `RATES (the athlete's suggested rate ranges: private; read a goal's money value from these)`, orNone(rateLines(rates), "- (no suggested rates yet)"),
      ``, whatWorksHeading(whatWorks), orNone(whatWorksBlockLines(whatWorks, forDigest)),
      ``, `POST KIT LIMITS (what a post kit can build)`, postKitLimitLines().join("\n"),
      ``, `OPEN THREADS WAITING ON THE ATHLETE`, threadBlock,
      ``, `FACTS`, factBlock,
    ].join("\n");
  };
  const input = `TODAY: ${today}\n${bodyOf(false)}`;
  // The week stands in for the day; why this run and what the plan itself wrote are left out (see ownPending).
  const digest = createHash("sha256").update(`WEEK: ${weekOf(today)}\n${bodyOf(true)}`).digest("hex");

  return {
    input, digest, brief, athleteName,
    evidence: keyedFacts.map((f) => ({ kind: "fact" as const, factId: f.id })),
    check: {
      today, facts: factsByKey, events, threads, goals: goalsAll, decisions: decisions90,
      offerableConnectors: offerable, connectorIds: CONNECTORS.map((c) => c.id), neverTerms, avoid,
      conflicts, hasMeasured,
      bank: {
        on: true, ideas: views.live.view.ideas, missed: views.live.view.missed, pillars: views.live.pillars.pillars,
        momentByFact: new Map(momentDecisions.flatMap((d) => {
          const factId = (d.detail as { factId?: unknown } | undefined)?.factId;
          return isMomentDecision(d) && typeof factId === "string" ? [[factId, d.id] as const] : [];
        })),
      },
    },
  };
}
