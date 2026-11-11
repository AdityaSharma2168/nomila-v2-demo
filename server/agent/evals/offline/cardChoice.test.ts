/**
 * cardChoice.test.ts — the card-choice eval, offline (CI): #1193's eleven cases (plus two from the 6 Nov dev run) are well formed, every case has a
 * scripted model output, each passes the grader, and the grader rejects the wrong choices the design page warns about.
 * No model, no provider, no database.
 */
jest.mock("../../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("the offline evals never touch the database"); } }) }));

import { CARD_TEXT } from "../../../../shared/milaCards";
import { MILA_TOOL_CARDS } from "../../engine/mastra/display";
import { milaCardTools } from "../../milaCards/tools";
import { createMemoryStore } from "../../research/store";
import { CARD_CHOICE_RECORDED, CARD_EVAL_CASES, CARD_HEADLINE_MAX, CARD_TOOL_CARDS, type CardChoiceOutput } from "./cardChoice.cases";
import { gradeCardChoice } from "./grade";

test("the grader's card table and headline budget are #1193's real ones (the registered card tools)", () => {
  const real = new Set(milaCardTools(createMemoryStore()).map((t) => t.name));
  for (const [tool, cards] of Object.entries(CARD_TOOL_CARDS)) {
    expect([tool, real.has(tool)]).toEqual([tool, true]);
    expect([tool, cards]).toEqual([tool, MILA_TOOL_CARDS[tool as keyof typeof MILA_TOOL_CARDS]]);
  }
  expect(CARD_HEADLINE_MAX).toBe(CARD_TEXT.headline);
});

const byId = (id: string) => CARD_EVAL_CASES.find((c) => c.id === id)!;

test("the design page's eleven cases plus two from the 6 Nov dev run, unique ids, each with a scripted output", () => {
  expect(CARD_EVAL_CASES).toHaveLength(13);
  expect(new Set(CARD_EVAL_CASES.map((c) => c.id)).size).toBe(13);
  expect(Object.keys(CARD_CHOICE_RECORDED).sort()).toEqual(CARD_EVAL_CASES.map((c) => c.id).sort());
});

test.each(CARD_EVAL_CASES.map((c) => [c.id, c] as const))("%s: the expected tool makes the expected card", (_id, c) => {
  if (c.expect.tool === "none") { expect(c.expect.card).toBeNull(); return; }
  expect(CARD_TOOL_CARDS[c.expect.tool]).toContain(c.expect.card);
  expect(c.expect.checks.length).toBeGreaterThan(0);
});

test("every card tool is covered by at least one case, and words-only is too", () => {
  const tools = new Set(CARD_EVAL_CASES.map((c) => c.expect.tool));
  for (const t of [...Object.keys(CARD_TOOL_CARDS), "none"]) expect(tools.has(t as never)).toBe(true);
});

test.each(CARD_EVAL_CASES.map((c) => [c.id, c] as const))("%s: the scripted output passes", (id, c) => {
  expect(gradeCardChoice(c, CARD_CHOICE_RECORDED[id])).toEqual({ pass: true, problems: [] });
});

describe("the grader rejects the wrong choices", () => {
  const fails = (id: string, out: CardChoiceOutput) => {
    const g = gradeCardChoice(byId(id), out);
    expect(g.pass).toBe(false);
    return g.problems;
  };
  it("an insight card when they asked (they get an answer)", () => {
    expect(fails("how-did-reels-do", { calls: [{ tool: "share_insight", card: "insight", headline: "Saves up 96%" }] }))
      .toEqual(["called share_insight, expected answer_with_sources", "made a insight card, expected answer"]);
  });
  it("a card when the web found nothing", () => {
    expect(fails("nothing-found", { calls: [{ tool: "answer_with_sources", card: "answer", headline: "Nothing found" }] })).toHaveLength(1);
  });
  it("a long headline accepted, or refused and never retried", () => {
    const long = "Cobaltwave Hydration appears to be a legitimate and established sports drink company";
    expect(fails("long-headline", { calls: [{ tool: "answer_with_sources", card: "answer", headline: long }] })).toEqual(["headline over 48 characters was accepted"]);
    expect(fails("long-headline", { calls: [{ tool: "answer_with_sources", card: "answer", headline: long, refused: "headline_too_long" }] }))
      .toEqual(["no card was made (expected answer_with_sources)", "a refused card was never retried"]);
  });
  it("no card at all where one was expected; two cards for one answer", () => {
    expect(fails("what-to-post", { calls: [] })).toEqual(["no card was made (expected ideas_suggest)"]);
    const one = CARD_CHOICE_RECORDED["what-to-post"].calls[0];
    expect(fails("what-to-post", { calls: [one, one] })).toEqual(["2 cards for one answer"]);
  });
});
