/**
 * publicCard.boundary.test.ts — the public read path never touches private tables (design-public-card-v3 §11).
 *
 *   B1 statically: publicCardReader.ts and every local module it pulls in import, from shared/schema, only the three
 *      public-card tables (and, besides, only the pure contact-detail patterns in lib/contactDetails); no raw SQL
 *   B2 by capture: every SQL statement the reader runs (ok, redirect, miss) names only those three tables, and never
 *      selects the draft, the sources manifest, her switches or show_mia — with a fully seeded athlete (deals, media,
 *      her words) sitting in the same database
 *   B3 every public surface (a file that imports publicCardReader, or a server/routes/public* file) imports no schema
 *      and no db: it gets data only through the reader
 *   B4 snapshots are immutable: no code anywhere updates public_card_snapshots (inserts and deletes only)
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { athleteAsserted, deals, mediaAssets, publicCards } from "../../../shared/schema";
import { client, closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { setHandle } from "./handles";
import { ensureCard, publishSnapshot } from "./publish";
import { mediaObject, read } from "./publicCardReader";
import { ALL_SWITCHES_ON, fixtureCard } from "../../testUtils/publicCardFixtures";

const ROOT = join(__dirname, "..", "..", "..");
const PUBLIC_TABLES = ["public_cards", "public_card_snapshots", "public_card_handle_redirects"];
const PUBLIC_SCHEMA_SYMBOLS = new Set(["publicCards", "publicCardSnapshots", "publicCardHandleRedirects"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

/** import specifiers and the named symbols taken from each (type-only imports included: they are harmless but listed). */
function imports(src: string): Array<{ from: string; names: string[] }> {
  const out: Array<{ from: string; names: string[] }> = [];
  for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const names = (m[1].match(/\{([\s\S]*?)\}/)?.[1] ?? "").split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
    out.push({ from: m[2], names: m[1].includes("*") ? ["*"] : names });
  }
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) out.push({ from: m[1], names: ["*"] });
  return out;
}

/** The reader and every LOCAL module it imports, transitively, within server/services/publicCard. */
function readerClosure(): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const i of imports(readFileSync(file, "utf8"))) {
      if (!i.from.startsWith("./")) continue;
      visit(resolve(dirname(file), `${i.from}.ts`));
    }
  };
  visit(join(__dirname, "publicCardReader.ts"));
  return [...seen];
}

describe("B1 the reader's imports", () => {
  it("only the three public-card tables, the db handle, drizzle operators, the shared contract and its own small modules", () => {
    const files = readerClosure();
    expect(files.map(rel).sort()).toEqual([
      "server/services/publicCard/config.ts",
      "server/services/publicCard/contactFilter.ts",
      "server/services/publicCard/flag.ts",
      "server/services/publicCard/handles.ts",
      "server/services/publicCard/publicCardReader.ts",
      "server/services/publicCard/tiles.ts",
      "server/services/publicCard/types.ts",
      "server/services/publicCard/view.ts",
    ]);
    for (const f of files) {
      for (const i of imports(readFileSync(f, "utf8"))) {
        if (i.from.startsWith("./") || i.from === "drizzle-orm" || i.from === "../../db" || i.from === "../../../shared/publicCard") continue;
        // The contact-detail patterns: pure, no imports, no I/O (asserted below).
        if (i.from === "../../lib/contactDetails") continue;
        expect(i.from).toBe("../../../shared/schema");
        expect(i.names.filter((n) => !PUBLIC_SCHEMA_SYMBOLS.has(n))).toEqual([]);
      }
    }
  });

  it("the contact-detail patterns the reader filters with import nothing", () => {
    expect(imports(readFileSync(join(ROOT, "server", "lib", "contactDetails.ts"), "utf8"))).toEqual([]);
  });

  it("the reader has no raw SQL", () => {
    expect(readFileSync(join(__dirname, "publicCardReader.ts"), "utf8")).not.toMatch(/\bsql`|\.execute\(|\.query\(/);
  });
});

// ─── B2 SQL capture ──────────────────────────────────────────────────────────────────────────────────────────

async function captureSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const seen: string[] = [];
  const orig = client.query.bind(client);
  const spy = jest.spyOn(client, "query").mockImplementation(((q: any, ...rest: any[]) => {
    seen.push(String(q));
    return (orig as any)(q, ...rest);
  }) as any);
  try { return { result: await fn(), sql: seen }; } finally { spy.mockRestore(); }
}

const tablesIn = (statement: string): string[] =>
  [...statement.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1].toLowerCase());

describe("B2 what the reader actually runs", () => {
  let athleteId: string;
  beforeAll(async () => {
    await initTestDb();
    athleteId = await seedAthlete("Boundary Sprinter");
    // Private data in the same database: a deal, a media item, her words.
    await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Private Brand Co" } as any);
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "upload", media_type: "IMAGE", status: "stored" } as any);
    await db.insert(athleteAsserted).values({ athlete_id: athleteId, field: "note", value: "private note", source: "settings" } as any);
    await ensureCard(athleteId);
    await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, athleteId));
    await db.transaction((tx) => setHandle(tx as any, athleteId, "boundary-sprinter"));
    await publishSnapshot(athleteId, fixtureCard("Boundary", "Sprinter"));
    // a second handle so the redirect path runs too
    await db.update(publicCards).set({ handle_changed_at: null }).where(eq(publicCards.athlete_id, athleteId));
    await db.transaction((tx) => setHandle(tx as any, athleteId, "boundary-s", new Date(Date.now() - 1000)));
  });
  afterAll(async () => { await closeTestDb(); });

  it.each([["ok", "boundary-s"], ["redirect", "boundary-sprinter"], ["miss", "no-such-card"]])("%s: only the three tables, never draft / sources / switches", async (_label, handle) => {
    const { result, sql } = await captureSql(() => read(handle));
    expect(result.status).toBe(_label === "miss" ? "not_found" : _label);
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      expect(/^\s*select\b/i.test(s)).toBe(true);
      for (const t of tablesIn(s)) expect(PUBLIC_TABLES).toContain(t);
      expect(s).not.toMatch(/"draft"|"sources"|"media"|"door_|"show_mia"|"handle_changed_at"|"approved_by_user_id"|"note"/);
    }
  });

  it("the media read: only the three tables, only the media map, never content, draft or sources", async () => {
    const f = fixtureCard("Boundary", "Sprinter");
    const key = Object.keys(f.media)[0];
    const { result, sql } = await captureSql(() => mediaObject("boundary-s", key));
    expect(result).toEqual(f.media[key]);
    for (const s of sql) {
      expect(/^\s*select\b/i.test(s)).toBe(true);
      for (const t of tablesIn(s)) expect(PUBLIC_TABLES).toContain(t);
      expect(s).not.toMatch(/"draft"|"sources"|"content"|"door_|"show_mia"|"note"/);
    }
  });
});

// ─── B3 / B4 static, whole repo ───────────────────────────────────────────────────────────────────────────────

const serverFiles = [...walk(join(ROOT, "server")), ...walk(join(ROOT, "shared"))].map((p) => ({ rel: rel(p), src: readFileSync(p, "utf8") }));

describe("B3 public surfaces read only through the reader", () => {
  it("no file that imports publicCardReader, and no server/routes/public* file, imports the schema or the db", () => {
    const surfaces = serverFiles.filter((f) =>
      f.rel !== "server/services/publicCard/publicCardReader.ts" &&
      (/from\s+["'][^"']*publicCardReader["']/.test(f.src) || /^server\/routes\/public[^/]*\.ts$/.test(f.rel)));
    const offenders = surfaces.filter((f) => /from\s+["'][^"']*shared\/schema["']|from\s+["'][^"']*\/db["']/.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe("B4 snapshots are immutable", () => {
  it("nothing updates public_card_snapshots", () => {
    const offenders = serverFiles.filter((f) => /\.update\(\s*publicCardSnapshots\b/.test(f.src) || /\bUPDATE\s+"?public_card_snapshots\b/i.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
