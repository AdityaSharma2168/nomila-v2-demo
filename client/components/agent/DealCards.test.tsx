/**
 * DealCards.test — Mila's deal and booking cards (AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS):
 *   - the deal card opens the deal on a tap anywhere (no dead tap); its one action asks Mila in her words
 *   - the reply card is the Muse pattern: the inbox's question, From / To / Subject / body, Send · Edit first · Not now,
 *     "Needs your OK", no "always allow"; Send approves THE proposal with the body's hash; nothing goes out on render
 *   - its state comes from the server: a reopened chat shows "Sent … exactly as you approved it" and offers no Send
 *   - Edit first: her text goes as a new proposal naming the card's own (replaces), which is withdrawn
 *   - Not now withdraws it; an Outlook reply can't be sent from here and says so
 *   - say-no: "by you", Undo reverses the receipt; the polite no still needs Send ("Skip")
 *   - the waiting card's rows open their deals; a booking request is answered only by her confirmed tap
 */
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { AgentCard } from "./AgentCard";
import {
  BOOKING_REQUEST_CARD, DEAL_CARD_CLOSED, DEAL_CARD_FIXTURES, DEAL_CARD_YOURS, DEAL_CLOSED_CARD, DEAL_PENDING_ROWS, REPLY_CARD,
  REPLY_CARD_OUTLOOK, REPLY_CARD_SENT, WAITING_CARD,
} from "../../lib/agent/dealFixtures";
import { bodySha256 } from "../../../shared/bodyHash";
import type { AnyChatCard } from "../../lib/agent/types";

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

jest.mock("../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));

const calls: Array<{ method: string; route: string; data?: any }> = [];
let rows: Record<string, unknown[]> = {};
let liveBookings: Record<string, unknown> = {};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const apiRequest = jest.fn(async (method: string, route: string, data?: unknown) => {
  calls.push({ method, route, data });
  const m = /pending-actions\?deal_id=([^&]+)/.exec(route);
  if (method === "GET" && m) return ok(rows[m[1]] ?? []);
  const b = /\/me\/bookings\/([^/?]+)$/.exec(route);
  if (method === "GET" && b) return liveBookings[b[1]] ? ok({ booking: liveBookings[b[1]] }) : ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  if (method === "POST" && /\/deals\/[^/]+\/pending-actions$/.test(route)) return ok({ id: "pa-new" });
  return ok({ id: "x", status: "approved" });
});
jest.mock("../../lib/query-client", () => ({ ...jest.requireActual("../../lib/query-client"), apiRequest: (...a: unknown[]) => (apiRequest as any)(...a) }));

// Several macrotasks, not one: a query's fetch → resolve → notify chain can outlast a single tick on a loaded machine (the
// "reopened chat reads Sent" case flaked on one).
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); });
beforeEach(() => { calls.length = 0; rows = JSON.parse(JSON.stringify(DEAL_PENDING_ROWS)); liveBookings = {}; });
const posts = () => calls.filter((c) => c.method === "POST");

it("every deal and booking card renders from its fixture", async () => {
  for (const c of DEAL_CARD_FIXTURES) {
    renderAgent(<AgentCard card={c as AnyChatCard} />);
    await flush();
    expect(screen.toJSON()).toBeTruthy();
  }
  expect(posts()).toEqual([]);
});

it("deal card: a tap anywhere opens the deal; the action asks Mila; a closed deal offers no action", async () => {
  const { handlers } = renderAgent(<AgentCard card={DEAL_CARD_YOURS} />);
  fireEvent.press(screen.getByTestId("card-deal"));
  expect(handlers.openLink).toHaveBeenCalledWith({ screen: "deal", id: "o1" }, expect.anything());
  fireEvent.press(screen.getByTestId("deal-action"));
  expect(handlers.reply).toHaveBeenCalledWith("Draft a reply to Northpeak Apparel");
  expect(screen.getByText("Your move")).toBeTruthy();
  expect(screen.getByText("Nothing to flag")).toBeTruthy();
  renderAgent(<AgentCard card={DEAL_CARD_CLOSED} />);
  expect(screen.queryAllByTestId("deal-action")).toHaveLength(0);
  expect(screen.getByText("Done")).toBeTruthy();
});

it("reply card: the Muse approval; Send approves THIS proposal with the body's hash", async () => {
  renderAgent(<AgentCard card={REPLY_CARD} />);
  await flush();
  expect(screen.getByText("Send this email from your Gmail?")).toBeTruthy();
  expect(screen.getByTestId("reply-needs-ok")).toBeTruthy();
  for (const t of ["From", "To", "Subject", "rowan.athlete@gmail.com", "sam@northpeak.example", "Re: November Reels"]) expect(screen.getByText(t)).toBeTruthy();
  expect(screen.queryByText(/always allow/i)).toBeNull();
  expect(screen.getByText("Nothing goes out until you tap Send.")).toBeTruthy();
  expect(posts()).toEqual([]);
  rows.d1 = [{ ...(rows.d1[0] as object), status: "approved", result: { sent: true }, executed_at: "2026-10-12T13:41:00.000Z" }];
  fireEvent.press(screen.getByTestId("reply-send"));
  await flush();
  expect(posts()).toEqual([{ method: "POST", route: "/api/v1/me/pending-actions/pa-1/approve", data: { body_sha256: bodySha256(REPLY_CARD.payload.body) } }]);
  await flush();
  expect(screen.getByText("Sent from your Gmail")).toBeTruthy();
  expect(screen.getByText("Sent exactly as you approved it.")).toBeTruthy();
});

it("reply card: a reopened chat reads 'Sent' from the server and offers no Send", async () => {
  renderAgent(<AgentCard card={REPLY_CARD_SENT} />);
  await flush();
  expect(screen.getByTestId("reply-sent")).toBeTruthy();
  expect(screen.queryByTestId("reply-send")).toBeNull();
});

it("reply card: Edit first sends HER text as a new proposal that replaces the card's own", async () => {
  renderAgent(<AgentCard card={REPLY_CARD} />);
  await flush();
  fireEvent.press(screen.getByTestId("reply-edit"));
  fireEvent.changeText(screen.getByTestId("reply-editor"), "Hi Sam, $2,000 for the two Reels works for me.");
  fireEvent.press(screen.getByTestId("reply-send"));
  await flush();
  const p = posts();
  expect(p[0]).toMatchObject({ route: "/api/v1/me/deals/d1/pending-actions", data: { kind: "send_reply", thread_id: "t1", payload: { body: "Hi Sam, $2,000 for the two Reels works for me.", replaces: "pa-1", reply_intent: "counter" } } });
  expect(p[1]).toEqual({ method: "POST", route: "/api/v1/me/pending-actions/pa-new/approve", data: { body_sha256: bodySha256("Hi Sam, $2,000 for the two Reels works for me.") } });
  // The card's own proposal is withdrawn only after her edited text went out.
  expect(p[2].route).toBe("/api/v1/me/pending-actions/pa-1/dismiss");
});

it("reply card: a failed edited send keeps the card's own proposal, her text and Send, to try again", async () => {
  renderAgent(<AgentCard card={REPLY_CARD} />);
  await flush();
  fireEvent.press(screen.getByTestId("reply-edit"));
  fireEvent.changeText(screen.getByTestId("reply-editor"), "Hi Sam, $2,000 works.");
  apiRequest.mockImplementationOnce(async (method: string, route: string, data?: unknown) => { calls.push({ method, route, data }); return ok({ id: "pa-new" }); });
  apiRequest.mockImplementationOnce(async (method: string, route: string, data?: unknown) => { calls.push({ method, route, data }); throw new Error("502: Couldn't send your reply."); });
  fireEvent.press(screen.getByTestId("reply-send"));
  await flush();
  expect(posts().map((c) => c.route)).not.toContain("/api/v1/me/pending-actions/pa-1/dismiss");
  expect(screen.getByTestId("reply-editor").props.value).toBe("Hi Sam, $2,000 works.");
  expect(screen.getByTestId("reply-send")).toBeTruthy();
});

it("reply card: Not now withdraws it; an Outlook reply says where to send it from", async () => {
  renderAgent(<AgentCard card={REPLY_CARD} />);
  await flush();
  fireEvent.press(screen.getByTestId("reply-not-now"));
  await flush();
  expect(posts()).toEqual([{ method: "POST", route: "/api/v1/me/pending-actions/pa-1/dismiss", data: undefined }]);
  renderAgent(<AgentCard card={REPLY_CARD_OUTLOOK} />);
  expect(screen.getByTestId("reply-not-sendable")).toBeTruthy();
  expect(screen.getByText(/Copy it into Outlook/)).toBeTruthy();
});

it("say-no card: 'by you', Undo reverses the receipt; the polite no still waits for Send", async () => {
  renderAgent(<AgentCard card={DEAL_CLOSED_CARD} />);
  await flush();
  expect(screen.getByText("Closed · Not interested · by you")).toBeTruthy();
  expect(screen.getByText("Send them a short no?")).toBeTruthy();
  expect(screen.getByText("Skip")).toBeTruthy();
  expect(posts()).toEqual([]);
  fireEvent.press(screen.getByTestId("closed-undo"));
  await flush();
  // Undo, then the short no written with the close is withdrawn (the deal is back; no unseen draft stays approvable).
  expect(posts()).toEqual([
    { method: "POST", route: "/api/v1/me/agent-actions/aa-1/undo", data: undefined },
    { method: "POST", route: "/api/v1/me/pending-actions/pa-3/dismiss", data: undefined },
  ]);
  expect(screen.getByText("Back on your board")).toBeTruthy();
});

it("waiting card: each row opens its deal", () => {
  const { handlers } = renderAgent(<AgentCard card={WAITING_CARD} />);
  expect(screen.getByText("3 waiting")).toBeTruthy();
  fireEvent.press(screen.getAllByTestId("waiting-row")[1]);
  expect(handlers.openLink).toHaveBeenCalledWith({ screen: "deal", id: "o2" });
});

it("booking request: Mila's suggestion leads; only her confirmed tap answers, on the existing route", async () => {
  renderAgent(<AgentCard card={BOOKING_REQUEST_CARD} />);
  expect(screen.getByText("Mila would accept. It's your call.")).toBeTruthy();
  fireEvent.press(screen.getByTestId("booking-accept"));
  expect(posts()).toEqual([]);
  fireEvent.press(screen.getByTestId("booking-confirm"));
  await flush();
  expect(posts()).toEqual([expect.objectContaining({ method: "POST", route: expect.stringMatching(/\/bookings\/b1\/accept$/) })]);
});

it("booking request: a reopened chat reads where the booking stands now — answered means no Accept", async () => {
  liveBookings.b1 = { id: "b1", phase: "booked" };
  renderAgent(<AgentCard card={BOOKING_REQUEST_CARD} />);
  await flush();
  expect(screen.getByText("Confirmed")).toBeTruthy();
  expect(screen.queryByTestId("booking-accept")).toBeNull();
  expect(screen.queryByText(/Mila would accept/)).toBeNull();
});
