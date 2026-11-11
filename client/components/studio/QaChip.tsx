/**
 * QaChip — what the check said about a generated asset, and what it cost (PR 11, R-4).
 *
 * ─── TWO WORDS OF STATE, AND A PRICE ────────────────────────────────────────────────────────────
 *
 * "Passed the check" or "Flagged for a look", and beside it the cost. That is the whole vocabulary.
 * No score, no distance, no "0.31 of 0.40", no threshold — the server never sends one and this
 * component has nowhere to put one. A verdict is something she looks at before she approves; it is
 * not something that decides for her, and a number with a line under it would read as exactly that.
 * ⚠️ MUTATION (QaChip.test): render `spendUsd` or a check score with a comparator — "verdict shown as
 * a score with a threshold" reds by name.
 *
 * The identity observation is captioned as an observation, never as pass/fail: the ruler behind it
 * failed its own stranger control (qa/identity.ts DEAD_RULER_CAVEAT) and its caption says so.
 * ⚠️ MUTATION: label the observation "Identity passed" — "identity observation shown as pass/fail"
 * reds by name.
 *
 * ─── OFF IS NOTHING ────────────────────────────────────────────────────────────────────────────
 *
 * With EXPO_PUBLIC_STUDIO_QA_DISPLAY off the hook does not fetch and this renders null. Nothing on
 * the card moves. ⚠️ MUTATION: drop the flag check — "verdict chip renders with STUDIO_QA_DISPLAY
 * off" reds by name.
 *
 * No loop, no retry, no reroll: this component has no press handler at all.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Bold } from "../../constants/theme";
import { STUDIO_IDENTITY_DRIFT, STUDIO_QA_DISPLAY } from "../../lib/flags";
import {
  useAssetQa,
  type QaCostWire,
  type QaVerdictWire,
} from "../../hooks/use-studio-qa";

/** "$0.13" or "$0.13 quoted" — the basis travels with the money, as it does everywhere in Studio. */
export function costText(cost: QaCostWire | null): string | null {
  if (!cost) return null;
  const usd = `$${cost.usd.toFixed(2)}`;
  return cost.basis === "authoritative" ? usd : `${usd} quoted`;
}

/** The chip's wording. Only the server's label — never a figure from the verdict. */
export function verdictText(v: QaVerdictWire | null): string {
  return v ? v.label : "Not checked";
}

interface Props {
  assetId: string | null | undefined;
  /** `dark` on the viewer's black bar; `light` on a card. Colour only. */
  tone?: "light" | "dark";
}

/**
 * The flag is decided here, BEFORE any hook runs. Off, this mounts nothing — not a query, not a
 * QueryClient lookup — so a card rendered with the flag off is byte-for-byte the card it was, and a
 * test that renders one needs no provider it did not need before.
 */
export function QaChip(props: Props) {
  if (!STUDIO_QA_DISPLAY || !props.assetId) return null;
  return <QaChipLive {...props} assetId={props.assetId} />;
}

function QaChipLive({ assetId, tone = "light" }: Props & { assetId: string }) {
  const q = useAssetQa(assetId);
  if (!q.data) return null;

  const { verdict, cost, structure } = q.data;
  // quality-scrappy piece 2: a structure finding flags the chip too, in the same two words. A clip the vision checks
  // passed but that came back black is flagged — the worst of the two, never an average, and never a number.
  const flagged = verdict?.wording === "flag" || structure?.wording === "flag";
  const label =
    verdict && (verdict.wording === "flag" || !structure || !flagged)
      ? verdict.label
      : (structure?.label ?? verdictText(verdict));
  const dark = tone === "dark";
  const price = costText(cost);

  return (
    <View style={styles.row} testID="qa-chip">
      <View
        style={[
          styles.pill,
          dark && styles.pillDark,
          flagged && (dark ? styles.pillFlagDark : styles.pillFlag),
        ]}
      >
        <Feather
          name={verdict || structure ? (flagged ? "flag" : "check") : "minus"}
          size={11}
          color={
            dark
              ? Bold.onDark
              : flagged
                ? Colors.light.primary
                : Colors.light.textSecondary
          }
        />
        <Text
          style={[
            styles.pillTx,
            dark && styles.pillTxDark,
            !dark && flagged && styles.pillTxFlag,
          ]}
        >
          {label}
        </Text>
      </View>
      {price ? (
        <Text
          style={[styles.cost, dark && styles.costDark]}
          accessibilityLabel={`Cost ${price}`}
        >
          {price}
        </Text>
      ) : null}
      {structure?.wording === "flag" && structure.lines.length ? (
        <Text
          style={[styles.obs, dark && styles.obsDark]}
          numberOfLines={2}
          testID="qa-structure"
        >
          {structure.lines.join(" ")}
        </Text>
      ) : null}
      {verdict?.identityObservation ? (
        <Text style={[styles.obs, dark && styles.obsDark]} numberOfLines={1}>
          Identity: {verdict.identityObservation.caption.toLowerCase()}
        </Text>
      ) : null}
      {/* PR 17 (R-6): the clip's drift line — the same observation posture, one more line, and only
          in a build with EXPO_PUBLIC_STUDIO_IDENTITY_DRIFT on. ⚠️ MUTATION (QaChip.test "drift shown
          as pass/fail"): word it with the verdict's vocabulary. */}
      {STUDIO_IDENTITY_DRIFT && verdict?.driftObservation ? (
        <Text
          style={[styles.obs, dark && styles.obsDark]}
          numberOfLines={2}
          testID="qa-drift"
        >
          Drift: {verdict.driftObservation.caption.toLowerCase()} —{" "}
          {verdict.driftObservation.line}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: Colors.light.backgroundDefault,
  },
  pillDark: { backgroundColor: "rgba(255,255,255,0.14)" },
  pillFlag: { backgroundColor: Colors.light.primaryLight },
  pillFlagDark: { backgroundColor: "rgba(255,255,255,0.24)" },
  pillTx: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11.5,
    fontWeight: "600",
    color: Colors.light.textSecondary,
  },
  pillTxDark: { color: Bold.onDark },
  pillTxFlag: { color: Colors.light.primary },
  cost: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11.5,
    fontWeight: "500",
    color: Colors.light.textSecondary,
  },
  costDark: { color: "#D9D3C8" },
  obs: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textSecondary,
    flexShrink: 1,
  },
  obsDark: { color: "#D9D3C8" },
});
