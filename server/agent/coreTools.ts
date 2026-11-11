/**
 * agent/coreTools.ts — the tools the harness ships, and the default registry.
 *
 *   health_check         ours · read      the harness answers: contract version, skills and tools loaded
 *   web_search           builtin · read   the provider's native web search (OpenAI web_search)
 *   chat tools           ours · read / propose (agent/chat/tools.ts): recall_facts (query / topic / subject_kind),
 *                        remember_fact, correct_fact, remember_preference (propose: saved only on the athlete's tap),
 *                        cite_facts, read_scouting, offer_connection, ask_quick_question, open_screen
 *   goal tools           ours · read / draft (agent/plan/tools.ts): list_goals, keep_goal, change_goal, set_aside_goal,
 *                        drop_goal, bring_back_goal, add_goal, suggest_goal, refresh_plan
 *   research tool        ours · draft (agent/researchRefresh/tools.ts): refresh_research — a lean research refresh run,
 *                        behind LEAN_SIGNUP_RESEARCH (`enabled`)
 *   post-kit tools       ours · read (agent/postKit/tools.ts): find_music
 *   media tools          ours · read (agent/media/tools.ts): check_camera_roll — behind CAMERA_ROLL_INTAKE (`enabled`):
 *                        registered always, left out of every run while the flag is off
 *
 *   deals tools          ours · read / draft / propose (agent/deals/tools.ts): deals_find, deals_get, deals_terms, deals_waiting,
 *                        deals_draft_reply, deals_close, deals_mark, deals_open, brand_get — AGENT_DEALS_TOOLS (`enabled`)
 *   bookings tools       ours · read / draft (agent/bookings/tools.ts): bookings_list, bookings_get, bookings_waiting,
 *                        bookings_respond — AGENT_BOOKINGS_TOOLS (`enabled`)
 *   documents tools      ours · read / draft / act (agent/documents/tools.ts): documents_status, documents_make,
 *                        documents_edit, documents_share (act: queued for her tap) — AGENT_DOCUMENTS_TOOLS (`enabled`)
 *   read tools           ours · read (agent/reads/tools.ts): media_search, posts_performance, money_summary, whats_next —
 *                        MILA_READ_TOOLS (`enabled`)
 *   card tools           ours · draft (agent/milaCards/tools.ts): share_insight, ideas_suggest, offer_capability, ask_once,
 *                        answer_with_sources — the card system v2's producers, MILA_CARDS_V2 (`enabled`)
 *
 * Product tools (rates, card, Studio, connectors …) register here as their tracks land. No tool takes an athlete
 * id: the run's athlete arrives in ToolContext. Every tool's result carries an explicit status (tools.ts ToolResult).
 */
import { z } from "zod";
import { waitlistTools } from "./waitlist/tools";
import { AGENT_CONTRACT_VERSION } from "../../shared/agent";
import { listJobs } from "./jobs";
import { okResult, ToolRegistry, type AgentTool } from "./tools";
import { goalTools } from "./plan/tools";
import { researchTools } from "./researchRefresh/tools";
import { postKitTools } from "./postKit/tools";
import { chatTools } from "./chat/tools";
import { mediaTools } from "./media/tools";
import { dbChatSources, type ChatSources } from "./chat/sources";
import { dbStore } from "./research/dbStore";
import type { AgentStore } from "./research/store";
import { dealsTools } from "./deals/tools";
import type { DealsSource } from "./deals/source";
import { bookingsTools } from "./bookings/tools";
import type { BookingsSource } from "./bookings/source";
import { bookingsEnabledFor } from "../services/bookings/config";
import { documentsTools } from "./documents/tools";
import { milaCardTools } from "./milaCards/tools";
import type { DocumentsSource } from "./documents/source";
import { readTools } from "./reads/tools";
import type { ReadsSource } from "./reads/source";

/**
 * The database sources, loaded on first use: the deal and booking services import the harness themselves (the reply
 * skill runs as an agent run), so a load-time import here would be a cycle — and most runs never touch a deal.
 */
const lazyDeals: DealsSource = new Proxy({} as DealsSource, {
  get: (_t, method: keyof DealsSource) => async (...args: unknown[]) => {
    const { dbDealsSource } = await import("./deals/dbSource");
    return (dbDealsSource[method] as (...a: unknown[]) => unknown).apply(dbDealsSource, args);
  },
});
const lazyBookings: BookingsSource = {
  enabled: (athleteId) => bookingsEnabledFor(athleteId),
  list: async (...a) => (await import("./bookings/dbSource")).dbBookingsSource.list(...a),
  get: async (...a) => (await import("./bookings/dbSource")).dbBookingsSource.get(...a),
};

/** Mila's read tools' source (agent/reads/dbSource.ts), loaded on first use: it reaches the money, deals and media services. */
const lazyReads: ReadsSource = new Proxy({} as ReadsSource, {
  get: (_t, method: keyof ReadsSource) => async (...args: unknown[]) => {
    const { dbReadsSource } = await import("./reads/dbSource");
    return (dbReadsSource[method] as (...a: unknown[]) => unknown).apply(dbReadsSource, args);
  },
});

/** The documents source, loaded on first use (it reaches the engine, the share layer and the workflow runner). */
const lazyDocuments: DocumentsSource = new Proxy({} as DocumentsSource, {
  get: (_t, method: keyof DocumentsSource) => async (...args: unknown[]) => {
    const { dbDocumentsSource } = await import("./documents/dbSource");
    return (dbDocumentsSource[method] as (...a: unknown[]) => unknown).apply(dbDocumentsSource, args);
  },
});

export function healthCheckTool(registry: ToolRegistry): AgentTool {
  return {
    name: "health_check",
    description: "Reports whether the agent harness is working. Returns { status, ok, contract, skills, tools }. No arguments.",
    kind: "ours",
    permission: "read",
    args: z.object({}),
    async execute() {
      return okResult({ ok: true, contract: AGENT_CONTRACT_VERSION, skills: listJobs().length, tools: registry.all().length });
    },
  };
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description: "Search the web (provider built-in). Cite what you use.",
  kind: "builtin",
  permission: "read",
  builtin: "web_search",
  args: z.object({}),
};

/** The registry the app runs with (database store and sources); the chat eval passes in-memory ones. */
export function createDefaultRegistry(opts: { store?: AgentStore; sources?: ChatSources; deals?: DealsSource; bookings?: BookingsSource; documents?: DocumentsSource; reads?: ReadsSource } = {}): ToolRegistry {
  const store = opts.store ?? dbStore;
  const registry = new ToolRegistry();
  registry.register(healthCheckTool(registry)).register(webSearchTool);
  for (const t of chatTools(store, opts.sources ?? dbChatSources)) registry.register(t);
  // The plan step's goal tools (list / keep / change / set aside / drop / bring back / add / suggest / refresh).
  for (const t of goalTools(store)) registry.register(t);
  // Lean research refresh (refresh_research, draft): LEAN_SIGNUP_RESEARCH (`enabled`); off ⇒ forSkill and the pass (visibleTools) leave it out.
  for (const t of researchTools()) registry.register(t);
  // The post-kit (creative) tools: find_music (read). Pure catalogue reads — no store, nothing of the athlete's.
  for (const t of postKitTools()) registry.register(t);
  // Media: the camera-roll review's one-tap card (CAMERA_ROLL_INTAKE; off ⇒ forSkill leaves it out).
  for (const t of mediaTools(store)) registry.register(t);
  // Deals and bookings in the chat.
  for (const t of dealsTools(opts.deals ?? lazyDeals)) registry.register(t);
  for (const t of bookingsTools(opts.bookings ?? lazyBookings)) registry.register(t);
  // Documents in the chat.
  for (const t of documentsTools(opts.documents ?? lazyDocuments)) registry.register(t);
  // Mila's reads over what Nomila holds (media_search, posts_performance, money_summary, whats_next): MILA_READ_TOOLS.
  for (const t of readTools(opts.reads ?? lazyReads, store)) registry.register(t);
  // The card system v2's producers (MILA_CARDS_V2; off ⇒ forSkill and the pass leave them out): share_insight,
  // ideas_suggest, offer_capability, ask_once, answer_with_sources (agent/milaCards/tools.ts).
  for (const t of milaCardTools(store)) registry.register(t);
  // The landing's Mila-hosted waitlist (MILA_TF_WAITLIST; off ⇒ forSkill and the pass leave them out): waitlist_status,
  // start_research, show_waitlist_card (waitlist/tools.ts; only the waitlist skill lists them).
  for (const t of waitlistTools()) registry.register(t);
  return registry;
}

let _default: ToolRegistry | null = null;
export function defaultRegistry(): ToolRegistry {
  return (_default ??= createDefaultRegistry());
}
