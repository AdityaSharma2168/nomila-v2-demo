/**
 * publishedCardDouble.ts — a PublishedCardSource over a fixed list of cards, for tests of the Partner door. The real
 * source is the snapshot track's publicCardReader (server/services/partner/publishedCard.ts explains the seam).
 */
import type { PublishedCardFacts, PublishedCardSource } from "../services/partner/publishedCard";

export function fixedCardSource(cards: PublishedCardFacts[]): PublishedCardSource {
  return { byHandle: async (h) => cards.find((c) => c.handle.toLowerCase() === h) ?? null };
}

export function cardFor(athleteId: string, handle: string, over: Partial<PublishedCardFacts> = {}): PublishedCardFacts {
  return {
    athleteId, handle, firstName: "Avery", version: 3, partnerOpen: true,
    chapters: [
      { id: "story", title: "Story", text: "Trains before sunrise; writes about recovery and routine." },
      { id: "media", title: "Media", text: "Short training videos and long-form recovery notes." },
    ],
    ...over,
  };
}
