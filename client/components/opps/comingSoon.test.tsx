/**
 * comingSoon.test — stage 1 (owner, 25 Oct 2026): the Business tab shows Bookings and Shop as "Coming soon" while they
 * are not live in the build: what each is, the chip, and nothing to tap (no set-up button, no Your picks link).
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { BookingsBoard, BookingsComingSoon, ShopComingSoon, BOOKINGS_SOON_COPY, SHOP_SOON_COPY } from "./BookingsBoard";
import type { BookingsSummary } from "../../../shared/meSummaries";

jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});

it("Bookings: the title, what bookings are and 'Coming soon'; no set-up button", () => {
  render(<BookingsComingSoon />);
  expect(screen.getByTestId("bookings-soon")).toBeTruthy();
  expect(screen.getByText(BOOKINGS_SOON_COPY.title)).toBeTruthy();
  expect(screen.getByText(BOOKINGS_SOON_COPY.body)).toBeTruthy();
  expect(screen.getByText("Coming soon")).toBeTruthy();
  expect(screen.queryByTestId("bookings-set-up")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

it("Shop: one quiet row with the line and 'Coming soon'; nothing to tap", () => {
  render(<ShopComingSoon />);
  expect(screen.getByTestId("opps-shop-soon")).toBeTruthy();
  expect(screen.getByText(SHOP_SOON_COPY.title)).toBeTruthy();
  expect(screen.getByText(SHOP_SOON_COPY.line)).toBeTruthy();
  expect(screen.getByText("Coming soon")).toBeTruthy();
  expect(screen.queryByText("Your picks")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

it("the board's Coming up: an open group's time is one row ('4 of 10 booked') that opens the group screen", () => {
  const line = { title: "Film room", format: "video_call", currency: "usd", startsAt: "2026-11-20T18:00:00Z", respondBy: null, createdAt: null };
  const summary: BookingsSummary = {
    version: "bookings-summary/0.1", published: true, publishedOffers: 1, requests: [],
    upcoming: [
      { ...line, id: "b1", status: "confirmed", priceCents: 45_000, audience: "open_group", slotId: "s1", spotsTaken: 4, capacity: 10 },
      { ...line, id: "b2", title: "1:1 call", status: "confirmed", priceCents: 15_000, audience: "one", slotId: null, spotsTaken: 1, capacity: 1 },
    ],
  };
  const onOpen = jest.fn(), onOpenGroup = jest.fn();
  render(<BookingsBoard summary={summary} onOpen={onOpen} onOpenGroup={onOpenGroup} />);
  expect(screen.getByText("4 of 10 booked")).toBeTruthy();
  expect(screen.queryByTestId("booking-upcoming-b1")).toBeNull();
  fireEvent.press(screen.getByTestId("booking-group-s1"));
  expect(onOpenGroup).toHaveBeenCalledWith("s1");
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId("booking-upcoming-b2"));
  expect(onOpen).toHaveBeenCalledWith("b2");
});
