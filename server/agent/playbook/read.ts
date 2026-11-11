/**
 * agent/playbook/read.ts — the read API the plan step reads (agent/plan/sources.ts; design
 * "Moments → post kits" §5 "who reads it" /
 * §7 register R3 extended): the active playbook for a (sport, stage) pair, across however many platforms the athlete
 * posts to, and the DEFAULT posting cadence it carries alongside her own words on the subject, when she has any.
 *
 * Review fix (PR #929): `cadenceFor` used to NULL the playbook's default the moment ANY active `standing_rule`
 * preference existed, whatever it was about — so an unrelated rule ("decline betting brands") silently hid a
 * perfectly good cadence default, and a real frequency preference ("I only want to post twice a week") is usually
 * saved as `style`, not `standing_rule`, so the one case this was FOR often didn't even trigger it. The fix: always
 * return the playbook's own default, and separately hand back every active `style` and `standing_rule` statement,
 * verbatim, alongside it. This function never decides which one wins — a model-backed caller (agent/plan) reads both
 * and judges relevance and override the same way it already reads every other free-text preference; parsing "twice
 * a week" out of a sentence in code is exactly the deterministic-layer-a-model-should-own case the project's
 * standing principle rules out.
 */
import type { Preference } from "../../../shared/agent";
import type { PlaybookConfig, PlaybookKey, PlaybookStage } from "../../../shared/playbook";
import { listPreferences } from "../memory";
import { athletePlaybookKeyBase } from "./keys";
import { getActivePlaybook } from "./store";

export interface PlaybookForPlatform {
  platform: string;
  /** Null when no active row exists yet for this (sport, stage, platform) key. */
  config: PlaybookConfig | null;
  version: string | null;
  activatedAt: string | null;
}

/** The active playbook for each requested platform, at one (sport, stage) pair. `sport` is folded to `lower(trim())`
 * before the lookup (keys.ts stores it the same way), so a caller's own casing/whitespace never causes a miss. A
 * missing key is a null config, never an error. */
export async function getPlaybook(sport: string, stage: PlaybookStage, platforms: readonly string[]): Promise<PlaybookForPlatform[]> {
  const normSport = sport.trim().toLowerCase();
  return Promise.all(platforms.map(async (platform) => {
    const key: PlaybookKey = { sport: normSport, stage, platform };
    const row = await getActivePlaybook(key);
    return {
      platform,
      config: (row?.config as PlaybookConfig | undefined) ?? null,
      version: row?.version ?? null,
      activatedAt: row?.activated_at ? row.activated_at.toISOString() : null,
    };
  }));
}

export interface PlaybookCadence {
  /** The playbook's own default for this key, when an active row exists — ALWAYS returned, whether or not she has
   * said anything; this is never nulled out by a preference. */
  postsPerWeek: { min: number; max: number } | null;
  /** Her own active "style" and "standing_rule" statements, verbatim, alongside the default. May mention frequency,
   * may not — this function never reads their content, only their kind and status; the caller judges relevance and
   * decides what (if anything) overrides the default. */
  preferenceStatements: string[];
}

const CADENCE_PREFERENCE_KINDS = new Set<Preference["kind"]>(["style", "standing_rule"]);

/** The playbook default plus her own words, never one replacing the other. */
export function cadenceFor(config: PlaybookConfig | null, preferences: readonly Pick<Preference, "kind" | "status" | "statement">[]): PlaybookCadence {
  const statements = preferences.filter((p) => CADENCE_PREFERENCE_KINDS.has(p.kind) && p.status === "active").map((p) => p.statement);
  return { postsPerWeek: config?.cadence?.postsPerWeek ?? null, preferenceStatements: statements };
}

/**
 * Convenience: getPlaybook + her own cadence-relevant preferences, per platform, in one call. The (sport, stage) pair
 * is derived from HER OWN current Brief and sport (keys.ts athletePlaybookKeyBase) — never trusted from the caller —
 * so this can never drift from what the daily sweep itself would key her under (review fix, PR #929). An athlete with
 * no current Brief, no sport, or an unclear stage yet has no key to look up: this returns `[]`, never an error.
 */
export async function getPlaybookForAthlete(
  athleteId: string, platforms: readonly string[],
): Promise<Array<PlaybookForPlatform & { cadence: PlaybookCadence }>> {
  const base = await athletePlaybookKeyBase(athleteId);
  if (!base) return [];
  const [rows, preferences] = await Promise.all([getPlaybook(base.sport, base.stage, platforms), listPreferences(athleteId)]);
  return rows.map((r) => ({ ...r, cadence: cadenceFor(r.config, preferences) }));
}

/** One platform the athlete is on and the post formats its active playbook recommends there (Understand's input). */
export interface PlaybookFormats {
  platform: string;
  formats: string[];
}

/**
 * The formats each platform's playbook recommends, from its config: the format mix's formats with posts a week, the
 * formats it lists (never "other"), and "story" when it recommends stories a week. A platform with no playbook yet is
 * left out. Pure.
 */
export function playbookFormatsOf(rows: ReadonlyArray<Pick<PlaybookForPlatform, "platform" | "config">>): PlaybookFormats[] {
  const out: PlaybookFormats[] = [];
  for (const r of rows) {
    const c = r.config;
    if (!c) continue;
    const set = new Set<string>();
    for (const [f, n] of Object.entries(c.cadence?.formatMix ?? {})) if (typeof n === "number" && n > 0) set.add(f);
    for (const f of c.formats ?? []) if (f?.postFormat && f.postFormat !== "other") set.add(f.postFormat);
    if ((c.cadence?.storiesPerWeek?.max ?? 0) > 0) set.add("story");
    if (set.size) out.push({ platform: r.platform, formats: [...set].sort() });
  }
  return out;
}

/**
 * The athlete's active playbook format mix, per platform she is on (understand 1.16.0: the Brief prices each). Never
 * throws: [] when she has no key yet (no current Brief, sport or known stage), no active platform, or on any error.
 */
export async function playbookFormatsForAthlete(athleteId: string): Promise<PlaybookFormats[]> {
  try {
    const [{ db }, { socialIdentities }, { and, eq }] = await Promise.all([import("../../db"), import("../../../shared/schema"), import("drizzle-orm")]);
    const rows = await db.selectDistinct({ platform: socialIdentities.platform }).from(socialIdentities)
      .where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active")));
    if (!rows.length) return [];
    return playbookFormatsOf(await getPlaybookForAthlete(athleteId, rows.map((r) => r.platform).sort()));
  } catch {
    return [];
  }
}
