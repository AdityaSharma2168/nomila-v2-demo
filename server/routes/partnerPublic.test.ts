/**
 * routes/partnerPublic.test.ts — the Partner door, end to end against PGlite (Express + real SQL). No test reaches a
 * provider: the homepage fetch (safeFetch), the fit model (genai), the email lib (sendEmail) and brand research
 * (getOrResearchBrand) are replaced at their boundaries.
 *
 *   P1 handle: unknown, unpublished-equivalent and Partner-off handles are the same 404, on every route
 *   P2 fit: the light read (title / description / og only), cached per domain; Mila's first read through the gate,
 *      sealed; an unreadable site asks "what does [brand] make?" and uses the answer ("told"); rate limits
 *   P3 draft: the request card and the press form validate by kind; contact details / links in free text are refused;
 *      the honeypot and the minimum fill time store nothing; a tampered or stale fit seal is refused
 *   P4 send: the confirm email (content-free, link only); a draft token opens only its own draft (tenancy); the
 *      per-email-per-athlete weekly limit
 *   P5 confirm: a GET never confirms; the POST lands ONE deal (source public_profile, the kind's category + deal_type,
 *      press → MEDIA with its media_kind), its thread on the opportunity (platform 'nomila', the request as the first
 *      inbound message), placed under an opportunity; research starts only now; the received email has the status link
 *   P6 status page: steps; "[First] is reviewing" after she opens the card; a token opens only its own request
 *   P7 her board: the request card + pre-qualified markers on GET /me/opportunities, for her only
 *   P8 expiry: unconfirmed requests expire at 72h and can no longer be confirmed
 */
process.env.PUBLIC_CARD = "true";
process.env.PARTNER_INTAKE = "true";
process.env.PARTNER_TOKEN_SECRET = "test-partner-secret";
process.env.PUBLIC_BASE_URL = "https://public.example.test";
// sendTemplate only hands a notice to sendEmail when a provider is configured; sendEmail itself is mocked below.
process.env.EMAIL_PROVIDER = "gmail"; // sendEmail is mocked: nothing reaches Google
process.env.PARTNER_FIT_PER_VISITOR_DAY = "100";
process.env.PARTNER_DRAFTS_PER_VISITOR_DAY = "100";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
const pages = new Map<string, { body: string; type?: string; status?: number }>();
const fetched: string[] = [];
jest.mock("../lib/safeFetch", () => {
  const actual = jest.requireActual("../lib/safeFetch");
  return {
    ...actual,
    safeFetch: jest.fn(async (url: string) => {
      fetched.push(url);
      const p = pages.get(url);
      if (!p) return new Response("", { status: 404 });
      return new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html" } });
    }),
  };
});
const modelAnswers: Array<object | Error> = [];
const modelPrompts: string[] = [];
jest.mock("../lib/models", () => ({
  ...jest.requireActual("../lib/models"),
  genai: () => ({ models: { generateContent: async (req: any) => {
    modelPrompts.push(req.contents[0].parts[0].text);
    const a = modelAnswers.shift() ?? { lines: [] };
    if (a instanceof Error) throw a;
    return { text: JSON.stringify(a) };
  } } }),
}));
const sent: Array<{ to: string; subject: string; html: string; text?: string; replyTo?: string }> = [];
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async (m: any) => { sent.push(m); return { sent: false, skipped: true }; }) }));
const researched: Array<[string, string | null | undefined]> = [];
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async (n: string, d?: string | null) => { researched.push([n, d]); return null; }) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import dealsRouter from "./deals";
import { partnerApiRouter, partnerConfirmRouter } from "./partnerPublic";
import { partnerStatusRouter } from "./partnerStatus";
import { athletes, deals, inboxMessages, inboxThreads, opportunities, partnerRequests } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { setPublishedCardSource } from "../services/partner/publishedCard";
import { cardFor, fixedCardSource } from "../testUtils/publishedCardDouble";
import { _clearRobotsCache } from "../services/shop/linkMeta";
import { expireUnconfirmed } from "../services/partner/requests";

let server: Server; let base: string; let a1: string; let a2: string;
const g = globalThis as any;
const as = (id: string) => { g.__TEST_ATHLETE_ID = id; };

async function call(method: string, path: string, body?: unknown, opts: { form?: boolean; redirect?: "manual" | "follow" } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: opts.redirect ?? "manual",
    headers: body === undefined ? {} : { "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json" },
    body: body === undefined ? undefined : opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}
const site = (domain: string, title: string, desc = "") =>
  pages.set(`https://${domain}/`, { body: `<html><head><title>${title}</title><meta name="description" content="${desc}"><meta property="og:site_name" content="${title}"><meta property="og:image" content="https://${domain}/og.png"></head></html>` });

const commercial = (over: Record<string, unknown> = {}) => ({
  kind: "content", website: "https://www.brandexample.com/about", brand_name: "Brand Example",
  goal: "launch", idea: "Three short videos around our new recovery line.", timing: { kind: "month", month: "2099-11" },
  budget: "5k_15k", agency: false, contact_name: "Jordan Lee", contact_email: "jordan@brandexample.com", ...over,
});
const press = (over: Record<string, unknown> = {}) => ({
  kind: "press", brand_name: "Example Weekly", topic: "How training routines change in the off-season.", format: "podcast",
  deadline: "2099-12-01", contact_name: "Sam Writer", contact_email: "sam@exampleweekly.com", ...over,
});
const lastLink = (re: RegExp) => { const m = re.exec(sent[sent.length - 1]?.text ?? ""); if (!m) throw new Error("no link in the last email"); return m[1]; };

/** Draft → send → confirm through the real routes; returns the status token and the request row. */
async function landRequest(handle: string, input: Record<string, unknown>) {
  const d = await call("POST", `/api/v1/public/cards/${handle}/partner/requests`, input);
  expect(d.status).toBe(201);
  expect((await call("POST", `/api/v1/public/cards/${handle}/partner/requests/${d.json.id}/send`, { draft_token: d.json.draftToken })).status).toBe(202);
  const confirmToken = lastLink(/\/partner\/confirm\/([A-Za-z0-9_-]+)/);
  const c = await call("POST", `/partner/confirm/${confirmToken}`);
  expect(c.status).toBe(303);
  const statusToken = decodeURIComponent(String(c.headers.get("location")).replace(/^\/r\//, ""));
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.json.id));
  return { draft: d.json, confirmToken, statusToken, row };
}

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Avery Example");
  a2 = await seedAthlete("Blair Example");
  setPublishedCardSource(fixedCardSource([
    cardFor(a1, "avery"),
    cardFor(a2, "blair", { firstName: "Blair", minor: true }),
    cardFor(a2, "closed-door", { partnerOpen: false }),
  ]));
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public/cards", partnerApiRouter);
  app.use("/partner", partnerConfirmRouter);
  app.use("/r", express.urlencoded({ extended: false }), partnerStatusRouter);
  app.use("/api/v1/me", dealsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); setPublishedCardSource(null); await closeTestDb(); });
beforeEach(() => { pages.clear(); fetched.length = 0; modelAnswers.length = 0; modelPrompts.length = 0; sent.length = 0; researched.length = 0; _clearRobotsCache(); });

describe("P1 handle", () => {
  it("unknown, malformed and Partner-off handles are the same 404 on every route", async () => {
    for (const h of ["nobody", "UPPER_case!", "closed-door"]) {
      expect((await call("POST", `/api/v1/public/cards/${h}/partner/fit`, { website: "brandexample.com" })).status).toBe(404);
      expect((await call("POST", `/api/v1/public/cards/${h}/partner/requests`, commercial())).status).toBe(404);
      expect((await call("POST", `/api/v1/public/cards/${h}/partner/requests/00000000-0000-4000-8000-000000000000/send`, { draft_token: "x" })).status).toBe(404);
    }
  });
});

describe("P2 fit", () => {
  it("reads only the homepage's own tags, cached per domain; the first read cites only given sources, sealed", async () => {
    site("fitbrand.example", "Fit Brand", "Recovery gear for early risers.");
    modelAnswers.push({ lines: [
      { text: "Fit Brand makes recovery gear, and Avery writes about recovery.", source: "media" },
      { text: "Early-riser routines match Avery's sunrise training.", source: "story" },
      { text: "Avery charges $5k a post.", source: "story" },                 // money → cut
      { text: "Email avery@x-example.com for details.", source: "site" },     // contact → cut
      { text: "Invented chapter line.", source: "awards" },                   // not a given source → cut
    ] });
    const r = await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "https://www.FitBrand.example/shop?x=1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ domain: "fitbrand.example", site: { readable: true, title: "Fit Brand", description: "Recovery gear for early risers.", siteName: "Fit Brand" }, askAbout: false });
    expect(r.json.site.image).toBeUndefined();                              // kept for logos, never shown
    expect(r.json.fit.preview.lines).toEqual([
      { text: "Fit Brand makes recovery gear, and Avery writes about recovery.", source: "media" },
      { text: "Early-riser routines match Avery's sunrise training.", source: "story" },
    ]);
    expect(r.json.fit.preview.label).toBe("Mila's first read · from fitbrand.example's public page and Avery's published card");
    expect(typeof r.json.fit.seal).toBe("string");
    // only the homepage (and robots) were fetched — no crawl
    expect(fetched.filter((u) => !u.endsWith("/robots.txt"))).toEqual(["https://fitbrand.example/"]);
    // the data goes to the model inside <external_content>
    expect(modelPrompts[0]).toMatch(/<external_content source="brand">[\s\S]*Recovery gear[\s\S]*<\/external_content>/);
    // a second visitor from the same brand: no fetch, no model call
    fetched.length = 0;
    const again = await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "fitbrand.example" });
    expect(again.json.fit.preview.lines).toHaveLength(2);
    expect(fetched).toEqual([]);
    expect(modelPrompts).toHaveLength(1);
  });

  it("an unreadable site asks what the brand makes, then uses the answer, labelled as told and never cached", async () => {
    const first = await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "dark.example" });
    expect(first.json).toMatchObject({ domain: "dark.example", site: { readable: false }, askAbout: true, fit: null });
    expect(modelPrompts).toHaveLength(0);
    modelAnswers.push({ lines: [{ text: "Sleep products suit Avery's recovery notes.", source: "told" }] });
    const told = await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "dark.example", about: "We make sleep masks." });
    expect(told.json.fit.preview).toMatchObject({ basis: "told", label: "Mila's first read · from what you told me and Avery's published card" });
    expect(modelPrompts[0]).toMatch(/what the visitor said the brand makes: We make sleep masks\./);
  });

  it("a model failure is no preview, not an error; a bad website is a 400", async () => {
    site("down.example", "Down");
    modelAnswers.push(new Error("model down"));
    const r = await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "down.example" });
    expect(r.status).toBe(200);
    expect(r.json.fit).toBeNull();
    expect((await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "not a site" })).status).toBe(400);
    expect((await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "someone@gmail.com" })).status).toBe(400);
  });

  it("per-visitor daily limit", async () => {
    process.env.PARTNER_FIT_PER_VISITOR_DAY = "1";
    try {
      // the earlier tests already used this visitor's allowance for today
      expect((await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "fitbrand.example" })).status).toBe(429);
    } finally { process.env.PARTNER_FIT_PER_VISITOR_DAY = "100"; }
  });
});

describe("P3 draft", () => {
  it("the request card: validated by kind; the serious-offer step is offered (on by default, $50)", async () => {
    const r = await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial());
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ref: expect.stringMatching(/^[2-9A-Z]{6}$/), draftToken: expect.any(String), seriousOffer: { available: true, amountCents: 5000 }, guardianNote: null });
    const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, r.json.id));
    expect(row).toMatchObject({ athlete_id: a1, status: "drafting", kind: "content", domain: "brandexample.com", display_name: "Avery", email_domain_match: true });
    expect(row.draft_token_hash).not.toBe(r.json.draftToken);             // hash only
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(72 * 3_600_000);
    expect(sent).toHaveLength(0);                                          // nothing sent at draft
  });

  it("required fields per kind, and the press form has no website, budget or hold", async () => {
    const miss = async (b: object, field: string) => {
      const r = await call("POST", "/api/v1/public/cards/avery/partner/requests", b);
      expect(r.status).toBe(400); expect(r.json.field).toBe(field);
    };
    await miss(commercial({ kind: "brief" }), "kind");
    await miss(commercial({ website: "" }), "website");
    await miss(commercial({ idea: "hi" }), "idea");
    await miss(commercial({ budget: "lots" }), "budget");
    await miss(commercial({ timing: { kind: "range", from: "2099-12-01", to: "2099-11-01" } }), "timing");
    await miss(commercial({ contact_email: "not-an-email" }), "contact_email");
    await miss(press({ format: "tv" }), "format");
    await miss(press({ topic: "" }), "topic");
    await miss(press({ deadline: "next week" }), "deadline");
    const p = await call("POST", "/api/v1/public/cards/avery/partner/requests", press());
    expect(p.status).toBe(201);
    expect(p.json.seriousOffer).toEqual({ available: false, amountCents: null });
  });

  it("free text carrying contact details, payment asks or links is refused with the reason in plain words", async () => {
    for (const [b, field] of [
      [commercial({ idea: "Text me at 415 555 0134 to talk about videos" }), "idea"],
      [commercial({ idea: "We'd pay via Venmo for three short videos" }), "idea"],
      [commercial({ idea: "Our deck is at https://deck.example.com/x please" }), "idea"],
      [press({ topic: "Email me at sam@exampleweekly.com about routines" }), "topic"],
      [commercial({ contact_name: "Jordan jordan@x.example" }), "contact_name"],
    ] as const) {
      const r = await call("POST", "/api/v1/public/cards/avery/partner/requests", b);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ field, error: expect.stringMatching(/Avery replies to you here/) });
    }
  });

  it("the honeypot and a too-fast form store nothing and send nothing, but look like a success", async () => {
    const before = (await db.select().from(partnerRequests)).length;
    const hp = await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ website_confirm: "x" }));
    const fast = await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ opened_at: Date.now() }));
    expect([hp.status, fast.status]).toEqual([201, 201]);
    expect((await db.select().from(partnerRequests)).length).toBe(before);
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${hp.json.id}/send`, { draft_token: hp.json.draftToken })).status).toBe(404);
  });

  it("a fit preview is attached only with its seal, for this card and this domain", async () => {
    site("sealbrand.example", "Seal Brand", "Things.");
    modelAnswers.push({ lines: [{ text: "Seal Brand things suit Avery's routine.", source: "story" }] });
    const fit = (await call("POST", "/api/v1/public/cards/avery/partner/fit", { website: "sealbrand.example" })).json.fit;
    const ok = await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ website: "sealbrand.example", fit }));
    expect(ok.status).toBe(201);
    const tampered = { ...fit, preview: { ...fit.preview, lines: [{ text: "Avery will definitely say yes.", source: "story" }] } };
    expect((await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ website: "sealbrand.example", fit: tampered }))).status).toBe(400);
    expect((await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ website: "otherbrand.example", fit }))).status).toBe(400);
    // another athlete's card cannot reuse it
    expect((await call("POST", "/api/v1/public/cards/blair/partner/requests", commercial({ website: "sealbrand.example", fit }))).status).toBe(400);
    const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, ok.json.id));
    expect((row.fit_preview as any).lines).toEqual(fit.preview.lines);
  });

  it("a minor athlete's request says a parent or guardian will be involved", async () => {
    const r = await call("POST", "/api/v1/public/cards/blair/partner/requests", commercial());
    expect(r.json.guardianNote).toBe("A parent or guardian will be involved.");
  });
});

describe("P4 send", () => {
  it("one content-free confirm email; the token opens only its own draft, for its own athlete", async () => {
    const d = (await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ contact_email: "p4@brandexample.com" }))).json;
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/send`, { draft_token: "wrong" })).status).toBe(404);
    expect((await call("POST", `/api/v1/public/cards/blair/partner/requests/${d.id}/send`, { draft_token: d.draftToken })).status).toBe(404);
    expect(sent).toHaveLength(0);
    const r = await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/send`, { draft_token: d.draftToken });
    expect(r.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "p4@brandexample.com", subject: "Confirm your request to Avery" });
    expect(sent[0].text).toMatch(/https:\/\/public\.example\.test\/partner\/confirm\//);
    expect(sent[0].text).not.toMatch(/recovery line/);                     // no request content in the email
    expect(sent[0].html + sent[0].text).not.toMatch(/\bbrief\b/i);        // visitor copy never says "brief"
    const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.id));
    expect(row.status).toBe("awaiting_email");
  });

  it("at most 3 sends per email per athlete per week", async () => {
    const email = "limit@brandexample.com";
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = (await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ contact_email: email }))).json;
      statuses.push((await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/send`, { draft_token: d.draftToken })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    // a different athlete is a different allowance
    const other = (await call("POST", "/api/v1/public/cards/blair/partner/requests", commercial({ contact_email: email }))).json;
    expect((await call("POST", `/api/v1/public/cards/blair/partner/requests/${other.id}/send`, { draft_token: other.draftToken })).status).toBe(202);
  });
});

describe("P5 confirm", () => {
  it("a GET shows the Send page and changes nothing; the POST lands one deal + thread on an opportunity", async () => {
    site("brandexample.com", "Brand Example", "Recovery gear.");
    const d = (await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ contact_email: "p5@brandexample.com" }))).json;
    await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/send`, { draft_token: d.draftToken });
    const token = lastLink(/\/partner\/confirm\/([A-Za-z0-9_-]+)/);
    const page = await call("GET", `/partner/confirm/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Send to Avery/);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'none'/);
    expect(page.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect((await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.id)))[0].status).toBe("awaiting_email");
    expect(researched).toEqual([]);

    sent.length = 0;
    const c = await call("POST", `/partner/confirm/${token}`);
    expect(c.status).toBe(303);
    expect(c.headers.get("location")).toMatch(/^\/r\//);
    const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.id));
    expect(row).toMatchObject({ status: "confirmed", deal_id: expect.any(String), inbox_thread_id: expect.any(String) });
    const [deal] = await db.select().from(deals).where(eq(deals.id, row.deal_id!));
    expect(deal).toMatchObject({ athlete_id: a1, source: "public_profile", direction: "inbound", status: "detected", deal_type: "social_post", brand_name: "Brand Example" });
    expect(deal.opportunity_id).toBeTruthy();
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, row.inbox_thread_id!));
    expect(thread).toMatchObject({ deal_id: deal.id, status: "deal_detected", message_count: 1 });
    expect(thread.classification).toMatchObject({ category: "PAID", source: "public_profile", qualification: "workable", channel: "direct" });
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, deal.opportunity_id!));
    expect(opp).toMatchObject({ athlete_id: a1, status: "open", lead_thread_id: thread.id });
    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, thread.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "inbound", platform: "nomila", moderation: "clean", sender_email: "p5@brandexample.com" });
    expect(msgs[0].body).toMatch(/Idea: Three short videos/);
    // research only now, for the resolved brand
    expect(researched).toEqual([["Brand Example", "brandexample.com"]]);
    // the received email carries the private status link, nothing else
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your request is with Avery");
    expect(sent[0].text).toMatch(/https:\/\/public\.example\.test\/r\//);

    // a second tap (or a re-sent form) is the same request, no second deal
    const again = await call("POST", `/partner/confirm/${token}`);
    expect(again.status).toBe(303);
    expect((await db.select().from(deals).where(eq(deals.athlete_id, a1))).filter((x) => (x.raw_data as any)?.partner_request_id === d.id)).toHaveLength(1);
    expect((await call("GET", `/partner/confirm/${token}`)).text).toMatch(/Already sent to Avery/);
  });

  it("press lands as MEDIA with its media_kind, needs no website, and an agency request carries its advertiser", async () => {
    const { row } = await landRequest("avery", press({ contact_email: "p5press@exampleweekly.com" }));
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, row.inbox_thread_id!));
    expect(thread.classification).toMatchObject({ category: "MEDIA", media_kind: "podcast", qualification: "needs_terms" });
    const [deal] = await db.select().from(deals).where(eq(deals.id, row.deal_id!));
    expect(deal.deal_type).toBe("appearance");

    const ag = await landRequest("avery", commercial({ kind: "sponsorship", brand_name: "Agency Example", website: "agencyexample.com", agency: true, client_brand: "Client Example", contact_email: "a@agencyexample.com", budget: "not_sure" }));
    const [agDeal] = await db.select().from(deals).where(eq(deals.id, ag.row.deal_id!));
    expect(agDeal).toMatchObject({ brand_name: "Client Example", deal_type: "ambassador" });
    const [agThread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, ag.row.inbox_thread_id!));
    expect(agThread.classification).toMatchObject({ channel: "agency", via_agency: true, agency_name: "Agency Example", qualification: "needs_terms" });
  });

  it("an unknown token is a 404 page and a forged one confirms nothing", async () => {
    expect((await call("GET", "/partner/confirm/not-a-real-token-at-all-xx")).status).toBe(404);
    expect((await call("POST", "/partner/confirm/not-a-real-token-at-all-xx")).status).toBe(404);
  });
});

describe("P6 status page", () => {
  it("Received, then [First] is reviewing after she opens the card; each token opens only its own request", async () => {
    const one = await landRequest("avery", commercial({ contact_email: "p6a@brandexample.com", brand_name: "Status One", website: "statusone.example" }));
    const two = await landRequest("blair", commercial({ contact_email: "p6b@brandexample.com", brand_name: "Status Two", website: "statustwo.example" }));
    const p1 = await call("GET", `/r/${one.statusToken}`);
    expect(p1.status).toBe(200);
    expect(p1.text).toMatch(/Status One/);
    expect(p1.text).not.toMatch(/Status Two/);
    expect(p1.text).toMatch(/<li class="now"><div class="row"><span>Received/);
    expect(p1.headers.get("cache-control")).toBe("no-store");
    expect((await call("GET", `/r/${two.statusToken}`)).text).toMatch(/Status Two/);
    expect((await call("GET", "/r/someone-elses-guess-token-xxxx")).status).toBe(404);
    // the confirm token is not a status token
    expect((await call("GET", `/r/${one.confirmToken}`)).status).toBe(404);

    // she opens the opportunity card (her route, her token)
    as(a1);
    const [deal] = await db.select().from(deals).where(eq(deals.id, one.row.deal_id!));
    expect((await call("GET", `/api/v1/me/opportunities/${deal.opportunity_id}`)).status).toBe(200);
    expect((await call("GET", `/r/${one.statusToken}`)).text).toMatch(/<li class="now"><div class="row"><span>Avery is reviewing/);
    // another athlete opening it sees nothing and marks nothing
    as(a2);
    const [d2] = await db.select().from(deals).where(eq(deals.id, two.row.deal_id!));
    expect((await call("GET", `/api/v1/me/opportunities/${deal.opportunity_id}`)).status).toBe(404);
    expect((await db.select().from(partnerRequests).where(eq(partnerRequests.id, two.row.id)))[0].brief_seen_at).toBeNull();
    expect(d2.athlete_id).toBe(a2);
  });
});

describe("P7 her board", () => {
  it("the request card with its pre-qualified markers, on her board only", async () => {
    await db.update(athletes).set({ deal_preferences: { minimum_rates: { socialPost: 10_000 } } }).where(eq(athletes.id, a1));
    const { row } = await landRequest("avery", commercial({ brand_name: "Board Brand", website: "boardbrand.example", contact_email: "x@gmail.com", budget: "1k_5k" }));
    as(a1);
    const board = (await call("GET", "/api/v1/me/opportunities")).json;
    const all = [...board.whatMatters, ...board.needsTermsBatch, ...board.inMotion, ...board.explore, ...board.toVerify];
    const card = all.find((i: any) => i.deal_ids.includes(row.deal_id));
    expect(card.partner_request).toMatchObject({
      request_id: row.id, ref: row.public_ref, kind: "content", kind_label: "Social posts or content", press: false,
      markers: { email_confirmed: true, domain_match: false, research_confirmed: false, budget: "below", dates_past: false },
    });
    as(a2);
    const other = (await call("GET", "/api/v1/me/opportunities")).json;
    const otherAll = [...other.whatMatters, ...other.needsTermsBatch, ...other.inMotion, ...other.explore, ...other.toVerify];
    expect(otherAll.some((i: any) => i.deal_ids.includes(row.deal_id))).toBe(false);
  });
});

describe("P8 expiry", () => {
  it("unconfirmed requests expire at 72h, and the link then says so", async () => {
    const d = (await call("POST", "/api/v1/public/cards/avery/partner/requests", commercial({ contact_email: "p8@brandexample.com" }))).json;
    await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/send`, { draft_token: d.draftToken });
    const token = lastLink(/\/partner\/confirm\/([A-Za-z0-9_-]+)/);
    expect(await expireUnconfirmed(new Date(Date.now() + 71 * 3_600_000))).toBe(0);
    expect(await expireUnconfirmed(new Date(Date.now() + 73 * 3_600_000))).toBeGreaterThan(0);
    expect((await call("POST", `/partner/confirm/${token}`)).status).toBe(410);
    expect((await db.select().from(partnerRequests).where(eq(partnerRequests.id, d.id)))[0].status).toBe("expired");
  });
});
