/**
 * shareLinkLimiter.test.ts — /c/:shareId behind nomila.co (Firebase Hosting → Cloud Run adds a hop). Headers are set
 * the way the real chain forwards them:
 *   via Hosting   "<whatever the visitor wrote>, <visitor>, <Hosting edge>"   (the app trusts one hop ⇒ req.ip = edge)
 *   direct        "<whatever the caller wrote>, <caller>"
 * The visitor is the second-from-right entry, so two visitors behind one edge are counted apart; a direct caller
 * rotating a fake header is still capped by the per-peer limit on its real address. Every other route stays at one hop.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trustProxyHops } from "./trustProxy";
import { SHARE_LINK_PEER_LIMIT, publicCardLimiter, shareLinkLimiters, viaHostingClientIp } from "./rateLimit";

let server: Server; let base = "";
beforeAll(async () => {
  const app = express();
  app.set("trust proxy", trustProxyHops());
  app.get("/c/:id", ...shareLinkLimiters, (req, res) => { res.json({ visitor: viaHostingClientIp(req), peer: req.ip }); });
  app.get("/card/:id", publicCardLimiter, (req, res) => { res.json({ ip: req.ip }); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const viaHosting = (visitor: string, edge: string, wrote?: string) => ({ "x-forwarded-for": [wrote, visitor, edge].filter(Boolean).join(", ") });
const direct = (caller: string, wrote: string) => ({ "x-forwarded-for": `${wrote}, ${caller}` });
const get = async (path: string, headers: Record<string, string>) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

it("via Hosting the visitor is the second-from-right entry, whatever the visitor wrote; the peer is the edge", async () => {
  expect((await get("/c/x", viaHosting("198.51.100.1", "203.0.113.200"))).json).toEqual({ visitor: "198.51.100.1", peer: "203.0.113.200" });
  expect((await get("/c/x", viaHosting("198.51.100.1", "203.0.113.200", "1.2.3.4"))).json).toEqual({ visitor: "198.51.100.1", peer: "203.0.113.200" });
});

it("two visitors behind one Hosting edge are counted apart (120 / min each)", async () => {
  const edge = "203.0.113.201";
  for (let i = 0; i < 120; i++) expect((await get("/c/a", viaHosting("198.51.100.10", edge))).status).toBe(200);
  expect((await get("/c/a", viaHosting("198.51.100.10", edge))).status).toBe(429);
  expect((await get("/c/a", viaHosting("198.51.100.11", edge))).status).toBe(200);
});

it("a direct caller rotating a fake header is capped per peer on its real address", async () => {
  const caller = "192.0.2.77";
  let last = 200;
  for (let i = 0; i <= SHARE_LINK_PEER_LIMIT; i++) last = (await get("/c/b", direct(caller, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`))).status;
  expect(last).toBe(429);
}, 120_000);

it("a missing or malformed second entry falls back to req.ip", async () => {
  expect((await get("/c/x", { "x-forwarded-for": "192.0.2.5" })).json.visitor).toBe("192.0.2.5");
  expect((await get("/c/x", { "x-forwarded-for": "not-an-ip, 192.0.2.6" })).json.visitor).toBe("192.0.2.6");
});

it("every other route keeps the one trusted hop (/card/:athleteId reads req.ip)", async () => {
  expect((await get("/card/x", viaHosting("198.51.100.1", "203.0.113.202"))).json.ip).toBe("203.0.113.202");
});

it("card.ts mounts shareLinkLimiters on /c/:shareId only", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "card.ts"), "utf8");
  expect(src).toMatch(/router\.get\("\/c\/:shareId", \.\.\.shareLinkLimiters,/);
  expect(src).toMatch(/router\.get\("\/card\/:athleteId", publicCardLimiter,/);
});
