/**
 * outputGate.test.ts — the output gate (quality-scrappy piece 5, ADI-QS-GO): which records fail, what is written and
 * counted, and what the wire says — against real SQL (PGlite).
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M5a — ignore the text check: "a name she didn't ask for fails the gate" reds.
 *   M5b — a missing record never reads as pending: "a clip whose gate has not landed yet reads as still being checked"
 *         reds.
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
import {
  GATE_PENDING_MS,
  evaluateGate,
  gateWire,
  gatesFor,
  recordGate,
  templateOf,
} from "./outputGate";
import { GATE_HEADLINE } from "./gateVocab";
import type { CreativeBrief } from "./brief";

const HER = "77777777-5555-4777-8777-777777777777";
const SOMEONE_ELSE = "88888888-5555-4888-8888-888888888888";
beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Gate Test Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(() => info.mockClear());

const structure = (
  status: string,
  findings: { reason: string; severity: string }[],
) => ({ status, findings });
const text = (status: string) => ({ checks: { text: { status } } });

describe("evaluateGate — structure fails and the name/handle check, nothing else", () => {
  it("a black clip fails on its fail findings only", () => {
    expect(
      evaluateGate({
        structure: structure("fail", [
          { reason: "black", severity: "fail" },
          { reason: "frozen", severity: "flag" },
        ]),
      }),
    ).toEqual({ failed: true, reasons: ["black"] });
  });

  it("a name she didn't ask for fails the gate", () => {
    expect(evaluateGate(text("fail"))).toEqual({
      failed: true,
      reasons: ["name_or_handle"],
    });
  });

  it("a flag is worth a look, not a failure — structure flagged, text flagged: passes", () => {
    expect(
      evaluateGate({
        ...text("flag"),
        structure: structure("flag", [{ reason: "black", severity: "flag" }]),
      }),
    ).toEqual({ failed: false, reasons: [] });
  });

  it("both, in the closed set's order; an unknown reason is ignored; nothing recorded passes", () => {
    expect(
      evaluateGate({
        ...text("fail"),
        structure: structure("fail", [
          { reason: "made-up", severity: "fail" },
          { reason: "aspect", severity: "fail" },
        ]),
      }),
    ).toEqual({ failed: true, reasons: ["aspect", "name_or_handle"] });
    expect(evaluateGate(undefined)).toEqual({ failed: false, reasons: [] });
  });

  it("identity plays no part — a failed identity check alone passes the gate (the biometric call is Mia's)", () => {
    expect(evaluateGate({ checks: { identity: { status: "fail" } } })).toEqual({
      failed: false,
      reasons: [],
    });
  });
});

describe("recordGate — one key under creative_qa, hers only, counted per template", () => {
  async function seed(owner: string, creativeQa: unknown): Promise<string> {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: owner,
        platform: "studio",
        origin: "generated",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${owner}/g-${Math.random().toString(36).slice(2)}.mp4`,
        content_type: "video/mp4",
        metadata: { vision: { beats: [] }, creative_qa: creativeQa },
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  }
  const qaOf = async (id: string) =>
    (
      (
        await db
          .select({ m: mediaAssets.metadata })
          .from(mediaAssets)
          .where(eq(mediaAssets.id, id))
      )[0].m as any
    ).creative_qa;
  const T = {
    key: "studio.video.broll-seedance",
    version: 2,
    source: "registry" as const,
  };

  it("writes creative_qa.gate beside the verdict and the structure record, and logs one line by template key", async () => {
    const id = await seed(HER, {
      overall: "pass",
      ...text("pass"),
      structure: structure("fail", [{ reason: "frozen", severity: "fail" }]),
    });
    const r = await recordGate(id, HER, "clip", T);
    expect(r).toMatchObject({
      failed: true,
      reasons: ["frozen"],
      kind: "clip",
      template: T,
    });
    const qa = await qaOf(id);
    expect(qa.overall).toBe("pass");
    expect(qa.structure.status).toBe("fail");
    expect(qa.gate).toMatchObject({
      version: 1,
      failed: true,
      reasons: ["frozen"],
      template: T,
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: "studio.video.broll-seedance",
        templateVersion: 2,
        templateSource: "registry",
        failed: true,
        reasons: ["frozen"],
      }),
      "output gate",
    );
  });

  it("a pass is recorded too — the pass rate needs its denominator", async () => {
    const id = await seed(HER, { overall: "pass", ...text("pass") });
    expect(await recordGate(id, HER, "image", T)).toMatchObject({
      failed: false,
      reasons: [],
    });
    expect((await qaOf(id)).gate.failed).toBe(false);
  });

  it("never reads or writes another athlete's asset", async () => {
    const theirs = await seed(SOMEONE_ELSE, text("fail"));
    expect(await recordGate(theirs, HER, "clip", T)).toBeNull();
    expect((await qaOf(theirs)).gate).toBeUndefined();
    expect(await gatesFor(HER, [theirs])).toEqual(new Map());
  });

  it("templateOf: the frozen record when there is one, else the planner's key as code", () => {
    const brief = {
      job: {
        template: {
          key: "k",
          source: "registry",
          version: 3,
          hash: "h",
          body: "{}",
        },
      },
    } as unknown as CreativeBrief;
    expect(templateOf(brief, "other")).toEqual({
      key: "k",
      version: 3,
      source: "registry",
    });
    expect(
      templateOf({ job: {} } as CreativeBrief, "studio.video.identity-static"),
    ).toEqual({
      key: "studio.video.identity-static",
      version: null,
      source: "code",
    });
  });
});

describe("gateWire — what a surface is told", () => {
  it("a failed record: the headline, one sentence per reason, the codes for a re-quote — no number", () => {
    expect(
      gateWire(
        { failed: true, reasons: ["black", "name_or_handle"] },
        new Date(),
      ),
    ).toEqual({
      failed: true,
      headline: GATE_HEADLINE,
      lines: [
        "Part of it is a black screen.",
        "It has a name or a handle written in it that you didn't ask for.",
      ],
      corrective: ["black", "name_or_handle"],
    });
  });

  it("a passing record: nothing on the wire", () => {
    expect(
      gateWire({ failed: false, reasons: [] }, new Date()),
    ).toBeUndefined();
  });

  it("a clip whose gate has not landed yet reads as still being checked — and stops saying so after the window", () => {
    const now = Date.now();
    expect(gateWire(null, new Date(now - 1000), now)).toEqual({
      pending: true,
    });
    expect(
      gateWire(null, new Date(now - GATE_PENDING_MS - 1), now),
    ).toBeUndefined();
    expect(gateWire(null, null, now)).toBeUndefined();
  });
});
