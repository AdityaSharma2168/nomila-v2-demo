// WS4 · Ask-for-Terms — AskTermsBatch: the bulk "ask for a number" co-pilot (a pushed
// screen; mirrors InFlightView's onClose + back-header pattern).
//
// THREE stages, and the split is the safety story. Nothing sends until the athlete says.
//
//   1. SELECT — unpriced candidates, grouped by age × sender-type (fresh · agency ·
//      quiet · old). Every row is PRE-CHECKED (subtractive: uncheck to exclude), EXCEPT
//      the Old (90+d) group, which starts OFF. Tap "Review & send".
//
//   2. REVIEW — the checked rows are PROPOSED (server composes each request_terms reply
//      and stores it as a `pending_action` in status `pending` — INERT, nothing sent).
//      The screen then shows the EXACT email that will go out for EVERY row: tap a row
//      to expand its full drafted body (byte-for-byte what sends), and tap Edit to tweak
//      the wording before it goes. Only the expanded row renders its full body, so a long
//      list stays light. Set a row aside here and it's dismissed.
//      EACH ROW IS APPROVED ON ITS OWN (owner decision, 6 Oct 2026): "Approve" appears only
//      once a row has been opened (its exact body was on screen), an edit clears it, and
//      there is no "approve all". The approval IS the review, so there is no confirm sheet.
//
//   3. SEND — "Send k approved replies" runs the EXISTING approve endpoint over the
//      approved rows only, in a PACED loop (SEND_SPACING_MS apart). Each approve carries
//      the body_sha256 of the body that row showed and `reviewed: true`. We have NO
//      scheduler, and the copy says so: these go out NOW, a few seconds apart.
//
// Trust principle: nothing sends that the athlete didn't read in full and approve. The
// body they read/edit in Review IS the body approve sends — there is no separate draft.
//
// Presentational + client-side over useDeals()'s DealItem[]; all sends go through
// pending_actions/approve. No rate is ever named in a request_terms draft.

import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator, TextInput } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../../BrandLogo";
import { Button, Chip } from "../../ui/Chip";
import type { DealItem } from "../DealCard";
import {
  buildSegments,
  defaultCheckedIds,
  summarizeSelection,
  countExcludedLowValue,
  canApprove,
  withApproval,
  withoutApproval,
  approvedToSend,
  sendApprovedLabel,
  SEGMENT_META,
  SEND_SPACING_MS,
  type AskSegmentId,
} from "./askTermsLogic";
import { useAskTermsBatch, useEditAskTermsDraft, type AskTermsSkip } from "../../../hooks/use-ask-terms";
import { useApprovePendingAction, useDismissPendingAction, type PendingAction } from "../../../hooks/use-pending-actions";
import { Fonts, Colors, Spacing, BorderRadius, Bold } from "../../../constants/theme";

interface AskTermsBatchProps {
  deals:     DealItem[];
  isLoading: boolean;
  error:     Error | null;
  /** Dismiss the pushed screen (back). Renders a back chevron in the header. */
  onClose:   () => void;
  /** Fired once the paced send finishes (so the orchestrator can refresh / route home). */
  onDone:    () => void;
}

type Stage = "select" | "review" | "sending" | "done";

const HONEST_NO_SCHEDULER =
  "I can't schedule these over days yet — they send now, a few seconds apart, so they don't look like one blast.";

export function AskTermsBatch({ deals, isLoading, error, onClose, onDone }: AskTermsBatchProps) {
  const insets = useSafeAreaInsets();
  const now = useMemo(() => Date.now(), []);
  const segments = useMemo(() => buildSegments(deals, now), [deals, now]);
  const dealById = useMemo(() => new Map(deals.map((d) => [d.id, d])), [deals]);

  const [stage, setStage]         = useState<Stage>("select");
  const [checked, setChecked]     = useState<Set<string>>(() => defaultCheckedIds(deals, now));

  // Review-stage state.
  const [proposals, setProposals] = useState<PendingAction[]>([]);
  const [skipped, setSkipped]     = useState<AskTermsSkip[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText]   = useState("");
  // Rows whose full body has been on screen, and the approved ones (id → the body approved).
  const [opened, setOpened]       = useState<Set<string>>(() => new Set());
  const [approved, setApproved]   = useState<Map<string, string>>(() => new Map());

  // Send-stage progress.
  const [sent, setSent]           = useState(0);
  const [failed, setFailed]       = useState(0);
  const [sendTotal, setSendTotal] = useState(0);

  const proposeBatch = useAskTermsBatch();
  const editDraft    = useEditAskTermsDraft();
  const approve      = useApprovePendingAction();
  const dismiss      = useDismissPendingAction();

  const summary = useMemo(() => summarizeSelection(deals, checked, now), [deals, checked, now]);
  const excludedLowValue = useMemo(() => countExcludedLowValue(deals, now), [deals, now]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Stage 1 → 2: propose the checked rows (inert; server composes, nothing sends) ──
  async function onReview() {
    const ids = Array.from(checked);
    if (ids.length === 0) return;
    const result = await proposeBatch.mutateAsync(ids);
    setProposals(result.created);
    setSkipped(result.skipped);
    setExpandedId(null);
    setOpened(new Set());
    setApproved(new Map());
    setStage("review");
  }

  // ── Open / close a row. Opening shows its exact body, which unlocks its Approve. ──
  function onToggleRow(id: string, open: boolean) {
    if (open) {
      setExpandedId(null);
      setEditingId(null);
      return;
    }
    setExpandedId(id);
    setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  // ── Set a proposed row aside in Review (dismiss it — nothing was ever sent) ──
  async function onSetAside(pa: PendingAction) {
    await dismiss.mutateAsync({ id: pa.id });
    setProposals((prev) => prev.filter((p) => p.id !== pa.id));
    setApproved((prev) => withoutApproval(prev, pa.id));
    if (expandedId === pa.id) setExpandedId(null);
    if (editingId === pa.id) setEditingId(null);
  }

  // ── Start editing: the approval goes, because the body is about to change ──
  function onStartEdit(pa: PendingAction, body: string) {
    setApproved((prev) => withoutApproval(prev, pa.id));
    setEditingId(pa.id);
    setEditText(body);
  }

  // ── Save an edited body (persists into the very row approve will read verbatim) ──
  async function onSaveEdit(pa: PendingAction) {
    const body = editText.trim();
    if (!body) return;
    const updated = await editDraft.mutateAsync({ id: pa.id, body });
    setProposals((prev) => prev.map((p) => (p.id === pa.id ? updated : p)));
    setApproved((prev) => withoutApproval(prev, pa.id));
    setEditingId(null);
  }

  // ── Stage 2 → 3: the paced send of the APPROVED rows only, SEND_SPACING_MS apart. ──
  async function onSendApproved() {
    const list = approvedToSend(proposals, approved);
    if (list.length === 0) return;
    setStage("sending");
    setSent(0);
    setFailed(0);
    setSendTotal(list.length);
    for (let i = 0; i < list.length; i++) {
      const { pa, body } = list[i];
      try {
        // `body` is the body THIS row showed when it was approved, so the server hashes
        // against it and refuses if the stored row no longer matches. `reviewed` attests
        // that this one message was opened and approved on its own.
        await approve.mutateAsync({
          id:       pa.id,
          body,
          reviewed: true,
          threadId: pa.thread_id,
          dealId:   pa.deal_id,
        });
        setSent((n) => n + 1);
      } catch {
        setFailed((n) => n + 1);
      }
      // Space the sends — real, short pacing (no scheduler). Skip the tail delay.
      if (i < list.length - 1) await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
    }
    setStage("done");
  }

  // ─── Header ──────────────────────────────────────────────────────────────────
  // The top inset is not optional here. This renders inside a full-screen Modal, which
  // starts at y=0 — without it the back chevron sits underneath the status bar on any
  // notched device, so the screen has no way out at all. FilteredView and
  // YourWeekOutcome already do this; these two were the ones that missed it.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + Spacing.xs }]}>
      <Pressable onPress={onClose} hitSlop={10} style={styles.backBtn}>
        <Feather name="chevron-left" size={22} color={Colors.light.text} />
      </Pressable>
      <Text style={styles.headerTitle}>Ask for terms</Text>
      <View style={styles.backBtn} />
    </View>
  );

  // ─── Loading / error / empty ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View style={styles.screen}>{header}
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={Colors.light.primary} />
          <Text style={styles.muted}>Finding brands that never named a price…</Text>
        </View>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.screen}>{header}
        <View style={styles.centered}>
          <Feather name="alert-circle" size={20} color={Colors.light.error} />
          <Text style={styles.muted}>Couldn't load your deals</Text>
        </View>
      </View>
    );
  }
  if (segments.length === 0) {
    return (
      <View style={styles.screen}>{header}
        <View style={styles.centered}>
          <Feather name="check-circle" size={22} color="#B8B0A6" />
          <Text style={styles.muted}>No unpriced brands to ask right now.</Text>
          <Text style={styles.mutedSmall}>Every open thread already has a number on it.</Text>
        </View>
      </View>
    );
  }

  // ─── Stage: SELECT ───────────────────────────────────────────────────────────
  if (stage === "select") {
    return (
      <View style={styles.screen}>{header}
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.intro}>
            <Text style={styles.introStrong}>{summary.willAsk}</Text> will be asked ·{" "}
            <Text style={styles.introStrong}>{summary.setAside}</Text> set aside. Each is a reply in that
            brand's own thread. Nothing sends until you say.
          </Text>
          {excludedLowValue > 0 && (
            <Text style={styles.introSub}>
              {excludedLowValue} gifting-only / commission / pass-recommended {excludedLowValue === 1 ? "thread" : "threads"} left out — nothing to ask a budget for.
            </Text>
          )}

          {segments.map((group) => (
            <View key={group.meta.id} style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>{group.meta.label}</Text>
                <Text style={styles.sectionCount}>{group.rows.length}</Text>
              </View>
              <Text style={styles.sectionBlurb}>{group.meta.blurb}</Text>

              {group.rows.map((row, i) => (
                <SelectRow
                  key={row.deal.id}
                  deal={row.deal}
                  segment={group.meta.id}
                  checked={checked.has(row.deal.id)}
                  onToggle={() => toggle(row.deal.id)}
                  // Show the honest ask preview on the first row of each group so the
                  // athlete sees the shape of the message before the full drafts appear.
                  showPreview={i === 0}
                />
              ))}
            </View>
          ))}
        </ScrollView>

        <View style={styles.bottomBar}>
          <Text style={styles.bottomNote} numberOfLines={2}>{HONEST_NO_SCHEDULER}</Text>
          <Pressable
            style={[styles.cta, (summary.willAsk === 0 || proposeBatch.isPending) && styles.ctaDisabled]}
            onPress={onReview}
            disabled={summary.willAsk === 0 || proposeBatch.isPending}
          >
            {proposeBatch.isPending
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.ctaText}>Review {summary.willAsk} {summary.willAsk === 1 ? "draft" : "drafts"}</Text>}
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Stage: REVIEW (exact emails, per-row expand + edit) ─────────────────────
  if (stage === "review") {
    const approvedCount = approvedToSend(proposals, approved).length;
    return (
      <View style={styles.screen}>{header}
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.intro}>
            Here's the <Text style={styles.introStrong}>exact email</Text> for each — open a row to read it in
            full, then Approve it or Edit the wording. Only approved emails send. None names a rate. Nothing has
            been sent.
          </Text>

          {skipped.length > 0 && (
            <View style={styles.skipNote}>
              <Feather name="info" size={13} color="#9C968D" />
              <Text style={styles.skipText}>
                {skipped.length} set aside automatically — {summarizeSkips(skipped)}.
              </Text>
            </View>
          )}

          {proposals.length === 0 ? (
            <View style={styles.centered}>
              <Feather name="inbox" size={22} color="#B8B0A6" />
              <Text style={styles.muted}>Nothing left to send.</Text>
            </View>
          ) : (
            proposals.map((pa) => {
              const deal    = pa.deal_id ? dealById.get(pa.deal_id) : undefined;
              const segment = ((pa.payload as any)?.segment ?? "fresh") as AskSegmentId;
              const body    = String((pa.payload as any)?.body ?? "");
              const edited  = (pa.payload as any)?.edited === true;
              const asking  = ((pa.payload as any)?.asking ?? []) as string[];
              const open    = expandedId === pa.id;
              const isEditing = editingId === pa.id;
              const isApproved = approved.get(pa.id) === body;
              const approvable = canApprove(pa.id, opened, editingId);
              const brandLabel = deal?.advertiser ?? deal?.brandName ?? "Brand";
              return (
                <View key={pa.id} style={styles.reviewCard} testID={`ask-row-${pa.id}`}>
                  <Pressable
                    style={styles.reviewTop}
                    onPress={() => onToggleRow(pa.id, open)}
                    accessibilityRole="button"
                    accessibilityLabel={`${open ? "Close" : "Open"} ${brandLabel}`}
                    accessibilityState={{ expanded: open }}
                  >
                    <BrandLogo brandName={deal?.brandName ?? "Brand"} brandDomain={deal?.brandDomain} size={34} borderRadius={9} />
                    <View style={styles.reviewCol}>
                      <Text style={styles.brand} numberOfLines={1}>{brandLabel}</Text>
                      {/* WHAT this email asks for — only this brand's genuine gaps. */}
                      {asking.length > 0 && (
                        <Text style={styles.asking} numberOfLines={1}>asking for: {asking.join(" · ")}</Text>
                      )}
                      <Text style={styles.reviewMeta} numberOfLines={1}>
                        {SEGMENT_META[segment].label}{edited ? " · edited" : ""}
                      </Text>
                      {!opened.has(pa.id) && (
                        <Text style={styles.reviewHint} numberOfLines={1}>Open to review</Text>
                      )}
                    </View>
                    {isApproved && <Chip bold="dark" testID={`approved-${pa.id}`}>Approved</Chip>}
                    <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color="#C5BFB8" />
                  </Pressable>

                  {open && (
                    <View style={styles.reviewBody}>
                      {isEditing ? (
                        <>
                          <TextInput
                            style={styles.editInput}
                            value={editText}
                            onChangeText={setEditText}
                            multiline
                            autoFocus
                            textAlignVertical="top"
                          />
                          <View style={styles.rowActions}>
                            <Pressable style={styles.smallBtn} onPress={() => setEditingId(null)}>
                              <Text style={styles.smallBtnText}>Cancel</Text>
                            </Pressable>
                            <Pressable
                              style={[styles.smallBtn, styles.smallBtnPrimary]}
                              onPress={() => onSaveEdit(pa)}
                              disabled={editDraft.isPending || !editText.trim()}
                            >
                              <Text style={styles.smallBtnPrimaryText}>{editDraft.isPending ? "Saving…" : "Save"}</Text>
                            </Pressable>
                          </View>
                        </>
                      ) : (
                        <>
                          <Text style={styles.emailBody} selectable>{body}</Text>
                          <View style={styles.rowActions}>
                            <Pressable style={styles.smallBtn} onPress={() => onSetAside(pa)} disabled={dismiss.isPending}>
                              <Feather name="x" size={13} color="#8A8A8A" />
                              <Text style={styles.smallBtnText}>Set aside</Text>
                            </Pressable>
                            <Pressable
                              style={styles.smallBtn}
                              onPress={() => onStartEdit(pa, body)}
                              accessibilityRole="button"
                              accessibilityLabel={`Edit ${brandLabel}`}
                            >
                              <Feather name="edit-2" size={13} color="#8A8A8A" />
                              <Text style={styles.smallBtnText}>Edit</Text>
                            </Pressable>
                            {approvable && !isApproved && (
                              <Button
                                bold="small"
                                onPress={() => setApproved((prev) => withApproval(prev, pa.id, body))}
                                accessibilityLabel={`Approve ${brandLabel}`}
                                testID={`approve-${pa.id}`}
                              >
                                Approve
                              </Button>
                            )}
                          </View>
                        </>
                      )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>

        {/* No confirm sheet: each row's Approve is its review, so this one tap sends them. */}
        <View style={styles.bottomBar}>
          <Text style={styles.bottomNote} numberOfLines={2}>{HONEST_NO_SCHEDULER}</Text>
          <Button
            bold="primary"
            onPress={onSendApproved}
            disabled={approvedCount === 0}
            accessibilityLabel={sendApprovedLabel(approvedCount)}
            testID="send-approved"
          >
            {sendApprovedLabel(approvedCount)}
          </Button>
        </View>
      </View>
    );
  }

  // ─── Stage: SENDING / DONE ───────────────────────────────────────────────────
  const total = sendTotal;
  return (
    <View style={styles.screen}>{header}
      <View style={styles.centered}>
        {stage === "sending" ? (
          <>
            <ActivityIndicator size="small" color={Colors.light.primary} />
            <Text style={styles.muted}>Sending {sent + failed} of {total}…</Text>
            <Text style={styles.mutedSmall}>One threaded reply at a time — {SEND_SPACING_MS / 1000}s apart.</Text>
          </>
        ) : (
          <>
            <Feather name="check-circle" size={26} color={Colors.light.primary} />
            <Text style={styles.doneTitle}>
              {sent} {sent === 1 ? "ask" : "asks"} sent{failed > 0 ? ` · ${failed} couldn't go` : ""}
            </Text>
            <Text style={styles.mutedSmall}>
              Each went out in its own thread. Replies with a number will come back to your Brief.
            </Text>
            <Pressable style={[styles.cta, { marginTop: Spacing.lg }]} onPress={onDone}>
              <Text style={styles.ctaText}>Done</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

// ─── Select row ────────────────────────────────────────────────────────────────

function SelectRow({
  deal, segment, checked, onToggle, showPreview,
}: {
  deal: DealItem;
  segment: AskSegmentId;
  checked: boolean;
  onToggle: () => void;
  showPreview: boolean;
}) {
  const context = deal.voice?.line ?? deal.aiSummary ?? "";
  return (
    <View style={styles.selectCard}>
      <Pressable style={styles.selectRow} onPress={onToggle} hitSlop={4}>
        <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={38} borderRadius={10} />
        <View style={styles.selectCol}>
          <Text style={styles.brand} numberOfLines={1}>{deal.advertiser ?? deal.brandName}</Text>
          {!!deal.viaAgency && !!deal.agencyName && (
            <Text style={styles.via} numberOfLines={1}>via {deal.agencyName}</Text>
          )}
          {!!context && <Text style={styles.context} numberOfLines={1}>{context}</Text>}
          {!!deal.timeAgo && <Text style={styles.age} numberOfLines={1}>last {deal.timeAgo}</Text>}
        </View>
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked && <Feather name="check" size={14} color="#fff" />}
        </View>
      </Pressable>
      {showPreview && (
        <Text style={styles.preview} numberOfLines={3}>{SEGMENT_META[segment].preview}</Text>
      )}
    </View>
  );
}

// A plain-language summary of why rows were auto-skipped.
function summarizeSkips(skips: AskTermsSkip[]): string {
  const reasons = new Set(skips.map((s) => s.reason));
  const parts: string[] = [];
  if (reasons.has("already_priced"))  parts.push("already have a number");
  if (reasons.has("not_needs_terms")) parts.push("not a terms conversation");
  if (reasons.has("gifting_only"))    parts.push("gifting-only");
  if (reasons.has("commission_only")) parts.push("commission-only");
  if (reasons.has("declined"))        parts.push("recommended to pass");
  if (reasons.has("filed"))           parts.push("filed away");
  if (reasons.has("not_open"))        parts.push("no longer open");
  if (reasons.has("no_thread"))       parts.push("nothing to reply to");
  if (reasons.has("not_found"))       parts.push("not found");
  if (reasons.has("mailbox_unavailable")) parts.push("mailbox needs reconnecting");
  if (reasons.has("unverifiable_sender")) parts.push("sender not verified");
  return parts.length > 0 ? parts.join(", ") : "not eligible";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
  },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: Fonts.bodyBold, fontSize: 18, color: Colors.light.text, letterSpacing: -0.2 },

  scroll: { paddingVertical: Spacing.sm, paddingBottom: 120 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: Spacing["3xl"], gap: Spacing.sm },
  muted:      { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textMuted, textAlign: "center" },
  mutedSmall: { fontFamily: Fonts.body, fontSize: 12.5, color: "#9C968D", textAlign: "center", lineHeight: 18 },

  intro: {
    fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: "#5A554E",
    marginHorizontal: Spacing.lg, marginBottom: Spacing.md,
  },
  introStrong: { fontFamily: Fonts.bodySemiBold, color: Colors.light.text },
  introSub: {
    fontFamily: Fonts.body, fontSize: 12.5, color: "#9C968D", lineHeight: 17, fontStyle: "italic",
    marginHorizontal: Spacing.lg, marginTop: -Spacing.sm, marginBottom: Spacing.md,
  },

  // ── Section ──
  section:     { marginBottom: Spacing.lg },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, marginHorizontal: Spacing.lg, marginBottom: 2 },
  sectionTitle:{ fontFamily: Fonts.bodySemiBold, fontSize: 16, color: Colors.light.text, letterSpacing: -0.2 },
  sectionCount:{ fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "#9C968D" },
  sectionBlurb:{ fontFamily: Fonts.body, fontSize: 12, color: "#9C968D", marginHorizontal: Spacing.lg, marginBottom: Spacing.sm, lineHeight: 17 },

  // ── Select card / row ──
  selectCard: {
    marginHorizontal: Spacing.lg, marginBottom: 10,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.sm,
    borderWidth: 1, borderColor: Colors.light.borderLight,
  },
  selectRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.md },
  selectCol: { flex: 1, minWidth: 0, gap: 1 },
  brand:  { fontFamily: Fonts.bodySemiBold, fontSize: 15.5, color: Colors.light.text, letterSpacing: -0.2 },
  via:    { fontFamily: Fonts.bodyMedium, fontSize: 11, color: "#9C968D" },
  context:{ fontFamily: Fonts.body, fontSize: 12.5, color: "#5A554E", lineHeight: 17 },
  age:    { fontFamily: Fonts.bodyMedium, fontSize: 11, color: "#9C968D", marginTop: 1 },

  checkbox: {
    width: 24, height: 24, borderRadius: 7, flexShrink: 0,
    borderWidth: 1.5, borderColor: "#D8CFC6", backgroundColor: "#fff",
    alignItems: "center", justifyContent: "center",
  },
  checkboxOn: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },

  preview: {
    fontFamily: Fonts.body, fontSize: 12.5, color: "#8A7F76", lineHeight: 18, fontStyle: "italic",
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.md, marginTop: -2,
  },

  // ── Review card ──
  skipNote: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    marginHorizontal: Spacing.lg, marginBottom: Spacing.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.light.backgroundDefault, borderRadius: BorderRadius.xs,
  },
  skipText: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, color: "#6B6560", lineHeight: 17 },

  reviewCard: {
    marginHorizontal: Spacing.lg, marginBottom: 10,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.sm,
    borderWidth: 1, borderColor: Colors.light.borderLight, overflow: "hidden",
  },
  reviewTop: { flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.md },
  reviewCol: { flex: 1, minWidth: 0, gap: 2 },
  asking: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.primary, letterSpacing: 0.1 },
  reviewMeta: { fontFamily: Fonts.bodyMedium, fontSize: 11.5, color: "#9C968D" },
  // "Needs you" — the one look B accent.
  reviewHint: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Bold.blue },
  reviewBody: {
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.md, paddingTop: 2,
    borderTopWidth: 1, borderTopColor: Colors.light.borderLight,
  },
  emailBody: {
    fontFamily: Fonts.body, fontSize: 14, lineHeight: 21, color: Colors.light.text,
    marginTop: Spacing.sm,
  },
  editInput: {
    fontFamily: Fonts.body, fontSize: 14, lineHeight: 21, color: Colors.light.text,
    marginTop: Spacing.sm, minHeight: 160,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.xs,
    padding: Spacing.sm, backgroundColor: "#fff",
  },
  rowActions: { flexDirection: "row", justifyContent: "flex-end", gap: Spacing.sm, marginTop: Spacing.sm },
  smallBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: "#fff",
  },
  smallBtnText: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: "#6B6560" },
  smallBtnPrimary: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  smallBtnPrimaryText: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: "#fff" },

  // ── Bottom bar / CTA ──
  bottomBar: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.xl,
    backgroundColor: Colors.light.card, borderTopWidth: 1, borderTopColor: Colors.light.borderLight,
    gap: Spacing.sm,
  },
  bottomNote: { fontFamily: Fonts.body, fontSize: 11.5, color: "#9C968D", lineHeight: 16, fontStyle: "italic" },
  cta: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm,
    backgroundColor: Colors.light.primary, borderRadius: BorderRadius.full,
    paddingVertical: 14,
  },
  ctaDisabled: { opacity: 0.45 },
  ctaText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: "#fff" },

  doneTitle: { fontFamily: Fonts.bodyBold, fontSize: 17, color: Colors.light.text, textAlign: "center", marginTop: Spacing.xs },
});
