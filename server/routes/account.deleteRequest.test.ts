/**
 * account.deleteRequest.test.ts — what DELETE /api/v1/me/account reads from the app (5 Nov 2026), with the deletion
 * service mocked: the optional fresh Sign in with Apple code is passed to phase 1, a malformed one is a 400 and deletes
 * nothing, and the 409 names the deal whose payment is held (the app's "See the payment"). The full two-phase flow on
 * PGlite: account.delete.test.ts and services/privacy/accountDeletionNotify.test.ts.
 */
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/auth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.athleteId = "a-1"; next(); } }));
const requestAccountDeletion = jest.fn();
jest.mock("../services/privacy/deleteAthleteAccount", () => {
  class AccountDeletionBlocked extends Error {
    constructor(public code: string, message: string, public detail: Record<string, unknown> = {}) { super(message); }
  }
  return { AccountDeletionBlocked, requestAccountDeletion: (...a: unknown[]) => requestAccountDeletion(...a) };
});
jest.mock("../services/privacy/exportAthleteData", () => ({ buildAthleteExport: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import accountRouter from "./account";
import { AccountDeletionBlocked } from "../services/privacy/deleteAthleteAccount";

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", accountRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => requestAccountDeletion.mockReset());

const del = (body?: unknown) => fetch(`${base}/account`, {
  method: "DELETE", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});

it("passes the fresh Apple code to phase 1 and answers 202 with the receipt", async () => {
  requestAccountDeletion.mockResolvedValue({ receipt_id: "r-1", status: "deleting", already: false });
  const res = await del({ apple_authorization_code: " c0de " });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, deleting: true, receipt_id: "r-1", status: "deleting" });
  expect(requestAccountDeletion).toHaveBeenCalledWith("a-1", {}, { appleAuthorizationCode: "c0de" });
});

it("without a body there is no Apple code", async () => {
  requestAccountDeletion.mockResolvedValue({ receipt_id: "r-2", status: "deleting", already: false });
  expect((await del()).status).toBe(202);
  expect(requestAccountDeletion).toHaveBeenCalledWith("a-1", {}, { appleAuthorizationCode: null });
});

it("refuses a malformed Apple code with 400 and deletes nothing", async () => {
  expect((await del({ apple_authorization_code: 42 })).status).toBe(400);
  expect((await del({ apple_authorization_code: "x".repeat(5000) })).status).toBe(400);
  expect(requestAccountDeletion).not.toHaveBeenCalled();
});

it("409 while a payment is held names the deal", async () => {
  requestAccountDeletion.mockRejectedValue(new AccountDeletionBlocked("PAYMENTS_IN_FLIGHT", "held", { payment_ids: ["p-1"], deal_ids: ["d-9"] }));
  const res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "held", code: "PAYMENTS_IN_FLIGHT", deal_id: "d-9" });
});
