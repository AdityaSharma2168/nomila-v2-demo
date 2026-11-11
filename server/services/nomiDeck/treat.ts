/**
 * nomiDeck/treat.ts — the Nomi Card's photos in the brand book's treatment (lib/photoTreat): each screen's lead photo
 * cropped to its shape around the athlete's stored face box and graded in the card's look; statement screens also get a
 * toned backdrop. $0 per document: every result is made once and cached per (photo, shape, treatment, look, face).
 * A failed treatment keeps the original photo.
 */
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { treatedPath, type PhotoLook, type SlotShape } from "../../lib/photoTreat";
import type { FaceBox } from "../../lib/visionTag";
import type { MediaKitData } from "../mediaKitService";
import { coverFitFor, planDeck, type CoverFit } from "./layout";
export { coverFitFor, type CoverFit } from "./layout";

type Kit = MediaKitData;

/** Which shape a screen's photo is cut to: full-screen hero screens 9:16, tiles 4:5. Pure. */
export function shapeOfScreen(kind: string): SlotShape {
  return kind === "gallery" ? "gallery" : kind === "data" || kind === "record" ? "band" : "statement";
}

/** The stored face boxes for a set of bucket paths (vision tags). */
export async function faceBoxes(paths: string[]): Promise<Map<string, FaceBox | null>> {
  const out = new Map<string, FaceBox | null>();
  const uniq = [...new Set(paths.filter((p) => p && !/^https?:/i.test(p)))];
  if (!uniq.length) return out;
  const rows = await db.select({ gcs_path: mediaAssets.gcs_path, metadata: mediaAssets.metadata }).from(mediaAssets).where(inArray(mediaAssets.gcs_path, uniq));
  for (const r of rows) if (r.gcs_path) out.set(r.gcs_path, ((r.metadata as any)?.vision?.face_box as FaceBox | undefined) ?? null);
  return out;
}

/**
 * The kit with every drawn photo treated (bucket paths in, bucket paths out — sign afterwards), plus toned backdrops per
 * statement card id. Brand imagery (http URLs) and logos are left untouched.
 */
export async function treatKitImages(kit: Kit, look: PhotoLook): Promise<{ kit: Kit; backdrops: Record<string, string>; coverFit: CoverFit }> {
  const screens = planDeck(kit);
  const cards = kit.cards.map((c) => ({ ...(c as any) }));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const paths: string[] = [];
  for (const s of screens) if (s.image) paths.push(s.image);
  for (const c of cards) if (c.type === "content") for (const t of c.tiles ?? []) if (t.image) paths.push(t.image);
  const faces = await faceBoxes(paths).catch(() => new Map<string, FaceBox | null>());
  const backdrops: Record<string, string> = {};
  let closeImg: string | null = null;
  let coverFit: CoverFit = "overlay";
  const isBucket = (p: string | null | undefined): p is string => !!p && !/^https?:/i.test(p);

  await Promise.all(screens.map(async (s) => {
    if (!isBucket(s.image)) return;
    const face = faces.get(s.image) ?? null;
    let shape = shapeOfScreen(s.kind);
    if (s.kind === "cover") { coverFit = coverFitFor(face); if (coverFit === "split") shape = "band"; }
    const treated = await treatedPath(s.image, { shape, treatment: "photo", look, face });
    if (s.cardId) {
      const c = byId.get(s.cardId);
      if (c) { if ("image" in c && c.image === s.image) c.image = treated; else if (c.bg === s.image) c.bg = treated; }
      if (s.kind === "statement") {
        const toned = await treatedPath(s.image, { shape: "statement", treatment: "tonal", look, face });
        if (toned !== s.image) backdrops[s.cardId] = toned;
      }
    } else if (s.kind === "close") {
      closeImg = treated;
    }
  }));
  for (const c of cards) {
    if (c.type !== "content") continue;
    c.tiles = await Promise.all((c.tiles ?? []).map(async (t: any) => (isBucket(t.image) ? { ...t, image: await treatedPath(t.image, { shape: "gallery", treatment: "photo", look, face: faces.get(t.image) ?? null }) } : t)));
  }
  const out: Kit = { ...kit, cards: cards as Kit["cards"] };
  // The close draws the first pool photo no other screen uses — put its treated copy first so the plan picks it again.
  if (closeImg) out.imagePool = [{ gcsPath: closeImg, shotType: "close", hero: 1 }, ...(kit.imagePool ?? [])];
  return { kit: out, backdrops, coverFit };
}
