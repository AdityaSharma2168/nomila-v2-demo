/**
 * watch.test.ts — the three watch metrics (PR 16, R-12, M16).
 */
import {
  CAMERA_COMPAT,
  cameraDisagreement,
  dropRate,
  i2vOnMadeHere,
  joinDistribution,
} from "./watch";
import type { AgentPlanItem } from "../../../../client/hooks/use-studio";

describe("(a) camera vs shot_type, by Adi's pre-registered table", () => {
  it("a compatible pair counts as a disagreement — it must not", () => {
    expect(
      cameraDisagreement([{ camera: "close_up", shotType: "portrait" }]),
    ).toEqual({ counted: 1, disagree: 0, rate: 0 });
  });
  it("an incompatible pair is one; text_graphic disagrees with every camera; other is not counted", () => {
    expect(
      cameraDisagreement([
        { camera: "overhead", shotType: "portrait" },
        { camera: "wide", shotType: "text_graphic" },
        { camera: "wide", shotType: "other" },
        { camera: null, shotType: "action" },
      ]),
    ).toEqual({ counted: 2, disagree: 2, rate: 1 });
  });
  it("the table is Adi's, as registered", () => {
    expect(Object.keys(CAMERA_COMPAT).sort()).toEqual([
      "action",
      "group",
      "lifestyle",
      "other",
      "portrait",
      "text_graphic",
    ]);
    expect(CAMERA_COMPAT.other).toBe("any");
  });
});

describe("(b) drop-rate and (c) join reasons", () => {
  const broll: AgentPlanItem = {
    kind: "broll",
    beat: "b",
    direction: "an empty court",
    assetId: null,
    thumbUrl: null,
    athletePresent: null,
    sound: false,
    brandFlag: null,
    swapped: null,
    uncast: null,
    shot: { framing: "wide", composition: "centered", motion: "running" },
  };
  it("a b-roll row keeps every planned slot with the composer on (PR 15.1)", () => {
    expect(dropRate([broll], true)).toEqual({ asked: 3, kept: 3, rate: 0 });
  });
  it("counts join reasons", () => {
    expect(
      joinDistribution({
        a: { reason: "position-0" },
        b: { reason: "default-fade" },
        c: { reason: "default-fade" },
      }),
    ).toEqual({ "position-0": 1, "default-fade": 2 });
  });
});

describe("(d) K40 — i2v cast onto a made-here still, per plan", () => {
  it("counts made-here i2v; a camera i2v is not made-here; b-roll from words is not counted", () => {
    expect(
      i2vOnMadeHere([
        { kind: "i2v", assetId: "a", provenance: "made-here" },
        { kind: "i2v", assetId: "b", provenance: "camera" },
        { kind: "broll", assetId: null, provenance: null },
        { kind: "image", assetId: "c", provenance: "made-here" },
      ]),
    ).toEqual({ i2v: 2, onMadeHere: 1, rate: 0.5 });
  });
  it("a camera i2v counts as made-here — it must not", () => {
    expect(
      i2vOnMadeHere([{ kind: "i2v", assetId: "b", provenance: "camera" }])
        .onMadeHere,
    ).toBe(0);
  });
});
