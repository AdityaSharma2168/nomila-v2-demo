/**
 * atmosphereFlag.test.ts — ATMOSPHERE_IMAGERY is pinned "true" in the dev Cloud Run yaml (DEV ONLY — the owner's
 * call) and "false" in prod (exactly once each); only the exact string "true" turns it on; PIXABAY_API_KEY is not
 * mounted yet (the owner creates the secret, then mounts it); the caps have the documented defaults, env can tune
 * them, and nonsense falls back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ATMOSPHERE, PIXABAY_KEY_ENV, atmosphereEnabled } from "./config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

const KEYS = ["ATMOSPHERE_IMAGERY", "ATMOSPHERE_ATHLETE_DAY_CAP_USD", "ATMOSPHERE_ATHLETE_TOTAL_CAP_USD", "ATMOSPHERE_DAY_CAP_USD", "ATMOSPHERE_GENERATIONS_PER_ATHLETE_DAY", "ATMOSPHERE_IMAGE_MODEL"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins ATMOSPHERE_IMAGERY to %j, exactly once, and mounts no Pixabay key yet", (file, value) => {
  expect(envOf(file).filter((e) => e.name === "ATMOSPHERE_IMAGERY")).toEqual([{ name: "ATMOSPHERE_IMAGERY", value }]);
  expect(envOf(file).filter((e) => e.name === PIXABAY_KEY_ENV)).toEqual([]);
});

it("only the exact string \"true\" is on", () => {
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    if (v === undefined) delete process.env.ATMOSPHERE_IMAGERY; else process.env.ATMOSPHERE_IMAGERY = v;
    expect(atmosphereEnabled()).toBe(false);
  }
  process.env.ATMOSPHERE_IMAGERY = "true";
  expect(atmosphereEnabled()).toBe(true);
});

it("caps: defaults, env tuning, \"0\" switches a step off, nonsense falls back", () => {
  expect([ATMOSPHERE.ATHLETE_DAY_CAP_MICRO_USD, ATMOSPHERE.ATHLETE_TOTAL_CAP_MICRO_USD, ATMOSPHERE.DAY_CAP_MICRO_USD, ATMOSPHERE.GENERATIONS_PER_ATHLETE_DAY, ATMOSPHERE.GENERATION_ESTIMATE_MICRO_USD, ATMOSPHERE.IMAGE_MODEL])
    .toEqual([500_000, 2_000_000, 10_000_000, 3, 70_000, "gemini-3.1-flash-image"]);
  process.env.ATMOSPHERE_ATHLETE_DAY_CAP_USD = "0.2";
  process.env.ATMOSPHERE_GENERATIONS_PER_ATHLETE_DAY = "0";
  process.env.ATMOSPHERE_DAY_CAP_USD = "abc";
  process.env.ATMOSPHERE_ATHLETE_TOTAL_CAP_USD = "-1";
  expect([ATMOSPHERE.ATHLETE_DAY_CAP_MICRO_USD, ATMOSPHERE.GENERATIONS_PER_ATHLETE_DAY, ATMOSPHERE.DAY_CAP_MICRO_USD, ATMOSPHERE.ATHLETE_TOTAL_CAP_MICRO_USD])
    .toEqual([200_000, 0, 10_000_000, 2_000_000]);
});
