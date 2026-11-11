/**
 * agent/engine/mastra/chatV2Stream.ts — a Mastra turn as the AI SDK v7 UI message stream (chat v2, MILA_CHAT_V2;
 * docs/design/mila-chat-v2.md). Owner decision 1 (31 Oct 2026): Mastra's own `toAISdkStream` (@mastra/ai-sdk), not
 * AG-UI and not our format.
 *
 *   turn (turn.ts tap) → Mastra chunks → toAISdkStream(v7) → ALLOW-LIST FILTER → write(part)
 *
 * The turn drives itself: the tap only ENQUEUES (never waits), so a slow or gone reader never slows or stops the turn
 * (decision 4). The display rules (display.ts) already swapped every tool's input for its status line and its output
 * for its card DTOs; the filter is the second layer: it rebuilds each part it knows field by field and drops
 * everything else (tool-input-start / -delta, tool errors, reasoning, sources, files, Mastra's data-tool-* parts, raw
 * chunks, any data part it did not make itself). What can come out:
 *
 *   start                 { messageId: runId, messageMetadata: { runId } }   (once, first)
 *   start-step / finish-step
 *   text-start / text-delta / text-end   { id, delta }
 *   data-mila-status      { id: "status", data: { label, phase } }  — a fixed status line only
 *   data-mila-card        { id: card id, data: { type, data } }      — a checked card DTO, once per card id
 *   data-mila-done        { data: { runId, status, stopReason, messageIds } }   (end())
 *   error                 { errorText }  — one fixed sentence, never the provider's error
 *   finish                { finishReason }   (end())
 */
import type { ChatCard } from "../../../../shared/agent";
import { checkMilaCardDto, type MilaCardDto, type MilaDoneData, type MilaStatusData } from "../../../../shared/milaCards";
import { createLogger } from "../../../logger";
import { THINKING_STATUS, TOOL_STATUS_FALLBACK, TOOL_STATUS_LABELS } from "../toolStatus";
import { cardDtos } from "./display";
import type { MastraStreamChunk, MastraTurnTap } from "./turn";

const logger = createLogger("agent/engine/mastra/chatV2Stream");

/** The AI SDK UI message stream's response headers (ai's UI_MESSAGE_STREAM_HEADERS, v7). */
export const UI_MESSAGE_STREAM_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

export const MILA_STATUS_PART = "data-mila-status";
export const MILA_CARD_PART = "data-mila-card";
export const MILA_DONE_PART = "data-mila-done";
/** The one sentence an `error` part says (as the v1 route's). */
export const STREAM_ERROR_TEXT = "Mila is unavailable right now — try again in a moment.";

export type UiPart =
  | { type: "start"; messageId?: string; messageMetadata: { runId: string | null } }
  | { type: "start-step" } | { type: "finish-step" }
  | { type: "text-start"; id: string } | { type: "text-end"; id: string } | { type: "text-delta"; id: string; delta: string }
  | { type: typeof MILA_STATUS_PART; id: "status"; data: MilaStatusData }
  | { type: typeof MILA_CARD_PART; id: string; data: MilaCardDto }
  | { type: typeof MILA_DONE_PART; data: MilaDoneData }
  | { type: "error"; errorText: string }
  | { type: "finish"; finishReason: "stop" | "error" | "other" };

/** Every part type the filter may write. */
export const ALLOWED_PART_TYPES: ReadonlySet<string> = new Set([
  "start", "start-step", "finish-step", "text-start", "text-delta", "text-end", MILA_STATUS_PART, MILA_CARD_PART, MILA_DONE_PART, "error", "finish",
]);

const STATUS_LABELS: ReadonlySet<string> = new Set([...Object.values(TOOL_STATUS_LABELS), TOOL_STATUS_FALLBACK, THINKING_STATUS]);
const str = (v: unknown): string | null => (typeof v === "string" && v.length <= 200 ? v : null);

export interface FilterState {
  /** The run (known once the run row exists). */
  runId: () => string | null;
  /** Card ids already written (shared with end(), so a card goes out once). */
  sent: Set<string>;
  started: boolean;
}

export const statusPart = (label: string, phase: MilaStatusData["phase"]): UiPart => ({ type: MILA_STATUS_PART, id: "status", data: { label, phase } });
const startPart = (runId: string | null): UiPart => ({ type: "start", ...(runId ? { messageId: runId } : {}), messageMetadata: { runId } });

/**
 * The allow-list: one upstream part in, zero or more safe parts out. Exported for the unit test (forged parts) and
 * used by createAllowListFilter.
 */
export function filterPart(raw: unknown, st: FilterState, running: Set<string> = new Set()): UiPart[] {
  const p = (raw ?? {}) as Record<string, any>;
  const type = typeof p.type === "string" ? p.type : "";
  const out: UiPart[] = [];
  if (!st.started) {
    st.started = true;
    out.push(startPart(st.runId()), statusPart(THINKING_STATUS, "thinking"));
    if (type === "start") return out;
  } else if (type === "start") return out;
  const endTool = (id: unknown) => {
    if (typeof id === "string") running.delete(id);
    if (!running.size) out.push(statusPart(THINKING_STATUS, "thinking"));
  };
  switch (type) {
    case "start-step": case "finish-step":
      out.push({ type });
      break;
    case "text-start": case "text-end": {
      const id = str(p.id);
      if (id) out.push({ type, id });
      break;
    }
    case "text-delta": {
      const id = str(p.id);
      if (id && typeof p.delta === "string") out.push({ type, id, delta: p.delta });
      break;
    }
    case "tool-input-available": {
      // Only the display rule's status line, and only if it is one of the fixed lines.
      const label = str(p.input?.label);
      if (typeof p.toolCallId === "string") running.add(p.toolCallId);
      out.push(statusPart(label && STATUS_LABELS.has(label) ? label : TOOL_STATUS_FALLBACK, "tool"));
      break;
    }
    case "tool-output-available": {
      const cards: unknown[] = Array.isArray(p.output?.cards) ? p.output.cards : [];
      for (const c of cards) pushCard(c, st, out);
      endTool(p.toolCallId);
      break;
    }
    case "tool-output-error": case "tool-input-error": case "tool-output-denied":
      endTool(p.toolCallId);
      break;
    case MILA_STATUS_PART: {
      const label = str(p.data?.label);
      if (label && STATUS_LABELS.has(label)) out.push(statusPart(label, p.data?.phase === "tool" ? "tool" : "thinking"));
      break;
    }
    case MILA_CARD_PART:
      pushCard(p.data, st, out);
      break;
    case "error":
      out.push({ type: "error", errorText: STREAM_ERROR_TEXT });
      break;
    default:
      // Everything else is dropped: tool-input-start / -delta, reasoning-*, source-*, file, custom, abort, finish
      // (end() writes the one finish), message-metadata, data-tool-call-approval / -suspended, data-tripwire, ...
      break;
  }
  return out;
}

function pushCard(c: unknown, st: FilterState, out: UiPart[]): void {
  const dto = checkMilaCardDto(c);
  if (!dto) { logger.warn({ runId: st.runId() }, "chat v2: card part dropped (not a valid card DTO)"); return; }
  if (st.sent.has(dto.data.id)) return;
  st.sent.add(dto.data.id);
  out.push({ type: MILA_CARD_PART, id: dto.data.id, data: dto });
}

export function createAllowListFilter(st: FilterState): TransformStream<unknown, UiPart> {
  const running = new Set<string>();
  return new TransformStream<unknown, UiPart>({
    transform(part, controller) {
      for (const safe of filterPart(part, st, running)) controller.enqueue(safe);
    },
  });
}

/** One part as SSE bytes (the AI SDK's JsonToSseTransformStream framing). */
export const sseFrame = (part: UiPart): string => `data: ${JSON.stringify(part)}\n\n`;
export const SSE_DONE = "data: [DONE]\n\n";

export interface ChatV2Stream {
  tap: MastraTurnTap;
  /** After the turn returned: its remaining cards ("How I got this", any not yet sent), done, finish. */
  end(result: { runId: string | null; status: MilaDoneData["status"]; stopReason?: string | null; cards?: ChatCard[]; error?: boolean }, messageIds: string[]): Promise<void>;
}

/**
 * The turn's tap and the pipeline behind it. `write` gets every safe part, in order; the caller stops writing when
 * the client leaves (the pipeline and the turn carry on).
 */
export async function createChatV2Stream(write: (part: UiPart) => void): Promise<ChatV2Stream> {
  const { toAISdkStream } = await import("@mastra/ai-sdk");
  let runId: string | null = null;
  const st: FilterState = { runId: () => runId, sent: new Set(), started: false };
  let ctl: ReadableStreamDefaultController<MastraStreamChunk> | null = null;
  let pump: Promise<void> | null = null;
  let dead = false;
  let textId: string | null = null;
  let n = 0;
  const emit = (part: UiPart) => { try { write(part); } catch (err: any) { logger.warn({ runId, err: err?.message }, "chat v2: write failed"); } };

  const open = () => {
    if (ctl || dead) return;
    const source = new ReadableStream<MastraStreamChunk>({ start(c) { ctl = c; } });
    const ui = toAISdkStream(source as never, { from: "agent", version: "v7", sendStart: true, sendFinish: false } as never) as unknown as ReadableStream<unknown>;
    const reader = ui.pipeThrough(createAllowListFilter(st)).getReader();
    pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        emit(value);
      }
    })().catch((err) => { dead = true; logger.warn({ runId, err: err?.message }, "chat v2: stream conversion failed"); });
  };
  const push = (c: MastraStreamChunk) => {
    open();
    if (dead || !ctl) return;
    try { ctl.enqueue(c); } catch { dead = true; }
  };
  const closeText = () => { if (textId) { push({ type: "text-end", payload: { id: textId } }); textId = null; } };

  return {
    tap: {
      // The run row exists: the phone gets the run id (and "Thinking…") at once, before the model's first chunk, so a
      // drop at any point after this can be caught up by GET /me/chat/v2/runs/:runId.
      run(id) {
        runId = id;
        if (!st.started) { st.started = true; emit(startPart(id)); emit(statusPart(THINKING_STATUS, "thinking")); }
      },
      chunk(c) { closeText(); push(c); },
      text(s) {
        if (!textId) { textId = `text-${++n}`; push({ type: "text-start", payload: { id: textId } }); }
        push({ type: "text-delta", payload: { id: textId, text: s } });
      },
    },
    async end(result, messageIds) {
      closeText();
      if (ctl && !dead) { try { ctl.close(); } catch { /* already closed */ } }
      await pump;
      const tail: UiPart[] = [];
      if (!st.started) { st.started = true; tail.push(startPart(result.runId ?? runId)); }
      for (const dto of cardDtos(result.cards ?? [], { toolName: "(turn)", runId: result.runId })) pushCard(dto, st, tail);
      if (result.error) tail.push({ type: "error", errorText: STREAM_ERROR_TEXT });
      tail.push(
        { type: MILA_DONE_PART, data: { runId: result.runId ?? runId, status: result.status, stopReason: result.stopReason ?? null, messageIds } },
        { type: "finish", finishReason: result.status === "completed" ? "stop" : result.status === "failed" ? "error" : "other" },
      );
      for (const part of tail) emit(part);
    },
  };
}
