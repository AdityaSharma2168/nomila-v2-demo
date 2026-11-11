/**
 * likeEscape.test.ts — user input in a LIKE / ILIKE pattern matches literally (`%`, `_` and `\` escaped).
 *
 *   containsPattern / escapeLike      the helper
 *   GET /search (routes/search.ts)    deals + inbox brands: `%` and `_` alone find nothing; a literal "50%" still finds "50% Off"
 *   GET /media  (routes/media.ts)     the caption / vision search: `%%` finds nothing; a literal "100%" still finds its caption
 *   the source guard                  no ILIKE in server code builds its pattern from raw input (`%${x}%`, '%' + x + '%') —
 *                                     covers server/index.ts /brands/search and routes/dealContracts.ts, which have no
 *                                     mountable router of their own
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/mediaStore", () => ({ ...jest.requireActual("../lib/mediaStore"), signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
jest.mock("../services/mediaEnrichment", () => ({ enrichNextChunk: jest.fn(async () => {}) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { deals, mediaAssets } from "../../shared/schema";
import searchRouter from "./search";
import mediaRouter from "./media";
import { containsPattern, escapeLike } from "../lib/likePattern";

let server: Server; let base: string; let athleteId: string;
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, json: await r.json() as any }; };

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Like Tester"); (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  for (const brand_name of ["50% Off Club", "Nike", "Under_Armour"]) await db.insert(deals).values({ athlete_id: athleteId, brand_name } as any);
  for (const caption of ["giving 100% today", "rest day"]) {
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "upload", origin: "upload", status: "stored", media_type: "IMAGE", content_type: "image/jpeg",
      gcs_path: `athletes/${athleteId}/${Math.random().toString(36).slice(2)}.jpg`, posted_at: new Date("2026-08-01T00:00:00Z"), caption } as any);
  }
  const app = express(); app.use(express.json()); app.use("/", searchRouter); app.use("/", mediaRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

test("containsPattern / escapeLike escape %, _ and the backslash", () => {
  expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  expect(containsPattern("%")).toBe("%\\%%");
});

test("GET /search: `%%` and `__` match nothing; literal `50%` and `r_A` match only their own brand", async () => {
  expect((await get(`/search?q=${encodeURIComponent("%%")}`)).json.deals).toEqual([]);
  expect((await get(`/search?q=${encodeURIComponent("__")}`)).json.deals).toEqual([]);
  expect((await get(`/search?q=${encodeURIComponent("50%")}`)).json.deals.map((d: any) => d.brand_name)).toEqual(["50% Off Club"]);
  expect((await get(`/search?q=${encodeURIComponent("r_A")}`)).json.deals.map((d: any) => d.brand_name)).toEqual(["Under_Armour"]);
  expect((await get(`/search?q=nik`)).json.deals.map((d: any) => d.brand_name)).toEqual(["Nike"]);   // plain substring unchanged
});

test("GET /media?q=: `%%` matches nothing; literal `100%` still finds its caption", async () => {
  const all = await get(`/media`); expect(all.status).toBe(200); expect(all.json.items.length).toBe(2);
  expect((await get(`/media?q=${encodeURIComponent("%%")}`)).json.items).toEqual([]);
  const hit = await get(`/media?q=${encodeURIComponent("100%")}`);
  expect(hit.json.items.map((i: any) => i.caption)).toEqual(["giving 100% today"]);
});

test("source guard: no ILIKE / LIKE in server code builds its pattern from raw input", () => {
  const root = join(__dirname, "..");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "node_modules") walk(p); } else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !p.includes(`${join("server", "scripts")}`)) files.push(p); } };
  walk(root);
  const raw = [
    /i?like\([^)]*`%\$\{/i,                      // ilike(col, `%${x}%`)
    /I?LIKE\s*\$\{\s*['"]%['"]\s*\+/i,          // ILIKE ${'%' + x + '%'}
    // a pattern built in a variable and passed in later: const p = `%${x}%` / '%' + x + '%' (escapeLike / containsPattern are fine)
    /\b(?:const|let|var)\s+\w+\s*=\s*`%\$\{(?!\s*escapeLike\()/,
    /\b(?:const|let|var)\s+\w+\s*=\s*['"]%['"]\s*\+/,
  ];
  /** Not user input, or already escaped inline. Shrink-only. */
  const allowed = [
    /like\(inboxMessages\.body, `%\$\{PDF_MARKER\}%`\)/,                // a code constant
    /ilike\(shopCatalogProducts\.title, `%\$\{term\.replace\(\/\[%_/,   // escaped inline
    /const like = `%\$\{athleteId\}%`;/,                                 // privacy delete: a server-side UUID (no % or _)
  ];
  const offenders = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, n) => ({ f: relative(root, f), n: n + 1, line }))
    .filter(({ line }) => raw.some((re) => re.test(line)) && !allowed.some((re) => re.test(line))));
  expect(offenders).toEqual([]);
});
