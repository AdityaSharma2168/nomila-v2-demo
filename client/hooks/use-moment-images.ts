// A picture for each moment with nothing prepared yet (design "Studio and Home, designed", 20 Oct 2026): the atmosphere
// picker (POST /me/atmosphere/pick, server/services/atmosphere: a stored no-people photo for the moment's kind and name,
// else a new one within the caps), on ONE screen key shared by Home and Studio so a moment shows the same picture on
// both. Keyed by story id; a missing key (loading, the picker off, a "default" answer) → the moment's kind card.
// A moment with a post prepared shows that post's photo instead (useKitPhoto), so it never asks here.

import { useMemo } from "react";
import { useAtmosphere } from "./use-me-memory";
import { MOMENT_ATMOSPHERE_SCREEN, momentAtmosphereSlots, type StoryItem } from "../lib/homeV3Logic";

export function useMomentImages(stories: ReadonlyArray<StoryItem>, enabled = true): Record<string, string> {
  const slots = useMemo(() => momentAtmosphereSlots(stories), [stories]);
  const images = useAtmosphere(MOMENT_ATMOSPHERE_SCREEN, slots, enabled);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, img] of Object.entries(images)) out[key] = img.url;
    return out;
  }, [images]);
}
