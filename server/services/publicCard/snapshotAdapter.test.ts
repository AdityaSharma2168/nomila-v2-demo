/**
 * snapshotAdapter.test.ts — the thin adapter from a published snapshot (read through publicCardReader) to
 * PublicCardView, end to end through the real page router against PGlite. Made-up athletes in different sports;
 * nothing reaches a provider or the network.
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/rateLimit", () => ({ publicCardLimiter: (_req: any, _res: any, next: any) => next() }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { publicCards } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { ALL_SWITCHES_ON, fixtureCard } from "../../testUtils/publicCardFixtures";
import { createPublicPageRouter } from "../../routes/publicPage";
import { setHandle } from "./handles";
import { ensureCard, publishRemoval, publishSnapshot, unpublish } from "./publish";
import { read } from "./publicCardReader";
import { compactNumber, loadView, toView } from "./snapshotAdapter";
import { tilesFor } from "./types";

async function published(name: string, first: string, last: string) {
  const id = await seedAthlete(name);
  await ensureCard(id);
  await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, id));
  const f = fixtureCard(first, last);
  await publishSnapshot(id, f);
  return { id, f };
}

let server: Server; let base: string;
beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(createPublicPageRouter({ loadView }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; });

describe("snapshot → PublicCardView adapter", () => {
  it("maps one published snapshot to a PublicCardView: handle, version, publishedAt, indexable, athlete, chapters in her order", async () => {
    const { f } = await published("Ines Kaur-Lindahl", "Ines", "Kaur-Lindahl");
    const v = (await loadView("ines-kaur-lindahl"))!;
    expect(v).toMatchObject({ handle: "ines-kaur-lindahl", version: 1, indexable: false, publishedAt: expect.any(String) });
    // Highlights opens on her own first published image (DESIGN.md §9: the card is about her), through the media proxy.
    expect(v.hero).toEqual({ kind: "image", src: expect.stringMatching(/^\/p\/ines-kaur-lindahl\/m\//), alt: "" });
    expect(v.athlete).toEqual({ firstName: "Ines", lastName: "Kaur-Lindahl", identityLine: f.content.chapters[0].items[0].text, quote: f.content.chapters[0].items[1].text, verified: true });
    expect(v.chapters.map((c) => [c.id, c.kind, c.title])).toEqual([["highlights", "highlights", "Highlights"], ["partnerships", "partnerships", "Partnerships"], ["media", "media", "Media"]]);
    expect(v.chapters[0].headline).toBe("Ines Kaur-Lindahl");
    expect(v.chapters[0].items).toEqual([{ type: "stat", label: "Instagram followers", value: "12.4K", asOf: "as of 1 Oct" }]);
    expect(v.chapters[1].items).toEqual([{ type: "partner", name: "Northwind Outfitters", since: "since Mar 2026" }]);
    expect(v.socials).toEqual(f.content.socials);
    expect(v.askChips).toEqual([{ label: "Who has Ines worked with?", chapterId: "partnerships" }]);
    expect(compactNumber(2_300_000)).toBe("2.3M");
    expect(compactNumber(950)).toBe("950");
  });

  it("copies the four tile slots resolved at publish (resolveTileSlots) and never recomputes them at read time", async () => {
    const { f } = await published("Oto Brennan", "Oto", "Brennan");
    const r = await read("oto-brennan");
    if (r.status !== "ok") throw new Error("not ok");
    expect(toView(r).tiles).toEqual(f.content.tiles);
    // a stored tile set that differs from what the resolver would give for these doors is still drawn exactly as stored
    const odd = { ...r, content: { ...r.content, tiles: tilesFor({ ...r.content, doors: { ...r.content.doors, book: false } }) } };
    expect(toView(odd).tiles).toEqual(odd.content.tiles);
    expect(toView(odd).tiles[1].intent).toBe("story");
  });

  it("rewrites every media key to the same-origin proxy /p/:handle/m/:key (never a bucket path)", async () => {
    const { f } = await published("Lark Mendes", "Lark", "Mendes");
    const v = (await loadView("lark-mendes"))!;
    const key = Object.keys(f.media)[0];
    expect(v.chapters[2].items).toEqual([{ type: "media", media: { kind: "image", src: `/p/lark-mendes/m/${key}`, alt: "" } }]);
    expect(JSON.stringify(v)).not.toMatch(/athletes\/|storage\.googleapis|gs:\/\//);
  });

  it("offers carry the quoted all-in total stored at publish; picks carry their opaque /go code and her words verbatim", async () => {
    await published("Remy Achterberg", "Remy", "Achterberg");
    const v = (await loadView("remy-achterberg"))!;
    expect(v.offers).toEqual([{ id: "offer:o1", title: "Video call", durationMin: 30, format: "virtual", allInMinor: 17796, currency: "USD", note: "Includes the Nomila service fee" }]);
    expect(v.picks).toEqual([{ id: "pick:abc123", title: "Trail bottle", merchant: "Example Store", herWords: "Never leaves my bag.", goCode: "abc123" }]);
  });

  it("drops anything not in the published snapshot (drafts, removed chapters, unpublished offers)", async () => {
    const { id } = await published("Nell Szabo", "Nell", "Szabo");
    await db.update(publicCards).set({ draft: { chapters: { impact: { title: "Draft only" } } } }).where(eq(publicCards.athlete_id, id));
    await publishRemoval(id, { itemKeys: ["partner:d1"], closeDoors: ["book"], reason: "Pulled." });
    const v = (await loadView("nell-szabo"))!;
    expect(v.version).toBe(2);
    expect(v.chapters.map((c) => c.id)).toEqual(["highlights", "media"]);
    expect(v.offers).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/Draft only|Northwind/);
  });

  it("an unknown, unpublished or removed handle maps to null (the same 404)", async () => {
    const { id } = await published("Ivo Halloran", "Ivo", "Halloran");
    expect(await loadView("nobody-at-all")).toBeNull();
    await db.transaction((tx) => setHandle(tx as any, id, "ivo-h"));
    expect(await loadView("ivo-halloran")).toBeNull();   // an old handle is not a page (the JSON read redirects)
    expect(await loadView("ivo-h")).not.toBeNull();
    await unpublish(id);
    expect(await loadView("ivo-h")).toBeNull();
    process.env.PUBLIC_CARD = "false";
    expect(await loadView("ivo-h")).toBeNull();
  });

  it("wired as createPublicPageRouter({ loadView }) in server/index.ts, and the page renders only the snapshot", async () => {
    const src = readFileSync(join(__dirname, "..", "..", "index.ts"), "utf8");
    expect(src).toMatch(/createPublicPageRouter\(\{\s*loadView:\s*loadPublicCardView\b/);
    expect(src).toMatch(/import \{ loadView as loadPublicCardView \} from "\.\/services\/publicCard\/snapshotAdapter"/);

    await published("Pia Thorvald", "Pia", "Thorvald");
    const page = await fetch(`${base}/p/pia-thorvald`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Pia");
    expect(html).toContain("Northwind Outfitters");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await fetch(`${base}/p/nobody-at-all`)).status).toBe(404);
  });
});
