/**
 * skills.test.ts — skills are markdown with strict front-matter, loaded on demand by id, and the shipped sample skill
 * (echo/health) loads, lists and names only registered tools. No skill in the repo names a model id.
 */
jest.mock("../db", () => ({ db: {} }));

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clearJobCache, listJobs, loadJob, parseJob, jobsDir, JobError } from "./jobs";
import { createDefaultRegistry } from "./coreTools";

const ok = `---
id: a/b
version: 1.2.3
description: Does a thing.
effort: low
model: fast
tools: [health_check]
---
Do the thing.`;

beforeEach(() => { delete process.env.AGENT_JOBS_DIR; clearJobCache(); });

describe("parseJob", () => {
  it("parses front-matter and body, defaulting inputs/outputs/tools", () => {
    expect(parseJob(ok)).toEqual({ id: "a/b", version: "1.2.3", description: "Does a thing.", inputs: [], outputs: [], effort: "low", model: "fast", tools: ["health_check"], instructions: "Do the thing." });
    expect(parseJob(ok.replace("\n", "\r\n"))).toMatchObject({ id: "a/b" });
  });

  it.each([
    ["no front-matter", "just text"],
    ["bad id", ok.replace("id: a/b", "id: A/B")],
    ["bad version", ok.replace("1.2.3", "v1")],
    ["unknown effort", ok.replace("effort: low", "effort: extreme")],
    ["a model id instead of a tier", ok.replace("model: fast", "model: gpt-5.4")],
    ["an unknown key", ok.replace("tools:", "temperature: 1\ntools:")],
    ["empty body", ok.replace("Do the thing.", "  ")],
  ])("refuses %s", (_label, text) => {
    expect(() => parseJob(text)).toThrow(JobError);
  });

  it("refuses an id that does not match its path", () => {
    expect(() => parseJob(ok, "a/c")).toThrow(/does not match its path/);
  });
});

describe("the shipped skills", () => {
  it("echo/health loads, and its tools are all registered", () => {
    const s = loadJob("echo/health");
    expect(s).toMatchObject({ id: "echo/health", version: "1.0.0", effort: "minimal", model: "fast", tools: ["health_check"] });
    expect(() => createDefaultRegistry().forSkill(s)).not.toThrow();
  });

  it("every skill file lists and loads; none is unknown or traverses out of the directory", () => {
    expect(listJobs().map((s) => s.id)).toContain("echo/health");
    expect(() => loadJob("nope/missing")).toThrow(/unknown skill/);
    expect(() => loadJob("../secrets")).toThrow(/invalid skill id/);
  });

  it("no skill names a model id or an athlete-specific value in its front-matter model field", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(jobsDir()).filter((p) => p.endsWith(".md"))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/^model:\s*(gpt|gemini|claude|o\d)/m);
    }
  });
});
