/**
 * documents — the tool-callable document functions answer expected states with typed, actionable errors (never throw),
 * and never start paid work for a brand that is not confirmed. Providers and the database are mocked.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

let brandRow: any = null;
jest.mock("../../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (brandRow ? [brandRow] : []) }) }) }) },
}));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const buildAndCacheKit = jest.fn(async (..._a: unknown[]) => ({ cards: [{ id: "cover" }] }));
jest.mock("../kitCache", () => ({ getOrBuildKit: jest.fn(async () => ({ cards: [{ id: "cover", type: "cover" }] })), buildAndCacheKit: (...a: unknown[]) => (buildAndCacheKit as any)(...a) }));
const markBrandBookBuilding = jest.fn(async (..._a: unknown[]) => ({ version: 2, started: true, hadData: true }));
const completeBrandBook = jest.fn(async (..._a: unknown[]) => true);
const writeBookLine = jest.fn(async (..._a: unknown[]) => true);
jest.mock("../brandBook", () => ({
  brandBookEnabled: () => true, readBrandBook: jest.fn(async () => ({ status: "ready" })), startBrandBook: jest.fn(async () => ({})), chooseLine: jest.fn(async () => false),
  markBrandBookBuilding: (...a: unknown[]) => (markBrandBookBuilding as any)(...a), completeBrandBook: (...a: unknown[]) => (completeBrandBook as any)(...a),
  writeLine: (...a: unknown[]) => (writeBookLine as any)(...a),
}));
const saveOverrides = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../cardOverrides", () => ({ getOverrides: jest.fn(async () => null), saveOverrides: (...a: unknown[]) => (saveOverrides as any)(...a), editableFields: (t: string) => (t === "cover" ? [{ field: "hook", slot: "tagline" }] : []) }));
let research: any = null;
jest.mock("../pitchConcept", () => ({ loadBrandResearch: async () => research, parseFocus: (x: unknown) => (Array.isArray(x) ? x : []) }));
jest.mock("../nomiDeck", () => ({ nomiEngineEnabled: () => true, renderNomiForWeb: jest.fn(async () => "<html></html>") }));

import { buildDocument, createPitch, swapLine, writeLine } from "./index";

describe("documents service", () => {
  beforeEach(() => { brandRow = null; research = null; buildAndCacheKit.mockClear(); saveOverrides.mockClear(); writeBookLine.mockClear(); markBrandBookBuilding.mockClear(); completeBrandBook.mockClear(); });

  it("createPitch: bad input is an error, not a throw", async () => {
    expect(await createPitch("a", 0)).toMatchObject({ ok: false, code: "bad_input" });
  });
  it("createPitch: unknown brand → not_found", async () => {
    expect(await createPitch("a", 7)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("createPitch: an unconfirmed brand never starts the paid build", async () => {
    brandRow = { id: 7, name: "Brandco", enrichment: { identity: { status: "candidate" } } };
    const r = await createPitch("a", 7);
    expect(r).toMatchObject({ ok: false, code: "brand_not_confirmed" });
    expect(buildAndCacheKit).not.toHaveBeenCalled();
  });
  it("createPitch: confirmed but unresearched → no_research", async () => {
    brandRow = { id: 7, name: "Brandco", enrichment: { identity: { status: "confirmed" } } };
    research = { description: null, values: null, audience: null, recentCampaigns: [] };
    expect(await createPitch("a", 7)).toMatchObject({ ok: false, code: "no_research" });
  });
  it("createPitch: confirmed + researched → builds with her chosen angles", async () => {
    brandRow = { id: 7, name: "Brandco", enrichment: { identity: { status: "confirmed" } } };
    research = { description: "We make things", values: null, audience: null, recentCampaigns: [] };
    expect(await createPitch("a", 7, ["leadership"])).toMatchObject({ ok: true, brandId: 7 });
    expect(buildAndCacheKit).toHaveBeenCalledWith("a", { brandId: 7, angles: ["leadership"] });
  });
  it("swapLine with an instruction is handed back for the writer (no model call here)", async () => {
    expect(await swapLine("a", "brand_book", "cover", "promise", { instruction: "warmer" })).toMatchObject({ ok: true, applied: false, needsWriter: { instruction: "warmer" } });
    expect(await swapLine("a", "brand_book", "cover", "promise", { instruction: " " })).toMatchObject({ ok: false, code: "bad_input" });
  });

  it("writeLine: her words land as the editor's copy override on a card, or on the brand book's line; blank or long is bad input", async () => {
    expect(await writeLine("a", "public_page", "cover", "hook", "  New  words ")).toEqual({ ok: true, applied: true });
    expect(saveOverrides).toHaveBeenCalledWith("a", 0, { copy: { "cover.hook": { text: "New words" } } });
    expect(await writeLine("a", "pitch", "cover", "tagline", "For you", { brandId: 7 })).toEqual({ ok: true, applied: true });
    expect(saveOverrides).toHaveBeenLastCalledWith("a", 7, { copy: { "cover.hook": { text: "For you" } } });
    expect(await writeLine("a", "public_page", "story", "close", "x")).toMatchObject({ ok: false, code: "not_found" });
    expect(await writeLine("a", "brand_book", "cover", "line", "Yours")).toEqual({ ok: true, applied: true });
    expect(writeBookLine).toHaveBeenCalledWith("a", "cover", "line", "Yours");
    expect(await writeLine("a", "brand_book", "cover", "line", " ")).toMatchObject({ ok: false, code: "bad_input" });
    expect(await writeLine("a", "brand_book", "cover", "line", "x".repeat(241))).toMatchObject({ ok: false, code: "bad_input" });
  });

  it("buildDocument: the brand book is written awaited (never twice at once); a pitch goes through the brand gate; the page rebuilds the general card", async () => {
    expect(await buildDocument("a", "brand_book")).toEqual({ ok: true, doc: "brand_book", detail: "built" });
    expect(completeBrandBook).toHaveBeenCalledWith("a", 2, true);
    markBrandBookBuilding.mockResolvedValueOnce({ version: 2, started: false, hadData: true });
    expect(await buildDocument("a", "brand_book")).toEqual({ ok: true, doc: "brand_book", detail: "already_building" });
    expect(completeBrandBook).toHaveBeenCalledTimes(1);
    completeBrandBook.mockResolvedValueOnce(false);
    expect(await buildDocument("a", "brand_book")).toMatchObject({ ok: false, code: "failed" });
    brandRow = { id: 7, name: "Brandco", enrichment: { identity: { status: "candidate" } } };
    expect(await buildDocument("a", "pitch", { brandId: 7 })).toMatchObject({ ok: false, code: "brand_not_confirmed" });
    expect(buildAndCacheKit).not.toHaveBeenCalled();
    expect(await buildDocument("a", "public_page")).toEqual({ ok: true, doc: "public_page", detail: "built" });
    expect(buildAndCacheKit).toHaveBeenCalledWith("a", {});
  });
});
