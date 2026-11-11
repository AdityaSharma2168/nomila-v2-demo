/**
 * routes.test.ts — POST /api/internal/playbook-refresh-cron: the secret, the flag, a failure. Same shape as
 * agent/moments/moments.db.test.ts's D5 (momentsCronRouter) — the sweep itself is faked, so no real database or
 * provider is reached.
 */
jest.mock("../../db", () => ({ db: {} }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { playbookCronRouter } from "./routes";

const saved = process.env.AGENT_PLAYBOOK;
afterEach(() => { if (saved === undefined) delete process.env.AGENT_PLAYBOOK; else process.env.AGENT_PLAYBOOK = saved; });

test("the cron route — the secret, the flag, a failure", async () => {
  const app = express();
  app.use(express.json());
  const calls: number[] = [];
  app.use(playbookCronRouter((req) => req.headers["x-cron-secret"] === "s3cret", async () => { calls.push(1); return { checked: 2, refreshed: 1, failed: 0, skipped: { recent: 1 }, outcomes: [] }; }));
  const broken = express();
  broken.use(playbookCronRouter(() => true, async () => { throw new Error("db down"); }));
  const servers: Server[] = [app.listen(0), broken.listen(0)];
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/internal/playbook-refresh-cron`;
  try {
    // No secret, and the wrong secret, are both a 401; the sweep is never called.
    expect((await fetch(url(servers[0]), { method: "POST" })).status).toBe(401);
    expect((await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "wrong" } })).status).toBe(401);
    expect(calls).toEqual([]);

    process.env.AGENT_PLAYBOOK = "true";
    const on = await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "s3cret" } });
    // The route reports enabled from the live flag, and the sweep's own counts — never the per-key outcomes (which
    // may carry a model's raw JSON) in the HTTP response.
    expect(await on.json()).toEqual({ ok: true, enabled: true, checked: 2, refreshed: 1, failed: 0, skipped: { recent: 1 } });
    expect(calls).toEqual([1]);

    const failed = await fetch(url(servers[1]), { method: "POST" });
    expect([failed.status, await failed.json()]).toEqual([500, { error: "Internal server error" }]);

    // Off: the real sweep answers enabled:false and does nothing (no listKeys/refresh call at all — triggers.test.ts
    // pins that directly; here the wiring just needs to report it honestly).
    process.env.AGENT_PLAYBOOK = "false";
    const real = express();
    real.use(playbookCronRouter(() => true));
    servers.push(real.listen(0));
    expect(await (await fetch(url(servers[2]), { method: "POST" })).json()).toEqual({ ok: true, enabled: false, checked: 0, refreshed: 0, failed: 0, skipped: {} });
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
});
