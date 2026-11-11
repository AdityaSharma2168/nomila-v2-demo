/**
 * partner/publishedCard.ts — the ONE thing the Partner door reads about her: what her PUBLISHED card says.
 *
 * The snapshot reader (public_cards / public_card_snapshots, publicCardReader) is a separate module. This file is the
 * narrow seam between the two: the facts the fit preview and the visitor copy may use, and nothing else — never her
 * record, her inbox, her deals or her drafts. Public routes resolve the athlete from the handle through this seam
 * only, so an unknown, unpublished or deleted handle is the same 404.
 *
 * Wiring: server/index.ts installs publishedCardSource.ts (an adapter over publicCardReader) at boot when the Partner
 * door is mounted. Without a source no handle resolves and every public partner route answers 404. Tests install a
 * double with the same call.
 */

/** One published chapter, as public text only (already approved by her, already public). */
export interface PublishedChapter {
  /** Stable chapter id ("story", "partnerships", …) — the fit preview cites it. */
  id: string;
  title: string;
  /** The chapter's public text, plain. */
  text: string;
}

export interface PublishedCardFacts {
  athleteId: string;
  handle: string;
  /** "[First]": the first name her published card shows. */
  firstName: string;
  /** The published snapshot version (fit previews are cached per version). */
  version: number;
  /** Her Partner door is on (it is unless she switched it off). */
  partnerOpen: boolean;
  /** She is known to be under 18: the request summary says a parent or guardian will be involved. */
  minor?: boolean;
  chapters: PublishedChapter[];
}

export interface PublishedCardSource {
  byHandle(handle: string): Promise<PublishedCardFacts | null>;
}

const NONE: PublishedCardSource = { byHandle: async () => null };
let source: PublishedCardSource = NONE;

export function setPublishedCardSource(s: PublishedCardSource | null): void {
  source = s ?? NONE;
}

/** Handles are lower-case [a-z0-9-], 2–40 chars; anything else never reaches the reader. */
export async function publishedCard(handle: unknown): Promise<PublishedCardFacts | null> {
  if (typeof handle !== "string") return null;
  const h = handle.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(h)) return null;
  const facts = await source.byHandle(h);
  return facts && facts.handle.toLowerCase() === h ? facts : null;
}

