/**
 * SeriousOffers.test — her side of the Serious offer: the board section shows only live holds, with the badge and the
 * line the server wrote (nothing computed here), and nothing at all with the flag off; the setting shows her switch and
 * the four amounts, and a tap saves exactly what she chose.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@expo/vector-icons", () => {
  const R = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => R.createElement(Text, null, `icon:${name}`) };
});
jest.mock("../../lib/flags", () => ({ PARTNER_INTAKE: true }));
jest.mock("../../lib/haptics", () => ({ haptics: { select: jest.fn(), tap: jest.fn() } }));
const apiRequest = jest.fn();
jest.mock("../../lib/query-client", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

import { SeriousOffersSection, type SeriousOfferItem } from "./SeriousOffers";
import { SeriousOfferSettings, SETTINGS_KEY } from "./SeriousOfferSettings";

const item = (id: string, state: "held" | "credited" | null, over: Partial<SeriousOfferItem> = {}): SeriousOfferItem => ({
  opportunity_id: id, brand: { name: `Brand ${id}`, safe_logo_url: null },
  partner_request: { kind_label: "Social posts or content", serious_offer: state ? { amount_cents: 5000, state, badge: "Verified · $50 held", line: "5 days left to reply before the hold is released", release_at: null, replied: false } : null },
  ...over,
});

function withClient(ui: React.ReactElement, settings?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => settings } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test("the section lists only live holds, with the server's badge and line, and opens the card", () => {
  const open = jest.fn();
  render(<SeriousOffersSection items={[item("a", "held"), item("b", null), item("c", "credited")]} onOpenItem={open} />);
  expect(screen.getByText("Serious offers · 1")).toBeTruthy();
  expect(screen.getByText("Verified · $50 held")).toBeTruthy();
  expect(screen.getByText("5 days left to reply before the hold is released")).toBeTruthy();
  expect(screen.queryByText("Brand b")).toBeNull();
  expect(screen.queryByText("Brand c")).toBeNull();
  fireEvent.press(screen.getByTestId("serious-offer-a"));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ opportunity_id: "a" }));
});

test("nothing with the flag off, or with no live hold", () => {
  const a = render(<SeriousOffersSection items={[item("a", "held")]} onOpenItem={jest.fn()} enabled={false} />);
  expect(a.toJSON()).toBeNull();
  a.unmount();
  expect(render(<SeriousOffersSection items={[]} onOpenItem={jest.fn()} />).toJSON()).toBeNull();
});

test("the setting: her switch, the four amounts, and a tap saves what she chose", async () => {
  apiRequest.mockResolvedValue({ json: async () => ({ serious_offer_enabled: true, serious_offer_cents: 10000, amounts: [5000, 10000, 15000, 25000] }) });
  withClient(<SeriousOfferSettings />, { serious_offer_enabled: true, serious_offer_cents: 5000, amounts: [5000, 10000, 15000, 25000] });
  await waitFor(() => expect(screen.getByTestId("serious-offer-switch")).toBeTruthy());
  expect(screen.getByText("$50")).toBeTruthy();
  expect(screen.getByText("$250")).toBeTruthy();
  expect(screen.getByTestId("serious-offer-amount-5000").props.accessibilityState).toMatchObject({ selected: true });
  fireEvent.press(screen.getByTestId("serious-offer-amount-10000"));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("PUT", SETTINGS_KEY, { serious_offer_cents: 10000 }));
  await waitFor(() => expect(screen.getByTestId("serious-offer-amount-10000").props.accessibilityState).toMatchObject({ selected: true }));
  fireEvent(screen.getByTestId("serious-offer-switch"), "valueChange", false);
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("PUT", SETTINGS_KEY, { serious_offer_enabled: false }));
  expect(screen.getByText(/You never receive a hold by itself/)).toBeTruthy();
});
