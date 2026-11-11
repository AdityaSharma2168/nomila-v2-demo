/**
 * thread/api.ts — chat v2's transport and its three side calls (run status, Stop, the saved turns), built over a fetch
 * and a header source the caller hands in. The app passes expo/fetch (a streaming body on iOS and Android; the browser's
 * fetch on web) and getAuthHeaders; the dev smoke script (scripts/dev/chat-v2-smoke.ts) passes Node's fetch and a test
 * athlete's token — so the smoke run parses the real stream with exactly the app's code.
 *
 * The transport is assistant-ui's AssistantChatTransport (the AI SDK's DefaultChatTransport underneath: the SSE parser,
 * the UI message chunk schema). `prepareSendMessagesRequest` replaces the whole body with chatV2Body: the conversation
 * and the newest user text, never the history useChat holds. Headers are read per request, so a refreshed token is used.
 */
import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import {
  ATTACHMENT_ONLY_TEXT, CHAT_V2_PATH, chatV2Body, conversationPath, lastUserAttachments, lastUserText, runPath, savedToMessages, stopPath,
  type MilaRunStatus, type MilaUIMessage, type SavedChatRow,
} from "./wire";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MilaApiDeps {
  /** The API origin, e.g. https://nomila-v2-….run.app (no trailing slash). */
  apiUrl: () => string;
  /** Authorization (and the selected athlete) for one request. */
  headers: () => Promise<Record<string, string>>;
  /** The conversation the next send belongs to. */
  conversationId: () => string;
  fetch: FetchLike;
}

export type StopResult = "stopping" | "ended" | "not_found" | "failed";

export interface MilaApi {
  transport: AssistantChatTransport<MilaUIMessage>;
  getRun(runId: string, signal?: AbortSignal): Promise<MilaRunStatus | null>;
  stopRun(runId: string): Promise<StopResult>;
  /** The saved turns of a conversation; null when they could not be read (the screen keeps what it has). */
  loadConversation(conversationId: string): Promise<MilaUIMessage[] | null>;
}

/** The new turn only: her newest typed text and its attachments' ids (an attachment-only turn reads "Take a look at
 *  this.", as today's chat sends it). Never history. */
function requestBody(conversationId: string, messages: readonly MilaUIMessage[]) {
  const attachments = lastUserAttachments(messages);
  const text = lastUserText(messages);
  return chatV2Body(conversationId, text.trim() || !attachments.length ? text : ATTACHMENT_ONLY_TEXT, attachments);
}

export function createMilaApi(deps: MilaApiDeps): MilaApi {
  const url = (path: string) => `${deps.apiUrl().replace(/\/+$/, "")}${path}`;
  const transport = new AssistantChatTransport<MilaUIMessage>({
    api: url(CHAT_V2_PATH),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => deps.fetch(String(input), init)) as typeof fetch,
    prepareSendMessagesRequest: async ({ messages }) => ({
      api: url(CHAT_V2_PATH),
      headers: await deps.headers(),
      body: requestBody(deps.conversationId(), messages),
    }),
  });

  return {
    transport,
    async getRun(runId, signal) {
      try {
        const res = await deps.fetch(url(runPath(runId)), { method: "GET", headers: await deps.headers(), signal });
        if (!res.ok) return null;
        return (await res.json()) as MilaRunStatus;
      } catch {
        return null;
      }
    },
    async stopRun(runId) {
      try {
        const res = await deps.fetch(url(stopPath(runId)), { method: "POST", headers: await deps.headers() });
        if (res.status === 202) return "stopping";
        if (res.status === 409) return "ended";
        if (res.status === 404) return "not_found";
        return "failed";
      } catch {
        return "failed";
      }
    },
    async loadConversation(conversationId) {
      try {
        const res = await deps.fetch(url(conversationPath(conversationId)), { method: "GET", headers: await deps.headers() });
        if (res.status === 404) return [];
        if (!res.ok) return null;
        const data = (await res.json()) as { messages?: SavedChatRow[] };
        return savedToMessages(data.messages ?? []);
      } catch {
        return null;
      }
    },
  };
}

/**
 * One turn, sent and read to the end through the app's transport (the smoke script's path): every chunk the parser
 * produced, in order, and the message useChat would have assembled from them (the AI SDK's readUIMessageStream).
 */
export async function sendAndCollect(
  api: MilaApi, text: string, opts: { chatId?: string; signal?: AbortSignal; onChunk?: (c: UIMessageChunk) => void } = {},
): Promise<{ chunks: UIMessageChunk[]; message: MilaUIMessage | null; error: unknown }> {
  const user: MilaUIMessage = { id: "u-1", role: "user", parts: [{ type: "text", text }] };
  const chunks: UIMessageChunk[] = [];
  let message: MilaUIMessage | null = null;
  let error: unknown = null;
  try {
    const stream = await api.transport.sendMessages({
      chatId: opts.chatId ?? "smoke",
      messages: [user],
      abortSignal: opts.signal,
      trigger: "submit-message",
      messageId: undefined,
    });
    const tapped = stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(c, ctl) { chunks.push(c); opts.onChunk?.(c); ctl.enqueue(c); },
    }));
    for await (const m of readUIMessageStream<MilaUIMessage>({ stream: tapped, onError: (e) => { error = e; } })) message = m;
  } catch (e) {
    error = e;
  }
  return { chunks, message, error };
}
