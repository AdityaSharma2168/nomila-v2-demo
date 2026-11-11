// BlockSheet — her "Block" confirm sheet (0154), from the booking detail, an open group's attendee, or a call tile.
// It loads the server's preview first and says exactly what will happen before she taps: they can't book her, request
// her or join her calls (and aren't told why); they leave the call now (from a tile); each upcoming paid booking of
// theirs is cancelled with a full refund (her cancel, so the card fee rule applies); pending requests are declined.
// Nothing happens until she taps the raspberry button.
import React, { useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { ConfirmSheet, ErrorLine, Loading, refusalLine } from "./parts";
import { useBlockFan, useBlockPreview, type BlockTarget } from "../../hooks/use-bookings";
import { blockSheetLines } from "../../lib/bookingSessionLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import type { BlockResultView } from "../../lib/bookingsTypes";

export function BlockSheet({ target, identity = null, name, inCall = false, onClose, onDone, testID = "block-sheet" }: {
  target: BlockTarget; identity?: string | null; name: string; inCall?: boolean;
  onClose: () => void; onDone: (r: BlockResultView) => void; testID?: string;
}) {
  const preview = useBlockPreview(target, identity);
  const block = useBlockFan(target);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;
  const who = p?.firstName ?? name;
  const confirm = () => {
    setError(null);
    block.mutate({ identity, reason: reason.trim() || undefined }, {
      onSuccess: (r) => { haptics.success(); onDone(r); },
      onError: (err) => setError(refusalLine(err, "Couldn't block them. Nothing changed. Try again.")),
    });
  };
  return (
    <ConfirmSheet title={`Block ${who}?`} confirm={p?.cancels.length ? `Block and refund ${who}` : `Block ${who}`} cancelLabel="Not now"
      onConfirm={confirm} onClose={onClose} busy={block.isPending || preview.isLoading} error={error} testID={testID}>
      {preview.isLoading ? <Loading testID={`${testID}-loading`} /> : null}
      {preview.isError ? <ErrorLine text="Couldn't check their bookings. Check your connection." testID={`${testID}-preview-error`} /> : null}
      {p ? blockSheetLines(p, inCall).map((line, i) => <Text key={i} style={styles.body} testID={`${testID}-line-${i}`}>{line}</Text>) : null}
      <Text style={styles.label}>Note for you (optional)</Text>
      <TextInput value={reason} onChangeText={setReason} placeholder="Why, so you remember" placeholderTextColor={Bold.quiet} maxLength={300}
        style={styles.input} accessibilityLabel="Note for you" testID={`${testID}-reason`} />
      <Text style={styles.caption}>You can unblock them any time from Your sessions › Blocked fans.</Text>
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  body:    { ...BoldType.body, color: Bold.ink },
  label:   { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  caption: { ...BoldType.caption, color: Bold.mute },
  input:   { ...BoldType.body, color: Bold.ink, minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12 },
});
