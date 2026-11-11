/**
 * scripts/jest-esm-cjs.cjs — TESTS ONLY: CommonJS copies of the ESM-only packages the Mastra engine loads, for Jest.
 *
 * WHY: the Mastra engine (server/agent/engine/mastra) loads the AI SDK (@ai-sdk/*) and `chat`, which ship ESM only.
 * Node itself runs them (require(esm) is on by default since Node 22.12; the server runs on Node 22.22), but Jest's
 * CommonJS runtime can only require ESM on Node >= 24.9, and a package marked "type": "module" is never handed to a
 * transform. So, once per Jest start, each package's own files are compiled to one CommonJS file with esbuild
 * (`packages: "external"`: its dependencies stay require() calls, so the copies point at each other and nothing is
 * duplicated), under node_modules/.cache/jest-esm-cjs, and jest.config.cjs maps the package names there.
 * Rebuilt only when the installed version changes. The server build and runtime never use these files.
 */
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "node_modules", ".cache", "jest-esm-cjs");

/** ESM-only packages reached through require() from @mastra/* CommonJS builds (or our own engine code). */
const PACKAGES = ["@ai-sdk/provider-utils-v7", "@ai-sdk/provider-v7", "@ai-sdk/provider-utils", "@ai-sdk/provider", "@ai-sdk/openai", "chat", "@workflow/serde"];

const fileFor = (pkg) => join(OUT, `${pkg.replace(/[@/]/g, "_")}.cjs`);

function esmEntry(pkg) {
  const dir = join(ROOT, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const dot = manifest.exports?.["."];
  const rel = typeof dot === "string" ? dot : dot?.import?.default ?? dot?.import ?? dot?.default ?? manifest.module ?? manifest.main;
  return { entry: join(dir, rel), version: manifest.version };
}

/** Build (when stale) and return Jest moduleNameMapper entries for every package that is installed. */
function esmCjsMapper() {
  const map = {};
  for (const pkg of PACKAGES) {
    if (!existsSync(join(ROOT, "node_modules", pkg, "package.json"))) continue;
    const { entry, version } = esmEntry(pkg);
    const out = fileFor(pkg);
    const stamp = `${out}.version`;
    if (!existsSync(out) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== version) {
      mkdirSync(OUT, { recursive: true });
      require("esbuild").buildSync({ entryPoints: [entry], outfile: out, bundle: true, packages: "external", format: "cjs", platform: "node", target: "node22", logLevel: "error" });
      writeFileSync(stamp, version);
    }
    map[`^${pkg.replace(/[/]/g, "\\/")}$`] = out;
  }
  return map;
}

/**
 * The app's chat stack (client/components/mila/thread, EXPO_PUBLIC_MILA_THREAD_V2): assistant-ui's React Native
 * primitives, its AI SDK runtime, `@ai-sdk/react` and `ai`. All ESM only, and they share module state (assistant-ui's
 * store contexts, the AI SDK's chat classes), so they are compiled together into ONE CommonJS bundle, not one file per
 * package: two copies of @assistant-ui/store would be two React contexts, and the primitives would not see the runtime.
 * React (and React Native) stay require() calls, so the suite's own copies — and RN's Jest mocks — are the ones used.
 * Each package name maps to a two-line shim that hands out its namespace from the bundle.
 *
 * Staleness: unlike the per-package copies above (dependencies left external), this bundle INLINES the packages'
 * dependencies (@assistant-ui/core, store, tap, assistant-stream, @ai-sdk/provider-utils …). So it is keyed on the
 * lockfile and this script as well as the four versions: a lockfile change that moves only a transitive dependency
 * rebuilds it too, instead of tests running yesterday's copy. The bundle is written to a temp file and renamed into
 * place, so a second Jest starting at the same moment never reads a half-written file.
 *
 * On a library upgrade: the bundle rebuilds by itself; what can break is a package changing its export conditions or
 * starting to need a module that only Metro provides — then the build fails loudly at Jest start (never silently).
 *
 *   "react-native" (the React Native project): built the way Metro builds the app — the "react-native" export condition
 *                  first, so @assistant-ui/ai-sdk resolves to its index.native.
 *   "node" (the node project): the transport side only (@assistant-ui/ai-sdk, @ai-sdk/react, ai), for the contract test
 *                  that reads the real chat v2 route's bytes with the app's own parser (server/routes/chatV2.client.db.test.ts).
 * Rebuilt when any of the packages' versions changes.
 */
const CLIENT_CHAT_PACKAGES = ["@assistant-ui/react-native", "@assistant-ui/ai-sdk", "@ai-sdk/react", "ai"];
const CHAT_FLAVORS = {
  "react-native": {
    packages: CLIENT_CHAT_PACKAGES,
    esbuild: {
      platform: "neutral",
      mainFields: ["react-native", "module", "main"],
      conditions: ["react-native", "browser", "import", "module", "default"],
      external: ["react", "react/*", "react-dom", "react-dom/*", "react-native", "react-native/*"],
    },
  },
  node: {
    packages: ["@assistant-ui/ai-sdk", "@ai-sdk/react", "ai"],
    esbuild: { platform: "node", conditions: ["node", "import", "default"], external: ["react", "react/*", "react-dom", "react-dom/*"] },
  },
};

function clientChatMapper(flavor = "react-native") {
  const { packages, esbuild } = CHAT_FLAVORS[flavor];
  const installed = packages.filter((pkg) => existsSync(join(ROOT, "node_modules", pkg, "package.json")));
  if (!installed.length) return {};
  const versions = installed.map((pkg) => `${pkg}@${JSON.parse(readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf8")).version}`).join(" ");
  const lock = join(ROOT, "package-lock.json");
  const hash = createHash("sha256")
    .update(existsSync(lock) ? readFileSync(lock) : "")
    .update(readFileSync(__filename))
    .update(JSON.stringify(esbuild))
    .digest("hex")
    .slice(0, 16);
  const version = `${versions} ${hash}`;
  const dir = join(OUT, flavor === "react-native" ? "client-chat" : `client-chat-${flavor}`);
  const bundle = join(dir, "bundle.cjs");
  const stamp = `${bundle}.version`;
  const shimFor = (pkg) => join(dir, `${pkg.replace(/[@/]/g, "_")}.cjs`);
  if (!existsSync(bundle) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== version) {
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, "entry.mjs");
    writeFileSync(entry, installed.map((pkg, i) => `export * as m${i} from ${JSON.stringify(pkg)};`).join("\n") + "\n");
    const tmp = `${bundle}.${process.pid}.tmp`;
    require("esbuild").buildSync({
      entryPoints: [entry],
      outfile: tmp,
      bundle: true,
      format: "cjs",
      nodePaths: [join(ROOT, "node_modules")],
      target: "node22",
      logLevel: "error",
      ...esbuild,
    });
    renameSync(tmp, bundle);
    installed.forEach((pkg, i) => {
      writeFileSync(shimFor(pkg), `"use strict";\nmodule.exports = require("./bundle.cjs").m${i};\n`);
    });
    writeFileSync(stamp, version);
  }
  return Object.fromEntries(installed.map((pkg) => [`^${pkg.replace(/[/]/g, "\\/")}$`, shimFor(pkg)]));
}

module.exports = { esmCjsMapper, clientChatMapper, PACKAGES, CLIENT_CHAT_PACKAGES };
