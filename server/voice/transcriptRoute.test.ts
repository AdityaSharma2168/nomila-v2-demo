/**
 * transcriptRoute.test.ts — voice turns joining the text thread.
 * DB is PGlite (real SQL); no network, no model.
 *
 * The property that matters most here is the one that is easy to lose later:
 * a voice turn is an ORDINARY chat message with a channel tag. It shares the
 * conversation, it uses the existing roles, and it is loadable by exactly the
 * same query the text path already uses. If `source` ever became a role, or the
 * conversation ever forked, this suite is what fails.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import voiceTranscriptRouter from "./transcriptRoute";
import { mintVoiceGrant, VOICE_GRANT_HEADER } from "./auth";
import { chatMessages, conversations } from "../../shared/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const SECRET = "voice-test-secret-0123456789";
const GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";
const CONV = "11111111-1111-4111-8111-111111111111";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  id?: string,
) {
  // The worker sends the session's grant with every write (the route binds the turn to it): one for the path athlete
  // and the body's conversation, unless the test sets its own (or sends no secret at all).
  const conv = (body as { conversationId?: unknown } | null)?.conversationId;
  const grant: Record<string, string> = headers["x-voice-secret"] && !(VOICE_GRANT_HEADER in headers) && typeof conv === "string"
    ? { [VOICE_GRANT_HEADER]: mintVoiceGrant(id ?? athleteId, conv)!.grant } : {};
  const res = await fetch(`${base}/athletes/${id ?? athleteId}/transcript`, {
    method: "POST",
    headers: { "content-type": "application/json", ...grant, ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, raw };
}

const auth = { "x-voice-secret": SECRET };

const turn = (over: Record<string, unknown> = {}) => ({
  conversationId: CONV,
  role: "user",
  content: "Should I take the Prime Hydration deal?",
  ...over,
});

const rows = () =>
  db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.athlete_id, athleteId))
    .orderBy(asc(chatMessages.created_at));

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Transcript Athlete");
  otherAthleteId = await seedAthlete("Transcript Other");

  const app = express();
  app.use(express.json());
  app.use("/", voiceTranscriptRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.VOICE_SERVICE_SECRET;
  delete process.env.VOICE_GRANT_SECRET;
});

beforeEach(async () => {
  process.env.VOICE_SERVICE_SECRET = SECRET;
  process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
  await db.delete(chatMessages);
  await db.delete(conversations);
});

describe("transcript — auth and validation", () => {
  it("401s without the secret", async () => {
    expect((await post(turn())).status).toBe(401);
  });

  it("401s on a wrong-length and a same-length-wrong secret", async () => {
    expect((await post(turn(), { "x-voice-secret": "short" })).status).toBe(
      401,
    );
    expect(
      (await post(turn(), { "x-voice-secret": "X".repeat(SECRET.length) }))
        .status,
    ).toBe(401);
  });

  it("400s on a bad athlete or conversation id", async () => {
    expect((await post(turn(), auth, "not-a-uuid")).status).toBe(400);
    expect((await post(turn({ conversationId: "nope" }), auth)).status).toBe(
      400,
    );
  });

  it("400s on a role voice cannot produce", async () => {
    // `system` and `tool` exist in chat_role_check but never come from speech.
    for (const role of ["system", "tool", "narrator", 7, null]) {
      expect((await post(turn({ role }), auth)).status).toBe(400);
    }
  });

  it("binds the write to the session grant: an athlete turn needs one; another athlete's or conversation's is 403", async () => {
    expect((await post(turn(), { ...auth, [VOICE_GRANT_HEADER]: "" })).status).toBe(401);
    const other = mintVoiceGrant(otherAthleteId, CONV)!.grant;
    expect((await post(turn(), { ...auth, [VOICE_GRANT_HEADER]: other })).status).toBe(403);
    const elsewhere = mintVoiceGrant(athleteId, "22222222-2222-4222-8222-222222222222")!.grant;
    expect((await post(turn(), { ...auth, [VOICE_GRANT_HEADER]: elsewhere })).status).toBe(403);
    expect((await post(turn({ role: "assistant" }), { ...auth, [VOICE_GRANT_HEADER]: elsewhere })).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("writes nothing at all when the guard rejects", async () => {
    await post(turn());
    expect(await rows()).toHaveLength(0);
  });
});

describe("transcript — what gets stored", () => {
  it("stores a voice turn as an ordinary chat message with a channel tag", async () => {
    const res = await post(turn(), auth);
    expect(res.body).toEqual({ stored: true });

    const [row] = await rows();
    expect(row.role).toBe("user");
    expect(row.source).toBe("voice");
    expect(row.conversation_id).toBe(CONV);
    expect(row.content).toBe("Should I take the Prime Hydration deal?");
  });

  it("keeps role user/assistant so chat_role_check is untouched", async () => {
    // The channel lives in `source`. If it ever migrated into `role`, the CHECK
    // would need a DROP/ADD pair — the exact concurrent-deploy hazard we avoided.
    await post(
      turn({ role: "assistant", content: "Yeah, I'd take it." }),
      auth,
    );
    const [row] = await rows();
    expect(["user", "assistant"]).toContain(row.role);
    expect(row.role).not.toBe("voice");
  });

  it("interleaves with text turns in ONE conversation", async () => {
    // The product model: text and voice share a thread. A text row is written
    // directly here, as the chat path would.
    await db.insert(chatMessages).values({
      athlete_id: athleteId,
      conversation_id: CONV,
      role: "user",
      content: "typed question",
    });
    await post(turn({ role: "assistant", content: "spoken answer" }), auth);

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.conversation_id)).toEqual([CONV, CONV]);
    // The text row is untagged; only the voice row carries a channel.
    expect(all.map((r) => r.source)).toEqual([null, "voice"]);
  });

  it("is loadable by the SAME query the text path uses", async () => {
    // loadHistory selects by (athlete_id, conversation_id) and orders by time.
    // A voice turn must be indistinguishable to it apart from `source`.
    await post(turn(), auth);
    const loaded = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.athlete_id, athleteId),
          eq(chatMessages.conversation_id, CONV),
        ),
      );
    expect(loaded).toHaveLength(1);
  });

  it("creates the conversation row so saved-chats sees it", async () => {
    await post(turn(), auth);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONV));
    expect(conv.athlete_id).toBe(athleteId);
    expect(conv.title).toBeTruthy();
  });

  it("does not overwrite a title an earlier message set", async () => {
    await post(turn({ content: "first thing said" }), auth);
    await post(turn({ content: "a much later turn" }), auth);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONV));
    expect(conv.title).toContain("first thing said");
  });
});

describe("transcript — degrades rather than losing the call", () => {
  it("treats an empty turn as nothing to store, not an error", async () => {
    // The realtime model emits items with no text (a tool-call-only turn).
    for (const content of ["", "   ", undefined, 42]) {
      const res = await post(turn({ content }), auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stored: false });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("truncates an over-long turn rather than dropping it", async () => {
    // Losing a turn from the transcript is worse than storing a clipped one.
    const res = await post(turn({ content: "x".repeat(20_000) }), auth);
    expect(res.body).toEqual({ stored: true });
    const [row] = await rows();
    expect(row.content!.length).toBe(8_000);
  });
});

describe("transcript — tenancy", () => {
  it("stores against the athlete in the path, not one in the body", async () => {
    // A body-supplied athlete must be ignored entirely.
    await post(turn({ athleteId: otherAthleteId }), auth);
    const [row] = await rows();
    expect(row.athlete_id).toBe(athleteId);
  });

  it("keeps two athletes' turns on the same conversation id apart", async () => {
    // A guessed conversation uuid must not merge one athlete's speech into
    // another's thread.
    await post(turn({ content: "mine" }), auth);
    await post(turn({ content: "theirs" }), auth, otherAthleteId);

    const mine = await rows();
    expect(mine).toHaveLength(1);
    expect(mine[0].content).toBe("mine");

    const theirs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.athlete_id, otherAthleteId));
    expect(theirs).toHaveLength(1);
    expect(theirs[0].content).toBe("theirs");
  });

  it("does not let a second athlete claim an existing conversation row", async () => {
    await post(turn(), auth);
    await post(turn(), auth, otherAthleteId);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONV));
    expect(conv.athlete_id).toBe(athleteId);
  });
});
