/**
 * opportunityDetail — the card's letter (PR 4 detail slice), against PGlite. Derived fields only; the action
 * hierarchy is fixed; "Looks signed" is a flag, never a state change; tenancy holds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { draftText, readOpportunityDetail, takeFor } from "./opportunityDetail";

const NOW = new Date("2026-10-07T12:00:00Z");
const CONFIRMED = { identity: { status: "confirmed", domain: "gorjana.example", own_sources: ["gorjana.example"], basis: "own_domain_source", checked_at: "" } };
let athleteId = "";
let otherAthlete = "";
const opp: Record<string, string> = {};

async function seed(name: string, o: {
  qualification?: string; channel?: string; category?: string; mediaKind?: string; reason?: string; agency?: string; ask?: string;
  dealStatus?: string; stage?: string; read?: string; offer?: string; draft?: string; outbound?: boolean; enrichment?: unknown; brandDomain?: string;
  tier?: string; description?: string; status?: "open" | "closed"; athlete?: string; laterIn?: string;
}) {
  const who = o.athlete ?? athleteId;
  const at = new Date("2026-09-20T12:00:00Z");
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${who.slice(0, 4)}`, enrichment: o.enrichment ?? null, brand_tier: o.tier ?? null, description: o.description ?? null, category: o.enrichment ? "Jewelry" : null } as any).returning({ id: inboxBrands.id });
  const [op] = await db.insert(opportunities).values({ athlete_id: who, brand_id: b.id, status: o.status ?? "open", opened_at: at, last_activity_at: at,
    ...(o.status === "closed" ? { close_reason: "expired", closed_at: NOW } : {}) } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: name, status: o.dealStatus ?? "detected", opportunity_id: op.id } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, deal_id: d.id, brand_id: b.id, subject: "x", status: "deal_detected", message_count: 2, latest_draft: o.draft ?? null,
    classification: { qualification: o.qualification ?? "needs_terms", channel: o.channel ?? "direct", qualification_reason: o.reason ?? "",
      category: o.category ?? "PAID", ...(o.mediaKind ? { media_kind: o.mediaKind } : {}), ...(o.agency ? { agency_name: o.agency } : {}), ...(o.brandDomain ? { brand_domain: o.brandDomain } : {}) },
    conversation_state: { ...(o.read ? { conversation_state: o.read } : {}), ...(o.stage ? { deal_stage: o.stage } : {}), ...(o.offer ? { offer_display: o.offer } : {}),
      key_details: { ask: o.ask ?? null, awaiting_response_from: "athlete", offer_struct: null } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
  await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: at } as any);
  if (o.outbound) await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "outbound", received_at: at } as any);
  if (o.laterIn) await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: new Date(o.laterIn) } as any);
  opp[name] = op.id;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  otherAthlete = await seedAthlete("Someone Else");
  await seed("INIU", { channel: "agency", reason: "The brand is asking for your rates.", ask: "1 video + 3-month bio link + copyright license", read: "INIU sent 2 unanswered emails; you haven't replied.", laterIn: "2026-09-24T12:00:00Z" });
  await seed("Harrison", { category: "MEDIA", mediaKind: "feature", ask: "collaborate on a video", read: "Harrison asked you to collaborate on a video." });
  await seed("Chevrolet", { qualification: "verify_first", channel: "unverifiable", brandDomain: "msg-biz.online", reason: "Unverifiable sender." });
  await seed("gorjana", { dealStatus: "accepted", stage: "signed", outbound: true, enrichment: CONFIRMED, tier: "established", description: "Jewelry brand.", offer: "$7.5K cash + $6.5K product", draft: "Thanks — here are my picks." });
  await seed("Signedlook", { dealStatus: "negotiating", stage: "signed", outbound: true, read: "They sent the agreement; you replied." });
  await seed("Closedco", { status: "closed" });
  await seed("Theirs", { athlete: otherAthlete });
});
afterAll(async () => { await closeTestDb(); });

it("needs terms via an agency: Ask for terms primary, Decline subordinate; reasons carry sources; unknowns from the extraction", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["INIU"], NOW))!;
  expect(d.primary).toEqual({ action: "ask_for_terms", label: "Ask for terms" });
  expect(d.secondary).toEqual([{ action: "decline", label: "Decline" }]);
  expect(d.ask).toBe("1 video + 3-month bio link + copyright license");
  expect(d.reasons.map((r) => r.source)).toEqual(["from their email", "from the sender’s address", "from the dates"]);
  // Plain, athlete-facing sources only: no pipeline names.
  for (const r of d.reasons) expect(r.source).not.toMatch(/classifier|qualification|timing/i);
  expect(d.unknowns).toEqual(expect.arrayContaining(["fee", "dates"]));
  expect(d.item.whats_new?.text).toBe("INIU sent 2 unanswered emails; you haven't replied.");
  expect(d.deck).toMatchObject({ confirmed: false, description: null, images: [] });
  expect(d.deck.unconfirmed_reason).toMatch(/agency/);
});

it("a media request is answered: Reply primary; a request reason first", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["Harrison"], NOW))!;
  expect(d.primary.action).toBe("reply");
  expect(d.item.kind_label).toBe("Feature");
  expect(d.reasons[0].source).toBe("from their email");
  // Plain words for what is asked, never the rule behind it ("not a sale", "never asked for a budget").
  expect(d.reasons[0].text).toBe("They’re asking for your time (feature), not offering a paid deal.");
  for (const r of d.reasons) expect(r.text).not.toMatch(/not a sale|never asked for a budget|answered,/i);
});

it("a deal under way has no second deal screen to open: no 'Deal details' secondary", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["gorjana"], NOW))!;
  expect(d.secondary.map((s) => s.action)).not.toContain("open_deal");
  expect(d.item.next.action).toBe("confirm_signed"); // looks signed: confirming is the one thing to do
});

it("What's new is only news: shown when they wrote again after the first message, hidden when the read is the original outreach", async () => {
  const later = (await readOpportunityDetail(athleteId, opp["INIU"], NOW))!;
  expect(later.item.whats_new).toEqual({ at: "2026-09-24T12:00:00.000Z", text: "INIU sent 2 unanswered emails; you haven't replied." });
  const onlyOutreach = (await readOpportunityDetail(athleteId, opp["Harrison"], NOW))!;
  expect(onlyOutreach.item.whats_new).toBeNull();
  // Her own reply is not news from them.
  const herReplyOnly = (await readOpportunityDetail(athleteId, opp["Signedlook"], NOW))!;
  expect(herReplyOnly.item.whats_new).toBeNull();
});

it("verify first: Decline is the one primary action, verify is secondary; the sender domain is named", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["Chevrolet"], NOW))!;
  expect(d.primary).toEqual({ action: "decline", label: "Decline" });
  expect(d.secondary).toEqual([{ action: "verify", label: "Ask who they are" }]);
  expect(d.reasons.map((r) => r.text)).toContain("The sending domain is msg-biz.online, not the brand’s own.");
  expect(d.unknowns[0]).toBe("who they really are");
});

it("a confirmed brand in motion: research on the deck, the agreed offer line, Nomila's saved draft", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["gorjana"], NOW))!;
  expect(d.deck).toMatchObject({ confirmed: true, description: "Jewelry brand.", unconfirmed_reason: null });
  expect(d.terms).toBe("$7.5K cash + $6.5K product");
  expect(d.draft).toBe("Thanks — here are my picks.");
  // Agreed is not Signed: the conversation reads signed and she hasn't confirmed it, so she is asked.
  expect(d.looks_signed).toBe(true);
  expect(d.signed_evidence.map((e) => e.kind)).toEqual(["summary"]);
  expect(d.signed).toBeNull();
  expect(d.primary.action).toBe("reply");
});

it("Looks signed is a flag only — the deal's status is untouched", async () => {
  const d = (await readOpportunityDetail(athleteId, opp["Signedlook"], NOW))!;
  expect(d.looks_signed).toBe(true);
  const [row] = await db.select().from(deals).where(eq(deals.opportunity_id, opp["Signedlook"]));
  expect(row.status).toBe("negotiating");
});

it("a closed opportunity opens read-only; another athlete's opportunity has no letter", async () => {
  const closed = await readOpportunityDetail(athleteId, opp["Closedco"], NOW);
  expect(closed).toMatchObject({ read_only: true, secondary: [] });
  expect(await readOpportunityDetail(athleteId, opp["Theirs"], NOW)).toBeNull();
});

it("Nomila's take is short: at most two sentences, never a recap", () => {
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  const base: any = { kind: "deal", state: "needs_terms", channel: "direct", qualification: "needs_terms", stage: null };
  for (const v of [base, { ...base, kind: "interview" }, { ...base, qualification: "verify_first" }, { ...base, state: "below_floor" }, { ...base, stage: "Agreed" }]) {
    expect(sentences(takeFor(v, { looksSigned: false }))).toBeLessThanOrEqual(2);
  }
});

it("the saved draft shows whether it is stored as an object (today) or a bare string (older rows)", () => {
  expect(draftText({ body: "Hi Sam, thanks.", tone: "friendly", reply_intent: "accept" })).toBe("Hi Sam, thanks.");
  expect(draftText("Hi Sam.")).toBe("Hi Sam.");
  expect(draftText({ body: "   " })).toBeNull();
  expect(draftText({ tone: "friendly" })).toBeNull();
  expect(draftText(null)).toBeNull();
});
