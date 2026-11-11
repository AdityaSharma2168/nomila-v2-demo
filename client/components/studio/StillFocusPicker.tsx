/**
 * StillFocusPicker — where a held photo's zoom, pan or punch heads: she taps the photo.
 *
 * The point leaves as FRACTIONS of the photo (storyboardLogic `focusFromTap`), MaskEditor's contract
 * and for its reason: the thumbnail is a stand-in for the original, so only a fraction survives the
 * trip to the server, which applies it to the upright photo (studio/video/still.ts). No point means
 * the server's framing prior — the upper middle, where she usually is; nothing detects her.
 */
import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useContainedStage } from "../../hooks/use-contained-stage";
import { focusFromTap } from "../../screens/studio/storyboardLogic";
import {
  BorderRadius,
  Brand,
  Colors,
  Fonts,
  Spacing,
} from "../../constants/theme";

const STAGE = 168;
const DOT = 18;

export function StillFocusPicker({
  imageUrl,
  focus,
  onFocus,
}: {
  imageUrl: string;
  focus: { x: number; y: number } | null;
  onFocus: (focus: { x: number; y: number } | null) => void;
}) {
  const { onLayout, drawn } = useContainedStage(imageUrl);
  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.stage}
        onLayout={onLayout}
        onPress={(e) => {
          const point = focusFromTap(
            { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY },
            drawn,
          );
          if (point) onFocus(point);
        }}
        accessibilityRole="button"
        accessibilityLabel="Tap the photo where the move should head"
      >
        <Image
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
        />
        {focus && drawn ? (
          <View
            pointerEvents="none"
            style={[
              styles.dot,
              {
                left: drawn.x + focus.x * drawn.w - DOT / 2,
                top: drawn.y + focus.y * drawn.h - DOT / 2,
              },
            ]}
          />
        ) : null}
      </Pressable>
      <View style={styles.side}>
        <Text style={styles.note}>
          {focus
            ? "Heading for the spot you tapped."
            : "Heading for the upper middle — where you usually are. Tap the photo to pick the spot."}
        </Text>
        {focus ? (
          <Pressable
            onPress={() => onFocus(null)}
            accessibilityRole="button"
            accessibilityLabel="Use the upper middle"
            style={styles.reset}
          >
            <Text style={styles.resetTxt}>Use the upper middle</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", gap: Spacing.md, alignItems: "flex-start" },
  stage: {
    width: STAGE,
    height: STAGE,
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    backgroundColor: Brand.heroBg,
  },
  dot: {
    position: "absolute",
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    borderColor: Colors.light.onHero,
    backgroundColor: Colors.light.primary,
  },
  side: { flex: 1, gap: Spacing.xs },
  note: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },
  reset: {
    alignSelf: "flex-start",
    minWidth: 120,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
    alignItems: "center",
  },
  resetTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
});
