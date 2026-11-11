/**
 * MeScreen.test — Me, "who you are and how the world sees you" (app layout B), rendered from served data only.
 *
 *   order       hero → the Nomi Card slot → the compact M.I.A. row → My Story · What Nomila Knows · My Media · My Picks →
 *               Settings. No My Strategy (Strategy has its tab), no rail, no chips, no second score block
 *   card slot   EXPO_PUBLIC_PUBLIC_CARD off: the existing My Nomi row → Brand › Deck; on: "Your public card" from
 *               GET /me/public-card/draft (lib/publicCardApi stubbed), its rows opening Review, Preview and Card settings;
 *               no view count (the server has none)
 *   M.I.A.      the ring with the number, the one-line read → My Intelligence; no score → no number
 *   new         a new athlete: every row there from day one, each with a plain line about what is missing
 *   reachable   every place a removed Home shortcut went is reachable from Me (Story, Knows, Intelligence, Media,
 *               Picks, Nomi, Settings)
 *   never       "verified", a trend glyph, a dimension number
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { renderWithClient } from "./__fixtures__/renderWithClient";
import { NEW_DRAFT } from "./__fixtures__/publicCard";

const navigate = jest.fn();
const popTo = jest.fn();
const rootNavigate = jest.fn();
let rootNames: string[] = ["Tabs", "Brand"];
const root = { navigate: rootNavigate, popTo, getParent: () => undefined, getState: () => ({ routeNames: rootNames }) };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate, getParent: () => root, setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
let authAthlete: any = { id: "a1", firstName: "Sam", lastName: null, sport: "Soccer" };
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: authAthlete }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub };
});
// What Mila can do reads its own route (react-query; cards/kit/kit.test.tsx covers it): not drawn here.
jest.mock("../../components/mila/cards/kit/ScreenCards", () => ({ MeWhatMilaCanDo: () => null }));
// The build flags Me reads, switchable per test (the rest of lib/flags is the real module).
const flags = { PUBLIC_CARD: false, SHOP_V1: true, AGENT_V3: false };
jest.mock("../../lib/flags", () => {
  const actual = jest.requireActual("../../lib/flags");
  return {
    ...actual,
    get PUBLIC_CARD() { return flags.PUBLIC_CARD; },
    get SHOP_V1() { return flags.SHOP_V1; },
    get AGENT_V3() { return flags.AGENT_V3; },
  };
});
// "Meet Mila" (fix/existing-users-skip-onboarding): MeetMilaDoor's own read, mounted only while AGENT_V3 is on. Every
// other export of this module (e.g. useStudioItems, read by PublishedSection — also mounted only behind AGENT_V3)
// stays real, so only the one read this suite cares about is faked.
let everStarted: boolean | undefined = false;
jest.mock("../../lib/agent/hooks", () => ({
  ...jest.requireActual("../../lib/agent/hooks"),
  useAgentOnboarding: () => ({ data: { everStarted } }),
  useStudioItems: () => ({ data: [] }),
}));

let overview: any = null;
let story: any = null;
let view: any = null;
let photos: any[] = [];
const refetched = jest.fn(async (_what: string) => undefined);
let overviewState = { isLoading: false, isError: false };
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeOverview: () => ({ data: overview, ...overviewState, refetch: () => refetched("overview") }),
  useMePool: () => photos,
  useMePhotos: (limit = 4) => photos.slice(0, limit),
}));
// Her public card: the API layer only; the section's real hook runs on a real query client.
const cardApi = { getDraft: jest.fn(async () => NEW_DRAFT), publicBase: () => "https://api.example.test" };
jest.mock("../../lib/publicCardApi", () => ({ get publicCardApi() { return cardApi; } }));
jest.mock("../../hooks/use-me-story", () => ({ useMeStory: () => ({ data: story, isLoading: false, refetch: () => refetched("story") }) }));
jest.mock("../../hooks/use-me-intelligence", () => ({
  useMeIntelligence: () => ({ data: view, isError: false, isRefetching: false, refetch: () => refetched("intelligence") }),
}));

import { MeScreen, MeClassicScreen } from "./MeScreen";

const KEYS = ["athletic_authority", "audience_scale", "engagement_quality", "cultural_relevance", "narrative_power", "brand_fit", "commercial_proof", "momentum"];
const STATES: Record<string, string> = { narrative_power: "strength", brand_fit: "strength" };
const emptySources = () => ({ grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] });
const intelligenceView = () => ({
  contract: "my-intelligence/0.1", athleteId: "a", asOf: "2026-10-01T00:00:00.000Z", pageState: "assessed", identity: null, inProgress: false,
  movement: { displayable: false, reason: "no_governed_stability_threshold" }, bridge: { waitingOnYou: null, goals: null, reviewCount: null },
  assessment: {
    entryId: "e", evidenceAsOf: "2026-09-29T00:00:00.000Z", createdAt: "2026-09-29T00:00:00.000Z", versions: { methodology: "m", evaluator: "e", params: "p" },
    score: 612, readState: "assessed", overall: { level: "HIGH", explanation: "x" }, confidenceBand: null, summary: "s", hasReasons: true,
    dimensions: KEYS.map((k) => ({ key: k, state: STATES[k] ?? "neutral", score: 77, confidence: "HIGH", confidenceReason: null, rationale: "r", components: [], sources: emptySources() })),
    evidence: [], notes: { strengths: [], constraints: [], missingEvidence: [], evaluationRisks: [] },
  },
});
const ov = (over: any = {}) => ({
  version: "knowledge/2.1", athleteId: "a", story: { status: "coming" },
  intelligence: { status: "ready", pageState: "assessed", score: 612, evidenceAsOf: "2026-09-29T00:00:00.000Z" },
  identity: {
    displayName: "Sam Example", fullName: "Sam Example", photoUrl: null, facts: ["Midfielder", "Senior"], role: "Captain", nationality: "Testland",
    primary: { label: "Example Soccer", org: "Example University", orgKind: "school", sport: "Soccer", source: null },
  },
  knows: { total: 3, categories: [] }, ...over,
});
const READY = {
  pageState: "ready",
  essence: { short: "Athlete and builder.", long: "An athlete and builder at the meeting point of sport and technology." },
  positioning: { current: { short: "Known for building while competing.", long: "Long." }, desired: { value: "Working where sport meets technology." } },
};
const LEARNING = { pageState: "learning", essence: null, positioning: { current: null, desired: null } };
const photo = (id: string) => ({ asset_id: id, url: `https://example.test/${id}.jpg`, thumb_url: null, origin: "connected" });

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");
const ROWS = ["My Nomi", "Your public card", "My Intelligence", "My Story", "What Nomila Knows", "My Media", "My Picks", "Settings", "My Strategy", "What matters next", "Meet Mila"];
const rows = () => texts(screen.toJSON()).filter((s) => ROWS.includes(s));
const NOW = new Date(2026, 9, 1, 9);

beforeEach(() => {
  navigate.mockReset(); popTo.mockReset(); rootNavigate.mockReset(); refetched.mockClear();
  overview = ov(); story = READY; view = intelligenceView(); photos = []; rootNames = ["Tabs", "Brand"];
  flags.PUBLIC_CARD = false; flags.SHOP_V1 = true; flags.AGENT_V3 = false; overviewState = { isLoading: false, isError: false };
  authAthlete = { id: "a1", firstName: "Sam", lastName: null, sport: "Soccer" }; everStarted = false;
  void require("@react-native-async-storage/async-storage").clear();
});

describe("an active athlete", () => {
  it("the order: hero, My Nomi, the M.I.A. row, Story · Knows · Media · Picks, Settings — no My Strategy, no Home briefing", () => {
    render(<MeScreen now={NOW} />);
    expect(rows()).toEqual(["My Nomi", "My Intelligence", "My Story", "What Nomila Knows", "My Media", "My Picks", "Settings"]);
    const t = allText();
    expect(t).toContain("Good morning,");
    expect(t).toContain("Sam Example");
    expect(t).toContain("Example Soccer");
    expect(t).toContain("Captain · Midfielder · Senior");
    expect(t).toContain("Testland");
    expect(t).not.toContain("Build what's next.");
    expect(screen.queryByTestId("home-next")).toBeNull();
    expect(screen.queryByTestId("home-mila-chips")).toBeNull();
    expect(screen.queryByTestId("home-intelligence")).toBeNull();   // the score block is Home's alone
    expect(screen.getByLabelText("Back")).toBeTruthy();
  });

  it("the M.I.A. row: the ring with the number, the one-line read, no '/ 850'; opens My Intelligence", () => {
    render(<MeScreen now={NOW} />);
    const t = allText();
    expect(screen.getAllByTestId("intelligence-ring")).toHaveLength(1);
    expect(t).toContain("612");
    expect(t).not.toContain("/ 850");
    expect(t).not.toContain("of 850");
    expect(t).toContain("Strongest in narrative power and brand fit.");
    expect(screen.getByLabelText("My Intelligence, M.I.A. 612 out of 850. Strongest in narrative power and brand fit.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("me-mia"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");
  });

  it("every door a Home shortcut used to open is here, and opens the same place (the shell)", () => {
    render(<MeScreen now={NOW} />);
    fireEvent.press(screen.getByText("My Story"));
    expect(navigate).toHaveBeenLastCalledWith("Story");
    fireEvent.press(screen.getByText("What Nomila Knows"));
    expect(navigate).toHaveBeenLastCalledWith("Knows", {});
    fireEvent.press(screen.getByText("My Intelligence"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");
    fireEvent.press(screen.getByText("My Media"));
    expect(navigate).toHaveBeenLastCalledWith("Studio", { screen: "MediaLibrary", params: undefined });
    fireEvent.press(screen.getByText("My Picks"));
    expect(navigate).toHaveBeenLastCalledWith("Picks");
    fireEvent.press(screen.getByText("My Nomi"));
    expect(rootNavigate).toHaveBeenLastCalledWith("Brand", { screen: "Deck", params: undefined });
    fireEvent.press(screen.getByText("Settings"));
    expect(navigate).toHaveBeenLastCalledWith("Home", { screen: "Settings" });
    expect(popTo).not.toHaveBeenCalled();
  });

  it("photos: the hero, then each slot its own photo, never twice; past the pool the icon tile", () => {
    photos = ["hero", "b", "c"].map(photo);
    render(<MeScreen now={NOW} />);
    const uris = screen.UNSAFE_queryAllByType(require("react-native").Image).map((i: any) => i.props.source?.uri).filter(Boolean);
    expect(uris).toEqual(["https://example.test/hero.jpg", "https://example.test/b.jpg", "https://example.test/c.jpg"]);
    expect(allText()).toContain("icon:search");   // What Nomila Knows: the pool ran out
  });

  it("never: verified, a trend glyph, a dimension number", () => {
    render(<MeScreen now={NOW} />);
    const t = allText();
    expect(t.toLowerCase()).not.toContain("verified");
    expect(t).not.toMatch(/icon:(bar-chart|bar-chart-2|trending-up|check-circle)/);
    expect(t).not.toMatch(/(^|\| )77( \||$)/);
  });

  it("swipe down reads the overview, the story and the score again", async () => {
    render(<MeScreen now={NOW} />);
    const rc = screen.UNSAFE_root.findAll((n: any) => !!n.props?.refreshControl)[0].props.refreshControl;
    await act(async () => { rc.props.onRefresh(); });
    expect(refetched.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["overview", "story", "intelligence"]));
  });
});

describe("a new athlete", () => {
  it("every row from day one with a plain line: Story coming soon (not tappable), Media 'Add photos', no number on M.I.A.", () => {
    overview = ov({ intelligence: { status: "ready", pageState: "no_assessment", score: null, evidenceAsOf: null }, identity: { displayName: "Sam", fullName: "Sam", photoUrl: null, facts: [], role: null, nationality: null, primary: null } });
    story = LEARNING; view = null; photos = [];
    render(<MeScreen now={NOW} />);
    expect(rows()).toEqual(["My Nomi", "My Intelligence", "My Story", "What Nomila Knows", "My Media", "My Picks", "Settings"]);
    const t = allText();
    expect(t).toContain("Tell Nomila your team and sport to fill this in.");
    expect(t).toContain("Coming soon");
    expect(t).toContain("Add photos");
    expect(t).not.toContain("612");
    expect(screen.getByTestId("me-hero-blank")).toBeTruthy();
    fireEvent.press(screen.getByText("My Story"));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("me-mia"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");   // My Intelligence stays reachable before a score
  });

  it("the slot withholds a score: no number, the state's headline", () => {
    overview = ov({ intelligence: { status: "ready", pageState: "identity_failed", score: null, evidenceAsOf: null } }); view = null;
    render(<MeScreen now={NOW} />);
    expect(allText()).not.toContain("612");
    expect(allText()).toContain("We couldn't confirm your public identity");
  });
});

describe("states", () => {
  it("the overview fails: Retry on the hero reads it again; the doors stay reachable", () => {
    overview = null; overviewState = { isLoading: false, isError: true };
    render(<MeScreen now={NOW} />);
    fireEvent.press(screen.getByText("Retry"));
    expect(refetched).toHaveBeenCalledWith("overview");
    fireEvent.press(screen.getByText("What Nomila Knows"));
    expect(navigate).toHaveBeenLastCalledWith("Knows", {});
    fireEvent.press(screen.getByTestId("me-mia"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");
  });

  it("loading: the hero's loading state; the rows are drawn", () => {
    overview = null; overviewState = { isLoading: true, isError: false };
    render(<MeScreen now={NOW} />);
    expect(rows()).toEqual(["My Nomi", "My Intelligence", "My Story", "What Nomila Knows", "My Media", "My Picks", "Settings"]);
  });
});

describe("the Nomi Card slot", () => {
  it("PUBLIC_CARD on: 'Your public card' from the draft; its rows open its screens; My Nomi not drawn twice; no views", async () => {
    flags.PUBLIC_CARD = true;
    renderWithClient(<MeScreen now={NOW} />);
    expect(screen.getByTestId("me-public-card")).toBeTruthy();
    expect(await screen.findByText("Draft")).toBeTruthy();
    expect(screen.queryByText("My Nomi")).toBeNull();
    const t = allText();
    expect(t).toContain("Your public card");
    expect(t).not.toMatch(/views/i);
    fireEvent.press(screen.getByLabelText(/^Review & publish/));
    expect(navigate).toHaveBeenLastCalledWith("PublicCardReview");
    fireEvent.press(screen.getByLabelText(/^Preview as a visitor/));
    expect(navigate).toHaveBeenLastCalledWith("PublicCardPreview");
    fireEvent.press(screen.getByLabelText(/^Card settings/));
    expect(navigate).toHaveBeenLastCalledWith("PublicCardSettings");
  });

  it("SHOP_V1 off: no My Picks", () => {
    flags.SHOP_V1 = false;
    render(<MeScreen now={NOW} />);
    expect(screen.queryByText("My Picks")).toBeNull();
    expect(rows()).toEqual(["My Nomi", "My Intelligence", "My Story", "What Nomila Knows", "My Media", "Settings"]);
  });
});

describe("Meet Mila (fix/existing-users-skip-onboarding: on request only, never auto-shown)", () => {
  it("AGENT_V3 off: never drawn (and its own read, useAgentOnboarding, is never mounted)", () => {
    render(<MeScreen now={NOW} />);
    expect(screen.queryByText("Meet Mila")).toBeNull();
  });

  // The rest render MeClassicScreen directly: AGENT_V3 also switches MeScreen's OWN gate to the agent memory screen
  // (MeAgentGate, a different read), which is out of scope here — the door lives inside MeClassicScreen regardless
  // of which screen the top-level AGENT_V3 gate lands on.
  it("AGENT_V3 on, name and sport known, never started: drawn first among the doors; opens MeetMila", () => {
    flags.AGENT_V3 = true;
    render(<MeClassicScreen now={NOW} />);
    expect(rows()).toEqual(["My Nomi", "My Intelligence", "Meet Mila", "My Story", "What Nomila Knows", "My Media", "My Picks", "Settings"]);
    fireEvent.press(screen.getByText("Meet Mila"));
    expect(navigate).toHaveBeenLastCalledWith("MeetMila");
  });

  it("AGENT_V3 on but already started (everStarted: true): not drawn — she already has the conversation to resume", () => {
    flags.AGENT_V3 = true; everStarted = true;
    render(<MeClassicScreen now={NOW} />);
    expect(screen.queryByText("Meet Mila")).toBeNull();
  });

  it("AGENT_V3 on but no sport on her row yet: not drawn (autoStart needs it)", () => {
    flags.AGENT_V3 = true; authAthlete = { ...authAthlete, sport: null };
    render(<MeClassicScreen now={NOW} />);
    expect(screen.queryByText("Meet Mila")).toBeNull();
  });

  it("AGENT_V3 on, the read not landed yet (everStarted: undefined): not drawn — never shown on a guess", () => {
    flags.AGENT_V3 = true; everStarted = undefined;
    render(<MeClassicScreen now={NOW} />);
    expect(screen.queryByText("Meet Mila")).toBeNull();
  });
});
