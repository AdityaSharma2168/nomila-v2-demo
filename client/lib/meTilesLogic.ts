// Me v3 tiles ("Icons and Glass", 20 Oct 2026). Two kinds of tile, both pure data here so the screen only draws:
//
//   fixed      Your bookings, Your shop: one illustration, the same for every athlete (client/assets/illustrations).
//   composed   Brand book, Your plan, Your page, Your rates: a one-time empty frame (a book, a stack of prints, a page,
//              a rate card) with HER content laid onto its surfaces in code: her photos, her name, her rate ranges.
//              The screen flattens each composed tile into a single image once it has drawn (ComposedTile).
//
// Me is who she is and her SET-UP (owner, 20 Oct 2026): she sets things up here and runs them in Business. So there is no
// Offers tile (offers live in Business, and the urgent ones on Home), and Bookings / Shop are what people can book and
// what she picks, never request counts. Every tile carries one short line under its name (tileLine).
//
// Frame geometry is in the frame image's own 1024-unit space: each surface is the quad (top-left, top-right,
// bottom-right, bottom-left) of a flat face in the picture. A surface gets a local box w × h (its mean side lengths)
// and the affine map that best fits the box's corners onto the quad (least squares; the faces are near-frontal, so the
// fourth corner lands within a few units). Layers are boxes in that local space.

export type MeTileKey = "brand" | "plan" | "page" | "rates" | "offers" | "bookings" | "shop";
export type ComposedKey = Extract<MeTileKey, "brand" | "plan" | "page" | "rates">;
export type FixedKey = Extract<MeTileKey, "offers" | "bookings" | "shop">;

export const FRAME_UNITS = 1024;

type Pt = readonly [number, number];
type Quad = readonly [Pt, Pt, Pt, Pt];

/** The flat faces of each frame, back to front (later surfaces are drawn over earlier ones). */
export const FRAME_SURFACES: Record<ComposedKey, ReadonlyArray<{ id: string; quad: Quad }>> = {
  brand: [{ id: "cover", quad: [[258, 204], [670, 242], [670, 864], [262, 807]] }],
  plan: [
    { id: "print3", quad: [[578, 305], [869, 445], [674, 848], [383, 708]] },
    { id: "print2", quad: [[388, 203], [779, 286], [646, 789], [255, 706]] },
    { id: "print1", quad: [[304, 194], [691, 194], [691, 731], [304, 731]] },
  ],
  page: [{ id: "front", quad: [[221, 214], [679, 214], [679, 893], [221, 893]] }],
  rates: [{ id: "card", quad: [[322, 217], [812, 217], [812, 908], [322, 908]] }],
};

/** x' = a·u + c·v + e, y' = b·u + d·v + f (the CSS / canvas order). */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }
export interface Surface { id: string; w: number; h: number; m: Affine }

const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** The local box and best-fit affine map for a quad (see the header). */
export function surfaceOf(id: string, quad: Quad): Surface {
  const [tl, tr, br, bl] = quad;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  // Corners relative to the box centre: (-w/2,-h/2) (w/2,-h/2) (w/2,h/2) (-w/2,h/2). Σu² = w², Σv² = h², Σuv = 0.
  const us = [-w / 2, w / 2, w / 2, -w / 2];
  const vs = [-h / 2, -h / 2, h / 2, h / 2];
  const fit = (k: 0 | 1) => {
    const ys = quad.map((p) => p[k]);
    const mean = ys.reduce((s, y) => s + y, 0) / 4;
    const lu = ys.reduce((s, y, i) => s + us[i] * y, 0) / (w * w);
    const lv = ys.reduce((s, y, i) => s + vs[i] * y, 0) / (h * h);
    return { lu, lv, off: mean - lu * (w / 2) - lv * (h / 2) };
  };
  const x = fit(0);
  const y = fit(1);
  return { id, w, h, m: { a: x.lu, b: y.lu, c: x.lv, d: y.lv, e: x.off, f: y.off } };
}

/** Where a local point lands in the frame (tests; the renderers apply the same map). */
export function mapPoint(m: Affine, u: number, v: number): [number, number] {
  return [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f];
}

export type Box = readonly [number, number, number, number];
export type Layer =
  | { kind: "photo"; surface: string; box: Box; uri: string }
  | { kind: "rect"; surface: string; box: Box; fill: string }
  | { kind: "text"; surface: string; box: Box; text: string; size: number; weight: "600" | "700" | "800"; color: string; align: "left" | "center" | "right"; tracking?: number };

export interface ComposedTile { key: ComposedKey; surfaces: Surface[]; layers: Layer[]; label: string; contentKey: string }

/** What a composed tile is drawn from: only data the Me screen already loads. */
export interface TileContent {
  firstName: string;
  /** Her hero photo (Me's), then the rest of her eligible library, best first. */
  photos: string[];
  /** This week's prepared posts' first pictures, in plan order. */
  planPhotos: string[];
  /** Her rate rows that carry a suggested range (label + low/high), in the order Your rates lists them. */
  rates: Array<{ label: string; low: number; high: number; currency: string }>;
}

export const ME_TILES_COPY = {
  brand: "Brand book",
  plan: "Your plan",
  page: "Your page",
  rates: "Your rates",
  offers: "Offers",
  bookings: "Your bookings",
  shop: "Your shop",
  ratesHead: "RATES",
  ratesEmpty: "Set your rates",
  turnOn: "Turn on",
  partner: (first: string) => (first ? `Partner with ${first}` : "Partner with me"),
} as const;

const INK = "#0E0E0E";
const MUTE = "#6B6B6B";
/** The one action colour (Bold.act, raspberry) — React-free here, so the hex; never the ring pink. */
const PINK = "#C8325A";
const GOLD = "#B88A2E";

/** "$1.5–5k", "$500–900", "$800–1.2k": compact, one unit when both ends share it. */
export function rangeLabel(low: number, high: number, currency = "usd"): string {
  const sym = currency.toLowerCase() === "usd" ? "$" : `${currency.toUpperCase()} `;
  const k = (n: number) => { const v = n / 1000; return `${Number.isInteger(v) ? v : Number(v.toFixed(1))}`; };
  if (low >= 1000 && high >= 1000) return `${sym}${k(low)}–${k(high)}k`;
  if (high >= 1000) return `${sym}${Math.round(low)}–${k(high)}k`;
  return `${sym}${Math.round(low)}–${Math.round(high)}`;
}

/** Strip a signed URL's query so a re-signed link of the same photo is the same content (the flattened cache key). */
export const stableUri = (u: string) => u.split("?")[0];

/** n photos for n slots: the preferred list first, then her library, repeating only when she has fewer than n. */
export function fillPhotos(preferred: string[], library: string[], n: number): string[] {
  const pool = [...preferred, ...library.filter((p) => !preferred.includes(p))];
  if (!pool.length) return [];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

/** The composed tile's surfaces and layers. Null when there is nothing of hers to draw (the tile shows its plain frame). */
export function composedTile(key: ComposedKey, c: TileContent): ComposedTile | null {
  const surfaces = FRAME_SURFACES[key].map((s) => surfaceOf(s.id, s.quad));
  const S = (id: string) => surfaces.find((s) => s.id === id)!;
  const layers: Layer[] = [];
  const first = c.firstName.trim();

  if (key === "brand") {
    const s = S("cover");
    const [photo] = fillPhotos([], c.photos, 1);
    if (!photo) return null;
    layers.push({ kind: "photo", surface: "cover", box: [0, 0, s.w, s.h], uri: photo });
    if (first) {
      layers.push({ kind: "rect", surface: "cover", box: [0, s.h * 0.78, s.w, s.h * 0.22], fill: "rgba(0,0,0,0.34)" });
      layers.push({ kind: "text", surface: "cover", box: [0, s.h * 0.8, s.w, s.h * 0.17], text: first.toUpperCase(), size: s.h * 0.12, weight: "800", color: "#FFFFFF", align: "center", tracking: 2 });
    }
  } else if (key === "plan") {
    const photos = fillPhotos(c.planPhotos, c.photos, 3);
    if (!photos.length) return null;
    // Back to front, so the newest post sits on top; each print keeps its white border.
    ["print3", "print2", "print1"].forEach((id, i) => {
      const s = S(id);
      const bx = s.w * 0.045;
      const by = s.h * 0.035;
      layers.push({ kind: "rect", surface: id, box: [0, 0, s.w, s.h], fill: "#FFFFFF" });
      layers.push({ kind: "photo", surface: id, box: [bx, by, s.w - 2 * bx, s.h - 2 * by], uri: photos[2 - i] });
    });
  } else if (key === "page") {
    const s = S("front");
    const [photo] = fillPhotos([], c.photos, 1);
    if (!photo) return null;
    const pad = s.w * 0.06;
    layers.push({ kind: "photo", surface: "front", box: [pad, pad, s.w - 2 * pad, s.h * 0.6], uri: photo });
    if (first) layers.push({ kind: "text", surface: "front", box: [pad, s.h * 0.66, s.w - 2 * pad, s.h * 0.1], text: first.toUpperCase(), size: s.h * 0.075, weight: "800", color: INK, align: "left", tracking: 1 });
    layers.push({ kind: "rect", surface: "front", box: [pad, s.h * 0.8, s.w * 0.62, s.h * 0.1], fill: PINK });
    layers.push({ kind: "text", surface: "front", box: [pad, s.h * 0.815, s.w * 0.62, s.h * 0.07], text: ME_TILES_COPY.partner(first), size: s.h * 0.04, weight: "700", color: "#FFFFFF", align: "center" });
  } else {
    const s = S("card");
    const pad = s.w * 0.1;
    layers.push({ kind: "text", surface: "card", box: [pad, s.h * 0.1, s.w - 2 * pad, s.h * 0.08], text: ME_TILES_COPY.ratesHead, size: s.h * 0.05, weight: "700", color: GOLD, align: "left", tracking: 4 });
    const rows = c.rates.slice(0, 3);
    if (!rows.length) {
      layers.push({ kind: "text", surface: "card", box: [pad, s.h * 0.42, s.w - 2 * pad, s.h * 0.12], text: ME_TILES_COPY.ratesEmpty, size: s.h * 0.065, weight: "700", color: MUTE, align: "left" });
    }
    rows.forEach((r, i) => {
      const y = s.h * (0.28 + i * 0.2);
      layers.push({ kind: "text", surface: "card", box: [pad, y, s.w * 0.45, s.h * 0.1], text: r.label, size: s.h * 0.058, weight: "600", color: INK, align: "left" });
      layers.push({ kind: "text", surface: "card", box: [s.w * 0.5, y, s.w * 0.5 - pad, s.h * 0.1], text: rangeLabel(r.low, r.high, r.currency), size: s.h * 0.058, weight: "700", color: INK, align: "right" });
      layers.push({ kind: "rect", surface: "card", box: [pad, y + s.h * 0.13, s.w - 2 * pad, 2], fill: "rgba(184,138,46,0.35)" });
    });
  }

  const contentKey = JSON.stringify([key, layers.map((l) => (l.kind === "photo" ? stableUri(l.uri) : l.kind === "text" ? l.text : l.fill))]);
  return { key, surfaces, layers, label: ME_TILES_COPY[key], contentKey };
}

/**
 * Which tiles Me shows, in order: always these five, all set-up (Bookings and Shop say "Turn on" until they are on). No
 * Your plan tile (20 Oct 2026): the plan is the brand book's last chapter, so the Brand book tile carries her goals' live
 * progress instead.
 */
export function meTileKeys(): MeTileKey[] {
  return ["brand", "page", "rates", "bookings", "shop"];
}

/** The short line under each tile's name: what it is, or one live fact when that says more. */
export const TILE_LINE = {
  brand: "How brands see you",
  plan: "Your goals and this week",
  page: "Your public page",
  rates: "Ranges + your minimums",
  bookings: "What people can book",
  shop: "Products you love",
  offers: "Offers",
  rateCount: (n: number) => `${n} rate${n === 1 ? "" : "s"} set`,
  sessions: (n: number) => `${n} session type${n === 1 ? "" : "s"}`,
  picks: (n: number) => `${n} pick${n === 1 ? "" : "s"}`,
} as const;

export interface TileFacts {
  /** The brand book's own line (lib/brandBookLogic bookTile .sub): "Mila is writing it" / "Mila writes it for you"; null when ready. */
  book: string | null;
  /** Your plan's live fact ("2 goals · 3 posts ready"), null when there is none. */
  plan: string | null;
  /** Her rate rows that carry a range. */
  rates: number;
  bookingsEnabled: boolean;
  /** Her bookable session types (booking offers). */
  sessions: number;
  shopPicks: number;
}

/**
 * Each tile's one line. `invite` is true only for "Turn on" (drawn in pink); every other line is quiet. Never a count of
 * requests or offers: those live in Business.
 */
export function tileLine(key: MeTileKey, f: TileFacts): { text: string; invite: boolean } {
  const quiet = (text: string) => ({ text, invite: false });
  switch (key) {
    // While Mila writes it, say so; otherwise the plan's live progress (its last chapter), else what the book is.
    case "brand": return quiet(f.book || f.plan || TILE_LINE.brand);
    case "plan": return quiet(f.plan || TILE_LINE.plan);
    case "page": return quiet(TILE_LINE.page);
    case "rates": return quiet(f.rates > 0 ? TILE_LINE.rateCount(f.rates) : TILE_LINE.rates);
    case "bookings":
      if (!f.bookingsEnabled) return { text: ME_TILES_COPY.turnOn, invite: true };
      return quiet(f.sessions > 0 ? TILE_LINE.sessions(f.sessions) : TILE_LINE.bookings);
    case "shop": return f.shopPicks > 0 ? quiet(TILE_LINE.picks(f.shopPicks)) : { text: ME_TILES_COPY.turnOn, invite: true };
    default: return quiet(TILE_LINE.offers);
  }
}

/** An odd count leaves the last tile alone in its row: it runs full width instead. */
export const isWide = (keys: MeTileKey[], i: number) => keys.length % 2 === 1 && i === keys.length - 1;

/** Her rate rows with a suggested range, as the rate card lists them (rows without one are left off the card). */
export function ratesForTile(rows: ReadonlyArray<{ label: string; suggested: { low: number; high: number; currency: string } | null }> | null | undefined): TileContent["rates"] {
  return (rows ?? []).flatMap((r) => (r.suggested ? [{ label: r.label, low: r.suggested.low, high: r.suggested.high, currency: r.suggested.currency }] : []));
}
