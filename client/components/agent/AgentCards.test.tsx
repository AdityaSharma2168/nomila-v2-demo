/**
 * AgentCards.test — every chat card kind renders from its typed fixture, every tap does something (no dead taps),
 * nothing outgoing happens without the athlete's tap, and failures say nothing was sent.
 */
import React from "react";
import { Linking } from "react-native";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderAgent, makeHandlers, spyApi } from "../../test/agentHarness";
import { fixtureAgentApi } from "../../lib/agent/fixtureApi";
import { AgentCard, AgentCardList, groupCards } from "./AgentCard";
import { ProgressCard } from "./ProgressCard";
import {
  ACTION_CARD, ACTION_CARD_PAYMENT, ALL_CARD_FIXTURES, CAPABILITY_CARDS, CONNECT_CARD, FACT_GROUPS, HOW_CARD, PARTNERS_CARD,
  PAYOUT_NOTE_CARD, PERSONAS, PLAY_CARD, POSITIONING_CARD, PROGRESS_CARD, PROGRESS_DONE, PROGRESS_FAILED, PROPOSAL_CARDS,
  READY_CARD, READY_EXPERIMENTAL, REVEAL_CARD, UNCONFIRMED_CARD, CONSENT_CARD,
  AGE_BAND_CARD, INSIGHT_CARDS, MIA_PREVIEW_CARD, ACTIVITY_CARD, REVEAL_BY_PERSONA, FACT_GROUP_CARE,
} from "../../lib/agent/fixtures";
import type { AnyChatCard } from "../../lib/agent/types";
import { chatTargetFor, routeFor } from "../../lib/agent/navigate";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const oauthConnect = jest.fn(async () => {});
jest.mock("../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: oauthConnect, disconnect: jest.fn(), connecting: false }) }));

const openURL = jest.spyOn(Linking, "openURL").mockImplementation(async () => true);
beforeEach(() => openURL.mockClear());

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("every card kind renders from its fixture", () => {
  it.each(ALL_CARD_FIXTURES.map((c) => [c.kind, c.id, c] as const))("%s (%s)", (_kind, _id, card) => {
    renderAgent(<AgentCard card={card as AnyChatCard} />);
    expect(screen.toJSON()).toBeTruthy();
  });

  it("an unknown kind is skipped, never crashed on; a malformed card is dropped", () => {
    renderAgent(<AgentCardList cards={[{ id: "x", kind: "hologram", payload: {} }, { kind: "action" }, ACTION_CARD]} />);
    expect(screen.getAllByTestId("card-action")).toHaveLength(1);
  });

  it("consecutive capabilities become one grid; everything else stands alone", () => {
    const groups = groupCards([MIA_PREVIEW_CARD, REVEAL_CARD, PLAY_CARD, ...CAPABILITY_CARDS]);
    expect(groups.map((g) => g.kind)).toEqual(["one", "one", "one", "capabilities"]);
    renderAgent(<AgentCardList cards={[REVEAL_CARD, ...CAPABILITY_CARDS]} />);
    expect(screen.getByTestId("capability-grid")).toBeTruthy();
  });
});

describe("action card: nothing goes out without the tap", () => {
  it("shows the draft, the money and the verb's button; renders without calling the API", () => {
    const { api } = renderAgent(<AgentCard card={ACTION_CARD} />);
    expect(screen.getByText(ACTION_CARD.payload.body!)).toBeTruthy();
    expect(screen.getByTestId("action-money").props.children).toBe("$1,200");
    expect(screen.getByText("Send")).toBeTruthy();
    expect(screen.getByText("Nothing goes out until you tap.")).toBeTruthy();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.decline).not.toHaveBeenCalled();
  });

  it("Send approves with the text on screen, then says it went", async () => {
    const { api } = renderAgent(<AgentCard card={ACTION_CARD} />);
    fireEvent.press(screen.getByTestId("action-approve"));
    await waitFor(() => expect(screen.getByTestId("action-done")).toBeTruthy());
    expect(api.approve).toHaveBeenCalledWith("appr-1", ACTION_CARD.payload.body, undefined);
    expect(screen.queryByTestId("action-approve")).toBeNull();
  });

  it("Edit opens the draft in place; Save keeps it on the card and Send attests the edited text", async () => {
    const { api } = renderAgent(<AgentCard card={ACTION_CARD} />);
    fireEvent.press(screen.getByTestId("action-edit"));
    fireEvent.changeText(screen.getByTestId("action-editor"), "A shorter reply.");
    fireEvent.press(screen.getByTestId("action-save"));
    expect(screen.getByText("A shorter reply.")).toBeTruthy();
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("action-approve"));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith("appr-1", ACTION_CARD.payload.body, "A shorter reply."));
  });

  it("Decline dismisses and says nothing was sent", async () => {
    const { api } = renderAgent(<AgentCard card={ACTION_CARD} />);
    fireEvent.press(screen.getByTestId("action-decline"));
    await waitFor(() => expect(screen.getByTestId("action-declined")).toBeTruthy());
    expect(api.decline).toHaveBeenCalledWith("appr-1");
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("a reopened chat's card starts where its row stands now (the server attaches `approval` on load): never asks again", () => {
    const withState = (state: string) => ({ ...ACTION_CARD, payload: { ...ACTION_CARD.payload, approval: { state, at: "2026-11-01T10:00:00.000Z" } } }) as AnyChatCard;
    const { api, unmount } = renderAgent(<AgentCard card={withState("sent")} />);
    expect(screen.getByTestId("action-done")).toBeTruthy();
    expect(screen.queryByTestId("action-approve")).toBeNull();
    expect(screen.queryByText("Needs your OK")).toBeNull();
    unmount();
    const declined = renderAgent(<AgentCard card={withState("declined")} />);
    expect(screen.getByTestId("action-declined")).toBeTruthy();
    expect(screen.queryByTestId("action-approve")).toBeNull();
    declined.unmount();
    const failed = renderAgent(<AgentCard card={withState("failed")} />);
    expect(screen.getByTestId("action-failed")).toBeTruthy();
    expect(screen.queryByTestId("action-approve")).toBeNull();
    failed.unmount();
    renderAgent(<AgentCard card={withState("expired")} />);
    expect(screen.getByTestId("action-expired")).toBeTruthy();
    expect(screen.queryByTestId("action-approve")).toBeNull();
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("a reopened card still waiting opens as before", () => {
    renderAgent(<AgentCard card={{ ...ACTION_CARD, payload: { ...ACTION_CARD.payload, approval: { state: "needs_approval", at: null } } } as AnyChatCard} />);
    expect(screen.getByTestId("action-approve")).toBeTruthy();
  });

  it("a failed send keeps the draft and the buttons, and says nothing was sent", async () => {
    renderAgent(<AgentCard card={ACTION_CARD} />, { opts: { fail: true } });
    fireEvent.press(screen.getByTestId("action-approve"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toBeTruthy());
    expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
    expect(screen.getByTestId("action-approve")).toBeTruthy();
  });

  it("a payment with no draft offers no Edit; small and large amounts read the same way", () => {
    renderAgent(<AgentCard card={ACTION_CARD_PAYMENT} />);
    expect(screen.queryByTestId("action-edit")).toBeNull();
    expect(screen.getByTestId("action-money").props.children).toBe("$80.50");
    screen.unmount();
    renderAgent(<AgentCard card={PERSONAS.youth.action} />);
    expect(screen.getByTestId("action-money").props.children).toBe("$50");
    screen.unmount();
    renderAgent(<AgentCard card={PERSONAS.pro.action} />);
    expect(screen.getByTestId("action-money").props.children).toBe("$50,000");
  });

  it("a partner rule is explained in a line, never a block: the tap still works", async () => {
    const { api } = renderAgent(<AgentCard card={PAYOUT_NOTE_CARD} />);
    expect(screen.getByTestId("partner-note")).toBeTruthy();
    fireEvent.press(screen.getByTestId("action-approve"));
    await waitFor(() => expect(api.approve).toHaveBeenCalled());
  });
});

describe("chat skill: \"Want me to save that?\" and tap-to-open", () => {
  const SAVE_CARD = {
    id: "action:save-1", kind: "action", title: "Something you told me", links: [], runId: "run-1",
    payload: { approvalId: "save-1", verb: "save_memory", body: "Signed with a local cafe through June.", money: null, buttons: ["approve", "decline"] },
  } as unknown as AnyChatCard;

  it("a save card asks first: Save and Not now, no Edit; nothing is saved until the tap", async () => {
    const { api } = renderAgent(<AgentCard card={SAVE_CARD} />);
    expect(screen.getByText("Want me to save that?")).toBeTruthy();
    expect(screen.getByText("Signed with a local cafe through June.")).toBeTruthy();
    expect(screen.getByText("Nothing is saved until you tap Save.")).toBeTruthy();
    expect(screen.queryByTestId("action-edit")).toBeNull();
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("action-approve"));
    await waitFor(() => expect(screen.getByTestId("action-done")).toBeTruthy());
    expect(api.approve).toHaveBeenCalledWith("save-1", "Signed with a local cafe through June.", undefined);
    expect(screen.getByText(/Saved\./)).toBeTruthy();
  });

  it("Not now says it was not saved", async () => {
    renderAgent(<AgentCard card={SAVE_CARD} />);
    expect(screen.getByText("Not now")).toBeTruthy();
    fireEvent.press(screen.getByTestId("action-decline"));
    await waitFor(() => expect(screen.getByText("Not saved.")).toBeTruthy());
  });

  it("an open-screen card opens its one screen through the host; no handler, no button", () => {
    const card = {
      id: "open:1", kind: "open-screen", title: "Your goals", runId: "run-1",
      payload: { screen: "goals", id: null, label: "Your goals", why: "Your plan lives there." },
      links: [{ label: "Open Your goals", target: { screen: "goals" } }],
    } as unknown as AnyChatCard;
    const handlers = makeHandlers();
    renderAgent(<AgentCard card={card} />, { handlers });
    expect(screen.getByText("Your plan lives there.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("open-screen-open"));
    expect(handlers.openLink).toHaveBeenCalledWith({ screen: "goals" }, expect.objectContaining({ label: "Open Your goals" }));
    screen.unmount();
    renderAgent(<AgentCard card={card} />, { handlers: {} });
    expect(screen.queryByTestId("open-screen-open")).toBeNull();
  });

  it("each allowed screen maps in the chat and in the app; anything else does nothing", () => {
    expect(chatTargetFor({ screen: "home" })).toEqual({ screen: "home" });
    expect(chatTargetFor({ screen: "goals" })).toEqual({ screen: "goals" });
    expect(chatTargetFor({ screen: "goal", id: "g-1" })).toEqual({ screen: "goals", goalId: "g-1" });
    expect(chatTargetFor({ screen: "me" })).toEqual({ screen: "me" });
    expect(chatTargetFor({ screen: "scouting", id: "room_to_grow" })).toEqual({ screen: "me", section: "room_to_grow" });
    expect(chatTargetFor({ screen: "knows" })).toEqual({ screen: "facts" });
    expect(chatTargetFor({ screen: "settings" })).toBeNull();
    expect(routeFor({ screen: "goal", id: "g-1" })).toEqual({ tab: "Strategy", screen: "StrategyRoot", params: { goalId: "g-1" } });
    expect(routeFor({ screen: "knows" })).toEqual({ tab: "Home", screen: "Knows" });
    expect(routeFor({ screen: "scouting", id: "mia" })).toEqual({ tab: "Home", screen: "Me", params: { section: "mia" } });
  });
});

describe("progress, ready, connect, how I got this", () => {
  it("progress: steps and a bar; done is full; failed offers retry only when given one", () => {
    renderAgent(<AgentCard card={PROGRESS_CARD} />);
    expect(screen.getByTestId("progress-line").props.children).toBe("Step 2 of 4 · Writing copy");
    expect(screen.getByTestId("progress-bar").props.accessibilityValue.now).toBe(38);
    screen.unmount();
    renderAgent(<AgentCard card={PROGRESS_DONE} />);
    expect(screen.getByTestId("progress-bar").props.accessibilityValue.now).toBe(100);
    screen.unmount();
    renderAgent(<AgentCard card={PROGRESS_FAILED} />);
    expect(screen.getByText("Couldn't finish this.")).toBeTruthy();
    expect(screen.queryByTestId("progress-retry")).toBeNull();
    screen.unmount();
    // A plan refresh that did not finish says so, softly (part of it may have been written).
    renderAgent(<AgentCard card={{ ...PROGRESS_FAILED, payload: { ...PROGRESS_FAILED.payload, planRunId: "wf-run-1" } }} />);
    expect(screen.getByText("I couldn't finish updating your plan. Goals shows the latest I have; ask me again in a bit.")).toBeTruthy();
  });

  it("ProgressCard passes its named steps through to the view", () => {
    const card = { title: "Updating your plan", payload: { step: 2, of: 2, label: "Getting your post kits ready", state: "running" as const, steps: [{ label: "Planning your week", state: "done" as const }, { label: "Getting your post kits ready", state: "running" as const }] } };
    renderAgent(<ProgressCard card={card} />);
    expect(screen.getByTestId("progress-steps")).toBeTruthy();
    expect(screen.getByText("Planning your week")).toBeTruthy();
  });

  it("ready: Review opens the item through the host; experimental is labelled", () => {
    const { handlers } = renderAgent(<AgentCard card={READY_CARD} />);
    fireEvent.press(screen.getByTestId("ready-open"));
    expect(handlers.openLink).toHaveBeenCalledWith({ screen: "studio", id: "studio-postkit-1" }, READY_CARD.links[0]);
    screen.unmount();
    renderAgent(<AgentCard card={READY_EXPERIMENTAL} />);
    expect(screen.getByTestId("ready-experimental")).toBeTruthy();
  });

  it("ready without an open handler draws no button (no dead tap)", () => {
    renderAgent(<AgentCard card={READY_CARD} />, { handlers: {} });
    expect(screen.queryByTestId("ready-open")).toBeNull();
  });

  it("connect: the reason and the access in plain words; Connect, then connected; Not now says where", async () => {
    const { handlers } = renderAgent(<AgentCard card={CONNECT_CARD} />);
    expect(screen.getByText(CONNECT_CARD.payload.why)).toBeTruthy();
    expect(screen.getByText("See when you're busy or free")).toBeTruthy();
    fireEvent.press(screen.getByTestId("connect-go"));
    await waitFor(() => expect(screen.getByTestId("connect-done")).toBeTruthy());
    expect(handlers.connect).toHaveBeenCalledWith("google_calendar");
    expect(handlers.act).toHaveBeenCalledWith([{ type: "connect", connectorId: "google_calendar", response: "started" }]);
    screen.unmount();
    const r = renderAgent(<AgentCard card={CONNECT_CARD} />);
    fireEvent.press(screen.getByTestId("connect-later-btn"));
    expect(screen.getByTestId("connect-later")).toBeTruthy();
    expect(r.handlers.act).toHaveBeenCalledWith([{ type: "connect", connectorId: "google_calendar", response: "declined" }]);
    expect(r.handlers.connect).not.toHaveBeenCalled();
  });

  it("connect with no host handler uses the existing OAuth door", async () => {
    renderAgent(<AgentCard card={CONNECT_CARD} />, { handlers: {} });
    fireEvent.press(screen.getByTestId("connect-go"));
    await waitFor(() => expect(oauthConnect).toHaveBeenCalled());
  });

  it("how I got this: the why and each fact with a tappable source", () => {
    renderAgent(<AgentCard card={HOW_CARD} />);
    expect(screen.getByText(HOW_CARD.payload.why)).toBeTruthy();
    expect(screen.getAllByTestId("how-fact")).toHaveLength(3);
    expect(screen.getAllByTestId("how-source")[0].props.accessibilityRole).toBe("link");
  });

  it("a turn's run id adds a lazy How I got this, fetched on first open", async () => {
    const { api } = renderAgent(<AgentCardList cards={[]} runId="run-9" />);
    expect(api.howIGotThis).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("turn-how-toggle"));
    await waitFor(() => expect(screen.getByTestId("how-body")).toBeTruthy());
    expect(api.howIGotThis).toHaveBeenCalledWith("run-9");
  });
});

describe("the presentation and onboarding cards", () => {
  it("the reveal (#891): the idea, 3–5 highlights, where you stand and timely windows, each sourced", () => {
    renderAgent(<AgentCard card={REVEAL_CARD} />);
    expect(screen.getByText(REVEAL_CARD.payload.headline)).toBeTruthy();
    expect(screen.getAllByTestId("reveal-highlight")).toHaveLength(4);
    expect(screen.getByTestId("reveal-standing")).toBeTruthy();
    expect(screen.getAllByTestId("reveal-window")).toHaveLength(2);
  });

  it("positioning, partners, unconfirmed draw their parts", () => {
    renderAgent(<AgentCardList cards={[POSITIONING_CARD, PARTNERS_CARD, UNCONFIRMED_CARD]} />);
    expect(screen.getAllByTestId("pillar")).toHaveLength(3);
    expect(screen.getAllByTestId("partner-category")).toHaveLength(3);
    expect(screen.getAllByTestId("unconfirmed-item")).toHaveLength(3);
  });

  it("small and large read the same way: youth and pro reveals and M.I.A. previews", () => {
    renderAgent(<AgentCardList cards={[REVEAL_BY_PERSONA.youth.mia, REVEAL_BY_PERSONA.youth.reveal, REVEAL_BY_PERSONA.pro.mia, REVEAL_BY_PERSONA.pro.reveal]} />);
    expect(screen.getByText("A small, real following that watches what you post")).toBeTruthy();
    expect(screen.getByText("1.5–2M followers across platforms")).toBeTruthy();
    expect(screen.getAllByTestId("card-mia-preview")).toHaveLength(2);
  });

  it("the play starts in Mila; unconfirmed offers connect or tell", () => {
    const { handlers } = renderAgent(<AgentCardList cards={[PLAY_CARD, UNCONFIRMED_CARD]} />);
    fireEvent.press(screen.getByTestId("play-start"));
    expect(handlers.startWorkflow).toHaveBeenCalledWith(PLAY_CARD.payload.startPrompt);
    fireEvent.press(screen.getAllByTestId("unconfirmed-connect")[0]);
    expect(handlers.connect).toHaveBeenCalledWith("instagram");
    fireEvent.press(screen.getByTestId("unconfirmed-tell"));
    expect(handlers.prefill).toHaveBeenCalledWith("The causes that matter most to me are ");
  });

  it("M.I.A. preview (mia-preview/1): Home's own block — of 850, the eight bands from ringBands(assessment), Preliminary", () => {
    const { handlers } = renderAgent(<AgentCard card={MIA_PREVIEW_CARD} />);
    expect(screen.getByText("Your marketability · Preliminary")).toBeTruthy();
    expect(screen.getByTestId("intelligence-ring").props.accessibilityLabel).toBe("M.I.A. 540 out of 850, 8 bands");
    expect(screen.getByTestId("ring-legend")).toBeTruthy();
    // "Preliminary" once (the tag): one plain line, no confidence line, no label line.
    expect(screen.getByText("Built from public information. It firms up as you confirm facts and connect your accounts.")).toBeTruthy();
    expect(screen.queryByText("Preliminary — connect to sharpen")).toBeNull();
    expect(screen.queryByText(/still early/)).toBeNull();
    expect(screen.queryByTestId("home-preliminary")).toBeNull();
    expect(screen.queryByText("Open My Intelligence")).toBeNull();
    // The evidence step is a line; the connect step starts ITS connector.
    expect(screen.getByText("Results from this season would firm up Performance.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("mia-sharpen"));
    expect(handlers.connect).toHaveBeenCalledWith("instagram");
  });

  it("M.I.A. preview with no connector to suggest: one general Connect an account, which asks Mila", () => {
    const { handlers } = renderAgent(<AgentCard card={REVEAL_BY_PERSONA.pro.mia} />);
    expect(screen.queryByTestId("mia-sharpen")).toBeNull();
    fireEvent.press(screen.getByTestId("mia-connect-any"));
    expect(handlers.reply).toHaveBeenCalledWith("Help me connect an account.");
    expect(handlers.connect).not.toHaveBeenCalled();
  });

  it("live research (#891 events): reading now, running counts, discoveries with their sources", () => {
    renderAgent(<AgentCard card={ACTIVITY_CARD} />);
    expect(screen.getByTestId("activity-reading").props.children).toBe("Reading example-stats.com…");
    expect(screen.getByTestId("activity-counts").props.children).toBe("4 sources · 3 finds");
    expect(screen.getAllByTestId("activity-discovery")).toHaveLength(3);
  });

  it("quick question (#891): an option is sent as the athlete's reply, then the card settles", () => {
    const { handlers } = renderAgent(<AgentCard card={REVEAL_BY_PERSONA.college.quick} />);
    expect(screen.getByText(REVEAL_BY_PERSONA.college.quick.payload.why)).toBeTruthy();
    fireEvent.press(screen.getAllByTestId("quick-option")[0]);
    expect(handlers.reply).toHaveBeenCalledWith("Yes, I'll tell you");
    expect(screen.getByTestId("quick-answered")).toBeTruthy();
  });

  it("early rate ranges (#891): wide, with drivers and confidence, and connect to sharpen — small and large alike", () => {
    const { handlers } = renderAgent(<AgentCard card={REVEAL_BY_PERSONA.youth.rates} />);
    expect(screen.getByText("$25–150")).toBeTruthy();
    expect(screen.getByText("Low confidence")).toBeTruthy();
    // One button per connector the server named, each starting that one.
    const buttons = screen.getAllByTestId("rates-sharpen");
    expect(buttons).toHaveLength(2);
    fireEvent.press(buttons[1]);
    expect(handlers.connect).toHaveBeenCalledWith("tiktok");
    screen.unmount();
    const r = renderAgent(<AgentCard card={REVEAL_BY_PERSONA.pro.rates} />);
    expect(screen.getByText("$150,000–600,000")).toBeTruthy();
    // None named while still public-only: the general button, which asks Mila.
    fireEvent.press(screen.getByTestId("rates-connect-any"));
    expect(r.handlers.reply).toHaveBeenCalledWith("Help me connect an account.");
  });

  it("a care fact shows plainly in the review, marked", () => {
    renderAgent(<AgentCard card={FACT_GROUP_CARE} />);
    expect(screen.getByText(FACT_GROUP_CARE.payload.facts[0].claim)).toBeTruthy();
    expect(screen.getByTestId("fact-care")).toBeTruthy();
  });

  it("reveal and insight (#890 shapes): the headline, each highlight with its sources; the angle in words", () => {
    renderAgent(<AgentCardList cards={[REVEAL_CARD, ...INSIGHT_CARDS]} />);
    expect(screen.getByText(REVEAL_CARD.payload.headline)).toBeTruthy();
    expect(screen.getAllByTestId("reveal-highlight")).toHaveLength(4);
    expect(screen.getByTestId("card-insight-timing")).toBeTruthy();
    expect(screen.getByText("A gap to close")).toBeTruthy();
  });

  it("fact review: right, fix (your words win), remove, then all look right — each an action on the turn", async () => {
    const { handlers } = renderAgent(<AgentCard card={FACT_GROUPS[0]} />);
    const [f1, f2, f3] = FACT_GROUPS[0].payload.facts;
    expect(screen.getByText("Sources disagree on this")).toBeTruthy();
    fireEvent.press(within(screen.getByTestId(`fact-${f1.factId}`)).getByTestId("fact-confirm"));
    await waitFor(() => expect(within(screen.getByTestId(`fact-${f1.factId}`)).getByText("Confirmed")).toBeTruthy());
    fireEvent.press(within(screen.getByTestId(`fact-${f2.factId}`)).getByTestId("fact-fix"));
    fireEvent.changeText(screen.getByTestId("fact-editor"), "You're from [Hometown B]");
    fireEvent.press(screen.getByTestId("fact-save"));
    await waitFor(() => expect(screen.getByTestId("fact-correction")).toBeTruthy());
    fireEvent.press(screen.getByTestId("fact-all-right"));
    await waitFor(() => expect(screen.getByText("3 of 3 checked")).toBeTruthy());
    expect(handlers.act.mock.calls).toEqual([
      [[{ type: "fact_review", factId: f1.factId, action: "confirm" }], { reply: false }],
      [[{ type: "fact_review", factId: f2.factId, action: "correct", correction: "You're from [Hometown B]" }], { reply: false }],
      [[{ type: "fact_review", factId: f3.factId, action: "confirm" }, { type: "facts_reviewed" }], { reply: true }],
    ]);
  });

  it("fact review without a place to send answers draws no controls (no dead taps)", () => {
    renderAgent(<AgentCard card={FACT_GROUPS[0]} />, { handlers: {} });
    expect(screen.queryByTestId("fact-confirm")).toBeNull();
  });

  it("goal proposal: why now, value, next decision; Accept; Edit saves the athlete's words; Skip", async () => {
    const { handlers } = renderAgent(<AgentCardList cards={PROPOSAL_CARDS} />);
    const [a, b, c] = screen.getAllByTestId("card-goal-proposal");
    expect(within(a).getByText("What it's worth")).toBeTruthy();
    expect(within(a).getByText("This season")).toBeTruthy();
    fireEvent.press(within(a).getByTestId("goal-accept"));
    await waitFor(() => expect(within(screen.getAllByTestId("card-goal-proposal")[0]).getByTestId("goal-accepted")).toBeTruthy());
    fireEvent.press(within(b).getByTestId("goal-edit"));
    fireEvent.changeText(screen.getByTestId("goal-editor"), "Grow my audience my way");
    fireEvent.press(screen.getByTestId("goal-save"));
    await waitFor(() => expect(screen.getByTestId("goal-her-words")).toBeTruthy());
    fireEvent.press(within(c).getByTestId("goal-skip"));
    await waitFor(() => expect(screen.getByTestId("goal-skipped")).toBeTruthy());
    expect(handlers.act.mock.calls.map((x: unknown[]) => x[0])).toEqual([
      [{ type: "goal", decisionId: "dec-1", response: "accept" }],
      [{ type: "goal", decisionId: "dec-2", response: "edit", text: "Grow my audience my way" }],
      [{ type: "goal", decisionId: "dec-3", response: "skip" }],
    ]);
  });

  it("capability: the tap is recorded and the host starts it; one that isn't live says Coming soon and is not a button", () => {
    const { handlers } = renderAgent(<AgentCard card={CAPABILITY_CARDS[0]} />);
    fireEvent.press(screen.getByTestId("card-capability"));
    expect(handlers.act).toHaveBeenCalledWith([{ type: "capability", capabilityId: "deals" }]);
    expect(handlers.startCapability).toHaveBeenCalledWith(CAPABILITY_CARDS[0].payload.capability);
    screen.unmount();
    renderAgent(<AgentCard card={CAPABILITY_CARDS[4]} />);
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect(screen.getByTestId("card-capability").props.accessibilityRole).toBeUndefined();
  });

  it("consent: fixed points; Agree is an action that asks Mila to go on", async () => {
    const { handlers } = renderAgent(<AgentCard card={CONSENT_CARD} />);
    expect(screen.getByText(CONSENT_CARD.payload.points[1])).toBeTruthy();
    fireEvent.press(screen.getByTestId("consent-agree"));
    await waitFor(() => expect(screen.getByTestId("consent-done")).toBeTruthy());
    expect(handlers.act).toHaveBeenCalledWith([{ type: "consent", consentId: "how_mila_works/1", response: "agree" }], { reply: true });
  });

  it("age band: optional — a band is recorded, Skip records nothing", async () => {
    const { handlers } = renderAgent(<AgentCard card={AGE_BAND_CARD} />);
    fireEvent.press(screen.getByTestId("age-18_plus"));
    await waitFor(() => expect(screen.getByTestId("age-done")).toBeTruthy());
    expect(handlers.act).toHaveBeenCalledWith([{ type: "age_band", value: "18_plus" }]);
    screen.unmount();
    const r = renderAgent(<AgentCard card={AGE_BAND_CARD} />);
    fireEvent.press(screen.getByTestId("age-skip"));
    expect(screen.getByTestId("age-done")).toBeTruthy();
    expect(r.handlers.act).not.toHaveBeenCalled();
  });
});

describe("no dead taps", () => {
  /** Press every button and link on a freshly rendered card; each must call a handler or the API, or change the card. */
  it.each(ALL_CARD_FIXTURES.map((c) => [c.kind, c.id, c] as const))("%s (%s)", async (_k, _id, card) => {
    const probe = () => renderAgent(<AgentCard card={card as AnyChatCard} />, { api: spyApi(fixtureAgentApi()), handlers: makeHandlers() });
    let r = probe();
    const count = r.UNSAFE_root.findAll((n: any) => (n.props.accessibilityRole === "button" || n.props.accessibilityRole === "link") && typeof n.props.onPress === "function" && typeof n.type !== "string").length;
    r.unmount();
    for (let i = 0; i < count; i++) {
      r = probe();
      const before = JSON.stringify(r.toJSON());
      const targets = r.UNSAFE_root.findAll((n: any) => (n.props.accessibilityRole === "button" || n.props.accessibilityRole === "link") && typeof n.props.onPress === "function" && typeof n.type !== "string");
      const t = targets[i];
      if (!t || t.props.disabled || t.props.accessibilityState?.disabled) { r.unmount(); continue; }
      fireEvent.press(t);
      await flush();
      const handlerCalls = Object.values(r.handlers).reduce((n, f) => n + (f as jest.Mock).mock.calls.length, 0);
      const apiCalls = Object.values(r.api).reduce((n, f) => n + ((f as jest.Mock).mock?.calls.length ?? 0), 0);
      const changed = JSON.stringify(r.toJSON()) !== before;
      const opened = openURL.mock.calls.length;
      openURL.mockClear();
      expect({ card: card.id, button: i, live: handlerCalls + apiCalls + opened > 0 || changed }).toEqual({ card: card.id, button: i, live: true });
      r.unmount();
    }
  });
});
