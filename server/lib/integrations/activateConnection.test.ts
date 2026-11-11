/**
 * activateConnection + the provider callbacks that use it — one connected_accounts row per account, for life
 * (docs/plans/connection-identity-fix.md §4.1, §7 "Connect and reconnect").
 *
 * Real modules, in-memory Postgres (schema.ts push, so connected_accounts_account_uq is live), global fetch mocked
 * per provider endpoint. Each case starts from the state POST /connect/:platform leaves: a pending row.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { connectedAccounts } from "../../../shared/schema";
import { activateConnection, MissingAccountIdError } from "./activateConnection";

type Provider = { handleCallback: (code: string, athleteId: string, alias?: string) => Promise<{ connectionId: string; connectedAt: Date; reactivated: boolean }> };
let gmail: Provider, outlook: Provider, youtube: Provider, spotify: Provider;

const realFetch = global.fetch;
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";

function json(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

/** Route fetch by URL prefix; anything unrouted fails the test loudly. */
function mockFetch(routes: Record<string, () => Response>) {
  (global as any).fetch = jest.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = Object.keys(routes).find((prefix) => u.startsWith(prefix));
    if (!hit) throw new Error(`unexpected fetch ${u}`);
    return routes[hit]();
  });
}

function googleTokens(accessToken: string, scope?: string) {
  return () => json({ access_token: accessToken, refresh_token: `${accessToken}-refresh`, expires_in: 3600, ...(scope ? { scope } : {}) });
}
const userinfo = (sub: string | null, email: string, status = 200) => () => json(sub ? { sub, email } : { error: "invalid_token" }, status);

async function pending(athleteId: string, platform: string, alias?: string): Promise<string> {
  const [row] = await db.insert(connectedAccounts)
    .values({ athlete_id: athleteId, platform, alias: alias ?? null, status: "pending" })
    .returning({ id: connectedAccounts.id });
  return row.id;
}

async function rowsFor(athleteId: string, platform: string) {
  return db.select().from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, platform)));
}

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-google-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET_WEB = "test-google-secret";
  process.env.MICROSOFT_CLIENT_ID = "test-ms-id";
  process.env.MICROSOFT_CLIENT_SECRET = "test-ms-secret";
  process.env.SPOTIFY_CLIENT_ID = "test-spotify-id";
  process.env.SPOTIFY_CLIENT_SECRET = "test-spotify-secret";
  gmail   = await import("./gmail");
  outlook = await import("./outlook");
  youtube = await import("./youtube");
  spotify = await import("./spotify");
  await initTestDb();
});
afterEach(() => { (global as any).fetch = realFetch; });
afterAll(async () => { await closeTestDb(); });

describe("gmail reconnect", () => {
  it("after a disconnect, reactivates the SAME row with new tokens and the GRANTED scopes; the pending row is gone", async () => {
    const athleteId = await seedAthlete("Reconnect After Disconnect");
    const oldId = await seedConnection({ athleteId, platform: "gmail", email: "mia@example.com", platformUserId: "sub-1", status: "revoked", scopes: `${READONLY} ${SEND}`, alias: "Work" });
    await db.update(connectedAccounts).set({ access_token: null, refresh_token: null }).where(eq(connectedAccounts.id, oldId));
    const pendingId = await pending(athleteId, "gmail");

    mockFetch({
      "https://oauth2.googleapis.com/token": googleTokens("fresh-token", `${READONLY} ${SEND} ${COMPOSE} openid`),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo("sub-1", "Mia@Example.com"),
    });
    const result = await gmail.handleCallback("code", athleteId);

    expect(result).toMatchObject({ connectionId: oldId, reactivated: true });
    const rows = await rowsFor(athleteId, "gmail");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe(oldId);
    expect(row.id).not.toBe(pendingId);
    expect(row.status).toBe("active");
    expect(row.access_token).toBe("fresh-token");
    expect(row.refresh_token).toBe("fresh-token-refresh");
    expect(row.scopes).toBe(`${READONLY} ${SEND} ${COMPOSE} openid`);
    expect(row.platform_username).toBe("Mia@Example.com");   // refreshed
    expect(row.alias).toBe("Work");                         // kept: this connect supplied none
    expect(row.connected_at?.getTime()).toBe(result.connectedAt.getTime());
  });

  it("on an ACTIVE row without gmail.compose, upgrades that row in place and resets every sync cursor", async () => {
    const athleteId = await seedAthlete("Upgrade In Place");
    const oldAt = new Date(Date.now() - 86_400_000);
    const id = await seedConnection({ athleteId, platform: "gmail", email: "mia@example.com", platformUserId: "sub-2", scopes: `${READONLY} ${SEND}`, connectedAt: oldAt });
    await db.update(connectedAccounts)
      .set({ last_fetched_at: new Date(), gmail_history_id: "9999", sync_cursor: "cursor-x" })
      .where(eq(connectedAccounts.id, id));
    await pending(athleteId, "gmail", "Personal");

    mockFetch({
      "https://oauth2.googleapis.com/token": googleTokens("upgraded", `${READONLY} ${SEND} ${COMPOSE}`),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo("sub-2", "mia@example.com"),
    });
    const result = await gmail.handleCallback("code", athleteId, "Personal");

    expect(result.connectionId).toBe(id);
    const [row] = await rowsFor(athleteId, "gmail");
    expect(row.scopes).toContain("gmail.compose");
    expect(row.last_fetched_at).toBeNull();
    expect(row.gmail_history_id).toBeNull();
    expect(row.sync_cursor).toBeNull();
    expect(row.alias).toBe("Personal");                     // a new alias was supplied → taken
    expect(row.connected_at!.getTime()).toBeGreaterThan(oldAt.getTime());
    expect(await rowsFor(athleteId, "gmail")).toHaveLength(1);
  });

  it("falls back to the requested scope set only when Google omits `scope`", async () => {
    const athleteId = await seedAthlete("No Scope Field");
    await pending(athleteId, "gmail");
    mockFetch({
      "https://oauth2.googleapis.com/token": googleTokens("t"),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo("sub-noscope", "x@example.com"),
    });
    await gmail.handleCallback("code", athleteId);
    const [row] = await rowsFor(athleteId, "gmail");
    expect(row.scopes).toContain("gmail.compose");
    expect(row.scopes).toContain("gmail.readonly");
  });

  it("a DIFFERENT Google account creates its own row — nothing shared across accounts", async () => {
    const athleteId = await seedAthlete("Two Mailboxes");
    const first = await seedConnection({ athleteId, platform: "gmail", email: "one@example.com", platformUserId: "sub-A" });
    const pendingId = await pending(athleteId, "gmail");

    mockFetch({
      "https://oauth2.googleapis.com/token": googleTokens("second", `${READONLY} ${SEND} ${COMPOSE}`),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo("sub-B", "two@example.com"),
    });
    const result = await gmail.handleCallback("code", athleteId);

    expect(result).toMatchObject({ connectionId: pendingId, reactivated: false });   // the pending row was promoted
    const rows = await rowsFor(athleteId, "gmail");
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first)!.access_token).toBe("test-access-token");                 // untouched
    expect(byId.get(pendingId)!).toMatchObject({ status: "active", platform_user_id: "sub-B", platform_username: "two@example.com" });
    expect(byId.get(pendingId)!.connected_at).not.toBeNull();
  });

  it("the same account id on ANOTHER athlete is a separate row (the invariant is per athlete)", async () => {
    const a1 = await seedAthlete("Athlete One");
    const a2 = await seedAthlete("Athlete Two");
    const theirs = await seedConnection({ athleteId: a1, platform: "gmail", platformUserId: "sub-shared" });
    const pendingId = await pending(a2, "gmail");
    mockFetch({
      "https://oauth2.googleapis.com/token": googleTokens("t2", COMPOSE),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo("sub-shared", "shared@example.com"),
    });
    const result = await gmail.handleCallback("code", a2);
    expect(result.connectionId).toBe(pendingId);
    expect(result.connectionId).not.toBe(theirs);
  });
});

describe("a connect that cannot identify the account fails and writes no row with a null id", () => {
  const cases: Array<[string, () => Provider, Record<string, () => Response>]> = [
    ["gmail (userinfo 401)", () => gmail, {
      "https://oauth2.googleapis.com/token": googleTokens("t"),
      "https://www.googleapis.com/oauth2/v3/userinfo": userinfo(null, "", 401),
    }],
    ["gmail (userinfo 200 without sub)", () => gmail, {
      "https://oauth2.googleapis.com/token": googleTokens("t"),
      "https://www.googleapis.com/oauth2/v3/userinfo": () => json({ email: "x@example.com" }),
    }],
    ["outlook (/me 401)", () => outlook, {
      "https://login.microsoftonline.com/": () => json({ access_token: "t", refresh_token: "r", expires_in: 3600, scope: "Mail.Read" }),
      "https://graph.microsoft.com/v1.0/me": () => json({ error: { code: "InvalidAuthenticationToken" } }, 401),
    }],
    ["youtube (no channel)", () => youtube, {
      "https://oauth2.googleapis.com/token": googleTokens("t"),
      "https://www.googleapis.com/youtube/v3/channels": () => json({ items: [] }),
    }],
    ["spotify (/me fails)", () => spotify, {
      "https://accounts.spotify.com/api/token": () => json({ access_token: "t", refresh_token: "r", expires_in: 3600, scope: "user-read-email" }),
      "https://api.spotify.com/v1/me": () => json({ error: { message: "bad token" } }, 401),
    }],
  ];

  for (const [name, provider, routes] of cases) {
    it(name, async () => {
      const platform = name.split(" ")[0];
      const athleteId = await seedAthlete(`No Id ${name}`);
      await pending(athleteId, platform);
      mockFetch(routes);

      await expect(provider().handleCallback("code", athleteId)).rejects.toThrow();

      const rows = await rowsFor(athleteId, platform);
      expect(rows.filter((r) => r.status !== "pending")).toHaveLength(0);   // nothing activated
      expect(rows.every((r) => r.access_token === null)).toBe(true);        // the pending row got no tokens
    });
  }

  it("activateConnection itself refuses a blank account id", async () => {
    const athleteId = await seedAthlete("Blank Id");
    await expect(activateConnection({
      athleteId, platform: "gmail", platformUserId: "  ", platformUsername: null,
      accessToken: "t", refreshToken: null, tokenExpiresAt: null, scopes: "",
    })).rejects.toBeInstanceOf(MissingAccountIdError);
    expect(await rowsFor(athleteId, "gmail")).toHaveLength(0);
  });
});

describe("concurrency", () => {
  const input = (athleteId: string, token: string) => ({
    athleteId, platform: "instagram", platformUserId: "ig-123", platformUsername: "rileyathlete",
    accessToken: token, refreshToken: null, tokenExpiresAt: null, scopes: "instagram_business_basic",
  });

  it("two concurrent callbacks for one account end with ONE row", async () => {
    const athleteId = await seedAthlete("Double Tap");
    await pending(athleteId, "instagram");
    const [a, b] = await Promise.all([activateConnection(input(athleteId, "first")), activateConnection(input(athleteId, "second"))]);

    expect(a.connectionId).toBe(b.connectionId);
    const rows = await rowsFor(athleteId, "instagram");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", platform_user_id: "ig-123" });
  });

  it("a write that loses the race on connected_accounts_account_uq retries and lands on one row", async () => {
    const athleteId = await seedAthlete("Race Loser");
    await pending(athleteId, "instagram");
    const race = Object.assign(new Error('duplicate key value violates unique constraint "connected_accounts_account_uq"'), { code: "23505" });
    let attempts = 0;
    const result = await activateConnection({ ...input(athleteId, "t"), __beforeWrite: async () => { attempts++; throw race; } });

    expect(attempts).toBe(1);   // the retry runs without the hook
    const rows = await rowsFor(athleteId, "instagram");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.connectionId);
  });

  it("the database refuses a second row for the same account outright", async () => {
    const athleteId = await seedAthlete("Index Holds");
    await seedConnection({ athleteId, platform: "gmail", platformUserId: "sub-dup" });
    await expect(seedConnection({ athleteId, platform: "gmail", platformUserId: "sub-dup", status: "revoked" })).rejects.toThrow();
  });
});
