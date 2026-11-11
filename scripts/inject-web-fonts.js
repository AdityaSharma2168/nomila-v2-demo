#!/usr/bin/env node
/**
 * Post-processes dist/index.html to inject @font-face CSS.
 *
 * Font files are copied to dist/fonts/ by the CI step BEFORE this script runs
 * (see deploy-web.yml). Using /fonts/ paths avoids the Firebase Hosting
 * "node_modules" ignore rule that excludes dist/assets/node_modules/...
 *
 * font-display:swap  — text: show system font immediately, swap to Outfit when ready
 * font-display:block — icons: hide until loaded (prevents □ boxes on first paint)
 *
 * Run: node scripts/inject-web-fonts.js  (after fonts are in dist/fonts/)
 */
const fs   = require("fs");
const path = require("path");

const distDir  = path.join(__dirname, "..", "dist");
const htmlFile = path.join(distDir, "index.html");

if (!fs.existsSync(htmlFile)) {
  console.error("dist/index.html not found — run expo export first");
  process.exit(1);
}

const css = `
  <style id="expo-generated-fonts">
    @font-face { font-family: "Outfit_400Regular";   font-display: swap;  src: url(/fonts/Outfit_400Regular.ttf)   format("truetype"); }
    @font-face { font-family: "Outfit_500Medium";    font-display: swap;  src: url(/fonts/Outfit_500Medium.ttf)    format("truetype"); }
    @font-face { font-family: "Outfit_600SemiBold";  font-display: swap;  src: url(/fonts/Outfit_600SemiBold.ttf)  format("truetype"); }
    @font-face { font-family: "Outfit_700Bold";      font-display: swap;  src: url(/fonts/Outfit_700Bold.ttf)      format("truetype"); }
    @font-face { font-family: "Outfit_800ExtraBold"; font-display: swap;  src: url(/fonts/Outfit_800ExtraBold.ttf) format("truetype"); }
    @font-face { font-family: "Feather";               font-display: block; src: url(/fonts/Feather.ttf)                   format("truetype"); }
    @font-face { font-family: "Ionicons";              font-display: block; src: url(/fonts/Ionicons.ttf)                  format("truetype"); }
    @font-face { font-family: "Material Design Icons"; font-display: block; src: url(/fonts/MaterialCommunityIcons.ttf)    format("truetype"); }
  </style>`;

let html = fs.readFileSync(htmlFile, "utf8");

// Idempotent: strip any previous injection by this script
html = html.replace(/<style id="expo-generated-fonts">[\s\S]*?<\/style>\s*/g, "");

html = html.replace("</head>", css + "\n  </head>");
fs.writeFileSync(htmlFile, html);

console.log("Font CSS injected into dist/index.html (/fonts/ paths)");
