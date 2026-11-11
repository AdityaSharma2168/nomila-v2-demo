/**
 * Outlook: a message the classifier could not judge is queued PER MESSAGE and retried, and the delta cursor moves on —
 * one poison message can no longer freeze the mailbox's sync (review follow-up to #983). Graph is a fake on global fetch;
 * detectDeal is mocked, so nothing leaves the test.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/dealDetector", () => ({ detectDeal: jest.fn() }));

import { eq } from "drizzle-orm";
import { syncRecent } from "./outlook";
import { detectDeal } from "../../skills/dealDetector";
import { connectedAccounts, gmailDeadLetters } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const detectMock = detectDeal as jest.Mock;
const CURSOR = "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=T0";
const NEXT = "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=T1";

const msg = (id: string) => ({
  id, subject: "Hello", from: { emailAddress: { name: "Acme", address: "brand@acme.com" } },
  receivedDateTime: "2026-10-06T12:00:00Z", body: { contentType: "text", content: "hi" },
  conversationId: `conv-${id}`, internetMessageId: `<${id}@acme.com>`, hasAttachments: false,
});
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as any;

let athleteId: string;
let conn: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Outlook");
  conn = await seedConnection({ athleteId, platform: "outlook", email: "her@outlook.com" });
  await db.update(connectedAccounts).set({ sync_cursor: CURSOR, last_fetched_at: new Date() }).where(eq(connectedAccounts.id, conn));
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith(CURSOR)) return ok({ value: [msg("poison"), msg("fine")], "@odata.deltaLink": NEXT });
    if (u.startsWith(NEXT)) return ok({ value: [], "@odata.deltaLink": NEXT });
    if (u.includes("/mailFolders/SentItems/")) return ok({ value: [] });
    if (u.includes("/me/messages/poison")) return ok(msg("poison"));
    return ok({ value: [] });
  });
}, 30_000);
afterAll(async () => { await closeTestDb(); });

it("queues the unjudged message, advances the cursor, then retries it and clears it once judged", async () => {
  detectMock.mockImplementation(async ({ message }: any) =>
    message.gmailMessageId === "poison" ? { skipped: true, reason: "classify_error", retryable: true } : { skipped: false, reason: "ok" });

  await syncRecent(conn, athleteId);
  let [row] = await db.select({ c: connectedAccounts.sync_cursor }).from(connectedAccounts).where(eq(connectedAccounts.id, conn));
  expect(row.c).toBe(NEXT);                                                     // the cursor moved on
  let queued = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(queued.map((q) => q.gmail_message_id)).toEqual(["poison"]);

  // Still unjudged on the next poll: the attempt is counted, the row stays (bounded at 5).
  await syncRecent(conn, athleteId);
  queued = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(queued[0].attempts).toBe(1);

  // Backoff: not due yet (15 min × 2^1 since the last attempt) — the next poll leaves it alone.
  detectMock.mockClear();
  detectMock.mockResolvedValue({ skipped: false, reason: "ok" });
  await syncRecent(conn, athleteId);
  expect(detectMock.mock.calls.some((c: any) => c[0].message.gmailMessageId === "poison")).toBe(false);
  queued = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(queued).toHaveLength(1);

  // Due again (its last attempt an hour ago): judged at last, and the row is cleared.
  await db.update(gmailDeadLetters).set({ last_attempt_at: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(gmailDeadLetters.id, queued[0].id));
  await syncRecent(conn, athleteId);
  queued = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(queued).toHaveLength(0);
  [row] = await db.select({ c: connectedAccounts.sync_cursor }).from(connectedAccounts).where(eq(connectedAccounts.id, conn));
  expect(row.c).toBe(NEXT);
});

it("a row is claimed by one retrier only (compare-and-set), and only once due", async () => {
  const { claimDeadLetter } = await import("../deadLetterClaim");
  const [row] = await db.insert(gmailDeadLetters).values({ connected_account_id: conn, athlete_id: athleteId, gmail_message_id: "race", error: "x" }).returning();
  const results = await Promise.all([claimDeadLetter(row), claimDeadLetter(row)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const [after] = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.id, row.id));
  expect(await claimDeadLetter(after)).toBe(false);               // just tried: not due for 15 minutes
});
