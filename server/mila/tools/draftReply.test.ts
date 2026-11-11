/**
 * draft_reply tool tests — real SQL against in-memory Postgres (PGlite), Kimi mocked.
 *
 * The load-bearing invariant: draft_reply DRAFTS ONLY. It produces a reply_action
 * widget payload and NEVER sends — no outbound message, no pending action. Also:
 * IDOR (A can't draft on B's deal), platform-derived sendability (Outlook / no thread
 * → not sendable), and the leak-lint refusal → no-Send state.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/kimi", () => ({ kimiStream: jest.fn() }));

import { draftReplyTool } from "./draftReply";
import { buildWidget } from "../widgets";
import { kimiStream } from "../../lib/kimi";
import {
  deals,
  inboxThreads,
  inboxMessages,
  pendingActions,
  athletes,
} from "../../../shared/schema";
import { and, eq } from "drizzle-orm";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

const kimiMock = kimiStream as jest.Mock;

/** An OpenAI-style streaming completion that yields each part as a delta. */
async function* streamOf(parts: string[]) {
  for (const p of parts) yield { choices: [{ delta: { content: p } }] } as any;
}

let athleteA: string;
let athleteB: string;
let dealGmail: string;
let dealOutlook: string;
let dealNoThread: string;
let dealB: string;
let threadGmail: string;

async function seedDealWithThread(
  owner: string,
  platform: string,
): Promise<{ dealId: string; threadId: string }> {
  const [deal] = await db
    .insert(deals)
    .values({
      athlete_id: owner,
      brand_name: "Acme",
      status: "detected",
      amount: "800",
    } as any)
    .returning({ id: deals.id });
  const [thread] = await db
    .insert(inboxThreads)
    .values({
      athlete_id: owner,
      subject: "Collab?",
      deal_id: deal.id,
      last_message_at: new Date(),
    } as any)
    .returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: thread.id,
    athlete_id: owner,
    direction: "inbound",
    sender_email: "brand@acme.com",
    sender_name: "Sarah",
    body: "Want to work together?",
    platform,
    received_at: new Date(),
  } as any);
  return { dealId: deal.id, threadId: thread.id };
}

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");
  // A confidential floor so negotiate drafts run the leak-buffer path.
  await db
    .update(athletes)
    .set({ deal_preferences: { minimum_rate: 2000 } as any })
    .where(eq(athletes.id, athleteA));

  ({ dealId: dealGmail, threadId: threadGmail } = await seedDealWithThread(
    athleteA,
    "gmail",
  ));
  ({ dealId: dealOutlook } = await seedDealWithThread(athleteA, "outlook"));

  const [noThread] = await db
    .insert(deals)
    .values({
      athlete_id: athleteA,
      brand_name: "Adidas",
      status: "detected",
    } as any)
    .returning({ id: deals.id });
  dealNoThread = noThread.id;

  const [b] = await db
    .insert(deals)
    .values({
      athlete_id: athleteB,
      brand_name: "RivalCo",
      status: "detected",
    } as any)
    .returning({ id: deals.id });
  dealB = b.id;
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a clean, non-leaking accept body.
  kimiMock.mockImplementation(async () =>
    streamOf([
      "Thanks so much for reaching out — ",
      "I'd love to explore this together.",
    ]),
  );
});

describe("draft_reply — drafts, never sends", () => {
  it("produces a sendable reply_action payload and writes NO outbound / NO pending action", async () => {
    const result = (await draftReplyTool.execute(athleteA, {
      deal_id: dealGmail,
      reply_intent: "accept",
      style: "friendly",
      voice: "athlete",
    })) as Record<string, unknown>;

    expect(result.deal_id).toBe(dealGmail);
    expect(result.thread_id).toBe(threadGmail);
    expect(result.platform).toBe("gmail");
    expect(result.sendable).toBe(true);
    expect(result.refusal).toBeNull();
    expect(typeof result.draft).toBe("string");
    expect(result.draft as string).toContain("explore this together");

    // The whole point: nothing left the app.
    const outbound = await db
      .select()
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.thread_id, threadGmail),
          eq(inboxMessages.direction, "outbound"),
        ),
      );
    expect(outbound).toHaveLength(0);
    const pending = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.athlete_id, athleteA));
    expect(pending).toHaveLength(0);

    // buildWidget shapes it into an interactive card.
    const widget = buildWidget("draft_reply", result);
    expect(widget?.type).toBe("reply_action");
    expect((widget as any).data.sendable).toBe(true);
    expect((widget as any).data.draft).toContain("explore this together");
  });

  it("blocks IDOR: another athlete's deal_id returns null (no draft, no send)", async () => {
    await expect(
      draftReplyTool.execute(athleteA, {
        deal_id: dealB,
        reply_intent: "accept",
        style: "friendly",
        voice: "athlete",
      }),
    ).resolves.toBeNull();
    expect(kimiMock).not.toHaveBeenCalled(); // never even drafted
  });

  it("returns null for a malformed deal_id (no DB cast error)", async () => {
    await expect(
      draftReplyTool.execute(athleteA, {
        deal_id: "not-a-uuid",
        reply_intent: "accept",
        style: "friendly",
        voice: "athlete",
      }),
    ).resolves.toBeNull();
  });

  it("Outlook thread → drafts but is NOT sendable (no in-app send path)", async () => {
    const result = (await draftReplyTool.execute(athleteA, {
      deal_id: dealOutlook,
      reply_intent: "accept",
      style: "friendly",
      voice: "athlete",
    })) as Record<string, unknown>;

    expect(result.platform).toBe("outlook");
    expect(result.sendable).toBe(false);
    expect(typeof result.draft).toBe("string"); // still drafted (paste-manually)
    const widget = buildWidget("draft_reply", result);
    expect((widget as any).data.sendable).toBe(false);
  });

  it("deal with no thread → drafts but is NOT sendable", async () => {
    const result = (await draftReplyTool.execute(athleteA, {
      deal_id: dealNoThread,
      reply_intent: "accept",
      style: "friendly",
      voice: "athlete",
    })) as Record<string, unknown>;

    expect(result.thread_id).toBeNull();
    expect(result.sendable).toBe(false);
  });

  it("leak-lint refusal → refusal message, no draft, not sendable (no-Send state)", async () => {
    // Negotiate + a confidential floor triggers the leak buffer; a body that trips
    // LEAK_PHRASES leaks on both attempts → the core refuses.
    kimiMock.mockImplementation(async () =>
      streamOf([
        "Your offer is below market and my minimum rate is higher, so let's revisit.",
      ]),
    );

    const result = (await draftReplyTool.execute(athleteA, {
      deal_id: dealGmail,
      reply_intent: "negotiate",
      style: "friendly",
      voice: "athlete",
      selected_terms: ["Rate"],
    })) as Record<string, unknown>;

    expect(result.draft).toBeNull();
    expect(typeof result.refusal).toBe("string");
    expect(result.sendable).toBe(false);
    expect(kimiMock).toHaveBeenCalledTimes(2); // first attempt + one retry, both leaked

    const widget = buildWidget("draft_reply", result);
    expect(widget?.type).toBe("reply_action");
    expect((widget as any).data.draft).toBeNull();
    expect((widget as any).data.refusal).toBeTruthy();
    expect((widget as any).data.sendable).toBe(false);
  });

  it("generation failure → honest no-Send refusal, never a fabricated glitch or manual-send nudge", async () => {
    // Model call blows up → the core returns gen_error → the tool surfaces an honest
    // refusal card, NOT a bare { error } the model can dress up as a glitch.
    kimiMock.mockImplementation(async () => {
      throw new Error("Vertex unavailable");
    });

    const result = (await draftReplyTool.execute(athleteA, {
      deal_id: dealGmail,
      reply_intent: "accept",
      style: "friendly",
      voice: "athlete",
    })) as Record<string, unknown>;

    expect(result.draft).toBeNull();
    expect(result.sendable).toBe(false);
    expect(result).not.toHaveProperty("error"); // a refusal card, not an { error } (no card)
    const refusal = result.refusal as string;
    // Honest "couldn't draft … right now" — no invented cause, no manual-send push.
    expect(refusal.toLowerCase()).toContain("couldn't draft");
    expect(refusal).not.toMatch(
      /glitch|outage|temporar|email|dm |messag.*yourself|manual|yourself/i,
    );

    // Renders as a deterministic refusal card (no draft, no Send).
    const widget = buildWidget("draft_reply", result);
    expect(widget?.type).toBe("reply_action");
    expect((widget as any).data.refusal).toBe(refusal);
    expect((widget as any).data.draft).toBeNull();
    expect((widget as any).data.sendable).toBe(false);
  });
});
