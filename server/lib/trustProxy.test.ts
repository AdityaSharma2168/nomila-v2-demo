/**
 * trustProxy.test.ts — req.ip behind Cloud Run: the front end appends the address it saw to X-Forwarded-For, and the
 * app trusts exactly that hop, so a client-written X-Forwarded-For can't choose the IP every per-IP limit keys on.
 * Also: a per-IP limiter really limits a client that rotates a spoofed header; TRUST_PROXY_HOPS parsing.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TRUST_PROXY_HOPS, trustProxyHops } from "./trustProxy";

let server: Server; let base = "";
beforeAll(async () => {
  const app = express();
  app.set("trust proxy", trustProxyHops());
  const limiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });
  app.get("/ip", (req, res) => { res.json({ ip: req.ip }); });
  app.get("/limited", limiter, (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { delete process.env.TRUST_PROXY_HOPS; });

/** What Cloud Run's front end forwards: whatever the client sent, then the address it saw. */
const viaCloudRun = (realClient: string, clientWrote?: string) => ({ "x-forwarded-for": clientWrote ? `${clientWrote}, ${realClient}` : realClient });
const ipOf = async (headers: Record<string, string>) => ((await (await fetch(`${base}/ip`, { headers })).json()) as { ip: string }).ip;

it("req.ip is the address the front end saw, whatever the client wrote", async () => {
  expect(await ipOf(viaCloudRun("198.51.100.7"))).toBe("198.51.100.7");
  expect(await ipOf(viaCloudRun("198.51.100.7", "1.2.3.4"))).toBe("198.51.100.7");
  expect(await ipOf(viaCloudRun("198.51.100.7", "1.2.3.4, 5.6.7.8"))).toBe("198.51.100.7");
});

it("a client rotating a spoofed X-Forwarded-For is still one client to a per-IP limiter", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/limited`, { headers: viaCloudRun("203.0.113.9", `10.0.0.${i}`) })).status);
  expect(codes).toEqual([200, 200, 200, 429, 429]);
  expect((await fetch(`${base}/limited`, { headers: viaCloudRun("203.0.113.10") })).status).toBe(200);
});

it("TRUST_PROXY_HOPS: a whole number overrides the default of one hop; anything else is ignored", () => {
  expect(trustProxyHops()).toBe(DEFAULT_TRUST_PROXY_HOPS);
  expect(DEFAULT_TRUST_PROXY_HOPS).toBe(1);
  process.env.TRUST_PROXY_HOPS = "2"; expect(trustProxyHops()).toBe(2);
  process.env.TRUST_PROXY_HOPS = "0"; expect(trustProxyHops()).toBe(0);
  for (const v of ["true", "-1", "1.5", "", "two"]) { process.env.TRUST_PROXY_HOPS = v; expect(trustProxyHops()).toBe(1); }
});

it("the app sets it from trustProxyHops() and no limiter switches the trust-proxy validation off", () => {
  const root = join(__dirname, "..");
  expect(readFileSync(join(root, "index.ts"), "utf8")).toMatch(/app\.set\("trust proxy", trustProxyHops\(\)\)/);
  for (const f of ["lib/rateLimit.ts", "routes/auth.ts", "routes/authEmailCode.ts", "routes/index.ts", "routes/studioSessions.ts", "routes/waitlist.ts"]) {
    expect(readFileSync(join(root, f), "utf8")).not.toMatch(/trustProxy:\s*false/);
  }
});
