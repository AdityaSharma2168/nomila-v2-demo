/**
 * social_sync — one run per newly connected social account, started alongside first_look by
 * the OAuth callback.
 *
 * Problem this replaces: `trigger: "connect"` has always been a valid SyncTrigger
 * (server/services/intelligence/social/substrate.ts) but nothing ever passed it — the first
 * substrate write for a freshly connected account waited for the 04:30 nightly cron
 * (collectAllAnalyticsSnapshots), up to 24h after connect.
 *
 * This workflow does one thing: call the existing connected-sync entry point,
 * collectSocialAnalytics, with trigger 'connect'. It does not reimplement fetching — that
 * lives in collectSocialAnalytics / the substrate ingest pipeline, which already handles the
 * SOCIAL_SUBSTRATE_WRITE flag (a clean no-op when it's off), token refresh, and marking a
 * connection 'expired' on an auth failure.
 *
 * Idempotent per connection: the callback passes `connect:<connectionId>` as the idempotency
 * key (same pattern as first_look, a different process so the keys never collide — see
 * workflow_runs_idempotency, unique on (process, idempotency_key)), so a repeated callback
 * returns the existing run rather than starting a second one. A step retry re-runs
 * collectSocialAnalytics, which is itself idempotent: social_analytics_snapshots upserts on
 * (athlete, platform, day) and every substrate table underneath it upserts/onConflictDoNothing
 * on its own unique key, so a retry can add a sync_run row but never a duplicate substrate row.
 *
 * Runs alongside first_look (not as a step inside it) so a change here never has to touch
 * first_look's already-live v1 step shape, and a failure/slow sync here can never block or
 * fail the first-look narrative.
 */

import { collectSocialAnalytics } from "../../skills/collectSocialAnalytics";
import { recomputeFeatures } from "../../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../../services/intelligence/social/config";
import { createLogger } from "../../logger";
import { requestEvaluation } from "../../services/marketabilityBeta1Orchestrator";
import { requestMemoryRecompute, syncMemoryMeasured } from "../../services/miaPreview/preview";
import { signupRunWillScore } from "../../agent/onboarding/signupWillScore";
import { defineWorkflow } from "../registry";

const log = createLogger("social-sync");

export const SOCIAL_SYNC_PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
type SocialSyncPlatform = (typeof SOCIAL_SYNC_PLATFORMS)[number];

interface SocialSyncInput { connectionId: string; platform: SocialSyncPlatform }

function inputOf(ctx: { runInput: unknown }): SocialSyncInput {
  const i = (ctx.runInput ?? {}) as Partial<SocialSyncInput>;
  if (!i.connectionId || !i.platform || !(SOCIAL_SYNC_PLATFORMS as readonly string[]).includes(i.platform)) {
    throw new Error(`social_sync needs { connectionId, platform ∈ ${SOCIAL_SYNC_PLATFORMS.join("|")} }`);
  }
  return i as SocialSyncInput;
}

export const SOCIAL_SYNC = defineWorkflow({
  process: "social_sync",
  version: 1,
  // One active sync per athlete PER PLATFORM (mirrors first_look's scope) — distinct string
  // prefix from first_look's `first_look:<platform>` so the two processes' active runs never
  // collide on workflow_runs_one_active, which is keyed on (athlete_id, active_scope) alone.
  activeScope: (input) => `social_sync:${String((input as any)?.platform ?? "unknown")}`,
  steps: [
    {
      name: "collect_analytics",
      kind: "code",
      leaseMs: 3 * 60_000,
      run: async (ctx) => {
        const { connectionId, platform } = inputOf(ctx);
        // Returns null (not a throw) when the platform lacks a provider, the account is the
        // shared discovery lens, the token is dead, or SOCIAL_SUBSTRATE_WRITE is off — all
        // clean no-ops, not failures, so the step still succeeds.
        const saved = await collectSocialAnalytics(connectionId, "connect");
        return { connectionId, platform, saved: !!saved };
      },
    },
  ],
});

/**
 * social_sync v2 — collection is not the finish line. Derived features are.
 *
 * WHAT v1 GOT WRONG, found by the Gate 2A connect-path proof. v1 reported `done` the moment
 * collectSocialAnalytics returned, and its step output said {"saved": true} — truthfully, because
 * OBSERVATIONS had been written. But the authoritative social block does not read observations; it
 * reads social_features (marketabilityBeta1SocialBlock.ts connectedBlock), and skips any platform
 * with no feature rows. recomputeFeatures() had exactly two callers, the 04:30 nightly pass and a
 * backfill script, and neither is the connect path.
 *
 * The measured consequence: reconnecting Mia's YouTube wrote nine fresh observations at 04:43:35,
 * including avg_view_pct_30d — retention evidence that had never been available — and the block
 * re-rendered BYTE-IDENTICAL, still saying "youtube: not available (no confidently resolved
 * account)". The evidence was in the substrate and unreachable by every reader for up to 24 hours.
 *
 * That is the wrong product behaviour, not merely a latency detail. An athlete connects an account
 * because Nomila should become more intelligent immediately; until the nightly pass, onboarding,
 * Mila and M.I.A. would all have gone on reading evidence that predates the connection.
 *
 * So v2's contract is: "social sync completed" = observations collected AND derived features
 * current. Recomputation is a SEPARATE STEP rather than a tail call inside collection, because the
 * two fail for different reasons and a run that collected but could not derive should say so
 * against the step that failed.
 *
 * FAILURE MUST FAIL THE RUN. recomputeFeatures returns null for two unrelated reasons — the write
 * flag being off (a clean no-op) and an internal throw it swallowed — so the step checks the flag
 * itself and treats a null while ENABLED as failure. Reporting `done` on evidence no reader can
 * consume is precisely the green that hid this for a day.
 */
export const SOCIAL_SYNC_V2 = defineWorkflow({
  process: "social_sync",
  version: 2,
  activeScope: (input) => `social_sync:${String((input as any)?.platform ?? "unknown")}`,
  steps: [
    {
      name: "collect_analytics",
      kind: "code",
      leaseMs: 3 * 60_000,
      run: async (ctx) => {
        const { connectionId, platform } = inputOf(ctx);
        const saved = await collectSocialAnalytics(connectionId, "connect");
        return { connectionId, platform, saved: !!saved };
      },
    },
    {
      name: "recompute_features",
      kind: "code",
      // Derivation reads up to 400 days of observations for every identity on the athlete, so it is
      // slower than the collection that preceded it.
      leaseMs: 5 * 60_000,
      run: async (ctx) => {
        if (!ctx.athleteId) throw new Error("social_sync requires an athlete to derive features for");
        // The flag is checked HERE, not inferred from a null return, because recomputeFeatures uses
        // null for both "disabled" and "failed" and only one of those is acceptable.
        if (!substrateWriteEnabled()) {
          // A NEW-AGENT athlete's M.I.A. reads her measured memory facts, which come from the snapshots collected
          // above — not from the substrate — so her recompute does not wait on this flag: measured facts are synced
          // and the existing refresh path is asked (the memory adapter builds its snapshot). No-op for anyone else.
          // One score per sign-up: a sign-up run that has not merged yet scores her with this connect included.
          const held = await signupRunWillScore(ctx.athleteId);
          if (held) return { recomputed: false, reason: "SOCIAL_SUBSTRATE_WRITE is off", miaRunId: null, miaCreated: false, scoredBySignupRun: held };
          const memory = await requestMemoryRecompute(ctx.athleteId)
            .catch((err: any) => { log.error({ athleteId: ctx.athleteId, error: err?.message }, "memory M.I.A. recompute request failed after social_sync"); return null; });
          return { recomputed: false, reason: "SOCIAL_SUBSTRATE_WRITE is off", ...(memory ? { miaRunId: memory.runId, miaCreated: memory.created } : {}) };
        }
        const result = await recomputeFeatures(ctx.athleteId);
        if (!result) throw new Error("feature recomputation failed after a successful sync — the observations landed but no reader can consume them");

        // THE EVIDENCE-CHANGE TRIGGER. Requested HERE and not at the OAuth callback, because this is the first moment
        // the authoritative block CAN have changed: the callback has observations at best, and the block reads
        // features. Asking earlier would evaluate the athlete as they were before their own connect.
        //
        // Requested unconditionally, and "materially changed" is decided downstream rather than guessed here. The
        // 10-minute debounce coalesces a connect cascade into one run, and that run builds a fresh snapshot and
        // compares its digest — so a sync that produced identical evidence costs nothing. A test of materiality at
        // this call site would be a second, weaker opinion about the same question.
        //
        // Never awaited and never fatal: the sync genuinely succeeded, and a scheduling failure must not undo that or
        // trigger a retry that would re-run the provider collection.
        // A new-agent athlete's measured memory facts are refreshed first, so the run reads them too (no-op otherwise).
        await syncMemoryMeasured(ctx.athleteId)
          .catch((err: any) => { log.error({ athleteId: ctx.athleteId, error: err?.message }, "measured memory sync failed after social_sync"); });
        // One score per sign-up (agent/onboarding/signupWillScore.ts): while her sign-up run has not merged yet, its own
        // mia_preview step is the score and will read these features — a second evaluation here would score the same
        // evidence again and could replace the score she was just emailed.
        const held = await signupRunWillScore(ctx.athleteId);
        if (held) {
          return { recomputed: true, features: result.features, identities: result.identities, observations: result.observations, miaRunId: null, miaCreated: false, scoredBySignupRun: held };
        }
        const evaluation = await requestEvaluation({ athleteId: ctx.athleteId, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" })
          .catch((err: any) => { log.error({ athleteId: ctx.athleteId, error: err?.message }, "mia evaluation request failed after social_sync"); return null; });

        return { recomputed: true, features: result.features, identities: result.identities, observations: result.observations, miaRunId: evaluation?.runId ?? null, miaCreated: evaluation?.created ?? false };
      },
    },
  ],
});
