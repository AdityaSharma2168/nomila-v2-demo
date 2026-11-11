/**
 * outlookAdapter.test.ts — the Outlook MailboxAdapter against a fake Microsoft Graph on
 * global fetch (never Microsoft).
 *
 * Proves the provider-neutral contract on the Outlook side: plain-text bodies asked for
 * with Prefer, conversations filtered by conversationId and sorted HERE, drafts / Junk /
 * Deleted Items dropped, direction from the account's own addresses, DEFAULT ids (no
 * ImmutableId preference — stored ids must keep matching), a cloud-link attachment that
 * is never downloaded, a size gate before any bytes, KQL search, and Graph's HTTP answers
 * mapped onto the four shared error kinds (Retry-After carried on rate_limited).
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../integrations/outlook", () => ({
  getAccessToken: jest.fn(async () => "tok"),
}));

import { outlookAdapter, outlookKql, clearOutlookAccountCacheForTests } from "./outlookAdapter";
import { MailboxError } from "./types";
import { withMailboxRetry } from "./index";
import { getAccessToken } from "../integrations/outlook";
import { initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const tokenMock = getAccessToken as jest.Mock;

const DELETED = "FOLDER-deleted";
const JUNK = "FOLDER-junk";
const INBOX = "FOLDER-inbox";

function graphMsg(id: string, from: [string, string], text: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: "Collab?",
    from: { emailAddress: { name: from[0], address: from[1] } },
    receivedDateTime: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
    body: { contentType: "text", content: `${text}\n\nOn Tue, Jordan wrote:\n> old stuff` },
    conversationId: "AAQkConv/1=",
    internetMessageId: `<${id}@mail>`,
    hasAttachments: false,
    isDraft: false,
    parentFolderId: INBOX,
    ...extra,
  };
}

type Route = (url: URL) => { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } | undefined;

let routes: Route[];
let seen: { url: URL; headers: Record<string, string> }[];
let accountId: string;
let athleteId: string;

/** Account facts every read asks for (own address + hidden folders); cached per account. */
const accountFacts: Route = (u) => {
  if (u.pathname.endsWith("/me")) return { status: 200, body: { mail: "Me@Example.com", userPrincipalName: "me@tenant.onmicrosoft.com" } };
  if (u.pathname.endsWith("/mailFolders/deleteditems")) return { status: 200, body: { id: DELETED } };
  if (u.pathname.endsWith("/mailFolders/junkemail")) return { status: 200, body: { id: JUNK } };
  return undefined;
};

function installFetch() {
  (globalThis as any).fetch = jest.fn(async (input: any, init: any) => {
    const url = new URL(String(input));
    seen.push({ url, headers: init?.headers ?? {} });
    for (const r of [accountFacts, ...routes]) {
      const hit = r(url);
      if (!hit) continue;
      const headers = new Headers(hit.headers ?? {});
      return {
        ok: hit.status >= 200 && hit.status < 300,
        status: hit.status,
        headers,
        json: async () => hit.body ?? {},
        arrayBuffer: async () => {
          const b = hit.bytes ?? Buffer.alloc(0);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      } as any;
    }
    throw new Error(`unexpected Graph call ${url}`);
  });
}

/** Graph calls other than the cached account facts. */
const mailCalls = () => seen.filter((c) => !/\/me$|\/mailFolders\//.test(c.url.pathname));

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  accountId = await seedConnection({ athleteId, platform: "outlook", email: "me@example.com" });
});
afterAll(async () => { await closeTestDb(); });

beforeEach(() => {
  routes = [];
  seen = [];
  clearOutlookAccountCacheForTests();
  installFetch();
  tokenMock.mockReset().mockResolvedValue("tok");
});

describe("outlookAdapter.fetchConversation", () => {
  it("filters by conversationId, sorts client-side, drops drafts/junk/deleted, direction by own address", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? {
      status: 200,
      body: {
        value: [
          graphMsg("m2", ["Me", "me@tenant.onmicrosoft.com"], "my reply", 2),
          graphMsg("m1", ["Jordan Lee", "jordan@acme.com"], "the pitch", 1, { hasAttachments: true }),
          graphMsg("m3", ["Me", "me@example.com"], "half-written", 3, { isDraft: true }),
          graphMsg("m4", ["Spam", "x@spam.com"], "junk", 0, { parentFolderId: JUNK }),
          graphMsg("m5", ["Jordan Lee", "jordan@acme.com"], "deleted", 4, { parentFolderId: DELETED }),
        ],
      },
    } : undefined);
    routes.push((u) => u.pathname.endsWith("/messages/m1/attachments") ? {
      status: 200,
      body: { value: [
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "ATT/1+=", name: "brief.pdf", contentType: "application/pdf", size: 1234, isInline: false },
        { "@odata.type": "#microsoft.graph.referenceAttachment", id: "ATT/2", name: "deck.pptx", contentType: null, size: 300, isInline: false },
      ] },
    } : undefined);

    const msgs = await outlookAdapter.fetchConversation(accountId, "AAQkConv/1=");

    const list = mailCalls()[0];
    expect(list.url.searchParams.get("$filter")).toBe("conversationId eq 'AAQkConv/1='");
    expect(list.url.searchParams.get("$orderby")).toBeNull();
    expect(list.headers.Prefer).toBe('outlook.body-content-type="text"');
    expect(JSON.stringify(seen.map((c) => c.headers))).not.toMatch(/ImmutableId/);

    expect(msgs.map((m) => m.ref.messageRef)).toEqual(["m1", "m2"]);
    expect(msgs.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(msgs[0]).toMatchObject({
      text: "the pitch",
      from: "Jordan Lee <jordan@acme.com>",
      fromEmail: "jordan@acme.com",
      fromName: "Jordan Lee",
      ref: { provider: "outlook", accountId, conversationRef: "AAQkConv/1=", internetMessageId: "<m1@mail>" },
      attachments: [
        { attachmentRef: "ATT/1+=", filename: "brief.pdf", mimeType: "application/pdf", size: 1234, kind: "file" },
        { attachmentRef: "ATT/2", filename: "deck.pptx", mimeType: "application/octet-stream", size: 300, kind: "link" },
      ],
    });
    // hasAttachments:false means no attachment call for m2.
    expect(mailCalls().some((c) => c.url.pathname.includes("/messages/m2/attachments"))).toBe(false);
  });

  it("prefers uniqueBody and flattens an html body a server returned anyway", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? {
      status: 200,
      body: { value: [
        graphMsg("m1", ["J", "j@acme.com"], "ignored", 1, { uniqueBody: { contentType: "html", content: "<div><p>Only the <b>new</b> part</p></div>" } }),
      ] },
    } : undefined);
    const [m] = await outlookAdapter.fetchConversation(accountId, "c");
    expect(m.text).toBe("Only the new part");
  });

  it("follows @odata.nextLink pages", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") && !u.searchParams.has("$skiptoken") ? {
      status: 200,
      body: { value: [graphMsg("m2", ["J", "j@acme.com"], "b", 2)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=X" },
    } : undefined);
    routes.push((u) => u.searchParams.get("$skiptoken") === "X" ? {
      status: 200, body: { value: [graphMsg("m1", ["J", "j@acme.com"], "a", 1)] },
    } : undefined);
    const msgs = await outlookAdapter.fetchConversation(accountId, "c");
    expect(msgs.map((m) => m.ref.messageRef)).toEqual(["m1", "m2"]);
  });

  it("an empty conversation is not_found", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? { status: 200, body: { value: [] } } : undefined);
    await expect(outlookAdapter.fetchConversation(accountId, "c")).rejects.toMatchObject({ kind: "not_found" });
  });

  it.each([
    [401, { error: { code: "InvalidAuthenticationToken" } }, "disconnected"],
    [403, { error: { code: "ErrorAccessDenied" } }, "disconnected"],
    [404, { error: { code: "ErrorItemNotFound" } }, "not_found"],
    [400, { error: { code: "ErrorInvalidIdMalformed" } }, "not_found"],
    [429, { error: { code: "ApplicationThrottled" } }, "rate_limited"],
    [503, {}, "transient"],
    [500, {}, "transient"],
  ])("HTTP %i → %s", async (status, body, kind) => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? { status: status as number, body } : undefined);
    await expect(outlookAdapter.fetchConversation(accountId, "c")).rejects.toMatchObject({ kind });
  });

  it("429 carries Retry-After, and withMailboxRetry waits it out then succeeds", async () => {
    let n = 0;
    routes.push((u) => {
      if (!u.pathname.endsWith("/me/messages")) return undefined;
      return n++ === 0
        ? { status: 429, headers: { "retry-after": "0.02" }, body: {} }
        : { status: 200, body: { value: [graphMsg("m1", ["J", "j@acme.com"], "a", 1)] } };
    });
    const err = await outlookAdapter.fetchConversation(accountId, "c").catch((e) => e);
    expect(err).toBeInstanceOf(MailboxError);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterMs: 20 });

    const started = Date.now();
    n = 0;
    const msgs = await withMailboxRetry(() => outlookAdapter.fetchConversation(accountId, "c"), { baseMs: 1 });
    expect(msgs).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("a Retry-After longer than the cap is final now — no held-open request", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? { status: 429, headers: { "retry-after": "120" }, body: {} } : undefined);
    await expect(withMailboxRetry(() => outlookAdapter.fetchConversation(accountId, "c"), { baseMs: 1 }))
      .rejects.toMatchObject({ kind: "rate_limited" });
    expect(mailCalls()).toHaveLength(1);
  });

  it("a network failure is transient", async () => {
    routes.push((u) => { if (u.pathname.endsWith("/me/messages")) throw new Error("ECONNRESET"); return undefined; });
    await expect(outlookAdapter.fetchConversation(accountId, "c")).rejects.toMatchObject({ kind: "transient" });
  });

  it("a dead grant is disconnected, without a Graph call", async () => {
    tokenMock.mockRejectedValueOnce(new Error("Outlook token refresh failed: AADSTS70000 invalid_grant"));
    await expect(outlookAdapter.fetchConversation(accountId, "c")).rejects.toMatchObject({ kind: "disconnected" });
    expect(seen).toHaveLength(0);
  });

  it("an inactive or non-Outlook connection is disconnected without any call", async () => {
    const revoked = await seedConnection({ athleteId, platform: "outlook", status: "revoked" });
    const gmail = await seedConnection({ athleteId, platform: "gmail" });
    await expect(outlookAdapter.fetchConversation(revoked, "c")).rejects.toMatchObject({ kind: "disconnected" });
    await expect(outlookAdapter.fetchConversation(gmail, "c")).rejects.toMatchObject({ kind: "disconnected" });
    expect(seen).toHaveLength(0);
    expect(tokenMock).not.toHaveBeenCalled();
  });
});

describe("outlookAdapter.fetchMessage", () => {
  it("reads a stored DEFAULT id as-is (URL-encoded), with no ImmutableId preference", async () => {
    routes.push((u) => decodeURIComponent(u.pathname).endsWith("/me/messages/AAMk/a+b=")
      ? { status: 200, body: graphMsg("AAMk/a+b=", ["J", "j@acme.com"], "hello", 1) } : undefined);
    const m = await outlookAdapter.fetchMessage(accountId, "AAMk/a+b=");
    expect(m.ref.messageRef).toBe("AAMk/a+b=");
    expect(mailCalls()[0].url.pathname).toContain("AAMk%2Fa%2Bb%3D");
    expect(JSON.stringify(seen.map((c) => c.headers))).not.toMatch(/IdType/);
  });

  it("a moved message (its old default id now 404s) degrades to not_found", async () => {
    routes.push((u) => u.pathname.includes("/me/messages/") ? { status: 404, body: { error: { code: "ErrorItemNotFound" } } } : undefined);
    await expect(outlookAdapter.fetchMessage(accountId, "old-id")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("a message in Deleted Items reads as deleted", async () => {
    routes.push((u) => u.pathname.includes("/me/messages/") ? { status: 200, body: graphMsg("m1", ["J", "j@acme.com"], "x", 1, { parentFolderId: DELETED }) } : undefined);
    await expect(outlookAdapter.fetchMessage(accountId, "m1")).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("outlookAdapter.fetchAttachment", () => {
  const list = (value: unknown[]): Route => (u) =>
    u.pathname.endsWith("/messages/m1/attachments") ? { status: 200, body: { value } } : undefined;
  const pdf = { "@odata.type": "#microsoft.graph.fileAttachment", id: "A/1=", name: "brief.pdf", contentType: "application/pdf", size: 8, isInline: false };

  it("gates on size from metadata ($select, no contentBytes), then downloads raw bytes via /$value", async () => {
    routes.push(list([pdf]));
    routes.push((u) => decodeURIComponent(u.pathname).endsWith("/attachments/A/1=/$value") ? { status: 200, bytes: Buffer.from("%PDF-1.4") } : undefined);
    const got = await outlookAdapter.fetchAttachment(accountId, "m1", "A/1=", { maxBytes: 10_000 });
    expect(got).toMatchObject({ kind: "bytes", filename: "brief.pdf", mimeType: "application/pdf" });
    expect(got.kind === "bytes" && got.bytes.toString()).toBe("%PDF-1.4");
    expect(mailCalls()[0].url.searchParams.get("$select")).toBe("id,name,contentType,size,isInline");
  });

  it("a cloud link (referenceAttachment) is not_downloadable/link, never fetched", async () => {
    routes.push(list([{ "@odata.type": "#microsoft.graph.referenceAttachment", id: "R1", name: "contract.docx", size: 100 }]));
    await expect(outlookAdapter.fetchAttachment(accountId, "m1", "R1", { maxBytes: 10_000 }))
      .resolves.toEqual({ kind: "not_downloadable", reason: "link" });
    expect(mailCalls().some((c) => c.url.pathname.endsWith("/$value"))).toBe(false);
  });

  it("a 405 on /$value is not_downloadable/link", async () => {
    routes.push(list([pdf]));
    routes.push((u) => u.pathname.endsWith("/$value") ? { status: 405, body: {} } : undefined);
    await expect(outlookAdapter.fetchAttachment(accountId, "m1", "A/1=", { maxBytes: 10_000 }))
      .resolves.toEqual({ kind: "not_downloadable", reason: "link" });
  });

  it("over the caller's cap is not_downloadable/too_large, without downloading", async () => {
    routes.push(list([{ ...pdf, size: 50_000_000 }]));
    await expect(outlookAdapter.fetchAttachment(accountId, "m1", "A/1=", { maxBytes: 10_000 }))
      .resolves.toEqual({ kind: "not_downloadable", reason: "too_large" });
    expect(mailCalls()).toHaveLength(1);
  });

  it("an attachment no longer on the message is not_found", async () => {
    routes.push(list([pdf]));
    await expect(outlookAdapter.fetchAttachment(accountId, "m1", "gone", { maxBytes: 10_000 }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("outlookAdapter.search", () => {
  it("translates the structured query to KQL", () => {
    expect(outlookKql({
      text: 'usage "rights" (exclusive)', from: "hoka.com", after: new Date(Date.UTC(2026, 0, 2)),
      before: new Date(Date.UTC(2026, 1, 3)), hasAttachment: true, limit: 5,
    })).toBe("usage rights exclusive from:hoka.com received>=2026-01-02 received<2026-02-03 hasAttachments:true");
    expect(outlookKql({ text: "from:evil OR x", limit: 5 })).toBe("from evil OR x");
  });

  it("sends $search with the KQL quoted, caps $top, and maps hits", async () => {
    routes.push((u) => u.pathname.endsWith("/me/messages") ? {
      status: 200,
      body: { value: [{
        id: "m9", conversationId: "c9", internetMessageId: "<m9@x>", bodyPreview: "usage rights…",
        receivedDateTime: "2026-01-05T00:00:00Z", from: { emailAddress: { name: "Hoka", address: "deals@hoka.com" } },
      }] },
    } : undefined);
    const hits = await outlookAdapter.search(accountId, { text: "usage rights", from: "hoka.com", limit: 500 });
    const call = mailCalls()[0].url;
    expect(call.searchParams.get("$search")).toBe('"usage rights from:hoka.com"');
    expect(call.searchParams.get("$top")).toBe("25");
    expect(hits).toEqual([{
      ref: { provider: "outlook", accountId, messageRef: "m9", conversationRef: "c9", internetMessageId: "<m9@x>" },
      senderDomain: "hoka.com",
      sentAt: "2026-01-05T00:00:00.000Z",
      snippet: "usage rights…",
    }]);
  });
});
