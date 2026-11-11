/**
 * push.web.test — browser notifications in the dev web build (EXPO_PUBLIC_WEB_V2 + EXPO_PUBLIC_FIREBASE_VAPID_KEY), with
 * lib/webPush (the browser + Firebase Cloud Messaging) and the API MOCKED — no browser permission, no FCM, no server:
 *   - mode off (production web, or no key): every call is today's quiet no-op — nothing registered, nothing asked
 *   - allowed: this browser's FCM token goes to POST /me/push/devices with platform "web"; never asks
 *   - the ask: Nomila's sheet first, never on a cold launch, once; the browser's dialog only after "Turn on"
 *   - iPhone Safari tab: the sheet shows the Home Screen hint (pushAskHint) and the browser is never asked
 *   - a tap (service-worker message or ?pushTarget=) opens the screen it names
 */
const web = {
  mode: "off" as "off" | "needs_home_screen" | "available",
  permission: "undetermined" as "granted" | "denied" | "undetermined",
  token: "fcm-token-abc",
  requestWebPermission: jest.fn(async () => true),
  tapDeliver: null as ((d: unknown) => void) | null,
};
jest.mock("./webPush", () => ({
  webPushMode: () => web.mode,
  webPermission: () => web.permission,
  requestWebPermission: () => web.requestWebPermission(),
  webPushToken: async () => web.token,
  listenWebPushTaps: (deliver: (d: unknown) => void) => { web.tapDeliver = deliver; return () => undefined; },
}));
jest.mock("expo-notifications", () => { throw new Error("the native module must never load on web"); });
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
const apiRequest = jest.fn(async (..._a: unknown[]) => ({ ok: true, json: async () => ({}) }));
jest.mock("./query-client", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import {
  __resetPush, acceptPushAsk, askForPushOnce, COLD_LAUNCH_MS, onPushTap, phonePermission, pushAskHint, registerPushIfAllowed,
  setPushAskHost, setUpPush,
} from "./push";

const later = Date.now() + COLD_LAUNCH_MS + 1000;
const os = Platform.OS;

beforeEach(async () => {
  (Platform as any).OS = "web";
  __resetPush(); apiRequest.mockClear(); web.requestWebPermission.mockClear();
  web.mode = "available"; web.permission = "undetermined"; web.tapDeliver = null;
  await AsyncStorage.clear();
});
afterAll(() => { (Platform as any).OS = os; });

it("mode off (production web, or no VAPID key): nothing registered, nothing asked — today's no-op", async () => {
  web.mode = "off";
  web.permission = "granted";
  const asked: string[] = [];
  setPushAskHost((r) => asked.push(r));
  expect(await registerPushIfAllowed()).toBe(false);
  expect(await askForPushOnce("first_plan", later)).toBe(false);
  expect(await acceptPushAsk()).toBe(false);
  expect(await phonePermission()).toBe("unavailable");
  expect(pushAskHint()).toBe("ask");
  expect(asked).toEqual([]);
  expect(apiRequest).not.toHaveBeenCalled();
});

it("allowed: registers this browser's FCM token as platform web, without asking", async () => {
  expect(await registerPushIfAllowed()).toBe(false);
  expect(apiRequest).not.toHaveBeenCalled();
  web.permission = "granted";
  expect(await registerPushIfAllowed()).toBe(true);
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/push/devices", { token: "fcm-token-abc", platform: "web", timeZone: expect.any(String) });
  expect(web.requestWebPermission).not.toHaveBeenCalled();
  expect(await phonePermission()).toBe("granted");
});

it("the ask: the sheet first (never on a cold launch, once); the browser's dialog only after Turn on", async () => {
  const asked: string[] = [];
  setPushAskHost((r) => asked.push(r));
  expect(await askForPushOnce("first_deal", Date.now())).toBe(false); // cold launch
  expect(asked).toEqual([]);
  expect(await askForPushOnce("first_deal", later)).toBe(false);
  expect(asked).toEqual(["first_deal"]);
  expect(await askForPushOnce("first_plan", later)).toBe(false); // once
  expect(asked).toEqual(["first_deal"]);
  expect(web.requestWebPermission).not.toHaveBeenCalled();
  expect(await acceptPushAsk()).toBe(true);
  expect(web.requestWebPermission).toHaveBeenCalledTimes(1);
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/push/devices", expect.objectContaining({ platform: "web" }));
});

it("denied in the browser: never asked again by us", async () => {
  web.permission = "denied";
  const asked: string[] = [];
  setPushAskHost((r) => asked.push(r));
  expect(await askForPushOnce("first_plan", later)).toBe(false);
  expect(asked).toEqual([]);
  expect(await phonePermission()).toBe("denied");
});

it("iPhone Safari tab: the sheet shows the Home Screen hint and the browser is never asked", async () => {
  web.mode = "needs_home_screen";
  const asked: string[] = [];
  setPushAskHost((r) => asked.push(r));
  expect(pushAskHint()).toBe("home_screen");
  expect(await askForPushOnce("first_plan", later)).toBe(false);
  expect(asked).toEqual(["first_plan"]);
  expect(await acceptPushAsk()).toBe(false);
  expect(web.requestWebPermission).not.toHaveBeenCalled();
  expect(apiRequest).not.toHaveBeenCalled();
});

it("a tap from the service worker opens the screen it names", async () => {
  await setUpPush();
  const seen: unknown[] = [];
  const off = onPushTap((t) => seen.push(t));
  web.tapDeliver!({ target: { screen: "opportunities", id: "deal-1" } });
  web.tapDeliver!({ target: { screen: "Bad Screen!" } });
  expect(seen).toEqual([{ screen: "opportunities", id: "deal-1" }]);
  off();
});
