/**
 * onboardingRoute.test.ts — the first entry on the voice wire.
 * DB is PGlite (real SQL); research is mocked; no model.
 *
 * Pinned: the secret gates both routes; GET says whether the athlete is in their first entry and
 * hands over the same block the chat loop uses; POST completes the waiting step with mode
 * 'voice', refuses the wrong step, refuses a bad field, and can only ever touch the athlete in
 * the path.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../skills/researchAthlete", () => ({
  buildSearchName: (a: any) => `${a.full_name} ${a.school ?? ""} ${a.sport ?? ""}`.trim(),
  researchAthlete: jest.fn(async () => ({ snapshotId: "snap-v", score: { displayScore: 400, tier: "Rising" } })),
}));
jest.mock("../skills/fetchSocialData", () => ({ fetchSocialData: jest.fn() }));
jest.mock("../skills/mediaBackfill", () => ({ backfillAthletePlatform: jest.fn() }));
jest.mock("../skills/enrichTopPostInsights", () => ({ enrichTopPostInsights: jest.fn() }));
jest.mock("../skills/firstLook", () => ({ FIRST_LOOK_POSTS: 30, runFirstLook: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import voiceOnboardingRouter from "./onboardingRoute";
import { athletes, athleteAsserted, workflowRuns, workflowSteps } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { configureRunner, resetRunnerConfig, startRun, getRun } from "../workflow/runner";
import "../workflow/definitions";

const SECRET = "voice-test-secret-0123456789";
const auth = { "x-voice-secret": SECRET };

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

async function call(method: "GET" | "POST", path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Voice Athlete");
  otherAthleteId = await seedAthlete("Voice Other");
  await db.update(athletes).set({ first_name: "Vee", sport: "soccer", school: "Stanford University" } as any).where(eq(athletes.id, athleteId));
  process.env.VOICE_SERVICE_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use("/api/internal/voice", voiceOnboardingRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/voice`;
});
afterAll(async () => {
  server.close();
  delete process.env.VOICE_SERVICE_SECRET;
  await closeTestDb();
});
beforeEach(async () => {
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
  await db.delete(athleteAsserted);
});

test("both routes fail closed without the secret", async () => {
  expect((await call("GET", `/athletes/${athleteId}/onboarding`)).status).toBe(401);
  expect((await call("POST", `/athletes/${athleteId}/onboarding/steps/greet/complete`, {}, { fields: {} })).status).toBe(401);
  expect((await call("GET", `/athletes/not-a-uuid/onboarding`, auth)).status).toBe(400);
});

test("GET: not in the first entry → active false and no prompt; in it → step + the chat loop's block", async () => {
  const idle = await call("GET", `/athletes/${athleteId}/onboarding`, auth);
  expect(idle.status).toBe(200);
  expect(idle.body).toEqual({ active: false, run_id: null, step: null, prompt: "" });

  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "test" });
  const live = await call("GET", `/athletes/${athleteId}/onboarding`, auth);
  expect(live.body).toMatchObject({ active: true, run_id: run.id, step: "greet" });
  expect(live.body.prompt).toContain("<<<ONBOARDING_CONTEXT>>>");
  expect(live.body.prompt).toContain("name: Voice Athlete (first name: Vee)");
  expect(live.body.prompt).toContain("CURRENT STEP: greet");
});

test("POST: completes the waiting step with mode voice; wrong step and bad field are refused; another athlete's path sees nothing", async () => {
  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "test" });

  const wrongStep = await call("POST", `/athletes/${athleteId}/onboarding/steps/doors/complete`, auth, { fields: { door: "deals" } });
  expect(wrongStep.status).toBe(409);

  const badField = await call("POST", `/athletes/${athleteId}/onboarding/steps/greet/complete`, auth, { fields: { corrections: [{ field: "email", value: "x" }] } });
  expect(badField.status).toBe(400);
  expect(badField.body.error).toMatch(/Unknown profile field/);

  // The other athlete has no run: their path can never complete this one.
  const other = await call("POST", `/athletes/${otherAthleteId}/onboarding/steps/greet/complete`, auth, { fields: { confirmed: true } });
  expect(other.status).toBe(409);

  const ok = await call("POST", `/athletes/${athleteId}/onboarding/steps/greet/complete`, auth, {
    fields: { confirmed: false, corrections: [{ field: "position", value: "keeper", said: "I'm the keeper" }] },
  });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ run_id: run.id, status: "waiting", step: "greet", next: "doors", door: null });
  expect(ok.body.saved).toHaveLength(1);
  expect(ok.body.saved[0]).toMatchObject({ field: "position", value: "keeper" });

  const found = (await getRun(run.id))!;
  expect(found.steps.find((s) => s.step === "greet" && s.status === "done")!.mode).toBe("voice");
  const [row] = await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId));
  expect(row.mode).toBe("voice");
  expect(row.said).toBe("I'm the keeper");

  const done = await call("POST", `/athletes/${athleteId}/onboarding/steps/doors/complete`, auth, { fields: { door: "profile" } });
  expect(done.body).toMatchObject({ status: "done", next: "done", door: "profile" });
});
