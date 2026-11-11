/**
 * OutputGateNotice — what came out, when the server's output gate held it back (quality-scrappy piece 5,
 * server/studio/outputGate.ts): the headline, one plain sentence per reason, and — where the surface can offer one — a
 * way to check the cost again WITH the fix. Never a number, never a score.
 *
 * NOTHING HERE RE-RUNS. The button asks for a fresh quote (the surface passes the gate's codes back as `corrective`),
 * and the only spend is her own Generate tap on that quote — the same approval, caps and day total as any job.
 *
 * Absent `gate` on the wire — it passed, or the server's opt-in STUDIO_OUTPUT_GATE is off — and no surface mounts this.
 *
 * ⚠️ MUTATION (OutputGateNotice.test): render a Try again that spends — call the generate hook here — "the notice never
 * spends: its button only asks for a check" reds by name.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts } from "../../constants/theme";

export const TRY_AGAIN_LABEL = "Check the cost to try again";

export function OutputGateNotice({
  headline,
  lines,
  onTryAgain,
}: {
  headline: string;
  lines: string[];
  /** Asks for a fresh quote with the fix. Absent: the surface has no way to, and says only what went wrong. */
  onTryAgain?: () => void;
}) {
  return (
    <View style={styles.box} testID="output-gate" accessibilityRole="alert">
      <View style={styles.head}>
        <Feather name="alert-circle" size={15} color={Colors.light.primary} />
        <Text style={styles.headline}>{headline}</Text>
      </View>
      {lines.map((l) => (
        <Text key={l} style={styles.line}>
          {l}
        </Text>
      ))}
      {onTryAgain ? (
        <Pressable
          style={styles.pill}
          onPress={onTryAgain}
          accessibilityRole="button"
          accessibilityLabel={TRY_AGAIN_LABEL}
          testID="output-gate-try-again"
        >
          <Feather
            name="refresh-cw"
            size={13}
            color={Colors.light.buttonText}
          />
          <Text style={styles.pillTxt}>{TRY_AGAIN_LABEL}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: BorderRadius.lg,
    padding: 16,
    gap: 8,
    backgroundColor: Colors.light.primaryLight,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  headline: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    fontWeight: "600",
    color: Colors.light.text,
    flexShrink: 1,
  },
  line: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textSecondary,
  },
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 120,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    marginTop: 4,
    backgroundColor: Colors.light.text,
  },
  pillTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.buttonText,
  },
});
