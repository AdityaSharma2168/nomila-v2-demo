/**
 * loop.ts — the Mila agent loop.
 *
 * LEGACY (v1): prod's text chat until the Mastra cutover, and it retires with that cutover; new work goes to
 * server/agent. It predates the Welcome capability registry (server/agent/welcome) and is not a capability source.
 * Its one optional action, draft_reply (the registry's draft_replies), is refused per call while that capability is off
 * for the athlete (welcome/toolGate.ts legacyToolRefusal; MILA_WELCOME, transparent while off). It starts no optional
 * background job.
 *
 * One user turn in, streamed answer out, with up to MILA.MAX_TOOL_ITERATIONS
 * rounds of tool calls in between. The streaming shapes here match what the
 * 2026-07-21 spike verified against @google/genai v2.7 (see spike notes):
 * function-call args arrive COMPLETE in a single chunk (no accumulator),
 * text streams incrementally, results go back as functionResponse turns.
 */

import type { Content, FunctionCall, Part } from "@google/genai";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { chatMessages } from "../../shared/schema";
import { createLogger } from "../logger";
import { withTimeout } from "../lib/withTimeout";
import type { SSEStream } from "../lib/sse";
import { MILA } from "./config";
import {
  getConversationContext,
  upsertConversationOnMessage,
  wrapSummaryForPrompt,
} from "./conversations";
import { creativeTools, milaTools, onboardingTools, shopTools, toFunctionDeclarations } from "./registry";
import { buildOnboardingPrompt } from "./onboarding";
import { attachmentBlock, attachmentParts, attachmentSuffix, type MilaAttachment } from "./attachments";
import type {
  MilaTool,
  MilaWidget,
  MilaNavChip,
  DealCardWidgetData,
} from "./types";
import {
  buildWidget,
  dealCardsFromRows,
  selectTurnWidget,
  type WidgetCandidate,
} from "./widgets";
import { buildNavChips, dedupeNavChips } from "./navChips";
import { modelViewOf } from "./tools/modelView";
import { StreamingLeakStripper } from "./proseSanitizer";
import { buildSystemPrompt, type ChatContext } from "./prompt";
import { streamMilaModel } from "./gemini";
import { recordTextTurn } from "./voiceMemory";
import { statusForCalls, DEFAULT_STATUS } from "./statusLabels";
import { chatMinimalEnabled, stubToolResult, trimQuotes, widgetForStorage } from "./chatMinimal";
import { assertPublicToolset } from "./public/tools";
import { legacyToolRefusal } from "../agent/welcome/toolGate";

const logger = createLogger("mila/loop");

/** Streamed to the athlete when the loop hits MAX_TOOL_ITERATIONS. Exported for tests. */
export const CAP_MESSAGE =
  "I've hit my look-up limit for this question, so I couldn't finish. " +
  "Try asking again, or narrow the question down.";

export interface MilaLoopParams {
  athleteId: string;
  message: string;
  context?: ChatContext;
  sse: SSEStream;
  /**
   * The continuing conversation this turn belongs to (Phase 1 memory). History is
   * loaded for THIS id and every persisted row is stamped with it. Absent (or on
   * an ephemeral run) → no prior history is replayed and inserts leave it NULL, so
   * the turn behaves statelessly — the pre-memory single-turn behavior. Always a
   * uuid; the route validates it before passing it in.
   */
  conversationId?: string;
  /**
   * Ephemeral run — read-only and stateless. Skips BOTH history replay and all
   * chat_messages persistence, so the turn touches no rows: nothing is read from
   * prior turns and nothing is written. Default false (production persists and
   * replays as normal). Used by the golden eval runner so the gate is read-only
   * and each entry is independent of the others.
   */
  ephemeral?: boolean;
  /**
   * Whether the loop emits the terminal `done` event itself (with the widget +
   * nav-chips). Default true. Pass false when the CALLER needs to fold extra
   * fields into a single `done` (the v2 chat route adds `suggestions`, which are
   * computed after the answer) — the loop then returns widget/navChips and the
   * caller emits the one `done`. This keeps suggestions on the `done` event the
   * client reads, matching the v1 path (never a separate post-`done` event).
   */
  emitDone?: boolean;
  /**
   * What the athlete attached with this message (server/mila/attachments.ts) — already rows in
   * their media library, resolved by the route against their athlete id. The stills ride to the
   * model inline, a DATA block names them, and the persisted user text gets a short suffix.
   * Absent or empty → the turn is byte-identical to a text-only turn.
   */
  attachments?: MilaAttachment[];
  /**
   * PUBLIC MODE (context.type === "public"; design-public-card-v3 §4). A visitor on her public card, not the athlete.
   * Unlike onboarding, which APPENDS tools, public mode REPLACES the whole tool list with `tools` (the allowlist,
   * server/mila/public/tools.ts — checked here on every turn) and the whole prompt with `systemPrompt` (the PUBLIC_MODE
   * block). History is the visitor's own chat (`history`, from ask_mila_turns), the visitor's message is already wrapped
   * as <external_content>, and NOTHING is written to chat_messages, voice memory, widgets or nav-chips: the caller
   * (server/services/askMila/turn.ts) persists to the ask_mila_* tables after its output gate. No web search.
   * Required when context.type is "public"; ignored otherwise.
   */
  publicMode?: {
    tools: MilaTool[];
    systemPrompt: string;
    history: Content[];
  };
}

/** Token usage of one turn, summed over its model calls (the public spend counter reads it). */
export interface MilaTurnUsage {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/**
 * Run one Mila turn. Persists the user message, every tool round, and the
 * final answer. Returns the full answer text (for the suggestions call in the
 * route). `tools` is injectable for tests; production always uses the registry.
 * `ephemeral` disables history + persistence for read-only eval runs.
 */
export async function runMilaLoop(
  {
    athleteId,
    message,
    context,
    sse,
    conversationId,
    ephemeral = false,
    emitDone = true,
    attachments = [],
    publicMode,
  }: MilaLoopParams,
  tools: MilaTool[] = milaTools,
): Promise<{
  text: string;
  widget?: MilaWidget | null;
  navChips?: MilaNavChip[];
  usage?: MilaTurnUsage;
  /** Public mode only: every tool call this turn and what it returned (the output gate allows their numbers). */
  toolResults?: Array<{ name: string; result: unknown }>;
}> {
  // Per-turn latency instrumentation. Monotonic clock; covers everything from
  // history load through the final answer. See logTurnSummary() below.
  const turnStart = performance.now();

  // Public mode: a visitor, a replaced tool list and prompt, and no athlete-side reads or writes (see publicMode above).
  const isPublic = context?.type === "public";
  if (isPublic && !publicMode) throw new Error("runMilaLoop: context.type 'public' needs publicMode");
  // Every chat_messages / voice-memory write below is skipped for an ephemeral run AND for public mode.
  const persist = !ephemeral && !isPublic;

  // History BEFORE inserting the current message, so it isn't replayed twice.
  // Ephemeral runs skip history entirely so each eval entry is deterministic; a
  // turn with no conversationId is stateless (no prior history) — same as pre-memory.
  let history: Content[] = [];
  // Phase-2 rolling summary for this conversation, if it has been folded. Prepended
  // to the system prompt (as delimited DATA) so the model keeps older context the
  // replayed tail no longer carries.
  let summary: string | null = null;
  if (isPublic) {
    history = publicMode!.history;
  } else if (!ephemeral && conversationId) {
    const ctx = await getConversationContext(athleteId, conversationId);
    summary = ctx.summary;
    // Replay ONLY the un-summarized tail (messages after the watermark). When the
    // conversation has never been folded the watermark is null and this loads the
    // whole conversation (capped) exactly as before Phase 2.
    history = await loadHistory(
      athleteId,
      conversationId,
      ctx.summaryThroughCreatedAt,
    );
  }

  // Attachments: the stills the model can look at (capped), and the block that names them. The
  // persisted text carries only a short suffix — history replay is text-only, and a row that said
  // nothing about the photo would mislead the next turn.
  const { parts: imageParts, inlined } = attachments.length && !isPublic
    ? await attachmentParts(attachments)
    : { parts: [], inlined: 0 };
  const userText = isPublic ? message : message + attachmentBlock(attachments, inlined);

  if (persist) {
    await db.insert(chatMessages).values({
      athlete_id: athleteId,
      role: "user",
      content: message + attachmentSuffix(attachments),
      conversation_id: conversationId ?? null,
    });
    // Upsert the conversation row at this choke point: the first message seeds the
    // saved-chats title, every later one bumps recency. Best-effort (never throws),
    // so a conversations-table write can't break the turn. Only for a real
    // conversation — a stateless (no-id) turn writes no metadata.
    if (conversationId) {
      await upsertConversationOnMessage(athleteId, conversationId, message);
    }
  }

  const contents: Content[] = [
    ...history,
    // Images first, then the text — the block tells the model the images above are the attachments.
    { role: "user", parts: [...imageParts, { text: userText }] },
  ];
  // Deterministic prose backstop (proseSanitizer). Runs on EVERY turn: bracketed
  // UUIDs + tool names are stripped live; numbered [n] footnotes are held to the
  // end of the stream and stripped there (this loop has had no web grounding since
  // the MILA_WEB_SEARCH spike was deleted, 2 Nov 2026, so an [n] is never a citation).
  const stripper = new StreamingLeakStripper();
  // The first entry (PR 3): an onboarding conversation gets the ONBOARDING_CONTEXT block —
  // the facts Mila may say she found, plus the step rules — and the two onboarding-only tools.
  // Every other context is byte-identical to before: same prompt, same tool list.
  const onboarding = !isPublic && context?.type === "onboarding";
  const onboardingBlock = onboarding ? await buildOnboardingPrompt(athleteId) : "";
  const withOnboarding = onboarding ? [...tools, ...onboardingTools.filter((t) => !tools.some((x) => x.name === t.name))] : tools;
  // The creative door (0072) is declared only while its flag is on — off, the model cannot even name it.
  const withCreative = [...withOnboarding, ...creativeTools().filter((t) => !withOnboarding.some((x) => x.name === t.name))];
  // Her picks (SHOP_V1): declared only while the flag is on.
  const appTools = [...withCreative, ...shopTools().filter((t) => !withCreative.some((x) => x.name === t.name))];
  // Public mode: REPLACED, never appended — the app registry, onboarding and every flag-gated door above are dropped,
  // and a set holding anything outside the allowlist throws before the model is called.
  const turnTools = isPublic ? assertPublicToolset(publicMode!.tools) : appTools;
  const declarations = toFunctionDeclarations(turnTools);
  // Prepend the rolling summary (when present) as a delimited DATA block — the
  // wrapper labels it not-an-instruction, since it may paraphrase untrusted
  // brand/email text folded from tool results.
  const systemPrompt = isPublic
    ? publicMode!.systemPrompt
    : buildSystemPrompt(context) +
      onboardingBlock +
      (summary ? wrapSummaryForPrompt(summary) : "");

  let fullText = "";
  const calledToolNames: string[] = [];
  let answered = false;
  // The card to render alongside the answer. A turn may run several tools /
  // rounds; the LAST widget produced wins (closest to the final answer).
  // Every widget produced this turn, tagged by its tool. The ONE that renders is
  // chosen AFTER the answer by selectTurnWidget (subject-matched), not last-wins —
  // so an over-fetch turn can't render a deal she only pulled in passing.
  const widgetCandidates: WidgetCandidate[] = [];
  // Read-only navigation shortcuts, collected across every round. Grounded in the
  // tools actually called this turn; deduped + capped (last round first) at the end.
  const navChipsRaw: MilaNavChip[] = [];
  // Card-ready data for EVERY deal any list_deals call returned this turn (uncapped).
  // Feeds selectTurnWidget's declared-id pool so a model-declared deal_list renders
  // deals it named from the list but never get_deal'd (the over-fetch fix means it
  // deep-dives only 1-2). Render stays capped at DEAL_LIST_MAX inside selectTurnWidget.
  const dealPool: DealCardWidgetData[] = [];
  // Public mode: the raw tool results of the turn, for the caller's output gate.
  const publicToolResults: Array<{ name: string; result: unknown }> = [];

  // ─── Latency instrumentation ──────────────────────────────────────────────
  // Per-iteration model timing (modelMs = whole streamed call; ttftMs = time to
  // the first chunk we saw) and per-tool execution timing (name + ms). Summed and
  // logged once as a per-turn summary at every exit. Pure measurement — it never
  // changes control flow.
  interface IterMetric {
    iteration: number;
    modelMs: number;
    ttftMs: number | null;
    toolMs: number; // wall-clock of this round's parallel tool batch (0 if none)
    toolCount: number;
    thinkingTokens: number; // thoughtsTokenCount for this round's model call
  }
  const iterMetrics: IterMetric[] = [];
  const toolTimings: { name: string; ms: number }[] = [];
  let promptTokens = 0; // summed across model calls (context is re-sent each round)
  let outputTokens = 0;
  // Thinking tokens (thoughtsTokenCount) summed across calls — the lever the
  // thinking-budget cap trims; the final-answer round dominates this.
  let thinkingTokens = 0;

  let summaryLogged = false;
  const logTurnSummary = (): void => {
    if (summaryLogged) return; // exactly one summary per turn, at whichever exit fires
    summaryLogged = true;
    const slowest = toolTimings.reduce<{ name: string; ms: number } | null>(
      (a, b) => (a && a.ms >= b.ms ? a : b),
      null,
    );
    logger.info(
      {
        athleteId,
        totalMs: Math.round(performance.now() - turnStart),
        iterations: iterMetrics.length,
        modelMsTotal: Math.round(
          iterMetrics.reduce((s, m) => s + m.modelMs, 0),
        ),
        toolCalls: toolTimings.length,
        slowestTool: slowest
          ? { name: slowest.name, ms: Math.round(slowest.ms) }
          : null,
        promptTokens,
        outputTokens,
        thinkingTokens,
        answered,
        perIteration: iterMetrics.map((m) => ({
          i: m.iteration,
          modelMs: Math.round(m.modelMs),
          ttftMs: m.ttftMs == null ? null : Math.round(m.ttftMs),
          toolMs: Math.round(m.toolMs),
          tools: m.toolCount,
          thinking: m.thinkingTokens,
        })),
        toolTimings: toolTimings.map((t) => ({
          name: t.name,
          ms: Math.round(t.ms),
        })),
      },
      "Mila turn summary",
    );
  };

  for (let iteration = 1; iteration <= MILA.MAX_TOOL_ITERATIONS; iteration++) {
    if (sse.closed || sse.signal.aborted) {
      logTurnSummary();
      return { text: fullText, usage: { promptTokens, outputTokens, thinkingTokens } };
    }

    // "Thinking…" while the model decides this round (and for the whole no-tool
    // final round, which streams its answer with no tool phrase to show). Once
    // this round's tool calls are known below, we replace it with their phrase.
    sse.status(DEFAULT_STATUS, "thinking");

    const modelStart = performance.now();
    const stream = await streamMilaModel(
      contents,
      declarations,
      sse.signal,
      systemPrompt,
    );

    // Spike-verified: functionCall parts arrive complete in one chunk, so we
    // collect whole Parts (keeping thoughtSignature intact for the echo back)
    // with no accumulator buffer.
    const callParts: Part[] = [];
    let usage: unknown;
    let ttft: number | null = null;
    for await (const chunk of stream) {
      if (ttft === null) ttft = performance.now() - modelStart; // first chunk seen
      if (sse.closed) break;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) {
          // Strip id/tool live; footnotes held until finalize (below) knows if the
          // turn grounded.
          const emit = stripper.push(part.text);
          if (emit) {
            fullText += emit;
            sse.token(emit);
          }
        }
        if (part.functionCall) callParts.push(part);
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }

    const modelMs = performance.now() - modelStart;
    const u = usage as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        }
      | undefined;
    promptTokens += u?.promptTokenCount ?? 0;
    outputTokens += u?.candidatesTokenCount ?? 0;
    const roundThinking = u?.thoughtsTokenCount ?? 0;
    thinkingTokens += roundThinking;
    // Recorded now (before the break/return branches) so a tool-free answering
    // round and an aborted round both leave a model-timing row behind. toolMs/
    // toolCount are backfilled below if this round runs tools.
    const iterMetric: IterMetric = {
      iteration,
      modelMs,
      ttftMs: ttft,
      toolMs: 0,
      toolCount: 0,
      thinkingTokens: roundThinking,
    };
    iterMetrics.push(iterMetric);

    logger.info(
      { athleteId, iteration, modelMs: Math.round(modelMs), usage },
      "Mila model call finished",
    );

    if (callParts.length === 0) {
      answered = true;
      break;
    }
    if (sse.closed || sse.signal.aborted) {
      logTurnSummary();
      return { text: fullText, usage: { promptTokens, outputTokens, thinkingTokens } };
    }

    const calls = callParts.map((p) => p.functionCall!);
    calledToolNames.push(...calls.map((c) => c.name ?? "?"));
    sse.status(statusForCalls(calls.map((c) => c.name ?? "")), "tool");

    // Tools run in PARALLEL (Promise.all): toolMs below is the round's wall-clock
    // (≈ the slowest tool), while each tool's own duration is captured per-call
    // for the summary's slowest-tool line.
    const toolsStart = performance.now();
    const results = await Promise.all(
      calls.map(async (call) => {
        const t0 = performance.now();
        const r = await executeCall(athleteId, call, turnTools);
        toolTimings.push({
          name: call.name ?? "?",
          ms: performance.now() - t0,
        });
        return r;
      }),
    );
    iterMetric.toolMs = performance.now() - toolsStart;
    iterMetric.toolCount = calls.length;

    // What the MODEL sees of each result (./tools/modelView): a tool may withhold fields that
    // only the in-app widget renders (the retired deal score). Widgets below keep the raw result.
    const modelResults = calls.map((call, i) =>
      modelViewOf(turnTools.find((t) => t.name === call.name), results[i]),
    );

    if (isPublic) {
      calls.forEach((call, i) => publicToolResults.push({ name: call.name ?? "?", result: modelResults[i] }));
    }

    if (persist) {
      await persistToolRound(
        athleteId,
        conversationId,
        callParts,
        calls,
        modelResults,
      );
    }

    // Derive a client widget + nav-chips from this round's results. buildWidget
    // trims to a safe scalar subset (no jsonb, no thread/email text); buildNavChip
    // maps a tool result to a read-only navigation shortcut, or nothing.
    for (let i = 0; i < calls.length && !isPublic; i++) {
      const name = calls[i].name ?? "";
      const w = buildWidget(name, results[i]);
      if (w) widgetCandidates.push({ name, widget: w }); // selected after the answer
      // Every listed deal becomes card-ready pool data (uncapped), so a declared
      // deal_list can render a deal she ranked from the list without opening it.
      if (name === "list_deals")
        dealPool.push(...dealCardsFromRows(results[i]));
      navChipsRaw.push(...buildNavChips(name, results[i]));
    }

    // Echo the model's functionCall parts verbatim (thoughtSignature included),
    // then hand back one functionResponse per call — the 3-message transcript
    // shape the spike verified.
    contents.push({ role: "model", parts: callParts });
    contents.push({
      role: "user",
      parts: calls.map((call, i) => ({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: { output: modelResults[i] },
        },
      })),
    });
  }

  if (sse.closed) {
    logTurnSummary();
    return { text: fullText, usage: { promptTokens, outputTokens, thinkingTokens } };
  }

  const usage: MilaTurnUsage = { promptTokens, outputTokens, thinkingTokens };

  // Flush the streaming stripper's held tail (footnotes stripped).
  const heldTail = stripper.finalize();
  if (heldTail) {
    fullText += heldTail;
    sse.token(heldTail);
  }

  if (!answered) {
    // Ran out of iterations while the model still wanted more tools. Be honest
    // with the athlete, and loud in the logs — the tool sequence is the clue.
    logger.warn(
      { athleteId, toolCalls: calledToolNames },
      "Mila hit MAX_TOOL_ITERATIONS without a final answer",
    );
    const capText = (fullText ? "\n\n" : "") + CAP_MESSAGE;
    fullText += capText;
    sse.token(capText);
  }

  // Later-round chips first (most specific / closest to the answer), then dedupe
  // + cap. Copy before reversing so navChipsRaw isn't mutated for the return.
  const navChips = dedupeNavChips([...navChipsRaw].reverse());

  // Choose the ONE widget to render: the model's declared directive (captured +
  // stripped from prose by the stripper) when usable, else the prose+question
  // heuristic. Server guards (draft_reply-wins, score-suppression, tenancy) apply.
  const widget = isPublic ? null : selectTurnWidget(
    widgetCandidates,
    fullText,
    calledToolNames,
    message,
    stripper.directive,
    dealPool,
  );

  // The widget and nav-chips (if any) ride on the `done` event as additive fields,
  // exactly like the v1 route's `done({ suggestions })`: field-presence compatible,
  // no new SSE method. When `emitDone` is false (the v2 chat route), the caller
  // emits the single `done` instead — folding `suggestions` in alongside these —
  // so suggestions always ride on the `done` the client reads, never a separate
  // post-`done` event. Either way the widget/nav-chips come back in the return.
  if (emitDone) {
    const doneData: Record<string, unknown> = {};
    if (widget) doneData.widget = widget;
    if (navChips.length) doneData.actions = navChips;
    sse.done(Object.keys(doneData).length ? doneData : undefined);
  }

  if (fullText && persist) {
    // Awaited (history + tests see the row deterministically) but past `done`,
    // so a slow or failing write can't delay the answer or surface an error to
    // the athlete. Errors are logged, never rethrown. Ephemeral eval runs skip
    // persistence entirely. The widget is persisted to the existing
    // chat_messages.widget jsonb column (history replay stays text-only for now).
    try {
      // MILA_CHAT_MINIMAL (decision 9): long quotes are trimmed and a draft card is
      // stored without its body. The athlete already saw the full answer live.
      const minimal = chatMinimalEnabled();
      await db.insert(chatMessages).values({
        athlete_id: athleteId,
        role: "assistant",
        content: minimal ? trimQuotes(fullText) : fullText,
        widget: minimal ? widgetForStorage(widget) : (widget ?? null),
        // Nav-chips persist to the (previously unused) app_actions jsonb column, on
        // the same assistant row as the widget. History replay stays text-only for
        // now, so this is durable-but-forward-looking, exactly like widget.
        app_actions: navChips.length ? navChips : null,
        conversation_id: conversationId ?? null,
      });
    } catch (err) {
      logger.warn(
        { athleteId, error: (err as Error).message },
        "Failed to persist Mila answer",
      );
    }
  }

  logTurnSummary();

  return {
    text: fullText,
    widget,
    navChips,
    usage,
    ...(isPublic ? { toolResults: publicToolResults } : {}),
  };
}

/**
 * Conversation history: this athlete's messages inside the recency window,
 * oldest first. Replays plain user/assistant text turns only for now — tool
 * rows and assistant tool-call turns (tool_call_id set) are persisted but NOT
 * replayed; reconstructing functionCall/functionResponse pairs from the DB is
 * a follow-up, and a half-reconstructed pair would mislead the model more
 * than the missing context does.
 */
async function loadHistory(
  athleteId: string,
  conversationId: string,
  // Phase-2 watermark: when set, replay ONLY messages created after it — the
  // turns older than this are already covered by the prepended rolling summary,
  // so replaying them too would double-count. Null → whole conversation (capped).
  afterCreatedAt: Date | null = null,
): Promise<Content[]> {
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      tool_call_id: chatMessages.tool_call_id,
    })
    .from(chatMessages)
    .where(
      and(
        // Tenancy first — a conversation id is a client-minted uuid, so the
        // athlete filter is what actually scopes the rows to this athlete.
        eq(chatMessages.athlete_id, athleteId),
        eq(chatMessages.conversation_id, conversationId),
        afterCreatedAt
          ? gt(chatMessages.created_at, afterCreatedAt)
          : undefined,
      ),
    )
    .orderBy(desc(chatMessages.created_at))
    .limit(MILA.HISTORY_MESSAGE_CAP);

  return rows
    .reverse()
    .filter(
      (r) =>
        (r.role === "user" || r.role === "assistant") &&
        r.content &&
        !r.tool_call_id,
    )
    .map((r) => ({
      role: r.role === "assistant" ? "model" : "user",
      parts: [{ text: r.content! }],
    }));
}

/**
 * Execute one tool call. NEVER throws — every failure mode (unknown tool, bad
 * args, tool error, timeout) becomes an `{ error }` result the model can
 * explain to the athlete, so a broken tool can't crash the stream.
 */
async function executeCall(
  athleteId: string,
  call: FunctionCall,
  tools: MilaTool[],
): Promise<unknown> {
  const name = call.name ?? "";
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool "${name}"` };

  const parsed = tool.argsSchema.safeParse(call.args ?? {});
  if (!parsed.success) {
    return { error: `Invalid arguments for ${name}: ${parsed.error.message}` };
  }

  // MILA_WELCOME: an optional capability's action (draft_reply → draft_replies) runs only while the athlete has it on.
  // Fails closed: a failed check refuses.
  const refusal = await legacyToolRefusal(athleteId, name).catch(() => `${name} is off for this athlete: the check failed. Do not retry.`);
  if (refusal) return { error: refusal };

  try {
    return await withTimeout(
      tool.execute(athleteId, parsed.data),
      // A tool that legitimately runs longer than a read (draft_reply calls a
      // model) declares its own ceiling; reads use the default.
      tool.timeoutMs ?? MILA.TOOL_TIMEOUT_MS,
      name,
    );
  } catch (err) {
    logger.warn(
      { athleteId, tool: name, error: (err as Error).message },
      "Mila tool execution failed",
    );
    return { error: `${name} failed: ${(err as Error).message}` };
  }
}

/**
 * Persist one tool round: the assistant tool-call turn (thoughtSignature in
 * reasoning_content, tool_call_id set so history replay can tell it apart
 * from a plain text turn — any text it streamed lands in the final assistant
 * row instead), then one 'tool' row per result, truncated to budget.
 *
 * ── Also the hook for cross-channel memory ───────────────────────────────────
 * This is the one place that holds the conversation id, the calls and the
 * results together, which is exactly what a `voice_context` delta is built from.
 * See ./voiceMemory: it takes ids and enums out of the results and writes them
 * to the same artifact voice reads at session start, so a call that follows a
 * chat knows what the chat covered. Nothing about `chat_messages` is involved —
 * that prose never reaches a session that speaks aloud.
 */
async function persistToolRound(
  athleteId: string,
  conversationId: string | undefined,
  callParts: Part[],
  calls: FunctionCall[],
  results: unknown[],
): Promise<void> {
  const signature =
    callParts.find((p) => p.thoughtSignature)?.thoughtSignature ?? null;
  const convId = conversationId ?? null;
  const minimal = chatMinimalEnabled();

  await db.insert(chatMessages).values([
    {
      athlete_id: athleteId,
      role: "assistant",
      content: null,
      tool_call_id: calls.map((c) => c.id ?? c.name ?? "?").join(","),
      reasoning_content: signature,
      conversation_id: convId,
    },
    ...calls.map((call, i) => ({
      athlete_id: athleteId,
      role: "tool",
      tool_call_id: call.id ?? call.name ?? "?",
      // MILA_CHAT_MINIMAL (decision 9): a reference (tool, ids, derived scalars),
      // never the payload — a get_deal or draft_reply result carries email-derived
      // text. Tool rows are never replayed or shown, so nothing reads more.
      content: minimal
        ? JSON.stringify(stubToolResult(call.name ?? "?", results[i]))
        : JSON.stringify(results[i] ?? null).slice(0, MILA.TOOL_RESULT_MAX_CHARS),
      conversation_id: convId,
    })),
  ]);

  // Cross-channel memory, AFTER the transcript is safely written and never in
  // front of it. NOT awaited: it resolves `hadDeal` with its own queries, and
  // this runs between tool rounds — a memory write must not add latency to the
  // athlete's answer, which is the same posture the voice worker takes with
  // recordDiscussion. It no-ops on an absent conversation id rather than
  // minting one, and swallows its own failures. See ./voiceMemory.
  void recordTextTurn(athleteId, conversationId, calls, results);
}
