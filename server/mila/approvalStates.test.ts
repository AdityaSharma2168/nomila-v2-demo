/**
 * approvalStates.test — a reopened chat's approval cards say where they stand NOW (PGlite; no provider is reached):
 *   • approve (the real tap, executeAgentAction) → reload (getConversationMessages) says sent, with the time
 *   • declined → reload says declined; expired and failed say so; a waiting one says needs_approval
 *   • a card naming ANOTHER athlete's pendingActionId gets nothing: her row is never read, the card stays as saved
 *   • a deal reply she edited first counts as sent when its replacement went out; the polite no inside deal-closed too
 *   • one query for the whole conversation; the stored cards are not changed
 *   • the old chat's card (ChatCard) and chat v2's card (the DTO) both carry it
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./gemini", () => ({ summarizeConversation: jest.fn() }));

import { z } from "zod";
import { eq } from "drizzle-orm";
import { chatMessages, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { getConversationMessages } from "./conversations";
import { approvalIdsOf, approvalStateOf, MAX_APPROVAL_LOOKUP, withApprovalStates, type PendingStateRow } from "./approvalStates";
import { executeAgentAction, queueApproval } from "../agent/approvals";
import { ToolRegistry, type AgentTool } from "../agent/tools";
import { toMilaCardDto } from "../../shared/milaCards";

let me: string;
let other: string;

const sendOut: AgentTool = {
  name: "send_out", description: "d", kind: "ours", permission: "act", args: z.object({ body: z.string() }),
  approval: { verb: "send_message", title: () => "Send the reply", summary: (a: any) => `Sends: ${a.body}` },
  execute: async () => ({ sent: true }),
} as unknown as AgentTool;
const registry = new ToolRegistry().register(sendOut);

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Card Owner");
  other = await seedAthlete("Someone Else");
});
afterAll(async () => { await closeTestDb(); });

const actionCard = (approvalId: string) => ({
  id: `action:${approvalId}`, kind: "action", title: "Send the reply", links: [], runId: null,
  payload: { approvalId, verb: "send_message", body: "Thanks, we accept.", money: null, buttons: ["approve", "edit", "decline"] },
});

async function queue(athleteId: string): Promise<string> {
  const item = await queueApproval({ athleteId, runId: "", skillId: "test/tools" } as any, sendOut, { body: "Thanks, we accept." });
  return item.id;
}

async function chatWith(athleteId: string, cards: unknown[]): Promise<string> {
  const cid = crypto.randomUUID();
  await db.insert(chatMessages).values({ athlete_id: athleteId, conversation_id: cid, role: "user", content: "reply yes", created_at: new Date(Date.now() - 1000) } as any);
  await db.insert(chatMessages).values({ athlete_id: athleteId, conversation_id: cid, role: "assistant", content: "Ready for you.", agent_cards: cards } as any);
  return cid;
}

const approvalOf = async (athleteId: string, cid: string, i = 0) => {
  const msgs = await getConversationMessages(athleteId, cid);
  return (msgs[1].agentCards![i] as { payload: { approval?: { state: string; at: string | null } } }).payload.approval;
};

it("approve → reload shows Sent, with the time it went", async () => {
  const id = await queue(me);
  const cid = await chatWith(me, [actionCard(id)]);
  expect(await approvalOf(me, cid)).toEqual({ state: "needs_approval", at: null });

  await executeAgentAction(me, id, registry);
  const a = await approvalOf(me, cid);
  expect(a?.state).toBe("sent");
  const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id));
  expect(a?.at).toBe(row.executed_at!.toISOString());

  // chat v2 reads the same rows: its DTO carries the state (and the old chat's ChatCard above carries `approval`).
  const msgs = await getConversationMessages(me, cid);
  const dto = toMilaCardDto(msgs[1].agentCards![0]);
  expect(dto.ok && dto.dto.type === "action" && dto.dto.data.fields).toMatchObject({ pendingActionId: id, state: "sent", stateAt: row.executed_at!.toISOString() });

  // The stored card is untouched: only the response is decorated.
  const saved = await db.select({ cards: chatMessages.agent_cards }).from(chatMessages).where(eq(chatMessages.conversation_id, cid));
  expect(JSON.stringify(saved.map((s) => s.cards))).not.toContain("\"approval\"");
});

it("declined → reload shows Declined", async () => {
  const id = await queue(me);
  const cid = await chatWith(me, [actionCard(id)]);
  const when = new Date("2026-11-01T10:00:00Z");
  await db.update(pendingActions).set({ status: "dismissed", dismissed_at: when }).where(eq(pendingActions.id, id));
  expect(await approvalOf(me, cid)).toEqual({ state: "declined", at: when.toISOString() });
});

it("failed and expired say so", async () => {
  const failed = await queue(me);
  const expired = await queue(me);
  await db.update(pendingActions).set({ status: "failed", error: "boom", executed_at: new Date() }).where(eq(pendingActions.id, failed));
  await db.update(pendingActions).set({ expires_at: new Date(Date.now() - 60_000) }).where(eq(pendingActions.id, expired));
  const cid = await chatWith(me, [actionCard(failed), actionCard(expired)]);
  expect((await approvalOf(me, cid, 0))?.state).toBe("failed");
  expect((await approvalOf(me, cid, 1))?.state).toBe("expired");
});

it("another athlete's pendingActionId can't be read: the card stays exactly as it was saved", async () => {
  const theirs = await queue(other);
  await executeAgentAction(other, theirs, registry); // theirs is sent — that must not show up in my chat
  const cid = await chatWith(me, [actionCard(theirs)]);
  const msgs = await getConversationMessages(me, cid);
  expect(msgs[1].agentCards).toEqual([actionCard(theirs)]);
  // And the lookup itself is scoped: her rows never come back for my athlete id.
  const decorated = await withApprovalStates(me, [{ agentCards: [actionCard(theirs)] }]);
  expect((decorated[0].agentCards![0] as any).payload.approval).toBeUndefined();
  // A state already written on a stored card is never passed on: only her own rows say where a card stands.
  const forged = { ...actionCard(theirs), payload: { ...actionCard(theirs).payload, approval: { state: "sent", at: null } } };
  const forgedCid = await chatWith(me, [forged]);
  expect((await getConversationMessages(me, forgedCid))[1].agentCards).toEqual([actionCard(theirs)]);
  // Not even on a card whose id is not a uuid (no lookup at all), nor when the chat has no usable id anywhere.
  const junk = { ...actionCard("not-a-uuid"), payload: { ...actionCard("not-a-uuid").payload, approval: { state: "sent", at: null } } };
  const junkCid = await chatWith(me, [junk]);
  expect((await getConversationMessages(me, junkCid))[1].agentCards).toEqual([actionCard("not-a-uuid")]);
  const closedJunk = { id: "c2", kind: "deal-closed", title: "Closed", links: [], payload: { opportunityId: "o", politeNo: { body: "no", approval: { state: "declined", at: null } } } };
  const [out] = await withApprovalStates(me, [{ agentCards: [closedJunk] }]);
  expect((out.agentCards![0] as any).payload.politeNo).toEqual({ body: "no" });
  // While the owner's own reload does see it.
  const theirCid = await chatWith(other, [actionCard(theirs)]);
  expect((await approvalOf(other, theirCid))?.state).toBe("sent");
});

it("one query for the whole conversation, however many cards", async () => {
  const ids = [await queue(me), await queue(me), await queue(me)];
  const cid = await chatWith(me, ids.map(actionCard));
  const spy = jest.spyOn(db, "select");
  try {
    await getConversationMessages(me, cid);
    expect(spy).toHaveBeenCalledTimes(2); // the chat rows, then ONE pending_actions read
  } finally {
    spy.mockRestore();
  }
});

it("a deal reply sent after Edit first counts as sent; the polite no inside deal-closed is decorated too", async () => {
  const [own] = await db.insert(pendingActions).values({ athlete_id: me, kind: "send_reply", payload: { body: "hi" }, status: "dismissed", dismissed_at: new Date() } as any).returning();
  await db.insert(pendingActions).values({ athlete_id: me, kind: "send_reply", payload: { body: "hi!", replaces: own.id }, status: "approved", approved_at: new Date(), executed_at: new Date() } as any);
  const [no] = await db.insert(pendingActions).values({ athlete_id: me, kind: "send_reply", payload: { body: "no thanks" }, status: "pending" } as any).returning();
  const reply = { id: "r1", kind: "deal-reply", title: "Reply", links: [], payload: { pendingActionId: own.id, body: "hi" } };
  const closed = { id: "c1", kind: "deal-closed", title: "Closed", links: [], payload: { opportunityId: "o", politeNo: { pendingActionId: no.id, body: "no thanks" } } };
  const cid = await chatWith(me, [reply, closed]);
  const msgs = await getConversationMessages(me, cid);
  expect((msgs[1].agentCards![0] as any).payload.approval.state).toBe("sent");
  expect((msgs[1].agentCards![1] as any).payload.politeNo.approval).toEqual({ state: "needs_approval", at: null });
});

describe("the pure parts", () => {
  const row = (over: Partial<PendingStateRow>): PendingStateRow => ({ id: "x", status: "pending", replaces: null, expires_at: null, approved_at: null, dismissed_at: null, executed_at: null, ...over });

  it("maps every status, and no row means leave the card alone", () => {
    expect(approvalStateOf(undefined, [])).toBeNull();
    expect(approvalStateOf(row({}), [])).toEqual({ state: "needs_approval", at: null });
    expect(approvalStateOf(row({ status: "approved", approved_at: new Date("2026-11-01T00:00:00Z") }), [])).toEqual({ state: "sent", at: "2026-11-01T00:00:00.000Z" });
    expect(approvalStateOf(row({ status: "dismissed" }), [])?.state).toBe("declined");
    expect(approvalStateOf(row({ status: "dismissed" }), [row({ status: "failed" })])?.state).toBe("failed");
    expect(approvalStateOf(row({ status: "failed" }), [])?.state).toBe("failed");
    expect(approvalStateOf(row({ status: "something_new" }), [])).toBeNull();
  });

  it("collects uuids only, deduplicated and bounded", () => {
    const u = "11111111-1111-4111-8111-111111111111";
    expect(approvalIdsOf([[actionCard(u), actionCard(u.toUpperCase()), actionCard("not-a-uuid"), { kind: "deal" }], null])).toEqual([u]);
    const many = Array.from({ length: MAX_APPROVAL_LOOKUP + 10 }, (_, i) => actionCard(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    expect(approvalIdsOf([many])).toHaveLength(MAX_APPROVAL_LOOKUP);
  });
});
