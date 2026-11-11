/**
 * templateScore.test.ts — a template's score per output (quality-scrappy piece 10, ADI-QS-5 (2)), against real SQL: the
 * pure scoring of a `creative_qa` record, the one key it writes beside the verdict and the gate, her row only, and the
 * ONE log line per output carrying the template's key and version (P10). The route-level count — one score per image a
 * real generate stores — is routes/studio.outputGate.test.ts's.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M10a — an unmeasured signal scored as a pass: "a check that did not run is unmeasured, never a pass" reds.
 *   M10b — adherence read on a generate: "adherence is an edit's alone" reds.
 *   M10c — the score written over creative_qa instead of beside: "the score sits beside the gate and the verdict" reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const info = jest.fn();
jest.mock("../logger", () => ({
  createLogger: () => ({
    info,
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, mediaAssets } from "../../shared/schema";
import { recordScore, scoreOf } from "./templateScore";
import { writeVerdict } from "./qa/record";
import type { CreativeQaVerdict } from "./qa/verdict";

const HER = "7a7a7a7a-1111-4111-8111-111111111111";
const OTHER = "7b7b7b7b-2222-4222-8222-222222222222";
const TEMPLATE = {
  key: "studio.image.edit.recolor",
  version: 2,
  source: "registry" as const,
};

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Score Athlete" },
    { id: OTHER, full_name: "Other Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(() => info.mockClear());

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
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/s-${Math.random().toString(36).slice(2)}.png`,
      content_type: "image/png",
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

describe("scoreOf — pure", () => {
  it("an edit's three signals, and the gate's reasons", () => {
    expect(
      scoreOf(
        {
          checks: {
            text: { status: "fail" },
            adherence: { status: "pass" },
          },
          gate: { failed: true, reasons: ["name_or_handle", "not-a-code"] },
        },
        "image",
        "edit",
        TEMPLATE,
        new Date("2026-09-28T00:00:00Z"),
      ),
    ).toEqual({
      version: 1,
      at: "2026-09-28T00:00:00.000Z",
      kind: "image",
      template: TEMPLATE,
      text: "fail",
      adherence: "pass",
      gate: "fail",
      gateReasons: ["name_or_handle"],
    });
  });

  it("a check that did not run is unmeasured, never a pass — nor is a gate that never ran", () => {
    const s = scoreOf(
      { checks: { text: { status: "unknown" }, adherence: {} } },
      "image",
      "edit",
      TEMPLATE,
    );
    expect(s).toMatchObject({
      text: "unmeasured",
      adherence: "unmeasured",
      gate: "unmeasured",
    });
    expect(scoreOf(null, "image", "edit", TEMPLATE)).toMatchObject({
      text: "unmeasured",
      gate: "unmeasured",
    });
  });

  it("adherence is an edit's alone: a generate and a clip say n/a, whatever the record holds", () => {
    const qa = { checks: { adherence: { status: "fail" } } };
    expect(scoreOf(qa, "image", "generate", TEMPLATE).adherence).toBe("n/a");
    expect(scoreOf(qa, "clip", "generate", TEMPLATE).adherence).toBe("n/a");
    expect(scoreOf(qa, "image", "edit", TEMPLATE).adherence).toBe("fail");
  });

  it("a flag is its own value — neither a pass nor a fail", () => {
    expect(
      scoreOf(
        { checks: { text: { status: "flag" } } },
        "image",
        "generate",
        TEMPLATE,
      ).text,
    ).toBe("flag");
  });
});

describe("recordScore — her row, one key, one line", () => {
  it("the score sits beside the gate and the verdict, and every other key is left alone", async () => {
    const id = await seed(HER, {
      vision: { beats: [] },
      creative_qa: {
        overall: "fail",
        checks: { text: { status: "fail" } },
        gate: { failed: true, reasons: ["name_or_handle"] },
      },
    });
    const record = await recordScore(id, HER, "image", "generate", TEMPLATE);
    expect(record).toMatchObject({ text: "fail", gate: "fail" });
    const m = await meta(id);
    expect(m.vision).toEqual({ beats: [] });
    expect(m.creative_qa.overall).toBe("fail");
    expect(m.creative_qa.gate).toEqual({
      failed: true,
      reasons: ["name_or_handle"],
    });
    expect(m.creative_qa.score).toMatchObject({
      template: TEMPLATE,
      text: "fail",
      adherence: "n/a",
      gate: "fail",
    });
  });

  it("P10: exactly one 'template score' line per output, carrying the template's key and version", async () => {
    const id = await seed(HER, {
      creative_qa: { checks: { text: { status: "pass" } } },
    });
    await recordScore(id, HER, "image", "edit", TEMPLATE);
    const lines = info.mock.calls.filter((c) => c[1] === "template score");
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({
      assetId: id,
      templateKey: "studio.image.edit.recolor",
      templateVersion: 2,
      templateSource: "registry",
      text: "pass",
    });
  });

  it("another athlete's output is never read or written", async () => {
    const id = await seed(OTHER, {
      creative_qa: { checks: { text: { status: "fail" } } },
    });
    expect(
      await recordScore(id, HER, "image", "generate", TEMPLATE),
    ).toBeNull();
    expect((await meta(id)).creative_qa.score).toBeUndefined();
    expect(
      info.mock.calls.filter((c) => c[1] === "template score"),
    ).toHaveLength(0);
  });

  it("a QA verdict written after the score keeps it (qa/record.ts KEPT_BESIDE_VERDICT)", async () => {
    const id = await seed(HER, {
      creative_qa: { checks: { text: { status: "pass" } } },
    });
    await recordScore(id, HER, "image", "generate", TEMPLATE);
    const verdict = {
      schemaVersion: 6,
      overall: "pass",
      subject: "generate",
      unknownChecks: 0,
      spend: { usd: 0 },
      comparison: { chainDepth: 0 },
    } as unknown as CreativeQaVerdict;
    expect(await writeVerdict(id, HER, verdict)).toBe(true);
    const qa = (await meta(id)).creative_qa;
    expect(qa.overall).toBe("pass");
    expect(qa.score).toMatchObject({ template: TEMPLATE });
  });
});
