/**
 * instagramScopes.test.ts — the publish permission is requested only behind IG_REQUEST_PUBLISH_SCOPE (PR 20,
 * docs/probes/ship.md item 5, ADI-S20-GO). Unset, the consent URL asks for exactly the three scopes it always asked for.
 *
 * ⚠️ MUTATION (docs/probes/ship.md, item 5): M-scope — read the variable as `!== "false"`: "unset: exactly the three
 * scopes it always asked" reds by name.
 */
jest.mock("../../db", () => ({ db: {} }));

const THREE =
  "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages";
const FOUR = `${THREE},instagram_business_content_publish`;

const VARS = [
  "IG_REQUEST_PUBLISH_SCOPE",
  "STUDIO_ALL_ON",
  "INSTAGRAM_LOGIN_APP_ID",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Ig = typeof import("./instagram");
/** The module loaded fresh, with an app id so getAuthUrl can build a URL (APP_ID is read at import). */
function load(): Ig {
  process.env.INSTAGRAM_LOGIN_APP_ID = "test-app";
  let mod!: Ig;
  jest.isolateModules(() => {
    mod = require("./instagram") as Ig;
  });
  return mod;
}
const scopeParam = (ig: Ig) =>
  new URL(
    ig.getAuthUrl("00000000-0000-0000-0000-000000000000"),
  ).searchParams.get("scope");

describe("the Instagram consent asks for the publish permission only behind IG_REQUEST_PUBLISH_SCOPE", () => {
  it("unset: exactly the three scopes it always asked", () => {
    const ig = load();
    expect(ig.requestedScopes()).toBe(THREE);
    expect(scopeParam(ig)).toBe(THREE);
  });

  it('exactly "true": the three plus instagram_business_content_publish, in the consent URL', () => {
    const ig = load();
    process.env.IG_REQUEST_PUBLISH_SCOPE = "true";
    expect(ig.requestedScopes()).toBe(FOUR);
    expect(scopeParam(ig)).toBe(FOUR);
  });

  it.each(["false", "1", "TRUE", "yes", ""])(
    "%p is not on: exactly the three",
    (v) => {
      const ig = load();
      process.env.IG_REQUEST_PUBLISH_SCOPE = v;
      expect(scopeParam(ig)).toBe(THREE);
    },
  );

  it("the Studio master never reaches it — it is not a STUDIO_* flag", () => {
    const ig = load();
    process.env.STUDIO_ALL_ON = "true";
    expect(scopeParam(ig)).toBe(THREE);
  });
});

describe("the consent URL stays in the browser on an iPhone with the Instagram app installed", () => {
  it("starts at api.instagram.com (no universal link), not www.instagram.com", () => {
    const url = new URL(load().getAuthUrl("00000000-0000-0000-0000-000000000000"));
    expect(url.origin + url.pathname).toBe("https://api.instagram.com/oauth/authorize");
  });
});
