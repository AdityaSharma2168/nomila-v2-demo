/**
 * studio.imageGenerate.test.ts — image.generate through BOTH doors, pinned at the spend boundary (image-parity, T1–T6).
 *
 * The flow census drives an image generate end to end but asserts only whether a field reached a point. Nothing
 * held what a generate SENDS: the prompt bytes, which photographs ride in which slot, whose photographs they may
 * be, and what the spend records. This suite does, through the real routes, the real router (so its cost line is
 * written) and the client's own request builders — `previewRequestFor` and the pack chooser `previewBody` — so the
 * body posted is the one the app posts.
 *
 *   T1  the prompt the adapter is handed IS the quoted prompt IS `plannedInputs` of the stored brief, and is the
 *       route golden captured on the pre-move tip (studio.imageGenerate.golden.json);
 *   T2  pack top-up: her pick first, then the largest clear face, then exactly one body-bearing shot, then her
 *       product — slots character, character, character, object;
 *   T3  tenancy: another athlete's photo (in her request or in her pack) is a 404 before anything is written or
 *       spent; another athlete cannot spend her preview; every image handed to the model is under her path;
 *   T4  the likeness gate: a made-here still whose job carried no photo of her, chosen by her, runs (ADI-R19-BOARD3 —
 *       "Made here · not from you" is a label, never a refusal at this door);
 *   T5  the spend: one job, the quote as its estimate, the adapter's cost as its cost, one cost line joined to
 *       the job and the preview, and a second tap that spends nothing;
 *   T6  today's flag-off bytes on this path: with STUDIO_IDENTITY_PACK and STUDIO_STYLE_SPEC off, her picks only
 *       and no fence marker, equal to the golden.
 *
 * Stood in, at the edge only: the model's two adapters (recorders that answer with a real PNG), storage, URL
 * signing and the fetch of a signed URL. `estimate` and the router are REAL.
 *
 * ─── CHANGING THE GOLDEN ─────────────────────────────────────────────────────────────────────────────────────
 * IMAGE_ROUTE_CAPTURE=1 writes studio.imageGenerate.golden.json and FAILS, so a capture run is never read as
 * green. The committed golden was captured on the pre-move tip b7e71617 (docs/probes/image-parity.md).
 *
 * ⚠️ MUTATIONS (docs/probes/image-parity.md): M-T1, M-x1 and M-x2 (client/server, T2), M-T3a/b, M-T4, M-T5a/b.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (
    req: { athleteId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.athleteId = (
      globalThis as { __TEST_ATHLETE_ID?: string }
    ).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/models", () => ({
  genai: jest.fn(() => ({})),
  GEMINI: {
    pro: "test-pro",
    flash: "test-flash",
    flashLite: "test-flash-lite",
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
}));
jest.mock("../studio/videoRunner", () => ({
  videoTick: jest.fn(async () => ({})),
}));
// THE BILLABLE DOOR'S FAR SIDE: the router is real; the adapters record exactly what they were handed.
const mockAdapterCalls: {
  task: string;
  prompt: string;
  slots: (string | null)[];
  refIds: string[];
  attribution: Record<string, unknown> | null;
}[] = [];
const mockAdapter = (name: string) => {
  const actual = jest.requireActual(`../studio/adapters/${name}`);
  const key = `${name}Adapter`;
  return {
    ...actual,
    [key]: {
      ...actual[key],
      generate: jest.fn(
        async (
          task: string,
          inputs: { prompt: string; references?: { slot?: string }[] },
          model: string,
          opts: { refIds?: string[]; attribution?: Record<string, unknown> },
        ) => {
          mockAdapterCalls.push({
            task,
            prompt: inputs.prompt,
            slots: (inputs.references ?? []).map((r) => r.slot ?? null),
            refIds: opts?.refIds ?? [],
            attribution: opts?.attribution ?? null,
          });
          const now = new Date().toISOString();
          return {
            task,
            provider: name,
            model,
            assets: [{ bytes: mockPng(), mimeType: "image/png" }],
            cost: { amountUsd: 0.1234, currency: "USD", basis: "estimated" },
            timings: { startedAt: now, completedAt: now, ms: 1 },
          };
        },
      ),
    },
  };
};
jest.mock("../studio/adapters/vertex", () => mockAdapter("vertex"));
jest.mock("../studio/adapters/openrouter", () => mockAdapter("openrouter"));
/** A real 64×80 PNG, made once: every stood-in image is it. */
let png: Buffer | null = null;
function mockPng(): Buffer {
  if (!png) {
    const { execFileSync } = jest.requireActual(
      "node:child_process",
    ) as typeof import("node:child_process");
    png = execFileSync(process.execPath, [
      "-e",
      "require('sharp')({create:{width:64,height:80,channels:3,background:{r:40,g:90,b:120}}}).png().toBuffer().then(b=>process.stdout.write(b))",
    ]);
  }
  return png;
}

import express from "express";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNotNull } from "drizzle-orm";
import studioRouter from "./studio";
import {
  athletes,
  athletesCurrent,
  generationJobs,
  identityProfiles,
  mediaAssets,
  studioGenerationPreviews,
} from "../../shared/schema";
import {
  db,
  client,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { plannedInputs } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import { PACK_MIN } from "../studio/identity/types";
import { EXTERNAL_OPEN } from "../studio/compile/fence";
import { STYLE_OPEN } from "../studio/compile/style";
import {
  previewRequestFor,
  type Attachment,
} from "../../client/lib/studio-contract";
import {
  previewBody,
  type IdentityProfileWire,
} from "../../client/lib/identityPack";
import type {
  PreviewRequest,
  StudioClassification,
} from "../../client/hooks/use-studio";

const GOLDEN_PATH = join(__dirname, "studio.imageGenerate.golden.json");
const CAPTURE = process.env.IMAGE_ROUTE_CAPTURE === "1";
const GOLDEN: Record<string, { prompt: string[]; slots: (string | null)[] }> =
  !CAPTURE && existsSync(GOLDEN_PATH)
    ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8"))
    : {};
const captured: typeof GOLDEN = {};

/** Her sentence names herself, so the pack may top it up (client/lib/identityPack.ts `hasPersonIntent`). */
const SENTENCE = "me sprinting out of the blocks at golden hour";

let server: Server;
let base: string;
let her: string;
let other: string;
const COST_DIR = mkdtempSync(join(tmpdir(), "image-generate-cost-"));
let costLog = "";
const realFetch = globalThis.fetch;

const asUser = (id: string) => {
  (globalThis as { __TEST_ATHLETE_ID?: string }).__TEST_ATHLETE_ID = id;
};

/** The fields of a route's JSON body this suite reads. */
interface Json {
  previewId?: string;
  plan?: { inputs?: { prompt?: string } };
  cost?: { amountUsd?: number };
  field?: string;
  reason?: string;
  status?: string;
  jobId?: string;
  profile?: IdentityProfileWire | null;
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: ((await res.json().catch(() => null)) ?? {}) as Json,
  };
}
const post = (path: string, body: unknown) => call("POST", path, body);
/** A field the route must have answered with — a missing one fails here, by name, rather than as a type hole. */
function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined)
    throw new Error(`the route answered without ${what}`);
  return v;
}

async function seedScoredAthlete(name: string): Promise<string> {
  const id = await seedAthlete(name);
  await db
    .update(athletes)
    .set({
      sport: "Soccer",
      school: "Test University",
      division: "D1",
    } as Partial<typeof athletes.$inferInsert>)
    .where(eq(athletes.id, id));
  await db.insert(athletesCurrent).values({
    athlete_id: id,
    story_arc: "A synthetic arc for tests.",
  } as typeof athletesCurrent.$inferInsert);
  return id;
}

/** A photo of her, tagged as the library tags one: her face clear, her the subject. */
const herVision = (shotType: string) => ({
  subject: "the_athlete",
  athlete_present: true,
  face_visibility: "clear",
  role: "identity",
  shot_type: shotType,
});

let seq = 0;
/** One stored row of `athleteId`'s library. Its path is under her id, as every real row's is. */
async function seedPhoto(
  athleteId: string,
  o: { vision?: unknown; origin?: string; generationJobId?: string } = {},
): Promise<{ id: string; path: string }> {
  const path = `athletes/${athleteId}/uploads/photo-${++seq}.jpg`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: o.origin ?? "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: path,
      content_type: "image/jpeg",
      ...(o.generationJobId ? { generation_job_id: o.generationJobId } : {}),
      metadata: { vision: o.vision ?? herVision("lifestyle") },
    } as typeof mediaAssets.$inferInsert)
    .returning({ id: mediaAssets.id });
  return { id: row.id, path };
}

/** Her pack: PACK_MIN photos, of which exactly ONE is body-bearing (action), so the body slot is unambiguous. */
async function seedPack(athleteId: string, extra: { assetId: string }[] = []) {
  const face = await seedPhoto(athleteId, { vision: herVision("portrait") });
  const body = await seedPhoto(athleteId, { vision: herVision("action") });
  const rest: { id: string; path: string }[] = [];
  for (let i = 0; i < PACK_MIN - 2 - extra.length; i++)
    rest.push(await seedPhoto(athleteId, { vision: herVision("portrait") }));
  const entry = (assetId: string, faceSizeFrac: number, shotType: string) => ({
    assetId,
    faceSizeFrac,
    prominence: 0.8,
    faceVisibility: "clear",
    shotType,
  });
  await db.insert(identityProfiles).values({
    athlete_id: athleteId,
    pack: [
      entry(face.id, 0.4, "portrait"),
      entry(body.id, 0.1, "action"),
      ...rest.map((r, i) => entry(r.id, 0.3 - i * 0.01, "portrait")),
      ...extra.map((e) => entry(e.assetId, 0.5, "portrait")),
    ],
  } as typeof identityProfiles.$inferInsert);
  return { face, body };
}

/** The request the app builds for a Create Anything still: the classifier's answer, the tray, the pack. */
async function requestFor(
  attachments: Attachment[],
  packOn: boolean,
): Promise<PreviewRequest> {
  const cls = await post("/studio/classify", {
    direction: SENTENCE,
    hasSourcePhoto: false,
  });
  expect(cls.status).toBe(200);
  const { request } = previewRequestFor({
    format: "photo",
    classification: cls.json as StudioClassification,
    direction: SENTENCE,
    attachments,
    frameAssetId: null,
    interpreter: false,
  });
  const prof = await call("GET", "/studio/identity/profile");
  const profile = prof.status === 200 ? (prof.json.profile ?? null) : null;
  return previewBody(request, profile, packOn);
}

const you = (id: string): Attachment => ({
  id,
  role: "source-frame",
  name: "me",
  uri: null,
  assetId: id,
});
const product = (id: string): Attachment => ({
  id,
  role: "product",
  name: "the spikes",
  uri: null,
  assetId: id,
});

async function storedBrief(previewId: string): Promise<CreativeBrief> {
  const [row] = await db
    .select({ brief: studioGenerationPreviews.brief })
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  return row.brief as CreativeBrief;
}
const previewCount = async () =>
  (await db.select().from(studioGenerationPreviews)).length;

/** Pin a captured prompt to the golden (or record it, in a capture run). */
function pinned(name: string, prompt: string, slots: (string | null)[]) {
  const got = { prompt: prompt.split("\n"), slots };
  if (CAPTURE) {
    captured[name] = got;
    return;
  }
  expect(got).toEqual(GOLDEN[name]);
}

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://signed.example/"))
      return new Response(new Uint8Array(mockPng()), { status: 200 });
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    throw new Error(
      `studio.imageGenerate.test: no outbound fetch is allowed (${url})`,
    );
  }) as typeof fetch;
  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  her = await seedScoredAthlete("Her Test Athlete");
  other = await seedScoredAthlete("Other Test Athlete");
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  if (CAPTURE) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(captured, null, 2)}\n`);
    throw new Error(
      `captured ${Object.keys(captured).length} route goldens — a capture run always fails`,
    );
  }
});

beforeEach(async () => {
  costLog = join(COST_DIR, `cost-${++seq}.jsonl`);
  process.env.STUDIO_COST_LOG = costLog;
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_LIBRARY_FIELDS = "true";
  for (const f of [
    "STUDIO_IDENTITY_PACK",
    "STUDIO_STYLE_SPEC",
    "STUDIO_SERVER_ROUTING",
    "STUDIO_CREATIVE_QA",
    "STUDIO_INTERPRETER",
    "STUDIO_NATIVE_EDIT",
    "STUDIO_IMAGE_PROVIDER",
    "STUDIO_MAX_REFERENCES",
  ])
    delete process.env[f];
  mockAdapterCalls.length = 0;
  asUser(her);
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets).where(isNotNull(mediaAssets.generation_job_id));
  await db.delete(generationJobs);
  await db.delete(identityProfiles);
  await db.delete(mediaAssets);
});

describe("image.generate at the spend boundary (image-parity)", () => {
  it("T1: the prompt the model is handed is the quoted prompt, the stored brief's own, and the pre-move golden", async () => {
    const body = await requestFor([], false);
    const quoted = await post("/studio/preview", body);
    expect(quoted.status).toBe(200);
    const ran = await post("/studio/generate", {
      previewId: need(quoted.json.previewId, "previewId"),
    });
    expect(ran.status).toBe(200);

    expect(mockAdapterCalls).toHaveLength(1);
    const [sent] = mockAdapterCalls;
    expect(sent.task).toBe("image.generate");
    expect(sent.prompt).toBe(
      need(quoted.json.plan?.inputs?.prompt, "plan.inputs.prompt"),
    );
    expect(sent.prompt).toBe(
      plannedInputs(await storedBrief(need(quoted.json.previewId, "previewId")))
        .inputs.prompt,
    );
    pinned(
      "T1 — a still from her words, nothing attached",
      sent.prompt,
      sent.slots,
    );
  });

  it("T2: pack top-up — her pick first, the largest clear face, exactly one body shot, then her product", async () => {
    process.env.STUDIO_IDENTITY_PACK = "true";
    const { face, body } = await seedPack(her);
    const mine = await seedPhoto(her, { vision: herVision("lifestyle") });
    const spikes = await seedPhoto(her, {
      vision: { subject: "object", athlete_present: false },
    });

    const req = await requestFor([you(mine.id), product(spikes.id)], true);
    expect(req.references).toEqual([
      { assetId: mine.id, role: "person" },
      { assetId: spikes.id, role: "product" },
      { assetId: face.id, role: "person" },
      { assetId: body.id, role: "person" },
    ]);
    const quoted = await post("/studio/preview", req);
    expect(quoted.status).toBe(200);
    await post("/studio/generate", {
      previewId: need(quoted.json.previewId, "previewId"),
    });

    const [sent] = mockAdapterCalls;
    expect(sent.slots).toEqual([
      "character",
      "character",
      "character",
      "object",
    ]);
    expect(sent.refIds).toEqual([mine.path, face.path, body.path, spikes.path]);
    pinned(
      "T2 — her pick, the pack's face and body, her product",
      sent.prompt,
      sent.slots,
    );
  });

  describe("T3: tenancy", () => {
    it("another athlete's photo in her request is a 404 — no preview row, nothing spent", async () => {
      const theirs = await seedPhoto(other);
      const before = await previewCount();
      const quoted = await post(
        "/studio/preview",
        await requestFor([you(theirs.id)], false),
      );
      expect([quoted.status, quoted.json?.field]).toEqual([404, "references"]);
      expect(await previewCount()).toBe(before);
      expect(mockAdapterCalls).toHaveLength(0);
    });

    it("another athlete's photo in HER pack is a 404 too — the pack is resolved under her id like any reference", async () => {
      process.env.STUDIO_IDENTITY_PACK = "true";
      const theirs = await seedPhoto(other);
      await seedPack(her, [{ assetId: theirs.id }]);
      const req = await requestFor([], true);
      expect((req.references ?? []).map((r) => r.assetId)).toContain(theirs.id);
      const before = await previewCount();
      const quoted = await post("/studio/preview", req);
      expect([quoted.status, quoted.json?.field]).toEqual([404, "references"]);
      expect(await previewCount()).toBe(before);
      expect(mockAdapterCalls).toHaveLength(0);
    });

    it("another athlete cannot spend her preview, and her approval survives the attempt", async () => {
      const mine = await seedPhoto(her);
      const quoted = await post(
        "/studio/preview",
        await requestFor([you(mine.id)], false),
      );
      expect(quoted.status).toBe(200);
      asUser(other);
      const ran = await post("/studio/generate", {
        previewId: need(quoted.json.previewId, "previewId"),
      });
      expect(ran.status).toBe(404);
      expect(mockAdapterCalls).toHaveLength(0);
      const [row] = await db
        .select({ consumed_at: studioGenerationPreviews.consumed_at })
        .from(studioGenerationPreviews)
        .where(
          eq(
            studioGenerationPreviews.id,
            need(quoted.json.previewId, "previewId"),
          ),
        );
      expect(row.consumed_at).toBeNull();
    });

    it("every image handed to the model is a path under her id", async () => {
      process.env.STUDIO_IDENTITY_PACK = "true";
      await seedPack(her);
      const mine = await seedPhoto(her);
      const quoted = await post(
        "/studio/preview",
        await requestFor([you(mine.id)], true),
      );
      await post("/studio/generate", {
        previewId: need(quoted.json.previewId, "previewId"),
      });
      const [sent] = mockAdapterCalls;
      expect(sent.refIds.length).toBeGreaterThan(0);
      expect(
        sent.refIds.filter((p) => !p.startsWith(`athletes/${her}/`)),
      ).toEqual([]);
    });
  });

  describe("T4: the likeness gate", () => {
    /** A made-here still whose generating job carried no photo of her — "Made here · not from you". */
    async function madeHereNotHer() {
      const [job] = await db
        .insert(generationJobs)
        .values({
          athlete_id: her,
          origin: "system",
          mode: "generate",
          objective: "grow-following",
          deliverable: "post",
          brief: { job: { references: [{ role: "product" }] } },
          status: "succeeded",
        } as typeof generationJobs.$inferInsert)
        .returning({ id: generationJobs.id });
      return seedPhoto(her, { origin: "generated", generationJobId: job.id });
    }

    /**
     * PR 19 (ADI-R19-BOARD3, superseding the 24 Sep door refusal): the same image in Create Anything, with her words,
     * runs. ⚠️ MUTATION M-madeHere: pass madeHereRefuses true at the door (routes/studio.ts) — this reds by name.
     */
    it("a made-here still she chose runs in Create Anything with her words — quoted, then made", async () => {
      const made = await madeHereNotHer();
      const quoted = await post(
        "/studio/preview",
        await requestFor([you(made.id)], false),
      );
      expect([quoted.status, quoted.json?.reason]).toEqual([200, undefined]);
      const ran = await post("/studio/generate", {
        previewId: need(quoted.json.previewId, "previewId"),
      });
      expect(ran.status).toBe(200);
      expect(mockAdapterCalls).toHaveLength(1);
    });

    it("with STUDIO_LIBRARY_FIELDS off the same still passes the door, as it does on (C-5, closed by ADI-R19-BOARD3)", async () => {
      delete process.env.STUDIO_LIBRARY_FIELDS;
      const made = await madeHereNotHer();
      const quoted = await post(
        "/studio/preview",
        await requestFor([you(made.id)], false),
      );
      expect(quoted.status).toBe(200);
    });
  });

  it("T5: one job, the quote as its estimate, the adapter's cost as its cost, one joined cost line — and a second tap spends nothing", async () => {
    const mine = await seedPhoto(her);
    const quoted = await post(
      "/studio/preview",
      await requestFor([you(mine.id)], false),
    );
    expect(quoted.status).toBe(200);
    const first = await post("/studio/generate", {
      previewId: need(quoted.json.previewId, "previewId"),
    });
    expect(first.status).toBe(200);

    const jobs = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.athlete_id, her));
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.status).toBe("succeeded");
    expect(Number(job.cost_estimated_usd)).toBe(
      need(quoted.json.cost?.amountUsd, "cost.amountUsd"),
    );
    expect(Number(job.cost_usd)).toBe(0.1234);

    const lines = readFileSync(costLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "generation",
      task: "image.generate",
      jobId: job.id,
      previewId: need(quoted.json.previewId, "previewId"),
      cost: 0.1234,
    });
    expect(mockAdapterCalls[0].attribution).toMatchObject({
      jobId: job.id,
      previewId: need(quoted.json.previewId, "previewId"),
    });

    const second = await post("/studio/generate", {
      previewId: need(quoted.json.previewId, "previewId"),
    });
    expect([second.status, second.json.status, second.json.jobId]).toEqual([
      200,
      "already_running",
      first.json.jobId,
    ]);
    expect(mockAdapterCalls).toHaveLength(1);
    expect(readFileSync(costLog, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("T6: today's flag-off bytes — pack and style spec off, a pack on file: her picks only, no fence, the golden", async () => {
    await seedPack(her);
    const mine = await seedPhoto(her);
    const req = await requestFor([you(mine.id)], false);
    expect(req.references).toEqual([{ assetId: mine.id, role: "person" }]);
    const quoted = await post("/studio/preview", req);
    await post("/studio/generate", {
      previewId: need(quoted.json.previewId, "previewId"),
    });
    const [sent] = mockAdapterCalls;
    expect(sent.refIds).toEqual([mine.path]);
    expect(sent.prompt).not.toContain(EXTERNAL_OPEN);
    expect(sent.prompt).not.toContain(STYLE_OPEN);
    pinned(
      "T6 — flag-off: her one pick, no pack, no fence",
      sent.prompt,
      sent.slots,
    );
  });
});
