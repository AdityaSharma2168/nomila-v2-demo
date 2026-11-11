/**
 * push — her phone's notifications (design "Goals tab post details + plan ready", PR D). The server decides what to send
 * and when (server/services/push); this is the phone's half.
 *
 *   setUpPush            once at start: no banner, sound or badge while the app is open (the chat card and Goals already
 *                        say it); Android's two channels, "default" and "quiet" (quiet hours: no sound, low importance)
 *   registerPushIfAllowed  on sign-in and on every profile switch: ONLY if she already allowed notifications, this
 *                        phone's Expo push token goes to POST /me/push/devices for the profile in use. Never asks.
 *   askForPushOnce       the one ask, at a moment that earns it — after her first plan, or her first deal; never on a
 *                        cold launch. Nomila's own sheet first (components/push/PushAskSheet); the phone's dialog only
 *                        after she taps "Turn on" (acceptPushAsk). Asked once per phone (remembered).
 *   phonePermission      what the phone allows (Settings: "Notifications are off in your phone's settings")
 *   unregisterPush       on sign-out, before the session ends: DELETE /me/push/devices for this phone's token, never
 *                        holding sign-out more than 3 seconds
 *   onPushTap            a tap opens the screen the notification names (goals · opportunities · mila); a tap that launched
 *                        the app is delivered once the tabs are up
 *
 * A notification only tells her something; nothing is ever sent on her behalf from here. Expo Go without the native
 * module, a simulator, and the web app: every call is a quiet no-op — EXCEPT the dev web build (EXPO_PUBLIC_WEB_V2 with
 * EXPO_PUBLIC_FIREBASE_VAPID_KEY set), where the same calls drive browser notifications through lib/webPush: the same
 * sheet first, the browser's dialog after "Turn on", this browser's FCM token registered with platform "web". On an
 * iPhone in a Safari tab the sheet shows a one-line "add to Home Screen" hint instead (pushAskHint).
 */
import { Platform } from "react-native";
import { apiRequest } from "./query-client";
import * as web from "./webPush";

// Native pieces load on first use, so a screen that imports this never needs them until a push call runs.
const storage = async () => (await import("@react-native-async-storage/async-storage")).default;
const projectId = async (): Promise<string | undefined> => {
  const Constants = (await import("expo-constants")).default;
  return (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
};

type Notifications = typeof import("expo-notifications");
/** Where a tap lands; `messageId` (a message Mila started) is the exact message a "mila" target opens on. */
type Target = { screen: string; id?: string; messageId?: string };

const ASKED_KEY = "push.asked.v1";
const TOKEN_KEY = "push.token.v1";
/** The app's start, and how long after it a screen counts as the one the app launched on. */
const LOADED_AT = Date.now();
export const COLD_LAUNCH_MS = 8000;

/** The native module, or null where there is none (web, a build without it). */
async function notifications(): Promise<Notifications | null> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  try { return await import("expo-notifications"); } catch { return null; }
}

/** This browser's FCM token, sent to the server (she has allowed notifications). Returns whether it registered. */
async function registerWebToken(): Promise<boolean> {
  try {
    const token = await web.webPushToken();
    if (!token) return false;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    await apiRequest("POST", "/api/v1/me/push/devices", { token, platform: "web", timeZone });
    await (await storage()).setItem(TOKEN_KEY, token).catch(() => undefined);
    return true;
  } catch { return false; }
}

/** What Nomila's sheet shows: the ask, or (iPhone Safari tab, dev web build) the add-to-Home-Screen hint. */
export function pushAskHint(): "ask" | "home_screen" {
  return web.webPushMode() === "needs_home_screen" ? "home_screen" : "ask";
}

let setUp = false;
export async function setUpPush(): Promise<void> {
  if (setUp) return;
  if (web.webPushMode() === "available") {
    setUp = true;
    try { web.listenWebPushTaps(deliverTap); } catch { /* no service worker */ }
    return;
  }
  const N = await notifications();
  if (!N) return;
  setUp = true;
  try {
    // While the app is open, nothing pops: the chat and Goals already show it.
    N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }) });
    if (Platform.OS === "android") {
      await N.setNotificationChannelAsync("default", { name: "Nomila", importance: N.AndroidImportance.DEFAULT });
      await N.setNotificationChannelAsync("quiet", { name: "Nomila (quiet hours)", importance: N.AndroidImportance.LOW, sound: null });
    }
    N.addNotificationResponseReceivedListener((r) => deliverTap(r.notification.request.content.data));
    const last = await N.getLastNotificationResponseAsync();
    if (last) deliverTap(last.notification.request.content.data);
  } catch { /* a phone without push support: nothing to set up */ }
}

/** This phone's Expo push token, sent to the server (she has allowed notifications). Returns whether it registered. */
async function registerToken(N: Notifications): Promise<boolean> {
  try {
    const id = await projectId();
    const { data: token } = await N.getExpoPushTokenAsync(id ? { projectId: id } : undefined);
    if (!token) return false;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    await apiRequest("POST", "/api/v1/me/push/devices", { token, platform: Platform.OS, timeZone });
    await (await storage()).setItem(TOKEN_KEY, token).catch(() => undefined);
    return true;
  } catch { return false; }
}

/** On sign-in: register this phone only if she already allowed notifications. Never asks. */
export async function registerPushIfAllowed(): Promise<boolean> {
  if (web.webPushMode() === "available") {
    try { return web.webPermission() === "granted" ? await registerWebToken() : false; } catch { return false; }
  }
  const N = await notifications();
  if (!N) return false;
  try {
    const p = await N.getPermissionsAsync();
    return p.granted ? await registerToken(N) : false;
  } catch { return false; }
}

export type AskReason = "first_plan" | "first_deal";

/** The in-app sheet that asks first (components/push/PushAskSheet, mounted with the tabs). */
let askHost: ((reason: AskReason) => void) | null = null;
export function setPushAskHost(fn: ((reason: AskReason) => void) | null): void { askHost = fn; }

/**
 * The one ask, at a moment that earns it (her first plan, her first deal). It opens Nomila's own sheet first; the phone's
 * system dialog shows only after she taps "Turn on" there (acceptPushAsk). Asked at most once per phone; never on a cold
 * launch; a phone where she already answered the system dialog is never asked again by us (she changes it in the phone's
 * settings). Returns whether the phone is registered now (it already was allowed).
 */
export async function askForPushOnce(reason: AskReason, nowMs: number = Date.now()): Promise<boolean> {
  const mode = web.webPushMode();
  if (mode !== "off") {
    try {
      const p = mode === "available" ? web.webPermission() : "undetermined";
      if (p === "granted") return await registerWebToken();
      // The same rules as the phone: never on a cold launch, once per browser, never after she answered the dialog.
      if (p === "denied" || nowMs - LOADED_AT < COLD_LAUNCH_MS || !askHost) return false;
      const s = await storage();
      if (await s.getItem(ASKED_KEY)) return false;
      await s.setItem(ASKED_KEY, new Date().toISOString());
      askHost(reason);
      return false;
    } catch { return false; }
  }
  const N = await notifications();
  if (!N) return false;
  try {
    const p = await N.getPermissionsAsync();
    if (p.granted) return await registerToken(N);
    // Never on a cold launch: a screen the app opened on is not a moment she chose (the next visit asks).
    if (nowMs - LOADED_AT < COLD_LAUNCH_MS || !askHost) return false;
    const s = await storage();
    if (!p.canAskAgain || (await s.getItem(ASKED_KEY))) return false;
    await s.setItem(ASKED_KEY, new Date().toISOString());
    askHost(reason);
    return false;
  } catch { return false; }
}

/** She tapped "Turn on" on Nomila's sheet: now the phone's own dialog, and the phone registers if she allows. */
export async function acceptPushAsk(): Promise<boolean> {
  if (web.webPushMode() === "available") {
    try { return (await web.requestWebPermission()) ? await registerWebToken() : false; } catch { return false; }
  }
  const N = await notifications();
  if (!N) return false;
  try {
    const asked = await N.requestPermissionsAsync();
    return asked.granted ? await registerToken(N) : false;
  } catch { return false; }
}

/** What the phone itself allows: Settings says so when notifications are off there. */
export async function phonePermission(): Promise<"granted" | "denied" | "undetermined" | "unavailable"> {
  if (web.webPushMode() === "available") {
    try { return web.webPermission(); } catch { return "unavailable"; }
  }
  const N = await notifications();
  if (!N) return "unavailable";
  try {
    const p = await N.getPermissionsAsync();
    return p.granted ? "granted" : p.canAskAgain ? "undetermined" : "denied";
  } catch { return "unavailable"; }
}

/** The longest sign-out waits on the server before it goes on regardless. */
export const UNREGISTER_TIMEOUT_MS = 3000;

/**
 * On sign-out (while she is still signed in): this phone stops getting her notifications. Never throws, and never holds
 * sign-out longer than UNREGISTER_TIMEOUT_MS (a slow network must not trap her signed in).
 */
export async function unregisterPush(timeoutMs: number = UNREGISTER_TIMEOUT_MS): Promise<void> {
  const work = (async () => {
    try {
      const s = await storage();
      const token = await s.getItem(TOKEN_KEY);
      if (!token) return;
      await apiRequest("DELETE", "/api/v1/me/push/devices", { token });
      await s.removeItem(TOKEN_KEY);
    } catch { /* the server also drops a token Expo reports as gone */ }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

// ─── Taps ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const tapListeners = new Set<(t: Target) => void>();
let pendingTap: Target | null = null;

/** The screen a notification's data names, or null. */
export function tapTarget(data: unknown): Target | null {
  const t = (data as { target?: { screen?: unknown; id?: unknown; messageId?: unknown } } | null)?.target;
  if (!t || typeof t.screen !== "string" || !/^[a-z-]{1,40}$/.test(t.screen)) return null;
  const messageId = typeof t.messageId === "string" && /^[0-9a-f-]{36}$/i.test(t.messageId) ? t.messageId : null;
  return { screen: t.screen, ...(typeof t.id === "string" ? { id: t.id } : {}), ...(messageId ? { messageId } : {}) };
}

function deliverTap(data: unknown): void {
  const t = tapTarget(data);
  if (!t) return;
  if (tapListeners.size) tapListeners.forEach((fn) => fn(t));
  else pendingTap = t;
}

/** The tabs listen here; a tap that launched the app (before they were up) is delivered on subscribe. */
export function onPushTap(fn: (t: Target) => void): () => void {
  tapListeners.add(fn);
  if (pendingTap) { const t = pendingTap; pendingTap = null; setTimeout(() => fn(t), 0); }
  return () => { tapListeners.delete(fn); };
}

/** Tests only. */
export function __resetPush(): void { setUp = false; pendingTap = null; tapListeners.clear(); askHost = null; }
