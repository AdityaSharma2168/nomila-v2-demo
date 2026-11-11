/**
 * MusicSuggestion — the Board's "Suggested" line above the Music chips: the recommender's pick for
 * the words on her board, and the one-line reason, shown as the server wrote it.
 *
 * The reason is the point. A preselected track with no why is a default she has to second-guess;
 * with "warm · 84 BPM, slow" beside it she can agree or tap another chip. fontWeight is always
 * paired with an Outfit family (DESIGN.md: on iOS the weight alone does nothing).
 */
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts } from "../../constants/theme";

export interface MusicSuggestionProps {
  label: string;
  reason: string;
}

export function MusicSuggestion({ label, reason }: MusicSuggestionProps) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`Suggested track: ${label}. ${reason}`}
    >
      <Feather name="music" size={13} color={Colors.light.primary} />
      <View style={styles.text}>
        <Text style={styles.title}>Suggested: {label}</Text>
        <Text style={styles.reason}>{reason}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginBottom: 6,
  },
  text: { flex: 1 },
  title: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12.5,
    color: Colors.light.text,
  },
  reason: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },
});
