/**
 * Deck.test — the swipeable image deck (DESIGN.md "Density: collapsed cards, decks and letters").
 *
 *   counter    "1 / N" only when there are two or more pages; one page is a plain hero with no counter and no swipe
 *   pages      an image page draws its image; a page without one draws its fallback, else the blank ground; children ride
 *              over the page's foot
 *   tap        a tap on a page calls onPagePress (the screen scrolls to the letter); the counter follows the swipe
 *   a11y       the counter is a polite live region reading "Page n of N"; pages are labelled in order
 *   parts      DeckIdentity puts the name and category on ONE line; DeckPanel carries its eyebrow label; DeckChip
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Text, View } from "react-native";
import { Deck, DeckChip, DeckIdentity, DeckPanel } from "./Deck";

jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});

const page = (key: string, image: string | null, children?: React.ReactNode) => ({ key, image, children });

describe("Deck", () => {
  it("one page: a plain hero — no counter, no swipe", () => {
    render(<Deck pages={[page("a", "https://img.example/a.jpg", <Text>Over the foot</Text>)]} />);
    expect(screen.queryByTestId("deck-counter")).toBeNull();
    expect(screen.getByTestId("deck-image-1").props.source.uri).toBe("https://img.example/a.jpg");
    expect(screen.getByText("Over the foot")).toBeTruthy();
    expect(screen.UNSAFE_getByType(require("react-native").FlatList).props.scrollEnabled).toBe(false);
  });

  it("two or more pages: the counter reads 1 / N and follows the swipe; the live region says Page n of N", () => {
    render(<Deck pages={[page("a", "https://img.example/a.jpg"), page("b", null), page("c", "https://img.example/c.jpg")]} />);
    expect(screen.getByTestId("deck-counter")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByTestId("deck-counter").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByTestId("deck-counter").props.accessibilityLabel).toBe("Page 1 of 3");
    expect(screen.getByTestId("deck-page-2").props.accessibilityLabel).toBe("Page 2 of 3");
    // a page without an image and without a fallback: the blank ground, never a tint
    expect(screen.getByTestId("deck-blank-2")).toBeTruthy();
    const list = screen.UNSAFE_getByType(require("react-native").FlatList);
    expect(list.props.scrollEnabled).toBe(true);
    const width = require("react-native").Dimensions.get("window").width;
    fireEvent(list, "momentumScrollEnd", { nativeEvent: { contentOffset: { x: width * 2 } } });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(screen.getByTestId("deck-counter").props.accessibilityLabel).toBe("Page 3 of 3");
  });

  it("a page without an image draws its fallback; a tap on any page calls onPagePress", () => {
    const onPagePress = jest.fn();
    render(<Deck pages={[page("a", "https://img.example/a.jpg"), { key: "b", image: null, fallback: <View testID="the-fallback" /> }]} onPagePress={onPagePress} />);
    expect(screen.getByTestId("the-fallback")).toBeTruthy();
    expect(screen.queryByTestId("deck-blank-2")).toBeNull();
    fireEvent.press(screen.getByTestId("deck-page-2"));
    expect(onPagePress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("deck-page-1").props.accessibilityRole).toBe("button");
  });

  it("the top bar rides over the deck", () => {
    render(<Deck pages={[page("a", null)]} topBar={<Text>‹ PLAN</Text>} />);
    expect(screen.getByText("‹ PLAN")).toBeTruthy();
  });

  it("DeckIdentity · DeckPanel · DeckChip", () => {
    render(
      <View>
        <DeckIdentity name="gorjana" category="Luxury Goods" logo={<View testID="the-logo" />} />
        <DeckPanel label="Their audience"><DeckChip>tennis</DeckChip><DeckChip blue>soccer</DeckChip></DeckPanel>
      </View>,
    );
    expect(screen.getByTestId("the-logo")).toBeTruthy();
    expect(screen.getByText("gorjana", { exact: false })).toBeTruthy();
    expect(screen.getByText(" · Luxury Goods")).toBeTruthy();
    expect(screen.getByText("Their audience")).toBeTruthy();
    expect(screen.getByText("tennis")).toBeTruthy();
    expect(screen.getByTestId("deck-chip-blue")).toBeTruthy();
  });
});
