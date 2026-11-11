/**
 * mediaVideoFixes.test.ts — the MEDIA_VIDEO_FIXES switch: only the exact string "true" is on; it is set in NEITHER
 * Cloud Run yaml by this change (dev is turned on later, in its own change; prod is not touched); the per-tick knobs
 * have their documented defaults and nonsense falls back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { instagramVideoTickBytes, instagramVideoTickMax, mediaVideoFixesEnabled } from "./mediaVideoFixes";

const GCP = join(__dirname, "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

const KEYS = ["MEDIA_VIDEO_FIXES", "INSTAGRAM_VIDEO_FETCH_TICK_MAX", "INSTAGRAM_VIDEO_FETCH_TICK_MB"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

it("only the exact string \"true\" is on", () => {
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    if (v === undefined) delete process.env.MEDIA_VIDEO_FIXES; else process.env.MEDIA_VIDEO_FIXES = v;
    expect(mediaVideoFixesEnabled()).toBe(false);
  }
  process.env.MEDIA_VIDEO_FIXES = "true";
  expect(mediaVideoFixesEnabled()).toBe(true);
});

it("dev and prod turn MEDIA_VIDEO_FIXES on (exactly \"true\")", () => {
  expect(envOf("cloud-run-dev.yaml").filter((e) => e.name === "MEDIA_VIDEO_FIXES")).toEqual([{ name: "MEDIA_VIDEO_FIXES", value: "true" }]);
  expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "MEDIA_VIDEO_FIXES")).toEqual([{ name: "MEDIA_VIDEO_FIXES", value: "true" }]);
});

it("per-tick knobs: defaults, env tuning, nonsense falls back", () => {
  expect([instagramVideoTickMax(), instagramVideoTickBytes()]).toEqual([40, 500 * 1024 * 1024]);
  process.env.INSTAGRAM_VIDEO_FETCH_TICK_MAX = "5";
  process.env.INSTAGRAM_VIDEO_FETCH_TICK_MB = "abc";
  expect([instagramVideoTickMax(), instagramVideoTickBytes()]).toEqual([5, 500 * 1024 * 1024]);
  process.env.INSTAGRAM_VIDEO_FETCH_TICK_MAX = "-2";
  expect(instagramVideoTickMax()).toBe(40);
});
