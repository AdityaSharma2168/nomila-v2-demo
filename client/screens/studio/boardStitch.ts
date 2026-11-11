/**
 * boardStitch — the Board's finished pieces, joined into one video: which clips, in what order, with
 * which joins, and what she is told before she taps.
 *
 * Pure for the reason every other Board module is. It builds real `TimelineItem`s and hands them to
 * the timeline's own `toStitchBody`, so the Board's stitch and the Video tab's stitch send one shape
 * through one function — never a second body builder.
 *
 * ─── ⚠️  THE JOINS ARE WHAT THE BOARD ALREADY PROMISED ─────────────────────────────────────────
 *
 * Every join she did not ask to bridge says "Crossfade · free" on the Board. So it IS a crossfade —
 * `DEFAULT_CROSSFADE_SEC`, the same value the timeline's Fade pill uses. A join she DID bridge is the
 * generated bridge clip itself, and both of its edges are cuts: the bridge arrives at this row's
 * still, which is where this row's clip begins, so fading across that edge would blur the one join
 * that was paid to be seamless.
 *
 * ─── ⚠️  NEVER A SILENT HOLE ────────────────────────────────────────────────────────────────────
 *
 * Pieces fail. The stitch joins what was made — but the button says how many ("Stitch 6 of 8") and
 * every piece left out is named, before she taps. A bridge that failed leaves its join to fall back
 * to the crossfade the Board offered for free; it is named like any other missing piece.
 *
 * ─── ⚠️  A STILL IS A PIECE THAT ALWAYS EXISTS ─────────────────────────────────────────────────
 *
 * A still row (C1b) generates nothing, so it has no view to wait for: it goes into the stitch at
 * its row, held for its `stillSec`, whether or not the shots around it were made. So the walk is
 * over ROWS, not over the pieces the run asked for — a still is not a piece — and a still-only
 * board has something to stitch. Its joins are the free crossfade unless she chose Cut (`cutIn`),
 * never a bridge; and the server's fade-vs-hold rule is mirrored here through the timeline's own
 * `timelineRefusal`, so a 1 s still fading both ways is refused in the server's words before she
 * taps. Her videos still go at the END.
 *
 * Stitching spends nothing — it is CPU, on its own queue — so there is no admission here.
 *
 * ─── THE COMPOSER (PR 15, R-1, docs/probes/composer.md) ─────────────────────────────────────────
 *
 * With `composer` given, every join is chosen by ONE rule — joinLogic `chooseJoin` — from her Cut,
 * the piece (a bridge's edges), whether the source continues, whether the edit is on the music's beat
 * and the reference reading's rhythm; and every choice is recorded in `joins` with its reason, keyed
 * by the position's key, for the dev log and the ledger. Nothing on the surface shows it. With
 * `composer` null (the flag off) the four sites below decide exactly as they always did, and `joins`
 * is empty: the body is byte-identical to before.
 *
 * ─── THE RECORD LEAVES THE CLIENT (PR 15.1, R-4, docs/probes/composer-boundary.md) ──────────────
 *
 * With `composer` given, the body carries `composer: ComposerRecord` — every join's reason, aligned
 * one-for-one with `clips`, every slot a row dropped with its reason, and the plan the Board came
 * from — and the server stores it on the stitch's own spec (studio/video/spec.ts). Until then the dev
 * log was the only way out, which is to say there was none. With `composer` null there is no key.
 */
import {
  DEFAULT_CROSSFADE_SEC,
  timelineRefusal,
  toStitchBody,
  type TimelineItem,
} from "./stitchLogic";
import {
  isClipRow,
  isStillRow,
  type DroppedSlot,
  type PassthroughClip,
  type StoryboardRow,
} from "./storyboardLogic";
import type { VideoEntryView } from "./videoEntryLogic";
import { snapToBeat, type BeatGrid } from "./beatLogic";
import { chooseJoin, type JoinDecision, type JoinInput } from "./joinLogic";
import type { RhythmReading } from "./rhythmLogic";

/** One piece the Board asked for, in playing order — a bridge before the clip it arrives at. */
export interface StitchPiece {
  key: string;
  kind: "bridge" | "clip";
  /** "Shot 2", "Bridge into shot 3" — what she reads when it is left out. */
  label: string;
}

export interface BoardStitch {
  /** The POST /studio/stitch body, or null when it cannot be sent (see `refusal`). */
  body: Record<string, unknown> | null;
  /** Clips that will be in the video — the Board's made pieces, its stills, plus her videos. */
  made: number;
  /** Everything asked for: the Board's pieces, its stills, plus her videos. */
  total: number;
  /** The pieces left out, by name, in playing order. */
  skipped: string[];
  /** The button's words: "Stitch these 8 clips", or "Stitch 6 of 8" when anything is missing. */
  label: string;
  refusal: string | null;
  /**
   * Per ROW key, how its position sits on the music — present only when the stitch is cut on the
   * beat. What the row's "On the beat" and its snapped hold are drawn from, so the Board says
   * exactly what the body will ask for.
   */
  beat: Record<
    string,
    { onBeat: boolean; holdSec: number | null; beats: number | null }
  >;
  /**
   * Per POSITION key, the join INTO it and why (PR 15) — `{ kind, reason }`, present only with the
   * composer on. Position 0 is in it too, as "position-0". For the log and the ledger, never the UI.
   */
  joins: Record<string, JoinDecision>;
}

/** What the composer needs beyond the Board's own state: the reading's rhythm, or null for none. */
export interface ComposerInput {
  rhythm: RhythmReading | null;
  /**
   * The plan this Board was seeded from, or null/absent for a hand-built board (PR 15.1, D-2). Rides on
   * the record so a later reader can join a dropped slot to the plan item it came from.
   */
  planId?: string | null;
}

/**
 * What the stitch body carries for the composer (PR 15.1, R-4) — stored verbatim on the stitch spec.
 * `joins[i]` is the join INTO `clips[i]`, keyed by the position's key (`<row key>:<still|own|clip|bridge>`
 * or `passthrough:<asset id>`); `dropped` is every row's `droppedSlots`, by row key.
 */
export interface ComposerRecord {
  joins: ({ key: string } & JoinDecision)[];
  dropped: {
    row: string;
    slot: DroppedSlot["slot"];
    value: string;
    reason: DroppedSlot["reason"];
  }[];
  planId?: string;
}

/**
 * The music the Board lays under the stitch — a curated bed by NAME — and whether the edit is cut
 * to its beat. `grid` is the bed's measured grid off /stitch/options (null for a bed nobody has
 * measured, which can be laid under a video but not cut to).
 */
export interface BoardMusic {
  bed: string;
  grid: BeatGrid | null;
  onBeat: boolean;
}

/** The server's portrait target runs at 30 fps (studio/video/spec.ts STITCH_TARGETS.portrait). */
const TARGET_FPS = 30;

/** Portrait: every Board clip is made 9:16 for her feed. */
const TARGET = "portrait" as const;

/**
 * The asset a finished watch made — its first clip once it is ready — or null. One reading, for the
 * pieces the stitch joins and for the stitched video the Board hands to the Video tab.
 */
export const madeAssetId = (view: VideoEntryView | null | undefined) =>
  view?.phase === "ready" ? (view.clips[0]?.assetId ?? null) : null;

export function boardStitch(
  /** The Board's rows, in order — the walk is over these; a still has no piece. */
  rows: StoryboardRow[],
  pieces: StitchPiece[],
  views: Record<string, VideoEntryView>,
  passthrough: PassthroughClip[],
  /** /studio/stitch/options `limits.maxClips` — null until it has been read. */
  maxClips: number | null,
  /** Music under it, and whether it is cut on the beat — null for a silent stitch, as before. */
  music: BoardMusic | null = null,
  /** The server's hold bounds — needed to cut on the beat; without them nothing is snapped. */
  holdLimits: { minStillSec: number; maxStillSec: number } | null = null,
  /** One look over every photo on the board (A3), by name — null for the photos as they are. */
  look: string | null = null,
  /** The composer (PR 15): joins by rule, with reasons. Null is the flag off — today's joins exactly. */
  composer: ComposerInput | null = null,
): BoardStitch {
  const items: TimelineItem[] = [];
  const skipped: string[] = [];
  const joins: Record<string, JoinDecision> = {};
  let boardMade = 0;
  let stills = 0;
  let own = 0;
  /** The row whose bridge was the last thing placed — its clip then follows on a cut. */
  let bridgedRow: string | null = null;
  /** The source asset of the last position placed — a continuation is the same source again. */
  let lastSource: string | null = null;
  // On the beat, for the composer: a track with a measured grid is chosen and the toggle is on. The
  // hold limits are what SNAPPING needs, not what a cut needs.
  const onBeatEdit = !!(music?.onBeat && music.grid);

  /**
   * The join into the position about to be pushed: the composer's decision, or the legacy answer
   * the site computed. ⚠️ MUTATION (boardStitch.test): read `legacyFades` with the composer on —
   * "editing_rhythm never chooses a join" and "on-beat toggle ignored at a cut" red by name.
   */
  const joinInto = (
    key: string,
    legacyFades: boolean,
    input: Omit<JoinInput, "index" | "onBeat" | "rhythm">,
  ): { crossfadeSec?: number } => {
    if (!composer)
      return legacyFades ? { crossfadeSec: DEFAULT_CROSSFADE_SEC } : {};
    const decision = chooseJoin({
      ...input,
      index: items.length,
      onBeat: onBeatEdit,
      rhythm: composer.rhythm?.pace ?? null,
    });
    joins[key] = decision;
    return decision.kind === "fade"
      ? { crossfadeSec: DEFAULT_CROSSFADE_SEC }
      : {};
  };
  const continues = (source: string | null) =>
    source !== null && lastSource === source;

  for (const row of rows) {
    if (isStillRow(row) && row.assetId && row.stillSec !== undefined) {
      // A still always goes in — there is nothing to fail. Its join in is the free fade unless she
      // cut it; row 0 fades from nothing.
      const key = `${row.key}:still`;
      items.push({
        key,
        assetId: row.assetId,
        durationSec: null,
        durationPreciseSec: null,
        stillSec: row.stillSec,
        ...(row.stillMotion ? { stillMotion: row.stillMotion } : {}),
        ...(row.stillFocus ? { stillFocus: row.stillFocus } : {}),
        ...joinInto(key, items.length > 0 && !row.cutIn, {
          cutIn: !!row.cutIn,
          piece: "still",
          afterOwnBridge: false,
          continuation: continues(row.assetId),
        }),
      });
      bridgedRow = null;
      lastSource = row.assetId;
      stills += 1;
      continue;
    }
    if (isClipRow(row) && row.assetId) {
      // HER OWN CLIP always goes in, at its row, as an ordinary video position (C2 Half B): its
      // window is the beat it was cut to, its sound is kept only when she said so, and its join in
      // is the free fade unless she cut it. Nothing to fail: nothing was made.
      const key = `${row.key}:own`;
      items.push({
        key,
        assetId: row.assetId,
        durationSec: row.clipSec ?? null,
        durationPreciseSec: null,
        ...(row.clipTrim
          ? {
              trimStartSec: row.clipTrim.startSec,
              trimEndSec: row.clipTrim.endSec,
            }
          : {}),
        ...(row.audio ? {} : { muted: true as const }),
        ...joinInto(key, items.length > 0 && !row.cutIn, {
          cutIn: !!row.cutIn,
          piece: "own",
          afterOwnBridge: false,
          continuation: continues(row.assetId),
        }),
      });
      bridgedRow = null;
      lastSource = row.assetId;
      own += 1;
      continue;
    }
    // ⚠️ THE ROW'S PIECES IN PIECE ORDER — the bridge into it, then its clip — exactly as the run
    // spent them. `pieces` is already in playing order, so a filter keeps it.
    for (const piece of pieces.filter((p) => p.key === row.key)) {
      const assetId = madeAssetId(views[`${piece.key}:${piece.kind}`]);
      if (!assetId) {
        skipped.push(piece.label);
        if (piece.kind === "clip") bridgedRow = null;
        continue;
      }
      // A clip after its own made bridge is a cut; a bridge's own edges are cuts; a join she cut
      // beside a still is a cut; every other join into a clip is the free crossfade the Board
      // promised. Position 0 fades from nothing.
      const fades =
        items.length > 0 &&
        piece.kind === "clip" &&
        bridgedRow !== piece.key &&
        !row.cutIn;
      const key = `${piece.key}:${piece.kind}`;
      // A generated piece's SOURCE is the row's photo — a still of it followed by its own animation
      // continues; a bridge has two sources and continues nothing.
      const source = piece.kind === "clip" ? row.assetId : null;
      items.push({
        key,
        assetId,
        durationSec: null,
        durationPreciseSec: null,
        ...joinInto(key, fades, {
          cutIn: !!row.cutIn,
          piece: piece.kind,
          afterOwnBridge: piece.kind === "clip" && bridgedRow === piece.key,
          continuation: continues(source),
        }),
      });
      bridgedRow = piece.kind === "bridge" ? piece.key : null;
      lastSource = source;
      boardMade += 1;
    }
  }

  // Her videos, at the end, in the order she picked them — joined like any free join.
  for (const clip of passthrough) {
    const key = `passthrough:${clip.assetId}`;
    items.push({
      key,
      assetId: clip.assetId,
      durationSec: null,
      durationPreciseSec: null,
      ...joinInto(key, items.length > 0, {
        cutIn: false,
        piece: "passthrough",
        afterOwnBridge: false,
        continuation: continues(clip.assetId),
      }),
    });
    lastSource = clip.assetId;
  }

  // ON THE BEAT: each still ends on a beat and every join beside one is a cut (beatLogic).
  const beat: BoardStitch["beat"] = {};
  const snapping = music?.onBeat && music.grid && holdLimits;
  const placed = snapping
    ? snapToBeat(items, {
        grid: music.grid as BeatGrid,
        fps: TARGET_FPS,
        ...holdLimits,
      })
    : null;
  if (placed) {
    for (const [i, p] of placed.entries()) {
      items[i] = p.item;
      // The row key is the item key up to its last ":" — `${row.key}:still`, `${piece.key}:clip`.
      const rowKey = p.item.key.slice(0, p.item.key.lastIndexOf(":"));
      if (p.item.key.endsWith(":bridge")) continue;
      beat[rowKey] = {
        onBeat: p.onBeat,
        holdSec: p.item.stillSec ?? null,
        beats: p.beats,
      };
    }
  }

  const made = items.length;
  const total = pieces.length + stills + own + passthrough.length;
  const label =
    made === total
      ? `Stitch these ${made} clips`
      : `Stitch ${made} of ${total}`;

  // The server's fade-vs-hold rule for a still, in the timeline's own words (it needs no limits).
  // Only a still can trip it, and only when it is held for less than its two fades.
  const fadeRefusal = items.length > 0 ? timelineRefusal(items, null) : null;

  const refusal =
    boardMade === 0 && stills === 0 && own === 0
      ? "Nothing on this board was made, so there's nothing to stitch yet."
      : fadeRefusal !== null
        ? fadeRefusal
        : maxClips !== null && made > maxClips
          ? `That's ${made} clips — one video can join up to ${maxClips}. Remove a video or a shot.`
          : null;

  return {
    body:
      refusal === null
        ? {
            ...toStitchBody(items, TARGET, music?.bed ?? null, null, {}, look),
            // Only with the composer on — off, the body has no such key and is byte-identical.
            // ⚠️ MUTATION (studio.stitch.test): drop this — "a join reason never leaves the client"
            // and "a dropped slot never leaves the client" red by name.
            ...(composer
              ? { composer: composerRecord(items, joins, rows, composer) }
              : {}),
          }
        : null,
    made,
    total,
    skipped,
    label,
    refusal,
    beat,
    joins,
  };
}

/**
 * The record, from what this stitch decided: one join per position IN PLAYING ORDER (the order of
 * `clips` on the wire, so the index is the join key), every row's dropped slots, and the plan id.
 */
function composerRecord(
  items: TimelineItem[],
  joins: Record<string, JoinDecision>,
  rows: StoryboardRow[],
  composer: ComposerInput,
): ComposerRecord {
  return {
    joins: items.map((item) => ({ key: item.key, ...joins[item.key] })),
    dropped: rows.flatMap((r) =>
      (r.droppedSlots ?? []).map((d) => ({
        row: r.key,
        slot: d.slot,
        value: d.value,
        reason: d.reason,
      })),
    ),
    ...(composer.planId ? { planId: composer.planId } : {}),
  };
}
