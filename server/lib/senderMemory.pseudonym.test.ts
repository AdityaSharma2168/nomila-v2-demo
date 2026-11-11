/**
 * Sender memory still works when senders are stored as pseudonyms (MAILBOX_ZERO_RETENTION,
 * decision 3: a non-counterparty is kept as `sha256-<hex>@<domain>`). Real SQL on PGlite — the
 * query itself must match the pseudonym for the address rule, split_part for the domain rule,
 * and see a reply on a pseudonymised thread as engagement. No provider is involved.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { agentActions, inboxMessages, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { senderVerdict } from "./senderMemory";
import { pseudonymousSender } from "./mailbox/retention";

let athleteId: string;

async function demotedThread(sender: string, label: string | null = "not_a_deal", minute = 0) {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, status: "archived" } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", platform: "gmail",
    sender_email: pseudonymousSender(sender), received_at: new Date(),
  } as any);
  await db.insert(agentActions).values({
    athlete_id: athleteId, action: "reclassify", thread_id: t.id, reversible: true,
    payload: label ? { athlete_label: label } : {}, created_at: new Date(Date.UTC(2026, 9, 1, 0, minute)),
  } as any);
  return t.id as string;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Memory");
});
afterAll(async () => { await closeTestDb(); });

describe("senderVerdict over pseudonymised senders", () => {
  it("an address the athlete marked not-a-deal twice is muted, matched through its pseudonym", async () => {
    await demotedThread("promo@spam-brand.test");
    await demotedThread("promo@spam-brand.test");
    const v = await senderVerdict(athleteId, "Promo@Spam-Brand.test");
    expect(v).toMatchObject({ muted: true, scope: "sender" });
  });

  it("the domain rule counts pseudonyms at the same domain", async () => {
    await demotedThread("a@bulk-mailer.test");
    await demotedThread("b@bulk-mailer.test");
    await demotedThread("c@bulk-mailer.test");
    const v = await senderVerdict(athleteId, "new-sender@bulk-mailer.test");
    expect(v).toMatchObject({ muted: true, scope: "domain" });
  });

  it("a reply on a pseudonymised thread is engagement — never muted", async () => {
    await demotedThread("friend@replied.test");
    const t = await demotedThread("friend@replied.test");
    await db.update(inboxThreads).set({ status: "read" } as any);
    await db.insert(inboxMessages).values({
      thread_id: t, athlete_id: athleteId, direction: "outbound", platform: "gmail", received_at: new Date(),
    } as any);
    expect(await senderVerdict(athleteId, "friend@replied.test")).toBeNull();
  });
});
