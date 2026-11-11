/**
 * enablement.db.test.ts — per-athlete tool enablement and job stops are SERVER-enforced (owner-approved A3, 3 Nov 2026),
 * on a real (PGlite) Postgres. No model, no workflow tick, no provider: the tools are fakes carrying the real names, the
 * job bodies (runMomentsScan, runPlan) are mocked, and the steps are called directly. Made-up athletes only.
 *
 *   E1 MILA_WELCOME off: nothing is refused, every job step runs (exactly as before)
 *   E2 on, unset: the optional tools are dropped from the turn's assembly (Mastra's visible list, the harness's list)
 *      and refused per call with an actionable capability_off error; core tools stay
 *   E3 a tap on the Turn-on card (turnOnFromCard) lets that capability's tools through, and only its tools
 *   E4 per-account: draft replies enabled on one mailbox lets deals_draft_reply through; disconnecting it turns it off
 *   E5 turning a capability off stops its jobs when their step RUNS (moments scan, optional plan refresh and its kits,
 *      scheduled research refresh), while a plan the athlete asked for still runs
 *   E6 consent is recorded with history (the version the sheet showed; a changed version is refused)
 *   E7 no cross-athlete effects: one athlete's yes changes nothing for another
 *   E8 the Turn-on offer check (offerFor) follows the states; every registry tool exists in the tool registry
 *   E9 the gaps closed in review (3 Nov): a goal edit's plan refresh needs plan_refresh; onboarding's first moments scan
 *      needs moments_scan; onboarding's first plan is core (not gated); post kits need post_ideas on every plan run;
 *      the legacy v1 loop's draft_reply needs draft_replies; the refusal never invites a card that cannot be drawn
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
const mockScan = jest.fn(async () => ({ status: "done" }));
jest.mock("../moments/scan", () => ({ ...jest.requireActual("../moments/scan"), runMomentsScan: () => mockScan() }));
const mockPlan = jest.fn(async () => ({ status: "done" }));
jest.mock("../plan/run", () => ({ ...jest.requireActual("../plan/run"), runPlan: () => mockPlan() }));
const mockKits = jest.fn(async () => ({ built: 0 }));
jest.mock("../postKit/build", () => ({ buildPendingPostKits: () => mockKits() }));
jest.mock("../postKit/deps", () => ({ dbPostKitDeps: () => ({}) }));

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectedAccounts, milaChoiceHistory, milaChoices } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { callTool } from "../callTool";
import { passRegistry, visibleTools } from "../engine/tools/registry";
import type { AgentTool, ToolContext } from "../tools";
import { MOMENTS_SCAN } from "../moments/workflow";
import { PLAN_REFRESH } from "../plan/workflow";
import { AGENT_RESEARCH_REFRESH } from "../researchRefresh/workflow";
import { getChoice, revokeChoice, revokeForAccount } from "./choices";
import { optionalToolCapabilities } from "./registry";
import { allowedTools, refusedTools, toolRefusal, OPTIONAL_TOOL_NAMES } from "./toolGate";
import { declineFromCard, offerFor, turnOnFromCard } from "./turnOn";
import { dbStore } from "../research/dbStore";
import { addGoal } from "../plan/goals";
import { requestPlanRefresh } from "../plan/triggers";
import { MOMENTS_STEP } from "../onboarding/workflow";
import { capability } from "./registry";
import { cardOfferable, legacyToolRefusal, refusalText } from "./toolGate";

const saved: Record<string, string | undefined> = {};
const FLAGS = ["MILA_WELCOME", "AGENT_PLAN", "AGENT_MOMENTS", "AGENT_RESEARCH_REFRESH", "AGENT_POST_KITS"] as const;
let A = "", B = "";

beforeAll(async () => {
  for (const k of FLAGS) saved[k] = process.env[k];
  await initTestDb();
  A = await seedAthlete("Ada Example", { sport: "Rowing" } as any);
  B = await seedAthlete("Bo Example", { sport: "Rowing" } as any);
});
afterAll(async () => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});
beforeEach(() => {
  process.env.MILA_WELCOME = "true";
  process.env.AGENT_PLAN = "true";
  process.env.AGENT_MOMENTS = "true";
  process.env.AGENT_RESEARCH_REFRESH = "true";
  process.env.AGENT_POST_KITS = "true";
  mockScan.mockClear(); mockPlan.mockClear(); mockKits.mockClear();
});

/** A fake tool with a real name: execute records that it ran. */
function fake(name: string, permission: AgentTool["permission"] = "draft") {
  const ran = jest.fn(async () => ({ status: "ok" }));
  const tool = { name, description: name, kind: "ours", permission, args: z.object({}), execute: ran } as unknown as AgentTool;
  return { tool, ran };
}
async function call(athleteId: string, name: string, permission: AgentTool["permission"] = "draft", args: Record<string, unknown> = {}) {
  const { tool, ran } = fake(name, permission);
  const ctx: ToolContext = { athleteId, runId: "00000000-0000-4000-8000-000000000001", skillId: "chat" };
  const out = await callTool({ skill: { id: "chat", tools: [name] }, tool, name, args, ctx, neverTerms: [], queueApproval: async () => { throw new Error("no queue"); }, citing: false });
  return { out, ran };
}
const step = (wf: { steps: Array<{ name: string; run?: (ctx: any) => Promise<unknown> }> }, name: string) => wf.steps.find((s) => s.name === name)!.run!;
const ctxFor = (athleteId: string, runInput: unknown) => ({ runId: "run-1", athleteId, process: "p", definitionVersion: 1, step: "s", attempt: 1, input: null, outputs: {}, runInput });

describe("E1 MILA_WELCOME off: transparent", () => {
  it("refuses nothing and every job step runs", async () => {
    delete process.env.MILA_WELCOME;
    expect((await refusedTools(A, ["refresh_plan", "deals_draft_reply", "documents_make"])).size).toBe(0);
    const { out, ran } = await call(A, "refresh_plan");
    expect(out.outcome).toBe("ok");
    expect(ran).toHaveBeenCalled();
    await step(MOMENTS_SCAN, "scan")(ctxFor(A, { trigger: "schedule", reason: "weekly" }));
    expect(mockScan).toHaveBeenCalledTimes(1);
    await step(PLAN_REFRESH, "plan")(ctxFor(A, { trigger: "schedule", reason: "weekly", optional: true }));
    expect(mockPlan).toHaveBeenCalledTimes(1);
  });
});

describe("E2 unset: optional tools refused in the assembly and per call", () => {
  it("drops them from the turn's visible tools, keeps the core ones", async () => {
    const registry = passRegistry();
    const names = ["recall_facts", "deals_find", "bookings_list", "refresh_plan", "deals_draft_reply", "documents_make", "bookings_respond"].filter((n) => registry.get(n));
    const visible = visibleTools({ id: "chat", tools: names }, registry, { scopes: ["read", "draft", "propose", "act"] });
    const assembled = (await allowedTools(A, visible)).map((t) => t.name);
    for (const core of ["recall_facts", "deals_find", "bookings_list"]) if (names.includes(core)) expect(assembled).toContain(core);
    for (const opt of ["refresh_plan", "deals_draft_reply", "bookings_respond"]) expect(assembled).not.toContain(opt);
    // documents_make is owned per document (a public page draft is core), so it stays in the list and the call decides.
    if (names.includes("documents_make")) expect(assembled).toContain("documents_make");
  });

  it("refuses the call with an actionable error and never runs the tool", async () => {
    const { out, ran } = await call(A, "refresh_plan");
    expect(out.outcome).toBe("denied");
    expect(out).toMatchObject({ rule: "capability_off" });
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("refresh_plan is off");
    // No Turn-on card can be drawn for it here (the card system names its own offerable keys): Me, never offer_capability.
    expect(reason).toContain("do not offer it with offer_capability");
    expect(reason).toContain("turn it on in Me");
    expect(ran).not.toHaveBeenCalled();
    expect(await toolRefusal(A, "recall_facts")).toBeNull();
    const core = await call(A, "recall_facts", "read");
    expect(core.out.outcome).toBe("ok");
  });
});

describe("E3 enabling lets its tools through", () => {
  it("a Turn-on tap enables plan_refresh: refresh_plan runs, documents_make still refused", async () => {
    const offer = await offerFor(A, "plan_refresh");
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    const r = await turnOnFromCard({ athleteId: A, key: "plan_refresh", consentVersion: offer.words.version, expectedVersion: offer.choice.version });
    expect(r).toMatchObject({ ok: true, changed: true });
    const { out, ran } = await call(A, "refresh_plan");
    expect(out.outcome).toBe("ok");
    expect(ran).toHaveBeenCalledTimes(1);
    expect((await call(A, "documents_make", "draft", { document: "pitch" })).out.outcome).toBe("denied");
  });
});

describe("E4 per-account capability", () => {
  it("draft replies on one active mailbox lets deals_draft_reply through; disconnecting turns it off", async () => {
    const mailbox = await seedConnection({ athleteId: A, platform: "gmail", email: "ada@example.org" });
    expect(await toolRefusal(A, "deals_draft_reply")).toContain("Draft replies to brands (draft_replies) is not turned on");
    expect((await offerFor(A, "draft_replies")).ok).toBe(false);   // needs the account
    expect(await turnOnFromCard({ athleteId: A, key: "draft_replies", accountRef: mailbox, consentVersion: "draft_replies/2" })).toMatchObject({ ok: true });
    expect(await toolRefusal(A, "deals_draft_reply")).toBeNull();
    // The token dies: refused (running state), the choice itself untouched.
    await db.update(connectedAccounts).set({ status: "revoked" }).where(eq(connectedAccounts.id, mailbox));
    expect(await toolRefusal(A, "deals_draft_reply")).not.toBeNull();
    expect((await getChoice(A, "draft_replies", mailbox)).state).toBe("enabled");
    // The athlete disconnects: the choice is turned off and stays off on reconnect.
    expect(await revokeForAccount(A, mailbox, "settings")).toEqual(["draft_replies"]);
    await db.update(connectedAccounts).set({ status: "active" }).where(eq(connectedAccounts.id, mailbox));
    expect(await toolRefusal(A, "deals_draft_reply")).not.toBeNull();
  });
});

describe("E5 turning a capability off stops its jobs when they run", () => {
  it("moments scan", async () => {
    expect(await turnOnFromCard({ athleteId: A, key: "moments_scan", consentVersion: "moments_scan/1" })).toMatchObject({ ok: true });
    await step(MOMENTS_SCAN, "scan")(ctxFor(A, { trigger: "schedule", reason: "weekly" }));
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(await revokeChoice(A, "moments_scan", null, "me")).toMatchObject({ ok: true });
    expect(await step(MOMENTS_SCAN, "scan")(ctxFor(A, { trigger: "schedule", reason: "weekly" }))).toEqual({ status: "skipped", reason: "not_chosen" });
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it("an automatic plan refresh (and its kits) stops; a plan the athlete asked for still runs", async () => {
    expect(await revokeChoice(A, "plan_refresh", null, "me")).toMatchObject({ ok: true });
    expect(await step(PLAN_REFRESH, "plan")(ctxFor(A, { trigger: "schedule", reason: "weekly", optional: true }))).toEqual({ status: "skipped", reason: "not_chosen" });
    expect(await step(PLAN_REFRESH, "post_kits")(ctxFor(A, { trigger: "schedule", reason: "weekly", optional: true }))).toEqual({ status: "skipped", reason: "not_chosen" });
    expect(mockPlan).not.toHaveBeenCalled();
    await step(PLAN_REFRESH, "plan")(ctxFor(A, { trigger: "event", reason: "you added a goal" }));
    expect(mockPlan).toHaveBeenCalledTimes(1);
  });

  it("the scheduled research refresh stops at every step; anchor refreshes are not gated", async () => {
    for (const s of AGENT_RESEARCH_REFRESH.steps) {
      expect(await s.run!(ctxFor(A, { name: "Ada Example", sport: "Rowing", trigger: "schedule", reason: "monthly" }) as any)).toEqual({ status: "skipped", reason: "not_chosen" });
    }
  });
});

describe("E6 consent is recorded with history", () => {
  it("keeps the version the sheet showed, each move as a history row, and refuses a changed version", async () => {
    expect(await turnOnFromCard({ athleteId: B, key: "post_ideas", consentVersion: "post_ideas/0" })).toMatchObject({ ok: false, error: "consent_changed" });
    expect(await declineFromCard(B, "post_ideas", null, "not_now")).toMatchObject({ ok: true });
    expect(await turnOnFromCard({ athleteId: B, key: "post_ideas", consentVersion: "post_ideas/1", expectedVersion: 0 })).toMatchObject({ ok: false, error: "version_conflict" });
    expect(await turnOnFromCard({ athleteId: B, key: "post_ideas", consentVersion: "post_ideas/1", expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(await revokeChoice(B, "post_ideas", null, "me")).toMatchObject({ ok: true });
    const [row] = await db.select().from(milaChoices).where(and(eq(milaChoices.athlete_id, B), eq(milaChoices.capability, "post_ideas")));
    expect(row).toMatchObject({ state: "revoked", consent_version: "post_ideas/1", version: 3 });
    expect((row.consent as { version: string }).version).toBe("post_ideas/1");
    const hist = await db.select().from(milaChoiceHistory).where(and(eq(milaChoiceHistory.athlete_id, B), eq(milaChoiceHistory.capability, "post_ideas")));
    expect(hist.sort((x, y) => x.version - y.version).map((h) => [h.from_state, h.to_state, h.via])).toEqual([
      [null, "not_now", "card"], ["not_now", "enabled", "card"], ["enabled", "revoked", "me"],
    ]);
  });
});

describe("E7 no cross-athlete effects", () => {
  it("B's yes changes nothing for A, and A's no changes nothing for B", async () => {
    expect(await turnOnFromCard({ athleteId: B, key: "deal_watch", consentVersion: "deal_watch/1" })).toMatchObject({ ok: false, error: "core_capability" });
    expect(await turnOnFromCard({ athleteId: B, key: "public_page", consentVersion: "public_page/2" })).toMatchObject({ ok: false, error: "not_a_switch" });
    expect(await turnOnFromCard({ athleteId: B, key: "moments_scan", consentVersion: "moments_scan/1" })).toMatchObject({ ok: true });
    await step(MOMENTS_SCAN, "scan")(ctxFor(A, { trigger: "schedule", reason: "weekly" }));
    expect(mockScan).not.toHaveBeenCalled();                                   // A turned it off in E5
    await step(MOMENTS_SCAN, "scan")(ctxFor(B, { trigger: "schedule", reason: "weekly" }));
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(await toolRefusal(B, "refresh_plan")).not.toBeNull();             // A enabled plan_refresh in E3, B never did
    expect((await getChoice(A, "moments_scan")).state).toBe("revoked");
  });
});

describe("E8 offer check and registry guard", () => {
  it("offerFor follows the states", async () => {
    expect(await offerFor(B, "moments_scan")).toMatchObject({ ok: false, reason: "already_on" });
    expect(await offerFor(B, "post_ideas")).toMatchObject({ ok: false, reason: "turned_off" });
    expect(await offerFor(B, "deal_watch")).toMatchObject({ ok: false, reason: "core_capability" });
    expect(await declineFromCard(B, "plan_refresh", null, "never")).toMatchObject({ ok: true });
    expect(await offerFor(B, "plan_refresh")).toMatchObject({ ok: false, reason: "said_never" });
    expect(await declineFromCard(B, "profile_refresh", null, "not_now")).toMatchObject({ ok: true });
    expect(await offerFor(B, "profile_refresh")).toMatchObject({ ok: false, reason: "cooling_down" });
    expect(await offerFor(B, "profile_refresh", null, new Date(Date.now() + 15 * 86_400_000))).toMatchObject({ ok: true });
    delete process.env.MILA_WELCOME;
    expect(await offerFor(B, "auto_archive")).toMatchObject({ ok: false, reason: "welcome_off" });
  });

  it("every tool an optional capability unlocks is a registered tool", () => {
    const registry = passRegistry();
    expect(OPTIONAL_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of OPTIONAL_TOOL_NAMES) expect(registry.get(name)?.name).toBe(name);
    // a use ("documents_make:pitch") names a registered tool
    expect([...optionalToolCapabilities().keys()].filter((n) => n.includes(":")).length).toBeGreaterThan(0);
  });
});

describe("E9 gaps closed in review", () => {
  let C = "";
  const starts: string[] = [];
  const start = async (o: { athleteId: string }) => { starts.push(o.athleteId); return { runId: `p-${starts.length}`, created: true }; };
  beforeAll(async () => {
    C = await seedAthlete("Cy Example", { sport: "Rowing" } as any);
    await dbStore.writeBrief(C, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  });
  beforeEach(() => { starts.length = 0; });

  it("a goal edit's plan refresh is automatic: refused until plan_refresh is on (the goal is saved either way)", async () => {
    await addGoal(C, { text: "Grow my audience" }, { store: dbStore, start: start as any });
    expect(starts).toEqual([]);
    expect(await requestPlanRefresh(C, { trigger: "event", reason: "you added a goal", optional: true }, { start: start as any })).toEqual({ started: false, reason: "not_chosen" });
    expect((await dbStore.listGoals(C)).map((g) => g.text)).toContain("Grow my audience");
    expect(await turnOnFromCard({ athleteId: C, key: "plan_refresh", consentVersion: "plan_refresh/1" })).toMatchObject({ ok: true });
    await addGoal(C, { text: "Land a first deal" }, { store: dbStore, start: start as any });
    expect(starts).toEqual([C]);
    expect(await revokeChoice(C, "plan_refresh", null, "me")).toMatchObject({ ok: true });
  });

  it("with MILA_WELCOME off a goal edit refreshes the plan exactly as before", async () => {
    delete process.env.MILA_WELCOME;
    await addGoal(C, { text: "Post every week" }, { store: dbStore, start: start as any });
    expect(starts).toEqual([C]);
  });

  it("onboarding's first plan is core sign-up service: not gated on plan_refresh", async () => {
    expect(capability("first_plan")).toMatchObject({ core: true });
    const r = await requestPlanRefresh(C, { trigger: "event", reason: "the Brief was written", immediate: true }, { start: start as any });
    expect(r).toMatchObject({ started: true });
    expect(starts).toEqual([C]);
  });

  it("onboarding's first moments scan needs moments_scan (unset at sign-up: skipped)", async () => {
    const ctx = { ...ctxFor(C, null), runId: "11111111-1111-4111-8111-111111111111" };
    expect(await MOMENTS_STEP.run!(ctx as any)).toEqual({ status: "skipped", reason: "not_chosen" });
    expect(mockScan).not.toHaveBeenCalled();
    expect(await turnOnFromCard({ athleteId: C, key: "moments_scan", consentVersion: "moments_scan/1" })).toMatchObject({ ok: true });
    await MOMENTS_STEP.run!(ctx as any);
    expect(mockScan).toHaveBeenCalledTimes(1);
    delete process.env.MILA_WELCOME;
    expect(await revokeChoice(C, "moments_scan", null, "me")).toMatchObject({ ok: false, error: "disabled" });
    await MOMENTS_STEP.run!(ctx as any);   // off: as before
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it("post kits pick from her own media: they need post_ideas on every plan run, the first plan included", async () => {
    expect(await step(PLAN_REFRESH, "post_kits")(ctxFor(C, { trigger: "event", reason: "the Brief was written" }))).toEqual({ status: "skipped", reason: "not_chosen" });
    expect(mockKits).not.toHaveBeenCalled();
    expect(await turnOnFromCard({ athleteId: C, key: "post_ideas", consentVersion: "post_ideas/1" })).toMatchObject({ ok: true });
    expect(await step(PLAN_REFRESH, "post_kits")(ctxFor(C, { trigger: "event", reason: "the Brief was written" }))).toMatchObject({ status: "done" });
    expect(mockKits).toHaveBeenCalledTimes(1);
  });

  it("the legacy v1 loop's draft_reply is refused while draft_replies is off; transparent with the flag off", async () => {
    const r = await legacyToolRefusal(C, "draft_reply");
    expect(r).toContain("draft_reply is off for this athlete: Draft replies to brands (draft_replies) is not turned on.");
    expect(await legacyToolRefusal(C, "get_deal")).toBeNull();
    delete process.env.MILA_WELCOME;
    expect(await legacyToolRefusal(C, "draft_reply")).toBeNull();
  });

  it("a key is card-offerable only with MILA_CARDS_V2 on and a card presentation (every built switch, 5 Nov)", () => {
    const saved = process.env.MILA_CARDS_V2;
    try {
      process.env.MILA_CARDS_V2 = "true";
      expect([cardOfferable("post_ideas"), cardOfferable("plan_refresh"), cardOfferable("draft_replies"), cardOfferable("studio_posts"), cardOfferable("reminders")]).toEqual([true, true, true, false, false]);
      delete process.env.MILA_CARDS_V2;
      expect(cardOfferable("post_ideas")).toBe(false);
    } finally { if (saved === undefined) delete process.env.MILA_CARDS_V2; else process.env.MILA_CARDS_V2 = saved; }
  });

  it("the refusal names offer_capability only for a key the Turn-on card can draw", () => {
    expect(refusalText("refresh_plan", ["plan_refresh"], (k) => k === "plan_refresh"))
      .toBe("refresh_plan is off for this athlete: Your plan, refreshed weekly (plan_refresh) is not turned on. Do not retry. Offer it with offer_capability (key: plan_refresh); only their tap on that card turns it on.");
    expect(refusalText("refresh_plan", ["plan_refresh"]))
      .toBe("refresh_plan is off for this athlete: Your plan, refreshed weekly (plan_refresh) is not turned on. Do not retry, and do not offer it with offer_capability. Say it is off and that they can turn it on in Me; only their own tap turns it on.");
  });
});
