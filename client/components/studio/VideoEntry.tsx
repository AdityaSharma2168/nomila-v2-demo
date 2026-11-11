/**
 * VideoEntry — ONE VIDEO, drawn.
 *
 * ─── SOURCE-AGNOSTIC, ON PURPOSE ────────────────────────────────────────────────────────────────
 *
 * ⚠️ It renders a VIDEO, not "the output of a generation job". A clip she uploaded and a clip Veo
 * made are the same entry here and play through the same player; the only thing this file is
 * given is a `VideoEntryView`, which by construction has no idea where its clips came from
 * (screens/studio/videoEntryLogic.ts — the generation job is one adapter among the pipelines
 * coming, not the shape). Nothing below may start branching on origin.
 *
 * ─── TAB-AGNOSTIC, ALSO ON PURPOSE ──────────────────────────────────────────────────────────────
 *
 * It takes a `VideoEntryView` and two callbacks and knows nothing else — not the tab it is mounted
 * in, not navigation, not the watch. The provisional Video tab is an isolation surface built to be
 * thrown away; the real home is the existing content surface (MadeShelf / ThreadCards, which
 * already carry non-IMAGE branches, and `listStudioContent` already returns VIDEO rows). Moving
 * this there must be a RE-MOUNT, not a rewrite, which is only true if nothing here reaches for the
 * tab. Recorded as a V7-era task.
 *
 * All the deciding is in screens/studio/videoEntryLogic.ts, pinned by pure tests. This file draws.
 *
 * DESIGN.md: cards at radius `lg`; pills at least 120px; no blur anywhere; motion is reanimated;
 * icons are Feather, never emoji; every weight is paired with its Outfit family (iOS ignores
 * `fontWeight` alone).
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { HapticPressable } from "../HapticPressable";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import type {
  VideoEntryPhase,
  VideoEntryView,
} from "../../screens/studio/videoEntryLogic";
import { ClipMissing, ClipPlayer } from "./ClipPlayer";
import { OutputGateNotice } from "./OutputGateNotice";

/** Feather names only. A phase is never an emoji — DESIGN.md. */
const ICON: Record<VideoEntryPhase, keyof typeof Feather.glyphMap> = {
  queued: "clock",
  working: "zap",
  ready: "check-circle",
  failed: "alert-circle",
  unknown: "help-circle",
};

export function VideoEntry({
  view,
  /**
   * A line under the phase — her words, a filename, an id. Whatever the surface mounting this has
   * that identifies the entry. Never model output, and never assumed to be a prompt.
   */
  caption,
  onOpenDetail,
  /**
   * Whether the clips play with sound. Defaulted to today's behaviour, so the generation surface
   * is unchanged; the stitch pipeline passes false because its last stage is music and a bed
   * nobody hears is a bed nobody reviews. See ClipPlayer.
   */
  muted = true,
  /**
   * The shape the clips are in, width ÷ height. Defaulted to portrait — what the generation engine
   * makes — so the generation surface is unchanged; the stitch result passes the shape SHE CHOSE,
   * because the engine conforms every input to it and so that is what came back.
   */
  ratio,
  gate,
}: {
  view: VideoEntryView;
  caption?: string | null;
  onOpenDetail?: (assetId: string) => void;
  muted?: boolean;
  ratio?: number;
  /**
   * quality-scrappy (ADI-QS-2): a surface that shows the output gate passes this — a clip the gate failed is then said
   * to have failed, and why, above the clip, with a fresh check WITH the fix when the surface can offer one. Absent,
   * the entry draws exactly as it always has (the Video tab's is carded, not built: docs/probes/quality-scrappy.md).
   */
  gate?: { onTryAgain?: (corrective: string[]) => void };
}) {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Phase view={view} />
      </View>

      {caption ? (
        <Text style={styles.caption} numberOfLines={3}>
          {caption}
        </Text>
      ) : null}

      {view.clips.map((c) =>
        c.removed || !c.uri ? (
          <ClipMissing key={c.assetId} />
        ) : (
          <Animated.View
            key={c.assetId}
            entering={FadeIn.duration(240)}
            style={styles.clip}
          >
            {gate && c.gate ? (
              <OutputGateNotice
                headline={c.gate.headline}
                lines={c.gate.lines}
                onTryAgain={
                  gate.onTryAgain
                    ? () => gate.onTryAgain!(c.gate!.corrective)
                    : undefined
                }
              />
            ) : null}
            <ClipPlayer uri={c.uri} muted={muted} ratio={ratio} />
            {c.rejected ? <Text style={styles.rejected}>Rejected</Text> : null}
            {onOpenDetail ? (
              <HapticPressable
                style={styles.pill}
                onPress={() => onOpenDetail(c.assetId)}
                accessibilityRole="button"
                accessibilityLabel="Open this clip's details"
              >
                <Feather
                  name="info"
                  size={14}
                  color={Colors.light.textSecondary}
                />
                <Text style={styles.pillTxt}>Details</Text>
              </HapticPressable>
            ) : null}
          </Animated.View>
        ),
      )}
    </View>
  );
}

/**
 * The state line. `working` pulses; an ended run does not.
 *
 * ⚠️ QUEUED AND RUNNING ARE DRAWN DIFFERENTLY, which is the whole point of the surface. The
 * thread's LoadingTile has no input but its own animation — right for an image, which is already
 * generated by the time the tile renders, and useless for a clip a runner picks up ~63 s later.
 * A `queued` that follows a `running` is the server's reaper handing the job on with the operation
 * handle intact: still working, still paid for, not a regression.
 */
function Phase({ view }: { view: VideoEntryView }) {
  const pulse = useSharedValue(1);
  React.useEffect(() => {
    pulse.value = view.working
      ? withRepeat(withTiming(0.55, { duration: 900 }), -1, true)
      : withTiming(1, { duration: 120 });
  }, [pulse, view.working]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      style={[styles.phase, style]}
      accessibilityRole={view.working ? "progressbar" : "text"}
      accessibilityLabel={view.label}
    >
      <Feather
        name={ICON[view.phase]}
        size={16}
        color={Colors.light.textSecondary}
      />
      <Text style={styles.phaseTxt}>{view.label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  phase: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
  phaseTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 14,
    color: Colors.light.text,
  },
  caption: {
    fontFamily: Fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.textSecondary,
  },
  clip: { gap: Spacing.sm },
  rejected: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  pill: {
    minWidth: 120,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundDefault,
  },
  pillTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 13,
    color: Colors.light.textSecondary,
  },
});
