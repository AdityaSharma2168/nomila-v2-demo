/**
 * editPopoverLogic — the pure half of the compose picker's edit popover (PR 9, Lane 3a).
 *
 * The popover is a card BELOW the strip that fired, owned by AgentScreen, driven by ONE piece of state:
 * `lastPicked` — the photo she just SELECTED. It is set by the toggle's outcome and never the other way
 * round: selection state never reads the popover, the popover never gates a pick. Everything decidable
 * without React lives here so it can be pinned:
 *
 *   ⚠️ MUTATION "edit offered on an unselected photo": return the id on a deselect too — reds by name.
 *   ⚠️ MUTATION "popover blocks selection": make `toggleIn` consult a popover flag — reds by name (the
 *      toggle is the same pure function with or without a popover open).
 *   ⚠️ MUTATION "edited selection loses derived_from": swap in an id other than the accepted asset's —
 *      reds by name (`swapIn` replaces the source id with EXACTLY the id accept answered).
 */
import type { EditPresented, StudioEditOp } from "./editTypes";

export type PickList = "picked" | "products";

export interface LastPicked {
  list: PickList;
  assetId: string;
  /** Her order among the picks, 1-based — "Photo 3". */
  ordinal: number;
}

/** The compose screen's toggle, unchanged: add up to the cap, or remove. Reads nothing but the list. */
export const toggleIn = (
  l: string[],
  assetId: string,
  cap: number,
): string[] =>
  l.includes(assetId)
    ? l.filter((id) => id !== assetId)
    : l.length >= cap
      ? l
      : [...l, assetId];

/**
 * What the popover shows after a toggle: the photo when the toggle ADDED it, nothing when it removed it
 * or could not add it (the cap). A deselect never offers an edit.
 */
export function lastPickedAfterToggle(
  list: PickList,
  before: string[],
  after: string[],
  assetId: string,
): LastPicked | null {
  const added = !before.includes(assetId) && after.includes(assetId);
  if (!added) return null;
  return { list, assetId, ordinal: after.indexOf(assetId) + 1 };
}

/** The accepted edit takes the source's place in the list, at the same position, once. */
export function swapIn(
  list: string[],
  sourceId: string,
  acceptedAssetId: string,
): string[] {
  if (!list.includes(sourceId) || list.includes(acceptedAssetId)) return list;
  return list.map((id) => (id === sourceId ? acceptedAssetId : id));
}

/**
 * The confirmed brief's lines the recommendation pass reads — its constraints, the product line, the story.
 * A brief with none of them yields no lines, and no lines means no call (manual only).
 */
export function briefLinesFrom(
  campaign: Record<string, unknown> | null | undefined,
): string[] {
  if (!campaign) return [];
  const out: string[] = [];
  const constraints = campaign.constraints;
  if (Array.isArray(constraints))
    for (const c of constraints)
      if (typeof c === "string" && c.trim()) out.push(c.trim());
  const product = campaign.product as { line?: unknown } | null | undefined;
  if (product && typeof product.line === "string" && product.line.trim())
    out.push(product.line.trim());
  if (typeof campaign.story === "string" && campaign.story.trim())
    out.push(campaign.story.trim());
  return out.slice(0, 12);
}

/**
 * The manual ops the popover offers. The ad op is Lane 4's door (its chip deep-links to the Carousel
 * Create screen) and is NOT offered until that screen exists — no dead chip ever renders.
 */
export const MANUAL_OPS: readonly {
  op: StudioEditOp;
  label: string;
  hint: string;
}[] = [
  {
    op: "recolour",
    label: "Recolour",
    hint: "Change one thing's colour — the jersey, the shorts.",
  },
  {
    op: "garment",
    label: "Swap the kit",
    hint: "Change a garment to a brand's version, or put a design on it.",
  },
  {
    op: "product",
    label: "Place a product",
    hint: "Put a product photo in the frame, draw a thing in, or take one out.",
  },
  {
    op: "background_clean",
    label: "Clean the background",
    hint: "Keep you; replace what is behind you.",
  },
];

// ─── The sheet's pure rules (components/studio/EditSheet.tsx reads these) ──────────────────────────

export type SheetStep = "op" | "params" | "quote" | "preview";

/** Accept exists only once a preview is on screen. The one rule the sheet must never bend. */
export const canAccept = (
  step: SheetStep,
  edit: EditPresented | null,
): boolean =>
  step === "preview" && !!edit && edit.status === "ready" && !!edit.url;

/** The op's params from her fields — null until every required one is there. Mirrors ops.ts's shapes. */
/**
 * The body the edit sheet POSTs to /studio/edits/quote: the op, and a style MODIFIER when she picked a look
 * (PR 18, ADI-GO18 G2). With no look picked it is exactly the body the sheet always sent: no `styleAssetId`
 * key at all. The server test that crosses the client/server boundary (edit/engine.style.test, M18) builds its
 * request with this function, so the path the sheet takes is the one measured.
 */
export function quoteBodyFor(
  sourceAssetId: string,
  op: StudioEditOp,
  params: Record<string, unknown>,
  styleAssetId: string | null,
): {
  sourceAssetId: string;
  op: StudioEditOp;
  params: Record<string, unknown>;
  styleAssetId?: string;
} {
  return {
    sourceAssetId,
    op,
    params,
    ...(styleAssetId ? { styleAssetId } : {}),
  };
}

export function paramsFor(
  op: StudioEditOp,
  f: Record<string, string>,
  productId: string | null,
): Record<string, unknown> | null {
  const t = (k: string) => (f[k] ?? "").trim();
  switch (op) {
    case "recolour":
      return t("target") && t("colour")
        ? { target: t("target"), colour: t("colour") }
        : null;
    case "garment":
      if (!t("garment")) return null;
      if (t("brand") && !t("design"))
        return { garment: t("garment"), brand: t("brand") };
      if (t("design") && !t("brand"))
        return { garment: t("garment"), design: t("design") };
      return null;
    case "product": {
      // Three modes, one op (Adi, 23 Sep 2026): place her photo, draw a thing in, take a thing out.
      const mode = t("mode") || "place";
      if (mode === "remove")
        return t("target") ? { mode, target: t("target") } : null;
      const place =
        t("preposition") && t("place")
          ? { place: { preposition: t("preposition"), place: t("place") } }
          : {};
      if (mode === "add")
        return t("thing") ? { mode, thing: t("thing"), ...place } : null;
      return productId && t("thing")
        ? { mode, productAssetId: productId, thing: t("thing"), ...place }
        : null;
    }
    case "background_clean":
      return t("setting") ? { setting: t("setting").slice(0, 40) } : {};
    case "ad":
      return null; // Lane 4's door; not offered here.
  }
}
