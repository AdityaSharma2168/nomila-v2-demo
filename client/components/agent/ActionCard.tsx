/**
 * ActionCard (agent/1 `action`) — something waiting for the athlete's tap: a reply to send, a post, a publish, a deal
 * response, a payment, an invite. The draft is shown in full; Edit opens it in place; the verb's button (Send · Post ·
 * Publish · Confirm …) is the ONLY thing that executes, through the approval queue with the shown text attested. Nothing
 * auto-sends: the card does nothing until tapped, and a failure keeps the draft and says nothing was sent.
 */
import React, { useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { Eyebrow, MilaButton, SettledLine, partStyles } from "./parts";
import { HowPanel } from "./HowIGotThis";
import { ACTION_COPY, VERB_COPY, formatMoney } from "../../lib/agent/cardLogic";
import { useApprovalTap } from "../../lib/agent/hooks";
import type { ActionPayloadWithNote, CardOf } from "../../lib/agent/types";
import { PartnerNote } from "./parts";
import { haptics } from "../../lib/haptics";

type Phase = "open" | "editing" | "approved" | "declined" | "failed" | "expired";

/** A reopened chat's card starts where its row stands now (the server attaches `approval` on load); a live one is open. */
export function initialPhase(approval: ActionPayloadWithNote["approval"]): Phase {
  switch (approval?.state) {
    case "sent": return "approved";
    case "declined": return "declined";
    case "failed": return "failed";
    case "expired": return "expired";
    default: return "open";
  }
}

/** `lazyHow` (default on): a "How I got this" fetched from the run on first open. Off when the turn already carries the
 *  run's how-i-got-this card (the harness sends one when the run read evidence), so it is never shown twice. */
export function ActionCard({ card, lazyHow = true }: { card: CardOf<"action">; lazyHow?: boolean }) {
  const p = card.payload as ActionPayloadWithNote;
  const verb = VERB_COPY[p.verb] ?? VERB_COPY.other_act;
  const { approve, decline } = useApprovalTap();
  const [phase, setPhase] = useState<Phase>(() => initialPhase(p.approval));
  const [draft, setDraft] = useState(p.body ?? "");
  const [edited, setEdited] = useState<string | undefined>(undefined);
  const busy = approve.isPending || decline.isPending;
  const failed = approve.isError || decline.isError;
  const shown = edited ?? p.body;
  const can = (b: "approve" | "edit" | "decline") => p.buttons.includes(b);

  // One tap, one approve: a second tap that lands before the first re-render (isPending still false) is dropped here.
  // The server claims the row at most once as well; this keeps the second request from being sent at all.
  const tapping = useRef(false);
  const onApprove = () => {
    if (tapping.current) return;
    tapping.current = true;
    approve.mutate(
      { approvalId: p.approvalId, body: p.body, ...(edited !== undefined ? { editedBody: edited } : {}) },
      {
        onSuccess: () => { haptics.success(); setPhase("approved"); },
        onError: () => haptics.error(),
        onSettled: () => { tapping.current = false; },
      },
    );
  };
  const onDecline = () => {
    decline.mutate({ approvalId: p.approvalId }, { onSuccess: () => setPhase("declined"), onError: () => haptics.error() });
  };

  return (
    <View style={styles.card} testID="card-action">
      <Eyebrow right={p.money ? <Text style={styles.money} testID="action-money">{formatMoney(p.money.amountMinor, p.money.currency)}</Text> : null}>
        {verb.eyebrow}
      </Eyebrow>
      <Text style={partStyles.title}>{card.title}</Text>

      {phase === "editing" ? (
        <View style={styles.gap}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            style={[partStyles.input, styles.editor]}
            accessibilityLabel={ACTION_COPY.editLabel}
            testID="action-editor"
          />
          <View style={partStyles.actions}>
            <MilaButton label={ACTION_COPY.save} onPress={() => { setEdited(draft); setPhase("open"); }} disabled={!draft.trim()} flex testID="action-save" />
            <MilaButton label={ACTION_COPY.cancel} tone="soft" onPress={() => { setDraft(shown ?? ""); setPhase("open"); }} flex testID="action-cancel" />
          </View>
        </View>
      ) : shown ? (
        <View style={styles.draft} testID="action-body">
          <Text style={styles.draftText} selectable>{shown}</Text>
        </View>
      ) : null}

      {phase === "approved" ? (
        <SettledLine text={verb.done} testID="action-done" />
      ) : phase === "declined" ? (
        <SettledLine text={verb.declined ?? ACTION_COPY.declined} icon="x" testID="action-declined" />
      ) : phase === "failed" ? (
        <Text style={partStyles.error} testID="action-failed">{ACTION_COPY.failed}</Text>
      ) : phase === "expired" ? (
        <Text style={partStyles.caption} testID="action-expired">{ACTION_COPY.expired}</Text>
      ) : phase === "open" ? (
        <>
          {failed ? <Text style={partStyles.error} accessibilityLiveRegion="polite" testID="action-error">{verb.error ?? ACTION_COPY.error}</Text> : null}
          {p.partnerNote ? <PartnerNote text={p.partnerNote} /> : null}
          <View style={partStyles.actions}>
            {can("approve") ? <MilaButton label={verb.approve} onPress={onApprove} loading={approve.isPending} disabled={busy} flex testID="action-approve" /> : null}
            {can("edit") && p.body !== null ? <MilaButton label={ACTION_COPY.edit} tone="soft" onPress={() => { setDraft(shown ?? ""); setPhase("editing"); }} disabled={busy} flex testID="action-edit" /> : null}
            {can("decline") ? <MilaButton label={verb.decline ?? ACTION_COPY.decline} tone="quiet" onPress={onDecline} loading={decline.isPending} disabled={busy} testID="action-decline" /> : null}
          </View>
          <Text style={styles.safety}>{verb.safety ?? ACTION_COPY.safety}</Text>
        </>
      ) : null}

      {lazyHow ? <HowPanel runId={card.runId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 12 },
  money: { ...BoldType.sigValue, color: Bold.ink },
  gap: { gap: 10 },
  draft: { backgroundColor: Bold.ground, borderRadius: 12, padding: 12 },
  draftText: { ...BoldType.read, color: Bold.ink },
  editor: { minHeight: 110, textAlignVertical: "top" },
  safety: { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
});
