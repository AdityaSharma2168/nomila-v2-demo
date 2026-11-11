/**
 * draftIntentRoute.test.ts — POST /athletes/:id/draft-intent. PGlite (real SQL),
 * no network, no model.
 *
 * This route is the trust boundary of the voice-draft flow, so the suite is
 * weighted accordingly:
 *
 *  - the guard first, because the shared secret is the ONLY authorization here;
 *  - THE INVARIANT: no draft text in, no draft text out, and no pending action
 *    created. Those are the three properties that make voice-triggered drafting
 *    safe, and each is asserted rather than assumed;
 *  - persist-first: the card is on a chat_message with NON-EMPTY content before
 *    the route answers, because empty content is dropped by the reload filter;
 *  - tenancy: another athlete's deal must not resolve, even by exact brand name.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import draftIntentRouter from "./draftIntentRoute";
import {
  chatMessages,
  deals,
  inboxMessages,
  inboxThreads,
  pendingActions,
} from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const SECRET = "voice-test-secret-0123456789";
const CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; cacheControl: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => undefined),
    cacheControl: res.headers.get("cache-control"),
  };
}

const withSecret = { "x-voice-secret": SECRET };

const validBody = {
  brand: "Gorjana",
  replyIntent: "negotiate",
  conversationId: CONVERSATION_ID,
};

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Draft Intent Athlete");
  otherAthleteId = await seedAthlete("Other Athlete");

  await db.insert(deals).values({
    athlete_id: athleteId,
    brand_name: "Gorjana",
    detected_at: new Date("2026-07-01T00:00:00Z"),
  });
  // Same brand name, different athlete — the tenancy probe.
  await db.insert(deals).values({
    athlete_id: otherAthleteId,
    brand_name: "Gorjana",
    detected_at: new Date("2026-07-02T00:00:00Z"),
  });

  const app = express();
  app.use(express.json());
  app.use("/", draftIntentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.VOICE_SERVICE_SECRET;
});

beforeEach(() => {
  process.env.VOICE_SERVICE_SECRET = SECRET;
});

describe("auth guard", () => {
  it("401s with no header", async () => {
    const res = await post(`/athletes/${athleteId}/draft-intent`, validBody);
    expect(res.status).toBe(401);
  });

  it("401s on a same-length wrong secret", async () => {
    const res = await post(`/athletes/${athleteId}/draft-intent`, validBody, {
      "x-voice-secret": "X".repeat(SECRET.length),
    });
    expect(res.status).toBe(401);
  });

  it("401s when the secret is unset (fail-closed)", async () => {
    delete process.env.VOICE_SERVICE_SECRET;
    const res = await post(`/athletes/${athleteId}/draft-intent`, validBody, {
      "x-voice-secret": SECRET,
    });
    expect(res.status).toBe(401);
  });

  it("writes nothing on a rejected request", async () => {
    const before = await db.select().from(chatMessages);
    await post(`/athletes/${athleteId}/draft-intent`, validBody);
    const after = await db.select().from(chatMessages);
    expect(after.length).toBe(before.length);
  });

  it("sets Cache-Control: no-store either way", async () => {
    const denied = await post(`/athletes/${athleteId}/draft-intent`, validBody);
    expect(denied.cacheControl).toBe("no-store");
    const ok = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );
    expect(ok.cacheControl).toBe("no-store");
  });
});

describe("input validation", () => {
  it("400s on a non-uuid athlete id", async () => {
    const res = await post(
      "/athletes/nope/draft-intent",
      validBody,
      withSecret,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid athlete id" });
  });

  it("400s on a missing brand", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { ...validBody, brand: "   " },
      withSecret,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing brand" });
  });

  it("400s on a reply intent outside the closed set", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { ...validBody, replyIntent: "ghost_them" },
      withSecret,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid reply intent" });
  });

  it("400s on a non-uuid conversation id", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { ...validBody, conversationId: "not-a-uuid" },
      withSecret,
    );
    expect(res.status).toBe(400);
  });

  it("404s for a brand the athlete has no deal with", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { ...validBody, brand: "Brand They Never Heard Of" },
      withSecret,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No deal for that brand" });
  });
});

describe("resolve — and what it deliberately does NOT do", () => {
  it("returns ids and enums only — never draft text", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "brandName",
      "dealId",
      "platform",
      "replyIntent",
      "sendable",
      "threadId",
    ]);
    // THE invariant: a draft is derived from the brand's email, and it must not
    // exist on this path at all — not under any key, not in any shape.
    expect(res.body).not.toHaveProperty("draft");
    expect(res.body).not.toHaveProperty("body");
    expect(res.body).not.toHaveProperty("text");
    expect(res.body.replyIntent).toBe("negotiate");
    expect(typeof res.body.sendable).toBe("boolean");
  });

  it("creates NO pending action — voice gains no send capability", async () => {
    await post(`/athletes/${athleteId}/draft-intent`, validBody, withSecret);
    const rows = await db.select().from(pendingActions);
    expect(rows).toHaveLength(0);
  });

  it("is not sendable with no thread to reply into", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );
    // The seeded deal has no inbox_thread, so there is no reply path and the
    // card must not offer Send.
    expect(res.body.sendable).toBe(false);
  });

  it("never resolves another athlete's deal, even on an exact brand match", async () => {
    const mine = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(eq(deals.athlete_id, athleteId), eq(deals.brand_name, "Gorjana")),
      );
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );
    expect(res.body.dealId).toBe(mine[0].id);

    const theirs = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.athlete_id, otherAthleteId),
          eq(deals.brand_name, "Gorjana"),
        ),
      );
    expect(res.body.dealId).not.toBe(theirs[0].id);
  });
});

describe("duplicate-brand deals — the regression that produced a wrong card", () => {
  // Reproduces live data: the athlete holds TWO deals for one brand. The NEWER
  // row has no messages; the older one is the real Gmail conversation. Taking
  // the newest match bound the card to the empty row and reported "no in-app
  // send" for a brand whose thread plainly existed.
  const DUP_BRAND = "Duplicate Brand Co";

  beforeAll(async () => {
    // Older row — the one carrying the actual thread.
    const [threaded] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: DUP_BRAND,
        detected_at: new Date("2026-06-01T00:00:00Z"),
      })
      .returning({ id: deals.id });

    // NEWER row, no thread at all — what the old code would have chosen.
    await db.insert(deals).values({
      athlete_id: athleteId,
      brand_name: DUP_BRAND,
      detected_at: new Date("2026-07-15T00:00:00Z"),
    });

    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id: athleteId,
        deal_id: threaded.id,
        external_thread_id: "ext-duplicate-brand",
        subject: "Re: partnership",
        last_message_at: new Date("2026-06-02T00:00:00Z"),
      })
      .returning({ id: inboxThreads.id });

    await db.insert(inboxMessages).values({
      thread_id: thread.id,
      athlete_id: athleteId,
      direction: "inbound",
      platform: "gmail",
      received_at: new Date("2026-06-02T00:00:00Z"),
    });
  });

  it("resolves the duplicate that has the thread, not the newest", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { ...validBody, brand: DUP_BRAND },
      withSecret,
    );

    expect(res.status).toBe(200);
    // The threaded row wins even though it is the OLDER deal.
    expect(res.body.sendable).toBe(true);

    const threadedIds = await db
      .select({ id: inboxThreads.deal_id })
      .from(inboxThreads)
      .where(eq(inboxThreads.external_thread_id, "ext-duplicate-brand"));
    expect(res.body.dealId).toBe(threadedIds[0].id);
  });

  it("is stable across repeated calls", async () => {
    // The old failure was intermittent: no ORDER BY in the resolver's SELECT
    // meant ties fell back to physical row order, so the same request could pick
    // a different duplicate. Same answer every time is the actual fix.
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await post(
        `/athletes/${athleteId}/draft-intent`,
        { ...validBody, brand: DUP_BRAND },
        withSecret,
      );
      seen.add(`${res.body.dealId}:${res.body.sendable}`);
    }
    expect(seen.size).toBe(1);
  });

  it("still returns a card when NO duplicate has a reply path", async () => {
    // Falls back to the newest match: a brand they have a deal with but no inbox
    // conversation still gets a card — just no Send.
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );
    expect(res.status).toBe(200);
    expect(res.body.sendable).toBe(false);
  });
});

describe("persist-first", () => {
  it("writes the card onto a chat_message BEFORE answering", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversation_id, CONVERSATION_ID));
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[rows.length - 1];
    expect(row.role).toBe("assistant");
    expect(row.source).toBe("voice");
    // Non-empty is load-bearing: getConversationMessages drops empty content, so
    // a blank line here would render live and then vanish on reopen.
    expect(row.content).toBe("Draft reply to Gorjana");
    expect((row.content ?? "").length).toBeGreaterThan(0);
  });

  it("returns the SAME threadId/platform/sendable it persists — live and reloaded cards agree", async () => {
    // The regression this guards: the response omitted threadId and platform, so
    // the worker filled them in itself (`threadId: null`), the client validator
    // turned that into sendable:false, and a voice card was unsendable live but
    // sendable after a reload — the same card, two answers.
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      validBody,
      withSecret,
    );

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversation_id, CONVERSATION_ID));
    const persisted = (rows[rows.length - 1].widget as any).data;

    expect(res.body.threadId).toBe(persisted.threadId);
    expect(res.body.platform).toBe(persisted.platform);
    expect(res.body.sendable).toBe(persisted.sendable);
  });

  it("stores a reply_action card that needs a draft and carries none", async () => {
    await post(`/athletes/${athleteId}/draft-intent`, validBody, withSecret);

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversation_id, CONVERSATION_ID));
    const widget = rows[rows.length - 1].widget as any;

    expect(widget.type).toBe("reply_action");
    expect(widget.data.needsDraft).toBe(true);
    // The stored card carries no copy either — the client generates it.
    expect(widget.data.draft).toBeNull();
    expect(widget.data.refusal).toBeNull();
    expect(widget.data.params.replyIntent).toBe("negotiate");
  });
});

// ─── Targeting a draft by id ─────────────────────────────────────────────────
// A revision ("make it longer") names no brand, so the worker used to have to
// re-state one from context — and live it re-stated the WRONG one, revising a
// brand from earlier in the conversation instead of the card on screen. The
// worker now remembers the dealId it opened and sends that back, which removes
// resolution from the revision path entirely: there is nothing left to guess.

describe("dealId targeting — a revision cannot mis-resolve", () => {
  const ownDeal = async () => {
    const [d] = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(eq(deals.athlete_id, athleteId), eq(deals.brand_name, "Gorjana")),
      )
      .limit(1);
    return d.id;
  };

  it("opens the named deal without resolving a brand at all", async () => {
    const id = await ownDeal();
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { dealId: id, replyIntent: "negotiate", conversationId: CONVERSATION_ID },
      withSecret,
    );
    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe(id);
    expect(res.body.brandName).toBe("Gorjana");
  });

  it("IGNORES a brand that disagrees with the dealId", async () => {
    // The live failure inverted: the model may still volunteer a stale brand on
    // a revision. The id is the target; the brand is not consulted.
    const id = await ownDeal();
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      {
        dealId: id,
        brand: "Handshake AI",
        replyIntent: "negotiate",
        conversationId: CONVERSATION_ID,
      },
      withSecret,
    );
    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe(id);
    expect(res.body.brandName).toBe("Gorjana");
  });

  it("404s on another athlete's dealId — never their card", async () => {
    const [theirs] = await db
      .select({ id: deals.id })
      .from(deals)
      .where(eq(deals.athlete_id, otherAthleteId))
      .limit(1);
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      {
        dealId: theirs.id,
        replyIntent: "accept",
        conversationId: CONVERSATION_ID,
      },
      withSecret,
    );
    expect(res.status).toBe(404);
  });

  it("400s on a malformed dealId rather than falling back to the brand", async () => {
    // Falling back would reintroduce exactly the guess this removes.
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      {
        dealId: "not-a-uuid",
        brand: "Gorjana",
        replyIntent: "accept",
        conversationId: CONVERSATION_ID,
      },
      withSecret,
    );
    expect(res.status).toBe(400);
  });

  it("still requires a brand when no dealId is given", async () => {
    const res = await post(
      `/athletes/${athleteId}/draft-intent`,
      { replyIntent: "accept", conversationId: CONVERSATION_ID },
      withSecret,
    );
    expect(res.status).toBe(400);
  });
});

describe("MILA_WELCOME — a voice draft card is the optional draft_replies capability", () => {
  const saved = process.env.MILA_WELCOME;
  afterEach(() => { if (saved === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = saved; });

  it("refuses (403 capability_off) and writes no card while draft replies are off for the athlete", async () => {
    process.env.MILA_WELCOME = "true";
    const before = (await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, athleteId))).length;
    const res = await post(`/athletes/${athleteId}/draft-intent`, validBody, withSecret);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("capability_off");
    expect(res.body.message).toContain("deals_draft_reply is off for this athlete");
    expect((await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, athleteId))).length).toBe(before);
  });

  it("resolves once the athlete turned draft replies on for a connected mailbox", async () => {
    process.env.MILA_WELCOME = "true";
    const { seedConnection } = await import("../testUtils/pgliteDb");
    const { turnOnFromCard } = await import("../agent/welcome/turnOn");
    const mailbox = await seedConnection({ athleteId, platform: "gmail", email: "draft-intent@example.org" });
    expect(await turnOnFromCard({ athleteId, key: "draft_replies", accountRef: mailbox, consentVersion: "draft_replies/2" })).toMatchObject({ ok: true });
    expect((await post(`/athletes/${athleteId}/draft-intent`, validBody, withSecret)).status).toBe(200);
  });
});
