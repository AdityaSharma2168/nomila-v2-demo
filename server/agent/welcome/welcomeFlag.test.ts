/**
 * welcomeFlag.test.ts — MILA_WELCOME is pinned "true" in the dev Cloud Run yaml and "false" in the prod one (exactly
 * once each; the prod flag guard keeps a deploy from ever flipping prod's copy on); only the exact string "true" turns
 * it on. Off, the job gate is transparent: every athlete passes, no SQL is added and no database is read.
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("the database must not be read with MILA_WELCOME off"); } }) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { milaWelcomeEnabled } from "./config";
import { enabledChoiceSql, jobAllowed, jobGate, OPTIONAL_JOBS, type OptionalJob } from "./gate";
import { setChoice } from "./choices";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

describe("MILA_WELCOME", () => {
  const saved = process.env.MILA_WELCOME;
  afterEach(() => { if (saved === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = saved; });

  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to \"%s\", exactly once", (file, expected) => {
    expect(envOf(file).filter((e) => e.name === "MILA_WELCOME")).toEqual([{ name: "MILA_WELCOME", value: expected }]);
  });

  it("only the exact string \"true\"", () => {
    for (const v of ["", "false", "TRUE", "1", " true"]) { process.env.MILA_WELCOME = v; expect(milaWelcomeEnabled()).toBe(false); }
    process.env.MILA_WELCOME = "true";
    expect(milaWelcomeEnabled()).toBe(true);
  });

  it("off: every optional job runs for every athlete as before, no SQL added, no read; nothing is recorded", async () => {
    delete process.env.MILA_WELCOME;
    for (const job of Object.keys(OPTIONAL_JOBS) as OptionalJob[]) {
      expect(await jobGate(job)("11111111-1111-4111-8111-111111111111")).toBe(true);
      expect(await jobAllowed(job, "11111111-1111-4111-8111-111111111111")).toBe(true);
      expect(enabledChoiceSql("athlete_id" as any, job)).toBeUndefined();
    }
    expect(await setChoice({ athleteId: "11111111-1111-4111-8111-111111111111", capability: "post_ideas", to: "enabled", via: "card" }))
      .toMatchObject({ ok: false, error: "disabled" });
  });
});
