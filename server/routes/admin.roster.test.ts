/**
 * admin.roster.test.ts — the admin roster: `school` is the projection column and `socials` the landing-entered handles,
 * never athlete_index_v (the ledger).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({ requireAdmin: (_req: any, _res: any, next: any) => next(), requireAuth: (_req: any, _res: any, next: any) => next() }));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import adminRouter, { furthestStep } from "./admin";
import { athletes, athleteAffiliations, socialIdentities } from "../../shared/schema";
import { client, db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../shared/schemaWorkflow";

let server: Server; let base: string; let athleteId: string;
const env = process.env;
async function roster() { const res = await fetch(`${base}/waitlist?status=active`); return (await res.json()) as any; }

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "../../migrations/0048_athlete_index.sql"), "utf8"));
  athleteId = await seedAthlete("Roster Athlete");
  await db.update(athletes).set({ sport: "soccer", school: "Stale Projection U", status: "active", socials: { instagram: "@typed_ig", twitter: "typed_x" } } as any).where(eq(athletes.id, athleteId));
  await db.insert(athleteAffiliations).values({ athlete_id: athleteId, org_name: "Ledger University", org_kind: "school", level: "D1", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
  await db.insert(socialIdentities).values({ athlete_id: athleteId, platform: "instagram", account_id: "ig-9", account_id_kind: "platform_id", handle: "verified_ig", source_class: "platform_public", source_method: "discovery", confidence: "0.80", status: "active" });
  const app = express(); app.use(express.json()); app.use("/", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 90_000);
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { process.env = env; });

test("the roster: projection school + entered handles", async () => {
  const r = await roster();
  const a = r.athletes.find((x: any) => x.id === athleteId);
  expect(a).toMatchObject({ fullName: "Roster Athlete", school: "Stale Projection U", socials: { instagram: "@typed_ig", twitter: "typed_x" }, socialCount: 2 });
});

// ─── the waitlist list: furthest join step, search by e-mail, sport and sign-up date filters ─────────────────────────
test("furthestStep: the highest milestone reached, signed in < sport < connected < researched < scored", () => {
  const f = { sport: null as string | null, connected: false, researched: false, scored: false };
  expect(furthestStep(f)).toBe("signed_in");
  expect(furthestStep({ ...f, sport: "  " })).toBe("signed_in");
  expect(furthestStep({ ...f, sport: "golf" })).toBe("sport");
  expect(furthestStep({ ...f, sport: "golf", connected: true })).toBe("connected");
  expect(furthestStep({ ...f, sport: "golf", researched: true })).toBe("researched");      // skipped connecting
  expect(furthestStep({ ...f, sport: "golf", connected: true, researched: true, scored: true })).toBe("scored");
});

test("waitlist list: each row carries its furthest step; q matches e-mail too; sport and from/to filter", async () => {
  const mk = async (name: string, email: string, set: Record<string, unknown>) => {
    const id = await seedAthlete(name);
    await db.update(athletes).set({ status: "waitlisted", email, ...set } as any).where(eq(athletes.id, id));
    return id;
  };
  const signedIn = await mk("Wl Signedin", "wl.signedin@example.com", { sport: null, created_at: new Date("2026-10-01T10:00:00Z") });
  const sport = await mk("Wl Sport", "wl.sport@example.com", { sport: "Golf", created_at: new Date("2026-10-02T10:00:00Z") });
  const conn = await mk("Wl Connected", "wl.conn@example.com", { sport: "golf", created_at: new Date("2026-10-03T10:00:00Z") });
  await seedConnection({ athleteId: conn, platform: "instagram" });
  const res = await mk("Wl Researched", "wl.res@example.com", { sport: "Tennis", created_at: new Date("2026-10-04T10:00:00Z") });
  const [run] = await db.insert(workflowRuns).values({ athlete_id: res, process: "signup_research", definition_version: 2, active_scope: "signup_research", status: "running" } as any).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: run.id, step: "research_merge", ordinal: 3, kind: "code", status: "done" } as any);
  const unmerged = await mk("Wl Unmerged", "wl.unmerged@example.com", { sport: "Tennis", created_at: new Date("2026-10-05T10:00:00Z") });
  const [run2] = await db.insert(workflowRuns).values({ athlete_id: unmerged, process: "signup_research", definition_version: 2, active_scope: "signup_research", status: "running" } as any).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: run2.id, step: "research_merge", ordinal: 3, kind: "code", status: "ready" } as any);

  const list = async (qs: string) => { const r = await fetch(`${base}/waitlist?status=waitlisted${qs}`); expect(r.status).toBe(200); return ((await r.json()) as any).athletes as any[]; };
  const all = await list("");
  const stepOf = (id: string) => all.find((a) => a.id === id)?.step;
  expect([stepOf(signedIn), stepOf(sport), stepOf(conn), stepOf(res), stepOf(unmerged)]).toEqual(["signed_in", "sport", "connected", "researched", "sport"]);

  expect((await list("&q=wl.conn%40example")).map((a) => a.id)).toEqual([conn]);              // e-mail, contains
  expect((await list("&q=WL.RES")).map((a) => a.id)).toEqual([res]);                          // any case
  expect((await list("&sport=GOLF")).map((a) => a.id).sort()).toEqual([sport, conn].sort());  // exact, any case
  expect((await list("&from=2026-10-02&to=2026-10-03")).map((a) => a.id)).toEqual([sport, conn]);
  expect((await list("&q=wl.&sport=tennis&from=2026-10-05")).map((a) => a.id)).toEqual([unmerged]);
  expect((await fetch(`${base}/waitlist?status=waitlisted&from=10/02/2026`)).status).toBe(400);
});

// ─── admin flags (anti-fake plan, lib/signupFlags.ts): chips on each row, ?flagged= filters; never a block ────────────
test("waitlist list: each row carries its admin flags; flagged=yes / no filter on them", async () => {
  const flaggedId = await seedAthlete("Flagged Waiter");
  const cleanId = await seedAthlete("Clean Waiter");
  await db.update(athletes).set({ status: "waitlisted", signup_flags: { disposable_email: { at: "2026-10-24T00:00:00.000Z", domain: "mailinator.com" }, same_network_burst: { at: "2026-10-24T00:00:00.000Z", accounts24h: 7 } } } as any).where(eq(athletes.id, flaggedId));
  await db.update(athletes).set({ status: "waitlisted" } as any).where(eq(athletes.id, cleanId));
  const list = async (qs: string) => (await (await fetch(`${base}/waitlist?status=waitlisted${qs}`)).json()) as any;
  const all = await list("");
  expect(all.athletes.find((a: any) => a.id === flaggedId).flags).toEqual(["disposable_email", "same_network_burst"]);
  expect(all.athletes.find((a: any) => a.id === cleanId).flags).toEqual([]);
  const yes = (await list("&flagged=yes")).athletes.map((a: any) => a.id);
  expect(yes).toContain(flaggedId); expect(yes).not.toContain(cleanId);
  const no = (await list("&flagged=no")).athletes.map((a: any) => a.id);
  expect(no).toContain(cleanId); expect(no).not.toContain(flaggedId);
});

// ─── referrals: tracked and shown only (owner, 24 Oct 2026) — never part of anyone's spot ─────────────────────────────
test("waitlist list: referredBy names who brought her in; referrals counts who joined with her link; ?sort=referrals", async () => {
  const { referralCodeFor } = await import("../lib/referralCode");
  const mk = async (name: string, set: Record<string, unknown> = {}) => {
    const id = await seedAthlete(name);
    await db.update(athletes).set({ status: "waitlisted", sport: "golf", created_at: new Date("2026-09-01T10:00:00Z"), ...set } as any).where(eq(athletes.id, id));
    return id;
  };
  const sharer = await mk("Ref Sharer");
  const quiet = await mk("Ref Quiet", { created_at: new Date("2026-08-01T10:00:00Z") });   // older: first in the joined order
  const a = await mk("Ref Joiner A", { referral_code: referralCodeFor(sharer) });
  const b = await mk("Ref Joiner B", { referral_code: referralCodeFor(sharer) });
  const junk = await mk("Ref Junk Code", { referral_code: "not-a-code" });
  const r = (await (await fetch(`${base}/waitlist?status=waitlisted&sport=golf`)).json()) as any;
  const row = (id: string) => r.athletes.find((x: any) => x.id === id);
  expect(row(sharer)).toMatchObject({ referrals: 2, referredBy: null });
  expect(row(a).referredBy).toEqual({ id: sharer, name: "Ref Sharer" });
  expect(row(b).referredBy).toEqual({ id: sharer, name: "Ref Sharer" });
  expect(row(quiet)).toMatchObject({ referrals: 0, referredBy: null });
  expect(row(junk)).toMatchObject({ referrals: 0, referredBy: null });               // a code that decodes to no one: nothing
  expect(r.athletes.findIndex((x: any) => x.id === quiet)).toBeLessThan(r.athletes.findIndex((x: any) => x.id === sharer));
  const sorted = (await (await fetch(`${base}/waitlist?status=waitlisted&sport=golf&sort=referrals`)).json()) as any;
  expect(sorted.athletes[0].id).toBe(sharer);
});
