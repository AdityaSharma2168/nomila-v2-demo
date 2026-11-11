/**
 * successReview.test.ts — Slice 3 A (slice3-a-design.md), pure: when her success line is awaiting her after a
 * rewrite, what answers it, and that the Brain is not shown an awaiting line while nothing else in its view changes.
 */
import { describe, expect, it } from "@jest/globals";
import type { Objective, ObjectiveEvent } from "../contracts/objectiveEntity";
import { renderObjectivesBlock, SUCCESS_AWAITING_LINE } from "../brain/inputBlock";
import { successReview } from "./successReview";
import { OBJECTIVE_CHANGE_ASSESSMENT_VERSION as V } from "./changeAssessment";

const OLD_LINE = "She has signed an EdTech partnership.";
const W1 = "Build my positioning across technology, AI and entrepreneurship.";
const obj = (wording: string, modified = true): Objective => ({
  id: "q", athleteId: "a", version: "objective/1.1.0", domain: "positioning", desiredState: { value: wording } as any, currentState: null,
  provenance: { origin: "joint" } as any, success: { observableCondition: OLD_LINE }, horizon: null, confidence: "HIGH",
  disposition: modified ? "modified" : "accepted", lifecycle: "active", createdAt: "2026-09-01T00:00:00Z",
  ...(modified ? { modifiedFrom: { desiredState: "Nomila's line.", at: "2026-09-02T00:00:00Z" } } : {}),
} as any);

let t = 0;
const ev = (action: ObjectiveEvent["action"], delta: any): ObjectiveEvent => ({ id: `e${++t}`, objectiveId: "q", athleteId: "a", at: `2026-09-0${Math.min(9, t)}T00:00:${String(t).padStart(2, "0")}Z`, actor: action === "change_assessed" ? { userId: null, role: "system" } : { userId: "u", role: "athlete" }, action, said: null, delta });
const edit = (to: string, success?: string) => ev("modify", { desiredState: { from: "prev", to }, ...(success ? { success: { from: OLD_LINE, to: success } } : {}) });
const assessed = (wording: string, verdict: "fits" | "needs_review", extra: any = {}) => ev("change_assessed", { changeAssessment: {
  version: V, modifyEventId: null, wording, previousWording: "prev", previousWasOriginal: false, openings: [], ...extra,
  result: { status: "assessed", version: V, by: "model", model: "m", promptSha256: "p", assessment: { success: { verdict, reason: "narrower", objectiveQuote: "AI", successQuote: "EdTech" }, openings: [] } } } });
const failed = (wording: string) => ev("change_assessed", { changeAssessment: { version: V, modifyEventId: null, wording, previousWording: "prev", previousWasOriginal: false, openings: [], result: { status: "unassessed", version: V, reason: "timed out" } } });
const typo = (wording: string, previousWording: string, previousWasOriginal: boolean) => ev("change_assessed", { changeAssessment: { version: V, modifyEventId: null, wording, previousWording, previousWasOriginal, openings: [], result: { status: "assessed", version: V, by: "rule", carriesForward: true, because: "typo" } } });
const kept = (forWording: string) => ev("success_confirmed", { successConfirmed: { condition: OLD_LINE, forWording } });

describe("awaiting her (derived, never stored)", () => {
  it("never for an Objective whose wording she has not changed", () => {
    expect(successReview(obj("As proposed.", false), [])).toBeNull();
  });
  it("awaiting when the assessment of her current wording says needs_review, failed, or does not exist (her legacy edits)", () => {
    expect(successReview(obj(W1), [edit(W1), assessed(W1, "needs_review")])).toEqual({ reason: "needs_review", why: "narrower", objectiveQuote: "AI", successQuote: "EdTech" });
    expect(successReview(obj(W1), [edit(W1), failed(W1)])).toEqual({ reason: "unassessed" });
    expect(successReview(obj(W1), [edit(W1)])).toEqual({ reason: "not_assessed" });
  });
  it("not awaiting when the line still fits", () => {
    expect(successReview(obj(W1), [edit(W1), assessed(W1, "fits")])).toBeNull();
  });
  it("her answer for the current wording clears it — a new line, or keeping the line", () => {
    expect(successReview(obj(W1), [edit(W1), assessed(W1, "needs_review"), ev("modify", { success: { from: OLD_LINE, to: "Mine." } })])).toBeNull();
    expect(successReview(obj(W1), [edit(W1), assessed(W1, "needs_review"), kept(W1)])).toBeNull();
  });
  it("a line supplied in the same edit as new wording is her answer for that wording", () => {
    expect(successReview(obj(W1), [edit(W1, "She has what she now wants."), assessed(W1, "needs_review")])).toBeNull();
  });
  it("an answer for an earlier wording does not carry to a new rewrite", () => {
    const W2 = "A different goal of hers.";
    expect(successReview(obj(W2), [edit(W1), kept(W1), edit(W2)])).toEqual({ reason: "not_assessed" });
  });
  it("a typo edit carries forward the state of the wording it corrected", () => {
    expect(successReview(obj("Grow my audience."), [edit("Grow my audience."), typo("Grow my audience.", "Grow my audiance.", true)])).toBeNull();
    const W1t = W1 + " ";
    expect(successReview(obj(W1t), [edit(W1), assessed(W1, "needs_review"), edit(W1t), typo(W1t, W1, false)])!.reason).toBe("needs_review");
    expect(successReview(obj(W1t), [edit(W1), assessed(W1, "needs_review"), kept(W1), edit(W1t), typo(W1t, W1, false)])).toBeNull();
  });
});

describe("the Brain does not see a line that is awaiting her", () => {
  const P = obj("As proposed.", false);
  const Q = obj(W1);
  it("the awaiting line replaces the old text, and exactly that line changes", () => {
    const shown = renderObjectivesBlock([Q], [], []);
    const withheld = renderObjectivesBlock([Q], [], [], new Set(), new Set(["q"]));
    expect(withheld).not.toContain(OLD_LINE);
    expect(withheld).toContain(`        how anyone would know: ${SUCCESS_AWAITING_LINE}`);
    const a = shown.split("\n"), b = withheld.split("\n");
    expect(a.length).toBe(b.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual([`        how anyone would know: ${OLD_LINE}`]);
  });
  it("nothing awaiting renders byte-identically", () => {
    expect(renderObjectivesBlock([P, Q], [], [], new Set(), new Set())).toBe(renderObjectivesBlock([P, Q], [], []));
  });
});
