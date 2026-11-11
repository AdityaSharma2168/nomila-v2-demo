/**
 * tickGate.test.ts — D6 as ruled: a Studio tick whose flag is off does nothing and spends nothing (PR 20,
 * docs/probes/ship.md item 4, ADI-S20-GO). The gate's table, and the handlers in server/index.ts asking it first.
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, item 4): M-gate — the video gate always open: "video does nothing while
 * STUDIO_VIDEO_ENABLED is off" reds; M-handler — the video handler's `if (!gate.run)` disabled: "every scheduled Studio
 * tick asks the gate before its lock: studio-video-tick" reds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tickGate, type StudioTick } from "./tickGate";

const VARS = [
  "STUDIO_ALL_ON",
  "STUDIO_ENABLED",
  "STUDIO_VIDEO_ENABLED",
  "STUDIO_IMAGE_EDIT_OPS",
  "AGENT_POST_KITS",
  "AGENT_POST_KIT_RENDER",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const set = (env: Record<string, string>) => Object.assign(process.env, env);
const runs = (tick: StudioTick) => tickGate(tick).run;

describe("D6: each tick runs only with its flags on", () => {
  it.each(["edit", "video", "stitch"] as const)(
    "%s does nothing while STUDIO_ENABLED is off — even with its own flag on",
    (tick) => {
      set({ STUDIO_VIDEO_ENABLED: "true", STUDIO_IMAGE_EDIT_OPS: "true" });
      expect(tickGate(tick)).toEqual({
        run: false,
        reason: "STUDIO_ENABLED is off",
      });
    },
  );

  it("video does nothing while STUDIO_VIDEO_ENABLED is off", () => {
    set({ STUDIO_ENABLED: "true", STUDIO_IMAGE_EDIT_OPS: "true" });
    expect(tickGate("video")).toEqual({
      run: false,
      reason: "STUDIO_VIDEO_ENABLED is off",
    });
  });

  it("edit does nothing while STUDIO_IMAGE_EDIT_OPS is off", () => {
    set({ STUDIO_ENABLED: "true", STUDIO_VIDEO_ENABLED: "true" });
    expect(tickGate("edit")).toEqual({
      run: false,
      reason: "STUDIO_IMAGE_EDIT_OPS is off",
    });
  });

  it("each runs with exactly its flags on, and stitch needs Studio alone", () => {
    set({ STUDIO_ENABLED: "true" });
    expect([runs("edit"), runs("video"), runs("stitch")]).toEqual([
      false,
      false,
      true,
    ]);
    set({ STUDIO_VIDEO_ENABLED: "true" });
    expect(runs("video")).toBe(true);
    set({ STUDIO_IMAGE_EDIT_OPS: "true" });
    expect(runs("edit")).toBe(true);
  });

  it("post-kit preview renders open the stitch tick alone, and only with both of their flags", () => {
    set({ AGENT_POST_KIT_RENDER: "true" });
    expect(tickGate("stitch")).toEqual({ run: false, reason: "STUDIO_ENABLED is off" });
    set({ AGENT_POST_KITS: "true" });
    expect([runs("edit"), runs("video"), runs("stitch")]).toEqual([
      false,
      false,
      true,
    ]);
    set({ AGENT_POST_KIT_RENDER: "false" });
    expect(runs("stitch")).toBe(false);
  });

  it("the master opens all three, and one explicit false closes its own tick", () => {
    set({ STUDIO_ALL_ON: "true" });
    expect([runs("edit"), runs("video"), runs("stitch")]).toEqual([
      true,
      true,
      true,
    ]);
    set({ STUDIO_VIDEO_ENABLED: "false" });
    expect([runs("edit"), runs("video"), runs("stitch")]).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe("the handlers ask the gate first (server/index.ts)", () => {
  const INDEX = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
  /** The handler's source: from its app.post to the next app.post. */
  const handler = (path: string) => {
    const start = INDEX.indexOf(`app.post("${path}"`);
    const end = INDEX.indexOf("app.post(", start + 1);
    return start === -1 ? "" : INDEX.slice(start, end);
  };

  it.each([
    ["/api/internal/studio-edit-tick", "edit", "editTick"],
    ["/api/internal/studio-video-tick", "video", "videoTick"],
    ["/api/internal/studio-stitch-tick", "stitch", "stitchTick"],
  ])(
    "every scheduled Studio tick asks the gate before its lock: %s",
    (path, tick, runner) => {
      const h = handler(path);
      const gate = h.indexOf(`tickGate("${tick}")`);
      const guard = h.indexOf("if (!gate.run) {", gate);
      expect({
        gate: gate > -1,
        guardFollows: guard > gate,
        beforeRunner: guard > -1 && guard < h.indexOf(`const { ${runner} }`),
        beforeLock: guard > -1 && guard < h.indexOf("withWorkflowTickLock("),
      }).toEqual({
        gate: true,
        guardFollows: true,
        beforeRunner: true,
        beforeLock: true,
      });
    },
  );

  it("every Studio tick the scheduler declares is one the gate covers (scripts/provision-schedulers.sh)", () => {
    const script = readFileSync(
      join(__dirname, "..", "..", "scripts", "provision-schedulers.sh"),
      "utf8",
    );
    const declared = [
      ...script.matchAll(
        /^\s*"studio-[a-z-]+\|[^|]+\|(\/api\/internal\/studio-[a-z-]+)\|/gm,
      ),
    ].map((m) => m[1]);
    expect(declared.sort()).toEqual([
      "/api/internal/studio-edit-tick",
      "/api/internal/studio-stitch-tick",
      "/api/internal/studio-video-tick",
    ]);
    for (const path of declared) expect(handler(path)).toContain("tickGate(");
  });

  it("the publish tick is not gated: it runs with publishing off to close what waited", () => {
    const h = handler("/api/internal/studio-publish-tick");
    expect(h.length).toBeGreaterThan(0);
    expect(h).not.toContain("tickGate(");
  });
});
