/**
 * meBrands.test.ts — "Confirm this is [brand]" over HTTP, against PGlite with the real runner (auth mocked: the
 * athlete is the token's). Providers are mocked; the job is only requested here (its body is
 * services/brandIdentityRefresh.test.ts), so nothing reaches a network.
 *
 *   - GET candidate: what research proposes (name, domain, logo), read-only; 404 for a brand not on her opportunities
 *   - confirm: records her governed assertion (field brand_identity, provenance), sets the domain, records her
 *     confirmation on the row, triggers exactly one brand_identity_refresh run; scoped to her brands
 *   - not_this: records the rejection; that candidate is no longer offered to her; another athlete is unaffected
 *   - refusals write nothing
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
const generateContent = jest.fn(async () => { throw new Error("tests never reach providers"); });
jest.mock("../lib/models", () => ({ genai: () => ({ models: { generateContent } }), GEMINI: { flash: "gemini-test" } }));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(async () => { throw new Error("tests never reach providers"); }) }));
jest.mock("../lib/ownSiteImagery", () => ({ fetchOwnSiteImagery: jest.fn(async () => { throw new Error("tests never reach providers"); }) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteAsserted, inboxBrands, opportunities, workflowRuns, workflowSteps } from "../../shared/schema";
import meBrandsRouter from "./meBrands";
import { BRAND_IDENTITY_REFRESH_PROCESS } from "../services/brandIdentityRefresh";
import { BRAND_IDENTITY_FIELD } from "../services/brandConfirmation";
import { resetRunnerConfig } from "../workflow/runner";
import "../workflow/definitions/index";

let server: Server;
let base: string;
let her: string, other: string;
let seq = 0;

const asAthlete = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
async function mkBrand(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1;
  const [r] = await db.insert(inboxBrands).values({ name: `Route Brand ${seq}`, normalized_name: `route brand ${seq}`, ...over } as any).returning({ id: inboxBrands.id });
  return r.id;
}
async function mkOpp(athleteId: string, brandId: number) {
  await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: brandId, status: "open", opened_at: new Date(), last_activity_at: new Date() } as any);
}
const row = async (id: number) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, id)))[0];
const statements = async (athleteId: string, brandIds: number[]) => (await db.select().from(athleteAsserted)
  .where(and(eq(athleteAsserted.athlete_id, athleteId), eq(athleteAsserted.field, BRAND_IDENTITY_FIELD)))).filter((s) => brandIds.includes((s.value as any).brand_id));
const brandRuns = () => db.select().from(workflowRuns).where(eq(workflowRuns.process, BRAND_IDENTITY_REFRESH_PROCESS));

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Brand Owner");
  other = await seedAthlete("Someone Else");
  const app = express();
  app.use(express.json());
  app.use("/", meBrandsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});
beforeEach(async () => {
  resetRunnerConfig();
  process.env.BRAND_IDENTITY_GATE = "true";
  asAthlete(her);
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { delete process.env.BRAND_IDENTITY_GATE; });

test("GET candidate proposes the row's domain with its logo; a brand not on her opportunities is 404", async () => {
  const id = await mkBrand({ domain: "proposed.example", logo_url: "https://logo.example/p.png" });
  await mkOpp(her, id);
  const r = await api("GET", `/brands/${id}/candidate`);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ brandId: id, status: "candidate", candidate: { domain: "proposed.example", logoUrl: "https://logo.example/p.png", basis: "mail_evidence" } });

  const notHers = await mkBrand({ domain: "nothers.example" });
  await mkOpp(other, notHers);
  expect((await api("GET", `/brands/${notHers}/candidate`)).status).toBe(404);
  expect((await api("GET", `/brands/abc/candidate`)).status).toBe(404);
  expect(await brandRuns()).toHaveLength(0);   // a read with a candidate starts nothing
});

test("GET candidate with nothing to offer starts one capped lookup; a name-search candidate is offered", async () => {
  const id = await mkBrand({ domain: null });
  await mkOpp(her, id);
  const r = await api("GET", `/brands/${id}/candidate`);
  expect(r.json).toMatchObject({ status: "none", candidate: null, lookup: "started" });
  const [run] = await brandRuns();
  expect(run.input).toMatchObject({ brandId: id, lookup: true });

  await db.update(inboxBrands).set({ enrichment: { candidate: { domain: "named.example", name: "x", source: "name_search", proposed_at: new Date().toISOString() }, candidate_lookup: { at: new Date().toISOString(), found: true } } } as any).where(eq(inboxBrands.id, id));
  const again = await api("GET", `/brands/${id}/candidate`);
  expect(again.json).toMatchObject({ status: "candidate", candidate: { domain: "named.example", basis: "name_search" } });
  expect(again.json.candidate.logoUrl).toContain("favicons?domain=named.example");
});

test("confirm records her assertion, sets the domain, marks the row, and triggers exactly one job", async () => {
  const id = await mkBrand({ domain: null });
  await mkOpp(her, id);
  await db.update(inboxBrands).set({ enrichment: { candidate: { domain: "confirmme.example", name: "x", source: "name_search", proposed_at: new Date().toISOString() } } } as any).where(eq(inboxBrands.id, id));

  const r = await api("POST", `/brands/${id}/confirm`, { domain: "https://www.confirmme.example/" });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: true, domain: "confirmme.example" });

  const [st] = await statements(her, [id]);
  expect(st).toMatchObject({ id: r.json.assertedId, source: "settings", mode: "form", said: null, retracted_at: null });
  expect(st.value).toEqual({ brand_id: id, domain: "confirmme.example", verdict: "confirmed", provenance: { surface: "confirm_brand", candidate_basis: "name_search" } });
  const b = await row(id);
  expect(b.domain).toBe("confirmme.example");
  expect((b.enrichment as any).athlete_confirmed).toMatchObject({ domain: "confirmme.example", assertion_id: st.id });

  const runs = await brandRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: r.json.runId, athlete_id: her, status: "running" });
  expect(runs[0].input).toMatchObject({ brandId: id, domain: "confirmme.example" });

  // A second tap supersedes the first and joins the same active run.
  const again = await api("POST", `/brands/${id}/confirm`, { domain: "confirmme.example" });
  expect(again.json.runId).toBe(r.json.runId);
  expect(await brandRuns()).toHaveLength(1);
  const live = await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, her), eq(athleteAsserted.field, BRAND_IDENTITY_FIELD), isNull(athleteAsserted.superseded_by)));
  expect(live.map((s) => s.id)).toEqual([again.json.assertedId]);

  const view = await api("GET", `/brands/${id}/candidate`);
  expect(view.json).toMatchObject({ status: "confirmed_by_you", confirmed: { domain: "confirmme.example" } });
});

test("confirm is scoped to her brands and refuses without writing", async () => {
  const notHers = await mkBrand({ domain: null });
  await mkOpp(other, notHers);
  expect(await api("POST", `/brands/${notHers}/confirm`, { domain: "x.example" })).toMatchObject({ status: 404, json: { reason: "not_your_brand" } });

  const mine = await mkBrand({ domain: "mine.example" });
  await mkOpp(her, mine);
  expect(await api("POST", `/brands/${mine}/confirm`, { domain: "gmail.com" })).toMatchObject({ status: 400, json: { reason: "invalid_domain" } });
  expect(await api("POST", `/brands/${mine}/confirm`, { domain: "someone-else.example" })).toMatchObject({ status: 409, json: { reason: "domain_mismatch" } });

  await mkBrand({ domain: "heldelsewhere.example" });
  const empty = await mkBrand({ domain: null });
  await mkOpp(her, empty);
  expect(await api("POST", `/brands/${empty}/confirm`, { domain: "heldelsewhere.example" })).toMatchObject({ status: 409, json: { reason: "domain_held" } });

  expect(await statements(her, [notHers, mine, empty])).toHaveLength(0);
  expect(await brandRuns()).toHaveLength(0);
  expect((await row(empty)).domain).toBeNull();
});

test("not_this records her rejection and suppresses that candidate for her only", async () => {
  const id = await mkBrand({ domain: "wrongco.example" });
  await mkOpp(her, id);
  await mkOpp(other, id);

  const r = await api("POST", `/brands/${id}/not_this`, { domain: "wrongco.example" });
  expect(r.status).toBe(200);
  const [st] = await statements(her, [id]);
  expect(st.value).toMatchObject({ brand_id: id, domain: "wrongco.example", verdict: "not_this" });
  expect(await brandRuns()).toHaveLength(0);

  expect((await api("GET", `/brands/${id}/candidate`)).json).toMatchObject({ status: "none", candidate: null });
  asAthlete(other);
  expect((await api("GET", `/brands/${id}/candidate`)).json).toMatchObject({ status: "candidate", candidate: { domain: "wrongco.example" } });
});

test("not_this withdraws her earlier confirmation of that domain, and the imagery that stood only on it", async () => {
  const id = await mkBrand({ domain: null });
  await mkOpp(her, id);
  const c = await api("POST", `/brands/${id}/confirm`, { domain: "changedmind.example" });
  await db.update(inboxBrands).set({
    image_url: "https://changedmind.example/og.jpg",
    enrichment: { ...((await row(id)).enrichment as any), own_site: { source: "own_site", domain: "changedmind.example", cover: "https://changedmind.example/og.jpg", logo_url: null, basis: "athlete_confirmed", fetched_at: new Date().toISOString() } },
  } as any).where(eq(inboxBrands.id, id));

  await api("POST", `/brands/${id}/not_this`, { domain: "changedmind.example" });
  const b = await row(id);
  expect((b.enrichment as any).athlete_confirmed).toBeUndefined();
  expect((b.enrichment as any).own_site).toBeUndefined();
  expect(b.image_url).toBeNull();
  const [first] = await db.select().from(athleteAsserted).where(eq(athleteAsserted.id, c.json.assertedId));
  expect(first.superseded_by).not.toBeNull();
});
