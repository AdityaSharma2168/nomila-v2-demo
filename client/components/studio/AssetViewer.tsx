/**
 * AssetViewer — a generated asset, full screen, close enough to judge.
 *
 * ─── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Until now the only way to look properly at something Studio made was to open its raw GCS url in a
 * browser tab. That is fine for us and impossible for her, and it is the reason an edit's fidelity
 * — did the retouch hold the skin texture, is the pasted region's seam visible — could not be
 * judged in the app at all. A 132px tile cannot answer that question. This can.
 *
 * ─── IT REUSES THE SIGNED URL IT WAS GIVEN. IT NEVER MINTS ONE ─────────────────────────────────
 * The uri handed in is the same signed url the thumbnail already rendered, straight off the read
 * that populated the surface (studio/content.ts for the shelf, the generate route's shapeAssets for
 * the result view). Both sign `media_assets.gcs_path` — the FULL-RES original object — so there is
 * no smaller variant to upgrade from and no second request to make. Nothing here builds a url from
 * a gcs path, and nothing here re-signs: this component cannot reach the network except through the
 * <Image> it is handed.
 *
 * ─── ZOOM ON TWO VERY DIFFERENT SURFACES ───────────────────────────────────────────────────────
 * Touch is pinch + drag + double-tap, on gesture-handler, matching the mask editor next door. Web
 * has no pinch, so the wheel drives the same shared values through a window listener — a listener
 * rather than a ref-to-DOM cast, because the viewer is the whole viewport while it is open and
 * there is nothing else on screen a scroll could belong to.
 *
 * Zoom is about the FOCAL POINT in both cases (`t1 = f - (f - t0)·k`, holding the point under the
 * fingers/cursor still). Zooming about the centre instead is the difference between inspecting a
 * corner and chasing it around the screen.
 *
 * ─── THE CHROME IS OUTSIDE THE GESTURE ─────────────────────────────────────────────────────────
 * Close and Download sit above the GestureDetector, not inside it. A tap-to-close that also lives
 * under the download button is a download button that closes the viewer.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, Image, Modal, Platform, Pressable, StatusBar, StyleSheet, Text, View,
  useWindowDimensions,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fileNameFor, saveRemoteAsset } from "../../lib/download-asset";
import { Brand, Fonts, Bold } from "../../constants/theme";
import { QaChip } from "./QaChip";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
/** Where a double-tap lands. Enough to read a seam; not so far that you lose the frame. */
const TAP_SCALE = 2.6;
const SETTLE = { duration: 150 };
const CHROME = Bold.onDark;
/** Room the note leaves under itself for the Edit this pill, when there is one. */
const EDIT_CLEARANCE = 56;

function clamp(v: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
}

/** How far the content may slide before its edge leaves the window. Zero while it fits. */
function bound(window: number, content: number, scale: number): number {
  "worklet";
  return Math.max(0, (content * scale - window) / 2);
}

/** The largest box of aspect `ar` that fits inside w×h — the pixels the image actually occupies. */
function fitInside(ar: number, w: number, h: number): { width: number; height: number } {
  const byWidth = w / ar;
  return byWidth <= h ? { width: w, height: byWidth } : { width: h * ar, height: h };
}

interface Props {
  visible: boolean;
  /** The SAME signed url the thumbnail used. Null renders the "nothing to show" state, not a crash. */
  uri: string | null;
  /** Names the downloaded file. A uuid — never a caption, never a brand. */
  assetId?: string | null;
  /** Optional line of context in the bar ("gorjana"). Never the caption; there is no room. */
  title?: string | null;
  onClose: () => void;
  /** When given, an ⓘ door to wherever this asset's detail lives, so opening the viewer costs nothing. */
  onDetails?: () => void;
  /**
   * When given, an "Edit this" pill: the Create anything thread's edit-from-chat (session persistence plan v2 §4).
   * The caller decides whether this asset can be edited — an image she can still read — and closes the viewer.
   * Absent for every other caller, whose viewer is exactly what it was.
   */
  onEdit?: () => void;
}

export function AssetViewer({
  visible,
  uri,
  assetId,
  title,
  onClose,
  onDetails,
  onEdit,
}: Props) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  const [ratio, setRatio] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  // Pinch and pan keep their own start values. Sharing one pair lets a two-finger gesture that
  // drives both at once clobber the other's origin mid-drag.
  const pinchScale0 = useSharedValue(1);
  const pinchTx0 = useSharedValue(0);
  const pinchTy0 = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const panTx0 = useSharedValue(0);
  const panTy0 = useSharedValue(0);

  // Before the image reports its shape, the box is the window and `contain` letterboxes inside it;
  // once the ratio lands the box IS the drawn pixels, so the pan bounds below are exact.
  const fit = ratio ? fitInside(ratio, winW, winH) : { width: winW, height: winH };
  const fitW = fit.width;
  const fitH = fit.height;

  // Every open starts at 1×, centred, with no stale note from the last asset.
  useEffect(() => {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    setRatio(null);
    setLoaded(false);
    setFailed(false);
    setNote(null);
    setSaving(false);
  }, [uri, visible, scale, tx, ty]);

  // The settle below is written out in both onEnd handlers rather than shared through a local
  // worklet. Six repeated lines cost less than a closure whose UI-thread behaviour depends on how
  // the worklets plugin treats a component-scope arrow; module-level worklets called from inline
  // gesture callbacks is the shape DeckSpread already ships.
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      pinchScale0.value = scale.value;
      pinchTx0.value = tx.value;
      pinchTy0.value = ty.value;
      focalX.value = e.focalX - winW / 2;
      focalY.value = e.focalY - winH / 2;
    })
    .onUpdate((e) => {
      const next = clamp(pinchScale0.value * e.scale, MIN_SCALE, MAX_SCALE);
      const k = next / pinchScale0.value;
      scale.value = next;
      tx.value = focalX.value - (focalX.value - pinchTx0.value) * k;
      ty.value = focalY.value - (focalY.value - pinchTy0.value) * k;
    })
    .onEnd(() => {
      const s = clamp(scale.value, MIN_SCALE, MAX_SCALE);
      const bx = bound(winW, fitW, s);
      const by = bound(winH, fitH, s);
      scale.value = withTiming(s, SETTLE);
      tx.value = withTiming(clamp(tx.value, -bx, bx), SETTLE);
      ty.value = withTiming(clamp(ty.value, -by, by), SETTLE);
    });

  // Allowed at 1× too, so a drag on an unzoomed image rubber-bands back rather than doing nothing.
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      panTx0.value = tx.value;
      panTy0.value = ty.value;
    })
    .onUpdate((e) => {
      tx.value = panTx0.value + e.translationX;
      ty.value = panTy0.value + e.translationY;
    })
    .onEnd(() => {
      const s = clamp(scale.value, MIN_SCALE, MAX_SCALE);
      const bx = bound(winW, fitW, s);
      const by = bound(winH, fitH, s);
      scale.value = withTiming(s, SETTLE);
      tx.value = withTiming(clamp(tx.value, -bx, bx), SETTLE);
      ty.value = withTiming(clamp(ty.value, -by, by), SETTLE);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(280)
    .onEnd((e, ok) => {
      if (!ok) return;
      if (scale.value > 1.05) {
        scale.value = withTiming(1, SETTLE);
        tx.value = withTiming(0, SETTLE);
        ty.value = withTiming(0, SETTLE);
        return;
      }
      const fx = e.x - winW / 2;
      const fy = e.y - winH / 2;
      const bx = bound(winW, fitW, TAP_SCALE);
      const by = bound(winH, fitH, TAP_SCALE);
      scale.value = withTiming(TAP_SCALE, SETTLE);
      tx.value = withTiming(clamp(fx - (fx - tx.value) * TAP_SCALE, -bx, bx), SETTLE);
      ty.value = withTiming(clamp(fy - (fy - ty.value) * TAP_SCALE, -by, by), SETTLE);
    });

  // Tap-out closes ONLY at rest. Zoomed in, a stray tap that dismissed the thing you were
  // inspecting would be the most expensive gesture on the screen.
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    // `ok` is not optional politeness: onEnd fires for a FAILED tap too (the finger moved, so it
    // was a drag), and without the guard every pan would end by closing the viewer.
    .onEnd((_e, ok) => {
      if (ok && scale.value <= 1.05) scheduleOnRN(onClose);
    });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  // Web has no pinch. The wheel (and a trackpad pinch, which arrives as ctrl+wheel) drives the same
  // shared values, about the cursor, so scroll-to-zoom and pinch-to-zoom are one behaviour.
  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const fx = e.clientX - winW / 2;
      const fy = e.clientY - winH / 2;
      // deltaMode: 0 = pixels (Chrome/Safari), 1 = lines (Firefox), 2 = pages. Reading deltaY raw
      // makes the same flick zoom sixteen times less in Firefox than in Chrome.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? winH : 1;
      const from = scale.value;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from * Math.exp(-e.deltaY * unit * 0.0022)));
      const k = next / from;
      const bx = Math.max(0, (fitW * next - winW) / 2);
      const by = Math.max(0, (fitH * next - winH) / 2);
      scale.value = next;
      tx.value = Math.min(bx, Math.max(-bx, fx - (fx - tx.value) * k));
      ty.value = Math.min(by, Math.max(-by, fy - (fy - ty.value) * k));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [visible, winW, winH, fitW, fitH, scale, tx, ty]);

  const imageStyle = useAnimatedStyle(() => ({
    // translate BEFORE scale: the offsets stay in screen pixels, which is what the bounds measure.
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const download = useCallback(async () => {
    if (!uri || saving) return;
    setSaving(true);
    setNote(null);
    try {
      const outcome = await saveRemoteAsset(uri, fileNameFor(uri, assetId ?? null));
      setNote(
        outcome === "saved"
          ? "Saved to your downloads."
          : outcome === "opened"
            ? "Opened in a new tab — save it from there."
            : null, // The share sheet already told her what happened.
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't save it. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [uri, assetId, saving]);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        <GestureDetector gesture={gesture}>
          <View style={styles.stage} collapsable={false}>
            {uri && !failed ? (
              <Animated.View style={imageStyle}>
                <Image
                  source={{ uri }}
                  style={{ width: fitW, height: fitH }}
                  resizeMode="contain"
                  onLoad={(e) => {
                    const s = e.nativeEvent.source;
                    if (s?.width && s?.height) setRatio(s.width / s.height);
                    setLoaded(true);
                  }}
                  onError={() => setFailed(true)}
                  accessibilityRole="image"
                  accessibilityLabel={title ? `${title}, full screen` : "Generated asset, full screen"}
                />
              </Animated.View>
            ) : (
              <View style={styles.gone}>
                <Feather name={failed ? "alert-circle" : "image"} size={26} color="rgba(255,255,255,0.5)" />
                <Text style={styles.goneTx}>
                  {failed
                    ? "Couldn't load this one — the link may have expired. Close this and open it again."
                    : "There is nothing to show for this one yet."}
                </Text>
              </View>
            )}

            {uri && !loaded && !failed ? (
              <ActivityIndicator style={styles.spinner} color={CHROME} />
            ) : null}
          </View>
        </GestureDetector>

        {/* Above the gesture, never inside it. */}
        <View style={[styles.bar, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
          <Pressable
            style={styles.icon}
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={18} color={CHROME} />
          </Pressable>

          <View style={{ flex: 1, gap: 4 }}>
            {title ? (
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
            ) : null}
            {/* The check's word and the cost, on the bar, behind EXPO_PUBLIC_STUDIO_QA_DISPLAY
                (PR 11). Off, or for an asset nobody generated: null, and the bar is as it was. */}
            <QaChip assetId={assetId} tone="dark" />
          </View>

          {onDetails ? (
            <Pressable
              style={styles.icon}
              onPress={onDetails}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Details"
            >
              <Feather name="info" size={17} color={CHROME} />
            </Pressable>
          ) : null}

          <Pressable
            style={[styles.icon, (!uri || saving) && styles.iconOff]}
            onPress={download}
            disabled={!uri || saving}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Download"
            accessibilityState={{ disabled: !uri || saving }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={CHROME} />
            ) : (
              <Feather name="download" size={17} color={CHROME} />
            )}
          </Pressable>
        </View>

        {note ? (
          <View
            style={[
              styles.noteWrap,
              {
                paddingBottom:
                  insets.bottom + 18 + (onEdit ? EDIT_CLEARANCE : 0),
              },
            ]}
            pointerEvents="none"
          >
            <Text style={styles.note}>{note}</Text>
          </View>
        ) : null}

        {/* Above the gesture too, for the reason the bar is: a tap on it must never also close the viewer. */}
        {onEdit ? (
          <View
            style={[styles.editWrap, { paddingBottom: insets.bottom + 18 }]}
            pointerEvents="box-none"
          >
            <Pressable
              style={styles.editPill}
              onPress={onEdit}
              accessibilityRole="button"
              accessibilityLabel="Edit this"
            >
              <Feather name="edit-2" size={14} color={Brand.heroBg} />
              <Text style={styles.editTxt}>Edit this</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Score rings are not the only thing that belongs on #0D0B08 — a picture being judged does too.
  backdrop: { flex: 1, backgroundColor: Brand.heroBg },
  stage:    { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  spinner:  { position: "absolute" },
  gone:     { alignItems: "center", gap: 12, paddingHorizontal: 44 },
  goneTx:   { fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 20, textAlign: "center", color: "rgba(255,255,255,0.72)" },
  bar: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingBottom: 10,
  },
  title: {
    flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "rgba(255,255,255,0.82)",
  },
  icon: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.26)",
    backgroundColor: "rgba(12,13,16,0.44)",
    alignItems: "center", justifyContent: "center",
  },
  iconOff:  { opacity: 0.45 },
  noteWrap: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 28 },
  note: {
    fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, textAlign: "center",
    color: "rgba(255,255,255,0.8)",
  },
  // Edit this: a pill (DESIGN.md — at least 120 wide), solid rather than blurred, in the chrome's own colour.
  editWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
  editPill: {
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 999,
    backgroundColor: CHROME,
  },
  editTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: "600",
    color: Brand.heroBg,
  },
});
