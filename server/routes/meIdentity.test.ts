/**
 * meIdentity.test.ts — the athlete's own public-identity confirm / reject routes (thin wrappers over
 * research/confirmation.ts T6/T8), over HTTP with the real requireAuth (only Firebase token verification faked), a real
 * (PGlite) Postgres and the real runner. Research providers are mocked; nothing reaches a network.
 *
 *   - athlete-authenticated: 401 without a token; the athlete is the token's, never the client's
 *   - an ambiguous Q1 is settled by HER: GET shows the Q1 candidates, confirm (T6) resolves, reject (T8) re-opens
 *   - refusals map to 403 / 409 / 422 / 400 and write nothing; another account cannot speak for her
 *   - boundary off ⇒ disabled
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
jest.mock("../lib/research/providers/geminiGrounded", () => ({ groundedSearch: jest.fn(), GEMINI_PROVIDER_ID: "gemini_grounded" }));
jest.mock("../lib/research/providers/kimiExtract", () => ({ extractWithCitations: jest.fn() }));
jest.mock("../lib/trends", () => ({ fetchGoogleTrends: jest.fn() }));
jest.mock("../lib/gdelt", () => ({ fetchGdelt: jest.fn() }));
jest.mock("../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn() }));
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
    verifyIdToken: async (t: string) => { if (t.startsWith("user:")) return { uid: t.slice(5), roles: [] }; throw new Error("invalid token"); } }),
}));
jest.setTimeout(300_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteAsserted, athletes } from "../../shared/schema";
import meIdentityRouter from "./meIdentity";
import { configureRunner, resetRunnerConfig } from "../workflow/runner";
import "../workflow/definitions/researchRefresh";
import type { DirectCallOpts, DirectCallResult } from "../lib/research/providers/geminiDirect";
import type { Finding } from "../services/intelligence/research/spec/directEvidenceV2";
import { grandfatherMembership } from "../services/intelligence/identity/users";
import { __resetResearchPolicyCache } from "../services/intelligence/research/config";
import { readIdentityState } from "../services/intelligence/research/identityResolution";
import { adminResolveIdentity } from "../services/intelligence/research/lifecycle";
import { PUBLIC_IDENTITY_FIELD } from "../services/intelligence/research/confirmation";

const URL0 = "https://example.edu/roster/athlete";
/** Q1 with two namesakes and an uncorroborated team ⇒ ambiguous (T-e). */
async function fakeAmbiguousQ1(opts: DirectCallOpts, name: string): Promise<DirectCallResult> {
  const env = opts.envelopeId;
  await opts.reserve();
  const mk = (section: any, item: string, value: Record<string, unknown>, statement: string): Finding => ({ section, item, value, statement, asOf: "2026-10-01", sources: [{ url: URL0, title: null, publishedAt: null, quote: statement }],
    lineage: { level: "native_supported", match: "index_support", boundChunkIds: [`${env}:c0`], boundSources: [{ url: URL0, domain: "example.edu", title: null }], detail: null, bindingMethod: "quote_exact" } } as Finding);
  const findings = [mk("S1", "full_name", { full: name }, `Her full name is ${name}.`), mk("S2", "current_affiliation", { organization: "Riverside University", organization_type: "college", level: "NCAA D1" }, "She plays for Riverside University.")];
  const items: Record<string, any> = {};
  for (const f of findings) (items[f.item] ??= { status: "found", reason: null, findings: [] }).findings.push(f);
  return {
    envelope: { id: env, provider: "gemini_direct", model: "gemini-test", queryName: opts.queryName, query: "(fake)", fetchedAt: "2026-10-01T00:00:00.000Z", answerText: findings.map((f) => f.statement).join(" "),
      chunks: [{ id: `${env}:c0`, url: URL0, domain: "example.edu", title: "Roster", text: findings.map((f) => f.statement).join(" "), textKind: "provider_answer_segments" }], supports: [], raw: null, request: { path: "fake" }, usage: { calls: 1, latencyMs: 5 }, errors: [] },
    parsed: null,
    parsedV2: { items, identity: { anchorMatch: "matched", confidence: 0.9, namesakes: [{ description: "another athlete", sourceUrl: null }, { description: "a third", sourceUrl: null }] }, parseError: null, unknownItems: [] },
    prose: "", markerFound: true, attempts: 1, refused: false, completed: true, nativeSources: 1, searchQueries: 1,
  } as DirectCallResult;
}
const direct = (jest.requireMock("../lib/research/providers/geminiDirect") as { geminiDirect: jest.Mock }).geminiDirect;

const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER", "IDENTITY_MEMBERSHIP_READ"]) delete process.env[k]; Object.assign(process.env, f); __resetResearchPolicyCache(); };

let server: Server; let base: string;
async function http(method: "GET" | "POST", path: string, token: string | null, body?: unknown) {
  const r = await fetch(`${base}/api/v1/me${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

let seq = 0;
/** A signed-up athlete (self membership + the auth_id projection), entered and left ambiguous by an admin Q1. */
async function ambiguousAthlete(): Promise<{ id: string; uid: string; name: string }> {
  const name = `Confirm Athlete ${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const id = await seedAthlete(name);
  await db.update(athletes).set({ sport: "volleyball", status: "raw" } as any).where(eq(athletes.id, id));
  const uid = `uid-${id}`;
  await grandfatherMembership({ athleteId: id, uid, note: "test" });
  await db.update(athletes).set({ auth_id: uid } as any).where(eq(athletes.id, id));
  direct.mockImplementationOnce(async (_r: string, opts: DirectCallOpts) => fakeAmbiguousQ1(opts, name));
  const r = await adminResolveIdentity(id, { by: "admin:test", perEpisodeKey: true });
  expect(r).toMatchObject({ started: true });
  expect((await readIdentityState(id))!.value).toBe("ambiguous");
  return { id, uid, name };
}
const statementsOf = async (id: string) => db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, id), eq(athleteAsserted.field, PUBLIC_IDENTITY_FIELD)));

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json()); app.use("/api/v1/me", meIdentityRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { flags(ON); resetRunnerConfig(); configureRunner({ retry: { randomize: false } }); direct.mockReset(); });
afterEach(() => { process.env = env; });

test("athlete-authenticated: no / bad token → 401 on every route", async () => {
  for (const [m, p] of [["GET", "/identity"], ["POST", "/identity/confirm"], ["POST", "/identity/reject"]] as const) {
    expect((await http(m, p, null, {})).status).toBe(401);
    expect((await http(m, p, "garbage", {})).status).toBe(401);
  }
});

test("ambiguous → she sees the Q1 candidates and confirms (T6 → resolved); then rejects (T8 → ambiguous)", async () => {
  const a = await ambiguousAthlete();
  const tok = `user:${a.uid}`;
  const g = await http("GET", "/identity", tok);
  expect(g).toMatchObject({ status: 200, json: { enabled: true, identity: { value: "ambiguous", basis: "q1", reason: "namesakes_uncorroborated" } } });
  const { q1ResearchRunId, evidence } = g.json.candidates;
  expect(evidence.length).toBeGreaterThan(0);
  const ids = evidence.map((e: any) => e.id);

  const ok = await http("POST", "/identity/confirm", tok, { q1ResearchRunId, evidenceIds: ids, said: "that's me" });
  expect(ok).toMatchObject({ status: 200, json: { ok: true, transition: "T6", q1ResearchRunId } });
  expect((await readIdentityState(a.id))).toMatchObject({ value: "resolved", detail: { basis: "athlete_confirmed", assertedId: ok.json.assertedId } });
  expect((await http("POST", "/identity/confirm", tok, { q1ResearchRunId, evidenceIds: ids })).status).toBe(409);   // not ambiguous any more

  const rej = await http("POST", "/identity/reject", tok, { said: "not me after all" });
  expect(rej).toMatchObject({ status: 200, json: { ok: true, transition: "T8" } });
  expect((await readIdentityState(a.id))!.value).toBe("ambiguous");
  expect(await http("POST", "/identity/reject", tok, {})).toMatchObject({ status: 409, json: { reason: "not_resolved" } });
  expect(direct).toHaveBeenCalledTimes(1);   // the statements call nothing
});

test("refusals write nothing: bad body 400, a run that is not her Q1 422, foreign evidence 422", async () => {
  const a = await ambiguousAthlete();
  const b = await ambiguousAthlete();
  const tok = `user:${a.uid}`;
  const mine = (await http("GET", "/identity", tok)).json.candidates;
  const theirs = (await http("GET", "/identity", `user:${b.uid}`)).json.candidates;
  expect((await http("POST", "/identity/confirm", tok, {})).status).toBe(400);
  expect((await http("POST", "/identity/confirm", tok, { q1ResearchRunId: mine.q1ResearchRunId, evidenceIds: [] })).status).toBe(400);
  expect(await http("POST", "/identity/confirm", tok, { q1ResearchRunId: theirs.q1ResearchRunId, evidenceIds: theirs.evidence.map((e: any) => e.id) })).toMatchObject({ status: 422, json: { reason: "q1_run_mismatch" } });
  expect(await http("POST", "/identity/confirm", tok, { q1ResearchRunId: mine.q1ResearchRunId, evidenceIds: [theirs.evidence[0].id] })).toMatchObject({ status: 422, json: { reason: "evidence_not_q1" } });
  expect(await http("POST", "/identity/confirm", tok, { byProof: true })).toMatchObject({ status: 422, json: { reason: "no_proof_affiliation" } });
  expect((await readIdentityState(a.id))!.value).toBe("ambiguous");
  expect(await statementsOf(a.id)).toEqual([]);
});

test("only her self user may speak: a token whose user is not her self member is refused (403 not_self)", async () => {
  const a = await ambiguousAthlete();
  // a second login holds the athlete row's auth_id projection but no self membership (e.g. a legacy link)
  await db.update(athletes).set({ auth_id: "uid-intruder" } as any).where(eq(athletes.id, a.id));
  const r = await http("POST", "/identity/reject", "user:uid-intruder", {});
  expect(r).toMatchObject({ status: 403, json: { reason: "not_self" } });
  expect((await readIdentityState(a.id))!.value).toBe("ambiguous");
});

test("boundary off ⇒ GET says disabled; confirm/reject refuse (409 disabled) and write nothing", async () => {
  const a = await ambiguousAthlete();
  flags({});
  const tok = `user:${a.uid}`;
  expect(await http("GET", "/identity", tok)).toMatchObject({ status: 200, json: { enabled: false, identity: null } });
  expect(await http("POST", "/identity/reject", tok, {})).toMatchObject({ status: 409, json: { reason: "disabled" } });
  expect(await statementsOf(a.id)).toEqual([]);
});
