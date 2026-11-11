/**
 * statusLabels.test.ts — the tool → phrase map + the default fallback. Kept
 * fully pure (no registry/db import): the coverage guard checks a hand-kept
 * list of the current tool names, so it can't pull the tool graph into a
 * presentational unit test.
 */

import { statusForCalls, TOOL_STATUS, DEFAULT_STATUS } from "./statusLabels";

// The registry's tool names (server/mila/registry.ts). Hand-kept so this test
// stays pure; if a tool is added there without a phrase here, this list should
// grow too and the coverage test below flags the gap.
const REGISTERED_TOOL_NAMES = [
  "get_score",
  "get_profile",
  "list_deals",
  "get_deal",
  "get_rate_card",
  "list_tasks_threads",
  "get_analytics",
  "draft_reply",
  "navigate",
  "get_help",
  "get_brand",
  "get_brand_fit",
];

describe("statusForCalls", () => {
  it("returns the mapped phrase for a known single tool", () => {
    expect(statusForCalls(["list_deals"])).toBe("Pulling up your deals…");
    expect(statusForCalls(["get_score"])).toBe("Checking your score…");
    expect(statusForCalls(["get_brand_fit"])).toBe("Sizing up the fit…");
    expect(statusForCalls(["draft_reply"])).toBe("Drafting your reply…");
  });

  it("falls back to DEFAULT_STATUS for an unmapped tool", () => {
    expect(statusForCalls(["totally_unknown_tool"])).toBe(DEFAULT_STATUS);
  });

  it("falls back to DEFAULT_STATUS for a no-tool round (empty array)", () => {
    expect(statusForCalls([])).toBe(DEFAULT_STATUS);
    expect(DEFAULT_STATUS).toBe("Thinking…");
  });

  it("uses the first MAPPED tool when a round mixes mapped + unmapped", () => {
    // An unmapped tool leading the batch must not blank out a describable round.
    expect(statusForCalls(["mystery", "list_deals"])).toBe(
      "Pulling up your deals…",
    );
    // First mapped wins when several are mapped.
    expect(statusForCalls(["get_profile", "get_score"])).toBe(
      "Looking at your profile…",
    );
  });

  it("has a mapped phrase for every registered Mila tool", () => {
    // Keeps the map from drifting out of sync as tools are added — a new tool
    // without a phrase is caught here rather than silently showing "Thinking…".
    for (const name of REGISTERED_TOOL_NAMES) {
      expect(TOOL_STATUS[name]).toBeDefined();
    }
  });

  it("every phrase is a non-empty, trailing-ellipsis string", () => {
    for (const phrase of Object.values(TOOL_STATUS)) {
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase.endsWith("…")).toBe(true);
    }
    expect(DEFAULT_STATUS.endsWith("…")).toBe(true);
  });
});
