/**
 * routes/meKnowledge.test.ts — Concept 0.4 Slice 1 read models on PGlite (GET /me/overview, GET /me/knowledge).
 *
 *   S1 the source label is derived from canonical provenance only (origin / sourceClass / authorityTier / kindOfFact / lineage)
 *   S2 legacy compatibility data never shows: no blob values, no story_arc, no athletes_current score
 *   S3 counts = present entries with status current (historical / disputed / missing are not counted); no "verified"
 *   S4 registry facts the contract did not carry (ranking, national team, season statistic, endorsement) are emitted
 *   S5 said wins for display and every said-field names the asserted field PUT /me/record/:field corrects
 *   S6 identity is factual: "<team> <sport>" from the canonical affiliation + sport, nothing interpretive; Story `coming`;
 *      M.I.A. is the Slice 2 entry (no read here ⇒ no_assessment, no score)
 *   S7 athlete-only: the session's athlete, 404 for an unknown one
 *   S8 inbox-accepted deals (deals.source inbox_scan, status accepted|completed) show as partners "From your inbox";
 *      athlete-confirmed keep "From your deals" and win on overlap; not-accepted / rejected never show; one brand counts once;
 *      no amounts
 *   S10 researchAsOf only moves on research that refreshed something shown: a newer failed/partial run (or a fresh
 *       `signals` domain) never advances it; only-failed research reads null (unknown), never the run or legacy date
 *   S11 research evidence in every ACCEPTED lineage (CITED_LINEAGES: cited, native_supported, native_retrieved) shows as
 *       press / "Seen with"; native_retrieved carries the weaker "page not confirmed" detail (#706 site_only);
 *       asserted_only / uncited / conflicting never show; none of them is counted as omitted legacy
 *   S12 knowledge/3 "This isn't right": POST /me/knowledge/disputes writes an athlete_asserted `dispute` row (fact /
 *       evidence ref when the entry has one, else the entry id); the entry then reads unconfirmed with her words and is
 *       not counted; 404 for an entry that is not hers, 409 for nothing on record, 400 for a bad body
 *   S13 knowledge/3 read model: a fact-backed found team is shown with its tier and an official logo domain; at a glance
 *       holds nationality + class; academics is present with an education fact; per-entry tier on every present entry
 *   S9 confirmedPartnersFor (deck / athleteContext / canonical build) is unchanged by the inbox work: same selection,
 *      same spelling (last row seen per brand), same order (biggest amount first)
 * Nothing here reaches a provider: the builder and the view are provider-free.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import meKnowledgeRouter from "./meKnowledge";
import { athleteAffiliations, athleteAsserted, athleteFacts, athleteResearchState, researchEvidence, researchRuns, deals } from "../../shared/schema";
import { and, eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb } from "../testUtils/pgliteDb";
import { seedCanonicalAthlete, seedLegacyAthlete, textOf, T1 } from "../services/intelligence/context/testFixtures";
import { confirmedPartnersFor } from "../services/snapshotDeals";
import { inboxAcceptedPartnersFor } from "../services/athleteKnowledge";
import { evidenceSourceOf, sourceOf, SITE_ONLY_DETAIL, SOURCE_LABELS, type AthleteKnowledge, type KnowledgeEntry } from "../services/intelligence/context/views/knowledge";

jest.setTimeout(180_000);   // PGlite schema push + fixtures exceed the 30 s default on a cold worker

const g = globalThis as any;
let server: Server; let base = "";
const ids: Record<string, string> = {};
const get = async (path: string, athleteId: string) => { g.__TEST_ATHLETE_ID = athleteId; const r = await fetch(`${base}/api/v1/me${path}`); return { status: r.status, body: await r.json().catch(() => undefined) }; };
const post = async (path: string, athleteId: string, body: unknown) => { g.__TEST_ATHLETE_ID = athleteId; const r = await fetch(`${base}/api/v1/me${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
const entries = (k: AthleteKnowledge): KnowledgeEntry[] => [...k.keyFacts, ...k.categories.flatMap((c) => c.sections.flatMap((s) => s.entries))];
const byId = (k: AthleteKnowledge, id: string) => entries(k).find((e) => e.id === id);
/** The deal amounts seeded below (deals.amount is NUMERIC, stored from strings) — S8 asserts none of them reaches the response. */
const AMOUNT_INBOX = 14321, AMOUNT_INBOX_2 = 5000, AMOUNT_CONTRACT = 900;
const SEEDED_AMOUNTS = [AMOUNT_INBOX, AMOUNT_INBOX_2, AMOUNT_CONTRACT];
/** Every [key, value] pair in a response, walked recursively — to assert what it does NOT carry without text-searching its random ids. */
const entriesDeep = (v: unknown): Array<[string, unknown]> => (v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [[k, x] as [string, unknown], ...entriesDeep(x)]) : []);
/** Deal money fields (deals / deal_periods / deal_installments, snake + camel) and generic money names. `value` is not one: it is every entry's display text. */
const MONEY_KEYS = ["amount", "amount_cash", "amountCash", "amount_product", "amountProduct", "commission_pct", "commissionPct", "cash_cents", "cashCents", "product_cents", "productCents", "product_directed_cents", "productDirectedCents", "amount_cents", "amountCents", "price", "fee", "compensation", "payment", "money"];
/** A leaf as a money figure: a number, or a purely numeric string ("900", "14,321", "$5000.00"); anything else is not a figure. */
const asFigure = (x: unknown): number | null => (typeof x === "number" ? x : typeof x === "string" && /^\$?\d[\d,]*(\.\d+)?$/.test(x.trim()) ? Number(x.trim().replace(/[$,]/g, "")) : null);

beforeAll(async () => {
  await initTestDb();
  ids.canon = await seedCanonicalAthlete({ brandDomain: "populated", name: "Canon Cole" });
  ids.legacy = await seedLegacyAthlete();
  // Registry facts the contract did not carry, plus an evidence-backed fact and a disputed one.
  const [run] = await db.insert(researchRuns).values({ athlete_id: ids.canon, domain: "achievements", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
  const [ev] = await db.insert(researchEvidence).values({ athlete_id: ids.canon, run_id: run.id, kind: "achievement", claim: { name: "x" } as any, lineage_status: "cited", source_url: "https://league.example/honours", source_domain: "league.example", source_type: "official_governing_body", retrieved_at: T1, confidence: "0.9", source_class: "web_researched", suspect: false, dedupe_key: "ach:official" } as any).returning({ id: researchEvidence.id });
  const fact = (key: string, value: unknown, over: Partial<{ status: string; tier: number | null; sourceClass: string; evidenceIds: string[] }> = {}) =>
    db.insert(athleteFacts).values({ athlete_id: ids.canon, fact_key: key, value: value as any, value_text: JSON.stringify(value), status: over.status ?? "current", retrieved_at: T1, origin: "research", source_class: over.sourceClass ?? "web_researched", authority_tier: over.tier === undefined ? 3 : over.tier, confidence: "0.8", provenance: { evidenceIds: over.evidenceIds ?? [] } as any, freshness_family: "achievements", resolver_version: "v1", registry_version: "v2" } as any);
  await fact("ranking", { body: "Top Drawer", rank: 12, year: 2025, scope: "national" });
  await fact("national_team_participation", { team: "U-20 National Team", level: "youth", year: 2024, event: "Qualifier" }, { tier: 1 });
  await fact("season_statistic", { metric: "goals", value: "9", season: 2025, competition: "League" });
  await fact("endorsement", { brand: "Brand Z", dealType: "ambassador" }, { tier: 5 });
  await fact("award", { name: "Player of the Week", year: 2025 }, { tier: 2, evidenceIds: [ev.id] });
  await fact("award", { name: "Contested Award", year: 2025 }, { status: "disputed" });
  await fact("graduation_year", { year: 2027 }, { sourceClass: "platform_public", tier: null });   // the DB admits no inferred class on a fact
  // A confirmed deal (athlete-confirmed source) ⇒ proof.
  await db.insert(deals).values({ athlete_id: ids.canon, brand_name: "Brand P", status: "accepted", source: "self_reported" } as any);
  // Inbox-mined deals: accepted on two threads (one brand), completed, overlapping a confirmed brand, and not accepted.
  await db.insert(deals).values([
    { athlete_id: ids.canon, brand_name: "Brand Inbox", status: "accepted", source: "inbox_scan", amount: String(AMOUNT_INBOX) },
    { athlete_id: ids.canon, brand_name: "brand inbox ", status: "accepted", source: "inbox_scan", amount: String(AMOUNT_INBOX_2) },
    { athlete_id: ids.canon, brand_name: "Brand Done", status: "completed", source: "inbox_scan" },
    { athlete_id: ids.canon, brand_name: "brand p", status: "accepted", source: "inbox_scan" },
    { athlete_id: ids.canon, brand_name: "Brand C", status: "accepted", source: "contract_upload", amount: String(AMOUNT_CONTRACT) },
    { athlete_id: ids.canon, brand_name: "Brand C", status: "accepted", source: "inbox_scan" },
    { athlete_id: ids.canon, brand_name: "Brand Detected", status: "detected", source: "inbox_scan" },
    { athlete_id: ids.canon, brand_name: "Brand Negotiating", status: "negotiating", source: "inbox_scan" },
    { athlete_id: ids.canon, brand_name: "Brand Rejected", status: "rejected", source: "inbox_scan" },
  ] as any);

  const app = express(); app.use(express.json()); app.use("/api/v1/me", meKnowledgeRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

describe("S1 source labels from canonical provenance", () => {
  it("maps every origin / class / tier to one label (legacy_blob is not shown)", () => {
    const f = (origin: string, sourceClass: string | null = null, authorityTier: number | null = null) => sourceOf({ origin, sourceClass, authorityTier } as any);
    expect(f("athlete_asserted")?.key).toBe("you");
    expect(f("legacy_row")).toEqual({ key: "you", label: SOURCE_LABELS.you, detail: "at signup" });
    expect(f("athlete_proof")?.key).toBe("proof");
    expect(f("connection", "connected_verified")?.key).toBe("connected");
    expect(f("research", "web_researched", 1)?.key).toBe("official");
    expect(f("research", "web_researched", 2)?.key).toBe("official");
    expect(f("research", "web_researched", 3)?.key).toBe("researched");
    expect(f("research", "platform_public", null)?.key).toBe("researched");
    expect(f("research", "inferred", null)?.key).toBe("inferred");
    expect(f("backfill", "web_researched", 5)).toEqual({ key: "researched", label: "Researched", detail: "earlier research" });
    expect(f("legacy_blob")).toBeNull();
    expect(Object.values(SOURCE_LABELS).join(" ").toLowerCase()).not.toContain("verified");
  });

  it("labels the canonical athlete's entries by their real provenance", async () => {
    const { status, body } = await get("/knowledge", ids.canon);
    expect(status).toBe(200);
    const k = body as AthleteKnowledge;
    expect(byId(k, "hometown")).toMatchObject({ value: "Springfield, IL, US", state: "present", source: { key: "official" } });   // tier 2
    expect(k.keyFacts[1]).toMatchObject({ label: "School", value: "Canon University", source: { key: "you" } });                               // said affiliation
    // knowledge/3: a legacy `found` ledger row (no fact_id) is not shown (S13 covers a fact-backed found row)
    expect(entries(k).find((e) => e.value?.startsWith("Found FC"))).toBeUndefined();
    const nat = entries(k).find((e) => e.value === "National Champion (2025)");
    expect(nat?.source?.key).toBe("official");                                                                                      // tier 1
    expect(byId(k, "graduation_year")).toMatchObject({ value: "2027", source: { key: "researched" } });
    expect(byId(k, "class_year")).toMatchObject({ stale: true });
    const press = k.categories.find((c) => c.key === "media")!.sections.find((s) => s.key === "press")!.entries;
    expect(press[0]).toMatchObject({ value: "Cole wins", source: { key: "researched", detail: "daily.example" }, evidence: [{ url: "https://daily.example/press_mention", domain: "daily.example" }] });
    const pow = entries(k).find((e) => e.value === "Player of the Week (2025)");
    expect(pow).toMatchObject({ source: { key: "official" }, evidence: [{ url: "https://league.example/honours", domain: "league.example" }] });
    expect(entries(k).find((e) => e.value === "Brand P")?.source?.key).toBe("proof");
  });
});

describe("S2 no legacy data", () => {
  it("the canonical athlete: no blob values, no story_arc, no legacy score", async () => {
    const { body } = await get("/knowledge", ids.canon);
    const t = textOf(body);
    for (const banned of ["Blob", "Brand X", "story arc", "Canonical story arc", "displayScore", "Established", "capitals", "verified"]) expect([banned, t.includes(banned)]).toEqual([banned, false]);
  });

  it("the legacy athlete: blob values are omitted and read as not_yet_computed; her said position still shows", async () => {
    const { body } = await get("/knowledge", ids.legacy);
    const k = body as AthleteKnowledge;
    const t = textOf(k);
    expect(t.includes("Legacy story arc")).toBe(false);
    expect(t.includes("All-Conference")).toBe(false);
    expect(t.includes("Brand X")).toBe(false);
    expect(t.includes("Rising")).toBe(false);
    expect(byId(k, "hometown")).toMatchObject({ value: null, state: "not_yet_computed" });
    expect(byId(k, "position")).toMatchObject({ value: "Striker", source: { key: "you" }, correct: { field: "position", shape: "text" } });
    expect(k.omitted.legacyValues).toBeGreaterThan(0);
  });
});

describe("S3 counts", () => {
  it("counts present current entries only, per category and in total", async () => {
    const { body } = await get("/knowledge", ids.canon);
    const k = body as AthleteKnowledge;
    for (const c of k.categories) {
      if (c.state === "unavailable") { expect(c.count).toBeNull(); continue; }
      const counted = c.sections.flatMap((s) => s.entries).filter((e) => e.state === "present" && e.status === "current");
      expect([c.key, c.count]).toEqual([c.key, counted.length]);
      expect(Object.values(c.bySource).reduce((a, b) => a + (b ?? 0), 0)).toBe(counted.length);
    }
    // the school key fact and the current-team entry are one affiliation: counted once in the total
    const counted = entries(k).filter((e) => e.state === "present" && e.status === "current").map((e) => e.id);
    expect(k.total).toBe(new Set(counted).size);
    expect(k.keyFacts[1].id).toBe(k.categories[0].sections.find((s) => s.key === "teams")!.entries[0].id);
    expect(k.categories.find((c) => c.key === "academics")).toMatchObject({ state: "unavailable", count: null });
    expect(k.categories.find((c) => c.key === "business")).toMatchObject({ state: "unavailable", count: null });
    const disputed = entries(k).find((e) => e.value?.startsWith("Contested Award"));
    // disputed facts are excluded by the builder's achievements section (status != disputed); never counted either way
    if (disputed) expect(disputed.status).toBe("disputed");
  });
});

describe("S4 registry facts the contract did not carry", () => {
  it("ranking, national team, season statistic and endorsement are emitted with their provenance", async () => {
    const { body } = await get("/knowledge", ids.canon);
    const k = body as AthleteKnowledge;
    const vals = entries(k).map((e) => e.value ?? "");
    expect(vals).toContain("#12 national — Top Drawer (2025)");
    expect(vals.find((v) => v.startsWith("U-20 National Team"))).toBeTruthy();
    expect(entries(k).find((e) => e.value?.startsWith("U-20 National Team"))?.source?.key).toBe("official");
    expect(vals).toContain("goals: 9");
    expect(entries(k).find((e) => e.value === "Brand Z")).toMatchObject({ label: "Ambassador", source: { key: "researched" } });
  });
});

describe("S5 corrections reuse PUT /me/record/:field", () => {
  it("said fields name their asserted field; research-only facts name none", async () => {
    const { body } = await get("/knowledge", ids.canon);
    const k = body as AthleteKnowledge;
    expect(byId(k, "position")).toMatchObject({ value: "Striker", source: { key: "you" }, correct: { field: "position" } });
    expect(byId(k, "sport")?.correct?.field).toBe("sport");
    expect(byId(k, "hometown")?.correct?.field).toBe("hometown");
    expect(k.keyFacts[1].correct).toMatchObject({ field: "affiliations", shape: "teams" });
    expect(entries(k).find((e) => e.value === "National Champion (2025)")?.correct).toBeNull();
    expect(byId(k, "name")?.correct).toBeNull();
  });
});

describe("S6 identity + S7 tenancy", () => {
  it("the overview is factual identity + counts; M.I.A. is the My Intelligence entry (Slice 2); Story is coming", async () => {
    const { status, body } = await get("/overview", ids.canon);
    expect(status).toBe(200);
    expect(body.identity).toMatchObject({ displayName: "Cole", fullName: "Canon Cole", primary: { label: "Canon Soccer", org: "Canon University", orgKind: "school", sport: "Soccer" }, facts: ["Striker", "Junior"] });
    // knowledge/2.1: nationality + role ride on the identity (no nationality fact and no affiliation role here ⇒ null; see knowledge.identity.test.ts).
    expect(body.identity).toMatchObject({ nationality: null, role: null });
    // knowledge/2:the slot is the My Intelligence entry (routes/meIntelligence.test.ts proves it equals the page in every state).
    expect(body.version).toBe("knowledge/3");
    expect(body.intelligence).toEqual({ status: "ready", pageState: "no_assessment", score: null, evidenceAsOf: null, preliminary: null });
    expect(body.story).toEqual({ status: "coming" });
    expect(body.knows.total).toBeGreaterThan(0);
    expect(textOf(body).includes("Established")).toBe(false);
  });

  it("reads the session's athlete; an unknown athlete is a 404", async () => {
    const other = await get("/overview", ids.legacy);
    expect(other.body.identity.fullName).toBe("Legacy Lane");
    expect((await get("/knowledge", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("S8 inbox-accepted deals", () => {
  it("appear as partners labelled From your inbox; confirmed keep their label; not-accepted never show; one brand counts once; no amounts", async () => {
    const { body } = await get("/knowledge", ids.canon);
    const k = body as AthleteKnowledge;
    const cat = k.categories.find((c) => c.key === "partnerships")!;
    const yours = cat.sections.find((s) => s.key === "confirmed")!.entries;
    // Evidence strengths stay distinguishable: contract_upload and self_reported keep "From your deals"; inbox_scan reads
    // "From your inbox"; a brand on both (Brand P, Brand C) shows the stronger, athlete-confirmed label, once.
    expect(yours.map((e) => [e.value, e.source?.key, e.source?.label])).toEqual([
      ["Brand C", "proof", "From your deals"],
      ["Brand P", "proof", "From your deals"],
      ["Brand Inbox", "inbox", "From your inbox"],
      ["Brand Done", "inbox", "From your inbox"],
    ]);
    const t = textOf(k);
    for (const banned of ["Brand Detected", "Brand Negotiating", "Brand Rejected"]) expect([banned, t.includes(banned)]).toEqual([banned, false]);
    // no amounts: no money field anywhere, and no leaf carrying a seeded amount (structural — the text holds random ids)
    expect(entriesDeep(k).filter(([key]) => MONEY_KEYS.includes(key))).toEqual([]);
    expect(entriesDeep(k).filter(([, x]) => SEEDED_AMOUNTS.includes(asFigure(x) as number))).toEqual([]);
    // counted once each, consistently with the category tally
    const counted = cat.sections.flatMap((s) => s.entries).filter((e) => e.state === "present" && e.status === "current");
    expect(cat.count).toBe(counted.length);
    expect(cat.bySource.inbox).toBe(2);
    expect(cat.bySource.proof).toBe(2);
    expect(new Set(yours.map((e) => e.id)).size).toBe(yours.length);
    expect(new Set(yours.map((e) => e.value!.toLowerCase())).size).toBe(yours.length);
  });
});

describe("S9 confirmedPartnersFor is unchanged (pre-#701 behaviour)", () => {
  it("same selection, spelling and order for a multi-row brand; inbox deals never enter it", async () => {
    await db.insert(deals).values([
      { athlete_id: ids.legacy, brand_name: "Acme", status: "accepted", source: "self_reported", amount: "100" },
      { athlete_id: ids.legacy, brand_name: "Zed", status: "completed", source: "contract_upload", amount: "500" },
      { athlete_id: ids.legacy, brand_name: "ACME ", status: "accepted", source: "contract_upload", amount: "50" },
      { athlete_id: ids.legacy, brand_name: "Inbox Only", status: "accepted", source: "inbox_scan", amount: "9999" },
      { athlete_id: ids.legacy, brand_name: "Pending", status: "negotiating", source: "self_reported", amount: "9999" },
    ] as any);
    // Biggest first; the spelling is the LAST row seen for the brand ("ACME"), exactly as before.
    expect(await confirmedPartnersFor(ids.legacy)).toEqual(["Zed", "ACME"]);
    expect(await confirmedPartnersFor(ids.canon)).toEqual(["Brand C", "Brand P"]);
    // The Concept 0.4 inbox list is separate and never feeds it.
    expect(await inboxAcceptedPartnersFor(ids.legacy)).toEqual(["Inbox Only"]);
    const inbox = await inboxAcceptedPartnersFor(ids.canon);
    expect(inbox[0]).toBe("Brand Inbox");   // the only inbox brand with an amount; the rest tie on NULL
    expect([...inbox].sort()).toEqual(["Brand C", "Brand Done", "Brand Inbox", "brand p"]);
  });
});

describe("S10 research freshness is truthful", () => {
  const T2 = new Date("2026-09-30T00:00:00Z");
  const failed = (lastResearchedAt: string | null) => ({ status: lastResearchedAt ? "fresh" : "missing", outcome: "failed", lastResearchedAt });

  it("a newer failed/partial run does not advance it; the last successful refresh does", async () => {
    const id = await seedCanonicalAthlete({ brandDomain: "populated", name: "Fresh Fern" });
    // Mia-shaped partial run at T2: only `signals` refreshed, every shown domain failed (their dates stay at T1).
    const t1 = T1.toISOString();
    await db.update(athleteResearchState).set({ last_researched_at: T2, domains: {
      identity: failed(t1), profile: failed(t1), affiliations: failed(null), achievements: failed(t1), press: failed(t1), brand_mentions: failed(t1), social_handles: failed(t1),
      narrative: { status: "fresh", outcome: "refreshed", lastResearchedAt: T2.toISOString() }, signals: { status: "fresh", outcome: "refreshed", lastResearchedAt: T2.toISOString() },
    } as any }).where(eq(athleteResearchState.athlete_id, id));
    const { body } = await get("/knowledge", id);
    expect((body as AthleteKnowledge).researchAsOf).toBe(t1);
  });

  it("only failed research reads null (unknown), not the run's date or the legacy blob's", async () => {
    const id = await seedCanonicalAthlete({ brandDomain: "populated", name: "Never Ned" });
    await db.update(athleteResearchState).set({ last_researched_at: T2, domains: {
      identity: failed(null), profile: failed(null), affiliations: failed(null), achievements: failed(null), press: failed(null), brand_mentions: failed(null), social_handles: failed(null),
      signals: { status: "fresh", outcome: "refreshed", lastResearchedAt: T2.toISOString() },
    } as any }).where(eq(athleteResearchState.athlete_id, id));
    expect(((await get("/knowledge", id)).body as AthleteKnowledge).researchAsOf).toBeNull();
    // The legacy athlete (blob only, no canonical research) is unknown too.
    expect(((await get("/knowledge", ids.legacy)).body as AthleteKnowledge).researchAsOf).toBeNull();
  });

  it("the successful canonical athlete keeps its refresh date", async () => {
    expect(((await get("/knowledge", ids.canon)).body as AthleteKnowledge).researchAsOf).toBe(T1.toISOString());
  });
});

describe("S11 accepted research lineages (cited, native_supported, native_retrieved)", () => {
  const LINEAGES = ["cited", "native_supported", "native_retrieved", "asserted_only", "uncited", "conflicting"] as const;
  const nid: Record<string, string> = {};
  beforeAll(async () => {
    nid.twin = await seedCanonicalAthlete({ brandDomain: "populated", name: "Twin Tate" });       // the same seed, no extra evidence
    nid.native = await seedCanonicalAthlete({ brandDomain: "populated", name: "Native Nia" });
    const [run] = await db.insert(researchRuns).values({ athlete_id: nid.native, domain: "press", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
    for (const lin of LINEAGES) {
      const row = (kind: string, claim: Record<string, unknown>) => ({ athlete_id: nid.native, run_id: run.id, kind, claim: claim as any, lineage_status: lin, source_url: `https://${lin}.example/${kind}`, source_domain: `${lin}.example`, source_type: "major_news", retrieved_at: T1, confidence: "0.80", source_class: "web_researched", suspect: false, dedupe_key: `${kind}:${lin}` });
      await db.insert(researchEvidence).values([row("press_mention", { outlet: `Outlet ${lin}`, headline: `Headline ${lin}` }), row("brand_mention", { brand: `Brand ${lin}`, type: "tagged" })] as any);
    }
  });

  it("maps each lineage: accepted → researched (native_retrieved weaker), legacy / not-accepted → not shown", () => {
    const f = (lineage: string, sourceDomain: string | null = "d.example") => evidenceSourceOf({ lineage, sourceClass: "web_researched", sourceDomain } as any);
    expect(f("cited")).toEqual({ key: "researched", label: "Researched", detail: "d.example" });
    expect(f("native_supported")).toEqual({ key: "researched", label: "Researched", detail: "d.example" });
    expect(f("native_retrieved")).toEqual({ key: "researched", label: "Researched", detail: `d.example · ${SITE_ONLY_DETAIL}` });
    expect(f("native_retrieved", null)?.detail).toBe(SITE_ONLY_DETAIL);
    expect(evidenceSourceOf({ lineage: "native_supported", sourceClass: "connected_verified", sourceDomain: null } as any)?.key).toBe("connected");
    for (const no of ["legacy", "uncited", "conflicting", "asserted_only", "unsupported"]) expect([no, f(no)]).toEqual([no, null]);
    expect(SITE_ONLY_DETAIL.toLowerCase()).not.toContain("verified");
  });

  it("press and brands-seen include every accepted lineage, labelled, and exclude the rest", async () => {
    const { body } = await get("/knowledge", nid.native);
    const k = body as AthleteKnowledge;
    const media = k.categories.find((c) => c.key === "media")!;
    const press = media.sections.find((s) => s.key === "press")!.entries;
    const seen = k.categories.find((c) => c.key === "partnerships")!.sections.find((s) => s.key === "seen")!.entries;
    for (const lin of ["cited", "native_supported", "native_retrieved"]) {
      const detail = lin === "native_retrieved" ? `${lin}.example · ${SITE_ONLY_DETAIL}` : `${lin}.example`;
      expect(press.find((e) => e.value === `Headline ${lin}`)).toMatchObject({ state: "present", source: { key: "researched", detail }, evidence: [{ url: `https://${lin}.example/press_mention`, domain: `${lin}.example` }] });
      expect(seen.find((e) => e.value === `Brand ${lin}`)).toMatchObject({ state: "present", source: { key: "researched", detail } });
    }
    const t = textOf(body);
    for (const lin of ["asserted_only", "uncited", "conflicting"]) expect([lin, t.includes(`Headline ${lin}`) || t.includes(`Brand ${lin}`)]).toEqual([lin, false]);
  });

  it("counts them as things Nomila knows and never inflates the legacy count", async () => {
    const native = (await get("/knowledge", nid.native)).body as AthleteKnowledge;
    const twin = (await get("/knowledge", nid.twin)).body as AthleteKnowledge;
    expect(native.omitted.legacyValues).toBe(twin.omitted.legacyValues);
    // 3 accepted lineages × (press + brand seen) = 6 more present, current entries, all "Researched".
    expect(native.total - twin.total).toBe(6);
    expect((native.bySource.researched ?? 0) - (twin.bySource.researched ?? 0)).toBe(6);
  });
});

describe("S12 This isn't right (POST /me/knowledge/disputes)", () => {
  let id = "";
  beforeAll(async () => { id = await seedCanonicalAthlete({ brandDomain: "populated", name: "Dispute Dee" }); });

  it("disputes a fact-backed entry: a `dispute` row naming the fact; the entry reads unconfirmed with her words; not counted", async () => {
    const before = (await get("/knowledge", id)).body as AthleteKnowledge;
    const champ = entries(before).find((e) => e.value === "National Champion (2025)")!;
    expect(champ).toMatchObject({ tier: "established", ref: { kind: "fact" }, yourDispute: null });
    const r = await post("/knowledge/disputes", id, { entryId: champ.id, said: "  That was the year before  " });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, entryId: champ.id, target: `fact:${champ.ref!.id}` });
    const rows = await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, id), eq(athleteAsserted.field, "dispute")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: { object: { entryRef: { kind: "fact", id: champ.ref!.id }, said: "That was the year before" } }, source: "settings", mode: "form" });
    const after = (await get("/knowledge", id)).body as AthleteKnowledge;
    expect(byId(after, champ.id)).toMatchObject({ tier: "unconfirmed", yourDispute: { said: "That was the year before" } });
    expect(after.total).toBe(before.total - 1);
    // one live dispute per target: disputing again supersedes, never stacks
    await post("/knowledge/disputes", id, { entryId: champ.id });
    const live = (await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, id), eq(athleteAsserted.field, "dispute")))).filter((x) => !x.superseded_by);
    expect(live).toHaveLength(1);
  });

  it("an entry with no fact / evidence behind it is disputed by its id", async () => {
    const k = (await get("/knowledge", id)).body as AthleteKnowledge;
    const handle = entries(k).find((e) => e.id.startsWith("handle_"))!;
    const r = await post("/knowledge/disputes", id, { entryId: handle.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, target: `entry:${handle.id}` });
    expect(byId((await get("/knowledge", id)).body, handle.id)).toMatchObject({ tier: "unconfirmed", yourDispute: { said: null } });
  });

  it("404 for an entry that is not hers or does not exist; 409 for nothing on record; 400 for a bad body", async () => {
    const k = (await get("/knowledge", id)).body as AthleteKnowledge;
    const champ = entries(k).find((e) => e.value === "National Champion (2025)")!;
    expect((await post("/knowledge/disputes", ids.legacy, { entryId: champ.id })).status).toBe(404);   // another athlete's fact
    expect((await post("/knowledge/disputes", id, { entryId: "nope_123" })).status).toBe(404);
    expect((await post("/knowledge/disputes", "00000000-0000-0000-0000-000000000000", { entryId: "name" })).status).toBe(404);
    const blankEntry = entries(k).find((e) => e.state !== "present")!;
    expect((await post("/knowledge/disputes", id, { entryId: blankEntry.id })).status).toBe(409);
    expect((await post("/knowledge/disputes", id, {})).status).toBe(400);
    expect((await post("/knowledge/disputes", id, { entryId: champ.id, said: 7 })).status).toBe(400);
  });
});

describe("S13 knowledge/3 read model on real rows", () => {
  let id = "";
  beforeAll(async () => {
    id = await seedCanonicalAthlete({ brandDomain: "populated", name: "Fact Fay" });
    const [run] = await db.insert(researchRuns).values({ athlete_id: id, domain: "affiliations", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
    const [ev] = await db.insert(researchEvidence).values({ athlete_id: id, run_id: run.id, kind: "affiliation", claim: { factKey: "affiliation" } as any, lineage_status: "native_supported", source_url: "https://club.example/roster", source_domain: "club.example", source_type: "official_team_or_school", retrieved_at: T1, confidence: "0.9", source_class: "web_researched", suspect: false, dedupe_key: "aff:club" } as any).returning({ id: researchEvidence.id });
    const [aff] = await db.insert(athleteFacts).values({ athlete_id: id, fact_key: "affiliation", value: { org: "Fact City FC", orgKind: "club", season: 2025, role: "captain" } as any, value_text: "fact city fc club 2025", status: "current", retrieved_at: T1, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: { evidenceIds: [ev.id], domains: ["club.example"] } as any, freshness_family: "affiliations", resolver_version: "v2", registry_version: "v3" } as any).returning({ id: athleteFacts.id });
    await db.insert(athleteAffiliations).values({ athlete_id: id, org_name: "Fact City FC", org_kind: "club", role: "captain", is_primary: false, kind: "found", source: "fact", fact_id: aff.id, started_on: "2025-01-01" } as any);
    const [evEdu] = await db.insert(researchEvidence).values({ athlete_id: id, run_id: run.id, kind: "profile_attribute", claim: { factKey: "education" } as any, lineage_status: "native_supported", source_url: "https://canon.example/bio", source_domain: "canon.example", source_type: "official_team_or_school", retrieved_at: T1, confidence: "0.9", source_class: "web_researched", suspect: false, dedupe_key: "edu:1" } as any).returning({ id: researchEvidence.id });
    await db.insert(athleteFacts).values([
      { athlete_id: id, fact_key: "education", value: { institution: "Canon University", degree: "BA Example Studies", status: "completed" } as any, value_text: "canon university ba example studies", status: "current", retrieved_at: T1, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: { evidenceIds: [evEdu.id] } as any, freshness_family: "affiliations", resolver_version: "v2", registry_version: "v3" },
      { athlete_id: id, fact_key: "nationality", value: { country: "Testland" } as any, value_text: "testland", status: "current", retrieved_at: T1, origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: {} as any, freshness_family: "identity", resolver_version: "v2", registry_version: "v3" },
    ] as any);
  });

  it("shows the fact-backed found team (tier from its fact, official logo, captain role) and drops the legacy one", async () => {
    const k = (await get("/knowledge", id)).body as AthleteKnowledge;
    const teams = k.categories.find((c) => c.key === "athletics")!.sections.find((s) => s.key === "teams")!.entries;
    const club = teams.find((e) => e.meta?.org === "Fact City FC")!;
    expect(club).toMatchObject({ source: { key: "researched" }, tier: "established", logoDomain: "club.example", ref: { kind: "fact" }, meta: { role: "Captain" }, evidence: [{ url: "https://club.example/roster", domain: "club.example" }] });
    expect(teams.some((e) => e.meta?.org === "Found FC")).toBe(false);
    expect(k.omitted.legacyValues).toBeGreaterThan(0);
  });

  it("at a glance holds nationality and class; graduation left it; every present entry has a tier", async () => {
    const k = (await get("/knowledge", id)).body as AthleteKnowledge;
    expect(k.keyFacts.map((e) => e.id)).toEqual(expect.arrayContaining(["nationality", "class_year"]));
    expect(k.keyFacts.some((e) => e.id === "graduation_year")).toBe(false);
    expect(byId(k, "nationality")).toMatchObject({ value: "Testland", tier: "established" });
    for (const e of entries(k)) if (e.state === "present") expect([e.id, ["established", "reported", "unconfirmed"].includes(e.tier as string)]).toEqual([e.id, true]);
  });

  it("academics is present with an education fact; the overview counts agree", async () => {
    const k = (await get("/knowledge", id)).body as AthleteKnowledge;
    const acad = k.categories.find((c) => c.key === "academics")!;
    expect(acad).toMatchObject({ state: "present", count: 1 });
    expect(acad.sections[0].entries[0]).toMatchObject({ value: "BA Example Studies · Canon University", logoDomain: "canon.example" });
    const ov = (await get("/overview", id)).body;
    expect(ov.version).toBe("knowledge/3");
    expect(ov.knows.total).toBe(k.total);
    expect(ov.knows.categories.find((c: any) => c.key === "academics")).toEqual({ key: "academics", title: "Academics", count: 1, state: "present" });
  });
});
