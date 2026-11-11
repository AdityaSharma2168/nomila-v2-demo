/**
 * ConfirmBriefStep — what a direction tool read, line by line, before anything is planned (PR 7).
 *
 * Two kinds of line, told apart on sight and by a screen reader: FROM THE BRIEF (literal — shown with
 * the words it was read from) and INFERRED (the tool's own — shown with its because and a Confirm
 * pill). "Use this brief" stays off until every inferred line is confirmed: nothing proceeds
 * unconfirmed (directionLogic `allConfirmed`). Literal lines are read, not tapped.
 *
 * The spike's surface (commit 1): rows and a confirm. Editing a line, the product-mismatch question
 * and the four doors that land here are Lane E's.
 */
import { useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { HapticPressable } from "../HapticPressable";
import { SourceLinks } from "../ui/SourceLinks";
import {
  allConfirmed,
  confirmRows,
  CONTEXT_PREFIX,
  INFERRED_PREFIX,
  isUnverifiedMoment,
  LITERAL_PREFIX,
  READ_AS_IMAGE,
  UNVERIFIED_LINE,
  type BriefProposal,
  type ConfirmRow,
} from "../../screens/studio/directionLogic";

export function ConfirmBriefStep({
  proposal,
  brandName,
  onBack,
  onConfirm,
}: {
  proposal: BriefProposal;
  brandName: string;
  onBack: () => void;
  /** Every inferred line confirmed; the proposal, unchanged, goes on. */
  onConfirm: (proposal: BriefProposal) => void;
}) {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const rows = confirmRows(proposal);
  const ready = allConfirmed(proposal, confirmed);
  const toggle = (path: string) =>
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Check what I read</Text>
          <Text style={styles.topSub}>{brandName}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {proposal.extras.extraction === "unavailable" ? (
          <Text style={styles.lead} accessibilityLabel="Read as an image">
            {READ_AS_IMAGE}
          </Text>
        ) : (
          <Text style={styles.lead}>
            Lines marked <Text style={styles.leadInferred}>inferred</Text> are
            mine, not the brief&apos;s. Confirm each one, or go back.
          </Text>
        )}
        <View style={styles.card}>
          {rows.map((r, i) => (
            <Row
              key={r.path}
              row={r}
              last={i === rows.length - 1}
              confirmed={confirmed.has(r.path)}
              onToggle={() => toggle(r.path)}
            />
          ))}
        </View>
        {proposal.extras.moment ? (
          <View style={styles.card} accessibilityLabel="What the search found">
            <View style={styles.block}>
              <Text style={styles.eyebrow}>WHAT THE SEARCH FOUND</Text>
              <Text style={styles.value}>{proposal.extras.moment.title}</Text>
              <Text style={styles.note}>{proposal.extras.moment.summary}</Text>
              {/* Each source is a tappable link (OpenAI's terms: web results are shown with clickable citations). */}
              {proposal.extras.moment.sources.length ? (
                <SourceLinks
                  sources={proposal.extras.moment.sources}
                  max={proposal.extras.moment.sources.length}
                  testID="moment-sources"
                />
              ) : (
                <Text
                  style={styles.unverified}
                  accessibilityLabel="Unverified moment"
                >
                  {UNVERIFIED_LINE}
                </Text>
              )}
              {isUnverifiedMoment(proposal) ? (
                <Text style={styles.note}>
                  Nothing here was cited. Confirm only if you know it is real.
                </Text>
              ) : null}
              {proposal.extras.moment.timingRemoved.length ? (
                <Text style={styles.note}>
                  Timing the search supplied was removed:{" "}
                  {proposal.extras.moment.timingRemoved.join(", ")}. The date is
                  yours to add.
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        {proposal.extras.notes?.length ? (
          <View style={styles.card} accessibilityLabel="What I noticed">
            <View style={styles.block}>
              <Text style={styles.eyebrow}>WHAT I NOTICED</Text>
              {proposal.extras.notes.map((n) => (
                <Text key={n} style={styles.note}>
                  {n}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {!ready ? (
          <Text style={styles.footerHint}>
            Confirm each inferred line to go on.
          </Text>
        ) : null}
        <HapticPressable
          style={[styles.primary, !ready && styles.primaryOff]}
          onPress={() => onConfirm(proposal)}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel="Use this brief"
          accessibilityState={{ disabled: !ready }}
        >
          <Text style={styles.primaryTxt}>Use this brief</Text>
        </HapticPressable>
      </View>
    </SafeAreaView>
  );
}

function Row({
  row,
  last,
  confirmed,
  onToggle,
}: {
  row: ConfirmRow;
  last: boolean;
  confirmed: boolean;
  onToggle: () => void;
}) {
  // A context row (the reference's provenance) is read, never tapped — whatever its basis on the wire.
  const inferred = row.basis === "inferred" && !row.context;
  return (
    <View
      style={[styles.row, !last && styles.rowDivider]}
      accessible
      accessibilityLabel={row.accessibilityLabel}
    >
      {inferred ? <View style={styles.inferredBar} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>{row.label.toUpperCase()}</Text>
          <Text
            style={[
              styles.chip,
              inferred ? styles.chipInferred : styles.chipLiteral,
            ]}
          >
            {(row.context
              ? CONTEXT_PREFIX
              : inferred
                ? INFERRED_PREFIX
                : LITERAL_PREFIX
            ).toUpperCase()}
          </Text>
        </View>
        <Text style={styles.value}>{row.value}</Text>
        {row.note ? (
          <Text style={[styles.note, !inferred && styles.quote]}>
            {row.note}
          </Text>
        ) : null}
      </View>
      {inferred ? (
        <HapticPressable
          style={[styles.pill, confirmed && styles.pillOn]}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={`${confirmed ? "Confirmed" : "Confirm"} ${row.label}`}
          accessibilityState={{ selected: confirmed }}
        >
          {confirmed ? (
            <Feather name="check" size={14} color={Colors.light.buttonText} />
          ) : null}
          <Text style={[styles.pillTxt, confirmed && styles.pillTxtOn]}>
            {confirmed ? "Confirmed" : "Confirm"}
          </Text>
        </HapticPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  topTitle: {
    fontFamily: Fonts.heading,
    fontWeight: "700",
    fontSize: 22,
    lineHeight: 28,
    color: Colors.light.text,
  },
  topSub: {
    fontFamily: Fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.textMuted,
  },
  body: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing["3xl"],
    gap: Spacing.lg,
  },
  lead: {
    fontFamily: Fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.textSecondary,
  },
  leadInferred: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    color: Colors.light.warning,
  },
  card: {
    backgroundColor: Colors.light.card,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    paddingHorizontal: Spacing.lg,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  inferredBar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
    backgroundColor: Colors.light.warning,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: 2,
  },
  eyebrow: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.5,
    color: Colors.light.textQuiet,
  },
  chip: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    borderRadius: BorderRadius.full,
    overflow: "hidden",
  },
  chipInferred: {
    color: "#92400E",
    backgroundColor: Colors.light.warningLight,
  },
  chipLiteral: { color: "#065F46", backgroundColor: Colors.light.successLight },
  value: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "500",
    fontSize: 16,
    lineHeight: 22,
    color: Colors.light.text,
  },
  note: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textMuted,
    marginTop: 2,
  },
  quote: { fontStyle: "italic" },
  block: { paddingVertical: Spacing.md, gap: 4 },
  unverified: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    fontSize: 13,
    lineHeight: 18,
    color: Colors.light.warning,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 120,
    height: 36,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.warning,
    backgroundColor: Colors.light.card,
  },
  pillOn: {
    backgroundColor: Colors.light.primary,
    borderColor: Colors.light.primary,
  },
  pillTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    fontSize: 13,
    color: Colors.light.text,
  },
  pillTxtOn: { color: Colors.light.buttonText },
  footer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    gap: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    backgroundColor: Colors.light.backgroundRoot,
  },
  footerHint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textMuted,
    textAlign: "center",
  },
  primary: {
    minWidth: 120,
    height: Spacing.buttonHeight,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryOff: { opacity: 0.4 },
  primaryTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontWeight: "600",
    fontSize: 16,
    color: Colors.light.buttonText,
  },
});
