import { useState, useRef, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import { markConversationSeen } from "../lib/milaUnread";
import { AGENT_V3 } from "../lib/flags";
import { advancePlanCard, applyPlanFollowUp, PLAN_FOLLOW_MAX_MS, PLAN_FOLLOW_POLL_MS, runningPlanRunId, stillPlanning, type ConversationRow } from "../lib/agent/planFollowUp";
import type { AgentGoalsResponse } from "../../shared/plan";
// Type-only: erased at compile, so this never pulls the web-only voice session
// (or livekit-client) into a native bundle.
import type {
  ParsedWidgetPush,
  TranscriptUpdate,
} from "../components/mila/voiceSession";
import {
  createTranscriptTracker,
  planTranscriptUpdate,
  type TranscriptTracker,
} from "./transcriptCollapse";

// React Native's built-in fetch (whatwg-fetch/XHR) never exposes a streaming
// `res.body`, so SSE can't be read incrementally on device. expo/fetch is the
// WinterCG fetch whose response body IS a ReadableStream. On web it resolves
// (via .web.ts) to `globalThis.fetch`, so the browser streaming path is
// unchanged. The SSE reader/parser below is identical to before — only the
// transport swapped.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MilaContext {
  // The screen the chat was launched from — seeds context-aware openers, and the
  // server turns it into a one-line "where the athlete is" hint. "deal"/"score"
  // are item-level; the rest are the launching tab.
  // "onboarding" is the first entry (OnboardingScreen): id is the workflow run id, the
  // server appends the first-entry block and offers the onboarding tools for that turn.
  // "record" is one fact on Brand › Facts (id = the record field): the server says which.
  type: "deal" | "score" | "deals-list" | "brand" | "studio" | "profile" | "onboarding" | "record";
  id?:  string;
  // Display-only brand name for a "deal" context, so the fresh-chat greeting can
  // read "Questions about the {brand} deal?". Optional + presentational — the
  // server ignores it; blank/absent falls back to "Questions about this deal?".
  brandName?: string;
}

// ─── Widgets ────────────────────────────────────────────────────────────────
// Wire shape mirrored from the server (server/mila/types.ts). A widget is an
// already-safe, scalar-only view a tool result attaches so the chat can render
// a card inline. It never carries raw jsonb or thread/email text.

export interface DealCardWidgetData {
  id:           string;
  brandName:    string;
  brandDomain:  string | null;
  category:     "PAID" | "MEDIA" | "EDITORIAL" | "GIFTING";
  status:       string;
  offerAmount:  string | null;
  timeAgo:      string;
  // null when the scorer never ran — the card renders "Not scored yet", not "5/10 Fair".
  verdict:      "poor" | "fair" | "good" | "great" | null;
  scoreNumeric: number | null;
}

// deal_list — an N-deal answer (list_deals) as an ordered stack of the SAME
// deal_card items above, capped at 5 server-side. Each element is a plain
// DealCardWidgetData (scalars + dealId only) — nothing a single card doesn't
// carry. One widget, one message.widget field; the array lives inside.
export interface DealListWidgetData {
  deals: DealCardWidgetData[];
}

// reply_action — the one INTERACTIVE widget: it renders the reused Draft Reply
// sheet inline so the athlete can review/edit/send a brand reply on a deliberate
// tap. `draft` is the single free-text field a widget may carry — the athlete's
// OWN app-generated, strip-guarded outgoing copy (never thread/email/scoring
// text), rendered only into an editable input. No pendingActionId: the send is
// propose-at-tap, bound to this widget's own dealId/threadId (see the send hook).
export type ReplyActionParams = {
  replyIntent:     "accept" | "negotiate" | "request_terms" | "decline";
  style:           "friendly" | "professional";
  voice:           "athlete" | "agent";
  selectedTerms:   string[];
  includeMediaKit: boolean;
};

export interface ReplyActionWidgetData {
  dealId:    string;
  threadId:  string | null;
  platform:  string;
  sendable:  boolean;
  brandName: string;
  draft:     string | null;
  refusal:   string | null;
  // Voice-opened card: the body does not exist yet and THIS CLIENT generates it,
  // over its own authenticated session. That is what keeps brand-derived draft
  // prose out of the worker, the model and the data channel. Absent on the text
  // path, where `draft` already carries the copy. See server/mila/types.ts.
  //
  // DURABLE — it is persisted with the card and is still true after a reload,
  // because the card still has no body. It says the draft is MISSING, not that
  // anything should be done about it right now.
  needsDraft?: boolean;
  // CLIENT-ONLY, never persisted and never set by the server: this card arrived
  // live over the widget bridge a moment ago, so generating its body immediately
  // is what the athlete just asked for.
  //
  // The two are separate because conflating them was expensive. `needsDraft`
  // alone drove auto-generation, so every reply_action card in a conversation
  // re-generated on every reopen — fifteen stale cards fired six Vertex streams
  // in twelve seconds, blew the 6/min limit, and billed for drafts nobody asked
  // for. Only `parseWidgetPush` sets this, and only a live packet reaches it.
  autoDraft?: boolean;
  params:    ReplyActionParams;
}

// onboarding_update — the first-entry receipt card (server/mila/types.ts). `saved[].value` is
// the athlete's OWN words about themself (vocabulary- and length-checked server-side), shown
// as a receipt line with Undo; everything else is an id or enum.
export interface OnboardingSavedFact {
  field:         string;
  label:         string;
  value:         string;
  agentActionId: string | null;
}
export interface OnboardingUpdateWidgetData {
  runId: string;
  step:  "greet" | "doors";
  saved: OnboardingSavedFact[];
  next:  "doors" | "done";
  door:  "profile" | "deals" | null;
}

// goal_change — a goal change Mila proposed (server/mila/types.ts). It writes nothing: the card's button calls the same
// goal routes the app's sheets call, so only her tap changes a goal. `goal` / `howSheKnows` / `currentGoal` are her goal
// line, length-capped server-side; everything else is an id or enum.
export interface GoalChangeWidgetData {
  change:      "add" | "edit" | "remove";
  goalId:      string | null;
  goal:        string;
  domain:      string;
  byWhen:      "this_season" | "next_12_months" | "multi_year" | null;
  howSheKnows: string | null;
  removeAs:    "achieved" | "not_for_me" | null;
  currentGoal: string | null;
}

// shop_item — a pick Mila got ready for her shelf (server/mila/types.ts). It writes nothing: the card's button adds a
// DRAFT through POST /me/shop/items. `title` / `store` are the store page's own words (one line, clipped server-side);
// `suggestedBlurb` is Mila's suggestion and is drawn as one, never as her words.
export interface ShopItemWidgetData {
  url:              string;
  host:             string;
  title:            string;
  store:            string | null;
  imageUrl:         string | null;
  priceCents:       number | null;
  currency:         string | null;
  source:           "amazon" | "shopify" | "ltk" | "shopmy" | "link";
  networkTag:       string | null;
  category:         string | null;
  amazonWithoutTag: boolean;
  shelfOpen:        boolean;
  warnings:         Array<{ code: string; text: string }>;
  suggestedBlurb:   string | null;
}

export type MilaWidget =
  | { type: "deal_card";       data: DealCardWidgetData }
  | { type: "deal_list";       data: DealListWidgetData }
  | { type: "reply_action";    data: ReplyActionWidgetData }
  | { type: "onboarding_update"; data: OnboardingUpdateWidgetData }
  | { type: "goal_change";     data: GoalChangeWidgetData }
  | { type: "shop_item";       data: ShopItemWidgetData };

// ─── Nav-chips ────────────────────────────────────────────────────────────────
// Mirrored from the server (server/mila/types.ts). A read-only shortcut to an
// existing screen — the target is semantic (the client maps "score" → Brand tab,
// "deal" → that deal's Thread screen). It NEVER drafts, replies, or sends.
// MainTabNavigator.handleNavigate maps each variant to a real React-Navigation call.

export type MilaNavTarget =
  | { screen: "deal"; threadId: string; brandName?: string }
  // Checkpoint 1: open the EXISTING upload surface for one of her requests (the overlay handles these in place).
  | { screen: "add_contract"; requestId: string }
  | { screen: "add_document"; requestId: string }
  | { screen: "deals" }
  | { screen: "score" }
  | { screen: "signals" }
  | { screen: "profile" }
  | { screen: "studio" }
  | { screen: "pitches" }
  | { screen: "media" }
  // PR B — the Brand tab's own screens (Deck, Rates) and tabs (Facts, Story).
  | { screen: "deck" }
  | { screen: "rates" }
  | { screen: "facts" }
  | { screen: "story" }
  // AGENT_V3 open_screen (shared/agent.ts OPEN_SCREENS): Home, Goals (optionally one goal), Me (optionally a scouting
  // report section). What Nomila knows rides on "facts" above.
  | { screen: "home" }
  | { screen: "goals"; goalId?: string }
  | { screen: "me"; section?: string }
  // EXPO_PUBLIC_CAMERA_ROLL_INTAKE: the camera-roll review — `ask` its filter (check_camera_roll's card), `prepared` to
  // open the review the app-open check already scored (Mila's one-tap offer).
  | { screen: "camera_roll"; ask?: string; prepared?: boolean }
  // Mila's deal and booking cards (AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS): one deal's detail by its opportunity id
  // (closed ones read-only), her past deals, one booking.
  | { screen: "opportunity"; opportunityId: string }
  | { screen: "deals_closed" }
  | { screen: "booking"; bookingId: string }
  // The legacy chat deal card's tap: the deal by its deal id (DealDetailRoute opens its ONE detail under the board).
  | { screen: "deal_detail"; dealId: string };

export interface MilaNavChip {
  label:  string;
  target: MilaNavTarget;
}

// ─── Profile-update candidates (Phase-3 durable memory) ────────────────────────
// Mirrored from the server (server/mila/profileFields.ts). A candidate durable
// profile update the extraction pass PROPOSED from a turn. It is never persisted
// on its own — the client renders a confirm card and only an explicit Save tap
// calls PATCH /me/profile/*. `achievement` is display-only (persistable:false):
// there is no endpoint, so its card is honest that it is NOT saved to the profile.
export interface MilaBrandVoice {
  tone?:    string;
  phrases?: string[];
  avoid?:   string[];
}

export type ProfileUpdateField =
  | "goal"
  | "secondary_goals"
  | "brand_voice"
  | "achievement";

export interface ProfileUpdateCandidate {
  field:       ProfileUpdateField;
  label:       string;
  value:       string | string[] | MilaBrandVoice;
  persistable: boolean;
}

/** One thing the athlete attached to a turn — already a media-library asset. */
export interface ChatAttachment {
  assetId:  string;
  role:     "photo" | "video" | "product";
  /** For the bubble's thumbnail row; null renders a role glyph instead. */
  thumbUrl: string | null;
}

export interface MilaMessage {
  id:           string;
  role:         "user" | "assistant";
  content:      string;
  // What the athlete attached with this turn (the composer's ＋). Display only here; the
  // server resolved the ids against their own library before the turn ran.
  attachments?: ChatAttachment[];
  streaming?:   boolean;
  // Context-aware loading phrase from the server (statusLabels.ts) — shown while
  // this message streams with no content yet; render falls back to "Thinking…".
  statusMessage?: string;
  error?:       string;
  suggestions?: string[];       // ask-chips: prefill a follow-up question
  actions?:     MilaNavChip[];  // nav-chips: navigate to an existing screen
  widget?:      MilaWidget;
  // Proposed durable profile updates (Phase-3) — rendered as confirm cards under
  // the answer. Persisted ONLY on an explicit Save tap; never automatically.
  profileUpdates?:   ProfileUpdateCandidate[];
  // AGENT_V3 (shared/agent.ts AgentDoneFields, additive on `done`): the harness's cards, drawn under the answer in order,
  // and the run id that opens "How I got this". Kept as the wire sent them; the renderer skips kinds it doesn't know.
  cards?:            unknown[];
  runId?:            string;
  // A reopened chat: the row's server id (a notification can open the chat ON it), and whether Mila started it from an
  // app event (EXPO_PUBLIC_MILA_PROACTIVE).
  serverId?:         string;
  milaStarted?:      boolean;
}

/**
 * What the in-flight text reply is doing RIGHT NOW, from the stream's own events — the signal
 * behind Mila's avatar and status pill (components/mila/milaActivity.ts):
 *   thinking — sent, nothing back yet; or a `status` event with phase "thinking" (the model is
 *              deciding a round)
 *   tool     — a `status` event with phase "tool": a tool round is running on the server
 *   writing  — answer tokens are arriving
 *   idle     — no reply in flight (done, stopped, failed, reset)
 * Only the request that owns the stream moves it, so a superseded turn's late events cannot.
 */
export type ChatPhase = "idle" | "thinking" | "tool" | "writing";

// Matches the server's DEFAULT_STATUS (server/mila/statusLabels.ts). Only used to read a status
// event from a server that predates the `phase` field: any other phrase there was a tool's.
const DEFAULT_STATUS_PHRASE = "Thinking…";

// Human text for non-stream HTTP failures — never surface a raw server body
// like "Internal server error".
const ERROR_RATE_LIMIT =
  "You've hit the message limit for this hour — try again shortly";
const ERROR_UNREACHABLE =
  "Mila couldn't reach your data just now — try again in a moment.";
const ERROR_NETWORK =
  "Mila is unavailable — check your connection and try again.";

// ─── The one continuing thread ────────────────────────────────────────────────
// Every Ask Mila surface (the Mila tab, Home's half-sheet) is its own useMilaChat instance, but they are ONE
// conversation: the instance that starts, opens or adds to a thread publishes it here, and another surface adopts it
// (re-reading the persisted turns) when it is next shown — see syncToActiveThread. `rev` moves on every finished turn,
// so a surface knows its transcript is behind even when the id is the same. Module state, one per app session.
const activeThread: { id: string | null; rev: number } = { id: null, rev: 0 };

/** The shared thread right now (a copy) — exported for tests. */
export function activeMilaThread(): { id: string | null; rev: number } {
  return { ...activeThread };
}

/** Test seam: forget the shared thread. */
export function resetActiveMilaThreadForTests(): void {
  activeThread.id = null;
  activeThread.rev = 0;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMilaChat() {
  const [streaming, setStreaming] = useState(false);
  const [messages,  setMessages]  = useState<MilaMessage[]>([]);
  const [phase,     setPhase]     = useState<ChatPhase>("idle");
  // Read by syncToActiveThread: never swap the transcript under a reply still arriving.
  const streamingRef = useRef(false);
  streamingRef.current = streaming;

  // Abort the in-flight request (safeguard 8 — concurrent cancellation)
  const abortRef = useRef<AbortController | null>(null);

  // Monotonic id source — survives reset() so list keys never collide.
  const idRef = useRef(0);

  /**
   * Live-transcript bookkeeping. A ref, not state: it is written from a stream
   * callback that fires per word, and nothing renders off it directly.
   *
   * The rule that reads and advances it lives in ./transcriptCollapse — one
   * spoken utterance opens several streams, and deciding which line each belongs
   * to is the part worth testing without a room. See appendTranscript.
   */
  const txRef = useRef<TranscriptTracker>(createTranscriptTracker());

  /**
   * Wholesale replacements of the message list invalidate every mapping — the
   * ids those streams were filling no longer exist. Called by reset/newChat/
   * openConversation, which is the degrade rule in code: live turns are only
   * ever APPENDED to live state, and a load REPLACES rather than merges, so a
   * pushed turn and a persisted turn can never both render.
   */
  const resetTranscript = useCallback(() => {
    txRef.current.streamToId.clear();
    txRef.current.lastUser = null;
  }, []);

  // The continuing conversation id (Phase 1 memory). Minted once, lazily, and
  // held for the life of this hook instance — the Ask Mila overlay is always
  // mounted, so it survives the sheet closing + reopening (context persists).
  // Sent with every turn; ONLY newChat() rotates it. Closing does NOT.
  //
  // ── Voice shares this thread by TRANSPORT, not by configuration ─────────────
  // This id is handed to the voice token endpoint when a call starts, which
  // resolves it against the authenticated athlete's ownership and stamps the
  // result into the worker's dispatch metadata. So a spoken turn and a typed
  // turn land in ONE transcript because they travel the same id, not because two
  // environments were pointed at the same constant.
  //
  // (Before Stage 2 they were: EXPO_PUBLIC_MILA_TEST_CONVERSATION_ID pinned this
  // to whatever the worker's env said, because the server would not accept an id
  // from a browser. It accepts one now — as a preference it verifies, never as a
  // write target it trusts — so the constant is gone.)
  const conversationIdRef = useRef<string | null>(null);
  // The shared thread's rev this instance's transcript reflects.
  const seenRevRef = useRef(0);
  if (conversationIdRef.current === null) {
    if (!activeThread.id) activeThread.id = Crypto.randomUUID();
    conversationIdRef.current = activeThread.id;
    seenRevRef.current = activeThread.rev;
  }
  // This instance moved the shared thread (a new chat, an opened chat, a finished turn): publish it.
  const publishThread = useCallback((id: string, bump: boolean) => {
    activeThread.id = id;
    if (bump) activeThread.rev += 1;
    seenRevRef.current = activeThread.rev;
  }, []);

  // Plan follow-ups in flight (lib/agent/planFollowUp): plan run id → its next check. Cancelled whenever the
  // transcript is replaced (new chat, reopen, reset) or the hook unmounts.
  const followRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stopFollows = useCallback(() => {
    for (const t of followRef.current.values()) clearTimeout(t);
    followRef.current.clear();
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { abortRef.current?.abort(); stopFollows(); }, [stopFollows]);

  /**
   * AGENT_V3: a refresh_plan card is running. Re-read the goals read every PLAN_FOLLOW_POLL_MS (at most
   * PLAN_FOLLOW_MAX_MS) until its `planning` no longer names this run, then re-read THIS conversation once: Mila's
   * follow-up row is added under the card (done), or the card says the plan didn't refresh. A chat switched meanwhile
   * is never touched.
   */
  const followPlan = useCallback((runId: string) => {
    if (!AGENT_V3 || followRef.current.has(runId)) return;
    const conversationId = conversationIdRef.current;
    const started = Date.now();
    const check = async () => {
      if (!followRef.current.has(runId)) return;
      const timedOut = Date.now() - started >= PLAN_FOLLOW_MAX_MS;
      // Backgrounded: no reads; look again once she is back (the next check after she returns).
      if (!timedOut && AppState.currentState !== "active") { followRef.current.set(runId, setTimeout(check, PLAN_FOLLOW_POLL_MS)); return; }
      let ended = timedOut;
      if (!timedOut) {
        try {
          const res = await fetch(`${getApiUrl()}/api/v1/me/agent/goals`, { method: "GET", headers: { ...(await getAuthHeaders()) } });
          if (res.status === 404) { followRef.current.delete(runId); return; } // the plan route is dark: nothing to follow
          if (res.ok) {
            const goals = (await res.json()) as AgentGoalsResponse;
            ended = !stillPlanning(goals, runId);
            // Still working: the card shows which step (planning, then the post kits).
            if (!ended && goals.planning && conversationIdRef.current === conversationId) {
              const step = goals.planning.step;
              setMessages((prev) => advancePlanCard(prev, runId, step));
            }
          }
        } catch { /* a network blip: look again on the next check */ }
      }
      if (!followRef.current.has(runId)) return;
      if (!ended) { followRef.current.set(runId, setTimeout(check, PLAN_FOLLOW_POLL_MS)); return; }
      followRef.current.delete(runId);
      if (conversationIdRef.current !== conversationId) return;
      try {
        const res = await fetch(`${getApiUrl()}/api/v1/me/conversations/${conversationId}`, { method: "GET", headers: { ...(await getAuthHeaders()) } });
        if (!res.ok) return;
        const data = (await res.json()) as { messages?: ConversationRow[] };
        if (conversationIdRef.current !== conversationId) return;
        setMessages((prev) => applyPlanFollowUp(prev, data.messages ?? [], runId, () => `a-${++idRef.current}`, !timedOut));
      } catch { /* the card stays as it is */ }
    };
    followRef.current.set(runId, setTimeout(check, PLAN_FOLLOW_POLL_MS));
  }, []);

  const send = useCallback(async (
    message: string,
    context?: MilaContext,
    opts?: { editMessageId?: string; attachments?: ChatAttachment[] },
  ) => {
    const attachments = opts?.attachments?.length ? opts.attachments : undefined;
    // Cancel any previous request before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const asstId = `a-${++idRef.current}`;

    setStreaming(true);
    setPhase("thinking");
    // Only this send, while it still owns the request, may move the phase.
    const setOwnPhase = (p: ChatPhase) => {
      if (abortRef.current === controller) setPhase(p);
    };
    // Append vs edit-in-place. A normal send appends a new user turn + assistant
    // slot at the end (finalizing any still-streaming message). An edit
    // (opts.editMessageId) instead REWRITES that user turn in place with the new
    // text and regenerates the answer right after it — every later turn is kept
    // untouched. An unknown/absent id falls back to append.
    setMessages((prev) => {
      const editId = opts?.editMessageId;
      const idx = editId ? prev.findIndex((m) => m.id === editId) : -1;

      if (idx === -1) {
        return [
          ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          { id: `u-${++idRef.current}`, role: "user", content: message, ...(attachments ? { attachments } : {}) },
          { id: asstId, role: "assistant", content: "", streaming: true },
        ];
      }

      // Edit-in-place: keep the whole array, rewrite the edited user turn's
      // text, and reset the answer immediately after it to a fresh streaming
      // slot. Later turns are untouched; any other still-streaming message is
      // finalized (its partial text preserved).
      const next = prev.map((m) => (m.streaming ? { ...m, streaming: false } : m));
      next[idx] = { ...next[idx], content: message };
      const freshAnswer: MilaMessage = {
        id: asstId,
        role: "assistant",
        content: "",
        streaming: true,
      };
      if (next[idx + 1]?.role === "assistant") {
        next[idx + 1] = freshAnswer; // replace the edited turn's old answer
      } else {
        next.splice(idx + 1, 0, freshAnswer); // edited an as-yet-unanswered turn
      }
      return next;
    });

    // Patch only this send's assistant message.
    const patch = (fields: Partial<MilaMessage>) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === asstId ? { ...m, ...fields } : m)),
      );

    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body:    JSON.stringify({
          message,
          conversation_id: conversationIdRef.current,
          ...(context ? { context } : {}),
          // Ids only — the bytes went to the library first. The server re-checks ownership.
          ...(attachments ? { attachments: attachments.map((a) => ({ asset_id: a.assetId, role: a.role })) } : {}),
        }),
        signal:  controller.signal,
      });

      if (!res.ok) {
        // 429 rate limit, 400 bad request, etc — not a stream. Map by status
        // to human text; never read the raw body into the UI.
        patch({
          streaming: false,
          error: res.status === 429 ? ERROR_RATE_LIMIT : ERROR_UNREACHABLE,
        });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        patch({ streaming: false, error: ERROR_UNREACHABLE });
        return;
      }

      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as {
              type?: string;
              message?: string;
              phase?:   "thinking" | "tool";
              token?:            string;
              done?:             boolean;
              suggestions?:      string[];
              actions?:          MilaNavChip[];
              widget?:           MilaWidget;
              profileUpdates?:   ProfileUpdateCandidate[];
              cards?:            unknown[];
              runId?:            string;
              error?:            string;
            };
            if (ev.error) { patch({ streaming: false, error: ev.error }); return; }
            // Context-aware loading phrase (named "status" event). asstId-scoped
            // via patch, so a superseded turn's status can't attach to a newer msg.
            if (ev.type === "status" && ev.message) {
              patch({ statusMessage: ev.message });
              const isTool = ev.phase
                ? ev.phase === "tool"
                : ev.message !== DEFAULT_STATUS_PHRASE;
              setOwnPhase(isTool ? "tool" : "thinking");
            }
            if (ev.token) {
              setOwnPhase("writing");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId ? { ...m, content: m.content + ev.token } : m,
                ),
              );
            }
            if (ev.suggestions) {
              // Additive follow-up suggestions. Rides on `done` (v1 path) or
              // arrives as a separate later event (v2 decoupled path). patch()
              // closes over THIS send's asstId, so a superseded turn's late
              // suggestions land on their own message, never a newer one.
              patch({ suggestions: ev.suggestions });
            }
            if (ev.widget) {
              // Additive inline card, same field-presence pattern as suggestions.
              // Rides on the `done` event; patch() is asstId-scoped so a
              // superseded turn's widget can't attach to a newer message.
              patch({ widget: ev.widget });
            }
            if (ev.actions) {
              // Additive read-only nav-chips, riding on `done` like the widget.
              // asstId-scoped, so a superseded turn's chips land on their own
              // message, never a newer one.
              patch({ actions: ev.actions });
            }
            // Proposed durable profile updates (Phase-3) — additive, asstId-scoped
            // like suggestions/widget, so a superseded turn's proposals can't attach
            // to a newer message.
            if (ev.profileUpdates)   patch({ profileUpdates: ev.profileUpdates });
            // AGENT_V3: the harness's cards and run id (AgentDoneFields) — same asstId-scoped, field-presence patch.
            if (AGENT_V3 && Array.isArray(ev.cards)) {
              patch({ cards: ev.cards });
              // A plan refresh started: Mila comes back in this chat when it is done.
              const planRun = runningPlanRunId(ev.cards);
              if (planRun) followPlan(planRun);
            }
            if (AGENT_V3 && typeof ev.runId === "string") patch({ runId: ev.runId });
            if (ev.done) {
              patch({ streaming: false });
              // Native: reader.read() can resolve long after `done`, so the
              // finally clear lands late and the Stop button lingers past a
              // visibly finished answer. Clear the top-level flag now — but only
              // if we still own the request. A superseded turn's late done must
              // not stomp a newer turn's streaming (same ownership guard as the
              // finally below).
              if (abortRef.current === controller) setStreaming(false);
              setOwnPhase("idle");
            }
          } catch {}
        }
      }
    } catch (err: any) {
      // Aborted (a newer send, stop(), reset(), or unmount) → keep the partial
      // text, surface nothing. Detect via the signal, not the error name: web
      // fetch rejects with a DOMException named "AbortError", but expo/fetch on
      // native rejects with a generic Error ("fetch failed: The operation was
      // aborted.", name "Error"), so a name-only check would mis-render every
      // native stop as a network error.
      if (!controller.signal.aborted && err?.name !== "AbortError") {
        patch({ error: ERROR_NETWORK });
      }
    } finally {
      patch({ streaming: false });
      // Only the request that still owns abortRef clears the global flag — a
      // superseded request must not stomp its successor's streaming state.
      if (abortRef.current === controller) setStreaming(false);
      setOwnPhase("idle");
      // The other Ask Mila surface is now behind this thread.
      if (conversationIdRef.current) publishThread(conversationIdRef.current, true);
    }
  }, []);

  const stop = useCallback(() => {
    // On the Mastra engine a dropped connection no longer stops Mila (the turn finishes and is saved), so Stop also
    // asks the server (POST /me/chat/stop). Best effort: the abort below runs either way.
    const conversationId = conversationIdRef.current;
    if (abortRef.current && !abortRef.current.signal.aborted && conversationId) {
      void (async () => {
        try {
          await fetch(`${getApiUrl()}/api/v1/me/chat/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
            body: JSON.stringify({ conversation_id: conversationId }),
          });
        } catch { /* offline: the turn finishes and is saved, as if she had left */ }
      })();
    }
    abortRef.current?.abort();
    // Keep the partial text — just close out the open turn.
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
    setStreaming(false);
    setPhase("idle");
  }, []);

  /**
   * appendTranscript — one spoken turn arriving live from the voice session.
   *
   * A VIEW, never the record. The durable copy is written server-side by the
   * worker (server/voice/transcriptRoute.ts → chat_messages, source='voice') and
   * is what a reopened chat replays. If this never runs — nobody listening, a
   * dropped stream, a closed overlay — nothing is lost; the turn is simply not
   * live. That is the whole reason this can stay best-effort and untested-by-DB.
   *
   * The DECISION — which line this update belongs to, and whether it may rewrite
   * that line — lives in ./transcriptCollapse, where it is unit-tested without a
   * room. What is left here is the application: turn a plan into setMessages.
   * `content: null` on an update means "settle `streaming`, keep the text" — a
   * late-closing partial stream must not rewind a line that already grew past it.
   */
  const appendTranscript = useCallback((update: TranscriptUpdate) => {
    const plan = planTranscriptUpdate(
      txRef.current,
      update,
      Date.now(),
      // Same monotonic id source as send(), so a spoken turn and a typed one can
      // never collide on a list key.
      (role) => `${role === "user" ? "u" : "a"}-${++idRef.current}`,
    );

    if (plan.kind === "ignore") return;

    if (plan.kind === "update") {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === plan.id
            ? {
                ...m,
                content: plan.content ?? m.content,
                streaming: plan.streaming,
              }
            : m,
        ),
      );
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: plan.id,
        role: plan.role,
        content: plan.content,
        streaming: plan.streaming,
      },
    ]);
  }, []);

  /**
   * appendWidgetMessage — a card pushed live from the voice session.
   *
   * Mirrors appendTranscript: a VIEW, appended to live state only, never merged
   * with loaded turns. The card is already validated key-by-key
   * (components/mila/widgetPush.ts) — nothing is re-checked here, and nothing
   * unvalidated could have reached this point.
   *
   * `content` is the line composed on the client from the card's own validated
   * fields, and it must be non-empty: getConversationMessages drops a row whose
   * content is empty, so a blank line would render live and then disappear on
   * reopen — visible exactly once, which is the worst of both.
   *
   * Simple append, no stream map: unlike a transcript a card arrives whole, in
   * one packet, and never updates.
   */
  const appendWidgetMessage = useCallback((push: ParsedWidgetPush) => {
    const line = push.line.trim();
    if (!line) return;
    setMessages((prev) => [
      ...prev,
      {
        id: `a-${++idRef.current}`,
        role: "assistant",
        content: line,
        widget: push.widget,
      },
    ]);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    stopFollows();
    setStreaming(false);
    setPhase("idle");
    resetTranscript();
    setMessages([]);
  }, [resetTranscript, stopFollows]);

  // "New chat" — start a fresh conversation: rotate the id (so the server loads no
  // prior history and stamps new rows with the new id) and clear the transcript.
  // This is the ONLY thing that rotates the id; closing the sheet keeps it.
  const newChat = useCallback(() => {
    abortRef.current?.abort();
    stopFollows();
    conversationIdRef.current = Crypto.randomUUID();
    publishThread(conversationIdRef.current, true);
    setStreaming(false);
    setPhase("idle");
    resetTranscript();
    setMessages([]);
  }, [resetTranscript, stopFollows, publishThread]);

  // Reopen a saved chat: fetch its persisted turns, rebuild the transcript, and
  // adopt its conversation id so the NEXT send continues that same conversation
  // (loads its history, stamps its rows). Best-effort — a failed fetch leaves the
  // current transcript untouched. Only the plain user/assistant turns come back
  // (plus persisted widget/nav-chips); the live stream is not replayed.
  const openConversation = useCallback(async (conversationId: string, opts: { adopting?: boolean } = {}) => {
    abortRef.current?.abort();
    setStreaming(false);
    setPhase("idle");
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(
        `${getApiUrl()}/api/v1/me/conversations/${conversationId}`,
        { method: "GET", headers: { ...authHeaders } },
      );
      if (!res.ok) {
        // Adopting the shared thread when it has no saved turns yet (a new chat on the other surface): take its id
        // with an empty transcript. Opening a named saved chat that fails keeps whatever is on screen.
        if (opts.adopting && res.status === 404) {
          stopFollows();
          conversationIdRef.current = conversationId;
          seenRevRef.current = activeThread.rev;
          resetTranscript();
          setMessages([]);
        }
        return;
      }
      const data = (await res.json()) as {
        messages?: {
          id?:          string;
          role:         "user" | "assistant";
          content:      string;
          milaStarted?: boolean;
          unread?:      boolean;
          widget?:      MilaWidget | null;
          app_actions?: MilaNavChip[] | null;
          // AGENT_V3: the cards that turn showed (absent from a server before this field).
          agentCards?:  unknown[] | null;
        }[];
      };
      const rebuilt: MilaMessage[] = (data.messages ?? []).map((m) => ({
        id: `${m.role === "user" ? "u" : "a"}-${++idRef.current}`,
        role: m.role,
        content: m.content,
        ...(m.widget ? { widget: m.widget } : {}),
        ...(m.app_actions?.length ? { actions: m.app_actions } : {}),
        ...(AGENT_V3 && m.agentCards?.length ? { cards: m.agentCards } : {}),
        ...(m.id ? { serverId: m.id } : {}),
        ...(m.milaStarted ? { milaStarted: true } : {}),
      }));
      stopFollows();
      conversationIdRef.current = conversationId;
      if (opts.adopting) seenRevRef.current = activeThread.rev;
      else publishThread(conversationId, false);
      // Cleared only once the replacement is in hand: a failed fetch leaves the
      // screen untouched, so its live mappings must stay valid too.
      resetTranscript();
      setMessages(rebuilt);
      // Opening the chat is seeing it: its Mila-started messages stop counting toward the Mila tab's dot.
      if ((data.messages ?? []).some((m) => m.unread)) void markConversationSeen(conversationId);
      // A plan refresh still running in this chat: keep following it.
      for (const m of rebuilt) {
        const planRun = runningPlanRunId(m.cards);
        if (planRun) followPlan(planRun);
      }
    } catch {
      // network failure — leave the current conversation as-is
    }
  }, [resetTranscript, stopFollows, followPlan, publishThread]);

  /**
   * Catch up with the shared thread before this surface is shown: when another Ask Mila surface started, opened or
   * added to a conversation since this one last looked, re-read it (the persisted turns) and continue it here. A no-op
   * while this surface is current, or while a reply is streaming in it. Resolves once the transcript is in place.
   */
  const syncToActiveThread = useCallback(async () => {
    const id = activeThread.id;
    if (!id || streamingRef.current) return;
    if (id === conversationIdRef.current && seenRevRef.current === activeThread.rev) return;
    await openConversation(id, { adopting: true });
  }, [openConversation]);

  return {
    send,
    stop,
    reset,
    newChat,
    openConversation,
    syncToActiveThread,
    // Live voice turns. Additive: nothing in the text path changes, and the
    // overlay renders an appended turn with the component it already uses.
    appendTranscript,
    appendWidgetMessage,
    streaming,
    // What the in-flight reply is doing (see ChatPhase) — drives Mila's avatar + status pill.
    phase,
    messages,
    // Exposed so voice can prove it is writing into THIS thread rather than
    // silently opening its own — see the conversationIdRef comment above.
    conversationId: conversationIdRef.current,
  };
}
