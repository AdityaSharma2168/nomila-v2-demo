/**
 * inboundMail.test.ts — the partner inbox's pure parts (the reply plus-address, the sender address, header and body
 * parsing, quoted-history stripping across common clients) and the Gmail boundary: a token for the partner mailbox and
 * gmail.modify only, the unprocessed query, metadata-only envelope reads, and the processed label (created once).
 * Google is never reached: the delegated token and fetch are stubs.
 */
// Pure functions only: a stub db (not PGlite, whose WASM boot would outlive this suite).
jest.mock("../../db", () => ({ db: {}, pool: { end: async () => {}, on: () => {} } }));
const delegatedToken = jest.fn(async (_a: string, _s: string) => "tok-partner");
const dropToken = jest.fn();
jest.mock("../../lib/gmailSender", () => ({
  ...jest.requireActual("../../lib/gmailSender"),
  getDelegatedGmailToken: (a: string, s: string) => delegatedToken(a, s),
  getGmailSender: () => ({ dropToken }),
}));
import { addressOf, addressesIn, envelopeOf, gmailPartnerInbox, replyTokenIn, stripQuoted, textOfPayload } from "./inboundMail";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("addresses", () => {
  it("reads the address out of a display form, lower-cased", () => {
    expect(addressOf("Jordan Lee <Jordan@Brand.example>")).toBe("jordan@brand.example");
    expect(addressOf("jordan@brand.example")).toBe("jordan@brand.example");
    expect(addressOf("nobody")).toBeNull();
  });
  it("lists every address in a header value", () => {
    expect(addressesIn(`"Lee, Jordan" <Jordan@Brand.example>, b@y.example`)).toEqual(["jordan@brand.example", "b@y.example"]);
    expect(addressesIn("")).toEqual([]);
  });
  it("finds the reply token only on the inbox's own plus-address, only 32 hex", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const inbox = "partners@nomila.example";
    expect(replyTokenIn(["someone@x.example", `Nomila <partners+${t}@nomila.example>`], inbox)).toBe(t);
    expect(replyTokenIn([`PARTNERS+${t}@Nomila.Example`], inbox)).toBe(t);
    expect(replyTokenIn([`partners+${t}@evil.example`], inbox)).toBeNull();
    expect(replyTokenIn([`hello+${t}@nomila.example`], inbox)).toBeNull();
    expect(replyTokenIn(["partners+short@nomila.example"], inbox)).toBeNull();
    expect(replyTokenIn(["partners@nomila.example"], inbox)).toBeNull();
    expect(replyTokenIn([`partners+${t}@nomila.example`], "not-an-address")).toBeNull();
  });
});

describe("Gmail message parsing", () => {
  it("envelope: From plus every To / Cc / Delivered-To address", () => {
    expect(envelopeOf([
      { name: "From", value: "Jordan <j@brand.example>" },
      { name: "To", value: "Nomila <partners+abc@nomila.example>, other@x.example" },
      { name: "cc", value: "c@y.example" },
      { name: "Delivered-To", value: "partners+abc@nomila.example" },
      { name: "Subject", value: "ignored" },
    ])).toEqual({ from: "Jordan <j@brand.example>", recipients: ["partners+abc@nomila.example", "other@x.example", "c@y.example", "partners+abc@nomila.example"] });
  });
  it("body: first inline text/plain; HTML converted when there is none; attachments skipped", () => {
    expect(textOfPayload({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("Hello — plain") } },
      { mimeType: "text/html", body: { data: b64("<p>Hello html</p>") } },
    ] })).toBe("Hello — plain");
    expect(textOfPayload({ mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", body: { attachmentId: "att1" } },
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>Only html</p><br>line") } }] },
    ] })).toBe("Only html\n\nline");
    expect(textOfPayload({ mimeType: "text/plain", body: { data: b64("single part") } })).toBe("single part");
    expect(textOfPayload({ mimeType: "image/png", body: { attachmentId: "a" } })).toBeNull();
    expect(textOfPayload(undefined)).toBeNull();
  });
});

describe("gmailPartnerInbox (Google stubbed)", () => {
  const calls: Array<{ url: string; method: string; body?: any; auth?: string }> = [];
  const realFetch = global.fetch;
  let labels: Array<{ id: string; name: string }> = [];
  beforeEach(() => { calls.length = 0; labels = []; delegatedToken.mockClear(); dropToken.mockClear(); });
  afterAll(() => { global.fetch = realFetch; });
  beforeAll(() => {
    global.fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as any)?.Authorization });
      const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
      if (path.startsWith("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (path === "/labels" && method === "GET") return json({ labels });
      if (path === "/labels" && method === "POST") { labels.push({ id: "Label_9", name: "nomila-processed" }); return json({ id: "Label_9" }); }
      if (path.startsWith("/messages/gone")) return json({ error: {} }, 404);
      if (path.startsWith("/messages/m1?format=metadata")) return json({ payload: { headers: [{ name: "From", value: "a@b.example" }, { name: "To", value: "partners+x@nomila.example" }] } });
      if (path.startsWith("/messages/m1?format=full")) return json({ payload: { headers: [{ name: "From", value: "a@b.example" }, { name: "To", value: "partners+x@nomila.example" }], mimeType: "text/plain", body: { data: b64("hi there") } } });
      if (path.endsWith("/modify")) return json({});
      if (path.startsWith("/messages/expired")) return json({ error: {} }, 401);
      return json({ error: { message: "unexpected" } }, 500);
    }) as any;
  });

  it("uses a token for the partner mailbox and gmail.modify only, lists unprocessed inbox mail, reads headers, labels once", async () => {
    const box = gmailPartnerInbox("partners@nomila.example", "nomila-processed");
    expect(await box.unprocessed(25)).toEqual(["m1", "m2"]);
    expect(decodeURIComponent(calls[0].url)).toContain("q=in:inbox -label:nomila-processed&maxResults=25");
    expect(delegatedToken).toHaveBeenCalledWith("partners@nomila.example", "https://www.googleapis.com/auth/gmail.modify");
    expect(delegatedToken.mock.calls.every(([a, s]) => a === "partners@nomila.example" && s.endsWith("/gmail.modify"))).toBe(true);
    expect(calls[0].auth).toBe("Bearer tok-partner");

    expect(await box.envelope("m1")).toEqual({ from: "a@b.example", recipients: ["partners+x@nomila.example"] });
    expect(calls.at(-1)!.url).toMatch(/format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Delivered-To$/);
    expect(await box.read("m1")).toEqual({ id: "m1", from: "a@b.example", to: ["partners+x@nomila.example"], text: "hi there" });
    expect(await box.envelope("gone")).toBeNull();
    expect(await box.read("gone")).toBeNull();

    await box.markProcessed("m1");
    await box.markProcessed("m2");
    expect(calls.filter((c) => c.url.endsWith("/labels") && c.method === "POST")).toHaveLength(1);
    const mods = calls.filter((c) => c.url.endsWith("/modify"));
    expect(mods.map((c) => c.body)).toEqual([{ addLabelIds: ["Label_9"] }, { addLabelIds: ["Label_9"] }]);
  });

  it("reuses an existing label; a 401 drops the cached token and throws (the next poll retries)", async () => {
    labels = [{ id: "Label_1", name: "nomila-processed" }];
    const box = gmailPartnerInbox("partners@nomila.example", "nomila-processed");
    await box.markProcessed("m1");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/labels"))).toBe(false);
    expect(calls.at(-1)!.body).toEqual({ addLabelIds: ["Label_1"] });
    await expect(box.envelope("expired")).rejects.toThrow(/401/);
    expect(dropToken).toHaveBeenCalledWith("partners@nomila.example", "https://www.googleapis.com/auth/gmail.modify");
  });
});

describe("stripQuoted", () => {
  it.each([
    ["Gmail", "Sounds good.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Nomila <hello@nomila.co> wrote:\n> You have a new message", "Sounds good."],
    ["Gmail wrapped", "Yes.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Nomila\n<hello@nomila.co> wrote:\n> quoted", "Yes."],
    ["Outlook", "Works for us.\r\n\r\nFrom: Nomila <hello@nomila.co>\r\nSent: Monday, October 5, 2026\r\nTo: x\r\nSubject: y", "Works for us."],
    ["Original Message", "Ok\n-----Original Message-----\nFrom: a", "Ok"],
    ["underscores", "Thanks\n________________________________\nFrom: a", "Thanks"],
    ["signature", "See you then\n-- \nJordan, Brand", "See you then"],
    ["plain", "Two lines\nof text", "Two lines\nof text"],
  ])("%s", (_n, input, want) => { expect(stripQuoted(input)).toBe(want); });
});
