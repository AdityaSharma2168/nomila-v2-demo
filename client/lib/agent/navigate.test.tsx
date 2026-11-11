/**
 * navigate.test.ts — routeFor (agent/navigate.ts): the one map from a semantic target to the app's routes. Pure, so
 * tested directly rather than only through a screen.
 */
import { routeFor } from "./navigate";

test("a URL target opens in the browser", () => {
  expect(routeFor({ url: "https://example.org" })).toEqual({ url: "https://example.org" });
});

test("studio focuses an item in the library", () => {
  expect(routeFor({ screen: "studio", params: { id: "studio-postkit-1" } })).toEqual({ tab: "Studio", screen: "StudioHome", params: { focus: "studio-postkit-1" } });
});

test("post-kit opens the kit screen directly, not the library", () => {
  expect(routeFor({ screen: "post-kit", params: { id: "d1" } })).toEqual({ tab: "Studio", screen: "PostKit", params: { id: "d1" } });
});

test("an unknown screen routes nowhere", () => {
  expect(routeFor({ screen: "not-a-real-screen" } as any)).toBeNull();
});

test("opportunities opens the board, or one opportunity when the target names it (a payment notification)", () => {
  expect(routeFor({ screen: "opportunities" } as any)).toEqual({ tab: "Opportunities", screen: "OpportunitiesList" });
  expect(routeFor({ screen: "opportunities", id: "opp-1" } as any)).toEqual({ tab: "Opportunities", screen: "OpportunityDetail", params: { opportunityId: "opp-1" } });
});
