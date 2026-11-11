/**
 * RequestDocumentSheet — she hands over a document she asked Nomila to prompt her for (Checkpoint 1, slice 1).
 *
 * Opened from Mila's "Add document" chip for one of her requests (for example, performance data from a past
 * partnership). ACQUISITION IS NOT UNDERSTANDING, said to her plainly: the file is kept with her records and nothing in
 * it is read, so it will not change what Nomila recommends until Nomila can read that kind of document.
 *
 * Upload goes straight to storage on a signed URL minted for THIS request; the API only records the reference.
 */
import React, { useState } from "react";
import { View, Text, Modal, Pressable, ActivityIndicator, StyleSheet, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
// SDK 54 moved the classic FileSystem API (uploadAsync) to the `legacy` entry.
import * as FileSystem from "expo-file-system/legacy";
import { apiRequest } from "../../lib/query-client";
import { tap, success as hapticSuccess, warning as hapticWarning } from "../../lib/haptics";

const TYPES = [
  "application/pdf", "text/csv", "text/plain",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg", "image/png", "image/heic", "image/webp",
];

interface Props {
  visible: boolean;
  requestId: string | null;
  onClose: () => void;
  /** Fired after the document is recorded against her request. */
  onDone: () => void;
}

export function RequestDocumentSheet({ visible, requestId, onClose, onDone }: Props) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function close() { setWorking(false); setError(null); setDone(false); onClose(); }

  async function pickAndUpload() {
    if (!requestId) return;
    tap();
    setError(null);
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: TYPES, copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      const contentType = a.mimeType || "application/pdf";
      setWorking(true);
      const mintRes = await apiRequest("POST", `/api/v1/me/intelligence-requests/${requestId}/upload-url`, {
        filename: a.name ?? "document", contentType, bytes: a.size ?? undefined,
      });
      const mint = await mintRes.json();
      if (!mint.uploadUrl) throw new Error(mint.error ?? "Could not start the upload");
      if (Platform.OS === "web") {
        const body = ((a as any).file as Blob | undefined) ?? (await (await fetch(a.uri)).blob());
        const put = await fetch(mint.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      } else {
        const put = await FileSystem.uploadAsync(mint.uploadUrl, a.uri, {
          httpMethod: "PUT", uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: { "Content-Type": contentType },
        });
        if (put.status < 200 || put.status >= 300) throw new Error(`Upload failed (${put.status})`);
      }
      const rec = await apiRequest("POST", `/api/v1/me/intelligence-requests/${requestId}/artifact`, {
        gcsPath: mint.gcsPath, filename: a.name ?? "document", contentType, bytes: a.size ?? 0,
      });
      if (!rec.ok) throw new Error((await rec.json().catch(() => null))?.error ?? "Could not save that document");
      hapticSuccess();
      setDone(true);
      onDone();
    } catch (e: any) {
      hapticWarning();
      setError(e?.message ?? "Something went wrong");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{done ? "Got it" : "Add a document"}</Text>
          <Text style={styles.body}>
            {done
              ? "It's saved with your records. I can't read this kind of document yet, so it won't change what I recommend until I can."
              : "I'll keep it with your records. I can't read performance reports yet — it won't change what I recommend until I can."}
          </Text>
          {error && <Text style={styles.error}>{error}</Text>}
          {working ? (
            <ActivityIndicator style={{ marginTop: 16 }} />
          ) : done ? (
            <Pressable accessibilityRole="button" style={styles.primary} onPress={close}><Text style={styles.primaryText}>Done</Text></Pressable>
          ) : (
            <View style={styles.row}>
              <Pressable accessibilityRole="button" style={styles.secondary} onPress={close}><Text style={styles.secondaryText}>Not now</Text></Pressable>
              <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void pickAndUpload()}><Text style={styles.primaryText}>Choose file</Text></Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: "#15151B", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 },
  title: { color: "#FFFFFF", fontSize: 18, fontWeight: "600", marginBottom: 8 },
  body: { color: "rgba(255,255,255,0.8)", fontSize: 14, lineHeight: 20 },
  error: { color: "#FF8A80", marginTop: 12, fontSize: 13 },
  row: { flexDirection: "row", gap: 12, marginTop: 20 },
  primary: { flex: 1, backgroundColor: "#FFFFFF", borderRadius: 999, paddingVertical: 12, alignItems: "center", marginTop: 20 },
  primaryText: { color: "#0B0B0F", fontWeight: "600" },
  secondary: { flex: 1, borderRadius: 999, paddingVertical: 12, alignItems: "center", marginTop: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  secondaryText: { color: "rgba(255,255,255,0.85)" },
});
