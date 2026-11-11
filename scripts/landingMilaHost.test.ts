/**
 * landingMilaHost.test.ts — the landing's Mila-hosted join flow (landing/mila-host.js; MILA_TF_WAITLIST, dev only;
 * docs/design/mila-hosted-waitlist.md). The module is plain browser ESM with no imports; its pure helpers are loaded
 * here as source in a sandbox, and the page is read for its wiring.
 *
 *   M1 moments come only from real progress: handle rows waiting for her answer, the quick score, the full score; each once
 *   M2 resuming picks the moment of where her research really is
 *   M3 the SSE reader: tokens and done across chunk boundaries; comments and junk skipped
 *   M4 fall back unless the turn completed
 *   M5 the page: the host is imported and created from the page's own functions; show() hands the join screens to it;
 *      route() asks it only after the promoted check; the card enum matches the server's; ?api=dev only on localhost
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { WAITLIST_CARDS } from "../shared/agent";

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "landing", "mila-host.js"), "utf8");
const m = vm.runInNewContext(`${src.replace(/^export /gm, "")}\n;({ HOSTED, CARD_SCREEN, momentsFor, resumeMoment, parseSse, shouldFallback, skipKey })`) as any;
const html = fs.readFileSync(path.join(ROOT, "landing", "index.html"), "utf8");

test("M1: moments only from real progress, each once", () => {
  expect(m.momentsFor(null, new Set())).toEqual([]);
  expect(m.momentsFor({ research: { state: "running" } }, new Set())).toEqual([]);
  const asks = { handles: [{ platform: "instagram", handle: "x", status: "suggested" }] };
  expect(m.momentsFor(asks, new Set())).toEqual(["handles_found"]);
  expect(m.momentsFor(asks, new Set(["handles_found"]))).toEqual([]);
  expect(m.momentsFor({ handles: [{ platform: "instagram", handle: "x", status: "confirmed" }] }, new Set())).toEqual([]);
  expect(m.momentsFor({ handles: [{ platform: "tiktok", handle: "x", status: "suggested" }] }, new Set())).toEqual([]);
  expect(m.momentsFor({ quickScore: { value: 500 } }, new Set())).toEqual(["score_quick"]);
  expect(m.momentsFor({ quickScore: { value: 500 }, score: null }, new Set(["score_quick"]))).toEqual([]);
  expect(m.momentsFor({ score: { value: 600 } }, new Set(["score_quick"]))).toEqual(["score_final"]);
  expect(m.momentsFor({ score: { value: 600 } }, new Set(["score_final"]))).toEqual([]);
});

test("M2: resume from where her research really is", () => {
  expect(m.resumeMoment(null)).toBe("research_started");
  expect(m.resumeMoment({ research: { state: "running" } })).toBe("research_started");
  expect(m.resumeMoment({ handles: [{ status: "suggested" }] })).toBe("handles_found");
  expect(m.resumeMoment({ quickScore: {} })).toBe("score_quick");
  expect(m.resumeMoment({ score: {}, quickScore: {} })).toBe("score_final");
});

test("M3: the SSE reader", () => {
  const a = m.parseSse('data: {"token":"Hi "}\n\n: keepalive\n\ndata: {"tok');
  expect(a.events).toEqual([{ token: "Hi " }]);
  const b = m.parseSse(a.rest + 'en":"there"}\n\ndata: not json\n\ndata: {"done":true,"status":"completed","cards":[]}\n\n');
  expect(b.events).toEqual([{ token: "there" }, { done: true, status: "completed", cards: [] }]);
  expect(b.rest).toBe("");
});

test("M4: fall back unless the turn completed", () => {
  expect(m.shouldFallback(null)).toBe(true);
  expect(m.shouldFallback({ done: true, status: "failed", stopReason: "error" })).toBe(true);
  expect(m.shouldFallback({ done: true, status: "stopped", stopReason: "cost_cap_day" })).toBe(true);
  expect(m.shouldFallback({ done: true, status: "completed" })).toBe(false);
  expect(m.skipKey("u1")).toBe("nomila.join.milaSkip.u1");
});

test("M5: the page's wiring", () => {
  expect(html).toMatch(/import \{ createMilaHost \} from '\.\/mila-host\.js';/);
  expect(html).toMatch(/MILA = createMilaHost\(\{/);
  expect(html).toMatch(/function show\(id\) \{\s+if \(MILA && MILA\.present\(id\)\) return;/);
  const route = html.slice(html.indexOf("async function route()"), html.indexOf("// ─── 1 · sign in"));
  expect(route.indexOf("openIn()")).toBeLessThan(route.indexOf("MILA.maybeStart(me)"));
  for (const id of ["j-mila", "j-mila-thread", "j-mila-form", "j-mila-in", "j-mila-skip", "j-mila-st"]) expect(html).toContain(`id="${id}"`);
  for (const id of m.HOSTED) expect(html).toContain(`id="${id}"`);
  expect(Object.keys(m.CARD_SCREEN).sort()).toEqual([...WAITLIST_CARDS].sort());
  expect(html).toMatch(/const API_URL = isLocal \? \(new URLSearchParams\(location\.search\)\.get\('api'\) === 'dev' \? 'https:\/\/api-dev\.nomila\.co' : 'http:\/\/localhost:8080'\)/);
});
