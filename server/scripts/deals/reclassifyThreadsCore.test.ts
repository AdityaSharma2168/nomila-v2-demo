/**
 * reclassifyThreadsCore — against PGlite, the classifier MOCKED (no provider is reached). The selected athlete's
 * threads stored under a category are re-read through services/reclassifyThread: the dry run (READ-ONLY session)
 * writes nothing and reports what would change; --apply writes only the changed threads, reusing the dry run's
 * classification. Another athlete's threads and other categories are never touched.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent: jest.fn(async () => { throw new Error("no provider in tests"); }) } }),
  GEMINI: { flash: "stub", flashLite: "stub", pro: "stub" },
  KIMI: { vertexModel: "stub", moonshotModel: "stub" },
}));
jest.mock("../../lib/kimi", () => ({ kimiInstant: jest.fn(async () => { throw new Error("no provider in tests"); }) }));
jest.mock("../../lib/brandResolver", () => ({ resolveBrandIdentity: jest.fn(async () => null) }));
jest.mock("../../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { reclassifyAthlete, renderMarkdown } from "./reclassifyThreadsCore";
import type { Classification } from "../../skills/dealDetector";

let athleteId = "";
let other = "";
let seq = 0;
const t: Record<string, string> = {};

const verdict = (category: string, media_kind: string | null): Classification => ({
  category, is_deal: true, confidence: 0.9, brand_name: "Studio", brand_domain: "studio.example.com", advertiser: "Studio",
  agency_name: null, via_agency: false, media_kind, summary: "A request", offer_amount: null, deliverables: [], deadline: null,
  contact_name: null, contact_email: null,
} as any);
// The mocked model's answers, per fixture thread (keyed on the test's own subject marker).
const ANSWERS: Record<string, Classification> = {
  collab: verdict("PAID", null),
  press: verdict("MEDIA", "interview"),
  same: verdict("MEDIA", "podcast"),
  aside: { ...verdict("NOISE", null), is_deal: false },
  elsewhere: verdict("PAID", null),
};
const classify = jest.fn(async (_from: string, subject: string) => ANSWERS[subject]);

async function thread(who: string, key: string, cls: Record<string, unknown>, bodies: string[] = ["…"]) {
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: "Studio", status: "detected", source: "inbox_scan", deal_type: "appearance" } as any).returning({ id: deals.id });
  const [row] = await db.insert(inboxThreads).values({ athlete_id: who, deal_id: d.id, subject: key, status: "deal_detected", classification: cls } as any).returning({ id: inboxThreads.id });
  for (const [i, body] of bodies.entries()) {
    await db.insert(inboxMessages).values({ athlete_id: who, thread_id: row.id, direction: "inbound", sender_email: "a@studio.example.com", subject: key, body, platform: "gmail", external_message_id: `rc-${++seq}`, received_at: new Date(Date.UTC(2026, 8, 25, 18, i)) } as any);
  }
  t[key] = row.id;
}
const stored = async (key: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, t[key])))[0].classification as any;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Reclassified");
  other = await seedAthlete("Not selected");
  await thread(athleteId, "collab", { category: "MEDIA", media_kind: null, alias_thread_ids: ["keep"] });
  await thread(athleteId, "press", { category: "MEDIA" });
  await thread(athleteId, "same", { category: "MEDIA", media_kind: "podcast" });
  await thread(athleteId, "paid", { category: "PAID" });
  await thread(athleteId, "aside", { category: "MEDIA" });
  await thread(other, "elsewhere", { category: "MEDIA" });
  // A payment advice minted as an offer (content in the message, as ingest merged it), and a real deal thread whose
  // latest message is a payment advice.
  const advice = "Payment advice. We have settled the following items by bank transfer, subject to the goods and services supplied and the invoice being in order. Net USD 5,000.00";
  await thread(athleteId, "remit-one", { category: "GIFTING" }, [advice]);
  await thread(athleteId, "remit-deal", { category: "GIFTING" }, ["Would you be interested in a paid post for our launch?", advice]);
});
afterAll(async () => { await closeTestDb(); });

it("dry run (read-only session): reports the changes the model makes and writes nothing", async () => {
  await client.exec("SET default_transaction_read_only = on");
  let r;
  try {
    r = await reclassifyAthlete(db, athleteId, { category: "MEDIA", apply: false, classify });
  } finally {
    await client.exec("SET default_transaction_read_only = off");
  }
  expect(classify).toHaveBeenCalledTimes(4);   // the PAID thread and the other athlete's are not selected
  expect(r.counts).toEqual({ examined: 4, changed: 3, category_changed: 2, written: 0, held: 1, errors: 0, by_new_category: { PAID: 1, NOISE: 1 } });
  expect(r.rows.find((x) => x.thread_id === t.aside)).toMatchObject({ to_category: "NOISE", outcome: "demoted", held: expect.any(String) });
  expect(r.rows.find((x) => x.thread_id === t.collab)).toMatchObject({ from_category: "MEDIA", to_category: "PAID", changed: true, written: false, outcome: "updated" });
  expect(r.rows.find((x) => x.thread_id === t.press)).toMatchObject({ to_category: "MEDIA", from_media_kind: null, to_media_kind: "interview", changed: true });
  expect(r.rows.find((x) => x.thread_id === t.same)).toMatchObject({ changed: false });
  expect(renderMarkdown(r)).not.toMatch(/…/);   // no message text in the report
  expect((await stored("collab")).category).toBe("MEDIA");
});

it("--apply writes only the changed threads, once each, keeping other subsystems' keys; a demotion is held; nothing else is touched", async () => {
  classify.mockClear();
  const r = await reclassifyAthlete(db, athleteId, { category: "MEDIA", apply: true, classify });
  expect(classify).toHaveBeenCalledTimes(4);   // the write reuses the dry read's answer
  expect(r.counts).toMatchObject({ written: 2, held: 1 });
  expect((await stored("aside")).category).toBe("MEDIA");
  const [asideRow] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.aside));
  expect(asideRow.status).toBe("deal_detected");
  expect(await stored("collab")).toMatchObject({ category: "PAID", media_kind: null, alias_thread_ids: ["keep"] });
  expect(await stored("press")).toMatchObject({ category: "MEDIA", media_kind: "interview" });
  expect(await stored("same")).toMatchObject({ category: "MEDIA", media_kind: "podcast" });
  expect(await stored("paid")).toEqual({ category: "PAID" });
  const [o] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.elsewhere));
  expect((o.classification as any).category).toBe("MEDIA");
});

it("a billing notice is re-read by the structural rule (no model call); applied on a one-message thread, held on a longer one", async () => {
  classify.mockClear();
  const r = await reclassifyAthlete(db, athleteId, { category: "GIFTING", apply: true, classify });
  expect(classify).not.toHaveBeenCalled();
  expect(r.rows.find((x) => x.thread_id === t["remit-one"])).toMatchObject({ to_category: "NOISE", outcome: "demoted", written: true, structural: expect.stringMatching(/^billing/) });
  expect(r.rows.find((x) => x.thread_id === t["remit-deal"])).toMatchObject({ to_category: "NOISE", outcome: "demoted", written: false, held: expect.any(String) });
  expect((await stored("remit-one")).category).toBe("NOISE");
  expect((await stored("remit-deal")).category).toBe("GIFTING");
});
