/**
 * PublicPageScreen.test — her public page full screen, her own view, over the REAL hooks; only lib/publicCardApi,
 * lib/meMemoryApi and the photo pool are stubbed.
 *
 *   page       the Front Door with the metrics rail (last 30 days), no heart; the doors pinned outside the page's scroll
 *   doors      in her own view a door explains what it does for a visitor; nothing opens or sends
 *   Edit       "What visitors can do": her switches (Ask Mila · Partner requests · Bookings · Picks · M.I.A. on your page),
 *              each a PATCH of that one switch; a door that can't work yet says why and can't be turned on; Review &
 *              publish goes to the existing review (publishing stays her tap there)
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { CONTENT_DRAFT, PREVIEW } from "./__fixtures__/publicCard";

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
let params: any = undefined;
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }), useRoute: () => ({ params }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../hooks/use-me-knowledge", () => ({ useMePool: () => [] }));
const card = {
  getDraft: jest.fn(async () => CONTENT_DRAFT), getPreview: jest.fn(async () => PREVIEW), saveDecisions: jest.fn(), publish: jest.fn(), unpublish: jest.fn(),
  setSwitches: jest.fn(async (p: any) => ({ switches: { ...CONTENT_DRAFT.card.switches, ...p }, removalVersion: null })), setHandle: jest.fn(),
  publicBase: () => "https://api.example.test",
};
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return card; } }));
const mem = {
  getPageMetrics: jest.fn(async () => ({ windowDays: 30, since: "2026-09-11", views: 612, likes: 48, requests: 3, bookings: 1, shop: 9 })),
  pickAtmosphere: jest.fn(async () => ({ images: [{ key: "chapter:story", kind: "image", imageId: "i1", url: "https://img.example/s.jpg", credit: "Photo: Example on Pixabay", source: "pixabay", sourceUrl: null }] })),
};
jest.mock("../../lib/meMemoryApi", () => ({ get meMemoryApi() { return mem; } }));

import { PublicPageScreen } from "./PublicPageScreen";

beforeEach(() => {
  jest.clearAllMocks();
  params = undefined;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});

describe("her page, her own view", () => {
  it("the rail, no heart, doors pinned, chapters on atmosphere with their credit", async () => {
    renderWithClient(<PublicPageScreen />);
    expect(await screen.findByTestId("front-door-owner")).toBeTruthy();
    const rail = await screen.findByTestId("front-door-metrics");
    expect(within(rail).getByText("612")).toBeTruthy();
    expect(screen.queryByTestId("front-door-like")).toBeNull();
    expect(within(screen.getByTestId("front-door-scroll")).queryByTestId("front-door-grid")).toBeNull();
    expect(await within(screen.getByTestId("front-door-chapter-story")).findByText("Photo: Example on Pixabay")).toBeTruthy();
    expect(mem.pickAtmosphere).toHaveBeenCalledWith("public_page", [expect.objectContaining({ key: "chapter:story", type: "section_header" })]);
  });

  it("a door explains itself; nothing opens or sends", async () => {
    renderWithClient(<PublicPageScreen />);
    fireEvent.press(await screen.findByTestId("front-door-tile-partner"));
    expect(within(screen.getByTestId("public-page-door")).getByText(/^On your live card, Partner opens a chat with Mila/)).toBeTruthy();
    expect(card.publish).not.toHaveBeenCalled();
  });
});

describe("Edit", () => {
  it("opens from Me's Edit; each switch is one PATCH; Review & publish goes to the review", async () => {
    params = { edit: true };
    renderWithClient(<PublicPageScreen />);
    const caps = await screen.findByTestId("public-page-capabilities");
    for (const k of ["askMila", "partner", "book", "shop", "showMia"]) expect(within(caps).getByTestId(`public-cap-${k}`)).toBeTruthy();
    await screen.findByText("Mila answers fans and brands for you");
    await act(async () => { fireEvent(screen.getByTestId("public-cap-switch-showMia"), "valueChange", true); });
    expect(card.setSwitches).toHaveBeenCalledWith({ showMia: true });
    fireEvent.press(screen.getByTestId("public-page-review"));
    expect(navigate).toHaveBeenCalledWith("PublicCardReview");
  });

  it("Edit toggles from the bar; Done closes it", async () => {
    renderWithClient(<PublicPageScreen />);
    expect(screen.queryByTestId("public-page-capabilities")).toBeNull();
    fireEvent.press(screen.getByTestId("public-page-edit"));
    expect(await screen.findByTestId("public-page-capabilities")).toBeTruthy();
    fireEvent.press(screen.getByTestId("public-page-edit"));
    expect(screen.queryByTestId("public-page-capabilities")).toBeNull();
  });
});
