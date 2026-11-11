/**
 * tiles.ts — the four grid tiles, resolved ONCE at publish time (design v2.1 §6 "Tile slot resolution").
 *
 * The grid always shows four tiles in the slots Partner · Book (top row) and Shop · Create (bottom row), with Mila (Ask)
 * in the centre. Rules:
 *   - Create is always present, marked Soon, and opens the one-line "coming soon" sheet.
 *   - Partner is on unless she switched it off. Book and Shop are on only when she turned them on (and their gates pass).
 *   - A slot that is not on gets a FALLBACK. The first fallback is Story ("See [First]'s story", opens the Story card).
 *     The second is Follow (her linked social profiles), or — if she has none — another Story tile that opens the Media
 *     card instead. Never two identical tiles: each further fallback takes the next chapter not already used.
 *   - Ask is never a tile. Only if every other option is used (one chapter and no socials) does a slot fall back to Ask,
 *     so the grid still never repeats itself. The one shape that cannot fill three distinct fallbacks — all three doors
 *     off, a single chapter and no socials — repeats the Ask tile; the publisher should not let that card go live.
 *
 * The snapshot publisher calls this and stores the result; the page draws `PublicCardView.tiles` as given.
 * Copy is plain and pronoun-neutral, with the athlete's first name as the only variable.
 */
import type { ChapterKind, PublicSocialLink, PublicTile, TileSlot } from "./view";

export interface TileSlotInput {
  firstName: string;
  /** Her Partner switch (default on). */
  partnerOn: boolean;
  /** Book is live for her (switch on + gates pass). */
  bookOn: boolean;
  /** Shop is live for her (switch on + gates pass). */
  shopOn: boolean;
  /** Her published chapters, in her order. */
  chapters: { id: string; kind: ChapterKind; title: string }[];
  socials: PublicSocialLink[];
  /** Optional factual hints (off by default). Only for doors that are on. */
  hints?: { partner?: string | null; book?: string | null; shop?: string | null };
}

const SLOTS: TileSlot[] = ["tl", "tr", "bl", "br"];

export const DOOR_COPY = {
  partner: { label: "Partner", sub: () => "Sponsorships, posts, interviews & more" },
  book: { label: "Book", sub: (first: string) => `Book a session with ${first}` },
  // The Front Door's door words (owner-approved, 10 Oct 2026): Partner · Book · Picks · Create.
  shop: { label: "Picks", sub: (first: string) => `Things ${first} uses` },
  create: { label: "Create", sub: () => "Coming soon" },
} as const;

type Fallback = Omit<PublicTile, "slot">;

/** The ordered fallback candidates for this athlete. Each one is distinct from every other. */
function fallbackCandidates(input: TileSlotInput): Fallback[] {
  const first = input.firstName;
  const out: Fallback[] = [];
  const used = new Set<string>();
  const story = input.chapters.find((c) => c.kind === "story") ?? input.chapters[0];
  if (story) {
    out.push({ intent: "story", label: "Story", subLabel: `See ${first}'s story`, targetChapterId: story.id });
    used.add(story.id);
  }
  if (input.socials.length > 0) {
    const sub = input.socials.length === 1 ? `${first} on ${input.socials[0].network}` : `${first}'s social profiles`;
    out.push({ intent: "follow", label: "Follow", subLabel: sub });
  }
  const media = input.chapters.find((c) => c.kind === "media" && !used.has(c.id));
  if (media) {
    out.push({ intent: "story", label: "Story", subLabel: `Photos & videos of ${first}`, targetChapterId: media.id });
    used.add(media.id);
  }
  for (const c of input.chapters) {
    if (used.has(c.id)) continue;
    out.push({ intent: "story", label: "Story", subLabel: `See ${c.title}`, targetChapterId: c.id });
    used.add(c.id);
  }
  // Last resort only (see header): the grid still never shows two identical tiles.
  out.push({ intent: "ask", label: "Ask", subLabel: `Questions about ${first}` });
  return out;
}

/** Resolve the four tiles, in slot order tl, tr, bl, br. */
export function resolveTileSlots(input: TileSlotInput): [PublicTile, PublicTile, PublicTile, PublicTile] {
  const first = input.firstName;
  const fallbacks = fallbackCandidates(input);
  let next = 0;
  const take = (): Fallback => fallbacks[Math.min(next++, fallbacks.length - 1)];
  const hint = (h: string | null | undefined) => (h && h.trim() ? h.trim() : null);

  const doors: Fallback[] = [
    input.partnerOn
      ? { intent: "partner", label: DOOR_COPY.partner.label, subLabel: DOOR_COPY.partner.sub(), hint: hint(input.hints?.partner) }
      : take(),
    input.bookOn
      ? { intent: "book", label: DOOR_COPY.book.label, subLabel: DOOR_COPY.book.sub(first), hint: hint(input.hints?.book) }
      : take(),
    input.shopOn
      ? { intent: "shop", label: DOOR_COPY.shop.label, subLabel: DOOR_COPY.shop.sub(first), hint: hint(input.hints?.shop) }
      : take(),
    { intent: "create", label: DOOR_COPY.create.label, subLabel: DOOR_COPY.create.sub(), soon: true },
  ];
  return doors.map((d, i) => ({ ...d, slot: SLOTS[i] })) as [PublicTile, PublicTile, PublicTile, PublicTile];
}
