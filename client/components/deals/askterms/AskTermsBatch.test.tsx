/**
 * AskTermsBatch.test — the ask-for-terms review, rendered: every message is approved on its own,
 * as the exact text that sends, and one tap sends only the approved ones.
 *
 * REVERT CHECKS, red by name:
 *   RC-1  show Approve on a row that was never opened          → "approve is unavailable until the row is opened"
 *   RC-2  keep an approval across an edit                       → "an edit clears the approval…"
 *   RC-3  send every proposal / one shared hash                 → "only approved rows send, each with its own hash…"
 *   RC-4  a fixed or stale count on the primary button          → "the button count follows approvals…"
 *
 * The network boundary is apiRequest, mocked here; nothing reaches a provider.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHash } from "node:crypto";
import type { DealItem } from "../DealCard";
import { AskTermsBatch } from "./AskTermsBatch";
import { apiRequest } from "../../../lib/query-client";

jest.mock("../../../lib/query-client", () => ({ apiRequest: jest.fn() }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("../../BrandLogo", () => ({ BrandLogo: () => null }));
jest.mock("../../../lib/haptics", () => {
  const noop = () => {};
  const fns = { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop };
  return { ...fns, haptics: fns };
});

const api = apiRequest as jest.Mock;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();

function deal(id: string, brand: string): DealItem {
  return {
    id, brandName: brand, category: "PAID", status: "detected", source: "gmail", sourceType: "Email",
    score: null, verdict: null, timeAgo: "2d", aiSummary: "", threadId: `t-${id}`, lastMessageAt: RECENT,
  } as unknown as DealItem;
}

const DEALS = [deal("d1", "Brand One"), deal("d2", "Brand Two"), deal("d3", "Brand Three")];
const BODY: Record<string, string> = {
  pa1: "Hi — could you share the budget and timeline? (one)",
  pa2: "Hi — could you share the deliverables and scope? (two)",
  pa3: "Hi — could you share usage rights? (three)",
};

function proposal(id: string, dealId: string, body: string) {
  return {
    id, athlete_id: "a", deal_id: dealId, thread_id: `t-${dealId}`, kind: "send_reply", status: "pending",
    payload: { body, reply_intent: "request_terms", source: "ask_terms_batch", segment: "fresh", asking: [] },
    result: null, error: null, created_at: null, expires_at: null, approved_at: null, dismissed_at: null, executed_at: null,
  };
}

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (method: string, route: string, data: any) => {
    let out: unknown = {};
    if (route.endsWith("/deals/ask-terms-batch")) {
      out = {
        created: [proposal("pa1", "d1", BODY.pa1), proposal("pa2", "d2", BODY.pa2), proposal("pa3", "d3", BODY.pa3)],
        skipped: [],
        cap: 25,
      };
    } else if (method === "PATCH") {
      const id = route.split("/").pop()!;
      const dealId = { pa1: "d1", pa2: "d2", pa3: "d3" }[id]!;
      out = { ...proposal(id, dealId, data.body), payload: { ...proposal(id, dealId, data.body).payload, edited: true } };
    } else if (route.endsWith("/approve")) {
      out = { status: "approved" };
    }
    return { json: async () => out };
  });
});

async function renderAtReview() {
  // gcTime Infinity: no garbage-collection timers left running after the suite.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AskTermsBatch deals={DEALS} isLoading={false} error={null} onClose={jest.fn()} onDone={jest.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.press(screen.getByText("Review 3 drafts"));
  await screen.findByLabelText("Open Brand One");
}

const sendButton = () => screen.getByTestId("send-approved");
const isDisabled = (el: any) => el.props.accessibilityState?.disabled === true;
const approveCalls = () => api.mock.calls.filter(([, route]) => String(route).endsWith("/approve"));

describe("AskTermsBatch — approve each message", () => {
  it("approve is unavailable until the row is opened; the hint reads 'Open to review' until then", async () => {
    await renderAtReview();
    expect(screen.getAllByText("Open to review")).toHaveLength(3);
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText(/Send \d+ now|I've reviewed them/)).toBeNull(); // the old confirm is gone

    fireEvent.press(screen.getByLabelText("Open Brand One"));
    expect(screen.getByText(BODY.pa1)).toBeTruthy();
    expect(screen.getByTestId("approve-pa1")).toBeTruthy();
    expect(screen.queryByTestId("approve-pa2")).toBeNull();
    expect(screen.getAllByText("Open to review")).toHaveLength(2);

    fireEvent.press(screen.getByTestId("approve-pa1"));
    expect(screen.getByTestId("approved-pa1")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("the button count follows approvals, and the button is off at zero", async () => {
    await renderAtReview();
    expect(screen.getByText("Send 0 approved replies")).toBeTruthy();
    expect(isDisabled(sendButton())).toBe(true);

    fireEvent.press(screen.getByLabelText("Open Brand One"));
    fireEvent.press(screen.getByTestId("approve-pa1"));
    expect(screen.getByText("Send 1 approved reply")).toBeTruthy();
    expect(isDisabled(sendButton())).toBe(false);

    fireEvent.press(screen.getByLabelText("Open Brand Two"));
    fireEvent.press(screen.getByTestId("approve-pa2"));
    expect(screen.getByText("Send 2 approved replies")).toBeTruthy();
  });

  it("an edit clears the approval, and the edited body must be approved again", async () => {
    await renderAtReview();
    fireEvent.press(screen.getByLabelText("Open Brand Two"));
    fireEvent.press(screen.getByTestId("approve-pa2"));
    expect(screen.getByText("Send 1 approved reply")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Edit Brand Two"));
    expect(screen.queryByTestId("approved-pa2")).toBeNull();
    expect(screen.getByText("Send 0 approved replies")).toBeTruthy();
    expect(screen.queryByTestId("approve-pa2")).toBeNull(); // not while editing

    fireEvent.changeText(screen.getByDisplayValue(BODY.pa2), "Edited ask (two)");
    await act(async () => { fireEvent.press(screen.getByText("Save")); });
    await screen.findByText("Edited ask (two)");
    expect(screen.queryByTestId("approved-pa2")).toBeNull();
    expect(screen.getByText("Send 0 approved replies")).toBeTruthy();
    expect(screen.getByTestId("approve-pa2")).toBeTruthy(); // the new body is on screen: approvable again
  });

  it("only approved rows send, each with its own hash and reviewed: true", async () => {
    await renderAtReview();
    // pa1 approved as drafted; pa2 edited then approved; pa3 opened but never approved.
    fireEvent.press(screen.getByLabelText("Open Brand One"));
    fireEvent.press(screen.getByTestId("approve-pa1"));
    fireEvent.press(screen.getByLabelText("Open Brand Two"));
    fireEvent.press(screen.getByLabelText("Edit Brand Two"));
    fireEvent.changeText(screen.getByDisplayValue(BODY.pa2), "Edited ask (two)");
    await act(async () => { fireEvent.press(screen.getByText("Save")); });
    await screen.findByText("Edited ask (two)");
    fireEvent.press(screen.getByTestId("approve-pa2"));
    fireEvent.press(screen.getByLabelText("Open Brand Three"));
    expect(screen.getByText("Send 2 approved replies")).toBeTruthy();

    await act(async () => { fireEvent.press(sendButton()); });
    await waitFor(() => expect(screen.getByText("2 asks sent")).toBeTruthy(), { timeout: 5000 });

    const calls = approveCalls();
    expect(calls.map(([, route]) => route)).toEqual([
      "/api/v1/me/pending-actions/pa1/approve",
      "/api/v1/me/pending-actions/pa2/approve",
    ]);
    expect(calls[0][2]).toEqual({ body_sha256: sha(BODY.pa1), reviewed: true });
    expect(calls[1][2]).toEqual({ body_sha256: sha("Edited ask (two)"), reviewed: true });
    expect(calls[0][2].body_sha256).not.toBe(calls[1][2].body_sha256);
  });
});
