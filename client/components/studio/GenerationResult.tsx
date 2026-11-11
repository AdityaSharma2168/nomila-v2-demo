/**
 * GenerationResult — what came out, and the two decisions she can make about it.
 *
 * A generated asset is born `draft` and is not cleared for anything until she says so. So this view
 * shows the picture and exactly two buttons, and it renders them from `allowedNext` — the server's
 * own account of what the clearance machine will accept — rather than from a guess. That is why
 * there is no "un-approve": from `approved` the only legal move is `rejected`, and a button that
 * cannot work is worse than a missing one.
 *
 * REJECT IS ONE GESTURE. If the asset is sitting in a pitch deck, rejecting it is two ordered
 * database acts (take it out of the deck, then withdraw clearance) — but that is our problem, not
 * hers. She taps once; the server does both and answers with a sentence saying what happened.
 *
 * AND THE PICTURE IS TAPPABLE, because this is the surface the decision is made on. The card is
 * bounded to ~55% of the window so the two buttons stay visible (see RESULT_MAX_*), which is
 * exactly the size at which a bad seam or a soft retouch is invisible. Approve/Reject with nothing
 * between them and a full-size look is a decision taken on a thumbnail. The viewer opens on the
 * SAME signed url this <Image> is already showing — no second read, no gcs path, no re-signing.
 */
import React, { useState } from "react";
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet, useWindowDimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { GeneratedAsset } from "../../hooks/use-studio";
import { AssetViewer } from "./AssetViewer";
import { QaChip } from "./QaChip";
import { OutputGateNotice } from "./OutputGateNotice";
import { Brand, Colors, Fonts, Spacing, Bold } from "../../constants/theme";

const MUTED = "#9C968D";

/**
 * The ceiling on the rendered result, absolute and as a share of the window — whichever is smaller.
 * Mirrors the mask editor's stage bound, for the same reason: a full-width portrait pushed the
 * approve and reject controls off the bottom, and a decision she cannot see the buttons for is not
 * a decision she can make.
 */
const RESULT_MAX_ABS_H = 520;
const RESULT_MAX_WINDOW_FRACTION = 0.55;

const STATUS_LABEL: Record<string, string> = {
  draft: "Not cleared yet",
  approved: "Cleared",
  rejected: "Rejected",
};

interface Props {
  assets: GeneratedAsset[];
  /** True while a clearance call is in flight — every button locks, not just the one tapped. */
  busy: boolean;
  /** The sentence the server sent back about the last decision ("Removed from 2 decks and rejected."). */
  note: string | null;
  error: string | null;
  onDecide: (assetId: string, action: "approve" | "reject" | "reopen") => void;
  /**
   * quality-scrappy piece 5: a fresh check of the same job with the gate's fix, for an output it failed. Only asks —
   * the spend is her Generate tap on the quote that comes back. Absent: the notice says what went wrong, no more.
   */
  onTryAgain?: (corrective: string[]) => void;
}

export function GenerationResult({ assets, busy, note, error, onDecide, onTryAgain }: Props) {
  // Before the early return — a hook after a conditional return is a hook that sometimes does not
  // run, which React does not allow.
  const { height: windowHeight } = useWindowDimensions();
  const [viewing, setViewing] = useState<GeneratedAsset | null>(null);

  // Bounded the same way the mask editor's stage is, and for the same reason: a full-width portrait
  // pushed the approve/reject controls under it off the screen. Display only — this scales the box
  // the result is drawn in and touches nothing about the asset.
  const resultHeight = Math.min(RESULT_MAX_ABS_H, windowHeight * RESULT_MAX_WINDOW_FRACTION);

  if (!assets.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.eyebrow}>WHAT CAME OUT</Text>

      {assets.map((a) => (
        <View key={a.assetId} style={styles.card}>
          {/* quality-scrappy piece 5: the gate failed it — said first, with why, before the picture. */}
          {gateNotice(a, onTryAgain)}
          {a.url ? (
            // `contain`, not `cover`. This is the surface she approves or rejects an edit on, and
            // `cover` cropped the result to the card's shape — you cannot judge a retouch you can
            // only see part of, and the part cropped away is exactly where a bad edit hides.
            // Letterboxing is fine HERE in a way it never was in the mask editor: nothing is drawn
            // on this image and no coordinate is measured against it.
            <Pressable
              onPress={() => setViewing(a)}
              accessibilityRole="button"
              accessibilityLabel="Open full screen"
            >
              <Image source={{ uri: a.url }} style={[styles.image, { height: resultHeight }]} resizeMode="contain" />
              {/* The affordance, quiet and in the corner — the picture is the button, this only
                  says so. Solid, not blurred: blur is for floating controls over media, and this
                  sits on a letterboxed field that is often flat black. */}
              <View style={styles.expand} pointerEvents="none">
                <Feather name="maximize-2" size={13} color={Bold.onDark} />
              </View>
            </Pressable>
          ) : (
            <View style={[styles.image, { height: resultHeight }, styles.imageEmpty]}>
              <Feather name="image" size={22} color={MUTED} />
            </View>
          )}

          <View style={styles.meta}>
            <View style={[styles.pill, a.approvalStatus === "approved" && styles.pillOk, a.approvalStatus === "rejected" && styles.pillOff]}>
              <Text style={[styles.pillTx, a.approvalStatus === "approved" && styles.pillTxOk]}>
                {STATUS_LABEL[a.approvalStatus ?? ""] ?? "Not cleared yet"}
              </Text>
            </View>
            {/* The check's word and the cost, behind EXPO_PUBLIC_STUDIO_QA_DISPLAY (PR 11). Off: null. */}
            <QaChip assetId={a.assetId} />
          </View>

          {/* Only the moves the machine will actually accept. */}
          <View style={styles.actions}>
            {a.allowedNext.includes("approved") && (
              <Decision
                icon="check"
                label={a.approvalStatus === "rejected" ? "Approve" : "Looks right"}
                primary
                busy={busy}
                onPress={() => onDecide(a.assetId, "approve")}
              />
            )}
            {a.allowedNext.includes("rejected") && (
              <Decision icon="x" label="Reject" busy={busy} onPress={() => onDecide(a.assetId, "reject")} />
            )}
            {a.allowedNext.includes("draft") && (
              <Decision icon="rotate-ccw" label="Reopen" busy={busy} onPress={() => onDecide(a.assetId, "reopen")} />
            )}
          </View>
        </View>
      ))}

      {note ? <Text style={styles.note}>{note}</Text> : null}
      {/* Always a sentence written for a person — the server never sends a database refusal through. */}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <AssetViewer
        visible={!!viewing}
        uri={viewing?.url ?? null}
        assetId={viewing?.assetId ?? null}
        onClose={() => setViewing(null)}
      />
    </View>
  );
}

/** quality-scrappy piece 5: the notice for an output the gate failed, or nothing. */
function gateNotice(a: GeneratedAsset, onTryAgain?: (corrective: string[]) => void) {
  const gate = a.gate;
  if (!gate || !("failed" in gate)) return null;
  return (
    <OutputGateNotice
      headline={gate.headline}
      lines={gate.lines}
      onTryAgain={onTryAgain ? () => onTryAgain(gate.corrective) : undefined}
    />
  );
}

function Decision({
  icon, label, primary, busy, onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string; primary?: boolean; busy: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.btn, primary ? styles.btnPrimary : styles.btnGhost, busy && styles.btnOff]}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={primary ? "#FFFFFF" : Colors.light.text} />
      ) : (
        <>
          <Feather name={icon} size={14} color={primary ? "#FFFFFF" : Colors.light.text} />
          <Text style={[styles.btnTx, primary && styles.btnTxPrimary]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap:       { paddingHorizontal: Spacing.lg, paddingTop: 20, gap: 12 },
  eyebrow:    { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: MUTED },
  card:       { borderRadius: 28, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: Colors.light.border, overflow: "hidden", gap: 10, paddingBottom: 12 },
  // Height is supplied per-render from the window; see resultHeight.
  image:      { width: "100%", backgroundColor: Brand.heroBg },
  expand: {
    position: "absolute", right: 10, bottom: 10,
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.26)",
    backgroundColor: "rgba(12,13,16,0.5)",
    alignItems: "center", justifyContent: "center",
  },
  imageEmpty: { alignItems: "center", justifyContent: "center" },
  meta:       { flexDirection: "row", alignItems: "center", paddingHorizontal: 12 },
  pill:       { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: Colors.light.backgroundDefault },
  pillOk:     { backgroundColor: Colors.light.primaryLight },
  pillOff:    { backgroundColor: "#F1ECE6" },
  pillTx:     { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, fontWeight: "600", color: Colors.light.textSecondary },
  pillTxOk:   { color: Colors.light.primary },
  actions:    { flexDirection: "row", gap: 10, paddingHorizontal: 12 },
  btn:        { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 999, minWidth: 120, paddingHorizontal: 18, paddingVertical: 11 },
  btnPrimary: { backgroundColor: Colors.light.primary },
  btnGhost:   { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: Colors.light.border },
  btnOff:     { opacity: 0.5 },
  btnTx:      { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  btnTxPrimary: { color: "#FFFFFF" },
  note:       { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.textSecondary },
  error:      { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: "#B3261E" },
});
