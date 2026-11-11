/**
 * toolPathHardening.db.test.ts — the three tool-path gaps closed 5 Nov 2026 (owner-approved, all tools), on a real
 * (PGlite) Postgres. No model and no provider: the tools are fakes with real names whose execute records that it ran.
 * Made-up athletes only.
 *
 *   H1 the tap re-checks the opt-in: a card queued while a capability was on does not run after it is turned off or
 *      paused; the row is declined with the reason; MILA_WELCOME off leaves the tap as it was
 *   H2 the tap re-checks the deletion fence: an account being deleted runs nothing (and a failing check refuses)
 *   H3 callTool checks the fence itself, for every caller, failing closed; an engine's fresh clearance is reused
 *      (no second read), a stale or forged one is not
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../services/push/events", () => ({ pushWaiting: jest.fn(async () => undefined) }));

import { eq } from "drizzle-orm";
import { z } from "zod";
import { athletes, pendingActions } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { callTool } from "./callTool";
import { ApprovalError, executeAgentAction, queueApproval } from "./approvals";
import { ToolRegistry, type AgentTool, type ToolContext } from "./tools";
import { offerFor, turnOnFromCard } from "./welcome/turnOn";
import { pauseChoice, revokeChoice } from "./welcome/choices";
import { clearFence, FENCE_REUSE_MS, isFreshClearance, type FenceClearance } from "../lib/privacy/deletionFence";

const RUN = "00000000-0000-4000-8000-000000000001";
const saved = process.env.MILA_WELCOME, savedPlan = process.env.AGENT_PLAN;
let A = "", B = "", GONE = "";

beforeAll(async () => {
  process.env.AGENT_PLAN = "true";   // plan_refresh is available only with the plan feature on
  await initTestDb();
  A = await seedAthlete("Ada Example", { sport: "Rowing" } as any);
  B = await seedAthlete("Bo Example", { sport: "Rowing" } as any);
  GONE = await seedAthlete("Cy Example", { sport: "Rowing" } as any);
  await db.update(athletes).set({ deletion_requested_at: new Date() } as any).where(eq(athletes.id, GONE));
});
afterAll(async () => {
  if (saved === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = saved;
  if (savedPlan === undefined) delete process.env.AGENT_PLAN; else process.env.AGENT_PLAN = savedPlan;
  await closeTestDb();
});

/** refresh_plan is unlocked by the optional plan_refresh capability; as a propose tool it waits for her tap. */
function tapTool(name = "refresh_plan", permission: AgentTool["permission"] = "propose") {
  const ran = jest.fn(async () => ({ status: "ok", done: true }));
  const tool = {
    name, description: name, kind: "ours", permission, args: z.object({ note: z.string() }), execute: ran,
    approval: { verb: "save", title: () => "Refresh your plan", summary: () => "Refresh your plan" },
  } as unknown as AgentTool;
  return { tool, ran, registry: new ToolRegistry().register(tool) };
}
const ctxOf = (athleteId: string): ToolContext => ({ athleteId, runId: RUN, skillId: "chat" });
const queue = (athleteId: string, tool: AgentTool) => queueApproval(ctxOf(athleteId), tool, { note: "weekly" });
const rowOf = async (id: string) => (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0];

async function turnOnPlanRefresh(athleteId: string) {
  const offer = await offerFor(athleteId, "plan_refresh");
  if (!offer.ok) throw new Error(`plan_refresh not offerable: ${JSON.stringify(offer)}`);
  const r = await turnOnFromCard({ athleteId, key: "plan_refresh", consentVersion: offer.words.version, expectedVersion: offer.choice.version });
  expect(r).toMatchObject({ ok: true });
}

describe("H1 the tap re-checks the opt-in", () => {
  beforeEach(() => { process.env.MILA_WELCOME = "true"; });

  it("queued while on, turned off before the tap: declined with the reason, nothing runs", async () => {
    await turnOnPlanRefresh(A);
    const { tool, ran, registry } = tapTool();
    const item = await queue(A, tool);
    expect(await revokeChoice(A, "plan_refresh", null, "me")).toMatchObject({ ok: true });

    const err = await executeAgentAction(A, item.id, registry).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalError);
    expect(err).toMatchObject({ status: 409, code: "capability_off", item: expect.objectContaining({ id: item.id, status: "dismissed" }) });
    expect(err.message).toContain("is turned off now, so this was not done");
    expect(err.message).toContain("Turn it on in Me");
    expect(ran).not.toHaveBeenCalled();
    const row = await rowOf(item.id);
    expect(row).toMatchObject({ status: "dismissed", executed_at: null, approved_at: null });
    expect(row.dismissed_at).not.toBeNull();
    expect(row.error).toMatch(/^capability_off: /);
    // A second tap finds it already handled; still nothing runs.
    await expect(executeAgentAction(A, item.id, registry)).rejects.toMatchObject({ status: 409 });
    expect(ran).not.toHaveBeenCalled();
  });

  it("paused since it was queued: declined, nothing runs", async () => {
    await turnOnPlanRefresh(B);
    const { tool, ran, registry } = tapTool();
    const item = await queue(B, tool);
    expect(await pauseChoice(B, "plan_refresh", null, "me")).toMatchObject({ ok: true });
    await expect(executeAgentAction(B, item.id, registry)).rejects.toMatchObject({ code: "capability_off" });
    expect(ran).not.toHaveBeenCalled();
    expect((await rowOf(item.id)).status).toBe("dismissed");
  });

  it("still on at the tap: it runs, once", async () => {
    const C = await seedAthlete("Di Example", { sport: "Rowing" } as any);
    await turnOnPlanRefresh(C);
    const { tool, ran, registry } = tapTool();
    const item = await queue(C, tool);
    expect((await executeAgentAction(C, item.id, registry)).status).toBe("approved");
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("a core tool (no capability) is never declined by the opt-in check", async () => {
    const { tool, ran, registry } = tapTool("save_note_core");
    const item = await queue(A, tool);
    expect((await executeAgentAction(A, item.id, registry)).status).toBe("approved");
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("a check that fails refuses WITHOUT declining, so she can tap again", async () => {
    const { tool, ran, registry } = tapTool();
    const item = await queue(A, tool);
    await expect(executeAgentAction(A, item.id, registry, { tapRefusal: async () => { throw new Error("db down"); } }))
      .rejects.toMatchObject({ status: 503, code: "check_failed" });
    expect(ran).not.toHaveBeenCalled();
    expect((await rowOf(item.id)).status).toBe("pending");
  });

  it("MILA_WELCOME off: the tap is as before (the gate passes, even with the capability never turned on)", async () => {
    delete process.env.MILA_WELCOME;
    const D = await seedAthlete("Ed Example", { sport: "Rowing" } as any);
    const { tool, ran, registry } = tapTool();
    const item = await queue(D, tool);
    expect((await executeAgentAction(D, item.id, registry)).status).toBe("approved");
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("MILA_WELCOME on, never turned on: the same card is declined", async () => {
    const E = await seedAthlete("Flo Example", { sport: "Rowing" } as any);
    const { tool, ran, registry } = tapTool();
    const item = await queue(E, tool);
    await expect(executeAgentAction(E, item.id, registry)).rejects.toMatchObject({ code: "capability_off" });
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("H2 the tap re-checks the deletion fence", () => {
  beforeEach(() => { delete process.env.MILA_WELCOME; });

  it("an account being deleted: refused, nothing runs, the row is left as it was", async () => {
    const { tool, ran, registry } = tapTool("save_note_core");
    const item = await queue(GONE, tool);
    await expect(executeAgentAction(GONE, item.id, registry)).rejects.toMatchObject({ status: 403, code: "athlete_deleting" });
    expect(ran).not.toHaveBeenCalled();
    expect((await rowOf(item.id)).status).toBe("pending");
  });

  it("a fence check that throws counts as fenced", async () => {
    const { tool, ran, registry } = tapTool("save_note_core");
    const item = await queue(A, tool);
    await expect(executeAgentAction(A, item.id, registry, { isDeleting: async () => { throw new Error("db down"); } }))
      .rejects.toMatchObject({ code: "athlete_deleting" });
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("H3 callTool checks the fence itself", () => {
  beforeEach(() => { delete process.env.MILA_WELCOME; });

  function readTool() {
    const ran = jest.fn(async () => ({ status: "ok", rows: 1 }));
    const tool = { name: "my_rows", description: "my_rows", kind: "ours", permission: "read", args: z.object({}), execute: ran } as unknown as AgentTool;
    return { tool, ran };
  }
  const run = (athleteId: string, tool: AgentTool, extra: { fence?: FenceClearance; isDeleting?: (id: string) => Promise<boolean> } = {}) =>
    callTool({
      skill: { id: "chat", tools: [tool.name] }, tool, name: tool.name, args: {},
      ctx: { ...ctxOf(athleteId), ...(extra.fence ? { fence: extra.fence } : {}) },
      neverTerms: [], queueApproval: async () => { throw new Error("no queue"); }, citing: false,
      ...(extra.isDeleting ? { isDeleting: extra.isDeleting } : {}),
    });

  it("a live athlete: the read runs", async () => {
    const { tool, ran } = readTool();
    expect((await run(A, tool)).outcome).toBe("ok");
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("an account being deleted (the real read): denied athlete_deleting, nothing runs", async () => {
    const { tool, ran } = readTool();
    const out = await run(GONE, tool);
    expect(out).toMatchObject({ outcome: "denied", rule: "athlete_deleting" });
    expect(ran).not.toHaveBeenCalled();
  });

  it("an athlete id with no row: denied (a deleted account)", async () => {
    const { tool, ran } = readTool();
    expect((await run("00000000-0000-4000-8000-0000000000ff", tool)).outcome).toBe("denied");
    expect(ran).not.toHaveBeenCalled();
  });

  it("fails closed when the check throws", async () => {
    const { tool, ran } = readTool();
    const out = await run(A, tool, { isDeleting: async () => { throw new Error("db down"); } });
    expect(out).toMatchObject({ outcome: "denied", rule: "athlete_deleting" });
    expect(ran).not.toHaveBeenCalled();
  });

  it("reuses the engine's fresh clearance: no second read", async () => {
    const { tool, ran } = readTool();
    const fence = (await clearFence(A))!;
    const read = jest.fn(async () => true);   // would refuse if it were asked
    expect((await run(A, tool, { fence, isDeleting: read })).outcome).toBe("ok");
    expect(read).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a clearance for another athlete, a stale one, or one not minted by clearFence", async () => {
    const { tool } = readTool();
    const forA = (await clearFence(A))!;
    const read = jest.fn(async () => true);
    expect((await run(B, tool, { fence: forA, isDeleting: read })).outcome).toBe("denied");
    const forged: FenceClearance = { athleteId: A, at: Date.now() };
    expect((await run(A, tool, { fence: forged, isDeleting: read })).outcome).toBe("denied");
    expect(read).toHaveBeenCalledTimes(2);
    expect(isFreshClearance(forA, A, forA.at + FENCE_REUSE_MS)).toBe(false);
    expect(isFreshClearance(forA, A, forA.at + FENCE_REUSE_MS - 1)).toBe(true);
  });

  it("clearFence: null for a fenced athlete and when the check throws", async () => {
    expect(await clearFence(GONE)).toBeNull();
    expect(await clearFence(A, async () => { throw new Error("db down"); })).toBeNull();
  });
});
