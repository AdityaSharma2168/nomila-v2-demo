/**
 * devTestEmail.test.ts — the dev-only test-email route: secret first, then dev markers (404 elsewhere), then one
 * address; the fixed subject/body go through sendEmail (mocked — tests never reach a provider). Also pins
 * EMAIL_PROVIDER per environment: "gmail" in dev and prod (prod switched on 24 Oct 2026 for the score-ready email), exactly once each, and no Resend key anywhere.
 */
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true, id: "msg-1" })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { sendEmail } from "../lib/notify";
import { createDevTestEmailRouter, devTestEmailAllowed, TEST_EMAIL_SUBJECT, TEST_EMAIL_TEXT } from "./devTestEmail";

const GCP = join(__dirname, "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

describe("EMAIL_PROVIDER pin", () => {
  it.each([["cloud-run-dev.yaml", "gmail"], ["cloud-run-prod.yaml", "gmail"]])("%s pins it to %s, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "EMAIL_PROVIDER")).toEqual([{ name: "EMAIL_PROVIDER", value }]);
  });
  it.each(["cloud-run-dev.yaml", "cloud-run-prod.yaml"])("%s mounts no Resend key (Gmail is the only provider)", (file) => {
    expect(readFileSync(join(GCP, file), "utf8")).not.toMatch(/RESEND/i);
  });
});

describe("devTestEmailAllowed", () => {
  const dev = { NODE_ENV: "production", K_SERVICE: "nomila-v2", API_BASE_URL: "https://api-dev.nomila.co" };
  it("allows the dev Cloud Run service and a local non-production process", () => {
    expect(devTestEmailAllowed(dev as NodeJS.ProcessEnv)).toBe(true);
    expect(devTestEmailAllowed({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("refuses prod and anything ambiguous", () => {
    for (const env of [
      { NODE_ENV: "production", K_SERVICE: "nomila-v2-prod", API_BASE_URL: "https://api.nomila.co" },
      { ...dev, K_SERVICE: "nomila-v2-prod" },
      { ...dev, API_BASE_URL: "https://api.nomila.co" },
      { ...dev, API_BASE_URL: undefined },
      { NODE_ENV: "production" },
      { NODE_ENV: "development", API_BASE_URL: "https://api.nomila.co" },
    ]) expect(devTestEmailAllowed(env as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("POST /api/internal/dev/test-email", () => {
  let server: Server;
  let base: string;
  const keep = { ...process.env };

  beforeAll(async () => {
    const app = express();
    app.use(createDevTestEmailRouter({ secretValid: (req) => req.headers["x-cron-secret"] === "s3cret" }));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); process.env = keep; });
  beforeEach(() => {
    (sendEmail as jest.Mock).mockClear();
    Object.assign(process.env, { NODE_ENV: "production", K_SERVICE: "nomila-v2", API_BASE_URL: "https://api-dev.nomila.co", EMAIL_PROVIDER: "gmail" });
  });

  const post = (body: unknown, secret?: string) => fetch(`${base}/api/internal/dev/test-email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-cron-secret": secret } : {}) },
    body: JSON.stringify(body),
  });

  it("401 without the secret; nothing sent", async () => {
    expect((await post({ to: "a@example.com" })).status).toBe(401);
    expect((await post({ to: "a@example.com" }, "wrong")).status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("404 on prod even with the secret; nothing sent", async () => {
    process.env.K_SERVICE = "nomila-v2-prod";
    process.env.API_BASE_URL = "https://api.nomila.co";
    expect((await post({ to: "a@example.com" }, "s3cret")).status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("400 unless body.to is one address", async () => {
    for (const to of [undefined, "", "nope", "a@example.com,b@example.com", "a@example.com\nBcc: x@y.z"]) {
      expect((await post({ to }, "s3cret")).status).toBe(400);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends exactly one fixed test email to the address", async () => {
    const res = await post({ to: "a@example.com" }, "s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "gmail", sent: true, id: "msg-1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@example.com", subject: TEST_EMAIL_SUBJECT, text: TEST_EMAIL_TEXT }));
  });

  it("502 with the sender's error when the send fails", async () => {
    (sendEmail as jest.Mock).mockResolvedValueOnce({ sent: false, error: "unauthorized_client" });
    const res = await post({ to: "a@example.com" }, "s3cret");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ provider: "gmail", sent: false, error: "unauthorized_client" });
  });
});
