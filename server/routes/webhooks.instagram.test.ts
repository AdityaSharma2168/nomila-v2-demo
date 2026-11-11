/**
 * Instagram webhook: a DM holding only an attachment no longer vanishes (owner, 4 Nov 2026).
 *  - attachment-only → a message on the thread with a placeholder body and the attachment metadata; detectDeal NOT called;
 *  - text + attachment → detectDeal gets the text (and the metadata);
 *  - an unknown payload → a dead letter, not a silent skip.
 * The Graph lookup (resolveDmContext) and detectDeal are mocked: nothing reaches a provider. Thread/message writes are
 * real (PGlite).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

const mockDetect = jest.fn();
jest.mock("../skills/dealDetector", () => ({ detectDeal: (...a: unknown[]) => mockDetect(...a) }));
const mockResolve = jest.fn();
jest.mock("../lib/integrations/instagram", () => ({ resolveDmContext: (...a: unknown[]) => mockResolve(...a) }));

import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, desc, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { gmailDeadLetters, inboxMessages, inboxThreads } from "../../shared/schema";
import { describeIgMessage, notPlaceholderOnly } from "../lib/integrations/instagramAttachments";

const SECRET = "test-ig-app-secret";
const IG_ACCOUNT = "ig-acct-attach-test";
const SIGNED_URL = "https://lookaside.fbsbx.example/ig_messaging_cdn/?asset_id=asset-123&signature=SIG-SECRET";
let server: Server;
let base: string;
let athleteId: string;
let connId: string;

async function postIg(payload: object): Promise<number> {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const res = await fetch(`${base}/api/webhooks/instagram`, {
    method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body,
  });
  return res.status;
}

const dm = (mid: string, message: Record<string, unknown>) => ({
  object: "instagram",
  entry: [{ id: IG_ACCOUNT, time: 1_780_000_000_000, messaging: [{
    sender: { id: "sender-1" }, recipient: { id: IG_ACCOUNT }, timestamp: 1_780_000_000_000, message: { mid, ...message },
  }] }],
});

async function waitFor<T>(read: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting for the webhook's background work");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const messageRow = (mid: string) => db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, mid)).then((r) => r[0]);

beforeAll(async () => {
  process.env.INSTAGRAM_LOGIN_APP_SECRET = SECRET;
  await initTestDb();
  athleteId = await seedAthlete("Attachment Receipt Athlete");
  connId = await seedConnection({ athleteId, platform: "instagram", email: "attach_athlete", platformUserId: IG_ACCOUNT });
  const { default: webhooksRouter } = await import("./webhooks");
  const app = express();
  app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.INSTAGRAM_LOGIN_APP_SECRET;
});

beforeEach(() => {
  mockDetect.mockReset().mockResolvedValue({ skipped: false, reason: "ok" });
  mockResolve.mockReset().mockResolvedValue({ conversationId: "conv-attach-1", senderName: "Brand Person" });
});

it("an attachment-only DM lands on the thread as a placeholder message with its metadata, and is never classified", async () => {
  expect(await postIg(dm("mid-photo", { attachments: [{ type: "image", payload: { url: SIGNED_URL } }] }))).toBe(200);
  const row = await waitFor(() => messageRow("mid-photo"));

  expect(row.body).toBe("[Photo]");
  expect(row.direction).toBe("inbound");
  expect(row.platform).toBe("instagram");
  expect(row.sender_ig_user_id).toBe("sender-1");
  expect(row.attachments).toEqual([expect.objectContaining({ ig_type: "image", ig_media_id: "asset-123", bytes: 0 })]);
  // The signed, expiring CDN url is never stored: only the asset id.
  expect(row.attachments?.[0]).not.toHaveProperty("attachment_ref");
  expect(JSON.stringify(row.attachments)).not.toContain("signature");

  const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, row.thread_id));
  expect(thread.external_thread_id).toBe("conv-attach-1");
  expect(thread.status).toBe("unread");
  expect(thread.message_count).toBe(1);
  expect(thread.classification).toBeNull();
  expect(mockDetect).not.toHaveBeenCalled();

  // Redelivery is idempotent: still one message.
  expect(await postIg(dm("mid-photo", { attachments: [{ type: "image", payload: { url: SIGNED_URL } }] }))).toBe(200);
  await new Promise((r) => setTimeout(r, 200));
  const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "mid-photo"));
  expect(rows).toHaveLength(1);
});

it("the classifier's 'newest inbound message' skips a placeholder-only row and finds the text the sender wrote", async () => {
  const photo = await waitFor(() => messageRow("mid-photo"));
  expect(photo.attachments?.every((a) => a.placeholder === true)).toBe(true);
  await db.insert(inboxMessages).values({
    thread_id: photo.thread_id, athlete_id: athleteId, direction: "inbound", platform: "instagram",
    body: "Hi! Would you post for our launch?", external_message_id: "mid-earlier-text",
    received_at: new Date(photo.received_at!.getTime() - 60_000),
  });
  const [newest] = await db.select({ body: inboxMessages.body }).from(inboxMessages)
    .where(and(eq(inboxMessages.thread_id, photo.thread_id), eq(inboxMessages.direction, "inbound"), notPlaceholderOnly))
    .orderBy(desc(inboxMessages.received_at)).limit(1);
  expect(newest.body).toBe("Hi! Would you post for our launch?");
});

it("a story reply with no text and a share land on the SAME thread with their own placeholders", async () => {
  await postIg(dm("mid-story", { reply_to: { story: { url: "https://cdn.example/story.mp4", id: "story-9" } } }));
  await postIg(dm("mid-share", { attachments: [{ type: "ig_post", payload: { ig_post_media_id: "post-7", title: "x" } }] }));
  const story = await waitFor(() => messageRow("mid-story"));
  const share = await waitFor(() => messageRow("mid-share"));
  expect(story.body).toBe("[Story reply]");
  expect(story.attachments).toEqual([expect.objectContaining({ ig_type: "story_reply", ig_media_id: "story-9" })]);
  expect(JSON.stringify(story.attachments)).not.toContain("cdn.example");
  expect(share.body).toBe("[Shared post]");
  expect(share.attachments).toEqual([expect.objectContaining({ ig_type: "ig_post", ig_media_id: "post-7" })]);
  expect(share.thread_id).toBe(story.thread_id);
  expect(mockDetect).not.toHaveBeenCalled();
});

it("a text + attachment DM goes to deal detection with its text, and the attachment metadata rides along", async () => {
  await postIg(dm("mid-text-photo", { text: "  Loved your post, rates?  ", attachments: [{ type: "video", payload: { url: "https://cdn.example/v.mp4" } }] }));
  await waitFor(async () => (mockDetect.mock.calls.length > 0 ? true : undefined));
  const msg = mockDetect.mock.calls[0][0].message;
  expect(msg.body).toBe("Loved your post, rates?");
  expect(msg.gmailMessageId).toBe("mid-text-photo");
  expect(msg.attachments).toEqual([expect.objectContaining({ ig_type: "video" })]);
  expect(msg.attachments[0].placeholder).toBeUndefined(); // it has text: not a placeholder-only message
  expect(JSON.stringify(msg.attachments)).not.toContain("cdn.example");
  expect(await messageRow("mid-text-photo")).toBeUndefined(); // detectDeal (mocked) owns the write
});

it("an unknown attachment type is dead-lettered, not recorded as a message and not classified", async () => {
  await postIg(dm("mid-hologram", { attachments: [{ type: "hologram", payload: {} }] }));
  const dl = await waitFor(() => db.select().from(gmailDeadLetters)
    .where(and(eq(gmailDeadLetters.connected_account_id, connId), eq(gmailDeadLetters.gmail_message_id, "mid-hologram")))
    .then((r) => r[0]));
  expect(dl.athlete_id).toBe(athleteId);
  expect(dl.error).toContain("unknown attachment type: hologram");
  expect(await messageRow("mid-hologram")).toBeUndefined();
  expect(mockDetect).not.toHaveBeenCalled();
});

describe("describeIgMessage", () => {
  it("maps the documented types to plain placeholders", () => {
    const one = (type: string) => describeIgMessage({ attachments: [{ type, payload: {} }] });
    expect(one("image")).toMatchObject({ kind: "placeholder", placeholder: "[Photo]" });
    expect(one("video")).toMatchObject({ kind: "placeholder", placeholder: "[Video]" });
    expect(one("file")).toMatchObject({ kind: "placeholder", placeholder: "[File]" });
    expect(one("share")).toMatchObject({ kind: "placeholder", placeholder: "[Shared post]" });
    expect(describeIgMessage({ attachments: [{ type: "image" }, { type: "video" }] })).toMatchObject({ placeholder: "[Photo] [Video]" });
  });
  it("an unsend is not a message; an empty message is unknown", () => {
    expect(describeIgMessage({ is_deleted: true })).toEqual({ kind: "deleted" });
    expect(describeIgMessage({})).toEqual({ kind: "unknown", reason: "no text and no attachment" });
    expect(describeIgMessage({ is_unsupported: true })).toMatchObject({ kind: "placeholder", placeholder: "[Unsupported attachment]" });
  });
});
