/**
 * ExportDataSheet — Settings › Account › Download your data (mockup 2a–2d, 5 Nov 2026). The shared Sheet: what the file
 * holds and what it doesn't, one raspberry Download; then "Putting your file together…" with Cancel (aborts the
 * request); then this sheet closes and the phone's own share sheet opens (web: the browser downloads the file); on a
 * failure, plain words and Try again. One JSON file (GET /api/v1/me/export); media files come later.
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { Sheet, Button } from "../ui";
import { deliverExport, prepareExport, type PreparedExport } from "../../lib/account-api";
import { logger } from "../../lib/logger";
import { Bold, BoldType } from "../../constants/theme";
import { SoftButton } from "./accountButtons";

export const EXPORT_COPY = {
  title: "Download your data",
  intro: "You get one file with everything Nomila holds about you: your account, About you, goals, deals and payments, brands, connected-account stats, chats with Mila, your media list, Studio work and receipts for what Nomila did for you.",
  notInFile: "Not in the file",
  notIn: [
    ["Your email and DM text.", " Nomila reads it live from Gmail, Outlook or Instagram and does not keep it."],
    ["Photo, video and contract files.", " Their records are in the file. The files themselves will come as a separate download later."],
    ["Passwords and access keys,", " and other people's details."],
  ] as const,
  download: "Download",
  fileNote: "A .json file. You can open it in any text editor.",
  preparing: "Putting your file together…",
  preparingSub: "This usually takes a few seconds.",
  cancel: "Cancel",
  error: "We couldn't make your file just now. Nothing was changed. Check your connection and try again.",
  retry: "Try again",
  close: "Close",
} as const;

type State = "intro" | "preparing" | "error";

export function ExportDataSheet({ onClose, testDeliver }: {
  onClose: () => void;
  /** Tests: replaces handing the file to the share sheet / browser. */
  testDeliver?: (file: PreparedExport) => void;
}) {
  const c = EXPORT_COPY;
  const [state, setState] = useState<State>("intro");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function start() {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState("preparing");
    try {
      const file = await prepareExport(ctrl.signal);
      if (ctrl.signal.aborted) return;
      onClose();
      // iOS will not open the share sheet over a Modal that is still closing.
      const deliver = testDeliver ?? ((f: PreparedExport) => { void deliverExport(f).catch((err) => logger.error("export share failed", err)); });
      if (testDeliver) deliver(file);
      else setTimeout(() => deliver(file), Platform.OS === "ios" ? 450 : 0);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      logger.warn("export failed", err);
      setState("error");
    }
  }

  function cancel() {
    abort.current?.abort();
    setState("intro");
  }

  return (
    <Sheet onClose={() => { abort.current?.abort(); onClose(); }} title={c.title}>
      {state === "intro" ? (
        <View testID="export-intro">
          <Text style={styles.body}>{c.intro}</Text>
          <Text style={styles.label}>{c.notInFile}</Text>
          <View style={styles.list}>
            {c.notIn.map(([b, rest], i) => (
              <View key={b} style={[styles.li, i > 0 && styles.liLine]}>
                <View style={styles.dot} />
                <Text style={styles.liText}><Text style={styles.liBold}>{b}</Text>{rest}</Text>
              </View>
            ))}
          </View>
          <Button bold="primary" onPress={start} style={styles.btn} testID="export-download">{c.download}</Button>
          <Text style={styles.fileNote}>{c.fileNote}</Text>
        </View>
      ) : state === "preparing" ? (
        <View testID="export-preparing">
          <View style={styles.waiting}>
            <ActivityIndicator size="small" color={Bold.ink} />
            <Text style={[styles.body, styles.waitingText]}>{c.preparing}</Text>
            <Text style={styles.fileNote}>{c.preparingSub}</Text>
          </View>
          <SoftButton onPress={cancel} testID="export-cancel">{c.cancel}</SoftButton>
        </View>
      ) : (
        <View testID="export-error">
          <View style={styles.warn}><Text style={styles.warnText}>{c.error}</Text></View>
          <Button bold="primary" onPress={start} style={styles.btn} testID="export-retry">{c.retry}</Button>
          <SoftButton onPress={onClose} testID="export-close">{c.close}</SoftButton>
        </View>
      )}
    </Sheet>
  );
}

export const accountSheetStyles = StyleSheet.create({
  body:     { ...BoldType.body, color: Bold.ink2, marginTop: 8, marginBottom: 4 },
  label:    { ...BoldType.label, color: Bold.mute, marginTop: 18, marginBottom: 8 },
  list:     { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, overflow: "hidden" },
  li:       { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  liLine:   { borderTopWidth: 1, borderTopColor: Bold.line },
  dot:      { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.ink, marginTop: 8 },
  dotQuiet: { backgroundColor: Bold.quiet },
  liText:   { ...BoldType.lede, color: Bold.ink2, flex: 1 },
  liBold:   { fontFamily: BoldType.rowTitle.fontFamily, fontWeight: BoldType.rowTitle.fontWeight, color: Bold.ink },
  btn:      { height: Bold.button, alignSelf: "stretch", marginTop: 16 },
  fileNote: { ...BoldType.caption, color: Bold.mute, textAlign: "center", marginTop: 12 },
  warn:     { backgroundColor: "#FEF2F2", borderRadius: Bold.radius.card, paddingHorizontal: 14, paddingVertical: 12, marginTop: 8 },
  warnText: { ...BoldType.rowMeta, color: "#7f1d1d" },
});

const styles = StyleSheet.create({
  ...accountSheetStyles,
  dot:         { ...accountSheetStyles.dot, backgroundColor: Bold.quiet },
  waiting:     { alignItems: "center", paddingTop: 28, paddingBottom: 8 },
  waitingText: { marginTop: 14, textAlign: "center" },
});
