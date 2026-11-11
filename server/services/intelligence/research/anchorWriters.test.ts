/**
 * anchorWriters.test.ts — PR E2b, T9 at the REAL production writers of the identity anchor's fields, with the REAL
 * re-entry service (design record §1.2 T9: a resolved identity must not stay resolved against an obsolete anchor):
 *
 *   mila/onboarding.ts   recordAssertions (a sport correction), undoProfileWrite (the sport put back), clearAssertion
 *   routes/waitlist.ts   the landing page's returning post (COALESCE update of name / sport)
 *
 * Each: a resolved athlete whose name or sport changes → pending (T9, trigger anchor_changed); an unchanged anchor →
 * still resolved, provenance byte-identical; boundary closed → nothing. Plus the entry hook itself against the real
 * service: a seeded athlete is never entered, no sport waits, a signed-up athlete with a sport gets T1.
 * The static exhaustiveness guard over every writer is lifecycleHooks.test.ts. No provider is reachable here.
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../../../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),   // routes/auth /signup and waitlist verify through lib/auth
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn(), createCustomToken: jest.fn() },
}));
const startRun = jest.fn().mockResolvedValue({ run: { id: "r" }, created: true });
jest.mock("../../../workflow/runner", () => ({ ...jest.requireActual("../../../workflow/runner"), startRun: (...a: unknown[]) => startRun(...a) }));
jest.mock("../../../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(() => { throw new Error("no provider in tests"); }), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../../../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { agentActions, athleteResearchState, athletes } from "../../../../shared/schema";
import { grandfatherMembership } from "../identity/users";
import { clearAssertion, recordAssertions, undoProfileWrite } from "../../../mila/onboarding";
import waitlistRouter from "../../../routes/waitlist";
import { anchorHash, applyIdentityTransition, readIdentityState } from "./identityResolution";
import { currentIdentityAnchor } from "./lifecycle";
import { enterLifecycleResearch } from "./lifecycleHooks";

const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env, RESEARCH_REFRESH_ENABLED: "false", RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_PROVIDER: "kimi", ATHLETE_INDEX_CLAIM: "false", ...f }; };
let server: Server; let base: string;
let n = 0;

async function makeAthlete(opts: { sport?: string | null; member?: boolean; uid?: string } = {}) {
  const id = await seedAthlete(`Jane Doe ${++n}${Math.random().toString(36).slice(2, 6)}`);
  const uid = opts.uid ?? `uid-${id}`;
  await db.update(athletes).set({ sport: opts.sport === undefined ? "soccer" : opts.sport, status: "raw", ...(opts.member === false ? {} : { auth_id: uid }) } as any).where(eq(athletes.id, id));
  if (opts.member !== false) await grandfatherMembership({ athleteId: id, uid, note: "test" });
  return { id, uid };
}
/** resolved by a Q1 determination over the CURRENT anchor (as the v3 stage records it). */
async function resolve(id: string) {
  await db.insert(athleteResearchState).values({ athlete_id: id, research_status: "seed_only" }).onConflictDoNothing();
  const h = anchorHash((await currentIdentityAnchor(id))!);
  await applyIdentityTransition(id, (await readIdentityState(id))!, { kind: "enter", trigger: "signup", by: null, anchorHash: h });
  const r = await applyIdentityTransition(id, (await readIdentityState(id))!, { kind: "q1", determination: { outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] }, researchRunId: "rr", workflowRunId: null, requestAnchorHash: h, currentAnchorHash: h });
  expect(r).toMatchObject({ written: true, transition: "T2" });
}
const identity = async (id: string) => readIdentityState(id);

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json()); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { flags(ON); startRun.mockClear(); });

const waitlistPost = async (uid: string, body: Record<string, unknown>) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}/waitlist`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body) });
  expect(r.status).toBeLessThan(300);
};

/** Each production writer: (athlete) => change the anchor;  (athlete) => write without changing it. */
const WRITERS: Array<[string, (a: { id: string; uid: string }) => Promise<void>, (a: { id: string; uid: string }) => Promise<void>]> = [
  ["mila recordAssertions (sport correction)",
    async (a) => { await recordAssertions({ athleteId: a.id, runId: null, mode: "form", corrections: [{ field: "sport", value: "basketball" } as any] }); },
    async (a) => { await recordAssertions({ athleteId: a.id, runId: null, mode: "form", corrections: [{ field: "sport", value: "soccer" } as any] }); }],
  ["mila undoProfileWrite (the sport put back)",
    async (a) => { const [act] = await db.insert(agentActions).values({ athlete_id: a.id, action: "profile_write", reason: "t", reversible: true, payload: { column: "sport", field: "sport", from: "tennis" } } as any).returning(); await undoProfileWrite(act as any); },
    async (a) => { const [act] = await db.insert(agentActions).values({ athlete_id: a.id, action: "profile_write", reason: "t", reversible: true, payload: { column: "sport", field: "sport", from: "soccer" } } as any).returning(); await undoProfileWrite(act as any); }],
  ["mila clearAssertion (sport cleared)",
    async (a) => { await clearAssertion({ athleteId: a.id, field: "sport", mode: "form", source: "settings" }); },
    async (a) => { await clearAssertion({ athleteId: a.id, field: "goal", mode: "form", source: "settings" }); }],
  ["waitlist returning post (name / sport)",
    async (a) => { await waitlistPost(a.uid, { full_name: "Janet Renamed", sport: "soccer" }); },
    async (a) => { const [r] = await db.select({ n: athletes.full_name }).from(athletes).where(eq(athletes.id, a.id)); await waitlistPost(a.uid, { full_name: r.n, sport: "soccer", school: "Another School" }); }],
];

describe("T9 at every production writer of an anchor field (real re-entry service)", () => {
  for (const [label, change, same] of WRITERS) {
    test(`${label}: resolved + changed name/sport → pending (T9, anchor_changed)`, async () => {
      const a = await makeAthlete();
      await resolve(a.id);
      await change(a);
      const s = await identity(a.id);
      expect(s!.value).toBe("pending");
      expect(s!.detail).toMatchObject({ trigger: "anchor_changed", previous: { value: "resolved", basis: "q1" } });
    });
    test(`${label}: anchor unchanged → still resolved, provenance byte-identical`, async () => {
      const a = await makeAthlete();
      await resolve(a.id);
      const before = await identity(a.id);
      await same(a);
      expect(await identity(a.id)).toEqual(before);
    });
    test(`${label}: boundary closed → nothing, even when the sport changes`, async () => {
      const a = await makeAthlete();
      await resolve(a.id);
      const before = await identity(a.id);
      flags({});
      await change(a);
      expect(await identity(a.id)).toEqual(before);
    });
  }
});

describe("the entry hook against the real service", () => {
  test("a seeded athlete (no account) is never entered; a signed-up athlete without a sport waits; with one she gets T1", async () => {
    const seeded = await makeAthlete({ member: false });
    await enterLifecycleResearch(seeded.id, "signup");
    expect((await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, seeded.id)))).toEqual([]);
    const noSport = await makeAthlete({ sport: null });
    await enterLifecycleResearch(noSport.id, "signup");
    expect((await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, noSport.id)))).toEqual([]);
    const ok = await makeAthlete();
    await enterLifecycleResearch(ok.id, "signup");
    expect((await identity(ok.id))!).toMatchObject({ value: "pending", detail: { trigger: "signup" } });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ process: "research_refresh", version: 3, athleteId: ok.id }));
  });
  test("boundary closed: the hook is a no-op (no row, no run)", async () => {
    flags({});
    const a = await makeAthlete();
    await enterLifecycleResearch(a.id, "signup");
    expect((await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, a.id)))).toEqual([]);
    expect(startRun).not.toHaveBeenCalled();
  });
});
