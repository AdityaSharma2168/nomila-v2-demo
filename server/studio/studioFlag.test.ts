/**
 * studioFlag.test.ts — the master switch over every boolean Studio flag (PR 20, docs/probes/ship.md, ADI-S20-GO).
 *
 * Three claims, each pinned where it lives:
 *   1. MASTER UNSET — every flag reads exactly `=== "true"` of its own variable, byte for byte what it did
 *      before the master existed, for every value (unset, "true", "false", "1", "TRUE"), and a master that is
 *      anything but exactly "true" is unset.
 *   2. MASTER ON — every flag reads on unless its own variable is exactly "false".
 *   3. THE VALUE FLAGS DO NOT MOVE — STUDIO_PUBLISH_MODE and the four caps read the same with the master on.
 * Plus the census: every boolean STUDIO_* read in server/studio goes through the helper, and the table below
 * names exactly those flags — a new flag that bypasses the master, or a table that forgot one, reds by name.
 *   4. THE STRICT FLAGS — governance surfaces, and (quality-scrappy, ADI-QS-GO) STUDIO_DIALECTS, STUDIO_OUTPUT_GATE,
 *      STUDIO_FINISHING — read through `studioGovernanceFlag`: exactly "true", and the master never reaches them.
 *      One table and one census since ADI-QS-10 unified quality-scrappy's `studioOptIn` onto main's helper.
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, item 1):
 *   M-master — studioFlag ignores the master (`studioAllOn()` → `false`): every "under the master … reads on" row reds.
 *   M-unset — studioFlag treats unset as on without the master: every "master unset … reads off" row for an unset
 *             variable reds.
 *   M-value — STUDIO_PUBLISH_MODE read through studioFlag (publish/config.ts): "a value flag does not move under
 *             the master: STUDIO_PUBLISH_MODE" reds.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  agentEnabled,
  backgroundMaskEnabled,
  brandProfilesEnabled,
  briefCarrierEnabled,
  clipQcEnabled,
  composerEnabled,
  dialectsEnabled,
  displayTextEnabled,
  finishingEnabled,
  garmentMaskEnabled,
  identityDriftEnabled,
  identityPackEnabled,
  imageEditOpsEnabled,
  imageOpsEnabled,
  interpreterEnabled,
  libraryFieldsEnabled,
  maxDayUsd,
  maxJobUsd,
  momentSearchEnabled,
  moveObjectEnabled,
  nativeEditEnabled,
  objectMaskEnabled,
  outputGateEnabled,
  promptRegistryEnabled,
  qaDisplayEnabled,
  retryEnabled,
  shotDetectEnabled,
  studioEnabled,
  studioServerRouting,
  studioSessionsEnabled,
  studioVideoEnabled,
  styleSpecEnabled,
} from "./config";
import {
  clipReadEnabled,
  enrichDailyCapUsd,
  videoEnrichEnabled,
  videoEnrichMaxRunUsd,
} from "./enrich/config";
import { publishMode } from "./publish/config";
import { creativeQaEnabled } from "./qa/record";
import { studioAllOn, studioFlag } from "./studioFlag";
import { bedsReady } from "./video/beds";
import { musicLibraryReady } from "./music/library";
import { campaignGovernanceEnabled, creativeIntentsEnabled } from "./config";
import { studioGovernanceFlag } from "./studioFlag";

// qa/record.ts imports the db module for its writes; nothing here queries, so a stub is enough (ts-jest hoists this).
jest.mock("../db", () => ({ db: {} }));

/**
 * Every boolean Studio flag under the master: ADI-S20-GO's twenty-eight (the twenty-two, the three masks, beds, enrich,
 * retry), and quality-scrappy's three (ADI-QS-GO: clip QC, shot detection, the prompt registry).
 */
const FLAGS: Record<string, () => boolean> = {
  STUDIO_ENABLED: studioEnabled,
  STUDIO_VIDEO_ENABLED: studioVideoEnabled,
  STUDIO_SESSIONS: studioSessionsEnabled,
  STUDIO_SERVER_ROUTING: studioServerRouting,
  STUDIO_NATIVE_EDIT: nativeEditEnabled,
  STUDIO_AGENT: agentEnabled,
  STUDIO_DISPLAY_TEXT: displayTextEnabled,
  STUDIO_MOVE_OBJECT: moveObjectEnabled,
  STUDIO_INTERPRETER: interpreterEnabled,
  STUDIO_BRAND_PROFILES: brandProfilesEnabled,
  STUDIO_DIRECTION_MOMENTS: momentSearchEnabled,
  STUDIO_IMAGE_EDIT_OPS: imageEditOpsEnabled,
  STUDIO_QA_DISPLAY: qaDisplayEnabled,
  STUDIO_COMPOSER: composerEnabled,
  STUDIO_LIBRARY_FIELDS: libraryFieldsEnabled,
  STUDIO_BRIEF_CARRIER: briefCarrierEnabled,
  STUDIO_IDENTITY_PACK: identityPackEnabled,
  STUDIO_IDENTITY_DRIFT: identityDriftEnabled,
  STUDIO_STYLE_SPEC: styleSpecEnabled,
  STUDIO_IMAGE_OPS: imageOpsEnabled,
  STUDIO_CREATIVE_QA: creativeQaEnabled,
  STUDIO_CLIP_READ: clipReadEnabled,
  STUDIO_GARMENT_MASK: garmentMaskEnabled,
  STUDIO_BACKGROUND_MASK: backgroundMaskEnabled,
  STUDIO_OBJECT_MASK: objectMaskEnabled,
  STUDIO_STITCH_BEDS_READY: bedsReady,
  STUDIO_VIDEO_ENRICH: videoEnrichEnabled,
  STUDIO_AGENT_RETRY: retryEnabled,
  STUDIO_CLIP_QC: clipQcEnabled,
  STUDIO_SHOT_DETECT: shotDetectEnabled,
  STUDIO_PROMPT_REGISTRY: promptRegistryEnabled,
};
const FLAG_NAMES = Object.keys(FLAGS).sort();

/** The value flags ADI-S20-GO keeps out of the master. */
/**
 * The GOVERNANCE flags: surfaces where the athlete governs work. On only when their own variable is exactly "true";
 * the master never opens one (studioFlag.ts).
 */
const GOVERNANCE_FLAGS: Record<string, () => boolean> = {
  STUDIO_CREATIVE_INTENTS: creativeIntentsEnabled,
  STUDIO_CAMPAIGN_GOVERNANCE: campaignGovernanceEnabled,
  // quality-scrappy (ADI-QS-GO; unified here by ADI-QS-10): each changes what she sees or what a spend asks for, and
  // waits for Adi's walk before any master reaches it.
  STUDIO_DIALECTS: dialectsEnabled,
  STUDIO_OUTPUT_GATE: outputGateEnabled,
  STUDIO_FINISHING: finishingEnabled,
  // A fact about THIS environment's bucket (scripts/music/verify_bucket.py OK 83/83): strict, so the master never
  // claims the free library is installed where nobody copied it.
  STUDIO_MUSIC_LIBRARY_READY: musicLibraryReady,
};
const GOVERNANCE_NAMES = Object.keys(GOVERNANCE_FLAGS).sort();

const VALUE_FLAGS = [
  "STUDIO_PUBLISH_MODE",
  "STUDIO_MAX_JOB_USD",
  "STUDIO_MAX_DAY_USD",
  "STUDIO_ENRICH_DAILY_CAP_USD",
  "STUDIO_VIDEO_ENRICH_MAX_RUN_USD",
];

const VALUES = [undefined, "true", "false", "1", "TRUE"] as const;
type Value = (typeof VALUES)[number];
const show = (v: Value) => (v === undefined ? "unset" : `"${v}"`);

/** Every STUDIO_* variable a row touches, saved and restored around each test so rows cannot leak. */
const TOUCHED = ["STUDIO_ALL_ON", ...FLAG_NAMES, ...GOVERNANCE_NAMES, ...VALUE_FLAGS];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setVar(name: string, v: string | undefined) {
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
}

const ROWS = FLAG_NAMES.flatMap((flag) =>
  VALUES.map((v) => [flag, v] as const),
);

describe('the master unset: every flag is byte-identical to its own === "true" (ADI-S20-GO)', () => {
  it.each(ROWS)('master unset: %s=%s reads exactly === "true"', (flag, v) => {
    setVar(flag, v);
    expect(FLAGS[flag]()).toBe(v === "true");
  });

  it.each(["1", "TRUE", "false", "yes", ""])(
    "a master of %p is not the master: every flag, every value, byte-identical",
    (master) => {
      process.env.STUDIO_ALL_ON = master;
      expect(studioAllOn()).toBe(false);
      const wrong = ROWS.filter(([flag, v]) => {
        setVar(flag, v);
        const got = FLAGS[flag]();
        setVar(flag, undefined);
        return got !== (v === "true");
      }).map(([flag, v]) => `${flag}=${show(v)}`);
      expect(wrong).toEqual([]);
    },
  );
});

describe('under the master: every flag reads on unless it is exactly "false" (ADI-S20-GO)', () => {
  it.each(ROWS)(
    'under the master: %s=%s reads on unless exactly "false"',
    (flag, v) => {
      process.env.STUDIO_ALL_ON = "true";
      setVar(flag, v);
      expect(FLAGS[flag]()).toBe(v !== "false");
    },
  );

  it('one explicit "false" turns one flag off and leaves every other flag on', () => {
    process.env.STUDIO_ALL_ON = "true";
    process.env.STUDIO_AGENT_RETRY = "false";
    const on = FLAG_NAMES.filter((f) => FLAGS[f]());
    expect(on).toEqual(FLAG_NAMES.filter((f) => f !== "STUDIO_AGENT_RETRY"));
  });

  it("the helper itself: exactly the table's rule, both sides", () => {
    for (const master of [undefined, "true"] as const) {
      setVar("STUDIO_ALL_ON", master);
      for (const v of VALUES)
        expect(studioFlag(v)).toBe(
          v === "true" || (master === "true" && v !== "false"),
        );
    }
  });
});

describe("the master's table and the strict table", () => {
  it("no flag is in both", () => {
    expect(GOVERNANCE_NAMES.filter((f) => FLAG_NAMES.includes(f))).toEqual([]);
  });
});

describe("the value flags do not move under the master (ADI-S20-GO)", () => {
  /** What each value flag reads, as one comparable string. */
  const read = () => ({
    STUDIO_PUBLISH_MODE: publishMode(),
    STUDIO_MAX_JOB_USD: maxJobUsd(),
    STUDIO_MAX_DAY_USD: maxDayUsd(),
    STUDIO_ENRICH_DAILY_CAP_USD: enrichDailyCapUsd(),
    STUDIO_VIDEO_ENRICH_MAX_RUN_USD: videoEnrichMaxRunUsd(),
  });

  it.each(VALUE_FLAGS)(
    "a value flag does not move under the master: %s",
    (name) => {
      // Unset, a boolean-looking value, and a real value — each must read the same with the master on.
      for (const v of [undefined, "true", "false", "dry", "live", "7"]) {
        setVar(name, v);
        setVar("STUDIO_ALL_ON", undefined);
        const off = read()[name as keyof ReturnType<typeof read>];
        process.env.STUDIO_ALL_ON = "true";
        const on = read()[name as keyof ReturnType<typeof read>];
        expect({ name, value: v ?? "unset", read: on }).toEqual({
          name,
          value: v ?? "unset",
          read: off,
        });
      }
    },
  );

  it("with the master on and every value flag unset, publishing is off and the caps are the code defaults", () => {
    process.env.STUDIO_ALL_ON = "true";
    expect(read()).toEqual({
      STUDIO_PUBLISH_MODE: "off",
      STUDIO_MAX_JOB_USD: 10,
      STUDIO_MAX_DAY_USD: 25,
      STUDIO_ENRICH_DAILY_CAP_USD: null,
      STUDIO_VIDEO_ENRICH_MAX_RUN_USD: 2,
    });
  });
});

describe("the governance flags never move under the master", () => {
  for (const flag of GOVERNANCE_NAMES) {
    for (const master of [undefined, "true"] as const) {
      for (const v of VALUES) {
        const expected = v === "true";
        it(`${flag} ${show(v)} with the master ${master ? "on" : "unset"} reads ${expected ? "on" : "off"}`, () => {
          setVar("STUDIO_ALL_ON", master);
          setVar(flag, v);
          expect(GOVERNANCE_FLAGS[flag]()).toBe(expected);
        });
      }
    }
  }

  it("the helper itself: exactly === \"true\", whatever the master says", () => {
    process.env.STUDIO_ALL_ON = "true";
    expect(studioGovernanceFlag(undefined)).toBe(false);
    expect(studioGovernanceFlag("1")).toBe(false);
    expect(studioGovernanceFlag("TRUE")).toBe(false);
    expect(studioGovernanceFlag("true")).toBe(true);
  });
});

describe("the census: every boolean Studio read goes through the master, and the table names them all", () => {
  const STUDIO_DIR = __dirname;
  const sources: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        sources.push({
          path: relative(STUDIO_DIR, full),
          text: readFileSync(full, "utf8"),
        });
    }
  };
  walk(STUDIO_DIR);

  it("reads a real source tree (a walk that found nothing would pass everything below)", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('no boolean STUDIO_* flag is read with a bare === "true" outside the helper', () => {
    const bare = sources
      .filter((s) => s.path !== "studioFlag.ts")
      .flatMap((s) =>
        [
          ...s.text.matchAll(
            /process\.env\.(STUDIO_[A-Z0-9_]+)\s*===\s*"true"/g,
          ),
        ].map((m) => `${s.path}: ${m[1]}`),
      );
    expect(bare).toEqual([]);
  });

  it("the flags read through the helper are exactly the table's thirty-one", () => {
    // The helper's own file is left out: its doc comment shows the call shape with a placeholder name.
    const through = [
      ...new Set(
        sources
          .filter((s) => s.path !== "studioFlag.ts")
          .flatMap((s) =>
            [
              ...s.text.matchAll(
                /studioFlag\(\s*process\.env\.(STUDIO_[A-Z0-9_]+)\s*,?\s*\)/g,
              ),
            ].map((m) => m[1]),
          ),
      ),
    ].sort();
    expect(FLAG_NAMES).toHaveLength(31);
    expect(through).toEqual(FLAG_NAMES);
  });

  it("every governance flag reads through the governance helper, and none through the master", () => {
    const strict = [
      ...new Set(
        // The helper's own file is left out: its doc comment shows the call shape with a placeholder name.
        sources
          .filter((s) => s.path !== "studioFlag.ts")
          .flatMap((s) =>
            [...s.text.matchAll(/studioGovernanceFlag\(\s*process\.env\.(STUDIO_[A-Z0-9_]+)\s*,?\s*\)/g)].map((m) => m[1]),
          ),
      ),
    ].sort();
    expect(strict).toEqual(GOVERNANCE_NAMES);
    const underMaster = sources.flatMap((s) =>
      GOVERNANCE_NAMES.filter((f) => new RegExp(`studioFlag\\(\\s*process\\.env\\.${f}\\b`).test(s.text)).map((f) => `${s.path}: ${f}`),
    );
    expect(underMaster).toEqual([]);
  });

  it("no value flag is ever read through the helper", () => {
    const wired = sources.flatMap((s) =>
      VALUE_FLAGS.filter((f) =>
        new RegExp(`studioFlag\\(\\s*process\\.env\\.${f}\\b`).test(s.text),
      ).map((f) => `${s.path}: ${f}`),
    );
    expect(wired).toEqual([]);
  });
});
