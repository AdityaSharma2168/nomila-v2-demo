/**
 * config.textPrice.test.ts — the planner's price is on the registry (PR 4, C5), priced per call.
 */
import { textCallUsd, textPriceFor } from "./config";

afterEach(() => {
  delete process.env.STUDIO_TEXT_PRICE_JSON;
});

describe("textCallUsd — gemini-3.1-pro-preview at the published rate, per call", () => {
  it("carries the published rate and says where it was read", () => {
    expect(textPriceFor("gemini-3.1-pro-preview")).toMatchObject({
      usdPerMInput: 2,
      usdPerMOutput: 12,
      longAbove: 200_000,
    });
    expect(textPriceFor("gemini-3.1-pro-preview")!.source).toMatch(
      /^https:\/\/ai\.google\.dev\/gemini-api\/docs\/pricing/,
    );
  });

  it("the after-S1b run's mean call (84,219 in / 79,779 out over 15 calls, 22 Sep 2026) costs $0.0751 — not the assumed rate's $0.0602", () => {
    expect(
      textCallUsd("gemini-3.1-pro-preview", {
        inputTokens: 5_615,
        outputTokens: 5_319,
      }),
    ).toBeCloseTo(0.075058, 6);
  });

  /** ⚠️ MUTATION: ignore the long tier — this reds by name. */
  it("a prompt past 200k bills the long tier for the whole call", () => {
    expect(
      textCallUsd("gemini-3.1-pro-preview", {
        inputTokens: 200_001,
        outputTokens: 1_000,
      }),
    ).toBeCloseTo((200_001 * 4 + 1_000 * 18) / 1e6, 6);
    expect(
      textCallUsd("gemini-3.1-pro-preview", {
        inputTokens: 200_000,
        outputTokens: 1_000,
      }),
    ).toBeCloseTo((200_000 * 2 + 1_000 * 12) / 1e6, 6);
  });

  it("an unknown model is unpriced — null, never a guess — and the override merges over the table", () => {
    expect(
      textCallUsd("some-other-model", { inputTokens: 1, outputTokens: 1 }),
    ).toBeNull();
    process.env.STUDIO_TEXT_PRICE_JSON = JSON.stringify({
      "some-other-model": { usdPerMInput: 1, usdPerMOutput: 1, source: "test" },
    });
    expect(
      textCallUsd("some-other-model", {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(1);
    process.env.STUDIO_TEXT_PRICE_JSON = "{not json";
    expect(textPriceFor("gemini-3.1-pro-preview")?.usdPerMInput).toBe(2);
  });
});
