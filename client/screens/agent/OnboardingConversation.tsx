/**
 * Onboarding, the conversation (EXPO_PUBLIC_AGENT_V3) — meeting your agent. After name + sport, the onboarding skill
 * decides what Mila says and which cards come next from what the athlete says and does; this screen draws whatever
 * turns the server holds, in order, on the Mila surfaces (DESIGN.md §16): Mila floating at the top with her status,
 * her turns with their cards, the athlete's replies as bubbles, quick replies and a frosted composer at the foot.
 *
 * Progress is subtle: "n of N covered" (the skill's required checkpoints) under Mila, never a stepper. Resumable: the
 * server holds the turns and checkpoints, so reopening draws the same conversation. "Go to Home" appears once the
 * required checkpoints are covered; a capability's Start finishes onboarding and opens Mila on that workflow.
 */
import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Bold, BoldType } from "../../constants/theme";
import { N } from "../../components/deals/opps/tokens";
import { MilaHeader } from "../../components/mila/MilaHeader";
import { Frost, SOFT_LIFT } from "../../components/mila/Frost";
import { useHeldActivity, type MilaActivity } from "../../components/mila/milaActivity";
import { AgentCardList } from "../../components/agent/AgentCard";
import { useQueryClient } from "@tanstack/react-query";
import { connectService } from "../../lib/agent/connect";
import { useReducedMotion } from "../../components/ui/Accordion";
import { OwnGoalComposer } from "../../components/agent/GoalCards";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../../components/agent/handlers";
import { MilaButton } from "../../components/agent/parts";
import { ONBOARDING_COPY, coveredA11y, coveredLabel, ownGoalTurnIndex, showsMilaLabel } from "../../lib/agent/onboardingLogic";
import { isWorking, useOnboardingAction, useSayOnboarding } from "../../lib/agent/hooks";
import type { AgentOnboardingState, CapabilityEntry } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

/** The covered pill's height plus its gap under the header: the stream never draws under it. */
const COVERED_H = 30;

const MILA_STILL = require("../../../assets/mila/mila-still.png");

function activityOf(s: AgentOnboardingState, sending: boolean): MilaActivity {
  if (sending) return "thinking";
  if (!isWorking(s)) return "idle";
  const last = s.turns[s.turns.length - 1];
  return last?.cards.some((c) => c.kind === "progress" && c.payload.state === "running") ? "looking" : "thinking";
}

/** The subtle checkpoint progress: a frosted line of dots and "n of N covered". */
function Covered({ state }: { state: AgentOnboardingState }) {
  const label = coveredLabel(state.checkpoints);
  if (!label) return null;
  return (
    <Frost radius={12} style={styles.covered} testID="onboarding-covered">
      <View style={styles.coveredInner} accessible accessibilityLabel={coveredA11y(state.checkpoints)}>
        <View style={styles.dots}>
          {state.checkpoints.map((c) => <View key={c.id} style={[styles.cdot, c.covered && styles.cdotOn]} />)}
        </View>
        <Text style={styles.coveredText}>{label}</Text>
      </View>
    </Frost>
  );
}

export function OnboardingConversation({
  state, onFinish, onStartWorkflow, onCapability, finishing, extraHandlers,
}: {
  state: AgentOnboardingState;
  /** "Go to Home". */
  onFinish: () => void;
  /** The play's Start: finish onboarding, then open Mila on it. */
  onStartWorkflow: (prompt: string) => void;
  /** A capability tapped: finish onboarding, then open its screen or start it in Mila. */
  onCapability: (capability: CapabilityEntry) => void;
  finishing?: boolean;
  /** Overrides for the gallery (connect without OAuth). */
  extraHandlers?: Partial<AgentCardHandlers>;
}) {
  const insets = useSafeAreaInsets();
  const say = useSayOnboarding();
  const action = useOnboardingAction();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [headerH, setHeaderH] = useState(140);
  const scrollRef = useRef<ScrollView>(null);
  const reduced = useReducedMotion();
  // Nothing may sit under the floating header or the "n of N covered" pill: the stream starts below both, and a new turn
  // from Mila is scrolled so ITS TOP lands there (a reveal's heading is never hidden), rather than to the very end.
  const topClear = headerH + COVERED_H + 10;
  const lastMila = [...state.turns].reverse().find((t) => t.role === "mila")?.id ?? null;
  const lastIsAthlete = state.turns[state.turns.length - 1]?.role === "athlete";
  const scrolledTo = useRef<string | null>(null);
  const activity = useHeldActivity(activityOf(state, say.isPending));
  const goalAt = ownGoalTurnIndex(state.turns);

  const sendRef = useRef<(text: string) => void>(() => {});
  const send = (text: string) => {
    const t = text.trim();
    if (!t || say.isPending) return;
    haptics.press();
    say.mutate(t, { onSuccess: () => setInput("") });
  };
  sendRef.current = send;

  // Every card answer is an action on the turn route; the conversation redraws from the state it answers with.
  const act = action.mutateAsync;
  const handlers = useMemo<AgentCardHandlers>(() => ({
    startWorkflow: onStartWorkflow,
    startCapability: onCapability,
    prefill: (text) => setInput(text),
    reply: (text) => sendRef.current(text),
    // A card names its connector (a sharpen step, a rate card): the existing OAuth door for that one.
    connect: (connectorId) => connectService(connectorId, qc),
    act: async (actions, opts) => { await act({ actions, reply: opts?.reply }); },
    ...extraHandlers,
  }), [onStartWorkflow, onCapability, act, extraHandlers, qc]);
  // The skill may send no quick replies; once Mila is waiting on the athlete, offer one way to move on.
  const last = state.turns[state.turns.length - 1];
  // An optional conversation (opt-in, or an athlete who already finished onboarding) can always be left; once every
  // checkpoint is met the in-thread "Go to Home" takes over.
  const showLeave = state.optional && !state.canFinish;
  const chips = state.suggestions.length ? state.suggestions : !isWorking(state) && !state.canFinish && last?.role === "mila" ? [ONBOARDING_COPY.keepGoing] : [];

  return (
    <AgentCardHandlersProvider value={handlers}>
      <View style={[styles.root, { paddingTop: insets.top }]} testID="onboarding-conversation">
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.flex}>
            <ScrollView
              ref={scrollRef}
              style={styles.flex}
              contentContainerStyle={[styles.body, { paddingTop: topClear }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              // The athlete's own new turn (a goal added, a reply waiting on Mila) follows the end.
              onContentSizeChange={() => { if (lastIsAthlete) scrollRef.current?.scrollToEnd({ animated: !reduced }); }}
              testID="onboarding-transcript"
            >
              {state.turns.map((t, i) => (
                <View
                  key={t.id}
                  style={styles.turn}
                  onLayout={(e) => {
                    if (t.id !== lastMila || scrolledTo.current === t.id) return;
                    scrolledTo.current = t.id;
                    // Its top just under the pill (the stream's own padding is the clear zone).
                    scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - topClear), animated: !reduced });
                  }}
                >
                  {t.role === "athlete" ? (
                    t.text ? (
                      <View style={styles.userBubble}><Text style={styles.userText}>{t.text}</Text></View>
                    ) : null
                  ) : (
                    <View style={styles.milaBlock}>
                      {showsMilaLabel(state.turns, i) ? (
                        <View style={styles.milaLabelRow}>
                          <Image source={MILA_STILL} style={styles.milaStill} accessibilityIgnoresInvertColors />
                          <Text style={styles.milaLabel}>Mila</Text>
                        </View>
                      ) : null}
                      {t.text ? <Text style={styles.milaText}>{t.text}</Text> : null}
                      {t.cards.length ? <View style={styles.cards}><AgentCardList cards={t.cards} staged={t.id === lastMila} /></View> : null}
                      {i === goalAt ? (
                        <View style={styles.cards}>
                          <OwnGoalComposer
                            onAdd={(text) => action.mutate({ actions: [{ type: "goal_add", text }], reply: false })}
                            busy={action.isPending}
                            error={action.isError ? ONBOARDING_COPY.sendError : null}
                          />
                        </View>
                      ) : null}
                    </View>
                  )}
                </View>
              ))}
              {say.isError ? <Text style={styles.error} accessibilityLiveRegion="polite">{ONBOARDING_COPY.sendError}</Text> : null}
              {state.canFinish ? (
                <View style={styles.finish} testID="onboarding-finish">
                  <Text style={styles.finishLine}>{ONBOARDING_COPY.finishLine}</Text>
                  <MilaButton label={ONBOARDING_COPY.finish} icon="home" onPress={onFinish} loading={finishing} testID="onboarding-home" />
                </View>
              ) : null}
            </ScrollView>
            <MilaHeader activity={activity} compact active onHeight={setHeaderH} />
            {/* An optional conversation is always leavable from the top, above the floating header — not only from the
                chip row, which the keyboard or a long transcript can push out of reach. */}
            {showLeave ? (
              <Pressable
                onPress={onFinish}
                disabled={finishing}
                accessibilityRole="button"
                accessibilityLabel={ONBOARDING_COPY.finish}
                hitSlop={8}
                style={({ pressed }) => [styles.topLeave, pressed && { opacity: 0.7 }]}
                testID="onboarding-leave-top"
              >
                <Frost radius={22} style={styles.topLeaveInner}><Text style={styles.chipText}><Feather name="home" size={14} /> {ONBOARDING_COPY.finish}</Text></Frost>
              </Pressable>
            ) : null}
            {/* The cream continues behind the pill and fades out under it, so scrolled turns never show through. */}
            <View style={[styles.pillBand, { top: headerH - 2, height: COVERED_H + 6 }]} pointerEvents="none" />
            <LinearGradient
              colors={[N.cream100, N.cream100Clear]}
              style={[styles.pillFade, { top: headerH + COVERED_H + 4 }]}
              pointerEvents="none"
            />
            <View style={[styles.coveredWrap, { top: headerH + 2 }]} pointerEvents="none">
              <Covered state={state} />
            </View>
          </View>

          {/* Quick replies, then the frosted composer (Muse: no ground or rule behind it). */}
          <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {chips.length || showLeave ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
                {showLeave ? (
                  <Pressable onPress={onFinish} disabled={finishing} accessibilityRole="button" accessibilityLabel={ONBOARDING_COPY.finish} style={({ pressed }) => pressed && { opacity: 0.7 }} testID="onboarding-leave">
                    <Frost radius={17} style={styles.chip}><Text style={styles.chipText}><Feather name="home" size={13} /> {ONBOARDING_COPY.finish}</Text></Frost>
                  </Pressable>
                ) : null}
                {chips.map((s) => (
                  <Pressable key={s} onPress={() => send(s)} disabled={say.isPending} accessibilityRole="button" style={({ pressed }) => pressed && { opacity: 0.7 }} testID="onboarding-suggestion">
                    <Frost radius={17} style={styles.chip}><Text style={styles.chipText}>{s}</Text></Frost>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <Frost radius={26} style={styles.composer}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={ONBOARDING_COPY.composer}
                placeholderTextColor={Bold.quiet}
                style={styles.input}
                multiline
                accessibilityLabel={ONBOARDING_COPY.composer}
                testID="onboarding-input"
              />
              <Pressable
                onPress={() => send(input)}
                disabled={!input.trim() || say.isPending}
                accessibilityRole="button"
                accessibilityLabel={ONBOARDING_COPY.send}
                style={({ pressed }) => pressed && { opacity: 0.8 }}
                testID="onboarding-send"
              >
                <View style={[styles.send, input.trim() ? styles.sendReady : null]}>
                  {say.isPending ? <ActivityIndicator size="small" color={Bold.ink} /> : <Feather name="arrow-up" size={18} color={input.trim() ? Bold.ink : Bold.quiet} />}
                </View>
              </Pressable>
            </Frost>
          </View>
        </KeyboardAvoidingView>
      </View>
    </AgentCardHandlersProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: N.cream100 },
  body: { paddingHorizontal: 20, paddingBottom: 24, gap: 18 },
  turn: {},
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: Bold.ink, borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 14 },
  userText: { ...BoldType.read, color: Bold.onDark },
  milaBlock: { alignSelf: "stretch" },
  milaLabelRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  milaStill: { width: 22, height: 22, borderRadius: 11, backgroundColor: N.cream200 },
  milaLabel: { ...BoldType.rowTitle, color: Bold.ink },
  milaText: { ...BoldType.body, color: Bold.ink },
  cards: { marginTop: 12 },
  error: { ...BoldType.caption, color: Bold.ink, textAlign: "center" },
  finish: { gap: 10, alignItems: "stretch", marginTop: 4 },
  finishLine: { ...BoldType.read, color: Bold.ink2, textAlign: "center" },

  coveredWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  topLeave: { position: "absolute", top: 8, left: 16, zIndex: 10, elevation: 10 },
  topLeaveInner: { height: 44, paddingHorizontal: 14, justifyContent: "center" },
  pillBand: { position: "absolute", left: 0, right: 0, backgroundColor: N.cream100 },
  pillFade: { position: "absolute", left: 0, right: 0, height: 14 },
  covered: { paddingHorizontal: 12, paddingVertical: 6 },
  coveredInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  dots: { flexDirection: "row", gap: 4 },
  cdot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.line },
  cdotOn: { backgroundColor: Bold.ink },
  coveredText: { ...BoldType.caption, color: Bold.ink2 },

  foot: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  chips: { gap: 8, paddingHorizontal: 2, paddingVertical: 4 },
  chip: { height: 34, paddingHorizontal: 14, justifyContent: "center" },
  chipText: { ...BoldType.chipLine, color: Bold.ink },
  composer: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 7, minHeight: 52 },
  // Positioned so it paints above the frost layer on web (an absolute sibling paints over static content).
  input: { ...BoldType.read, flex: 1, color: Bold.ink, paddingVertical: 12, maxHeight: 120, position: "relative", zIndex: 1 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  sendReady: { backgroundColor: Bold.paper, ...SOFT_LIFT },
});
