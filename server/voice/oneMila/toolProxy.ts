/**
 * voice/oneMila/toolProxy.ts — ONE voice tool call, run on the server through the same guarded path as a chat turn's
 * tools (engine/mastra/tools.ts → engine/tools/registry.ts callPassTool). The worker sends the model's call as it is;
 * the athlete and the conversation come from the verified grant (routes.ts), never from the call.
 *
 * Per call, in order (fail closed at each step):
 *   1. the call's tools, recomputed now (session.ts voiceToolset: flags, scopes, per-athlete capabilities): a name not
 *      declared for this athlete now is refused (a tool turned off mid-call stays off)
 *   2. spend: the athlete's day cap (agent/trace.ts spentTodayMicroUsd — her voice minutes and every tool's own runs
 *      count in it, as a chat turn's do) and the platform's day cap; at either, nothing runs. There is no per-turn
 *      dollar cap on voice: a turn is bounded by its call and search slots below, and the day caps.
 *   3. the spoken turn's run (state.ts voiceTurnRun: one agent_runs row per worker turnId; a call has at most
 *      VOICE_TURNS_PER_CALL turns) and the call's slot, RESERVED atomically before anything runs (state.ts
 *      reserveSlot: tool calls per turn = the voice job's max_steps, web searches per turn, tool calls per minute
 *      across the call), so parallel calls cannot all pass a cap
 *   4. registry tools: a fresh athlete pass minted per call (10-minute JWS; the worker never holds one), the deletion
 *      fence (clearFence), then callPassTool: skill toolset, tenancy, NEVER USE, tap_to_send / money / confirm_first
 *      (act and propose calls are queued for her tap, never run), capability gate, zod validation, prepare, the timeout,
 *      the turn store record, and an ok result fenced as outside text. The text returned is exactly what the Mastra
 *      model would read.
 *      web_search: one search through the chat's search skill (mastra/webSearch.ts realWebSearch), its own agent_runs
 *      row in her day spend.
 *      skill: one playbook's text (mila/build.ts readPlaybook), only a playbook the voice surface is offered.
 *      read_back / confirm_by_voice: confirm.ts (ordinary replies only, opted in; the server decides).
 *   5. cards: what THIS call made (callPassTool's own return: its approval and its code-built cards, never another
 *      parallel call's) is saved at once as ONE assistant row in the conversation (chat_messages, source 'voice',
 *      agent_cards, agent_run_id = the turn run), so the app can draw it while the call goes on and a reopened chat
 *      shows it. Its id comes back as `messageId` with a ref per card; the worker relays only those ids (the widget
 *      bridge, see routes.ts). A deal-reply card's pending id (and recipient) is recorded for confirm_by_voice
 *      ("drafted in this call"). The turn store's items for the run (tool records, evidence) are taken and kept on the
 *      run; its cards and approvals there are the same ones, already saved.
 * Errors are `{ status: "error", … }` text the model can recover from, never thrown; only the guard refuses with a
 * status (routes.ts).
 */
import { z } from "zod";
import { db } from "../../db";
import { chatMessages } from "../../../shared/schema";
import type { ChatCard, ToolCallRecord } from "../../../shared/agent";
import { createLogger } from "../../logger";
import { external } from "../../lib/externalContent";
import { clearFence, isAthleteDeleting } from "../../lib/privacy/deletionFence";
import { PLATFORM_CAP_MESSAGE, platformBudget, type PlatformBudget } from "../../lib/platformSpend";
import { AGENT } from "../../agent/config";
import { queueApproval as dbQueueApproval, settleRunApproval } from "../../agent/approvals";
import { actionCard } from "../../agent/cards";
import { neverTermsFor } from "../../agent/memory";
import { issueAthletePass, verifyAthletePass } from "../../agent/engine/tools/pass";
import { callPassTool, passSkill, type PassToolDeps } from "../../agent/engine/tools/registry";
import { STOP_MESSAGES } from "../../agent/engine/stopMessages";
import { readPlaybook, type MilaPlaybook } from "../../agent/mila/build";
import { realWebSearch, webSearchCap, WebSearchDayCap, SOURCES_TO_MODEL, type WebSearchCall } from "../../agent/engine/mastra/webSearch";
import { spentTodayMicroUsd } from "../../agent/trace";
import {
  CONFIRM_BY_VOICE_TOOL, PENDING_ARGS, READ_BACK_TOOL, SKILL_TOOL, VOICE_SCOPES, WEB_SEARCH_ARGS, voiceToolset, type ToolsetDeps,
} from "./session";
import { confirmByVoice, readBack, type ConfirmDeps } from "./confirm";
import {
  recordDrafted, recordOnRun, reserveSlot, sessionIdOf, voiceSessionRow, voiceTurnRun, voiceTurnStore, voiceWords, VOICE_TURNS_PER_CALL,
  type SlotRefusal,
} from "./state";

const logger = createLogger("voice/oneMila/tool");

/**
 * Appended to the model's text when the call put a card on the athlete's screen. Prompt Register "Mila voice — card on
 * screen": model-facing, exact text.
 */
export const CARD_ON_SCREEN_NOTE = "(A card for this is on the athlete's screen now. Point to it and read out only its key parts.)";

/** What the model reads when a slot is refused. Prompt Register "Mila voice — proxy errors". */
export const SLOT_REFUSED: Readonly<Record<SlotRefusal | "turns_per_call", (n: number) => string>> = {
  calls_per_turn: (n) => `tool call limit for this turn reached (${n}); answer with what you have`,
  searches_per_turn: (n) => `web search limit reached for this turn (${n}); answer with what you have`,
  calls_per_minute: () => "too many tool calls in this call just now; answer with what you have and try again in a minute",
  turns_per_call: () => "this call has reached its limit of turns; tell them to start a new call",
};

/** One card the call made, as the worker relays it and the app finds it. */
export interface VoiceCardRef {
  cardId: string;
  kind: string;
  title: string;
  /** The chat_messages row the card is saved on (GET /api/v1/me/conversations/:id returns it with its agentCards). */
  messageId: string;
  /** An approval card (pending_actions agent_action): its id. */
  approvalId?: string;
  /** A deal-reply card (pending_actions send_reply): its id. */
  pendingActionId?: string;
}

export interface VoiceToolResult {
  /** What the model reads (the worker's functionResponse). */
  text: string;
  isError: boolean;
  /** The row the call's cards are saved on, or null when it made none (or has no conversation). */
  messageId: string | null;
  cards: VoiceCardRef[];
  runId: string | null;
}

export interface VoiceToolInput {
  athleteId: string;
  /** From the grant ('' when the call has none). */
  conversationId: string;
  callKey: string;
  turnId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceToolDeps extends ToolsetDeps, Partial<PassToolDeps> {
  passKey?: string | null;
  spentToday?: (athleteId: string) => Promise<number>;
  platform?: () => Promise<PlatformBudget>;
  search?: WebSearchCall;
  confirm?: ConfirmDeps;
}

const errorText = (reason: string) => JSON.stringify({ status: "error", reason });
const refused = (text: string, runId: string | null = null): VoiceToolResult => ({ text, isError: true, messageId: null, cards: [], runId });

function cardRef(c: ChatCard, messageId: string): VoiceCardRef {
  const payload = (c.payload ?? {}) as Record<string, unknown>;
  return {
    cardId: c.id, kind: c.kind, title: c.title, messageId,
    ...(typeof payload.approvalId === "string" ? { approvalId: payload.approvalId } : {}),
    ...(c.kind === "deal-reply" && typeof payload.pendingActionId === "string" && payload.pendingActionId ? { pendingActionId: payload.pendingActionId } : {}),
  };
}

export async function runVoiceTool(input: VoiceToolInput, deps: VoiceToolDeps = {}): Promise<VoiceToolResult> {
  const { athleteId, conversationId, callKey, turnId, name } = input;
  const t0 = Date.now();
  const ts = await voiceToolset(athleteId, deps);
  if (!ts.names.includes(name)) {
    logger.info({ athleteId, tool: name }, "voice tool refused: not available in this call");
    return refused(errorText(`${name} is not available in this call. Use only the tools you were given.`));
  }

  // Spend, before anything runs: her day cap (her voice and every tool's own run count in it), then the platform's.
  const spent = await (deps.spentToday ?? spentTodayMicroUsd)(athleteId).catch(() => Number.POSITIVE_INFINITY);
  if (spent >= AGENT.DAY_COST_CAP_MICRO_USD) return refused(errorText(STOP_MESSAGES.cost_cap_day));
  const platform = await (deps.platform ?? platformBudget)().catch(() => ({ over: true } as PlatformBudget));
  if (platform.over) return refused(errorText(PLATFORM_CAP_MESSAGE));

  const session = await voiceSessionRow(athleteId, conversationId);
  const conv = session ? conversationId : "";
  const runId = await voiceTurnRun({ athleteId, conversationId: conv || null, callKey, turnId, skillVersion: `voice:${ts.job.version}` });
  if (!runId) return refused(errorText(SLOT_REFUSED.turns_per_call(VOICE_TURNS_PER_CALL)));
  const record = (outcome: ToolCallRecord["outcome"], extra: Partial<ToolCallRecord> = {}): ToolCallRecord =>
    ({ name, kind: name === "web_search" ? "builtin" : "ours", permission: "read", outcome, durationMs: Date.now() - t0, ...extra });

  // The slot, reserved before anything runs (a refused call reserves nothing).
  const searchCap = webSearchCap(ts.job, ts.limits.maxWebSearches);
  const slot = await reserveSlot({ athleteId, callKey, runId, search: name === "web_search", callsPerTurn: ts.limits.maxSteps, searchesPerTurn: searchCap });
  if (!slot.ok) {
    await recordOnRun(athleteId, runId, [record("denied", { rule: "cost_cap", reason: slot.why })], [], false).catch(() => undefined);
    return refused(errorText(SLOT_REFUSED[slot.why](slot.why === "searches_per_turn" ? searchCap : ts.limits.maxSteps)), runId);
  }

  // ── the proxy's own tools ──────────────────────────────────────────────────────────────────────────────────────
  if (name === SKILL_TOOL) {
    const a = z.object({ name: z.string() }).safeParse(input.args);
    const out = a.success && ts.playbooks.includes(a.data.name)
      ? { text: readPlaybook(a.data.name as MilaPlaybook), isError: false }
      : { text: errorText(`no such playbook; available: ${ts.playbooks.join(", ")}`), isError: true };
    await recordOnRun(athleteId, runId, [record(out.isError ? "error" : "ok")], [], false);
    return { ...out, messageId: null, cards: [], runId };
  }
  if (name === READ_BACK_TOOL || name === CONFIRM_BY_VOICE_TOOL) {
    if (!(await clearFence(athleteId, deps.isDeleting ?? isAthleteDeleting))) return refused(errorText("this account is being deleted, so nothing can run. Do not retry."), runId);
    const a = PENDING_ARGS.safeParse(input.args);
    if (!a.success) return refused(errorText("give the pending_id of the reply you drafted"), runId);
    const c = { athleteId, conversationId: conv, callKey, session, pendingId: a.data.pending_id.trim(), turnId };
    const out = name === READ_BACK_TOOL ? await readBack(c, deps.confirm) : await confirmByVoice(c, deps.confirm);
    await recordOnRun(athleteId, runId, [record(out.isError ? "denied" : "ok", { permission: name === CONFIRM_BY_VOICE_TOOL ? "act" : "read", ...(out.isError && name === CONFIRM_BY_VOICE_TOOL ? { rule: "tap_to_send" } : {}) })], [], false);
    return { text: out.text, isError: out.isError, messageId: null, cards: [], runId };
  }
  if (name === "web_search") return webSearch(input, runId, slot.searches, record, deps);

  // ── a registry tool: the one guarded path ──────────────────────────────────────────────────────────────────────
  const fenced = deps.isDeleting ?? isAthleteDeleting;
  const fence = await clearFence(athleteId, fenced);
  if (!fence) {
    logger.warn({ athleteId, tool: name }, "voice tool refused: account being deleted");
    return refused(errorText("this account is being deleted, so no tool may run. Do not retry."), runId);
  }
  const sessionId = sessionIdOf(session, callKey);
  const pass = verifyAthletePass(issueAthletePass({ athleteId, sessionId, runId, skillId: ts.job.id, scopes: VOICE_SCOPES }, deps.passKey === undefined ? undefined : deps.passKey), deps.passKey === undefined ? undefined : deps.passKey);
  const turns = deps.turns ?? voiceTurnStore(conv ? await voiceWords(athleteId, conv).catch(() => []) : []);
  const r = await callPassTool(pass, passSkill(ts.job, ts.registry), ts.registry, name, input.args, {
    neverTerms: deps.neverTerms ?? neverTermsFor,
    queueApproval: deps.queueApproval ?? dbQueueApproval,
    turns,
    resultMaxChars: deps.resultMaxChars ?? AGENT.TOOL_RESULT_MAX_CHARS,
    isDeleting: fenced,
  }, fence);

  // This call's own cards (never a parallel call's). The run's turn-store items: records and evidence onto the run.
  const cards: ChatCard[] = [...(r.approval ? [actionCard(r.approval)] : []), ...(r.cards ?? [])];
  const taken = await turns.take({ athleteId, sessionId, runId }).catch((err) => { logger.warn({ athleteId, runId, err: err?.message }, "voice tool: turn items not read"); return null; });
  await recordOnRun(athleteId, runId, taken?.tools ?? [], taken?.evidence ?? [], !!r.approval)
    .catch((err) => logger.warn({ athleteId, runId, err: err?.message }, "voice tool: run record not kept"));
  if (r.approval) await settleRunApproval(athleteId, runId);

  let messageId: string | null = null;
  let refs: VoiceCardRef[] = [];
  if (cards.length && conv) {
    try {
      const [row] = await db.insert(chatMessages).values({
        athlete_id: athleteId, conversation_id: conv, role: "assistant", content: "", source: "voice", agent_cards: cards, agent_run_id: runId,
      }).returning({ id: chatMessages.id });
      messageId = row.id;
      refs = cards.map((c) => cardRef(c, row.id));
    } catch (err: any) {
      logger.error({ athleteId, runId, err: err?.message }, "voice tool: cards not saved");
    }
  }
  if (session) {
    for (const c of cards) {
      const p = (c.payload ?? {}) as Record<string, unknown>;
      if (c.kind === "deal-reply" && typeof p.pendingActionId === "string" && p.pendingActionId) {
        await recordDrafted(session, p.pendingActionId, callKey, typeof p.to === "string" ? p.to : null).catch(() => undefined);
      }
    }
  }

  logger.info({ athleteId, runId, tool: name, isError: r.isError, cards: cards.length, ms: Date.now() - t0 }, "voice tool");
  return { text: refs.length ? `${r.text}\n${CARD_ON_SCREEN_NOTE}` : r.text, isError: r.isError, messageId, cards: refs, runId };
}

/** web_search: one search through the chat's search skill, its own run in her day spend (its slot already reserved). */
async function webSearch(
  input: VoiceToolInput, runId: string, n: number,
  record: (o: ToolCallRecord["outcome"], extra?: Partial<ToolCallRecord>) => ToolCallRecord, deps: VoiceToolDeps,
): Promise<VoiceToolResult> {
  const { athleteId } = input;
  if (!(await clearFence(athleteId, deps.isDeleting ?? isAthleteDeleting))) return refused(errorText("this account is being deleted, so nothing can run. Do not retry."), runId);
  const a = WEB_SEARCH_ARGS.safeParse(input.args);
  if (!a.success) { await recordOnRun(athleteId, runId, [record("error", { reason: "invalid arguments" })], [], false); return refused(errorText("give one short search query"), runId); }
  try {
    // n: this search's number in the turn (its reserved slot), so its parent_ref is unique and never reused.
    const r = await (deps.search ?? realWebSearch)(a.data.query, { athleteId, runId, n });
    const evidence = r.sources.filter((s) => s.url).map((s) => ({ kind: "url" as const, url: s.url, ...(s.title ? { title: s.title } : {}) }));
    await recordOnRun(athleteId, runId, [record("ok")], evidence, false);
    const body = { status: "ok", answer: r.answer || "(the search found nothing reliable)", sources: r.sources.slice(0, SOURCES_TO_MODEL) };
    return { text: external(JSON.stringify(body), {}, { newlines: true })!, isError: false, messageId: null, cards: [], runId };
  } catch (err: any) {
    if (err instanceof WebSearchDayCap) {
      await recordOnRun(athleteId, runId, [record("denied", { rule: "cost_cap", reason: "the day cap is reached" })], [], false);
      return refused(errorText("today's spending limit is reached, so the web search did not run; answer without it"), runId);
    }
    await recordOnRun(athleteId, runId, [record("error", { reason: String(err?.message ?? err).slice(0, 200) })], [], false).catch(() => undefined);
    logger.warn({ athleteId, runId, err: String(err?.message ?? err).slice(0, 200) }, "voice web search failed");
    return refused(errorText("the web search failed; answer without it"), runId);
  }
}
