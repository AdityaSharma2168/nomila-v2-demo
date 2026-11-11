/**
 * MyIntelligenceScreen.test — the 6b landing renders the view as served, and Me's card keeps parity with it.
 *
 *   assessed: the number ONCE (in the ring; the hero carries only the title), the templated read, the confidence line;
 *             the marketable rows are Identity Intelligence's differentiators (no number, no brand paired with a score);
 *             strengths / growth are non-imputed sub-signals (the health-sensitive and measurement-quality ones never);
 *             help rows only for what she can resolve (no connect row once an insights account is connected); the
 *             three doors; no dimension number, no M.I.A. prose
 *   identity hold: the heading + reason body, no number, no identity action (D-2, O-6)
 *   updating with a read: the D-1 quiet line; without one: the assessing message
 *   0.1 server (no signals, no contributions): the score card and the doors only — nothing invented
 *   Me: the number appears only when the overview slot carries one
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { MyIntelligenceScreen } from "./MyIntelligenceScreen";
import { MeScreen } from "./MeScreen";

const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate, getParent: () => null, getState: () => ({ routeNames: ["Brand"] }), setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
// What Mila can do reads its own route (react-query; cards/kit/kit.test.tsx covers it): not drawn here.
jest.mock("../../components/mila/cards/kit/ScreenCards", () => ({ MeWhatMilaCanDo: () => null }));
// MeScreen carries the shell's top-bar actions (Home mode): the avatar reads auth + the Classic layout store.
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "a1", firstName: "Sam", lastName: null } }) }));
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Circle: Stub, Line: Stub, Path: Stub, Polygon: Stub, Rect: Stub, ClipPath: Stub, Text: Stub, Defs: Stub, LinearGradient: Stub, Stop: Stub };
});
const openMila = jest.fn();
jest.mock("../../lib/milaLaunch", () => ({ openMila: (...a: unknown[]) => openMila(...a) }));

let view: any = null;
let overview: any = null;
let story: any = null;
let connections: any[] = [];
jest.mock("../../hooks/use-me-intelligence", () => ({
  useMeIntelligence: () => ({ data: view, isError: false, isRefetching: false, refetch: () => {} }),
}));
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeOverview: () => ({ data: overview, isLoading: false, isError: false, refetch: () => {} }),
  useMePool: () => [],
}));
jest.mock("../../hooks/use-connections", () => ({ useConnections: () => ({ connections, isLoading: false, refetch: () => {} }) }));
// The Me card test renders MeScreen, which (as Home) also reads the rail and the chips; neither is under test here.
jest.mock("../../hooks/use-intelligence-requests", () => ({ useIntelligenceRequests: () => ({ data: { items: [], waiting: 0 }, isLoading: false, isError: false }) }));
jest.mock("../../hooks/use-me-story", () => ({ useMeStory: () => ({ data: story, isLoading: false }) }));

const KEYS = ["athletic_authority", "audience_scale", "engagement_quality", "cultural_relevance", "narrative_power", "brand_fit", "commercial_proof", "momentum"];
const STATES: Record<string, string> = { narrative_power: "strength", brand_fit: "strength", audience_scale: "gap", momentum: "unknown" };
const SCORES: Record<string, number> = { athletic_authority: 71, audience_scale: 32, engagement_quality: 73, cultural_relevance: 52, narrative_power: 86, brand_fit: 82, commercial_proof: 69 };
const WEIGHT = 0.125;
const sig = (key: string, value: number | null) => ({ key, value, source: value == null ? "imputed" : "web_researched", imputed: value == null });
const SIGNALS: Record<string, any[]> = {
  narrative_power: [sig("narrative_power.distinctiveness", 92), sig("narrative_power.evidence_authenticity", 94)],
  brand_fit: [sig("brand_fit.brand_safety", 98), sig("brand_fit.identity_values_coherence", 91)],
  commercial_proof: [sig("commercial_proof.brand_quality", 90), sig("commercial_proof.campaign_performance", null)],
  audience_scale: [sig("audience_scale.cross_platform_effective_reach", 35), sig("audience_scale.platform_breadth", null)],
  engagement_quality: [sig("engagement_quality.engagement_percentile", 81), sig("engagement_quality.video_retention", null)],
  momentum: [sig("momentum.athletic_trajectory", 11), sig("momentum.search_social_trajectory", 38)],
};
const empty = () => ({ grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] });
const assessment = (o: { signals?: boolean } = { signals: true }) => ({
  entryId: "e", evidenceAsOf: "2026-09-29T00:00:00.000Z", createdAt: "2026-09-29T00:00:00.000Z", versions: { methodology: "m", evaluator: "e", params: "p" },
  score: 600, readState: "assessed_partial", overall: { level: "HIGH", explanation: "Well corroborated." }, confidenceBand: null, summary: "SUMMARY PROSE SENTINEL", hasReasons: true,
  dimensions: KEYS.map((k) => ({
    key: k, state: STATES[k] ?? "neutral", score: STATES[k] === "unknown" ? null : SCORES[k], confidence: "HIGH", confidenceReason: null, rationale: `RATIONALE PROSE for ${k}.`, components: [], sources: empty(),
    ...(o.signals ? { weight: WEIGHT, contribution: STATES[k] === "unknown" ? null : SCORES[k] * WEIGHT, signals: SIGNALS[k] ?? [] } : {}),
  })),
  evidence: [], notes: { strengths: [], constraints: [], missingEvidence: ["MISSING EVIDENCE PROSE"], evaluationRisks: [] },
});
const baseView = (over: any = {}) => ({
  contract: "my-intelligence/0.2", athleteId: "a", asOf: "2026-10-01T00:00:00.000Z", pageState: "assessed_partial", identity: null, inProgress: false,
  assessment: assessment(), movement: { displayable: false, reason: "no_governed_stability_threshold" },
  bridge: { waitingOnYou: null, goals: null, reviewCount: null }, ...over,
});
const waiting = (over: any = {}) => ({ requestId: "r1", status: "open", nomilaSays: "You asked me to prompt you for your contract.", sheAsked: "prompt me for my contract", cta: { kind: "add_contract", label: "Add contract" }, sourceClass: "athlete", ...over });

const storyData = () => ({
  pageState: "ready", essence: null, positioning: { current: null, desired: null }, throughline: null,
  standsFor: { short: "Every kid on the harbour gets a seat.", long: "", basis: [], strength: "reported" },
  pillars: [], proofPoints: [], signatureMoments: [],
  differentiators: [
    { text: "Races at national level while coaching the next crew.", basis: [{ kind: "fact", id: "f1" }], strength: "established" },
    { text: "Opens the sport to kids who could not pay for it.", basis: [{ kind: "assertion", id: "a1" }], strength: "reported" },
  ],
  chapters: { origin: null, rise: null, defining: { text: "Stroked the winning crew at the regional final.", basis: [], strength: "established" }, now: null },
  direction: [], imageGap: null, athleteStatements: [],
});

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");

beforeEach(() => { navigate.mockReset(); openMila.mockReset(); story = storyData(); connections = []; });

describe("My Intelligence landing (6b)", () => {
  it("assessed: the number once (in the ring), the read once (on the card), the confidence line, the three sections and the three doors — no dimension number, no prose", () => {
    view = baseView({ bridge: { reviewCount: 2, goals: null, waitingOnYou: { count: 2, items: [waiting(), waiting({ requestId: "r3", sourceClass: "connected", sheAsked: null, nomilaSays: "The counterparty's terms." })] } } });
    render(<MyIntelligenceScreen />);
    const t = allText();
    // The hero carries the title only; the ring holds the number; the card gives the read — each exactly once.
    expect(t).toContain("My Intelligence");
    expect(t.match(/(^|\| )600( \||$)/g)).toHaveLength(1);
    expect(t).toContain("of 850");
    expect(t.split("Strongest in narrative power and brand fit. Thinnest in audience scale.").length - 1).toBe(1);
    expect(t).not.toContain("Not enough evidence yet on momentum.");          // the hero's long read is gone; the card's read is the Me line
    expect(screen.getByTestId("intelligence-read")).toBeTruthy();
    expect(t).toContain("Nomila is confident in this read.");
    expect(t).not.toContain("icon:eye");                                        // look B: the confidence line carries no glyph
    expect(t).toContain("Why?");
    expect(t).toContain("Read 29 Sep 2026");

    // What makes you marketable: Identity Intelligence's differentiators, each with where it comes from — no number, no brand.
    expect(t).toContain("What makes you marketable");
    expect(t).not.toContain("WHAT MAKES YOU MARKETABLE");                        // sentence case in copy; the eyebrow role sets the capitals
    expect(t).toContain("Races at national level while coaching the next crew.");
    expect(t).toContain("From your story");
    expect(t).toContain("Opens the sport to kids who could not pay for it.");
    expect(t).toContain("From what you told Nomila");
    expect(t).not.toMatch(/Brand partner quality|A distinctive story|Values and identity line up|logo:/);
    expect(t).not.toContain("“Races at national");                               // body text, never her quote style
    expect(screen.getAllByTestId(/^marketable-/)).toHaveLength(2);

    // Biggest strengths / Growth areas: non-imputed sub-signals; athletic trajectory (11, health) and evidence authenticity (94, about the evidence) never.
    expect(t).toContain("Biggest strengths");
    expect(t).toContain("Growth areas");
    expect(t).toContain("Brand safety");
    expect(t).toContain("Reach across platforms");
    expect(t).not.toContain("Athletic trajectory");
    expect(t).not.toContain("Evidence authenticity");
    expect(t).not.toMatch(/Best opportunities|holding you back/);

    // Help: her contract request only (the counterparty's is not hers to resolve) + the imputed connect gap (no insights account connected).
    expect(t).toContain("Help Nomila understand you better");
    expect(t).toContain("Share the contract you mentioned");
    expect(t).toContain("You asked Nomila to remind you");
    expect(t).not.toContain("Nomila asked for");
    expect(t).toContain("Connect your account insights");
    expect(t).not.toContain("counterparty");

    // Doors.
    expect(t).toContain("What to do next");
    expect(t).toContain("2 waiting");
    expect(t).toContain("Explore all 8 dimensions");
    expect(t).toContain("Scores, signals and sources");
    expect(t).toContain("Your platforms, measured");

    // Never on the face: a dimension score, the evaluator's prose, the missing-evidence note, raw keys.
    for (const n of Object.values(SCORES)) expect(t).not.toMatch(new RegExp(`(^|\\| )${n}( \\||$)`));
    expect(t).not.toMatch(/PROSE|SENTINEL|narrative_power\.|brand_quality/);
    expect(t).not.toContain("HIGH");
  });

  it("an insights account already connected: no connect row (its button would only open Settings); her requests stay", () => {
    connections = [{ id: "c1", platform: "instagram", status: "active" }];
    view = baseView({ bridge: { reviewCount: 0, goals: null, waitingOnYou: { count: 1, items: [waiting()] } } });
    render(<MyIntelligenceScreen />);
    const t = allText();
    expect(t).not.toContain("Connect your account insights");
    expect(t).toContain("Share the contract you mentioned");
  });

  it("no differentiators: the marketable section is not drawn; nothing is invented from the assessment", () => {
    story = { ...storyData(), differentiators: [] };
    view = baseView();
    render(<MyIntelligenceScreen />);
    expect(screen.queryByTestId("intelligence-marketable")).toBeNull();
    expect(allText()).not.toContain("What makes you marketable");
  });

  it("the doors and actions go where they say", () => {
    view = baseView({ bridge: { reviewCount: 0, goals: null, waitingOnYou: { count: 1, items: [waiting({ requestId: "r5", cta: null, sheAsked: "my rate floor" })] } } });
    render(<MyIntelligenceScreen />);
    fireEvent.press(screen.getByLabelText("Explore all 8 dimensions"));
    expect(navigate).toHaveBeenCalledWith("IntelligenceAreas");
    fireEvent.press(screen.getByLabelText("Your platforms, measured"));
    expect(navigate).toHaveBeenCalledWith("Platforms");
    fireEvent.press(screen.getByLabelText("What to do next"));
    expect(navigate).toHaveBeenCalledWith("Strategy", { screen: "StrategyRoot", params: undefined });
    fireEvent.press(screen.getByLabelText("Tell Mila: Tell Nomila what it asked for"));
    expect(openMila).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.stringContaining("my rate floor") }));
    expect(allText()).not.toMatch(/\d+ waiting/);   // reviewCount 0: no count chip
  });

  it("a 0.1 server (no signals, no contributions): the score card and the doors only — nothing invented", () => {
    view = baseView({ assessment: assessment({ signals: false }) });
    story = { ...storyData(), differentiators: [] };
    render(<MyIntelligenceScreen />);
    const t = allText();
    expect(t).toContain("600");
    expect(screen.queryByTestId("intelligence-marketable")).toBeNull();
    expect(screen.queryByTestId("intelligence-signals")).toBeNull();
    expect(screen.queryByTestId("intelligence-help")).toBeNull();
    expect(t).toContain("Explore all 8 dimensions");
  });

  it("identity ambiguous: heading + reason body; no number and no identity action", () => {
    view = baseView({ pageState: "identity_ambiguous", assessment: null, identity: { value: "ambiguous", basis: "q1", reason: "conflicts_athlete_statement", determinedAt: null } });
    render(<MyIntelligenceScreen />);
    const t = allText();
    expect(t).toContain("Confirming your public identity");
    expect(t).toContain("Some of what we found doesn't match what you've told us.");
    expect(t).not.toContain("600");
    expect(t).not.toMatch(/Confirm it's you|Add your team|Tell Mila|Is this you\?/);
  });

  it("updating: the quiet line with a read; the assessing message without one", () => {
    view = baseView({ inProgress: true });
    render(<MyIntelligenceScreen />);
    expect(allText()).toContain("Nomila is checking for a newer read.");
    view = baseView({ pageState: "updating", assessment: null, inProgress: true });
    render(<MyIntelligenceScreen />);
    expect(allText()).toContain("Nomila is assessing your marketability.");
  });

  it("no read yet: the measured door is still there, so connected accounts' numbers never wait on the M.I.A.", () => {
    view = baseView({ pageState: "updating", assessment: null, inProgress: true });
    render(<MyIntelligenceScreen />);
    expect(allText()).not.toContain("600");
    fireEvent.press(screen.getByLabelText("Your platforms, measured"));
    expect(navigate).toHaveBeenCalledWith("Platforms");
    expect(screen.queryByLabelText("Explore all 8 dimensions")).toBeNull();
  });
});

describe("Me card", () => {
  const ov = (intelligence: any) => ({
    version: "knowledge/2.1", athleteId: "a", story: { status: "coming" }, intelligence,
    identity: { displayName: "A", fullName: "A B", photoUrl: null, primary: null, facts: [] },
    knows: { total: 0, categories: [] },
  });

  it("shows the number and the page's answer when the slot carries a score", () => {
    overview = ov({ status: "ready", pageState: "assessed_partial", score: 600, evidenceAsOf: "2026-09-29T00:00:00.000Z" });
    view = baseView();
    story = { pageState: "unavailable", essence: null, positioning: { current: null, desired: null } };
    render(<MeScreen now={new Date(2026, 9, 1, 9)} />);
    const t = allText();
    expect(t).toContain("600");
    expect(t).toContain("Strongest in narrative power and brand fit. Thinnest in audience scale.");
  });

  it("never shows a number when the slot withholds it", () => {
    overview = ov({ status: "ready", pageState: "identity_failed", score: null, evidenceAsOf: null });
    view = null;
    story = { pageState: "unavailable", essence: null, positioning: { current: null, desired: null } };
    render(<MeScreen now={new Date(2026, 9, 1, 9)} />);
    const t = allText();
    expect(t).not.toContain("600");
    expect(t).toContain("We couldn't confirm your public identity");
  });
});
