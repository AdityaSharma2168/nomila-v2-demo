/**
 * nativeIntent.log.test.ts — the two events a blocked preview logs (wave A, G4; sweep-4 ledger F-CA7).
 *
 * A refused FREEZE logs `native_freeze_refused`. The interpreter answering her ask with no proposal logs
 * `interpreter_ask_blocked` — nothing was frozen. Both can carry `reason: "not_routed"`, so the event is what
 * tells them apart; C2's acceptance cell 3 was misread off the shared name.
 */
const logged: {
  module: string;
  fields: Record<string, unknown>;
  msg: string;
}[] = [];
jest.mock("../logger", () => ({
  createLogger: (module: string) => {
    const log = (fields: Record<string, unknown>, msg: string) =>
      logged.push({ module, fields, msg });
    return { info: log, warn: log, error: log, debug: log };
  },
}));
// brief.ts reads the database at assembly; this suite never assembles, so the module is stubbed.
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import type { BriefInput, CreativeBrief } from "./brief";
import { blockedOnAsk, withNativeEditIntent } from "./nativeIntent";

const brief = (): CreativeBrief =>
  ({
    athlete: { athleteId: "athlete-1" },
    gaps: [],
    job: {
      mode: "edit",
      origin: "system",
      source: {
        mediaAssetId: "asset-1",
        ref: "athletes/synthetic/frame.jpg",
        width: 1008,
        height: 1476,
        editRegions: [],
      },
      references: [],
    },
  }) as unknown as CreativeBrief;

const input = (direction: string): BriefInput => ({
  athleteId: "athlete-1",
  origin: "system",
  objective: "grow-following",
  deliverable: "post",
  mode: "edit",
  direction,
});

const mine = () => logged.filter((l) => l.module === "studio/nativeIntent");
const events = () =>
  mine().map((l) => [l.fields.event, l.fields.reason, l.fields.askReason]);

beforeEach(() => {
  logged.length = 0;
  process.env.STUDIO_NATIVE_EDIT = "true";
});
afterEach(() => {
  delete process.env.STUDIO_NATIVE_EDIT;
});

describe("a blocked preview names what blocked it", () => {
  it("logs the interpreter's ask as its own event — nothing was frozen", () => {
    blockedOnAsk(brief(), "add_unclear");
    expect(events()).toEqual([
      ["interpreter_ask_blocked", "not_routed", "add_unclear"],
    ]);
    expect(mine()[0].msg).toMatch(/interpreter made no proposal/);
  });

  it("keeps a refused freeze's event and words byte for byte, for the same not_routed reason", () => {
    withNativeEditIntent(brief(), input("make it pop"), {
      regions: "region-free",
    });
    expect(events()).toEqual([
      ["native_freeze_refused", "not_routed", "fast_path_declined"],
    ]);
    expect(mine()[0].msg).toBe(
      "native edit intent could not be frozen — the preview is blocked, nothing falls back",
    );
  });
});
