/**
 * partnerDoorForm.test.ts — the no-script Partner form on her card (/p/:handle/partner) and public Mila's
 * PartnerIntakePort, end to end through Express against PGlite. Partner's own draft → email confirm path runs for real;
 * only the email lib and brand research are replaced at their boundaries (no provider is reached).
 *
 *   D1 the page: PARTNER_INTAKE off → the disabled "opens soon" form; on → the kind chooser, then the kind's form
 *      (commercial or press), never cached
 *   D2 a valid request → "Check your email", one request awaiting the email confirm, the confirm email sent; nothing on
 *      her board until the visitor taps Send in it (then the existing confirm page lands it)
 *   D3 invalid input → the form again, with the reason and the visitor's words, escaped
 *   D4 the honeypot and the minimum fill time: answered like a success, nothing stored or sent
 *   D5 tenancy: a request filed on one card belongs to that athlete only; a handle whose Partner door is off is 404
 *   D6 PARTNER_INTAKE off → POST stores nothing and says so (503)
 *   M1 public Mila's PartnerIntakePort: a kind → this card's Partner page with that kind; another athlete's id, a
 *      Partner door that is off, the flag off → closed; an unknown kind → invalid; it writes nothing
 */
process.env.PUBLIC_CARD = "true";
process.env.PARTNER_INTAKE = "true";
process.env.PARTNER_TOKEN_SECRET = "test-partner-secret";
process.env.PUBLIC_BASE_URL = "https://public.example.test";
process.env.EMAIL_PROVIDER = "gmail"; // sendEmail is mocked: nothing reaches Google
process.env.PARTNER_DRAFTS_PER_VISITOR_DAY = "100";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/rateLimit", () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { publicCardLimiter: pass, askMilaLimiter: pass };
});
const sent: Array<{ to: string; subject: string; text?: string }> = [];
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async (m: any) => { sent.push(m); return { sent: false, skipped: true }; }) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { deals, partnerRequests } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { createPublicPageRouter } from "./publicPage";
import { partnerConfirmRouter } from "./partnerPublic";
import { PUBLIC_CARD_FIXTURES } from "../services/publicCard/fixtures";
import { setPublishedCardSource } from "../services/partner/publishedCard";
import { cardFor, fixedCardSource } from "../testUtils/publishedCardDouble";
import { createPartnerIntakePort } from "../services/partner/milaPort";
import { safeNextUrl } from "../mila/public/ports";

const A = "avery-okafor";
const B = "rowan-castell";
let server: Server; let base: string; let a1: string; let a2: string;

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Door Form One");
  a2 = await seedAthlete("Door Form Two");
  setPublishedCardSource(fixedCardSource([cardFor(a1, A, { firstName: "Avery" }), cardFor(a2, B, { firstName: "Rowan", partnerOpen: false })]));
  const app = express();
  app.use(createPublicPageRouter({ loadView: async (h) => PUBLIC_CARD_FIXTURES[h] ?? null }));
  app.use("/partner", express.urlencoded({ extended: false }), partnerConfirmRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); setPublishedCardSource(null); await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; process.env.PARTNER_INTAKE = "true"; sent.length = 0; });

async function call(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(base + path, {
    method, redirect: "manual",
    headers: form ? { "content-type": "application/x-www-form-urlencoded" } : {},
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const longAgo = () => String(Date.now() - 60_000);
const commercial = (over: Record<string, string> = {}) => ({
  kind: "content", brand_name: "Brand Example", website: "https://www.brandexample.com", idea: "Three short videos for a new line.",
  goal: "launch", timing_month: "", budget: "5k_15k", contact_name: "Jordan Lee", contact_email: "jordan@brandexample.com",
  website_confirm: "", opened_at: longAgo(), ...over,
});
const requestsFor = (athleteId: string) => db.select().from(partnerRequests).where(eq(partnerRequests.athlete_id, athleteId));

describe("D1 the page", () => {
  it("off: the disabled 'opens soon' form; on: the kind chooser, then the kind's form, never cached", async () => {
    process.env.PARTNER_INTAKE = "false";
    const off = await call("GET", `/p/${A}/partner`);
    expect(off.text).toContain("Requests open soon. Nothing can be sent from this page yet.");
    expect(off.text).toMatch(/type="submit" disabled/);

    process.env.PARTNER_INTAKE = "true";
    const chooser = await call("GET", `/p/${A}/partner`);
    expect(chooser.headers.get("cache-control")).toBe("no-store");
    for (const k of ["sponsorship", "content", "endorsement", "appearance", "press", "other"]) expect(chooser.text).toContain(`href="/p/${A}/partner?kind=${k}"`);
    expect(chooser.text).not.toContain("disabled");

    const form = await call("GET", `/p/${A}/partner?kind=content`);
    expect(form.headers.get("cache-control")).toBe("no-store");
    for (const f of ["brand_name", "website", "idea", "goal", "timing_month", "budget", "agency", "client_brand", "contact_name", "contact_email", "website_confirm", "opened_at"]) expect(form.text).toContain(`name="${f}"`);
    expect(form.text).toContain('<input type="hidden" name="kind" value="content">');
    expect(form.text).toContain("Nothing reaches Avery until you tap Send in that email.");
    const pressForm = await call("GET", `/p/${A}/partner?kind=press`);
    for (const f of ["topic", "format", "deadline"]) expect(pressForm.text).toContain(`name="${f}"`);
    expect(pressForm.text).not.toContain('name="budget"');
    // an unknown kind is the chooser again
    expect((await call("GET", `/p/${A}/partner?kind=rates`)).text).toContain("What kind of request?");
  });
});

describe("D2 a valid request", () => {
  it("→ check your email; one request awaiting the confirm; nothing on her board until the visitor taps Send", async () => {
    const r = await call("POST", `/p/${A}/partner`, commercial());
    expect(r.status).toBe(200);
    expect(r.text).toContain("Check your email");
    expect(r.text).toContain("jordan@brandexample.com");
    const rows = await requestsFor(a1);
    expect(rows.map((x) => [x.kind, x.status, x.brand_name])).toEqual([["content", "awaiting_email", "Brand Example"]]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("jordan@brandexample.com");
    expect(await db.select().from(deals).where(eq(deals.athlete_id, a1))).toEqual([]);

    const token = /\/partner\/confirm\/([A-Za-z0-9_-]+)/.exec(sent[0].text ?? "")![1];
    const confirm = await call("POST", `/partner/confirm/${token}`, {});
    expect(confirm.status).toBe(303);
    const landed = await db.select().from(deals).where(eq(deals.athlete_id, a1));
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ source: "public_profile" });
  });

  it("a press request through the press form", async () => {
    const r = await call("POST", `/p/${A}/partner`, {
      kind: "press", brand_name: "Example Weekly", topic: "How training changes in the off-season.", format: "podcast", deadline: "",
      contact_name: "Sam Writer", contact_email: "sam@exampleweekly.com", website_confirm: "", opened_at: longAgo(),
    });
    expect(r.status).toBe(200);
    const rows = (await requestsFor(a1)).filter((x) => x.kind === "press");
    expect(rows).toHaveLength(1);
  });
});

describe("D3 invalid input", () => {
  it("→ the form again, with the reason and the visitor's words, escaped", async () => {
    const before = (await requestsFor(a1)).length;
    const r = await call("POST", `/p/${A}/partner`, commercial({ idea: "short", brand_name: '<script>alert(1)</script>' }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('role="alert"');
    expect(r.text).toContain("say a little about the idea");
    expect(r.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.text).not.toContain("<script>alert(1)");
    expect(r.text).toContain('name="idea"');
    expect((await requestsFor(a1)).length).toBe(before);
  });
});

describe("D4 spam checks", () => {
  it("the honeypot and a too-fast form: answered like a success, nothing stored or sent", async () => {
    const before = (await requestsFor(a1)).length;
    expect((await call("POST", `/p/${A}/partner`, commercial({ website_confirm: "https://spam.example" }))).text).toContain("Check your email");
    expect((await call("POST", `/p/${A}/partner`, commercial({ opened_at: String(Date.now()) }))).text).toContain("Check your email");
    expect((await requestsFor(a1)).length).toBe(before);
    expect(sent).toEqual([]);
  });
});

describe("D5 tenancy", () => {
  it("a request belongs to the card it was filed on; a card whose Partner door is off is 404", async () => {
    const r = await call("POST", `/p/${B}/partner`, commercial());
    expect(r.status).toBe(404);
    expect(await requestsFor(a2)).toEqual([]);
    const all = await db.select({ athlete_id: partnerRequests.athlete_id }).from(partnerRequests);
    expect(new Set(all.map((x) => x.athlete_id))).toEqual(new Set([a1]));
  });
});

describe("D6 PARTNER_INTAKE off", () => {
  it("POST stores nothing and says so", async () => {
    process.env.PARTNER_INTAKE = "false";
    const before = (await requestsFor(a1)).length;
    const r = await call("POST", `/p/${A}/partner`, commercial());
    expect(r.status).toBe(503);
    expect(r.text).toContain("Nothing was sent.");
    expect((await requestsFor(a1)).length).toBe(before);
  });
});

describe("M1 public Mila's PartnerIntakePort", () => {
  const port = createPartnerIntakePort();
  it("a kind → this card's Partner page with that kind (a same-site path); it writes nothing", async () => {
    const before = (await db.select().from(partnerRequests)).length;
    const r = await port.begin({ athleteId: a1, handle: A, kind: "sponsorship", askMilaSessionId: null });
    expect(r).toEqual({ ok: true, nextUrl: `/p/${A}/partner?kind=sponsorship` });
    expect(r.ok && safeNextUrl(r.nextUrl)).toBe(`/p/${A}/partner?kind=sponsorship`);
    expect((await db.select().from(partnerRequests)).length).toBe(before);
  });
  it("another athlete's id, a Partner door that is off, or the flag off → closed; an unknown kind → invalid", async () => {
    expect(await port.begin({ athleteId: a2, handle: A, kind: "press", askMilaSessionId: null })).toEqual({ ok: false, reason: "closed" });
    expect(await port.begin({ athleteId: a2, handle: B, kind: "press", askMilaSessionId: null })).toEqual({ ok: false, reason: "closed" });
    expect(await port.begin({ athleteId: a1, handle: "nobody-here", kind: "press", askMilaSessionId: null })).toEqual({ ok: false, reason: "closed" });
    expect(await port.begin({ athleteId: a1, handle: A, kind: "rates" as any, askMilaSessionId: null })).toEqual({ ok: false, reason: "invalid" });
    process.env.PARTNER_INTAKE = "false";
    expect(await port.begin({ athleteId: a1, handle: A, kind: "press", askMilaSessionId: null })).toEqual({ ok: false, reason: "closed" });
  });
});
