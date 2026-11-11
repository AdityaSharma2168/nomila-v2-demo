/**
 * studio.approval.test.ts — clearance through the route, and the §11 one-gesture retraction.
 *
 * studio/approval.test.ts already proves the state machine and the database guards. This suite is
 * about the SURFACE over them, where two different things can go wrong:
 *
 *   1. An illegal transition must be refused, and the UI must be told what IS legal so it never
 *      offers a button that cannot work.
 *   2. Rejecting a still-embedded concept is two ordered database acts (un-embed, then withdraw),
 *      and generationGuards.sql §4 enforces the order. The athlete must never be shown that: not
 *      the trigger's `check_violation`, not the asset uuid, and not the chore of going to clear the
 *      deck herself. She taps Reject once and gets one sentence.
 *
 * PGlite with the real guards applied, exactly as approval.test.ts does. No router mock is needed —
 * nothing in this file generates.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(), rehostFromUrl: jest.fn(),
}));
// The deck's override store lives in the pitch-deck engine, which is out of this lane to touch.
// Faked in memory so unembedConceptFromDeck's picture-then-record ordering runs for real.
jest.mock("../services/cardOverrides", () => {
  const store = new Map<string, any>();
  return {
    __store: store,
    getOverrides: jest.fn(async (a: string, b: number) => store.get(`${a}:${b}`) ?? null),
    saveOverrides: jest.fn(async (a: string, b: number, data: any) => { store.set(`${a}:${b}`, data); }),
  };
});

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { athletes, mediaAssets, mediaKits, kitContent, generationJobs } from "../../shared/schema";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ID   = "99999999-8888-4777-8666-555555555555";
const BRAND_ID   = 4242;

let server: Server;
let base: string;
let jobId: string;

const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };

async function post(path: string) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/** A generated asset in `draft` — what runStudioGeneration leaves behind. */
async function draftAsset(athleteId = ATHLETE_ID): Promise<string> {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "studio", origin: "generated", media_type: "IMAGE",
    status: "stored", approval_status: "draft", generation_job_id: jobId,
    gcs_path: `athletes/${athleteId}/studio/${jobId}/${Math.random()}.png`, content_type: "image/png",
  } as never).returning({ id: mediaAssets.id });
  return row.id;
}

/** A deck for this athlete + brand, with the asset placed in it. Mirrors embedConceptInDeck's writes. */
async function embed(assetId: string, athleteId = ATHLETE_ID): Promise<string> {
  const [kit] = await db.insert(mediaKits).values({
    athlete_id: athleteId, brand_id: BRAND_ID,
    data: { cards: [{ id: "campaignConcept", type: "campaignConcept", image: null }] },
  } as never).returning({ id: mediaKits.id });
  await db.insert(kitContent).values({ media_kit_id: kit.id, asset_id: assetId, position: 0 } as never);
  return kit.id;
}

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "..", "studio", "sql", "generationGuards.sql"), "utf8"));
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" },
    { id: OTHER_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);
  const [job] = await db.insert(generationJobs).values({
    athlete_id: ATHLETE_ID, origin: "system", mode: "generate", objective: "grow-following",
    deliverable: "post", brief: {}, status: "succeeded",
  } as never).returning({ id: generationJobs.id });
  jobId = job.id;

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
  asUser(ATHLETE_ID);
  await db.delete(kitContent);
  await db.delete(mediaKits);
  await db.delete(mediaAssets);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("clearance, forwards", () => {
  it("approves a draft and reports what may legally follow", async () => {
    const assetId = await draftAsset();

    const { status, json } = await post(`/studio/assets/${assetId}/approve`);

    expect(status).toBe(200);
    expect(json.approvalStatus).toBe("approved");
    // From approved the ONLY legal move is rejected — no silent un-approval back to draft.
    expect(json.allowedNext).toEqual(["rejected"]);
  });

  it("refuses to un-approve back to draft, and says what is legal instead", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/approve`);

    const { status, json } = await post(`/studio/assets/${assetId}/reopen`);

    expect(status).toBe(409);
    expect(json.error).toMatch(/approved.*draft|only legal moves/i);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("approved");
  });

  it("refuses one-step rehabilitation: rejected cannot jump to approved", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/reject`);

    const { status } = await post(`/studio/assets/${assetId}/approve`);

    expect(status).toBe(409);
    // The way back is deliberate and two-step.
    const reopened = await post(`/studio/assets/${assetId}/reopen`);
    expect(reopened.json.approvalStatus).toBe("draft");
    const approved = await post(`/studio/assets/${assetId}/approve`);
    expect(approved.json.approvalStatus).toBe("approved");
  });

  it("will not pull an ungated ingested asset into the machine", async () => {
    const [row] = await db.insert(mediaAssets).values({
      athlete_id: ATHLETE_ID, platform: "instagram", origin: "connected", source_media_id: "ig-1",
      media_type: "IMAGE", status: "stored", gcs_path: "athletes/x/1.jpg", content_type: "image/jpeg",
    } as never).returning({ id: mediaAssets.id });

    const { status, json } = await post(`/studio/assets/${row.id}/approve`);

    expect(status).toBe(409);
    expect(json.error).toMatch(/ungated/i);
  });
});

describe("§11 — remove from deck and reject, as ONE gesture", () => {
  it("un-embeds every deck and rejects, in one call", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/approve`);
    const kitId = await embed(assetId);

    const { status, json } = await post(`/studio/assets/${assetId}/reject`);

    expect(status).toBe(200);
    expect(json.approvalStatus).toBe("rejected");
    expect(json.removedFromDecks).toBe(1);
    expect(json.message).toBe("Removed from 1 deck and rejected.");

    // The placement is gone and the clearance is withdrawn — both halves, one tap.
    const placements = await db.select().from(kitContent).where(eq(kitContent.media_kit_id, kitId));
    expect(placements).toHaveLength(0);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("rejected");
  });

  it("NEVER shows the athlete the database's refusal", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/approve`);
    await embed(assetId);

    const { json } = await post(`/studio/assets/${assetId}/reject`);

    const body = JSON.stringify(json);
    // Not the trigger, not the application refusal, not our schema, not the raw id.
    expect(body).not.toMatch(/check_violation/i);
    expect(body).not.toMatch(/kit_content|media_assets|approval_status/i);
    expect(body).not.toMatch(/remove it from the deck/i);
    expect(body).not.toContain(assetId.replace(/-/g, ""));
    expect(body).toMatch(/Removed from 1 deck and rejected\./);
  });

  it("says the plain thing when nothing was embedded", async () => {
    const assetId = await draftAsset();

    const { status, json } = await post(`/studio/assets/${assetId}/reject`);

    expect(status).toBe(200);
    expect(json.removedFromDecks).toBe(0);
    expect(json.message).toBe("Rejected.");
  });

  it("pluralises honestly across two decks", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/approve`);
    await embed(assetId);
    // A second deck for the same athlete, different brand.
    const [kit2] = await db.insert(mediaKits).values({
      athlete_id: ATHLETE_ID, brand_id: BRAND_ID + 1,
      data: { cards: [{ id: "campaignConcept", type: "campaignConcept", image: null }] },
    } as never).returning({ id: mediaKits.id });
    await db.insert(kitContent).values({ media_kit_id: kit2.id, asset_id: assetId, position: 0 } as never);

    const { json } = await post(`/studio/assets/${assetId}/reject`);

    expect(json.removedFromDecks).toBe(2);
    expect(json.message).toBe("Removed from 2 decks and rejected.");
    expect(await db.select().from(kitContent)).toHaveLength(0);
  });

  /**
   * The hardest case for "never show her the database", because here the trigger genuinely fires.
   *
   * THE APP CHECK AND THE DB GUARD HAVE DIFFERENT SCOPES, ON PURPOSE. studio/approval.ts counts
   * embeds through `media_kits.athlete_id`, so it only sees HER decks. generationGuards.sql §4 is
   * `EXISTS (SELECT 1 FROM kit_content WHERE asset_id = NEW.id)` with no athlete predicate at all —
   * it refuses if ANY kit anywhere still holds the asset. That asymmetry is the safe direction (the
   * unbypassable guard is the broader one), but it means the gesture can clear every deck it is
   * allowed to see and still be refused by Postgres.
   *
   * Such a row should not exist — an asset belongs to exactly one athlete — so this is a corrupt
   * state, not a workflow. What is asserted is that a corrupt state still produces a SENTENCE and
   * not a stack trace: no check_violation, no table names, no uuid, and her clearance unchanged.
   */
  it("refuses in plain words — never the trigger's message — if a deck it cannot see still holds the asset", async () => {
    const assetId = await draftAsset();
    await post(`/studio/assets/${assetId}/approve`);
    const mine = await embed(assetId);
    const [foreignKit] = await db.insert(mediaKits).values({
      athlete_id: OTHER_ID, brand_id: BRAND_ID, data: { cards: [] },
    } as never).returning({ id: mediaKits.id });
    await db.insert(kitContent).values({ media_kit_id: foreignKit.id, asset_id: assetId, position: 0 } as never);

    const { status, json } = await post(`/studio/assets/${assetId}/reject`);

    expect(status).toBe(409);
    const body = JSON.stringify(json);
    expect(body).not.toMatch(/check_violation|kit_content|media_assets|approval_status/i);
    expect(body).not.toContain(assetId);
    expect(json.error).toMatch(/retry|nothing has changed/i);

    // Her own deck WAS cleared (the gesture got that far), the foreign one is untouched, and
    // clearance did not move — so a retry after the corrupt row is fixed is safe.
    expect(await db.select().from(kitContent).where(eq(kitContent.media_kit_id, mine))).toHaveLength(0);
    expect(await db.select().from(kitContent).where(eq(kitContent.media_kit_id, foreignKit.id))).toHaveLength(1);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("approved");
  });
});

describe("tenancy and the flag", () => {
  it("another athlete's asset is a 404 from every clearance route", async () => {
    const assetId = await draftAsset(ATHLETE_ID);

    asUser(OTHER_ID);
    for (const verb of ["approve", "reject", "reopen"]) {
      expect((await post(`/studio/assets/${assetId}/${verb}`)).status).toBe(404);
    }

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(row.approval_status).toBe("draft");
  });

  it("a non-uuid asset id is a 404, not a database error", async () => {
    expect((await post(`/studio/assets/not-a-uuid/approve`)).status).toBe(404);
    expect((await post(`/studio/assets/${"'; drop table media_assets; --"}/reject`)).status).toBe(404);
  });

  it("404s the clearance routes when Studio is off", async () => {
    const assetId = await draftAsset();
    process.env.STUDIO_ENABLED = "false";
    expect((await post(`/studio/assets/${assetId}/approve`)).status).toBe(404);
    process.env.STUDIO_ENABLED = "true";
  });
});
