/**
 * emailBody.ts — one shared extractor for readable email text.
 *
 * Both Gmail fetch paths previously grabbed the first top-level text/plain
 * part and otherwise fell back to the RAW payload body — which for html-only
 * mail is raw markup (the CSS-junk bubbles; 54 messages in prod), and for
 * nested multipart (mixed → alternative) is nothing at all. Quoted reply
 * chains ("On … wrote:") were also kept, so a bubble could contain the whole
 * prior thread.
 *
 * extractEmailBody(payload):
 *   1. walk the MIME tree recursively, preferring text/plain over text/html
 *   2. convert html to text (node-html-parser; style/script dropped)
 *   3. strip quoted history
 *   4. collapse whitespace, truncate AFTER cleaning
 */

import { parse } from "node-html-parser";

export interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

const MAX_BODY_LEN = 4000;

export function extractEmailBody(payload: GmailPayloadPart | undefined, maxLen = MAX_BODY_LEN): string {
  if (!payload) return "";

  const plain  = findPart(payload, "text/plain");
  const html   = plain ? null : findPart(payload, "text/html");
  const source = plain ?? html ?? (payload.body?.data ? payload : null);
  if (!source?.body?.data) return "";

  // Gmail body data is URL-safe base64; Buffer accepts both alphabets.
  let text = Buffer.from(source.body.data, "base64").toString("utf-8").replace(/\r\n/g, "\n");

  // Strip whenever the CONTENT looks like markup, not only when it came from the html
  // part. Some senders put a full HTML document inside the text/plain part — AEGISLAB's
  // mail arrives as `<!doctype html>` in text/plain — and the old `source !== plain`
  // guard skipped exactly those, storing raw markup as the body.
  //
  // That is not just a display problem. The body is what gets classified, summarised and
  // EMBEDDED, so an unstripped mail contributes a vector describing <table> and xmlns
  // rather than its offer, and lands near every other HTML mail regardless of content.
  if (source === html || looksLikeHtml(text)) {
    text = htmlToText(text);
  }

  return collapseWhitespace(stripQuotedHistory(text)).slice(0, maxLen);
}

function findPart(part: GmailPayloadPart, mime: string): GmailPayloadPart | null {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

function looksLikeHtml(text: string): boolean {
  return /<\s*(!doctype|html|head|body|div|table|style|p|br)\b/i.test(text.slice(0, 500));
}

export function htmlToText(html: string): string {
  // Malformed doctypes ("<!doctypehtml>", seen in prod marketing mail) aren't
  // recognized as doctype nodes by the parser and would leak into the text.
  const root = parse(html.replace(/<!doctype[^>]*>/gi, ""));
  // Drop everything that renders as junk when flattened to text.
  root.querySelectorAll("style, script, noscript, head, title, meta, link").forEach((el) => el.remove());
  const text = root.structuredText ?? root.text ?? "";
  return text;
}

// Cut the quoted history a reply carries below the new content. Conservative:
// cuts at well-known reply markers, plus a trailing block of ">"-quoted lines.
export function stripQuotedHistory(text: string): string {
  const MARKERS: RegExp[] = [
    /^\s*On .{0,200}wrote:\s*$/m,               // Gmail / Apple Mail
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,   // Outlook classic
    /^\s*_{10,}\s*$/m,                          // Outlook divider
    /^\s*From:\s.+\n\s*Sent:\s.+/m,             // Outlook top-quote header block
    /^\s*Le .{0,200}a écrit\s*:\s*$/m,          // French clients
  ];

  let cut = text.length;
  for (const re of MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  let out = text.slice(0, cut);

  // Trailing ">"-quoted block without a marker line above it.
  const lines = out.split("\n");
  let end = lines.length;
  while (end > 0) {
    const l = lines[end - 1].trim();
    if (l === "" || l.startsWith(">")) end--;
    else break;
  }
  if (lines.slice(end).some((l) => l.trim().startsWith(">"))) {
    out = lines.slice(0, end).join("\n");
  }

  return out;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
