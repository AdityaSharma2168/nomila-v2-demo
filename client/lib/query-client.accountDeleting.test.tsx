/**
 * query-client.accountDeleting.test — the shared request paths (apiRequest and the default queryFn) report the server's
 * 410 account_deleting app-wide (lib/account-deleting), still throwing as before; other errors are not reported.
 */
jest.mock("./firebase-client", () => ({ getFirebaseIdToken: async () => "tok" }));
jest.mock("./athlete-selection", () => ({ athleteHeader: () => ({}) }));
jest.mock("./logger", () => ({ logger: { log: () => {}, error: () => {}, warn: () => {} } }));

import { apiRequest, getQueryFn } from "./query-client";
import { onAccountDeleting } from "./account-deleting";

const answer = (status: number, body: unknown) => {
  (global as any).fetch = jest.fn(async () => ({ ok: status < 400, status, statusText: "x", text: async () => JSON.stringify(body), json: async () => body }));
};

beforeAll(() => { process.env.EXPO_PUBLIC_API_URL = "https://api.test"; });

it("apiRequest: a 410 account_deleting is reported and still throws", async () => {
  const heard = jest.fn(); const off = onAccountDeleting(heard);
  answer(410, { error: "account_deleting" });
  await expect(apiRequest("GET", "/api/v1/me/anything")).rejects.toThrow("410");
  expect(heard).toHaveBeenCalledTimes(1);
  off();
});

it("the default queryFn reports it too; a 500 is not reported", async () => {
  const heard = jest.fn(); const off = onAccountDeleting(heard);
  const qf = getQueryFn<unknown>({ on401: "throw" });
  answer(410, { error: "account_deleting" });
  await expect(qf({ queryKey: ["/api/v1/me/deals"] } as any)).rejects.toThrow();
  answer(500, { error: "boom" });
  await expect(apiRequest("GET", "/api/v1/me/x")).rejects.toThrow("500");
  expect(heard).toHaveBeenCalledTimes(1);
  off();
});
