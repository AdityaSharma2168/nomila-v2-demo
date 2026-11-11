/**
 * DetailSheet — the look-B sheet (DESIGN.md §11 Modal / Sheet), promoted from the approved prototype (PR #900,
 * client/screens/prototypes/ProtoSheet.tsx): the 0.5 overlay, a white sheet with its 26 top corners and grab handle, a
 * section head with the 2px rule, the body scrolling inside. Drawn over the screen (absolute), so it needs no Modal.
 * Where Me's sections open their detail (never a second copy of the screen), and a fact's actions on What Nomila knows.
 */
import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";

const SHEET_RADIUS = 26;
const OVERLAY = "rgba(0,0,0,0.5)";

export function DetailSheet({ title, onClose, children, testID }: { title: string; onClose: () => void; children: React.ReactNode; testID?: string }) {
  const { height } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} testID={testID ?? "detail-sheet"}>
      <Pressable style={[StyleSheet.absoluteFill, styles.overlay]} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.sheet, { maxHeight: Math.round(height * 0.82) }]}>
          <View style={styles.grab} />
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" testID="detail-sheet-close"><Feather name="x" size={20} color={Bold.quiet} /></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { backgroundColor: OVERLAY },
  wrap:    { flex: 1, justifyContent: "flex-end" },
  sheet:   { backgroundColor: Bold.paper, borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS, paddingTop: 10 },
  grab:    { width: 36, height: 4, borderRadius: 2, backgroundColor: Bold.line, alignSelf: "center", marginBottom: 10 },
  head:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 10, borderBottomWidth: 2, borderBottomColor: Bold.ink, marginHorizontal: Bold.gutter },
  title:   { ...BoldType.section, color: Bold.ink },
  body:    { paddingBottom: 32 },
});
