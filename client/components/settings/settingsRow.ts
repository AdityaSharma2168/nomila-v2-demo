/**
 * settingsRow — the Settings screen's door / switch row (Classic layout, Your rates, Notifications): one shape, one
 * place. Same geometry as a section header.
 */
import { StyleSheet } from "react-native";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";

export const settingsRow = StyleSheet.create({
  row:      { flexDirection: "row", alignItems: "center", gap: Spacing.md, marginHorizontal: Spacing.xl, marginTop: Spacing.md, backgroundColor: Colors.light.card, borderRadius: BorderRadius.xl, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  iconWrap: { width: 36, height: 36, borderRadius: 12, backgroundColor: Colors.light.backgroundDefault, alignItems: "center", justifyContent: "center" },
  text:     { flex: 1 },
  title:    { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Colors.light.text },
  sub:      { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 1 },
});
