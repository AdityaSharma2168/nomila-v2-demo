// BoldSheet — the look-B bottom sheet (DESIGN.md §11 Modal / Sheet): the 0.5 overlay, white, the 26 top corners and the
// grab handle, an uppercase title with its ✕, then the content. Buttons inside follow §11 Button. Bold / BoldType only.
//
//   <BoldSheet title="Reply to Gymshark" sub="To the thread you're on" onClose={…}>…</BoldSheet>
import React from "react";
import { Modal, View, Text, Pressable, ScrollView, KeyboardAvoidingView, Platform, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bold, BoldType } from "../../constants/theme";

export function BoldSheet({ title, sub, onClose, children, footer, testID, closeDisabled }: {
  title: string;
  sub?: string | null;
  onClose: () => void;
  children: React.ReactNode;
  /** Pinned under the scroll (Send and its safety line). */
  footer?: React.ReactNode;
  testID?: string;
  /** While sending: the overlay and ✕ don't close it. */
  closeDisabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const close = closeDisabled ? () => {} : onClose;
  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={close}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.scrim} onPress={close} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} testID={testID}>
          <View style={styles.grab} />
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.title} accessibilityRole="header">{title}</Text>
              {sub ? <Text style={styles.sub}>{sub}</Text> : null}
            </View>
            <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.x} disabled={closeDisabled}>
              <Feather name="x" size={20} color={Bold.ink} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill:     { flex: 1, justifyContent: "flex-end" },
  scrim:    { ...StyleSheet.absoluteFill, backgroundColor: Bold.sheetScrim },
  sheet:    { maxHeight: "92%", backgroundColor: Bold.paper, borderTopLeftRadius: Bold.sheetRadius, borderTopRightRadius: Bold.sheetRadius, paddingTop: 10 },
  grab:     { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: Bold.line, marginBottom: 8 },
  head:     { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: Bold.gutter, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  headText: { flex: 1, gap: 4 },
  title:    { ...BoldType.screenTitleSm, color: Bold.ink },
  sub:      { ...BoldType.caption, color: Bold.mute },
  x:        { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginTop: -10, marginRight: -10 },
  scroll:   { flexGrow: 0 },
  body:     { paddingHorizontal: Bold.gutter, paddingTop: 14, paddingBottom: 14, gap: 14 },
  footer:   { paddingHorizontal: Bold.gutter, paddingTop: 10, gap: 8, borderTopWidth: 1, borderTopColor: Bold.line },
});
