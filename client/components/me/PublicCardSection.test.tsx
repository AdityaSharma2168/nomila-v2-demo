/**
 * PublicCardSection.test — her public card at the top of Me, over the REAL hooks; only lib/publicCardApi is stubbed.
 *
 *   S1 flag off: the My Nomi row → her deck, and no request is made
 *   S2 a new athlete: Draft, "Not published yet", how the link is set, Review's meta is the server's blockedReason,
 *      no Share row (nothing is live), no view count anywhere
 *   S3 a live card: Live · v2, the link, "4 items wait for you"; every row opens something real (Review, Preview,
 *      the system share sheet with the link, Card settings)
 *   S4 loading, a failed load with Try again, and the server's flag off (404) falling back to the deck
 */
import React from "react";
import { Share } from "react-native";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithClient } from "../../screens/me/__fixtures__/renderWithClient";
import { PublicCardSection } from "./PublicCardSection";
import { CONTENT_DRAFT, NEW_DRAFT, httpError } from "../../screens/me/__fixtures__/publicCard";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const api = {
  getDraft: jest.fn(), saveDecisions: jest.fn(), getPreview: jest.fn(), publish: jest.fn(), unpublish: jest.fn(),
  setSwitches: jest.fn(), setHandle: jest.fn(), publicBase: () => "https://api.example.test",
};
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return api; } }));

const handlers = { onDeck: jest.fn(), onReview: jest.fn(), onPreview: jest.fn(), onSettings: jest.fn() };
function mount(enabled = true) {
  return renderWithClient(<PublicCardSection enabled={enabled} photo={null} {...handlers} />);
}
const allText = () => screen.toJSON() ? JSON.stringify(screen.toJSON()) : "";

beforeEach(() => { jest.clearAllMocks(); });

describe("S1 flag off", () => {
  it("draws the My Nomi row and never calls the card's routes", () => {
    mount(false);
    fireEvent.press(screen.getByText("My Nomi"));
    expect(handlers.onDeck).toHaveBeenCalled();
    expect(api.getDraft).not.toHaveBeenCalled();
  });
});

describe("S2 a new athlete", () => {
  it("draft, no link yet, the reason it can't publish, no share, no views", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    mount();
    expect(await screen.findByText("Draft")).toBeTruthy();
    expect(screen.getByText("Not published yet. Nothing is public until you publish.")).toBeTruthy();
    expect(screen.getByText(/Your link is set when you publish/)).toBeTruthy();
    expect(screen.getByText("Add a chapter or turn on a door to publish")).toBeTruthy();
    expect(screen.queryByText("Share link")).toBeNull();
    expect(allText()).not.toMatch(/views/i);
  });
});

describe("S3 a live card", () => {
  it("shows its state and link, and every row opens something real", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as any);
    mount();
    expect(await screen.findByText("Live · v2")).toBeTruthy();
    expect(screen.getByTestId("me-public-card-link").props.children).toBe("api.example.test/p/sam-lee");
    expect(screen.getByText("4 items wait for you")).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/^Review & publish/));
    expect(handlers.onReview).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText(/^Preview as a visitor/));
    expect(handlers.onPreview).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText(/^Card settings/));
    expect(handlers.onSettings).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText(/^Share link/));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(JSON.stringify(share.mock.calls[0][0])).toContain("https://api.example.test/p/sam-lee");
    expect(allText()).not.toMatch(/views/i);
  });
});

describe("S4 loading and errors", () => {
  it("loading, then a failed load with Try again that refetches", async () => {
    api.getDraft.mockRejectedValueOnce(httpError(500, { error: "public card operation failed" }));
    mount();
    expect(screen.getByTestId("me-public-card-loading")).toBeTruthy();
    expect(await screen.findByText("Your public card didn't load.")).toBeTruthy();
    api.getDraft.mockResolvedValueOnce(NEW_DRAFT);
    fireEvent.press(screen.getByTestId("me-public-card-retry"));
    expect(await screen.findByText("Draft")).toBeTruthy();
  });
  it("the server's flag off: publishing opens soon, and the deck row stays", async () => {
    api.getDraft.mockRejectedValue(httpError(404, { error: "The public card is not available yet.", code: "disabled" }));
    mount();
    expect(await screen.findByText(/Publishing your card opens soon/)).toBeTruthy();
    fireEvent.press(screen.getByText("Your deck"));
    expect(handlers.onDeck).toHaveBeenCalled();
  });
});
