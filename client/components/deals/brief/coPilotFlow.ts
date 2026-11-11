// WS2 · coPilotFlow — the pure state machine behind the composer's co-pilot send.
//
// Dependency-free (no React, no RN, no network) so the propose → preview →
// approve / dismiss transitions are trivially unit-testable and the composer stays
// a thin view over it. Mirrors the money-safety spirit of negotiateLogic: no side
// effects here — the reducer only tracks WHICH phase we're in; the component wires
// the pending_actions mutations to dispatch events.
//
// The one hard rule this encodes: nothing reaches "sent" without passing through
// "preview" (a proposed pending action) and an explicit APPROVE. A send that
// errors on approve is terminal server-side (the row moves to `failed`), so we
// drop back to `compose` — a retry is a fresh proposal, never a re-approve.

// ─── Phases ─────────────────────────────────────────────────────────────────────
//   compose    — editing the draft; the CTA proposes (does NOT send)
//   proposing  — POST /pending-actions in flight (no send)
//   preview    — Mila will send this on your behalf — approve? (shows exact draft)
//   approving  — POST /approve in flight (this is the send)
//   dismissing — POST /dismiss in flight (backing out, no send)
//   sent       — approved + executed; the counter is out
export type CoPilotPhase =
  | "compose"
  | "proposing"
  | "preview"
  | "approving"
  | "dismissing"
  | "sent";

export interface CoPilotState {
  phase:           CoPilotPhase;
  /** The proposed pending-action id — set in `preview`, the thing we approve/dismiss. */
  pendingActionId: string | null;
  /** The EXACT body the proposal will send, echoed back from the created row. */
  previewBody:     string | null;
  /** Last error to surface (propose/approve/dismiss failure). Null when clear. */
  error:           string | null;
  /** The approve failure was a dead connection → prompt a reconnect, not a retry. */
  reauth:          boolean;
}

export const INITIAL_CO_PILOT_STATE: CoPilotState = {
  phase:           "compose",
  pendingActionId: null,
  previewBody:     null,
  error:           null,
  reauth:          false,
};

export type CoPilotEvent =
  | { type: "PROPOSE" }                                   // compose → proposing
  | { type: "PROPOSED"; id: string; body: string }        // proposing → preview
  | { type: "PROPOSE_FAILED"; error: string }             // proposing → compose
  | { type: "APPROVE" }                                   // preview → approving (SENDS)
  | { type: "APPROVED" }                                  // approving → sent
  | { type: "APPROVE_FAILED"; error: string; reauth?: boolean } // approving → compose (row is dead)
  | { type: "DISMISS" }                                   // preview → dismissing
  | { type: "DISMISSED" }                                 // dismissing → compose
  | { type: "DISMISS_FAILED"; error: string }             // dismissing → preview
  | { type: "RESET" };                                    // any → initial (sheet close)

/**
 * Advance the co-pilot flow. Invalid (phase, event) pairs are no-ops — the machine
 * only ever moves along the sanctioned path, so a stray dispatch can't, say, jump
 * straight to `sent` without an approve.
 */
export function coPilotReducer(state: CoPilotState, event: CoPilotEvent): CoPilotState {
  switch (event.type) {
    case "RESET":
      return INITIAL_CO_PILOT_STATE;

    case "PROPOSE":
      if (state.phase !== "compose") return state;
      return { ...state, phase: "proposing", error: null, reauth: false };

    case "PROPOSED":
      if (state.phase !== "proposing") return state;
      return {
        phase:           "preview",
        pendingActionId: event.id,
        previewBody:     event.body,
        error:           null,
        reauth:          false,
      };

    case "PROPOSE_FAILED":
      if (state.phase !== "proposing") return state;
      // Couldn't even create the proposal → back to compose so the caller can fall
      // back (mailto / direct) or the athlete can retry.
      return { ...INITIAL_CO_PILOT_STATE, error: event.error };

    case "APPROVE":
      if (state.phase !== "preview") return state;
      return { ...state, phase: "approving", error: null, reauth: false };

    case "APPROVED":
      if (state.phase !== "approving") return state;
      return { ...state, phase: "sent", error: null, reauth: false };

    case "APPROVE_FAILED":
      if (state.phase !== "approving") return state;
      // The approved row is terminal (`failed`) server-side; it can't be re-approved.
      // Drop to compose with the error — a retry recomposes a fresh proposal.
      return {
        phase:           "compose",
        pendingActionId: null,
        previewBody:     null,
        error:           event.error,
        reauth:          !!event.reauth,
      };

    case "DISMISS":
      if (state.phase !== "preview") return state;
      return { ...state, phase: "dismissing", error: null, reauth: false };

    case "DISMISSED":
      if (state.phase !== "dismissing") return state;
      // Back to compose, proposal discarded.
      return { ...INITIAL_CO_PILOT_STATE };

    case "DISMISS_FAILED":
      if (state.phase !== "dismissing") return state;
      // Couldn't cancel — stay in preview (the proposal still stands) and show why.
      return { ...state, phase: "preview", error: event.error };

    default:
      return state;
  }
}

// ─── Approve-error parsing (pure) ────────────────────────────────────────────────
// `apiRequest` throws `Error("<status>: <body>")` on a non-ok response. An approve
// whose underlying send failed returns the route's JSON ({ error, code?, ... }) at
// a real HTTP status (401 REAUTH, 502, …). Pull a human message + a reauth flag
// out of that thrown error so the composer can surface it.

export interface ParsedSendError {
  message: string;
  reauth:  boolean;
}

const DEFAULT_SEND_ERROR = "Couldn't send your counter. Please try again.";

export function parseApproveError(err: unknown): ParsedSendError {
  const raw = err instanceof Error ? err.message : String(err ?? "");

  let status = 0;
  let bodyText = raw;
  const m = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
  if (m) {
    status = Number(m[1]);
    bodyText = m[2];
  }

  let message = "";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
    if (typeof parsed.code === "string") code = parsed.code;
  } catch {
    // Body wasn't JSON — use the raw text (minus the status prefix) as the message.
    message = bodyText.trim();
  }

  const reauth = code === "REAUTH_REQUIRED" || status === 401;
  return { message: message || DEFAULT_SEND_ERROR, reauth };
}
