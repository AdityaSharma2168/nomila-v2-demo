// use-my-front-door — her own Front Door page, as Me and her full page view draw it (components/frontDoor/FrontDoorPage).
//
//   content      GET /me/public-card/preview: exactly what Publish would freeze now (the same content the visitor's page
//                renders); the draft's card state says whether it is live and under which handle
//   hero photo   HER OWN photo (Highlights is about her, DESIGN.md §9): the first image she published, while the card is
//                live; otherwise her library's best eligible photo (the Home hero's pick)
//   chapters     ATMOSPHERE from the picker (POST /me/atmosphere/pick, screen "public_page", one slot per chapter); a
//                chapter the picker has nothing for (or the picker off) draws its category default
//   metrics      GET /me/public-card/metrics (views · likes · requests · bookings · shop, last 30 days); zeros while it
//                loads or fails are never shown as hers: the rail waits for the answer

import { usePublicCardDraft, usePublicCardPreview } from "./use-public-card";
import { useMePool } from "./use-me-knowledge";
import { useAtmosphere, usePageMetrics } from "./use-me-memory";
import { publicCardApi } from "../lib/publicCardApi";
import { meImagery, photoUri } from "../lib/myStoryLogic";
import { frontDoorModel, CHAPTER_DOMAIN, type FrontDoorModel } from "../lib/frontDoorLogic";
import type { ChapterImages } from "../components/frontDoor/FrontDoorPage";
import type { PublicCardContent } from "../../shared/publicCard";
import type { AtmosphereSlot } from "../lib/meMemoryApi";
import type { PublicPageMetrics } from "../../shared/publicPageStats";

/** The first image she published on the card (Highlights first), as its public media key. */
export function firstImageKey(c: PublicCardContent | null | undefined): string | null {
  if (!c) return null;
  const ordered = [...c.chapters.filter((ch) => ch.key === "highlights"), ...c.chapters.filter((ch) => ch.key !== "highlights")];
  for (const ch of ordered) for (const it of ch.items) if (it.kind === "media" && it.mediaKey && it.mediaType !== "video") return it.mediaKey;
  return null;
}

export interface MyFrontDoor {
  model: FrontDoorModel | null;
  metrics: PublicPageMetrics | null;
  chapterImages: ChapterImages;
  verified: boolean;
  live: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useMyFrontDoor(enabled = true): MyFrontDoor {
  const preview = usePublicCardPreview(enabled);
  const draft = usePublicCardDraft(enabled);
  const metrics = usePageMetrics(enabled);
  const pool = useMePool();
  const content = preview.data?.content ?? null;
  const card = draft.data?.card ?? null;
  const live = card?.status === "published" && !!card.handle;
  const key = live ? firstImageKey(content) : null;
  const published = key ? `${publicCardApi.publicBase()}/p/${encodeURIComponent(card!.handle!)}/m/${encodeURIComponent(key)}` : null;
  const heroPhoto = published ?? photoUri(meImagery(pool, "home").hero);
  const chapters = (content?.chapters ?? []).filter((c) => c.key !== "highlights");
  const slots: AtmosphereSlot[] = chapters.map((c) => ({
    key: `chapter:${c.key}`, type: "section_header", purpose: CHAPTER_DOMAIN[c.key] ?? "positioning", context: c.title,
  }));
  const images = useAtmosphere("public_page", slots, enabled && !!content);
  const chapterImages: ChapterImages = {};
  for (const c of chapters) {
    const img = images[`chapter:${c.key}`];
    if (img) chapterImages[c.key] = { url: img.url, credit: img.credit };
  }
  return {
    model: content ? frontDoorModel(content, { handle: preview.data?.handle ?? card?.handle ?? null, heroPhoto }) : null,
    metrics: metrics.data ?? null,
    chapterImages,
    verified: !!content?.verified,
    live,
    isLoading: preview.isLoading,
    isError: preview.isError,
    refetch: () => { preview.refetch(); draft.refetch(); metrics.refetch(); },
  };
}
