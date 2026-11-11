/**
 * voice/oneMila/session.ts — what a voice call starts with: Mila's one definition for the voice surface, the chat's
 * per-turn CONTEXT, and the tools as Gemini Live function declarations, all from the same sources a Mastra chat turn
 * uses (engine/mastra/turn.ts), so voice and chat are one Mila:
 *
 *   instructions  mila/build.ts buildMilaInstructions({ surface: "voice", engine: "mastra" }) (instructions/00…60 +
 *                 surfaces/voice.md), then the playbooks catalog in our own words (engine/mastra/skills.ts
 *                 playbooksCatalog, as milaSkillsProcessor adds it to a chat turn) for the playbooks the voice surface
 *                 is offered (nomila.yaml `surfaces` has "voice", flag on)
 *   context       engine/context.ts buildTurnContext, the extended block a chat turn gets (BRIEF, goals, COMING UP,
 *                 taps waiting, PREFERENCES with NEVER USE, CAN DO NOW, EARLIER / RECENT), with OPENED FROM voice,
 *                 fenced in <context> exactly as a chat turn's. CAN DO NOW is worked out from the call's own tools.
 *   tools         the voice job's tools (jobs/voice.yaml) through the SAME filter as a chat turn:
 *                 allowedTools(athlete, visibleTools(passSkill(loadJob("voice")), registry, { scopes })) — flags,
 *                 scopes and per-athlete capabilities applied; then the proxy's own: web_search (while
 *                 MILA_VOICE_WEB_SEARCH is on and the job allows searches), skill (when a playbook is offered), and
 *                 read_back + confirm_by_voice (when a reply can be drafted in the call). declarations.ts writes them.
 *
 * The tool route (toolProxy.ts) recomputes the same set per call, so a tool turned off mid-call is refused even though
 * the worker declared it at the start.
 */
import { z } from "zod";
import type { FunctionDeclaration } from "@google/genai";
import type { AgentTool, ToolRegistry } from "../../agent/tools";
import type { Skill } from "../../../shared/agent";
import { loadJob } from "../../agent/jobs";
import { buildMilaInstructions, approxTokens, digestOf } from "../../agent/mila/build";
import { readSkillFrontMatter } from "../../agent/mila/load";
import { passRegistry, passSkill, visibleTools } from "../../agent/engine/tools/registry";
import { allowedTools, capabilityOverview } from "../../agent/welcome/toolGate";
import { CHAT_SCOPES } from "../../agent/engine/turnTypes";
import { runLimitsFor } from "../../agent/config";
import { allowedSkillNames, MILA_SKILL_TOOL_DESCRIPTIONS, playbooksCatalog } from "../../agent/engine/mastra/skills";
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_TOOL, webSearchCap } from "../../agent/engine/mastra/webSearch";
import { buildTurnContext } from "../../agent/engine/context";
import { wrapTagged } from "../../lib/externalContent";
import { dbStore } from "../../agent/research/dbStore";
import { dbChatSources } from "../../agent/chat/sources";
import { dbTurnStore } from "../../agent/engine/tools/dbTurnStore";
import { getConversationContext } from "../../mila/conversations";
import { conversationLanguageOf, readMilaVoiceSettings } from "../../services/milaVoice/settings";
import { MILA } from "../../mila/config";
import { createLogger } from "../../logger";
import { declare, type DeclarableTool, type JsonFunctionTool } from "./declarations";
import { sessionIdOf, voiceSessionRow, VOICE_CALLS_PER_MINUTE, VOICE_TURNS_PER_CALL } from "./state";

const logger = createLogger("voice/oneMila/session");

/** The voice pass's job id (jobs/voice.yaml) and the pass's scopes (the chat's: propose and act are only ever queued). */
export const VOICE_JOB_ID = "voice";
export const VOICE_SCOPES = CHAT_SCOPES;
/** The voice session contract's version: bumped when the worker must change with it. */
export const VOICE_SESSION_VERSION = 1;

export const SKILL_TOOL = "skill";
export const READ_BACK_TOOL = "read_back";
export const CONFIRM_BY_VOICE_TOOL = "confirm_by_voice";
/** The proxy's own tools (not registry tools). */
export const VOICE_PROXY_TOOLS = [WEB_SEARCH_TOOL, SKILL_TOOL, READ_BACK_TOOL, CONFIRM_BY_VOICE_TOOL] as const;

/** Prompt Register "Mila voice — read_back / confirm_by_voice tools": model-facing, exact text. */
export const READ_BACK_DESCRIPTION =
  "Get the exact reply waiting for the athlete's approval, to read it back out loud: who it goes to, the subject, the " +
  "body, and whether a spoken yes can send it. Use right after you draft a reply in this call, before asking whether " +
  "to send it. Don't use it to read anything else.";
export const CONFIRM_BY_VOICE_DESCRIPTION =
  "Send a reply the athlete just approved out loud. Only after you read it back with read_back in an earlier turn of " +
  "this call and they then clearly said to send it. Works for an ordinary reply you drafted in this call (a question, " +
  "asking for details, terms or paperwork, or a polite no), unless they turned sending by voice off. Anything with " +
  "money or a number, a yes to an offer, a booking or anything public is refused and waits for their tap in the app.";

export const WEB_SEARCH_ARGS = z.object({ query: z.string().trim().min(2).max(300).describe("What to look up, as a short search query.") });
export const PENDING_ARGS = z.object({ pending_id: z.string().max(80).describe("The pending reply's id, from the draft you made in this call.") });

/** The call's tools, as the session declares them and the tool route enforces them. */
export interface VoiceToolset {
  job: Skill;
  registry: ToolRegistry;
  /** The registry tools this athlete's call can use (flags, scopes and per-athlete capabilities applied). */
  visible: AgentTool[];
  /** The playbooks the voice surface is offered (the skill tool's names). */
  playbooks: string[];
  webSearch: boolean;
  confirm: boolean;
  limits: ReturnType<typeof runLimitsFor>;
  /** Every declared name: the visible registry tools, then the proxy's own. */
  names: string[];
}

export interface ToolsetDeps {
  allowed?: <T extends { name: string }>(athleteId: string, tools: readonly T[]) => Promise<T[]>;
}

export async function voiceToolset(athleteId: string, deps: ToolsetDeps = {}): Promise<VoiceToolset> {
  const job = loadJob(VOICE_JOB_ID);
  const registry = passRegistry();
  const visible = await (deps.allowed ?? allowedTools)(athleteId, visibleTools(passSkill(job, registry), registry, { scopes: [...VOICE_SCOPES] }));
  const limits = runLimitsFor(job);
  const webSearch = MILA.VOICE_WEB_SEARCH && VOICE_SCOPES.includes("read") && webSearchCap(job, limits.maxWebSearches) > 0;
  const playbooks = allowedSkillNames({ surface: "voice", tools: visible.map((t) => t.name) });
  const confirm = visible.some((t) => t.name === "deals_draft_reply");
  const names = [
    ...visible.map((t) => t.name),
    ...(webSearch ? [WEB_SEARCH_TOOL] : []),
    ...(playbooks.length ? [SKILL_TOOL] : []),
    ...(confirm ? [READ_BACK_TOOL, CONFIRM_BY_VOICE_TOOL] : []),
  ];
  return { job, registry, visible, playbooks, webSearch, confirm, limits, names };
}

/** Every declared tool as name + description + zod args (the registry's own, and the proxy's). */
export function declarables(ts: VoiceToolset): DeclarableTool[] {
  return [
    ...ts.visible.map((t) => ({ name: t.name, description: t.description, args: t.args })),
    ...(ts.webSearch ? [{ name: WEB_SEARCH_TOOL, description: WEB_SEARCH_DESCRIPTION, args: WEB_SEARCH_ARGS }] : []),
    ...(ts.playbooks.length ? [{
      name: SKILL_TOOL, description: MILA_SKILL_TOOL_DESCRIPTIONS.skill,
      args: z.object({ name: z.enum(ts.playbooks as [string, ...string[]]).describe("The playbook's name.") }),
    }] : []),
    ...(ts.confirm ? [
      { name: READ_BACK_TOOL, description: READ_BACK_DESCRIPTION, args: PENDING_ARGS },
      { name: CONFIRM_BY_VOICE_TOOL, description: CONFIRM_BY_VOICE_DESCRIPTION, args: PENDING_ARGS },
    ] : []),
  ];
}

/** The instructions a voice call is given: Mila's one definition for voice, then the playbooks catalog. */
export function voiceInstructions(playbooks: readonly string[]): string {
  const core = buildMilaInstructions({ surface: "voice", engine: "mastra" });
  return playbooks.length ? `${core}\n${playbooksCatalog(playbooks.map((n) => readSkillFrontMatter(n)))}\n` : core;
}

export interface VoiceSession {
  version: number;
  athleteId: string;
  conversationId: string | null;
  /** The conversation's mila_tf_sessions row (the chat's own); null without a conversation. */
  sessionId: string | null;
  instructions: string;
  /** The CONTEXT block, fenced in <context> as a chat turn's. The worker appends it to the system instruction. */
  context: string;
  tools: FunctionDeclaration[];
  /** The same tools for an OpenAI-style realtime model (the Grok fallback, MILA_VOICE_XAI). */
  toolsJsonSchema: JsonFunctionTool[];
  limits: {
    grantExpiresAt: string;
    toolCallsPerTurn: number;
    webSearchesPerTurn: number;
    /** Ceilings on the whole call (state.ts): its spoken turns, and its tool calls in any 60 seconds. */
    turnsPerCall: number;
    toolCallsPerMinute: number;
    /** What is left of today's voice minutes when the call was granted is in the grant's expiry; this is now. */
    voiceMinutesLeft: number | null;
  };
  digests: { instructions: string; tools: string; context: string };
  approxTokens: { instructions: number; context: number; tools: number };
}

export interface SessionDeps extends ToolsetDeps {
  now?: () => Date;
  context?: (p: { athleteId: string; conversationId: string | null; visible: AgentTool[]; offeredConnectors: string[] }) => Promise<string>;
  voiceMinutesLeft?: (athleteId: string) => Promise<number | null>;
}

// The athlete's fixed conversation language (Me > Mila's voice and language, #1249) rides in the same CONTEXT as a chat
// turn's LANGUAGE line, so a call on the server definition keeps the language they chose. Read fail-open: a failed read
// is "auto" (no line), never a lost call. The worker adds its own LANGUAGE line only on its legacy-briefing path.
async function defaultContext(p: { athleteId: string; conversationId: string | null; visible: AgentTool[]; offeredConnectors: string[]; now: Date }): Promise<string> {
  const conversationSummary = p.conversationId
    ? await getConversationContext(p.athleteId, p.conversationId).then((c) => c.summary, () => null) : null;
  const [capabilities, voiceSettings] = await Promise.all([
    capabilityOverview(p.athleteId, { surface: "voice" }).catch((err) => {
      logger.warn({ athleteId: p.athleteId, err: err?.message }, "voice session: capability states not read");
      return null;
    }),
    readMilaVoiceSettings(p.athleteId).catch((err) => {
      logger.warn({ athleteId: p.athleteId, err: err?.message }, "voice session: language setting not read");
      return null;
    }),
  ]);
  return buildTurnContext(dbStore, dbChatSources, {
    athleteId: p.athleteId, openedFrom: { type: "voice" }, now: p.now, visibleTools: p.visible, offeredConnectors: p.offeredConnectors,
    capabilities,
    extended: { conversationId: p.conversationId, conversationSummary },
    conversationLanguage: conversationLanguageOf(voiceSettings),
  });
}

async function defaultMinutesLeft(athleteId: string): Promise<number | null> {
  const { voiceAllowance } = await import("../voiceMinutes");
  return voiceAllowance(athleteId).then((a) => Math.max(0, Math.floor(a.remainingMs / 60_000)), () => null);
}

/** Build the session a voice call starts with. `grantExp` is the grant's expiry (epoch seconds). */
export async function buildVoiceSession(
  p: { athleteId: string; conversationId: string; callKey: string; grantExp: number },
  deps: SessionDeps = {},
): Promise<VoiceSession> {
  const now = (deps.now ?? (() => new Date()))();
  const ts = await voiceToolset(p.athleteId, deps);
  const row = await voiceSessionRow(p.athleteId, p.conversationId);
  const conversationId = row ? p.conversationId : null;
  const { turn } = await dbTurnStore.loadState({ athleteId: p.athleteId, sessionId: sessionIdOf(row, p.callKey), runId: "" });
  const raw = deps.context
    ? await deps.context({ athleteId: p.athleteId, conversationId, visible: ts.visible, offeredConnectors: turn.offeredConnectors })
    : await defaultContext({ athleteId: p.athleteId, conversationId, visible: ts.visible, offeredConnectors: turn.offeredConnectors, now });
  const context = raw.trim() ? wrapTagged(raw, "context", {}, { newlines: true }) : "";
  const decl = declarables(ts).map(declare);
  const tools = decl.map((d) => d.gemini);
  const toolsJsonSchema = decl.map((d) => d.json);
  const instructions = voiceInstructions(ts.playbooks);
  const toolsText = JSON.stringify(tools);
  return {
    version: VOICE_SESSION_VERSION,
    athleteId: p.athleteId,
    conversationId,
    sessionId: row?.id ?? null,
    instructions,
    context,
    tools,
    toolsJsonSchema,
    limits: {
      grantExpiresAt: new Date(p.grantExp * 1000).toISOString(),
      toolCallsPerTurn: ts.limits.maxSteps,
      webSearchesPerTurn: ts.webSearch ? webSearchCap(ts.job, ts.limits.maxWebSearches) : 0,
      turnsPerCall: VOICE_TURNS_PER_CALL,
      toolCallsPerMinute: VOICE_CALLS_PER_MINUTE,
      voiceMinutesLeft: await (deps.voiceMinutesLeft ?? defaultMinutesLeft)(p.athleteId).catch(() => null),
    },
    digests: { instructions: digestOf(instructions), tools: digestOf(toolsText), context: digestOf(context) },
    approxTokens: { instructions: approxTokens(instructions), context: approxTokens(context), tools: approxTokens(toolsText) },
  };
}
