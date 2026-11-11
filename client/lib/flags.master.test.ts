/**
 * flags.master.test.ts — the client twin of server/studio/studioFlag.test.ts (PR 20, docs/probes/ship.md, ADI-S20-GO).
 *
 * `client/lib/flags.ts` is loaded fresh under each environment, exactly as a bundle evaluates it once at start:
 *   MASTER UNSET — every Studio flag is byte-identical to its own `=== "true"`, for unset / "true" / "false" / "1" / "TRUE",
 *     and a master that is anything but exactly "true" is unset;
 *   MASTER ON — every Studio flag reads on unless its own variable is exactly "false";
 *   and the master never reaches the flag that is not Studio's (IDENTITY_CLAIM).
 * The census reads flags.ts itself: every EXPO_PUBLIC_STUDIO_* but the master passes its literal read through studioFlag.
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, item 1): M-cmaster — studioFlag ignores the master (`allOn &&` → `false &&`):
 * the "under the master" rows red by name. M-cunset — studioFlag treats unset as on without it: the "master unset" rows
 * for an unset variable red by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Flags = typeof import("./flags");

const SOURCE = readFileSync(join(__dirname, "flags.ts"), "utf8");
const MASTER = "EXPO_PUBLIC_STUDIO_ALL_ON";

/** The export name each Studio flag's variable feeds, read off flags.ts: `export const X =\n studioFlag(process.env.V)`. */
const EXPORT_OF: Record<string, string> = Object.fromEntries(
  [
    ...SOURCE.matchAll(
      /export const (STUDIO_[A-Z0-9_]+)\s*=\s*studioFlag\(\s*process\.env\.(EXPO_PUBLIC_STUDIO_[A-Z0-9_]+)\s*,?\s*\)/g,
    ),
  ].map((m) => [m[2], m[1]]),
);
const VARS = Object.keys(EXPORT_OF).sort();

const VALUES = [undefined, "true", "false", "1", "TRUE"] as const;
const OTHERS = ["EXPO_PUBLIC_IDENTITY_CLAIM"];
const TOUCHED = [MASTER, ...VARS, ...OTHERS];

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

/** flags.ts evaluated fresh under the given variables — what a bundle built with them would hold. */
function load(env: Record<string, string | undefined>): Flags {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod!: Flags;
  jest.isolateModules(() => {
    mod = require("./flags") as Flags;
  });
  return mod;
}
const flagOf = (mod: Flags, v: string) =>
  (mod as unknown as Record<string, boolean>)[EXPORT_OF[v]];

const ROWS = VARS.flatMap((v) => VALUES.map((x) => [v, x] as const));

describe("the census: flags.ts reads every Studio flag through the master", () => {
  it("seventeen Studio flags, each its literal variable passed into studioFlag", () => {
    expect(VARS).toHaveLength(17);
    const all = [
      ...new Set(
        [
          ...SOURCE.matchAll(/process\.env\.(EXPO_PUBLIC_STUDIO_[A-Z0-9_]+)/g),
        ].map((m) => m[1]),
      ),
    ].sort();
    expect(all.filter((v) => v !== MASTER)).toEqual(VARS);
  });

  it('no Studio flag is read with a bare === "true" — only the master itself', () => {
    const bare = [
      ...SOURCE.matchAll(
        /process\.env\.(EXPO_PUBLIC_STUDIO_[A-Z0-9_]+)\s*===\s*"true"/g,
      ),
    ].map((m) => m[1]);
    expect(bare).toEqual([MASTER]);
  });
});

describe('the client master unset: every Studio flag is byte-identical to its own === "true"', () => {
  it.each(ROWS)('master unset: %s=%s reads exactly === "true"', (v, x) => {
    expect(flagOf(load({ [v]: x }), v)).toBe(x === "true");
  });

  it.each(["1", "TRUE", "false", "yes", ""])(
    "a master of %p is not the master: every flag, every value, byte-identical",
    (master) => {
      const wrong = ROWS.filter(([v, x]) => {
        const got = flagOf(load({ [MASTER]: master, [v]: x }), v);
        delete process.env[v];
        return got !== (x === "true");
      }).map(([v, x]) => `${v}=${x ?? "unset"}`);
      expect(wrong).toEqual([]);
    },
  );
});

describe('under the client master: every Studio flag is on unless exactly "false"', () => {
  it.each(ROWS)(
    'under the master: %s=%s reads on unless exactly "false"',
    (v, x) => {
      expect(flagOf(load({ [MASTER]: "true", [v]: x }), v)).toBe(x !== "false");
    },
  );

  it("the master never reaches the flags that are not Studio's", () => {
    const mod = load({ [MASTER]: "true" });
    expect({
      IDENTITY_CLAIM: mod.IDENTITY_CLAIM,
    }).toEqual({
      IDENTITY_CLAIM: false,
    });
  });
});
