import React, { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Image,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  useAthleteBrands,
  useResolveBrand,
  type AthleteBrand,
} from "../../hooks/use-card";
import { Bold, Fonts, Colors, Spacing } from "../../constants/theme";

// ─── Brand picker (Spec 9 — per-brand cards) ───────────────────────────────────
// Two sources, one sheet:
//   1. "Brands you're talking to" — the athlete's PIPELINE brands (already in
//      deals/threads, already researched). Those with a pre-built card are "Ready".
//   2. Search → add a new brand → POST /brands/resolve (dedup + research). If it
//      comes back researching:true the ShareSheet shows "Researching [brand]…".
// Selecting a brand returns its { brandId, name } (+ researching) to the caller.

const ROSE_INK = "#C23577";

export interface PickedBrand {
  brandId:      number;
  name:         string;
  researching?: boolean;
}

interface BrandPickerProps {
  athleteId: string | undefined;
  onClose:   () => void;
  onSelect:  (brand: PickedBrand) => void;
}

function haptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS !== "web") Haptics.impactAsync(style).catch(() => {});
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The dark brand chip avatar — logo when we have one, initials on ink otherwise.
function BrandAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return <Image source={{ uri: logoUrl }} style={styles.avatarImg} resizeMode="cover" />;
  }
  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarInitials}>{initialsOf(name)}</Text>
    </View>
  );
}

function BrandRow({ brand, onPress }: { brand: AthleteBrand; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <BrandAvatar name={brand.name} logoUrl={brand.logoUrl} />
      <View style={styles.rowTx}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>{brand.name}</Text>
          {brand.hasTailoredCard && (
            <View style={styles.readyChip}>
              <Feather name="check" size={9} color="#1A9960" />
              <Text style={styles.readyChipText}>Ready</Text>
            </View>
          )}
        </View>
        {(brand.category || brand.tier) && (
          <View style={styles.chipRow}>
            {!!brand.category && (
              <View style={styles.metaChip}>
                <Text style={styles.metaChipText} numberOfLines={1}>{brand.category}</Text>
              </View>
            )}
            {!!brand.tier && (
              <View style={[styles.metaChip, styles.tierChip]}>
                <Text style={[styles.metaChipText, styles.tierChipText]} numberOfLines={1}>
                  {brand.tier}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      <Feather name="chevron-right" size={18} color="#C5BFB8" />
    </Pressable>
  );
}

export function BrandPicker({ athleteId, onClose, onSelect }: BrandPickerProps) {
  const { brands, isLoading } = useAthleteBrands(athleteId);
  const resolveBrand = useResolveBrand();

  const [query, setQuery] = useState("");

  const q = query.trim();
  const filtered = useMemo(() => {
    if (!q) return brands;
    const needle = q.toLowerCase();
    return brands.filter((b) => b.name.toLowerCase().includes(needle));
  }, [brands, q]);

  // Show "Add …" only when the typed name isn't already an exact pipeline brand.
  const exactMatch = useMemo(
    () => brands.some((b) => b.name.trim().toLowerCase() === q.toLowerCase()),
    [brands, q],
  );
  const canAdd = q.length >= 2 && !exactMatch;

  function pick(brand: PickedBrand) {
    haptic(Haptics.ImpactFeedbackStyle.Medium);
    onSelect(brand);
  }

  function addNew() {
    if (!canAdd || resolveBrand.isPending) return;
    haptic();
    resolveBrand.mutate(
      { name: q },
      {
        onSuccess: (res) =>
          pick({ brandId: res.brandId, name: res.name, researching: res.researching }),
      },
    );
  }

  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Tailor for a brand</Text>
              <Text style={styles.subtitle}>Pick who you're pitching — the card reframes for them.</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="#9C968D" />
            </Pressable>
          </View>

          {/* Search field */}
          <View style={styles.searchWrap}>
            <View style={styles.searchPill}>
              <Feather name="search" size={16} color="#9C968D" />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search brands, or add a new one"
                placeholderTextColor="#C5BFB8"
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={addNew}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery("")} hitSlop={8}>
                  <Feather name="x-circle" size={16} color="#C5BFB8" />
                </Pressable>
              )}
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Section 1 — pipeline brands */}
            <View style={styles.block}>
              <Text style={styles.eyebrow}>Brands you're talking to</Text>

              {isLoading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={Colors.light.primary} />
                  <Text style={styles.loadingText}>Finding your brands…</Text>
                </View>
              ) : filtered.length > 0 ? (
                filtered.map((b) => (
                  <BrandRow key={b.brandId} brand={b} onPress={() => pick({ brandId: b.brandId, name: b.name })} />
                ))
              ) : (
                <Text style={styles.emptyText}>
                  {q
                    ? `No brand in your pipeline matches "${q}".`
                    : "No brands in your pipeline yet — search to add one."}
                </Text>
              )}
            </View>

            {/* Section 2 — add a new brand */}
            {canAdd && (
              <View style={styles.block}>
                <Text style={styles.eyebrow}>Not in your pipeline?</Text>
                <Pressable
                  style={[styles.addRow, resolveBrand.isPending && styles.addRowBusy]}
                  onPress={addNew}
                  disabled={resolveBrand.isPending}
                >
                  <View style={styles.addIco}>
                    {resolveBrand.isPending
                      ? <ActivityIndicator size="small" color={Colors.light.primary} />
                      : <Feather name="plus" size={18} color={Colors.light.primary} />}
                  </View>
                  <View style={styles.rowTx}>
                    <Text style={styles.addName} numberOfLines={1}>Add "{q}"</Text>
                    <Text style={styles.addSub}>
                      {resolveBrand.isPending ? "Looking them up…" : "We'll research them and tailor your card."}
                    </Text>
                  </View>
                </Pressable>
                {resolveBrand.isError && (
                  <Text style={styles.errorText}>Couldn't add that brand. Try again.</Text>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "flex-end" },
  backdrop:  { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,34,0.45)" },
  sheet: {
    backgroundColor:      Colors.light.card,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    paddingTop:           10,
    maxHeight:            "86%",
  },
  handle: {
    width: 40, height: 4.5, backgroundColor: Colors.light.border,
    borderRadius: 3, alignSelf: "center", marginBottom: Spacing.md,
  },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    justifyContent:    "space-between",
    gap:               Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingBottom:     Spacing.md,
  },
  headerText: { flex: 1, gap: 2 },
  title:      { fontFamily: Fonts.heading, fontSize: 18, color: Colors.light.text, letterSpacing: -0.3 },
  subtitle:   { fontFamily: Fonts.body, fontSize: 12, color: "#9C968D" },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },

  // Search
  searchWrap:  { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md },
  searchPill: {
    flexDirection: "row", alignItems: "center", gap: 9,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 999, borderWidth: 1, borderColor: Colors.light.borderLight,
    paddingHorizontal: 15, height: 46,
  },
  searchInput: { flex: 1, fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text, padding: 0 },

  // Scroll
  scroll:        { flexGrow: 0 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 28, gap: Spacing.lg },

  block:   { gap: 8 },
  eyebrow: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#9C968D",
    letterSpacing: 0.8, textTransform: "uppercase",
  },

  // Brand row
  row: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           12,
    borderWidth:   1.5,
    borderColor:   Colors.light.border,
    borderRadius:  18,
    backgroundColor: "#FFFFFF",
    padding:       12,
  },
  rowTx:  { flex: 1, gap: 4, minWidth: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { flex: 0, flexShrink: 1, fontFamily: Fonts.bodyBold, fontSize: 15, color: Colors.light.text },

  // Avatar
  avatarImg: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: Colors.light.backgroundDefault,
  },
  avatarFallback: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: "#0D0B08",
    alignItems: "center", justifyContent: "center",
  },
  avatarInitials: { fontFamily: Fonts.bodyBold, fontSize: 13, color: "#F2E7CE" },

  // Ready badge
  readyChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "#E7F4EC", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2,
  },
  readyChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 10, color: "#1A9960" },

  // Meta chips (category / tier)
  chipRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  metaChip: {
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
  },
  metaChipText: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: Colors.light.textSecondary },
  // A tier is a category word, so a dark chip (DESIGN.md Chip "dark"): never a ring colour (one look, 23 Oct 2026).
  tierChip:     { backgroundColor: Bold.ink },
  tierChipText: { color: Bold.onDark, letterSpacing: 0.3, textTransform: "uppercase" },

  // Add-new row
  addRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           12,
    borderWidth:   1.5,
    borderColor:   Colors.light.primary,
    borderRadius:  18,
    backgroundColor: "#FFF9FC",
    padding:       12,
  },
  addRowBusy: { opacity: 0.7 },
  addIco: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  addName: { fontFamily: Fonts.bodyBold, fontSize: 15, color: Colors.light.primary },
  addSub:  { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textSecondary },

  // States
  loadingRow:  { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 10 },
  loadingText: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textSecondary },
  emptyText:   { fontFamily: Fonts.body, fontSize: 13, lineHeight: 19, color: Colors.light.textSecondary, paddingVertical: 4 },
  errorText:   { fontFamily: Fonts.bodyMedium, fontSize: 12, color: ROSE_INK },
});
