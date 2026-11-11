/**
 * withoutRetiredCards — what every served kit loses (legacy retirement, phases 1 + 2). Pure; nothing reaches a model.
 */
jest.mock("../db", () => ({ db: {} })); // pure function under test: no database needed (a lazy PGlite boot outlived the suite in CI)
jest.mock("../lib/models", () => ({
  genai: () => ({ models: { generateContent: async () => { throw new Error("tests must never reach a provider"); } } }),
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

import { withoutRetiredCards } from "./kitCache";

const kit = (cards: any[], identity: any = { name: "A", sport: "s", school: "", hook: "" }) =>
  ({ athleteId: "a", identity, tokens: { theme: "campaign", accent: "#000" }, cards, deck: cards.map((c) => c.id), meta: { generatedAt: "", overallConfidence: 1 } }) as any;

it("keeps an M.I.A. index card and drops the legacy one, the mix card and the rate cards", () => {
  const out = withoutRetiredCards(kit([
    { id: "cover", type: "cover" },
    { id: "mia", type: "index", value: 612, max: 850, scale: "mia", verdict: "v" },
    { id: "legacy", type: "index", value: 691, max: 850, tierDisplay: "Established", rings: {}, verdict: "v" },
    { id: "mix", type: "mix" },
    { id: "rates", type: "rates" },
    { id: "payments", type: "payments" },
  ]));
  expect(out.cards.map((c: any) => c.id)).toEqual(["cover", "mia"]);
  expect(out.deck).toEqual(["cover", "mia"]);
});

it("strips the legacy tier word off a cached identity", () => {
  const out = withoutRetiredCards(kit([{ id: "cover", type: "cover" }], { name: "A", sport: "s", school: "", tier: "Elite", tierDisplay: "Elite", hook: "" }));
  expect(out.identity).toEqual({ name: "A", sport: "s", school: "", hook: "" });
});

it("returns a clean kit as is", () => {
  const k = kit([{ id: "cover", type: "cover" }, { id: "mia", type: "index", scale: "mia" }]);
  expect(withoutRetiredCards(k)).toBe(k);
});
