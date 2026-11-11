/**
 * agent/engine/mastra/turn.ts — one Mila turn on Mastra (the only engine). Built to the contract TrueForge's turn had
 * (tf/chat.ts runTfChatTurn, retired 9 Nov 2026): same arguments, same TurnResult (text, cards, cost, tools, evidence, approvalState), same
 * chat rows, SSE wire, cards and agent_runs record, the same account-deletion fence. So every caller (chat, proactive
 * with its SPEAK/SILENT/DEFER decision, waitlist, onboarding) and the app are unchanged. What differs is the turn:
 *
 *   session   the conversation's mila_tf_sessions row (found by athlete + conversation, or minted here) is the mapping;
 *             the Mastra thread id IS that row id (server-generated), resource = the athlete. A new row is written with
 *             tf_session_id "mastra:<row id>" (the column's name is TrueForge's, retired). A row TrueForge made before
 *             then keeps its old id (nothing reads it); Mastra opens a thread under the same row id. An isolated (proactive) turn gets a fresh row and thread of its own. The
 *             pass is issued on the row's id once the row exists (a lost first-insert race joins the winner's row).
 *   one turn  per row at a time, across instances (sessions.ts claimTurn): a new turn takes the row and the running one
 *             stops ("superseded", stopped/aborted, as TrueForge, retired, cancelled a running turn when another started
 *             in its session); the new one waits for it to end (at most TAKEOVER_WAIT_MS) before Mastra reads the thread.
 *   engine    last_engine on the row: a conversation TrueForge ran last (before its retirement) starts over on Mastra (its old Mastra thread,
 *             if any, is deleted), seeded with the recent chat rows (sessions.ts recentChatSeed) and the new-session
 *             preface.
 *   guards    guards.ts before Mastra sees anything: the thread is ours and the athlete's (and Mastra's copy names the
 *             same resource), the requestContext comes from the verified pass only, the input is text, the Mastra run
 *             id is our agent_runs id.
 *   gap      every turn on a thread that already exists reads the conversation's chat rows no Mastra turn wrote since
 *             the last one it was given (sessions.ts chatGapSeed: voice turns, messages the app posted), bounded, as
 *             app updates; what it covered is saved (tool_state.chatSeen: a mark past settled rows, ids after it) once Mastra takes the turn.
 *   input     the turn's input text (engine/context.ts turnInputText, first written for TrueForge): app updates, preface, CONTEXT, message;
 *             the CONTEXT is the extended one (Brief, coming up, preferences, what works, this conversation's rolling
 *             summary and the last two other conversations').
 *   summary   after the reply is saved, the rolling summary fold (chat/summary.ts maybeFoldAgentConversation, as the
 *             old harness) is started and never awaited; bounded there (one per conversation, a timeout, the deletion
 *             fence); an isolated turn starts none.
 *   attached  what she attached (chat: asset ids the route checked) is prepared here (attachments.ts: ownership
 *             re-checked now; the media library's existing analysis as text; photos resized with no metadata; a clip
 *             not yet read as a clip as its poster + frames; the per-turn limits; never throws) and goes to Mastra as a
 *             `context` message (guards.ts turnImageContext: server-made images only), which the model sees right
 *             before her message and Mastra never saves; one APP UPDATES line says what came and what could not be
 *             shown. Image tokens arrive in the model's input usage, so the cost and its caps count them.
 *   turn      agent.stream: memory {thread, resource}, the pass's visible tools only (tools.ts, in-process, the same
 *             per-call path every pass tool takes; the playbooks are Mastra agent skills, skills.ts, offered
 *             for the turn's surface and flags), abortSignal = our turn timeout / account deletion (polled every FENCE_POLL_MS) /
 *             a newer turn taking the conversation / an explicit Stop (stopMastraRun) / the run cost cap. The loop
 *             runs in this process, so aborting it is the cancel. The CLIENT LEAVING DOES NOT STOP IT (owner decision
 *             4, 31 Oct 2026, docs/design/mila-chat-v2.md): a phone that drops mid-reply finds the turn finished and
 *             saved when it reconnects (the conversation + GET /me/chat/v2/runs/:runId). Only writing to it stops.
 *   tap       chat v2 (routes/chatV2.ts) passes `tap`: the run id once the run row exists, every Mastra stream chunk
 *             except text, and the text exactly as the v1 wire gets it (openui blocks removed). A tap that throws never
 *             touches the turn.
 *   stream    fullStream → our SSE: text-delta → token (openui blocks removed; a new text part after earlier text is
 *             a new message, "\n\n" between); tool-call / tool-result / tool-error → the status lines
 *             (engine/toolStatus.ts, fed events in the shape TrueForge streamed: fixed labels only, never arguments or results);
 *             reasoning counted, never shown.
 *   cost      usage × our price table (agent/models.ts costOf, #1160) on agent_runs: totalUsage, or the sum of the
 *             step-finish usages when the turn was aborted or failed (totalUsage is then empty or rejects). After every
 *             step, from those sums: the run cap (runLimitsFor: AGENT_SKILL_CAPS / the skill's limits /
 *             AGENT_RUN_COST_CAP_USD; past it, cost_cap_run) and the day cap (their spend today, re-read at each poll,
 *             plus this run's so far; past AGENT_DAY_COST_CAP_USD, cost_cap_day). The day cap is also checked before
 *             the turn starts. A Langfuse trace with ids and numbers only (trace.ts).
 *   at once   at most MILA_MAX_CONCURRENT_TURNS Mastra turns per athlete across conversations and instances
 *             (admitRun: counted and claimed under a Postgres advisory transaction lock on the athlete; the claim is
 *             the run row itself). A newer turn in the same conversation replaces that conversation's turn, so it is
 *             not counted against it. Over the cap the turn never runs: a chat turn says TURN_CAP_MESSAGE; any other
 *             turn says nothing and returns `turnCap` (proactive defers it once).
 *   steps     MAX_STEPS model steps; a turn that ends there still calling tools stops with max_steps (its stop message
 *             is shown and kept when there is no text).
 *   search    the skill's web_search (chat: at most 2 a turn) as our own tool (webSearch.ts: one fast-tier OpenAI search
 *             per call through research/runSkill.ts, each its own agent_runs row in the day spend). Each call's cost
 *             joins the run total the run cap checks after every step; the turn's row counts the searches
 *             (web_search_calls) and records each call; their pages go on "How I got this".
 *   ZDR       every Mastra model call sends store:false (mastraProviderOptions): OpenAI keeps no copy of the response.
 *             The AI SDK's Responses default is to store, so this is never left to the default.
 */
import { db } from "../../../db";
import { agentRuns, chatMessages } from "../../../../shared/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentDoneFields, ChatCard, EvidenceRef, MemoryFact, RunApprovalState, RunCost, StopReason, ToolCallRecord, TraceStep,
} from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { notifyReplyReady, waitingCardPushed, type ReplyPushDeps } from "../replyPush";
import type { SSEStream } from "../../../lib/sse";
import { isAthleteDeleting } from "../../../lib/privacy/deletionFence";
import { getConversationContext, upsertConversationOnMessage } from "../../../mila/conversations";
import { maybeFoldAgentConversation } from "../../chat/summary";
import { settleRunApproval } from "../../approvals";
import { actionCard, howIGotThisCard, uniqueCards } from "../../cards";
import { dbChatSources } from "../../chat/sources";
import { AGENT, runLimitsFor } from "../../config";
import { STOP_MESSAGES } from "../stopMessages";
import { PLATFORM_CAP_MESSAGE, platformBudget } from "../../../lib/platformSpend";
import { factsByIds as dbFactsByIds } from "../../memory";
import { ZERO_COST, costOf } from "../../models";
import { dbTurnStore } from "../tools/dbTurnStore";
import { issueAthletePass } from "../tools/pass";
import { passRegistry, passSkill, visibleTools } from "../tools/registry";
import { checkCost } from "../../policy";
import { dbStore } from "../../research/dbStore";
import { loadJob } from "../../jobs";
import { spentTodayMicroUsd } from "../../trace";
import { CHAT_SCOPES, MILA_STARTED_SEED, WAITLIST_SKILL_ID, type TurnDeps, type TurnOptions, type TurnResult } from "../turnTypes";
import { buildTurnContext, openedFromOf, turnInputText } from "../context";
import { createOpenUiFilter } from "../openuiFilter";
import {
  advanceChatSeen, appendHerWords, chatGapSeed, claimTurn, clearEvents, earlierChatSeed, ENGINE_SWITCH_SEED, findSession, insertSession, lastEngineOf, markEngine, milaStartedSeed, pendingEvents,
  recentChatSeed, releaseTurn, runEnded, turnHolder, type AppEvent, type MilaSessionRow,
} from "../sessions";
import { createToolStatus } from "../toolStatus";
import { MASTRA, MASTRA_PROVIDER, MASTRA_SESSION_PREFIX, MILA_TURN } from "../config";
import { displayChunk } from "./display";
import { NO_ATTACHMENTS, prepareTurnAttachments, type AttachmentDeps, type PreparedAttachments, type TurnAttachmentRef } from "./attachments";
import { assertThreadOwned, contextFromPass, turnImageContext, turnInput, type GuardDeps } from "./guards";
import { SKILLS_CONTEXT_KEY, turnSurface, type MilaSkillScope } from "./skills";
import { mastraRuntime, type MastraRuntime } from "./runtime";
import { mastraTools, takeCallCards } from "./tools";
import { allowedTools, capabilityOverview } from "../../welcome/toolGate";
import { traceMastraTurn } from "./trace";
import { WEB_SEARCH_TOOL, WebSearchLedger, webSearchCap, webSearchTool, type WebSearchCall } from "./webSearch";
import { conversationLanguageOf, readMilaVoiceSettings } from "../../../services/milaVoice/settings";

const logger = createLogger("agent/engine/mastra");

/**
 * The OpenAI options on every Mastra model call: the reasoning effort, and store:false (zero data retention: OpenAI keeps
 * no copy of the response; the AI SDK's own default for the Responses API is store:true). With store:false the AI SDK
 * also asks for the reasoning items encrypted (include reasoning.encrypted_content), so a multi-step turn keeps them.
 */
export function mastraProviderOptions(effort: string) {
  return { openai: { reasoningEffort: effort, store: false } } as const;
}

/** How often an in-flight turn checks the account-deletion fence (phase 1 cannot reach into this process). */
export const FENCE_POLL_MS = 5_000;
/** Model steps (tool rounds) per turn. */
export const MAX_STEPS = 16;
/** How long a new turn on a conversation waits for the turn it took the row from to stop (then it runs anyway). */
export const TAKEOVER_WAIT_MS = 15_000;

/** The Mastra turns running in THIS process, by session row: a new turn here stops the old one at once. */
type RunningHere = Map<string, { runId: string; abort: AbortController }>;
const runningHere: RunningHere = new Map();

type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const hasUsage = (u: any): boolean => !!u && typeof u.inputTokens === "number";

export type MastraStreamChunk = { type: string; payload?: any; metadata?: any };
export interface MastraStreamOut { fullStream: AsyncIterable<MastraStreamChunk>; totalUsage: Promise<any> }

export interface MastraTurnDeps extends TurnDeps {
  /** Tests: a runtime with a mock model and an in-memory store (never a provider). */
  runtime?: () => Promise<Pick<MastraRuntime, "agent" | "memory">>;
  guards?: GuardDeps;
  /** Tests: the tools' fence check (default: deletionFence). */
  toolsDeleting?: (athleteId: string) => Promise<boolean>;
  fencePollMs?: number;
  /** Tests: the reply-ready push's send and fence check (replyPush.ts; never Expo). */
  replyPush?: ReplyPushDeps;
  /** Tests: how long a new turn waits for the one it took over (default TAKEOVER_WAIT_MS). */
  takeoverWaitMs?: number;
  /** Tests: the in-process registry (a separate Map acts as another instance; default this process's). */
  runningHere?: RunningHere;
  /** Tests: this conversation's rolling summary (default: conversations.summary, mila/conversations.ts). */
  conversationSummary?: (athleteId: string, conversationId: string) => Promise<string | null>;
  /**
   * After the turn, the rolling summary fold (chat/summary.ts maybeFoldAgentConversation): started, never awaited,
   * never throws. false: no fold (tests).
   */
  fold?: false | ((athleteId: string, conversationId: string) => Promise<void>);
  /** Tests: the attachment step's reads (attachments.ts; never GCS). */
  attachments?: AttachmentDeps;
  /** Tests: the web search call (webSearch.ts; default one OpenAI search through callStructured). */
  webSearch?: WebSearchCall;
}

const summaryOf = async (athleteId: string, conversationId: string) => (await getConversationContext(athleteId, conversationId)).summary;

/** Chat v2's view of a turn (chatV2Stream.ts): what it turns into the AI SDK stream. */
export interface MastraTurnTap {
  run(runId: string): void;
  /** Every fullStream chunk but text-start / text-delta / text-end (text comes through `text`). */
  chunk(c: MastraStreamChunk): void;
  /** Answer text exactly as the v1 wire streams it and the chat row keeps it (openui blocks removed, a blank line
   * between text parts, a stop message), so what streamed is what is saved. */
  text(s: string): void;
}

/** Why an aborted turn stopped, as the abort reason says it. */
const STOPPED_BY_ATHLETE = "stopped";
/** agent_runs.error while a running turn's Stop is pending (the turn overwrites it when it ends). */
const STOP_ASKED = "stop asked";
/** agent_runs.error when the turn ran but its reply row could not be written. */
const REPLY_NOT_SAVED = "reply not saved";
/** agent_runs.error (stop_reason "policy") of a turn refused by the per-athlete turn cap. */
export const TURN_CAP = "turn cap";
/** The abort reason when the day cap is passed mid-turn. */
const DAY_CAP = "day cost cap";
/**
 * What a chat turn refused by the turn cap says (and keeps as its reply). Prompt Register: athlete-facing, fixed text.
 * Never names the number (MILA_MAX_CONCURRENT_TURNS is a tuning value).
 */
export const TURN_CAP_MESSAGE = "One sec. I'm finishing a couple of other replies first. Send this again in a moment.";

type RunValues = typeof agentRuns.$inferInsert;

/**
 * Insert the turn's run row, admitted only while the athlete has fewer than `cap` Mastra turns running.
 *
 * Counted: their agent_runs with provider mastra, status running, started within `staleMs` (the conversation lock's
 * staleness rule, sessions.ts claimTurn: an older one is an instance that died mid-turn), except the turns this one
 * replaces in the conversation it is for (`conversationId`, null for an isolated turn: then every turn counts). Left
 * out there: a chat turn (the only kind that is never isolated before it claims the conversation's row) and any turn
 * holding that conversation's row now. Still counted there: an isolated (proactive) turn, recorded against the
 * conversation but holding a row of its own and never superseded, at every moment of its life (before it claims its
 * row, while it holds it, after it gave it back); and a non-chat turn that has not claimed the conversation's row yet
 * (milliseconds; fails closed).
 * Atomic across instances: the count and the insert run in one transaction holding pg_advisory_xact_lock on the
 * athlete, so two turns starting together can never both see room for one. The insert IS the claim; the turn's end
 * (ended_at) releases it. A refused turn's row is written already stopped (status stopped, stop_reason policy, error
 * "turn cap"), so it never counts. Any database error throws: the turn never runs (fails closed).
 */
export async function admitRun(p: { values: RunValues; athleteId: string; conversationId: string | null; cap: number; staleMs: number }): Promise<{ id: string; admitted: boolean; running: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mila_mastra_turns:${p.athleteId}`}, 0))`);
    const sameConversation = p.conversationId
      // (IS DISTINCT FROM, not <>: a run with no conversation must count, never fall out as NULL.)
      ? sql`AND (r.conversation_id IS DISTINCT FROM ${p.conversationId}::uuid
          OR EXISTS (SELECT 1 FROM mila_tf_sessions s WHERE s.athlete_id = r.athlete_id AND s.running_run_id = r.id AND s.conversation_id IS NULL)
          OR (r.trigger IS DISTINCT FROM 'chat' AND NOT EXISTS (
            SELECT 1 FROM mila_tf_sessions s WHERE s.athlete_id = r.athlete_id AND s.running_run_id = r.id AND s.conversation_id = ${p.conversationId}::uuid)))`
      : sql``;
    const res = await tx.execute(sql`
      SELECT count(*)::int AS n FROM agent_runs r
      WHERE r.athlete_id = ${p.athleteId}::uuid AND r.provider = ${MASTRA_PROVIDER} AND r.status = 'running' AND r.ended_at IS NULL
        AND r.started_at > now() - make_interval(secs => ${Math.max(0, p.staleMs) / 1000})
        ${sameConversation}`);
    const rows = ((res as { rows?: unknown[] })?.rows ?? res) as Array<{ n: number }>;
    const running = Number((Array.isArray(rows) ? rows[0]?.n : 0) ?? 0);
    const admitted = running < p.cap;
    const [row] = await tx.insert(agentRuns).values(admitted ? p.values : {
      ...p.values, status: "stopped", stop_reason: "policy", error: TURN_CAP, ended_at: new Date(),
    }).returning({ id: agentRuns.id });
    return { id: row.id, admitted, running };
  });
}

/**
 * Stop a running Mastra turn of this athlete (chat v2's Stop, POST /me/chat/v2/runs/:runId/stop; v1's Stop through
 * stopMastraConversation). It marks the run (agent_runs.error "stop asked"): the turn reads that at its next poll (any
 * instance) and, if it has not claimed its conversation yet, right before and after the claim; on this instance it
 * stops at once. The conversation's row is NOT given back here: the stopping turn keeps it until it has ended, so a
 * new message right after a Stop waits for it (as for a superseded turn) and the two never write the thread at once.
 * "not_found": not this athlete's Mastra run. "ended": it already finished.
 */
export async function stopMastraRun(athleteId: string, runId: string, local: RunningHere = runningHere): Promise<"stopping" | "ended" | "not_found"> {
  const [run] = await db.select({ provider: agentRuns.provider, ended: agentRuns.ended_at }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
  if (!run || run.provider !== MASTRA_PROVIDER) return "not_found";
  if (run.ended) return "ended";
  await db.update(agentRuns).set({ error: STOP_ASKED })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId), isNull(agentRuns.ended_at)));
  for (const r of local.values()) if (r.runId === runId && !r.abort.signal.aborted) r.abort.abort(new Error(STOPPED_BY_ATHLETE));
  logger.info({ athleteId, runId }, "mastra turn: stop asked");
  return "stopping";
}

/**
 * v1's Stop (POST /api/v1/me/chat/stop): the v1 wire carries the run id only on `done`, so the app names the
 * conversation. Stops every Mastra chat turn of this athlete still running in it (started within the turn timeout, so
 * an orphaned row is never touched). Returns how many were asked to stop.
 */
export async function stopMastraConversation(athleteId: string, conversationId: string, local: RunningHere = runningHere): Promise<number> {
  const since = new Date(Date.now() - MILA_TURN.timeoutMs - 60_000);
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(
    eq(agentRuns.athlete_id, athleteId), eq(agentRuns.conversation_id, conversationId), eq(agentRuns.provider, MASTRA_PROVIDER),
    eq(agentRuns.trigger, "chat"), isNull(agentRuns.ended_at), gt(agentRuns.started_at, since),
  ));
  let n = 0;
  for (const r of runs) if (await stopMastraRun(athleteId, r.id, local) === "stopping") n++;
  return n;
}

async function stopAsked(athleteId: string, runId: string): Promise<boolean> {
  const [r] = await db.select({ error: agentRuns.error }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
  return r?.error === STOP_ASKED;
}

export async function runMastraTurn(
  p: { athleteId: string; message: string | null; conversationId?: string; sse: SSEStream; context?: unknown; tap?: MastraTurnTap; attachments?: TurnAttachmentRef[] },
  deps: MastraTurnDeps = {},
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const turns = deps.turns ?? dbTurnStore;
  const store = deps.store ?? dbStore;
  const sources = deps.sources ?? dbChatSources;
  const now = deps.now ?? (() => new Date());
  const conversationId = p.conversationId ?? null;
  const skill = loadJob(opts.skillId ?? AGENT.CHAT_SKILL);
  const scopes = opts.scopes ?? CHAT_SCOPES;
  const herWords = p.message != null ? [p.message] : [];
  const t0 = Date.now();
  const fenced = deps.isDeleting ?? isAthleteDeleting;

  // Account deletion fenced them (lib/privacy/deletionFence.ts): no turn starts, nothing is written.
  if (await fenced(p.athleteId).catch(() => false)) {
    if (!p.sse.closed) p.sse.done({} as Record<string, unknown>);
    return { runId: null, text: "", status: "stopped", stopReason: "aborted", cards: [], cost: { ...ZERO_COST } };
  }

  let herRowId: string | null = null;
  if (p.message != null && !opts.isolated) {
    const [row] = await db.insert(chatMessages).values({ athlete_id: p.athleteId, role: "user", content: p.message, conversation_id: conversationId }).returning({ id: chatMessages.id });
    herRowId = row?.id ?? null;
    if (conversationId) await upsertConversationOnMessage(p.athleteId, conversationId, p.message);
  }

  const effort = MASTRA.effort;
  // One of at most MILA_MAX_CONCURRENT_TURNS turns of theirs running at once (admitRun); the run row is the claim.
  const admission = await admitRun({
    athleteId: p.athleteId, conversationId: opts.isolated ? null : conversationId, cap: MASTRA.maxConcurrentTurns, staleMs: MILA_TURN.timeoutMs,
    values: {
      athlete_id: p.athleteId, skill_id: skill.id, skill_version: `mastra:${MASTRA.model}`, trigger: opts.trigger ?? "chat",
      provider: MASTRA_PROVIDER, model: MASTRA.priceModel, effort, conversation_id: conversationId,
      ...(opts.parentRef ? { parent_ref: opts.parentRef } : {}),
    },
  });
  const runId = admission.id;
  // Someone is waiting on this reply (they wrote, in a conversation they see): a refused turn tells them so.
  const interactive = (opts.trigger ?? "chat") === "chat" && !opts.isolated;
  const tap = (f: (t: MastraTurnTap) => void) => {
    if (!p.tap) return;
    try { f(p.tap); } catch (err: any) { logger.warn({ runId, err: err?.message }, "mastra turn: tap failed (turn unaffected)"); }
  };
  tap((t) => t.run(runId));
  const steps: TraceStep[] = [];
  const step = (s: Record<string, unknown>) => steps.push({ ...s, seq: steps.length + 1, at: new Date().toISOString() } as TraceStep);
  step({ type: "skill", skillId: skill.id, version: `mastra:${MASTRA.model}` });

  let text = "";
  let status: TurnResult["status"] = "completed";
  let stopReason: StopReason | null = null;
  let error: string | null = null;
  let cost: RunCost = { ...ZERO_COST };
  const emit = (s: string) => { if (!s) return; text += s; p.sse.token(s); tap((t) => t.text(s)); };

  const spentToday = deps.spentToday ?? spentTodayMicroUsd;
  const dayCap = AGENT.DAY_COST_CAP_MICRO_USD;
  let spent = admission.admitted ? await spentToday(p.athleteId).catch(() => 0) : 0;
  const capped = checkCost({ runMicroUsd: 0, dayMicroUsd: spent, runCap: Number.MAX_SAFE_INTEGER, dayCap });
  // The platform-wide day ceiling (lib/platformSpend.ts): once reached, no turn starts for anyone.
  const platform = admission.admitted && capped.decision === "allow" ? await (deps.platformBudget ?? platformBudget)().catch(() => null) : null;
  let platformCapped = false;

  let session: MilaSessionRow | null = null;
  /** This turn's web searches (webSearch.ts): their count, cost, records and pages. Empty until the turn runs. */
  let searches = new WebSearchLedger(0);
  /** What the attachment step did (counts only; the trace and the log carry these, never content). */
  let attachmentCounts: PreparedAttachments["counts"] | null = null;
  const turnCap = !admission.admitted;
  if (turnCap) {
    step({ type: "policy", rule: "cost_cap", decision: "deny", reason: `turn cap: ${admission.running} of their Mila turns already running` });
    status = "stopped"; stopReason = "policy"; error = TURN_CAP;
    logger.info({ athleteId: p.athleteId, runId, running: admission.running, cap: MASTRA.maxConcurrentTurns, interactive }, "mastra turn: refused (turn cap)");
  } else if (capped.decision !== "allow") {
    step({ type: "policy", rule: "cost_cap", decision: "deny", reason: capped.reason });
    status = "stopped"; stopReason = capped.stop ?? "cost_cap_day";
  } else if (platform?.over) {
    step({ type: "policy", rule: "cost_cap", decision: "deny", reason: "the platform's day spend cap is reached (PLATFORM_DAY_COST_CAP_USD)" });
    status = "stopped"; stopReason = "cost_cap_day"; platformCapped = true;
  } else {
    const turnAbort = new AbortController();
    const abort = (why: string) => { if (!turnAbort.signal.aborted) turnAbort.abort(new Error(why)); };
    const timer = setTimeout(() => abort("turn timeout"), MILA_TURN.timeoutMs);
    // The client leaving (p.sse.signal) is NOT a reason to stop (decision 4): the turn finishes and is saved.
    const local = deps.runningHere ?? runningHere;
    let held: MilaSessionRow | null = null;
    // Account deletion phase 1 cannot cancel a loop running in this process: the turn watches the fence itself, and
    // (another instance) whether a newer turn took its conversation's row.
    const fencePoll = setInterval(() => {
      void fenced(p.athleteId).then((yes) => { if (yes) abort("account deletion"); }, () => undefined);
      if (held) void turnHolder(held).then((h) => { if (h !== runId) abort("superseded"); }, () => undefined);
      // A Stop asked on any instance (stopMastraRun marks the run).
      void stopAsked(p.athleteId, runId).then((yes) => { if (yes) abort(STOPPED_BY_ATHLETE); }, () => undefined);
      // Their spend today, for the day cap after each step (other turns that ended meanwhile; a failed read keeps the last).
      void spentToday(p.athleteId).then((v) => { if (Number.isFinite(v)) spent = v; }, () => undefined);
    }, deps.fencePollMs ?? FENCE_POLL_MS);
    const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const limits = runLimitsFor(skill);
    const runCap = limits.costCapMicroUsd;
    // The model's own tokens at its price; the web searches are priced by their own call (webSearch.ts) and added.
    const costFrom = (u: Usage) => costOf(MASTRA.priceModel, { ...u, webSearchCalls: 0 });
    // web_search on this turn: the skill's per-turn count (0 ⇒ not offered); a read tool, so only with read in scope.
    searches = new WebSearchLedger(scopes.includes("read") ? webSearchCap(skill, limits.maxWebSearches) : 0);
    let total: any = null;
    let tModel: number | null = null;
    let stepsDone = 0;
    let finishReason: string | null = null;
    try {
      // The thread: our session row (server-generated id). An isolated turn never joins the conversation's row.
      const existing = conversationId && !opts.isolated ? await findSession(p.athleteId, conversationId) : null;
      const sid = existing?.id ?? randomUUID();
      session = existing ?? await insertSession({ id: sid, athleteId: p.athleteId, conversationId: opts.isolated ? null : conversationId, tfSessionId: `${MASTRA_SESSION_PREFIX}${sid}`, herWords, engine: "mastra" });
      // Lost the first-insert race of a new conversation: the winner's row is the conversation's, and this turn joins it.
      const joined = !existing && session.id !== sid;
      if ((existing || joined) && p.message != null) await appendHerWords(session, p.message);
      // The pass names the row that exists (never a candidate id that lost the race).
      const pass = issueAthletePass({ athleteId: p.athleteId, sessionId: session.id, runId, skillId: skill.id, scopes }, deps.passKey === undefined ? undefined : deps.passKey);

      // One turn at a time on the row: take it; the turn running on it stops; wait for it to end before Mastra reads
      // the thread (so the two never write it at once).
      // A Stop that came before the claim: stop here, so this turn never takes the conversation from the one running.
      if (await stopAsked(p.athleteId, runId)) abort(STOPPED_BY_ATHLETE);
      if (turnAbort.signal.aborted) throw turnAbort.signal.reason;
      const claimed = await claimTurn(session, runId, MILA_TURN.timeoutMs);
      held = session;
      const here = local.get(session.id);
      if (here && here.runId !== runId) here.abort.abort(new Error("superseded"));
      local.set(session.id, { runId, abort: turnAbort });
      if (claimed.previous && !claimed.stale) {
        const until = Date.now() + (deps.takeoverWaitMs ?? TAKEOVER_WAIT_MS);
        while (!turnAbort.signal.aborted && Date.now() < until && !(await runEnded(p.athleteId, claimed.previous))) await new Promise((r) => setTimeout(r, 50));
        logger.info({ athleteId: p.athleteId, runId, previous: claimed.previous }, "mastra turn: took the conversation from a running turn");
      }
      if (!turnAbort.signal.aborted && await stopAsked(p.athleteId, runId)) abort(STOPPED_BY_ATHLETE);
      if (turnAbort.signal.aborted) throw turnAbort.signal.reason;

      const rt = await (deps.runtime ?? mastraRuntime)();
      // Tenant guards: the thread is ours and theirs before Mastra memory sees it; the context comes from the pass only.
      let { exists } = await assertThreadOwned(rt.memory as never, p.athleteId, session.id, deps.guards);
      const { requestContext } = await contextFromPass(pass, { athleteId: p.athleteId, threadId: session.id }, deps.passKey);
      // TrueForge ran this conversation last: its Mastra thread (if any) misses those turns, so Mastra starts it over.
      const switched = (!!existing || joined) && lastEngineOf(session) !== "mastra";
      if (switched && exists) { await rt.memory.deleteThread(session.id); exists = false; }
      if (switched) logger.info({ athleteId: p.athleteId, runId, from: lastEngineOf(session) }, "mastra turn: engine changed, conversation starts over on Mastra");
      await markEngine(session, "mastra");

      // A new thread on a conversation that already has turns reads the recent chat back; a conversation's first
      // Mastra turn reads what Mila started in it (agent/proactive), and, when the conversation already
      // has chat but no session row (the retired harness ran it and kept none), its rows after the rolling summary's
      // watermark (sessions.ts earlierChatSeed), so Mila does not forget them. Merged below with the voice rows, in time order.
      const firstTurn = !(opts.isolated || !conversationId || exists || existing || joined);
      const seeded = opts.isolated || !conversationId || exists ? []
        : existing || joined ? await recentChatSeed(p.athleteId, conversationId, ENGINE_SWITCH_SEED, herRowId).catch(() => [] as AppEvent[])
        : [
          ...await milaStartedSeed(p.athleteId, conversationId, MILA_STARTED_SEED).catch(() => [] as AppEvent[]),
          ...await earlierChatSeed(p.athleteId, conversationId, ENGINE_SWITCH_SEED, { excludeId: herRowId }).catch(() => [] as AppEvent[]),
        ];
      // The chat rows the thread never saw (voice turns, messages the app posted, a message no turn answered), read on
      // every turn of a conversation's thread that already exists; a new conversation's first turn reads its voice turns
      // only (a call can open a chat); a thread that starts over (engine change, lost) is covered by recentChatSeed.
      // `gap.cursor` is what this turn covers (sessions.ts ChatSeen), saved once Mastra takes the turn (as the events are cleared).
      const gap = opts.isolated || !conversationId ? null
        : await chatGapSeed(session, { read: exists ? "gap" : existing || joined ? "none" : "voice", excludeId: herRowId }).catch((err) => {
          logger.warn({ athleteId: p.athleteId, runId, err: err?.message }, "mastra turn: chat gap not read");
          return null;
        });
      // A conversation's first turn: what Mila started, the earlier chat and the voice turns, one timeline (a stable sort:
      // the "earlier lines omitted" marker keeps its place before its first row). Otherwise the order is as built.
      const timeline = firstTurn ? [...seeded, ...(gap?.events ?? [])].sort((a, b) => a.at.localeCompare(b.at)) : [...seeded, ...(gap?.events ?? [])];
      const events = [...timeline, ...await pendingEvents(session)];
      const registry = passRegistry();
      // The playbooks are Mastra's own agent skills (skills.ts), scoped to this turn's surface and visible tools through
      // the requestContext (server-side values only).
      // Per-athlete enablement (agent/welcome/toolGate.ts; MILA_WELCOME): a tool whose optional capability is not turned
      // on for this athlete is not assembled at all; callPassTool refuses it again per call.
      const visible = await allowedTools(p.athleteId, visibleTools(passSkill(skill, registry), registry, { scopes: [...scopes] }));
      const skillScope: MilaSkillScope = { surface: turnSurface({ skillId: skill.id, isolated: opts.isolated, waitlistSkillId: WAITLIST_SKILL_ID }), tools: visible.map((t) => t.name) };
      requestContext.set(SKILLS_CONTEXT_KEY, skillScope);
      const { turn: toolState } = await turns.loadState({ athleteId: p.athleteId, sessionId: session.id, runId });
      // The old harness block's sections too (parity, 3 Nov 2026): Brief, coming up, preferences, the what-works
      // headline, this conversation's rolling summary and the last two other conversations' (engine/context.ts extended).
      const conversationSummary = conversationId && !opts.isolated
        ? (await (deps.conversationSummary ?? summaryOf)(p.athleteId, conversationId).catch(() => null)) : null;
      const context = opts.context ? await opts.context() : await (async () => {
        // Read side by side; each is fail-open on its own.
        const [capabilities, voiceSettings] = await Promise.all([
          // What each optional capability's state is for them, by the same check that dropped the refused tools above.
          capabilityOverview(p.athleteId).catch((err) => {
            logger.warn({ athleteId: p.athleteId, runId, err: err?.message }, "mastra turn: capability states not read");
            return null;
          }),
          // The language they fixed for talking with Mila; a failed read is "auto" (no line), never a lost turn.
          readMilaVoiceSettings(p.athleteId).catch(() => null),
        ]);
        return buildTurnContext(store, sources, {
          athleteId: p.athleteId, openedFrom: openedFromOf(p.context), now: now(), visibleTools: visible, offeredConnectors: toolState.offeredConnectors,
          capabilities,
          extended: { conversationId: opts.isolated ? null : conversationId, conversationSummary },
          conversationLanguage: conversationLanguageOf(voiceSettings),
        });
      })();
      // Her attachments (chat only): server-made images of her own media, and the line saying what came.
      const attached = p.attachments?.length && !opts.isolated ? await prepareTurnAttachments(p.athleteId, p.attachments, deps.attachments) : NO_ATTACHMENTS;
      if (attached.counts.attached) {
        attachmentCounts = attached.counts;
        // Account deletion while they were read: no model call.
        if (await fenced(p.athleteId).catch(() => false)) abort("account deletion");
        if (turnAbort.signal.aborted) throw turnAbort.signal.reason;
      }
      const imageContext = turnImageContext(attached.images, attached.block);
      const updates = attached.note ? [...(opts.updates ?? []), attached.note] : opts.updates;
      const input = turnInput(turnInputText({ events, updates, preface: opts.preface?.({ isNew: !exists, engine: "mastra" }), context, message: p.message }));
      // The cards each tool call made, by call id: chat v2's copy of that call's result chunk carries them
      // (display.ts displayChunk), never Mastra's thread.
      const callCards = new Map<string, ChatCard[]>();
      const tools = await mastraTools(visible, registry, { turns, passKey: deps.passKey, isDeleting: deps.toolsDeleting, callCards });
      if (searches.cap > 0) tools[WEB_SEARCH_TOOL] = await webSearchTool(searches, { passKey: deps.passKey, isDeleting: deps.toolsDeleting, search: deps.webSearch, signal: turnAbort.signal });

      const filter = createOpenUiFilter();
      const toolStatus = createToolStatus((m, phase) => p.sse.status(m, phase));
      let separate = false;
      const show = (chunk: string) => {
        const out = filter.push(chunk);
        if (!out) return;
        if (separate && text.trim()) emit("\n\n");
        separate = false;
        emit(out);
      };
      tModel = Date.now();
      const out = await rt.agent.stream(input, {
        memory: { thread: session.id, resource: p.athleteId },
        runId,
        requestContext,
        toolsets: { nomila: tools },
        abortSignal: turnAbort.signal,
        maxSteps: MAX_STEPS,
        providerOptions: mastraProviderOptions(effort),
        ...(imageContext.length ? { context: imageContext } : {}),
      }) as unknown as MastraStreamOut;
      let started = false;
      let streamError: string | null = null;
      for await (const c of out.fullStream) {
        if (!started) {
          started = true;
          if (events.length) await clearEvents(session, events.map((e) => e.id)).catch((err) => logger.warn({ err: err?.message }, "mastra turn: events not cleared"));
          if (gap?.cursor) await advanceChatSeen(session, gap.cursor).catch((err) => logger.warn({ err: err?.message }, "mastra turn: chat gap cursor not saved"));
        }
        const pl = c.payload ?? {};
        if (c.type !== "text-start" && c.type !== "text-delta" && c.type !== "text-end") tap((t) => t.chunk(displayChunk(c, (id) => takeCallCards(callCards, id))));
        switch (c.type) {
          case "text-start":
            if (text.trim()) { emit(filter.flush()); separate = true; }
            break;
          case "text-delta":
            toolStatus.see({ type: "model.message.delta", thread_id: "main", content: pl.text ?? "" });
            show(pl.text ?? "");
            break;
          case "reasoning-delta":
            toolStatus.see({ type: "model.message.delta", thread_id: "main", reasoning_content: pl.text ?? "" });
            break;
          case "tool-call":
            toolStatus.see({ type: "model.message", thread_id: "main", tool_calls: [{ id: pl.toolCallId, function: { name: pl.toolName } }] });
            break;
          case "tool-result":
          case "tool-error":
            toolStatus.see({ type: "tool.response", thread_id: "main", tool_call_id: pl.toolCallId });
            break;
          case "step-finish": {
            // Each step's own usage, summed as it arrives: the cost of an aborted or failed turn, the run cap and the
            // day cap (their spend today + this run so far; checkCost checks the day first).
            stepsDone++;
            const u = pl.output?.usage ?? {};
            usage.inputTokens += num(u.inputTokens); usage.cachedInputTokens += num(u.cachedInputTokens);
            usage.outputTokens += num(u.outputTokens); usage.reasoningTokens += num(u.reasoningTokens);
            // The run cap counts this turn's searches too; the day cap reads them from their own rows (spent, re-read at
            // each poll), so a search is never counted twice.
            const modelMicroUsd = costFrom(usage).microUsd;
            const runMicroUsd = modelMicroUsd + searches.cost.microUsd;
            const over = checkCost({ runMicroUsd, dayMicroUsd: spent + modelMicroUsd, runCap, dayCap });
            if (over.decision !== "allow" && !turnAbort.signal.aborted) {
              step({ type: "policy", rule: "cost_cap", decision: "deny", reason: over.reason });
              abort(over.stop === "cost_cap_day" ? DAY_CAP : "cost cap");
            }
            break;
          }
          case "finish":
            finishReason = typeof pl.stepResult?.reason === "string" ? pl.stepResult.reason : null;
            break;
          case "error":
            streamError = String(pl.error?.message ?? pl.error ?? "stream error").slice(0, 500);
            break;
        }
      }
      emit(filter.flush());
      if (toolStatus.reasoningChars) logger.info({ athleteId: p.athleteId, runId, reasoningChars: toolStatus.reasoningChars }, "mastra turn: reasoning streamed (not shown)");
      if (filter.removed) logger.info({ athleteId: p.athleteId, runId, removed: filter.removed }, "mastra turn: openui blocks removed");
      total = await out.totalUsage.catch(() => null);
      if (turnAbort.signal.aborted) throw turnAbort.signal.reason ?? new Error("aborted");
      if (streamError) { status = "failed"; stopReason = "error"; error = streamError; }
      // Mastra ends at maxSteps with the model still calling tools: the step limit, not an answer.
      else if (finishReason === "tool-calls") {
        status = "stopped"; stopReason = "max_steps";
        logger.info({ athleteId: p.athleteId, runId, steps: stepsDone }, "mastra turn: step limit reached");
      }
    } catch (err: any) {
      const reason = turnAbort.signal.aborted ? String((turnAbort.signal.reason as Error)?.message ?? "aborted") : null;
      if (reason === STOPPED_BY_ATHLETE || reason === "account deletion" || reason === "superseded") {
        status = "stopped"; stopReason = "aborted"; error = reason;
      } else if (reason === "cost cap") { status = "stopped"; stopReason = "cost_cap_run"; }
      else if (reason === DAY_CAP) { status = "stopped"; stopReason = "cost_cap_day"; }
      else { status = "failed"; stopReason = "error"; error = reason ?? String(err?.message ?? err).slice(0, 500); }
      step({ type: "error", message: (error ?? reason ?? "aborted").slice(0, 500) });
      if (status === "failed") logger.error({ athleteId: p.athleteId, runId, error, code: err?.code }, "mastra turn failed");
    } finally {
      clearTimeout(timer);
      clearInterval(fencePoll);
      if (held) {
        if (local.get(held.id)?.runId === runId) local.delete(held.id);
        await releaseTurn(held, runId).catch((err) => logger.warn({ err: err?.message, runId }, "mastra turn: row not released"));
      }
    }
    // Cost: Mastra's total when it has one; else (aborted, failed) the steps' own usage summed as they arrived.
    if (tModel != null) {
      const modelCost = costFrom(hasUsage(total) ? {
        inputTokens: num(total.inputTokens), cachedInputTokens: num(total.cachedInputTokens), outputTokens: num(total.outputTokens), reasoningTokens: num(total.reasoningTokens),
      } : usage);
      step({ type: "model", model: { provider: MASTRA_PROVIDER, model: MASTRA.priceModel, effort }, cost: modelCost, durationMs: Date.now() - tModel });
      // The row's cost is the model's own; each search's cost (and its trace) is on its own row (webSearch.ts). The row
      // counts the turn's searches.
      cost = { ...modelCost, webSearchCalls: searches.cost.webSearchCalls };
    }
  }

  // Account deletion fenced them while this turn ran: write nothing more but this run's own end state.
  if (await fenced(p.athleteId).catch(() => false)) {
    await db.update(agentRuns).set({ status: "stopped", stop_reason: "aborted", error: "account deletion", ended_at: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, p.athleteId))).catch(() => undefined);
    if (!p.sse.closed) p.sse.done({ runId } as Record<string, unknown>);
    logger.info({ athleteId: p.athleteId, runId }, "mastra turn fenced by account deletion: nothing written");
    return { runId, text, status: "stopped", stopReason: "aborted", cards: [], cost };
  }

  if (turnCap) { if (interactive) emit(TURN_CAP_MESSAGE); }
  else if (platformCapped && !text.trim()) emit(PLATFORM_CAP_MESSAGE);
  else if (stopReason && stopReason !== "aborted" && !text.trim()) emit(STOP_MESSAGES[stopReason]);

  const taken = await turns.take({ athleteId: p.athleteId, sessionId: session?.id ?? "", runId }).catch((err) => {
    logger.warn({ err: err?.message, runId }, "mastra turn: turn items not read");
    return null;
  });
  // What the tools read, plus the pages the web searches used (as the retired harness put them on "How I got this"). The pages
  // go first: the card keeps 20 rows, and a web search's sources must stay visible and clickable (OpenAI's terms).
  const evidence: EvidenceRef[] = [...searches.evidence(), ...(taken?.evidence ?? [])];
  // One card per id: a tool called twice for one subject (bookings_get on the same booking) leaves the same card twice.
  const cards: ChatCard[] = uniqueCards([...(taken?.approvals ?? []).map(actionCard), ...(taken?.cards ?? [])]);
  const factIds = [...new Set(evidence.flatMap((e) => (e.kind === "fact" ? [e.factId] : [])))];
  const how = howIGotThisCard({
    runId, skillId: skill.id, why: skill.description, evidence,
    facts: factIds.length ? await (deps.factsByIds ?? dbFactsByIds)(p.athleteId, factIds).catch(() => [] as MemoryFact[]) : [],
  });
  if (how) cards.push(how);
  const tools: ToolCallRecord[] = [...(taken?.tools ?? []), ...searches.records];
  for (const call of tools) step({ type: "tool", call });

  // The reply is saved BEFORE the run is marked ended, so a phone that reconnects and sees the run ended (GET
  // /me/chat/v2/runs/:runId) always finds the reply in the conversation.
  // A failed save still ends the run (failed, "reply not saved"): a run left "running" would keep a reconnecting phone
  // waiting for a reply that never comes.
  const kept = opts.keepInHistory ? cards.filter(opts.keepInHistory) : cards;
  let replyRowId: string | null = null;
  if ((text.trim() || kept.length) && !opts.isolated) {
    try {
      const [saved] = await db.insert(chatMessages).values({
        athlete_id: p.athleteId, role: "assistant", content: text, conversation_id: conversationId,
        agent_cards: kept.length ? kept : null, agent_run_id: runId,
      }).returning({ id: chatMessages.id });
      replyRowId = saved?.id ?? null;
    } catch (err: any) {
      logger.error({ athleteId: p.athleteId, runId, err: err?.message }, "mastra turn: reply not saved");
      status = "failed"; stopReason = "error"; error = REPLY_NOT_SAVED;
      step({ type: "error", message: REPLY_NOT_SAVED });
    }
  }

  // A card waiting on their tap is recorded as such (approval_state, #1162); `status` stays how the model turn ended.
  let approvalState: RunApprovalState | null = taken?.approvals?.length ? "awaiting_approval" : null;
  await db.update(agentRuns).set({
    status, stop_reason: stopReason, error, ended_at: new Date(), approval_state: approvalState,
    input_tokens: cost.inputTokens, cached_input_tokens: cost.cachedInputTokens, output_tokens: cost.outputTokens,
    reasoning_tokens: cost.reasoningTokens, web_search_calls: cost.webSearchCalls, cost_micro_usd: cost.microUsd,
    steps, tools_called: tools, evidence_read: evidence,
  }).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, p.athleteId)));
  if (approvalState) approvalState = (await settleRunApproval(p.athleteId, runId)) ?? approvalState;

  // The client had stopped listening before the reply was done: one "your reply is ready" push (replyPush.ts decides
  // the rest: completed, saved, no turn cap, no waiting card that pushed already; claimed once per run).
  const clientLeft = p.sse.closed;
  if (!p.sse.closed) {
    const doneFields: AgentDoneFields = { runId, ...(cards.length ? { cards } : {}) };
    p.sse.done(doneFields as unknown as Record<string, unknown>);
  }
  await notifyReplyReady({
    athleteId: p.athleteId, runId, conversationId, messageId: replyRowId, status, clientLeft, interactive, turnCap,
    waitingPushed: waitingCardPushed(taken?.approvals ?? []),
  }, deps.replyPush);
  // The rolling summary, after the reply is saved and done is sent: started here, never awaited, never throws. It folds only once the conversation has grown past its trigger; bounded
  // (chat/summary.ts: one per conversation at a time, FOLD_TIMEOUT_MS, nothing after the deletion fence).
  if (!opts.isolated && conversationId && replyRowId && deps.fold !== false) {
    const fold = deps.fold ?? (async (a: string, c: string) => { await maybeFoldAgentConversation(a, c, {}, { isDeleting: fenced }); });
    void Promise.resolve().then(() => fold(p.athleteId, conversationId)).catch((err) => logger.warn({ runId, err: err?.message }, "mastra turn: summary fold failed"));
  }
  const durationMs = Date.now() - t0;
  await traceMastraTurn({ athleteId: p.athleteId, runId, threadId: session?.id ?? null, trigger: opts.trigger ?? "chat", status, stopReason, cost, tools, durationMs, ...(attachmentCounts ? { attachments: attachmentCounts } : {}) });
  logger.info({ athleteId: p.athleteId, runId, engine: MASTRA_PROVIDER, status, stopReason, approvalState, cards: cards.length, ...(attachmentCounts ? { attachments: attachmentCounts } : {}), tools: tools.length, toolErrors: tools.filter((t) => t.outcome === "error").length, microUsd: cost.microUsd, ms: durationMs }, "mastra turn");
  return { runId, text, status, stopReason, approvalState, cards, cost, tools, evidence, ...(turnCap ? { turnCap: true } : {}) };
}
