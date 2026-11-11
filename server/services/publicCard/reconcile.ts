/**
 * publicCard/reconcile.ts — "pulled at once, without waiting for her" (design-public-card-v3 §10).
 *
 * Light on purpose (single-table reads, no identity or model code), so any writer can call it after it commits: the
 * signed-deal undo (routes/agentActions.ts) and her shelf edits (routes/shop.ts) do.
 */
import { createLogger } from "../../logger";
import { publicShelf } from "../shop/publicShelf";
import { publishRemoval, publishedContent } from "./publish";
import { ownMedia, publishedOffers, signedPartners } from "./sources";
import { contentItems, type Door } from "./types";
import { opaqueItemKey } from "./mediaKey";

const logger = createLogger("publicCard/reconcile");

/**
 * "Pulled at once, without waiting for her" (§10): compares her PUBLISHED card with what is live now and writes a
 * removal for anything whose source went away — a partner whose deal is no longer signed, a media item deleted or
 * rejected, a pick that left her shelf, an offer no longer published (Book closes with the last one), or the shelf
 * closing. Never adds. Identity lines are not reconciled here: their changes collect in her next draft.
 * Safe to call from any writer after it commits; a no-op unless the card is published. Errors are logged, not thrown.
 */
export async function reconcilePublishedCard(athleteId: string, reason: string): Promise<number | null> {
  try {
    const current = await publishedContent(athleteId);
    if (!current) return null;
    const items = contentItems(current);
    const has = (prefix: string) => items.some((i) => i.key.startsWith(prefix));
    const [partners, media, offerRows, shelf] = await Promise.all([
      has("partner:") ? signedPartners(athleteId) : Promise.resolve([]),
      has("media:") ? ownMedia(athleteId) : Promise.resolve([]),
      has("offer:") ? publishedOffers(athleteId) : Promise.resolve([]),
      has("pick:") || current.doors.shop ? publicShelf(athleteId) : Promise.resolve({ picks: [], amazonStatement: null }),
    ]);
    const live = new Set<string>([
      ...partners.map((p) => opaqueItemKey(athleteId, `partner:${p.dealId}`)),
      ...media.map((m) => opaqueItemKey(athleteId, `media:${m.assetId}`)),
      ...offerRows.map((o) => `offer:${o.publicId}`),
      ...shelf.picks.map((p) => `pick:${p.href.split("/").pop()}`),
    ]);
    const gone = items.filter((i) => /^(partner|media|offer|pick):/.test(i.key) && !live.has(i.key)).map((i) => i.key);
    const closeDoors: Door[] = [];
    if (current.doors.shop && shelf.picks.length === 0) closeDoors.push("shop");
    if (current.doors.book && offerRows.length === 0 && has("offer:")) closeDoors.push("book");
    if (!gone.length && !closeDoors.length) return null;
    return await publishRemoval(athleteId, { itemKeys: gone, closeDoors, reason });
  } catch (err: any) {
    logger.error({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "public card reconcile failed");
    return null;
  }
}
