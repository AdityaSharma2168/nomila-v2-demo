/**
 * agent/postKit/build.ts — Track E for a post action: build its post kit on the action's own decision row (design §9–§10).
 *
 *   1. The action: one of the athlete's pending plan actions of kind post toward a goal they hold, not built yet (state
 *      to_start). Prepared before Keep (C1): the plan workflow's step also builds the next HELD_PER_RUN timely posts held
 *      for recommended goals still waiting for the athlete, so a recommendation is never empty — under the same caps; a
 *      kit on a held action follows it when the goal is kept (goals.ts keepRecommended moves the row as it is).
 *   2. The post to make (kit.ts postSpecOf): the plan's deliverable, and the moment it is timed for when the store has
 *      one (a moment decision whose evidence is the action's event fact).
 *   3. Retrieval: services/mediaSearch.ts searchMedia, as the Nomi Card curator casts (brief, athlete present, hard
 *      brand-safe, diverse, k 12) — a second, clip-only search for a video format — then EVERY id re-loaded through the
 *      Studio's one athlete-scoped predicate (studio/photoPredicate.ts herPhoto / herClip, via cast.ts loadCastable) and
 *      judged by kit.ts ineligibleReason. searchMedia is the search, never the judge.
 *   4. Budget: the day's harness cap, the week's post-kit cap, and the weekly kit count must leave room.
 *   5. One cheap-tier re-rank (skill post-kit/match, Gemini Flash): picks 1–3 in order and a segment per clip. Nothing
 *      eligible → no call, and the kit says so (aiGenerationNeeded true; nothing is ever generated). A retried step
 *      reuses the finished run (parentRef) and reads its picks against the candidates that run was shown, in that run's
 *      order (its evidence), never against a fresh search.
 *   5b. The copy pass (COPYWRITER_V1) may rewrite the hook and caption; then the FINAL-text guard (finalGuard.ts) runs
 *      on the words that ship — numbers against every active fact the plan read, #ad at the start when the partner (or a
 *      brand the words name or @-tag) matches a real deal, gift or affiliate record of the athlete's (else "ask"), contact / prices /
 *      M.I.A. out, never-content / avoided wording / care text blocked. A blocked rewrite falls back to the plan's copy
 *      (guarded the same way); blocked again, the hold is recorded on the row (prepared.postKitHold) and the plan
 *      workflow and the athlete's "Build it" answer from it (nothing paid twice) until what it was built from changes.
 *      The never-content check before the re-rank stays only because it saves that call.
 *   6. The write: the row is re-read; when its state moved or a kit appeared meanwhile, nothing is written ("conflict").
 *      Otherwise the kit goes to detail.prepared.postKit (merged into the fresh row's own `prepared`), conditionally on
 *      the row being exactly what was re-read, with studioItemId = the decision id and state made — or, with no asset
 *      to show, the kit is kept but the action stays at to_start, so a later build can try again.
 *   7. The preview (AGENT_POST_KIT_RENDER, render/request.ts): a made kit asks for its render — real media only, on the
 *      stitch queue; a failure to ask never fails the build.
 *
 * Every read is the athlete's own: the athlete id comes from the session or the run, never a body or a model; the
 * store and the media port both take it first.
 */
import type { Decision, MemoryFact, Preference, RunTrigger } from "../../../shared/agent";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit, PostKitHold } from "../../../shared/postKit";
import { LOOK_PRESETS } from "../../../shared/postKit";
import type { CastableRow } from "../../studio/agent/cast";
import { brandsToAvoid, SPORTSWEAR_BRANDS, type Brand } from "../../studio/agent/brands";
import { TRACK_MOODS } from "../../studio/music/tracks";
import { paramValues } from "../../studio/agent/capabilityEntries";
import { createLogger } from "../../logger";
import { copywriterEnabled } from "../../services/copywriterFlag";
import { neverTermsFrom } from "../neverTerms";
import { findNeverContent } from "../policy";
import { CostCapError, runSkill } from "../research/runSkill";
import { athleteDaySpendMicroUsd, type AgentStore, type StoredRun } from "../research/store";
import { dayWords } from "../plan/goals";
import { agentPostKitCapabilityBlockEnabled, IDEAS_SKILL_ID, MATCH_LIBRARY_SKILL_ID, MATCH_SKILL_ID, POST_KIT } from "./config";
import { PostKitError } from "./errors";
import { requestQuietly, type PostKitRenderPort } from "./render/request";
import { creditLine, musicChoicesFor, selectedCredit, withCredit, withMusic } from "./music";
import { GUARD_VERSION, guardKit, guardPostText, numberSourcesFor, type GuardBlock, type GuardSources } from "./finalGuard";
import { disclosureFor, type MaterialConnection } from "./disclosure";
import { createHash } from "node:crypto";
import { withTags } from "./caption";
import {
  assembleKit, candidateInput, capabilitiesFor, capCaption, fitsFormat, hashtagsOf, ineligibleReason, isVideoFormat, kitAssetIds, maxAssetsFor, momentOf, parseMatch,
  postSpecOf, refsInOrder, type MomentRef, type PostSpec,
} from "./kit";

const logger = createLogger("agent/postKit");
const DAY = 86_400_000;

/** A place in the athlete's library by tag time: rows tagged after it come next (ties broken by id). */
export interface TagCursor {
  at: string;
  id: string;
}

/** The athlete's library, as the builder may read it. Every method takes the athlete first and never reaches past it. */
export interface PostKitMedia {
  /**
   * searchMedia's shortlist for a brief, best first: photos and clips together (`clipsFirst`: the clip-only search's
   * results lead), athlete present, hard brand-safe, the given brands kept out of frame.
   */
  search(athleteId: string, brief: string, opts: { clipsFirst: boolean; excludeBrands: string[]; k: number }): Promise<string[]>;
  /** These ids, re-loaded through herPhoto / herClip (cast.ts loadCastable): anything not hers simply does not come back. */
  load(athleteId: string, ids: string[]): Promise<Map<string, CastableRow>>;
  /**
   * Tagged rows of the athlete's (herPhoto / herClip) whose tags were written after `after` (all when null), OLDEST
   * first, at most `limit` — a page: the caller moves its cursor to the last row it consumed, so nothing is skipped.
   * The tag time is metadata_updated_at (every enrichment writer bumps it), else ingested_at.
   */
  newlyTagged(athleteId: string, after: TagCursor | null, limit: number): Promise<Array<{ row: CastableRow; taggedAt: string }>>;
  /** What a screen shows for a row: signed URLs. */
  urls(row: CastableRow): Promise<{ thumbUrl: string | null; videoUrl: string | null }>;
  /**
   * A listening link for one of the PRODUCT's music files (a kit's suggested track, studio/music), by its bucket path —
   * nothing of the athlete's. Asked only for a file installed here (beds.ts musicInstalled). Optional: absent, no link.
   */
  trackUrl?(gcsPath: string): Promise<string | null>;
}

export interface PostKitDeps {
  store: AgentStore;
  media: PostKitMedia;
  /** The athlete's active preferences (never-use names live in "avoid" ones). */
  preferences: (athleteId: string) => Promise<Preference[]>;
  /**
   * The preview render's port (render/request.ts): with it, and AGENT_POST_KIT_RENDER on, a built, swapped or
   * re-captioned kit asks for its preview. Absent: no preview is ever asked for.
   */
  render?: PostKitRenderPort;
  /**
   * The athlete's avoided wording (brand_voice avoid, as the copy pass reads it), for the final guard (finalGuard.ts).
   * Absent: none is checked.
   */
  avoidWords?: (athleteId: string) => Promise<string[]>;
  /**
   * The athlete's material connections (disclosure.ts dbMaterialConnections): signed / active deals, gifted products,
   * affiliate links. Absent: none — a post naming a brand is then "ask", never an #ad on a guess.
   */
  connections?: (athleteId: string) => Promise<MaterialConnection[]>;
  now?: Date;
}

export { PostKitError };

export type BuildOutcome =
  | { status: "built"; decisionId: string; assets: number; aiGenerationNeeded: boolean; costMicroUsd: number; runId: string | null }
  | { status: "exists"; decisionId: string }
  | { status: "conflict"; decisionId: string }
  | { status: "skipped"; decisionId: string; reason: "day_cap" | "week_cap" | "week_count" }
  | {
    status: "held"; decisionId: string; reason: "never_content" | "final_guard"; block?: GuardBlock;
    /** True when this answers from a hold already recorded (nothing was run or paid for). */
    reused?: boolean;
  };

export const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["picks", "none_fit", "none_fit_reason", "look_preset", "music_mood"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["ref", "segment", "reason"],
        properties: { ref: { type: "string" }, segment: { type: "string" }, reason: { type: "string" } },
      },
    },
    none_fit: { type: "boolean" },
    none_fit_reason: { type: "string" },
    look_preset: { type: "string", enum: [...LOOK_PRESETS] },
    music_mood: { type: "string", enum: [...TRACK_MOODS, "none"] },
  },
};

/**
 * The re-rank's schema with the capability block (AGENT_POST_KIT_CAPABILITY_BLOCK): the same shape, its look and mood
 * lists read off the library's look.preset and music.mood entries — the lists the block prints — never written here.
 */
export const MATCH_LIBRARY_SCHEMA = {
  ...MATCH_SCHEMA,
  properties: {
    ...MATCH_SCHEMA.properties,
    look_preset: { type: "string", enum: paramValues("look.preset", "name") },
    music_mood: { type: "string", enum: paramValues("music.mood", "mood") },
  },
};

const sum = (runs: StoredRun[]) => runs.reduce((n, r) => n + (r.cost?.microUsd ?? 0), 0);

/** Whether one more post-kit skill call fits: today's spend (every run), this week's post-kit spend and (for a kit) count. */
export async function postKitBudget(store: AgentStore, athleteId: string, now: Date, opts: { countKits: boolean }): Promise<
  { ok: true; weekMicroUsd: number } | { ok: false; reason: "day_cap" | "week_cap" | "week_count" }
> {
  if ((await athleteDaySpendMicroUsd(store, athleteId, now)) + POST_KIT.RUN_RESERVE_MICRO_USD > POST_KIT.DAY_CAP_MICRO_USD) return { ok: false, reason: "day_cap" };
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  // Both re-rank skills count: the flag that picks one never resets the week.
  const match = [
    ...(await store.listRunsSince(athleteId, { since, skillId: MATCH_SKILL_ID })),
    ...(await store.listRunsSince(athleteId, { since, skillId: MATCH_LIBRARY_SKILL_ID })),
  ];
  const ideas = await store.listRunsSince(athleteId, { since, skillId: IDEAS_SKILL_ID });
  const week = sum(match) + sum(ideas);
  if (week + POST_KIT.RUN_RESERVE_MICRO_USD > POST_KIT.WEEK_CAP_MICRO_USD) return { ok: false, reason: "week_cap" };
  if (opts.countKits && match.filter((r) => r.status !== "failed").length >= POST_KIT.MAX_PER_WEEK) return { ok: false, reason: "week_count" };
  return { ok: true, weekMicroUsd: week };
}

/** A plan action of kind post, or why not. */
function postActionOf(d: Decision | null): ActionDecisionDetail {
  if (!d || d.kind !== "action") throw new PostKitError("No such action", 404, "not_found");
  const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
  if (det.kind !== "post") throw new PostKitError("This action is not a post", 409, "not_a_post");
  return det;
}

/** What identifies the kit on a row (its build time), or null — how a write tells that another kit appeared meanwhile. */
const kitStamp = (det: Partial<ActionDecisionDetail> | undefined): string | null => det?.prepared?.postKit?.builtAt ?? null;

/** The moment the action is timed for: a pending moment decision (kind other, detail.kind moment) citing its event fact. */
export async function momentFor(store: AgentStore, athleteId: string, det: ActionDecisionDetail): Promise<MomentRef | null> {
  const factId = det.event?.factId;
  if (!factId) return null;
  const others = await store.listDecisions(athleteId, { kinds: ["other"], responses: ["pending"] });
  const d = [...others].reverse().find((o) => o.detail?.kind === "moment" && o.evidence.some((e) => e.kind === "fact" && e.factId === factId));
  if (!d) return null;
  const [fact] = await store.getFacts(athleteId, [factId]);
  return momentOf(d.id, d.detail, (fact as MemoryFact | undefined) ?? null);
}

/** Assets already in another live kit (a kit on a pending or answered action, built in the lookback window). */
export async function usedAssetIds(store: AgentStore, athleteId: string, now: Date, exceptDecisionId: string | null): Promise<Set<string>> {
  const since = new Date(now.getTime() - POST_KIT.USED_LOOKBACK_DAYS * DAY).toISOString();
  const actions = await store.listDecisions(athleteId, { kinds: ["action"], responses: ["pending", "accepted", "edited"], since });
  return new Set(actions.filter((a) => a.id !== exceptDecisionId).flatMap((a) => kitAssetIds(a.detail)));
}

/** Brands that may not be in frame: other sportswear brands when the post names a partner brand. */
const avoidFor = (spec: PostSpec): Brand[] => (spec.partner ? brandsToAvoid(spec.partner.name) : []);

/** Whether a loaded row may be a candidate for this post: every eligibility check, and the moment's format. */
const usableFor = (spec: PostSpec, ctx: { neverTerms: string[]; used: Set<string> }) => {
  const avoidBrands = avoidFor(spec);
  return (row: CastableRow): string | null => {
    const why = ineligibleReason(row, { neverTerms: ctx.neverTerms, avoidBrands, used: ctx.used });
    if (why) return why;
    return spec.formatFixed && !fitsFormat(spec.idea.format, row.mediaType) ? "wrong_format" : null;
  };
};

/** The shortlist: searched, re-loaded through the athlete's own predicate, judged; best first, at most MAX_CANDIDATES. */
export async function shortlistFor(deps: PostKitDeps, athleteId: string, spec: PostSpec, ctx: { neverTerms: string[]; used: Set<string> }): Promise<{ rows: CastableRow[]; excluded: Record<string, number> }> {
  const clipsFirst = spec.formatFixed ? isVideoFormat(spec.idea.format) : false;
  const ids = await deps.media.search(athleteId, spec.searchText, { clipsFirst, excludeBrands: avoidFor(spec).flatMap((b) => b.spellings), k: POST_KIT.SEARCH_K });
  const rows = await deps.media.load(athleteId, ids);
  const unusable = usableFor(spec, ctx);
  const excluded: Record<string, number> = {};
  const out: CastableRow[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue; // not hers, deleted, a reference, a poster-only video: the predicate's answer
    const why = unusable(row);
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; continue; }
    if (!out.some((r) => r.id === row.id)) out.push(row);
    if (out.length >= POST_KIT.MAX_CANDIDATES) break;
  }
  return { rows: out, excluded };
}

/** The media_assets ids a run was shown, in the order it was shown them (its evidence). */
export const shownIds = (run: StoredRun | null): string[] =>
  (run?.evidenceRead ?? []).filter((e) => e.kind === "record" && e.table === "media_assets").map((e) => (e as { id: string }).id);

/** The selected track's credit lines (both forms): the guard never reads or touches them. */
export const creditLines = (kit: PostKit): string[] => {
  const c = selectedCredit(kit);
  return c ? [c.full, c.short].filter((x): x is string => !!x).map(creditLine) : [];
};

/**
 * What the final guard reads for a post action (finalGuard.ts):
 *   numbers      EVERY active fact the plan read for the athlete (not only the keys it cited) — never a disputed one (a
 *                number two sources disagree on is not a source), a removed or a superseded one — its event and moment,
 *                its due date, the countdown to the event
 *   never / avoid / care   the athlete's never-terms, avoided wording (deps.avoidWords; none without it), care facts
 *   disclosure   the post's partner against the athlete's material connections (disclosure.ts; deps.connections — none
 *                without it, so a named brand is "ask", never an #ad on a guess); the connections and the product's known
 *                brand names also go to the guard, which reads the brands the final words name or @-tag
 * Only the athlete's own rows are read.
 */
export async function guardSourcesFor(
  deps: Pick<PostKitDeps, "store" | "avoidWords" | "connections">, athleteId: string, det: ActionDecisionDetail,
  moment: MomentRef | null, neverTerms: readonly string[], now: Date, mode: GuardSources["mode"],
): Promise<GuardSources & { facts: MemoryFact[]; connections: MaterialConnection[] }> {
  const [all, avoidWords, connections] = await Promise.all([
    deps.store.listFacts(athleteId),
    deps.avoidWords ? deps.avoidWords(athleteId).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    deps.connections ? deps.connections(athleteId).catch(() => [] as MaterialConnection[]) : Promise.resolve([] as MaterialConnection[]),
  ]);
  const read = all.filter((f) => f.status === "active");
  const disclosure = disclosureFor(det.deliverable?.target, connections);
  return {
    numberSources: numberSourcesFor({
      facts: read, event: det.event ? { label: det.event.label, date: det.event.date } : null,
      moment: moment ? { name: moment.name, date: moment.date } : null, dueOn: det.dueOn ?? null, today: now.toISOString().slice(0, 10),
    }),
    neverTerms, avoidWords,
    careFacts: all.filter((f) => f.sensitive && f.status !== "removed"),
    disclosure: disclosure.need, codes: disclosure.codes, mode, connections,
    knownBrands: SPORTSWEAR_BRANDS.flatMap((b) => [b.name, ...b.spellings]),
    facts: read,
  };
}

/**
 * What a held build was made from (PostKitHold.inputsKey), as a fingerprint of everything the guard reads: the
 * deliverable, the post's idea, its due date, its event (fact and date), the athlete's never-terms and avoided wording,
 * EVERY active fact (id, claim, date — a fact edited, added or retired changes it, not only the count) and the material
 * connections disclosure reads (brand, kind, codes). While it is unchanged, the plan workflow does not build the same
 * action again (it would be held again, and a final-guard hold is paid for: the re-rank ran first).
 */
export function holdInputsKey(
  det: ActionDecisionDetail, neverTerms: readonly string[], avoidWords: readonly string[],
  facts: readonly Pick<MemoryFact, "id" | "claim" | "date">[], connections: readonly MaterialConnection[],
): string {
  const lower = (xs: readonly string[]) => [...xs].map((t) => t.toLowerCase()).sort();
  const json = JSON.stringify({
    v: GUARD_VERSION, deliverable: det.deliverable ?? null, post: det.post ?? null, dueOn: det.dueOn ?? null,
    event: det.event ? [det.event.factId, det.event.date] : null,
    never: lower(neverTerms), avoid: lower(avoidWords),
    facts: facts.map((f) => [f.id, f.claim, f.date ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    connections: connections.map((c) => [c.brand.toLowerCase(), c.kind, [...c.codes].sort()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

/**
 * How long a hold stands against the athlete's own "Build it" tap with nothing changed: after this, a tap tries once
 * more (the copy pass writes new words each time, so a retry can pass) — at most one paid attempt per action per hour
 * from taps. The plan workflow never retries on time, only when the inputs change.
 */
export const HOLD_RETRY_MS = 60 * 60 * 1000;

/** Record a hold on the action's row (conditional on the row being what was read; a lost race records nothing). */
async function recordHold(store: AgentStore, athleteId: string, d: Decision, hold: PostKitHold): Promise<void> {
  const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
  const detail: ActionDecisionDetail = { ...det, prepared: { ...(det.prepared ?? {}), postKitHold: hold } };
  await store.updateDecision(athleteId, d.id, {
    detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: d.detail ?? {}, response: "pending" },
  }).catch(() => null);
}

/** The pending recommendation (a goal decision Mila is waiting on) a held action belongs to, or null. */
async function pendingRecommendation(store: AgentStore, athleteId: string, d: Decision): Promise<Decision | null> {
  if (d.goalId || !d.parentDecisionId) return null;
  const parent = await store.getDecision(athleteId, d.parentDecisionId);
  return parent && parent.kind === "goal" && parent.response === "pending" ? parent : null;
}

export async function buildPostKit(
  deps: PostKitDeps, athleteId: string, decisionId: string,
  opts: {
    trigger: Extract<RunTrigger, "event" | "schedule" | "chat">; parentRef: string | null;
    /** C1, prepare before Keep: the plan workflow may build an action held for a recommendation still waiting. */
    allowHeld?: boolean;
    /** The athlete tapped Build it (the route): a hold older than HOLD_RETRY_MS is tried again even with nothing changed. */
    asked?: boolean;
  },
): Promise<BuildOutcome> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const d = await store.getDecision(athleteId, decisionId);
  const det = postActionOf(d);
  if (d!.response !== "pending") throw new PostKitError("This action is already answered", 409, "answered");
  if (!d!.goalId && !(opts.allowHeld && (await pendingRecommendation(store, athleteId, d!)))) throw new PostKitError("This action waits until its goal is kept", 409, "goal_not_kept");
  if ((det.state ?? "to_start") !== "to_start") return { status: "exists", decisionId };

  const neverTerms = neverTermsFrom(await deps.preferences(athleteId));
  const moment = await momentFor(store, athleteId, det);
  const sources = await guardSourcesFor(deps, athleteId, det, moment, neverTerms, now, "build");
  const inputsKey = holdInputsKey(det, neverTerms, sources.avoidWords, sources.facts, sources.connections);
  const prior = det.prepared?.postKitHold ?? null;
  // A hold recorded on the row, with nothing it was built from changed since: the same answer, free (a re-rank and a
  // copy pass would be paid for the same words again). Anything it was built from changing tries again — and so does the
  // athlete's own Build it tap once the hold is older than HOLD_RETRY_MS.
  const stale = !!prior && opts.asked === true && now.getTime() - Date.parse(prior.at) >= HOLD_RETRY_MS;
  if (prior && prior.inputsKey === inputsKey && !stale) {
    return { status: "held", decisionId, reason: prior.reason, reused: true, ...(prior.block ? { block: prior.block as GuardBlock } : {}) };
  }
  const hold = async (reason: PostKitHold["reason"], block: GuardBlock | null): Promise<BuildOutcome> => {
    await recordHold(store, athleteId, d!, { reason, block, inputsKey, at: now.toISOString() });
    return { status: "held", decisionId, reason, ...(block ? { block } : {}) };
  };
  const spec = postSpecOf(det, d!.suggested, moment, neverTerms, dayWords);
  // The plan step already holds a deliverable with never-content; this is the same check on the kit's own text. It is
  // NOT the authority (the final guard after the copy pass is, below): it only saves the re-rank call on a kit that
  // could never pass.
  if (findNeverContent([spec.caption.text, spec.idea.hook, spec.brief.show].join("\n"), neverTerms).length) {
    logger.warn({ athleteId, decisionId }, "post kit held: never-content in its text");
    return hold("never_content", null);
  }

  const ctx = { neverTerms, used: await usedAssetIds(store, athleteId, now, decisionId) };
  const searched = await shortlistFor(deps, athleteId, spec, ctx);
  let rows = searched.rows;

  let runId: string | null = null;
  let skillVersion: string | null = null;
  let runCostMicroUsd = 0;
  let spentMicroUsd = 0;
  let answer = parseMatch(null, new Map(), 0);
  if (rows.length) {
    const budget = await postKitBudget(store, athleteId, now, { countKits: true });
    if (!budget.ok) {
      logger.warn({ athleteId, decisionId, reason: budget.reason }, "post kit skipped: a cap would be passed");
      return { status: "skipped", decisionId, reason: budget.reason };
    }
    const maxPicks = spec.formatFixed ? maxAssetsFor(spec.idea.format) : POST_KIT.MAX_ASSETS;
    const { lines } = candidateInput(rows);
    // The capability layer (AGENT_POST_KIT_CAPABILITY_BLOCK): the block generated for THIS post replaces the prompt's
    // fixed look and music lists. Off: the input and the skill are exactly what they were.
    const library = agentPostKitCapabilityBlockEnabled();
    const input = JSON.stringify({
      post: {
        format: spec.formatFixed ? spec.idea.format : "not set: choose the best fit (reel, carousel or feed)",
        platform: spec.idea.platform, hook: spec.idea.hook, show: spec.brief.show, caption_angle: spec.brief.captionAngle,
        avoid: spec.brief.avoid, media_needs: spec.mediaNeeds,
      },
      candidates: lines,
      max_picks: maxPicks,
      ...(library ? { capabilities: capabilitiesFor(spec, moment, rows, now) } : {}),
    });
    try {
      const r = await runSkill({
        store, athleteId, skillId: library ? MATCH_LIBRARY_SKILL_ID : MATCH_SKILL_ID, trigger: opts.trigger, parentRef: opts.parentRef, input,
        schemaName: "post_kit_match", schema: library ? MATCH_LIBRARY_SCHEMA : MATCH_SCHEMA, maxOutputTokens: POST_KIT.MAX_OUTPUT_TOKENS,
        evidenceRead: rows.map((row) => ({ kind: "record" as const, table: "media_assets", id: row.id })),
        budget: { spentMicroUsd: budget.weekMicroUsd, capMicroUsd: POST_KIT.WEEK_CAP_MICRO_USD },
      });
      const run = await store.getRun(athleteId, r.runId);
      runId = r.runId;
      skillVersion = run?.skillVersion ?? null;
      runCostMicroUsd = r.cost.microUsd;
      spentMicroUsd = r.reused ? 0 : r.cost.microUsd;
      if (r.reused) {
        // The picks name C-refs of what THAT run was shown: rebuild them from its evidence, in its order, keeping only
        // rows still the athlete's and still usable. The shortlist is that run's, too.
        const ids = shownIds(run);
        const keep = usableFor(spec, ctx);
        const reused = refsInOrder(ids, await deps.media.load(athleteId, ids), "C", (row) => !keep(row));
        rows = [...reused.values()];
        answer = parseMatch(r.json, reused, maxPicks);
      } else {
        answer = parseMatch(r.json, candidateInput(rows).refs, maxPicks);
      }
    } catch (err) {
      if (err instanceof CostCapError) return { status: "skipped", decisionId, reason: "week_cap" };
      throw err;
    }
  }

  const assembled: PostKit = assembleKit({
    spec, picks: answer.picks, shortlist: rows, look: answer.look, musicMood: answer.musicMood,
    match: { runId, skillVersion, candidates: rows.length, costMicroUsd: runCostMicroUsd, noneFitNote: answer.noneFitNote },
    eligibleCount: rows.length, neverTerms, now,
  });
  // Three suggested tracks for the mood the re-rank named (AGENT_POST_KIT_MUSIC_CHOICES; off: none, as before).
  let kit: PostKit = withMusic(assembled, musicChoicesFor({
    mood: answer.musicMood, format: assembled.idea.format, forBrand: spec.partner !== null, totalSec: assembled.treatmentPlan.totalSec,
  }));
  // The copy pass (COPYWRITER_V1): the narrator's craft rewrites the hook and caption (one Fable call + one editor call,
  // a few cents, outside the kit caps). Any failure keeps the kit's own copy; the plan's copy is kept as the original.
  const planCopy = kit;
  if (copywriterEnabled()) {
    const { polishPostCopy } = await import("../../services/copywriter");
    const p = await polishPostCopy(athleteId, {
      format: kit.idea.format, platform: kit.idea.platform, timing: kit.idea.timing, event: det.event ? { label: det.event.label, date: det.event.date } : null,
      hook: kit.idea.hook, show: kit.brief.show, captionAngle: kit.brief.captionAngle, avoid: kit.brief.avoid, caption: kit.caption.text,
    }, { neverTerms });
    // The rewrite is the words; the plan's tags follow them (plan 1.7.0), and the selected track's credit goes back at
    // the end (the writer is shown the caption without it). A rewrite with no room for the credit is not used.
    const credited = p ? withCredit(withTags(capCaption(p.picked.caption), kit.caption.hashtags), null, selectedCredit(kit)) : null;
    const text = credited?.ok ? capCaption(credited.text) : "";
    if (p && text) {
      // The stored options are guarded too (a screen may offer them): only the ones that pass, as they would ship.
      const options = p.options.flatMap((o) => {
        const g = guardPostText({ caption: withTags(o.caption, kit.caption.hashtags), onCard: [o.hook] }, sources);
        return g.ok ? [{ hook: o.hook, caption: g.caption }] : [];
      });
      kit = {
        ...kit, idea: { ...kit.idea, hook: p.picked.hook || kit.idea.hook }, caption: { text, hashtags: hashtagsOf(text), edited: false },
        copy: { original: { hook: kit.idea.hook, caption: kit.caption.text }, options },
      };
    }
  }
  // The final-text guard (finalGuard.ts) on the words that ship: the copy pass's when it ran. A rewrite the guard blocks
  // is dropped for the plan's own words, guarded the same way; when those are blocked too, the hold is recorded on the
  // row (PostKitHold) and nothing else is written.
  let guarded = guardKit(kit, { ...sources, keep: creditLines(kit) }, now);
  if (!guarded.ok && kit !== planCopy) {
    logger.warn({ athleteId, decisionId, block: guarded.block }, "post kit: the copy pass's words were blocked by the final guard; the plan's copy is used");
    guarded = guardKit(planCopy, { ...sources, keep: creditLines(planCopy) }, now);
  }
  if (!guarded.ok) {
    logger.warn({ athleteId, decisionId, block: guarded.block }, "post kit held: the final guard blocked its text");
    return hold("final_guard", guarded.block);
  }
  if (guarded.fixes.length) logger.info({ athleteId, decisionId, fixes: guarded.fixes }, "post kit: the final guard fixed its text");
  kit = guarded.kit;
  const made = kit.assets.length > 0;

  // Re-read, and write only onto what was re-read: a plan refresh, an edit or another build in between wins.
  const fresh = await store.getDecision(athleteId, decisionId);
  const freshDet = (fresh?.detail ?? {}) as unknown as ActionDecisionDetail;
  if (!fresh || fresh.response !== "pending" || (freshDet.state ?? "to_start") !== "to_start" || kitStamp(freshDet) !== kitStamp(det)) {
    logger.warn({ athleteId, decisionId }, "post kit not written: the action changed while it was built");
    return { status: "conflict", decisionId };
  }
  const detail: ActionDecisionDetail = {
    ...freshDet,
    state: made ? "made" : freshDet.state ?? "to_start",
    // A kit that passed clears any hold recorded on the row.
    prepared: { ...(freshDet.prepared ?? {}), ...(made ? { studioItemId: decisionId } : {}), postKit: kit, postKitHold: null },
  };
  const written = await store.updateDecision(athleteId, decisionId, {
    detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: fresh.detail ?? {}, response: "pending" },
  });
  if (!written) {
    logger.warn({ athleteId, decisionId }, "post kit not written: the action changed while it was written");
    return { status: "conflict", decisionId };
  }
  logger.info({
    athleteId, decisionId, format: kit.idea.format, assets: kit.assets.length, candidates: rows.length, excluded: searched.excluded,
    aiGenerationNeeded: kit.aiGenerationNeeded.value, noneFit: answer.noneFit, costUsd: spentMicroUsd / 1e6,
  }, "post kit built");
  // The preview (AGENT_POST_KIT_RENDER): asked for once the kit is on the row; a kit is built whether or not it can be.
  if (made) await requestQuietly(deps, athleteId, decisionId);
  return { status: "built", decisionId, assets: kit.assets.length, aiGenerationNeeded: kit.aiGenerationNeeded.value, costMicroUsd: spentMicroUsd, runId };
}

/**
 * Whether an action's EMPTY kit (nothing fitted when it was built) is worth another try: some usable asset was tagged
 * since that build.
 */
async function newMediaSinceEmptyKit(deps: PostKitDeps, athleteId: string, d: Decision, now: Date, neverTerms: string[]): Promise<boolean> {
  const det = d.detail as unknown as ActionDecisionDetail;
  const kit = det.prepared?.postKit;
  if (!kit || kit.assets.length) return false;
  const spec = postSpecOf(det, d.suggested, null, neverTerms, dayWords);
  const keep = usableFor(spec, { neverTerms, used: await usedAssetIds(deps.store, athleteId, now, d.id) });
  const page = await deps.media.newlyTagged(athleteId, { at: kit.builtAt, id: "" }, POST_KIT.MAX_CANDIDATES);
  return page.some((p) => !keep(p.row));
}

/**
 * The plan workflow's post_kits step: kits for the athlete's pending post actions toward a goal they hold, still to
 * start — with no kit tried yet, or an empty kit and new usable media since — soonest due first. Then (C1, prepare
 * before Keep) the next HELD_PER_RUN timely posts held for recommendations still waiting (a due date or an event, soonest
 * first), so a recommended goal is never empty. MAX_PER_RUN kits are built at most, under the same week and day caps:
 * a build, a failed attempt, or a final-guard hold (paid: the re-rank and the copy pass ran) takes a slot; a never-content
 * hold (free), a hold answered again from its row, an action already made or changed meanwhile does
 * not. One kit failing never fails the others.
 */
export async function buildPendingPostKits(deps: PostKitDeps, athleteId: string, opts: { parentRef: string; trigger: Extract<RunTrigger, "event" | "schedule" | "chat"> }): Promise<{
  built: number; skipped: Record<string, number>; failed: number;
  /** The holds made THIS run, each once (plan/tell.ts tells them; a hold answered from the row again is not re-told). */
  held: Array<{ reason: PostKitHold["reason"]; block: GuardBlock | null }>;
}> {
  const out = { built: 0, skipped: {} as Record<string, number>, failed: 0, held: [] as Array<{ reason: PostKitHold["reason"]; block: GuardBlock | null }> };
  // A final-guard hold was paid for (the re-rank and the copy pass ran before the guard): it takes a slot like a build.
  let paidHolds = 0;
  const now = deps.now ?? new Date();
  const neverTerms = neverTermsFrom(await deps.preferences(athleteId));
  const actions = await deps.store.listDecisions(athleteId, { kinds: ["action"], responses: ["pending"] });
  const toStart = (a: Decision) => {
    const det = (a.detail ?? {}) as Partial<ActionDecisionDetail>;
    return det.kind === "post" && (det.state ?? "to_start") === "to_start";
  };
  const due = (a: Decision) => String((a.detail as Partial<ActionDecisionDetail>).dueOn ?? (a.detail as Partial<ActionDecisionDetail>).event?.date ?? "9999");
  const kept = actions.filter((a) => a.goalId && toStart(a)).sort((a, b) => due(a).localeCompare(due(b)));
  // C1: the next timely posts held for a recommendation still waiting (one with a date: a due date or its event).
  const waiting = new Set((await deps.store.listDecisions(athleteId, { kinds: ["goal"], responses: ["pending"] })).map((d) => d.id));
  const held = actions.filter((a) => !a.goalId && a.parentDecisionId && waiting.has(a.parentDecisionId) && toStart(a) && due(a) !== "9999")
    .sort((a, b) => due(a).localeCompare(due(b))).slice(0, POST_KIT.HELD_PER_RUN);
  const candidates = [...kept.map((a) => ({ a, held: false })), ...held.map((a) => ({ a, held: true }))];
  for (const { a, held: isHeld } of candidates) {
    if (out.built + out.failed + paidHolds >= POST_KIT.MAX_PER_RUN) break;
    try {
      const tried = !!(a.detail as Partial<ActionDecisionDetail>).prepared?.postKit;
      if (tried && !(await newMediaSinceEmptyKit(deps, athleteId, a, now, neverTerms))) continue;
      const r = await buildPostKit(deps, athleteId, a.id, { trigger: opts.trigger, parentRef: `${opts.parentRef}:${a.id}`, allowHeld: isHeld });
      if (r.status === "built") { out.built++; continue; }
      // A hold answered from the row (nothing changed, nothing run): not counted, not told again.
      if (r.status === "held" && r.reused) continue;
      if (r.status === "held") {
        out.held.push({ reason: r.reason, block: r.block ?? null });
        if (r.reason === "final_guard") paidHolds++;
      }
      const key = r.status === "skipped" || r.status === "held" ? r.reason : r.status;
      out.skipped[key] = (out.skipped[key] ?? 0) + 1;
      if (r.status === "skipped") break; // a cap: the rest would be refused too
    } catch (err: any) {
      out.failed++;
      logger.warn({ athleteId, decisionId: a.id, error: String(err?.message ?? err).slice(0, 200) }, "post kit build failed");
    }
  }
  return out;
}
