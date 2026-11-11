#!/usr/bin/env node
/**
 * copy-web-frame-hero.js — the web frame's backdrop photos (client/components/web/WebFrame.tsx, heroSlides.ts).
 *
 * Copies nomila.co's hero photos (landing/assets/v2/hero-N-960.webp and -1920.webp, the landing's own files) into the
 * web export at dist/web-frame/, where the frame loads them by URL. Run by both web deploy workflows after
 * `expo export --platform web`; the photos are never bundled, so native builds never carry them.
 *
 * Idempotent. Run: node scripts/copy-web-frame-hero.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "landing", "assets", "v2");
const distDir = path.join(root, "dist");
const outDir = path.join(distDir, "web-frame");

/** The landing's hero files: hero-<n>-<960|1920>.webp. */
const HERO_FILE = /^hero-\d+-(960|1920)\.webp$/;

function heroFiles(dir = srcDir) {
  return fs.readdirSync(dir).filter((f) => HERO_FILE.test(f)).sort();
}

function main() {
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error("dist/index.html not found — run expo export first");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = heroFiles();
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
  console.log(`web-frame: ${files.length} hero photos copied to dist/web-frame`);
}

module.exports = { heroFiles, HERO_FILE };

if (require.main === module) main();
