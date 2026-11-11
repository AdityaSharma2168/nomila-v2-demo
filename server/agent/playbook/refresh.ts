/**
 * agent/playbook/refresh.ts — one playbook refresh: one model call (fast tier + web search) for ONE
 * (sport, stage, platform) key → code checks → draft + activate, or hold the old active row.
 *
 * Not athlete-scoped, so it does not go through runSkill/agent_runs (which require an athlete_id — design §5's own
 * reason content_playbooks is its own table rather than memory_facts). It calls research/llm.ts's callStructured
 * directly: the same model-call plumbing runSkill wraps, minus the per-athlete trace and budget bookkeeping — there
 * is no per-athlete spend to check here, since the cost is shared across every athlete at the key.
 *
 *   1. loadJob("playbook") + modelFor (the fast tier; web_search on Gemini would throw — models.ts' own rule).
 *   2. One structured call, capped at PLAYBOOK.MAX_SEARCHES searches and PLAYBOOK.MAX_OUTPUT_TOKENS output tokens.
 *   3. Code validates the JSON (validatePlaybookOutput): a hook or a format naming a dated day/month/year is
 *      DROPPED from its own array (never a reason to fail the refresh by itself); the key fails only if that leaves
 *      zero formats or zero hooks, or the length (0 < min ≤ max ≤ 600s) / cadence (0 < min ≤ max ≤ 21/week) range is
 *      missing or backwards. playbook 1.2.0: the format mix (whole posts a week per format, summing to no more than the
 *      cadence's max) and the stories range (0 ≤ min ≤ max ≤ 35) are kept only when they pass; a failing one is left
 *      out, never a reason to fail the key. A source is kept only when it is an EXACT page this run's own searches actually
 *      returned (checkSource against callStructured's `sources`, factor === 1 — moments/research.ts's own function,
 *      but stricter here: its own "nothing searched, trust everything" fallback is the wrong default for a run that
 *      always has web_search on, so an empty `seen` keeps NO sources). A call that throws is also a FAILED key — in
 *      every failed case the old active row, if any, is left exactly as it was, and the failure is recorded
 *      (recordPlaybookFailure) so the next sweep backs off the key for PLAYBOOK.FAILURE_BACKOFF_DAYS instead of
 *      retrying (and re-billing) it on every subsequent daily check.
 *   4. On a valid output: insertDraftPlaybook (idempotent on (key, version); a version is immutable) then
 *      activatePlaybook, in that order, so a failure between the two still leaves a draft on file to retry from,
 *      never a half-written active row. A valid output with NO verified source behind its numbers is still
 *      activated — FLAGGED (logged), never blocked: the length/cadence ranges may rest on the skill's own general
 *      platform knowledge rather than a page this run happened to see, which the skill itself is told is fine, as
 *      long as it says so in `path_note`.
 */
import { createLogger } from "../../logger";
import { PLAYBOOK_SCHEMA } from "../research/schemas";
import { callStructured, ModelCallError } from "../research/llm";
import { checkSource } from "../research/research";
import { modelFor } from "../models";
import { loadJob } from "../jobs";
import { isPlaybookPostFormat, type PlaybookConfig, type PlaybookKey } from "../../../shared/playbook";
import { PLAYBOOK, PLAYBOOK_SKILL_ID } from "./config";
import { POST_KIT } from "../postKit/config";
import { activatePlaybook, getActivePlaybook, hashConfig, insertDraftPlaybook, recordPlaybookFailure } from "./store";

const logger = createLogger("agent/playbook");

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The no-date rule, enforced in code (not just asked for in the skill): a trend, a seasonal hook or a current event
 * belongs to the weekly moments scan, never here. Review fix (round 2): the first version matched ANY 4-digit
 * 19xx/20xx number and ANY month name case-insensitively, anywhere — which caught "may" (the modal verb), "march"
 * (to walk), "august" (the adjective) and "under 2000 characters" (a character count, not a year), and FAILED THE
 * WHOLE KEY for it. Two fixes:
 *   - a month name only counts when CAPITALISED (a proper month, never the common lowercase word) AND sitting right
 *     next to a day/year number ("May 12", "12 March", "August 2026") — a bare capitalised month with no adjoining
 *     number ("every August she ramps up") is not flagged;
 *   - a year only counts as 19xx/20xx when NOT immediately followed by a unit word ("characters", "followers",
 *     "views", …) — "2000 characters" is a length, not a date.
 * And the whole-key failure is gone: a line (one hook string, or one format's name+when_to_use) that still leaks a
 * date after that is DROPPED from its array, never a reason to fail the refresh — the key only fails if dropping
 * leaves zero formats or zero hooks (the existing emptiness check, below).
 */
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_NEAR_NUMBER_RE = new RegExp(`\\b(?:${MONTH_NAMES})\\b\\s+\\d{1,4}\\b|\\b\\d{1,2}\\b\\s+(?:${MONTH_NAMES})\\b`);
const NON_DATE_UNIT_WORDS = "characters|chars|words|followers|subscribers|views|likes|comments|shares|posts|reels|stories|minutes|seconds|hours|days|weeks|months|years|times|%|percent";
const YEAR_RE = new RegExp(`\\b(?:19|20)\\d{2}\\b(?!\\s*(?:${NON_DATE_UNIT_WORDS}))`, "i");
const hasDateLeak = (s: string): boolean => MONTH_NEAR_NUMBER_RE.test(s) || YEAR_RE.test(s);

export interface ValidatedPlaybook {
  config: PlaybookConfig;
  /** The skill's own one-liner on what it looked for and why — stored on the row (content_playbooks.note), never part of the config shape itself. */
  pathNote: string;
}

/**
 * Code checks the model's JSON into a PlaybookConfig, or null when it fails the checks (a failed key, never
 * half-applied). `seen` is callStructured's own `sources` — every page this run's searches actually returned; a
 * source the model names that is not among them is dropped, not trusted (checkSource, the same function
 * moments/research.ts uses for exactly this).
 */
export function validatePlaybookOutput(json: any, now: Date, seen: Array<{ url: string; title?: string }>): ValidatedPlaybook | null {
  const formats = (Array.isArray(json?.formats) ? json.formats : [])
    .map((f: any) => ({
      name: oneLine(f?.name).slice(0, 60),
      postFormat: isPlaybookPostFormat(f?.post_format) ? f.post_format : "other",
      whenToUse: oneLine(f?.when_to_use).slice(0, 300),
    }))
    .filter((f: { name: string; whenToUse: string }) => f.name && f.whenToUse)
    // A format that still leaks a date is DROPPED, not a reason to fail the whole key (see the module header).
    .filter((f: { name: string; whenToUse: string }) => !hasDateLeak(f.name) && !hasDateLeak(f.whenToUse))
    .slice(0, 6);
  const hooks = (Array.isArray(json?.hooks) ? json.hooks : [])
    .map((h: unknown) => oneLine(h).slice(0, 300)).filter(Boolean)
    .filter((h: string) => !hasDateLeak(h))
    .slice(0, 8);
  const min = json?.ideal_length_sec?.min;
  const max = json?.ideal_length_sec?.max;
  const cadenceMin = json?.cadence?.posts_per_week?.min;
  const cadenceMax = json?.cadence?.posts_per_week?.max;
  const crossPlatformReuse = (Array.isArray(json?.cross_platform_reuse) ? json.cross_platform_reuse : [])
    .map((r: any) => ({ from: oneLine(r?.from).slice(0, 40), to: oneLine(r?.to).slice(0, 40), rule: oneLine(r?.rule).slice(0, 300) }))
    .filter((r: { from: string; to: string; rule: string }) => r.from && r.to && r.rule)
    .slice(0, 6);
  // Review fix (round 2): checkSource lets EVERYTHING through when `seen` is empty (research.ts's own benefit-of-the-
  // doubt rule for a non-search source, e.g. a deal ref) — wrong here, where `seen` empty means the model made no
  // searches at all, so nothing it names as a source was actually seen. With an empty `seen`, keep NO sources.
  // Otherwise keep only an EXACT page match (factor === 1) — a same-host-different-page or malformed-URL match
  // (factor 0.8/0.6) is good enough for a dated fact (moments/research.ts), not for "this page backs this claim".
  const sources = seen.length === 0 ? [] : (Array.isArray(json?.sources) ? json.sources : [])
    .map((s: any) => ({ url: oneLine(s?.url), title: oneLine(s?.title).slice(0, 300) }))
    .map((s: { url: string; title: string }) => ({ title: s.title, checked: checkSource(s.url, seen) }))
    .filter((s: { checked: { ok: boolean; factor: number } }) => s.checked.ok && s.checked.factor === 1)
    .map((s: { title: string; checked: { url: string } }) => ({ url: s.checked.url, title: s.title }))
    .slice(0, 10);
  const pathNote = oneLine(json?.path_note).slice(0, 500);

  if (!formats.length || !hooks.length) return null;
  if (!isFiniteNum(min) || !isFiniteNum(max) || min <= 0 || max < min || max > 600) return null;
  if (!isFiniteNum(cadenceMin) || !isFiniteNum(cadenceMax) || cadenceMin <= 0 || cadenceMax < cadenceMin || cadenceMax > 21) return null;

  // playbook 1.2.0: the format mix and the stories range, each kept only when it passes (never a reason to fail the key).
  const whole = (v: unknown): v is number => isFiniteNum(v) && v >= 0 && Number.isInteger(v);
  const m = json?.cadence?.format_mix;
  const formatMix = m && whole(m.reel) && whole(m.carousel) && whole(m.feed) && m.reel + m.carousel + m.feed > 0 && m.reel + m.carousel + m.feed <= cadenceMax
    ? { reel: m.reel, carousel: m.carousel, feed: m.feed } : null;
  const sMin = json?.cadence?.stories_per_week?.min;
  const sMax = json?.cadence?.stories_per_week?.max;
  const storiesPerWeek = isFiniteNum(sMin) && isFiniteNum(sMax) && sMin >= 0 && sMax >= sMin && sMax <= 35 ? { min: sMin, max: sMax } : null;

  return {
    config: {
      formats, hooks, idealLengthSec: { min, max },
      cadence: { postsPerWeek: { min: cadenceMin, max: cadenceMax }, ...(formatMix ? { formatMix } : {}), ...(storiesPerWeek ? { storiesPerWeek } : {}) },
      crossPlatformReuse, sources, refreshedAt: now.toISOString().slice(0, 10),
    },
    pathNote,
  };
}

function inputFor(key: PlaybookKey, athleteCount: number, existing: PlaybookConfig | null): string {
  return [
    `KEY`,
    `- sport: ${key.sport}`,
    `- career stage: ${key.stage}`,
    `- platform: ${key.platform}`,
    `- athletes currently at this key: ${athleteCount}`,
    ``,
    `EXISTING PLAYBOOK ON FILE`,
    existing ? JSON.stringify(existing) : "(none yet — this is the first refresh for this key)",
    ``,
    // playbook 1.2.0: what a post kit can build, so no format or length is recommended that a kit cannot make.
    `WHAT A POST KIT CAN BUILD`,
    `- formats: reel, carousel, story, feed — from the athlete's own photos and clips; nothing is generated`,
    `- a carousel holds at most ${POST_KIT.MAX_ASSETS} photos or clips; a reel or story at most ${POST_KIT.VIDEO_MAX_ASSETS}; a feed post one photo`,
    `- a video is at most ${POST_KIT.TOTAL_MAX_SEC} seconds in all, each clip at most ${POST_KIT.MAX_CLIP_SEC} seconds`,
  ].join("\n");
}

export type PlaybookRefreshOutcome =
  | { status: "activated"; key: PlaybookKey; version: string; created: boolean; costMicroUsd: number }
  | { status: "failed"; key: PlaybookKey; reason: "invalid_output" | "error" };

/** Best-effort: recording the failure must never itself throw, or mask the real failure being reported. */
async function recordFailure(key: PlaybookKey, reason: string, now: Date): Promise<void> {
  try { await recordPlaybookFailure({ key, reason, now }); }
  catch (err: any) { logger.warn({ key, error: String(err?.message ?? err).slice(0, 300) }, "playbook refresh: could not record the failure marker"); }
}

/** One key's refresh. Never throws: a failed key is reported, not thrown, so a sweep over many keys keeps going. */
export async function refreshPlaybookKey(key: PlaybookKey, opts: { athleteCount: number; now?: Date } = { athleteCount: 1 }): Promise<PlaybookRefreshOutcome> {
  const now = opts.now ?? new Date();
  try {
    const skill = loadJob(PLAYBOOK_SKILL_ID);
    const model = modelFor(skill);
    const existingRow = await getActivePlaybook(key);
    const existing = (existingRow?.config ?? null) as PlaybookConfig | null;

    const result = await callStructured({
      skill, model, input: inputFor(key, opts.athleteCount, existing), schemaName: "playbook", schema: PLAYBOOK_SCHEMA,
      webSearch: { maxCalls: PLAYBOOK.MAX_SEARCHES, contextSize: "low" }, maxOutputTokens: PLAYBOOK.MAX_OUTPUT_TOKENS,
    });
    if (result.cost.microUsd > PLAYBOOK.RUN_RESERVE_MICRO_USD) {
      logger.warn({ key, costUsd: result.cost.microUsd / 1e6, reserveUsd: PLAYBOOK.RUN_RESERVE_MICRO_USD / 1e6 }, "playbook refresh cost more than its reserve");
    }

    const validated = validatePlaybookOutput(result.json, now, result.sources);
    if (!validated) {
      logger.warn({ key }, "playbook refresh: the model's output failed the checks; the old active row (if any) is left as is");
      await recordFailure(key, "invalid_output", now);
      return { status: "failed", key, reason: "invalid_output" };
    }
    const { config, pathNote } = validated;
    // Flagged, never blocked: the length/cadence ranges may rest on the skill's own general knowledge rather than a
    // page this run happened to see — the skill is told that is acceptable (server/agent/jobs/playbook.md).
    if (config.sources.length === 0) {
      logger.warn({ key, pathNote }, "playbook refresh: no source this run's searches actually saw backs the length/cadence numbers — kept, flagged only");
    }

    const version = `v${now.toISOString().slice(0, 10)}-${hashConfig(config)}`;
    const { row, created } = await insertDraftPlaybook({ key, version, config, note: pathNote || null, createdBy: "playbook:schedule" });
    await activatePlaybook(key, row.version);
    logger.info({
      key, version: row.version, created, costUsd: result.cost.microUsd / 1e6, searchCalls: result.cost.webSearchCalls, pathNote,
    }, "playbook refreshed");
    return { status: "activated", key, version: row.version, created, costMicroUsd: result.cost.microUsd };
  } catch (err: any) {
    const partial = err instanceof ModelCallError ? err.partial : undefined;
    logger.warn({ key, error: String(err?.message ?? err).slice(0, 300), costUsd: (partial?.cost?.microUsd ?? 0) / 1e6 }, "playbook refresh failed; the old active row (if any) is left as is");
    await recordFailure(key, "error", now);
    return { status: "failed", key, reason: "error" };
  }
}
