/**
 * brandBook/overrides — the athlete's CHOICES in her brand book, applied as a thin layer at read time. The same pattern
 * as the Nomi Card's editor (services/cardOverrides.ts): the engine's book (brand_books.data) stays fully rebuildable,
 * and what she picked or wrote lives beside it (brand_books.overrides), re-applied over every build before it is shown,
 * rendered or read by Mila. Principle: she edits a VIEW, not the source.
 *
 *  - copy — the words for one crafted line, key `${pageId}.${slot}` (slot names may hold dots: "pillar.0.name").
 *           `pick` = the option index she chose (absent for her own words). The text is the resolved words, so a
 *           rebuild that reorders or rewrites the options still shows what she chose.
 *
 * A rebuild that no longer has the slot an override points at keeps the override (her words are never deleted) and
 * simply does not show it; applyBookOverrides names those keys so the rebuild can log them. Facts, images and the live
 * chapters (rates, the M.I.A. read) are never overridden. Nothing here names an athlete, sport, school or brand.
 */
import type { BookPage, BrandBookData } from "../../../shared/brandBook";

export interface BookOverrides {
  copy?: Record<string, { text: string; pick?: number }>;
}

export const lineKey = (pageId: string, slot: string): string => `${pageId}.${slot}`;

/** Split a copy key at its first dot (page ids never hold one; slot names may). */
function splitKey(key: string): { pageId: string; slot: string } | null {
  const i = key.indexOf(".");
  return i > 0 && i < key.length - 1 ? { pageId: key.slice(0, i), slot: key.slice(i + 1) } : null;
}

const isBlank = (s: unknown) => typeof s !== "string" || !s.trim();

/**
 * Her choices over the engine's book → the book she sees, plus the override keys whose page or slot this build no longer
 * has (kept in storage, not shown). The chosen text joins the slot's options when the build did not offer it, so the
 * app's swap still offers it. Never mutates `data`.
 */
export function applyBookOverrides(data: BrandBookData, ov: BookOverrides | null | undefined): { book: BrandBookData; orphans: string[] } {
  const entries = Object.entries(ov?.copy ?? {});
  if (!entries.length) return { book: data, orphans: [] };
  const pages: BookPage[] = data.pages.map((p) => ({ ...p, lines: { ...p.lines } }));
  const orphans: string[] = [];
  for (const [key, o] of entries) {
    if (!o || isBlank(o.text)) continue;
    const at = splitKey(key);
    const page = at ? pages.find((p) => p.id === at.pageId) : undefined;
    const line = at && page ? page.lines[at.slot] : undefined;
    if (!at || !page || !line) { orphans.push(key); continue; }
    page.lines[at.slot] = { text: o.text, options: line.options.includes(o.text) ? line.options : [...line.options, o.text] };
  }
  return { book: { ...data, pages }, orphans };
}
