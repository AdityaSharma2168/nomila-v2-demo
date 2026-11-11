/**
 * publicCard/contactFilter.ts — no contact details on the public page, ever. ONE function over every text a page shows
 * or freezes, applied three times (defence in depth):
 *
 *   draft.ts      each line as it is built, and the preview it freezes (a line that was only contact details is cut)
 *   publish.ts    every version written (her publish, a numbers refresh, a removal)
 *   publicCardReader.ts   every published version read, so a snapshot frozen before this filter is clean on the page
 *
 * Stripped (lib/contactDetails.ts stripContactDetails): emails, phone numbers, street addresses and PO boxes, URLs and
 * web addresses, @handles and labelled handles. Her social accounts appear only as the page's Follow links
 * (content.socials, from her connected accounts), which are not text and are left as they are.
 *
 * Pure. Nothing here names an athlete, sport, school, league or brand.
 */
import { stripContactDetails } from "../../lib/contactDetails";
import { tilesFor, type PublicCardContent, type PublicCardSources, type PublicItem } from "./types";

/** One text, filtered. Null and non-strings pass through. */
export function cleanText<T extends string | null | undefined>(text: T, opts: { bareDomains?: boolean } = {}): T {
  return (typeof text === "string" ? stripContactDetails(text, opts) : text) as T;
}

const blankToNull = (s: string | null | undefined) => (typeof s === "string" && !s.trim() ? null : s);

/** An item with every text field filtered; null when its words were nothing but contact details. */
function cleanItem(it: PublicItem): PublicItem | null {
  const text = cleanText(it.text);
  if (typeof it.text === "string" && it.text.trim() && !text?.trim()) return null;
  const out: PublicItem = { ...it, text };
  if (it.label !== undefined) out.label = blankToNull(cleanText(it.label));
  if (it.blurb !== undefined) out.blurb = blankToNull(cleanText(it.blurb));
  if (it.disclosure !== undefined) out.disclosure = blankToNull(cleanText(it.disclosure));
  // A merchant is a shop's own name ("Example.com" is a name there), so only the personal formats come off it.
  if (it.merchant !== undefined) out.merchant = blankToNull(cleanText(it.merchant, { bareDomains: false }));
  return out;
}

/**
 * The content with contact details stripped from every text: her name, chapter titles and buttons, every item's
 * words (text, label, blurb, disclosure, merchant), offers, picks and the grid tiles. An item left with no words leaves
 * (and its sources entry with it); a chapter other than Highlights left empty leaves, and the grid is then re-resolved.
 * `changed` says whether anything differed. Idempotent: clean content comes back equal.
 */
export function sanitizeSnapshot<S extends PublicCardSources | undefined>(content: PublicCardContent, sources?: S): { content: PublicCardContent; sources: S; changed: boolean } {
  const before = JSON.stringify(content);
  const c: PublicCardContent = structuredClone(content);
  c.displayName = cleanText(c.displayName) || content.displayName;
  c.firstName = cleanText(c.firstName) || content.firstName;
  c.lastName = cleanText(c.lastName) ?? content.lastName;
  const items = (list: PublicItem[] | undefined) => (list ?? []).map(cleanItem).filter((x): x is PublicItem => !!x);
  const chapterCount = (c.chapters ?? []).length;
  c.chapters = (c.chapters ?? [])
    .map((ch) => ({
      ...ch,
      title: cleanText(ch.title) || ch.key.charAt(0).toUpperCase() + ch.key.slice(1),
      button: ch.button ? { ...ch.button, label: cleanText(ch.button.label) } : ch.button,
      items: items(ch.items),
    }))
    .filter((ch) => ch.key === "highlights" || ch.items.length > 0);
  c.offers = items(c.offers);
  c.picks = items(c.picks);
  if (c.chapters.length !== chapterCount) c.tiles = tilesFor(c);
  if (Array.isArray(c.tiles)) {
    c.tiles = c.tiles.map((t) => ({
      ...t, label: cleanText(t.label), subLabel: cleanText(t.subLabel), ...(t.hint !== undefined ? { hint: blankToNull(cleanText(t.hint)) } : {}),
    })) as PublicCardContent["tiles"];
  }
  const changed = JSON.stringify(c) !== before;
  if (!changed) return { content, sources: sources as S, changed: false };
  let outSources = sources;
  if (sources) {
    const kept = new Set([...c.chapters.flatMap((ch) => ch.items), ...c.offers, ...c.picks].map((i) => i.key));
    outSources = { ...sources, items: Object.fromEntries(Object.entries(sources.items ?? {}).filter(([k]) => kept.has(k))) } as S;
  }
  return { content: c, sources: outSources as S, changed: true };
}
