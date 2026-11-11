/**
 * stitchJobs.test.ts — the lease, and the one place this queue deliberately disagrees with the
 * video one.
 *
 * PGlite, so SKIP LOCKED, the partial indexes and 0057's status CHECK are real Postgres. The
 * property this file exists to defend is NEGATIVE and therefore easy to lose to a well-meaning
 * edit:
 *
 *   ⚠️  A LAPSED STITCH GOES BACK TO `queued`. IT IS NEVER FAILED CLOSED.
 *
 * videoJobs.ts fails a lapsed job that died inside a provider submit, because that submit may have
 * been paid for and re-running it could charge twice. A stitch has no provider and no charge, so
 * copying that arm here would convert a dead instance into a refusal she has to notice and redo,
 * protecting money that was never at risk. The test below is written to RED if the orphan arm is
 * ever ported across.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, studioStitchJobs } from "../../shared/schema";
import {
  claimStitchJobs,
  failStitch,
  leaseMs,
  maxAttempts,
  queueStitch,
  readStitchJob,
  reapExpiredStitchLeases,
  renewStitchLease,
  stitchTimeoutMs,
  succeedStitch,
  transferTimeoutMs,
} from "./stitchJobs";

const ATHLETE_ID = "11111111-3333-4333-8444-555555555555";
const OTHER_ID = "22222222-3333-4333-8444-555555555555";

const SPEC = {
  clips: [{ assetId: "33333333-3333-4333-8444-555555555555" }],
  target: "portrait",
};

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Stitch Lease Athlete" },
    { id: OTHER_ID, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(studioStitchJobs);
});

const read = async (id: string) =>
  (
    await db.select().from(studioStitchJobs).where(eq(studioStitchJobs.id, id))
  )[0];

/** Force a lease into the past without waiting for it — the instance-died simulation. */
const expireLease = (id: string) =>
  db
    .update(studioStitchJobs)
    .set({ lease_until: new Date(Date.now() - 1000) })
    .where(eq(studioStitchJobs.id, id));

// ─── 1. Queue ───────────────────────────────────────────────────────────────────────────────────

describe("queueStitch", () => {
  it("is born queued, not pending — there is no inline path for a stitch", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    const row = await read(id);
    expect(row.status).toBe("queued");
    expect(row.athlete_id).toBe(ATHLETE_ID);
    expect(row.attempts).toBe(0);
    expect(row.output_asset_id).toBeNull();
    expect(row.spec).toEqual(SPEC);
  });

  it("refuses a status 0057's CHECK does not permit", async () => {
    // 'pending' is the video table's state and is deliberately absent here. The DB is the guard.
    await expect(
      db
        .insert(studioStitchJobs)
        .values({
          athlete_id: ATHLETE_ID,
          spec: SPEC,
          status: "pending",
        } as never),
    ).rejects.toThrow();
  });
});

// ─── 2. Claim ───────────────────────────────────────────────────────────────────────────────────

describe("claimStitchJobs", () => {
  it("moves a queued job to running under a lease and counts the attempt", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    const [claimed] = await claimStitchJobs(1, "instance-a");

    expect(claimed.id).toBe(id);
    const row = await read(id);
    expect(row.status).toBe("running");
    expect(row.lease_holder).toBe("instance-a");
    expect(row.attempts).toBe(1);
    expect(row.started_at).not.toBeNull();
    expect(row.lease_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives one job to exactly one of two runners", async () => {
    // As videoJobs.test.ts says of its own version: PGlite is single-connection, so this asserts
    // the `status = 'queued'` predicate rather than the row lock. SKIP LOCKED is pinned
    // structurally at the end of this block, and that limit is stated rather than papered over.
    const id = await queueStitch(ATHLETE_ID, SPEC);
    const [a, b] = await Promise.all([
      claimStitchJobs(10, "instance-a"),
      claimStitchJobs(10, "instance-b"),
    ]);
    expect([...a, ...b].map((j) => j.id)).toEqual([id]);
  });

  it("claims nothing when asked for nothing — the capacity guard's zero case", async () => {
    await queueStitch(ATHLETE_ID, SPEC);
    expect(await claimStitchJobs(0, "instance-a")).toEqual([]);
    // And the row is untouched, not merely unreturned.
    const [row] = await db.select().from(studioStitchJobs);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
  });

  it("never claims a job that is already running", async () => {
    await queueStitch(ATHLETE_ID, SPEC);
    expect(await claimStitchJobs(10, "instance-a")).toHaveLength(1);
    expect(await claimStitchJobs(10, "instance-b")).toHaveLength(0);
  });

  it("still contains SKIP LOCKED", () => {
    // Structural, and honest about being so: PGlite cannot exercise a genuine row-lock race.
    const src = require("fs").readFileSync(
      require.resolve("./stitchJobs.ts"),
      "utf8",
    );
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
});

// ─── 3. The lease ───────────────────────────────────────────────────────────────────────────────

describe("the lease", () => {
  it("outlasts the work it covers — ffmpeg plus both transfer phases", () => {
    // The ordering that stops the reaper racing a runner that is merely slow. DERIVED, so raising
    // any one budget cannot silently invalidate it.
    expect(leaseMs()).toBeGreaterThanOrEqual(
      stitchTimeoutMs() + 2 * transferTimeoutMs(),
    );
  });

  it("renews only for the holder", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    expect(await renewStitchLease(id, "instance-b")).toBe(false);
    expect(await renewStitchLease(id, "instance-a")).toBe(true);
  });

  it("will not let a runner close a job it no longer holds", async () => {
    // The reaper took this job back and instance-b has it now. instance-a finishing late must not
    // overwrite the outcome — in either direction.
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    await expireLease(id);
    await reapExpiredStitchLeases();
    await claimStitchJobs(1, "instance-b");

    expect(await succeedStitch(id, "instance-a", ATHLETE_ID)).toBe(false);
    expect(await failStitch(id, "instance-a", "late")).toBe(false);
    expect((await read(id)).status).toBe("running");
    expect((await read(id)).lease_holder).toBe("instance-b");
  });
});

// ─── 4. The reaper — the negative property ──────────────────────────────────────────────────────

describe("reapExpiredStitchLeases", () => {
  it("returns a lapsed job to the QUEUE and never fails it", async () => {
    // ⚠️  THE REVERT CHECK FOR THIS LAYER. Porting videoJobs.ts's orphan arm across — failing a
    // lapsed job because its instance died mid-run — reds here. At $0 there is nothing to protect
    // by failing closed, and the cost of doing it is a refusal she has to notice and redo.
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    await expireLease(id);

    const out = await reapExpiredStitchLeases();
    expect(out).toEqual({ exhausted: 0, requeued: 1 });

    const row = await read(id);
    expect(row.status).toBe("queued");
    expect(row.last_error).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.lease_holder).toBeNull();
    expect(row.lease_until).toBeNull();
  });

  it("requeues a job that got all the way to ffmpeg, with its attempt kept", async () => {
    // "Died mid-encode" is exactly the state the video reaper treats as dangerous. Here it is
    // ordinary: the work is repeatable and free, so it goes back.
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    await db
      .update(studioStitchJobs)
      .set({ started_at: new Date(Date.now() - 60_000) })
      .where(eq(studioStitchJobs.id, id));
    await expireLease(id);

    await reapExpiredStitchLeases();
    const row = await read(id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1); // counted, so the loop is still bounded
  });

  it("gives up on a job that has burned its attempts", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    for (let i = 0; i < maxAttempts(); i++) {
      await claimStitchJobs(1, `instance-${i}`);
      await expireLease(id);
      if (i < maxAttempts() - 1) await reapExpiredStitchLeases();
    }
    const out = await reapExpiredStitchLeases();

    expect(out.exhausted).toBe(1);
    expect(out.requeued).toBe(0);
    const row = await read(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/couldn't finish it/i);
    expect(row.completed_at).not.toBeNull();
  });

  it("gives up BEFORE handing out again — the order is the policy", async () => {
    // Reversing the two arms would hand an instance-killing timeline back to the fleet forever.
    const src = require("fs").readFileSync(
      require.resolve("./stitchJobs.ts"),
      "utf8",
    );
    expect(src.indexOf("1. EXHAUSTED")).toBeLessThan(src.indexOf("2. HANDOFF"));
  });

  it("leaves a live lease alone", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    expect(await reapExpiredStitchLeases()).toEqual({
      exhausted: 0,
      requeued: 0,
    });
    expect((await read(id)).status).toBe("running");
  });
});

// ─── 5. Closing ─────────────────────────────────────────────────────────────────────────────────

describe("closing a stitch", () => {
  it("records the output asset and releases the lease", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    // A real media_assets row is not needed to prove the lease half; the FK is proven in the
    // runner's suite, which publishes one.
    expect(await succeedStitch(id, "instance-a", null as never)).toBe(true);

    const row = await read(id);
    expect(row.status).toBe("succeeded");
    expect(row.lease_until).toBeNull();
    expect(row.lease_holder).toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it("writes a readable refusal, and the reaper then ignores the row", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    await claimStitchJobs(1, "instance-a");
    await failStitch(id, "instance-a", "A timeline can hold up to 12 clips");

    expect((await read(id)).last_error).toMatch(/12 clips/);
    await expireLease(id); // a terminal row with a stale lease must still be left alone
    expect(await reapExpiredStitchLeases()).toEqual({
      exhausted: 0,
      requeued: 0,
    });
  });
});

// ─── 6. Tenancy on the read ─────────────────────────────────────────────────────────────────────

describe("readStitchJob", () => {
  it("answers null for another athlete's stitch — not-yours is not-found", async () => {
    const id = await queueStitch(ATHLETE_ID, SPEC);
    expect(await readStitchJob(ATHLETE_ID, id)).not.toBeNull();
    expect(await readStitchJob(OTHER_ID, id)).toBeNull();
  });

  it("answers null for a stitch that does not exist — the same answer, by the same route", async () => {
    expect(
      await readStitchJob(ATHLETE_ID, "99999999-9999-4999-8999-999999999999"),
    ).toBeNull();
  });
});
