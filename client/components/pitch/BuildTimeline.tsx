import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts } from "../../constants/theme";
import { BUILD_STEPS, type BuildStepState } from "../../hooks/use-build-stream";

/** The live agent-step timeline (Gates 2 & 3) — one row per stage, lit as the work progresses. */
export function BuildTimeline({
  stepState,
  steps = BUILD_STEPS,
}: {
  stepState: (i: number) => BuildStepState;
  steps?: readonly string[];
}) {
  return (
    <View style={styles.wrap}>
      {steps.map((label, i) => {
        const st = stepState(i);
        return (
          <View key={label} style={styles.row}>
            <View style={styles.railCol}>
              <View style={[styles.node, st === "done" && styles.nodeDone, st === "active" && styles.nodeActive]}>
                {st === "done" ? (
                  <Feather name="check" size={12} color="#fff" />
                ) : st === "active" ? (
                  <ActivityIndicator size="small" color={Colors.light.primary} />
                ) : null}
              </View>
              {i < steps.length - 1 ? <View style={[styles.rail, st === "done" && styles.railDone]} /> : null}
            </View>
            <Text style={[styles.label, st === "pending" && styles.labelPending, st === "active" && styles.labelActive]}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 0 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  railCol: { alignItems: "center", width: 24 },
  node: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: Colors.light.border,
    backgroundColor: Colors.light.card, alignItems: "center", justifyContent: "center",
  },
  nodeActive: { borderColor: Colors.light.primary },
  nodeDone: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  rail: { width: 2, flex: 1, minHeight: 22, backgroundColor: Colors.light.border, marginVertical: 2 },
  railDone: { backgroundColor: Colors.light.primary },
  label: { flex: 1, paddingTop: 3, paddingBottom: 18, fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.textSecondary },
  labelPending: { color: Colors.light.textMuted },
  labelActive: { fontFamily: Fonts.bodyBold, fontWeight: "700", color: Colors.light.text },
});
