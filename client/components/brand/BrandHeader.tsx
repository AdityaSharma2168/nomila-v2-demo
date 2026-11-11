// The top of the Brand tab: who this is (name + identity line from the record) and the score
// chip that opens the Score screen. One header for every tab under Brand, so the athlete always
// knows whose brand they're looking at — the agency cover page. Tokens only; no literals.
//
// The Brand stack is pushed above the tabs (no top bar, no Me entry here): her avatar sits at the left of
// the identity block, nothing is pressable, and `onBack` draws the chevron that gets her back.

import React from "react";
import { View, Text, Pressable, StyleSheet, Image } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing } from "../../constants/theme";

const C = Colors.light;

/** The tier dot: ink for a known tier, grey otherwise. Never a ring colour — those mean a part of the M.I.A. score
 * (one look, 23 Oct 2026). */
export function getTierColor(tier: string | null | undefined): string {
  switch ((tier ?? "").toLowerCase()) {
    case "icon":
    case "elite":
    case "established":
    case "rising":      return C.text;
    default:            return C.textQuiet;
  }
}

export function BrandHeader({ name, identityLine, displayScore, tier, photoUrl, onScore, onRefresh, refreshing, onBack }: {
  name:          string | null;
  identityLine:  string | null;
  displayScore:  number | null;
  tier:          string | null;
  photoUrl?:     string | null;
  onScore:       () => void;
  onRefresh?:    () => void;
  refreshing?:   boolean;
  /** Set when the Brand stack is pushed above the tabs (the shell): a back chevron at the left. */
  onBack?:       () => void;
}) {
  return (
    <View style={styles.wrap}>
      {onBack ? (
        <Pressable hitSlop={10} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={24} color={C.text} />
        </Pressable>
      ) : null}
      <View style={styles.identity}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarEmpty]}>
            <Text style={styles.avatarInitial}>{(name ?? "?").slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{name ?? "Your brand"}</Text>
          <Text style={styles.line} numberOfLines={1}>{identityLine ?? "Mila is still putting your line together"}</Text>
        </View>
      </View>
      <View style={styles.right}>
        <Pressable style={styles.scoreChip} onPress={onScore} accessibilityRole="button" accessibilityLabel={displayScore != null ? `Score ${displayScore}, ${tier ?? ""}` : "Score"}>
          {displayScore != null ? (
            <>
              <View style={[styles.scoreDot, { backgroundColor: getTierColor(tier) }]} />
              <Text style={styles.scoreValue}>{displayScore}</Text>
            </>
          ) : (
            <Text style={styles.scorePending}>Score</Text>
          )}
          <Feather name="chevron-right" size={13} color={C.textQuiet} />
        </Pressable>
        {onRefresh && (
          <Pressable hitSlop={8} onPress={onRefresh} disabled={refreshing} accessibilityLabel="Refresh">
            <Feather name="refresh-cw" size={16} color={refreshing ? C.primary : C.textQuiet} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:          { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingTop: 14, paddingBottom: Spacing.sm },
  identity:      { flex: 1, flexDirection: "row", alignItems: "center", gap: Spacing.md },
  avatar:        { width: 40, height: 40, borderRadius: 20, backgroundColor: C.backgroundTertiary },
  avatarEmpty:   { alignItems: "center", justifyContent: "center" },
  avatarInitial: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: C.textSecondary },
  name:          { fontFamily: Fonts.headingSemiBold, fontSize: 18, color: C.text },
  line:          { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, marginTop: 1 },
  right:         { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  scoreChip:     { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.card, borderRadius: 999, height: 32, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border },
  scoreDot:      { width: 8, height: 8, borderRadius: 4 },
  scoreValue:    { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: C.text, fontVariant: ["tabular-nums"] },
  scorePending:  { fontFamily: Fonts.bodyMedium, fontSize: 13, color: C.textQuiet },
});
