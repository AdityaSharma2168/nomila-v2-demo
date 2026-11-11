// Firebase client SDK — same GCP project as the server (gamechanger-pocket-agent).
// These config values are public and safe to embed in client code.
// Security is enforced via Firebase Security Rules and server-side token verification.
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  signInWithCredential,
  signInWithCustomToken,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  type UserCredential,
  type User as FirebaseUser,
  type Auth,
} from "firebase/auth";
import { Platform } from "react-native";

const firebaseConfig = {
  apiKey:            "AIzaSyAfVZNcQ65LcRQPh1XbUZYT4Yab5WFcvGw",
  // Use the current hostname as authDomain so the auth handler is same-origin.
  // Cross-origin authDomain (firebaseapp.com) causes iOS Chrome storage partitioning
  // to drop Firebase's initial state, breaking both redirect and popup flows.
  // nomila-dev.web.app/__/auth/handler is registered on the Firebase Auth client.
  // On native (iOS/Android dev app) `window` exists but `window.location` does
  // not, so guard the .location access — otherwise reading .hostname throws at
  // module load ("Cannot read property 'hostname' of undefined").
  authDomain: typeof window !== "undefined" &&
    window.location?.hostname &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
      ? window.location.hostname
      : "gamechanger-pocket-agent.firebaseapp.com",
  projectId:         "gamechanger-pocket-agent",
  storageBucket:     "gamechanger-pocket-agent.firebasestorage.app",
  messagingSenderId: "241621020090",
  appId:             "1:241621020090:web:a4c064de2e19791aa88183",
};

const app  = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// On native, getAuth() keeps the session in memory only, so every app reload signed the athlete out. Persist it in
// AsyncStorage instead. initializeAuth throws if auth already exists (a hot reload), so fall back to getAuth then.
// Web keeps getAuth (browser persistence by default).
function createAuth(): Auth {
  if (Platform.OS === "web") return getAuth(app);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initializeAuth, getReactNativePersistence } = require("firebase/auth");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    return initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    return getAuth(app);
  }
}
const auth = createAuth();

export async function emailSignIn(email: string, password: string): Promise<string> {
  const cred: UserCredential = await signInWithEmailAndPassword(auth, email, password);
  return cred.user.getIdToken();
}

export async function emailSignUp(email: string, password: string): Promise<string> {
  const cred: UserCredential = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user.getIdToken();
}

export async function emailPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export function firebaseAuthErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-email":          return "Invalid email address.";
    case "auth/user-not-found":
    case "auth/invalid-credential":     return "No account found with that email and password.";
    case "auth/wrong-password":         return "Incorrect password.";
    case "auth/email-already-in-use":   return "An account with this email already exists. Try signing in.";
    case "auth/weak-password":          return "Password must be at least 6 characters.";
    case "auth/too-many-requests":      return "Too many attempts. Please wait and try again.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    default:                            return "Something went wrong. Please try again.";
  }
}

export async function signInWithGoogleCredential(idToken: string): Promise<FirebaseUser> {
  const credential = GoogleAuthProvider.credential(idToken);
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

export async function signInWithAppleCredential(identityToken: string): Promise<FirebaseUser> {
  const provider = new OAuthProvider("apple.com");
  const credential = provider.credential({ idToken: identityToken });
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

/** Sign in with a Firebase custom token minted by our server: Microsoft (POST /auth/microsoft) and the email code (POST /auth/email-code/verify). */
export async function signInWithFirebaseCustomToken(customToken: string): Promise<FirebaseUser> {
  const result = await signInWithCustomToken(auth, customToken);
  return result.user;
}

// sessionStorage flag — set before redirect so we can distinguish an intentional redirect
// from a cold page load. iOS Safari/Chrome clear sessionStorage on cross-origin navigation,
// so we also always call getRedirectResult unconditionally (see processRedirectResult).
const REDIRECT_PENDING = "firebase_redirect_pending";

export async function signInWithGoogleRedirect(): Promise<void> {
  // Consume any stale pending redirect state before starting a new one.
  // This prevents "malformed credential should not be retried" which Firebase
  // throws when signInWithRedirect finds an existing corrupted pending state
  // in IndexedDB (common on iOS mobile web where sessionStorage is cleared).
  try {
    const existing = await getRedirectResult(auth);
    if (existing?.user) return; // already signed in from a completed redirect
  } catch { /* corrupted state — cleared by Firebase on throw, safe to continue */ }

  const provider = new GoogleAuthProvider();
  provider.addScope("profile");
  provider.addScope("email");
  provider.setCustomParameters({ prompt: "select_account" });
  try { sessionStorage.setItem(REDIRECT_PENDING, "1"); } catch {}
  await signInWithRedirect(auth, provider);
}

export async function signInWithGooglePopup(): Promise<FirebaseUser> {
  const provider = new GoogleAuthProvider();
  provider.addScope("profile");
  provider.addScope("email");
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signInWithMicrosoftPopup(): Promise<FirebaseUser> {
  const provider = new OAuthProvider("microsoft.com");
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signInWithMicrosoftRedirect(): Promise<void> {
  const provider = new OAuthProvider("microsoft.com");
  provider.setCustomParameters({ prompt: "select_account" });
  try { sessionStorage.setItem(REDIRECT_PENDING, "1"); } catch {}
  await signInWithRedirect(auth, provider);
}

export async function processRedirectResult(): Promise<FirebaseUser | null> {
  try {
    if (typeof sessionStorage === "undefined") return null;
    // Always call getRedirectResult — on iOS mobile web, sessionStorage is cleared during
    // cross-origin navigation so the REDIRECT_PENDING flag may be gone even after a real
    // redirect. If we skip the call, the stale IndexedDB state accumulates and causes
    // "malformed credential" errors on the next sign-in attempt.
    sessionStorage.removeItem(REDIRECT_PENDING);
    const result = await getRedirectResult(auth);
    return result?.user ?? null;
  } catch (err: any) {
    const code = err?.code ?? "unknown";
    const msg  = err?.message ?? String(err);
    // Always log so a masked error never silently dead-ends login again.
    console.error(`[firebase-auth] getRedirectResult threw ${code}: ${msg}`);
    // auth/missing-initial-state and auth/web-storage-unsupported are expected on
    // fresh page loads with no pending redirect (iOS storage partitioning). All other
    // errors are unexpected but also safe to return null — the SDK clears corrupted
    // state before throwing, so the user can retry sign-in.
    return null;
  }
}

export async function getFirebaseIdToken(): Promise<string | null> {
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken();
}

export async function firebaseSignOutUser(): Promise<void> {
  await firebaseSignOut(auth);
}

export { auth, onAuthStateChanged, type FirebaseUser };
/** The one Firebase app (web notifications reuse it for Cloud Messaging: lib/webPush). */
export { app as firebaseApp };
