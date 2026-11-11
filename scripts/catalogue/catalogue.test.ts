/**
 * catalogue.test.ts — CI GUARD for the generated catalogue (scripts/catalogue/build.ts).
 *
 * Fails when the committed docs/catalogue/*.json is not what the repo generates: a PR that changes a prompt, a
 * playbook, a job, a tool, a card or a flag must run `npm run catalogue` and commit the result, so the Prompt Register
 * export (prompt-register.json) never drifts from the served text.
 *
 * Tool display rules are guarded by server/agent/engine/mastra/display.test.ts (every tool Mila can call has a status
 * line and its card types, every card type has a DTO); this suite only checks the catalogue agrees with it.
 * Nothing here reaches a database or a provider: server/db is mocked, and the generator only calls loaders/registries.
 */
jest.mock("../../server/db", () => ({ db: {}, pool: {} }));

import { buildCatalogue, staleFiles, type BuildResult } from "./build";

const root = process.cwd();
let r: BuildResult;

beforeAll(async () => {
  r = await buildCatalogue(root);
});

describe("generated catalogue (CI guard)", () => {
  it("the committed docs/catalogue JSON is current (if this fails: run `npm run catalogue` and commit docs/catalogue)", () => {
    expect(staleFiles(root, r)).toEqual([]);
  });

  it("is not vacuous: every section found something", () => {
    const c = r.catalogue.counts;
    for (const k of ["coreFiles", "coreSurfaces", "skills", "jobs", "tools", "milaTools", "cards", "serverFlags", "clientFlags", "workflows", "internalRoutes", "schedulerJobs", "inProcessCrons"]) {
      expect([k, c[k] > 0]).toEqual([k, true]);
    }
  });

  it("the Prompt Register holds every core part, built surface, playbook and job prompt, each digest over its exact text", () => {
    const ids = new Set(r.register.entries.map((e) => e.id));
    for (const s of r.catalogue.skills) expect(ids.has(s.register_id)).toBe(true);
    for (const j of r.catalogue.jobs.items) expect(ids.has(`job.${j.id}`)).toBe(true);
    for (const b of r.catalogue.core.built) expect(ids.has(b.registerId)).toBe(true);
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    for (const e of r.register.entries) expect([e.id, createHash("sha256").update(e.text).digest("hex")]).toEqual([e.id, e.sha256]);
    const jobDigest = new Map(r.catalogue.jobs.items.map((j) => [`job.${j.id}`, j.promptDigest]));
    for (const e of r.register.entries.filter((x) => x.kind === "job")) expect([e.id, e.sha256]).toEqual([e.id, jobDigest.get(e.id)]);
  });

  it("agrees with the display guard: every tool Mila can call has a display rule, every card type it makes a DTO", () => {
    const tools = r.catalogue.tools.filter((t) => t.milaCallable);
    expect(tools.filter((t) => !t.displayRule).map((t) => t.name)).toEqual([]);
    expect(tools.filter((t) => t.cardTypes.length !== t.cardDtos.length).map((t) => t.name)).toEqual([]);
  });

  it("every Cloud Scheduler job targets a route the server defines", () => {
    expect(r.catalogue.schedulerJobs.filter((j) => !j.routeFound).map((j) => j.path)).toEqual([]);
  });
});
