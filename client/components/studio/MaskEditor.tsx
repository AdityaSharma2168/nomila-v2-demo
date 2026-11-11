/**
 * MaskEditor — where an athlete marks the part of a photo she wants changed.
 *
 * WHAT IT PRODUCES, AND WHY THAT SHAPE. Every box leaves here as FRACTIONS of the source image
 * (0..1), never pixels. The photo on screen is a scaled-down stand-in for a 4000x6000-class
 * original, so a pixel measured here means nothing on the server — and a mask that lands in the
 * wrong place re-renders features that should not move, which is the failure the spike hit with a
 * loose crop. A fraction survives every transform between her finger and the original: device
 * pixel ratio, the letterboxing `resizeMode="contain"` adds, the difference between the preview
 * she sees and the full-resolution frame the model gets. There is no scale factor for the client
 * and the server to disagree about, because there is no scale factor.
 *
 * The server does the rest: it measures the real frame from the object's own bytes and multiplies
 * (server/studio/geometry.ts). NOTHING here is trusted for geometry. `Image.getSize` is used ONLY
 * to lay the image out inside its container — if it were ever wrong, the box would look wrong to
 * her while she is drawing it, which is a self-correcting error rather than a silent one.
 *
 * THE BOX IS A RECTANGLE, DELIBERATELY. `editRegions` is `{label, left, top, width, height}` and
 * the mask reaches the model as language, not as an alpha channel — there is no brush, lasso or
 * polygon behind this contract to expose.
 */
import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Feather } from "@expo/vector-icons";
import type { StudioRegion } from "../../hooks/use-studio";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { regionToPixels, useContainedStage } from "../../hooks/use-contained-stage";

/**
 * Where the copy turns cautionary. Mirrors LOOSE_REGION_AREA in server/studio/geometry.ts — the
 * server owns the real warning (it rides the preview's `warnings`, so it is in the frozen brief);
 * this is the live nudge while her finger is still down. A v1 guess, tuned in one place there.
 */
const LOOSE_AREA = 0.25;

/** Matches MIN_REGION_PX server-side once mapped: guards the mis-tap before it becomes a request. */
const MIN_DRAW_PX = 12;

/**
 * The stage's height bounds, and what it falls back to before the photo has been measured.
 *
 * A FIXED 320 WAS THE BUG. `contain` fits the photo inside whatever box it is given, so a fixed
 * landscape-ish stage rendered every portrait frame as a narrow column with wide black bars either
 * side — which is most phone photos. The bars were not just ugly: they shrank the drawable image to
 * a fraction of the stage, so the fine control she needs to mark one sleeve was gone.
 *
 * Giving the stage the PHOTO'S OWN aspect ratio removes them, because there is then nothing left
 * for `contain` to letterbox. The bounds are the only reason bars can still appear at all: a 9:16
 * story would otherwise run off the bottom of the screen, and a panorama would collapse to a strip
 * too short to draw in. Between them the photo fills the stage exactly.
 */
const HANDLE = 28;
const MAX_REGIONS = 3;
const MAX_LABEL = 60;

type Box = { left: number; top: number; width: number; height: number };

/** A region while it is being edited: a fractional box plus the words that go with it. */
export interface DraftRegion extends Box {
  id: string;
  label: string;
}

export function toStudioRegions(drafts: DraftRegion[]): StudioRegion[] {
  return drafts.map((d) => ({
    label: d.label.trim(),
    left: d.left,
    top: d.top,
    width: d.width,
    height: d.height,
  }));
}

/** Clamp a fractional edge into the image. Drawing past the edge stops at it rather than refusing. */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function MaskEditor({
  imageUrl,
  regions,
  onChange,
}: {
  imageUrl: string | null;
  regions: DraftRegion[];
  onChange: (next: DraftRegion[]) => void;
}) {
  // Where the photo lands inside its container, and the stage height that follows from it. Shared
  // with the read-only preview in screens/studio/MakeItScreen.tsx — see hooks/contained-stage.ts for
  // why this is one implementation and not two.
  const { onLayout, stageHeight, drawn } = useContainedStage(imageUrl);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Box | null>(null);

  /** Screen point → fraction OF THE IMAGE. The letterbox offset comes off before the divide. */
  const toFraction = useCallback(
    (x: number, y: number) => {
      if (!drawn || drawn.w <= 0 || drawn.h <= 0) return { fx: 0, fy: 0 };
      return {
        fx: clamp01((x - drawn.x) / drawn.w),
        fy: clamp01((y - drawn.y) / drawn.h),
      };
    },
    [drawn],
  );

  const full = regions.length >= MAX_REGIONS;

  // Draw a new box. Gesture callbacks touch React state only, so they run on the JS thread — this
  // is a drag over a static image, not an animation, and a worklet would buy nothing here.
  const draw = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!!drawn && !full)
        .runOnJS(true)
        .onBegin((e) => {
          setActiveId(null);
          setDrawing({ left: e.x, top: e.y, width: 0, height: 0 });
        })
        .onUpdate((e) => {
          setDrawing((d) =>
            d ? { ...d, width: e.x - d.left, height: e.y - d.top } : d,
          );
        })
        .onEnd(() => {
          setDrawing((d) => {
            if (!d) return null;
            // Normalize a drag made in any direction into a positive-extent rect.
            const x1 = Math.min(d.left, d.left + d.width);
            const y1 = Math.min(d.top, d.top + d.height);
            const w = Math.abs(d.width);
            const h = Math.abs(d.height);
            if (w < MIN_DRAW_PX || h < MIN_DRAW_PX) return null; // a tap, not a box
            const a = toFraction(x1, y1);
            const b = toFraction(x1 + w, y1 + h);
            const id = `r${Date.now()}`;
            onChange([
              ...regions,
              {
                id,
                label: "",
                left: a.fx,
                top: a.fy,
                width: b.fx - a.fx,
                height: b.fy - a.fy,
              },
            ]);
            setActiveId(id);
            return null;
          });
        }),
    [drawn, full, regions, onChange, toFraction],
  );

  const update = (id: string, patch: Partial<DraftRegion>) =>
    onChange(regions.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(regions.filter((r) => r.id !== id));

  if (!imageUrl) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.eyebrow}>WHAT TO CHANGE</Text>

      <View style={[styles.stage, { height: stageHeight }]} onLayout={onLayout}>
        <GestureDetector gesture={draw}>
          <View style={StyleSheet.absoluteFill}>
            <Image
              source={{ uri: imageUrl }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
            {!drawn ? (
              <View style={styles.stageLoading}>
                <ActivityIndicator size="small" color={Colors.light.primary} />
              </View>
            ) : null}

            {drawn
              ? regions.map((r, i) => (
                  <RegionBox
                    key={r.id}
                    index={i}
                    region={r}
                    drawn={drawn}
                    active={r.id === activeId}
                    onSelect={() => setActiveId(r.id)}
                    onMove={(box) => update(r.id, box)}
                    toFraction={toFraction}
                  />
                ))
              : null}

            {drawing ? (
              <View
                pointerEvents="none"
                style={[
                  styles.live,
                  {
                    left: Math.min(drawing.left, drawing.left + drawing.width),
                    top: Math.min(drawing.top, drawing.top + drawing.height),
                    width: Math.abs(drawing.width),
                    height: Math.abs(drawing.height),
                  },
                ]}
              />
            ) : null}
          </View>
        </GestureDetector>
      </View>

      <Text style={styles.hint}>
        {regions.length === 0
          ? "Drag a box around the part you want changed. Everything outside it stays exactly as it is."
          : full
            ? `${MAX_REGIONS} regions is the most one edit can carry.`
            : "Drag another box to mark a second thing, or tap a box to rename it."}
      </Text>

      {regions.map((r, i) => {
        const area = r.width * r.height;
        const loose = area > LOOSE_AREA;
        return (
          <View
            key={r.id}
            style={[styles.row, r.id === activeId ? styles.rowOn : null]}
          >
            <View style={styles.rowIdx}>
              <Text style={styles.rowIdxTxt}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <TextInput
                style={styles.label}
                value={r.label}
                onChangeText={(t) =>
                  update(r.id, { label: t.slice(0, MAX_LABEL) })
                }
                onFocus={() => setActiveId(r.id)}
                placeholder="What should change here? e.g. the logo on the ball"
                placeholderTextColor={Colors.light.textMuted}
                maxLength={MAX_LABEL}
              />
              {/* The live steer. The server owns the authoritative warning; this is what she reads
                  while the box is still under her finger, which is when it can change her mind. */}
              <Text style={[styles.area, loose ? styles.areaLoose : null]}>
                {`${Math.max(1, Math.round(area * 100))}% of the photo`}
                {loose
                  ? " — a tighter box keeps more of the shot untouched"
                  : ""}
              </Text>
            </View>
            <Pressable
              onPress={() => remove(r.id)}
              hitSlop={10}
              accessibilityLabel={`Remove region ${i + 1}`}
            >
              <Feather
                name="trash-2"
                size={16}
                color={Colors.light.textMuted}
              />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** One drawn box: draggable body, one resize handle, rendered from fractions every time. */
function RegionBox({
  index,
  region,
  drawn,
  active,
  onSelect,
  onMove,
  toFraction,
}: {
  index: number;
  region: DraftRegion;
  drawn: { x: number; y: number; w: number; h: number };
  active: boolean;
  onSelect: () => void;
  onMove: (box: Box) => void;
  toFraction: (x: number, y: number) => { fx: number; fy: number };
}) {
  const px = {
    ...regionToPixels(region, drawn),
  };

  // Fractions are the source of truth, so a drag is applied to the fractional origin and the extent
  // is carried unchanged — moving a box can never resize it through accumulated rounding.
  const move = Gesture.Pan()
    .runOnJS(true)
    .onBegin(onSelect)
    .onUpdate((e) => {
      const a = toFraction(px.left + e.translationX, px.top + e.translationY);
      onMove({
        left: Math.min(a.fx, 1 - region.width),
        top: Math.min(a.fy, 1 - region.height),
        width: region.width,
        height: region.height,
      });
    });

  const resize = Gesture.Pan()
    .runOnJS(true)
    .onBegin(onSelect)
    .onUpdate((e) => {
      const b = toFraction(
        px.left + px.width + e.translationX,
        px.top + px.height + e.translationY,
      );
      onMove({
        left: region.left,
        top: region.top,
        width: Math.max(0.01, b.fx - region.left),
        height: Math.max(0.01, b.fy - region.top),
      });
    });

  return (
    <GestureDetector gesture={move}>
      <View style={[styles.box, active ? styles.boxOn : null, px]}>
        <View style={styles.boxTag}>
          <Text style={styles.boxTagTxt}>{index + 1}</Text>
        </View>
        <GestureDetector gesture={resize}>
          <View style={styles.handle}>
            <View style={styles.handleDot} />
          </View>
        </GestureDetector>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: Spacing.xl, paddingTop: 22 },
  eyebrow: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    letterSpacing: 1.6,
    color: Colors.light.textMuted,
    fontWeight: "700",
    marginBottom: 10,
  },
  // No blur anywhere: DESIGN.md reserves it for floating buttons over media.
  stage: {
    borderRadius: BorderRadius.lg,
    overflow: "hidden",
    backgroundColor: "#0D0B08",
    borderWidth: 1,
    borderColor: Colors.light.border,
    // No height here on purpose: it is computed in `stageHeight` so the clamp is ours rather than
    // the layout engine's. See the note there.
  },
  stageLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  live: {
    position: "absolute",
    borderWidth: 2,
    borderColor: Colors.light.primary,
    borderStyle: "dashed",
    borderRadius: BorderRadius.xs,
  },
  box: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.9)",
    borderRadius: BorderRadius.xs,
  },
  boxOn: { borderColor: Colors.light.primary },
  boxTag: {
    position: "absolute",
    top: -9,
    left: -9,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  boxTagTxt: {
    fontFamily: Fonts.bodyBold,
    fontWeight: "800",
    fontSize: 11,
    color: Colors.light.buttonText,
  },
  handle: {
    position: "absolute",
    right: -HANDLE / 2,
    bottom: -HANDLE / 2,
    width: HANDLE,
    height: HANDLE,
    alignItems: "center",
    justifyContent: "center",
  },
  handleDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.light.primary,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
    marginTop: 10,
    lineHeight: 17,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 10,
    padding: 12,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  rowOn: { borderColor: Colors.light.primary },
  rowIdx: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.light.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  rowIdxTxt: {
    fontFamily: Fonts.bodyBold,
    fontWeight: "800",
    fontSize: 11,
    color: Colors.light.primary,
  },
  label: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    padding: 0,
  },
  area: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    color: Colors.light.textMuted,
    marginTop: 4,
  },
  areaLoose: { color: Colors.light.warning },
});
