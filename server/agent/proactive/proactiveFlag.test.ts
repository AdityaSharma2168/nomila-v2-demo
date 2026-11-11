/**
 * proactiveFlag.test.ts — MILA_PROACTIVE is pinned ON in dev (back on 28 Oct 2026 with the SPEAK/SILENT/DEFER decision fix, #1161) and OFF in prod (exactly once each); only the exact string "true" turns it on, and nothing
 * else is needed (no MILA_ENGINE since Mastra-only PR 2; no MILA_TF_CHAT or NOMILA_MCP_ENABLED since P1, 5 Nov 2026). With it off, emitAthleteEvent writes nothing and routeToMila hands the push back to the caller.
 */
jest.mock("../../db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { milaProactiveEnabled } from "./config";
import { emitAthleteEvent, routeToMila } from "./events";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);
const KEYS = ["MILA_PROACTIVE", "MILA_ENGINE", "MILA_TF_CHAT", "NOMILA_MCP_ENABLED"] as const;

describe("MILA_PROACTIVE", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to %s, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "MILA_PROACTIVE")).toEqual([{ name: "MILA_PROACTIVE", value }]);
  });

  it("only the exact string \"true\" (no MILA_ENGINE, MILA_TF_CHAT or /mcp needed; a leftover engine value changes nothing)", () => {
    for (const k of KEYS) delete process.env[k];
    for (const v of ["", "false", "TRUE", "1", " true"]) { process.env.MILA_PROACTIVE = v; expect(milaProactiveEnabled()).toBe(false); }
    process.env.MILA_PROACTIVE = "true";
    expect(milaProactiveEnabled()).toBe(true);
    for (const e of ["harness", "trueforge"]) { process.env.MILA_ENGINE = e; expect(milaProactiveEnabled()).toBe(true); }
  });

  it("off: nothing is logged and the caller keeps its own push", async () => {
    delete process.env.MILA_PROACTIVE;
    const start = jest.fn();
    const e = { athleteId: "dd1a8a80-d31b-423a-a572-9d146716cb0f", kind: "brand_reply" as const, dedupeKey: "brand_reply:x:y" };
    expect(await emitAthleteEvent(e, { start })).toBeNull();
    expect(routeToMila(e)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
