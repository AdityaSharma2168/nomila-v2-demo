/**
 * agent/research/understand.ts — the UNDERSTAND skill: read the facts and write the Brief. No web search (understand
 * 1.11.0): what is coming up is the one moments store (agent/moments), already in the facts as dated event facts, which
 * the input lists apart under DATED MOMENTS so the timing section cites them like any other fact.
 *
 * The model judges (jobs/understand.md); code does plumbing and safety:
 *   - facts go in with short keys (f1…), never ids; the brief's refs are mapped back to fact ids, unknown keys dropped;
 *   - care facts (public but delicate) are given to the model marked (care) (a found one "(care · unconfirmed report)", principle 9), to use respectfully; nothing meant for content
 *     can rest on one;
 *   - the athlete's held goals, when any exist, go in under GOALS (absent on a first Brief): the content direction's
 *     so-what may rest on them;
 *   - the content pillars (understand 1.11.0: 2–4 themes chosen from the facts) are kept only with a real fact behind
 *     each and no score in them, at most four, stored with the display fields;
 *   - a "fact" line with no valid ref is downgraded to an inference (no unsupported claim is shown as fact), and a
 *     line that shows a score is dropped (the M.I.A. is the only score; the Brief never scores or rates);
 *   - the stage and the positioning are stored as returned (memory_briefs.display) beside the flattened sections;
 *   - on a research refresh (understand 1.12.0) the current Brief goes in as CURRENT BRIEF, and the facts it did not rest
 *     on are marked NEW. Its strategy — thesis, positioning, content pillars, narrative — is CARRIED FORWARD into the new
 *     Brief whatever the model returns: when the model says the facts materially changed it (carry_forward, resting on
 *     at least one NEW fact) and its new strategy differs, the new strategy comes back as a PROPOSAL the athlete answers
 *     (agent/researchRefresh/proposal.ts); nothing in her strategy changes until she taps. The other sections refresh.
 *   - the internal read (sponsors, current kept apart from past; exclusivity and category conflicts, each with what it
 *     blocks and the facts it rests on) is stored apart. No athlete route returns it whole: the Scouting report shows a
 *     conflict's words and the plan's pitch check reads what it blocks. A conflict with no real fact behind it, or one
 *     that carries a score, is dropped.
 *   - understand 1.13.0: the Brief is the ONE place that decides her suggested rate ranges. It reads her own agreed,
 *     accepted or signed deals in Nomila (NOMILA DEALS, agent/research/nomilaDeals.ts; the skill weighs them by how
 *     many there are) and returns `rate_ranges`; code keeps a range only with a known rate type, a positive low ≤ high
 *     and at least one driver (refs mapped like every other ref, unknown keys dropped; confidence "low" without measured
 *     facts), keeps them on the internal read, and stores them as her suggested rates (services/rates.ts
 *     saveBriefRanges, source "brief": Your rates, the deal Money line and the onboarding card read them). Her deal fees
 *     are private: a sentence naming one is removed from the thesis, positioning, content pillars and narrative.
 *   - understand 1.13.0: her saved preferences (memory_preferences, read as the plan reads them) go in under PREFERENCES,
 *     with her never-use names; a sentence quoting a never-use name is removed from everything she reads.
 *   - understand 1.15.0: how the athlete's own posts did against their usual (agent/learning, WHAT WORKS FOR THIS ATHLETE) goes in
 *     when a line rests on 3 or more posts; it informs the content direction only, never the positioning.
 *   - understand 1.16.0: the formats the athlete's active playbook recommends on each platform they are on (PLAYBOOK
 *     FORMATS, agent/playbook/read.ts playbookFormatsForAthlete) go in when there are any, so `rate_ranges` prices
 *     each format she is told to post (a Reel and a story, not only a feed post).
 */
import { isAboutAthlete, type AgeBand, type Goal, type MemoryFact, type Preference } from "../../../shared/agent";
import { neverTermsFrom } from "../neverTerms";
import { findNeverContent } from "../policy";
import type { AthleteIdentity, JobContext } from "./research";
import { runSkill } from "./runSkill";
import { BRIEF_SECTION_KEYS, MATERIAL_CHANGE_KINDS, STAGE_BANDS, UNDERSTAND_SCHEMA, type StageBand } from "./schemas";
import type { BriefDisplay, BriefInternal, BriefLine, BriefProposalDraft, BriefStrategy, ContentPillar, ExclusivityConflict, StoredBrief, StoredBriefSection } from "./store";
import { cleanClaim } from "../factHygiene";
import { isEventFact, notEnded } from "../moments/facts";
import { isRateType, type RateType } from "../../../shared/deals";
import type { BriefRateRange } from "./store";
import { nomilaDealsBlock, type NomilaDeal } from "./nomilaDeals";
import { whatWorksHeading, whatWorksLines, type WhatWorks } from "../learning/core";
import { createLogger } from "../../logger";

const logger = createLogger("agent/understand");

/** Stores the Brief's ranges as her suggested rates (default: services/rates.ts saveBriefRanges). */
export type SaveRateRanges = (athleteId: string, ranges: BriefRateRange[], meta: { runId: string }) => Promise<{ saved: RateType[]; removed?: RateType[] }>;

const defaultSaveRateRanges: SaveRateRanges = async (athleteId, ranges, meta) => {
  const { saveBriefRanges } = await import("../../services/rates");
  return saveBriefRanges(athleteId, ranges, { runId: meta.runId });
};

export interface BriefStage {
  label: string;
  band: StageBand;
  confidence: number;
  why: string;
  factIds: string[];
}

export interface UnderstandResult {
  runId: string;
  brief: StoredBrief;
  stage: BriefStage;
  /** The content pillars kept (understand 1.11.0). */
  contentPillars: ContentPillar[];
  /** Pillars the model returned that code dropped (no real fact behind it, no name, a score in it, or past four). */
  droppedPillars: number;
  downgraded: number;
  droppedLines: number;
  /** Sponsors the model listed for the athlete that rest only on facts about others (dropped from the internal read). */
  othersSponsors: number;
  costMicroUsd: number;
  /** A refresh only (understand 1.12.0): the current Brief's strategy was carried forward. */
  carried?: boolean;
  /** A refresh only: the strategy change the facts call for, for the athlete to answer; null when none. */
  proposal?: BriefProposalDraft | null;
  /** understand 1.13.0: the suggested rate ranges kept, and how many the model returned that code dropped. */
  rateRanges: BriefRateRange[];
  droppedRanges: number;
  /** The rate types stored as her suggested rates; null when the store failed (the Brief stands either way). */
  rateRangesSaved: RateType[] | null;
  /** Sentences removed from public text because they named one of her private deal fees. */
  feeRedactions: number;
  /** Sentences removed from text she reads because they named one of her never-use names. */
  neverRedactions: number;
}

/**
 * Fact keys ("f12") the model leaked into prose — and context keys ("c3"), which Briefs before 1.11.0 used: removed,
 * with any brackets left empty. Inline markdown citations ("([site](url))") go too: a Brief line's sources are its refs,
 * never a link in its text.
 */
export function stripKeys(text: string): string {
  return cleanClaim(text)
    .replace(/\s*[(\[]\s*(?:[fc]\d+\s*(?:,|and)?\s*)+[)\]]/g, "")
    .replace(/\b(?:[fc]\d+)'s\s+/g, "the ")
    .replace(/\b[fc]\d+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** A shown line must not carry a score (the M.I.A. is the only score, and the Brief never gives one). Exported for the eval's copy grader. */
export const SHOWS_SCORE = /\b(score[sd]?|rating|rated)\b[^.]*\d|\b\d+(\.\d+)?\s*\/\s*10\b/i;

/** At most this many content pillars are kept (the skill asks for 2–4). */
export const MAX_CONTENT_PILLARS = 4;

const factLine = (key: string, f: MemoryFact, isNew = false) =>
  `${key}${isNew ? " (NEW)" : ""} | ${f.type}${f.status === "disputed" ? " (DISPUTED)" : ""}${f.sensitive ? (f.type === "found" ? " (care · unconfirmed report)" : " (care)") : ""} | ${f.subject.kind}: ${f.subject.name} | ${f.claim} | date ${f.date ?? "-"} | conf ${f.confidence} | source ${f.source.title ?? f.source.url ?? f.source.ref ?? "-"}`;

const SECTION_TITLES: Record<string, string> = {
  thesis: "The big idea", stage: "Career stage", positioning: "Positioning", brand_now_next: "Brand: now → next",
  commercial_readiness: "Commercial readiness", rate_logic: "Rate logic",
  context_timing: "Timing and tentpoles", content_direction: "Content: today → direction", risks_upside: "Biggest risk and biggest upside", could_not_confirm: "What I couldn't confirm",
  refresh_cadence: "Refresh cadence",
};

/** Facts the brief may rest on: active or disputed, never removed. Care facts included (marked). */
export function briefableFacts(facts: MemoryFact[]): MemoryFact[] {
  return facts.filter((f) => f.status === "active" || f.status === "disputed");
}

/**
 * The keys of the dated moments among the keyed facts that have not ended by today (a month-only moment stays listed
 * through its month), soonest first: the timing section's input.
 */
export function datedMomentKeys(keyed: ReadonlyMap<string, MemoryFact>, today: string): string[] {
  return [...keyed].filter(([, f]) => isEventFact(f) && notEnded(f, today))
    .sort(([, a], [, b]) => a.date!.localeCompare(b.date!)).map(([k]) => k);
}

const oneLine = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const precisionWords = (f: MemoryFact) => (f.datePrecision === "month" ? " (month only)" : f.datePrecision === "year" ? " (year only)" : "");

export async function understand(ctx: JobContext, opts: {
  athlete: AthleteIdentity; facts: MemoryFact[]; gaps: string[]; ageBand: AgeBand | null;
  /** The athlete's goals; only active ones are read. Absent (or none) on a first Brief. */
  goals?: Goal[];
  /** A research refresh (understand 1.12.0): the Brief she already has, carried forward. Absent on a first Brief. */
  carry?: StoredBrief | null;
  /** understand 1.13.0: her own agreed, accepted or signed deals in Nomila (nomilaDeals.ts loadNomilaDeals). */
  nomilaDeals?: NomilaDeal[];
  /** understand 1.13.0: her saved preferences (memory listPreferences, as the plan reads them); only active ones are read. */
  preferences?: Preference[];
  /** Where the ranges are stored (default: services/rates.ts saveBriefRanges). */
  saveRateRanges?: SaveRateRanges;
  /**
   * understand 1.14.0, rates carry forward: on a refresh, the ranges she already has (CURRENT RATES). Absent, they are
   * read from the current Brief's internal read; never read on a first Brief.
   */
  currentRates?: BriefRateRange[];
  /**
   * understand 1.15.0: the athlete's "what works for you" (agent/learning/db.ts whatWorksIfOn). It informs the content
   * direction only. Absent, null or with no line resting on 3 or more posts, the block is left out.
   */
  whatWorks?: WhatWorks | null;
  /**
   * understand 1.16.0: the post formats the athlete's active playbook recommends, per platform they are on
   * (agent/playbook/read.ts playbookFormatsForAthlete). Absent or empty, the block is left out.
   */
  playbookFormats?: ReadonlyArray<{ platform: string; formats: readonly string[] }> | null;
}): Promise<UnderstandResult> {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const usable = briefableFacts(opts.facts);
  const keyed = new Map<string, MemoryFact>(usable.map((f, n) => [`f${n + 1}`, f]));
  const carry = opts.carry ?? null;
  const isNew = (f: MemoryFact) => !!carry && isNewSince(f, carry);
  const moments = datedMomentKeys(keyed, today).map((k) => [k, keyed.get(k)!] as const);
  const goals = (opts.goals ?? []).filter((g) => g.status === "active");
  const nomilaDeals = opts.nomilaDeals ?? [];
  const preferences = (opts.preferences ?? []).filter((p) => p.status === "active");
  const neverTerms = neverTermsFrom(preferences);
  const hasMeasured = usable.some((f) => f.type === "measured" && f.status === "active");
  // understand 1.14.0: on a refresh, the ranges she already has carry forward unless a new fact moves them.
  const currentRates: BriefRateRange[] = carry
    ? opts.currentRates ?? (await ctx.store.currentBriefInternal(ctx.athleteId).catch(() => null))?.rateRanges ?? []
    : [];
  const saveRanges = async (ranges: BriefRateRange[], runId: string): Promise<RateType[] | null> => {
    if (!ranges.length) return [];
    try {
      return (await (opts.saveRateRanges ?? defaultSaveRateRanges)(ctx.athleteId, ranges, { runId })).saved;
    } catch (err: any) {
      // The Brief stands: a failed store only means her suggested rates are not refreshed this time.
      logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "understand: rate ranges not stored");
      return null;
    }
  };
  const input = [
    `ATHLETE: ${opts.athlete.name} (${opts.athlete.sport})`,
    `AGE BAND (self-declared): ${opts.ageBand ?? "not told yet"}`,
    `TODAY: ${today}`,
    ``,
    `FACTS`,
    ...(keyed.size ? [...keyed].map(([k, f]) => factLine(k, f, isNew(f))) : ["- (no facts found)"]),
    ``,
    `DATED MOMENTS (event facts above, today or later, soonest first)`,
    ...(moments.length ? moments.map(([k, f]) => `- ${k} | ${f.date}${precisionWords(f)} | ${oneLine(f.subject.name)}`) : ["- (none in the facts yet)"]),
    ``,
    `GOALS (held by the athlete)`,
    ...(goals.length ? goals.map((g, n) => `G${n + 1} | ${oneLine(g.text)} | domain ${g.domain ?? "-"} | horizon ${g.horizon ?? "-"}`) : ["- (none yet)"]),
    ``,
    `RESEARCH GAPS (could not find)`,
    ...(opts.gaps.length ? opts.gaps.map((g) => `- ${g}`) : ["- (none listed)"]),
    ``,
    ...preferencesBlock(preferences),
    ``,
    ...nomilaDealsBlock(nomilaDeals),
    ...(carry ? ["", ...currentBriefBlock(carry), "", ...currentRatesBlock(currentRates)] : []),
    ...whatWorksBlock(opts.whatWorks),
    ...playbookFormatsBlock(opts.playbookFormats),
  ].join("\n");

  // No web search: the skill lists no tools (understand 1.11.0), and code offers none.
  const r = await runSkill({
    store: ctx.store, athleteId: ctx.athleteId, skillId: "understand", trigger: "event",
    parentRef: ctx.parentPrefix ? `${ctx.parentPrefix}:understand` : null,
    input, schemaName: "understand_brief", schema: UNDERSTAND_SCHEMA,
    maxOutputTokens: 24_000, budget: ctx.budget,
    evidenceRead: usable.map((f) => ({ kind: "fact" as const, factId: f.id })),
  });
  // Her deal fees are private (never in public text: thesis, positioning, pillars, narrative), and a never-use name is
  // never quoted in anything she reads: the sentences naming one go before anything is built.
  const fees = nomilaDeals.flatMap((d) => (d.fee ? [d.fee.amount] : []));
  const guarded = redactPublic(r.json ?? {}, { fees, neverTerms });
  const j = guarded.json;
  const feeRedactions = guarded.fees;
  const neverRedactions = guarded.never;

  // A retried step: the brief this run wrote is the current one.
  // (On a refresh the proposal is stored by the step that wrote this brief, keyed by this run: agent/researchRefresh.)
  if (r.reused) {
    const brief = await ctx.store.currentBrief(ctx.athleteId);
    if (brief && brief.runId === r.runId) {
      const stageSec = brief.sections.find((s) => s.key === "stage");
      // The ranges this run decided are stored again (idempotent): a retry after a failed store still lands them.
      const rateRanges = (await ctx.store.currentBriefInternal(ctx.athleteId))?.rateRanges ?? [];
      const rateRangesSaved = await saveRanges(rateRanges, r.runId);
      return {
        runId: r.runId, brief, stage: stageFrom(j.stage, () => stageSec?.factIds ?? []), contentPillars: brief.display?.contentPillars ?? [],
        droppedPillars: 0, downgraded: 0, droppedLines: 0, othersSponsors: 0, costMicroUsd: 0, ...(carry ? { carried: true, proposal: null } : {}),
        rateRanges, droppedRanges: 0, rateRangesSaved, feeRedactions: 0, neverRedactions: 0,
      };
    }
  }

  const ids = (refs: unknown): string[] => [...new Set((Array.isArray(refs) ? refs : []).map(String).map((k) => keyed.get(k)?.id).filter((x): x is string => !!x))];
  let downgraded = 0;
  let droppedLines = 0;
  const lines = (raw: unknown): BriefLine[] => {
    const out: BriefLine[] = [];
    for (const l of Array.isArray(raw) ? raw : []) {
      const text = typeof l?.text === "string" ? stripKeys(l.text) : "";
      if (!text) continue;
      // No score in a shown line: the M.I.A. is the only score (care facts are allowed: handled by the skill, respectfully).
      if (SHOWS_SCORE.test(text)) { droppedLines++; continue; }
      const factIds = ids(l.refs);
      let kind: BriefLine["kind"] = l.kind === "fact" ? "fact" : "inference";
      if (kind === "fact" && !factIds.length) { kind = "inference"; downgraded++; }
      out.push({ text, kind, factIds });
    }
    return out;
  };
  const section = (key: string, ls: BriefLine[], soWhat?: string): StoredBriefSection => {
    const factIds = [...new Set(ls.flatMap((l) => l.factIds))];
    const text = [...ls.map((l) => l.text), ...(soWhat ? [`So what: ${soWhat}`] : [])].join("\n");
    return { key, title: SECTION_TITLES[key] ?? key, text, factIds, lines: ls, ...(soWhat ? { soWhat: stripKeys(soWhat) } : {}) };
  };

  const stage = stageFrom(j.stage, () => ids(j.stage?.refs));
  const sections: StoredBriefSection[] = [];
  sections.push(section("thesis", lines([
    { text: String(j.thesis?.big_idea ?? ""), kind: "inference", refs: [] },
    { text: String(j.thesis?.verdict ?? ""), kind: "inference", refs: [] },
  ])));
  sections.push(section("stage", lines([{ text: `${stage.label}${stage.why ? ` — ${stage.why}` : ""}`, kind: "inference", refs: j.stage?.refs }])));
  const p = j.positioning ?? {};
  sections.push(section("positioning", lines([
    { text: `From: ${p.from ?? ""}`, kind: "inference", refs: p.refs },
    { text: `To: ${p.to ?? ""}`, kind: "inference", refs: p.refs },
    { text: String(p.statement ?? ""), kind: "inference", refs: p.refs },
    ...(Array.isArray(p.pillars) ? p.pillars : []).slice(0, 3).map((x: any) => ({ text: `${x?.name ?? ""}: ${x?.line ?? ""}`, kind: "inference", refs: x?.refs })),
  ])));
  const rawSections = Array.isArray(j.sections) ? j.sections : [];
  for (const key of BRIEF_SECTION_KEYS) {
    const s = rawSections.find((x: any) => x?.key === key);
    if (s) sections.push(section(key, lines(s.lines), typeof s.so_what === "string" && !SHOWS_SCORE.test(s.so_what) ? s.so_what : undefined));
  }

  const internalRaw = j.internal ?? {};
  // Code guard: a sponsor resting only on facts about someone else (a team, school or club's sponsor, a teammate's
  // deal) is never listed as the athlete's own, current or past — that knowledge stays on the organization's facts.
  const factById = new Map([...keyed.values()].filter(Boolean).map((f) => [f.id, f]));
  let othersSponsors = 0;
  const sponsors = (raw: unknown) => (Array.isArray(raw) ? raw : []).map((s: any) => {
    const factIds = ids(s?.refs);
    const since = statedSince(s?.since, factIds.map((id) => factById.get(id)).filter((f): f is MemoryFact => !!f));
    return { name: String(s?.name ?? ""), factIds, ...(since ? { since } : {}) };
  })
    .filter((s) => {
      const facts = s.factIds.map((id) => factById.get(id)).filter((f): f is MemoryFact => !!f);
      const othersOnly = facts.length > 0 && facts.every((f) => !isAboutAthlete(f.subject, opts.athlete.name));
      if (othersOnly) othersSponsors++;
      return !othersOnly;
    });
  const ranges = rateRangesFrom(j.rate_ranges, ids, { hasMeasured });
  const internal: BriefInternal & { narrative: string } = {
    currentSponsors: sponsors(internalRaw.current_sponsors),
    pastSponsors: sponsors(internalRaw.past_sponsors),
    exclusivityConflicts: conflictsFrom(internalRaw.exclusivity_conflicts, ids),
    ...(ranges.kept.length ? { rateRanges: ranges.kept } : {}),
    narrative: String(j.narrative ?? ""),
  };
  const pillars = pillarsFrom(j.content_pillars, ids, (id) => !!factById.get(id)?.sensitive);
  const display: BriefDisplay = { ...displayFrom(stage, p, ids), contentPillars: pillars.kept };

  const freshSummary = stripKeys(String(j.narrative ?? "")) || [j.thesis?.big_idea, j.thesis?.verdict].filter(Boolean).join(" ") || "Not enough evidence yet for a brief.";

  // A refresh: the strategy she has is carried forward; a material change becomes a proposal, never an edit.
  let written = { sections, display, summary: freshSummary, narrative: internal.narrative };
  let proposal: BriefProposalDraft | null = null;
  if (carry) {
    // Her answer to an earlier suggestion (Update / Edit it) may have landed while the model ran: carry the Brief she
    // has NOW, so a refresh never writes over a choice she just made.
    const latest = await ctx.store.currentBrief(ctx.athleteId);
    const base = latest && latest.id !== carry.id ? latest : carry;
    const before = strategyOf(base);
    const after: BriefStrategy = {
      thesis: sections.find((s) => s.key === "thesis") ?? null, positioningSection: sections.find((s) => s.key === "positioning") ?? null,
      positioning: display.positioning, contentPillars: display.contentPillars ?? [], summary: freshSummary,
    };
    written = withStrategy({ sections, display, summary: freshSummary, narrative: internal.narrative }, before, base.display?.editedByAthlete);
    const cf = j.carry_forward;
    // A material change names at least one of the listed kinds: "material" with no kind is not one.
    const kinds = (Array.isArray(cf?.kinds) ? cf.kinds : []).map(String).filter((k: string) => (MATERIAL_CHANGE_KINDS as readonly string[]).includes(k)).slice(0, 5);
    const newIds = ids(cf?.refs).filter((id) => { const f = factById.get(id); return !!f && isNew(f); });
    const changed = strategyChanges(before, after);
    if (cf?.material_change === true && kinds.length && newIds.length && changed.length) {
      proposal = {
        kinds,
        reason: stripKeys(String(cf.reason ?? "")).slice(0, 600) || "Your research turned up something new that changes how you're positioned.",
        factIds: newIds, before, after, changed,
      };
    }
  }

  const factIds = [...new Set(written.sections.flatMap((s) => s.factIds))];
  const brief = await ctx.store.writeBrief(ctx.athleteId, { summary: written.summary, sections: written.sections, factIds, internal: { ...internal, narrative: written.narrative } as BriefInternal, display: written.display, runId: r.runId });
  // The Brief decides her suggested rates: stored after the Brief is written, never blocking it.
  const rateRangesSaved = await saveRanges(ranges.kept, r.runId);
  return {
    runId: r.runId, brief, stage, contentPillars: written.display.contentPillars ?? [], droppedPillars: pillars.dropped, downgraded, droppedLines, othersSponsors,
    costMicroUsd: r.cost.microUsd, ...(carry ? { carried: true, proposal } : {}),
    rateRanges: ranges.kept, droppedRanges: ranges.dropped, rateRangesSaved, feeRedactions, neverRedactions,
  };
}

// ── carry forward (understand 1.12.0) ───────────────────────────────────────────────────────────────────────────────

/** A fact the current Brief did not rest on and that was written after it: what the refresh found new. */
export function isNewSince(f: Pick<MemoryFact, "id" | "createdAt">, brief: Pick<StoredBrief, "factIds" | "createdAt">): boolean {
  return !brief.factIds.includes(f.id) && Date.parse(f.createdAt) > Date.parse(brief.createdAt);
}

/** The strategy part of a stored Brief. */
export function strategyOf(b: Pick<StoredBrief, "sections" | "display" | "summary">): BriefStrategy {
  return {
    thesis: b.sections.find((s) => s.key === "thesis") ?? null,
    positioningSection: b.sections.find((s) => s.key === "positioning") ?? null,
    positioning: b.display?.positioning ?? null,
    contentPillars: b.display?.contentPillars ?? [],
    summary: b.summary,
  };
}

/**
 * A Brief's parts with the given strategy put in: the thesis and positioning sections replaced in place (or added when
 * absent), the displayed positioning and content pillars, and the summary (the narrative). Everything else — stage,
 * the fact sections, the internal read — is the fresh Brief's. `editedByAthlete` is the marker of the parts she wrote.
 */
export function withStrategy<T extends { sections: StoredBriefSection[]; display: BriefDisplay; summary: string; narrative: string }>(fresh: T, s: BriefStrategy, editedByAthlete?: BriefDisplay["editedByAthlete"]): T {
  const put = (list: StoredBriefSection[], key: string, sec: StoredBriefSection | null) => {
    if (!sec) return list;
    const at = list.findIndex((x) => x.key === key);
    if (at >= 0) { const out = [...list]; out[at] = sec; return out; }
    return key === "thesis" ? [sec, ...list] : [...list, sec];
  };
  const sections = put(put(fresh.sections, "thesis", s.thesis), "positioning", s.positioningSection);
  const { editedByAthlete: _old, ...rest } = fresh.display;
  const display: BriefDisplay = {
    ...rest,
    ...(s.positioning ? { positioning: s.positioning } : {}),
    contentPillars: s.contentPillars,
    ...(editedByAthlete ? { editedByAthlete } : {}),
  };
  return { ...fresh, sections, display, summary: s.summary, narrative: s.summary };
}

const norm = (t: string | null | undefined) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const sectionText = (s: StoredBriefSection | null) => norm(s?.lines?.map((l) => l.text).join(" ") ?? s?.text);

/** Which parts of the strategy differ (whitespace and case ignored). */
export function strategyChanges(a: BriefStrategy, b: BriefStrategy): BriefProposalDraft["changed"] {
  const out: BriefProposalDraft["changed"] = [];
  if (sectionText(a.thesis) !== sectionText(b.thesis)) out.push("thesis");
  const pos = (p: BriefStrategy["positioning"]) => norm([p?.from, p?.to, p?.statement, ...(p?.pillars ?? []).map((x) => `${x.name}: ${x.line}`)].join(" | "));
  if (pos(a.positioning) !== pos(b.positioning)) out.push("positioning");
  const pil = (ps: ContentPillar[]) => norm(ps.map((p) => `${p.name}: ${p.whyThisAthlete}`).join(" | "));
  if (pil(a.contentPillars) !== pil(b.contentPillars)) out.push("pillars");
  if (norm(a.summary) !== norm(b.summary)) out.push("narrative");
  return out;
}

/**
 * The CURRENT RATES block of a refresh's input (understand 1.14.0): the suggested ranges she already has, each with its
 * confidence and drivers, so a refresh carries them forward unless a new fact moves one. Private: model input only.
 */
export function currentRatesBlock(rates: readonly BriefRateRange[]): string[] {
  return [
    `CURRENT RATES (the suggested ranges the athlete already has: return each as it stands unless a NEW fact materially changes it)`,
    ...(rates.length
      ? rates.map((r) => `- ${r.rateType} | ${r.low}-${r.high} ${r.currency} | confidence ${r.confidence} | drivers: ${r.drivers.map(oneLine).join("; ") || "-"}`)
      : ["- (none yet)"]),
  ];
}

/** The CURRENT BRIEF block of a refresh's input: the strategy she has, her own words marked. */
export function currentBriefBlock(b: StoredBrief): string[] {
  const s = strategyOf(b);
  const thesis = s.thesis?.lines?.map((l) => oneLine(l.text)).filter(Boolean) ?? [];
  const p = s.positioning;
  const hers = new Set<string>(b.display?.editedByAthlete?.fields ?? []);
  return [
    `CURRENT BRIEF (the athlete has it; carry it forward unless the facts materially changed — facts marked NEW are what this refresh found)`,
    `- Big idea: ${thesis[0] ?? "-"}`,
    `- Verdict: ${thesis[1] ?? "-"}`,
    `- Positioning from: ${oneLine(p?.from ?? "") || "-"}`,
    `- Positioning to: ${oneLine(p?.to ?? "") || "-"}`,
    `- Positioning statement: ${oneLine(p?.statement ?? "") || "-"}${hers.has("statement") ? " (written by the athlete)" : ""}`,
    ...(p?.pillars ?? []).map((x, i) => `- Positioning pillar ${i + 1}: ${oneLine(x.name)}: ${oneLine(x.line)}`),
    ...s.contentPillars.map((x) => `- Content pillar ${x.key}: ${oneLine(x.name)} — ${oneLine(x.whyThisAthlete)}`),
    `- Narrative: ${oneLine(s.summary) || "-"}`,
  ];
}

/**
 * The content pillars (understand 1.11.0): prose with leaked keys stripped, refs mapped to fact ids, renumbered P1…Pn
 * in the order returned. A pillar is content, and nothing meant for content rests on a care fact: care refs are
 * removed. Dropped: one with no name, no real non-care fact behind it (a pillar with no supporting fact is not a
 * pillar), or a score in it (the M.I.A. is the only score); and any past four.
 */
export function pillarsFrom(raw: unknown, ids: (refs: unknown) => string[], isCare: (factId: string) => boolean = () => false): { kept: ContentPillar[]; dropped: number } {
  const all = Array.isArray(raw) ? raw : [];
  const kept: ContentPillar[] = [];
  for (const x of all) {
    if (kept.length >= MAX_CONTENT_PILLARS) break;
    const name = typeof x?.name === "string" ? stripKeys(x.name).slice(0, 80) : "";
    const why = typeof x?.why_this_athlete === "string" ? stripKeys(x.why_this_athlete).slice(0, 300) : "";
    const factIds = ids(x?.refs).filter((id) => !isCare(id));
    if (!name || !factIds.length || SHOWS_SCORE.test(name) || SHOWS_SCORE.test(why)) continue;
    kept.push({ key: `P${kept.length + 1}`, name, whyThisAthlete: why, factIds });
  }
  return { kept, dropped: all.length - kept.length };
}

/**
 * The exclusivity and category conflicts (understand 1.9.0), for the Scouting report and the plan's pitch check: prose
 * with leaked keys stripped, refs mapped to fact ids. Dropped: one with no words, no real fact behind it, or a score in
 * it (the M.I.A. is the only score). At most eight, each blocking at most six things.
 */
export function conflictsFrom(raw: unknown, ids: (refs: unknown) => string[]): ExclusivityConflict[] {
  const out: ExclusivityConflict[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const what = typeof c?.what === "string" ? stripKeys(c.what) : "";
    const blocks = (Array.isArray(c?.blocks) ? c.blocks : typeof c?.blocks === "string" ? [c.blocks] : [])
      .map((b: unknown) => (typeof b === "string" ? stripKeys(b) : "")).filter((b: string) => b && !SHOWS_SCORE.test(b)).slice(0, 6);
    const factIds = ids(c?.refs);
    if (!what || !blocks.length || !factIds.length || SHOWS_SCORE.test(what)) continue;
    out.push({ what: what.slice(0, 300), blocks: blocks.map((b: string) => b.slice(0, 120)), factIds });
    if (out.length >= 8) break;
  }
  return out;
}

// ── rate ranges (understand 1.13.0) ───────────────────────────────────────────────────────────────────────────────

/** A range above this (whole currency units) is not a suggestion anyone could use: dropped. */
export const MAX_RANGE_HIGH = 10_000_000;

/**
 * The suggested rate ranges (understand 1.13.0), for Your rates, the deal Money line and the onboarding card. Kept only
 * with a known rate type (shared/deals.ts RATE_TYPES), whole positive amounts with low ≤ high (and high at most
 * MAX_RANGE_HIGH), and at least one driver; the first range per rate type wins. Refs map to fact ids like every other
 * ref (unknown keys dropped). Confidence is "low" without measured (connected-account) facts, whatever the model said.
 * Drivers: keys stripped, no score, at most five.
 */
export function rateRangesFrom(raw: unknown, ids: (refs: unknown) => string[], opts: { hasMeasured: boolean }): { kept: BriefRateRange[]; dropped: number } {
  const all = Array.isArray(raw) ? raw : [];
  const kept: BriefRateRange[] = [];
  for (const x of all) {
    const rateType = x?.rate_type;
    const low = Math.round(Number(x?.low));
    const high = Math.round(Number(x?.high));
    if (!isRateType(rateType) || kept.some((k) => k.rateType === rateType)) continue;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > MAX_RANGE_HIGH) continue;
    const drivers = (Array.isArray(x?.drivers) ? x.drivers : [])
      .map((d: unknown) => (typeof d === "string" ? stripKeys(d).slice(0, 120) : "")).filter((d: string) => d && !SHOWS_SCORE.test(d)).slice(0, 5);
    if (!drivers.length) continue;
    const said = ["low", "medium", "high"].includes(x?.confidence) ? (x.confidence as BriefRateRange["confidence"]) : "low";
    const currency = typeof x?.currency === "string" && /^[A-Za-z]{3}$/.test(x.currency.trim()) ? x.currency.trim().toUpperCase() : "USD";
    kept.push({ rateType, low, high, currency, confidence: opts.hasMeasured ? said : "low", drivers, factIds: ids(x?.refs) });
  }
  return { kept, dropped: all.length - kept.length };
}

/** The money amounts a text states ("$1,500", "1500 USD", "$1.5k", "2k dollars"), in whole units. */
export function moneyAmountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /([$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|thousand\b)?\s?(usd\b|dollars?\b|eur\b|gbp\b)?/gi;
  for (const m of text.matchAll(re)) {
    if (!m[1] && !m[3] && !m[4]) continue;     // a bare number (a year, a count) is not money
    const n = parseFloat(m[2].replace(/,/g, "")) * (m[3] ? 1000 : 1);
    if (Number.isFinite(n)) out.push(Math.round(n));
  }
  return out;
}

/** The text without the sentences that name one of these fees. */
export function redactFees(text: string, fees: readonly number[]): { text: string; redacted: number } {
  return redactSentences(text, (s) => moneyAmountsIn(s).some((a) => fees.includes(a)));
}

/** The text without the sentences `bad` flags. */
function redactSentences(text: string, bad: (sentence: string) => boolean): { text: string; redacted: number } {
  if (!text) return { text, redacted: 0 };
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !bad(s));
  return { text: kept.join(" "), redacted: sentences.length - kept.length };
}

const namesNever = (text: string, neverTerms: readonly string[]) => neverTerms.length > 0 && findNeverContent(text, neverTerms).includes("never_term");

/**
 * Two code guards over the model's answer (understand 1.13.0), before anything is built from it. Returns a copy.
 *   - Her deal fees are private: they may shape the ranges and the rate analysis, never text that could be public. A
 *     sentence naming one is removed from the thesis, the positioning (from, to, statement, pillars), the content
 *     pillars and the narrative.
 *   - A never-use name (her "Never use: …" avoid preferences, agent/neverTerms.ts) is never quoted in text she reads: a
 *     sentence naming one is removed from those same parts and from the stage, every section line and so-what, each
 *     conflict's words, each range driver and a refresh's reason.
 */
export function redactPublic(json: any, opts: { fees: readonly number[]; neverTerms: readonly string[] }): { json: any; fees: number; never: number } {
  const { fees, neverTerms } = opts;
  if ((!fees.length && !neverTerms.length) || !json || typeof json !== "object") return { json, fees: 0, never: 0 };
  let feeHits = 0;
  let neverHits = 0;
  const isFee = (s: string) => fees.length > 0 && moneyAmountsIn(s).some((a) => fees.includes(a));
  /** Public text: neither a fee nor a never-use name. */
  const pub = (v: unknown) => {
    if (typeof v !== "string") return v;
    const a = redactSentences(v, (s) => namesNever(s, neverTerms));
    const b = redactSentences(a.text, isFee);
    neverHits += a.redacted; feeHits += b.redacted;
    return b.text;
  };
  /** Text she reads in private (the rate analysis may name a fee): no never-use name. */
  const shown = (v: unknown) => {
    if (typeof v !== "string") return v;
    const a = redactSentences(v, (s) => namesNever(s, neverTerms));
    neverHits += a.redacted;
    return a.text;
  };
  const out = { ...json };
  if (out.thesis) out.thesis = { ...out.thesis, big_idea: pub(out.thesis.big_idea), verdict: pub(out.thesis.verdict) };
  if (out.positioning) {
    const p = out.positioning;
    out.positioning = {
      ...p, from: pub(p.from), to: pub(p.to), statement: pub(p.statement),
      pillars: Array.isArray(p.pillars) ? p.pillars.map((x: any) => ({ ...x, name: pub(x?.name), line: pub(x?.line) })) : p.pillars,
    };
  }
  if (Array.isArray(out.content_pillars)) out.content_pillars = out.content_pillars.map((x: any) => ({ ...x, name: pub(x?.name), why_this_athlete: pub(x?.why_this_athlete) }));
  out.narrative = pub(out.narrative);
  if (neverTerms.length) {
    if (out.stage) out.stage = { ...out.stage, label: shown(out.stage.label), why: shown(out.stage.why) };
    if (Array.isArray(out.sections)) {
      out.sections = out.sections.map((s: any) => ({
        ...s, so_what: shown(s?.so_what),
        lines: Array.isArray(s?.lines) ? s.lines.map((l: any) => ({ ...l, text: shown(l?.text) })) : s?.lines,
      }));
    }
    if (out.internal && Array.isArray(out.internal.exclusivity_conflicts)) {
      out.internal = { ...out.internal, exclusivity_conflicts: out.internal.exclusivity_conflicts.map((c: any) => ({ ...c, what: shown(c?.what) })) };
    }
    if (Array.isArray(out.rate_ranges)) {
      out.rate_ranges = out.rate_ranges.map((x: any) => ({ ...x, drivers: Array.isArray(x?.drivers) ? x.drivers.map(shown).filter((d: unknown) => d) : x?.drivers }));
    }
    if (out.carry_forward && typeof out.carry_forward === "object") out.carry_forward = { ...out.carry_forward, reason: shown(out.carry_forward.reason) };
  }
  return { json: out, fees: feeHits, never: neverHits };
}

/** At most this many WHAT WORKS FOR THIS ATHLETE lines in Understand's input (leading lines kept first). */
export const MAX_WHAT_WORKS = 24;

/**
 * The WHAT WORKS FOR THIS ATHLETE block of Understand's input (understand 1.15.0): the lines resting on 3 or more of the
 * athlete's own posts, each marked "leads" or "early sign". Nothing (not even the heading) when no line qualifies, so a
 * first Brief or an athlete with nothing measured reads exactly as before.
 */
/**
 * The PLAYBOOK FORMATS block of Understand's input (understand 1.16.0): one line per platform she is on, the formats its
 * playbook recommends (`- instagram: carousel, feed, reel, story`). Empty input → no block.
 */
export function playbookFormatsBlock(rows: ReadonlyArray<{ platform: string; formats: readonly string[] }> | null | undefined): string[] {
  const lines = (rows ?? []).filter((r) => r.formats.length).map((r) => `- ${oneLine(r.platform)}: ${r.formats.map(oneLine).join(", ")}`);
  return lines.length ? ["", "PLAYBOOK FORMATS (what Nomila's playbook recommends the athlete posts, per platform they are on)", ...lines] : [];
}

export function whatWorksBlock(w: WhatWorks | null | undefined): string[] {
  const lines = whatWorksLines(w, MAX_WHAT_WORKS);
  return lines.length ? ["", whatWorksHeading(w), ...lines] : [];
}

/** The PREFERENCES block of Understand's input (understand 1.13.0): her active standing directions, as the plan reads them. */
export function preferencesBlock(prefs: readonly Preference[]): string[] {
  const active = prefs.filter((p) => p.status === "active").slice(0, MAX_PREFERENCES);
  const never = neverTermsFrom(active);
  return [
    `PREFERENCES (the athlete's own standing directions)`,
    ...(active.length ? active.map((p) => `- ${p.kind}: ${oneLine(p.statement)}`) : ["- (none)"]),
    ...(never.length ? [`Never use these names anywhere: ${never.join(", ")}`] : []),
  ];
}

/** At most this many preferences go in (the plan's cap). */
export const MAX_PREFERENCES = 30;

/**
 * A partner's start (understand 1.10.0), kept only when it is a real YYYY or YYYY-MM AND its year is written in the claim
 * of a fact the partner rests on — the code guard behind "only when a fact states it, never inferred". Otherwise null.
 */
export function statedSince(raw: unknown, facts: readonly Pick<MemoryFact, "claim">[]): string | null {
  const since = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(since)) return null;
  const year = since.slice(0, 4);
  return facts.some((f) => new RegExp(`\\b${year}\\b`).test(f.claim)) ? since : null;
}

/**
 * The stage and the positioning as Understand returned them, for display (memory_briefs.display): prose with any leaked
 * keys stripped, refs mapped to fact ids, at most three pillars (the skill asks for exactly three).
 */
export function displayFrom(stage: BriefStage, p: any, ids: (refs: unknown) => string[]): BriefDisplay {
  const text = (v: unknown) => (typeof v === "string" ? stripKeys(v) : "");
  return {
    stage: { label: stripKeys(stage.label), band: stage.band, confidence: stage.confidence, why: stripKeys(stage.why), factIds: stage.factIds },
    positioning: {
      from: text(p?.from), to: text(p?.to), statement: text(p?.statement),
      pillars: (Array.isArray(p?.pillars) ? p.pillars : []).slice(0, 3).map((x: any) => ({ name: text(x?.name), line: text(x?.line), factIds: ids(x?.refs) })),
      factIds: ids(p?.refs),
    },
  };
}

function stageFrom(raw: any, factIds: () => string[]): BriefStage {
  const band = (STAGE_BANDS as readonly string[]).includes(raw?.band) ? (raw.band as StageBand) : "unclear";
  return {
    label: String(raw?.label ?? "Unclear"), band, confidence: Math.min(1, Math.max(0, Number(raw?.confidence) || 0)),
    why: String(raw?.why ?? ""), factIds: factIds(),
  };
}
