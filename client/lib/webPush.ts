/**
 * webPush — the browser's half of notifications (lib/push calls it on web). Firebase Cloud Messaging for web: the service
 * worker /firebase-messaging-sw.js (web-v2/firebase-messaging-sw.js, copied into the dev web build only) shows a
 * notification while the app is closed or in the background, and a tap focuses the app and opens the screen it names.
 *
 * ON only with the dev web switch (EXPO_PUBLIC_WEB_V2) in a browser AND the web-push public key
 * (EXPO_PUBLIC_FIREBASE_VAPID_KEY). Either missing → "off", and every lib/push call stays the quiet no-op it is on web
 * today. On an iPhone or iPad, web notifications work only once the site is added to the Home Screen (iOS 16.4+): in a
 * Safari tab the mode is "needs_home_screen" and Nomila's sheet shows a one-line hint instead of asking.
 *
 * While the app is open nothing pops (same as the phone app): the page receives the message and ignores it.
 */
import { Platform } from "react-native";
import { FIREBASE_VAPID_KEY, webV2On } from "./flags";

export type WebPushMode = "off" | "needs_home_screen" | "available";

/** What the browser offers, read once per call (tests pass their own). */
export interface WebEnv {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  serviceWorker: boolean;
  notification: boolean;
  pushManager: boolean;
}

export function readWebEnv(): WebEnv {
  const nav: any = typeof navigator !== "undefined" ? navigator : {};
  const win: any = typeof window !== "undefined" ? window : {};
  let standalone = nav.standalone === true;
  try { standalone = standalone || !!win.matchMedia?.("(display-mode: standalone)")?.matches; } catch { /* no matchMedia */ }
  return {
    userAgent: String(nav.userAgent ?? ""),
    maxTouchPoints: Number(nav.maxTouchPoints ?? 0),
    standalone,
    serviceWorker: !!nav.serviceWorker,
    notification: typeof win.Notification !== "undefined",
    pushManager: typeof win.PushManager !== "undefined",
  };
}

/** iPhone, iPod, or an iPad (which reports a Mac user agent but has touch). */
export function isAppleMobile(env: Pick<WebEnv, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/i.test(env.userAgent) || (/Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1);
}

/** Pure: the switch, the key and the browser decide. */
export function webPushModeFor(on: boolean, vapidKey: string, env: WebEnv): WebPushMode {
  if (!on || !vapidKey) return "off";
  if (isAppleMobile(env) && !env.standalone) return "needs_home_screen";
  if (!env.serviceWorker || !env.notification || !env.pushManager) return "off";
  return "available";
}

export function webPushMode(): WebPushMode {
  if (Platform.OS !== "web") return "off";
  return webPushModeFor(webV2On(Platform.OS), FIREBASE_VAPID_KEY, readWebEnv());
}

/** The browser's permission in lib/push's words. */
export function webPermission(): "granted" | "denied" | "undetermined" {
  const p = (window as any).Notification?.permission;
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "undetermined";
}

/** The browser's own dialog (only after she tapped "Turn on" on Nomila's sheet). */
export async function requestWebPermission(): Promise<boolean> {
  return (await (window as any).Notification.requestPermission()) === "granted";
}

/** The service worker the dev web build serves at the site root (see the file's own header). */
export const WEB_PUSH_SW_PATH = "/firebase-messaging-sw.js";

/** This browser's FCM registration token (registers the service worker on first use). Null when FCM refuses. */
export async function webPushToken(vapidKey: string = FIREBASE_VAPID_KEY): Promise<string | null> {
  const [{ getMessaging, getToken, onMessage }, { firebaseApp }] = await Promise.all([import("firebase/messaging"), import("./firebase-client")]);
  const registration = await navigator.serviceWorker.register(WEB_PUSH_SW_PATH, { scope: "/firebase-cloud-messaging-push-scope" });
  const messaging = getMessaging(firebaseApp);
  // While the app is open nothing pops: a message that arrives in the foreground is received and dropped here.
  onMessage(messaging, () => undefined);
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  return token || null;
}

/** The tap message the service worker posts to an open app window. */
export const TAP_MESSAGE = "nomila-push-tap";

/**
 * A notification tap reaches the app two ways: the worker posts {type: TAP_MESSAGE, target} to an open window, or — no
 * window open — opens "/?pushTarget=<screen>&pushId=<id>". Both hand lib/push the same `{ target }` data a phone tap
 * carries. Returns the unsubscribe.
 */
export function listenWebPushTaps(deliver: (data: unknown) => void): () => void {
  try {
    const params = new URLSearchParams(window.location.search);
    const screen = params.get("pushTarget");
    if (screen) {
      const id = params.get("pushId");
      deliver({ target: { screen, ...(id ? { id } : {}) } });
    }
  } catch { /* no location */ }
  const sw = typeof navigator !== "undefined" ? (navigator as any).serviceWorker : null;
  if (!sw?.addEventListener) return () => undefined;
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; target?: unknown } | null;
    if (d && d.type === TAP_MESSAGE) deliver({ target: d.target });
  };
  sw.addEventListener("message", onMessage);
  return () => sw.removeEventListener("message", onMessage);
}
