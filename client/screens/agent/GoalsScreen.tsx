/**
 * Goals — one screen (EXPO_PUBLIC_AGENT_V3; replaces Goals · Plan · Results on the second tab). Look B (DESIGN.md):
 * each goal card shows the goal in the athlete's words (behind the blue her-words rule), the game plan in 1–2 lines, and
 * this week's 1–3 actions. An action Mila has made opens it (Studio); one not started yet starts it in Mila; a finished
 * one says so. Words for the chain come from lib/agent/naming. Loading, error, empty and pull-to-refresh included.
 */
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { Bold, BoldType } from "../../constants/theme";
import { Button, Card, Chip, IconTile } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { useAgentGoals } from "../../lib/agent/hooks";
import { NAMING } from "../../lib/agent/naming";
import { openAgentTarget } from "../../lib/agent/navigate";
import { openMila } from "../../lib/milaLaunch";
import type { AgentGoal, GoalAction, GoalActionKind } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const GOALS_COPY = {
  title: NAMING.tab,
  lede: "What you want, how you'll get there, and what's next this week.",
  open: "Open",
  start: "Start with Mila",
  done: "Done",
  noActions: "Nothing planned this week yet.",
  planIt: "Plan this week with Mila",
  planPrompt: (goal: string) => `Plan this week's actions for my goal: ${goal}`,
  emptyTitle: `No ${NAMING.goals.toLowerCase()} yet`,
  emptyLine: "Tell Mila what you want, in your own words, and you'll build the game plan together.",
  add: `Add a ${NAMING.goal.toLowerCase()}`,
  addPrompt: "I want to add a goal: ",
  error: `Couldn't load your ${NAMING.goals.toLowerCase()}.`,
  retry: "Retry",
} as const;

const ACTION_GLYPH: Record<GoalActionKind, string> = {
  post_kit: "film", deck: "layers", page: "globe", pitch: "send", reply: "mail", visual: "image", task: "check-square",
};

function ActionRow({ action, last, onPress }: { action: GoalAction; last: boolean; onPress: (() => void) | null }) {
  const done = action.state === "done";
  const cta = action.state === "made" ? GOALS_COPY.open : action.state === "to_start" ? GOALS_COPY.start : null;
  const body = (
    <>
      <IconTile icon={done ? "check" : (ACTION_GLYPH[action.kind] as any)} bold={done ? "grey" : "black"} />
      <View style={styles.actionText}>
        <Text style={[styles.actionTitle, done && styles.actionDone]} numberOfLines={2}>{action.title}</Text>
        {action.when ? <Text style={styles.actionMeta}>{done ? GOALS_COPY.done : action.when}</Text> : done ? <Text style={styles.actionMeta}>{GOALS_COPY.done}</Text> : null}
      </View>
      {cta && onPress ? (
        <View style={styles.cta}>
          <Text style={styles.ctaText}>{cta}</Text>
          <Feather name="chevron-right" size={16} color={Bold.blue} />
        </View>
      ) : null}
    </>
  );
  if (!onPress) return <View style={[styles.action, !last && styles.actionRule]} testID={`goal-action-${action.id}`}>{body}</View>;
  return (
    <Pressable
      onPress={() => { haptics.tap(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={`${action.title}. ${cta}`}
      style={({ pressed }) => [styles.action, !last && styles.actionRule, pressed && styles.pressed]}
      testID={`goal-action-${action.id}`}
    >
      {body}
    </Pressable>
  );
}

export function GoalCard({ goal, onAction, onPlan }: { goal: AgentGoal; onAction: (a: GoalAction) => (() => void) | null; onPlan: () => void }) {
  const actions = goal.actions.slice(0, 3);
  return (
    <Card bold style={styles.card} testID={`goal-${goal.id}`}>
      <View style={styles.cardHead}>
        <Text style={styles.eyebrow}>{NAMING.goal}</Text>
        {goal.horizon ? <Chip bold="line">{goal.horizon}</Chip> : null}
      </View>
      <View style={styles.herRule}>
        <Text style={styles.goal} accessibilityRole="header">{goal.text}</Text>
      </View>
      {goal.plan ? (
        <View style={styles.block}>
          <Text style={styles.eyebrow}>{NAMING.gamePlan}</Text>
          <Text style={styles.plan} numberOfLines={3}>{goal.plan}</Text>
        </View>
      ) : null}
      <View style={styles.block}>
        <Text style={styles.eyebrow}>{NAMING.thisWeek}</Text>
        {actions.length ? (
          <View style={styles.actions}>
            {actions.map((a, i) => <ActionRow key={a.id} action={a} last={i === actions.length - 1} onPress={onAction(a)} />)}
          </View>
        ) : (
          <View style={styles.none}>
            <Text style={styles.plan}>{GOALS_COPY.noActions}</Text>
            <Pressable onPress={onPlan} accessibilityRole="button" hitSlop={10} style={styles.planIt} testID={`goal-plan-${goal.id}`}>
              <Text style={styles.ctaText}>{GOALS_COPY.planIt}</Text>
              <Feather name="arrow-right" size={14} color={Bold.blue} />
            </Pressable>
          </View>
        )}
      </View>
    </Card>
  );
}

export function GoalsScreen() {
  const navigation = useNavigation<any>();
  const q = useAgentGoals();
  const pull = usePullRefresh(() => q.refetch());
  const goals = q.data ?? [];

  const startInMila = (prompt: string) => openMila({ context: undefined, draft: undefined, prompt });
  const onAction = (a: GoalAction): (() => void) | null => {
    if (a.state === "made" && a.open) { const t = a.open; return () => { openAgentTarget(navigation, t); }; }
    if (a.state === "to_start" && a.startPrompt) { const p = a.startPrompt; return () => startInMila(p); }
    return null;
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} refreshControl={pullRefresh(pull)} showsVerticalScrollIndicator={false} testID="agent-goals">
      <View style={styles.head}>
        <Text style={styles.title}>{GOALS_COPY.title}</Text>
        <Text style={styles.lede}>{GOALS_COPY.lede}</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center} testID="goals-loading"><ActivityIndicator color={Bold.ink} /></View>
      ) : q.isError ? (
        <View style={styles.center} testID="goals-error">
          <Text style={styles.muted}>{GOALS_COPY.error}</Text>
          <Button bold="small" onPress={() => { void q.refetch(); }}>{GOALS_COPY.retry}</Button>
        </View>
      ) : goals.length === 0 ? (
        <Card bold style={styles.card} testID="goals-empty">
          <View style={styles.center}>
            <Feather name="target" size={22} color={Bold.quiet} />
            <Text style={styles.emptyTitle}>{GOALS_COPY.emptyTitle}</Text>
            <Text style={styles.muted}>{GOALS_COPY.emptyLine}</Text>
          </View>
        </Card>
      ) : (
        goals.map((g) => <GoalCard key={g.id} goal={g} onAction={onAction} onPlan={() => startInMila(GOALS_COPY.planPrompt(g.text))} />)
      )}
      {!q.isLoading && !q.isError ? (
        <Button bold="secondary" onPress={() => openMila({ draft: GOALS_COPY.addPrompt })} icon={<Feather name="plus" size={15} color={Bold.onDark} />} style={styles.add} testID="goals-add">
          {GOALS_COPY.add}
        </Button>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Bold.paper },
  content: { paddingBottom: 40 },
  head: { paddingHorizontal: Bold.gutter, paddingTop: 4, gap: 6 },
  title: { ...BoldType.screenTitle, color: Bold.ink },
  lede: { ...BoldType.lede, color: Bold.mute },
  card: { marginHorizontal: Bold.gutter, marginTop: 16, padding: 14, gap: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { ...BoldType.label, color: Bold.mute },
  herRule: { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 12 },
  goal: { ...BoldType.goal, color: Bold.ink },
  block: { gap: 6 },
  plan: { ...BoldType.body, color: Bold.ink2 },
  actions: { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, minHeight: 56 },
  actionRule: { borderBottomWidth: 1, borderBottomColor: Bold.line },
  actionText: { flex: 1, gap: 2 },
  actionTitle: { ...BoldType.rowTitle, color: Bold.ink },
  actionDone: { color: Bold.mute, textDecorationLine: "line-through" },
  actionMeta: { ...BoldType.rowMeta, color: Bold.mute },
  cta: { flexDirection: "row", alignItems: "center", gap: 2 },
  ctaText: { ...BoldType.link, color: Bold.blue },
  none: { gap: 6 },
  planIt: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  center: { alignItems: "center", gap: 8, paddingVertical: 24, paddingHorizontal: 20 },
  muted: { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
  emptyTitle: { ...BoldType.h4, color: Bold.ink },
  add: { marginHorizontal: Bold.gutter, marginTop: 16 },
});
