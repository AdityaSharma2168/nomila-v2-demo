/**
 * routes/partnerThreads.test.ts — the relay and the request thread, end to end against PGlite. Email (sendEmail), the
 * partner Gmail inbox, brand research and the fit model are replaced at their boundaries; nothing reaches a
 * provider.
 *
 *   T1 the status link alone shows steps only; messages need the email code; the code goes only to the address the
 *      request came from; a wrong code and an exhausted code fail; the check is a cookie on /r and /requests only
 *   T2 the visitor writes: clean → on her thread (platform nomila, inbound, clean), her move; held → body NULL (no
 *      other reader can show it), "being checked" to the sender only, invisible to her; blocked → never shown
 *   T3 her reply by her own tap (send_reply pending action → approve → relay): from Nomila, a content-free notice with
 *      the per-thread reply-to, "[First] replied" on the page; her held reply is not sent and she is told why
 *   T4 tenancy: her request endpoint and decisions are hers only; a visitor check for one address opens no other
 *      address's thread; one status token never shows another request
 *   T5 decline: deal rejected, the visitor told "[First] has passed on this one", the reply box gone; agree: accepted
 *   T6 "Your requests": email → code → the list of every request from that address, same answer for unknown addresses
 *   T7 inbound mail (the partner Workspace mailbox, polled): a reply to partners+<token>@ from the request's address
 *      lands on the thread with the quote stripped, and every looked-at message is labelled; mail not addressed to a
 *      reply address is labelled without its body ever being read; another sender, another domain, an unknown token are
 *      ignored; seeing a message again is a no-op; a held email reply is held; a failure leaves the message unlabelled
 *   T8 review: held messages listed for admins; release delivers (with the notice); block never does
 */
process.env.PUBLIC_CARD = "true";
process.env.PARTNER_INTAKE = "true";
process.env.PARTNER_TOKEN_SECRET = "test-partner-secret";
process.env.PUBLIC_BASE_URL = "https://public.example.test";
// sendTemplate only hands a notice to sendEmail when a provider is configured; sendEmail itself is mocked below.
process.env.EMAIL_PROVIDER = "gmail"; // sendEmail is mocked: nothing reaches Google
process.env.PARTNER_INBOUND_MAIL = "true";
process.env.PARTNER_INBOX_ADDRESS = "partners@inbox.example.test";
process.env.PARTNER_DRAFTS_PER_VISITOR_DAY = "100";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
  requireAdmin: (req: any, res: any, next: any) => ((globalThis as any).__TEST_ADMIN ? next() : res.status(403).json({ error: "forbidden" })),
}));
const sent: Array<{ to: string; subject: string; html: string; text?: string; replyTo?: string }> = [];
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async (m: any) => { sent.push(m); return { sent: false, skipped: true }; }) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));
jest.mock("../lib/safeFetch", () => ({ ...jest.requireActual("../lib/safeFetch"), safeFetch: jest.fn(async () => new Response("", { status: 404 })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { partnerApiRouter, partnerConfirmRouter } from "./partnerPublic";
import { partnerRequestsRouter, partnerStatusRouter } from "./partnerStatus";
import { partnerAthleteRouter } from "./partnerAthlete";
import { adminRelayRouter } from "./adminRelay";
import pendingActionsRouter from "./pendingActions";
import { deals, inboxMessages, inboxThreads, partnerRequests, partnerVisitorCodes } from "../../shared/schema";
import { bodySha256 } from "../../shared/bodyHash";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { setPublishedCardSource } from "../services/partner/publishedCard";
import { cardFor, fixedCardSource } from "../testUtils/publishedCardDouble";
import { pollPartnerInbox, setPartnerInbox, envelopeOf, type PartnerInbox, type ReceivedEmail } from "../services/partner/inboundMail";
import { deriveToken } from "../services/partner/tokens";

let server: Server; let base: string; let a1: string; let a2: string;
const g = globalThis as any;
const as = (id: string) => { g.__TEST_ATHLETE_ID = id; };

async function call(method: string, path: string, body?: unknown, opts: { form?: boolean; cookie?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  let payload: string | undefined;
  if (opts.raw !== undefined) { payload = opts.raw; headers["content-type"] = "application/json"; }
  else if (body !== undefined) {
    headers["content-type"] = opts.form ? "application/x-www-form-urlencoded" : "application/json";
    payload = opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers, body: payload });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}
const cookieOf = (h: Headers): string => (h.get("set-cookie") ?? "").split(/,(?=\s*nomila_rq=)/).map((c) => c.split(";")[0].trim())[0] ?? "";
const lastText = () => sent[sent.length - 1]?.text ?? "";
const linkIn = (re: RegExp) => { const m = re.exec(lastText()); if (!m) throw new Error(`no link in: ${lastText().slice(0, 200)}`); return m[1]; };

const commercial = (over: Record<string, unknown> = {}) => ({
  kind: "content", website: "brandexample.com", brand_name: "Brand Example", idea: "Three short videos around our new line.",
  timing: { kind: "flexible" }, budget: "5k_15k", contact_name: "Jordan Lee", contact_email: "jordan@brandexample.com", ...over,
});

async function land(handle: string, input: Record<string, unknown>) {
  const d = await call("POST", `/api/v1/public/cards/${handle}/partner/requests`, input);
  expect(d.status).toBe(201);
  await call("POST", `/api/v1/public/cards/${handle}/partner/requests/${d.json.id}/send`, { draft_token: d.json.draftToken });
  const c = await call("POST", `/partner/confirm/${linkIn(/\/partner\/confirm\/([A-Za-z0-9_-]+)/)}`);
  const token = decodeURIComponent(String(c.headers.get("location")).slice(3));
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.json.id));
  return { token, row };
}

/** Pass the email-code check for a request's status page; returns the cookie. */
async function check(token: string): Promise<string> {
  sent.length = 0;
  expect((await call("POST", `/r/${token}/code`)).status).toBe(303);
  const code = linkIn(/Your code is (\d{6})/);
  const v = await call("POST", `/r/${token}/verify`, { code }, { form: true });
  expect(v.status).toBe(303);
  const c = cookieOf(v.headers);
  expect(c).toMatch(/^nomila_rq=/);
  return c;
}

/** A stand-in partner mailbox: messages in, labels and body reads recorded. Nothing reaches Google. */
const mailbox = new Map<string, Omit<ReceivedEmail, "id">>();
const labelled = new Set<string>();
const bodyReads: string[] = [];
let failRead: string | null = null;
const fakeInbox: PartnerInbox = {
  async unprocessed(max) { return [...mailbox.keys()].filter((id) => !labelled.has(id)).slice(0, max); },
  async envelope(id) {
    const m = mailbox.get(id);
    return m ? envelopeOf([{ name: "From", value: m.from }, { name: "To", value: m.to.join(", ") }]) : null;
  },
  async read(id) {
    bodyReads.push(id);
    if (failRead === id) throw new Error("database down");
    const m = mailbox.get(id);
    return m ? { id, ...m } : null;
  },
  async markProcessed(id) { labelled.add(id); },
};
const replyTo = (row: { id: string; token_nonce: string }) => `partners+${deriveToken("reply", row.id, row.token_nonce)}@inbox.example.test`;

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Avery Example");
  a2 = await seedAthlete("Blair Example");
  setPublishedCardSource(fixedCardSource([cardFor(a1, "avery"), cardFor(a2, "blair", { firstName: "Blair" })]));
  setPartnerInbox(fakeInbox);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public/cards", partnerApiRouter);
  app.use("/partner", partnerConfirmRouter);
  app.use("/r", express.urlencoded({ extended: false }), partnerStatusRouter);
  app.use("/requests", express.urlencoded({ extended: false }), partnerRequestsRouter);
  app.use("/api/v1/admin/relay", adminRelayRouter);
  app.use("/api/v1/me", partnerAthleteRouter);
  app.use("/api/v1/me", pendingActionsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); setPublishedCardSource(null); setPartnerInbox(null); await closeTestDb(); });
beforeEach(() => { sent.length = 0; g.__TEST_ADMIN = false; });

const threadRows = async (threadId: string) => db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, threadId));
async function herReply(athleteId: string, dealId: string, threadId: string, body: string) {
  as(athleteId);
  const pa = await call("POST", `/api/v1/me/deals/${dealId}/pending-actions`, { kind: "send_reply", thread_id: threadId, payload: { body } });
  expect(pa.status).toBe(201);
  return call("POST", `/api/v1/me/pending-actions/${pa.json.pending_action?.id ?? pa.json.id}/approve`, { body_sha256: bodySha256(body) });
}

describe("T1 the visitor check", () => {
  it("the link alone shows steps; messages need a code sent to the request's own address", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t1@brandexample.com" }));
    const page = await call("GET", `/r/${token}`);
    expect(page.text).toMatch(/Show messages/);
    expect(page.text).not.toMatch(/<textarea/);
    sent.length = 0;
    await call("POST", `/r/${token}/code`);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("t1@brandexample.com");
    expect(sent[0].subject).toMatch(/^Your Nomila code: \d{6}$/);
    // a wrong code fails and counts; the right code then still works once
    expect((await call("POST", `/r/${token}/verify`, { code: "000000" }, { form: true })).headers.get("location")).toMatch(/m=badcode/);
    const code = linkIn(/Your code is (\d{6})/);
    const ok = await call("POST", `/r/${token}/verify`, { code }, { form: true });
    const setCookies = ok.headers.get("set-cookie") ?? "";
    expect(setCookies).toMatch(/Path=\/r/);
    expect(setCookies).toMatch(/Path=\/requests/);
    expect(setCookies).toMatch(/HttpOnly/i);
    const cookie = cookieOf(ok.headers);
    expect((await call("GET", `/r/${token}`, undefined, { cookie })).text).toMatch(/<textarea/);
    // the code is spent
    expect((await call("POST", `/r/${token}/verify`, { code }, { form: true })).headers.get("location")).toMatch(/m=badcode/);
    expect(row.contact_email_hash).toBeTruthy();
  });

  it("five wrong tries exhaust a code", async () => {
    const { token } = await land("avery", commercial({ contact_email: "t1b@brandexample.com" }));
    sent.length = 0;
    await call("POST", `/r/${token}/code`);
    const code = linkIn(/Your code is (\d{6})/);
    for (let i = 0; i < 5; i++) await call("POST", `/r/${token}/verify`, { code: code === "111111" ? "222222" : "111111" }, { form: true });
    expect((await call("POST", `/r/${token}/verify`, { code }, { form: true })).headers.get("location")).toMatch(/m=badcode/);
  });
});

describe("T2 the visitor writes", () => {
  it("clean lands on her thread; held is stored without a body and shown only to the sender; blocked never shows", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t2@brandexample.com" }));
    const cookie = await check(token);
    expect((await call("POST", `/r/${token}/messages`, { body: "Could you do a call next week?" }, { form: true, cookie })).headers.get("location")).toMatch(/m=sent/);
    expect((await call("POST", `/r/${token}/messages`, { body: "Text me on 415 555 0134" }, { form: true, cookie })).headers.get("location")).toMatch(/m=checking/);
    expect((await call("POST", `/r/${token}/messages`, { body: "Pay the fee in gift cards" }, { form: true, cookie })).headers.get("location")).toMatch(/m=blocked/);
    const rows = await threadRows(row.inbox_thread_id!);
    const clean = rows.find((m) => m.body === "Could you do a call next week?")!;
    expect(clean).toMatchObject({ direction: "inbound", platform: "nomila", moderation: "clean", sender_email: "t2@brandexample.com" });
    const held = rows.find((m) => m.moderation === "held")!;
    expect(held).toMatchObject({ body: null, held_body: "Text me on 415 555 0134", moderation_reason: "contact_phone" });
    expect(rows.find((m) => m.moderation === "blocked")).toMatchObject({ body: null, moderation_reason: "scam" });
    const page = (await call("GET", `/r/${token}`, undefined, { cookie })).text;
    expect(page).toMatch(/Could you do a call next week\?/);
    expect(page).toMatch(/This message is being checked\./);
    expect(page).not.toMatch(/415 555 0134|gift cards/);
    // her view: the clean message only, and it is her move
    as(a1);
    const mine = await call("GET", `/api/v1/me/partner-requests/${row.id}`);
    expect(mine.json.messages.map((m: any) => m.body)).toEqual([expect.stringMatching(/request from Brand Example/), "Could you do a call next week?"]);
    const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, row.inbox_thread_id!));
    expect((t.conversation_state as any).key_details.awaiting_response_from).toBe("athlete");
    expect(t.message_count).toBe(2);
    // no email goes to anyone for the visitor's own message
    expect(sent.filter((s) => s.subject.startsWith("You have a new message"))).toHaveLength(0);
  });

  it("empty, too long and too many are refused", async () => {
    const { token } = await land("avery", commercial({ contact_email: "t2b@brandexample.com" }));
    const cookie = await check(token);
    expect((await call("POST", `/r/${token}/messages`, { body: "   " }, { form: true, cookie })).status).toBe(400);
    expect((await call("POST", `/r/${token}/messages`, { body: "x".repeat(2001) }, { form: true, cookie })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("POST", `/r/${token}/messages`, { body: `note ${i}` }, { form: true, cookie })).status);
    expect(statuses.slice(0, 10).every((s) => s === 303)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("without the check, writing just asks for the code", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t2c@brandexample.com" }));
    expect((await call("POST", `/r/${token}/messages`, { body: "hello" }, { form: true })).headers.get("location")).toMatch(/m=code/);
    expect((await threadRows(row.inbox_thread_id!))).toHaveLength(1);
  });
});

describe("T3 her reply, by her tap", () => {
  it("goes through the relay from Nomila: a content-free notice with the reply-to; the page says she replied", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t3@brandexample.com" }));
    sent.length = 0;
    const r = await herReply(a1, row.deal_id!, row.inbox_thread_id!, "Thanks — happy to talk about formats.");
    expect(r.status).toBe(200);
    const rows = await threadRows(row.inbox_thread_id!);
    expect(rows.find((m) => m.direction === "outbound")).toMatchObject({ platform: "nomila", moderation: "clean", body: "Thanks — happy to talk about formats.", sender_email: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "t3@brandexample.com", subject: "You have a new message from Avery" });
    expect(sent[0].replyTo).toBe(replyTo(row));
    expect(sent[0].text).not.toMatch(/happy to talk/);                      // content-free
    expect(sent[0].text).toMatch(/https:\/\/public\.example\.test\/r\//);
    expect((await call("GET", `/r/${token}`)).text).toMatch(/<li class="now"><div class="row"><span>Avery replied/);
    const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, row.inbox_thread_id!));
    expect((t.conversation_state as any).key_details.awaiting_response_from).toBe("brand");
  });

  it("her reply with contact details is held, not sent, and she is told why", async () => {
    const { row } = await land("avery", commercial({ contact_email: "t3b@brandexample.com" }));
    sent.length = 0;
    const r = await herReply(a1, row.deal_id!, row.inbox_thread_id!, "Email me at avery@example-mail.com");
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "HELD_FOR_REVIEW" });
    expect(sent).toHaveLength(0);
    as(a1);
    const mine = (await call("GET", `/api/v1/me/partner-requests/${row.id}`)).json.messages;
    expect(mine[mine.length - 1]).toMatchObject({ from: "athlete", state: "checking", body: "Email me at avery@example-mail.com" });
  });
});

describe("T4 tenancy", () => {
  it("her request routes are hers only; one address's check opens no other address's thread", async () => {
    const one = await land("avery", commercial({ contact_email: "t4a@brandexample.com" }));
    const two = await land("blair", commercial({ contact_email: "t4b@otherexample.com" }));
    as(a2);
    expect((await call("GET", `/api/v1/me/partner-requests/${one.row.id}`)).status).toBe(404);
    expect((await call("POST", `/api/v1/me/partner-requests/${one.row.id}/decline`)).status).toBe(404);
    expect((await call("POST", `/api/v1/me/partner-requests/${one.row.id}/agree`)).status).toBe(404);
    expect((await call("GET", "/api/v1/me/partner-requests/not-a-uuid")).status).toBe(404);
    expect((await db.select().from(partnerRequests).where(eq(partnerRequests.id, one.row.id)))[0].outcome).toBeNull();
    // she cannot reply on another athlete's thread through the send path either
    as(a2);
    expect((await call("POST", `/api/v1/me/deals/${one.row.deal_id}/pending-actions`, { kind: "send_reply", thread_id: one.row.inbox_thread_id, payload: { body: "hi" } })).status).toBe(404);
    // the visitor check for t4a does not open t4b's thread
    const cookieA = await check(one.token);
    const p2 = await call("GET", `/r/${two.token}`, undefined, { cookie: cookieA });
    expect(p2.text).toMatch(/Show messages/);
    expect((await call("POST", `/r/${two.token}/messages`, { body: "sneaky" }, { form: true, cookie: cookieA })).headers.get("location")).toMatch(/m=code/);
    expect(await threadRows(two.row.inbox_thread_id!)).toHaveLength(1);
  });
});

describe("T5 her decisions", () => {
  it("decline: rejected, the visitor hears the no once, the reply box closes; a second decision is refused", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t5@brandexample.com" }));
    const cookie = await check(token);
    sent.length = 0;
    as(a1);
    expect((await call("POST", `/api/v1/me/partner-requests/${row.id}/decline`)).json).toEqual({ ok: true, outcome: "declined", releasedCents: null });   // no Serious-offer hold here
    expect((await db.select().from(deals).where(eq(deals.id, row.deal_id!)))[0].status).toBe("rejected");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("An update on your request to Avery");
    expect(sent[0].text).toMatch(/Thank you for thinking of Avery/);
    const page = (await call("GET", `/r/${token}`, undefined, { cookie })).text;
    expect(page).toMatch(/Avery has passed on this one/);
    expect(page).not.toMatch(/<textarea/);
    expect((await call("POST", `/api/v1/me/partner-requests/${row.id}/agree`)).status).toBe(409);
  });

  it("agree: accepted, and the page says so", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t5b@brandexample.com" }));
    as(a1);
    expect((await call("POST", `/api/v1/me/partner-requests/${row.id}/agree`)).json).toEqual({ ok: true, outcome: "agreed", creditedCents: null });
    expect((await db.select().from(deals).where(eq(deals.id, row.deal_id!)))[0].status).toBe("accepted");
    expect((await call("GET", `/r/${token}`)).text).toMatch(/Avery agreed/);
  });
});

describe("T6 Your requests", () => {
  it("email → code → every request from that address; an unknown address gets the same answer and no email", async () => {
    await land("avery", commercial({ contact_email: "many@brandexample.com", brand_name: "First Brand" }));
    await land("blair", commercial({ contact_email: "many@brandexample.com", brand_name: "Second Brand" }));
    await land("avery", commercial({ contact_email: "someone-else@brandexample.com", brand_name: "Not Mine" }));
    expect((await call("GET", "/requests")).text).toMatch(/Email me a code/);
    sent.length = 0;
    const unknown = await call("POST", "/requests/code", { email: "nobody@nowhere.example" }, { form: true });
    const known = await call("POST", "/requests/code", { email: "Many@BrandExample.com" }, { form: true });
    expect(unknown.text.replace(/nobody@nowhere\.example/g, "X")).toBe(known.text.replace(/Many@BrandExample\.com/g, "X"));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("many@brandexample.com");
    const code = linkIn(/Your code is (\d{6})/);
    const v = await call("POST", "/requests/verify", { email: "many@brandexample.com", code }, { form: true });
    expect(v.status).toBe(303);
    const list = (await call("GET", "/requests", undefined, { cookie: cookieOf(v.headers) })).text;
    expect(list).toMatch(/First Brand × Avery/);
    expect(list).toMatch(/Second Brand × Blair/);
    expect(list).not.toMatch(/Not Mine/);
    expect(list).toMatch(/https:\/\/public\.example\.test\/r\//);
    expect((await call("POST", "/requests/verify", { email: "many@brandexample.com", code: "123456" }, { form: true })).status).toBe(400);
    expect((await db.select().from(partnerVisitorCodes)).every((c) => c.code_hash.length === 64)).toBe(true);
  });
});

describe("T7 inbound mail", () => {
  beforeEach(() => { mailbox.clear(); labelled.clear(); bodyReads.length = 0; failRead = null; });

  it("a reply from the request's address lands on the thread, quote stripped, and is labelled; seeing it again is a no-op", async () => {
    const { row } = await land("avery", commercial({ contact_email: "t7@brandexample.com" }));
    const to = replyTo(row);
    mailbox.set("gm_1", { from: "Jordan Lee <T7@brandexample.com>", to: [`Nomila <${to}>`], text: "Great, Tuesday works.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Nomila <hello@nomila.co> wrote:\n> You have a new message" });
    expect(await pollPartnerInbox()).toMatchObject({ seen: 1, failed: 0, outcomes: { relayed: 1 } });
    expect(labelled.has("gm_1")).toBe(true);
    const rows = await threadRows(row.inbox_thread_id!);
    expect(rows.find((m) => m.external_message_id === "nomila:inbound:gm_1")).toMatchObject({ body: "Great, Tuesday works.", direction: "inbound", moderation: "clean" });
    expect(await pollPartnerInbox()).toMatchObject({ seen: 0 });             // labelled: never looked at again
    labelled.delete("gm_1");                                                // label lost: the relay still stores it once
    expect(await pollPartnerInbox()).toMatchObject({ outcomes: { duplicate: 1 } });
    expect((await threadRows(row.inbox_thread_id!)).filter((m) => m.external_message_id === "nomila:inbound:gm_1")).toHaveLength(1);
  });

  it("mail not addressed to a reply address is labelled without its body being read", async () => {
    mailbox.set("gm_n1", { from: "news@shop.example", to: ["partners@inbox.example.test"], text: "Sale!" });
    mailbox.set("gm_n2", { from: "x@brandexample.com", to: ["partners+0123456789abcdef0123456789abcdef@other.example"], text: "hi" });
    expect(await pollPartnerInbox()).toMatchObject({ seen: 2, outcomes: { "ignored:not_a_reply_address": 2 } });
    expect(bodyReads).toEqual([]);
    expect([...labelled].sort()).toEqual(["gm_n1", "gm_n2"]);
  });

  it("another sender, an unknown token and a held reply; a failure leaves the message unlabelled for the next poll", async () => {
    const { row } = await land("avery", commercial({ contact_email: "t7b@brandexample.com" }));
    const to = replyTo(row);
    mailbox.set("gm_2", { from: "intruder@elsewhere.example", to: [to], text: "hi" });
    mailbox.set("gm_4", { from: "t7b@brandexample.com", to: ["partners+ffffffffffffffffffffffffffffffff@inbox.example.test"], text: "hi" });
    mailbox.set("gm_5", { from: "t7b@brandexample.com", to: [to], text: "Call me at 415 555 0134" });
    expect(await pollPartnerInbox()).toMatchObject({ seen: 3, failed: 0, outcomes: { "ignored:sender": 1, "ignored:unknown_thread": 1, held: 1 } });
    const rows = await threadRows(row.inbox_thread_id!);
    expect(rows.filter((m) => m.direction === "inbound")).toHaveLength(2);    // the request + the held one
    expect(rows.find((m) => m.moderation === "held")).toMatchObject({ body: null, held_body: "Call me at 415 555 0134" });

    mailbox.set("gm_6", { from: "t7b@brandexample.com", to: [to], text: "Retry me" });
    failRead = "gm_6";
    expect(await pollPartnerInbox()).toMatchObject({ seen: 1, failed: 1 });
    expect(labelled.has("gm_6")).toBe(false);
    failRead = null;
    expect(await pollPartnerInbox()).toMatchObject({ seen: 1, failed: 0, outcomes: { relayed: 1 } });
    expect(labelled.has("gm_6")).toBe(true);
  });
});

describe("T8 review of held messages", () => {
  it("admins only; release delivers with its notice; block never delivers", async () => {
    const { token, row } = await land("avery", commercial({ contact_email: "t8@brandexample.com" }));
    sent.length = 0;
    await herReply(a1, row.deal_id!, row.inbox_thread_id!, "My deck is at https://deck.example.com");
    await herReply(a1, row.deal_id!, row.inbox_thread_id!, "Or venmo works for a deposit");
    expect(sent).toHaveLength(0);
    expect((await call("GET", "/api/v1/admin/relay/held")).status).toBe(403);
    g.__TEST_ADMIN = true;
    const held = (await call("GET", "/api/v1/admin/relay/held")).json.messages.filter((m: any) => m.requestRef === row.public_ref);
    expect(held.map((m: any) => m.body)).toEqual(["My deck is at https://deck.example.com", "Or venmo works for a deposit"]);
    expect((await call("POST", `/api/v1/admin/relay/messages/${held[0].id}/release`)).json).toEqual({ ok: true, decision: "release" });
    expect((await call("POST", `/api/v1/admin/relay/messages/${held[1].id}/block`)).json).toEqual({ ok: true, decision: "block" });
    expect((await call("POST", `/api/v1/admin/relay/messages/${held[1].id}/release`)).status).toBe(404);   // blocked is final
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("You have a new message from Avery");
    const cookie = await check(token);
    const page = (await call("GET", `/r/${token}`, undefined, { cookie })).text;
    expect(page).toMatch(/deck\.example\.com/);
    expect(page).not.toMatch(/venmo/);
    const rows = await db.select().from(inboxMessages).where(and(eq(inboxMessages.thread_id, row.inbox_thread_id!), eq(inboxMessages.moderation, "blocked")));
    expect(rows).toHaveLength(1);
  });
});
