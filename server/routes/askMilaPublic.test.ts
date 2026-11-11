/**
 * askMilaPublic.test.ts — POST /p/:handle/ask (+ the booking / partner taps) through Express against PGlite
 * (design-public-card-v3 §4, PR 5). The model is MOCKED (server/mila/gemini): nothing reaches a provider. Made-up
 * athletes; their cards are published with the real publish service and read with the real public reader.
 *
 *   P1 flags: PUBLIC_CARD and ASK_MILA_PUBLIC both needed (exactly "true"), else the route does not exist
 *   P2 CSRF for a cookieless page: JSON only, the X-Nomila-Ask header, same-site Origin / Sec-Fetch-Site
 *   P3 a turn: public mode (replaced allowlist, PUBLIC_MODE prompt, visitor text wrapped), cited chapter, persisted to
 *      ask_mila_* (never chat_messages), spend counted; the second turn continues the same chat with its history
 *   P4 tenancy: a chat id + token from one athlete's card never opens, reads or continues on another's
 *   P5 input: 300 characters, empty, unknown handle, Ask Mila off in the published version
 *   P6 limits: 20 turns a chat, 15 idle minutes, 30 a visitor a day, 400 an athlete a day, the spend cap (+ kill switch)
 *   P7 the output gate on the wire: a blocked answer is never shown or stored; a model failure gives the fallback
 *   P8 published slots through the bookings port, and the taps: 404 until wired; with doubles, only her offers, her
 *      chat's token, a same-site next URL
 */
process.env.PUBLIC_CARD = "true";
process.env.ASK_MILA_PUBLIC = "true";
process.env.SESSION_SECRET = "test-ask-mila-secret";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../mila/gemini", () => ({ streamMilaModel: jest.fn() }));
jest.mock("../lib/rateLimit", () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { askMilaLimiter: pass, publicCardLimiter: pass };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  askMilaAthleteDays, askMilaSessions, askMilaSpendDays, askMilaTurns, askMilaVisitorDays, chatMessages, publicCards,
} from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { ensureCard, publishSnapshot } from "../services/publicCard/publish";
import { ALL_SWITCHES_ON, fixtureCard } from "../testUtils/publicCardFixtures";
import { callChunk, fakeBookings, fakePartner, scriptRounds, textChunk } from "../testUtils/askMila";
import { streamMilaModel } from "../mila/gemini";
import { createAskMilaPublicRouter } from "./askMilaPublic";
import { PUBLIC_TOOL_ALLOWLIST } from "../mila/public/tools";
import { _resetPurgeClock } from "../services/askMila/store";

const model = streamMilaModel as jest.Mock;

let wired: { server: Server; base: string };
let bare: { server: Server; base: string };
let bookings = fakeBookings({});
let partner = fakePartner();

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  await initTestDb();
  const a = express();
  a.use(express.json());
  // the ports are read through these indirections so a test can swap the doubles
  a.use(createAskMilaPublicRouter({
    bookings: { bookable: (id) => bookings.bookable(id), listOpenSlots: (q) => bookings.listOpenSlots(q), createPendingRequest: (r) => bookings.createPendingRequest(r) },
    partner: { begin: (r) => partner.begin(r) },
  }));
  a.use((_req, res) => res.status(404).json({ error: "app 404" }));
  wired = await listen(a);
  const b = express();
  b.use(express.json());
  b.use(createAskMilaPublicRouter());
  b.use((_req, res) => res.status(404).json({ error: "app 404" }));
  bare = await listen(b);
});
afterAll(async () => { wired.server.close(); bare.server.close(); await closeTestDb(); });
beforeEach(() => {
  process.env.PUBLIC_CARD = "true";
  process.env.ASK_MILA_PUBLIC = "true";
  delete process.env.ASK_MILA_VISITOR_DAILY_TURNS;
  delete process.env.ASK_MILA_ATHLETE_DAILY_TURNS;
  delete process.env.ASK_MILA_DAILY_SPEND_CAP_USD;
  model.mockReset();
  bookings = fakeBookings({});
  partner = fakePartner();
  _resetPurgeClock();
});

const JSON_HEADERS = { "Content-Type": "application/json", "X-Nomila-Ask": "1" };
async function post(path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS, base = wired.base) {
  const res = await fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

let seq = 0;
/** A made-up athlete with a published card. Handles are made from the name by the real publish service. */
async function athlete(first: string, last: string, mutate?: (c: ReturnType<typeof fixtureCard>) => void) {
  const id = await seedAthlete(`${first} ${last}`);
  await ensureCard(id);
  await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, id));
  const card = fixtureCard(first, last);
  mutate?.(card);
  await publishSnapshot(id, card);
  const [row] = await db.select({ handle: publicCards.handle }).from(publicCards).where(eq(publicCards.athlete_id, id));
  seq++;
  return { id, handle: row.handle!, card };
}

const answer = (text: string) => scriptRounds(model, [textChunk(text)]);
const turns = (sessionId: string) => db.select().from(askMilaTurns).where(eq(askMilaTurns.session_id, sessionId)).orderBy(askMilaTurns.seq);

describe("P1 flags", () => {
  it("both flags on → the route exists; either off, or anything but \"true\" → falls through to the app 404", async () => {
    const a = await athlete("Iko", "Varga");
    answer("Hello from Mila.");
    expect((await post(`/p/${a.handle}/ask`, { text: "hi" })).status).toBe(200);
    for (const [k, v] of [["ASK_MILA_PUBLIC", "false"], ["ASK_MILA_PUBLIC", "1"], ["PUBLIC_CARD", "false"]] as const) {
      process.env.PUBLIC_CARD = "true"; process.env.ASK_MILA_PUBLIC = "true";
      process.env[k] = v;
      const r = await post(`/p/${a.handle}/ask`, { text: "hi" });
      expect({ k, v, status: r.status, body: r.body }).toEqual({ k, v, status: 404, body: { error: "app 404" } });
    }
    for (const p of ["/ask/booking", "/ask/partner"]) {
      process.env.ASK_MILA_PUBLIC = "false";
      expect((await post(`/p/${a.handle}${p}`, {})).body).toEqual({ error: "app 404" });
    }
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("P2 CSRF on a cookieless page", () => {
  it("refuses non-JSON, a missing header, a cross-site Origin or Sec-Fetch-Site; accepts this site", async () => {
    const a = await athlete("Rue", "Adeyemi");
    const path = `/p/${a.handle}/ask`;
    expect((await post(path, "text=hi", { "Content-Type": "application/x-www-form-urlencoded", "X-Nomila-Ask": "1" })).status).toBe(415);
    expect((await post(path, "hi", { "Content-Type": "text/plain", "X-Nomila-Ask": "1" })).status).toBe(415);
    expect((await post(path, { text: "hi" }, { "Content-Type": "application/json" })).status).toBe(403);
    expect((await post(path, { text: "hi" }, { ...JSON_HEADERS, Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(path, { text: "hi" }, { ...JSON_HEADERS, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(model).not.toHaveBeenCalled();
    answer("Hello.");
    const ok = await post(path, { text: "hi" }, { ...JSON_HEADERS, Origin: wired.base, "Sec-Fetch-Site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    // the taps carry the same guard
    expect((await post(`/p/${a.handle}/ask/booking`, { offerId: "offer:o1" }, { "Content-Type": "application/json" })).status).toBe(403);
    expect((await post(`/p/${a.handle}/ask/partner`, { kind: "press" }, { ...JSON_HEADERS, Origin: "https://elsewhere.example" })).status).toBe(403);
  });
});

describe("P3 a turn in public mode", () => {
  it("answers from the published card with the replaced allowlist, cites the chapter, persists to ask_mila_* only", async () => {
    const a = await athlete("Tavi", "Okonkwo-Lind");
    scriptRounds(model,
      [callChunk("read_card", { chapter: "partnerships" })],
      [textChunk("From Tavi's Partnerships card: Tavi has worked with Northwind Outfitters since March.")],
    );
    const r = await post(`/p/${a.handle}/ask`, { text: "Who has Tavi worked with?", intent: "ask", tz: "America/Chicago" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      sessionId: expect.any(String), token: expect.any(String), limited: null, ended: false,
      reply: { text: "From Tavi's Partnerships card: Tavi has worked with Northwind Outfitters since March.", chapterId: "partnerships", widget: null },
    });

    // what the model was given: ONLY allowlisted tools, the PUBLIC_MODE prompt, the visitor's text as external content
    const [contents, declarations, , systemPrompt] = model.mock.calls[0];
    const names = (declarations as Array<{ name: string }>).map((d) => d.name);
    expect(names.every((n) => (PUBLIC_TOOL_ALLOWLIST as readonly string[]).includes(n))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["read_card", "show_picks", "list_published_slots", "request_booking", "start_partner_request"]));
    expect(names).not.toEqual(expect.arrayContaining(["get_rate_card"]));
    expect(systemPrompt).toContain("PUBLIC_MODE (public-mode/1)");
    expect(systemPrompt).toContain("You are Mila, Nomila's assistant, answering on Tavi's public card");
    // (the loop appends the tool rounds to the same array after this call: the visitor's message is its first entry)
    expect((contents as any[])[0].parts[0].text).toBe('<external_content source="visitor">\nWho has Tavi worked with?\n</external_content>');
    // the tool round got the snapshot's partnerships chapter, nothing else
    const toolTurn = (model.mock.calls[1][0] as any[]).at(-1);
    expect(toolTurn.parts[0].functionResponse.response.output).toEqual({
      chapter: "partnerships", title: "Partnerships", lines: [{ kind: "partner", text: "Northwind Outfitters", since: "2026-03" }],
    });

    const [s] = await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, r.body.sessionId));
    expect(s).toMatchObject({ athlete_id: a.id, snapshot_version: 1, intent: "ask", turn_count: 1, status: "open" });
    expect(s.token_sha256).not.toContain(r.body.token);
    expect((await turns(s.id)).map((t) => ({ seq: t.seq, role: t.role, text: t.text, chapter: t.chapter, gate: t.gate }))).toEqual([
      { seq: 1, role: "visitor", text: "Who has Tavi worked with?", chapter: null, gate: null },
      { seq: 2, role: "mila", text: "From Tavi's Partnerships card: Tavi has worked with Northwind Outfitters since March.", chapter: "partnerships", gate: "passed" },
    ]);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, a.id))).toEqual([]);
    const [spend] = await db.select().from(askMilaSpendDays);
    expect(spend.turns).toBeGreaterThanOrEqual(1);
    expect(spend.micro_usd).toBeGreaterThan(0);

    // the next turn continues the SAME chat, with its history replayed (visitor turns still wrapped)
    answer("That's not on Tavi's card. You can send Tavi a request through Partner.");
    const r2 = await post(`/p/${a.handle}/ask`, { text: "Where does Tavi live?", sessionId: r.body.sessionId, token: r.body.token });
    expect(r2.body.sessionId).toBe(r.body.sessionId);
    const contents2 = model.mock.calls[2][0] as any[];
    expect(contents2.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents2[0].parts[0].text).toContain("<external_content source=\"visitor\">\nWho has Tavi worked with?");
    expect((await turns(s.id)).map((t) => t.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("P4 tenancy", () => {
  it("a chat from one athlete's card never opens, continues or reads on another's", async () => {
    const a = await athlete("Noor", "Lindqvist");
    const b = await athlete("Pax", "Moreau");
    answer("Noor has a Partnerships card.");
    const ra = await post(`/p/${a.handle}/ask`, { text: "Secret question for Noor" });
    answer("Hello from Pax's card.");
    const rb = await post(`/p/${b.handle}/ask`, { text: "hi", sessionId: ra.body.sessionId, token: ra.body.token });
    expect(rb.status).toBe(200);
    expect(rb.body.sessionId).not.toBe(ra.body.sessionId);         // a NEW chat, on Pax's card
    const contents = model.mock.calls[1][0] as any[];
    expect(JSON.stringify(contents)).not.toContain("Secret question");  // nothing of Noor's chat reached the model
    expect(model.mock.calls[1][3]).toContain("Pax's public card");
    expect(model.mock.calls[1][3]).not.toContain("Noor");
    const [sb] = await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, rb.body.sessionId));
    expect(sb.athlete_id).toBe(b.id);
    expect((await turns(ra.body.sessionId)).length).toBe(2);         // Noor's chat untouched

    // a wrong token on her own card is also a new chat, never the old one
    answer("Hello again.");
    const forged = await post(`/p/${a.handle}/ask`, { text: "hi", sessionId: ra.body.sessionId, token: "x".repeat(32) });
    expect(forged.body.sessionId).not.toBe(ra.body.sessionId);
    // read_card answers from THIS card only: Pax's tool round shows Pax's name, never Noor's
    scriptRounds(model, [callChunk("read_card", {})], [textChunk("This is Pax's card.")]);
    const rc = await post(`/p/${b.handle}/ask`, { text: "Who is this?" });
    expect(rc.status).toBe(200);
    const out = (model.mock.calls.at(-1)![0] as any[]).at(-1).parts[0].functionResponse.response.output;
    expect(out.firstName).toBe("Pax");
    expect(JSON.stringify(out)).not.toContain("Noor");
  });
});

describe("P5 input", () => {
  it("300 characters at most; empty is refused; unknown handle and Ask Mila off → 404", async () => {
    const a = await athlete("Juno", "Abara");
    expect((await post(`/p/${a.handle}/ask`, { text: "x".repeat(301) })).body).toEqual({ error: "Keep it to 300 characters or fewer." });
    expect((await post(`/p/${a.handle}/ask`, { text: "   " })).status).toBe(400);
    expect((await post(`/p/${a.handle}/ask`, { nope: true })).status).toBe(400);
    expect((await post(`/p/nobody-here/ask`, { text: "hi" })).status).toBe(404);
    expect((await post(`/p/Bad.Handle/ask`, { text: "hi" })).status).toBe(404);
    const off = await athlete("Kit", "Osei", (c) => { c.content.doors.ask_mila = false; });
    await db.update(publicCards).set({ door_ask_mila: false }).where(eq(publicCards.athlete_id, off.id));
    expect((await post(`/p/${off.handle}/ask`, { text: "hi" })).status).toBe(404);
    expect(model).not.toHaveBeenCalled();
    answer("Fine.");
    expect((await post(`/p/${a.handle}/ask`, { text: "x".repeat(300) })).status).toBe(200);
  });
});

describe("P6 limits", () => {
  it("20 turns a chat: the next message ends it without a model call", async () => {
    const a = await athlete("Lio", "Brandt");
    answer("Hi.");
    const r = await post(`/p/${a.handle}/ask`, { text: "hi" });
    await db.update(askMilaSessions).set({ turn_count: 20 }).where(eq(askMilaSessions.id, r.body.sessionId));
    const capped = await post(`/p/${a.handle}/ask`, { text: "one more", sessionId: r.body.sessionId, token: r.body.token });
    expect(capped.body).toMatchObject({ limited: "turn_limit", ended: true, sessionId: null, reply: { text: "This chat has reached its limit. You can still send Lio a request through Partner." } });
    expect(model).toHaveBeenCalledTimes(1);
    const [s] = await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, r.body.sessionId));
    expect(s).toMatchObject({ status: "ended", ended_reason: "turn_limit" });
  });

  it("15 idle minutes end a chat; the next message starts a new one", async () => {
    const a = await athlete("Mae", "Fontaine");
    answer("Hi.");
    const r = await post(`/p/${a.handle}/ask`, { text: "hi" });
    await db.update(askMilaSessions).set({ last_turn_at: new Date(Date.now() - 16 * 60_000) }).where(eq(askMilaSessions.id, r.body.sessionId));
    answer("Hi again.");
    const r2 = await post(`/p/${a.handle}/ask`, { text: "back", sessionId: r.body.sessionId, token: r.body.token });
    expect(r2.body.sessionId).not.toBe(r.body.sessionId);
    const [old] = await db.select().from(askMilaSessions).where(eq(askMilaSessions.id, r.body.sessionId));
    expect(old).toMatchObject({ status: "ended", ended_reason: "idle" });
    // 14 minutes is not idle
    await db.update(askMilaSessions).set({ last_turn_at: new Date(Date.now() - 14 * 60_000) }).where(eq(askMilaSessions.id, r2.body.sessionId));
    answer("Still here.");
    expect((await post(`/p/${a.handle}/ask`, { text: "x", sessionId: r2.body.sessionId, token: r2.body.token })).body.sessionId).toBe(r2.body.sessionId);
  });

  it("per visitor a day (daily-salted IP hash): over the cap → the limit line, nothing counted or called", async () => {
    await db.delete(askMilaVisitorDays);
    process.env.ASK_MILA_VISITOR_DAILY_TURNS = "2";
    const a = await athlete("Ode", "Hartmann");
    const b = await athlete("Pim", "Sorensen");
    answer("One."); answer("Two.");
    expect((await post(`/p/${a.handle}/ask`, { text: "1" })).body.limited).toBeNull();
    expect((await post(`/p/${b.handle}/ask`, { text: "2" })).body.limited).toBeNull(); // every card counts toward it
    const r = await post(`/p/${a.handle}/ask`, { text: "3" });
    expect(r.body).toMatchObject({ limited: "visitor", reply: { text: "That's today's limit for chatting with Mila. You can still send Ode a request through Partner." } });
    expect(model).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(askMilaVisitorDays);
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(2);
    expect(rows[0].visitor_hash).not.toContain("127.0.0.1");
  });

  it("per athlete a day: over the cap → the limit line; the visitor's count rolls back with it", async () => {
    await db.delete(askMilaVisitorDays);
    process.env.ASK_MILA_ATHLETE_DAILY_TURNS = "1";
    const a = await athlete("Quin", "Delacroix");
    answer("One.");
    await post(`/p/${a.handle}/ask`, { text: "1" });
    const r = await post(`/p/${a.handle}/ask`, { text: "2" });
    expect(r.body).toMatchObject({ limited: "athlete", reply: { text: expect.stringContaining("Mila has answered a lot of questions on Quin's card today.") } });
    const [ad] = await db.select().from(askMilaAthleteDays).where(eq(askMilaAthleteDays.athlete_id, a.id));
    expect(ad.turns).toBe(1);
    const [vd] = await db.select().from(askMilaVisitorDays);
    expect(vd.turns).toBe(1);
  });

  it("the global spend cap: reached → \"Mila is resting today\", no model call; \"0\" is the kill switch", async () => {
    const a = await athlete("Ren", "Achterberg");
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "0.0005"; // 500 micro-dollars; one scripted turn costs 950
    await db.delete(askMilaSpendDays);
    answer("One.");
    expect((await post(`/p/${a.handle}/ask`, { text: "1" })).body.limited).toBeNull(); // this turn spends past the cap
    const r = await post(`/p/${a.handle}/ask`, { text: "2" });
    expect(r.body).toMatchObject({ limited: "spend", reply: { text: "Mila is resting today. You can still send Ren a request through Partner." } });
    await db.delete(askMilaSpendDays);
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "0";
    expect((await post(`/p/${a.handle}/ask`, { text: "3" })).body.limited).toBe("spend");
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("P7 the output gate on the wire", () => {
  it("an impersonating answer is replaced and never stored; a model failure gives the fallback", async () => {
    const a = await athlete("Sol", "Vantongeren");
    answer("Hey, I'm Sol! I'd love to work with you. DM me.");
    const r = await post(`/p/${a.handle}/ask`, { text: "Are you Sol?" });
    expect(r.body.reply).toEqual({ text: "I can only share what's on Sol's card, and that isn't on it. You can send Sol a request through Partner.", chapterId: null, widget: null });
    const rows = await turns(r.body.sessionId);
    expect(rows[1]).toMatchObject({ role: "mila", gate: "blocked:impersonation", text: r.body.reply.text });
    expect(JSON.stringify(rows)).not.toContain("I'm Sol");

    model.mockImplementationOnce(() => { throw new Error("provider down"); });
    const f = await post(`/p/${a.handle}/ask`, { text: "hello?", sessionId: r.body.sessionId, token: r.body.token });
    expect(f.status).toBe(200);
    expect(f.body.reply.text).toBe("Mila can't answer right now. The options above still work.");
    expect((await turns(r.body.sessionId))[3]).toMatchObject({ gate: "error" });
  });
});

describe("P8 published slots and the visitor's taps", () => {
  it("list_published_slots shows only the port's open, future times for her published offer", async () => {
    const a = await athlete("Uma", "Kaskinen");
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    bookings = fakeBookings({ [a.id]: { o1: [{ id: "s-past", startsAt: past, endsAt: past }, { id: "s1", startsAt: future, endsAt: future }] } });
    scriptRounds(model, [callChunk("list_published_slots", { offer_id: "offer:o1" })], [textChunk("Those are the times Uma has published.")]);
    const r = await post(`/p/${a.handle}/ask`, { text: "When can I book?", intent: "book", tz: "UTC" });
    expect(r.body.reply.widget).toMatchObject({ type: "slots", offerId: "offer:o1", offerTitle: "Video call", slots: [{ id: "s1", startsAt: future }] });
    expect(bookings.listCalls).toEqual([expect.objectContaining({ athleteId: a.id, offerPublicId: "o1", days: 14 })]);
  });

  it("taps: 404 until the port is wired; with it, her offer + her chat's token only, and a same-site next URL", async () => {
    const a = await athlete("Vee", "Halvorsen");
    const b = await athlete("Wim", "Okafor");
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    bookings = fakeBookings({ [a.id]: { o1: [{ id: "s1", startsAt: future, endsAt: future }] } });
    answer("Hi."); answer("Hi.");
    const ca = await post(`/p/${a.handle}/ask`, { text: "hi" });
    const cb = await post(`/p/${b.handle}/ask`, { text: "hi" });

    // unwired (the default server) → the taps do not exist
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:o1", slotId: "s1" }, JSON_HEADERS, bare.base)).status).toBe(404);
    expect((await post(`/p/${a.handle}/ask/partner`, { sessionId: ca.body.sessionId, token: ca.body.token, kind: "press" }, JSON_HEADERS, bare.base)).status).toBe(404);

    const ok = await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:o1", slotId: "s1", note: "First session" });
    expect(ok).toMatchObject({ status: 200, body: { nextUrl: "/r/verify-example", ref: "NB-0001" } });
    expect(bookings.requestCalls).toEqual([{ athleteId: a.id, offerPublicId: "o1", slotId: "s1", times: null, note: "First session", askMilaSessionId: ca.body.sessionId }]);

    // another athlete's chat, a wrong token, an offer not on her card, both or neither of slot/times
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: cb.body.sessionId, token: cb.body.token, offerId: "offer:o1", slotId: "s1" })).status).toBe(404);
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: "y".repeat(32), offerId: "offer:o1", slotId: "s1" })).status).toBe(404);
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:zz", slotId: "s1" })).status).toBe(400);
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:o1" })).status).toBe(400);
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:o1", slotId: "gone" })).body).toMatchObject({ reason: "slot_taken" });
    expect(bookings.requestCalls).toHaveLength(2); // only the valid tap and the taken slot reached the port

    // a port answering an off-site next URL is refused
    bookings = fakeBookings({ [a.id]: { o1: [{ id: "s1", startsAt: future, endsAt: future }] } }, { nextUrl: "https://elsewhere.example/x" });
    expect((await post(`/p/${a.handle}/ask/booking`, { sessionId: ca.body.sessionId, token: ca.body.token, offerId: "offer:o1", slotId: "s1" })).status).toBe(409);

    const p = await post(`/p/${a.handle}/ask/partner`, { sessionId: ca.body.sessionId, token: ca.body.token, kind: "sponsorship" });
    expect(p).toMatchObject({ status: 200, body: { nextUrl: "/r/brief-example" } });
    expect(partner.calls).toEqual([{ athleteId: a.id, handle: a.handle, kind: "sponsorship", askMilaSessionId: ca.body.sessionId }]);
    expect((await post(`/p/${a.handle}/ask/partner`, { sessionId: ca.body.sessionId, token: ca.body.token, kind: "rates" })).status).toBe(400);
    // a "What kind of request?" chip tapped before anything was typed: no chat to attach; a named chat must be valid
    expect((await post(`/p/${a.handle}/ask/partner`, { kind: "press" })).status).toBe(200);
    expect(partner.calls[1]).toEqual({ athleteId: a.id, handle: a.handle, kind: "press", askMilaSessionId: null });
    expect((await post(`/p/${a.handle}/ask/partner`, { sessionId: ca.body.sessionId, kind: "press" })).status).toBe(404);
    expect((await post(`/p/${b.handle}/ask/partner`, { sessionId: ca.body.sessionId, token: ca.body.token, kind: "press" })).status).toBe(404);
    expect(partner.calls).toHaveLength(2);
  });

  it("bookings off for this athlete: Mila is not given the booking tools, and the booking tap is a 404", async () => {
    const a = await athlete("Yan", "Ostrowski");
    bookings = fakeBookings({ [a.id]: { o1: [] } }, { bookable: false });
    answer("Hi.");
    const r = await post(`/p/${a.handle}/ask`, { text: "Can I book?", intent: "book" });
    const names = (model.mock.calls[0][1] as Array<{ name: string }>).map((d) => d.name);
    expect(names).not.toContain("request_booking");
    expect(names).not.toContain("list_published_slots");
    const tap = await post(`/p/${a.handle}/ask/booking`, { sessionId: r.body.sessionId, token: r.body.token, offerId: "offer:o1", times: [new Date(Date.now() + 3 * 86_400_000).toISOString()] });
    expect(tap.status).toBe(404);
    expect(bookings.requestCalls).toEqual([]);
  });

  it("request_booking only PREPARES a card: nothing reaches the port until the visitor taps", async () => {
    const a = await athlete("Xan", "Petrov");
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    bookings = fakeBookings({ [a.id]: { o1: [{ id: "s9", startsAt: future, endsAt: future }] } });
    scriptRounds(model, [callChunk("request_booking", { offer_id: "offer:o1", slot_id: "s9" })], [textChunk("Tap the card to send the request.")]);
    const r = await post(`/p/${a.handle}/ask`, { text: "Book that one", intent: "book", tz: "UTC" });
    expect(r.body.reply.widget).toMatchObject({ type: "booking_request", offerId: "offer:o1", slotId: "s9", price: "$177.96" });
    expect(bookings.requestCalls).toEqual([]);
    const rows = await db.select().from(askMilaTurns).where(and(eq(askMilaTurns.session_id, r.body.sessionId), eq(askMilaTurns.role, "mila")));
    expect(rows[0].widget).toMatchObject({ type: "booking_request", slotId: "s9" });
  });
});
