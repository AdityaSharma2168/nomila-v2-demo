/**
 * agent/onboarding/heroPhoto.ts — her own hero photo for the landing's share card (the app's Me hero, client
 * components/me/MeHero.tsx, picks it from her media library with lib/myStoryLogic eligibleStoryPhotos + heroCandidates).
 *
 * The same bar, on the stored rows: a stored, top-level PHOTO of hers (origin connected or upload: her own account or her
 * own upload, never a discovery, a generated image or a reference link), of her where the library has read it (vision
 * subject the_athlete), never a text graphic or a group shot, her face clear where the library has read it; portrait
 * frames first, then the most recent. Null when she has none: the card then uses an atmosphere photo, as the hero falls
 * back to the blank ground.
 *
 * The bytes are served by GET /api/v1/waitlist/hero-photo through the API (same CORS as every API read), so the
 * landing's canvas is never tainted and can export the card.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { notAPreview } from "../../lib/previewAsset";

const PHOTO_TYPES = ["IMAGE", "CAROUSEL_ALBUM"];
/** How many of her most recent photos are looked at. */
const LOOK_AT = 60;

export interface HeroRow { id: string; gcs_path: string | null; content_type: string | null; origin: string; width: number | null; height: number | null; metadata: unknown }

/** Pure: the hero among her rows (newest first), by the Me hero's bar; null when none meets it. */
export function pickHeroPhoto(rows: readonly HeroRow[]): HeroRow | null {
  const ok = rows.filter((r) => {
    if (!r.gcs_path || (r.content_type && !r.content_type.startsWith("image/"))) return false;
    if (r.origin !== "connected" && r.origin !== "upload") return false;
    const v = ((r.metadata as { vision?: Record<string, unknown> } | null)?.vision ?? null);
    if (v) {
      if (v.subject != null && v.subject !== "the_athlete") return false;
      if (v.shot_type === "text_graphic" || v.shot_type === "group") return false;
      if (v.face_visibility != null && v.face_visibility !== "clear") return false;
    }
    return true;
  });
  const portrait = (r: HeroRow) => typeof r.width === "number" && typeof r.height === "number" && r.height > r.width;
  return ok.find(portrait) ?? ok[0] ?? null;
}

/** Her hero photo's stored row, or null. */
export async function heroPhotoOf(athleteId: string): Promise<HeroRow | null> {
  const rows = await db.select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path, content_type: mediaAssets.content_type, origin: mediaAssets.origin, width: mediaAssets.width, height: mediaAssets.height, metadata: mediaAssets.metadata })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), inArray(mediaAssets.origin, ["connected", "upload"]),
      inArray(mediaAssets.media_type, PHOTO_TYPES), ne(mediaAssets.origin, "reference"), notAPreview()))
    .orderBy(sql`${mediaAssets.posted_at} DESC NULLS LAST`, desc(mediaAssets.id))
    .limit(LOOK_AT);
  return pickHeroPhoto(rows);
}
