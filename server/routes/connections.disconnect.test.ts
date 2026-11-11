/**
 * DELETE /disconnect/:platform — never picks an arbitrary row (plan §4.3).
 *
 * An athlete may hold two inboxes on one platform (two Gmail mailboxes); the platform name alone cannot say which
 * one to revoke, so the route refuses and the client disconnects by id. A single row still disconnects by platform,
 * and revoking keeps the row (status revoked, tokens nulled) so it can be reactivated in place later.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
const revokeProviderToken = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/oauthRevoke", () => ({ revokeProviderToken: (...a: unknown[]) => revokeProviderToken(...a) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { connectedAccounts } from "../../shared/schema";
import connectionsRouter from "./connections";

let server: Server; let base: string;

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/", connectionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => revokeProviderToken.mockClear());

const del = (path: string) => fetch(`${base}${path}`, { method: "DELETE" });
const rowOf = async (id: string) => (await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, id)))[0];

it("two active Gmail inboxes: refuses with CONNECTION_ID_REQUIRED and revokes nothing", async () => {
  const athleteId = await seedAthlete("Two Inboxes");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const a = await seedConnection({ athleteId, platform: "gmail", email: "one@example.com" });
  const b = await seedConnection({ athleteId, platform: "gmail", email: "two@example.com" });

  const res = await del("/disconnect/gmail");
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("CONNECTION_ID_REQUIRED");
  expect(revokeProviderToken).not.toHaveBeenCalled();
  expect((await rowOf(a)).status).toBe("active");
  expect((await rowOf(b)).status).toBe("active");
});

it("one active Gmail inbox: disconnects by platform, keeps the row, nulls its tokens", async () => {
  const athleteId = await seedAthlete("One Inbox");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const id = await seedConnection({ athleteId, platform: "gmail", email: "only@example.com" });

  const res = await del("/disconnect/gmail");
  expect(res.status).toBe(200);
  expect(revokeProviderToken).toHaveBeenCalledWith("gmail", "test-access-token");
  const row = await rowOf(id);
  expect(row).toMatchObject({ status: "revoked", access_token: null, refresh_token: null });
});

it("two inboxes: DELETE /connect/:connectionId revokes exactly the one named", async () => {
  const athleteId = await seedAthlete("By Id");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const keep = await seedConnection({ athleteId, platform: "gmail", email: "keep@example.com" });
  const drop = await seedConnection({ athleteId, platform: "gmail", email: "drop@example.com" });

  const res = await del(`/connect/${drop}`);
  expect(res.status).toBe(200);
  expect((await rowOf(drop)).status).toBe("revoked");
  expect((await rowOf(keep)).status).toBe("active");
});

it("a non-inbox platform keeps the platform form (single-account social)", async () => {
  const athleteId = await seedAthlete("TikTok");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const id = await seedConnection({ athleteId, platform: "tiktok" });

  const res = await del("/disconnect/tiktok");
  expect(res.status).toBe(200);
  expect((await rowOf(id)).status).toBe("revoked");
});
