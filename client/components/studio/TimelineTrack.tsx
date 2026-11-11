/**
 * TimelineTrack — her clips laid out in TIME, which is the whole point of a timeline.
 *
 * ─── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────────────
 *
 * The `Row` list it sits above answers "what order are these in". It cannot answer "how long is
 * this", "where does that clip start", or "what am I about to cut" — and every piece still to come
 * (scrub, trim, split) is a gesture against a position in time. This draws that space so those
 * gestures have somewhere to land.
 *
 * Tapping a clip SELECTS it, which is what fills the preview above. Reordering and removal stay on
 * the arrows until there is a drag to replace them, so nothing she can do today stops working.
 *
 * ─── THE ARITHMETIC IS NOT HERE ─────────────────────────────────────────────────────────────────
 *
 * `screens/studio/timelineGeometry.ts` owns every number: rect positions, the px↔seconds mapping,
 * the ruler's interval. This file applies them, the same way `ClipPlayer` applies `playerBox`.
 *
 * ⚠️  A TILE IS A `ClipPoster`, AND MAY NEVER BECOME A `ClipPlayer`. That file's own header says
 * why they are separate components rather than one behind a flag: "the flag is how a strip of ten
 * tiles ends up all playing at once". A track of twelve is exactly that.
 *
 * DESIGN.md: radius never below `xs`; nothing blurred; Feather icons, never emoji; motion is
 * reanimated; every weight paired with its Outfit face, which iOS ignores on its own.
 */
import React, { useMemo, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { HapticPressable } from "../HapticPressable";
import { ClipPoster } from "./ClipPoster";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import {
  clock,
  soundStartAfterDrag,
  type TrimEdge,
} from "../../screens/studio/stitchLogic";
import {
  clampToTrack,
  DEFAULT_PX_PER_SEC,
  dropIndexFor,
  REORDER_HOLD_MS,
  rulerTicks,
  timeAtX,
  xAtTime,
  type TrackLayout,
  type TrackRect,
} from "../../screens/studio/timelineGeometry";

/** Just enough of a clip to draw a still for it. A subset of `ClipChoice`. */
export interface TrackClipSource {
  videoUrl: string | null;
  posterUrl: string | null;
}

const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 26;
const SOUND_HEIGHT = 34;
const SOUND_GAP = 6;

/**
 * The sound under the timeline, drawn as its own lane beneath the clips.
 *
 * It lives INSIDE this component's scroll content on purpose: the lane is laid against the clips,
 * so it has to scroll with them. A strip rendered outside would stay put while the clips moved and
 * stop meaning anything the moment a timeline was longer than the screen.
 */
export interface TrackSound {
  /** "Walking Away", or "Your video's sound". */
  label: string;
  /** Seconds into the sound that play at 0:00 of the video. */
  startSec: number;
  /** How long the sound runs, or null when it has not been measured. Bounds the drag. */
  soundSeconds: number | null;
  onStartChange: (seconds: number) => void;
  onClear: () => void;
  /** Kept and cropped, but left OUT of the video — so she can hear the edit with and without it. */
  muted: boolean;
  onToggleMuted: () => void;
}
/**
 * Breathing room at both ends of the scroll content.
 *
 * The playhead lands here in checkpoint 3 and has to be draggable to 0:00 and to the very end
 * without being pinned against the edge of the viewport.
 */
export const EDGE_PAD = Spacing.md;

export function TimelineTrack({
  /**
   * Computed by the CALLER, not here.
   *
   * The scrub has to resolve a second to a clip, and whoever does that must be measuring the same
   * track that is drawn. Computing it in both places from the same inputs is one `pxPerSec` away
   * from two surfaces quietly disagreeing about where a clip starts.
   */
  layout,
  /** Keyed by asset id — the same clip may hold more than one position. */
  clipsById,
  pxPerSec = DEFAULT_PX_PER_SEC,
  onSelect,
  selectedKey,
  /** Where the playhead sits, in TRACK seconds. */
  playheadSec = 0,
  /** Dragging or tapping the ruler. Absent leaves the track unscrubbable. */
  onScrub,
  onTrim,
  onReorder,
  sound,
}: {
  /** The chosen sound, or null/absent for none — in which case the track is exactly as it was. */
  sound?: TrackSound | null;
  layout: TrackLayout;
  clipsById: Map<string, TrackClipSource>;
  pxPerSec?: number;
  /** Tapping a clip. Absent leaves the track view-only. */
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  playheadSec?: number;
  onScrub?: (sec: number) => void;
  /** Dragging an edge of the SELECTED clip. Absent leaves the track untrimmable. */
  onTrim?: (key: string, edge: TrimEdge, seconds: number) => void;
  /** A clip held and dragged to a new position. `toIndex` is already `moveItem`'s `to`. */
  onReorder?: (key: string, toIndex: number) => void;
}) {
  const ticks = useMemo(
    () => rulerTicks(layout.totalSeconds, pxPerSec),
    [layout.totalSeconds, pxPerSec],
  );

  /*
   * ⚠️  THE SCRUB IS ON THE RULER, NOT ON THE CLIP LANE, and that is a deliberate choice about
   * which gestures are allowed to compete. A pan over the lane would fight tap-to-select today and
   * long-press-to-drag at checkpoint 6; putting it on the ruler settles that conflict once.
   *
   * `.runOnJS(true)` is MaskEditor's flavour of this: the handler is plain JS, so the arithmetic
   * stays in `timelineGeometry` where it is tested rather than in a worklet where it is not.
   */
  const scrub = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .withTestId("timeline-scrub")
        .onBegin((e) =>
          onScrub?.(clampToTrack(timeAtX(e.x - EDGE_PAD, pxPerSec), layout)),
        )
        .onUpdate((e) =>
          onScrub?.(clampToTrack(timeAtX(e.x - EDGE_PAD, pxPerSec), layout)),
        ),
    [onScrub, pxPerSec, layout],
  );

  /**
   * A drag finished: turn where the clip's centre ended up into an array index.
   *
   * The geometry lives here rather than in the clip, because only the track knows about the other
   * clips — and only one place should know how a position on screen becomes a position in the
   * array.
   */
  const onDrop = useMemo(
    () =>
      onReorder
        ? (key: string, centreX: number) => {
            const from = layout.rects.findIndex((r) => r.key === key);
            if (from < 0) return;
            const to = dropIndexFor(centreX, layout, from);
            if (to !== from) onReorder(key, to);
          }
        : undefined,
    [onReorder, layout],
  );

  if (layout.rects.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
    >
      {/*
        ⚠️  THE EXPLICIT WIDTH IS LOAD-BEARING AND ITS ABSENCE IS SILENT. A ScrollView takes its
        scrollable extent from its content, and absolutely-positioned children contribute nothing
        to that — so without this the track draws correctly and simply refuses to scroll past the
        viewport, which reads as a short timeline rather than as a bug.
      */}
      <View
        testID="timeline-track-content"
        style={[styles.content, { width: layout.totalWidth + EDGE_PAD * 2 }]}
      >
        <GestureDetector gesture={scrub}>
          <View style={styles.ruler} testID="timeline-ruler">
            {ticks.map((tick) => (
              <View
                key={tick.sec}
                testID={`timeline-tick-${tick.sec}`}
                style={[styles.tick, { left: EDGE_PAD + tick.x }]}
              >
                <View style={styles.tickMark} />
                <Text style={styles.tickTxt}>{clock(tick.sec)}</Text>
              </View>
            ))}
          </View>
        </GestureDetector>

        <View style={styles.lane}>
          {/*
            ⚠️  RENDERED IN TIMELINE ORDER, and that is not incidental. A crossfade makes two rects
            genuinely overlap, and the LATER clip is the frame she is looking at — the same rule
            `resolvePlayhead` follows. A later sibling paints on top, so the order below IS the
            rule; reverse it and the outgoing clip covers the incoming one.
          */}
          {layout.rects.map((rect) => (
            <Clip
              key={rect.key}
              rect={rect}
              source={clipsById.get(rect.assetId)}
              faded={rect.hasCrossfade}
              selected={rect.key === selectedKey}
              onSelect={onSelect}
              pxPerSec={pxPerSec}
              onTrim={onTrim}
              onDrop={onDrop}
            />
          ))}
        </View>

        {sound && layout.totalWidth > 0 ? (
          <SoundLane
            sound={sound}
            width={layout.totalWidth}
            pxPerSec={pxPerSec}
          />
        ) : null}

        {/*
          The playhead, drawn OVER both rows and outside the gesture so it never swallows a tap
          meant for a clip. Its handle sits in the ruler, which is the band that scrubs.
        */}
        <View
          testID="timeline-playhead"
          pointerEvents="none"
          style={[
            styles.playhead,
            { left: EDGE_PAD + xAtTime(playheadSec, pxPerSec) },
          ]}
        >
          <View style={styles.playheadKnob} />
          <View
            style={[
              styles.playheadLine,
              // Through the sound lane too, when there is one: the line is "this moment", and the
              // sound at this moment is part of it.
              sound
                ? { height: PLAYHEAD_HEIGHT + SOUND_GAP + SOUND_HEIGHT }
                : null,
            ]}
          />
        </View>
      </View>
    </ScrollView>
  );
}

/**
 * ⚠️  MEMOISED, because the playhead moves five times a second during playback and none of a clip's
 * props change when it does. Without this every progress tick reconciles every tile on the track —
 * each of which carries a poster, and a poster-less one carries a decoder.
 *
 * It holds only because every callback reaching it is already stable: `onSelect`, `onTrim` and
 * `onDrop` are all memoised by their owners against inputs that do not include the playhead. If one
 * of them is ever made to change per render, this quietly stops working and nothing fails — which
 * is why they are named here rather than left to be rediscovered.
 */
const Clip = React.memo(function Clip({
  rect,
  source,
  faded,
  selected,
  onSelect,
  pxPerSec,
  onTrim,
  onDrop,
}: {
  rect: TrackRect;
  source: TrackClipSource | undefined;
  faded: boolean;
  selected: boolean;
  onSelect?: (key: string) => void;
  pxPerSec: number;
  onTrim?: (key: string, edge: TrimEdge, seconds: number) => void;
  onDrop?: (key: string, centreX: number) => void;
}) {
  /*
   * ⚠️  "—", NEVER THE PLACEHOLDER'S SECONDS. An unknown clip is DRAWN at a placeholder width so
   * it can be seen and fixed, but labelling it "0:03" would be that invented number escaping into
   * something she could believe. `Row` already says "—" for the same case.
   */
  const label =
    rect.durationSource === "unknown"
      ? "—"
      : clock(rect.sourceEndSec - rect.sourceStartSec);
  // A held photo says so — in words for assistive tech, and with a mark on the tile.
  const what = rect.still ? "Photo" : "Clip";

  /*
   * ⚠️  THE HOLD IS WHAT MAKES THREE GESTURES COEXIST ON ONE CLIP, and it settles two conflicts
   * with one mechanism:
   *
   *   tap              → select   neither pan activates: one needs movement, this one a hold
   *   drag an edge     → trim     the handle's pan fires on the FIRST move, while this waits
   *   hold, then drag  → reorder  the handle was not touched and the hold has elapsed
   *
   * It is also what stops this losing the race to the horizontal ScrollView the track sits in: a
   * reorder activating on the first movement would either be swallowed by the scroll, or win and
   * make the track unscrollable.
   *
   * ⚠️ NOT CLOSED: a long-press that STARTS on a trim handle. The handle still wins on the first
   * movement, so it is narrow — closing it properly needs `blocksExternalGesture` with refs across
   * two components. Device acceptance, not a guess.
   */
  const dx = useSharedValue(0);
  const held = useSharedValue(0);
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .withTestId(`reorder-${rect.key}`)
        .activateAfterLongPress(REORDER_HOLD_MS)
        .enabled(!!onDrop)
        .onStart(() => {
          held.value = 1;
        })
        .onUpdate((e) => {
          dx.value = e.translationX;
        })
        .onEnd((e) => {
          onDrop?.(rect.key, rect.x + rect.width / 2 + e.translationX);
        })
        .onFinalize(() => {
          // Always, not only on a clean end — a cancelled drag must not leave the clip offset.
          dx.value = 0;
          held.value = 0;
        }),
    [rect.key, rect.x, rect.width, onDrop, dx, held],
  );

  /*
   * The dependency array is explicit on purpose. Without it this relies on the reanimated Babel
   * plugin having rewritten the worklet — true in the app, false under ts-jest, where it throws at
   * render. Stating the dependencies costs nothing and makes the component work in both.
   */
  const lifted = useAnimatedStyle(
    () => ({
      transform: [{ translateX: dx.value }],
      opacity: held.value ? 0.85 : 1,
      zIndex: held.value ? 10 : 0,
    }),
    [dx, held],
  );

  return (
    <GestureDetector gesture={drag}>
      <Animated.View
        testID={`timeline-clip-${rect.key}`}
        style={[
          styles.clip,
          { left: EDGE_PAD + rect.x, width: rect.width },
          faded && styles.clipFaded,
          selected && styles.clipOn,
          lifted,
        ]}
      >
        <HapticPressable
          testID={`timeline-clip-tap-${rect.key}`}
          style={StyleSheet.absoluteFill}
          onPress={onSelect ? () => onSelect(rect.key) : undefined}
          disabled={!onSelect}
          /*
           * A short segment is genuinely hard to hit — there is deliberately no minimum drawn width,
           * because a minimum would make timeAtX piecewise and scrub, trim and split all lean on it
           * being an exact inverse. hitSlop widens the TOUCH TARGET without widening the rect, which
           * is the part that has to stay honest.
           */
          hitSlop={{ top: 0, bottom: 0, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={`${what} at ${clock(rect.startSec)}, ${label} long`}
        >
          {/*
            ⚠️  THE POSTER TAKES NO POINTER EVENTS, AND ON WEB THAT IS WHAT MAKES THE DRAG WORK AT
            ALL.
            
            An `<img>` is natively draggable in a browser. React Native Web's own Image sets
            `draggable={false}`, but this is expo-image's, which does not — so pressing and dragging
            a clip started CHROME'S OWN drag-and-drop, which paints a translucent ghost of the tile
            and swallows the pointer stream. The reorder gesture never activated, and what she saw
            was a floating picture instead of a clip moving.
            
            `pointerEvents="none"` means the pointer never targets the image at all, so there is
            nothing for the browser to start a drag on and the event lands on the view that actually
            wants it. The same covers the `<video>` a poster-less clip renders. On native it costs
            nothing: this was always decoration.
          */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ClipPoster
              source={{
                mediaType: "VIDEO",
                thumbUrl: source?.posterUrl ?? null,
                videoUrl: source?.videoUrl ?? null,
              }}
              style={StyleSheet.absoluteFill}
            />
          </View>
          <Text style={styles.clipTxt} numberOfLines={1}>
            {rect.still ? (
              <Feather name="image" size={9} color={Colors.light.onHero} />
            ) : null}
            {rect.still ? ` ${label}` : label}
          </Text>
        </HapticPressable>
        {/*
          ⚠️  HANDLES ONLY ON THE SELECTED CLIP, AND NEVER ON ONE OF UNKNOWN LENGTH. Twelve pairs
          of handles is noise; and the placeholder width of an unmeasured clip is a plausible three
          seconds against a clip that might be sixty, so trimming against it would silently throw
          away most of the footage. See `setTrim`, which refuses the same case at the arithmetic.

          OUTSIDE the pressable, so grabbing a handle is never also a press on the clip.
        */}
        {/* Nor on a held photo: its length is its hold, set by the chips under the track. */}
        {selected &&
        onTrim &&
        rect.durationSource !== "unknown" &&
        !rect.still ? (
          <TrimHandles rect={rect} pxPerSec={pxPerSec} onTrim={onTrim} />
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
});

/**
 * The two edges of the selected clip, as gestures.
 *
 * Each drag is measured from where the edge WAS when the finger went down, captured in `onBegin`.
 * Reading the live position instead would feed the trim back into itself: applying the trim moves
 * the rect, which moves the edge, which changes the number the next update computes.
 */
function TrimHandles({
  rect,
  pxPerSec,
  onTrim,
}: {
  rect: TrackRect;
  pxPerSec: number;
  onTrim: (key: string, edge: TrimEdge, seconds: number) => void;
}) {
  // The rect is read through a ref so the gesture objects stay STABLE across a drag — rebuilding
  // them mid-gesture is how a drag loses its own handler.
  const live = useRef(rect);
  live.current = rect;
  const from = useRef(0);

  // Both built in ONE memo, so the factory is not itself a dependency that changes every render.
  const [start, end] = useMemo(() => {
    const edge = (which: TrimEdge) =>
      Gesture.Pan()
        .runOnJS(true)
        .withTestId(`trim-${which}-${rect.key}`)
        .onBegin(() => {
          from.current =
            which === "start"
              ? live.current.sourceStartSec
              : live.current.sourceEndSec;
        })
        .onUpdate((e) =>
          onTrim(
            live.current.key,
            which,
            from.current + timeAtX(e.translationX, pxPerSec),
          ),
        );
    return [edge("start"), edge("end")] as const;
  }, [rect.key, pxPerSec, onTrim]);

  return (
    <>
      <GestureDetector gesture={start}>
        <View
          testID={`trim-handle-start-${rect.key}`}
          style={[styles.handle, styles.handleStart]}
          // The clip has no minimum drawn width, on purpose — so the TOUCH target is widened here
          // instead, which is the part that may lie.
          hitSlop={{ top: 6, bottom: 6, left: 10, right: 10 }}
          accessibilityRole="adjustable"
          accessibilityLabel="Trim the start of this clip"
        />
      </GestureDetector>
      <GestureDetector gesture={end}>
        <View
          testID={`trim-handle-end-${rect.key}`}
          style={[styles.handle, styles.handleEnd]}
          hitSlop={{ top: 6, bottom: 6, left: 10, right: 10 }}
          accessibilityRole="adjustable"
          accessibilityLabel="Trim the end of this clip"
        />
      </GestureDetector>
    </>
  );
}

const PLAYHEAD_HEIGHT = RULER_HEIGHT + TRACK_HEIGHT;

/**
 * The sound's tile. Drag it sideways to choose where in the sound the video starts.
 *
 * ⚠️  THE ONLY "CROP" A SOUND HAS IS ITS START. It always ends when the video ends (the engine
 * clamps the mix to the programme) and loops if it is shorter, so there is no out-point to set —
 * and the tile is therefore always exactly as wide as the timeline. What moves is the label.
 *
 * `activeOffsetX` claims a HORIZONTAL drag for the tile and leaves everything else to the scroll
 * view it sits in; the arithmetic is `soundStartAfterDrag`, which is where the direction (left is
 * later) and the clamps are decided and tested.
 */
function SoundLane({
  sound,
  width,
  pxPerSec,
}: {
  sound: TrackSound;
  width: number;
  pxPerSec: number;
}) {
  const base = useRef(sound.startSec);
  const latest = useRef(sound);
  latest.current = sound;

  const drag = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetX([-6, 6])
        .onBegin(() => {
          base.current = latest.current.startSec;
        })
        .onUpdate((e) => {
          const next = soundStartAfterDrag(
            base.current,
            e.translationX,
            pxPerSec,
            latest.current.soundSeconds,
          );
          if (next !== latest.current.startSec) {
            latest.current.onStartChange(next);
          }
        }),
    [pxPerSec],
  );

  return (
    <GestureDetector gesture={drag}>
      <View
        testID="timeline-sound"
        style={[
          styles.sound,
          { left: EDGE_PAD, width: Math.max(width, 170) },
          sound.muted && styles.soundMuted,
        ]}
        accessibilityRole="adjustable"
        accessibilityLabel={`${sound.label}, starting ${clock(sound.startSec)} in. Drag sideways to change where it starts.`}
      >
        <HapticPressable
          onPress={sound.onToggleMuted}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ selected: sound.muted }}
          accessibilityLabel={
            sound.muted ? "Put the sound back in" : "Leave the sound out"
          }
        >
          <Feather
            name={sound.muted ? "volume-x" : "volume-2"}
            size={14}
            color={
              sound.muted ? Colors.light.textSecondary : Colors.light.primary
            }
          />
        </HapticPressable>
        <Text style={styles.soundTxt} numberOfLines={1}>
          {sound.label}
          {sound.muted
            ? " · muted"
            : sound.startSec > 0
              ? ` · from ${clock(sound.startSec)}`
              : ""}
        </Text>
        {/* The tile looked like a label and nobody tried to drag it (first device pass). The grip
            says it moves; the words under the track say what moving it does. */}
        <Feather
          name="move"
          size={12}
          color={Colors.light.textSecondary}
          accessibilityElementsHidden
        />
        <HapticPressable
          onPress={sound.onClear}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Take the sound off"
        >
          <Feather name="x" size={13} color={Colors.light.textSecondary} />
        </HapticPressable>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  sound: {
    marginTop: SOUND_GAP,
    height: SOUND_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.xs,
    borderWidth: 1,
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
    // A held drag over the label otherwise starts selecting text on web, which fights the gesture.
    userSelect: "none",
  },
  /* Muted is still THERE — her choice and where it starts are kept — so it dims rather than goes. */
  soundMuted: {
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  soundTxt: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontWeight: "500",
    fontSize: 12,
    color: Colors.light.text,
  },
  scroll: { marginHorizontal: -Spacing.md },
  content: { paddingVertical: Spacing.xs },
  /* Tall enough to grab: this band IS the scrub surface, not just a label strip. */
  ruler: { height: RULER_HEIGHT },
  tick: { position: "absolute", alignItems: "flex-start" },
  tickMark: {
    width: 1,
    height: 4,
    backgroundColor: Colors.light.border,
  },
  tickTxt: {
    fontFamily: Fonts.body,
    fontSize: 10,
    color: Colors.light.textQuiet,
  },
  lane: { height: TRACK_HEIGHT },
  clip: {
    position: "absolute",
    // A held drag over a label otherwise starts selecting text on web, which fights the gesture.
    userSelect: "none",
    top: 0,
    height: TRACK_HEIGHT,
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    justifyContent: "flex-end",
    // DESIGN.md: a video sits on the dark inset, the same ground the player uses.
    backgroundColor: "#0D0B08",
  },
  /* A crossfaded clip overlaps the one before it; the accent says the overlap is deliberate. */
  clipFaded: {
    borderLeftWidth: 2,
    borderLeftColor: Colors.light.primary,
  },
  /* The clip the preview is showing. */
  clipOn: {
    borderWidth: 2,
    borderColor: Colors.light.primary,
  },
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 12,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  handleStart: {
    left: 0,
    borderTopLeftRadius: BorderRadius.xs,
    borderBottomLeftRadius: BorderRadius.xs,
  },
  handleEnd: {
    right: 0,
    borderTopRightRadius: BorderRadius.xs,
    borderBottomRightRadius: BorderRadius.xs,
  },
  playhead: {
    position: "absolute",
    top: 0,
    alignItems: "center",
    // Half the knob, so the LINE is what sits on the second — the knob is centred on it.
    marginLeft: -6,
    width: 12,
  },
  playheadKnob: {
    width: 12,
    height: 12,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  playheadLine: {
    width: 2,
    height: RULER_HEIGHT + TRACK_HEIGHT,
    backgroundColor: Colors.light.primary,
  },
  clipTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 10,
    color: Colors.light.onHero,
    paddingHorizontal: 4,
    paddingBottom: 3,
  },
});
