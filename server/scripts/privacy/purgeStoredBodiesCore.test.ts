/**
 * purgeStoredBodiesCore — removes stored mail content from existing rows, only where the
 * derived facts exist. Real SQL on PGlite (never a real database); no provider is involved.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { countStoredBodies, purgeStoredBodies } from "./purgeStoredBodiesCore";
import { inboxBodyFingerprint } from "../../lib/inboxBodyFingerprint";
import { pseudonymousSender } from "../../lib/mailbox/retention";

let a: string;
let b: string;
const ids: Record<string, string> = {};

/** Leading/trailing whitespace JS trims but Postgres btrim() would not (NBSP, em space, newline). */
const DEAL_BODY = " \n  Two reels for $5,000 — deal? \n";

async function thread(athleteId: string, over: Record<string, unknown>) {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, status: "deal_detected", ...over } as any)
    .returning({ id: inboxThreads.id });
  return t.id as string;
}
async function message(threadId: string, athleteId: string, over: Record<string, unknown>) {
  const [m] = await db.insert(inboxMessages).values({
    thread_id: threadId, athlete_id: athleteId, direction: "inbound", platform: "gmail", received_at: new Date(), ...over,
  } as any).returning({ id: inboxMessages.id });
  return m.id as string;
}
const msg = async (id: string) => (await db.select().from(inboxMessages).where(eq(inboxMessages.id, id)))[0];
const thr = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0];

beforeAll(async () => {
  await initTestDb();
  a = await seedAthlete("Purge A");
  b = await seedAthlete("Purge B");
  const [d] = await db.insert(deals).values({ athlete_id: a, brand_name: "Acme", status: "negotiating" } as any).returning({ id: deals.id });

  const derived = { classification: { category: "PAID" }, conversation_state: { summary: "derived" } };
  // T1: a deal thread with its derived facts → purged; the counterparty's address stays.
  ids.t1 = await thread(a, { ...derived, deal_id: d.id, subject: "Acme reels" });
  ids.m1 = await message(ids.t1, a, { sender_email: "sarah@acme.com", sender_name: "Sarah", subject: "Acme reels", body: DEAL_BODY });
  ids.m1out = await message(ids.t1, a, { direction: "outbound", subject: "Re: Acme reels", body: "Yes!", body_sha256: inboxBodyFingerprint("Yes!") });
  // T2: not a deal, derived facts present → purged; the sender becomes a pseudonym.
  ids.t2 = await thread(a, { ...derived, status: "read", subject: "hello" });
  ids.m2 = await message(ids.t2, a, { sender_email: " Fan@Gmail.com ", sender_name: "A Fan", subject: "hello", body: "Love your game" });
  // T3: no derived facts → REFUSED, untouched.
  ids.t3 = await thread(a, { classification: null, conversation_state: null, subject: "pending" });
  ids.m3 = await message(ids.t3, a, { sender_email: "x@y.com", subject: "pending", body: "not yet summarized" });
  // T4: junk (archived, no summary) → purged.
  ids.t4 = await thread(a, { status: "archived", classification: { category: "NOISE" }, subject: "promo" });
  ids.m4 = await message(ids.t4, a, { sender_email: "Promo Team", subject: "promo", body: "50% off" });
  // T5: Instagram → never touched (the exception).
  ids.t5 = await thread(a, { ...derived, subject: "DM from someone" });
  ids.m5 = await message(ids.t5, a, { platform: "instagram", sender_email: "someone", sender_name: "someone", subject: "DM from someone", body: "dm text" });
  // T6: a Nomila-relayed partner-request thread → never touched (Nomila's own relay record, the second exception).
  ids.t6 = await thread(a, { ...derived, deal_id: d.id, subject: "Request from your public card" });
  ids.m6 = await message(ids.t6, a, { platform: "nomila", sender_email: "visitor@brand.example", sender_name: "Visitor", subject: "Request from your public card", body: "relayed text" });
  // B: another athlete's eligible thread — out of an --athlete A scope.
  ids.tb = await thread(b, { ...derived, subject: "b subject" });
  ids.mb = await message(ids.tb, b, { sender_email: "z@brand.com", subject: "b subject", body: "b body" });
});
afterAll(async () => { await closeTestDb(); });

describe("purgeStoredBodiesCore", () => {
  it("dry run: counts and bytes only, refuses threads without derived facts, under a READ-ONLY session", async () => {
    await client.exec("SET default_transaction_read_only = on");
    try {
      const c = await countStoredBodies(db, { athleteId: a });
      expect(c.threads).toBe(4);                       // T1 T2 T3 T4 (T5 is Instagram, T6 Nomila-relayed)
      expect(c.eligibleThreads).toBe(3);
      expect(c.refusedThreadIds).toEqual([ids.t3]);
      expect(c.instagramThreads).toBe(2);              // the exceptions: T5 Instagram + T6 Nomila-relayed
      expect(c.messages).toBe(4);                      // m1, m1out, m2, m4
      expect(c.missingFingerprint).toBe(3);            // m1, m2, m4 (m1out already has one)
      expect(c.bytes.body).toBe(
        Buffer.byteLength(DEAL_BODY) + Buffer.byteLength("Yes!") + Buffer.byteLength("Love your game") + Buffer.byteLength("50% off"),
      );
      expect(c.bytes.thread_subject).toBe(Buffer.byteLength("Acme reels") + Buffer.byteLength("hello") + Buffer.byteLength("promo"));
      // Nothing can be written in the dry run's session.
      await expect(purgeStoredBodies(db, { athleteId: a })).rejects.toThrow(/read-only/);
    } finally {
      await client.exec("SET default_transaction_read_only = off");
    }
    // …and nothing was.
    expect((await msg(ids.m1)).body).toBe(DEAL_BODY);
    expect((await msg(ids.m1)).body_sha256).toBeNull();
  });

  it("--athlete: fingerprints first, then content off; counterparty kept, others pseudonymised; refused + Instagram + other athlete untouched", async () => {
    const r = await purgeStoredBodies(db, { athleteId: a });
    expect(r).toMatchObject({ threadsPurged: 3, fingerprintsFilled: 3, refusedThreadIds: [ids.t3] });

    const m1 = await msg(ids.m1);
    expect(m1).toMatchObject({ body: null, subject: null, sender_name: null, sender_email: "sarah@acme.com" });
    // The SQL fingerprint is the JS one: trimmed exactly as String.prototype.trim trims.
    expect(m1.body_sha256).toBe(inboxBodyFingerprint(DEAL_BODY));
    expect((await msg(ids.m1out))).toMatchObject({ body: null, subject: null, body_sha256: inboxBodyFingerprint("Yes!") });

    const m2 = await msg(ids.m2);
    expect(m2).toMatchObject({ body: null, subject: null, sender_name: null });
    expect(m2.sender_email).toBe(pseudonymousSender(" Fan@Gmail.com "));   // same bytes as ingest writes
    expect(m2.body_sha256).toBe(inboxBodyFingerprint("Love your game"));

    expect(await msg(ids.m4)).toMatchObject({ body: null, subject: null, sender_email: null });   // a name, not an address
    expect((await thr(ids.t1)).subject).toBeNull();
    expect((await thr(ids.t2)).subject).toBeNull();
    expect((await thr(ids.t4)).subject).toBeNull();

    expect(await msg(ids.m3)).toMatchObject({ body: "not yet summarized", subject: "pending", sender_email: "x@y.com" });
    expect((await thr(ids.t3)).subject).toBe("pending");
    expect(await msg(ids.m5)).toMatchObject({ body: "dm text", subject: "DM from someone" });
    expect(await msg(ids.m6)).toMatchObject({ body: "relayed text", subject: "Request from your public card", sender_email: "visitor@brand.example" });
    expect((await thr(ids.t6)).subject).toBe("Request from your public card");
    expect(await msg(ids.mb)).toMatchObject({ body: "b body", subject: "b subject" });
  });

  it("re-running is a no-op; only the refused thread still holds content", async () => {
    expect(await purgeStoredBodies(db, { athleteId: a })).toMatchObject({ threadsPurged: 0, messagesCleared: 0 });
    const c = await countStoredBodies(db, { athleteId: a });
    expect(c).toMatchObject({ threads: 1, eligibleThreads: 0, refusedThreadIds: [ids.t3] });
  });

  it("--all reaches the other athlete", async () => {
    const r = await purgeStoredBodies(db, { all: true });
    expect(r.threadsPurged).toBe(1);
    expect(await msg(ids.mb)).toMatchObject({ body: null, subject: null, sender_email: pseudonymousSender("z@brand.com") });
  });
});
