/**
 * athleteProfile.ts — the speakable slice of the athlete's own profile.
 *
 * Pure: no db, no model. Same discipline as ./brandProfile, different threat
 * model — and the difference is the whole reason this module reads the way it
 * does.
 *
 * ── Why Mila needs this at all ───────────────────────────────────────────────
 * The worker registers four tools and none of them describe the ATHLETE. She can
 * fetch a score, list deals and read a brand, but she cannot say what sport they
 * play. Every "does this brand fit me" answer was therefore reasoning about one
 * side of a two-sided question.
 *
 * ── Provenance: athlete-authored, not app-owned ──────────────────────────────
 * These fields are the athlete's own words about themselves, and that is a
 * genuinely different class from both the deal fields (brand email, hostile) and
 * the brand fields (web-grounded, influenceable):
 *
 *   segment                      GENERATED column, computed in SQL from division
 *                                and school. App-owned outright.
 *   division                     Effectively closed — shared/schema.ts's `segment`
 *                                expression enumerates every accepted value, so it
 *                                is allow-listed here against that same list.
 *   sport, school, conference    Athlete-typed at onboarding. Free text, but there
 *                                is NO path by which anyone else writes them.
 *   goal_archetype,              Athlete-set via PATCH /me/profile/* — and ALSO
 *   secondary_goals,             proposable by mila/profileExtraction. See below.
 *   brand_voice
 *   (rates)                      Always null — the computed rate card is retired.
 *
 * ── The one influence path, stated plainly ───────────────────────────────────
 * (Historical: profileExtraction.ts was deleted with the old chat loop, Nov 2026;
 * the fence-and-confirm reasoning below still applies to any future proposer.)
 * `profileExtraction.ts` read a completed chat turn and PROPOSED candidates for
 * goal_archetype / secondary_goals / brand_voice. That turn can carry tool-result
 * brand or email text. So there is a chain by which external text could reach
 * these fields: land it in the inbox → have extraction propose it → have the
 * athlete tap confirm.
 *
 * It is a weak chain — extraction never writes (routes/profile.ts is the only
 * writer), and the athlete reads the exact value on a confirm card before it
 * persists. But it is not nothing, and these fields ARE free text bound for a TTS
 * layer. So they get the shape gate below rather than a pass-through, and the
 * caps are imported from `profileFields` rather than restated so what we speak
 * can never exceed what we agreed to store.
 *
 * The gate is the ./voiceSeed `safeName` pattern generalised: single line,
 * bounded, no angle brackets, reject-don't-truncate. It does not make free text
 * closed-vocabulary — nothing can — and it is not claimed to. What it buys is
 * that a value cannot carry newlines or markup into a spoken sentence, and cannot
 * be longer than a phrase.
 */

import { PROFILE_LIMITS } from "../mila/profileFields";
// One implementation of the shape gate, shared with ./brandProfile — a guard
// that exists in three copies only has to be weakened once.
import { fromVocabulary, speakable, speakableList } from "./speakable";

/**
 * Every division `shared/schema.ts` recognises, taken from the generated
 * `segment` CASE expression. That column is the authority; if it grows a value,
 * this list is the second place to add it.
 */
const DIVISIONS: readonly string[] = [
  "D1",
  "FBS",
  "FCS",
  "D2",
  "D3",
  "NAIA",
  "JUCO",
  "NJCAA",
  "HS",
  "High School",
  "Youth",
  "Club",
  "AAU",
  "Pro",
  "Olympic",
];

/** The generated column's own four-plus-one vocabulary. App-computed in SQL. */
const SEGMENTS: readonly string[] = [
  "college",
  "high_school",
  "youth",
  "pro",
  "olympic",
];
const SEGMENT_SET: ReadonlySet<string> = new Set(SEGMENTS);

/** Identity free text (sport, school, conference) is short by nature. */
const IDENTITY_MAX = 80;

/** Most secondary goals / voice phrases spoken. The stored caps are far higher. */
const MAX_LIST_ITEMS = 4;

/** The speakable profile. */
export interface VoiceAthleteProfile {
  sport: string | null;
  school: string | null;
  /** Allow-listed against the schema's own division vocabulary. */
  division: string | null;
  conference: string | null;
  /** From the GENERATED column — app-computed, not athlete-typed. */
  segment: string | null;
  goal: string | null;
  secondaryGoals: string[];
  /** The athlete's stated voice. Free text behind the shape gate — see header. */
  voiceTone: string | null;
  voicePhrases: string[];
  voiceAvoid: string[];
  /**
   * Always null (legacy retirement, 8 Oct 2026): the computed v3 rate card is retired and rates are being rebuilt.
   * Kept on the wire so the worker contract is unchanged; the worker treats null as "we have not worked one out".
   */
  rates: null;
}

/** The row shape this reads. Deliberately narrow. */
export interface AthleteProfileRow {
  sport?: unknown;
  school?: unknown;
  division?: unknown;
  conference?: unknown;
  segment?: unknown;
  goal_archetype?: unknown;
  secondary_goals?: unknown;
  brand_voice?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function readAthleteProfile(
  row: AthleteProfileRow | null,
): VoiceAthleteProfile {
  const voice = isRecord(row?.brand_voice) ? row.brand_voice : null;

  const rawDivision =
    typeof row?.division === "string" ? row.division.trim() : null;

  const rawSegment =
    typeof row?.segment === "string" ? row.segment.trim().toLowerCase() : null;

  return {
    sport: speakable(row?.sport, IDENTITY_MAX),
    school: speakable(row?.school, IDENTITY_MAX),
    // Allow-listed, then echoed in the SCHEMA's casing rather than the row's, so
    // a stored "d1" is spoken as the value we recognise.
    division: fromVocabulary(rawDivision, DIVISIONS),
    conference: speakable(row?.conference, IDENTITY_MAX),
    segment: rawSegment && SEGMENT_SET.has(rawSegment) ? rawSegment : null,
    goal: speakable(row?.goal_archetype, PROFILE_LIMITS.goal),
    secondaryGoals: speakableList(
      row?.secondary_goals,
      PROFILE_LIMITS.goalItem,
      MAX_LIST_ITEMS,
    ),
    voiceTone: speakable(voice?.tone, PROFILE_LIMITS.tone),
    voicePhrases: speakableList(
      voice?.phrases,
      PROFILE_LIMITS.voiceItem,
      MAX_LIST_ITEMS,
    ),
    voiceAvoid: speakableList(
      voice?.avoid,
      PROFILE_LIMITS.voiceItem,
      MAX_LIST_ITEMS,
    ),
    rates: null,
  };
}
