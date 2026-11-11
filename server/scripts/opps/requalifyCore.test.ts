/**
 * requalifyCore — the dry-run's no-write guarantee and report shape. Real SQL (PGlite) under a
 * READ-ONLY session, so any write the core attempted would throw; the classify provider is a mock
 * (and lib/models is stubbed besides), so nothing reaches a model.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/models", () => ({
  genai: () => { throw new Error("tests must never reach the classify provider"); },
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

import { eq, sql } from "drizzle-orm";
import { requalifyAthlete, renderMarkdown, countCandidates } from "./requalifyCore";
import { readOnlyPgOptions } from "./readOnly";
import type { Classification } from "../../skills/dealDetector";
import { parseModelQualification } from "../../skills/dealQualification";
import { athletes, deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";

let athleteId: string;

function cls(over: Record<string, unknown>): Classification {
  const raw = {
    channel: "direct", claims_known_brand: false, qualification: "needs_terms",
    qualification_reason: "A brand asks to talk.", cash_amount: null, comp_kind: "none",
    work_kind: "social_post", work_units: null, ...over,
  };
  return {
    category: (over.category as any) ?? "PAID", is_deal: true, confidence: 0.9,
    brand_name: "Brand", brand_domain: null, advertiser: (over.advertiser as string) ?? "Brand",
    agency_name: (over.agency_name as string) ?? null, via_agency: !!over.agency_name,
    summary: "", offer_amount: null, deliverables: [], deadline: null, contact_name: null, contact_email: null,
    model_qualification: parseModelQualification(raw),
  };
}

async function seedDeal(brand: string, status: string, subject: string, opts: { withThread?: boolean } = {}) {
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: brand, deal_type: "social_post", status, source: "inbox_scan",
  } as any).returning({ id: deals.id });
  if (opts.withThread === false) return d.id;
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, subject, deal_id: d.id, status: "deal_detected",
    classification: { category: "PAID", brand_name: brand },
  } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", subject, body: `${subject} body`,
    sender_email: `hi@${brand.toLowerCase()}.com`, sender_name: brand, received_at: new Date(),
    external_message_id: `ext-${brand}`, platform: "gmail",
  } as any);
  return d.id;
}

async function snapshot() {
  const [c] = await db.execute(sql`
    select (select count(*) from deals)::int as deals,
           (select count(*) from inbox_threads)::int as threads,
           (select count(*) from inbox_messages)::int as messages,
           (select count(*) from agent_actions)::int as actions,
           (select coalesce(string_agg(classification::text, '|' order by id), '') from inbox_threads) as cls
  `).then((r: any) => r.rows ?? r);
  return c;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  await db.update(athletes).set({ deal_preferences: { minimum_rates: { socialPost: 1000 } } } as any).where(eq(athletes.id, athleteId));
  await seedDeal("Newsco", "detected", "Weekly newsletter");
  await seedDeal("Lowballco", "detected", "Paid UGC");
  await seedDeal("Claimco", "pending", "Collab with a famous brand");
  await seedDeal("Askco", "negotiating", "Partnership idea");
  await seedDeal("Doneco", "accepted", "Signed deal");                        // not open
  await seedDeal("Lonelyco", "detected", "No thread", { withThread: false }); // no thread to read
  await seedDeal("Devteam", "detected", "Test deal please ignore"); // a developer's test email
});

// Config, not code: the dry-run is told which senders are the team's own.
const TEST_SENDERS = "someone@elsewhere.example, devteam.com";

afterAll(async () => { await closeTestDb(); });

const byBrand: Record<string, Classification> = {
  Newsco:    cls({ qualification: "not_relevant", qualification_reason: "A marketing newsletter." }),
  Lowballco: cls({ qualification: "workable", cash_amount: 150, comp_kind: "cash", work_units: 1, agency_name: "Agency One", advertiser: "Lowballco" }),
  Claimco:   cls({ channel: "unverifiable", claims_known_brand: true, qualification: "workable" }),
  Askco:     cls({}),
};

describe("requalifyDryRun core", () => {
  it("re-qualifies open deals under a READ-ONLY session and writes nothing", async () => {
    const before = await snapshot();
    const classify = jest.fn(async (from: string) => {
      const brand = Object.keys(byBrand).find((b) => from.includes(b))!;
      return byBrand[brand];
    });

    await client.exec("SET default_transaction_read_only = on");
    let report;
    try {
      report = await requalifyAthlete({ dbx: db, athleteId, limit: 10, classify, now: new Date("2026-10-05T00:00:00Z"), testSenders: TEST_SENDERS });
    } finally {
      await client.exec("SET default_transaction_read_only = off");
    }

    expect(await snapshot()).toEqual(before);           // nothing changed
    expect(classify).toHaveBeenCalledTimes(4);          // open deals with a thread, possible tests skipped

    expect(report.open_deals_total).toBe(6);
    expect(report.examined).toBe(4);
    // The developer's test email: listed separately, never classified, in no count.
    expect(report.possible_tests).toHaveLength(1);
    expect(report.possible_tests[0]).toMatchObject({ brand: "Devteam", possible_test: 'internal sender + "test" in subject/body' });
    expect(report.rows.find((r) => r.brand === "Devteam")).toBeUndefined();
    expect(report.test_senders_configured).toEqual({ addresses: 1, domains: 1 });
    const row = (b: string) => report.rows.find((r) => r.brand === b)!;
    expect(row("Newsco")).toMatchObject({ qualification: "not_relevant", flag_action: "file", status: "detected" });
    expect(row("Lowballco")).toMatchObject({ qualification: "below_floor", flag_action: "keep", agency: "Agency One", channel: "direct" });
    expect(row("Lowballco").floor_check).toMatchObject({ cash: 150, floor: 1000 });
    expect(row("Claimco")).toMatchObject({ qualification: "verify_first", flag_action: "mark_verify" });
    expect(row("Askco")).toMatchObject({ qualification: "needs_terms", flag_action: "keep" });

    expect(report.counts_by_state).toEqual({ not_relevant: 1, below_floor: 1, verify_first: 1, needs_terms: 1 });
    expect(report.counts_by_action).toEqual({ file: 1, keep: 2, mark_verify: 1 });
    expect(report.changes.map((c) => c.brand).sort()).toEqual(["Claimco", "Newsco"]);

    const md = renderMarkdown(report);
    expect(md).toContain("Changes vs today (2)");
    expect(md).toContain("file (would not have been minted)");
    expect(md).toContain("read-only");
    expect(md).toContain("Possible test emails — excluded from every count above (1)");
    expect(md).not.toContain("devteam.com");             // the configured list itself is never printed

    // A developer report of her own deals, never a copy of her mail: no message body in
    // either output (Google API Limited Use).
    const json = JSON.stringify(report);
    for (const subject of ["Weekly newsletter", "Paid UGC", "Collab with a famous brand", "Partnership idea", "Test deal please ignore"]) {
      expect(json).not.toContain(`${subject} body`);
      expect(md).not.toContain(`${subject} body`);
    }
  });

  it("with no internal senders configured, nothing is treated as a test", async () => {
    const classify = jest.fn(async () => byBrand.Askco);
    const report = await requalifyAthlete({ dbx: db, athleteId, limit: 10, classify, testSenders: "" });
    expect(report.possible_tests).toHaveLength(0);
    expect(report.rows.find((r) => r.brand === "Devteam")).toBeDefined();
  });

  it("the read-only session really refuses a write (the guarantee the core relies on)", async () => {
    await client.exec("SET default_transaction_read_only = on");
    try {
      await expect(db.update(deals).set({ status: "rejected" } as any).where(eq(deals.athlete_id, athleteId))).rejects.toThrow(/read-only/);
    } finally {
      await client.exec("SET default_transaction_read_only = off");
    }
  });

  it("honours --limit and estimates calls before anything is classified", async () => {
    expect(await countCandidates(db, athleteId, 2)).toEqual({ total: 6, withThread: 5, willClassify: 2 });
    const classify = jest.fn(async () => byBrand.Askco);
    const report = await requalifyAthlete({ dbx: db, athleteId, limit: 2, classify });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(report.examined).toBe(2);
  });

  it("a classify failure is reported, not guessed", async () => {
    const classify = jest.fn(async () => ({ ...byBrand.Askco, llm_error: true }));
    const report = await requalifyAthlete({ dbx: db, athleteId, limit: 1, classify });
    expect(report.rows[0]).toMatchObject({ flag_action: "error", qualification: null });
  });

  it("the CLI's session options make every transaction read-only", () => {
    expect(readOnlyPgOptions(undefined)).toBe("-c default_transaction_read_only=on");
    expect(readOnlyPgOptions("-c statement_timeout=0")).toBe("-c statement_timeout=0 -c default_transaction_read_only=on");
    expect(readOnlyPgOptions("-c default_transaction_read_only=on")).toBe("-c default_transaction_read_only=on");
  });
});
