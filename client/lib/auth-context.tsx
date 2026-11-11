import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import * as AuthSession from "expo-auth-session";
import * as Google from "expo-auth-session/providers/google";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import { Platform, Alert } from "react-native";
import { getApiUrl } from "./query-client";
import { AGENT_V3, IDENTITY_CLAIM } from "./flags";
import { loadOnboardingFront } from "./onboardingFront";
import { startEmailCode as postStartEmailCode, verifyEmailCode as postVerifyEmailCode, type StartOutcome, type VerifyOutcome } from "./emailCodeSignIn";
import { signInFailureOf, type SignInFailure } from "./signInFailure";
import { athleteHeader, loadSelectedAthlete, setSelectedAthlete } from "./athlete-selection";
import { logger } from "./logger";
import { unregisterPush } from "./push";
import { isAccountDeletingResponse, onAccountDeleting, reportAccountDeleting, silenceAccountDeleting } from "./account-deleting";
import {
  auth,
  onAuthStateChanged,
  signInWithGoogleCredential,
  signInWithGooglePopup,
  signInWithGoogleRedirect,
  signInWithAppleCredential,
  signInWithFirebaseCustomToken,
  signInWithMicrosoftPopup,
  signInWithMicrosoftRedirect,
  processRedirectResult,
  firebaseSignOutUser,
  getFirebaseIdToken,
  emailSignIn,
  emailSignUp,
  emailPasswordReset,
  firebaseAuthErrorMessage,
  type FirebaseUser,
} from "./firebase-client";

WebBrowser.maybeCompleteAuthSession();

// ─── Types ────────────────────────────────────────────────────────────────────

// Matches GET /api/v1/auth/me response shape
export interface Athlete {
  id:               string;
  email:            string | null;
  firstName:        string | null;
  lastName:         string | null;
  profileImageUrl:  string | null;
  role:             string;
  subscriptionTier: "free" | "pro" | "elite";
  sport:            string | null;
  school:           string | null;
  conference:       string | null;
  goalArchetype:    string | null;
  status:           string;
  /**
   * Whether the server has web voice turned on (MILA_VOICE_WEB). Drives whether
   * the Ask Mila mic button renders — see useMilaVoice.
   *
   * OPTIONAL, and absence means OFF. A profile cached from before this field
   * existed, or a server that predates it, must read as "no voice" rather than
   * as "voice" — the safe direction is the one where the button hides.
   */
  voiceEnabled?:    boolean;
}

// ─── Phase A Step 3b: the claim prompt and the profile choice ───────────────
/** What the server shows for one candidate (the public index record; never an e-mail, never a uid). */
export interface ClaimCandidate {
  athleteId: string; fullName: string; sport: string | null; teamOrSchool: string | null; classYear: number | null;
  cityOrCountry: string | null; knownSocialHandles: Record<string, string> | null; claimability: "open" | "review" | "none";
  matchScore?: number;
}
export interface ClaimPrompt { claimSessionId: string; tier: string; claims: Array<{ claimId: string; athleteId: string; candidate: ClaimCandidate | null }> }
export interface ProfileChoice { athleteId: string; fullName: string | null; relation: string; proof: string }
export type { SignInFailure } from "./signInFailure";

/**
 * How a caller hears that a Google, Apple or Microsoft sign-in failed. With `onError` the failure is handed to the
 * caller (the agent front draws it as its error line) instead of the system alert the older sign-in screen shows.
 * Cancelling never counts as a failure.
 */
export interface SignInOptions { onError?: (failure: SignInFailure) => void }

/** What the email code's verify step comes back with; on `ok` the app is already signing in. */
export type EmailVerifyResult = Exclude<VerifyOutcome, { kind: "ok" }> | { kind: "ok" };

interface AuthContextType {
  athlete:              Athlete | null;
  /** 3b: the "Is this you?" question, when the server asked one (client flag on). */
  claimPrompt:          ClaimPrompt | null;
  confirmClaim:         (claimId: string) => Promise<void>;
  dismissClaims:        () => Promise<void>;
  /** 3b: the user holds more than one athlete profile and must choose (never chosen for her). */
  profileChoice:        ProfileChoice[] | null;
  chooseProfile:        (athleteId: string) => Promise<void>;
  /**
   * The agent onboarding front (EXPO_PUBLIC_AGENT_V3 + the server's AGENT_ONBOARDING): signed in, no athlete yet, and
   * the sign-up waits for the sport grid. Always false with either flag off (sign-up runs at once, as before).
   */
  awaitingSports:       boolean;
  /**
   * Sign up with the sports from the grid (main first) and, when the grid asked (`signupNeedsName`), the name typed
   * there; the index match sees the main sport and the name.
   */
  completeSignup:       (sports: string[], name?: string | null) => Promise<void>;
  /** The signed-in user brought no name (an email code, often Apple): the sport grid asks for one. */
  signupNeedsName:      boolean;
  /** The sports picked on the grid this session (main first), for the onboarding start; null when none were. */
  frontSports:          string[] | null;
  isLoading:            boolean;
  /**
   * GET /auth/me kept answering "unavailable" (5xx or no network) for PROFILE_RETRY.attempts tries: the app shows
   * "can't reach Nomila" with Try again (retryProfile) and Sign out, instead of spinning forever.
   */
  profileUnavailable:   boolean;
  retryProfile:         () => void;
  /**
   * The server answered 410 account_deleting (this account's deletion was confirmed, here or on another phone):
   * RootGate shows "This account is being deleted"; its OK is leaveDeletedAccount (signs out).
   */
  accountDeleting:      boolean;
  leaveDeletedAccount:  () => Promise<void>;
  isAuthenticated:      boolean;
  appleSignInAvailable: boolean;
  /** The server refused to create a new account (403 signups_closed); the sign-in screens show SIGNUPS_CLOSED_MESSAGE. */
  signupsClosed:        boolean;
  needsSetup:           boolean;
  setNeedsSetup:        (v: boolean) => void;
  signInWithGoogle:     (opts?: SignInOptions) => Promise<void>;
  signInWithApple:      (opts?: SignInOptions) => Promise<void>;
  signInWithMicrosoft:  (opts?: SignInOptions) => Promise<void>;
  /** Email a 6-digit sign-in code (server/routes/authEmailCode.ts). Never reports "sent" when nothing was sent. */
  startEmailCode:       (email: string) => Promise<StartOutcome>;
  /** Check the code; on a match, sign in with the server's custom token (the same path Microsoft sign-in uses). */
  verifyEmailCode:      (email: string, code: string) => Promise<EmailVerifyResult>;
  signInWithEmail:      (email: string, password: string) => Promise<void>;
  createAccountWithEmail: (email: string, password: string, name: string) => Promise<void>;
  sendEmailPasswordReset: (email: string) => Promise<void>;
  signOut:              () => Promise<void>;
  getAccessToken:       () => Promise<string | null>;
  refreshAthlete:       () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = "241621020090-iedv8l2vs8cujmfmlu1i4adgbs4q1ev2.apps.googleusercontent.com";
const GOOGLE_CLIENT_ID_IOS = "241621020090-ktpco1g6moehmndre8qf78q89b7globj.apps.googleusercontent.com";

const MICROSOFT_DISCOVERY = {
  authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint:         "https://login.microsoftonline.com/common/oauth2/v2.0/token",
};

// ─── API helpers ──────────────────────────────────────────────────────────────

/**
 * `unavailable`: the server could not answer who she is right now (a 5xx — e.g. 503 when its token-revocation check
 * could not reach Firebase — or no network). That is "try again", NEVER "no athlete": treating it as no athlete would
 * send a signed-in athlete to sign-up (or the sport grid) and could create a second profile.
 */
type ProfileResult = { athlete: Athlete | null; selection?: ProfileChoice[]; unavailable?: boolean; deleting?: boolean };

/**
 * Profile retries while the server is unavailable: `attempts` tries in all, waiting firstMs, doubling, capped at maxMs
 * (2 + 4 + 8 + 16 + 20 s ≈ 50 s), then the "can't reach Nomila" state.
 */
export const PROFILE_RETRY = { firstMs: 2000, maxMs: 20_000, attempts: 6 };

async function fetchAthleteProfile(idToken: string): Promise<ProfileResult> {
  try {
    const res = await fetch(new URL("/api/v1/auth/me", getApiUrl()).toString(), {
      headers: { Authorization: `Bearer ${idToken}`, ...athleteHeader() },
    });
    if (res.ok) return { athlete: (await res.json()) as Athlete };
    if (res.status >= 500) return { athlete: null, unavailable: true };
    // The account is being deleted: never "no athlete" (that would start a sign-up).
    if (res.status === 410 && isAccountDeletingResponse(410, await res.text().catch(() => ""))) return { athlete: null, deleting: true };
    if (res.status === 409) {
      // Phase A Step 3b: more than one athlete profile — she chooses; the app never picks the first row
      const body = (await res.json().catch(() => ({}))) as { error?: string; profiles?: ProfileChoice[] };
      if (body.error === "athlete_selection_required" && Array.isArray(body.profiles)) return { athlete: null, selection: body.profiles };
    }
    return { athlete: null };
  } catch (err) {
    logger.error("fetchAthleteProfile error:", err);
    return { athlete: null, unavailable: true };
  }
}

/** `signupsClosed`: the server's sign-ups kill switch (SIGNUPS_OPEN) refused a NEW account — 403 signups_closed. */
type SignupResult = ProfileResult & { claimPrompt?: ClaimPrompt; signupsClosed?: boolean };

/** The plain line both sign-in screens show when the server answered signups_closed. */
export const SIGNUPS_CLOSED_MESSAGE = "Sign-ups are closed for now";

async function isSignupsClosed(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return body.error === "signups_closed";
}

/**
 * The agent onboarding front signs up AFTER the sport grid: the main sport goes to the index match, marked as the
 * front's, with the name typed on the grid when the sign-in brought none.
 */
export interface FrontSignup { sport: string; name?: string | null }

export async function createAthleteRow(firebaseUser: FirebaseUser, idToken: string, claimSessionId: string | null = null, front: FrontSignup | null = null): Promise<SignupResult> {
  const name = front?.name?.replace(/\s+/g, " ").trim()
    || firebaseUser.displayName
    || firebaseUser.email?.split("@")[0]
    || "Athlete";

  try {
    const res = await fetch(new URL("/api/v1/auth/signup", getApiUrl()).toString(), {
      method:  "POST",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ name, role: "athlete", ...(claimSessionId ? { claimSessionId } : {}), ...(front ? { sport: front.sport, front: "agent" } : {}) }),
    });
    if (res.status === 409 && IDENTITY_CLAIM) {
      // Phase A Step 3b: the index found candidates — "Is this you?" — nothing links until she decides
      const body = (await res.json().catch(() => ({}))) as { error?: string } & Partial<ClaimPrompt>;
      if (body.error === "confirmation_required" && body.claimSessionId && Array.isArray(body.claims)) {
        return { athlete: null, claimPrompt: { claimSessionId: body.claimSessionId, tier: body.tier ?? "candidate", claims: body.claims } };
      }
    }
    if (await isSignupsClosed(res)) return { athlete: null, signupsClosed: true };
    if (!res.ok) {
      logger.error("createAthleteRow signup failed", { status: res.status });   // a 409 with the client flag off lands here: no silent create
      return { athlete: null };
    }
    // Force-refresh token so custom claims propagate
    const freshToken = await firebaseUser.getIdToken(true);
    return fetchAthleteProfile(freshToken);
  } catch (err) {
    logger.error("createAthleteRow exception:", err);
    return { athlete: null };
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [athlete, setAthlete]                   = useState<Athlete | null>(null);
  const [isLoading, setIsLoading]               = useState(true);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const [needsSetup, setNeedsSetup]             = useState(false);
  const [claimPrompt, setClaimPrompt]           = useState<ClaimPrompt | null>(null);
  const [profileChoice, setProfileChoice]       = useState<ProfileChoice[] | null>(null);
  const [firebaseUserRef, setFirebaseUserRef]   = useState<FirebaseUser | null>(null);
  const [awaitingSports, setAwaitingSports]     = useState(false);
  const [frontSports, setFrontSports]           = useState<string[] | null>(null);
  const [frontName, setFrontName]               = useState<string | null>(null);
  const [signupNeedsName, setSignupNeedsName]   = useState(false);
  const [appleSignInAvailable, setAppleSignIn]  = useState(false);
  const [signupsClosed, setSignupsClosed]       = useState(false);
  const [accountDeleting, setAccountDeleting]   = useState(false);

  // Any shared request path that hears 410 account_deleting (lib/account-deleting.ts).
  useEffect(() => onAccountDeleting(() => setAccountDeleting(true)), []);

  /** The server refused a NEW account (SIGNUPS_OPEN off): say so on the sign-in screen and drop the Firebase session. */
  const closeSignup = useCallback(async () => {
    setSignupsClosed(true); setAwaitingSports(false); setClaimPrompt(null); setProfileChoice(null); setAthlete(null);
    await firebaseSignOutUser().catch((err) => logger.error("Sign out after signups_closed failed:", err));
  }, []);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync()
      .then(setAppleSignIn)
      .catch(() => setAppleSignIn(false));
  }, []);

  // Consume Google ID token passed from landing page via URL hash (#gtoken=...)
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const hash = window.location.hash;
    if (!hash.includes("gtoken=")) return;
    const token = new URLSearchParams(hash.slice(1)).get("gtoken");
    if (!token) return;
    // Clean the hash immediately so it's not visible or reused
    window.history.replaceState(null, "", window.location.pathname);
    signInWithGoogleCredential(decodeURIComponent(token)).catch((err) => {
      logger.error("Landing page token sign-in failed:", err);
    });
  }, []);

  // Process any pending OAuth redirect result on page load (mobile web)
  useEffect(() => {
    if (Platform.OS !== "web") return;
    processRedirectResult().catch((err) => {
      logger.error("OAuth redirect result error:", err);
    });
  }, []);

  // Who the signed-in user is: the profile, else sign-up (or the sport grid). Kept in a ref so the auth listener and
  // "Try again" run the same, current code.
  const loadProfileRef = useRef<(firebaseUser: FirebaseUser) => Promise<void>>(async () => {});
  loadProfileRef.current = async (firebaseUser: FirebaseUser) => {
    try {
      setFirebaseUserRef(firebaseUser);
      await loadSelectedAthlete();
      let result: SignupResult = await fetchAthleteProfile(await firebaseUser.getIdToken());
      // Unavailable is "try again", never "no athlete": keep loading and retry (doubling, capped) while this same user
      // is signed in. After PROFILE_RETRY.attempts tries, stop and show "can't reach Nomila" (Try again / Sign out).
      let wait = PROFILE_RETRY.firstMs;
      for (let tries = 1; result.unavailable; tries++, wait = Math.min(wait * 2, PROFILE_RETRY.maxMs)) {
        if (tries >= PROFILE_RETRY.attempts) {
          logger.warn("profile unavailable — giving up for now", { tries });
          setProfileUnavailable(true);
          setIsLoading(false);
          return;
        }
        logger.warn("profile unavailable — retrying", { waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
        if (auth.currentUser?.uid !== firebaseUser.uid) return;   // signed out or switched meanwhile
        result = await fetchAthleteProfile(await firebaseUser.getIdToken());
      }
      setProfileUnavailable(false);
      if (result.deleting) {
        reportAccountDeleting();
        setAthlete(null);
        setIsLoading(false);
        return;
      }
      if (!result.athlete && !result.selection) {
        // The agent onboarding front: sign-up waits for the sport grid (completeSignup). Otherwise, as before.
        if (AGENT_V3 && (await loadOnboardingFront()).agentOnboarding) {
          setSignupNeedsName(!firebaseUser.displayName?.trim());
          setAwaitingSports(true);
          setIsLoading(false);
          return;
        }
        // A fresh token: the first one may be close to expiry after the retries.
        result = await createAthleteRow(firebaseUser, await firebaseUser.getIdToken());
        if (result.signupsClosed) { await closeSignup(); setIsLoading(false); return; }
      }
      setClaimPrompt(result.claimPrompt ?? null);
      setProfileChoice(result.selection ?? null);
      setAthlete(result.athlete);
      if (result.athlete) setSignupsClosed(false);
    } catch (err) {
      logger.error("onAuthStateChanged profile/signup error:", err);
      setAthlete(null);
    }
    setIsLoading(false);
  };

  // Firebase auth state listener — single source of truth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setAwaitingSports(false);
        setProfileUnavailable(false);
        setAthlete(null);
        setIsLoading(false);
        return;
      }
      await loadProfileRef.current(firebaseUser);
    });
    return unsubscribe;
  }, []);

  /** "Try again" on the can't-reach state: the same load, from the top. */
  const retryProfile = useCallback(() => {
    const u = auth.currentUser;
    if (!u) { setProfileUnavailable(false); return; }
    setProfileUnavailable(false);
    setIsLoading(true);
    void loadProfileRef.current(u);
  }, []);

  const refreshAthlete = useCallback(async () => {
    const idToken = await getFirebaseIdToken();
    if (!idToken) return;
    const result = await fetchAthleteProfile(idToken);
    if (result.unavailable) return;   // keep what we have; never read as "no athlete"
    if (result.selection) setProfileChoice(result.selection);
    if (result.athlete) { setAthlete(result.athlete); setProfileChoice(null); }
  }, []);

  // ─── Phase A Step 3b: "Is this you?" ────────────────────────────────────────
  // The claim id and the session id are the only handles; the server validates both against the user. After she decided
  // (linked, or continuing on a new profile), signup is retried with the session id — the server reads her decision,
  // never the client's say-so.
  const retrySignup = useCallback(async (claimSessionId: string) => {
    const fu = firebaseUserRef; if (!fu) return;
    const idToken = await fu.getIdToken(true);
    const result = await createAthleteRow(fu, idToken, claimSessionId, frontSports?.length ? { sport: frontSports[0], name: frontName } : null);
    if (result.signupsClosed) { await closeSignup(); return; }
    setClaimPrompt(result.claimPrompt ?? null);
    setProfileChoice(result.selection ?? null);
    if (result.athlete) setAthlete(result.athlete);
  }, [firebaseUserRef, frontSports, frontName, closeSignup]);

  // ─── The agent onboarding front: sign-up after the sport grid ──────────────────────────────────────────────────
  const completeSignup = useCallback(async (sports: string[], name: string | null = null) => {
    const fu = firebaseUserRef ?? auth.currentUser; if (!fu || !sports.length) return;
    const idToken = await fu.getIdToken();
    const result = await createAthleteRow(fu, idToken, null, { sport: sports[0], name });
    if (result.signupsClosed) { await closeSignup(); return; }
    if (!result.athlete && !result.claimPrompt && !result.selection) throw new Error("signup failed");
    setFrontSports(sports);
    setFrontName(name);
    setAwaitingSports(false);
    setClaimPrompt(result.claimPrompt ?? null);
    setProfileChoice(result.selection ?? null);
    setAthlete(result.athlete);
  }, [firebaseUserRef, closeSignup]);

  const confirmClaim = useCallback(async (claimId: string) => {
    const prompt = claimPrompt; if (!prompt) return;
    const idToken = await getFirebaseIdToken(); if (!idToken) return;
    const res = await fetch(new URL(`/api/v1/identity/claims/${claimId}/confirm`, getApiUrl()).toString(), {
      method: "POST", headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ claimSessionId: prompt.claimSessionId }),
    });
    if (res.status === 410) { setClaimPrompt(null); await retrySignup(prompt.claimSessionId); return; }
    if (!res.ok) throw new Error("We couldn't record that. Please try again.");
    const out = (await res.json()) as { outcome: string };
    if (out.outcome === "pending_operator") Alert.alert("Thanks — we'll check this", "Our team will confirm that profile is yours. Meanwhile you continue on a fresh profile.");
    if (out.outcome === "taken") Alert.alert("That profile already has an owner", "We'll sort this out. You continue on a fresh profile.");
    await retrySignup(prompt.claimSessionId);   // linked ⇒ the linked row; pending/taken ⇒ the new row
  }, [claimPrompt, retrySignup]);

  const dismissClaims = useCallback(async () => {
    const prompt = claimPrompt; if (!prompt) return;
    const idToken = await getFirebaseIdToken(); if (!idToken) return;
    const res = await fetch(new URL(`/api/v1/identity/claims/session/${prompt.claimSessionId}/dismiss`, getApiUrl()).toString(), { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok && res.status !== 404) throw new Error("We couldn't record that. Please try again.");
    await retrySignup(prompt.claimSessionId);
  }, [claimPrompt, retrySignup]);

  const chooseProfile = useCallback(async (athleteId: string) => {
    await setSelectedAthlete(athleteId);
    await refreshAthlete();
  }, [refreshAthlete]);

  /** A failed sign-in: handed to the caller when it asked (the agent front), else today's system alert. */
  const fail = (opts: SignInOptions | undefined, title: string, message: string, err?: unknown) => {
    if (opts?.onError) opts.onError(signInFailureOf(err)); else Alert.alert(title, message);
  };
  /** The athlete closed the web popup: not a failure for the front's error line. */
  const closedPopup = (err: unknown) => ["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes((err as { code?: string })?.code ?? "");

  // ── Google ──────────────────────────────────────────────────────────────────
  // Native Google finishes in the effect below, after the prompt has returned: the caller's onError waits here, and is
  // cleared once it has been used (or the sign-in went through), so a later response never reports to a stale caller.
  const googleOnError = useRef<SignInOptions["onError"] | null>(null);
  const redirectUri = Platform.OS === "web" ? AuthSession.makeRedirectUri() : undefined;

  const [, googleResponse, googlePromptAsync] = Google.useIdTokenAuthRequest({
    clientId:    GOOGLE_CLIENT_ID,
    iosClientId: GOOGLE_CLIENT_ID_IOS,
    ...(redirectUri ? { redirectUri } : {}),
    scopes:      ["openid", "profile", "email"],
    extraParams: { prompt: "select_account" },
  });

  useEffect(() => {
    if (!googleResponse) return;
    const onError = googleOnError.current ?? undefined;
    googleOnError.current = null;
    if (googleResponse.type === "success") {
      const idToken = googleResponse.params.id_token;
      if (idToken) {
        signInWithGoogleCredential(idToken).catch((err) => {
          logger.error("Google Firebase sign-in failed:", err);
          fail(onError ? { onError } : undefined, "Sign In Failed", "Google sign in failed. Please try again.", err);
        });
      } else if (onError) {
        onError({ kind: "failed" });
      }
    } else if (googleResponse.type === "error" && onError) {
      onError({ kind: "failed" });
    }
  }, [googleResponse]);

  const signInWithGoogle = async (opts?: SignInOptions) => {
    if (Platform.OS === "web") {
      // Mobile web: redirect only. Popup is unreliable across mobile web (iOS breaks
      // window.opener during cross-origin nav; Android is flaky), and with same-origin
      // authDomain redirect stores/reads from same-origin IndexedDB — no partitioning.
      //
      // Desktop web (incl. localhost dev): popup. On localhost the authDomain falls back
      // to the cross-origin firebaseapp.com handler, which Chrome's storage partitioning
      // breaks for signInWithRedirect (getRedirectResult returns null → bounce back to
      // sign-in). Popup avoids the redirect round-trip and works cross-origin on desktop.
      const isMobileWeb = typeof navigator !== "undefined" &&
        /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      try {
        if (isMobileWeb) {
          await signInWithGoogleRedirect();
        } else {
          await signInWithGooglePopup();
        }
      } catch (err) {
        logger.error("Google web sign-in error:", err);
        if (opts?.onError && closedPopup(err)) return;
        fail(opts, "Error", "Could not start Google sign in. Please try again.", err);
      }
      return;
    }
    googleOnError.current = opts?.onError ?? null;   // native: the response arrives in the effect above
    try {
      await googlePromptAsync();
    } catch (err) {
      googleOnError.current = null;
      logger.error("Google prompt error:", err);
      fail(opts, "Error", "Could not start Google sign in.", err);
    }
  };

  // ── Apple ───────────────────────────────────────────────────────────────────
  const signInWithApple = async (opts?: SignInOptions) => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        fail(opts, "Sign In Failed", "Apple did not return an identity token.");
        return;
      }
      await signInWithAppleCredential(credential.identityToken);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ERR_REQUEST_CANCELED") return;
      logger.error("Apple sign-in error:", err);
      fail(opts, "Sign In Failed", "Apple sign in failed. Please try again.", err);
    }
  };

  // ── Microsoft ───────────────────────────────────────────────────────────────
  const msRedirectUri = AuthSession.makeRedirectUri({ scheme: "co.nomila.app" });
  const [msRequest, , msPromptAsync] = AuthSession.useAuthRequest(
    {
      clientId:    process.env.EXPO_PUBLIC_MICROSOFT_CLIENT_ID ?? "",
      scopes:      ["openid", "profile", "email", "User.Read"],
      redirectUri: msRedirectUri,
    },
    MICROSOFT_DISCOVERY,
  );

  const signInWithMicrosoft = async (opts?: SignInOptions) => {
    if (Platform.OS === "web") {
      try {
        await signInWithMicrosoftRedirect();
      } catch (err) {
        logger.error("Microsoft popup error:", err);
        if (opts?.onError && closedPopup(err)) return;
        fail(opts, "Sign In Failed", "Microsoft sign in failed.", err);
      }
      return;
    }
    if (!msRequest) {
      fail(opts, "Error", "Microsoft sign in is not configured.");
      return;
    }
    try {
      const result = await msPromptAsync();
      if (result.type !== "success" || !result.params.code) {
        if (result.type !== "cancel" && result.type !== "dismiss") {
          fail(opts, "Sign In Failed", "Microsoft sign in failed.");
        }
        return;
      }
      const res = await fetch(new URL("/api/v1/auth/microsoft", getApiUrl()).toString(), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code: result.params.code, redirectUri: msRedirectUri }),
      });
      if (await isSignupsClosed(res)) { setSignupsClosed(true); return; }
      if (!res.ok) {
        fail(opts, "Sign In Failed", "Microsoft sign in failed.");
        return;
      }
      const { customToken } = await res.json() as { customToken: string };
      await signInWithFirebaseCustomToken(customToken);
    } catch (err) {
      logger.error("Microsoft sign-in error:", err);
      fail(opts, "Error", "Could not complete Microsoft sign in.", err);
    }
  };

  // ── Email code (the agent front's "Use email instead") ─────────────────────────────────────────────────────────
  const startEmailCode = useCallback((email: string) => postStartEmailCode(email), []);

  const verifyEmailCode = useCallback(async (email: string, code: string): Promise<EmailVerifyResult> => {
    const out = await postVerifyEmailCode(email, code);
    if (out.kind !== "ok") return out;
    try {
      // onAuthStateChanged takes it from here: the sport grid (asking the name), then sign-up, as for every way in.
      await signInWithFirebaseCustomToken(out.customToken);
      return { kind: "ok" };
    } catch (err) {
      logger.error("Email code Firebase sign-in failed:", err);
      return { kind: "failed" };
    }
  }, []);

  // ── Email ───────────────────────────────────────────────────────────────────
  const signInWithEmail = async (email: string, password: string) => {
    try {
      await emailSignIn(email, password);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      throw new Error(firebaseAuthErrorMessage(code));
    }
  };

  const createAccountWithEmail = async (email: string, password: string, _name: string) => {
    try {
      await emailSignUp(email, password);
      // onAuthStateChanged fires automatically → createAthleteRow handles row creation
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      throw new Error(firebaseAuthErrorMessage(code));
    }
  };

  const sendEmailPasswordReset = async (email: string) => {
    await emailPasswordReset(email);
  };

  // ── Sign out ────────────────────────────────────────────────────────────────
  const signOut = async () => {
    // While she is still signed in: this phone stops getting her notifications (best effort, never blocks sign-out).
    await unregisterPush();
    try {
      setProfileUnavailable(false);
      await setSelectedAthlete(null); setClaimPrompt(null); setProfileChoice(null); setAwaitingSports(false); setFrontSports(null); setFrontName(null); setSignupNeedsName(false);
      await firebaseSignOutUser();
    } catch (err) {
      logger.error("Sign out error:", err);
      setAthlete(null);
    }
  };

  /** OK on "This account is being deleted", or Done after this phone deleted it: sign out, back to the front door. */
  const leaveDeletedAccount = async () => {
    silenceAccountDeleting(true);   // the sign-out's own calls hear 410 too
    await signOut();
    setAccountDeleting(false);
    silenceAccountDeleting(false);
  };

  return (
    <AuthContext.Provider
      value={{
        athlete,
        isLoading,
        profileUnavailable,
        retryProfile,
        accountDeleting,
        leaveDeletedAccount,
        isAuthenticated:      !!athlete,
        appleSignInAvailable,
        signupsClosed,
        needsSetup,
        setNeedsSetup,
        claimPrompt,
        confirmClaim,
        dismissClaims,
        profileChoice,
        chooseProfile,
        awaitingSports,
        completeSignup,
        signupNeedsName,
        frontSports,
        signInWithGoogle,
        signInWithApple,
        signInWithMicrosoft,
        startEmailCode,
        verifyEmailCode,
        signInWithEmail,
        createAccountWithEmail,
        sendEmailPasswordReset,
        signOut,
        getAccessToken: getFirebaseIdToken,
        refreshAthlete,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
