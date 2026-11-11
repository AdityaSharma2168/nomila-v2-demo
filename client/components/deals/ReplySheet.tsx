// ReplySheet — the ONE reply sheet, look B (deals design §5c, §7 "Reply to Gymshark"; replaces DealActionSheet behind
// EXPO_PUBLIC_OPPS_V2).
//
//   the choices     the deal type's own reply intents (shared/deals INTENTS_BY_TYPE, served on the item) as chips,
//                   ALWAYS switchable — a seeded draft never locks them
//   their → yours   for a counter, one row per term that matters ("their term → your ask"); a one-figure reply (Share my
//                   rate, Propose paid) shows the fee row alone. Her fee is the ONLY figure the draft may state
//   the draft       written by the server's reply skill, editable; Mila redrafts when she changes the choice or a row
//   sign as         "You" by default; "<her team member>" only once she has named one in Settings (D2)
//   Send            the governed send: propose a send_reply on the thread the draft was written for, then approve it on
//                   the visible text (body hash). A failed send keeps her text and says why. A "yes" she sends may mark the
//                   deal agreed (D4): the receipt says so, labelled as hers, with Undo
//
// Nothing goes out until she taps Send. Closing keeps an edited draft on the deal (never in her Gmail drafts).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import type { DealType, ReplyIntent, TermKey, TermSheet } from "../../../shared/deals";
import { useDealDraft } from "../../hooks/use-deal-draft";
import { useDealPreferences } from "../../hooks/use-deals";
import { proposeAndApproveReply, sendErrorMessage } from "../../hooks/use-pending-actions";
import { invalidateDealQueries } from "../../lib/dealQueryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { Button, LinkText } from "../ui";
import { BoldSheet } from "./BoldSheet";
import { ChoiceChip, ChipRow } from "./ChoiceChip";
import { draftRequest, splitRows, teamMember, termRowsFor } from "./replySheetLogic";
import { isAgreedReceipt, undoLatest } from "./receipts";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";

export interface ReplySheetProps {
  dealId: string;
  /** The deal's lead thread: the fallback when the draft didn't name its thread. */
  threadId: string | null;
  brandName: string;
  dealType: DealType | null | undefined;
  /** The intents this type offers, with labels (the item's `actions`). */
  actions: Array<{ intent: ReplyIntent; label: string }>;
  terms?: Partial<TermSheet> | null;
  /** The chip it opens on (the letter's button). */
  initialIntent: ReplyIntent;
  /** Nomila's saved draft for this thread: shown instead of drafting afresh, still switchable. */
  seededDraft?: string | null;
  onClose: () => void;
  /** After a send (and after she leaves the receipt). */
  onSent: () => void;
}

export function ReplySheet({ dealId, threadId, brandName, dealType, actions, terms, initialIntent, seededDraft, onClose, onSent }: ReplySheetProps) {
  const qc = useQueryClient();
  const [intent, setIntent] = useState<ReplyIntent>(initialIntent);
  const [asks, setAsks] = useState<Partial<Record<TermKey, string>>>({});
  const [asTeam, setAsTeam] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<null | { agreed: boolean; undone: boolean; undoError: boolean }>(null);
  const dirty = useRef(false);   // she typed in the draft

  const prefs = useDealPreferences();
  const team = teamMember(prefs.data?.deal_preferences);
  const { draft, streaming, error, generate, editDraft, threadId: draftThread, persistDraft } = useDealDraft(dealId);
  const rows = useMemo(() => termRowsFor(intent, dealType, terms), [intent, dealType, terms]);
  const [allTerms, setAllTerms] = useState(false);
  const split = useMemo(() => splitRows(rows), [rows]);
  const visibleRows = allTerms ? rows : split.shown;

  const redraft = useCallback((next: { intent?: ReplyIntent; asTeam?: boolean; asks?: Partial<Record<TermKey, string>> } = {}) => {
    const i = next.intent ?? intent;
    dirty.current = false;
    setSendError(null);
    const req = draftRequest({ intent: i, asks: next.asks ?? asks, rows: termRowsFor(i, dealType, terms), asTeam: next.asTeam ?? asTeam });
    void generate(req);
  }, [intent, asks, asTeam, dealType, terms, generate]);

  // Open on the saved draft when there is one (switching still redrafts); otherwise draft the opening choice.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (seededDraft?.trim()) editDraft(seededDraft);
    else redraft();
  }, [seededDraft, editDraft, redraft]);

  const choose = (i: ReplyIntent) => {
    if (i === intent || sending) return;
    setIntent(i);
    redraft({ intent: i });
  };

  const close = () => {
    if (sending) return;
    // An edited, unsent draft stays on the deal (never in her Gmail drafts).
    if (!receipt && dirty.current && draft.trim()) void persistDraft(draft);
    onClose();
  };

  const send = async () => {
    const body = draft.trim();
    const onThread = draftThread ?? threadId;
    if (!body || !onThread || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await proposeAndApproveReply({ dealId, threadId: onThread, body: draft, payload: { reply_intent: intent } });
      haptics.success();
      void invalidateDealQueries(qc);
      if ((res as { deal_agreed?: boolean }).deal_agreed) setReceipt({ agreed: true, undone: false, undoError: false });
      else { onSent(); onClose(); }
    } catch (err) {
      // Her text stays exactly as it is; the line says what to do.
      setSendError(sendErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const undoAgreed = async () => {
    try {
      await undoLatest(dealId, "reopen", isAgreedReceipt);
      setReceipt((r) => (r ? { ...r, undone: true, undoError: false } : r));
      void invalidateDealQueries(qc);
    } catch {
      setReceipt((r) => (r ? { ...r, undoError: true } : r));
    }
  };

  if (receipt) {
    return (
      <BoldSheet title={`Sent to ${brandName}`} sub="From your inbox, exactly as you approved it." onClose={() => { onSent(); onClose(); }} testID="reply-sheet-receipt">
        <View style={styles.receipt}>
          <Text style={styles.receiptLine}>{receipt.undone ? "Back to where it was · by you" : "Marked agreed · by you"}</Text>
          {!receipt.undone ? <LinkText onPress={undoAgreed} arrow={false} testID="reply-undo-agreed">Undo</LinkText> : null}
        </View>
        {receipt.undoError ? <Text style={styles.error}>That didn’t undo. Try again.</Text> : null}
        <Button bold="secondary" onPress={() => { onSent(); onClose(); }}>Done</Button>
      </BoldSheet>
    );
  }

  const canSend = !!draft.trim() && !streaming && !sending && !!(draftThread ?? threadId);
  return (
    <BoldSheet
      title={`Reply to ${brandName}`}
      sub="On the email thread you’re in."
      onClose={close}
      closeDisabled={sending}
      testID="reply-sheet"
      footer={
        <>
          {sendError ? <Text style={styles.error} accessibilityRole="alert" testID="reply-send-error">{`Not sent. ${sendError} Your text is still here.`}</Text> : null}
          <Button bold="primary" onPress={send} disabled={!canSend} loading={sending} testID="reply-send">Send</Button>
          <Text style={styles.safety}>Nothing goes out until you tap Send.</Text>
        </>
      }
    >
      <ChipRow>
        {actions.map((a) => (
          <ChoiceChip key={a.intent} selected={a.intent === intent} onPress={() => choose(a.intent)} testID={`reply-intent-${a.intent}`}>{a.label}</ChoiceChip>
        ))}
      </ChipRow>

      {rows.length ? (
        <View style={styles.terms} testID="reply-terms">
          <View style={styles.termHead}>
            <Text style={[styles.colLabel, styles.colTerm]}>Their term</Text>
            <Text style={[styles.colLabel, styles.colAsk]}>Your ask</Text>
          </View>
          {visibleRows.map((r) => (
            <View key={r.term} style={styles.termRow}>
              <View style={styles.colTerm}>
                <Text style={styles.termLabel}>{r.label}</Text>
                <Text style={styles.termTheirs}>{r.theirs}</Text>
              </View>
              <TextInput
                style={[styles.input, styles.colAsk]}
                value={asks[r.term] ?? ""}
                onChangeText={(v) => setAsks((a) => ({ ...a, [r.term]: v }))}
                onEndEditing={(e) => { const v = e.nativeEvent.text ?? ""; redraft({ asks: { ...asks, [r.term]: v } }); }}
                placeholder={r.numeric ? "$" : "Your ask"}
                placeholderTextColor={Bold.quiet}
                keyboardType={r.numeric ? "decimal-pad" : "default"}
                accessibilityLabel={`Your ask for ${r.label}. They said: ${r.theirs}`}
                testID={`reply-ask-${r.term}`}
              />
            </View>
          ))}
          {!allTerms && split.more.length ? (
            <View style={styles.moreTerms}>
              <LinkText onPress={() => setAllTerms(true)} arrow={false} testID="reply-more-terms">{`More terms (${split.more.length})`}</LinkText>
            </View>
          ) : null}
        </View>
      ) : null}

      {team ? (
        <View style={styles.signAs}>
          <Text style={styles.colLabel}>Sign as</Text>
          <ChipRow>
            <ChoiceChip selected={!asTeam} onPress={() => { if (asTeam) { setAsTeam(false); redraft({ asTeam: false }); } }} testID="reply-sign-you">You</ChoiceChip>
            <ChoiceChip selected={asTeam} onPress={() => { if (!asTeam) { setAsTeam(true); redraft({ asTeam: true }); } }} testID="reply-sign-team"
              accessibilityLabel={`Send as my team: ${team.name}${team.role ? `, ${team.role}` : ""}`}>
              {team.role ? `${team.name} · ${team.role}` : team.name}
            </ChoiceChip>
          </ChipRow>
        </View>
      ) : null}

      <View style={styles.draftBox}>
        {streaming && !draft ? (
          <View style={styles.drafting}><ActivityIndicator color={Bold.ink} /><Text style={styles.hint}>Mila is drafting…</Text></View>
        ) : (
          <TextInput
            style={styles.draft}
            value={draft}
            onChangeText={(v) => { dirty.current = true; setSendError(null); editDraft(v); }}
            multiline
            editable={!sending}
            textAlignVertical="top"
            accessibilityLabel="Your reply. You can edit it."
            testID="reply-draft"
          />
        )}
      </View>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <Text style={styles.hint}>Mila redrafts when you change a choice or a row. You can edit the text.</Text>
    </BoldSheet>
  );
}

const styles = StyleSheet.create({
  terms:      { borderTopWidth: 1, borderTopColor: Bold.line },
  termHead:   { flexDirection: "row", gap: 12, paddingVertical: 8 },
  termRow:    { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: Bold.line },
  colTerm:    { flex: 1 },
  colAsk:     { flex: 1 },
  colLabel:   { ...BoldType.label, color: Bold.mute },
  termLabel:  { ...BoldType.rowMeta, color: Bold.mute },
  termTheirs: { ...BoldType.rowTitle, color: Bold.ink },
  input:      { ...BoldType.body, color: Bold.ink, minHeight: 44, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, backgroundColor: Bold.paper },
  signAs:     { gap: 6 },
  moreTerms:  { minHeight: 44, justifyContent: "center", borderTopWidth: 1, borderTopColor: Bold.line },
  draftBox:   { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, minHeight: 160 },
  draft:      { ...BoldType.body, color: Bold.ink, minHeight: 160, padding: 12 },
  drafting:   { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  hint:       { ...BoldType.caption, color: Bold.mute },
  error:      { ...BoldType.caption, color: Bold.ink },
  safety:     { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  receipt:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44, borderTopWidth: 1, borderBottomWidth: 1, borderColor: Bold.line },
  receiptLine:{ ...BoldType.rowTitle, color: Bold.ink },
});
