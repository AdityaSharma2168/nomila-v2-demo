/**
 * studio.test.ts — the Studio Content Engine's read surface, end to end against in-memory Postgres.
 *
 * The things this suite exists to prove are all TENANCY, because both routes are the A2-class
 * boundary:
 *
 *   1. The preview's subject is the TOKEN'S athlete and nothing else. An `athleteId` in the body is
 *      not honoured (it is not even in the type), and a `sourceAssetId` belonging to someone else
 *      resolves to nothing rather than to their photo — with their storage path never echoed back.
 *   2. The content read is scoped through `media_assets.athlete_id`, which is the ONLY column in
 *      this feature that carries ownership. `content_posts` has none, so a second athlete's publish
 *      record must not reach the first athlete even when it hangs off a row this query joins.
 *   3. The BRAND a piece was made for comes from `generation_jobs`, reached by a column with no
 *      foreign key behind it — so an asset pointing at another athlete's job must read a null brand
 *      rather than name their partner. That is the "brand a piece was made for" block below.
 *
 * Everything else here is guard-rail: the flag, the vocabulary allowlists, the intent/format pair
 * rule, and the invariant that a PRE-check writes nothing and spends nothing.
 *
 * The adapters are NOT mocked, deliberately — `estimate()` is pure arithmetic over the config price
 * table and touches no network and no credentials, so the cost figures asserted below are the real
 * ones. Only Vertex's client construction (pulled in transitively by services/shotList) and GCS URL
 * signing are stubbed.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
// services/shotList builds a GoogleGenAI client at module load; the real getBrandContext below is a
// plain SELECT and runs for real against PGlite.
jest.mock("../lib/models", () => ({
  genai: () => ({}),
  GEMINI: { pro: "test-pro", flash: "test-flash", flashLite: "test-flash-lite" },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
}));
// PR 19 (ADI-R19-BOARD4): the door reads an unread photo on the spot through the enrichment cron's own unit. The two
// calls it makes are the network boundary, mocked here: by default the read fails (as it would with no network), and
// the test that reads says what the tagger answers.
jest.mock("../lib/visionTag", () => ({
  ...jest.requireActual("../lib/visionTag"),
  tagAsset: jest.fn(async () => null),
}));
jest.mock("../lib/mediaEmbed", () => ({
  ...jest.requireActual("../lib/mediaEmbed"),
  embedImageGcsWithReason: jest.fn(async () => ({ ok: false, reason: "other" })),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import {
  athletes, athletesCurrent, contentPosts, dealDeliverables, deals, generationJobs, inboxBrands,
  mediaAssets, studioGenerationPreviews,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { MAX_REGIONS } from "../studio/geometry";
import { plannedInputs } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import { tagAsset, type AssetTags } from "../lib/visionTag";
import { embedImageGcsWithReason } from "../lib/mediaEmbed";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;
let brandId: number;

const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };

/** A scored athlete — getAthleteContext requires an athletes_current row or it throws. */
async function seedScoredAthlete(name: string): Promise<string> {
  const id = await seedAthlete(name);
  await db.update(athletes)
    .set({ sport: "Soccer", school: "Test University", division: "D1" } as any)
    .where(eq(athletes.id, id));
  await db.insert(athletesCurrent).values({
    athlete_id: id,
    story_arc: "A synthetic arc for tests.",
  } as any);
  return id;
}

async function seedAsset(
  owner: string,
  over: Partial<{ origin: string; status: string; deleted: boolean; caption: string; approval: string | null }> = {},
): Promise<string> {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: owner,
    platform: "instagram",
    origin: over.origin ?? "generated",
    media_type: "IMAGE",
    status: over.status ?? "stored",
    gcs_path: `athletes/${owner}/asset-${Math.random().toString(36).slice(2)}.jpg`,
    caption: over.caption ?? null,
    approval_status: over.approval === undefined ? "draft" : over.approval,
    deleted_at: over.deleted ? new Date() : null,
  } as any).returning({ id: mediaAssets.id });
  return row.id;
}

// ─── The source-frame probe, served synthetically ───────────────────────────────────────────────
//
// resolveSource measures the real frame by signing a read url and asking for its first 256KB
// (studio/imageSize.ts). The mock above turns a gcs path into `https://signed.example/<path>`, so
// this intercepts exactly those urls and answers with a JPEG header of whatever size the test
// registered — every other fetch, including the requests to the express server under test, goes
// through untouched. That keeps the whole mapping path REAL: the route signs, ranges, parses and
// multiplies for itself, and only the bytes are synthetic.
const FRAMES = new Map<string, { width: number; height: number } | "unreadable">();
const realFetch = globalThis.fetch;

/**
 * A minimal but genuinely well-formed baseline JPEG header: SOI, one SOF0 segment, then SOS.
 * The length field covers itself plus the 6-byte payload — 8, not the payload alone.
 */
function jpegBytes(width: number, height: number): Buffer {
  const sof = Buffer.alloc(10);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(8, 2);            // 2 (this field) + 6 (payload below)
  sof.writeUInt8(8, 4);               // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);               // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda])]);
}

beforeAll(() => {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.startsWith("https://signed.example/")) {
      const path = decodeURIComponent(url.slice("https://signed.example/".length));
      const frame = FRAMES.get(path);
      if (!frame) return new Response(null, { status: 404 });
      const body = frame === "unreadable"
        ? Buffer.from("not an image at all, just a letter to a brand")
        : jpegBytes(frame.width, frame.height);
      // Uint8Array rather than Buffer: BodyInit accepts the former, and a Buffer IS one.
      return new Response(new Uint8Array(body), { status: 206 });
    }
    return realFetch(input, init);
  };
});
afterAll(() => { (globalThis as any).fetch = realFetch; });

/** Seed an asset AND declare the pixel dimensions its stored object will report. */
async function seedFrame(
  owner: string,
  frame: { width: number; height: number } | "unreadable" = { width: 4000, height: 6000 },
): Promise<{ id: string; path: string }> {
  const id = await seedAsset(owner, { origin: "upload" });
  const [row] = await db.select({ path: mediaAssets.gcs_path })
    .from(mediaAssets).where(eq(mediaAssets.id, id));
  FRAMES.set(row.path!, frame);
  return { id, path: row.path! };
}

/** One valid region: a tight box at the centre of the frame. */
const REGION = { label: "the logo on the ball", left: 0.5, top: 0.5, width: 0.1, height: 0.1 };

const editReq = (sourceAssetId: string, regions?: unknown) => ({
  intent: "image.edit", deliverable: "post", objective: "grow-following",
  sourceAssetId, ...(regions === undefined ? {} : { regions }),
});

const post = (body: unknown) =>
  fetch(`${base}/studio/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const getContent = (qs = "") => fetch(`${base}/studio/content${qs}`);
const getDeliverables = (qs = "") => fetch(`${base}/studio/deliverables${qs}`);

/** A valid, minimal net-new image request. */
const IMAGE_REQ = { intent: "image.generate", deliverable: "post", objective: "grow-following" };

beforeAll(async () => {
  process.env.STUDIO_ENABLED = "true";
  await initTestDb();

  athleteId      = await seedScoredAthlete("Test Athlete");
  otherAthleteId = await seedScoredAthlete("Other Athlete");
  asUser(athleteId);

  const [brand] = await db.insert(inboxBrands)
    .values({ name: "Testwear", normalized_name: "testwear", category: "apparel" } as any)
    .returning({ id: inboxBrands.id });
  brandId = brand.id;

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

beforeEach(() => {
  process.env.STUDIO_ENABLED = "true";
  asUser(athleteId);
});

// ─── The flag ───────────────────────────────────────────────────────────────────────────────────

describe("the feature flag", () => {
  it("404s both routes when STUDIO_ENABLED is off", async () => {
    process.env.STUDIO_ENABLED = "false";
    expect((await post(IMAGE_REQ)).status).toBe(404);
    expect((await getContent()).status).toBe(404);
  });

  it("is read at call time, so flipping it needs no restart", async () => {
    process.env.STUDIO_ENABLED = "false";
    expect((await getContent()).status).toBe(404);
    process.env.STUDIO_ENABLED = "true";
    expect((await getContent()).status).toBe(200);
  });
});

// ─── Tenancy: the preview's subject ─────────────────────────────────────────────────────────────

describe("preview tenancy", () => {
  it("IGNORES an athleteId in the body — the subject is the authenticated athlete", async () => {
    const res = await post({ ...IMAGE_REQ, athleteId: otherAthleteId });
    expect(res.status).toBe(200);

    const body = await res.json();
    // The brief is built for whoever the TOKEN names, never for whoever the body names.
    expect(body.brief.athlete.athleteId).toBe(athleteId);
    expect(body.brief.athlete.athleteId).not.toBe(otherAthleteId);
    expect(JSON.stringify(body)).not.toContain(otherAthleteId);
  });

  it("refuses a sourceAssetId belonging to another athlete, and never echoes its path", async () => {
    const theirAsset = await seedAsset(otherAthleteId, { origin: "upload" });
    const [row] = await db.select({ path: mediaAssets.gcs_path })
      .from(mediaAssets).where(eq(mediaAssets.id, theirAsset));

    const res = await post({
      intent: "image.edit", deliverable: "post", objective: "grow-following", sourceAssetId: theirAsset,
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(row.path!);       // the storage path must not leak
    expect(text).not.toContain(otherAthleteId);
  });

  /**
   * ─── ⚠️  THE LAST FRAME IS AN ID AND ITS OWNERSHIP IS DECIDED HERE ───────────────────────────
   *
   * MUTATION: drop `eq(mediaAssets.athlete_id, athleteId)` from `readOwnedImage`, or resolve
   * `lastFrameAssetId` without going through it. This test reds.
   *
   * It is the same boundary `sourceAssetId` has, and it matters MORE rather than less: this id
   * names a photograph that is sent to a paid provider as the frame a clip renders TOWARD, so a
   * client that could name someone else's asset would be commissioning a video of their face.
   */
  it("refuses a lastFrameAssetId belonging to another athlete, and never echoes its path", async () => {
    const theirAsset = await seedAsset(otherAthleteId, { origin: "upload" });
    const [row] = await db
      .select({ path: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, theirAsset));

    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
      lastFrameAssetId: theirAsset,
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    // The storage path must not leak, and neither must the fact that their asset exists — the
    // sentence is the same one a bad reference gets, deliberately.
    expect(text).not.toContain(row.path!);
    expect(text).not.toContain(otherAthleteId);
  });

  it("takes her OWN last frame from the ROW, and keeps it off the wire", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const [row] = await db
      .select({ path: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, mine));

    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
      lastFrameAssetId: mine,
    });
    expect(res.status).toBe(200);
    const { previewId } = await res.json();

    // ⚠️ THE RESPONSE DELIBERATELY DOES NOT ECHO THE PATH — `plan.inputs` is a summary, which is
    // why an earlier draft of this test asserting the path was IN the response failed. That draft
    // would have pinned a leak as a feature.

    // ⚠️ WHAT TRAVELS IS THE ROW'S PATH, and the frozen preview row is where that is observable.
    // A signed url here would be a credential frozen into a row that outlives it; the body's own
    // string would be a path a client named.
    //
    // ⚠️ IT IS ON THE FROZEN BRIEF, NOT ON THE PLAN. `GenerationPlan.inputs` is a deliberate summary
    // — `references` is a COUNT and no path is stored there — which is exactly why an earlier draft
    // of this test, reading plan.inputs.lastFrame, could never have passed. The brief is the object
    // the spend leg replays, so the brief is the only place this value can honestly live.
    const [saved] = await db
      .select({ brief: studioGenerationPreviews.brief })
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, previewId));
    const lastFrame = (
      saved.brief as { job?: { lastFrame?: { ref?: string } } }
    )?.job?.lastFrame;
    expect(lastFrame?.ref).toBe(row.path);
    expect(lastFrame?.ref).not.toContain("https://");
  });

  it("a last frame makes the clip a TRANSITION, which is what the field is for", async () => {
    // ⚠️ THE FLAG IS ON BECAUSE THERE IS NO PLAN WITHOUT IT. `withVideoAvailability` nulls the plan
    // for a clip that cannot run, which is the behaviour the tests above pin — so a test that wants
    // to inspect the ROUTE has to ask for a preview that could actually run.
    process.env.STUDIO_VIDEO_ENABLED = "true";
    // videoRouteFor("transition") and its template have existed since V9/V10 with nothing able to
    // fill the field that selects them. This is the first caller that can, and the two observable
    // consequences are the ROUTE and the PROMPT.
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
      lastFrameAssetId: mine,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Kling, not Veo — the identity route cannot carry a last frame (vertex.ts), so a transition
    // reaching it would lose its destination and bill an ordinary clip under a bridge's name.
    expect(body.plan.model).toContain("kling");
    // The transition template's spine, which is the probe's own measured sentence.
    expect(body.plan.inputs.prompt).toContain(
      "A single continuous live-action shot of her, moving naturally.",
    );
    // …and NOT the identity template's scene lock, which would fight the frame it was handed.
    expect(body.plan.inputs.prompt).not.toContain("background stay unchanged");
    delete process.env.STUDIO_VIDEO_ENABLED;
  });

  it("without one, the same clip is NOT a transition", async () => {
    // ⚠️ THE FLAG IS ON BECAUSE THERE IS NO PLAN WITHOUT IT. `withVideoAvailability` nulls the plan
    // for a clip that cannot run, which is the behaviour the tests above pin — so a test that wants
    // to inspect the ROUTE has to ask for a preview that could actually run.
    process.env.STUDIO_VIDEO_ENABLED = "true";
    // The additive property, asserted rather than assumed: absent the field, this request is
    // byte-identical to what it was before the field existed.
    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.model).not.toContain("kling");
    expect(body.plan.inputs.prompt).not.toContain(
      "A single continuous live-action shot of her, moving naturally.",
    );
    delete process.env.STUDIO_VIDEO_ENABLED;
  });

  /**
   * ⚠️ ADDITIVE, AND THIS IS THE ONLY PLACE IT CAN BE PROVEN.
   *
   * MUTATION: make `assembleBrief` write `lastFrame: input.lastFrame` unconditionally. This reds —
   * and a hand-built-brief test in preview.test.ts did NOT, which is why this lives here: the
   * guarantee is about what `assembleBrief` FREEZES INTO THE ROW, and only a round trip sees that.
   *
   * Previews are jsonb with a TTL and the spend leg re-derives from the stored object, so a check
   * taken before this field shipped can be spent against after. `lastFrame: undefined` would put a
   * key on every brief in the table and make "frozen before this existed" indistinguishable from
   * "explicitly none".
   */
  it("a request with no last frame freezes a brief with no such KEY", async () => {
    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
    });
    expect(res.status).toBe(200);
    const { previewId } = await res.json();

    const [saved] = await db
      .select({ brief: studioGenerationPreviews.brief })
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, previewId));
    const job = (saved.brief as { job: Record<string, unknown> }).job;
    // Not `undefined` under the key — ABSENT.
    expect("lastFrame" in job).toBe(false);
    expect(JSON.stringify(saved.brief)).not.toContain("lastFrame");
  });

  /**
   * ─── ⚠️  A PREVIEW MUST NOT PRICE A JOB THAT CANNOT RUN ──────────────────────────────────────
   *
   * MUTATION: check the flag only at run time — delete `withVideoAvailability` from `humanize`, or
   * return the preview untouched from it. This reds.
   *
   * `assertVideoEnabled` lived in runStudioGeneration alone, so a clip previewed clean with the flag
   * off: ready, quoted, button enabled — and refused the instant she approved. A two-shot storyboard
   * said $1.60 and told her it was ready, and only the press found the wall. Same family as the
   * quote/run drift: what she is shown must be what happens.
   */
  it("a video preview with the flag OFF is unavailable and quotes nothing", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    const res = await post({
      intent: "video.generate",
      deliverable: "clip",
      objective: "grow-following",
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // `unavailable`, not a blocker: the field's own header says it is for a capability WE are
    // missing, and a red refusal about her brief would be the lie it exists to prevent.
    expect(body.unavailable?.reason).toMatch(/isn't switched on yet/i);
    expect(body.verdict.canGenerate).toBe(false);

    // ⚠️ AND NO FIGURE. A ceiling beside "not available" is a price for a job that will not happen,
    // and the storyboard sums whatever it is handed — the quote would still have read $1.60, in
    // smaller type. `unpriced`, never $0.00, which reads as free.
    expect(body.cost).toBeNull();
    expect(body.unpriced).toBe(true);
    expect(JSON.stringify(body)).not.toContain("amountUsd");
  });

  it("with the flag ON, a video preview quotes and is not unavailable", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const res = await post({
        intent: "video.generate",
        deliverable: "clip",
        objective: "grow-following",
      });
      const body = await res.json();
      // Additive: flag on is exactly what it was before this existed.
      expect(body.unavailable).toBeNull();
      expect(body.verdict.canGenerate).toBe(true);
      expect(body.cost.amountUsd).toBeGreaterThan(0);
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  it("an IMAGE preview is untouched by the video flag", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    const res = await post(IMAGE_REQ);
    const body = await res.json();
    expect(body.unavailable).toBeNull();
    expect(body.cost.amountUsd).toBeGreaterThan(0);
  });

  /**
   * ─── ⚠️  THE MONEY TEST, SERVER HALF ──────────────────────────────────────────────────────────
   *
   * Two paid boards ran every b-roll shot on Veo at $0.80, a 2.18x overcharge against seedance's
   * $0.3667, because the client sent `role: "person"` for every row. `shotTypeFor` reads that one
   * field and nothing else. This pins the consequence end to end: what the brief FREEZES, where it
   * routes, and that the cheaper arm is actually cheaper.
   *
   * MUTATION: send "person" for a b-roll row. All three assertions red.
   */
  it("an OBJECT reference routes b-roll to seedance, and freezes that role on the brief", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const mine = await seedAsset(athleteId, { origin: "upload" });
      const res = await post({
        intent: "video.generate",
        deliverable: "clip",
        objective: "grow-following",
        references: [{ assetId: mine, role: "object" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.plan.model).toContain("seedance");
      expect(body.plan.model).not.toContain("veo");

      // ⚠️ THE FROZEN ROLE. The brief is the provenance record and the thing the spend leg replays,
      // so a role that drifted here would re-route the run away from the quote.
      const [saved] = await db
        .select({ brief: studioGenerationPreviews.brief })
        .from(studioGenerationPreviews)
        .where(eq(studioGenerationPreviews.id, body.previewId));
      const refs = (saved.brief as { job: { references: { role: string }[] } })
        .job.references;
      expect(refs.map((r) => r.role)).toEqual(["object"]);
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  it("a PERSON reference routes to Veo, and costs more than the b-roll arm", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const mine = await seedAsset(athleteId, { origin: "upload" });
      const req = (role: string) => ({
        intent: "video.generate",
        deliverable: "clip",
        objective: "grow-following",
        references: [{ assetId: mine, role }],
      });
      const identity = await (await post(req("person"))).json();
      const broll = await (await post(req("object"))).json();

      expect(identity.plan.model).toContain("veo");
      // The whole reason the kind exists. If these ever converge, the pill is decorative again.
      expect(identity.cost.amountUsd).toBeGreaterThan(broll.cost.amountUsd);
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  /**
   * ⚠️ ZERO REFERENCES — the text-to-video arm (#6). Measured on this same walk rather than assumed:
   * the chain tolerates an empty references array end to end, and the t2v arm quotes EXACTLY what
   * i2v b-roll quotes, because seedance bills `w x h x frames / 1024` and an input image is not a
   * term in that. So the quote-matches-run invariant holds for the image-less arm for free.
   */
  it("a clip with NO references is b-roll on seedance, and quotes the same as i2v b-roll", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const mine = await seedAsset(athleteId, { origin: "upload" });
      const t2v = await (
        await post({
          intent: "video.generate",
          deliverable: "clip",
          objective: "grow-following",
        })
      ).json();
      const i2v = await (
        await post({
          intent: "video.generate",
          deliverable: "clip",
          objective: "grow-following",
          references: [{ assetId: mine, role: "object" }],
        })
      ).json();

      expect(t2v.verdict.canGenerate).toBe(true);
      expect(t2v.plan.model).toContain("seedance");
      expect(t2v.plan.inputs.references).toBe(0);
      expect(t2v.cost.amountUsd).toBe(i2v.cost.amountUsd);
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  it("is ignored on an image task rather than refused twice", async () => {
    // plannedInputs enforces video-only behind its isVideo guard. A second rule here would be the
    // same rule in a second place, and the two would eventually disagree.
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await post({ ...IMAGE_REQ, lastFrameAssetId: mine });
    expect(res.status).toBe(200);
  });

  it("accepts her OWN asset and builds the source from the row, not the request", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const [row] = await db.select({ path: mediaAssets.gcs_path })
      .from(mediaAssets).where(eq(mediaAssets.id, mine));

    const res = await post({
      intent: "image.edit", deliverable: "post", objective: "grow-following", sourceAssetId: mine,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.job.mode).toBe("edit");
    // The ref is the stored PATH from the row — never a signed url, which would be a credential.
    expect(body.brief.job.source.ref).toBe(row.path);
    expect(body.brief.job.source.ref).not.toContain("https://");
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────────────────────────

describe("request validation", () => {
  it("rejects an unknown intent", async () => {
    const res = await post({ ...IMAGE_REQ, intent: "image.upscale" });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("intent");
  });

  it("rejects an unknown objective and an unknown deliverable", async () => {
    expect((await post({ ...IMAGE_REQ, objective: "go-viral" })).status).toBe(400);
    expect((await post({ ...IMAGE_REQ, deliverable: "billboard" })).status).toBe(400);
  });

  it("rejects motion under an image intent", async () => {
    const res = await post({ ...IMAGE_REQ, deliverable: "reel" });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("deliverable");
  });

  it("rejects a still under a video intent", async () => {
    const res = await post({ intent: "video.generate", deliverable: "post", objective: "grow-following" });
    expect(res.status).toBe(400);
  });

  it("requires a source for an edit and forbids one otherwise", async () => {
    const noSource = await post({ intent: "image.edit", deliverable: "post", objective: "grow-following" });
    expect(noSource.status).toBe(400);
    expect((await noSource.json()).field).toBe("sourceAssetId");

    const mine = await seedAsset(athleteId, { origin: "upload" });
    const strayCarry = await post({ ...IMAGE_REQ, sourceAssetId: mine });
    expect(strayCarry.status).toBe(400);
  });

  it("clamps an absurd clip duration rather than quoting it", async () => {
    const res = await post({
      intent: "video.generate", deliverable: "clip", objective: "grow-following", durationSeconds: 99999,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("durationSeconds");
  });

  /**
   * THE CAP IS 8 NOW, NOT 60, AND 30 IS THE CASE THAT TELLS THEM APART.
   *
   * 99999 above was refused by either version, so it never proved which ceiling was in force. Veo
   * serves 4/6/8 seconds; the old `MAX_CLIP_SECONDS = 60` would have QUOTED a 30s clip at $12.00
   * with audio, taken her approval for it, and only then had Vertex refuse the request — after the
   * spend gate had burnt the approval on a job that could never run.
   */
  it("refuses a 30s clip the old 60s ceiling would have quoted, and says what it will serve", async () => {
    const res = await post({
      intent: "video.generate", deliverable: "clip", objective: "grow-following", durationSeconds: 30,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("durationSeconds");
    expect(body.error).toContain("8");     // the ceiling actually in force
    expect(body.error).not.toContain("60");
  });

  /**
   * ⚠️ QUOTE-MATCHES-RUN, FOR DURATION. The kind → role class of defect, in the price term.
   *
   * MUTATION: in the route, pass `durationSeconds` to `previewGeneration` as an OPTION again instead
   * of freezing it on the brief. This reds — and nothing else did, which is how it shipped: the
   * quote read the option (8s, $1.60), the spend leg replays the brief with `{}`
   * (`videoRunner.inputsFor`), and the run fell back to DEFAULT_CLIP_SECONDS.
   *
   * So the replay is performed HERE, the way the runner performs it — the saved brief, no options —
   * and compared with what she was shown. Asserting only that the response says 8 would pass under
   * the exact bug.
   */
  it("quote-matches-run: the duration she was quoted is the duration the frozen brief replays", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    const res = await post({
      intent: "video.generate", deliverable: "clip", objective: "grow-following", durationSeconds: 8,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.inputs.durationSeconds).toBe(8);

    const [saved] = await db
      .select({ brief: studioGenerationPreviews.brief })
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, body.previewId));
    const replayed = plannedInputs(saved.brief as unknown as CreativeBrief, {});
    expect(replayed.inputs.durationSeconds).toBe(body.plan.inputs.durationSeconds);
    delete process.env.STUDIO_VIDEO_ENABLED;
  });

  /**
   * MUTATION: drop the `VIDEO_DELIVERABLES` guard in the route, so a still freezes the duration it
   * happened to send. This reds.
   *
   * ⚠️ WHAT THIS TEST CANNOT SEE, measured rather than assumed: the OTHER absent-key mutation —
   * `assembleBrief` writing `durationSeconds: input.durationSeconds` unconditionally — passes here,
   * because jsonb drops an `undefined` value on the way into the row. That one is pinned against
   * `assembleBrief`'s own return value, in brief.test.ts.
   */
  it("a clip with no duration, and a STILL with one, freeze a brief with no such KEY", async () => {
    for (const req of [
      { intent: "video.generate", deliverable: "clip", objective: "grow-following" },
      { ...IMAGE_REQ, durationSeconds: 8 },
    ]) {
      const res = await post(req);
      expect(res.status).toBe(200);
      const { previewId } = await res.json();
      const [saved] = await db
        .select({ brief: studioGenerationPreviews.brief })
        .from(studioGenerationPreviews)
        .where(eq(studioGenerationPreviews.id, previewId));
      expect("durationSeconds" in (saved.brief as { job: object }).job).toBe(false);
    }
  });

  /**
   * ⚠️ THE SAME ROUND TRIP DURATION NEEDED, IN THE TERM THAT DOUBLES THE BILL.
   *
   * Asserting only that the response mentions sound would pass under the exact bug this closes: the
   * quote read an option, the spend leg replays the frozen brief with `{}` (`videoRunner.inputsFor`),
   * and the flag was gone by the time the money moved — a clip quoted on Veo's $0.40/s arm and run
   * silent. So the replay is performed HERE, the way the runner performs it, and compared with what
   * she was shown.
   *
   * MUTATION: pass `audio` to `assembleBrief` as an option instead of freezing it on the brief. This
   * reds.
   */
  it("quote-matches-run: the sound she was quoted is the sound the frozen brief replays", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const res = await post({
        intent: "video.generate", deliverable: "clip", objective: "grow-following",
        durationSeconds: 6, audio: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const [saved] = await db
        .select({ brief: studioGenerationPreviews.brief })
        .from(studioGenerationPreviews)
        .where(eq(studioGenerationPreviews.id, body.previewId));
      const brief = saved.brief as unknown as CreativeBrief;
      expect(brief.job.audio).toBe(true);

      const replayed = plannedInputs(brief, {});
      const params = replayed.providerParams as {
        parameters: { generateAudio: boolean };
      };
      expect(params.parameters.generateAudio).toBe(true);

      // And b-roll sound is FREE, through the real pricer rather than a fixture: seedance is
      // token-priced with no audio arm, so the figure she approved is the figure without it.
      const silent = await (
        await post({
          intent: "video.generate", deliverable: "clip", objective: "grow-following",
          durationSeconds: 6,
        })
      ).json();
      expect(body.cost.amountUsd).toBe(silent.cost.amountUsd);
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  /**
   * MUTATION: drop the `VIDEO_DELIVERABLES` guard on `audio` in the route, so a still freezes the
   * sound it happened to send. This reds.
   *
   * The absent-KEY half that jsonb hides is pinned on `assembleBrief`'s own return, in brief.test.ts
   * — the same split durationSeconds needed.
   */
  it("a clip with no sound, and a STILL with sound, freeze a brief with no such KEY", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      for (const req of [
        { intent: "video.generate", deliverable: "clip", objective: "grow-following" },
        { ...IMAGE_REQ, audio: true },
      ]) {
        const res = await post(req);
        expect(res.status).toBe(200);
        const { previewId } = await res.json();
        const [saved] = await db
          .select({ brief: studioGenerationPreviews.brief })
          .from(studioGenerationPreviews)
          .where(eq(studioGenerationPreviews.id, previewId));
        expect("audio" in (saved.brief as { job: object }).job).toBe(false);
      }
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  /**
   * ─── THE SHOT SLOTS: EVERY HOP, THROUGH THE REAL ROUTE ───────────────────────────────────────
   *
   * The kind → role lesson is that a field which dies between the row and the brief produces no
   * error — so these go request → parser → BriefInput → assembleBrief → frozen row → REPLAY, and
   * assert at the far end.
   *
   * MUTATION: leave `shot` out of `parsePreviewBody`'s return literal (the allow-list). Reds.
   * MUTATION: leave it out of the BriefInput the handler builds. Reds.
   * MUTATION: read the slot from an OPTION in the compiler instead of the brief. The replay reds.
   */
  it("quote-matches-run: a slot she set is in the prompt she was quoted AND the prompt the frozen brief replays", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    const res = await post({
      intent: "video.generate", deliverable: "clip", objective: "grow-following",
      direction: "An empty stadium at dusk.",
      shot: { movement: "orbit", environment: "stadium", lighting: "golden-hour" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.inputs.prompt).toContain("slow arc around the scene");
    expect(body.plan.inputs.prompt).toContain("The setting is a stadium.");

    const [saved] = await db
      .select({ brief: studioGenerationPreviews.brief })
      .from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, body.previewId));
    expect((saved.brief as { job: { shot?: object } }).job.shot).toEqual({
      movement: "orbit", lighting: "golden-hour", environment: "stadium",
    });
    // The run leg, performed the way the runner performs it: the saved brief, no options.
    const replayed = plannedInputs(saved.brief as unknown as CreativeBrief, {});
    expect(replayed.inputs.prompt).toBe(body.plan.inputs.prompt);
    delete process.env.STUDIO_VIDEO_ENABLED;
  });

  // She tapped a chip; she must not be quoted for a clip that ignores it.
  it("400s an unknown slot VALUE and an unknown slot NAME — never a silent drop", async () => {
    const clip = { intent: "video.generate", deliverable: "clip", objective: "grow-following" };
    const badValue = await post({ ...clip, shot: { movement: "dolly-zoom" } });
    expect(badValue.status).toBe(400);
    expect((await badValue.json()).field).toBe("shot.movement");

    const badName = await post({ ...clip, shot: { lens: "50mm" } });
    expect(badName.status).toBe(400);
    expect((await badName.json()).field).toBe("shot.lens");

    expect((await post({ ...clip, shot: "wide" })).status).toBe(400);
  });

  it("no slots, an empty spec, and a STILL with slots all freeze a brief with no `shot` key", async () => {
    for (const req of [
      { intent: "video.generate", deliverable: "clip", objective: "grow-following" },
      { intent: "video.generate", deliverable: "clip", objective: "grow-following", shot: {} },
      { ...IMAGE_REQ, shot: { movement: "orbit" } },
    ]) {
      const res = await post(req);
      expect(res.status).toBe(200);
      const { previewId } = await res.json();
      const [saved] = await db
        .select({ brief: studioGenerationPreviews.brief })
        .from(studioGenerationPreviews)
        .where(eq(studioGenerationPreviews.id, previewId));
      expect("shot" in (saved.brief as { job: object }).job).toBe(false);
    }
  });

  // The compiler's refusal has to arrive as a blocker she can read, not as a 500 or an empty plan.
  it("a slot the photo already decides comes back as a blocker in her words", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await post({
      intent: "video.generate", deliverable: "clip", objective: "grow-following",
      references: [{ assetId: mine, role: "person" }],
      shot: { lighting: "overcast" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body.blockers ?? body)).toContain("starts from a photo");
    delete process.env.STUDIO_VIDEO_ENABLED;
  });

  it("still accepts the lengths Veo really serves", async () => {
    for (const durationSeconds of [4, 6, 8]) {
      const res = await post({
        intent: "video.generate", deliverable: "clip", objective: "grow-following", durationSeconds,
      });
      expect(res.status).toBe(200);
    }
  });

  it("404s an unknown brand but ACCEPTS a brand she has no relationship with (spec-pitch)", async () => {
    expect((await post({ ...IMAGE_REQ, brandId: 999999 })).status).toBe(404);

    // brandId exists and belongs to nobody in particular — inbox_brands is a global catalog.
    const res = await post({ ...IMAGE_REQ, brandId, objective: "showcase-product" });
    expect(res.status).toBe(200);
    expect((await res.json()).brief.brand.name).toBe("Testwear");
  });
});

// ─── The verdict ────────────────────────────────────────────────────────────────────────────────

describe("the pre-check", () => {
  it("returns a routed plan with an ESTIMATED cost and spends nothing", async () => {
    const before = await db.select().from(generationJobs);

    const res = await post(IMAGE_REQ);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.plan).not.toBeNull();
    expect(body.plan.task).toBe("image.generate");
    expect(body.cost.basis).toBe("estimated");     // never a billed figure
    expect(body.status).toBe("ready");
    expect(body.verdict.canGenerate).toBe(true);
    expect(body.unavailable).toBeNull();

    // A pre-check is a check. It must not have created a job.
    expect((await db.select().from(generationJobs)).length).toBe(before.length);
  });

  it("carries her typed brief through as the direction, trusted and undelimited", async () => {
    const res = await post({ ...IMAGE_REQ, direction: "mid-stride, hard evening light" });
    const body = await res.json();

    expect(body.brief.job.direction.statement).toBe("mid-stride, hard evening light");
    expect(body.brief.job.direction.set).toBe("chosen");
    // Her own words about her own generation are not an injection vector against herself.
    expect(body.brief.job.direction.untrusted).toBe(false);
    expect(body.plan.inputs.prompt).toContain("mid-stride, hard evening light");
  });

  it("falls back to the objective's goal when the brief is blank", async () => {
    const res = await post({ ...IMAGE_REQ, direction: "   " });
    const body = await res.json();
    expect(body.brief.job.direction.statement).toContain("Grow her audience");
  });

  it("asks for a region when an edit arrives without one — HER step, not our missing capability", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await post({
      intent: "image.edit", deliverable: "post", objective: "grow-following", sourceAssetId: mine,
    });

    const body = await res.json();
    expect(body.status).toBe("blocked");
    // U3 SHIPPED THE MASK EDITOR, so this stopped being a capability we lack. Before U3 this route
    // hoisted `unavailable` and said "photo editing isn't available yet", because nothing in the
    // product could produce a region and telling her to draw one would have been a lie. It can now,
    // so an empty mask is a step she has not taken on a screen that is asking her to take it.
    expect(body.unavailable).toBeNull();
    expect(body.verdict.headline).toMatch(/mark what to change/i);
    expect(JSON.stringify(body.blockers)).toMatch(/drag a box/i);
    expect(JSON.stringify(body)).not.toMatch(/isn't available yet/i);
  });

  // ─── U3: the mask ─────────────────────────────────────────────────────────────────────────────
  //
  // The regions arrive as FRACTIONS of the source frame and must leave as pixels in that frame's
  // OWN space. There is no runtime check downstream — the mask reaches the model as language, not
  // as an alpha channel — so a mis-mapped box generates successfully, bills real money and comes
  // back with the wrong part of the photo changed. These are the tests that stop that.

  describe("edit regions", () => {
    it("maps fractions to ORIGINAL pixels and FREEZES them on the row that authorizes the spend", async () => {
      // THE OFF-BY-SCALE CATCHER. 0.5/0.5/0.1/0.1 of a 4000x6000 frame is 2000,3000 800x600. If the
      // mapping ever used display pixels, the row's frozen brief carries different numbers and this
      // fails — which is the only place the mistake is still visible, because /studio/generate
      // replays THIS brief rather than rebuilding one.
      const { id } = await seedFrame(athleteId, { width: 4000, height: 6000 });

      const res = await post(editReq(id, [REGION]));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.brief.job.source.editRegions).toEqual([
        { label: "the logo on the ball", left: 2000, top: 3000, width: 400, height: 600 },
      ]);
      // The measured frame is recorded too, so the geometry basis stays recoverable after the fact.
      expect(body.brief.job.source).toMatchObject({ width: 4000, height: 6000 });

      const [stored] = await db.select({ brief: studioGenerationPreviews.brief })
        .from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, body.previewId));
      expect((stored.brief as any).job.source.editRegions).toEqual([
        { label: "the logo on the ball", left: 2000, top: 3000, width: 400, height: 600 },
      ]);
    });

    it("maps the SAME fractions differently on a landscape frame", () => seedFrame(athleteId, { width: 6000, height: 4000 })
      .then(async ({ id }) => {
        // The axis-transposition catcher, at the route level rather than the unit level.
        const body = await (await post(editReq(id, [REGION]))).json();
        expect(body.brief.job.source.editRegions[0]).toEqual({
          label: "the logo on the ball", left: 3000, top: 2000, width: 600, height: 400,
        });
      }));

    it("states the size of what the model is LOOKING AT, so the coordinates mean something", async () => {
      // The model has no pixel ruler of its own: "at 2000,3000" is uninterpretable unless it is told
      // what the numbers are relative to. That reasoning is unchanged. What changed is the picture.
      //
      // A masked edit sends a padded CROP, not the photograph, so the frame's dimensions and
      // frame-space coordinates would describe an image the model cannot see — a confident wrong
      // answer to "where", in a block that shouts that the coordinates are authoritative. The
      // geometry is restated in CROP space instead.
      //
      // REGION is 400x600 at 2000,3000 on a 4000x6000 frame. Padding is half the region per side,
      // floored at 256: 256 horizontally, 300 vertically → a 912x1200 crop at (1744,2700), inside
      // which the region sits at (256,300).
      const { id } = await seedFrame(athleteId, { width: 4000, height: 6000 });
      const body = await (await post(editReq(id, [REGION]))).json();

      const prompt = body.plan.inputs.prompt as string;
      expect(prompt).toContain("This image is a 912x1200 pixel crop taken from a larger photograph");
      expect(prompt).toContain("CHANGE ONLY: the logo on the ball (at 256,300, 400x600)");
      // And the frame-space form is GONE — leaving it in would be two coordinate systems in one
      // prompt, which is worse than either.
      expect(prompt).not.toContain("The frame is 4000x6000 pixels");
    });

    it("unblocks the edit that U1 and U2 could only refuse", async () => {
      const { id } = await seedFrame(athleteId);
      const body = await (await post(editReq(id, [REGION]))).json();

      expect(body.status).toBe("ready");
      expect(body.verdict.canGenerate).toBe(true);
      expect(body.unavailable).toBeNull();
      expect(JSON.stringify(body.blockers)).not.toMatch(/edit regions/i);
    });

    it("REJECTS an out-of-bounds region rather than clamping it, and writes nothing", async () => {
      const { id } = await seedFrame(athleteId);
      const before = await db.select({ id: studioGenerationPreviews.id }).from(studioGenerationPreviews);

      const res = await post(editReq(id, [{ ...REGION, left: 0.9, width: 0.5 }]));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/outside the photo/i);
      // No preview row means nothing exists that could later authorize a spend on a bad mask.
      expect(await db.select({ id: studioGenerationPreviews.id }).from(studioGenerationPreviews))
        .toHaveLength(before.length);
    });

    it("rejects a region too small to be an intent", async () => {
      const { id } = await seedFrame(athleteId);
      const res = await post(editReq(id, [{ ...REGION, width: 0.0005, height: 0.0005 }]));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/too small/i);
    });

    it("rejects a region with no label — it would reach the prompt as nothing", async () => {
      const { id } = await seedFrame(athleteId);
      const res = await post(editReq(id, [{ ...REGION, label: "  " }]));
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("regions[0].label");
    });

    /**
     * ─── THIS TEST WAS RED FOR TWO MERGES, AND THE CAP WAS NEVER THE PROBLEM ────────────────────
     *
     * It asserted "Up to 3 regions" and got a 200. The cap MOVED, deliberately: `MAX_REGIONS` went
     * 3 → 12 in #367, which split one number that had been doing three jobs at once — how many
     * things she may change, how many boxes may be detected, and how much a job may spend — into
     * MAX_TARGETS (6), MAX_REGIONS (12) and maxEditCalls() (4, and the binding one). Four regions
     * returning 200 is that split working.
     *
     * The route's check never vanished: it has always read the constant (`Up to ${MAX_REGIONS}`).
     * Only this assertion was frozen at the old value. So the number comes off the constant now and
     * cannot go stale again.
     *
     * ⚠️ AND THE CONSTANT IS PINNED BY HAND BESIDE IT, which is not belt-and-braces. A test that
     * derives its expectation from the thing it protects reports green when that thing shrinks —
     * the runbook has three measured instances, one of which survived deleting "socks" from
     * GARMENT_NOUNS. `MAX_REGIONS + 1` alone would pass just as happily at a cap of 3 as at 12, and
     * silently stop testing the contract anybody actually agreed to.
     */
    it("accepts a fourth region — the cap is no longer three, and that was deliberate", async () => {
      const { id } = await seedFrame(athleteId);
      const res = await post(editReq(id, [REGION, REGION, REGION, REGION]));
      expect(res.status).toBe(200);
    });

    it(`rejects more than ${MAX_REGIONS} regions`, async () => {
      const { id } = await seedFrame(athleteId);
      const tooMany = Array.from({ length: MAX_REGIONS + 1 }, () => REGION);
      const res = await post(editReq(id, tooMany));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        new RegExp(`Up to ${MAX_REGIONS} regions`),
      );
    });

    /**
     * ⚠️ THE TEST ABOVE PASSES WITH THE ROUTE'S CAP CHECK DELETED. Measured, not supposed.
     *
     * `mapRegions` (studio/geometry.ts) refuses the same count with the same sentence one layer
     * down, so the status and the message are identical either way and neither can see which guard
     * fired. That is the runbook's "a test that reports success while measuring nothing", and it is
     * why this second one exists.
     *
     * The route's guard is not a duplicate: its whole job is to refuse BEFORE any database read,
     * because an unbounded array would otherwise turn one request into N queries (see its own note
     * on `maxReferences`). So the discriminator is a source photo that does not exist. Parse-first
     * gives the regions 400; a missing parse guard reaches `resolveSource` and 404s on the photo
     * instead. Reading the ORDER is the only way to see the guard at all.
     */
    it("refuses an over-cap payload BEFORE it reads a row — which is the guard's whole job", async () => {
      const tooMany = Array.from({ length: MAX_REGIONS + 1 }, () => REGION);
      const res = await post(
        editReq("00000000-0000-4000-8000-000000000000", tooMany),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        new RegExp(`Up to ${MAX_REGIONS} regions`),
      );
    });

    it("the cap the route enforces is twelve", () => {
      // The hand-written half. Shrink MAX_REGIONS and the two tests above still pass; this one does
      // not, and it is the only thing standing between a quiet cap change and a silent 400.
      expect(MAX_REGIONS).toBe(12);
    });

    it("REFUSES when the frame cannot be measured, rather than trusting anything else", async () => {
      // media_assets.width/height is NULL for ingested media and client-asserted for uploads, so
      // there is no second source to fall back to. Guessing here would place the mask by accident.
      const { id } = await seedFrame(athleteId, "unreadable");
      const res = await post(editReq(id, [REGION]));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/couldn't read this photo's dimensions/i);
      expect(body.field).toBe("sourceAssetId");
    });

    it("warns but does NOT block when the marked area is loose", async () => {
      const { id } = await seedFrame(athleteId);
      const body = await (await post(editReq(id, [{ ...REGION, left: 0.1, top: 0.1, width: 0.6, height: 0.6 }]))).json();

      expect(body.status).toBe("ready");
      expect(body.verdict.canGenerate).toBe(true);      // her call to make
      expect(JSON.stringify(body.warnings)).toMatch(/36% of the photo/);
      expect(body.warnings.every((w: any) => w.severity === "degraded")).toBe(true);
    });

    it("stays quiet about a tight box", async () => {
      const { id } = await seedFrame(athleteId);
      const body = await (await post(editReq(id, [REGION]))).json();
      expect(JSON.stringify(body.warnings)).not.toMatch(/of the photo/);
    });

    it("will not map regions against ANOTHER athlete's frame", async () => {
      // The tenancy boundary with a region attached: valid geometry must not buy access to a photo
      // she does not own, and their storage path must not come back either.
      const theirs = await seedFrame(otherAthleteId, { width: 4000, height: 6000 });
      const res = await post(editReq(theirs.id, [REGION]));

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain(theirs.path);
      expect(text).not.toContain(otherAthleteId);
      expect(text).not.toMatch(/4000|6000/);            // not even the shape of their photo
    });

    it("refuses regions on a generate, which has no frame to measure them against", async () => {
      const res = await post({ ...IMAGE_REQ, regions: [REGION] });
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("regions");
    });

    it.each([
      ["not a list", { regions: "the logo" }],
      ["a list of strings", { regions: ["the logo"] }],
      ["a list of nulls", { regions: [null] }],
    ])("refuses malformed regions: %s", async (_label, over) => {
      const { id } = await seedFrame(athleteId);
      const res = await post({ ...editReq(id), ...over });
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("regions");
    });
  });

  it("409s an athlete who has never been scored instead of 500ing", async () => {
    const fresh = await seedAthlete("Unscored Athlete");   // no athletes_current row
    asUser(fresh);
    const res = await post(IMAGE_REQ);
    expect(res.status).toBe(409);
  });
});

// ─── Tenancy: the content read ──────────────────────────────────────────────────────────────────

describe("content read tenancy", () => {
  it("returns empty for an athlete with nothing generated", async () => {
    const res = await getContent();
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  it("returns her generated assets and NEVER another athlete's", async () => {
    const mine   = await seedAsset(athleteId,      { caption: "mine" });
    const theirs = await seedAsset(otherAthleteId, { caption: "theirs" });

    const body = await (await getContent()).json();
    const ids = body.items.map((i: any) => i.assetId);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(JSON.stringify(body)).not.toContain("theirs");
  });

  it("excludes ingested, soft-deleted and unstored rows", async () => {
    const ingested = await seedAsset(athleteId, { origin: "connected", approval: null });
    const deleted  = await seedAsset(athleteId, { deleted: true });
    const failed   = await seedAsset(athleteId, { status: "failed" });

    const ids = (await (await getContent()).json()).items.map((i: any) => i.assetId);
    expect(ids).not.toContain(ingested);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(failed);
  });

  it("surfaces publish state — and no one else's, even though content_posts has no athlete_id", async () => {
    const mine   = await seedAsset(athleteId);
    const theirs = await seedAsset(otherAthleteId);

    await db.insert(contentPosts).values([
      { asset_id: mine,   platform: "instagram", permalink: "https://ig.test/mine",   posted_at: new Date("2026-08-01") },
      { asset_id: theirs, platform: "instagram", permalink: "https://ig.test/theirs", posted_at: new Date("2026-08-02") },
    ] as any);

    const body = await (await getContent()).json();
    const item = body.items.find((i: any) => i.assetId === mine);

    expect(item.published.permalink).toBe("https://ig.test/mine");
    // The join can only see ids the athlete-scoped first query already cleared.
    expect(JSON.stringify(body)).not.toContain("ig.test/theirs");
  });

  it("keeps the most recent publish record when a piece was reposted", async () => {
    const mine = await seedAsset(athleteId);
    await db.insert(contentPosts).values([
      { asset_id: mine, platform: "instagram", permalink: "https://ig.test/first",  posted_at: new Date("2026-07-01") },
      { asset_id: mine, platform: "tiktok",    permalink: "https://tt.test/repost", posted_at: new Date("2026-08-15") },
    ] as any);

    const body = await (await getContent()).json();
    const items = body.items.filter((i: any) => i.assetId === mine);

    // One tile, not one per publish record — a leftJoin would have fanned this out.
    expect(items.length).toBe(1);
    expect(items[0].published.permalink).toBe("https://tt.test/repost");
  });

  it("clamps a client-requested page size", async () => {
    for (let i = 0; i < 3; i++) await seedAsset(athleteId);
    const res = await getContent("?limit=100000");
    expect(res.status).toBe(200);
    expect((await res.json()).items.length).toBeLessThanOrEqual(50);
  });
});

// ─── Who a piece was made for ───────────────────────────────────────────────────────────────────
//
// The Made shelf sorts by audience, and the audience comes from `generation_jobs.brand_id` — NOT
// from either `deal_id` column, both of which are NULL on every generated row. The linkage runs
// media_assets.generation_job_id → generation_jobs → inbox_brands, and the leak it opens is the
// point of the last test here: `generation_job_id` has no foreign key on the media_assets side, so
// an asset can be made to point at ANOTHER ATHLETE'S job. If that job's brand came back, athlete A
// would be told who athlete B is working with.

/** A generated asset that came out of a real job — optionally one placed under a brand. */
async function seedAssetFromJob(owner: string, brand: number | null): Promise<string> {
  const [job] = await db.insert(generationJobs).values({
    athlete_id: owner,
    brand_id: brand,
    origin: "system",
    mode: "generate",          // generate ⇒ source_asset_id must stay null (DB check constraint)
    objective: "grow-following",
    deliverable: "post",
    brief: { synthetic: true },
    status: "succeeded",
  } as any).returning({ id: generationJobs.id });

  const assetId = await seedAsset(owner);
  await db.update(mediaAssets)
    .set({ generation_job_id: job.id } as any)
    .where(eq(mediaAssets.id, assetId));
  return assetId;
}

const itemFor = async (assetId: string) =>
  (await (await getContent("?limit=50")).json()).items.find((i: any) => i.assetId === assetId);

describe("the brand a piece was made for", () => {
  it("names the brand off the job that made it", async () => {
    const asset = await seedAssetFromJob(athleteId, brandId);
    const item = await itemFor(asset);

    expect(item.brandId).toBe(brandId);
    expect(item.brandName).toBe("Testwear");
  });

  it("reads null for a piece she made for herself", async () => {
    const asset = await seedAssetFromJob(athleteId, null);
    const item = await itemFor(asset);

    // Null means "no brand was named", which is a personal piece — not "we could not tell".
    expect(item.brandId).toBeNull();
    expect(item.brandName).toBeNull();
  });

  it("reads null for a piece with no job at all, rather than dropping the row", async () => {
    const asset = await seedAsset(athleteId);
    const item = await itemFor(asset);

    // A leftJoin, not an inner one: an asset that predates job tracking still belongs on her shelf.
    expect(item).toBeDefined();
    expect(item.brandName).toBeNull();
  });

  it("still returns ONE row per asset — the joins must not fan out", async () => {
    const asset = await seedAssetFromJob(athleteId, brandId);
    const items = (await (await getContent("?limit=50")).json()).items
      .filter((i: any) => i.assetId === asset);

    expect(items.length).toBe(1);
  });

  // ── THE LEAK TEST ──
  it("NEVER surfaces another athlete's brand, even from a job her asset points at", async () => {
    const [rival] = await db.insert(inboxBrands)
      .values({ name: "Rivalwear", normalized_name: "rivalwear", category: "apparel" } as any)
      .returning({ id: inboxBrands.id });

    // Athlete B's job, naming B's brand.
    const [theirJob] = await db.insert(generationJobs).values({
      athlete_id: otherAthleteId,
      brand_id: rival.id,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "post",
      brief: { synthetic: true },
      status: "succeeded",
    } as any).returning({ id: generationJobs.id });

    // A of hers, mis-pointed at it. There is no FK to stop this write.
    const mine = await seedAsset(athleteId);
    await db.update(mediaAssets)
      .set({ generation_job_id: theirJob.id } as any)
      .where(eq(mediaAssets.id, mine));

    const body = await (await getContent("?limit=50")).json();
    const item = body.items.find((i: any) => i.assetId === mine);

    // The row is still hers and still on her shelf — it is the BRAND that must not come with it.
    expect(item).toBeDefined();
    expect(item.brandId).toBeNull();
    expect(item.brandName).toBeNull();
    expect(JSON.stringify(body)).not.toContain("Rivalwear");
  });

  it("does not put another athlete's branded asset on her shelf at all", async () => {
    const theirs = await seedAssetFromJob(otherAthleteId, brandId);

    const body = await (await getContent("?limit=50")).json();
    expect(body.items.map((i: any) => i.assetId)).not.toContain(theirs);
  });
});

// ─── Tagged references ───────────────────────────────────────────────────────────────────────────
//
// The tenancy assertion here is the one that matters most in this PR: a reference arrives as an
// ASSET ID, and the path that reaches the brief must come out of a row read under the authenticated
// athlete. If that ever regresses, a client can point a generation at somebody else's photo AND
// read its storage path back out of `preview.references`.

describe("references — the reading gate (PR 12, STUDIO_LIBRARY_FIELDS)", () => {
  /** A row of hers with the given metadata, on the source-frame probe so the request is otherwise well-formed. */
  const rowWith = async (metadata: unknown): Promise<string> => {
    const [row] = await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored",
      gcs_path: `athletes/${athleteId}/gate-${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg", metadata,
    } as any).returning({ id: mediaAssets.id });
    return row.id;
  };
  const send = (assetId: string, role: string) =>
    post({ ...IMAGE_REQ, references: [{ assetId, role }] });

  beforeEach(() => { asUser(athleteId); process.env.STUDIO_LIBRARY_FIELDS = "true"; });
  afterEach(() => { delete process.env.STUDIO_LIBRARY_FIELDS; });

  /** ⚠️ MUTATION "an unclassified image reaches a generation call": skip likenessDecision in resolveReferences — reds. */
  it("an unread photo is refused as a person or product reference, by why it is unread — and writes no preview", async () => {
    const before = (await db.select({ id: studioGenerationPreviews.id }).from(studioGenerationPreviews)).length;
    const pending = await rowWith(null);
    const failed = await rowWith({ enrichment: { abandoned_at: "2026-09-23T00:00:00Z", abandoned_reason: "oversize" } });
    const capped = await rowWith({ enrichment: { abandoned_at: "2026-09-23T00:00:00Z", abandoned_reason: "attempts" } });
    for (const [id, role, reason] of [
      [pending, "person", "reference_unread"],
      [pending, "product", "reference_unread"],
      [failed, "person", "reference_read_failed"],
      [capped, "product", "reference_read_capped"],
    ] as const) {
      const res = await send(id, role);
      const body = await res.json();
      expect([res.status, body.field, body.reason]).toEqual([422, "references", reason]);
      expect(typeof body.error).toBe("string");
    }
    // An object reference is a thing she pointed at: unread or not, it passes as before.
    expect((await send(pending, "object")).status).toBe(200);
    expect((await db.select({ id: studioGenerationPreviews.id }).from(studioGenerationPreviews)).length).toBe(before + 1);
  });

  /** ⚠️ MUTATION "a no-face photo is accepted as a person likeness ref": drop the face arm — reds. */
  it("a no-face photo is refused as a person likeness, with its reason — and accepted as a product", async () => {
    const noFace = await rowWith({ vision: { subject: "the_athlete", athlete_present: true, face_visibility: "none", role: "identity" } });
    const res = await send(noFace, "person");
    const body = await res.json();
    expect([res.status, body.reason]).toEqual([422, "likeness_no_face"]);
    expect(body.error).toBe("This photo doesn't show your face clearly enough to use as a likeness. Pick one where your face is visible.");
    expect((await send(noFace, "product")).status).toBe(200);
    const partial = await rowWith({ vision: { subject: "the_athlete", athlete_present: true, face_visibility: "partial" } });
    expect((await send(partial, "person")).status).toBe(200);
  });

  /**
   * PR 19 (ADI-R19-FACE): "face visibility never rejects". With STUDIO_IMAGE_OPS on, a real photo of her with an
   * unclear face is used for what she asked — Create Anything's image and the Board's clip alike. (A made-here row not
   * from her runs too since ADI-R19-BOARD3 — the test below.) Off, the test above holds: today's 422. ⚠️ MUTATION M-face: pass faceRejects true at
   * the reference door (routes/studio.ts) — this reds by name.
   */
  it("a real photo of her with an unclear face is never refused with STUDIO_IMAGE_OPS on — on an image and on a clip", async () => {
    process.env.STUDIO_IMAGE_OPS = "true";
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const noFace = await rowWith({ vision: { subject: "the_athlete", athlete_present: true, face_visibility: "none", role: "identity" } });
      // Create Anything's likeness generate.
      expect((await send(noFace, "person")).status).toBe(200);
      // The Board's clip, as the walk sent it (less the plan id, which needs its own row and flag).
      const clip = await post({
        intent: "video.generate", deliverable: "clip", objective: "grow-following", audio: true,
        direction: "A close-up, sideways-oriented detail shot of her hands resting on the ball.",
        references: [{ assetId: noFace, role: "person" }], shot: { framing: "wide", lighting: "stadium" },
      });
      expect(clip.status).toBe(200);
      // Unchanged: a made-here row whose job carried no photo of her is still not her.
      const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "system", mode: "generate", objective: "grow-following", deliverable: "post", brief: { job: { references: [{ role: "product" }] } }, status: "succeeded" } as any).returning({ id: generationJobs.id });
      const [notHer] = await db.insert(mediaAssets).values({
        athlete_id: athleteId, platform: "upload", origin: "generated", media_type: "IMAGE", status: "stored",
        gcs_path: `athletes/${athleteId}/gen-${Math.random().toString(36).slice(2)}.jpg`, content_type: "image/jpeg",
        generation_job_id: job.id, metadata: { vision: { subject: "the_athlete", athlete_present: true, face_visibility: "none" } },
      } as any).returning({ id: mediaAssets.id });
      // ADI-R19-BOARD3: what she chose runs as she set it — "Made here · not from you" is a label, never a refusal here.
      expect((await send(notHer.id, "person")).status).toBe(200);
    } finally {
      delete process.env.STUDIO_IMAGE_OPS;
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  /**
   * PR 19 (ADI-R19-BOARD4): a refusal never changes her shot — fix the cause. A photo not read yet is read at the door,
   * by the enrichment cron's own unit (services/mediaEnrichment.ts `enrichOnePhoto`): the same tagger and embedder, the
   * same fields, once — a second check finds it read and asks nothing. Then it is judged on what was read, and her
   * Board's clip prices ready and runs. A row the cron set down (oversize, attempts) is not retried here: it answers as
   * before. ⚠️ MUTATION M-readNow: skip the read at the door (routes/studio.ts) — this reds by name.
   */
  it("an unread photo of hers is read on the spot, then prices and runs — once, never set-down rows", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    const tag = jest.mocked(tagAsset);
    const embed = jest.mocked(embedImageGcsWithReason);
    tag.mockClear();
    embed.mockClear();
    tag.mockResolvedValue({
      athlete_present: true, subject: "the_athlete", athlete_prominence: 0.9, shot_type: "portrait",
      description: "she smiles at the camera", brands_visible: [], aesthetic_quality: 0.8, brand_safe: true,
      setting: "track", attire: "kit", vibe: "calm", hero_suitability: 0.8, disposition: "as_is", edit_note: "",
      reason: "", face_visibility: "clear", role: "identity",
    } satisfies AssetTags);
    embed.mockResolvedValue({ ok: true, embedding: [0.1, 0.2, 0.3] });
    try {
      const pending = await rowWith(null);
      const clip = () =>
        post({
          intent: "video.generate", deliverable: "clip", objective: "grow-following",
          direction: "She turns to the camera and smiles.",
          references: [{ assetId: pending, role: "person" }],
        });
      const first = await clip();
      expect(first.status).toBe(200);
      const body = await first.json();
      expect([body.status, body.unpriced, typeof body.cost?.amountUsd]).toEqual(["ready", false, "number"]);
      // The read landed as the cron would have written it — the same two fields.
      const [row] = await db.select({ metadata: mediaAssets.metadata }).from(mediaAssets).where(eq(mediaAssets.id, pending));
      expect(Object.keys(row.metadata as object).sort()).toEqual(["embedding", "vision"]);
      expect([tag.mock.calls.length, embed.mock.calls.length]).toEqual([1, 1]);
      // Once: the next check finds it read and reads nothing.
      expect((await clip()).status).toBe(200);
      expect([tag.mock.calls.length, embed.mock.calls.length]).toEqual([1, 1]);
      // Create Anything's likeness generate reads the same way.
      expect((await send(await rowWith(null), "person")).status).toBe(200);
      expect(tag.mock.calls.length).toBe(2);
      // Set down by the cron: never retried here, refused as before.
      const failed = await rowWith({ enrichment: { abandoned_at: "2026-09-23T00:00:00Z", abandoned_reason: "oversize" } });
      const capped = await rowWith({ enrichment: { abandoned_at: "2026-09-23T00:00:00Z", abandoned_reason: "attempts" } });
      expect([(await send(failed, "person")).status, (await send(capped, "person")).status]).toEqual([422, 422]);
      expect(tag.mock.calls.length).toBe(2);
    } finally {
      tag.mockReset();
      tag.mockResolvedValue(null);
      embed.mockReset();
      embed.mockResolvedValue({ ok: false, reason: "other" });
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  /** P-old. ⚠️ MUTATION "an old row without face_visibility is refused": read the key raw — reds. */
  it("an old row — tagged before face_visibility existed — is accepted as her likeness", async () => {
    const ternary = await rowWith({ vision: { subject: "the_athlete", athlete_present: true, description: "she runs" } });
    const preTernary = await rowWith({ vision: { athlete_present: true, description: "she runs" } });
    expect((await send(ternary, "person")).status).toBe(200);
    expect((await send(preTernary, "person")).status).toBe(200);
  });

  /**
   * PR 19 (ADI-R19-BOARD3, superseding the 24 Sep door refusal): a shot on her Board runs as she set it, and an image she
   * chose in Create Anything runs — "Made here · not from you" stays a LABEL (studio.media.test) and the identity pack
   * still keeps generated rows out (packGate.test "pack accepts a generated photo — REFUSED, generated"), but the
   * generation door never refuses it. ⚠️ MUTATION M-madeHere: pass madeHereRefuses true at the door (routes/studio.ts
   * resolveReferences) — this reds by name.
   */
  it("a made-here still she chose runs — her Board's clip and Create Anything's likeness generate, no refusal", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
    try {
      const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "system", mode: "generate", objective: "grow-following", deliverable: "post", brief: { job: { references: [{ role: "product" }] } }, status: "succeeded" } as any).returning({ id: generationJobs.id });
      const [noHer] = await db.insert(mediaAssets).values({
        athlete_id: athleteId, platform: "upload", origin: "generated", media_type: "IMAGE", status: "stored",
        gcs_path: `athletes/${athleteId}/gen-${Math.random().toString(36).slice(2)}.jpg`, content_type: "image/jpeg",
        generation_job_id: job.id, metadata: { vision: { subject: "the_athlete", athlete_present: true, face_visibility: "clear", role: "identity" } },
      } as any).returning({ id: mediaAssets.id });
      // Create Anything's likeness generate.
      expect((await send(noHer.id, "person")).status).toBe(200);
      // Her Board's clip: an animated shot of it, as the Board sends a motion row (storyboardRun clipRequestFor).
      const clip = await post({
        intent: "video.generate", deliverable: "clip", objective: "grow-following",
        direction: "She turns to the camera and smiles.",
        references: [{ assetId: noHer.id, role: "person" }],
      });
      expect(clip.status).toBe(200);
      expect((await clip.json()).status).toBe("ready");
    } finally {
      delete process.env.STUDIO_VIDEO_ENABLED;
    }
  });

  it("with the flag off, none of this exists — an unread person reference passes as before", async () => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
    const pending = await rowWith(null);
    expect((await send(pending, "person")).status).toBe(200);
  });
});

describe("references — tenancy", () => {
  it("refuses another athlete's photo as a reference, and never echoes its path", async () => {
    const theirs = await seedAsset(otherAthleteId, { origin: "upload" });
    const [row] = await db.select({ path: mediaAssets.gcs_path })
      .from(mediaAssets).where(eq(mediaAssets.id, theirs));

    asUser(athleteId);
    const res = await post({ ...IMAGE_REQ, references: [{ assetId: theirs, role: "person" }] });
    const body = await res.text();

    expect(res.status).toBe(404);
    // Not-found and not-yours are one answer, and their path is nowhere in it.
    expect(body).not.toContain(row.path!);
    expect(body).not.toContain(otherAthleteId);
  });

  it("writes no preview row when a reference is refused — nothing that could later authorize a spend", async () => {
    const theirs = await seedAsset(otherAthleteId, { origin: "upload" });
    const before = await db.select().from(studioGenerationPreviews);
    asUser(athleteId);
    await post({ ...IMAGE_REQ, references: [{ assetId: theirs, role: "product" }] });
    const after = await db.select().from(studioGenerationPreviews);
    expect(after.length).toBe(before.length);
  });

  it("resolves the path from the ROW, and freezes it on the brief with the role she chose", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const [row] = await db.select({ path: mediaAssets.gcs_path })
      .from(mediaAssets).where(eq(mediaAssets.id, mine));

    asUser(athleteId);
    const res = await post({
      ...IMAGE_REQ,
      references: [{ assetId: mine, role: "product", label: "the charm" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const [stored] = await db.select().from(studioGenerationPreviews)
      .where(eq(studioGenerationPreviews.id, body.previewId));
    const frozen = (stored.brief as any).job.references;

    expect(frozen).toEqual([expect.objectContaining({
      role: "product",
      ref: row.path,               // FROM THE ROW
      mediaAssetId: mine,
      label: "the charm",
    })]);
    // And it reached the planner in the object slot, not an identity one.
    expect(body.references.find((r: any) => r.ref === row.path)).toMatchObject({ role: "product", slot: "object" });
  });

  it("a path in the body is not read — only the assetId is", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const theirs = await seedAsset(otherAthleteId, { origin: "upload" });
    const [their] = await db.select({ path: mediaAssets.gcs_path })
      .from(mediaAssets).where(eq(mediaAssets.id, theirs));

    asUser(athleteId);
    const res = await post({
      ...IMAGE_REQ,
      references: [{ assetId: mine, role: "product", ref: their.path, gcsPath: their.path }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(their.path!);
  });
});

describe("references — validation", () => {
  const withRefs = (references: unknown) => post({ ...IMAGE_REQ, references });

  it("refuses an untagged reference rather than defaulting one", async () => {
    // NO DEFAULT, deliberately: the role is the safety boundary, and quietly calling an untagged
    // mood board a person reference is the exact failure typed roles exist to prevent.
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await withRefs([{ assetId: mine }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Say what each photo is for/);
  });

  it("refuses a role it does not recognise", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await withRefs([{ assetId: mine, role: "background" }]);
    expect(res.status).toBe(400);
  });

  it("refuses the look-reference tag a stale client might still send", async () => {
    // A 400 rather than a silent reinterpretation. `influence` was a real tag; a client built before
    // it was removed must be told no, not have its mood board quietly treated as something else.
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await withRefs([{ assetId: mine, role: "influence" }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Say what each photo is for/);
  });

  it("refuses a non-uuid assetId before it reaches a query", async () => {
    expect((await withRefs([{ assetId: "../../etc/passwd", role: "person" }])).status).toBe(400);
  });

  it("refuses the same photo twice", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await withRefs([
      { assetId: mine, role: "person" },
      { assetId: mine, role: "product" },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already on this list/);
  });

  it("caps the list BEFORE any database read, so a long list cannot amplify into N queries", async () => {
    // Ids that do not exist: if the cap were checked after resolution this would still be a 400,
    // so the assertion that matters is that it is refused on COUNT, naming the ceiling.
    const many = Array.from({ length: 40 }, () => ({
      assetId: "00000000-0000-4000-8000-000000000000", role: "person",
    }));
    const res = await withRefs(many);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Up to \d+ references/);
  });

  it("refuses an over-long label — it rides into the prompt verbatim", async () => {
    const mine = await seedAsset(athleteId, { origin: "upload" });
    const res = await withRefs([{ assetId: mine, role: "product", label: "x".repeat(200) }]);
    expect(res.status).toBe(400);
  });

  it("refuses a references field that is not a list", async () => {
    expect((await withRefs({ assetId: "x" })).status).toBe(400);
  });
});

describe("references — the cost check still spends nothing", () => {
  it("quotes MORE with references than without, and stays an estimate", async () => {
    asUser(athleteId);
    const bare = await (await post(IMAGE_REQ)).json();

    const a = await seedAsset(athleteId, { origin: "upload" });
    const b = await seedAsset(athleteId, { origin: "upload" });
    const withTwo = await (await post({
      ...IMAGE_REQ,
      references: [{ assetId: a, role: "person" }, { assetId: b, role: "product" }],
    })).json();

    expect(withTwo.cost.amountUsd).toBeGreaterThan(bare.cost.amountUsd);
    expect(withTwo.cost.basis).toBe("estimated");
    // The basis line names them rather than folding them in silently.
    expect(withTwo.cost.detail).toMatch(/reference/);
    expect(withTwo.plan.inputs.references).toBeGreaterThanOrEqual(2);
  });

  it("writes no generation job — a pre-check runs nothing", async () => {
    const before = await db.select().from(generationJobs);
    const id = await seedAsset(athleteId, { origin: "upload" });
    asUser(athleteId);
    await post({ ...IMAGE_REQ, references: [{ assetId: id, role: "person" }] });
    expect((await db.select().from(generationJobs)).length).toBe(before.length);
  });
});


// ─── GET /studio/deliverables ───────────────────────────────────────────────────────────────────

/**
 * The route-level half of the tenancy story. studio/dealDeliverables.test.ts proves the QUERY is
 * scoped; this proves the ROUTE reaches it with the authenticated athlete and nothing else — there
 * is no deliverableId or dealId on this surface to borrow, and the one client-supplied value
 * (brandId) can only narrow her own set.
 */
describe("GET /studio/deliverables", () => {
  /** One obligation on a fresh deal owned by `owner`. Returns the deliverable id. */
  async function seedDeliverable(
    owner: string,
    over: Record<string, unknown> = {},
    dealOver: Record<string, unknown> = {},
  ): Promise<string> {
    const [deal] = await db.insert(deals).values({
      athlete_id: owner, brand_name: "gorjana", brand_id: brandId, status: "accepted", ...dealOver,
    } as never).returning({ id: deals.id });
    const [row] = await db.insert(dealDeliverables).values({
      deal_id: deal.id, seq: 1, format: "Reel · 9:16", kind: "reel", quantity: 3, ...over,
    } as never).returning({ id: dealDeliverables.id });
    return row.id;
  }

  it("returns her outstanding work in the shape the client renders", async () => {
    const id = await seedDeliverable(athleteId, { campaign: "Coastal Capsule", due_on: "2026-10-12" });
    asUser(athleteId);

    const body = await (await getDeliverables()).json();
    const row = body.items.find((d: any) => d.id === id);

    expect(row).toBeDefined();
    expect(row.campaign).toBe("Coastal Capsule");
    expect(row.format).toBe("Reel · 9:16");
    // The DATE STRING, not an instant — the whole point of the column's type.
    expect(row.dueOn).toBe("2026-10-12");
    expect(row.total).toBe(3);
    expect(row.delivered).toBe(0);
    expect(row.optional).toBe(false);
  });

  it("NEVER returns another athlete's deliverable", async () => {
    const hers = await seedDeliverable(athleteId, { campaign: "Hers", seq: 2 });
    const his = await seedDeliverable(otherAthleteId, { campaign: "His" });

    asUser(athleteId);
    const mine = await (await getDeliverables()).json();
    const ids = mine.items.map((d: any) => d.id);
    expect(ids).toContain(hers);
    expect(ids).not.toContain(his);
    expect(mine.items.map((d: any) => d.campaign)).not.toContain("His");

    // And it IS reachable for its owner, so this passed for the right reason.
    asUser(otherAthleteId);
    const theirs = await (await getDeliverables()).json();
    expect(theirs.items.map((d: any) => d.id)).toContain(his);
  });

  it("a brandId cannot reach across to another athlete's deal", async () => {
    const his = await seedDeliverable(otherAthleteId, { campaign: "His By Brand", seq: 3 });
    asUser(athleteId);

    const body = await (await getDeliverables(`?brandId=${brandId}`)).json();
    expect(body.items.map((d: any) => d.id)).not.toContain(his);
    expect(body.items.every((d: any) => d.brandId === brandId)).toBe(true);
  });

  it("refuses a non-integer brandId rather than matching nothing", async () => {
    asUser(athleteId);
    const res = await getDeliverables("?brandId=nope");
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("brandId");
  });

  it("is 404 with the flag off, like every other studio route", async () => {
    const prev = process.env.STUDIO_ENABLED;
    process.env.STUDIO_ENABLED = "false";
    asUser(athleteId);
    expect((await getDeliverables()).status).toBe(404);
    process.env.STUDIO_ENABLED = prev;
  });
});
