/**
 * navigate.test.ts — the navigate tool is pure screen-mapping (no DB, no athlete
 * data), so these are plain unit tests. It must map every model destination to a
 * WIRED screen-level target, degrade deeper/alias requests to the nearest wired
 * screen, and NEVER emit the id-bearing `deal` target (that's get_deal's job).
 */

import { navigateTool } from "./navigate";

const ATHLETE = "athlete-a"; // passed by the contract, never used by the tool

const nav = (destination: string) =>
  navigateTool.execute(ATHLETE, { destination } as never) as Promise<{
    navigated: boolean;
    screen?: string;
  }>;

describe("navigate tool", () => {
  it("maps each canonical destination to its own wired screen", async () => {
    expect(await nav("deals")).toEqual({ navigated: true, screen: "deals" });
    expect(await nav("score")).toEqual({ navigated: true, screen: "score" });
    expect(await nav("signals")).toEqual({ navigated: true, screen: "signals" });
    expect(await nav("profile")).toEqual({ navigated: true, screen: "profile" });
    expect(await nav("studio")).toEqual({ navigated: true, screen: "studio" });
    expect(await nav("pitches")).toEqual({ navigated: true, screen: "pitches" });
    expect(await nav("media")).toEqual({ navigated: true, screen: "media" });
  });

  it("degrades aliases + detail requests to the nearest wired screen", async () => {
    expect(await nav("opportunities")).toEqual({ navigated: true, screen: "deals" });
    expect(await nav("inbox")).toEqual({ navigated: true, screen: "deals" });
    expect(await nav("deal")).toEqual({ navigated: true, screen: "deals" }); // generic → list
    expect(await nav("brand")).toEqual({ navigated: true, screen: "score" });
    expect(await nav("settings")).toEqual({ navigated: true, screen: "profile" });
    expect(await nav("rates")).toEqual({ navigated: true, screen: "rates" }); // Brand › Rates, not Settings
    expect(await nav("card")).toEqual({ navigated: true, screen: "deck" });
    expect(await nav("record")).toEqual({ navigated: true, screen: "facts" });
    expect(await nav("story")).toEqual({ navigated: true, screen: "story" });
    expect(await nav("pitch")).toEqual({ navigated: true, screen: "pitches" }); // PitchDetail → list
    expect(await nav("media_kit")).toEqual({ navigated: true, screen: "media" }); // MediaDetail → list
  });

  it("never resolves to the id-bearing `deal` target", async () => {
    for (const d of [
      "deals",
      "deal",
      "score",
      "brand",
      "signals",
      "profile",
      "settings",
      "studio",
      "pitches",
      "pitch",
      "media",
      "media_kit",
    ]) {
      expect((await nav(d)).screen).not.toBe("deal");
    }
  });

  it("returns { navigated:false } for an unmappable destination (defense in depth)", async () => {
    expect(await nav("nonexistent")).toEqual({ navigated: false });
  });

  it("reads no athlete data — the result is identical across athletes", async () => {
    const a = await navigateTool.execute("athlete-a", { destination: "score" } as never);
    const b = await navigateTool.execute("athlete-b", { destination: "score" } as never);
    expect(a).toEqual(b);
  });
});
