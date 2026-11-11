/**
 * identityClaims.test.ts — Phase A Step 3b: the "Is this you?" endpoints. Dark unless ATHLETE_INDEX_CLAIM; a claim id and
 * a session id are the only handles, both bound to the caller's user; no athlete id from the client is authority.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireFirebaseUser: (req: any, _res: any, next: any) => { const c = (globalThis as any).__CALLER; req.authUid = c.uid; req.authEmail = c.email ?? null; req.authEmailVerified = c.emailVerified === true; next(); },
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  firebaseAuth: { verifyIdToken: jest.fn() },
}));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, identityClaims } from "../../shared/schema";
import router from "./identityClaims";
import { resolveIdentity } from "../services/intelligence/identity/resolve";
import { selfMembershipFor } from "../services/intelligence/identity/users";

let server: Server; let base: string; const env = process.env;
const as = (uid: string, email: string | null = null, emailVerified = false) => { (globalThis as any).__CALLER = { uid, email, emailVerified }; };
const post = async (path: string, body?: unknown) => { const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };

let open: string;
beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  open = await seedAthlete("Nia Okafor"); await db.update(athletes).set({ sport: "soccer", status: "enriched", email: "nia@example.com" } as any).where(eq(athletes.id, open));
  const app = express(); app.use(express.json()); app.use("/", router);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { process.env = env; });

test("flag off: every endpoint is dark (404)", async () => {
  process.env = { ...env, ATHLETE_INDEX_CLAIM: "false" }; as("uid-dark");
  expect((await post("/claims/00000000-0000-0000-0000-000000000000/confirm", { claimSessionId: null })).status).toBe(404);
  expect((await post("/claims/session/00000000-0000-0000-0000-000000000000/dismiss")).status).toBe(404);
  expect((await get("/claims/mine")).status).toBe(404);
});

test("flag on: confirm is bound to the caller's user + session; the athlete comes from the claim, never from the body; dismiss + mine are user-scoped", async () => {
  process.env = { ...env, ATHLETE_INDEX_CLAIM: "true" };
  const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-nia2", email: "nia@example.com", emailVerified: false }, provider: "firebase", query: { name: "Nia Okafor", sport: "soccer" } });
  expect(r.action).toBe("confirm");
  const claim = r.claims!.find((c) => c.athleteId === open)!;
  // another user: 404, nothing changes
  as("uid-stranger");
  expect((await post(`/claims/${claim.claimId}/confirm`, { claimSessionId: r.claimSessionId })).status).toBe(404);
  // the owner with the wrong session: 404
  as("uid-nia2", "nia@example.com", true);
  expect((await post(`/claims/${claim.claimId}/confirm`, { claimSessionId: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
  expect((await post(`/claims/not-a-uuid/confirm`, {})).status).toBe(404);
  // mine: grouped by session
  const mine = await get("/claims/mine");
  expect(mine.status).toBe(200); expect(mine.json.sessions[0].claimSessionId).toBe(r.claimSessionId); expect(mine.json.sessions[0].claims.length).toBe(r.claims!.length);
  // a client-supplied athlete id is ignored: the confirm links the CLAIM's athlete
  const other = await seedAthlete("Someone Else");
  const ok = await post(`/claims/${claim.claimId}/confirm`, { claimSessionId: r.claimSessionId, athleteId: other });
  expect(ok.status).toBe(200); expect(ok.json).toMatchObject({ outcome: "linked", athleteId: open, proof: "verified_unique_email" });
  expect(await selfMembershipFor(other)).toBeNull(); expect((await selfMembershipFor(open))).not.toBeNull();
  // dismiss: another user's call does nothing; the owner's expires the rest of the session
  const r2 = await resolveIdentity({ path: "signup", caller: { uid: "uid-dis", email: "d@example.com", emailVerified: true }, provider: "firebase", query: { name: "Nia Okafor", sport: "soccer" } });
  expect(r2.action).toBe("confirm");
  as("uid-stranger"); expect((await post(`/claims/session/${r2.claimSessionId}/dismiss`)).json.expired).toBe(0);
  as("uid-dis", "d@example.com", true); expect((await post(`/claims/session/${r2.claimSessionId}/dismiss`)).json.expired).toBe(r2.claims!.length);
  const rows = await db.select().from(identityClaims).where(eq(identityClaims.claim_session_id, r2.claimSessionId!));
  expect(rows.every((x) => x.status === "expired")).toBe(true);
  expect((await get("/claims/mine")).json.sessions).toEqual([]);
});

test("flag on: an expired claim answers 410", async () => {
  process.env = { ...env, ATHLETE_INDEX_CLAIM: "true" };
  const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-exp", email: null, emailVerified: false }, provider: "firebase", query: { name: "Nia Okafor", sport: "soccer" } });
  expect(r.action).toBe("confirm");
  await db.update(identityClaims).set({ proposed_at: new Date(Date.now() - 8 * 86_400_000) }).where(eq(identityClaims.id, r.claims![0].claimId));
  as("uid-exp");
  expect((await post(`/claims/${r.claims![0].claimId}/confirm`, { claimSessionId: r.claimSessionId })).status).toBe(410);
});

test("SECURITY: an UNVERIFIED e-mail never matches — not on signup, waitlist or Microsoft, and a confirm with it never links", async () => {
  process.env = { ...env, ATHLETE_INDEX_CLAIM: "true" };
  const victim = await seedAthlete("Wren Castellanos"); await db.update(athletes).set({ sport: "rowing", status: "enriched", email: "wren@example.com" } as any).where(eq(athletes.id, victim));
  // a stranger's name + the victim's address, unverified: nothing surfaced, nothing linked — the caller creates a new row
  for (const [path, provider, uid] of [["signup", "firebase", "uid-w-signup"], ["waitlist", "firebase", "uid-w-wait"], ["microsoft", "microsoft", "microsoft:w-ms"]] as const) {
    const r = await resolveIdentity({ path, caller: { uid, email: "Wren@Example.com", emailVerified: false }, provider, query: { name: "Mallory Unrelated" } });
    expect(r.action).toBe("create"); expect(r.proof).toBe("none");
    expect(r.result.candidates.some((c) => c.record.athleteId === victim)).toBe(false);
  }
  expect(await selfMembershipFor(victim)).toBeNull();
  // the same address VERIFIED links on the unique e-mail
  const ok = await resolveIdentity({ path: "waitlist", caller: { uid: "uid-wren", email: "wren@example.com", emailVerified: true }, provider: "firebase", query: { name: "Wren Castellanos" } });
  expect(ok).toMatchObject({ action: "linked", athleteId: victim, proof: "verified_unique_email" });

  // "Is this you?" confirm: a name match proposes the claim; confirming with an unverified matching e-mail only waits for an operator
  const target = await seedAthlete("Xan Okonjo"); await db.update(athletes).set({ sport: "fencing", status: "enriched", email: "xan@example.com" } as any).where(eq(athletes.id, target));
  const r = await resolveIdentity({ path: "signup", caller: { uid: "uid-xan-attacker", email: "xan@example.com", emailVerified: false }, provider: "firebase", query: { name: "Xan Okonjo", sport: "fencing" } });
  expect(r.action).toBe("confirm");
  const claim = r.claims!.find((c) => c.athleteId === target)!;
  as("uid-xan-attacker", "xan@example.com", false);
  const res = await post(`/claims/${claim.claimId}/confirm`, { claimSessionId: r.claimSessionId });
  expect(res.status).toBe(200); expect(res.json.outcome).toBe("pending_operator");
  expect(await selfMembershipFor(target)).toBeNull();
});
