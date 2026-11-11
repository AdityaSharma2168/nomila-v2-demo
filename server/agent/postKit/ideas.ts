/**
 * agent/postKit/ideas.ts — the reverse direction (design §10, §6): new or unused media → post ideas in the idea bank.
 *
 *   1. New: the athlete's tagged rows (herPhoto / herClip) whose tags were written after the last pass's cursor, OLDEST
 *      first — a page, never a slice: the cursor moves only past what this pass looked at, so a backlog is worked
 *      through over the following passes, never dropped. Unused: not in any live post kit and not already behind an
 *      idea (an idea's assets are its evidence, `record` media_assets). Judged by the same eligibility as a kit
 *      (kit.ts ineligibleReason): only the athlete's own footage, brand-safe, no never-use name. At most
 *      IDEAS_MAX_ASSETS a pass.
 *   2. Nothing new: no call. New media but none usable: no call either, and a zero-cost "checked" run records the
 *      moved cursor (so the sweep does not come back to the same rows every day). Otherwise, within budget, one
 *      cheap-tier call (skill post-kit/ideas, Gemini Flash): does an asset fit an open moment in the store, or stand on
 *      its own? Most do not, and nothing forces an idea.
 *   3. Each idea is checked (only refs it was shown, each asset in one idea, a valid format, a platform from the
 *      athlete's own, no never-content) and written as memory_decisions kind "other", skill_id post-kit/ideas,
 *      detail.kind "idea" (shared/postKit.ts IdeaBankEntry), status new: time-bound to its moment (expiresOn = the
 *      moment's date) or evergreen — under the content pillar it serves, when the model named one it was shown (the
 *      Brief's content pillars, P1…Pn). A retried pass (same
 *      parentRef) reuses its finished run, reads the answer against what THAT run was shown (its evidence, its recorded
 *      moments and pillars, in order) and writes only the ideas missing for it.
 *
 * The plan reads the bank (agent/ideaBank, build step 8); the athlete never sees a raw idea.
 *
 * The daily sweep (POST /api/internal/post-ideas-cron) runs this for athletes with a current Brief and new tagged media.
 */
import type { MemoryFact, RunTrigger } from "../../../shared/agent";
import { POST_FORMATS, type IdeaBankEntry, type PostFormat } from "../../../shared/postKit";
import type { CastableRow } from "../../studio/agent/cast";
import { capWords } from "../../studio/text";
import { createLogger } from "../../logger";
import { modelFor, ZERO_COST } from "../models";
import { guardrailsFrom } from "../guardrails";
import { CONNECTORS } from "../onboarding/catalog";
import { findNeverContent } from "../policy";
import { CostCapError, runSkill } from "../research/runSkill";
import type { AgentStore } from "../research/store";
import { loadJob } from "../jobs";
import { postKitBudget, shownIds, usedAssetIds, type PostKitDeps, type TagCursor } from "./build";
import { agentPostKitsEnabled, IDEAS_SKILL_ID, POST_KIT } from "./config";
import { candidateInput, ineligibleReason, maxAssetsFor, momentOf, refsInOrder, type MomentRef } from "./kit";
import { notEnded } from "../moments/facts";
import { enabledChoiceSql, jobGate } from "../welcome/gate";

const logger = createLogger("agent/postKit/ideas");
const DAY = 86_400_000;
/** How far back a pass looks for the previous one (a cursor older than this starts the library over; ideas dedupe). */
const PASS_LOOKBACK_DAYS = 365;

export const IDEAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["asset_refs", "moment_ref", "pillar_ref", "hook", "format", "platform", "timing", "show", "caption_angle", "avoid", "media_needs"],
        properties: {
          asset_refs: { type: "array", items: { type: "string" } },
          moment_ref: { type: "string" },
          pillar_ref: { type: "string" },
          hook: { type: "string" }, format: { type: "string", enum: [...POST_FORMATS] }, platform: { type: "string" },
          timing: { type: "string" }, show: { type: "string" }, caption_angle: { type: "string" }, avoid: { type: "string" },
          media_needs: { type: "string" },
        },
      },
    },
  },
};

export interface IdeasDeps extends PostKitDeps {
  /** The athlete's connected accounts (agent/plan/sources.ts dbPlanSources.connected). */
  connected: (athleteId: string) => Promise<Array<{ id: string; lastReadAt: string | null }>>;
}

export type IdeasOutcome =
  | { status: "proposed"; ideas: number; runId: string; costMicroUsd: number }
  | { status: "nothing_new" }
  | { status: "skipped"; reason: "day_cap" | "week_cap" | "week_count" };

/** What a pass leaves on its agent run (agent_runs.output), beside runSkill's own fields. */
interface PassOutput {
  status?: "proposed" | "nothing_new";
  /** Where the next pass starts (the last row this one looked at). */
  cursor?: TagCursor | null;
  /** The moment decisions this pass showed the model, in M-ref order. */
  momentDecisionIds?: string[];
  /** The content pillars this pass showed the model, in P-ref order (none while the idea bank is off). */
  pillars?: IdeaPillar[];
}

/** A content pillar as the reverse pass shows it (the Brief's, P1…Pn). */
export interface IdeaPillar {
  key: string;
  name: string;
}

/** The Brief's content pillars. */
async function pillarsFor(store: AgentStore, athleteId: string): Promise<IdeaPillar[]> {
  const pillars = (await store.currentBrief(athleteId))?.display?.contentPillars ?? [];
  return pillars.map((p) => ({ key: p.key, name: p.name }));
}

/**
 * The last pass: the athlete's latest COMPLETED post-kit/ideas run (a model run or a zero-cost "checked" run) — the
 * one rule both the pass and the sweep read.
 */
export async function lastPass(store: AgentStore, athleteId: string, now: Date): Promise<{ startedAt: string; cursor: TagCursor | null } | null> {
  const runs = await store.listRunsSince(athleteId, { since: new Date(now.getTime() - PASS_LOOKBACK_DAYS * DAY).toISOString(), skillId: IDEAS_SKILL_ID });
  const last = runs.filter((r) => r.status === "completed").sort((a, b) => a.startedAt.localeCompare(b.startedAt)).pop();
  if (!last) return null;
  const cursor = (last.output as PassOutput | null)?.cursor ?? null;
  return { startedAt: last.startedAt, cursor };
}

/** The social platforms an idea may name: the athlete's connected ones, else every social connector. */
export function platformsFor(connected: ReadonlyArray<{ id: string }>): string[] {
  const social = CONNECTORS.filter((c) => c.kind === "social").map((c) => c.id);
  const mine = social.filter((id) => connected.some((c) => c.id === id));
  return mine.length ? mine : social;
}

/** Open moments (pending moment decisions whose period has not ended), soonest first, at most IDEAS_MAX_MOMENTS. */
async function openMoments(deps: PostKitDeps, athleteId: string, today: string): Promise<MomentRef[]> {
  const others = await deps.store.listDecisions(athleteId, { kinds: ["other"], responses: ["pending"] });
  const rows = others.filter((d) => d.detail?.kind === "moment");
  const factIds = rows.flatMap((d) => d.evidence.filter((e) => e.kind === "fact").map((e) => (e as { factId: string }).factId));
  const facts = new Map((await deps.store.getFacts(athleteId, factIds)).map((f: MemoryFact) => [f.id, f]));
  // Open = its period has not ended (a month-only moment stays open through its month: moments/facts.ts notEnded).
  return rows.flatMap((d) => {
    const ev = d.evidence.find((e) => e.kind === "fact") as { factId: string } | undefined;
    const fact = ev ? facts.get(ev.factId) ?? null : null;
    const m = momentOf(d.id, d.detail, fact);
    const open = fact ? notEnded(fact, today) : !!m?.date && m.date.slice(0, 10) >= today;
    return m && m.date && open ? [m] : [];
  })
    .sort((a, b) => a.date!.localeCompare(b.date!)).slice(0, POST_KIT.IDEAS_MAX_MOMENTS);
}

/** Asset ids already behind an idea in the bank (any status). */
async function ideaAssetIds(deps: PostKitDeps, athleteId: string): Promise<Set<string>> {
  const ideas = await deps.store.listDecisions(athleteId, { kinds: ["other"], skillId: IDEAS_SKILL_ID });
  return new Set(ideas.flatMap((d) => d.evidence.filter((e) => e.kind === "record" && e.table === "media_assets").map((e) => (e as { id: string }).id)));
}

/** The model's ideas → bank entries, checked. Exported for tests. */
export function parseIdeas(
  json: unknown, assetRefs: ReadonlyMap<string, CastableRow>, momentRefs: ReadonlyMap<string, MomentRef>,
  platforms: readonly string[], neverTerms: readonly string[], pillars: readonly IdeaPillar[] = [],
): Array<{ entry: IdeaBankEntry; assets: CastableRow[]; moment: MomentRef | null }> {
  const raw = (json && typeof json === "object" ? (json as { ideas?: unknown }).ideas : null);
  const out: Array<{ entry: IdeaBankEntry; assets: CastableRow[]; moment: MomentRef | null }> = [];
  const taken = new Set<string>();
  const line = (v: unknown, max: number) => (typeof v === "string" ? capWords(v, max) : "");
  for (const it of Array.isArray(raw) ? raw : []) {
    if (out.length >= POST_KIT.IDEAS_MAX_PER_PASS) break;
    const i = (it ?? {}) as Record<string, unknown>;
    const format = typeof i.format === "string" && (POST_FORMATS as readonly string[]).includes(i.format) ? (i.format as PostFormat) : null;
    // As many assets as the format holds (a carousel up to MAX_ASSETS, a reel or story VIDEO_MAX_ASSETS, a feed post one).
    const cap = format ? maxAssetsFor(format) : POST_KIT.MAX_ASSETS;
    const assets: CastableRow[] = [];
    for (const r of Array.isArray(i.asset_refs) ? i.asset_refs : []) {
      const row = typeof r === "string" ? assetRefs.get(r.trim().toUpperCase()) : undefined;
      if (row && !taken.has(row.id) && !assets.includes(row) && assets.length < cap) assets.push(row);
    }
    const hook = line(i.hook, 160);
    const show = line(i.show, 300);
    if (!assets.length || !format || !hook || !show) continue;
    const captionAngle = line(i.caption_angle, 200);
    const avoid = line(i.avoid, 200);
    const timing = line(i.timing, 120);
    const mediaNeeds = line(i.media_needs, 200);
    if (findNeverContent([hook, show, captionAngle, avoid, timing, mediaNeeds].join("\n"), neverTerms).length) continue;
    const moment = typeof i.moment_ref === "string" && i.moment_ref.trim() ? momentRefs.get(i.moment_ref.trim().toUpperCase()) ?? null : null;
    const platform = typeof i.platform === "string" && platforms.includes(i.platform.trim().toLowerCase()) ? i.platform.trim().toLowerCase() : platforms[0] ?? "";
    // An evergreen idea serves the pillar the model named, when it was shown that pillar; a timely one serves its moment.
    const pillarRef = typeof i.pillar_ref === "string" ? i.pillar_ref.trim().toUpperCase() : "";
    const pillar = !moment && pillarRef ? pillars.find((p) => p.key === pillarRef) ?? null : null;
    assets.forEach((a) => taken.add(a.id));
    out.push({
      assets, moment,
      entry: {
        kind: "idea", timeBound: !!moment,
        pillarKey: pillar?.key ?? null, pillarName: pillar?.name ?? null,
        momentDecisionId: moment?.decisionId ?? null,
        expiresOn: moment?.date ? moment.date.slice(0, 10) : null,
        idea: { hook, format, platform, timing }, brief: { show, captionAngle, avoid }, mediaNeeds,
        status: "new", usedInDecisionId: null, adaptedFromIdeaId: null,
      },
    });
  }
  return out;
}

/** A zero-cost completed run that records a pass which looked and found nothing usable: the cursor moves on. */
async function recordChecked(store: AgentStore, athleteId: string, trigger: RunTrigger, cursor: TagCursor, looked: number): Promise<void> {
  const skill = loadJob(IDEAS_SKILL_ID);
  const runId = await store.startRun({ athleteId, skillId: skill.id, skillVersion: skill.version, trigger, model: modelFor(skill), parentRef: null });
  const output: PassOutput & { looked: number } = { status: "nothing_new", cursor, looked };
  await store.finishRun(athleteId, runId, { status: "completed", stopReason: null, cost: ZERO_COST, steps: [], evidenceRead: [], output, error: null });
}

export async function runPostIdeas(deps: IdeasDeps, athleteId: string, opts: { trigger: Extract<RunTrigger, "schedule" | "event">; parentRef: string | null }): Promise<IdeasOutcome> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  // Her guardrails, from the plan's own sources (preferences + the Brief's internal read): in the input (ideas 1.2.0),
  // and her never-use names are still checked in code on every idea (parseIdeas).
  const guardrails = guardrailsFrom(await deps.preferences(athleteId), await store.currentBriefInternal(athleteId).catch(() => null));
  const neverTerms = guardrails.neverTerms;

  // A retried pass: the finished run is the answer, read against what it was shown.
  if (opts.parentRef) {
    const done = await store.findCompletedRun(athleteId, opts.parentRef);
    if (done) return finishReused(deps, athleteId, done.id, neverTerms, today);
  }

  const used = new Set([...(await usedAssetIds(store, athleteId, now, null)), ...(await ideaAssetIds(deps, athleteId))]);
  const page = await deps.media.newlyTagged(athleteId, (await lastPass(store, athleteId, now))?.cursor ?? null, POST_KIT.IDEAS_MAX_ASSETS * 3);
  if (!page.length) return { status: "nothing_new" };
  const fresh: CastableRow[] = [];
  let cursor: TagCursor = { at: page[0].taggedAt, id: page[0].row.id };
  for (const p of page) {
    cursor = { at: p.taggedAt, id: p.row.id };
    if (!ineligibleReason(p.row, { neverTerms, avoidBrands: [], used })) fresh.push(p.row);
    if (fresh.length >= POST_KIT.IDEAS_MAX_ASSETS) break;
  }
  if (!fresh.length) {
    await recordChecked(store, athleteId, opts.trigger, cursor, page.length);
    return { status: "nothing_new" };
  }

  const budget = await postKitBudget(store, athleteId, now, { countKits: false });
  if (!budget.ok) return { status: "skipped", reason: budget.reason };

  const moments = await openMoments(deps, athleteId, today);
  const platforms = platformsFor(await deps.connected(athleteId));
  const pillars = await pillarsFor(store, athleteId);
  const { lines } = candidateInput(fresh);
  const input = JSON.stringify({
    // The kit's re-rank lines, under A-refs: the ideas skill names assets A1…An.
    assets: lines.map((l) => ({ ...l, ref: String(l.ref).replace(/^C/, "A") })),
    // A moment carries its hook and one angle (moments 1.2.0); one from before carries the media it needs instead.
    moments: moments.map((m, i) => ({ ref: `M${i + 1}`, name: m.name, date: m.date, hook: m.idea.hook ?? null, angle: m.brief.captionAngle ?? null, media_needs: m.mediaNeeds })),
    pillars: pillars.map((p) => ({ ref: p.key, name: p.name })),
    platforms, today, max_ideas: POST_KIT.IDEAS_MAX_PER_PASS,
    avoid: guardrails.avoid,
    never_use: guardrails.neverTerms,
    partners: guardrails.partners,
    conflicts: guardrails.conflicts.map((c) => ({ what: c.what, blocks: c.blocks })),
  });

  let r;
  try {
    r = await runSkill({
      store, athleteId, skillId: IDEAS_SKILL_ID, trigger: opts.trigger, parentRef: opts.parentRef, input,
      schemaName: "post_kit_ideas", schema: IDEAS_SCHEMA, maxOutputTokens: POST_KIT.MAX_OUTPUT_TOKENS,
      evidenceRead: fresh.map((row) => ({ kind: "record" as const, table: "media_assets", id: row.id })),
      budget: { spentMicroUsd: budget.weekMicroUsd, capMicroUsd: POST_KIT.WEEK_CAP_MICRO_USD },
    });
  } catch (err) {
    if (err instanceof CostCapError) return { status: "skipped", reason: "week_cap" };
    throw err;
  }
  const prior = ((await store.getRun(athleteId, r.runId))?.output ?? {}) as Record<string, unknown>;
  const pass: PassOutput = { status: "proposed", cursor, momentDecisionIds: moments.map((m) => m.decisionId), pillars };
  await store.setRunOutput(athleteId, r.runId, { ...prior, ...pass });
  const out = await finishReused(deps, athleteId, r.runId, neverTerms, today);
  logger.info({ athleteId, looked: page.length, fresh: fresh.length, moments: moments.length, ideas: out.status === "proposed" ? out.ideas : 0, costUsd: r.cost.microUsd / 1e6 }, "post ideas proposed");
  return out.status === "proposed" ? { ...out, costMicroUsd: r.cost.microUsd } : out;
}

/**
 * Read a finished ideas run against what IT was shown — its evidence (A-refs, in order) and the moments it recorded
 * (M-refs, in order), still open — and write the ideas missing for that run (an idea already written from the run is
 * recognised by its first asset). Writes nothing twice; a "checked" run (no model call) has nothing to write.
 */
async function finishReused(deps: IdeasDeps, athleteId: string, runId: string, neverTerms: string[], today: string): Promise<IdeasOutcome> {
  const { store } = deps;
  const run = await store.getRun(athleteId, runId);
  const output = (run?.output ?? {}) as PassOutput & { json?: unknown };
  if (output.status === "nothing_new" || output.json === undefined) return { status: "nothing_new" };
  const ids = shownIds(run);
  const assetRefs = refsInOrder(ids, await deps.media.load(athleteId, ids), "A", () => true);
  const open = new Map((await openMoments(deps, athleteId, today)).map((m) => [m.decisionId, m]));
  const momentRefs = new Map<string, MomentRef>();
  (output.momentDecisionIds ?? []).forEach((id, i) => { const m = open.get(id); if (m) momentRefs.set(`M${i + 1}`, m); });
  const platforms = platformsFor(await deps.connected(athleteId));
  const ideas = parseIdeas(output.json, assetRefs, momentRefs, platforms, neverTerms, output.pillars ?? []);
  const written = new Set((await store.listDecisions(athleteId, { kinds: ["other"], skillId: IDEAS_SKILL_ID, runId }))
    .map((d) => d.evidence.find((e) => e.kind === "record" && e.table === "media_assets") as { id: string } | undefined).map((e) => e?.id));
  let inserted = 0;
  for (const { entry, assets, moment } of ideas) {
    if (written.has(assets[0].id)) continue;
    await store.insertDecision(athleteId, {
      runId, skillId: IDEAS_SKILL_ID, kind: "other", suggested: entry.idea.hook,
      why: moment ? `Fits ${moment.name ?? "an upcoming moment"}${moment.date ? ` (${moment.date.slice(0, 10)})` : ""}.` : "A strong new photo or clip in your library.",
      evidence: assets.map((a) => ({ kind: "record" as const, table: "media_assets", id: a.id })),
      detail: entry as unknown as Record<string, unknown>,
    });
    inserted++;
  }
  return { status: "proposed", ideas: inserted, runId, costMicroUsd: 0 };
}

/**
 * The daily sweep: athletes with a current Brief, longest since their last pass first (the same "latest completed
 * post-kit/ideas run" rule the pass reads). An athlete with no newly tagged media of their own (herPhoto / herClip, after
 * their cursor) is passed over without taking a slot; at most IDEAS_SWEEP_LIMIT athletes are run per call. A no-op
 * unless AGENT_POST_KITS is "true".
 */
export async function sweepPostIdeas(deps: IdeasDeps, opts: { limit?: number } = {}): Promise<{ enabled: boolean; checked: number; proposed: number; ideas: number; skipped: Record<string, number>; failed: number }> {
  const out = { enabled: agentPostKitsEnabled(), checked: 0, proposed: 0, ideas: 0, skipped: {} as Record<string, number>, failed: 0 };
  if (!out.enabled) return out;
  const now = deps.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? POST_KIT.IDEAS_SWEEP_LIMIT, 200));
  const { db } = await import("../../db");
  const { and, eq } = await import("drizzle-orm");
  const { memoryBriefs } = await import("../../../shared/schema");
  // MILA_WELCOME: post ideas are optional — only athletes who said yes (no-op SQL while the flag is off).
  const briefs = await db.selectDistinct({ athleteId: memoryBriefs.athlete_id }).from(memoryBriefs)
    .where(and(eq(memoryBriefs.status, "current"), enabledChoiceSql(memoryBriefs.athlete_id, "post_ideas")));
  const chose = jobGate("post_ideas");
  const withPass = await Promise.all(briefs.map(async (b) => ({ athleteId: b.athleteId, last: await lastPass(deps.store, b.athleteId, now) })));
  withPass.sort((a, b) => (a.last?.startedAt ?? "").localeCompare(b.last?.startedAt ?? ""));
  const day = now.toISOString().slice(0, 10);
  for (const { athleteId, last } of withPass) {
    if (out.checked >= limit) break;
    try {
      if (!(await chose(athleteId))) { out.skipped.not_chosen = (out.skipped.not_chosen ?? 0) + 1; continue; }
      if (!(await deps.media.newlyTagged(athleteId, last?.cursor ?? null, 1)).length) continue;
      out.checked++;
      const r = await runPostIdeas(deps, athleteId, { trigger: "schedule", parentRef: `post-ideas:${day}` });
      if (r.status === "proposed") { out.proposed++; out.ideas += r.ideas; }
      else { const k = r.status === "skipped" ? r.reason : r.status; out.skipped[k] = (out.skipped[k] ?? 0) + 1; }
    } catch (err: any) {
      out.failed++;
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "post ideas pass failed");
    }
  }
  logger.info(out, "post ideas sweep");
  return out;
}
