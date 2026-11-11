/**
 * KnowsFactsScreen.test — What Nomila knows on the agent memory, over the REAL hooks; only lib/meMemoryApi is stubbed.
 *
 *   list      the counts line; sections with facts only, each fact a whole-row target with where it came from, its date
 *             and "Couldn't confirm"; Hidden with Restore
 *   actions   That's right → POST confirm · Change it → PATCH with your words · This isn't right → POST dispute, then
 *             Mila opens with your words to finish (never auto-sent) · Hide → DELETE; each says what happens next
 *   measured  a fact from your accounts has no Change it (fix it at the source)
 *   failure   a refused action says so and changes nothing on screen
 */
import React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { KNOWS } from "./__fixtures__/scouting";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const openMila = jest.fn();
jest.mock("../../lib/milaLaunch", () => ({ openMila: (l: unknown) => openMila(l) }));
const rerun = { runId: "r1", after: "2026-10-10T10:00:00Z" };
const mem = {
  getFacts: jest.fn(async (): Promise<any> => KNOWS),
  confirmFact: jest.fn(async () => undefined),
  correctFact: jest.fn(async () => ({ fact: {}, rerun })),
  hideFact: jest.fn(async () => ({ rerun })),
  restoreFact: jest.fn(async () => ({ fact: {}, rerun })),
  disputeFact: jest.fn(async () => ({ seed: { factId: "c1", claim: "x", alternatives: [] }, rerun })),
};
jest.mock("../../lib/meMemoryApi", () => ({ get meMemoryApi() { return mem; } }));

import { KnowsFactsScreen, factDate, factMeta } from "./KnowsFactsScreen";

beforeEach(() => { jest.clearAllMocks(); mem.getFacts.mockResolvedValue(KNOWS); });
const open = async (claim: string) => {
  fireEvent.press(await screen.findByLabelText(new RegExp(`^${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));
  return within(await screen.findByTestId("knows-fact-sheet"));
};

describe("the list", () => {
  it("counts, sections with facts only, where each came from, and Hidden with Restore", async () => {
    renderWithClient(<KnowsFactsScreen />);
    expect((await screen.findByTestId("knows-counts")).props.children).toBe("3 facts · 1 couldn't confirm");
    expect(screen.getByTestId("knows-section-glance")).toBeTruthy();
    expect(screen.getByTestId("knows-section-career")).toBeTruthy();
    expect(screen.queryByTestId("knows-section-honours")).toBeNull();
    expect(screen.getByText("You told us · 3 Oct 2026")).toBeTruthy();
    expect(screen.getByText("Found · 3 Oct 2026 · Couldn't confirm")).toBeTruthy();
    expect(screen.getByText("From your accounts · 3 Oct 2026")).toBeTruthy();
    await act(async () => { fireEvent.press(within(screen.getByTestId("knows-hidden")).getByTestId("knows-restore-h1")); });
    expect(mem.restoreFact).toHaveBeenCalledWith("h1");
  });

  it("factMeta: confirmed by you", () => {
    expect(factMeta({ provenance: "found", date: null, unconfirmed: false, confirmedByYou: true })).toBe("Found · You confirmed");
  });

  it("factDate: the date at its precision — a year as the year, a month as Mon YYYY, a day in full", () => {
    expect(factDate("2025-01-01", "year")).toBe("2025");
    expect(factDate("2025-06-01", "month")).toBe("Jun 2025");
    expect(factDate("2025-06-14", "day")).toBe("14 Jun 2025");
    expect(factDate(null, "year")).toBeNull();
    // no precision stored and a 1 January date (an older merge's year): the year, unless the claim states a full date
    expect(factDate("2025-01-01", null, "Won the regional title in 2025.")).toBe("2025");
    expect(factDate("2025-01-01", undefined, "Signed with the club on 1 January 2025.")).toBe("1 Jan 2025");
    expect(factDate("2025-01-01", null, "Debuted January 1, 2025.")).toBe("1 Jan 2025");
    expect(factDate("2025-03-09", null, "Anything")).toBe("9 Mar 2025");
    expect(factMeta({ provenance: "found", date: "2024-01-01", datePrecision: "year", claim: "Named captain in 2024.", unconfirmed: false, confirmedByYou: false })).toBe("Found · 2024");
  });
});

describe("a fact's actions", () => {
  it("That's right confirms", async () => {
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("Started every game");
    expect(sheet.getByText("example.org")).toBeTruthy();
    await act(async () => { fireEvent.press(sheet.getByTestId("knows-confirm")); });
    expect(mem.confirmFact).toHaveBeenCalledWith("c1");
    expect((await screen.findByTestId("knows-note")).props.children).toBe("Thanks. Nomila keeps it as it is.");
    expect(screen.queryByTestId("knows-fact-sheet")).toBeNull();
  });

  it("Change it sends your words", async () => {
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("You play second slot");
    fireEvent.press(sheet.getByTestId("knows-change"));
    fireEvent.changeText(screen.getByTestId("knows-edit-input"), "You play first slot.");
    await act(async () => { fireEvent.press(screen.getByTestId("knows-save")); });
    expect(mem.correctFact).toHaveBeenCalledWith("g1", "You play first slot.");
    expect((await screen.findByTestId("knows-note")).props.children).toMatch(/about 30 minutes/);
  });

  it("This isn't right disputes it, then Mila opens with your words to finish (not sent)", async () => {
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("Started every game");
    await act(async () => { fireEvent.press(sheet.getByTestId("knows-dispute")); });
    expect(mem.disputeFact).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(openMila).toHaveBeenCalledWith({ draft: '"Started every game this season." isn\'t right. What\'s true is ' }));
  });

  it("Hide hides it", async () => {
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("You play second slot");
    await act(async () => { fireEvent.press(sheet.getByTestId("knows-hide")); });
    expect(mem.hideFact).toHaveBeenCalledWith("g1");
  });

  it("a measured fact is fixed at its source: no Change it", async () => {
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("12,400 followers");
    expect(sheet.queryByTestId("knows-change")).toBeNull();
    expect(sheet.getByText("This number comes from your connected account. Fix it there.")).toBeTruthy();
  });

  it("a refused action says so", async () => {
    mem.confirmFact.mockRejectedValueOnce(new Error("500: {}"));
    renderWithClient(<KnowsFactsScreen />);
    const sheet = await open("Started every game");
    await act(async () => { fireEvent.press(sheet.getByTestId("knows-confirm")); });
    expect((await screen.findByTestId("knows-note")).props.children).toBe("That didn't go through. Try again.");
  });
});

describe("empty", () => {
  it("no memory yet: one plain line", async () => {
    mem.getFacts.mockResolvedValue({ contract: "knows/1", status: "no_memory" });
    renderWithClient(<KnowsFactsScreen />);
    expect(await screen.findByTestId("knows-empty")).toBeTruthy();
  });
});
