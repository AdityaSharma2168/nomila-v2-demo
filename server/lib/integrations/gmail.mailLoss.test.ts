/**
 * Gmail: don't lose mail (12 Oct 2026). Real SQL on PGlite; Gmail is a fake behind global fetch
 * and detectDeal is mocked — nothing reaches Google or a model.
 *
 *   · history.list reads EVERY page (it used to read one, then advance the cursor);
 *   · a cursor too old for Gmail (404) is a HistoryExpiredError, recovered by date;
 *   · a listed message Gmail would not return is reported for dead-lettering;
 *   · the watch renewal never overwrites a stored cursor;
 *   · a dead-letter retry that comes back retryable keeps the dead letter.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
const mockDetect = jest.fn();
jest.mock("../../skills/dealDetector", () => ({ detectDeal: (...a: unknown[]) => mockDetect(...a) }));

import { eq } from "drizzle-orm";
import { connectedAccounts, gmailDeadLetters } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { fetchMessagesByHistoryId, HistoryExpiredError, setupPushNotifications, syncRecent } from "./gmail";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;
const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: `status ${status}` } }) }) as any;

function gmailMessage(id: string, labels = ["INBOX"]) {
  return {
    id, threadId: `t-${id}`, internalDate: "1790000000000", labelIds: labels,
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "brand@acme.com" }, { name: "Subject", value: `Hello ${id}` }],
      body: { data: Buffer.from("hi").toString("base64url") },
    },
  };
}

let athleteId: string;
let conn: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Mail");
  conn = await seedConnection({ athleteId, email: "her@gmail.com" });
}, 30_000);
afterAll(async () => { await closeTestDb(); delete process.env.GMAIL_PUBSUB_TOPIC; });
beforeEach(() => { mockDetect.mockReset(); });

it("reads every history page, and reports a message Gmail would not return", async () => {
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/history")) {
      return u.searchParams.get("pageToken") === "p2"
        ? ok({ history: [{ messagesAdded: [{ message: { id: "m2" } }, { message: { id: "m3" } }] }] })
        : ok({ history: [{ messagesAdded: [{ message: { id: "m1" } }] }], nextPageToken: "p2" });
    }
    if (u.pathname.endsWith("/messages/m3")) return fail(500);
    const id = u.pathname.split("/").pop()!;
    return ok(gmailMessage(id));
  });
  const batch = await fetchMessagesByHistoryId(conn, "100");
  expect(batch.map((m) => m.gmailMessageId).sort()).toEqual(["m1", "m2"]);
  expect(batch.failedIds).toEqual(["m3"]);
});

it("past the page bound it returns what it read and where to resume — never stuck, never skipping", async () => {
  // A history that never ends: every page has a nextPageToken. Record ids rise by page.
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/history")) {
      const n = Number(u.searchParams.get("pageToken") ?? "0");
      return ok({ history: [{ id: String(1000 + n), messagesAdded: [{ message: { id: `b${n}` } }] }], nextPageToken: String(n + 1) });
    }
    return ok(gmailMessage(u.pathname.split("/").pop()!));
  });
  const batch = await fetchMessagesByHistoryId(conn, "999");
  expect(batch).toHaveLength(20);
  // The cursor moves to the last record read (page 20 → id 1019), not to the push's historyId.
  expect(batch.resumeHistoryId).toBe("1019");
});

it("a cursor older than Gmail keeps is a HistoryExpiredError (the webhook recovers by date)", async () => {
  (globalThis as any).fetch = jest.fn(async () => fail(404));
  await expect(fetchMessagesByHistoryId(conn, "1")).rejects.toBeInstanceOf(HistoryExpiredError);
});

it("the watch renewal keeps a stored cursor; it only seeds an empty one", async () => {
  process.env.GMAIL_PUBSUB_TOPIC = "projects/x/topics/y";
  (globalThis as any).fetch = jest.fn(async () => ok({ historyId: "999" }));
  await db.update(connectedAccounts).set({ gmail_history_id: "500" }).where(eq(connectedAccounts.id, conn));
  expect(await setupPushNotifications(conn)).toBe(true);
  let [row] = await db.select({ h: connectedAccounts.gmail_history_id }).from(connectedAccounts).where(eq(connectedAccounts.id, conn));
  expect(row.h).toBe("500");

  await db.update(connectedAccounts).set({ gmail_history_id: null }).where(eq(connectedAccounts.id, conn));
  await setupPushNotifications(conn);
  [row] = await db.select({ h: connectedAccounts.gmail_history_id }).from(connectedAccounts).where(eq(connectedAccounts.id, conn));
  expect(row.h).toBe("999");
});

it("a retryable poll result is dead-lettered, and a retry that is retryable again keeps it", async () => {
  await db.update(connectedAccounts).set({ last_fetched_at: new Date() }).where(eq(connectedAccounts.id, conn));
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages") && !u.pathname.includes("/messages/")) return ok({ messages: [{ id: "r1" }] });
    return ok(gmailMessage(u.pathname.split("/").pop()!));
  });
  mockDetect.mockResolvedValue({ skipped: true, reason: "classify_error", retryable: true });

  await syncRecent(conn, athleteId);

  const rows = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(rows).toHaveLength(1);
  expect(rows[0].gmail_message_id).toBe("r1");
  // The same run's retry came back retryable too: the attempt is counted, the row is kept.
  expect(rows[0].attempts).toBe(1);
});

it("a dead letter backs off (15 min x 2^attempts) before the next retry, then is retried once due (review #991)", async () => {
  // State from the test above: r1 queued with attempts 1, just tried. Now the poll lists nothing new.
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages") && !u.pathname.includes("/messages/")) return ok({ messages: [] });
    return ok(gmailMessage(u.pathname.split("/").pop()!));
  });
  mockDetect.mockResolvedValue({ skipped: false, reason: "ok" });

  await syncRecent(conn, athleteId);
  expect(mockDetect).not.toHaveBeenCalled();                       // not due: 30 min since its last attempt
  let rows = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(rows).toHaveLength(1);

  await db.update(gmailDeadLetters).set({ last_attempt_at: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(gmailDeadLetters.id, rows[0].id));
  await syncRecent(conn, athleteId);
  expect(mockDetect).toHaveBeenCalledTimes(1);
  rows = await db.select().from(gmailDeadLetters).where(eq(gmailDeadLetters.connected_account_id, conn));
  expect(rows).toHaveLength(0);
});
