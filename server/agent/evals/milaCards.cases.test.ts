/**
 * milaCards.cases.test.ts — the card-choice eval cases are well formed (offline: no model, no provider). The paid run
 * is scripts/run-card-eval.ts, by hand only.
 */
import { MILA_TOOL_CARDS } from "../engine/mastra/display";
import { CARD_EVAL_CASES } from "./milaCards.cases";

jest.mock("../../db", () => ({ db: {} }));

test("the design page's eleven cases, unique ids", () => {
  expect(CARD_EVAL_CASES).toHaveLength(11);
  expect(new Set(CARD_EVAL_CASES.map((c) => c.id)).size).toBe(11);
});

test.each(CARD_EVAL_CASES.map((c) => [c.id, c]))("%s: the expected tool makes the expected card", (_id, c) => {
  if (c.expect.tool === "none") { expect(c.expect.card).toBeNull(); return; }
  expect(MILA_TOOL_CARDS[c.expect.tool]).toContain(c.expect.card);
  expect(c.expect.checks.length).toBeGreaterThan(0);
});

test("every producer is covered by at least one case", () => {
  const tools = new Set(CARD_EVAL_CASES.map((c) => c.expect.tool));
  for (const t of ["share_insight", "ideas_suggest", "offer_capability", "ask_once", "answer_with_sources", "none"]) expect(tools.has(t as never)).toBe(true);
});
