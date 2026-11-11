/**
 * beds.ts — the music a stitch can lay under the programme.
 *
 * ─── WHY A BED IS NOT ONE OF HER ASSETS ─────────────────────────────────────────────────────────
 *
 * Because it cannot be. `media_assets.media_type` is IMAGE | VIDEO | REELS | CAROUSEL_ALBUM |
 * CAROUSEL_CHILD — there is no AUDIO — and studio/video/materialize.ts resolves only the video
 * ones. Making a bed an asset id would mean widening a shared column, which is a schema change
 * this build does not get to make on its own.
 *
 * It is also the right answer independently: a bed is LICENSED MUSIC, not her media. It belongs to
 * the product, the same for every athlete, and it has to be cleared for commercial use before it
 * is ever laid under a clip she might send to a brand. That is a curated list, not a library.
 *
 * ─── SO THE WIRE CARRIES A NAME ─────────────────────────────────────────────────────────────────
 *
 * Exactly the argument studio/video/spec.ts makes about target names, for exactly the same reason:
 * a path off the wire is a durable file-read primitive, and the stored spec holds the NAME so a
 * bed can be re-cut, re-licensed or replaced without rewriting rows nobody can edit.
 *
 * ⚠️ ─── THE BYTES ARE NOT HERE YET, AND THAT IS DELIBERATE ────────────────────────────────────────
 *
 * Every path below points at an object in the media bucket that DOES NOT EXIST until someone puts
 * it there. Uploading it is a live-infra write, so it is not this build's to do — see
 * docs/probes/video-v7-bed-placeholder.md for the ffmpeg recipe that generates a placeholder loop
 * (CC0 by construction, because we made it) and the one gsutil line that installs it.
 *
 * Until then `bedAvailable()` answers false for every bed, the parser refuses a bed by name with a
 * sentence that says so, and a timeline without one works exactly as it does today. Nothing here
 * fails at run time for a missing file: it refuses at the door.
 */
import { createLogger } from "../../logger";
import type { BeatGrid } from "./beatGrid";
import { MUSIC_TRACKS, isTrackId, type TrackId } from "../music/tracks";
import { LIBRARY_TRACKS, isLibraryTrackId, musicLibraryReady } from "../music/library";
import { studioFlag } from "../studioFlag";

const logger = createLogger("studio/video/beds");

/**
 * The only licences a bed may carry. CC0 or public domain, and nothing else — not CC-BY (an
 * attribution she would have to carry into a brand deliverable), and not a site's own "royalty
 * free" terms, which are a contract with the site rather than a grant from the author.
 * "generated" is ours: a tone made by ffmpeg's lavfi, nobody's recording.
 */
export const BED_LICENSES = ["CC0-1.0", "PD", "generated"] as const;
export type BedLicense = (typeof BED_LICENSES)[number];

/**
 * Where a track came from and what its page said ON THE DAY WE TOOK IT.
 *
 * The date is not bookkeeping. A CC0 dedication is irrevocable, but a hosting page is not: an
 * uploader can relabel a track, and then the only evidence of the grant we relied on is what we
 * wrote down — the URL, the licence it showed, the day, and the hash of the exact bytes we took.
 * BEDS-LICENSES.md, beside this file, holds the same record in prose, with the page's own words.
 */
export interface BedProvenance {
  license: BedLicense;
  artist: string;
  /** The track's own page, not the album's or the site's. */
  sourceUrl: string;
  /** YYYY-MM-DD, the day the page was read and the file downloaded. */
  retrievedOn: string;
  /** Of the file as downloaded, before any transcode — so the bytes can be matched to the page. */
  sha256: string;
}

export interface BedDefinition {
  /** What she sees. */
  label: string;
  /** Bucket-relative object path, signed and streamed the same way a clip is. */
  gcsPath: string;
  /** One line for the picker, so a bed is chosen by feel rather than by filename. */
  note: string;
  /**
   * Whether the picker offers it. An UNLISTED bed is still a valid name: a row queued with it
   * re-parses and runs. That is the whole reason to unlist rather than delete — deleting a name
   * fails every stored spec that holds it, over its soundtrack.
   */
  listed: boolean;
  /** Required for anything listed; asserted in the suite, so a track cannot ship unrecorded. */
  provenance: BedProvenance | null;
  /**
   * How long the track runs, in seconds — MEASURED off the downloaded file with ffprobe, not read
   * off a page. For the picker only: it bounds how far in she can ask the track to start. Nothing
   * on the server trusts it; a start past the end simply wraps (the bed loops).
   */
  durationSec: number | null;
  /**
   * Where its beats fall — MEASURED off the installed file by studio/video/beatGrid.ts, once, like
   * `durationSec`. This is the per-track cache: nothing decodes a bed at run time to find its beat.
   * Listened to against a click on the grid before it was written here (PR 5 A2, ledger). Null when
   * nobody has measured it; a bed with no grid can still be laid under a video, just not cut to.
   */
  beat: BeatGrid | null;
}

/**
 * The curated list. A name, never a path, is what travels.
 *
 * The placeholder proved the PATH — that a bed is fetched, mixed and present in the output — and is
 * now UNLISTED: a 220 Hz tone is not something to offer an athlete. It stays a valid name.
 *
 * THE BED DUCKS UNDER A CLIP THAT SOUNDS, and is flat under silent ones. For a long time it never
 * ducked at all (ledger D4, docs/probes/video-prompt-quality-ledger.md): the request never asked.
 * It asks now (spec.ts), and plan.ts emits the sidechain only when a clip actually has sound.
 *
 * Real tracks are added here ONE AT A TIME, each with its provenance, each approved by a person
 * who listened to it. The list is short on purpose.
 */
export const STITCH_BEDS = {
  placeholder: {
    label: "Placeholder loop",
    gcsPath: "studio/beds/placeholder-loop.m4a",
    note: "A tone, not music — it is here to prove the audio path works.",
    listed: false,
    provenance: null,
    durationSec: 12,
    beat: null,
  },
  "walking-away": {
    label: "Walking Away",
    gcsPath: "studio/beds/walking-away.m4a",
    note: "Steady and warm — a lo-fi beat that keeps moving.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/",
      retrievedOn: "2026-09-20",
      sha256:
        "fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610",
    },
    durationSec: 156.04,
    beat: { bpm: 81.5, firstBeatSec: 0.012 },
  },
  doodles: {
    label: "Doodles",
    gcsPath: "studio/beds/doodles.m4a",
    note: "Bright and light — easy under a fun clip.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/doodles-lofi-happy-mp3/",
      retrievedOn: "2026-09-20",
      sha256:
        "84db72387b14fa51294ba76a0bb3f72f39172527e5eb7964da8567596561ae72",
    },
    durationSec: 138.32,
    beat: { bpm: 85, firstBeatSec: 0.004 },
  },
  "tokyo-sunset": {
    label: "Tokyo Sunset",
    gcsPath: "studio/beds/tokyo-sunset.m4a",
    note: "Soft and slow — for a calm, reflective cut.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/tokyo-sunset-lofi-peaceful-soft/",
      retrievedOn: "2026-09-20",
      sha256:
        "83b9208ab781af9b2da86e6885c4ec0fc1270457848609a1f96267539518fb9b",
    },
    durationSec: 139.0,
    beat: { bpm: 63, firstBeatSec: 0.951 },
  },
  "hope-on-repeat": {
    label: "Hope On Repeat",
    gcsPath: "studio/beds/hope-on-repeat.m4a",
    note: "Hopeful and easy — a lift without the rush.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/spring-woke-me-up/hope-on-repeat/",
      retrievedOn: "2026-09-20",
      sha256:
        "e781cf3926ea5b769f3b5667011234f4524cbcb06e539ba563c7f15fd805477a",
    },
    durationSec: 163.72,
    beat: { bpm: 85, firstBeatSec: 0.012 },
  },
  "we-drove-all-night": {
    label: "We Drove All Night",
    gcsPath: "studio/beds/we-drove-all-night.m4a",
    note: "Driving retro synths — the one with momentum.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/we-drove-all-night-game-soundtrack/we-drove-all-night/",
      retrievedOn: "2026-09-20",
      sha256:
        "7f2f8953c5cb21c4704ec700a2c16f75043f6ceb7d8cfab69e69bc175b6ffaed",
    },
    durationSec: 157.86,
    beat: { bpm: 76, firstBeatSec: 0.001 },
  },
  "only-human": {
    label: "Only Human",
    gcsPath: "studio/beds/only-human.m4a",
    note: "Dark and heavy — a phonk beat for a highlight reel.",
    listed: true,
    provenance: {
      license: "CC0-1.0",
      artist: "HoliznaCC0",
      sourceUrl:
        "https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/only-human/",
      retrievedOn: "2026-09-20",
      sha256:
        "d91ab977eecf295d1ae3c332fdebac2361c549a0059e44e27036a42e6a21095f",
    },
    durationSec: 235.02,
    beat: { bpm: 85, firstBeatSec: 0.012 },
  },
} as const satisfies Record<string, BedDefinition>;

/**
 * ─── THE MUSIC A STITCH CAN NAME IS TWO CATALOGUES, ONE NAMESPACE ───────────────────────────────
 *
 * The curated CC0 beds above, and the licensed tracks in studio/music/tracks.ts (PR 8). They are
 * joined HERE, where a name is resolved, rather than by adding the tracks to STITCH_BEDS: that list's
 * suite admits CC0 and public domain only, and an Artlist track is neither — widening the rule to
 * fit them would let the next non-CC0 file in unrecorded. Each catalogue keeps its own paper trail
 * and its own tests; the stitch sees one list of names, and the suite asserts no name is in both.
 */
export type BedName = keyof typeof STITCH_BEDS | TrackId;

export const isBedName = (v: unknown): v is BedName =>
  (typeof v === "string" &&
    Object.prototype.hasOwnProperty.call(STITCH_BEDS, v)) ||
  isTrackId(v);

/** All the stitch needs of a named track to lay it under a video: where its bytes are. */
export type BedSource = Pick<BedDefinition, "gcsPath">;

const gcsPathOf = (name: BedName): string =>
  isTrackId(name) ? MUSIC_TRACKS[name].gcsPath : STITCH_BEDS[name].gcsPath;

/**
 * How large a bed may be, as a ceiling charged against the same workspace budget the clips are.
 *
 * Layer 3's lesson, applied before it can bite: the bed is another file downloaded into the same
 * tmpfs, and an uncounted file is charged at zero. 25 MB is generous for a loop — a 3-minute track
 * at 192 kbps is about 4 MB — and being generous is the safe direction for a ceiling that only
 * ever refuses.
 */
export const bedMaxBytes = () =>
  Number(process.env.STUDIO_STITCH_BED_MAX_BYTES ?? 25 * 1024 * 1024);

/**
 * Whether a bed's object has actually been installed in the bucket.
 *
 * Read from the environment rather than probed: a HEAD against GCS on every queue would put a
 * network call in the request path to answer a question whose answer changes once, by hand. Set
 * `STUDIO_STITCH_BEDS_READY=true` after the upload.
 *
 * Fail-closed while unset, which is why the parser can refuse at the door instead of letting a
 * runner discover a 404 three minutes into a job she is waiting on.
 */
export const bedsReady = () => studioFlag(process.env.STUDIO_STITCH_BEDS_READY);

/**
 * How long a listening link lasts. Long enough to hear a track through and come back to it; short
 * enough that a link copied out of the app stops working the same afternoon.
 */
export const BED_PREVIEW_TTL_MS = 15 * 60 * 1000;

/**
 * The object to sign so she can LISTEN to a bed before choosing it, or null.
 *
 * Any valid NAME, listed or not: listing governs what the picker OFFERS, and this only ever
 * resolves a name on the allowlist to the product's own file under studio/beds/ or studio/tracks/. The name is the
 * whole input — there is no path to traverse and nothing of hers to scope. Null while the bytes
 * are not installed, for the reason `bedFor` is: a link to an object that does not exist is a
 * player that spins.
 */
export function bedPreviewPath(name: unknown): string | null {
  if (!isBedName(name) || !bedsReady()) return null;
  return gcsPathOf(name);
}

/** The bed to fetch, or null. Refuses rather than guesses when the bytes are not installed. */
export function bedFor(name: BedName | undefined): BedSource | null {
  if (!name) return null;
  if (!bedsReady()) {
    logger.warn(
      { bed: name },
      "a bed was asked for before any bed object was installed",
    );
    return null;
  }
  return { gcsPath: gcsPathOf(name) };
}

/**
 * A post kit's music, by id: a licensed track (tracks.ts) or a free-library track (studio/music/library.ts). Null when
 * the id is neither, or its bytes are not installed: STUDIO_STITCH_BEDS_READY for a licensed track (as `bedFor`),
 * STUDIO_MUSIC_LIBRARY_READY for a library one.
 *
 * Deliberately NOT `isBedName` widened: the Studio Board's stitch parser accepts any BedName, and the free library is
 * offered only through the post kit's music choices, where brand-safety is checked per kit (agent/postKit/music.ts).
 */
/** Whether a post-kit music id's file is installed here: the library's gate for a library track, the beds' otherwise. */
export const musicInstalled = (id: string): boolean =>
  isLibraryTrackId(id) ? musicLibraryReady() : isTrackId(id) && bedsReady();

export function musicBedFor(id: string | null | undefined): BedSource | null {
  if (!id) return null;
  if (isTrackId(id)) return bedFor(id);
  if (!isLibraryTrackId(id)) return null;
  // The free library has its own gate (library.ts musicLibraryReady): its files are a separate install.
  if (!musicLibraryReady()) {
    logger.warn({ bed: id }, "a library track was asked for before the free library was installed (STUDIO_MUSIC_LIBRARY_READY)");
    return null;
  }
  return { gcsPath: LIBRARY_TRACKS[id].gcsPath };
}

/**
 * How loud the bed sits, as a NAME. Three, not a slider.
 *
 * ─── THIS REVERSES A WRITTEN DECISION, DELIBERATELY ─────────────────────────────────────────────
 *
 * studio/video/spec.ts used to say, at the point it builds the engine's request: "A bed sits under;
 * how far under is a product decision made once, in one place, not a slider per stitch." That held
 * while there was one placeholder tone. With real tracks of different loudness, one level is wrong
 * for some of them, and she is the one who can hear which.
 *
 * What survives of that decision is its actual point — no free number off the wire. This is the
 * same closed-vocabulary rule as `target` and the caption sets: a name travels, the gain lives
 * here, and correcting a gain corrects every queued row.
 *
 * `medium` IS plan.ts's DEFAULT_BED.level, asserted in the suite so the two cannot drift, and it is
 * never stored: absent means medium, so "the default" has one representation.
 */
export const BED_LEVELS = {
  low: { label: "Quiet", gain: 0.15 },
  medium: { label: "Medium", gain: 0.25 },
  high: { label: "Loud", gain: 0.4 },
} as const satisfies Record<string, { label: string; gain: number }>;

export type BedLevelName = keyof typeof BED_LEVELS;
export const DEFAULT_BED_LEVEL = "medium" satisfies BedLevelName;

export const isBedLevelName = (v: unknown): v is BedLevelName =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(BED_LEVELS, v);

/** The names she can actually pick — what a refusal should offer, not every name that still parses. */
export const listedBedNames = (): string[] => [
  ...Object.entries(STITCH_BEDS as Record<string, BedDefinition>)
    .filter(([, b]) => b.listed)
    .map(([name]) => name),
  ...Object.keys(MUSIC_TRACKS),
];

/** "Hype, bright." — a track's note in the picker, from the moods it carries. */
const moodNote = (moods: readonly string[]) =>
  `${moods.join(", ").replace(/^./, (c) => c.toUpperCase())}.`;

/** What the picker renders: every LISTED bed, the levels, and whether music can be used yet. */
export const bedCatalog = () => ({
  ready: bedsReady(),
  beds: [
    ...Object.entries(STITCH_BEDS as Record<string, BedDefinition>)
      .filter(([, b]) => b.listed)
      .map(([name, b]) => ({
        name,
        label: b.label,
        note: b.note,
        // Shown in the picker: crediting a CC0 author is not owed, and is still the decent thing.
        artist: b.provenance?.artist ?? null,
        durationSec: b.durationSec,
        // The grid a stills edit cuts to (PR 5 A2). Null for a bed nobody has measured.
        beat: b.beat,
      })),
    // The licensed tracks (PR 8), in the same shape — so a chip, its preview and "On the beat" work
    // identically for both. A null firstBeatSec is a tempo nobody trusts to cut on: no grid served.
    ...Object.entries(MUSIC_TRACKS).map(([name, t]) => ({
      name,
      label: t.title,
      note: moodNote(t.moods),
      artist: t.author,
      durationSec: t.durationSec,
      beat:
        t.firstBeatSec === null
          ? null
          : { bpm: t.bpm, firstBeatSec: t.firstBeatSec },
    })),
  ],
  levels: Object.entries(BED_LEVELS).map(([name, l]) => ({
    name,
    label: l.label,
  })),
  defaultLevel: DEFAULT_BED_LEVEL,
});
