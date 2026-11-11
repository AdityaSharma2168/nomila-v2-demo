/**
 * documents/dbSource.test.ts — Mila's documents source on the app's real services and the real workflow runner, on
 * PGlite. No engine build runs (the runner is never ticked; the kit cache is read, never built), no image is signed
 * (GCS mocked), no model is reached. Made-up brands.
 *
 *   S1  her brands only: a brand of another athlete's thread is never found; an exact name beats a partial one; confirmed
 *       and researched come from the brand's own research
 *   S2  the brand book: its pages and lines; pick_line and write_line store her override (write keeps the options), never the engine's book
 *   S3  builds: documents_make's start is ONE document_build run per document (a second ask joins it), scoped to her;
 *       the day's limit stops a seventh different build; the overview shows the running one as building
 *   S4  the tell side: the asking chat is found by its progress card, the line goes under it once, the card flips
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: async (p: string) => `https://signed.example/${p}` }));
// The runner is real, but never kicked here, and the engine's build is a stub: no build, provider or GCS is reached.
jest.mock("../../workflow/runner", () => ({ ...jest.requireActual("../../workflow/runner"), kick: jest.fn(async () => 0) }));
jest.mock("../../services/documents", () => ({ ...jest.requireActual("../../services/documents"), buildDocument: jest.fn(async () => { throw new Error("tests never build a document"); }) }));

import { and, eq } from "drizzle-orm";
import { brandBooks, chatMessages, inboxBrands, inboxThreads, workflowRuns } from "../../../shared/schema";
import { BRAND_BOOK_CONTRACT } from "../../../shared/brandBook";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dbDocumentsSource } from "./dbSource";
import { buildProgressCard } from "./cards";
import { dbDocTellChats } from "./tellDb";
import { tellDocumentReady } from "./tell";
import { DOCUMENT_BUILDS_PER_DAY } from "./config";

let her = "";
let other = "";
const brandIds: Record<string, number> = {};
const ENV = ["PUBLIC_CARD"];
const saved: Record<string, string | undefined> = {};

async function brandFor(who: string, key: string, name: string, research: "confirmed" | "candidate" | "none") {
  const enrichment = research === "none" ? null : { identity: { status: research } };
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${key}-${who.slice(0, 6)}`, enrichment, description: research === "confirmed" ? "Makes gear for runners." : null } as any).returning({ id: inboxBrands.id });
  await db.insert(inboxThreads).values({ athlete_id: who, brand_id: b.id, subject: "Hello", status: "deal_detected", message_count: 1 } as any);
  brandIds[key] = b.id;
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.PUBLIC_CARD;
  await initTestDb();
  her = await seedAthlete("Test Athlete One");
  other = await seedAthlete("Test Athlete Two");
  await brandFor(her, "north", "Northpeak Apparel", "confirmed");
  await brandFor(her, "northx", "Northpeak", "candidate");
  await brandFor(her, "plain", "Plainfield Water", "none");
  await brandFor(other, "foreign", "Foreignbrand Co", "confirmed");
  await db.insert(brandBooks).values({
    athlete_id: her, version: 1, status: "ready", generated_at: new Date("2026-10-20T10:00:00Z"),
    data: { contract: BRAND_BOOK_CONTRACT, version: 1, generatedAt: "2026-10-20T10:00:00Z", firstName: "Test", pages: [
      { id: "cover", title: "Your brand", lines: { line: { text: "First words.", options: ["First words.", "Second words."] } }, facts: [], images: ["books/cover.jpg"] },
    ] },
  } as any);
}, 120_000);
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await closeTestDb();
});

describe("S1: her brands only", () => {
  it("never finds another athlete's brand; exact beats partial; confirmed and researched from the research", async () => {
    expect(await dbDocumentsSource.brand(her, "Foreignbrand")).toEqual({ none: true });
    expect(await dbDocumentsSource.brand(other, "Foreignbrand")).toMatchObject({ found: { id: brandIds.foreign } });
    expect(await dbDocumentsSource.brand(her, "northpeak")).toMatchObject({ found: { id: brandIds.northx, confirmed: false, researched: false } });
    expect(await dbDocumentsSource.brand(her, "Northpeak Apparel")).toMatchObject({ found: { id: brandIds.north, confirmed: true, researched: true } });
    expect(await dbDocumentsSource.brand(her, "north")).toMatchObject({ ambiguous: expect.arrayContaining(["Northpeak Apparel", "Northpeak"]) });
    expect(await dbDocumentsSource.brand(her, "Plainfield")).toMatchObject({ found: { confirmed: false, researched: false } });
  });
});

describe("S2: the brand book", () => {
  it("reads its pages and changes a line both ways, keeping the options", async () => {
    const pages = await dbDocumentsSource.pages(her, { kind: "brand_book" });
    expect(pages).toEqual({ ok: true, value: [{ id: "cover", title: "Your brand", photo: false, lines: [{ slot: "line", text: "First words.", options: ["First words.", "Second words."] }] }] });
    expect(await dbDocumentsSource.edit(her, { kind: "brand_book" }, { change: "pick_line", page: "cover", slot: "line", option: 1 })).toEqual({ ok: true, value: { text: null } });
    expect(await dbDocumentsSource.edit(her, { kind: "brand_book" }, { change: "write_line", page: "cover", slot: "line", text: "Third words." })).toEqual({ ok: true, value: { text: "Third words." } });
    // Her words show (keeping the options) and are stored as her override; the engine's book is untouched.
    expect(await dbDocumentsSource.pages(her, { kind: "brand_book" })).toMatchObject({ ok: true, value: [{ lines: [{ slot: "line", text: "Third words.", options: ["First words.", "Second words.", "Third words."] }] }] });
    const [row] = await db.select().from(brandBooks).where(eq(brandBooks.athlete_id, her));
    expect((row.data as any).pages[0].lines.line).toEqual({ text: "First words.", options: ["First words.", "Second words."] });
    expect(row.overrides).toEqual({ copy: { "cover.line": { text: "Third words." } } });
    expect(await dbDocumentsSource.edit(her, { kind: "brand_book" }, { change: "write_line", page: "nope", slot: "line", text: "x" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await dbDocumentsSource.pages(other, { kind: "brand_book" })).toMatchObject({ ok: false, error: "not_built" });
    const s = await dbDocumentsSource.summary(her, { kind: "brand_book" });
    expect(s).toMatchObject({ kind: "brand_book", state: "ready", thumbUrl: "https://signed.example/books/cover.jpg" });
  });
});

describe("S3: builds on the workflow runner", () => {
  it("one run per document (a second ask joins), hers only, and the day's limit", async () => {
    const brand = { id: brandIds.north, name: "Northpeak Apparel", logoUrl: null, confirmed: true, researched: true };
    const a = await dbDocumentsSource.startBuild(her, { kind: "pitch", brand }, { angles: ["Trail days"], conversationId: "11111111-1111-4111-a111-111111111111" });
    expect(a).toMatchObject({ ok: true, value: { joined: false } });
    const b = await dbDocumentsSource.startBuild(her, { kind: "pitch", brand }, { angles: [], conversationId: null });
    expect(b).toEqual({ ok: true, value: { runId: (a as any).value.runId, joined: true } });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, (a as any).value.runId));
    expect(run).toMatchObject({ athlete_id: her, process: "document_build", active_scope: `document_build:pitch:${brandIds.north}`, input: expect.objectContaining({ kind: "pitch", brandId: brandIds.north, angles: ["Trail days"], askedFrom: ["11111111-1111-4111-a111-111111111111"] }) });
    const o = await dbDocumentsSource.overview(her);
    expect(o.pitches).toEqual([expect.objectContaining({ kind: "pitch", state: "building", brand: expect.objectContaining({ id: brandIds.north }) })]);
    // Different documents up to the day's limit (the brand book and the public page are two of them).
    const started = [a];
    for (const ref of [{ kind: "brand_book" as const }, { kind: "public_page" as const }]) started.push(await dbDocumentsSource.startBuild(her, ref, { angles: [], conversationId: null }));
    for (let i = started.length; i < DOCUMENT_BUILDS_PER_DAY; i++) {
      started.push(await dbDocumentsSource.startBuild(her, { kind: "pitch", brand: { ...brand, id: 900_000 + i } }, { angles: [], conversationId: null }));
    }
    expect(started.every((s) => s.ok)).toBe(true);
    expect(await dbDocumentsSource.startBuild(her, { kind: "pitch", brand: { ...brand, id: 999_999 } }, { angles: [], conversationId: null })).toEqual({ ok: false, error: "daily_limit" });
    // Joining a running one is never limited.
    expect(await dbDocumentsSource.startBuild(her, { kind: "pitch", brand }, { angles: [], conversationId: null })).toMatchObject({ ok: true, value: { joined: true } });
    // Another athlete has her own day.
    expect(await dbDocumentsSource.startBuild(other, { kind: "brand_book" }, { angles: [], conversationId: null })).toMatchObject({ ok: true, value: { joined: false } });
  });
});

describe("S4: the tell side", () => {
  it("finds the asking chat by its progress card, writes the line once, flips the card", async () => {
    const conv = "22222222-2222-4222-a222-222222222222";
    const brand = { id: brandIds.north, name: "Northpeak Apparel", logoUrl: null, confirmed: true, researched: true };
    await db.insert(chatMessages).values({ athlete_id: her, role: "assistant", content: "On it.", conversation_id: conv, agent_cards: [buildProgressCard("wf-77", { kind: "pitch", brand }, "run-1")] } as any);
    // Another athlete's row with the same run id is never touched.
    await db.insert(chatMessages).values({ athlete_id: other, role: "assistant", content: "On it.", conversation_id: conv, agent_cards: [buildProgressCard("wf-77", { kind: "pitch", brand }, "run-1")] } as any);
    const input = { kind: "pitch" as const, brandId: brand.id, brandName: brand.name, angles: [], askedFrom: [conv] };
    const r = await tellDocumentReady({ chats: dbDocTellChats, source: dbDocumentsSource }, her, { runId: "wf-77", input, ok: false });
    expect(r).toEqual({ told: [conv], alreadyTold: [] });
    const again = await tellDocumentReady({ chats: dbDocTellChats, source: dbDocumentsSource }, her, { runId: "wf-77", input, ok: false });
    expect(again).toEqual({ told: [], alreadyTold: [conv] });
    const mine = await db.select().from(chatMessages).where(and(eq(chatMessages.athlete_id, her), eq(chatMessages.conversation_id, conv)));
    expect(mine.map((m) => m.content).sort()).toEqual(["I couldn't finish your pitch for Northpeak Apparel this time. Nothing changed and nothing went out. Ask me again in a little while.", "On it."]);
    expect((mine.find((m) => m.content === "On it.")!.agent_cards as any[])[0].payload.state).toBe("failed");
    const theirs = await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, other));
    expect(theirs).toHaveLength(1);
    expect((theirs[0].agent_cards as any[])[0].payload.state).toBe("running");
  });
});
