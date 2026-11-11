// MilaProfileConfirm — the interactive confirm card for a proposed durable profile
// update (Phase-3 memory). Follows the reply_action PATTERN: the model PROPOSED a
// value; the athlete reviews + edits it here and only a deliberate Save tap writes
// (via useProfileConfirm → PATCH /me/profile/*). The model can never trigger the
// write; only the tap does.
//
// An `achievement` candidate is non-persistable — there is no endpoint — so it
// renders as an honest acknowledgment that is explicit it is NOT saved to the
// profile (it only rides the conversation summary).

import React, { useState } from "react";
import { View, Text, Pressable, TextInput, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { haptics } from "../../lib/haptics";
import { N, oppsFont } from "../deals/opps/tokens";
import type { ProfileUpdateCandidate } from "../../hooks/use-mila-chat";
import { MILA_CARD } from "./milaSurface";
import { candidateEditText, useProfileConfirm } from "./useProfileConfirm";

function editHint(field: ProfileUpdateCandidate["field"]): string | null {
  if (field === "secondary_goals") return "Separate goals with commas.";
  if (field === "brand_voice") return "A few words on the tone you want.";
  return null;
}

export function MilaProfileConfirm({
  candidate,
}: {
  candidate: ProfileUpdateCandidate;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [text, setText] = useState(() => candidateEditText(candidate));
  const { status, error, save } = useProfileConfirm(candidate);

  if (dismissed) return null;

  // ── Achievement: honest, non-persisted. No Save, no endpoint. ──
  if (!candidate.persistable) {
    return (
      <View style={[styles.card, styles.noteCard]}>
        <Feather name="award" size={15} color={N.ink500} />
        <View style={styles.noteText}>
          <Text style={styles.noteTitle}>{String(candidate.value)}</Text>
          <Text style={styles.noteSub}>
            Noted for this chat — not saved to your profile.
          </Text>
        </View>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          accessibilityLabel="Dismiss"
          style={({ pressed }) => pressed && { opacity: 0.6 }}
        >
          <Feather name="x" size={15} color={N.ink300} />
        </Pressable>
      </View>
    );
  }

  // ── Saved: terminal state, so a scrollback re-tap can't re-save. ──
  if (status === "saved") {
    return (
      <View style={[styles.card, styles.savedCard]}>
        <View style={styles.checkCircle}>
          <Feather name="check" size={13} color="#fff" />
        </View>
        <Text style={styles.savedText}>Saved to your profile</Text>
      </View>
    );
  }

  const hint = editHint(candidate.field);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Feather name="bookmark" size={14} color={N.ink500} />
        <Text style={styles.title}>Save to your profile?</Text>
      </View>
      <Text style={styles.label}>{candidate.label}</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Edit before saving…"
        placeholderTextColor={N.ink500}
        autoCorrect={false}
      />
      {hint && <Text style={styles.hint}>{hint}</Text>}
      <View style={styles.actions}>
        <Pressable
          onPress={() => {
            haptics.press();
            save(text);
          }}
          disabled={status === "saving"}
          accessibilityLabel="Save to profile"
          style={({ pressed }) => [
            styles.saveBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Feather name="check" size={14} color="#fff" />
          <Text style={styles.saveBtnText}>
            {status === "saving" ? "Saving…" : "Save"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setDismissed(true)}
          accessibilityLabel="Dismiss"
          style={({ pressed }) => [
            styles.dismissBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.dismissBtnText}>Dismiss</Text>
        </Pressable>
      </View>
      {status === "error" && !!error && (
        <Text style={styles.errorText}>{error}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A light Mila card with the soft lift, no border (milaSurface).
  card: {
    ...MILA_CARD,
    padding: 14,
    gap: 10,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: {
    fontFamily: oppsFont(700),
    fontSize: 13,
    color: N.ink900,
  },
  label: {
    fontFamily: oppsFont(500),
    fontSize: 14,
    color: N.ink700,
    lineHeight: 20,
  },
  input: {
    fontFamily: oppsFont(500),
    fontSize: 14.5,
    color: N.ink900,
    backgroundColor: N.cream100,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 40,
  },
  hint: {
    fontFamily: oppsFont(400),
    fontSize: 12,
    color: N.ink500,
    marginTop: -2,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 120,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 9999,
    backgroundColor: N.pink,
  },
  saveBtnText: {
    fontFamily: oppsFont(700),
    fontSize: 13.5,
    color: "#fff",
  },
  dismissBtn: {
    height: 40,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dismissBtnText: {
    fontFamily: oppsFont(600),
    fontSize: 13.5,
    color: N.ink500,
  },
  errorText: {
    fontFamily: oppsFont(500),
    fontSize: 12.5,
    color: N.error,
  },
  // Achievement note
  noteCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  noteText: { flex: 1, gap: 2 },
  noteTitle: {
    fontFamily: oppsFont(600),
    fontSize: 14,
    color: N.ink900,
    lineHeight: 20,
  },
  noteSub: {
    fontFamily: oppsFont(400),
    fontSize: 12,
    color: N.ink500,
  },
  // Saved terminal
  savedCard: { flexDirection: "row", alignItems: "center", gap: 9 },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#3BA55C",
    alignItems: "center",
    justifyContent: "center",
  },
  savedText: {
    fontFamily: oppsFont(600),
    fontSize: 13.5,
    color: N.ink900,
  },
});
