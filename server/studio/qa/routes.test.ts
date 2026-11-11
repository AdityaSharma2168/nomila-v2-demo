/**
 * qa/routes.test — the verdict door's shape (PR 11, R-4/R-5): off is a 404, on it says flag-or-pass
 * and the cost, and nothing on the wire is a number with a threshold. The join is stood in; the
 * query itself is join.test.ts's against real SQL.
 *
 * REVERT CHECKS, red by name:
 *   "verdict chip renders with STUDIO_QA_DISPLAY off" (server half) → drop `requireDisplay`
 *   "verdict shown as a score with a threshold"        → put a check score or a distance on the wire
 *   "identity observation shown as pass/fail"          → caption the observation with the verdict's word
 */
const joinRowMock = jest.fn();
jest.mock("./join", () => ({
  joinRow: (...a: unknown[]) => joinRowMock(...a),
}));

import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  presentCost,
  presentQa,
  presentVerdict,
  registerQaRoutes,
  wordingFor,
} from "./routes";
import type { StructureRecord } from "../video/structureVocab";
import type { JoinRow } from "./join";
import type { CreativeQaVerdict } from "./verdict";

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const router = express.Router();
  const gate: RequestHandler = (req, _res, next) => {
    req.athleteId = ATHLETE;
    next();
  };
  registerQaRoutes(router, [gate]);
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
  process.env.STUDIO_QA_DISPLAY = "true";
  joinRowMock.mockReset();
});
afterEach(() => {
  delete process.env.STUDIO_QA_DISPLAY;
});

const get = (path: string) => fetch(`${base}${path}`);

/** A verdict as the record holds it: full of numbers, none of which may reach the wire. */
const verdict = (over: Partial<CreativeQaVerdict> = {}): CreativeQaVerdict =>
  ({
    schemaVersion: 6,
    at: "2026-09-23T00:00:00.000Z",
    overall: "flag",
    unknownChecks: 1,
    advisoryChecks: [],
    checks: {
      identity: {
        status: "flag",
        summary: "distance 0.41 against a 0.40 threshold",
        detail: { distance: 0.41 },
        error: null,
        spend: {},
        latencyMs: 0,
      },
      marks: {
        status: "pass",
        summary: "",
        detail: null,
        error: null,
        spend: {},
        latencyMs: 0,
      },
      anatomy: {
        status: "pass",
        summary: "",
        detail: null,
        error: null,
        spend: {},
        latencyMs: 0,
      },
      adherence: {
        status: "unknown",
        summary: "",
        detail: null,
        error: "x",
        spend: {},
        latencyMs: 0,
      },
      text: {
        status: "pass",
        summary: "",
        detail: null,
        error: null,
        spend: {},
        latencyMs: 0,
      },
    },
    subject: "generate",
    identityObservation: {
      method: "face-crop/multimodalembedding@001",
      caveat:
        "Observation only, never a verdict. The ruler failed its stranger control.",
      outputFace: { confidence: 0.99, sizeFrac: 0.2, small: false },
      outputReason: null,
      comparisons: [
        {
          comparedAgainst: "reference",
          assetId: "r",
          distance: 0.3584,
          face: null,
          reason: null,
        },
      ],
      referencesMean: 0.3584,
      identitySetMean: 0.3158,
      referencesCount: 1,
      identitySetCount: 3,
      spend: {
        usd: 0.002,
        basis: "estimated",
        visionCalls: 1,
        embedCalls: 2,
        inputTokens: 1,
        outputTokens: 1,
      },
      latencyMs: 5,
    },
    spend: {
      usd: 0.0123,
      basis: "estimated",
      visionCalls: 3,
      embedCalls: 2,
      inputTokens: 1,
      outputTokens: 1,
    },
    latencyMs: 4321,
    comparison: {
      rootAssetId: "r",
      outputAssetId: ASSET,
      chainDepth: 0,
      chainTruncated: false,
    },
    ...over,
  }) as unknown as CreativeQaVerdict;

const row = (over: Partial<JoinRow> = {}): JoinRow => ({
  from: { assetId: ASSET },
  job: {
    id: "job-1",
    cost_estimated_usd: "0.1344",
    cost_basis: "estimated",
  } as unknown as JoinRow["job"],
  asset: {
    id: ASSET,
    mediaType: "IMAGE",
    gcsPath: "x",
    approvalStatus: "draft",
    generationJobId: "job-1",
    derivedFromAssetId: null,
    createdAt: null,
  },
  edit: null,
  verdict: verdict(),
  costLines: [],
  costLinesFrom: "/dev/null",
  ...over,
});

describe("off is a 404", () => {
  /** ⚠️ MUTATION "verdict chip renders with STUDIO_QA_DISPLAY off": drop requireDisplay from the route. */
  it("answers 404 before reading anything when STUDIO_QA_DISPLAY is off", async () => {
    delete process.env.STUDIO_QA_DISPLAY;
    const res = await get(`/studio/assets/${ASSET}/qa`);
    expect(res.status).toBe(404);
    expect(joinRowMock).not.toHaveBeenCalled();
  });

  it("is a 404, not a 403 — the flag's state is not readable from outside", async () => {
    delete process.env.STUDIO_QA_DISPLAY;
    const res = await get(`/studio/assets/${ASSET}/qa`);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("on: the wire", () => {
  it("reads through the join under req.athleteId and answers flag-or-pass wording plus the cost", async () => {
    joinRowMock.mockResolvedValue(row());
    const res = await get(`/studio/assets/${ASSET}/qa`);
    expect(res.status).toBe(200);
    expect(joinRowMock).toHaveBeenCalledWith(ATHLETE, { assetId: ASSET });
    const body = await res.json();
    expect(body).toEqual({
      assetId: ASSET,
      verdict: {
        wording: "flag",
        label: "Flagged for a look",
        subject: "generate",
        at: "2026-09-23T00:00:00.000Z",
        unknownChecks: 1,
        identityObservation: {
          caption: "Observation only, not a check",
          caveat:
            "Observation only, never a verdict. The ruler failed its stranger control.",
        },
        spendUsd: 0.0123,
      },
      cost: { usd: 0.1344, basis: "estimated", source: "job_quote" },
    });
  });

  /** ⚠️ MUTATION "verdict shown as a score with a threshold": add `checks` or a distance to presentVerdict. */
  it("carries NO check score, distance, mean or threshold — the record's numbers never leave it", async () => {
    joinRowMock.mockResolvedValue(row());
    const text = await (await get(`/studio/assets/${ASSET}/qa`)).text();
    for (const leaked of [
      "0.41",
      "0.40",
      "0.3584",
      "0.3158",
      "threshold",
      "distance",
      "checks",
      "referencesMean",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  /** ⚠️ MUTATION "identity observation shown as pass/fail": caption it with `checks.identity.status`. */
  it("captions the identity observation as an observation, whatever the identity check said", async () => {
    joinRowMock.mockResolvedValue(row());
    const body = await (await get(`/studio/assets/${ASSET}/qa`)).json();
    expect(body.verdict.identityObservation.caption).toBe(
      "Observation only, not a check",
    );
    // Exactly two keys, and no status-shaped value anywhere in it: the caveat is prose that may
    // say the ruler "failed" its control; what must never appear is a verdict word AS a value.
    expect(Object.keys(body.verdict.identityObservation).sort()).toEqual([
      "caption",
      "caveat",
    ]);
    expect(JSON.stringify(body.verdict.identityObservation)).not.toMatch(
      /"(pass|fail|flag)"/,
    );
  });

  it("a FAIL reads as flagged — the surface shows, it does not decide", () => {
    expect(wordingFor("fail")).toBe("flag");
    expect(wordingFor("flag")).toBe("flag");
    expect(wordingFor("pass")).toBe("pass");
    expect(presentVerdict(verdict({ overall: "fail" })).label).toBe(
      "Flagged for a look",
    );
  });

  it("no verdict yet → verdict null, and the cost still answers", async () => {
    joinRowMock.mockResolvedValue(row({ verdict: null }));
    const body = await (await get(`/studio/assets/${ASSET}/qa`)).json();
    expect(body.verdict).toBeNull();
    expect(body.cost).toEqual({
      usd: 0.1344,
      basis: "estimated",
      source: "job_quote",
    });
  });

  it("an accepted edit's cost is the edit row's actual figure, with the line's basis when a line joined", () => {
    const edit = {
      id: "edit-1",
      cost_usd: "0.1300",
    } as unknown as JoinRow["edit"];
    expect(presentCost(row({ edit }))).toEqual({
      usd: 0.13,
      basis: "estimated",
      source: "edit_row",
    });
    const authoritative = [
      { editPreviewId: "edit-1", costBasis: "authoritative" },
    ] as unknown as JoinRow["costLines"];
    expect(presentCost(row({ edit, costLines: authoritative }))).toEqual({
      usd: 0.13,
      basis: "authoritative",
      source: "edit_row",
    });
  });

  it("not her asset, or no such asset → 404", async () => {
    joinRowMock.mockResolvedValue(
      row({ asset: null, job: null, verdict: null }),
    );
    expect((await get(`/studio/assets/${ASSET}/qa`)).status).toBe(404);
  });

  it("a non-uuid is a 400 that names the field", async () => {
    const res = await get("/studio/assets/not-a-uuid/qa");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "assetId must be a uuid",
      field: "assetId",
    });
    expect(joinRowMock).not.toHaveBeenCalled();
  });
});

describe("drift on the wire (PR 17, R-6)", () => {
  const drift = (over: Record<string, unknown> = {}) => ({
    method: "face-crop/multimodalembedding@001",
    caption: "Observation only, not a check",
    caveat: "x",
    framesFrom: "beats",
    frames: [
      {
        timeSec: 0,
        stepFromPrev: null,
        face: { confidence: 0.9, sizeFrac: 0.2, small: false },
      },
      {
        timeSec: 2,
        stepFromPrev: 0.1,
        face: { confidence: 0.9, sizeFrac: 0.2, small: false },
      },
      {
        timeSec: 4,
        stepFromPrev: 0.4,
        face: { confidence: 0.9, sizeFrac: 0.2, small: false },
      },
    ],
    medianStep: 0.25,
    maxStep: 0.4,
    maxStepAtSec: 4,
    maxOverMedian: 1.6,
    spend: {},
    latencyMs: 1,
    ...over,
  });

  it("absent on the record → ABSENT on the wire (an old wire is byte-identical)", () => {
    expect("driftObservation" in presentVerdict(verdict())).toBe(false);
  });

  it("drift shown as pass/fail — the line is a time and a count, captioned as an observation", () => {
    const w = presentVerdict(verdict({ driftObservation: drift() as never }));
    expect(w.driftObservation).toEqual({
      caption: "Observation only, not a check",
      line: "Face measured across 3 frames. Changed most around 4.0s.",
    });
    const text = JSON.stringify(w.driftObservation).toLowerCase();
    for (const word of [
      "pass",
      "fail",
      "flag",
      "0.4",
      "0.25",
      "1.6",
      "×",
      "threshold",
    ])
      expect(text).not.toContain(word);
  });

  it("is-it-her shown for an athlete whose control failed — the line mentions the pack only when the record carries isHer", () => {
    const w1 = presentVerdict(verdict({ driftObservation: drift() as never }));
    expect(w1.driftObservation?.line).not.toMatch(/pack/);
    const w2 = presentVerdict(
      verdict({
        driftObservation: drift({
          isHer: { anchors: 3, caveat: "c" },
        }) as never,
      }),
    );
    expect(w2.driftObservation?.line).toMatch(/Compared with your pack too/);
  });

  it("with too few faces the line says so, and still no verdict word", () => {
    const w = presentVerdict(
      verdict({
        driftObservation: drift({
          frames: [{ timeSec: 0, stepFromPrev: null, face: null }],
        }) as never,
      }),
    );
    expect(w.driftObservation?.line).toBe(
      "Face was not measurable across this clip.",
    );
  });
});

/**
 * quality-scrappy piece 2: the structure record on the wire. ⚠️ MUTATION M2f: put `measured` (a duration, a black-second
 * count) on the wire — "structure carries no number" reds.
 */
describe("structure on the wire (quality-scrappy piece 2)", () => {
  const structure = (over: Partial<StructureRecord> = {}): StructureRecord => ({
    version: 1,
    at: "2026-09-28T00:00:00.000Z",
    subject: "stitch",
    status: "fail",
    findings: [
      { reason: "black", severity: "fail" },
      { reason: "frozen", severity: "fail" },
      { reason: "black", severity: "flag" },
    ],
    expected: {
      durationSec: 8,
      aspect: "9:16",
      width: 1080,
      height: 1920,
      sound: false,
    },
    measured: {
      durationSec: 8.043,
      width: 1080,
      height: 1920,
      displayAspect: 0.5625,
      hasAudio: false,
      blackSec: 3.25,
      longestBlackSec: 3.25,
      frozenSec: 6.5,
      longestFrozenSec: 6.5,
      silentSec: null,
    },
    error: null,
    latencyMs: 812,
    ...over,
  });

  it("no structure on the record → no `structure` key on the wire (the wire is what it was)", () => {
    const w = presentQa(row())!;
    expect(Object.keys(w).sort()).toEqual(["assetId", "cost", "verdict"]);
  });

  it("a structure-only record (a stitch, or a clip with creative QA off): verdict null, structure flagged, one line per reason", () => {
    const w = presentQa(row({ verdict: { structure: structure() } as never }))!;
    expect(w.verdict).toBeNull();
    expect(w.structure).toEqual({
      wording: "flag",
      label: "Flagged for a look",
      lines: ["Part of it is a black screen.", "Part of it is frozen."],
    });
  });

  it("beside a verdict: both on the wire, the verdict unchanged", () => {
    const w = presentQa(
      row({
        verdict: {
          ...verdict(),
          structure: structure({ status: "pass", findings: [] }),
        } as never,
      }),
    )!;
    expect(w.verdict).toEqual(presentVerdict(verdict()));
    expect(w.structure).toEqual({
      wording: "pass",
      label: "Passed the check",
      lines: [],
    });
  });

  it("a check that could not answer is not shown — unknown is not a pass", () => {
    const w = presentQa(
      row({
        verdict: {
          structure: structure({
            status: "unknown",
            findings: [],
            measured: null,
          }),
        } as never,
      }),
    )!;
    expect(w.structure).toBeUndefined();
  });

  it("structure carries no number — no duration, no black seconds, no ratio", () => {
    const text = JSON.stringify(
      presentQa(row({ verdict: { structure: structure() } as never })),
    );
    expect(text).not.toMatch(/8\.043|3\.25|6\.5|0\.5625|812/);
    expect(text).not.toMatch(/threshold|≥|<=|>=/i);
  });
});
