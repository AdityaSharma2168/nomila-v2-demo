/**
 * ReplySheet, rendered: the type's choices are always switchable (a seeded draft never locks them), a counter shows
 * "their term → your ask", "Send as my team" appears only with a named team member (D2), the send proposes on the
 * draft's own thread with her intent, and a failed send keeps her text and says why. A sent "yes" that marked the
 * deal agreed shows the receipt, labelled as hers. Hooks and the send are mocked; no provider is reached.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ReplySheet } from "./ReplySheet";
import { INTENTS_BY_TYPE, REPLY_INTENT_LABEL } from "../../../shared/deals";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn(async () => undefined) }) }));
jest.mock("../../lib/dealQueryKeys", () => ({ invalidateDealQueries: jest.fn(async () => undefined) }));
jest.mock("../../lib/haptics", () => ({ haptics: { tap: jest.fn(), select: jest.fn(), press: jest.fn(), success: jest.fn() } }));

const generate = jest.fn();
let draftState = { draft: "Hi Sam, thanks — happy to do it.", streaming: false, error: null as string | null, threadId: "t-draft" as string | null };
const editDraft = jest.fn((v: string) => { draftState = { ...draftState, draft: v }; });
jest.mock("../../hooks/use-deal-draft", () => ({
  useDealDraft: () => ({ ...draftState, generate, editDraft, persistDraft: jest.fn() }),
}));
let prefs: Record<string, string> | null = null;
jest.mock("../../hooks/use-deals", () => ({ useDealPreferences: () => ({ data: { deal_preferences: prefs } }) }));
const propose = jest.fn();
jest.mock("../../hooks/use-pending-actions", () => ({
  proposeAndApproveReply: (...a: unknown[]) => propose(...a),
  sendErrorMessage: () => "Check your Gmail connection and try again.",
}));
jest.mock("./receipts", () => ({ undoLatest: jest.fn(async () => ({ id: "r" })), isAgreedReceipt: () => true }));

const paid = INTENTS_BY_TYPE.paid_content.map((intent) => ({ intent, label: REPLY_INTENT_LABEL[intent] }));

const props = (over: Partial<React.ComponentProps<typeof ReplySheet>> = {}) => ({
  dealId: "d1", threadId: "t-lead", brandName: "Gymshark", dealType: "paid_content" as const, actions: paid,
  terms: { fee: { amount: 1400, unit: "flat" as const }, usage: { paid: true, months: 12 }, unknown: [] },
  initialIntent: "accept_terms" as const, onClose: jest.fn(), onSent: jest.fn(), ...over,
});

beforeEach(() => {
  generate.mockClear(); editDraft.mockClear(); propose.mockReset();
  prefs = null;
  draftState = { draft: "Hi Sam, thanks — happy to do it.", streaming: false, error: null, threadId: "t-draft" };
});

it("drafts the opening choice; switching a choice redrafts — even when it opened on a saved draft", () => {
  render(<ReplySheet {...props({ seededDraft: "Saved text" })} />);
  expect(editDraft).toHaveBeenCalledWith("Saved text");
  expect(generate).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId("reply-intent-counter"));
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ intent: "counter", reply_intent: "negotiate" }));
});

it("a counter shows their term → your ask; her fee is the one figure", () => {
  render(<ReplySheet {...props({ initialIntent: "counter" })} />);
  expect(screen.getByTestId("reply-terms")).toBeTruthy();
  expect(screen.getByText("$1,400")).toBeTruthy();
  expect(screen.getByText("Paid usage · 12 months")).toBeTruthy();
  fireEvent.changeText(screen.getByTestId("reply-ask-fee"), "1800");
  fireEvent(screen.getByTestId("reply-ask-fee"), "endEditing", { nativeEvent: { text: "1800" } });
  expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ intent: "counter", figure: 1800 }));
});

it("no team member named → no 'send as my team'; named → the choice appears", () => {
  const { unmount } = render(<ReplySheet {...props()} />);
  expect(screen.queryByTestId("reply-sign-team")).toBeNull();
  unmount();
  prefs = { agent_name: "Alex Chen", agent_role: "Manager" };
  render(<ReplySheet {...props()} />);
  expect(screen.getByText("Alex Chen · Manager")).toBeTruthy();
});

it("Send proposes on the draft's own thread with her intent", async () => {
  propose.mockResolvedValue({ id: "p" });
  const p = props();
  render(<ReplySheet {...p} />);
  await act(async () => { fireEvent.press(screen.getByTestId("reply-send")); });
  expect(propose).toHaveBeenCalledWith({ dealId: "d1", threadId: "t-draft", body: draftState.draft, payload: { reply_intent: "accept_terms" } });
  expect(p.onSent).toHaveBeenCalled();
  expect(p.onClose).toHaveBeenCalled();
});

it("a failed send keeps her text and says why", async () => {
  propose.mockRejectedValue(new Error("500: boom"));
  const p = props();
  render(<ReplySheet {...p} />);
  await act(async () => { fireEvent.press(screen.getByTestId("reply-send")); });
  expect(screen.getByTestId("reply-send-error").props.children).toBe("Not sent. Check your Gmail connection and try again. Your text is still here.");
  expect(screen.getByTestId("reply-draft").props.value).toBe(draftState.draft);
  expect(p.onClose).not.toHaveBeenCalled();
});

it("a yes that marked the deal agreed shows her receipt with Undo", async () => {
  propose.mockResolvedValue({ id: "p", deal_agreed: true });
  render(<ReplySheet {...props()} />);
  await act(async () => { fireEvent.press(screen.getByTestId("reply-send")); });
  expect(screen.getByText("Marked agreed · by you")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("reply-undo-agreed")); });
  expect(screen.getByText("Back to where it was · by you")).toBeTruthy();
});
