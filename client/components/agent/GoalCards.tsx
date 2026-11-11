/**
 * Goal cards in the conversation (agent/1 `goal-proposal`, #890).
 *
 *   GoalProposalCard  a goal Mila proposes: the goal, its horizon, why now, what it's worth, the next decision and the
 *                     sources; Accept · Edit · Skip as the card allows. Edit saves the athlete's own wording (drawn behind
 *                     the blue rule). Nothing is set until tapped; each answer is an action on the turn route.
 *   OwnGoalComposer   "Add your own": a goal in the athlete's words, beside Mila's.
 *
 * The words for the goal chain come from lib/agent/naming.
 */
import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { Eyebrow, MilaButton, SettledLine, SoftChip, SourceChip, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import { NAMING } from "../../lib/agent/naming";
import type { CardOf, GoalHorizon } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const HORIZON_WORDS: Record<GoalHorizon, string> = { now: "This month", next: "This season", later: "The year ahead" };

export const GOAL_CARD_COPY = {
  eyebrow: `Proposed ${NAMING.goal.toLowerCase()}`,
  whyNow: "Why now",
  value: "What it's worth",
  next: "Your next decision",
  accept: "Accept",
  edit: "Edit",
  skip: "Skip",
  save: "Save",
  cancel: "Cancel",
  accepted: `Added to your ${NAMING.goals.toLowerCase()}.`,
  skipped: "Skipped. You can bring it back any time.",
  yourWords: "In your words",
  editLabel: `Edit this ${NAMING.goal.toLowerCase()}`,
  error: "That didn't save. Try again.",
} as const;

type State = "open" | "editing" | "accepted" | "edited" | "skipped";

export function GoalProposalCard({ card }: { card: CardOf<"goal-proposal"> }) {
  const { act } = useAgentCardHandlers();
  const p = card.payload;
  const [state, setState] = useState<State>("open");
  const [draft, setDraft] = useState(p.goal);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const can = (b: "accept" | "edit" | "skip") => p.buttons.includes(b);

  const answer = async (response: "accept" | "edit" | "skip", text?: string) => {
    if (!act) return;
    setBusy(true); setFailed(false);
    try {
      await act([{ type: "goal", decisionId: p.decisionId, response, ...(text ? { text } : {}) }]);
      haptics.success();
      if (response === "edit") { setMine(text ?? null); setState("edited"); } else setState(response === "accept" ? "accepted" : "skipped");
    } catch {
      setFailed(true); haptics.error();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.card, state === "skipped" && styles.dim]} testID="card-goal-proposal">
      <Eyebrow right={<SoftChip>{HORIZON_WORDS[p.horizon] ?? p.horizon}</SoftChip>}>{GOAL_CARD_COPY.eyebrow}</Eyebrow>
      {mine ? (
        <View style={styles.herWords} testID="goal-her-words">
          <Text style={styles.herLabel}>{GOAL_CARD_COPY.yourWords}</Text>
          <Text style={styles.herText}>{mine}</Text>
        </View>
      ) : (
        <Text style={styles.goal}>{p.goal}</Text>
      )}
      {state !== "skipped" ? (
        <>
          <View style={styles.block}>
            <Text style={styles.label}>{GOAL_CARD_COPY.whyNow}</Text>
            <Text style={partStyles.body}>{p.why}</Text>
          </View>
          <View style={styles.pair}>
            <View style={[styles.block, styles.half]}>
              <Text style={styles.label}>{GOAL_CARD_COPY.value}</Text>
              <Text style={styles.value}>{p.value}</Text>
            </View>
            <View style={[styles.block, styles.half]}>
              <Text style={styles.label}>{GOAL_CARD_COPY.next}</Text>
              <Text style={partStyles.body}>{p.nextDecision}</Text>
            </View>
          </View>
          {p.sources.length ? (
            <View style={partStyles.wrap}>{p.sources.slice(0, 3).map((s, i) => <SourceChip key={`${i}-${s.label}`} source={s} />)}</View>
          ) : null}
        </>
      ) : null}

      {state === "editing" ? (
        <View style={styles.block}>
          <TextInput value={draft} onChangeText={setDraft} autoFocus multiline style={partStyles.input} accessibilityLabel={GOAL_CARD_COPY.editLabel} testID="goal-editor" />
          <View style={partStyles.actions}>
            <MilaButton label={GOAL_CARD_COPY.save} onPress={() => { void answer("edit", draft.trim()); }} disabled={!draft.trim()} loading={busy} flex testID="goal-save" />
            <MilaButton label={GOAL_CARD_COPY.cancel} tone="soft" onPress={() => setState(mine ? "edited" : "open")} flex testID="goal-cancel" />
          </View>
        </View>
      ) : state === "accepted" || state === "edited" ? (
        <SettledLine text={GOAL_CARD_COPY.accepted} testID="goal-accepted" />
      ) : state === "skipped" ? (
        <SettledLine text={GOAL_CARD_COPY.skipped} icon="minus" testID="goal-skipped" />
      ) : act ? (
        <>
          {failed ? <Text style={partStyles.error}>{GOAL_CARD_COPY.error}</Text> : null}
          <View style={partStyles.actions}>
            {can("accept") ? <MilaButton label={GOAL_CARD_COPY.accept} onPress={() => { void answer("accept"); }} loading={busy} flex testID="goal-accept" /> : null}
            {can("edit") ? <MilaButton label={GOAL_CARD_COPY.edit} tone="soft" onPress={() => setState("editing")} disabled={busy} flex testID="goal-edit" /> : null}
            {can("skip") ? <MilaButton label={GOAL_CARD_COPY.skip} tone="quiet" onPress={() => { void answer("skip"); }} disabled={busy} testID="goal-skip" /> : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

export const OWN_GOAL_COPY = {
  label: "Add your own",
  placeholder: "A goal, in your words",
  add: "Add",
  added: (text: string) => `Added: ${text}`,
} as const;

export function OwnGoalComposer({ onAdd, busy, error }: { onAdd: (text: string) => void; busy?: boolean; error?: string | null }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (!t) return; onAdd(t); setText(""); };
  return (
    <View style={styles.card} testID="own-goal">
      <Eyebrow>{OWN_GOAL_COPY.label}</Eyebrow>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={OWN_GOAL_COPY.placeholder}
        placeholderTextColor={Bold.quiet}
        style={partStyles.input}
        accessibilityLabel={OWN_GOAL_COPY.label}
        onSubmitEditing={add}
        returnKeyType="done"
        testID="own-goal-input"
      />
      {error ? <Text style={partStyles.error}>{error}</Text> : null}
      <MilaButton label={OWN_GOAL_COPY.add} tone="soft" icon="plus" onPress={add} disabled={!text.trim()} loading={busy} testID="own-goal-add" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 12 },
  dim: { opacity: 0.7 },
  goal: { ...BoldType.goal, color: Bold.ink },
  block: { gap: 6 },
  pair: { flexDirection: "row", gap: 12 },
  half: { flex: 1, backgroundColor: Bold.ground, borderRadius: 12, padding: 10 },
  label: { ...BoldType.label, color: Bold.mute },
  value: { ...BoldType.rowTitle, color: Bold.ink },
  herWords: { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 12, gap: 4 },
  herLabel: { ...BoldType.herLabel, color: Bold.blue },
  herText: { ...BoldType.herWords, color: Bold.ink },
});
