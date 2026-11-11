/**
 * AgentOnboardingFlow (EXPO_PUBLIC_AGENT_V3) — which onboarding screen to draw, from the server's state: the first
 * screen (name and sport) until onboarding has started; then the conversation, which stays up once every checkpoint is
 * met so the athlete leaves with a tap (Go to Home, or a Start). Loading and error
 * are drawn on the Mila ground. Resumable: the state is the server's, so reopening lands on the same moment.
 *
 * With the agent onboarding FRONT on (`front`: the build flag and the server's AGENT_ONBOARDING), the first screen is
 * the sport grid — skipped when the athlete already picked their sports before signing up, which then start the
 * onboarding at once (name + every sport as "said" facts) — and two moments come before the conversation: Mila's intro
 * (the interests, saved as "said" facts through the turn's `capability` action) and "What Mila already has" (the facts,
 * tick or fix). Where the athlete is in those two is kept per athlete on the device; without it, a conversation that
 * has already begun goes straight on.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Bold, BoldType } from "../../constants/theme";
import { N } from "../../components/deals/opps/tokens";
import { MilaButton } from "../../components/agent/parts";
import type { AgentCardHandlers } from "../../components/agent/handlers";
import { OnboardingNameScreen } from "./OnboardingNameScreen";
import { OnboardingConversation } from "./OnboardingConversation";
import { ONBOARDING_COPY, onboardingScreen } from "../../lib/agent/onboardingLogic";
import { isWorking, useAgentOnboarding, useOnboardingAction, useOnboardingFacts, useStartOnboarding } from "../../lib/agent/hooks";
import { useAuth } from "../../lib/auth-context";
import { useAtmosphere } from "../../hooks/use-me-memory";
import { FRONT_STAGES, factCards, factPhotoSlots, interestActions, nextStage, profileName, type FrontStage } from "../../lib/onboardingFront";
import { SportGridScreen } from "../onboarding/SportGridScreen";
import { MilaIntroScreen } from "../onboarding/MilaIntroScreen";
import { WhatMilaHasScreen } from "../onboarding/WhatMilaHasScreen";

export interface OnboardingExit {
  /** Set when the athlete started a workflow from a card: Mila opens on it. */
  startPrompt: string | null;
  /** Set when a capability opens a screen (semantic name; lib/agent/navigate maps it). */
  screen?: string | null;
}

/** What Mila is asked when the athlete starts a capability that has no screen of its own. */
export const CAPABILITY_PROMPT = (label: string) => `Let's start with ${label.toLowerCase()}.`;

/** How often "What Mila already has" re-reads the facts while research runs. */
export const FACTS_POLL_MS = 3000;

const stageKey = (athleteId: string) => `nomila:onboardingFront:${athleteId}`;

/** The front's stage on this device: undefined while read, null when nothing is kept. */
function useFrontStage(athleteId: string | null, on: boolean) {
  const [stage, setStageState] = useState<FrontStage | null | undefined>(on && athleteId ? undefined : null);
  useEffect(() => {
    if (!on || !athleteId) { setStageState(null); return; }
    let live = true;
    AsyncStorage.getItem(stageKey(athleteId))
      .then((v) => { if (live) setStageState(FRONT_STAGES.includes(v as FrontStage) ? (v as FrontStage) : null); })
      .catch(() => { if (live) setStageState(null); });
    return () => { live = false; };
  }, [athleteId, on]);
  const setStage = useCallback((s: FrontStage) => {
    setStageState(s);
    if (athleteId) AsyncStorage.setItem(stageKey(athleteId), s).catch(() => { /* memory only */ });
  }, [athleteId]);
  return [stage, setStage] as const;
}

export function AgentOnboardingFlow({ onDone, extraHandlers, front = false, autoStart }: {
  onDone: (exit: OnboardingExit) => void;
  extraHandlers?: Partial<AgentCardHandlers>;
  front?: boolean;
  /**
   * The "Meet Mila" entry (an EXISTING athlete asking for the conversation on request, never auto-shown):
   * name + sport are already known, so the name/sport screen (and the front's sport grid) is skipped entirely and
   * onboarding starts at once with optIn: true — the server records the opt-in (server/agent/onboarding/service.ts),
   * so a canceled run still reopens the conversation next launch. Mila's intro and "What Mila already has" still show,
   * exactly as they do for a brand-new front signup.
   */
  autoStart?: { name: string; sport: string };
}) {
  const q = useAgentOnboarding();
  const start = useStartOnboarding();
  const act = useOnboardingAction();
  const { athlete, frontSports } = useAuth();
  const [leaving, setLeaving] = useState(false);
  // The front's two moments (intro, has) also apply to an athlete opting in on request.
  const showsStages = front || !!autoStart;
  const [stage, setStage] = useFrontStage(athlete?.id ?? null, showsStages);
  const screen = onboardingScreen(q.data);
  const working = isWorking(q.data) || !!q.data?.working;
  const facts = useOnboardingFacts(showsStages && stage === "has", working ? FACTS_POLL_MS : false);
  const cards = factCards(facts.data ?? []);
  // The cards' photos: atmosphere from the shared library through the picker (ATMOSPHERE_IMAGERY; off ⇒ the dark ground).
  const atm = useAtmosphere("onboarding_has", factPhotoSlots(cards), showsStages && stage === "has");
  const photos: Record<string, string> = {};
  for (const f of cards) { const img = atm[`fact:${f.id}`]; if (img) photos[f.id] = img.url; }

  // Leaving is the athlete's tap (Go to Home, or a Start); the server already holds the finished state.
  const leave = useCallback((exit: OnboardingExit) => {
    if (leaving) return;
    setLeaving(true);
    onDone(exit);
  }, [leaving, onDone]);

  // The front: sports picked before signing up start the onboarding at once (no second screen asks again). "Meet
  // Mila" (autoStart): the athlete already has a name and sport on her row — start at once too, with optIn: true.
  const name = profileName(athlete);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !q.data) return;
    // "Meet Mila" (autoStart): an existing athlete's read resolves to "done" (never "needs_name" — she never needed
    // onboarding), not "name"; start as soon as the read lands, not on a screen that will never arrive.
    if (autoStart) {
      autoStarted.current = true;
      start.mutate({ name: autoStart.name, sport: autoStart.sport, optIn: true }, { onSuccess: () => setStage("intro") });
      return;
    }
    if (screen !== "name" || !front || !name || !frontSports?.length) return;
    autoStarted.current = true;
    start.mutate({ name, sport: frontSports[0], sports: frontSports }, { onSuccess: () => setStage("intro") });
  }, [front, autoStart, screen, name, frontSports, start, setStage, q.data]);

  // "done" (every checkpoint met) keeps the conversation up with Go to Home: leaving is the athlete's tap. (A launch that
  // finds onboarding already done never mounts this flow: App's gate lets the app through.)
  if (q.isError && !q.data) {
    return (
      <View style={styles.center} testID="onboarding-error">
        <StatusBar barStyle="dark-content" />
        <Text style={styles.text}>{ONBOARDING_COPY.loadError}</Text>
        <MilaButton label={ONBOARDING_COPY.retry} tone="soft" onPress={() => { void q.refetch(); }} testID="onboarding-retry" />
      </View>
    );
  }
  // The autoStart mutation is in flight (or about to be): stay on the loading ground until the run actually exists,
  // never a flash of the name screen or the conversation drawn before she has one.
  if (screen === "loading" || !q.data || (showsStages && stage === undefined) || (autoStart && !q.data.everStarted)) {
    return <View style={styles.center} testID="onboarding-loading"><StatusBar barStyle="dark-content" /><ActivityIndicator color={Bold.ink} /></View>;
  }
  if (screen === "name") {
    if (autoStart) return <View style={styles.center} testID="onboarding-loading"><StatusBar barStyle="dark-content" /><ActivityIndicator color={Bold.ink} /></View>;
    if (!front) return <OnboardingNameScreen onStart={(v) => start.mutate(v)} busy={start.isPending} error={start.isError} />;
    if (frontSports?.length && name && !start.isError) {
      return <View style={styles.center} testID="onboarding-loading"><StatusBar barStyle="dark-content" /><ActivityIndicator color={Bold.ink} /></View>;
    }
    return (
      <SportGridScreen
        askName={!name}
        busy={start.isPending}
        error={start.isError}
        onContinue={({ sports, name: typed }) => start.mutate({ name: typed ?? name ?? "", sport: sports[0], sports }, { onSuccess: () => setStage("intro") })}
      />
    );
  }
  // The front's two moments before the conversation (also shown for an autoStart opt-in). Nothing kept on this
  // device: an onboarding that has not begun talking starts at the intro; one already under way goes straight on.
  const at: FrontStage = !showsStages ? "done" : stage ?? (q.data.turns.length ? "done" : "intro");
  if (at === "intro") {
    return (
      <MilaIntroScreen
        busy={act.isPending}
        error={act.isError}
        onStart={(picked) => {
          const actions = interestActions(picked);
          if (!actions.length) { setStage(nextStage("intro")); return; }
          act.mutate({ actions, reply: false }, { onSuccess: () => setStage(nextStage("intro")) });
        }}
      />
    );
  }
  if (at === "has") {
    return (
      <WhatMilaHasScreen
        facts={cards}
        photos={photos}
        working={working}
        onConfirm={async (factId) => { await act.mutateAsync({ actions: [{ type: "fact_review", factId, action: "confirm" }], reply: false }); }}
        onCorrect={async (factId, words) => { await act.mutateAsync({ actions: [{ type: "fact_review", factId, action: "correct", correction: words }], reply: false }); void facts.refetch(); }}
        onContinue={() => setStage(nextStage("has"))}
      />
    );
  }
  return (
    <OnboardingConversation
      state={q.data}
      onFinish={() => leave({ startPrompt: null })}
      onStartWorkflow={(prompt) => leave({ startPrompt: prompt })}
      onCapability={(c) => leave(c.screen ? { startPrompt: null, screen: c.screen } : { startPrompt: CAPABILITY_PROMPT(c.label) })}
      finishing={leaving}
      extraHandlers={extraHandlers}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: N.cream100, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  text: { ...BoldType.read, color: Bold.ink2, textAlign: "center" },
});
