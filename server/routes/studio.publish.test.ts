/**
 * studio.publish.test.ts — the three publish doors, through the REAL Studio router and its real
 * gate, against real SQL (PGlite). The runner is mocked: a queue here never reaches Instagram, and
 * the test that the kick FIRES can watch for it.
 *
 * REVERT CHECKS — each reds BY NAME when the line it guards is taken out of
 * server/studio/publish/routes.ts:
 *
 *   RC-R1  queue BEFORE the approve door          → "APPROVE THEN QUEUE: the job is created only after approval commits"
 *   RC-R2  swallow a failed approval and carry on  → "APPROVE THEN QUEUE: when approval fails there is NO job — never a posted draft"
 *   RC-R3  approve without being asked             → "a draft is never approved by a tap that did not ask to"
 *   RC-R4  take the account from the body          → "TENANCY: the account is HERS, resolved server-side — an id in the body is ignored"
 *   RC-R5  drop the off-switch from POST           → "STUDIO_PUBLISH_MODE=off: the surface does not exist"
 *   RC-R6  freeze the wrong mode on the row        → "freezes the mode, the caption and the account on the row"
 *   RC-R7  leak the account beyond three facts     → "/options tells the client three facts about the account and nothing else"
 *   RC-R8  unmount from the Studio gate            → "is behind the Studio gate…"
 *
 * Tenancy of the VIDEO lookup is RC-E1 (eligibility.test.ts), exercised again here end to end.
 * All rows are synthetic.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const who = (globalThis as any).__TEST_ATHLETE_ID;
    if (who === undefined) {
      res
        .status(401)
        .json({ error: "Missing or malformed Authorization header" });
      return;
    }
    if (who !== "no-athlete") req.athleteId = who;
    next();
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));
jest.mock("../studio/publish/runner", () => ({
  publishTick: jest.fn(async () => ({})),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { publishTick } from "../studio/publish/runner";
import * as approval from "../studio/approval";
import * as publishJobs from "../studio/publish/jobs";
import { PUBLISH_SCOPE } from "../studio/publish/eligibility";
import {
  athletes,
  connectedAccounts,
  mediaAssets,
  studioPublishJobs,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const HER = "22222222-9999-4444-8555-666666666666";
const SOMEONE_ELSE = "99999999-9999-4777-8666-555555555555";
const MISSING = "11111111-9999-4333-8444-555555555555";

let server: Server;
let base: string;
let HER_ACCOUNT = "";
let THEIR_ACCOUNT = "";

const asUser = (id: string | undefined) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};
const setMode = (v: "off" | "dry" | "live" | undefined) => {
  if (v === undefined) delete process.env.STUDIO_PUBLISH_MODE;
  else process.env.STUDIO_PUBLISH_MODE = v;
};
const mockTick = publishTick as jest.MockedFunction<typeof publishTick>;

const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};

async function seedVideo(
  owner: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "approved",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      bytes: 5_000_000,
      duration_seconds: 13,
      duration_seconds_precise: 12.5,
      ingested_at: new Date(),
      ...over,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const seedAccount = async (owner: string, over: Record<string, unknown> = {}) =>
  (
    await db
      .insert(connectedAccounts)
      .values({
        athlete_id: owner,
        platform: "instagram",
        status: "active",
        platform_username:
          owner === HER ? "her_synthetic_handle" : "their_synthetic_handle",
        platform_user_id: "17840000000000001",
        access_token: `tok-${owner.slice(0, 4)}`,
        scopes: `instagram_business_basic,${PUBLISH_SCOPE}`,
        ...over,
      } as never)
      .returning({ id: connectedAccounts.id })
  )[0].id;

const jobsOf = () => db.select().from(studioPublishJobs);
const approvalOf = async (id: string) =>
  (
    await db
      .select({ s: mediaAssets.approval_status })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
  )[0].s;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Publish Route Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  process.env.STUDIO_ENABLED = "true";

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.STUDIO_ENABLED;
  setMode(undefined);
  await closeTestDb();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  mockTick.mockClear();
  await db.delete(studioPublishJobs);
  await db.delete(connectedAccounts);
  HER_ACCOUNT = await seedAccount(HER);
  THEIR_ACCOUNT = await seedAccount(SOMEONE_ELSE);
  asUser(HER);
  setMode("live");
});

const body = (assetId: string, over: Record<string, unknown> = {}) => ({
  assetId,
  platform: "instagram",
  caption: "a synthetic caption",
  ...over,
});

// ─── The gate and the switch ────────────────────────────────────────────────────────────────────

describe("the gate and the switch", () => {
  /** RC-R8. */
  it("is behind the Studio gate: 404 with STUDIO_ENABLED off, 401 with no token, 403 with no athlete", async () => {
    const id = await seedVideo(HER);
    process.env.STUDIO_ENABLED = "false";
    try {
      expect((await post("/studio/publish", body(id))).status).toBe(404);
      expect((await get("/studio/publish/options")).status).toBe(404);
    } finally {
      process.env.STUDIO_ENABLED = "true";
    }
    asUser(undefined);
    expect((await post("/studio/publish", body(id))).status).toBe(401);
    asUser("no-athlete");
    expect((await post("/studio/publish", body(id))).status).toBe(403);
    expect(await jobsOf()).toEqual([]);
  });

  /** RC-R5. */
  it("STUDIO_PUBLISH_MODE=off: the surface does not exist — and unset means off", async () => {
    const id = await seedVideo(HER);
    for (const mode of ["off", undefined] as const) {
      setMode(mode);
      expect((await post("/studio/publish", body(id))).status).toBe(404);
      expect((await get(`/studio/publish/${MISSING}`)).status).toBe(404);
      // /options answers, so the client can draw NOTHING — and says nothing about her account.
      const options = await get(`/studio/publish/options?assetId=${id}`);
      expect(options).toEqual({ status: 200, json: { mode: "off" } });
    }
    expect(await jobsOf()).toEqual([]);
    expect(mockTick).not.toHaveBeenCalled();
  });
});

// ─── POST /studio/publish ───────────────────────────────────────────────────────────────────────

describe("POST /studio/publish", () => {
  /** RC-R6. */
  it("freezes the mode, the caption and the account on the row, answers 202, and kicks a tick", async () => {
    for (const mode of ["live", "dry"] as const) {
      await db.delete(studioPublishJobs);
      setMode(mode);
      const id = await seedVideo(HER);
      const res = await post(
        "/studio/publish",
        body(id, { caption: "  hello #one  " }),
      );
      expect(res.status).toBe(202);
      expect(res.json).toEqual({
        publishId: expect.any(String),
        status: "queued",
        alreadyLive: false,
        dryRun: mode === "dry",
        handle: "her_synthetic_handle",
      });
      const [row] = await jobsOf();
      expect(row).toMatchObject({
        id: res.json.publishId,
        athlete_id: HER,
        asset_id: id,
        connected_account_id: HER_ACCOUNT,
        platform: "instagram",
        caption: "hello #one",
        mode,
        status: "queued",
      });
    }
    expect(mockTick).toHaveBeenCalledTimes(2);
  });

  it("two taps are one job: the second is handed the first's id", async () => {
    const id = await seedVideo(HER);
    const a = await post("/studio/publish", body(id));
    const b = await post("/studio/publish", body(id));
    expect(b.status).toBe(202);
    expect(b.json).toMatchObject({
      publishId: a.json.publishId,
      alreadyLive: true,
    });
    expect(await jobsOf()).toHaveLength(1);
  });

  it("TENANCY: another athlete's video and a video that does not exist are the SAME 404", async () => {
    const theirs = await seedVideo(SOMEONE_ELSE);
    const a = await post("/studio/publish", body(theirs));
    const b = await post("/studio/publish", body(MISSING));
    const c = await post("/studio/publish", body("not-a-uuid"));
    expect(a.status).toBe(404);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(await jobsOf()).toEqual([]);
  });

  /** RC-R4. */
  it("TENANCY: the account is HERS, resolved server-side — an id in the body is ignored", async () => {
    const id = await seedVideo(HER);
    const res = await post(
      "/studio/publish",
      body(id, {
        athleteId: SOMEONE_ELSE,
        connectedAccountId: THEIR_ACCOUNT,
        connected_account_id: THEIR_ACCOUNT,
        handle: "their_synthetic_handle",
      }),
    );
    expect(res.status).toBe(202);
    expect(res.json.handle).toBe("her_synthetic_handle");
    const [row] = await jobsOf();
    expect(row.athlete_id).toBe(HER);
    expect(row.connected_account_id).toBe(HER_ACCOUNT);
  });

  it("refuses in a plain sentence when no Instagram account is connected", async () => {
    await db.delete(connectedAccounts);
    const res = await post("/studio/publish", body(await seedVideo(HER)));
    expect(res).toEqual({
      status: 409,
      json: {
        error: "Connect a professional Instagram account to post from here.",
        code: "not_connected",
      },
    });
  });

  it("refuses with 'Reconnect Instagram to allow posting.' when the recorded scopes lack publishing", async () => {
    await db.delete(connectedAccounts);
    await seedAccount(HER, {
      scopes:
        "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages",
    });
    const res = await post("/studio/publish", body(await seedVideo(HER)));
    expect(res).toEqual({
      status: 409,
      json: {
        error: "Reconnect Instagram to allow posting.",
        code: "reconnect",
      },
    });
    expect(await jobsOf()).toEqual([]);
  });

  it("refuses a video under 3 seconds and one over 300 MB — and the big one names the gap", async () => {
    const short = await post(
      "/studio/publish",
      body(await seedVideo(HER, { duration_seconds_precise: 2.2 })),
    );
    expect(short.status).toBe(400);
    expect(short.json.code).toBe("too_short");

    const big = await post(
      "/studio/publish",
      body(await seedVideo(HER, { bytes: 640_000_000 })),
    );
    expect(big.status).toBe(400);
    expect(big.json.code).toBe("too_big");
    expect(big.json.error).toMatch(/up to 300 MB.*640 MB/);
    expect(big.json.error).toMatch(/bigger videos than Instagram accepts/);
    expect(await jobsOf()).toEqual([]);
  });

  it("refuses a caption over 2,200 characters, over 30 hashtags or over 20 mentions — and accepts none at all", async () => {
    const id = await seedVideo(HER);
    const long = await post(
      "/studio/publish",
      body(id, { caption: "x".repeat(2201) }),
    );
    expect(long.status).toBe(400);
    expect(long.json).toMatchObject({ code: "bad_caption", field: "caption" });
    expect(long.json.error).toMatch(/2,200 characters.*2,201/);

    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(
      (await post("/studio/publish", body(id, { caption: tags }))).json.error,
    ).toMatch(/30 hashtags.*31/);
    const ats = Array.from({ length: 21 }, (_, i) => `@a${i}`).join(" ");
    expect(
      (await post("/studio/publish", body(id, { caption: ats }))).json.error,
    ).toMatch(/20 @mentions.*21/);
    expect(
      (await post("/studio/publish", body(id, { caption: 7 }))).status,
    ).toBe(400);
    expect(await jobsOf()).toEqual([]);

    const exactly = await post(
      "/studio/publish",
      body(id, { caption: "y".repeat(2200) }),
    );
    expect(exactly.status).toBe(202);
    await db.delete(studioPublishJobs);
    expect(
      (await post("/studio/publish", { assetId: id, platform: "instagram" }))
        .status,
    ).toBe(202);
    expect((await jobsOf())[0].caption).toBe("");
  });

  it("refuses a platform it has no publisher for", async () => {
    const res = await post(
      "/studio/publish",
      body(await seedVideo(HER), { platform: "tiktok" }),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "bad_platform", field: "platform" });
  });
});

// ─── APPROVE, THEN QUEUE ────────────────────────────────────────────────────────────────────────

describe("the combined step: approve, then queue", () => {
  /** RC-R3. */
  it("a draft is never approved by a tap that did not ask to", async () => {
    const id = await seedVideo(HER, { approval_status: "draft" });
    const res = await post("/studio/publish", body(id));
    expect(res).toEqual({
      status: 409,
      json: {
        error: "Approve this video before posting it.",
        code: "not_approved",
      },
    });
    expect(await approvalOf(id)).toBe("draft");
    expect(await jobsOf()).toEqual([]);
    // `approve` must be exactly true — not truthy.
    for (const approve of ["true", 1, "yes", {}]) {
      expect(
        (await post("/studio/publish", body(id, { approve }))).status,
      ).toBe(409);
      expect(await approvalOf(id)).toBe("draft");
    }
  });

  /**
   * RC-R1. THE ORDERING, observed rather than inferred: the approve door is entered, RETURNS, and
   * only then is queuePublish called — and at that moment the video is already `approved` in the
   * database.
   *
   * THE DOOR IS MADE SLOW ON PURPOSE. PGlite serialises every query behind one mutex, so an
   * approval the route forgot to await still commits before the route's next query — the race is
   * real on Postgres and invisible here. The first version of this test passed with the `await`
   * removed AND the re-resolve belt off, i.e. with a draft going into the queue. The delay puts the
   * approval where a dropped await leaves it: later than the queue.
   */
  it("APPROVE THEN QUEUE: the job is created only after approval commits", async () => {
    const id = await seedVideo(HER, { approval_status: "draft" });
    const order: string[] = [];
    const realApprove = approval.setApprovalStatus;
    const realQueue = publishJobs.queuePublish;
    jest
      .spyOn(approval, "setApprovalStatus")
      .mockImplementation(async (...args) => {
        order.push("approve:start");
        await new Promise((r) => setTimeout(r, 60));
        const out = await realApprove(...args);
        order.push("approve:committed");
        return out;
      });
    jest
      .spyOn(publishJobs, "queuePublish")
      .mockImplementation(async (input) => {
        order.push(`queue:start(asset is ${await approvalOf(id)})`);
        return realQueue(input);
      });

    const res = await post("/studio/publish", body(id, { approve: true }));
    expect(res.status).toBe(202);
    expect(order).toEqual([
      "approve:start",
      "approve:committed",
      "queue:start(asset is approved)",
    ]);
    expect(await approvalOf(id)).toBe("approved");
    expect(await jobsOf()).toHaveLength(1);
  });

  /** RC-R2. */
  it("APPROVE THEN QUEUE: when approval fails there is NO job — never a posted draft", async () => {
    const id = await seedVideo(HER, { approval_status: "draft" });
    jest
      .spyOn(approval, "setApprovalStatus")
      .mockRejectedValue(new Error("approval store is down"));
    const queue = jest.spyOn(publishJobs, "queuePublish");

    const res = await post("/studio/publish", body(id, { approve: true }));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(
      "Couldn't approve this video, so it wasn't posted. Try again.",
    );
    expect(queue).not.toHaveBeenCalled();
    expect(await jobsOf()).toEqual([]);
    expect(await approvalOf(id)).toBe("draft");
    expect(mockTick).not.toHaveBeenCalled();
  });

  it("when approval succeeds and QUEUEING fails, she has an approved video and a plain error", async () => {
    const id = await seedVideo(HER, { approval_status: "draft" });
    jest
      .spyOn(publishJobs, "queuePublish")
      .mockRejectedValue(new Error("queue is down"));
    const res = await post("/studio/publish", body(id, { approve: true }));
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/nothing was posted/i);
    expect(await approvalOf(id)).toBe("approved");
    expect(await jobsOf()).toEqual([]);
  });

  it("a video that could not be posted anyway is refused BEFORE she is asked to clear it", async () => {
    const big = await seedVideo(HER, {
      approval_status: "draft",
      bytes: 640_000_000,
    });
    const approve = jest.spyOn(approval, "setApprovalStatus");
    expect(
      (await post("/studio/publish", body(big, { approve: true }))).json.code,
    ).toBe("too_big");

    await db.delete(connectedAccounts);
    const draft = await seedVideo(HER, { approval_status: "draft" });
    expect(
      (await post("/studio/publish", body(draft, { approve: true }))).json.code,
    ).toBe("not_connected");

    expect(approve).not.toHaveBeenCalled();
    expect(await approvalOf(big)).toBe("draft");
    expect(await approvalOf(draft)).toBe("draft");
  });

  it("a REJECTED video is not rehabilitated by posting it — approval.ts makes that two acts", async () => {
    const id = await seedVideo(HER, { approval_status: "rejected" });
    const res = await post("/studio/publish", body(id, { approve: true }));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/turned down/);
    expect(await approvalOf(id)).toBe("rejected");
    expect(await jobsOf()).toEqual([]);
  });

  it("an ungated (NULL) ingested asset is not what this door is for", async () => {
    const id = await seedVideo(HER, {
      approval_status: null,
      origin: "upload",
    });
    expect(
      (await post("/studio/publish", body(id, { approve: true }))).status,
    ).toBe(409);
    expect(await jobsOf()).toEqual([]);
  });
});

// ─── GET /studio/publish/options ────────────────────────────────────────────────────────────────

describe("GET /studio/publish/options", () => {
  /** RC-R7. */
  it("/options tells the client three facts about the account and nothing else", async () => {
    const res = await get("/studio/publish/options");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      mode: "live",
      platforms: ["instagram"],
      instagram: {
        connected: true,
        handle: "her_synthetic_handle",
        canPublish: true,
      },
      limits: { captionMaxChars: 2200, minSeconds: 3, maxBytes: 300_000_000 },
    });
    const raw = JSON.stringify(res.json);
    expect(raw).not.toContain("tok-");
    expect(raw).not.toContain(PUBLISH_SCOPE);
    expect(raw).not.toContain(HER_ACCOUNT);
    expect(raw).not.toContain("17840000000000001");
  });

  it("says 'Reconnect to post' in data: connected, but cannot publish", async () => {
    await db.delete(connectedAccounts);
    await seedAccount(HER, { scopes: "instagram_business_basic" });
    expect((await get("/studio/publish/options")).json.instagram).toEqual({
      connected: true,
      handle: "her_synthetic_handle",
      canPublish: false,
    });
    await db.delete(connectedAccounts);
    expect((await get("/studio/publish/options")).json.instagram).toEqual({
      connected: false,
      handle: null,
      canPublish: false,
    });
  });

  it("describes HER video — a draft needs approval, a big one is refused in words — and never someone else's", async () => {
    const draft = await seedVideo(HER, { approval_status: "draft" });
    expect(
      (await get(`/studio/publish/options?assetId=${draft}`)).json,
    ).toMatchObject({
      asset: { postable: true, approvalStatus: "draft", needsApproval: true },
      latest: null,
    });
    const big = await seedVideo(HER, { bytes: 640_000_000 });
    expect(
      (await get(`/studio/publish/options?assetId=${big}`)).json.asset,
    ).toMatchObject({
      postable: false,
      refusal: { code: "too_big" },
    });
    const theirs = await seedVideo(SOMEONE_ELSE);
    expect(
      (await get(`/studio/publish/options?assetId=${theirs}`)).status,
    ).toBe(404);
    expect(
      (await get(`/studio/publish/options?assetId=${MISSING}`)).status,
    ).toBe(404);
  });

  it("remembers the last post of this video, so the result card is right when she comes back", async () => {
    const id = await seedVideo(HER);
    const { json } = await post("/studio/publish", body(id));
    expect(
      (await get(`/studio/publish/options?assetId=${id}`)).json.latest,
    ).toMatchObject({
      publishId: json.publishId,
      status: "queued",
      posted: false,
    });
  });
});

// ─── GET /studio/publish/:publishId ─────────────────────────────────────────────────────────────

describe("GET /studio/publish/:publishId", () => {
  it("reads her job, tells a real post from a dry run, and DRIVES NOTHING", async () => {
    const id = await seedVideo(HER);
    const { json } = await post("/studio/publish", body(id));
    mockTick.mockClear();

    await db
      .update(studioPublishJobs)
      .set({
        status: "succeeded",
        permalink: "https://example.test/reel/1",
        ig_media_id: "media-1",
        container_id: "container-1",
      })
      .where(eq(studioPublishJobs.id, json.publishId));
    const live = await get(`/studio/publish/${json.publishId}`);
    expect(live.json).toMatchObject({
      status: "succeeded",
      posted: true,
      dryRun: false,
      permalink: "https://example.test/reel/1",
      error: null,
    });
    // No handle Instagram gave us leaves the server.
    expect(JSON.stringify(live.json)).not.toMatch(/media-1|container-1/);

    await db
      .update(studioPublishJobs)
      .set({ mode: "dry", permalink: null })
      .where(eq(studioPublishJobs.id, json.publishId));
    expect((await get(`/studio/publish/${json.publishId}`)).json).toMatchObject(
      {
        status: "succeeded",
        posted: false,
        dryRun: true,
      },
    );
    expect(mockTick).not.toHaveBeenCalled();
  });

  it("carries the sentence AND the code, so the client can offer the right next step", async () => {
    const id = await seedVideo(HER);
    const { json } = await post("/studio/publish", body(id));
    await db
      .update(studioPublishJobs)
      .set({
        status: "failed",
        error_code: "reconnect",
        last_error: "Reconnect Instagram to allow posting.",
      })
      .where(eq(studioPublishJobs.id, json.publishId));
    expect((await get(`/studio/publish/${json.publishId}`)).json).toMatchObject(
      {
        status: "failed",
        posted: false,
        errorCode: "reconnect",
        error: "Reconnect Instagram to allow posting.",
      },
    );
  });

  it("TENANCY: another athlete's job is 'No such post' — the same answer as one that does not exist", async () => {
    const id = await seedVideo(HER);
    const { json } = await post("/studio/publish", body(id));
    asUser(SOMEONE_ELSE);
    const theirs = await get(`/studio/publish/${json.publishId}`);
    const ghost = await get(`/studio/publish/${MISSING}`);
    expect(theirs.status).toBe(404);
    expect(theirs).toEqual(ghost);
    expect((await get("/studio/publish/not-a-uuid")).status).toBe(404);
  });
});
