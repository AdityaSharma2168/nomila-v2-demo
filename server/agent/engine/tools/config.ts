/**
 * agent/engine/tools/config.ts — the settings Mila's tools need on every engine: the athlete pass and the result budget.
 * Moved here from agent/mcp/config.ts (5 Nov 2026); /mcp itself went with TrueForge (Mastra-only PR 3). The "MCP" left
 * in NOMILA_MCP_PASS_KEY and the pass's audience value "nomila-mcp" is that history (renaming either is a prod change).
 * Getters: env is read at call time, as in agent/config.ts.
 *
 *   NOMILA_MCP_PASS_KEY  the HMAC key that signs and checks the athlete pass (Secret Manager secret of the same name;
 *                        the name is kept for now, a rename is cleanup). Unset or shorter than 32 bytes ⇒ no pass can be
 *                        issued or verified: every tool call is refused (fail closed).
 */

export const PASS_AUDIENCE = "nomila-mcp";
export const PASS_ISSUER = "nomila-api";
/** A pass lives 10 minutes; a long turn gets a fresh pass per turn. */
export const PASS_TTL_SECONDS = 600;
/**
 * A tool result handed back to the model is kept under this many characters (~2,000 tokens). First set for TrueForge's
 * large-response threshold (~6,000 tokens, 10,000 across parallel calls; retired); the same budget as the harness
 * (AGENT_TOOL_RESULT_MAX_CHARS).
 */
export const TOOL_RESULT_MAX_CHARS_DEFAULT = 8000;

/** The pass key, or null when it is unset or too short (fail closed). */
export function passKey(): string | null {
  const k = process.env.NOMILA_MCP_PASS_KEY?.trim();
  return k && Buffer.byteLength(k, "utf8") >= 32 ? k : null;
}
