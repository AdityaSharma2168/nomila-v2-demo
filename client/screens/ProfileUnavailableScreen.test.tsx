/**
 * ProfileUnavailableScreen.test — the "can't reach Nomila" state: its plain copy, Try again and Sign out wired to their
 * handlers, white type on the dark ground (no red).
 */
import React from "react";
import { StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { PROFILE_UNAVAILABLE_COPY, ProfileUnavailableScreen } from "./ProfileUnavailableScreen";
import { Bold } from "../constants/theme";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

it("says it can't reach Nomila and offers Try again and Sign out", () => {
  const onRetry = jest.fn(); const onSignOut = jest.fn();
  render(<ProfileUnavailableScreen onRetry={onRetry} onSignOut={onSignOut} />);
  expect(screen.getByText(PROFILE_UNAVAILABLE_COPY.title)).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByText(PROFILE_UNAVAILABLE_COPY.title).props.style).color).toBe(Bold.onDark);
  fireEvent.press(screen.getByTestId("profile-unavailable-retry"));
  fireEvent.press(screen.getByTestId("profile-unavailable-signout"));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onSignOut).toHaveBeenCalledTimes(1);
});
