/**
 * interpret.test.ts — one interpretation end to end, with the transport injected: the memo, every
 * failure as her ask, the record, and the log (the interpreter, I.3). No model is ever called.
 *
 * The properties asserted hardest:
 *
 *   1. ONE CALL PER KEY, NO RETRIES — and the key is scoped by athlete first. A reading of one athlete's
 *      photograph is never another's answer.
 *   2. EVERY FAILURE IS HER ASK: a timeout, an API error, an unreadable frame, a reply the core refuses.
 *   3. NO LOG LINE CARRIES HER WORDS: the interpreter's own lines hold no sentence, no C and no slot
 *      value; no line anywhere on the path holds her whole sentence or C.
 */
const logged: { module: string; args: unknown[] }[] = [];
jest.mock("../../logger", () => ({
  createLogger: (module: string) => {
    const log =
      (level: string) =>
      (...args: unknown[]) =>
        logged.push({ module, args: [level, ...args] });
    return {
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      debug: log("debug"),
    };
  },
}));

import { NOTHING_ATTACHED } from "../classify";
import type { InterpretationInput } from "./core";
import {
  __clearInterpreterMemo,
  interpret,
  memoKey,
  type InterpretDeps,
} from "./interpret";
import { PROMPT_VERSION } from "./prompt";
import type { Transport } from "./transport";

const S = "switch my jersey over to adidas";
const C = "change my jersey to an adidas jersey";

const input = (
  over: Partial<InterpretationInput> = {},
): InterpretationInput => ({
  sentence: S,
  attached: NOTHING_ATTACHED,
  treatment: null,
  menu: { text: false, exclusion: false },
  ...over,
});

const REPLY = JSON.stringify({
  decline: false,
  spans: [{ quote: S, reads: "edit", edits: [0] }],
  edits: [
    {
      kind: "brand_swap",
      source: "yours",
      item: "jersey",
      descriptors: [],
      brand: "adidas",
    },
  ],
  constraints: [],
  visibleMarks: [{ brand: "nike", item: "jersey" }],
});

const FRAME = { bytes: Buffer.from("frame"), mimeType: "image/jpeg" };
const KEY = { athleteId: "athlete-1", sourceAssetId: "asset-1" };

function deps(transport: Transport): InterpretDeps & { calls: () => number } {
  let n = 0;
  return {
    transport: async (req) => {
      n++;
      return transport(req);
    },
    frame: async () => FRAME,
    calls: () => n,
  };
}

const answering =
  (text = REPLY): Transport =>
  async () => ({
    text,
    usage: { inputTokens: 2400, outputTokens: 380 },
    model: "gemini-3.5-flash",
  });

beforeEach(() => {
  __clearInterpreterMemo();
  logged.length = 0;
});

describe("a reply becomes a proposal, and the record says what it was and what it cost", () => {
  it("proposes C, and records her sentence, C, the prompt, the model, tokens and an estimated cost", async () => {
    const d = deps(answering());
    const { interpretation, record } = await interpret(input(), KEY, d);
    expect(interpretation).toMatchObject({ kind: "proposal", canonical: C });
    expect(record).toMatchObject({
      from: S,
      canonical: C,
      promptVersion: PROMPT_VERSION,
      model: "gemini-3.5-flash",
      outcome: "proposed",
      askReason: null,
      usage: { inputTokens: 2400, outputTokens: 380 },
      costBasis: "estimated",
      memo: false,
      visibleMarks: [{ brand: "nike", item: "jersey" }],
    });
    // QA's Flash rates: 2400 × $0.30/M + 380 × $2.50/M.
    expect(record.costUsd).toBeCloseTo(0.00072 + 0.00095, 6);
    expect(d.calls()).toBe(1);
  });
});

describe("the memo — one call per key, scoped by athlete first", () => {
  it("answers a second read from the memo: no call, and no cost", async () => {
    const d = deps(answering());
    await interpret(input(), KEY, d);
    const again = await interpret(input(), KEY, d);
    expect(d.calls()).toBe(1);
    expect(again.record).toMatchObject({
      memo: true,
      costUsd: 0,
      outcome: "proposed",
    });
  });

  it("never answers one athlete's photograph from another's reading", async () => {
    const d = deps(answering());
    await interpret(input(), KEY, d);
    await interpret(input(), { ...KEY, athleteId: "athlete-2" }, d);
    expect(d.calls()).toBe(2);
    expect(memoKey(KEY, input())).toMatch(/^\["athlete-1",/);
  });

  it("asks again when the photo, the sentence, the photos attached, the ad's brand or category, or the menu differ", async () => {
    const d = deps(answering());
    await interpret(input(), KEY, d);
    await interpret(input(), { ...KEY, sourceAssetId: "asset-2" }, d);
    await interpret(input({ sentence: `${S} please` }), KEY, d);
    await interpret(input({ attached: { objects: 1 } }), KEY, d);
    await interpret(
      input({
        treatment: {
          brand: "adidas",
          category: null,
          profile: null,
          register: null,
          swapTo: "adidas",
          competitors: [],
        },
      }),
      KEY,
      d,
    );
    await interpret(input({ menu: { text: true, exclusion: false } }), KEY, d);
    // The brand's category is in the prompt too (I.4: a named brand with no row has none).
    await interpret(
      input({
        treatment: {
          brand: "adidas",
          category: "Athletic Apparel",
          profile: null,
          register: null,
          swapTo: "adidas",
          competitors: [],
        },
      }),
      KEY,
      d,
    );
    expect(d.calls()).toBe(7);
  });
});

describe("an ad is assembled by the ad's plan unless the caller says otherwise (I.4)", () => {
  const AD = "turn this into an adidas ad";
  const AD_REPLY = JSON.stringify({
    decline: false,
    spans: [{ quote: AD, reads: "treatment" }],
    edits: [],
    constraints: [],
    visibleMarks: [{ brand: "nike", item: "jersey" }],
  });

  it("swaps the kit the model saw without a plan passed — a caller cannot forget it", async () => {
    const { interpretation } = await interpret(
      input({
        sentence: AD,
        treatment: {
          brand: "adidas",
          category: null,
          profile: null,
          register: null,
          swapTo: "adidas",
          competitors: ["nike"],
        },
      }),
      KEY,
      deps(answering(AD_REPLY)),
    );
    expect(interpretation).toMatchObject({
      kind: "proposal",
      canonical: C,
      edits: [{ kind: "brand_swap", item: "jersey", source: "brand" }],
    });
  });
});

describe("every failure is her ask — and none is retried", () => {
  it("times out to her ask", async () => {
    const d = deps(async () => {
      throw new Error("studio interpreter timed out after 15000ms");
    });
    const { interpretation, record } = await interpret(input(), KEY, d);
    expect(interpretation).toEqual({
      kind: "ask",
      outcome: "timeout",
      askReason: null,
    });
    expect(record).toMatchObject({
      outcome: "timeout",
      canonical: null,
      costUsd: 0,
    });
  });

  it("fails to her ask on an API error, and on a frame it could not read", async () => {
    const d = deps(async () => {
      throw new Error("PERMISSION_DENIED");
    });
    expect((await interpret(input(), KEY, d)).interpretation).toMatchObject({
      outcome: "error",
    });
    const noFrame: InterpretDeps = {
      transport: answering(),
      frame: async () => null,
    };
    expect(
      (await interpret(input(), { ...KEY, sourceAssetId: "asset-9" }, noFrame))
        .interpretation,
    ).toMatchObject({ outcome: "error" });
  });

  it("keeps a failure for the key — Make it's re-fire is not a retry", async () => {
    const d = deps(async () => {
      throw new Error("PERMISSION_DENIED");
    });
    await interpret(input(), KEY, d);
    await interpret(input(), KEY, d);
    expect(d.calls()).toBe(1);
  });

  it("carries the core's refusal through — a reply it cannot accept is her ask", async () => {
    const d = deps(answering("not json"));
    expect((await interpret(input(), KEY, d)).interpretation).toEqual({
      kind: "ask",
      outcome: "unparseable",
      askReason: null,
    });
  });
});

describe("a new image is recorded as an answer, with its own code — never as a failure (the new-image exit)", () => {
  const SCENE = "me on a beach";
  const NEW_IMAGE = JSON.stringify({
    decline: false,
    newImage: true,
    spans: [],
    edits: [],
    constraints: [],
    visibleMarks: [{ brand: "nike", item: "jersey" }],
  });

  it("records outcome and askReason new_image, what it cost, and no C — and logs codes only", async () => {
    const d = deps(answering(NEW_IMAGE));
    const { interpretation, record } = await interpret(
      input({ sentence: SCENE }),
      KEY,
      d,
    );
    expect(interpretation).toEqual({ kind: "new_image" });
    expect(record).toMatchObject({
      from: SCENE,
      outcome: "new_image",
      askReason: "new_image",
      canonical: null,
      edits: [],
      constraints: [],
      costBasis: "estimated",
      memo: false,
    });
    expect(record.costUsd).toBeGreaterThan(0);
    const line = logged.find((l) => l.module === "studio/interpret");
    expect(JSON.stringify(line?.args)).toContain('"outcome":"new_image"');
    expect(JSON.stringify(line?.args)).not.toContain(SCENE);
  });

  it("serves a second read from the memo as the same answer, for nothing", async () => {
    const d = deps(answering(NEW_IMAGE));
    await interpret(input({ sentence: SCENE }), KEY, d);
    const again = await interpret(input({ sentence: SCENE }), KEY, d);
    expect(d.calls()).toBe(1);
    expect(again.interpretation).toEqual({ kind: "new_image" });
    expect(again.record).toMatchObject({
      outcome: "new_image",
      memo: true,
      costUsd: 0,
    });
  });
});

describe("no log line carries her words", () => {
  it("holds no sentence, no C and no slot value in the interpreter's lines — and her sentence and C in none at all", async () => {
    await interpret(input(), KEY, deps(answering()));
    await interpret(input(), KEY, deps(answering()));
    await interpret(
      input({ sentence: "make it pop" }),
      KEY,
      deps(async () => {
        throw new Error("timed out");
      }),
    );
    const mine = logged.filter((l) => l.module === "studio/interpret");
    expect(mine.length).toBeGreaterThanOrEqual(3);
    const text = (l: { args: unknown[] }) => JSON.stringify(l.args);
    for (const l of mine) {
      for (const forbidden of [
        S,
        C,
        "make it pop",
        "jersey",
        "adidas jersey",
        "nike",
      ]) {
        expect({
          line: text(l),
          has: text(l).includes(forbidden),
        }).toMatchObject({ has: false });
      }
    }
    for (const l of logged) {
      for (const forbidden of [S, C, "make it pop"]) {
        expect({
          line: text(l),
          has: text(l).includes(forbidden),
        }).toMatchObject({ has: false });
      }
    }
  });
});
