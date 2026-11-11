/**
 * BrandTabScreen.test — the Brand header chip and the "Score" door now read the modern ledger
 * score (my-intelligence/0.1, via GET /me/overview), never the legacy
 * athletes_current.display_score/tier.
 *
 * Covers:
 *   - the modern score renders in the header chip and the door's meta line, with no legacy tier
 *     text ("· Established")
 *   - a withheld page (identity ambiguous/failed, or no assessment) shows the existing empty
 *     treatment in both places and never a number
 *   - legacy retirement, phase 1: the Score door opens My Intelligence, and the Rates door is
 *     "Your floor" (OPPS_V2 off; "Your rates" with it on) with no projected annual value
 *
 * Every other child surface (NomiCardHero, Facts/Story/Growth tabs, objectives) is stubbed —
 * not under test here.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { BrandTabScreen } from "./BrandTabScreen";
import type { MeOverview } from "../../hooks/use-me-knowledge";

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => <Text>{`icon:${name}`}</Text> };
});
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});
const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate, setParams: jest.fn(), getParent: () => ({ navigate: jest.fn() }) }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("../../components/brand/NomiCardHero", () => ({ NomiCardHero: () => null }));
jest.mock("./FactsTab", () => ({ FactsTab: () => null }));
jest.mock("./StoryTab", () => ({ StoryTab: () => null }));
jest.mock("../../components/analytics/AnalyticsTab", () => ({ AnalyticsTab: () => null }));
// BrandHeader reads the Classic layout switch (AsyncStorage) for where the Me avatar sits; default OFF here.
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ athlete: { id: "a1", firstName: "Test", lastName: "Athlete" } }),
}));
jest.mock("../../hooks/use-athlete-record", () => ({
  useAthleteRecord: () => ({
    data: { header: { name: "Test Athlete", identityLine: "Soccer · Stanford", displayScore: null, tier: null, photoUrl: null } },
    refetch: jest.fn(),
  }),
}));
jest.mock("../../hooks/use-card", () => ({ useShares: () => ({ totalOpens: 0 }) }));

let overview: { data: MeOverview | undefined };
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeOverview: () => ({ ...overview, refetch: jest.fn() }),
}));

const baseOverview = (intelligence: MeOverview["intelligence"]): MeOverview => ({
  version: "knowledge/2.1",
  athleteId: "a1",
  identity: { displayName: "Test Athlete", fullName: "Test Athlete", photoUrl: null, primary: null, facts: [] },
  knows: { total: 0, categories: [] },
  intelligence,
  story: { status: "coming" },
});

describe("BrandTabScreen — header chip and Score door", () => {
  it("shows the modern score, with no legacy tier text", () => {
    overview = { data: baseOverview({ status: "ready", pageState: "assessed", score: 640, evidenceAsOf: "2026-09-20T00:00:00.000Z" }) };
    render(<BrandTabScreen />);
    // The header chip (just the number — BrandHeader never renders tier as text).
    expect(screen.getByText("640")).toBeTruthy();
    // The "Score" door's meta line.
    expect(screen.getByText("640 of 850")).toBeTruthy();
    expect(screen.queryByText(/Established/)).toBeNull();
  });

  it("withholds the score when the page withholds it — no number, existing empty treatment", () => {
    overview = { data: baseOverview({ status: "ready", pageState: "identity_ambiguous", score: null, evidenceAsOf: null }) };
    render(<BrandTabScreen />);
    expect(screen.queryByText("640")).toBeNull();
    expect(screen.queryByText("640 of 850")).toBeNull();
    // BrandHeader's pending chip ("Score", no dot/number) and the door's empty meta.
    expect(screen.getAllByText("Score").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Not computed yet")).toBeTruthy();
  });
});

describe("BrandTabScreen — legacy retirement, phase 1", () => {
  it("the Score door opens My Intelligence (Home › Intelligence)", () => {
    overview = { data: baseOverview({ status: "ready", pageState: "assessed", score: 640, evidenceAsOf: "2026-09-20T00:00:00.000Z" }) };
    mockNavigate.mockClear();
    render(<BrandTabScreen />);
    fireEvent.press(screen.getByText("640 of 850"));
    expect(mockNavigate).toHaveBeenCalledWith("Home", { screen: "Intelligence" });
    expect(mockNavigate).not.toHaveBeenCalledWith("Score");
  });

  it("the Rates door (OPPS_V2 off, as in prod) is her floor, with no projected annual value", () => {
    overview = { data: baseOverview({ status: "ready", pageState: "assessed", score: 640, evidenceAsOf: "2026-09-20T00:00:00.000Z" }) };
    render(<BrandTabScreen />);
    expect(screen.getByText("Your floor")).toBeTruthy();
    expect(screen.getByText("The least you'll take, per deal type")).toBeTruthy();
    expect(screen.queryByText(/projected/i)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});
