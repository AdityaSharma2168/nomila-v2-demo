import { describe, expect, it, jest } from "@jest/globals";
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
import { proofStats } from "./mediaKitService";
import { normalizeBeats } from "./narrator";

describe("proofStats — measured numbers only", () => {
  it("reach, views and engagement from connected channels; engagement is stored as a percentage", () => {
    const s = proofStats([
      { platform: "instagram", followers: 21700, avgEngagementRate: 5.2, avgReachPerPost: 12546, avgViewsPerPost: null },
      { platform: "tiktok", followers: 15400, avgEngagementRate: 11.95, avgReachPerPost: null, avgViewsPerPost: 78662 },
    ]);
    expect(s).toEqual([
      { value: expect.any(String), label: "Instagram reach per post" },
      { value: expect.any(String), label: "TikTok views per post" },
      { value: "12%", label: "TikTok engagement" },
    ]);
  });
  it("nothing measured → no block (never a made-up number)", () => {
    expect(proofStats([{ platform: "instagram", followers: null, avgEngagementRate: null, avgReachPerPost: null, avgViewsPerPost: null }])).toEqual([]);
  });
});

describe("normalizeBeats", () => {
  it("keeps only complete sets with the right count, one string per option", () => {
    const out = normalizeBeats({ cards: [{ card: "record", tagline: [], beats: [["a", "b"], ["only one"], "not a set"] as any }] }, [{ card: "record", label: "", factsShown: [], slots: ["beats"], count: 2, intent: "" }]);
    expect(out.cards[0].beats).toEqual(["a\nb"]);
  });
});
