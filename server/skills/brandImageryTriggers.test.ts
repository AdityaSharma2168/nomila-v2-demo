/**
 * brandImageryTriggers.test.ts — ingest and onboarding reach the brand imagery pipeline by themselves. The real
 * dealDetector, brand resolver and request seam run against PGlite with the real runner; the classify provider, Kimi,
 * the summarizer, ingest's brand research and the Gmail fetch are mocked, so nothing reaches a provider.
 *
 *   - a new email whose mail shows the advertiser's domain (classification.advertiser_domain) fills the advertiser's
 *     row and requests EXACTLY ONE brand_identity_refresh run; more mail from the brand joins it
 *   - a direct pitch from a free-mail address that shows the brand's site fills the domain the same way
 *   - mail for a brand already checked starts nothing; gate off starts nothing
 *   - onboarding: a new athlete's first inbox scan (runGmailBackfill) goes through the same path
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(async () => ({ choices: [{ message: { content: "{}" } }] })) }));
jest.mock("../lib/models", () => {
  const generateContent = jest.fn();
  const client = { models: { generateContent } };
  return { genai: () => client, GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" }, KIMI: { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" } };
});
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined), searchOfficialSite: jest.fn() }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));
// Default: an empty folder. The backfill lists inbox, then Sent, separately (#990); a test queues the inbox page.
const fetchBackfillMessages = jest.fn(async (..._a: any[]) => [] as any[]);
jest.mock("../lib/integrations/gmail", () => ({ fetchBackfillMessages: (...a: any[]) => fetchBackfillMessages(...a) }));

import { eq } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { runGmailBackfill } from "./gmailBackfill";
import { genai } from "../lib/models";
import { inboxBrands, workflowRuns, workflowSteps } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { BRAND_IDENTITY_REFRESH_PROCESS } from "../services/brandIdentityRefresh";
import { resetRunnerConfig } from "../workflow/runner";
import "../workflow/definitions/index";

const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const BASE = {
  category: "PAID", confidence: 0.9, is_deal: true, offer_amount: 500, deliverables: ["1 post"], deadline: null,
  contact_name: "Robin", contact_email: null, channel: "agency", claims_known_brand: false, advertiser_named: true,
  qualification: "qualified", qualification_reason: "A paid campaign.", cash_amount: 500,
  comp_kind: "cash", work_kind: "social_post", work_units: 1, summary: "Paid campaign",
};

let athleteId: string;
let inbox: string;
const runs = () => db.select().from(workflowRuns).where(eq(workflowRuns.process, BRAND_IDENTITY_REFRESH_PROCESS));
const brandNamed = async (name: string) => (await db.select().from(inboxBrands)).find((b) => b.name === name);

function message(id: string, from: string, body: string) {
  return { gmailMessageId: id, gmailThreadId: `t-${id}`, subject: "Paid campaign", from, body, date: "2026-10-01T10:00:00Z", messageIdHeader: `<${id}@x>` };
}
function send(id: string, cls: Record<string, unknown>, from: string, body: string) {
  classifyMock.mockImplementationOnce(async () => ({ text: JSON.stringify({ ...BASE, ...cls }) }));
  return detectDeal({ athleteId, connectionId: inbox, message: message(id, from, body) });
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Trigger Athlete");
  inbox = await seedConnection({ athleteId, email: "trigger-athlete@example.com" });
});
afterAll(async () => { await new Promise((r) => setTimeout(r, 100)); await closeTestDb(); });
beforeEach(async () => {
  resetRunnerConfig();
  process.env.BRAND_IDENTITY_GATE = "true";
  classifyMock.mockReset();
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { delete process.env.BRAND_IDENTITY_GATE; });

test("agency mail showing the advertiser's domain: the domain is filled and exactly one job is requested", async () => {
  const cls = { brand_name: "Crunchwell", brand_domain: "otterlanemedia.example", advertiser: "Crunchwell", agency_name: "Otterlane Media", via_agency: true, advertiser_domain: "crunchwell.example" };
  const body = "On behalf of our client Crunchwell (https://www.crunchwell.example/shop) we'd like to pay you $500.";
  const r1 = await send("a1", cls, "Robin <robin@otterlanemedia.example>", body);
  expect(r1.skipped).toBe(false);
  const brand = await brandNamed("Crunchwell");
  expect(brand?.domain).toBe("crunchwell.example");
  let all = await runs();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ athlete_id: athleteId, status: "running" });
  expect(all[0].input).toMatchObject({ brandId: brand!.id });

  // A second email about the same advertiser (another thread) joins the active run: still one.
  await send("a2", cls, "Robin <robin@otterlanemedia.example>", body);
  all = await runs();
  expect(all).toHaveLength(1);
});

test("a direct pitch from a free-mail address that shows the brand's site fills the domain too", async () => {
  const cls = { brand_name: "Pebblebar", brand_domain: null, advertiser: "Pebblebar", agency_name: null, via_agency: false, channel: "direct", advertiser_domain: "pebblebar.example" };
  await send("d1", cls, "Sam <sam.pebblebar@gmail.com>", "Hi! I run partnerships at Pebblebar — pebblebar.example. Paid post?");
  const brand = await brandNamed("Pebblebar");
  expect(brand?.domain).toBe("pebblebar.example");
  const all = await runs();
  expect(all.map((r) => (r.input as any).brandId)).toEqual([brand!.id]);
});

test("mail for a brand already checked starts nothing; gate off starts nothing", async () => {
  const [checked] = await db.insert(inboxBrands).values({
    name: "Settled Co", normalized_name: "settled co", domain: "settled.example",
    enrichment: { identity: { status: "unconfirmed", domain: "settled.example", own_sources: [], basis: "no_own_domain_source", checked_at: new Date().toISOString() } },
  } as any).returning();
  await send("s1", { brand_name: "Settled Co", brand_domain: "settled.example", advertiser: "Settled Co", agency_name: null, via_agency: false, channel: "direct", advertiser_domain: null }, "Lee <lee@settled.example>", "Paid post for $500?");
  expect(await runs()).toHaveLength(0);
  expect(checked.id).toBeGreaterThan(0);

  delete process.env.BRAND_IDENTITY_GATE;
  await send("g1", { brand_name: "Gateless", brand_domain: "gateless.example", advertiser: "Gateless", agency_name: null, via_agency: false, channel: "direct", advertiser_domain: null }, "Kim <kim@gateless.example>", "Paid post for $500?");
  expect(await runs()).toHaveLength(0);
});

test("onboarding: the first inbox scan sends each brand through the same path", async () => {
  const newcomer = await seedAthlete("New Athlete");
  const conn = await seedConnection({ athleteId: newcomer, email: "new-athlete@example.com" });
  fetchBackfillMessages.mockResolvedValueOnce([
    { id: "ob1", threadId: "tob1", subject: "Paid campaign", from: "Ana <ana@firstbrand.example>", body: "We'd love to pay you $500 for a post.", date: "2026-09-20T10:00:00Z", messageIdHeader: "<ob1@x>" },
    { id: "ob2", threadId: "tob2", subject: "Paid campaign", from: "Ana <ana@firstbrand.example>", body: "Following up on our $500 offer.", date: "2026-09-21T10:00:00Z", messageIdHeader: "<ob2@x>" },
  ]);
  const cls = { brand_name: "Firstbrand", brand_domain: "firstbrand.example", advertiser: "Firstbrand", agency_name: null, via_agency: false, channel: "direct", advertiser_domain: null };
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify({ ...BASE, ...cls }) }));

  const r = await runGmailBackfill({ connectionId: conn, athleteId: newcomer });
  expect(r.errored).toBe(0);
  const brand = await brandNamed("Firstbrand");
  const mine = (await runs()).filter((x) => x.athlete_id === newcomer);
  expect(mine).toHaveLength(1);
  expect(mine[0].input).toMatchObject({ brandId: brand!.id });
});
