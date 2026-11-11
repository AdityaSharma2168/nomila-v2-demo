/**
 * PushAskSheet.test — Nomila's own ask comes first: nothing shows until lib/push asks; "Turn on" closes it and only then
 * opens the phone's dialog (acceptPushAsk); "Not now" closes it and asks nothing. lib/push is mocked (no device).
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

let host: ((r: "first_plan" | "first_deal") => void) | null = null;
const acceptPushAsk = jest.fn(async () => true);
let hint: "ask" | "home_screen" = "ask";
jest.mock("../../lib/push", () => ({ setPushAskHost: (fn: typeof host) => { host = fn; }, acceptPushAsk: () => acceptPushAsk(), pushAskHint: () => hint }));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

import { PushAskSheet, PUSH_ASK_COPY } from "./PushAskSheet";

beforeEach(() => { acceptPushAsk.mockClear(); hint = "ask"; });

it("shows only when asked; Turn on closes it, then opens the phone's dialog", async () => {
  render(<PushAskSheet />);
  expect(screen.queryByTestId("push-ask-sheet")).toBeNull();
  act(() => host!("first_plan"));
  expect(screen.getByText(PUSH_ASK_COPY.title)).toBeTruthy();
  expect(screen.getByText(PUSH_ASK_COPY.lead.first_plan)).toBeTruthy();
  expect(acceptPushAsk).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByTestId("push-ask-yes")); });
  expect(acceptPushAsk).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("push-ask-sheet")).toBeNull();
});

it("Not now closes it and asks the phone nothing", () => {
  render(<PushAskSheet />);
  act(() => host!("first_deal"));
  expect(screen.getByText(PUSH_ASK_COPY.lead.first_deal)).toBeTruthy();
  fireEvent.press(screen.getByTestId("push-ask-no"));
  expect(screen.queryByTestId("push-ask-sheet")).toBeNull();
  expect(acceptPushAsk).not.toHaveBeenCalled();
});

it("dev web build on an iPhone Safari tab: a one-line Home Screen hint instead of the ask; Got it asks nothing", () => {
  hint = "home_screen";
  render(<PushAskSheet />);
  act(() => host!("first_plan"));
  expect(screen.getByTestId("push-ask-home-screen")).toBeTruthy();
  expect(screen.queryByTestId("push-ask-yes")).toBeNull();
  fireEvent.press(screen.getByTestId("push-ask-got-it"));
  expect(screen.queryByTestId("push-ask-sheet")).toBeNull();
  expect(acceptPushAsk).not.toHaveBeenCalled();
});
