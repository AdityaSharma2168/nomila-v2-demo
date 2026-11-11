/**
 * agent/documents/config.ts — Mila's documents tools: their limits and one flag. The documents_* tools themselves are
 * always in the chat (AGENT_DOCUMENTS_TOOLS was retired on 2 Nov 2026). Only the exact string "true" turns the flag on;
 * read at call time, so a flip needs no restart.
 *
 *   AGENT_DOCUMENTS_CARD   send the proposed `document` card instead of the `ready` card the app already draws. Off
 *                          everywhere until the owner approves the card's design (no client draws it yet).
 *
 * The public page also needs PUBLIC_CARD: a tool on a switched-off document answers feature_off, never a silent empty.
 * (The brand book and the engine are always on: BRAND_BOOK_V1 and NOMI_ENGINE_V1 were retired on 2 Nov 2026.)
 */
export const agentDocumentsCardEnabled = (): boolean => process.env.AGENT_DOCUMENTS_CARD === "true";

/** The workflow process that builds a document in the background and comes back to the chat (workflow.ts). */
export const DOCUMENT_BUILD_PROCESS = "document_build";

/** At most this many document builds start per athlete in any 24 hours (each pitch is ~$0.20 of model work). */
export const DOCUMENT_BUILDS_PER_DAY = 6;
