/**
 * refreshTokenIfNeeded — Gmail connection status transitions on token refresh.
 *
 * Real module, in-memory Postgres for the connection row, global fetch mocked
 * (no Google token endpoint). A definitive re-auth failure (invalid_grant) must
 * flip the connection to "expired"; a transient failure must leave it "active".
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db, client, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { connectedAccounts } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import type { refreshTokenIfNeeded as RefreshFn } from "./gmail";

// gmail.ts reads GOOGLE_CLIENT_ID / _SECRET at module-load time, so it is imported
// dynamically in beforeAll — after the env is set.
let refreshTokenIfNeeded: typeof RefreshFn;

const realFetch = global.fetch;

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload } as Response;
}

// Force the stored token past the 5-min refresh window and give it a refresh token.
async function makeStale(connectionId: string, refreshToken: string | null) {
  await db
    .update(connectedAccounts)
    .set({ token_expires_at: new Date(Date.now() - 60_000), refresh_token: refreshToken })
    .where(eq(connectedAccounts.id, connectionId));
}

async function statusOf(connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: connectedAccounts.status })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectionId))
    .limit(1);
  return row.status;
}

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET_WEB = "test-client-secret";
  ({ refreshTokenIfNeeded } = await import("./gmail"));
  await initTestDb();
});

afterEach(async () => {
  (global as any).fetch = realFetch;
  // Reset all connections to active between cases.
  await client.exec(`UPDATE connected_accounts SET status = 'active'`);
});

afterAll(async () => {
  await closeTestDb();
});

it("flips the connection to expired on invalid_grant and rethrows", async () => {
  const athleteId = await seedAthlete();
  const connId = await seedConnection({ athleteId, email: "a@gmail.com" });
  await makeStale(connId, "refresh-tok");

  (global as any).fetch = jest.fn(async () =>
    jsonResponse({ error: "invalid_grant", error_description: "Token has been revoked" }, false, 400),
  );

  await expect(refreshTokenIfNeeded(connId)).rejects.toThrow(/refresh failed/i);
  expect(await statusOf(connId)).toBe("expired");
});

it("flips to expired when there is no refresh token", async () => {
  const athleteId = await seedAthlete();
  const connId = await seedConnection({ athleteId, email: "b@gmail.com" });
  await makeStale(connId, null);

  const fetchMock = jest.fn();
  (global as any).fetch = fetchMock;

  await expect(refreshTokenIfNeeded(connId)).rejects.toThrow(/reconnect/i);
  expect(await statusOf(connId)).toBe("expired");
  expect(fetchMock).not.toHaveBeenCalled(); // never hit the network
});

it("leaves the connection active on a transient (non-auth) failure", async () => {
  const athleteId = await seedAthlete();
  const connId = await seedConnection({ athleteId, email: "c@gmail.com" });
  await makeStale(connId, "refresh-tok");

  (global as any).fetch = jest.fn(async () =>
    jsonResponse({ error: "temporarily_unavailable" }, false, 503),
  );

  await expect(refreshTokenIfNeeded(connId)).rejects.toThrow();
  expect(await statusOf(connId)).toBe("active"); // NOT flipped — a blip must not force reconnect
});

it("stores the fresh token and stays active on success", async () => {
  const athleteId = await seedAthlete();
  const connId = await seedConnection({ athleteId, email: "d@gmail.com" });
  await makeStale(connId, "refresh-tok");

  (global as any).fetch = jest.fn(async () =>
    jsonResponse({ access_token: "fresh-access-token", expires_in: 3600 }),
  );

  const token = await refreshTokenIfNeeded(connId);
  expect(token).toBe("fresh-access-token");
  expect(await statusOf(connId)).toBe("active");

  const [row] = await db
    .select({ access_token: connectedAccounts.access_token })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connId))
    .limit(1);
  expect(row.access_token).toBe("fresh-access-token");
});
