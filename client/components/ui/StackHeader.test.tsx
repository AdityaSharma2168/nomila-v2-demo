/**
 * StackHeader (bold) — the ONE pushed-screen bar (DESIGN.md §11 Shell): ‹ and the PARENT's name in the backLabel role,
 * 52 high, 16 gutter; ink on white, white (`dark`) riding over a deck or a photo. Every look-B pushed screen draws its
 * back control with it — including over a deck (Recommendation, Priority, Brand, the opportunity detail).
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { StackHeader } from "./StackHeader";
import { Bold, BoldType } from "../../constants/theme";

const goBack = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name, color }: { name: string; color: string }) => React.createElement(Text, { testID: `icon-${name}`, style: { color } }, name) };
});
const press = jest.fn();
jest.mock("../../lib/haptics", () => ({ haptics: { press: () => press(), tap: () => {} } }));

const flat = (s: any) => StyleSheet.flatten(s) ?? {};

it("bold: 52 high, 16 gutter, the parent's name in the backLabel role, ink on white; back goes back", () => {
  render(<StackHeader title="Opportunities" bold />);
  expect(flat(screen.getByTestId("stack-header").props.style)).toMatchObject({ height: 52, paddingHorizontal: Bold.gutter });
  const label = screen.getByText("Opportunities");
  expect(flat(label.props.style)).toMatchObject({ fontSize: BoldType.backLabel.fontSize, textTransform: "uppercase", color: Bold.ink });
  expect(flat(screen.getByTestId("icon-chevron-left").props.style).color).toBe(Bold.ink);
  fireEvent.press(screen.getByTestId("stack-header-back"));
  expect(goBack).toHaveBeenCalled();
  expect(press).toHaveBeenCalled();
});

it("bold + dark: the same bar in white, for a deck or a photo; onBack overrides goBack", () => {
  const onBack = jest.fn();
  goBack.mockClear();
  render(<StackHeader title="Your plan" bold dark onBack={onBack} />);
  expect(flat(screen.getByText("Your plan").props.style).color).toBe(Bold.onDark);
  expect(flat(screen.getByTestId("icon-chevron-left").props.style).color).toBe(Bold.onDark);
  fireEvent.press(screen.getByTestId("stack-header-back"));
  expect(onBack).toHaveBeenCalled();
  expect(goBack).not.toHaveBeenCalled();
});
