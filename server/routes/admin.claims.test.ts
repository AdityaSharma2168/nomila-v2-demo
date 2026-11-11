/**
 * admin.claims.test.ts — Phase A Step 3b: the operator's claim queue (list + decide). requireAdmin is the router's own gate.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({ requireAdmin: (req: any, _res: any, next: any) => { req.athleteId = "op-athlete"; next(); }, requireAuth: (_req: any, _res: any, next: any) => next(), requireFirebaseUser: (_req: any, _res: any, next: any) => next(), firebaseAuth: { verifyIdToken: jest.fn() } }));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, identityClaims } from "../../shared/schema";
import adminRouter from "./admin";
import { resolveIdentity } from "../services/intelligence/identity/resolve";
import { confirmClaim } from "../services/intelligence/identity/claims";
import { selfMembershipFor } from "../services/intelligence/identity/users";

let server: Server; let base: string;
const post = async (path: string, body?: unknown) => { const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

test("queue lists proposed claims (no uid); decide confirm links by operator; reject records; bad input 400/404/409", async () => {
  const open = await seedAthlete("Ola Brandt"); await db.update(athletes).set({ sport: "golf", status: "enriched", email: "ola@example.com" } as any).where(eq(athletes.id, open));
  const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-ola2", email: "z@example.com", emailVerified: true }, provider: "firebase", query: { name: "Ola Brandt", sport: "golf" } });
  expect(r.action).toBe("confirm");
  const claim = r.claims!.find((c) => c.athleteId === open)!;
  expect((await confirmClaim({ caller: { uid: "uid-ola2", email: "z@example.com", emailVerified: true }, claimId: claim.claimId, claimSessionId: r.claimSessionId! })).outcome).toBe("pending_operator");
  const q = await get("/identity/claims?status=proposed");
  expect(q.status).toBe(200); expect(q.json.claims.some((c: any) => c.claimId === claim.claimId && c.athleteName === "Ola Brandt" && c.note.userConfirmedAt)).toBe(true);
  expect(JSON.stringify(q.json)).not.toContain("uid-ola2");
  expect((await get("/identity/claims?status=bogus")).status).toBe(400);
  expect((await post(`/identity/claims/${claim.claimId}/decide`, { decision: "maybe" })).status).toBe(400);
  expect((await post(`/identity/claims/00000000-0000-0000-0000-000000000000/decide`, { decision: "reject" })).status).toBe(404);
  const ok = await post(`/identity/claims/${claim.claimId}/decide`, { decision: "confirm", note: "roster checked" });
  expect(ok.status).toBe(200); expect(ok.json).toEqual({ outcome: "linked", athleteId: open });
  expect((await selfMembershipFor(open))).toMatchObject({ proof: "human_confirmation" });
  const [row] = await db.select().from(identityClaims).where(eq(identityClaims.id, claim.claimId));
  expect(row).toMatchObject({ status: "confirmed", decided_by: "operator" }); expect((row.note as any).operator).toBe("op-athlete");
  expect((await post(`/identity/claims/${claim.claimId}/decide`, { decision: "confirm" })).status).toBe(409);
  // a second claimant on the now-taken row: confirm refused (409), reject works
  const r2 = await resolveIdentity({ path: "signup", caller: { uid: "uid-ola3", email: "y@example.com", emailVerified: true }, provider: "firebase", query: { name: "Ola Brandt", sport: "golf" } });
  const c2 = r2.claims!.find((c) => c.athleteId === open)!;
  expect((await post(`/identity/claims/${c2.claimId}/decide`, { decision: "confirm" })).status).toBe(409);
  expect((await post(`/identity/claims/${c2.claimId}/decide`, { decision: "reject", note: "not her" })).json).toEqual({ outcome: "rejected" });
});

test("a legacy name-match proposal from a user who already has a sign-up row: decide confirm ⇒ 409 manual_merge_required with the operator message; the queue shows provider / e-mail / verification", async () => {
  const target = await seedAthlete("Rhea Target"); await db.update(athletes).set({ status: "raw" } as any).where(eq(athletes.id, target));
  const own = await seedAthlete("Rhea Target", { auth_id: "uid-rhea", auth_provider: "firebase", status: "raw" } as any);
  const { grandfatherMembership } = await import("../services/intelligence/identity/users");
  const m = (await grandfatherMembership({ athleteId: own, uid: "uid-rhea", email: "rhea@new.example", note: "legacy_path:signup_create" }))!;
  const [claim] = await db.insert(identityClaims).values({ user_id: m.userId, athlete_id: target, proof: "none", status: "proposed", note: { path: "signup_legacy_name" } }).returning();
  const q = await get("/identity/claims?status=proposed");
  expect(q.json.claims.find((c: any) => c.claimId === claim.id).user).toEqual({ provider: "firebase", email: "rhea@new.example", emailVerified: false });
  const d = await post(`/identity/claims/${claim.id}/decide`, { decision: "confirm" });
  expect(d.status).toBe(409); expect(d.json).toMatchObject({ error: "manual_merge_required", athleteId: target, heldBy: own });
  expect(d.json.message).toMatch(/Merge the two rows by hand/);
  expect(await selfMembershipFor(target)).toBeNull();
});
