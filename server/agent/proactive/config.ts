/**
 * agent/proactive/config.ts — the switch for "Mila starts the conversation" (design "Mila on watch", 27 Oct 2026).
 *
 *   MILA_PROACTIVE   app events go to the event log and the dispatcher instead of straight to a fixed-copy push, and
 *                    for the speak-now ones Mila writes the message (on Mastra, as every Mila turn). Only the exact
 *                    string "true" turns it on; it needs no MILA_TF_CHAT or NOMILA_MCP_ENABLED. Guarded in prod
 *                    (scripts/prod-flag-guard.ts GUARDED_FLAGS; pinned by proactiveFlag.test.ts).
 *
 * A getter, so env is read at call time (tests and late env injection rely on that).
 */
export const MILA_PROACTIVE_PROCESS = "mila_proactive";

export function milaProactiveEnabled(): boolean {
  return process.env.MILA_PROACTIVE === "true";
}
