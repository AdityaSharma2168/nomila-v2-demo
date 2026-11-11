/**
 * agent/ready/queue.ts — "Ready for you" (content engine plan, Part C; build step 2): the made posts waiting on the
 * athlete's one tap, for Studio › Ready and Home's single top card, and "I posted it".
 *
 *   listQueue   state "ready": every post kit that is built, has media, PASSED THE FINAL GUARD (kit.guard: the mark
 *               finalGuard.ts leaves on the final text) and is still open (response pending), minus any the athlete
 *               rested with ⋯ Not now (detail.cardTap not_now, still within its 14 days). Most timely first (rankReady).
 *               state "posted": every kit marked posted (response accepted or edited), the newest post first.
 *   markItemPosted  "I posted it": the kit's own markPosted (postKit/edit.ts), with the optional link and time — see
 *               there. The link is what lets the learning loop find the post without guessing (learning/core.ts
 *               linkPosts, via "link").
 *
 * A kit built before the final guard existed (no kit.guard) is NOT listed as ready: its words never passed the check
 * that ships. Editing its caption runs the guard (edit.ts editCaption), and then it is listed. A held kit never has a kit
 * to list (build.ts writes a hold instead of a kit).
 *
 * Reads only the athlete's own rows: every store read takes the athlete id first (from the session), and media through
 * the athlete's own predicate. No model call, no provider.
 */
import type { Decision } from "../../../shared/agent";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import {
  READY_QUEUE_CONTRACT, type PostedBody, type PostedDetail, type ReadyAction, type ReadyItem, type ReadyQueueResponse, type ReadyState,
} from "../../../shared/readyQueue";
import { momentFor, type PostKitDeps } from "../postKit/build";
import { PostKitError } from "../postKit/errors";
import { previewView } from "../postKit/render/request";
import { markPosted } from "../postKit/edit";
import type { CastableRow } from "../../studio/agent/cast";
import { isReadyRow, restingUntil } from "./readiness";
import { disclosureOf, needsOf, partnerFor, type Attestation, type RightsStore } from "./rights";
import type { MaterialConnection } from "../postKit/disclosure";

const DAY = 86_400_000;

/** The most items one read lists: far above what a plan makes in a season. */
export const READY_ITEMS_MAX = 50;

/** A due date this many days past still counts as "now" (the learning loop's own window around a due date). */
export const OVERDUE_GRACE_DAYS = 3;

export type ReadyDeps = Pick<PostKitDeps, "store" | "media" | "render" | "now"> & {
  /** The athlete's rights words (rights.ts): with it, each ready item says what "Post it" will still ask. */
  rights?: RightsStore;
  /** The athlete's deal / gift / affiliate records (disclosure.ts): which deal a sponsored confirmation is for. */
  connections?: (athleteId: string) => Promise<MaterialConnection[]>;
};

interface Built { d: Decision; det: ActionDecisionDetail; kit: PostKit }

function builtKit(d: Decision): Built | null {
  const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
  if (d.kind !== "action" || det.kind !== "post") return null;
  const kit = det.prepared?.postKit;
  return kit ? { d, det, kit } : null;
}

export { restingUntil };

/** Ready = built, with media, passed the final guard, still open, not resting (readiness.ts: the one shared test). */
export function isReady(b: Built, now: Date): boolean {
  return isReadyRow(b.d, now);
}

const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/**
 * Most timely first:
 *   1. due today or later, or at most OVERDUE_GRACE_DAYS past — the soonest due first;
 *   2. no due date — the newest made first;
 *   3. due longer ago than that — still postable, the newest made first.
 * Ties: the newest made first, then the id (a stable order).
 */
export function rankReady<T extends { dueOn: string | null; updatedAt: string; id: string }>(items: readonly T[], now: Date): T[] {
  const today = dayMs(now.toISOString());
  const band = (i: T) => (!i.dueOn ? 1 : dayMs(i.dueOn) >= today - OVERDUE_GRACE_DAYS * DAY ? 0 : 2);
  return [...items].sort((a, b) => band(a) - band(b)
    || (band(a) === 0 ? a.dueOn!.localeCompare(b.dueOn!) : 0)
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.id.localeCompare(b.id));
}

const firstLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";

function postedOf(detail: Record<string, unknown> | null | undefined, d: Decision): ReadyItem["posted"] {
  const p = (detail?.posted ?? null) as Partial<PostedDetail> | null;
  if (p && typeof p.at === "string") return { at: p.at, link: typeof p.link === "string" ? p.link : null, by: p.by === "learning" ? "learning" : "athlete" };
  // Marked posted before detail.posted existed: the answer's own time.
  return d.respondedAt ? { at: d.respondedAt, link: null, by: "athlete" } : null;
}

const READY_ACTIONS_OF: ReadyAction[] = ["post_it", "copy_caption", "save_media", "posted", "open", "not_now", "not_for_me"];
const POSTED_ACTIONS_OF: ReadyAction[] = ["open"];

async function itemOf(deps: ReadyDeps, athleteId: string, b: Built, rows: Map<string, CastableRow>, goals: Map<string, { id: string; text: string }>, state: ReadyState, live: Attestation[] | null, connections: MaterialConnection[]): Promise<ReadyItem> {
  const { d, det, kit } = b;
  const [moment, preview] = await Promise.all([
    momentFor(deps.store, athleteId, det).catch(() => null),
    previewView(deps as PostKitDeps, athleteId, kit).catch(() => null),
  ]);
  const first = kit.assets[0] ? rows.get(kit.assets[0].assetId) : undefined;
  const thumb = first ? (await deps.media.urls(first)).thumbUrl : null;
  const partner = det.deliverable?.target?.subjectKind === "brand" && det.deliverable.target.name.trim() ? det.deliverable.target.name.trim() : null;
  return {
    id: d.id,
    recipe: "post_kit",
    title: (det.post?.hook || kit.idea?.hook || det.what || d.suggested || "").trim(),
    format: kit.idea?.format ?? null,
    platform: kit.idea?.platform ?? det.deliverable?.platform ?? null,
    dueOn: det.dueOn ?? null,
    thumbUrl: preview?.coverUrl ?? thumb,
    previewUrl: preview?.previewUrl ?? null,
    previewStatus: preview?.status ?? null,
    caption: { text: kit.caption.text, firstLine: firstLine(kit.caption.text), hashtags: kit.caption.hashtags, edited: kit.caption.edited },
    guard: { version: kit.guard?.version ?? 0, at: kit.guard?.at ?? "", disclosure: kit.guard ? disclosureOf(kit, d.detail) : null },
    sponsored: partner ? { brand: partner } : null,
    moment: moment ? { name: moment.name ?? "", date: moment.date, whyNow: moment.whyNow } : null,
    why: d.why === "-" ? "" : d.why,
    goal: d.goalId ? goals.get(d.goalId) ?? null : null,
    sourceAssetIds: kit.assets.map((a) => a.assetId),
    actions: state === "ready" ? READY_ACTIONS_OF : POSTED_ACTIONS_OF,
    rights: state === "ready" && live ? needsOf(kit, partnerFor(det, kit, connections), live, { detail: d.detail, connections }) : null,
    posted: state === "posted" ? postedOf(d.detail, d) : null,
    updatedAt: kit.updatedAt,
  };
}

async function itemsFor(deps: ReadyDeps, athleteId: string, built: Built[], state: ReadyState): Promise<ReadyItem[]> {
  if (!built.length) return [];
  const firstIds = [...new Set(built.map((b) => b.kit.assets[0]?.assetId).filter((id): id is string => !!id))];
  const [goals, rows] = await Promise.all([
    deps.store.listGoals(athleteId, { includeDropped: true }),
    firstIds.length ? deps.media.load(athleteId, firstIds) : Promise.resolve(new Map<string, CastableRow>()),
  ]);
  const goalById = new Map(goals.map((g) => [g.id, { id: g.id, text: g.text }]));
  const live = state === "ready" && deps.rights ? await deps.rights.listLive(athleteId) : null;
  const connections = live && deps.connections ? await deps.connections(athleteId).catch(() => [] as MaterialConnection[]) : [];
  return Promise.all(built.map((b) => itemOf(deps, athleteId, b, rows, goalById, state, live, connections)));
}

/** GET /me/engine/items?state=… — the athlete's ready (or posted) items. */
export async function listQueue(deps: ReadyDeps, athleteId: string, state: ReadyState = "ready"): Promise<ReadyQueueResponse> {
  const now = deps.now ?? new Date();
  const responses: Decision["response"][] = state === "ready" ? ["pending"] : ["accepted", "edited"];
  const actions = await deps.store.listDecisions(athleteId, { kinds: ["action"], responses });
  const built = actions.filter((d) => d.athleteId === athleteId).map(builtKit).filter((b): b is Built => b !== null);
  if (state === "ready") {
    const ready = built.filter((b) => isReady(b, now));
    // Rank on the cheap fields first, then build only the items that are listed.
    const ranked = rankReady(ready.map((b) => ({ b, id: b.d.id, dueOn: b.det.dueOn ?? null, updatedAt: b.kit.updatedAt })), now)
      .slice(0, READY_ITEMS_MAX).map((x) => x.b);
    const items = await itemsFor(deps, athleteId, ranked, "ready");
    return { contract: READY_QUEUE_CONTRACT, state, items, top: items[0] ?? null, more: Math.max(0, ready.length - 1) };
  }
  const postedAt = (b: Built) => postedOf(b.d.detail, b.d)?.at ?? b.kit.updatedAt;
  const newest = [...built].sort((a, b) => postedAt(b).localeCompare(postedAt(a)) || a.d.id.localeCompare(b.d.id)).slice(0, READY_ITEMS_MAX);
  return { contract: READY_QUEUE_CONTRACT, state, items: await itemsFor(deps, athleteId, newest, "posted"), top: null, more: 0 };
}

/** One item, in the state it is now (ready or posted), for the answer to a tap. */
export async function readItem(deps: ReadyDeps, athleteId: string, id: string): Promise<ReadyItem> {
  const d = await deps.store.getDecision(athleteId, id);
  const b = d ? builtKit(d) : null;
  if (!b) throw new PostKitError("No such post", 404, "not_found");
  const state: ReadyState = b.d.response === "accepted" || b.d.response === "edited" ? "posted" : "ready";
  const [item] = await itemsFor(deps, athleteId, [b], state);
  return item;
}

export const POSTED_RECEIPT = "Marked as posted. I'll check how it does in a couple of days.";

/** "I posted it", from Studio or Home: the kit's markPosted with the optional link and time. */
export async function markItemPosted(deps: ReadyDeps, athleteId: string, id: string, body: PostedBody): Promise<{ item: ReadyItem; receipt: string }> {
  await markPosted(deps as PostKitDeps, athleteId, id, body);
  return { item: await readItem(deps, athleteId, id), receipt: POSTED_RECEIPT };
}
