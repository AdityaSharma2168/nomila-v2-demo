/**
 * ThreadCards — what Mila's answer to a send looks like IN the thread (session persistence plan v2 §4): the plan she
 * was shown, what it was built from, and — once she approved — the result, landing where the loading tile was.
 *
 * Every card here renders a `PlanCardView` (threadLogic.ts), so what it SAYS in each state is decided and tested
 * there. This file only draws it.
 *
 * ─── NOTHING HERE SPENDS, AND NOTHING HERE REFUSES ─────────────────────────────────────────────────────
 *
 * There is no Generate button in the thread. The one button that spends is still Make it's, in the sheet, over a
 * preview that sheet rendered; a card offers Check again, which opens a FRESH sheet. And "Here's what we'll do" is
 * the sheet's own InterpretationCard, rendered with `onReject={null}`: she answered it in the sheet, or it is
 * history, and in neither case is there a reading left to refuse.
 *
 * ─── PHONE WIDTH, AND DESIGN.md ────────────────────────────────────────────────────────────────────────
 *
 * One column. An output is capped at the thread's width and at 55% of the window's height (GenerationResult's
 * bound), so a tall portrait never pushes the composer off a phone. Thumbnails are 56px, the tray's size. Buttons
 * are pills of at least 120px; cards and tiles never go below radius `xs`; nothing is blurred; motion is
 * reanimated (a pulse on the loading tile, a fade as the image lands); icons are Feather.
 */
import React, { useEffect, useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { HapticPressable } from "../../components/HapticPressable";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { InterpretationCard } from "./MakeItScreen";
import type { OutputView, PlanCardView, ThumbView } from "./threadLogic";
import { OutputGateNotice } from "../../components/studio/OutputGateNotice";

/** An image in the thread she may open or edit: the viewer gets the same signed url the tile drew. */
export interface ThreadImageRef {
  assetId: string;
  uri: string | null;
  editable: boolean;
}

const OUTPUT_MAX_HEIGHT = 0.55;
/** Until an image reports its own shape, a portrait slot: most of what Studio makes is 4:5. */
const DEFAULT_RATIO = 4 / 5;

export function PlanCard({
  view,
  notSaved,
  onCheckAgain,
  onTryAgain,
  onOpen,
  onEdit,
  onOpenDetail,
}: {
  view: PlanCardView;
  /** The quiet line when this plan could not be saved. */
  notSaved?: string | null;
  onCheckAgain: () => void;
  /**
   * quality-scrappy piece 5: a fresh check with the gate's fix, for an output it failed. Absent, a failed output says
   * what went wrong and offers nothing — Check again still stands below it.
   */
  onTryAgain?: (corrective: string[]) => void;
  onOpen: (image: ThreadImageRef) => void;
  /** Edit this. Absent, and no image offers it. */
  onEdit?: (image: ThreadImageRef) => void;
  /** An output that is not an image opens where its detail lives — there is no edit for it. */
  onOpenDetail: (assetId: string) => void;
}) {
  if (view.collapsed) {
    return (
      <View style={styles.collapsed}>
        <Feather
          name="corner-left-down"
          size={12}
          color={Colors.light.textMuted}
        />
        <Text style={styles.collapsedTxt}>{view.headline}</Text>
      </View>
    );
  }

  const shown = view.outputs.some((o) => !o.removed);
  // quality-scrappy piece 5: an output the gate failed is not "on your Made shelf" in any sense she would mean.
  const failed = view.outputs.some((o) => o.gate);
  return (
    <View style={styles.body}>
      <Text style={styles.headline}>{view.headline}</Text>
      {view.note ? <Text style={styles.note}>{view.note}</Text> : null}

      {view.lines ? (
        <InterpretationCard
          lines={view.lines}
          onReject={null}
          rejecting={false}
        />
      ) : null}

      {view.builtFrom.length > 0 ? (
        <BuiltFromStrip thumbs={view.builtFrom} onOpen={onOpen} />
      ) : null}

      {/* Under the strip on purpose: "tap it" names those thumbnails, so the sentence sits beside them. */}
      {view.teaching ? (
        <Text style={styles.teaching}>{view.teaching}</Text>
      ) : null}

      {view.loading ? <LoadingTile /> : null}

      {view.outputs.map((o) => (
        <OutputTile
          key={o.assetId}
          output={o}
          onOpen={onOpen}
          onEdit={onEdit}
          onOpenDetail={onOpenDetail}
          onTryAgain={onTryAgain}
        />
      ))}
      {view.state === "made" && shown && !failed ? (
        <Text style={styles.caption}>On your Made shelf</Text>
      ) : null}

      {view.checkAgain ? (
        <Pill
          label="Check again"
          icon="refresh-cw"
          ghost
          onPress={onCheckAgain}
        />
      ) : null}

      {notSaved ? <Text style={styles.quiet}>{notSaved}</Text> : null}
    </View>
  );
}

/**
 * WHAT IT WAS BUILT FROM — the photos she sent, at the tray's size. A tap opens the viewer, which is where Edit
 * this lives for a thumbnail: a 56px tile has no room for a pill, and a smaller button than DESIGN.md allows is
 * not the answer to that.
 */
function BuiltFromStrip({
  thumbs,
  onOpen,
}: {
  thumbs: ThumbView[];
  onOpen: (image: ThreadImageRef) => void;
}) {
  return (
    <View style={styles.strip}>
      <Text style={styles.label}>BUILT FROM</Text>
      <View style={styles.thumbs}>
        {thumbs.map((t) => (
          <HapticPressable
            key={t.assetId}
            style={styles.thumb}
            disabled={t.removed || !t.uri}
            onPress={() =>
              onOpen({ assetId: t.assetId, uri: t.uri, editable: t.editable })
            }
            accessibilityRole={t.removed ? "image" : "imagebutton"}
            accessibilityLabel={
              t.removed ? `${t.label}, removed` : `${t.label}. Open it.`
            }
          >
            {t.uri && !t.removed ? (
              <Image source={{ uri: t.uri }} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.thumbGone]}>
                <Feather
                  name="slash"
                  size={14}
                  color={Colors.light.tabIconDefault}
                />
              </View>
            )}
            <View style={styles.thumbScrim} />
            <Text style={styles.thumbRole} numberOfLines={1}>
              {t.removed ? "REMOVED" : t.label.toUpperCase()}
            </Text>
          </HapticPressable>
        ))}
      </View>
    </View>
  );
}

/** Where the image will land. A slow pulse, not a spinner: it holds the image's place, so nothing jumps when it arrives. */
export function LoadingTile() {
  const { height } = useWindowDimensions();
  const pulse = useSharedValue(0.55);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      style={[styles.tile, { maxHeight: height * OUTPUT_MAX_HEIGHT }, style]}
      accessibilityRole="progressbar"
      accessibilityLabel="Making it"
    >
      <Feather name="zap" size={18} color={Colors.light.tabIconDefault} />
      <Text style={styles.tileTxt}>Making it…</Text>
    </Animated.View>
  );
}

function OutputTile({
  output,
  onOpen,
  onEdit,
  onOpenDetail,
  onTryAgain,
}: {
  output: OutputView;
  onOpen: (image: ThreadImageRef) => void;
  onEdit?: (image: ThreadImageRef) => void;
  onOpenDetail: (assetId: string) => void;
  onTryAgain?: (corrective: string[]) => void;
}) {
  // A missing object reads as the same tombstone a removed row does (plan §5) — never a broken image.
  const [broken, setBroken] = useState(false);
  if (output.removed || broken || !output.uri) return <RemovedTile />;

  // quality-scrappy piece 5: the gate failed it. Say so first, and why; she can still open it to see — but it is not
  // offered for an edit, and the only way forward on offer is a fresh check with the fix.
  const gate = output.gate;
  const notice = gate ? (
    <OutputGateNotice
      headline={gate.headline}
      lines={gate.lines}
      onTryAgain={onTryAgain ? () => onTryAgain(gate.corrective) : undefined}
    />
  ) : null;

  // Edits are stills-only, so anything but an image is a door to its detail and nothing more.
  if (output.mediaType !== "IMAGE") {
    return (
      <>
        {notice}
        <HapticPressable
          style={styles.generic}
          onPress={() => onOpenDetail(output.assetId)}
          accessibilityRole="button"
          accessibilityLabel="Open what was made"
        >
          <Feather name="film" size={18} color={Colors.light.textSecondary} />
          <Text style={styles.genericTxt}>Open it</Text>
        </HapticPressable>
      </>
    );
  }

  const ref: ThreadImageRef = {
    assetId: output.assetId,
    uri: output.uri,
    editable: output.editable,
  };
  return (
    <Animated.View entering={FadeIn.duration(240)} style={styles.output}>
      {notice}
      <HapticPressable
        onPress={() => onOpen(ref)}
        accessibilityRole="imagebutton"
        accessibilityLabel="Open the image full screen"
      >
        <ThreadImage uri={output.uri} onError={() => setBroken(true)} />
      </HapticPressable>
      {output.rejected ? <Text style={styles.rejected}>Rejected</Text> : null}
      {onEdit && output.editable && !gate ? (
        <Pill label="Edit this" icon="edit-2" onPress={() => onEdit(ref)} />
      ) : null}
    </Animated.View>
  );
}

/** An image at its own shape, as wide as the thread allows and no taller than 55% of the window. */
function ThreadImage({ uri, onError }: { uri: string; onError: () => void }) {
  const { height: winH } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  const r = ratio ?? DEFAULT_RATIO;
  const h = width ? Math.min(width / r, winH * OUTPUT_MAX_HEIGHT) : 0;
  return (
    <View
      style={styles.imageWrap}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width ? (
        <Image
          source={{ uri }}
          style={[styles.image, { width: h * r, height: h }]}
          resizeMode="cover"
          onLoad={(e) => {
            const s = e.nativeEvent.source;
            if (s?.width && s?.height) setRatio(s.width / s.height);
          }}
          onError={onError}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

/** A tombstone: where something was, with no image, no viewer and no Edit this. */
export function RemovedTile() {
  return (
    <View
      style={styles.removed}
      accessibilityRole="text"
      accessibilityLabel="Removed"
    >
      <Feather name="slash" size={16} color={Colors.light.tabIconDefault} />
      <Text style={styles.removedTxt}>Removed</Text>
    </View>
  );
}

export function Pill({
  label,
  icon,
  ghost = false,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  ghost?: boolean;
  onPress: () => void;
}) {
  return (
    <HapticPressable
      style={[styles.pill, ghost && styles.pillGhost]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather
        name={icon}
        size={13}
        color={ghost ? Colors.light.text : Colors.light.buttonText}
      />
      <Text style={[styles.pillTxt, ghost && styles.pillGhostTxt]}>
        {label}
      </Text>
    </HapticPressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.sm },
  headline: {
    fontFamily: Fonts.bodyBold,
    fontSize: 13.5,
    fontWeight: "700",
    lineHeight: 19,
    color: Colors.light.text,
  },
  note: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.light.textSecondary,
  },
  /** Quieter than `note`: this is an aside about what is happening, not a reason something failed. */
  teaching: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textMuted,
    marginTop: 7,
  },
  caption: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    fontWeight: "500",
    color: Colors.light.textMuted,
  },
  quiet: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
  },

  collapsed: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 35,
    marginBottom: 10,
  },
  collapsedTxt: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    color: Colors.light.textMuted,
  },

  strip: { gap: 6 },
  label: {
    fontFamily: Fonts.bodyBold,
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: Colors.light.textMuted,
  },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  thumbGone: { alignItems: "center", justifyContent: "center" },
  thumbScrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 18,
    backgroundColor: "rgba(13,11,8,0.62)",
  },
  thumbRole: {
    position: "absolute",
    left: 2,
    right: 2,
    bottom: 3,
    fontFamily: Fonts.bodyBold,
    fontSize: 7,
    fontWeight: "700",
    letterSpacing: 0.4,
    textAlign: "center",
    color: Colors.light.buttonText,
  },

  tile: {
    width: "100%",
    aspectRatio: DEFAULT_RATIO,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.light.backgroundSecondary,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  tileTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    fontWeight: "500",
    color: Colors.light.textSecondary,
  },

  output: { gap: Spacing.sm },
  imageWrap: { width: "100%" },
  image: {
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  rejected: {
    alignSelf: "flex-start",
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: Colors.light.textSecondary,
    backgroundColor: Colors.light.backgroundSecondary,
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },

  removed: {
    width: "100%",
    height: 96,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  removedTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    fontWeight: "500",
    color: Colors.light.textMuted,
  },

  generic: {
    width: "100%",
    height: 96,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.light.backgroundSecondary,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  genericTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: "600",
    color: Colors.light.textSecondary,
  },

  pill: {
    minWidth: 120,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: BorderRadius.full,
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: Colors.light.text,
  },
  pillGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  pillTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.buttonText,
  },
  pillGhostTxt: { color: Colors.light.text },
});
