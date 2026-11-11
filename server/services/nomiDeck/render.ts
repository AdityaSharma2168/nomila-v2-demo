/**
 * nomiDeck/render.ts — the Nomi Card as HTML, in the brand book's craft. Two looks (luxe, campaign) and two modes:
 *   deck  a swipeable stack of phone screens (the pitch a brand opens, the owner's preview) — inline style/script are
 *         allowed by the card CSP (setCardCsp)
 *   page  the public page: the same screens stacked as a scrolling page, the doors (Partner · Book · Shop) at the
 *         BOTTOM, a small sticky "Work with {first}" — no script and no style attributes at all, so it also fits the
 *         public page's strict CSP (its stylesheet is served from the bundle: nomiDeckCss()).
 * Markup never uses style="" attributes: photos are <img class="bg">, sizes and colours are classes. Every element binds
 * a real field; a field that is empty is not drawn.
 */
import type { MediaKitData } from "../mediaKitService";
import { DECK_TOKENS as T, CARD_TITLE, displaySize, planDeck, type DeckLook, type DeckScreen, type DeckEdition, type FrontDoor as FrontDoorT, type FrontDoorArrangement as FrontDoorArrangementT } from "./layout";

type Kit = MediaKitData;
type AnyCard = Kit["cards"][number];
type CardOf<K extends AnyCard["type"]> = Extract<AnyCard, { type: K }>;

export interface DeckDoor { key: "partner" | "book" | "shop"; label: string; href: string }
export interface RenderDeckOpts {
  look: DeckLook;
  mode: "deck" | "page";
  /** Toned backdrops per card id (statement screens set type over them). */
  backdrops?: Record<string, string>;
  /** How the cover sets its type (treat.ts coverFitFor): a dark panel over the photo, or split photo band / ink. */
  coverFit?: "overlay" | "split";
  /** Public page: the doors shown at the bottom (only those she has turned on). */
  doors?: DeckDoor[];
  /** Pitch close: where "Partner with {first}" goes (the public page's Partner door), when there is one. */
  partnerHref?: string | null;
  /** Public page: the stylesheet URL (page mode never inlines CSS). */
  cssHref?: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const firstOf = (kit: Kit) => kit.identity.name.split(" ")[0] || kit.identity.name;
/** Type-size class for a display line (fs-1 biggest … fs-5 smallest), from the shared fitting rule. */
const fsClass = (text: string, perLine = 16, lines = 3) => {
  const px = displaySize(text, { max: 46, min: 24, perLine, lines });
  return px >= 44 ? "fs-1" : px >= 38 ? "fs-2" : px >= 33 ? "fs-3" : px >= 28 ? "fs-4" : "fs-5";
};
const img = (src: string | null | undefined, cls = "bg", alt = "") => (src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">` : "");
const pct = (n: number) => `w${Math.max(0, Math.min(100, Math.round(n / 5) * 5))}`;

function cover(c: CardOf<"cover">, s: DeckScreen, kit: Kit, edition: DeckEdition, fit: "overlay" | "split" = "overlay", backdrop?: string): string {
  const brand = edition === "pitch" ? (kit.cards.find((x) => x.type === "whyFits" || x.type === "campaignConcept") as any)?.brand : null;
  const name = c.nameLines.join(" ");
  const stats = c.stats.slice(0, 3).map((st) => `<div class="stat"><b>${esc(st.value)}</b><span>${esc(st.label)}</span></div>`).join("");
  const lock = brand ? `<div class="lockup">${brand.logo ? `<span class="chip-logo">${img(brand.logo, "logo", brand.name)}</span>` : ""}<span class="x">×</span><span class="lock-name">${esc(firstOf(kit))}</span></div>` : `<div class="eyebrow">Nomi Card</div>`;
  const photo = s.variant !== "C" && !!s.image;
  const split = photo && fit === "split";
  const type = `${lock}
    <h1 class="name ${s.variant === "A" && !split ? "giant" : ""}">${c.nameLines.map((l) => `<span>${esc(l)}</span>`).join("")}</h1>
    ${c.meta ? `<div class="meta">${esc(c.meta)}</div>` : ""}
    ${c.hook ? `<p class="hook">${esc(c.hook)}</p>` : ""}
    ${stats ? `<div class="stats">${stats}</div>` : ""}`;
  if (split) {
    return `<section class="scr g-ink k-cover split v-${s.variant}"><div class="cover-band">${img(s.image, "bandimg", name)}</div>
  <div class="inner under">${type}</div></section>`;
  }
  // No usable photo of the athlete: type-led over a toned place (atmosphere library), never a stranger's likeness.
  const place = !photo && !!backdrop;
  return `<section class="scr g-${s.ground} k-cover v-${s.variant}">${photo ? img(s.image, "bg", name) : place ? img(backdrop, "bg toned") : ""}${photo || place ? `<div class="scrim"></div>` : ""}
  <div class="inner bottom${photo || place ? " panel" : ""}">${type}</div></section>`;
}

function idea(c: CardOf<"signatureIdea"> | CardOf<"campaignConcept">, s: DeckScreen, backdrop: string | undefined): string {
  const brand = c.type === "campaignConcept" ? c.brand : null;
  // The brand's own imagery is shown as itself (its world); her photos sit toned behind the type.
  const bg = s.variant === "C" ? "" : brand && (c as any).brandImage === s.image ? img(s.image) : s.variant === "B" ? img(backdrop ?? s.image, "bg toned") : img(s.image);
  return `<section class="scr g-${s.ground} k-statement v-${s.variant}">${bg}${bg ? `<div class="scrim"></div>` : ""}
  <div class="inner ${bg ? "bottom" : "center"}">
    <div class="eyebrow">${brand ? `Campaign concept · ${esc(brand.name)}` : esc(c.eyebrow || "The idea")}</div>
    <h2 class="display ${fsClass(c.title, 14, 2)}">${esc(c.title)}</h2>
    <p class="line">${esc(c.line)}${c.lineEmphasis ? ` <em>${esc(c.lineEmphasis)}</em>` : ""}</p>
    ${c.facets.length ? `<div class="chips">${c.facets.slice(0, 4).map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
  </div></section>`;
}

function values(c: CardOf<"values">, s: DeckScreen, backdrop: string | undefined): string {
  const bg = s.variant === "B" ? img(backdrop ?? s.image, "bg toned") : "";
  return `<section class="scr g-${s.ground} k-statement v-${s.variant}">${bg}${bg ? `<div class="scrim"></div>` : ""}
  <div class="inner ${bg ? "bottom" : "center"}"><div class="eyebrow">${esc(c.eyebrow || "Stands for")}</div>
    ${c.statement ? `<h2 class="display ${fsClass(c.statement, 18, 4)}">${esc(c.statement)}</h2>` : ""}
    ${c.planks.length ? `<ul class="rows">${c.planks.slice(0, 3).map((p) => `<li><b>${esc(p.name)}</b><span>${esc(p.line)}</span></li>`).join("")}</ul>` : ""}
  </div></section>`;
}

function record(c: CardOf<"achievements">, s: DeckScreen, kit: Kit): string {
  const idx = kit.cards.find((x) => x.type === "index") as CardOf<"index"> | undefined;
  const seen = new Set<string>([c.heroEntry?.name?.toLowerCase() ?? ""]);
  const rows = c.entries.filter((e) => { const k = e.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  return `<section class="scr g-${s.ground} k-record v-${s.variant}">${s.variant === "A" ? `<div class="band">${img(s.image, "bandimg")}</div>` : ""}<div class="inner ${s.variant === "A" ? "under" : "top"}">
    <div class="eyebrow">${esc(c.eyebrow || "The record")}</div>
    ${c.heroEntry?.name ? `<div class="hero-entry"><span class="year">${esc(c.heroEntry.year)}</span><h2 class="display ${fsClass(c.heroStory || c.heroEntry.name, 15, 3)}">${esc(c.heroStory || c.heroEntry.name)}</h2>${c.heroStory ? `<span class="fact">${esc(c.heroEntry.name)}</span>` : ""}${c.heroEntry.badge ? `<span class="badge">${esc(c.heroEntry.badge)}</span>` : ""}</div>` : ""}
    ${rows.length ? `<ul class="timeline">${rows.map((e) => `<li><span class="year">${esc(e.year)}</span><span class="what">${esc(e.story || e.name)}</span>${e.story ? `<span class="lvl">${esc(e.name)}</span>` : e.level ? `<span class="lvl">${esc(e.level)}</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${idx ? `<div class="mia"><div class="mia-n"><b>${esc(idx.value)}</b><span>/ ${esc(idx.max)}</span></div><div class="mia-t"><span class="eyebrow">M.I.A. marketability</span>${idx.verdict ? `<p>${esc(idx.verdict)}</p>` : ""}</div></div>` : ""}
  </div></section>`;
}

function proof(c: CardOf<"content">, s: DeckScreen): string {
  const tiles = c.tiles.filter((t) => t.image).slice(0, 3);
  return `<section class="scr g-ink k-gallery v-${s.variant}"><div class="inner top">
    <div class="eyebrow">${esc(c.eyebrow || "The proof")}</div>
    ${c.heroStat?.value ? `<div class="big"><b>${esc(c.heroStat.value)}</b><span>${esc(c.heroStat.label)}</span></div>` : ""}
    ${c.stats?.length ? `<div class="statrow n${c.stats.length}">${c.stats.map((st) => `<div><b>${esc(st.value)}</b><span>${esc(st.label)}</span></div>`).join("")}</div>` : ""}
    ${tiles.length ? `<div class="tiles n${tiles.length}">${tiles.map((t) => `<figure>${img(t.image, "tile")}${t.stat ? `<figcaption>${esc(t.stat)}</figcaption>` : ""}</figure>`).join("")}</div>` : ""}
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
  </div></section>`;
}

function audience(c: CardOf<"audience">, s: DeckScreen): string {
  const ages = (c.ages ?? []).filter((a) => a.pct > 0).slice(0, 5);
  const geo = c.geo.filter((g) => g.pct != null && g.pct > 0).slice(0, 4);
  const plats = (c.platforms ?? []).slice(0, 2);
  // The book's data layout: one big number, then bars. On a pitch, the brand's own audience (from its research) beside it.
  const bigN = c.share != null ? `${c.share}%` : "";
  const bigLabel = c.headline ? c.headline.toLowerCase() : "";
  return `<section class="scr g-paper k-data v-${s.variant}">${s.variant === "A" ? `<div class="band short">${img(s.image, "bandimg")}</div>` : ""}<div class="inner ${s.variant === "A" ? "under" : "top"}">
    <div class="eyebrow">${esc(c.eyebrow || "The audience")}</div>
    ${bigN ? `<div class="bignum"><b>${esc(bigN)}</b><span>${esc(bigLabel)}</span></div>` : c.headline ? `<h2 class="display fs-3">${esc(c.headline)}</h2>` : ""}${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : ""}
    ${c.brandAudience ? `<div class="overlap"><span class="eyebrow">Who ${esc(c.brandAudience.brand)} sells to</span><p>${esc(c.brandAudience.text)}</p></div>` : ""}
    ${plats.length ? `<div class="cards2">${plats.map((p) => `<div class="pcard"><span class="eyebrow">${esc(p.label)}</span><b>${esc(compactN(p.n))}</b><span>${esc(p.pct)}% of her audience</span></div>`).join("")}</div>` : ""}
    ${ages.length ? `<div class="bars"><span class="eyebrow">Age</span>${ages.map((a) => `<div class="bar"><span class="lbl">${esc(a.label)}</span><span class="track"><i class="${pct(a.pct)}"></i></span><span class="val">${esc(a.pct)}%</span></div>`).join("")}</div>` : ""}
    ${geo.length ? `<div class="bars"><span class="eyebrow">Where</span>${geo.map((g) => `<div class="bar"><span class="lbl">${esc(g.label)}</span><span class="track"><i class="${pct(g.pct!)}"></i></span><span class="val">${esc(g.pct)}%</span></div>`).join("")}</div>` : ""}
  </div></section>`;
}
const compactN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(n));

function why(c: CardOf<"whyFits">, s: DeckScreen): string {
  return `<section class="scr g-ink k-fit v-${s.variant}"><div class="inner top">
    <div class="lockup">${c.brand.logo ? `<span class="chip-logo">${img(c.brand.logo, "logo", c.brand.name)}</span>` : ""}<span class="lock-name">Why ${esc(c.brand.name)}</span></div>
    <h2 class="display ${fsClass(c.lead, 18, 4)}">${esc(c.lead)}</h2>
    <ol class="reasons">${c.reasons.slice(0, 3).map((r, i) => `<li><span class="num">0${i + 1}</span><div><b>${esc(r.head)}</b><p>${esc(r.insight)}</p></div></li>`).join("")}</ol>
  </div></section>`;
}

function fit(c: CardOf<"fit">, s: DeckScreen): string {
  return `<section class="scr g-${s.ground} k-fit v-${s.variant}">${s.variant !== "C" ? img(s.image) : ""}${s.variant !== "C" ? `<div class="scrim"></div>` : ""}
  <div class="inner bottom"><div class="eyebrow">${esc(c.eyebrow || "The fit")}</div>
    <h2 class="display ${fsClass(c.lead, 18, 3)}">${esc(c.lead)}</h2>${c.body ? `<p class="line">${esc(c.body)}</p>` : ""}
    ${c.tags.length ? `<div class="chips">${c.tags.slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
  </div></section>`;
}

function calendar(c: CardOf<"activationPlan">, s: DeckScreen): string {
  return `<section class="scr g-ink k-calendar v-${s.variant}"><div class="inner top">
    <div class="eyebrow">${esc(c.eyebrow || "All year")}</div>
    <h2 class="display ${fsClass(c.lead, 20, 3)}">${esc(c.lead)}</h2>
    <ol class="buckets">${c.buckets.slice(0, 4).map((b, i) => `<li><span class="num">0${i + 1}</span><div><b>${esc(b.label)}</b>${b.audience ? `<span class="aud">${esc(b.audience)}</span>` : ""}<p>${esc(b.line)}</p></div></li>`).join("")}</ol>
    ${c.close ? `<p class="close-line">${esc(c.close)}</p>` : ""}
  </div></section>`;
}

function close(kit: Kit, s: DeckScreen, edition: DeckEdition, o: RenderDeckOpts): string {
  const first = firstOf(kit);
  const coverHook = (kit.cards.find((c) => c.type === "cover") as CardOf<"cover"> | undefined)?.hook ?? "";
  const cta = edition === "pitch"
    ? (o.partnerHref ? `<a class="btn" href="${esc(o.partnerHref)}">Partner with ${esc(first)}</a>` : `<button class="btn" id="btnShare" type="button">Share this card</button>`)
    : "";
  return `<section class="scr g-${s.ground} k-close v-${s.variant}">${s.variant === "A" ? img(s.image) : ""}${s.variant === "A" ? `<div class="scrim"></div>` : ""}
  <div class="inner bottom"><div class="eyebrow">${edition === "pitch" ? "Next" : "Nomi Card"}</div>
    <h2 class="display fs-2">${edition === "pitch" ? `Let's build it with ${esc(first)}.` : `Work with ${esc(first)}.`}</h2>
    ${edition === "public" && coverHook ? `<p class="hook">${esc(coverHook)}</p>` : ""}
    ${cta}
    <div class="mark">Nomila</div>
  </div></section>`;
}

function screenHtml(kit: Kit, s: DeckScreen, edition: DeckEdition, o: RenderDeckOpts): string {
  const c = s.cardId ? kit.cards.find((x) => x.id === s.cardId) : null;
  const bd = s.cardId ? o.backdrops?.[s.cardId] : undefined;
  if (s.kind === "close") return close(kit, s, edition, o);
  if (!c) return "";
  switch (c.type) {
    case "cover": return cover(c, s, kit, edition, o.coverFit, bd);
    case "signatureIdea": case "campaignConcept": return idea(c, s, bd);
    case "values": return values(c, s, bd);
    case "achievements": return record(c, s, kit);
    case "content": return proof(c, s);
    case "audience": return audience(c, s);
    case "whyFits": return why(c, s);
    case "fit": return fit(c, s);
    case "activationPlan": return calendar(c, s);
    default: return "";
  }
}

/** The whole document. Kit images must already be signed (or public) URLs. */
export function renderNomiDeckHtml(kit: Kit, o: RenderDeckOpts): string {
  const screens = planDeck(kit);
  const edition = screens.length && kit.cards.some((c) => c.type === "whyFits" || c.type === "campaignConcept") ? "pitch" : "public";
  const accent = /^#[0-9a-f]{6}$/i.test(kit.tokens?.accent ?? "") ? kit.tokens.accent : T.pink;
  const body = screens.map((s) => screenHtml(kit, s, edition, o)).join("\n");
  const first = firstOf(kit);
  const title = `${esc(kit.identity.name)} — Nomi Card · Nomila`;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..800;1,6..96,400..700&family=Archivo:wdth,wght@75..100,600..900&family=Outfit:wght@300..700&display=swap">`;
  const lookClass = `look-${o.look}`;
  if (o.mode === "page") {
    const doors = (o.doors ?? []).map((d) => `<a class="door door-${d.key}" href="${esc(d.href)}">${esc(d.label)}</a>`).join("");
    const partner = (o.doors ?? []).find((d) => d.key === "partner");
    return `<!doctype html><html lang="en"><head>${head}<link rel="stylesheet" href="${esc(o.cssHref ?? "")}"></head>
<body class="nomi page ${lookClass} acc-${accentClass(accent)}"><main class="pagecol">${body}
<section class="doors-block"><div class="eyebrow">Work with ${esc(first)}</div><div class="doors">${doors}</div><p class="fine">Requests go to ${esc(first)} first. Nothing is shared until ${esc(first)} says yes.</p></section></main>
${partner ? `<a class="sticky" href="${esc(partner.href)}">Work with ${esc(first)}</a>` : ""}</body></html>`;
  }
  return `<!doctype html><html lang="en"><head>${head}<style>${nomiDeckCss(accent)}</style></head>
<body class="nomi deck ${lookClass}"><div class="frame"><div class="progress" id="progress">${screens.map(() => "<i></i>").join("")}</div>
<div class="track" id="track">${body}</div>
<button class="nav prev" id="prev" aria-label="Previous"></button><button class="nav next" id="next" aria-label="Next"></button></div>
<script>${DECK_JS}</script></body></html>`;
}

// ── The public page: front door v2.1, simplified (22 Oct 2026) ─────────────────────────────────────────────────────
// The top ~70% is the athlete's story as hero cards that swipe SIDEWAYS (native scroll-snap; the next card peeks in);
// below it up to three doors (layout.ts frontDoors). No inline script or style: the public route's CSP is strict, so
// the stylesheet is a file (/p/_a/nomi.css) and the carousel's extras come from the existing front.js, whose hooks
// (#pc-track, .pc-card[data-title], #pc-chap, .pc-dots, .pc-arrow--prev/next, #pc-like) this markup reuses.

export interface FrontDoorPageOpts {
  look: DeckLook;
  backdrops?: Record<string, string>;
  coverFit?: "overlay" | "split";
  /** The doors and their arrangement (layout.ts frontDoors), with where each one goes. */
  doors: Array<FrontDoorT & { href: string }>;
  arrangement: FrontDoorArrangementT;
  handle?: string | null;
  /** The heart's POST endpoint; null draws it without sending (fixtures/preview); undefined → no heart. */
  likeEndpoint?: string | null;
  /** Stylesheet URL (public route) — or inline the CSS (owner preview, whose CSP allows it). */
  cssHref?: string;
  inlineCss?: boolean;
  /** front.js URL (carousel status, arrows, keys, heart). Absent → the page still works without script. */
  jsHref?: string;
  /** "Get your own Nomi Card" — the claim campaign. */
  claimHref?: string;
  /** sheets.js URL: opens each door in a slide-up sheet on the page. Absent → the doors stay plain links to their pages. */
  sheetsJsHref?: string;
  /** book.js URL: the Book door runs the request flow inside its sheet (Bookings PR2). */
  bookJsHref?: string;
  /** OWNER VIEW ONLY: the metrics rail on the right of the hero (last 30 days). Never set for visitors. */
  metrics?: OwnerRailItem[] | null;
}

/** One count on the owner's metrics rail, with where a tap goes (an app deep link), or none. */
export interface OwnerRailItem { key: "views" | "likes" | "requests" | "bookings" | "shop"; label: string; value: number; href?: string | null }

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
const RAIL_ICON: Record<OwnerRailItem["key"], string> = {
  views: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  likes: HEART,
  requests: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V5h8v3"/></svg>',
  bookings: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
};

/** The owner's rail: Instagram-like placement on the right of the hero. Exported for the tests. */
export function ownerRailHtml(items: OwnerRailItem[]): string {
  if (!items.length) return "";
  const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(v));
  return `<aside class="fd-rail" aria-label="Your page, last 30 days (only you see this)">${items.map((m) => {
    const inner = `${RAIL_ICON[m.key]}<b>${esc(n(m.value))}</b><span>${esc(m.label)}</span>`;
    return m.href ? `<a class="fd-stat" data-stat="${m.key}" href="${esc(m.href)}">${inner}</a>` : `<div class="fd-stat" data-stat="${m.key}">${inner}</div>`;
  }).join("")}<span class="fd-rail-note">30 days · only you</span></aside>`;
}

const DOOR_ICON: Record<string, string> = {
  partner: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V5h8v3"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
};

/** The door tiles, in their arrangement. Exported for the tests. */
export function frontDoorsHtml(doors: FrontDoorPageOpts["doors"], arrangement: FrontDoorArrangementT): string {
  if (!doors.length) return "";
  return `<nav class="fd-doors a-${arrangement}" aria-label="Work with this athlete">${doors.map((d) =>
    `<a class="fd-door${d.primary ? " pri" : ""}" data-door="${d.key}" data-sheet href="${esc(d.href)}" aria-haspopup="dialog"><b>${DOOR_ICON[d.key] ?? ""}<span>${esc(d.label)}</span></b><span class="fd-line">${esc(d.line)}</span></a>`).join("")}</nav>`;
}

/** The whole public page in the engine's look. Kit images must already be signed (or public) URLs. */
export function renderFrontDoorHtml(kit: Kit, o: FrontDoorPageOpts): string {
  const screens = planDeck(kit, "public");
  const first = firstOf(kit);
  const cover = kit.cards.find((c) => c.type === "cover") as CardOf<"cover"> | undefined;
  const ro: RenderDeckOpts = { look: o.look, mode: "page", backdrops: o.backdrops, coverFit: o.coverFit };
  const cards = screens.map((s, i) => {
    const title = CARD_TITLE[s.cardType] ?? "Chapter";
    return `<article class="pc-card fd-card" id="ch-${esc(s.key)}" data-title="${esc(title)}" aria-roledescription="slide" aria-label="${esc(title)}, ${i + 1} of ${screens.length}">${screenHtml(kit, s, "public", ro)}</article>`;
  }).join("");
  const dots = screens.map((_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("");
  const firstTitle = CARD_TITLE[screens[0]?.cardType ?? "cover"] ?? "Cover";
  const rail = o.metrics?.length ? ownerRailHtml(o.metrics) : "";
  const heart = !rail && o.likeEndpoint !== undefined && o.handle
    ? `<button type="button" class="pc-like fd-heart" id="pc-like" hidden aria-pressed="false" aria-label="Like this page" data-handle="${esc(o.handle)}"${o.likeEndpoint ? ` data-endpoint="${esc(o.likeEndpoint)}"` : ""}>${HEART}</button>`
    : "";
  const title = `${esc(kit.identity.name)} · Nomila`;
  const css = o.inlineCss ? `<style>${nomiDeckCss()}${frontDoorCss()}</style>` : `<link rel="stylesheet" href="${esc(o.cssHref ?? "")}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..800;1,6..96,400..700&family=Archivo:wdth,wght@75..100,600..900&family=Outfit:wght@300..700&display=swap">${css}</head>
<body class="nomi front look-${o.look}">
<header class="fd-bar"><span class="fd-brand">Nomila</span>${o.handle ? `<span class="fd-handle">@${esc(o.handle)}</span>` : ""}${heart}</header>
<main class="fd-main">
<section class="pc-hero fd-hero" aria-roledescription="carousel" aria-label="${esc(first)}'s story">
<div class="fd-track" id="pc-track" tabindex="0">${cards}</div>
${rail}<div class="fd-status"><span id="pc-chap">${esc(firstTitle)} · 1 of ${screens.length}</span><span class="pc-dots">${dots}</span></div>
<button type="button" class="pc-arrow pc-arrow--prev fd-arrow prev" hidden aria-label="Previous">‹</button><button type="button" class="pc-arrow pc-arrow--next fd-arrow next" hidden aria-label="Next">›</button>
</section>
<aside class="fd-side">
<div class="fd-who"><h1 class="fd-name">${esc(kit.identity.name)}</h1>${cover?.meta ? `<p class="fd-meta">${esc(cover.meta)}</p>` : ""}</div>
${frontDoorsHtml(o.doors, o.arrangement)}
<footer class="fd-foot"><b>Follow ${esc(first)}</b><span>Everything on this page is published by ${esc(first)}.</span>${o.claimHref ? `<a class="fd-claim" href="${esc(o.claimHref)}">Get your own Nomi Card</a>` : ""}</footer>
</aside>
</main>
${o.sheetsJsHref ? sheetShellHtml() : ""}${o.jsHref ? `<script src="${esc(o.jsHref)}" defer></script>` : ""}${o.bookJsHref ? `<script src="${esc(o.bookJsHref)}" defer></script>` : ""}${o.sheetsJsHref ? `<script src="${esc(o.sheetsJsHref)}" defer></script>` : ""}</body></html>`;
}

/**
 * The one sheet every door opens in (sheets.js fills it with that door page's own content, so the no-script door pages
 * stay the single source of each door). Hidden until a door is tapped; a real dialog: labelled, modal, closable.
 */
export function sheetShellHtml(): string {
  return `<div class="fd-sheet" id="fd-sheet" hidden><div class="fd-scrim" data-close></div>` +
    `<section class="fd-panel" role="dialog" aria-modal="true" aria-labelledby="fd-sheet-title" tabindex="-1">` +
    `<div class="fd-grab" data-grab><i></i></div>` +
    `<header class="fd-sheet-head"><h2 class="fd-sheet-title" id="fd-sheet-title"></h2><button type="button" class="fd-x" data-close aria-label="Close">×</button></header>` +
    `<div class="fd-sheet-body" id="fd-sheet-body" aria-live="polite"></div></section></div>`;
}

/** The front door's own styles (on top of nomiDeckCss). Phone first; ≥ 800px puts the doors beside the carousel. */
export function frontDoorCss(): string {
  return `
.front{min-height:100svh;background:var(--ink)}
.fd-bar{position:sticky;top:0;z-index:20;height:52px;display:flex;align-items:center;gap:10px;padding:0 16px;padding-top:env(safe-area-inset-top);background:var(--ink)}
.fd-brand{font:800 12px/1 var(--body);letter-spacing:.3em;text-transform:uppercase;color:var(--on-ink)}
.fd-handle{margin-left:auto;font:500 11px/1 var(--body);letter-spacing:.16em;text-transform:uppercase;color:var(--on-ink-mut)}
.fd-heart{width:34px;height:34px;border-radius:50%;border:1px solid var(--hair-ink);background:transparent;display:grid;place-items:center;cursor:pointer;color:var(--on-ink)}
.fd-heart svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2}.fd-heart[aria-pressed="true"] svg{fill:var(--pink);stroke:var(--pink)}
.fd-handle+.fd-heart{margin-left:10px}.fd-brand+.fd-heart{margin-left:auto}
.fd-main{display:flex;flex-direction:column}
.fd-hero{position:relative;height:70svh;min-height:460px;background:var(--ink)}
.fd-track{display:flex;gap:6px;height:calc(100% - 36px);overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scroll-padding:0 16px;padding:0 16px;scrollbar-width:none}
.fd-track::-webkit-scrollbar{display:none}.fd-track:focus-visible{outline:2px solid var(--gold);outline-offset:-2px}
.fd-card{flex:0 0 calc(100% - 26px);scroll-snap-align:start;height:100%;border-radius:18px;overflow:hidden;position:relative}
.fd-card .scr{height:100%;min-height:0}.fd-card .k-data .band{display:none}.fd-card .k-data .inner.under{padding-top:40px}.fd-card .bignum b{font-size:52px}.fd-card .cards2 .pcard{padding:11px}.fd-card .pcard b{font-size:26px}.fd-card .bars{gap:6px}.fd-card .inner{padding:40px 22px 46px}.fd-card .inner.top{padding-top:44px}
.fd-card .name{font-size:46px}.fd-card .name.giant{font-size:62px}.fd-card .display{font-size:34px}.fd-card .fs-1{font-size:38px}.fd-card .fs-2{font-size:34px}
.fd-status{position:absolute;left:20px;right:20px;bottom:12px;z-index:6;display:flex;justify-content:space-between;align-items:center;font:500 11px/1 var(--body);letter-spacing:.06em;color:var(--on-ink-dim);pointer-events:none}
.pc-dots{display:flex;gap:4px}.pc-dots i{width:5px;height:5px;border-radius:50%;background:rgba(244,238,226,.42)}.pc-dots i.on{width:16px;border-radius:4px;background:var(--on-ink)}
.fd-arrow{position:absolute;top:50%;z-index:7;width:38px;height:38px;margin-top:-19px;border-radius:50%;border:1px solid var(--hair-ink);background:rgba(21,17,13,.55);color:var(--on-ink);font:400 22px/1 var(--body);cursor:pointer}
.fd-arrow.prev{left:22px}.fd-arrow.next{right:22px}.fd-arrow:disabled{opacity:.3;cursor:default}
@media (hover:none){.fd-arrow{display:none}}
.fd-rail{position:absolute;right:24px;top:22px;z-index:8;display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 6px;border-radius:999px;background:rgba(21,17,13,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.fd-stat{display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--on-ink);text-decoration:none;min-width:44px}
.fd-stat svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.fd-stat b{font:700 13px/1 var(--body)}.fd-stat span{font:500 9px/1 var(--body);letter-spacing:.06em;color:var(--on-ink-mut)}
.fd-rail-note{font:500 8px/1.2 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--on-ink-mut);text-align:center;max-width:52px}
@media (min-width:800px){.fd-rail{right:20px;top:20px}}
.fd-side{display:flex;flex-direction:column;gap:14px;padding:12px 16px calc(24px + env(safe-area-inset-bottom))}
.fd-who{display:none}
.fd-doors{display:grid;gap:8px}.fd-doors.a-one{grid-template-columns:1fr}.fd-doors.a-two{grid-template-columns:1fr 1fr}
.fd-doors.a-stack{grid-template-columns:1fr 1fr}.fd-doors.a-stack .fd-door:first-child{grid-column:1/-1}
.fd-door{display:flex;flex-direction:column;gap:6px;min-height:68px;padding:13px 14px;background:var(--paper);color:var(--on-paper);border-top:2px solid var(--gold);text-decoration:none}
.fd-door b{display:flex;align-items:center;gap:8px;font:500 18px/1.15 var(--display)}.fd-door b svg{flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.fd-line{font:400 12.5px/1.35 var(--body);color:var(--on-paper-mut)}
.fd-door.pri{background:var(--pink);color:#fff;border-top-color:var(--pink)}.fd-door.pri .fd-line{color:rgba(255,255,255,.88)}
.fd-door:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.look-campaign .fd-door b{font-family:var(--body);font-weight:700}
.fd-foot{display:flex;flex-direction:column;gap:4px;font:400 12px/1.4 var(--body);color:var(--on-ink-mut)}
.fd-foot b{font:700 12px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;color:var(--on-ink)}
.fd-claim{margin-top:6px;color:var(--gold);text-decoration:none;font-size:12px}
@media (min-width:800px){
 .fd-main{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(320px,1fr);gap:28px;max-width:1280px;margin:0 auto;padding:16px 28px 28px;align-items:start}
 .fd-hero{height:calc(100svh - 96px);min-height:520px;border-radius:20px;overflow:hidden}
 .fd-track{padding:0;scroll-padding:0;gap:0}.fd-card{flex:0 0 100%;border-radius:0}
 .fd-status{left:24px;right:24px}.fd-hero{background:var(--ink2)}
 .fd-side{position:sticky;top:68px;padding:8px 0;gap:18px}
 .fd-who{display:block}.fd-name{font:500 40px/1 var(--display);color:var(--on-ink)}.fd-meta{margin-top:8px;font:400 14px/1.4 var(--body);color:var(--on-ink-dim)}
 .fd-door{min-height:96px;padding:16px}.fd-door b{font-size:21px}.fd-line{font-size:13.5px}
}
@media (prefers-reduced-motion:no-preference){.fd-track{scroll-behavior:smooth}}
${sheetCss()}`;
}

/** The door sheet, and the door pages' own content restyled inside it (form, sessions, picks) in the engine's look. */
export function sheetCss(): string {
  return `
.fd-sheet{position:fixed;inset:0;z-index:60}.fd-sheet[hidden]{display:none}
.fd-scrim{position:absolute;inset:0;background:rgba(10,8,6,.62)}
.fd-panel{position:absolute;left:0;right:0;bottom:0;max-height:88svh;display:flex;flex-direction:column;background:var(--paper);color:var(--on-paper);border-top:2px solid var(--gold);border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom);outline:none;transform:translateY(0)}
.fd-sheet.opening .fd-panel{transform:translateY(100%)}
@media (prefers-reduced-motion:no-preference){.fd-panel{transition:transform .26s cubic-bezier(.2,.8,.2,1)}}
.fd-grab{display:flex;justify-content:center;padding:10px 0 2px;cursor:grab;touch-action:none}.fd-grab i{width:40px;height:4px;border-radius:2px;background:var(--hair-paper)}
.fd-sheet-head{display:flex;align-items:flex-start;gap:12px;padding:6px 20px 10px}
.fd-sheet-title{flex:1;margin:0;font:500 24px/1.15 var(--display);color:var(--on-paper)}
.fd-x{flex:none;width:36px;height:36px;border-radius:50%;border:1px solid var(--hair-paper);background:transparent;font:400 22px/1 var(--body);color:var(--on-paper);cursor:pointer}
.fd-x:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.fd-sheet-body{overflow-y:auto;overscroll-behavior:contain;padding:0 20px 24px;font:400 15px/1.5 var(--body);color:var(--on-paper-dim)}
.fd-sheet-body .pc-lede{margin:0 0 14px;color:var(--on-paper)}
.fd-sheet-body .pc-fine,.fd-sheet-body .pc-notyet{margin:12px 0 0;font-size:12.5px;color:var(--on-paper-mut)}
.fd-sheet-body .pc-fh{margin:18px 0 8px;font:700 11px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--on-paper-mut)}
.fd-sheet-body .pc-form{display:flex;flex-direction:column;gap:12px}
.fd-sheet-body .pc-form fieldset{border:0;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.fd-sheet-body .pc-form legend{margin-bottom:8px;font:700 11px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--on-paper-mut)}
.fd-sheet-body .pc-radio{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--hair-paper);border-radius:999px;font-size:14px;color:var(--on-paper)}
.fd-sheet-body .pc-form label:not(.pc-radio){display:flex;flex-direction:column;gap:6px;font:600 12px/1.2 var(--body);color:var(--on-paper)}
.fd-sheet-body input:not([type=radio]):not([type=checkbox]),.fd-sheet-body textarea,.fd-sheet-body select{width:100%;padding:11px 12px;border:1px solid var(--hair-paper);border-radius:10px;background:var(--paper2);font:400 15px/1.4 var(--body);color:var(--on-paper)}
.fd-sheet-body input:focus-visible,.fd-sheet-body textarea:focus-visible{outline:2px solid var(--gold);outline-offset:1px}
.fd-sheet-body .pc-btn{min-height:48px;border:0;border-radius:999px;background:var(--pink);color:#fff;font:600 15px/1 var(--body);cursor:pointer}
.fd-sheet-body .pc-btn[disabled]{opacity:.45;cursor:not-allowed}
.fd-sheet-body a.pc-btn:not(.pc-btn--wide){display:flex;align-items:center;justify-content:center;min-height:44px;margin-top:8px;padding:0 18px;text-decoration:none}
.fd-sheet-body a:not(.pc-btn){color:var(--gold-deep);text-decoration:underline;text-underline-offset:2px}
.fd-sheet-body a:focus-visible,.fd-sheet-body button:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.fd-sheet-body .pc-error,.fd-sheet-body [role=alert]{margin:0;color:#B3261E;font-size:13px}
.fd-sheet-body .pc-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.fd-sheet-body .pc-kinds{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.fd-sheet-body .pc-btn--wide{display:flex;align-items:center;min-height:52px;padding:0 16px;border:1px solid var(--hair-paper);border-radius:12px;background:var(--paper2);color:var(--on-paper);font:500 16px/1.2 var(--display);text-decoration:none}
.fd-sheet-body .pc-btn--wide:first-child{border-color:var(--pink)}
.fd-sheet-body .pc-btn--big{width:100%}
.fd-sheet-body .pc-offer{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.fd-sheet-body .pc-offer b{display:block}.fd-sheet-body .pc-price{flex:none;font:500 17px/1.2 var(--display);color:var(--on-paper)}
.fd-sheet-body .pc-paid{display:inline-block;margin-right:8px;padding:2px 6px;border:1px solid var(--hair-paper);border-radius:4px;font:700 10px/1.3 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--on-paper-mut)}
.fd-sheet-body .pc-offers,.fd-sheet-body .pc-picks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.fd-sheet-body .pc-offers li,.fd-sheet-body .pc-picks li{border-top:1px solid var(--hair-paper);padding-top:10px}
.fd-sheet-body .pc-offers b,.fd-sheet-body .pc-picks b{color:var(--on-paper);font-weight:600}
.fd-sheet-body .pc-picks a{display:flex;gap:12px;align-items:center;color:inherit;text-decoration:none}
.fd-sheet-body .pc-picks img{width:56px;height:56px;object-fit:cover;border-radius:8px;flex:none}
.fd-sheet-body small{display:block;color:var(--on-paper-mut);font-size:12.5px}
.fd-sheet-body .pc-times{display:flex;flex-direction:column;gap:8px}.fd-sheet-body .pc-book-row{width:100%;justify-content:space-between;gap:12px;text-align:left}.fd-sheet-body .pc-book-row small{font:400 12.5px/1.3 var(--body)}.fd-sheet-body .pc-link-btn{margin-top:12px;padding:8px 0;border:0;background:none;color:var(--gold-deep);font:600 14px/1 var(--body);cursor:pointer}.fd-sheet-body .pc-form label.pc-check{flex-direction:row;align-items:flex-start;gap:8px;font:400 14px/1.35 var(--body)}.fd-sheet-body .pc-code{font-size:24px!important;letter-spacing:.4em;text-align:center}.fd-sheet-body .pc-sum{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 6px}.fd-sheet-body .pc-sum dt{color:var(--on-paper-mut);font-size:13px}.fd-sheet-body .pc-sum dd{margin:0;color:var(--on-paper);font-weight:600;text-align:right}
.fd-sheet-load{padding:28px 0;text-align:center;color:var(--on-paper-mut)}
body.fd-locked{overflow:hidden}
@media (min-width:800px){.fd-panel{left:50%;right:auto;bottom:50%;width:min(520px,92vw);max-height:84vh;border-radius:18px;transform:translate(-50%,50%)}.fd-sheet.opening .fd-panel{transform:translate(-50%,60%)}.fd-grab{display:none}}`;
}

/** Accent classes for the CSP-safe page (no style attributes): the brand's colour is chosen from a fixed set, else pink. */
const accentClass = (hex: string) => (hex.toLowerCase() === T.pink.toLowerCase() ? "pink" : "brand");

const DECK_JS = `(function(){var t=document.getElementById('track'),p=document.getElementById('progress').children,n=p.length;function i(){return Math.round(t.scrollLeft/t.clientWidth)}function m(){var k=i();for(var j=0;j<n;j++)p[j].className=j<=k?'on':''}function go(d){t.scrollTo({left:(i()+d)*t.clientWidth,behavior:'smooth'})}t.addEventListener('scroll',function(){window.requestAnimationFrame(m)});document.getElementById('prev').onclick=function(){go(-1)};document.getElementById('next').onclick=function(){go(1)};document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1)});var s=document.getElementById('btnShare');if(s)s.onclick=function(){if(navigator.share)navigator.share({title:document.title,url:location.href}).catch(function(){});else if(navigator.clipboard)navigator.clipboard.writeText(location.href)};m()})();`;

/** The stylesheet for both modes. `accent` is the brand's colour on a tailored pitch (deck mode inlines it). */
export function nomiDeckCss(accent: string = T.pink): string {
  const widths = Array.from({ length: 21 }, (_, i) => `.w${i * 5}{width:${i * 5}%}`).join("");
  return `:root{--ink:${T.ink};--ink2:${T.inkRaised};--paper:${T.paper};--paper2:${T.paperRaised};--on-ink:${T.onInk};--on-ink-dim:${T.onInkDim};--on-ink-mut:${T.onInkMut};--on-paper:${T.onPaper};--on-paper-dim:${T.onPaperDim};--on-paper-mut:${T.onPaperMut};--gold:${T.gold};--gold-deep:${T.goldDeep};--hair-ink:${T.hairInk};--hair-paper:${T.hairPaper};--pink:${T.pink};--accent:${accent};
--display:'Bodoni Moda',Didot,'Times New Roman',serif;--body:'Outfit',system-ui,-apple-system,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}html,body{background:var(--ink);color:var(--on-ink);font-family:var(--body);-webkit-font-smoothing:antialiased}
.look-campaign{--display:'Archivo','Arial Narrow',system-ui,sans-serif}
.look-campaign .display,.look-campaign .name{font-stretch:78%;font-weight:850;text-transform:uppercase;letter-spacing:-.01em;font-style:normal}
.look-campaign .hook,.look-campaign .line em,.look-campaign .close-line{font-family:var(--body);font-style:normal;font-weight:600;color:var(--accent)}
.look-campaign .eyebrow{color:var(--accent)}.look-campaign .g-paper .eyebrow{color:var(--accent)}
.look-campaign img.bg{filter:none}
.deck .frame{position:relative;height:100svh;max-width:440px;margin:0 auto;overflow:hidden;background:var(--ink)}
.deck .track{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}.deck .track::-webkit-scrollbar{display:none}
.deck .scr{flex:0 0 100%;scroll-snap-align:start;height:100%}
.progress{position:absolute;z-index:5;top:max(10px,env(safe-area-inset-top));left:14px;right:14px;display:flex;gap:4px}.progress i{flex:1;height:2px;border-radius:2px;background:rgba(244,238,226,.28)}.progress i.on{background:var(--on-ink)}
.nav{position:absolute;z-index:4;top:12%;bottom:22%;width:28%;background:transparent;border:0;cursor:pointer}.nav.prev{left:0}.nav.next{right:0}
.page .pagecol{max-width:480px;margin:0 auto}.page .scr{min-height:100svh}
.scr{position:relative;overflow:hidden;display:flex;flex-direction:column;width:100%}
.g-ink{background:var(--ink);color:var(--on-ink)}.g-paper{background:var(--paper);color:var(--on-paper)}.g-photo{background:var(--ink);color:var(--on-ink)}
img.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%}
img.bg.toned{opacity:.92}
.scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(21,17,13,.45) 0%,rgba(21,17,13,0) 22%,rgba(21,17,13,0) 42%,rgba(21,17,13,.82) 74%,rgba(21,17,13,.96) 100%)}
.inner{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;gap:14px;padding:64px 26px 40px;width:100%;min-width:0;overflow-wrap:break-word}
.inner>*{max-width:100%;min-width:0}.timeline li>*,.reasons li>*,.buckets li>*{min-width:0}
.band{position:relative;height:38%;flex:0 0 auto;overflow:hidden}.band.short{height:30%}.band .bandimg{width:100%;height:100%;object-fit:cover;object-position:50% 50%;display:block}
.band::after{content:"";position:absolute;inset:auto 0 0 0;height:46%;background:linear-gradient(180deg,transparent,var(--band-fade,var(--ink)))}.g-paper .band::after{background:linear-gradient(180deg,transparent,var(--paper))}
.inner.under{justify-content:flex-start;padding-top:8px;gap:12px}
.k-record.g-ink .hero-entry,.k-record.g-ink .timeline li{border-color:var(--hair-ink)}.k-record.g-ink .timeline .lvl{color:var(--on-ink-mut)}.k-record.g-ink .year{color:var(--gold)}
.k-record.g-ink .badge{background:var(--on-ink);color:var(--ink)}.k-record.g-ink .mia{background:var(--ink2);box-shadow:none;border:1px solid var(--hair-ink)}.k-record.g-ink .mia-t p{color:var(--on-ink)}.k-record.g-ink .mia-n span{color:var(--on-ink-mut)}
.k-record.v-A .timeline li:nth-child(n+3){display:none}.k-record.v-A .display{font-size:24px}.k-record .band{height:27%}.k-record.v-A .timeline li{padding:9px 0}.k-record.v-A .what{font-size:14px}.k-record.v-A .mia{padding:12px}.k-record.v-A .mia-n b{font-size:36px}.k-record.v-A .mia-t p{font-size:14px}
.inner.bottom{justify-content:flex-end}
.k-cover .inner.panel{flex:0 0 auto;margin-top:auto;padding-top:96px;background:linear-gradient(180deg,rgba(21,17,13,0) 0,rgba(21,17,13,.9) 84px,rgba(21,17,13,.94) 100%)}
.k-cover.split .cover-band{position:relative;flex:0 0 46%;overflow:hidden}.k-cover.split .cover-band .bandimg{width:100%;height:100%;object-fit:cover;object-position:50% 30%;display:block}
.k-cover.split .cover-band::after{content:"";position:absolute;inset:auto 0 0 0;height:40%;background:linear-gradient(180deg,rgba(21,17,13,0),var(--ink))}
.k-cover.split .inner.under{padding-top:6px;gap:10px}.k-cover.split .name{font-size:44px}.inner.center{justify-content:center}.inner.top{justify-content:flex-start;padding-top:72px}
.eyebrow{font:600 11px/1.3 var(--body);letter-spacing:.22em;text-transform:uppercase;color:var(--gold)}
.g-paper .eyebrow{color:var(--gold-deep)}
.eyebrow::before{content:"";display:inline-block;width:26px;height:1px;background:currentColor;opacity:.6;margin-right:10px;vertical-align:middle}
.name{font:500 52px/.92 var(--display);letter-spacing:-.01em}.name span{display:block}.name.giant{font-size:78px}
.meta{font:500 13px/1.4 var(--body);color:var(--on-ink-dim);letter-spacing:.04em}
.hook{font:italic 400 21px/1.35 var(--display);color:var(--gold);max-width:22ch}
.stats{display:flex;gap:22px;padding-top:12px;border-top:1px solid var(--hair-ink)}.stat b{display:block;font:500 24px/1 var(--display)}.stat span{font:500 10px/1.3 var(--body);letter-spacing:.12em;text-transform:uppercase;color:var(--on-ink-mut)}
.display{font:500 40px/1.06 var(--display);letter-spacing:-.005em;text-wrap:balance}
.fs-1{font-size:46px}.fs-2{font-size:40px}.fs-3{font-size:34px}.fs-4{font-size:29px}.fs-5{font-size:24px}
.line{font:400 17px/1.5 var(--body);color:var(--on-ink-dim);max-width:34ch}.line em{font:italic 400 19px/1.4 var(--display);color:var(--gold)}
.g-paper .line{color:var(--on-paper-dim)}.g-paper .line em{color:var(--gold-deep)}
.note,.sub{font:400 14px/1.55 var(--body);color:var(--on-ink-mut);max-width:36ch}.g-paper .note,.g-paper .sub{color:var(--on-paper-mut)}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips span{font:500 12px/1 var(--body);padding:8px 12px;border:1px solid var(--hair-ink);border-radius:999px;color:var(--on-ink-dim)}
.g-paper .chips span{border-color:var(--hair-paper);color:var(--on-paper-dim)}
.lockup{display:flex;align-items:center;gap:10px}.chip-logo{width:40px;height:40px;border-radius:12px;background:#fff;display:grid;place-items:center;overflow:hidden}.chip-logo .logo{width:30px;height:30px;object-fit:contain}
.lockup .x{color:var(--on-ink-mut);font-size:14px}.lock-name{font:600 12px/1 var(--body);letter-spacing:.2em;text-transform:uppercase;color:var(--gold)}
.hero-entry{display:flex;flex-direction:column;gap:8px;padding:6px 0 16px;border-bottom:1px solid var(--hair-paper)}
.year{font:italic 500 15px/1 var(--display);color:var(--gold-deep)}.badge{align-self:flex-start;font:600 10px/1 var(--body);letter-spacing:.16em;text-transform:uppercase;padding:7px 10px;border-radius:999px;background:var(--on-paper);color:var(--paper)}
.timeline{list-style:none;display:flex;flex-direction:column}.timeline li{display:grid;grid-template-columns:52px 1fr;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--hair-paper)}
.timeline .what{font:500 15px/1.35 var(--body);overflow-wrap:anywhere}.timeline .lvl{grid-column:2;font:500 11px/1.35 var(--body);overflow-wrap:anywhere;letter-spacing:.12em;text-transform:uppercase;color:var(--on-paper-mut)}
.mia{margin-top:auto;display:flex;gap:16px;align-items:center;padding:16px;border-radius:18px;background:var(--paper2);box-shadow:0 10px 30px rgba(27,23,18,.08)}
.mia-n b{font:500 44px/1 var(--display)}.mia-n span{font:500 13px/1 var(--body);color:var(--on-paper-mut);margin-left:4px}.mia-t p{font:italic 400 16px/1.35 var(--display);color:var(--on-paper);margin-top:4px}
.statrow{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:12px 0;border-top:1px solid var(--hair-ink);border-bottom:1px solid var(--hair-ink)}.statrow.n2{grid-template-columns:1fr 1fr}.statrow.n1{grid-template-columns:1fr}
.statrow b{display:block;font:500 26px/1 var(--display);color:var(--on-ink)}.statrow span{display:block;margin-top:5px;font:500 10px/1.3 var(--body);letter-spacing:.1em;text-transform:uppercase;color:var(--on-ink-mut)}
.fact{font:500 12px/1.4 var(--body);overflow-wrap:anywhere;letter-spacing:.04em;color:var(--on-paper-mut)}.k-record.g-ink .fact{color:var(--on-ink-mut)}
.bignum b{display:block;font:500 64px/1 var(--display);color:var(--on-paper)}.bignum span{font:500 13px/1.3 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--on-paper-mut)}
.look-campaign .bignum b{font-stretch:78%;font-weight:850}
.overlap{background:var(--paper2);border-radius:14px;padding:12px 14px;border:1px solid var(--hair-paper)}.overlap .eyebrow::before{display:none}.overlap p{font:400 13px/1.45 var(--body);color:var(--on-paper-dim);margin-top:4px}
.big b{display:block;font:500 72px/1 var(--display);color:var(--gold)}.big span{font:500 12px/1.4 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--on-ink-mut)}
.tiles{display:grid;gap:8px;grid-template-columns:1fr 1fr}.tiles.n3 figure:first-child{grid-column:1/3;aspect-ratio:5/4}.tiles.n1{grid-template-columns:1fr}
.tiles figure{position:relative;aspect-ratio:4/5;border-radius:14px;overflow:hidden;background:var(--ink2)}.tiles img.tile{width:100%;height:100%;object-fit:cover}
.tiles figcaption{position:absolute;left:8px;bottom:8px;font:600 12px/1 var(--body);padding:6px 8px;border-radius:999px;background:rgba(21,17,13,.66);color:var(--on-ink)}
.cards2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pcard{background:var(--paper2);border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(27,23,18,.07);display:flex;flex-direction:column;gap:6px}
.pcard .eyebrow::before{display:none}.pcard b{font:500 30px/1 var(--display)}.pcard span{font:400 12px/1.3 var(--body);color:var(--on-paper-mut)}
.bars{display:flex;flex-direction:column;gap:8px}.bars .eyebrow::before{display:none}.bar{display:grid;grid-template-columns:54px 1fr 40px;gap:10px;align-items:center;font:500 13px/1 var(--body)}
.track{height:6px;border-radius:6px;background:rgba(27,23,18,.08);overflow:hidden}.track i{display:block;height:100%;border-radius:6px;background:var(--gold-deep)}.bar .val{text-align:right;color:var(--on-paper-dim)}
.look-campaign .track i{background:var(--accent)}
${widths}
.reasons,.buckets{list-style:none;display:flex;flex-direction:column;gap:14px;margin-top:6px}.reasons li,.buckets li{display:grid;grid-template-columns:30px 1fr;gap:12px;padding-top:14px;border-top:1px solid var(--hair-ink)}
.num{font:italic 500 15px/1.4 var(--display);color:var(--gold)}.reasons b,.buckets b{font:600 15px/1.3 var(--body)}.reasons p,.buckets p{font:400 14px/1.5 var(--body);color:var(--on-ink-dim);margin-top:4px}
.aud{display:block;font:500 10px/1.4 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--on-ink-mut);margin-top:3px}
.close-line{font:italic 400 20px/1.35 var(--display);color:var(--gold);margin-top:8px}
.rows{list-style:none;display:flex;flex-direction:column;gap:10px}.rows li{display:flex;flex-direction:column;gap:3px;padding-top:10px;border-top:1px solid var(--hair-paper)}.rows b{font:600 15px/1.3 var(--body)}.rows span{font:400 14px/1.45 var(--body);color:var(--on-paper-dim)}
.btn,.door{display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;font:600 15px/1 var(--body);padding:15px 22px;border-radius:999px;background:var(--pink);color:#fff;text-decoration:none;border:0;cursor:pointer}
.look-campaign .btn{background:var(--accent)}
.mark{font:600 11px/1 var(--body);letter-spacing:.3em;text-transform:uppercase;color:var(--on-ink-mut);margin-top:8px}
.doors-block{padding:48px 26px 120px;display:flex;flex-direction:column;gap:16px;background:var(--ink)}.doors{display:flex;flex-direction:column;gap:10px}.door{align-self:stretch;background:var(--paper);color:var(--on-paper)}.door-partner{background:var(--pink);color:#fff}
.fine{font:400 13px/1.5 var(--body);color:var(--on-ink-mut)}
.sticky{position:fixed;z-index:9;left:50%;transform:translateX(-50%);bottom:max(16px,env(safe-area-inset-bottom));font:600 14px/1 var(--body);padding:13px 20px;border-radius:999px;background:rgba(21,17,13,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:var(--on-ink);text-decoration:none;border:1px solid var(--hair-ink)}
.acc-brand{}
@media (prefers-reduced-motion:no-preference){.deck .track{scroll-behavior:smooth}}`;
}
