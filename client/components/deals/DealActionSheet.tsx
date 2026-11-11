import React, { useState, useCallback, useRef, useEffect } from "react";
import { haptics } from "../../lib/haptics";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { DealItem } from "./DealCard";
import { BrandLogo } from "../BrandLogo";
import { Bold, Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";
import { useDealDraft } from "../../hooks/use-deal-draft";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReplyIntent = "accept" | "negotiate" | "request_terms" | "decline";
type DraftStyle  = "friendly" | "professional";
type DraftVoice  = "athlete" | "agent";

interface DealActionSheetProps {
  deal:    DealItem;
  mode:    "accept" | "negotiate" | "terms";
  onClose: () => void;
  /** `intent` is the reply she is sending (the chip selected at Send), so a caller sets status from it, never from `mode`. */
  onSend:  (draftBody: string, intent: ReplyIntent) => void | Promise<void>;
  // ── Mila draft-as-data (PR-7). All optional; absent = byte-identical to today. ──
  /** Pre-generated, strip-guarded draft. Seeds the editor on mount so the athlete
   *  reviews/edits/sends without the sheet ever streaming on device (the SSE path is
   *  the unfixed native bug). Requires `disableGenerate`. */
  seededDraft?: string;
  /** Never call generate() on device: the generation controls render seeded but
   *  read-only, and the draft comes from `seededDraft`. */
  disableGenerate?: boolean;
  /** Reflect what Mila drafted with, so the controls mirror the approach. */
  initialParams?: {
    replyIntent?:     ReplyIntent;
    style?:           DraftStyle;
    voice?:           DraftVoice;
    includeMediaKit?: boolean;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NEGOTIATE_TERMS = [
  { id: "rate",         label: "Rate / Compensation" },
  { id: "deliverables", label: "Deliverables" },
  { id: "timeline",     label: "Timeline" },
  { id: "exclusivity",  label: "Exclusivity" },
] as const;

type TermId = typeof NEGOTIATE_TERMS[number]["id"];
type NegAsk = { orig: string; cur: string; selected: boolean; custom?: boolean };

const INTENT_HINT: Record<ReplyIntent, string> = {
  accept:        "Express interest and ask for next steps",
  negotiate:     "Counter with better terms",
  request_terms: "Ask for the scope, timeline, budget and usage they left open",
  decline:       "Decline graciously, keep door open",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function DealActionSheet({ deal, mode, onClose, onSend, seededDraft, disableGenerate, initialParams }: DealActionSheetProps) {

  // Pre-select intent from what the user tapped — or from the params Mila drafted with.
  const [intent, setIntent]         = useState<ReplyIntent>(
    initialParams?.replyIntent ??
      (mode === "terms" ? "request_terms" : mode === "negotiate" ? "negotiate" : "accept"),
  );
  // The terms mode swaps its own intent chip in place of "Accept" — a request-for-terms
  // ask, not a yes. accept/negotiate modes keep the original chip set unchanged.
  const intentOptions: ReplyIntent[] =
    mode === "terms" ? ["request_terms", "negotiate", "decline"] : ["accept", "negotiate", "decline"];
  const [style, setStyle]           = useState<DraftStyle>(initialParams?.style ?? "friendly");
  const [voice, setVoice]           = useState<DraftVoice>(initialParams?.voice ?? "athlete");
  const [asks, setAsks]             = useState<NegAsk[]>(() => {
    const seed = (deal.negotiateTerms && deal.negotiateTerms.length)
      ? deal.negotiateTerms
      : NEGOTIATE_TERMS.map((t) => t.label);
    return seed.map((t) => ({ orig: t, cur: t, selected: false }));
  });
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [instruction, setInstruct]  = useState("");
  const [includeKit, setIncludeKit] = useState(initialParams?.includeMediaKit ?? false);

  // Shared SSE reader (handles the `replace` event + client-side stream watchdog).
  // Previously this sheet duplicated the reader inline and never handled `replace`,
  // so drafts here missed the sanitized final email + signature.
  const {
    draft, streaming, generated, error: streamError, generate, editDraft, reset,
    saveDraft, persistDraft, clearDraft, saving, saved, gmailDraft,
  } = useDealDraft(deal.id);
  const [sending, setSending]       = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Seed the editor ONCE, from whichever source applies. editDraft sets draft +
  // generated, so the Generate button hides and Send enables — with no on-device
  // generation (the streaming path is the unfixed native bug PR-3 fixed only for chat).
  //
  //   1. Mila draft-as-data — the injected, freshly-generated text wins.
  //   2. Otherwise the draft saved on this deal, so closing the sheet and coming
  //      back resumes what you were writing instead of showing an empty editor.
  // `touchedRef` is what makes this safe to re-run. Saving invalidates the deals query,
  // so `deal.draftBody` can arrive AFTER mount — without the guard the effect would fire
  // then and overwrite everything typed since. "Have we seeded" isn't enough; the real
  // question is whether the editor is still untouched.
  const seededRef  = useRef(false);
  const touchedRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || touchedRef.current) return;
    if (disableGenerate && seededDraft) {
      seededRef.current = true;
      editDraft(seededDraft);
      return;
    }
    if (disableGenerate || !deal.draftBody?.trim()) return;
    // Only restore a draft written for what this sheet is FOR. Reopening "Negotiate"
    // must not hand back an acceptance with Send already enabled.
    if (deal.draftIntent && deal.draftIntent !== intent) return;
    seededRef.current = true;
    editDraft(deal.draftBody);
  }, [disableGenerate, seededDraft, deal.draftBody, deal.draftIntent, intent, editDraft]);

  // Every user-driven change to the text — typing or generating — marks the editor dirty
  // so no later async seed can clobber it.
  const handleEditDraft = useCallback((next: string) => {
    touchedRef.current = true;
    editDraft(next);
  }, [editDraft]);

  // Show hint when recommendation differs from user's tap
  const recoIntent = deal.recommendation === "accept" ? "accept"
    : deal.recommendation === "negotiate" ? "negotiate"
    : deal.recommendation === "reject" || deal.recommendation === "delete" ? "decline"
    : null;
  // The terms composer is a focused scope/budget ask — don't distract with the
  // accept/negotiate lean hint. accept/negotiate modes are unaffected (intent is
  // never "request_terms" there).
  const showHint = recoIntent !== null && recoIntent !== intent && intent !== "request_terms";

  function toggleAsk(i: number) {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setAsks((prev) => prev.map((a, j) => (j === i ? { ...a, selected: !a.selected } : a)));
  }
  function changeAsk(i: number, text: string) {
    setAsks((prev) => prev.map((a, j) => (j === i ? { ...a, cur: text } : a)));
  }
  function commitEdit(i: number) {
    setAsks((prev) => {
      const a = prev[i];
      if (!a) return prev;
      // Empty custom ask → discard the row; empty edit of Mila's ask → revert to hers.
      if (a.custom && a.cur.trim() === "") return prev.filter((_, j) => j !== i);
      return prev.map((x, j) => {
        if (j !== i) return x;
        const cur    = x.cur.trim() === "" ? x.orig : x.cur;
        const edited = cur.trim() !== x.orig.trim();
        return { ...x, cur, selected: x.selected || edited || !!x.custom };
      });
    });
    setEditingIdx(null);
  }
  function revertAsk(i: number) {
    setAsks((prev) => prev.map((a, j) => (j === i ? { ...a, cur: a.orig } : a)));
  }
  function addCustomAsk() {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setEditingIdx(asks.length);                 // edit the row we're about to append
    setAsks((prev) => [...prev, { orig: "", cur: "", selected: true, custom: true }]);
  }
  function removeAsk(i: number) {
    setAsks((prev) => prev.filter((_, j) => j !== i));
    setEditingIdx((cur) => (cur === i ? null : cur));
  }

  // In Mila mode the controls are read-only (draft-as-data) — never reset the seeded
  // draft. The read-only wrapper blocks taps too; this is belt-and-suspenders.
  function selectIntent(next: ReplyIntent) {
    if (disableGenerate) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setIntent(next);
    reset();
  }

  function selectStyle(next: DraftStyle) {
    if (disableGenerate) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setStyle(next);
    if (generated) reset();
  }

  function selectVoice(next: DraftVoice) {
    if (disableGenerate) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setVoice(next);
    if (generated) reset();
  }

  const selectedAsks = asks.filter((a) => a.selected).map((a) => a.cur.trim()).filter(Boolean);
  const canGenerate = intent !== "negotiate" || selectedAsks.length > 0;

  const generateDraft = useCallback(() => {
    if (disableGenerate) return; // Mila mode: the draft is injected, never generated here
    if (!canGenerate || streaming) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    generate({
      reply_intent:       intent,
      style,
      voice,
      selected_terms:     asks.filter((a) => a.selected).map((a) => a.cur.trim()).filter(Boolean),
      custom_instruction: instruction.trim() || undefined,
      include_media_kit:  includeKit,
    });
  }, [disableGenerate, canGenerate, streaming, generate, intent, style, voice, asks, instruction, includeKit]);

  const canSend = generated && draft.trim().length > 0 && !streaming && !sending;

  // Closing must never lose work. Anything in the editor is persisted on the way out —
  // Nomila-only, so an unfinished thought doesn't land in the athlete's Gmail. Deliberately
  // fire-and-forget: the close should feel instant, and persistDraft touches no state, so
  // the request outliving this component is harmless.
  const closeAndKeepDraft = useCallback(() => {
    const body  = draft.trim();
    const saved = (deal.draftBody ?? "").trim();
    if (body && body !== saved) {
      void persistDraft(body, { mirrorToGmail: false });
    } else if (!body && saved && touchedRef.current) {
      // Emptied on purpose — abandon it, or restore would hand back the text they
      // just deleted. Gated on `touched` so a sheet merely opened and closed on a
      // deal that has a draft never discards it.
      void clearDraft();
    }
    onClose();
  }, [draft, deal.draftBody, persistDraft, clearDraft, onClose]);

  // The explicit "Save as draft" — this one DOES reach Gmail.
  const handleSaveDraft = useCallback(() => {
    haptics.press();
    void saveDraft({ mirrorToGmail: true });
  }, [saveDraft]);

  const canSaveDraft = draft.trim().length > 0 && !streaming && !saving && !sending;

  async function handleSend() {
    if (!canSend) return;
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    setSending(true);
    try {
      await onSend(draft, intent);
    } finally {
      // Guard against setState after the sheet unmounts (onSend may close it).
      if (mountedRef.current) setSending(false);
    }
  }

  return (
    <Modal transparent statusBarTranslucent animationType="slide" onRequestClose={sending ? () => {} : closeAndKeepDraft}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={sending ? undefined : closeAndKeepDraft} disabled={sending} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* ── Header ── */}
          <View style={styles.header}>
            <BrandLogo
              brandName={deal.brandName}
              brandDomain={deal.brandDomain ?? null}
              size={36}
              borderRadius={10}
            />
            <View style={styles.headerText}>
              <Text style={styles.title}>Draft Reply</Text>
              <Text style={styles.brandName}>{deal.brandName}</Text>
            </View>
            <Pressable onPress={closeAndKeepDraft} disabled={sending} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="#9C968D" />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Mila mode: the draft was generated server-side and injected, so the
                generation controls below are shown seeded but read-only. The draft
                text stays editable.

                THE COPY DESCRIBES THIS SHEET, NOT THE CALL. It used to read "edit
                the text below, or ask Mila to redraft" — but a redraft opens a NEW
                card in the chat, and nothing about it happens here: this sheet has
                no path to regenerate (generateDraft early-returns under
                disableGenerate) and its seeded body never changes. So the line
                promised, on the surface that cannot do it, a thing that only
                happens somewhere else. Point at what this sheet actually offers —
                editing — and let the chat own re-opening. */}
            {disableGenerate && (
              <View style={styles.milaNote}>
                <Feather name="zap" size={11} color={Colors.light.primary} />
                <Text style={styles.milaNoteText}>
                  Drafted by Mila — edit the text below before you send.
                </Text>
              </View>
            )}
            <View
              pointerEvents={disableGenerate ? "none" : "auto"}
              style={disableGenerate ? styles.controlsReadOnly : undefined}
            >
            {/* ── Intent picker ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Your response</Text>
              <View style={styles.intentRow}>
                {intentOptions.map((id) => (
                  <Pressable
                    key={id}
                    style={[styles.intentChip, intent === id && intentChipActiveStyle(id)]}
                    onPress={() => selectIntent(id)}
                  >
                    <Feather
                      name={intentChipIcon(id)}
                      size={12}
                      color={intent === id ? "#fff" : "#9C968D"}
                    />
                    <Text style={[styles.intentChipText, intent === id && styles.intentChipTextActive]}>
                      {intentChipLabel(id)}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {showHint && recoIntent && (
                <View style={styles.hintRow}>
                  <Feather name="zap" size={11} color={Colors.light.primary} />
                  <Text style={styles.hintText}>
                    Mila suggests: {recoIntent}
                    {deal.recommendationUi ? ` — ${deal.recommendationUi}` : ""}
                  </Text>
                </View>
              )}
              <Text style={styles.intentHint}>{INTENT_HINT[intent]}</Text>
            </View>

            {/* ── Style picker ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Style</Text>
              <View style={styles.chipRow}>
                {(["friendly","professional"] as DraftStyle[]).map((s) => (
                  <Pressable
                    key={s}
                    style={[styles.chip, style === s && styles.chipActive]}
                    onPress={() => selectStyle(s)}
                  >
                    <Text style={[styles.chipText, style === s && styles.chipTextActive]}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Voice picker (write as the athlete or their team) ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Send as</Text>
              <View style={styles.chipRow}>
                {(["athlete","agent"] as DraftVoice[]).map((v) => (
                  <Pressable
                    key={v}
                    style={[styles.chip, voice === v && styles.chipActive]}
                    onPress={() => selectVoice(v)}
                  >
                    <Text style={[styles.chipText, voice === v && styles.chipTextActive]}>
                      {v === "athlete" ? "Myself" : "My team"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Negotiate terms checklist ── */}
            {intent === "negotiate" && (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>What to negotiate</Text>
                <Text style={styles.negHint}>
                  Mila's suggestions for this deal — check any to include, tap to reword, or add your own.
                </Text>
                <View style={styles.termsList}>
                  {asks.map((a, i) => {
                    const edited  = !a.custom && a.cur.trim() !== a.orig.trim();
                    const editing = editingIdx === i;
                    return (
                      <View key={i} style={[styles.termRow, a.selected && styles.termRowChecked]}>
                        <Pressable
                          onPress={() => toggleAsk(i)}
                          style={[styles.checkbox, a.selected && styles.checkboxChecked]}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: a.selected }}
                          hitSlop={6}
                        >
                          {a.selected && <Feather name="check" size={11} color="#fff" />}
                        </Pressable>
                        <View style={styles.askBody}>
                          {editing ? (
                            <TextInput
                              style={styles.askInput}
                              value={a.cur}
                              onChangeText={(t) => changeAsk(i, t)}
                              onBlur={() => commitEdit(i)}
                              onSubmitEditing={() => commitEdit(i)}
                              autoFocus
                              multiline
                              blurOnSubmit
                              returnKeyType="done"
                              placeholder={a.custom && a.orig === "" ? "Add your own ask…" : "Reword this ask…"}
                              placeholderTextColor="#B8B2AA"
                            />
                          ) : (
                            <Pressable style={styles.askTextRow} onPress={() => setEditingIdx(i)}>
                              <Text style={[styles.askText, a.selected && styles.termLabelChecked]}>
                                {a.cur}
                              </Text>
                              <Feather name="edit-2" size={12} color="#C9C1B8" style={styles.askPencil} />
                            </Pressable>
                          )}
                          {edited && !editing && (
                            <View style={styles.askMeta}>
                              <View style={styles.editedBadge}>
                                <Text style={styles.editedBadgeText}>Edited</Text>
                              </View>
                              <Pressable style={styles.revertBtn} onPress={() => revertAsk(i)} hitSlop={6}>
                                <Feather name="rotate-ccw" size={11} color={Colors.light.primary} />
                                <Text style={styles.revertText}>Use Mila's version</Text>
                              </Pressable>
                            </View>
                          )}
                          {a.custom && !editing && (
                            <View style={styles.askMeta}>
                              <View style={styles.yourBadge}>
                                <Text style={styles.yourBadgeText}>Your ask</Text>
                              </View>
                              <Pressable style={styles.revertBtn} onPress={() => removeAsk(i)} hitSlop={6}>
                                <Feather name="x" size={12} color={Colors.light.textMuted} />
                                <Text style={styles.removeText}>Remove</Text>
                              </Pressable>
                            </View>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
                <Pressable style={styles.addAskBtn} onPress={addCustomAsk}>
                  <Feather name="plus" size={14} color={Colors.light.primary} />
                  <Text style={styles.addAskText}>Add your own ask</Text>
                </Pressable>
                {selectedAsks.length === 0 && (
                  <Text style={styles.emptyHint}>Select at least one ask to generate a draft</Text>
                )}
              </View>
            )}

            {/* ── Custom instruction ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Custom instruction (optional)</Text>
              <TextInput
                style={styles.instructInput}
                value={instruction}
                onChangeText={setInstruct}
                placeholder="e.g. Mention I'm available for a call this week…"
                placeholderTextColor="#C5BFB8"
                multiline
                maxLength={400}
              />
            </View>

            {/* ── Media kit toggle ── */}
            <Pressable style={styles.toggleRow} onPress={() => setIncludeKit((v) => !v)}>
              <View style={styles.toggleLeft}>
                <Feather name="briefcase" size={14} color={includeKit ? Colors.light.primary : "#9C968D"} />
                <Text style={[styles.toggleLabel, includeKit && styles.toggleLabelActive]}>
                  Offer to share media kit
                </Text>
              </View>
              <View style={[styles.toggle, includeKit && styles.toggleOn]}>
                <View style={[styles.toggleKnob, includeKit && styles.toggleKnobOn]} />
              </View>
            </Pressable>

            {/* ── Generate button ── */}
            {!generated && (
              <Pressable
                style={[styles.generateBtn, (!canGenerate || streaming) && styles.generateBtnDisabled]}
                onPress={generateDraft}
                disabled={!canGenerate || streaming}
              >
                {streaming ? (
                  <>
                    <ActivityIndicator size="small" color={Colors.light.buttonText} />
                    <Text style={styles.generateBtnText}>Writing…</Text>
                  </>
                ) : (
                  <>
                    <Feather name="zap" size={14} color={Colors.light.buttonText} />
                    <Text style={styles.generateBtnText}>Generate Draft</Text>
                  </>
                )}
              </Pressable>
            )}
            </View>

            {/* ── Draft output ── */}
            {/* `generated || streaming` FIRST, and draft.length only as a fallback for
                the pre-`done` stream. Gating on draft.length alone meant clearing the
                field UNMOUNTED it: select-all + delete made this whole section vanish
                mid-edit, which reads as the input locking. There was no way back —
                generateDraft early-returns in Mila mode and the Rewrite button is
                hidden there, so only closing and reopening the sheet recovered. An
                empty draft is a normal editing state, not the absence of a draft. */}
            {(generated || streaming || draft.length > 0 || streamError) && (
              <View style={styles.section}>
                <View style={styles.draftLabelRow}>
                  {streamError ? (
                    <Feather name="alert-circle" size={11} color="#E87070" />
                  ) : (
                    <Feather name="zap" size={11} color={Colors.light.primary} />
                  )}
                  <Text style={[styles.draftLabel, streamError && styles.draftLabelError]}>
                    {streamError ? "Error" : streaming ? "Writing…" : "Mila's draft"}
                  </Text>
                  {generated && !streaming && !disableGenerate && (
                    <Pressable onPress={generateDraft} hitSlop={8} style={styles.regenBtn}>
                      <Feather name="refresh-cw" size={11} color="#9C968D" />
                      <Text style={styles.regenText}>Rewrite</Text>
                    </Pressable>
                  )}
                </View>

                {streamError ? (
                  <Text style={styles.errorText}>{streamError}</Text>
                ) : (
                  <TextInput
                    style={styles.draftInput}
                    value={draft}
                    onChangeText={handleEditDraft}
                    multiline
                    scrollEnabled={false}
                    textAlignVertical="top"
                    editable={!streaming}
                  />
                )}
              </View>
            )}
          </ScrollView>

          {/* ── Footer ── */}
          <View style={styles.footer}>
            {/* Says where the draft went, and offers the fix when Gmail refused it —
                a grant issued before gmail.compose can save in Nomila but not Gmail,
                and silently promising a Gmail draft is how that went unnoticed. */}
            {saved && (
              <Text style={styles.saveNote}>
                {gmailDraft === "saved"
                  ? "Saved here and in your Gmail drafts."
                  : gmailDraft === "unavailable"
                    ? "Saved here. Reconnect Gmail in Settings to also save it there."
                    : "Saved — it'll be here when you come back."}
              </Text>
            )}
            <View style={styles.footerRow}>
              <Pressable
                style={[styles.saveDraftBtn, !canSaveDraft && styles.saveDraftBtnDisabled]}
                onPress={handleSaveDraft}
                disabled={!canSaveDraft}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={Colors.light.primary} />
                ) : (
                  <Feather name={saved ? "check" : "save"} size={15} color={Colors.light.primary} />
                )}
                <Text style={styles.saveDraftText}>
                  {saving ? "Saving…" : saved ? "Saved" : "Save as draft"}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
                onPress={() => { haptics.press(); handleSend(); }}
                disabled={!canSend}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={Colors.light.buttonText} />
                ) : (
                  <Feather name="send" size={15} color={Colors.light.buttonText} />
                )}
                <Text style={styles.sendText}>{sending ? "Sending…" : "Send Reply"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function intentChipActiveStyle(id: ReplyIntent) {
  if (id === "accept")    return { backgroundColor: Bold.ink };
  if (id === "decline")   return { backgroundColor: "#9C968D" };
  return { backgroundColor: Colors.light.primary };
}

function intentChipIcon(id: ReplyIntent): React.ComponentProps<typeof Feather>["name"] {
  if (id === "accept")        return "check";
  if (id === "negotiate")     return "message-circle";
  if (id === "request_terms") return "file-text";
  return "x";
}

function intentChipLabel(id: ReplyIntent): string {
  if (id === "request_terms") return "Terms";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    backgroundColor: Colors.light.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    maxHeight: "90%",
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: Colors.light.border,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: Spacing.md,
  },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    gap:               Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingBottom:     Spacing.lg,
  },
  headerText: { flex: 1, gap: 2 },
  title: {
    fontFamily: Fonts.heading,
    fontSize: 18,
    color: Colors.light.text,
    letterSpacing: -0.3,
  },
  brandName: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#9C968D",
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },

  // Scroll
  scroll: { flexShrink: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.sm,
    gap: Spacing.xl,
  },

  // Sections
  section: { gap: 10 },
  sectionLabel: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    color: "#9C968D",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },

  // Intent
  intentRow: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  intentChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    borderRadius: BorderRadius.full,
    paddingVertical: 9,
  },
  intentChipText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: "#9C968D",
  },
  intentChipTextActive: {
    color: "#fff",
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: Colors.light.primary + "10",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  hintText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: Colors.light.primary,
    flex: 1,
  },
  intentHint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#C5BFB8",
    marginTop: -4,
  },

  // Style chips
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
  },
  chip: {
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    borderRadius: BorderRadius.full,
    paddingHorizontal: 14,
    paddingVertical: Spacing.sm,
  },
  chipActive: {
    backgroundColor: "#1C1915",
    borderColor: "#1C1915",
  },
  chipText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.textMuted,
  },
  chipTextActive: {
    color: "#fff",
  },

  // Negotiate terms
  termsList: { gap: 6 },
  termRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  termRowChecked: {
    backgroundColor: Colors.light.primary + "08",
    borderColor: Colors.light.primary + "30",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: Colors.light.primary,
    borderColor: Colors.light.primary,
  },
  termLabel: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 14,
    color: Colors.light.textMuted,
  },
  termLabelChecked: {
    color: Colors.light.text,
  },
  suggestedPill: {
    backgroundColor: Colors.light.primary + "18",
    borderRadius: BorderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  suggestedText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    color: Colors.light.primary,
  },
  emptyHint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#C5BFB8",
    textAlign: "center",
    paddingVertical: Spacing.sm,
  },
  negHint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
    marginTop: -2,
    marginBottom: 8,
    lineHeight: 16,
  },
  askBody: { flex: 1, gap: 6 },
  askTextRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  askText: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 14,
    lineHeight: 19,
    color: Colors.light.textMuted,
  },
  askPencil: { marginTop: 3 },
  askInput: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 14,
    lineHeight: 19,
    color: Colors.light.text,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: Colors.light.primary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  askMeta: { flexDirection: "row", alignItems: "center", gap: 10 },
  editedBadge: {
    backgroundColor: "#FBF1DC",
    borderRadius: BorderRadius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  editedBadgeText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: "#A6720C",
  },
  revertBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  revertText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    color: Colors.light.primary,
  },
  removeText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  yourBadge: {
    backgroundColor: Colors.light.primary + "14",
    borderRadius: BorderRadius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  yourBadgeText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: Colors.light.primary,
  },
  addAskBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  addAskText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.primary,
  },

  // Custom instruction
  instructInput: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    minHeight: 60,
    maxHeight: 100,
    lineHeight: 20,
    textAlignVertical: "top",
  },

  // Media kit toggle
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  toggleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  toggleLabel: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 14,
    color: Colors.light.textMuted,
  },
  toggleLabelActive: {
    color: Colors.light.text,
  },
  toggle: {
    width: 40,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.light.border,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  toggleOn: {
    backgroundColor: Colors.light.primary,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  toggleKnobOn: {
    alignSelf: "flex-end",
  },

  // Mila draft-as-data
  milaNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: Spacing.md,
  },
  milaNoteText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  controlsReadOnly: {
    opacity: 0.55,
  },

  // Generate button
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 48,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  generateBtnDisabled: {
    opacity: 0.4,
  },
  generateBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    color: Colors.light.buttonText,
  },

  // Draft
  draftLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  draftLabel: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11,
    color: Colors.light.primary,
    letterSpacing: 0.3,
    flex: 1,
  },
  draftLabelError: {
    color: "#E87070",
  },
  regenBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  regenText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: "#9C968D",
  },
  errorText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: "#E87070",
    lineHeight: 18,
  },
  draftInput: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    lineHeight: 22,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 12,
    padding: 14,
  },

  // Footer
  footer: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
  },
  // Send stays the dominant action; Save sits beside it as the quieter escape hatch.
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  saveNote: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
    textAlign: "center",
    marginBottom: Spacing.sm,
  },
  saveDraftBtn: {
    flex: 1,
    height: Spacing["5xl"],
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primaryLight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  saveDraftBtnDisabled: {
    opacity: 0.35,
  },
  saveDraftText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    color: Colors.light.primary,
  },
  sendBtn: {
    flex: 1.4,
    height: Spacing["5xl"],
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  sendBtnDisabled: {
    opacity: 0.35,
  },
  sendText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    color: Colors.light.buttonText,
  },
});
