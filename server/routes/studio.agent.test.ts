/**
 * studio.agent.test.ts — POST /studio/agent/plan, end to end over HTTP against in-memory Postgres.
 *
 * What is REAL here: the router, the body checks, the caster's predicate, searchMedia, the planner's
 * parser and its product gate. What is stood in, at the network edge only: the one Gemini call
 * (`genai`), embedText, and URL signing.
 *
 * The assertions that matter most are about what did NOT happen:
 *   - with the flag off, no model was called and nothing was searched;
 *   - with a foreign asset named, the planner was never asked;
 *   - on every path, no preview was written — this route plans; the Board prices and spends.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
// Pino stood in, so P5c can read the library's warnings; nothing else here asserts a log line.
// Every line lands in ONE array, whichever module registry the logger was made in (the route
// loads studio/agent/library dynamically).
const mockLogs: { name: string; level: string; args: unknown[] }[] = [];
jest.mock("../logger", () => {
  const make = (name: string) => {
    const at = (level: string) =>
      jest.fn((...args: unknown[]) => {
        mockLogs.push({ name, level, args });
      });
    return {
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      debug: at("debug"),
    };
  };
  return { createLogger: jest.fn(make) };
});
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/models", () => ({
  genai: jest.fn(),
  GEMINI: {
    pro: "test-pro",
    flash: "test-flash",
    flashLite: "test-flash-lite",
  },
}));
jest.mock("../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  embedImageGcs: jest.fn(),
  embedImageGcsWithReason: jest.fn(),
  cosine: (a: number[], b: number[]) => {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));
// The brief upload's signer builds a GCS client at module load; the route loads it dynamically.
jest.mock("../lib/inboxAttachmentStore", () => ({
  signedAttachmentUploadUrl: jest.fn(
    async (p: string) => `https://signed-put.example/${p}`,
  ),
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
}));

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "./studio";
import { genai } from "../lib/models";
import { embedText } from "../lib/mediaEmbed";
import {
  athletes,
  dealDeliverables,
  deals,
  mediaAssets,
  studioGenerationPreviews,
  studioPlans,
  studioReferenceAnalyses,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { UNCAST_LINE } from "../studio/agent/cast";

const HER = "33333333-1111-4444-8555-666666666666";
const SOMEONE_ELSE = "44444444-1111-4777-8666-555555555555";

let server: Server;
let base: string;
const generateContent = jest.fn();

const post = async (body: unknown) => {
  const res = await fetch(`${base}/studio/agent/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};

/** What the planner answers, as the model would write it. */
const planReply = (items: Record<string, unknown>[]) =>
  generateContent.mockResolvedValue({ text: JSON.stringify({ items }) });
const planned = (over: Record<string, unknown> = {}) => ({
  kind: "i2v",
  beat: "open on her",
  direction: "she turns toward the camera",
  ref: "a1",
  searchQuery: "her on the track",
  ...over,
});

const ask = (over: Record<string, unknown> = {}) => ({
  prompt: "something for the new season",
  objective: "grow-following",
  ...over,
});

async function photo(
  over: {
    owner?: string;
    athletePresent?: boolean;
    description?: string;
    brands?: string[];
    [k: string]: unknown;
  } = {},
): Promise<string> {
  const {
    owner = HER,
    athletePresent = true,
    description = "she stands on the track in the sun",
    brands = [],
    ...rest
  } = over;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
      metadata: {
        vision: {
          athlete_present: athletePresent,
          athlete_prominence: 0.8,
          shot_type: "action",
          description,
          brands_visible: brands,
          aesthetic_quality: 0.8,
          brand_safe: true,
          hero_suitability: 0.8,
          content_flags: {},
          setting: "a track",
          vibe: "warm",
        },
        embedding: [1, 0, 0],
      },
      ...rest,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Agent Route Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(mediaAssets);
  jest.clearAllMocks();
  (genai as jest.Mock).mockReturnValue({ models: { generateContent } });
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_AGENT = "true";
  (globalThis as any).__TEST_ATHLETE_ID = HER;
});

afterEach(async () => {
  delete process.env.STUDIO_AGENT;
  // On EVERY path: this route plans. Nothing was quoted, so nothing can have been spent.
  expect(await db.select().from(studioGenerationPreviews)).toHaveLength(0);
});

describe("POST /studio/agent/plan", () => {
  /**
   * ⚠️ MUTATION: drop the `agentEnabled()` check. This reds, and nothing else does.
   */
  it("does not exist with STUDIO_AGENT off — and calls no model and searches nothing", async () => {
    delete process.env.STUDIO_AGENT;
    await photo();
    planReply([planned()]);

    const { status } = await post(ask());

    expect(status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ MUTATION: skip the product's ownership check. This reds, and nothing else does.
   *
   * Another athlete's photo named as her product is the same answer as one that does not exist —
   * and it is given before the planner is asked anything.
   */
  it("404s a product that is not hers, before any model is called", async () => {
    await photo();
    const mine = await photo({ athletePresent: false });
    const theirs = await photo({ owner: SOMEONE_ELSE, athletePresent: false });
    planReply([planned({ kind: "product", searchQuery: null })]);

    // One of hers and one of theirs: any product that is not hers refuses the whole ask.
    const { status, json } = await post(
      ask({ productAssetIds: [mine, theirs] }),
    );

    expect(status).toBe(404);
    expect(json.field).toBe("productAssetIds");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("404s a picked photo that is not hers, before any model is called", async () => {
    const theirs = await photo({ owner: SOMEONE_ELSE });
    planReply([planned()]);

    const { status, json } = await post(ask({ assetIds: [theirs] }));

    expect(status).toBe(404);
    expect(json.field).toBe("assetIds");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("refuses a plan in which nothing could be cast — and says nothing was spent", async () => {
    // Only scenes in her library; the planner asks for identity shots.
    await photo({ athletePresent: false });
    planReply([planned({ kind: "i2v" }), planned({ kind: "i2v" })]);

    const { status, json } = await post(ask());

    expect(status).toBe(422);
    expect(json.error).toMatch(/Nothing was spent/);
    expect(json.items).toBeUndefined();
  });

  it("refuses a plan that puts in a product she never gave — the model not listening is not a product", async () => {
    await photo();
    planReply([planned(), planned({ kind: "product", searchQuery: null })]);

    const { status } = await post(ask());

    expect(status).toBe(502);
    // …and the prompt never offered the kind in the first place.
    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(prompt).not.toMatch(/"product"/);
  });

  it("returns the plan and what each item is cast from — gaps shown, not hidden — after ONE model call", async () => {
    const her = await photo({ athletePresent: true });
    await photo({ athletePresent: false });
    // The library the planner is shown: a1 = her (photos of her first), a2 = the scene. The b-roll item
    // names no photo — b-roll is made from words, and a ref on it refuses the plan whole (C1b 10); its
    // stray search query is dropped as noise. The third item names the scene for an identity shot — it
    // does not fit, and nothing else of her is left.
    planReply([
      planned({ kind: "i2v", sound: true }),
      planned({ kind: "broll", ref: null, searchQuery: "the empty track" }),
      planned({ kind: "i2v", ref: "a2", beat: "close on her again" }),
    ]);

    const { status, json } = await post(ask());

    expect(status).toBe(200);
    // Made: the shot of her, and the b-roll from words. Left out: the third.
    expect(json.castCount).toBe(2);
    expect(json.items.map((i: any) => i.assetId)).toEqual([her, null, null]);
    expect(json.items.map((i: any) => i.uncast === null)).toEqual([
      true,
      true,
      false,
    ]);
    // The planner's sound recommendation reaches her, item by item, untouched by casting.
    expect(json.items.map((i: any) => i.sound)).toEqual([true, false, false]);
    expect(json.items[2]).toMatchObject({
      beat: "close on her again",
      uncast: UNCAST_LINE,
    });
    // Planned, not priced: nothing here is a quote or a preview.
    expect(json.items[0]).not.toHaveProperty("previewId");
    expect(json).not.toHaveProperty("cost");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ MUTATION: count only items with a photo in `castCount` again (`assetId !== null`). A plan of
   * only b-roll then counts zero and is refused as a plan with nothing in it — this reds.
   */
  it("makes a plan of only b-roll — made from words, never refused as a plan with nothing in it", async () => {
    planReply([
      planned({
        kind: "broll",
        ref: null,
        searchQuery: null,
        beat: "the empty track",
      }),
      planned({
        kind: "broll",
        ref: null,
        searchQuery: null,
        beat: "laces pulled tight",
      }),
    ]);

    const { status, json } = await post(ask());

    expect(status).toBe(200);
    expect(json.castCount).toBe(2);
    expect(json.items.map((i: any) => [i.assetId, i.uncast])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("names the picks the tagger did not see her in — the ones no shot can be made from", async () => {
    const mine = await photo({ athletePresent: true });
    const ball = await photo({
      athletePresent: false,
      description: "a soccer ball on grass",
    });
    planReply([planned()]);

    const { status, json } = await post(ask({ assetIds: [mine, ball] }));

    expect(status).toBe(200);
    expect(json.picksWithoutHer).toEqual([ball]);
  });

  it("casts her product as the product, and offers the kind to the planner only then", async () => {
    await photo();
    const bottle = await photo({
      athletePresent: false,
      description: "a bottle",
    });
    planReply([planned(), planned({ kind: "product", searchQuery: null })]);

    const { status, json } = await post(ask({ productAssetIds: [bottle] }));

    expect(status).toBe(200);
    expect(json.items[1]).toMatchObject({ kind: "product", assetId: bottle });
    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(prompt).toMatch(/"product"/);
  });

  it("describes her products to the planner in the order she picked them, and casts them in it", async () => {
    await photo();
    const shoe = await photo({ athletePresent: false, description: "a shoe" });
    const bottle = await photo({
      athletePresent: true,
      description: "her hand around a bottle",
    });
    planReply([
      planned({ kind: "product", searchQuery: null }),
      planned({ kind: "product", searchQuery: null }),
    ]);

    // Picked bottle first, then shoe — the order of the ask, not of the library.
    const { status, json } = await post(
      ask({ productAssetIds: [bottle, shoe] }),
    );

    expect(status).toBe(200);
    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(prompt).toMatch(
      /p1 \| shows: her hand around a bottle\np2 \| shows: a shoe/,
    );
    // Her products are not library: neither is offered to the planner as a scene.
    expect(prompt).not.toMatch(/a\d+ \|[^\n]*a shoe/);
    // The first product item is her FIRST pick. (Each later item taking the next one, and the
    // tagger's fact riding along, are the caster's to prove — cast.test.ts.)
    expect(json.items[0].assetId).toBe(bottle);
  });

  /**
   * ⚠️ MUTATION: skip the scenes (show the planner only what searchMedia ranks). This reds, and
   * nothing else does.
   *
   * With thirty photos of her and five without, searchMedia's hero term fills every place with her
   * — the planner is shown no scene, and never plans b-roll. Scenes get their own places.
   */
  it("shows the planner scenes without her, even when photos of her would fill the list", async () => {
    for (let i = 0; i < 30; i++) await photo({ athletePresent: true });
    for (let i = 0; i < 5; i++) await photo({ athletePresent: false });
    planReply([planned()]);

    await post(ask());

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    const lines = (answer: string) =>
      prompt.match(new RegExp(`^a\\d+ \\| person_in_frame: ${answer}`, "gm"))
        ?.length ?? 0;
    expect(lines("no")).toBe(5);
    expect(lines("yes")).toBe(16);
  });

  it("shows the planner her clips under CLIP lines with their beats, and casts a clip item to its beat's window — $0, its own sound (C2 Half B)", async () => {
    await photo();
    const [clipRow] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        // A GENERATED clip carries its job (studio/jobs.ts); without one it is a stitched compilation.
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${HER}/clip.mp4`,
        gcs_thumb_path: `athletes/${HER}/clip-poster.jpg`,
        content_type: "video/mp4",
        duration_seconds_precise: 6.5,
        ingested_at: new Date(),
        metadata: {
          vision: {
            athlete_present: true,
            shot_type: "action",
            description: "she sprints then stops",
            brands_visible: [],
            setting: "track",
            vibe: "fast",
            beats: [
              {
                start_s: 0,
                end_s: 3,
                description: "she sprints",
                camera: "static wide",
                motion: "she sprints left to right",
              },
              {
                start_s: 3,
                end_s: 6.5,
                description: "she looks to camera",
                camera: "handheld close-up",
                motion: "still",
              },
            ],
            video: { source: "clip" },
          },
          embedding: [1, 0, 0],
        },
      } as never)
      .returning({ id: mediaAssets.id });
    planReply([
      planned({
        kind: "clip",
        ref: "a2",
        segment: 1,
        searchQuery: null,
        sound: true,
      }),
    ]);

    const r = await post(ask());

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(prompt).toMatch(
      /^a2 \| CLIP 6\.5s \| .*\| from: made here \| .*\| beats: \[0\] 0-3s wide\/static\/running: she sprints; \[1\] 3-6\.5s close_up\/handheld\/-: she looks to camera$/m,
    );
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "clip",
      assetId: clipRow.id,
      mediaType: "clip",
      trim: { startSec: 3, endSec: 6.5 },
      durationSeconds: 6.5,
      sound: true,
      uncast: null,
    });
    expect(r.json.castCount).toBe(1);
  });

  it("refuses a clip in the products tray by name, before any model — a product is a photo", async () => {
    const [clipRow] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${HER}/c.mp4`,
        gcs_thumb_path: `athletes/${HER}/c.jpg`,
        content_type: "video/mp4",
        ingested_at: new Date(),
        metadata: {
          vision: {
            athlete_present: false,
            description: "a bottle",
            brands_visible: [],
          },
        },
      } as never)
      .returning({ id: mediaAssets.id });
    const r = await post(ask({ productAssetIds: [clipRow.id] }));
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("productAssetIds");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("labels each library line with where the photo came from, read off the row's origin (C2, labels only)", async () => {
    await photo({ origin: "upload", platform: "upload" });
    await photo({ origin: "generated", platform: "studio" });
    await photo({ origin: "connected", platform: "instagram" });
    await photo({ origin: "connected", platform: "tiktok" });
    planReply([planned()]);

    await post(ask());

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    const from = (label: string) =>
      prompt.match(new RegExp(`^a\\d+ \\| .*\\| from: ${label} \\|`, "gm"))
        ?.length ?? 0;
    expect(from("her camera")).toBe(1);
    expect(from("made here")).toBe(1);
    // PR 4 B2b: a synced row off Instagram names the account; any other synced platform does not.
    expect(from("her instagram")).toBe(1);
    expect(from("synced from her accounts")).toBe(1);
  });

  /**
   * ⚠️ THE OFFER IS THE DOOR (found by the plan eval's first dry run, 22 Sep 2026). searchMedia has no
   * media_type filter, so a stitched compilation that ranks well comes back among "photos of her"
   * and would fill the clip room without ever passing listClips. MUTATION: drop the stitched check
   * from `offer` in studio/agent/library.ts — the first assertion reds; the pick half still passes.
   */
  it("never shows the planner a stitched compilation the search returned — but shows one she picked, labelled (doctrine, trust)", async () => {
    await photo();
    const stitchedRow = async () => {
      const [row] = await db
        .insert(mediaAssets)
        .values({
          athlete_id: HER,
          platform: "studio",
          origin: "generated",
          media_type: "VIDEO",
          status: "stored",
          // The publisher's own shape: no job, under the stitch path (video/materialize.ts).
          generation_job_id: null,
          gcs_path: `athletes/${HER}/studio/stitch/${randomUUID()}/output.mp4`,
          content_type: "video/mp4",
          duration_seconds_precise: 12.5,
          ingested_at: new Date(),
          metadata: {
            vision: {
              athlete_present: true,
              shot_type: "action",
              description: "a compilation of her season",
              brands_visible: [],
              setting: "various",
              vibe: "hype",
              beats: [],
              video: { source: "clip" },
            },
            embedding: [1, 0, 0],
          },
        } as never)
        .returning({ id: mediaAssets.id });
      return row.id;
    };
    const stitched = await stitchedRow();
    planReply([planned()]);

    await post(ask());
    const first = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    // The doctrine names "stitched here" as a rule; what must be absent is a LINE labelled with it.
    expect(first).not.toMatch(/^a\d+ \| .*from: stitched here/m);
    expect(first).not.toMatch(/a compilation of her season/);

    // Her own pick of it is offered — as what it is.
    await post(ask({ assetIds: [stitched] }));
    const second = generateContent.mock.calls[1][0].contents[0].parts[0]
      .text as string;
    expect(second).toMatch(
      /^a1 \| CLIP 12\.5s \| her pick: yes \| .*\| from: stitched here \|/m,
    );
  });

  /**
   * ⚠️ MUTATIONS, both red here and nowhere else: pass `avoid: []` to the caster (the route never
   * reads her sentence for a brand); and cast with `brandFlag: null` (the caster never says).
   *
   * Device check finding 3: an Adidas ad cast a photo with a Nike logo, and nothing said so. The
   * photo is still cast — nothing else fits — and she is told, in fact rather than verdict.
   */
  it("flags a photo showing a sportswear brand her sentence did not name — and says nothing when she named none", async () => {
    await photo({ brands: ["Nike", "a school crest"] });
    planReply([planned()]);

    const branded = await post(ask({ prompt: "an Adidas ad for the drop" }));
    const unbranded = await post(ask({ prompt: "something for the season" }));

    expect(branded.json.items[0].brandFlag).toBe("This photo shows Nike.");
    expect(unbranded.json.items[0].brandFlag).toBeNull();
  });

  it("shows the planner her picked photos first", async () => {
    await photo({ description: "somebody else's favourite" });
    const pick = await photo({ description: "the one she picked" });
    planReply([planned()]);

    await post(ask({ assetIds: [pick] }));

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(prompt).toMatch(/a1 \| her pick: yes \|[^\n]*the one she picked/);
  });

  /**
   * ─── FIX PASS 1 (enrichment eval, 22 Sep 2026) ────────────────────────────────────────────────
   * The subject guard (studio/agent/subject.ts), the her-room overfetch and the sport demotion
   * (studio/agent/library.ts). Each names its mutation.
   */
  const promptOf = (call = 0) =>
    generateContent.mock.calls[call][0].contents[0].parts[0].text as string;
  const lines = (prompt: string, answer: string) =>
    prompt.match(new RegExp(`^a\\d+ \\| person_in_frame: ${answer}`, "gm"))
      ?.length ?? 0;

  /**
   * ─── PR 12 — the library line carries what the tagger knows (docs/probes/library-fields.md) ──
   * Flag-gated: STUDIO_LIBRARY_FIELDS. With it off the line is what it always was (plan.test pins
   * the bytes); with it on the ten dropped fields ride as labels, a hard-flagged row is never
   * offered, and a plain reject is offered but never auto-cast.
   */
  describe("PR 12 — library fields", () => {
    afterEach(() => {
      delete process.env.STUDIO_LIBRARY_FIELDS;
    });

    it("with the flag off, no PR 12 label is on any line", async () => {
      await photo();
      planReply([planned()]);
      await post(ask());
      expect(promptOf()).toMatch(
        /^a1 \| person_in_frame: yes \| shot: action \| setting: a track \| vibe: warm \| brands: none seen \| from: /m,
      );
      expect(promptOf()).not.toMatch(/quality: |hero: |who: |face: /);
    });

    /** P-drop, end to end. ⚠️ MUTATION "library line drops aesthetic_quality": drop `quality:` in tagWords — reds. */
    it("with the flag on, every dropped field is on the line — and an old row reads unknown, never refused", async () => {
      process.env.STUDIO_LIBRARY_FIELDS = "true";
      await photo({
        metadata: {
          vision: {
            subject: "the_athlete",
            athlete_present: true,
            athlete_prominence: 0.95,
            shot_type: "portrait",
            description: "she looks to camera",
            brands_visible: [],
            aesthetic_quality: 0.8,
            brand_safe: false,
            content_flags: { violence_or_weapons: true },
            setting: "a gym",
            attire: "a red kit",
            vibe: "calm",
            hero_suitability: 0.7,
            disposition: "crop",
            edit_note: "tighten the frame",
            reason: "strong light",
            face_visibility: "clear",
            role: "identity",
          },
          embedding: [1, 0, 0],
        },
      });
      await photo({
        description: "she runs — an older row, tagged before the keys existed",
      });
      planReply([planned()]);
      await post(ask());
      const p = promptOf();
      expect(p).toMatch(
        /^a\d+ \| person_in_frame: yes \| shot: portrait \| setting: a gym \| vibe: calm \| brands: none seen \| who: the_athlete \| face: clear \| role: identity \| prominence: 1 \| quality: 0.8 \| hero: 0.7 \| brand_safe: no \| flags: violence_or_weapons \| attire: a red kit \| disposition: crop \| edit: tighten the frame \| reason: strong light \| from: /m,
      );
      expect(p).toMatch(
        /^a\d+ \| person_in_frame: yes \|[^\n]*who: unknown \| face: partial \| role: identity \| prominence: 0.8 \| quality: 0.8 \| hero: 0.8 \| brand_safe: yes \| flags: none \| attire:  \| disposition:  \| edit: none \| reason:  \|[^\n]*older row/m,
      );
    });

    /** ⚠️ MUTATION "planner sees a hard-flagged photo": drop the hardFlagged refusal in library.ts offer — reds. */
    it("a hard-flagged row is never offered, picked or not; a plain reject is offered with its label", async () => {
      process.env.STUDIO_LIBRARY_FIELDS = "true";
      const hard = await photo({
        description: "a hateful sign",
        metadata: {
          vision: {
            athlete_present: true,
            subject: "the_athlete",
            description: "a hateful sign",
            content_flags: { hateful: true },
            disposition: "reject",
            shot_type: "other",
            brands_visible: [],
          },
          embedding: [1, 0, 0],
        },
      });
      await photo({
        description: "a blurry reject of her",
        metadata: {
          vision: {
            athlete_present: true,
            subject: "the_athlete",
            description: "a blurry reject of her",
            content_flags: {},
            disposition: "reject",
            shot_type: "portrait",
            brands_visible: [],
          },
          embedding: [1, 0, 0],
        },
      });
      await photo();
      planReply([planned()]);
      await post(ask({ assetIds: [hard] }));
      const p = promptOf();
      expect(p).not.toMatch(/hateful sign/);
      expect(p).toMatch(
        /^a\d+ \|[^\n]*disposition: reject[^\n]*blurry reject of her/m,
      );
    });
  });

  /** ⚠️ MUTATION: `subjectOf` always "her" — P1a and P1b red by name; P1c stays green either way. */
  it("P1a · a photo the tagger describes as ANOTHER person never enters the library, whatever athlete_present says", async () => {
    await photo({
      description:
        "Professional soccer player Tomás Ferré mid-air controlling a soccer ball on the pitch.",
    });
    await photo();
    planReply([planned()]);
    await post(ask());
    expect(promptOf()).not.toMatch(/Tomás Ferré/);
    expect(lines(promptOf(), "yes")).toBe(1);
  });

  it("P1b · a photo the tagger describes as NOBODY enters as a scene — person_in_frame: no, after the ranked scenes — and cannot be cast as her", async () => {
    await photo({
      athletePresent: false,
      description: "an empty stadium at dawn",
    });
    const hands = await photo({
      description:
        "Close-up of hands holding a white squeeze bottle against a blurred field.",
    });
    await photo();
    // The planner names the hands photo as a shot of HER: refused by the caster on the SAME fact.
    planReply([
      planned({ ref: "a3" }),
      planned({ kind: "image", ref: "a3", beat: "hold" }),
    ]);
    const r = await post(ask());
    const prompt = promptOf();
    expect(prompt).toMatch(/^a1 \| person_in_frame: yes/m);
    expect(prompt).toMatch(/^a2 \| person_in_frame: no \|.*empty stadium/m);
    expect(prompt).toMatch(/^a3 \| person_in_frame: no \|.*hands holding/m);
    // Its named photo did not fit i2v on the guard's fact, so it was SWAPPED to the photo of her.
    expect(r.json.items[0].assetId).not.toBe(hands);
    expect(r.json.items[0].assetId).toBeTruthy();
    expect(r.json.items[0].swapped).toBeTruthy();
    // And held as an image it is cast as what it is — a scene, nobody in it.
    expect(r.json.items[1].assetId).toBe(hands);
    expect(r.json.items[1].athletePresent).toBe(false);
  });

  it("P1c · a photo the tagger describes as HER is unchanged", async () => {
    await photo({ description: "she leaps for a header in front of the net" });
    planReply([planned()]);
    const r = await post(ask());
    expect(lines(promptOf(), "yes")).toBe(1);
    expect(r.json.items[0].assetId).toBeTruthy();
  });

  /** ⚠️ MUTATION: `LIBRARY_SEARCH_KS = [24]` — red by name: 0 lines of her, where 16 are expected. */
  it("P2 · the photos-of-her room fills when the search's top 24 are all stitched compilations — the search is asked again, wider", async () => {
    for (let i = 0; i < 24; i++)
      await photo({
        origin: "generated",
        media_type: "VIDEO",
        generation_job_id: null,
        gcs_path: `athletes/${HER}/studio/stitch/${randomUUID()}/output.mp4`,
        content_type: "video/mp4",
        metadata: {
          vision: {
            athlete_present: true,
            athlete_prominence: 1,
            shot_type: "action",
            description: "she plays across a compilation of her season",
            brands_visible: [],
            aesthetic_quality: 1,
            brand_safe: true,
            hero_suitability: 1,
            content_flags: {},
            setting: "various",
            vibe: "hype",
            beats: [],
            video: { source: "clip" },
          },
          embedding: [1, 0, 0],
        },
      });
    for (let i = 0; i < 16; i++) await photo();
    planReply([planned()]);
    await post(ask());
    const prompt = promptOf();
    expect(lines(prompt, "yes")).toBe(16);
    expect(prompt).not.toMatch(/compilation of her season/);
  });

  /** ⚠️ MUTATION: offer `hits` in the search's order (drop the sameSport split) — red by name. */
  it("P5 · on a soccer brief, photos of her at another sport are offered AFTER photos of her at soccer — a demotion, never an exclusion", async () => {
    // Ranks first by hero score, so the search's own order would put it at a1.
    await photo({
      description: "she dribbles a basketball on an outdoor court",
      metadata: {
        vision: {
          athlete_present: true,
          athlete_prominence: 1,
          shot_type: "action",
          description: "she dribbles a basketball on an outdoor court",
          brands_visible: [],
          aesthetic_quality: 1,
          brand_safe: true,
          hero_suitability: 1,
          content_flags: {},
          setting: "outdoor basketball court",
          vibe: "focused",
        },
        embedding: [1, 0, 0],
      },
    });
    for (let i = 0; i < 16; i++)
      await photo({ description: "she strikes a soccer ball on the pitch" });
    planReply([planned()]);
    await post(ask({ prompt: "a soccer ad with me in it" }));
    const full = promptOf();
    expect(full).toMatch(/^her sport for this plan: soccer/m);
    expect(full).not.toMatch(/basketball/);
    expect(lines(full, "yes")).toBe(16);

    // With room to spare it IS offered — last among the photos of her, sport on its line.
    await db.delete(mediaAssets);
    await photo({
      description: "she dribbles a basketball on an outdoor court",
    });
    for (let i = 0; i < 3; i++)
      await photo({ description: "she strikes a soccer ball on the pitch" });
    planReply([planned()]);
    await post(ask({ prompt: "a soccer ad with me in it" }));
    const thin = promptOf(1);
    expect(thin).toMatch(
      /^a4 \| person_in_frame: yes \|.*sport: basketball \|.*basketball/m,
    );
    expect(thin).toMatch(/^a1 \| person_in_frame: yes \|.*sport: soccer \|/m);
  });

  /** ⚠️ MUTATION: fall back to the profile before the library's majority — red by name. */
  it("P5b · a brief that names no sport takes the sport her LIBRARY mostly shows, not her profile's — the test athlete's row says basketball, her footage is soccer", async () => {
    await db
      .update(athletes)
      .set({ sport: "Basketball" })
      .where(eq(athletes.id, HER));
    await photo({
      description: "she dribbles a basketball on an outdoor court",
      metadata: {
        vision: {
          athlete_present: true,
          athlete_prominence: 1,
          shot_type: "action",
          description: "she dribbles a basketball on an outdoor court",
          brands_visible: [],
          aesthetic_quality: 1,
          brand_safe: true,
          hero_suitability: 1,
          content_flags: {},
          setting: "outdoor basketball court",
          vibe: "focused",
        },
        embedding: [1, 0, 0],
      },
    });
    for (let i = 0; i < 3; i++)
      await photo({ description: "she strikes a soccer ball on the pitch" });
    planReply([planned()]);
    await post(ask({ prompt: "a recap of this week's training" }));
    const full = promptOf();
    expect(full).toMatch(/^her sport for this plan: soccer/m);
    expect(full).toMatch(
      /^a4 \| person_in_frame: yes \|.*sport: basketball \|/m,
    );
    await db.update(athletes).set({ sport: null }).where(eq(athletes.id, HER));
  });

  /**
   * ⚠️ MUTATIONS (studio/agent/library.ts), red HERE by name: let a plurality through in
   * `briefSport` — "sport tie silently resolves against row"; skip the assembly's warn, or make
   * `sportDisagrees` strict — "assembly proceeds on high disagreement without warning".
   */
  it("P5c · a slice split 50/50 is not her library deciding: the athlete row settles the sport, and the assembly warns instead of proceeding in silence (23 Sep 2026)", async () => {
    await db
      .update(athletes)
      .set({ sport: "Soccer" })
      .where(eq(athletes.id, HER));
    for (let i = 0; i < 2; i++)
      await photo({
        description: "she dribbles a basketball on an outdoor court",
        metadata: {
          vision: {
            athlete_present: true,
            athlete_prominence: 1,
            shot_type: "action",
            description: "she dribbles a basketball on an outdoor court",
            brands_visible: [],
            aesthetic_quality: 1,
            brand_safe: true,
            hero_suitability: 1,
            content_flags: {},
            setting: "outdoor basketball court",
            vibe: "focused",
          },
          embedding: [1, 0, 0],
        },
      });
    for (let i = 0; i < 2; i++)
      await photo({ description: "she strikes a soccer ball on the pitch" });
    planReply([planned()]);
    await post(ask({ prompt: "a recap of this week's training" }));
    // The row, not whichever sport the search happened to rank first.
    expect(promptOf()).toMatch(/^her sport for this plan: soccer/m);
    // Both readers said so: briefSport that the slice split, the assembly that the footage disagrees.
    const warns = mockLogs
      .filter((l) => l.name === "studio/agent/library" && l.level === "warn")
      .map((l) => l.args);
    expect(warns.map((c) => c[1])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^agent library sport split/),
        expect.stringMatching(/^agent library sport disagreement/),
      ]),
    );
    const split = warns.find((c) => /sport split/.test(String(c[1])))?.[0];
    expect(split).toMatchObject({
      split: 0.5,
      sport: "soccer",
      source: "profile",
    });
    const assembled = warns.find((c) =>
      /sport disagreement/.test(String(c[1])),
    )?.[0];
    expect(assembled).toMatchObject({
      sport: "soccer",
      sportSource: "profile",
      sportDisagreement: 0.5,
      sportSplit: 0.5,
    });
    await db.update(athletes).set({ sport: null }).where(eq(athletes.id, HER));
  });

  it("D2 · a clip item's window inside its beat is the cast trim, and every cast item says where it came from", async () => {
    await photo();
    const [clipRow] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "studio",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${HER}/long.mp4`,
        gcs_thumb_path: `athletes/${HER}/long-poster.jpg`,
        content_type: "video/mp4",
        duration_seconds_precise: 51.5,
        ingested_at: new Date(),
        metadata: {
          vision: {
            athlete_present: true,
            shot_type: "action",
            description: "she trains on the pitch",
            brands_visible: [],
            setting: "pitch",
            vibe: "focused",
            beats: [
              {
                start_s: 0,
                end_s: 9.5,
                description: "she ties her cleats",
                camera: "static",
                motion: "still",
              },
              {
                start_s: 20.5,
                end_s: 30.5,
                description: "she dribbles down the field",
                camera: "tracking",
                motion: "she runs",
              },
            ],
            video: { source: "clip" },
          },
          embedding: [1, 0, 0],
        },
      } as never)
      .returning({ id: mediaAssets.id });
    planReply([
      planned({
        kind: "clip",
        ref: "a2",
        segment: 1,
        window: { startSec: 22.5, endSec: 26 },
        searchQuery: null,
        sound: true,
      }),
      planned({ ref: "a1" }),
    ]);
    const r = await post(
      ask({ prompt: "recap my training, use live footage" }),
    );
    expect(r.json.items[0]).toMatchObject({
      assetId: clipRow.id,
      trim: { startSec: 22.5, endSec: 26 },
      provenance: "camera",
    });
    expect(r.json.items[1]).toMatchObject({ provenance: "camera" });
    expect(promptOf()).toMatch(/OUTRANKS a "made here" line/);
  });

  /**
   * ─── THE d076a790 MECHANISM (live, 22 Sep 2026 11:06) ───────────────────────────────────────
   * The acceptance run listed eight clips and her 51 s camera upload was not among them, while
   * another camera clip was. searchMedia has no media-type filter, so her clips came back among
   * the "photos of her" and the her-room pass offered them IN THE SEARCH'S ORDER — the clip room
   * was full before listClips' camera-first order ran, and the camera clip that ranked low for the
   * brief was refused at "room full". Clips enter through listClips alone now.
   *
   * ⚠️ MUTATION, red here by name: drop the `mediaType !== "clip"` guard from `fillsHer` — the
   * low-ranked camera clip is refused again.
   */
  it("D076 · a camera clip the search ranks low is still listed — clips enter through listClips alone, never through the photos-of-her search", async () => {
    const clipRow = (over: Record<string, unknown>) =>
      db
        .insert(mediaAssets)
        .values({
          athlete_id: HER,
          platform: "studio",
          media_type: "VIDEO",
          status: "stored",
          content_type: "video/mp4",
          duration_seconds_precise: 6,
          ingested_at: new Date(Date.now() - 600_000),
          ...over,
        } as never)
        .returning({ id: mediaAssets.id });
    const vision = (description: string, hero: number) => ({
      athlete_present: true,
      athlete_prominence: 1,
      shot_type: "action",
      description,
      brands_visible: [],
      aesthetic_quality: hero,
      brand_safe: true,
      hero_suitability: hero,
      content_flags: {},
      setting: "pitch",
      vibe: "fast",
      beats: [],
      video: { source: "clip" },
    });
    // Nine made-here clips that rank HIGHER for the brief than her camera clip.
    for (let i = 0; i < 9; i++)
      await clipRow({
        origin: "generated",
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${HER}/made-${i}.mp4`,
        ingested_at: new Date(),
        metadata: {
          vision: vision(`she sprints in made-here clip ${i}`, 1),
          embedding: [1, 0, 0],
        },
      });
    const [camera] = await clipRow({
      origin: "upload",
      gcs_path: `athletes/${HER}/her-51s.mp4`,
      metadata: {
        vision: vision("she trains for 51 seconds", 0.5),
        embedding: [1, 0, 0],
      },
    });
    planReply([
      planned({ kind: "clip", ref: "a1", segment: null, searchQuery: null }),
    ]);
    const r = await post(
      ask({ prompt: "recap my training, use live footage" }),
    );
    const prompt = promptOf();
    expect(prompt).toMatch(/^a1 \| CLIP 6s \|.*from: her camera/m);
    expect(prompt).toMatch(/she trains for 51 seconds/);
    expect(r.json.items[0].assetId).toBe(camera.id);
  });

  /**
   * ⚠️ MUTATIONS, each red here by name: `verifiedFirst` returns rows unsorted — the order case
   * reds; `verifiedOf` returns true for every camera row — the label case reds.
   */
  it("V3 · a verified camera clip lists before an unverified one whatever its date, the line says which, and a synced or made-here row carries neither word", async () => {
    await photo();
    const clipRow = (over: Record<string, unknown>) =>
      db
        .insert(mediaAssets)
        .values({
          athlete_id: HER,
          platform: "studio",
          media_type: "VIDEO",
          status: "stored",
          content_type: "video/mp4",
          duration_seconds_precise: 6,
          ...over,
        } as never)
        .returning({ id: mediaAssets.id });
    const vision = (
      description: string,
      more: Record<string, unknown> = {},
    ) => ({
      athlete_present: true,
      shot_type: "action",
      description,
      brands_visible: [],
      setting: "pitch",
      vibe: "fast",
      beats: [],
      video: { source: "clip" },
      ...more,
    });
    // Newest first would put the UNVERIFIED upload first: it is ingested later.
    await clipRow({
      origin: "upload",
      gcs_path: `athletes/${HER}/unverified.mp4`,
      ingested_at: new Date(),
      metadata: {
        vision: vision("she sprints — unverified"),
        provenance_signal: { signal: "no-device-metadata" },
        embedding: [1, 0, 0],
      },
    });
    await clipRow({
      origin: "upload",
      gcs_path: `athletes/${HER}/verified.mp4`,
      ingested_at: new Date(Date.now() - 60_000),
      metadata: {
        vision: vision("she sprints — verified"),
        provenance_signal: { signal: "device-camera" },
        embedding: [1, 0, 0],
      },
    });
    await clipRow({
      origin: "connected",
      gcs_path: `athletes/${HER}/synced.mp4`,
      ingested_at: new Date(Date.now() - 120_000),
      metadata: {
        vision: vision("a synced reel"),
        embedding: [1, 0, 0],
      },
    });
    await clipRow({
      origin: "generated",
      generation_job_id: randomUUID(),
      gcs_path: `athletes/${HER}/made.mp4`,
      ingested_at: new Date(Date.now() - 180_000),
      metadata: {
        vision: vision("a made-here clip"),
        embedding: [1, 0, 0],
      },
    });
    planReply([planned()]);
    await post(ask());
    const prompt = promptOf();
    const lines = prompt.split("\n").filter((l) => /^a\d+ \| CLIP/.test(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /from: her camera \(verified\) \|.*she sprints — verified/,
    );
    expect(lines[1]).toMatch(
      /from: her camera \(unverified\) \|.*she sprints — unverified/,
    );
    expect(lines[2]).toMatch(/from: synced from her accounts \| sport/);
    expect(lines[3]).toMatch(/from: made here \| sport/);
    expect(lines[2]).not.toMatch(/verified/);
    expect(lines[3]).not.toMatch(/verified/);
    expect(prompt).toMatch(/\(verified\) before one marked \(unverified\)/);
  });

  it.each([
    ["an unknown field", { costUsd: 0 }, "costUsd"],
    ["no sentence", { prompt: "   " }, "prompt"],
    ["an objective we do not have", { objective: "go-viral" }, "objective"],
    ["a picked id that is not a uuid", { assetIds: ["a7"] }, "assetIds"],
    [
      "more products than a plan takes",
      {
        productAssetIds: Array.from(
          { length: 6 },
          (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
        ),
      },
      "productAssetIds",
    ],
    ["the old single-product field", { productAssetId: HER }, "productAssetId"],
  ])("400s %s, and calls no model", async (_label, over, field) => {
    const { status, json } = await post(ask(over));
    expect(status).toBe(400);
    expect(json.field).toBe(field);
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("POST /studio/agent/plan — the teammates fixture: a made-here still is never an i2v ref unless she picked it (S1)", () => {
  const TEAMMATES =
    "A female soccer player smiles joyfully while dribbling a ball; teammates frame the foreground";
  /** The planner names whichever ref the teammates line was shown under — read off the prompt it was sent. */
  const planNamingTheTeammatesLine = (over: Record<string, unknown> = {}) =>
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const ref = text.match(
        /^(a\d+) \| .*teammates frame the foreground/m,
      )?.[1];
      if (!ref) throw new Error("the teammates line was not shown");
      return { text: JSON.stringify({ items: [planned({ ref, ...over })] }) };
    });

  /**
   * ⚠️ MUTATION: drop the provenance clause from cast.ts `fitsKind` — the first case reds (the
   * lookalike is the i2v ref); the second stays green.
   */
  it("named as an i2v ref, the made-here teammates still is swapped to her upload — never animated as her", async () => {
    const lookalike = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: TEAMMATES,
    });
    const hers = await photo({ origin: "upload", platform: "upload" });
    planNamingTheTeammatesLine();
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "i2v",
      assetId: hers,
      provenance: "camera",
      swapped: expect.any(String),
    });
    expect(r.json.items[0].assetId).not.toBe(lookalike);
  });

  /** ⚠️ MUTATION: keep the direction on swap (cast.ts castTo) — this reds by name. */
  it("the swap takes the words too: a direction written about the teammates still is rewritten to the upload's own line, and the card is told", async () => {
    await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: TEAMMATES,
    });
    const hers = await photo({
      origin: "upload",
      platform: "upload",
      description: "she stands on the track in the sun",
    });
    planNamingTheTeammatesLine({
      direction:
        "She smiles joyfully while dribbling, framed by the shoulders of her teammates in the foreground",
    });
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      assetId: hers,
      rewritten: expect.stringMatching(/rewritten/i),
      direction: expect.stringMatching(/^she stands on the track in the sun/),
    });
    expect(r.json.items[0].direction).not.toMatch(/teammates/);
  });

  it("picked by her, the same still is cast as the i2v she asked for — her decision, labelled MADE HERE", async () => {
    const chosen = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: TEAMMATES,
    });
    await photo({ origin: "upload", platform: "upload" });
    planNamingTheTeammatesLine();
    const r = await post(ask({ assetIds: [chosen] }));
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "i2v",
      assetId: chosen,
      provenance: "made-here",
      swapped: null,
    });
  });
});

describe("POST /studio/agent/plan — a clip item carries the tagger's stored edit note (C3, D1)", () => {
  const clipWith = async (vision: Record<string, unknown>) => {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "upload",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${HER}/${Math.random().toString(36).slice(2)}.mp4`,
        gcs_thumb_path: `athletes/${HER}/p.jpg`,
        content_type: "video/mp4",
        duration_seconds_precise: 5,
        ingested_at: new Date(),
        metadata: {
          vision: {
            athlete_present: true,
            shot_type: "action",
            description: "she juggles the ball",
            brands_visible: [],
            setting: "pitch",
            vibe: "calm",
            beats: [],
            video: { source: "clip" },
            ...vision,
          },
          embedding: [1, 0, 0],
        },
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  };

  /** ⚠️ MUTATION: drop `editNote` from cast.ts `castTo` — the first case reds by name. */
  it("a cropped clip's note rides the item; an as-is clip's does not; no model call is added", async () => {
    await photo();
    const clip = await clipWith({
      disposition: "crop",
      edit_note: "tighten to her, waist up",
    });
    planReply([planned({ kind: "clip", ref: "a2", searchQuery: null })]);
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "clip",
      assetId: clip,
      editNote: "tighten to her, waist up",
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("as_is: the item's editNote is null", async () => {
    await photo();
    const clip = await clipWith({
      disposition: "as_is",
      edit_note: "none needed",
    });
    planReply([planned({ kind: "clip", ref: "a2", searchQuery: null })]);
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "clip",
      assetId: clip,
      editNote: null,
    });
  });
});

describe("POST /studio/agent/plan — a made-here still generated FROM her is an i2v ref (S2)", () => {
  it("the teammates still, when its job carried her reference, is cast as the i2v she named", async () => {
    const { generationJobs } = jest.requireActual(
      "../../shared/schema",
    ) as typeof import("../../shared/schema");
    const [job] = await db
      .insert(generationJobs)
      .values({
        athlete_id: HER,
        origin: "system",
        mode: "generate",
        objective: "grow-following",
        deliverable: "post",
        brief: { job: { references: [{ role: "person" }] } },
        status: "succeeded",
      } as never)
      .returning({ id: generationJobs.id });
    const bound = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: job.id,
      description:
        "A female soccer player smiles joyfully while dribbling a ball; teammates frame the foreground",
    });
    await photo({ origin: "upload", platform: "upload" });
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const ref = text.match(
        /^(a\d+) \| .*teammates frame the foreground/m,
      )![1];
      return { text: JSON.stringify({ items: [planned({ ref })] }) };
    });
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "i2v",
      assetId: bound,
      provenance: "made-here",
      swapped: null,
    });
  });
});

describe("POST /studio/agent/plan — an image item's push-in rides the cast item (C3, D2)", () => {
  it("motion pan on an image arrives as motion: 'pan'; an i2v never carries one", async () => {
    await photo();
    await photo({ athletePresent: false, description: "her boots on a step" });
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const boots = text.match(/^(a\d+) \| .*her boots on a step/m)![1];
      const her = text.match(
        /^(a\d+) \| .*she stands on the track in the sun/m,
      )![1];
      return {
        text: JSON.stringify({
          items: [
            planned({
              kind: "image",
              ref: boots,
              searchQuery: "boots",
              motion: "dolly",
              sound: false,
            }),
            planned({ ref: her, motion: "dolly" }),
          ],
        }),
      };
    });
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "image",
      motion: "dolly",
      uncast: null,
    });
    expect(r.json.items[1]).toMatchObject({
      kind: "i2v",
      motion: null,
      uncast: null,
    });
  });
});

describe("POST /studio/agent/plan — the training-recap fixture: on an own-footage brief a made-here still at $0 is dropped or swapped (S1b)", () => {
  const RECAP = "a recap of this week's training, using what I actually filmed";
  const nameTheStill = (over: Record<string, unknown>) =>
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const ref = text.match(
        /^(a\d+) \| .*her boots on the step after training/m,
      )![1];
      return {
        text: JSON.stringify({
          items: [
            planned({
              kind: "image",
              ref,
              searchQuery: "boots on the step",
              sound: false,
              ...over,
            }),
          ],
        }),
      };
    });

  /** ⚠️ MUTATION: exempt held stills from cast.ts's own-footage gate — the first case reds by name. */
  it("a made-here still named as a held image is swapped to her upload", async () => {
    const made = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: "her boots on the step after training",
    });
    const hers = await photo({ origin: "upload", platform: "upload" });
    nameTheStill({});
    const r = await post(ask({ prompt: RECAP, objective: "recap" }));
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "image",
      assetId: hers,
      provenance: "camera",
      swapped: expect.any(String),
    });
    expect(r.json.items[0].assetId).not.toBe(made);
  });

  it("pushed in, with no upload to swap to, it is left out and shown", async () => {
    await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: "her boots on the step after training",
    });
    nameTheStill({ motion: "dolly" });
    const r = await post(ask({ prompt: RECAP, objective: "recap" }));
    expect(r.status).toBe(422);
  });

  it("the same still on a brief that does not ask for her footage is held as it was", async () => {
    const made = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: randomUUID(),
      description: "her boots on the step after training",
    });
    nameTheStill({});
    const r = await post(ask({ prompt: "something for the new season" }));
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "image",
      assetId: made,
      provenance: "made-here",
      swapped: null,
    });
  });
});

describe("POST /studio/agent/plan — a campaign brief, behind STUDIO_BRAND_PROFILES (PR 6, 6b)", () => {
  const { campaign } = JSON.parse(
    readFileSync(
      join(
        __dirname,
        "..",
        "studio",
        "campaign",
        "fixtures",
        "bottle-campaign.json",
      ),
      "utf8",
    ),
  ) as { campaign: Record<string, unknown> };
  const promptSent = () =>
    generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
  afterEach(() => {
    delete process.env.STUDIO_BRAND_PROFILES;
  });

  /** ⚠️ MUTATION: drop the brandProfilesEnabled() check on `campaign` — this reds by name. */
  it("with the flag off a campaign is an unknown field, and nothing is called", async () => {
    await photo();
    planReply([planned()]);
    const r = await post(ask({ campaign }));
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ field: "campaign" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("with it on, the brief reaches the planner inside its fence and is stored on the plan row", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    planReply([planned()]);
    const r = await post(ask({ campaign }));
    expect(r.status).toBe(200);
    expect(promptSent()).toContain("<<<CAMPAIGN>>>");
    expect(promptSent()).toContain(
      '"the matte-black Solstice insulated bottle"',
    );
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, r.json.planId));
    expect(row.brief).toMatchObject({
      brand: { name: "Solstice" },
      product: { line: "the matte-black Solstice insulated bottle" },
    });
    // And no athlete id anywhere in what was stored as the brief.
    expect(JSON.stringify(row.brief)).not.toContain(HER);
  });

  const INTENT = {
    composition: { summary: "Centered.", tags: ["centered"], basis: "observed" },
    camera: { summary: "A static medium shot.", tags: ["medium", "static"], basis: "observed" },
    lens_perspective: null,
    lighting: { summary: "Soft studio light.", tags: ["studio", "soft_light"], basis: "inferred" },
    color: { summary: "Muted.", tags: [], basis: "observed" },
    environment: null,
    subject_placement: null,
    wardrobe: null,
    motion: null,
    editing_rhythm: null,
    typography: null,
    emotional_tone: { summary: "Calm.", tags: [], basis: "observed" },
  };
  const withRef = (over: Record<string, unknown> = {}) => ({
    ...campaign,
    references: [{ ref: "ref_1", role: "style_reference", intent: INTENT, ...over }],
  });
  const rowOfPlan = async (id: string) => {
    const [row] = await db.select().from(studioPlans).where(eq(studioPlans.id, id));
    return row;
  };

  /** ⚠️ MUTATION (PR 14, R-6): skip resolveReferenceAssets on the plan route — "ref_N handle reaches compile unresolved" reds by name. */
  it("P-ref: ref_1 is resolved at save to the asset its reading was made from, under her id, and stored on the row", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    const asset = await photo();
    await db.insert(studioReferenceAnalyses).values({
      athlete_id: HER,
      source_kind: "image",
      source_asset_id: asset,
      role: "style_reference",
      decomposition: { schema: "reference-decomposition/1", reference_intent: INTENT, commercial_style: [] },
      prompt_version: "reference-decomposition/1",
      model: "test",
    } as never);
    planReply([planned()]);
    const r = await post(ask({ campaign: withRef() }));
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 200 });
    const row = await rowOfPlan(r.json.planId);
    expect((row.brief as { references: unknown[] }).references).toEqual([
      { ref: "ref_1", role: "style_reference", intent: INTENT, assetId: asset },
    ]);
    // The planner saw the whole reading — tags and basis — and never the asset id.
    expect(promptSent()).toContain("camera: A static medium shot. [medium, static] (observed)");
    expect(promptSent()).not.toContain(asset);
  });

  it("another athlete's identical reading is not hers to resolve: the row stores the handle and its reading, no asset", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    const theirs = await photo({ owner: SOMEONE_ELSE });
    await db.insert(studioReferenceAnalyses).values({
      athlete_id: SOMEONE_ELSE,
      source_kind: "image",
      source_asset_id: theirs,
      role: "style_reference",
      decomposition: { schema: "reference-decomposition/1", reference_intent: INTENT, commercial_style: [] },
      prompt_version: "reference-decomposition/1",
      model: "test",
    } as never);
    planReply([planned()]);
    const r = await post(ask({ campaign: withRef() }));
    expect(r.status).toBe(200);
    const refs = (await rowOfPlan(r.json.planId)).brief as { references: Record<string, unknown>[] };
    expect("assetId" in refs.references[0]).toBe(false);
  });

  /** ⚠️ MUTATION: drop the postsReferenceAsset check — "a client-posted reference assetId is stored" reds by name. */
  it("a client-posted reference assetId is refused before any model call — an id from a client is never trusted", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    planReply([planned()]);
    const r = await post(ask({ campaign: withRef({ assetId: "22222222-2222-4222-8222-222222222222" }) }));
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ field: "campaign" });
    expect(r.json.error).toMatch(/resolved here, never sent/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  /**
   * The green side of "confirmed output block reaches the planner as video/9:16 after confirming image/4:5"
   * (PR 10, R-3; Adi's test 2). The client half — the assembly no longer overwrites the confirmed block —
   * is brandPlan.test; this is the server half, through the real route with the model mocked.
   */
  it("through the real plan route, a confirmed image/4:5 brief reaches the planner as 'deliver as: image, 4:5' with its product intact — never video/9:16 (PR 10, R-3)", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    planReply([planned()]);
    const confirmed = {
      ...campaign,
      output: { type: "image", aspect_ratio: "4:5", platform: null },
    };
    const r = await post(ask({ campaign: confirmed }));
    expect(r.status).toBe(200);
    const block = promptSent().slice(promptSent().indexOf("<<<CAMPAIGN>>>"), promptSent().indexOf("<<<END_CAMPAIGN>>>"));
    expect(block).toContain("deliver as: image, 4:5");
    expect(block).not.toContain("9:16");
    expect(block).not.toContain("deliver as: video");
    expect(block).toContain('"the matte-black Solstice insulated bottle"');
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, r.json.planId));
    expect(row.brief).toMatchObject({
      output: { type: "image", aspect_ratio: "4:5", platform: null },
      product: { line: "the matte-black Solstice insulated bottle" },
    });
  });

  it("an invalid brief — an unknown key, an athlete id — is a 400 with its issues, before any model call", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    planReply([planned()]);
    const r = await post(ask({ campaign: { ...campaign, athlete_id: HER } }));
    expect(r.status).toBe(400);
    expect(r.json.issues.join(" ")).toMatch(/athlete_id/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a product handle beyond the products she picked is a 400, before any model call", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    await photo();
    planReply([planned()]);
    const r = await post(
      ask({
        campaign: {
          ...campaign,
          product: { ref: "product_1", fidelity: "high", line: null },
        },
      }),
    );
    expect(r.status).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("POST /studio/agent/plan — concept before coverage (PR 6, 6c)", () => {
  const three = [
    {
      angle: "the work nobody sees",
      feeling: "quiet",
      line: "The reps before anyone watches.",
    },
    {
      angle: "one touch, slowed down",
      feeling: "precise",
      line: "A single first touch, taken apart.",
    },
    {
      angle: "the team around her",
      feeling: "warm",
      line: "Training as a crew.",
    },
  ];
  beforeEach(async () => {
    await db.delete(studioPlans);
  });

  it("stage concepts: one model call, two or three concepts, no plan stored — and the call saw none of her library", async () => {
    await photo({
      description: "UNIQUE-LIBRARY-WORDS she sprints on the track",
    });
    generateContent.mockResolvedValue({
      text: JSON.stringify({ concepts: three }),
    });
    const r = await post(ask({ stage: "concepts" }));
    expect(r.status).toBe(200);
    expect(r.json.concepts.map((c: { id: string }) => c.id)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(generateContent).toHaveBeenCalledTimes(1);
    const sent = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(sent).not.toContain("UNIQUE-LIBRARY-WORDS");
    expect(sent).not.toContain("<<<LIBRARY>>>");
    expect(await db.select().from(studioPlans)).toHaveLength(0);
  });

  it("the concept she picked reaches the planner fenced, and is stored on the plan row", async () => {
    await photo();
    planReply([planned()]);
    const r = await post(ask({ concept: { id: "B", ...three[1] } }));
    expect(r.status).toBe(200);
    const sent = generateContent.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(sent).toContain("<<<CONCEPT>>>");
    expect(sent).toContain("concept B: one touch, slowed down — precise");
    expect(r.json.concept).toEqual({ id: "B", ...three[1] });
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, r.json.planId));
    expect(row.concept).toEqual({ id: "B", ...three[1] });
  });

  it("a malformed concept, or a concept with stage concepts, or another stage, is a 400 before any call", async () => {
    await photo();
    planReply([planned()]);
    expect(
      (await post(ask({ concept: { id: "D", ...three[0] } }))).status,
    ).toBe(400);
    expect(
      (
        await post(
          ask({ stage: "concepts", concept: { id: "A", ...three[0] } }),
        )
      ).status,
    ).toBe(400);
    expect((await post(ask({ stage: "plan" }))).status).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("POST /studio/agent/plan — the brand flow's linkage: her deliverable and her brief, on the plan row (PR 6, 6d)", () => {
  async function deliverableOf(owner: string): Promise<string> {
    const [deal] = await db
      .insert(deals)
      .values({ athlete_id: owner, brand_name: "Synthetic Brand" } as never)
      .returning({ id: deals.id });
    const [d] = await db
      .insert(dealDeliverables)
      .values({ deal_id: deal.id, seq: 1, format: "1 reel" } as never)
      .returning({ id: dealDeliverables.id });
    return d.id;
  }
  beforeEach(async () => {
    await db.delete(studioPlans);
  });
  afterEach(() => {
    delete process.env.STUDIO_BRAND_PROFILES;
  });

  it("stores her deliverable and her brief's path on the plan row, and answers the deliverable", async () => {
    await photo();
    planReply([planned()]);
    const d = await deliverableOf(HER);
    const briefFilePath = `studio-briefs/${HER}/${randomUUID()}.pdf`;
    const r = await post(ask({ dealDeliverableId: d, briefFilePath }));
    expect(r.status).toBe(200);
    expect(r.json.dealDeliverableId).toBe(d);
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, r.json.planId));
    expect(row).toMatchObject({
      deal_deliverable_id: d,
      brief_file_path: briefFilePath,
    });
  });

  /** ⚠️ MUTATION: drop the athlete predicate in studio/agent/plans.ts ownsDeliverable — this reds by name. */
  it("another athlete's deliverable is refused, before any model call", async () => {
    await photo();
    planReply([planned()]);
    const theirs = await deliverableOf(SOMEONE_ELSE);
    const r = await post(ask({ dealDeliverableId: theirs }));
    expect(r.status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a brief path outside her own prefix is refused, before any model call", async () => {
    await photo();
    planReply([planned()]);
    for (const briefFilePath of [
      `studio-briefs/${SOMEONE_ELSE}/${randomUUID()}.pdf`,
      `athletes/${HER}/contracts/x.pdf`,
      `studio-briefs/${HER}/../${SOMEONE_ELSE}/a.pdf`,
    ]) {
      expect((await post(ask({ briefFilePath }))).status).toBe(400);
    }
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("the brief upload url: a PDF under her own prefix, behind STUDIO_BRAND_PROFILES", async () => {
    const mint = (body: unknown) =>
      fetch(`${base}/studio/briefs/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => ({
        status: res.status,
        json: (await res.json().catch(() => null)) as any,
      }));
    expect((await mint({ contentType: "application/pdf" })).status).toBe(404);
    process.env.STUDIO_BRAND_PROFILES = "true";
    expect((await mint({ contentType: "image/png" })).status).toBe(415);
    expect(
      (await mint({ contentType: "application/pdf", bytes: 30 * 1024 * 1024 }))
        .status,
    ).toBe(413);
    const ok = await mint({ contentType: "application/pdf", bytes: 1000 });
    expect(ok.status).toBe(200);
    expect(ok.json.briefFilePath).toMatch(
      new RegExp(`^studio-briefs/${HER}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(ok.json.uploadUrl).toBe(
      `https://signed-put.example/${ok.json.briefFilePath}`,
    );
  });

  /**
   * The upload door branches on capability (PR 7, Lane E): Cloud Run signs, a laptop's ADC cannot. Both
   * branches are held HERE — signer present, signer absent — so neither is assumed. ⚠️ MUTATION
   * (routes/studio.ts): answer 500 on a SigningError — "signer absent: 501 signing_unavailable, never a
   * 500" reds by name.
   */
  it("signer present: the mint serves and says so on one greppable line; signer absent: 501 signing_unavailable, never a 500, and the line names the fallback", async () => {
    process.env.STUDIO_BRAND_PROFILES = "true";
    const mint = () =>
      fetch(`${base}/studio/briefs/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: "application/pdf", bytes: 1000 }),
      }).then(async (res) => ({
        status: res.status,
        json: (await res.json().catch(() => null)) as any,
      }));
    const routeLogs = () =>
      mockLogs.filter((l) => l.name === "routes/studio").map((l) => l.args);
    const before = routeLogs().length;

    const signed = await mint();
    expect(signed.status).toBe(200);
    expect(routeLogs().slice(before)).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({ path: "signed-url" }),
          "brief upload path: signed-url",
        ],
      ]),
    );

    const signer = jest.requireMock("../lib/inboxAttachmentStore")
      .signedAttachmentUploadUrl as jest.Mock;
    signer.mockRejectedValueOnce(
      Object.assign(new Error("Cannot sign data without `client_email`."), {
        name: "SigningError",
      }),
    );
    const unsigned = await mint();
    expect(unsigned.status).toBe(501);
    expect(unsigned.json).toEqual({
      error: "signing_unavailable",
      fallback: "raw",
    });
    const fallbackLine = routeLogs().find((c) =>
      /no signer in this runtime/.test(String(c[1])),
    );
    expect(fallbackLine?.[0]).toMatchObject({ path: "raw-fallback" });
    // Any other failure is still the plain 500 it was.
    signer.mockRejectedValueOnce(new Error("bucket unreachable"));
    expect((await mint()).status).toBe(500);
  });
});

describe("stored plans — a plan is a versioned object, re-opened without a re-plan (PR 6, 6a3)", () => {
  const get = async (id: string) => {
    const res = await fetch(`${base}/studio/agent/plans/${id}`);
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as any,
    };
  };
  beforeEach(async () => {
    await db.delete(studioPlans);
  });
  const answer = () =>
    planReply([
      planned({
        reason: {
          entry: "i2v",
          fits: "her turn to camera",
          over: "image.held",
        },
      }),
      planned({ kind: "broll", ref: null, searchQuery: null }),
    ]);

  it("stores the plan it answers, and re-opens the same object — no planner, no search on the read", async () => {
    await photo();
    answer();
    const made = await post(ask());
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({
      planId: expect.any(String),
      version: 1,
      parentPlanId: null,
    });

    generateContent.mockClear();
    (embedText as jest.Mock).mockClear();
    const opened = await get(made.json.planId);
    expect(opened.status).toBe(200);
    expect(opened.json.items).toEqual(made.json.items);
    expect(opened.json).toMatchObject({
      planId: made.json.planId,
      version: 1,
      castCount: made.json.castCount,
      look: made.json.look,
      music: made.json.music,
      gaps: made.json.gaps,
    });
    expect(generateContent).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it("stores no signed url — the read signs afresh", async () => {
    await photo();
    answer();
    const made = await post(ask());
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, made.json.planId));
    expect(row.athlete_id).toBe(HER);
    const stored = row.plan as { items: { thumbUrl: string | null }[] };
    expect(stored.items[0].thumbUrl).toBeNull();
    expect(made.json.items[0].thumbUrl).toMatch(/^https:\/\/signed\.example\//);
  });

  it("a regenerate writes a child: version 2, its parent the first", async () => {
    await photo();
    answer();
    const first = await post(ask());
    answer();
    const second = await post(ask({ parentPlanId: first.json.planId }));
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      version: 2,
      parentPlanId: first.json.planId,
    });
    const [row] = await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, second.json.planId));
    expect(row).toMatchObject({
      version: 2,
      parent_plan_id: first.json.planId,
    });
  });

  /** ⚠️ MUTATION: drop the athlete filter in studio/agent/plans.ts readPlan — this reds by name. */
  it("cross-athlete plan read: another athlete's plan is a 404 — to read, and as a parent, before any model call", async () => {
    await photo();
    answer();
    const hers = await post(ask());
    (globalThis as any).__TEST_ATHLETE_ID = SOMEONE_ELSE;
    expect((await get(hers.json.planId)).status).toBe(404);
    generateContent.mockClear();
    const regen = await post(ask({ parentPlanId: hers.json.planId }));
    expect(regen.status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("an id that is not a uuid, or not a plan, is a 404; with STUDIO_AGENT off the read does not exist", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await get(randomUUID())).status).toBe(404);
    delete process.env.STUDIO_AGENT;
    expect((await get(randomUUID())).status).toBe(404);
  });
});

describe("POST /studio/agent/plan — each item's reason, and the plan's look and music, reach her (PR 6, 6a2)", () => {
  it("carries a library reason on the item, nulls one outside the library, and answers the look and the music", async () => {
    await photo();
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        items: [
          planned({
            kind: "image",
            motion: "zoom",
            focus: { x: 0.5, y: 0.3 },
            reason: {
              entry: "image.motion.zoom",
              fits: "arrive at her face",
              over: "i2v",
            },
          }),
          planned({
            kind: "broll",
            ref: null,
            searchQuery: null,
            reason: { entry: "teleport", fits: "x" },
          }),
        ],
        look: { value: "warm", reason: { entry: "look", fits: "golden" } },
        music: {
          name: "walking-away",
          onBeat: true,
          reason: { entry: "music.bed", fits: "steady" },
        },
      }),
    });
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "image",
      motion: "zoom",
      focus: { x: 0.5, y: 0.3 },
      reason: {
        entry: "image.motion.zoom",
        fits: "arrive at her face",
        over: "i2v",
      },
    });
    expect(r.json.items[1].reason).toBeNull();
    expect(r.json.look).toEqual({
      value: "warm",
      reason: { entry: "look", fits: "golden", over: null },
    });
    expect(r.json.music).toMatchObject({ name: "walking-away", onBeat: true });
  });
});

describe("POST /studio/agent/plan — the acceptance-recap sentence: on an own-footage brief a made-here clip is never cast unpicked (S1c, PR 6)", () => {
  const RECAP = "recap my training, use live footage";
  async function madeClip(): Promise<string> {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${HER}/made-clip.mp4`,
        gcs_thumb_path: `athletes/${HER}/made-clip-poster.jpg`,
        content_type: "video/mp4",
        duration_seconds_precise: 6,
        ingested_at: new Date(),
        metadata: {
          vision: {
            athlete_present: true,
            shot_type: "action",
            description: "a generated sprint on a track",
            brands_visible: [],
            setting: "track",
            vibe: "fast",
            beats: [
              {
                start_s: 0,
                end_s: 3,
                description: "she sprints",
                camera: "static wide",
                motion: "sprint",
              },
              {
                start_s: 3,
                end_s: 6,
                description: "she slows",
                camera: "handheld close-up",
                motion: "still",
              },
            ],
            video: { source: "clip" },
          },
          embedding: [1, 0, 0],
        },
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  }
  const nameTheClip = () =>
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const ref = text.match(/^(a\d+) \| CLIP /m)![1];
      return {
        text: JSON.stringify({
          items: [
            planned({
              kind: "clip",
              ref,
              segment: 0,
              searchQuery: null,
              sound: true,
            }),
          ],
        }),
      };
    });

  /** ⚠️ MUTATION: drop S1c's `(!ownFootage || hers)` in cast.ts fitsKind — this case reds by name. */
  it("made-here clip castable on own footage: never — the only item is left out, and nothing is made", async () => {
    await madeClip();
    nameTheClip();
    const r = await post(ask({ prompt: RECAP, objective: "recap" }));
    expect(r.status).toBe(422);
  });

  it("the same clip on a brief that does not ask for her footage is cast as before", async () => {
    const made = await madeClip();
    nameTheClip();
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "clip",
      assetId: made,
      provenance: "made-here",
    });
  });
});

describe("POST /studio/agent/plan — the acceptance-recap sentence: on an own-footage brief an i2v is held, pushed in (PR 4 A1b)", () => {
  const ACCEPTANCE = "recap my training, use live footage";
  const nameAnI2v = () =>
    generateContent.mockImplementation(async (req: any) => {
      const text = req.contents[0].parts[0].text as string;
      const ref = text.match(
        /^(a\d+) \| .*her smile to camera on the pitch/m,
      )![1];
      return {
        text: JSON.stringify({
          items: [
            planned({
              kind: "i2v",
              ref,
              searchQuery: "her smile to camera",
              sound: false,
            }),
          ],
        }),
      };
    });

  /** ⚠️ MUTATION: the i2v stays an i2v on an own-footage brief — this case reds by name. */
  it("the planned i2v on her camera photo comes back held and pushed in, the same photo, and the card says why", async () => {
    const hers = await photo({
      origin: "upload",
      platform: "upload",
      description: "her smile to camera on the pitch",
    });
    nameAnI2v();
    const r = await post(ask({ prompt: ACCEPTANCE, objective: "recap" }));
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "image",
      motion: "dolly",
      assetId: hers,
      provenance: "camera",
      swapped: null,
      demoted: expect.stringMatching(/held, not animated/i),
    });
  });

  it("the ad-brief control does not ask for her footage: the same i2v is animated as before", async () => {
    const hers = await photo({
      origin: "upload",
      platform: "upload",
      description: "her smile to camera on the pitch",
    });
    nameAnI2v();
    const r = await post(ask({ prompt: "a soccer ad with me in it" }));
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({
      kind: "i2v",
      motion: null,
      assetId: hers,
      demoted: null,
    });
  });
});

describe("plan-row memory — a plan remembers what it was planned from, and re-plans from it (PR 13, 0066)", () => {
  const { campaign } = JSON.parse(
    readFileSync(
      join(__dirname, "..", "studio", "campaign", "fixtures", "bottle-campaign.json"),
      "utf8",
    ),
  ) as { campaign: Record<string, unknown> };
  const flags = [
    { path: "brand.name", basis: "literal", quote: "Solstice" },
    { path: "product.fidelity", basis: "inferred", because: "a product shot wants the real bottle" },
  ];
  const promptAt = (call: number) =>
    generateContent.mock.calls[call][0].contents[0].parts[0].text as string;
  const get = async (id: string) => {
    const res = await fetch(`${base}/studio/agent/plans/${id}`);
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const replan = async (id: string, body?: unknown) => {
    const res = await fetch(`${base}/studio/agent/plans/${id}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const rowOf = async (id: string) => {
    const [row] = await db.select().from(studioPlans).where(eq(studioPlans.id, id));
    return row;
  };
  /** Her words, her feel, the brief and the confirm flags — the plan the rest re-plans from. */
  const herAsk = () =>
    ask({
      prompt: "her own words: the bottle on the start line at dawn",
      aesthetic: "warm and unhurried",
      objective: "showcase-product",
      campaign,
      confirm: flags,
    });

  beforeEach(async () => {
    await db.delete(studioPlans);
    process.env.STUDIO_BRAND_PROFILES = "true";
  });
  afterEach(() => {
    delete process.env.STUDIO_BRAND_PROFILES;
  });

  it("stores her words, her feel, the purpose and the confirm flags on the row, once, and the GET returns them", async () => {
    await photo();
    planReply([planned()]);
    const made = await post(herAsk());
    expect(made.status).toBe(200);
    const row = await rowOf(made.json.planId);
    expect(row).toMatchObject({
      prompt: "her own words: the bottle on the start line at dawn",
      aesthetic: "warm and unhurried",
      objective: "showcase-product",
      confirm: flags,
    });
    const opened = await get(made.json.planId);
    expect(opened.json).toMatchObject({
      prompt: "her own words: the bottle on the start line at dawn",
      aesthetic: "warm and unhurried",
      objective: "showcase-product",
      confirm: flags,
    });
    // No feel given: null, not "".
    planReply([planned()]);
    const plain = await post(ask());
    expect(await rowOf(plain.json.planId)).toMatchObject({ aesthetic: null, confirm: null, objective: "grow-following" });
  });

  /** ⚠️ MUTATION: drop `confirm` from the savePlan call in routes/studio.ts — this reds by name. */
  it("confirm flags lost at save: never — and confirm is an unknown field with the flag off, a 400 when malformed, before any model call", async () => {
    await photo();
    planReply([planned()]);
    const made = await post(herAsk());
    expect((await rowOf(made.json.planId)).confirm).toEqual(flags);

    generateContent.mockClear();
    delete process.env.STUDIO_BRAND_PROFILES;
    const off = await post(ask({ confirm: flags }));
    expect(off.status).toBe(400);
    expect(off.json).toMatchObject({ field: "confirm" });
    process.env.STUDIO_BRAND_PROFILES = "true";
    // A literal line without its quote is not a flag the envelope accepts.
    const bad = await post(ask({ confirm: [{ path: "brand.name", basis: "literal" }] }));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ field: "confirm" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  /** ⚠️ MUTATION: make the replan route compose its prompt from the brief instead of the row — this reds by name (P-words). */
  it("a regenerate re-plans from the fallback line: never — a replan with no body plans from her stored words, and the planner is shown the same prompt byte-for-byte", async () => {
    await photo();
    planReply([planned()]);
    const first = await post(herAsk());
    expect(first.status).toBe(200);
    planReply([planned()]);
    const second = await replan(first.json.planId);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ version: 2, parentPlanId: first.json.planId });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(promptAt(1)).toBe(promptAt(0));
    expect(promptAt(1)).toContain("her own words: the bottle on the start line at dawn");
    // The child remembers the same things, verbatim — and the parent row is untouched.
    const parent = await rowOf(first.json.planId);
    const child = await rowOf(second.json.planId);
    expect(child).toMatchObject({
      prompt: parent.prompt,
      aesthetic: parent.aesthetic,
      objective: parent.objective,
      confirm: parent.confirm,
      brief: parent.brief,
      parent_plan_id: parent.id,
      version: 2,
    });
    expect(parent.version).toBe(1);
    expect(parent.parent_plan_id).toBeNull();
  });

  /** ⚠️ MUTATION: drop `campaign: row.brief` from the replan route's composition — this reds by name (P-replan). */
  it("replan ignores the stored brief: never — no campaign in the body plans from the stored one; a posted campaign takes the posted path unchanged", async () => {
    await photo();
    planReply([planned()]);
    const first = await post(herAsk());
    planReply([planned()]);
    const fromRow = await replan(first.json.planId, {});
    expect(fromRow.status).toBe(200);
    expect(promptAt(1)).toContain("<<<CAMPAIGN>>>");
    expect(promptAt(1)).toContain('"the matte-black Solstice insulated bottle"');
    expect((await rowOf(fromRow.json.planId)).brief).toMatchObject({ brand: { name: "Solstice" } });

    planReply([planned()]);
    const posted = await replan(first.json.planId, {
      campaign: {
        ...campaign,
        brand: { ...(campaign.brand as object), name: "Lumen" },
        product: { ...(campaign.product as object), line: "the brushed-steel Lumen flask" },
      },
    });
    expect(posted.status).toBe(200);
    expect(promptAt(2)).toContain("Lumen");
    expect(promptAt(2)).not.toContain("Solstice");
    expect((await rowOf(posted.json.planId)).brief).toMatchObject({ brand: { name: "Lumen" } });
    // Her words still come from the row: only the brief was posted over.
    expect((await rowOf(posted.json.planId)).prompt).toBe("her own words: the bottle on the start line at dawn");
  });

  /** PR 14: the parent's resolved assets are stripped from the re-posted brief, so the child re-resolves on its own save. */
  it("a replan re-posts the stored brief without the parent's resolved reference assets, and re-resolves them on the child", async () => {
    const INTENT = {
      composition: { summary: "Centered.", tags: ["centered"], basis: "observed" },
      camera: { summary: "A static medium shot.", tags: ["medium", "static"], basis: "observed" },
      lens_perspective: null,
      lighting: { summary: "Soft studio light.", tags: ["studio", "soft_light"], basis: "inferred" },
      color: { summary: "Muted.", tags: [], basis: "observed" },
      environment: null,
      subject_placement: null,
      wardrobe: null,
      motion: null,
      editing_rhythm: null,
      typography: null,
      emotional_tone: { summary: "Calm.", tags: [], basis: "observed" },
    };
    const asset = await photo();
    await db.insert(studioReferenceAnalyses).values({
      athlete_id: HER,
      source_kind: "image",
      source_asset_id: asset,
      role: "style_reference",
      decomposition: { schema: "reference-decomposition/1", reference_intent: INTENT, commercial_style: [] },
      prompt_version: "reference-decomposition/1",
      model: "test",
    } as never);
    planReply([planned()]);
    const first = await post({
      ...herAsk(),
      campaign: { ...campaign, references: [{ ref: "ref_1", role: "style_reference", intent: INTENT }] },
    });
    expect(first.status).toBe(200);
    expect(((await rowOf(first.json.planId)).brief as { references: { assetId?: string }[] }).references[0].assetId).toBe(asset);
    // The reading is gone (her photo deleted, CASCADE) — the child still plans, and stores no asset for it.
    await db.delete(studioReferenceAnalyses);
    planReply([planned()]);
    const child = await replan(first.json.planId, {});
    expect(child.status).toBe(200);
    const refs = ((await rowOf(child.json.planId)).brief as { references: Record<string, unknown>[] }).references;
    expect(refs[0]).toMatchObject({ ref: "ref_1", role: "style_reference" });
    expect("assetId" in refs[0]).toBe(false);
  });

  /** ⚠️ MUTATION: read the parent by id alone in the replan route — this reds by name. */
  it("replan plans another athlete's stored brief: never — hers is a 404 to anyone else, before any model call", async () => {
    await photo();
    planReply([planned()]);
    const hers = await post(herAsk());
    (globalThis as any).__TEST_ATHLETE_ID = SOMEONE_ELSE;
    generateContent.mockClear();
    const r = await replan(hers.json.planId);
    expect(r.status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
    expect(await db.select().from(studioPlans)).toHaveLength(1);
    // Not a uuid, not a plan, or the surface off: a 404 too.
    (globalThis as any).__TEST_ATHLETE_ID = HER;
    expect((await replan("not-a-uuid")).status).toBe(404);
    expect((await replan(randomUUID())).status).toBe(404);
    delete process.env.STUDIO_AGENT;
    expect((await replan(hers.json.planId)).status).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
  });

  /** ⚠️ MUTATION: give the replan route a fallback line or objective for a null column — this reds by name (P-old). */
  it("an old row with null objective re-plans with no objective: never — a pre-0066 row is a 400 naming the field, nothing called; posted, it plans as its child", async () => {
    await photo();
    const [old] = await db
      .insert(studioPlans)
      .values({
        athlete_id: HER,
        version: 1,
        brief: campaign,
        plan: { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null },
      } as never)
      .returning({ id: studioPlans.id });
    planReply([planned()]);
    const noWords = await replan(old.id);
    expect(noWords.status).toBe(400);
    expect(noWords.json).toMatchObject({ field: "prompt" });
    const noPurpose = await replan(old.id, { prompt: "said again" });
    expect(noPurpose.status).toBe(400);
    expect(noPurpose.json).toMatchObject({ field: "objective" });
    expect(generateContent).not.toHaveBeenCalled();
    expect(await db.select().from(studioPlans)).toHaveLength(1);

    const said = await replan(old.id, { prompt: "said again", objective: "showcase-product" });
    expect(said.status).toBe(200);
    expect(said.json).toMatchObject({ version: 2, parentPlanId: old.id });
    expect(promptAt(0)).toContain("said again");
    expect(promptAt(0)).toContain("<<<CAMPAIGN>>>");
    expect(await rowOf(said.json.planId)).toMatchObject({ prompt: "said again", objective: "showcase-product", aesthetic: null });
  });

  it("the replan body is the plan body minus the parent and the stage: parentPlanId and stage are unknown fields", async () => {
    await photo();
    planReply([planned()]);
    const first = await post(herAsk());
    generateContent.mockClear();
    for (const [body, field] of [
      [{ parentPlanId: first.json.planId }, "parentPlanId"],
      [{ stage: "concepts" }, "stage"],
      [{ costUsd: 0 }, "costUsd"],
    ] as const) {
      const r = await replan(first.json.planId, body);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ field });
    }
    expect((await replan(first.json.planId, [])).status).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });

  /**
   * The POST handler became a function the replan route calls (PR 13, ruling 3). This pins the POST
   * path: the same body, twice, is the same planner prompt and the same saved row in every column but
   * the ones a row owns (id, created_at). The replan path is held to the POST path's prompt above.
   */
  it("the POST path is byte-identical: the same body is the same planner prompt and the same saved row", async () => {
    await photo();
    planReply([planned()]);
    const a = await post(herAsk());
    planReply([planned()]);
    const b = await post(herAsk());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(promptAt(1)).toBe(promptAt(0));
    const strip = ({ id: _id, created_at: _at, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await rowOf(b.json.planId))).toEqual(strip(await rowOf(a.json.planId)));
    const { planId: _a, ...answerA } = a.json;
    const { planId: _b, ...answerB } = b.json;
    expect(answerB).toEqual(answerA);
  });
});
