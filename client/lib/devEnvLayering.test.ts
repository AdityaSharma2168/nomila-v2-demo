/**
 * devEnvLayering.test.ts — a client flag as the DEV BUNDLE resolves it, not as a test passes it (PR 15.1).
 *
 * ─── WHY THIS EXISTS (docs/probes/composer-boundary.md, "P-join — failed live") ──────────────────
 *
 * Every composer test handed the flag in as a literal, and every one was green, while the app Adi
 * walked had the composer OFF: the committed `.env.development` carried
 * `EXPO_PUBLIC_STUDIO_COMPOSER=false`, and Expo layers `.env` → `.env.development` → `.env.local` →
 * `.env.development.local` with the LATER file winning — so the committed `false` silently outranked the
 * `true` in her own `.env`, and the Board never sent the composer's record (stitch e8759769, 24 Sep 2026).
 * The value was lost between the config and the code, the layer no test crossed.
 *
 * So this resolves the flag the way the app does, with Expo's own code, over a fixture `.env` that turns
 * it on plus the repo's COMMITTED `.env.development` exactly as it is:
 *   - the dev bundle: the merge order `@expo/metro-config` writes into `expo/virtual/env` (read out of its
 *     transform worker, not retyped here) and its own per-file parser;
 *   - the Metro process / production inlining: `@expo/env`'s `parseProjectEnv` in development mode;
 * and then reads `client/lib/flags.ts`'s constant under the resolved value — the boolean the Board reads.
 * The developer's real `.env` is never read: the fixture directory holds the two files and nothing else.
 *
 * ⚠️ MUTATION: put `EXPO_PUBLIC_STUDIO_COMPOSER=false` back in `.env.development` (main before PR 15.1)
 * — "the Board's composer flag resolves off in the dev bundle while .env turns it on" reds by name.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectEnv } from "@expo/env";
import { parseEnvFile } from "@expo/metro-config/build/transform-worker/dot-env-development";

const ROOT = join(__dirname, "..", "..");
const FLAG = "EXPO_PUBLIC_STUDIO_COMPOSER";

/**
 * The order the dev bundle merges the `.env*` files in, read from the transform worker that writes the
 * `expo/virtual/env` module — so an Expo upgrade that changes it changes this test's input, and one that
 * moves it fails here by name rather than passing on a stale copy.
 */
function bundleMergeOrder(): string[] {
  const worker = readFileSync(
    require.resolve(
      "@expo/metro-config/build/transform-worker/transform-worker.js",
    ),
    "utf8",
  );
  const m = worker.match(/\.\.\.\[((?:'\.env[^']*',?\s*)+)\]\.reduce/);
  if (!m)
    throw new Error(
      "the dev bundle's .env merge moved in @expo/metro-config — re-read transform-worker.js",
    );
  return m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
}

/** A project directory holding a fixture `.env` and `.env.development` (the repo's, unless given). */
function project(envDevelopment?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "env-layering-"));
  // Her own .env turns the composer on — the line Adi had at .env:81.
  writeFileSync(join(dir, ".env"), `${FLAG}=true\n`);
  if (envDevelopment !== undefined)
    writeFileSync(join(dir, ".env.development"), envDevelopment);
  else
    copyFileSync(join(ROOT, ".env.development"), join(dir, ".env.development"));
  return dir;
}

/** What `expo/virtual/env` exports in a dev bundle for this project (transform-worker.js). */
function devBundleEnv(dir: string): Record<string, string> {
  return bundleMergeOrder().reduce<Record<string, string>>((acc, file) => {
    const path = join(dir, file);
    return existsSync(path)
      ? { ...acc, ...parseEnvFile(readFileSync(path, "utf8"), true) }
      : acc;
  }, {});
}

/** `client/lib/flags.ts`'s STUDIO_COMPOSER with the env var set to `value`, loaded fresh. */
function boardFlagUnder(value: string | undefined): boolean {
  // Static access, as flags.ts itself reads it (expo/no-dynamic-env-var).
  const prev = process.env.EXPO_PUBLIC_STUDIO_COMPOSER;
  if (value === undefined) delete process.env.EXPO_PUBLIC_STUDIO_COMPOSER;
  else process.env.EXPO_PUBLIC_STUDIO_COMPOSER = value;
  try {
    let flag = false;
    jest.isolateModules(() => {
      flag = (require("./flags") as typeof import("./flags")).STUDIO_COMPOSER;
    });
    return flag;
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_STUDIO_COMPOSER;
    else process.env.EXPO_PUBLIC_STUDIO_COMPOSER = prev;
  }
}

describe("client flags as Expo resolves them in development (PR 15.1)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("the Board's composer flag resolves off in the dev bundle while .env turns it on — never: the committed .env.development leaves her .env in charge", () => {
    const dir = project();
    dirs.push(dir);
    // The dev bundle (what the Board reads at runtime in development).
    const bundled = devBundleEnv(dir)[FLAG];
    expect(bundled).toBe("true");
    expect(boardFlagUnder(bundled)).toBe(true);
    // Expo's own loader (the Metro process; what a production build inlines from).
    const loaded = parseProjectEnv(dir, { mode: "development", silent: true })
      .env[FLAG];
    expect(loaded).toBe("true");
  });

  it("the harness can see an override: a .env.development that sets it false wins over .env, in both layerings", () => {
    const dir = project(`${FLAG}=false\n`);
    dirs.push(dir);
    expect(bundleMergeOrder().indexOf(".env.development")).toBeGreaterThan(
      bundleMergeOrder().indexOf(".env"),
    );
    expect(devBundleEnv(dir)[FLAG]).toBe("false");
    expect(boardFlagUnder(devBundleEnv(dir)[FLAG])).toBe(false);
    expect(
      parseProjectEnv(dir, { mode: "development", silent: true }).env[FLAG],
    ).toBe("false");
  });

  it("and with the flag nowhere, the Board's composer is off — the default is the flag's, not a file's", () => {
    expect(boardFlagUnder(undefined)).toBe(false);
  });
});

/**
 * ─── EVERY STUDIO FLAG, PINNED ON (image-parity; Adi's ruling ADI-GO-IP, 24 Sep 2026) ───────────────────────
 *
 * Dev is all-on by design: the committed `.env.development` pins every client Studio flag `=true`, and a
 * flag-off walk goes in the worktree's `.env.local`, which outranks it. The house rule: an
 * `EXPO_PUBLIC_STUDIO_*` line in `.env.development` is `=true` only, never `=false` — a committed `false`
 * silently outranks every developer's `.env` (the PR 15.1 lesson above).
 *
 * The flag list is read from `client/lib/flags.ts` itself (the dot form, as `tools/expo-flags/list-expo-flags.sh`
 * reads it), so a new flag joins these tests without anyone listing it — and its count is pinned, so a
 * reader that silently matched nothing is red rather than vacuously green.
 *
 * ⚠️ MUTATIONS (docs/probes/image-parity.md): set one pin to `=false` (M-env) — "every EXPO_PUBLIC_STUDIO_* line
 * … is =true" and "every flag … resolves on" red, naming the key; delete one pin (M-env3) — "every flag
 * flags.ts reads has a =true pin" reds, naming the flag.
 *
 * PR 20 (ADI-S20-GO): the MASTER, `EXPO_PUBLIC_STUDIO_ALL_ON`, is read in flags.ts too but is not a flag with a pin —
 * `.env.development` is left alone and never carries it (the block below pins that). It is left out of this list by name.
 */
const MASTER = "EXPO_PUBLIC_STUDIO_ALL_ON";
const STUDIO_FLAGS = [
  ...new Set(
    [
      ...readFileSync(join(__dirname, "flags.ts"), "utf8").matchAll(
        /process\.env\.(EXPO_PUBLIC_STUDIO_[A-Z0-9_]+)/g,
      ),
    ].map((m) => m[1]),
  ),
]
  .filter((f) => f !== MASTER)
  .sort();

/** The committed `.env.development`, as the dev bundle's own parser reads it. */
const committedDevEnv = (): Record<string, string> =>
  parseEnvFile(readFileSync(join(ROOT, ".env.development"), "utf8"), true);

describe("every client Studio flag is pinned on in .env.development (ADI-GO-IP)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("reads the seventeen flags client/lib/flags.ts declares (PR 19 adds STUDIO_IMAGE_OPS)", () => {
    expect(STUDIO_FLAGS).toHaveLength(17);
  });

  it("every EXPO_PUBLIC_STUDIO_* line in .env.development is =true — never =false", () => {
    const notTrue = Object.entries(committedDevEnv())
      .filter(([k, v]) => k.startsWith("EXPO_PUBLIC_STUDIO_") && v !== "true")
      .map(([k, v]) => `${k}=${v}`);
    expect(notTrue).toEqual([]);
  });

  it.each(STUDIO_FLAGS)(
    "every flag resolves on in the dev bundle and Expo's loader, over a .env that turns it on: %s",
    (flag) => {
      const dir = mkdtempSync(join(tmpdir(), "env-layering-"));
      dirs.push(dir);
      writeFileSync(join(dir, ".env"), `${flag}=true\n`);
      copyFileSync(
        join(ROOT, ".env.development"),
        join(dir, ".env.development"),
      );
      expect(devBundleEnv(dir)[flag]).toBe("true");
      expect(
        parseProjectEnv(dir, { mode: "development", silent: true }).env[flag],
      ).toBe("true");
    },
  );

  it("every flag flags.ts reads has a =true pin in .env.development — a new flag without one fails by name", () => {
    const env = committedDevEnv();
    expect(STUDIO_FLAGS.filter((f) => env[f] !== "true")).toEqual([]);
  });
});

/**
 * ─── THE MASTER AND THE COMMITTED FILE (PR 20, ADI-S20-GO) ────────────────────────────────────────────────────
 *
 * `.env.development` is left alone: it never carries `EXPO_PUBLIC_STUDIO_ALL_ON`, so a developer's master in her own
 * `.env` is never outranked by a committed value — the same lesson as the composer's `false` above, one level up.
 */
describe("the client master and .env.development (ADI-S20-GO)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("the committed .env.development never carries the master", () => {
    expect(Object.keys(committedDevEnv()).filter((k) => k === MASTER)).toEqual(
      [],
    );
  });

  it("a master in her .env resolves on through the committed .env.development, in both layerings, and turns an unpinned flag on", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-layering-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), `${MASTER}=true\n`);
    copyFileSync(join(ROOT, ".env.development"), join(dir, ".env.development"));
    expect(devBundleEnv(dir)[MASTER]).toBe("true");
    expect(
      parseProjectEnv(dir, { mode: "development", silent: true }).env[MASTER],
    ).toBe("true");

    // flags.ts under that resolved master with the composer's own variable unset: on (static access, as flags.ts reads it).
    const prev = [
      process.env.EXPO_PUBLIC_STUDIO_ALL_ON,
      process.env.EXPO_PUBLIC_STUDIO_COMPOSER,
    ] as const;
    process.env.EXPO_PUBLIC_STUDIO_ALL_ON = devBundleEnv(dir)[MASTER];
    delete process.env.EXPO_PUBLIC_STUDIO_COMPOSER;
    try {
      let flag = false;
      jest.isolateModules(() => {
        flag = (require("./flags") as typeof import("./flags")).STUDIO_COMPOSER;
      });
      expect(flag).toBe(true);
    } finally {
      if (prev[0] === undefined) delete process.env.EXPO_PUBLIC_STUDIO_ALL_ON;
      else process.env.EXPO_PUBLIC_STUDIO_ALL_ON = prev[0];
      if (prev[1] === undefined) delete process.env.EXPO_PUBLIC_STUDIO_COMPOSER;
      else process.env.EXPO_PUBLIC_STUDIO_COMPOSER = prev[1];
    }
  });
});
