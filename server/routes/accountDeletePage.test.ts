/**
 * accountDeletePage.test.ts — the public /account/delete page (Google Play's web deletion link). It is a request form
 * and never a delete: nothing here can close or erase an account without sign-in. The sender is mocked (no email is
 * ever sent from a test) and the deletion service is mocked only to prove it is never called.
 */
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const sendEmail = jest.fn();
jest.mock("../lib/notify", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
const requestAccountDeletion = jest.fn();
jest.mock("../services/privacy/deleteAthleteAccount", () => ({ requestAccountDeletion: (...a: unknown[]) => requestAccountDeletion(...a) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import accountDeletePageRouter, { DELETION_REQUESTS_TO } from "./accountDeletePage";

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/account", express.urlencoded({ extended: false, limit: "4kb" }), accountDeletePageRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { sendEmail.mockReset(); requestAccountDeletion.mockReset(); });

// One client address for the whole file (the limiter allows 5 per 15 min): the suite's posts are counted in order.
const post = (form: Record<string, string>) => fetch(`${base}/account/delete`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
});

it("serves the page with no script, the in-app path, what is erased and kept, and a form posting back to itself", async () => {
  const res = await fetch(`${base}/account/delete`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const html = await res.text();
  expect(html).not.toMatch(/<script/i);
  expect(html).toContain("Settings › Account › Delete account");
  expect(html).toContain("What we keep");
  expect(html).toContain('action="/account/delete"');
  expect(html).toContain("This form doesn't delete anything by itself");
});

it("passes a request to hello@nomila.co with Reply-To the requester, confirms, and never deletes", async () => {
  sendEmail.mockResolvedValue({ sent: true });
  const res = await post({ email: "someone@example.com" });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("We got your request");
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: DELETION_REQUESTS_TO, replyTo: "someone@example.com" });
  expect(requestAccountDeletion).not.toHaveBeenCalled();
});

it("refuses a bad email (400), escapes what was typed, and sends nothing", async () => {
  const res = await post({ email: "<b>not-an-email" });
  expect(res.status).toBe(400);
  const html = await res.text();
  expect(html).toContain("&lt;b&gt;not-an-email");
  expect(html).not.toContain("<b>not-an-email");
  expect(sendEmail).not.toHaveBeenCalled();
});

it("answers a filled honeypot like a success and sends nothing", async () => {
  const res = await post({ email: "bot@example.com", website: "http://spam" });
  expect(res.status).toBe(200);
  expect(sendEmail).not.toHaveBeenCalled();
});

it("says plainly when the request could not be sent (email off or down) instead of claiming it was received", async () => {
  sendEmail.mockResolvedValue({ sent: false, skipped: true });
  const res = await post({ email: "someone@example.com" });
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("We couldn&#39;t send your request just now");
});

it("has no route that deletes: DELETE and other methods are not served", async () => {
  expect((await fetch(`${base}/account/delete`, { method: "DELETE" })).status).toBe(404);
  expect((await fetch(`${base}/account`, { method: "DELETE" })).status).toBe(404);
  expect(requestAccountDeletion).not.toHaveBeenCalled();
});

it("rate-limits the form per address (4 posts above, so the 5th passes and the 6th is refused)", async () => {
  sendEmail.mockResolvedValue({ sent: true });
  expect((await post({ email: "r@example.com" })).status).toBe(200);
  const refused = await post({ email: "r@example.com" });
  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("Too many requests");
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
