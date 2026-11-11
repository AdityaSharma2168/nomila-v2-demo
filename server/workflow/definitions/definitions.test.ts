/**
 * definitions.test.ts — the onboarding and first_look definitions on the real runner, with
 * the network-bound skills mocked at their module boundary.
 *
 * What is pinned:
 *   onboarding v1  — research runs with the athlete's KNOWN handles (typed + connected), the
 *                    run reaches done, the generic kit cache row is invalidated.
 *                    (pinned with version: 1 — new runs start on v2, covered in server/mila/onboarding.test.ts)
 *   first_look v1  — fetch and backfill run in parallel, compute reads fetch's snapshot id,
 *                    two connects for one connection id produce ONE run, an inbox-only
 *                    connect is never a first look.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/researchAthlete", () => ({
  buildSearchName: (a: any) => (a.school ? `${a.full_name} ${a.school} ${a.sport ?? ""}` : `${a.full_name} ${a.sport ?? ""}`).trim(),
  researchAthlete: jest.fn(),
}));
jest.mock("../../skills/fetchSocialData", () => ({ fetchSocialData: jest.fn() }));
jest.mock("../../skills/mediaBackfill", () => ({ backfillAthletePlatform: jest.fn() }));
jest.mock("../../skills/enrichTopPostInsights", () => ({ enrichTopPostInsights: jest.fn(async () => ({ enriched: 0, failed: 0 })) }));
jest.mock("../../skills/firstLook", () => ({ FIRST_LOOK_POSTS: 30, runFirstLook: jest.fn() }));
// The kit builder (the paid multi-model DAG): context_ready rebuilds the generic card in the background.
jest.mock("../../services/mediaKitService", () => ({
  assembleMediaKit: jest.fn(async () => ({ identity: { name: "Rebuilt" }, cards: [], deck: [], tokens: { theme: "campaign" } })),
}));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { athleteAffiliations, athleteSnapshots, athletes, mediaKits, workflowRuns, workflowSteps } from "../../../shared/schema";
import { researchAthlete } from "../../skills/researchAthlete";
import { fetchSocialData } from "../../skills/fetchSocialData";
import { backfillAthletePlatform } from "../../skills/mediaBackfill";
import { runFirstLook } from "../../skills/firstLook";
import { configureRunner, resetRunnerConfig, startRun, getRun } from "../runner";
import { collectKnownHandles } from "./onboarding";
import { assembleMediaKit } from "../../services/mediaKitService";
import "./index"; // registers onboarding, first_look, research_refresh

const research = researchAthlete as jest.Mock;
const fetchSocial = fetchSocialData as jest.Mock;
const backfill = backfillAthletePlatform as jest.Mock;
const firstLook = runFirstLook as jest.Mock;
const buildKit = assembleMediaKit as unknown as jest.Mock;

/** Wait for the fire-and-forget background kit rebuild to land (the builder is mocked). */
async function settleKitRebuild(athleteId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select({ id: mediaKits.id }).from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, 0)));
    if (row) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("background kit rebuild never landed");
}

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Mia Bhuta");
  await db.update(athletes).set({ sport: "soccer", school: "Stanford University", socials: { instagram: "@rileyathlete", twitter: "miab" } } as any)
    .where(eq(athletes.id, athleteId));
  await seedConnection({ athleteId, platform: "tiktok", email: "mia_tt" });
});
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  jest.clearAllMocks();
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});

test("collectKnownHandles: typed handles (x stored as twitter) plus connected usernames, '@' stripped", async () => {
  const h = await collectKnownHandles(athleteId);
  expect(h).toEqual({ instagram: "rileyathlete", x: "miab", tiktok: "mia_tt" });
});

test("onboarding v1: research runs with known handles, then the generic kit is invalidated and the run is done", async () => {
  research.mockResolvedValue({ snapshotId: "snap-1" });
  await db.insert(mediaKits).values({ athlete_id: athleteId, brand_id: 0, data: {} } as any);
  await db.insert(mediaKits).values({ athlete_id: athleteId, brand_id: 141, data: {} } as any);

  const { run } = await startRun({ process: "onboarding", athleteId, createdBy: "signup", idempotencyKey: `onboarding:${athleteId}`, version: 1 });
  expect(run.status).toBe("done");
  expect(research).toHaveBeenCalledTimes(1);
  const [calledId, searchName, trigger, opts] = research.mock.calls[0];
  expect(calledId).toBe(athleteId);
  expect(searchName).toBe("Mia Bhuta Stanford University soccer");
  expect(trigger).toBe("signup");
  expect(opts.handles).toEqual({ instagram: "rileyathlete", x: "miab", tiktok: "mia_tt" });

  const { steps } = (await getRun(run.id))!;
  expect(steps.map((s) => [s.step, s.status])).toEqual([["research", "done"], ["context_ready", "done"]]);
  expect(steps[0].output).toEqual({ snapshot_id: "snap-1" });   // no legacy score in the step output (P2-4)
  expect(steps[1].output).toMatchObject({ kits_invalidated: 1 });   // the stale generic card was dropped …
  // … and rebuilt ONCE in the background, server-side (a live share never builds); the brand deck is untouched.
  await settleKitRebuild(athleteId);
  expect(buildKit).toHaveBeenCalledTimes(1);
  expect(buildKit.mock.calls[0][0]).toBe(athleteId);
  expect(buildKit.mock.calls[0][1]).toMatchObject({ brandId: undefined });
  const kits = await db.select({ brand_id: mediaKits.brand_id, data: mediaKits.data }).from(mediaKits).where(eq(mediaKits.athlete_id, athleteId));
  expect(kits.map((k) => k.brand_id).sort((a, b) => a - b)).toEqual([0, 141]);
  expect((kits.find((k) => k.brand_id === 0)!.data as any).identity.name).toBe("Rebuilt");

  // A second signup post for the same athlete returns the same run.
  const again = await startRun({ process: "onboarding", athleteId, createdBy: "signup", idempotencyKey: `onboarding:${athleteId}`, version: 1 });
  expect(again.created).toBe(false);
  expect(again.run.id).toBe(run.id);
});

test("onboarding v1: research needs a sport; without one the attempt fails loudly and a retry is scheduled", async () => {
  const bare = await seedAthlete("No Sport");
  // Real backoff here, so the queued retry is not due inside the kick loop.
  configureRunner({ retry: { randomize: false, minTimeoutMs: 60_000 } });
  const { run } = await startRun({ process: "onboarding", athleteId: bare, createdBy: "app_signup", version: 1 });
  // The research step carries its own retry policy (3 attempts), so the run stays running
  // with attempt 2 queued — the failure is recorded on the attempt, never swallowed.
  expect(run.status).toBe("running");
  const { steps } = (await getRun(run.id))!;
  expect(steps.map((s) => [s.attempt, s.status])).toEqual([[1, "failed"], [2, "ready"]]);
  expect(steps[0].error).toMatch(/Research needs a sport/);
  expect(research).not.toHaveBeenCalled();
});

test("first_look v1: fetch and backfill in parallel, compute reads the snapshot id, one run per connection", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rileyathlete" });
  fetchSocial.mockImplementation(async () => {
    await db.insert(athleteSnapshots).values({ athlete_id: athleteId, trigger: "social_connect", social: { instagram: { followers: 22177 } } } as any);
  });
  backfill.mockResolvedValue({ platform: "instagram", ingested: 30, done: false });
  firstLook.mockImplementation(async (o: any) => ({ snapshot_id: o.snapshotId, posts_read: 30, themes: 4 }));

  const input = { connectionId, platform: "instagram" };
  const { run, created } = await startRun({ process: "first_look", athleteId, createdBy: "connect", input, idempotencyKey: `connect:${connectionId}` });
  expect(created).toBe(true);
  expect(run.status).toBe("done");
  expect(fetchSocial).toHaveBeenCalledWith(athleteId, "instagram", connectionId);
  expect(backfill).toHaveBeenCalledWith(athleteId, "instagram", 30);

  const { steps } = (await getRun(run.id))!;
  const byName = Object.fromEntries(steps.map((s) => [s.step, s]));
  expect(byName.fetch_social.ordinal).toBe(0);
  expect(byName.backfill_recent.ordinal).toBe(0);       // parallel sibling
  expect(byName.compute_first_look.ordinal).toBe(1);
  const snapId = (byName.fetch_social.output as any).snapshot_id;
  expect(firstLook).toHaveBeenCalledWith({ athleteId, platform: "instagram", snapshotId: snapId });
  expect(byName.compute_first_look.output).toEqual({ snapshot_id: snapId, posts_read: 30, themes: 4 });

  const dup = await startRun({ process: "first_look", athleteId, createdBy: "connect", input, idempotencyKey: `connect:${connectionId}` });
  expect(dup.created).toBe(false);
  expect(dup.run.id).toBe(run.id);
});

test("first_look v1: when the fetch produces no fresh snapshot the step fails and the run reports it", async () => {
  fetchSocial.mockResolvedValue(undefined);          // token expired: fetchSocialData returns without writing
  backfill.mockResolvedValue({ platform: "tiktok", ingested: 0, done: true, skipped: "no-connection" });
  const { run } = await startRun({ process: "first_look", athleteId, createdBy: "connect", input: { connectionId: "c-2", platform: "tiktok" } });
  expect(run.status).toBe("failed");
  expect(run.last_error).toMatch(/fetch_social: fetchSocialData produced no new social_connect snapshot for tiktok/);
  expect(firstLook).not.toHaveBeenCalled();
});

test("first_look v1: rejects an inbox platform as input", async () => {
  const { run } = await startRun({ process: "first_look", athleteId, createdBy: "connect", input: { connectionId: "c-3", platform: "gmail" } });
  expect(run.status).toBe("failed");
  expect(run.last_error).toMatch(/first_look needs/);
});

// ─── The research step's search inputs and freshness gate ───

describe("onboarding research step: the projection anchor", () => {
  const env = process.env;
  afterEach(() => { process.env = env; });

  test("the projection anchor with no team option", async () => {
    research.mockResolvedValue({ snapshotId: "snap-2d5b" });
    process.env = { ...env };
    await startRun({ process: "onboarding", athleteId, createdBy: "signup", idempotencyKey: `onboarding-2d5c:${athleteId}`, version: 1 });
    const [, searchName, , opts] = research.mock.calls[0];
    expect(searchName).toBe("Mia Bhuta Stanford University soccer");
    expect(opts).toEqual({ handles: { instagram: "rileyathlete", x: "miab", tiktok: "mia_tt" } });
  });

  test("the v2 freshness gate trusts created_at", async () => {
    const fresh = await seedAthlete("Gate Athlete");
    await db.update(athletes).set({ sport: "soccer" } as any).where(eq(athletes.id, fresh));
    await db.insert(athleteSnapshots).values({ athlete_id: fresh, trigger: "scheduled_refresh", research: { achievements: [] }, created_at: new Date(), as_of: null } as any);
    research.mockResolvedValue({ snapshotId: "snap-gate" });
    process.env = { ...env };
    await startRun({ process: "onboarding", athleteId: fresh, createdBy: "test", idempotencyKey: `gate-unlisted:${fresh}`, version: 2 });
    expect(research).not.toHaveBeenCalled();                                            // created_at is recent ⇒ skipped
  });
});
