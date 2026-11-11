/**
 * sendGmailReply construction tests — the real module with global fetch mocked
 * (no Gmail API) and the token read served by in-memory Postgres (no Cloud
 * SQL; the seeded token is unexpired so no refresh round-trip happens).
 *
 * Covers the RFC 2822 pieces threading depends on: In-Reply-To / References
 * headers, the threadId in the send body, and the retry-without-threadId path
 * for threadIds that don't exist in the sending mailbox.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { sendGmailReply } from "./gmail";
import { initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const realFetch = global.fetch;
let fetchMock: jest.Mock;
let connectionId: string;

interface SentRequest { url: string; body: any; }
let sendRequests: SentRequest[];

// Per-test hook: return a non-ok response for the Nth send call (1-based).
let failSendCall: { call: number; message: string } | null;

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload } as Response;
}

beforeAll(async () => {
  await initTestDb();
  const athleteId = await seedAthlete();
  connectionId = await seedConnection({ athleteId, email: "sender@gmail.com" });

  fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/messages/send")) {
      const body = JSON.parse(String(init?.body));
      sendRequests.push({ url, body });
      if (failSendCall && sendRequests.length === failSendCall.call) {
        return jsonResponse({ error: { message: failSendCall.message } }, false, 404);
      }
      return jsonResponse({ id: "sent-1" });
    }
    if (url.includes("/messages/sent-1")) {
      // Read-back of the sent message to learn the Message-ID Gmail assigned.
      return jsonResponse({
        threadId: "gt-1",
        payload:  { headers: [{ name: "Message-ID", value: "<assigned@mail.gmail.com>" }] },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  (global as any).fetch = fetchMock;
});

afterAll(async () => {
  (global as any).fetch = realFetch;
  await closeTestDb();
});

beforeEach(() => {
  sendRequests = [];
  failSendCall = null;
});

function decodeRaw(body: any): string {
  return Buffer.from(body.raw, "base64url").toString("utf-8");
}

describe("sendGmailReply — RFC 2822 threading construction", () => {
  it("sends In-Reply-To, the full References chain, and the threadId", async () => {
    const result = await sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-1",
      messageIdHeader: "<m2@acme>",
      references:      ["<m1@acme>", "<m2@acme>"],
    });

    expect(sendRequests).toHaveLength(1);
    expect(sendRequests[0].body.threadId).toBe("gt-1");

    const raw = decodeRaw(sendRequests[0].body);
    expect(raw).toContain("To: brand@acme.com");
    expect(raw).toContain("Subject: Re: Sponsorship");
    expect(raw).toContain("In-Reply-To: <m2@acme>");
    expect(raw).toContain("References: <m1@acme> <m2@acme>");
    expect(raw.endsWith("Deal!")).toBe(true);

    // Returns the Message-ID Gmail assigned so the next reply can chain off it.
    expect(result).toBe("<assigned@mail.gmail.com>");
  });

  it("falls back to the parent Message-ID as References when no chain is given", async () => {
    await sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-1",
      messageIdHeader: "<only@acme>",
    });

    const raw = decodeRaw(sendRequests[0].body);
    expect(raw).toContain("In-Reply-To: <only@acme>");
    expect(raw).toContain("References: <only@acme>");
  });

  it("omits threading headers entirely when no Message-ID is available", async () => {
    await sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-1",
      messageIdHeader: null,
    });

    const raw = decodeRaw(sendRequests[0].body);
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
    expect(sendRequests[0].body.threadId).toBe("gt-1"); // server-side grouping still requested
  });

  it("does not double the Re: prefix", async () => {
    await sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Re: Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-1",
      messageIdHeader: "<m@acme>",
    });

    expect(decodeRaw(sendRequests[0].body)).toContain("Subject: Re: Sponsorship");
    expect(decodeRaw(sendRequests[0].body)).not.toContain("Re: Re:");
  });

  it("retries without threadId when the threadId isn't in the sending mailbox", async () => {
    failSendCall = { call: 1, message: "Requested entity was not found." };

    await sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-foreign",
      messageIdHeader: "<m@acme>",
    });

    expect(sendRequests).toHaveLength(2);
    expect(sendRequests[0].body.threadId).toBe("gt-foreign");
    expect(sendRequests[1].body.threadId).toBeUndefined();
    // The reply still threads for the recipient via the RFC headers.
    expect(decodeRaw(sendRequests[1].body)).toContain("In-Reply-To: <m@acme>");
  });

  it("throws on a hard send failure", async () => {
    failSendCall = { call: 1, message: "Insufficient Permission" };

    await expect(sendGmailReply({
      connectionId,
      toEmail:         "brand@acme.com",
      subject:         "Sponsorship",
      body:            "Deal!",
      gmailThreadId:   "gt-1",
      messageIdHeader: "<m@acme>",
    })).rejects.toThrow(/Gmail send failed/);

    expect(sendRequests).toHaveLength(1); // no blind retry on non-threadId errors
  });
});
