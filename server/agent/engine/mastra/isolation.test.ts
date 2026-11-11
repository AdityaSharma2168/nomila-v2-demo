/**
 * isolation.test.ts — the Mastra engine's tenant guards against the attacks the security review named, on the REAL
 * Mastra Agent + Memory (in-memory store, a scripted model: no provider, no network, no database). Two made-up
 * athletes A and B; ownership lookups are injected (our tables are the source of truth, tested on PGlite in
 * mastraTurn.db.test.ts).
 *
 *   thread-id reuse   A naming B's thread is refused by OUR table before Mastra memory is asked; a thread whose Mastra
 *                     owner was rewritten (mastra#26216) is refused even when our table says it is A's
 *   foreign run id    a run that is not A's in agent_runs is refused (mastra#25716: Mastra resolves runs by id alone)
 *   foreign message   a Mastra message id of B's is refused (storage listMessagesById is a global lookup); a message
 *                     OBJECT (with its own id) is never accepted as turn input, only text
 *   forged context    a forged / expired / other-athlete / other-thread pass never becomes a requestContext; a tool
 *                     called without a valid pass in its requestContext throws before anything runs; the reserved
 *                     resource key is pinned, so A's turn writes only A's thread and B's thread is unchanged
 */
jest.mock("../../../db", () => ({ db: {} }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { z } from "zod";
import { issueAthletePass, PassError } from "../tools/pass";
import { ToolRegistry, type AgentTool } from "../../tools";
import { scriptedModel, testRuntime } from "../../../testUtils/mastraScripted";
import { assertMessagesOwned, assertRunOwned, assertThreadOwned, contextFromPass, turnInput, TenantGuardError } from "./guards";
import { mastraTool, ToolRefusedError } from "./tools";
import { PASS_CONTEXT_KEY } from "../config";

const KEY = "mastra-test-pass-key-0123456789-0123456789";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const THREAD_A = "a1a1a1a1-0000-4000-8000-0000000000a1";
const THREAD_B = "b1b1b1b1-0000-4000-8000-0000000000b1";
const RUN_A = "a2a2a2a2-0000-4000-8000-0000000000a2";
const RUN_B = "b2b2b2b2-0000-4000-8000-0000000000b2";

/** Our tables, as the guards see them: A owns THREAD_A and RUN_A, B owns THREAD_B and RUN_B. */
const ours = {
  ownsThread: async (athlete: string, thread: string) => (athlete === A && thread === THREAD_A) || (athlete === B && thread === THREAD_B),
  ownsRun: async (athlete: string, run: string) => (athlete === A && run === RUN_A) || (athlete === B && run === RUN_B),
};
const pass = (athleteId: string, sessionId: string, runId: string) => issueAthletePass({ athleteId, sessionId, runId, skillId: "chat", scopes: ["read"] }, KEY);

async function seededRuntime() {
  const m = scriptedModel([{ text: "hello" }]);
  const rt = await testRuntime(m.model);
  // B has a conversation in Mastra already.
  const ctxB = await contextFromPass(pass(B, THREAD_B, RUN_B), { athleteId: B, threadId: THREAD_B }, KEY);
  const out: any = await rt.agent.stream("B's private words: canary-b-7731", { memory: { thread: THREAD_B, resource: B }, runId: RUN_B, requestContext: ctxB.requestContext } as never);
  for await (const _ of out.fullStream) { /* drain */ }
  return { rt, m };
}
const messagesOf = async (rt: any, threadId: string) => (await rt.memory.recall({ threadId, resourceId: undefined })).messages as Array<{ id: string; threadId?: string; resourceId?: string; role: string }>;

describe("thread-id reuse", () => {
  it("refuses B's thread for A from OUR table, before Mastra memory is asked", async () => {
    const memory = { getThreadById: jest.fn(async () => ({ resourceId: B })) };
    await expect(assertThreadOwned(memory, A, THREAD_B, ours)).rejects.toMatchObject({ code: "thread_not_owned" });
    expect(memory.getThreadById).not.toHaveBeenCalled();
  });

  it("refuses a thread whose Mastra owner is another athlete even when our table says it is A's (rewritten owner)", async () => {
    const { rt } = await seededRuntime();
    const rewritten = { ownsThread: async () => true };
    await expect(assertThreadOwned(rt.memory as never, A, THREAD_B, rewritten)).rejects.toMatchObject({ code: "thread_resource_mismatch" });
  });

  it("allows A's own thread, new to Mastra or already there; says which", async () => {
    const { rt } = await seededRuntime();
    await expect(assertThreadOwned(rt.memory as never, A, THREAD_A, ours)).resolves.toEqual({ exists: false });
    await expect(assertThreadOwned(rt.memory as never, B, THREAD_B, ours)).resolves.toEqual({ exists: true });
  });
});

describe("foreign run id", () => {
  it("refuses a run that is not the athlete's in agent_runs", async () => {
    await expect(assertRunOwned(A, RUN_B, ours)).rejects.toMatchObject({ code: "run_not_owned" });
    await expect(assertRunOwned(A, RUN_A, ours)).resolves.toBeUndefined();
  });
});

describe("foreign message id", () => {
  it("refuses B's Mastra message ids for A; returns A's own", async () => {
    const { rt } = await seededRuntime();
    const bIds = (await messagesOf(rt, THREAD_B)).map((m) => m.id);
    expect(bIds.length).toBeGreaterThan(0);
    await expect(assertMessagesOwned(rt.storage as never, A, bIds, ours)).rejects.toMatchObject({ code: "message_not_owned" });
    await expect(assertMessagesOwned(rt.storage as never, A, ["no-such-id"], ours)).rejects.toMatchObject({ code: "message_not_owned" });
    await expect(assertMessagesOwned(rt.storage as never, B, bIds, ours)).resolves.toHaveLength(bIds.length);
  });

  it("takes text only as turn input: a message object carrying its own id is refused", () => {
    expect(turnInput("hi")).toBe("hi");
    expect(() => turnInput({ id: "b-message-id", role: "user", content: "x" })).toThrow(TenantGuardError);
    expect(() => turnInput([{ id: "b-message-id", role: "user", content: "x" }])).toThrow(TenantGuardError);
  });
});

describe("forged context", () => {
  it("never builds a requestContext from a forged, expired, other-athlete or other-thread pass", async () => {
    const good = pass(A, THREAD_A, RUN_A);
    const forged = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(contextFromPass(forged, { athleteId: A, threadId: THREAD_A }, KEY)).rejects.toBeInstanceOf(PassError);
    await expect(contextFromPass(good, { athleteId: A, threadId: THREAD_A }, "another-key-0123456789-0123456789-0123")).rejects.toBeInstanceOf(PassError);
    await expect(contextFromPass(pass(B, THREAD_A, RUN_A), { athleteId: A, threadId: THREAD_A }, KEY)).rejects.toMatchObject({ code: "pass_mismatch" });
    await expect(contextFromPass(pass(A, THREAD_B, RUN_A), { athleteId: A, threadId: THREAD_A }, KEY)).rejects.toMatchObject({ code: "pass_mismatch" });
    const { requestContext } = await contextFromPass(good, { athleteId: A, threadId: THREAD_A }, KEY);
    const { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } = await import("@mastra/core/request-context");
    expect([requestContext.get(PASS_CONTEXT_KEY), requestContext.get(MASTRA_RESOURCE_ID_KEY), requestContext.get(MASTRA_THREAD_ID_KEY)]).toEqual([good, A, THREAD_A]);
  });

  it("a tool refuses a call whose requestContext has no valid pass, before it runs", async () => {
    const run = jest.fn(async () => ({ ok: true }));
    const t: AgentTool = { name: "probe", description: "probe", kind: "ours", permission: "read", args: z.object({}), execute: run } as never;
    const registry = new ToolRegistry(); registry.register(t);
    const tool: any = await mastraTool(t, registry, { passKey: KEY, isDeleting: async () => false });
    const { RequestContext } = await import("@mastra/core/request-context");
    const none = new RequestContext();
    const forged = new RequestContext(); forged.set(PASS_CONTEXT_KEY, "not-a-pass");
    for (const rc of [undefined, none, forged]) await expect(tool.execute({}, { requestContext: rc })).rejects.toBeInstanceOf(ToolRefusedError);
    const fenced: any = await mastraTool(t, registry, { passKey: KEY, isDeleting: async () => true });
    const ok = new RequestContext(); ok.set(PASS_CONTEXT_KEY, pass(A, THREAD_A, RUN_A));
    await expect(fenced.execute({}, { requestContext: ok })).rejects.toMatchObject({ code: "athlete_deleting" });
    const failing: any = await mastraTool(t, registry, { passKey: KEY, isDeleting: async () => { throw new Error("db down"); } });
    await expect(failing.execute({}, { requestContext: ok })).rejects.toMatchObject({ code: "athlete_deleting" });   // fails closed
    expect(run).not.toHaveBeenCalled();
  });

  it("A's turn, with the pinned context, writes only A's thread; B's thread is unchanged", async () => {
    const { rt } = await seededRuntime();
    const before = await messagesOf(rt, THREAD_B);
    const { requestContext } = await contextFromPass(pass(A, THREAD_A, RUN_A), { athleteId: A, threadId: THREAD_A }, KEY);
    const out: any = await rt.agent.stream(turnInput("A's words"), { memory: { thread: THREAD_A, resource: A }, runId: RUN_A, requestContext } as never);
    for await (const _ of out.fullStream) { /* drain */ }
    const a = await messagesOf(rt, THREAD_A);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((m) => m.resourceId === A)).toBe(true);
    expect(JSON.stringify(a)).not.toContain("canary-b-7731");
    expect(await messagesOf(rt, THREAD_B)).toEqual(before);
    expect((await rt.memory.getThreadById({ threadId: THREAD_B }))?.resourceId).toBe(B);
  });

  it("Mastra itself refuses A streaming into B's thread (core resource check), even without our guard", async () => {
    const { rt } = await seededRuntime();
    const before = await messagesOf(rt, THREAD_B);
    let refused = false;
    try {
      const out: any = await rt.agent.stream("A's words", { memory: { thread: THREAD_B, resource: A }, runId: RUN_A } as never);
      for await (const c of out.fullStream) if (c.type === "error") refused = true;
    } catch { refused = true; }
    expect(refused).toBe(true);
    expect(await messagesOf(rt, THREAD_B)).toEqual(before);
  });
});
