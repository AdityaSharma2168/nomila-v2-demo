/**
 * FactReviewCard (agent/1 `fact-review`, #890) — facts Mila found, each with its type mark, date, sources and the
 * controls the card allows (Right · Fix · Remove). Fix opens a short edit in place; the athlete's words then stand behind
 * the blue rule and win over what was found (the server keeps them as a "said" fact). "All look right" confirms the
 * rest and tells Mila the review is done. A disputed fact says so. Each answer is an action on the turn route.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { Eyebrow, FactMark, MilaButton, SourceChip, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import type { CardOf, FactReviewAction, FactReviewCardPayload } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const FACT_COPY = {
  title: "Did I get this right?",
  right: "Right",
  fix: "Fix",
  remove: "Remove",
  save: "Save",
  cancel: "Cancel",
  confirmed: "Confirmed",
  removed: "Removed",
  youSaid: "You said",
  disputed: "Sources disagree on this",
  care: "Private. I'll never use this in anything public.",
  allRight: "All look right",
  checked: (n: number, of: number) => `${n} of ${of} checked`,
  error: "That didn't save. Try again.",
  editLabel: "Correct this fact",
} as const;

type Fact = FactReviewCardPayload["facts"][number];
type Answer = { action: FactReviewAction; correction: string | null };

function Control({ icon, label, onPress, testID, disabled }: { icon: string; label: string; onPress: () => void; testID: string; disabled?: boolean }) {
  return (
    <Pressable
      onPress={() => { haptics.select(); onPress(); }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.control, pressed && styles.pressed, disabled && { opacity: 0.4 }]}
      testID={testID}
    >
      <Feather name={icon as any} size={14} color={Bold.ink} />
      <Text style={styles.controlText}>{label}</Text>
    </Pressable>
  );
}

function FactRow({ f, answer, buttons, last, onAnswer, busy }: {
  f: Fact; answer: Answer | null; buttons: FactReviewCardPayload["buttons"]; last: boolean;
  onAnswer: ((a: Answer) => Promise<boolean>) | null; busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(answer?.correction ?? f.claim);
  const struck = answer?.action === "remove" || answer?.action === "correct";
  const send = async (a: Answer) => { if (onAnswer && (await onAnswer(a))) setEditing(false); };

  return (
    <View style={[styles.fact, !last && styles.factRule]} testID={`fact-${f.factId}`}>
      <Text style={[styles.claim, struck && styles.struck]}>{f.claim}</Text>
      {answer?.action === "correct" && answer.correction ? (
        <View style={styles.herWords} testID="fact-correction">
          <Text style={styles.herLabel}>{FACT_COPY.youSaid}</Text>
          <Text style={styles.herText}>{answer.correction}</Text>
        </View>
      ) : null}
      {f.status === "disputed" ? <Text style={styles.disputed}>{FACT_COPY.disputed}</Text> : null}
      {/* A "care" fact (private life) is shown plainly so the athlete can check it, never highlighted anywhere. */}
      {f.sensitivity === "care" ? (
        <View style={styles.care} testID="fact-care">
          <Feather name="lock" size={12} color={Bold.mute} />
          <Text style={styles.careText}>{FACT_COPY.care}</Text>
        </View>
      ) : null}
      <View style={partStyles.wrap}>
        <FactMark type={f.type} />
        {f.date ? <Text style={partStyles.caption}>{f.date}</Text> : null}
        {f.sources.slice(0, 2).map((s, i) => <SourceChip key={`${i}-${s.label}`} source={s} />)}
      </View>

      {!onAnswer ? null : editing ? (
        <View style={styles.edit}>
          <TextInput value={draft} onChangeText={setDraft} autoFocus style={partStyles.input} accessibilityLabel={FACT_COPY.editLabel} testID="fact-editor" />
          <View style={partStyles.actions}>
            <MilaButton label={FACT_COPY.save} onPress={() => { void send({ action: "correct", correction: draft.trim() }); }} disabled={!draft.trim()} loading={busy} flex testID="fact-save" />
            <MilaButton label={FACT_COPY.cancel} tone="soft" onPress={() => setEditing(false)} flex testID="fact-cancel" />
          </View>
        </View>
      ) : !answer ? (
        <View style={styles.controls}>
          {buttons.includes("confirm") ? <Control icon="check" label={FACT_COPY.right} onPress={() => { void send({ action: "confirm", correction: null }); }} disabled={busy} testID="fact-confirm" /> : null}
          {buttons.includes("correct") ? <Control icon="edit-2" label={FACT_COPY.fix} onPress={() => setEditing(true)} disabled={busy} testID="fact-fix" /> : null}
          {buttons.includes("remove") ? <Control icon="x" label={FACT_COPY.remove} onPress={() => { void send({ action: "remove", correction: null }); }} disabled={busy} testID="fact-remove" /> : null}
        </View>
      ) : (
        <View style={styles.settled}>
          <Feather name={answer.action === "remove" ? "x" : "check"} size={14} color={Bold.ink} />
          <Text style={styles.settledText}>{answer.action === "confirm" ? FACT_COPY.confirmed : answer.action === "remove" ? FACT_COPY.removed : FACT_COPY.youSaid}</Text>
          {answer.action !== "remove" && buttons.includes("correct") ? (
            <Pressable onPress={() => { setDraft(answer.correction ?? f.claim); setEditing(true); }} accessibilityRole="button" accessibilityLabel={FACT_COPY.fix} hitSlop={12} testID="fact-refix">
              <Text style={styles.refix}>{FACT_COPY.fix}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

export function FactReviewCard({ card }: { card: CardOf<"fact-review"> }) {
  const { act } = useAgentCardHandlers();
  const facts = card.payload.facts;
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const checked = facts.filter((f) => answers[f.factId]).length;
  const open = facts.filter((f) => !answers[f.factId]);

  const send = act
    ? async (pairs: Array<[Fact, Answer]>, final: boolean): Promise<boolean> => {
        setBusy(true); setFailed(false);
        try {
          await act(
            [
              ...pairs.map(([f, a]) => ({ type: "fact_review" as const, factId: f.factId, action: a.action, ...(a.correction ? { correction: a.correction } : {}) })),
              ...(final ? [{ type: "facts_reviewed" as const }] : []),
            ],
            { reply: final },
          );
          haptics.success();
          setAnswers((all) => ({ ...all, ...Object.fromEntries(pairs.map(([f, a]) => [f.factId, a])) }));
          return true;
        } catch {
          setFailed(true); haptics.error();
          return false;
        } finally {
          setBusy(false);
        }
      }
    : null;

  return (
    <View style={styles.card} testID="card-fact-review">
      <Eyebrow right={<Text style={partStyles.caption}>{FACT_COPY.checked(checked, facts.length)}</Text>}>{card.title || FACT_COPY.title}</Eyebrow>
      <View>
        {facts.map((f, i) => (
          <FactRow
            key={f.factId} f={f} answer={answers[f.factId] ?? null} buttons={card.payload.buttons} last={i === facts.length - 1} busy={busy}
            onAnswer={send ? (a) => send([[f, a]], false) : null}
          />
        ))}
      </View>
      {failed ? <Text style={partStyles.error} accessibilityLiveRegion="polite">{FACT_COPY.error}</Text> : null}
      {send && open.length && card.payload.buttons.includes("confirm") ? (
        <MilaButton label={FACT_COPY.allRight} tone="soft" icon="check" onPress={() => { void send(open.map((f) => [f, { action: "confirm", correction: null }]), true); }} loading={busy} testID="fact-all-right" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 8 },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  fact: { gap: 8, paddingVertical: 12 },
  factRule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Bold.line },
  claim: { ...BoldType.rowTitle, color: Bold.ink },
  struck: { textDecorationLine: "line-through", color: Bold.mute },
  disputed: { ...BoldType.caption, color: Bold.blue },
  care: { flexDirection: "row", alignItems: "center", gap: 6 },
  careText: { ...BoldType.caption, color: Bold.mute, flex: 1 },
  herWords: { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 10, gap: 2 },
  herLabel: { ...BoldType.herLabel, color: Bold.blue },
  herText: { ...BoldType.herWords, color: Bold.ink },
  edit: { gap: 8 },
  controls: { flexDirection: "row", gap: 8 },
  control: { flexDirection: "row", alignItems: "center", gap: 5, height: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: Bold.ground, minWidth: 44, justifyContent: "center" },
  controlText: { ...BoldType.chipLine, color: Bold.ink },
  settled: { flexDirection: "row", alignItems: "center", gap: 6 },
  settledText: { ...BoldType.chipLine, color: Bold.ink, flex: 1 },
  refix: { ...BoldType.link, color: Bold.blue },
});
