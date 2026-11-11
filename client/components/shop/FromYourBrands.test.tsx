/**
 * FromYourBrands.test — "select, don't paste" (Her picks §12). Only her brands are listed; she asks; a pending brand
 * says so; an approved brand's catalog adds a draft on her tap.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { FromYourBrands } from "./FromYourBrands";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const request = { mutate: jest.fn(), isPending: false };
const add = { mutate: jest.fn(), isPending: false };
let brands: any[] = [];
jest.mock("../../hooks/use-shop", () => ({
  useShopBrands: () => ({ data: { brands } }),
  useRequestBrand: () => request,
  useAddFromCatalog: () => add,
  useBrandCatalog: (shopId: string | null) => ({ isLoading: false, data: shopId ? { products: [{ id: "p1", title: "Oak Tee", vendor: "Oak", imageUrl: null, priceCents: 4800, currency: "USD", available: true }] } : undefined }),
}));

beforeEach(() => { request.mutate.mockReset(); add.mutate.mockReset(); });

describe("From your brands", () => {
  it("nothing to show without a brand on the app", () => {
    brands = [];
    render(<FromYourBrands />);
    expect(screen.queryByTestId("picks-brands")).toBeNull();
  });
  it("ask, wait, then browse and add a draft", () => {
    brands = [
      { shopId: "s1", name: "Oak Brand", domain: "oakbrand.com", state: "none", code: null },
      { shopId: "s2", name: "Elm", domain: "elm.com", state: "pending", code: null },
      { shopId: "s3", name: "Pine", domain: "pine.com", state: "approved", code: "PINE10" },
    ];
    render(<FromYourBrands />);
    fireEvent.press(screen.getByTestId("brand-ask-s1"));
    expect(request.mutate.mock.calls[0][0]).toBe("s1");
    expect(screen.getByText("Waiting for the brand")).toBeTruthy();
    expect(screen.getByText("Your code PINE10")).toBeTruthy();
    fireEvent.press(screen.getByTestId("brand-browse-s3"));
    expect(screen.getByText("$48.00")).toBeTruthy();
    fireEvent.press(screen.getByTestId("catalog-add-p1"));
    expect(add.mutate.mock.calls[0][0]).toBe("p1");
    act(() => { add.mutate.mock.calls[0][1].onSuccess(); });
    expect(screen.getByText("Added")).toBeTruthy();
  });
});
