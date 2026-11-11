/**
 * OnboardingFrontGate — the agent onboarding FRONT before an athlete exists (EXPO_PUBLIC_AGENT_V3 + the server's
 * AGENT_ONBOARDING, both on; either off ⇒ App draws today's screens):
 *
 *   signed out                       SignInFront (rotating library photos, "Get your agent" → Google · Apple · Microsoft,
 *                                    and "Use email instead" when the server offers the email code). A failed sign-in
 *                                    shows as the front's error line, never a system alert.
 *   signed in, no athlete yet        SportGridScreen — the sign-up waits for the sports (auth-context completeSignup); it
 *                                    asks the name too when the sign-in brought none (an email code, often Apple)
 *   the index asked "Is this you?"   IsThisYouFront over the existing claim flow (EXPO_PUBLIC_IDENTITY_CLAIM)
 *   several profiles                 the existing ChooseProfileScreen
 *
 * After the sign-up the athlete exists and App's agent onboarding gate takes over (Mila's intro, then what she has).
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SIGNUPS_CLOSED_MESSAGE, useAuth, type SignInOptions } from "../../lib/auth-context";
import { signInFailureOf, type SignInFailure } from "../../lib/signInFailure";
import { haptics } from "../../lib/haptics";
import { IDENTITY_CLAIM } from "../../lib/flags";
import { FRONT_OFF, loadOnboardingFront, type OnboardingFront } from "../../lib/onboardingFront";
import { Bold } from "../../constants/theme";
import { ChooseProfileScreen } from "../ChooseProfileScreen";
import { SignInFront } from "./SignInFront";
import { SportGridScreen } from "./SportGridScreen";
import { IsThisYouFront } from "./IsThisYouFront";

/** The server's answer for this launch: null while it is asked, FRONT_OFF when the build flag is off. */
export function useOnboardingFront(buildFlag: boolean): OnboardingFront | null {
  const [front, setFront] = useState<OnboardingFront | null>(buildFlag ? null : FRONT_OFF);
  useEffect(() => {
    if (!buildFlag) return;
    let live = true;
    void loadOnboardingFront().then((f) => { if (live) setFront(f); });
    return () => { live = false; };
  }, [buildFlag]);
  return front;
}

/** The dark ground the front draws while it waits (never today's sign-in, which would flash). */
export function FrontWaiting() {
  return <View style={styles.wait} testID="front-waiting"><ActivityIndicator color={Bold.onDark} /></View>;
}

export function OnboardingFrontGate({ front }: { front: OnboardingFront }) {
  const {
    claimPrompt, confirmClaim, dismissClaims, profileChoice, chooseProfile, awaitingSports, completeSignup, signupNeedsName,
    signInWithGoogle, signInWithApple, signInWithMicrosoft, startEmailCode, verifyEmailCode, appleSignInAvailable, signupsClosed,
  } = useAuth();
  const [busy, setBusy] = useState<"google" | "apple" | "microsoft" | "sports" | null>(null);
  const [error, setError] = useState(false);
  const [signInError, setSignInError] = useState<SignInFailure | null>(null);
  const run = async (key: "google" | "apple" | "microsoft" | "sports", fn: () => Promise<void>) => {
    setBusy(key); setError(false);
    try { await fn(); } catch { setError(true); } finally { setBusy(null); }
  };
  /** A provider sign-in: its failure (handed back by auth-context, or thrown) is the front's error line. */
  const signIn = (key: "google" | "apple" | "microsoft", fn: (opts?: SignInOptions) => Promise<void>) => {
    const failed = (f: SignInFailure) => { setSignInError(f); haptics.error(); };
    setSignInError(null); setBusy(key);
    void fn({ onError: failed }).catch((err) => failed(signInFailureOf(err))).finally(() => setBusy(null));
  };

  if (IDENTITY_CLAIM && claimPrompt) return <IsThisYouFront prompt={claimPrompt} onConfirm={confirmClaim} onDismiss={dismissClaims} />;
  if (IDENTITY_CLAIM && profileChoice) return <ChooseProfileScreen profiles={profileChoice} onChoose={chooseProfile} />;
  if (awaitingSports) {
    return (
      <SportGridScreen
        askName={signupNeedsName}
        onContinue={({ sports, name }) => { void run("sports", () => completeSignup(sports, name)); }}
        busy={busy === "sports"}
        error={error}
      />
    );
  }
  return (
    <SignInFront
      photos={front.signinPhotos}
      busy={busy === "google" || busy === "apple" || busy === "microsoft" ? busy : null}
      appleAvailable={appleSignInAvailable}
      notice={signupsClosed ? SIGNUPS_CLOSED_MESSAGE : null}
      onGoogle={() => signIn("google", signInWithGoogle)}
      onApple={() => signIn("apple", signInWithApple)}
      onMicrosoft={() => signIn("microsoft", signInWithMicrosoft)}
      providerError={signInError}
      emailSignIn={front.emailSignIn}
      onEmailStart={(email) => { setSignInError(null); return startEmailCode(email); }}
      onEmailVerify={verifyEmailCode}
    />
  );
}

const styles = StyleSheet.create({
  wait: { flex: 1, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
});
