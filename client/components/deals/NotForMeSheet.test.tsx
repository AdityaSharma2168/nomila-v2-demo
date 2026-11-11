/**
 * NotForMeSheet, rendered: a reason is required; "Just close it" records her reason (dispose) and sends nothing; the
 * polite no is offered for a real offer only and goes out only on "Close and send" (the governed send, before the
 * close); the receipt is labelled as hers, with Undo. Hooks and the send are mocked; no provider is reached.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { NotForMeSheet } from "./NotForMeSheet";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
jest.mock("../../lib/dealQueryKeys", () => ({ invalidateDealQueries: jest.fn(async () => undefined) }));
jest.mock("../../lib/haptics", () => ({ haptics: { tap: jest.fn(), select: jest.fn(), press: jest.fn(), success: jest.fn() } }));
const api = jest.fn(async (..._a: unknown[]) => ({ json: async () => ({ ok: true }) }));
jest.mock("../../lib/query-client", () => ({ apiRequest: (...a: unknown[]) => api(...a) }));
const generate = jest.fn();
jest.mock("../../hooks/use-deal-draft", () => ({
  useDealDraft: () => ({ draft: "Thanks so much for thinking of me.", streaming: false, error: null, threadId: "t-draft", generate, editDraft: jest.fn() }),
}));
const propose = jest.fn(async (..._a: unknown[]) => ({ id: "p" }));
jest.mock("../../hooks/use-pending-actions", () => ({
  proposeAndApproveReply: (...a: unknown[]) => propose(...a),
  sendErrorMessage: () => "Check your Gmail connection and try again.",
}));
const undo = jest.fn(async () => ({ id: "r" }));
jest.mock("./receipts", () => ({ undoLatest: (...a: unknown[]) => (undo as any)(...a), isDisposeReceipt: () => true }));

const props = () => ({ dealId: "d1", threadId: "t1", brandName: "Nuun", onClose: jest.fn(), onClosed: jest.fn() });

beforeEach(() => { api.mockClear(); propose.mockClear(); generate.mockClear(); undo.mockClear(); });

it("Just close it records her reason and sends nothing; the receipt is hers, with Undo", async () => {
  render(<NotForMeSheet {...props()} />);
  fireEvent.press(screen.getByTestId("not-for-me-not_interested"));
  await act(async () => { fireEvent.press(screen.getByTestId("not-for-me-close")); });
  expect(api).toHaveBeenCalledWith("POST", "/api/v1/me/deals/d1/dispose", { disposition: "not_interested" });
  expect(propose).not.toHaveBeenCalled();
  expect(screen.getByText("Closed as not interested · by you")).toBeTruthy();
  expect(screen.getByText("Nothing was sent to Nuun.")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("not-for-me-undo")); });
  expect(undo).toHaveBeenCalledWith("d1", "reclassify", expect.any(Function));
  expect(screen.getByText("Reopened · by you")).toBeTruthy();
});

it("spam gets no polite no", () => {
  render(<NotForMeSheet {...props()} />);
  fireEvent.press(screen.getByTestId("not-for-me-not_a_deal"));
  expect(screen.queryByTestId("not-for-me-say-no")).toBeNull();
});

it("a polite no is drafted on request and goes out only on Close and send, before the close", async () => {
  render(<NotForMeSheet {...props()} />);
  fireEvent.press(screen.getByTestId("not-for-me-expired"));
  fireEvent(screen.getByTestId("not-for-me-say-no"), "valueChange", true);
  expect(generate).toHaveBeenCalledWith({ reply_intent: "decline", intent: "decline" });
  await act(async () => { fireEvent.press(screen.getByTestId("not-for-me-send")); });
  expect(propose).toHaveBeenCalledWith({ dealId: "d1", threadId: "t-draft", body: "Thanks so much for thinking of me.", payload: { reply_intent: "decline" } });
  expect(api).toHaveBeenCalledWith("POST", "/api/v1/me/deals/d1/dispose", { disposition: "expired" });
  expect(propose.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[0]);
  expect(screen.getByText("Your short no went to Nuun.")).toBeTruthy();
});

it("a failed no closes nothing and says why", async () => {
  propose.mockRejectedValueOnce(new Error("500: x"));
  render(<NotForMeSheet {...props()} />);
  fireEvent.press(screen.getByTestId("not-for-me-not_interested"));
  fireEvent(screen.getByTestId("not-for-me-say-no"), "valueChange", true);
  await act(async () => { fireEvent.press(screen.getByTestId("not-for-me-send")); });
  expect(api).not.toHaveBeenCalled();
  expect(screen.getByText("Check your Gmail connection and try again.")).toBeTruthy();
});
