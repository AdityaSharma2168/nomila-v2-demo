/**
 * CardImmersiveOverlay — the card grows to full-screen. Per expand-immersive.html: NOT a nav
 * push (no separate screen/route) — a Modal that renders the same CardDeck large, with only a
 * hairline of chrome (a top bar: grab handle, ˅ close, count, progress). No action bar here by
 * design (README key decision #2) — Share/Edit/Signals stay on the Brand screen; this state is
 * for looking/showing.
 *
 * ── Why the close-drag lives on the top bar, not the whole card ──
 * The card body owns a HORIZONTAL page-gesture (CardDeck). A second, whole-card swipe-DOWN-to-close
 * gesture stacked on top of it made every swipe a coin-flip between "page" and "close" (the founder:
 * "have to try multiple times to swipe left/right"). So the close-drag is scoped to the top bar
 * only — the card body pages exactly like the collapsed Brand-screen deck (which works cleanly),
 * and you dismiss by pulling the handle down or tapping ˅. The top bar's paddingTop also clears the
 * status bar / notch so the card's own content never sits under the clock.
 */
import React, { useEffect } from "react";
import { Modal, View, Text, Pressable, StyleSheet, StatusBar } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CardDeck } from "./CardDeck";
import { useAthleteCard } from "../../hooks/use-card";
import { Brand, Fonts, Bold } from "../../constants/theme";

interface Props {
  athleteId:      string | undefined;
  activeIndex:    number;
  onIndexChange:  (index: number) => void;
  onClose:        () => void;
  theme?:         string;
}

const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 780;

export function CardImmersiveOverlay({ athleteId, activeIndex, onIndexChange, onClose, theme }: Props) {
  const insets = useSafeAreaInsets();
  // Same query key/cache as CardDeck's own useAthleteCard — no extra network request, just
  // reading the count for the shell-owned progress segments + "i / N" chip.
  const { kit } = useAthleteCard(athleteId);
  const count = kit?.deck?.length || kit?.cards?.length || 0;

  const translateY = useSharedValue(28);
  const opacity    = useSharedValue(0);

  useEffect(() => {
    translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
    opacity.value = withTiming(1, { duration: 160 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close-drag: scoped to the top bar only (see file header). Only a DOWNWARD drag past 8px
  // activates — a plain tap falls through to the ˅ button; an upward drag never closes.
  const dragStart = useSharedValue(0);
  const pan = Gesture.Pan()
    .activeOffsetY([-9999, 8])
    .onStart(() => { dragStart.value = translateY.value; })
    .onUpdate((e) => {
      translateY.value = Math.max(0, dragStart.value + e.translationY);
      opacity.value = Math.max(0.3, 1 - translateY.value / 420);
    })
    .onEnd((e) => {
      if (translateY.value > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        translateY.value = withTiming(700, { duration: 180 });
        opacity.value = withTiming(0, { duration: 180 }, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
        opacity.value = withTiming(1, { duration: 140 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        <Animated.View style={[styles.full, animatedStyle]}>
          {/* Top bar — clears the notch AND owns the close-drag. Nothing here competes with the
              card body's horizontal paging. */}
          <GestureDetector gesture={pan}>
            <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
              <View style={styles.handle} />
              <View style={styles.chromeRow}>
                <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12} accessibilityLabel="Close">
                  <Feather name="chevron-down" size={18} color={Bold.onDark} />
                </Pressable>
                {count > 0 && (
                  <View style={styles.count}>
                    <Text style={styles.countText}>{activeIndex + 1} / {count}</Text>
                  </View>
                )}
              </View>
              {count > 1 && (
                <View style={styles.progress}>
                  {Array.from({ length: count }).map((_, i) => (
                    <View key={i} style={[styles.seg, i === activeIndex && styles.segNow]} />
                  ))}
                </View>
              )}
            </View>
          </GestureDetector>

          {/* Card body — free for horizontal paging, same gesture as the collapsed deck. */}
          <View style={[styles.cardBody, { paddingBottom: insets.bottom }]}>
            <CardDeck
              athleteId={athleteId}
              activeIndex={activeIndex}
              onIndexChange={onIndexChange}
              showProgress={false}
              theme={theme}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Brand.heroBg },
  full:     { flex: 1 },
  topBar: {
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  handle: {
    width: 40, height: 4.5, borderRadius: 3, alignSelf: "center",
    backgroundColor: "rgba(255,255,255,0.32)", marginBottom: 12,
  },
  chromeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  closeBtn: {
    width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "rgba(255,255,255,0.26)",
    backgroundColor: "rgba(12,13,16,0.44)", alignItems: "center", justifyContent: "center",
  },
  count: {
    borderRadius: 99, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(12,13,16,0.44)", paddingHorizontal: 13, paddingVertical: 7,
  },
  countText: { fontFamily: Fonts.bodyBold, fontSize: 11, letterSpacing: 1.2, color: "rgba(255,255,255,0.75)" },
  progress: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 12 },
  seg:      { flex: 1, height: 2.5, borderRadius: 99, backgroundColor: "rgba(255,255,255,0.22)" },
  segNow:   { backgroundColor: Bold.onDark },
  cardBody: { flex: 1 },
});
