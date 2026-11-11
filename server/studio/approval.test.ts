/**
 * approval.test.ts — the content model: clearance machine, publish gate, lineage.
 *
 * PGlite, so the CHECK constraints, the FKs and the plpgsql trigger are all real Postgres rather
 * than a simulation of one. `initTestDb()` pushes shared/schema.ts; the two pieces Drizzle cannot
 * express (the media_assets → generation_jobs FK, and the trigger) are applied from
 * server/studio/sql/generationGuards.sql — the SAME file migration 0027 embeds.
 *
 * The properties that matter:
 *   1. Every illegal approval transition is REFUSED, by name.
 *   2. Nothing publishes from draft — enforced by the database, verified against a raw INSERT that
 *      bypasses the application entirely.
 *   3. Lineage is recorded for both modes, and differs between them in the one way it should.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, mediaAssets, contentPosts, generationJobs } from "../../shared/schema";
import { setApprovalStatus, allowedNext, isLegalTransition, type ApprovalStatus } from "./approval";
import { createGenerationJob, recordGeneratedAsset, claimJob, succeedJob, failJob, assetsForJob, STUDIO_PLATFORM } from "./jobs";
import type { GenerationPreview } from "./preview";
import { GenerationError } from "./types";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ATHLETE_ID = "99999999-8888-4777-8666-555555555555";

/** A ready preview, hand-built — this suite is about persistence, not about the gate. */
function readyPreview(over: Record<string, unknown> = {}): GenerationPreview {
  return {
    previewId: "prev-1", createdAt: "2026-08-29T00:00:00.000Z",
    status: "ready",
    brief: {
      briefId: "brief-1", createdAt: "2026-08-29T00:00:00.000Z",
      job: {
        origin: "system", objective: "grow-following", deliverable: "post",
        mode: "generate", source: null,
        direction: { set: "chosen", statement: "d", untrusted: false, featuredPieces: [] },
      },
      athlete: { athleteId: ATHLETE_ID, identity: { name: "Test Spike Athlete" } },
      brand: null,
      gaps: [],
    },
    plan: { task: "image.generate", provider: "vertex", model: "gemini-3-pro-image", inputs: { prompt: "p", references: 0, n: 1 }, cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" } },
    references: [], cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" },
    unpriced: false, blockers: [], warnings: [],
    verdict: { canGenerate: true, headline: "Ready to generate", reason: null },
    ...over,
  } as unknown as GenerationPreview;
}

/** An ingested asset — origin 'connected', approval_status NULL. The 561-row case. */
async function seedIngested(athleteId = ATHLETE_ID, i = 0) {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "instagram", origin: "connected",
    source_media_id: `ig-${athleteId}-${i}`, media_type: "IMAGE", status: "stored",
    gcs_path: `athletes/x/${i}.jpg`, content_type: "image/jpeg",
  } as never).returning();
  return row;
}

beforeAll(async () => {
  await initTestDb();
  // The DDL Drizzle cannot express — the same file 0027 embeds verbatim.
  await client.exec(readFileSync(join(__dirname, "sql", "generationGuards.sql"), "utf8"));
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" },
    { id: OTHER_ATHLETE_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);
});

afterAll(async () => { await closeTestDb(); });

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the transition table, as pure logic", () => {
  const ALL: ApprovalStatus[] = ["draft", "approved", "rejected"];
  const LEGAL: Array<[ApprovalStatus, ApprovalStatus]> = [
    ["draft", "approved"], ["draft", "rejected"],
    ["approved", "rejected"],
    ["rejected", "draft"],
  ];

  it.each(LEGAL)("allows %s → %s", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
  });

  it("refuses every transition not in the table", () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    const refused: string[] = [];
    for (const from of ALL) for (const to of ALL) {
      if (from === to) continue;
      if (!legal.has(`${from}->${to}`)) {
        expect(isLegalTransition(from, to)).toBe(false);
        refused.push(`${from}->${to}`);
      }
    }
    // The three that must never be legal: no silent un-approval, no one-step rehabilitation.
    expect(refused.sort()).toEqual(["approved->draft", "rejected->approved"].sort());
  });

  it("reports what a state may become, for a UI that renders only real buttons", () => {
    expect(allowedNext("draft")).toEqual(["approved", "rejected"]);
    expect(allowedNext("approved")).toEqual(["rejected"]);
    expect(allowedNext("rejected")).toEqual(["draft"]);
    expect(allowedNext(null)).toEqual([]);   // ungated content has no buttons at all
  });
});

describe("setApprovalStatus enforces the machine against real rows", () => {
  let jobId: string;
  const draftAsset = async () => {
    const asset = await recordGeneratedAsset({
      athleteId: ATHLETE_ID, jobId, gcsPath: `athletes/gen/${Math.random()}.png`, contentType: "image/png",
    });
    return asset.id as string;
  };

  beforeAll(async () => { jobId = (await createGenerationJob(readyPreview())).id; });

  it("a generated asset is born in draft, never cleared", async () => {
    const id = await draftAsset();
    const [row] = await db.select().from(mediaAssets).where(sql`id = ${id}`);
    expect(row.approval_status).toBe("draft");
    expect(row.origin).toBe("generated");
    expect(row.platform).toBe(STUDIO_PLATFORM);
  });

  it("draft → approved, then approved → rejected as a takedown", async () => {
    const id = await draftAsset();
    expect(await setApprovalStatus(ATHLETE_ID, id, "approved")).toMatchObject({ from: "draft", to: "approved" });
    expect(await setApprovalStatus(ATHLETE_ID, id, "rejected")).toMatchObject({ from: "approved", to: "rejected" });
  });

  it("rejected → draft reopens for another pass", async () => {
    const id = await draftAsset();
    await setApprovalStatus(ATHLETE_ID, id, "rejected");
    expect(await setApprovalStatus(ATHLETE_ID, id, "draft")).toMatchObject({ from: "rejected", to: "draft" });
  });

  it("REFUSES approved → draft — no silent un-approval", async () => {
    const id = await draftAsset();
    await setApprovalStatus(ATHLETE_ID, id, "approved");
    await expect(setApprovalStatus(ATHLETE_ID, id, "draft"))
      .rejects.toThrow(/Illegal approval transition "approved" → "draft"/);
  });

  it("REFUSES rejected → approved — rehabilitation is always two acts", async () => {
    const id = await draftAsset();
    await setApprovalStatus(ATHLETE_ID, id, "rejected");
    await expect(setApprovalStatus(ATHLETE_ID, id, "approved"))
      .rejects.toThrow(/Illegal approval transition "rejected" → "approved"/);
  });

  it("names the legal moves in the refusal", async () => {
    const id = await draftAsset();
    await setApprovalStatus(ATHLETE_ID, id, "approved");
    await expect(setApprovalStatus(ATHLETE_ID, id, "draft")).rejects.toThrow(/only legal moves are: rejected/);
  });

  it("REFUSES moving ungated ingested content into the machine", async () => {
    const ingested = await seedIngested(ATHLETE_ID, 1);
    await expect(setApprovalStatus(ATHLETE_ID, ingested.id as string, "draft"))
      .rejects.toThrow(/is ungated .* and is not in the approval machine/);
  });

  it("refuses a no-op transition rather than pretending something happened", async () => {
    const id = await draftAsset();
    await expect(setApprovalStatus(ATHLETE_ID, id, "draft")).rejects.toThrow(/already "draft"/);
  });

  it("throws GenerationError(invalid_input), not a bare Error", async () => {
    const id = await draftAsset();
    expect.assertions(2);
    try { await setApprovalStatus(ATHLETE_ID, id, "draft"); }
    catch (e) { expect(e).toBeInstanceOf(GenerationError); expect((e as GenerationError).code).toBe("invalid_input"); }
  });

  it("cannot approve another athlete's asset", async () => {
    const id = await draftAsset();
    await expect(setApprovalStatus(OTHER_ATHLETE_ID, id, "approved"))
      .rejects.toThrow(/No asset .* for this athlete/);
    const [row] = await db.select().from(mediaAssets).where(sql`id = ${id}`);
    expect(row.approval_status).toBe("draft");     // untouched
  });

  it("a concurrent transition loses rather than both winning", async () => {
    const id = await draftAsset();
    const [a, b] = await Promise.allSettled([
      setApprovalStatus(ATHLETE_ID, id, "approved"),
      setApprovalStatus(ATHLETE_ID, id, "rejected"),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("nothing publishes from draft — the database says so", () => {
  let jobId: string;
  beforeAll(async () => { jobId = (await createGenerationJob(readyPreview())).id; });

  const gen = async () => (await recordGeneratedAsset({
    athleteId: ATHLETE_ID, jobId, gcsPath: `athletes/gen/${Math.random()}.png`, contentType: "image/png",
  })).id as string;

  it("REFUSES a publish record for a generated draft asset — via a RAW insert that bypasses the app", async () => {
    const id = await gen();
    await expect(
      client.query(`INSERT INTO content_posts (asset_id, platform) VALUES ('${id}', 'instagram')`),
    ).rejects.toThrow(/not approved/);
  });

  it("REFUSES a rejected asset too", async () => {
    const id = await gen();
    await setApprovalStatus(ATHLETE_ID, id, "rejected");
    await expect(
      client.query(`INSERT INTO content_posts (asset_id, platform) VALUES ('${id}', 'instagram')`),
    ).rejects.toThrow(/not approved/);
  });

  it("ALLOWS it once approved", async () => {
    const id = await gen();
    await setApprovalStatus(ATHLETE_ID, id, "approved");
    const [post] = await db.insert(contentPosts)
      .values({ asset_id: id, platform: "instagram", permalink: `https://ig.test/${id}` } as never).returning();
    expect(post.asset_id).toBe(id);
  });

  it("ALLOWS an ingested asset with NULL approval — no retroactive gating of the 561", async () => {
    const ingested = await seedIngested(ATHLETE_ID, 2);
    const [post] = await db.insert(contentPosts)
      .values({ asset_id: ingested.id, platform: "instagram", permalink: `https://ig.test/${ingested.id}` } as never).returning();
    expect(post.asset_id).toBe(ingested.id);
  });

  it("REFUSES an UPDATE that repoints a publish record at unapproved content", async () => {
    const approved = await gen();
    await setApprovalStatus(ATHLETE_ID, approved, "approved");
    const [post] = await db.insert(contentPosts).values({ asset_id: approved, platform: "tiktok" } as never).returning();
    const draft = await gen();
    await expect(
      client.query(`UPDATE content_posts SET asset_id = '${draft}' WHERE id = '${post.id}'`),
    ).rejects.toThrow(/not approved/);
  });

  it("refuses to double-record the same published post", async () => {
    const id = await gen();
    await setApprovalStatus(ATHLETE_ID, id, "approved");
    const permalink = `https://ig.test/dedupe-${id}`;
    await db.insert(contentPosts).values({ asset_id: id, platform: "instagram", permalink } as never);
    await expect(
      db.insert(contentPosts).values({ asset_id: id, platform: "instagram", permalink } as never),
    ).rejects.toThrow();
  });
});

describe("lineage", () => {
  it("an EDIT records the frame it preserved; a GENERATE records none", async () => {
    const source = await seedIngested(ATHLETE_ID, 3);

    const editJob = await createGenerationJob(readyPreview({
      brief: {
        ...readyPreview().brief,
        job: {
          origin: "system", objective: "recap", deliverable: "post", mode: "edit",
          source: { mediaAssetId: source.id, ref: "athletes/x/3.jpg", width: 4000, height: 6000, editRegions: [] },
          direction: { set: "chosen", statement: "d", untrusted: false, featuredPieces: [] },
        },
      },
    }));
    expect(editJob.mode).toBe("edit");
    expect(editJob.source_asset_id).toBe(source.id);

    const edited = await recordGeneratedAsset({
      athleteId: ATHLETE_ID, jobId: editJob.id, gcsPath: "athletes/gen/edit.png",
      contentType: "image/png", derivedFromAssetId: source.id as string,
    });
    expect(edited.derived_from_asset_id).toBe(source.id);
    expect(edited.generation_job_id).toBe(editJob.id);

    const genJob = await createGenerationJob(readyPreview());
    const made = await recordGeneratedAsset({
      athleteId: ATHLETE_ID, jobId: genJob.id, gcsPath: "athletes/gen/new.png", contentType: "image/png",
    });
    expect(made.derived_from_asset_id).toBeNull();
    expect(made.generation_job_id).toBe(genJob.id);
  });

  it("freezes the brief on the job — the record of what was asked", async () => {
    const job = await createGenerationJob(readyPreview());
    expect((job.brief as { briefId: string }).briefId).toBe("brief-1");
    expect(job.cost_estimated_usd).toBe("0.1344");
    expect(job.cost_basis).toBe("estimated");   // never stored as a billed figure
  });

  it("one job can carry several assets, each approved on its own", async () => {
    const job = await createGenerationJob(readyPreview());
    const a = await recordGeneratedAsset({ athleteId: ATHLETE_ID, jobId: job.id, gcsPath: "g/a.png", contentType: "image/png" });
    const b = await recordGeneratedAsset({ athleteId: ATHLETE_ID, jobId: job.id, gcsPath: "g/b.png", contentType: "image/png" });
    await setApprovalStatus(ATHLETE_ID, a.id as string, "approved");
    const rows = await assetsForJob(job.id, ATHLETE_ID);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a.id)!.approval_status).toBe("approved");
    expect(rows.find((r) => r.id === b.id)!.approval_status).toBe("draft");
  });

  it("the database refuses an edit job with no source frame", async () => {
    await expect(client.query(
      `INSERT INTO generation_jobs (athlete_id, origin, mode, objective, deliverable, brief)
       VALUES ('${ATHLETE_ID}', 'system', 'edit', 'recap', 'post', '{}'::jsonb)`,
    )).rejects.toThrow(/generation_jobs_edit_needs_source/);
  });

  it("the database refuses a generate job that carries one", async () => {
    const source = await seedIngested(ATHLETE_ID, 4);
    await expect(client.query(
      `INSERT INTO generation_jobs (athlete_id, origin, mode, objective, deliverable, brief, source_asset_id)
       VALUES ('${ATHLETE_ID}', 'system', 'generate', 'recap', 'post', '{}'::jsonb, '${source.id}')`,
    )).rejects.toThrow(/generation_jobs_edit_needs_source/);
  });

  it("refuses an origin outside the vocabulary", async () => {
    await expect(client.query(
      `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status)
       VALUES ('${ATHLETE_ID}', 'studio', 'invented', 'IMAGE', 'stored')`,
    )).rejects.toThrow(/media_assets_origin_check/);
  });
});

describe("job lifecycle", () => {
  it("claims pending → running exactly once", async () => {
    const job = await createGenerationJob(readyPreview());
    expect(await claimJob(job.id, ATHLETE_ID)).toBe(true);
    expect(await claimJob(job.id, ATHLETE_ID)).toBe(false);   // already running
  });

  it("cannot claim another athlete's job", async () => {
    const job = await createGenerationJob(readyPreview());
    expect(await claimJob(job.id, OTHER_ATHLETE_ID)).toBe(false);
  });

  it("records success and failure with a reason", async () => {
    const ok = await createGenerationJob(readyPreview());
    await succeedJob(ok.id, ATHLETE_ID);
    const bad = await createGenerationJob(readyPreview());
    await failJob(bad.id, ATHLETE_ID, "vertex returned no image data");
    const rows = await db.select().from(generationJobs).where(sql`id in (${ok.id}, ${bad.id})`);
    expect(rows.find((r) => r.id === ok.id)!.status).toBe("succeeded");
    const failed = rows.find((r) => r.id === bad.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toMatch(/no image data/);
  });

  it("refuses to open a job for a blocked preview", async () => {
    await expect(createGenerationJob(readyPreview({
      status: "blocked",
      blockers: [{ field: "brand.pieces[M].reference", note: "no photo", severity: "blocking" }],
    }))).rejects.toThrow(/Refusing to open a job for a blocked preview/);
  });
});

describe("migration 0027 and the guards file cannot drift", () => {
  it("0027 embeds generationGuards.sql verbatim", () => {
    const guards = readFileSync(join(__dirname, "sql", "generationGuards.sql"), "utf8");
    const migration = readFileSync(join(__dirname, "..", "..", "migrations", "0027_studio_generation.sql"), "utf8");
    expect(migration).toContain(guards);
  });
});
