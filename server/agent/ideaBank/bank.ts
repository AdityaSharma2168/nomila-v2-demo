/**
 * agent/ideaBank/bank.ts — the idea bank (design "Moments → post kits" v2 §6–§7, build step 8): a running stock of post
 * ideas not used yet, which the weekly plan reads before it invents anything.
 *
 * Storage: memory_decisions kind "other", detail.kind "idea" (shared/postKit.ts IdeaBankEntry) — no table, no migration.
 * Three writers, told apart by the row's skill_id:
 *   moments          the weekly moments scan: one entry per moment's candidate post, time-bound to it (mirrorMoment)
 *   post-kit/ideas   the reverse pass: new media → an idea, time-bound to an open moment or evergreen under a pillar
 *   plan             the plan: a fresh evergreen idea it had to invent (used at once), or a missed timely idea adapted
 *                    to a later event
 * Status lives in detail.status: new → used (a post action took it: usedInDecisionId) | skipped (the plan judged it not
 * worth doing, or its moment turned out to be a care moment) | adapted (a missed timely idea re-pointed at a later event;
 * the NEW row carries adaptedFromIdeaId). A post action the plan later drops (expired, never made) hands its idea back:
 * used → new. The row's response is never touched: an idea is not something the athlete answered.
 *
 * Care: an idea whose event fact is a care fact is never read (listBank leaves it out), and the scan skips every idea on
 * a moment it judges care (skipIdeasForMoment), whoever wrote it.
 *
 * Every write to an existing row is conditional on the row being exactly what was read (DecisionPatch.ifUnchanged) and
 * retried on a fresh read, so the scan and the plan never overwrite each other. Filing is idempotent per action: a
 * retried plan apply finds what it already filed (filePostIdea, applyIdeaMoves) and never writes a second row. A missed
 * idea is claimed for adapting with its claimant written into the row (claimForAdapting), so two plan runs racing for it
 * never both adapt it (unless that claimant crashed). A skip made by a plan run carries that run's id (skippedByRunId),
 * which marks it as the plan's own for the digest's rewind.
 *
 * What the plan reads (planBank): I-keys for live (new) ideas — a moment's own entry rides on its MOMENTS line; the rest
 * are the IDEA BANK block, timely and evergreen each with reserved slots — X-keys for missed timely ideas it may adapt,
 * and P-keys for the Brief's content pillars with when each last had a post. The keys are persisted on the plan run
 * (persistBankKeys), so a retry resolves the model's refs against what that run was shown (restoreBankKeys).
 */
import type { Decision, EvidenceRef } from "../../../shared/agent";
import type { ActionDecisionDetail, MomentDecisionDetail, PlanAction, PlanIdeaMove, PlanPillarRef } from "../../../shared/plan";
import { IDEA_STATUSES, POST_FORMATS, type IdeaBankEntry, type IdeaStatus, type PostFormat } from "../../../shared/postKit";
import { createLogger } from "../../logger";
import { MOMENTS_SKILL_ID } from "../moments/config";
import { periodEnd } from "../moments/facts";
import { PLAN_SKILL_ID } from "../plan/config";
import type { PlanBankContext, PlanEvent } from "../plan/validate";
import type { AgentStore, ContentPillar, DecisionPatch } from "../research/store";
import { IDEAS_SKILL_ID } from "../postKit/config";
import { IDEA_BANK } from "./config";

const logger = createLogger("agent/ideaBank");
const DAY = 86_400_000;
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isFormat = (v: unknown): v is PostFormat => typeof v === "string" && (POST_FORMATS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is IdeaStatus => typeof v === "string" && (IDEA_STATUSES as readonly string[]).includes(v);
/** A pillar name as the rotation compares it: case, spacing and punctuation folded. */
export const pillarNameKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A memory_decisions row that is an idea-bank entry, read. */
export interface BankIdea {
  decisionId: string;
  /** Who wrote it: moments, post-kit/ideas or plan. */
  skillId: string;
  entry: IdeaBankEntry;
  /** The event fact a time-bound idea is for: its own fact evidence, else its moment decision's fact. */
  eventFactId: string | null;
  /** Whether its moment decision is still pending; null when it is bound to none. */
  momentPending: boolean | null;
  /** The moment's name, from its decision row, when it has one. */
  momentName: string | null;
  /** The moment's category (shared/plan.ts MOMENT_CATEGORIES), when it has one. */
  momentCategory: string | null;
  /** Why the scan retired its moment (MomentDecisionDetail.retiredWhy), when it did. */
  momentRetiredWhy: string | null;
  /** How many of the athlete's own photos and clips it is built on (the reverse pass's evidence). */
  assets: number;
  createdAt: string;
}

/** The idea-bank entry off a decision's detail (jsonb, read defensively), or null when the row is not a usable idea. */
export function entryOf(detail: Record<string, unknown> | undefined): IdeaBankEntry | null {
  if (!detail || detail.kind !== "idea") return null;
  const d = detail as Partial<IdeaBankEntry>;
  const idea = (d.idea && typeof d.idea === "object" ? d.idea : {}) as Partial<IdeaBankEntry["idea"]>;
  const brief = (d.brief && typeof d.brief === "object" ? d.brief : {}) as Partial<IdeaBankEntry["brief"]>;
  const hook = str(idea.hook);
  // A moment's own entry has no format since moments 1.2.0 (the plan picks it); a format that IS given must be one of ours.
  if (!hook || (idea.format != null && !isFormat(idea.format))) return null;
  const timeBound = d.timeBound === true;
  const pillarName = str(d.pillarName) || null;
  return {
    kind: "idea", timeBound,
    pillarKey: str(d.pillarKey) || null, pillarName,
    momentDecisionId: str(d.momentDecisionId) || null,
    expiresOn: /^\d{4}-\d{2}-\d{2}$/.test(str(d.expiresOn)) ? str(d.expiresOn) : null,
    idea: { hook, format: isFormat(idea.format) ? idea.format : null, platform: str(idea.platform), timing: str(idea.timing) },
    brief: { show: str(brief.show), captionAngle: str(brief.captionAngle), avoid: str(brief.avoid) },
    mediaNeeds: str(d.mediaNeeds),
    status: isStatus(d.status) ? d.status : "new",
    usedInDecisionId: str(d.usedInDecisionId) || null,
    adaptedFromIdeaId: str(d.adaptedFromIdeaId) || null,
    ...(str(d.skippedByRunId) ? { skippedByRunId: str(d.skippedByRunId) } : {}),
    ...(str(d.adaptedFor) ? { adaptedFor: str(d.adaptedFor) } : {}),
    ...(str(d.adaptedAt) ? { adaptedAt: str(d.adaptedAt) } : {}),
  };
}

/** Every word of an idea, for the never-content, care and copy checks. */
export const ideaWords = (e: IdeaBankEntry) => [e.idea.hook, e.idea.platform, e.idea.timing, e.brief.show, e.brief.captionAngle, e.brief.avoid, e.mediaNeeds].join("\n");

/**
 * Every idea-bank entry of the athlete's, any status, oldest first, with what its moment is now. An idea whose event
 * fact is a care fact (sensitive) is left out: a care moment never becomes a post, not even adapted.
 */
export async function listBank(store: AgentStore, athleteId: string): Promise<BankIdea[]> {
  const rows = await store.listDecisions(athleteId, { kinds: ["other"] });
  const moments = new Map(rows.filter((d) => d.detail?.kind === "moment").map((d) => [d.id, d]));
  const read = rows.flatMap((d) => {
    const entry = entryOf(d.detail);
    if (!entry) return [];
    const moment = entry.momentDecisionId ? moments.get(entry.momentDecisionId) : undefined;
    const momentDetail = moment?.detail as Partial<MomentDecisionDetail> | undefined;
    const ownFact = d.evidence.find((e) => e.kind === "fact") as { factId: string } | undefined;
    const idea: BankIdea = {
      decisionId: d.id, skillId: d.skillId, entry,
      eventFactId: entry.timeBound ? ownFact?.factId ?? (typeof momentDetail?.factId === "string" ? momentDetail.factId : null) : null,
      momentPending: entry.momentDecisionId ? moment?.response === "pending" : null,
      momentName: str(momentDetail?.name) || null,
      momentCategory: str(momentDetail?.category) || null,
      momentRetiredWhy: str(momentDetail?.retiredWhy) || null,
      assets: d.evidence.filter((e) => e.kind === "record" && e.table === "media_assets").length,
      createdAt: d.createdAt,
    };
    return [idea];
  });
  const factIds = [...new Set(read.map((b) => b.eventFactId).filter((x): x is string => !!x))];
  const care = new Set((factIds.length ? await store.getFacts(athleteId, factIds) : []).filter((f) => f.sensitive).map((f) => f.id));
  return read.filter((b) => !b.eventFactId || !care.has(b.eventFactId));
}

/** The moments scan's own entry for each moment decision (the newest, if there were ever two). */
export function momentEntries(bank: readonly BankIdea[]): Map<string, BankIdea> {
  const by = new Map<string, BankIdea>();
  for (const b of bank) if (b.skillId === MOMENTS_SKILL_ID && b.entry.momentDecisionId) by.set(b.entry.momentDecisionId, b);
  return by;
}

/** Moment decisions whose own bank entry is spent (used, skipped or adapted): not offered to the plan again. */
export function spentMomentIds(bank: readonly BankIdea[]): Set<string> {
  return new Set([...momentEntries(bank)].filter(([, b]) => b.entry.status !== "new").map(([id]) => id));
}

const asNew = (b: BankIdea): BankIdea => {
  const { skippedByRunId: _skippedBy, adaptedFor: _adaptedFor, adaptedAt: _adaptedAt, ...entry } = b.entry;
  return { ...b, entry: { ...entry, status: "new", usedInDecisionId: null } };
};

/**
 * The bank as the plan sees it this run: an idea used by one of the plan's own pending actions is offered again (the
 * plan may reword or replace that action; apply.ts lets a new action take an idea from one this run expires).
 */
export function reclaimForPlan(bank: readonly BankIdea[], ownPendingActionIds: ReadonlySet<string>): BankIdea[] {
  return bank.map((b) => (b.entry.status === "used" && b.entry.usedInDecisionId && ownPendingActionIds.has(b.entry.usedInDecisionId) ? asNew(b) : b));
}

/**
 * The bank as the plan's digest sees it: what the plan itself did and nobody has acted on yet is undone, so a plan
 * never changes the next one's input on its own (the same rule as agent/plan/input.ts ownPending). Rows the plan wrote
 * are left out; an idea used by one of the plan's own pending actions reads new again; an adapted idea reads as the
 * missed idea it was (only the plan adapts); an idea a plan run skipped (the row carries `skippedByRunId`) reads new
 * again, however long ago — a skip is the plan's own effect, so it never changes a later plan's input on its own. A skip
 * that is not the plan's (a care moment's) carries no run id and stays.
 */
export function rewindForDigest(bank: readonly BankIdea[], ownPendingActionIds: ReadonlySet<string>): BankIdea[] {
  return bank.filter((b) => b.skillId !== PLAN_SKILL_ID).map((b) => {
    const e = b.entry;
    if (e.status === "used" && e.usedInDecisionId && ownPendingActionIds.has(e.usedInDecisionId)) return asNew(b);
    if (e.status === "adapted") return asNew(b);
    if (e.status === "skipped" && e.skippedByRunId) return asNew(b);
    return b;
  });
}

// ─── The plan's view ───────────────────────────────────────────────────────────────────────────────────────────────

/** The Brief's content pillars as the plan reads them: P-keys, and when each last had a post. */
export interface PlanPillars {
  pillars: Map<string, PlanPillarRef>;
  lines: string[];
}

/**
 * The CONTENT PILLARS block: each pillar with why it fits, its facts' keys and the date of its newest post action in the
 * lookback (matched by name: P-keys are renumbered with every Brief). `posts` are the post actions to count — the
 * caller leaves out expired ones, and the plan's own unanswered ones for the digest.
 */
export function planPillars(pillars: readonly ContentPillar[], posts: ReadonlyArray<Pick<Decision, "createdAt" | "detail">>, keysOf: (ids: string[]) => string): PlanPillars {
  const last = new Map<string, string>();
  for (const p of posts) {
    const name = (p.detail as Partial<ActionDecisionDetail> | undefined)?.idea?.pillar?.name;
    if (!name) continue;
    const k = pillarNameKey(name);
    const day = p.createdAt.slice(0, 10);
    if (!last.has(k) || last.get(k)! < day) last.set(k, day);
  }
  const map = new Map<string, PlanPillarRef>();
  const lines = pillars.map((p) => {
    map.set(p.key, { key: p.key, name: p.name });
    const keys = keysOf(p.factIds);
    const when = last.get(pillarNameKey(p.name));
    return `${p.key} | ${oneLine(p.name)} | why: ${oneLine(p.whyThisAthlete) || "-"} | last post: ${when ?? `none in the last ${IDEA_BANK.PILLAR_LOOKBACK_DAYS} days`}${keys ? ` [${keys}]` : ""}`;
  });
  return { pillars: map, lines };
}

/** The ideas the plan is shown, keyed, and the lines that show them. */
export interface PlanBank {
  /** I-keys → live ideas (a moment's own entry first, in MOMENTS order; then the IDEA BANK block's). */
  ideas: Map<string, BankIdea>;
  /** X-keys → missed timely ideas the plan may adapt to a later event. */
  missed: Map<string, BankIdea>;
  /** Moment decision → the I-key of its own entry, for its MOMENTS line. */
  momentKeys: Map<string, string>;
  bankLines: string[];
  missedLines: string[];
}

/** Offered to the plan: new only (an adapted row's moment is gone; its replacement is the new row). */
const live = (e: IdeaBankEntry) => e.status === "new";

/** The idea's pillar, as the current Brief names it: matched by name, else the name it was written under. */
export function pillarOfIdea(e: IdeaBankEntry, pillars: ReadonlyMap<string, PlanPillarRef>): PlanPillarRef | null {
  if (!e.pillarName) return null;
  const k = pillarNameKey(e.pillarName);
  return [...pillars.values()].find((p) => pillarNameKey(p.name) === k) ?? { key: e.pillarKey ?? "", name: e.pillarName };
}

function fromWords(b: BankIdea): string {
  if (b.entry.adaptedFromIdeaId) return "adapted from a missed idea";
  if (b.skillId === MOMENTS_SKILL_ID) return "from the moments scan";
  if (b.skillId === IDEAS_SKILL_ID) return `from the athlete's new photos and clips (${b.assets})`;
  return "from an earlier plan";
}

function ideaLines(head: string, e: IdeaBankEntry): string[] {
  return [
    `${head} | hook: ${oneLine(e.idea.hook)} | ${e.idea.format ?? "format: yours to choose"} on ${oneLine(e.idea.platform) || "-"} | timing: ${oneLine(e.idea.timing) || "-"}`,
    `  brief: show ${oneLine(e.brief.show) || "-"} | caption angle: ${oneLine(e.brief.captionAngle) || "-"} | avoid: ${oneLine(e.brief.avoid) || "-"}`,
    `  media it needs: ${oneLine(e.mediaNeeds) || "-"}`,
  ];
}

/** The slots each kind gets in the IDEA BANK block (a kind that is short gives its spare slots to the other). */
export function bankSlots<T>(timely: readonly T[], evergreen: readonly T[], total: number = IDEA_BANK.BANK_LINES, perKind: number = IDEA_BANK.SLOTS_PER_KIND): { timely: T[]; evergreen: T[] } {
  const t = Math.min(timely.length, Math.max(perKind, total - Math.min(evergreen.length, perKind)));
  const e = Math.min(evergreen.length, total - t);
  return { timely: timely.slice(0, t), evergreen: evergreen.slice(0, e) };
}

/** Why a missed idea may not be adapted: its moment was a partner campaign, or was cancelled or wrong. */
const RETIRED_FOR_GOOD = new Set(["cancelled", "wrong"]);
const adaptable = (b: BankIdea) => b.momentCategory !== "partner_campaign" && !RETIRED_FOR_GOOD.has(b.momentRetiredWhy ?? "");

/**
 * The plan's view of the bank. `shownMomentIds` are the moment decisions on the MOMENTS block, in order: each one's own
 * scan entry takes the first I-keys and rides on that line. Then the IDEA BANK block, at most BANK_LINES with
 * SLOTS_PER_KIND reserved for each kind: the timely ideas whose event the plan sees (an E-key) and whose moment is still
 * pending, soonest first; the evergreen ones, newest first. Missed: new timely ideas whose moment went (expired, or its
 * period ended) in the last MISSED_DAYS, newest first, at most MISSED_LINES — never one from a partner campaign (only a
 * signed deal sources partner content, and a missed campaign window is not re-pointed) or from a moment retired as
 * cancelled or wrong.
 */
export function planBank(bank: readonly BankIdea[], opts: { today: string; events: ReadonlyMap<string, PlanEvent>; shownMomentIds: readonly string[]; pillars: ReadonlyMap<string, PlanPillarRef> }): PlanBank {
  const eventKey = new Map([...opts.events].map(([k, e]) => [e.factId, k]));
  const ideas = new Map<string, BankIdea>();
  const momentKeys = new Map<string, string>();
  const own = momentEntries(bank);
  for (const id of opts.shownMomentIds) {
    const b = own.get(id);
    if (!b || !live(b.entry)) continue;
    const key = `I${ideas.size + 1}`;
    ideas.set(key, b);
    momentKeys.set(id, key);
  }

  const ownIds = new Set([...own.values()].map((b) => b.decisionId));
  const rest = bank.filter((b) => !ownIds.has(b.decisionId) && live(b.entry));
  const timely = rest.filter((b) => b.entry.timeBound && b.eventFactId && eventKey.has(b.eventFactId) && b.momentPending !== false)
    .sort((a, b) => opts.events.get(eventKey.get(a.eventFactId!)!)!.date.localeCompare(opts.events.get(eventKey.get(b.eventFactId!)!)!.date) || a.createdAt.localeCompare(b.createdAt));
  const evergreen = rest.filter((b) => !b.entry.timeBound).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const slots = bankSlots(timely, evergreen);
  const bankLines: string[] = [];
  for (const b of [...slots.timely, ...slots.evergreen]) {
    const key = `I${ideas.size + 1}`;
    ideas.set(key, b);
    let where: string;
    if (b.entry.timeBound) {
      const ek = eventKey.get(b.eventFactId!)!;
      where = `timely | ${ek} ${oneLine(opts.events.get(ek)!.label)}`;
    } else {
      const p = pillarOfIdea(b.entry, opts.pillars);
      const current = !!p && opts.pillars.get(p.key)?.name === p.name;
      where = `evergreen | ${!p ? "no pillar" : current ? `${p.key} ${oneLine(p.name)}` : `${oneLine(p.name)} (a pillar no longer in the Brief)`}`;
    }
    bankLines.push(...ideaLines(`${key} | ${where} | ${fromWords(b)}`, b.entry));
  }

  const since = new Date(Date.parse(`${opts.today}T00:00:00Z`) - IDEA_BANK.MISSED_DAYS * DAY).toISOString().slice(0, 10);
  const missedAll = bank.filter((b) => b.entry.status === "new" && b.entry.timeBound && b.entry.expiresOn && b.entry.expiresOn >= since
    && (b.momentPending === false || b.entry.expiresOn < opts.today) && adaptable(b))
    .sort((a, b) => b.entry.expiresOn!.localeCompare(a.entry.expiresOn!) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, IDEA_BANK.MISSED_LINES);
  const missed = new Map<string, BankIdea>();
  const missedLines: string[] = [];
  for (const b of missedAll) {
    const key = `X${missed.size + 1}`;
    missed.set(key, b);
    missedLines.push(...ideaLines(`${key} | missed: ${oneLine(b.momentName) || "an earlier moment"} (${b.entry.expiresOn})`, b.entry));
  }
  return { ideas, missed, momentKeys, bankLines, missedLines };
}

// ─── The keys, on the run ──────────────────────────────────────────────────────────────────────────────────────────

/** The bank keys a plan run was shown, as stored on its output (agent_runs.output.bankKeys). */
export interface PersistedBankKeys {
  on: boolean;
  ideas: Record<string, string>;
  missed: Record<string, string>;
  pillars: Record<string, PlanPillarRef>;
  momentByFact: Record<string, string>;
}

export function persistBankKeys(b: PlanBankContext): PersistedBankKeys {
  const ids = (m: ReadonlyMap<string, BankIdea>) => Object.fromEntries([...m].map(([k, x]) => [k, x.decisionId]));
  return { on: b.on, ideas: ids(b.ideas), missed: ids(b.missed), pillars: Object.fromEntries(b.pillars), momentByFact: Object.fromEntries(b.momentByFact) };
}

/**
 * The bank keys a run was shown, re-read against the store as it is now (a key whose idea is gone, or became a care
 * idea, drops out): a retried apply resolves the model's refs exactly as that run saw them, never against a rebuilt
 * input whose keys moved.
 */
export async function restoreBankKeys(store: AgentStore, athleteId: string, p: PersistedBankKeys): Promise<PlanBankContext> {
  const byId = new Map((await listBank(store, athleteId)).map((b) => [b.decisionId, b]));
  const ideas = (rec: Record<string, string>) => new Map(Object.entries(rec ?? {}).flatMap(([k, id]) => (byId.has(id) ? [[k, byId.get(id)!] as const] : [])));
  return { on: !!p.on, ideas: ideas(p.ideas), missed: ideas(p.missed), pillars: new Map(Object.entries(p.pillars ?? {})), momentByFact: new Map(Object.entries(p.momentByFact ?? {})) };
}

// ─── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A new bank row. `suggested` is the hook; the row is pending and stays so. */
export async function writeIdea(store: AgentStore, athleteId: string, w: { runId: string | null; skillId: string; entry: IdeaBankEntry; evidence: EvidenceRef[]; why: string }): Promise<Decision> {
  return store.insertDecision(athleteId, {
    runId: w.runId, skillId: w.skillId, kind: "other", suggested: w.entry.idea.hook, why: w.why, evidence: w.evidence,
    detail: w.entry as unknown as Record<string, unknown>,
  });
}

/**
 * Change one bank row: `change` gets the entry as it is now and returns the new one, or null for "no change". Written
 * only while the row is still what was read; a row that moved in between is re-read and `change` asked again. Answers
 * the entry written, or null when nothing was (no such idea, `change` declined, or it kept moving).
 */
export async function patchIdea(
  store: AgentStore, athleteId: string, ideaId: string, change: (e: IdeaBankEntry) => IdeaBankEntry | null,
  extra: Omit<DecisionPatch, "detail" | "ifUnchanged"> = {},
): Promise<IdeaBankEntry | null> {
  for (let i = 0; i < IDEA_BANK.WRITE_ATTEMPTS; i++) {
    const row = await store.getDecision(athleteId, ideaId);
    const cur = row ? entryOf(row.detail) : null;
    if (!row || !cur) return null;
    const next = change(cur);
    if (!next) return null;
    const done = await store.updateDecision(athleteId, ideaId, {
      ...extra, detail: { ...(row.detail ?? {}), ...next } as Record<string, unknown>, ifUnchanged: { detail: row.detail ?? {}, response: row.response },
    });
    if (done) return next;
  }
  logger.warn({ athleteId, ideaId }, "idea bank row kept changing: write given up");
  return null;
}

/**
 * The moments scan's entry for a moment's candidate post: written the first time, refreshed in place while it is still
 * new (same id), and left alone once the plan used, skipped or adapted it. It expires with the end of the moment's
 * period (a month-only moment: the month's last day). Since moments 1.2.0 a moment carries a hook and ONE angle: the
 * entry keeps the hook, files the angle as its caption angle, and leaves the format, platform, timing, what it shows and
 * the media it needs for the plan to pick (a moment from before keeps its own).
 */
export function momentEntryIdea(m: Pick<MomentDecisionDetail, "idea" | "brief" | "mediaNeeds">): Pick<IdeaBankEntry, "idea" | "brief" | "mediaNeeds"> {
  return {
    idea: { hook: str(m.idea?.hook), format: isFormat(m.idea?.format) ? m.idea.format : null, platform: str(m.idea?.platform), timing: str(m.idea?.timing) },
    brief: m.brief ? { show: str(m.brief.show), captionAngle: str(m.brief.captionAngle), avoid: str(m.brief.avoid) } : { show: "", captionAngle: str(m.idea?.angle), avoid: "" },
    mediaNeeds: str(m.mediaNeeds),
  };
}

export async function mirrorMoment(store: AgentStore, athleteId: string, runId: string, momentDecisionId: string, m: MomentDecisionDetail, existing: Decision | undefined): Promise<void> {
  const fresh = (prior: IdeaBankEntry | null): IdeaBankEntry => ({
    kind: "idea", timeBound: true, pillarKey: null, pillarName: null, momentDecisionId, expiresOn: periodEnd(m.date.slice(0, 10), m.datePrecision),
    ...momentEntryIdea(m),
    status: prior?.status ?? "new", usedInDecisionId: prior?.usedInDecisionId ?? null, adaptedFromIdeaId: prior?.adaptedFromIdeaId ?? null,
  });
  const evidence: EvidenceRef[] = [{ kind: "fact", factId: m.factId }];
  if (!existing || !entryOf(existing.detail)) {
    await writeIdea(store, athleteId, { runId, skillId: MOMENTS_SKILL_ID, entry: fresh(null), evidence, why: m.whyNow });
    return;
  }
  await patchIdea(store, athleteId, existing.id, (e) => (e.status === "new" ? fresh(e) : null), { suggested: m.idea.hook, why: m.whyNow, evidence, runId });
}

/**
 * Mark a bank idea skipped (while it is new). `byPlanRunId`: the plan run whose idea move skipped it, kept on the row so
 * the plan's digest can undo it (rewindForDigest); null for a skip that is not the plan's own (a care moment).
 */
export async function skipIdea(store: AgentStore, athleteId: string, ideaId: string, byPlanRunId: string | null): Promise<boolean> {
  return !!(await patchIdea(store, athleteId, ideaId, (e) => (e.status === "new" ? { ...e, status: "skipped", ...(byPlanRunId ? { skippedByRunId: byPlanRunId } : {}) } : null)));
}

/**
 * A moment judged care: every idea still new that rests on it is skipped, whoever wrote it (the scan's own entry, a
 * reverse-pass idea, a plan-adapted row) and whether or not its candidate post was still pending — bound to one of its
 * moment decisions, or citing its event fact. Answers the ideas skipped.
 */
export async function skipIdeasForMoment(store: AgentStore, athleteId: string, factId: string, momentDecisionIds: ReadonlySet<string>): Promise<string[]> {
  const rows = await store.listDecisions(athleteId, { kinds: ["other"] });
  const out: string[] = [];
  for (const d of rows) {
    const e = entryOf(d.detail);
    if (!e || e.status !== "new") continue;
    const onIt = (e.momentDecisionId && momentDecisionIds.has(e.momentDecisionId)) || d.evidence.some((x) => x.kind === "fact" && x.factId === factId);
    if (onIt && (await skipIdea(store, athleteId, d.id, null))) out.push(d.id);
  }
  return out;
}

/** What the plan wrote to the bank (agent_runs.output.applied.ideas). */
export interface BankApplied {
  used: string[];
  written: string[];
  adapted: string[];
  skipped: string[];
  returned: string[];
}

export const emptyBankApplied = (): BankApplied => ({ used: [], written: [], adapted: [], skipped: [], returned: [] });

/** A plan-written row already filed for this action (a retried apply): fresh, or adapted from `fromIdeaId`. */
async function filedFor(store: AgentStore, athleteId: string, actionId: string, fromIdeaId: string | null): Promise<string | null> {
  const rows = await store.listDecisions(athleteId, { kinds: ["other"], skillId: PLAN_SKILL_ID });
  const hit = rows.find((d) => {
    const e = entryOf(d.detail);
    return !!e && e.usedInDecisionId === actionId && e.adaptedFromIdeaId === fromIdeaId;
  });
  return hit?.id ?? null;
}

/** Rows the plan adapted from this idea. */
async function adaptedChildren(store: AgentStore, athleteId: string, ideaId: string): Promise<Decision[]> {
  return (await store.listDecisions(athleteId, { kinds: ["other"], skillId: PLAN_SKILL_ID })).filter((d) => entryOf(d.detail)?.adaptedFromIdeaId === ideaId);
}

/**
 * Whether an adapted row's claim (no child row yet) is still someone's to finish. The claimant is the post action's
 * decision id, or the plan run of an idea move:
 *   - the current run's own claim (its run id, or an action that run wrote): not live to it — a retry finishes it
 *   - a post action: live while that action is still pending (a later plan that expired it frees the idea)
 *   - a run's move: live for CLAIM_LEASE_MS from the claim (a run id says nothing about whether its apply crashed; the
 *     lease is how long an apply can still be writing)
 * A claim with no claimant (made before claims were recorded) is never live.
 */
async function claimLive(store: AgentStore, athleteId: string, e: IdeaBankEntry, runId: string): Promise<boolean> {
  if (!e.adaptedFor || e.adaptedFor === runId) return false;
  const d = await store.getDecision(athleteId, e.adaptedFor);
  if (d) return d.runId !== runId && d.response === "pending";
  return !!e.adaptedAt && Date.now() - Date.parse(e.adaptedAt) < IDEA_BANK.CLAIM_LEASE_MS;
}

/**
 * Claim a missed idea for ONE adaptation, by `claimant` (the post action's decision id, or the plan run of an idea
 * move) in plan run `runId`: new → adapted with adaptedFor = claimant. Refused when a row adapted from it already
 * exists, or another claim on it is live (claimLive). A claim that is not live — this run's own (a retried apply that
 * crashed before writing the new row), or one whose claimant crashed — is taken over.
 *
 * Why the claimant is written: the claim is a conditional write (patchIdea: only over the row as read), and it must
 * CHANGE the row. Were it only adapted → adapted, a second plan run that read the row after the first claimed it would
 * write the same detail over itself, succeed, and adapt the idea a second time. With the claimant in the row, the second
 * run's write either loses the race (the row changed under it) or reads the first claim and declines. A takeover is
 * written only over the exact claim judged not live: a claim that moved meanwhile is read again and refused.
 */
async function claimForAdapting(store: AgentStore, athleteId: string, ideaId: string, claimant: string, runId: string): Promise<IdeaBankEntry | null> {
  if ((await adaptedChildren(store, athleteId, ideaId)).length) return null;
  const cur = entryOf((await store.getDecision(athleteId, ideaId))?.detail);
  if (!cur) return null;
  // The claim that may be taken over (undefined: none may — only a new row can be claimed).
  const takeOver = cur.status === "adapted" && (cur.adaptedFor === claimant || !(await claimLive(store, athleteId, cur, runId)))
    ? cur.adaptedFor ?? null : undefined;
  return patchIdea(store, athleteId, ideaId, (e) => (e.status === "new" || (e.status === "adapted" && takeOver !== undefined && (e.adaptedFor ?? null) === takeOver)
    ? { ...e, status: "adapted", adaptedFor: claimant, adaptedAt: new Date().toISOString() } : null));
}

/**
 * Read just before the child row is written: the claim is still `claimant`'s. A claim can be taken over after it was
 * made (claimLive judged it crashed — say a slow apply passed CLAIM_LEASE_MS); then the new holder writes the child, and
 * this one, seeing the row no longer names it, writes nothing.
 */
async function stillClaimedBy(store: AgentStore, athleteId: string, ideaId: string, claimant: string): Promise<boolean> {
  const e = entryOf((await store.getDecision(athleteId, ideaId))?.detail);
  return e?.status === "adapted" && e.adaptedFor === claimant;
}

/** The new row's entry starts from the missed idea's, without the old row's own claim. */
const adaptedFrom = (old: IdeaBankEntry): IdeaBankEntry => {
  const { adaptedFor: _claim, adaptedAt: _at, ...rest } = old;
  return rest;
};

/**
 * A post action's idea, filed in the bank (the action's decision already exists: `actionId`). bank: the idea is marked
 * used by it — taken from an action this run expires (`reclaimable`) when the plan reworded or replaced it. adapted: the
 * missed idea is claimed (new → adapted) and a new row written for the action's later event, used by it. fresh: a new
 * evergreen row, used by it. Idempotent per action: what is already filed for it (a retried apply) is answered, never
 * written twice. Answers the bank row the action now rests on, or null when nothing could be filed.
 */
export async function filePostIdea(
  store: AgentStore, athleteId: string, runId: string, a: PlanAction, actionId: string, out: BankApplied, reclaimable: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const src = a.source;
  if (!src) return null;
  const timing = a.dueOn ? `by ${a.dueOn}` : "this week";
  if (src.from === "bank") {
    const cur = await store.getDecision(athleteId, src.ideaId!);
    if (entryOf(cur?.detail)?.usedInDecisionId === actionId) return src.ideaId;
    const ok = await patchIdea(store, athleteId, src.ideaId!, (e) => (e.status === "new" || (e.status === "used" && !!e.usedInDecisionId && reclaimable.has(e.usedInDecisionId))
      ? { ...e, status: "used", usedInDecisionId: actionId } : null));
    if (!ok) return null;
    out.used.push(src.ideaId!);
    return src.ideaId;
  }
  if (src.from === "adapted") {
    const already = await filedFor(store, athleteId, actionId, src.ideaId);
    if (already) return already;
    // Adapted already, for another action or a move (or claimed by a concurrent plan run): not this one's to take.
    // Claimed by this action but never written (a retried apply): claimed again, and written now.
    if (!a.event) return null;
    const old = await claimForAdapting(store, athleteId, src.ideaId!, actionId, runId);
    if (!old) return null;
    const p = a.post;
    const entry: IdeaBankEntry = {
      ...adaptedFrom(old), timeBound: true, momentDecisionId: src.momentDecisionId, expiresOn: periodEnd(a.event.date, a.event.precision),
      idea: p ? { hook: p.hook, format: p.format, platform: a.deliverable.platform ?? old.idea.platform, timing } : { ...old.idea, timing },
      brief: p ? { show: p.show, captionAngle: p.captionAngle, avoid: p.avoid } : old.brief, mediaNeeds: p ? p.mediaNeeds : old.mediaNeeds,
      status: "used", usedInDecisionId: actionId, adaptedFromIdeaId: src.ideaId,
    };
    if (!(await stillClaimedBy(store, athleteId, src.ideaId!, actionId))) return null;
    const row = await writeIdea(store, athleteId, { runId, skillId: PLAN_SKILL_ID, entry, evidence: [{ kind: "fact", factId: a.event.factId }], why: `Adapted for ${a.event.label}.` });
    out.adapted.push(src.ideaId!);
    out.written.push(row.id);
    return row.id;
  }
  if (!a.post) return null;
  const already = await filedFor(store, athleteId, actionId, null);
  if (already) return already;
  const entry: IdeaBankEntry = {
    kind: "idea", timeBound: false, pillarKey: src.pillar?.key ?? null, pillarName: src.pillar?.name ?? null, momentDecisionId: null, expiresOn: null,
    idea: { hook: a.post.hook, format: a.post.format, platform: a.deliverable.platform ?? "", timing },
    brief: { show: a.post.show, captionAngle: a.post.captionAngle, avoid: a.post.avoid }, mediaNeeds: a.post.mediaNeeds,
    status: "used", usedInDecisionId: actionId, adaptedFromIdeaId: null,
  };
  const row = await writeIdea(store, athleteId, { runId, skillId: PLAN_SKILL_ID, entry, evidence: a.factIds.map((factId) => ({ kind: "fact" as const, factId })), why: a.why });
  out.written.push(row.id);
  return row.id;
}

/**
 * The plan's skips and adaptations of ideas it did not use this week. An adaptation is idempotent: when a row adapted
 * from the idea already exists (a retried apply), nothing is written again; a missed idea already claimed but whose new
 * row was never written gets it now.
 */
export async function applyIdeaMoves(store: AgentStore, athleteId: string, runId: string, moves: readonly PlanIdeaMove[], out: BankApplied): Promise<void> {
  for (const m of moves) {
    if (m.move === "skip") {
      if (await skipIdea(store, athleteId, m.ideaId, runId)) out.skipped.push(m.ideaId);
      continue;
    }
    if (!m.event) continue;
    const old = await claimForAdapting(store, athleteId, m.ideaId, runId, runId);
    if (!old) continue;
    const entry: IdeaBankEntry = {
      ...adaptedFrom(old), timeBound: true, momentDecisionId: m.momentDecisionId, expiresOn: periodEnd(m.event.date, m.event.precision),
      idea: { ...old.idea, timing: m.timing ?? old.idea.timing }, status: "new", usedInDecisionId: null, adaptedFromIdeaId: m.ideaId,
    };
    if (!(await stillClaimedBy(store, athleteId, m.ideaId, runId))) continue;
    const row = await writeIdea(store, athleteId, { runId, skillId: PLAN_SKILL_ID, entry, evidence: [{ kind: "fact", factId: m.event.factId }], why: m.why || `Adapted for ${m.event.label}.` });
    out.adapted.push(m.ideaId);
    out.written.push(row.id);
  }
}

/** Ideas used by actions the plan just expired go back to the bank (used → new): the post was never made. */
export async function handBackIdeas(store: AgentStore, athleteId: string, expired: ReadonlyArray<Pick<Decision, "id" | "detail">>, out: BankApplied): Promise<void> {
  for (const d of expired) {
    const ideaId = (d.detail as Partial<ActionDecisionDetail> | undefined)?.idea?.ideaId;
    if (!ideaId) continue;
    const back = await patchIdea(store, athleteId, ideaId, (e) => (e.status === "used" && e.usedInDecisionId === d.id ? { ...e, status: "new", usedInDecisionId: null } : null));
    if (back) out.returned.push(ideaId);
  }
}
