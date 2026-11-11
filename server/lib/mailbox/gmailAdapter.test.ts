/**
 * gmailAdapter.test.ts — the Gmail MailboxAdapter against a mocked fetch (never Google).
 *
 * Proves the provider-neutral contract on the Gmail side: messages normalised (text,
 * oldest-first, direction from the account's OWN address — not labels), drafts/spam
 * dropped, attachments addressed by partId, and Gmail's HTTP answers mapped onto the four
 * shared error kinds. An inactive connection is `disconnected` without a network call.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../integrations/gmail", () => ({
  refreshTokenIfNeeded: jest.fn(async () => "tok"),
}));

import { gmailAdapter } from "./gmailAdapter";
import { MailboxError } from "./types";
import { refreshTokenIfNeeded } from "../integrations/gmail";
import { initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const refreshMock = refreshTokenIfNeeded as jest.Mock;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

function gmailMsg(id: string, from: string, text: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    threadId: "t1",
    internalDate: String(Date.UTC(2026, 9, 1, 0, minute)),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: "Collab?" },
        { name: "Message-ID", value: `<${id}@mail>` },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { data: b64(text) } },
        { partId: "1", mimeType: "application/pdf", filename: "brief.pdf", body: { attachmentId: "ATT-volatile", size: 1234 } },
      ],
    },
    ...extra,
  };
}

let fetchMock: jest.Mock;
let accountId: string;
let athleteId: string;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  accountId = await seedConnection({ athleteId, platform: "gmail", email: "Me@Example.com" });
});
afterAll(async () => { await closeTestDb(); });

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as any).fetch = fetchMock;
  refreshMock.mockReset().mockResolvedValue("tok");
});

describe("gmailAdapter.fetchConversation", () => {
  it("normalises, orders by sent time, decides direction by own address, drops drafts", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, {
      messages: [
        gmailMsg("m2", "Me <me@example.com>", "my reply", 2, { labelIds: ["SENT"] }),
        gmailMsg("m1", "Jordan Lee <jordan@acme.com>", "the pitch", 1),
        gmailMsg("m3", "Me <me@example.com>", "half-written", 3, { labelIds: ["DRAFT"] }),
      ],
    }));
    const msgs = await gmailAdapter.fetchConversation(accountId, "t1");
    expect(msgs.map((m) => m.ref.messageRef)).toEqual(["m1", "m2"]);
    expect(msgs.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(msgs[0]).toMatchObject({
      text: "the pitch",
      fromEmail: "jordan@acme.com",
      fromName: "Jordan Lee",
      ref: { provider: "gmail", accountId, conversationRef: "t1", internetMessageId: "<m1@mail>" },
      attachments: [{ attachmentRef: "1", filename: "brief.pdf", mimeType: "application/pdf", size: 1234, kind: "file" }],
    });
  });

  it.each([
    [404, {}, "not_found"],
    [400, { error: { message: "Invalid id value" } }, "not_found"],
    [401, {}, "disconnected"],
    [403, { error: { errors: [{ reason: "insufficientPermissions" }] } }, "disconnected"],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "rate_limited"],
    [429, {}, "rate_limited"],
    [503, {}, "transient"],
  ])("HTTP %i → %s", async (status, body, kind) => {
    fetchMock.mockResolvedValueOnce(respond(status as number, body));
    await expect(gmailAdapter.fetchConversation(accountId, "t1")).rejects.toMatchObject({ kind });
  });

  it("a network failure is transient", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(gmailAdapter.fetchConversation(accountId, "t1")).rejects.toMatchObject({ kind: "transient" });
  });

  it("a dead grant is disconnected", async () => {
    refreshMock.mockRejectedValueOnce(new Error("Google token refresh failed: invalid_grant"));
    await expect(gmailAdapter.fetchConversation(accountId, "t1")).rejects.toMatchObject({ kind: "disconnected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an inactive connection is disconnected without any network call", async () => {
    const revoked = await seedConnection({ athleteId, platform: "gmail", status: "revoked" });
    await expect(gmailAdapter.fetchConversation(revoked, "t1")).rejects.toBeInstanceOf(MailboxError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("gmailAdapter.fetchMessage / fetchAttachment / search", () => {
  it("a trashed message reads as deleted", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, gmailMsg("m1", "a@b.com", "x", 1, { labelIds: ["TRASH"] })));
    await expect(gmailAdapter.fetchMessage(accountId, "m1")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("re-resolves the attachment by partId and returns bytes", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, gmailMsg("m1", "a@b.com", "x", 1)))
      .mockResolvedValueOnce(respond(200, { data: Buffer.from("%PDF").toString("base64") }));
    const got = await gmailAdapter.fetchAttachment(accountId, "m1", "1", { maxBytes: 10_000 });
    expect(got).toMatchObject({ kind: "bytes", filename: "brief.pdf" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/attachments/ATT-volatile");
  });

  it("over the caller's cap is not_downloadable, without downloading", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, gmailMsg("m1", "a@b.com", "x", 1)));
    await expect(gmailAdapter.fetchAttachment(accountId, "m1", "1", { maxBytes: 10 }))
      .resolves.toEqual({ kind: "not_downloadable", reason: "too_large" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("translates the structured query to q", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { messages: [{ id: "m9" }] }))
      .mockResolvedValueOnce(respond(200, { id: "m9", threadId: "t9", snippet: "usage rights…", internalDate: "0", payload: { headers: [{ name: "From", value: "x@hoka.com" }] } }));
    const hits = await gmailAdapter.search(accountId, {
      text: "usage rights", from: "hoka.com", after: new Date(Date.UTC(2026, 0, 2)), hasAttachment: true, limit: 5,
    });
    const q = decodeURIComponent(String(fetchMock.mock.calls[0][0]).split("q=")[1]);
    expect(q).toBe(`"usage rights" from:hoka.com after:2026/1/2 has:attachment`);
    expect(hits[0]).toMatchObject({ senderDomain: "hoka.com", snippet: "usage rights…", ref: { messageRef: "m9", conversationRef: "t9" } });
  });
});
