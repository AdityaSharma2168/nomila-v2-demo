/**
 * AccountDeletingScreen — any request answered 410 account_deleting (lib/account-deleting.ts): this account's deletion
 * was confirmed, on this phone or another one still signed in. Full screen, no shell; OK signs out
 * (auth-context leaveDeletedAccount). Also the closing screen of the delete flow (DeleteAccountScreen's success), which
 * shares this layout: a mark, one big line, plain words, one button.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { Button } from "../components/ui";
import { Bold, BoldType } from "../constants/theme";

export const ACCOUNT_DELETING_COPY = {
  title: "This account is being deleted",
  line: "You asked to delete this account, so it's closed. If that wasn't you, write to us at hello@nomila.co.",
  ok: "OK",
} as const;

/** The shared full-screen result: mark, big line, body, an optional quiet line, one outlined button. */
export function AccountResultScreen({ icon, title, body, meta, action, onAction, testID }: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  body: string;
  meta?: string;
  action: string;
  onAction: () => void;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID={testID}>
      <View style={styles.center}>
        <View style={styles.mark}><Feather name={icon} size={24} color={Bold.ink} /></View>
        <Text style={styles.big} accessibilityRole="header">{title}</Text>
        <Text style={styles.body}>{body}</Text>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        <Button bold="small" onPress={onAction} style={styles.btn} testID={testID ? `${testID}-action` : undefined}>{action}</Button>
      </View>
    </View>
  );
}

export function AccountDeletingScreen({ onOk }: { onOk: () => void }) {
  const c = ACCOUNT_DELETING_COPY;
  return <AccountResultScreen icon="alert-circle" title={c.title} body={c.line} action={c.ok} onAction={onOk} testID="account-deleting" />;
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: Bold.paper },
  center: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  mark:   { width: 52, height: 52, borderRadius: 26, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  big:    { ...BoldType.displaySm, color: Bold.ink, marginTop: 14, marginBottom: 12 },
  body:   { ...BoldType.body, color: Bold.ink2, marginBottom: 12 },
  meta:   { ...BoldType.caption, color: Bold.mute },
  btn:    { height: Bold.button, marginTop: 24, alignSelf: "stretch" },
});
