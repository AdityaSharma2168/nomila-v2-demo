/**
 * coPilotFlow — pure state-machine unit tests (no React, no RN, no network).
 * Covers the composer's co-pilot send flow:
 *   - propose → preview → approve (the only path that reaches "sent")
 *   - dismiss backs out of preview → compose
 *   - a failed approve is terminal → drop to compose (retry = fresh proposal)
 *   - invalid transitions are no-ops (can't jump to "sent" without an approve)
 *   - approve-error parsing (REAUTH flag, human message)
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/brief
 */

import {
  coPilotReducer,
  INITIAL_CO_PILOT_STATE,
  parseApproveError,
  type CoPilotState,
} from "./coPilotFlow";

// Small helper: run a sequence of events from the initial state.
function run(events: Parameters<typeof coPilotReducer>[1][]): CoPilotState {
  return events.reduce(coPilotReducer, INITIAL_CO_PILOT_STATE);
}

describe("coPilotReducer — the happy path", () => {
  it("propose → preview → approve → sent", () => {
    const proposing = coPilotReducer(INITIAL_CO_PILOT_STATE, { type: "PROPOSE" });
    expect(proposing.phase).toBe("proposing");

    const preview = coPilotReducer(proposing, { type: "PROPOSED", id: "pa_1", body: "Counter at $850." });
    expect(preview).toEqual({
      phase: "preview",
      pendingActionId: "pa_1",
      previewBody: "Counter at $850.",
      error: null,
      reauth: false,
    });

    const approving = coPilotReducer(preview, { type: "APPROVE" });
    expect(approving.phase).toBe("approving");
    // The proposal id is still around while the send is in flight.
    expect(approving.pendingActionId).toBe("pa_1");

    const sent = coPilotReducer(approving, { type: "APPROVED" });
    expect(sent.phase).toBe("sent");
  });
});

describe("coPilotReducer — dismiss backs out", () => {
  it("preview → dismissing → compose (proposal discarded)", () => {
    const preview = run([{ type: "PROPOSE" }, { type: "PROPOSED", id: "pa_1", body: "draft" }]);
    const dismissing = coPilotReducer(preview, { type: "DISMISS" });
    expect(dismissing.phase).toBe("dismissing");

    const back = coPilotReducer(dismissing, { type: "DISMISSED" });
    expect(back).toEqual(INITIAL_CO_PILOT_STATE);
  });

  it("a failed dismiss stays in preview with the error (proposal still stands)", () => {
    const dismissing = run([
      { type: "PROPOSE" },
      { type: "PROPOSED", id: "pa_1", body: "draft" },
      { type: "DISMISS" },
    ]);
    const stillPreview = coPilotReducer(dismissing, { type: "DISMISS_FAILED", error: "network" });
    expect(stillPreview.phase).toBe("preview");
    expect(stillPreview.pendingActionId).toBe("pa_1");
    expect(stillPreview.error).toBe("network");
  });
});

describe("coPilotReducer — failures", () => {
  it("a failed proposal drops back to compose with the error", () => {
    const failed = run([{ type: "PROPOSE" }, { type: "PROPOSE_FAILED", error: "No thread" }]);
    expect(failed.phase).toBe("compose");
    expect(failed.pendingActionId).toBeNull();
    expect(failed.error).toBe("No thread");
  });

  it("a failed approve is terminal → compose, id cleared (retry = fresh proposal)", () => {
    const approving = run([
      { type: "PROPOSE" },
      { type: "PROPOSED", id: "pa_1", body: "draft" },
      { type: "APPROVE" },
    ]);
    const failed = coPilotReducer(approving, {
      type: "APPROVE_FAILED",
      error: "Your Gmail connection has expired.",
      reauth: true,
    });
    expect(failed.phase).toBe("compose");
    expect(failed.pendingActionId).toBeNull();   // the row is dead server-side
    expect(failed.previewBody).toBeNull();
    expect(failed.error).toBe("Your Gmail connection has expired.");
    expect(failed.reauth).toBe(true);
  });
});

describe("coPilotReducer — invalid transitions are no-ops", () => {
  it("cannot approve from compose (never sends without a proposal)", () => {
    const s = coPilotReducer(INITIAL_CO_PILOT_STATE, { type: "APPROVE" });
    expect(s).toBe(INITIAL_CO_PILOT_STATE);
  });

  it("cannot reach sent without going through approving", () => {
    const preview = run([{ type: "PROPOSE" }, { type: "PROPOSED", id: "pa_1", body: "d" }]);
    // APPROVED only applies while approving; from preview it's ignored.
    expect(coPilotReducer(preview, { type: "APPROVED" })).toBe(preview);
  });

  it("a stray PROPOSED while already in preview is ignored", () => {
    const preview = run([{ type: "PROPOSE" }, { type: "PROPOSED", id: "pa_1", body: "d" }]);
    const s = coPilotReducer(preview, { type: "PROPOSED", id: "pa_2", body: "other" });
    expect(s).toBe(preview);
  });

  it("RESET returns to the initial state from anywhere", () => {
    const approving = run([
      { type: "PROPOSE" },
      { type: "PROPOSED", id: "pa_1", body: "d" },
      { type: "APPROVE" },
    ]);
    expect(coPilotReducer(approving, { type: "RESET" })).toEqual(INITIAL_CO_PILOT_STATE);
  });
});

describe("parseApproveError", () => {
  it("extracts the REAUTH code from an apiRequest-style thrown error", () => {
    const err = new Error(
      `401: ${JSON.stringify({ error: "Your Gmail connection has expired.", code: "REAUTH_REQUIRED" })}`,
    );
    const parsed = parseApproveError(err);
    expect(parsed.reauth).toBe(true);
    expect(parsed.message).toBe("Your Gmail connection has expired.");
  });

  it("flags reauth on a bare 401 even without an explicit code", () => {
    const err = new Error(`401: ${JSON.stringify({ error: "unauthorized" })}`);
    expect(parseApproveError(err).reauth).toBe(true);
  });

  it("surfaces a non-reauth send failure message (e.g. 502)", () => {
    const err = new Error(`502: ${JSON.stringify({ error: "Couldn't send your reply. Please try again." })}`);
    const parsed = parseApproveError(err);
    expect(parsed.reauth).toBe(false);
    expect(parsed.message).toBe("Couldn't send your reply. Please try again.");
  });

  it("falls back to a default message when the body isn't JSON", () => {
    const parsed = parseApproveError(new Error("500: Internal Server Error"));
    expect(parsed.message).toBe("500: Internal Server Error".replace(/^\d{3}:\s*/, ""));
    expect(parsed.reauth).toBe(false);
  });

  it("handles a non-Error throw", () => {
    const parsed = parseApproveError("boom");
    expect(parsed.message).toBeTruthy();
    expect(parsed.reauth).toBe(false);
  });
});
