/**
 * capabilityRoutes.test.ts — one source, and a guard (capability layer v3 §3 rule 7): every entry a planner can see
 * has a route, every route names an entry, and an engine swap is one variable, never a prompt.
 */
import { CAPABILITY_ENTRIES } from "./agent/capabilityEntries";
import { ENTRY_ROUTES, LANES, engineOverrideVar, laneUp, routeFor, routedEntryIds } from "./capabilityRoutes";

describe("entry ↔ route, both ways", () => {
  it("every entry on any surface has a route", () => {
    const missing = routedEntryIds().filter((id) => !routeFor(id, {}));
    expect(missing).toEqual([]);
  });

  it("every route names an entry that is on some surface (a retired entry has none)", () => {
    const routed = new Set(routedEntryIds());
    expect(Object.keys(ENTRY_ROUTES).filter((id) => !routed.has(id))).toEqual([]);
    expect(routeFor("text_graphic", {})).toBeNull();
    expect(CAPABILITY_ENTRIES.find((e) => e.id === "text_graphic")!.surfaces).toEqual([]);
  });

  it("every route's lane is a known lane; paid entries take the paid lane and free ones never do", () => {
    for (const [id, r] of Object.entries(ENTRY_ROUTES)) {
      expect(LANES).toContain(r.lane);
      const e = CAPABILITY_ENTRIES.find((x) => x.id === id)!;
      expect([id, r.lane === "paid"]).toEqual([id, e.cost.kind === "registry"]);
    }
  });
});

describe("swaps and lanes", () => {
  it("STUDIO_CAP_ENGINE_<ENTRY> swaps one engine and nothing else", () => {
    expect(engineOverrideVar("image.motion.zoom")).toBe("STUDIO_CAP_ENGINE_IMAGE_MOTION_ZOOM");
    expect(engineOverrideVar("clip.slow_mo")).toBe("STUDIO_CAP_ENGINE_CLIP_SLOW_MO");
    const env = { STUDIO_CAP_ENGINE_CLIP_STABILISE: "ffmpeg-deshake/1" };
    expect(routeFor("clip.stabilise", env)).toEqual({ lane: "inline", engine: "ffmpeg-deshake/1", fallback: "ffmpeg-deshake/1" });
    expect(routeFor("clip.slow_mo", env)).toEqual(ENTRY_ROUTES["clip.slow_mo"]);
    expect(routeFor("clip.stabilise", { STUDIO_CAP_ENGINE_CLIP_STABILISE: "  " })).toEqual(ENTRY_ROUTES["clip.stabilise"]);
    expect(routeFor("constructor", {})).toBeNull();
  });

  it("inline and paid are always up; media only when post-kit previews run on the media worker", () => {
    expect(laneUp("inline", {})).toBe(true);
    expect(laneUp("paid", {})).toBe(true);
    expect(laneUp("media", {})).toBe(false);
    expect(laneUp("media", { AGENT_POST_KIT_RENDER_LANE: "stitch" })).toBe(false);
    expect(laneUp("media", { AGENT_POST_KIT_RENDER_LANE: "media" })).toBe(true);
  });
});
