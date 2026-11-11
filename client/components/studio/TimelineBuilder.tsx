/**
 * TimelineBuilder — Pipeline 1 (upload → stitch → music), the functional half of video V7 layer 4.
 *
 * Pick clips, order them, join them, score them, watch it come back. The arithmetic is NOT here —
 * it is in screens/studio/stitchLogic.ts, pure and tested without a renderer, for the reason
 * videoEntryLogic.ts gives: this surface is provisional and the thinking must survive it being
 * deleted.
 *
 * ─── WHAT THIS DOES NOT DO, AND WHY ─────────────────────────────────────────────────────────────
 *
 * NO TRIM UI YET. The spec and the server accept `trimStartSec` / `trimEndSec` per position and the
 * engine honours them; the handles that set them land on `TimelineTrack` once there is a preview to
 * trim against. The wire has been shaped for it all along.
 *
 * NO DRAG TO REORDER YET. Up/down on each row instead. The `Row` list below the track is still the
 * only way to reorder or remove, deliberately: the track is added ABOVE it rather than swapped for
 * it, so nothing she can do today stops working before the drag that replaces these controls
 * exists.
 *
 * ─── IT SPENDS NOTHING ──────────────────────────────────────────────────────────────────────────
 *
 * A stitch is one ffmpeg call. No preview, no approval, no cost line, no `previewId`.
 *
 * DESIGN.md: pills at least 120px; cards at radius `lg`; no blur; Feather icons; reanimated only;
 * fontWeight always paired with its Outfit face, which does nothing on iOS alone.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useQueryClient } from "@tanstack/react-query";
import Animated, { FadeIn } from "react-native-reanimated";
import { HapticPressable } from "../HapticPressable";
import { ClipPoster } from "./ClipPoster";
import { TimelinePreview, type PreviewSpec } from "./TimelinePreview";
import { TimelineTrack } from "./TimelineTrack";
import { VideoEntry } from "./VideoEntry";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import {
  useQueueStitch,
  useStitchClips,
  useStitchStills,
  fetchBedPreviewUrl,
  fetchSoundPreviewUrl,
  useCaptionPreview,
  useCaptionSuggestion,
  useStitchOptions,
  type CaptionOptions,
  type NamedChoice,
  type BedChoice,
} from "../../hooks/use-studio-stitch";
import { useRunWatch, type Watch } from "../../hooks/use-studio-sessions";
import { PublishPill } from "./PublishPill";
import { useClipDurations } from "../../hooks/use-clip-durations";
import {
  pickFromCameraRoll,
  RightsAckRequired,
  useUploadMedia,
} from "../../hooks/use-media-library";
import { RightsAckPanel } from "../media/RightsAckPanel";
import { STUDIO_COMPOSER } from "../../lib/flags";
import { StudioMediaPicker, type PickerTileProps } from "./StudioMediaPicker";
import {
  MOUNT_ORIGINS,
  type PickerRow,
} from "../../screens/studio/mediaPickerLogic";
import {
  addClip,
  addStill,
  isStill,
  setStillSec,
  clock,
  fineTuneTimeline,
  normalize,
  removeAt,
  reorderTo,
  setBridgeRequested,
  setCaption,
  setClipMuted,
  setCrossfade,
  setTrim,
  soundOffsetAt,
  splitAt,
  MIN_SEGMENT_SEC,
  timelineRefusal,
  timelineSignature,
  timelineTotals,
  toStitchBody,
  type TimelineCaption,
  DEFAULT_CROSSFADE_SEC,
  MAX_CROSSFADE_SEC,
  type ClipChoice,
  type StillChoice,
  type StitchLimits,
  type StitchTargetName,
  type TimelineItem,
  type TrimEdge,
} from "../../screens/studio/stitchLogic";
import {
  videoEntryFromJob,
  type VideoEntryView,
} from "../../screens/studio/videoEntryLogic";
import { ratioForTarget } from "./playerBox";
import {
  clampToTrack,
  resolvePlayhead,
  trackLayout,
  trackTimeAt,
} from "../../screens/studio/timelineGeometry";

const TARGETS: { name: StitchTargetName; label: string }[] = [
  { name: "portrait", label: "Portrait" },
  { name: "square", label: "Square" },
  { name: "landscape", label: "Landscape" },
];

/**
 * The crossfade she can set on a join. One value, not a slider — a provisional surface. Declared in
 * stitchLogic, because the Board's "Crossfade · free" promises the same fade.
 */
const CROSSFADE_SEC = DEFAULT_CROSSFADE_SEC;

export function TimelineBuilder({
  onOpenDetail,
  initialClipId,
  onInitialClipTaken,
  captionFeel = null,
}: {
  onOpenDetail?: (assetId: string) => void;
  /** A video to start the timeline with — the Board's "Fine-tune in Video". */
  initialClipId?: string | null;
  /** Called once it is on the timeline, so it is never put there twice. */
  onInitialClipTaken?: () => void;
  /**
   * The Board's row sentences and purpose, when the Board handed this timeline over (PR 15, R-5) —
   * what the caption suggestion is read from. Null on a timeline she built here: no words, no chip.
   */
  captionFeel?: { feel: string[]; objective: string } | null;
}) {
  const options = useStitchOptions(true);
  const clips = useStitchClips(true);
  // Her photos, for holding as stills — Studio's own list (GET /studio/stitch/stills).
  const stills = useStitchStills(true);
  const queue = useQueueStitch();

  const [items, setItems] = useState<TimelineItem[]>([]);

  // ─── ARRIVING FROM THE BOARD ───────────────────────────────────────────────────────────────────
  // The stitched video goes on the timeline as soon as the clip list holds it — and only onto an
  // empty timeline (`fineTuneTimeline`). The tab mounts fresh on arrival, so in practice it is.
  useEffect(() => {
    if (!initialClipId) return;
    const start = fineTuneTimeline(items, clips.data, initialClipId);
    if (!start) return;
    setItems(normalize(start));
    onInitialClipTaken?.();
  }, [initialClipId, clips.data, items, onInitialClipTaken]);
  const [target, setTarget] = useState<StitchTargetName>("portrait");
  const [bed, setBed] = useState<string | null>(null);
  /** A level NAME, or null for the server's default. Kept when she picks None, so it survives a
   *  change of mind — `toStitchBody` is what stops it travelling without a bed. */
  const [bedLevel, setBedLevel] = useState<string | null>(null);
  /**
   * What the result on screen was made FROM — `timelineSignature` at the moment it was queued.
   *
   * The result card stays up while she keeps editing above it. Without this, she changes a caption,
   * looks down, and sees a video captioned the old way with nothing to say so. The signature IS the
   * request body, so anything that would change what the server makes marks the result stale —
   * including every field added after this line was written (see TIMELINE_ITEM_FIELDS).
   */
  const [queuedSignature, setQueuedSignature] = useState<string | null>(null);
  /**
   * One of HER videos, whose sound plays underneath instead of a track. An asset id.
   *
   * ⚠️  NEVER SET TOGETHER WITH `bed`. The two setters below are the only way either changes, and
   * each clears the other — the server 400s a body that names both, and `toStitchBody` would
   * silently prefer the track, so a state holding both would show her one thing and send another.
   */
  const [ownSound, setOwnSound] = useState<string | null>(null);
  /** Seconds into the sound that play at 0:00. Back to the top whenever the sound changes. */
  const [bedStartSec, setBedStartSec] = useState(0);

  /**
   * The sound is chosen and cropped but LEFT OUT. Not a server field: a muted sound is simply not
   * sent (see `sentBed` / `sentSound`), which is exactly what "without the music" means — and her
   * choice and where it starts survive, so un-muting is one tap and not a re-do.
   */
  const [soundMuted, setSoundMuted] = useState(false);
  /** Bumped when she picks a sound: the preview unmutes, because she chose it to hear it. */
  const [unmuteSignal, setUnmuteSignal] = useState(0);

  const chooseTrack = useCallback((name: string | null) => {
    setBed(name);
    setOwnSound(null);
    setBedStartSec(0);
    setSoundMuted(false);
    if (name) setUnmuteSignal((n) => n + 1);
  }, []);
  const chooseOwnSound = useCallback((assetId: string | null) => {
    setOwnSound(assetId);
    setBed(null);
    setBedStartSec(0);
    setSoundMuted(false);
    if (assetId) setUnmuteSignal((n) => n + 1);
  }, []);
  // What actually TRAVELS. Everything that builds a body or a signature uses these two, never
  // `bed`/`ownSound` directly — so muting the sound makes a finished result stale like any other
  // edit, and cannot be forgotten at one call site.
  const sentBed = soundMuted ? null : bed;
  const sound = useMemo(
    () => ({ bedAssetId: soundMuted ? null : ownSound, bedStartSec }),
    [ownSound, bedStartSec, soundMuted],
  );
  const [stitchId, setStitchId] = useState<string | null>(null);
  /**
   * What the preview is showing, and which timeline position is lit up for it.
   *
   * The spec carries a TOKEN that changes on every request, including for the clip already showing
   * — tapping it again has to restart it, and keying off the uri would make that a no-op.
   */
  const [preview, setPreview] = useState<PreviewSpec | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /**
   * Where the playhead sits, in TRACK seconds.
   *
   * ⚠️  THIS DOES NOT DRIVE THE PLAYER. It is moved by a scrub AND by playback, and if its value
   * produced a seek then every progress tick would re-seek the clip and playback would stutter or
   * stall. A seek request is only ever produced by a GESTURE or a TAP — `setPreview` below is
   * called from those and from nothing else.
   */
  const [playheadSec, setPlayheadSec] = useState(0);
  const token = useRef(0);
  /**
   * The shape the RESULT is in.
   *
   * Snapshotted at queue time rather than read from `target`, which she can still change while the
   * stitch runs — the engine conformed every clip to whatever was chosen when it was queued, so
   * reading the live value would draw a portrait result in a landscape box the moment she browsed
   * the shapes again.
   */
  const [resultTarget, setResultTarget] =
    useState<StitchTargetName>("portrait");
  const [view, setView] = useState<VideoEntryView | null>(null);

  // "unavailable" is the 404 reading useStudioContent takes: the surface is not released on this
  // server. Narrowed once, here, so nothing below has to keep re-proving it is not a string.
  const opts =
    options.data && options.data !== "unavailable" ? options.data : null;
  const limits = opts?.limits ?? null;

  /*
   * Rows she picked from the shared picker's "View more" — past the /stitch/* lists' newest 60. The
   * timeline resolves every position through the maps below, so a clip picked from further down has
   * to be in them too, or it lands on the track with no poster and no mp4. The lists' own rows win
   * where both hold one: they are re-signed on every mount.
   */
  const [pickedRows, setPickedRows] = useState<ReadonlyMap<string, PickerRow>>(
    () => new Map(),
  );
  const remember = useCallback(
    (r: PickerRow) =>
      setPickedRows((m) =>
        m.has(r.assetId) ? m : new Map(m).set(r.assetId, r),
      ),
    [],
  );

  // The picker's rows, by id — the track needs a still per position, and the same clip may hold
  // more than one of them.
  const clipsById = useMemo(() => {
    const out = new Map<string, ClipChoice>();
    for (const r of pickedRows.values())
      if (r.kind === "clip") out.set(r.assetId, r);
    for (const c of clips.data ?? []) out.set(c.assetId, c);
    return out;
  }, [clips.data, pickedRows]);
  const stillsById = useMemo(() => {
    const out = new Map<string, StillChoice>();
    for (const r of pickedRows.values())
      if (r.kind === "photo") out.set(r.assetId, r);
    for (const p of stills.data ?? []) out.set(p.assetId, p);
    return out;
  }, [stills.data, pickedRows]);
  /*
   * What the TRACK draws each position from: a clip's poster and mp4, or a held photo's thumbnail
   * with no mp4 at all — so a still's tile is its picture and never a player. The two id spaces
   * cannot collide: a photo is never a clip (the server resolves them through disjoint predicates).
   */
  const trackSources = useMemo(() => {
    const out = new Map<
      string,
      { videoUrl: string | null; posterUrl: string | null }
    >(clipsById);
    for (const p of stillsById.values()) {
      out.set(p.assetId, { videoUrl: null, posterUrl: p.thumbUrl });
    }
    return out;
  }, [clipsById, stillsById]);

  /*
   * ⚠️  FED THE TIMELINE, NOT THE STRIP. This opens decoders. The timeline is bounded at
   * `maxClips`; the strip is every video she owns and is bounded by nothing. Measuring the strip
   * would be the cost `ClipPoster` exists to avoid, paid again and on a longer list.
   */
  const onTimeline = useMemo(
    () =>
      items.map((i) => ({
        assetId: i.assetId,
        // A held photo has no video to decode; its length is its hold.
        videoUrl: isStill(i)
          ? null
          : (clipsById.get(i.assetId)?.videoUrl ?? null),
        // The server already probed this one — no reason to open a decoder for it.
        knownSec: i.stillSec ?? i.durationPreciseSec,
      })),
    [items, clipsById],
  );
  const measured = useClipDurations(onTimeline);

  /*
   * Computed HERE and handed down, rather than inside the track. The scrub has to resolve a second
   * to a clip and the track has to draw that same clip; two calls from the same inputs is one
   * stale `pxPerSec` away from disagreeing about where a clip starts.
   */
  const layout = useMemo(() => trackLayout(items, measured), [items, measured]);

  /** Show a clip straight from the picker — the whole source, since it holds no position yet. */
  const previewClip = useCallback((c: ClipChoice) => {
    if (!c.videoUrl) return;
    token.current += 1;
    setPreview({
      token: token.current,
      uri: c.videoUrl,
      startSec: 0,
      endSec: null,
      autoplay: true,
    });
    setSelectedKey(null);
  }, []);

  /** Show a held photo: the picture itself, never a player (TimelinePreview `still`). */
  const showStill = useCallback((uri: string) => {
    token.current += 1;
    setPreview({
      token: token.current,
      uri,
      startSec: 0,
      endSec: null,
      autoplay: false,
      still: true,
    });
  }, []);

  /** Show a position ON the timeline — its trimmed window, in SOURCE seconds. */
  const previewItem = useCallback(
    (key: string) => {
      const item = items.find((i) => i.key === key);
      if (item && isStill(item)) {
        const photo = stillsById.get(item.assetId)?.imageUrl;
        if (!photo) return;
        showStill(photo);
        setSelectedKey(key);
        const rect = layout.rects.find((r) => r.key === key);
        if (rect) setPlayheadSec(rect.startSec);
        return;
      }
      const uri = item && clipsById.get(item.assetId)?.videoUrl;
      if (!item || !uri) return;
      token.current += 1;
      setPreview({
        token: token.current,
        uri,
        startSec: item.trimStartSec ?? 0,
        endSec: item.trimEndSec ?? null,
        autoplay: true,
      });
      setSelectedKey(key);
      const rect = layout.rects.find((r) => r.key === key);
      if (rect) setPlayheadSec(rect.startSec);
    },
    [items, clipsById, stillsById, layout, showStill],
  );

  /**
   * Dragging the ruler: move the line, and show the frame under it WITHOUT playing.
   *
   * A clip running on under a dragging finger is the same failure as not seeking at all — the
   * frame she is pointing at is gone by the time she looks at it.
   */
  const onScrub = useCallback(
    (sec: number) => {
      const at = clampToTrack(sec, layout);
      setPlayheadSec(at);
      const where = resolvePlayhead(at, layout);
      const item = where ? items[where.index] : null;
      // Over a held photo the frame under the line IS the photo.
      if (item && isStill(item)) {
        const photo = stillsById.get(item.assetId)?.imageUrl;
        if (photo) {
          showStill(photo);
          setSelectedKey(item.key);
        }
        return;
      }
      const uri = item && clipsById.get(item.assetId)?.videoUrl;
      if (!where || !item || !uri) return;
      token.current += 1;
      setPreview({
        token: token.current,
        uri,
        startSec: where.sourceSec,
        endSec: item.trimEndSec ?? null,
        autoplay: false,
      });
      setSelectedKey(item.key);
    },
    [layout, items, clipsById, stillsById, showStill],
  );

  /**
   * Dragging one edge of the selected clip.
   *
   * The whole length comes off the LAYOUT rather than being re-derived, so the handle is clamped
   * against exactly the duration the track was drawn with. The preview follows the edge as it
   * moves — trimming blind is guessing — and it SEEKS rather than plays, the same as a scrub.
   */
  const onTrim = useCallback(
    (key: string, edge: TrimEdge, seconds: number) => {
      const index = items.findIndex((i) => i.key === key);
      const rect = layout.rects.find((r) => r.key === key);
      if (index < 0 || !rect || rect.durationSource === "unknown") return;
      // A held photo has no footage to trim (the track offers no handles; setTrim refuses too).
      if (isStill(items[index])) return;

      setItems((list) => setTrim(list, index, edge, seconds, rect.wholeSec));

      const uri = clipsById.get(items[index].assetId)?.videoUrl;
      if (!uri) return;
      const at = Math.min(Math.max(seconds, 0), rect.wholeSec);
      token.current += 1;
      setPreview({
        token: token.current,
        uri,
        startSec: at,
        // No out-point while the edge is moving: the point is to SEE the frame she is choosing.
        endSec: null,
        autoplay: false,
      });
    },
    [items, layout, clipsById],
  );

  /**
   * Where the playhead would cut, and whether that cut is legal — null when it is not.
   *
   * ⚠️  A BUTTON, NOT A TAP ON THE CLIP. Tapping a clip already selects it and fills the preview;
   * making the same tap also cut it would make selection destructive. So the control is explicit
   * and simply disabled when there is nothing legal to do, rather than refusing after the fact.
   */
  const cut = useMemo(() => {
    const index = items.findIndex((i) => i.key === selectedKey);
    const rect = layout.rects.find((r) => r.key === selectedKey);
    if (index < 0 || !rect || rect.durationSource === "unknown") return null;
    // Nothing to cut in a held photo — Split stays disabled on one (splitAt refuses it too).
    if (isStill(items[index])) return null;

    const at = resolvePlayhead(playheadSec, layout);
    // The playhead has to be inside THIS clip — it can sit over a neighbour after a reorder.
    if (!at || at.index !== index) return null;
    if (at.sourceSec - rect.sourceStartSec < MIN_SEGMENT_SEC) return null;
    if (rect.sourceEndSec - at.sourceSec < MIN_SEGMENT_SEC) return null;

    return { index, atSourceSec: at.sourceSec, whole: rect.wholeSec };
  }, [items, selectedKey, layout, playheadSec]);

  /**
   * A clip moved to a new position — from a DROP or from an ARROW, and this cannot tell which.
   *
   * ⚠️  THAT IS THE DESIGN. Both affordances choose a target index and nothing else, so both hand
   * it to the same `reorderTo`. Giving each its own mutation is how two paths that agree today
   * quietly stop agreeing later; with one, the rules that live in there — `normalize` after every
   * move, trims travelling with their clip — cannot reach one and miss the other.
   *
   * They stay side by side permanently. A press-hold-then-drag is natural on touch and awkward with
   * a trackpad, where a pair of buttons is both discoverable and exact.
   */
  const onReorder = useCallback((key: string, toIndex: number) => {
    setItems((list) => reorderTo(list, key, toIndex));
  }, []);

  /**
   * ⚠️  MEMOISED AGAINST THE PLAYHEAD. Playback moves the playhead five times a second, and each
   * move is a setState on this component — but nothing in the strip depends on it. Without this,
   * every progress tick reconciles a dozen-odd tiles, several of which mount a decoder, which is
   * what made the preview feel laggy. Lowering the progress rate instead would only trade the lag
   * for a stuttering playhead.
   */
  const onPickClip = useCallback(
    (r: PickerRow) => {
      if (r.kind !== "clip") return;
      remember(r);
      // Adds AND shows it. Making the tap preview INSTEAD would remove the primary action this
      // strip exists for.
      setItems((list) => normalize(addClip(list, r)));
      previewClip(r);
    },
    [remember, previewClip],
  );
  const clipTile = useCallback(
    (r: PickerRow, t: PickerTileProps) =>
      r.kind === "clip" ? <ClipTile clip={r} onAdd={t.onPress} /> : null,
    [],
  );
  const strip = useMemo(
    () => (
      <StudioMediaPicker
        kind="clips"
        origins={MOUNT_ORIGINS["video-clip"]}
        context="video-clip"
        pageSize={60}
        upload="video"
        label="Add this clip to the timeline"
        empty="No videos yet. Upload one and it will show up here."
        onPick={onPickClip}
        renderTile={clipTile}
      />
    ),
    [onPickClip, clipTile],
  );

  /*
   * Her photos. A tap holds one at the end of the timeline for the server's default hold, and shows
   * it. Disabled until the options have arrived: the default is the server's number, not ours.
   */
  const onPickPhoto = useCallback(
    (r: PickerRow) => {
      if (r.kind !== "photo" || !limits) return;
      remember(r);
      setItems((list) => normalize(addStill(list, r, limits.defaultStillSec)));
      showStill(r.imageUrl);
      setSelectedKey(null);
    },
    [remember, limits, showStill],
  );
  const photoTile = useCallback(
    (r: PickerRow, t: PickerTileProps) =>
      r.kind === "photo" ? (
        <PhotoTile photo={r} disabled={t.disabled} onAdd={t.onPress} />
      ) : null,
    [],
  );
  const photoStrip = useMemo(
    () => (
      <StudioMediaPicker
        kind="photos"
        forStill
        origins={MOUNT_ORIGINS["video-still"]}
        context="video-still"
        pageSize={60}
        upload="photo"
        disabled={!limits}
        label="Hold this photo in the video"
        empty="No photos yet. Upload one and you can hold it in a video."
        onPick={onPickPhoto}
        renderTile={photoTile}
      />
    ),
    [onPickPhoto, photoTile, limits],
  );

  const onSplit = useCallback(() => {
    if (!cut) return;
    setItems((list) =>
      normalize(splitAt(list, cut.index, cut.atSourceSec, cut.whole)),
    );
  }, [cut]);

  /**
   * Playback reporting where it has got to, in SOURCE seconds.
   *
   * ⚠️  MOVES THE LINE AND NOTHING ELSE. It must never reach `setPreview`, or the player would be
   * re-seeked by its own progress.
   */
  const onProgress = useCallback(
    (sourceSec: number) => {
      const index = layout.rects.findIndex((r) => r.key === selectedKey);
      if (index < 0) return;
      const at = trackTimeAt(index, sourceSec, layout);
      if (at !== null) setPlayheadSec(at);
    },
    [layout, selectedKey],
  );
  const totals = useMemo(() => timelineTotals(items), [items]);
  const refusal = useMemo(
    () => timelineRefusal(items, limits),
    [items, limits],
  );

  // ⚠️ kind "stitch" — that is what sends this watch to GET /studio/stitch/:id instead of the job
  // route, and what gives it the longer clock. See threadLogic.ts WatchKind.
  const watches = useMemo<Watch[]>(
    () =>
      stitchId && view?.working !== false
        ? [{ key: stitchId, jobId: stitchId, kind: "stitch" as const }]
        : [],
    [stitchId, view],
  );
  useRunWatch(
    watches,
    (_key, outcome, read) =>
      setView(videoEntryFromJob(read ?? "error", outcome)),
    (_key, _phase, read) => setView(videoEntryFromJob(read, "continue")),
  );

  const onQueue = useCallback(async () => {
    // Taken BEFORE the await, from the same values the body is built from: she can keep editing
    // while the request is in flight, and the result is a fact about what was SENT.
    const signature = timelineSignature(
      items,
      target,
      sentBed,
      bedLevel,
      sound,
    );
    const out = await queue.mutateAsync(
      toStitchBody(items, target, sentBed, bedLevel, sound),
    );
    setStitchId(out.stitchId);
    setQueuedSignature(signature);
    setResultTarget(target);
    // Opens as working until the first tick says otherwise — we have learned nothing yet.
    setView(videoEntryFromJob("error", "continue"));
  }, [queue, items, target, sentBed, bedLevel, sound]);

  const stale =
    view !== null &&
    queuedSignature !== null &&
    queuedSignature !==
      timelineSignature(items, target, sentBed, bedLevel, sound);

  // The finished stitch, once there is one. `ready` and a stored clip — not a queued or failed run.
  const postableAssetId =
    view?.phase === "ready" && view.clips[0] && !view.clips[0].removed
      ? view.clips[0].assetId
      : null;

  const selectedIndex = items.findIndex((i) => i.key === selectedKey);

  // The chosen sound as the track draws it: a lane under the clips she can drag to choose where in
  // the sound the video starts. Its length bounds the drag — the server's measured figure for a
  // track, and for her own video whatever has been measured so far (null until something has).
  const trackSound = useMemo(() => {
    const track = bed ? (opts?.beds.find((b) => b.name === bed) ?? null) : null;
    if (!track && !ownSound) return null;
    const hers = ownSound ? clipsById.get(ownSound) : undefined;
    return {
      label: track ? track.label : "Your video's sound",
      startSec: bedStartSec,
      soundSeconds: track
        ? (track.durationSec ?? null)
        : ((ownSound ? measured.get(ownSound) : undefined) ??
          hers?.durationPreciseSec ??
          hers?.durationSec ??
          null),
      onStartChange: setBedStartSec,
      onClear: () => chooseTrack(null),
      muted: soundMuted,
      onToggleMuted: () => setSoundMuted((m) => !m),
    };
  }, [
    bed,
    ownSound,
    bedStartSec,
    opts,
    clipsById,
    measured,
    chooseTrack,
    soundMuted,
  ]);

  /*
   * ─── THE MUSIC, UNDER THE PREVIEW ───────────────────────────────────────────────────────────
   *
   * The preview player plays a SOURCE CLIP; the music is only ever mixed in by the stitch. So
   * without this she picks a track, presses play, and hears nothing — and the first time she
   * hears her own choice is in the finished video. (Found on the first device pass.)
   *
   * A second player, holding the chosen sound, that FOLLOWS the preview: it starts when the preview
   * is sounding (playing and not muted), stops when it is not, and each time it starts it is put
   * where the stitch would be at that moment — `soundOffsetAt`, the stitch's own rule: where she
   * started the sound, plus how far into the video the playhead is, wrapped at the sound's length.
   *
   * ⚠️  WHAT IT IS NOT. It is a preview of WHICH sound and WHERE in it — not of the mix. It plays
   * at the player's own volume rather than the Quiet/Medium/Loud gain (those numbers live on the
   * server, and her clips are silent, so there is nothing here to be quiet under), and it is synced
   * when playback starts rather than sample-locked. The finished video is the mix.
   */
  const soundPlayer = useAudioPlayer();
  const [soundUrl, setSoundUrl] = useState<string | null>(null);
  const previewSounding = useRef(false);
  const playheadNow = useRef(0);
  playheadNow.current = playheadSec;
  const soundNow = useRef(trackSound);
  soundNow.current = trackSound;

  useEffect(() => {
    // A new sound, or none: whatever was playing stops, and the old link is forgotten.
    soundPlayer.pause();
    setSoundUrl(null);
    if (!bed && !ownSound) return;
    let cancelled = false;
    (bed ? fetchBedPreviewUrl(bed) : fetchSoundPreviewUrl(ownSound as string))
      .then((url) => {
        if (!cancelled) setSoundUrl(url);
      })
      // No link is no music in the preview — never an error she has to act on. The stitch has its
      // own, louder, answer for a sound that cannot be used.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bed, ownSound, soundPlayer]);

  const startSound = useCallback(() => {
    const s = soundNow.current;
    // Muted is out of the video, so it is out of the preview of the video.
    if (!s || s.muted) return;
    void soundPlayer
      .seekTo(soundOffsetAt(s.startSec, playheadNow.current, s.soundSeconds))
      .then(() => {
        if (previewSounding.current) soundPlayer.play();
      })
      .catch(() => undefined);
  }, [soundPlayer]);

  useEffect(() => {
    if (!soundUrl) return;
    soundPlayer.replace({ uri: soundUrl });
    soundPlayer.loop = true;
    // The link can arrive AFTER she pressed play.
    if (previewSounding.current) startSound();
  }, [soundUrl, soundPlayer, startSound]);

  const onPreviewSounding = useCallback(
    (sounding: boolean) => {
      previewSounding.current = sounding;
      if (sounding && soundUrl) startSound();
      else soundPlayer.pause();
    },
    [soundUrl, soundPlayer, startSound],
  );

  // She moved where the sound starts WHILE it is playing: jump to the new place, so the drag is
  // heard as she makes it.
  useEffect(() => {
    if (previewSounding.current && soundUrl) startSound();
  }, [bedStartSec, soundUrl, startSound]);

  // Muting or un-muting the sound WHILE the preview plays is heard at once.
  useEffect(() => {
    if (soundMuted) soundPlayer.pause();
    else if (previewSounding.current && soundUrl) startSound();
  }, [soundMuted, soundUrl, soundPlayer, startSound]);

  // The player shows the SELECTED position, so its caption is the one drawn over it. Asked of the
  // server, which draws the very band the stitch burns in — see useCaptionPreview.
  const selectedCaption =
    selectedIndex >= 0 ? (items[selectedIndex].caption ?? null) : null;
  // A caption to start from (PR 15, R-5): by rule, from the Board's words, only with the composer on
  // and only when the Board sent them. She always types over it.
  const captionSuggestion = useCaptionSuggestion(
    captionFeel?.feel ?? [],
    captionFeel?.objective ?? "",
    STUDIO_COMPOSER && captionFeel !== null && !!opts?.captions,
  );
  const captionPreview = useCaptionPreview(
    opts?.captions ? selectedCaption : null,
    target,
  );

  const blocked = !!refusal || queue.isPending;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Note text="Pipeline 1 — join your clips and lay music under them. Nothing here spends." />

      {/* ── Her clips ─────────────────────────────────────────────────────────────── */}
      <Text style={styles.h}>Your clips</Text>
      {strip}

      {/* ── Her photos, to hold as stills ────────────────────────────────────────────── */}
      <Text style={styles.h}>Your photos</Text>
      {photoStrip}

      {/* ── The preview ───────────────────────────────────────────────────────────── */}
      {/* `ratio` is the shape SHE chose, live — unlike the result below, which is snapshotted at
          queue time. This box is a promise about what the stitch will look like, so it should
          follow the pills; the result is a fact about what was made. */}
      <TimelinePreview
        spec={preview}
        ratio={ratioForTarget(target)}
        onProgress={onProgress}
        /* Only while the selected clip HAS a caption: keepPreviousData holds the last band during a
           redraw, and without this it would linger after she deleted the words. */
        caption={selectedCaption ? (captionPreview.data?.band ?? null) : null}
        onPlayingChange={onPreviewSounding}
        unmuteSignal={unmuteSignal}
        /* The preview plays the SELECTED clip, so it is silent when that clip is muted — what she
           hears is what the stitch will keep. The music under it plays on. */
        clipMuted={selectedIndex >= 0 && !!items[selectedIndex].muted}
      />

      {/* ── The timeline ──────────────────────────────────────────────────────────── */}
      <Text style={styles.h}>Timeline</Text>
      <TimelineTrack
        layout={layout}
        clipsById={trackSources}
        onSelect={previewItem}
        selectedKey={selectedKey}
        playheadSec={playheadSec}
        onScrub={onScrub}
        onTrim={onTrim}
        onReorder={onReorder}
        sound={trackSound}
      />
      {trackSound ? (
        <Text style={styles.quiet}>
          Drag the sound left or right to choose where it starts. Press play to
          hear it with your clip.
        </Text>
      ) : null}
      {/* ── Words on the selected clip ────────────────────────────────────────────── */}
      {/* DIRECTLY under the track, above the rows: it edits the clip that is lit up there, and with
          the row list in between it was a screen away from the thing it changes (seen on the first
          device pass). Only when the server offers captions (an older one does not) and a clip is selected. Keyed
          by the position so the draft resets when she selects another — see CaptionEditor. */}
      {opts?.captions && selectedIndex >= 0 ? (
        <CaptionEditor
          key={items[selectedIndex].key}
          index={selectedIndex}
          caption={items[selectedIndex].caption ?? null}
          options={opts.captions}
          onChange={(c) => setItems((l) => setCaption(l, selectedIndex, c))}
          /* The server's sentence, the moment it can say it — not only when she queues. */
          refusal={
            selectedCaption ? (captionPreview.data?.refusal ?? null) : null
          }
          suggestion={captionSuggestion.data ?? null}
        />
      ) : null}
      {/* ── How long the selected photo is held ─────────────────────────────────────── */}
      {limits && selectedIndex >= 0 && isStill(items[selectedIndex]) ? (
        <HoldPicker
          seconds={items[selectedIndex].stillSec ?? limits.defaultStillSec}
          limits={limits}
          onChange={(sec) =>
            setItems((l) => setStillSec(l, selectedIndex, sec, limits))
          }
        />
      ) : null}

      {items.length === 0 ? (
        <Text style={styles.quiet}>Tap a clip or a photo above to start.</Text>
      ) : (
        items.map((item, i) => (
          <Animated.View key={item.key} entering={FadeIn.duration(180)}>
            <Row
              index={i}
              item={item}
              last={i === items.length - 1}
              /* The SAME handler the drop goes through — see onReorder. */
              onUp={() => onReorder(item.key, i - 1)}
              onDown={() => onReorder(item.key, i + 1)}
              captioned={!!item.caption}
              muted={!!item.muted}
              /* Beside a held photo there is no bridge to ask for — see setBridgeRequested. */
              bridgeable={!isStill(item) && !isStill(items[i - 1])}
              onMute={() => setItems((l) => setClipMuted(l, i, !item.muted))}
              onRemove={() => setItems((l) => normalize(removeAt(l, i)))}
              /* Cut → Fade → Bridge → Cut. The third position is an ASK; see Row's note. */
              onFade={() =>
                setItems((l) => {
                  if (item.bridgeRequested)
                    return setBridgeRequested(l, i, false);
                  if (item.crossfadeSec === undefined)
                    return setCrossfade(l, i, CROSSFADE_SEC);
                  // Cut → Fade → Cut beside a photo: there is no Bridge to cycle onto.
                  if (isStill(item) || isStill(l[i - 1]))
                    return setCrossfade(l, i, null);
                  return setBridgeRequested(l, i, true);
                })
              }
            />
          </Animated.View>
        ))
      )}

      {/* Split sits under the track, where the cut it makes is visible. */}
      <View style={styles.wrap}>
        <HapticPressable
          testID="timeline-split"
          style={[styles.choice, !cut && styles.off]}
          onPress={onSplit}
          disabled={!cut}
          accessibilityRole="button"
          accessibilityState={{ disabled: !cut }}
          accessibilityLabel="Split this clip at the playhead"
        >
          <Text style={styles.choiceTxt}>Split</Text>
        </HapticPressable>
      </View>

      {/* The caps, on screen beside the totals — which is why the refusal names only the one she
          hit rather than repeating all three the way the server's message has to. */}
      {limits ? (
        <Text style={styles.totals}>
          {totals.clips} of {limits.maxClips} clips · {clock(totals.seconds)} of{" "}
          {clock(limits.maxTimelineSeconds)}
        </Text>
      ) : null}
      {refusal && items.length > 0 ? (
        <Text style={styles.refusal}>{refusal}</Text>
      ) : null}

      {/* ── Shape ─────────────────────────────────────────────────────────────────── */}
      <Text style={styles.h}>Shape</Text>
      <View style={styles.wrap}>
        {TARGETS.map((t) => (
          <Choice
            key={t.name}
            label={t.label}
            on={target === t.name}
            onPress={() => setTarget(t.name)}
          />
        ))}
      </View>

      {/* ── Music ─────────────────────────────────────────────────────────────────── */}
      <Text style={styles.h}>Music</Text>
      <BedPicker
        beds={opts?.beds ?? []}
        ready={!!opts?.ready}
        chosen={bed}
        onChoose={chooseTrack}
        clips={clips.data ?? []}
        ownSound={ownSound}
        onOwnSound={chooseOwnSound}
        levels={opts?.levels ?? []}
        level={bedLevel ?? opts?.defaultLevel ?? null}
        /* The default is stored as null — "absent means the server's default" has one spelling. */
        onLevel={(name) =>
          setBedLevel(name === opts?.defaultLevel ? null : name)
        }
      />

      <HapticPressable
        style={[styles.cta, blocked && styles.off]}
        onPress={onQueue}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityLabel="Put this timeline together"
      >
        <Feather name="film" size={15} color={Colors.light.buttonText} />
        <Text style={styles.ctaTxt}>
          {queue.isPending ? "Starting…" : "Put it together"}
        </Text>
      </HapticPressable>

      {/* The server's own sentence, never replaced: it names the cap and the field. */}
      {queue.error ? (
        <Text style={styles.refusal}>{queue.error.message}</Text>
      ) : null}

      {/* muted={false}: the last stage of this pipeline is MUSIC, and a bed nobody can hear is a
          bed nobody reviews. Every other surface keeps ClipPlayer's muted default. */}
      {/* The result below is a fact about what was QUEUED. Once the timeline above it has moved on,
          saying so is the difference between a result and a lie. */}
      {stale ? (
        <Note text="You've changed the timeline since this was made. Put it together again to see the changes." />
      ) : null}
      {view ? (
        <VideoEntry
          view={view}
          caption={stitchId}
          onOpenDetail={onOpenDetail}
          muted={false}
          ratio={ratioForTarget(resultTarget)}
        />
      ) : null}
      {/* Stitch → watch → post, right there. Only for the result of the timeline ON SCREEN: once
          she has changed it, what is below is an older cut, and the thing she posts should be the
          thing she just watched. The pill decides for itself whether to draw — the server's
          STUDIO_PUBLISH_MODE, her connection and this video's limits all arrive through it. */}
      {postableAssetId && !stale ? (
        <PublishPill key={postableAssetId} assetId={postableAssetId} />
      ) : null}
    </ScrollView>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────────────────────

function Note({ text }: { text: string }) {
  return (
    <View style={styles.note}>
      <Feather name="alert-triangle" size={14} color={Colors.light.textMuted} />
      <Text style={styles.noteTxt}>{text}</Text>
    </View>
  );
}

/** One of her photos in the picker. A tap holds it on the timeline — see `photoStrip`. */
function PhotoTile({
  photo,
  onAdd,
  disabled,
}: {
  photo: StillChoice;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <HapticPressable
      testID={`timeline-photo-${photo.assetId}`}
      style={[styles.tile, disabled && styles.off]}
      onPress={onAdd}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel="Hold this photo in the video"
    >
      <ClipPoster
        source={{
          mediaType: "IMAGE",
          thumbUrl: photo.thumbUrl,
          videoUrl: null,
        }}
        style={styles.poster}
      />
      <Text style={styles.tileTxt} numberOfLines={1}>
        {photo.origin ?? "Photo"}
      </Text>
    </HapticPressable>
  );
}

/** The holds offered as chips — trimmed to the server's bounds, plus whatever is set now. */
const HOLD_CHOICES = [1, 2, 3, 5, 8];

/**
 * How long the selected photo is held. Chips rather than a slider: a hold is a beat, and "2s" is a
 * decision she can make at a glance. Every value is inside the server's bounds (setStillSec clamps
 * as well), so no choice here can produce a timeline the server refuses for its length.
 */
function HoldPicker({
  seconds,
  limits,
  onChange,
}: {
  seconds: number;
  limits: Pick<StitchLimits, "minStillSec" | "maxStillSec">;
  onChange: (seconds: number) => void;
}) {
  const choices = [
    ...new Set([
      ...HOLD_CHOICES.filter(
        (s) => s >= limits.minStillSec && s <= limits.maxStillSec,
      ),
      seconds,
    ]),
  ].sort((a, b) => a - b);
  return (
    <View testID="timeline-hold">
      <Text style={styles.quiet}>Hold this photo for</Text>
      <View style={styles.wrap}>
        {choices.map((sec) => (
          <Choice
            key={sec}
            label={`${sec}s`}
            on={sec === seconds}
            onPress={() => onChange(sec)}
          />
        ))}
      </View>
    </View>
  );
}

function ClipTile({ clip, onAdd }: { clip: ClipChoice; onAdd: () => void }) {
  return (
    <HapticPressable
      style={styles.tile}
      onPress={onAdd}
      accessibilityRole="button"
      accessibilityLabel="Add this clip to the timeline"
    >
      {/*
        A poster when there is one, the clip's own first frame when there is not. A fresh upload
        has no gcs_thumb_path until the media-poster cron fires — minutes in production, never on
        a laptop — so without this every clip she just added is a blank filmstrip tile.
      */}
      <ClipPoster
        source={{
          mediaType: "VIDEO",
          thumbUrl: clip.posterUrl,
          videoUrl: clip.videoUrl,
        }}
        style={styles.poster}
      />
      <Text style={styles.tileTxt} numberOfLines={1}>
        {clip.durationSec ? clock(clip.durationSec) : "—"}
        {clip.origin ? ` · ${clip.origin}` : ""}
      </Text>
    </HapticPressable>
  );
}

/**
 * One position's controls.
 *
 * ⚠️  THE ARROWS AND THE DRAG ARE BOTH PERMANENT, and they are not alternatives to each other.
 * A press-hold-then-drag on the track is natural on touch and awkward with a trackpad; a pair of
 * buttons is discoverable and exact, and needs no hold at all. Two inputs, two affordances — and
 * both call the same handler, so neither can drift from the other.
 *
 * The disabled ends are the visible half of a rule the arithmetic already keeps: `reorderTo`
 * refuses an out-of-range target, so up on the first clip and down on the last do nothing even if
 * this state were ever wrong.
 */
function Row({
  index,
  item,
  last,
  onUp,
  onDown,
  onRemove,
  onFade,
  captioned,
  muted,
  bridgeable,
  onMute,
}: {
  index: number;
  item: TimelineItem;
  last: boolean;
  captioned: boolean;
  /** Whether the join into this position may cycle on to a Bridge ask. False beside a photo. */
  bridgeable: boolean;
  /** This clip's OWN sound is left out of the finished video. */
  muted: boolean;
  onMute: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onFade: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.idx}>{index + 1}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTxt} numberOfLines={1}>
          {item.stillSec !== undefined
            ? `Photo · ${item.stillSec}s`
            : item.durationSec
              ? clock(item.durationSec)
              : "—"}
        </Text>
        {/* A mark, not the words: the row is narrow, and which clips are captioned is what she
            needs to see at a glance. The words are in the editor when the clip is selected. */}
        {captioned ? (
          <Feather
            name="type"
            size={12}
            color={Colors.light.textSecondary}
            accessibilityLabel="This clip has a caption"
          />
        ) : null}
        {/* Position 0 has nothing to fade FROM, so it is not offered one. stitchLogic strips it on
            reorder too, so a clip dragged to the front cannot keep an impossible state. */}
        {index > 0 ? (
          /* ─── ⚠️  THREE STATES, AND THE THIRD ONE SPENDS NOTHING ON TAP ────────────────────
             Cut and Fade are ffmpeg filter choices the stitch engine makes for free. BRIDGE is a
             clip Kling has to generate, at roughly $0.42 — so cycling onto it only ASKS. Nothing
             is generated and nothing is billed until she confirms it on the money path, the same
             way Generate is the one button on CampaignWorkspaceScreen that spends. A toggle that
             bills because your thumb kept going is not a toggle. */
          <HapticPressable
            style={[styles.fade, item.bridgeRequested && styles.fadeBridge]}
            onPress={onFade}
            accessibilityRole="button"
            accessibilityLabel={
              item.bridgeRequested
                ? "Cut into this clip instead"
                : item.crossfadeSec === undefined
                  ? "Crossfade into this clip"
                  : bridgeable
                    ? "Make a generated transition into this clip"
                    : "Cut into this clip instead"
            }
          >
            <Feather
              name={
                item.bridgeRequested
                  ? "git-merge"
                  : item.crossfadeSec === undefined
                    ? "scissors"
                    : "shuffle"
              }
              size={12}
              color={
                item.bridgeRequested
                  ? Colors.light.primary
                  : Colors.light.textSecondary
              }
            />
            <Text
              style={[
                styles.fadeTxt,
                item.bridgeRequested && styles.fadeTxtBridge,
              ]}
            >
              {item.bridgeRequested
                ? "Bridge · not made yet"
                : item.crossfadeSec === undefined
                  ? "Cut"
                  : `Fade ${Math.min(item.crossfadeSec, MAX_CROSSFADE_SEC)}s`}
            </Text>
          </HapticPressable>
        ) : null}
      </View>
      {/* The clip's own sound. Her uploads have it; mixing it under music is often not what she
          wants, and a video used for its SOUND would otherwise play that sound twice. A held photo
          has no sound of its own, so it is offered no mute (the server refuses one by field). */}
      {item.stillSec === undefined ? (
        <Ico
          label={muted ? "Turn this clip's sound back on" : "Mute this clip"}
          name={muted ? "volume-x" : "volume-2"}
          onPress={onMute}
        />
      ) : null}
      <Ico label="Move up" name="arrow-up" onPress={onUp} off={index === 0} />
      <Ico label="Move down" name="arrow-down" onPress={onDown} off={last} />
      <Ico label="Remove" name="x" onPress={onRemove} />
    </View>
  );
}

function Ico({
  label,
  name,
  onPress,
  off,
}: {
  label: string;
  name: React.ComponentProps<typeof Feather>["name"];
  onPress: () => void;
  off?: boolean;
}) {
  return (
    <HapticPressable
      style={[styles.ico, off && styles.off]}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={name} size={14} color={Colors.light.textSecondary} />
    </HapticPressable>
  );
}

function Choice({
  label,
  on,
  onPress,
  disabled,
  swatch,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** A colour to show beside the label. Ringed, so white is visible on a white pill. */
  swatch?: string;
}) {
  return (
    <HapticPressable
      style={[styles.choice, on && styles.choiceOn, disabled && styles.off]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
    >
      {swatch ? (
        <View style={[styles.swatch, { backgroundColor: swatch }]} />
      ) : null}
      <Text style={[styles.choiceTxt, on && styles.choiceTxtOn]}>{label}</Text>
    </HapticPressable>
  );
}

/**
 * The beds, and an honest line when there are none to play yet.
 *
 * `ready` is false until the bed objects are installed in the bucket (server/studio/video/beds.ts).
 * SAYING SO beats hiding the section: a music step that silently is not there reads as a missing
 * feature, and the server would refuse the choice at the door anyway.
 */
function BedPicker({
  beds,
  ready,
  chosen,
  onChoose,
  levels,
  level,
  onLevel,
  clips,
  ownSound,
  onOwnSound,
}: {
  /** Her videos — what "From a video" picks from. */
  clips: ClipChoice[];
  /** The video whose sound is chosen, by asset id, or null. */
  ownSound: string | null;
  onOwnSound: (assetId: string | null) => void;
  beds: BedChoice[];
  ready: boolean;
  chosen: string | null;
  onChoose: (name: string | null) => void;
  levels: NamedChoice[];
  level: string | null;
  onLevel: (name: string) => void;
}) {
  /*
   * ─── LISTENING ──────────────────────────────────────────────────────────────────────────────
   *
   * ONE player for the whole picker, its source swapped per track: two tracks can never play over
   * each other, and there is one thing to stop. `auditioning` is which NAME she asked to hear; the
   * player's own status says whether it is actually sounding. (Hooks first — the early return for
   * "no music yet" is below them on purpose.)
   *
   * Played at the track's own volume, NOT at the chosen level: Quiet is 15% gain, and a track
   * auditioned alone at 15% only tells her it is quiet. How it sits under her clips is what the
   * finished video is for.
   */
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [unplayable, setUnplayable] = useState<string | null>(null);
  /** The latest tap wins: a slow link for the track before must not start over the one after. */
  const asked = useRef(0);

  // It ran to the end: the button goes back to "play" instead of showing pause over silence.
  useEffect(() => {
    if (status.didJustFinish) setAuditioning(null);
  }, [status.didJustFinish]);

  const onAudition = useCallback(
    // `name` is what is lit up as playing: a track's name, or a video's asset id. `link` is how to
    // get something to play for it — the two kinds of sound have two routes and one player.
    async (
      name: string,
      link: (name: string) => Promise<string | null> = fetchBedPreviewUrl,
    ) => {
      const ticket = ++asked.current;
      if (auditioning === name) {
        player.pause();
        setAuditioning(null);
        return;
      }
      player.pause();
      setUnplayable(null);
      setAuditioning(name);
      try {
        const url = await link(name);
        if (ticket !== asked.current) return;
        if (!url) {
          setAuditioning(null);
          setUnplayable(name);
          return;
        }
        player.replace({ uri: url });
        player.play();
      } catch {
        if (ticket !== asked.current) return;
        setAuditioning(null);
        setUnplayable(name);
      }
    },
    [auditioning, player],
  );

  const [fromVideo, setFromVideo] = useState(false);
  const picked = beds.find((b) => b.name === chosen) ?? null;
  const hasSound = picked !== null || ownSound !== null;
  return (
    <View style={styles.stack}>
      <View style={styles.wrap}>
        <Choice
          label="None"
          on={chosen === null && ownSound === null}
          onPress={() => {
            onChoose(null);
            setFromVideo(false);
          }}
        />
        {/* Each track is its pill AND a way to hear it. Listening does not choose: she can play
            five and pick none, and choosing one does not start it. */}
        {ready
          ? beds.map((b) => (
              <View key={b.name} style={styles.bed}>
                <Choice
                  label={b.label}
                  on={chosen === b.name}
                  onPress={() => {
                    onChoose(b.name);
                    setFromVideo(false);
                  }}
                />
                <Ico
                  label={
                    auditioning === b.name
                      ? `Stop ${b.label}`
                      : `Listen to ${b.label}`
                  }
                  name={auditioning === b.name ? "pause" : "play"}
                  onPress={() => void onAudition(b.name)}
                />
              </View>
            ))
          : null}
        {/* HER OWN SOUND. Not gated on `ready`: that flag says the PRODUCT's tracks are installed,
            and her video is already in her library. */}
        <Choice
          label="From a video"
          on={ownSound !== null || fromVideo}
          onPress={() => setFromVideo((open) => !open)}
        />
      </View>
      {!ready ? (
        <Text style={styles.quiet}>
          No tracks available yet — you can still use the sound from one of your
          videos.
        </Text>
      ) : null}
      {fromVideo || ownSound !== null ? (
        <OwnSoundPicker
          clips={clips}
          chosen={ownSound}
          onChoose={onOwnSound}
          playing={auditioning}
          onListen={(assetId) => void onAudition(assetId, fetchSoundPreviewUrl)}
        />
      ) : null}
      {unplayable ? (
        <Text style={styles.refusal}>
          That track can&apos;t be played right now.
        </Text>
      ) : null}
      {/* Ready, and nothing listed: every track is cleared and listened to before it is offered
          (server/studio/video/BEDS-LICENSES.md), so an empty list is a true statement, said plainly. */}
      {ready && beds.length === 0 ? (
        <Text style={styles.quiet}>No tracks to choose from yet.</Text>
      ) : null}
      {picked ? (
        <Text style={styles.quiet}>
          {picked.note}
          {picked.artist ? ` · ${picked.artist}` : ""}
        </Text>
      ) : null}
      {hasSound ? (
        <>
          {/* How loud, and only once there is something to be loud. Three names — the server holds
              the gains. The music sits at one level throughout: it does not dip under a clip's own
              sound, so there is nothing here that promises it will. */}
          {levels.length > 0 ? (
            <View style={styles.wrap}>
              {levels.map((l) => (
                <Choice
                  key={l.name}
                  label={l.label}
                  on={level === l.name}
                  onPress={() => onLevel(l.name)}
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * Choose one of HER videos to take the sound from — from her library, or a new upload.
 *
 * ─── THE UPLOAD IS THE APP'S OWN, NOT A SECOND ONE ──────────────────────────────────────────────
 *
 * `pickFromCameraRoll("video")` → `useUploadMedia`, the same path every other upload in the app
 * takes, INCLUDING the one-time rights acknowledgment (`RightsAckRequired` → `RightsAckPanel` →
 * retry with `ackRights`). What she uploads lands in her library as an ordinary video, shows up in
 * the clip strip too, and is chosen as the sound. Video files only: the server admits no bare audio
 * (server/lib/mediaStore.ts UPLOAD_LIMITS), so neither does this.
 *
 * ─── THE LINE ABOUT RIGHTS IS NOT BOILERPLATE ───────────────────────────────────────────────────
 *
 * A curated track is CC0 because someone checked. HER video can have anyone's song on it, and this
 * is the step that lays it under something she may send to a brand. So it is said here, where the
 * choice is made, in the words Adi chose.
 */
function OwnSoundPicker({
  clips,
  chosen,
  onChoose,
  playing,
  onListen,
}: {
  clips: ClipChoice[];
  chosen: string | null;
  onChoose: (assetId: string | null) => void;
  /** Whatever the picker's one player is sounding — a track name or an asset id. */
  playing: string | null;
  onListen: (assetId: string) => void;
}) {
  const qc = useQueryClient();
  const upload = useUploadMedia();
  const [ackFor, setAckFor] = useState<
    Parameters<typeof upload.mutateAsync>[0]["asset"] | null
  >(null);
  const [failed, setFailed] = useState(false);

  const send = useCallback(
    async (
      asset: Parameters<typeof upload.mutateAsync>[0]["asset"],
      ackRights?: boolean,
    ) => {
      setFailed(false);
      try {
        const item = await upload.mutateAsync({ asset, ackRights });
        // Her new video belongs in the clip strip as well, and that list has its own cache key.
        await qc.invalidateQueries({ queryKey: ["studio", "stitch", "clips"] });
        onChoose(item.asset_id);
      } catch (e) {
        if (e instanceof RightsAckRequired) setAckFor(asset);
        else setFailed(true);
      }
    },
    [upload, qc, onChoose],
  );

  const onUpload = useCallback(async () => {
    try {
      const pickedFile = await pickFromCameraRoll("video");
      if (pickedFile?.assets.length) await send(pickedFile.assets[0]);
    } catch {
      // Permission refused or the picker failed: nothing chosen, nothing to undo.
    }
  }, [send]);

  return (
    <View style={styles.stack}>
      <Text style={styles.quiet}>
        Use sound you own or have permission to use — music from other artists
        can get posts taken down.
      </Text>
      {ackFor ? (
        <RightsAckPanel
          busy={upload.isPending}
          onConfirm={() => {
            const asset = ackFor;
            setAckFor(null);
            void send(asset, true);
          }}
          onCancel={() => setAckFor(null)}
        />
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.strip}>
          {clips.map((c) => (
            <View key={c.assetId} style={styles.tile}>
              <HapticPressable
                onPress={() =>
                  onChoose(chosen === c.assetId ? null : c.assetId)
                }
                accessibilityRole="button"
                accessibilityState={{ selected: chosen === c.assetId }}
                accessibilityLabel="Use this video's sound"
                style={chosen === c.assetId ? styles.tileOn : null}
              >
                <ClipPoster
                  source={{
                    mediaType: "VIDEO",
                    thumbUrl: c.posterUrl,
                    videoUrl: c.videoUrl,
                  }}
                  style={styles.poster}
                />
              </HapticPressable>
              <Ico
                label={
                  playing === c.assetId
                    ? "Stop this video's sound"
                    : "Listen to this video's sound"
                }
                name={playing === c.assetId ? "pause" : "play"}
                onPress={() => onListen(c.assetId)}
              />
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.wrap}>
        <HapticPressable
          style={[styles.choice, upload.isPending && styles.off]}
          onPress={() => void onUpload()}
          disabled={upload.isPending}
          accessibilityRole="button"
          accessibilityLabel="Upload a video to use its sound"
        >
          <Feather name="upload" size={14} color={Colors.light.text} />
          <Text style={styles.choiceTxt}>
            {upload.isPending ? "Uploading…" : "Upload a video"}
          </Text>
        </HapticPressable>
      </View>
      {failed ? (
        <Text style={styles.refusal}>
          That video couldn&apos;t be uploaded. Try again, or pick one above.
        </Text>
      ) : null}
      {/* Said plainly, because a ten-second clip under a minute of video repeats six times and that
          should not be a surprise in the finished thing. */}
      <Text style={styles.quiet}>
        If the sound is shorter than your video, it repeats. Drag the sound
        under your clips to choose where it starts.
      </Text>
    </View>
  );
}

/**
 * Words on one clip: what they say, where they sit, how they look.
 *
 * ─── WHY THE TEXT IS A LOCAL DRAFT ──────────────────────────────────────────────────────────────
 *
 * `setCaption` trims, because a stored caption has no stray edges. If the input were bound to the
 * stored value, the space after "Game" would be trimmed away the moment it was typed and she could
 * never write "Game day". So the box shows what she TYPED and the timeline holds what will be SENT.
 * The parent keys this component by position, so selecting another clip starts a fresh draft.
 *
 * ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
 *
 * It does not decide what a caption may contain. The length comes from the server, the refusal is
 * the server's sentence, and a character the font cannot draw is refused by the route, by field,
 * when she puts the timeline together — shown under the button as written. A second copy of that
 * rule here would be a second rule.
 */
function CaptionEditor({
  index,
  caption,
  options,
  onChange,
  refusal,
  suggestion = null,
}: {
  index: number;
  caption: TimelineCaption | null;
  options: CaptionOptions;
  onChange: (caption: TimelineCaption | null) => void;
  refusal: string | null;
  /** A line to start from (PR 15, R-5), or null for no chip. Tapping it fills the box; she edits on. */
  suggestion?: string | null;
}) {
  const [draft, setDraft] = useState(caption?.text ?? "");
  const position = caption?.position ?? options.defaults.position;
  const style = caption?.style ?? options.defaults.style;
  // The default colour is held as ABSENT, the way the server stores it — so a white caption has the
  // same signature whether or not she ever touched the colour row.
  const color = caption?.color;
  const shownColor = color ?? options.defaults.color ?? null;
  // The font (PR 8) is held the same way: the default is ABSENT, so an Outfit caption has one
  // signature whether or not she ever touched the font row.
  const font = caption?.font;
  const shownFont = font ?? options.defaults.font ?? null;
  const hasWords = draft.trim() !== "";
  /** Everything as it stands, with one thing changed. */
  const emit = (over: Partial<TimelineCaption>) =>
    onChange({
      text: draft,
      position,
      style,
      ...(color ? { color } : {}),
      ...(font ? { font } : {}),
      ...over,
    });

  return (
    <View style={styles.stack}>
      <Text style={styles.h}>Words on clip {index + 1}</Text>
      <TextInput
        testID="caption-text"
        style={styles.input}
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          emit({ text });
        }}
        placeholder="Add a caption"
        placeholderTextColor={Colors.light.textMuted}
        maxLength={options.maxChars}
        multiline
        numberOfLines={options.maxLines}
        accessibilityLabel={`Caption for clip ${index + 1}`}
      />
      <Text style={styles.quiet}>
        {Array.from(draft).length} of {options.maxChars}
      </Text>
      {/* THE SUGGESTION CHIP (PR 15, R-5): one pill, only when there is a line and it is not already
          in the box. It fills the draft through the same path a keystroke takes, so nothing about
          the caption's position, style or signature is special-cased. */}
      {suggestion !== null && suggestion !== draft ? (
        <View style={styles.wrap}>
          <Choice
            label={`Use “${suggestion}”`}
            on={false}
            onPress={() => {
              setDraft(suggestion);
              emit({ text: suggestion });
            }}
          />
        </View>
      ) : null}
      {refusal ? <Text style={styles.refusal}>{refusal}</Text> : null}
      {/* The pills mean nothing without words to apply them to — off, rather than storing a
          position for a caption that does not exist. */}
      <View style={styles.wrap}>
        {options.positions.map((p) => (
          <Choice
            key={p.name}
            label={p.label}
            on={hasWords && position === p.name}
            disabled={!hasWords}
            onPress={() => emit({ position: p.name })}
          />
        ))}
      </View>
      <View style={styles.wrap}>
        {options.styles.map((s) => (
          <Choice
            key={s.name}
            label={s.label}
            on={hasWords && style === s.name}
            disabled={!hasWords}
            onPress={() => emit({ style: s.name })}
          />
        ))}
      </View>
      {/* A swatch beside the name: "Pink" is a word, and which pink is the question. */}
      {options.colors && options.colors.length > 0 ? (
        <View style={styles.wrap}>
          {options.colors.map((c) => (
            <Choice
              key={c.name}
              label={c.label}
              swatch={c.hex}
              on={hasWords && shownColor === c.name}
              disabled={!hasWords}
              /* The default goes back to ABSENT rather than being spelled out. */
              onPress={() =>
                emit({
                  color: c.name === options.defaults.color ? undefined : c.name,
                })
              }
            />
          ))}
        </View>
      ) : null}
      {/* The typeface (PR 8). The server holds the files and weights; the row holds names. */}
      {options.fonts && options.fonts.length > 0 ? (
        <View style={styles.wrap}>
          {options.fonts.map((f) => (
            <Choice
              key={f.name}
              label={f.label}
              on={hasWords && shownFont === f.name}
              disabled={!hasWords}
              onPress={() =>
                emit({
                  font: f.name === options.defaults.font ? undefined : f.name,
                })
              }
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: Spacing.md, gap: Spacing.sm },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    padding: Spacing.sm,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  noteTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  h: {
    fontFamily: Fonts.headingSemiBold,
    fontWeight: "600",
    fontSize: 13,
    color: Colors.light.text,
    marginTop: Spacing.sm,
  },
  quiet: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textMuted,
  },
  strip: { flexDirection: "row", gap: Spacing.sm, paddingVertical: Spacing.xs },
  tile: { width: 92, gap: 4 },
  poster: {
    width: 92,
    height: 124,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  tileTxt: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    padding: Spacing.sm,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  idx: {
    width: 20,
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 12,
    color: Colors.light.textQuiet,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTxt: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.text,
  },
  fade: { flexDirection: "row", alignItems: "center", gap: 4 },
  // The asked-for state reads as PENDING rather than as a setting that has taken effect — it is
  // the one join state that describes something which does not exist yet.
  fadeBridge: {
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
  },
  fadeTxtBridge: { color: Colors.light.primary },
  fadeTxt: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textSecondary,
  },
  ico: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  totals: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  refusal: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
  stack: { gap: Spacing.xs },
  tileOn: {
    borderRadius: BorderRadius.xs,
    borderWidth: 2,
    borderColor: Colors.light.primary,
  },
  bed: { flexDirection: "row", alignItems: "center", gap: 4 },
  input: {
    minHeight: 56,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: BorderRadius.xs,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    backgroundColor: Colors.light.backgroundRoot,
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    textAlignVertical: "top",
  },
  choice: {
    minWidth: 120,
    height: 40,
    // A row, so a swatch sits BESIDE its label. A pill with only a label is unchanged by it.
    flexDirection: "row",
    gap: Spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  swatch: {
    width: 14,
    height: 14,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  choiceOn: {
    backgroundColor: Colors.light.primary,
    borderColor: Colors.light.primary,
  },
  choiceTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "500",
    fontSize: 13,
    color: Colors.light.text,
  },
  choiceTxtOn: { color: Colors.light.buttonText },
  cta: {
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    height: 48,
    marginTop: Spacing.sm,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  ctaTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 14,
    color: Colors.light.buttonText,
  },
  off: { opacity: 0.4 },
});
