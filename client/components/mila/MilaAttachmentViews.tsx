/**
 * MilaAttachmentViews — how Mila's chat shows what she attached with the composer's ＋: a chip above the input while it
 * uploads and waits for the next send (thumbnail, a spinner or a failure mark, the role's badge, a remove ×), and the
 * thumbnail row inside her sent bubble. Moved here unchanged from MilaSearchOverlay so the old chat and chat v2
 * (thread/) draw the same pieces from the same code.
 */
import React from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { N } from "../deals/opps/tokens";
import { SOFT_LIFT } from "./Frost";
import { haptics } from "../../lib/haptics";

export type MilaAttachmentRole = "photo" | "video" | "product";

const glyph = (role: MilaAttachmentRole) => (role === "video" ? "video" : role === "product" ? "tag" : "image");

/** One staged attachment above the input. */
export function MilaAttachmentChip({
  uri, role, status, onRemove, testID,
}: {
  uri: string;
  role: MilaAttachmentRole;
  status: "uploading" | "ready" | "failed";
  onRemove: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.chip} testID={testID}>
      <Image source={{ uri }} style={styles.chipThumb} />
      {status === "uploading" ? (
        <View style={styles.chipOverlay} testID={testID ? `${testID}-uploading` : undefined}><ActivityIndicator size="small" color="#fff" /></View>
      ) : status === "failed" ? (
        <View style={[styles.chipOverlay, styles.chipFailed]} testID={testID ? `${testID}-failed` : undefined}><Feather name="alert-circle" size={16} color="#fff" /></View>
      ) : null}
      <View style={styles.chipBadge}>
        <Feather name={glyph(role)} size={10} color="#fff" />
      </View>
      <Pressable
        onPress={() => { haptics.press(); onRemove(); }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Remove attachment"
        style={styles.chipRemove}
      >
        <Feather name="x" size={11} color={N.ink900} />
      </Pressable>
    </View>
  );
}

/** The chips' row (wraps). */
export function MilaAttachmentChipRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.chipsRow}>{children}</View>;
}

/** The thumbnails at the top of her sent bubble (a role glyph when there is no picture). */
export function MilaBubbleThumbs({ items }: { items: ReadonlyArray<{ key: string; thumbUrl: string | null; role: MilaAttachmentRole }> }) {
  if (!items.length) return null;
  return (
    <View style={styles.bubbleThumbs} testID="mila-bubble-thumbs">
      {items.map((a) => (
        a.thumbUrl ? (
          <Image key={a.key} source={{ uri: a.thumbUrl }} style={styles.bubbleThumb} accessibilityLabel={a.role} />
        ) : (
          <View key={a.key} style={[styles.bubbleThumb, styles.bubbleThumbEmpty]}>
            <Feather name={glyph(a.role)} size={16} color="#fff" />
          </View>
        )
      ))}
    </View>
  );
}

// Values from MilaSearchOverlay's StyleSheet (unchanged).
const styles = StyleSheet.create({
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: { width: 56, height: 56, borderRadius: 12, overflow: "visible" },
  chipThumb: { width: 56, height: 56, borderRadius: 12, backgroundColor: N.cream300 },
  chipOverlay: { position: "absolute", inset: 0, borderRadius: 12, backgroundColor: "rgba(26,26,26,0.45)", alignItems: "center", justifyContent: "center" },
  chipFailed: { backgroundColor: "rgba(194,52,47,0.75)" },
  chipBadge: { position: "absolute", left: 4, bottom: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(26,26,26,0.7)", alignItems: "center", justifyContent: "center" },
  chipRemove: { position: "absolute", right: -6, top: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: N.white, ...SOFT_LIFT, alignItems: "center", justifyContent: "center" },
  bubbleThumbs: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  bubbleThumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.25)" },
  bubbleThumbEmpty: { alignItems: "center", justifyContent: "center" },
});
