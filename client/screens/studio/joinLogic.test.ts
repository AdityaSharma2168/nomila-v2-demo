/**
 * joinLogic.test.ts — the composer's one rule, input by input, in precedence order (PR 15, R-1).
 */
import { chooseJoin, type JoinInput } from "./joinLogic";

const base = (over: Partial<JoinInput> = {}): JoinInput => ({
  index: 1,
  cutIn: false,
  piece: "clip",
  afterOwnBridge: false,
  continuation: false,
  onBeat: false,
  rhythm: null,
  ...over,
});

describe("chooseJoin — precedence", () => {
  /** ⚠️ MUTATION: fade position 0 (drop the `index === 0` line) — this reds by name. */
  it("position 0 gets a crossfade — never: the first position is a cut whatever else is true", () => {
    expect(
      chooseJoin(base({ index: 0, rhythm: "slow", onBeat: false })),
    ).toEqual({ kind: "cut", reason: "position-0" });
    expect(chooseJoin(base({ index: 0, cutIn: true }))).toEqual({
      kind: "cut",
      reason: "position-0",
    });
  });

  /** ⚠️ MUTATION: move the `cutIn` line below `onBeat` or `rhythm` — this reds by name. */
  it("her explicit Cut is overridden — never: her Cut wins over the beat, the music and the reading", () => {
    expect(chooseJoin(base({ cutIn: true, rhythm: "slow" }))).toEqual({
      kind: "cut",
      reason: "her-cut",
    });
    expect(
      chooseJoin(base({ cutIn: true, onBeat: false, rhythm: "slow" })),
    ).toEqual({ kind: "cut", reason: "her-cut" });
    expect(
      chooseJoin(base({ cutIn: true, continuation: true, rhythm: "slow" })),
    ).toEqual({ kind: "cut", reason: "her-cut" });
  });

  /** ⚠️ MUTATION: drop either bridge line — this reds by name. */
  it("a generated bridge's join is overridden — never: a bridge's edges are cuts, and so is the clip after its own bridge, whatever the reading says", () => {
    expect(chooseJoin(base({ piece: "bridge", rhythm: "slow" }))).toEqual({
      kind: "cut",
      reason: "bridge-edge",
    });
    expect(chooseJoin(base({ afterOwnBridge: true, rhythm: "slow" }))).toEqual({
      kind: "cut",
      reason: "after-own-bridge",
    });
  });

  it("a continuation — the same source on both sides — is a cut, above the music and the reading", () => {
    expect(chooseJoin(base({ continuation: true, rhythm: "slow" }))).toEqual({
      kind: "cut",
      reason: "continuation",
    });
  });

  /** ⚠️ MUTATION: drop the `onBeat` line — this reds by name. */
  it("on-beat toggle ignored at a cut — never: with a track on the beat, every free join is a cut, over a slow reading", () => {
    expect(chooseJoin(base({ onBeat: true, rhythm: "slow" }))).toEqual({
      kind: "cut",
      reason: "on-beat",
    });
    for (const piece of ["still", "own", "clip", "passthrough"] as const)
      expect(chooseJoin(base({ onBeat: true, piece })).kind).toBe("cut");
  });

  /** ⚠️ MUTATION: drop the two rhythm lines — this reds by name. */
  it("editing_rhythm never chooses a join — it does: a fast reading cuts, a slow one fades, each with its reason", () => {
    expect(chooseJoin(base({ rhythm: "fast" }))).toEqual({
      kind: "cut",
      reason: "rhythm-fast",
    });
    expect(chooseJoin(base({ rhythm: "slow" }))).toEqual({
      kind: "fade",
      reason: "rhythm-slow",
    });
  });

  it("with nothing to say, today's default — the free fade — and it says so", () => {
    expect(chooseJoin(base())).toEqual({
      kind: "fade",
      reason: "default-fade",
    });
    for (const piece of ["still", "own", "clip", "passthrough"] as const)
      expect(chooseJoin(base({ piece }))).toEqual({
        kind: "fade",
        reason: "default-fade",
      });
  });

  it("is a pure function — the same input gives the same decision every time", () => {
    const input = base({ onBeat: true, rhythm: "slow" });
    const first = chooseJoin(input);
    for (let i = 0; i < 50; i++) expect(chooseJoin(input)).toEqual(first);
  });
});
