/**
 * lib/contactDetails.ts — THE contact-detail patterns, and the one stripper built on them. Pure: no imports, no I/O.
 *
 *   privateFormats(text)          detect (research privacy, agent policy, bookings): an email, a phone in a strict
 *                                 format, a street address. High precision: year ranges and stat runs never match.
 *   stripContactDetails(text)     remove (the public page): everything privateFormats finds, plus a few more phone
 *                                 shapes, PO boxes, URLs and bare web addresses, @handles and labelled handles
 *                                 ("ig: name"); then tidy the labels, punctuation and spacing left behind. Text with
 *                                 nothing to remove comes back exactly as it went in.
 *
 * The email, phone and address patterns were the research privacy rule's (agent/research/privacy.ts), moved here so the
 * public page strips with the same patterns research drops with. No word lists of names, places or brands.
 */

export const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/i;
// Strict phone formats only: international with a leading "+" (8–15 digits in total), or North American
// "(555) 010-2030" / "555-010-2030" / "555.010.2030". A year range or a stat line never has these shapes.
export const PHONE_INTL = /(^|[^\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?=$|[^\w])/;
export const PHONE_NANP = /(^|[^\d])(\(\d{3}\)\s?|\d{3}[.-])\d{3}[.-]\d{4}(?!\d)/;
const STREET_SUFFIX = "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Terrace|Way|Parkway|Pkwy|Circle|Cir|Highway|Hwy";
// Number + one to four capitalised name words + a street suffix ("12 Example Street", "450 West Oak Ave").
export const ADDRESS = new RegExp(String.raw`\b\d{1,6}\s+(?:[A-Z][A-Za-z'.-]*\s+){1,4}(?:${STREET_SUFFIX})\b`);

const digitCount = (s: string) => s.replace(/\D/g, "").length;

function hasPhone(text: string): boolean {
  const m = PHONE_INTL.exec(text);
  if (m && digitCount(m[0]) >= 8 && digitCount(m[0]) <= 15) return true;
  return PHONE_NANP.test(text);
}

/** The private FORMATS found in a text (empty = none). Meaning is the model's call, not this. */
export function privateFormats(text: string): Array<"contact" | "address"> {
  const kinds: Array<"contact" | "address"> = [];
  if (EMAIL.test(text) || hasPhone(text)) kinds.push("contact");
  if (ADDRESS.test(text)) kinds.push("address");
  return kinds;
}

// ─── stripping (the public page) ───────────────────────────────────────────────────────────────────────────────

const g = (re: RegExp, extra = "") => new RegExp(re.source, [...new Set(`${re.flags}g${extra}`)].join(""));

const MARK = "\u0000";
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi;
const BARE_DOMAIN = /(^|[^\w@.\-/])((?:[a-z0-9-]*[a-z][a-z0-9-]*\.)+(?:com|co|net|org|io|app|me|ly|gg|tv|ee|link|bio|page|store|shop|site|us|uk)(?![a-z0-9-])(?:\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])?)/gi;
// The same NANP shape with spaces allowed as separators ("555 010 2030"), and ten digits run together.
const PHONE_SPACED = /(^|[^\d])(\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;
const PHONE_RUN = /(^|[^\d.,])\+?\d{10,11}(?![\d.,]*\d)/g;
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+\b/gi;
const PLATFORM = "ig|insta|instagram|tiktok|tt|twitter|snap|snapchat|sc|yt|youtube|threads|fb|facebook|twitch";
const LABELLED_HANDLE = new RegExp(String.raw`\b(?:${PLATFORM})\s*[:：]\s*@?[A-Za-z0-9._]{2,30}`, "gi");
const AT_HANDLE = /(^|[^\w.@])@([A-Za-z0-9._]{2,30})/g;
// A label left pointing at nothing ("💌:", "email:", "for business inquiries:"), removed only right before a cut. The
// emoji are the ones that signal a contact line (mail, phone, globe, link, pin, pointing hand); any other emoji is hers.
const LABEL_WORDS = `${PLATFORM}|inquiries|enquiries|inquiry|enquiry|email|e-mail|mail|contact|business|bookings?|press|media|pr|management|mgmt|collabs?|collaborations?|partnerships?|dm|dms|text|call|phone|tel|mobile|cell|whatsapp|website|web|site|link|links|linktree|follow|find|reach|hit|visit|see|check|out|write|send|go|to|me|us|at|via|or|and|for|on`;
const CONTACT_EMOJI = String.raw`(?:\u{1F4E7}|\u{1F4E9}|\u{1F4E8}|\u2709|\u{1F48C}|\u{1F4DE}|\u260E|\u{1F4F1}|\u{1F4F2}|\u{1F310}|\u{1F517}|\u{1F449}|\u27A1|\u2B07|\u{1F447}|\u{1F4CD}|\u{1F3E0}|\u{1F4EC}|\u{1F4EE}|\u{1F4BC}|\u{1F91D})[\uFE0F\u200D]*`;
const LABEL_BEFORE_MARK = new RegExp(String.raw`(?:${CONTACT_EMOJI}|\b(?:${LABEL_WORDS})\b)[\s:\uFF1A\-\u2013\u2014>\u2192|]*${MARK}`, "giu");

export interface StripOptions {
  /** @handles that may stay (the page's own social links). Lowercase, without "@". */
  keepHandles?: ReadonlySet<string>;
  /** Strip bare web addresses ("example.com"). Default true; off for a merchant's own name. */
  bareDomains?: boolean;
}

/** `text` with every contact detail removed and the leftovers tidied; unchanged when there was nothing to remove. */
export function stripContactDetails(text: string, opts: StripOptions = {}): string {
  if (typeof text !== "string" || !text) return text;
  const keep = opts.keepHandles;
  let t = text
    .replace(URL_RE, MARK)
    .replace(g(EMAIL), MARK)
    .replace(g(PHONE_INTL), (m: string, pre: string) => (digitCount(m) >= 8 && digitCount(m) <= 15 ? `${pre}${MARK}` : m))
    .replace(g(PHONE_NANP), (_m: string, pre: string) => `${pre}${MARK}`)
    .replace(PHONE_SPACED, (_m: string, pre: string) => `${pre}${MARK}`)
    .replace(PHONE_RUN, (_m: string, pre: string) => `${pre}${MARK}`)
    .replace(g(ADDRESS), MARK)
    .replace(PO_BOX, MARK)
    .replace(LABELLED_HANDLE, MARK)
    .replace(AT_HANDLE, (m: string, pre: string, h: string) => (keep?.has(h.replace(/\.+$/, "").toLowerCase()) ? m : `${pre}${MARK}`));
  if (opts.bareDomains !== false) t = t.replace(BARE_DOMAIN, (_m: string, pre: string) => `${pre}${MARK}`);
  if (!t.includes(MARK)) return text;
  return tidy(t);
}

/** Tidy what a cut leaves: dangling labels, doubled or stranded separators, empty brackets, stray spaces. */
function tidy(t: string): string {
  // Adjacent cuts are one cut, and the labels standing right in front of a cut go with it, as many as there are.
  const merge = new RegExp(String.raw`${MARK}(?:[\s|\u2022\u00B7,;/:\-\u2013\u2014]*${MARK})+`, "gu");
  for (let i = 0; i < 8; i++) {
    const next = t.replace(merge, MARK).replace(LABEL_BEFORE_MARK, MARK);
    if (next === t) break;
    t = next;
  }
  const SEP = String.raw`[|•·/;,:\-–—>→]`;
  return t
    .split("\n")
    .map((line) => line
      .replace(new RegExp(MARK, "g"), " ")
      .replace(/[ \t ]+/g, " ")
      .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
      .replace(new RegExp(String.raw`(?:\s*${SEP}){2,}\s*`, "g"), (m) => ` ${m.trim().charAt(0)} `)
      .replace(new RegExp(String.raw`^[\s|•·/;,:\-–—>→]+|[\s|•·/;,:\-–—>→]+$`, "g"), "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/ {2,}/g, " ")
      .trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join("\n")
    .trim();
}
