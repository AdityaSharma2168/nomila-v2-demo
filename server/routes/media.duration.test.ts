/**
 * media.duration.test.ts — POST /media writes a video's MEASURED length (migration 0058).
 *
 * Two columns, two provenances, and the whole point of the change is that they do not get mixed:
 *
 *   duration_seconds          — what the client's picker ASSERTED, rounded to the integer the
 *                               column has always been. UNCHANGED by this work.
 *   duration_seconds_precise  — what ffprobe MEASURED off the bytes; the picker's unrounded
 *                               fraction only when nothing could be measured.
 *
 * The probe FAILS OPEN, which is the opposite posture to the image branch beside it, and that
 * asymmetry is the thing most likely to be "tidied" into consistency later. A photo that cannot be
 * straightened is refused because storing it is the bug that code exists to prevent; a clip whose
 * length cannot be read is a perfectly good clip missing a number. The suite below fails if the
 * refusal ever spreads to video.
 *
 * Real Express router against PGlite. GCS signing, enrichment and ffprobe are mocked — signing
 * needs a service-account key and ffprobe needs a real file, neither of which exists in a worker.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/mediaStore", () => {
  const actual = jest.requireActual("../lib/mediaStore");
  return {
    ...actual,
    signedUrl: jest.fn(
      async (p: string) => `https://signed.example/${p}?sig=secret`,
    ),
    signedUploadUrl: jest.fn(
      async (p: string) => `https://signed.example/upload/${p}?sig=abc`,
    ),
  };
});
jest.mock("../services/mediaEnrichment", () => ({
  enrichNextChunk: jest.fn(async () => {}),
}));
jest.mock("../studio/video/probe", () => ({ probeDurationSeconds: jest.fn() }));
// The image branch reads the object back out of GCS to straighten it; there is no object here.
// Null is its "not a format we can measure" answer, which registers the row unverified.
jest.mock("../studio/orient", () => ({
  normalizeStoredImage: jest.fn(async () => null),
}));
jest.mock("../lib/moderation", () => ({
  moderateGcsImage: jest.fn(async () => ({
    blocked: false,
    categories: [],
    scores: null,
  })),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import mediaRouter from "./media";
import { mediaAssets } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { probeDurationSeconds } from "../studio/video/probe";
import { signedUrl } from "../lib/mediaStore";

const probeMock = probeDurationSeconds as jest.MockedFunction<
  typeof probeDurationSeconds
>;

let server: Server;
let base: string;
let athleteId: string;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

/** Register an object the client has "already PUT" — the real POST /media body. */
async function register(body: Record<string, unknown>) {
  const res = await fetch(`${base}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
}

/** The two duration columns as they landed, for the row just registered. */
async function durationsOf(assetId: string) {
  const [row] = await db
    .select({
      rounded: mediaAssets.duration_seconds,
      precise: mediaAssets.duration_seconds_precise,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));
  return row;
}

const clip = (overrides: Record<string, unknown> = {}) => ({
  gcsPath: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`,
  contentType: "video/mp4",
  ...overrides,
});

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/", mediaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  athleteId = await seedAthlete("Duration Tester");
  asUser(athleteId);
  probeMock.mockReset();
});

describe("POST /media — the measured duration goes to the precise column only", () => {
  /**
   * ⚠️  THE REVERT CHECK FOR THE UPLOAD PROBE.
   *
   * ffprobe says 12.47. The picker said 13 (a phone rounds up in its own UI and sends ms). The two
   * columns must disagree, each holding its own provenance: the integer keeps the ASSERTION, the
   * float8 keeps the MEASUREMENT.
   *
   * MUTATION: drop `measuredDurationSec ??` from the write, so the client's number feeds both.
   * `precise` becomes 13 and this reds on the first assertion.
   */
  it("stores ffprobe's fraction as precise and leaves the picker's integer alone", async () => {
    probeMock.mockResolvedValue(12.47);

    const { status, json } = await register(clip({ durationSeconds: 13 }));
    expect(status).toBe(201);

    const d = await durationsOf(json.item.asset_id);
    expect(d.precise).toBeCloseTo(12.47, 6);
    expect(d.rounded).toBe(13);
  });

  /**
   * The path that motivated the whole change: a clip that arrived with NO asserted duration at all
   * — anything that did not come through the OS picker. Before 0058 this row had no duration in
   * any column, and video/materialize.ts had to charge it at bytes ÷ bitrate.
   */
  it("measures a clip the client said nothing about", async () => {
    probeMock.mockResolvedValue(8.033);

    const { status, json } = await register(clip());
    expect(status).toBe(201);

    const d = await durationsOf(json.item.asset_id);
    expect(d.precise).toBeCloseTo(8.033, 6);
    expect(d.rounded).toBeNull(); // unchanged behaviour: no assertion, no integer
  });

  /**
   * ⚠️  THE FAIL-OPEN REVERT CHECK. The image branch one screen up REFUSES an upload it cannot
   * normalize (422, object left unregistered). If that posture is ever copied onto video, this
   * reds: the row must exist, and it must be usable.
   *
   * MUTATION: re-throw from the catch in the probe block instead of logging. The request 500s and
   * both assertions fail.
   */
  it("registers the clip anyway when ffprobe fails, falling back to the client's fraction", async () => {
    probeMock.mockRejectedValue(
      new Error("ffprobe failed: moov atom not found"),
    );

    const { status, json } = await register(clip({ durationSeconds: 9.6 }));
    expect(status).toBe(201);

    const d = await durationsOf(json.item.asset_id);
    // The fallback is ASSERTED, but it is a fraction — strictly more than the integer column holds.
    expect(d.precise).toBeCloseTo(9.6, 6);
    expect(d.rounded).toBe(10);
  });

  it("registers a clip that could neither be measured nor asserted, with both columns null", async () => {
    probeMock.mockRejectedValue(new Error("ffprobe failed: 403"));

    const { status, json } = await register(clip());
    expect(status).toBe(201);

    const d = await durationsOf(json.item.asset_id);
    // NULL is a real answer — "not measured", never "zero". A 0 here would read as "no video".
    expect(d.precise).toBeNull();
    expect(d.rounded).toBeNull();
  });

  /**
   * A photo must not be probed at all. ffprobe on a JPEG would either throw (a wasted round trip
   * on every single photo upload) or, worse, succeed against an image "stream" and write a
   * duration onto a still.
   */
  it("never probes a photo, and leaves both duration columns null", async () => {
    const { status, json } = await register({
      gcsPath: `athletes/${athleteId}/uploads/p.jpg`,
      contentType: "image/jpeg",
      durationSeconds: 5,
    });
    expect(status).toBe(201);

    expect(probeMock).not.toHaveBeenCalled();
    const d = await durationsOf(json.item.asset_id);
    expect(d.precise).toBeNull();
    expect(d.rounded).toBeNull();
  });

  /**
   * The probe reads the object over a SIGNED URL rather than downloading it — on Cloud Run /tmp is
   * RAM, and a phone capture is tens of MB. Pinned because "just fetch the bytes first" is the
   * change that would make this quietly expensive.
   */
  it("probes the signed URL for the object, not a local path", async () => {
    probeMock.mockResolvedValue(4);
    const path = `athletes/${athleteId}/uploads/signed-check.mp4`;

    await register(clip({ gcsPath: path }));

    expect(signedUrl).toHaveBeenCalledWith(path, expect.any(Number));
    expect(probeMock).toHaveBeenCalledWith(
      `https://signed.example/${path}?sig=secret`,
    );
  });
});

describe("GET /media — the measured duration reaches the client", () => {
  /**
   * ⚠️  THE REVERT CHECK FOR THE WHOLE ARC REACHING ANYTHING.
   *
   * The migration, the upload probe and both riders put a real fractional duration in the column —
   * and if the read API keeps serving only the rounded integer, no client can ever see it and the
   * entire change is dead weight behind a column nobody reads. This is the seam where it either
   * arrives or does not.
   *
   * ADDITIVE, and asserted as such: the old key must keep its old value and its old meaning beside
   * the new one. A client that knows only `duration_seconds` must be unaffected.
   *
   * MUTATION: delete `duration_seconds_precise` from shapeItems. The first assertion reds on
   * undefined, and the studio timeline goes back to its own decoder as the only accurate source.
   */
  it("serves both durations, each keeping its own meaning", async () => {
    probeMock.mockResolvedValue(12.47);
    await register(clip({ durationSeconds: 13 }));

    const res = await fetch(`${base}/media?type=videos`);
    const { items } = (await res.json()) as any;
    const item = items[0];

    expect(item.duration_seconds_precise).toBeCloseTo(12.47, 6);
    expect(item.duration_seconds).toBe(13);
  });

  /**
   * A row nothing has measured serves NULL for the precise key rather than omitting it or
   * substituting the integer. The client's ladder needs to be able to tell "measured 5.0" from
   * "asserted 5, never measured" — that distinction is the reason there are two columns, and
   * collapsing it here would throw it away at the last step.
   */
  it("serves null, not the integer, when nothing has measured the row", async () => {
    probeMock.mockRejectedValue(new Error("ffprobe failed: 403"));
    await register(clip());

    const res = await fetch(`${base}/media?type=videos`);
    const { items } = (await res.json()) as any;

    expect(items[0].duration_seconds_precise).toBeNull();
  });
});

describe("POST /media — tenancy still binds the probe path", () => {
  /**
   * The gcsPath prefix check runs BEFORE any probe. A path outside this athlete's upload prefix is
   * refused without ffprobe ever being pointed at it — otherwise the route would read an object
   * for an athlete the caller is not, and report on it.
   */
  it("refuses another athlete's path without probing it", async () => {
    probeMock.mockResolvedValue(30);
    const someoneElse = await seedAthlete("Not Her");

    const { status } = await register({
      gcsPath: `athletes/${someoneElse}/uploads/theirs.mp4`,
      contentType: "video/mp4",
    });

    expect(status).toBe(400);
    expect(probeMock).not.toHaveBeenCalled();
  });
});
