/**
 * workflow.db.test.ts — one agent research refresh through the REAL workflow runner on PGlite. The model-calling pieces
 * (the research passes and merge, Understand, the M.I.A. preview) are replaced at their module boundary: tests never
 * reach a provider. This pins the wiring:
 *
 *   R1 the steps run in order (research_a ∥ research_b → research_merge → understand ∥ mia_preview → finish), each model
 *      run keyed under "research_refresh:<run>"; Understand gets her CURRENT Brief to carry forward; the finish step
 *      records her anchor (name, sport, team) and the cost
 *   R2 a material change: ONE suggestion stored, ONE Mila message with the card in a new chat of hers, and the push
 *      asked once (kind mila_suggestion, opening that chat); Home's row reads it
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

const calls: string[] = [];
const searchPass = jest.fn(async (job: any, o: any) => { calls.push(`pass_${o.pass}:${job.parentPrefix}`); return { runId: `pass-${o.pass}`, pass: o.pass, identity: { resolved: true, description: "", ambiguity: "" }, facts: [], gaps: [], narrative: "", dropped: [], costMicroUsd: 0 }; });
const mergePasses = jest.fn(async (job: any) => { calls.push(`merge:${job.parentPrefix}`); return { runId: "merge-1", inserted: [], disputed: 0, duplicates: 0, dropped: [], narrative: "", gaps: [], identity: { resolved: true, description: "", ambiguity: "" }, costMicroUsd: 0 }; });
jest.mock("../research/research", () => ({
  ...jest.requireActual("../research/research"),
  searchPass: (...a: any[]) => (searchPass as any)(...a),
  mergePasses: (...a: any[]) => (mergePasses as any)(...a),
  recordIdentityOutcome: jest.fn(async () => ({ written: false, superseded: 0 })),
  syncMeasured: jest.fn(async () => ({ inserted: 0, superseded: 0 })),
}));
const understandMock = jest.fn();
jest.mock("../research/understand", () => ({ ...jest.requireActual("../research/understand"), understand: (...a: any[]) => understandMock(...a) }));
const getMiaPreview = jest.fn(async () => ({ status: "ready", computed: "reused", score: 512, provenance: null }));
jest.mock("../../services/miaPreview/preview", () => ({ getMiaPreview: (...a: any[]) => (getMiaPreview as any)(...a) }));
const sendPush = jest.fn(async () => ({ status: "sent" }));
jest.mock("../../services/push/push", () => ({ ...jest.requireActual("../../services/push/push"), sendPush: (...a: any[]) => (sendPush as any)(...a) }));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, chatMessages, conversations, memoryDecisions, memoryFacts } from "../../../shared/schema";
import { configureRunner, getRun, kick, resetRunnerConfig, startRun } from "../../workflow/runner";
import "../../workflow/definitions/index";
import { dbStore } from "../research/dbStore";
import type { BriefStrategy } from "../research/store";
import { RESEARCH_REFRESH_PROCESS } from "./config";
import { homeCandidate } from "./proposal";

jest.setTimeout(120_000);

let athleteId = "";
let understandRunId = "";
const strategy = (statement: string): BriefStrategy => ({
  thesis: { key: "thesis", title: "The big idea", text: statement, factIds: [], lines: [{ text: statement, kind: "inference", factIds: [] }] },
  positioningSection: null,
  positioning: { from: "", to: "", statement, pillars: [], factIds: [] },
  contentPillars: [],
  summary: statement,
});

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Refresh Athlete", { sport: "Rowing", status: "active", auth_id: "uid-refresh" } as any);
  await db.insert(memoryFacts).values({ athlete_id: athleteId, subject_kind: "athlete", subject_name: "Refresh Athlete", claim: "Refresh Athlete rows for City Club.", type: "found", source_url: "https://example.org/club", source_title: "Club", confidence: 0.9, field: "team", field_value: "City Club" } as any);
  await dbStore.writeBrief(athleteId, { summary: "Hers.", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, display: null, runId: null });
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  // The Understand run the suggestion is keyed by (memory_decisions.run_id references agent_runs).
  [{ id: understandRunId }] = await db.insert(agentRuns).values({ athlete_id: athleteId, skill_id: "understand", skill_version: "1.12.0", trigger: "event", provider: "openai", model: "m", effort: "high", status: "completed", ended_at: new Date() }).returning({ id: agentRuns.id });
});
afterAll(async () => { resetRunnerConfig(); await closeTestDb(); });

test("R1 + R2: the steps in order; her Brief carried; a suggestion stored, posted once to a new chat, pushed once; the anchor recorded", async () => {
  understandMock.mockImplementation(async (job: any, opts: any) => {
    calls.push(`understand:${job.parentPrefix}:carry=${opts.carry?.summary ?? "none"}`);
    const brief = await dbStore.currentBrief(athleteId);
    return {
      runId: understandRunId, brief, stage: { band: "developing" }, contentPillars: [], droppedPillars: 0, downgraded: 0, droppedLines: 0, othersSponsors: 0, costMicroUsd: 0, carried: true,
      proposal: { kinds: ["new_team_or_level"], reason: "You moved clubs.", factIds: [], before: strategy("Hers."), after: strategy("New club, new chapter."), changed: ["thesis", "positioning", "narrative"] },
    };
  });

  const { run } = await startRun({ process: RESEARCH_REFRESH_PROCESS, athleteId, input: { name: "Refresh Athlete", sport: "Rowing", trigger: "manual", reason: "test" }, createdBy: "test", kick: false });
  for (let i = 0; i < 10; i++) await kick(run.id);
  const done = (await getRun(run.id))!;
  expect(done.run.status).toBe("done");
  expect(done.steps.map((s) => `${s.step}:${s.status}`).sort()).toEqual(["finish:done", "mia_preview:done", "research_a:done", "research_b:done", "research_merge:done", "understand:done"]);

  const prefix = `research_refresh:${run.id}`;
  expect(calls).toEqual(expect.arrayContaining([`pass_a:${prefix}`, `pass_b:${prefix}`, `merge:${prefix}`, `understand:${prefix}:carry=Hers.`]));
  expect(calls.indexOf(`merge:${prefix}`)).toBeLessThan(calls.indexOf(`understand:${prefix}:carry=Hers.`));
  expect(getMiaPreview).toHaveBeenCalledWith(athleteId, expect.objectContaining({ trigger: "USER_REQUESTED_REFRESH" }));

  const understandOut = done.steps.find((s) => s.step === "understand")!.output as any;
  expect(understandOut).toMatchObject({ carried: true, suggestion: { status: "suggested", decision_id: expect.any(String) } });
  const finish = done.steps.find((s) => s.step === "finish")!.output as any;
  expect(finish.anchor).toEqual({ name: "Refresh Athlete", sport: "Rowing", team: "City Club" });

  // One suggestion, one message with its card in a new chat of hers, one push that opens it.
  const decisions = await db.select().from(memoryDecisions).where(eq(memoryDecisions.athlete_id, athleteId));
  expect(decisions).toHaveLength(1);
  const detail = decisions[0].detail as any;
  expect(detail).toMatchObject({ kind: "brief_proposal", understandRunId, workflowRunId: run.id, conversationId: expect.any(String) });
  const [chat] = await db.select().from(conversations).where(eq(conversations.id, detail.conversationId));
  expect(chat.athlete_id).toBe(athleteId);
  const msgs = await db.select().from(chatMessages).where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, detail.conversationId)));
  expect(msgs).toHaveLength(1);
  expect((msgs[0].agent_cards as any[])[0]).toMatchObject({ kind: "brief-proposal", payload: { decisionId: decisions[0].id, answered: null } });
  expect(sendPush).toHaveBeenCalledTimes(1);
  expect((sendPush.mock.calls[0] as any[])[1]).toMatchObject({ kind: "mila_suggestion", dedupeKey: `mila_suggestion:${decisions[0].id}`, target: { screen: "mila", id: detail.conversationId } });
  expect(await homeCandidate(dbStore, athleteId)).toMatchObject({ kind: "mila_suggestion", target: { conversationId: detail.conversationId } });
});
