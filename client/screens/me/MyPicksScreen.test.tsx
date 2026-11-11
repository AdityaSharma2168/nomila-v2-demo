/**
 * MyPicksScreen.test — Me › My Picks (Her picks §1). The hooks are replaced; the screen's own decisions are tested:
 *
 *   P1 the gate asks, never guesses: 18+, the international question, the visa warning she acknowledges; a minor sees one line
 *   P2 adding is her link, pasted or typed, as a draft
 *   P3 her order moves one step at a time
 *   P4 the edit sheet: the fan preview carries "Paid link"; Mila's suggestion only fills her field on "Use this"; a
 *      warning from the server is read out and "I've checked — publish" resends with confirm_warnings
 *   P5 NIL Go: per brand against $600, the affiliate note, college only
 *   P6 supplements turn on only after the warning
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { MyPicksScreen } from "./MyPicksScreen";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "https://store.example.com/p/clip?ref=HER") }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const m = () => ({ mutate: jest.fn(), isPending: false, isError: false });
const hooks = { add: m(), settings: m(), update: m(), reorder: m(), remove: m(), data: null as any };
jest.mock("../../hooks/use-shop", () => ({
  useShop: () => ({ data: hooks.data, isLoading: false, isError: false, refetch: jest.fn() }),
  useAddShopItem: () => hooks.add,
  useShopSettings: () => hooks.settings,
  useUpdateShopItem: () => hooks.update,
  useReorderShopItems: () => hooks.reorder,
  useDeleteShopItem: () => hooks.remove,
}));

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, url: `https://store.example.com/${id}`, host: "store.example.com", source: "link", networkTag: null, title: `Pick ${id}`,
  imageUrl: null, priceCents: 4500, currency: "USD", merchant: "Example Store", category: "apparel", blurb: null, blurbSuggestion: null,
  discountCode: null, status: "draft", position: 0, publishedAt: null, clicks7d: 0, clicks30d: 0, ...over,
});
const open = { eligible: true, needs: [], adultConfirmed: true, internationalStudent: false, internationalAcknowledged: false, supplementsOn: false, schoolApparelSponsor: null };
const nilGoOff = { applies: false, thresholdCents: 60000, brands: [], copy: { title: "NIL Go reminder", rule: "r", notFiling: "n", affiliateNote: "Your own affiliate earnings from your picks are not counted here." } };
const base = (over: Record<string, unknown> = {}) => ({ settings: open, items: [], nilGo: nilGoOff, categories: ["apparel", "footwear", "supplements"], ...over });

beforeEach(() => { for (const k of ["add", "settings", "update", "reorder", "remove"] as const) hooks[k].mutate.mockReset(); });

describe("P1 the gate", () => {
  it("asks for 18+ and the international answer; a yes shows the visa warning to acknowledge", () => {
    hooks.data = base({ settings: { ...open, eligible: false, needs: ["adult_confirmation", "international_answer"], adultConfirmed: false, internationalStudent: null } });
    const a = render(<MyPicksScreen />);
    fireEvent.press(screen.getByTestId("picks-adult"));
    expect(hooks.settings.mutate.mock.calls[0][0]).toEqual({ adult_confirmed: true });
    fireEvent.press(screen.getByTestId("picks-intl-yes"));
    expect(hooks.settings.mutate.mock.calls[1][0]).toEqual({ international_student: true });
    a.unmount();
    hooks.data = base({ settings: { ...open, eligible: false, needs: ["international_ack"], internationalStudent: true } });
    render(<MyPicksScreen />);
    expect(screen.getByTestId("picks-intl-warning")).toBeTruthy();
    fireEvent.press(screen.getByTestId("picks-intl-ack"));
    expect(hooks.settings.mutate.mock.calls[2][0]).toEqual({ international_ack: true });
  });
  it("a known minor sees one plain line and no questions", () => {
    hooks.data = base({ settings: { ...open, eligible: false, needs: ["minor", "adult_confirmation"], adultConfirmed: false } });
    render(<MyPicksScreen />);
    expect(screen.getByText("My Picks is for athletes 18 and older.")).toBeTruthy();
    expect(screen.queryByTestId("picks-adult")).toBeNull();
  });
  it("an open shelf shows no gate", () => {
    hooks.data = base();
    render(<MyPicksScreen />);
    expect(screen.queryByTestId("picks-gate")).toBeNull();
  });
});

describe("P2 adding", () => {
  it("her link, pasted from the clipboard, becomes a draft", async () => {
    hooks.data = base();
    render(<MyPicksScreen />);
    await act(async () => { fireEvent.press(screen.getByTestId("picks-paste")); });
    fireEvent.press(screen.getByTestId("picks-add-button"));
    expect(hooks.add.mutate.mock.calls[0][0]).toEqual({ url: "https://store.example.com/p/clip?ref=HER" });
    act(() => { hooks.add.mutate.mock.calls[0][1].onSuccess({ existing: false }); });
    expect(screen.getByTestId("picks-add-line").props.children).toBe("Added as a draft. Open it to add your words and publish.");
  });
});

describe("P3 her order", () => {
  it("moves one step; the first can't go up", () => {
    hooks.data = base({ items: [item("a", { status: "live", clicks7d: 3, clicks30d: 3 }), item("b"), item("c")] });
    render(<MyPicksScreen />);
    expect(screen.getByText("Live · 3 clicks this week")).toBeTruthy();
    fireEvent.press(screen.getByTestId("pick-down-a"));
    expect(hooks.reorder.mutate.mock.calls[0][0]).toEqual(["b", "a", "c"]);
    fireEvent.press(screen.getByTestId("pick-up-a"));
    expect(hooks.reorder.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("P4 the edit sheet", () => {
  it("previews with Paid link; the suggestion fills her field only on her tap; a warning is confirmed before publishing", () => {
    hooks.data = base({ items: [item("a", { blurbSuggestion: "Mila's idea" })] });
    render(<MyPicksScreen />);
    fireEvent.press(screen.getByTestId("pick-row-a"));
    expect(screen.getByTestId("pick-edit-sheet")).toBeTruthy();
    expect(screen.getByTestId("pick-disclosure")).toBeTruthy();
    expect(screen.getByTestId("pick-blurb").props.value).toBe("");
    fireEvent.press(screen.getByTestId("pick-use-suggestion"));
    expect(screen.getByTestId("pick-blurb").props.value).toBe("Mila's idea");

    fireEvent.press(screen.getByTestId("pick-publish"));
    expect(hooks.update.mutate.mock.calls[0][0]).toEqual({ id: "a", patch: { blurb: "Mila's idea", status: "live" } });
    const warning = { code: "exclusivity", brand: "Brand Oak", text: "Your deal with Brand Oak has an exclusivity clause." };
    act(() => { hooks.update.mutate.mock.calls[0][1].onError(new Error(`409: ${JSON.stringify({ code: "needs_confirmation", error: "check", warnings: [warning] })}`)); });
    expect(screen.getByTestId("pick-warning-exclusivity")).toBeTruthy();
    fireEvent.press(screen.getByTestId("pick-publish-confirmed"));
    expect(hooks.update.mutate.mock.calls[1][0]).toEqual({ id: "a", patch: { blurb: "Mila's idea", status: "live", confirm_warnings: true } });
  });
  it("supplements-off is read out plainly and can't be confirmed past", () => {
    hooks.data = base({ items: [item("s", { category: "supplements" })] });
    render(<MyPicksScreen />);
    fireEvent.press(screen.getByTestId("pick-row-s"));
    fireEvent.press(screen.getByTestId("pick-publish"));
    act(() => { hooks.update.mutate.mock.calls[0][1].onError(new Error(`409: ${JSON.stringify({ code: "supplements_off", error: "Supplements are off.", warnings: [{ code: "supplements_off", text: "Supplements are off." }] })}`)); });
    expect(screen.getByTestId("pick-line").props.children).toBe("Supplements are off.");
    expect(screen.queryByTestId("pick-publish-confirmed")).toBeNull();
  });
});

describe("P5 NIL Go", () => {
  it("per brand against $600, with the affiliate note; absent when it doesn't apply", () => {
    hooks.data = base({ nilGo: { ...nilGoOff, applies: true, brands: [{ brand: "Maple", totalCents: 65000, deals: 2, reportable: true, reportBy: null }, { brand: "Birch", totalCents: 10000, deals: 1, reportable: false, reportBy: null }] } });
    const a = render(<MyPicksScreen />);
    expect(screen.getByText("$650")).toBeTruthy();
    expect(screen.getByText("Report to NIL Go")).toBeTruthy();
    expect(screen.getByText("Under $600")).toBeTruthy();
    expect(screen.getByTestId("nilgo-affiliate-note")).toBeTruthy();
    a.unmount();
    hooks.data = base();
    render(<MyPicksScreen />);
    expect(screen.queryByTestId("picks-nilgo")).toBeNull();
  });
});

describe("P6 supplements", () => {
  it("turn on only after the warning", () => {
    hooks.data = base();
    render(<MyPicksScreen />);
    fireEvent.press(screen.getByTestId("picks-supplements"));
    expect(hooks.settings.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("picks-supplements-warning")).toBeTruthy();
    fireEvent.press(screen.getByTestId("picks-supplements-confirm"));
    expect(hooks.settings.mutate.mock.calls[0][0]).toEqual({ supplements_opt_in: true });
  });
});
