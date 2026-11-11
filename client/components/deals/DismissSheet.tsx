// DismissSheet — what the X on Deal Detail opens instead of deleting something.
//
// The X used to be a single destructive icon wired straight to "decline". It read as a
// delete (the deal vanished), it was the last surviving fragment of a ten-action overflow
// menu, and — the part that mattered — it threw away the only information worth having.
//
// "Not a deal" and "Not interested" look identical in the deals table and mean opposite
// things about the classifier:
//
//   Not a deal      → we should never have surfaced this. A precision failure.
//   Not interested  → a real offer, correctly surfaced, and the answer is no.
//
// Collapsing them is why 2,000 filed messages taught the system nothing. Each choice here
// posts to /deals/:id/dispose, which records `payload.athlete_label` — the first
// ground-truth label in the product that a person actually asserted rather than the
// pipeline inferring. Her sender memory (server/lib/senderMemory.ts) reads exactly these.
//
// A plain RN Modal bottom sheet, matching DecisionSheet and the app's other modals — no
// new sheet dependency.

import React from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { haptics } from "../../lib/haptics";
import { Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";

export type DealDisposition = "not_a_deal" | "not_interested" | "expired" | "save";

interface Choice {
  key:   DealDisposition;
  label: string;
  hint:  string;
  icon:  any;
  tone:  "neutral" | "decline";
}

// Order is deliberate: the judgements first, the keep-it option last, so the sheet reads
// as "what is this?" rather than as a menu of ways to delete.
//
// The hints are written in HER voice, not the app's — "not one I want", "keep it on my
// list" — because this sheet is where she tells Mila what something is. An instruction
// ("keep it in your list") reads like the app talking back at her.
//
// The three judgements are not degrees of the same answer, they are different answers, and
// the wording has to make that obvious in the half-second someone spends here:
//   not a deal      — we were WRONG to show it
//   not interested  — we were RIGHT, it just isn't for her
//   expired         — we were RIGHT, and we were too LATE
// Collapsing the last into either of the others would teach the system the opposite of
// what happened, so each hint names the thing that makes it distinct.
const CHOICES: Choice[] = [
  {
    key: "not_a_deal",
    label: "Not a deal",
    hint: "Junk — Mila shouldn't have surfaced it",
    icon: "slash",
    tone: "decline",
  },
  {
    key: "not_interested",
    label: "Not interested",
    hint: "A real offer, but not one I want",
    icon: "x-circle",
    tone: "decline",
  },
  {
    key: "expired",
    label: "No longer valid",
    hint: "A real offer, but the moment has passed",
    icon: "clock",
    tone: "decline",
  },
  {
    key: "save",
    label: "Save for later",
    hint: "Keep it on my list",
    icon: "bookmark",
    tone: "neutral",
  },
];

interface DismissSheetProps {
  visible:   boolean;
  brandName: string;
  busy?:     boolean;
  onClose:   () => void;
  onChoose:  (disposition: DealDisposition) => void;
}

export function DismissSheet({ visible, brandName, busy, onClose, onChoose }: DismissSheetProps) {
  const C = Colors.light; // light only (one look, Oct 2026)
  const styles = React.useMemo(() => createStyles(C), [C]);

  const choose = (key: DealDisposition) => {
    if (busy) return;
    haptics.select();
    onChoose(key);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />

        <Text style={styles.title} numberOfLines={2}>
          What should Mila do with {brandName}?
        </Text>
        {/* Says plainly that nothing is destroyed. The old confirm alert promised the same
            thing in prose and still read as a delete, because the only button was red. */}
        <Text style={styles.sub}>Every option is reversible — nothing is deleted.</Text>

        <View style={styles.choices}>
          {CHOICES.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => choose(c.key)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={c.label}
              style={({ pressed }) => [
                styles.choice,
                pressed && !busy && styles.choicePressed,
                busy && styles.choiceBusy,
              ]}
            >
              <View style={[styles.iconWrap, c.tone === "decline" && styles.iconWrapDecline]}>
                <Feather
                  name={c.icon}
                  size={16}
                  color={c.tone === "decline" ? C.textMuted : C.primary}
                />
              </View>
              <View style={styles.choiceText}>
                <Text style={styles.choiceLabel}>{c.label}</Text>
                <Text style={styles.choiceHint} numberOfLines={2}>{c.hint}</Text>
              </View>
              <Feather name="chevron-right" size={16} color={C.borderLight} />
            </Pressable>
          ))}
        </View>

        <Pressable onPress={onClose} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

type Palette = (typeof Colors)["light"] | (typeof Colors)["dark"];

function createStyles(C: Palette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)" },
    sheet: {
      backgroundColor: C.card,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing["2xl"],
      gap: Spacing.sm,
    },
    grabber: {
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.borderLight,
      alignSelf: "center",
      marginBottom: Spacing.md,
    },
    title: {
      fontFamily: Fonts.headingSemiBold,
      fontSize: 19,
      color: C.text,
      letterSpacing: -0.2,
    },
    sub: {
      fontFamily: Fonts.body,
      fontSize: 13,
      color: C.textMuted,
      marginBottom: Spacing.xs,
    },
    choices: { gap: Spacing.xs, marginTop: Spacing.xs },
    choice: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.md,
      borderRadius: BorderRadius.md,
      backgroundColor: C.backgroundSecondary,
    },
    choicePressed: { opacity: 0.72 },
    choiceBusy: { opacity: 0.5 },
    iconWrap: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: C.card,
    },
    iconWrapDecline: { backgroundColor: C.card },
    choiceText: { flex: 1, gap: 2 },
    choiceLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 15.5, color: C.text },
    choiceHint: { fontFamily: Fonts.body, fontSize: 12.5, color: C.textMuted, lineHeight: 17 },
    cancel: { alignItems: "center", paddingVertical: Spacing.md, marginTop: Spacing.xs },
    cancelText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: C.textMuted },
  });
}
