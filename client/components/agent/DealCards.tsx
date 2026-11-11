/**
 * DealCards — Mila's deal cards in the chat (agent/1 `deal` · `deal-reply` · `deal-closed` · `deals-waiting`;
 * AGENT_DEALS_TOOLS). Built by the server from what a deal tool did, drawn on the Mila card surface (DESIGN.md §16:
 * white, corner 18, the soft lift, no border; soft rounded controls, ink primary, no pink).
 *
 *   DealChatCard      logo mark, the money, whose move, the read's chips, ONE action and "Open deal". The whole card
 *                     opens the deal (no dead tap).
 *   DealReplyCard     the reply, the Muse way: the inbox's own mark, "Send this email from your Gmail?", From / To /
 *                     Subject / attachment / body; Send · Edit first · Not now; "Needs your OK" while it waits; after
 *                     her tap a quiet receipt — "Sent … exactly as you approved it". No "always allow". Its state is
 *                     READ FROM THE SERVER (the pending action), so a reopened chat shows what really happened and can
 *                     never send twice.
 *   DealClosedCard    "Closed · by you" with Undo, and the optional polite no (a reply card that still needs Send)
 *   DealsWaitingCard  her tap queue; each row opens its deal
 *
 * Send = approve the server's inert send_reply proposal with the body's hash (the governed send). Edit first = a new
 * proposal with her text at her tap (payload.replaces names the card's own), the card's own dismissed once it went out.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Bold, BoldType } from "../../constants/theme";
import { LogoMark } from "../ui/LogoMark";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, SettledLine, SoftChip, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import {
  approvePendingAction, proposeAndApproveReply, sendErrorMessage, usePendingActions, useDismissPendingAction,
} from "../../hooks/use-pending-actions";
import { invalidateDealQueries } from "../../lib/dealQueryKeys";
import { apiRequest } from "../../lib/query-client";
import { approvalQuestion, inboxWord, replyStateOf, replyStateOfApproval, shortTime, type PendingRowLike } from "../../lib/agent/dealCardLogic";
import type { CardOf } from "../../lib/agent/types";
import type { DealCardBrand, DealReplyCardPayload } from "../../../shared/agent";
import { haptics } from "../../lib/haptics";

function BrandMark({ brand, size = 36 }: { brand: DealCardBrand; size?: number }) {
  return <LogoMark logoUrl={brand.logoUrl} domain={brand.domain} name={brand.name} size={size} />;
}

// ─── deal ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function DealChatCard({ card }: { card: CardOf<"deal"> }) {
  const { openLink, reply } = useAgentCardHandlers();
  const p = card.payload;
  const link = card.links[0] ?? { label: "Open deal", target: { screen: "deal", id: p.opportunityId } };
  const open = openLink ? () => { haptics.tap(); openLink(link.target, link); } : undefined;
  return (
    <Pressable
      onPress={open}
      disabled={!open}
      accessibilityRole={open ? "button" : undefined}
      accessibilityLabel={`${p.brand.name}, ${p.moneyLine}, ${p.moveLabel}`}
      style={({ pressed }) => [styles.card, pressed && open ? styles.pressed : null]}
      testID="card-deal"
    >
      <View style={styles.head}>
        <BrandMark brand={p.brand} />
        <View style={styles.headText}>
          <Text style={partStyles.h4} numberOfLines={1}>{p.brand.name}</Text>
          {p.typeLabel ? <Text style={partStyles.caption} numberOfLines={1}>{p.typeLabel}</Text> : null}
        </View>
        <SoftChip tone={p.whoseMove === "yours" ? "blue" : "ground"} testID="deal-move">{p.moveLabel}</SoftChip>
      </View>
      <Text style={styles.money} numberOfLines={2}>{p.moneyLine}</Text>
      {p.chips.length ? (
        <View style={partStyles.wrap}>
          {p.chips.map((c) => <SoftChip key={c}>{c}</SoftChip>)}
        </View>
      ) : null}
      <View style={styles.actions}>
        {p.action && reply ? (
          <MilaButton label={p.action.label} onPress={() => reply(p.action!.message)} testID="deal-action" />
        ) : null}
        {open ? <MilaButton label="Open deal" tone="quiet" icon="arrow-right" onPress={open} testID="deal-open" /> : null}
      </View>
    </Pressable>
  );
}

// ─── deal-reply ───────────────────────────────────────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

/** The approval body for one reply. `asNo`: the polite no on a closed card ("Send them a short no?", Skip). */
export function ReplyApproval({ p, asNo = false }: { p: DealReplyCardPayload; asNo?: boolean }) {
  const qc = useQueryClient();
  const rows = usePendingActions(p.pendingActionId ? { dealId: p.dealId } : undefined);
  const dismiss = useDismissPendingAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The live row wins; until it has loaded, a reopened chat's card shows the state the server attached on load.
  const state = p.pendingActionId
    ? (rows.data ? replyStateOf(p.pendingActionId, rows.data as PendingRowLike[]) : replyStateOfApproval(p.approval) ?? replyStateOf(p.pendingActionId, undefined))
    : null;
  const inbox = inboxWord(p.inbox);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["/api/v1/me/pending-actions"] });
    await invalidateDealQueries(qc);
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = text.trim();
      if (editing && body !== p.body.trim()) {
        // Her edit: a fresh proposal with HER text, approved on that same text; the card's own proposal is withdrawn
        // only AFTER that went out, so a failed send leaves this card's Send (and her edited text) in place to retry.
        await proposeAndApproveReply({ dealId: p.dealId, threadId: p.threadId!, body, payload: { reply_intent: p.intent, source: "mila_chat", drafted_by: "mila", edited: true, replaces: p.pendingActionId } });
        await dismiss.mutateAsync({ id: p.pendingActionId }).catch(() => {});
      } else {
        await approvePendingAction(p.pendingActionId, p.body);
      }
      haptics.success();
      setEditing(false);
    } catch (err) {
      setError(sendErrorMessage(err));
    } finally {
      setBusy(false);
      await settle();
    }
  };

  const notNow = async () => {
    setBusy(true);
    await dismiss.mutateAsync({ id: p.pendingActionId }).catch(() => {});
    setBusy(false);
    await settle();
  };

  // Sent: the quiet receipt (the inbox's mark, who, when, what was attached), and Mila's confirmation.
  if (state?.kind === "sent") {
    return (
      <View style={styles.inner} testID="reply-sent">
        <View style={styles.receipt}>
          <LogoMark platform={p.inbox ?? "gmail"} name={inbox} size={24} />
          <View style={styles.headText}>
            <Text style={partStyles.h4}>Sent from your {inbox}</Text>
            <Text style={partStyles.caption} numberOfLines={1}>
              {[p.to ? `To ${p.to}` : null, shortTime(state.at), p.attachment ? `with ${p.attachment}` : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
        <SettledLine text={state.edited ? "Sent exactly as you edited and approved it." : "Sent exactly as you approved it."} testID="reply-sent-line" />
      </View>
    );
  }

  const header = (
    <View style={styles.head}>
      <LogoMark platform={p.inbox ?? "gmail"} name={inbox} size={28} />
      <Text style={[partStyles.h4, styles.headText]}>{asNo ? "Send them a short no?" : approvalQuestion(p.inbox)}</Text>
    </View>
  );

  if (!p.sendable || !p.pendingActionId) {
    // Nothing to approve here: never ask "Send this…?" for a reply the app can't send.
    return (
      <View style={styles.inner} testID="reply-not-sendable">
        <View style={styles.head}>
          <LogoMark platform={p.inbox ?? "gmail"} name={inbox} size={28} />
          <Text style={[partStyles.h4, styles.headText]}>{asNo ? "A short no, to send yourself" : `A reply to send from your ${inbox}`}</Text>
        </View>
        <Text style={styles.bodyText} selectable>{p.body}</Text>
        <Text style={partStyles.caption}>{p.whyNotSendable ? `Can't send from here: ${p.whyNotSendable}.` : "Can't send this from the app."} Copy it into {inbox} to send.</Text>
      </View>
    );
  }

  const closed = state && (state.kind === "not_now" || state.kind === "expired");
  return (
    <View style={styles.inner} testID="reply-approval">
      {header}
      {!closed ? <SoftChip tone="blue" testID="reply-needs-ok">Needs your OK</SoftChip> : null}
      <View style={styles.fields}>
        <Field label="From" value={p.from} />
        <Field label="To" value={p.to} />
        <Field label="Subject" value={p.subject} />
        <Field label="Attached" value={p.attachment} />
      </View>
      {editing ? (
        <TextInput value={text} onChangeText={setText} multiline style={[partStyles.input, styles.editor]} accessibilityLabel="Edit the reply" testID="reply-editor" />
      ) : (
        <Text style={styles.bodyText} selectable testID="reply-body">{p.body}</Text>
      )}
      {error ? <Text style={partStyles.error} testID="reply-error">{error}</Text> : null}
      {state?.kind === "failed" ? <Text style={partStyles.error}>{state.error ?? "It didn't go through."} Nothing was sent.</Text> : null}
      {closed ? (
        <Text style={partStyles.caption} testID="reply-closed">{state!.kind === "expired" ? "This draft expired. Ask Mila for a fresh one." : "Not sent."}</Text>
      ) : state?.kind === "failed" ? null : (
        <View style={styles.actions}>
          <MilaButton label="Send" onPress={send} loading={busy} disabled={!state || state.kind !== "needs_ok" || (editing && !text.trim())} testID="reply-send" />
          {!editing ? <MilaButton label="Edit first" tone="soft" onPress={() => setEditing(true)} disabled={busy} testID="reply-edit" /> : null}
          <MilaButton label={asNo ? "Skip" : "Not now"} tone="quiet" onPress={notNow} disabled={busy} testID="reply-not-now" />
        </View>
      )}
      <Text style={partStyles.caption}>Nothing goes out until you tap Send.</Text>
    </View>
  );
}

export function DealReplyCard({ card }: { card: CardOf<"deal-reply"> }) {
  return (
    <View style={styles.card} testID="card-deal-reply">
      <ReplyApproval p={card.payload} />
    </View>
  );
}

// ─── deal-closed ──────────────────────────────────────────────────────────────────────────────────────────────────

export function DealClosedCard({ card }: { card: CardOf<"deal-closed"> }) {
  const qc = useQueryClient();
  const p = card.payload;
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The deal is back on her board: the short no written with the close is withdrawn, never left approvable unseen.
  const backOnBoard = async () => {
    setUndone(true);
    if (p.politeNo?.pendingActionId) await apiRequest("POST", `/api/v1/me/pending-actions/${p.politeNo.pendingActionId}/dismiss`).catch(() => {});
  };
  const undo = async () => {
    if (!p.receiptId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", `/api/v1/me/agent-actions/${p.receiptId}/undo`);
      await backOnBoard();
    } catch (err: any) {
      // Already undone (from the deal screen, or an earlier tap): it is back either way.
      if (/already undone|409/.test(String(err?.message ?? ""))) await backOnBoard();
      else setError("Couldn't undo that. Try again.");
    } finally {
      setBusy(false);
      await invalidateDealQueries(qc);
    }
  };
  return (
    <View style={styles.card} testID="card-deal-closed">
      <View style={styles.head}>
        <BrandMark brand={p.brand} />
        <View style={styles.headText}>
          <Text style={partStyles.h4} numberOfLines={1}>{p.brand.name}</Text>
          <Text style={partStyles.caption}>{undone ? "Back on your board" : `Closed · ${p.reasonLabel} · by you`}</Text>
        </View>
        {p.receiptId && !undone ? <MilaButton label="Undo" tone="soft" onPress={undo} loading={busy} testID="closed-undo" /> : null}
      </View>
      {error ? <Text style={partStyles.error}>{error}</Text> : null}
      {!undone ? <Text style={partStyles.caption}>Nothing was sent to them.</Text> : null}
      {p.politeNo && !undone ? <ReplyApproval p={p.politeNo} asNo /> : null}
    </View>
  );
}

// ─── deals-waiting ────────────────────────────────────────────────────────────────────────────────────────────────

export function DealsWaitingCard({ card }: { card: CardOf<"deals-waiting"> }) {
  const { openLink } = useAgentCardHandlers();
  const p = card.payload;
  return (
    <View style={styles.card} testID="card-deals-waiting">
      <View style={styles.head}>
        <Text style={[partStyles.title, styles.headText]}>Waiting for your tap</Text>
        <SoftChip tone="blue">{`${p.count} waiting`}</SoftChip>
      </View>
      <Text style={partStyles.caption}>Drafts Mila made. Nothing sends without you.</Text>
      {p.items.map((i) => {
        const go = openLink && i.opportunityId ? () => openLink({ screen: "deal", id: i.opportunityId! }) : undefined;
        return (
          <Pressable key={i.pendingActionId} onPress={go} disabled={!go} accessibilityRole={go ? "button" : undefined} style={({ pressed }) => [styles.row, pressed && go ? styles.pressed : null]} testID="waiting-row">
            <View style={styles.headText}>
              <Text style={partStyles.h4} numberOfLines={1}>{i.title}</Text>
              <Text style={partStyles.caption}>{i.kind === "ask_terms" ? "Ask for terms · draft ready" : "Reply · draft ready"}</Text>
            </View>
            {go ? <Feather name="chevron-right" size={18} color={Bold.mute} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 10 },
  inner: { gap: 10 },
  pressed: { opacity: 0.85 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  headText: { flex: 1, minWidth: 0 },
  money: { ...BoldType.read, color: Bold.ink },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  fields: { gap: 4 },
  field: { flexDirection: "row", gap: 8 },
  fieldLabel: { ...BoldType.caption, color: Bold.mute, width: 62 },
  fieldValue: { ...BoldType.caption, color: Bold.ink, flex: 1 },
  bodyText: { ...BoldType.read, color: Bold.ink2, backgroundColor: Bold.ground, borderRadius: 12, padding: 12 },
  editor: { minHeight: 120, textAlignVertical: "top" },
  receipt: { flexDirection: "row", alignItems: "center", gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
});
