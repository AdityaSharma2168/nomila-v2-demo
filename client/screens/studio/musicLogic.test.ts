/**
 * musicLogic.test.ts — the suggestion is preselected until she touches Music, and never after.
 */
import { effectiveBed, feelFromRows, type MusicPick } from "./musicLogic";

const offered = ["walking-away", "walking-around", "save"];
const untouched: MusicPick = { bed: null, onBeat: true, touched: false };

describe("which track is under the stitch", () => {
  it("is the suggestion while she has not touched Music", () => {
    expect(effectiveBed(untouched, "walking-around", offered, true)).toBe(
      "walking-around",
    );
  });

  it("is her pick once she has tapped a chip — and the suggestion never re-asserts", () => {
    const picked: MusicPick = { bed: "save", onBeat: true, touched: true };
    expect(effectiveBed(picked, "walking-around", offered, true)).toBe("save");
    // A new suggestion after her tap changes nothing.
    expect(effectiveBed(picked, "walking-away", offered, true)).toBe("save");
  });

  it("stays None when None is what she tapped", () => {
    const none: MusicPick = { bed: null, onBeat: true, touched: true };
    expect(effectiveBed(none, "walking-around", offered, true)).toBeNull();
  });

  it("is not a suggestion the picker does not offer, or one made while music cannot be used", () => {
    expect(effectiveBed(untouched, "not-a-track", offered, true)).toBeNull();
    expect(
      effectiveBed(untouched, "walking-around", offered, false),
    ).toBeNull();
    expect(effectiveBed(untouched, null, offered, true)).toBeNull();
  });
});

describe("the feel it is read from", () => {
  it("is her row sentences, with the empty ones dropped", () => {
    expect(
      feelFromRows([
        { prompt: "golden hour" },
        { prompt: "  " },
        { prompt: "slow walk" },
      ]),
    ).toEqual(["golden hour", "slow walk"]);
  });
});
