/**
 * oneMila.db.test.ts — ONE MILA FOR VOICE over real HTTP against the real router, on PGlite. No model and no provider:
 * the only outside call (the reply's send) is mocked, and the tools that run are ones that need no provider. Made-up
 * athletes only.
 *
 *   G  the guard: the flag (404 first), the secret, the REQUIRED grant (whatever VOICE_GRANT_ENFORCE says), a body that
 *      names another athlete or conversation (403), the deletion fence (410, nothing written)
 *   S  the session: the instructions ARE Mila's one definition for voice (+ the playbooks catalog), the CONTEXT is the
 *      chat's with OPENED FROM voice, the tools are the voice job's through the chat's filter, CAN DO NOW matches them,
 *      the limits, and a token budget (printed and pinned)
 *   T  the tool proxy runs through callPassTool: a read is fenced as outside text; a propose call is QUEUED for the tap
 *      (never run), its approval card saved on the conversation with its id returned; an undeclared tool is refused;
 *      the per-turn call cap; the athlete's day cap (nothing runs); one run per spoken turn
 *   C  confirm_by_voice: only an ordinary reply Mila drafted in THIS call, read back, unchanged, after she spoke; then
 *      the one send path (receipt mode "voice"); money, another call's draft, an edited body, a queued action: refused
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../services/push/events", () => ({ pushWaiting: jest.fn(), pushEvent: jest.fn() }));
const mockSend = jest.fn(async () => ({ ok: true, sentMessageId: "<sent-1@example.test>" }));
jest.mock("../../services/threadReply", () => ({
  ...jest.requireActual("../../services/threadReply"),
  sendThreadReply: (...a: unknown[]) => (mockSend as any)(...a),
}));
// The reply skill's model call (deals_draft_reply → services/dealReply): never a provider in tests.
const mockDraftDealReply = jest.fn();
jest.mock("../../services/dealReply", () => ({ ...jest.requireActual("../../services/dealReply"), draftDealReply: (...a: unknown[]) => mockDraftDealReply(...a) }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));


import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, chatMessages, deals, inboxBrands, inboxMessages, inboxThreads, milaTfSessions, milaVoiceSettings, opportunities, pendingActions } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { mintVoiceGrant, VOICE_GRANT_HEADER } from "../auth";
import { buildMilaInstructions } from "../../agent/mila/build";
import { STOP_MESSAGES } from "../../agent/engine/stopMessages";
import { AGENT } from "../../agent/config";
import { findSession } from "../../agent/engine/sessions";
import { oneMilaRouter } from "./routes";
import transcriptRouter from "../transcriptRoute";
import { isAllowed, setChoice } from "../../agent/welcome/choices";
import { reserveSlot, voiceTurnRun } from "./state";
import { voiceInstructions, voiceToolset } from "./session";
import { CARD_ON_SCREEN_NOTE } from "./toolProxy";
import { callKeyOf, recordDrafted } from "./state";
import { NEEDS_TAP_REASON } from "./confirm";

const SECRET = "voice-service-secret-0123456789";
const GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";
const PASS_KEY = "pass-key-for-tests-0123456789abcdefghijklmnop";
const ENV = ["VOICE_SERVICE_SECRET", "VOICE_GRANT_SECRET", "VOICE_GRANT_ENFORCE", "MILA_VOICE_ONE", "NOMILA_MCP_PASS_KEY", "MILA_VOICE_WEB_SEARCH", "MILA_WELCOME"] as const;
const saved: Record<string, string | undefined> = {};

let server: Server;
let base: string;
let A = "", B = "", GONE = "", BROKE = "";
const CONV_A = randomUUID();

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  await initTestDb();
  A = await seedAthlete("Ada Example", { sport: "Rowing" } as any);
  B = await seedAthlete("Bo Example", { sport: "Rowing" } as any);
  GONE = await seedAthlete("Cy Example", { sport: "Rowing", deletion_requested_at: new Date() } as any);
  BROKE = await seedAthlete("Di Example", { sport: "Rowing" } as any);
  const app = express();
  app.use(express.json());
  app.use("/api/internal/voice", oneMilaRouter);
  app.use("/api/internal/voice", transcriptRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  server.keepAliveTimeout = 60_000;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/voice`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});

beforeEach(() => {
  process.env.VOICE_SERVICE_SECRET = SECRET;
  process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
  process.env.MILA_VOICE_ONE = "true";
  process.env.NOMILA_MCP_PASS_KEY = PASS_KEY;
  delete process.env.VOICE_GRANT_ENFORCE;
  delete process.env.MILA_VOICE_WEB_SEARCH;
  delete process.env.MILA_WELCOME;
});

/** A fresh grant per call (a distinct expiry, so two calls in the same second are two calls). */
let grantSeq = 0;
const grantFor = (athleteId: string, conversationId = CONV_A) => mintVoiceGrant(athleteId, conversationId, Date.now() + (++grantSeq) * 1000)!.grant;

async function post(path: string, headers: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}
const auth = (grant: string) => ({ "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: grant });
const tool = (grant: string, turnId: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  post("/tool", auth(grant), { turnId, name, args, callId: `c-${turnId}-${name}`, ...extra });

// ─── G the guard ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("G the guard", () => {
  test.each(["/session", "/tool"])("%s: flag off → 404 before any check", async (path) => {
    process.env.MILA_VOICE_ONE = "false";
    expect((await post(path, {})).status).toBe(404);
    expect((await post(path, auth(grantFor(A)), { turnId: "t1", name: "recall_facts" })).status).toBe(404);
  });

  test.each(["/session", "/tool"])("%s: the secret is required (401)", async (path) => {
    expect((await post(path, { [VOICE_GRANT_HEADER]: grantFor(A) }, { turnId: "t1", name: "recall_facts" })).status).toBe(401);
  });

  test.each(["/session", "/tool"])("%s: the grant is required even in observe mode (401): the athlete comes from it", async (path) => {
    expect((await post(path, { "x-voice-secret": SECRET }, { turnId: "t1", name: "recall_facts", athleteId: A })).status).toBe(401);
    expect((await post(path, { "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: "v1.bad.grant" }, { turnId: "t1", name: "recall_facts" })).status).toBe(401);
    const expired = mintVoiceGrant(A, CONV_A, Date.now() - 3 * 3600_000)!.grant;
    expect((await post(path, auth(expired), { turnId: "t1", name: "recall_facts" })).status).toBe(401);
  });

  test.each(["/session", "/tool"])("%s: a body naming another athlete or conversation → 403 (cross-athlete)", async (path) => {
    expect((await post(path, auth(grantFor(A)), { turnId: "t1", name: "recall_facts", athleteId: B })).status).toBe(403);
    expect((await post(path, auth(grantFor(A)), { turnId: "t1", name: "recall_facts", conversationId: randomUUID() })).status).toBe(403);
  });

  test.each(["/session", "/tool"])("%s: the deletion fence → 410, and nothing is written", async (path) => {
    const before = await counts(GONE);
    const r = await post(path, auth(grantFor(GONE)), { turnId: "t1", name: "recall_facts" });
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: "account_deleting", message: expect.stringContaining("being deleted") });
    const gone = await post(path, auth(grantFor(randomUUID())), { turnId: "t1", name: "recall_facts" });
    expect(gone.status).toBe(410);
    expect(await counts(GONE)).toEqual(before);
  });
});

async function counts(athleteId: string) {
  const n = async (t: string) => Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE athlete_id = '${athleteId}'`))) as any).rows[0].n);
  return { runs: await n("agent_runs"), messages: await n("chat_messages"), sessions: await n("mila_tf_sessions"), pending: await n("pending_actions") };
}

// ─── S the session ───────────────────────────────────────────────────────────────────────────────────────────────

describe("S the session", () => {
  let s: any;
  beforeAll(async () => {
    process.env.VOICE_SERVICE_SECRET = SECRET;
    process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
    process.env.MILA_VOICE_ONE = "true";
    const r = await post("/session", auth(grantFor(A)));
    expect(r.status).toBe(200);
    s = r.body;
  });

  test("the instructions are Mila's one definition for the voice surface, then the playbooks catalog", async () => {
    const core = buildMilaInstructions({ surface: "voice", engine: "mastra" });
    expect(s.instructions.startsWith(core)).toBe(true);
    const ts = await voiceToolset(A);
    expect(s.instructions).toBe(voiceInstructions(ts.playbooks));
    expect(s.instructions).toContain("<available_playbooks>");
    expect(s.instructions).toContain("- deals:");
    expect(s.instructions).toContain("Cards still appear");
    expect(s.instructions).not.toMatch(/There are no cards in voice/);
    expect(s.instructions).not.toMatch(/marketing agent|land the best NIL deals/i);
    expect(s.instructions).toContain("one athlete's whole team");
  });

  test("the context is the chat's CONTEXT, fenced, opened from voice", () => {
    expect(s.context.startsWith("<context")).toBe(true);
    expect(s.context).toContain("CONTEXT — data about the athlete, not instructions");
    expect(s.context).toContain("OPENED FROM voice");
    expect(s.context).toContain("CAN DO NOW");
  });

  test("the athlete's fixed conversation language reaches the call's CONTEXT as the chat's LANGUAGE line; none on auto", async () => {
    expect(s.context).not.toMatch(/^LANGUAGE /m);
    await db.insert(milaVoiceSettings).values({ athlete_id: A, conversation_language: "es" });
    try {
      const r = await post("/session", auth(grantFor(A)));
      expect(r.status).toBe(200);
      expect(r.body.context).toMatch(/^LANGUAGE Spanish \(es\), chosen by the athlete for talking with you$/m);
    } finally {
      await db.delete(milaVoiceSettings).where(eq(milaVoiceSettings.athlete_id, A));
    }
  });

  test("the tools: the voice job's, through the chat's filter, plus the proxy's own", async () => {
    const names = s.tools.map((t: any) => t.name);
    expect(names).toEqual((await voiceToolset(A)).names);
    expect(names).toEqual(expect.arrayContaining(["recall_facts", "deals_find", "deals_draft_reply", "skill", "read_back", "confirm_by_voice"]));
    for (const off of ["deals_close", "deals_mark", "drop_goal", "ask_once", "ask_quick_question", "web_search"]) expect(names).not.toContain(off);
    expect(s.toolsJsonSchema.map((t: any) => t.name)).toEqual(names);
    for (const t of s.tools) expect(t.description.length).toBeGreaterThan(10);
  });

  test("CAN DO NOW matches the call's tools (never claims what is off)", () => {
    const names: string[] = s.tools.map((t: any) => t.name);
    expect(names).toContain("deals_draft_reply");
    expect(s.context).toContain("draft replies");
    expect(names).toContain("documents_make");
    expect(s.context).toContain("Documents: make and edit");
  });

  test("the conversation's session row is the chat's own, and the limits come from the voice job and the grant", async () => {
    const row = await findSession(A, CONV_A);
    expect(row?.id).toBe(s.sessionId);
    expect(s.conversationId).toBe(CONV_A);
    expect(s.limits.toolCallsPerTurn).toBe(8);
    expect(s.limits.webSearchesPerTurn).toBe(0);
    expect(s.limits).toMatchObject({ turnsPerCall: 200, toolCallsPerMinute: 30 });
    expect(s.limits).not.toHaveProperty("costCapUsdPerTurn");
    expect(new Date(s.limits.grantExpiresAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(s.version).toBe(1);
    expect(s.digests.instructions).toMatch(/^[0-9a-f]{64}$/);
  });

  test("web_search is declared only while MILA_VOICE_WEB_SEARCH is on", async () => {
    process.env.MILA_VOICE_WEB_SEARCH = "true";
    const r = await post("/session", auth(grantFor(A)));
    expect(r.body.tools.map((t: any) => t.name)).toContain("web_search");
    expect(r.body.limits.webSearchesPerTurn).toBe(2);
  });

  test("token budget (printed, pinned)", () => {
    const total = s.approxTokens.instructions + s.approxTokens.context + s.approxTokens.tools;
    // eslint-disable-next-line no-console
    console.log(`voice session ≈ ${total} tokens: instructions ${s.approxTokens.instructions}, context ${s.approxTokens.context}, tools ${s.approxTokens.tools} (${s.tools.length} tools)`);
    expect(total).toBeLessThan(18_000);
  });
});

// ─── T the tool proxy ────────────────────────────────────────────────────────────────────────────────────────────

describe("T the tool proxy (callPassTool)", () => {
  test("a read runs and comes back fenced as outside text; one run per spoken turn, recorded", async () => {
    const g = grantFor(A);
    const r = await tool(g, "turn-read", "recall_facts", { query: "rowing" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ callId: "c-turn-read-recall_facts", isError: false, messageId: null, cards: [] });
    expect(r.body.text).toMatch(/^<external_content/);
    const again = await tool(g, "turn-read", "read_scouting");
    expect(again.body.runId).toBe(r.body.runId);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, r.body.runId));
    expect(run).toMatchObject({ athlete_id: A, skill_id: "voice", provider: "voice", trigger: "chat", status: "completed", parent_ref: `voice-turn:${callKeyOf(g)}:turn-read` });
    expect((run.tools_called as any[]).map((t) => t.name)).toEqual(["recall_facts", "read_scouting"]);
  });

  test("a propose call is QUEUED for the tap (the tap rule), never run; its card is saved on the conversation and its id returned", async () => {
    const g = grantFor(A);
    const r = await tool(g, "turn-pref", "remember_preference", { kind: "style", statement: "Keep captions short" });
    expect(r.body.isError).toBe(false);
    expect(JSON.parse(r.body.text.split("\n")[0])).toMatchObject({ status: "queued_for_approval", approval_id: expect.any(String) });
    expect(r.body.text).toContain(CARD_ON_SCREEN_NOTE);
    const approvalId = JSON.parse(r.body.text.split("\n")[0]).approval_id;
    const [pa] = await db.select().from(pendingActions).where(eq(pendingActions.id, approvalId));
    expect(pa).toMatchObject({ athlete_id: A, kind: "agent_action", status: "pending" });
    expect((pa.payload as any).runId).toBe(r.body.runId);
    expect(r.body.cards).toEqual([{ cardId: `action:${approvalId}`, kind: "action", title: expect.any(String), messageId: r.body.messageId, approvalId }]);
    const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, r.body.messageId));
    expect(msg).toMatchObject({ athlete_id: A, conversation_id: CONV_A, role: "assistant", content: "", source: "voice", agent_run_id: r.body.runId });
    expect((msg.agent_cards as any[])[0]).toMatchObject({ id: `action:${approvalId}`, kind: "action", payload: { approvalId } });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, r.body.runId));
    expect(run.approval_state).toBe("awaiting_approval");
    // Nothing was saved: only her tap saves a preference.
    const prefs = await db.execute(sql`SELECT count(*)::int AS n FROM memory_preferences WHERE athlete_id = ${A}::uuid`).catch(() => ({ rows: [{ n: 0 }] }) as any);
    expect(Number((prefs as any).rows[0].n)).toBe(0);
  });

  test("a tool not declared for this call is refused (deals_close, a chat-only tool)", async () => {
    const r = await tool(grantFor(A), "turn-x", "deals_close", { deal_id: "x", reason: "expired" });
    expect(r.body.isError).toBe(true);
    expect(r.body.text).toContain("not available in this call");
  });

  test("the per-turn call cap (the voice job's max_steps)", async () => {
    const g = grantFor(A);
    for (let i = 0; i < 8; i++) expect((await tool(g, "turn-cap", "read_scouting")).body.isError).toBe(false);
    const ninth = await tool(g, "turn-cap", "read_scouting");
    expect(ninth.body.isError).toBe(true);
    expect(ninth.body.text).toContain("tool call limit for this turn");
  });

  test("parallel calls in one turn cannot all pass the cap: slots are reserved atomically", async () => {
    const g = grantFor(A);
    const all = await Promise.all(Array.from({ length: 12 }, () => tool(g, "turn-par", "read_scouting")));
    expect(all.filter((r) => !r.body.isError)).toHaveLength(8);
    expect(all.filter((r) => r.body.isError && r.body.text.includes("tool call limit for this turn"))).toHaveLength(4);
  });

  test("fresh turnIds cannot bypass the call's ceiling: tool calls per minute across the call", async () => {
    const callKey = callKeyOf(grantFor(A));
    const runs = await Promise.all([1, 2, 3].map((i) => voiceTurnRun({ athleteId: A, conversationId: CONV_A, callKey, turnId: `m${i}`, skillVersion: "voice:1" })));
    const now = Date.now();
    const go = (runId: string) => reserveSlot({ athleteId: A, callKey, runId, search: false, callsPerTurn: 8, searchesPerTurn: 2, callsPerMinute: 5, nowMs: now });
    const results = [];
    for (const runId of [...runs, ...runs]) results.push(await go(runId!));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.at(-1)).toEqual({ ok: false, why: "calls_per_minute" });
    // A minute later the window has moved on.
    expect(await reserveSlot({ athleteId: A, callKey, runId: runs[0]!, search: false, callsPerTurn: 8, searchesPerTurn: 2, callsPerMinute: 5, nowMs: now + 61_000 })).toMatchObject({ ok: true });
  });

  test("web searches per turn are reserved atomically too", async () => {
    const callKey = callKeyOf(grantFor(A));
    const runId = (await voiceTurnRun({ athleteId: A, conversationId: CONV_A, callKey, turnId: "s1", skillVersion: "voice:1" }))!;
    const all = await Promise.all(Array.from({ length: 5 }, () => reserveSlot({ athleteId: A, callKey, runId, search: true, callsPerTurn: 8, searchesPerTurn: 2 })));
    expect(all.filter((r) => r.ok)).toHaveLength(2);
    expect(all.filter((r) => !r.ok && r.why === "searches_per_turn")).toHaveLength(3);
  });

  test("at the athlete's day cap nothing runs (voice tool spend counts in it)", async () => {
    await db.insert(agentRuns).values({
      athlete_id: BROKE, skill_id: "chat", skill_version: "x", trigger: "chat", provider: "mastra", model: "m", effort: "low",
      status: "completed", cost_micro_usd: AGENT.DAY_COST_CAP_MICRO_USD, ended_at: new Date(),
    });
    const before = await counts(BROKE);
    const r = await tool(grantFor(BROKE), "turn-1", "remember_preference", { kind: "style", statement: "Short" });
    expect(r.body).toMatchObject({ isError: true, cards: [] });
    expect(r.body.text).toContain(STOP_MESSAGES.cost_cap_day);
    expect(await counts(BROKE)).toEqual(before);
  });

  test("a non-object args is an error the model reads, not an HTTP failure", async () => {
    const r = await post("/tool", auth(grantFor(A)), { turnId: "t-bad", name: "recall_facts", args: "nope" });
    expect(r.status).toBe(200);
    expect(r.body.isError).toBe(true);
    expect((await post("/tool", auth(grantFor(A)), { turnId: "has space", name: "recall_facts" })).status).toBe(400);
  });

  test("the skill tool serves a playbook the voice surface is offered, nothing else", async () => {
    const ok = await tool(grantFor(A), "turn-skill", "skill", { name: "deals" });
    expect(ok.body.isError).toBe(false);
    expect(ok.body.text.length).toBeGreaterThan(200);
    const no = await tool(grantFor(A), "turn-skill", "skill", { name: "waitlist" });
    expect(no.body.isError).toBe(true);
  });
});

// ─── C confirm_by_voice ──────────────────────────────────────────────────────────────────────────────────────────

describe("C confirm_by_voice: ordinary replies only, opted in, her answer on record in a later turn", () => {
  let dealId = "", threadId = "", g = "";
  const BODY = "Thanks for reaching out! Could you share more about the timing and what you have in mind?";

  beforeAll(async () => {
    process.env.VOICE_SERVICE_SECRET = SECRET;
    process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
    process.env.MILA_VOICE_ONE = "true";
    process.env.NOMILA_MCP_PASS_KEY = PASS_KEY;
    g = grantFor(A);
    const inbox = await seedConnection({ athleteId: A, email: "ada@example.test" });
    // The welcome flow is on (a spoken send needs it: it is where she can turn voice sending off), with Draft replies
    // turned on for her mailbox (with MILA_WELCOME on, deals_draft_reply and so read_back / confirm_by_voice need it).
    process.env.MILA_WELCOME = "true";
    expect(await setChoice({ athleteId: A, capability: "draft_replies", accountRef: inbox, to: "enabled", via: "card" })).toMatchObject({ ok: true });
    const [deal] = await db.insert(deals).values({ athlete_id: A, brand_name: "Example Brand", status: "detected" } as any).returning();
    const [thread] = await db.insert(inboxThreads).values({ athlete_id: A, subject: "Partnership", deal_id: deal.id, connected_account_id: inbox } as any).returning();
    await db.insert(inboxMessages).values({
      thread_id: thread.id, athlete_id: A, direction: "inbound", sender_email: "partners@brand.example", subject: "Partnership",
      body: "Want to work together?", platform: "gmail", connected_account_id: inbox, gmail_thread_id: "gt-1",
      gmail_message_id_header: "<orig-1@brand.example>", received_at: new Date(Date.UTC(2026, 0, 1)),
    } as any);
    dealId = deal.id; threadId = thread.id;
    await post("/session", auth(g));
  });
  // One call per test (a fresh grant), so the call's per-minute ceiling never spills from one test into the next.
  beforeEach(() => { g = grantFor(A); mockSend.mockClear(); process.env.MILA_WELCOME = "true"; });

  /** The athlete's own switch for voice sending (Me / Settings). setChoice records only while MILA_WELCOME is on. */
  async function voiceSending(to: "revoked" | "enabled") {
    process.env.MILA_WELCOME = "true";
    expect(await setChoice({ athleteId: A, capability: "voice_send", to, via: "settings" })).toMatchObject({ ok: true });
  }

  async function draft(intent: string, body = BODY, opts: { grant?: string } = {}) {
    const [row] = await db.insert(pendingActions).values({
      athlete_id: A, deal_id: dealId, thread_id: threadId, kind: "send_reply", status: "pending",
      payload: { body, reply_intent: intent, source: "mila_chat", drafted_by: "mila", subject: "Re: Partnership" },
    }).returning();
    // What the proxy records when deals_draft_reply's card comes back in this call.
    await recordDrafted((await findSession(A, CONV_A))!, row.id, callKeyOf(opts.grant ?? g), "partners@brand.example");
    return row.id;
  }
  /** Her spoken turn, written as the worker writes it: the grant-bound transcript route, with the turn's id. */
  const said = async (content: string, turnId: string, grant = g) => {
    const r = await post(`/athletes/${A}/transcript`, auth(grant), { conversationId: CONV_A, role: "user", content, turnId });
    expect(r.status).toBe(200);
  };
  const rowOf = async (id: string) => (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0];
  const reason = (r: { body: any }) => JSON.parse(r.body.text).reason as string;
  const verdictOf = (r: { body: any }) => JSON.parse(r.body.text.split("\n")[0]);

  test("the whole path: read back in one turn, her yes in the next, sent once through the one send path", async () => {
    const id = await draft("ask_question");
    expect(reason(await tool(g, "t1", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_read_back);

    const rb = await tool(g, "t1", "read_back", { pending_id: id });
    expect(rb.body.isError).toBe(false);
    // Our verdict and note first, outside the fence; the reply's content inside it, with the address the send uses.
    expect(verdictOf(rb)).toMatchObject({ status: "ok", send_by_voice: true });
    const [, fenced] = rb.body.text.split("\n");
    expect(fenced).toMatch(/^<external_content/);
    expect(rb.body.text).toContain(BODY);
    expect(rb.body.text).toContain("partners@brand.example");

    // Confirming in the read-back's own turn never counts.
    expect(reason(await tool(g, "t1", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.same_turn);
    // A later turn with no transcript of hers yet: not heard.
    expect(reason(await tool(g, "t2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_heard);
    expect(mockSend).not.toHaveBeenCalled();

    await said("Yes, send it.", "t2");
    const ok = await tool(g, "t2", "confirm_by_voice", { pending_id: id });
    expect(ok.body.isError).toBe(false);
    expect(JSON.parse(ok.body.text)).toMatchObject({ status: "ok", sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(A, threadId, BODY);
    const sent = await rowOf(id);
    expect(sent).toMatchObject({ status: "approved", result: { sent: true, mode: "voice", voice: { call: callKeyOf(g), turnId: "t2", readBackTurnId: "t1", transcriptMessageId: expect.any(String) } } });
    const [heard] = await db.select().from(chatMessages).where(eq(chatMessages.id, (sent.result as any).voice.transcriptMessageId));
    expect(heard).toMatchObject({ athlete_id: A, role: "user", source: "voice", content: "Yes, send it." });

    expect(reason(await tool(g, "t3", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_pending);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("a late transcript of the read-back's own turn (her original request) can never stand in for the yes", async () => {
    const id = await draft("ask_details");
    await tool(g, "late1", "read_back", { pending_id: id });
    await said("Reply to them and ask about the timing", "late1");   // lands after the read-back, but is the read-back's turn
    expect(reason(await tool(g, "late1", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.same_turn);
    expect(reason(await tool(g, "late2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_heard);
    // Her answer in another turn than the confirm's does not count either.
    await said("yes", "late3");
    expect(reason(await tool(g, "late2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_heard);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("her answer in another call (another grant) does not count", async () => {
    const id = await draft("ask_question");
    await tool(g, "x1", "read_back", { pending_id: id });
    const other = grantFor(A);
    await said("send it", "x2", other);
    expect(reason(await tool(g, "x2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_heard);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("MILA_WELCOME off: nothing is sent by voice (she would have no switch to turn it off)", async () => {
    const id = await draft("ask_question");
    await tool(g, "w1", "read_back", { pending_id: id });
    await said("Yes, send it.", "w2");
    process.env.MILA_WELCOME = "false";
    const rb = await tool(g, "w2", "read_back", { pending_id: id });
    expect(verdictOf(rb).send_by_voice).toBe(false);
    expect(reason(await tool(g, "w2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.welcome_off);
    expect(mockSend).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe("pending");
  });

  test("a real deals_draft_reply through the proxy records 'drafted in this call', and the spoken send then goes", async () => {
    // A deal the deals source can read (opportunity + deal + lead thread with an inbound message), and the reply skill's
    // model call mocked.
    const at = new Date("2026-11-01T12:00:00Z");
    const [b] = await db.insert(inboxBrands).values({ name: "Example Outfitters", normalized_name: `example-outfitters-${A.slice(0, 4)}` } as any).returning({ id: inboxBrands.id });
    const [op] = await db.insert(opportunities).values({ athlete_id: A, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
    const [d] = await db.insert(deals).values({ athlete_id: A, brand_name: "Example Outfitters", status: "detected", opportunity_id: op.id, amount_cash: "1400" } as any).returning({ id: deals.id });
    const [t] = await db.insert(inboxThreads).values({
      athlete_id: A, deal_id: d.id, brand_id: b.id, subject: "Collab", status: "deal_detected", message_count: 1,
      classification: { qualification: "workable", channel: "direct", qualification_reason: "", category: "PAID", comp_kind: "cash", work_kind: "social_post" },
      conversation_state: { key_details: { ask: "2 Reels", awaiting_response_from: "athlete", offer_struct: { amount: 1400, unit: "total" } } },
    } as any).returning({ id: inboxThreads.id });
    await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
    await db.insert(inboxMessages).values({ athlete_id: A, thread_id: t.id, direction: "inbound", platform: "gmail", sender_email: "sam@outfitters.example", received_at: at } as any);
    const reply = "Hi Sam,\n\nThanks for thinking of me. Could you share more about the timing and what you have in mind?\n\nBest";
    mockDraftDealReply.mockResolvedValueOnce({ ok: true, fullText: reply, threadId: t.id, intent: "ask_question", dealType: "paid_content", channel: "email", voice: "athlete" });

    const r = await tool(g, "rd1", "deals_draft_reply", { deal_id: op.id, intent: "ask_question" });
    expect(r.body.isError).toBe(false);
    expect(mockDraftDealReply).toHaveBeenCalledTimes(1);
    const ref = r.body.cards.find((c: any) => c.kind === "deal-reply");
    expect(ref).toMatchObject({ messageId: r.body.messageId, pendingActionId: expect.any(String) });
    const state = (await db.select({ s: milaTfSessions.tool_state }).from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV_A))))[0].s as any;
    expect(state.voiceConfirm.drafted[ref.pendingActionId]).toMatchObject({ call: callKeyOf(g), to: "sam@outfitters.example" });

    const rb = await tool(g, "rd1", "read_back", { pending_id: ref.pendingActionId });
    expect(verdictOf(rb).send_by_voice).toBe(true);
    expect(rb.body.text).toContain("sam@outfitters.example");
    await said("Yes, send it.", "rd2");
    const ok = await tool(g, "rd2", "confirm_by_voice", { pending_id: ref.pendingActionId });
    expect(JSON.parse(ok.body.text)).toMatchObject({ status: "ok", sent: true });
    expect(mockSend).toHaveBeenCalledWith(A, t.id, reply);
    expect((await rowOf(ref.pendingActionId)).result).toMatchObject({ sent: true, mode: "voice" });
  });

  test("on by default: with no choice of hers, voice sending is allowed", async () => {
    expect(await isAllowed(A, "voice_send")).toEqual({ allowed: true, reason: "default_on" });
  });

  test("turned off by the athlete: refused with 'tap Send on the card', and read_back says it can't go by voice", async () => {
    await voiceSending("revoked");
    expect((await isAllowed(A, "voice_send")).allowed).toBe(false);
    const id = await draft("ask_question");
    const rb = await tool(g, "o1", "read_back", { pending_id: id });
    expect(verdictOf(rb).send_by_voice).toBe(false);
    expect(verdictOf(rb).note).toContain(NEEDS_TAP_REASON.not_opted_in);
    await said("send it", "o2");
    const r = await tool(g, "o2", "confirm_by_voice", { pending_id: id });
    expect(reason(r)).toBe(NEEDS_TAP_REASON.not_opted_in);
    expect(reason(r)).toContain("tap Send on the card");
    expect(mockSend).not.toHaveBeenCalled();
    // Turned back on: allowed again (an explicit yes now).
    await voiceSending("enabled");
    expect(await isAllowed(A, "voice_send")).toEqual({ allowed: true, reason: "enabled" });
  });

  test.each([["decline"], ["ask_term_sheet"], ["ask_licensing_terms"], ["acknowledge"]] as const)("%s: voice-sendable (owner, 10 Nov) with the same read-back + next-turn proof", async (intent) => {
    const id = await draft(intent);
    const rb = await tool(g, `v-${intent}`, "read_back", { pending_id: id });
    expect(verdictOf(rb).send_by_voice).toBe(true);
    await said("Yes, send it.", `v2-${intent}`);
    const ok = await tool(g, `v2-${intent}`, "confirm_by_voice", { pending_id: id });
    expect(JSON.parse(ok.body.text)).toMatchObject({ status: "ok", sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["counter", "money"], ["share_rate", "money"], ["accept_terms", "money"], ["accept_gift", "agreement"],
    ["accept_to_try", "agreement"], ["accept_and_propose_times", "agreement"], ["accept_and_confirm_logistics", "agreement"], ["propose_paid", "money"],
  ] as const)("%s: read back and said yes, still refused (%s); nothing sent", async (intent, why) => {
    const id = await draft(intent);
    const rb = await tool(g, `m-${intent}`, "read_back", { pending_id: id });
    expect(verdictOf(rb).send_by_voice).toBe(false);
    await said("Send it", `m2-${intent}`);
    const r = await tool(g, `m2-${intent}`, "confirm_by_voice", { pending_id: id });
    expect(reason(r)).toBe(NEEDS_TAP_REASON[why]);
    expect(JSON.parse(r.body.text).needs_tap).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe("pending");
  });

  test("a number in an ordinary reply's body: refused (fails closed)", async () => {
    const id = await draft("ask_question", "Could we talk on the 14th?");
    await tool(g, "amt", "read_back", { pending_id: id });
    await said("send it", "amt2");
    expect(reason(await tool(g, "amt2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.money);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("drafted in another call: refused", async () => {
    const id = await draft("ask_question", BODY, { grant: grantFor(A) });
    await tool(g, "d1", "read_back", { pending_id: id });
    await said("send it", "d2");
    expect(reason(await tool(g, "d2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.not_drafted_here);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("the body changed after the read-back: refused until read back again", async () => {
    const id = await draft("ask_details");
    await tool(g, "e1", "read_back", { pending_id: id });
    await db.update(pendingActions).set({ payload: { body: "Edited in the app.", reply_intent: "ask_details", source: "mila_chat", drafted_by: "mila" } }).where(eq(pendingActions.id, id));
    await said("send it", "e2");
    expect(reason(await tool(g, "e2", "confirm_by_voice", { pending_id: id }))).toBe(NEEDS_TAP_REASON.changed);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("a queued action (an approval card) is tap-only", async () => {
    const r = await tool(g, "q1", "remember_preference", { kind: "voice", statement: "Warm and direct" });
    const approvalId = JSON.parse(r.body.text.split("\n")[0]).approval_id;
    const rb = await tool(g, "q1", "read_back", { pending_id: approvalId });
    expect(verdictOf(rb).send_by_voice).toBe(false);
    await said("yes do it", "q2");
    expect(reason(await tool(g, "q2", "confirm_by_voice", { pending_id: approvalId }))).toBe(NEEDS_TAP_REASON.tap_only_action);
    expect((await rowOf(approvalId)).status).toBe("pending");
  });

  test("another athlete's pending reply is not found", async () => {
    const [row] = await db.insert(pendingActions).values({ athlete_id: B, kind: "send_reply", status: "pending", payload: { body: BODY, reply_intent: "ask_question", drafted_by: "mila" } }).returning();
    expect(reason(await tool(g, "n1", "confirm_by_voice", { pending_id: row.id }))).toBe(NEEDS_TAP_REASON.not_found);
    expect(reason(await tool(g, "n2", "read_back", { pending_id: row.id }))).toBe(NEEDS_TAP_REASON.not_found);
  });

  test("the voice state lives on the chat's session row, beside the tools' state", async () => {
    const [row] = await db.select({ state: milaTfSessions.tool_state }).from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV_A)));
    expect(Object.keys((row.state as any).voiceConfirm).sort()).toEqual(["drafted", "heard", "readBacks"]);
    expect(row.state).toHaveProperty("factKeys");
  });
});

describe("R the transcript route is bound to the grant", () => {
  const send = (athleteId: string, headers: Record<string, string>, body: Record<string, unknown>) => post(`/athletes/${athleteId}/transcript`, headers, body);
  const turn = { conversationId: CONV_A, role: "user", content: "hello", turnId: "r1" };

  test("an athlete turn needs a valid grant (401), even in observe mode", async () => {
    expect((await send(A, { "x-voice-secret": SECRET }, turn)).status).toBe(401);
    expect((await send(A, { "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: "v1.bad.sig" }, turn)).status).toBe(401);
  });
  test("a grant for another conversation or another athlete is 403", async () => {
    expect((await send(A, auth(grantFor(A, randomUUID())), turn)).status).toBe(403);
    expect((await send(A, auth(grantFor(B)), turn)).status).toBe(403);
    expect((await send(A, auth(grantFor(B)), { ...turn, role: "assistant" })).status).toBe(403);
  });
  test("the matching grant writes the turn and records it for the call", async () => {
    const g = grantFor(A);
    const r = await send(A, auth(g), { ...turn, turnId: "r9" });
    expect(r.body).toEqual({ stored: true });
    const [row] = await db.select({ state: milaTfSessions.tool_state }).from(milaTfSessions).where(and(eq(milaTfSessions.athlete_id, A), eq(milaTfSessions.conversation_id, CONV_A)));
    expect(Object.values((row.state as any).voiceConfirm.heard)).toContainEqual(expect.objectContaining({ call: callKeyOf(g), turnId: "r9" }));
  });
});
