/**
 * tfWaitlistFlag.test.ts — MILA_TF_WAITLIST (docs/design/mila-hosted-waitlist.md) is pinned ON in the dev Cloud Run yaml
 * and OFF in prod (exactly once each; DEV ONLY); only the exact string "true" turns it on, and nothing
 * else is needed: no MILA_ENGINE (Mastra-only PR 2), no MCP server and no TrueForge setting (P1, 5 Nov 2026).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { milaWaitlistEnabled } from "../engine/config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);
const KEYS = ["MILA_TF_WAITLIST", "MILA_ENGINE", "NOMILA_MCP_ENABLED", "TRUEFORGE_BASE_URL", "TRUEFORGE_IAP_AUDIENCE", "TRUEFORGE_CALLER_SA", "TRUEFORGE_API_KEY"];

describe("MILA_TF_WAITLIST", () => {
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to %j, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "MILA_TF_WAITLIST")).toEqual([{ name: "MILA_TF_WAITLIST", value }]);
  });

  it("only the exact string \"true\"; no engine, MCP server or TrueForge setting needed", () => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      for (const v of ["", "false", "TRUE", "1", " true"]) { process.env.MILA_TF_WAITLIST = v; expect(milaWaitlistEnabled()).toBe(false); }
      process.env.MILA_TF_WAITLIST = "true";
      expect(milaWaitlistEnabled()).toBe(true);
      // A leftover engine value changes nothing.
      for (const e of ["harness", "trueforge", ""]) { process.env.MILA_ENGINE = e; expect(milaWaitlistEnabled()).toBe(true); }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
