#!/usr/bin/env node
/**
 * eas-profile-env.cjs — one eas.json build profile's `env`, as KEY=VALUE lines for $GITHUB_ENV (PR 20,
 * docs/probes/ship.md item 2, ADI-S20-GO "fewest places to flip").
 *
 * WHY: a client flag is inlined at bundle time, so every bundle of an environment has to be built with the same
 * EXPO_PUBLIC_* values — the installed binary (eas.json → build.<profile>.env), its OTA update, and the web export.
 * Until PR 20 each OTA step repeated its profile's env as literal lines under a "MUST match eas.json" comment, and the
 * web steps set their own. With this, eas.json is the one place per environment:
 *
 *   node scripts/eas-profile-env.cjs production >> "$GITHUB_ENV"                              # the OTA: the whole profile
 *   node scripts/eas-profile-env.cjs production --prefix EXPO_PUBLIC_STUDIO_ >> "$GITHUB_ENV"  # a web export: Studio only
 *
 * The web export takes only the Studio keys: the profile's other keys (the Microsoft client id, native voice, the
 * identity and objectives rollouts) are native-app settings a web bundle has never been built with, and carrying them
 * would change the web app on merge. Today no profile carries a Studio key, so every bundle is byte-for-byte what it was.
 *
 * Refuses rather than writes anything it cannot vouch for: a key that is not EXPO_PUBLIC_* (the profile env must never
 * be able to set PATH or NODE_OPTIONS for the rest of a deploy job), a value that is not a string, or a value with a
 * newline (which would forge a second $GITHUB_ENV line).
 *
 * ⚠️ MUTATIONS (scripts/eas-profile-env.test.ts): ignore --prefix — "a web export takes only the profile's Studio keys"
 * reds; drop the key guard — "refuses a key that is not EXPO_PUBLIC_*" reds.
 */
"use strict";
const { readFileSync } = require("node:fs");

const KEY_RE = /^EXPO_PUBLIC_[A-Z0-9_]+$/;

/**
 * Settings for the EAS build machine only (read while `npm ci` runs there), never part of a bundle: skipped, never
 * written to $GITHUB_ENV. SHARP_IGNORE_GLOBAL_LIBVIPS keeps sharp (a server dependency) on its prebuilt binary on the
 * SDK 57 macOS builder, where its install otherwise falls back to a failing source build (PR #1174). Exact names only.
 */
const BUILD_ONLY_KEYS = new Set(["SHARP_IGNORE_GLOBAL_LIBVIPS"]);

/** The profile's env as [key, value] pairs, filtered to `prefix` when one is given. Throws on anything unsafe. */
function profileEnv(easJson, profile, prefix) {
  const build = easJson && easJson.build && easJson.build[profile];
  if (!build) throw new Error(`eas.json has no build profile "${profile}"`);
  const env = build.env || {};
  const pairs = [];
  for (const [key, value] of Object.entries(env)) {
    if (BUILD_ONLY_KEYS.has(key)) continue;
    if (!KEY_RE.test(key))
      throw new Error(
        `eas.json build.${profile}.env: "${key}" is not an EXPO_PUBLIC_* key`,
      );
    if (typeof value !== "string")
      throw new Error(`eas.json build.${profile}.env.${key} is not a string`);
    if (/[\r\n]/.test(value))
      throw new Error(
        `eas.json build.${profile}.env.${key} contains a newline`,
      );
    if (prefix && !key.startsWith(prefix)) continue;
    pairs.push([key, value]);
  }
  return pairs;
}

/** The $GITHUB_ENV text for those pairs — one KEY=VALUE per line, empty when there are none. */
function render(pairs) {
  return pairs.map(([k, v]) => `${k}=${v}\n`).join("");
}

function main(argv) {
  const [profile, flag, prefix] = argv;
  if (!profile || (flag !== undefined && (flag !== "--prefix" || !prefix))) {
    throw new Error(
      "usage: eas-profile-env.cjs <profile> [--prefix EXPO_PUBLIC_STUDIO_]",
    );
  }
  const easJson = JSON.parse(
    readFileSync(require.resolve("../eas.json"), "utf8"),
  );
  process.stdout.write(render(profileEnv(easJson, profile, prefix)));
}

module.exports = { profileEnv, render };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`eas-profile-env: ${err.message}\n`);
    process.exit(1);
  }
}
