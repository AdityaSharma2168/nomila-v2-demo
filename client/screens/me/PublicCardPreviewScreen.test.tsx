/**
 * PublicCardPreviewScreen.test — Preview as a visitor, over the REAL hooks; only lib/publicCardApi and lib/meMemoryApi
 * (the atmosphere picker, the metrics) are stubbed. The page is the approved Front Door design (FrontDoorPage).
 *
 *   V1 loading, a failed load with Try again
 *   V2 the visitor's page from GET /preview: Highlights (her name, her quote, her identity line; "Verified by Nomila" off
 *      by the switch), "Highlights · 1 of N", the four doors in reading order with Mila at the centre ("Ask Mila"), the
 *      heart (a visitor's view: no metrics rail, never a count), "Follow [First]"
 *   V3 a story tile goes to its card and the doors stay where they are; a door tile and Mila explain what they do
 *   V4 a NEW athlete: just Highlights and the four tiles; the footer gives the blockedReason and Review
 *   V6 Publish from the preview opens the publish sheet (her tap there publishes)
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { PublicCardPreviewScreen } from "./PublicCardPreviewScreen";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { CONTENT_DRAFT, NEW_DRAFT, NEW_PREVIEW, PREVIEW } from "./__fixtures__/publicCard";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub, G: Stub };
});
jest.mock("../../components/mila/MilaAvatar", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { MilaAvatar: () => React.createElement(View, { testID: "mila-loop" }) };
});
const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../hooks/use-me-knowledge", () => ({ useMePool: () => [] }));
const api = {
  getDraft: jest.fn(), saveDecisions: jest.fn(), getPreview: jest.fn(), publish: jest.fn(), unpublish: jest.fn(),
  setSwitches: jest.fn(), setHandle: jest.fn(), publicBase: () => "https://api.example.test",
};
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return api; } }));
const mem = { pickAtmosphere: jest.fn(async () => { throw new Error("404: {}"); }), getPageMetrics: jest.fn(async () => ({ windowDays: 30, since: "2026-09-11", views: 1, likes: 2, requests: 0, bookings: 0, shop: 0 })) };
jest.mock("../../lib/meMemoryApi", () => ({ get meMemoryApi() { return mem; } }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  api.getDraft.mockResolvedValue(CONTENT_DRAFT);
  api.getPreview.mockResolvedValue(PREVIEW);
});
const mount = () => renderWithClient(<PublicCardPreviewScreen />);

describe("V1 loading and errors", () => {
  it("a failed load says so; Try again loads", async () => {
    api.getPreview.mockRejectedValueOnce(new Error("500: {}"));
    mount();
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    expect(await screen.findByText("Your public card didn't load.")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByTestId("front-door-visitor")).toBeTruthy();
  });
});

describe("V2 the visitor's page", () => {
  it("draws Highlights, the swipe cards, the doors with Mila, the heart and the footer", async () => {
    mount();
    const hl = within(await screen.findByTestId("front-door-highlights"));
    expect(hl.queryByText("Verified by Nomila")).toBeNull(); // the switch is off
    expect(hl.getByText("Sam Lee")).toBeTruthy();
    expect(hl.getByText("“Show up early.”")).toBeTruthy();
    expect(hl.getByText("Builder of teams")).toBeTruthy();
    expect(within(screen.getByTestId("front-door-chapter-story")).getByText("Started at nine.")).toBeTruthy();
    expect(screen.getByTestId("front-door-counter").props.children).toBe("Highlights · 1 of 2");
    expect(["partner", "story", "shop", "create"].map((k) => screen.getByTestId(`front-door-tile-${k}`).props.accessibilityLabel)).toEqual([
      "Partner. Work with Sam", "Sam's story. See Sam's story", "Picks. Sam's picks", "Create. Coming soon",
    ]);
    expect(screen.getByLabelText("Ask Mila")).toBeTruthy();
    expect(screen.getByTestId("mila-loop")).toBeTruthy();
    expect(screen.getByTestId("front-door-like")).toBeTruthy();
    expect(screen.queryByTestId("front-door-metrics")).toBeNull();
    expect(screen.getByText("Follow Sam")).toBeTruthy();
    expect(screen.getByText("instagram @samlee")).toBeTruthy();
  });
});

describe("V3 taps", () => {
  it("a story tile goes to its card and the doors stay put; a door and Mila explain themselves", async () => {
    mount();
    fireEvent.press(await screen.findByTestId("front-door-tile-story"));
    expect(screen.getByTestId("front-door-counter").props.children).toBe("Story · 2 of 2");
    // the doors are not inside the swiping row, and are still there after the swipe
    expect(within(screen.getByTestId("front-door-cards")).queryByTestId("front-door-grid")).toBeNull();
    expect(screen.getByTestId("front-door-grid")).toBeTruthy();
    fireEvent.press(screen.getByTestId("front-door-tile-partner"));
    expect(screen.getByTestId("preview-door-text").props.children).toMatch(/^On your live card, Partner opens a chat with Mila/);
    fireEvent.press(screen.getAllByLabelText("Close")[0]);
    fireEvent.press(screen.getByTestId("front-door-tile-create"));
    expect(screen.getByTestId("preview-door-text").props.children).toBe('On your live card, Create says "Create with Sam is coming soon". Nothing is collected.');
    fireEvent.press(screen.getAllByLabelText("Close")[0]);
    fireEvent.press(screen.getByTestId("front-door-mila"));
    expect(screen.getByTestId("preview-door-text").props.children).toMatch(/answers questions about Sam from your published card only/);
    expect(api.publish).not.toHaveBeenCalled();
  });
});

describe("V4 a new athlete", () => {
  it("Highlights alone, the four tiles, and why it can't publish yet", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.getPreview.mockResolvedValue(NEW_PREVIEW);
    mount();
    expect(await screen.findByTestId("front-door-highlights")).toBeTruthy();
    expect(screen.getByTestId("front-door-counter").props.children).toBe("Highlights · 1 of 1");
    expect(screen.queryByText("Verified by Nomila")).toBeNull();
    for (const k of ["partner", "story", "shop", "create"]) expect(screen.getByTestId(`front-door-tile-${k}`)).toBeTruthy();
    expect((await screen.findByTestId("preview-blocked")).props.children).toBe("Add a chapter or turn on a door to publish");
    fireEvent.press(screen.getByTestId("preview-review"));
    expect(navigate).toHaveBeenCalledWith("PublicCardReview");
  });
});

describe("V6 publish from the preview", () => {
  it("opens the publish sheet; nothing is published until her tap there", async () => {
    mount();
    await act(async () => { fireEvent.press(await screen.findByTestId("preview-publish")); });
    expect(await screen.findByTestId("publish-sheet")).toBeTruthy();
    expect(api.publish).not.toHaveBeenCalled();
  });
});
