/**
 * thread/wire.ts — chat v2's wire, as the app reads it (docs/design/mila-chat-v2.md). Pure: no React, no network.
 *
 *   POST /api/v1/me/chat/v2                  body { conversationId, message: { text, attachments? } } — ONLY the new turn
 *                                            (its text, and the ids of media she attached), never history
 *   GET  /api/v1/me/chat/v2/runs/:runId      → MilaRunStatus (after a drop: poll while "running")
 *   POST /api/v1/me/chat/v2/runs/:runId/stop → 202 | 409 (already ended) | 404
 *   GET  /api/v1/me/conversations/:id        → the saved turns (the catch-up after a drop, and reopening a chat)
 *
 * The stream is the AI SDK v7 UI message stream; the parts the server can send are `start` (messageMetadata.runId),
 * steps, text, `data-mila-status`, `data-mila-card`, `data-mila-done`, `error` and `finish`. Everything here reads the
 * AI SDK's message shape (UIMessage) the way useChat assembles it from those parts.
 */
import type { UIMessage } from "ai";
import { toMilaCardDto, type MilaCardDto, type MilaDoneData, type MilaRunStatus, type MilaStatusData } from "../../../../shared/milaCards";
import type { MilaNavChip, MilaNavTarget, MilaWidget } from "../../../hooks/use-mila-chat";

export const CHAT_V2_PATH = "/api/v1/me/chat/v2";
export const runPath = (runId: string) => `${CHAT_V2_PATH}/runs/${encodeURIComponent(runId)}`;
export const stopPath = (runId: string) => `${runPath(runId)}/stop`;
export const conversationPath = (conversationId: string) => `/api/v1/me/conversations/${encodeURIComponent(conversationId)}`;

/** What a message carries besides its parts: the run it belongs to (the `start` part), or that it was loaded saved. */
export interface MilaMessageMetadata {
  runId?: string | null;
  /** Loaded from GET /me/conversations/:id — a finished turn, never an unfinished run. */
  saved?: boolean;
  /** A spoken turn shown live from the voice session (a view: the voice worker saves the row). Never a typed turn. */
  voice?: boolean;
  /** The saved row's server id (a push can open the chat ON it). */
  serverId?: string;
  /** A saved Mila-started row she has not seen yet (opening the chat marks it seen). */
  unread?: boolean;
}

/** One thing she attached to a turn (the composer's ＋): an asset already in her media library. */
export interface MilaAttachmentData {
  assetId: string;
  role: "photo" | "video" | "product";
  /** For the bubble's thumbnail; null draws the role's glyph. */
  thumbUrl: string | null;
}

/** What today's chat draws under its newest answer: nav chips (open a screen) and follow-up questions. */
export interface MilaFollowUpsData {
  actions?: MilaNavChip[];
  suggestions?: string[];
}

/** The data parts chat v2 sends, by name (the part type is `data-<name>`). */
export type MilaDataParts = {
  "mila-card": MilaCardDto;
  "mila-status": MilaStatusData;
  "mila-done": MilaDoneData;
  // Client-side parts (the server's stream never carries these; its filter drops anything it did not make):
  // her attachments on her own message (assistant-ui's composer attachments → our adapter, thread/attachments.ts) …
  "mila-attachment": MilaAttachmentData;
  // … a v1 widget (a voice push, or a saved row's `widget`), drawn by today's MilaWidget …
  "mila-widget": MilaWidget;
  // … and a saved row's nav chips (`app_actions`).
  "mila-followups": MilaFollowUpsData;
};

export type MilaUIMessage = UIMessage<MilaMessageMetadata, MilaDataParts>;
export type { MilaRunStatus };

export interface ChatV2Body {
  conversationId: string;
  message: { text: string; attachments?: Array<{ asset_id: string; role: MilaAttachmentData["role"] }> };
}

/**
 * The request body: the conversation, the new text and (only when she attached something) the attached assets' ids and
 * roles, the shape POST /me/chat takes. Nothing else ever goes up (no history, ids or state).
 */
export function chatV2Body(conversationId: string, text: string, attachments: readonly MilaAttachmentData[] = []): ChatV2Body {
  if (!attachments.length) return { conversationId, message: { text } };
  return { conversationId, message: { text, attachments: attachments.map((a) => ({ asset_id: a.assetId, role: a.role })) } };
}

/** The plain text of a message's text parts, joined. */
export function textOf(message: Pick<MilaUIMessage, "parts"> | undefined): string {
  if (!message) return "";
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** The athlete's newest typed message text: the only thing a send (or a retry) carries. A spoken turn is not one. */
export function lastUserText(messages: readonly Pick<MilaUIMessage, "role" | "parts" | "metadata">[]): string {
  const m = lastTypedUser(messages);
  return m ? textOf(m) : "";
}

/** Her newest typed message's attachments (what a send, or a retry of it, carries). */
export function lastUserAttachments(messages: readonly Pick<MilaUIMessage, "role" | "parts" | "metadata">[]): MilaAttachmentData[] {
  return attachmentsOf(lastTypedUser(messages));
}

function lastTypedUser<M extends Pick<MilaUIMessage, "role" | "metadata">>(messages: readonly M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !messages[i].metadata?.voice) return messages[i];
  return undefined;
}

/** A message's `data-mila-attachment` parts. */
export function attachmentsOf(message: Pick<MilaUIMessage, "parts"> | undefined): MilaAttachmentData[] {
  if (!message) return [];
  return message.parts.filter((p) => p.type === "data-mila-attachment").map((p) => (p as { data: MilaAttachmentData }).data);
}

/** A message's follow-ups (nav chips and questions), when it carries any. */
export function followUpsOf(message: Pick<MilaUIMessage, "parts"> | undefined): MilaFollowUpsData | null {
  if (!message) return null;
  for (const p of message.parts) if (p.type === "data-mila-followups") return (p as { data: MilaFollowUpsData }).data;
  return null;
}

/** The attachment-only turn's text: the server reads an empty text with attachments the same way (ATTACHMENT_ONLY_MESSAGE). */
export const ATTACHMENT_ONLY_TEXT = "Take a look at this.";

type AnyPart = MilaUIMessage["parts"][number];
const isPart = (p: AnyPart, type: string): p is AnyPart & { data: unknown } => p.type === type;

/** The turn's last `data-mila-status` (the server sends one part id, "status", reconciled in place). */
export function statusOf(message: MilaUIMessage | undefined): MilaStatusData | null {
  if (!message) return null;
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const p = message.parts[i];
    if (isPart(p, "data-mila-status")) return p.data as MilaStatusData;
  }
  return null;
}

/** The turn's `data-mila-done`, when the stream got that far. */
export function doneOf(message: MilaUIMessage | undefined): MilaDoneData | null {
  if (!message) return null;
  for (const p of message.parts) if (isPart(p, "data-mila-done")) return p.data as MilaDoneData;
  return null;
}

/** The turn's cards, in the order they arrived. */
export function cardsOf(message: MilaUIMessage | undefined): MilaCardDto[] {
  if (!message) return [];
  return message.parts.filter((p) => isPart(p, "data-mila-card")).map((p) => (p as { data: MilaCardDto }).data);
}

/**
 * The newest message that is not a live voice line. A spoken line can land while a typed reply is still streaming (the
 * voice session runs beside the composer), so "how did the typed turn end" reads past any voice lines after it.
 */
export function lastTypedOf<M extends Pick<MilaUIMessage, "metadata">>(messages: readonly M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].metadata?.voice) return messages[i];
  return undefined;
}

/**
 * The run a live (streamed, not loaded) assistant turn belongs to while it has not reached `data-mila-done`: the turn
 * to catch up on after a drop or a resume. Null when the last message is not such a turn.
 */
export function unfinishedRunOf(messages: readonly MilaUIMessage[]): string | null {
  const last = lastTypedOf(messages);
  if (!last || last.role !== "assistant" || last.metadata?.saved) return null;
  const runId = last.metadata?.runId;
  if (!runId) return null;
  return doneOf(last) ? null : runId;
}

/** One row of GET /api/v1/me/conversations/:id (server/mila/conversations.ts). */
export interface SavedChatRow {
  id?: string | number;
  role: "user" | "assistant";
  content: string;
  agentCards?: unknown[] | null;
  /** A v1 widget the row showed (a voice push's card, or an older turn's). */
  widget?: MilaWidget | null;
  /** The row's nav chips (older turns). */
  app_actions?: MilaNavChip[] | null;
  milaStarted?: boolean;
  unread?: boolean;
}

/**
 * The saved turns as messages: text, then the turn's cards as the same `data-mila-card` parts the stream sends (each
 * card goes through the shared DTO schema, so a reloaded card carries exactly the fields a streamed one does), then a
 * v1 widget the row showed (today's chat draws it with MilaWidget, and so does this one) and its nav chips. Marked
 * `saved`: a loaded turn is finished.
 */
export function savedToMessages(rows: readonly SavedChatRow[]): MilaUIMessage[] {
  return rows.map((r, i) => {
    const id = r.id != null ? `saved-${r.id}` : `saved-${i}-${r.role}`;
    const parts: AnyPart[] = [];
    if (r.content) parts.push({ type: "text", text: r.content, state: "done" } as AnyPart);
    if (r.role === "assistant") {
      // One part per card id, as the stream has it: the AI SDK reconciles a data part whose id it has already seen in
      // place (the later data wins, at the first one's position). A saved row can hold the same card twice (a turn that
      // called bookings_get twice for one booking, Nov 2026), and it must draw once, as it did live.
      const seen = new Map<string, AnyPart & { data: MilaCardDto }>();
      for (const c of r.agentCards ?? []) {
        const dto = toMilaCardDto(c);
        if (!dto.ok) continue;
        const prior = seen.get(dto.dto.data.id);
        if (prior) { prior.data = dto.dto; continue; }
        const part = { type: "data-mila-card", id: dto.dto.data.id, data: dto.dto } as AnyPart & { data: MilaCardDto };
        seen.set(dto.dto.data.id, part);
        parts.push(part);
      }
      if (isWidget(r.widget)) parts.push({ type: "data-mila-widget", data: r.widget } as AnyPart);
      const actions = (r.app_actions ?? []).filter(isNavChip);
      if (actions.length) parts.push({ type: "data-mila-followups", data: { actions } } as AnyPart);
    }
    const metadata: MilaMessageMetadata = { saved: true };
    if (r.id != null) metadata.serverId = String(r.id);
    if (r.unread) metadata.unread = true;
    return { id, role: r.role, parts, metadata };
  });
}

const isWidget = (w: unknown): w is MilaWidget =>
  !!w && typeof w === "object" && typeof (w as { type?: unknown }).type === "string"
  && typeof (w as { data?: unknown }).data === "object" && (w as { data?: unknown }).data !== null;
/**
 * The screens a saved row's nav chip may open (hooks/use-mila-chat MilaNavTarget), each with the id it must carry. A row
 * is the model's output, saved: a target off this list, or one missing its id, is dropped rather than handed to the
 * navigator (which would close the chat for nothing, or open a screen without its subject).
 */
const NAV_TARGET_IDS: Readonly<Record<MilaNavTarget["screen"], string | null>> = {
  deal: "threadId", add_contract: "requestId", add_document: "requestId", deals: null, score: null, signals: null,
  profile: null, studio: null, pitches: null, media: null, deck: null, rates: null, facts: null, story: null,
  home: null, goals: null, me: null, camera_roll: null, opportunity: "opportunityId", deals_closed: null,
  booking: "bookingId", deal_detail: "dealId",
};
export function isNavChip(a: unknown): a is MilaNavChip {
  if (!a || typeof a !== "object") return false;
  const { label, target } = a as { label?: unknown; target?: unknown };
  if (typeof label !== "string" || !label.trim() || !target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  if (typeof t.screen !== "string" || !Object.prototype.hasOwnProperty.call(NAV_TARGET_IDS, t.screen)) return false;
  const idKey = NAV_TARGET_IDS[t.screen as MilaNavTarget["screen"]];
  return idKey === null || (typeof t[idKey] === "string" && (t[idKey] as string).length > 0);
}

/**
 * Mila's words as plain text for the clipboard. She writes plain text, but a model can slip into markdown; this takes
 * the marks off so a pasted message reads as words (bold, italics, code, headings, links, list bullets, quotes).
 */
export function plainTextForCopy(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
