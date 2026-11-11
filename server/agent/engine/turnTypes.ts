/**
 * agent/engine/turnTypes.ts — the contract every Mila turn shares (runMilaTurn and the Mastra turn): its dependencies,
 * options and result, the chat pass's scopes, and how many of Mila's own started messages a new conversation reads
 * back. Moved from agent/tf/chat.ts (5 Nov 2026); TrueForge itself went in Mastra-only PR 3 (9 Nov 2026), and with it
 * MilaTurnDeps' TrueForge client and clock. MilaTurnDeps is what runMilaTurn and the surfaces that call it take.
 */
import type { ChatCard, EvidenceRef, MemoryFact, RunApprovalState, RunCost, RunTrigger, StopReason, ToolCallRecord, ToolPermission } from "../../../shared/agent";
import type { PlatformBudget } from "../../lib/platformSpend";
import type { ChatSources } from "../chat/sources";
import type { AgentStore } from "../research/store";
import type { TurnStore } from "./tools/turnStore";

/** The landing's waitlist conversation's skill (jobs/waitlist.md; waitlist/turn.ts runs it). */
export const WAITLIST_SKILL_ID = "waitlist";

/** A chat turn's pass may use every level: propose and act are only ever queued for their tap (callTool.ts). */
export const CHAT_SCOPES: readonly ToolPermission[] = ["read", "draft", "propose", "act"];

export interface TurnDeps {
  turns?: TurnStore;
  store?: AgentStore;
  sources?: ChatSources;
  spentToday?: (athleteId: string) => Promise<number>;
  factsByIds?: (athleteId: string, ids: string[]) => Promise<MemoryFact[]>;
  passKey?: string | null;
  now?: () => Date;
  /** Default: the account-deletion fence (lib/privacy/deletionFence.ts). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
  /** The platform-wide day ceiling (default lib/platformSpend.ts platformBudget). */
  platformBudget?: () => Promise<PlatformBudget>;
}

/**
 * What runMilaTurn (engine/index.ts) and every surface that calls it take (the waitlist, agent_onboarding's and the
 * proactive turns): the shared turn deps.
 */
export type MilaTurnDeps = TurnDeps;

export interface TurnResult {
  runId: string | null;
  text: string;
  status: "completed" | "stopped" | "failed";
  stopReason: StopReason | null;
  /** "awaiting_approval" when the turn left a card waiting on the athlete's tap (agent_runs.approval_state); else null. */
  approvalState?: RunApprovalState | null;
  cards: ChatCard[];
  cost: RunCost;
  /** The turn's tool-call records (agent/proactive reads them: did Mila read the event's own deal or booking?). */
  tools?: ToolCallRecord[];
  /** What the turn read (facts, records): agent/proactive checks a SPEAK decision's evidence against it. */
  evidence?: EvidenceRef[];
  /**
   * Mastra only: the turn never ran because the athlete already had MILA_MAX_CONCURRENT_TURNS turns running
   * (engine/mastra/turn.ts admitRun). Status "stopped", stop reason "policy". agent/proactive reads it as a DEFER.
   */
  turnCap?: boolean;
}

/**
 * How a non-chat surface runs its turn on the same path (the landing's waitlist, agent_onboarding's turns;
 * docs/design/mila-hosted-waitlist.md). Absent ⇒ the chat turn exactly as before.
 */
export interface TurnOptions {
  /** The skill whose tool list bounds the pass (default AGENT.CHAT_SKILL). */
  skillId?: string;
  /** The pass's scopes (default CHAT_SCOPES). */
  scopes?: readonly ToolPermission[];
  /** App-update lines in our own words (a moment, a step, her taps), after any queued events. */
  updates?: string[];
  /** Our own instruction blocks before the context; `isNew` when this turn opens a new session (its Mastra thread). */
  /** `engine`: which engine runs the turn, so a preface can use that engine's words (mila/load.ts ENGINE_TERMS). */
  preface?: (session: { isNew: boolean; engine?: "mastra" }) => string[];
  /** The context block (default: the chat context, engine/context.ts). */
  context?: () => Promise<string>;
  /** agent_runs.parent_ref (an onboarding turn: its turn prefix, so resume, the path log and the cost cap read it). */
  parentRef?: string;
  /** agent_runs.trigger (default "chat"). */
  trigger?: RunTrigger;
  /** Which cards go into the chat history (default all). The `done` event always carries every card. */
  keepInHistory?: (c: ChatCard) => boolean;
  /**
   * A turn the server starts on its own (agent/proactive, MILA_PROACTIVE): it runs in a fresh session of its own, never
   * the conversation's live one (so a running chat turn is never disturbed, and its tool calls stay out of the
   * athlete's chat); it writes no chat rows (the caller adds only the
   * finished message to the conversation); the run is still recorded against `p.conversationId`, so a tap on one of its
   * cards reaches that conversation (events.ts noteApprovalOutcome).
   */
  isolated?: boolean;
}

/** How many of Mila's own started messages a conversation's first turn reads back (rules.ts keeps the number). */
export const MILA_STARTED_SEED = 3;
