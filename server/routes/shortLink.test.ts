/**
 * shortLink.test.ts — {host}/{handle} → /p/{handle}: only on SHORT_LINK_HOSTS, only for a published, non-reserved
 * handle; everything else falls through to the next route. No DB: the published check is a stub.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createShortLinkRouter } from "./shortLink";

let server: Server;
let base: string;
let hosts = new Set<string>(["127.0.0.1"]);
const published = new Set(["miabhuta", "alex-demo"]);

beforeAll(async () => {
  const app = express();
  app.get("/health", (_req, res) => { res.send("ok"); });
  app.use(createShortLinkRouter({ hosts: () => hosts, isPublished: async (h) => published.has(h) }));
  app.use((_req, res) => { res.status(404).send("not found"); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { hosts = new Set(["127.0.0.1"]); });

const get = (p: string) => fetch(base + p, { redirect: "manual" });

describe("short link", () => {
  it("a published handle on an allowed host → 302 to its public page", async () => {
    const r = await get("/miabhuta");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/p/miabhuta");
  });
  it("handles are matched case-insensitively", async () => {
    const r = await get("/MiaBhuta");
    expect(r.headers.get("location")).toBe("/p/miabhuta");
  });
  it("an unknown handle falls through (404 from the app, not a redirect)", async () => {
    expect((await get("/nobody-here")).status).toBe(404);
  });
  it("never shadows an existing route", async () => {
    const r = await get("/health");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });
  it("a reserved word is never a handle", async () => {
    published.add("admin");
    expect((await get("/admin")).status).toBe(404);
  });
  it("off on any host not listed (prod until the hosting change)", async () => {
    hosts = new Set();
    expect((await get("/miabhuta")).status).toBe(404);
    hosts = new Set(["api-dev.nomila.co"]);
    expect((await get("/miabhuta")).status).toBe(404);
  });
});
