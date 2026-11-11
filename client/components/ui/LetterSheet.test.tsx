/**
 * LetterSheet.test — the white sheet over a deck's foot.
 *
 *   head     a recommendation letter opens with the date and has NO title; a brand letter is headed "<Brand> and you";
 *            the head is a header for assistive tech
 *   overlap  the sheet rises over the deck by Bold.deck.overlap (24) with corner 6 on the top corners only
 *   blocks   LetterBlock: a heading with an optional caption; `row` lays the children in a row; onPress makes it a button
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { StyleSheet, Text } from "react-native";
import { LetterBlock, LetterSheet } from "./LetterSheet";
import { Bold } from "../../constants/theme";

describe("LetterSheet", () => {
  it("a recommendation letter: the date first, no title, a header for assistive tech; it overlaps the deck by 24 with the card radius on the top corners", () => {
    render(<LetterSheet meta="Suggested 27 Sep 2026"><Text>The proposal.</Text></LetterSheet>);
    expect(screen.queryByTestId("letter-title")).toBeNull();
    expect(screen.getByTestId("letter-meta").props.children).toBe("Suggested 27 Sep 2026");
    expect(screen.getByTestId("letter-head").props.accessibilityRole).toBe("header");
    expect(screen.getByText("The proposal.")).toBeTruthy();
    const s = StyleSheet.flatten(screen.getByTestId("letter").props.style);
    expect(s.marginTop).toBe(-Bold.deck.overlap);
    expect(s.borderTopLeftRadius).toBe(Bold.radius.card);
    expect(s.borderTopRightRadius).toBe(Bold.radius.card);
    expect(s.borderBottomLeftRadius).toBeUndefined();
    expect(s.backgroundColor).toBe(Bold.paper);
  });

  it("a brand letter is headed '<Brand> and you'", () => {
    render(<LetterSheet title="gorjana and you" meta="What Nomila knows, and where each fact came from" />);
    expect(screen.getByTestId("letter-title").props.children).toBe("gorjana and you");
    expect(screen.getByText("What Nomila knows, and where each fact came from")).toBeTruthy();
  });

  it("LetterBlock: heading + caption; a row block; a pressable block is a button", () => {
    const onPress = jest.fn();
    render(
      <LetterSheet>
        <LetterBlock title="Why Nomila thinks this" meta="3 sources"><Text>a</Text></LetterBlock>
        <LetterBlock row onPress={onPress} accessibilityLabel="Advances your Impact goal" testID="advances"><Text>b</Text></LetterBlock>
      </LetterSheet>,
    );
    expect(screen.getByText("Why Nomila thinks this")).toBeTruthy();
    expect(screen.getByText("3 sources")).toBeTruthy();
    expect(screen.getByTestId("advances").props.accessibilityRole).toBe("button");
    fireEvent.press(screen.getByTestId("advances"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
