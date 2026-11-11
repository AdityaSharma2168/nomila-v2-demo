// NotForMeSheet — saying no to a deal (deals design §7 "Not for me"; replaces the board's bare Alert decline).
//
//   Why?            three reasons, which are the label the inbox learns from (POST /me/deals/:id/dispose):
//                     Not interested  — a real offer, not right for her       → not_interested
//                     Not a real deal — spam, mass mail or a scam             → not_a_deal
//                     Too late        — the date or offer has passed          → expired
//   a polite no     optional, and never for "Not a real deal" (nobody answers spam). Mila drafts it (the decline reply);
//                   it is editable and goes out only on "Close and send" — her tap, the governed send
//   the receipt     "Closed as not interested · by you" with Undo — her own act, labelled as hers
//
// "Just close it" sends nothing.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, Switch, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../lib/query-client";
import { useDealDraft } from "../../hooks/use-deal-draft";
import { proposeAndApproveReply, sendErrorMessage } from "../../hooks/use-pending-actions";
import { invalidateDealQueries } from "../../lib/dealQueryKeys";
import { Button, LinkText } from "../ui";
import { BoldSheet } from "./BoldSheet";
import { NOT_FOR_ME_REASONS, politeNoAllowed, type NotForMeReason } from "./notForMeLogic";
import { isDisposeReceipt, undoLatest } from "./receipts";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";

export function NotForMeSheet({ dealId, threadId, brandName, canReply = true, onClose, onClosed }: {
  dealId: string;
  threadId: string | null;
  brandName: string;
  /** False when there is no thread to answer on (a deal she added herself): no polite-no offer. */
  canReply?: boolean;
  onClose: () => void;
  /** After she leaves the receipt (closed, or closed then undone). */
  onClosed: (undone: boolean) => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<NotForMeReason | null>(null);
  const [sayNo, setSayNo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<null | { reason: NotForMeReason; sent: boolean; undone: boolean }>(null);
  const { draft, streaming, error: draftError, generate, editDraft, threadId: draftThread } = useDealDraft(dealId);
  const asked = useRef(false);

  const offerNo = canReply && !!threadId && reason != null && politeNoAllowed(reason);
  useEffect(() => {
    if (offerNo && sayNo && !asked.current) {
      asked.current = true;
      void generate({ reply_intent: "decline", intent: "decline" });
    }
  }, [offerNo, sayNo, generate]);

  const close = async (send: boolean) => {
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The no goes first: if it can't go out, nothing is closed and her text stays.
      if (send && offerNo) {
        const onThread = draftThread ?? threadId;
        if (!onThread || !draft.trim()) throw new Error("NO_TEXT");
        await proposeAndApproveReply({ dealId, threadId: onThread, body: draft, payload: { reply_intent: "decline" } });
      }
      await apiRequest("POST", `/api/v1/me/deals/${dealId}/dispose`, { disposition: reason });
      haptics.success();
      void invalidateDealQueries(qc);
      setReceipt({ reason, sent: send && offerNo, undone: false });
    } catch (err) {
      setError(err instanceof Error && err.message === "NO_TEXT" ? "Write the short no first, or just close it." : sendErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    try {
      await undoLatest(dealId, "reclassify", isDisposeReceipt);
      void invalidateDealQueries(qc);
      setReceipt((r) => (r ? { ...r, undone: true } : r));
    } catch {
      setError("That didn’t undo. Try again.");
    } finally { setBusy(false); }
  };

  if (receipt) {
    const label = NOT_FOR_ME_REASONS.find((r) => r.key === receipt.reason)!.receipt;
    const done = () => { onClosed(receipt.undone); onClose(); };
    return (
      <BoldSheet title={receipt.undone ? "Back on your list" : "Closed"} sub={receipt.sent ? `Your short no went to ${brandName}.` : `Nothing was sent to ${brandName}.`} onClose={done} testID="not-for-me-receipt">
        <View style={styles.receipt}>
          <Text style={styles.receiptLine}>{receipt.undone ? "Reopened · by you" : `${label} · by you`}</Text>
          {!receipt.undone ? <LinkText onPress={undo} arrow={false} testID="not-for-me-undo">Undo</LinkText> : null}
        </View>
        {receipt.sent && !receipt.undone ? <Text style={styles.hint}>Undo reopens the deal here. The email has already gone.</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button bold="secondary" onPress={done}>Done</Button>
      </BoldSheet>
    );
  }

  return (
    <BoldSheet
      title="Not for me"
      sub={`${brandName}. Why? This helps Mila sort your inbox.`}
      onClose={onClose}
      closeDisabled={busy}
      testID="not-for-me"
      footer={
        <>
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
          {offerNo && sayNo ? (
            <Button bold="primary" onPress={() => close(true)} disabled={!reason || busy || streaming || !draft.trim()} loading={busy} testID="not-for-me-send">Close and send</Button>
          ) : null}
          <Button bold={offerNo && sayNo ? "secondary" : "primary"} onPress={() => close(false)} disabled={!reason || busy} loading={busy && !(offerNo && sayNo)} testID="not-for-me-close">Just close it</Button>
          <Text style={styles.safety}>Nothing goes out until you tap Send.</Text>
        </>
      }
    >
      <View style={styles.reasons} accessibilityRole="radiogroup">
        {NOT_FOR_ME_REASONS.map((r) => {
          const on = reason === r.key;
          return (
            <Pressable key={r.key} onPress={() => { haptics.select(); setReason(r.key); setError(null); }} accessibilityRole="radio" accessibilityState={{ checked: on }}
              accessibilityLabel={`${r.title}. ${r.meta}`} style={({ pressed }) => [styles.reason, on && styles.reasonOn, pressed && styles.pressed]} testID={`not-for-me-${r.key}`}>
              <View style={styles.reasonText}>
                <Text style={[styles.reasonTitle, on && styles.onDark]}>{r.title}</Text>
                <Text style={[styles.reasonMeta, on && styles.onDarkSoft]}>{r.meta}</Text>
              </View>
              {on ? <Feather name="check" size={18} color={Bold.onDark} /> : null}
            </Pressable>
          );
        })}
      </View>

      {offerNo ? (
        <View style={styles.no}>
          <View style={styles.noHead}>
            <Text style={styles.noTitle}>Send them a short no?</Text>
            <Switch value={sayNo} onValueChange={setSayNo} trackColor={{ false: Bold.track, true: Bold.ink }} thumbColor={Bold.paper}
              {...({ activeThumbColor: Bold.paper } as object)} accessibilityLabel="Send them a short no" testID="not-for-me-say-no" />
          </View>
          {sayNo ? (
            streaming && !draft ? (
              <View style={styles.drafting}><ActivityIndicator color={Bold.ink} /><Text style={styles.hint}>Mila is drafting…</Text></View>
            ) : (
              <TextInput style={styles.draft} value={draft} onChangeText={editDraft} multiline textAlignVertical="top"
                accessibilityLabel="Your short no. You can edit it." testID="not-for-me-draft" />
            )
          ) : null}
          {sayNo && draftError ? <Text style={styles.error}>{draftError}</Text> : null}
        </View>
      ) : null}
    </BoldSheet>
  );
}

const styles = StyleSheet.create({
  reasons:     { gap: 8 },
  reason:      { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, backgroundColor: Bold.paper },
  reasonOn:    { backgroundColor: Bold.ink, borderColor: Bold.ink },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  reasonText:  { flex: 1, gap: 2 },
  reasonTitle: { ...BoldType.rowTitle, color: Bold.ink },
  reasonMeta:  { ...BoldType.rowMeta, color: Bold.mute },
  onDark:      { color: Bold.onDark },
  onDarkSoft:  { color: Bold.onDarkLabel },
  no:          { gap: 8, borderTopWidth: 1, borderTopColor: Bold.line, paddingTop: 12 },
  noHead:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  noTitle:     { ...BoldType.h4, color: Bold.ink },
  draft:       { ...BoldType.body, color: Bold.ink, minHeight: 120, padding: 12, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control },
  drafting:    { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  hint:        { ...BoldType.caption, color: Bold.mute },
  error:       { ...BoldType.caption, color: Bold.ink },
  safety:      { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  receipt:     { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44, borderTopWidth: 1, borderBottomWidth: 1, borderColor: Bold.line },
  receiptLine: { ...BoldType.rowTitle, color: Bold.ink, flex: 1 },
});
