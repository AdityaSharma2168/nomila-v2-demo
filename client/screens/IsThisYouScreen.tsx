/**
 * IsThisYouScreen — Phase A Step 3b (plan §3b §9). The index found one or more profiles that may already be this athlete.
 * She picks one ("That's me") or none ("None of these"). Picking is candidate confirmation, never proof: the server links
 * only with a corroboration (her verified e-mail, a connected account) and otherwise keeps the claim for an operator while
 * she continues on a new profile. Nothing is chosen for her. Rendered only behind EXPO_PUBLIC_IDENTITY_CLAIM.
 */

import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Colors } from "../constants/theme";
import type { ClaimPrompt, ClaimCandidate } from "../lib/auth-context";

interface Props {
  prompt: ClaimPrompt;
  onConfirm: (claimId: string) => Promise<void>;
  onDismiss: () => Promise<void>;
}

function line(c: ClaimCandidate): string {
  const parts = [c.sport, c.teamOrSchool, c.classYear ? `Class of ${c.classYear}` : null, c.cityOrCountry].filter(Boolean);
  return parts.join(" · ");
}
function handles(c: ClaimCandidate): string {
  const h = c.knownSocialHandles ?? {};
  return Object.entries(h).filter(([, v]) => !!v).map(([k, v]) => `${k}: @${String(v).replace(/^@/, "")}`).join("  ");
}

export function IsThisYouScreen({ prompt, onConfirm, onDismiss }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>, key: string) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong. Please try again."); }
    finally { setBusy(null); }
  };
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Is this you?</Text>
      <Text style={styles.lead}>We found {prompt.claims.length === 1 ? "a profile" : "profiles"} that might already be yours. Pick yours, or start fresh — nothing is chosen for you.</Text>
      {prompt.claims.map((cl) => {
        const c = cl.candidate;
        const taken = c?.claimability === "none";
        return (
          <View key={cl.claimId} style={styles.card}>
            <Text style={styles.name}>{c?.fullName ?? "Athlete"}</Text>
            {c ? <Text style={styles.meta}>{line(c)}</Text> : null}
            {c && handles(c) ? <Text style={styles.meta}>{handles(c)}</Text> : null}
            {taken ? <Text style={styles.note}>This profile already has an owner — picking it sends it to our team.</Text> : null}
            <Pressable accessibilityRole="button" disabled={!!busy} onPress={() => act(() => onConfirm(cl.claimId), cl.claimId)} style={({ pressed }) => [styles.primary, pressed && styles.pressed, !!busy && styles.disabled]}>
              {busy === cl.claimId ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>That's me</Text>}
            </Pressable>
          </View>
        );
      })}
      <Pressable accessibilityRole="button" disabled={!!busy} onPress={() => act(onDismiss, "none")} style={({ pressed }) => [styles.secondary, pressed && styles.pressed, !!busy && styles.disabled]}>
        {busy === "none" ? <ActivityIndicator color={Colors.light.primary} /> : <Text style={styles.secondaryText}>None of these — start fresh</Text>}
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, paddingTop: 72, gap: 16 },
  title: { fontSize: 28, fontWeight: "700", color: Colors.light.text },
  lead: { fontSize: 16, lineHeight: 22, color: Colors.light.text, opacity: 0.8 },
  card: { borderRadius: 12, padding: 16, gap: 6, backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#d8d8d8" },
  name: { fontSize: 18, fontWeight: "600", color: Colors.light.text },
  meta: { fontSize: 14, color: Colors.light.text, opacity: 0.75 },
  note: { fontSize: 13, color: "#8a5a00" },
  primary: { marginTop: 8, borderRadius: 8, paddingVertical: 12, alignItems: "center", backgroundColor: Colors.light.primary },
  primaryText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  secondary: { marginTop: 8, borderRadius: 8, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: Colors.light.primary },
  secondaryText: { color: Colors.light.primary, fontWeight: "600", fontSize: 16 },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.6 },
  error: { color: "#b00020", fontSize: 14 },
});
