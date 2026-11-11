/**
 * shipConfig.test.ts — PR 20's deploy config, pinned both ways (docs/probes/ship.md items 5 and 8, ADI-S20-GO):
 * dev runs the flip's proof (the master on, its cap beside it, the publish scope requested), and merging changes nothing
 * in prod's behaviour (no master, no publish scope, the Studio lines exactly as they were). Both services mount the
 * OpenRouter key (ADI-S20-HOLD2) — in prod it is inert until Studio video is on.
 *
 * ⚠️ The one trap this exists for: under STUDIO_ALL_ON an explicit "false" still wins (studio/studioFlag.ts), so a
 * leftover `STUDIO_ENABLED: "false"` in the dev yaml would keep Studio OFF under the master. "no Studio flag line says
 * false in dev" reds on it by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(__dirname, "..", "..");
/** The container env of a Cloud Run service yaml, as name → literal value (secretKeyRef entries are left out). */
function envOf(file: string): Record<string, string> {
  const doc = parse(readFileSync(join(ROOT, "gcp", file), "utf8"));
  const env: { name: string; value?: string }[] =
    doc.spec.template.spec.containers[0].env;
  return Object.fromEntries(
    env
      .filter((e) => e.value !== undefined)
      .map((e) => [e.name, e.value as string]),
  );
}
/** The Secret Manager reference an env var is mounted from, or undefined. */
function secretOf(file: string, name: string) {
  const doc = parse(readFileSync(join(ROOT, "gcp", file), "utf8"));
  const env: { name: string; value?: string; valueFrom?: unknown }[] =
    doc.spec.template.spec.containers[0].env;
  const hit = env.filter((e) => e.name === name);
  return hit.length === 1
    ? { value: hit[0].value, valueFrom: hit[0].valueFrom }
    : { count: hit.length };
}
const studioLines = (env: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(env).filter(([k]) => k.startsWith("STUDIO_")),
  );

describe("dev: the flip's proof (ADI-S20-GO item 8)", () => {
  const DEV = envOf("cloud-run-dev.yaml");

  it("the master is on, with the enrich day cap beside it at 5", () => {
    expect({
      STUDIO_ALL_ON: DEV.STUDIO_ALL_ON,
      STUDIO_ENRICH_DAILY_CAP_USD: DEV.STUDIO_ENRICH_DAILY_CAP_USD,
    }).toEqual({ STUDIO_ALL_ON: "true", STUDIO_ENRICH_DAILY_CAP_USD: "5" });
  });

  it("no Studio flag line says false in dev — an explicit false outranks the master", () => {
    expect(
      Object.entries(studioLines(DEV)).filter(([, v]) => v === "false"),
    ).toEqual([]);
  });

  it("the publish scope is requested at connect in dev", () => {
    expect(DEV.IG_REQUEST_PUBLISH_SCOPE).toBe("true");
  });

  it("publishing itself stays off in dev config — the Instagram test sets it per run", () => {
    expect(DEV.STUDIO_PUBLISH_MODE).toBeUndefined();
  });
});

describe("prod: Studio on for stage 1 (owner, 25 Oct 2026), the caps with it", () => {
  const PROD = envOf("cloud-run-prod.yaml");

  it("the master is on, no explicit STUDIO_ENABLED=false outranks it, the $5 job cap and the enrich day cap travel with it", () => {
    expect(studioLines(PROD)).toEqual({
      STUDIO_ALL_ON: "true",
      STUDIO_MAX_JOB_USD: "5",
      STUDIO_ENRICH_DAILY_CAP_USD: "5",
      STUDIO_SHOT_DETECT: "true",
      STUDIO_VIDEO_ENRICH: "true",
    });
  });

  it("no publish scope is requested in prod", () => {
    expect(PROD.IG_REQUEST_PUBLISH_SCOPE).toBeUndefined();
  });
});

describe("the OpenRouter key is mounted in both services (ADI-S20-HOLD2)", () => {
  it.each(["cloud-run-dev.yaml", "cloud-run-prod.yaml"])(
    "%s mounts OPENROUTER_API_KEY from the secret of that name at latest — once, never a literal",
    (file) => {
      expect(secretOf(file, "OPENROUTER_API_KEY")).toEqual({
        value: undefined,
        valueFrom: {
          secretKeyRef: { name: "OPENROUTER_API_KEY", key: "latest" },
        },
      });
    },
  );
});
