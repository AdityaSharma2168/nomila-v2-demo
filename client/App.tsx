import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View, ActivityIndicator, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Feather, Ionicons } from "@expo/vector-icons";
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  Outfit_800ExtraBold,
  Outfit_900Black,
} from "@expo-google-fonts/outfit";
// Nomi Card display faces — the card's "campaign" look is condensed-black-italic (Archivo Narrow,
// the closest static match to the web's font-stretch:62.5%/900 Archivo) over Instrument Serif
// italic taglines. These replace the Outfit faux-italic stand-ins that read as broken.
import {
  ArchivoNarrow_700Bold,
  ArchivoNarrow_700Bold_Italic,
} from "@expo-google-fonts/archivo-narrow";
import {
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
} from "@expo-google-fonts/instrument-serif";
// Luxe look — Bodoni Moda (Didone display) over Jost (geometric sans).
import {
  BodoniModa_400Regular,
  BodoniModa_500Medium,
  BodoniModa_500Medium_Italic,
  BodoniModa_600SemiBold,
} from "@expo-google-fonts/bodoni-moda";
import {
  Jost_300Light,
  Jost_400Regular,
  Jost_500Medium,
} from "@expo-google-fonts/jost";
// Broadcast look — Anton (ultra-condensed display) + Barlow Condensed + Barlow.
import { Anton_400Regular } from "@expo-google-fonts/anton";
import {
  BarlowCondensed_500Medium,
  BarlowCondensed_600SemiBold,
  BarlowCondensed_700Bold,
} from "@expo-google-fonts/barlow-condensed";
import {
  Barlow_400Regular,
  Barlow_500Medium,
} from "@expo-google-fonts/barlow";
// Immersive look — Big Shoulders Display (tall condensed) + Schibsted Grotesk (body).
import {
  BigShouldersDisplay_700Bold,
  BigShouldersDisplay_800ExtraBold,
} from "@expo-google-fonts/big-shoulders-display";
import {
  SchibstedGrotesk_400Regular,
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_700Bold,
} from "@expo-google-fonts/schibsted-grotesk";
import { QueryClientProvider } from "@tanstack/react-query";
import { NavigationContainer } from "@react-navigation/native";

import { queryClient } from "./lib/query-client";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { Colors, Brand } from "./constants/theme";
import { SignInScreen } from "./screens/SignInScreen";
import { ProfileUnavailableScreen } from "./screens/ProfileUnavailableScreen";
import { AccountDeletingScreen } from "./screens/AccountDeletingScreen";
import { WaitlistScreen } from "./screens/WaitlistScreen";
import { MainTabNavigator } from "./navigation/MainTabNavigator";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { IsThisYouScreen } from "./screens/IsThisYouScreen";
import { ChooseProfileScreen } from "./screens/ChooseProfileScreen";
import { IDENTITY_CLAIM, AGENT_V3, OPPS_V2, webV2On } from "./lib/flags";
import { webLinkingFor } from "./navigation/webLinking";
import { WebFrame } from "./components/web/WebFrame";
import { useOnboardingRun, type OnboardingDoor } from "./hooks/use-onboarding-run";
import { AgentOnboardingFlow, type OnboardingExit } from "./screens/agent/AgentOnboardingFlow";
import { AgentGalleryScreen } from "./screens/agent/AgentGalleryScreen";
import { DealsGalleryScreen } from "./screens/prototypes/DealsGalleryScreen";
import { FrontWaiting, OnboardingFrontGate, useOnboardingFront } from "./screens/onboarding/OnboardingFrontGate";
import { useAgentOnboarding } from "./lib/agent/hooks";
import { awaitsAgentOnboardingRead, latchesAgentOnboardingGate, needsAgentOnboardingGate } from "./lib/agent/onboardingLogic";
import { routeFor } from "./lib/agent/navigate";
import type { MainTabParamList } from "./navigation/shellTabs";

/** The tab a capability's screen lives in (semantic name → tab); Home when it maps nowhere. */
function tabForScreen(screen: string): keyof MainTabParamList {
  const r = routeFor({ screen });
  return r && "tab" in r ? (r.tab as keyof MainTabParamList) : "Home";
}

/** DEV ONLY: the agent UI gallery (fixtures, no sign-in) at /agent-gallery on web, with EXPO_PUBLIC_AGENT_V3 on. */
const AGENT_GALLERY =
  __DEV__ && AGENT_V3 && Platform.OS === "web" && typeof window !== "undefined" && window.location?.pathname?.startsWith("/agent-gallery");

/** DEV ONLY: the OPPS_V2 deal and booking screens on fixtures (no sign-in) at /deals-gallery on web. */
const DEALS_GALLERY =
  __DEV__ && OPPS_V2 && Platform.OS === "web" && typeof window !== "undefined" && window.location?.pathname?.startsWith("/deals-gallery");

/** The dev web switch (EXPO_PUBLIC_WEB_V2) in a browser: URLs + the phone-width column. Off everywhere else. */
const WEB_V2_ON = webV2On(Platform.OS);
const LINKING = webLinkingFor(WEB_V2_ON);
// With linking on, React Navigation writes the tab title from the route ("undefined" before any screen, "DealDetail" on a
// deal): keep it "Nomila", as the page's own <title> is today.
const WEB_DOCUMENT_TITLE = { formatter: () => "Nomila" };

SplashScreen.preventAutoHideAsync();

// ─── Root gate — shows SignIn or app based on auth state ─────────────────────

const DEV_BYPASS_AUTH = __DEV__;

function RootGate() {
  const { athlete, isAuthenticated, isLoading, claimPrompt, confirmClaim, dismissClaims, profileChoice, chooseProfile, profileUnavailable, retryProfile, signOut, accountDeleting, leaveDeletedAccount } = useAuth();
  // The agent onboarding front: the build flag AND the server's AGENT_ONBOARDING (asked once). Either off ⇒ today's flow.
  const front = useOnboardingFront(AGENT_V3);
  const frontOn = !!front?.agentOnboarding;

  // First entry (PR 3): while the athlete's onboarding run is waiting on them (greet or
  // doors), the app is Mila full-screen. The run ending — a door chosen by tap or in
  // words — releases the gate and opens the tab they chose. Fail-open: a failed lookup
  // never blocks the app. Waitlisted athletes are not gated (they see the waitlist).
  const waitlisted = athlete?.status === "waitlisted";
  const inApp = isAuthenticated && !!athlete && !waitlisted;
  // AGENT_V3 replaces the first entry with the new onboarding conversation (name + sport, then the skill decides).
  const onboarding = useOnboardingRun(!AGENT_V3 && inApp);
  const agentOnboarding = useAgentOnboarding(AGENT_V3 && inApp);
  const [agentExit, setAgentExit] = useState<OnboardingExit | null>(null);
  // Gated while the server says onboarding isn't done. Fail-open: a failed read (or a server without the route) never
  // blocks the app. An existing athlete (never started agent onboarding) resolves to "done" without a run — see
  // onboardingAdapter.fromWire — so she is never gated here; only a new agent-front signup (or an explicit "Meet
  // Mila" opt-in while active) is.
  const gateRead = { agentV3: AGENT_V3, inApp, isError: agentOnboarding.isError, isLoading: agentOnboarding.isLoading, data: agentOnboarding.data };
  const needsAgentOnboarding = needsAgentOnboardingGate(gateRead);
  // Latched: once the conversation is up it stays until the athlete leaves it (Go to Home, or a Start), even after the
  // last checkpoint flips the server to done mid-session. Only a landed "not done" read latches, never the loading one.
  // The latch belongs to one athlete: signing out and in as someone else (no app restart) starts it over.
  const agentLatch = useRef(false);
  const latchFor = useRef<string | null>(null);
  if (latchFor.current !== (athlete?.id ?? null)) { latchFor.current = athlete?.id ?? null; agentLatch.current = false; }
  if (latchesAgentOnboardingGate(gateRead)) agentLatch.current = true;
  const agentGated = AGENT_V3 && inApp && !agentExit && (needsAgentOnboarding || agentLatch.current);
  // The first read is in flight: a neutral splash, never the conversation (an optional run must not open on launch).
  const agentWaiting = !agentExit && !agentLatch.current && awaitsAgentOnboardingRead(gateRead);
  const [door, setDoor] = useState<OnboardingDoor | null>(null);
  const onOnboardingDone = useCallback((d: OnboardingDoor | null) => {
    setDoor(d);
    void onboarding.refresh();
  }, [onboarding]);

  // Status gate: an authenticated athlete still on the waitlist sees the "you're on the
  // list" state, not the full app. Promotion (status → 'active', via the admin dashboard)
  // is what unlocks the app — every other status ('raw'/'enriched'/'claimed'/'active') is
  // an in-app user.
  const gatedApp =
    waitlisted ? <WaitlistScreen />
    : agentWaiting ? <View style={styles.loader} testID="agent-onboarding-splash"><ActivityIndicator size="large" color={Colors.light.primary} /></View>
    : agentGated ? <AgentOnboardingFlow onDone={setAgentExit} front={frontOn} />
    : onboarding.gated && onboarding.runId ? <OnboardingScreen runId={onboarding.runId} onDone={onOnboardingDone} />
    : agentExit?.startPrompt ? <MainTabNavigator initialTabName="SearchAsk" initialMilaPrompt={agentExit.startPrompt} />
    : agentExit?.screen ? <MainTabNavigator initialTabName={tabForScreen(agentExit.screen)} />
    : <MainTabNavigator initialTabName={door === "deals" ? "Opportunities" : undefined} />;

  if (AGENT_GALLERY) return <AgentGalleryScreen />;
  if (DEALS_GALLERY) return <DealsGalleryScreen />;

  // This account's deletion was confirmed (410 account_deleting, here or on another phone): say so, then sign out.
  if (accountDeleting) return <AccountDeletingScreen onOk={() => { void leaveDeletedAccount(); }} />;

  // Signed in, but the server could not say who she is after several tries: Try again / Sign out, never a forever spinner
  // and never "no athlete" (which would send her to sign-up).
  if (profileUnavailable) return <ProfileUnavailableScreen onRetry={retryProfile} onSignOut={() => { void signOut(); }} />;

  // The agent onboarding front, signed out or not yet an athlete: its own screens (the dark ground while the server is
  // asked, never a flash of today's sign-in). With either flag off this is skipped and everything below is unchanged.
  if (AGENT_V3 && !isAuthenticated && (front === null || frontOn)) {
    if (front === null || isLoading) return <FrontWaiting />;
    return <OnboardingFrontGate front={front} />;
  }

  // In dev: skip the loading spinner but still require login for real API data.
  if (DEV_BYPASS_AUTH && !isLoading) return isAuthenticated ? gatedApp : <SignInScreen />;

  if (isLoading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={Colors.light.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    // Phase A Step 3b (client flag on): signed in with Firebase but no athlete yet — the index asked "Is this you?",
    // or the user holds several profiles and must choose. Nothing is chosen for her.
    if (IDENTITY_CLAIM && claimPrompt) return <IsThisYouScreen prompt={claimPrompt} onConfirm={confirmClaim} onDismiss={dismissClaims} />;
    if (IDENTITY_CLAIM && profileChoice) return <ChooseProfileScreen profiles={profileChoice} onChoose={chooseProfile} />;
    return <SignInScreen />;
  }

  return gatedApp;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    Outfit_700Bold,
    Outfit_800ExtraBold,
    Outfit_900Black,
    ArchivoNarrow_700Bold,
    ArchivoNarrow_700Bold_Italic,
    InstrumentSerif_400Regular,
    InstrumentSerif_400Regular_Italic,
    BodoniModa_400Regular,
    BodoniModa_500Medium,
    BodoniModa_500Medium_Italic,
    BodoniModa_600SemiBold,
    Jost_300Light,
    Jost_400Regular,
    Jost_500Medium,
    Anton_400Regular,
    BarlowCondensed_500Medium,
    BarlowCondensed_600SemiBold,
    BarlowCondensed_700Bold,
    Barlow_400Regular,
    Barlow_500Medium,
    BigShouldersDisplay_700Bold,
    BigShouldersDisplay_800ExtraBold,
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_700Bold,
    ...Feather.font,
    ...Ionicons.font,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <WebFrame on={WEB_V2_ON}>
              <NavigationContainer linking={LINKING} documentTitle={LINKING ? WEB_DOCUMENT_TITLE : undefined}>
                <RootGate />
              </NavigationContainer>
            </WebFrame>
            <StatusBar style="light" />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.light.backgroundRoot,
  },
  loader: {
    flex: 1,
    backgroundColor: Brand.heroBg,
    alignItems: "center",
    justifyContent: "center",
  },
});
