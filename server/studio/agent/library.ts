/**
 * studio/agent/library — what the planner is SHOWN of her library, assembled in one place.
 *
 * Until 22 Sep 2026 this lived inline in POST /studio/agent/plan. It was moved here, unchanged in
 * behaviour, so that the plan eval (server/scripts/studioPlanEval.ts) can hand the planner the very
 * same library the product hands it. A copy of these forty lines in the harness would drift the
 * next time the route changed, and from then on every eval result would be about a planner nobody
 * ships. The route suite (routes/studio.agent.test.ts) is what holds the move: inline this back and
 * it must not notice; break it and it reds.
 *
 * ─── THE SPLIT, NOT A TUNING KNOB ───────────────────────────────────────────────────────────────
 *
 * Her view of the library divides into three rooms — photos OF her, scenes WITHOUT her, and her
 * CLIPS — her picks first, whichever room they belong to. The rooms compensate for one fact about
 * searchMedia's ranking: its default score gives every photo of her up to 0.18 of `heroScore` that
 * a scene cannot earn (heroScore is 0 whenever she is absent — lib/visionTag.ts), and a clip earns
 * none of it either. Shown "the top 24" of a real library (358 photos of her, 7 without — device
 * check, 21 Sep 2026) the planner never saw a scene, so it never planned b-roll. Scenes are
 * therefore ranked among themselves (cast.ts `rankWithoutHer`) and clips listed newest first
 * (cast.ts `listClips`), each in their own places. A slot a room does not fill stays empty.
 *
 * ─── WHAT IT CALLS ──────────────────────────────────────────────────────────────────────────────
 *
 * One searchMedia (photos of her), one scene ranking, one clip listing. Two `embedText` calls, no
 * model, no generation. This module reaches cast.ts → services/mediaSearch → lib/mediaEmbed, which
 * builds a GCS client AT MODULE LOAD — so the route imports it dynamically, as it does cast.ts.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { faceOf, hasHardSafetyFlag, roleOf } from "../../lib/visionTag";
import { searchMedia, type SearchResult } from "../../services/mediaSearch";
import { libraryFieldsEnabled } from "../config";
import { namesSport } from "../sportVocab";
import { brandsOf } from "./brands";
import { nearestCapability } from "./capabilities";
import {
  listClips,
  loadCastable,
  rankWithoutHer,
  type CastableRow,
} from "./cast";
import { subjectOf } from "./subject";
import type { LibraryEntry, LibraryTags } from "./types";

const logger = createLogger("studio/agent/library");

/** Photos OF her, ranked by searchMedia for the brief. */
export const AGENT_LIBRARY_WITH_HER = 16;
/** Scenes WITHOUT her, ranked among themselves. */
export const AGENT_LIBRARY_WITHOUT_HER = 8;
/** Her clips, newest tagged first (C2 Half B). */
export const AGENT_LIBRARY_CLIPS = 8;

/**
 * How many rows searchMedia is asked for, step by step, until the photos-of-her room fills.
 *
 * ─── WHY MORE THAN ONE k (enrichment eval Part 0, 22 Sep 2026) ──────────────────────────────────
 *
 * searchMedia has no media-type filter, so her videos come back among the "photos of her", and on
 * the measured library 21 of the top 24 were stitched compilations — refused by the offer below,
 * AFTER the k was spent. 3 of 16 places filled, all three basketball on a soccer brief. The
 * refusal is right (a compilation is never offered as her footage); the k was the starvation. So
 * the search is asked again, larger, while the room is short AND the last answer was a full k — a
 * short answer means the ranking is exhausted, and asking for more would return the same rows.
 * Each step is one embedText and one repeat of searchMedia's whole-library SELECT (it has no
 * LIMIT; k truncates the sorted list), so the steps are few and wide rather than many and narrow.
 * Shape A — refusing compilations inside the search — is the eventual home
 * (docs/proposals/media-search-stitched-filter.md); this is the in-lane form.
 */
export const LIBRARY_SEARCH_KS: readonly number[] = [
  AGENT_LIBRARY_WITH_HER + AGENT_LIBRARY_WITHOUT_HER,
  96,
  384,
];

/** The sport the tagger's words name for a row — description, setting, attire — or null. */
export const sportOf = (
  vision: Record<string, unknown> | null,
): string | null =>
  namesSport(
    [vision?.description, vision?.setting, vision?.attire]
      .filter((v): v is string => typeof v === "string")
      .join(" "),
  );

/**
 * The sport a plan is FOR: the one her sentence names; else the sport MOST OF HER LIBRARY names;
 * else her profile's; else null. Her profile's sport is read through `namesSport` too, so
 * "Women's Soccer" and "soccer" are one word.
 *
 * ⚠️ THE LIBRARY BEFORE THE PROFILE, measured 22 Sep 2026: the test athlete's row says Basketball
 * and her library is soccer by 403 rows to 32. A profile-first fallback read the recap brief as
 * basketball and would have demoted her soccer footage behind the basketball rows — the leak the
 * demotion exists to stop, inverted. What her footage mostly shows is the better fact about what
 * a plan of it is for; the profile is the last resort, for a library too thin to have a majority.
 *
 * ⚠️ A PLURALITY IS NOT A MAJORITY, measured 23 Sep 2026: "her library" here is the SEARCHED rows —
 * the k the prompt's sentence retrieved (40, widened to 96/384 only when the her-room is short),
 * not the 482 assets — so two sentences over one library see two slices. propose_campaign's
 * grow-following gloss retrieved a slice split 50/50 soccer/basketball on a library a recap
 * sentence reads as soccer; the tie went to whichever the search ranked first (basketball, against
 * a soccer row) and the warning below compared strictly above one half, so it said nothing. Now a
 * split at or above one half is not the library deciding: the athlete row decides, or nothing is
 * picked — and either way the log says so. More than half still beats the row, as 22 Sep decided.
 * ⚠️ MUTATION (library.test): let a plurality through — "a tie never resolves by search order" reds.
 */
export async function briefSport(
  athleteId: string,
  prompt: string,
  libraryRows: readonly CastableRow[] = [],
): Promise<BriefSport> {
  // The most-named sport and the share of sport-naming rows that name ANOTHER: 0 when they agree,
  // 0.5 a tie, above it no sport has half. Computed first so it rides on every answer.
  const plurality = majoritySport(libraryRows);
  const split = sportDisagreement(libraryRows, plurality);
  const named = namesSport(prompt);
  if (named) return { sport: named, source: "prompt", split };
  if (plurality && !sportDisagrees(split))
    return { sport: plurality, source: "library", split };
  const [row] = await db
    .select({ sport: athletes.sport })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const profile = namesSport(row?.sport ?? null);
  const resolved: BriefSport = profile
    ? { sport: profile, source: "profile", split }
    : { sport: null, source: null, split };
  if (plurality)
    logger.warn(
      {
        athleteId,
        plurality,
        split,
        named: libraryRows.filter((r) => sportOf(r.vision) !== null).length,
        sport: resolved.sport,
        source: resolved.source,
      },
      resolved.sport
        ? "agent library sport split — her searched footage names no majority sport; resolved to the athlete row, never to the search order"
        : "agent library sport split — her searched footage names no majority sport and the athlete row names none; no sport picked, nothing demoted",
    );
  return resolved;
}

/** The brief's sport and WHERE it came from — on the log line, so a wrong plan is diagnosable at a glance. */
export interface BriefSport {
  sport: string | null;
  source: "prompt" | "library" | "profile" | null;
  /**
   * Of the searched rows that name a sport, the share naming another than the most-named one —
   * 0 when they agree, 0.5 a tie. At or above one half the library has no majority and did not
   * decide (`sportDisagrees`).
   */
  split: number;
}

/**
 * Of the rows that name a sport, the share naming a DIFFERENT one from the brief's — 0 when the
 * brief has no sport or no row names one. Over one half is the signal a live run screamed
 * (22 Sep 2026: 73 survivors, mostly soccer, a brief resolved to basketball off a wrong profile
 * row; the plan recapped a fictional basketball session for $2.40): the plan is about to be for a
 * sport her footage is not. Logged as a WARNING, never acted on — the demotion is the mechanism,
 * and a sentence that names a sport is her decision.
 */
export function sportDisagreement(
  rows: readonly CastableRow[],
  sport: string | null,
): number {
  if (!sport) return 0;
  let named = 0;
  let other = 0;
  for (const r of rows) {
    const s = sportOf(r.vision);
    if (!s) continue;
    named += 1;
    if (s !== sport) other += 1;
  }
  return named ? Math.round((other / named) * 100) / 100 : 0;
}

/** At or above this share of rows naming another sport, the sport is in dispute — a tie is one half. */
export const SPORT_DISAGREEMENT_WARN = 0.5;

/**
 * Whether a share of rows naming another sport is a disagreement: AT one half — a tie — and above.
 * The one compare both readers use (`briefSport` to defer, the assembly to warn), so the boundary is
 * one fact. ⚠️ MUTATION (library.test): `>` — "at exactly one half — a tie — the share is a
 * disagreement" reds; that strict compare let a 50/50 slice through in silence on 23 Sep 2026.
 */
export const sportDisagrees = (share: number): boolean =>
  share >= SPORT_DISAGREEMENT_WARN;

/** `hasHardSafetyFlag` over a raw vision object — hateful / sexual / self_harm, as the tagger recorded them. */
export const hardFlagged = (vision: Record<string, unknown> | null): boolean =>
  hasHardSafetyFlag({
    content_flags:
      vision?.content_flags && typeof vision.content_flags === "object"
        ? (vision.content_flags as Record<string, boolean | undefined>)
        : undefined,
  });

/**
 * The rest of the tagger's answer, as `LibraryEntry.tags` (PR 12). Raw strings here — plan.ts
 * `tagWords` fences and caps every one on its way into the prompt. Numbers are kept as the tagger
 * wrote them or null; a row tagged before a key existed reads `unknown` on the line, never refuses.
 */
export const tagsOf = (vision: Record<string, unknown> | null): LibraryTags => {
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const flags =
    vision?.content_flags && typeof vision.content_flags === "object"
      ? Object.entries(vision.content_flags as Record<string, unknown>)
          .filter(([, on]) => on === true)
          .map(([k]) => k)
      : [];
  return {
    subject: typeof vision?.subject === "string" ? vision.subject : null,
    prominence: num(vision?.athlete_prominence),
    quality: num(vision?.aesthetic_quality),
    hero: num(vision?.hero_suitability),
    brandSafe:
      typeof vision?.brand_safe === "boolean" ? vision.brand_safe : null,
    flags,
    attire: str(vision?.attire),
    disposition: str(vision?.disposition),
    editNote: str(vision?.edit_note),
    reason: str(vision?.reason),
    face: faceOf(vision) ?? "unknown",
    role: roleOf(vision) ?? "unknown",
  };
};

/** A camera row's `verified` (types.ts `LibraryEntry.verified`): true on device-camera, false otherwise; null off camera. */
export const verifiedOf = (
  row: Pick<CastableRow, "provenance" | "provenanceSignal" | "mediaType">,
): boolean | null =>
  row.provenance === "camera" && row.mediaType === "clip"
    ? row.provenanceSignal === "device-camera"
    : null;

/**
 * ⚠️ MUTATION (routes/studio.agent.test V3): return `rows` unsorted — the order case reds.
 */
export function verifiedFirst(rows: readonly CastableRow[]): CastableRow[] {
  const rank = (r: CastableRow) =>
    r.provenance === "camera" ? (verifiedOf(r) ? 0 : 1) : 2;
  return [...rows]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * The sport MOST rows name — a plurality: a tie goes to the first seen, and null when none names
 * one. Whether that plurality is a majority is `briefSport`'s question, not this one's.
 */
export function majoritySport(rows: readonly CastableRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = sportOf(r.vision);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [s, n] of counts)
    if (best === null || n > counts.get(best)!) best = s;
  return best;
}

export interface AssembledLibrary {
  /** The lines the planner reads, refs `a1`…`aN`. Data, never instruction (plan.ts fences it). */
  library: LibraryEntry[];
  /**
   * What each ref names — held by the caller, never sent. A ref is a handle into rows the predicate
   * already loaded under her athlete id; the caster casts only through this map.
   */
  byRef: ReadonlyMap<string, CastableRow>;
}

/**
 * Assemble the planner's view: her picks (always — she chose them, never crowded out), then photos
 * of her, then scenes, then clips, each room capped. Tagged rows only — an untagged row has nothing
 * to describe it with. Her products are not library: each is offered as a product, never as a scene.
 *
 * `named` is every row she named (picks and products), already loaded through the caster's
 * predicate by the caller; a pick not in it is simply not offered.
 */
export async function assembleLibrary(
  athleteId: string,
  given: {
    prompt: string;
    /** The photos she picked, in her order, lower-cased ids. */
    picked: readonly string[];
    /** The products she picked — kept OUT of the library. */
    productIds: readonly string[];
    named: ReadonlyMap<string, CastableRow>;
  },
): Promise<AssembledLibrary & { sport: string | null }> {
  const { prompt, picked, productIds, named } = given;
  const seen = new Set<string>(productIds);

  /**
   * ─── THE SUBJECT GUARD (studio/agent/subject.ts — a stopgap, and it says so) ────────────────
   * A row the tagger describes as ANOTHER person never enters at all. A row it describes as NOBODY
   * enters with `athletePresent` forced false — on the copy the planner reads AND the copy the
   * caster casts through, so `fitsKind` cannot cast an i2v from it — and only after the ranked
   * scenes, so it never crowds a real scene out. Her own picks are relabelled, never dropped.
   */
  const judged = new Map<string, CastableRow>();
  const judge = (row: CastableRow): CastableRow => {
    const had = judged.get(row.id);
    if (had) return had;
    const out =
      subjectOf(row.vision) === "nobody"
        ? { ...row, athletePresent: false }
        : row;
    judged.set(row.id, out);
    return out;
  };
  const isOther = (row: CastableRow) => subjectOf(row.vision) === "other";
  /** Would this search hit take a place in the photos-of-her room? */
  const fillsHer = (row: CastableRow | undefined): row is CastableRow =>
    row !== undefined &&
    // A CLIP the search returned is not a photo of her: clips enter through `listClips` alone —
    // camera-first, verified-first. Offered here, in the search's order, they took clip-room
    // places before that order ran (found 22 Sep 2026: an unverified upload listed before a
    // verified one because it ranked higher for the brief).
    row.mediaType !== "clip" &&
    !seen.has(row.id) &&
    !picked.includes(row.id) &&
    row.vision !== null &&
    row.provenance !== "stitched-here" &&
    !isOther(row) &&
    judge(row).athletePresent === true;

  // ── Photos of her: searched, and searched again while the room is short (LIBRARY_SEARCH_KS) ──
  let found: SearchResult[] = [];
  let pool = new Map<string, CastableRow>();
  let herSurvivors = 0;
  let steps = 0;
  for (const k of LIBRARY_SEARCH_KS) {
    steps += 1;
    found = await searchMedia(athleteId, {
      brief: prompt,
      filters: { athletePresent: true },
      k,
    });
    pool = await loadCastable(
      athleteId,
      found.map((r) => r.id),
    );
    herSurvivors = found.filter((r) => fillsHer(pool.get(r.id))).length;
    if (herSurvivors >= AGENT_LIBRARY_WITH_HER || found.length < k) break;
  }
  // The signal that the LIBRARY is thin, not the search starved: the widest step still could not fill it.
  const thin =
    herSurvivors < AGENT_LIBRARY_WITH_HER &&
    found.length >= LIBRARY_SEARCH_KS[LIBRARY_SEARCH_KS.length - 1];
  const scenes = await rankWithoutHer(athleteId, prompt);
  // Camera-first is the SQL's order; within her camera, a VERIFIED row (device atoms in the
  // container — provenanceSignal.ts) before an unverified one. A stable sort: nothing crosses a
  // provenance boundary, an unverified camera clip still lists before every made-here one.
  const listed = await listClips(athleteId, AGENT_LIBRARY_CLIPS);
  const clips = verifiedFirst(listed);
  // What the plan is FOR — her words, else what her searched library mostly shows, else her profile.
  const herRows = found
    .map((r) => pool.get(r.id))
    .filter((r): r is CastableRow => r !== undefined);
  const brief = await briefSport(athleteId, prompt, herRows);
  const sport = brief.sport;
  const disagreement = sportDisagreement(herRows, sport);

  const described: CastableRow[] = [];
  /** Places left: photos of her, scenes without her, and her clips — three rooms. */
  const roomOf = (row: CastableRow) =>
    row.mediaType === "clip" ? "clip" : row.athletePresent ? "her" : "scene";
  const room = new Map<"her" | "scene" | "clip", number>([
    ["her", AGENT_LIBRARY_WITH_HER],
    ["scene", AGENT_LIBRARY_WITHOUT_HER],
    ["clip", AGENT_LIBRARY_CLIPS],
  ]);
  const guard = { other: 0, nobody: 0, hard: 0 };
  const offer = (given: CastableRow | undefined, always = false) => {
    if (
      !given ||
      seen.has(given.id) ||
      given.vision === null ||
      given.athletePresent === null
    )
      return;
    // PR 12 (ruling 3): a row carrying a HARD content flag — hateful, sexual, self-harm — is never
    // offered, picked or not. The tagger already forces its disposition to reject and heroScore
    // zeroes it; the planner is not shown it either. A plain `reject` (unusable quality) IS offered,
    // labelled, and the caster refuses to auto-cast it (cast.ts fitsKind). ⚠️ MUTATION
    // (routes/studio.agent.test "planner sees a hard-flagged photo"): drop this — reds by name.
    if (libraryFieldsEnabled() && hardFlagged(given.vision)) {
      guard.hard += 1;
      return;
    }
    // ⚠️ A STITCHED COMPILATION IS NEVER OFFERED — HERE, NOT ONLY IN listClips. searchMedia has no
    // media_type filter, so her videos come back among the 24 "photos of her", and on the measured
    // library (22 Sep 2026, first dry run of the plan eval) EIGHT of them were stitched outputs —
    // the clip room filled with compilations that listClips had correctly refused. The offer is
    // the one door every room passes through, so the refusal lives on it. A row she PICKED herself
    // (`always`) is still offered, labelled "stitched here", for the planner to read as what it is.
    if (!always && given.provenance === "stitched-here") return;
    // The subject guard: someone else is never offered (unless she picked it — then relabelled).
    if (isOther(given)) {
      guard.other += 1;
      if (!always) return;
    }
    const row = isOther(given)
      ? { ...given, athletePresent: false }
      : judge(given);
    if (row !== given && subjectOf(given.vision) === "nobody")
      guard.nobody += 1;
    const which = roomOf(row);
    const left = room.get(which)!;
    if (!always && left <= 0) return;
    seen.add(row.id);
    room.set(which, left - 1);
    described.push(row);
  };
  for (const id of picked) offer(named.get(id), true); // she chose them: never crowded out

  // Search hits of her, in the search's order — BUT rows of another sport after rows of hers
  // (enrichment eval Part 3: basketball photographs on a soccer brief). A demotion, never an
  // exclusion: when the brief's sport fills the room they are not offered; when it cannot, they
  // are. A row whose words name no sport is not "another sport" and keeps its place.
  const hits = found.map((r) => pool.get(r.id)).filter(fillsHer);
  const sameSport = (row: CastableRow) => {
    const s = sportOf(row.vision);
    return sport === null || s === null || s === sport;
  };
  for (const row of hits.filter(sameSport)) offer(row);
  for (const row of hits.filter((r) => !sameSport(r))) offer(row);
  for (const row of scenes) offer(row);
  // Search hits the guard read as NOBODY: scenes, offered after the ranked scenes — leftovers only.
  for (const r of found) {
    const row = pool.get(r.id);
    if (
      row &&
      row.mediaType !== "clip" && // clips enter through listClips alone (see fillsHer)
      !seen.has(row.id) &&
      row.athletePresent === true &&
      !isOther(row) &&
      judge(row).athletePresent === false
    )
      offer(row);
  }
  for (const row of clips) offer(row);

  const assembled = {
    athleteId,
    sport,
    // WHERE the sport came from: her sentence, her library's majority, or the athlete row.
    sportSource: brief.source,
    // The share of her-room rows whose words name ANOTHER sport than the brief's (0–1).
    sportDisagreement: disagreement,
    // The share naming another sport than the MOST-NAMED one (0–1): at or above one half the
    // searched slice had no majority and the row, not the search order, decided (briefSport).
    sportSplit: brief.split,
    steps,
    k: LIBRARY_SEARCH_KS[steps - 1],
    found: found.length,
    herSurvivors,
    thin,
    guard,
    library: described.length,
    // The clips offered, by short id — so "was d076a790 in the library" is read, never inferred
    // from the plan (enrichment eval Part 0's card; a live plan on 22 Sep 2026 asked it again).
    clips: described
      .filter((r) => r.mediaType === "clip")
      .map((r) => r.id.slice(0, 8)),
    // What listClips returned, in its order — a clip here and not in `clips` was refused at the
    // offer (untagged, present unknown, or the room full), and that is the stage to look at.
    listed: listed.map((r) => r.id.slice(0, 8)),
  };
  logger.info(
    assembled,
    thin
      ? "agent library thin — the widest search could not fill the photos-of-her room"
      : "agent library assembled",
  );
  if (sportDisagrees(disagreement))
    logger.warn(
      assembled,
      "agent library sport disagreement — most of her footage names another sport than the brief's; if the brief named none, check the athlete row's sport",
    );

  const library: LibraryEntry[] = described.map((row, i) => ({
    ref: `a${i + 1}`,
    description: String(row.vision?.description ?? ""),
    shotType: String(row.vision?.shot_type ?? ""),
    athletePresent: row.athletePresent === true,
    setting: String(row.vision?.setting ?? ""),
    vibe: String(row.vision?.vibe ?? ""),
    picked: picked.includes(row.id),
    brands: brandsOf(row.vision),
    provenance: row.provenance,
    platform: row.platform,
    mediaType: row.mediaType,
    durationSeconds: row.durationSeconds,
    sport: sportOf(row.vision),
    verified: verifiedOf(row),
    // PR 12: the ten fields this map used to drop (AUDIT2 F28), plus face and role — flag-gated so
    // the line is byte-identical with it off. ⚠️ MUTATION (plan.test / studio.agent.test): leave
    // `tags` out — "library line drops aesthetic_quality" reds by name.
    ...(libraryFieldsEnabled() ? { tags: tagsOf(row.vision) } : {}),
    // Half A's freeform camera / motion words, folded onto the vocabulary deterministically — no
    // model, no spend (capabilities.ts). Null where nothing matched.
    beats: row.beats.map((b, index) => ({
      index,
      startSec: b.startSec,
      endSec: b.endSec,
      description: b.description,
      camera: nearestCapability("camera", b.camera),
      movement: nearestCapability("movement", b.camera),
      motion: nearestCapability("motion", b.motion),
    })),
  }));
  const byRef = new Map(described.map((row, i) => [`a${i + 1}`, row] as const));
  return { library, byRef, sport };
}
