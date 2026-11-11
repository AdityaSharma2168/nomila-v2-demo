/**
 * agent/learning/job.ts — the learning loop for ONE athlete (design "What works for you", 16 Oct 2026; L1). Run nightly
 * after the social sync (learning/db.ts runLearningLoopNightly, hooked into collectAllAnalyticsSnapshots). The athlete
 * id always comes from the job, never from content; every read and write below is filtered by it.
 *
 *   1. link     newly seen posts → the plan post action they came from by time (same platform and format, ±3 days of
 *               the due date, the action older than the post); stored on the action (detail.published). With
 *               CONTENT_READY_QUEUE on, also what "I posted it" said: the pasted link first, the stated day for an
 *               undated action — and a link that cannot close the wrong kit (core.ts mayAutoMark) marks a READY kit
 *               posted in the same write (response accepted, detail.posted by "learning"). Off: as before.
 *   2. measure  at about 2 and 7 days: reach, saves, shares, comments, views (stored on detail.published.readings)
 *   3. judge    against the athlete's own usual (median of the athlete's posts on that platform, 90 days) →
 *               recordOutcome on the action
 *   4. summary  weekly "what works for you" → ONE measured memory fact (superseded by the next week's)
 *   5. message  any of the athlete's posts (linked or not) at ≥ 3× the athlete's usual reach or saves → ONE Mila message
 *               + one push (mila_suggestion), at most one per post and one a week, recorded as a memory_decisions row
 *               (skill learning, detail.kind exceptional_post)
 *
 * Calendar days (day of week, event timing, the due-date window, "from Friday") use the athlete's phone time zone
 * (the newest push device registration's), UTC when there is none.
 *
 * No model call, no provider: code over Nomila's own rows. Off unless AGENT_LEARNING_LOOP is "true". No migration:
 * every write goes to a column that already exists. An unlinked post is still measured (it counts in the athlete's usual,
 * the summary and the exceptional-post check); it is only not judged as an action.
 */
import type { Decision } from "../../../shared/agent";
import type { PostedDetail } from "../../../shared/readyQueue";
import { contentReadyQueueEnabled } from "../ready/config";
import { isReadyRow } from "../ready/readiness";
import type { PushEvent } from "../../services/push/push";
import type { AgentStore } from "../research/store";
import { syncMeasured } from "../research/research";
import { agentLearningLoopEnabled, EXCEPTIONAL_DETAIL_KIND, LEARNING } from "./config";
import { jobAllowed } from "../welcome/gate";
import {
  ageDays, baselineFor, classOf, EXCEPTIONAL_COPY, exceptionalPost, groupPosts, judge, linkPosts, mayAutoMark, postActionOf, readingAt,
  summarise, summaryClaim, WHAT_WORKS_REF, WHAT_WORKS_SUBJECT,
  type ContentObservation, type Outcome, type Post, type PostAction, type PublishedDetail, type WhatWorks,
} from "./core";

const DAY = 86_400_000;
export { EXCEPTIONAL_DETAIL_KIND };

export interface LearningAnnouncer {
  /** Post Mila's message in a new chat of the athlete's; returns the chat's id. */
  postMilaMessage(athleteId: string, title: string, text: string): Promise<string>;
  push(athleteId: string, event: PushEvent): Promise<unknown>;
}

export interface LearningDeps {
  store: AgentStore;
  /** The athlete's connected per-post observations (entity_type content) for posts that went up at or after `since`. */
  loadContentObservations(athleteId: string, since: Date): Promise<ContentObservation[]>;
  /** The athlete's phone time zone (the newest push device registration's), or null. */
  loadTimeZone(athleteId: string): Promise<string | null>;
  /** agent/memory.ts recordOutcome. */
  recordOutcome(athleteId: string, decisionId: string, outcome: Outcome, note: string | null): Promise<unknown>;
  announcer: LearningAnnouncer;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

export interface LearningResult {
  ran: boolean;
  posts: number;
  linked: number;
  judged: number;
  summaryWritten: boolean;
  messaged: string | null;
}

const windowStart = (now: Date) => new Date(now.getTime() - (LEARNING.BASELINE_DAYS + LEARNING.SETTLED_DAYS + 1) * DAY);

/** The athlete's posts as of `now`: the athlete's observations only, none observed after `now` (a run is one moment). */
async function postsAsOf(deps: Pick<LearningDeps, "loadContentObservations">, athleteId: string, now: Date): Promise<Post[]> {
  const obs = await deps.loadContentObservations(athleteId, windowStart(now));
  return groupPosts(athleteId, obs.filter((o) => Date.parse(o.observedAt) <= now.getTime()));
}

async function postActions(store: AgentStore, athleteId: string, now: Date): Promise<Array<{ d: Decision; a: PostAction }>> {
  const since = new Date(now.getTime() - LEARNING.ACTION_LOOKBACK_DAYS * DAY).toISOString();
  const rows = await store.listDecisions(athleteId, { kinds: ["action"], since });
  return rows.filter((d) => d.athleteId === athleteId).flatMap((d) => { const a = postActionOf(d); return a ? [{ d, a }] : []; });
}

const byEntity = (actions: PostAction[]) => new Map(actions.filter((a) => a.published).map((a) => [`${a.published!.platform}|${a.published!.entity_id}`, a]));

/** The athlete's "what works for you" now, from the athlete's own rows (the read the plan, Understand and chat wiring
 * will use). */
export async function whatWorksFrom(deps: Pick<LearningDeps, "store" | "loadContentObservations" | "loadTimeZone">, athleteId: string, now: Date = new Date()): Promise<WhatWorks> {
  const posts = await postsAsOf(deps, athleteId, now);
  const actions = (await postActions(deps.store, athleteId, now)).map((x) => x.a);
  return summarise(athleteId, posts, byEntity(actions), now, await deps.loadTimeZone(athleteId));
}

export async function runLearningLoop(athleteId: string, deps: LearningDeps, now: Date = new Date()): Promise<LearningResult> {
  const result: LearningResult = { ran: false, posts: 0, linked: 0, judged: 0, summaryWritten: false, messaged: null };
  if (!agentLearningLoopEnabled()) return result;
  result.ran = true;
  const log = deps.log ?? (() => {});
  const posts = await postsAsOf(deps, athleteId, now);
  const timeZone = await deps.loadTimeZone(athleteId);
  result.posts = posts.length;
  const postOf = new Map(posts.map((p) => [`${p.platform}|${p.entityId}`, p]));
  let actions = await postActions(deps.store, athleteId, now);

  // 1. link: posts first seen in the lookback that no action holds yet.
  const held = new Set(actions.filter((x) => x.a.published).map((x) => `${x.a.published!.platform}|${x.a.published!.entity_id}`));
  const fresh = posts.filter((p) => ageDays(p, now) <= LEARNING.LINK_LOOKBACK_DAYS && !held.has(`${p.platform}|${p.entityId}`));
  // CONTENT_READY_QUEUE: read what "I posted it" said (the pasted link, the stated day) and let a safe link mark a ready
  // kit posted. Off: exactly the loop as it was (time links only, measurement only).
  const queueOn = contentReadyQueueEnabled();
  const links = linkPosts(athleteId, fresh, actions.map((x) => x.a), timeZone, { athleteSaid: queueOn });
  for (const l of links) {
    const x = actions.find((y) => y.a.id === l.actionId)!;
    const published: PublishedDetail = {
      platform: l.post.platform, entity_id: l.post.entityId, at: l.post.at, format: l.post.format, via: l.via, linkedAt: now.toISOString(),
      ...(queueOn ? { permalink: l.post.permalink } : {}),
    };
    // A READY kit (readiness.ts) is marked posted by the link too, in the same write (response accepted, detail.posted by
    // "learning"), only when that cannot close the wrong kit (core.ts mayAutoMark); any other link is measurement only.
    const marksPosted = queueOn && x.d.response === "pending" && isReadyRow(x.d, now) && mayAutoMark(l, x.a);
    const posted: PostedDetail | null = marksPosted ? { at: l.post.at, link: l.post.permalink, by: "learning" } : null;
    // Conditional: an edit in between wins, and the link is made again next night.
    const updated = await deps.store.updateDecision(athleteId, x.d.id, {
      ifUnchanged: { detail: x.d.detail ?? {}, response: x.d.response },
      detail: { ...(x.d.detail ?? {}), published, ...(posted ? { posted } : {}) },
      ...(posted ? { response: "accepted" as const, responseReason: "posted" } : {}),
    });
    if (updated) { result.linked++; log("post linked to its plan action", { athleteId, decisionId: x.d.id, via: l.via }); }
  }
  if (links.length) actions = await postActions(deps.store, athleteId, now);

  // 2 + 3. measure at about 2 and 7 days; judge against the athlete's usual; record the outcome on the action.
  for (const { d, a } of actions) {
    const pub = a.published;
    const p = pub ? postOf.get(`${pub.platform}|${pub.entity_id}`) : undefined;
    if (!pub || !p) continue;
    const readings = { ...(pub.readings ?? {}) };
    let changed = false;
    let last: { outcome: Outcome; note: string } | null = null;
    for (const cp of LEARNING.CHECKPOINTS) {
      const key = `d${cp}` as const;
      if (readings[key] || ageDays(p, now) < cp) continue;
      const metrics = readingAt(p, cp);
      if (!Object.keys(metrics).length) continue;
      const j = judge(metrics, baselineFor(posts, p.platform, classOf(p.format), now, p.entityId));
      readings[key] = { at: now.toISOString(), metrics, outcome: j?.outcome ?? null, note: j?.note ?? null, ...(j ? { ratios: j.ratios } : {}) };
      changed = true;
      if (j) last = { outcome: j.outcome, note: cp === LEARNING.CHECKPOINTS[0] ? `After ${cp} days: ${j.note}` : j.note };
    }
    if (!changed) continue;
    const ok = await deps.store.updateDecision(athleteId, d.id, { ifUnchanged: { detail: d.detail ?? {}, response: d.response }, detail: { ...(d.detail ?? {}), published: { ...pub, readings } } });
    if (ok && last) { await deps.recordOutcome(athleteId, d.id, last.outcome, last.note); result.judged++; }
  }

  // 4. the weekly summary, as one measured fact (the newer one supersedes the last).
  const facts = await deps.store.listFacts(athleteId, ["active"]);
  const current = facts.find((f) => f.type === "measured" && f.source.ref === WHAT_WORKS_REF);
  const today = now.toISOString().slice(0, 10);
  const due = !current?.date || Date.parse(`${today}T00:00:00Z`) - Date.parse(`${current.date}T00:00:00Z`) >= LEARNING.SUMMARY_EVERY_DAYS * DAY;
  if (due) {
    const w = summarise(athleteId, posts, byEntity(actions.map((x) => x.a)), now, timeZone);
    if (w.posts > 0) {
      const r = await syncMeasured(deps.store, athleteId, [{
        subject: { kind: "content", name: WHAT_WORKS_SUBJECT }, claim: summaryClaim(w), type: "measured",
        source: { ref: WHAT_WORKS_REF, title: "The athlete's connected accounts (Nomila learning loop)" }, date: today, confidence: 1, runId: null,
      }]);
      result.summaryWritten = r.inserted > 0;
    }
  }

  // 5. one message for an exceptional post (at most one per post, one a week). MILA_WELCOME: the message is the optional
  // post_took_off capability — only for athletes who said yes (steps 1–4 are data upkeep and always run).
  if (await jobAllowed("post_took_off", athleteId)) result.messaged = await maybeMessage(athleteId, posts, deps, now, timeZone);
  return result;
}

async function maybeMessage(athleteId: string, posts: Post[], deps: LearningDeps, now: Date, timeZone: string | null): Promise<string | null> {
  const prior = (await deps.store.listDecisions(athleteId, { skillId: LEARNING.SKILL_ID, kinds: ["other"] }))
    .filter((d) => d.athleteId === athleteId && (d.detail as { kind?: unknown } | undefined)?.kind === EXCEPTIONAL_DETAIL_KIND);
  const celebrated = new Set(prior.map((d) => `${(d.detail as any).platform}|${(d.detail as any).entityId}`));
  const lastAt = prior.length ? prior.map((d) => d.createdAt).sort().slice(-1)[0] : null;
  const e = exceptionalPost(posts, now, { celebrated, lastAt });
  if (!e) return null;
  const text = EXCEPTIONAL_COPY.message(e, timeZone);
  const detail = {
    kind: EXCEPTIONAL_DETAIL_KIND, version: 1, platform: e.post.platform, entityId: e.post.entityId, postedAt: e.post.at,
    format: e.post.format, metric: e.metric, value: e.value, usual: e.usual, ratio: Math.round(e.ratio * 100) / 100, conversationId: null as string | null,
  };
  // The row first: it is the cap (one per post, one a week), so a failed announce is never repeated as a second message.
  const d = await deps.store.insertDecision(athleteId, { runId: null, skillId: LEARNING.SKILL_ID, suggested: EXCEPTIONAL_COPY.suggested(e, timeZone), why: text, evidence: [], kind: "other", detail });
  try {
    const conversationId = await deps.announcer.postMilaMessage(athleteId, EXCEPTIONAL_COPY.chatTitle, text);
    await deps.store.updateDecision(athleteId, d.id, { detail: { ...detail, conversationId } });
    await deps.announcer.push(athleteId, {
      kind: "mila_suggestion", dedupeKey: `mila_suggestion:${d.id}`, title: EXCEPTIONAL_COPY.pushTitle, body: EXCEPTIONAL_COPY.pushBody(e),
      target: { screen: "mila", id: conversationId },
    });
  } catch (err: any) {
    deps.log?.("exceptional-post announce failed", { athleteId, decisionId: d.id, error: String(err?.message ?? err).slice(0, 200) });
  }
  return d.id;
}
