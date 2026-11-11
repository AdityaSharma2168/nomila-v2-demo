/**
 * inbox.status.test.ts — WS5 shared write paths on the inbox router, against
 * in-memory Postgres (PGlite) with auth + the classify/score path mocked.
 *
 * Covers:
 *   · PATCH /inbox/threads/:id { status } — the archive/file write path
 *     (round-trip, ownership reject, allowlist validation).
 *   · POST  /inbox/threads/:id/reclassify — one-shot classify+score re-run
 *     (fan → deal happy path, non-scoreable stays unscored, ownership reject).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(),
  sendGmailReply:            jest.fn(),
}));
jest.mock("../lib/integrations/instagram", () => ({
  sendInstagramDM: jest.fn(),
}));
// Mock ONLY the LLM-backed classify/score entry points; keep SCOREABLE_CATEGORIES
// and the Classification type real (they gate the route's branch).
jest.mock("../skills/dealDetector", () => {
  const actual = jest.requireActual("../skills/dealDetector");
  return { ...actual, classifyMessage: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import inboxRouter from "./inbox";
import { classifyMessage } from "../skills/dealDetector";
import { inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const classifyMock = classifyMessage as jest.Mock;

let server: Server;
let base: string;
let athleteId: string, otherId: string;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

async function mkThread(owner: string, over: Record<string, unknown> = {}) {
  const [t] = await db
    .insert(inboxThreads)
    .values({ athlete_id: owner, subject: "Hello", status: "read", ...over } as any)
    .returning();
  return t;
}

let msgSeq = 0;
async function mkMsg(threadId: string, owner: string, over: Record<string, unknown> = {}) {
  msgSeq++;
  await db.insert(inboxMessages).values({
    thread_id:           threadId,
    athlete_id:          owner,
    direction:           "inbound",
    sender_email:        "person@example.com",
    sender_name:         "A Person",
    subject:             "Hello",
    body:                "Hey, are you interested?",
    platform:            "gmail",
    external_message_id: `ext-${msgSeq}`,
    received_at:         new Date(Date.UTC(2026, 0, 1, 0, msgSeq)),
    ...over,
  } as any);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
  otherId   = await seedAthlete("Other");

  const app = express();
  app.use(express.json());
  app.use("/", inboxRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  asUser(athleteId);
});

describe("PATCH /inbox/threads/:id — the archive/file write path", () => {
  it("files a thread (status → archived) and returns the updated row", async () => {
    const t = await mkThread(athleteId, { status: "read" });

    const r = await api("PATCH", `/inbox/threads/${t.id}`, { status: "archived" });

    expect(r.status).toBe(200);
    expect(r.json.status).toBe("archived");

    const [row] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(row.status).toBe("archived");
  });

  it("round-trips back — 'Pull it back' re-surfaces a filed thread", async () => {
    const t = await mkThread(athleteId, { status: "archived" });
    const r = await api("PATCH", `/inbox/threads/${t.id}`, { status: "deal_detected" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("deal_detected");
  });

  it("rejects a status outside the allowlist (400)", async () => {
    const t = await mkThread(athleteId);
    const r = await api("PATCH", `/inbox/threads/${t.id}`, { status: "filed" });
    expect(r.status).toBe(400);
  });

  it("404s patching another athlete's thread and does NOT mutate it", async () => {
    const t = await mkThread(otherId, { status: "read" });
    asUser(athleteId);
    const r = await api("PATCH", `/inbox/threads/${t.id}`, { status: "archived" });
    expect(r.status).toBe(404);

    const [row] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(row.status).toBe("read"); // untouched
  });
});

describe("POST /inbox/threads/:id/reclassify — one-shot classify", () => {
  it("turns a mis-piled fan item into a deal: writes classification, flips to deal_detected", async () => {
    const t = await mkThread(athleteId, { status: "read", classification: { category: "FAN" } });
    await mkMsg(t.id, athleteId);

    classifyMock.mockResolvedValueOnce({
      category: "PAID", confidence: 0.9, brand_name: "Acme", brand_domain: "acme.com",
      advertiser: "Acme", agency_name: null, via_agency: false,
      summary: "Paid partnership offer", offer_amount: 1000, deliverables: ["1 post"],
      deadline: null, contact_name: "A Person", contact_email: "person@example.com",
    });

    const r = await api("POST", `/inbox/threads/${t.id}/reclassify`);

    expect(r.status).toBe(200);
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(r.json.classification.category).toBe("PAID");
    expect(r.json.score).toBeNull(); // the deal score is gone; the key stays null for older builds
    expect(r.json.thread.status).toBe("deal_detected");

    const [row] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(row.status).toBe("deal_detected");
    expect((row.classification as any).category).toBe("PAID");
    expect("score" in row).toBe(false); // the column is dropped (0088)
  });

  // Regression: `classification` is shared storage. threadAliases.ts keeps the
  // cross-mailbox dedupe keys (alias_thread_ids) there, and this route used to rebuild
  // the object from scratch — so recovering one thread silently dropped the aliases and
  // the next reply from the second mailbox would mint a duplicate deal card again.
  it("preserves alias_thread_ids and other non-classifier keys written by other subsystems", async () => {
    const t = await mkThread(athleteId, {
      status: "read",
      classification: {
        category: "FAN",
        alias_thread_ids: ["gmail-thread-B", "gmail-thread-C"],
        some_other_subsystem_key: "keep me",
      },
    });
    await mkMsg(t.id, athleteId);

    classifyMock.mockResolvedValueOnce({
      category: "PAID", confidence: 0.9, brand_name: "Acme", brand_domain: "acme.com",
      advertiser: "Acme", agency_name: null, via_agency: false,
      summary: "Paid partnership offer", offer_amount: 1000, deliverables: ["1 post"],
      deadline: null, contact_name: null, contact_email: null,
    });

    const r = await api("POST", `/inbox/threads/${t.id}/reclassify`);
    expect(r.status).toBe(200);

    const [row] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    const cls = row.classification as any;
    // Classifier fields win…
    expect(cls.category).toBe("PAID");
    expect(cls.brand_name).toBe("Acme");
    // …and everything else survives.
    expect(cls.alias_thread_ids).toEqual(["gmail-thread-B", "gmail-thread-C"]);
    expect(cls.some_other_subsystem_key).toBe("keep me");
  });

  it("a non-scoreable reclassify (still FAN) writes classification but no score, status unchanged", async () => {
    const t = await mkThread(athleteId, { status: "read" });
    await mkMsg(t.id, athleteId);

    classifyMock.mockResolvedValueOnce({
      category: "FAN", confidence: 0.8, brand_name: null, brand_domain: null,
      advertiser: null, agency_name: null, via_agency: false,
      summary: "Just a fan", offer_amount: null, deliverables: [],
      deadline: null, contact_name: null, contact_email: null,
    });

    const r = await api("POST", `/inbox/threads/${t.id}/reclassify`);

    expect(r.status).toBe(200);
    expect(r.json.score).toBeNull();
    expect(r.json.thread.status).toBe("read"); // unchanged — not a deal
  });

  it("400s when the thread has no messages", async () => {
    const t = await mkThread(athleteId);
    const r = await api("POST", `/inbox/threads/${t.id}/reclassify`);
    expect(r.status).toBe(400);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("404s reclassifying another athlete's thread", async () => {
    const t = await mkThread(otherId);
    await mkMsg(t.id, otherId);
    asUser(athleteId);
    const r = await api("POST", `/inbox/threads/${t.id}/reclassify`);
    expect(r.status).toBe(404);
    expect(classifyMock).not.toHaveBeenCalled();
  });
});
