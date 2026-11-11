/**
 * PublicCardReviewScreen.test — Review & publish, over the REAL hooks; only lib/publicCardApi is stubbed.
 *
 *   R1 loading, a failed load with Try again; a NEW athlete: the server's blockedReason, the empty line, Publish disabled
 *   R2 an athlete with content: chapters in her order, each item's source chip and why it does or doesn't show, the
 *      chapter notes, the cut list with its reasons (never text)
 *   R3 her edits PUT the whole decision set: Approve pins a made line's exact hash; Hide; a chapter moves, hides, is renamed;
 *      Highlights never moves or hides
 *   R4 a failed save says so, and Try again / Undo
 *   R5 Publish is her tap in the sheet: the summary first, then POST /publish; success shows the version and the link;
 *      the 422 sentence verbatim; a missing handle → Card settings
 */
import React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { PublicCardReviewScreen } from "./PublicCardReviewScreen";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { CONTENT_DRAFT, NEW_DRAFT, PREVIEW, httpError } from "./__fixtures__/publicCard";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const api = {
  getDraft: jest.fn(), saveDecisions: jest.fn(), getPreview: jest.fn(), publish: jest.fn(), unpublish: jest.fn(),
  setSwitches: jest.fn(), setHandle: jest.fn(), publicBase: () => "https://api.example.test",
};
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return api; } }));

beforeEach(() => {
  jest.clearAllMocks();
  api.saveDecisions.mockResolvedValue(CONTENT_DRAFT);
  api.getPreview.mockResolvedValue(PREVIEW);
});
const mount = () => renderWithClient(<PublicCardReviewScreen />);
const lastSaved = () => api.saveDecisions.mock.calls[api.saveDecisions.mock.calls.length - 1][0];

describe("R1 loading, errors, a new athlete", () => {
  it("a failed load says so; Try again loads", async () => {
    api.getDraft.mockRejectedValueOnce(new Error("Network request failed"));
    mount();
    expect(screen.getByTestId("review-loading")).toBeTruthy();
    expect(await screen.findByText(/Couldn't reach Nomila/)).toBeTruthy();
    api.getDraft.mockResolvedValueOnce(NEW_DRAFT);
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByTestId("review-status")).toBeTruthy();
  });
  it("a new athlete: the reason, the empty line, Publish disabled", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    mount();
    expect(await screen.findByText("Add a chapter or turn on a door to publish")).toBeTruthy();
    expect(screen.getByTestId("review-empty")).toBeTruthy();
    expect(screen.getByTestId("review-publish").props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId("review-up-highlights")).toBeNull();
    expect(screen.queryByTestId("review-chapter-toggle-highlights")).toBeNull();
  });
});

describe("R2 an athlete with content", () => {
  it("draws chapters, sources, notes and the cut list", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    mount();
    expect(await screen.findByText("Ready to publish.")).toBeTruthy();
    const titles = ["HIGHLIGHTS", "STORY", "WHAT I CARE ABOUT"].map((t) => screen.getByText(t));
    expect(titles).toHaveLength(3);
    const id = within(screen.getByTestId("review-item-hl-id"));
    expect(id.getByText("Made")).toBeTruthy();
    expect(id.getByLabelText("Source: Nomila wrote this from your record")).toBeTruthy();
    expect(within(screen.getByTestId("review-item-hl-aff")).getByText("Found")).toBeTruthy();
    expect(screen.getByTestId("review-note-hl-aff").props.children).toBe("Nomila found this. Approve to confirm it's right.");
    expect(screen.getByTestId("review-note-st-rise").props.children).toMatch(/wording changed/);
    expect(screen.getByText("Shows once 2 items are approved (0 so far).")).toBeTruthy();
    expect(screen.getByText("Hidden. This chapter won't show.")).toBeTruthy();
    const cut = within(screen.getByTestId("review-cut"));
    expect(cut.getByText("Story beat")).toBeTruthy();
    expect(cut.getByText("It touched one of your guardrails.")).toBeTruthy();
    expect(within(screen.getByTestId("review-picks")).getByText("Trail shoe")).toBeTruthy();
  });
});

describe("R3 her edits", () => {
  beforeEach(() => { api.getDraft.mockResolvedValue(CONTENT_DRAFT); });
  it("Approve pins the exact wording; the whole set goes up", async () => {
    mount();
    fireEvent.press(await screen.findByTestId("review-approve-st-origin"));
    await waitFor(() => expect(api.saveDecisions).toHaveBeenCalledTimes(1));
    expect(lastSaved()).toEqual({
      items: {
        "hl-id": { state: "approved", textHash: "h-id" },
        "st-rise": { state: "approved" },
        "im-cause": { state: "hidden" },
        "st-origin": { state: "approved", textHash: "h-origin" },
      },
      chapters: { impact: { hidden: true, title: "What I care about" } },
      order: ["story", "impact"],
    });
  });
  it("Hide an item; show a hidden one", async () => {
    mount();
    fireEvent.press(await screen.findByTestId("review-hide-hl-aff"));
    await waitFor(() => expect(lastSaved().items["hl-aff"]).toEqual({ state: "hidden" }));
    fireEvent.press(screen.getByTestId("review-approve-im-cause"));
    await waitFor(() => expect(lastSaved().items["im-cause"]).toEqual({ state: "approved" }));
  });
  it("a chapter moves, shows, and is renamed", async () => {
    mount();
    expect((await screen.findByTestId("review-up-story")).props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId("review-up-impact"));
    await waitFor(() => expect(lastSaved().order).toEqual(["impact", "story"]));
    fireEvent.press(screen.getByTestId("review-chapter-toggle-impact"));
    await waitFor(() => expect(lastSaved().chapters.impact).toEqual({ title: "What I care about" }));
    fireEvent.press(screen.getByTestId("review-rename-story"));
    fireEvent.changeText(screen.getByTestId("review-rename-input"), "My road");
    fireEvent.press(screen.getByTestId("review-rename-save"));
    await waitFor(() => expect(lastSaved().chapters.story).toEqual({ title: "My road" }));
  });
});

describe("R4 a failed save", () => {
  it("says so; Try again resends the same set; Undo drops it", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    api.saveDecisions.mockRejectedValueOnce(new Error("500: {}"));
    mount();
    fireEvent.press(await screen.findByTestId("review-hide-hl-aff"));
    expect(await screen.findByTestId("review-save-error")).toBeTruthy();
    expect(screen.getByTestId("review-publish").props.accessibilityState.disabled).toBe(true);
    const sent = lastSaved();
    fireEvent.press(screen.getByTestId("review-save-retry"));
    await waitFor(() => expect(api.saveDecisions).toHaveBeenCalledTimes(2));
    expect(lastSaved()).toEqual(sent);
    await waitFor(() => expect(screen.queryByTestId("review-save-error")).toBeNull());
  });
  it("Undo puts the server's state back", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    api.saveDecisions.mockRejectedValueOnce(new Error("500: {}"));
    mount();
    fireEvent.press(await screen.findByTestId("review-hide-hl-aff"));
    fireEvent.press(await screen.findByTestId("review-save-undo"));
    await waitFor(() => expect(screen.queryByTestId("review-save-error")).toBeNull());
    expect(screen.getByTestId("review-note-hl-aff").props.children).toMatch(/Nomila found this/);
  });
});

describe("R5 publish is her tap", () => {
  beforeEach(() => { api.getDraft.mockResolvedValue(CONTENT_DRAFT); });
  it("the summary, then her tap publishes; success shows the version and link", async () => {
    api.publish.mockResolvedValue({ version: 3, handle: "sam-lee", page: {} });
    mount();
    fireEvent.press(await screen.findByTestId("review-publish"));
    const summary = await screen.findByTestId("publish-summary");
    expect(within(summary).getByText("Highlights · Story")).toBeTruthy();
    expect(within(summary).getByText("Partner · Shop · Create · Ask Mila")).toBeTruthy();
    expect(within(summary).getByText("api.example.test/p/sam-lee")).toBeTruthy();
    expect(api.publish).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(screen.getByTestId("publish-confirm")); });
    expect(api.publish).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Version 3 is live at your link.")).toBeTruthy();
  });
  it("a 422 shows the server's sentence; Try again", async () => {
    api.publish.mockRejectedValueOnce(httpError(422, { code: "invalid", error: "Add a chapter or turn on a door to publish" }));
    mount();
    fireEvent.press(await screen.findByTestId("review-publish"));
    await screen.findByTestId("publish-summary");
    await act(async () => { fireEvent.press(screen.getByTestId("publish-confirm")); });
    expect(await screen.findByText("Add a chapter or turn on a door to publish")).toBeTruthy();
    expect(within(screen.getByTestId("publish-confirm")).getByText("Try again")).toBeTruthy();
  });
  it("no handle yet: Pick your link opens Card settings", async () => {
    api.publish.mockRejectedValueOnce(httpError(409, { code: "needs_handle", error: "Pick a handle before publishing." }));
    mount();
    fireEvent.press(await screen.findByTestId("review-publish"));
    await screen.findByTestId("publish-summary");
    await act(async () => { fireEvent.press(screen.getByTestId("publish-confirm")); });
    fireEvent.press(await screen.findByTestId("publish-pick-handle"));
    expect(navigate).toHaveBeenCalledWith("PublicCardSettings");
  });
  it("Preview as a visitor opens the preview", async () => {
    mount();
    fireEvent.press(await screen.findByTestId("review-preview"));
    expect(navigate).toHaveBeenCalledWith("PublicCardPreview");
  });
});
