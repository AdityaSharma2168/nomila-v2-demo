import { pickReceipt, receiptActor, receiptLine, isAgreedReceipt, isDisposeReceipt } from "./receipts";
import type { AgentActionRow } from "../../hooks/use-agent-actions";
import { NOT_FOR_ME_REASONS, politeNoAllowed } from "./notForMeLogic";

jest.mock("../../lib/query-client", () => ({ apiRequest: jest.fn() }));

const r = (over: Partial<AgentActionRow>): AgentActionRow => ({
  id: "a", athlete_id: "x", action: "reclassify", deal_id: "d", thread_id: null, reason: null, reversible: true,
  held_until: null, undone_at: null, payload: null, result: null, created_at: "2026-10-12T10:00:00Z", ...over,
});

describe("receipts", () => {
  it("say who did it — her own act is never Nomila's", () => {
    expect(receiptActor(r({ payload: { actor: "athlete" } }))).toBe("You");
    expect(receiptActor(r({ payload: { actor: "mila" } }))).toBe("Mila");
    expect(receiptActor(r({}))).toBe("Nomila");
    expect(receiptLine(r({ action: "reopen", payload: { kind: "deal_agreed", actor: "athlete" } }))).toBe("Marked agreed · by you");
    expect(receiptLine(r({ payload: { actor: "athlete", athlete_label: "not_interested" } }))).toBe("Closed as not interested · by you");
    expect(receiptLine(r({ action: "file" }))).toBe("Set aside · by Nomila");
  });

  it("Undo picks the newest live receipt of that kind", () => {
    const rows = [
      r({ id: "old", payload: { actor: "athlete", athlete_label: "expired" }, created_at: "2026-10-01T00:00:00Z" }),
      r({ id: "new", payload: { actor: "athlete", athlete_label: "not_interested" }, created_at: "2026-10-12T00:00:00Z" }),
      r({ id: "undone", payload: { actor: "athlete", athlete_label: "not_a_deal" }, created_at: "2026-10-13T00:00:00Z", undone_at: "2026-10-13T01:00:00Z" }),
      r({ id: "agreed", action: "reopen", payload: { kind: "deal_agreed", actor: "athlete" } }),
    ];
    expect(pickReceipt(rows, isDisposeReceipt)?.id).toBe("new");
    expect(pickReceipt(rows, isAgreedReceipt)?.id).toBe("agreed");
    expect(pickReceipt([], isAgreedReceipt)).toBeNull();
  });
});

describe("Not for me", () => {
  it("three reasons, each the label the inbox learns from; no polite no to spam", () => {
    expect(NOT_FOR_ME_REASONS.map((x) => x.key)).toEqual(["not_interested", "not_a_deal", "expired"]);
    expect(politeNoAllowed("not_a_deal")).toBe(false);
    expect(politeNoAllowed("not_interested")).toBe(true);
    expect(politeNoAllowed("expired")).toBe(true);
  });
});
