/**
 * ExportDataSheet.test — Download your data (mockup 2a–2d): the intro says what is and isn't in the file; Download
 * shows the preparing state, then closes the sheet and hands the file over; a failure shows the plain error with Try
 * again; Cancel goes back. The server call is mocked; the "Your account is being deleted" screen has its own test here.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../lib/logger", () => ({ logger: { error: () => {}, warn: () => {}, log: () => {} } }));
const prepareExport = jest.fn();
jest.mock("../../lib/account-api", () => ({ prepareExport: (...a: unknown[]) => prepareExport(...a), deliverExport: jest.fn() }));

import { EXPORT_COPY, ExportDataSheet } from "./ExportDataSheet";
import { ACCOUNT_DELETING_COPY, AccountDeletingScreen } from "../../screens/AccountDeletingScreen";

beforeEach(() => prepareExport.mockReset());

it("says what is in the file and what isn't", () => {
  render(<ExportDataSheet onClose={() => {}} />);
  expect(screen.getByText(EXPORT_COPY.title)).toBeTruthy();
  expect(screen.getByText(EXPORT_COPY.intro)).toBeTruthy();
  expect(screen.getByText(EXPORT_COPY.notIn[0][0])).toBeTruthy();
  expect(screen.getByText(EXPORT_COPY.fileNote)).toBeTruthy();
});

it("Download: preparing, then the sheet closes and the file is handed over", async () => {
  let resolve!: (f: unknown) => void;
  prepareExport.mockReturnValue(new Promise((r) => { resolve = r; }));
  const onClose = jest.fn(); const deliver = jest.fn();
  render(<ExportDataSheet onClose={onClose} testDeliver={deliver} />);
  fireEvent.press(screen.getByTestId("export-download"));
  expect(screen.getByTestId("export-preparing")).toBeTruthy();
  expect(screen.getByText(EXPORT_COPY.preparing)).toBeTruthy();
  const file = { name: "nomila-data-2026-11-05.json", uri: "file:///cache/nomila-data-2026-11-05.json" };
  await act(async () => { resolve(file); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(file);
});

it("a failure shows the plain error, and Try again asks again", async () => {
  prepareExport.mockRejectedValueOnce(new Error("export 500")).mockReturnValue(new Promise(() => {}));
  render(<ExportDataSheet onClose={() => {}} testDeliver={() => {}} />);
  fireEvent.press(screen.getByTestId("export-download"));
  await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());
  expect(screen.getByText(EXPORT_COPY.error)).toBeTruthy();
  fireEvent.press(screen.getByTestId("export-retry"));
  expect(prepareExport).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("export-preparing")).toBeTruthy();
});

it("Cancel aborts the request and goes back to the intro", async () => {
  prepareExport.mockReturnValue(new Promise(() => {}));
  const onClose = jest.fn();
  render(<ExportDataSheet onClose={onClose} testDeliver={() => {}} />);
  fireEvent.press(screen.getByTestId("export-download"));
  const signal = prepareExport.mock.calls[0][0] as AbortSignal;
  fireEvent.press(screen.getByTestId("export-cancel"));
  expect(signal.aborted).toBe(true);
  expect(screen.getByTestId("export-intro")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

it("AccountDeletingScreen: says the account is being deleted, and OK hands off to sign-out", () => {
  const onOk = jest.fn();
  render(<AccountDeletingScreen onOk={onOk} />);
  expect(screen.getByText(ACCOUNT_DELETING_COPY.title)).toBeTruthy();
  expect(screen.getByText(ACCOUNT_DELETING_COPY.line)).toBeTruthy();
  fireEvent.press(screen.getByTestId("account-deleting-action"));
  expect(onOk).toHaveBeenCalledTimes(1);
});
