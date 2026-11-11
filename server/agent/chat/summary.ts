/**
 * agent/chat/summary.ts — the agent chat's rolling conversation summary (design §6).
 *
 * Reuses what the old loop built: conversations.summary + summary_through_message_id, and its thresholds (fold once more
 * than MILA.SUMMARY_TRIGGER_MESSAGES = 30 replayable messages sit after the watermark; keep the newest
 * MILA.SUMMARY_TAIL_MESSAGES = 10 word for word) — server/mila/conversations.ts maybeSummarizeConversation does the
 * reading, the watermark and the write. Only the folding call is new: the chat/summary skill (cheap tier, minimal effort,
 * no tools, one step), one traced call (engine/textSkill.ts runTextSkill), so every fold is an agent_runs row with its
 * cost. It no longer runs on the harness loop (5 Nov 2026): the same call, so the Mastra engine needs nothing from it.
 *
 * After a turn, asynchronously: the reply never waits for it, and a failed fold is retried on a later turn. The summary
 * writes no facts — facts and preferences are written only through the chat's own tools, on the athlete's tap.
 *
 * Bounded (maybeFoldAgentConversation): one fold at a time per conversation in this process (a second turn's fold while
 * one runs is skipped: the next turn folds); settles within FOLD_TIMEOUT_MS (the model call is aborted at the bound and
 * a late answer is never written); nothing starts, and nothing is written, once account deletion has fenced the athlete;
 * the call is a traced run, so its cost is an agent_runs row under the skill's run cap and the athlete's day cap.
 */
import { createLogger } from "../../logger";
import { buildSummarizerInput, maybeSummarizeConversation } from "../../mila/conversations";
import { isAthleteDeleting } from "../../lib/privacy/deletionFence";
import { runTextSkill, type TextSkillDeps } from "../engine/textSkill";

/** What a fold's call needs (a test's provider and runtime). */
export type FoldDeps = TextSkillDeps;

const logger = createLogger("agent/chat/summary");

export const CHAT_SUMMARY_SKILL = "chat/summary";
export const CHAT_SUMMARY_MAX_CHARS = 1200;
/** A fold settles within this (ms): the model call is aborted and nothing late is written. */
export const FOLD_TIMEOUT_MS = 45_000;

/** One chat/summary call over a prepared input (prior summary + turns to fold, fenced as data). "" unless it completed. */
async function summaryCall(athleteId: string, conversationId: string | null, input: string, deps: FoldDeps, signal?: AbortSignal): Promise<string> {
  const r = await runTextSkill({ athleteId, skillId: CHAT_SUMMARY_SKILL, trigger: "chat", conversationId, message: input, ...(signal ? { signal } : {}) }, deps);
  if (r.status !== "completed") return "";
  const text = r.text.replace(/\s+/g, " ").trim();
  return text.length > CHAT_SUMMARY_MAX_CHARS ? `${text.slice(0, CHAT_SUMMARY_MAX_CHARS - 1).trimEnd()}…` : text;
}

/** Fold older turns into the prior summary (the chat eval calls this on its in-memory conversation). */
export function foldSummary(
  p: { athleteId: string; conversationId: string | null; priorSummary: string | null; turns: Array<{ role: string; content: string }> },
  deps: FoldDeps = {},
): Promise<string> {
  return summaryCall(p.athleteId, p.conversationId, buildSummarizerInput(p.priorSummary, p.turns), deps);
}

export type FoldOutcome = "done" | "busy" | "fenced" | "timeout" | "failed";

export interface FoldOptions {
  /** The bound (default FOLD_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The account-deletion fence (default lib/privacy/deletionFence.ts isAthleteDeleting; a failed check counts as fenced). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
  /**
   * Tests: the fold's work given the summarizing call (default mila/conversations.ts maybeSummarizeConversation: reads the
   * conversation, calls `summarize` once it has grown past the trigger, writes the summary).
   */
  work?: (athleteId: string, conversationId: string, summarize: (input: string) => Promise<string>) => Promise<void>;
}

/** The conversations folding in this process right now (athleteId:conversationId). */
const folding = new Set<string>();

/**
 * After a chat turn: fold the conversation when it has grown past the trigger. Never throws; settles within the bound;
 * one at a time per conversation; nothing after the deletion fence.
 */
export async function maybeFoldAgentConversation(athleteId: string, conversationId: string, deps: FoldDeps = {}, opts: FoldOptions = {}): Promise<FoldOutcome> {
  const key = `${athleteId}:${conversationId}`;
  if (folding.has(key)) return "busy";
  folding.add(key);
  const fenced = async () => (opts.isDeleting ?? isAthleteDeleting)(athleteId).catch(() => true);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<FoldOutcome>((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve("timeout"); }, opts.timeoutMs ?? FOLD_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    if (await fenced()) return "fenced";
    const work = opts.work ?? maybeSummarizeConversation;
    const run = work(athleteId, conversationId, async (input) => {
      const text = await summaryCall(athleteId, conversationId, input, deps, ac.signal);
      // An answer after the bound, or once deletion fenced them, is dropped: "" writes nothing.
      return ac.signal.aborted || (await fenced()) ? "" : text;
    }).then((): FoldOutcome => "done");
    run.catch(() => undefined);   // a late rejection after the bound is not unhandled
    const outcome = await Promise.race([run, bound]);
    if (outcome === "timeout") logger.warn({ athleteId, conversationId }, "agent conversation fold timed out (aborted)");
    return outcome;
  } catch (err: any) {
    logger.warn({ athleteId, error: err?.message }, "agent conversation fold failed (best-effort)");
    return "failed";
  } finally {
    clearTimeout(timer);
    folding.delete(key);
  }
}
