/**
 * MeAgentScreen.test — Me on the agent memory (AGENT_V3), over the REAL hooks; only lib/meMemoryApi, lib/publicCardApi
 * and the photo pool are stubbed. And MeScreen's gate: the agent Me only with AGENT_V3 on and her memory served.
 *
 *   order      her public page mini (her own view: the metrics rail) → the Scouting report → What Nomila knows; no
 *              greeting, no Settings row (Settings live only in the gear)
 *   mini       the whole card opens her full page; Edit opens it in Edit mode
 *   scouting   the statement, "College · Developing", the identity line, M.I.A. → My Intelligence, Working for you /
 *              Room to grow (top two) with "2 things not on record yet", What defines you in plain sentences, Your brands
 *              (Current / Past) and the conflict line
 *   sheets     the read in detail opens with the biggest upside and risk, then every note; brands show "Since 2024" or
 *              "confirmed 3 Oct"; defines lists the pillars
 *   knows      "12 facts · 1 couldn't confirm" → What Nomila knows
 *   gate       flag off → the classic Me; on + no_memory → the classic Me; on + a report → the agent Me
 *   copy       never "AI"
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { CONTENT_DRAFT, PREVIEW } from "./__fixtures__/publicCard";
import { REPORT } from "./__fixtures__/scouting";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub, G: Stub };
});
jest.mock("../../components/mila/MilaAvatar", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { MilaAvatar: () => React.createElement(View, { testID: "mila-loop" }) };
});
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const navigate = jest.fn();
const goBack = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack, getParent: () => undefined, setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "a1", firstName: "Sam", lastName: null } }) }));
const flags = { AGENT_V3: true, PUBLIC_CARD: true };
jest.mock("../../lib/flags", () => {
  const actual = jest.requireActual("../../lib/flags");
  return { ...actual, get AGENT_V3() { return flags.AGENT_V3; }, get PUBLIC_CARD() { return flags.PUBLIC_CARD; } };
});
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMePool: () => [],
  useMePhotos: () => [],
  useMeOverview: () => ({ data: null, isLoading: false, isError: false, refetch: async () => undefined }),
}));
// The classic Me's own parts that read other routes (their suites cover them).
jest.mock("../../components/agent/PublishedSection", () => ({ PublishedSection: () => null }));
jest.mock("../../components/bookings/BookingsSetupDoor", () => ({ BookingsSetupDoor: () => null }));
jest.mock("../../hooks/use-me-story", () => ({ useMeStory: () => ({ data: null, isLoading: false, refetch: async () => undefined }) }));
jest.mock("../../hooks/use-me-intelligence", () => ({ useMeIntelligence: () => ({ data: null, isError: false, refetch: async () => undefined }) }));
const card = {
  getDraft: jest.fn(async () => CONTENT_DRAFT), getPreview: jest.fn(async () => PREVIEW), saveDecisions: jest.fn(), publish: jest.fn(), unpublish: jest.fn(),
  setSwitches: jest.fn(), setHandle: jest.fn(), publicBase: () => "https://api.example.test",
};
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return card; } }));
const mem = {
  getScouting: jest.fn(async (): Promise<any> => REPORT),
  getPageMetrics: jest.fn(async () => ({ windowDays: 30, since: "2026-09-11", views: 612, likes: 48, requests: 3, bookings: 1, shop: 9 })),
  pickAtmosphere: jest.fn(async () => { throw new Error("404: {}"); }),
};
jest.mock("../../lib/meMemoryApi", () => ({ get meMemoryApi() { return mem; } }));

import { MeAgentScreen } from "./MeAgentScreen";
import { MeScreen } from "./MeScreen";

beforeEach(() => {
  jest.clearAllMocks();
  flags.AGENT_V3 = true; flags.PUBLIC_CARD = true;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  mem.getScouting.mockResolvedValue(REPORT);
});

const NOW = new Date("2026-10-10T09:00:00Z");

describe("the agent Me", () => {
  it("her page mini, then the Scouting report, then What Nomila knows; no Settings row, no greeting", async () => {
    renderWithClient(<MeAgentScreen report={REPORT} />);
    const mini = await screen.findByTestId("public-page-mini");
    expect(within(mini).getByText("Your public page")).toBeTruthy();
    expect(await within(mini).findByTestId("front-door-metrics")).toBeTruthy();
    expect(within(mini).queryByTestId("front-door-like")).toBeNull();
    expect(screen.getByTestId("scout-statement").props.children).toBe(REPORT.hero.statement);
    expect(screen.getByTestId("scout-stage").props.children).toBe("College · Developing");
    expect(screen.getByTestId("scout-identity").props.children).toBe("Team Example · Second slot · Junior");
    expect(screen.getByTestId("scout-not-yet").props.children).toBe("2 things not on record yet");
    expect(within(screen.getByTestId("scout-working")).getByText("Engagement runs above your level.")).toBeTruthy();
    expect(within(screen.getByTestId("scout-growth")).getByText("Few paid partnerships on record.")).toBeTruthy();
    expect(screen.getByText(/Known for results\./)).toBeTruthy();
    expect(screen.getByTestId("scout-to")).toBeTruthy();
    expect(screen.getByTestId("scout-conflict")).toBeTruthy();
    expect(within(screen.getByTestId("me-knows-door")).getByText("12 facts · 1 couldn't confirm")).toBeTruthy();
    expect(screen.queryByText("Settings")).toBeNull();
    expect(screen.queryByText(/Good (morning|afternoon|evening)/)).toBeNull();
    expect(screen.queryByText(/\bAI\b/)).toBeNull();
  });

  it("the whole mini opens her page; Edit opens it in Edit; M.I.A. and the Knows door go where they're handled", async () => {
    renderWithClient(<MeAgentScreen report={REPORT} />);
    fireEvent.press(await screen.findByTestId("public-page-mini-open"));
    expect(navigate).toHaveBeenLastCalledWith("PublicPage");
    fireEvent.press(screen.getByTestId("public-page-mini-edit"));
    expect(navigate).toHaveBeenLastCalledWith("PublicPage", { edit: true });
    fireEvent.press(screen.getByTestId("scout-mia"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");
    fireEvent.press(screen.getByLabelText("What Nomila knows"));
    expect(navigate).toHaveBeenLastCalledWith("KnowsFacts");
  });

  it("the read in detail opens with the biggest upside and risk, then every note", async () => {
    renderWithClient(<MeAgentScreen report={REPORT} />);
    fireEvent.press(screen.getByTestId("scout-notes-summary"));
    const sheet = within(await screen.findByTestId("me-sheet-notes"));
    expect(sheet.getByText("Your read in detail")).toBeTruthy();
    const ur = within(sheet.getByTestId("scout-upside-risk"));
    expect(ur.getByText("The comeback story opens bigger brands.")).toBeTruthy();
    expect(ur.getByText("A quiet off-season could cost reach.")).toBeTruthy();
    expect(sheet.getByTestId("scout-notes-missing")).toBeTruthy();
    expect(sheet.getByText("Season results")).toBeTruthy();
    fireEvent.press(sheet.getByTestId("detail-sheet-close"));
    expect(screen.queryByTestId("me-sheet-notes")).toBeNull();
  });

  it("your brands: Current and Past, Since <year> or confirmed <date>, and the conflict", async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      renderWithClient(<MeAgentScreen report={REPORT} />);
      fireEvent.press(screen.getByTestId("scout-brands"));
      const sheet = within(await screen.findByTestId("me-sheet-brands"));
      expect(sheet.getByText("Since 2024")).toBeTruthy();
      expect(sheet.getByText("confirmed 3 Oct")).toBeTruthy();
      expect(sheet.getByText("Brand One and Brand Three sell in the same category. Rules out Brand Three.")).toBeTruthy();
    } finally { jest.useRealTimers(); }
  });

  it("what defines you: the pillars, each on atmosphere or its category default", async () => {
    renderWithClient(<MeAgentScreen report={REPORT} />);
    fireEvent.press(screen.getByTestId("scout-defines-open"));
    const sheet = within(await screen.findByTestId("me-sheet-defines"));
    expect(sheet.getByText("Comeback")).toBeTruthy();
    expect(sheet.getByText("Captain.")).toBeTruthy();
    expect(within(screen.getByTestId("scout-pillar-pillar_1")).getByTestId("scout-pillar-img-pillar_1-default")).toBeTruthy();
  });

  it("with PUBLIC_CARD off, the existing card row instead of the mini", async () => {
    flags.PUBLIC_CARD = false;
    renderWithClient(<MeAgentScreen report={REPORT} />);
    expect(screen.getByTestId("me-nomi")).toBeTruthy();
    expect(screen.queryByTestId("public-page-mini")).toBeNull();
  });
});

describe("MeScreen's gate", () => {
  it("AGENT_V3 on and her memory served → the agent Me", async () => {
    renderWithClient(<MeScreen now={NOW} />);
    expect(await screen.findByTestId("me-agent")).toBeTruthy();
  });

  it("AGENT_V3 on but no memory yet → the classic Me", async () => {
    mem.getScouting.mockResolvedValue({ contract: "scouting/1", status: "no_memory" });
    renderWithClient(<MeScreen now={NOW} />);
    await waitFor(() => expect(screen.queryByTestId("me-loading")).toBeNull(), { timeout: 5000 });
    expect(screen.queryByTestId("me-agent")).toBeNull();
    expect(screen.getByTestId("me-mia")).toBeTruthy();
  });

  it("AGENT_V3 on but the read fails → the classic Me", async () => {
    mem.getScouting.mockRejectedValue(new Error("500: {}"));
    renderWithClient(<MeScreen now={NOW} />);
    await waitFor(() => expect(screen.queryByTestId("me-loading")).toBeNull(), { timeout: 5000 });
    expect(screen.queryByTestId("me-agent")).toBeNull();
  });

  it("AGENT_V3 off → the classic Me, and the scouting route is never asked", async () => {
    flags.AGENT_V3 = false;
    renderWithClient(<MeScreen now={NOW} />);
    expect(screen.getByTestId("me-mia")).toBeTruthy();
    expect(screen.queryByTestId("me-agent")).toBeNull();
    expect(mem.getScouting).not.toHaveBeenCalled();
  });
});
