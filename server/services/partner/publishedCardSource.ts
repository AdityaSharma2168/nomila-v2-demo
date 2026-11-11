/**
 * partner/publishedCardSource.ts — the real PublishedCardSource: an adapter over publicCardReader (the ONE public read,
 * server/services/publicCard/publicCardReader.ts). The Partner door sees exactly what her published snapshot shows:
 * her first name, the version, whether the Partner door is live, and each chapter's published words. Nothing else.
 *
 * Like every public surface it imports only the reader (publicCard.boundary.test.ts B3: no schema, no db here).
 * A redirect (an old handle) or a miss is "no card": the public partner routes answer the same 404.
 */
import { publicCardReader } from "../publicCard/publicCardReader";
import type { PublicCardContent } from "../../../shared/publicCard";
import type { PublishedCardFacts, PublishedCardSource } from "./publishedCard";

/** A chapter's published words, one line per item (verbatim as she approved them). */
function chapterText(ch: PublicCardContent["chapters"][number]): string {
  return ch.items
    .map((i) => [i.label, i.text].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join(": "))
    .filter(Boolean)
    .join("\n");
}

export function factsFromContent(athleteId: string, handle: string, version: number, content: PublicCardContent): PublishedCardFacts {
  return {
    athleteId,
    handle,
    firstName: content.firstName || content.displayName,
    version,
    partnerOpen: content.doors?.partner === true,
    chapters: content.chapters
      .map((c) => ({ id: c.key, title: c.title, text: chapterText(c) }))
      .filter((c) => c.text.length > 0),
  };
}

export const publicCardReaderSource: PublishedCardSource = {
  async byHandle(handle) {
    const r = await publicCardReader.read(handle);
    return r.status === "ok" ? factsFromContent(r.athleteId, r.handle, r.version, r.content) : null;
  },
};
