/**
 * readsMastra.db.test.ts — Mila's read tools and the CONTEXT parity on a REAL Mastra turn (PGlite, the real Agent loop
 * with a scripted model: no provider, no network; the query embedding is mocked). Made-up athletes.
 *
 *   RM1 a turn calls media_search, posts_performance, money_summary and whats_next in-process through the athlete pass
 *       (callPassTool): each is recorded ok; the model reads the athlete's rows (fenced) and never the other athlete's;
 *       chat v2's client stream carries none of those rows (status lines and text only)
 *   RM2 the turn input carries the parity sections: this conversation's rolling summary and the last other
 *       conversations' summaries (never another athlete's), the PREFERENCES line
 *   RM3 the rolling summary fold is started after the reply is saved, for this athlete and conversation, and the turn
 *       never waits for it (a fold that never finishes does not hold the turn); an isolated turn starts none
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
jest.mock("../../lib/mediaEmbed", () => ({ ...jest.requireActual("../../lib/mediaEmbed"), embedText: jest.fn(async () => [1, 0, 0, 0]) }));
jest.mock("../../lib/mediaStore", () => ({ ...jest.requireActual("../../lib/mediaStore"), signedUrl: jest.fn(async () => { throw new Error("never signed"); }) }));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentRuns, conversations, deals, mediaAssets, memoryPreferences, payments } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../testUtils/mastraScripted";
import type { SSEStream } from "../../lib/sse";
import { clearJobCache } from "../jobs";
import { runMastraTurn, type MastraTurnDeps } from "../engine/mastra/turn";
import { createChatV2Stream, type UiPart } from "../engine/mastra/chatV2Stream";

const KEY = "reads-mastra-test-pass-key-0123456789-0123456789";
const ENV = ["NOMILA_MCP_PASS_KEY", "MILA_READ_TOOLS"] as const;
const saved: Record<string, string | undefined> = {};
let A = "";
let B = "";
let assetA = "";
let assetB = "";

function sse(): SSEStream {
  const s: any = { closed: false, signal: new AbortController().signal };
  s.status = () => undefined; s.token = () => undefined; s.done = () => undefined; s.suggestions = () => undefined;
  s.profileUpdates = () => undefined; s.error = () => undefined; s.close = () => { s.closed = true; }; s.abort = () => undefined;
  return s;
}

async function engine(steps: ScriptedStep[], over: Partial<MastraTurnDeps> = {}) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model);
  const deps: MastraTurnDeps = { runtime: async () => rt, passKey: KEY, spentToday: async () => 0, isDeleting: async () => false, toolsDeleting: async () => false, ...over };
  return { m, deps };
}

async function seed(athleteId: string, tag: string, cents: number) {
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "instagram", origin: "connected", source_media_id: `src-${tag}`, media_type: "IMAGE",
    posted_at: new Date(), like_count: 5, comments_count: 1, gcs_path: `athletes/${tag}/1.jpg`, content_type: "image/jpeg", status: "stored",
    metadata: { vision: { athlete_present: true, subject: "the_athlete", shot_type: "portrait", description: `${tag}-moment on the dock`, brands_visible: [], aesthetic_quality: 0.9, brand_safe: true, disposition: "as_is", edit_note: "", reason: "", setting: "", attire: "", vibe: "", hero_suitability: 0.8, athlete_prominence: 0.9 }, embedding: [1, 0, 0, 0] },
  } as any).returning({ id: mediaAssets.id });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: `${tag}-brand`, status: "accepted", source: "self_reported" } as any).returning({ id: deals.id });
  await db.insert(payments).values({ deal_id: d.id, athlete_id: athleteId, kind: "deal_payment", status: "settled", deal_value_cents: cents, updated_at: new Date() } as any);
  await db.insert(conversations).values({ id: randomUUID(), athlete_id: athleteId, title: "older chat", summary: `${tag}-summary of an older chat`, updated_at: new Date(Date.now() - 3_600_000) } as any);
  return r.id;
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  process.env.MILA_READ_TOOLS = "true";
  await initTestDb();
  A = await seedAthlete("Rowan Vale");
  B = await seedAthlete("Other Person");
  assetA = await seed(A, "alpha", 125_000);
  assetB = await seed(B, "bravo", 777_700);
  await db.insert(memoryPreferences).values({ athlete_id: A, kind: "style", statement: "Keep replies short", source: "said", status: "active" } as any);
}, 120_000);
afterAll(async () => {
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => clearJobCache());

const READS = [
  { name: "media_search", args: { query: "on the dock" } },
  { name: "posts_performance", args: {} },
  { name: "money_summary", args: {} },
  { name: "whats_next", args: {} },
];

describe("RM1–RM3: the read tools and the CONTEXT on a Mastra turn", () => {
  it("runs the reads through the pass, shows the model her rows only, and keeps them out of the client stream", async () => {
    const CONV = randomUUID();
    let folded: [string, string] | null = null;
    const { m, deps } = await engine([{ tools: READS }, { text: "Here is what I found." }], {
      conversationSummary: async () => "Earlier they asked about a dock shoot.",
      // A fold that never finishes: the turn must not wait for it.
      fold: (a, c) => { folded = [a, c]; return new Promise<void>(() => undefined); },
    });
    const parts: UiPart[] = [];
    const stream = await createChatV2Stream((p) => parts.push(p));
    const res = await runMastraTurn({ athleteId: A, message: "Which photo should I post, and how much have I earned?", conversationId: CONV, sse: sse(), tap: stream.tap }, deps);
    await stream.end({ runId: res.runId, status: res.status, stopReason: res.stopReason ?? null, cards: res.cards }, []);

    expect(res).toMatchObject({ status: "completed", text: "Here is what I found." });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect((run.tools_called as any[]).map((t) => [t.name, t.outcome]).sort()).toEqual(READS.map((r) => [r.name, "ok"]).sort());

    // The model read her rows (the second call's prompt holds the tool results), never the other athlete's.
    const seen = JSON.stringify(m.prompts[1]);
    expect(seen).toContain(assetA);
    expect(seen).toContain("alpha-moment on the dock");
    expect(seen).toContain("$1,250");
    expect(seen).not.toContain(assetB);
    expect(seen).not.toMatch(/bravo|7,777/);

    // RM1: the client stream: status lines and text, never a row.
    const wire = JSON.stringify(parts);
    expect(wire).not.toContain(assetA);
    expect(wire).not.toMatch(/alpha|1,250|athletes\//);
    expect(parts.filter((p) => p.type === "data-mila-status").map((p: any) => p.data.label)).toEqual(expect.arrayContaining(["Looking through your photos and videos…"]));

    // RM2: the turn input's CONTEXT parity sections.
    const input = JSON.stringify(m.prompts[0]);
    expect(input).toContain("EARLIER IN THIS CONVERSATION Earlier they asked about a dock shoot.");
    expect(input).toContain("RECENT CONVERSATIONS (1) alpha-summary of an older chat");
    expect(input).not.toContain("bravo-summary");
    expect(input).toContain("PREFERENCES style: Keep replies short");
    expect(input).toContain("Library: search their photos and videos by what is in them.");

    // RM3: the fold was started for her conversation; the turn returned without waiting for it.
    expect(folded).toEqual([A, CONV]);
  });

  it("an isolated turn starts no fold and reads no conversation summary", async () => {
    const fold = jest.fn(async () => undefined);
    const conversationSummary = jest.fn(async () => "never");
    const { deps } = await engine([{ text: "ok" }], { fold, conversationSummary });
    await runMastraTurn({ athleteId: A, message: null, conversationId: randomUUID(), sse: sse() }, deps, { isolated: true, trigger: "event" });
    expect(fold).not.toHaveBeenCalled();
    expect(conversationSummary).not.toHaveBeenCalled();
  });
});
