// ConfidenceLine — the ONE quiet line under Nomila's read ("Nomila is confident in this read."), on Home's black score
// block (`onDark`) and on My Intelligence's score card alike: one size, an optional "Why?" link that opens the explanation.

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Bold, BoldType } from "../../constants/theme";

export function ConfidenceLine({ text, onWhy, onDark, testID }: { text: string; onWhy?: () => void; onDark?: boolean; testID?: string }) {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={[styles.text, onDark && styles.textDark]}>{text}</Text>
      {onWhy ? (
        <Pressable onPress={onWhy} hitSlop={8} accessibilityRole="button" accessibilityHint="Why Nomila is this sure">
          <Text style={[styles.why, onDark && styles.whyDark]}>Why?</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 4 },
  text:     { flex: 1, ...BoldType.caption, color: Bold.mute },
  textDark: { color: Bold.onDarkMute },
  why:      { ...BoldType.link, color: Bold.blue },
  whyDark:  { color: Bold.blueOnDark },
});
