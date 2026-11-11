/**
 * MyStoryScreen.test — My Story S1 (Home › Story), rendered from served data only; the density pass: each section
 * is a collapsed card (title · one summary line · count or thumbnails) that opens in place, ONE at a time.
 *
 *   ready      the hero statement (throughline.short) exactly; What defines you opens to a swipe rail of pillar cards,
 *              tap → the proof + Why; Your story so far opens to one line per chapter, then "Read the full story" → the
 *              full chapters in order with fixed labels and served text exactly ("Reported as…" kept) and IN YOUR WORDS
 *              only where one of her statements relates; What you stand for + her statement; Where you're headed leads
 *              with her goal verbatim, no second quote box, the rest deduplicated with domain labels; What Nomila sees
 *   one open   opening a second card closes the first
 *   why        the sheet speaks the strength and the basis in fixed words — and only there
 *   sparse     a story with no pillars, one chapter, no standsFor, no imageGap shows only what it has; nothing empty
 *   learning   the quiet learning line; Where you're headed still shows when she has a goal; no other section
 *   never      "Established" / "Reported" on the face; "Refine with Mila"; the pre-#754 athleteFacingText; a stock image
 * Fixtures are fictional.
 */
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import React from "react";
import { MyStoryScreen } from "./MyStoryScreen";
import { parseMeStory } from "../../hooks/use-me-story";
import { STORY_LEARNING_LINE } from "../../lib/meStoryLogic";

jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => {}, navigate: () => {} }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Image: (p: { source?: { uri?: string } }) => React.createElement(View, { testID: "img", ...p }) };
});
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../lib/query-client", () => ({ apiRequest: jest.fn() }));

let story: any = null;
let photos: any[] = [];
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeOverview: () => ({ data: { identity: { displayName: "Avery", photoUrl: "https://img.example/avatar.jpg" } } }),
  useMePool: () => photos,
}));
jest.mock("../../hooks/use-me-story", () => {
  const actual = jest.requireActual("../../hooks/use-me-story");
  return { ...actual, useMeStory: () => ({ data: story, isLoading: false, isError: false, refetch: () => {} }) };
});

const served = {
  pageState: "ready",
  essence: { short: "A harbour-town rower who builds crews.", long: "A harbour-town rower who builds the crew around her.", basis: [{ kind: "fact", id: "f1" }], strength: "established" },
  positioning: { current: { short: "The crew-minded rower.", long: "", basis: [], strength: "reported" }, desired: { value: "Be known as the rower who builds the next crew", source: "objective", basis: [{ kind: "objective", id: "o1" }] } },
  throughline: { short: "The water is the constant.", long: "From the harbour to the national squad, the water is the constant.", basis: [{ kind: "fact", id: "f1" }, { kind: "evidence", id: "e1" }, { kind: "evidence", id: "e5" }], strength: "reported" },
  standsFor: { short: "Rowing opened to every kid on the harbour.", long: "Rowing opened to every kid on the harbour, whatever they can pay.", basis: [{ kind: "evidence", id: "e2" }], strength: "reported" },
  pillars: [
    { key: "competitor", label: "Competitor", definition: "Races at national level.", proof: ["pp:national", "sm:final"], basis: [{ kind: "fact", id: "f2" }], strength: "established", salience: 0.9 },
    { key: "builder", label: "Builder", definition: "Coaches the next crew.", proof: [], basis: [{ kind: "assertion", id: "a1" }], strength: "established", salience: 0.6 },
  ],
  proofPoints: [{ key: "pp:national", kind: "national_team", text: "National U23 squad, 2025", basis: [], strength: "established", asOf: null }],
  signatureMoments: [{ key: "sm:final", kind: "signature", text: "Stroked the winning crew at the regional final", basis: [], strength: "established", asOf: "2025-05-01" }],
  chapters: {
    origin: { text: "Reported as growing up rowing on the harbour.", athleteFacingText: "PRE754 SENTINEL", basis: [{ kind: "assertion", id: "a2" }], strength: "reported" },
    rise: null,
    defining: { text: "The regional final.", basis: [{ kind: "evidence", id: "e3" }], strength: "established" },
    now: { text: "Rowing for Lakeside College.", basis: [{ kind: "fact", id: "f2" }], strength: "established" },
  },
  direction: [
    { value: "Be known as the rower who builds the next crew", objectiveId: "o1", domain: "positioning", athleteAuthored: true, basis: [{ kind: "objective", id: "o1" }] },
    { value: "Start a coaching business for young rowers", objectiveId: "o2", domain: "owned_venture", athleteAuthored: true, basis: [{ kind: "objective", id: "o2" }] },
    { value: "Grow a steadier presence on two platforms", objectiveId: "o4", domain: "audience", athleteAuthored: false, basis: [{ kind: "objective", id: "o4" }] },
  ],
  imageGap: { text: "Coverage frames the final; her direction is the coaching.", basis: [{ kind: "evidence", id: "e4" }], strength: "reported" },
  athleteStatements: [
    { id: "said:assertion:a2", text: "I grew up rowing on the harbour every single morning", truncated: false, provenance: "her_own", medium: "form", source: { outlet: null, title: null, platform: null, url: null }, topics: ["origin"], at: null, intent: false, citedBy: ["chapters.origin"] },
    { id: "evidence:e2", text: "Every kid on the harbour should get a seat in a boat.", truncated: false, provenance: "source_read", medium: "video", source: { outlet: "Outlet One", title: "Morning interview", platform: null, url: "https://outlet-one.example/i" }, topics: ["values"], at: null, intent: false, citedBy: ["standsFor"] },
    { id: "said:objective:o1", text: "Be known as the rower who builds the next crew", truncated: false, provenance: "her_own", medium: "objective", source: { outlet: null, title: null, platform: null, url: null }, topics: ["ambition"], at: null, intent: true, citedBy: ["positioningDesired"] },
  ],
};
const photo = (asset_id: string, over: object = {}) => ({ asset_id, url: `https://img.example/${asset_id}.jpg`, thumb_url: null, origin: "connected", ...over });

beforeEach(() => { story = parseMeStory(served); photos = [photo("hero"), photo("p1"), photo("gen", { origin: "generated" })]; });

const faceText = () => screen.toJSON() ? JSON.stringify(screen.toJSON()) : "";

describe("ready", () => {
  it("composes every section from served text exactly, in the agreed order", () => {
    render(<MyStoryScreen />);
    // the hero, restrained: ONE statement (throughline.short) + ONE supporting line (essence.short); never the long paragraph
    expect(screen.getByTestId("story-hero-statement")).toHaveTextContent("The water is the constant.");
    expect(screen.getByTestId("story-hero-support")).toHaveTextContent("A harbour-town rower who builds crews.");
    expect(faceText()).not.toContain("From the harbour to the national squad");
    // two photos meet the hero bar: My Story takes the second (Home keeps the first), the other is a pillar (its thumbnail
    // at the head of the collapsed card); a generated image never appears anywhere; the avatar is not drawn on a pushed
    // hero (back + wordmark only)
    expect(screen.getAllByTestId("img").map((i: any) => i.props.source?.uri)).toEqual(["https://img.example/p1.jpg", "https://img.example/hero.jpg"]);
    expect(faceText()).not.toContain("gen.jpg");
    expect(faceText()).not.toContain("avatar.jpg");

    // every section collapsed: title, ONE summary line, the count; nothing of the bodies on the face
    expect(screen.getByText("What defines you")).toBeTruthy();
    expect(screen.getByText("Competitor · Builder")).toBeTruthy();                    // the summary line
    expect(screen.queryByText("Races at national level.")).toBeNull();
    expect(screen.queryByText("National U23 squad, 2025")).toBeNull();
    expect(screen.queryByText("Where it started")).toBeNull();
    expect(screen.queryByTestId("story-headed-lead")).toBeNull();
    for (const id of ["pillars", "chapters", "standsFor", "headed", "sees"]) expect(screen.getByTestId(`accordion-head-${id}`).props.accessibilityState).toEqual({ expanded: false });
    expect(screen.getByTestId("accordion-head-pillars").props.accessibilityLabel).toBe("What defines you, 2 items");
    expect(screen.getByTestId("accordion-head-chapters").props.accessibilityLabel).toBe("Your story so far, 3 items");
    expect(screen.getByTestId("accordion-head-headed").props.accessibilityLabel).toBe("Where you're headed, 3 items");

    // What defines you opens to the swipe rail: her photo on the first card, the second text-led (a light tile with its
    // initial — never a dark block); tap a card → its proof
    fireEvent.press(screen.getByTestId("accordion-head-pillars"));
    expect(screen.getByTestId("story-pillar-rail")).toBeTruthy();
    expect(screen.getByText("Competitor")).toBeTruthy();
    expect(screen.getByText("Races at national level.")).toBeTruthy();
    expect(screen.getByText("Swipe · 1 of 2")).toBeTruthy();
    expect(screen.queryByText("National U23 squad, 2025")).toBeNull();
    fireEvent.press(screen.getByTestId("pillar-competitor"));
    const open = within(screen.getByTestId("pillar-open-competitor"));
    expect(open.getByText("National U23 squad, 2025")).toBeTruthy();
    expect(open.getByText("Stroked the winning crew at the regional final")).toBeTruthy();
    expect(within(screen.getByTestId("pillar-tile-builder")).getByText("B")).toBeTruthy();
    expect(JSON.stringify(screen.getByTestId("pillar-tile-builder").props.style)).not.toMatch(/#2A2622|#0D0B08/);
    expect(faceText()).not.toContain("gen.jpg");

    // one open at a time: opening Your story so far closes What defines you
    fireEvent.press(screen.getByTestId("accordion-head-chapters"));
    expect(screen.queryByTestId("story-pillar-rail")).toBeNull();
    expect(screen.getByTestId("accordion-head-pillars").props.accessibilityState).toEqual({ expanded: false });
    expect(screen.getByTestId("accordion-head-chapters").props.accessibilityState).toEqual({ expanded: true });

    // chapters: first the brief — one line per chapter, in order, with the fixed labels (sentence case; capitals by the
    // eyebrow role); then "Read the full story" → the full text exactly, a quote only under origin
    const brief = within(screen.getByTestId("story-chapters-brief"));
    const labels = ["Where it started", "A defining moment", "Now"];
    for (const l of labels) expect(brief.getByText(l)).toBeTruthy();
    expect(screen.queryByText("A bigger stage")).toBeNull();
    expect(faceText()).not.toMatch(/WHERE IT STARTED|IN YOUR WORDS|FROM YOU/);
    expect(screen.queryByTestId("quote-said:assertion:a2")).toBeNull();
    fireEvent.press(screen.getByTestId("story-read-full"));
    const chapters = screen.getByTestId("story-chapters-full");
    expect(within(chapters).getByText("Reported as growing up rowing on the harbour.")).toBeTruthy();
    expect(within(screen.getByTestId("chapter-origin")).getByTestId("quote-said:assertion:a2")).toHaveTextContent(/I grew up rowing on the harbour every single morning/);
    expect(within(screen.getByTestId("chapter-origin")).getByText("Written to Nomila, in a form")).toBeTruthy();
    expect(within(screen.getByTestId("chapter-defining")).queryByText(/In your words/)).toBeNull();
    expect(faceText()).not.toContain("PRE754");

    // stands for + her statement with its source
    fireEvent.press(screen.getByTestId("accordion-head-standsFor"));
    const sf = within(screen.getByTestId("story-stands-for"));
    expect(sf.getAllByText("Rowing opened to every kid on the harbour.").length).toBeGreaterThanOrEqual(1);
    expect(sf.getByText("“Every kid on the harbour should get a seat in a boat.”")).toBeTruthy();
    expect(sf.getByText("Outlet One · video")).toBeTruthy();

    // headed: her PRIMARY direction leads, once, labelled From you; the rest as rows with domain labels
    fireEvent.press(screen.getByTestId("accordion-head-headed"));
    const headed = within(screen.getByTestId("story-headed"));
    expect(headed.getByText("From you")).toBeTruthy();
    expect(headed.getByTestId("story-headed-lead")).toHaveTextContent(/Be known as the rower who builds the next crew/);
    expect(headed.getAllByText("Be known as the rower who builds the next crew")).toHaveLength(1);   // the summary is the quoted form, the lead the plain one
    expect(headed.getByText("Venture")).toBeTruthy();
    expect(headed.getByText("Audience")).toBeTruthy();
    expect(headed.getByText("Start a coaching business for young rowers")).toBeTruthy();
    expect(headed.queryByText("Positioning")).toBeNull();

    // what Nomila sees, exactly
    fireEvent.press(screen.getByTestId("accordion-head-sees"));
    expect(within(screen.getByTestId("story-sees")).getAllByText("Coverage frames the final; her direction is the coaching.").length).toBeGreaterThanOrEqual(1);

    // never on the face
    expect(screen.queryByText(/Refine with Mila/)).toBeNull();
    expect(screen.queryByText(/^Established$|^Reported$/)).toBeNull();
    expect(faceText()).not.toMatch(/verified/i);
  });

  it("Why Nomila sees this opens the basis and the strength in fixed words, only in the sheet", () => {
    render(<MyStoryScreen />);
    expect(screen.queryByTestId("why-sheet")).toBeNull();
    fireEvent.press(screen.getAllByLabelText("Why Nomila sees this")[0]);   // the hero's
    const sheet = within(screen.getByTestId("why-sheet"));
    expect(sheet.getByText(/^Nomila holds this as reported/)).toBeTruthy();
    expect(sheet.getByText("Built from 1 fact, 2 sources.")).toBeTruthy();
  });
});

describe("sparse and learning", () => {
  it("a sparse story shows only what it has — never an empty section", () => {
    story = parseMeStory({ ...served, throughline: null, essence: null, pillars: [], standsFor: null, imageGap: null, chapters: { origin: null, rise: null, defining: null, now: served.chapters.now }, athleteStatements: [] });
    photos = [];
    render(<MyStoryScreen />);
    expect(screen.getByTestId("story-hero-statement")).toHaveTextContent("The crew-minded rower.");
    expect(screen.queryByTestId("story-pillars")).toBeNull();
    expect(screen.queryByTestId("story-stands-for")).toBeNull();
    expect(screen.queryByTestId("story-sees")).toBeNull();
    expect(screen.getByTestId("story-chapters")).toBeTruthy();
    expect(screen.getByText("Rowing for Lakeside College.")).toBeTruthy();                    // the summary: the first chapter's line
    fireEvent.press(screen.getByTestId("accordion-head-chapters"));
    expect(screen.getByTestId("chapter-brief-now")).toBeTruthy();
    expect(screen.queryByTestId("chapter-brief-origin")).toBeNull();
    expect(screen.getByTestId("story-headed")).toBeTruthy();
  });

  it("learning: the quiet line, and Where you're headed only", () => {
    story = parseMeStory({ pageState: "learning", positioning: { current: null, desired: { value: "Be the rower who builds the next crew", source: "direction", basis: [{ kind: "assertion", id: "a9" }] } }, direction: [] });
    render(<MyStoryScreen />);
    expect(screen.getByTestId("story-hero-learning")).toHaveTextContent(STORY_LEARNING_LINE);
    expect(screen.queryByTestId("story-hero-statement")).toBeNull();
    expect(screen.getByTestId("story-headed")).toBeTruthy();
    fireEvent.press(screen.getByTestId("accordion-head-headed"));
    expect(screen.getByTestId("story-headed-lead")).toHaveTextContent(/Be the rower who builds the next crew/);
    expect(screen.queryByTestId("story-pillars")).toBeNull();
    expect(screen.queryByTestId("story-chapters")).toBeNull();
  });
});
