/**
 * EditPopover — the card beneath the compose picker's strip, for the photo she just selected (PR 9, Lane 3a).
 *
 * Non-blocking by construction: it is rendered by AgentScreen from its own `lastPicked` state, below the
 * strip that fired, never inside the picker and never over a tile; the selection it refers to is already
 * made. It shows the system recommendation when her confirmed brief grounds one (the chip quotes the brief
 * line it rests on), the manual door to the typed ops, and — when the source gate refuses the photo — the
 * refusal's own words, never a silent nothing. A rec is a chip she taps into the same quote → preview →
 * accept sheet as a manual op; nothing here runs anything.
 */
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import type { EditRec, RecommendAnswer } from "../../screens/studio/editTypes";
import type { LastPicked } from "../../screens/studio/editPopoverLogic";

export interface EditPopoverProps {
  picked: LastPicked;
  /** The recommendation answer, or undefined while it is being read / when there is no brief. */
  answer: RecommendAnswer | undefined;
  loading: boolean;
  onRec: (rec: EditRec) => void;
  onManual: () => void;
  onDismiss: () => void;
}

// The ad op has ONE door — the brand post's Carousel chip after the brief (Adi, 23 Sep 2026) — so it is not a
// chip here either: a grounded ad rec is filtered out before the card renders (`shown`).
const OP_WORD: Record<Exclude<EditRec["op"], "ad">, string> = {
  recolour: "Recolour",
  garment: "Swap the kit",
  product: "Place the product",
  background_clean: "Clean the background",
};

export function EditPopover({
  picked,
  answer,
  loading,
  onRec,
  onManual,
  onDismiss,
}: EditPopoverProps) {
  const noun = picked.list === "products" ? "Product" : "Photo";
  const shown = (answer?.recs ?? []).filter(
    (r): r is EditRec & { op: Exclude<EditRec["op"], "ad"> } => r.op !== "ad",
  );
  return (
    <View
      style={styles.card}
      testID="edit-popover"
      accessibilityLabel={`${noun} ${picked.ordinal}, change anything?`}
    >
      <View style={styles.head}>
        <Text style={styles.title}>
          {noun.toUpperCase()} {picked.ordinal} · CHANGE ANYTHING?
        </Text>
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Feather name="x" size={16} color={Colors.light.textMuted} />
        </Pressable>
      </View>

      {answer?.refusal ? (
        <View style={styles.refusal} testID="edit-popover-refusal">
          <Feather name="alert-circle" size={13} color={Colors.light.primary} />
          <Text style={styles.refusalTxt}>{answer.refusal}</Text>
        </View>
      ) : loading ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={Colors.light.primary} />
          <Text style={styles.hint}>Checking it against your brief…</Text>
        </View>
      ) : answer && shown.length > 0 ? (
        shown.map((rec, i) => (
          <Pressable
            key={`${rec.op}-${i}`}
            style={styles.rec}
            onPress={() => onRec(rec)}
            accessibilityRole="button"
            accessibilityLabel={`${OP_WORD[rec.op]}: ${rec.what}`}
            testID="edit-popover-rec"
          >
            <View style={styles.recMain}>
              <Text style={styles.recOp}>{OP_WORD[rec.op].toUpperCase()}</Text>
              <Text style={styles.recWhat}>{rec.what}</Text>
              <Text style={styles.recBecause}>“{rec.because}”</Text>
            </View>
            <Feather
              name="chevron-right"
              size={16}
              color={Colors.light.textMuted}
            />
          </Pressable>
        ))
      ) : (
        <Text style={styles.hint}>
          {answer && answer.skipped === "no_brief"
            ? "No brief on this post, so nothing to check it against."
            : "Nothing in your brief asks for a change here."}
        </Text>
      )}

      {answer?.refusal ? null : (
        <Pressable
          style={styles.manual}
          onPress={onManual}
          accessibilityRole="button"
          accessibilityLabel="Change it yourself"
          testID="edit-popover-manual"
        >
          <Feather name="edit-2" size={13} color={Colors.light.primary} />
          <Text style={styles.manualTxt}>Change it…</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: Spacing.sm,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  row: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },
  rec: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.light.backgroundRoot,
  },
  recMain: { flex: 1, gap: 2 },
  recOp: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.primary,
  },
  recWhat: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.light.text,
  },
  recBecause: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
    fontStyle: "italic",
  },
  manual: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  manualTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  refusal: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  refusalTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.text,
  },
});
