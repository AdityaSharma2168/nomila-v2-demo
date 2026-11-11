/**
 * recommend.test.ts — the recommendation pass's pure half (PR 9, Lane 3a): grounding, the brand-word strip,
 * the route check, the memo, and the one structural claim — this module can never run an op.
 */
const generateContentMock = jest.fn();
jest.mock("../../lib/models", () => ({
  genai: () => ({
    models: { generateContent: (...a: unknown[]) => generateContentMock(...a) },
  }),
  GEMINI: { flash: "flash-test", flashLite: "lite-test", pro: "pro-test" },
}));

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLog } from "../costLog";
import {
  briefHash,
  groundRecs,
  RECOMMEND_PROMPT,
  recommendMemoized,
  stripBrandWords,
} from "./recommend";
import PIN from "./recommend.prompt.pin.json";

const LINES = [
  "No competitor firms named or shown.",
  "No Nike marks on kit or ball.",
  "Mention the campus internship program by name once, verbally or on screen.",
];

beforeEach(() => {
  process.env.STUDIO_DISPLAY_TEXT = "true";
});
afterEach(() => {
  delete process.env.STUDIO_DISPLAY_TEXT;
});

describe("grounded, or dropped", () => {
  /** ⚠️ MUTATION "rec shown without a brief line grounding it": skip the substring check in groundRecs. */
  it("keeps a rec whose because is a verbatim brief line, and drops a paraphrase — naming it", () => {
    const out = groundRecs(
      {
        recs: [
          {
            op: "recolour",
            params: { target: "logos", colour: "black" },
            because: "No Nike marks on kit or ball.",
            what: "Nike logos on the kit.",
          },
          {
            op: "recolour",
            params: { target: "logos", colour: "black" },
            because: "No Nike marks anywhere.",
            what: "paraphrased",
          },
          {
            op: "recolour",
            params: { target: "logos", colour: "black" },
            because: "",
            what: "empty",
          },
        ],
      },
      LINES,
    );
    expect(out.recs).toEqual([
      expect.objectContaining({
        op: "recolour",
        because: "No Nike marks on kit or ball.",
        what: "Nike logos on the kit.",
      }),
    ]);
    expect(out.dropped.map((d) => d.reason)).toEqual([
      "ungrounded",
      "ungrounded",
    ]);
  });

  it("a substring of a line counts; a line of another brief does not", () => {
    const partial = groundRecs(
      {
        recs: [
          {
            op: "recolour",
            params: { target: "logos", colour: "black" },
            because: "No Nike marks",
            what: "",
          },
        ],
      },
      LINES,
    );
    expect(partial.recs).toHaveLength(1);
    const other = groundRecs(
      {
        recs: [
          {
            op: "recolour",
            params: { target: "logos", colour: "black" },
            because: "No Nike marks",
            what: "",
          },
        ],
      },
      ["Wear the home kit."],
    );
    expect(other.recs).toHaveLength(0);
    expect(other.dropped[0].reason).toBe("ungrounded");
  });

  it("an op outside the five, or params outside its shape, is dropped as bad_op", () => {
    const out = groundRecs(
      {
        recs: [
          { op: "upscale", params: {}, because: LINES[0], what: "" },
          {
            op: "recolour",
            params: { target: "logos" },
            because: LINES[1],
            what: "",
          },
          {
            op: "garment",
            params: { garment: "jersey", brand: "adidas", design: "stripe" },
            because: LINES[1],
            what: "",
          },
        ],
      },
      LINES,
    );
    expect(out.recs).toHaveLength(0);
    expect(out.dropped.map((d) => d.reason)).toEqual([
      "bad_op",
      "bad_op",
      "bad_op",
    ]);
  });

  it("caps what it reads at six replies and tolerates a non-object", () => {
    const many = {
      recs: Array.from({ length: 9 }, () => ({
        op: "recolour",
        params: { target: "logos", colour: "black" },
        because: LINES[1],
        what: "",
      })),
    };
    expect(groundRecs(many, LINES).recs).toHaveLength(6);
    expect(groundRecs(null, LINES)).toEqual({ recs: [], dropped: [] });
    expect(groundRecs("nope", LINES)).toEqual({ recs: [], dropped: [] });
  });
});

describe("the spike's finding — a rec must route, or it is not a chip", () => {
  it("strips brand words from a target: the spike's own reply now routes", () => {
    expect(stripBrandWords("Nike logos")).toBe("logos");
    expect(stripBrandWords("adidas jersey")).toBe("jersey");
    expect(stripBrandWords("New Balance shoes")).toBe("shoes");
    expect(stripBrandWords("jersey")).toBe("jersey");
    const out = groundRecs(
      {
        recs: [
          {
            op: "recolour",
            params: { target: "Nike logos", colour: "black" },
            because: LINES[1],
            what: "There are visible Nike logos on the jersey, shorts, socks, and soccer ball.",
          },
        ],
      },
      LINES,
    );
    expect(out.recs).toEqual([
      expect.objectContaining({
        op: "recolour",
        params: { target: "logos", colour: "black" },
      }),
    ]);
    expect(out.dropped).toEqual([]);
  });

  /** ⚠️ MUTATION "rec that asks is shown": skip the route check in groundRecs. */
  it("drops a rec whose sentence would ask at the quote — fail-closed, named not_routed", () => {
    // "make my arms red" — a person target; the rules refuse it, so the chip would refuse too.
    const out = groundRecs(
      {
        recs: [
          {
            op: "recolour",
            params: { target: "arms", colour: "red" },
            because: LINES[1],
            what: "",
          },
        ],
      },
      LINES,
    );
    expect(out.recs).toHaveLength(0);
    expect(out.dropped.map((d) => d.reason)).toEqual(["not_routed"]);
  });

  it("a product rec needs no asset id from the model — the popover fills it at tap time", () => {
    const out = groundRecs(
      {
        recs: [
          {
            op: "product",
            params: { thing: "soccer ball" },
            because: LINES[0],
            what: "",
          },
        ],
      },
      LINES,
    );
    expect(out.recs).toEqual([
      expect.objectContaining({
        op: "product",
        params: { thing: "soccer ball" },
      }),
    ]);
  });
});

describe("the memo and the no-brief path", () => {
  it("no brief lines → no call at all; the loader is never invoked", async () => {
    const load = jest.fn();
    const out = await recommendMemoized(
      { athleteId: "a", assetId: "b", briefLines: ["   ", ""] },
      load,
    );
    expect(out).toEqual({
      recs: [],
      dropped: [],
      usage: null,
      skipped: "no_brief",
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("the brief hash is order- and whitespace-sensitive only as far as the lines themselves", () => {
    expect(briefHash(["a ", " b"])).toBe(briefHash(["a", "b"]));
    expect(briefHash(["a", "b"])).not.toBe(briefHash(["b", "a"]));
    expect(briefHash(["a", "", "b"])).toBe(briefHash(["a", "b"]));
  });

  it("the prompt lists the lines verbatim and tells the model only what is visible can break one", () => {
    const p = RECOMMEND_PROMPT("Jane Street", LINES);
    for (const l of LINES) expect(p).toContain(l);
    expect(p).toMatch(/Only what is VISIBLE/);
    expect(p).toMatch(/copied exactly/);
    expect(p).toMatch(/\{"recs": \[\]\}/);
  });
});

describe("a rec never runs an op — structurally", () => {
  /** ⚠️ MUTATION "rec runs an op without her tap": import quoteEdit / runEdit into recommend.ts and call one. */
  it("recommend.ts imports nothing from engine.ts and names no quote/run/accept call", () => {
    const src = readFileSync(join(__dirname, "recommend.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\/engine"|import\("\.\/engine"\)/);
    expect(src).not.toMatch(
      /\b(quoteEdit|runEdit|acceptEdit|discardEdit|runStudioGeneration|generate)\s*\(/,
    );
    expect(src).not.toMatch(/from "\.\.\/router"/);
    expect(src).not.toMatch(/from "\.\.\/generate"/);
  });
});

describe("recommend spend goes through the cost-log door (PR 11, R-2)", () => {
  let logFile: string;
  beforeEach(() => {
    logFile = join(mkdtempSync(join(tmpdir(), "rec-cost-")), "log.jsonl");
    process.env.STUDIO_COST_LOG = logFile;
    generateContentMock.mockReset();
    generateContentMock.mockResolvedValue({
      text: "[]",
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 },
    });
  });
  afterEach(() => {
    delete process.env.STUDIO_COST_LOG;
  });

  /** ⚠️ MUTATION "recommend spend unlogged": drop the recordOffRouterSpend call from recommendEdits. */
  it("one call → one line, task edit.recommend, priced from the usage the model reported, naming the photo", async () => {
    const key = { athleteId: "a", assetId: "asset-1", briefLines: LINES };
    const load = jest.fn(async () => ({
      bytes: Buffer.from("jpg"),
      mimeType: "image/jpeg",
    }));
    await recommendMemoized(key, load);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const lines = await readLog(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      task: "edit.recommend",
      provider: "vertex",
      model: "flash-test",
      costBasis: "estimated",
      inputRefs: { count: 1, ids: ["asset-1"] },
      // No job exists before the quote, so every join key is null — present, and null.
      jobId: null,
      previewId: null,
      editPreviewId: null,
      batchId: null,
      promptVersion: null,
      assetId: null,
    });
    // 1000 in × $0.3/M + 50 out × $2.5/M — the qa/cost rates, not a confident zero.
    expect(lines[0].cost).toBeCloseTo(0.000425, 6);
  });

  it("a memo HIT spends nothing and writes nothing", async () => {
    const key = { athleteId: "a", assetId: "asset-2", briefLines: LINES };
    const load = jest.fn(async () => ({
      bytes: Buffer.from("jpg"),
      mimeType: "image/jpeg",
    }));
    await recommendMemoized(key, load);
    await recommendMemoized(key, load);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(await readLog(logFile)).toHaveLength(1);
  });
});

/**
 * PR 18 (PR 16 K2; ADI-24SEP R1; brief R-7, R-12): the brand's name and each brief line are FENCED in
 * <external_content>, verbatim, with STUDIO_STYLE_SPEC on. Off, the prompt is the one captured from the tip
 * (`7a083fc6`) BEFORE this PR touched the file (recommend.prompt.pin.json), byte for byte.
 */
describe("the fences (PR 18)", () => {
  const withFlag = <T>(v: string | undefined, f: () => T): T => {
    const was = process.env.STUDIO_STYLE_SPEC;
    if (v === undefined) delete process.env.STUDIO_STYLE_SPEC;
    else process.env.STUDIO_STYLE_SPEC = v;
    try {
      return f();
    } finally {
      if (was === undefined) delete process.env.STUDIO_STYLE_SPEC;
      else process.env.STUDIO_STYLE_SPEC = was;
    }
  };

  it.each([undefined, "false"])(
    "a fence changes a prompt with the flag off — it must not (flag %s): the prompt is the tip's, byte for byte",
    (flag) => {
      withFlag(flag, () => {
        expect(RECOMMEND_PROMPT(PIN.fixture.brand, PIN.fixture.lines)).toBe(
          PIN.withBrand,
        );
        expect(RECOMMEND_PROMPT(null, PIN.fixture.lines)).toBe(PIN.noBrand);
      });
    },
  );

  it("a brief line reaches recommend unfenced — it must not: each line and the brand sit whole inside a fence", () => {
    withFlag("true", () => {
      const p = RECOMMEND_PROMPT(PIN.fixture.brand, PIN.fixture.lines);
      for (const l of PIN.fixture.lines)
        expect(p).toContain(`<external_content>${l}</external_content>`);
      expect(p).toContain(
        `for <external_content>${PIN.fixture.brand}</external_content>.`,
      );
      // Only the fences were added: take them out and it is the tip's prompt.
      expect(
        p
          .split("<external_content>")
          .join("")
          .split("</external_content>")
          .join(""),
      ).toBe(PIN.withBrand);
    });
  });

  it("a line copied back WITH its markers still grounds with the flag on, and does not with it off", () => {
    const reply = {
      recs: [
        {
          op: "recolour",
          params: { target: "logos", colour: "black" },
          because: `<external_content>${LINES[1]}</external_content>`,
          what: "a mark on the sleeve",
        },
      ],
    };
    const on = withFlag("true", () => groundRecs(reply, LINES));
    expect(on.recs.map((r) => r.because)).toEqual([LINES[1]]);
    const off = withFlag(undefined, () => groundRecs(reply, LINES));
    expect(off.recs).toEqual([]);
    expect(off.dropped.map((d) => d.reason)).toEqual(["ungrounded"]);
  });
});
