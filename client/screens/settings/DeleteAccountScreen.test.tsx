/**
 * DeleteAccountScreen.test — the in-app delete (mockup 3a–3f): Continue opens the confirm sheet; the red button stays
 * off until DELETE is typed (any case); 202 shows "Your account is closed" with the short reference and Done signs out;
 * 409 says a payment is held and "See the payment" opens the deal; a failure says nothing was deleted and Try again
 * goes back to the confirm; Apple users confirm with Apple first and the code goes with the request, and cancelling
 * Apple deletes nothing. The server and Apple are mocked.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const leaveDeletedAccount = jest.fn(async () => {});
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ leaveDeletedAccount }) }));
const deleteMyAccount = jest.fn();
const confirmWithApple = jest.fn();
let apple = false;
jest.mock("../../lib/account-api", () => ({
  deleteMyAccount: (...a: unknown[]) => deleteMyAccount(...a),
  confirmWithApple: () => confirmWithApple(),
  needsAppleConfirm: async () => apple,
  shortReference: (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`,
  prepareExport: jest.fn(), deliverExport: jest.fn(),
}));

import { DELETE_COPY, DeleteAccountScreen, isConfirmWord } from "./DeleteAccountScreen";

beforeEach(() => { deleteMyAccount.mockReset(); confirmWithApple.mockReset(); navigate.mockReset(); leaveDeletedAccount.mockClear(); apple = false; });

const openConfirm = () => { fireEvent.press(screen.getByTestId("delete-continue")); };
const confirmDisabled = () => screen.getByTestId("delete-confirm").props.accessibilityState?.disabled;

it("accepts DELETE in any case, nothing else", () => {
  expect(isConfirmWord("DELETE")).toBe(true);
  expect(isConfirmWord(" delete ")).toBe(true);
  expect(isConfirmWord("Delete")).toBe(true);
  expect(isConfirmWord("delet")).toBe(false);
  expect(isConfirmWord("")).toBe(false);
});

it("says plainly what is erased, kept and that it can't be undone, and offers a download first", () => {
  render(<DeleteAccountScreen />);
  expect(screen.getByText(DELETE_COPY.title)).toBeTruthy();
  expect(screen.getByText(DELETE_COPY.ledeStrong)).toBeTruthy();
  expect(screen.getByText(DELETE_COPY.erased[2])).toBeTruthy();
  expect(screen.getByText(DELETE_COPY.keptLabel)).toBeTruthy();
  fireEvent.press(screen.getByTestId("delete-download-first"));
  expect(screen.getByTestId("export-intro")).toBeTruthy();
});

it("keeps the red button off until DELETE is typed, then closes the account and shows the reference; Done signs out", async () => {
  deleteMyAccount.mockResolvedValue({ kind: "closed", receiptId: "7f3c0000-0000-0000-0000-00000000e21a" });
  render(<DeleteAccountScreen />);
  openConfirm();
  expect(screen.getByText(DELETE_COPY.confirmValue)).toBeTruthy();
  expect(confirmDisabled()).toBe(true);
  fireEvent.press(screen.getByTestId("delete-confirm"));
  expect(deleteMyAccount).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByTestId("delete-input"), "delete");
  expect(confirmDisabled()).toBe(false);
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.getByTestId("delete-closed")).toBeTruthy());
  expect(deleteMyAccount).toHaveBeenCalledWith(null);
  expect(screen.getByText(DELETE_COPY.doneTitle)).toBeTruthy();
  expect(screen.getByText(DELETE_COPY.doneRef("7f3c…e21a"))).toBeTruthy();
  fireEvent.press(screen.getByTestId("delete-closed-action"));
  expect(leaveDeletedAccount).toHaveBeenCalledTimes(1);
});

it("409: a payment is held; See the payment opens the deal", async () => {
  deleteMyAccount.mockResolvedValue({ kind: "blocked", dealId: "deal-9" });
  render(<DeleteAccountScreen />);
  openConfirm();
  fireEvent.changeText(screen.getByTestId("delete-input"), "DELETE");
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.getByTestId("delete-blocked")).toBeTruthy());
  expect(screen.getByText(DELETE_COPY.blockedTitle)).toBeTruthy();
  fireEvent.press(screen.getByTestId("delete-see-payment"));
  expect(navigate).toHaveBeenCalledWith("Opportunities", { screen: "DealDetail", params: { dealId: "deal-9" } });
});

it("a failure says nothing was deleted; Try again goes back to the confirm", async () => {
  deleteMyAccount.mockResolvedValue({ kind: "error" });
  render(<DeleteAccountScreen />);
  openConfirm();
  fireEvent.changeText(screen.getByTestId("delete-input"), "delete");
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.getByTestId("delete-error")).toBeTruthy());
  expect(screen.getByText(DELETE_COPY.errorLine)).toBeTruthy();
  fireEvent.press(screen.getByTestId("delete-retry"));
  expect(screen.getByTestId("delete-input")).toBeTruthy();
});

it("Apple users confirm with Apple, and the fresh code goes with the request", async () => {
  apple = true;
  confirmWithApple.mockResolvedValue({ code: "apple-code-1" });
  deleteMyAccount.mockResolvedValue({ kind: "closed", receiptId: "r-0123456789" });
  render(<DeleteAccountScreen />);
  openConfirm();
  await waitFor(() => expect(screen.getByText(`${DELETE_COPY.confirmLine} ${DELETE_COPY.confirmApple}`)).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("delete-input"), "delete");
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(deleteMyAccount).toHaveBeenCalledWith("apple-code-1"));
});

it("cancelling Apple deletes nothing and says so", async () => {
  apple = true;
  confirmWithApple.mockResolvedValue({ cancelled: true });
  render(<DeleteAccountScreen />);
  openConfirm();
  await waitFor(() => expect(screen.getByText(`${DELETE_COPY.confirmLine} ${DELETE_COPY.confirmApple}`)).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("delete-input"), "delete");
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.getByText(DELETE_COPY.appleCancelled)).toBeTruthy());
  expect(deleteMyAccount).not.toHaveBeenCalled();
});

it("Apple failing (not cancelled) never blocks the delete: it goes ahead without a code", async () => {
  apple = true;
  confirmWithApple.mockResolvedValue({ failed: true });
  deleteMyAccount.mockResolvedValue({ kind: "closed", receiptId: "r-0123456789" });
  render(<DeleteAccountScreen />);
  openConfirm();
  await waitFor(() => expect(screen.getByText(`${DELETE_COPY.confirmLine} ${DELETE_COPY.confirmApple}`)).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("delete-input"), "delete");
  fireEvent.press(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(deleteMyAccount).toHaveBeenCalledWith(null));
  expect(confirmWithApple).toHaveBeenCalledTimes(1);
});
