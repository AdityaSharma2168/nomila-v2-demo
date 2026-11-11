/**
 * saveThreadDraft.test.ts — the Gmail mirror is opt-in.
 *
 * Generating a draft used to write into the athlete's real Gmail every time, so trying
 * three phrasings wrote three times before they had decided anything — and a Gmail draft
 * nested in the thread is then re-ingested by the poll path and shown in "view full
 * conversation" as if it had been sent. Now: Nomila always saves (so closing the sheet
 * never loses work), and only an explicit "Save as draft" reaches Gmail.
 *
 * Real SQL against in-memory Postgres (PGlite); the Gmail client is mocked.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/integrations/gmail", () => ({
  upsertGmailDraft: jest.fn(async () => "gdraft-1"),
  deleteGmailDraft: jest.fn(async () => true),
}));

import { eq } from "drizzle-orm";
import { saveThreadDraft, clearThreadDraft } from "./saveThreadDraft";
import { upsertGmailDraft, deleteGmailDraft } from "../lib/integrations/gmail";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const upsertMock = upsertGmailDraft as jest.Mock;
const deleteMock = deleteGmailDraft as jest.Mock;

// What every Gmail grant since 2 Aug stores (requested set incl. gmail.compose).
const COMPOSE_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose";
// A grant from before gmail.compose was requested: can send, cannot draft.
const SEND_ONLY_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

let athleteId: string;
let connectionId: string;
let dealId: string;
let threadId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  connectionId = await seedConnection({ athleteId, email: "rileyathlete@gmail.com", scopes: COMPOSE_SCOPES });
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  upsertMock.mockClear();
  upsertMock.mockImplementation(async () => "gdraft-1");
  deleteMock.mockClear();

  // A deal with a thread and one inbound message (the mirror needs a recipient).
  const [deal] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: "Gorjana", deal_type: "social_post", status: "detected",
  }).returning({ id: deals.id });
  dealId = deal.id;

  const [thread] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: dealId, subject: "Partnership",
    external_thread_id: `t-${dealId}`, connected_account_id: connectionId, status: "deal_detected",
  }).returning({ id: inboxThreads.id });
  threadId = thread.id;

  await db.insert(inboxMessages).values({
    thread_id: threadId, athlete_id: athleteId, direction: "inbound",
    sender_email: "avery@solsticejewelry.test", body: "Hi Mia!", received_at: new Date(),
    connected_account_id: connectionId, gmail_thread_id: "gt-1",
    gmail_message_id_header: `<${dealId}@mail.gmail.com>`, external_message_id: `m-${dealId}`,
  });
});

async function storedDraft(): Promise<Record<string, any>> {
  const [row] = await db
    .select({ latest_draft: inboxThreads.latest_draft })
    .from(inboxThreads)
    .where(eq(inboxThreads.id, threadId));
  return row.latest_draft as Record<string, any>;
}

describe("saveThreadDraft", () => {
  it("saves in Nomila without touching Gmail by default", async () => {
    const result = await saveThreadDraft({ athleteId, dealId, body: "A half-written counter." });

    expect(result.ok).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();

    const draft = await storedDraft();
    expect(draft.body).toBe("A half-written counter.");
    expect(draft.gmail_draft).toBe("not_requested");
    expect(draft.gmail_draft_id).toBeUndefined();
  });

  it("writes a Gmail draft when the save is explicit", async () => {
    const result = await saveThreadDraft({
      athleteId, dealId, body: "My counter.", mirrorToGmail: true,
    });

    expect(result.ok).toBe(true);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      connectionId, toEmail: "avery@solsticejewelry.test", body: "My counter.",
    });

    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("saved");
    expect(draft.gmail_draft_id).toBe("gdraft-1");
  });

  it("does not let a later autosave rewrite the Gmail draft", async () => {
    // Press Save as draft on polished copy...
    await saveThreadDraft({ athleteId, dealId, body: "Polished counter.", mirrorToGmail: true });
    upsertMock.mockClear();

    // ...then type half a thought more and close. Gmail must keep the polished copy —
    // pushing the half-written text there is the bug this whole change exists to fix.
    await saveThreadDraft({ athleteId, dealId, body: "Polished counter. And also" });

    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.body).toBe("Polished counter. And also"); // Nomila has the latest
    expect(draft.gmail_draft_id).toBe("gdraft-1");         // the Gmail draft still exists
  });

  it("updates the same Gmail draft when the button is pressed again", async () => {
    await saveThreadDraft({ athleteId, dealId, body: "First.", mirrorToGmail: true });
    upsertMock.mockClear();

    await saveThreadDraft({ athleteId, dealId, body: "Second.", mirrorToGmail: true });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      body: "Second.", existingDraftId: "gdraft-1", // updated, not a second draft
    });
  });

  it("reports unavailable rather than failing when Gmail refuses the draft", async () => {
    // What a grant issued before the gmail.compose scope actually does.
    upsertMock.mockImplementation(async () => null);

    const result = await saveThreadDraft({
      athleteId, dealId, body: "Counter.", mirrorToGmail: true,
    });

    // The app draft still saved — that is the promise the button makes.
    expect(result.ok).toBe(true);
    const draft = await storedDraft();
    expect(draft.body).toBe("Counter.");
    expect(draft.gmail_draft).toBe("unavailable");
    expect(draft.gmail_draft_id).toBeUndefined();
  });

  it("still saves in Nomila when the Gmail call throws", async () => {
    upsertMock.mockImplementation(async () => { throw new Error("network down"); });

    const result = await saveThreadDraft({
      athleteId, dealId, body: "Counter.", mirrorToGmail: true,
    });

    expect(result.ok).toBe(true);
    expect((await storedDraft()).body).toBe("Counter.");
    expect((await storedDraft()).gmail_draft).toBe("unavailable");
  });

  it("rejects an empty body", async () => {
    const result = await saveThreadDraft({ athleteId, dealId, body: "   " });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

/**
 * Plan §4.4: draft save checks exactly ONE row — the one the newest inbound message
 * recorded, else the thread's — and says why it could not reach Gmail, naming the inbox.
 */
describe("saveThreadDraft — which inbox, and why it failed", () => {
  /** Point this test's thread and its message at `connId`; null clears both. */
  async function pointAt(connId: string | null) {
    await db.update(inboxThreads).set({ connected_account_id: connId }).where(eq(inboxThreads.id, threadId));
    await db.update(inboxMessages).set({ connected_account_id: connId }).where(eq(inboxMessages.thread_id, threadId));
  }

  it("active + compose: saved, with no inbox detail", async () => {
    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });
    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("saved");
    expect(draft.gmail_draft_inbox).toBeUndefined();
  });

  it("active but no gmail.compose: scope_missing, Gmail never called, inbox named", async () => {
    const sendOnly = await seedConnection({ athleteId, email: "rileyathlete@rileyathlete.test", scopes: SEND_ONLY_SCOPES });
    await pointAt(sendOnly);

    const result = await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(result.ok).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.body).toBe("Counter.");
    expect(draft.gmail_draft).toBe("scope_missing");
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: sendOnly, email: "rileyathlete@rileyathlete.test" });
    // The PUT route returns this same object as `latest_draft`.
    expect((result as any).latest_draft.gmail_draft_inbox).toEqual(draft.gmail_draft_inbox);
  });

  it("active with NULL scopes cannot draft (matches GET /connections can_draft)", async () => {
    const unknown = await seedConnection({ athleteId, email: "null-scopes@gmail.com" });
    await pointAt(unknown);

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock).not.toHaveBeenCalled();
    expect((await storedDraft()).gmail_draft).toBe("scope_missing");
  });

  it.each(["revoked", "expired"])("%s row: reconnect_required, Gmail never called", async (status) => {
    const dead = await seedConnection({ athleteId, email: `${status}@gmail.com`, status, scopes: COMPOSE_SCOPES });
    await pointAt(dead);

    const result = await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(result.ok).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("reconnect_required");
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: dead, email: `${status}@gmail.com` });
  });

  it("a row that is not this athlete's reads as missing: reconnect_required", async () => {
    const other = await seedAthlete("Someone Else");
    const foreign = await seedConnection({ athleteId: other, email: "other@gmail.com", scopes: COMPOSE_SCOPES });
    await pointAt(foreign);

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("reconnect_required");
    // The id is known; the address is not (never leak another athlete's mailbox).
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: foreign, email: null });
  });

  it("no connection on message or thread (legacy): no_inbox, not a silent skip", async () => {
    await pointAt(null);

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("no_inbox");
    expect(draft.gmail_draft_inbox).toBeUndefined();
  });

  it("no recipient on the thread: still skipped, with the inbox named", async () => {
    await db.update(inboxMessages).set({ sender_email: null }).where(eq(inboxMessages.thread_id, threadId));

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock).not.toHaveBeenCalled();
    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("skipped");
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: connectionId, email: "rileyathlete@gmail.com" });
  });

  it("the message's connection wins over the thread's", async () => {
    const other = await seedConnection({ athleteId, email: "second@gmail.com", scopes: COMPOSE_SCOPES });
    await db.update(inboxMessages).set({ connected_account_id: other }).where(eq(inboxMessages.thread_id, threadId));
    // the thread still points at `connectionId`

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock.mock.calls[0][0].connectionId).toBe(other);
  });

  it("a revoked message row is NOT rescued by an active thread row", async () => {
    const dead = await seedConnection({ athleteId, email: "gone@gmail.com", status: "revoked", scopes: COMPOSE_SCOPES });
    await db.update(inboxMessages).set({ connected_account_id: dead }).where(eq(inboxMessages.thread_id, threadId));

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    expect(upsertMock).not.toHaveBeenCalled();
    expect((await storedDraft()).gmail_draft).toBe("reconnect_required");
  });

  it("Google's 403 insufficient-scopes at call time: scope_missing", async () => {
    upsertMock.mockImplementation(async (p: any) => {
      p.onFailure?.({ status: 403, message: "Request had insufficient authentication scopes." });
      return null;
    });

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("scope_missing");
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: connectionId, email: "rileyathlete@gmail.com" });
  });

  it("any other Gmail failure stays unavailable, with the inbox named", async () => {
    upsertMock.mockImplementation(async (p: any) => {
      p.onFailure?.({ status: 500, message: "Backend Error" });
      return null;
    });

    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    const draft = await storedDraft();
    expect(draft.gmail_draft).toBe("unavailable");
    expect(draft.gmail_draft_inbox).toEqual({ connection_id: connectionId, email: "rileyathlete@gmail.com" });
  });

  it("a later success (or autosave) drops a stale inbox detail", async () => {
    upsertMock.mockImplementation(async () => null);
    await saveThreadDraft({ athleteId, dealId, body: "One.", mirrorToGmail: true });
    expect((await storedDraft()).gmail_draft_inbox).toBeDefined();

    upsertMock.mockImplementation(async () => "gdraft-1");
    await saveThreadDraft({ athleteId, dealId, body: "Two.", mirrorToGmail: true });
    expect((await storedDraft()).gmail_draft_inbox).toBeUndefined();

    upsertMock.mockImplementation(async () => null);
    await saveThreadDraft({ athleteId, dealId, body: "Three.", mirrorToGmail: true });
    await saveThreadDraft({ athleteId, dealId, body: "Four." });
    expect((await storedDraft()).gmail_draft_inbox).toBeUndefined();
  });
});

describe("clearThreadDraft — uses the same inbox as save", () => {
  it("deletes the Gmail draft through the message's connection, not the thread's", async () => {
    const other = await seedConnection({ athleteId, email: "second@gmail.com", scopes: COMPOSE_SCOPES });
    await db.update(inboxMessages).set({ connected_account_id: other }).where(eq(inboxMessages.thread_id, threadId));
    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });

    const result = await clearThreadDraft({ athleteId, dealId });

    expect(result.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith(other, "gdraft-1");
    const [row] = await db.select({ d: inboxThreads.latest_draft }).from(inboxThreads).where(eq(inboxThreads.id, threadId));
    expect(row.d).toBeNull();
  });

  it("still clears locally, without calling Gmail, when that inbox is revoked", async () => {
    await saveThreadDraft({ athleteId, dealId, body: "Counter.", mirrorToGmail: true });
    const dead = await seedConnection({ athleteId, email: "gone@gmail.com", status: "revoked", scopes: COMPOSE_SCOPES });
    await db.update(inboxMessages).set({ connected_account_id: dead }).where(eq(inboxMessages.thread_id, threadId));

    const result = await clearThreadDraft({ athleteId, dealId });

    expect(result.ok).toBe(true);
    expect(deleteMock).not.toHaveBeenCalled();
    const [row] = await db.select({ d: inboxThreads.latest_draft }).from(inboxThreads).where(eq(inboxThreads.id, threadId));
    expect(row.d).toBeNull();
  });
});
