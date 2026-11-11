/**
 * DealDetailRoute — ONE detail per deal (owner, 8 Oct 2026). With the board on, a deal opens its brand's detail
 * (OpportunityDetail) by its opportunity — the route is REPLACED, so back returns where she came from; only a deal with
 * no opportunity (one she added herself) keeps the older screen; with the board off (the classic build) nothing changes.
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

const replace = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ replace, goBack: jest.fn() }) }));
jest.mock("../components/ui/StackHeader", () => ({ StackHeader: () => null }));
let served: { deal: any; isLoading: boolean; error: Error | null } = { deal: null, isLoading: true, error: null };
const asked: Array<string | undefined> = [];
jest.mock("../hooks/use-deals", () => ({ useDeal: (id: string | undefined) => { asked.push(id); return served; } }));

import { DealDetailRoute, dealDetailTarget } from "./DealDetailRoute";

const OLD = <Text>old deal screen</Text>;
beforeEach(() => { replace.mockReset(); asked.length = 0; });

describe("dealDetailTarget", () => {
  it("board on: an inbox deal opens its opportunity's detail; waits while loading; no opportunity keeps the older screen", () => {
    expect(dealDetailTarget(true, true, { opportunityId: "o1" })).toEqual({ screen: "OpportunityDetail", opportunityId: "o1" });
    expect(dealDetailTarget(true, false, null)).toEqual({ screen: "pending" });
    expect(dealDetailTarget(true, true, { opportunityId: null })).toEqual({ screen: "DealDetail" });
  });
  it("board off (the classic build): unchanged", () => {
    expect(dealDetailTarget(false, true, { opportunityId: "o1" })).toEqual({ screen: "DealDetail" });
  });
});

describe("the route", () => {
  it("board on, an active athlete's inbox deal: replaced by its brand's detail; the old screen never renders", () => {
    served = { deal: { id: "d1", opportunityId: "o1" }, isLoading: false, error: null };
    render(<DealDetailRoute dealId="d1" board>{OLD}</DealDetailRoute>);
    expect(replace).toHaveBeenCalledWith("OpportunityDetail", { opportunityId: "o1" });
    expect(screen.queryByText("old deal screen")).toBeNull();
  });
  it("board on, while the deal loads: a spinner, not the old screen", () => {
    served = { deal: null, isLoading: true, error: null };
    render(<DealDetailRoute dealId="d1" board>{OLD}</DealDetailRoute>);
    expect(screen.getByTestId("deal-detail-route")).toBeTruthy();
    expect(screen.queryByText("old deal screen")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
  it("board on, a deal she added herself (no opportunity): the older screen", () => {
    served = { deal: { id: "d2", opportunityId: null }, isLoading: false, error: null };
    render(<DealDetailRoute dealId="d2" board>{OLD}</DealDetailRoute>);
    expect(screen.getByText("old deal screen")).toBeTruthy();
  });
  it("board off: the older screen, and the deal is not even fetched", () => {
    served = { deal: null, isLoading: false, error: null };
    render(<DealDetailRoute dealId="d3" board={false}>{OLD}</DealDetailRoute>);
    expect(screen.getByText("old deal screen")).toBeTruthy();
    expect(asked.every((a) => a === undefined)).toBe(true);
  });
});
