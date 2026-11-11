/**
 * tenancy.test.ts — the cross-tenant isolation guarantee, end to end.
 *
 * Every module in the voice path already has its own tenancy tests, and they are
 * good ones. What none of them can cover is the SEAM: each suite hand-feeds ids
 * to one module and checks that module behaves. This suite instead drives the
 * real chain — mint a token as A, take the ids the server actually decided, feed
 * them to the real internal routes as A's worker would, and then ask, as B,
 * whether any of it is visible.
 *
 * That distinction matters because the dangerous regressions live between the
 * modules, not inside them. If `resolveVoiceConversation` started adopting a
 * foreign id, every existing suite would still pass: the token route's tests feed
 * it ids and check the response, and the transcript route's tests feed it ids and
 * check the write. Only following one athlete's id all the way from mint to
 * persistence, and then reading as the other athlete, catches it.
 *
 * ── The guarantee, restated ──────────────────────────────────────────────────
 * Athlete A can never, by any request A is able to make, obtain B's identity,
 * write into B's thread, read B's data, or alter B's rows.
 *
 * Each `describe` below is one clause of that, and is labelled with the design
 * guarantee it encodes so a failure names what broke rather than where:
 *
 *   G1  identity comes from the verified session, never from the request
 *   G2  a conversation id is resolved against ownership, never adopted on trust
 *   G3  a persisted turn is visible only in the speaker's own thread
 *   G4  the voice_context upsert will not overwrite a row it does not own
 *
 * ── What is real here and what is not ────────────────────────────────────────
 * Real: the token route with its true middleware chain, `requireAuth`'s logic,
 * the internal voice routes, `resolveVoiceConversation`, every SQL statement
 * (PGlite, real Postgres, the real schema).
 * Stubbed: only the two boundaries that would reach the network — Firebase
 * signature verification, and nothing else. There is no LiveKit call to make:
 * minting a token is local signing.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

// Already-initialized, so requireAuth's module-load `initializeApp()` is skipped.
jest.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  initializeApp: () => ({}),
}));

// The only stub inside the auth path: the signature check. A token is valid iff
// this suite registered a uid for it.
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
   
    verifyIdToken: async (idToken: string) => {
      const uid = (globalThis as any).__TEST_UID_BY_TOKEN?.[idToken];
      if (!uid) throw new Error("Firebase ID token has invalid signature.");
      return { uid };
    },
  }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { tokenRouter, voiceIdentityFor } from "./webTokenRoute";
import transcriptRouter from "./transcriptRoute";
import { mintVoiceGrant } from "./auth";
import voiceContextRouter from "./voiceContextRoute";
import { getVoiceContext } from "./voiceContext";
import {
  getConversationMessages,
  listConversations,
} from "../mila/conversations";
import { voiceTokenLimiter } from "../lib/rateLimit";
import {
  athletes,
  chatMessages,
  conversations,
  voiceContext,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const API_KEY = "APItestkey";
const API_SECRET = "test-secret-at-least-32-bytes-long-xxxxx";
const WS_URL = "wss://mila-test.livekit.cloud";
const VOICE_SECRET = "voice-service-secret-0123456789";
const GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";

/** Athlete A — "us" in every test below. */
const A_TOKEN = "firebase-id-token-athlete-a";
const A_UID = "firebase-uid-athlete-a";
/** Athlete B — the other tenant, whose data must never move. */
const B_TOKEN = "firebase-id-token-athlete-b";
const B_UID = "firebase-uid-athlete-b";

let server: Server;
let base: string;
let A: string;
let B: string;
/** A conversation B owns outright, and has already spoken in. */
let bConversation: string;

const ENV_KEYS = [
  "MILA_VOICE_WEB",
  "NODE_ENV",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "VOICE_SERVICE_SECRET",
  "VOICE_GRANT_SECRET",
  "VOICE_GRANT_ENFORCE",
] as const;
const saved: Record<string, string | undefined> = {};

/** Mint a token as an athlete, exactly as the browser would. */
async function mint(
  token: string,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  // The limiter is real in this chain; these tests are about tenancy, not rate.
  for (const id of [A, B]) voiceTokenLimiter.resetKey(id);
  const res = await fetch(`${base}/voice/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** Decode a minted LiveKit token's dispatch metadata — what the worker will read. */
function dispatchMetadata(jwt: string): {
  athleteId: string;
  conversationId: string;
  grant?: string;
} {
  const claims = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
  );
  return JSON.parse(claims.roomConfig.agents[0].metadata);
}

/** The worker writing one spoken turn back, with the service secret. */
async function writeTurn(
  athleteId: string,
  conversationId: string,
  content: string,
  role: "user" | "assistant" = "user",
  /** The session grant the worker echoes (undefined: one for this athlete and conversation, as the worker sends; null: none). */
  grant?: string | null,
): Promise<{ status: number; body: any }> {
  if (grant === undefined) grant = mintVoiceGrant(athleteId, conversationId)!.grant;
  const res = await fetch(
    `${base}/api/internal/voice/athletes/${athleteId}/transcript`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voice-secret": VOICE_SECRET,
        ...(grant ? { "x-voice-grant": grant } : {}),
      },
      body: JSON.stringify({ conversationId, role, content }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** The worker recording what a session discussed. */
async function writeContext(
  athleteId: string,
  conversationId: string,
  dealId: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${base}/api/internal/voice/athletes/${athleteId}/voice-context`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voice-secret": VOICE_SECRET,
      },
      body: JSON.stringify({
        conversationId,
        deals: [
          {
            dealId,
            brandId: null,
            recommendationGiven: null,
            spokenAt: new Date("2026-08-10T12:00:00Z").toISOString(),
          },
        ],
        brands: [],
        openThreads: [],
      }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  await initTestDb();

  const [a] = await db
    .insert(athletes)
    .values({ full_name: "Athlete A", auth_id: A_UID } as any)
    .returning({ id: athletes.id });
  A = a.id;

  const [b] = await db
    .insert(athletes)
    .values({ full_name: "Athlete B", auth_id: B_UID } as any)
    .returning({ id: athletes.id });
  B = b.id;

  (globalThis as any).__TEST_UID_BY_TOKEN = {
    [A_TOKEN]: A_UID,
    [B_TOKEN]: B_UID,
  };

  const app = express();
  app.use(express.json());
  app.use(tokenRouter);
  app.use("/api/internal/voice", transcriptRouter);
  app.use("/api/internal/voice", voiceContextRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete (globalThis as any).__TEST_UID_BY_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  process.env.MILA_VOICE_WEB = "true";
  process.env.NODE_ENV = "test";
  process.env.LIVEKIT_URL = WS_URL;
  process.env.LIVEKIT_API_KEY = API_KEY;
  process.env.LIVEKIT_API_SECRET = API_SECRET;
  process.env.VOICE_SERVICE_SECRET = VOICE_SECRET;
  process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
  // Observe mode unless a test turns enforcement on (G5).
  delete process.env.VOICE_GRANT_ENFORCE;

  // B's established thread, rebuilt per test so one test's writes cannot make
  // another test's isolation assertion pass for the wrong reason.
  bConversation = randomUUID();
  await db.insert(conversations).values({
    id: bConversation,
    athlete_id: B,
    title: "B's private thread",
  } as any);
  await writeTurn(B, bConversation, "B said something private", "user");
});

// ─── G1 ───────────────────────────────────────────────────────────────────────

describe("G1 — identity comes from the verified session, never the request", () => {
  it("mints for the caller, and the metadata the worker will read says so", async () => {
    const res = await mint(A_TOKEN);
    expect(res.status).toBe(200);
    // The participant identity is A's pseudonym (never her raw id: LiveKit keeps it in logs Nomila can't delete).
    expect(res.body.identity).toBe(voiceIdentityFor(A));
    expect(res.body.identity).not.toBe(A);
    // The metadata is what actually scopes the worker; asserting the response
    // body alone would miss a token whose claims disagree with it.
    expect(dispatchMetadata(res.body.token).athleteId).toBe(A);
  });

  it("ignores B's athlete id supplied by A in every shape", async () => {
    for (const payload of [
      { athleteId: B },
      { athlete_id: B },
      { identity: B },
      { sub: B },
      { metadata: { athleteId: B } },
      { athleteId: B, conversationId: bConversation },
    ]) {
      const res = await mint(A_TOKEN, payload);
      expect(res.status).toBe(200);
      expect(res.body.identity).toBe(voiceIdentityFor(A));
      expect(dispatchMetadata(res.body.token).athleteId).toBe(A);
      // B's id must not appear anywhere in what A is handed, including inside
      // the signed token.
      expect(JSON.stringify(res.body)).not.toContain(B);
    }
  });

  it("gives two different callers two different identities", async () => {
    // A fixed id would satisfy every assertion above.
    const a = await mint(A_TOKEN);
    const b = await mint(B_TOKEN);
    expect(dispatchMetadata(a.body.token).athleteId).toBe(A);
    expect(dispatchMetadata(b.body.token).athleteId).toBe(B);
    expect(a.body.identity).not.toBe(b.body.identity);
  });
});

// ─── G2 ───────────────────────────────────────────────────────────────────────

describe("G2 — a conversation id is resolved against ownership, never adopted", () => {
  it("does not give A B's conversation, and does not disclose that it exists", async () => {
    const res = await mint(A_TOKEN, { conversationId: bConversation });

    // 200, not 4xx: an error would confirm the guessed id is real and owned.
    expect(res.status).toBe(200);
    expect(res.body.conversationId).not.toBe(bConversation);
    expect(dispatchMetadata(res.body.token).conversationId).not.toBe(
      bConversation,
    );
  });

  it("leaves B's conversation row byte-for-byte untouched", async () => {
    const before = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, bConversation));

    await mint(A_TOKEN, { conversationId: bConversation });

    const after = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, bConversation));

    expect(after).toHaveLength(1); // no second row forked off the same id
    expect(after[0].athlete_id).toBe(B); // not re-owned
    expect(after[0].title).toBe(before[0].title); // not retitled
    expect(after[0].updated_at?.getTime()).toBe(
      before[0].updated_at?.getTime(),
    );
  });

  it("hands A a thread that is A's own", async () => {
    const res = await mint(A_TOKEN, { conversationId: bConversation });
    const substitute = res.body.conversationId;

    // Whatever A got, it is either unclaimed or A's — never B's.
    const [row] = await db
      .select({ athlete_id: conversations.athlete_id })
      .from(conversations)
      .where(eq(conversations.id, substitute));
    if (row) expect(row.athlete_id).toBe(A);

    // And it is usable: A can write into it.
    const write = await writeTurn(A, substitute, "A's turn");
    expect(write.status).toBe(200);
  });

  it("honours a conversation A does own", async () => {
    // The negative case needs its positive twin, or "always mint fresh" would
    // pass every assertion above while silently breaking the unified transcript.
    const aOwn = randomUUID();
    await db
      .insert(conversations)
      .values({ id: aOwn, athlete_id: A, title: "A's thread" } as any);

    const res = await mint(A_TOKEN, { conversationId: aOwn });
    expect(res.body.conversationId).toBe(aOwn);
    expect(dispatchMetadata(res.body.token).conversationId).toBe(aOwn);
  });
});

// ─── G3 ───────────────────────────────────────────────────────────────────────

describe("G3 — a persisted turn is visible only in the speaker's own thread", () => {
  it("the full chain: A mints, A's worker writes, B sees nothing of it", async () => {
    // This is the composite no single-module suite covers. Every id below comes
    // from the server's own decision, not from the test.
    const minted = await mint(A_TOKEN, { conversationId: bConversation });
    const { athleteId, conversationId } = dispatchMetadata(minted.body.token);

    // A's worker writes back using exactly what it was dispatched with.
    const write = await writeTurn(athleteId, conversationId, "A's spoken turn");
    expect(write.status).toBe(200);

    // B, reading their own thread through the real access layer, sees only
    // their own turn.
    const bMessages = await getConversationMessages(B, bConversation);
    expect(bMessages.map((m) => m.content)).toEqual([
      "B said something private",
    ]);
    expect(JSON.stringify(bMessages)).not.toContain("A's spoken turn");

    // And A sees theirs.
    const aMessages = await getConversationMessages(A, conversationId);
    expect(aMessages.map((m) => m.content)).toEqual(["A's spoken turn"]);
  });

  it("a turn written against B's conversation id under A's athlete id is invisible to B", async () => {
    // The worker is trusted infrastructure holding the service secret, so this
    // is the shape a BUG takes rather than an attack: a mismatched pair reaching
    // the write. It must still be unreadable by B, because every read filters on
    // both columns rather than on the conversation alone.
    await writeTurn(A, bConversation, "mismatched pair");

    const bMessages = await getConversationMessages(B, bConversation);
    expect(JSON.stringify(bMessages)).not.toContain("mismatched pair");

    // The row exists, under A — the isolation is in the read filter, and this
    // asserts that rather than assuming the write was rejected.
    const rows = await db
      .select({ athlete_id: chatMessages.athlete_id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversation_id, bConversation),
          eq(chatMessages.athlete_id, A),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("A's substitute thread never appears in B's saved-chats list", async () => {
    const minted = await mint(A_TOKEN, { conversationId: bConversation });
    const { conversationId } = dispatchMetadata(minted.body.token);
    await writeTurn(A, conversationId, "A's turn");

    const bList = await listConversations(B);
    expect(bList.map((c) => c.id)).not.toContain(conversationId);
    expect(bList.map((c) => c.id)).toContain(bConversation);
  });

  it("does not let A's write bump the recency of B's thread", async () => {
    // Ordering is a leak of a smaller kind: B's list re-sorting when B did
    // nothing would disclose that someone else touched their id.
    const [before] = await db
      .select({ updated_at: conversations.updated_at })
      .from(conversations)
      .where(eq(conversations.id, bConversation));

    await writeTurn(A, bConversation, "A poking B's thread");

    const [after] = await db
      .select({ updated_at: conversations.updated_at })
      .from(conversations)
      .where(eq(conversations.id, bConversation));
    expect(after.updated_at?.getTime()).toBe(before.updated_at?.getTime());
  });
});

// ─── G4 ───────────────────────────────────────────────────────────────────────

describe("G4 — the voice_context upsert will not overwrite a row it does not own", () => {
  const B_DEAL = "402bb00c-8fef-44bd-afcc-9e9053aff49e";
  const A_DEAL = "11111111-2222-4333-8444-555555555555";

  it("refuses to overwrite B's row when A posts against B's conversation id", async () => {
    // voice_context is keyed on conversation_id ALONE (it is the primary key),
    // so this is the one table where a foreign id collides directly. The upsert's
    // athlete-scoped `where` is the only thing preventing the overwrite.
    await writeContext(B, bConversation, B_DEAL);
    const before = await getVoiceContext(B, bConversation);
    expect(before?.dealsDiscussed.map((d) => d.dealId)).toEqual([B_DEAL]);

    // A posts against the same conversation id with A's own deal.
    await writeContext(A, bConversation, A_DEAL);

    // B's row is unchanged — still B's deal, still owned by B.
    const after = await getVoiceContext(B, bConversation);
    expect(after?.dealsDiscussed.map((d) => d.dealId)).toEqual([B_DEAL]);

    const [row] = await db
      .select({ athlete_id: voiceContext.athlete_id })
      .from(voiceContext)
      .where(eq(voiceContext.conversation_id, bConversation));
    expect(row.athlete_id).toBe(B);
  });

  it("A cannot read the row it failed to overwrite", async () => {
    await writeContext(B, bConversation, B_DEAL);
    await writeContext(A, bConversation, A_DEAL);

    // The read is scoped by both columns, so A gets nothing at all — not B's
    // deal, and not A's own (which was never written).
    expect(await getVoiceContext(A, bConversation)).toBeNull();
  });

  it("still records normally for A's own conversation", async () => {
    // The refusal must be about ownership, not about writes failing generally.
    const minted = await mint(A_TOKEN);
    const { conversationId } = dispatchMetadata(minted.body.token);

    await writeContext(A, conversationId, A_DEAL);
    const ctx = await getVoiceContext(A, conversationId);
    expect(ctx?.dealsDiscussed.map((d) => d.dealId)).toEqual([A_DEAL]);
  });
});

// ─── G5 ───────────────────────────────────────────────────────────────────────

describe("G5 — a secret holder changing the path athlete gets 403", () => {
  // Every write above holds the service secret, which on its own names ANY
  // athlete in the path. The session grant closes that: it is minted from A's
  // verified session into A's dispatch metadata, and once VOICE_GRANT_ENFORCE is
  // on, A's grant opens A's paths and nothing else.

  it("mints a grant for the caller into the dispatch metadata", async () => {
    const meta = dispatchMetadata((await mint(A_TOKEN)).body.token);
    expect(typeof meta.grant).toBe("string");
  });

  it("enforced: A's grant on B's path is 403, and B's thread is untouched", async () => {
    process.env.VOICE_GRANT_ENFORCE = "true";
    const { grant } = dispatchMetadata((await mint(A_TOKEN)).body.token);

    const res = await writeTurn(B, bConversation, "A posing as B", "user", grant);
    expect(res.status).toBe(403);

    const bMessages = await getConversationMessages(B, bConversation);
    expect(bMessages.map((m) => m.content)).toEqual([
      "B said something private",
    ]);
  });

  it("enforced: the secret alone is no longer enough (401)", async () => {
    process.env.VOICE_GRANT_ENFORCE = "true";
    const res = await writeTurn(B, bConversation, "secret only", "user", null);
    expect(res.status).toBe(401);
  });

  it("enforced: A's grant still works on A's own path", async () => {
    process.env.VOICE_GRANT_ENFORCE = "true";
    const meta = dispatchMetadata((await mint(A_TOKEN)).body.token);
    const res = await writeTurn(
      A,
      meta.conversationId,
      "A's own turn",
      "user",
      meta.grant,
    );
    expect(res.status).toBe(200);
  });

  it("observe mode (flag unset): the transcript write is still bound to the grant (403), unlike the read routes", async () => {
    // The other routes let a mismatch through in observe mode (the log line is the signal; server/voice/auth.test.ts).
    // The transcript is where the athlete's own words are written, so it binds to a valid grant always (security
    // review of #1251, 10 Nov 2026): A's grant can never write into B's thread.
    const { grant } = dispatchMetadata((await mint(A_TOKEN)).body.token);
    const res = await writeTurn(B, bConversation, "observe mode", "user", grant);
    expect(res.status).toBe(403);
  });
});

// ─── The guarantee, as one assertion ──────────────────────────────────────────

describe("the whole guarantee, in one pass", () => {
  it("A exercises every request A can make; B's world is unchanged", async () => {
    const snapshot = async () => ({
      conversations: await db
        .select()
        .from(conversations)
        .where(eq(conversations.athlete_id, B)),
      messages: await getConversationMessages(B, bConversation),
      context: await getVoiceContext(B, bConversation),
    });

    await writeContext(
      B,
      bConversation,
      "402bb00c-8fef-44bd-afcc-9e9053aff49e",
    );
    const before = await snapshot();

    // Everything A can do, aimed at B. Every token is inspected, not just the
    // last one — a mint that quietly returned B's identity would otherwise pass
    // this test as long as it wrote nothing.
    const attempts = [
      { athleteId: B },
      { conversationId: bConversation },
      { athleteId: B, conversationId: bConversation },
      { athlete_id: B, conversation_id: bConversation },
    ];

    let last: { athleteId: string; conversationId: string } | null = null;
    for (const payload of attempts) {
      const res = await mint(A_TOKEN, payload);
      const meta = dispatchMetadata(res.body.token);
      // A never becomes B, and never acquires B's thread — on ANY attempt.
      expect(meta.athleteId).toBe(A);
      expect(meta.conversationId).not.toBe(bConversation);
      expect(JSON.stringify(res.body)).not.toContain(B);
      last = meta;
    }

    // Then A's worker does everything a real session does with what it was given.
    await writeTurn(last!.athleteId, last!.conversationId, "A's session");
    await writeContext(
      last!.athleteId,
      last!.conversationId,
      "11111111-2222-4333-8444-555555555555",
    );

    // And the two writes aimed straight at B's thread. These need the service
    // secret, so they are the shape a WORKER BUG takes rather than something A
    // can send — but B's rows must survive them either way, because the tenancy
    // check in each write path is what stands between a mismatched pair and
    // another athlete's data.
    await writeTurn(A, bConversation, "A aiming at B's thread");
    await writeContext(
      A,
      bConversation,
      "11111111-2222-4333-8444-555555555555",
    );

    // B's world is byte-identical to before A did any of that.
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
