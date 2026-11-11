/**
 * previewAsset.ts — the one mark a post-kit PREVIEW carries in media_assets, and the predicate every library reader
 * adds to skip it (design "Moments → post kits" §11 v2; agent/postKit/render/publish.ts writes it).
 *
 * A preview is a derived file (origin "generated", derived_from_asset_id set) re-rendered on every swap: it is not
 * something she made, so it is not on the Made shelf, not in her library or its search, and never sent to enrichment
 * (which would pay a vision call per render). It is reached only through its kit (postKit.preview's asset ids).
 *
 * The mark is `content_format` — free text, no CHECK, "the canonical format" of a row — set to POST_KIT_PREVIEW_FORMAT.
 * No migration. `IS DISTINCT FROM`, so the NULL every other row holds still passes.
 */
import { sql } from "drizzle-orm";
import { mediaAssets } from "../../shared/schema";

export const POST_KIT_PREVIEW_FORMAT = "post_kit_preview";

/** True for every row that is not a post-kit preview. */
export const notAPreview = () => sql`${mediaAssets.content_format} IS DISTINCT FROM ${POST_KIT_PREVIEW_FORMAT}`;
