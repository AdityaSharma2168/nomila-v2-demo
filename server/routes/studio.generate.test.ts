/**
 * studio.generate.test.ts — the spend boundary.
 *
 * This is the first real money the project spends, so the properties under test are not "does the
 * happy path work" but "can a client cause a charge the server did not independently authorize from
 * its own stored record". Every one of these is a money bug if it regresses:
 *
 *   1. A blocked brief never reaches the router.
 *   2. A cost figure in the request body is not read by anything. The ceiling comes off OUR row.
 *   3. A quote that has grown past the approved figure is refused.
 *   4. An unpriced model never spends as if it were $0.
 *   5. A job over the hard cap is refused even when the approval says otherwise.
 *   6. A double-tapped Generate produces ONE charge and one job id.
 *   7. Another athlete's previewId, job or asset is a 404 — never a spend, never a read.
 *
 * THE ROUTER IS MOCKED, so no test in this file can spend or touch the network. `generate` is a
 * jest.fn and the assertion that matters most is `expect(generate).not.toHaveBeenCalled()`.
 *
 * PGlite gives real Postgres: the CHECK constraints, the FKs and the plpgsql triggers are the real
 * ones, applied from the same generationGuards.sql migration 0027 embeds (see approval.test.ts).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

// The billable door, and ONLY that door. `estimate` is deliberately left real: it is pure pricing
// arithmetic with no network, and it is the thing that derives the figure the whole spend gate is
// checked against — mocking it would make every assertion below test a stub instead of the gate.
jest.mock("../studio/router", () => {
  const actual = jest.requireActual("../studio/router");
  return { ...actual, generate: jest.fn() };
});

// The runner a queued video is kicked into after the response. Not this suite's subject, and a real
// tick would claim the job and submit it to a provider.
jest.mock("../studio/videoRunner", () => ({ videoTick: jest.fn(async () => ({})) }));

// Storage + signing need a service-account key; neither is what this suite is about.
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })),
}));

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { savePreview } from "../studio/previewStore";
import { previewGeneration, type GenerationPreview } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import { athletes, athletesCurrent, generationJobs, mediaAssets, studioGenerationPreviews, studioPlans } from "../../shared/schema";
import { savePlan } from "../studio/agent/plans";
import { MODELS } from "../studio/config";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ID   = "99999999-8888-4777-8666-555555555555";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

let server: Server;
let base: string;

const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/**
 * A complete CreativeBrief, as assembleBrief would produce one.
 *
 * Every field buildPrompt reads is present: a partial brief throws inside the prompt builder, which
 * would make these tests fail for a reason that has nothing to do with spend.
 */
function fullBrief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: new Date().toISOString(),
    job: {
      origin: "system", objective: "grow-following", deliverable: "post",
      mode: "generate", source: null,
      direction: { set: "chosen", statement: "mid-stride, hard evening light", untrusted: false, featuredPieces: [] },
    },
    athlete: {
      athleteId: ATHLETE_ID,
      identity: {
        name: "Test Spike Athlete", firstName: "Test",
        identityLine: "soccer · Test University · captain",
        sport: "soccer", org: "Test University",
        division: null, conference: null, segment: null, tier: null, marqueeTag: null,
      },
      voice: { storyArc: "walked on, started by junior year", highlights: [] },
      audience: { descriptor: "women 18-24 · top market US", ageRange: "18-24", topCity: null, topMarket: "US", share: 41 },
      aesthetic: { register: "grounded, high-effort", notes: [] },
      goal: "grow her audience",
      commercialState: "none",
    },
    brand: null,
    gaps: [],
    ...over,
  } as unknown as CreativeBrief;
}

/**
 * The REAL verdict for a brief — the same call the preview route makes.
 *
 * Built rather than hand-written so the stored approval and the figure generate re-derives agree by
 * construction. A hand-written cost would silently drift from the price table and turn these into
 * tests of a fixture.
 */
function previewFixture(brief: CreativeBrief = fullBrief()): GenerationPreview {
  return previewGeneration(brief);
}

/** What the mocked router hands back for a successful image generation. */
function generatedResult() {
  const now = new Date().toISOString();
  return {
    task: "image.generate", provider: "vertex", model: "gemini-3-pro-image",
    assets: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]).buffer, width: 1024, height: 1280 }],
    cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" },
    timings: { startedAt: now, completedAt: now, ms: 10 },
    raw: {},
  };
}

beforeAll(async () => {
  await initTestDb();
  // The DDL Drizzle cannot express — the same file 0027 embeds verbatim.
  await client.exec(readFileSync(join(__dirname, "..", "studio", "sql", "generationGuards.sql"), "utf8"));
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" },
    { id: OTHER_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);

  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  process.env.STUDIO_ENABLED = "true";
  delete process.env.STUDIO_MAX_JOB_USD;
  delete process.env.STUDIO_MAX_DAY_USD;
  delete process.env.STUDIO_SERVER_ROUTING;
  asUser(ATHLETE_ID);
  (generate as jest.Mock).mockReset().mockResolvedValue(generatedResult());
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets);
  await db.delete(generationJobs);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the flag", () => {
  it("404s every U2 route when Studio is off", async () => {
    process.env.STUDIO_ENABLED = "false";
    const previewId = await savePreview(ATHLETE_ID, previewFixture());

    for (const r of [
      await post("/studio/generate", { previewId }),
      await get(`/studio/jobs/${MISSING_ID}`),
      await post(`/studio/assets/${MISSING_ID}/approve`),
      await post(`/studio/assets/${MISSING_ID}/reject`),
      await post(`/studio/assets/${MISSING_ID}/reopen`),
    ]) {
      expect(r.status).toBe(404);
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("POST /studio/generate — nothing spends without our own approval", () => {
  it("refuses a blocked preview and never reaches the router", async () => {
    // A real blocking gap on the brief, rendered by the real previewGeneration — not a hand-set flag.
    const previewId = await savePreview(ATHLETE_ID, previewFixture(fullBrief({
      gaps: [{ field: "job.direction", note: "nothing to make a picture from", severity: "blocking" }],
    })));

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(409);
    expect(json.error).toMatch(/can't run yet|check again/i);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("never spends when the model has no configured price", async () => {
    // A real model with no entry in the price table — pricing reports `unpriced`, never $0.
    process.env.STUDIO_IMAGE_MODEL = "some/model-nobody-priced";
    const preview = previewFixture();
    expect(preview.unpriced).toBe(true);
    const previewId = await savePreview(ATHLETE_ID, preview);

    const { status, json } = await post("/studio/generate", { previewId });
    delete process.env.STUDIO_IMAGE_MODEL;

    expect(status).toBe(409);
    expect(json.error).toMatch(/price/i);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("IGNORES a cost the client puts in the body — the ceiling is ours, not theirs", async () => {
    // The forgery that matters is an INFLATED ceiling: a low one merely refuses the job, but a high
    // one would authorize a spend the athlete never saw. Here the stored approval is $0.1344 and the
    // body claims $999. If the body were read at all, the expensive preview below would generate.
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    // Our record says she approved a figure the real quote now exceeds.
    await db.update(studioGenerationPreviews)
      .set({ cost_usd: "0.0001" })
      .where(eq(studioGenerationPreviews.id, previewId));

    // The body screams a ceiling high enough to authorize anything. If it were read at all, this
    // would generate.
    const { status } = await post("/studio/generate", {
      previewId,
      approvedCostUsd: 999,
      cost: { amountUsd: 999 },
      approvedCost: 999,
    });

    expect(status).toBe(409);
    expect(generate).not.toHaveBeenCalled();

    // And the stored approval is untouched by the attempt.
    const [row] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, previewId));
    expect(row.consumed_at).toBeNull();
  });

  it("refuses when the fresh quote has grown past the approved figure", async () => {
    // The stored row says she approved a cheap job; the brief re-derives to a dearer one. The route
    // re-derives rather than trusting the row's plan, so the growth is caught.
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    await db.update(studioGenerationPreviews)
      .set({ cost_usd: "0.0001" })
      .where(eq(studioGenerationPreviews.id, previewId));

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(409);
    expect(json.error).toMatch(/above the \$0\.0001 you approved|check the cost again/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a job over the hard per-job cap even when the approval allows it", async () => {
    process.env.STUDIO_MAX_JOB_USD = "0.05";
    const previewId = await savePreview(ATHLETE_ID, previewFixture());   // quotes $0.1344, approved at $0.1344

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
    // Both sides of the comparison, in the message she gets. A refusal that names neither the quote
    // nor the limit tells the person who hit it nothing they can act on.
    expect(json.error).toContain("$0.13");            // what it quoted
    expect(json.error).toContain("$0.05");            // the cap it broke
    expect(json.error).toMatch(/per-job limit/);
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  /**
   * THE PER-DAY CEILING, accumulated for real.
   *
   * The per-job cap bounds one spend and says nothing about a hundred of them, which is the runaway
   * this project can actually produce. So the ceiling is cumulative, and the only honest way to test
   * "it refuses the Nth job" is to let N-1 of them really run and really write their rows.
   *
   * Each generate quotes $0.1344. At a $0.30 ceiling: two land ($0.2688), and the third would take
   * the day to $0.4032 and is refused. Nothing here inserts a fixture row — the total is summed off
   * the job rows the previous requests opened, through studio/jobs.ts spentTodayUsd.
   */
  it("lets two jobs through and refuses the third against a $0.30 daily ceiling", async () => {
    process.env.STUDIO_MAX_DAY_USD = "0.30";

    const first = await post("/studio/generate", { previewId: await savePreview(ATHLETE_ID, previewFixture()) });
    expect(first.status).toBe(200);
    const second = await post("/studio/generate", { previewId: await savePreview(ATHLETE_ID, previewFixture()) });
    expect(second.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);

    const third = await post("/studio/generate", { previewId: await savePreview(ATHLETE_ID, previewFixture()) });

    expect(third.status).toBe(409);
    expect(third.json.error).toMatch(/daily ceiling/);
    expect(third.json.error).toContain("$0.30");          // the ceiling
    expect(third.json.error).toContain("STUDIO_MAX_DAY_USD");  // the knob, in the message
    // The refusal is a refusal: no third call, and no third job row.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await db.select().from(generationJobs)).toHaveLength(2);
  });

  it("does not count another athlete's day against hers", async () => {
    process.env.STUDIO_MAX_DAY_USD = "0.30";

    // Two jobs on the OTHER athlete's row — enough to break the ceiling if the sum were global.
    asUser(OTHER_ID);
    const otherBrief = fullBrief({ athlete: { ...fullBrief().athlete, athleteId: OTHER_ID } } as Partial<CreativeBrief>);
    for (let n = 0; n < 2; n += 1) {
      const { status } = await post("/studio/generate", { previewId: await savePreview(OTHER_ID, previewFixture(otherBrief)) });
      expect(status).toBe(200);
    }

    // Hers is still empty, so hers still generates. The predicate is athlete_id, like every other
    // query in this codebase — which is also why this ceiling is not a global budget.
    asUser(ATHLETE_ID);
    const { status } = await post("/studio/generate", { previewId: await savePreview(ATHLETE_ID, previewFixture()) });
    expect(status).toBe(200);
  });

  it("does not count a CANCELED job — the losing half of a double tap is not a charge", async () => {
    process.env.STUDIO_MAX_DAY_USD = "0.30";

    // One real job, then a double tap on one preview: the loser is canceled and must not count.
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    const [a, b] = await Promise.all([
      post("/studio/generate", { previewId }),
      post("/studio/generate", { previewId }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.json.jobId).toBe(b.json.jobId);          // one charge, one job id
    expect(generate).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(generationJobs);
    expect(rows.filter((r) => r.status === "canceled").length).toBeLessThanOrEqual(1);

    // $0.1344 really spent. If the canceled row counted, the day would read $0.2688 and the two
    // below would not both fit under $0.30.
    const second = await post("/studio/generate", { previewId: await savePreview(ATHLETE_ID, previewFixture()) });
    expect(second.status).toBe(200);
  });

  it("refuses an expired approval", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    await db.update(studioGenerationPreviews)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(studioGenerationPreviews.id, previewId));

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(409);
    expect(json.error).toMatch(/expired/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates once on the happy path, and the asset is born draft", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(json.assets).toHaveLength(1);
    // Never born cleared — that is the entire point of the approval machine.
    expect(json.assets[0].approvalStatus).toBe("draft");
    expect(json.assets[0].assetId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(json.assets[0].url).toContain("https://signed.example/");
    // Only the moves the machine actually allows from draft.
    expect(json.assets[0].allowedNext.sort()).toEqual(["approved", "rejected"]);

    const jobs = await db.select().from(generationJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("succeeded");
    expect(jobs[0].athlete_id).toBe(ATHLETE_ID);
  });
});

describe("idempotency — a double-tapped Generate bills once", () => {
  it("two CONCURRENT taps produce one charge, one job, and the same jobId", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());

    const [a, b] = await Promise.all([
      post("/studio/generate", { previewId }),
      post("/studio/generate", { previewId }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The property that costs money if it breaks.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(a.json.jobId).toBe(b.json.jobId);

    // Exactly one job ever ran. The loser's row exists and is canceled — a real thing that
    // happened, recorded, never claimed and never billed.
    const jobs = await db.select().from(generationJobs);
    expect(jobs.filter((j) => j.status === "succeeded")).toHaveLength(1);
    expect(jobs.filter((j) => j.status === "canceled").length).toBeLessThanOrEqual(1);
    expect(await db.select().from(mediaAssets)).toHaveLength(1);
  });

  it("a sequential re-tap on a consumed approval returns the same job and does not spend again", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());

    const first = await post("/studio/generate", { previewId });
    expect(generate).toHaveBeenCalledTimes(1);

    const second = await post("/studio/generate", { previewId });

    expect(second.status).toBe(200);
    expect(second.json.jobId).toBe(first.json.jobId);
    expect(second.json.status).toBe("already_running");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await db.select().from(mediaAssets)).toHaveLength(1);
  });
});

describe("tenancy", () => {
  it("another athlete's previewId is a 404 and never spends", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());

    asUser(OTHER_ID);
    const { status } = await post("/studio/generate", { previewId });

    expect(status).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    // Untouched — B's failed attempt must not burn A's approval.
    const [row] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, previewId));
    expect(row.consumed_at).toBeNull();
  });

  it("another athlete's job is a 404, not a different error", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    const { json } = await post("/studio/generate", { previewId });

    asUser(OTHER_ID);
    const mine = await get(`/studio/jobs/${json.jobId}`);
    const nothing = await get(`/studio/jobs/${MISSING_ID}`);

    expect(mine.status).toBe(404);
    // Not-yours and not-found are indistinguishable — a different answer would confirm it exists.
    expect(mine.json).toEqual(nothing.json);
  });

  it("another athlete cannot approve or reject her asset", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    const { json } = await post("/studio/generate", { previewId });
    const assetId = json.assets[0].assetId;

    asUser(OTHER_ID);
    expect((await post(`/studio/assets/${assetId}/approve`)).status).toBe(404);
    expect((await post(`/studio/assets/${assetId}/reject`)).status).toBe(404);

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("draft");
  });

  it("rejects a previewId that is not a uuid without touching the database", async () => {
    const { status } = await post("/studio/generate", { previewId: "'; drop table athletes; --" });
    expect(status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("GET /studio/jobs/:jobId — watching, never driving", () => {
  it("reports the run and what it produced", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture());
    const { json } = await post("/studio/generate", { previewId });

    const before = (generate as jest.Mock).mock.calls.length;
    const { status, json: job } = await get(`/studio/jobs/${json.jobId}`);

    expect(status).toBe(200);
    expect(job.status).toBe("succeeded");
    expect(job.quotedUsd).toBeCloseTo(0.1344, 4);
    expect(job.costBasis).toBe("estimated");
    expect(job.assets).toHaveLength(1);
    expect(job.assets[0].url).toContain("https://signed.example/");
    // Polling must never advance work.
    expect((generate as jest.Mock).mock.calls.length).toBe(before);
  });
});

// ─── The routing cutover, at the spend boundary ─────────────────────────────────────────────────

/**
 * A brief the CLASSIFIER refuses: an edit, on her photograph, whose direction names a person.
 *
 * `refusalFor` reads exactly two things off the frozen brief — the direction statement and whether
 * there is a source — so those are what this fixture varies. Everything else is `fullBrief`'s.
 */
function editBriefSaying(statement: string): CreativeBrief {
  return fullBrief({
    job: {
      origin: "system", objective: "grow-following", deliverable: "post",
      mode: "edit",
      source: {
        mediaAssetId: MISSING_ID,
        ref: "athletes/x/frame.jpg",
        width: 4000,
        height: 6000,
        editRegions: [{ label: "her hair", x: 100, y: 100, width: 200, height: 200 }],
      },
      direction: { set: "chosen", statement, untrusted: false, featuredPieces: [] },
      references: [],
    },
  } as unknown as Partial<CreativeBrief>);
}

describe("STUDIO_SERVER_ROUTING — the server can refuse before it spends", () => {
  /**
   * ⚠️ THE HALF OF THE CUTOVER A CLIENT FLAG CANNOT BUY.
   *
   * The client asks /studio/classify and acts on the answer. A retry, a cron, or any future API
   * arrives HERE with that guard already behind it — which is the entire argument for the
   * classifier being server-side, and it only pays off if the path that spends money consults it.
   *
   * The assertion that matters is `generate` never being called: a refusal that happened after the
   * provider call would be a refusal that cost money.
   */
  it("refuses an ASK brief with its reason attached, and never reaches the router", async () => {
    process.env.STUDIO_SERVER_ROUTING = "true";
    const previewId = await savePreview(ATHLETE_ID, previewFixture(editBriefSaying("make my hair red")));

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).toBe(409);
    // THE REASON, not a generic decline. `person_target` and `fast_path_declined` want different
    // UI, and this is the last boundary that could flatten them.
    expect(json.error).toMatch(/person_target/);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("tells the two ASK reasons apart here too", async () => {
    process.env.STUDIO_SERVER_ROUTING = "true";
    const declined = await savePreview(
      ATHLETE_ID,
      previewFixture(editBriefSaying("do something cool with this")),
    );

    const { status, json } = await post("/studio/generate", { previewId: declined });

    expect(status).toBe(409);
    expect(json.error).toMatch(/fast_path_declined/);
    expect(json.error).not.toMatch(/person_target/);
    expect(generate).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ WITH THE FLAG OFF, THE CLASSIFIER IS NOT CONSULTED AT ALL — the test that makes this a real
   * rollback rather than a decoration. The SAME brief refused above must get PAST the ASK gate
   * here, because `refusalFor` returns `{}` and `runStudioGeneration` receives no `path`. If this
   * goes red, the cutover has stopped being revertible by config.
   *
   * ⚠️ ASSERTED AS "NOT REFUSED BY THE CLASSIFIER", NOT AS "THE JOB SUCCEEDS", AND THE DIFFERENCE
   * IS HONEST RATHER THAN CONVENIENT. This suite mocks `generate` and nothing beneath it, so an
   * EDIT brief cannot run to completion here: the masked path reads the source frame out of
   * media_assets and this fixture's source is an id with no row. It fails at 500 for that reason,
   * and building the fixture that would let it succeed is an edit-pipeline harness, not this
   * commit. What IS provable — and is the whole claim — is that execution reaches that failure
   * instead of stopping at the gate above it.
   */
  const REFUSED_BY_CLASSIFIER = /was not routed/;

  it("does not consult the classifier when the flag is off — the brief gets past the gate", async () => {
    const previewId = await savePreview(ATHLETE_ID, previewFixture(editBriefSaying("make my hair red")));

    const { status, json } = await post("/studio/generate", { previewId });

    // The identical request 409s with `person_target` when the flag is on, two tests above.
    expect(status).not.toBe(409);
    expect(json?.error ?? "").not.toMatch(REFUSED_BY_CLASSIFIER);
  });

  it("leaves a routable edit alone even with the flag on — only an ASK is threaded", async () => {
    // "remove the ball" routes to MASKED. A routed answer passes `{}`, so `usesMaskedPath` keeps
    // deducing from brief shape and nothing about the job changes. See `refusalFor`: the server
    // gets to say no, never to say something different.
    process.env.STUDIO_SERVER_ROUTING = "true";
    const previewId = await savePreview(ATHLETE_ID, previewFixture(editBriefSaying("remove the ball")));

    const { status, json } = await post("/studio/generate", { previewId });

    expect(status).not.toBe(409);
    expect(json?.error ?? "").not.toMatch(REFUSED_BY_CLASSIFIER);
  });
});

// ─── Quote matches run on the t2v path (b-roll t2v) ─────────────────────────────────────────────

/**
 * THE #545 / PR-0 DEFECT CLASS, ON THE PATH B-ROLL NOW TAKES. PR 0 found a run spending on a model its
 * quote never priced: the run re-planned the brief without the shot type's route and fell back to the
 * default video route. B-roll is now made from words — a photo-less Board row — so this proves, rather
 * than assumes, that such a row is quoted and RUN on the same model: the real preview route, the real
 * generate route (only the billable `generate` is mocked, and a video never reaches it), and the job
 * row the runner reads its provider and model from (videoRunner.dispatch.test.ts pins that the runner
 * submits to exactly the row's provider).
 */
describe("quote matches run for a photo-less b-roll row — text-to-video, one model", () => {
  const OFF = { ...process.env };
  // The REAL preview route builds her brief from her profile, which needs an athletes_current row
  // (studio.test.ts seeds one the same way). Only for this block — every other test here saves its
  // preview directly and must not start seeing a profile.
  beforeAll(async () => {
    await db.insert(athletesCurrent).values({
      athlete_id: ATHLETE_ID,
      story_arc: "A synthetic arc for tests.",
    } as never);
  });
  afterAll(async () => {
    await db.delete(athletesCurrent).where(eq(athletesCurrent.athlete_id, ATHLETE_ID));
  });
  beforeEach(() => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
  });
  afterEach(() => {
    process.env = { ...OFF, STUDIO_ENABLED: "true" };
  });

  /**
   * ⚠️ MUTATION: have the job row record the DEFAULT video route instead of the plan it was opened
   * from (studio/jobs.ts createGenerationJob — the PR-0 shape: the run falls back to Veo). This reds.
   */
  it("quotes and runs a photo-less b-roll row on the SAME model — seedance-fast, no reference", async () => {
    // Exactly what the Board sends for a row with no photo (client storyboardRun `clipRequestFor`).
    const quote = await post("/studio/preview", {
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
      direction: "Rain beading on an empty bench at dusk.",
      references: [],
    });
    expect({ status: quote.status, body: quote.json }).toMatchObject({ status: 200 });
    expect(quote.json.plan.model).toBe(MODELS.seedanceFast);
    expect(quote.json.plan.inputs.references).toBe(0);

    const run = await post("/studio/generate", { previewId: quote.json.previewId });
    // The body rides in the comparison, so a refusal says what it was.
    expect({ status: run.status, body: run.json }).toMatchObject({
      status: 200,
      body: { status: "queued" },
    });

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, run.json.jobId));
    // The row the runner works from names the model the quote priced — and the provider that serves it.
    expect({ provider: job.provider, model: job.model }).toEqual({
      provider: "openrouter",
      model: quote.json.plan.model,
    });
    expect(Number(job.cost_estimated_usd)).toBeCloseTo(quote.json.cost.amountUsd, 6);
    // Nothing ran inline: a clip is queued, and the billable door was never reached from here.
    expect(generate).not.toHaveBeenCalled();
  });
});

/**
 * ─── THE CARRIER (PR 14, docs/probes/brief-carrier.md) ────────────────────────────────────────────
 *
 * A clip request may name the plan it belongs to; the route reads that row under HER athlete id and
 * freezes the brief's feel, constraints and concept onto the clip's brief. MUTATIONS, by name:
 *   "carrier renders with STUDIO_BRIEF_CARRIER off" — drop the flag check on `planId`: the first test reds.
 *   "a clip request with another athlete's planId is served" — read the row by id alone: the 404 test reds.
 *   "a client-posted campaign object is accepted" — drop the `campaign` refusal in parsePreviewBody: reds.
 *   "a brief do-not absent from the clip request" / "concept line absent from the clip request" — drop
 *     `campaign` from the BriefInput literal: the frozen-brief test reds.
 */
describe("the carrier — a clip request carrying planId, behind STUDIO_BRIEF_CARRIER", () => {
  const OFF = { ...process.env };
  const CAMPAIGN = JSON.parse(
    readFileSync(join(__dirname, "..", "studio", "campaign", "fixtures", "bottle-campaign.json"), "utf8"),
  ).campaign as Record<string, unknown>;
  const EMPTY_PLAN = { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null };
  const BROLL = {
    intent: "video.generate",
    deliverable: "clip",
    objective: "grow-following",
    direction: "Rain beading on an empty bench at dusk.",
    references: [],
  };
  let hers: string;
  let theirs: string;
  let plain: string;

  beforeAll(async () => {
    await db.insert(athletesCurrent).values({
      athlete_id: ATHLETE_ID,
      story_arc: "A synthetic arc for tests.",
    } as never);
    hers = (
      await savePlan(ATHLETE_ID, {
        plan: EMPTY_PLAN,
        brief: { ...CAMPAIGN, constraints: ["do not show a competitor's logo", "mention @solstice in the caption"] },
        concept: { id: "A", angle: "Quiet power", feeling: "calm", line: "she trains alone at dawn" },
        aesthetic: "moody and quiet",
        objective: "showcase-product",
      })
    ).id;
    theirs = (await savePlan(OTHER_ID, { plan: EMPTY_PLAN, brief: CAMPAIGN, aesthetic: "loud" })).id;
    plain = (await savePlan(ATHLETE_ID, { plan: EMPTY_PLAN, aesthetic: "bright and playful", objective: "grow-following" })).id;
  });
  afterAll(async () => {
    await db.delete(studioPlans);
    await db.delete(athletesCurrent).where(eq(athletesCurrent.athlete_id, ATHLETE_ID));
  });
  beforeEach(() => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    process.env.STUDIO_BRIEF_CARRIER = "true";
    process.env.STUDIO_BRAND_PROFILES = "true";
  });
  afterEach(() => {
    process.env = { ...OFF, STUDIO_ENABLED: "true" };
  });

  it("P-off: with the flag off, planId is an unknown field and no row is read", async () => {
    delete process.env.STUDIO_BRIEF_CARRIER;
    const r = await post("/studio/preview", { ...BROLL, planId: hers });
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 400, body: { field: "planId" } });
  });

  it("P-noplan: a request with no planId compiles the prompt it always did — flag on or off", async () => {
    const on = await post("/studio/preview", BROLL);
    delete process.env.STUDIO_BRIEF_CARRIER;
    const off = await post("/studio/preview", BROLL);
    expect(on.status).toBe(200);
    expect(on.json.plan.inputs.prompt).toBe(off.json.plan.inputs.prompt);
    expect(on.json.plan.inputs.prompt).not.toContain("<<<CAMPAIGN>>>");
    expect("campaign" in on.json.brief.job).toBe(false);
  });

  it("P-planid: another athlete's planId is a 404 before anything runs — and never confirms theirs exists", async () => {
    const r = await post("/studio/preview", { ...BROLL, planId: theirs });
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 404, body: { field: "planId" } });
    const missing = await post("/studio/preview", { ...BROLL, planId: MISSING_ID });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe(r.json.error);
    expect(await db.select().from(studioGenerationPreviews)).toHaveLength(0);
  });

  it("a client-posted campaign object is refused as an unknown field, planId or not", async () => {
    const r = await post("/studio/preview", { ...BROLL, campaign: CAMPAIGN });
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 400, body: { field: "campaign" } });
    const both = await post("/studio/preview", { ...BROLL, planId: hers, campaign: CAMPAIGN });
    expect(both.status).toBe(400);
    const bad = await post("/studio/preview", { ...BROLL, planId: "not-a-uuid" });
    expect({ status: bad.status, body: bad.json }).toMatchObject({ status: 400, body: { field: "planId" } });
  });

  it("P-feel / P-donot: her plan's feel, constraints and concept are frozen on the brief and render in the compiled b-roll prompt as fenced data", async () => {
    const r = await post("/studio/preview", { ...BROLL, planId: hers });
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 200 });
    expect(r.json.brief.job.campaign).toMatchObject({
      planId: hers,
      tone: ["calm", "focused"],
      energy: "steady",
      constraints: ["do not show a competitor's logo", "mention @solstice in the caption"],
      concept: "Quiet power — calm: she trains alone at dawn",
      aesthetic: "moody and quiet",
      objective: "showcase-product",
    });
    const prompt = r.json.plan.inputs.prompt as string;
    const fence = prompt.slice(prompt.indexOf("<<<CAMPAIGN>>>"), prompt.indexOf("<<<END_CAMPAIGN>>>"));
    expect(fence).toContain("feel: calm, focused · energy steady");
    expect(fence).toContain("constraint: do not show a competitor's logo");
    expect(fence).toContain("concept: Quiet power — calm: she trains alone at dawn");
    // Frozen on the preview row: what the spend leg replays.
    const [row] = await db.select().from(studioGenerationPreviews);
    expect((row.brief as { job: { campaign: { planId: string } } }).job.campaign.planId).toBe(hers);
  });

  it("R-8: a plan with no brief carries her typed feel alone; with STUDIO_BRAND_PROFILES off a brief's parts are not read", async () => {
    const r = await post("/studio/preview", { ...BROLL, planId: plain });
    expect(r.status).toBe(200);
    expect(r.json.brief.job.campaign).toMatchObject({ tone: [], constraints: [], concept: null, aesthetic: "bright and playful" });
    expect(r.json.plan.inputs.prompt).toContain("how it should feel: bright and playful");
    delete process.env.STUDIO_BRAND_PROFILES;
    const gated = await post("/studio/preview", { ...BROLL, planId: hers });
    expect(gated.status).toBe(200);
    expect(gated.json.brief.job.campaign).toMatchObject({ tone: [], constraints: [], aesthetic: "moody and quiet" });
    expect(gated.json.plan.inputs.prompt).not.toContain("competitor");
  });
});
