/**
 * FrontDoorPage.test — the approved Front Door page (promoted from PR #900), from a model built off her card's content.
 *
 *   visitor     the heart (one like, tap again to take it back, never a count); no metrics rail
 *   owner       the metrics rail (views · likes · requests · bookings · shop), no heart; the rail waits for its numbers
 *   doors       only the hero swipes: the door grid is never inside the swiping row, and stays after a swipe; with
 *               `pinnedDoors` it sits outside the page's vertical scroll, so it is always on screen
 *   taps        a story tile swipes to its chapter; every other door goes to onDoor; Mila to onAsk
 *   images      a chapter with an atmosphere image draws it with its credit line; without one, the category default
 *   switch      "Verified by Nomila" stays off (SHOW_VERIFIED) even for a verified snapshot
 *   copy        Partner · Book · Picks · Create (an older "Shop" label reads "Picks"); "you"-free visitor copy
 */
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { FrontDoorPage } from "./FrontDoorPage";
import { frontDoorModel } from "../../lib/frontDoorLogic";
import { content } from "../../screens/me/__fixtures__/publicCard";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub, G: Stub };
});
jest.mock("../mila/MilaAvatar", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { MilaAvatar: () => React.createElement(View, { testID: "mila-loop" }) };
});

const model = (over = {}) => frontDoorModel(content(over), { handle: "sam-lee", heroPhoto: "https://img.example/her.jpg" });
const METRICS = { views: 612, likes: 48, requests: 3, bookings: 1, shop: 12400 };

describe("visitor view", () => {
  it("the heart toggles a like and back; no count and no rail", () => {
    const onLike = jest.fn();
    render(<FrontDoorPage model={model()} onLike={onLike} />);
    const heart = screen.getByTestId("front-door-like");
    expect(heart.props.accessibilityLabel).toBe("Like this page");
    fireEvent.press(heart);
    expect(onLike).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("front-door-like").props.accessibilityLabel).toBe("You like this page");
    fireEvent.press(screen.getByTestId("front-door-like"));
    expect(onLike).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("front-door-metrics")).toBeNull();
    expect(screen.queryByText(/likes?$/i)).toBeNull();
  });

  it("Verified by Nomila stays off by the switch, even for a verified snapshot", () => {
    render(<FrontDoorPage model={model()} verified />);
    expect(screen.queryByText("Verified by Nomila")).toBeNull();
  });
});

describe("owner view", () => {
  it("the metrics rail, last 30 days; no heart", () => {
    render(<FrontDoorPage model={model()} owner metrics={METRICS} />);
    const rail = screen.getByTestId("front-door-metrics");
    expect(rail.props.accessibilityLabel).toBe("Last 30 days: 612 views, 48 likes, 3 requests, 1 bookings, 12400 shop");
    expect(within(rail).getByText("612")).toBeTruthy();
    expect(within(rail).getByText("12K")).toBeTruthy();
    expect(screen.queryByTestId("front-door-like")).toBeNull();
  });

  it("waits for the numbers rather than show zeros", () => {
    render(<FrontDoorPage model={model()} owner metrics={null} />);
    expect(screen.queryByTestId("front-door-metrics")).toBeNull();
    expect(screen.queryByTestId("front-door-like")).toBeNull();
  });
});

describe("only the hero swipes; the doors stay", () => {
  it("the grid is outside the swiping row, and still there after a swipe", () => {
    render(<FrontDoorPage model={model()} width={390} />);
    const row = screen.getByTestId("front-door-cards");
    expect(within(row).queryByTestId("front-door-grid")).toBeNull();
    fireEvent(row, "momentumScrollEnd", { nativeEvent: { contentOffset: { x: 390, y: 0 } } });
    expect(screen.getByTestId("front-door-counter").props.children).toBe("Story · 2 of 2");
    expect(screen.getByTestId("front-door-grid")).toBeTruthy();
    for (const k of ["partner", "story", "shop", "create"]) expect(screen.getByTestId(`front-door-tile-${k}`)).toBeTruthy();
  });

  it("pinned: the grid sits outside the page's vertical scroll", () => {
    render(<FrontDoorPage model={model()} pinnedDoors />);
    const scroll = screen.getByTestId("front-door-scroll");
    expect(within(scroll).getByTestId("front-door-cards")).toBeTruthy();
    expect(within(scroll).queryByTestId("front-door-grid")).toBeNull();
    expect(screen.getByTestId("front-door-grid")).toBeTruthy();
  });
});

describe("taps", () => {
  it("a story tile swipes to its chapter; the other doors and Mila go to their handlers", () => {
    const onDoor = jest.fn(); const onAsk = jest.fn();
    render(<FrontDoorPage model={model()} onDoor={onDoor} onAsk={onAsk} />);
    fireEvent.press(screen.getByTestId("front-door-tile-story"));
    expect(screen.getByTestId("front-door-counter").props.children).toBe("Story · 2 of 2");
    expect(onDoor).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("front-door-tile-partner"));
    expect(onDoor).toHaveBeenCalledWith(expect.objectContaining({ key: "partner", label: "Partner" }));
    fireEvent.press(screen.getByTestId("front-door-mila"));
    expect(onAsk).toHaveBeenCalled();
  });

  it("the doors read Partner · Picks · Create (an older Shop label reads Picks); Mila only when Ask Mila is on", () => {
    const { rerender } = render(<FrontDoorPage model={model()} />);
    expect(screen.getByTestId("front-door-tile-shop").props.accessibilityLabel).toBe("Picks. Sam's picks");
    rerender(<FrontDoorPage model={model({ doors: { partner: true, book: false, shop: true, create: true, ask_mila: false } })} />);
    expect(screen.queryByTestId("front-door-mila")).toBeNull();
  });
});

describe("images", () => {
  it("a chapter on atmosphere carries its credit line; without one it draws the category default", () => {
    const { rerender } = render(<FrontDoorPage model={model()} chapterImages={{ story: { url: "https://img.example/a.jpg", credit: "Photo: Example on Pixabay" } }} />);
    const ch = within(screen.getByTestId("front-door-chapter-story"));
    expect(ch.getByText("Photo: Example on Pixabay")).toBeTruthy();
    rerender(<FrontDoorPage model={model()} />);
    expect(within(screen.getByTestId("front-door-chapter-story")).getByTestId("front-door-atmosphere-story-default")).toBeTruthy();
  });

  it("Highlights is on her own photo; none → the blank ground", () => {
    render(<FrontDoorPage model={{ ...model(), heroPhoto: null }} />);
    expect(within(screen.getByTestId("front-door-highlights")).getByText("Sam Lee")).toBeTruthy();
  });
});
