/**
 * syntheticFixture.test.ts — the seeded synthetic athlete through the legacy adapters, the
 * deterministic identity resolution and the calculator (spec §31: same evidence, same as_of,
 * same vector). No real athlete data is in the repository; the exact-Mia acceptance run is the
 * `--from legacy` / database mode of socialFeatureVector.ts on dev.
 *
 * When a definition or calculation version changes on purpose, bump the version and update the
 * pinned numbers here in the same PR.
 */

import { syntheticLegacy } from "./testUtils/syntheticLegacy";
import { assembleLegacyBundle } from "./legacyBundle";
import { calculateSocialFeatures, type FeatureRow } from "./features";
import { assertNoSecrets } from "./sanitize";

const AS_OF = "2026-09-09T00:00:00.000Z";

describe("synthetic legacy fixture → features (as_of 2026-09-09, seed 7)", () => {
  const fx = syntheticLegacy({ seed: 7, asOf: AS_OF, days: 45 });
  const b = assembleLegacyBundle({ connections: fx.connections, snapshots: fx.snapshots, media: fx.media });
  const features = calculateSocialFeatures({ identities: b.identities.map((i) => ({ id: i.id, platform: i.platform })), observations: b.observations, distributions: b.distributions, asOf: AS_OF });
  const f = (platform: string | null, key: string, window: number): FeatureRow | undefined => features.find((r) => r.platform === platform && r.featureKey === key && r.windowDays === window);
  const inputsOf = (r: FeatureRow) => r.inputs as { observationIds: Array<number | string>; byClass: Record<string, number>; byMethod: Record<string, number>; denominatorObservationIds?: Array<number | string> };

  it("is deterministic and carries no secret-like strings", () => {
    const again = syntheticLegacy({ seed: 7, asOf: AS_OF, days: 45 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(fx));
    expect(() => assertNoSecrets(fx.snapshots, [], "synthetic snapshots")).not.toThrow();
    expect(() => assertNoSecrets(fx.media, [], "synthetic media")).not.toThrow();
  });

  it("resolves identities deterministically: handle-only rows fold into the connected account, nothing is guessed", () => {
    expect(b.identities.map((i) => `${i.platform}:${i.accountIdKind}`).sort()).toEqual(["instagram:platform_id", "tiktok:platform_id"]);
    expect(b.resolutions["snapshot:account_id"]).toBe(85);      // 45 days × 2 connected platforms, minus the 5 app-scoped-id days
    expect(b.resolutions["snapshot:connected_account"]).toBe(5); // those 5 resolve through the connection linkage, not a new identity
    expect(b.resolutions["snapshot:handle_match"]).toBe(2);      // the discovery row and the research row
    expect(b.resolutions["media:sole_identity"]).toBe(2);        // instagram|connected, tiktok|connected
    expect(b.skipped).toEqual([]);
  });

  it("reports, and does not attach, media whose owner is ambiguous", () => {
    const two = assembleLegacyBundle({
      connections: [...fx.connections, { platform: "instagram", platform_user_id: "17849999999999999", platform_username: "second_account" }],
      snapshots: fx.snapshots.filter((s) => s.platform === "instagram"), media: fx.media.filter((m) => m.platform === "instagram"),
    });
    expect(two.skipped).toEqual([expect.objectContaining({ platform: "instagram", kind: "media", origin: "connected", reason: "ambiguous_platform", rows: fx.media.filter((m) => m.platform === "instagram").length })]);
    expect(two.observations.some((o) => o.sourceMethod === "legacy_media_assets")).toBe(false);
  });

  it("adapts every row into canonical observations and distributions", () => {
    expect(fx.snapshots).toHaveLength(92);
    expect(fx.media).toHaveLength(48);
    expect(b.raw).toHaveLength(92);
    expect(b.observations.length).toBeGreaterThan(5000);
    expect(b.distributions.length).toBeGreaterThan(500);
  });

  it("every feature carries complete lineage and a privacy class independent of authority", () => {
    expect(features.length).toBeGreaterThan(40);
    for (const r of features) {
      const i = inputsOf(r);
      expect(i.observationIds.length).toBeGreaterThan(0);
      expect(Object.values(i.byClass).reduce((a, n) => a + n, 0)).toBe(i.observationIds.length);
      expect(Object.keys(i.byMethod).length).toBeGreaterThan(0);
      expect(r.inputAccessClass).toBe("includes_athlete_private");     // every input here is connected evidence
    }
  });

  it("follower-based ratios carry their denominator observations in the lineage", () => {
    for (const key of ["engagement_per_follower_median", "reach_per_follower_median", "non_follower_reach_share"]) {
      const r = f("instagram", key, 90)!;
      expect(r).toBeDefined();
      const i = inputsOf(r);
      expect(i.denominatorObservationIds!.length).toBeGreaterThan(0);
      for (const id of i.denominatorObservationIds!) expect(i.observationIds).toContain(id);
      const followerIds = new Set(b.observations.filter((o) => o.metricKey === "followers").map((o) => o.id));
      for (const id of i.denominatorObservationIds!) expect(followerIds.has(id)).toBe(true);
    }
    const noDenominator = inputsOf(f("instagram", "interactions_per_reach_median", 90)!);
    expect(noDenominator.denominatorObservationIds).toBeUndefined();
  });

  it("reproduces the pinned vector", () => {
    // Pinned from the first reviewed run; a change here is a change in definitions or calculation.
    expect(features).toHaveLength(117);
    expect(f("instagram", "followers_latest", 0)?.value).toBe(18753);
    expect(f("tiktok", "followers_latest", 0)?.value).toBe(9336);
    expect(f("instagram", "content_n", 90)?.value).toBe(15);
    expect(f("instagram", "reach_median", 90)?.value).toBe(34046);
    expect(f("instagram", "engagement_per_follower_median", 90)?.value).toBe(0.1011);
    expect(f("tiktok", "views_median", 90)?.value).toBe(72579);
    expect(f(null, "platform_breadth", 30)?.value).toBe(2);
  });
});
