/**
 * The brand book's photo treatment (21 Oct 2026): each cast photo cropped to its slot around her face and graded in the
 * book's look — the one look's neutral "campaign" grade since 23 Oct 2026 (it was "luxe": warmer, grain, lifted blacks);
 * statement slots also get a toned (neutral) backdrop; the cover is cut out on ink when it is a decent match or busy,
 * PHOTO_CUTOUT_V1 is on and a mask exists. All $0 (lib/photoTreat, cached per photo + treatment).
 */
import { readObject } from "../../lib/mediaStore";
import { cutoutEnabled, hasMask, isBusy, treatedPath, type PhotoLook, type SlotShape } from "../../lib/photoTreat";
import type { FaceBox } from "../../lib/visionTag";

export type CastLike = { gcsPath: string; tier?: "strong" | "decent" | "atmosphere"; tags?: { face_box?: FaceBox | null } | null };

/**
 * Which slot shape each brand book photo slot is drawn at. Pure. The reader draws the cover, the big idea and each pillar
 * full-bleed over a whole phone screen (one screen per page), so those are cropped tall (9:16) around her face; the
 * story, voice and plan photos sit inset (4:5).
 */
export function slotShapeOf(key: string): SlotShape {
  return key === "cover" || key === "big_idea" || key === "close" || key.startsWith("pillar.") ? "statement" : "gallery";
}
/** The book's photo grade: the one look's neutral grade (owner, 23 Oct 2026). Part of the cache key, so the switch re-treats. */
export const BOOK_PHOTO_LOOK: PhotoLook = "campaign";

/** The slots whose page sets a big line over a toned photo (statement pages). */
export const BACKDROP_SLOTS = ["big_idea", "plan"] as const;

/**
 * The book's photos, treated: each slot cropped around her face and graded "campaign"; statement slots also get a toned
 * backdrop; the cover is cut out on ink when it is a decent match or its background is busy, the cut-out is on and a
 * mask exists. Slots run in parallel; any failure keeps that slot's original.
 */
export async function treatBookImages(
  cast: Record<string, CastLike | null>, images: Record<string, string | null>,
): Promise<{ images: Record<string, string | null>; backdrops: Record<string, string> }> {
  const look = BOOK_PHOTO_LOOK;
  const outImages: Record<string, string | null> = { ...images };
  const backdrops: Record<string, string> = {};
  await Promise.all(Object.entries(images).map(async ([key, path]) => {
    if (!path) return;
    const face = cast[key]?.tags?.face_box ?? null;
    let treatment: "photo" | "cutout" = "photo";
    if (key === "cover" && cutoutEnabled() && await hasMask(path)) {
      const decent = cast[key]?.tier === "decent";
      const busy = decent ? true : await readObject(path, 40_000_000).then((o) => (o ? isBusy(o.buf) : false)).catch(() => false);
      if (busy) treatment = "cutout";
    }
    outImages[key] = await treatedPath(path, { shape: slotShapeOf(key), treatment, look, face });
    if ((BACKDROP_SLOTS as readonly string[]).includes(key)) {
      const toned = await treatedPath(path, { shape: "statement", treatment: "tonal", look, face });
      if (toned !== path) backdrops[key] = toned;
    }
  }));
  return { images: outImages, backdrops };
}

/** A place from the atmosphere library as a toned backdrop behind a type-led page (cover / big idea). $0, cached; the original on any failure. */
export async function tonedBackdrop(path: string): Promise<string> {
  return treatedPath(path, { shape: "statement", treatment: "tonal", look: BOOK_PHOTO_LOOK, face: null }).catch(() => path);
}
