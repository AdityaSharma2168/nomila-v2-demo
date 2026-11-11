/**
 * publicPage.engine.test.ts — the engine hook on /p/:handle (NOMI_ENGINE_V1, front door v2.1 simplified): an engine
 * page is served under the same strict CSP; null or a throw falls back to the classic page; the stylesheet is a file.
 * No DB, no providers: the view loader is the fixtures and the engine is a stub.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicPageRouter } from "./publicPage";
import { PUBLIC_CARD_FIXTURES } from "../services/publicCard/fixtures";

let server: Server;
let base: string;
const ENV = { ...process.env };
let mode: "html" | "null" | "throw" = "html";
const seen: string[] = [];
const sheetsSeen: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(createPublicPageRouter({
    loadView: async (h) => PUBLIC_CARD_FIXTURES[h] ?? null,
    renderEngine: async (view, paths) => {
      seen.push(`${paths.base}|${paths.css}|${paths.like}`);
      sheetsSeen.push(paths.sheets ?? "");
      if (mode === "throw") throw new Error("boom");
      return mode === "html" ? `<!doctype html><title>engine ${view.handle}</title>` : null;
    },
    engineCss: () => ".fd-door{color:red}",
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = ENV;
});
beforeEach(() => {
  process.env.PUBLIC_CARD = "true";
  process.env.NODE_ENV = "test";
  mode = "html";
});

const handle = Object.keys(PUBLIC_CARD_FIXTURES)[0];
const get = async (p: string) => {
  const res = await fetch(base + p);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

describe("/p/:handle engine hook", () => {
  it("serves the engine page under the strict public CSP, never cached", async () => {
    const r = await get(`/p/${handle}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`engine ${handle}`);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(seen.at(-1)).toBe(`/p/${handle}|/p/_a/nomi.css|/p/${handle}/like`);
  });
  it.each(["null", "throw"] as const)("engine %s → the classic page", async (m) => {
    mode = m;
    const r = await get(`/p/${handle}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("engine ");
    expect(r.text).toContain("pc-track");
  });
  it("the stylesheet is a file", async () => {
    const r = await get("/p/_a/nomi.css");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    expect(r.text).toContain(".fd-door");
  });
  it("door pages are untouched (the doors keep their existing flows)", async () => {
    const r = await get(`/p/${handle}/partner`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("engine ");
  });
  it("the engine page gets sheets.js, served from 'self' under the same CSP (no inline script)", async () => {
    await get(`/p/${handle}`);
    expect(sheetsSeen.at(-1)).toMatch(/^\/p\/_a\/sheets\.js\?v=/);
    const r = await get("/p/_a/sheets.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.text).toContain("fd-sheet");
  });
  it("a door page is plain HTML the sheet can load (main.pc-door), so no-script visitors get the same content", async () => {
    for (const door of ["partner", "book", "shop"]) {
      const r = await get(`/p/${handle}/${door}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.text).toContain('class="pc-door"');
    }
  });
});
