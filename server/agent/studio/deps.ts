/**
 * agent/studio/deps.ts — the production wiring for the Studio library route: the real db store, the post-kit media
 * port (for a kit's thumbnail) and the real pitches list (today's decks).
 */
import { dbStore } from "../research/dbStore";
import { dbPostKitMedia } from "../postKit/media";
import { listPitches } from "../../services/pitches";
import type { StudioItemsDeps } from "./items";

export function dbStudioItemsDeps(): StudioItemsDeps {
  return { store: dbStore, media: dbPostKitMedia, pitches: listPitches };
}
