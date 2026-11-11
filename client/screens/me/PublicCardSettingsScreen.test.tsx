/**
 * PublicCardSettingsScreen.test — Card settings, over the REAL hooks; only lib/publicCardApi is stubbed.
 *
 *   T1 loading and a failed load with Try again
 *   T2 doors: five switches from the draft; Book and Shop say why they can't work (availability); a flip PATCHes only
 *      that switch; on a live card, off says it came off at once (removalVersion) and on waits for a publish; a refused
 *      flip goes back and says so
 *   T3 What shows: M.I.A. and search default off, each its own PATCH
 *   T4 the link: the shape is checked before asking; 409 taken / reserved, 422, 429 with the date; a change that waits
 *      locks the field and says when; a new athlete is told how a link is set
 *   T5 social links: listed from the preview with "Coming soon"; no per-link switch is drawn
 *   T6 offline: only on a live card, behind a confirm; the confirm POSTs /unpublish once
 */
import React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { PublicCardSettingsScreen } from "./PublicCardSettingsScreen";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { CONTENT_DRAFT, NEW_DRAFT, NEW_PREVIEW, PREVIEW, SWITCHES_DEFAULT, httpError, state } from "./__fixtures__/publicCard";

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

beforeEach(() => {
  jest.clearAllMocks();
  api.getPreview.mockResolvedValue(PREVIEW);
});
const mount = () => renderWithClient(<PublicCardSettingsScreen />);

describe("T1 loading and errors", () => {
  it("a failed load says so; Try again loads", async () => {
    api.getDraft.mockRejectedValueOnce(new Error("500: {}"));
    mount();
    expect(screen.getByTestId("settings-loading")).toBeTruthy();
    expect(await screen.findByText("Your public card didn't load.")).toBeTruthy();
    api.getDraft.mockResolvedValueOnce(NEW_DRAFT);
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByTestId("settings-doors")).toBeTruthy();
  });
});

describe("T2 doors", () => {
  it("five switches; Book and Shop say why they can't work", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    mount();
    await screen.findByTestId("settings-doors");
    for (const k of ["partner", "book", "shop", "create", "askMila"]) expect(screen.getByTestId(`settings-switch-${k}`)).toBeTruthy();
    expect(screen.getByTestId("settings-switch-partner").props.value).toBe(true);
    expect(screen.getByTestId("settings-unavailable-book").props.children).toMatch(/published offer and payouts/);
    expect(screen.getByTestId("settings-unavailable-shop").props.children).toMatch(/live pick/);
    expect(screen.getByText("Your choices show when you publish.")).toBeTruthy();
  });
  it("on a live card: off comes off at once; on waits for a publish", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    api.setSwitches.mockResolvedValueOnce({ switches: { ...SWITCHES_DEFAULT, shop: true, partner: false }, removalVersion: 3 });
    mount();
    await act(async () => { fireEvent(await screen.findByTestId("settings-switch-partner"), "valueChange", false); });
    expect(api.setSwitches).toHaveBeenCalledWith({ partner: false });
    expect((await screen.findByTestId("settings-note-partner")).props.children).toBe("Removed from your live card.");
    api.setSwitches.mockResolvedValueOnce({ switches: { ...SWITCHES_DEFAULT, shop: true, partner: false, create: true }, removalVersion: null });
    await act(async () => { fireEvent(screen.getByTestId("settings-switch-askMila"), "valueChange", true); });
    expect((await screen.findByTestId("settings-note-askMila")).props.children).toBe("Shows after you publish again.");
  });
  it("a refused flip goes back and says so", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.setSwitches.mockRejectedValueOnce(new Error("Network request failed"));
    mount();
    await act(async () => { fireEvent(await screen.findByTestId("settings-switch-create"), "valueChange", false); });
    expect((await screen.findByTestId("settings-note-create")).props.children).toMatch(/Couldn't reach Nomila/);
    expect(screen.getByTestId("settings-switch-create").props.value).toBe(true);
  });
});

describe("T3 what shows", () => {
  it("M.I.A. and search default off; each flips on its own", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.setSwitches.mockResolvedValue({ switches: { ...SWITCHES_DEFAULT, showMia: true }, removalVersion: null });
    mount();
    expect((await screen.findByTestId("settings-switch-showMia")).props.value).toBe(false);
    expect(screen.getByTestId("settings-switch-indexable").props.value).toBe(false);
    expect(screen.getByLabelText("Show M.I.A. on my card")).toBeTruthy();
    expect(screen.getByLabelText("Let search engines find my card")).toBeTruthy();
    await act(async () => { fireEvent(screen.getByTestId("settings-switch-showMia"), "valueChange", true); });
    expect(api.setSwitches).toHaveBeenCalledWith({ showMia: true });
    await act(async () => { fireEvent(screen.getByTestId("settings-switch-indexable"), "valueChange", true); });
    expect(api.setSwitches).toHaveBeenLastCalledWith({ indexable: true });
  });
});

describe("T4 the link", () => {
  it("a new athlete: how a link is set; the shape is checked before asking", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    mount();
    expect(await screen.findByText(/Pick your link/)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId("settings-handle-input"), "a");
    fireEvent.press(screen.getByTestId("settings-handle-save"));
    expect(screen.getByTestId("settings-handle-line").props.children).toMatch(/3–30/);
    expect(api.setHandle).not.toHaveBeenCalled();
  });
  it.each([
    [httpError(409, { code: "taken", error: "That handle is taken." }), "That link is taken. Try another."],
    [httpError(409, { code: "reserved", error: "That handle is reserved." }), "That link is reserved by Nomila. Try another."],
    [httpError(422, { code: "invalid", error: "x" }), "A link is 3–30 letters, numbers and single hyphens."],
    [httpError(429, { code: "too_soon", error: "x", nextChangeAt: "2026-11-07T00:00:00.000Z" }), "You can change your link once a month. Next change: 7 Nov 2026."],
  ])("every refusal in her words (%#)", async (err, line) => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.setHandle.mockRejectedValueOnce(err);
    mount();
    fireEvent.changeText(await screen.findByTestId("settings-handle-input"), "Sam-Lee");
    await act(async () => { fireEvent.press(screen.getByTestId("settings-handle-save")); });
    expect(api.setHandle).toHaveBeenCalledWith("sam-lee");
    expect((await screen.findByTestId("settings-handle-line")).props.children).toBe(line);
  });
  it("saved: the new link shows", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.setHandle.mockResolvedValueOnce({ handle: "sam-lee", handleChangeAvailableAt: null });
    mount();
    fireEvent.changeText(await screen.findByTestId("settings-handle-input"), "sam-lee");
    await act(async () => { fireEvent.press(screen.getByTestId("settings-handle-save")); });
    expect((await screen.findByTestId("settings-handle-line")).props.children).toBe("Saved.");
  });
  it("a change that waits locks the field and says when", async () => {
    api.getDraft.mockResolvedValue({ ...CONTENT_DRAFT, card: { ...CONTENT_DRAFT.card, handleChangeAvailableAt: "2026-11-04T09:00:00.000Z" } });
    mount();
    expect(await screen.findByText("You can change your link again on 4 Nov 2026.")).toBeTruthy();
    expect(screen.getByTestId("settings-handle-input").props.editable).toBe(false);
    expect(screen.getByTestId("settings-handle-save").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId("settings-url").props.children).toBe("api.example.test/p/sam-lee");
  });
});

describe("T5 social links", () => {
  it("lists the profiles with Coming soon and draws no per-link switch", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    mount();
    const card = await screen.findByTestId("settings-socials");
    expect(await within(card).findByText("@samlee")).toBeTruthy();
    expect(within(card).getByText("Coming soon")).toBeTruthy();
    expect(within(card).queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByTestId("settings-socials-soon").props.children).toMatch(/^Coming soon/);
  });
  it("none connected says so", async () => {
    api.getDraft.mockResolvedValue(NEW_DRAFT);
    api.getPreview.mockResolvedValue(NEW_PREVIEW);
    mount();
    expect(await screen.findByText("No connected social profiles yet.")).toBeTruthy();
  });
});

describe("T6 offline", () => {
  it("absent on a draft", async () => {
    api.getDraft.mockResolvedValue({ ...NEW_DRAFT, card: state() });
    mount();
    await screen.findByTestId("settings-doors");
    expect(screen.queryByText("Take your card offline")).toBeNull();
  });
  it("on a live card: confirm first, then one POST", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    api.unpublish.mockResolvedValue({ unpublished: true });
    mount();
    fireEvent.press(await screen.findByText("Take your card offline"));
    expect(screen.getByTestId("unpublish-sheet")).toBeTruthy();
    expect(api.unpublish).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(screen.getByTestId("unpublish-confirm")); });
    expect(api.unpublish).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("unpublish-done")).toBeTruthy());
  });
  it("a failed unpublish says so and offers Try again", async () => {
    api.getDraft.mockResolvedValue(CONTENT_DRAFT);
    api.unpublish.mockRejectedValueOnce(new Error("500: {}"));
    mount();
    fireEvent.press(await screen.findByText("Take your card offline"));
    await act(async () => { fireEvent.press(screen.getByTestId("unpublish-confirm")); });
    expect(await screen.findByTestId("unpublish-error")).toBeTruthy();
    expect(within(screen.getByTestId("unpublish-confirm")).getByText("Try again")).toBeTruthy();
  });
});
