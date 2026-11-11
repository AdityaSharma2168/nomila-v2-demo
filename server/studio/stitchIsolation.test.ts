/**
 * stitchIsolation.test.ts — the two revert checks that prove the TABLE DECISION rather than restate it.
 *
 * 0057 puts stitch jobs in their own table. The argument for that was not tidiness; it was two
 * specific queries in the money path that carry NO discriminator:
 *
 *   1. studio/videoJobs.ts claimVideoJobs — `WHERE status = 'queued'` over generation_jobs and
 *      nothing else. A queued stitch row in THAT table is claimed by the VIDEO runner and handed to
 *      submitVideoOperation: a paid Vertex call for a job that has no brief to send.
 *   2. studio/jobs.ts spentTodayUsd — sums generation_jobs.cost_estimated_usd for the athlete over
 *      24h, filtered only on `status <> 'canceled'`. A $0 row in the money table is one careless
 *      DEFAULT away from moving the figure the day ceiling is compared against.
 *
 * ─── THESE DRIVE THE REAL QUERIES ───────────────────────────────────────────────────────────────
 *
 * Both functions are IMPORTED AND CALLED, not re-typed here. A test that re-implements the claim
 * would go on passing after someone edited the real one, which is the failure mode this file exists
 * to prevent. PGlite is real Postgres, so SKIP LOCKED, the partial indexes and both status CHECKs
 * are real.
 *
 * ─── THE MUTATION EACH ONE REDS UNDER ───────────────────────────────────────────────────────────
 *
 * Named here because "unchanged" is a weak assertion on its own — a test asserting the spend figure
 * did not move would ALSO pass if stitch rows lived in generation_jobs with a NULL cost, since SQL
 * SUM ignores NULLs. So the mutation that discriminates is not "delete a guard", it is
 * REVERSING THE TABLE DECISION:
 *
 *   * `seedStitchInItsOwnTable` → insert into generation_jobs instead (with a cost, for the spend
 *     test). Then claimVideoJobs returns the row and spentTodayUsd moves by that cost.
 *
 * Both were run as mutations and both went red before this file was committed green.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import {
  athletes,
  generationJobs,
  studioGenerationPreviews,
  studioStitchJobs,
} from "../../shared/schema";
import { claimVideoJobs } from "./videoJobs";
import { spentTodayUsd } from "./jobs";

const ATHLETE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ATHLETE_ID = "55555555-5555-4555-8555-555555555555";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Stitch Isolation Athlete" },
    { id: OTHER_ATHLETE_ID, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(studioStitchJobs);
  await db.delete(studioGenerationPreviews);
  await db.delete(generationJobs);
});

/** A stitch, in the table 0057 created. The spec carries ASSET IDS — never paths. */
async function seedStitchInItsOwnTable(status = "queued"): Promise<string> {
  const [row] = await db
    .insert(studioStitchJobs)
    .values({
      athlete_id: ATHLETE_ID,
      spec: {
        clips: [{ assetId: "66666666-6666-4666-8666-666666666666" }],
        target: { width: 1080, height: 1920, fps: 30 },
      },
      status,
    } as never)
    .returning({ id: studioStitchJobs.id });
  return row.id;
}

/** A real video job, so the claim has something it IS supposed to pick up. */
async function seedVideoJob(status = "queued"): Promise<string> {
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: ATHLETE_ID,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "clip",
      brief: { job: { mode: "generate" } },
      status,
      provider: "vertex",
      model: "veo-3.1-generate-001",
      cost_estimated_usd: "1.60",
      cost_basis: "estimated",
    } as never)
    .returning({ id: generationJobs.id });
  return row.id;
}

describe("a stitch job is invisible to the video claim", () => {
  /**
   * THE REVERT CHECK. MUTATION: seed the stitch into generation_jobs instead — the shared-table
   * design — and this goes red, because claimVideoJobs picks it up and the runner would submit it
   * to Vertex.
   */
  it("claimVideoJobs claims nothing when the only queued work is a stitch", async () => {
    await seedStitchInItsOwnTable("queued");

    const claimed = await claimVideoJobs(10, "runner-under-test");

    expect(claimed).toEqual([]);
  });

  it("leaves the stitch untouched — still queued, never leased, attempts still 0", async () => {
    const id = await seedStitchInItsOwnTable("queued");

    await claimVideoJobs(10, "runner-under-test");

    const [row] = await db
      .select()
      .from(studioStitchJobs)
      .where(eq(studioStitchJobs.id, id));
    expect(row.status).toBe("queued");
    expect(row.lease_holder).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.attempts).toBe(0);
  });

  /**
   * The other half, and the reason the first test is not vacuous: the claim still does its job.
   * A claim that returned nothing because it was broken would pass the test above.
   */
  it("still claims a real video job sitting beside it", async () => {
    await seedStitchInItsOwnTable("queued");
    const videoId = await seedVideoJob("queued");

    const claimed = await claimVideoJobs(10, "runner-under-test");

    expect(claimed.map((j) => j.id)).toEqual([videoId]);
  });
});

describe("a stitch job cannot move the spend figure", () => {
  /**
   * THE REVERT CHECK. MUTATION: seed the stitch into generation_jobs with
   * `cost_estimated_usd: "1.60"` and this goes red — the figure moves to 1.6 while no money was
   * ever spent. Note what the mutation has to include: a stitch row in generation_jobs with a NULL
   * cost would NOT move the sum (SQL SUM ignores NULLs), so "unchanged" alone would not have
   * discriminated. The hazard being pinned is a $0 row in the money table acquiring a cost.
   */
  it("spentTodayUsd is 0 when the athlete's only work today is a stitch", async () => {
    await seedStitchInItsOwnTable("queued");

    expect(await spentTodayUsd(ATHLETE_ID)).toBe(0);
  });

  it("reports exactly the video spend when both exist — the stitch adds nothing", async () => {
    await seedVideoJob("succeeded");
    await seedStitchInItsOwnTable("succeeded");

    expect(await spentTodayUsd(ATHLETE_ID)).toBe(1.6);
  });

  it("is athlete-scoped, as it was before 0057", async () => {
    await seedVideoJob("succeeded");
    await seedStitchInItsOwnTable("succeeded");

    expect(await spentTodayUsd(OTHER_ATHLETE_ID)).toBe(0);
  });
});

describe("the two tables do not share a queue", () => {
  /**
   * The inverse of the claim test: a queued VIDEO job must not be picked up by anything looking for
   * stitches. There is no stitch claim yet — that is layer 3 — so what is pinned here is the fact
   * the claim will rest on: the row simply is not in the table.
   */
  it("a queued video job does not appear in studio_stitch_jobs", async () => {
    await seedVideoJob("queued");

    const rows = await db.select().from(studioStitchJobs);

    expect(rows).toEqual([]);
  });

  it("a queued stitch job does not appear in generation_jobs", async () => {
    await seedStitchInItsOwnTable("queued");

    const rows = await db.select().from(generationJobs);

    expect(rows).toEqual([]);
  });
});
