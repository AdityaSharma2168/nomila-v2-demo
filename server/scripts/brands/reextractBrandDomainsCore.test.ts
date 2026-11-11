/**
 * reextractBrandDomainsCore.test.ts — the catch-up for existing opportunities, on PGlite. The live mailbox read and
 * the classify call are injected (no provider, no stored body is read).
 *
 *   - DRY-RUN writes nothing (run under a read-only session: any write would throw) and never enqueues, yet makes —
 *     and counts — the classify calls
 *   - per brand: a domain-less brand gets the advertiser_domain the live mail shows; a brand with a domain is not
 *     classified and is enqueued only when it has identity work outstanding; agency rows and domains held by another
 *     row are reported, not enqueued
 *   - APPLY enqueues exactly the brands that gain a domain or have work outstanding
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { inboxBrands, inboxMessages, inboxThreads, opportunities, workflowRuns } from "../../../shared/schema";
import { estimate, reextractBrandDomains, renderReport, type LatestInbound } from "./reextractBrandDomainsCore";
import type { Classification } from "../../skills/dealDetector";

let athleteId: string;
const ids: Record<string, number> = {};

const cls = (advertiser_domain: string | null): Classification => ({
  category: "PAID", confidence: 0.9, brand_name: null, brand_domain: null, advertiser: null, agency_name: null, via_agency: true,
  summary: "", offer_amount: null, deliverables: [], deadline: null, contact_name: null, contact_email: null, advertiser_domain,
});

async function brandWithOpp(key: string, values: Record<string, unknown>, withInbound = true): Promise<void> {
  const [b] = await db.insert(inboxBrands).values({ name: key, normalized_name: key.toLowerCase(), ...values } as any).returning({ id: inboxBrands.id });
  ids[key] = b.id;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, brand_id: b.id, subject: `${key} campaign`, external_thread_id: `ext-${key}` } as any).returning({ id: inboxThreads.id });
  if (withInbound) await db.insert(inboxMessages).values({ thread_id: t.id, athlete_id: athleteId, direction: "inbound", subject: "x", body: "STORED BODY — must never be read", external_message_id: `m-${key}`, platform: "gmail" } as any);
  await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: new Date(), last_activity_at: new Date(), lead_thread_id: t.id } as any);
}

const snapshot = async () => JSON.stringify({
  brands: await db.select().from(inboxBrands).orderBy(inboxBrands.id),
  runs: await db.select().from(workflowRuns),
});

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Catch-up Athlete");
  await brandWithOpp("Nodomain Co", { domain: null });                         // live mail shows its site
  await brandWithOpp("Silent Co", { domain: null });                           // live mail shows nothing
  await brandWithOpp("Held Co", { domain: "held.example" });                   // never checked → work outstanding
  await brandWithOpp("Checked Co", { domain: "checked.example", enrichment: { identity: { status: "unconfirmed", domain: "checked.example", own_sources: [], basis: "no_own_domain_source", checked_at: new Date().toISOString() } } });
  await brandWithOpp("Agency Co", { domain: null, is_agency: true });
  await brandWithOpp("Clash Co", { domain: null });                            // shows a domain another row holds
  await brandWithOpp("Nomail Co", { domain: null }, false);
});
afterAll(closeTestDb);

const mailFor: Record<string, string | null> = { "Nodomain Co": "nodomain.example", "Silent Co": null, "Clash Co": "held.example" };
function deps() {
  const read = jest.fn(async (_a: string, threadId: string): Promise<LatestInbound> => ({ from: "Robin <robin@agency.example>", subject: "Campaign", text: `live text for ${threadId}` }));
  const brandOfThread = async (threadId: string) => {
    const all = await db.select({ id: inboxThreads.id, brand_id: inboxThreads.brand_id }).from(inboxThreads);
    const bid = all.find((x) => x.id === threadId)?.brand_id;
    return Object.keys(ids).find((k) => ids[k] === bid)!;
  };
  const classify = jest.fn(async (_f: string, _s: string, body: string) => cls(mailFor[await brandOfThread(body.replace("live text for ", ""))] ?? null));
  const enqueue = jest.fn(async () => ({ runId: "run" }));
  return { read, classify, enqueue };
}

test("dry-run writes nothing and enqueues nothing, but makes and counts the classify calls", async () => {
  const before = await snapshot();
  const d = deps();
  expect(await estimate(db, [athleteId])).toEqual({ brands: 7, classifyCalls: 4 });   // Nodomain, Silent, Clash, Nomail (no inbound → no call)
  await client.exec("SET default_transaction_read_only = on");
  let report;
  try {
    report = await reextractBrandDomains({ dbx: db, athleteIds: [athleteId], apply: false, classify: d.classify, readLatestInbound: d.read, enqueue: d.enqueue });
  } finally {
    await client.exec("SET default_transaction_read_only = off");
  }
  expect(d.enqueue).not.toHaveBeenCalled();
  expect(await snapshot()).toBe(before);
  expect(report.classifyCalls).toBe(3);
  expect(d.classify).toHaveBeenCalledTimes(3);
  for (const c of d.classify.mock.calls) expect(c[2]).not.toContain("STORED BODY");

  const by = Object.fromEntries(report.rows.map((r) => [r.brand, r]));
  expect(by["Nodomain Co"]).toMatchObject({ found_domain: "nodomain.example", source: "advertiser_domain", action: "enqueue" });
  expect(by["Silent Co"]).toMatchObject({ found_domain: null, action: "none" });
  expect(by["Held Co"]).toMatchObject({ found_domain: "held.example", source: "held", action: "enqueue" });
  expect(by["Checked Co"]).toMatchObject({ action: "none", note: "already checked" });
  expect(by["Agency Co"]).toMatchObject({ action: "none" });
  expect(by["Clash Co"]).toMatchObject({ found_domain: "held.example", action: "none" });
  expect(by["Clash Co"].note).toContain(`#${ids["Held Co"]}`);
  expect(by["Nomail Co"]).toMatchObject({ action: "none", note: "no inbound message" });
  expect(renderReport(report)).toContain("DRY-RUN (nothing written)");
});

test("apply enqueues exactly the brands that gain a domain or have work outstanding", async () => {
  const d = deps();
  const report = await reextractBrandDomains({ dbx: db, athleteIds: [athleteId], apply: true, classify: d.classify, readLatestInbound: d.read, enqueue: d.enqueue });
  expect(report.enqueued).toBe(2);
  expect(d.enqueue.mock.calls).toEqual(expect.arrayContaining([
    [athleteId, ids["Nodomain Co"], "nodomain.example"],
    [athleteId, ids["Held Co"], null],
  ]));
  expect(d.enqueue).toHaveBeenCalledTimes(2);
});

test("no live reader: reported as an error, never a stored-body fallback", async () => {
  const d = deps();
  const report = await reextractBrandDomains({ dbx: db, athleteIds: [athleteId], apply: false, classify: d.classify, readLatestInbound: async () => null, enqueue: d.enqueue });
  expect(d.classify).not.toHaveBeenCalled();
  expect(report.rows.find((r) => r.brand === "Nodomain Co")).toMatchObject({ action: "error" });
});
