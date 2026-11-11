/**
 * backfillSocialSubstrate.ts — populate the social substrate from evidence Nomila already holds.
 *
 *   npx tsx --require dotenv/config server/scripts/backfillSocialSubstrate.ts [--athlete <id>] [--apply] [--features] [--as-of <iso>]
 *
 * Without --apply it counts what it would write and reports every row it would SKIP. With
 * --apply it:
 *   1. identities   — one row per (athlete, platform, platform_user_id) from connected_accounts
 *                     (active, expired and revoked alike: an account is still hers after a
 *                     disconnect, D5), skipping Nomila's own discovery IG account.
 *   2. observations — every social_analytics_snapshots row through adaptLegacySnapshot and every
 *                     social media_assets row through adaptLegacyMediaAsset. Idempotent on the
 *                     observation unique key.
 *   3. --features   — recompute every athlete's feature vector at --as-of (default now).
 *
 * Identity is never guessed (adapters/legacy.ts resolvers): a snapshot row resolves by exact
 * account id, or by a handle that matches exactly one connected identity, or becomes its own
 * identity; a media_assets row (no account linkage) resolves only when its platform has exactly
 * one candidate. Anything ambiguous is reported and left out.
 *
 * Runs regardless of SOCIAL_SUBSTRATE_WRITE (it is the deliberate one-off; the flag gates the
 * live writers). The sanitizer runs on every native value written here.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { athletes, connectedAccounts, mediaAssets, socialAnalyticsSnapshots } from "../../shared/schema";
import { adaptLegacyMediaAsset, adaptLegacySnapshot, legacySourceClass, resolveMediaIdentity, resolveSnapshotIdentity, type KnownIdentity, type LegacyMediaRow, type LegacySnapshotRow } from "../services/intelligence/social/adapters/legacy";
import { attachContentNative, ensureIdentity, listIdentities, openSyncRun, closeSyncRun, writeDistributions, writeObservations } from "../services/intelligence/social/ingest";
import { isSharedDiscoveryAccount } from "../skills/collectSocialAnalytics";
import { recomputeFeatures } from "../services/intelligence/social/substrate";
import type { SourceClass } from "../services/intelligence/types";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FEATURES = args.includes("--features");
const ATHLETE = args.includes("--athlete") ? args[args.indexOf("--athlete") + 1] : null;
const AS_OF = args.includes("--as-of") ? new Date(args[args.indexOf("--as-of") + 1]) : new Date();
const SOCIAL = ["instagram", "tiktok", "youtube"];

type Known = KnownIdentity & { platform: string };

async function main() {
  const roster = await db.select({ id: athletes.id, full_name: athletes.full_name }).from(athletes).where(ATHLETE ? eq(athletes.id, ATHLETE) : undefined as any);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${roster.length} athlete(s)`);
  const totals = { identities: 0, observations: 0, distributions: 0, contentLinked: 0, features: 0, skippedRows: 0 };
  const skipped: string[] = [];
  const resolutions: Record<string, number> = {};
  const count = (k: string) => { resolutions[k] = (resolutions[k] ?? 0) + 1; };

  for (const a of roster) {
    const known: Known[] = [];
    const knownOn = (platform: string) => known.filter((k) => k.platform === platform);
    let dry = 0;
    const newId = () => `dry-${++dry}`;

    // 1. Identities from connected accounts (every status).
    const conns = await db.select().from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, a.id), inArray(connectedAccounts.platform, SOCIAL)));
    for (const c of conns) {
      if (!c.platform_user_id || isSharedDiscoveryAccount(c.platform, c.platform_user_id)) continue;
      const dup = known.find((k) => k.platform === c.platform && k.accountId === c.platform_user_id);
      if (dup) { (dup.connectedAccountIds ??= []).push(c.id); continue; }
      const id = APPLY ? (await ensureIdentity({ athleteId: a.id, platform: c.platform, accountId: c.platform_user_id, accountIdKind: "platform_id", handle: c.platform_username, canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: `oauth_${c.platform}`, connectedAccountId: c.id, verifiedAt: c.last_fetched_at ?? c.created_at ?? new Date() })).id : newId();
      known.push({ id, platform: c.platform, accountId: c.platform_user_id, accountIdKind: "platform_id", handle: c.platform_username, connectedAccountIds: [c.id] }); totals.identities++;
    }

    // 2a. Snapshot rows.
    const snaps = await db.select().from(socialAnalyticsSnapshots).where(eq(socialAnalyticsSnapshots.athlete_id, a.id));
    let obsN = 0, distN = 0, linkedN = 0;
    for (const s of snaps) {
      const { identity, result } = adaptLegacySnapshot(s as unknown as LegacySnapshotRow);
      if (!identity) { skipped.push(`${a.full_name} ${s.platform} snapshot ${s.id}: no account id or handle`); totals.skippedRows++; continue; }
      const sourceClass: SourceClass = legacySourceClass(s.source);
      const r = resolveSnapshotIdentity(knownOn(s.platform), identity, s.connected_account_id);
      let identityId: string;
      if (r.ok) { identityId = r.id; count(`snapshot:${r.via}`); }
      else if (r.reason === "unknown_account") {
        identityId = APPLY ? (await ensureIdentity({ athleteId: a.id, platform: s.platform, ...identity, sourceClass, sourceMethod: "legacy_snapshot", confidence: sourceClass === "connected_verified" ? 1 : 0.7, connectedAccountId: s.connected_account_id, verifiedAt: s.snapshot_date })).id : newId();
        known.push({ id: identityId, platform: s.platform, accountId: identity.accountId, accountIdKind: identity.accountIdKind, handle: identity.handle }); totals.identities++; count("snapshot:new_identity");
      } else { skipped.push(`${a.full_name} ${s.platform} snapshot ${s.id}: ${r.reason} (${r.candidates.join(",")})`); totals.skippedRows++; continue; }
      obsN += result.observations.length; distN += result.distributions.length;
      if (!APPLY) continue;
      const runId = await openSyncRun({ athleteId: a.id, identityId, platform: s.platform, provider: "legacy", endpointFamily: "legacy_snapshot", sourceClass, trigger: "backfill", connectedAccountId: s.connected_account_id });
      const ctx = { athleteId: a.id, platform: s.platform, identityId, sourceClass, sourceMethod: "legacy_snapshot", provider: "legacy", runId, definitionVersion: "legacy/1" };
      const assetIds = await attachContentNative({ athleteId: a.id, platform: s.platform, identityId }, result.content);
      linkedN += assetIds.size;
      const o = await writeObservations(ctx, result.observations, assetIds);
      const d = await writeDistributions(ctx, result.distributions);
      await closeSyncRun(runId, { status: "ok", pages: 1, items: o + d });
    }

    // 2b. media_assets rows (social origins only). Explicit legacy columns so the dry run also
    // works before 0044 has added the new ones.
    const media = await db.select({ id: mediaAssets.id, athlete_id: mediaAssets.athlete_id, platform: mediaAssets.platform, origin: mediaAssets.origin, source_media_id: mediaAssets.source_media_id, parent_media_id: mediaAssets.parent_media_id, media_type: mediaAssets.media_type, permalink: mediaAssets.permalink, posted_at: mediaAssets.posted_at, like_count: mediaAssets.like_count, comments_count: mediaAssets.comments_count, insights: mediaAssets.insights, metadata: mediaAssets.metadata, metadata_updated_at: mediaAssets.metadata_updated_at, ingested_at: mediaAssets.ingested_at })
      .from(mediaAssets).where(and(eq(mediaAssets.athlete_id, a.id), inArray(mediaAssets.platform, SOCIAL), inArray(mediaAssets.origin, ["connected", "discovery"])));
    const groups = new Map<string, typeof media>();
    for (const m of media) { const k = `${m.platform}|${m.origin}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(m); }
    for (const [k, rows] of groups) {
      const [platform, origin] = k.split("|");
      const r = resolveMediaIdentity(knownOn(platform), origin);
      if (!r.ok) { skipped.push(`${a.full_name} ${platform} media origin=${origin} ${rows.length} rows: ${r.reason} (${r.candidates.join(",")})`); totals.skippedRows += rows.length; continue; }
      count(`media:${r.via}`);
      const all = rows.flatMap((m) => adaptLegacyMediaAsset(m as unknown as LegacyMediaRow).observations);
      obsN += all.length;
      if (!APPLY) continue;
      const sourceClass: SourceClass = origin === "connected" ? "connected_verified" : "platform_public";
      const runId = await openSyncRun({ athleteId: a.id, identityId: r.id, platform, provider: "legacy", endpointFamily: "legacy_media_assets", sourceClass, trigger: "backfill" });
      const assetIds = new Map(rows.filter((m) => m.source_media_id).map((m) => [m.source_media_id!, m.id]));
      const o = await writeObservations({ athleteId: a.id, platform, identityId: r.id, sourceClass, sourceMethod: "legacy_media_assets", provider: "legacy", runId, definitionVersion: "legacy/1" }, all, assetIds);
      for (const m of rows) {
        const { contentFormat } = adaptLegacyMediaAsset(m as unknown as LegacyMediaRow);
        await db.update(mediaAssets).set({ content_format: contentFormat, social_identity_id: r.id }).where(eq(mediaAssets.id, m.id));
      }
      await closeSyncRun(runId, { status: "ok", pages: 1, items: o });
    }

    totals.observations += obsN; totals.distributions += distN; totals.contentLinked += linkedN;
    let f = 0;
    if (FEATURES && APPLY) { process.env.SOCIAL_SUBSTRATE_WRITE = "true"; const r = await recomputeFeatures(a.id, AS_OF); f = r?.features ?? 0; totals.features += f; }
    console.log(`  ${a.full_name}: identities=${known.length} snapshots=${snaps.length} media=${media.length} observations~${obsN} distributions~${distN}${FEATURES && APPLY ? ` features=${f}` : ""}`);
  }
  console.log("resolutions", resolutions);
  for (const s of skipped) console.log("  SKIPPED", s);
  console.log(totals);
  if (APPLY) console.log("identities now:", (await Promise.all(roster.map((a) => listIdentities(a.id)))).flat().length);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
