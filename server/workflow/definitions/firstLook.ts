/**
 * first_look — one run per connected social account, started by the OAuth callback.
 *
 * Replaces the fire-and-forget connect-time fetch with three traced, retried steps:
 *   fetch_social      the existing fetchSocialData, awaited, through the shared writer
 *   backfill_recent   the thirty most recent posts with captions, in parallel
 *   compute_first_look  arithmetic + one model call → athlete_snapshots.first_look
 *
 * Idempotent per connection: the callback passes `connect:<connectionId>` as the key, so a
 * repeated callback returns the same run. Inbox providers (gmail, outlook) never start one.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { athleteSnapshots } from "../../../shared/schema";
import { fetchSocialData } from "../../skills/fetchSocialData";
import { backfillAthletePlatform } from "../../skills/mediaBackfill";
import { enrichTopPostInsights } from "../../skills/enrichTopPostInsights";
import { runFirstLook, FIRST_LOOK_POSTS } from "../../skills/firstLook";
import { defineWorkflow } from "../registry";

export const FIRST_LOOK_PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
type FirstLookPlatform = (typeof FIRST_LOOK_PLATFORMS)[number];

interface FirstLookInput { connectionId: string; platform: FirstLookPlatform }

function inputOf(ctx: { runInput: unknown }): FirstLookInput {
  const i = (ctx.runInput ?? {}) as Partial<FirstLookInput>;
  if (!i.connectionId || !i.platform || !(FIRST_LOOK_PLATFORMS as readonly string[]).includes(i.platform)) {
    throw new Error(`first_look needs { connectionId, platform ∈ ${FIRST_LOOK_PLATFORMS.join("|")} }`);
  }
  return i as FirstLookInput;
}

export const FIRST_LOOK = defineWorkflow({
  process: "first_look",
  version: 1,
  // One active first look per athlete PER PLATFORM: Instagram and TikTok may run at once;
  // two Instagram connects in a row collapse onto one run.
  activeScope: (input) => `first_look:${String((input as any)?.platform ?? "unknown")}`,
  steps: [
    {
      name: "fetch_social",
      kind: "code",
      leaseMs: 3 * 60_000,
      run: async (ctx) => {
        const { connectionId, platform } = inputOf(ctx);
        const athleteId = ctx.athleteId!;
        const latestConnectSnapshot = async () => {
          const [snap] = await db.select({ id: athleteSnapshots.id })
            .from(athleteSnapshots)
            .where(and(eq(athleteSnapshots.athlete_id, athleteId), eq(athleteSnapshots.trigger, "social_connect")))
            .orderBy(desc(athleteSnapshots.created_at)).limit(1);
          return snap?.id ?? null;
        };
        // fetchSocialData returns void and swallows provider errors by design (expired token,
        // rate limit). The proof it did its job is a NEW social_connect snapshot — one that did
        // not exist before the call. Without one this attempt fails and the runner retries.
        const before = await latestConnectSnapshot();
        await fetchSocialData(athleteId, platform, connectionId);
        const after = await latestConnectSnapshot();
        if (!after || after === before) {
          throw new Error(`fetchSocialData produced no new social_connect snapshot for ${platform} (token expired or rate limited?)`);
        }
        return { snapshot_id: after };
      },
    },
    {
      name: "backfill_recent",
      kind: "code",
      parallel: true,
      leaseMs: 3 * 60_000,
      run: async (ctx) => {
        const { platform } = inputOf(ctx);
        const athleteId = ctx.athleteId!;
        const r = await backfillAthletePlatform(athleteId, platform, FIRST_LOOK_POSTS);
        let insights = { enriched: 0, failed: 0 };
        if (platform === "instagram") insights = await enrichTopPostInsights(athleteId).catch(() => ({ enriched: 0, failed: 0 }));
        return { platform, ingested: r.ingested, done: r.done, skipped: r.skipped ?? null, insights };
      },
    },
    {
      name: "compute_first_look",
      kind: "model",
      run: async (ctx) => {
        const { platform } = inputOf(ctx);
        const snapshotId = (ctx.outputs.fetch_social as { snapshot_id: string }).snapshot_id;
        return runFirstLook({ athleteId: ctx.athleteId!, platform, snapshotId });
      },
    },
  ],
});
