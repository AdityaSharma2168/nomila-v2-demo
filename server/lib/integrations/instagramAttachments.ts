/**
 * instagramAttachments.ts — Instagram DMs that carry an attachment (owner, 4 Nov 2026).
 *
 * A DM that held only a photo, a video, a file, a shared post or a story reply used to vanish: the webhook
 * kept text messages only and `continue`d past everything else, with no log and no receipt. Now:
 *
 *   - an attachment-only DM is RECORDED on its conversation's thread as a message whose body is a plain
 *     placeholder naming the type ("[Photo]", "[Video]", "[File]", "[Shared post]" …). Never invented content.
 *     The type and the Graph media id go in the message's `attachments` column for the later download step (never
 *     the CDN url: it expires and carries a signature in its query string).
 *     It is never sent to deal detection: a placeholder is not text a brand wrote, so "[Photo]" is never classified.
 *   - a DM with text AND an attachment goes to deal detection exactly as before, with its text; the attachment
 *     metadata rides along on the same row.
 *   - a payload we cannot read (no text, no attachment we know, not an unsend) is dead-lettered in
 *     gmail_dead_letters (shared by Gmail and Outlook, keyed by connection + message id) with the reason, and logged.
 *     No retrier reads Instagram rows yet; the row is the receipt that it arrived.
 *
 * The placeholders are model-facing (Mila reads thread history): registered in the Prompt Register
 * (Mila & agent page, "Instagram attachment placeholders").
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { gmailDeadLetters, inboxMessages, inboxThreads, type InboxAttachment } from "../../../shared/schema";
import { findThreadByExternalId, registerThreadAlias } from "../threadAliases";
import { inboxBodyFingerprint } from "../inboxBodyFingerprint";
import { createLogger } from "../../logger";

const logger = createLogger("integrations/instagramAttachments");

/** The webhook `message` object, as Meta delivers it (only the fields read here). */
export interface IgWebhookMessage {
  mid?:            string;
  text?:           string;
  is_echo?:        boolean;
  is_deleted?:     boolean;
  is_unsupported?: boolean;
  attachments?:    Array<{ type?: string; payload?: Record<string, unknown> | null }>;
  reply_to?:       { mid?: string; story?: { url?: string; id?: string } | null } | null;
}

/**
 * Webhook attachment type → the placeholder shown in place of text. Meta's documented `messages` types
 * (developers.facebook.com/docs/instagram-platform/webhooks/examples). Anything else is unknown.
 */
export const IG_ATTACHMENT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  image:         "[Photo]",          // includes GIFs and stickers
  video:         "[Video]",
  audio:         "[Voice message]",
  file:          "[File]",
  media:         "[Media]",
  share:         "[Shared post]",
  ig_post:       "[Shared post]",
  ig_reel:       "[Shared reel]",
  reel:          "[Shared reel]",
  story:         "[Shared story]",
  ig_story:      "[Shared story]",
  story_mention: "[Story mention]",
};
export const IG_STORY_REPLY_PLACEHOLDER  = "[Story reply]";
export const IG_UNSUPPORTED_PLACEHOLDER  = "[Unsupported attachment]";

/**
 * The media id from a Graph CDN url, when the payload gave no id of its own. Messaging attachment urls look like
 * `lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=<id>&signature=<sig>`; only the asset id is kept.
 */
function assetIdFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).searchParams.get("asset_id") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kept for the later download step: the type and the Graph media id. The CDN url itself is NOT stored: it expires
 * and carries a signature (`signature=`, `oh=`/`oe=`) in its query string, so the download step re-reads the message
 * from Graph by its id instead.
 */
function attachmentMeta(type: string, payload: Record<string, unknown> | null | undefined, placeholder: string): InboxAttachment {
  const id = ["id", "ig_post_media_id", "reel_video_id", "story_media_id"]
    .map((k) => payload?.[k])
    .find((v) => typeof v === "string" || typeof v === "number") ?? assetIdFromUrl(payload?.url);
  return {
    filename:     placeholder.replace(/^\[|\]$/g, ""),
    content_type: `instagram/${type}`,
    bytes:        0,
    parsed:       false,
    ig_type:      type,
    ...(id != null ? { ig_media_id: String(id) } : {}),
  };
}

export type IgMessageShape =
  | { kind: "text";        text: string; attachments: InboxAttachment[] }
  | { kind: "placeholder"; placeholder: string; attachments: InboxAttachment[] }
  | { kind: "deleted" }                          // an unsend — not a new message
  | { kind: "unknown";     reason: string };

/** Read one webhook message: text (with any attachments), placeholder-only, an unsend, or unknown. */
export function describeIgMessage(message: IgWebhookMessage): IgMessageShape {
  const text = message.text?.trim() ?? "";
  if (message.is_deleted) return { kind: "deleted" };

  const attachments: InboxAttachment[] = [];
  const placeholders: string[] = [];
  const unknownTypes: string[] = [];
  for (const a of message.attachments ?? []) {
    const type = (a?.type ?? "").trim();
    const placeholder = IG_ATTACHMENT_PLACEHOLDERS[type];
    if (!placeholder) { unknownTypes.push(type || "(none)"); continue; }
    placeholders.push(placeholder);
    attachments.push(attachmentMeta(type, a.payload, placeholder));
  }
  const story = message.reply_to?.story;
  if (story) {
    attachments.push(attachmentMeta("story_reply", { url: story.url, id: story.id }, IG_STORY_REPLY_PLACEHOLDER));
    if (!text) placeholders.push(IG_STORY_REPLY_PLACEHOLDER);
  }
  if (message.is_unsupported && placeholders.length === 0 && !text) {
    placeholders.push(IG_UNSUPPORTED_PLACEHOLDER);
    attachments.push({ filename: "Unsupported attachment", content_type: "instagram/unsupported", bytes: 0, parsed: false, ig_type: "unsupported" });
  }

  if (text) return { kind: "text", text, attachments };
  if (placeholders.length > 0) {
    return { kind: "placeholder", placeholder: placeholders.join(" "), attachments: attachments.map((a) => ({ ...a, placeholder: true })) };
  }
  return {
    kind:   "unknown",
    reason: unknownTypes.length > 0 ? `unknown attachment type: ${unknownTypes.join(", ")}` : "no text and no attachment",
  };
}

/**
 * Record an attachment-only DM on its conversation's thread: the same thread a text DM from this sender lands on
 * (keyed by the IG conversation id, aliases honoured), or a new unread thread when there is none. Idempotent on the
 * message id. No classification is written and no model is called: a later text DM on the thread is classified as usual.
 */
export async function recordIgPlaceholderMessage(params: {
  athleteId:      string;
  connectionId:   string;
  threadKey:      string;       // IG conversation id, or `ig:<sender>` when it could not be resolved
  messageId:      string;
  senderIgUserId: string;
  senderName:     string;
  placeholder:    string;
  attachments:    InboxAttachment[];
  at:             Date;
}): Promise<{ recorded: boolean; threadId: string }> {
  const { athleteId, connectionId, threadKey, messageId } = params;

  const [dupe] = await db.select({ thread_id: inboxMessages.thread_id }).from(inboxMessages)
    .where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.external_message_id, messageId)))
    .limit(1);
  if (dupe) return { recorded: false, threadId: dupe.thread_id };

  let threadId = (await findThreadByExternalId(athleteId, threadKey))?.id;
  if (!threadId) {
    const [t] = await db.insert(inboxThreads).values({
      athlete_id:           athleteId,
      subject:              `DM from ${params.senderName}`,
      last_message_at:      params.at,
      message_count:        0,
      status:               "unread",
      external_thread_id:   threadKey,
      connected_account_id: connectionId,
    }).onConflictDoUpdate({
      target: [inboxThreads.athlete_id, inboxThreads.external_thread_id],
      set:    { connected_account_id: connectionId },
    }).returning({ id: inboxThreads.id });
    threadId = t.id;
  }

  const inserted = await db.insert(inboxMessages).values({
    thread_id:            threadId,
    athlete_id:           athleteId,
    sender_email:         params.senderName,
    sender_name:          params.senderName,
    direction:            "inbound",
    subject:              `DM from ${params.senderName}`,
    body:                 params.placeholder,
    body_sha256:          inboxBodyFingerprint(params.placeholder),
    attachments:          params.attachments.length ? params.attachments : null,
    received_at:          params.at,
    external_message_id:  messageId,
    platform:             "instagram",
    gmail_thread_id:      threadKey,
    sender_ig_user_id:    params.senderIgUserId,
    connected_account_id: connectionId,
  }).onConflictDoNothing().returning({ id: inboxMessages.id });

  if (inserted.length > 0) {
    await db.update(inboxThreads).set({
      last_message_at: sql`greatest(${inboxThreads.last_message_at}, ${params.at.toISOString()}::timestamptz)`,
      message_count:   sql`coalesce(${inboxThreads.message_count}, 0) + 1`,
    }).where(eq(inboxThreads.id, threadId));
    await registerThreadAlias(threadId, threadKey);
  }
  return { recorded: inserted.length > 0, threadId };
}

/**
 * SQL condition: the row is NOT a placeholder-only message. Readers that pick "the newest inbound message" to feed a
 * classifier use it, so a later "[Photo]" never stands in for the text the brand actually wrote.
 */
export const notPlaceholderOnly = sql`not coalesce(${inboxMessages.attachments} @> '[{"placeholder": true}]'::jsonb, false)`;

/** A payload we could not read: a visible dead letter (and a warn log), never a silent skip. */
export async function deadLetterIgMessage(params: {
  athleteId: string; connectionId: string; messageId: string; reason: string;
}): Promise<void> {
  await db.insert(gmailDeadLetters).values({
    connected_account_id: params.connectionId,
    athlete_id:           params.athleteId,
    gmail_message_id:     params.messageId,
    error:                `instagram: ${params.reason}`.slice(0, 500),
  }).onConflictDoNothing();
  logger.warn({ connectionId: params.connectionId, messageId: params.messageId, reason: params.reason }, "Instagram DM not readable — dead-lettered");
}
