/**
 * library.test.ts — the shared atmosphere library's import pieces, with no network: the sport list is the one shared
 * list (shared/sports.ts); list entries are checked against the vocabulary and the grid, for either source; the
 * Unsplash download goes through the page's download URL to images.unsplash.com only and refuses Unsplash+; the
 * Pexels download goes straight to its keyless image CDN; the copy is ≤ 1600 px WebP within the size target; the
 * verdict rejects people only outside sign-in. Every HTTP call is a fake.
 */
import sharp from "sharp";
import {
  downloadPexelsPhoto, downloadUnsplashPhoto, libraryVerdict, LibraryEntrySchema, LICENCE_BY_SOURCE, objectBase,
  parseEntry, pexelsIdOf, photoIdOf, PEXELS_LICENCE, sourceOf, sportGrid, toLibraryWebp, unsplashIdOf,
  UnsplashPlusError, UNSPLASH_LICENCE, LONG_EDGE, TARGET_MAX_BYTES, type FetchLike,
} from "./library";
import { SPORTS } from "../../../shared/sports";
import { MAX_SIGNIN_PHOTOS } from "../../agent/onboarding/front";

const GRID = [{ id: "sport_a", label: "Sport A" }, { id: "sport_b", label: "Sport B & C" }];

describe("sportGrid", () => {
  it("reads the ids from the grid source and adds other", () => {
    expect(sportGrid(GRID)).toEqual([{ id: "sport_a", label: "Sport A" }, { id: "sport_b", label: "Sport B & C" }, { id: "other", label: "Other" }]);
  });
  it("reads the ONE sport list (shared/sports.ts: the app's grid and the landing page read it too)", () => {
    const ids = sportGrid().map((s) => s.id);
    expect(ids).toEqual([...SPORTS.map((s) => s.id), "other"]);
    expect(ids).toEqual(expect.arrayContaining(["pickleball", "skiing"]));
    expect(ids.every((id) => /^[a-z0-9_]+$/.test(id))).toBe(true);
  });
  it("fails loudly when the list is empty", () => {
    expect(() => sportGrid([])).toThrow(/sport list is empty/);
  });
});

describe("entries", () => {
  const sports = new Set(["sport_a", "other"]);
  const base = { page: "https://unsplash.com/photos/an-empty-place-AbCdEfGhIjK", licence: "Unsplash License", purposes: ["performance"] };
  const pexelsBase = { page: "https://www.pexels.com/photo/an-empty-place-123456789/", licence: "Pexels License", purposes: ["performance"] };
  it("takes the photo id from the page URL", () => {
    expect(unsplashIdOf(base.page)).toBe("AbCdEfGhIjK");
    expect(unsplashIdOf("https://unsplash.com/photos/-ofOCf-jen4")).toBe("-ofOCf-jen4");
    expect(unsplashIdOf("https://example.com/photos/AbCdEfGhIjK")).toBeNull();
    expect(unsplashIdOf("https://unsplash.com/@someone")).toBeNull();
  });
  it("takes the photo id from a Pexels page URL", () => {
    expect(pexelsIdOf(pexelsBase.page)).toBe("123456789");
    expect(pexelsIdOf("https://www.pexels.com/photo/portrait-of-male-soccer-player-by-goalpost-38242310/")).toBe("38242310");
    expect(pexelsIdOf("https://pexels.com/photo/no-trailing-slash-1")).toBe("1");
    expect(pexelsIdOf("https://example.com/photo/an-empty-place-123456789/")).toBeNull();
    expect(pexelsIdOf("https://www.pexels.com/@someone/")).toBeNull();
    expect(pexelsIdOf(base.page)).toBeNull(); // an Unsplash page is not a Pexels one
  });
  it("tells the source apart from the page URL; photoIdOf works for either", () => {
    expect(sourceOf(base.page)).toBe("unsplash");
    expect(sourceOf(pexelsBase.page)).toBe("pexels");
    expect(sourceOf("https://example.com/photos/x")).toBeNull();
    expect(photoIdOf(base.page)).toBe("AbCdEfGhIjK");
    expect(photoIdOf(pexelsBase.page)).toBe("123456789");
    expect(photoIdOf("https://example.com/photos/x")).toBeNull();
  });
  it("checks category, sport, purposes and licence", () => {
    expect(parseEntry({ ...base, category: "sport", sport: "sport_a", tags: ["Court "] }, sports)).toMatchObject({ sport: "sport_a", tags: ["court"], source: "unsplash", active: true });
    expect(parseEntry({ ...base, category: "general", purposes: ["texture"] }, sports)).toMatchObject({ sport: null });
    expect(() => parseEntry({ ...base, category: "sport", sport: "sport_z" }, sports)).toThrow(/not in the onboarding grid/);
    expect(() => parseEntry({ ...base, category: "sport" }, sports)).toThrow(/needs `sport`/);
    expect(() => parseEntry({ ...base, category: "general", sport: "sport_a" }, sports)).toThrow(/has no sport/);
    expect(() => parseEntry({ ...base, category: "general", purposes: ["hero"] }, sports)).toThrow();
    expect(() => parseEntry({ ...base, category: "general", licence: "Unsplash+ License" }, sports)).toThrow();
  });
  it("accepts a Pexels entry with the Pexels licence, and refuses a mismatched licence or an explicit wrong source", () => {
    expect(parseEntry({ ...pexelsBase, category: "general", purposes: ["texture"] }, sports)).toMatchObject({ source: "pexels", sport: null });
    expect(parseEntry({ ...pexelsBase, source: "pexels", category: "general", purposes: ["texture"] }, sports)).toMatchObject({ source: "pexels" });
    expect(() => parseEntry({ ...pexelsBase, licence: "Unsplash License", category: "general", purposes: ["texture"] }, sports)).toThrow(/needs the licence "Pexels License"/);
    expect(() => parseEntry({ ...base, licence: "Pexels License", category: "general", purposes: ["texture"] }, sports)).toThrow(/needs the licence "Unsplash License"/);
    expect(() => parseEntry({ ...pexelsBase, source: "unsplash", category: "general", purposes: ["texture"] }, sports)).toThrow(/page is a pexels URL but source says "unsplash"/);
  });
  it("defaults active to true; an explicit false round-trips", () => {
    expect(parseEntry({ ...base, category: "general", purposes: ["texture"] }, sports)).toMatchObject({ active: true });
    expect(parseEntry({ ...base, category: "general", purposes: ["texture"], active: false }, sports)).toMatchObject({ active: false });
  });
  it("files the copy under atmosphere/shared/<group>/<id>", () => {
    expect(objectBase({ category: "sport", sport: "sport_a" }, "X")).toBe("atmosphere/shared/sport_a/X");
    expect(objectBase({ category: "signin", sport: null }, "X")).toBe("atmosphere/shared/signin/X");
  });
  it("is strict: a typo'd field fails loudly instead of being silently dropped", () => {
    expect(() => LibraryEntrySchema.parse({ ...base, category: "general", purposes: ["texture"], actve: false })).toThrow(/actve/);
    // retiredReason / reviewNote are named fields (kept for the record; parseEntry ignores their content).
    expect(LibraryEntrySchema.parse({ ...base, category: "general", purposes: ["texture"], retiredReason: "x", reviewNote: "y" }))
      .toMatchObject({ retiredReason: "x", reviewNote: "y" });
  });
});

const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
// `Uint8Array` (any backing buffer) in; a copy into a fresh ArrayBuffer out, so no cast is needed.
const res = (status: number, headers: Record<string, string>, body: Uint8Array = new Uint8Array(0)) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(body).buffer,
});

describe("downloadUnsplashPhoto", () => {
  it("follows the page's download URL to images.unsplash.com and asks for 2400 px", async () => {
    const calls: string[] = [];
    const body = await jpeg(40, 30);
    const f: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith("https://unsplash.com/")) return res(302, { location: "https://images.unsplash.com/photo-1?ixlib=rb&q=85&fm=jpg&dl=x.jpg" });
      return res(200, { "content-type": "image/jpeg" }, body);
    };
    const out = await downloadUnsplashPhoto("AbCdEfGhIjK", f);
    expect(calls[0]).toBe("https://unsplash.com/photos/AbCdEfGhIjK/download?force=true");
    expect(new URL(calls[1]).searchParams.get("w")).toBe("2400");
    expect(new URL(calls[1]).searchParams.has("dl")).toBe(false);
    expect(out.fileUrl).toBe("https://images.unsplash.com/photo-1");
    expect(out.bytes.equals(body)).toBe(true);
  });
  it("refuses Unsplash+, other hosts, non-images and bad ids", async () => {
    const to = (location: string): FetchLike => async () => res(302, { location });
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", to("https://plus.unsplash.com/premium_photo-1"))).rejects.toBeInstanceOf(UnsplashPlusError);
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", to("https://evil.example/x.jpg"))).rejects.toThrow(/unexpected file host/);
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", async () => res(200, {}))).rejects.toThrow(/did not redirect/);
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", to("/.within.website?redir=x"))).rejects.toThrow(/bot check/);
    let n = 0;
    const html: FetchLike = async () => (n++ === 0 ? res(302, { location: "https://images.unsplash.com/photo-1" }) : res(200, { "content-type": "text/html" }, Buffer.from("x")));
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", html)).rejects.toThrow(/not an image/);
    await expect(downloadUnsplashPhoto("../etc", to("https://images.unsplash.com/x"))).rejects.toThrow(/not an Unsplash photo id/);
  });
  it("gives up on a stalled request instead of waiting forever", async () => {
    const stalled: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expect(downloadUnsplashPhoto("AbCdEfGhIjK", stalled, undefined, 20)).rejects.toThrow(/timeout|aborted/i);
  });
});

describe("downloadPexelsPhoto", () => {
  it("fetches the keyless image CDN URL directly, no page scrape or redirect", async () => {
    const calls: string[] = [];
    const body = await jpeg(40, 30);
    const f: FetchLike = async (url) => { calls.push(url); return res(200, { "content-type": "image/jpeg" }, body); };
    const out = await downloadPexelsPhoto("38242310", f);
    expect(calls).toEqual(["https://images.pexels.com/photos/38242310/pexels-photo-38242310.jpeg?auto=compress&cs=tinysrgb&w=2400"]);
    expect(out.fileUrl).toBe(calls[0]);
    expect(out.bytes.equals(body)).toBe(true);
  });
  it("refuses a failed fetch, a non-image response and a bad id", async () => {
    await expect(downloadPexelsPhoto("38242310", async () => res(404, {}))).rejects.toThrow(/download failed/);
    await expect(downloadPexelsPhoto("38242310", async () => res(200, { "content-type": "text/html" }, Buffer.from("x")))).rejects.toThrow(/not an image/);
    await expect(downloadPexelsPhoto("not-a-number", async () => res(200, {}))).rejects.toThrow(/not a Pexels photo id/);
  });
  it("asks for no redirect and refuses any 3xx, instead of silently following to an unverified host", async () => {
    const calls: Array<{ url: string; redirect?: string }> = [];
    const f: FetchLike = async (url, init) => { calls.push({ url, redirect: init?.redirect }); return res(302, { location: "https://evil.example/x.jpg" }); };
    await expect(downloadPexelsPhoto("38242310", f)).rejects.toThrow(/unexpected redirect/);
    expect(calls[0].redirect).toBe("manual");
  });
  it("gives up on a stalled request instead of waiting forever", async () => {
    const stalled: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expect(downloadPexelsPhoto("38242310", stalled, undefined, 20)).rejects.toThrow(/timeout|aborted/i);
  });
});

describe("toLibraryWebp", () => {
  it("fits the long edge to 1600 px as WebP within the size target, never enlarging", async () => {
    const big = await toLibraryWebp(await jpeg(3200, 2000));
    expect([big.width, big.height]).toEqual([LONG_EDGE, 1000]);
    expect(big.bytes.byteLength).toBeLessThanOrEqual(TARGET_MAX_BYTES);
    expect((await sharp(big.bytes).metadata()).format).toBe("webp");
    const small = await toLibraryWebp(await jpeg(800, 1200));
    expect([small.width, small.height]).toEqual([800, 1200]);
  });
});

describe("the seed list (scripts/data/atmosphere-library-seed.json)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const list = require("../../../scripts/data/atmosphere-library-seed.json") as unknown[];
  const sports = new Set(sportGrid().map((s) => s.id));
  const entries = list.map((e) => parseEntry(e, sports));

  it("is valid against the vocabulary and the onboarding grid, one row per photo (per source), standard licence per source", () => {
    const ids = entries.map((e) => photoIdOf(e.page));
    expect(new Set(ids).size).toBe(ids.length);
    // De-duped on source:id, not just id: an Unsplash id must never collide with a same-looking Pexels one.
    const keys = entries.map((e, i) => `${e.source}:${ids[i]}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(entries.every((e) => e.licence === LICENCE_BY_SOURCE[e.source])).toBe(true);
    expect(entries.filter((e) => e.category === "signin").length).toBeGreaterThanOrEqual(4);
    expect(entries.filter((e) => e.category === "general").length).toBeGreaterThanOrEqual(15);
    // the seed includes both sources (round 3's volleyball/soccer/football/baseball/tennis picks are Pexels)
    expect(entries.some((e) => e.source === "pexels")).toBe(true);
    expect(entries.some((e) => e.source === "unsplash")).toBe(true);
  });

  it("the active sign-in picks: one close-up per sport (no two share a first tag), within the front's safety cap", () => {
    const activeSignin = entries.filter((e) => e.category === "signin" && e.active);
    const firstTags = activeSignin.map((e) => e.tags[0]);
    expect(new Set(firstTags).size).toBe(firstTags.length);
    expect(activeSignin.length).toBeLessThanOrEqual(MAX_SIGNIN_PHOTOS);
    expect(activeSignin.length).toBeGreaterThan(0);
  });
});

describe("libraryVerdict", () => {
  const clean = { person: false, face: false, logo: false, text: false, watermark: false, fits_purpose: true, reason: "" };
  it("atmosphere photos: no person, face, logo, text or watermark, and on purpose", () => {
    expect(libraryVerdict("sport", clean)).toEqual({ accepted: true, reasons: [] });
    expect(libraryVerdict("general", { ...clean, person: true, text: true })).toEqual({ accepted: false, reasons: ["person", "text"] });
    expect(libraryVerdict("sport", { ...clean, fits_purpose: false })).toEqual({ accepted: false, reasons: ["off_purpose"] });
  });
  it("sign-in photos may show people, never a logo, text or watermark", () => {
    expect(libraryVerdict("signin", { ...clean, person: true, face: true }).accepted).toBe(true);
    expect(libraryVerdict("signin", { ...clean, person: true, logo: true })).toEqual({ accepted: false, reasons: ["logo"] });
  });
});
