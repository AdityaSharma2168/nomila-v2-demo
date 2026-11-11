/**
 * Accordion.test — the collapsed section card that opens in place.
 *
 *   closed     head + ONE summary line + the count; the body is not rendered
 *   one open   in a group, opening a second closes the first; the group reports the opening card's id
 *   a11y       the head is a button with `expanded`, labelled "<title>, N items"; the open head carries the black rule
 *   motion     the expand configures a layout animation; with reduced motion a 120 ms fade
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo, LayoutAnimation, StyleSheet, Text } from "react-native";
import { Accordion, AccordionGroup, animateExpand } from "./Accordion";
import { Bold } from "../../constants/theme";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});

const two = (onOpen?: (id: string, y: number) => void) => (
  <AccordionGroup onOpen={onOpen}>
    <Accordion id="a" title="What defines you" summary="Historic representation · Academic rigor" count={3}><Text>body a</Text></Accordion>
    <Accordion id="b" title="Your story so far" summary="Mt. Lebanon · Stanford" count={4}><Text>body b</Text></Accordion>
  </AccordionGroup>
);

describe("Accordion", () => {
  it("closed: the head, one summary line and the count; no body; a button that is not expanded", () => {
    render(two());
    expect(screen.getByText("What defines you")).toBeTruthy();
    expect(screen.getByText("Historic representation · Academic rigor")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("body a")).toBeNull();
    const head = screen.getByTestId("accordion-head-a");
    expect(head.props.accessibilityRole).toBe("button");
    expect(head.props.accessibilityState).toEqual({ expanded: false });
    expect(head.props.accessibilityLabel).toBe("What defines you, 3 items");
    expect(StyleSheet.flatten(head.props.style).borderBottomWidth).toBeUndefined();
  });

  it("one open at a time: opening the second closes the first; the open head carries the 2px black rule; the group reports the id", () => {
    const onOpen = jest.fn();
    render(two(onOpen));
    fireEvent.press(screen.getByTestId("accordion-head-a"));
    expect(screen.getByText("body a")).toBeTruthy();
    expect(screen.getByTestId("accordion-head-a").props.accessibilityState).toEqual({ expanded: true });
    expect(StyleSheet.flatten(screen.getByTestId("accordion-head-a").props.style)).toMatchObject({ borderBottomWidth: 2, borderBottomColor: Bold.ink });
    expect(onOpen).toHaveBeenLastCalledWith("a", expect.any(Number));
    fireEvent.press(screen.getByTestId("accordion-head-b"));
    expect(screen.queryByText("body a")).toBeNull();
    expect(screen.getByText("body b")).toBeTruthy();
    expect(screen.getByTestId("accordion-head-a").props.accessibilityState).toEqual({ expanded: false });
    // tapping the open one closes it: nothing open
    fireEvent.press(screen.getByTestId("accordion-head-b"));
    expect(screen.queryByText("body b")).toBeNull();
  });

  it("outside a group a card opens on its own", () => {
    render(<Accordion id="solo" title="What you stand for"><Text>solo body</Text></Accordion>);
    fireEvent.press(screen.getByTestId("accordion-head-solo"));
    expect(screen.getByText("solo body")).toBeTruthy();
    expect(screen.getByTestId("accordion-head-solo").props.accessibilityLabel).toBe("What you stand for");
  });

  it("the expand is a 250 ms spring, a 120 ms fade under reduced motion", () => {
    const spy = jest.spyOn(LayoutAnimation, "configureNext").mockImplementation(() => {});
    animateExpand(false);
    expect(spy.mock.calls[0][0]).toMatchObject({ duration: 250, update: { type: "spring" } });
    animateExpand(true);
    expect(spy.mock.calls[1][0]).toMatchObject({ duration: 120, update: { type: "linear" } });
    spy.mockRestore();
    expect(typeof AccessibilityInfo.isReduceMotionEnabled).toBe("function");
  });
});
