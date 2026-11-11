/**
 * inboxCronSync × OUTLOOK_PUSH — the sync position rule.
 *
 * Flag off: the 6h poll runs every active Outlook connection, exactly as before (subscription rows or not).
 * Flag on: a connection with a healthy subscription whose delta ran within 23 h is skipped (push covers it);
 * one that has not synced for a day, or whose subscription is not active/unexpired, still polls — the daily backstop.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const mockSync = jest.fn(async () => ({ detected: 0, skipped: 0 }));
jest.mock("../lib/integrations/registry", () => ({ INBOX: { outlook: { syncRecent: (...a: unknown[]) => (mockSync as any)(...a) } } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { connectedAccounts, outlookSubscriptions } from "../../shared/schema";
import { runInboxCronSync } from "./inboxCronSync";

let fresh: string, stale: string, removed: string, unsubscribed: string;

beforeAll(async () => {
  await initTestDb();
  const athleteId = await seedAthlete("Poll");
  const hourAgo = new Date(Date.now() - 3600_000);
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5);
  const sub = (connectionId: string, n: number, status = "active") => db.insert(outlookSubscriptions).values({
    connected_account_id: connectionId, graph_subscription_id: `g-${n}`, resource: "me/mailFolders('inbox')/messages",
    expires_at: new Date(Date.now() + 5 * 864e5), client_state_hash: "h", status,
  });
  fresh = await seedConnection({ athleteId, platform: "outlook" });
  stale = await seedConnection({ athleteId, platform: "outlook" });
  removed = await seedConnection({ athleteId, platform: "outlook" });
  unsubscribed = await seedConnection({ athleteId, platform: "outlook" });
  await db.update(connectedAccounts).set({ last_fetched_at: hourAgo }).where(eq(connectedAccounts.id, fresh));
  await db.update(connectedAccounts).set({ last_fetched_at: twoDaysAgo }).where(eq(connectedAccounts.id, stale));
  await db.update(connectedAccounts).set({ last_fetched_at: hourAgo }).where(eq(connectedAccounts.id, removed));
  await db.update(connectedAccounts).set({ last_fetched_at: hourAgo }).where(eq(connectedAccounts.id, unsubscribed));
  await sub(fresh, 1);
  await sub(stale, 2);
  await sub(removed, 3, "removed");
});
afterAll(async () => { await closeTestDb(); delete process.env.OUTLOOK_PUSH; });
beforeEach(() => mockSync.mockClear());

const synced = () => new Set(mockSync.mock.calls.map((c: any[]) => c[0]));

it("flag off: every active Outlook connection polls, nothing deferred", async () => {
  delete process.env.OUTLOOK_PUSH;
  const r = await runInboxCronSync();
  expect(synced()).toEqual(new Set([fresh, stale, removed, unsubscribed]));
  expect(r.platforms[0]).toMatchObject({ platform: "outlook", connections: 4, deferred: 0 });
});

it("flag on: only the push-covered, recently synced connection is skipped", async () => {
  process.env.OUTLOOK_PUSH = "true";
  const r = await runInboxCronSync();
  expect(synced()).toEqual(new Set([stale, removed, unsubscribed]));
  expect(r.platforms[0]).toMatchObject({ connections: 4, deferred: 1 });
});
