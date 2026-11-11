// MilaGoalWidget — the confirm card for a goal change Mila proposed (Goals PR, "Goals in your words" §3f, look B).
//
// Mila's tool WRITES NOTHING. This card shows the goal written out (the text, the domain, the horizon) and two buttons:
// the primary one (Add goal · Save changes · Remove goal) calls the SAME routes the app's sheets call — POST
// /me/objectives, or the decision route with modify / achieve / abandon — so only her tap changes a goal (tap-to-send
// rule). "Change it" sets the card aside and she tells Mila what to change in the composer. Once done, the card says so
// and its buttons go. A failure leaves the buttons, with a line to try again.

import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Chip, Button } from "../ui";
import { useCreateObjective, useDecideObjective } from "../../hooks/use-objectives";
import { herHorizon } from "../../lib/goalLogic";
import type { GoalChangeWidgetData } from "../../hooks/use-mila-chat";
import { domainLabel, horizonWords } from "../../lib/strategyLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "./milaSurface";

export const GOAL_CARD_COPY = {
  title: { add: "Add this goal?", edit: "Change this goal?", remove: "Remove this goal?" },
  confirm: { add: "Add goal", edit: "Save changes", remove: "Remove goal" },
  done: { add: "Added to Goals. Nomila will plan around it.", edit: "Saved. Nomila re-plans around it.", remove: "Removed from Goals. It stays in your history." },
  change: "Change it",
  tellMila: "Tell Mila what to change.",
  was: "Now",
  removeAs: { achieved: "You've done it — it stays in your history as a win.", not_for_me: "It's not for you any more." },
  safety: "Mila never changes your goals without your tap.",
  error: "Couldn't save that. Try again.",
} as const;

export function MilaGoalWidget({ data }: { data: GoalChangeWidgetData }) {
  const create = useCreateObjective();
  const decide = useDecideObjective();
  const [state, setState] = useState<"open" | "changing" | "done">("open");
  const busy = create.isPending || decide.isPending;
  const failed = create.isError || decide.isError;
  const horizon = data.byWhen ? horizonWords({ kind: "period", period: data.byWhen, why: "" }) : null;

  const confirm = () => {
    if (busy || state === "done") return;
    const done = { onSuccess: () => { haptics.success(); setState("done"); } };
    if (data.change === "add") {
      create.mutate({ desiredState: data.goal, domain: data.domain, horizon: data.byWhen ? herHorizon(data.byWhen) : null, observableCondition: data.howSheKnows ?? undefined }, done);
    } else if (data.change === "edit" && data.goalId) {
      decide.mutate({ id: data.goalId, action: "modify", desiredState: data.goal, ...(data.byWhen ? { horizon: herHorizon(data.byWhen) } : {}), ...(data.howSheKnows ? { success: data.howSheKnows } : {}) }, done);
    } else if (data.change === "remove" && data.goalId && data.removeAs) {
      decide.mutate({ id: data.goalId, action: data.removeAs === "achieved" ? "achieve" : "abandon" }, done);
    }
  };

  return (
    <View style={styles.card} testID="mila-goal-card">
      <Text style={styles.eyebrow}>{GOAL_CARD_COPY.title[data.change]}</Text>
      <Text style={styles.goal} testID="mila-goal-text">{data.goal}</Text>
      {data.change === "edit" && data.currentGoal && data.currentGoal !== data.goal ? <Text style={styles.was}>{GOAL_CARD_COPY.was}: {data.currentGoal}</Text> : null}
      {data.change === "remove" && data.removeAs ? <Text style={styles.was}>{GOAL_CARD_COPY.removeAs[data.removeAs]}</Text> : null}
      <View style={styles.chips}>
        <Chip bold="dark">{domainLabel(data.domain)}</Chip>
        {horizon ? <Chip bold="line">{horizon}</Chip> : null}
      </View>
      {data.howSheKnows && data.change !== "remove" ? <Text style={styles.how}>You'd know when: {data.howSheKnows}</Text> : null}
      {state === "done" ? (
        <Text style={styles.done} testID="mila-goal-done">{GOAL_CARD_COPY.done[data.change]}</Text>
      ) : state === "changing" ? (
        <Text style={styles.how} testID="mila-goal-changing">{GOAL_CARD_COPY.tellMila}</Text>
      ) : (
        <>
          {failed ? <Text style={styles.error}>{GOAL_CARD_COPY.error}</Text> : null}
          <View style={styles.actions}>
            <Button bold="primary" onPress={confirm} loading={busy} style={styles.btn} testID="mila-goal-confirm">{GOAL_CARD_COPY.confirm[data.change]}</Button>
            <Button bold="secondary" onPress={() => setState("changing")} disabled={busy} style={styles.btn} testID="mila-goal-change">{GOAL_CARD_COPY.change}</Button>
          </View>
          <Text style={styles.safety}>{GOAL_CARD_COPY.safety}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A light Mila card with the soft lift, no border (milaSurface; DESIGN.md §16).
  card:    { ...MILA_CARD, padding: 14, gap: 10 },
  eyebrow: { ...BoldType.h4, color: Bold.ink },
  goal:    { ...BoldType.goalSm, color: Bold.ink },
  was:     { ...BoldType.rowMeta, color: Bold.ink2 },
  chips:   { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  how:     { ...BoldType.rowMeta, color: Bold.ink2 },
  done:    { ...BoldType.rowMeta, color: Bold.ink },
  error:   { ...BoldType.caption, color: Bold.mute },
  actions: { flexDirection: "row", gap: 8 },
  btn:     { flex: 1 },
  safety:  { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
});
