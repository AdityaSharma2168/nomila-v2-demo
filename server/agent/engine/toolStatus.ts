/**
 * agent/engine/toolStatus.ts (moved from agent/tf/, 5 Nov 2026) — what Mila is doing during a turn, from stream events in
 * TrueForge's shape (the Mastra turn feeds its own chunks in it, mastra/turn.ts; TrueForge itself went in Mastra-only
 * PR 3, and what follows records the shape as TrueForge streamed it), as the
 * app's existing `status` event (lib/sse.ts: a phrase + phase "tool" | "thinking", which drives Mila's avatar and status
 * pill; client/hooks/use-mila-chat.ts). Nothing new on the wire and no new UI.
 *
 * Read from the main thread only (sub-agent threads are TrueForge's own work). What TrueForge-dev actually streams
 * (captured 28 Oct 2026, sanitized in __fixtures__/tf-dev-events/): `model.message` only OPENS a model message (keys
 * type, thread_id, created_at, id, model; never tool_calls). The calls arrive in that message's `model.message.delta`
 * events, OpenAI-style: `tool_calls[{ index, id, type, function: { name, arguments: "" }, tool_info }]` on a call's
 * first fragment, then `tool_calls[{ index, function: { arguments: "<chunk>" } }]`, then one delta with
 * `finish_reason: "tool_calls"` once the model has finished asking. So:
 *   model.message.delta with tool_calls       collect each call by index (id, name, tool_info, argument chunks).
 *   model.message.delta with finish_reason    the round's calls are complete and about to run (also on the round's
 *                                             first tool.response, or the next model.message, if no finish came):
 *                                             status(<the label of the first tool we have a label for>, "tool").
 *   model.message (complete) with tool_calls  the same, for a stream that sends whole calls.
 *   The tool's name is `tool_info.name` for one of our MCP tools; when our tools are discovered on demand (mila-dev
 *   has MCP preload off) the call is TrueForge's `call_tool` and the name is its `tool_name` argument (read here for
 *   the lookup only). TrueForge's discovery calls (`list_tools`, `get_tool_info`) run no tool of ours, so they show
 *   TOOL_STATUS_FALLBACK: the stream says only that something is being worked on.
 *   tool.response                            when every call of the round has answered: status("Thinking…", "thinking")
 *                                             (the model is deciding what to do with the results).
 *   model.message.delta with content          answer text again: the app shows "writing" on the first token by itself,
 *                                             so nothing is sent; the next tool round sends its label again.
 *
 * The phrase is ALWAYS one of the fixed labels below: never a tool's arguments, ids, results or data, and never the
 * tool's name (an unlisted tool shows TOOL_STATUS_FALLBACK).
 *
 * Also counted, not sent: reasoning text TrueForge streams (`reasoning_content` on model.message.delta; with an OpenAI
 * model TrueForge asks for reasoning summaries, reasoningSummary "auto") — the count lets us see on dev whether a
 * summary is there to show, before any display is designed. And whether TrueForge ever paused a turn for its own
 * tool approval (tool.approval_required), which our tools must never need: approvals are our own tap cards.
 */
import type { StatusPhase } from "../../lib/sse";

/** One label per tool a pass can offer (engine/tools/registry.ts), plus the web search tools. */
export const TOOL_STATUS_LABELS: Readonly<Record<string, string>> = {
  // what Nomila knows about them
  recall_facts: "Checking what I know…",
  remember_fact: "Getting that ready to save…",
  correct_fact: "Getting that fix ready…",
  remember_preference: "Getting that ready to save…",
  cite_facts: "Checking my sources…",
  read_scouting: "Reading your scouting report…",
  // Mastra's own agent-skill tools (engine/mastra/skills.ts): Mila's playbooks
  skill: "Getting ready…",
  skill_read: "Getting ready…",
  skill_search: "Getting ready…",
  // cards that point somewhere
  offer_connection: "Getting that ready…",
  ask_quick_question: "Getting that ready…",
  open_screen: "Finding that screen…",
  check_camera_roll: "Getting that ready…",
  // the card system v2's producers (MILA_CARDS_V2)
  share_insight: "Getting that ready…",
  ideas_suggest: "Finding post ideas…",
  offer_capability: "Getting that ready…",
  ask_once: "Getting that ready…",
  answer_with_sources: "Getting that ready…",
  // goals and the plan
  list_goals: "Checking your goals…",
  keep_goal: "Updating your goals…",
  change_goal: "Updating your goals…",
  set_aside_goal: "Updating your goals…",
  drop_goal: "Updating your goals…",
  bring_back_goal: "Updating your goals…",
  add_goal: "Updating your goals…",
  suggest_goal: "Updating your goals…",
  refresh_plan: "Working on your plan…",
  // research and the web
  refresh_research: "Looking you up again…",
  web_search: "Looking that up…",
  web_fetch: "Looking that up…",
  // content
  find_music: "Finding music…",
  // deals
  deals_find: "Checking your deals…",
  deals_get: "Checking your deals…",
  deals_terms: "Reading the terms…",
  deals_waiting: "Checking what's waiting…",
  deals_draft_reply: "Writing a reply…",
  deals_close: "Updating your deals…",
  deals_mark: "Updating your deals…",
  deals_open: "Checking your deals…",
  brand_get: "Looking into the brand…",
  // bookings
  bookings_list: "Checking your bookings…",
  bookings_get: "Checking your bookings…",
  bookings_waiting: "Checking what's waiting…",
  bookings_respond: "Getting that request ready…",
  // documents
  documents_status: "Checking your documents…",
  documents_make: "Working on your document…",
  documents_edit: "Working on your document…",
  documents_share: "Getting your link ready…",
  // reads over what Nomila holds (agent/reads)
  media_search: "Looking through your photos and videos…",
  posts_performance: "Checking how your posts did…",
  money_summary: "Checking your money…",
  whats_next: "Checking what's coming up…",
  // the waitlist page
  waitlist_status: "Checking where things are…",
  start_research: "Starting your research…",
  show_waitlist_card: "Getting that ready…",
};

export const TOOL_STATUS_FALLBACK = "Working on it…";
/** The route's opening phrase (routes/chat.ts) and the client's DEFAULT_STATUS_PHRASE. */
export const THINKING_STATUS = "Thinking…";

/** TrueForge's on-demand discovery wrapper: the real tool is its `tool_name` argument (DeferredTool.ts). */
const DEFERRED_CALL_TOOL = "call_tool";

export function toolStatusLabel(name: string | null | undefined): string {
  return (name && Object.prototype.hasOwnProperty.call(TOOL_STATUS_LABELS, name) ? TOOL_STATUS_LABELS[name] : null) ?? TOOL_STATUS_FALLBACK;
}

type ToolCallLike = { id?: string; function?: { name?: string; arguments?: string }; tool_info?: { type?: string; name?: string } };

/** The tool a call runs: our MCP tool's own name, the deferred wrapper's target, or the name TrueForge gave. */
export function toolNameOf(call: ToolCallLike): string | null {
  const info = call.tool_info;
  if (info?.type === "mcp" && info.name) return info.name;
  const name = info?.name ?? call.function?.name ?? null;
  if (name === DEFERRED_CALL_TOOL) {
    try {
      const target = (JSON.parse(call.function?.arguments ?? "") as { tool_name?: unknown })?.tool_name;
      return typeof target === "string" ? target : null;
    } catch {
      return null;
    }
  }
  return name;
}

/**
 * One stream event, in the shape the tracker reads (TrueForge's stream events have it; the Mastra turn feeds its own
 * chunks in the same shape, mastra/turn.ts). Defined here so the engine needs nothing from TrueForge's client.
 */
export interface ToolStatusEvent {
  type: string;
  thread_id?: string | null;
  content?: unknown;
  reasoning_content?: unknown;
  finish_reason?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface ToolStatusTracker {
  /** Feed every stream event, in order. */
  see(ev: ToolStatusEvent): void;
  /** Reasoning characters TrueForge streamed on the main thread (counted only; never sent). */
  readonly reasoningChars: number;
  /** TrueForge paused the turn for its own tool approval (it should never: our approvals are tap cards). */
  readonly approvalRequired: boolean;
}

/** One streamed call being assembled from its fragments. */
type PendingCall = { id?: string; name?: string; info?: { type?: string; name?: string }; args: string };
type CallFragment = ToolCallLike & { index?: unknown };

export function createToolStatus(status: (message: string, phase: StatusPhase) => void): ToolStatusTracker {
  let phase: "thinking" | "tool" | "writing" = "thinking";
  let shown: string | null = null;
  const running = new Set<string>();
  /** The current model message's streamed tool calls, by index, until the round is complete. */
  let pending = new Map<number, PendingCall>();
  let reasoningChars = 0;
  let approvalRequired = false;

  const send = (message: string, p: StatusPhase) => {
    if (phase === p && shown === message) return;
    phase = p; shown = message;
    status(message, p);
  };

  const startRound = (calls: ToolCallLike[]) => {
    for (const c of calls) if (c.id) running.add(c.id);
    const names = calls.map(toolNameOf);
    const known = names.find((n) => n && Object.prototype.hasOwnProperty.call(TOOL_STATUS_LABELS, n));
    send(toolStatusLabel(known ?? null), "tool");
  };

  const collect = (fragments: CallFragment[]) => {
    for (const f of fragments) {
      const index = typeof f?.index === "number" ? f.index : 0;
      const cur = pending.get(index) ?? { args: "" };
      if (typeof f.id === "string" && f.id) cur.id = f.id;
      if (typeof f.function?.name === "string" && f.function.name) cur.name = f.function.name;
      if (f.tool_info && typeof f.tool_info === "object") cur.info = f.tool_info;
      if (typeof f.function?.arguments === "string") cur.args += f.function.arguments;
      pending.set(index, cur);
    }
  };

  /** The streamed calls are complete: show the round's label (once). */
  const flush = () => {
    if (!pending.size) return;
    const calls = [...pending.entries()].sort(([a], [b]) => a - b)
      .map(([, c]): ToolCallLike => ({ id: c.id, function: { name: c.name, arguments: c.args }, tool_info: c.info }));
    pending = new Map();
    startRound(calls);
  };

  return {
    see(ev) {
      if (ev.type === "tool.approval_required") { approvalRequired = true; return; }
      if (ev.thread_id !== "main") return;
      if (ev.type === "model.message.delta") {
        if (Array.isArray(ev.tool_calls) && ev.tool_calls.length) collect(ev.tool_calls as CallFragment[]);
        if (typeof ev.reasoning_content === "string") reasoningChars += ev.reasoning_content.length;
        if (typeof ev.content === "string" && ev.content) { phase = "writing"; shown = null; }
        if (ev.finish_reason) flush();
      } else if (ev.type === "model.message") {
        flush();   // a streamed round whose finish delta never came: it ran before this new message
        if (ev.tool_calls?.length) startRound(ev.tool_calls as ToolCallLike[]);
      } else if (ev.type === "tool.response") {
        flush();
        const id = typeof ev.tool_call_id === "string" ? ev.tool_call_id : null;
        if (id) running.delete(id);
        if (!running.size && phase === "tool") send(THINKING_STATUS, "thinking");
      }
    },
    get reasoningChars() { return reasoningChars; },
    get approvalRequired() { return approvalRequired; },
  };
}
