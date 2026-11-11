/**
 * NotificationSettings.test — Settings › Notifications: her choices from GET /me/push/preferences, one switch each; a
 * switch writes only what changed (PATCH); the kinds are off while all notifications are off; quiet hours in words;
 * brand names off by default; the phone's own "off" with Open Settings; an error with Try again. API and phone mocked.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const DEFAULTS = { enabled: true, planReady: true, brandReply: true, waiting: true, quietHours: true, quietStart: 1320, quietEnd: 480, showBrandNames: false };
let prefs = { ...DEFAULTS };
let failGet = false;
const apiRequest = jest.fn(async (method: string, _url: string, body?: Record<string, unknown>) => {
  if (method === "GET" && failGet) throw new Error("500: boom");
  if (method === "PATCH") prefs = { ...prefs, ...(body as object) };
  return { ok: true, json: async () => ({ ...prefs }) };
});
let phone: "granted" | "denied" | "undetermined" | "unavailable" = "granted";
jest.mock("../../lib/query-client", () => ({ apiRequest: (...a: unknown[]) => (apiRequest as any)(...a), getApiUrl: () => "http://test", getAuthHeaders: async () => ({}) }));
const acceptPushAsk = jest.fn(async () => { phone = "granted"; return true; });
jest.mock("../../lib/push", () => ({ phonePermission: async () => phone, acceptPushAsk: () => acceptPushAsk() }));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

import { NotificationSettings, NOTIFICATION_COPY } from "./NotificationSettings";
import { clockWords } from "../../hooks/use-push-preferences";

const ui = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } })}><NotificationSettings /></QueryClientProvider>);

beforeEach(() => { apiRequest.mockClear(); prefs = { ...DEFAULTS }; failGet = false; phone = "granted"; });

it("one switch per choice; quiet hours in words; brand names off by default", async () => {
  ui();
  await waitFor(() => expect(screen.getByTestId("push-preferences")).toBeTruthy());
  for (const k of ["enabled", "planReady", "brandReply", "waiting", "quietHours"]) expect(screen.getByTestId(`push-pref-${k}`).props.value).toBe(true);
  expect(screen.getByTestId("push-pref-showBrandNames").props.value).toBe(false);
  expect(screen.getByText(NOTIFICATION_COPY.showBrandNames.title)).toBeTruthy();
  expect(screen.getByText(NOTIFICATION_COPY.quietHours.sub("10pm", "8am"))).toBeTruthy();
  expect(screen.queryByTestId("push-phone-off")).toBeNull();
});

it("a switch writes only what changed; with all off, the kinds are off too", async () => {
  ui();
  await waitFor(() => expect(screen.getByTestId("push-preferences")).toBeTruthy());
  await act(async () => { fireEvent(screen.getByTestId("push-pref-showBrandNames"), "valueChange", true); });
  expect(apiRequest).toHaveBeenCalledWith("PATCH", "/api/v1/me/push/preferences", { showBrandNames: true });
  await act(async () => { fireEvent(screen.getByTestId("push-pref-enabled"), "valueChange", false); });
  await waitFor(() => expect(screen.getByTestId("push-pref-planReady").props.disabled).toBe(true));
});

it("the phone's own notifications off: it says so, and Open Settings opens the phone's settings", async () => {
  phone = "denied";
  const open = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined as never);
  ui();
  await waitFor(() => expect(screen.getByTestId("push-phone-off")).toBeTruthy());
  expect(screen.getByText(NOTIFICATION_COPY.phoneOff.title)).toBeTruthy();
  fireEvent.press(screen.getByTestId("push-open-settings"));
  expect(open).toHaveBeenCalled();
});

it("not asked yet (she tapped Not now on the sheet): Turn on phone notifications asks the phone, then the row goes", async () => {
  phone = "undetermined";
  acceptPushAsk.mockClear();
  ui();
  await waitFor(() => expect(screen.getByTestId("push-turn-on")).toBeTruthy());
  expect(screen.getByText(NOTIFICATION_COPY.turnOn.title)).toBeTruthy();
  expect(screen.queryByTestId("push-phone-off")).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId("push-turn-on")); });
  expect(acceptPushAsk).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByTestId("push-turn-on")).toBeNull());
});

it("the choices could not be read: a line and Try again", async () => {
  failGet = true;
  ui();
  await waitFor(() => expect(screen.getByTestId("push-preferences-error")).toBeTruthy());
  expect(screen.getByText(NOTIFICATION_COPY.error)).toBeTruthy();
  failGet = false;
  await act(async () => { fireEvent.press(screen.getByTestId("push-preferences-retry")); });
  await waitFor(() => expect(screen.getByTestId("push-preferences")).toBeTruthy());
});

it("clock words", () => {
  expect([clockWords(1320), clockWords(480), clockWords(0), clockWords(720), clockWords(1350)]).toEqual(["10pm", "8am", "12am", "12pm", "10:30pm"]);
});
