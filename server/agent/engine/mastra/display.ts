/**
 * agent/engine/mastra/display.ts — what each Mila tool shows OUTSIDE the runtime (chat v2's AI SDK stream).
 *
 *   input     → `{ label }`: the tool's fixed status line (engine/toolStatus.ts TOOL_STATUS_LABELS, the same lines
 *               the v1 stream sends). Never the arguments.
 *   output    → `{ cards: MilaCardDto[] }` (shared/milaCards.ts) for the cards THIS call made (taken from the call's
 *               own result in tools.ts, never the model-facing text), or null when it made none. Never the result.
 *   deltas    suppressed; an error → a fixed placeholder. Chat v2's allow-list filter (chatV2Stream.ts) drops those
 *               parts anyway.
 *
 * Where it is applied (1 Nov 2026): on chat v2's COPY of each stream chunk (displayChunk, called by turn.ts's tap),
 * in the same chunk metadata Mastra's own `transform.display` would write (`metadata.mastra.toolPayloadTransform`,
 * which @mastra/ai-sdk's toAISdkStream reads). Not as a `transform` on the tool: Mastra merges a tool's transform
 * output into the tool part's providerMetadata and SAVES it in the thread, so every card DTO was kept a second time
 * in Mastra's memory (the model never reads it; the conversation's cards live in chat_messages). Mastra's thread now
 * keeps only the tool call and its model-facing result text.
 *
 * MILA_TOOL_CARDS names the card types each tool can make. agent/engine/mastra/display.test.ts (CI) fails when a
 * tool Mila can call has no display rule, or a card-making tool has a card type without a DTO schema.
 *
 * Mastra's own agent-skill tools (skill, skill_read, skill_search: Mila's playbooks, skills.ts) have rules too: the
 * fixed "Getting ready…" line, and no cards, so their arguments and the playbook text they return never reach the
 * client. (TrueForge's get_playbook went with TrueForge, Mastra-only PR 3.)
 */
import type { ChatCardKind } from "../../../../shared/agent";
import { toMilaCardDto, type MilaCardDto } from "../../../../shared/milaCards";
import { createLogger } from "../../../logger";
import { TOOL_STATUS_LABELS, toolStatusLabel } from "../toolStatus";

const logger = createLogger("agent/engine/mastra/display");

/**
 * The card types each tool can make (empty: none). Act / propose tools make the approval ("action") card from the
 * queued pending_actions row. Every tool Mila can call over our registry is listed (display.test.ts checks it).
 */
export const MILA_TOOL_CARDS: Readonly<Record<string, readonly ChatCardKind[]>> = {
  recall_facts: [],
  remember_fact: ["action"],
  correct_fact: ["action"],
  remember_preference: ["action"],
  cite_facts: [],
  read_scouting: [],
  offer_connection: ["connect"],
  ask_quick_question: ["quick-question"],
  open_screen: ["open-screen"],
  check_camera_roll: ["open-screen"],
  list_goals: [],
  keep_goal: ["goal-change"],
  change_goal: ["goal-change"],
  set_aside_goal: ["goal-change"],
  drop_goal: ["goal-change"],
  bring_back_goal: ["goal-change"],
  add_goal: ["goal-change"],
  suggest_goal: ["goal-change"],
  refresh_plan: ["progress"],
  refresh_research: [],
  find_music: [],
  deals_find: ["deal"],
  deals_get: ["deal"],
  deals_terms: [],
  deals_waiting: ["deals-waiting"],
  deals_draft_reply: ["deal-reply"],
  deals_close: ["deal-closed"],
  deals_mark: ["action"],
  deals_open: ["open-screen"],
  brand_get: [],
  bookings_list: [],
  bookings_get: ["booking"],
  bookings_waiting: ["booking"],
  bookings_respond: ["booking"],
  documents_status: ["document", "ready"],
  documents_make: ["progress"],
  documents_edit: ["document", "ready"],
  documents_share: ["action"],
  // Reads over what Nomila holds (agent/reads): no card type fits yet, so none (the reply describes what they found).
  media_search: [],
  posts_performance: [],
  money_summary: [],
  whats_next: [],
  waitlist_status: [],
  start_research: [],
  show_waitlist_card: ["waitlist-card"],
  // The card system v2 (MILA_CARDS_V2): the five new cards' producers.
  share_insight: ["insight"],
  ideas_suggest: ["ideas"],
  offer_capability: ["turn-on"],
  ask_once: ["quick-question"],
  answer_with_sources: ["answer"],
  // Mastra's agent-skill tools (not registry tools; MASTRA_SKILL_TOOLS): read our own playbooks, make no cards.
  skill: [],
  skill_read: [],
  skill_search: [],
};

/** The card types the turn itself adds at the end (not a tool's): "How I got this". */
export const TURN_CARDS: readonly ChatCardKind[] = ["how-i-got-this"];

export function hasDisplayRule(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_STATUS_LABELS, toolName) && Object.prototype.hasOwnProperty.call(MILA_TOOL_CARDS, toolName);
}

/** The display status for a tool's input: its fixed line. */
export function displayStatus(toolName: string): { label: string } {
  return { label: toolStatusLabel(toolName) };
}

/** Code-built cards → their DTOs; a card without a schema, or failing it, is dropped and logged. */
export function cardDtos(cards: unknown[], where: { toolName: string; runId?: string | null }): MilaCardDto[] {
  const out: MilaCardDto[] = [];
  for (const c of cards) {
    const r = toMilaCardDto(c);
    if (r.ok) out.push(r.dto);
    else logger.warn({ tool: where.toolName, runId: where.runId ?? null, kind: r.kind, reason: r.reason }, "mila card dropped: no valid DTO");
  }
  return out;
}

/** The chunk shape displayChunk reads and writes (a Mastra fullStream chunk). */
export type DisplayChunk = { type: string; payload?: any; metadata?: any };

/** What an error part says instead of the error (as Mastra's own placeholder). */
export const TOOL_ERROR_PLACEHOLDER = { message: "Tool error payload unavailable" } as const;

/**
 * A COPY of a tool chunk carrying its display payload, for chat v2 only (the chunk Mastra keeps is never touched).
 * `cardsFor(toolCallId)` hands over (once) the cards that call made. Any other chunk comes back as it is.
 */
export function displayChunk<C extends DisplayChunk>(c: C, cardsFor: (toolCallId: string) => unknown[]): C {
  const pl = c.payload;
  if (!pl || typeof pl.toolCallId !== "string") return c;
  const toolName = typeof pl.toolName === "string" ? pl.toolName : "";
  const input = { transformed: displayStatus(toolName) };
  let display: Record<string, unknown>;
  switch (c.type) {
    case "tool-call": display = { "input-available": input }; break;
    case "tool-call-delta": display = { "input-delta": { suppress: true } }; break;
    case "tool-result": {
      const dtos = cardDtos(cardsFor(pl.toolCallId), { toolName });
      display = { "input-available": input, "output-available": { transformed: dtos.length ? { cards: dtos } : null } };
      break;
    }
    case "tool-error": display = { "input-available": input, error: { transformed: TOOL_ERROR_PLACEHOLDER } }; break;
    default: return c;
  }
  if (c.type === "tool-call" && !hasDisplayRule(toolName)) logger.warn({ tool: toolName }, "mila tool has no display rule: fallback status, no cards");
  const meta = c.metadata ?? {};
  return { ...c, metadata: { ...meta, mastra: { ...(meta.mastra ?? {}), toolPayloadTransform: { display } } } };
}
