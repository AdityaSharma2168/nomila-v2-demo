/**
 * tracks.ts — the music catalogue a stitch will be able to choose from, with what the recommender
 * needs to choose well: tempo, where the beat falls, mood, energy, and whether it may go under a
 * brand's video.
 *
 * ─── A COMMITTED MODULE, NOT A TABLE ────────────────────────────────────────────────────────────
 *
 * The same argument studio/video/beds.ts makes: a track is product media, the same for every
 * athlete, curated by a person and cleared before it is offered. A short list that changes by hand
 * belongs in code review, not in a row anyone with a DB client can edit. The wire will carry an
 * id; the bytes live at `studio/tracks/<id>.m4a` in the media bucket.
 *
 * NOTHING SELECTS THESE YET. The stitch's bed allowlist is still beds.ts, and the Board's picker is
 * wired after PR 5 merges. This file is the data half.
 *
 * ─── THE MANIFEST ───────────────────────────────────────────────────────────────────────────────
 *
 * tracks.manifest.json, beside this file, is the record of the exact objects uploaded: size,
 * SHA-256, and the MD5 the bucket reported back on 2026-09-22 (`gsutil ls -L`), plus the file as
 * downloaded. Each entry here repeats its SHA-256, and the suite fails an entry whose hash differs
 * from the manifest by name — so a re-cut file cannot slip in under old measurements.
 *
 * ─── THE GRID ───────────────────────────────────────────────────────────────────────────────────
 *
 * `bpm` and `firstBeatSec` were measured OFFLINE with the spectral-flux detector from PR 5
 * (studio/photos-motion, server/studio/video/beatGrid.ts @ 7c79f36), run from probe-out — nothing
 * here decodes audio. A grid is committed only if the track's first and second halves, measured
 * independently, agree within 0.05 BPM and 15 ms of phase — or, where it does not, a person has
 * listened to a click overlay of the committed grid and the entry says so. `firstBeatSec: null`
 * means the tempo is known but the grid is NOT trusted to cut on.
 */

export const TRACK_LICENSES = ["artlist", "CC0-1.0", "PD"] as const;
export type TrackLicense = (typeof TRACK_LICENSES)[number];

/** Closed vocabulary. The recommender maps her words onto these and names only these. */
export const TRACK_MOODS = [
  "hype",
  "warm",
  "reflective",
  "bright",
  "driving",
  "dark",
  "playful",
  "uplifting",
] as const;
export type TrackMood = (typeof TRACK_MOODS)[number];

export type Energy = 1 | 2 | 3 | 4 | 5;

export interface TrackDefinition {
  title: string;
  /** As the download credited it. */
  author: string;
  license: TrackLicense;
  /**
   * Whose licence covers it. Required for a vendor licence: an Artlist grant belongs to a
   * subscription, and "who holds it" is the first question anyone auditing a brand deliverable asks.
   */
  planHolder: string | null;
  /** The track's own page, when one was recorded. Required for CC0/PD. */
  sourceUrl: string | null;
  /** YYYY-MM-DD the file was taken. */
  retrievedOn: string;
  /** Bucket-relative. */
  gcsPath: string;
  /** Of the uploaded .m4a; must equal tracks.manifest.json. */
  sha256: string;
  /** Measured off the uploaded file with ffprobe. */
  durationSec: number;
  bpm: number;
  /** Seconds to beat 0, in [0, 60/bpm) — or null when the grid failed its half-split check. */
  firstBeatSec: number | null;
  moods: readonly TrackMood[];
  energy: Energy;
  /**
   * Whether it may sit under a video she makes FOR A BRAND. True for the Artlist set pending Mia's
   * reading of the subscription's terms; it flips here, in one place, on her answer — and the
   * recommender never offers a false one for brand work.
   */
  brandSafe: boolean;
}

export const MUSIC_TRACKS = {
  "walking-around": {
    title: "Walking Around",
    author: "Eldar Kedem",
    license: "artlist",
    planHolder: "Aditya Sharma",
    sourceUrl: null,
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/walking-around.m4a",
    sha256: "382875d2178c3e876bd161b9d0999e2bd007a41f3b0a952dcd7000c69abd7cc8",
    durationSec: 177.9,
    bpm: 84,
    firstBeatSec: 0.696,
    moods: ["warm", "reflective"],
    energy: 2,
    brandSafe: true,
  },
  status: {
    title: "Status",
    author: "Jamie Bathgate",
    license: "artlist",
    planHolder: "Aditya Sharma",
    sourceUrl: null,
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/status.m4a",
    sha256: "2f02ce7ac02d4aa9ab24f074734bcb938dd9bb5904dedcc3daca9cc2d0895950",
    durationSec: 188.11,
    bpm: 89.99,
    // FAILED the half-split check: tempo agrees (90.00 / 90.01) but the second half's own grid sat
    // 327 ms — half a beat — off the first's. The whole-track grid below was then ear-checked by
    // Aditya Sharma on 2026-09-22 at 5 s and at 130 s and is on the beat at both: the second half's
    // detector had locked onto the off-beat, not the track drifting.
    firstBeatSec: 0.328,
    moods: ["driving", "dark"],
    energy: 3,
    brandSafe: true,
  },
  "with-your-hands": {
    title: "With your Hands",
    author: "Oc/In",
    license: "artlist",
    planHolder: "Aditya Sharma",
    sourceUrl: null,
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/with-your-hands.m4a",
    sha256: "0e68da75c8e03d890696cb679c4b9de78f320da1457779550de97b80f7f91770",
    durationSec: 129.48,
    bpm: 114.99,
    firstBeatSec: 0.086,
    moods: ["hype", "bright"],
    energy: 4,
    brandSafe: true,
  },
  save: {
    title: "SAVE!",
    author: "VESHZA",
    license: "artlist",
    planHolder: "Aditya Sharma",
    sourceUrl: null,
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/save.m4a",
    sha256: "4f83ae902e863a18162b25a219b4f71be35fb1db7687f501cf1b023f86b4e60d",
    durationSec: 110.09,
    // The detector reported 60.00, its floor. A 120 grid from the same first beat was ear-checked
    // by Aditya Sharma on 2026-09-22 and lands on a beat at every click: 60 skipped every other one.
    bpm: 120,
    firstBeatSec: 0.092,
    moods: ["hype", "driving"],
    energy: 4,
    brandSafe: true,
  },
} as const satisfies Record<string, TrackDefinition>;

export type TrackId = keyof typeof MUSIC_TRACKS;

export const isTrackId = (v: unknown): v is TrackId =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(MUSIC_TRACKS, v);
