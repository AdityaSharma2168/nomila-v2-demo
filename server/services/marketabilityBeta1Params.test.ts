/**
 * marketabilityBeta1Params.test.ts — the versioned Beta.1 bundle round-trips through model_params (existing families only),
 * a missing family is named rather than defaulted, and the v0 drafts validate. Then the service produces a real Beta.1
 * result for an athlete with no evidence at all (every sub-signal on its prior) — the honest first pass.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { __resetSubstrateParamsCache } from "./intelligence/social/config";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";
import { Beta1ParamsError, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, loadBeta1Params, seedBeta1Params } from "./marketabilityBeta1Params";
import { validateNormalizationBundle } from "./marketabilityBeta1Normalization";
import { scoreAthleteBeta1 } from "./marketabilityBeta1Service";

beforeAll(async () => { await initTestDb(); __resetSubstrateParamsCache(); });
afterAll(closeTestDb);

describe("Beta.1 parameter bundle (Slice D)", () => {
  it("names the missing family instead of defaulting", async () => {
    await expect(loadBeta1Params()).rejects.toThrow(Beta1ParamsError);
    await expect(loadBeta1Params()).rejects.toThrow(/marketability.*no active row/);
  });

  it("seeds drafts idempotently, activates, and loads a validated bundle from the existing families", async () => {
    const first = await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, activate: false });
    const again = await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, activate: true });
    expect(again).toEqual({ ...first, activated: true });
    const l = await loadBeta1Params();
    expect(l.params.version).toBe(`${MARKETABILITY_BETA1_FROZEN_PARAMS.version}+${BETA1_LOOKUPS_V1.version}+${BETA1_POLICY_V0.version}`);
    expect(l.params.config.dimensionWeights).toEqual(MARKETABILITY_BETA1_FROZEN_PARAMS.config.dimensionWeights);   // frozen weights untouched
    expect((l.params.config as any).normalization).toBeUndefined();   // normalization lives beside the engine config, not inside the engine params
    expect(l.bundle.lookups.lookups.map((x) => x.signal)).toContain("athletic_authority.competition_level");
    expect(l.bundle.priors).toEqual(BETA1_PRIORS_V1);
    expect(l.bundle.cohorts.tables).toEqual([]);
    expect(l.bundle.freshnessDays.web_researched).toBeGreaterThan(0);   // from the signals substrate defaults (no signals row active)
    expect(() => validateNormalizationBundle(l.bundle)).not.toThrow();
    expect(l.versions).toMatchObject({ cohorts: "cohorts-v0-empty", priors: "priors-v1", lookups: "lookups-v1", policy: "policy-v0" });
  });

  it("scores an athlete with no evidence: every sub-signal on its prior, a real 0–850 number, deterministic", async () => {
    const athleteId = await seedAthlete("Prior Only");
    const a = await scoreAthleteBeta1(athleteId, { asOf: new Date("2026-09-13T00:00:00.000Z") });
    expect(a).not.toBeNull();
    expect(a!.totalSignals).toBe(44);
    expect(a!.imputedSignals).toBe(44);
    expect(a!.evidenceSignals).toBe(0);
    expect(a!.drivers).toEqual([]);
    expect(a!.result.dimensions).toHaveLength(8);
    // neutral priors (50, confidence 0.3) everywhere except brand_safety (global prior 85, confidence 0.4)
    const cfg = MARKETABILITY_BETA1_FROZEN_PARAMS.config;
    const wSafety = cfg.subWeights.brand_fit.brand_safety;
    const bf = 50 * (1 - wSafety) + 85 * wSafety, bfConf = 30 * (1 - wSafety) + 40 * wSafety;
    for (const d of a!.result.dimensions) expect(d.score).toBeCloseTo(d.dimension === "brand_fit" ? bf : 50, 1);
    const composite = 50 * (1 - cfg.dimensionWeights.brand_fit) + bf * cfg.dimensionWeights.brand_fit;
    expect(a!.result.composite).toBeCloseTo(composite, 1);
    expect(a!.result.score).toBe(Math.round(850 * Math.pow(a!.result.composite / 100, cfg.mapping.exponent)));
    expect(a!.result.confidence).toBeCloseTo(30 * (1 - cfg.dimensionWeights.brand_fit) + bfConf * cfg.dimensionWeights.brand_fit, 0);
    // only the five lookup-backed (categorical) paths are "ready" as parameters; every quantitative path lacks a cohort table and every other path an evidence channel
    expect(a!.readiness.filter((r) => r.ready).map((r) => r.path).sort()).toEqual(BETA1_LOOKUPS_V1.lookups.map((l) => l.signal).sort());   // the 13 lookup-backed paths
    expect(a!.readiness.filter((r) => r.kind === "quantitative" && r.cohortTables === 0)).toHaveLength(10);
    const b = await scoreAthleteBeta1(athleteId, { asOf: new Date("2026-09-13T00:00:00.000Z") });
    expect({ ...b!.result, provenance: null }).toEqual({ ...a!.result, provenance: null });   // identical except the context build timestamp
    expect(await scoreAthleteBeta1("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
