/**
 * routes.test.ts — the typed edit door's shape (PR 9, Lane 1): off is a 404, the body is validated, the
 * engine's refusals and errors reach the client with their status, and nothing here touches a database
 * (the engine is stood in).
 */
const mockEngine = {
  quoteEdit: jest.fn(),
  runEdit: jest.fn(),
  acceptEdit: jest.fn(),
  discardEdit: jest.fn(),
  presentEdit: jest.fn(async (row: { id: string; status: string }) => ({
    id: row.id,
    status: row.status,
  })),
};
jest.mock("./engine", () => mockEngine);
const mockPreviews = {
  readEditPreview: jest.fn(),
  listEditPreviews: jest.fn(),
};
jest.mock("./previews", () => mockPreviews);
const mockRecommend = { recommendMemoized: jest.fn() };
jest.mock("./recommend", () => mockRecommend);
const mockBatch = {
  quoteBatch: jest.fn(),
  runBatch: jest.fn(),
  rerollBatch: jest.fn(),
  acceptAllBatch: jest.fn(),
  batchView: jest.fn(),
  MAX_REFS: 3,
  MAX_INITIAL_CANDIDATES: 3,
};
jest.mock("./batch", () => mockBatch);
const mockSource = {
  verifiedSource: jest.fn(),
  SOURCE_REFUSAL_COPY: {
    source_not_found: "not found copy",
    source_not_her: "not her copy",
    source_unverified: "still checking copy",
  },
};
jest.mock("./source", () => mockSource);
jest.mock("../autoMask", () => ({
  probeBytesFor: jest.fn(async () => ({
    bytes: Buffer.from("x"),
    mimeType: "image/png",
  })),
}));

import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GenerationError } from "../types";
import { registerEditRoutes } from "./routes";

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const gate: RequestHandler = (req, _res, next) => {
    req.athleteId = ATHLETE;
    next();
  };
  registerEditRoutes(router, [gate]);
  app.use("/api/v1/me", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.STUDIO_IMAGE_EDIT_OPS = "true";
  for (const fn of Object.values(mockEngine))
    if (fn !== mockEngine.presentEdit) fn.mockReset();
  mockPreviews.readEditPreview.mockReset();
  mockPreviews.listEditPreviews.mockReset();
  mockRecommend.recommendMemoized.mockReset();
  mockSource.verifiedSource.mockReset();
  for (const fn of [
    mockBatch.quoteBatch,
    mockBatch.runBatch,
    mockBatch.rerollBatch,
    mockBatch.acceptAllBatch,
    mockBatch.batchView,
  ])
    fn.mockReset();
});
afterEach(() => {
  delete process.env.STUDIO_IMAGE_EDIT_OPS;
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("off, the door is not there", () => {
  it("every route answers 404 with STUDIO_IMAGE_EDIT_OPS unset, and the engine is never called", async () => {
    delete process.env.STUDIO_IMAGE_EDIT_OPS;
    expect(
      (
        await call("POST", "/studio/edits/quote", {
          sourceAssetId: ID,
          op: "recolour",
        })
      ).status,
    ).toBe(404);
    expect((await call("POST", `/studio/edits/${ID}/run`)).status).toBe(404);
    expect((await call("POST", `/studio/edits/${ID}/accept`)).status).toBe(404);
    expect((await call("POST", `/studio/edits/${ID}/discard`)).status).toBe(
      404,
    );
    expect((await call("GET", `/studio/edits/${ID}`)).status).toBe(404);
    expect((await call("GET", "/studio/edits")).status).toBe(404);
    expect(mockEngine.quoteEdit).not.toHaveBeenCalled();
    expect(mockEngine.runEdit).not.toHaveBeenCalled();
  });
});

describe("quote", () => {
  it("validates the body before the engine sees it", async () => {
    expect(
      await call("POST", "/studio/edits/quote", { op: "recolour" }),
    ).toMatchObject({ status: 400, body: { field: "sourceAssetId" } });
    expect(
      await call("POST", "/studio/edits/quote", {
        sourceAssetId: "nope",
        op: "recolour",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call("POST", "/studio/edits/quote", {
        sourceAssetId: ID,
        op: "recolour",
        extra: 1,
      }),
    ).toMatchObject({ status: 400 });
    expect(mockEngine.quoteEdit).not.toHaveBeenCalled();
  });

  it("hands a valid body to the engine under the gate's athlete, and answers the quote", async () => {
    mockEngine.quoteEdit.mockResolvedValue({
      ok: true,
      row: { id: ID, status: "quoted" },
      quote: {
        costUsd: 0.165,
        unpriced: false,
        sentence: "make the jersey red",
        warnings: [],
        expiresAt: "2026-09-24T00:00:00.000Z",
      },
    });
    const out = await call("POST", "/studio/edits/quote", {
      sourceAssetId: ID,
      op: "recolour",
      params: { target: "jersey", colour: "red" },
    });
    expect(out).toMatchObject({
      status: 200,
      body: {
        edit: { id: ID, status: "quoted" },
        quote: { costUsd: 0.165, sentence: "make the jersey red" },
      },
    });
    expect(mockEngine.quoteEdit).toHaveBeenCalledWith({
      athleteId: ATHLETE,
      sourceAssetId: ID,
      op: "recolour",
      params: { target: "jersey", colour: "red" },
      brandId: null,
      batchId: null,
    });
  });

  it("a refusal keeps its status and field; a GenerationError is a 409; anything else a 500 that says nothing", async () => {
    mockEngine.quoteEdit.mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: "isn't you",
      field: "sourceAssetId",
    });
    expect(
      await call("POST", "/studio/edits/quote", {
        sourceAssetId: ID,
        op: "recolour",
      }),
    ).toMatchObject({
      status: 422,
      body: { error: "isn't you", field: "sourceAssetId" },
    });
    mockEngine.quoteEdit.mockRejectedValueOnce(
      new GenerationError("over the cap", "invalid_input"),
    );
    expect(
      await call("POST", "/studio/edits/quote", {
        sourceAssetId: ID,
        op: "recolour",
      }),
    ).toMatchObject({ status: 409, body: { error: "over the cap" } });
    mockEngine.quoteEdit.mockRejectedValueOnce(new Error("secret internals"));
    const out = await call("POST", "/studio/edits/quote", {
      sourceAssetId: ID,
      op: "recolour",
    });
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("secret internals");
  });
});

describe("run, accept, discard, read, list", () => {
  it("each takes a uuid id, under the gate's athlete", async () => {
    expect((await call("POST", "/studio/edits/not-a-uuid/run")).status).toBe(
      400,
    );
    mockEngine.runEdit.mockResolvedValue({
      ok: true,
      row: { id: ID, status: "ready" },
      url: "https://signed.example/x",
    });
    expect(await call("POST", `/studio/edits/${ID}/run`)).toMatchObject({
      status: 200,
      body: { edit: { status: "ready" } },
    });
    expect(mockEngine.runEdit).toHaveBeenCalledWith({
      athleteId: ATHLETE,
      id: ID,
    });

    mockEngine.acceptEdit.mockResolvedValue({
      ok: true,
      row: { id: ID, status: "accepted" },
      assetId: "33333333-3333-4333-8333-333333333333",
    });
    expect(await call("POST", `/studio/edits/${ID}/accept`)).toMatchObject({
      status: 200,
      body: { assetId: "33333333-3333-4333-8333-333333333333" },
    });

    mockEngine.discardEdit.mockResolvedValue({
      ok: false,
      status: 409,
      error: "already decided",
    });
    expect(await call("POST", `/studio/edits/${ID}/discard`)).toMatchObject({
      status: 409,
      body: { error: "already decided" },
    });

    mockPreviews.readEditPreview.mockResolvedValue(null);
    expect((await call("GET", `/studio/edits/${ID}`)).status).toBe(404);
    expect(mockPreviews.readEditPreview).toHaveBeenCalledWith(ATHLETE, ID);

    mockPreviews.listEditPreviews.mockResolvedValue([
      { id: ID, status: "ready" },
    ]);
    expect(await call("GET", `/studio/edits?batchId=${ID}`)).toMatchObject({
      status: 200,
      body: { edits: [{ id: ID }] },
    });
    expect(mockPreviews.listEditPreviews).toHaveBeenCalledWith(ATHLETE, {
      batchId: ID,
    });
    expect((await call("GET", "/studio/edits?batchId=nope")).status).toBe(400);
  });
});

describe("recommend — reads the photo, never runs an op, and says why the manual path would refuse", () => {
  it("validates the body: a uuid, up to 12 lines of up to 300 characters", async () => {
    expect(
      (
        await call("POST", "/studio/edits/recommend", {
          assetId: "nope",
          briefLines: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/studio/edits/recommend", {
          assetId: ID,
          briefLines: Array(13).fill("x"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/studio/edits/recommend", {
          assetId: ID,
          briefLines: ["x"],
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(mockRecommend.recommendMemoized).not.toHaveBeenCalled();
  });

  it("a verified source goes to the memoized pass under her id, with the lines and the brand", async () => {
    mockSource.verifiedSource.mockResolvedValue({
      ok: true,
      source: {
        id: ID,
        gcsPath: "p",
        origin: "upload",
        subject: "the_athlete",
      },
    });
    mockRecommend.recommendMemoized.mockResolvedValue({
      recs: [
        {
          op: "recolour",
          params: { target: "logos", colour: "black" },
          because: "No Nike marks on kit or ball.",
          what: "w",
        },
      ],
      dropped: [],
      usage: null,
      skipped: null,
    });
    const out = await call("POST", "/studio/edits/recommend", {
      assetId: ID,
      briefLines: ["No Nike marks on kit or ball."],
      brand: "Jane Street",
    });
    expect(out).toMatchObject({
      status: 200,
      body: {
        recs: [{ op: "recolour", because: "No Nike marks on kit or ball." }],
        skipped: null,
        refusal: null,
      },
    });
    expect(mockRecommend.recommendMemoized).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteId: ATHLETE,
        assetId: ID,
        briefLines: ["No Nike marks on kit or ball."],
        brand: "Jane Street",
      }),
      expect.any(Function),
    );
    expect(mockSource.verifiedSource).toHaveBeenCalledWith(ATHLETE, ID);
    // Nothing in this route reaches the engine.
    expect(mockEngine.quoteEdit).not.toHaveBeenCalled();
    expect(mockEngine.runEdit).not.toHaveBeenCalled();
  });

  it("a source the gate refuses answers no recs and the refusal's copy — never swallowed; a missing one is a 404", async () => {
    mockSource.verifiedSource.mockResolvedValueOnce({
      ok: false,
      reason: "source_unverified",
    });
    expect(
      await call("POST", "/studio/edits/recommend", {
        assetId: ID,
        briefLines: ["x"],
      }),
    ).toMatchObject({
      status: 200,
      body: { recs: [], skipped: "source", refusal: "still checking copy" },
    });
    expect(mockRecommend.recommendMemoized).not.toHaveBeenCalled();
    mockSource.verifiedSource.mockResolvedValueOnce({
      ok: false,
      reason: "source_not_found",
    });
    expect(
      (
        await call("POST", "/studio/edits/recommend", {
          assetId: ID,
          briefLines: ["x"],
        })
      ).status,
    ).toBe(404);
  });
});

describe("the carousel batch routes (Lane 4)", () => {
  it("the quote body is validated at the door: a 4th reference, a bad variation count and a stray key are 400s before the engine", async () => {
    const ref = (assetId: string) => ({
      assetId,
      variations: 1,
      cleanup: null,
    });
    const four = [
      ID,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ].map(ref);
    expect(
      (
        await call("POST", "/studio/edits/batch/quote", {
          refs: four,
          brand: "Jane Street",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/studio/edits/batch/quote", {
          refs: [{ assetId: ID, variations: 4, cleanup: null }],
          brand: "Jane Street",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/studio/edits/batch/quote", {
          refs: [ref(ID)],
          brand: "Jane Street",
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(mockBatch.quoteBatch).not.toHaveBeenCalled();
  });

  it("a valid quote goes to the engine under her id, with the brief lines; run, reroll, accept-all and the view take uuids", async () => {
    mockBatch.quoteBatch.mockResolvedValue({
      ok: true,
      batchId: ID,
      lines: [],
      totalUsd: 0.66,
      unpriced: false,
    });
    // No setting: refused before the engine — the setting is hers to give (Adi, 23 Sep 2026).
    expect(
      (
        await call("POST", "/studio/edits/batch/quote", {
          refs: [{ assetId: ID, variations: 3, cleanup: null }],
          brand: "Jane Street",
        })
      ).status,
    ).toBe(400);
    expect(mockBatch.quoteBatch).not.toHaveBeenCalled();
    const out = await call("POST", "/studio/edits/batch/quote", {
      refs: [{ assetId: ID, variations: 3, cleanup: null }],
      brand: "Jane Street",
      setting: "stadium pitch at dusk",
      briefLines: ["No Nike marks on kit or ball."],
    });
    expect(out).toMatchObject({
      status: 200,
      body: { batchId: ID, totalUsd: 0.66 },
    });
    expect(mockBatch.quoteBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteId: ATHLETE,
        brand: "Jane Street",
        setting: "stadium pitch at dusk",
        briefLines: ["No Nike marks on kit or ball."],
      }),
    );

    mockBatch.runBatch.mockResolvedValue({ ok: true, queued: 3 });
    expect(await call("POST", `/studio/edits/batch/${ID}/run`)).toMatchObject({
      status: 200,
      body: { queued: 3 },
    });
    expect(mockBatch.runBatch).toHaveBeenCalledWith({
      athleteId: ATHLETE,
      batchId: ID,
    });
    expect((await call("POST", "/studio/edits/batch/nope/run")).status).toBe(
      400,
    );

    mockBatch.rerollBatch.mockResolvedValue({
      ok: false,
      status: 409,
      error: "four is the most",
    });
    expect(
      await call("POST", `/studio/edits/batch/${ID}/reroll`, { assetId: ID }),
    ).toMatchObject({ status: 409, body: { error: "four is the most" } });
    expect(
      (
        await call("POST", `/studio/edits/batch/${ID}/reroll`, {
          assetId: "nope",
        })
      ).status,
    ).toBe(400);

    mockBatch.acceptAllBatch.mockResolvedValue({
      ok: true,
      assetIds: [ID],
      skipped: 1,
    });
    expect(
      await call("POST", `/studio/edits/batch/${ID}/accept-all`),
    ).toMatchObject({ status: 200, body: { assetIds: [ID], skipped: 1 } });

    mockBatch.batchView.mockResolvedValue({
      batchId: ID,
      candidates: [],
      intermediates: [],
      running: false,
      canReroll: false,
    });
    expect(await call("GET", `/studio/edits/batch/${ID}`)).toMatchObject({
      status: 200,
      body: { batchId: ID, running: false },
    });
    expect(mockEngine.quoteEdit).not.toHaveBeenCalled();
    expect(mockEngine.runEdit).not.toHaveBeenCalled();
  });
});
