#!/usr/bin/env node
/**
 * inject-web-v2.js — the dev web build's install-to-home-screen and notification files (EXPO_PUBLIC_WEB_V2).
 *
 * Run ONLY by .github/workflows/deploy-web-dev.yml, after `expo export` and inject-web-fonts.js. It copies web-v2/
 * (the manifest, the icons, the notification service worker) into dist/ and adds the manifest link, the
 * apple-touch-icon and the home-screen meta tags to dist/index.html. The production web build (deploy-prod.yml) never
 * runs it, so app.nomila.co's output is unchanged: no manifest, no worker, no new tags.
 *
 * Idempotent: a second run replaces its own block. Run: node scripts/inject-web-v2.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "web-v2");
const distDir = path.join(root, "dist");
const htmlFile = path.join(distDir, "index.html");

const TAGS = `
  <!-- web-v2 -->
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#FAF8F5">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Nomila">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <!-- /web-v2 -->`;

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** The page with the web-v2 block (any earlier one replaced) just before </head>. */
function injectTags(html) {
  const clean = html.replace(/\s*<!-- web-v2 -->[\s\S]*?<!-- \/web-v2 -->\s*/g, "");
  return clean.replace("</head>", `${TAGS}\n  </head>`);
}

function main() {
  if (!fs.existsSync(htmlFile)) {
    console.error("dist/index.html not found — run expo export first");
    process.exit(1);
  }
  copyDir(srcDir, distDir);
  fs.writeFileSync(htmlFile, injectTags(fs.readFileSync(htmlFile, "utf8")));
  console.log("web-v2: manifest, icons and notification worker copied; home-screen tags injected");
}

module.exports = { injectTags, TAGS };

if (require.main === module) main();
