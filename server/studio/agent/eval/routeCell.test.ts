import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOKALIKE_PREFIX,
  poolRouteCells,
  summarizeRouteCell,
  type RouteItem,
} from "./routeCell";

const item = (
  over: Partial<RouteItem> & Pick<RouteItem, "kind">,
): RouteItem => ({
  assetId: null,
  provenance: null,
  trim: null,
  motion: null,
  uncast: null,
  demoted: null,
  swapped: null,
  sound: false,
  athletePresent: null,
  ...over,
});
const CAM_CLIP = "d076a790-0000-4000-8000-000000000001";
const CAM_PHOTO = "5581e882-0000-4000-8000-000000000002";
const MADE = "3bb6f269-0000-4000-8000-000000000003";

describe("a route cell counts what castPlan cast, not what the planner asked", () => {
  it("tables camera, i2v, held, demoted, b-roll and left-out, keeping whole ids", () => {
    const cell = summarizeRouteCell([
      item({
        kind: "clip",
        assetId: CAM_CLIP,
        provenance: "camera",
        trim: { startSec: 2, endSec: 5 },
      }),
      item({
        kind: "image",
        assetId: CAM_PHOTO,
        provenance: "camera",
        motion: "dolly",
        demoted: "held",
      }),
      item({ kind: "i2v", assetId: MADE, provenance: "made-here" }),
      item({ kind: "broll" }),
      item({ kind: "i2v", uncast: "no_pick_fits" }),
    ]);
    expect(cell).toMatchObject({
      slots: 4,
      camera: 2,
      madeHere: 1,
      i2v: 1,
      i2vMadeHere: 1,
      held: 1,
      demoted: 1,
      clips: 1,
      brollFromWords: 1,
      leftOut: 1,
      lookalike: 0,
      allCamera: false,
    });
    expect(cell.slotList.map((s) => s.assetId)).toEqual([
      CAM_CLIP,
      CAM_PHOTO,
      MADE,
      null,
    ]);
  });

  it("all-camera only when every slot is a camera asset — b-roll from words breaks it", () => {
    const camera = [
      item({ kind: "clip", assetId: CAM_CLIP, provenance: "camera" }),
      item({ kind: "image", assetId: CAM_PHOTO, provenance: "camera" }),
    ];
    expect(summarizeRouteCell(camera).allCamera).toBe(true);
    expect(
      summarizeRouteCell([...camera, item({ kind: "broll" })]).allCamera,
    ).toBe(false);
    expect(summarizeRouteCell([]).allCamera).toBe(false);
  });

  it("names the lookalike by its id", () => {
    const cell = summarizeRouteCell([
      item({
        kind: "image",
        assetId: `${LOOKALIKE_PREFIX}-x`,
        provenance: "made-here",
      }),
    ]);
    expect(cell.lookalike).toBe(1);
  });

  it("pools n cells into the thresholded share", () => {
    const a = summarizeRouteCell([
      item({ kind: "clip", assetId: CAM_CLIP, provenance: "camera" }),
      item({ kind: "broll" }),
    ]);
    const b = summarizeRouteCell([
      item({ kind: "clip", assetId: CAM_CLIP, provenance: "camera" }),
    ]);
    const p = poolRouteCells([a, b]);
    expect(p).toMatchObject({
      cells: 2,
      slots: 3,
      camera: 2,
      brollFromWords: 1,
      allCameraCells: 1,
    });
    expect(p.cameraShare).toBeCloseTo(2 / 3);
    expect(poolRouteCells([]).cameraShare).toBeNull();
  });
});

describe("eval runners never call the planner around the route", () => {
  // derivePlan in-process skips castPlan — every gate — which is the probe/route divergence
  // (docs/probes/c3-doctrine2.md:9-16). The route is the only caller outside plan.ts itself.
  it("runner calls derivePlan directly: no script or eval module does", () => {
    const root = join(__dirname, "..", "..", "..");
    const dirs = [join(root, "scripts"), join(root, "studio", "agent", "eval")];
    const offenders = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .filter((f) =>
          /\bderivePlan\s*\(/.test(readFileSync(join(d, f), "utf8")),
        )
        .map((f) => join(d, f)),
    );
    expect(offenders).toEqual([]);
  });
});
