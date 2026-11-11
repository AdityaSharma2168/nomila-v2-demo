/**
 * conversations.test.ts (route) — the saved-chats read endpoints. The access
 * layer is unit-tested in server/mila/conversations.test.ts; this covers the
 * route wiring: uuid validation on reopen,
 * and that tenancy (req.athleteId) reaches the queries. DB is PGlite.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import conversationsRouter from "./conversations";
import { eq } from "drizzle-orm";
import { chatMessages, conversations } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Route Owner");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;

  const app = express();
  app.use(express.json());
  app.use("/", conversationsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

describe("GET /conversations", () => {
  it("lists this athlete's conversations", async () => {
    const cid = randomUUID();
    await db
      .insert(conversations)
      .values({ id: cid, athlete_id: athleteId, title: "my chat" } as any);

    const { status, body } = await get("/conversations");
    expect(status).toBe(200);
    expect(body.conversations.some((c: any) => c.id === cid)).toBe(true);
  });

});

describe("GET /conversations/:id", () => {
  it("returns the conversation's replayable turns", async () => {
    const cid = randomUUID();
    await db.insert(chatMessages).values([
      { athlete_id: athleteId, conversation_id: cid, role: "user", content: "hey" },
      { athlete_id: athleteId, conversation_id: cid, role: "assistant", content: "hi there" },
    ] as any);

    const { status, body } = await get(`/conversations/${cid}`);
    expect(status).toBe(200);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "hey" });
  });

  it("rejects a malformed conversation id with 400", async () => {
    const { status } = await get("/conversations/not-a-uuid");
    expect(status).toBe(400);
  });

  it("returns nothing for another athlete's conversation (tenancy)", async () => {
    const other = await seedAthlete("Other Route Athlete");
    const cid = randomUUID();
    await db
      .insert(chatMessages)
      .values({ athlete_id: other, conversation_id: cid, role: "user", content: "secret" } as any);

    const { status, body } = await get(`/conversations/${cid}`);
    expect(status).toBe(200);
    expect(body.messages).toEqual([]);
  });
});

describe("DELETE /conversations/:id and /conversations", () => {
  async function del(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, { method: "DELETE" });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  }
  async function msgCount(owner: string) {
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, owner));
    return rows.length;
  }

  it("rejects a malformed id with 400", async () => {
    expect((await del("/conversations/not-a-uuid")).status).toBe(400);
  });

  it("deletes the signed-in athlete's chat, never another athlete's (even by id)", async () => {
    const other = await seedAthlete("Other Delete Athlete");
    const own = randomUUID();
    const foreign = randomUUID();
    await db.insert(chatMessages).values([
      { athlete_id: athleteId, conversation_id: own, role: "user", content: "own" },
      { athlete_id: other, conversation_id: foreign, role: "user", content: "foreign" },
    ] as any);

    const r1 = await del(`/conversations/${foreign}`);
    expect(r1.status).toBe(200);
    expect(r1.body.deleted.messages).toBe(0);
    expect(await msgCount(other)).toBe(1);

    const r2 = await del(`/conversations/${own}`);
    expect(r2.status).toBe(200);
    expect(r2.body.deleted.messages).toBe(1);
  });

  it("DELETE /conversations removes all of this athlete's chats only", async () => {
    const other = await seedAthlete("Other All Athlete");
    await db.insert(chatMessages).values([
      { athlete_id: athleteId, conversation_id: randomUUID(), role: "user", content: "a" },
      { athlete_id: athleteId, conversation_id: null, role: "user", content: "b" },
      { athlete_id: other, conversation_id: randomUUID(), role: "user", content: "c" },
    ] as any);
    const r = await del("/conversations");
    expect(r.status).toBe(200);
    expect(await msgCount(athleteId)).toBe(0);
    expect(await msgCount(other)).toBe(1);
  });
});
