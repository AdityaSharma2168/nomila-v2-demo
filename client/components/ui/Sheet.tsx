// Sheet — the one bottom sheet. Corner 26, the warm scrim, a grab handle, a head with either a
// title or an eyebrow + big value, ✕ at the right, hairline under. Rows go inside.
//
//   <Sheet onClose title="Per post — by platform"> … </Sheet>
//   <Sheet onClose eyebrow="Class year" value="2027" headBelow={<chip + meta/>}> … </Sheet>

import React from "react";
import { View, Text, Pressable, StyleSheet, Modal, KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing } from "../../constants/theme";

const C = Colors.light;
export const SHEET_RADIUS = 26;
export const SCRIM = "rgba(42,38,34,0.45)";

export function Sheet({ onClose, title, eyebrow, value, headBelow, children, footer, style, keyboard }: {
  onClose:    () => void;
  title?:     string;
  eyebrow?:   string;
  value?:     string;
  /** Under the head text: a chip and a meta line, say. */
  headBelow?: React.ReactNode;
  children?:  React.ReactNode;
  /** A quiet 11-pt line at the bottom ("Connect a platform to add its verified rate."). */
  footer?:    string;
  style?:     StyleProp<ViewStyle>;
  /** Lift the sheet with the keyboard (an input inside). */
  keyboard?:  boolean;
}) {
  const body = (
    <Pressable style={[styles.sheet, style]} onPress={() => {}}>
      <View style={styles.grab} />
      {(title || eyebrow || value) ? (
        <View style={styles.head}>
          <View style={styles.headText}>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            {value ? <Text style={styles.value} numberOfLines={3}>{value}</Text> : null}
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {headBelow ? <View style={styles.headBelow}>{headBelow}</View> : null}
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Feather name="x" size={20} color={C.textQuiet} />
          </Pressable>
        </View>
      ) : null}
      {children}
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </Pressable>
  );
  return (
    <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        {keyboard ? (
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.kav}>{body}</KeyboardAvoidingView>
        ) : body}
      </Pressable>
    </Modal>
  );
}

/** A tappable "door" inside a sheet: icon tile, title, subtitle, chevron. */
export function SheetDoor({ icon, title, subtitle, onPress, divider }: { icon: React.ReactNode; title: string; subtitle?: string; onPress: () => void; divider?: boolean }) {
  return (
    <Pressable style={[styles.door, divider && styles.doorDivider]} onPress={onPress} accessibilityRole="button">
      <View style={styles.doorIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.doorTitle}>{title}</Text>
        {subtitle ? <Text style={styles.doorSub}>{subtitle}</Text> : null}
      </View>
      <Feather name="chevron-right" size={16} color="#C5BFB8" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim:       { flex: 1, backgroundColor: SCRIM, justifyContent: "flex-end" },
  kav:         { justifyContent: "flex-end" },
  sheet:       { backgroundColor: C.card, borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS, paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: 34 },
  grab:        { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center", marginBottom: Spacing.md },
  head:        { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md, paddingBottom: Spacing.md, marginBottom: Spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderLight },
  headText:    { flex: 1, gap: 2 },
  eyebrow:     { fontFamily: Fonts.bodySemiBold, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: C.textQuiet },
  value:       { fontFamily: Fonts.headingSemiBold, fontSize: 20, lineHeight: 26, color: C.text },
  title:       { fontFamily: Fonts.bodySemiBold, fontSize: 16, color: C.text },
  headBelow:   { marginTop: 4 },
  footer:      { fontFamily: Fonts.body, fontSize: 11, color: C.textQuiet, marginTop: Spacing.md, lineHeight: 16 },
  door:        { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingVertical: Spacing.md },
  doorDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderLight },
  doorIcon:    { width: 34, height: 34, borderRadius: 10, backgroundColor: C.backgroundDefault, alignItems: "center", justifyContent: "center" },
  doorTitle:   { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: C.text },
  doorSub:     { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, marginTop: 1 },
});
