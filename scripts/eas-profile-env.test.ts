/**
 * eas-profile-env.test.ts — eas.json is the one place a client flag is set per environment (PR 20, docs/probes/ship.md
 * item 2, ADI-S20-GO), and moving the OTA and web steps onto it changed no bundle.
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, item 2): M-prefix — profileEnv ignores `prefix`: "a web export takes only the
 * profile's Studio keys" and "the production profile carries exactly the Studio master" red. M-key — the EXPO_PUBLIC_ key guard dropped:
 * "refuses a key that is not EXPO_PUBLIC_*" reds.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { profileEnv, render } = require("./eas-profile-env.cjs") as {
  profileEnv: (
    easJson: unknown,
    profile: string,
    prefix?: string,
  ) => [string, string][];
  render: (pairs: [string, string][]) => string;
};

const ROOT = join(__dirname, "..");
const EAS = JSON.parse(readFileSync(join(ROOT, "eas.json"), "utf8"));
const wf = (name: string) =>
  readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

/** What each OTA step set as literal lines before PR 20 (deploy-prod.yml:289-291, eas-update-preview.yml:75-86). */
const OTA_BEFORE = {
  production: {
    EXPO_PUBLIC_API_URL: "https://api.nomila.co",
    EXPO_PUBLIC_MICROSOFT_CLIENT_ID: "d614f3fe-6f13-4c94-a5b9-2f715a66e015",
    EXPO_PUBLIC_MILA_VOICE_NATIVE: "true",
  },
  preview: {
    EXPO_PUBLIC_API_URL: "https://nomila-v2-iau7alh5qq-uc.a.run.app",
    EXPO_PUBLIC_MICROSOFT_CLIENT_ID: "d614f3fe-6f13-4c94-a5b9-2f715a66e015",
    EXPO_PUBLIC_MILA_VOICE_NATIVE: "true",
    EXPO_PUBLIC_IDENTITY_CLAIM: "true",
  },
};

describe("merging changes no prod bundle: the OTA and web steps read eas.json and get exactly what they had", () => {
  // EXPO_PUBLIC_PARTNER_INTAKE (the Partner door, her side) is pinned OFF in production; ON in preview (the public profile wiring PR).
  // EXPO_PUBLIC_PUBLIC_CARD (app layout B): the "Your public card" section on Me, pinned OFF in production; ON in preview since 8 Oct 2026 (owner: "turn it on")
  // — before that, Me shows the existing My Nomi (deck) entry in its slot meanwhile.
  // EXPO_PUBLIC_AGENT_V3 (the agent rebuild's athlete UI: chat cards, the onboarding conversation, Goals, the Studio
  // library) is pinned OFF in production; DEV/PREVIEW ONLY it is pinned ON (the owner's call). EXPO_PUBLIC_HOME_V3 (the v3
  // Home / Me / five-tab bar, 19 Oct 2026) likewise: pinned OFF in production (Meta reviews the older screens), ON in preview.
  // Stage 1 (owner, 25 Oct 2026): the new app is switched on in production — the agent UI, Home v3, the identity claim,
  // Studio (library + Create, via the master), the Opportunities board + v2 and the deals tools. The public card and the
  // Partner door stay off (Bookings and Shop show "Coming soon").
  it("the production OTA: the literal lines it carried before PR 20, the stage 1 switches on, the public card and the Partner door off", () => {
    expect(Object.fromEntries(profileEnv(EAS, "production"))).toEqual({
      ...OTA_BEFORE.production,
      EXPO_PUBLIC_PUBLIC_CARD: "false",
      EXPO_PUBLIC_PARTNER_INTAKE: "false",
      EXPO_PUBLIC_AGENT_V3: "true",
      EXPO_PUBLIC_HOME_V3: "true",
      EXPO_PUBLIC_IDENTITY_CLAIM: "true",
      EXPO_PUBLIC_STUDIO_ALL_ON: "true",
      EXPO_PUBLIC_OPPS_BOARD: "true",
      EXPO_PUBLIC_OPPS_V2: "true",
      EXPO_PUBLIC_AGENT_DEALS_TOOLS: "true",
      // Mila chat v2 in the app (the chat foundation, step 2): pinned OFF in production.
      EXPO_PUBLIC_MILA_THREAD_V2: "false",
      // Mila cards v2 (the card kit): pinned OFF in production.
      EXPO_PUBLIC_MILA_CARDS_V2: "false",
    });
  });

  it("the production profile carries exactly the Studio master (stage 1: library and Create on)", () => {
    expect(profileEnv(EAS, "production", "EXPO_PUBLIC_STUDIO_")).toEqual([
      ["EXPO_PUBLIC_STUDIO_ALL_ON", "true"],
    ]);
  });

  // EXPO_PUBLIC_CONCEPT04_ME was here between PR #757 and the app shell PR; the shell retired the flag, so the line is gone.
  // EXPO_PUBLIC_OPPS_BOARD turns the new Opportunities board on in preview only (PR #801).
  // EXPO_PUBLIC_SHOP_V1 turns Her picks (My Picks) on in preview only.
  it("dev/preview: the lines it carried before PR 20 plus exactly the master (ADI-S20-GO item 8), and dev web takes only the master", () => {
    expect(Object.fromEntries(profileEnv(EAS, "preview"))).toEqual({
      ...OTA_BEFORE.preview,
      EXPO_PUBLIC_STUDIO_ALL_ON: "true",
      EXPO_PUBLIC_OPPS_BOARD: "true",
      EXPO_PUBLIC_SHOP_V1: "true",
      EXPO_PUBLIC_PUBLIC_CARD: "true",
      // The public profile wiring PR: the Partner door's her-side section and Bookings v2, preview only.
      EXPO_PUBLIC_PARTNER_INTAKE: "true",
      EXPO_PUBLIC_BOOKINGS: "true",
      // Camera-roll intake (#961/#963), preview only; switched on with the dev server flags (12 Oct).
      EXPO_PUBLIC_CAMERA_ROLL_INTAKE: "true",
      // The agent UI: pinned ON in preview (DEV/PREVIEW ONLY — the owner's call); still off in production.
      EXPO_PUBLIC_AGENT_V3: "true",
      // Home v3 (EXPO_PUBLIC_HOME_V3): preview only, the same as the agent UI.
      EXPO_PUBLIC_HOME_V3: "true",
      // Proactive Mila (unread dot, push opens on Mila's message): preview only, owner switched on 28 Oct 2026.
      EXPO_PUBLIC_MILA_PROACTIVE: "true",
      // Mila chat v2 and the card kit: ON in preview (owner, 5 Nov 2026, "opt-in made real"), so the dev phone builds
      // draw Mila's v2 cards (Insight, Ideas, Turn-on, One-time question, Answer). Still pinned OFF in production.
      EXPO_PUBLIC_MILA_THREAD_V2: "true",
      EXPO_PUBLIC_MILA_CARDS_V2: "true",
    });
    expect(profileEnv(EAS, "preview", "EXPO_PUBLIC_STUDIO_")).toEqual([
      ["EXPO_PUBLIC_STUDIO_ALL_ON", "true"],
    ]);
  });

  it("the CLI prints exactly the rendered pairs, one KEY=VALUE per line", () => {
    const r = spawnSync(
      process.execPath,
      [join(__dirname, "eas-profile-env.cjs"), "production"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(render(profileEnv(EAS, "production")));
    expect(r.stdout.trim().split("\n")).toHaveLength(14);
  });
});

describe("what the helper takes and what it refuses", () => {
  const easWith = (env: Record<string, unknown>) => ({
    build: { production: { env } },
  });

  it("a web export takes only the profile's Studio keys", () => {
    const eas = easWith({
      EXPO_PUBLIC_API_URL: "https://api.nomila.co",
      EXPO_PUBLIC_STUDIO_ALL_ON: "true",
      EXPO_PUBLIC_MILA_VOICE_NATIVE: "true",
    });
    expect(profileEnv(eas, "production", "EXPO_PUBLIC_STUDIO_")).toEqual([
      ["EXPO_PUBLIC_STUDIO_ALL_ON", "true"],
    ]);
    expect(profileEnv(eas, "production")).toHaveLength(3);
  });

  it("refuses a key that is not EXPO_PUBLIC_* — the profile can never set PATH or NODE_OPTIONS for a deploy job", () => {
    expect(() =>
      profileEnv(easWith({ NODE_OPTIONS: "--require x" }), "production"),
    ).toThrow(/not an EXPO_PUBLIC_\* key/);
  });

  it("skips the build-machine-only key (never written for an OTA or web bundle), and only that exact name", () => {
    const eas = easWith({ SHARP_IGNORE_GLOBAL_LIBVIPS: "1", EXPO_PUBLIC_API_URL: "https://api.nomila.co" });
    expect(profileEnv(eas, "production")).toEqual([["EXPO_PUBLIC_API_URL", "https://api.nomila.co"]]);
    expect(() =>
      profileEnv(easWith({ SHARP_IGNORE_GLOBAL_LIBVIPS_X: "1" }), "production"),
    ).toThrow(/not an EXPO_PUBLIC_\* key/);
  });

  it("refuses a value with a newline (a forged second $GITHUB_ENV line) or a non-string", () => {
    expect(() =>
      profileEnv(easWith({ EXPO_PUBLIC_X: "true\nPATH=/tmp" }), "production"),
    ).toThrow(/newline/);
    expect(() =>
      profileEnv(easWith({ EXPO_PUBLIC_X: true }), "production"),
    ).toThrow(/not a string/);
  });

  it("refuses a profile eas.json does not have", () => {
    expect(() => profileEnv(EAS, "staging")).toThrow(
      /no build profile "staging"/,
    );
  });
});

describe("the workflows are wired to it, and no workflow sets a client value of its own", () => {
  const PROD = wf("deploy-prod.yml");
  const PREVIEW = wf("eas-update-preview.yml");
  const DEVWEB = wf("deploy-web-dev.yml");
  const before = (text: string, a: string, b: string) =>
    text.indexOf(a) !== -1 &&
    text.indexOf(b) !== -1 &&
    text.indexOf(a) < text.indexOf(b);

  it("production (stage 1): the web export reads the whole profile but its API URL, then the OTA reads the whole profile, each before its build", () => {
    const web =
      `node scripts/eas-profile-env.cjs production | grep -v '^EXPO_PUBLIC_API_URL=' >> "$GITHUB_ENV"`;
    const ota = 'node scripts/eas-profile-env.cjs production >> "$GITHUB_ENV"';
    expect(before(PROD, web, "npx expo export --platform web")).toBe(true);
    expect(before(PROD, ota, "eas update --branch production")).toBe(true);
  });

  it("preview: the OTA reads the whole preview profile before it publishes", () => {
    expect(
      before(
        PREVIEW,
        'node scripts/eas-profile-env.cjs preview >> "$GITHUB_ENV"',
        "eas update --branch preview",
      ),
    ).toBe(true);
  });

  it("dev web: reads the preview profile's Studio keys before its export", () => {
    expect(
      before(
        DEVWEB,
        'node scripts/eas-profile-env.cjs preview --prefix EXPO_PUBLIC_STUDIO_ >> "$GITHUB_ENV"',
        "npx expo export --platform web",
      ),
    ).toBe(true);
  });

  it("dev web (WEB_V2): the whole preview profile but its API URL, plus the dev-web-only switches, before its export", () => {
    expect(
      before(
        DEVWEB,
        `node scripts/eas-profile-env.cjs preview | grep -v '^EXPO_PUBLIC_API_URL=' >> "$GITHUB_ENV"`,
        "npx expo export --platform web",
      ),
    ).toBe(true);
    for (const line of ['echo "EXPO_PUBLIC_OPPS_V2=true"', 'echo "EXPO_PUBLIC_AGENT_DEALS_TOOLS=true"', 'echo "EXPO_PUBLIC_WEB_V2=true"']) {
      expect(before(DEVWEB, line, "npx expo export --platform web")).toBe(true);
    }
    // The production workflow echoes no dev-web-only switch itself (OPPS_V2 comes from the production profile) and has no push key.
    expect(PROD).not.toMatch(/echo "EXPO_PUBLIC_OPPS_V2|echo "EXPO_PUBLIC_AGENT_DEALS_TOOLS|FIREBASE_VAPID/);
  });

  it("production web (stage 1): the web switch is on before its export — URLs, the phone-width column, same-tab connects", () => {
    expect(before(PROD, 'echo "EXPO_PUBLIC_WEB_V2=true" >> "$GITHUB_ENV"', "npx expo export --platform web")).toBe(true);
  });

  it("the only EXPO_PUBLIC_ values a workflow still sets itself: the web exports' API URL, and dev web's push key", () => {
    const own = [PROD, PREVIEW, DEVWEB].flatMap((t) =>
      [...t.matchAll(/^\s+(EXPO_PUBLIC_[A-Z0-9_]+):/gm)].map((m) => m[1]),
    );
    // EXPO_PUBLIC_FIREBASE_VAPID_KEY: a public key from a repository variable, dev web only (no eas.json profile has it).
    expect(own).toEqual(["EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_FIREBASE_VAPID_KEY"]);
  });
});
