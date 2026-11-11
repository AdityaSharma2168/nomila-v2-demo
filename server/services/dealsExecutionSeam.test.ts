/**
 * dealsExecutionSeam.test.ts — what crosses from a Recommendation into Deals, and what never does.
 */
import { describe, expect, it } from "@jest/globals";
import { INTENT_TO_REPLY, dealsDraftRequestFrom, executionIntentFrom, pendingActionProposalFrom, seamCarriesNoAmount } from "./dealsExecutionSeam";
import type { RecommendationRecord } from "./intelligence/brain/recommendation";

const rec = (over: Partial<RecommendationRecord["value"]> = {}, subject = { kind: "deal", id: "d-1" } as RecommendationRecord["subject"]): RecommendationRecord => ({
  version: "recommendation/0.2.0-exp", id: "rec_1", key: "k", source: "her agent, through Mila", subject, question: "q", objectiveIds: ["o-1"],
  value: { what: "Counter the term sheet.", why: "The offer is USD 5,000 and her recorded floor is USD 1,000, unit not established.", cites: [{ ref: "deal[d-1].band", how: "b" }, { ref: "deal[d-1].absent", how: "a" }, { ref: "deal[d-1].unknown", how: "u" }, { ref: "constraints[adidas]", how: "c" }], executionPath: "direct_action", relationToExistingWork: "new_work", advances: null, notSeen: ["usage rights duration"], intent: "counter", ...over, ends: over.ends ?? null },
  versions: { spec: "s", runId: "r", runAt: "t" }, runs: ["r"], response: { state: "none", at: null, actor: null }, authorization: { state: "none", at: null, actor: null }, execution: { state: "none", refs: [] }, outcome: null, supersededBy: null, reconsiders: null, closed: false, events: [],
});

describe("RECOMMEND → direct_action → Deals seam (experimental)", () => {
  it("carries the subject unchanged, the typed intent, considerations and constraints — and no amount", () => {
    const i = executionIntentFrom(rec());
    expect(i.subject).toBe("deal[d-1]"); expect(i.dealId).toBe("d-1"); expect(i.intent).toBe("counter");
    expect(i.considerations).toEqual(["deal[d-1].absent", "deal[d-1].unknown", "not seen: usage rights duration"]);
    expect(i.constraints).toEqual(["constraints[adidas]"]);
    expect(seamCarriesNoAmount(i)).toBe(true);
    expect(JSON.stringify({ ...i, why: "" })).not.toMatch(/USD|\$\d/); // the figures in `why` are the Brain's cited evidence for Mila, not an instruction
  });
  it("maps onto Deals' existing draft route inputs; `wait` produces no draft; the map is total", () => {
    expect(Object.keys(INTENT_TO_REPLY).sort()).toEqual(["accept", "ask_terms", "counter", "decline", "wait"]);
    const d = dealsDraftRequestFrom(executionIntentFrom(rec()))!;
    expect(d.route).toBe("POST /api/v1/me/deals/d-1/draft");
    expect(d.body).toEqual({ reply_intent: "negotiate", selected_terms: ["deal[d-1].absent", "deal[d-1].unknown"], style: "friendly", voice: "athlete", include_media_kit: false });
    expect(dealsDraftRequestFrom(executionIntentFrom(rec({ intent: "ask_terms" })))!.body.reply_intent).toBe("request_terms");
    expect(dealsDraftRequestFrom(executionIntentFrom(rec({ intent: "accept" })))!.body.selected_terms).toEqual([]);
    expect(dealsDraftRequestFrom(executionIntentFrom(rec({ intent: "wait" })))).toBeNull();
  });
  it("lineage rides in the pending action's free payload — no column", () => {
    const p = pendingActionProposalFrom(executionIntentFrom(rec()), "Hi — thanks for the offer…");
    expect(p.route).toBe("POST /api/v1/me/deals/d-1/pending-actions");
    expect(p.body).toEqual({ kind: "send_reply", payload: { body: "Hi — thanks for the offer…", recommendation_id: "rec_1", subject: "deal[d-1]" } });
  });
  it("refuses a non-direct action, a non-deal subject, and a commercial RECOMMEND without a typed intent", () => {
    expect(() => executionIntentFrom(rec({ executionPath: "campaign" }))).toThrow("not a direct action");
    expect(() => executionIntentFrom(rec({}, { kind: "brand", id: "7" }))).toThrow("not a deal subject");
    expect(() => executionIntentFrom(rec({ intent: null }))).toThrow("does not reinterpret prose");
  });
});
