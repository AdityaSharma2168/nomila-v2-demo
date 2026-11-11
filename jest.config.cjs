/**
 * Project unit tests (server-side). Scoped to server/ so it never walks
 * node_modules. Uses ts-jest in CJS. Two kinds of suites:
 *  - pure-logic tests (dealScoreGrid, withTimeout) with no dependencies
 *  - db-backed tests that jest.mock server/db with an in-memory Postgres
 *    (PGlite via server/testUtils/pgliteDb.ts) — real SQL, no Cloud SQL,
 *    with network boundaries (Gmail API, Kimi, auth) mocked per suite.
 * The moduleNameMapper strips ".js" from relative specifiers so the runtime
 * dynamic imports (await import("./x.js")) resolve to the .ts sources.
 * The inline tsconfig override adds the jest/node ambient types (the app
 * tsconfig doesn't list them).
 */
/**
 * ─── TWO PROJECTS, AND WHY THE SPLIT EXISTS (video V4) ──────────────────────────────────────
 *
 * Until V4 there was one project and one extension: `.test.ts`, `testEnvironment: "node"`, every
 * client suite pure logic. That is why the comment above can say client suites "cost seconds".
 *
 * Mounting a component or a hook needs React Native's own Jest environment — its resolver, its
 * native-module mocks, its `__DEV__`. Loading that for all 341 server suites to serve the handful
 * that render would tax every one of them for nothing. `projects` is how Jest says "these files
 * run under those rules": a `.test.ts` is routed to `node` and resolves exactly as it did before
 * this commit, and only a `.test.tsx` pays for the renderer.
 *
 * SCOPED, DELIBERATELY. This adds the capability and V4 uses it. The fourteen existing client
 * suites stay pure-logic `.test.ts` and are NOT retrofitted.
 *
 * scripts/testRunner/discovery.ts already globbed `.test.tsx` "defensively" (TEST_FILE_RE), so
 * such a file was DISCOVERED, handed to Jest, and then matched nothing. The two agree now.
 */

const { esmCjsMapper, clientChatMapper } = require("./scripts/jest-esm-cjs.cjs");

/** What both projects share. Everything here behaved this way before the split. */
const shared = {
  // NOTE: `testTimeout` deliberately does NOT live here. It is a GLOBAL-config option — see the
  // comment on it below — and for the fortnight it sat in this object it did nothing at all.
  roots: ["<rootDir>/server", "<rootDir>/scripts", "<rootDir>/client"],
  testPathIgnorePatterns: ["/node_modules/"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};

module.exports = {
  // Each db-backed suite boots its own in-memory Postgres (WASM); cap parallel
  // workers so peak memory stays sane on small CI boxes.
  maxWorkers: "50%",
  // ⚠️  TOP LEVEL ON PURPOSE, AND IT IS NOT A STYLE CHOICE. jest-circus reads this off the GLOBAL
  // config and nowhere else (jest-circus/build/jestAdapterInit.js: `if (globalConfig.testTimeout)
  // { getState().testTimeout = globalConfig.testTimeout }`). A value inside a `projects[]` entry
  // lands in that PROJECT's config, which nothing consults for this — `--showConfig` will happily
  // print `120000` under both projects while `globalConfig.testTimeout` is undefined and every
  // suite in the repo runs on jest's 5s default. That is exactly what happened between the V4
  // projects split and this commit. If it ever needs to move again, verify with:
  //   npx jest --config jest.config.cjs --showConfig | grep -A2 '"globalConfig"'
  //
  // Why 120s rather than the default (restoring the rationale the split deleted): a db-backed
  // beforeAll regenerates the whole schema through drizzle-kit and boots a WASM Postgres, and the
  // retry paths deliberately sleep between attempts. At 5s that is marginal for every db-backed
  // suite — different ones fail on different runs, and a test cut off mid-await keeps running and
  // corrupts the NEXT test's counters. PGlite boot gets slower the deeper into a batch it happens:
  // chat.profile.test.ts once exceeded 30s in beforeAll, 35s into the 32-suite server/routes batch.
  // Suites that need more than this still say so locally (jest.setTimeout), and those still win.
  testTimeout: 120_000,
  projects: [
    {
      ...shared,
      displayName: "node",
      testEnvironment: "node",
      // The platform day spend total reads 0 unless a suite installs its own reader (server/testUtils/platformSpendSetup.ts).
      setupFiles: ["<rootDir>/server/testUtils/platformSpendSetup.ts"],
      // Unchanged: `tsx?` became `ts` only because `.test.tsx` now belongs to the other project.
      testMatch: ["**/*.test.ts"],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
      },
      // The ESM-only packages the Mastra engine loads (AI SDK, `chat`) as CommonJS copies: Jest's CommonJS runtime
      // cannot require ESM before Node 24.9 (scripts/jest-esm-cjs.cjs says why and how).
      // The app's chat transport (client/components/mila/thread/api.ts) too, for the chat v2 contract test.
      moduleNameMapper: { ...shared.moduleNameMapper, ...esmCjsMapper(), ...clientChatMapper("node") },
    },
    {
      ...shared,
      displayName: "react-native",
      // Brings RN's resolver, its `testEnvironment`, and the setup file that defines `__DEV__`
      // and mocks the native modules `View` reaches for at import time. Everything below
      // overrides one piece of it; nothing replaces it wholesale.
      // RN 0.86 (Expo SDK 57) moved the preset out of `react-native` into its own package;
      // react-native/jest-preset.js is now a stub that re-exports it. Named directly.
      preset: "@react-native/jest-preset",
      // ⚠️ THE PRESET'S OWN `testEnvironment` IS NOT USABLE HERE. The preset ships
      // `jest/react-native-env.js` written against Jest 29's `jest-mock`; under this repo's
      // Jest 30 it dies before the first test with `this._moduleMocker.clearMocksOnScope is not
      // a function`. Plain "node" is what the rest of the repo already runs on, and the parts of
      // the preset that matter — the resolver and the setup file — are kept.
      // `babel-jest` and `jest-environment-node` are explicit devDependencies for the same reason:
      // the separate preset package depends on their Jest 29 builds, and without the pins npm
      // hoists those to the top, so "node" (for BOTH projects) resolved to the Jest 29 env.
      testEnvironment: "node",
      /*
       * ⚠️  BOTH ENTRIES, AND INSIDE THIS PROJECT ONLY.
       *
       * The preset already supplies `setupFiles: [@react-native/jest-preset/jest/setup.js]`, and a
       * `setupFiles` written here REPLACES the preset's rather than extending it — so listing only
       * the gesture-handler entry would drop `__DEV__` and RN's native-module mocks.
       *
       * The gesture-handler entry is what registers `RNGestureHandlerModule`. Without it any suite
       * that imports the library dies at IMPORT with "'RNGestureHandlerModule' could not be found",
       * before a single test runs — which is how the timeline's scrub and drag are testable through
       * the real `Gesture.Pan` rather than through a mock asserting a handler was called.
       *
       * It stays inside `projects[]` because `setupFiles` IS a project-level option. That is the
       * opposite of `testTimeout` below, which jest-circus reads off the GLOBAL config only — a key
       * that looked project-level and silently did nothing for a fortnight (#523). Do not move
       * either one to the other's place.
       */
      setupFiles: [
        require.resolve("@react-native/jest-preset/jest/setup.js"),
        require.resolve("react-native-gesture-handler/jestSetup.js"),
        // expo-image renders as react-native's Image under jest (client/test/expoImageMock.js).
        require.resolve("./client/test/expoImageMock.js"),
        // Expo SDK 57 installs its WinterCG globals lazily; they are read in scope here, and fetch stays
        // React Native's polyfill (client/test/expoWinterInJest.js says why).
        require.resolve("./client/test/expoWinterInJest.js"),
      ],
      testMatch: ["**/*.test.tsx"],
      // react-native-worklets 0.10 (Expo SDK 57) ships ESM only: its `main` is lib/module, under a
      // `"type": "module"` package.json, and Jest's CommonJS runtime cannot require that before
      // Node 24.9 (nor hand it to a transform). Its real sources reach for the native module at
      // import, so every suite gets the package's own Jest mock instead (a CommonJS-shaped .ts
      // file ts-jest compiles like ours) — the setup the Worklets docs give for Jest. It covers
      // what reanimated's mock imports and what our code calls (scheduleOnRN runs the callback
      // on a microtask, as runOnJS did).
      moduleNameMapper: {
        ...shared.moduleNameMapper,
        "^react-native-worklets$": "<rootDir>/node_modules/react-native-worklets/src/mock",
        // Mila's chat v2 module (client/components/mila/thread): assistant-ui, its AI SDK runtime, @ai-sdk/react and `ai`
        // ship ESM only, for the same reason as above. One CommonJS bundle of the four, so they share one copy of their
        // module state (scripts/jest-esm-cjs.cjs, clientChatMapper, says why and how).
        ...clientChatMapper(),
      },
      transform: {
        // Our own TypeScript still compiles with ts-jest, so a `.tsx` suite and a `.ts` suite
        // read the same sources the same way. `.tsx` FIRST — Jest takes the first pattern that
        // matches, and `tsx?` would swallow it. The only difference between the two tsconfigs
        // is `jsx`; see tsconfig.jest.tsx.json for why that one line has to exist.
        "^.+\\.tsx$": ["ts-jest", { tsconfig: "tsconfig.jest.tsx.json" }],
        "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
        // Everything arriving from node_modules. React Native ships Flow, its Expo neighbours
        // ship ESM, and ts-jest will read neither — so that JS goes through babel with the
        // preset the app already builds with. `babel-preset-expo` is already installed,
        // transitively via expo: no new dependency for this line.
        "^.+\\.[cm]?jsx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
      },
      // RN's preset allows `react-native` and `@react-native*` through. This adds the packages a
      // Studio screen actually touches — navigation, the Expo modules, and the renderer itself.
      // It applies to THIS project only, so no server suite's resolution changes.
      transformIgnorePatterns: [
        "node_modules/(?!(?:jest-)?react-native|@react-native|@react-navigation|expo|@expo|expo-modules-core|react-native-.*|@testing-library)",
      ],
    },
  ],
};
