/**
 * agent/engine/mastra/guards.ts — tenant guards around every Mastra memory/agent call (security review 28 Oct 2026).
 *
 * Mastra is a library here; OUR tables decide ownership, before Mastra sees an id:
 *   threads   a Mastra thread id is always one of OUR mila_tf_sessions row ids (server-generated UUIDs), found by
 *             (athlete, conversation) or minted by us; the row must belong to the athlete. @mastra/pg 1.32.0 saveThread
 *             upserts ON CONFLICT(id) and rewrites resourceId (mastra#26216 root cause, still in storage), so a foreign
 *             id must never reach Mastra memory. Mastra's own thread row, when it exists, must name the same athlete
 *             as resource (defence in depth: a rewritten owner is refused, not used).
 *   runs      a Mastra run id is always OUR agent_runs id (passed as runId), so runs are addressable only by ids we
 *             own; anything that acts on a run by id (approve, decline, resume) checks agent_runs.athlete_id first
 *             (mastra#25716: core resolves runs by runId alone). We expose no runId-based Mastra control today.
 *   messages  the turn's input is TEXT (Mastra mints the message ids); no client message id or message object ever
 *             reaches Mastra (mastra#26216: a message upsert by id rewrites thread_id/resourceId). Any read of Mastra
 *             messages by id goes through assertMessagesOwned (storage listMessagesById is a global lookup).
 *   images    the ONE exception to text-only (3 Nov 2026): images of her own attachments, and only images this server
 *             made (attachments.ts mints them from her library after re-checking ownership; turnImageContext refuses
 *             anything else: a URL, a data URI, a client's bytes, a look-alike object). They go to Mastra, with the
 *             server's own text about them (the library's analysis), as a `context` message (sent to the model, never
 *             saved to the thread), as inline base64 JPEG, never a URL.
 *   context   requestContext is built here, server-side, from the VERIFIED athlete pass only: the pass for our tools,
 *             and Mastra's reserved resource/thread keys pinned to the pass's athlete and session (in core they win
 *             over memory.resource/thread). The pass must name the athlete and thread of the turn. Nothing from a
 *             client body is copied into it.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { agentRuns, milaTfSessions } from "../../../../shared/schema";
import { verifyAthletePass } from "../tools/pass";
import { PASS_CONTEXT_KEY } from "../config";
import { isServerImage, MAX_TURN_IMAGES } from "./serverImage";

export type TenantGuardCode =
  | "thread_not_owned" | "thread_resource_mismatch" | "run_not_owned" | "pass_mismatch" | "message_not_owned" | "input_not_text"
  | "image_not_server";

export class TenantGuardError extends Error {
  constructor(readonly code: TenantGuardCode, message: string) { super(message); this.name = "TenantGuardError"; }
}

export interface GuardDeps {
  /** Our session row for (athlete, thread id). Default: mila_tf_sessions. */
  ownsThread?: (athleteId: string, threadId: string) => Promise<boolean>;
  /** Our run row for (athlete, run id). Default: agent_runs. Used by assertRunOwned (the guard for any future run-id control). */
  ownsRun?: (athleteId: string, runId: string) => Promise<boolean>;
}

const ownsThreadDb = async (athleteId: string, threadId: string) =>
  (await db.select({ id: milaTfSessions.id }).from(milaTfSessions)
    .where(and(eq(milaTfSessions.id, threadId), eq(milaTfSessions.athlete_id, athleteId))).limit(1)).length > 0;
const ownsRunDb = async (athleteId: string, runId: string) =>
  (await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1)).length > 0;

type ThreadReader = { getThreadById(a: { threadId: string }): Promise<{ resourceId?: string } | null> };

/**
 * Throws unless the thread is the athlete's in OUR table and (if Mastra has it) Mastra's row names the same resource.
 * Returns whether Mastra already holds the thread (false: this turn opens it).
 */
export async function assertThreadOwned(memory: ThreadReader, athleteId: string, threadId: string, deps: GuardDeps = {}): Promise<{ exists: boolean }> {
  if (!(await (deps.ownsThread ?? ownsThreadDb)(athleteId, threadId))) throw new TenantGuardError("thread_not_owned", "thread is not this athlete's");
  const t = await memory.getThreadById({ threadId });
  if (t && t.resourceId !== athleteId) throw new TenantGuardError("thread_resource_mismatch", "Mastra thread names another resource");
  return { exists: !!t };
}

/**
 * REQUIRED GUARD, no production caller yet (on purpose): any future code that acts on a Mastra run by id (approve,
 * decline, resume, cancel, read) must call this first; core resolves runs by runId alone (mastra#25716). Kept with its
 * isolation test so that code has the check ready, not reinvented.
 */
export async function assertRunOwned(athleteId: string, runId: string, deps: GuardDeps = {}): Promise<void> {
  if (!(await (deps.ownsRun ?? ownsRunDb)(athleteId, runId))) throw new TenantGuardError("run_not_owned", "run is not this athlete's");
}

type MessageReader = { getStore(name: "memory"): Promise<{ listMessagesById(a: { messageIds: string[] }): Promise<{ messages: Array<{ id: string; threadId?: string; resourceId?: string }> }> } | undefined> };

/**
 * Mastra messages by id, only if EVERY one is in one of the athlete's own threads (our table) and names them as
 * resource. Storage's listMessagesById is a global lookup by id, so this is the only way we read messages by id.
 * REQUIRED GUARD, no production caller yet (on purpose): nothing reads Mastra messages by id today; any future code
 * that does must go through this (mastra#26216).
 */
export async function assertMessagesOwned(
  storage: MessageReader, athleteId: string, messageIds: string[], deps: GuardDeps = {},
): Promise<Array<{ id: string; threadId?: string; resourceId?: string }>> {
  if (!messageIds.length) return [];
  const store = await storage.getStore("memory");
  if (!store) throw new TenantGuardError("message_not_owned", "no message store");
  const { messages } = await store.listMessagesById({ messageIds });
  if (messages.length !== new Set(messageIds).size) throw new TenantGuardError("message_not_owned", "message not found");
  for (const m of messages) {
    if (m.resourceId !== athleteId || !m.threadId || !(await (deps.ownsThread ?? ownsThreadDb)(athleteId, m.threadId))) {
      throw new TenantGuardError("message_not_owned", "message is not this athlete's");
    }
  }
  return messages;
}

/** The turn's input to Mastra: text only (Mastra mints message ids). A message object with its own id is refused. */
export function turnInput(text: unknown): string {
  if (typeof text !== "string") throw new TenantGuardError("input_not_text", "a Mastra turn takes text only");
  return text;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The images of a turn, as Mastra `context` messages: ONLY images minted by attachments.ts (server-resolved from her
 * own library), each base64 JPEG bytes (never a URL: Mastra would download one), at most MAX_TURN_IMAGES. `block` is
 * the server's own fenced text about the attachments (the library's analysis); it may stand alone, for an attachment
 * described with no image. Anything else throws (image_not_server): the turn fails closed rather than pass on an image
 * it did not make. No images and no block → no context message.
 */
export function turnImageContext(images: unknown, block: unknown): Array<{ role: "user"; content: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: "image/jpeg" }> }> {
  if (!Array.isArray(images)) throw new TenantGuardError("image_not_server", "images must come from the server's attachment step");
  if (images.length > MAX_TURN_IMAGES) throw new TenantGuardError("image_not_server", "too many images for one turn");
  if (typeof block !== "string") throw new TenantGuardError("input_not_text", "the attachment block is text");
  if (!images.length && !block) return [];
  if (!block) throw new TenantGuardError("image_not_server", "images come with the server's block about them");
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: "image/jpeg" }> = [{ type: "text", text: block }];
  for (const img of images) {
    if (!isServerImage(img)) throw new TenantGuardError("image_not_server", "an image the server did not make");
    // Belt and braces on the minted value itself: raw base64 of a JPEG, never a URL or a data URI.
    if (img.mediaType !== "image/jpeg" || typeof img.data !== "string" || !BASE64_RE.test(img.data) || !img.data.startsWith("/9j/")) {
      throw new TenantGuardError("image_not_server", "an image that is not inline JPEG bytes");
    }
    content.push({ type: "text", text: img.label }, { type: "image", image: img.data, mediaType: "image/jpeg" });
  }
  return [{ role: "user", content }];
}

/**
 * The requestContext for one call, from the signed pass only. The pass must be valid (signature, expiry) and name
 * the athlete and the thread (= our session row = pass `sid`) of this turn.
 */
export async function contextFromPass(pass: string, expect: { athleteId: string; threadId: string }, passKey?: string | null) {
  const verified = verifyAthletePass(pass, passKey);   // throws PassError on anything forged, expired or malformed
  if (verified.athleteId !== expect.athleteId) throw new TenantGuardError("pass_mismatch", "pass names another athlete");
  if (verified.sessionId !== expect.threadId) throw new TenantGuardError("pass_mismatch", "pass names another thread");
  const { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } = await import("@mastra/core/request-context");
  const rc = new RequestContext();
  rc.set(PASS_CONTEXT_KEY, pass);
  rc.set(MASTRA_RESOURCE_ID_KEY, verified.athleteId);
  rc.set(MASTRA_THREAD_ID_KEY, expect.threadId);
  return { requestContext: rc, pass: verified };
}
