/**
 * eligibility.test.ts — "may THIS video go to THIS account?", against real SQL (PGlite).
 *
 * REVERT CHECKS, red by name:
 *   RC-E1  drop athlete_id from the asset lookup     → "TENANCY: another athlete's video is 'could not be found'…"
 *   RC-E2  drop athlete_id from the pinned lookup    → "TENANCY: an account id that belongs to another athlete is no account"
 *   RC-E3  accept any non-rejected approval state    → "only APPROVED posts…"
 *   RC-E4  scope matched by substring                → "reads the recorded scopes exactly…"
 *   RC-E5  drop the size check                       → "names the gap: we can make a video bigger than Instagram takes"
 *   RC-E6  drop the bitrate check                    → "refuses a file over Instagram's 25 Mbps…"
 *
 * All rows are synthetic.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athletes,
  connectedAccounts,
  mediaAssets,
} from "../../../shared/schema";
import {
  PUBLISH_SCOPE,
  accountRefusal,
  currentInstagramAccount,
  pinnedInstagramAccount,
  resolvePostableAsset,
} from "./eligibility";

const ATHLETE = "11111111-8888-4888-8888-888888888888";
const OTHER = "22222222-8888-4888-8888-888888888888";

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: ATHLETE, full_name: "Eligibility Athlete" },
    { id: OTHER, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});

let n = 0;
const asset = async (over: Record<string, unknown> = {}) =>
  (
    await db
      .insert(mediaAssets)
      .values({
        athlete_id: ATHLETE,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `synthetic/${n++}.mp4`,
        bytes: 5_000_000,
        duration_seconds: 13,
        duration_seconds_precise: 12.5,
        approval_status: "approved",
        ...over,
      } as never)
      .returning({ id: mediaAssets.id })
  )[0].id;

// Each row is its own Instagram account: 0071's connected_accounts_account_uq allows one row per
// (athlete, platform, platform_user_id), so several rows for one athlete are several accounts.
let igSeq = 0;
const account = async (over: Record<string, unknown> = {}) =>
  (
    await db
      .insert(connectedAccounts)
      .values({
        athlete_id: ATHLETE,
        platform: "instagram",
        status: "active",
        platform_username: "synthetic_handle",
        platform_user_id: `1784000000000${String(++igSeq).padStart(4, "0")}`,
        access_token: "tok",
        scopes: `instagram_business_basic,${PUBLISH_SCOPE}`,
        ...over,
      } as never)
      .returning({ id: connectedAccounts.id })
  )[0].id;

describe("resolvePostableAsset", () => {
  it("resolves her approved video, preferring the measured duration", async () => {
    const id = await asset();
    expect(await resolvePostableAsset(ATHLETE, id)).toEqual({
      ok: true,
      asset: {
        id,
        gcsPath: expect.stringMatching(/^synthetic\//),
        bytes: 5_000_000,
        durationSeconds: 12.5,
        approvalStatus: "approved",
      },
    });
  });

  /** RC-E1. */
  it("TENANCY: another athlete's video is 'could not be found' — the same answer as one that does not exist", async () => {
    const theirs = await asset({ athlete_id: OTHER });
    const mine = await resolvePostableAsset(ATHLETE, theirs);
    const ghost = await resolvePostableAsset(
      ATHLETE,
      "33333333-8888-4888-8888-888888888888",
    );
    expect(mine).toEqual(ghost);
    expect(mine).toMatchObject({ ok: false, status: 404, code: "not_found" });
  });

  it("a deleted video is gone", async () => {
    const id = await asset({ deleted_at: new Date() });
    expect(await resolvePostableAsset(ATHLETE, id)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  /** RC-E3. approval.ts: `approved` is "cleared for embed and publish". Nothing else is. */
  it("only APPROVED posts — a draft, a rejected video and an ungated (NULL) one are all refused", async () => {
    for (const approval_status of ["draft", "rejected", null]) {
      const id = await asset({ approval_status });
      expect(await resolvePostableAsset(ATHLETE, id)).toMatchObject({
        ok: false,
        status: 409,
        code: "not_approved",
        message: "Approve this video before posting it.",
      });
    }
  });

  it("can DESCRIBE a draft when asked to — that is how the client offers 'Approve and post'", async () => {
    const id = await asset({ approval_status: "draft" });
    expect(
      await resolvePostableAsset(ATHLETE, id, { requireApproved: false }),
    ).toMatchObject({
      ok: true,
      asset: { approvalStatus: "draft" },
    });
  });

  it("refuses a video under Instagram's three seconds, and says how long it is", async () => {
    const id = await asset({
      duration_seconds: 2,
      duration_seconds_precise: 2.4,
    });
    const out = await resolvePostableAsset(ATHLETE, id);
    expect(out).toMatchObject({ ok: false, status: 400, code: "too_short" });
    expect(out.ok === false && out.message).toMatch(/at least 3 seconds.*2\.4/);
  });

  it("a duration nobody measured is not a duration under three seconds", async () => {
    const id = await asset({
      duration_seconds: null,
      duration_seconds_precise: null,
      bytes: null,
    });
    expect(await resolvePostableAsset(ATHLETE, id)).toMatchObject({ ok: true });
  });

  /** RC-E5. The stitcher's own cap is above Instagram's, so a legal stitch can be unpostable. */
  it("names the gap: we can make a video bigger than Instagram takes", async () => {
    const id = await asset({
      bytes: 412_000_000,
      duration_seconds: 170,
      duration_seconds_precise: 170,
    });
    const out = await resolvePostableAsset(ATHLETE, id);
    expect(out).toMatchObject({ ok: false, status: 400, code: "too_big" });
    const message = out.ok === false ? out.message : "";
    expect(message).toMatch(/up to 300 MB/);
    expect(message).toMatch(/this one is 412 MB/);
    expect(message).toMatch(/bigger videos than Instagram accepts/);
    expect(message).toMatch(/shorter/);
    // Exactly at the cap is allowed; one byte over is not. Over a REAL length: 300 MB in the default
    // fixture's 12.5 s would be 192 Mbps, and the rate rule — not this one — would refuse it.
    const LONG = { duration_seconds: 170, duration_seconds_precise: 170 };
    expect(
      await resolvePostableAsset(
        ATHLETE,
        await asset({ ...LONG, bytes: 300_000_000 }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await resolvePostableAsset(
        ATHLETE,
        await asset({ ...LONG, bytes: 300_000_001 }),
      ),
    ).toMatchObject({ ok: false });
  });

  /**
   * RC-E6. The stitch encodes at a fixed quality with no rate ceiling, and Instagram's is 25 Mbps.
   * Without this, Meta's "format not supported" becomes OUR "put it together again" — which makes
   * the identical file. The refusal has to say that re-stitching will not help.
   */
  it("refuses a file over Instagram's 25 Mbps, and does NOT tell her to put it together again", async () => {
    // 10 s at 40 Mbps = 50 MB: far under the size cap, far over the rate cap.
    const dense = await asset({
      bytes: 50_000_000,
      duration_seconds: 10,
      duration_seconds_precise: 10,
    });
    const out = await resolvePostableAsset(ATHLETE, dense);
    expect(out).toMatchObject({ ok: false, status: 400, code: "too_dense" });
    const message = out.ok === false ? out.message : "";
    expect(message).toMatch(/40 Mbps/);
    expect(message).toMatch(/limit is 25/);
    expect(message).toMatch(/won't change that/);
    // Exactly at the limit posts; ordinary footage (the default fixture is 3.2 Mbps) posts.
    expect(
      await resolvePostableAsset(
        ATHLETE,
        await asset({
          bytes: 31_250_000,
          duration_seconds: 10,
          duration_seconds_precise: 10,
        }),
      ),
    ).toMatchObject({ ok: true });
    // No duration, no verdict: a rate we cannot compute is not a rate over the limit.
    expect(
      await resolvePostableAsset(
        ATHLETE,
        await asset({
          bytes: 50_000_000,
          duration_seconds: null,
          duration_seconds_precise: null,
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses a photo, and a video whose file never arrived", async () => {
    expect(
      await resolvePostableAsset(ATHLETE, await asset({ media_type: "IMAGE" })),
    ).toMatchObject({
      ok: false,
      code: "not_a_video",
    });
    expect(
      await resolvePostableAsset(ATHLETE, await asset({ status: "failed" })),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("the account", () => {
  it("currentInstagramAccount is her NEWEST ACTIVE Instagram row, and nobody else's", async () => {
    await account({
      created_at: new Date(Date.now() - 86_400_000),
      access_token: "tok-old",
    });
    const newest = await account({
      created_at: new Date(Date.now() + 60_000),
      access_token: "tok-new",
    });
    await account({
      created_at: new Date(Date.now() + 120_000),
      status: "revoked",
    });
    await account({
      created_at: new Date(Date.now() + 180_000),
      platform: "tiktok",
    });
    await account({
      created_at: new Date(Date.now() + 240_000),
      athlete_id: OTHER,
    });

    expect(await currentInstagramAccount(ATHLETE)).toMatchObject({
      id: newest,
      accessToken: "tok-new",
    });
    expect(
      await currentInstagramAccount("44444444-8888-4888-8888-888888888888"),
    ).toBeNull();
  });

  /** RC-E2. */
  it("TENANCY: an account id that belongs to another athlete is no account", async () => {
    const theirs = await account({ athlete_id: OTHER });
    expect(await pinnedInstagramAccount(ATHLETE, theirs)).toBeNull();
    expect(await pinnedInstagramAccount(OTHER, theirs)).toMatchObject({
      id: theirs,
    });
  });

  it("the pinned account must still be active — it never falls back to another", async () => {
    const id = await account({ status: "revoked" });
    expect(await pinnedInstagramAccount(ATHLETE, id)).toBeNull();
  });

  /** RC-E4. */
  it("reads the recorded scopes exactly — comma or space separated, never by substring", async () => {
    const yes = [
      PUBLISH_SCOPE,
      `instagram_business_basic,${PUBLISH_SCOPE}`,
      `instagram_business_basic, ${PUBLISH_SCOPE} ,x`,
      `instagram_business_basic ${PUBLISH_SCOPE}`,
    ];
    const no = [
      null,
      "",
      "instagram_business_basic,instagram_business_manage_insights",
      `${PUBLISH_SCOPE}_not`,
      `not_${PUBLISH_SCOPE}`,
      "instagram_content_publish", // the FACEBOOK-Login scope: a different product, not ours
    ];
    for (const scopes of yes)
      expect(
        (await pinnedInstagramAccount(ATHLETE, await account({ scopes })))!
          .canPublish,
      ).toBe(true);
    for (const scopes of no)
      expect(
        (await pinnedInstagramAccount(ATHLETE, await account({ scopes })))!
          .canPublish,
      ).toBe(false);
  });

  it("accountRefusal: no account, no scope, no token and no id each get the right sentence", async () => {
    expect(accountRefusal(null)).toMatchObject({
      code: "not_connected",
      message: "Connect a professional Instagram account to post from here.",
    });
    const ok = (await pinnedInstagramAccount(ATHLETE, await account()))!;
    expect(accountRefusal(ok)).toBeNull();
    for (const broken of [
      { ...ok, canPublish: false },
      { ...ok, accessToken: null },
      { ...ok, igUserId: null },
    ])
      expect(accountRefusal(broken)).toMatchObject({
        code: "reconnect",
        message: "Reconnect Instagram to allow posting.",
      });
  });
});
