/**
 * markProvenance.test.ts — which brand marks an interpreted edit asked to bring in or take away, and who
 * asked (the interpreter, I.5; plan v2 N7). Pure: read off the frozen record, never a model.
 */
import type { InterpretationRecord } from "./interpret";
import { markProvenanceFor } from "./markProvenance";

const record = (over: Partial<InterpretationRecord>): InterpretationRecord => ({
  from: "a sentence",
  promptVersion: "interpret/3",
  model: "gemini-3.5-flash",
  outcome: "proposed",
  askReason: null,
  canonical: "a sentence",
  spans: [],
  edits: [],
  constraints: [],
  visibleMarks: [],
  lines: [],
  usage: null,
  costUsd: 0,
  costBasis: "estimated",
  ms: 1,
  memo: false,
  ...over,
});

describe("markProvenanceFor", () => {
  it("reads cell 1a: adidas arrives and Nike leaves, both the brand's", () => {
    const swap = (item: string) => ({
      kind: "brand_swap" as const,
      item,
      descriptors: [],
      brand: "adidas",
      source: "brand" as const,
      reason: { brand: "adidas", away: ["nike"] },
    });
    expect(
      markProvenanceFor(
        record({
          edits: [
            swap("jersey"),
            swap("socks"),
            { kind: "text", content: "OWN THE MOMENT", source: "suggested" },
          ],
          constraints: [
            { kind: "preserve_person", source: "yours" },
            { kind: "exclude_marks", brand: "nike", source: "brand" },
          ],
          visibleMarks: [{ brand: "nike", item: "jersey" }],
        }),
      ),
    ).toEqual({
      arrivals: [{ brand: "adidas", source: "brand" }],
      departures: [{ brand: "nike", source: "brand" }],
    });
  });

  it("credits her own swap with what the model saw on that item — hers first", () => {
    expect(
      markProvenanceFor(
        record({
          edits: [
            {
              kind: "brand_swap",
              item: "jersey",
              descriptors: [],
              brand: "adidas",
              source: "yours",
            },
          ],
          constraints: [
            { kind: "exclude_marks", brand: "nike", source: "brand" },
          ],
          visibleMarks: [
            { brand: "nike", item: "jersey" },
            { brand: "puma", item: "shorts" },
          ],
        }),
      ),
    ).toEqual({
      arrivals: [{ brand: "adidas", source: "yours" }],
      departures: [{ brand: "nike", source: "yours" }],
    });
  });

  it("reads a brand in a design, a worn add and a removal, and her own exclusion", () => {
    expect(
      markProvenanceFor(
        record({
          edits: [
            {
              kind: "design",
              design: "nike swoosh",
              target: "shorts",
              source: "yours",
            },
            {
              kind: "add",
              thing: "adidas cap",
              preposition: "on",
              place: "my head",
              source: "yours",
            },
            { kind: "remove", target: "puma logo", source: "yours" },
          ],
          constraints: [
            { kind: "exclude_marks", brand: "reebok", source: "yours" },
          ],
        }),
      ),
    ).toEqual({
      arrivals: [
        { brand: "nike", source: "yours" },
        { brand: "adidas", source: "yours" },
      ],
      departures: [
        { brand: "puma", source: "yours" },
        { brand: "reebok", source: "yours" },
      ],
    });
  });

  it("has none for a job the interpreter did not propose", () => {
    expect(markProvenanceFor(undefined)).toBeNull();
    expect(
      markProvenanceFor(record({ outcome: "declined", canonical: null })),
    ).toBeNull();
  });
});
