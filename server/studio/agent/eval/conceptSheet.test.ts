/**
 * conceptSheet.test.ts — the concept blind sheet's guards (PR 16, R-9, M6/M7/M8).
 */
import { CONCEPT_CRITERIA, CRITERIA, scoresTemplate } from "./sheet";
import {
  assignConceptCodes,
  distinctShare,
  jaccard,
  renderConceptSheet,
  revealConcepts,
  type RawConceptCell,
} from "./conceptSheet";

const cell = (briefId: string, run: string, model: string): RawConceptCell => ({
  briefId,
  prompt: `a video for ${briefId}`,
  objective: "recap",
  concepts: [
    {
      id: "A",
      angle: "the dawn run",
      feeling: "calm",
      line: "she runs before the city wakes",
    },
    {
      id: "B",
      angle: "the record",
      feeling: "proud",
      line: "the relay record falls at dawn",
    },
  ],
  planned: "A",
  plan: [{ kind: "i2v", beat: "open on her", direction: "she looks up" }],
  source: { run, repeat: 0, model },
});

const RUN = "SECRETRUNLABEL-2026-09-24-0ebb8528a218";
const MODEL = "gemini-9-secret-model";
const raw = [
  "adidas-ad",
  "hype",
  "recap",
  "announce",
  "concept",
  "product-drop",
].map((b, i) => cell(b, i % 2 ? RUN : `${RUN}-b`, MODEL));

describe("the concept sheet is blind", () => {
  const { cells, key } = assignConceptCodes(raw);
  const html = renderConceptSheet(cells);

  it("the concept sheet reveals the run label — it must not", () => {
    expect(html).not.toContain("SECRETRUNLABEL");
    expect(html).not.toContain("0ebb8528a218");
  });

  it("a judge sees the model name — it must not", () => {
    expect(html).not.toContain(MODEL);
  });

  it("the key holds what the sheet does not", () => {
    expect(
      Object.values(key).every(
        (k) => k.run.startsWith("SECRETRUNLABEL") && k.model === MODEL,
      ),
    ).toBe(true);
  });

  it("the concept sheet is shuffled, by a fixed seed — the same cells, the same order, not the input order", () => {
    const again = assignConceptCodes(raw);
    expect(again.cells.map((c) => c.briefId)).toEqual(
      cells.map((c) => c.briefId),
    );
    expect(cells.map((c) => c.briefId)).not.toEqual(raw.map((c) => c.briefId));
    const other = assignConceptCodes(raw, 7);
    expect(other.cells.map((c) => c.briefId)).not.toEqual(
      cells.map((c) => c.briefId),
    );
  });
});

describe("the concept scoresheet and its reveal", () => {
  it("the concept template has the four frozen columns; the plan template is unchanged", () => {
    expect(scoresTemplate(["C01"], CONCEPT_CRITERIA).split("\n")[0]).toBe(
      "code,relevance,groundable,non_generic,distinct,note",
    );
    expect(scoresTemplate(["P01"]).split("\n")[0]).toBe(
      ["code", ...CRITERIA, "note"].join(","),
    );
  });

  it("reveal pools the judge's scores per run", () => {
    const { key } = assignConceptCodes(raw);
    const codes = Object.keys(key);
    const csv = [
      "code,relevance,groundable,non_generic,distinct,note",
      ...codes.map((c) => `${c},4,3,3,5,`),
    ].join("\n");
    const out = revealConcepts({ key, scoresCsv: csv });
    expect(out.map((r) => r.cells).reduce((a, b) => a + b, 0)).toBe(
      codes.length,
    );
    expect(out[0].criteria.relevance.mean).toBe(4);
  });

  it("distinctness's deterministic half: pairs under the 0.5 Jaccard bar", () => {
    expect(
      jaccard(
        "she runs before the city wakes",
        "she runs before the city wakes",
      ),
    ).toBe(1);
    expect(distinctShare([raw[0].concepts])).toEqual({ pairs: 1, under: 1 });
  });
});
