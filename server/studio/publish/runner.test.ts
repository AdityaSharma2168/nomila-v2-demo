/**
 * runner.test.ts — the publish worker, against real SQL (PGlite) and a scripted fake of Meta that
 * COUNTS EVERY CALL BY OPERATION. Nothing here touches the network, GCS or Cloud SQL.
 *
 * THE PROPERTY: a retry must never produce a second post. Here that is a number — `meta.count.publish`
 * — and across every way a job can be re-worked it is never 2.
 *
 * REVERT CHECKS — each reds BY NAME when the line it guards is taken out of runner.ts:
 *
 *   RC-W1  ignore the gate (always call publish)      → "IDEMPOTENCY: two runners holding the same row post ONCE"
 *   RC-W2  drop arm 2 (publish_attempted_at)          → "an orphan with the switch OFF is told it MAY HAVE POSTED…"
 *   RC-W3  drop arm 1 (ig_media_id)                   → "a job that already carries a media id finishes its paperwork…"
 *   RC-W4  treat an unknown publish outcome as a no   → "IDEMPOTENCY: a publish that TIMES OUT is never re-sent…"
 *   RC-W5  ignore job.container_id                    → "a job that already has a container RESUMES it…"
 *   RC-W6  dry branch removed                         → "DRY RUN makes no Meta POST…"
 *   RC-W7  log the raw signed URL                     → "DRY RUN makes no Meta POST…"
 *   RC-W8  maySendLive replaced by the row's mode     → "a LIVE row in a DRY process posts nothing…"
 *   RC-W9  use her CURRENT account, not the pinned    → "posts to the account she CONFIRMED…"
 *   RC-W10 drop the publishing-limit read             → "a row that CLAIMS the publish scope but is refused by Meta…"
 *   RC-W11 generic catch ignores the gate             → "a crash AFTER the post is never reported as a refusal…"
 *   RC-W12 write content_posts on a dry run           → "DRY RUN makes no Meta POST…"
 *   RC-W13 skip the run-time approval re-check        → "approval withdrawn while it waited…"
 *
 * All rows, tokens, handles and URLs are synthetic.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
// Network boundaries, mocked per suite: the runner's defaults name GCS and the shared integration.
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn() }));
jest.mock("../../lib/integrations/instagram", () => ({
  refreshTokenIfNeeded: jest.fn(),
}));
const mockLogs: { level: string; obj: unknown; msg: unknown }[] = [];
jest.mock("../../logger", () => {
  const at = (level: string) => (obj: unknown, msg?: unknown) =>
    mockLogs.push({ level, obj, msg });
  const logger = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  };
  return { createLogger: () => logger };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athletes,
  connectedAccounts,
  contentPosts,
  mediaAssets,
  studioPublishJobs,
} from "../../../shared/schema";
import { maxPolls } from "./config";
import { PUBLISH_SCOPE } from "./eligibility";
import type { FetchLike } from "./instagram";
import * as jobs from "./jobs";
import {
  MAY_HAVE_POSTED,
  claimPublishJobs,
  queuePublish,
  reapExpiredPublishLeases,
} from "./jobs";
import {
  inFlightCount,
  publishTick,
  workPublish,
  type RunnerDeps,
} from "./runner";

const ATHLETE = "11111111-7777-4777-8777-777777777777";
const OTHER = "22222222-7777-4777-8777-777777777777";
const SIGNATURE = "deadbeefcafe0123";
const SIGNED = (path: string) =>
  `https://storage.googleapis.com/synthetic-bucket/${path}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`;

let APPROVED = "";
let DRAFT = "";
let THEIRS = "";
let PINNED = "";
let NEWER = "";
let UNSCOPED = "";

const setMode = (v: "off" | "dry" | "live" | undefined) => {
  if (v === undefined) delete process.env.STUDIO_PUBLISH_MODE;
  else process.env.STUDIO_PUBLISH_MODE = v;
};

beforeAll(async () => {
  process.env.STUDIO_PUBLISH_POLL_WINDOW_MS = "0"; // one look per claim; the next look is the next tick's
  await initTestDb();
  await db.insert(athletes).values([
    { id: ATHLETE, full_name: "Publish Runner Athlete" },
    { id: OTHER, full_name: "Another Athlete" },
  ] as never);
  const asset = async (
    athlete: string,
    path: string,
    approval: string | null,
    extra = {},
  ) =>
    (
      await db
        .insert(mediaAssets)
        .values({
          athlete_id: athlete,
          platform: "studio",
          origin: "generated",
          media_type: "VIDEO",
          status: "stored",
          gcs_path: path,
          bytes: 5_000_000,
          duration_seconds: 13,
          duration_seconds_precise: 12.5,
          approval_status: approval,
          ...extra,
        } as never)
        .returning({ id: mediaAssets.id })
    )[0].id;
  APPROVED = await asset(ATHLETE, "synthetic/approved.mp4", "approved");
  DRAFT = await asset(ATHLETE, "synthetic/draft.mp4", "draft");
  THEIRS = await asset(OTHER, "synthetic/theirs.mp4", "approved");

  // Three rows = three Instagram accounts: 0071's connected_accounts_account_uq allows one row per
  // (athlete, platform, platform_user_id).
  let igSeq = 0;
  const account = async (token: string, scopes: string, createdAt: Date) =>
    (
      await db
        .insert(connectedAccounts)
        .values({
          athlete_id: ATHLETE,
          platform: "instagram",
          status: "active",
          platform_username: "synthetic_handle",
          platform_user_id: `1784000000000${String(++igSeq).padStart(4, "0")}`,
          access_token: token,
          scopes,
          created_at: createdAt,
        } as never)
        .returning({ id: connectedAccounts.id })
    )[0].id;
  const scoped = `instagram_business_basic,${PUBLISH_SCOPE}`;
  PINNED = await account(
    "tok-PINNED",
    scoped,
    new Date(Date.now() - 86_400_000),
  );
  NEWER = await account("tok-NEWER", scoped, new Date());
  UNSCOPED = await account(
    "tok-UNSCOPED",
    "instagram_business_basic",
    new Date(Date.now() - 2 * 86_400_000),
  );
});
afterAll(async () => {
  delete process.env.STUDIO_PUBLISH_POLL_WINDOW_MS;
  setMode(undefined);
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(studioPublishJobs);
  await db.delete(contentPosts);
  mockLogs.length = 0;
  setMode("live");
  jest.restoreAllMocks();
});

// ─── The fake of Meta ───────────────────────────────────────────────────────────────────────────

type Op = "limit" | "create" | "status" | "publish" | "permalink";
type Answer = { status?: number; json: unknown } | "hang" | Error;
type Script = Partial<Record<Op, Answer | Answer[]>>;

const OK_LIMIT: Answer = {
  json: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] },
};
const status = (code: string, text?: string): Answer => ({
  json: {
    id: "container-1",
    status_code: code,
    ...(text ? { status: text } : {}),
  },
});
const refusal = (error: Record<string, unknown>, http = 400): Answer => ({
  status: http,
  json: { error },
});

function meta(script: Script) {
  const count: Record<Op, number> = {
    limit: 0,
    create: 0,
    status: 0,
    publish: 0,
    permalink: 0,
  };
  const calls: {
    op: Op;
    method: string;
    url: string;
    auth: string;
    body?: string;
  }[] = [];
  const opOf = (method: string, url: string): Op => {
    if (method === "POST" && url.endsWith("/media_publish")) return "publish";
    if (method === "POST" && url.endsWith("/media")) return "create";
    if (url.includes("content_publishing_limit")) return "limit";
    if (url.includes("fields=status_code")) return "status";
    if (url.includes("fields=permalink")) return "permalink";
    throw new Error(`fake meta: unexpected ${method} ${url}`);
  };
  const fetch: FetchLike = (url, init) => {
    const op = opOf(init.method, url);
    const n = count[op]++;
    calls.push({
      op,
      method: init.method,
      url,
      auth: init.headers.Authorization,
      body: init.body,
    });
    const s = script[op] ?? (op === "limit" ? OK_LIMIT : undefined);
    if (s === undefined) throw new Error(`fake meta: no script for ${op}`);
    const a = Array.isArray(s) ? s[Math.min(n, s.length - 1)] : s;
    if (a === "hang") return new Promise(() => {});
    if (a instanceof Error) return Promise.reject(a);
    const http = a.status ?? 200;
    return Promise.resolve({
      ok: http >= 200 && http < 300,
      status: http,
      json: () => Promise.resolve(a.json),
    });
  };
  const posts = () => calls.filter((c) => c.method === "POST").length;
  return { fetch, count, calls, posts };
}

const HAPPY: Script = {
  create: { json: { id: "container-1" } },
  status: status("FINISHED"),
  publish: { json: { id: "media-1" } },
  permalink: { json: { permalink: "https://example.test/reel/1" } },
};

const depsFor = (
  m: ReturnType<typeof meta>,
  holder = "instance-a",
): RunnerDeps => ({
  ig: { fetch: m.fetch, timeoutMs: 100 },
  signUrl: async (path) => SIGNED(path),
  refreshToken: async () => {},
  sleep: async () => {},
  holder,
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────

const queue = (over: Partial<jobs.QueuePublishInput> = {}) =>
  queuePublish({
    athleteId: ATHLETE,
    assetId: APPROVED,
    connectedAccountId: PINNED,
    platform: "instagram",
    caption: "a synthetic caption #one",
    mode: "live",
    ...over,
  });

const claim = async (holder = "instance-a") =>
  (await claimPublishJobs(1, holder))[0];

const read = async (id: string) =>
  (
    await db
      .select()
      .from(studioPublishJobs)
      .where(eq(studioPublishJobs.id, id))
  )[0];

const posts = () => db.select().from(contentPosts);

/** The instance holding `id` dies; the reaper runs; `holder` picks the job up. */
async function handOff(id: string, holder: string) {
  await db
    .update(studioPublishJobs)
    .set({ lease_until: new Date(Date.now() - 1000) })
    .where(eq(studioPublishJobs.id, id));
  await reapExpiredPublishLeases();
  const job = await claim(holder);
  expect(job?.id).toBe(id);
  return job;
}

// ─── The ordinary path ──────────────────────────────────────────────────────────────────────────

describe("the ordinary path", () => {
  it("posts ONCE: limit → container → FINISHED → publish → permalink → content_posts → succeeded", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");

    expect(m.calls.map((c) => c.op)).toEqual([
      "limit",
      "create",
      "status",
      "publish",
      "permalink",
    ]);
    expect(m.count.publish).toBe(1);
    expect(JSON.parse(m.calls[1].body!)).toEqual({
      media_type: "REELS",
      video_url: SIGNED("synthetic/approved.mp4"),
      caption: "a synthetic caption #one",
    });
    expect(JSON.parse(m.calls[3].body!)).toEqual({
      creation_id: "container-1",
    });

    expect(await read(id)).toMatchObject({
      status: "succeeded",
      container_id: "container-1",
      ig_media_id: "media-1",
      permalink: "https://example.test/reel/1",
      error_code: null,
      lease_holder: null,
    });
    expect((await read(id)).publish_attempted_at).not.toBeNull();
    expect(await posts()).toMatchObject([
      {
        asset_id: APPROVED,
        platform: "instagram",
        permalink: "https://example.test/reel/1",
      },
    ]);
  });

  /** RC-W5. */
  it("a job that already has a container RESUMES it — Instagram is not made to fetch the file twice", async () => {
    const m = meta({
      ...HAPPY,
      status: [status("IN_PROGRESS"), status("FINISHED")],
    });
    const { id } = await queue();

    expect(
      await workPublish(await claim("instance-a"), depsFor(m, "instance-a")),
    ).toBe("waiting");
    expect(await read(id)).toMatchObject({
      status: "queued",
      container_id: "container-1",
      poll_count: 1,
    });
    expect(m.count.publish).toBe(0);

    expect(
      await workPublish(await claim("instance-b"), depsFor(m, "instance-b")),
    ).toBe("succeeded");
    expect(m.count.create).toBe(1);
    expect(m.count.publish).toBe(1);
  });

  it("a video Instagram never finishes preparing is given up on WITHOUT ever publishing", async () => {
    const m = meta({ ...HAPPY, status: status("IN_PROGRESS") });
    const { id } = await queue();
    let outcome = "";
    for (let i = 0; i < maxPolls() + 2 && outcome !== "failed"; i++)
      outcome = await workPublish(await claim(), depsFor(m));

    expect(outcome).toBe("failed");
    const row = await read(id);
    expect(row.error_code).toBe("transient");
    expect(row.last_error).toMatch(/nothing was posted/i);
    expect(m.count.publish).toBe(0);
    expect(m.count.create).toBe(1);
    expect(await posts()).toEqual([]);
  });

  it("a permalink that cannot be read does not un-post the post", async () => {
    const m = meta({
      ...HAPPY,
      permalink: refusal({ code: 1, message: "x" }, 500),
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      ig_media_id: "media-1",
      permalink: null,
    });
    expect(await posts()).toHaveLength(1);
  });
});

// ─── IDEMPOTENCY ────────────────────────────────────────────────────────────────────────────────

describe("IDEMPOTENCY — a retry never produces a second post", () => {
  /**
   * RC-W1. Two runners hold the SAME claimed row — the stale-lease race, made deterministic. Both
   * reach "FINISHED, so publish". Exactly one is given permission.
   */
  it("IDEMPOTENCY: two runners holding the same row post ONCE", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    const job = await claim("instance-a");
    await jobs.recordContainer(id, "instance-a", "container-1");
    const stale = { ...job, container_id: "container-1" };

    const [a, b] = await Promise.all([
      workPublish(stale, depsFor(m, "instance-a")),
      workPublish(stale, depsFor(m, "instance-a")),
    ]);

    expect(m.count.publish).toBe(1);
    expect([a, b].filter((o) => o === "succeeded")).toHaveLength(1);
    expect(await posts()).toHaveLength(1);
  });

  /**
   * RC-W4. The publish call goes out and the answer never comes back. It MAY have posted. The job
   * is read, handed on, read again — and finally told the truth. publish is never called again.
   */
  it("IDEMPOTENCY: a publish that TIMES OUT is never re-sent, and a container that then reads PUBLISHED is a success", async () => {
    const m = meta({
      ...HAPPY,
      publish: "hang",
      status: [status("FINISHED"), status("FINISHED"), status("PUBLISHED")],
    });
    const { id } = await queue();

    // Tick 1: FINISHED → publish → silence → read again (still FINISHED) → wait.
    expect(
      await workPublish(await claim("instance-a"), depsFor(m, "instance-a")),
    ).toBe("waiting");
    expect(m.count.publish).toBe(1);
    const waiting = await read(id);
    expect(waiting.status).toBe("queued");
    expect(waiting.publish_attempted_at).not.toBeNull();
    expect(waiting.ig_media_id).toBeNull();

    // Tick 2, another instance: the container now says PUBLISHED. It posted.
    expect(
      await workPublish(await claim("instance-b"), depsFor(m, "instance-b")),
    ).toBe("succeeded");
    expect(m.count.publish).toBe(1); // ← the whole point
    expect(m.count.create).toBe(1);
    // No field on a container returns the media id, so a recovered post has no permalink. It is
    // still a post, and content_posts still says so.
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      ig_media_id: null,
      permalink: null,
    });
    expect(await posts()).toMatchObject([
      { asset_id: APPROVED, permalink: null },
    ]);
  });

  it("IDEMPOTENCY: when nobody can say whether it posted, she is told exactly that — and it is never re-sent", async () => {
    const m = meta({
      ...HAPPY,
      publish: new Error("socket hang up"),
      status: status("FINISHED"),
    });
    const { id } = await queue();
    let outcome = "";
    for (let i = 0; i < maxPolls() + 3 && outcome !== "failed"; i++)
      outcome = await workPublish(
        await claim(`instance-${i}`),
        depsFor(m, `instance-${i}`),
      );

    expect(outcome).toBe("failed");
    expect(m.count.publish).toBe(1);
    const row = await read(id);
    expect(row).toMatchObject({
      status: "failed",
      error_code: "may_have_posted",
      last_error: MAY_HAVE_POSTED,
    });
    expect(row.last_error).not.toMatch(/nothing was posted/i);
    expect(await posts()).toEqual([]);
  });

  it("IDEMPOTENCY: Meta's 'try again' on publish is an UNKNOWN outcome, not an invitation", async () => {
    const m = meta({
      ...HAPPY,
      publish: refusal({
        code: -1,
        error_subcode: 2207001,
        message: "server error",
        is_transient: true,
      }),
      status: [status("FINISHED"), status("PUBLISHED")],
    });
    await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");
    expect(m.count.publish).toBe(1);
  });

  /** RC-W3. The instance died between writing the handle and finishing the paperwork. */
  it("a job that already carries a media id finishes its paperwork and makes NO Meta POST", async () => {
    const m = meta({
      permalink: { json: { permalink: "https://example.test/reel/1" } },
    });
    const { id } = await queue();
    await claim("instance-a");
    await jobs.recordContainer(id, "instance-a", "container-1");
    await jobs.recordPublishAttempt(id, "instance-a");
    await jobs.recordMediaId(id, "media-1");

    expect(
      await workPublish(
        await handOff(id, "instance-b"),
        depsFor(m, "instance-b"),
      ),
    ).toBe("succeeded");
    expect(m.posts()).toBe(0);
    expect(m.calls.map((c) => c.op)).toEqual(["permalink"]);
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      permalink: "https://example.test/reel/1",
    });
    expect(await posts()).toHaveLength(1);
  });

  it("re-entering the paperwork does not write a second content_posts row", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    const spy = jest
      .spyOn(jobs, "succeedPublish")
      .mockRejectedValueOnce(new Error("db blip"));
    expect(
      await workPublish(await claim("instance-a"), depsFor(m, "instance-a")),
    ).toBe("lost");
    spy.mockRestore();
    expect(await posts()).toHaveLength(1);

    expect(
      await workPublish(
        await handOff(id, "instance-b"),
        depsFor(m, "instance-b"),
      ),
    ).toBe("succeeded");
    expect(await posts()).toHaveLength(1);
    expect(m.count.publish).toBe(1);
  });

  /**
   * RC-W11. Our own database hiccups AFTER Instagram made the post. The generic error path would
   * write "refused" over a video that is live on her profile — and invite her to post it again.
   */
  it("a crash AFTER the post is never reported as a refusal — the row is left for the reaper, and ends succeeded", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    const spy = jest
      .spyOn(jobs, "succeedPublish")
      .mockRejectedValueOnce(new Error("db blip"));

    expect(
      await workPublish(await claim("instance-a"), depsFor(m, "instance-a")),
    ).toBe("lost");
    spy.mockRestore();
    const mid = await read(id);
    expect(mid.status).toBe("running"); // NOT failed
    expect(mid.error_code).toBeNull();
    expect(mid.ig_media_id).toBe("media-1");

    expect(
      await workPublish(
        await handOff(id, "instance-b"),
        depsFor(m, "instance-b"),
      ),
    ).toBe("succeeded");
    expect(m.count.publish).toBe(1);
  });

  /** RC-W2. Arms 1 and 2 are facts about the world; the switch does not change them. */
  it("an orphan with the switch OFF is told it MAY HAVE POSTED, never that nothing was", async () => {
    const m = meta({});
    const { id } = await queue();
    await claim("instance-a");
    await jobs.recordContainer(id, "instance-a", "container-1");
    await jobs.recordPublishAttempt(id, "instance-a");
    const job = await handOff(id, "instance-b");

    setMode("off");
    expect(await workPublish(job, depsFor(m, "instance-b"))).toBe("failed");
    expect(m.calls).toEqual([]); // off means no Meta call at all — not even a read
    const row = await read(id);
    expect(row.error_code).toBe("may_have_posted");
    expect(row.last_error).not.toMatch(/nothing was posted/i);
  });

  it("an explicit refusal from publish IS a no: nothing was posted, and it is said plainly", async () => {
    const m = meta({
      ...HAPPY,
      publish: refusal({
        code: 9,
        error_subcode: 2207042,
        message: "limit reached",
      }),
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.count.publish).toBe(1);
    expect(await read(id)).toMatchObject({
      status: "failed",
      error_code: "rate_limited",
    });
    expect(await posts()).toEqual([]);
  });
});

// ─── The switch ─────────────────────────────────────────────────────────────────────────────────

describe("STUDIO_PUBLISH_MODE", () => {
  /** RC-W6, RC-W7, RC-W12. */
  it("DRY RUN makes no Meta POST, writes no content_posts, and logs the exact payload without the URL's secrets", async () => {
    setMode("dry");
    const m = meta({});
    const { id } = await queue({ mode: "dry" });
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");

    expect(m.posts()).toBe(0);
    expect(m.calls.map((c) => c.op)).toEqual(["limit"]); // the one read that proves the scope is real
    expect(await read(id)).toMatchObject({
      status: "succeeded",
      mode: "dry",
      container_id: null,
      publish_attempted_at: null,
      ig_media_id: null,
      permalink: null,
    });
    expect(await posts()).toEqual([]);

    const dry = mockLogs.find((l) => String(l.msg).startsWith("DRY RUN"));
    expect(dry).toBeDefined();
    expect(dry!.obj).toMatchObject({
      mode: "dry",
      connectedAccountId: PINNED,
      wouldSend: [
        {
          method: "POST",
          path: "/<IG_ID>/media",
          body: {
            media_type: "REELS",
            caption: "a synthetic caption #one",
            video_url:
              "https://storage.googleapis.com/synthetic-bucket/synthetic/approved.mp4?<redacted: X-Goog-Algorithm,X-Goog-Signature>",
          },
        },
        {
          method: "POST",
          path: "/<IG_ID>/media_publish",
          body: { creation_id: expect.any(String) },
        },
      ],
    });
    const everything = JSON.stringify(mockLogs);
    expect(everything).not.toContain(SIGNATURE);
    expect(everything).not.toContain("tok-PINNED");
    expect(everything).not.toContain("synthetic_handle");
  });

  it("a DRY row in a LIVE process stays dry — the row's mode was frozen at the tap", async () => {
    setMode("live");
    const m = meta({});
    await queue({ mode: "dry" });
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");
    expect(m.posts()).toBe(0);
  });

  /** RC-W8. */
  it("a LIVE row in a DRY process posts nothing, and says nothing was posted", async () => {
    setMode("dry");
    const m = meta(HAPPY);
    const { id } = await queue({ mode: "live" });
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.calls).toEqual([]);
    const row = await read(id);
    expect(row.error_code).toBe("not_sending");
    expect(row.last_error).toMatch(/nothing was posted/i);
  });

  it("OFF fails a waiting job rather than draining it, with no Meta call at all", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    setMode("off");
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.calls).toEqual([]);
    expect((await read(id)).error_code).toBe("not_sending");
  });
});

// ─── Who, and what ──────────────────────────────────────────────────────────────────────────────

describe("the account and the video are re-resolved at run time, against HER id", () => {
  /** RC-W9. She holds two Instagram rows. The confirm step named one of them. */
  it("posts to the account she CONFIRMED, not to whichever is newest", async () => {
    const m = meta(HAPPY);
    await queue({ connectedAccountId: PINNED });
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");
    expect(new Set(m.calls.map((c) => c.auth))).toEqual(
      new Set(["Bearer tok-PINNED"]),
    );
    expect(NEWER).not.toBe(PINNED);
  });

  /** RC-W10. connected_accounts.scopes can claim a scope Meta never granted. Meta has the last word. */
  it("a row that CLAIMS the publish scope but is refused by Meta ends as 'Reconnect Instagram to allow posting.' before any container exists", async () => {
    const m = meta({
      ...HAPPY,
      limit: refusal({
        code: 10,
        type: "OAuthException",
        message: "no permission",
      }),
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.count.create).toBe(0);
    expect(m.posts()).toBe(0);
    expect(await read(id)).toMatchObject({
      error_code: "reconnect",
      last_error: "Reconnect Instagram to allow posting.",
    });
  });

  it("a row whose RECORDED scopes lack publishing is refused with no Meta call", async () => {
    const m = meta(HAPPY);
    const { id } = await queue({ connectedAccountId: UNSCOPED });
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.calls).toEqual([]);
    expect((await read(id)).error_code).toBe("reconnect");
  });

  it("a failed READ of the limit does not refuse a post — only 'no permission' and 'no quota' do", async () => {
    const m = meta({
      ...HAPPY,
      limit: refusal({ code: 2, message: "temporarily unavailable" }, 500),
    });
    await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("succeeded");
    expect(m.count.publish).toBe(1);
  });

  it("a used-up quota is said BEFORE she waits for an upload", async () => {
    const m = meta({
      ...HAPPY,
      limit: {
        json: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] },
      },
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.count.create).toBe(0);
    expect((await read(id)).error_code).toBe("rate_limited");
  });

  it("an account disconnected while the job waited fails it — it does NOT fall back to another @handle", async () => {
    const m = meta(HAPPY);
    const gone = (
      await db
        .insert(connectedAccounts)
        .values({
          athlete_id: ATHLETE,
          platform: "instagram",
          status: "active",
          access_token: "tok-GONE",
          platform_user_id: "17840000000000009",
          scopes: PUBLISH_SCOPE,
        } as never)
        .returning({ id: connectedAccounts.id })
    )[0].id;
    const { id } = await queue({ connectedAccountId: gone });
    await db
      .update(connectedAccounts)
      .set({ status: "revoked" })
      .where(eq(connectedAccounts.id, gone));

    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.calls).toEqual([]);
    const row = await read(id);
    expect(row.error_code).toBe("account_gone");
    expect(row.last_error).toMatch(/nothing was posted/i);
  });

  /** RC-W13. */
  it("approval withdrawn while it waited: the video is not posted", async () => {
    const m = meta(HAPPY);
    const { id } = await queue({ assetId: DRAFT });
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(m.calls).toEqual([]);
    expect((await read(id)).last_error).toMatch(/approve this video/i);
  });

  /** A forged or corrupted row must not be able to post someone else's video. */
  it("TENANCY: a job row naming ANOTHER athlete's video is 'no such video' — nothing is signed, nothing is sent", async () => {
    const m = meta(HAPPY);
    const signUrl = jest.fn(async (p: string) => SIGNED(p));
    const { id } = await queue({ assetId: THEIRS });
    expect(await workPublish(await claim(), { ...depsFor(m), signUrl })).toBe(
      "failed",
    );
    expect(signUrl).not.toHaveBeenCalled();
    expect(m.calls).toEqual([]);
    expect((await read(id)).error_code).toBe("asset_gone");
  });
});

// ─── Instagram's refusals reach her as sentences ────────────────────────────────────────────────

describe("what Instagram says becomes what she can do", () => {
  it("a container that ERRORS on the format tells her to put it together again", async () => {
    const m = meta({
      ...HAPPY,
      status: status("ERROR", "Error: unsupported format, subcode 2207026"),
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    const row = await read(id);
    expect(row.error_code).toBe("restitch");
    expect(row.last_error).toMatch(/put it together again/i);
    expect(row.last_error).not.toMatch(/2207026|subcode/);
    expect(m.count.publish).toBe(0);
  });

  it("Meta being unable to fetch the video is OUR problem, and says so — ledger (b)'s signal", async () => {
    const m = meta({
      ...HAPPY,
      create: refusal({
        code: 9004,
        error_subcode: 2207052,
        message: "could not be fetched",
      }),
    });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect(await read(id)).toMatchObject({ error_code: "fetch_failed" });
    expect((await read(id)).last_error).toMatch(/on our side/i);
  });

  it("an EXPIRED container is a fresh start, not a publish", async () => {
    const m = meta({ ...HAPPY, status: status("EXPIRED") });
    const { id } = await queue();
    expect(await workPublish(await claim(), depsFor(m))).toBe("failed");
    expect((await read(id)).error_code).toBe("expired");
    expect(m.count.publish).toBe(0);
  });

  it("our own crash before anything was sent blames us, not an Instagram refusal that never happened", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    const deps = {
      ...depsFor(m),
      signUrl: async () => Promise.reject(new Error("signing key missing")),
    };
    expect(await workPublish(await claim(), deps)).toBe("failed");
    const row = await read(id);
    expect(row.last_error).toMatch(/on our side/i);
    expect(row.last_error).toMatch(/nothing was posted/i);
    expect(m.posts()).toBe(0);
  });
});

// ─── The tick ───────────────────────────────────────────────────────────────────────────────────

describe("publishTick", () => {
  const settled = async () => {
    for (let i = 0; i < 200 && inFlightCount() > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
  };

  it("reaps, claims and works the queue without waiting for the work", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    const out = await publishTick(depsFor(m));
    expect(out).toMatchObject({ claimed: 1, atCapacity: false, mode: "live" });
    await settled();
    expect((await read(id)).status).toBe("succeeded");
    expect(m.count.publish).toBe(1);
  });

  it("runs with the switch OFF too — to close what was waiting, with no Meta call", async () => {
    const m = meta(HAPPY);
    const { id } = await queue();
    setMode("off");
    expect(await publishTick(depsFor(m))).toMatchObject({
      claimed: 1,
      mode: "off",
    });
    await settled();
    expect((await read(id)).error_code).toBe("not_sending");
    expect(m.calls).toEqual([]);
  });

  /** Mirrors the stitch suite's pin. One value shared by two queues silently serialises them. */
  it("is ticked by its own endpoint, with a lock key neither other queue uses", () => {
    const index = readFileSync(join(__dirname, "..", "..", "index.ts"), "utf8");
    expect(index).toMatch(/\/api\/internal\/studio-publish-tick/);
    const key = (name: string) =>
      index.match(new RegExp(`${name} = (\\S+);`))![1];
    const keys = [
      key("STUDIO_VIDEO_TICK_LOCK_KEY"),
      key("STUDIO_STITCH_TICK_LOCK_KEY"),
      key("STUDIO_PUBLISH_TICK_LOCK_KEY"),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});
