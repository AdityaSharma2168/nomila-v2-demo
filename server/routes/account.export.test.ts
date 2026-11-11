/**
 * GET /api/v1/me/export — one JSON document from the manifest's export set (PGlite, no providers involved).
 *
 * Two athletes each get a row in every manifest table. Her export holds every exported table under its category,
 * and none of: his rows, any token, stored email text, a chat tool result's content, or shared brand research.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { dropCheckConstraints, seedAthleteEverywhere, sharedAtmospherePhoto, sharedBrand, type SeededAthlete } from "../testUtils/seedAthleteEverywhere";
import { ATHLETE_DATA_MANIFEST } from "../lib/athleteDataManifest";
import accountRouter from "./account";

let server: Server; let base: string;
let her: SeededAthlete; let him: SeededAthlete;

beforeAll(async () => {
  await initTestDb();
  await dropCheckConstraints();
  her = await seedAthleteEverywhere("Her");
  him = await seedAthleteEverywhere("Him");
  await db.execute(sql`UPDATE chat_messages SET role = 'tool', content = 'QUOTED-EMAIL-IN-TOOL-RESULT' WHERE athlete_id = ${her.athleteId}::uuid`);
  await db.execute(sql`UPDATE connected_accounts SET access_token = 'HER-ACCESS-TOKEN', refresh_token = 'HER-REFRESH-TOKEN' WHERE athlete_id = ${her.athleteId}::uuid`);
  await db.execute(sql`UPDATE inbox_threads SET subject = 'HER-EMAIL-SUBJECT' WHERE athlete_id = ${her.athleteId}::uuid`);
  await db.execute(sql`UPDATE inbox_senders SET email = 'sender@brand.example', name = 'A Sender' WHERE athlete_id = ${her.athleteId}::uuid`);
  const app = express();
  app.use(express.json());
  app.use("/", accountRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

const get = (athleteId: string) => { (globalThis as any).__TEST_ATHLETE_ID = athleteId; return fetch(`${base}/export`); };

describe("GET /export", () => {
  let doc: any; let text: string;
  beforeAll(async () => {
    const res = await get(her.athleteId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="nomila-data-\d{4}-\d{2}-\d{2}\.json"$/);
    text = await res.text();
    doc = JSON.parse(text);
  }, 60_000);

  it("is one document listing every exported manifest table under its category, with her one row each", () => {
    expect(doc).toMatchObject({ format: "nomila.athlete-data-export", version: 1, athlete_id: her.athleteId });
    for (const e of ATHLETE_DATA_MANIFEST) {
      if (e.export.mode === "none") continue;
      const t = doc.categories[e.category].tables[e.name];
      expect([e.name, t?.count]).toEqual([e.name, 1]);
    }
    expect(doc.categories.account.tables.athletes.rows[0].id).toBe(her.athleteId);
    expect(doc.not_included.map((n: any) => n.what)).toContain("Your email and DM text");
  });

  it("contains nothing of the other athlete's", () => {
    expect(text).not.toContain(him.athleteId);
    for (const [table, row] of him.rows) {
      if (typeof row.id === "string") expect([table, text.includes(row.id)]).toEqual([table, false]);
    }
  });

  it("contains no token, stored email text, sender identity or tool-result content", () => {
    for (const secret of ["HER-ACCESS-TOKEN", "HER-REFRESH-TOKEN", "STORED-EMAIL-BODY", "STORED-EMAIL-SUBJECT", "HER-EMAIL-SUBJECT",
      "sender@brand.example", "A Sender", "QUOTED-EMAIL-IN-TOOL-RESULT"]) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
    const recipientToken = her.rows.get("card_shares")!.recipient_token;
    if (typeof recipientToken === "string") expect(text).not.toContain(recipientToken);
    const conn = doc.categories.connections.tables.connected_accounts.rows[0];
    expect(conn).not.toHaveProperty("access_token");
    expect(conn).not.toHaveProperty("refresh_token");
    const msg = doc.categories.inbox.tables.inbox_messages;
    expect(msg.mode).toBe("references");
    expect(Object.keys(msg.rows[0])).not.toEqual(expect.arrayContaining(["body"]));
    expect(doc.categories.chats.tables.chat_messages.rows[0]).toMatchObject({ content: null, content_omitted: expect.any(String) });
  });

  it("references the shared brand by id but does not export brand research", async () => {
    const brandId = await sharedBrand();
    expect(text).toContain(`"brand_id":${JSON.stringify(brandId)}`); // her deals point at it
    for (const c of Object.values<any>(doc.categories)) expect(Object.keys(c.tables)).not.toContain("inbox_brands");
  });

  it("exports her atmosphere placements but not the shared atmosphere library", async () => {
    const photoId = await sharedAtmospherePhoto();
    expect(text).toContain(`"library_id":${JSON.stringify(photoId)}`); // her placement points at it
    for (const c of Object.values<any>(doc.categories)) expect(Object.keys(c.tables)).not.toContain("atmosphere_library");
  });

  it("404s for an athlete that does not exist", async () => {
    expect((await get(randomUUID())).status).toBe(404);
  });
});
