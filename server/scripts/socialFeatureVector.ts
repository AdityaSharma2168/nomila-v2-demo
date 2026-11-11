/**
 * socialFeatureVector.ts — RAW → OBSERVATIONS → FEATURES for one athlete at one as_of, so every
 * number can be inspected and explained (Step 1 design §9; spec §31 "one reproducible command").
 *
 *   # acceptance on dev, from the substrate tables (after 0044 + the backfill):
 *   npx tsx --require dotenv/config server/scripts/socialFeatureVector.ts --athlete <id> --as-of 2026-09-09T00:00:00Z [--out f.json] [--explain <feature_key>]
 *   # acceptance on dev BEFORE the substrate exists: the athlete's real legacy rows through the same adapters, in memory:
 *   npx tsx --require dotenv/config server/scripts/socialFeatureVector.ts --athlete <id> --from legacy --as-of ...
 *   # no database: the seeded synthetic athlete (what CI pins), or a local export directory (never committed):
 *   npx tsx server/scripts/socialFeatureVector.ts --synthetic --as-of ...
 *   npx tsx server/scripts/socialFeatureVector.ts --fixtures <dir> --as-of ...
 *
 * Nothing is fetched and nothing is written in any mode. Output: { asOf, mode, identities, raw,
 * observations, skipped, features, explain? }; every feature row carries its inputs (observation
 * ids, per-class and per-method counts, denominators) and its input_access_class.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LegacyMediaRow, LegacySnapshotRow } from "../services/intelligence/social/adapters/legacy";
import { assembleLegacyBundle, type LegacyBundle, type LegacyConnection } from "../services/intelligence/social/legacyBundle";
import { calculateSocialFeatures, type FeatureDistribution, type FeatureObservation, type FeatureRow } from "../services/intelligence/social/features";
import { METRIC_DEFINITION_VERSION } from "../services/intelligence/social/metrics";

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const ATHLETE = opt("--athlete"); const FIXTURES = opt("--fixtures"); const OUT = opt("--out"); const EXPLAIN = opt("--explain");
const SYNTHETIC = args.includes("--synthetic"); const FROM = opt("--from") ?? "substrate"; const STORIES = args.includes("--stories");
const AS_OF = new Date(opt("--as-of") ?? new Date().toISOString());

interface Bundle {
  identities: Array<{ id: string; platform: string; accountId: string; handle: string | null; sourceClass: string }>;
  raw: Array<{ platform: string; family: string; observedAt: string; bytes: number; hash?: string }>;
  observations: FeatureObservation[];
  distributions: FeatureDistribution[];
  skipped: LegacyBundle["skipped"];
  resolutions?: Record<string, number>;
}

const fromLegacyRows = (connections: LegacyConnection[], snapshots: LegacySnapshotRow[], media: LegacyMediaRow[], isShared?: (p: string, a: string) => boolean): Bundle => {
  const b = assembleLegacyBundle({ connections, snapshots, media, isSharedAccount: isShared });
  return { identities: b.identities.map((i) => ({ id: i.id, platform: i.platform, accountId: i.accountId, handle: i.handle, sourceClass: i.sourceClass })), raw: b.raw, observations: b.observations, distributions: b.distributions, skipped: b.skipped, resolutions: b.resolutions };
};

async function fromSubstrate(athleteId: string): Promise<Bundle> {
  const { db } = await import("../db");
  const { and, eq, gte, lte } = await import("drizzle-orm");
  const { rawSourcePayloads } = await import("../../shared/schema");
  const { listIdentities, loadDistributions, loadObservations } = await import("../services/intelligence/social/ingest");
  const from = new Date(AS_OF.getTime() - 400 * 86_400_000);
  const identities = (await listIdentities(athleteId)).map((i) => ({ id: i.id, platform: i.platform, accountId: i.account_id, handle: i.handle, sourceClass: i.source_class }));
  const payloads = await db.select({ platform: rawSourcePayloads.platform, family: rawSourcePayloads.endpoint_family, fetched_at: rawSourcePayloads.fetched_at, bytes: rawSourcePayloads.bytes, hash: rawSourcePayloads.payload_hash })
    .from(rawSourcePayloads).where(and(eq(rawSourcePayloads.athlete_id, athleteId), gte(rawSourcePayloads.fetched_at, from), lte(rawSourcePayloads.fetched_at, AS_OF)));
  return { identities, raw: payloads.map((p) => ({ platform: p.platform, family: p.family, observedAt: p.fetched_at.toISOString(), bytes: p.bytes ?? 0, hash: p.hash })), observations: await loadObservations(athleteId, from, AS_OF), distributions: await loadDistributions(athleteId, from, AS_OF), skipped: [] };
}

/** The athlete's real legacy rows on the connected database, through the same adapters and resolvers as the backfill. */
async function fromLegacyDb(athleteId: string): Promise<Bundle> {
  const { db } = await import("../db");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { connectedAccounts, mediaAssets, socialAnalyticsSnapshots } = await import("../../shared/schema");
  const { isSharedDiscoveryAccount } = await import("../skills/collectSocialAnalytics");
  const SOCIAL = ["instagram", "tiktok", "youtube"];
  const conns = await db.select({ id: connectedAccounts.id, platform: connectedAccounts.platform, platform_user_id: connectedAccounts.platform_user_id, platform_username: connectedAccounts.platform_username }).from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, athleteId), inArray(connectedAccounts.platform, SOCIAL)));
  const snaps = await db.select().from(socialAnalyticsSnapshots).where(eq(socialAnalyticsSnapshots.athlete_id, athleteId));
  const media = await db.select({ id: mediaAssets.id, athlete_id: mediaAssets.athlete_id, platform: mediaAssets.platform, origin: mediaAssets.origin, source_media_id: mediaAssets.source_media_id, parent_media_id: mediaAssets.parent_media_id, media_type: mediaAssets.media_type, permalink: mediaAssets.permalink, posted_at: mediaAssets.posted_at, like_count: mediaAssets.like_count, comments_count: mediaAssets.comments_count, insights: mediaAssets.insights, metadata: mediaAssets.metadata, metadata_updated_at: mediaAssets.metadata_updated_at, ingested_at: mediaAssets.ingested_at })
    .from(mediaAssets).where(and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.platform, SOCIAL), inArray(mediaAssets.origin, ["connected", "discovery"])));
  return fromLegacyRows(conns, snaps as unknown as LegacySnapshotRow[], media as unknown as LegacyMediaRow[], isSharedDiscoveryAccount);
}

function fromFixtureDir(dir: string): Bundle {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const connections: LegacyConnection[] = (() => { try { return read("connections.json"); } catch { return []; } })();
  return fromLegacyRows(connections, read("snapshots.json"), read("media.json"));
}

async function fromSynthetic(): Promise<Bundle> {
  const { syntheticLegacy } = await import("../services/intelligence/social/testUtils/syntheticLegacy");
  const fx = syntheticLegacy({ seed: 7, asOf: AS_OF.toISOString(), days: 45 });
  return fromLegacyRows(fx.connections, fx.snapshots, fx.media);
}

function summarize(obs: FeatureObservation[]) {
  const by: Record<string, number> = {};
  for (const o of obs) { const k = `${o.platform}.${o.entityType}.${o.metricKey}@${o.sourceClass}`; by[k] = (by[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(by).sort());
}

async function main() {
  const mode = SYNTHETIC ? "synthetic" : FIXTURES ? "fixtures" : ATHLETE ? (FROM === "legacy" ? "legacy-db" : "substrate") : null;
  if (!mode) { console.error("need --athlete <id> [--from legacy], --synthetic, or --fixtures <dir>"); process.exit(2); }
  const bundle = mode === "synthetic" ? await fromSynthetic() : mode === "fixtures" ? fromFixtureDir(FIXTURES!) : mode === "legacy-db" ? await fromLegacyDb(ATHLETE!) : await fromSubstrate(ATHLETE!);
  const features: FeatureRow[] = calculateSocialFeatures({ identities: bundle.identities.map((i) => ({ id: i.id, platform: i.platform })), observations: bundle.observations, distributions: bundle.distributions, asOf: AS_OF.toISOString() });
  const out: Record<string, unknown> = {
    asOf: AS_OF.toISOString(), mode, definitionVersion: METRIC_DEFINITION_VERSION,
    identities: bundle.identities, resolutions: bundle.resolutions ?? null, skipped: bundle.skipped,
    raw: { payloads: bundle.raw.length, bytes: bundle.raw.reduce((a, r) => a + r.bytes, 0), byFamily: bundle.raw.reduce<Record<string, number>>((m, r) => { const k = `${r.platform}.${r.family}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}) },
    observations: { count: bundle.observations.length, distributions: bundle.distributions.length, byMetric: summarize(bundle.observations) },
    features: features.map((f) => ({ platform: f.platform, key: f.featureKey, window: f.windowDays, value: f.value ?? f.valueJson, unit: f.unit, n: f.n, sourceClass: f.sourceClass, inputAccessClass: f.inputAccessClass, confidence: f.confidence, inputs: f.inputs })),
  };
  if (EXPLAIN) {
    out.explain = features.filter((f) => f.featureKey === EXPLAIN).map((f) => {
      const ids = new Set(((f.inputs as any).observationIds ?? []) as Array<number | string>);
      return { platform: f.platform, window: f.windowDays, value: f.value ?? f.valueJson, sourceClass: f.sourceClass, inputAccessClass: f.inputAccessClass, inputs: f.inputs,
        observations: bundle.observations.filter((o) => o.id != null && ids.has(o.id)).map((o) => ({ id: o.id, entity: `${o.entityType}:${o.entityId}`, metric: o.metricKey, value: o.value, class: o.sourceClass, method: o.sourceMethod, observedAt: o.observedAt, entityTime: o.entityTime })) };
    });
  }
  const text = JSON.stringify(out, null, 1);
  if (OUT) { writeFileSync(OUT, text); console.log(`written ${OUT}`); }
  console.log(`mode ${mode} · as_of ${out.asOf} · identities ${bundle.identities.length} · raw ${bundle.raw.length} · observations ${bundle.observations.length} · distributions ${bundle.distributions.length} · features ${features.length} · skipped ${bundle.skipped.length}`);
  if (bundle.resolutions) console.log("resolutions", bundle.resolutions);
  for (const s of bundle.skipped) console.log(`  SKIPPED ${s.platform} ${s.kind} origin=${s.origin} rows=${s.rows}: ${s.reason} ${s.candidates.join(",")}`);
  console.log(features.filter((f) => f.value != null).map((f) => `${(f.platform ?? "*").padEnd(9)} ${f.featureKey.padEnd(34)} w${String(f.windowDays).padStart(3)}  ${String(f.value).padStart(12)}  n=${String(f.n ?? "").padStart(3)}  ${f.sourceClass.padEnd(18)} ${f.inputAccessClass.padEnd(24)} c=${f.confidence}`).join("\n"));
  if (EXPLAIN) console.log(JSON.stringify(out.explain, null, 1));
  if (STORIES) {
    // Step 1b ledger: every Story (entity_format = story) with each reading by age since posting.
    const byStory = new Map<string, FeatureObservation[]>();
    for (const o of bundle.observations) if (o.entityFormat === "story") (byStory.get(o.entityId) ?? byStory.set(o.entityId, []).get(o.entityId)!).push(o);
    console.log(`\nSTORIES ${byStory.size}`);
    for (const [id, rows] of byStory) {
      const posted = rows[0].entityTime ? Date.parse(rows[0].entityTime) : NaN;
      const byRead = new Map<string, Record<string, number>>();
      for (const o of rows) (byRead.get(o.observedAt) ?? byRead.set(o.observedAt, {}).get(o.observedAt)!)[o.metricKey] = o.value;
      console.log(`story ${id} posted ${rows[0].entityTime ?? "?"} readings ${byRead.size}`);
      for (const [at, m] of [...byRead.entries()].sort()) console.log(`   age ${Number.isNaN(posted) ? "?" : ((Date.parse(at) - posted) / 3_600_000).toFixed(1).padStart(5)} h  ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
