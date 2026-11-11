/**
 * BriefProposalCard (agent/1 `brief-proposal`) — Mila's suggestion to change the athlete's strategy, from a research
 * refresh. What changed and why, the strategy now beside the suggestion, the sources; then Update · Keep mine · Edit it.
 * Nothing changes until she taps: Update makes the suggestion her strategy, Keep mine keeps hers (and Mila won't raise
 * the same suggestion again unless the facts change further), Edit it takes the suggestion with the positioning line in
 * her own words. Each answer is POST /me/agent/suggestions/:decisionId. A card re-read from history shows its answer.
 */
import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { Eyebrow, MilaButton, SettledLine, SourceChip, partStyles } from "./parts";
import { apiRequest } from "../../lib/query-client";
import { haptics } from "../../lib/haptics";
import type { CardOf } from "../../lib/agent/types";

export const SUGGESTION_CARD_COPY = {
  eyebrow: "Mila's suggestion",
  why: "What changed",
  now: "Yours now",
  suggested: "Suggested",
  update: "Update",
  keep: "Keep mine",
  edit: "Edit it",
  save: "Save",
  cancel: "Cancel",
  editLabel: "Your positioning, in your words",
  updated: "Updated. Your positioning now reads this way.",
  edited: "Updated, in your words.",
  kept: "Kept yours. Mila won't suggest this again unless something new comes up.",
  error: "That didn't save. Try again.",
} as const;

type Answer = "update" | "keep_mine" | "edit";

export async function answerSuggestion(decisionId: string, response: Answer, statement?: string): Promise<void> {
  await apiRequest("POST", `/api/v1/me/agent/suggestions/${encodeURIComponent(decisionId)}`, { response, ...(statement ? { statement } : {}) });
}

export function BriefProposalCard({ card }: { card: CardOf<"brief-proposal"> }) {
  const p = card.payload;
  const qc = useQueryClient();
  const [answered, setAnswered] = useState<Answer | null>(p.answered ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.after.statement);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const answer = async (response: Answer, statement?: string) => {
    setBusy(true); setFailed(false);
    try {
      await answerSuggestion(p.decisionId, response, statement);
      haptics.success();
      setAnswered(response); setEditing(false);
      // Home's row and the Brief read again.
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch {
      setFailed(true); haptics.error();
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, now: string, next: string) => (now || next ? (
    <View style={styles.pair} key={label}>
      <View style={[styles.half, styles.now]}>
        <Text style={styles.label}>{SUGGESTION_CARD_COPY.now}</Text>
        <Text style={partStyles.body}>{now || "—"}</Text>
      </View>
      <View style={[styles.half, styles.next]}>
        <Text style={styles.label}>{SUGGESTION_CARD_COPY.suggested}</Text>
        <Text style={partStyles.body}>{next || "—"}</Text>
      </View>
    </View>
  ) : null);

  return (
    <View style={[styles.card, answered === "keep_mine" && styles.dim]} testID="card-brief-proposal">
      <Eyebrow>{SUGGESTION_CARD_COPY.eyebrow}</Eyebrow>
      <Text style={partStyles.title}>{card.title}</Text>
      <View style={styles.block}>
        <Text style={styles.label}>{SUGGESTION_CARD_COPY.why}</Text>
        <Text style={partStyles.body}>{p.reason}</Text>
      </View>
      {p.changed.includes("thesis") ? row("thesis", p.before.bigIdea, p.after.bigIdea) : null}
      {p.changed.includes("positioning") ? row("positioning", p.before.statement, p.after.statement) : null}
      {p.changed.includes("pillars") ? row("pillars", p.before.contentPillars.join(" · "), p.after.contentPillars.join(" · ")) : null}
      {p.sources.length ? (
        <View style={partStyles.wrap}>{p.sources.slice(0, 3).map((s, i) => <SourceChip key={`${i}-${s.label}`} source={s} />)}</View>
      ) : null}

      {answered === "update" ? <SettledLine text={SUGGESTION_CARD_COPY.updated} testID="suggestion-updated" />
        : answered === "edit" ? <SettledLine text={SUGGESTION_CARD_COPY.edited} testID="suggestion-edited" />
        : answered === "keep_mine" ? <SettledLine text={SUGGESTION_CARD_COPY.kept} icon="minus" testID="suggestion-kept" />
        : editing ? (
          <View style={styles.block}>
            <TextInput value={draft} onChangeText={setDraft} autoFocus multiline style={partStyles.input} accessibilityLabel={SUGGESTION_CARD_COPY.editLabel} testID="suggestion-editor" />
            {failed ? <Text style={partStyles.error}>{SUGGESTION_CARD_COPY.error}</Text> : null}
            <View style={partStyles.actions}>
              <MilaButton label={SUGGESTION_CARD_COPY.save} onPress={() => { void answer("edit", draft.trim()); }} disabled={!draft.trim()} loading={busy} flex testID="suggestion-save" />
              <MilaButton label={SUGGESTION_CARD_COPY.cancel} tone="soft" onPress={() => setEditing(false)} flex testID="suggestion-cancel" />
            </View>
          </View>
        ) : (
          <>
            {failed ? <Text style={partStyles.error}>{SUGGESTION_CARD_COPY.error}</Text> : null}
            <View style={partStyles.actions}>
              <MilaButton label={SUGGESTION_CARD_COPY.update} onPress={() => { void answer("update"); }} loading={busy} flex testID="suggestion-update" />
              <MilaButton label={SUGGESTION_CARD_COPY.edit} tone="soft" onPress={() => setEditing(true)} disabled={busy} flex testID="suggestion-edit" />
              <MilaButton label={SUGGESTION_CARD_COPY.keep} tone="quiet" onPress={() => { void answer("keep_mine"); }} disabled={busy} testID="suggestion-keep" />
            </View>
          </>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 12 },
  dim: { opacity: 0.7 },
  block: { gap: 6 },
  pair: { flexDirection: "row", gap: 12 },
  half: { flex: 1, borderRadius: 12, padding: 10, gap: 4 },
  now: { backgroundColor: Bold.ground },
  next: { borderWidth: 1, borderColor: Bold.blue },
  label: { ...BoldType.label, color: Bold.mute },
});
