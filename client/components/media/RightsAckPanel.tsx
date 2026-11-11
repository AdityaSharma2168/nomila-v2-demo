/**
 * RightsAckPanel — the one-time media rights attestation, shown inline when the upload endpoint
 * answers 428 `rights_ack_required`.
 *
 * Inline on purpose, never `Alert.alert`: react-native-web's Alert is a literal no-op
 * (`static alert() {}`), so an OS dialog means the panel never appears on web, the retry never
 * fires, and the upload dies silently. Shared by both upload surfaces (the Studio library and the
 * card editor's picker) so the two attest to identical wording.
 *
 * The checkbox is deliberate friction. The server persists the ack once, per athlete
 * (`athletes.media_rights_ack_at`), and never asks again — so this single tap covers every future
 * upload, and a lone button would get tapped reflexively as "dismiss". The copy says so.
 */
import React, { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Fonts, Colors } from "../../constants/theme";

const MUTED = "#9C968D";

interface Props {
  busy: boolean;
  /** Fires only once the athlete has ticked the box — the caller then retries with ackRights: true. */
  onConfirm: () => void;
  onCancel: () => void;
}

export function RightsAckPanel({ busy, onConfirm, onCancel }: Props) {
  const [checked, setChecked] = useState(false);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Confirm you have the rights</Text>
      <Text style={styles.body}>
        These photos and videos are mine, or I have permission to use them. I&apos;m confirming I have the
        rights to use the media I upload in my Nomi Card, media kits, and brand shares.
      </Text>

      <Pressable
        style={styles.checkRow}
        onPress={() => setChecked((v) => !v)}
        disabled={busy}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: busy }}
        accessibilityLabel="I have the rights to this media"
        hitSlop={6}
      >
        <View style={[styles.box, checked && styles.boxOn]}>
          {checked ? <Feather name="check" size={13} color="#FFFFFF" /> : null}
        </View>
        <Text style={styles.checkTx}>I have the rights to this media</Text>
      </Pressable>

      <View style={styles.row}>
        <Pressable
          style={[styles.btn, !checked && styles.btnOff]}
          onPress={onConfirm}
          disabled={!checked || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !checked || busy }}
        >
          {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.btnTx}>I confirm</Text>}
        </Pressable>
        <Pressable onPress={onCancel} disabled={busy} hitSlop={6}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>Asked once — this covers media you upload later too.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, padding: 12, gap: 10,
  },
  title:    { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  body:     { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.text },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  box: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: Colors.light.border,
    backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center",
  },
  boxOn:    { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  checkTx:  { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.text },
  row:      { flexDirection: "row", alignItems: "center", gap: 14 },
  btn: {
    backgroundColor: Colors.light.primary, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9,
    minWidth: 120, alignItems: "center",
  },
  btnOff:   { opacity: 0.4 },
  btnTx:    { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: "#FFFFFF" },
  cancel:   { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: MUTED },
  note:     { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: MUTED },
});
