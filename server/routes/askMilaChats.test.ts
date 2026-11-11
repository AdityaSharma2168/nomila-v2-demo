/**
 * askMilaChats.test.ts — "Chats on your card" (/api/v1/me/public-card/chats) through Express against PGlite.
 *
 *   C1 she lists her chats (newest first, empty chats left out) and reads one: what the visitor typed and what Mila
 *      showed, with the chapter and card; no visitor identity anywhere in the response
 *   C2 tenancy: another athlete's chat is a 404 to read and to delete, and never appears in her list
 *   C3 she deletes a chat for good (turns go with it)
 *   C4 PUBLIC_CARD off → the routes do not exist; no token → 401
 *   C5 retention: chats older than 90 days are purged
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) return res.status(401).json({ error: "Missing or malformed Authorization header" });
    req.athleteId = id;
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { askMilaSessions, askMilaTurns } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { appendTurn, purgeExpired, startSession, takeTurn } from "../services/askMila/store";
import router from "./askMilaChats";

let server: Server; let base: string;
beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", router);
  app.use((_req, res) => res.status(404).json({ error: "app 404" }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; });

const as = (athleteId: string | null) => { (globalThis as any).__TEST_ATHLETE_ID = athleteId; };
async function call(method: string, path: string) {
  const res = await fetch(`${base}/api/v1/me${path}`, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function chat(athleteId: string, lines: Array<[string, string]>, at = new Date()) {
  const s = await startSession({ athleteId, version: 1, intent: "ask", now: at });
  for (const [q, a] of lines) {
    const n = (await takeTurn(athleteId, s.id, at))!;
    await appendTurn(athleteId, s.id, n, { role: "visitor", text: q }, at);
    await appendTurn(athleteId, s.id, n, { role: "mila", text: a, chapter: "story", gate: "passed", widget: { type: "picks", ids: ["pick:abc123"] } }, at);
  }
  return s.id;
}

it("C1 lists her chats newest first and reads one, with no visitor identity", async () => {
  const me = await seedAthlete("Ari Mbeki");
  const older = await chat(me, [["How did Ari start?", "From Ari's Story card: …"]], new Date(Date.now() - 3_600_000));
  const newer = await chat(me, [["Who has Ari worked with?", "From Ari's Partnerships card: …"], ["Thanks", "You're welcome."]]);
  await startSession({ athleteId: me, version: 1, intent: "book", now: new Date() }); // opened, never typed in: not listed
  as(me);
  const list = await call("GET", "/public-card/chats");
  expect(list.status).toBe(200);
  expect(list.body.chats.map((c: any) => [c.id, c.turns, c.firstMessage])).toEqual([[newer, 2, "Who has Ari worked with?"], [older, 1, "How did Ari start?"]]);
  expect(list.body.next).toBeNull();
  // a chat quiet for more than 15 minutes shows as ended even before a next message would end it
  expect(list.body.chats.map((c: any) => c.status)).toEqual(["open", "ended"]);

  const one = await call("GET", `/public-card/chats/${newer}`);
  expect(one.body.chat.messages.map((m: any) => [m.from, m.text, m.chapter])).toEqual([
    ["visitor", "Who has Ari worked with?", null], ["mila", "From Ari's Partnerships card: …", "story"],
    ["visitor", "Thanks", null], ["mila", "You're welcome.", "story"],
  ]);
  expect(one.body.chat.messages[1].widget).toEqual({ type: "picks", ids: ["pick:abc123"] });
  const raw = JSON.stringify(one.body);
  expect(raw).not.toMatch(/"(token|token_sha256|tokenSha256|ip|userAgent|user_agent|visitorHash|visitor_hash|athlete_id|athleteId)"/);
});

it("C2 another athlete's chat is a 404 to read or delete, and never in her list", async () => {
  const me = await seedAthlete("Bea Novak");
  const other = await seedAthlete("Cal Haddad");
  const theirs = await chat(other, [["Private to Cal's card", "…"]]);
  as(me);
  expect((await call("GET", "/public-card/chats")).body.chats).toEqual([]);
  expect((await call("GET", `/public-card/chats/${theirs}`)).status).toBe(404);
  expect((await call("DELETE", `/public-card/chats/${theirs}`)).status).toBe(404);
  expect((await call("GET", "/public-card/chats/not-a-uuid")).status).toBe(404);
  expect(await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, theirs))).toHaveLength(1);
});

it("C3 she deletes a chat for good", async () => {
  const me = await seedAthlete("Dee Laurent");
  const id = await chat(me, [["hi", "hello"]]);
  as(me);
  expect((await call("DELETE", `/public-card/chats/${id}`)).status).toBe(204);
  expect(await db.select().from(askMilaTurns).where(eq(askMilaTurns.session_id, id))).toEqual([]);
  expect((await call("GET", `/public-card/chats/${id}`)).status).toBe(404);
});

it("C4 PUBLIC_CARD off → no route; no token → 401", async () => {
  const me = await seedAthlete("Eli Strand");
  as(me);
  process.env.PUBLIC_CARD = "false";
  expect(await call("GET", "/public-card/chats")).toEqual({ status: 404, body: { error: "app 404" } });
  process.env.PUBLIC_CARD = "true";
  as(null);
  expect((await call("GET", "/public-card/chats")).status).toBe(401);
});

it("C5 chats older than 90 days are purged; newer ones stay", async () => {
  const me = await seedAthlete("Fen Oduya");
  const old = await chat(me, [["old", "old"]], new Date(Date.now() - 91 * 86_400_000));
  const recent = await chat(me, [["new", "new"]], new Date(Date.now() - 89 * 86_400_000));
  await purgeExpired(new Date());
  expect(await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, old))).toEqual([]);
  expect(await db.select().from(askMilaTurns).where(eq(askMilaTurns.session_id, old))).toEqual([]);
  expect(await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, recent))).toHaveLength(1);
});
