/**
 * push.test — the phone's half of notifications, with expo-notifications and the API mocked (no device, no server):
 *   - set up: no banner/sound/badge in the foreground; Android's default and quiet channels
 *   - on sign-in, a phone registers ONLY if she already allowed notifications; it never asks
 *   - the one ask: never on a cold launch, once per phone, registers when she allows
 *   - sign-out removes this phone's token
 *   - a tap opens the screen the notification names; a tap that launched the app waits for the tabs
 */
const perms = { granted: false, canAskAgain: true };
const requestPermissionsAsync = jest.fn(async () => ({ granted: true, canAskAgain: true }));
let responseListener: ((r: unknown) => void) | null = null;
const handler: { current: any } = { current: null };
const channels: Array<[string, any]> = [];
jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3, LOW: 2 },
  setNotificationHandler: (h: unknown) => { handler.current = h; },
  setNotificationChannelAsync: async (id: string, c: unknown) => { channels.push([id, c]); },
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => { responseListener = fn; return { remove: () => {} }; },
  getLastNotificationResponseAsync: async () => null,
  getPermissionsAsync: async () => ({ ...perms }),
  requestPermissionsAsync: () => requestPermissionsAsync(),
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[abcdefgh12345]" }),
}), { virtual: false });
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: "proj-1" } } } } }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
const apiRequest = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
jest.mock("./query-client", () => ({ apiRequest: (...a: unknown[]) => (apiRequest as any)(...a) }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { __resetPush, acceptPushAsk, askForPushOnce, COLD_LAUNCH_MS, onPushTap, phonePermission, registerPushIfAllowed, setPushAskHost, setUpPush, tapTarget, unregisterPush } from "./push";

const later = Date.now() + COLD_LAUNCH_MS + 1000;

beforeEach(async () => {
  __resetPush(); apiRequest.mockClear(); requestPermissionsAsync.mockClear(); channels.length = 0;
  perms.granted = false; perms.canAskAgain = true;
  await AsyncStorage.clear();
});

it("set up: nothing pops while the app is open; Android gets the default and the quiet channel", async () => {
  (Platform as any).OS = "android";
  await setUpPush();
  expect(await handler.current.handleNotification()).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  expect(channels.map(([id, c]) => [id, c.importance])).toEqual([["default", 3], ["quiet", 2]]);
  (Platform as any).OS = "ios";
});

it("on sign-in: registers only when she already allowed notifications, and never asks", async () => {
  expect(await registerPushIfAllowed()).toBe(false);
  expect(apiRequest).not.toHaveBeenCalled();
  expect(requestPermissionsAsync).not.toHaveBeenCalled();
  perms.granted = true;
  expect(await registerPushIfAllowed()).toBe(true);
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/push/devices", { token: "ExponentPushToken[abcdefgh12345]", platform: "ios", timeZone: expect.any(String) });
});

it("the one ask: Nomila's sheet first, never on a cold launch, once per phone; the system dialog only after Turn on", async () => {
  const asked: string[] = [];
  // No sheet mounted: nothing is asked, and nothing is remembered as asked.
  expect(await askForPushOnce("first_plan", later)).toBe(false);
  setPushAskHost((r) => asked.push(r));
  expect(await askForPushOnce("first_plan", Date.now())).toBe(false);          // the screen the app launched on
  expect(asked).toEqual([]);
  expect(await askForPushOnce("first_plan", later)).toBe(false);
  expect(asked).toEqual(["first_plan"]);
  expect(requestPermissionsAsync).not.toHaveBeenCalled();                      // the sheet asks; the phone has not yet
  expect(await askForPushOnce("first_deal", later)).toBe(false);               // once per phone
  expect(asked).toEqual(["first_plan"]);
  // She taps "Turn on": the phone's dialog, then the phone registers.
  expect(await acceptPushAsk()).toBe(true);
  expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/push/devices", expect.objectContaining({ platform: "ios" }));
  // The phone says it may not ask again: no sheet.
  await AsyncStorage.clear(); perms.canAskAgain = false;
  expect(await askForPushOnce("first_deal", later)).toBe(false);
  expect(asked).toEqual(["first_plan"]);
  expect(await phonePermission()).toBe("denied");
  perms.granted = true;
  expect(await phonePermission()).toBe("granted");
});

it("sign-out never waits more than its timeout on a slow server", async () => {
  perms.granted = true;
  await registerPushIfAllowed();
  apiRequest.mockImplementationOnce(() => new Promise(() => {}) as any);       // the server never answers
  const t0 = Date.now();
  await unregisterPush(50);
  expect(Date.now() - t0).toBeLessThan(1000);
});

it("sign-out removes this phone's token", async () => {
  perms.granted = true;
  await registerPushIfAllowed();
  apiRequest.mockClear();
  await unregisterPush();
  expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/v1/me/push/devices", { token: "ExponentPushToken[abcdefgh12345]" });
  apiRequest.mockClear();
  await unregisterPush();                                                       // nothing left to remove
  expect(apiRequest).not.toHaveBeenCalled();
});

it("a tap opens the screen it names; one that launched the app waits for the tabs", async () => {
  expect(tapTarget({ target: { screen: "goals" } })).toEqual({ screen: "goals" });
  expect(tapTarget({ target: { screen: "javascript:alert(1)" } })).toBeNull();
  expect(tapTarget(null)).toBeNull();
  // A message Mila started: the chat AND the exact message (a malformed message id is dropped, the chat still opens).
  const conv = "11111111-1111-4111-8111-111111111111";
  const msg = "22222222-2222-4222-8222-222222222222";
  expect(tapTarget({ target: { screen: "mila", id: conv, messageId: msg } })).toEqual({ screen: "mila", id: conv, messageId: msg });
  expect(tapTarget({ target: { screen: "mila", id: conv, messageId: "<script>" } })).toEqual({ screen: "mila", id: conv });
  await setUpPush();
  const tap = (data: unknown) => responseListener!({ notification: { request: { content: { data } } } });
  tap({ kind: "plan_ready", target: { screen: "goals" } });                     // the tabs are not up yet
  const got: unknown[] = [];
  const off = onPushTap((t) => got.push(t));
  await new Promise((r) => setTimeout(r, 5));
  expect(got).toEqual([{ screen: "goals" }]);
  tap({ kind: "waiting", target: { screen: "mila" } });
  expect(got).toEqual([{ screen: "goals" }, { screen: "mila" }]);
  off();
});
