/**
 * Onboarding, the one fixed screen (EXPO_PUBLIC_AGENT_V3): meeting Mila. Her avatar floats at the top on the Mila ground
 * (DESIGN.md §16, the Muse look); Mila asks the athlete's name and sport. Start hands over to the conversation, where
 * the onboarding skill decides what comes next (including the optional age-band card, which gates nothing). Nothing here
 * assumes an age, level or sport.
 */
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bold, BoldType } from "../../constants/theme";
import { N } from "../../components/deals/opps/tokens";
import { MilaAvatar } from "../../components/mila/MilaAvatar";
import { Frost } from "../../components/mila/Frost";
import { MILA_CARD } from "../../components/mila/milaSurface";
import { MilaButton, partStyles } from "../../components/agent/parts";
import { ONBOARDING_COPY } from "../../lib/agent/onboardingLogic";

export function OnboardingNameScreen({
  onStart, busy, error, initialName,
}: {
  onStart: (v: { name: string; sport: string }) => void;
  busy?: boolean;
  error?: boolean;
  initialName?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const c = ONBOARDING_COPY.name;
  const [name, setName] = useState(initialName ?? "");
  const [sport, setSport] = useState("");
  const ready = !!name.trim() && !!sport.trim();

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined} testID="onboarding-name">
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <MilaAvatar state="idle" size={96} />
          <Frost radius={14} style={styles.nameLabel}><Text style={styles.nameLabelText}>Mila</Text></Frost>
          <Text style={styles.hello} accessibilityRole="header">{c.hello}</Text>
          <Text style={styles.lede}>{c.lede}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label} nativeID="name-label">{c.nameLabel}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={c.namePlaceholder}
            placeholderTextColor={Bold.quiet}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="givenName"
            style={partStyles.input}
            accessibilityLabel={c.nameLabel}
            testID="onboarding-name-input"
          />
          <Text style={[styles.label, styles.gapTop]}>{c.sportLabel}</Text>
          <TextInput
            value={sport}
            onChangeText={setSport}
            placeholder={c.sportPlaceholder}
            placeholderTextColor={Bold.quiet}
            autoCapitalize="sentences"
            style={partStyles.input}
            accessibilityLabel={c.sportLabel}
            testID="onboarding-sport-input"
          />
        </View>

        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{c.error}</Text> : null}
        <MilaButton
          label={c.go}
          onPress={() => { if (ready) onStart({ name: name.trim(), sport: sport.trim() }); }}
          disabled={!ready}
          loading={busy}
          testID="onboarding-start"
        />
        <Text style={styles.note}>{c.note}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: N.cream100 },
  content: { paddingHorizontal: 20, gap: 16 },
  hero: { alignItems: "center", gap: 8, marginBottom: 8 },
  nameLabel: { paddingHorizontal: 14, paddingVertical: 5, marginTop: -6 },
  nameLabelText: { ...BoldType.rowTitle, color: Bold.ink },
  hello: { ...BoldType.headedTitle, color: Bold.ink, textAlign: "center", marginTop: 10 },
  lede: { ...BoldType.body, color: Bold.ink2, textAlign: "center", maxWidth: 320 },
  card: { ...MILA_CARD, padding: 16, gap: 8 },
  label: { ...BoldType.h4, color: Bold.ink },
  labelRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  gapTop: { marginTop: 8 },
  choices: { flexDirection: "row", gap: 8 },
  choice: { flex: 1, height: 44, borderRadius: 22, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  choiceOn: { backgroundColor: Bold.ink },
  choiceText: { ...BoldType.rowTitle, color: Bold.ink },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  error: { ...BoldType.caption, color: Bold.ink, textAlign: "center" },
  note: { ...BoldType.caption, color: Bold.mute, textAlign: "center", paddingHorizontal: 12 },
});
