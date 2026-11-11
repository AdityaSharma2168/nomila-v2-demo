/**
 * structure.test.ts — the structure check (quality-scrappy piece 2, ADI-QS-GO) on real ffmpeg, against fixture clips
 * generated at test time: a clean one, a black one, a frozen one, a wrong shape, a short black run, a silent track and
 * no track. Then the record's write: one key under creative_qa, tenancy in the predicate, and a verdict written after
 * it keeps it.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M2a — drop the freezedetect verdict (`frozenSec` never fails): "a frozen clip fails as frozen" reds.
 *   M2b — check silence on a clip that did not pay for sound: "no sound was paid for: silence is not a finding" reds.
 *   M2c — writeVerdict stops keeping `structure` (qa/record.ts keptBeside → {}): "a verdict written after the
 *         structure check keeps it" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { athletes, mediaAssets } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { writeVerdict } from "../qa/record";
import type { CreativeQaVerdict } from "../qa/verdict";
import {
  STRUCTURE_LIMITS,
  checkStructure,
  checkStructureBytes,
  clipExpectation,
  findingsFor,
  intervalsFrom,
  statusOf,
  writeStructure,
  type StructureExpectation,
  type StructureMeasurement,
} from "./structure";
import {
  makeStructureFixtures,
  type StructureFixtures,
} from "./structureFixtures";

jest.setTimeout(120_000);

const DIR = mkdtempSync(join(tmpdir(), "structure-test-"));
let fx: StructureFixtures;

const HER = "77777777-2222-4777-8777-777777777777";
const SOMEONE_ELSE = "88888888-2222-4888-8888-888888888888";

beforeAll(async () => {
  fx = await makeStructureFixtures(DIR);
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Structure Test Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(DIR, { recursive: true, force: true });
});

/** What a 4 s 9:16 clip at 360x640 was asked for; sound on or off. */
const ASKED = (
  over: Partial<StructureExpectation> = {},
): StructureExpectation => ({
  durationSec: 4,
  aspect: "9:16",
  width: 360,
  height: 640,
  sound: false,
  ...over,
});
const reasons = (r: { findings: { reason: string; severity: string }[] }) =>
  r.findings.map((f) => `${f.reason}:${f.severity}`).sort();

describe("the fixtures, checked", () => {
  it("a clean clip passes, and its measurements are what was made", async () => {
    const r = await checkStructure(fx.clean, ASKED({ sound: true }), "clip");
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.measured).toMatchObject({
      width: 360,
      height: 640,
      hasAudio: true,
      blackSec: 0,
      frozenSec: 0,
    });
    expect(r.measured!.durationSec).toBeCloseTo(4, 1);
    expect(r.error).toBeNull();
  });

  it("a black clip fails as black", async () => {
    const r = await checkStructure(fx.black, ASKED(), "clip");
    expect(r.status).toBe("fail");
    expect(reasons(r)).toContain("black:fail");
  });

  it("a frozen clip fails as frozen — and is not called black", async () => {
    const r = await checkStructure(fx.frozen, ASKED(), "clip");
    expect(r.status).toBe("fail");
    expect(reasons(r)).toEqual(["frozen:fail"]);
  });

  it("a wrong shape fails on aspect and on size", async () => {
    const r = await checkStructure(fx.wide, ASKED(), "clip");
    expect(r.status).toBe("fail");
    expect(reasons(r)).toEqual(["aspect:fail", "resolution:fail"]);
  });

  it("a wrong shape with no size asked (Vertex takes a ratio) fails on aspect alone", async () => {
    const r = await checkStructure(
      fx.wide,
      ASKED({ width: null, height: null }),
      "clip",
    );
    expect(reasons(r)).toEqual(["aspect:fail"]);
  });

  it("a length that is not the quote fails", async () => {
    const r = await checkStructure(fx.clean, ASKED({ durationSec: 8 }), "clip");
    expect(reasons(r)).toEqual(["duration:fail"]);
  });

  it("a short black run is worth a look, not a failure", async () => {
    const r = await checkStructure(fx.blackStart, ASKED(), "clip");
    expect(r.status).toBe("flag");
    expect(reasons(r)).toEqual(["black:flag"]);
  });

  it("sound paid for, a silent track: fails as silent", async () => {
    const r = await checkStructure(
      fx.silentTrack,
      ASKED({ sound: true }),
      "clip",
    );
    expect(reasons(r)).toEqual(["silent:fail"]);
    expect(r.measured!.silentSec).toBeGreaterThan(3.5);
  });

  it("sound paid for, no audio track at all: fails as silent", async () => {
    const r = await checkStructure(fx.noAudio, ASKED({ sound: true }), "clip");
    expect(reasons(r)).toEqual(["silent:fail"]);
  });

  it("no sound was paid for: silence is not a finding, and is not even measured", async () => {
    for (const f of [fx.silentTrack, fx.noAudio]) {
      const r = await checkStructure(f, ASKED({ sound: false }), "clip");
      expect(r.status).toBe("pass");
      expect(r.measured!.silentSec).toBeNull();
    }
  });

  it("never throws: a missing file, and a url, are `unknown` with the reason", async () => {
    const missing = await checkStructure(
      join(DIR, "nope.mp4"),
      ASKED(),
      "clip",
    );
    expect(missing.status).toBe("unknown");
    expect(missing.error).toMatch(/ffprobe failed/);
    const url = await checkStructure(
      "https://example.test/a.mp4",
      ASKED(),
      "clip",
    );
    expect(url.status).toBe("unknown");
    expect(url.error).toMatch(/local file path/);
  });

  it("bytes in hand go through a private temp file and come out the same verdict", async () => {
    const r = await checkStructureBytes(
      readFileSync(fx.black),
      ASKED(),
      "clip",
    );
    expect(r.status).toBe("fail");
    expect(reasons(r)).toContain("black:fail");
  });
});

describe("the rules, pure", () => {
  const m = (
    over: Partial<StructureMeasurement> = {},
  ): StructureMeasurement => ({
    durationSec: 8,
    width: 720,
    height: 1280,
    displayAspect: 0.5625,
    hasAudio: true,
    blackSec: 0,
    longestBlackSec: 0,
    frozenSec: 0,
    longestFrozenSec: 0,
    silentSec: null,
    ...over,
  });
  const e = (
    over: Partial<StructureExpectation> = {},
  ): StructureExpectation => ({
    durationSec: 8,
    aspect: "9:16",
    width: null,
    height: null,
    sound: false,
    ...over,
  });

  it("Seedance's extra frame is inside the length slack (4 s quoted, 4.04 s delivered)", () => {
    expect(
      findingsFor(m({ durationSec: 4.042 }), e({ durationSec: 4 })),
    ).toEqual([]);
  });

  it("the thresholds are the named constants", () => {
    const L = STRUCTURE_LIMITS;
    expect(
      // On a 4 s clip the absolute floor (1.0 s) is the larger; on an 8 s clip the share (1.6 s) is.
      findingsFor(
        m({ durationSec: 4, blackSec: L.blackFailSec, longestBlackSec: 1 }),
        e({ durationSec: 4 }),
      ),
    ).toEqual([{ reason: "black", severity: "fail" }]);
    expect(
      findingsFor(m({ blackSec: L.blackFailSec, longestBlackSec: 1 }), e()),
    ).toEqual([{ reason: "black", severity: "flag" }]);
    expect(findingsFor(m({ frozenSec: 4, longestFrozenSec: 4 }), e())).toEqual([
      { reason: "frozen", severity: "fail" },
    ]);
    expect(
      findingsFor(m({ frozenSec: 2.5, longestFrozenSec: 2.5 }), e()),
    ).toEqual([{ reason: "frozen", severity: "flag" }]);
    expect(findingsFor(m({ silentSec: 5 }), e({ sound: true }))).toEqual([
      { reason: "silent", severity: "flag" },
    ]);
  });

  it("status is the worst finding", () => {
    expect(statusOf([])).toBe("pass");
    expect(statusOf([{ reason: "black", severity: "flag" }])).toBe("flag");
    expect(
      statusOf([
        { reason: "black", severity: "flag" },
        { reason: "aspect", severity: "fail" },
      ]),
    ).toBe("fail");
  });

  it("an interval still open at EOF runs to the end of the clip", () => {
    const log = "lavfi.freezedetect.freeze_start: 1.5\nsomething else";
    expect(
      intervalsFrom(
        log,
        /freeze_start:\s*([\d.]+)/,
        /freeze_end:\s*([\d.]+)/,
        4,
      ),
    ).toEqual([{ startSec: 1.5, endSec: 4 }]);
  });

  it("clipExpectation reads what the quote priced: the planner's inputs and parameters.generateAudio", () => {
    expect(
      clipExpectation(
        { durationSeconds: 4, aspectRatio: "9:16", width: 720, height: 1280 },
        { parameters: { generateAudio: true } },
      ),
    ).toEqual({
      durationSec: 4,
      aspect: "9:16",
      width: 720,
      height: 1280,
      sound: true,
    });
    expect(
      clipExpectation(
        { durationSeconds: 8, aspectRatio: "9:16" },
        { parameters: { generateAudio: false } },
      ),
    ).toEqual({
      durationSec: 8,
      aspect: "9:16",
      width: null,
      height: null,
      sound: false,
    });
  });
});

describe("the record: one key under creative_qa, hers only", () => {
  async function seed(
    owner: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<string> {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: owner,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${owner}/c-${Math.random().toString(36).slice(2)}.mp4`,
        content_type: "video/mp4",
        ...(metadata ? { metadata } : {}),
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  }
  const meta = async (id: string) =>
    (
      await db
        .select({ m: mediaAssets.metadata })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, id))
    )[0].m as Record<string, any>;

  it("writes creative_qa.structure and leaves every other key alone", async () => {
    const id = await seed(HER, {
      vision: { beats: [] },
      creative_qa: { overall: "pass", schemaVersion: 6 },
    });
    const record = await checkStructure(fx.black, ASKED(), "clip");
    expect(await writeStructure(id, HER, record)).toBe(true);
    const m = await meta(id);
    expect(m.vision).toEqual({ beats: [] });
    expect(m.creative_qa.overall).toBe("pass");
    expect(m.creative_qa.structure.status).toBe("fail");
  });

  it("creates creative_qa when there is none", async () => {
    const id = await seed(HER);
    await writeStructure(
      id,
      HER,
      await checkStructure(fx.clean, ASKED(), "clip"),
    );
    expect((await meta(id)).creative_qa).toEqual({
      structure: expect.objectContaining({ status: "pass" }),
    });
  });

  it("never writes another athlete's asset", async () => {
    const theirs = await seed(SOMEONE_ELSE);
    expect(
      await writeStructure(
        theirs,
        HER,
        await checkStructure(fx.clean, ASKED(), "clip"),
      ),
    ).toBe(false);
    expect((await meta(theirs))?.creative_qa).toBeUndefined();
  });

  it("a verdict written after the structure check keeps it", async () => {
    const id = await seed(HER);
    await writeStructure(
      id,
      HER,
      await checkStructure(fx.frozen, ASKED(), "clip"),
    );
    const verdict = {
      schemaVersion: 6,
      overall: "pass",
      subject: "clip",
      unknownChecks: 0,
      spend: { usd: 0 },
      comparison: { chainDepth: 0 },
    } as unknown as CreativeQaVerdict;
    expect(await writeVerdict(id, HER, verdict)).toBe(true);
    const qa = (await meta(id)).creative_qa;
    expect(qa.overall).toBe("pass");
    expect(qa.structure.status).toBe("fail");
  });

  it("with no structure on record, a verdict is written exactly as before", async () => {
    const id = await seed(HER);
    const verdict = {
      schemaVersion: 6,
      overall: "flag",
      subject: "generate",
      unknownChecks: 0,
      spend: { usd: 0 },
      comparison: { chainDepth: 0 },
    } as unknown as CreativeQaVerdict;
    expect(await writeVerdict(id, HER, verdict)).toBe(true);
    expect((await meta(id)).creative_qa).toEqual(verdict);
  });
});
