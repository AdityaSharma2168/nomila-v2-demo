/**
 * replyThread — the ONE thread draft, propose and send use. Real SQL on PGlite.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { resolveReplyThread } from "./replyThread";

let her: string;
let other: string;
let dealId: string;
let otherDealId: string;
let older: string;
let newerInbound: string;
let newestOutboundOnly: string;
let foreignThread: string;

async function thread(athleteId: string, deal: string | null, lastAt: Date): Promise<string> {
  const [t] = await db.insert(inboxThreads)
    .values({ athlete_id: athleteId, subject: "x", deal_id: deal, last_message_at: lastAt } as any)
    .returning({ id: inboxThreads.id });
  return t.id;
}
async function msg(threadId: string, athleteId: string, direction: "inbound" | "outbound", at: Date) {
  await db.insert(inboxMessages).values({
    thread_id: threadId, athlete_id: athleteId, direction, body: "b", platform: "gmail",
    external_message_id: `m-${threadId}-${at.getTime()}`, received_at: at,
  } as any);
}

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Her");
  other = await seedAthlete("Other");
  [{ id: dealId }] = await db.insert(deals).values({ athlete_id: her, brand_name: "Acme", status: "detected" } as any).returning({ id: deals.id });
  [{ id: otherDealId }] = await db.insert(deals).values({ athlete_id: her, brand_name: "Zed", status: "detected" } as any).returning({ id: deals.id });

  const d = (day: number) => new Date(Date.UTC(2026, 9, day));
  older = await thread(her, dealId, d(1));
  await msg(older, her, "inbound", d(1));
  newerInbound = await thread(her, dealId, d(5));
  await msg(newerInbound, her, "inbound", d(5));
  // Most recent ACTIVITY, but only her own outbound — the brand last wrote on newerInbound.
  newestOutboundOnly = await thread(her, dealId, d(9));
  await msg(newestOutboundOnly, her, "outbound", d(9));
  foreignThread = await thread(her, otherDealId, d(3));
}, 30_000);

afterAll(async () => { await closeTestDb(); });

describe("resolveReplyThread", () => {
  it("picks the deal's thread the brand last wrote on (latest INBOUND), not the latest activity", async () => {
    expect(await resolveReplyThread(her, dealId)).toEqual({ ok: true, threadId: newerInbound });
  });

  it("accepts a named thread only when it is hers AND this deal's", async () => {
    expect(await resolveReplyThread(her, dealId, older)).toEqual({ ok: true, threadId: older });
    expect(await resolveReplyThread(her, dealId, foreignThread)).toEqual({ ok: false, reason: "thread_not_found" });
    expect(await resolveReplyThread(other, dealId, older)).toEqual({ ok: false, reason: "thread_not_found" });
  });

  it("another athlete never resolves her deal's thread; a deal with no thread resolves to null", async () => {
    expect(await resolveReplyThread(other, dealId)).toEqual({ ok: true, threadId: null });
    const [{ id: bare }] = await db.insert(deals).values({ athlete_id: her, brand_name: "Bare", status: "detected" } as any).returning({ id: deals.id });
    expect(await resolveReplyThread(her, bare)).toEqual({ ok: true, threadId: null });
  });
});
