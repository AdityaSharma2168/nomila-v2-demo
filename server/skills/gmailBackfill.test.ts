/**
 * Gmail connect backfill: inbox and Sent are listed with SEPARATE caps (a busy Sent folder never crowds brand mail out),
 * merged, de-duplicated, and run OLDEST FIRST; a failed Sent list leaves the inbox to run alone. Gmail and detectDeal
 * are mocked; PGlite holds the connection row.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const mockFetch = jest.fn();
jest.mock("../lib/integrations/gmail", () => ({ fetchBackfillMessages: (...a: unknown[]) => mockFetch(...a) }));
const mockDetect = jest.fn(async () => ({ skipped: false, reason: "ok" }));
jest.mock("./dealDetector", () => ({ detectDeal: (...a: unknown[]) => (mockDetect as any)(...a) }));

import { runGmailBackfill } from "./gmailBackfill";
import { eq } from "drizzle-orm";
import { connectedAccounts } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const m = (id: string, date: string) => ({ id, threadId: `t-${id}`, subject: "s", from: "a@b.com", body: "x", date, messageIdHeader: null, labelIds: [], inReplyToHeader: null, attachmentText: "", attachments: [] });

let athleteId: string;
let conn: string;
beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Backfill");
  conn = await seedConnection({ athleteId, email: "bf@gmail.com" });
}, 30_000);
afterAll(async () => { await closeTestDb(); });
beforeEach(() => { mockFetch.mockReset(); mockDetect.mockClear(); });

it("lists inbox and sent with their own caps and runs them oldest first, each message once", async () => {
  mockFetch.mockImplementation(async (_c: string, _after: number, _max: number, opts: { folder: string }) =>
    opts.folder === "sent"
      ? [m("s2", "2026-09-03T10:00:00Z"), m("i1", "2026-09-01T10:00:00Z")]     // i1 is in both lists
      : [m("i3", "2026-09-05T10:00:00Z"), m("i1", "2026-09-01T10:00:00Z")]);
  await runGmailBackfill({ connectionId: conn, athleteId });
  const caps = mockFetch.mock.calls.map((c) => [c[3].folder, c[2]]);
  expect(caps).toEqual([["inbox", 1000], ["sent", 500]]);
  expect(mockDetect.mock.calls.map((c: any) => c[0].message.gmailMessageId)).toEqual(["i1", "s2", "i3"]);
});

it("a failed Sent list: the inbox runs on its own, and the scan still closes (no full re-scan, and re-classification, every poll)", async () => {
  mockFetch.mockImplementation(async (_c: string, _a: number, _m: number, opts: { folder: string }) => {
    if (opts.folder === "sent") throw new Error("Gmail list failed");
    return [m("i9", "2026-09-09T10:00:00Z")];
  });
  await db.update(connectedAccounts).set({ last_fetched_at: null }).where(eq(connectedAccounts.id, conn));
  const r = await runGmailBackfill({ connectionId: conn, athleteId });
  expect(r.processed).toBe(1);
  const [row] = await db.select({ f: connectedAccounts.last_fetched_at }).from(connectedAccounts).where(eq(connectedAccounts.id, conn));
  expect(row.f).not.toBeNull();
});
