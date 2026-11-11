/**
 * emailBody tests — the MIME shapes that produced broken bubbles in prod:
 * html-only mail rendered as raw markup/CSS, nested multipart came in empty,
 * and quoted reply chains repeated the whole thread inside one message.
 */

import { extractEmailBody, htmlToText, stripQuotedHistory, type GmailPayloadPart } from "./emailBody";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

describe("extractEmailBody — MIME walking", () => {
  it("prefers text/plain nested inside multipart/mixed → multipart/alternative", () => {
    const payload: GmailPayloadPart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Hi Mia, we'd love to work with you.") } },
            { mimeType: "text/html", body: { data: b64("<p>Hi Mia, we'd love to work with you.</p>") } },
          ],
        },
        { mimeType: "application/pdf", body: { data: b64("%PDF-1.4 …") } },
      ],
    };
    expect(extractEmailBody(payload)).toBe("Hi Mia, we'd love to work with you.");
  });

  it("converts html-only mail to text — no tags, no CSS (the prod junk bubble)", () => {
    const html = `<!doctypehtml><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      .muted { color: rgb(135, 136, 142); }
      a[href^='tel'], a[href^='sms'] { text-decoration: none; color: black; }
    </style></head><body><div><p>Big promotion is here!</p><p>Shop the drop today.</p></div></body></html>`;
    const payload: GmailPayloadPart = { mimeType: "text/html", body: { data: b64(html) } };

    const out = extractEmailBody(payload);
    expect(out).toContain("Big promotion is here!");
    expect(out).toContain("Shop the drop today.");
    expect(out).not.toContain("rgb(135");
    expect(out).not.toContain("a[href");
    expect(out).not.toContain("<");
  });

  it("returns empty for an empty payload and for attachment-only mail", () => {
    expect(extractEmailBody(undefined)).toBe("");
    expect(extractEmailBody({ mimeType: "multipart/mixed", parts: [{ mimeType: "image/png", body: {} }] })).toBe("");
  });

  it("truncates AFTER cleaning, not before", () => {
    // 6k of style junk followed by the real content: pre-clean truncation used
    // to cut the content away and keep the junk.
    const html = `<html><head><style>${".x{color:#000}".repeat(500)}</style></head><body><p>The actual offer text.</p></body></html>`;
    const payload: GmailPayloadPart = { mimeType: "text/html", body: { data: b64(html) } };
    const out = extractEmailBody(payload);
    expect(out).toContain("The actual offer text.");
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it("decodes html entities", () => {
    const payload: GmailPayloadPart = {
      mimeType: "text/html",
      body: { data: b64("<p>Rate &amp; usage rights &mdash; $500</p>") },
    };
    expect(extractEmailBody(payload)).toContain("Rate & usage rights");
  });
});

describe("stripQuotedHistory", () => {
  it("cuts at the Gmail 'On … wrote:' marker", () => {
    const text = "Sounds great, sending the contract.\n\nOn Jul 5, 2026, at 9:15 AM, Mia Nguyen <mia@x.com> wrote:\n> Thanks for reaching out\n> about the campaign";
    expect(stripQuotedHistory(text).trim()).toBe("Sounds great, sending the contract.");
  });

  it("cuts a trailing '>'-quoted block with no marker line", () => {
    const text = "Got it, thanks!\n\n> original offer text\n> more quoted lines\n";
    expect(stripQuotedHistory(text).trim()).toBe("Got it, thanks!");
  });

  it("cuts at the Outlook header block", () => {
    const text = "See attached.\n\nFrom: Mia Nguyen <mia@x.com>\nSent: Monday, July 6\nTo: brand@acme.com\nSubject: Re: Deal";
    expect(stripQuotedHistory(text).trim()).toBe("See attached.");
  });

  it("leaves unquoted mail alone", () => {
    const text = "We wrote a proposal for you.\n\nBudget: $2,000.\nDeliverables: 2 reels.";
    expect(stripQuotedHistory(text)).toBe(text);
  });
});

describe("htmlToText", () => {
  it("keeps paragraph structure readable", () => {
    const out = htmlToText("<div><p>Line one.</p><p>Line two.</p></div>");
    expect(out).toContain("Line one.");
    expect(out).toContain("Line two.");
    expect(out).not.toContain("<p>");
  });
});
