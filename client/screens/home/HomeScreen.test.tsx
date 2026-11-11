/**
 * HomeScreen.test — Home, the daily briefing (app layout B), rendered from served data. "What matters next" is read
 * through the REAL hook (use-what-matters-next) from the shared wire shape (shared/meSummaries WhatMattersNext); only
 * apiRequest is stubbed, so the 404 fallback and the error path are the hook's own.
 *
 *   new athlete    the hero; the early / unscored block; "Nothing waiting on you" + the line + the Plan link; no chips;
 *                  no shortcut rows
 *   active         the block (ring, read, confidence); the ranked list (clock first, five at most), each row opening
 *                  where it is handled; never an accept / decline / reply on Home; "See all N" → Opportunities
 *   states         loading; error with Try again; an older server (404) → the empty list
 *   Mila chips     frosted chips from open requests + imputed signals; each opens its flow; hidden when empty
 *   refresh        swipe down refetches the overview, the list, the chips and connections
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NextCandidate, WhatMattersNext } from "../../../shared/meSummaries";
import { HomeScreen, HOME_NEXT_ERROR } from "./HomeScreen";

const navigate = jest.fn();
const popTo = jest.fn();
const rootNavigate = jest.fn();
const root = { navigate: rootNavigate, popTo, getParent: () => undefined, getState: () => ({ routeNames: ["Tabs", "Brand"] }) };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate, getParent: () => root, setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "a1", firstName: "Sam", lastName: null } }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Polygon: Stub, Rect: Stub, Line: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub };
});

// The one stubbed seam: the API. `next` is what GET /what-matters-next answers (a body, or an Error the hook reads).
let next: WhatMattersNext | Error | "pending" = { version: "what-matters-next/0.1", items: [] };
const apiCalls: string[] = [];
jest.mock("../../lib/query-client", () => ({
  apiRequest: async (_m: string, route: string) => {
    apiCalls.push(route);
    if (route !== "/api/v1/me/what-matters-next") throw new Error(`unexpected ${route}`);
    if (next === "pending") return new Promise(() => {});
    if (next instanceof Error) throw next;
    const body = next;
    return { json: async () => body };
  },
}));

let overview: any = null;
let view: any = null;
let photos: any[] = [];
const refetched = jest.fn(async (_what: string) => undefined);
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeOverview: () => ({ data: overview, isLoading: false, isError: false, refetch: () => refetched("overview") }),
  useMePool: () => photos,
  useMePhotos: (limit = 4) => photos.slice(0, limit),
}));
let connections: any[] = [];
jest.mock("../../hooks/use-connections", () => ({ useConnections: () => ({ connections, isLoading: false, refetch: () => refetched("connections") }) }));
jest.mock("../../hooks/use-me-intelligence", () => ({
  useMeIntelligence: () => ({ data: view, isError: false, isRefetching: false, refetch: () => refetched("intelligence") }),
}));
let requests: any = { items: [], waiting: 0 };
jest.mock("../../hooks/use-intelligence-requests", () => ({ useIntelligenceRequests: () => ({ data: requests, isLoading: false, isError: false, refetch: () => refetched("requests") }) }));
const contractSheet = jest.fn();
jest.mock("../../components/deals/AddContractSheet", () => ({ AddContractSheet: (p: any) => { contractSheet(p); return null; } }));
const openMila = jest.fn();
jest.mock("../../lib/milaLaunch", () => ({ openMila: (...a: unknown[]) => openMila(...a) }));

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
  identity: { displayName: "Sam Example", fullName: "Sam Example", photoUrl: null, facts: [], role: null, nationality: null, primary: null },
  knows: { total: 3, categories: [] }, ...over,
});

const NOW = new Date("2026-10-08T12:00:00.000Z");
const cand = (key: string, kind: NextCandidate["kind"], over: Partial<NextCandidate> = {}): NextCandidate => ({
  key, kind, dueAt: null, at: null, order: null, title: null, brandName: null, logoUrl: null, amountCents: null, currency: null,
  target: { screen: "financials" }, ...over,
});
/** The active athlete's day, as the server serves it (unranked). */
const ACTIVE: WhatMattersNext = {
  version: "what-matters-next/0.1",
  items: [
    cand("paid:p1", "money_paid", { at: "2026-10-03T00:00:00.000Z", brandName: "Brand F", amountCents: 120_000, currency: "usd" }),
    cand("opp:o1", "deal_waiting", { at: "2026-10-07T00:00:00.000Z", brandName: "Brand A", target: { screen: "opportunity", opportunityId: "o1", dealId: "d1" } }),
    cand("booking:b1", "booking_request", { dueAt: "2026-10-09T06:00:00.000Z", title: "20-min video call", amountCents: 12_000, currency: "usd", target: { screen: "booking", id: "b1" } }),
    cand("opp:o2", "serious_offer", { at: "2026-10-06T00:00:00.000Z", brandName: "Brand D", amountCents: 5_000, currency: "usd", target: { screen: "opportunity", opportunityId: "o2", dealId: "d2" } }),
    cand("payout_setup", "payout_setup", { amountCents: 180_000, currency: "usd" }),
  ],
};
const DOORS = ["My Story", "What Nomila Knows", "My Intelligence", "My Strategy", "My Media", "My Picks", "My Nomi", "Settings"];

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><HomeScreen now={NOW} /></QueryClientProvider>);
}

beforeEach(() => {
  navigate.mockReset(); popTo.mockReset(); rootNavigate.mockReset(); contractSheet.mockReset(); openMila.mockReset(); refetched.mockClear();
  apiCalls.length = 0;
  next = { version: "what-matters-next/0.1", items: [] };
  overview = ov(); view = intelligenceView(); photos = []; connections = []; requests = { items: [], waiting: 0 };
  void require("@react-native-async-storage/async-storage").clear();
});

describe("a new athlete", () => {
  it("the hero, the early block, 'Nothing waiting on you' with its line and the Plan link; no chips; no shortcut rows", async () => {
    overview = ov({ intelligence: { status: "ready", pageState: "no_assessment", score: null, evidenceAsOf: null }, identity: { ...ov().identity, displayName: "Sam" } });
    view = null;
    renderHome();
    await waitFor(() => expect(screen.getByText("Nothing waiting on you")).toBeTruthy());
    const t = allText();
    expect(t).toMatch(/Good (morning|afternoon|evening),/); // the greeting follows the clock
    expect(t).toContain("Sam");
    expect(t).toContain("Build what's next.");
    expect(t).toContain("New deals, bookings and money will show here.");
    expect(t).not.toContain("612");
    expect(screen.getByTestId("home-intelligence")).toBeTruthy();
    expect(screen.queryByTestId("home-mila-chips")).toBeNull();
    expect(screen.queryByText(/See all/)).toBeNull();
    for (const d of DOORS) expect(screen.queryByText(d)).toBeNull();
    fireEvent.press(screen.getByText("Plan"));
    expect(navigate).toHaveBeenLastCalledWith("Strategy", { screen: "StrategyRoot", params: undefined });
    expect(apiCalls).toEqual(["/api/v1/me/what-matters-next"]);
  });
});

describe("an active athlete", () => {
  beforeEach(() => { next = ACTIVE; });

  it("the block: the ring, Nomila's read, the confidence line; opens My Intelligence; first name only", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-next")).toBeTruthy());
    const t = allText();
    expect(t).not.toContain("Sam Example");
    expect(screen.getByTestId("intelligence-ring")).toBeTruthy();
    expect(t).toContain("612");
    expect(t).toContain("Strongest in narrative power and brand fit.");
    expect(t).toContain("Nomila is confident in this read.");
    expect(t).toContain("Open My Intelligence");
    fireEvent.press(screen.getByTestId("home-intelligence"));
    expect(navigate).toHaveBeenLastCalledWith("Intelligence");
  });

  it("the list: five rows, clock first, then waiting newest first, then the money line; nothing answers", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId("next-row-booking:b1")).toBeTruthy());
    const rows = screen.UNSAFE_root.findAll((n: any) => typeof n.props?.testID === "string" && n.props.testID.startsWith("next-row-") && typeof n.type !== "string")
      .map((n: any) => n.props.testID).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    expect(rows).toEqual(["next-row-booking:b1", "next-row-opp:o1", "next-row-opp:o2", "next-row-payout_setup", "next-row-paid:p1"]);
    const t = allText();
    expect(t).toContain("Booking request: 20-min video call");
    expect(t).toContain("18h left to accept");
    expect(t).toContain("Brand A is waiting on you");
    expect(t).toContain("Serious offer from Brand D");
    expect(t).toContain("Opportunities · $50 held");
    expect(t).toContain("Set up payouts to get paid");
    expect(t).toContain("Money · $1,800 waiting for you");
    expect(t).toContain("$1,200 paid by Brand F");                 // news last
    for (const verb of ["Accept", "Decline", "Reply", "Not now"]) expect(screen.queryByText(verb)).toBeNull();
    expect(screen.queryByText(/See all/)).toBeNull();               // four waiting: no "See all"
    for (const d of DOORS) expect(screen.queryByText(d)).toBeNull();
    expect(screen.getByLabelText("Booking request: 20-min video call. Opportunities · Bookings. 18h left to accept")).toBeTruthy();
  });

  it("each row opens where it is handled", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId("next-row-opp:o1")).toBeTruthy());
    fireEvent.press(screen.getByTestId("next-row-opp:o1"));
    expect(navigate).toHaveBeenLastCalledWith("Opportunities", { screen: "DealDetail", params: { dealId: "d1" } });
    fireEvent.press(screen.getByTestId("next-row-booking:b1"));
    expect(navigate).toHaveBeenLastCalledWith("Opportunities", undefined);
    fireEvent.press(screen.getByTestId("next-row-payout_setup"));
    expect(navigate).toHaveBeenLastCalledWith("Opportunities", { screen: "Financials", params: undefined });
  });

  it("more than five waiting: 'See all N' opens Opportunities", async () => {
    next = { version: "what-matters-next/0.1", items: Array.from({ length: 7 }, (_, i) => cand(`opp:x${i}`, "deal_waiting", { brandName: `Brand ${i}`, at: `2026-10-0${i + 1}T00:00:00.000Z`, target: { screen: "opportunity", opportunityId: `x${i}`, dealId: null } })) };
    renderHome();
    await waitFor(() => expect(screen.getByText("See all 7")).toBeTruthy());
    fireEvent.press(screen.getByText("See all 7"));
    expect(navigate).toHaveBeenLastCalledWith("Opportunities", undefined);
  });
});

describe("an active athlete, today's server (8 Oct 2026: one row model with Opportunities)", () => {
  // As GET /what-matters-next answers now: each deal carries its card's next step, in the board's order, plus the count.
  const SERVED: WhatMattersNext = {
    version: "what-matters-next/0.1",
    waiting: 12,
    items: [
      cand("opp:o1", "deal_waiting", { order: 1, at: "2026-10-01T00:00:00.000Z", brandName: "Brand A", action: "confirm_signed", need: "Confirm it’s signed", why: "An e-signature email says every party has signed.", target: { screen: "opportunity", opportunityId: "o1", dealId: "d1" } }),
      cand("opp:o2", "deal_waiting", { order: 0, dueAt: "2026-10-12", at: "2026-09-30T00:00:00.000Z", brandName: "Brand B", action: "ask_for_terms", need: "Ask for terms", why: "Their ask: Two posts and a story.", target: { screen: "opportunity", opportunityId: "o2", dealId: "d2" } }),
      cand("opp:o3", "deal_waiting", { order: 2, at: "2026-10-07T00:00:00.000Z", brandName: "Brand C", action: "reply", need: "Reply", why: "Answer what your school needs. It isn’t a paid offer.", target: { screen: "opportunity", opportunityId: "o3", dealId: "d3" } }),
    ],
  };

  it("each deal row says what to do and why, a deadline in words; 'See all 12' is the Opportunities count", async () => {
    next = SERVED;
    renderHome();
    await waitFor(() => expect(screen.getByTestId("next-row-opp:o2")).toBeTruthy());
    const rows = screen.UNSAFE_root.findAll((n: any) => typeof n.props?.testID === "string" && n.props.testID.startsWith("next-row-") && typeof n.type !== "string")
      .map((n: any) => n.props.testID).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    // the dated one first (as the board orders it), then the board's order
    expect(rows).toEqual(["next-row-opp:o2", "next-row-opp:o1", "next-row-opp:o3"]);
    const t = allText();
    expect(t).toContain("Ask Brand B for terms");
    expect(t).toContain("Their ask: Two posts and a story.");
    expect(t).toContain("Respond by Oct 12");
    expect(t).toContain("Confirm Brand A is signed");
    expect(t).toContain("An e-signature email says every party has signed.");
    expect(t).toContain("Reply to Brand C");
    expect(t).not.toMatch(/is waiting on you/);
    expect(t).not.toMatch(/2026-10-12/);
    expect(screen.getByText("See all 12")).toBeTruthy();
  });
});

describe("states", () => {
  it("loading: a spinner where the list goes", () => {
    next = "pending";
    renderHome();
    expect(screen.getByTestId("home-next-loading")).toBeTruthy();
  });

  it("error: one line and Try again, which reads the list again", async () => {
    next = new Error("500: boom");
    renderHome();
    await waitFor(() => expect(screen.getByText(HOME_NEXT_ERROR)).toBeTruthy());
    next = ACTIVE;
    await act(async () => { fireEvent.press(screen.getByText("Try again")); });
    await waitFor(() => expect(screen.getByTestId("next-row-booking:b1")).toBeTruthy());
  });

  it("an older server (404): the empty list, never an error", async () => {
    next = new Error("404: Cannot GET");
    renderHome();
    await waitFor(() => expect(screen.getByText("Nothing waiting on you")).toBeTruthy());
    expect(screen.queryByText(HOME_NEXT_ERROR)).toBeNull();
  });
});

describe("Mila chips", () => {
  it("frosted chips from open requests + imputed signals; each opens its flow; never health", async () => {
    requests = { items: [
      { requestId: "r1", status: "open", sheAsked: "remind me", nomilaSays: "You asked me to prompt you for your contract.", cta: { kind: "add_contract", label: "Add contract" } },
      { requestId: "r2", status: "open", sheAsked: null, nomilaSays: "You asked me to prompt you for your performance data.", cta: { kind: "add_document", label: "Add document" } },
      { requestId: "hurt", status: "open", sheAsked: null, nomilaSays: "your injury report", cta: { kind: "add_document", label: "Add document" } },
    ], waiting: 3 };
    const v: any = intelligenceView(); v.assessment.dimensions[2].components = [{ key: "engagement_quality.video_retention", evidenceClass: "ASSUMED", confidence: null, rationale: null, sources: [] }]; view = v;
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-mila-chips")).toBeTruthy());
    expect(screen.getByTestId("home-mila-chip-add_contract")).toBeTruthy();
    expect(screen.getAllByTestId("frost-blur").length).toBe(3);
    expect(allText()).not.toMatch(/injur/i);
    fireEvent.press(screen.getByText("Add contract"));
    await waitFor(() => expect(contractSheet).toHaveBeenCalledWith(expect.objectContaining({ visible: true, requestId: "r1" })));
    fireEvent.press(screen.getByText("Connect insights"));
    expect(navigate).toHaveBeenLastCalledWith("Home", { screen: "Settings" });
    fireEvent.press(screen.getByText("Share performance data"));
    expect(openMila).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.stringMatching(/performance data/) }));
  });
});

describe("refresh", () => {
  it("swipe down reads the overview, the score, the list, the chips and connections again", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-next")).toBeTruthy());
    const rc = () => screen.UNSAFE_root.findAll((n: any) => !!n.props?.refreshControl)[0].props.refreshControl;
    const before = apiCalls.length;
    await act(async () => { rc().props.onRefresh(); });
    expect(refetched.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["overview", "intelligence", "requests", "connections"]));
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(before));
  });
});
