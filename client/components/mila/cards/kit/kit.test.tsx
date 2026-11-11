/**
 * kit.test.tsx — the card system v2's card kit (design "Mila card designs" v2.2): every card in both densities, the
 * expand behaviour (chat: in place, one open at a time; screen: opens the detail), each action recording its outcome,
 * the two-faces-per-screen rule, the text budgets, and the chat view's flag. Fictional fixtures; no network (the
 * recorder is a mock).
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { MILA_CARD_SCHEMAS, type MilaCardDto } from "../../../../../shared/milaCards";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../../../agent/handlers";
import { CardKitHost, KitCard, hasKitView, type CardSurface, type RecordOutcome } from "./index";
import { ANSWER_DTO, DEAL_DTO, DEALS_LIST_DTO, IDEAS_DTO, INSIGHT_DTO, ONCE_DTO, TURN_ON_DTO } from "./fixtures";
import { MilaCardView } from "../MilaCardView";
import { SourceChip } from "./parts";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Image: (p: Record<string, unknown>) => React.createElement(View, { ...p, testID: p.testID ?? "photo" }) };
});
jest.mock("../../../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../../../lib/query-client", () => ({ apiRequest: jest.fn(async () => ({ json: async () => ({ receipt: "x" }) })), queryClient: { invalidateQueries: jest.fn(async () => undefined) } }));

function draw(dtos: MilaCardDto[], opts: { surface?: CardSurface; expanded?: boolean; handlers?: AgentCardHandlers; record?: RecordOutcome } = {}) {
  const record = opts.record ?? jest.fn<ReturnType<RecordOutcome>, Parameters<RecordOutcome>>(async (o) => (o.outcome === "seen" ? "" : "Done."));
  const handlers = opts.handlers ?? { reply: jest.fn(), prefill: jest.fn(), openLink: jest.fn() };
  render(
    <AgentCardHandlersProvider value={handlers}>
      <CardKitHost surface={opts.surface ?? "chat"} record={record}>
        {dtos.map((d) => <KitCard key={d.data.id} dto={d} initialExpanded={opts.expanded} />)}
      </CardKitHost>
    </AgentCardHandlersProvider>,
  );
  return { record: record as jest.Mock, handlers: handlers as Required<Pick<AgentCardHandlers, "reply" | "prefill" | "openLink">> & Record<string, jest.Mock> };
}
const flush = () => act(async () => { await Promise.resolve(); });
const recorded = (r: jest.Mock) => r.mock.calls.map((c) => c[0]).filter((o) => o.outcome !== "seen");

describe("Insight", () => {
  test("collapsed: the row card (chart tile, one headline, Ask Mila); no line, no raspberry", () => {
    draw([INSIGHT_DTO]);
    expect(screen.getByTestId("card-insight-collapsed")).toBeTruthy();
    expect(screen.getByText("Your reel saves doubled this month")).toBeTruthy();
    expect(screen.queryByText("Gear and nutrition brands look for saves before reaching out.")).toBeNull();
    expect(screen.getByTestId("card-ask-mila")).toBeTruthy();
  });
  test("chat: a body tap expands it in place (figures, source, My Intelligence); another tap folds it", async () => {
    const { record } = draw([INSIGHT_DTO]);
    fireEvent.press(screen.getByLabelText("Your reel saves doubled this month, see more"));
    expect(screen.getByTestId("card-insight-expanded")).toBeTruthy();
    expect(screen.getByText("Gear and nutrition brands look for saves before reaching out.")).toBeTruthy();
    expect(screen.getAllByText("1,940")).toHaveLength(2); // the chart's big number and the figure tile
    expect(screen.getByTestId("card-source")).toBeTruthy();
    fireEvent.press(screen.getAllByLabelText("Your reel saves doubled this month, collapse")[0]);
    expect(screen.getByTestId("card-insight-collapsed")).toBeTruthy();
    expect(record.mock.calls[0][0]).toEqual({ card: "insight", ref: INSIGHT_DTO.type === "insight" ? INSIGHT_DTO.data.fields.decisionId : "", outcome: "seen" });
  });
  test("Ask Mila sends the ask as their message and records accepted · asked, then a receipt", async () => {
    const { record, handlers } = draw([INSIGHT_DTO]);
    fireEvent.press(screen.getByTestId("card-ask-mila"));
    await flush();
    expect(handlers.reply).toHaveBeenCalledWith("Tell me more about my reel saves");
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "insight", outcome: "accepted", action: "asked" })]);
    expect(screen.getByTestId("card-receipt")).toBeTruthy();
  });
  test("on an app screen the body opens My Intelligence instead of expanding", () => {
    const { handlers } = draw([INSIGHT_DTO], { surface: "screen" });
    fireEvent.press(screen.getByLabelText("Your reel saves doubled this month, open"));
    expect(handlers.openLink).toHaveBeenCalledWith({ screen: "scouting", id: "mia" }, expect.anything());
    expect(screen.queryByTestId("card-insight-expanded")).toBeNull();
  });
});

describe("one open at a time (the accordion)", () => {
  test("expanding a second card folds the first", () => {
    draw([INSIGHT_DTO, ANSWER_DTO]);
    fireEvent.press(screen.getByLabelText("Your reel saves doubled this month, see more"));
    expect(screen.getByTestId("card-insight-expanded")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Yes, they run real athlete campaigns, see more"));
    expect(screen.getByTestId("card-answer-expanded")).toBeTruthy();
    expect(screen.getByTestId("card-insight-collapsed")).toBeTruthy();
  });
});

describe("Ideas", () => {
  test("collapsed: a carousel of tall cards, each with ONE soft Make it", () => {
    draw([IDEAS_DTO]);
    expect(screen.getAllByTestId("card-idea-item")).toHaveLength(3);
    expect(screen.getAllByTestId("card-idea-make")).toHaveLength(3);
    expect(screen.queryByTestId("card-idea-make-studio")).toBeNull();
  });
  test("Make it acts directly: Studio opens, accepted · idea used, a receipt; only the first is seen at first", async () => {
    const { record, handlers } = draw([IDEAS_DTO]);
    expect(record.mock.calls.filter((c) => c[0].outcome === "seen")).toHaveLength(1);
    fireEvent.press(screen.getAllByTestId("card-idea-make")[0]);
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "idea", outcome: "accepted", action: "idea_used" })]);
    expect(handlers.openLink).toHaveBeenCalledWith(expect.objectContaining({ screen: "studio" }));
    expect(screen.getByText("Done.")).toBeTruthy();
  });
  test("expanded: the raspberry Make it in Studio + Not now; ⋯ → Don't suggest this records never", async () => {
    const { record } = draw([IDEAS_DTO], { expanded: true });
    expect(screen.getByTestId("card-idea-detail")).toBeTruthy();
    expect(screen.getByTestId("card-idea-make-studio")).toBeTruthy();
    fireEvent.press(screen.getByTestId("card-idea-menu"));
    fireEvent.press(screen.getByTestId("card-idea-never"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "idea", outcome: "never" })]);
  });
});

describe("Turn-on offer", () => {
  test("collapsed: one soft Set it up, which turns nothing on: it opens the connect sheet", async () => {
    const { record } = draw([TURN_ON_DTO]);
    expect(screen.queryByTestId("connect-sheet")).toBeNull();
    fireEvent.press(screen.getByTestId("card-turn-on-setup"));
    expect(screen.getByTestId("connect-sheet")).toBeTruthy();
    expect(recorded(record)).toEqual([]);
    expect(screen.getByText("Ideas from your own shots")).toBeTruthy();
    expect(screen.getByText("You choose what Mila can do")).toBeTruthy();
    expect(screen.getByText("Keep an eye on it")).toBeTruthy();
  });
  test("only the sheet's Turn on records accepted · enabled; Not now and Don't offer this again record theirs", async () => {
    const { record } = draw([TURN_ON_DTO], { expanded: true });
    fireEvent.press(screen.getByTestId("connect-sheet-turn-on"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "turn-on", outcome: "accepted", action: "enabled", consentVersion: "post_ideas/1" })]);
    expect(screen.getByTestId("card-receipt")).toBeTruthy();
  });
  test("Don't offer this again records never", async () => {
    const { record } = draw([TURN_ON_DTO], { expanded: true });
    fireEvent.press(screen.getByTestId("connect-sheet-never"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "turn-on", outcome: "never" })]);
  });
  test("the sheet shows the registry's consent words verbatim, under their two labels, in the pinned foot with Turn on", () => {
    draw([TURN_ON_DTO], { expanded: true });
    const foot = within(screen.getByTestId("connect-sheet-foot"));
    expect(foot.getByTestId("connect-sheet-consent")).toBeTruthy();
    expect(foot.getByTestId("connect-sheet-turn-on")).toBeTruthy();
    expect(foot.getByTestId("connect-sheet-not-now")).toBeTruthy();
    const reads = within(foot.getByTestId("connect-sheet-consent-reads"));
    expect(reads.getByText("Once it's on, Mila will")).toBeTruthy();
    expect(reads.getByText("Look at your newly tagged photos and videos and suggest posts")).toBeTruthy();
    const asks = within(foot.getByTestId("connect-sheet-consent-asks"));
    expect(asks.getByText("Always asks you first")).toBeTruthy();
    expect(asks.getByText("Posting anything")).toBeTruthy();
    // The rows scroll in the body, never in the foot.
    expect(within(screen.getByTestId("connect-sheet-body")).getByText("Ideas from your own shots")).toBeTruthy();
    expect(foot.queryByText("Ideas from your own shots")).toBeNull();
  });
  test("an empty group is not drawn, and no line is cut short", () => {
    const d = JSON.parse(JSON.stringify(TURN_ON_DTO)) as MilaCardDto & { type: "turn-on" };
    d.data.fields.consent.alwaysAsks = [];
    d.data.fields.consent.reads = ["Move a deal nobody worked on for 45 days out of your list, with Undo", "Look at your newly tagged photos and videos and suggest posts"];
    draw([d], { expanded: true });
    expect(screen.queryByTestId("connect-sheet-consent-asks")).toBeNull();
    expect(screen.queryByText("Always asks you first")).toBeNull();
    const line = screen.getByText("Move a deal nobody worked on for 45 days out of your list, with Undo");
    expect(line.props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId("connect-sheet-foot")).toBeTruthy();
  });
  test("a drafting capability's sheet draws the registry's drafts line under Once it's on, verbatim", () => {
    // The registry's pitch_deck/2 words (consentWords adds DRAFTS_SAYS when consent.drafts is true).
    const d = JSON.parse(JSON.stringify(TURN_ON_DTO)) as MilaCardDto & { type: "turn-on" };
    d.data.fields.consent = { reads: ["Write drafts for you to check. Nothing is sent without your tap."], drafts: true, alwaysAsks: ["Sharing it with anyone"], onRevoke: "stop_and_keep" };
    d.data.fields.consentVersion = "pitch_deck/2";
    expect(MILA_CARD_SCHEMAS["turn-on"].safeParse(d.data).success).toBe(true);
    draw([d], { expanded: true });
    const reads = within(screen.getByTestId("connect-sheet-consent-reads"));
    expect(reads.getByText("Once it's on, Mila will")).toBeTruthy();
    expect(reads.getByText("Write drafts for you to check. Nothing is sent without your tap.")).toBeTruthy();
    expect(within(screen.getByTestId("connect-sheet-consent-asks")).getByText("Sharing it with anyone")).toBeTruthy();
  });
  test("a capability with no reads draws only its always-asks group", () => {
    const d = JSON.parse(JSON.stringify(TURN_ON_DTO)) as MilaCardDto & { type: "turn-on" };
    d.data.fields.consent.reads = [];
    expect(MILA_CARD_SCHEMAS["turn-on"].safeParse(d.data).success).toBe(true);
    draw([d], { expanded: true });
    expect(screen.queryByTestId("connect-sheet-consent-reads")).toBeNull();
    expect(screen.getByText("Posting anything")).toBeTruthy();
  });
  test("Not now (a text link in the foot) records not_now", async () => {
    const { record } = draw([TURN_ON_DTO], { expanded: true });
    fireEvent.press(screen.getByTestId("connect-sheet-not-now"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "turn-on", outcome: "not_now" })]);
  });
});

describe("One-time question", () => {
  test("collapsed: the logos head, the question, dashed rows + Something else…; no card surface, no Skip", () => {
    draw([ONCE_DTO]);
    expect(screen.getByTestId("card-once-collapsed")).toBeTruthy();
    expect(screen.getByText("2 product-only offers this month")).toBeTruthy();
    expect(screen.getAllByTestId(/card-once-option-/)).toHaveLength(3);
    expect(screen.getByTestId("card-once-else")).toBeTruthy();
    expect(screen.queryByText("Skip")).toBeNull();
  });
  test("the head expands \"why I'm asking\"", () => {
    draw([ONCE_DTO]);
    fireEvent.press(screen.getByTestId("card-once-head"));
    expect(screen.getByTestId("card-once-why")).toBeTruthy();
  });
  test("a row saves its rule (accepted · rule, the choice's index) and shows the receipt", async () => {
    const { record } = draw([ONCE_DTO]);
    fireEvent.press(screen.getByTestId("card-once-option-1"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "once", outcome: "accepted", choice: 1 })]);
    expect(screen.getByText("Only show product offers from brands you already use.")).toBeTruthy();
    expect(screen.getByText("Change it any time in Me")).toBeTruthy();
  });
  test("Something else… puts the topic in the composer and records edited", async () => {
    const { record, handlers } = draw([ONCE_DTO]);
    fireEvent.press(screen.getByTestId("card-once-else"));
    await flush();
    expect(handlers.prefill).toHaveBeenCalledWith("Free-product offers: ");
    expect(recorded(record)).toEqual([expect.objectContaining({ card: "once", outcome: "edited" })]);
  });
});

describe("Answer", () => {
  test("collapsed: one source chip with the count, ONE full-width Save, follow-ups outside the card", () => {
    draw([ANSWER_DTO]);
    expect(screen.getByTestId("card-answer-collapsed")).toBeTruthy();
    expect(screen.getAllByTestId("card-source")).toHaveLength(1);
    expect(screen.getByText("cobaltwave.example +1")).toBeTruthy();
    expect(screen.getByTestId("card-answer-follow-0")).toBeTruthy();
    expect(screen.queryByTestId("card-ask-mila")).toBeNull();
  });
  test("expanded: the list, every source, Save + Ask Mila", () => {
    draw([ANSWER_DTO], { expanded: true });
    expect(screen.getByTestId("card-answer-list")).toBeTruthy();
    expect(screen.getAllByTestId("card-source")).toHaveLength(2);
    expect(screen.getByTestId("card-ask-mila")).toBeTruthy();
  });
  test("Save records accepted · saved; a follow-up sends its words", async () => {
    const { record, handlers } = draw([ANSWER_DTO]);
    fireEvent.press(screen.getByTestId("card-answer-save"));
    fireEvent.press(screen.getByTestId("card-answer-follow-0"));
    await flush();
    expect(recorded(record)).toEqual([expect.objectContaining({ action: "saved" }), expect.objectContaining({ action: "follow_up" })]);
    expect(handlers.reply).toHaveBeenCalledWith("Have they worked with volleyball players?");
  });
  test("a source chip is a link: a tap opens its page through openLink", () => {
    const { handlers } = draw([ANSWER_DTO], { expanded: true });
    const chips = screen.getAllByRole("link").filter((n) => n.props.testID === "card-source");
    expect(chips).toHaveLength(2);
    fireEvent.press(chips[0]);
    expect(handlers.openLink).toHaveBeenCalledWith({ url: "https://cobaltwave.example/press" });
  });
});

describe("SourceChip", () => {
  const chip = (url: string | null) => {
    const openLink = jest.fn();
    render(<AgentCardHandlersProvider value={{ openLink }}><SourceChip label="Press" url={url} site="example.org" /></AgentCardHandlersProvider>);
    return openLink;
  };
  test.each(["javascript:alert(1)", "mailto:a@example.org", "not a url"])("opens only http(s): %s is not a link", (url) => {
    chip(url);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("card-source")).toBeTruthy();
  });
  test("no url: a plain chip", () => {
    chip(null);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Deal and deals list", () => {
  test("the deal row: the money as the headline; expanded adds the chips and Draft a reply (raspberry)", () => {
    const { handlers } = draw([DEAL_DTO]);
    expect(screen.getByText("$1,400 for 2 reels")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Northpeak Apparel, $1,400 for 2 reels"));
    expect(screen.getByText("Above your minimum")).toBeTruthy();
    fireEvent.press(screen.getByTestId("card-deal-action"));
    expect(handlers.reply).toHaveBeenCalledWith("Draft a reply to Northpeak Apparel");
  });
  test("the deals list: one row per deal, each opening its deal, no buttons", () => {
    const { handlers } = draw([DEALS_LIST_DTO]);
    fireEvent.press(screen.getByLabelText("Cobaltwave Hydration, No fee yet"));
    expect(handlers.openLink).toHaveBeenCalledWith({ screen: "deal", id: "o2" });
  });
});

describe("the Insight chart and the pictures", () => {
  test("the chart is drawn from the stored series: the latest point is the one emphasised, the delta is shown", () => {
    draw([INSIGHT_DTO], { expanded: true });
    expect(screen.getAllByTestId("card-chart-latest")).toHaveLength(1);
    expect(screen.getAllByText("1,940").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+96%").length).toBeGreaterThan(0);
  });
  test("a picture that fails to load draws the fallback, never a broken image", () => {
    draw([TURN_ON_DTO]);
    const photo = screen.getByTestId("photo");
    act(() => { (photo.props.onError as () => void)(); });
    expect(screen.queryByTestId("photo")).toBeNull();
    expect(screen.getByTestId("card-media-fallback")).toBeTruthy();
  });
  test("a Turn on already said yes to reads as on", () => {
    const d = JSON.parse(JSON.stringify(TURN_ON_DTO)) as MilaCardDto & { type: "turn-on" };
    d.data.fields.state = "enabled";
    draw([d]);
    expect(screen.getByTestId("card-receipt")).toHaveTextContent(/^On\. Turn it off any time in Me\./);
  });
});

describe("faces: at most two per screen across cards", () => {
  const withFace = (id: string, n: number): MilaCardDto => {
    const d = JSON.parse(JSON.stringify(INSIGHT_DTO)) as MilaCardDto & { type: "insight" };
    d.data.id = id;
    d.data.fields.decisionId = `00000000-0000-4000-8000-00000000090${n}`;
    d.data.fields.media = { ...d.data.fields.media, kind: "athlete_photo", url: `https://signed.example/${id}.jpg`, chart: null, hasFace: true };
    return d;
  };
  test("the third face-led card draws its fallback", () => {
    draw([withFace("a", 1), withFace("b", 2), withFace("c", 3)]);
    expect(screen.getAllByTestId("photo")).toHaveLength(2);
    expect(screen.getByTestId("card-media-face-held")).toBeTruthy();
  });
});

describe("text budgets and the chat view", () => {
  test("a headline over 48 characters or a line over 90 fails the DTO: the card never draws", () => {
    const bad = JSON.parse(JSON.stringify(INSIGHT_DTO));
    bad.data.fields.headline = "Your training reels are being saved twice as often now";
    expect(MILA_CARD_SCHEMAS.insight.safeParse(bad.data).success).toBe(false);
    render(<MilaCardView dto={bad} cardsV2 />);
    expect(screen.queryByTestId(/card-insight/)).toBeNull();
  });
  test("flag off: a v2-only type draws nothing (today's chat is unchanged); on: the kit draws it", () => {
    expect(hasKitView(IDEAS_DTO)).toBe(true);
    render(<MilaCardView dto={IDEAS_DTO} cardsV2={false} />);
    expect(screen.queryByTestId("card-idea-item")).toBeNull();
    render(<MilaCardView dto={IDEAS_DTO} cardsV2 />);
    expect(screen.getAllByTestId("card-idea-item").length).toBe(3);
  });
});

describe("on the app screens (PR B)", () => {
  const { KitBriefing, KitScreenHost, kitBriefingSlots, WhatMilaCanDo } = require("./ScreenCards") as typeof import("./ScreenCards");
  const { MilaBriefing, briefingLayout } = require("../../../homeV3/MilaBriefing") as typeof import("../../../homeV3/MilaBriefing");
  const { GALLERY_BRIEFING } = require("./KitGallery") as typeof import("./KitGallery");
  const { QueryClient, QueryClientProvider } = require("@tanstack/react-query") as typeof import("@tanstack/react-query");
  const slot = (key: string) => ({ key, text: key, node: null });

  test("briefingLayout: the v2 cards TAKE the compact slots; the hero stays; three in all; the rest counts in 'more'", () => {
    const b = GALLERY_BRIEFING as never as Parameters<typeof briefingLayout>[0];
    const kinds = (l: ReturnType<typeof briefingLayout>) => l.rows.map((r) => (r.kind === "slot" ? `slot:${r.slot.key}` : `${r.kind}:${r.m.kind}`));
    // No v2 cards: exactly today's briefing.
    expect(kinds(briefingLayout(b))).toEqual(["hero:offer", "compact:post", "compact:moment"]);
    // Two v2 cards: they replace both compact items, which move into "2 more".
    const two = briefingLayout(b, [slot("ideas"), slot("insight")]);
    expect(kinds(two)).toEqual(["hero:offer", "slot:ideas", "slot:insight"]);
    expect(two.overflow).toBe(2);
    // One v2 card: it takes the first compact slot; today's next item keeps the last one.
    const one = briefingLayout(b, [slot("insight")]);
    expect(kinds(one)).toEqual(["hero:offer", "slot:insight", "compact:post"]);
    expect(one.overflow).toBe(1);
    // A quiet day (no briefing of today's): the v2 cards fill the slots, never more than three.
    expect(kinds(briefingLayout({ messages: [], overflow: 0 }, [slot("a"), slot("b"), slot("c"), slot("d")]))).toEqual(["slot:a", "slot:b", "slot:c"]);
  });

  test("Home: today's hero is drawn as today, the v2 cards sit in the compact slots, and today's compact cards are gone", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <KitScreenHost record={jest.fn(async () => "")}>
          <MilaBriefing briefing={GALLERY_BRIEFING as never} onOpen={jest.fn()} onChip={jest.fn()} onMore={jest.fn()} slots={kitBriefingSlots([IDEAS_DTO, INSIGHT_DTO])} />
        </KitScreenHost>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("home-v3-hero-offer")).toBeTruthy();
    expect(screen.getByTestId("home-v3-kit-ideas")).toBeTruthy();
    expect(screen.getByTestId("home-v3-kit-insight")).toBeTruthy();
    expect(screen.queryByTestId("home-v3-brief-msg-post")).toBeNull();
    expect(screen.queryByTestId("home-v3-brief-msg-moment")).toBeNull();
    expect(screen.getByTestId("home-v3-brief-more")).toBeTruthy();
    // On a screen a body tap opens the detail; it never expands in place.
    fireEvent.press(screen.getByLabelText("Your reel saves doubled this month, open"));
    expect(screen.queryByTestId("card-insight-expanded")).toBeNull();
  });
  test("Home's briefing: the cards collapsed under one sentence each; a body tap opens the screen, never expands", () => {
    const record = jest.fn(async () => "");
    render(<KitBriefing cards={[IDEAS_DTO, INSIGHT_DTO]} record={record} />);
    expect(screen.getByTestId("home-v3-kit-ideas")).toBeTruthy();
    expect(screen.getByTestId("home-v3-kit-insight")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Your reel saves doubled this month, open"));
    expect(screen.queryByTestId("card-insight-expanded")).toBeNull();
    expect(screen.getByTestId("card-insight-collapsed")).toBeTruthy();
  });
  test("Me › What Mila can do: every capability from the route, each with its state; per account, one row per inbox", () => {
    const { ME_CAPABILITIES_FIXTURE } = require("./fixtures") as typeof import("./fixtures");
    render(<WhatMilaCanDo capabilities={ME_CAPABILITIES_FIXTURE} setChoice={jest.fn(async () => true)} />);
    expect(screen.getByText("What Mila can do")).toBeTruthy();
    expect(screen.getByTestId("me-can-do-post_ideas-state")).toHaveTextContent("On");
    expect(screen.getByTestId("me-can-do-plan_refresh-state")).toHaveTextContent("Paused");
    expect(screen.getByTestId("me-can-do-pitch_deck-state")).toHaveTextContent("Off");
    const inbox = ME_CAPABILITIES_FIXTURE[0].accounts[0].accountRef;
    expect(screen.getByTestId(`me-can-do-draft_replies:${inbox}-state`)).toHaveTextContent("Off · sam.rivera@example.com");
    // off: Turn on; on: Pause + Turn off; paused: Resume + Turn off
    expect(screen.getByTestId("me-can-do-pitch_deck-on")).toBeTruthy();
    expect(screen.getByTestId("me-can-do-post_ideas-pause")).toBeTruthy();
    expect(screen.getByTestId("me-can-do-post_ideas-off")).toBeTruthy();
    expect(screen.getByTestId("me-can-do-plan_refresh-resume")).toBeTruthy();
    expect(screen.queryByTestId("me-can-do-pitch_deck-off")).toBeNull();
  });
  test("Me: Turn on opens the sheet with the registry's words; only the sheet's Turn on records the yes, with the version shown", async () => {
    const { ME_CAPABILITIES_FIXTURE } = require("./fixtures") as typeof import("./fixtures");
    const setChoice = jest.fn(async () => true);
    render(<WhatMilaCanDo capabilities={ME_CAPABILITIES_FIXTURE} setChoice={setChoice} />);
    fireEvent.press(screen.getByTestId("me-can-do-pitch_deck-on"));
    expect(screen.getByTestId("connect-sheet")).toBeTruthy();
    expect(setChoice).not.toHaveBeenCalled();
    expect(screen.getByTestId("connect-sheet-consent-asks")).toHaveTextContent(/Sharing it with anyone/);
    expect(screen.getByTestId("connect-sheet-consent-reads")).toHaveTextContent(/Write drafts for you to check. Nothing is sent without your tap./);
    expect(screen.getByTestId("connect-sheet-never")).toBeTruthy();
    fireEvent.press(screen.getByTestId("connect-sheet-turn-on"));
    await waitFor(() => expect(setChoice).toHaveBeenCalledWith("pitch_deck", { to: "enabled", accountRef: null, expectedVersion: 0, consentVersion: "pitch_deck/2" }));
  });
  test("Me: Pause, Resume and Turn off go to Me's route with the row's choice version; per account carries the inbox", async () => {
    const { ME_CAPABILITIES_FIXTURE } = require("./fixtures") as typeof import("./fixtures");
    const setChoice = jest.fn(async () => true);
    render(<WhatMilaCanDo capabilities={ME_CAPABILITIES_FIXTURE} setChoice={setChoice} />);
    fireEvent.press(screen.getByTestId("me-can-do-post_ideas-pause"));
    await waitFor(() => expect(setChoice).toHaveBeenCalledWith("post_ideas", { to: "paused", accountRef: null, expectedVersion: 1 }));
    fireEvent.press(screen.getByTestId("me-can-do-plan_refresh-resume"));
    await waitFor(() => expect(setChoice).toHaveBeenCalledWith("plan_refresh", { to: "enabled", accountRef: null, expectedVersion: 2, consentVersion: "plan_refresh/1" }));
    fireEvent.press(screen.getByTestId("me-can-do-plan_refresh-off"));
    await waitFor(() => expect(setChoice).toHaveBeenCalledWith("plan_refresh", { to: "revoked", accountRef: null, expectedVersion: 2 }));
    const inbox = ME_CAPABILITIES_FIXTURE[0].accounts[0].accountRef;
    fireEvent.press(screen.getByTestId(`me-can-do-draft_replies:${inbox}-on`));
    fireEvent.press(screen.getByTestId("connect-sheet-turn-on"));
    await waitFor(() => expect(setChoice).toHaveBeenCalledWith("draft_replies", { to: "enabled", accountRef: inbox, expectedVersion: 0, consentVersion: "draft_replies/2" }));
  });
  test("Me: a paused yes to older words shows the sheet again; a failed save says so; no account, no button", async () => {
    const { ME_CAPABILITIES_FIXTURE } = require("./fixtures") as typeof import("./fixtures");
    const caps = ME_CAPABILITIES_FIXTURE.map((c) => c.key === "plan_refresh" ? { ...c, consent: { ...c.consent, version: "plan_refresh/2" } }
      : c.key === "draft_replies" ? { ...c, accounts: [] } : c);
    const setChoice = jest.fn(async () => false);
    render(<WhatMilaCanDo capabilities={caps} setChoice={setChoice} />);
    fireEvent.press(screen.getByTestId("me-can-do-plan_refresh-resume"));
    expect(screen.getByTestId("connect-sheet")).toBeTruthy();
    // Paused: "Don't offer this again" cannot apply.
    expect(screen.queryByTestId("connect-sheet-never")).toBeNull();
    fireEvent.press(screen.getByTestId("connect-sheet-turn-on"));
    await waitFor(() => expect(screen.getByTestId("connect-sheet-error")).toHaveTextContent("That didn't save. Try again."));
    expect(screen.getByTestId("me-can-do-draft_replies")).toHaveTextContent(/Connect an inbox or Instagram first/);
    expect(screen.queryByTestId("me-can-do-draft_replies-on")).toBeNull();
  });
  test("a Turn-on answered in chat reads Me's list again (the real recorder invalidates GET /me/mila/capabilities)", async () => {
    const { recordOutcomeOverApi } = require("./host") as typeof import("./host");
    const { queryClient } = require("../../../../lib/query-client") as { queryClient: { invalidateQueries: jest.Mock } };
    queryClient.invalidateQueries.mockClear();
    await recordOutcomeOverApi({ card: "idea", ref: "i1", outcome: "accepted" });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(await recordOutcomeOverApi({ card: "turn-on", ref: "t1", outcome: "accepted", action: "enabled", consentVersion: "post_ideas/1" })).toBe("x");
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/v1/me/mila/capabilities"] });
  });
  test("an Insight on a screen opens its detail, so it draws no expand chevron", () => {
    render(<KitScreenHost record={jest.fn(async () => "")}><KitCard dto={INSIGHT_DTO} /></KitScreenHost>);
    expect(screen.queryByTestId("card-chevron")).toBeNull();
  });
});
