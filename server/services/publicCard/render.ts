/**
 * render.ts — the public athlete page (/p/:handle) as server-rendered HTML, from a PublicCardView only.
 *
 * Design: public profile v2 "Mila at the centre" (approved 8 Oct 2026). Swipeable chapter cards on top (~70% of a phone's
 * height), a compact notched 2×2 grid below (Partner · Book / Shop · Create, or their fallbacks), and the round Mila
 * avatar at the centre (the Ask door). On desktop the grid sits beside the cards.
 *
 * Works without script: the cards are a native scroll-snap row (swipe and anchors work), every tile and the avatar are
 * real links to plain door pages (renderDoorPage), and Partner's door page is a plain request form. The first-party
 * scripts only enhance: arrows, keyboard and dots for the cards; the Mila sheet (PR 4a) for the doors.
 *
 * Security: every value is HTML-escaped here; URLs from data pass safeHttpUrl(); there is no inline script and no
 * style attribute, so the page runs under a strict CSP (setPublicPageCsp: script-src 'self', style-src 'self' + fonts).
 * The widget's data travels in a JSON <script type="application/json"> block, which is data, not code.
 */
import { htmlEscape as esc } from "../../lib/securityHeaders";
import { SHOW_VERIFIED } from "../../../shared/publicPageStats";
import { BUDGETS, GOALS, KIND_MAP, PRESS_FORMATS, isKind } from "../partner/kinds";
import type {
  PublicCardView,
  PublicChapter,
  PublicChapterItem,
  PublicMedia,
  PublicOffer,
  PublicPick,
  PublicTile,
  TileIntent,
} from "./view";

/** The doors that have a plain no-script page. "story" tiles are in-page anchors instead. */
export const DOOR_PAGES = ["partner", "book", "shop", "create", "ask", "follow"] as const;
export type DoorPage = (typeof DOOR_PAGES)[number];
export const isDoorPage = (v: string): v is DoorPage => (DOOR_PAGES as readonly string[]).includes(v);

/**
 * The no-script Partner form's state (partner/doorForm.ts does the work). `open` = the Partner door takes requests
 * (PARTNER_INTAKE on and her door on). Without it the form stays the disabled "opens soon" form.
 */
export interface PartnerFormState {
  open: boolean;
  /** The request kind chosen (from ?kind=, a chip, or Mila's tap), or null: the kind chooser. */
  kind: string | null;
  /** Server time the form was drawn (the minimum fill time check). */
  openedAt: number;
  error?: { text: string; field: string | null } | null;
  /** What the visitor typed, echoed back after an error. */
  values?: Record<string, string>;
}

export interface RenderOptions {
  /** The Partner door page's form state (only the partner door page reads it). */
  partner?: PartnerFormState | null;
  /**
   * Public Mila mode (PR 5, ASK_MILA_PUBLIC on): where the sheet sends a typed question, and which visitor taps exist
   * (each only when its track's port is wired). Absent → the sheet keeps typing closed ("opens soon").
   */
  ask?: { endpoint: string; booking: boolean; partner: boolean } | null;
  /**
   * The visitor's heart in the top bar (the Front Door page; front.js draws it, so it needs script). `endpoint` is where
   * a like is sent (POST /p/:handle/like); null on the dev fixtures (the heart toggles, nothing is sent). Absent → no
   * heart (door pages). Visitors never see a count.
   */
  like?: { endpoint: string | null } | null;
  /** Where this card's page lives, e.g. "/p/<handle>" (or the dev fixture path). Door pages hang off it. */
  basePath: string;
  /** Absolute origin for og:url / og:image, e.g. "https://nomila.co". */
  publicOrigin: string;
  /** Versioned same-origin asset URLs. */
  assets: {
    css: string;
    js: string;
    /** The Mila widget bundle (PR 4a): script + its stylesheet. Absent → the doors stay plain links. */
    milaJs?: string;
    milaCss?: string;
    /** Public Mila mode's transport (PR 5): loaded after mila.js only when `ask` is set. */
    askJs?: string;
    /** The Book door's request flow (Bookings PR2). Absent → the door stays a plain list. */
    bookJs?: string;
    /** Mila avatar files, by state. */
    mila: { poster: string; idle: string; searching?: string; generating?: string; writing?: string };
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

/** Only http(s) URLs from data ever reach an href/src. Anything else becomes "" and the element is dropped. */
export function safeHttpUrl(u: string | undefined | null): string {
  if (!u) return "";
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : "";
  } catch {
    return "";
  }
}

/** Same-origin media paths (the media proxy) or http(s). */
function mediaSrc(u: string): string {
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return safeHttpUrl(u);
}

export function formatMoney(minor: number, currency = "USD"): string {
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${esc(currency)}`;
  }
}

const fullName = (v: PublicCardView) => `${v.athlete.firstName} ${v.athlete.lastName}`.trim();

const ICONS: Record<TileIntent | "verified" | "back" | "prev" | "next" | "ext" | "heart", string> = {
  partner: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  book: '<rect x="3" y="4" width="18" height="18"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  shop: '<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  create: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>',
  story: '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>',
  follow: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6"/>',
  ask: '<path d="M4 5h16v11H9l-5 4z"/>',
  verified: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7 12.3l3.3 3.2L17 9" stroke="#0E0E0E"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  ext: '<path d="M7 17L17 7M9 7h8v8"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
};
const icon = (name: keyof typeof ICONS, cls = "pc-ic") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

function renderMedia(m: PublicMedia | null | undefined, cls: string, eager = false): string {
  if (!m) return "";
  const src = mediaSrc(m.src);
  if (!src) return "";
  if (m.kind === "video") {
    const poster = m.poster ? mediaSrc(m.poster) : "";
    // Never autoplay: the script plays it only when reduced motion is off and the page is visible.
    return `<video class="${cls}" src="${esc(src)}"${poster ? ` poster="${esc(poster)}"` : ""} muted loop playsinline preload="metadata"${m.alt ? ` aria-label="${esc(m.alt)}"` : ' aria-hidden="true"'}></video>`;
  }
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(m.alt)}"${eager ? "" : ' loading="lazy"'} decoding="async">`;
}

// ── chapter cards ────────────────────────────────────────────────────────────

function renderItems(items: PublicChapterItem[]): string {
  const stats = items.filter((i): i is Extract<PublicChapterItem, { type: "stat" }> => i.type === "stat").slice(0, 3);
  const beats = items.filter((i): i is Extract<PublicChapterItem, { type: "beat" }> => i.type === "beat").slice(0, 4);
  const partners = items.filter((i): i is Extract<PublicChapterItem, { type: "partner" }> => i.type === "partner").slice(0, 4);
  const facts = items.filter((i): i is Extract<PublicChapterItem, { type: "fact" }> => i.type === "fact").slice(0, 4);
  const media = items.filter((i): i is Extract<PublicChapterItem, { type: "media" }> => i.type === "media").slice(0, 6);
  const links = items.filter((i): i is Extract<PublicChapterItem, { type: "link" }> => i.type === "link").slice(0, 3);
  let out = "";
  if (stats.length)
    out += `<dl class="pc-stats">${stats
      .map((s) => `<div class="pc-stat"><dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd>${s.asOf ? `<dd class="pc-asof">${esc(s.asOf)}</dd>` : ""}</div>`)
      .join("")}</dl>`;
  if (beats.length)
    out += `<ol class="pc-beats">${beats.map((b) => `<li><span class="pc-k">${esc(b.label)}</span><p>${esc(b.text)}</p></li>`).join("")}</ol>`;
  if (partners.length)
    out += `<ul class="pc-partners">${partners
      .map(
        (p) =>
          `<li>${p.logo ? renderMedia(p.logo, "pc-logo") : `<span class="pc-logo pc-logo--name">${esc(p.name)}</span>`}<span class="pc-row"><b>${esc(p.name)}</b>${p.since ? `<small>${esc(p.since)}</small>` : ""}</span></li>`,
      )
      .join("")}</ul>`;
  if (facts.length)
    out += `<ul class="pc-facts">${facts.map((f) => `<li><b>${esc(f.text)}</b>${f.detail ? `<small>${esc(f.detail)}</small>` : ""}</li>`).join("")}</ul>`;
  if (media.length)
    out += `<ul class="pc-mgrid">${media.map((m) => `<li>${renderMedia(m.media, "pc-mthumb")}${m.caption ? `<small>${esc(m.caption)}</small>` : ""}</li>`).join("")}</ul>`;
  if (links.length)
    out += `<ul class="pc-links">${links
      .map((l) => {
        const href = safeHttpUrl(l.url);
        const inner = `<b>${esc(l.title)}</b><small>${esc(l.outlet)}</small>`;
        return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}${icon("ext")}</a>` : inner}</li>`;
      })
      .join("")}</ul>`;
  return out;
}

function renderChapter(v: PublicCardView, ch: PublicChapter, i: number, n: number): string {
  const isFirst = i === 0;
  const bg = isFirst ? (v.hero ?? ch.media) : ch.media;
  const label = `${i + 1} of ${n}: ${ch.title}`;
  let body: string;
  if (ch.kind === "highlights") {
    const a = v.athlete;
    body =
      (SHOW_VERIFIED && a.verified ? `<span class="pc-verified">${icon("verified")}Verified by Nomila</span>` : "") +
      `<h1 class="pc-name"><span>${esc(a.firstName)}</span> <span>${esc(a.lastName)}</span></h1>` +
      (a.quote ? `<p class="pc-quote"><span class="pc-sr">In ${esc(a.firstName)}'s words: </span>“${esc(a.quote)}”</p>` : "") +
      (a.identityLine ? `<p class="pc-line">${esc(a.identityLine)}</p>` : "") +
      renderItems(ch.items);
  } else {
    body =
      (ch.eyebrow ? `<p class="pc-eyebrow">${esc(ch.eyebrow)}</p>` : "") +
      `<h2 class="pc-h">${esc(ch.headline)}</h2>` +
      (ch.body ? `<p class="pc-para">${esc(ch.body)}</p>` : "") +
      (ch.quote ? `<p class="pc-quote pc-quote--sm"><span class="pc-sr">In ${esc(v.athlete.firstName)}'s words: </span>“${esc(ch.quote)}”</p>` : "") +
      renderItems(ch.items);
  }
  return (
    `<article class="pc-card pc-tone-${i % 6}${bg ? " pc-card--media" : ""}" id="ch-${esc(ch.id)}" data-title="${esc(ch.title)}" role="group" aria-roledescription="slide" aria-label="${esc(label)}">` +
    (bg ? `<div class="pc-bgwrap">${renderMedia(bg, "pc-bg", isFirst)}</div>` : "") +
    `<div class="pc-scrim" aria-hidden="true"></div>` +
    `<div class="pc-cardbody">${body}${ch.source ? `<p class="pc-src">${esc(ch.source)}</p>` : ""}</div>` +
    `</article>`
  );
}

// ── the grid ────────────────────────────────────────────────────────────────

function tileHref(t: PublicTile, basePath: string): string {
  if (t.intent === "story") return `#ch-${t.targetChapterId ?? ""}`;
  return `${basePath}/${t.intent}`;
}

function renderTile(t: PublicTile, basePath: string): string {
  const sub = t.hint ? `<small class="pc-tsub pc-tsub--hint">${esc(t.hint)}</small>` : `<small class="pc-tsub">${esc(t.subLabel)}</small>`;
  return (
    `<a class="pc-tile pc-tile--${t.slot}${t.soon ? " pc-tile--soon" : ""}" href="${esc(tileHref(t, basePath))}" data-intent="${t.intent}"` +
    (t.targetChapterId ? ` data-target="ch-${esc(t.targetChapterId)}"` : "") +
    `><span class="pc-tl">${icon(t.intent)}<b>${esc(t.label)}</b></span>${sub}</a>`
  );
}

function renderMilaButton(o: RenderOptions): string {
  const m = o.assets.mila;
  return (
    `<a class="pc-mila" href="${esc(o.basePath)}/ask" data-intent="ask" aria-label="Ask Mila">` +
    `<video class="pc-mila-v" poster="${esc(m.poster)}" src="${esc(m.idle)}" muted loop playsinline preload="metadata" aria-hidden="true" tabindex="-1"></video>` +
    `</a>`
  );
}

function renderGrid(v: PublicCardView, o: RenderOptions): string {
  return (
    `<nav class="pc-grid" aria-label="${esc(`Ways to connect with ${v.athlete.firstName}`)}">` +
    v.tiles.map((t) => renderTile(t, o.basePath)).join("") +
    renderMilaButton(o) +
    `</nav>`
  );
}

// ── head ────────────────────────────────────────────────────────────────────

function renderHead(v: PublicCardView, o: RenderOptions, title: string, canonicalPath: string): string {
  const desc = v.athlete.identityLine || `${fullName(v)} on Nomila.`;
  const url = o.publicOrigin + canonicalPath;
  const ogImg = v.hero && v.hero.kind === "image" ? v.hero.src : v.hero?.poster;
  const ogImage = ogImg ? (ogImg.startsWith("/") ? o.publicOrigin + ogImg : safeHttpUrl(ogImg)) : "";
  return (
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<title>${esc(title)}</title>` +
    `<meta name="description" content="${esc(desc)}">` +
    (v.indexable ? "" : `<meta name="robots" content="noindex, nofollow">`) +
    `<meta name="theme-color" content="#0E0E0E">` +
    `<link rel="canonical" href="${esc(url)}">` +
    `<meta property="og:type" content="profile">` +
    `<meta property="og:site_name" content="Nomila">` +
    `<meta property="og:title" content="${esc(`${fullName(v)} · Nomila`)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(url)}">` +
    `<meta property="profile:first_name" content="${esc(v.athlete.firstName)}">` +
    `<meta property="profile:last_name" content="${esc(v.athlete.lastName)}">` +
    (ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : "") +
    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&amp;display=swap">` +
    `<link rel="stylesheet" href="${esc(o.assets.css)}">` +
    (o.assets.milaJs && o.assets.milaCss ? `<link rel="stylesheet" href="${esc(o.assets.milaCss)}">` : "")
  );
}

function renderFooter(v: PublicCardView): string {
  const first = v.athlete.firstName;
  const socials = v.socials
    .map((s) => ({ ...s, href: safeHttpUrl(s.url) }))
    .filter((s) => s.href)
    .map((s) => `<li><a href="${esc(s.href)}" target="_blank" rel="noopener noreferrer me"><b>${esc(s.network)}</b><small>@${esc(s.handle)}</small>${icon("ext")}</a></li>`)
    .join("");
  const published = new Date(v.publishedAt);
  const when = isNaN(published.getTime())
    ? ""
    : published.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  // The Front Door footer: "Follow <First>" (her profiles when she linked any), and who published the page.
  return (
    `<footer class="pc-foot">` +
    `<section id="follow" aria-label="${esc(`Follow ${first}`)}"><h2 class="pc-fh">Follow ${esc(first)}</h2>${socials ? `<ul class="pc-socials">${socials}</ul>` : ""}</section>` +
    `<p class="pc-fine">Everything on this page was published by ${esc(first)}${when ? ` · ${esc(when)}` : ""}. ` +
    `Mila is Nomila's assistant. She answers from what ${esc(first)} published and never speaks as ${esc(first)}.</p>` +
    `<p class="pc-fine"><a href="https://nomila.co" rel="noopener">Nomila</a></p>` +
    `</footer>`
  );
}

/** The data the Mila widget (PR 4a) needs, as an inert JSON block. "<" is escaped so the block cannot be closed early. */
export function widgetData(v: PublicCardView, o: RenderOptions): string {
  const data = {
    handle: v.handle,
    version: v.version,
    basePath: o.basePath,
    first: v.athlete.firstName,
    minor: !!v.athlete.minor,
    mila: o.assets.mila,
    chapters: v.chapters.map((c) => ({ id: c.id, title: c.title, headline: c.headline, body: c.body ?? null, source: c.source ?? null })),
    offers: v.offers.map((x) => ({ ...x, price: formatMoney(x.allInMinor, x.currency) })),
    picks: v.picks.map((p) => ({
      id: p.id,
      title: p.title,
      merchant: p.merchant,
      price: p.priceMinor != null ? formatMoney(p.priceMinor, p.currency) : null,
      herWords: p.herWords ?? null,
      href: `/go/${encodeURIComponent(p.goCode)}`,
      image: p.image ? { src: mediaSrc(p.image.src), alt: p.image.alt } : null,
      fromBrand: !!p.fromBrand,
      amazon: !!p.amazon,
    })),
    socials: v.socials.map((s) => ({ ...s, url: safeHttpUrl(s.url) })).filter((s) => s.url),
    askChips: v.askChips,
    /** The four tile intents, so Ask can offer only the doors that are on. */
    doors: v.tiles.map((t) => t.intent),
    /**
     * Her Book door page (the request flow, book.js), when booking is on: bookings are on here (the flow is bundled)
     * and her published card has the Book door. Null → the Book panel shows her sessions with the "opens soon" line.
     */
    bookPath: o.assets.bookJs && v.tiles.some((t) => t.intent === "book") ? `${o.basePath}/book` : null,
    partnerKinds: PARTNER_KINDS,
    /** Public Mila mode, only when it is on AND her published card has Ask Mila on. */
    ask: askMilaOn(v, o) ? o.ask : null,
  };
  // "<" becomes its JSON escape, so the block can never be closed early. (U+2028/9 are harmless: JSON.parse reads it.)
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** Typing to Mila is open: the flag gave the page an endpoint, the transport is bundled, and her Ask Mila door is on. */
export const askMilaOn = (v: PublicCardView, o: RenderOptions): boolean => !!(o.ask && o.assets.askJs && o.assets.milaJs && v.askMila);

// ── the page ────────────────────────────────────────────────────────────────

export function renderPublicCardHtml(v: PublicCardView, o: RenderOptions): string {
  const n = v.chapters.length;
  const first = v.chapters[0];
  const name = fullName(v);
  const chapterStatus = first ? `${first.title} · 1 of ${n}` : "";
  return (
    `<!doctype html><html lang="en"><head>${renderHead(v, o, `${name} · Nomila`, o.basePath)}</head>` +
    `<body class="pc-body">` +
    `<a class="pc-skip" href="#pc-doors">Skip to ways to connect</a>` +
    `<main class="pc">` +
    `<section class="pc-hero" aria-roledescription="carousel" aria-label="${esc(`${v.athlete.firstName}'s chapters`)}">` +
    `<header class="pc-top"><span class="pc-wm">Nomila</span><span class="pc-topname" aria-hidden="true">${esc(name)}${SHOW_VERIFIED && v.athlete.verified ? " ✓" : ""}</span><span class="pc-handle">${esc(v.handle)}</span>` +
    // The visitor's heart: one like, tap again to take it back, no count. Drawn by front.js (it needs script), so hidden here.
    (o.like
      ? `<button type="button" class="pc-like" id="pc-like" hidden aria-pressed="false" aria-label="Like this page" data-handle="${esc(v.handle)}"${o.like.endpoint ? ` data-endpoint="${esc(o.like.endpoint)}"` : ""}>${icon("heart")}</button>`
      : "") +
    `</header>` +
    `<div class="pc-track" id="pc-track" tabindex="0" aria-label="${esc(`${n} chapters. Swipe or use the arrow keys.`)}">` +
    v.chapters.map((c, i) => renderChapter(v, c, i, n)).join("") +
    `</div>` +
    (n > 1
      ? `<div class="pc-nav">` +
        `<button type="button" class="pc-arrow pc-arrow--prev" data-dir="-1" aria-label="Previous chapter" aria-controls="pc-track" hidden>${icon("prev")}</button>` +
        `<p class="pc-chap" id="pc-chap" aria-live="polite">${esc(chapterStatus)}</p>` +
        `<span class="pc-dots" aria-hidden="true">${v.chapters.map((_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("")}</span>` +
        `<button type="button" class="pc-arrow pc-arrow--next" data-dir="1" aria-label="Next chapter" aria-controls="pc-track" hidden>${icon("next")}</button>` +
        `</div>`
      : "") +
    `</section>` +
    // The doors never move with the cards, and stay pinned while the page scrolls (front.css), so every door is
    // always one tap away. The footer sits in the page under the cards.
    `<div class="pc-doors" id="pc-doors">${renderGrid(v, o)}</div>` +
    renderFooter(v) +
    `</main>` +
    (o.assets.milaJs ? `<script type="application/json" id="pc-data">${widgetData(v, o)}</script>` : "") +
    `<script src="${esc(o.assets.js)}" defer></script>` +
    (o.assets.milaJs ? `<script src="${esc(o.assets.milaJs)}" defer></script>` : "") +
    (askMilaOn(v, o) ? `<script src="${esc(o.assets.askJs!)}" defer></script>` : "") +
    `</body></html>`
  );
}

// ── no-script door pages ────────────────────────────────────────────────────

export const PARTNER_KINDS = [
  { id: "sponsorship", label: "Sponsorship or ambassador" },
  { id: "content", label: "Social posts or content" },
  { id: "endorsement", label: "Endorsement or product collab (licensing, merch)" },
  { id: "appearance", label: "Appearance or event (speaking, signing, camp)" },
  { id: "press", label: "Interview, podcast or editorial" },
  { id: "other", label: "Something else" },
] as const;

/** The bookings API's public id for an offer row (snapshot keys are `offer:<publicId>`); null for fixtures/other keys. */
function offerPublicId(id: string): string | null {
  return id.startsWith("offer:") && /^[A-Za-z0-9_-]{4,64}$/.test(id.slice(6)) ? id.slice(6) : null;
}

function offerRow(x: PublicOffer): string {
  const fmt = x.format === "virtual" ? "Virtual" : "In person";
  const pid = offerPublicId(x.id);
  return `<li class="pc-offer"${pid ? ` data-offer="${esc(pid)}"` : ""}><span><b>${esc(x.title)}</b><small>${esc(`${x.durationMin} min · ${fmt}`)}${x.note ? ` · ${esc(x.note)}` : ""}</small></span><span class="pc-price">${esc(formatMoney(x.allInMinor, x.currency))}</span></li>`;
}

function pickRow(p: PublicPick): string {
  return (
    `<li class="pc-pick"><span class="pc-paid">Paid link</span><b>${esc(p.title)}</b>` +
    `<small>${esc(p.merchant)}${p.priceMinor != null ? ` · ${esc(formatMoney(p.priceMinor, p.currency))}` : ""}</small>` +
    (p.herWords ? `<q>${esc(p.herWords)}</q>` : "") +
    `<a class="pc-btn" href="/go/${esc(encodeURIComponent(p.goCode))}" target="_blank" rel="noopener noreferrer sponsored">Buy on ${esc(p.merchant)}</a></li>`
  );
}

// ── the working Partner form (PARTNER_INTAKE on) ────────────────────────────────

const GOAL_LABELS: Record<string, string> = { launch: "A launch", awareness: "Awareness", event: "An event", product_seeding: "Product seeding", other: "Something else" };
const FORMAT_LABELS: Record<string, string> = { interview: "Interview", podcast: "Podcast", editorial: "Editorial" };

/** The next 12 months as YYYY-MM, for "When would this run?". */
function nextMonths(now: Date): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push({ value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  return out;
}

function partnerForm(v: PublicCardView, o: RenderOptions, st: PartnerFormState): string {
  const first = v.athlete.firstName;
  const base = esc(o.basePath);
  if (!st.kind || !isKind(st.kind)) {
    // Step one: what kind of request. Each is a link, so it works with script off and from Mila's tap.
    return `<p class="pc-lede">What kind of request?</p><ul class="pc-kinds">` +
      PARTNER_KINDS.map((k) => `<li><a class="pc-btn pc-btn--wide" href="${base}/partner?kind=${k.id}">${esc(k.label)}</a></li>`).join("") +
      `</ul><p class="pc-fine">${esc(first)} reviews every request personally.</p>`;
  }
  const kind = st.kind;
  const press = KIND_MAP[kind].press;
  const val = (k: string) => esc(st.values?.[k] ?? "");
  const err = st.error ? `<p class="pc-error" role="alert" id="pc-error">${esc(st.error.text)}</p>` : "";
  const inv = (f: string) => (st.error?.field === f ? ' aria-invalid="true" aria-describedby="pc-error"' : "");
  const opt = (value: string, label: string, chosen: string) => `<option value="${esc(value)}"${value === chosen ? " selected" : ""}>${esc(label)}</option>`;
  const label = PARTNER_KINDS.find((k) => k.id === kind)!.label;
  const fields = press
    ? `<label>Outlet<input name="brand_name" required maxlength="120" autocomplete="organization" value="${val("brand_name")}"${inv("brand_name")}></label>` +
      `<label>Outlet website (optional)<input name="website" maxlength="300" inputmode="url" value="${val("website")}"${inv("website")}></label>` +
      `<label>What is the piece about?<textarea name="topic" rows="4" maxlength="600" required${inv("topic")}>${val("topic")}</textarea></label>` +
      `<fieldset${inv("format")}><legend>Format</legend>` +
      PRESS_FORMATS.map((f, i) => `<label class="pc-radio"><input type="radio" name="format" value="${f}"${(st.values?.format ?? (i === 0 ? f : "")) === f ? " checked" : ""}> ${FORMAT_LABELS[f]}</label>`).join("") +
      `</fieldset>` +
      `<label>Deadline (optional)<input name="deadline" type="date" value="${val("deadline")}"${inv("deadline")}></label>`
    : `<label>Brand<input name="brand_name" required maxlength="120" autocomplete="organization" value="${val("brand_name")}"${inv("brand_name")}></label>` +
      `<label>Brand website<input name="website" required maxlength="300" inputmode="url" value="${val("website")}"${inv("website")}></label>` +
      `<label>Your idea<textarea name="idea" rows="5" minlength="10" maxlength="1500" required${inv("idea")}>${val("idea")}</textarea></label>` +
      `<label>What are you hoping this does?<select name="goal"${inv("goal")}>${opt("", "Not sure yet", st.values?.goal ?? "")}${GOALS.map((g) => opt(g, GOAL_LABELS[g] ?? g, st.values?.goal ?? "")).join("")}</select></label>` +
      `<label>When would this run?<select name="timing_month"${inv("timing")}>${opt("", "Flexible", st.values?.timing_month ?? "")}${nextMonths(new Date(st.openedAt)).map((m) => opt(m.value, m.label, st.values?.timing_month ?? "")).join("")}</select></label>` +
      `<label>Budget range<select name="budget" required${inv("budget")}>${Object.entries(BUDGETS).map(([k, b]) => opt(k, b.label, st.values?.budget ?? "not_sure")).join("")}</select></label>` +
      `<label class="pc-radio"><input type="checkbox" name="agency"${st.values?.agency ? " checked" : ""}> I'm writing for a client</label>` +
      `<label>Client brand (if you're an agency)<input name="client_brand" maxlength="120" value="${val("client_brand")}"${inv("client_brand")}></label>`;
  return (
    `<form class="pc-form" method="post" action="${base}/partner">` +
    `<p class="pc-lede">${esc(label)} · <a href="${base}/partner">Change</a></p>` + err +
    `<input type="hidden" name="kind" value="${esc(kind)}">` +
    `<input type="hidden" name="opened_at" value="${esc(String(st.openedAt))}">` +
    // The honeypot: hidden from people and from screen readers; a bot that fills it is answered like a success.
    `<div class="pc-hp" aria-hidden="true"><label>Leave this empty<input name="website_confirm" tabindex="-1" autocomplete="off"></label></div>` +
    fields +
    `<label>Your name<input name="contact_name" required maxlength="120" autocomplete="name" value="${val("contact_name")}"${inv("contact_name")}></label>` +
    `<label>Your work email<input name="contact_email" type="email" required maxlength="254" autocomplete="email" value="${val("contact_email")}"${inv("contact_email")}></label>` +
    `<button class="pc-btn pc-btn--big pc-btn--ink" type="submit">Continue</button>` +
    `<p class="pc-fine">We'll email you a link to confirm. Nothing reaches ${esc(first)} until you tap Send in that email. ${esc(first)} reviews every request personally.</p>` +
    `</form>`
  );
}

/** A plain, server-rendered page for one door: the no-script path for every tile and the avatar. */
export function renderDoorPage(v: PublicCardView, door: DoorPage, o: RenderOptions): string {
  const first = v.athlete.firstName;
  let title: string;
  let body: string;
  switch (door) {
    case "partner":
      title = `Work with ${first}`;
      if (o.partner?.open) { body = partnerForm(v, o, o.partner); break; }
      // TODO(intake PR 6): POST {basePath}/partner has no backend yet, so the submit is disabled with a visible "not
      // yet" line (and the route answers "opens soon", storing nothing). The intake PR enables it and adds the honeypot,
      // minimum fill time, email confirmation and the opportunity.
      body =
        `<form class="pc-form" method="post" action="${esc(o.basePath)}/partner">` +
        `<fieldset><legend>What kind of request?</legend>` +
        PARTNER_KINDS.map(
          (k, i) => `<label class="pc-radio"><input type="radio" name="kind" value="${k.id}"${i === 0 ? " checked" : ""}> ${esc(k.label)}</label>`,
        ).join("") +
        `</fieldset>` +
        `<label>Your name<input name="name" autocomplete="name" required maxlength="120"></label>` +
        `<label>Your email<input name="email" type="email" autocomplete="email" required maxlength="200"></label>` +
        `<label>Company, outlet or website<input name="org" autocomplete="organization" maxlength="200"></label>` +
        `<label>Your idea<textarea name="message" rows="5" maxlength="2000" required></textarea></label>` +
        // Not yet: the submit stays disabled, with a visible reason, until the intake PR gives it a backend.
        `<button class="pc-btn pc-btn--big" type="submit" disabled aria-describedby="pc-notyet">Send to ${esc(first)}</button>` +
        `<p class="pc-notyet" id="pc-notyet">Requests open soon. Nothing can be sent from this page yet.</p>` +
        `<p class="pc-fine">Nothing is sent until you tap. ${esc(first)} reviews every request.</p>` +
        `</form>`;
      break;
    case "book":
      title = `Book a session with ${first}`;
      // The list is what she published; book.js swaps it for her live offers (GET /api/v1/book/cards/:handle/offers),
      // so a session she publishes later shows here without a republish.
      body = `<div data-book data-book-handle="${esc(v.handle)}">` + (v.offers.length
        ? `<p class="pc-lede">All-in prices.</p><ul class="pc-offers">${v.offers.map(offerRow).join("")}</ul><p class="pc-fine" data-book-soon>Booking requests open soon.</p>`
        : `<p class="pc-lede">${esc(first)} has no sessions open right now.</p>`) + `</div>`;
      break;
    case "shop": {
      title = `Things ${first} uses`;
      const own = v.picks.filter((p) => !p.fromBrand);
      const brand = v.picks.filter((p) => p.fromBrand);
      body = v.picks.length
        ? `<p class="pc-lede">Paid links. ${esc(first)} may earn a commission if you buy.</p>` +
          (own.length ? `<ul class="pc-picks">${own.map(pickRow).join("")}</ul>` : "") +
          (brand.length ? `<h2 class="pc-fh">From brands ${esc(first)} works with</h2><ul class="pc-picks">${brand.map(pickRow).join("")}</ul>` : "") +
          (v.picks.some((p) => p.amazon) ? `<p class="pc-fine">As an Amazon Associate ${esc(first)} earns from qualifying purchases.</p>` : "")
        : `<p class="pc-lede">${esc(first)} has no picks yet.</p>`;
      break;
    }
    case "create":
      title = `Create with ${first}`;
      body = `<p class="pc-lede">Create with ${esc(first)} is coming soon.</p>`;
      break;
    case "follow": {
      title = `Follow ${first}`;
      const socials = v.socials
        .map((s) => ({ ...s, href: safeHttpUrl(s.url) }))
        .filter((s) => s.href)
        .map((s) => `<li><a href="${esc(s.href)}" target="_blank" rel="noopener noreferrer me"><b>${esc(s.network)}</b><small>@${esc(s.handle)}</small></a></li>`)
        .join("");
      body = socials ? `<ul class="pc-socials">${socials}</ul>` : `<p class="pc-lede">No linked profiles yet.</p>`;
      break;
    }
    case "ask":
    default:
      title = "Ask Mila";
      body =
        `<p class="pc-lede">Mila is Nomila's assistant. She answers questions about ${esc(first)} from what ${esc(first)} published. Chatting with Mila needs JavaScript.</p>` +
        `<ul class="pc-links">${v.chapters.map((c) => `<li><a href="${esc(o.basePath)}#ch-${esc(c.id)}"><b>${esc(c.title)}</b><small>${esc(c.headline)}</small></a></li>`).join("")}</ul>`;
      break;
  }
  return (
    `<!doctype html><html lang="en"><head>${renderHead(v, o, `${title} · ${fullName(v)} · Nomila`, `${o.basePath}/${door}`)}</head>` +
    `<body class="pc-body pc-body--door"><main class="pc-door">` +
    `<a class="pc-back" href="${esc(o.basePath)}">${icon("back")}Profile</a>` +
    `<h1 class="pc-dh">${esc(title)}</h1>${body}` +
    `</main>${door === "book" && o.assets.bookJs ? `<script src="${esc(o.assets.bookJs)}" defer></script>` : ""}</body></html>`
  );
}

/** The page after the no-script Partner form: check your email, or why nothing was sent. */
export function renderPartnerResult(v: PublicCardView, o: RenderOptions, r: { sent: true; email: string } | { sent: false; text: string }): string {
  const first = v.athlete.firstName;
  const title = r.sent ? "Check your email" : `Work with ${first}`;
  const body = r.sent
    ? `<p class="pc-lede">We sent a link to ${esc(r.email)}. Open it and tap Send to send your request to ${esc(first)}.</p>` +
      `<p class="pc-fine">Nothing reaches ${esc(first)} until you do. The link works for 3 days.</p>`
    : `<p class="pc-lede">${esc(r.text)}</p>`;
  return (
    `<!doctype html><html lang="en"><head>${renderHead(v, o, `${title} · ${fullName(v)} · Nomila`, `${o.basePath}/partner`)}</head>` +
    `<body class="pc-body pc-body--door"><main class="pc-door">` +
    `<a class="pc-back" href="${esc(o.basePath)}">${icon("back")}Profile</a>` +
    `<h1 class="pc-dh">${esc(title)}</h1>${body}` +
    `</main></body></html>`
  );
}
