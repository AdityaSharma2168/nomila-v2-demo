/**
 * flagDecoupling.test.ts — research-acquisition architecture D3: provider binding and substrate persistence are
 * independent switches. (The third, the legacy Kimi dual-write RESEARCH_LEGACY_DUAL_WRITE, was removed with the
 * dual-write itself.)
 *
 *   (a) RESEARCH_SUBSTRATE_WRITE — may persistResearchRun write. Turns nothing else on.
 *   (b) researchPlannerExecutionEnabled (RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE) — admin rerouting and
 *       the monthly-sweep suppression key off it; RESEARCH_REFRESH_PROVIDER picks the refresh binding ("kimi" default,
 *       "direct" binds research_refresh v3 (PR E2a): the v2 refresh refuses under it, a v3 step refuses under "kimi").
 *
 * No database and no provider: db, the provider adapters and the refresh service are stubs.
 */

jest.mock("../../../db", () => ({ db: {}, pool: {} }));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../lib/research/providers/kimiExtract", () => ({ extractWithCitations: jest.fn() }));
jest.mock("../../../lib/research/providers/geminiGrounded", () => ({ toSearchEnvelope: jest.fn(), groundedSearch: jest.fn(), GEMINI_PROVIDER_ID: "gemini_grounded" }));
jest.mock("../../../lib/research/providers/signals", () => ({ trendsEnvelope: jest.fn(), gdeltEnvelope: jest.fn() }));
jest.mock("../../../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../../../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
jest.mock("../../../lib/trends", () => ({ fetchGoogleTrends: jest.fn() }));
jest.mock("../../../lib/gdelt", () => ({ fetchGdelt: jest.fn() }));
jest.mock("./refresh", () => ({ refreshAthlete: jest.fn(async () => ({ ok: true, researchRunId: "rr", status: "ok" })) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { researchPlannerExecutionEnabled, researchRefreshProviderBinding, researchSubstrateWriteEnabled } from "./config";
import { REAL_REFRESH_PROVIDERS, REAL_V3_PROVIDERS, resolveRefreshBinding, resolveRefreshProviders, runResearchRefresh, runResearchRefreshV3Query, runResearchRefreshV3Signals } from "../../../skills/researchRefresh";
// The provider boundary, as mocked above (requireMock: this suite never imports a provider module itself).
const { geminiDirect } = jest.requireMock("../../../lib/research/providers/geminiDirect") as { geminiDirect: jest.Mock };
const { fetchGoogleTrends } = jest.requireMock("../../../lib/trends") as { fetchGoogleTrends: jest.Mock };
const { fetchGdelt } = jest.requireMock("../../../lib/gdelt") as { fetchGdelt: jest.Mock };
import { resolveV3Plan } from "./v3Stage";
import { refreshAthlete } from "./refresh";

const FLAGS = ["RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"] as const;
const env = process.env;
const setFlags = (f: Partial<Record<(typeof FLAGS)[number], string>>) => {
  process.env = { ...env };
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, f);
};
afterEach(() => { process.env = env; jest.clearAllMocks(); });

const tf = (b: boolean) => (b ? "true" : "false");
/** Execution (admin reroute, sweep no-op) = R && S. */
const before = (s: boolean, r: boolean) => ({ persist: s, execution: r && s });
const after = () => ({ persist: researchSubstrateWriteEnabled(), execution: researchPlannerExecutionEnabled() });

describe("the truth table", () => {
  it("execution (admin reroute, sweep suppression) needs both switches; persistence does not imply it", () => {
    for (const s of [false, true]) for (const r of [false, true]) {
      setFlags({ RESEARCH_SUBSTRATE_WRITE: tf(s), RESEARCH_REFRESH_ENABLED: tf(r) });
      expect(after()).toEqual({ persist: s, execution: r && s });
    }
  });

  it("substrate on alone ⇒ persistence only: no planner execution (admin not rerouted, sweep not suppressed)", () => {
    setFlags({ RESEARCH_SUBSTRATE_WRITE: "true" });
    expect(after()).toEqual({ persist: true, execution: false });
  });

  it("all-false (and all-unset) ⇒ identical to before D3", () => {
    for (const f of [{}, { RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_ENABLED: "false", RESEARCH_REFRESH_PROVIDER: "kimi" }]) {
      setFlags(f);
      expect(after()).toEqual(before(false, false));
      expect(researchRefreshProviderBinding()).toBe("kimi");
    }
  });

  it("dev yaml runs research v3 on the direct binding (approved 1 Oct 2026)", () => {
    const doc = parse(readFileSync(join(__dirname, "..", "..", "..", "..", "gcp", "cloud-run-dev.yaml"), "utf8"));
    const deployed = Object.fromEntries((doc.spec.template.spec.containers[0].env as { name: string; value?: string }[]).filter((e) => (FLAGS as readonly string[]).includes(e.name)).map((e) => [e.name, e.value]));
    expect(deployed).toEqual({ RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_ENABLED: "true", RESEARCH_REFRESH_PROVIDER: "direct" });
    setFlags(deployed);
    expect(researchRefreshProviderBinding()).toBe("direct");
  });

  // Stage 1 (owner, 25 Oct 2026): prod persists research (substrate on) on the direct binding; the planner still does not
  // execute (RESEARCH_REFRESH_ENABLED stays off), so no admin reroute and no sweep suppression.
  it("the deployed flag values (prod yaml): persistence on, no planner execution, the direct binding", () => {
    for (const file of ["cloud-run-prod.yaml"]) {
      const doc = parse(readFileSync(join(__dirname, "..", "..", "..", "..", "gcp", file), "utf8"));
      const deployed = Object.fromEntries((doc.spec.template.spec.containers[0].env as { name: string; value?: string }[]).filter((e) => (FLAGS as readonly string[]).includes(e.name)).map((e) => [e.name, e.value]));
      expect(deployed).toEqual({ RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_ENABLED: "false", RESEARCH_REFRESH_PROVIDER: "direct" });
      setFlags(deployed);
      expect(after()).toEqual({ persist: true, execution: false });
      expect(researchRefreshProviderBinding()).toBe("direct");
    }
  });
});

describe("the refresh provider binding", () => {
  it("unset or kimi ⇒ the v2 binding", () => {
    setFlags({});
    expect(resolveRefreshProviders()).toBe(REAL_REFRESH_PROVIDERS);
    setFlags({ RESEARCH_REFRESH_PROVIDER: "kimi" });
    expect(resolveRefreshProviders()).toBe(REAL_REFRESH_PROVIDERS);
  });

  it("direct ⇒ resolves to research_refresh v3 (PR E2a); the v2 refresh still refuses to run under it, before the refresh service", async () => {
    setFlags({ RESEARCH_REFRESH_PROVIDER: "direct", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_ENABLED: "true" });
    expect(researchRefreshProviderBinding()).toBe("direct");
    expect(resolveRefreshBinding()).toEqual({ binding: "direct", version: 3, providers: REAL_V3_PROVIDERS });
    expect(REAL_V3_PROVIDERS.trends).toBe(REAL_REFRESH_PROVIDERS.trends);   // the v2 signals lane, unchanged (D13)
    expect(REAL_V3_PROVIDERS.gdelt).toBe(REAL_REFRESH_PROVIDERS.gdelt);
    expect(() => resolveRefreshProviders()).toThrow(/binds research_refresh v3; a v2 refresh refuses/);
    await expect(runResearchRefresh({ athleteId: "a1", domains: ["press"], trigger: "ttl" })).rejects.toThrow(/binds research_refresh v3/);
    expect(refreshAthlete).not.toHaveBeenCalled();
  });

  it("kimi (the deployed value) ⇒ v2; a v3 step refuses before any provider or the stage", async () => {
    for (const f of [{}, { RESEARCH_REFRESH_PROVIDER: "kimi", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_ENABLED: "true" }]) {
      setFlags(f);
      expect(resolveRefreshBinding()).toEqual({ binding: "kimi", version: 2, providers: REAL_REFRESH_PROVIDERS });
      await expect(runResearchRefreshV3Query({ athleteId: "a1", workflowRunId: "w1", plan: resolveV3Plan({}), prior: [] }, "Q1")).rejects.toThrow(/runs only under RESEARCH_REFRESH_PROVIDER=direct/);
      await expect(runResearchRefreshV3Signals({ athleteId: "a1", workflowRunId: "w1", plan: resolveV3Plan({}), prior: [] })).rejects.toThrow(/runs only under RESEARCH_REFRESH_PROVIDER=direct/);
    }
    expect(geminiDirect).not.toHaveBeenCalled();
    expect(fetchGoogleTrends).not.toHaveBeenCalled();
    expect(fetchGdelt).not.toHaveBeenCalled();
  });

  it("an unknown value ⇒ fails closed", async () => {
    setFlags({ RESEARCH_REFRESH_PROVIDER: "some-unknown-provider" });
    expect(() => researchRefreshProviderBinding()).toThrow(/not a known provider binding/);
    await expect(runResearchRefresh({ athleteId: "a1", domains: ["press"], trigger: "ttl" })).rejects.toThrow(/not a known provider binding/);
    expect(refreshAthlete).not.toHaveBeenCalled();
  });

  it("kimi ⇒ the refresh service gets the v2 providers", async () => {
    setFlags({});
    await runResearchRefresh({ athleteId: "a1", domains: ["press"], trigger: "ttl" });
    expect(refreshAthlete).toHaveBeenCalledWith(expect.objectContaining({ athleteId: "a1" }), REAL_REFRESH_PROVIDERS);
  });
});
