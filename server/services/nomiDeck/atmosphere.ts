/**
 * The Nomi Card's ATMOSPHERE tier (22 Oct 2026; atmosphere/documentFill). A screen the athlete's own photos leave empty
 * takes a place from the shared sport library — pitch, court, track, never a person — before it falls back to type-led:
 *   - statement, record, fit and calendar screens lead with it (card `image` or `bg`, recorded as imageTier "atmosphere");
 *   - the cover never shows a place AS the athlete: it gets a toned backdrop behind its type-led layout;
 *   - the close takes one from the pool only when no photo of the athlete is left for it;
 *   - proof (content) and audience never take one.
 * $0: the library is stored; only the cached tonal treatment runs.
 */
import type { MediaKitData } from "../mediaKitService";
import { fillFromAtmosphere, type FillDeps } from "../atmosphere/documentFill";
import { planDeck } from "./layout";

type Kit = MediaKitData;

/** Which deck screens may take a place, keyed as documentFill keys them. Pure. */
export function atmosphereSlotsOf(kit: Kit): Array<{ key: string; cardId: string | null; filled: boolean }> {
  return planDeck(kit).map((s) => ({
    key: s.kind === "close" ? "close" : s.cardType,
    cardId: s.cardId,
    filled: !!s.image,
  }));
}

/**
 * The kit with its empty screens filled from the atmosphere library, plus the cover's backdrop path (untreated; the
 * caller tones it) when the cover has no photo of the athlete. Never throws: no library → the kit unchanged.
 */
export async function fillKitAtmosphere(kit: Kit, deps?: FillDeps): Promise<{ kit: Kit; coverBackdrop: string | null }> {
  const slots = atmosphereSlotsOf(kit);
  const fill = await fillFromAtmosphere(kit.identity?.sport ?? null, slots.map((s) => ({ key: s.key, filled: s.filled })), deps)
    .catch(() => ({ images: {} as Record<string, string>, backdrops: {} as Record<string, string>, atmosphereKeys: [] as string[] }));
  const byType = new Map(slots.filter((s) => s.cardId).map((s) => [s.key, s.cardId!]));
  const cards = kit.cards.map((c) => {
    const id = byType.get(c.type);
    const path = id === c.id ? fill.images[c.type] : undefined;
    if (!path) return c;
    // Cards with their own image field (fit, ideas) lead with it; the rest carry a background (what signKit signs).
    return ("image" in (c as any) ? { ...(c as any), image: path, imageTier: "atmosphere" } : { ...(c as any), bg: path, imageTier: "atmosphere" }) as typeof c;
  });
  const out: Kit = { ...kit, cards };
  if (fill.images.close) out.imagePool = [...(kit.imagePool ?? []), { gcsPath: fill.images.close, shotType: "atmosphere", hero: 0 }];
  return { kit: out, coverBackdrop: fill.backdrops.cover ?? null };
}

