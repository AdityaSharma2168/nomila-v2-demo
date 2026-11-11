/**
 * Goals tab — the CHOSEN design (draft PR #900, owner 10 Oct 2026), live over GET /me/agent/goals (#904/#905). The
 * Strategy tab is Goals with EXPO_PUBLIC_AGENT_V3 on; this screen draws it while the server's AGENT_PLAN serves the
 * route. While the route is dark (404) the tab is exactly what it was (GoalsScreen), so either flag off changes nothing.
 *
 *   Title          "Goals", "The goals you've set, in your words."
 *   Goals          the open goal in full (image band, category and horizon chips, the goal line, the game plan, this
 *                  week's actions each with its button, Change · Set aside · Drop); the others below as compact cards
 *                  (image, goal line, horizon chip, next action). A tap anywhere on a compact card opens it and folds
 *                  the open one. Home's "Coming up" opens the tab at the goal timed for the event (route param goalId)
 *   Recommended    "Recommended for you": a horizontal rail, Keep / Not now
 *   + Add a goal   your own goal, in your words, with its horizon
 *   Set aside      the set-aside goals, each with Bring back
 *   Post rows      (design "Goals tab post details + plan ready", 12 Oct 2026) a post reads as its idea, with one button
 *                  into its kit and the kit's state; a tap elsewhere opens the idea in place, one at a time
 *   Updating       while a plan run is in progress (the read's `planning`): "Mila is updating your plan", a re-read
 *                  every 5 s (only then, only while the tab is focused) and on every return to the tab; when it ends,
 *                  the notice "Your plan is updated: N posts this week."
 *
 * Every write answers with the fresh read and a change card; its Undo shows on the line under the title. Images per
 * DESIGN.md §9: her action shot for a performance goal only, atmosphere for every other card (POST /me/atmosphere/pick,
 * no image credit shown: owner, #907), the category default while the picker is dark. Upside / risk is NOT on this tab.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { Bold, BoldType } from "../../constants/theme";
import { Button, Card, SectionHead } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { CompactGoalCard, FullGoalCard, GoalEditor, RecommendedCard, SetAsideRow, type PostRowHandlers } from "../../components/goals/GoalCards";
import { useAgentGoalsPlan, useAtmosphere, useGoalWrite, usePostKitWrite } from "../../lib/agent/hooks";
import type { GoalWrite } from "../../lib/agent/api";
import { openAgentTarget } from "../../lib/agent/navigate";
import { ATMOSPHERE_SCREEN, atmosphereSlots, goalImages, GOALS_UPDATING_COPY, postsThisWeek, recSlotKey, type GoalImage } from "../../lib/agent/goalsLogic";
import { buildOutcomeLine, POST_KIT_COPY } from "../../components/postKit/copy";
import { openMila } from "../../lib/milaLaunch";
import { askForPushOnce } from "../../lib/push";
import { openSettings } from "../../navigation/meNav";
import { OPPS_BOARD } from "../../lib/flags";
import { useMePool } from "../../hooks/use-me-knowledge";
import { photoUri } from "../../lib/myStoryLogic";
import { GoalsScreen } from "./GoalsScreen";
import type { GoalActionView } from "../../../shared/plan";
import type { GoalChangeCardPayload } from "../../../shared/agent";

export const GOALS_TAB_COPY = {
  title: "Goals",
  lede: "The goals you've set, in your words.",
  add: "Add a goal",
  recommended: "Recommended for you",
  recommendedSub: "Goals Nomila suggests keeping.",
  setAside: "Set aside for now",
  emptyTitle: "No goals yet",
  emptyLine: "Add one in your own words, or keep one of the goals recommended for you.",
  error: "Couldn't load your goals.",
  retry: "Retry",
  undo: "Undo",
  failed: "That didn't save. Try again.",
  skipped: "Not suggested again for 90 days.",
  done: {
    keep: "Kept. It's one of your goals now.",
    change: "Goal changed.",
    set_aside: "Set aside for now.",
    drop: "Goal dropped.",
    add: "Goal added.",
    bring_back: "Brought back.",
    suggest: "Suggested for you.",
  } satisfies Record<GoalChangeCardPayload["op"], string>,
  undone: "Undone.",
} as const;

type Nav = { navigate: (...args: any[]) => void; setParams?: (p: object) => void };

/** Where an action's button (and its row) goes: Mila starts it, or it opens the item it made / the thread / the connect. */
export function openGoalAction(navigation: Nav, a: GoalActionView): void {
  if (a.state === "done") return;
  if (a.button === "start" && a.startPrompt) { openMila({ prompt: a.startPrompt }); return; }
  const o = a.open;
  if (o && "url" in o) { Promise.resolve(Linking.openURL(o.url)).catch(() => {}); return; }
  const id = (o?.params as Record<string, unknown> | undefined) ?? {};
  switch (o?.screen) {
    case "studio-item": navigation.navigate("Studio", { screen: "StudioHome", params: { focus: id.id } }); return;
    case "opportunity":
      if (OPPS_BOARD) navigation.navigate("Opportunities", { screen: "OpportunityDetail", params: { opportunityId: id.opportunityId } });
      else navigation.navigate("Opportunities");
      return;
    case "connect": openSettings(navigation); return;
  }
  if (o && openAgentTarget(navigation, o)) return;
  openMila({ prompt: a.startPrompt ?? a.title });
}

/** The tab: the chosen design while the route serves, today's screen while it is dark. */
export function GoalsTab(props: { route?: { params?: { goalId?: string } }; title?: string }) {
  const q = useAgentGoalsPlan();
  if (q.data === null) return <GoalsScreen />;
  return <GoalsPlanScreen route={props.route} title={props.title} />;
}

/** A post action's kit screen (Studio › PostKit), built or not: the kit screen says when nothing is built yet. */
export function openPostKit(navigation: Nav, a: GoalActionView): void {
  openAgentTarget(navigation, { screen: "post-kit", params: { id: a.id } });
}

/** `title`: HOME_V3 opens this from Me as "Your plan"; absent, the tab's own "Goals". */
export function GoalsPlanScreen({ route, title = GOALS_TAB_COPY.title }: { route?: { params?: { goalId?: string } }; title?: string }) {
  const navigation = useNavigation<any>();
  const focused = useIsFocused();
  const q = useAgentGoalsPlan(true, { poll: focused });
  const write = useGoalWrite();
  const kitWrite = usePostKitWrite();
  const pull = usePullRefresh(() => q.refetch());
  const data = q.data ?? null;
  const goals = useMemo(() => data?.goals ?? [], [data]);
  const recommended = useMemo(() => data?.recommended ?? [], [data]);
  const setAside = data?.setAside ?? [];

  // Images (DESIGN.md §9).
  const pool = useMePool();
  const actionShots = useMemo(() => pool.filter((p) => p.shot_type === "action").map(photoUri).filter((u): u is string => !!u), [pool]);
  const slots = useMemo(() => atmosphereSlots(goals, recommended, actionShots.length > 0), [goals, recommended, actionShots.length]);
  const picks = useAtmosphere(ATMOSPHERE_SCREEN, slots, !!data);
  const images = useMemo(() => goalImages(goals, recommended, actionShots, picks.data), [goals, recommended, actionShots, picks.data]);
  const imageOf = (key: string): GoalImage => images.get(key) ?? { imagery: { kind: "typographic", capital: "brand" } };

  // One goal open: the first by default; Home's "Coming up" asks for the one timed for its event.
  const [openId, setOpenId] = useState<string | null>(null);
  const asked = route?.params?.goalId;
  const scrollRef = useRef<ScrollView>(null);
  const scrollTo = useRef<string | null>(null);
  useEffect(() => {
    if (!asked) return;
    setOpenId(asked);
    scrollTo.current = asked;
    navigation.setParams?.({ goalId: undefined });
    // Only a new goalId re-runs this (the param is cleared once read, so the same row tapped again opens it again).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const open = openId && goals.some((g) => g.id === openId) ? openId : goals[0]?.id ?? null;

  const [editing, setEditing] = useState<"add" | string | null>(null);
  const [recOpen, setRecOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undoId: string | null } | null>(null);

  const run = (w: GoalWrite) => {
    write.mutate(w, {
      onSuccess: (r) => {
        if (w.op === "undo") setNotice({ text: GOALS_TAB_COPY.undone, undoId: null });
        else if (w.op === "skip") setNotice({ text: GOALS_TAB_COPY.skipped, undoId: null });
        else if (r.change) setNotice({ text: GOALS_TAB_COPY.done[r.change.op], undoId: r.change.undoDecisionId });
        if (w.op === "add" || w.op === "change") setEditing(null);
        if ((w.op === "keep" || w.op === "add") && r.change?.goalId) setOpenId(r.change.goalId);
      },
      onError: () => setNotice({ text: GOALS_TAB_COPY.failed, undoId: null }),
    });
  };
  const busy = write.isPending;
  const onAction = (a: GoalActionView) => openGoalAction(navigation, a);

  // Her first plan is on screen: the one moment Nomila asks to notify her phone (asked once per phone; lib/push).
  const hasPlan = !!data?.plan && goals.some((g) => g.actions.length > 0);
  useEffect(() => { if (hasPlan) void askForPushOnce("first_plan"); }, [hasPlan]);
  // A plan run in progress: re-read on every return to the tab (the poll runs only while it is focused); when the run
  // ends, say what the plan holds now.
  const planning = data?.planning ?? null;
  const wasFocused = useRef(focused);
  useEffect(() => {
    if (focused && !wasFocused.current) void q.refetch();
    wasFocused.current = focused;
  }, [focused, q]);
  const wasPlanning = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    // Never over a pending Undo: the change she just made keeps its notice.
    if (wasPlanning.current && !planning) setNotice((cur) => (cur?.undoId ? cur : { text: GOALS_UPDATING_COPY.done(postsThisWeek(data.goals)), undoId: null }));
    wasPlanning.current = planning?.runId ?? null;
  }, [data, planning]);

  // Post rows: one opened in place at a time; Build it builds the kit here, then opens it (or says why it didn't).
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  // DESIGN.md §9, at most two faces a screen: the goal cards' photos of her count first.
  const faces = goals.filter((g) => images.get(g.id)?.imagery.kind === "performance").length;
  const posts: PostRowHandlers = {
    planning,
    thumbAllowed: faces < 2,
    openId: openPostId,
    buildingId: kitWrite.isPending && kitWrite.variables?.op === "build" ? kitWrite.variables.id : null,
    toggle: (a) => setOpenPostId((cur) => (cur === a.id ? null : a.id)),
    openKit: (a) => openPostKit(navigation, a),
    build: (a) => kitWrite.mutate({ op: "build", id: a.id }, {
      onSuccess: (r) => { if (r.read?.kit) openPostKit(navigation, a); else setNotice({ text: buildOutcomeLine(r.outcome), undoId: null }); },
      onError: () => setNotice({ text: POST_KIT_COPY.failBuild, undoId: null }),
    }),
    talk: (a) => openMila({ prompt: a.title }),
  };

  return (
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content} refreshControl={pullRefresh(pull)} showsVerticalScrollIndicator={false} testID="goals-tab">
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.lede}>{GOALS_TAB_COPY.lede}</Text>
      </View>

      {planning ? (
        <View style={styles.updating} accessibilityRole="text" accessibilityLiveRegion="polite" testID="goals-updating">
          <ActivityIndicator size="small" color={Bold.ink} />
          <View style={styles.updatingText}>
            <Text style={styles.updatingTitle}>{GOALS_UPDATING_COPY.title}</Text>
            <Text style={styles.updatingSub}>{GOALS_UPDATING_COPY.sub}</Text>
          </View>
        </View>
      ) : null}

      {notice ? (
        <View style={styles.notice} testID="goals-notice">
          <Text style={styles.noticeText}>{notice.text}</Text>
          {notice.undoId ? (
            <Pressable onPress={() => run({ op: "undo", decisionId: notice.undoId! })} disabled={busy} accessibilityRole="button" hitSlop={8} testID="goals-undo">
              <Text style={styles.undo}>{GOALS_TAB_COPY.undo}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {q.isLoading ? (
        <View style={styles.center} testID="goals-loading"><ActivityIndicator color={Bold.ink} /></View>
      ) : q.isError ? (
        <View style={styles.center} testID="goals-error">
          <Text style={styles.muted}>{GOALS_TAB_COPY.error}</Text>
          <Button bold="small" onPress={() => { void q.refetch(); }}>{GOALS_TAB_COPY.retry}</Button>
        </View>
      ) : (
        <>
          {goals.length === 0 ? (
            <Card bold style={styles.empty} testID="goals-empty">
              <Feather name="target" size={22} color={Bold.quiet} />
              <Text style={styles.emptyTitle}>{GOALS_TAB_COPY.emptyTitle}</Text>
              <Text style={styles.muted}>{GOALS_TAB_COPY.emptyLine}</Text>
            </Card>
          ) : null}

          {goals.map((g, gi) => (
            <View key={g.id} onLayout={(e) => {
              if (scrollTo.current !== g.id) return;
              scrollTo.current = null;
              scrollRef.current?.scrollTo?.({ y: Math.max(0, e.nativeEvent.layout.y - 8), animated: true });
            }}>
              {editing === g.id ? (
                <GoalEditor initialText={g.text} initialHorizon={g.horizon} busy={busy} onCancel={() => setEditing(null)} onSave={(text, horizon) => run({ op: "change", goalId: g.id, ...(text !== g.text ? { text } : {}), horizon })} testID={`goal-editor-${g.id}`} />
              ) : g.id === open ? (
                <FullGoalCard g={g} index={gi} total={goals.length} img={imageOf(g.id)} onAction={onAction} posts={posts} busy={busy}
                  onChange={() => setEditing(g.id)} onSetAside={() => run({ op: "set_aside", goalId: g.id })} onDrop={() => run({ op: "drop", goalId: g.id })} />
              ) : (
                <CompactGoalCard g={g} index={gi} total={goals.length} img={imageOf(g.id)} onAction={onAction} posts={posts} onExpand={() => setOpenId(g.id)} />
              )}
            </View>
          ))}

          {editing === "add"
            ? <GoalEditor busy={busy} onCancel={() => setEditing(null)} onSave={(text, horizon) => run({ op: "add", text, horizon })} testID="goal-editor-add" />
            : <Button bold="secondary" onPress={() => setEditing("add")} icon={<Feather name="plus" size={15} color={Bold.onDark} />} style={styles.add} testID="goals-add">{GOALS_TAB_COPY.add}</Button>}

          {recommended.length ? (
            <View style={styles.section} testID="goals-recommended">
              <SectionHead title={GOALS_TAB_COPY.recommended} sub={GOALS_TAB_COPY.recommendedSub} style={styles.in} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                {recommended.map((r) => (
                  <RecommendedCard key={r.decisionId} r={r} img={imageOf(recSlotKey(r.decisionId))} open={recOpen === r.decisionId} busy={busy}
                    onToggle={() => setRecOpen(recOpen === r.decisionId ? null : r.decisionId)}
                    onKeep={() => run({ op: "keep", decisionId: r.decisionId })} onSkip={() => run({ op: "skip", decisionId: r.decisionId })} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {setAside.length ? (
            <View style={styles.section} testID="goals-set-aside">
              <SectionHead title={GOALS_TAB_COPY.setAside} style={styles.in} />
              <Card bold style={styles.list}>
                {setAside.map((g, i) => <SetAsideRow key={g.id} g={g} last={i === setAside.length - 1} busy={busy} onBringBack={() => run({ op: "bring_back", goalId: g.id })} />)}
              </Card>
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll:     { flex: 1, backgroundColor: Bold.paper },
  content:    { paddingBottom: 40 },
  head:       { paddingHorizontal: Bold.gutter, paddingTop: 4, gap: 6 },
  title:      { ...BoldType.screenTitle, color: Bold.ink },
  lede:       { ...BoldType.lede, color: Bold.mute },
  in:         { paddingHorizontal: Bold.gutter },
  updating:   { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: Bold.gutter, marginTop: 14, paddingVertical: 10, paddingHorizontal: 14, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  updatingText: { flex: 1, gap: 1 },
  updatingTitle: { ...BoldType.rowTitle, color: Bold.ink },
  updatingSub: { ...BoldType.caption, color: Bold.mute },
  notice:     { flexDirection: "row", alignItems: "center", gap: 16, marginHorizontal: Bold.gutter, marginTop: 14, paddingVertical: 10, paddingHorizontal: 14, borderRadius: Bold.radius.control, backgroundColor: Bold.ink },
  noticeText: { ...BoldType.rowMeta, color: Bold.onDark, flex: 1 },
  undo:       { ...BoldType.buttonSmall, color: Bold.blueOnDark },
  center:     { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 20 },
  muted:      { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
  empty:      { marginHorizontal: Bold.gutter, marginTop: 28, alignItems: "center", gap: 8, paddingVertical: 24, paddingHorizontal: 20 },
  emptyTitle: { ...BoldType.h4, color: Bold.ink },
  add:        { marginHorizontal: Bold.gutter, marginTop: 14 },
  section:    { marginTop: 24, gap: 10 },
  rail:       { paddingHorizontal: Bold.gutter, gap: 10 },
  list:       { marginHorizontal: Bold.gutter },
});
