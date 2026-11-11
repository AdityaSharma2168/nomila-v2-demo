/**
 * overrides.db.test.ts — her choices in the brand book survive a rebuild (overrides.ts, the Nomi Card editor's pattern),
 * on PGlite. The engine's build is stubbed at its inputs (sources, copy, pages): no model, provider or GCS is reached.
 *
 *   O1  a rebuild keeps the line she chose and the line she wrote; the engine's book itself holds only the engine's words
 *   O2  an override whose slot the rebuild no longer has is kept in storage, not rendered, and noted in the log
 *   O3  the read API (readBrandBook) and Mila's pages read return the merged view
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
const logged: Array<{ obj: any; msg: string }> = [];
jest.mock("../../logger", () => ({
  createLogger: () => ({ info: (obj: any, msg: string) => logged.push({ obj, msg }), warn: () => {}, error: () => {}, debug: () => {} }),
}));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: async (p: string) => `https://signed.example/${p}` }));
jest.mock("./reel", () => ({ startBookReel: async () => null }));
jest.mock("../athleteContext", () => ({ getAthleteContext: async () => ({ firstName: "Test", name: "Test Athlete" }) }));
jest.mock("../copywriter", () => ({ loadCopyCtx: async () => ({ voice: null, brief: null }) }));
jest.mock("../../agent/memory", () => ({ listPreferences: async () => [] }));
jest.mock("./sources", () => ({ readBookSources: async () => ({ firstName: "Test" }) }));
jest.mock("./copy", () => ({ restateLines: async () => [], writeBookCopy: async () => ({ lines: {} }) }));
// The engine's pages for the next build: each test sets what the rebuild writes.
let nextPages: any[] = [];
jest.mock("./pages", () => ({
  assemblePages: () => nextPages, bookBriefs: () => [], chipFactsFor: () => ({}), readLines: () => [], withRestated: (s: unknown) => s,
}));

import { eq } from "drizzle-orm";
import { brandBooks } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { chooseLine, completeBrandBook, markBrandBookBuilding, readBrandBook, writeLine } from "./index";
import { dbDocumentsSource } from "../../agent/documents/dbSource";

const ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";

const enginePages = (lead: string) => [
  { id: "cover", title: "Your brand", lines: { line: { text: `${lead} one.`, options: [`${lead} one.`, `${lead} two.`] }, eyebrow: { text: "Tag", options: ["Tag"] } }, facts: [], images: [] },
  { id: "pillars", title: "Your pillars", lines: { "pillar.0.name": { text: "Engine pillar", options: ["Engine pillar"] } }, facts: [], images: [] },
];

async function rebuild(pages: any[]): Promise<void> {
  nextPages = pages;
  const m = await markBrandBookBuilding(ATHLETE);
  expect(m.started).toBe(true);
  expect(await completeBrandBook(ATHLETE, m.version, m.hadData)).toBe(true);
}
const stored = async () => (await db.select().from(brandBooks).where(eq(brandBooks.athlete_id, ATHLETE)))[0];
const lineOf = (book: any, page: string, slot: string) => book?.pages.find((p: any) => p.id === page)?.lines[slot];

beforeAll(async () => {
  await initTestDb();
  await seedAthlete("Test Athlete", { id: ATHLETE } as any);
}, 120_000);
afterAll(async () => { await closeTestDb(); });

describe("O1: a rebuild keeps her chosen and written lines", () => {
  it("chooses, writes, rebuilds: both lines still show; the engine's book holds only the engine's words", async () => {
    await rebuild(enginePages("Old"));
    expect(await chooseLine(ATHLETE, "cover", "line", 1)).toBe(true);
    expect(await writeLine(ATHLETE, "pillars", "pillar.0.name", "  Her   own pillar ")).toBe(true);
    expect(await chooseLine(ATHLETE, "cover", "line", 9)).toBe(false);
    expect(await writeLine(ATHLETE, "nope", "line", "x")).toBe(false);

    await rebuild(enginePages("New"));
    const row = await stored();
    expect(lineOf(row.data, "cover", "line")).toEqual({ text: "New one.", options: ["New one.", "New two."] });
    expect(row.overrides).toEqual({ copy: { "cover.line": { text: "Old two.", pick: 1 }, "pillars.pillar.0.name": { text: "Her own pillar" } } });

    const r = await readBrandBook(ATHLETE);
    expect(r.status).toBe("ready");
    // What she chose stays shown, and still sits among the options so the swap offers it.
    expect(lineOf(r.book, "cover", "line")).toEqual({ text: "Old two.", options: ["New one.", "New two.", "Old two."] });
    expect(lineOf(r.book, "pillars", "pillar.0.name")).toEqual({ text: "Her own pillar", options: ["Engine pillar", "Her own pillar"] });
    expect(lineOf(r.book, "cover", "eyebrow")).toEqual({ text: "Tag", options: ["Tag"] });

    // A swap after the rebuild picks from the options she sees, and replaces her earlier choice.
    expect(await chooseLine(ATHLETE, "cover", "line", 1)).toBe(true);
    expect(lineOf((await readBrandBook(ATHLETE)).book, "cover", "line").text).toBe("New two.");
    expect((await stored()).overrides).toMatchObject({ copy: { "cover.line": { text: "New two.", pick: 1 } } });
    // Choosing the engine's own line again clears her override: she is back on the engine's line, which follows rebuilds.
    expect(await chooseLine(ATHLETE, "cover", "line", 0)).toBe(true);
    expect(lineOf((await readBrandBook(ATHLETE)).book, "cover", "line").text).toBe("New one.");
    expect((await stored()).overrides).toEqual({ copy: { "pillars.pillar.0.name": { text: "Her own pillar" } } });
  });
});

describe("O1b: two swaps at once", () => {
  it("both land (one atomic jsonb merge each, no read-modify-write of the whole object)", async () => {
    await Promise.all([chooseLine(ATHLETE, "cover", "line", 1), writeLine(ATHLETE, "cover", "eyebrow", "Both")]);
    const copy = ((await stored()).overrides as any).copy;
    expect(copy["cover.line"]).toEqual({ text: "New two.", pick: 1 });
    expect(copy["cover.eyebrow"]).toEqual({ text: "Both" });
    expect(await chooseLine(ATHLETE, "cover", "line", 0)).toBe(true);
    expect(await writeLine(ATHLETE, "cover", "eyebrow", "Tag")).toBe(true);
    expect(((await stored()).overrides as any).copy).toEqual({ "pillars.pillar.0.name": { text: "Her own pillar" } });
  });
});

describe("O2: an override whose slot vanished", () => {
  it("is kept, not rendered, and noted in the log", async () => {
    logged.length = 0;
    await rebuild([enginePages("Newer")[0]]);   // this build has no pillars page
    const row = await stored();
    expect((row.overrides as any).copy["pillars.pillar.0.name"]).toEqual({ text: "Her own pillar" });
    const r = await readBrandBook(ATHLETE);
    expect(r.book?.pages.map((p) => p.id)).toEqual(["cover"]);
    expect(JSON.stringify(r.book)).not.toContain("Her own pillar");
    expect(logged.find((l) => /kept but not shown/.test(l.msg))?.obj).toMatchObject({ athleteId: ATHLETE, orphans: ["pillars.pillar.0.name"] });

    // When a later build has the slot again, her words come back.
    await rebuild(enginePages("Newest"));
    expect(lineOf((await readBrandBook(ATHLETE)).book, "pillars", "pillar.0.name").text).toBe("Her own pillar");
  });
});

describe("O3: Mila reads the merged view", () => {
  it("documents pages show her lines, and her edits there go to the overrides", async () => {
    const pages = await dbDocumentsSource.pages(ATHLETE, { kind: "brand_book" });
    if (!pages.ok) throw new Error("expected pages");
    expect(pages.value.find((p) => p.id === "pillars")?.lines).toEqual([{ slot: "pillar.0.name", text: "Her own pillar", options: ["Engine pillar", "Her own pillar"] }]);
    expect(await dbDocumentsSource.edit(ATHLETE, { kind: "brand_book" }, { change: "write_line", page: "cover", slot: "eyebrow", text: "Mine" })).toEqual({ ok: true, value: { text: "Mine" } });
    const row = await stored();
    expect(lineOf(row.data, "cover", "eyebrow")).toEqual({ text: "Tag", options: ["Tag"] });
    expect((row.overrides as any).copy["cover.eyebrow"]).toEqual({ text: "Mine" });
  });
});
