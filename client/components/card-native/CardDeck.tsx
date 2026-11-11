/**
 * CardDeck — the real Nomi Card, native. Fetches the signed `MediaKitData` from
 * GET /api/card/:athleteId (client/hooks/use-card.ts → useAthleteCard) and renders the cards in
 * `deck` order as a horizontal pager. This is the drop-in replacement for the `<WebView>` that
 * used to render server/services/kitRenderer.ts's HTML — same data source, same card set, now
 * real RN views so per-card content can scroll and swipe never gets stolen by a button.
 *
 * ── The two founder bugs this fixes ──
 * 1. Per-card vertical scroll: each card type wraps its content in a ScrollView (see
 *    Chrome.tsx's `CardShell`) instead of a fixed-height absolutely-positioned block — tall
 *    cards (payments/story/achievements) scroll, they never clip.
 * 2. Swipe everywhere: the pager's Pan gesture only ACTIVATES after a clear horizontal drag
 *    (`activeOffsetX`) and fails fast on a vertical one (`failOffsetY`) — so a plain tap on the
 *    payments package buttons / Book button always reaches the Pressable first (the gesture
 *    never claims a touch that doesn't move), while a real horizontal drag started anywhere,
 *    including on top of a button, still pages the deck. Vertical drags fall through to each
 *    card's own ScrollView.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useAthleteCard } from "../../hooks/use-card";
import { T } from "./Chrome";
import type { Card } from "./types";
import { CardView } from "./looks";
import { NOMILA_LIGHT_TYPES } from "./nomila/Chrome";
import { resolveDeckLook } from "../../../shared/deckLooks";
import { CardErrorBoundary } from "./CardErrorBoundary";

const SWIPE_THRESHOLD_RATIO = 0.22;
const SWIPE_VELOCITY = 650;

export interface CardDeckProps {
  athleteId: string | undefined;
  /** brandId > 0 renders the brand-TAILORED deck (a pitch); omitted renders the generic card. */
  brandId?: number;
  /** false = static poster (first deck card only, no gesture/progress) — used where the deck
   *  is shown as a non-interactive picture rather than a mini-app. */
  interactive?: boolean;
  /** Controlled pagination (optional) — the shell can drive/observe which card is showing. */
  activeIndex?: number;
  onIndexChange?: (index: number) => void;
  /** Reports the deck's card count once the kit loads — lets a shell that owns its own
   *  progress UI (NomiCardHero, CardImmersiveOverlay) size its segments without re-deriving
   *  the deck order itself. Fires again whenever the count changes (e.g. athlete switch). */
  onCountChange?: (count: number) => void;
  /** Draw the built-in floating progress segments (top-left, absolute over the cards).
   *  Shells that render their OWN progress (shell-owned, per the v2 Brand-screen + immersive
   *  designs) pass false here to avoid doubling up. Defaults to true (legacy/standalone use). */
  showProgress?: boolean;
  /** Wired to the fit card's "Partner with…" CTA — defaults to a no-op if the shell doesn't pass one. */
  onShare?: () => void;
  /** Which look to render the cards in ("nomila" | "luxe" | "broadcast"). Falls back to the kit's own
   *  tokens.theme; a retired or unknown look renders in Nomila (see looks.tsx). */
  theme?: string;
}

export function CardDeck({
  athleteId, brandId, interactive = true, activeIndex, onIndexChange, onCountChange, showProgress = true, onShare, theme,
}: CardDeckProps) {
  const { kit, isLoading, isError } = useAthleteCard(athleteId, brandId);
  const activeTheme = resolveDeckLook(theme ?? kit?.tokens?.theme);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, []);

  const orderedCards = useMemo<Card[]>(() => {
    if (!kit) return [];
    const cards = kit.cards ?? [];                        // a partial kit may omit `cards` entirely
    const byId = new Map(cards.map((c) => [c.id, c]));
    const order = kit.deck?.length ? kit.deck : cards.map((c) => c.id);
    return order.map((id) => byId.get(id)).filter((c): c is Card => !!c);
  }, [kit]);

  const cardsToShow = interactive ? orderedCards : orderedCards.slice(0, 1);
  const count = cardsToShow.length;
  const firstName = kit?.identity?.name?.split(" ")[0] || "her";

  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  useEffect(() => { onCountChangeRef.current?.(count); }, [count]);

  const [internalIndex, setInternalIndex] = useState(0);
  const index = Math.min(activeIndex ?? internalIndex, Math.max(count - 1, 0));

  const commitIndex = useCallback((next: number) => {
    setInternalIndex(next);
    onIndexChange?.(next);
  }, [onIndexChange]);

  const pageWidth = size.width;
  const translateX = useSharedValue(0);
  const dragStart = useSharedValue(0);

  // Snap to the current index whenever it changes (swipe-committed, externally driven, or the
  // container was just measured) — also handles the deck shrinking (e.g. athlete switch).
  useEffect(() => {
    if (pageWidth > 0) translateX.value = withSpring(-index * pageWidth, { damping: 22, stiffness: 170 });
  }, [index, pageWidth, translateX]);

  const pan = Gesture.Pan()
    .enabled(interactive && count > 1)
    .activeOffsetX([-14, 14])
    .failOffsetY([-14, 14])
    .onStart(() => {
      dragStart.value = translateX.value;
    })
    .onUpdate((e) => {
      let next = dragStart.value + e.translationX;
      const min = -(count - 1) * pageWidth;
      // rubber-band past the first/last card
      if (next > 0) next = next * 0.3;
      if (next < min) next = min + (next - min) * 0.3;
      translateX.value = next;
    })
    .onEnd((e) => {
      const threshold = pageWidth * SWIPE_THRESHOLD_RATIO;
      let next = index;
      if ((e.translationX < -threshold || e.velocityX < -SWIPE_VELOCITY) && index < count - 1) next = index + 1;
      else if ((e.translationX > threshold || e.velocityX > SWIPE_VELOCITY) && index > 0) next = index - 1;
      translateX.value = withSpring(-next * pageWidth, { damping: 22, stiffness: 170 });
      if (next !== index) scheduleOnRN(commitIndex, next);
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  const showLoading = isLoading || !size.width;
  const showEmpty = !showLoading && (isError || !kit || count === 0);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {showLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" color="#9A9A98" />
        </View>
      ) : showEmpty ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Card not found.</Text>
        </View>
      ) : (
        <>
          {showProgress && interactive && count > 1 && (() => {
            // On the Nomila look's white cards the segments read in ink; on photos and dark cards, in white.
            const onLight = activeTheme === "nomila" && NOMILA_LIGHT_TYPES.has(cardsToShow[index]?.type ?? "");
            return (
              <View style={styles.progress} pointerEvents="none">
                {cardsToShow.map((card, i) => (
                  <View key={card.id} style={[styles.segTrack, onLight && styles.segTrackLight]}>
                    <View style={[styles.segFill, i <= index && (onLight ? styles.segOnLight : styles.segOn), i === index && activeTheme !== "nomila" && styles.segNow]} />
                  </View>
                ))}
              </View>
            );
          })()}
          <View style={styles.viewport}>
            <GestureDetector gesture={pan}>
              <Animated.View style={[styles.row, rowStyle, { width: count * pageWidth }]}>
                {cardsToShow.map((card, i) => (
                  <View key={card.id} style={{ width: pageWidth, height: size.height }}>
                    <CardErrorBoundary>
                      <CardView card={card} active={i === index} theme={activeTheme} firstName={firstName} onShare={onShare} />
                    </CardErrorBoundary>
                  </View>
                ))}
              </Animated.View>
            </GestureDetector>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Transparent: the looks draw their own rounded card grounds, so the screen shows at the corners.
  wrap: { flex: 1, backgroundColor: "transparent" },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  errorText: { fontSize: 13, color: "#9A9A98" },
  viewport: { flex: 1, overflow: "hidden" },
  row: { flexDirection: "row", flex: 1 },
  progress: {
    position: "absolute",
    top: 12,
    left: 14,
    right: 14,
    zIndex: 40,
    flexDirection: "row",
    gap: 5,
  },
  segTrack: {
    flex: 1,
    height: 3,
    borderRadius: 99,
    backgroundColor: "rgba(243,238,228,0.22)",
    overflow: "hidden",
  },
  segFill: { flex: 1, borderRadius: 99, backgroundColor: "transparent" },
  segOn: { backgroundColor: T.bone },
  segTrackLight: { backgroundColor: "rgba(14,14,14,0.12)" },
  segOnLight: { backgroundColor: "#0E0E0E" },
  segNow: { backgroundColor: T.cardinal },
});
