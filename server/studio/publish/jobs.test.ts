/**
 * jobs.test.ts — the publish queue against real SQL (PGlite), never Cloud SQL.
 *
 * THE CLAIM UNDER TEST: Instagram's publish can be called AT MOST ONCE PER ROW, EVER — and that is
 * held by one compare-and-set, `recordPublishAttempt`, not by the order a runner does things in.
 *
 * REVERT CHECKS — each reds BY NAME when the clause it guards is taken out of jobs.ts:
 *
 *   RC-1  drop `publish_attempted_at IS NULL`   → "returns true ONCE in the life of a row…"
 *                                                 and "a requeued orphan can never be published again"
 *   RC-2  drop `mode = 'live'`                  → "a DRY row can never be marked for sending…"
 *   RC-3  drop `container_id IS NOT NULL`       → "refuses when there is no container to publish"
 *   RC-4  drop `ig_media_id IS NULL` (attempt)  → "refuses once a post exists"
 *   RC-5  drop `ig_media_id IS NULL` (handle)   → "the media id is written once and never replaced"
 *   RC-6  remove the reaper's UNCONFIRMED arm   → "an attempted job that is given up on is told it MAY HAVE POSTED…"
 *   RC-7  reaper handoff clears the attempt     → "a requeued orphan can never be published again"
 *   RC-8  releaseForPoll drops container_id     → "hands the job back for the next tick and KEEPS the container"
 *   RC-9  recordContainer unguarded             → "remembers the container once…"
 *   RC-10 queuePublish rethrows the 23505       → "a second tap while the first is live joins it…"
 *   RC-11 readPublishJob without athlete_id     → "another athlete's job id is 'no such job'…"
 *
 * All rows are synthetic.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athletes,
  connectedAccounts,
  mediaAssets,
  studioPublishJobs,
} from "../../../shared/schema";
import { maxAttempts } from "./config";
import {
  MAY_HAVE_POSTED,
  claimPublishJobs,
  failPublish,
  queuePublish,
  readLatestPublishForAsset,
  readPublishJob,
  reapExpiredPublishLeases,
  recordContainer,
  recordMediaId,
  recordPublishAttempt,
  releaseForPoll,
  succeedPublish,
  type QueuePublishInput,
} from "./jobs";

const ATHLETE = "11111111-5555-4555-8555-555555555555";
const OTHER = "22222222-5555-4555-8555-555555555555";

let ASSET = "";
let ASSET_2 = "";
let ACCOUNT = "";

const A = "instance-a";
const B = "instance-b";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: ATHLETE, full_name: "Publish Queue Athlete" },
    { id: OTHER, full_name: "Another Athlete" },
  ] as never);
  const asset = (path: string) =>
    db
      .insert(mediaAssets)
      .values({
        athlete_id: ATHLETE,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: path,
      } as never)
      .returning({ id: mediaAssets.id });
  ASSET = (await asset("synthetic/one.mp4"))[0].id;
  ASSET_2 = (await asset("synthetic/two.mp4"))[0].id;
  ACCOUNT = (
    await db
      .insert(connectedAccounts)
      .values({
        athlete_id: ATHLETE,
        platform: "instagram",
        status: "active",
        platform_username: "synthetic_handle",
      } as never)
      .returning({ id: connectedAccounts.id })
  )[0].id;
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(studioPublishJobs);
});

const input = (over: Partial<QueuePublishInput> = {}): QueuePublishInput => ({
  athleteId: ATHLETE,
  assetId: ASSET,
  connectedAccountId: ACCOUNT,
  platform: "instagram",
  caption: "a synthetic caption",
  mode: "live",
  ...over,
});

const read = async (id: string) =>
  (
    await db
      .select()
      .from(studioPublishJobs)
      .where(eq(studioPublishJobs.id, id))
  )[0];

/** Force a lease into the past without waiting for it — the instance-died simulation. */
const expireLease = (id: string) =>
  db
    .update(studioPublishJobs)
    .set({ lease_until: new Date(Date.now() - 1000) })
    .where(eq(studioPublishJobs.id, id));

const setAttempts = (id: string, n: number) =>
  db
    .update(studioPublishJobs)
    .set({ attempts: n })
    .where(eq(studioPublishJobs.id, id));

/** Queue → claim by `holder` → container recorded. The state just before a publish. */
async function readyToPublish(
  holder = A,
  over: Partial<QueuePublishInput> = {},
) {
  const { id } = await queuePublish(input(over));
  await claimPublishJobs(1, holder);
  expect(await recordContainer(id, holder, "container-1")).toBe(true);
  return id;
}

/** The instance holding `id` dies; the reaper runs; `next` picks the job up. */
async function dieAndHandOff(id: string, next: string) {
  await expireLease(id);
  await reapExpiredPublishLeases();
  const [claimed] = await claimPublishJobs(1, next);
  expect(claimed?.id).toBe(id);
  return claimed;
}

// ─── 1. Queue ───────────────────────────────────────────────────────────────────────────────────

describe("queuePublish", () => {
  it("is born queued with the account, the caption and the mode FROZEN, and nothing attempted", async () => {
    const out = await queuePublish(input({ mode: "dry" }));
    expect(out.alreadyLive).toBe(false);
    const row = await read(out.id);
    expect(row).toMatchObject({
      athlete_id: ATHLETE,
      asset_id: ASSET,
      connected_account_id: ACCOUNT,
      platform: "instagram",
      caption: "a synthetic caption",
      mode: "dry",
      status: "queued",
      attempts: 0,
      poll_count: 0,
      container_id: null,
      publish_attempted_at: null,
      ig_media_id: null,
    });
  });

  /** RC-10. Two taps are one post, and the second tap gets the first tap's job — not an error. */
  it("a second tap while the first is live joins it — one row, the same id", async () => {
    const first = await queuePublish(input());
    const second = await queuePublish(
      input({ caption: "a different caption, tapped twice" }),
    );
    expect(second).toEqual({ id: first.id, alreadyLive: true });
    expect(await db.select().from(studioPublishJobs)).toHaveLength(1);
    // The job that runs is the one she confirmed FIRST. The second tap changes nothing about it.
    expect((await read(first.id)).caption).toBe("a synthetic caption");
  });

  it("a second tap while the first is RUNNING joins it too — mid-upload is when it matters", async () => {
    const first = await queuePublish(input());
    await claimPublishJobs(1, A);
    expect(await queuePublish(input())).toEqual({
      id: first.id,
      alreadyLive: true,
    });
  });

  it("a finished job does not hold the slot — her retry is a new row and a new decision", async () => {
    const first = await queuePublish(input());
    await claimPublishJobs(1, A);
    await failPublish(
      first.id,
      A,
      "transient",
      "Instagram had a problem on its side.",
    );
    const second = await queuePublish(input());
    expect(second.alreadyLive).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  it("a different video is not a double tap", async () => {
    const a = await queuePublish(input());
    const b = await queuePublish(input({ assetId: ASSET_2 }));
    expect(b).toEqual({
      id: expect.not.stringMatching(a.id),
      alreadyLive: false,
    });
  });
});

// ─── 2. Claim ───────────────────────────────────────────────────────────────────────────────────

describe("claimPublishJobs", () => {
  it("moves a queued job to running under a lease and counts the attempt", async () => {
    const { id } = await queuePublish(input());
    const [claimed] = await claimPublishJobs(1, A);
    expect(claimed.id).toBe(id);
    const row = await read(id);
    expect(row.status).toBe("running");
    expect(row.lease_holder).toBe(A);
    expect(row.attempts).toBe(1);
    expect(row.lease_until!.getTime()).toBeGreaterThan(Date.now());
    expect(row.started_at).not.toBeNull();
  });

  it("hands a job to ONE runner — the second claim finds nothing", async () => {
    await queuePublish(input());
    expect(await claimPublishJobs(5, A)).toHaveLength(1);
    expect(await claimPublishJobs(5, B)).toHaveLength(0);
  });

  it("claims nothing for a limit of zero, and oldest first", async () => {
    const a = await queuePublish(input());
    await db
      .update(studioPublishJobs)
      .set({ created_at: new Date(Date.now() - 60_000) })
      .where(eq(studioPublishJobs.id, a.id));
    await queuePublish(input({ assetId: ASSET_2 }));
    expect(await claimPublishJobs(0, A)).toEqual([]);
    expect((await claimPublishJobs(1, A))[0].id).toBe(a.id);
  });
});

// ─── 3. The container ───────────────────────────────────────────────────────────────────────────

describe("the container is a resume handle", () => {
  /** RC-9. The container a job is waiting on is the one a later publish will name. */
  it("remembers the container once — a second one cannot replace it", async () => {
    const id = await readyToPublish();
    expect(await recordContainer(id, A, "container-2")).toBe(false);
    const row = await read(id);
    expect(row.container_id).toBe("container-1");
    expect(row.container_created_at).not.toBeNull();
  });

  it("only the runner holding the job may record one", async () => {
    const { id } = await queuePublish(input());
    await claimPublishJobs(1, A);
    expect(await recordContainer(id, B, "container-b")).toBe(false);
    expect((await read(id)).container_id).toBeNull();
  });

  /** RC-8. */
  it("hands the job back for the next tick and KEEPS the container", async () => {
    const id = await readyToPublish();
    expect(await releaseForPoll(id, A)).toBe(1);
    const row = await read(id);
    expect(row).toMatchObject({
      status: "queued",
      container_id: "container-1",
      poll_count: 1,
      lease_holder: null,
      lease_until: null,
    });
    // Waiting for Instagram is not a lapse: the claim's attempt is given back.
    expect(row.attempts).toBe(0);

    const [again] = await claimPublishJobs(1, B);
    expect(again.container_id).toBe("container-1");
    expect(await releaseForPoll(id, B)).toBe(2);
    expect((await read(id)).attempts).toBe(0);
  });

  it("a runner that lost the job cannot hand it back", async () => {
    const id = await readyToPublish();
    expect(await releaseForPoll(id, B)).toBeNull();
    expect((await read(id)).status).toBe("running");
  });
});

// ─── 4. THE SUBMIT-ONCE PAIR ────────────────────────────────────────────────────────────────────

describe("recordPublishAttempt — the one write that lets a publish happen", () => {
  /** RC-1. */
  it("returns true ONCE in the life of a row, and false for ever after", async () => {
    const id = await readyToPublish();
    expect(await recordPublishAttempt(id, A)).toBe(true);
    expect(await recordPublishAttempt(id, A)).toBe(false);
    expect(await recordPublishAttempt(id, A)).toBe(false);
    expect((await read(id)).publish_attempted_at).not.toBeNull();
  });

  /**
   * RC-1 and RC-7 — THE TEST THIS WHOLE TABLE EXISTS FOR. The instance dies after asking Instagram
   * to publish and before learning the answer. The reaper hands the job to another runner. That
   * runner — however it is written — cannot be given permission to publish.
   */
  it("a requeued orphan can never be published again", async () => {
    const id = await readyToPublish(A);
    expect(await recordPublishAttempt(id, A)).toBe(true);
    // …instance A dies here, mid-call. No media id was ever written.

    const claimed = await dieAndHandOff(id, B);
    expect(claimed.publish_attempted_at).not.toBeNull(); // the mark SURVIVED the handoff
    expect(claimed.container_id).toBe("container-1");
    expect(claimed.ig_media_id).toBeNull();

    expect(await recordPublishAttempt(id, B)).toBe(false);

    // And again, for as many handoffs as there are attempts left.
    await dieAndHandOff(id, A);
    expect(await recordPublishAttempt(id, A)).toBe(false);
  });

  /** RC-2. The second of the two keys, held in SQL: the process saying "live" is not enough. */
  it("a DRY row can never be marked for sending, whatever the process says", async () => {
    const id = await readyToPublish(A, { mode: "dry" });
    expect(await recordPublishAttempt(id, A)).toBe(false);
    expect((await read(id)).publish_attempted_at).toBeNull();
  });

  /** RC-3. */
  it("refuses when there is no container to publish", async () => {
    const { id } = await queuePublish(input());
    await claimPublishJobs(1, A);
    expect(await recordPublishAttempt(id, A)).toBe(false);
  });

  /** RC-4. A row can reach here with a media id and no attempt mark only by a bug — refuse anyway. */
  it("refuses once a post exists", async () => {
    const id = await readyToPublish();
    await recordMediaId(id, "media-1");
    expect(await recordPublishAttempt(id, A)).toBe(false);
  });

  it("refuses a runner that does not hold the job, and a job that is not running", async () => {
    const id = await readyToPublish(A);
    expect(await recordPublishAttempt(id, B)).toBe(false);
    await failPublish(id, A, "transient", "x");
    expect(await recordPublishAttempt(id, A)).toBe(false);
    expect((await read(id)).publish_attempted_at).toBeNull();
  });
});

describe("recordMediaId — the post exists; remember it", () => {
  /** RC-5. */
  it("the media id is written once and never replaced", async () => {
    const id = await readyToPublish();
    expect(await recordMediaId(id, "media-1")).toBe(true);
    expect(await recordMediaId(id, "media-2")).toBe(false);
    expect((await read(id)).ig_media_id).toBe("media-1");
  });

  /** The one write that is deliberately NOT holder-guarded. A lost lease is no reason to forget a real post. */
  it("is written even after the lease was lost and the job handed to someone else", async () => {
    const id = await readyToPublish(A);
    await recordPublishAttempt(id, A);
    await dieAndHandOff(id, B); // A is slow, not dead: its publish call is about to return
    expect(await recordMediaId(id, "media-1")).toBe(true);
    expect((await read(id)).ig_media_id).toBe("media-1");
  });
});

// ─── 5. Closing ─────────────────────────────────────────────────────────────────────────────────

describe("succeedPublish / failPublish", () => {
  it("succeed stores the permalink, clears the lease and frees the slot", async () => {
    const id = await readyToPublish();
    expect(await succeedPublish(id, A, "https://example.test/reel/1")).toBe(
      true,
    );
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      permalink: "https://example.test/reel/1",
      lease_holder: null,
      lease_until: null,
      last_error: null,
      error_code: null,
    });
    expect((await queuePublish(input())).alreadyLive).toBe(false);
  });

  it("succeed accepts a post with no permalink — a recovered orphan has none", async () => {
    const id = await readyToPublish();
    expect(await succeedPublish(id, A, null)).toBe(true);
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      permalink: null,
    });
  });

  it("fail stores a sentence AND a closed code, so the client can offer the right next step", async () => {
    const id = await readyToPublish();
    expect(
      await failPublish(
        id,
        A,
        "reconnect",
        "Reconnect Instagram to allow posting.",
      ),
    ).toBe(true);
    expect(await read(id)).toMatchObject({
      status: "failed",
      error_code: "reconnect",
      last_error: "Reconnect Instagram to allow posting.",
      lease_holder: null,
    });
  });

  it("a runner that lost the lease cannot close the job under its new owner", async () => {
    const id = await readyToPublish(A);
    await dieAndHandOff(id, B);
    expect(await succeedPublish(id, A, "https://example.test/x")).toBe(false);
    expect(await failPublish(id, A, "transient", "x")).toBe(false);
    expect(await read(id)).toMatchObject({
      status: "running",
      lease_holder: B,
    });
  });
});

// ─── 6. The reaper ──────────────────────────────────────────────────────────────────────────────

describe("reapExpiredPublishLeases", () => {
  it("leaves a live lease alone", async () => {
    const id = await readyToPublish();
    expect(await reapExpiredPublishLeases()).toEqual({
      unconfirmed: 0,
      posted: 0,
      exhausted: 0,
      requeued: 0,
    });
    expect((await read(id)).status).toBe("running");
  });

  it("hands a lapsed job back with its container, so the next runner resumes instead of starting again", async () => {
    const id = await readyToPublish();
    await expireLease(id);
    expect(await reapExpiredPublishLeases()).toMatchObject({ requeued: 1 });
    expect(await read(id)).toMatchObject({
      status: "queued",
      container_id: "container-1",
      lease_holder: null,
      attempts: 1,
    });
  });

  /**
   * RC-6. THE REAPER MUST NOT LIE. A publish call went out for this row and nobody learned the
   * answer; telling her "nothing was posted" invites exactly the second post this table exists to
   * prevent — made by her own hand, on our word.
   */
  it("an attempted job that is given up on is told it MAY HAVE POSTED, never that nothing was", async () => {
    const id = await readyToPublish();
    await recordPublishAttempt(id, A);
    await setAttempts(id, maxAttempts());
    await expireLease(id);

    expect(await reapExpiredPublishLeases()).toEqual({
      unconfirmed: 1,
      posted: 0,
      exhausted: 0,
      requeued: 0,
    });
    const row = await read(id);
    expect(row).toMatchObject({
      status: "failed",
      error_code: "may_have_posted",
      last_error: MAY_HAVE_POSTED,
    });
    expect(row.last_error).toMatch(/may have posted/i);
    expect(row.last_error).toMatch(/check Instagram/i);
    expect(row.last_error).not.toMatch(/nothing was posted/i);
  });

  it("a given-up job that carries a media id is SUCCEEDED — the post is real whatever else was lost", async () => {
    const id = await readyToPublish();
    await recordPublishAttempt(id, A);
    await recordMediaId(id, "media-1");
    await setAttempts(id, maxAttempts());
    await expireLease(id);

    expect(await reapExpiredPublishLeases()).toMatchObject({
      posted: 1,
      unconfirmed: 0,
    });
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      ig_media_id: "media-1",
      error_code: null,
    });
  });

  it("a job given up on BEFORE anything was sent says so — and only then", async () => {
    const id = await readyToPublish();
    await setAttempts(id, maxAttempts());
    await expireLease(id);

    expect(await reapExpiredPublishLeases()).toMatchObject({
      exhausted: 1,
      unconfirmed: 0,
    });
    const row = await read(id);
    expect(row).toMatchObject({ status: "failed", error_code: "gave_up" });
    expect(row.last_error).toMatch(/nothing was posted/i);
    expect(row.publish_attempted_at).toBeNull();
  });

  it("sorts a mixed queue in one pass — every row gets the arm that is true of it", async () => {
    const orphan = await readyToPublish(A);
    await recordPublishAttempt(orphan, A);
    await setAttempts(orphan, maxAttempts());
    await expireLease(orphan);

    const { id: fresh } = await queuePublish(input({ assetId: ASSET_2 }));
    await claimPublishJobs(1, B);
    await expireLease(fresh);

    expect(await reapExpiredPublishLeases()).toEqual({
      unconfirmed: 1,
      posted: 0,
      exhausted: 0,
      requeued: 1,
    });
    expect((await read(orphan)).error_code).toBe("may_have_posted");
    expect((await read(fresh)).status).toBe("queued");
  });
});

// ─── 7. Reads ───────────────────────────────────────────────────────────────────────────────────

describe("reads are hers", () => {
  /** RC-11. */
  it("another athlete's job id is 'no such job' — the same answer as an id that does not exist", async () => {
    const { id } = await queuePublish(input());
    expect((await readPublishJob(ATHLETE, id))?.id).toBe(id);
    expect(await readPublishJob(OTHER, id)).toBeNull();
    expect(
      await readPublishJob(ATHLETE, "33333333-5555-4555-8555-555555555555"),
    ).toBeNull();
  });

  it("the latest job for a video is the newest one, and only hers", async () => {
    const first = await queuePublish(input());
    await claimPublishJobs(1, A);
    await failPublish(first.id, A, "transient", "x");
    await db
      .update(studioPublishJobs)
      .set({ created_at: new Date(Date.now() - 60_000) })
      .where(eq(studioPublishJobs.id, first.id));
    const second = await queuePublish(input());

    expect(
      (await readLatestPublishForAsset(ATHLETE, ASSET, "instagram"))?.id,
    ).toBe(second.id);
    expect(
      await readLatestPublishForAsset(OTHER, ASSET, "instagram"),
    ).toBeNull();
    expect(
      await readLatestPublishForAsset(ATHLETE, ASSET_2, "instagram"),
    ).toBeNull();
  });
});
