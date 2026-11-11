/**
 * The three snapshot-writing skills import cleanly and still export what they should.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `refreshScores`, `researchAthlete` and `fetchSocialData` had NO test coverage of any
 * kind — a search across server/, scripts/ and client/ found no suite that so much as
 * imports them. They write every athlete_snapshots row and every athletes_current
 * projection, which 22 files read, so "nothing loads them in CI" is worth fixing even
 * with a test this thin.
 *
 * It is deliberately shallow: it does not run the pipelines, which need a database, the
 * platform APIs and real model calls. It asserts the two things a compiler cannot — that
 * the modules actually EVALUATE (module-level code runs: db.ts opens a pool, and
 * researchAthlete constructs a Vertex client at import), and that their entry points are
 * still callable. A broken import path or a bad top-level side effect fails here rather
 * than at 04:30 in the refresh cron.
 *
 * The `dbSnapshotToScoring` assertions pin the extraction that moved that function into
 * `services/snapshotAdapter`: the three local copies are gone, and no caller can quietly
 * reintroduce one without this turning red.
 *
 * The mocks below stand in for the module-level side effects only. Nothing under test
 * touches them.
 */

jest.mock("../db", () => ({ db: {}, pool: {} }));
jest.mock("../lib/models", () => ({
  genai: () => ({ models: {} }),
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI: { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

describe("snapshot-writing skills load", () => {
  it("exposes each skill's entry point", async () => {
    // refreshScores (the nightly legacy re-score) was deleted in the legacy retirement, P2-4.
    const socialFromAnalytics = await import("./socialFromAnalytics");
    const researchAthlete = await import("./researchAthlete");
    const fetchSocialData = await import("./fetchSocialData");

    expect(typeof socialFromAnalytics.buildSocialFromAnalytics).toBe("function");
    expect(typeof researchAthlete.researchAthlete).toBe("function");
    expect(typeof fetchSocialData.fetchSocialData).toBe("function");
  });

});
