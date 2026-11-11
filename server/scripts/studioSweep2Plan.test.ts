/**
 * studioSweep2Plan.test.ts — sweep #2's list covers what PR N (N.4) asked for, and its estimate is
 * the price table's own sum. Pure: the plan does no I/O.
 *
 * The coverage checks are HAND-WRITTEN expectations rather than loops over the plan, for the
 * runbook's reason: a test that iterates the list it protects goes green when an entry is deleted.
 */
import {
  SWEEP2_CELLS,
  SWEEP2_SOURCES,
  classifyCell,
  quoteFor,
  sweep2Estimate,
  type SourceKey,
} from "./studioSweep2Plan";

const cell = (id: string) => {
  const c = SWEEP2_CELLS.find((x) => x.id === id);
  if (!c) throw new Error(`no cell ${id}`);
  return c;
};

describe("sweep #2 covers what N.4 asked for", () => {
  it("reruns every sweep #1 section 1–5 prompt on its ORIGINAL source", () => {
    // Sweep #1's own table (studio-sweep-results.md), prompt and `src` column — written out.
    const sweep1: [string, SourceKey, string][] = [
      ["1.1", "small", "change the color of the jersey to purple"],
      ["1.2", "halo", "make the sports bra white"],
      ["1.3a", "small", "change the socks to yellow"],
      ["1.3b", "large", "change the socks to yellow"],
      ["1.4", "small", "make the cleats black"],
      ["1.5a-r1", "jacket", "make the jacket pink"],
      ["1.5b", "jacket", "recolor the jacket to be black"],
      ["2.1", "small", "put a number 10 on the jersey"],
      ["2.2", "small", "add a nike swoosh to the shorts"],
      ["2.3", "small", "put a sponsor patch on the sleeve"],
      ["2.4a", "mint", "add an adidas logo to the jersey"],
      ["2.4b", "small", "add an adidas logo to the jersey"],
      ["3.1", "small", "make the jersey red and the shorts black"],
      ["3.2", "small", "change my jersey to blue and add an adidas logo"],
      ["4.1", "small", "put me in a packed stadium"],
      ["4.2", "halo", "change the background to a beach at sunset"],
      ["4.3", "large", "change the background to a plain studio backdrop"],
      ["5.1", "halo", "remove the ball"],
      ["5.2", "halo", "change the ball to a black one"],
    ];
    for (const [id, source, sentence] of sweep1) {
      expect({
        id,
        source: cell(id).source,
        sentence: cell(id).sentence,
      }).toEqual({ id, source, sentence });
    }
  });

  it("runs the jacket — the variance and identity cell — at n=2", () => {
    expect([cell("1.5a-r1").sentence, cell("1.5a-r2").sentence]).toEqual([
      "make the jacket pink",
      "make the jacket pink",
    ]);
  });

  it("runs a multi-part recolour at n=2 where BOTH garments change, as one step with two targets", () => {
    for (const id of ["multi-r1", "multi-r2"]) {
      expect(cell(id).source).toBe("small");
      expect(classifyCell(cell(id)).steps).toEqual([
        {
          op: "RECOLOR",
          targets: ["jersey", "socks"],
          value: "white",
          scope: "REGION",
          // ⚠️ AND SINCE CARD 2, THE COLOUR SHE GAVE EACH GARMENT (wave D, #511). `value` is rule 5's
          // `firstMatch` over the whole sentence — "white" for BOTH targets — which is exactly what
          // this cell was built to render and exactly what it rendered wrongly: the socks came back
          // white too. `values` is the pairing read off her own sentence, so the sweep now plans the
          // yellow socks she asked for. Still ONE step with two targets, which is what this test is
          // named for; the step's shape did not move.
          values: ["white", "yellow"],
        },
      ]);
    }
    // Not sweep 3.1's sentence, whose shorts are already black on this frame.
    expect(cell("multi-r1").sentence).not.toBe(cell("3.1").sentence);
  });

  it("stages 3.2 as a gate cell — the classifier ASKs, so it must block and spend nothing", () => {
    expect(cell("3.2").kind).toBe("expect-block");
    expect(classifyCell(cell("3.2")).initialPath).toBe("ASK");
    expect(quoteFor(cell("3.2")).quotedUsd).toBe(0);
  });

  it("puts every background prompt on BOTH 4000px sources", () => {
    const on = (sentence: string) =>
      SWEEP2_CELLS.filter((c) => c.sentence === sentence)
        .map((c) => c.source)
        .sort();
    expect(on("put me in a packed stadium")).toEqual([
      "halo",
      "large",
      "small",
    ]);
    expect(on("change the background to a beach at sunset")).toEqual([
      "halo",
      "large",
    ]);
    expect(on("change the background to a plain studio backdrop")).toEqual([
      "halo",
      "large",
    ]);
  });

  it("stages the ball insertion as the GENERATE it routes to before C′", () => {
    expect(cell("ball").kind).toBe("generate");
    expect(classifyCell(cell("ball")).initialPath).toBe("GENERATE");
  });

  it("has no dead native cell — every one routes to an edit, none ASKs, none generates", () => {
    for (const c of SWEEP2_CELLS.filter((x) => x.kind === "native")) {
      const r = classifyCell(c);
      expect({
        id: c.id,
        path:
          r.initialPath === "ASK" || r.initialPath === "GENERATE"
            ? r.initialPath
            : "edit",
      }).toEqual({ id: c.id, path: "edit" });
    }
  });
});

describe("the estimate is the price table's own arithmetic", () => {
  it("quotes the 1.5 MP frames at 2K and the 24 MP frames at 4K — smallestImageSizeFor", () => {
    expect(quoteFor(cell("1.1"))).toEqual({
      size: "2K",
      quotedUsd: 0.1654,
      billedUsd: 0.1344,
    });
    expect(quoteFor(cell("1.3b"))).toEqual({
      size: "4K",
      quotedUsd: 0.271,
      billedUsd: 0.24,
    });
    expect(SWEEP2_SOURCES.large).toMatchObject({ width: 4000, height: 6000 });
  });

  it("totals $5.7041 quoted / $4.8672 billed for generation, and $0.53 of QA", () => {
    // 12 cells at 2K ($0.1654) + 13 at 4K ($0.2710) + the ball generate at 1K with two
    // references ($0.1963) = $5.7041 quoted. Billed, image tokens only: 12×$0.1344 + 13×$0.24 +
    // $0.1344 = $4.8672. QA inspects the 25 native outputs at $0.0212 each; a generate has no
    // source frame, so it is never inspected.
    expect(sweep2Estimate()).toEqual({
      cells: 27,
      spending: 26,
      quotedUsd: 5.7041,
      billedUsd: 4.8672,
      qaUsd: 0.53,
    });
  });
});
