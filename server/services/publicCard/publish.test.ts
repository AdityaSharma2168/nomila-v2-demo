/**
 * publish.test.ts — the publish model and the handle rules against PGlite (design-public-card-v3 §10, §11, §16 Q1).
 * Made-up athletes in different sports; nothing reaches a provider or the network.
 *
 *   H1 handle shape + reserved words; a proposal from her name (accents folded, a number when taken)
 *   H2 first pick free; then once per 30 days; the old handle redirects for 90 days and is closed to others
 *   H3 she can take back her own old handle; an expired hold frees the handle for anyone
 *   P1 publish freezes version 1 and switches the URL atomically; versions only grow
 *   P2 cite or cut at the freeze: an item with no basis is refused; nothing is written
 *   P3 a door her switch has off, or an M.I.A. block with show_mia off, is refused
 *   P4 numbers refresh: same items, new numbers, kind numbers_only; nothing changed → no version
 *   P5 removals: items gone, a closed door's tile becomes "[First]'s story", buttons fall back, never adds
 *   P6 unpublish: the reader answers 404, every snapshot is deleted, versions keep counting
 *   P7 the flag: off → publish refused and the reader answers 404
 *   P8 no contact details: a publish snapshot is frozen filtered (hash of what is stored); a version frozen before the
 *      filter is served filtered on read, under its own ETag; a line that was only contact details is left out
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { publicCardHandleRedirects, publicCardSnapshots, publicCards } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { HandleError, proposeHandle, setHandle, slugFromName, validateHandle } from "./handles";
import { contentHash, ensureCard, publishNumbersRefresh, publishRemoval, publishSnapshot, unpublish } from "./publish";
import { mediaObject, read } from "./publicCardReader";
import { DUPLICATE_TILES_REASON, PUBLIC_CARD_SOURCES_SCHEMA, etagOf, tilesFor } from "./types";
import { ALL_SWITCHES_ON, fixtureCard } from "../../testUtils/publicCardFixtures";

const DAY = 86_400_000;
const T0 = new Date("2026-10-08T12:00:00Z");
const later = (days: number) => new Date(T0.getTime() + days * DAY);

async function newAthlete(name: string, switchesOn = true): Promise<string> {
  const id = await seedAthlete(name);
  await ensureCard(id);
  if (switchesOn) await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, id));
  return id;
}
const handleSet = (id: string, h: string, now = T0) => db.transaction((tx) => setHandle(tx as any, id, h, now));
const card = async (id: string) => (await db.select().from(publicCards).where(eq(publicCards.athlete_id, id)))[0];
const versions = async (id: string) => (await db.select({ v: publicCardSnapshots.version, k: publicCardSnapshots.kind })
  .from(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, id)).orderBy(publicCardSnapshots.version)).map((r) => `${r.v}:${r.k}`);

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; });

describe("H1 handle rules", () => {
  it("shape and reserved words", () => {
    expect(validateHandle("  Tavi-Lind ")).toEqual({ ok: true, handle: "tavi-lind" });
    for (const bad of ["ab", "-tavi", "tavi-", "ta--vi", "ta vi", "tavi_lind", "t".repeat(31), "", null, 42]) expect(validateHandle(bad).ok).toBe(false);
    for (const reserved of ["pay", "legal", "admin", "mila", "requests", "nomila"]) expect(validateHandle(reserved)).toEqual({ ok: false, code: "reserved" });
  });

  it("proposes from her name, folding accents and numbering when taken", async () => {
    expect(slugFromName("Zoë Ångström-Ruiz")).toBe("zoe-angstrom-ruiz");
    const a = await newAthlete("Marisol Peña");
    expect(await proposeHandle(a, "Marisol Peña")).toBe("marisol-pena");
    await handleSet(a, "marisol-pena");
    const b = await newAthlete("Marisol Pena");
    expect(await proposeHandle(b, "Marisol Pena")).toBe("marisol-pena-2");
    expect(await proposeHandle(b, "!!")).toBeNull();
  });
});

describe("H2/H3 changes, redirects and holds", () => {
  it("first pick free; then once per 30 days; the old handle redirects 90 days and is closed to others", async () => {
    const a = await newAthlete("Ines Halvorsen");
    await handleSet(a, "ines-rows");
    expect((await card(a)).handle_changed_at).toBeNull();
    await handleSet(a, "ines-h", later(1));                       // first CHANGE is allowed (the pick was free)
    await expect(handleSet(a, "ines-x", later(10))).rejects.toMatchObject({ code: "too_soon" });
    const err = await handleSet(a, "ines-x", later(10)).catch((e: HandleError) => e);
    expect((err as HandleError).nextChangeAt?.toISOString()).toBe(later(31).toISOString());

    const [r] = await db.select().from(publicCardHandleRedirects).where(eq(publicCardHandleRedirects.handle, "ines-rows"));
    expect(r.athlete_id).toBe(a);
    expect(r.expires_at.toISOString()).toBe(later(91).toISOString());

    const b = await newAthlete("Other Climber");
    await expect(handleSet(b, "ines-rows", later(30))).rejects.toMatchObject({ code: "taken" });
    await expect(handleSet(b, "ines-h", later(30))).rejects.toMatchObject({ code: "taken" });
    await expect(handleSet(b, "admin", later(30))).rejects.toMatchObject({ code: "reserved" });

    // the redirect serves while her card is published
    const { content, sources, media } = fixtureCard("Ines", "Halvorsen");
    await publishSnapshot(a, { content, sources, media }, { now: later(2) });
    expect(await read("ines-rows", { now: later(5) })).toEqual({ status: "redirect", to: "ines-h" });
    expect(await read("INES-ROWS", { now: later(5) })).toEqual({ status: "redirect", to: "ines-h" });
    expect(await read("ines-rows", { now: later(92) })).toEqual({ status: "not_found" });

    // after 90 days anyone may take it (the expired hold is released on claim)
    await handleSet(b, "ines-rows", later(92));
    expect((await card(b)).handle).toBe("ines-rows");
  });

  it("she can take back her own old handle; that redirect ends", async () => {
    const a = await newAthlete("Kofi Brandt");
    await handleSet(a, "kofi-jumps");
    await handleSet(a, "kofi-b", later(1));
    await handleSet(a, "kofi-jumps", later(40));
    expect((await card(a)).handle).toBe("kofi-jumps");
    const rows = await db.select().from(publicCardHandleRedirects).where(eq(publicCardHandleRedirects.athlete_id, a));
    expect(rows.map((r) => r.handle)).toEqual(["kofi-b"]);
  });
});

describe("P1–P3 publish", () => {
  it("freezes version 1, switches the URL, versions only grow; the reader returns only content", async () => {
    const a = await newAthlete("Tavi Okonkwo-Lind");
    const { content, sources, media } = fixtureCard();
    const r1 = await publishSnapshot(a, { content, sources, media }, { now: T0 });
    expect(r1).toMatchObject({ version: 1, handle: "tavi-okonkwo-lind" });
    const got = await read("tavi-okonkwo-lind");
    expect(got).toMatchObject({ status: "ok", version: 1, indexable: false, content });
    expect(Object.keys(got)).not.toContain("sources");
    expect(JSON.stringify(got)).not.toMatch(/assertion|social_feature|shop_item/);   // no manifest leaks

    const edited = fixtureCard();
    edited.content.chapters[0].title = "In short";
    const r2 = await publishSnapshot(a, edited, { now: later(1) });
    expect(r2.version).toBe(2);
    expect(await read("tavi-okonkwo-lind")).toMatchObject({ version: 2 });
    expect(await versions(a)).toEqual(["1:full", "2:full"]);
    expect((await card(a))).toMatchObject({ status: "published", published_version: 2, last_version: 2 });
  });

  it("cite or cut: an item with no basis is refused and nothing is written", async () => {
    const a = await newAthlete("Rhea Castellanos");
    const { content, sources, media } = fixtureCard("Rhea", "Castellanos");
    delete sources.items["partner:d1"];
    await expect(publishSnapshot(a, { content, sources, media })).rejects.toMatchObject({ code: "invalid" });
    const empty = fixtureCard("Rhea", "Castellanos");
    empty.sources.items["partner:d1"] = [];
    await expect(publishSnapshot(a, empty)).rejects.toMatchObject({ code: "invalid" });
    expect(await versions(a)).toEqual([]);
    expect((await card(a)).status).toBe("draft");
  });

  it("a door switched off, or M.I.A. with show_mia off, is refused", async () => {
    const a = await newAthlete("Juno Vasquez", false);   // defaults: book + shop off
    const { content, sources, media } = fixtureCard("Juno", "Vasquez");
    await expect(publishSnapshot(a, { content, sources, media })).rejects.toMatchObject({ code: "invalid" });
    await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, a));
    const withMia = fixtureCard("Juno", "Vasquez");
    withMia.content.mia = { score: 71, band: "HIGH", asOf: "2026-10-01" };
    await expect(publishSnapshot(a, withMia)).rejects.toMatchObject({ code: "invalid" });
    await db.update(publicCards).set({ show_mia: true }).where(eq(publicCards.athlete_id, a));
    expect((await publishSnapshot(a, withMia)).version).toBe(1);
  });
});

describe("P4–P6 numbers, removals, unpublish", () => {
  it("numbers refresh changes stats only, as numbers_only; nothing changed → no version", async () => {
    const a = await newAthlete("Saoirse Mbeki");
    const { content, sources, media } = fixtureCard("Saoirse", "Mbeki");
    await publishSnapshot(a, { content, sources, media });
    const v = await publishNumbersRefresh(a, { "hl.stat:instagram.followers": { value: 13100, asOf: "2026-10-08" }, "partner:d1": { value: 1, asOf: "x" } });
    expect(v).toBe(2);
    const got = await read("saoirse-mbeki");
    if (got.status !== "ok") throw new Error("not ok");
    expect(got.content.chapters[0].items.find((i) => i.kind === "stat")).toMatchObject({ value: 13100, asOf: "2026-10-08" });
    expect(got.content.chapters[1].items[0]).toEqual(content.chapters[1].items[0]);
    expect(await publishNumbersRefresh(a, { "hl.stat:instagram.followers": { value: 13100, asOf: "2026-10-08" } })).toBeNull();
    expect(await versions(a)).toEqual(["1:full", "2:numbers_only"]);
  });

  it("removals pull items and doors, fall back, never add, and say why", async () => {
    const a = await newAthlete("Dara Lindqvist");
    const { content, sources, media } = fixtureCard("Dara", "Lindqvist");
    await publishSnapshot(a, { content, sources, media });

    // she undid "signed": the partner leaves; the chapter is now empty so it leaves too
    expect(await publishRemoval(a, { itemKeys: ["partner:d1"], reason: "You marked the deal as not signed." })).toBe(2);
    let got = await read("dara-lindqvist");
    if (got.status !== "ok") throw new Error("not ok");
    expect(got.content.chapters.map((c) => c.key)).toEqual(["highlights", "media"]);
    expect(got.content.tiles.map((t) => t.intent)).toEqual(["partner", "book", "shop", "create"]);

    // her shelf closed: Shop door off and its picks go; the grid is re-resolved by the renderer's resolver
    expect(await publishRemoval(a, { closeDoors: ["shop"], reason: "Your shelf is closed." })).toBe(3);
    got = await read("dara-lindqvist");
    if (got.status !== "ok") throw new Error("not ok");
    expect(got.content.doors.shop).toBe(false);
    expect(got.content.picks).toEqual([]);
    expect(got.content.tiles[2]).toEqual({ slot: "bl", intent: "story", label: "Story", subLabel: "See Dara's story", targetChapterId: "highlights" });
    expect(got.content.tiles).toEqual(tilesFor(got.content));

    // Ask Mila off: the Highlights button falls back to "Work with Dara"; Book closes and its offers go
    expect(await publishRemoval(a, { closeDoors: ["ask_mila", "book"], reason: "You switched doors off." })).toBe(4);
    got = await read("dara-lindqvist");
    if (got.status !== "ok") throw new Error("not ok");
    expect(got.content.chapters[0].button).toEqual({ door: "partner", label: "Work with Dara" });
    expect(got.content.chapters[1].button).toEqual({ door: "partner", label: "Work with Dara" });
    expect(got.content.offers).toEqual([]);
    expect(got.content.tiles.map((t) => t.intent)).toEqual(["partner", "story", "follow", "create"]);

    // nothing left to pull → no version; the notes are kept for her
    expect(await publishRemoval(a, { itemKeys: ["partner:d1"], reason: "again" })).toBeNull();
    const notes = await db.select({ note: publicCardSnapshots.note, kind: publicCardSnapshots.kind, by: publicCardSnapshots.approved_by_user_id })
      .from(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, a)).orderBy(publicCardSnapshots.version);
    expect(notes.slice(1)).toEqual([
      { note: "You marked the deal as not signed.", kind: "removal", by: null },
      { note: "Your shelf is closed.", kind: "removal", by: null },
      { note: "You switched doors off.", kind: "removal", by: null },
    ]);
    // the sources manifest shrinks with the content
    const [last] = await db.select({ sources: publicCardSnapshots.sources }).from(publicCardSnapshots)
      .where(eq(publicCardSnapshots.athlete_id, a)).orderBy(publicCardSnapshots.version).offset(3);
    expect(Object.keys((last.sources as any).items).sort()).toEqual(["hl.identity:said", "hl.quote:a1", "hl.stat:instagram.followers", "media:x1"]);
  });

  it("drops M.I.A. at once when she switches it off", async () => {
    const a = await newAthlete("Noor Abernathy");
    await db.update(publicCards).set({ show_mia: true }).where(eq(publicCards.athlete_id, a));
    const f = fixtureCard("Noor", "Abernathy");
    f.content.mia = { score: 64, band: "MEDIUM", asOf: "2026-10-01" };
    await publishSnapshot(a, f);
    expect(await publishRemoval(a, { dropMia: true, reason: "You hid your M.I.A." })).toBe(2);
    const got = await read("noor-abernathy");
    expect(got.status === "ok" && got.content.mia).toBeNull();
  });

  it("unpublish: 404, every snapshot deleted, handle kept, versions keep counting", async () => {
    const a = await newAthlete("Pell Ashworth");
    const f = fixtureCard("Pell", "Ashworth");
    await publishSnapshot(a, f);
    await publishSnapshot(a, f);
    expect(await unpublish(a)).toBe(true);
    expect(await read("pell-ashworth")).toEqual({ status: "not_found" });
    expect(await versions(a)).toEqual([]);
    expect(await card(a)).toMatchObject({ status: "unpublished", published_version: null, handle: "pell-ashworth", last_version: 2 });
    expect(await publishRemoval(a, { itemKeys: ["pick:abc123"], reason: "x" })).toBeNull();
    expect((await publishSnapshot(a, f)).version).toBe(3);
    expect(await unpublish(await newAthlete("Never Published"))).toBe(false);
  });
});

describe("P8 the grid guard and media", () => {
  it("refuses a card whose grid would repeat a tile, with a clear reason", async () => {
    const a = await newAthlete("Solo Hurdler", false);
    await db.update(publicCards).set({ door_partner: false }).where(eq(publicCards.athlete_id, a));
    // all three doors off, one chapter, no socials: the resolver cannot fill three distinct fallbacks
    const base = {
      ...fixtureCard("Solo", "Hurdler").content,
      chapters: [{ key: "highlights" as const, title: "Highlights", button: null, items: [] }],
      doors: { partner: false, book: false, shop: false, create: true, ask_mila: true },
      socials: [], offers: [], picks: [],
    };
    const content = { ...base, tiles: tilesFor(base) };
    await expect(publishSnapshot(a, { content, sources: { schema: PUBLIC_CARD_SOURCES_SCHEMA, items: {} } }))
      .rejects.toMatchObject({ code: "invalid", message: DUPLICATE_TILES_REASON });
    expect(await versions(a)).toEqual([]);
  });

  it("refuses tiles that are not the resolver's", async () => {
    const a = await newAthlete("Tile Forger");
    const f = fixtureCard("Tile", "Forger");
    f.content.tiles[0] = { ...f.content.tiles[0], label: "Hire" };
    await expect(publishSnapshot(a, f)).rejects.toMatchObject({ code: "invalid" });
  });

  it("every media key needs its stored object, and the map holds nothing else; the reader serves one key of the live version", async () => {
    const a = await newAthlete("Mika Sorensen");
    const f = fixtureCard("Mika", "Sorensen");
    await expect(publishSnapshot(a, { ...f, media: {} })).rejects.toMatchObject({ code: "invalid" });
    await expect(publishSnapshot(a, { ...f, media: { ...f.media, m00000000000000000000: { path: "x", kind: "image" } } })).rejects.toMatchObject({ code: "invalid" });
    await publishSnapshot(a, f);
    const key = Object.keys(f.media)[0];
    expect(await mediaObject("mika-sorensen", key)).toEqual(f.media[key]);
    expect(await mediaObject("mika-sorensen", "m11111111111111111111")).toBeNull();
    expect(await mediaObject("mika-sorensen", "../../etc")).toBeNull();
    expect(await mediaObject("nobody-here", key)).toBeNull();
    // pulled media leaves the map too
    await publishRemoval(a, { itemKeys: ["media:x1"], reason: "That photo was deleted." });
    expect(await mediaObject("mika-sorensen", key)).toBeNull();
  });
});

describe("P7 the flag", () => {
  it("off: publish refused, reader 404; removals and unpublish still work", async () => {
    const a = await newAthlete("Yara Feld");
    const f = fixtureCard("Yara", "Feld");
    await publishSnapshot(a, f);
    process.env.PUBLIC_CARD = "false";
    await expect(publishSnapshot(a, f)).rejects.toMatchObject({ code: "disabled" });
    expect(await read("yara-feld")).toEqual({ status: "not_found" });
    expect(await publishRemoval(a, { itemKeys: ["pick:abc123"], reason: "Removed." })).toBe(2);
    expect(await unpublish(a)).toBe(true);
    process.env.PUBLIC_CARD = "TRUE";
    expect(await read("yara-feld")).toEqual({ status: "not_found" });
  });

  it("unknown and malformed handles get the same 404", async () => {
    expect(await read("nobody-here")).toEqual({ status: "not_found" });
    expect(await read("../etc")).toEqual({ status: "not_found" });
    expect(await read(undefined)).toEqual({ status: "not_found" });
  });
});

describe("P8 no contact details on the page", () => {
  const CONTACT = /@example\.com|555|example\.(com|net)|@quiet\.rower/;
  const dirty = (first: string, last: string) => {
    const f = fixtureCard(first, last);
    const hl = f.content.chapters[0].items;
    hl[0].text = "Open-water swimmer 🌊 💌: swim@example.com ig: quiet.rower";
    hl[1].text = "I race the clock. Call (555) 010-2030 or visit www.example.net";
    f.content.picks[0].blurb = "Never leaves my bag. @quiet.rower";
    return f;
  };

  it("a publish snapshot is frozen filtered, and its hash is the hash of what is stored", async () => {
    const a = await newAthlete("Imke Solberg");
    const f = dirty("Imke", "Solberg");
    const r = await publishSnapshot(a, f);
    const [row] = await db.select().from(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, a));
    expect(JSON.stringify(row.content)).not.toMatch(CONTACT);
    const hl = (row.content as typeof f.content).chapters[0].items;
    expect(hl[0].text).toBe("Open-water swimmer 🌊");
    expect(hl[1].text).toBe("I race the clock.");
    expect((row.content as typeof f.content).picks[0].blurb).toBe("Never leaves my bag.");
    expect(row.content_sha256).toBe(contentHash(row.content as typeof f.content));
    expect(r.contentSha256).toBe(row.content_sha256);
    expect(r.content).toEqual(row.content);
    // her follow link is not text: it stays exactly as connected
    expect((row.content as typeof f.content).socials).toEqual(f.content.socials);
  });

  it("an old snapshot with an email in it is filtered on read, under its own ETag; a line that was only an email leaves", async () => {
    const a = await newAthlete("Oskar Berglund");
    const clean = fixtureCard("Oskar", "Berglund");
    await publishSnapshot(a, clean);
    // A version frozen before the filter existed: written straight to the table, as the old code would have.
    const old = dirty("Oskar", "Berglund");
    old.content.chapters[1].items.push({ key: "partner:d2", kind: "partner", text: "deals@example.com", basis: "proof" });
    old.sources.items["partner:d2"] = [{ kind: "deal", id: "d2" }];
    const c = await card(a);
    await db.insert(publicCardSnapshots).values({
      athlete_id: a, version: 2, kind: "full", content: old.content, sources: old.sources, media: old.media,
      content_sha256: contentHash(old.content), published_at: T0,
    });
    await db.update(publicCards).set({ published_version: 2, last_version: 2 }).where(eq(publicCards.athlete_id, a));
    const got = await read(c.handle ?? "oskar-berglund");
    if (got.status !== "ok") throw new Error("not ok");
    expect(JSON.stringify(got.content)).not.toMatch(CONTACT);
    expect(got.content.chapters[0].items[0].text).toBe("Open-water swimmer 🌊");
    expect(got.content.chapters[1].items.map((i) => i.text)).toEqual(["Northwind Outfitters"]);
    expect(got.etag).not.toBe(etagOf(2, contentHash(old.content)));
    // a clean version is served exactly as stored, under its own ETag
    await db.update(publicCards).set({ published_version: 1 }).where(eq(publicCards.athlete_id, a));
    const v1 = await read(c.handle ?? "oskar-berglund");
    if (v1.status !== "ok") throw new Error("not ok");
    expect(v1.content).toEqual(clean.content);
    expect(v1.etag).toBe(etagOf(1, contentHash(clean.content)));
  });

  it("a removal or refresh over an old dirty version writes a clean one", async () => {
    const a = await newAthlete("Liv Haugen");
    await publishSnapshot(a, fixtureCard("Liv", "Haugen"));
    const old = dirty("Liv", "Haugen");
    await db.insert(publicCardSnapshots).values({
      athlete_id: a, version: 2, kind: "full", content: old.content, sources: old.sources, media: old.media,
      content_sha256: contentHash(old.content), published_at: T0,
    });
    await db.update(publicCards).set({ published_version: 2, last_version: 2 }).where(eq(publicCards.athlete_id, a));
    expect(await publishNumbersRefresh(a, { "hl.stat:instagram.followers": { value: 99, asOf: "2026-10-09" } })).toBe(3);
    const [row] = await db.select().from(publicCardSnapshots).where(eq(publicCardSnapshots.version, 3));
    expect(JSON.stringify(row.content)).not.toMatch(CONTACT);
  });
});
