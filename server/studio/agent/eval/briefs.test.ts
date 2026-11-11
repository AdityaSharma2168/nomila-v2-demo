/**
 * briefs.test.ts — the fixture's own shape. Not the planner: no model, no library.
 */
import { EVAL_BRIEFS, briefById } from "./briefs";
import { CRITERIA } from "./sheet";

const OBJECTIVES = [
  "announce",
  "showcase-product",
  "grow-following",
  "concept",
  "recap",
  "thank-partner",
];

describe("the brief set", () => {
  it("has thirteen briefs with unique, stable ids", () => {
    // Eleven from the doctrine eval, plus the acceptance pair (briefs 12 and 13, C3 doctrine 2).
    expect(EVAL_BRIEFS).toHaveLength(13);
    expect(new Set(EVAL_BRIEFS.map((b) => b.id)).size).toBe(13);
    expect(briefById("adidas-ad")?.objective).toBe("showcase-product");
  });

  it("uses only the objectives the Agent tab offers, and every one of them at least once", () => {
    for (const b of EVAL_BRIEFS) expect(OBJECTIVES).toContain(b.objective);
    for (const o of OBJECTIVES)
      expect(EVAL_BRIEFS.some((b) => b.objective === o)).toBe(true);
  });

  it("covers both ends of the mix — at least two briefs that should come back mostly real, two mostly generated", () => {
    expect(
      EVAL_BRIEFS.filter((b) => b.lean === "real").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      EVAL_BRIEFS.filter((b) => b.lean === "generated").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("names, in every expectation, a criterion the scoresheet scores — or provenance, which the metrics count", () => {
    const names = [...CRITERIA, "provenance"];
    for (const b of EVAL_BRIEFS) {
      expect(b.expect.length).toBeGreaterThan(0);
      for (const e of b.expect) {
        const head = e.split(":")[0];
        expect(names).toContain(head);
      }
    }
  });

  it("keeps the sentences within the form's own limits, and carries no asset id", () => {
    for (const b of EVAL_BRIEFS) {
      expect(b.prompt.length).toBeLessThanOrEqual(2000);
      expect(b.aesthetic?.length ?? 0).toBeLessThanOrEqual(200);
      expect(b.prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });
});
