/**
 * ProfileUnavailableScreen — signed in, but GET /auth/me kept answering "unavailable" (a 5xx or no network) for
 * PROFILE_RETRY.attempts tries (auth-context `profileUnavailable`). Never read as "no athlete": instead of spinning
 * forever, one plain line on the dark ground (the same ground as the front's waiting state) with Try again and
 * Sign out. Look B tokens and the shared Button / LinkText only.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, LinkText } from "../components/ui";
import { Bold, BoldType } from "../constants/theme";

export const PROFILE_UNAVAILABLE_COPY = {
  title: "We can’t reach Nomila right now.",
  line: "Check your connection, then try again.",
  retry: "Try again",
  signOut: "Sign out",
} as const;

export function ProfileUnavailableScreen({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  const c = PROFILE_UNAVAILABLE_COPY;
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]} testID="profile-unavailable">
      <Text style={styles.wordmark}>NOMILA</Text>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">{c.title}</Text>
        <Text style={styles.line}>{c.line}</Text>
        <Button bold="onHero" onPress={onRetry} style={styles.btn} testID="profile-unavailable-retry">{c.retry}</Button>
        <View style={styles.center}>
          <LinkText onDark arrow={false} onPress={onSignOut} style={styles.link} testID="profile-unavailable-signout">{c.signOut}</LinkText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root:     { flex: 1, backgroundColor: Bold.ink, paddingHorizontal: Bold.gutter, justifyContent: "space-between" },
  wordmark: { ...BoldType.wordmark, color: Bold.onDark, marginTop: 16 },
  body:     { gap: 8 },
  title:    { ...BoldType.displaySm, color: Bold.onDark },
  line:     { ...BoldType.heroLineSmall, color: Bold.onDarkSoft, marginBottom: 8 },
  btn:      { alignSelf: "stretch", height: Bold.button },
  center:   { alignItems: "center" },
  link:     { minHeight: 44 },
});
