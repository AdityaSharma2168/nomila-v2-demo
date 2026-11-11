/**
 * MeetMilaScreen — the "Meet Mila" entry (EXPO_PUBLIC_AGENT_V3): an EXISTING athlete asking, on request, for the agent
 * onboarding conversation she never had (fix/existing-users-skip-onboarding; server/agent/onboarding/service.ts's
 * agent_onboarding_required stayed false for her at signup, so the app's gate never showed it to her). Opened only
 * from a door she taps (Me, or Mila's tab) — never auto-shown.
 *
 * Her name and sport are already on her row, so AgentOnboardingFlow's autoStart skips the name/sport screen entirely
 * and starts at once with optIn: true; Mila's intro and "What Mila already has" show first, exactly as they do for a
 * brand-new front signup, then the conversation itself. Leaving (Go to Home, or a Start) pops back to wherever this
 * was opened from.
 */
import React from "react";
import { useNavigation } from "@react-navigation/native";
import { AgentOnboardingFlow } from "./AgentOnboardingFlow";
import { useAuth } from "../../lib/auth-context";
import { profileName } from "../../lib/onboardingFront";

// meetMilaVisible lives in lib/agent/onboardingLogic (no React, no screen imports) so a caller that only needs to
// decide whether to show the door (e.g. MeScreen) never pulls this screen's whole module graph — AgentOnboardingFlow
// → OnboardingNameScreen → MilaAvatar → expo-video — into its own, which breaks under jest's RN test environment.
export { meetMilaVisible } from "../../lib/agent/onboardingLogic";

export function MeetMilaScreen() {
  const navigation = useNavigation<any>();
  const { athlete } = useAuth();
  const name = profileName(athlete ?? null);
  const sport = athlete?.sport?.trim() || null;
  // The door that opens this screen (meetMilaVisible, below) only shows once both are known; a race (e.g. the
  // profile read not yet landed) falls back to leaving at once rather than drawing a broken screen.
  if (!name || !sport) {
    navigation.goBack();
    return null;
  }
  return (
    <AgentOnboardingFlow
      onDone={() => navigation.goBack()}
      autoStart={{ name, sport }}
    />
  );
}
