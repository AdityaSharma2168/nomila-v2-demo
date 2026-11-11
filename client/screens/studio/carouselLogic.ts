/**
 * carouselLogic — the pure half of the Carousel Create screen (PR 9, Lane 4).
 *
 *   ⚠️ MUTATION "a 4th reference accepted" (client half): let `addRef` take a fourth — reds by name.
 *   ⚠️ MUTATION "candidate or stage count exceeds the quote" (client half): let `setVariations` pass a total
 *      over three — reds by name.
 *   ⚠️ MUTATION "download-all names its count": drop the count from `downloadAllLabel` — reds by name.
 *   ⚠️ MUTATION "ad chip runs headless instead of opening this screen": structural (carouselLogic.test).
 */
import type { EditPresented, EditRec } from "./editTypes";

export const MAX_REFS = 3;
export const MAX_INITIAL_CANDIDATES = 3;
export const MAX_CANDIDATES = 4;

export interface CarouselRef {
  assetId: string;
  thumbUrl: string | null;
  /** How many ads from this photo. */
  variations: number;
  /** The grounded cleanup rec the popover's pass answered for this photo, or null (manual none). */
  cleanup: EditRec | null;
  /** The source gate's copy when the photo cannot be used yet (untagged, someone else), else null. */
  refusal: string | null;
}

export const totalVariations = (refs: readonly CarouselRef[]): number =>
  refs.reduce((s, r) => s + r.variations, 0);

/** Add a photo as a reference — at most three, never twice; the fourth is refused in copy. */
export function addRef(
  refs: readonly CarouselRef[],
  photo: { assetId: string; thumbUrl: string | null },
): { ok: true; refs: CarouselRef[] } | { ok: false; reason: string } {
  if (refs.some((r) => r.assetId === photo.assetId))
    return { ok: false, reason: "That photo is already in." };
  if (refs.length >= MAX_REFS)
    return {
      ok: false,
      reason: `Up to ${MAX_REFS} photos — remove one to add another.`,
    };
  // The newcomer takes one ad unless the three are already spoken for; then it takes none of the total.
  const free = MAX_INITIAL_CANDIDATES - totalVariations(refs);
  return {
    ok: true,
    refs: [
      ...refs,
      {
        ...photo,
        variations: Math.max(1, Math.min(1, free)),
        cleanup: null,
        refusal: null,
      },
    ],
  };
}

export const removeRef = (
  refs: readonly CarouselRef[],
  assetId: string,
): CarouselRef[] => refs.filter((r) => r.assetId !== assetId);

/** Her distribution: this photo makes `n` ads, as long as the total stays at three. */
export function setVariations(
  refs: readonly CarouselRef[],
  assetId: string,
  n: number,
): { ok: true; refs: CarouselRef[] } | { ok: false; reason: string } {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INITIAL_CANDIDATES)
    return { ok: false, reason: "One to three ads from each photo." };
  const others = refs.filter((r) => r.assetId !== assetId);
  if (totalVariations(others) + n > MAX_INITIAL_CANDIDATES)
    return {
      ok: false,
      reason: `Up to ${MAX_INITIAL_CANDIDATES} ads in one go.`,
    };
  return {
    ok: true,
    refs: refs.map((r) =>
      r.assetId === assetId ? { ...r, variations: n } : r,
    ),
  };
}

export const canCreate = (refs: readonly CarouselRef[]): boolean =>
  refs.length > 0 &&
  refs.every((r) => !r.refusal) &&
  totalVariations(refs) >= 1 &&
  totalVariations(refs) <= MAX_INITIAL_CANDIDATES;

/** The batch quote's body — the cleanup rides ONLY where the pass grounded one for that photo. */
export function batchBody(
  refs: readonly CarouselRef[],
  brand: string,
  campaign: { product?: string; story?: string; goal?: string } | null,
  briefLines: readonly string[],
  headline: string | null,
  /** Required (Adi, 23 Sep 2026): the first ad is set where she says, the others somewhere else. */
  setting: string,
) {
  return {
    refs: refs.map((r) => ({
      assetId: r.assetId,
      variations: r.variations,
      cleanup: r.cleanup,
    })),
    brand,
    ...(campaign && Object.keys(campaign).length ? { campaign } : {}),
    ...(headline ? { headline } : {}),
    setting,
    briefLines: [...briefLines],
  };
}

/** The Download-all button names what it will save (Adi's rider 3). */
export const downloadAllLabel = (readyCount: number): string =>
  readyCount === 1
    ? "Download all · 1 frame"
    : `Download all · ${readyCount} frames`;

/** The grid's candidates: never an intermediate, newest last. */
export const candidatesOf = (rows: readonly EditPresented[]): EditPresented[] =>
  rows
    .filter((r) => !r.intermediate)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export interface ReadyBatch {
  batchId: string;
  ready: number;
  total: number;
}

/**
 * Carousels with results waiting for her — the Now feed's row (the one away-completion surface): a batch
 * whose candidates are all settled, at least one ready and none yet decided.
 */
export function readyBatches(
  rows: readonly EditPresented[],
  now: number = Date.now(),
): ReadyBatch[] {
  const byBatch = new Map<string, EditPresented[]>();
  for (const r of rows) {
    if (!r.batchId || r.intermediate) continue;
    // An expired row is not waiting for her (PR 10, R-7): the server no longer lists it, and a cached
    // list cannot resurrect it here. ⚠️ MUTATION (carouselLogic.test): drop this line — "an expired
    // ready row shows under Now" reds by name.
    if (r.expired === true || Date.parse(r.expiresAt) <= now) continue;
    byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r]);
  }
  const out: ReadyBatch[] = [];
  for (const [batchId, cs] of byBatch) {
    const settled = cs.every(
      (c) => c.status !== "quoted" && c.status !== "running",
    );
    const ready = cs.filter((c) => c.status === "ready").length;
    const decided = cs.some(
      (c) => c.status === "accepted" || c.status === "discarded",
    );
    if (settled && ready > 0 && !decided)
      out.push({ batchId, ready, total: cs.length });
  }
  return out;
}

/**
 * The results appear together, once every candidate has finished (Adi, 23 Sep 2026): three small windows
 * hold the place while any is still quoted or running, and nothing is drawn until all are settled — so the
 * grid never redraws frame by frame as they land.
 */
export const allSettled = (candidates: readonly EditPresented[]): boolean =>
  candidates.length > 0 &&
  candidates.every((c) => c.status !== "quoted" && c.status !== "running");
