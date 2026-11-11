/**
 * opportunityBoard — the ONE reader of the open opportunities (Opportunities PR 3), against PGlite.
 * Sections are rules; the order is lib/opportunityOrder; nothing here calls a model or writes.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { dealLines, dealPositions, readOpportunityBoard } from "./opportunityBoard";

const NOW = new Date("2026-10-06T12:00:00Z");
const CONFIRMED = (domain: string) => ({ identity: { status: "confirmed", domain, own_sources: [domain], basis: "own_domain_source", checked_at: "2026-10-06" } });
const UNCONFIRMED = { identity: { status: "unconfirmed", domain: null, own_sources: [], basis: "no_domain_evidence", checked_at: "2026-10-06" } };

let athleteId = "";
const ids: Record<string, { opp: string; deal: string; thread: string }> = {};

async function seed(name: string, o: {
  tier?: string | null; enrichment?: unknown; category?: string; domain?: string; logo?: string;
  qualification?: string | null; channel?: string; reason?: string; offer?: Record<string, unknown>; ask?: string; threadCategory?: string; mediaKind?: string; read?: string; agency?: string;
  awaiting?: string; lastIn: string; firstIn?: string; outbound?: boolean; dealStatus?: string; cash?: number; status?: "open" | "closed"; goingQuiet?: boolean;
}) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), brand_tier: o.tier ?? null, enrichment: o.enrichment ?? null, category: o.category ?? null, domain: o.domain ?? null, logo_url: o.logo ?? null } as any).returning({ id: inboxBrands.id });
  const at = new Date(o.lastIn);
  const [opp] = await db.insert(opportunities).values({
    athlete_id: athleteId, brand_id: b.id, status: o.status ?? "open", opened_at: at, last_activity_at: at,
    ...(o.status === "closed" ? { close_reason: "expired", closed_at: NOW } : {}),
    ...(o.goingQuiet ? { going_quiet_at: NOW } : {}),
  } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: o.dealStatus ?? "detected", opportunity_id: opp.id, amount_cash: o.cash ?? null } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: `${name} subject`, status: "deal_detected",
    classification: o.qualification === null ? {} : { qualification: o.qualification ?? "needs_terms", channel: o.channel ?? "direct", qualification_reason: o.reason ?? "", ...(o.threadCategory ? { category: o.threadCategory } : {}), ...(o.mediaKind ? { media_kind: o.mediaKind } : {}), ...(o.agency ? { agency_name: o.agency } : {}) },
    conversation_state: { ...(o.read ? { conversation_state: o.read } : {}), key_details: { ask: o.ask ?? null, awaiting_response_from: o.awaiting ?? "athlete", offer_struct: o.offer ?? null } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(require("drizzle-orm").eq(opportunities.id, opp.id));
  if (o.firstIn) await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", received_at: new Date(o.firstIn) } as any);
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", received_at: at } as any);
  if (o.outbound) await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "outbound", received_at: at } as any);
  ids[name] = { opp: opp.id, deal: d.id, thread: t.id };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  await seed("gorjana", { tier: "established", enrichment: CONFIRMED("gorjana.com"), qualification: "needs_terms", lastIn: "2026-10-06", firstIn: "2026-09-20", outbound: true, dealStatus: "accepted", awaiting: "athlete", read: "They asked for your five jewelry picks." });
  await seed("Chevrolet", { qualification: "verify_first", channel: "unverifiable", lastIn: "2026-09-17" });
  await seed("INIU", { tier: "established", enrichment: CONFIRMED("iniu.com"), category: "Tech Accessories", qualification: "needs_terms", channel: "agency", ask: "1 video + bio link", lastIn: "2026-08-26" });
  await seed("MUDWTR", { tier: "established", enrichment: CONFIRMED("mudwtr.com"), qualification: "workable", channel: "agency", offer: { unit: "gifting_only" }, lastIn: "2026-10-01" });
  await seed("MPG", { domain: "mpgummies.example", logo: "https://logo.example/mpg.png", tier: "emerging", enrichment: CONFIRMED("mpgummies.com"), qualification: "workable", offer: { unit: "gifting_only" }, lastIn: "2026-08-29" });
  await seed("StartX1", { tier: null, enrichment: UNCONFIRMED, qualification: "needs_terms", ask: "a paid partnership", lastIn: "2026-09-14" });
  await seed("Harrison", { qualification: "needs_terms", ask: "a Day in the Life video", lastIn: "2026-09-25" });
  await seed("StanEats", { qualification: "needs_terms", lastIn: "2026-09-22", read: "Stan Eats asked about a collaboration." });
  await seed("Podcast", { qualification: "needs_terms", threadCategory: "MEDIA", mediaKind: "podcast", ask: "a podcast interview", lastIn: "2026-06-01" });
  await seed("HomeImprovement", { qualification: "needs_terms", channel: "agency", agency: "Jelly Otter", ask: "3 Instagram Reels", lastIn: "2026-08-29" });
  await seed("Jaambu", { qualification: "workable", channel: "unverifiable", reason: "Terms are stated (cash plus product)", lastIn: "2026-09-29" });
  await seed("Legacy", { qualification: null, lastIn: "2026-09-01" });
  await seed("Quiet", { qualification: "needs_terms", lastIn: "2026-07-01", goingQuiet: true, awaiting: "brand" });
  await seed("Filed", { qualification: "needs_terms", lastIn: "2026-07-01", status: "closed" });
});
afterAll(async () => { await closeTestDb(); });

it("puts every open opportunity in exactly one section, by rule", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const names = (xs: any[]) => xs.map((x) => x.brand.name);
  // What matters = the first five of "needs you": a deal under way waiting on her first, then new opportunities in
  // opportunityOrder (decision D3: her move, then state, then cash, the confirmed tier only a tiebreak, then newest;
  // unverifiable last). The channel is no longer a key, so the agency's HomeImprovement no longer sorts below Podcast.
  expect(names(b.needsYou)).toEqual(["gorjana", "INIU", "Harrison", "StanEats", "StartX1", "HomeImprovement", "Podcast", "MUDWTR", "MPG", "Jaambu", "Legacy"]);
  expect(names(b.whatMatters)).toEqual(["gorjana", "INIU", "Harrison", "StanEats", "StartX1"]);
  expect(names(b.inMotion)).toEqual([]); // gorjana waits on her, so it is in What matters, not twice
  expect(names(b.toVerify)).toEqual(["Chevrolet"]);
  // Quiet is their move (never "needs you"); below the cut, a needs-terms deal is in the ask-for-terms batch
  expect(names(b.needsTermsBatch)).toEqual(["HomeImprovement", "Quiet"]); // D3: her move (HomeImprovement) first
  // an interview request keeps its place in the order but is never in the ask-for-terms batch
  expect(names(b.explore)).toEqual(["Podcast", "MUDWTR", "MPG", "Jaambu", "Legacy"]);
  expect(names(b.goingQuiet)).toEqual(["Quiet"]);
  expect(b.counts).toEqual({ open: 13, inMotion: 0, toVerify: 1, filed: 1, needsYou: 11 });
  expect(b.order).toHaveLength(13);
  const podcast = b.explore[0];
  expect(podcast).toMatchObject({ kind: "interview", line: "Interview request · Their ask: A podcast interview · Waiting on you since Jun 1" });
});

it("reads standing only from confirmed research, and shows a category only when confirmed", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const all = [...b.whatMatters, ...b.needsTermsBatch, ...b.explore];
  const by = (n: string) => all.find((x) => x.brand.name === n)!;
  expect(by("INIU")).toMatchObject({ standing: "established", brand: { category: "Tech Accessories", research_confirmed: true } });
  expect(by("StartX1")).toMatchObject({ standing: "none", brand: { tier: null, research_confirmed: false } });
  // Paid with no amount named (stored "cash plus product", no figure anywhere) reads as needs_terms, never terms in (23 Oct).
  expect(by("Jaambu")).toMatchObject({ standing: "unverifiable", state: "needs_terms", qualification: "needs_terms" });
  expect(by("StartX1").qualification).toBe("needs_terms"); // unconfirmed research never becomes verify-first
});

it("writes template lines and marks overdue (her move > 7 days) as the only blue", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const iniu = b.whatMatters[1];
  expect(iniu.line).toBe("Via an agency · Their ask: 1 video + bio link · no fee yet · Waiting on you since Aug 26");
  expect(b.whatMatters[0].line).toBe("Agreed · Waiting on you since Oct 6"); // stage, not the stale first-email qualification
  expect(iniu.overdue).toBe(true);
  expect(b.explore.find((x) => x.brand.name === "MUDWTR")!.overdue).toBe(false); // 5 days
  expect(b.needsTermsBatch.find((x) => x.brand.name === "Quiet")!.overdue).toBe(false); // their move
});

it("gives every member deal its opportunity's position and line (for /deals and Mila)", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const pos = dealPositions(b);
  expect(pos.get(ids["gorjana"].deal)).toBe(0);
  expect(pos.get(ids["INIU"].deal)).toBe(1);
  expect(pos.get(ids["Chevrolet"].deal)).toBe(12);
  expect(pos.has(ids["Filed"].deal)).toBe(false);
  expect(dealLines(b).get(ids["MPG"].deal)).toBe("Product only, no cash · Waiting on you since Aug 29");
});

it("PR 4: kind label, poster type, what's new, stage and via — all derived fields", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const all = [...b.whatMatters, ...b.needsTermsBatch, ...b.inMotion, ...b.explore, ...b.toVerify];
  const by = (n: string) => all.find((x) => x.brand.name === n)!;
  expect(by("Podcast")).toMatchObject({ kind: "interview", kind_label: "Podcast", poster: "request" });
  expect(by("MPG")).toMatchObject({ poster: "product", kind_label: null });
  expect(by("StartX1")).toMatchObject({ poster: "paid", brand: { image_url: null, research_confirmed: false } });
  expect(by("HomeImprovement")).toMatchObject({ via: "Jelly Otter", channel: "agency" });
  expect(by("gorjana")).toMatchObject({ stage: "Agreed", whats_new: { text: "They asked for your five jewelry picks." } });
  expect(by("Harrison").whats_new).toBeNull();
  // What's new is only news: a read of the ORIGINAL outreach (their only message) is not shown as new.
  expect(by("StanEats").whats_new).toBeNull();
  expect(by("gorjana").whats_new?.at).toBe("2026-10-06T00:00:00.000Z"); // their later message, after the first
  // the logo is safe only from the brand's own (evidence) domain; a request with no domain is a person
  expect(by("MPG").brand).toMatchObject({ safe_logo_url: "https://logo.example/mpg.png", is_person: false });
  expect(by("StartX1").brand.safe_logo_url).toBeNull();
  expect(by("Podcast").brand.is_person).toBe(true);
});
