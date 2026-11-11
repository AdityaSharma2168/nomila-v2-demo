/**
 * inject-web-v2.test — the dev web build's home-screen tags (scripts/inject-web-v2.js, run only by deploy-web-dev.yml):
 * added once before </head>, idempotent on a second run, and the manifest they point at is the installable one
 * (standalone, 192 and 512 icons that exist). The production workflow never runs the script (checked here too); since stage 1 it turns WEB_V2 on without them.
 */
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { injectTags, TAGS } = require("./inject-web-v2.js") as { injectTags: (html: string) => string; TAGS: string };

const root = path.join(__dirname, "..");
const page = "<html><head><title>Nomila</title></head><body></body></html>";

test("adds the manifest and apple-touch-icon tags once, before </head>; a second run changes nothing", () => {
  const once = injectTags(page);
  expect(once).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(once).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
  expect(once.indexOf(TAGS.trim())).toBeLessThan(once.indexOf("</head>"));
  expect(injectTags(once)).toBe(once);
});

test("the manifest is installable: Nomila, standalone, 192 and 512 icons that exist", () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, "web-v2", "manifest.webmanifest"), "utf8"));
  expect(m).toMatchObject({ name: "Nomila", display: "standalone", start_url: "/" });
  expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
  for (const i of m.icons) expect(fs.existsSync(path.join(root, "web-v2", i.src))).toBe(true);
  expect(fs.existsSync(path.join(root, "web-v2", "icons", "apple-touch-icon.png"))).toBe(true);
  expect(fs.existsSync(path.join(root, "web-v2", "firebase-messaging-sw.js"))).toBe(true);
});

// Stage 1 (owner, 25 Oct 2026): the production web turns WEB_V2 on too, but not the home-screen install or web push.
test("only the dev web workflow runs it; production has WEB_V2 but neither the script nor a push key", () => {
  const dev = fs.readFileSync(path.join(root, ".github", "workflows", "deploy-web-dev.yml"), "utf8");
  const prod = fs.readFileSync(path.join(root, ".github", "workflows", "deploy-prod.yml"), "utf8");
  expect(dev).toContain("node scripts/inject-web-v2.js");
  expect(dev).toContain("EXPO_PUBLIC_WEB_V2=true");
  expect(prod).not.toContain("inject-web-v2");
  expect(prod).toContain("EXPO_PUBLIC_WEB_V2=true");
  expect(prod).not.toContain("FIREBASE_VAPID");
});
