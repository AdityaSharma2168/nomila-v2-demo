/**
 * publicCard/types.ts — the server's rules over the shared contract (shared/publicCard.ts, re-exported here): the
 * button fallback, the grid tiles (always resolveTileSlots, the renderer's own resolver), and the freeze check.
 *
 * Cite-or-cut is enforced at the freeze (validateSnapshot): an item with no basis in the manifest is refused.
 * Nothing here names an athlete, sport, school, league or brand.
 */

import {
  CHAPTER_KINDS, DOORS, PUBLIC_CARD_CONTENT_SCHEMA, PUBLIC_CARD_SOURCES_SCHEMA,
  type ChapterButton, type Door, type PublicCardContent, type PublicCardSources, type PublicItem,
} from "../../../shared/publicCard";
import { resolveTileSlots } from "./tiles";

export * from "../../../shared/publicCard";

/** Key-order-insensitive JSON (jsonb does not keep key order), so the same value always compares and hashes the same. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as object).sort().reduce((o: Record<string, unknown>, k) => { o[k] = (val as Record<string, unknown>)[k]; return o; }, {})
      : val);
}

/** The public ETag of a version: the version plus a prefix of its content hash. */
export const etagOf = (version: number, contentSha256: string): string => `"v${version}-${contentSha256.slice(0, 16)}"`;

/** Every item in content, flattened (chapter items, then offers, then picks). */
export function contentItems(c: PublicCardContent): PublicItem[] {
  return [...c.chapters.flatMap((ch) => ch.items), ...(c.offers ?? []), ...(c.picks ?? [])];
}

/** The white button's words (§3; pronoun-neutral: her first name, never "her"). */
export function buttonLabel(door: ChapterButton["door"], firstName: string): string {
  switch (door) {
    case "partner":  return `Work with ${firstName}`;
    case "book":     return `Book time with ${firstName}`;
    case "shop":     return `Shop ${firstName}'s picks`;
    case "ask_mila": return `Ask Mila about ${firstName}`;
  }
}

/**
 * §3 fallback: a chapter's button whose door is hidden becomes "Ask Mila about [First]"; with Ask Mila off too it
 * becomes "Work with [First]" (the Partner door, or its no-script brief form); with both off there is no button.
 */
export function fallbackButton(preferred: ChapterButton["door"], doors: Record<Door, boolean>, firstName: string): ChapterButton | null {
  const order: ChapterButton["door"][] = preferred === "ask_mila" ? ["ask_mila", "partner"] : [preferred, "ask_mila", "partner"];
  const door = order.find((d) => doors[d]);
  return door ? { door, label: buttonLabel(door, firstName) } : null;
}

/**
 * The four grid tiles for a card, resolved by resolveTileSlots (tiles.ts) from what the card publishes: her first
 * name, the Partner / Book / Shop doors that are live, her chapters in order and her socials. Called at publish and at
 * every removal; the stored result is what the page draws.
 */
export function tilesFor(c: Pick<PublicCardContent, "firstName" | "doors" | "chapters" | "socials">): PublicCardContent["tiles"] {
  return resolveTileSlots({
    firstName: c.firstName,
    partnerOn: c.doors.partner, bookOn: c.doors.book, shopOn: c.doors.shop,
    chapters: c.chapters.map((ch) => ({ id: ch.key, kind: ch.key, title: ch.title })),
    socials: c.socials,
  });
}

/** The publish guard's words when the grid would repeat a tile (all three doors off, one chapter, no socials). */
export const DUPLICATE_TILES_REASON = "Add a chapter or turn on a door to publish";
const tileKey = (t: PublicCardContent["tiles"][number]) => `${t.intent}|${t.label}|${t.subLabel}|${t.targetChapterId ?? ""}`;
export const tilesRepeat = (tiles: PublicCardContent["tiles"]): boolean => new Set(tiles.map(tileKey)).size !== tiles.length;

export class SnapshotInvalid extends Error {
  constructor(message: string) { super(message); this.name = "SnapshotInvalid"; }
}

/**
 * The freeze check. Refuses a snapshot that is not the public shape, that carries an item with no basis (cite or
 * cut), that has a chapter other than Highlights with no items, duplicate item keys, a door on that her switch has off,
 * tiles that are not the resolver's for this card or that repeat (DUPLICATE_TILES_REASON), or an M.I.A. block while
 * show_mia is off.
 */
export function validateSnapshot(content: PublicCardContent, sources: PublicCardSources, opts: { showMia: boolean; switches: Record<Door, boolean> }): void {
  if (content?.schema !== PUBLIC_CARD_CONTENT_SCHEMA) throw new SnapshotInvalid("content schema");
  if (sources?.schema !== PUBLIC_CARD_SOURCES_SCHEMA) throw new SnapshotInvalid("sources schema");
  if (!content.displayName?.trim() || !content.firstName?.trim()) throw new SnapshotInvalid("name");
  if (!Array.isArray(content.chapters) || content.chapters.length === 0) throw new SnapshotInvalid("no chapters");
  if (content.chapters[0].key !== "highlights") throw new SnapshotInvalid("Highlights comes first");
  const seenChapters = new Set<string>();
  const seenItems = new Set<string>();
  for (const ch of content.chapters) {
    if (!(CHAPTER_KINDS as readonly string[]).includes(ch.key)) throw new SnapshotInvalid(`chapter kind ${ch.key}`);
    if (seenChapters.has(ch.key)) throw new SnapshotInvalid(`chapter twice: ${ch.key}`);
    seenChapters.add(ch.key);
    // Highlights is always there (her name and mark are its header); every other chapter exists only with content.
    if (!Array.isArray(ch.items) || (ch.key !== "highlights" && ch.items.length === 0)) throw new SnapshotInvalid(`empty chapter: ${ch.key}`);
  }
  if (!Array.isArray(content.offers) || !Array.isArray(content.picks)) throw new SnapshotInvalid("offers / picks");
  if (content.offers.length && !content.doors?.book) throw new SnapshotInvalid("offers while Book is off");
  if (content.picks.length && !content.doors?.shop) throw new SnapshotInvalid("picks while Shop is off");
  for (const it of contentItems(content)) {
    if (!it.key || seenItems.has(it.key)) throw new SnapshotInvalid(`item key: ${it.key}`);
    seenItems.add(it.key);
    const refs = sources.items?.[it.key];
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((r) => !r?.kind || !r?.id)) throw new SnapshotInvalid(`no basis: ${it.key}`);
    if (!["said", "found", "made", "proof"].includes(it.basis)) throw new SnapshotInvalid(`basis label: ${it.key}`);
  }
  const extra = Object.keys(sources.items ?? {}).filter((k) => !seenItems.has(k));
  if (extra.length) throw new SnapshotInvalid(`sources for items not in content: ${extra.join(", ")}`);
  for (const d of DOORS) {
    if (typeof content.doors?.[d] !== "boolean") throw new SnapshotInvalid(`door ${d}`);
    if (content.doors[d] && !opts.switches[d]) throw new SnapshotInvalid(`door ${d} is switched off`);
  }
  // The grid is exactly what the renderer's resolver gives for this card, and never repeats a tile.
  if (!Array.isArray(content.tiles) || canonicalJson(content.tiles) !== canonicalJson(tilesFor(content))) {
    throw new SnapshotInvalid("tiles must be the four resolved at publish");
  }
  if (tilesRepeat(content.tiles)) throw new SnapshotInvalid(DUPLICATE_TILES_REASON);
  if (content.mia && !opts.showMia) throw new SnapshotInvalid("M.I.A. while show_mia is off");
}
