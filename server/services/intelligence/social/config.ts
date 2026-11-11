/**
 * social/config.ts — the substrate flag and its versioned parameters.
 *
 * SOCIAL_SUBSTRATE_WRITE (default off) gates every write into the substrate tables. Off, the
 * code path is the pre-Step-1a one byte for byte. On, the daily collectors, the backfill tick
 * and the top-post enrichment write observations beside their existing writes; a failure in
 * the substrate is logged on the sync run and never fails the old write.
 *
 * Parameters (retention days, feature windows, freshness) come from the ACTIVE
 * model_params row of family `signals` when one exists, else from the approved alpha
 * defaults below (decisions D2, D6; Step 1 design §5–6). Reading an active row only — a draft
 * is never consulted.
 */

import { getActiveParams } from "../params";
import { DEFAULT_FRESHNESS, DEFAULT_WINDOWS, type FeatureWindows } from "./features";
import type { FreshnessDays } from "./resolve";
import { createLogger } from "../../../logger";

const logger = createLogger("social-substrate");

export const SIGNALS_SCHEMA_VERSION = "signals-config/1";

export interface SubstrateParams {
  /** Days a raw payload is kept, by source class (D2). */
  rawRetentionDays: { connected_verified: number; platform_public: number; web_researched: number };
  windows: FeatureWindows;
  freshnessDays: FreshnessDays;
  /** Step 1b: Story sweep cadence and the age (hours) from which a last look is due. */
  stories: { sweepHours: number; lastLookHours: number };
}

export const DEFAULT_SUBSTRATE_PARAMS: SubstrateParams = {
  rawRetentionDays: { connected_verified: 180, platform_public: 90, web_researched: 90 },
  windows: DEFAULT_WINDOWS,
  freshnessDays: DEFAULT_FRESHNESS,
  stories: { sweepHours: 8, lastLookHours: 22 },
};

export function substrateWriteEnabled(): boolean {
  return process.env.SOCIAL_SUBSTRATE_WRITE === "true";
}

/** Step 1b: Instagram Story sweeps and last looks write only when SOCIAL_STORIES_WRITE=true (its own flag, independent of SOCIAL_SUBSTRATE_WRITE). */
export function storiesWriteEnabled(): boolean {
  return process.env.SOCIAL_STORIES_WRITE === "true";
}

let cached: { at: number; params: SubstrateParams } | null = null;
const TTL_MS = 60_000;

/** The effective parameters: active `signals` row over the defaults, cached a minute. */
export async function getSubstrateParams(): Promise<SubstrateParams> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.params;
  let params = DEFAULT_SUBSTRATE_PARAMS;
  try {
    const row = await getActiveParams("signals");
    if (row && row.schema_version === SIGNALS_SCHEMA_VERSION) {
      const c = row.config as Partial<SubstrateParams>;
      params = {
        rawRetentionDays: { ...DEFAULT_SUBSTRATE_PARAMS.rawRetentionDays, ...(c.rawRetentionDays ?? {}) },
        windows:          { ...DEFAULT_SUBSTRATE_PARAMS.windows, ...(c.windows ?? {}) },
        freshnessDays:    { ...DEFAULT_SUBSTRATE_PARAMS.freshnessDays, ...(c.freshnessDays ?? {}) },
        stories:          { ...DEFAULT_SUBSTRATE_PARAMS.stories, ...(c.stories ?? {}) },
      };
    } else if (row) {
      logger.warn({ version: row.version, schema: row.schema_version }, "active signals params have an unexpected schema_version — using defaults");
    }
  } catch (err: any) {
    logger.warn({ error: err.message?.slice(0, 120) }, "could not read signals params — using defaults");
  }
  cached = { at: Date.now(), params };
  return params;
}

/** Tests only. */
export function __resetSubstrateParamsCache(): void { cached = null; }
