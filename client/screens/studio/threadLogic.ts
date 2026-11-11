/**
 * threadLogic — the Create anything thread as data: what the server hands back, what the thread shows for it, and
 * every decision in between that can be made without a screen (session persistence plan v2 §4;
 * docs/plans/studio-sessions-plan-v2.md). Pure, so each decision is a unit test (threadLogic.test.ts).
 *
 * ─── HISTORY IS INERT ──────────────────────────────────────────────────────────────────────────────────
 *
 * An entry read back from the server already happened. It renders — her words, Mila's card, what came of it —
 * and offers nothing that acts on the past. There is no Generate on a history card and no "Not what I meant":
 * a preview this mount did not render is never approved from it. The only ways out of a history card start
 * something NEW — Check again (a fresh preview, through the same sheet), Edit this (a fresh tray), the viewer.
 * Only what this mount made is live, and live items render from this mount's own state, never from a re-read.
 *
 * ─── STATUS IS DERIVED, AND SO IS EVERYTHING ELSE HERE ─────────────────────────────────────────────────
 *
 * The server derives a plan card's state from the preview and job rows (D6: the job row is the status). This
 * module never stores one either: a card is a function of what the server said, what this mount did, and — for a
 * run it is watching — what the job route last answered.
 *
 * ─── THE WIRE ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * The shapes below hand-mirror server/studio/sessions.ts (ThreadPage, ThreadEntry, AssetView), for the reason
 * use-studio.ts mirrors its own: there is no shared studio type module, and adding one to shared/ is out of lane.
 * A role or kind this build does not know is rendered through a total fallback, never guessed at.
 */
import {
  askCopyFor,
  nextFrameAssetId,
  PICKABLE_ROLES,
  ROLE_LABELS,
  type Attachment,
  type PickableRole,
  type PreviewSeed,
  type StudioFormat,
} from "../../lib/studio-contract";
import type {
  GenerationRun,
  InterpretationLine,
  OutputGate,
} from "../../hooks/use-studio";
import { money } from "./planLogic";

// ─── Constants, mirrored from the server ───────────────────────────────────────────────────────────────

/** A run still going this long reads as stalled — mirrors STALL_AFTER_MS (server/studio/sessions.ts). */
export const STALL_AFTER_MS = 10 * 60_000;
/** How often a watched run is asked about, while the thread is on screen. */
export const POLL_EVERY_MS = 3_000;
/** Retries after the first try — so an append is attempted at most four times. */
export const MAX_APPEND_RETRIES = 3;
/** Ids an entry may name as what went into it — mirrors MAX_REFS. More would be a 400 for the whole entry. */
export const MAX_SENT_REFS = 12;

// ─── The wire ──────────────────────────────────────────────────────────────────────────────────────────

export type CardState =
  | "gone"
  | "made"
  | "failed"
  | "making"
  | "stalled"
  | "not_meant"
  | "blocked"
  | "expired"
  | "checked";
export type RunState = Extract<
  CardState,
  "made" | "failed" | "making" | "stalled"
>;
export type StoppedFor = "product" | "photo";

/** A tray item as stored: an asset id and what it was to her. The role is a string on the wire — see roleLabel. */
export interface WireRef {
  assetId: string;
  role: string;
}

export interface WireMaterial {
  promptEntryId: string | null;
  sent: WireRef[];
  frameAssetId: string | null;
  carriedOn: boolean;
  format: StudioFormat;
}

export interface WireCard {
  lines: InterpretationLine[];
  /** "Not what I meant" was offered with it. Never offered again from the thread — see the header. */
  refusable: boolean;
}

export interface WirePreview {
  status: "ready" | "blocked";
  costUsd: number | null;
  unpriced: boolean;
  expired: boolean;
  rejected: boolean;
  card: WireCard | null;
  askReason: string | null;
  blockingNote: string | null;
}

export interface WireRun {
  jobId: string;
  state: RunState;
  outputIds: string[];
}

interface WireBase {
  id: string;
  seq: number;
  createdAt: string;
}

export type WirePromptEntry = WireBase & {
  kind: "prompt";
  text: string;
  stoppedFor: StoppedFor | null;
};
export type WirePlanEntry = WireBase &
  WireMaterial & {
    kind: "plan";
    previewId: string | null;
    state: CardState;
    preview: WirePreview | null;
    run: WireRun | null;
  };
export type WireAskEntry = WireBase &
  WireMaterial & { kind: "ask"; reason: string };
export type WireEntry = WirePromptEntry | WirePlanEntry | WireAskEntry;

export interface WireAsset {
  mediaType: string | null;
  thumbUrl: string | null;
  /** The full image — outputs only. */
  url: string | null;
  approvalStatus: string | null;
  state: "ok" | "removed";
  /** quality-scrappy (ADI-QS-2): an output's gate, as the job route sends it — absent unless the opt-in gate holds it. */
  gate?: OutputGate;
}

export interface WireSession {
  id: string;
  title: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadPage {
  session: WireSession;
  /** Oldest first. */
  entries: WireEntry[];
  assets: Record<string, WireAsset>;
  /** Pass as `before` for the page above this one. Null: this page starts the thread. */
  earlier: number | null;
}

export interface SessionSummary extends WireSession {
  thumbUrl: string | null;
}

/** What GET /studio/jobs/:jobId answers, as far as the thread reads it. `error` is never shown — it is the engine's. */
export interface JobRead {
  status: string;
  startedAt: string | null;
  assets: {
    assetId: string;
    mediaType: string;
    url: string | null;
    approvalStatus: string | null;
    /** quality-scrappy piece 5: absent unless the server's opt-in output gate held this output back. */
    gate?: OutputGate;
  }[];
}

// ─── Reading the server's answers ──────────────────────────────────────────────────────────────────────

/**
 * WHAT A 404 MEANS DEPENDS ON WHICH ROUTE SAID IT, and the two must not be confused.
 *
 * On the LIST it is the gate: STUDIO_SESSIONS (or STUDIO_ENABLED) is off on this server, so the thread runs
 * session-only — today's lifetime, with the new lifecycle — and nothing tries to save. It is not an error, and
 * the thread says nothing about it.
 *
 * On ONE THREAD it is a thread that has never been appended to: an id minted by "+" or by the door, which the
 * server only creates on the first append (plan §2, "Claims"). That thread is genuinely empty.
 *
 * Anything else that is not a 2xx is a read that FAILED, and a failed read is never rendered as empty: an empty
 * thread would tell her the conversation is gone when the truth is that we could not ask (plan §4).
 */
export type ListRead = "ok" | "unavailable" | "error";
export type ThreadRead = "ok" | "unclaimed" | "error";

export function listReadFor(status: number): ListRead {
  if (status >= 200 && status < 300) return "ok";
  return status === 404 ? "unavailable" : "error";
}

export function threadReadFor(status: number): ThreadRead {
  if (status >= 200 && status < 300) return "ok";
  return status === 404 ? "unclaimed" : "error";
}

/** Where the list stands, as the door needs it. */
export type ListAnswer =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "ok"; sessions: SessionSummary[] };

export type Resolution =
  | { kind: "thread"; sessionId: string }
  | { kind: "waiting" }
  | { kind: "error" };

/**
 * WHICH THREAD THE DOOR OPENS (D2a): the one she named, else her latest open thread, else a new one.
 *
 * A thread she named (Threads, "+") is opened as named — the server decides whether it exists. With none named
 * the door waits for the list, because opening a fresh thread while the list is still loading would hide the one
 * she was in. A list the server has switched off mints (session-only); a list that FAILED does not — it asks her
 * to retry rather than open an empty thread over the one she has.
 */
export function resolveThread(
  named: string | undefined,
  list: ListAnswer,
  mint: () => string,
): Resolution {
  if (named) return { kind: "thread", sessionId: named };
  switch (list.kind) {
    case "loading":
      return { kind: "waiting" };
    case "error":
      return { kind: "error" };
    case "unavailable":
      return { kind: "thread", sessionId: mint() };
    case "ok":
      return {
        kind: "thread",
        // The list is open threads only (the server's default), newest first; `archived` is re-checked anyway so
        // a list that ever widened could not resume an archived thread through the door.
        sessionId: list.sessions.find((s) => !s.archived)?.id ?? mint(),
      };
  }
}

// ─── Saving: the append queue's policy ─────────────────────────────────────────────────────────────────

/**
 * WHAT TO DO WITH ONE APPEND'S ANSWER. Appends never block a send or the spend (plan §4), so a failure here costs
 * the record, never the work — and a retry that cannot succeed is not attempted.
 *
 *   2xx                      done (201 written, 200 replayed — the append is idempotent by entry id)
 *   408, 429, 5xx, network   retry: the server may answer differently in a moment
 *   any other 4xx            fail now: a 400 (a body it refuses), 404 (an id that is not hers) and 409 (the thread
 *                            is full, or the id is taken) are the same answer however often they are asked
 */
export type AppendDisposition = "done" | "retry" | "fail";

export function appendDisposition(
  status: number | "network",
): AppendDisposition {
  if (status === "network") return "retry";
  if (status >= 200 && status < 300) return "done";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "fail";
}

/** Backoff before retry `n` (1-based): 1s, 2s, 4s. Short, because the entry after this one waits on it. */
export function retryDelayMs(retry: number): number {
  return 1000 * 2 ** Math.max(0, retry - 1);
}

/**
 * Why a final failure failed, as far as she needs to know. Only one 409 is hers to act on: the thread is full
 * (the server names `sessionId`). The other 409 — an entry id already taken — and everything else are just "not
 * saved".
 */
export function appendFailureReason(
  status: number | "network",
  field: unknown,
): "full" | "failed" {
  return status === 409 && field === "sessionId" ? "full" : "failed";
}

/** The quiet line under an entry that could not be saved. The one reason worth her words is a full thread. */
export function notSavedLine(reason: "full" | "failed"): string {
  return reason === "full"
    ? "Not saved — this thread is full. Start a new one with +."
    : "Not saved";
}

// ─── Roles ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A stored role, in her words — TOTAL AT RUNTIME, not just in the type.
 *
 * Roles come back off the wire as strings. ROLE_LABELS covers every role this build has, but a thread written by
 * a later build can hold one it has not heard of, and an index into a plain object with an unknown key is not
 * `undefined` for every key: "constructor" and "toString" are properties of every object. So the lookup is
 * own-property only, and anything else is "Attachment" — never a raw enum, never a function printed as text.
 */
export function roleLabel(role: string): string {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)
    ? ROLE_LABELS[role as keyof typeof ROLE_LABELS]
    : "Attachment";
}

/** The role back as something the tray can hold, or null for one the picker cannot make (and so cannot remake). */
export function trayRole(role: string): PickableRole | null {
  return (PICKABLE_ROLES as readonly string[]).includes(role)
    ? (role as PickableRole)
    : null;
}

// ─── The material a check was made from ────────────────────────────────────────────────────────────────

/**
 * WHAT A SEND HANDS THE SHEET — her words and the tray she sent, snapshotted.
 *
 * Every open of the sheet is its own job (`key`), so its preview check, her mask correction and its "Not what I
 * meant" die with it. Check again builds one of these from a stored plan; a send builds one from the tray.
 */
export interface SheetJob {
  key: string;
  promptEntryId: string | null;
  prompt: string;
  attachments: (Attachment & { role: PickableRole })[];
  frameAssetId: string | null;
  carriedOn: boolean;
  format: StudioFormat;
  /**
   * The preview the send already checked for exactly this job (catch-all through the interpreter, C2): the sheet shows
   * it rather than asking again. SESSION-ONLY — `materialOf` picks its fields by name, so it is never stored, and a
   * job rebuilt from the thread (Check again) has none and asks.
   */
  seed?: PreviewSeed;
  /**
   * quality-scrappy piece 5: Try again on an output the gate failed — the gate's reason CODES, so the sheet's fresh
   * check re-quotes with the target's fix. SESSION-ONLY, like `seed`: `materialOf` never stores it.
   */
  corrective?: string[];
}

/**
 * The stored shape of a job's material — ids and closed codes only (plan §2's payload rule).
 *
 * Only attachments with an asset row go (one still uploading cannot have been sent), and at most MAX_SENT_REFS of
 * them: the server refuses a longer list outright, and a refused append loses the whole entry rather than the
 * tail of a list the engine never reads past its first six anyway.
 */
export function materialOf(job: Omit<SheetJob, "key">): WireMaterial {
  return {
    promptEntryId: job.promptEntryId,
    sent: job.attachments
      .filter((a): a is typeof a & { assetId: string } => Boolean(a.assetId))
      .slice(0, MAX_SENT_REFS)
      .map((a) => ({ assetId: a.assetId, role: a.role })),
    frameAssetId: job.frameAssetId,
    carriedOn: job.carriedOn,
    format: job.format,
  };
}

/**
 * ONE APPEND'S BODY — exactly the closed shape server/studio/sessions.ts `parseEntry` accepts, and nothing else.
 * It refuses an unknown key, and a plan or ask missing one, with a 400; a 400 is not retried, so a key added here
 * without the server is an entry lost every time. The test pins the key sets.
 */
export type EntryBody =
  | {
      id: string;
      kind: "prompt";
      text: string;
      payload: { stoppedFor?: StoppedFor };
    }
  | { id: string; kind: "plan"; previewId: string; payload: WireMaterial }
  | { id: string; kind: "ask"; payload: WireMaterial & { reason: string } };

export function promptBody(
  id: string,
  text: string,
  stoppedFor: StoppedFor | null,
): EntryBody {
  return {
    id,
    kind: "prompt",
    text,
    payload: stoppedFor ? { stoppedFor } : {},
  };
}

export function planBody(
  id: string,
  previewId: string,
  job: SheetJob,
): EntryBody {
  return { id, kind: "plan", previewId, payload: materialOf(job) };
}

/** An ask's body. The material it asked about need not have opened a sheet — Create anything's frame ask never does. */
export function askBody(
  id: string,
  reason: string,
  job: Omit<SheetJob, "key">,
): EntryBody {
  return { id, kind: "ask", payload: { ...materialOf(job), reason } };
}

// ─── Superseded plans ──────────────────────────────────────────────────────────────────────────────────

export interface PlanOrder {
  id: string;
  promptEntryId: string | null;
  /** The preview was spent — the plan has a run. */
  consumed: boolean;
}

/**
 * WHICH PLANS RENDER COLLAPSED (plan §2, "Superseded plans"): an UNSPENT plan with a later plan for the same prompt.
 *
 * A mask correction or a Check again makes a second plan for the same words; the first is no longer the one she is
 * deciding on, so it folds to a line. A spent plan never folds — it is where an output came from — and a plan with
 * no prompt to group under (a dangling id) is never anyone's sibling. `plans` is in thread order.
 */
export function supersededIds(plans: PlanOrder[]): Set<string> {
  const out = new Set<string>();
  plans.forEach((p, i) => {
    if (p.consumed || !p.promptEntryId) return;
    if (
      plans
        .slice(i + 1)
        .some((later) => later.promptEntryId === p.promptEntryId)
    )
      out.add(p.id);
  });
  return out;
}

// ─── History: pages → items ────────────────────────────────────────────────────────────────────────────

export type HistoryItem =
  | { kind: "prompt"; key: string; entry: WirePromptEntry }
  | { kind: "ask"; key: string; entry: WireAskEntry }
  | { kind: "plan"; key: string; entry: WirePlanEntry };

export interface History {
  items: HistoryItem[];
  /** Every asset the loaded pages name. */
  assets: Record<string, WireAsset>;
  /** Her words by entry id — what Check again and a plan's grouping read. Includes entries this mount made. */
  prompts: Map<string, string>;
  /** The `before` for "Load earlier", or null when the oldest page is loaded. */
  earlier: number | null;
}

/**
 * THE LOADED PAGES, AS THE THREAD RENDERS THEM — oldest first, one item per entry.
 *
 * `pages` is in fetch order: the newest page first, then each "Load earlier" above it. Entries THIS MOUNT made are
 * left out (`liveIds`) because they are already on screen as live items, and a re-read that included them would
 * show every one twice. A kind this build does not know is skipped, as the server skips one it does not know.
 */
export function toHistory(
  pages: ThreadPage[],
  liveIds: ReadonlySet<string>,
): History {
  const items: HistoryItem[] = [];
  const assets: Record<string, WireAsset> = {};
  const prompts = new Map<string, string>();
  const seen = new Set<string>();
  for (const page of [...pages].reverse()) {
    Object.assign(assets, page.assets);
    for (const e of page.entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.kind === "prompt") prompts.set(e.id, e.text);
      if (liveIds.has(e.id)) continue;
      if (e.kind === "prompt")
        items.push({ kind: "prompt", key: e.id, entry: e });
      else if (e.kind === "ask")
        items.push({ kind: "ask", key: e.id, entry: e });
      else if (e.kind === "plan")
        items.push({ kind: "plan", key: e.id, entry: e });
    }
  }
  return {
    items,
    assets,
    prompts,
    earlier: pages.length ? pages[pages.length - 1].earlier : null,
  };
}

/** The line under a prompt a gate stopped. The gate's own card was transient and is not stored (plan §2). */
export function gateLineFor(stoppedFor: StoppedFor | null): string | null {
  if (stoppedFor === "product")
    return "I needed to see the actual product for this one.";
  if (stoppedFor === "photo") return "I needed a photo of you for this one.";
  return null;
}

// ─── A plan card ───────────────────────────────────────────────────────────────────────────────────────

export interface ThumbView {
  assetId: string;
  uri: string | null;
  label: string;
  removed: boolean;
  /** An IMAGE she can still read: Edit this is offered. */
  editable: boolean;
}

export interface OutputView {
  assetId: string;
  mediaType: string | null;
  uri: string | null;
  removed: boolean;
  editable: boolean;
  rejected: boolean;
  /** quality-scrappy piece 5: the gate failed this output — shown instead of presenting it as done. */
  gate?: Extract<OutputGate, { failed: true }>;
}

export interface PlanCardView {
  key: string;
  state: CardState;
  collapsed: boolean;
  headline: string;
  /** The sentence under the headline, when there is one: why it was blocked, what the run said. */
  note: string | null;
  /** "Here's what we'll do", as she read it. Rendered without "Not what I meant" — see the header. */
  lines: InterpretationLine[] | null;
  builtFrom: ThumbView[];
  outputs: OutputView[];
  /** The inline loading tile, where the image will land. */
  loading: boolean;
  checkAgain: boolean;
  /**
   * The teaching line on a GENERATE she has photos of herself in — null on an edit, and null when she
   * attached none (wave C card 2).
   *
   * She attached a photo of herself and is getting a NEW picture, not a change to that photo. Both are
   * legitimate and the plan is not wrong; what was missing is that nothing said which of the two was
   * happening, or that the other one was a tap away. Frame defaulting made this the normal case: an
   * unmarked photo of hers is her likeness for a new image (CreateAnythingScreen's header), so the
   * commonest send now silently picks the branch she did not ask about.
   *
   * Deliberately NOT an ask and NOT a block — `new_image` and `frame_pick` already ask where a question
   * is warranted. This is the case where nothing is ambiguous and she simply may not know.
   */
  teaching: string | null;
}

/** Only an image can be edited (edits are stills-only), and only one she can still read. */
const isEditable = (
  mediaType: string | null,
  removed: boolean,
  uri: string | null,
) => mediaType === "IMAGE" && !removed && uri !== null;

function headlineFor(state: CardState, preview: WirePreview | null): string {
  switch (state) {
    case "checked":
      if (!preview || preview.unpriced || preview.costUsd === null)
        return "Checked";
      return `Checked · ${money(preview.costUsd)}`;
    case "expired":
      return "That check expired";
    case "gone":
      return "That check is no longer available";
    case "blocked":
      return "This one can't be made as it is";
    case "not_meant":
      return "You said that wasn't what you meant";
    case "making":
      return "Making it…";
    case "stalled":
      return "This one stopped answering";
    case "failed":
      return "That one didn't come out";
    case "made":
      return "Made";
  }
}

/**
 * The blocked card's sentence: the interpreter's own ask when it asked, else the check's own blocking note, else
 * the generic one (the server returns no note for a routing blocker — §11).
 */
function blockedNoteFor(preview: WirePreview | null): string {
  if (preview?.askReason) return askCopyFor(preview.askReason);
  return (
    preview?.blockingNote ??
    "Something this needed wasn't there. Say it another way, or add what's missing."
  );
}

const STALLED_NOTE = "If it finished, it's on your Made shelf.";

/** Check again lives on these states and no others (plan §4): a card whose check could still be made fresh. */
const CHECK_AGAIN_STATES: ReadonlySet<CardState> = new Set([
  "checked",
  "expired",
  "failed",
  "stalled",
]);

/**
 * CAN THIS PLAN BE CHECKED AGAIN — and with what. Null when it cannot.
 *
 * It needs her words (the prompt entry is loaded, or this mount made it) and every photo that went with it still
 * hers and readable. A removed photo is not quietly dropped: dropping it would check a DIFFERENT job — an edit of
 * a photo that is gone would come back as a generate from nothing — and the card would claim to be re-checking
 * hers. So a plan short of a photo offers no Check again, and says why through the Removed tile.
 *
 * ─── THE FRAME IS REPLAYED EXACTLY AS IT WAS SENT (frame defaulting, 2026-09-16) ─────────────────────────
 *
 * A plan sent with no frame — photos of her as references only — checks again with no frame. It used to pick her
 * first photo back up through the mark's old default, so Check again on a reference pack became the very edit the
 * pack was sent to avoid. And a plan saved BEFORE that fix, whose frame was defaulted in at the time, replays with
 * that frame: history is what she was shown, and is not reinterpreted under the new rule.
 */
export function checkAgainJob(
  material: WireMaterial,
  prompt: string | undefined,
  assets: Record<string, WireAsset>,
): Omit<SheetJob, "key"> | null {
  if (!prompt?.trim()) return null;
  const attachments: SheetJob["attachments"] = [];
  for (const ref of material.sent) {
    const role = trayRole(ref.role);
    const asset = assets[ref.assetId];
    if (!role || !asset || asset.state !== "ok") return null;
    attachments.push({
      id: `${role}:${ref.assetId}`,
      role,
      name: ROLE_LABELS[role],
      uri: asset.thumbUrl,
      assetId: ref.assetId,
    });
  }
  return {
    promptEntryId: material.promptEntryId,
    prompt,
    attachments,
    frameAssetId: nextFrameAssetId(attachments, material.frameAssetId),
    carriedOn: material.carriedOn,
    format: material.format,
  };
}

function thumbsFrom(
  sent: WireRef[],
  assets: Record<string, WireAsset>,
): ThumbView[] {
  return sent.map((ref) => {
    const a = assets[ref.assetId];
    const removed = !a || a.state !== "ok";
    const uri = removed ? null : a.thumbUrl;
    return {
      assetId: ref.assetId,
      uri,
      label: roleLabel(ref.role),
      removed,
      editable: isEditable(a?.mediaType ?? null, removed, uri),
    };
  });
}

/** One output, from the thread's asset map (history) — removed ones too, so the thread shows where they were. */
function outputFromAsset(
  assetId: string,
  a: WireAsset | undefined,
): OutputView {
  const removed = !a || a.state !== "ok";
  const uri = removed ? null : (a.url ?? a.thumbUrl);
  return {
    assetId,
    mediaType: a?.mediaType ?? null,
    uri,
    removed,
    editable: isEditable(a?.mediaType ?? null, removed, uri),
    rejected: a?.approvalStatus === "rejected",
    // quality-scrappy (ADI-QS-2): a card reloaded from history shows a failed output as failed, as the live card does.
    ...(!removed && a?.gate && "failed" in a.gate ? { gate: a.gate } : {}),
  };
}

/** One output, from the generate response or the job route — the same shape from both doors. */
export function outputFromRun(a: JobRead["assets"][number]): OutputView {
  const removed = a.url === null;
  return {
    assetId: a.assetId,
    mediaType: a.mediaType,
    uri: a.url,
    removed,
    editable: isEditable(a.mediaType, removed, a.url),
    rejected: a.approvalStatus === "rejected",
    // quality-scrappy piece 5: a failed output carries why, so the card shows that instead of presenting it as done.
    ...(a.gate && "failed" in a.gate ? { gate: a.gate } : {}),
  };
}

/** What a watched run settled on — the job route's answer, laid over a history card. */
export interface RunOverlay {
  state: RunState;
  outputs: OutputView[];
}

/**
 * A HISTORY PLAN CARD. The server's derived state, unless a watch of this mount has since heard the run finish —
 * then the watch's answer, because it is newer than the page.
 */
export function historyPlanView(
  entry: WirePlanEntry,
  ctx: {
    assets: Record<string, WireAsset>;
    prompts: Map<string, string>;
    collapsed: ReadonlySet<string>;
    overlay?: RunOverlay;
  },
): PlanCardView {
  const state: CardState = ctx.overlay?.state ?? entry.state;
  const collapsed = ctx.collapsed.has(entry.id);
  const outputs =
    ctx.overlay?.outputs ??
    (entry.run?.outputIds ?? []).map((id) =>
      outputFromAsset(id, ctx.assets[id]),
    );
  const prompt = entry.promptEntryId
    ? ctx.prompts.get(entry.promptEntryId)
    : undefined;
  return {
    key: entry.id,
    state,
    collapsed,
    headline: collapsed
      ? "Checked again below"
      : headlineFor(state, entry.preview),
    note: noteFor(state, entry.preview, null, outputs),
    lines: entry.preview?.card?.lines.length ? entry.preview.card.lines : null,
    builtFrom: thumbsFrom(entry.sent, ctx.assets),
    outputs: state === "made" ? outputs : [],
    loading: state === "making",
    checkAgain:
      !collapsed &&
      CHECK_AGAIN_STATES.has(state) &&
      checkAgainJob(entry, prompt, ctx.assets) !== null,
    // NULL IN HISTORY ON PURPOSE, not for want of the data — `entry.sent` and `entry.material` carry
    // enough to recompute it. The line ends "tap it to edit that photo instead", and the tray that
    // sentence points at is gone by the time a plan is history: the strip here is a RECORD of what the
    // plan was built from, not a composer she can still change. Teaching a choice she can no longer
    // make is noise on every scroll back through her thread.
    teaching: null,
  };
}

function noteFor(
  state: CardState,
  preview: WirePreview | null,
  runNote: string | null,
  outputs: OutputView[],
): string | null {
  if (runNote) return runNote;
  if (state === "blocked") return blockedNoteFor(preview);
  if (state === "stalled") return STALLED_NOTE;
  if (state === "made" && outputs.length === 0)
    return "It ran, but nothing came back to show. Check your shelf in a moment.";
  return null;
}

// ─── A live plan: this mount's ─────────────────────────────────────────────────────────────────────────

/**
 * A plan THIS MOUNT made: the preview it rendered in the sheet, and — once she approved — the run it started.
 * Live cards render from this, never from a re-read of the page (the re-read leaves them out; see toHistory).
 */
export interface LivePlan {
  entryId: string;
  previewId: string;
  job: SheetJob;
  state: CardState;
  preview: WirePreview;
  /** The run's job, once the server has named one. */
  jobId: string | null;
  outputs: OutputView[];
  /** What the run said, in its own words: a 409's sentence, "already running", an empty result. */
  note: string | null;
  /**
   * PR 19 (K-IO12): she marked a photo and the plan runs as a GENERATE anyway — a pose, an unknown brand's ad — so
   * the card says "This makes a new image". Absent on every other plan.
   */
  newImageFromFrame?: boolean;
}

/** The plan view the sheet rendered, as far as a card needs it — GenerationPlanView's fields, loosely coupled. */
export interface SheetPlan {
  previewId: string | null;
  canGenerate: boolean;
  jobCostUsd: number | null;
  unpriced: boolean;
  blockers: string[];
  interpretation: { lines: InterpretationLine[] } | null;
  card: { lines: InterpretationLine[] } | null;
  /** PR 19 (K-IO12): the plan's routed intent, when STUDIO_IMAGE_OPS set it. */
  intent?: string;
}

/**
 * THE CARD A PREVIEW LEAVES IN THE THREAD, the moment it lands in the sheet.
 *
 * Checked when the server said it could be made; blocked, with the check's own first blocker, when it could not.
 * The lines are the ones she read in the sheet — the interpreter's, else the rules' (A3b), which is the order the
 * server's history read uses, so a live card and its later history card say the same thing.
 */
export function livePlanFrom(
  entryId: string,
  job: SheetJob,
  plan: SheetPlan & { previewId: string },
): LivePlan {
  const lines = plan.interpretation?.lines.length
    ? plan.interpretation.lines
    : (plan.card?.lines ?? []);
  const blocked = !plan.canGenerate;
  return {
    entryId,
    previewId: plan.previewId,
    job,
    state: blocked ? "blocked" : "checked",
    preview: {
      status: blocked ? "blocked" : "ready",
      costUsd: plan.jobCostUsd,
      unpriced: plan.unpriced,
      expired: false,
      rejected: false,
      card: lines.length
        ? { lines, refusable: Boolean(plan.interpretation?.lines.length) }
        : null,
      askReason: null,
      blockingNote: blocked ? (plan.blockers[0] ?? null) : null,
    },
    jobId: null,
    outputs: [],
    note: null,
    ...(plan.intent === "image.generate" && job.frameAssetId !== null
      ? { newImageFromFrame: true }
      : {}),
  };
}

export function livePlanView(
  plan: LivePlan,
  ctx: { collapsed: ReadonlySet<string>; mediaTypes: Record<string, string> },
): PlanCardView {
  const collapsed = ctx.collapsed.has(plan.entryId);
  const builtFrom: ThumbView[] = plan.job.attachments
    .filter((a): a is typeof a & { assetId: string } => Boolean(a.assetId))
    .map((a) => ({
      assetId: a.assetId,
      uri: a.uri,
      label: roleLabel(a.role),
      removed: false,
      editable: isEditable(ctx.mediaTypes[a.assetId] ?? null, false, a.uri),
    }));
  return {
    key: plan.entryId,
    state: plan.state,
    collapsed,
    headline: collapsed
      ? "Checked again below"
      : headlineFor(plan.state, plan.preview),
    note: noteFor(plan.state, plan.preview, plan.note, plan.outputs),
    lines: plan.preview.card?.lines.length ? plan.preview.card.lines : null,
    builtFrom,
    outputs: plan.state === "made" ? plan.outputs : [],
    loading: plan.state === "making",
    checkAgain:
      !collapsed &&
      CHECK_AGAIN_STATES.has(plan.state) &&
      plan.job.prompt.trim().length > 0,
    teaching: teachingFor(plan.job, plan.newImageFromFrame === true),
  };
}

/**
 * "This makes a new image", said once, on the plan that makes one from a photo of her.
 *
 * A generate is `frameAssetId === null` — there is no photo being changed. It only needs saying when she
 * actually attached one of herself, because that is the only case where she has something on screen that
 * COULD have been edited and was not. With no photo attached there is no misreading available.
 */
const NEW_IMAGE_LINE =
  "This makes a new image. Your photo is a reference for how you look — tap it to edit that photo instead.";

function teachingFor(job: SheetJob, fromFrame = false): string | null {
  // PR 19 (K-IO12): a marked frame the plan runs as a GENERATE (a pose, an unknown brand's ad) is a new image too.
  // ⚠️ MUTATION M-K12: drop this line — "pose from a marked frame says This makes a new image" reds by name.
  if (fromFrame) return NEW_IMAGE_LINE;
  if (job.frameAssetId !== null) return null;
  const hasHer = job.attachments.some(
    (a) => a.role === "source-frame" && Boolean(a.assetId),
  );
  return hasHer ? NEW_IMAGE_LINE : null;
}

// ─── The run ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE GENERATE RESPONSE MAKES OF THE CARD — mirroring MakeItRoute's reading of the same response.
 *
 * An asset with a url is the result, whatever the status says: an `already_running` whose job has since finished
 * comes back with its assets, and they are hers to see. With none, an `already_running` is a run still going
 * (an identical tap already bought it — same job, one charge), so the card watches that job; a `succeeded` with
 * nothing to show says so rather than showing an empty frame.
 */
export type RunUpdate =
  | { state: "made"; jobId: string; outputs: OutputView[]; note: string | null }
  | { state: "making"; jobId: string; note: null };

export function afterGenerate(run: GenerationRun): RunUpdate {
  const outputs = run.assets.map(outputFromRun);
  if (outputs.some((o) => o.uri))
    return { state: "made", jobId: run.jobId, outputs, note: null };
  if (run.status === "already_running")
    return { state: "making", jobId: run.jobId, note: null };
  return {
    state: "made",
    jobId: run.jobId,
    outputs,
    note: "It ran, but nothing came back to show. Check your shelf in a moment.",
  };
}

/**
 * WHAT A FAILED GENERATE MEANS FOR THE CARD.
 *
 * An HTTP answer is the server's decision — a 409's sentence, a held capability — and the card says it, with
 * Check again. A NETWORK failure is not an answer at all: the request may have reached the server and the run may
 * be going (nothing aborts it on a disconnect — plan §1b), so saying "didn't come out" could send her to pay for
 * it twice. That one is `lost`, and the thread goes and looks (the plan's run, on a re-read) before it says anything.
 * fetch throws a TypeError for a network failure on both surfaces; every HTTP failure here is a plain Error.
 */
export type GenerateFailure =
  | { kind: "lost" }
  | { kind: "failed"; note: string };

export function generateFailure(err: unknown): GenerateFailure {
  if (err instanceof TypeError) return { kind: "lost" };
  return {
    kind: "failed",
    note:
      err instanceof Error && err.message
        ? err.message
        : "Something went wrong making this.",
  };
}

/** The sentence when a lost run could not be found again (no re-read, or no run on it). */
export const LOST_NOTE =
  "We lost the connection while this was making. If it finished, it's on your Made shelf.";

/**
 * WHAT A LOST RUN TURNED OUT TO BE — the thread re-reads its own plan entry (a moment after the connection
 * dropped) and goes by what the server derived:
 *
 *   the preview was spent (a run)   → making, on that job: the watch reads it and lands the image, or the failure
 *   it was never spent              → failed: the approval did not reach the server, so there is nothing running to
 *                                     watch — and Check again is the way to try once more
 *   no entry, or the read failed    → stalled, with LOST_NOTE: we do not know, and say where to look
 *
 * The one claim it never makes is "it didn't come out" about a run that might still be going.
 */
export function recoverLost(
  entry: WirePlanEntry | null | "error",
):
  | { state: "making"; jobId: string; note: null }
  | { state: "failed" | "stalled"; jobId: null; note: string } {
  if (entry === "error" || entry === null) {
    return { state: "stalled", jobId: null, note: LOST_NOTE };
  }
  if (entry.run) return { state: "making", jobId: entry.run.jobId, note: null };
  if (entry.state === "gone") {
    return { state: "stalled", jobId: null, note: LOST_NOTE };
  }
  return {
    state: "failed",
    jobId: null,
    note: "That didn't go through. Check again to try once more.",
  };
}

/**
 * THE WATCH'S DECISION after each read of the job route (plan §4: every 3 s while the thread is on screen, stopping
 * on a terminal state or after 10 minutes).
 *
 *   succeeded                 made — the image goes in, in place
 *   failed, canceled          failed
 *   the job isn't readable    stalled — a 404 is not-found or not-yours, and neither will change by asking again
 *   10 minutes of watching    stalled — nothing reaps a job whose instance died, so a watch must end on its own
 *   anything else             keep watching; a read that failed (5xx, network) is asked again on the next tick
 */
export type PollOutcome = "continue" | "made" | "failed" | "stalled";

/**
 * WHAT KIND OF RUN IS BEING WATCHED — and the only thing it decides is how long a watch may live.
 *
 * An image is generated INLINE inside the generate request, so by the time anything is watched the
 * work is already done and the watch is pure reconnect-and-refresh. A video is not: the request
 * queues a job and a leased runner works it (server/studio/videoRunner.ts), which is why it needs
 * its own clock. Defaulted everywhere, so a caller that never heard of video is an image and
 * behaves exactly as it did before this existed.
 */
export type WatchKind = "image" | "video" | "stitch";

/**
 * HOW LONG A VIDEO WATCH MAY LIVE — finite, and deliberately longer than an image's.
 *
 * ⚠️ 10 MINUTES IS THE WRONG NUMBER FOR A CLIP, and using it was a false stall rather than a
 * conservative one. The server's per-tick poll budget is `videoPoll().maxMs`, which defaults to
 * 600_000 — EXACTLY `STALL_AFTER_MS`. A clip that needs a second tick therefore outlives the
 * client's clock while it is still running and about to succeed, and the watch that gave up on it
 * never looks again (studio/videoRunner.ts returns "deferred" on a spent budget precisely so the
 * next tick resumes it).
 *
 * A lease handoff adds another budget on top of that, bounded by `maxAttempts()` (5 by default,
 * studio/videoJobs.ts). Three budgets is the honest allowance for the ordinary case — one submit
 * plus two resumes — and it is a CEILING, not an expectation: the watch ends the instant the job
 * reaches a terminal status, which is how it ends on nearly every run.
 *
 * What it must never be is infinite. A watch that cannot end is the leak this whole mechanism is
 * written against, so a number that is too generous is still a number.
 */
export const VIDEO_STALL_AFTER_MS = 3 * STALL_AFTER_MS;

/**
 * The wall clock a watch of this kind dies on. Finite for all three, by construction.
 *
 * A STITCH REUSES THE VIDEO CLOCK, and the reason is worth writing down because the arithmetic
 * looks like it argues for a longer one. Server worst case is `maxAttempts` (3) × `leaseMs`
 * (20 min) = SIXTY MINUTES, against this clock's thirty — so a stitch on its third handoff
 * outlives the watch while it is still alive and still going.
 *
 * That is not a bug to be fixed with a bigger number. It is precisely what `VideoEntryPhase`
 * distinguishes: `unknown` means "nothing says it went wrong, only that we stopped being able to
 * tell", which is exactly true of a job that is still being handed between runners after half an
 * hour. Showing `failed` there would be a lie; watching forever is the leak this whole mechanism
 * exists to prevent. Thirty minutes of looking, then say so honestly.
 */
export function watchLimitMs(kind: WatchKind = "image"): number {
  return kind === "image" ? STALL_AFTER_MS : VIDEO_STALL_AFTER_MS;
}

/**
 * What GET /studio/stitch/:id answers, on the wire.
 *
 * Deliberately NOT the job route's shape: a stitch produces exactly ONE file, so the route says
 * `asset` rather than `assets`, and its id is a `stitchId`. Both are correct for what they
 * describe, and neither is what the watch downstream expects.
 */
export interface StitchRead {
  stitchId: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  asset: JobRead["assets"][number] | null;
}

/**
 * THE WHOLE ADAPTER, and the reason nothing downstream of it changed.
 *
 * A stitch read becomes a `JobRead` here, at the FETCH BOUNDARY — one file becomes a list of one,
 * and everything else already lines up because studio_stitch_jobs shares the status vocabulary
 * exactly (`queued` / `running` / `succeeded` / `failed` / `canceled`, 0057's CHECK). So
 * `pollOutcome`, `pollProgress` and `videoEntryFromJob` are untouched, and V4's claim — that an
 * entry is a VIDEO and not a generation result, so a second pipeline is an adapter and not a
 * rewrite — holds without a line changing in videoEntryLogic.ts.
 *
 * Normalising HERE rather than downstream is the load-bearing choice. One function knows the
 * stitch route's shape; if the mapping were pushed into the view model instead, every consumer
 * would have to learn that a clip can arrive two ways.
 */
export function jobReadFromStitch(read: StitchRead): JobRead {
  return {
    status: read.status,
    startedAt: read.startedAt,
    assets: read.asset ? [read.asset] : [],
  };
}

/**
 * WHERE A RUN HAS GOT TO, when it has not finished — the states `PollOutcome` deliberately does not
 * have, because none of them is a settlement.
 *
 *   queued   the approval is spent and the job is owed, and NO provider call has been made yet.
 *            Video only: it is the state that lets POST /studio/generate return without blocking
 *            on a clip (migrations/0056). An image is never seen in it, because an image is
 *            already generated by the time anything watches it.
 *   running  a runner holds the lease and is submitting or polling.
 *
 * ⚠️ `queued` AFTER `running` IS NOT A REGRESSION AND IS NOT AN ERROR. The server's reaper returns
 * a job whose holder died to `queued` KEEPING `provider_operation_name`, so the next runner resumes
 * polling an operation that is already paid for (studio/videoJobs.ts, reapExpiredLeases step 3).
 * The back-edge is the system working. Anything that reads it as terminal, or restarts a clock on
 * it, has turned a healthy handoff into a false failure.
 */
export type RunPhase = "queued" | "running";

/**
 * The phase a read reports, or null when the read settles the watch or says nothing.
 *
 * Null for a terminal status, for a 404 and for a failed read — the first is `pollOutcome`'s to
 * answer and the other two are not news about the job at all. A tick that cannot reach the server
 * must not be allowed to look like progress.
 */
export function pollProgress(
  read: JobRead | "missing" | "error",
): RunPhase | null {
  if (read === "missing" || read === "error") return null;
  if (read.status === "queued") return "queued";
  if (read.status === "running" || read.status === "pending") return "running";
  return null;
}

export function pollOutcome(
  read: JobRead | "missing" | "error",
  watchStartedAt: number,
  now: number,
  /**
   * Defaulted to `image`, which is what every caller that predates video passes by saying nothing.
   * With it defaulted this function's answers are byte-identical to what they were before video
   * existed — including for a `queued` read, which has always fallen through to `continue` and
   * still does, now on purpose rather than by accident.
   */
  kind: WatchKind = "image",
): PollOutcome {
  if (read === "missing") return "stalled";
  if (read !== "error") {
    // quality-scrappy piece 5: a clip's gate lands after `succeeded` — while the server says it is still being checked,
    // it is not yet made, and the watch keeps going (bounded by the same limit as any other wait).
    if (
      read.status === "succeeded" &&
      read.assets?.some((a) => a.gate && "pending" in a.gate)
    )
      return now - watchStartedAt >= watchLimitMs(kind)
        ? "stalled"
        : "continue";
    if (read.status === "succeeded") return "made";
    if (read.status === "failed" || read.status === "canceled") return "failed";
  }
  return now - watchStartedAt >= watchLimitMs(kind) ? "stalled" : "continue";
}

/**
 * WHICH HISTORY RUNS THE THREAD WATCHES (the resume rule): every plan the server says is still making, unless this
 * mount has already heard it settle. A stalled plan is not watched — the server has already said it is too old to
 * trust as running — and a made or failed one has nothing left to hear.
 */
export function runsToWatch(
  items: HistoryItem[],
  overlays: Record<string, RunOverlay>,
): { entryId: string; jobId: string }[] {
  return items.flatMap((it) =>
    it.kind === "plan" &&
    it.entry.state === "making" &&
    it.entry.run &&
    !overlays[it.entry.id]
      ? [{ entryId: it.entry.id, jobId: it.entry.run.jobId }]
      : [],
  );
}

// ─── The composer ──────────────────────────────────────────────────────────────────────────────────────

type TrayItem = Attachment & { role: PickableRole };

/**
 * CONTINUATION — in a thread, the next thing she says is about the last thing it made.
 *
 * With NOTHING in the tray, her next send's frame defaults to the thread's latest image she can still edit — the
 * same asset Edit this would put there, through the same plumbing (`editFromChat`). Without it, "make it warmer"
 * after a result landed was a brand-new image from her words alone (with no photo the server allows GENERATE and
 * nothing else), and "put the cap on me" was stopped to ask for a photo of her when one was on screen.
 *
 * Only an empty tray: anything she attached is her say over what this job is made from, and is never added to.
 * The latest editable output wins — `cards` is in thread order, and a removed or non-image output is passed over
 * for the one before it. She can decline it (`dismissed`, the indicator's ×): then this send starts fresh, and
 * nothing older stands in for the image she just said no to.
 *
 * What "it" means is NOT resolved here — "make it blue" still reaches the check as her words. That is the memory
 * PR's (plan §6, InterpretationInput.prior), on the server.
 */
export function continuationFrame(
  cards: Pick<PlanCardView, "state" | "outputs">[],
  tray: readonly unknown[],
  dismissed: string | null,
): { assetId: string; uri: string } | null {
  if (tray.length > 0) return null;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].state !== "made") continue;
    const out = [...cards[i].outputs]
      .reverse()
      .find((o) => o.editable && o.uri !== null);
    if (!out || out.uri === null) continue;
    return out.assetId === dismissed
      ? null
      : { assetId: out.assetId, uri: out.uri };
  }
  return null;
}

/**
 * EDIT THIS — an image in the thread becomes the frame being edited, explicitly.
 *
 * It goes in the tray as HER media (`source-frame`), and the mark moves to it. That is the difference from
 * attaching the same photo from the library, where a second photo of hers is a question ("which one am I working
 * on?"): here the tap IS the answer, so nothing is asked, and whatever was marked before stays in the tray as
 * material rather than as the frame. A photo already in the tray as hers is marked, not added twice.
 */
export function editFromChat(
  tray: TrayItem[],
  asset: { assetId: string; uri: string | null },
): { tray: TrayItem[]; frameAssetId: string } {
  const already = tray.some(
    (a) => a.role === "source-frame" && a.assetId === asset.assetId,
  );
  return {
    tray: already
      ? tray
      : [
          ...tray,
          {
            id: `source-frame:${asset.assetId}`,
            role: "source-frame",
            name: ROLE_LABELS["source-frame"],
            uri: asset.uri,
            assetId: asset.assetId,
          },
        ],
    frameAssetId: asset.assetId,
  };
}

/**
 * "NOT WHAT I MEANT" puts her sentence back in the composer (D5) — and the photos it was about.
 *
 * Refusing a reading is not refusing the request: she will say the same thing another way, about the same photo,
 * and a composer that came back without it would turn "make it moodier, but only the sky" into a generate from
 * nothing. So the tray she sent comes back with the words — unless she has already put something in the tray,
 * which is hers and is never merged with or replaced. The same rule holds for words she has typed since.
 *
 * The frame comes back exactly as it went (frame defaulting, 2026-09-16): a job with no frame restores a tray of
 * references with no badge on any of them, never her first photo re-marked.
 */
export function composerAfterReject(
  now: { draft: string; tray: TrayItem[]; frameAssetId: string | null },
  refused: SheetJob,
): { draft: string; tray: TrayItem[]; frameAssetId: string | null } {
  const restoreTray = now.tray.length === 0;
  return {
    draft: now.draft.trim() ? now.draft : refused.prompt,
    tray: restoreTray ? refused.attachments : now.tray,
    frameAssetId: restoreTray
      ? nextFrameAssetId(refused.attachments, refused.frameAssetId)
      : now.frameAssetId,
  };
}

// ─── The threads list ──────────────────────────────────────────────────────────────────────────────────

/** A row's time, the way a chat list says it. Never a raw ISO string — that is what the stub rendered. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
