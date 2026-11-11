/**
 * ChooseProfileScreen — Phase A Step 3b (plan §3b §10, P-10). The server answered 409 `athlete_selection_required`: this
 * user holds more than one athlete membership and every request must name one (`X-Athlete-Id`). The server never picks
 * the first row; neither does the app — she chooses. Minimal by design; a profile switcher is not in 3b.
 */

import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Colors } from "../constants/theme";
import type { ProfileChoice } from "../lib/auth-context";

interface Props { profiles: ProfileChoice[]; onChoose: (athleteId: string) => Promise<void> }

export function ChooseProfileScreen({ profiles, onChoose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Which profile?</Text>
      <Text style={styles.lead}>Your sign-in is linked to more than one athlete profile. Choose the one to open.</Text>
      {profiles.map((p) => (
        <Pressable key={p.athleteId} accessibilityRole="button" disabled={!!busy} onPress={async () => { setBusy(p.athleteId); try { await onChoose(p.athleteId); } finally { setBusy(null); } }} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
          <Text style={styles.name}>{p.fullName ?? "Athlete profile"}</Text>
          <Text style={styles.meta}>{p.relation} · {p.proof.replace(/_/g, " ")}</Text>
          {busy === p.athleteId ? <ActivityIndicator color={Colors.light.primary} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, paddingTop: 72, gap: 12 },
  title: { fontSize: 28, fontWeight: "700", color: Colors.light.text },
  lead: { fontSize: 16, lineHeight: 22, color: Colors.light.text, opacity: 0.8, marginBottom: 8 },
  card: { borderRadius: 12, padding: 16, gap: 4, backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#d8d8d8" },
  name: { fontSize: 18, fontWeight: "600", color: Colors.light.text },
  meta: { fontSize: 13, color: Colors.light.text, opacity: 0.7 },
  pressed: { opacity: 0.85 },
});
