import React, { useEffect, useMemo, useRef, useState } from "react";
import { resolveDeckLook } from "../../shared/deckLooks";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
} from "react-native";
import { ScrollView as GestureScrollView } from "react-native-gesture-handler";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BrandStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import { haptics } from "../lib/haptics";
import {
  useCardEditor,
  useSaveOverrides,
  type CardEditorCard,
  type CardEditorLibraryItem,
  type CardOverrides,
} from "../hooks/use-card-editor";
import { useAthleteCard } from "../hooks/use-card";
import type { Card } from "../components/card-native/types";
import { CardMiniTile } from "../components/card/CardMiniTile";
import { DeckSpread, type SpreadCard } from "../components/card/DeckSpread";
import { CardEditorSheet } from "../components/card/CardEditorSheet";
import { Fonts, Colors, Brand, Spacing } from "../constants/theme";

// ─── Nomi Card editor — the athlete's control surface ──────────────────────────
// Warm APP chrome (cream/pink/Outfit) around a preview of her dark editorial card.
// Four interactions from the Fable mock: reorder the deck, add from library, pick
// a copy alternate, swap a photo. Edits are staged locally and sent as one
// CardOverrides PUT on Publish — the server applies them at serve time.

const MUTED = "#9C968D";

// Opened as a modal from the Brand screen's Edit (see client/components/brand/NomiCardHero.tsx),
// so back / publish are driven by the onBack / onPublishSuccess props, not the navigator.
type CardEditorNavProp = NativeStackNavigationProp<BrandStackParamList>;

// A badge ONLY when the athlete has TOUCHED a card — the auto-built deck is the default state of
// the world, so a badge always means "you did something here" (no more "Auto · Strategist" jargon).
function badgeFor(
  card: CardEditorCard,
  copyOverrides: Record<string, { text: string; pick?: number }>,
  imageOverrides: Record<string, string | { path: string; poster?: string }>,
  isAdded: boolean,
): "New" | "Edited" | null {
  if (isAdded) return "New";
  const hasCopy  = card.editable.some((f) => !!copyOverrides[`${card.id}.${f.field}`]);
  const hasImage = !!imageOverrides[card.id];
  return (hasCopy || hasImage) ? "Edited" : null;
}

export interface CardEditorScreenProps {
  /** Header title — "Edit your deck" (default). */
  title?: string;
  /** Back chevron / discard-changes flow. Shown as a modal from the Brand screen's Edit, so this
   *  closes the modal instead of a navigator pop; defaults to navigation.goBack(). */
  onBack?: () => void;
  /** Called on a successful Publish — closes the modal; defaults to navigation.goBack(). */
  onPublishSuccess?: () => void;
}

export function CardEditorScreen({ title, onBack, onPublishSuccess }: CardEditorScreenProps = {}) {
  const navigation = useNavigation<CardEditorNavProp>();
  const { athlete } = useAuth();
  const athleteId   = athlete?.id;

  // brandId-tailored editing is out of scope this phase — always the generic deck.
  const brandId = 0;

  const { deck, library, cards, overrides, imagePool, isLoading } = useCardEditor(athleteId, brandId);
  const saveOverrides = useSaveOverrides(athleteId, brandId);

  // The real, typed card data (same source the native deck renders) — powers the mini-tiles'
  // "one real datum, huge" look. Same query cache as the Brand screen, so no extra request.
  const { kit } = useAthleteCard(athleteId);
  const previewTheme = resolveDeckLook(kit?.tokens?.theme);   // render the sheet preview in the athlete's chosen look
  const richById = useMemo(() => {
    const map: Record<string, Card> = {};
    kit?.cards?.forEach((c) => { map[c.id] = c; });
    return map;
  }, [kit]);

  const cardsById = useMemo(() => {
    const map: Record<string, CardEditorCard> = {};
    cards.forEach((c) => { map[c.id] = c; });
    return map;
  }, [cards]);

  // ── Staged edits — seeded once from the loaded deck/overrides, then owned locally ──
  const [deckIds, setDeckIds]           = useState<string[]>([]);
  const [copyOverrides, setCopyOverrides]   = useState<Record<string, { text: string; pick?: number }>>({});
  const [imageOverrides, setImageOverrides] = useState<Record<string, string | { path: string; poster?: string }>>({});

  const seededRef          = useRef(false);
  const initialDeckRef     = useRef<string[]>([]);
  const originalOverridesRef = useRef<CardOverrides>({});

  useEffect(() => {
    if (isLoading || seededRef.current) return;
    seededRef.current = true;
    initialDeckRef.current = deck;
    originalOverridesRef.current = overrides;
    setDeckIds(deck);
    setCopyOverrides(overrides.copy ?? {});
    setImageOverrides(overrides.images ?? {});
  }, [isLoading, deck, overrides]);

  const coverId = initialDeckRef.current[0];

  const hiddenIds = initialDeckRef.current.filter((id) => id !== coverId && !deckIds.includes(id));
  const hiddenCards = hiddenIds.map((id) => cardsById[id]).filter((c): c is CardEditorCard => !!c);

  const addedIdSet = useMemo(
    () => new Set(deckIds.filter((id) => !initialDeckRef.current.includes(id))),
    [deckIds],
  );

  const libraryForSheet = library.filter((item) => !deckIds.includes(item.id));

  // ── Dirty check — compares staged state against what was loaded ──
  const isDirty = useMemo(() => {
    if (!seededRef.current) return false;
    if (JSON.stringify(deckIds) !== JSON.stringify(initialDeckRef.current)) return true;
    if (JSON.stringify(copyOverrides) !== JSON.stringify(originalOverridesRef.current.copy ?? {})) return true;
    if (JSON.stringify(imageOverrides) !== JSON.stringify(originalOverridesRef.current.images ?? {})) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckIds, copyOverrides, imageOverrides]);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [editingId, setEditingId]     = useState<string | null>(null);   // card open in the consolidated editor

  function removeCard(cardId: string) {
    if (cardId === coverId) return;
    setDeckIds((prev) => prev.filter((id) => id !== cardId));
  }
  function restoreCard(cardId: string) {
    setDeckIds((prev) => (prev.includes(cardId) ? prev : [...prev, cardId]));
  }
  function addFromLibrary(cardId: string) {
    setDeckIds((prev) => (prev.includes(cardId) ? prev : [...prev, cardId]));
    setLibraryOpen(false);
  }
  function resetCard(cardId: string) {
    const card = cardsById[cardId];
    setCopyOverrides((prev) => {
      const next = { ...prev };
      card?.editable.forEach((f) => { delete next[`${cardId}.${f.field}`]; });
      return next;
    });
    setImageOverrides((prev) => {
      const next = { ...prev };
      delete next[cardId];
      return next;
    });
  }
  function resetAll() {
    setDeckIds(initialDeckRef.current);
    setCopyOverrides(originalOverridesRef.current.copy ?? {});
    setImageOverrides(originalOverridesRef.current.images ?? {});
  }

  function buildPayload(): CardOverrides {
    const removed = initialDeckRef.current.filter((id) => id !== coverId && !deckIds.includes(id));
    const added   = deckIds.filter((id) => !initialDeckRef.current.includes(id));
    return { order: deckIds, removed, added, copy: copyOverrides, images: imageOverrides };
  }

  function handlePublish() {
    if (!isDirty || saveOverrides.isPending) return;
    saveOverrides.mutate(buildPayload(), {
      onSuccess: () => (onPublishSuccess ?? navigation.goBack)(),
      onError:   () => Alert.alert("Couldn't publish", "Please try again in a moment."),
    });
  }

  function handleBack() {
    const close = onBack ?? (() => navigation.goBack());
    if (!isDirty) { close(); return; }
    Alert.alert("Discard changes?", "You have unpublished edits — leaving now won't save them.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: close },
    ]);
  }

  const visibleCount = deckIds.length;

  // The ordered deck → spread tiles (cover pinned first, each with its real card data + badge).
  const spreadCards: SpreadCard[] = deckIds
    .map((id): SpreadCard | null => {
      const card = cardsById[id];
      if (!card) return null;
      return {
        id,
        type:  card.type,
        title: card.title,
        image: card.image,
        rich:  richById[id],
        locked: id === coverId,
        badge: badgeFor(card, copyOverrides, imageOverrides, addedIdSet.has(id)),
      };
    })
    .filter((c): c is SpreadCard => c !== null);

  // The card open in the consolidated editor + its currently-staged copy (keyed by field).
  const editingCard = editingId ? cardsById[editingId] : undefined;
  // Prev/next walk the visible deck order, so the sheet can step card→card without closing.
  const editIndex = editingId ? deckIds.indexOf(editingId) : -1;
  const stepEditing = (delta: number) => {
    const next = editIndex >= 0 ? deckIds[editIndex + delta] : undefined;
    if (next) setEditingId(next);
  };
  const editingCopy: Record<string, { text: string; pick?: number }> = {};
  if (editingCard) {
    editingCard.editable.forEach((f) => {
      const v = copyOverrides[`${editingCard.id}.${f.field}`];
      if (v) editingCopy[f.field] = v;
    });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.light.backgroundRoot} />

      <View style={styles.header}>
        <Pressable hitSlop={8} style={styles.headerSide} onPress={handleBack} accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={MUTED} />
        </Pressable>
        <Text style={styles.screenTitle}>{title ?? "Edit your deck"}</Text>
        <Pressable
          hitSlop={8}
          style={[styles.publishBtn, (!isDirty || saveOverrides.isPending) && styles.publishBtnDisabled]}
          onPress={() => { haptics.press(); handlePublish(); }}
          disabled={!isDirty || saveOverrides.isPending}
        >
          {saveOverrides.isPending
            ? <ActivityIndicator size="small" color="#FFFFFF" />
            : <Text style={styles.publishBtnText}>Publish</Text>}
        </Pressable>
      </View>

      <View style={styles.subhead}>
        <Text style={styles.subheadText}>{visibleCount} card{visibleCount === 1 ? "" : "s"} · hold &amp; drag to reorder</Text>
        {isDirty && (
          <Pressable onPress={resetAll} hitSlop={6}>
            <Text style={styles.subheadHint}>Reset all</Text>
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.loading}><ActivityIndicator color={Colors.light.primary} /></View>
      ) : (
        <GestureScrollView
          style={styles.page}
          contentContainerStyle={styles.pageContent}
          showsVerticalScrollIndicator={false}
        >
          {/* The spread — the whole deck as mini-cards, long-press &amp; drag to reorder. */}
          <DeckSpread
            cards={spreadCards}
            onReorder={setDeckIds}
            onTapCard={setEditingId}
            onAdd={() => setLibraryOpen(true)}
          />

          {hiddenCards.length > 0 && (
            <View style={styles.hiddenBlock}>
              <Text style={styles.hiddenEyebrow}>Hidden for now · tap to bring one back</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hiddenScroll}>
                {hiddenCards.map((c) => (
                  <Pressable key={c.id} style={styles.hiddenTile} onPress={() => restoreCard(c.id)}>
                    <View style={styles.hiddenTileInner}>
                      <CardMiniTile rich={richById[c.id]} type={c.type} title={c.title} image={c.image} />
                      <View style={styles.hiddenDim} pointerEvents="none" />
                      <View style={styles.showChip}><Text style={styles.showChipText}>Show</Text></View>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          <Text style={styles.footnote}>
            <Text style={styles.footnoteBold}>7–9 cards is the sweet spot</Text> — brands actually finish those.
          </Text>
        </GestureScrollView>
      )}

      {libraryOpen && (
        <LibrarySheet
          library={libraryForSheet}
          onAdd={addFromLibrary}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {editingCard && (
        <CardEditorSheet
          card={editingCard}
          theme={previewTheme}
          onPrev={editIndex > 0 ? () => stepEditing(-1) : undefined}
          onNext={editIndex >= 0 && editIndex < deckIds.length - 1 ? () => stepEditing(1) : undefined}
          position={{ index: editIndex, total: deckIds.length }}
          rich={richById[editingCard.id]}
          imagePool={imagePool}
          copyByField={editingCopy}
          imageOverride={imageOverrides[editingCard.id]}
          isCover={editingCard.id === coverId}
          hasEdits={
            editingCard.editable.some((f) => !!copyOverrides[`${editingCard.id}.${f.field}`]) ||
            !!imageOverrides[editingCard.id]
          }
          onSetCopy={(field, val) =>
            setCopyOverrides((prev) => {
              const next = { ...prev };
              const key = `${editingCard.id}.${field}`;
              if (val === null) delete next[key];
              else next[key] = val;
              return next;
            })
          }
          onSetImage={(gcs) => setImageOverrides((prev) => ({ ...prev, [editingCard.id]: gcs }))}
          onReset={() => resetCard(editingCard.id)}
          onHide={() => { removeCard(editingCard.id); setEditingId(null); }}
          onClose={() => setEditingId(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Add-from-library sheet ─────────────────────────────────────────────────────

function LibrarySheet({
  library, onAdd, onClose,
}: { library: CardEditorLibraryItem[]; onAdd: (id: string) => void; onClose: () => void }) {
  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetContainer}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} />
        <View style={styles.librarySheet}>
          <View style={styles.handle} />
          <View style={styles.libraryHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.libraryTitle}>Add a card</Text>
              <Text style={styles.librarySub}>Every card fills itself in from your verified data — you edit the words and photos after.</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color={MUTED} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.libraryScroll} showsVerticalScrollIndicator={false}>
            {library.length === 0 ? (
              <View style={styles.libraryEmpty}>
                <Feather name="check-circle" size={20} color="#C5BFB8" />
                <Text style={styles.libraryEmptyText}>Everything Mila's built for you is already in your deck.</Text>
              </View>
            ) : (
              <View style={styles.libraryGrid}>
                {library.map((item) => (
                  <Pressable key={item.id} style={styles.libTile} onPress={() => onAdd(item.id)}>
                    <View style={styles.libTilePreview}>
                      <CardMiniTile type={item.type} title={item.title} image={null} />
                    </View>
                    <Text style={styles.libTileTitle} numberOfLines={1}>{item.title}</Text>
                    <View style={styles.libTileAddBadge}>
                      <Text style={styles.libTileAddBadgeText}>Add</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },

  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: Spacing.xl, paddingTop: 14, paddingBottom: Spacing.sm, gap: Spacing.sm,
  },
  headerSide:  { minWidth: 32, alignItems: "flex-start" },
  screenTitle: { flex: 1, textAlign: "center", fontFamily: Fonts.headingSemiBold, fontSize: 17, color: Colors.light.text },

  publishBtn: {
    backgroundColor: Colors.light.primary, borderRadius: 999,
    paddingHorizontal: 16, paddingVertical: 8, minWidth: 74, alignItems: "center", justifyContent: "center",
  },
  publishBtnDisabled: { opacity: 0.4 },
  publishBtnText: { fontFamily: Fonts.bodyBold, fontSize: 13.5, color: "#FFFFFF" },

  subhead: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm,
  },
  subheadText: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: MUTED },
  subheadHint: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.primary },

  loading: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── The spread page (grid lives in DeckSpread) ──
  page:        { flex: 1 },
  pageContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: Spacing.lg, gap: 16 },

  // Hidden shelf
  hiddenBlock:     { backgroundColor: Colors.light.backgroundDefault, borderRadius: 18, padding: 12, gap: 10 },
  hiddenEyebrow:   { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: MUTED },
  hiddenScroll:    { gap: 8, paddingRight: 4 },
  hiddenTile:      { width: 74 },
  hiddenTileInner: { width: 74, height: 110, borderRadius: 11, overflow: "hidden", backgroundColor: Brand.heroBg },
  hiddenDim:       { ...StyleSheet.absoluteFill, backgroundColor: "rgba(255,255,255,0.34)" },
  showChip:        { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: Colors.light.primary, paddingVertical: 5, alignItems: "center" },
  showChipText:    { fontFamily: Fonts.bodyBold, fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "#FFFFFF" },

  footnote:     { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: MUTED, textAlign: "center", paddingHorizontal: 10 },
  footnoteBold: { fontFamily: Fonts.bodySemiBold, color: Colors.light.textSecondary },

  // Sheets (shared)
  sheetContainer: { flex: 1, justifyContent: "flex-end" },
  sheetBackdrop:  { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,34,0.4)" },
  handle: { width: 40, height: 4.5, backgroundColor: Colors.light.border, borderRadius: 3, alignSelf: "center", marginBottom: Spacing.md },

  // Library sheet
  librarySheet: {
    backgroundColor: Colors.light.backgroundRoot, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingTop: 10, maxHeight: "86%",
  },
  libraryHeader: { flexDirection: "row", gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm },
  libraryTitle: { fontFamily: Fonts.heading, fontSize: 18, color: Colors.light.text, letterSpacing: -0.2 },
  librarySub:   { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: MUTED, marginTop: 4 },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center",
  },
  libraryScroll: { paddingHorizontal: Spacing.xl, paddingBottom: 28, paddingTop: 8 },
  libraryEmpty: { alignItems: "center", gap: 10, paddingVertical: 30 },
  libraryEmptyText: { fontFamily: Fonts.body, fontSize: 13, color: MUTED, textAlign: "center", lineHeight: 19 },
  libraryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  libTile: {
    width: "47%", backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 20, padding: 10, gap: 8,
  },
  libTilePreview: {
    height: 96, borderRadius: 12, overflow: "hidden", backgroundColor: Brand.heroBg,
  },
  libTileTitle: { fontFamily: Fonts.bodyBold, fontSize: 12.5, color: Colors.light.text },
  libTileAddBadge: {
    position: "absolute", top: 16, right: 16, backgroundColor: Colors.light.primary,
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4,
  },
  libTileAddBadgeText: { fontFamily: Fonts.bodyBold, fontSize: 9, letterSpacing: 0.4, color: "#FFFFFF" },
});
