/**
 * igTokenRefresh.test — every failure has a name, and the token's state is logged token-free (PR 7, G2).
 *
 * No network: `fetch` is stood in per URL (debug_token, the exchange, Secret Manager); google-auth-library
 * hands back a fixed access token. ⚠️ MUTATIONS, red here by name: classify FB 190 as transient —
 * "expired token reported as transient" (the kind and the 424 both); log the token — "the token itself
 * never reaches a log line".
 */
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "gcp-access-token" }),
    }),
  })),
}));
// Every log line lands in ONE array (clearAllMocks between tests would otherwise lose the module-load
// createLogger call this file needs to find its logger by).
const mockLogs: { level: string; args: unknown[] }[] = [];
jest.mock("../logger", () => {
  const at = (level: string) =>
    jest.fn((...args: unknown[]) => {
      mockLogs.push({ level, args });
    });
  const make = () => ({
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  });
  return { createLogger: jest.fn(make) };
});

import {
  classifyFbError,
  IgTokenRefreshError,
  refreshInstagramToken,
  statusForRefreshError,
} from "./igTokenRefresh";

const TOKEN = "EAAB-the-current-token-never-logged";
const NEW_TOKEN = "EAAB-the-new-token";
const APP = "123456";

/** The log lines of one level, as `[fields, message]` pairs. */
const lines = (level: "info" | "warn" | "error") =>
  mockLogs.filter((l) => l.level === level).map((l) => l.args);
const logs = () => ({
  info: { mock: { calls: lines("info") } },
  warn: { mock: { calls: lines("warn") } },
  error: { mock: { calls: lines("error") } },
});

type Script = {
  debug?: () => Response;
  exchange?: () => Response;
  secret?: () => Response;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const scripted = (s: Script) =>
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/debug_token"))
      return (
        s.debug ??
        (() =>
          json(200, {
            data: {
              is_valid: true,
              expires_at: 1_793_000_000,
              app_id: APP,
              type: "PAGE",
              scopes: ["a", "b"],
            },
          }))
      )();
    if (url.includes("/oauth/access_token"))
      return (
        s.exchange ??
        (() => json(200, { access_token: NEW_TOKEN, expires_in: 5184000 }))
      )();
    if (url.includes("secretmanager.googleapis.com"))
      return (
        s.secret ??
        (() => json(200, { name: "projects/p/secrets/s/versions/7" }))
      )();
    throw new Error(`unexpected fetch ${url}`);
  });

beforeEach(() => {
  process.env.IG_PAGE_ACCESS_TOKEN = TOKEN;
  process.env.INSTAGRAM_APP_ID = APP;
  process.env.INSTAGRAM_APP_SECRET = "shh";
  jest.clearAllMocks();
  mockLogs.length = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
});

const failure = async (): Promise<IgTokenRefreshError> => {
  try {
    await refreshInstagramToken();
  } catch (err) {
    if (err instanceof IgTokenRefreshError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("the happy path, unchanged", () => {
  it("exchanges, writes the new version, returns the expiry — and the token's state is on the log, token-free", async () => {
    const fetched = scripted({});
    const r = await refreshInstagramToken();
    expect(r.expiresInSeconds).toBe(5184000);
    expect(Date.parse(r.newExpiryDate)).toBeGreaterThan(Date.now());
    const secretCall = fetched.mock.calls.find((c) =>
      String(c[0]).includes("secretmanager"),
    )!;
    expect(JSON.parse(String(secretCall[1]!.body)).payload.data).toBe(
      Buffer.from(NEW_TOKEN).toString("base64"),
    );
    const state = logs().info.mock.calls.find(
      (c) => c[1] === "Instagram token state",
    )! as [Record<string, unknown>, string];
    expect(state[0]).toMatchObject({
      isValid: true,
      tokenAppId: APP,
      ourAppId: APP,
      appMatches: true,
      type: "PAGE",
      scopes: 2,
    });
    expect(String(state[0].expiresAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The token itself never reaches a log line, on any level.
    const everything = JSON.stringify([
      logs().info.mock.calls,
      logs().warn.mock.calls,
      logs().error.mock.calls,
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(NEW_TOKEN);
  });
});

describe("every failure has a name", () => {
  it("FB 190 is the dead token: token_expired → 424 (never transient)", async () => {
    scripted({
      exchange: () =>
        json(400, {
          error: {
            code: 190,
            type: "OAuthException",
            message: "Error validating access token: Session has expired",
          },
        }),
    });
    const err = await failure();
    expect(err.kind).toBe("token_expired");
    expect(err.detail).toMatchObject({ fbCode: 190 });
    expect(statusForRefreshError(err)).toEqual({
      status: 424,
      body: { error: "token_expired", fbCode: 190, fbType: "OAuthException" },
    });
    expect(classifyFbError(400, { error: { code: 190 } }).kind).toBe(
      "token_expired",
    );
  });

  it("Secret Manager refusing the version is secret_write_failed → 502; its 5xx is transient → 503", async () => {
    scripted({
      secret: () => new Response("PERMISSION_DENIED", { status: 403 }),
    });
    const denied = await failure();
    expect(denied.kind).toBe("secret_write_failed");
    expect(statusForRefreshError(denied).status).toBe(502);
    jest.restoreAllMocks();
    scripted({ secret: () => new Response("upstream", { status: 503 }) });
    expect((await failure()).kind).toBe("transient");
  });

  it("FB 5xx, a timeout and a network error are transient → 503", async () => {
    scripted({
      exchange: () =>
        json(503, { error: { code: 2, message: "temporarily unavailable" } }),
    });
    expect((await failure()).kind).toBe("transient");
    jest.restoreAllMocks();
    scripted({
      exchange: () => {
        throw new Error("fetch failed: ECONNRESET");
      },
    });
    const net = await failure();
    expect(net.kind).toBe("transient");
    expect(statusForRefreshError(net)).toEqual({
      status: 503,
      body: { error: "transient", network: true },
    });
  });

  it("a token that belongs to another app than the one signing the exchange is misconfigured → 500, and says which apps", async () => {
    scripted({
      debug: () =>
        json(200, {
          data: {
            is_valid: true,
            expires_at: 1_793_000_000,
            app_id: "999999",
            type: "PAGE",
          },
        }),
      exchange: () =>
        json(400, {
          error: {
            code: 101,
            type: "OAuthException",
            message: "Error validating application",
          },
        }),
    });
    const err = await failure();
    expect(err.kind).toBe("misconfigured");
    expect(err.detail).toMatchObject({
      tokenAppId: "999999",
      ourAppId: APP,
      fbCode: 101,
    });
    expect(statusForRefreshError(err).status).toBe(500);
    expect(
      logs().info.mock.calls.find((c) => c[1] === "Instagram token state")![0],
    ).toMatchObject({ appMatches: false });
  });

  it("missing env is misconfigured, before any call", async () => {
    const fetched = scripted({});
    delete process.env.INSTAGRAM_APP_SECRET;
    const err = await failure();
    expect(err.kind).toBe("misconfigured");
    expect(err.detail).toEqual({
      hasToken: true,
      hasAppId: true,
      hasAppSecret: false,
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("a failed debug_token is a warning, never a refusal — the exchange still runs", async () => {
    scripted({
      debug: () => {
        throw new Error("timeout");
      },
    });
    const r = await refreshInstagramToken();
    expect(r.expiresInSeconds).toBe(5184000);
    expect(
      logs().warn.mock.calls.some(
        (c) => c[1] === "Instagram token state unavailable",
      ),
    ).toBe(true);
  });

  it("an error that is not ours stays a plain 500", () => {
    expect(statusForRefreshError(new Error("boom"))).toEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
  });
});
