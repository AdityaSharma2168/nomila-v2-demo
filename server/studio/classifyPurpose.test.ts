/**
 * classifyPurpose.test.ts — why a classify call was made, and what the classifier's log says about it
 * (auto-mark, 2026-09-16).
 *
 * Create anything asks the classifier two questions of its own before a plan exists: while she types
 * (`draft`) and at send (`shape`). Neither answer is shown to her. So:
 *
 *   1. A DRAFT call writes no line at all. A half-typed sentence is not a request the screen declined.
 *   2. A SHAPE call's lines carry `purpose: "shape"`, and nothing else about them changes.
 *   3. Every other call — the plan's, the preview's, the freeze's — logs exactly as before, untagged, even
 *      straight after a tagged one.
 *   4. The purpose never changes the ANSWER.
 */
const logged: { module: string; args: unknown[] }[] = [];
jest.mock("../logger", () => ({
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

import { route, routeAs, NOTHING_ATTACHED } from "./classify";

/** The classifier's own lines, as `[fields, msg]`. */
const lines = () =>
  logged
    .filter((l) => l.module === "studio/classify")
    .map((l) => l.args.slice(1) as [Record<string, unknown>, string]);

/** The same, one level only — the decision log is info; a superseded pass is debug (PR 9, 0b). */
const linesAt = (level: "info" | "debug") =>
  logged
    .filter((l) => l.module === "studio/classify" && l.args[0] === level)
    .map((l) => l.args.slice(1) as [Record<string, unknown>, string]);

beforeEach(() => {
  logged.length = 0;
});

/** One sentence per line the classifier writes: the fall-through, the person guard, the missing photo. */
const LOGGING = [
  { sentence: "make me taller", event: "fast_path_declined" },
  // A sentence the guard refuses AND that asks — since PR 9 (0b) "make my jersey blue, dont change my
  // face" routes, and a routed sentence writes no refusal line (see "one line per decision" below).
  { sentence: "make my bicep red", event: "person_target" },
  {
    sentence: "change my earrings to these gold hoops",
    event: "object_photo_missing",
  },
  // Since the preservation fixes (#488): its line goes through `note` too.
  {
    sentence: "make it warmer but keep the background the same",
    event: "keep_conflict",
  },
] as const;

describe("a classify call's purpose", () => {
  it.each(LOGGING)(
    "an untagged call logs $event as it always did — no purpose field",
    ({ sentence, event }) => {
      route(sentence, true, NOTHING_ATTACHED);
      const events = lines().map(([fields]) => fields);
      expect(events.map((f) => f.event)).toContain(event);
      expect(events.every((f) => !("purpose" in f))).toBe(true);
    },
  );

  it.each(LOGGING)(
    "a DRAFT call writes no line at all for $event — a half-typed sentence is not a decline",
    ({ sentence }) => {
      routeAs("draft", sentence, true, NOTHING_ATTACHED);
      expect(lines()).toEqual([]);
    },
  );

  it.each(LOGGING)(
    "a SHAPE call's $event line is the untagged line, plus purpose: shape",
    ({ sentence }) => {
      route(sentence, true, NOTHING_ATTACHED);
      const plain = lines();
      logged.length = 0;
      routeAs("shape", sentence, true, NOTHING_ATTACHED);
      expect(lines()).toEqual(
        plain.map(([fields, msg]) => [{ ...fields, purpose: "shape" }, msg]),
      );
    },
  );

  it("does not leak: the plan's untagged call straight after a draft or a shape call logs as before", () => {
    routeAs("draft", "make me taller", true, NOTHING_ATTACHED);
    routeAs("shape", "make me taller", true, NOTHING_ATTACHED);
    logged.length = 0;
    route("make me taller", true, NOTHING_ATTACHED);
    expect(lines()).toHaveLength(1);
    expect(lines()[0][0]).not.toHaveProperty("purpose");
  });

  it("never changes the answer — the same Routed for no purpose, draft and shape", () => {
    for (const sentence of [
      ...LOGGING.map((l) => l.sentence),
      "make the socks blue",
      "generate pic of me playing soccer",
      "put me on a rooftop at dusk",
    ]) {
      for (const hasSourcePhoto of [true, false]) {
        const plain = route(sentence, hasSourcePhoto, NOTHING_ATTACHED);
        expect({
          sentence,
          draft: routeAs("draft", sentence, hasSourcePhoto, NOTHING_ATTACHED),
          shape: routeAs("shape", sentence, hasSourcePhoto, NOTHING_ATTACHED),
          none: routeAs(undefined, sentence, hasSourcePhoto, NOTHING_ATTACHED),
        }).toEqual({ sentence, draft: plain, shape: plain, none: plain });
      }
    }
  });
});

/**
 * One line per decision (PR 9, commit 0b — the PR 1 log-noise flag). `route` reads a sentence whole, then
 * with her keep set aside; until PR 9 every pass wrote its refusal the moment it refused, so a sentence that
 * ROUTED beside her keep still logged `person_target`, and one that asked after two passes logged it twice.
 * Now the pass whose answer she gets writes at info; a superseded pass at debug, `superseded: true`.
 */
describe("one line per decision — the log says what the answer says", () => {
  const events = (level: "info" | "debug") =>
    linesAt(level).map(([f]) => f.event);

  /** ⚠️ MUTATION "person_target logged on a routed sentence": write the pass's line the moment it refuses. */
  it("a sentence that routes beside her keep writes no refusal at info — the guard's reading of the whole sentence goes to debug, superseded", () => {
    const out = route(
      "make my jersey blue, dont change my face",
      true,
      NOTHING_ATTACHED,
    );
    expect(out.initialPath).not.toBe("ASK");
    expect(out.constraints).toEqual([{ kind: "preserve_person" }]);
    expect(events("info")).toEqual([]);
    expect(linesAt("debug")).toEqual([
      [
        expect.objectContaining({ event: "person_target", superseded: true }),
        "classifier denied a person target",
      ],
    ]);
  });

  it("a look that routes beside her keep writes no fast_path_declined at info", () => {
    const out = route(
      "make it warmer, dont change my face",
      true,
      NOTHING_ATTACHED,
    );
    expect(out.initialPath).not.toBe("ASK");
    expect(events("info")).toEqual([]);
    expect(events("debug")).toEqual(["fast_path_declined"]);
  });

  it("a sentence that asks after both passes writes its refusal ONCE, at info — the pass she hears", () => {
    const out = route(
      "make my arms bigger, dont change my face",
      true,
      NOTHING_ATTACHED,
    );
    expect(out.initialPath).toBe("ASK");
    expect(out.reason).toBe("person_mentioned");
    // The fall-through's event is always fast_path_declined; which "no" is its `reason` field.
    expect(linesAt("info")).toEqual([
      [
        expect.objectContaining({
          event: "fast_path_declined",
          reason: "person_mentioned",
        }),
        "classifier fell through to ASK",
      ],
    ]);
    // The other pass (the rest, "make my arms bigger") fell through the same way — before PR 9 that was a
    // second identical info line. Read, set aside, kept off the decision log.
    expect(linesAt("debug")).toEqual([
      [
        expect.objectContaining({
          event: "fast_path_declined",
          reason: "person_mentioned",
          superseded: true,
        }),
        "classifier fell through to ASK",
      ],
    ]);
  });

  it("a one-pass refusal is unchanged: one line, at info, no superseded field", () => {
    route("make my bicep red", true, NOTHING_ATTACHED);
    expect(linesAt("info")).toHaveLength(1);
    expect(linesAt("info")[0][0]).toEqual(
      expect.objectContaining({ event: "person_target", phrase: "bicep" }),
    );
    expect(linesAt("info")[0][0]).not.toHaveProperty("superseded");
    expect(linesAt("debug")).toEqual([]);
  });

  it("a draft call writes nothing at either level; a shape call tags both levels", () => {
    routeAs(
      "draft",
      "make my jersey blue, dont change my face",
      true,
      NOTHING_ATTACHED,
    );
    expect(lines()).toEqual([]);
    routeAs(
      "shape",
      "make my jersey blue, dont change my face",
      true,
      NOTHING_ATTACHED,
    );
    expect(linesAt("debug").map(([f]) => f.purpose)).toEqual(["shape"]);
  });
});
