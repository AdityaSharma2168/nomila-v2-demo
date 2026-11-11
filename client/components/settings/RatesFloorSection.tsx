// WS2 · RatesFloorSection — the athlete sets her per-type FLOOR: the least she'll take.
//
// A per-type ledger, editable, in the app's light theme. The floor is what Mila uses to (a) flag
// offers under it and (b) hold the line in negotiations. Per-deal she can still override in the
// composer.
//
// Legacy retirement, phase 1 (owner decision 8 Oct 2026): no "suggested" rates. They came from the
// retired v3 rate card; every deal type is shown so she can set any floor without one. Her floor is
// her own words and is kept exactly as saved.
//
// Self-contained: saved floors from useDealPreferences, saves via useUpdatePreferences.

import React, { useState } from "react";
import { haptics } from "../../lib/haptics";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useDealPreferences, useUpdatePreferences, type RateFloorKey } from "../../hooks/use-deals";
import { Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";

const ROWS: { key: RateFloorKey; label: string; unit: string }[] = [
  { key: "socialPost", label: "Per post",   unit: "/post" },
  { key: "appearance", label: "Appearance", unit: "/event" },
  { key: "ambassador", label: "Ambassador", unit: "/month" },
  { key: "autograph",  label: "Autograph",  unit: "/deal" },
  { key: "licensing",  label: "Licensing",  unit: "min." },
];

const digits = (s: string) => s.replace(/[^0-9]/g, "");

export function RatesFloorSection() {
  const { data: prefsData, isLoading: prefsLoading } = useDealPreferences();
  const update = useUpdatePreferences();

  const savedFloors = prefsData?.deal_preferences?.minimum_rates ?? {};

  // Local edit state, keyed by deal type. Empty string = "not set".
  const [edits, setEdits] = useState<Partial<Record<RateFloorKey, string>>>({});
  const valueFor = (key: RateFloorKey) =>
    edits[key] !== undefined ? edits[key]! : (savedFloors[key] != null ? String(savedFloors[key]) : "");

  const dirty = Object.keys(edits).length > 0;

  const onSave = () => {
    const minimum_rates: Partial<Record<RateFloorKey, number>> = {};
    for (const r of ROWS) {
      const v = valueFor(r.key);
      if (v !== "") minimum_rates[r.key] = Number(v);
    }
    update.mutate({ minimum_rates }, { onSuccess: () => setEdits({}) });
  };

  if (prefsLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={Colors.light.primary} />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.intro}>
        Your <Text style={styles.introBold}>floor</Text> is the least you'll take per deal type. Mila uses it to
        flag offers under it and hold the line when she negotiates.
      </Text>

      <View style={styles.ledger}>
        {ROWS.map((r, i) => (
          <View key={r.key} style={[styles.row, i > 0 && styles.rowDivider]}>
            <View style={styles.left}>
              <Text style={styles.rowLabel}>{r.label.toUpperCase()}</Text>
            </View>
            <View style={styles.inputWrap}>
              <Text style={styles.dollar}>$</Text>
              <TextInput
                style={styles.input}
                value={valueFor(r.key)}
                onChangeText={(t) => setEdits((e) => ({ ...e, [r.key]: digits(t) }))}
                placeholder="Not set"
                placeholderTextColor={Colors.light.textMuted}
                keyboardType="number-pad"
                maxLength={9}
              />
              <Text style={styles.unit}>{r.unit}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        style={[styles.saveBtn, (!dirty || update.isPending) && styles.saveBtnDisabled]}
        onPress={() => { haptics.press(); onSave(); }}
        disabled={!dirty || update.isPending}
      >
        {update.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.saveText}>{update.isSuccess && !dirty ? "Saved" : "Save floors"}</Text>
        )}
      </Pressable>

      {update.isError && (
        <View style={styles.errorRow}>
          <Feather name="alert-circle" size={13} color={Colors.light.error} />
          <Text style={styles.errorText}>Couldn't save — try again.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: Spacing.sm },
  loading: { paddingVertical: Spacing.xl, alignItems: "center" },
  intro: { fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 20, color: Colors.light.textMuted, marginBottom: Spacing.md },
  introBold: { fontFamily: Fonts.bodySemiBold, color: Colors.light.text },

  ledger: {
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.sm,
    backgroundColor: Colors.light.card, overflow: "hidden",
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 13 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight },
  left: { flex: 1 },
  rowLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 11, letterSpacing: 1, color: Colors.light.text },

  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 2,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundRoot, paddingHorizontal: 10, height: 40, minWidth: 108,
  },
  dollar: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Colors.light.textSecondary },
  input: {
    flex: 1, fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.text,
    paddingVertical: 0, fontVariant: ["tabular-nums"], minWidth: 40,
  },
  unit: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted },

  saveBtn: {
    marginTop: Spacing.md, height: 46, borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary, alignItems: "center", justifyContent: "center",
  },
  saveBtnDisabled: { opacity: 0.45 },
  saveText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: "#fff" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: Spacing.sm },
  errorText: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.error },
});
