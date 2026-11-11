/**
 * spendCron.test.ts — POST /api/internal/agent-spend-cron (agent/spendCron.ts): today's agent_runs spend by provider in
 * dollars, one "over threshold" per provider at or over AGENT_SPEND_ALERT_USD, the cron secret required, a failed read
 * is a 500 with no detail. The spend read is injected (no database, no provider).
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { agentSpendCronRouter, reportSpend, spendAlertUsd, type ProviderSpend } from "./spendCron";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function post(rows: () => Promise<ProviderSpend[]>, secretOk = true) {
  const app = express();
  app.use(agentSpendCronRouter(() => secretOk, rows));
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/internal/agent-spend-cron`, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

describe("agent spend cron", () => {
  it("reports each provider in dollars and flags those at or over the threshold", () => {
    const r = reportSpend([
      { provider: "openai", microUsd: 61_234_567, runs: 40 },
      { provider: "gemini", microUsd: 1_500_000, runs: 3 },
      { provider: "trueforge", microUsd: 50_000_000, runs: 9 },
    ], 50);
    expect(r.providers).toEqual([
      { provider: "openai", usd: 61.23, runs: 40 },
      { provider: "gemini", usd: 1.5, runs: 3 },
      { provider: "trueforge", usd: 50, runs: 9 },
    ]);
    expect(r.over).toEqual(["openai", "trueforge"]);
    expect(r.window).toBe("utc_day");
  });

  it("reads the threshold from AGENT_SPEND_ALERT_USD, 50 when unset or not a positive number", () => {
    expect(spendAlertUsd({})).toBe(50);
    expect(spendAlertUsd({ AGENT_SPEND_ALERT_USD: "20" })).toBe(20);
    for (const v of ["", "0", "-5", "abc"]) expect(spendAlertUsd({ AGENT_SPEND_ALERT_USD: v })).toBe(50);
  });

  it("answers with the report", async () => {
    const r = await post(async () => [{ provider: "openai", microUsd: 2_000_000, runs: 1 }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, window: "utc_day", thresholdUsd: 50, providers: [{ provider: "openai", usd: 2, runs: 1 }], over: [] });
  });

  it("refuses without the cron secret, and never reads", async () => {
    const rows = jest.fn(async () => [] as ProviderSpend[]);
    const r = await post(rows, false);
    expect(r.status).toBe(401);
    expect(rows).not.toHaveBeenCalled();
  });

  it("a failed read is a 500 without detail", async () => {
    const r = await post(async () => { throw new Error("connection refused at 10.0.0.1"); });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal server error" });
  });
});
