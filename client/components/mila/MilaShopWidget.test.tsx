/**
 * MilaShopWidget.test — Mila's pick card (Her picks §7). Nothing is added until she taps "Add as a draft"; the tap sends
 * her link as given and Mila's line only as a suggestion; "Paid link" is always on the card; warnings are read out.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { MilaShopWidget } from "./MilaShopWidget";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const add = { mutate: jest.fn(), isPending: false, isError: false };
jest.mock("../../hooks/use-shop", () => ({ useAddShopItem: () => add }));

const data = {
  url: "https://www.amazon.com/dp/B0?tag=her-20", host: "www.amazon.com", title: "Trail Shoe", store: "Amazon.com",
  imageUrl: null, priceCents: 12900, currency: "USD", source: "amazon", networkTag: "her-20", category: "footwear",
  amazonWithoutTag: false, shelfOpen: true, warnings: [{ code: "exclusivity", text: "Your deal with Brand Oak has an exclusivity clause." }],
  suggestedBlurb: "What I wear for long runs",
} as const;

beforeEach(() => add.mutate.mockReset());

describe("Mila's pick card", () => {
  it("shows the product with Paid link, what was detected, the warning and the labelled suggestion; adds only on her tap", () => {
    render(<MilaShopWidget data={{ ...data, warnings: [...data.warnings] }} />);
    expect(screen.getByText("Paid link")).toBeTruthy();
    expect(screen.getByText("Amazon · your tag her-20")).toBeTruthy();
    expect(screen.getByText("$129.00")).toBeTruthy();
    expect(screen.getByTestId("mila-shop-warning-exclusivity")).toBeTruthy();
    expect(screen.getByText(/Suggested by Mila/)).toBeTruthy();
    expect(add.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("mila-shop-add"));
    expect(add.mutate.mock.calls[0][0]).toEqual({ url: "https://www.amazon.com/dp/B0?tag=her-20", suggested_blurb: "What I wear for long runs" });
    act(() => { add.mutate.mock.calls[0][1].onSuccess({ existing: false }); });
    expect(screen.getByText("Added as a draft. Publish it on My Picks when it's ready.")).toBeTruthy();
    expect(screen.queryByTestId("mila-shop-add")).toBeNull();
  });

  it("an Amazon link without a tag says she won't earn on it; a closed shelf says so", () => {
    render(<MilaShopWidget data={{ ...data, networkTag: null, amazonWithoutTag: true, shelfOpen: false, warnings: [], suggestedBlurb: null }} />);
    expect(screen.getByText(/no Associates tag/)).toBeTruthy();
    expect(screen.getByText(/isn't open yet/)).toBeTruthy();
    expect(screen.queryByTestId("mila-shop-suggestion")).toBeNull();
  });
});
