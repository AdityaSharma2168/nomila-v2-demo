/**
 * lib/mailbox/retention — the MAILBOX_ZERO_RETENTION switch and the storage rule. Pure; no DB.
 */

import {
  isPseudonymousSender,
  mailboxZeroRetentionEnabled,
  pseudonymousSender,
  retainsMessageContent,
  sendableAddress,
  storedMessageContent,
} from "./retention";

const ENV = ["MAILBOX_LIVE_READS", "MAILBOX_ZERO_RETENTION"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const set = (live?: string, zr?: string) => {
  if (live === undefined) delete process.env.MAILBOX_LIVE_READS; else process.env.MAILBOX_LIVE_READS = live;
  if (zr === undefined) delete process.env.MAILBOX_ZERO_RETENTION; else process.env.MAILBOX_ZERO_RETENTION = zr;
};

const INPUT = { platform: "gmail", senderEmail: "Sarah@Acme.com", senderName: "Sarah", subject: "Hi", body: "text" };

describe("mailboxZeroRetentionEnabled", () => {
  it("is on only with BOTH flags — zero retention without live readers would leave readers nothing", () => {
    set(undefined, undefined); expect(mailboxZeroRetentionEnabled()).toBe(false);
    set(undefined, "true");    expect(mailboxZeroRetentionEnabled()).toBe(false);
    set("true", undefined);    expect(mailboxZeroRetentionEnabled()).toBe(false);
    set("true", "false");      expect(mailboxZeroRetentionEnabled()).toBe(false);
    set("true", " TRUE ");     expect(mailboxZeroRetentionEnabled()).toBe(true);
  });
});

describe("storage rule", () => {
  it("flag off: everything stored as before", () => {
    set();
    expect(storedMessageContent({ ...INPUT, counterparty: false })).toEqual({
      sender_email: "Sarah@Acme.com", sender_name: "Sarah", subject: "Hi", body: "text",
    });
  });

  it("flag on: no body / subject / name; the counterparty keeps her address, anyone else is a pseudonym", () => {
    set("true", "true");
    expect(storedMessageContent({ ...INPUT, counterparty: true })).toEqual({ sender_email: "Sarah@Acme.com", sender_name: null, subject: null, body: null });
    const other = storedMessageContent({ ...INPUT, counterparty: false });
    expect(other).toMatchObject({ sender_name: null, subject: null, body: null });
    expect(other.sender_email).toMatch(/^sha256-[0-9a-f]{64}@acme\.com$/);
  });

  it("Instagram DMs are the documented exception: still stored", () => {
    set("true", "true");
    expect(retainsMessageContent("instagram")).toBe(true);
    expect(retainsMessageContent("gmail")).toBe(false);
    expect(retainsMessageContent("outlook")).toBe(false);
    expect(storedMessageContent({ ...INPUT, platform: "instagram", counterparty: false }).body).toBe("text");
  });

  it("Nomila-relayed messages (partner requests) are Nomila's own record: still stored", () => {
    set("true", "true");
    expect(retainsMessageContent("nomila")).toBe(true);
    expect(storedMessageContent({ ...INPUT, platform: "nomila", counterparty: false }).body).toBe("text");
  });
});

describe("pseudonyms", () => {
  it("are stable, case/space-insensitive, keep the domain, and are idempotent", () => {
    const p = pseudonymousSender(" Sarah@ACME.com ")!;
    expect(p).toBe(pseudonymousSender("sarah@acme.com"));
    expect(p.split("@")[1]).toBe("acme.com");
    expect(pseudonymousSender(p)).toBe(p);
    expect(pseudonymousSender("no-at-sign")).toBeNull();
  });

  it("are never an address to send to", () => {
    const p = pseudonymousSender("sarah@acme.com");
    expect(isPseudonymousSender(p)).toBe(true);
    expect(sendableAddress(p)).toBeNull();
    expect(sendableAddress("sarah@acme.com")).toBe("sarah@acme.com");
    expect(isPseudonymousSender("sarah@acme.com")).toBe(false);
  });
});
