import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Platform, Modal } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BrandStackParamList } from "../../navigation/MainTabNavigator";
import { Fonts, Colors, Brand, Spacing, BorderRadius, Bold } from "../../constants/theme";
import { useAuth } from "../../lib/auth-context";
import { useAthleteCard, useShares, useSaveCardTheme } from "../../hooks/use-card";
import { CardDeck } from "../card-native/CardDeck";
import { NATIVE_LOOKS } from "../card-native/looks";
import { DECK_LOOK_LABEL, DEFAULT_DECK_LOOK, resolveDeckLook, type DeckLook } from "../../../shared/deckLooks";
import { CardImmersiveOverlay } from "../card-native/CardImmersiveOverlay";
import { CardEditorScreen } from "../../screens/CardEditorScreen";
import { ShareSheet } from "../card/ShareSheet";
import type { PickedBrand } from "../card/BrandPicker";

// ─── v2 shell: the Brand screen IS the deck ────────────────────────────────────
// Per brand-swipe.html: the card swipes in place (native pager + edge-peek, already built
// in CardDeck), shell-owned progress segments right under it, then the action bar
// (quiet Edit · primary Share · quiet Signals). This supersedes the old tap-to-navigate
// poster — expand (⤢) now opens an in-place immersive overlay (Modal, not a push, see
// CardImmersiveOverlay), and Edit opens a bottom sheet scoped to the active card
// (see CardEditSheet) instead of pushing CardEditorScreen.

type BrandNavProp = NativeStackNavigationProp<BrandStackParamList, "BrandOverview">;

interface Props {
  athleteId: string | undefined;
  /** Cross-tab "Tailor & send" bridge (from OpportunitiesScreen → BrandOverview params) —
   *  pops the Share sheet pre-targeted at this brand. See screens/brand/BrandTabScreen.tsx. */
  initialShareBrand?: { brandId: number; brandName?: string };
  /** Called once the initial brand has been consumed, so BrandTabScreen can clear the route param
   *  and avoid re-opening the sheet on the next focus/re-render. */
  onConsumedInitialBrand?: () => void;
  /** New Brand tab: the third action opens the Deck screen (Signals lives there now) instead of
   *  pushing Signals directly. Absent → the legacy Signals button. */
  onOpenDeck?: () => void;
}

export function NomiCardHero({ athleteId, initialShareBrand, onConsumedInitialBrand, onOpenDeck }: Props) {
  const navigation = useNavigation<BrandNavProp>();
  const { athlete } = useAuth();
  const { kit }     = useAthleteCard(athleteId);
  const { totalOpens } = useShares(athleteId);
  const saveTheme   = useSaveCardTheme(athleteId);

  const [activeIndex, setActiveIndex] = useState(0);
  const [immersiveOpen, setImmersiveOpen] = useState(false);
  const [editOpen, setEditOpen]           = useState(false);
  const [shareOpen, setShareOpen]         = useState(false);
  const [shareBrand, setShareBrand]       = useState<PickedBrand | undefined>(undefined);
  const [look, setLook]                   = useState<DeckLook>(DEFAULT_DECK_LOOK);

  // Seed the switcher from the athlete's saved look once the kit arrives (kit.tokens.theme is set by
  // applyOverrides server-side). Sync once — after that the user's in-session pick owns the state.
  const seededLook = useRef(false);
  useEffect(() => {
    if (seededLook.current) return;
    const saved = kit?.tokens?.theme;
    if (saved) { setLook(resolveDeckLook(saved)); seededLook.current = true; }
  }, [kit?.tokens?.theme]);

  // Pick a look → reflect immediately + persist so it flows to the app + every share.
  function pickLook(next: DeckLook) {
    if (next === look) return;
    seededLook.current = true;   // the user has now chosen — don't let a later kit refetch override it
    setLook(next);
    saveTheme.mutate(next);
  }

  // Same query cache as CardDeck's own useAthleteCard — no extra request, just reading the
  // deck order so the shell can own progress + know which card id is active for Edit.
  const orderedIds = useMemo(() => {
    if (!kit) return [];
    return kit.deck?.length ? kit.deck : (kit.cards ?? []).map((c) => c.id);
  }, [kit]);
  const count = orderedIds.length;
  const clampedIndex = Math.min(activeIndex, Math.max(count - 1, 0));

  const athleteName = [athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ") || null;

  // ── Cross-tab bridge: OpportunitiesScreen "Tailor & send" lands here with a brand picked ──
  useEffect(() => {
    if (!initialShareBrand) return;
    setShareBrand({ brandId: initialShareBrand.brandId, name: initialShareBrand.brandName ?? "this brand" });
    setShareOpen(true);
    onConsumedInitialBrand?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShareBrand?.brandId]);

  function openShare() {
    setShareBrand(undefined);
    setShareOpen(true);
  }

  return (
    <View style={styles.zone}>
      {/* ── The deck — swipeable in place, edge-peek is the affordance ── */}
      <View style={styles.deckSlot}>
        <CardDeck
          athleteId={athleteId}
          activeIndex={clampedIndex}
          onIndexChange={setActiveIndex}
          showProgress={false}
          onShare={openShare}
          theme={look}
        />

        {/* Quiet expand affordance — the one control on the card face; opens the immersive view.
            Not an action (Edit/Share/Signals all live in the bar below) — just a door to fullscreen. */}
        <Pressable
          style={styles.expand}
          onPress={() => setImmersiveOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Expand full screen"
        >
          <Feather name="maximize-2" size={14} color={Bold.onDark} />
        </Pressable>
      </View>

      {/* ── Shell-owned progress — directly under the deck ── */}
      {count > 1 && (
        <View style={styles.progress} accessibilityLabel={`Card ${clampedIndex + 1} of ${count}`}>
          {orderedIds.map((id, i) => (
            <View key={id} style={styles.segTrack}>
              <View style={[styles.segFill, i <= clampedIndex && styles.segOn, i === clampedIndex && styles.segNow]} />
            </View>
          ))}
        </View>
      )}

      {/* ── Look switcher — the same card, in each finished look ── */}
      {NATIVE_LOOKS.length > 1 && (
        <View style={styles.lookRow}>
          <Text style={styles.lookLabel}>Look</Text>
          <View style={styles.lookPills}>
            {NATIVE_LOOKS.map((l) => (
              <Pressable key={l} style={[styles.lookPill, look === l && styles.lookPillOn]} onPress={() => pickLook(l)}>
                <Text style={[styles.lookPillText, look === l && styles.lookPillTextOn]}>{DECK_LOOK_LABEL[l]}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* ── Actions live here now — no expansion required to send or check reads ── */}
      <View style={styles.actionBar}>
        <Pressable style={styles.quiet} onPress={() => setEditOpen(true)}>
          <View style={styles.quietIcon}>
            <Feather name="edit-2" size={18} color={Colors.light.text} />
          </View>
          <Text style={styles.quietLabel}>Edit</Text>
        </Pressable>

        <Pressable style={styles.shareBtn} onPress={openShare}>
          <Feather name="send" size={16} color="#FFFFFF" />
          <Text style={styles.shareBtnText}>Share</Text>
        </Pressable>

        <Pressable style={styles.quiet} onPress={() => (onOpenDeck ? onOpenDeck() : navigation.navigate("Signals"))}>
          <View style={styles.quietIcon}>
            <Feather name={onOpenDeck ? "layers" : "bar-chart-2"} size={18} color={Colors.light.text} />
            {totalOpens > 0 && (
              <View style={styles.pip}>
                <Text style={styles.pipText}>{totalOpens}</Text>
              </View>
            )}
          </View>
          <Text style={styles.quietLabel}>{onOpenDeck ? "Deck" : "Signals"}</Text>
        </Pressable>
      </View>

      {/* Pitches strip — Phase 3 surface; placeholder only per this phase's scope */}
      <View style={styles.pitchesStrip}>
        <View style={styles.pitchesIcon}>
          <Feather name="send" size={14} color="#9C968D" />
        </View>
        <Text style={styles.pitchesText}>Brand cards — coming soon</Text>
      </View>

      {immersiveOpen && (
        <CardImmersiveOverlay
          athleteId={athleteId}
          activeIndex={clampedIndex}
          onIndexChange={setActiveIndex}
          onClose={() => setImmersiveOpen(false)}
          theme={look}
        />
      )}

      {editOpen && (
        <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={() => setEditOpen(false)}>
          <CardEditorScreen
            title="Edit your deck"
            onBack={() => setEditOpen(false)}
            onPublishSuccess={() => setEditOpen(false)}
          />
        </Modal>
      )}

      {shareOpen && (
        <ShareSheet
          athleteId={athleteId}
          athleteName={athleteName}
          lookLabel={DECK_LOOK_LABEL[look]}
          initialBrand={shareBrand}
          onClose={() => setShareOpen(false)}
          onViewSignals={() => { setShareOpen(false); navigation.navigate("Signals"); }}
        />
      )}
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  zone: {
    marginHorizontal: Spacing.xl,
    marginTop:        Spacing.md,
  },
  deckSlot: {
    width:           "100%",
    aspectRatio:      354 / 618,
    borderRadius:     BorderRadius.lg,
    overflow:         "hidden",
    backgroundColor:  Brand.heroBg,
    ...Platform.select({
      web: { boxShadow: "0px 28px 54px rgba(13,11,8,0.5)" },
      default: {
        shadowColor:   "#0D0B08",
        shadowOffset:  { width: 0, height: 20 },
        shadowOpacity: 0.45,
        shadowRadius:  22,
        elevation:     12,
      },
    }),
  },
  expand: {
    position:        "absolute",
    top:             14,
    right:           14,
    width:           30,
    height:          30,
    borderRadius:    15,
    borderWidth:     1,
    borderColor:     "rgba(255,255,255,0.28)",
    backgroundColor: "rgba(12,13,16,0.42)",
    alignItems:      "center",
    justifyContent:  "center",
    zIndex:          20,
  },
  // Shell-owned progress — same visual language as CardDeck's own (now shown here instead)
  progress: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           5,
    paddingTop:    12,
  },
  segTrack: {
    flex:            1,
    height:          3,
    borderRadius:    99,
    backgroundColor: Colors.light.border,
    overflow:        "hidden",
  },
  segFill: { flex: 1, borderRadius: 99, backgroundColor: "transparent" },
  segOn:   { backgroundColor: Colors.light.text, opacity: 0.7 },
  segNow:  { backgroundColor: Colors.light.primary, opacity: 1 },

  // Look switcher
  lookRow:   { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 12 },
  lookLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#9C968D" },
  lookPills: { flexDirection: "row", gap: 6, flex: 1 },
  lookPill: {
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.light.card,
  },
  lookPillOn:      { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  lookPillText:    { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.textSecondary },
  lookPillTextOn:  { color: "#FFFFFF" },

  // Action bar
  actionBar: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    paddingTop:     Spacing.md,
    gap:            Spacing.md,
  },
  quiet: { width: 60, alignItems: "center", gap: 4 },
  quietIcon: {
    width:           44,
    height:          44,
    borderRadius:    22,
    borderWidth:     1,
    borderColor:     Colors.light.border,
    backgroundColor: Colors.light.card,
    alignItems:      "center",
    justifyContent:  "center",
  },
  quietLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, color: Colors.light.textSecondary },
  pip: {
    position:          "absolute",
    top:               -3,
    right:             -6,
    backgroundColor:   Colors.light.primary,
    borderRadius:      999,
    borderWidth:       2,
    borderColor:       Colors.light.backgroundRoot,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  pipText: { fontFamily: Fonts.bodyBold, fontSize: 9.5, color: "#FFFFFF" },
  shareBtn: {
    flex:            1,
    height:          50,
    borderRadius:    999,
    backgroundColor: Colors.light.primary,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    ...Platform.select({
      web: { boxShadow: "0px 8px 18px rgba(200,50,90,0.4)" },
      default: {
        shadowColor:   Colors.light.primary,
        shadowOffset:  { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius:  9,
        elevation:     6,
      },
    }),
  },
  shareBtnText: { fontFamily: Fonts.bodySemiBold, fontSize: 15.5, color: "#FFFFFF" },

  // Pitches strip — placeholder only (Phase 3 builds the real Brand-cards surface)
  pitchesStrip: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              10,
    marginTop:        Spacing.md,
    padding:          12,
    borderRadius:     18,
    borderWidth:      1,
    borderColor:      Colors.light.border,
    backgroundColor:  Colors.light.card,
    opacity:          0.7,
  },
  pitchesIcon: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center",
  },
  pitchesText: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: "#9C968D" },
});
