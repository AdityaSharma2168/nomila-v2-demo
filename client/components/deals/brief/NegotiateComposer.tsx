// WS2 · NegotiateComposer — the Brief's per-deal rate-override surface.
//
// The only full-screen commit surface in the Brief. The athlete opens it from the
// DecisionSheet's negotiate action, sets her counter against a three-number strip
// (her floor → her ask), folds in draft points, picks a tone, and reviews
// Mila's streamed draft before anything leaves. CO-PILOT: nothing auto-sends — the
// draft is generated for review and only goes out on an explicit Approve. CO-PILOT
// SEND (WS3 §3.6): tapping "Send counter" does NOT send — it PROPOSES a pending
// action (kind send_reply) for the deal's thread, moving to a preview ("Mila will
// send this on your behalf — approve?"). Only Approve executes (the server's approve
// path is the single send). Dismiss backs out. mailto survives ONLY as a hand-off
// when a deal has no connected thread to co-pilot through; there is no direct send.
//
// Money safety: the strip only ever prints figures backed by real data — the floor
// from `deal_preferences.minimum_rates` and the athlete's own typed counter. (Legacy
// retirement, phase 1, 8 Oct 2026: the "suggested" benchmark from the v3 rate card is
// gone until a new rate model exists.) Anything missing renders as "—", never a
// fabricated number. All numeric logic lives in ./negotiateLogic (unit-tested).
//
// Visual language matches AskCard / DecisionSheet: recoCard tint (#FFF8FC) with the
// 3px raspberry (Bold.act) left border for Mila's voice, app theme constants throughout. Mined
// from the orphaned Variant B `opps/detail/DraftReply.tsx` (tone chips, tappable
// asks, streamed-draft + in-app-send-with-mailto-fallback plumbing).

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../../BrandLogo";
import type { DealItem } from "../DealCard";
import { Fonts, Colors, Spacing, BorderRadius } from "../../../constants/theme";
import { useDealPreferences } from "../../../hooks/use-deals";
import { useDealDraft } from "../../../hooks/use-deal-draft";
import { useThread } from "../../../hooks/use-thread";
import { useConnections } from "../../../hooks/use-connections";
import {
  useCreatePendingAction,
  useApprovePendingAction,
  useDismissPendingAction,
} from "../../../hooks/use-pending-actions";
import { openReply } from "../../../lib/reply-link";
import {
  NEGOTIATE_TONES,
  toneToDraftParams,
  rateKeyForCategory,
  resolveThreeNumbers,
  resolveDraftPoints,
  buildCounterInstruction,
  sanitizeCounterInput,
  formatMoney,
  type NegotiateToneId,
} from "./negotiateLogic";
import { coPilotReducer, INITIAL_CO_PILOT_STATE, parseApproveError } from "./coPilotFlow";

interface NegotiateComposerProps {
  deal:     DealItem;
  visible:  boolean;
  onClose:  () => void;
  onSent?:  () => void;   // fired after a successful in-app send (closes the sheet behind)
}

export function NegotiateComposer({ deal, visible, onClose, onSent }: NegotiateComposerProps) {
  const { data: prefsData } = useDealPreferences();

  // ── The three numbers (all backed, or null → "—") ──
  const rateKey   = rateKeyForCategory(deal.category);
  const floorVal  = prefsData?.deal_preferences?.minimum_rates?.[rateKey] ?? null;
  // No computed benchmark (legacy rates retired): the counter seeds from her own floor, or starts empty.
  const nums      = useMemo(() => resolveThreeNumbers(floorVal, null), [floorVal]);

  // Counter is free text; seeded to her floor once it resolves.
  const [counter, setCounter]         = useState<string>("");
  const [counterDirty, setCounterDirty] = useState(false); // typed but not yet re-drafted
  const counterNum = sanitizeCounterInput(counter);

  // ── Draft points + tone ──
  const points = useMemo(
    () => resolveDraftPoints(deal.draftPoints, deal.negotiateTerms),
    [deal.draftPoints, deal.negotiateTerms],
  );
  const [activePoints, setActivePoints] = useState<string[]>([]);
  const [toneId, setToneId]             = useState<NegotiateToneId>("friendly");

  // ── Streamed draft (same SSE endpoint as the existing composer) ──
  const { draft, streaming, generated, error: draftError, generate, editDraft, reset } = useDealDraft(deal.id);

  // ── Send — CO-PILOT: propose → preview → approve. Nothing sends until Approve. ──
  // mailto (openReply) survives ONLY for a deal with no connected thread to co-pilot
  // through — it hands the draft to the athlete's own mail app, Nomila sends nothing.
  // There is no in-app direct send: a propose failure shows the error and keeps the draft.
  const { data: thread } = useThread(deal.threadId, { enabled: visible && !!deal.threadId });
  const replyTo =
    thread?.messages.find((m) => m.direction === "inbound" && m.sender_email)?.sender_email ?? null;
  const { canSend } = useConnections();
  const canSendInApp = !!deal.threadId && canSend(deal.source);
  // Co-pilot is possible only with a real thread + connected inbox to send through;
  // otherwise we fall back to mailto (never a silent drop, never a fabricated send).
  const canCoPilot = canSendInApp;

  // Co-pilot mutations (propose / approve / dismiss) + the pure flow state machine.
  const createPending    = useCreatePendingAction(deal.id);
  const approve          = useApprovePendingAction();
  const dismiss          = useDismissPendingAction();
  const [flow, dispatch] = useReducer(coPilotReducer, INITIAL_CO_PILOT_STATE);
  const flowLocked       = flow.phase !== "compose";  // freeze inputs once proposed

  const regenerate = useCallback(
    (tone: NegotiateToneId, selectedTerms: string[], counterValue: number | null) => {
      const { style, reply_intent } = toneToDraftParams(tone);
      setCounterDirty(false);
      generate({
        reply_intent,
        style,
        voice: "athlete",
        selected_terms: selectedTerms,
        custom_instruction: buildCounterInstruction(counterValue, nums.floor),
      });
    },
    [generate, nums.floor],
  );

  // On open: seed the counter to her floor and draft ONCE with that
  // number folded in, ready for review — NOT sent. The rate card / floor are
  // app-wide cached, so `counterDefault` is usually available on the first pass;
  // if it arrives late (cold cache), this re-runs and seeds+redrafts. `preparedRef`
  // flips only once we've drafted WITH a real seed, so a late rate isn't missed.
  const preparedRef = useRef(false);
  useEffect(() => {
    if (!visible) return;
    if (preparedRef.current) return;
    const seed = nums.counterDefault;
    if (seed != null) {
      preparedRef.current = true;
      setCounter(String(Math.round(seed)));
      regenerate(toneId, activePoints, seed);
    } else {
      // No backed rate yet — draft once without a counter (will re-prepare if a
      // rate lands). Never invent a starting number.
      regenerate(toneId, activePoints, null);
    }
    // Fire on open + when the seed first resolves; inputs drive their own regens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, nums.counterDefault]);

  // On close: reset everything so a re-open starts clean.
  useEffect(() => {
    if (visible) return;
    preparedRef.current = false;
    setCounter("");
    setCounterDirty(false);
    setActivePoints([]);
    setToneId("friendly");
    reset();
    dispatch({ type: "RESET" });
    createPending.reset();
    approve.reset();
    dismiss.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Once the counter is sent, hold the confirmation briefly, then let the parent
  // close the sheet (onSent). Cleanup guards against firing after unmount.
  useEffect(() => {
    if (flow.phase !== "sent") return;
    const t = setTimeout(() => onSent?.(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.phase]);

  const pickTone = (id: NegotiateToneId) => {
    if (streaming || flowLocked || id === toneId) return;
    setToneId(id);
    regenerate(id, activePoints, counterNum);
  };

  const togglePoint = (term: string) => {
    if (streaming || flowLocked) return;
    const next = activePoints.includes(term)
      ? activePoints.filter((t) => t !== term)
      : [...activePoints, term];
    setActivePoints(next);
    regenerate(toneId, next, counterNum);
  };

  const onCounterChange = (text: string) => {
    setCounter(text.replace(/[^0-9]/g, ""));
    setCounterDirty(true);
  };

  // The compose-phase CTA is live only once there's a real, reviewed draft.
  const composeDisabled =
    !generated || streaming || draft.trim().length === 0 || flow.phase === "proposing";

  // ── PROPOSE: create a pending_action (kind send_reply) — NO send — then preview. ──
  async function handlePropose() {
    const body = draft.trim();
    if (!body) return;
    // No thread / connection to co-pilot through → hand the draft to the mail app
    // (Nomila sends nothing). Never a direct in-app send around the approval.
    if (!canCoPilot || !deal.threadId) { await openReply(replyTo, draft); return; }

    dispatch({ type: "PROPOSE" });
    try {
      const pa = await createPending.mutateAsync({
        kind:      "send_reply",
        thread_id: deal.threadId,
        // Read verbatim by the executor at approval. `body` is the reviewed draft;
        // any money figure is already baked into it via negotiateLogic — we never
        // restate a number here.
        payload: { body, reply_intent: "negotiate", style: toneId, voice: "athlete" },
      });
      const echoed = typeof (pa.payload as any)?.body === "string" ? (pa.payload as any).body : body;
      dispatch({ type: "PROPOSED", id: pa.id, body: echoed });
    } catch (err) {
      // Couldn't create the proposal → surface the reason and stay in compose with the
      // draft intact so the athlete can retry. No direct-send fallback: it would go
      // around the approval record.
      dispatch({ type: "PROPOSE_FAILED", error: parseApproveError(err).message });
    }
  }

  // ── APPROVE: the ONLY path that sends. Surfaces send failures (REAUTH etc.). ──
  async function handleApprove() {
    if (flow.phase !== "preview" || !flow.pendingActionId || flow.previewBody == null) return;
    dispatch({ type: "APPROVE" });
    try {
      // `body` is the preview the athlete is looking at — the server checks it is
      // byte-for-byte what will send (body_sha256).
      await approve.mutateAsync({
        id:       flow.pendingActionId,
        body:     flow.previewBody,
        threadId: deal.threadId,
        dealId:   deal.id,
      });
      dispatch({ type: "APPROVED" });   // → "sent" confirmation, then onSent (timer)
    } catch (err) {
      const { message, reauth } = parseApproveError(err);
      dispatch({ type: "APPROVE_FAILED", error: message, reauth });
    }
  }

  // ── DISMISS: back out of the preview without sending. ──
  async function handleDismiss() {
    if (flow.phase !== "preview" || !flow.pendingActionId) return;
    dispatch({ type: "DISMISS" });
    try {
      await dismiss.mutateAsync({ id: flow.pendingActionId });
      dispatch({ type: "DISMISSED" });
    } catch (err) {
      dispatch({ type: "DISMISS_FAILED", error: parseApproveError(err).message });
    }
  }

  const inPreview = flow.phase === "preview" || flow.phase === "approving" || flow.phase === "dismissing";

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.screen}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable hitSlop={8} onPress={onClose} style={styles.headerBtn}>
            <Feather name="chevron-left" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={22} borderRadius={6} />
            <Text style={styles.headerTitle} numberOfLines={1}>Negotiate · {deal.brandName}</Text>
          </View>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Mila's framing — recoCard voice region */}
          {!!(deal.voice?.line) && (
            <View style={styles.voiceCard}>
              <Text style={styles.voiceLabel}>THE COUNTER</Text>
              <Text style={styles.voiceLine}>{deal.voice!.line}</Text>
            </View>
          )}

          {/* Number strip: your floor → your counter */}
          <View style={styles.strip}>
            <NumberCell label="YOUR FLOOR" hint="walk-away" value={nums.floor} tone="floor" />
            <View style={styles.stripArrow}><Feather name="arrow-right" size={13} color={Colors.light.textMuted} /></View>
            {/* Your counter — the one editable figure */}
            <View style={[styles.cell, styles.cellCounter]}>
              <Text style={[styles.cellLabel, styles.cellLabelCounter]}>YOUR ASK</Text>
              <View style={styles.counterInputRow}>
                <Text style={styles.counterDollar}>$</Text>
                <TextInput
                  style={styles.counterInput}
                  value={counter}
                  onChangeText={onCounterChange}
                  keyboardType="number-pad"
                  placeholder={nums.counterDefault != null ? String(Math.round(nums.counterDefault)) : "—"}
                  placeholderTextColor={Colors.light.textMuted}
                  maxLength={9}
                  editable={!flowLocked}
                />
              </View>
              <Text style={styles.cellHint}>what we ask for</Text>
            </View>
          </View>

          {/* Floor guard rail */}
          {nums.floor != null && counterNum != null && counterNum < nums.floor && (
            <View style={styles.warnRow}>
              <Feather name="alert-triangle" size={13} color="#A6720C" />
              <Text style={styles.warnText}>That's below your {formatMoney(nums.floor)} floor for this deal type.</Text>
            </View>
          )}

          {/* Tone — 2, not 4 */}
          <Text style={styles.sectionLabel}>TONE</Text>
          <View style={styles.toneRow}>
            {NEGOTIATE_TONES.map((t) => {
              const on = t.id === toneId;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => pickTone(t.id)}
                  disabled={streaming || flowLocked}
                  style={[styles.toneChip, on && styles.toneChipOn, (streaming || flowLocked) && styles.dim]}
                >
                  <Feather name={t.icon} size={14} color={on ? "#fff" : Colors.light.textSecondary} />
                  <Text style={[styles.toneChipText, on && styles.toneChipTextOn]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Draft points */}
          <Text style={styles.sectionLabel}>WHAT TO FOLD IN</Text>
          <Text style={styles.pointsHint}>
            {deal.negotiateTerms && deal.negotiateTerms.length
              ? "Tap a term for Mila to weave into your counter."
              : "Tap a suggestion to fold it into your counter."}
          </Text>
          <View style={styles.pointsWrap}>
            {points.map((p) => {
              const on = activePoints.includes(p.term);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => togglePoint(p.term)}
                  disabled={streaming || flowLocked}
                  style={[styles.pointChip, on && styles.pointChipOn, (streaming || flowLocked) && styles.dim]}
                >
                  <Feather name={on ? "check" : "plus"} size={13} color={on ? Colors.light.primary : Colors.light.textSecondary} />
                  <Text style={[styles.pointChipText, on && styles.pointChipTextOn]}>{p.chip}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* The streamed draft — reviewable + editable before send */}
          <View style={styles.draftCard}>
            <View style={styles.draftHead}>
              <Feather name={draftError ? "alert-circle" : "zap"} size={14} color={draftError ? Colors.light.error : Colors.light.primary} />
              <Text style={[styles.draftLabel, draftError && { color: Colors.light.error }]}>
                {draftError ? "Couldn't draft"
                  : streaming ? "Mila is writing…"
                  : inPreview ? "Mila's draft — approve to send"
                  : "Mila's draft — review before it sends"}
              </Text>
              {generated && !streaming && !draftError && !flowLocked && (
                <Pressable onPress={() => regenerate(toneId, activePoints, counterNum)} hitSlop={6} style={styles.regenBtn}>
                  <Feather name="refresh-cw" size={13} color={Colors.light.textSecondary} />
                </Pressable>
              )}
            </View>

            {draftError ? (
              <Text style={styles.errorText}>{draftError}</Text>
            ) : streaming && draft.length === 0 ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={Colors.light.primary} />
                <Text style={styles.loadingText}>Drafting your counter…</Text>
              </View>
            ) : (
              <TextInput
                style={styles.draftInput}
                value={draft}
                onChangeText={editDraft}
                multiline
                textAlignVertical="top"
                editable={!streaming && !flowLocked}
                placeholder="Your counter will appear here…"
                placeholderTextColor={Colors.light.textMuted}
              />
            )}

            {/* Counter changed but the draft hasn't caught up yet */}
            {counterDirty && counterNum != null && !streaming && !flowLocked && (
              <Pressable style={styles.updateBtn} onPress={() => regenerate(toneId, activePoints, counterNum)}>
                <Feather name="refresh-cw" size={13} color={Colors.light.primary} />
                <Text style={styles.updateText}>Update draft to counter at {formatMoney(counterNum)}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>

        {/* Footer — CO-PILOT: propose → preview → approve. Nothing sends until Approve. */}
        <View style={styles.footer}>
          {flow.phase === "sent" ? (
            /* Sent confirmation (held briefly, then onSent closes the sheet). */
            <View style={styles.sentRow}>
              <Feather name="check-circle" size={16} color={Colors.light.success} />
              <Text style={styles.sentText}>Counter sent to {deal.brandName}</Text>
            </View>
          ) : inPreview ? (
            /* Preview — Mila will send on the athlete's behalf; she approves or backs out. */
            <>
              <View style={styles.coPilotBanner}>
                <Feather name="shield" size={14} color={Colors.light.primary} />
                <Text style={styles.coPilotText}>
                  Mila will send this to {deal.brandName} on your behalf — approve?
                </Text>
              </View>
              {!!flow.previewBody && (
                <ScrollView
                  style={styles.previewBox}
                  contentContainerStyle={styles.previewBoxContent}
                  nestedScrollEnabled
                >
                  <Text style={styles.previewBodyText}>{flow.previewBody}</Text>
                </ScrollView>
              )}
              <View style={styles.approveRow}>
                <Pressable
                  style={[styles.dismissBtn, flow.phase !== "preview" && styles.sendBtnDisabled]}
                  onPress={handleDismiss}
                  disabled={flow.phase !== "preview"}
                >
                  <Feather name="x" size={15} color={Colors.light.textSecondary} />
                  <Text style={styles.dismissText}>
                    {flow.phase === "dismissing" ? "Discarding…" : "Not yet"}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.approveBtn, flow.phase !== "preview" && styles.sendBtnDisabled]}
                  onPress={handleApprove}
                  disabled={flow.phase !== "preview"}
                >
                  {flow.phase === "approving"
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Feather name="check" size={16} color="#fff" />}
                  <Text style={styles.sendText}>
                    {flow.phase === "approving" ? "Sending…" : "Approve & send"}
                  </Text>
                </Pressable>
              </View>
              {!!flow.error && (
                <View style={styles.sendErr}>
                  <Text style={styles.errorText}>{flow.error}</Text>
                </View>
              )}
            </>
          ) : (
            /* Compose — the CTA PROPOSES (no send); mailto when there's no co-pilot thread. */
            <>
              <Pressable
                style={[styles.sendBtn, composeDisabled && styles.sendBtnDisabled]}
                onPress={handlePropose}
                disabled={composeDisabled}
              >
                {flow.phase === "proposing"
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Feather name={canCoPilot ? "send" : "external-link"} size={16} color="#fff" />}
                <Text style={styles.sendText}>
                  {flow.phase === "proposing" ? "Preparing…"
                    : canCoPilot ? "Send counter"
                    : "Open in Mail"}
                </Text>
              </Pressable>
              {/* A propose/approve failure dropped us back here — surface the reason. */}
              {!!flow.error && (
                <View style={styles.sendErr}>
                  <Text style={styles.errorText}>{flow.error}</Text>
                  {flow.reauth && (
                    <Text style={styles.reauthHint}>Reconnect the inbox in Settings, then send again.</Text>
                  )}
                </View>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// A single read-only cell of the three-number strip. Prints "—" (never a guess)
// when the backing figure is absent.
function NumberCell({
  label, hint, value, tone,
}: { label: string; hint: string; value: number | null; tone: "floor" | "suggested" }) {
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text style={[styles.cellValue, tone === "floor" && styles.cellValueFloor]}>
        {value != null ? formatMoney(value) : "—"}
      </Text>
      <Text style={styles.cellHint}>{value != null ? hint : "not set"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.backgroundRoot },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.borderLight,
    backgroundColor: Colors.light.card,
  },
  headerBtn: { width: 40, alignItems: "flex-start" },
  headerCenter: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm },
  headerTitle: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Colors.light.text, flexShrink: 1 },

  scroll: { flex: 1 },
  scrollContent: { padding: Spacing.lg, paddingBottom: Spacing["3xl"] },

  // Mila voice region — recoCard treatment
  voiceCard: {
    backgroundColor: "#FFF8FC", borderLeftWidth: 3, borderLeftColor: Colors.light.primary,
    borderRadius: BorderRadius.xs, padding: 12, marginBottom: Spacing.lg,
  },
  voiceLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 9.5, letterSpacing: 1.2, color: Colors.light.primary },
  voiceLine:  { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: Colors.light.text, marginTop: 7 },

  // Three-number strip
  strip: {
    flexDirection: "row", alignItems: "stretch",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: BorderRadius.sm, padding: Spacing.md, gap: 2,
  },
  stripArrow: { justifyContent: "center", paddingHorizontal: 1 },
  cell: { flex: 1, alignItems: "center", justifyContent: "flex-start", gap: 3 },
  cellCounter: {
    backgroundColor: "#FFF8FC", borderWidth: 1, borderColor: Colors.light.primary + "40",
    borderRadius: BorderRadius.xs, paddingVertical: 6, paddingHorizontal: 4,
  },
  cellLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 8.5, letterSpacing: 0.7, color: Colors.light.textMuted, textAlign: "center" },
  cellLabelCounter: { color: Colors.light.primary },
  cellValue: { fontFamily: Fonts.heading, fontSize: 17, color: Colors.light.text, letterSpacing: -0.3, fontVariant: ["tabular-nums"] },
  cellValueFloor: { color: Colors.light.textSecondary },
  cellHint: { fontFamily: Fonts.body, fontSize: 9.5, color: Colors.light.textMuted, textAlign: "center" },

  counterInputRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  counterDollar: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Colors.light.primary },
  counterInput: {
    fontFamily: Fonts.heading, fontSize: 17, color: Colors.light.text, letterSpacing: -0.3,
    fontVariant: ["tabular-nums"], minWidth: 46, textAlign: "center", paddingVertical: 0,
  },

  warnRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: Spacing.sm },
  warnText: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: "#A6720C", flex: 1 },

  sectionLabel: {
    fontFamily: Fonts.bodySemiBold, fontSize: 10.5, letterSpacing: 1, color: Colors.light.textMuted,
    marginTop: Spacing.xl, marginBottom: Spacing.sm,
  },
  pointsHint: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: -4, marginBottom: Spacing.sm },

  toneRow: { flexDirection: "row", gap: Spacing.sm },
  toneChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  toneChipOn: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  toneChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.textSecondary },
  toneChipTextOn: { color: "#fff" },

  pointsWrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  pointChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  pointChipOn: { backgroundColor: "#FFF8FC", borderColor: Colors.light.primary + "66" },
  pointChipText: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.textSecondary },
  pointChipTextOn: { color: Colors.light.primary },
  dim: { opacity: 0.55 },

  draftCard: {
    marginTop: Spacing.xl, backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.sm, padding: Spacing.md,
  },
  draftHead: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: Spacing.sm },
  draftLabel: { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Colors.light.primary },
  regenBtn: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  loadingText: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted },
  errorText: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.error, lineHeight: 18 },
  draftInput: {
    fontFamily: Fonts.body, fontSize: 15, color: Colors.light.text, lineHeight: 22,
    backgroundColor: Colors.light.backgroundRoot, borderRadius: BorderRadius.xs, padding: 12,
    borderWidth: 1, borderColor: Colors.light.borderLight, minHeight: 150,
  },
  updateBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: Spacing.sm, paddingVertical: 9, borderRadius: BorderRadius.xs,
    backgroundColor: "#FFF8FC", borderWidth: 1, borderColor: Colors.light.primary + "40",
  },
  updateText: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.primary },

  footer: {
    padding: Spacing.lg, paddingBottom: Spacing["2xl"],
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight,
    backgroundColor: Colors.light.card, gap: Spacing.sm,
  },
  sendBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm,
    height: Spacing.buttonHeight, borderRadius: BorderRadius.full, backgroundColor: Colors.light.primary,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: "#fff" },
  sentRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: Spacing.buttonHeight },
  sentText: { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.success },
  sendErr: { alignItems: "center", gap: 6 },
  reauthHint: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, textAlign: "center" },

  // Co-pilot preview — Mila proposes, the athlete approves. Mila-voice recoCard tint.
  coPilotBanner: {
    flexDirection: "row", alignItems: "center", gap: 7,
    backgroundColor: "#FFF8FC", borderLeftWidth: 3, borderLeftColor: Colors.light.primary,
    borderRadius: BorderRadius.xs, paddingVertical: 9, paddingHorizontal: 11,
  },
  coPilotText: { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: Colors.light.text, lineHeight: 17 },
  previewBox: {
    maxHeight: 108, backgroundColor: Colors.light.backgroundRoot,
    borderWidth: 1, borderColor: Colors.light.borderLight, borderRadius: BorderRadius.xs,
  },
  previewBoxContent: { padding: 11 },
  previewBodyText: { fontFamily: Fonts.body, fontSize: 13.5, color: Colors.light.textSecondary, lineHeight: 20 },
  approveRow: { flexDirection: "row", gap: Spacing.sm },
  dismissBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingHorizontal: 16, height: Spacing.buttonHeight, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  dismissText: { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.textSecondary },
  approveBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm,
    height: Spacing.buttonHeight, borderRadius: BorderRadius.full, backgroundColor: Colors.light.primary,
  },
});
