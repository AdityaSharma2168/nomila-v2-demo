/**
 * onboarding.test.ts — the first entry on the real runner + pglite.
 *
 * Pinned:
 *   • the vocabulary: unknown fields, empty values and over-long lists are refused, not stored
 *   • a correction writes an athlete_asserted row + a reversible profile_write receipt, and
 *     sport/school also update the athletes column; Undo puts both back
 *   • the block carries facts only (no email/thread text), lists what the athlete told us, and
 *     names the current step
 *   • onboarding v2 end to end: fresh research is skipped, the run parks on greet, the tool
 *     records corrections and moves to doors, a door finishes the run
 *   • the tool refuses when no step is waiting; the widget renders only from an ok result and
 *     wins the turn over any other card
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../skills/researchAthlete", () => ({
  buildSearchName: (a: any) => `${a.full_name} ${a.school ?? ""} ${a.sport ?? ""}`.trim(),
  researchAthlete: jest.fn(),
}));
jest.mock("../skills/fetchSocialData", () => ({ fetchSocialData: jest.fn() }));
jest.mock("../skills/mediaBackfill", () => ({ backfillAthletePlatform: jest.fn() }));
jest.mock("../skills/enrichTopPostInsights", () => ({ enrichTopPostInsights: jest.fn() }));
jest.mock("../skills/firstLook", () => ({ FIRST_LOOK_POSTS: 30, runFirstLook: jest.fn() }));
// The kit builder (the paid multi-model DAG) — onboarding rebuilds the generic card in the background.
jest.mock("../services/mediaKitService", () => ({
  assembleMediaKit: jest.fn(async () => ({ identity: { name: "Rebuilt After Onboarding" }, cards: [], deck: [], tokens: { theme: "campaign" } })),
}));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { agentActions, athleteAsserted, athleteSnapshots, athletes, athletesCurrent, mediaKits, workflowRuns, workflowSteps } from "../../shared/schema";
import { researchAthlete } from "../skills/researchAthlete";
import { configureRunner, resetRunnerConfig, startRun, getRun } from "../workflow/runner";
import "../workflow/definitions"; // registers onboarding v1 + v2
import {
  latestAssertions, loadOnboardingFacts, parseDoorsFields, parseGreetFields, recordAssertions,
  renderOnboardingBlock, undoProfileWrite, buildOnboardingPrompt, OnboardingFieldError, latestFirstLooks,
} from "./onboarding";
import { completeOnboardingStepTool } from "./tools/completeOnboardingStep";
import { buildWidget, selectTurnWidget } from "./widgets";
import type { MilaWidget } from "./types";
import { assembleMediaKit } from "../services/mediaKitService";

const research = researchAthlete as jest.Mock;
let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Lilia Bhuta");
  await db.update(athletes).set({ first_name: "Lilia", sport: "soccer", school: "Stanford University" } as any).where(eq(athletes.id, athleteId));
});
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  jest.clearAllMocks();
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
  await db.delete(athleteAsserted);
  await db.delete(agentActions);
  await db.delete(athleteSnapshots);
  await db.update(athletes).set({ sport: "soccer", school: "Stanford University" } as any).where(eq(athletes.id, athleteId));
});

// ─── Vocabulary ───────────────────────────────────────────────────────────────

test("parseGreetFields: accepts known fields, tidies whitespace, and treats no corrections as confirmed", () => {
  const out = parseGreetFields({ confirmed: false, corrections: [{ field: "position", value: "  midfielder \n", said: "I play mid" }] });
  expect(out).toEqual({ confirmed: false, corrections: [{ field: "position", value: "midfielder", said: "I play mid" }] });
  expect(parseGreetFields({}).confirmed).toBe(true);
  expect(parseGreetFields({ confirmed: true, corrections: [] })).toEqual({ confirmed: true, corrections: [] });
});

test("parseGreetFields: refuses an unknown field, an empty value, and too many corrections", () => {
  expect(() => parseGreetFields({ corrections: [{ field: "email", value: "x@y.z" }] })).toThrow(OnboardingFieldError);
  expect(() => parseGreetFields({ corrections: [{ field: "position", value: "   " }] })).toThrow(/Empty value/);
  const many = Array.from({ length: 9 }, () => ({ field: "note", value: "x" }));
  expect(() => parseGreetFields({ corrections: many })).toThrow(/At most 8/);
  expect(() => parseDoorsFields({ door: "exit" })).toThrow(OnboardingFieldError);
  expect(parseDoorsFields({ door: "deals" })).toEqual({ door: "deals" });
});

// ─── Writes + undo ────────────────────────────────────────────────────────────

test("recordAssertions: asserted row + reversible profile_write receipt; school also updates the column; undo restores both", async () => {
  const saved = await recordAssertions({
    athleteId, runId: null, mode: "chat",
    corrections: [
      { field: "position", value: "midfielder", said: "I'm a mid" },
      { field: "school", value: "Stanford", said: "just say Stanford" },
    ],
  });
  expect(saved.map((s) => s.field)).toEqual(["position", "school"]);

  const rows = await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId));
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.agent_action_id && r.source === "onboarding" && r.mode === "chat")).toBe(true);

  const receipts = await db.select().from(agentActions).where(eq(agentActions.athlete_id, athleteId));
  expect(receipts).toHaveLength(2);
  expect(receipts.every((r) => r.action === "profile_write" && r.reversible)).toBe(true);
  const schoolReceipt = receipts.find((r) => (r.payload as any).field === "school")!;
  expect(schoolReceipt.payload).toMatchObject({ column: "school", from: "Stanford University", to: "Stanford" });

  const [a] = await db.select({ school: athletes.school }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.school).toBe("Stanford");

  await undoProfileWrite(schoolReceipt);
  const [after] = await db.select({ school: athletes.school }).from(athletes).where(eq(athletes.id, athleteId));
  expect(after.school).toBe("Stanford University");
  const current = await latestAssertions(athleteId);
  expect(current.map((c) => c.field)).toEqual(["position"]); // the retracted school row is gone from "current"
});

test("latestAssertions: a newer value for the same field supersedes the older one", async () => {
  await recordAssertions({ athleteId, runId: null, mode: "voice", corrections: [{ field: "position", value: "forward" }] });
  await recordAssertions({ athleteId, runId: null, mode: "chat", corrections: [{ field: "position", value: "midfielder" }] });
  const current = await latestAssertions(athleteId);
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({ field: "position", label: "Position", value: "midfielder", raw: "midfielder", said: null, source: "onboarding", mode: "chat" });
  const rows = await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId));
  expect(rows.filter((r) => r.superseded_by).length).toBe(1);
});

// ─── The block ────────────────────────────────────────────────────────────────

test("the block carries facts only and names the step; what the athlete told us appears under TOLD US", async () => {
  await db.insert(athleteSnapshots).values({
    athlete_id: athleteId, trigger: "signup",
    research: {
      achievements: [{ name: "Pac-12 All-Freshman Team", year: 2024 }],
      brand_mentions: [{ brand: "gorjana" }, { brand: "gorjana" }, { brand: "adidas" }],
      causes: [{ name: "Girls in sport" }],
      summary: "A paragraph of research prose that must NOT be in the block. Reply-To: attacker@example.com",
    },
  } as any);
  await db.insert(athletesCurrent).values({ athlete_id: athleteId } as any).onConflictDoNothing();
  await recordAssertions({ athleteId, runId: null, mode: "chat", corrections: [{ field: "position", value: "midfielder" }] });

  const facts = (await loadOnboardingFacts(athleteId))!;
  expect(facts.first_name).toBe("Lilia");
  expect(facts.brands_seen).toEqual(["gorjana", "adidas"]);
  const block = renderOnboardingBlock(facts, "greet");
  expect(block).toContain("<<<ONBOARDING_CONTEXT>>>");
  expect(block).toContain("achievements_found: Pac-12 All-Freshman Team (2024)");
  expect(block).toContain("TOLD US: position = midfielder");
  expect(block).toContain("current_step: greet");
  expect(block).toContain("CURRENT STEP: greet");
  expect(block).not.toContain("attacker@example.com");
  expect(block).not.toContain("paragraph of research prose");
  // Legacy retirement, phase 1: the legacy athletes_current score (404 · Rising) never reaches Mila; no M.I.A.
  // assessment is seeded here, so the line says so.
  expect(block).toContain("score: not scored yet");
  expect(block).not.toContain("404");
  expect(block).not.toContain("Rising");

  // No active run → the prompt says onboarding is finished and does not offer the tool.
  const prompt = await buildOnboardingPrompt(athleteId);
  expect(prompt).toContain("current_step: finished");
  expect(prompt).toContain("do not call complete_onboarding_step");
});

// ─── v2 end to end ────────────────────────────────────────────────────────────

test("the block reads the first look from the connect-time snapshot, not a trigger nobody writes", async () => {
  // fetchSocialData inserts trigger "social_connect"; skills/firstLook UPDATEs that row's first_look.
  await db.insert(athleteSnapshots).values({
    athlete_id: athleteId, trigger: "social_connect", research: {},
    first_look: { platform: "instagram", posts_read: 30, cadence: { posts_per_week: 2.5 }, themes: ["match day", "training", "teammates"], tone: ["warm"], tagged: [{ handle: "@stanfordwsoccer" }] },
  } as any);
  const looks = await latestFirstLooks(athleteId);
  expect(looks.map((l) => [l.platform, l.posts_read, l.posts_per_week])).toEqual([["instagram", 30, 2.5]]);
  const prompt = await buildOnboardingPrompt(athleteId);
  expect(prompt).toContain("posts_instagram: read 30, about 2.5/week; themes: match day, training, teammates; tone: warm; often tags: @stanfordwsoccer");
  expect(prompt).not.toContain("no first look yet");
});

test("onboarding v2: fresh research is skipped, the run parks on greet, corrections move it to doors, a door finishes it", async () => {
  await db.insert(athleteSnapshots).values({ athlete_id: athleteId, trigger: "signup", research: { achievements: [] } } as any);

  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "test", idempotencyKey: `onboarding:${athleteId}` });
  expect(run.definition_version).toBe(2);
  expect(run.status).toBe("waiting");
  expect(research).not.toHaveBeenCalled();
  let found = (await getRun(run.id))!;
  expect(found.steps.find((s) => s.step === "research")!.output).toMatchObject({ skipped: true });
  expect(found.steps.find((s) => s.status === "waiting")!.step).toBe("greet");

  // Wrong step → refused, nothing written.
  const wrong = await completeOnboardingStepTool.execute(athleteId, { step: "doors", door: "deals" } as any);
  expect(wrong).toMatchObject({ error: expect.stringContaining("'greet'") });

  const greeted = (await completeOnboardingStepTool.execute(athleteId, {
    step: "greet", confirmed: false,
    corrections: [{ field: "position", value: "midfielder", said: "I'm a mid, not a forward" }, { field: "hometown", value: "Dublin, Ohio" }],
  } as any)) as any;
  expect(greeted.ok).toBe(true);
  expect(greeted.next).toBe("doors");
  expect(greeted.saved.map((s: any) => s.field)).toEqual(["position", "hometown"]);
  expect(greeted.saved[0].agent_action_id).toBeTruthy();

  found = (await getRun(run.id))!;
  const greetStep = found.steps.find((s) => s.step === "greet" && s.status === "done")!;
  expect(greetStep.mode).toBe("chat");
  expect(found.steps.find((s) => s.status === "waiting")!.step).toBe("doors");

  // The widget the loop would render from that result: receipt + doors, and it wins the turn.
  const widget = buildWidget("complete_onboarding_step", greeted)!;
  expect(widget.type).toBe("onboarding_update");
  expect(widget.data).toMatchObject({ runId: run.id, step: "greet", next: "doors", door: null });
  expect((widget.data as any).saved[0]).toMatchObject({ field: "position", label: "Position", value: "midfielder" });
  const list: MilaWidget = { type: "deal_list", data: { deals: [] } };
  expect(selectTurnWidget([{ name: "complete_onboarding_step", widget }, { name: "list_deals", widget: list }], "…", ["complete_onboarding_step", "list_deals"], "hi")).toBe(widget);

  const chosen = (await completeOnboardingStepTool.execute(athleteId, { step: "doors", door: "deals" } as any)) as any;
  expect(chosen).toMatchObject({ ok: true, next: "done", door: "deals" });
  found = (await getRun(run.id))!;
  expect(found.run.status).toBe("done");
  expect(found.steps.find((s) => s.step === "wrap")!.output).toMatchObject({ door: "deals", saved: 2 });

  // Finished → the tool refuses and the widget from a refusal is nothing.
  const again = await completeOnboardingStepTool.execute(athleteId, { step: "doors", door: "profile" } as any);
  expect(again).toMatchObject({ error: expect.stringContaining("No onboarding step") });
  expect(buildWidget("complete_onboarding_step", again)).toBeNull();
});

test("onboarding v2: stale research runs the researcher; a bad correction is refused at the step and nothing is written", async () => {
  research.mockResolvedValue({ snapshotId: "snap-2", score: { displayScore: 410, tier: "Rising" } });
  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "test" });
  expect(research).toHaveBeenCalledTimes(1);
  expect(run.status).toBe("waiting");

  const bad = await completeOnboardingStepTool.execute(athleteId, { step: "greet", corrections: [{ field: "position", value: "   " }] } as any);
  expect(bad).toMatchObject({ error: expect.stringContaining("Empty value") });
  expect(await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId))).toHaveLength(0);
  expect((await getRun(run.id))!.steps.find((s) => s.status === "waiting")!.step).toBe("greet");
});

// ─── The generic card is rebuilt after onboarding (security fix A1 follow-up) ──────────────────
// Public share links read the cached kit only and never build, so when onboarding drops the stale
// generic card it must rebuild it itself (server-side, in the background), or a live generic share
// would sit at "being refreshed" until the athlete next opened her app.
test("onboarding v2 completion: the stale generic card is dropped and rebuilt exactly once in the background; brand decks untouched", async () => {
  const buildKit = assembleMediaKit as unknown as jest.Mock;
  await db.delete(mediaKits).where(eq(mediaKits.athlete_id, athleteId));
  await db.insert(mediaKits).values({ athlete_id: athleteId, brand_id: 0, data: { identity: { name: "Stale" }, cards: [] } } as any);
  await db.insert(mediaKits).values({ athlete_id: athleteId, brand_id: 141, data: { identity: { name: "Brand deck" }, cards: [] } } as any);
  // Fresh research → context_ready keeps the card; the athlete's corrections at greet are what invalidate it (wrap).
  await db.insert(athleteSnapshots).values({ athlete_id: athleteId, trigger: "signup", research: { achievements: [] } } as any);

  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "test", idempotencyKey: `onboarding-kit:${athleteId}` });
  expect(run.status).toBe("waiting");
  expect(buildKit).not.toHaveBeenCalled();
  await completeOnboardingStepTool.execute(athleteId, { step: "greet", confirmed: false, corrections: [{ field: "position", value: "midfielder" }] } as any);
  const done = (await completeOnboardingStepTool.execute(athleteId, { step: "doors", door: "deals" } as any)) as any;
  expect(done).toMatchObject({ ok: true, next: "done" });
  const found = (await getRun(run.id))!;
  expect(found.run.status).toBe("done");
  expect(found.steps.find((s) => s.step === "wrap")!.output).toMatchObject({ kits_invalidated: 1 });

  // The rebuild is fire-and-forget; wait for it to land.
  let rebuilt: any = null;
  for (let i = 0; i < 200 && !rebuilt; i++) {
    const [row] = await db.select({ data: mediaKits.data }).from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, 0)));
    if (row) rebuilt = row.data; else await new Promise((r) => setTimeout(r, 10));
  }
  expect(rebuilt?.identity?.name).toBe("Rebuilt After Onboarding");
  await new Promise((r) => setTimeout(r, 50));   // nothing else trails in after it
  expect(buildKit).toHaveBeenCalledTimes(1);
  expect(buildKit.mock.calls[0][0]).toBe(athleteId);
  expect(buildKit.mock.calls[0][1]).toMatchObject({ brandId: undefined });   // the GENERIC card only
  const [brand] = await db.select({ data: mediaKits.data }).from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, 141)));
  expect((brand.data as any).identity.name).toBe("Brand deck");
});
