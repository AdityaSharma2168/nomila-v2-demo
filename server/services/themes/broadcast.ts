/**
 * broadcast theme — the "Nomi Card" broadcast look (nomila-kit-broadcast.html) productionized.
 *
 * FAITHFUL REPRODUCTION + data-binding: the prototype's CSS, card markup and swipe/tap/keyboard/share
 * JS ARE the design and are kept verbatim (String.raw below). The only structural change vs. the raw
 * prototype is that the seven `#c1..#c7` id-scoped selectors are rewritten to type classes
 * (`.k-cover .k-index .k-mix .k-aud .k-tape .k-rates .k-fit`, plus a broadcast-styled `.k-video`) so an
 * optional video card can slot in without shifting positional ids, and the two values the prototype
 * hard-coded (the index meter fill and the commercial bar) are driven from the data instead.
 *
 * Everything renders from a theme-agnostic `MediaKitData` (see mediaKitService). Images / bg / poster /
 * video URLs arrive already-signed; nulls render photo-less over the theme's solid card background.
 * Self-contained: its own esc()/img()/clamp() helpers + the full broadcast CSS + JS. No imports but the type.
 */
import type { MediaKitData } from "../mediaKitService";

type Kit = MediaKitData;
type AnyCard = Kit["cards"][number];

// The official Nomila mark (from the landing page): four concentric arcs — the facets — over faint
// tracks, each arc a colour, all sharing one origin. The brand thesis rendered as the logo.
const NOMILA_MARK = `<svg class="nomila-mark" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <circle cx="56" cy="56" r="50" stroke="var(--bone)" stroke-width="4" stroke-opacity="0.10"/>
    <circle cx="56" cy="56" r="38" stroke="var(--bone)" stroke-width="4" stroke-opacity="0.10"/>
    <circle cx="56" cy="56" r="26" stroke="var(--bone)" stroke-width="4" stroke-opacity="0.10"/>
    <circle cx="56" cy="56" r="14" stroke="var(--bone)" stroke-width="4" stroke-opacity="0.10"/>
    <path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0" stroke="#2D8EFF" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke="#2DC87C" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke="#E84591" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0" stroke="#E8A215" stroke-width="5" stroke-linecap="round" fill="none"/>
  </svg>`;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));
// URLs are ALREADY signed at render time — drop straight into src; null → photo-less element.
const img = (url: string | null | undefined, alt = "", cls = ""): string =>
  url ? `<img${cls ? ` class="${cls}"` : ""} src="${esc(url)}" alt="${esc(alt)}">` : "";
// parse a compact money/number string ("$2.6K", "835", "1.5M") to a comparable magnitude
const magnitude = (v: string): number => {
  const num = parseFloat(String(v).replace(/[^0-9.]/g, "")) || 0;
  if (/M/i.test(v)) return num * 1e6;
  if (/K/i.test(v)) return num * 1e3;
  return num;
};

// ── 1 · COVER ────────────────────────────────────────────────────────────────
function coverCard(c: Extract<AnyCard, { type: "cover" }>): string {
  const [first, ...rest] = c.nameLines;
  const surname = rest.join(" ").trim();
  const metaParts = String(c.meta ?? "").split("·").map((s) => esc(s.trim())).filter(Boolean);
  const lower = metaParts.join(' <span>·</span> ');
  const ticker = c.stats
    .map((s) => `<span><b>${esc(s.value)}</b> ${esc(s.label)} <i>/</i></span>`)
    .join("\n        ");
  return `<section class="card k-cover" aria-label="Cover — ${esc(first)} ${esc(surname)}">
    <div class="hero">${img(c.image, c.nameLines.join(" "), "ph")}</div>
    <div class="scrim"></div>
    <div class="top">
      <div class="wordmark">${NOMILA_MARK}<span class="cardmark-label">Nomi Card</span></div>
      <div class="kit-tag">Media Kit</div>
    </div>
    <div class="name-block">
      <div class="display name">${esc(first)}${surname ? `<br><span class="row2">${esc(surname)}</span>` : ""}</div>
    </div>
    <div class="lower-third">${lower}</div>
    <p class="hook">${esc(c.hook)}</p>
    <div class="ticker">
      <div class="ticker-inner" id="ticker">
        ${ticker}
      </div>
    </div>
  </section>`;
}

// ── 2 · MARKETABILITY INDEX ──────────────────────────────────────────────────
function indexCard(c: Extract<AnyCard, { type: "index" }>): string {
  const frac = c.max ? clamp((c.value / c.max) * 100) / 100 : 0;
  return `<section class="card panel k-index" style="--v:${frac.toFixed(3)}" aria-label="M.I.A. — ${c.value} of ${c.max}">
    <div class="bug">INDEX</div>
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <div class="matchup">M.I.A. &mdash; Nomila&rsquo;s read of her marketability, in a single number.</div>
      <div class="mega-wrap">
        <div class="display mega num"><span data-count="${c.value}" data-fmt="int">${c.value}</span><span class="den">/ ${c.max}</span></div>
        <div class="meter"><div class="meter-fill"></div></div>
        <div class="meter-scale"><span>0</span><span>${c.max}</span></div>
        <p class="foot">${esc(c.verdict)}</p>
      </div>
    </div>
  </section>`;
}

// ── 3 · THE MIX ──────────────────────────────────────────────────────────────

// ── 4 · AUDIENCE ─────────────────────────────────────────────────────────────
function audienceCard(c: Extract<AnyCard, { type: "audience" }>): string {
  // giant hero number: the audience share % (prototype's volt "%" accent) — else fall back
  const heroNum = c.share != null
    ? `${esc(String(c.share))}<small>%</small>`
    : esc(c.stats[0]?.n ?? c.headline);
  const strip = c.stats
    .map((s, i) => `<div${i === 0 ? ' class="big"' : ""}><div class="fs-n">${esc(s.n)}</div><div class="fs-l">${esc(s.k)}</div></div>`)
    .join("\n        ");
  const geo = c.geo.map((g) => {
    const other = String(g.label).toLowerCase() === "other";
    const frac = g.pct == null ? 0 : clamp(g.pct) / 100;
    const val = g.pct == null ? "" : `${Math.round(g.pct)}%`;
    return `<div class="geo-row${other ? " other" : ""}"><div class="geo-name">${esc(g.label)}</div><div class="geo-track"><div class="geo-fill" style="--v:${frac.toFixed(3)}"></div></div><div class="geo-val num">${esc(val)}</div></div>`;
  }).join("\n        ");
  return `<section class="card panel k-aud" aria-label="Audience — ${esc(c.headline)}">
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <div class="hero-stat">
        <div class="n num">${heroNum}</div>
        <div class="hero-cap">${esc(c.headline)}<span>${esc(c.sub)}</span></div>
      </div>
      <div class="follow-strip num">
        ${strip}
      </div>
      <div class="kicker" style="margin-bottom:14px"><i></i>Where they live</div>
      <div class="geo">
        ${geo}
      </div>
    </div>
  </section>`;
}

// ── 5 · THE TAPE (content) ───────────────────────────────────────────────────
function contentCard(c: Extract<AnyCard, { type: "content" }>): string {
  const [lead, ...subs] = c.tiles;
  const subTiles = subs.map((t, i) => `<div class="tile sub">
          ${img(t.image, "")}
          <div class="veil"></div>
          <div class="stat"><div class="v num">${esc(t.stat)}</div><div class="l">Views &middot; No.&nbsp;${i + 2}</div></div>
        </div>`).join("\n        ");
  return `<section class="card panel k-tape" aria-label="Top content">
    <div class="card-inner">
      <div class="kicker red" style="padding:0 4px"><i></i>${esc(c.eyebrow)}</div>
      <div class="tiles">
        <div class="tile main">
          ${lead ? img(lead.image, "") : ""}
          <div class="veil"></div>
          <div class="flag">No. 1 post</div>
          <div class="stat">
            <div class="v num">${esc(lead ? lead.stat : c.heroStat.value)}</div>
            <div class="l">${esc(c.heroStat.label)}</div>
          </div>
        </div>
        ${subTiles}
      </div>
      <div class="tape-note">${esc(c.note)}</div>
    </div>
  </section>`;
}

// ── (optional) · IN MOTION (video) — broadcast-styled, full-bleed like cover/fit ──
function videoCard(c: Extract<AnyCard, { type: "video" }>): string {
  return `<section class="card k-video" aria-label="In motion — autoplaying clip">
    <div class="bg-vid">
      <video autoplay muted loop playsinline preload="metadata"${c.posterUrl ? ` poster="${esc(c.posterUrl)}"` : ""}>
        <source src="${esc(c.videoUrl)}" type="video/mp4">
      </video>
    </div>
    <div class="scrim"></div>
    <div class="live-dot" aria-hidden="true"></div>
    <div class="card-inner vid-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <p class="vid-note">${esc(c.note)}</p>
    </div>
  </section>`;
}

// ── 6 · RATE CARD ────────────────────────────────────────────────────────────

// ── 7 · THE FIT ──────────────────────────────────────────────────────────────
function fitCard(c: Extract<AnyCard, { type: "fit" }>): string {
  const chips = c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("\n        ");
  const whyBody = c.body && c.body !== c.lead ? `<div><i></i><span>${esc(c.body)}</span></div>` : "";
  return `<section class="card k-fit" aria-label="Brand fit and share">
    <div class="bg">${img(c.image, "")}</div>
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <h2 class="display">Built for<br><em>your brand.</em></h2>
      <div class="cats">
        ${chips}
      </div>
      <div class="why">
        <div><i></i><span>${esc(c.lead)}</span></div>
        ${whyBody}
      </div>
      <div class="cta">
        <button class="cta-btn" id="ctaShare" type="button">Share this kit</button>
      </div>
      <div class="cta-sub">Send by text or email &mdash; the kit does the talking</div>
    </div>
  </section>`;
}

// ── Card library (Spec 8/9) — same data contract as campaign; broadcast idiom: the ".panel"
// diagonal-texture chrome IS this theme's photo-less state (already used by index/mix/rates), so the
// library cards get it free — a signed `bg` just layers a full-bleed photo + scrim on top of it. ──
function libBackdrop(bg: string | null | undefined): string {
  return (bg ? `<div class="lib-bg">${img(bg, "", "ph")}</div><div class="lib-scrim"></div>` : "") + RINGS_WM;
}
// The faint rings watermark (owner, 23 Oct 2026: every look carries the Nomila mark treatment): the mark's four
// tracks in the broadcast paper white, top-right on the library cards, under the content.
const RINGS_WM = `<svg class="rings-wm" viewBox="0 0 112 112" fill="none" aria-hidden="true"><circle cx="56" cy="56" r="50" stroke="#F2EFE6" stroke-width="1.4" stroke-opacity="0.09"/><circle cx="56" cy="56" r="38" stroke="#F2EFE6" stroke-width="1.4" stroke-opacity="0.09"/><circle cx="56" cy="56" r="26" stroke="#F2EFE6" stroke-width="1.4" stroke-opacity="0.09"/><circle cx="56" cy="56" r="14" stroke="#F2EFE6" stroke-width="1.4" stroke-opacity="0.09"/></svg>`;


function whyFitsCard(c: Extract<AnyCard, { type: "whyFits" }>): string {
  const reasons = c.reasons.map((r, i) => `<div class="why-row">
          <span class="why-n display">${String(i + 1).padStart(2, "0")}</span>
          <div class="why-tx"><div class="why-h">${esc(r.head)}</div><div class="why-b">${esc(r.insight)}</div></div>
        </div>`).join("\n        ");
  const cobrand = `<div class="why-cobrand">
      ${c.brand.logo
        ? `<span class="logo-chip"><img class="brand-logo" src="${esc(c.brand.logo)}" alt="${esc(c.brand.name)}"></span>`
        : `<span class="brand-namemark">${esc(c.brand.name)}</span>`}
      <span class="cobrand-x">&times;</span>
      ${NOMILA_MARK}
    </div>`;
  return `<section class="card panel c-why" aria-label="Why she fits ${esc(c.brand.name)}">
    ${libBackdrop(c.bg)}
    <div class="card-inner">
      ${cobrand}
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <h2 class="display why-lead">${esc(c.lead)}</h2>
      <div class="why-list">
        ${reasons}
      </div>
      <div class="why-foot">${esc(c.brand.name)}${c.brand.category ? ` &middot; ${esc(c.brand.category)}` : ""}${c.confidence.level === "inferred" ? " &middot; inferred from public signals" : ""}</div>
    </div>
  </section>`;
}

function storyCard(c: Extract<AnyCard, { type: "story" }>): string {
  const beats = c.beats.map((b) => `<div class="beat${b.current ? " now" : ""}">
          <span class="beat-yr">${esc(b.year)}</span>
          <div class="beat-tx"><div class="beat-where">${esc(b.where)}</div><div class="beat-line">${esc(b.line)}</div></div>
        </div>`).join("\n        ");
  return `<section class="card panel c-story" aria-label="The story">
    ${libBackdrop(c.bg)}
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <div class="story-rail">
        ${beats}
      </div>
      <p class="story-close display">${esc(c.close)}</p>
    </div>
  </section>`;
}

function valuesCard(c: Extract<AnyCard, { type: "values" }>): string {
  const planks = c.planks.map((p) => `<div class="plank"><span class="plank-n">${esc(p.name)}</span>${p.line ? `<span class="plank-l">${esc(p.line)}</span>` : ""}</div>`).join("\n        ");
  return `<section class="card panel c-vals" aria-label="What she stands for">
    ${libBackdrop(c.bg)}
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <h2 class="display vals-statement">${esc(c.statement)}</h2>
      <div class="planks">
        ${planks}
      </div>
      <p class="vals-note">${esc(c.note)}</p>
      ${c.confidence.level === "self_reported" ? `<div class="prov">Self-declared &mdash; the athlete&rsquo;s own words, not a Nomila claim.</div>` : ""}
    </div>
  </section>`;
}

function achievementsCard(c: Extract<AnyCard, { type: "achievements" }>): string {
  const rows = c.entries.map((e) => `<div class="ach-row"><span class="ach-yr">${esc(e.year)}</span><span class="ach-nm">${esc(e.name)}</span>${e.level ? `<span class="ach-lv">${esc(e.level)}</span>` : ""}</div>`).join("\n        ");
  return `<section class="card panel c-ach" aria-label="The record">
    ${libBackdrop(c.bg)}
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <div class="ach-hero">
        ${c.heroEntry.badge ? `<span class="chip red ach-badge">${esc(c.heroEntry.badge)}</span>` : ""}
        <div class="ach-hname display">${esc(c.heroEntry.name)}</div>
        <div class="ach-hmeta">${[esc(c.heroEntry.year), esc(c.heroEntry.detail)].filter(Boolean).join(" &middot; ")}</div>
      </div>
      <div class="ach-rows">
        ${rows}
      </div>
      <p class="ach-foot">${esc(c.footnote)}</p>
    </div>
  </section>`;
}

// ── Brand creative cards (PITCH_CONCEPT_V1): the concept, the signature idea and the year-round calendar, in the
//    broadcast idiom (panel + photo backdrop, kicker, Anton display, chips, the why-list). A Broadcast pitch shows them
//    instead of dropping them (23 Oct 2026, when Broadcast became a recommended pitch look). ──
function ideaCard(
  c: { eyebrow: string; title: string; line: string; lineEmphasis: string; facets: string[]; note: string },
  image: string | null | undefined, brand: { name: string; logo?: string | null } | null, label: string,
): string {
  const facets = c.facets.map((f) => `<span class="chip">${esc(f)}</span>`).join("");
  const cobrand = brand ? `<div class="why-cobrand">
      ${brand.logo ? `<span class="logo-chip"><img class="brand-logo" src="${esc(brand.logo)}" alt="${esc(brand.name)}"></span>` : `<span class="brand-namemark">${esc(brand.name)}</span>`}
      <span class="cobrand-x">&times;</span>
      ${NOMILA_MARK}
    </div>` : "";
  return `<section class="card panel c-why c-idea" aria-label="${label} — ${esc(c.title)}">
    ${libBackdrop(image)}
    <div class="card-inner">
      ${cobrand}
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <h2 class="display why-lead">${esc(c.title)}</h2>
      <p class="idea-line">${esc(c.line)} <em>${esc(c.lineEmphasis)}</em></p>
      ${facets ? `<div class="cats">${facets}</div>` : ""}
      ${c.note ? `<div class="why-foot">${esc(c.note)}</div>` : ""}
    </div>
  </section>`;
}

function activationPlanCard(c: Extract<AnyCard, { type: "activationPlan" }>): string {
  const rows = c.buckets.map((b, i) => `<div class="why-row">
          <span class="why-n display">${String(i + 1).padStart(2, "0")}</span>
          <div class="why-tx"><div class="why-h">${esc(b.label)} <span class="ap-aud">${esc(b.audience)}</span></div><div class="why-b">${esc(b.line)}</div></div>
        </div>`).join("");
  return `<section class="card panel c-why" aria-label="All year — ${esc(c.lead)}">
    ${libBackdrop(c.brandImage ?? c.bg)}
    <div class="card-inner">
      <div class="kicker"><i></i>${esc(c.eyebrow)}</div>
      <h2 class="display why-lead">${esc(c.lead)}</h2>
      <div class="why-list">
        ${rows}
      </div>
      <div class="why-foot">${esc(c.close)}</div>
    </div>
  </section>`;
}

// Render in DECK order (mirrors kitRenderer.renderCampaign) — cards not listed in kit.deck are the
// "library" (assembled but not shown by default); falls back to raw card order if deck is absent.
function deckOrder(kit: Kit): string[] {
  return kit.deck?.length ? kit.deck : kit.cards.map((c) => c.id);
}

function renderDeck(kit: Kit): string {
  const firstName = kit.identity.name.split(" ")[0] || kit.identity.name;
  const byId = new Map(kit.cards.map((c) => [c.id, c]));
  return deckOrder(kit).map((id) => {
    const c = byId.get(id);
    if (!c) return "";
    switch (c.type) {
      case "cover":        return coverCard(c);
      case "index":        return indexCard(c);
      case "audience":     return audienceCard(c);
      case "content":      return contentCard(c);
      case "video":        return videoCard(c);
      case "whyFits":      return whyFitsCard(c);
      case "story":        return storyCard(c);
      case "values":       return valuesCard(c);
      case "achievements": return achievementsCard(c);
      case "fit":          return fitCard(c);
      case "campaignConcept": return ideaCard(c, c.image ?? c.brandImage ?? null, c.brand, "Campaign concept");
      case "signatureIdea":   return ideaCard(c, c.image, null, "The idea");
      case "activationPlan":  return activationPlanCard(c);
      default:             return "";
    }
  }).join("\n\n  ");
}

// Share pitch built from identity + key stats (wired into the prototype's share button, like campaign).
function shareTitle(kit: Kit): string {
  return `${kit.identity.name} — NIL Media Kit`;
}
function shareText(kit: Kit): string {
  const cover = kit.cards.find((c) => c.type === "cover") as Extract<AnyCard, { type: "cover" }> | undefined;
  const index = kit.cards.find((c) => c.type === "index") as Extract<AnyCard, { type: "index" }> | undefined;
  const meta = cover?.meta || [kit.identity.sport, kit.identity.school].filter(Boolean).join(" · ");
  const lines = [
    `${kit.identity.name} · ${meta}.`,
    cover?.stats?.length ? cover.stats.map((s) => `${s.value} ${String(s.label).toLowerCase()}`).join(", ") + "." : null,
    index ? `Nomila M.I.A. ${index.value}/${index.max}.` : null,
    "Full kit:",
  ].filter(Boolean);
  return lines.join(" ");
}

export function renderBroadcast(kit: MediaKitData): string {
  const accent = kit.tokens?.accent ?? "#D8FF3E";
  const order = deckOrder(kit);
  const bars = order.map(() => "<b></b>").join("");
  const share = { title: shareTitle(kit), text: shareText(kit) };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(kit.identity.name)} — NIL Media Kit · Nomila</title>
<style>
${CSS}
</style>
</head>
<body data-palette="${esc(accent)},#E4002B">

<div class="page-tag"><i></i>NOMILA · ATHLETE MEDIA KIT<i></i></div>

<div class="stage" id="stage">

  <div class="progress" id="progress" aria-hidden="true">${bars}</div>

  ${renderDeck(kit)}

  <div class="actions" id="actions">
    <button class="abtn" id="btnPrev" type="button" aria-label="Previous card">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button class="abtn" id="btnMail" type="button" aria-label="Share by email">
      <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1"/><polyline points="3 7 12 13 21 7"/></svg>
    </button>
    <button class="abtn share" id="btnShare" type="button" aria-label="Share this kit">
      <svg viewBox="0 0 24 24"><path d="M12 3v13"/><polyline points="6 9 12 3 18 9"/><path d="M5 21h14"/></svg>
    </button>
    <button class="abtn" id="btnSms" type="button" aria-label="Share by text message">
      <svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>
    </button>
    <button class="abtn" id="btnNext" type="button" aria-label="Next card">
      <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  </div>

  <div class="toast" id="toast" role="status"><i></i><span id="toastMsg"></span></div>
</div>

<div class="page-hint">Swipe, tap the edges, or use arrow keys · ${order.length} cards</div>

<script>
var __SHARE__ = ${JSON.stringify(share)};
${SCRIPT}
</script>
</body>
</html>`;
}

// ── Verbatim design from the broadcast prototype (nomila-kit-broadcast.html) ──────────
// id-scoped #c1..#c7 selectors rewritten to type classes (.k-cover .k-index .k-mix .k-aud .k-tape
// .k-rates .k-fit) + a broadcast-styled .k-video; the index meter fill and the commercial bar,
// hard-coded in the prototype, are driven from inline --v vars set by the renderers above.
const CSS = String.raw`@import url('https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600&display=swap');

/* ============ TOKENS ============ */
:root{
  --ink:      #0B0C10;   /* pitch black */
  --panel:    #14161D;   /* card panel */
  --panel-2:  #1B1E27;
  --paper:    #F2EFE6;   /* chalk white */
  --bone:     #F2EFE6;   /* alias for the Nomila mark */
  --mut:      rgba(242,239,230,.60);
  --faint:    rgba(242,239,230,.34);
  --line:     rgba(242,239,230,.14);
  --volt:     #D8FF3E;   /* scoreboard volt */
  --volt-dim: rgba(216,255,62,.16);
  --red:      #E4002B;   /* matchday cardinal */
  --red-deep: #8E0F22;
  --track:    rgba(242,239,230,.10);
  --shadow:   0 30px 60px -18px rgba(0,0,0,.75);
  /* type scale */
  --t-tag: 11px; --t-body: 13px; --t-lead: 15px; --t-sub: 21px;
  --t-h: 30px; --t-d1: 46px; --t-d2: 66px; --t-mega: 132px;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{
  background:#07080B;
  background-image:
    linear-gradient(rgba(242,239,230,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(242,239,230,.028) 1px, transparent 1px);
  background-size:44px 44px;
  color:var(--paper);
  font-family:'Barlow',system-ui,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;min-height:100vh;overflow-x:hidden;padding:24px 0;
}
.page-tag{
  font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--t-tag);
  letter-spacing:.32em;text-transform:uppercase;color:var(--faint);
  display:flex;align-items:center;gap:10px;
}
.page-tag i{display:inline-block;width:22px;height:2px;background:var(--red);transform:skewX(-24deg)}
.page-hint{font-size:12px;color:var(--faint);letter-spacing:.04em}

/* ============ STAGE ============ */
.stage{
  position:relative;width:354px;height:618px;
  touch-action:pan-y;user-select:none;-webkit-user-select:none;
}
@media (max-height:730px){ .stage{transform:scale(.92);transform-origin:center} }

/* ============ CARDS ============ */
.card{
  position:absolute;inset:0;overflow:hidden;background:var(--ink);
  clip-path:polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px));
  box-shadow:var(--shadow);
  transition:transform .5s cubic-bezier(.22,.68,.26,1), opacity .4s ease;
  will-change:transform;
}
.card.dragging{transition:none}
.card.is-active{z-index:5}
.card.is-past{transform:translateX(-120%) rotate(-7deg);opacity:0;z-index:6;pointer-events:none}
.card.is-next{transform:translateY(14px) scale(.955);opacity:.85;z-index:3;pointer-events:none;filter:brightness(.5)}
.card.is-far{transform:translateY(14px) scale(.955);opacity:0;z-index:1;pointer-events:none}
@keyframes cardbounce{0%,100%{transform:translateX(0)}35%{transform:translateX(-12px)}70%{transform:translateX(7px)}}
.card.bounce{animation:cardbounce .32s ease}

/* subtle diagonal texture on panel cards */
.card.panel{
  background:
    repeating-linear-gradient(115deg, transparent 0 9px, rgba(242,239,230,.022) 9px 10px),
    linear-gradient(180deg,#101218 0%, #0B0C10 70%);
}

/* ============ PROGRESS (story bars) ============ */
.progress{
  position:absolute;top:12px;left:14px;right:14px;z-index:20;
  display:flex;gap:5px;
}
.progress b{
  flex:1;height:3px;background:rgba(242,239,230,.22);cursor:pointer;
  transform:skewX(-24deg);position:relative;overflow:hidden;
}
.progress b::after{
  content:"";position:absolute;inset:0;background:var(--paper);
  transform:scaleX(0);transform-origin:left;transition:transform .3s ease;
}
.progress b.on::after{transform:scaleX(1)}
.progress b.now::after{background:var(--volt)}

/* ============ TAP HINT EDGES ============ */
.card-inner{position:absolute;inset:0;display:flex;flex-direction:column}

/* ============ SHARED PIECES ============ */
.kicker{
  font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--t-tag);
  letter-spacing:.30em;text-transform:uppercase;color:var(--mut);
  display:flex;align-items:center;gap:8px;
}
.kicker i{width:16px;height:2px;background:var(--volt);transform:skewX(-24deg);flex:none}
.kicker.red i{background:var(--red)}
.display{font-family:'Anton','Arial Narrow',sans-serif;font-weight:400;line-height:.92;text-transform:uppercase}
.num{font-variant-numeric:tabular-nums;letter-spacing:.01em}
.cond{font-family:'Barlow Condensed',sans-serif}
.chip{
  display:inline-flex;align-items:center;gap:6px;
  font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;
  letter-spacing:.18em;text-transform:uppercase;
  padding:5px 12px 4px;color:var(--ink);background:var(--volt);
  clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);
}
.chip.red{background:var(--red);color:var(--paper)}
.chip.ghost{background:transparent;color:var(--mut);box-shadow:inset 0 0 0 1px var(--line)}
.slashline{height:3px;background:repeating-linear-gradient(-65deg,var(--red) 0 8px,transparent 8px 15px)}

/* stat bars */
.bar-row{display:grid;grid-template-columns:1fr 56px;gap:0 10px;align-items:end}
.bar-name{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:14px;letter-spacing:.10em;text-transform:uppercase}
.bar-tier{font-family:'Barlow Condensed',sans-serif;font-weight:500;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--mut)}
.bar-val{font-family:'Anton',sans-serif;font-size:26px;line-height:1;text-align:right;font-variant-numeric:tabular-nums}
.bar-track{grid-column:1 / -1;height:8px;background:var(--track);margin-top:6px;transform:skewX(-24deg);overflow:hidden}
.bar-fill{height:100%;background:var(--volt);transform:scaleX(0);transform-origin:left;transition:transform .9s cubic-bezier(.2,.7,.2,1) .15s}
.is-live .bar-fill{transform:scaleX(var(--v))}
/* commercial "wide-open" row — dashed, no fill */
.bar-row.open .bar-track{background:none;overflow:visible;box-shadow:inset 0 0 0 1.5px var(--red);border-radius:1px}
.bar-row.open .bar-val{color:var(--red)}
.bar-row.open .bar-tier{color:var(--red)}

/* photo helpers */
.ph{width:100%;height:100%;object-fit:cover;display:block}
.duo{filter:grayscale(1) contrast(1.12) brightness(.92)}

/* ============ CARD 1 · COVER ============ */
.k-cover .hero{position:absolute;inset:0}
.k-cover .hero img{width:100%;height:100%;object-fit:cover;object-position:top center}
.k-cover .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,12,16,.66) 0%,rgba(11,12,16,.14) 22%,rgba(11,12,16,.24) 40%,rgba(11,12,16,.74) 60%,rgba(11,12,16,.95) 80%,#0B0C10 100%)}
.k-cover .top{position:absolute;top:30px;left:18px;right:18px;display:flex;justify-content:space-between;align-items:center}
.k-cover .wordmark{display:flex;align-items:center;gap:9px}
.k-cover .wordmark .nomila-mark{width:26px;height:26px;flex:none}
.k-cover .cardmark-label{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--paper);text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-cover .kit-tag{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:10px;letter-spacing:.26em;text-transform:uppercase;color:var(--paper);background:rgba(11,12,16,.55);padding:4px 9px 3px;box-shadow:inset 0 0 0 1px var(--line)}
.k-cover .name-block{position:absolute;left:18px;right:18px;bottom:178px}
.k-cover .name{font-size:74px;position:relative;z-index:1;text-shadow:0 2px 20px rgba(0,0,0,.6),0 1px 3px rgba(0,0,0,.5)}
.k-cover .name .row2{color:var(--volt);display:inline-block;position:relative}
.k-cover .name .row2::after{content:"";position:absolute;left:-6px;right:-14px;top:54%;height:14px;background:var(--red);transform:skewX(-24deg);z-index:-1}
.k-cover .lower-third{
  position:absolute;left:0;right:34px;bottom:130px;background:var(--red);
  clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);
  padding:8px 22px 7px 18px;
  font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--paper);
  display:flex;gap:10px;align-items:baseline;
}
.k-cover .lower-third span{opacity:.55;font-weight:500}
.k-cover .hook{position:absolute;left:18px;right:26px;bottom:88px;font-size:var(--t-lead);line-height:1.4;color:var(--paper);font-weight:500;text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-cover .hook b{color:var(--volt);font-weight:600}
/* ticker */
.ticker{position:absolute;left:0;right:0;bottom:0;height:30px;background:#0B0C10;border-top:1px solid var(--line);overflow:hidden;display:flex;align-items:center}
.ticker-inner{display:flex;white-space:nowrap;animation:tick 26s linear infinite}
.ticker-inner span{
  font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:12px;
  letter-spacing:.20em;text-transform:uppercase;color:var(--mut);padding:0 14px;
  font-variant-numeric:tabular-nums;
}
.ticker-inner span b{color:var(--volt);font-weight:700}
.ticker-inner span i{color:var(--red);font-style:normal;padding-right:14px}
@keyframes tick{to{transform:translateX(-50%)}}

/* ============ CARD 2 · INDEX ============ */
.k-index .card-inner{padding:52px 22px 100px}
.k-index .matchup{margin-top:22px;font-family:'Barlow Condensed',sans-serif;font-weight:500;font-size:14px;letter-spacing:.06em;color:var(--mut)}
.k-index .mega-wrap{margin-top:auto}
.k-index .mega{font-size:var(--t-mega);color:var(--volt);display:flex;align-items:baseline;gap:10px}
.k-index .mega .den{font-size:34px;color:var(--faint)}
.k-index .tier-line{display:flex;align-items:center;gap:12px;margin:14px 0 30px}
.k-index .tier-line .lbl{font-family:'Barlow Condensed',sans-serif;font-weight:500;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--mut)}
.k-index .meter{position:relative;height:14px;background:var(--track);transform:skewX(-24deg);overflow:hidden}
.k-index .meter::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 1px),rgba(11,12,16,.9) calc(10% - 1px) 10%)}
.k-index .meter-fill{position:absolute;inset:0;background:linear-gradient(90deg,var(--red-deep),var(--red) 55%,var(--volt));transform:scaleX(0);transform-origin:left;transition:transform 1.1s cubic-bezier(.2,.7,.2,1) .2s}
.k-index.is-live .meter-fill{transform:scaleX(var(--v,0))}
.k-index .meter-scale{display:flex;justify-content:space-between;margin-top:8px;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:.14em;color:var(--faint);font-variant-numeric:tabular-nums}
.k-index .foot{margin-top:26px;font-size:var(--t-body);line-height:1.55;color:var(--mut);max-width:270px}
.k-index .bug{position:absolute;right:-38px;top:96px;font-family:'Anton',sans-serif;font-size:150px;color:transparent;-webkit-text-stroke:1px rgba(242,239,230,.09);transform:rotate(90deg);letter-spacing:.04em;pointer-events:none}

/* ============ CARD 3 · THE MIX ============ */
.k-mix .card-inner{padding:52px 22px 100px}
.k-mix h2{font-size:var(--t-d1);margin-top:10px}
.k-mix h2 em{font-style:normal;color:var(--volt)}
.k-mix .rows{margin-top:26px;display:flex;flex-direction:column;gap:19px}
.k-mix .inset{position:absolute;top:44px;right:-6px;width:104px;height:128px;clip-path:polygon(14px 0,100% 0,100% 100%,0 100%,0 14px);box-shadow:inset 0 0 0 1px var(--line);opacity:.9;overflow:hidden}
.k-mix .inset::after{content:"";position:absolute;inset:0;background:linear-gradient(160deg,rgba(228,0,43,.32),rgba(11,12,16,.25))}
.k-mix .note{margin-top:auto;padding:11px 14px;background:var(--volt-dim);border-left:3px solid var(--volt);font-size:12.5px;line-height:1.5;color:var(--paper)}
.k-mix .note b{color:var(--volt)}

/* ============ CARD 4 · AUDIENCE ============ */
.k-aud .card-inner{padding:52px 22px 100px}
.k-aud .hero-stat{margin-top:20px;display:flex;align-items:baseline;gap:12px}
.k-aud .hero-stat .n{font-family:'Anton',sans-serif;font-size:96px;line-height:.9;color:var(--paper);font-variant-numeric:tabular-nums}
.k-aud .hero-stat .n small{font-size:44px;color:var(--volt)}
.k-aud .hero-cap{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:16px;letter-spacing:.10em;text-transform:uppercase;line-height:1.25;color:var(--paper)}
.k-aud .hero-cap span{display:block;color:var(--mut);font-weight:500;font-size:13px;letter-spacing:.16em}
.k-aud .follow-strip{display:flex;align-items:stretch;gap:1px;margin:22px 0 24px;background:var(--line)}
.k-aud .follow-strip>div{flex:1;background:var(--panel);padding:10px 12px}
.k-aud .follow-strip .big{background:var(--panel-2)}
.k-aud .fs-n{font-family:'Anton',sans-serif;font-size:24px;font-variant-numeric:tabular-nums}
.k-aud .fs-l{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:10px;letter-spacing:.20em;text-transform:uppercase;color:var(--mut);margin-top:3px}
.k-aud .geo{display:flex;flex-direction:column;gap:10px}
.k-aud .geo-row{display:grid;grid-template-columns:52px 1fr 44px;gap:10px;align-items:center}
.k-aud .geo-name{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:13px;letter-spacing:.14em;text-transform:uppercase}
.k-aud .geo-track{height:7px;background:var(--track);transform:skewX(-24deg);overflow:hidden}
.k-aud .geo-fill{height:100%;background:var(--volt);transform:scaleX(0);transform-origin:left;transition:transform .9s cubic-bezier(.2,.7,.2,1) .2s}
.k-aud.is-live .geo-fill{transform:scaleX(var(--v))}
.k-aud .geo-row.other .geo-fill{background:var(--faint)}
.k-aud .geo-row.other .geo-name,.k-aud .geo-row.other .geo-val{color:var(--faint)}
.k-aud .geo-val{font-family:'Anton',sans-serif;font-size:16px;text-align:right;font-variant-numeric:tabular-nums}

/* ============ CARD 5 · THE TAPE ============ */
.k-tape .card-inner{padding:52px 18px 100px}
.k-tape .tiles{margin-top:16px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto auto;gap:8px;flex:1;min-height:0}
.k-tape .tile{position:relative;overflow:hidden;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%);background:var(--panel)}
.k-tape .tile.main{grid-column:1 / -1;height:236px}
.k-tape .tile.sub{height:132px}
.k-tape .tile img{width:100%;height:100%;object-fit:cover;object-position:top center}
.k-tape .tile .veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,12,16,0) 16%,rgba(11,12,16,.30) 46%,rgba(11,12,16,.74) 74%,rgba(11,12,16,.96) 100%)}
.k-tape .tile .stat{position:absolute;left:12px;bottom:10px;right:12px}
.k-tape .tile .v{font-family:'Anton',sans-serif;line-height:.95;color:var(--volt);font-variant-numeric:tabular-nums;text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.5)}
.k-tape .tile.main .v{font-size:56px}
.k-tape .tile.sub .v{font-size:30px}
.k-tape .tile .l{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--paper);margin-top:2px;text-shadow:0 1px 10px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-tape .tile .flag{position:absolute;top:0;left:0;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.20em;text-transform:uppercase;background:var(--red);color:var(--paper);padding:4px 10px 3px;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%)}
.k-tape .tape-note{margin-top:12px;padding:0 4px;font-family:'Barlow',sans-serif;font-size:12px;line-height:1.5;color:var(--mut)}
.k-tape .substrip{display:flex;gap:14px;margin-top:9px;justify-content:space-between}
.k-tape .substrip div{font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-variant-numeric:tabular-nums}
.k-tape .substrip b{color:var(--paper);font-weight:700;padding-right:3px}

/* ============ CARD · IN MOTION (video) ============ */
.k-video .bg-vid{position:absolute;inset:0;overflow:hidden}
.k-video .bg-vid video{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
.k-video .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,12,16,.55) 0%,rgba(11,12,16,.12) 30%,rgba(11,12,16,.5) 58%,rgba(11,12,16,.95) 84%,#0B0C10 100%)}
.k-video .live-dot{position:absolute;top:30px;right:20px;z-index:7;width:11px;height:11px;border-radius:50%;background:var(--red);box-shadow:0 0 0 0 rgba(228,0,43,.6);animation:vidpulse 2s ease-out infinite}
@keyframes vidpulse{0%{box-shadow:0 0 0 0 rgba(228,0,43,.6)}70%{box-shadow:0 0 0 12px rgba(228,0,43,0)}100%{box-shadow:0 0 0 0 rgba(228,0,43,0)}}
.k-video .card-inner.vid-inner{justify-content:flex-end;padding:52px 22px 100px}
.k-video .kicker{text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-video .vid-note{margin-top:12px;font-size:var(--t-lead);line-height:1.4;color:var(--paper);font-weight:500;text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}

/* ============ CARD 6 · RATE CARD ============ */
.k-rates .card-inner{padding:52px 22px 100px}
.k-rates .proj{margin-top:18px}
.k-rates .proj .n{font-family:'Anton',sans-serif;font-size:104px;line-height:.9;color:var(--paper);font-variant-numeric:tabular-nums}
.k-rates .proj .n small{font-size:48px;color:var(--volt)}
.k-rates .proj .cap{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut);margin-top:6px}
.k-rates .range{position:relative;height:10px;background:var(--track);margin:20px 0 6px;transform:skewX(-24deg)}
.k-rates .range-fill{position:absolute;left:0;top:0;bottom:0;width:100%;background:linear-gradient(90deg,var(--red-deep),var(--red))}
.k-rates .range-pin{position:absolute;left:50%;top:-4px;bottom:-4px;width:4px;background:var(--volt)}
.k-rates .range-scale{display:flex;justify-content:space-between;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:.14em;color:var(--faint);font-variant-numeric:tabular-nums;margin-bottom:22px}
.k-rates .range-scale .mid{color:var(--volt);font-weight:700}
.k-rates .rates{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);box-shadow:0 0 0 1px var(--line)}
.k-rates .rate{background:var(--panel);padding:13px 14px 12px;position:relative}
.k-rates .rate .rn{font-family:'Anton',sans-serif;font-size:29px;font-variant-numeric:tabular-nums}
.k-rates .rate .rn i{font-style:normal;font-family:'Barlow Condensed',sans-serif;font-size:13px;color:var(--mut);letter-spacing:.06em}
.k-rates .rate .rl{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:11px;letter-spacing:.20em;text-transform:uppercase;color:var(--mut);margin-top:4px}
.k-rates .rate::before{content:"";position:absolute;top:0;left:0;width:18px;height:3px;background:var(--red)}
.k-rates .rate.hot::before{background:var(--volt)}
.k-rates .rate-foot{margin-top:auto;font-size:12.5px;line-height:1.55;color:var(--mut)}

/* ============ CARD 7 · THE FIT ============ */
.k-fit .bg{position:absolute;inset:0}
.k-fit .bg img{width:100%;height:100%;object-fit:cover;object-position:top center;filter:grayscale(.4) contrast(1.05)}
.k-fit .bg::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,12,16,.72) 0%,rgba(11,12,16,.52) 30%,rgba(11,12,16,.72) 54%,rgba(11,12,16,.96) 78%,#0B0C10 100%)}
.k-fit .card-inner{padding:52px 22px 104px;position:relative}
.k-fit .kicker{text-shadow:0 1px 12px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-fit h2{font-size:56px;margin-top:8px;text-shadow:0 2px 20px rgba(0,0,0,.6),0 1px 3px rgba(0,0,0,.5)}
.k-fit h2 em{font-style:normal;color:var(--volt)}
.k-fit .cats{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.k-fit .why{margin-top:auto;display:flex;flex-direction:column;gap:9px}
.k-fit .why div{display:flex;gap:10px;align-items:baseline;font-size:13.5px;line-height:1.45;color:var(--paper);text-shadow:0 1px 10px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}
.k-fit .why i{flex:none;width:14px;height:2px;background:var(--volt);transform:skewX(-24deg) translateY(-3px)}
.k-fit .why b{font-variant-numeric:tabular-nums}
.k-fit .cta{margin-top:18px;display:flex;align-items:center;gap:12px}
.k-fit .cta-btn{
  flex:1;font-family:'Anton',sans-serif;font-size:19px;letter-spacing:.08em;text-transform:uppercase;
  background:var(--volt);color:var(--ink);border:0;padding:15px 10px 13px;cursor:pointer;
  clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);
  transition:transform .15s ease;
}
.cta-btn:active{transform:scale(.97)}
.k-fit .cta-sub{font-family:'Barlow Condensed',sans-serif;font-weight:500;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);text-align:center;margin-top:10px;text-shadow:0 1px 10px rgba(0,0,0,.6),0 1px 2px rgba(0,0,0,.45)}

/* ============ ACTION ROW ============ */
.actions{
  position:absolute;left:0;right:0;bottom:14px;z-index:22;
  display:flex;align-items:center;justify-content:center;gap:13px;
}
.abtn{
  width:44px;height:44px;border-radius:50%;border:1px solid var(--line);
  background:rgba(11,12,16,.72);backdrop-filter:blur(6px);color:var(--paper);
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  transition:transform .15s ease,border-color .15s ease,color .15s ease;
}
.abtn:hover{border-color:var(--volt);color:var(--volt)}
.abtn:active{transform:scale(.9)}
.abtn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.abtn.share{
  width:66px;height:66px;background:var(--volt);border:none;color:var(--ink);
  box-shadow:0 8px 26px -6px rgba(216,255,62,.5), 0 0 0 5px rgba(216,255,62,.12);
}
.abtn.share:hover{color:var(--ink);transform:scale(1.06)}
.abtn.share:active{transform:scale(.94)}
.abtn.share svg{width:26px;height:26px;stroke-width:2.2}
.abtn[disabled]{opacity:.28;pointer-events:none}

/* ============ TOAST ============ */
.toast{
  position:absolute;left:20px;right:20px;bottom:96px;z-index:30;
  background:var(--paper);color:var(--ink);padding:11px 15px;
  clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);
  font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:14px;letter-spacing:.05em;
  display:flex;align-items:center;gap:9px;
  opacity:0;transform:translateY(10px);pointer-events:none;
  transition:opacity .25s ease,transform .25s ease;
}
.toast.show{opacity:1;transform:translateY(0)}
.toast i{flex:none;width:10px;height:10px;background:var(--red);transform:skewX(-24deg);font-style:normal}

/* ============ REDUCED MOTION ============ */
@media (prefers-reduced-motion: reduce){
  .card,.bar-fill,.k-index .meter-fill,.k-aud .geo-fill,.progress b::after,.abtn,.toast{transition:none !important}
  .ticker-inner{animation:none}
  .card.bounce{animation:none}
  .is-live .bar-fill{transform:scaleX(var(--v))}
}

/* ============ CARD LIBRARY (payments / whyFits / story / values / achievements) ============ */
/* .panel already gives the diagonal texture — the photo-less state. A signed bg layers a full-bleed
   photo + scrim UNDER .card-inner so it reads as image-led, matching the panel cards' own idiom. */
.lib-bg{position:absolute;inset:0;overflow:hidden;z-index:0}
.lib-bg img{width:100%;height:100%;object-fit:cover;object-position:50% 20%;filter:grayscale(.3) contrast(1.1) brightness(.82)}
.rings-wm{position:absolute;right:-118px;top:-96px;width:330px;height:330px;z-index:0;pointer-events:none}
.lib-scrim{position:absolute;inset:0;z-index:0;background:linear-gradient(180deg, rgba(11,12,16,.5) 0%, rgba(11,12,16,.30) 28%, rgba(11,12,16,.88) 74%, #0B0C10 100%)}
.c-pay .card-inner,.c-why .card-inner,.c-story .card-inner,.c-vals .card-inner,.c-ach .card-inner{padding:52px 22px 100px;position:relative;z-index:1}

/* payments — "Book Her" */
.pay-lead{font-size:32px;margin-top:12px;max-width:280px}
.pkgs{margin-top:20px;display:flex;flex-direction:column}
.pkg{position:relative;display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--line);padding:12px 8px 12px 6px;cursor:pointer;color:var(--paper);font-family:'Barlow',sans-serif;transition:background .18s ease}
.pkg:last-of-type{border-bottom:1px solid var(--line)}
.pkg::before{content:"";position:absolute;left:-2px;top:10px;bottom:10px;width:3px;background:transparent;transform:skewX(-24deg);transition:background .18s ease}
.pkg.sel{background:var(--volt-dim)}
.pkg.sel::before{background:var(--volt)}
.pkg-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.pkg-name{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;letter-spacing:.10em;text-transform:uppercase}
.pkg-price{font-family:'Anton',sans-serif;font-size:22px;display:flex;align-items:baseline;gap:6px}
.pkg-price i{font-style:normal;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--mut);letter-spacing:.1em}
.pkg-inc{margin-top:4px;font-size:11.5px;line-height:1.4;color:var(--mut);max-width:250px}
.pkg-flag{position:absolute;top:-8px;left:6px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9px;letter-spacing:.18em;text-transform:uppercase;padding:3px 9px;background:var(--volt);color:var(--ink);clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%)}
.pay-cta{margin-top:auto;width:100%;font-family:'Anton',sans-serif;font-size:18px;letter-spacing:.06em;text-transform:uppercase;background:var(--volt);color:var(--ink);border:none;padding:15px 10px 13px;cursor:pointer;clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);transition:transform .15s ease}
.pay-cta:active{transform:scale(.97)}
.assure{margin-top:12px;display:flex;align-items:center;gap:8px;justify-content:center;font-family:'Barlow Condensed',sans-serif;font-weight:500;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.assure i{width:14px;height:2px;background:var(--volt);transform:skewX(-24deg);flex:none}
.pay-toast{bottom:150px}

/* whyFits — "Why She Fits" */
.why-cobrand{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.why-cobrand .logo-chip{background:#fff;padding:6px 11px;display:inline-flex;align-items:center;clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);box-shadow:0 4px 14px rgba(0,0,0,.35)}
.why-cobrand .brand-logo{height:18px;max-width:100px;object-fit:contain;display:block}
.why-cobrand .brand-namemark{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;letter-spacing:.10em;text-transform:uppercase;color:var(--paper)}
.why-cobrand .cobrand-x{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:13px;color:var(--mut)}
.why-cobrand .nomila-mark{width:20px;height:20px;flex:none}
.why-lead{font-size:29px;margin-top:10px;max-width:290px}
.c-idea .card-inner{justify-content:flex-end}
.idea-line{margin-top:12px;font-size:15px;line-height:1.4;color:var(--paper)}
.idea-line em{font-style:normal;color:var(--volt)}
.c-idea .cats{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.ap-aud{margin-left:6px;font-size:10px;letter-spacing:.14em;color:var(--mut)}
.why-list{margin-top:18px;display:flex;flex-direction:column;gap:15px}
.why-row{display:flex;gap:12px;align-items:flex-start}
.why-n{font-size:15px;color:var(--volt);flex:none;width:22px;padding-top:1px}
.why-h{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12.5px;letter-spacing:.10em;text-transform:uppercase;color:var(--paper)}
.why-b{margin-top:3px;font-size:12px;line-height:1.45;color:var(--mut)}
.why-foot{margin-top:auto;padding-top:14px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}

/* story — "The Story" */
.story-rail{margin-top:18px;display:flex;flex-direction:column}
.beat{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:10px 0;border-top:1px dashed var(--line);align-items:start}
.beat:first-child{border-top:none}
.beat-yr{font-family:'Anton',sans-serif;font-size:15px;color:var(--faint)}
.beat.now .beat-yr{color:var(--volt)}
.beat-where{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut)}
.beat-line{margin-top:2px;font-size:12.5px;line-height:1.35;color:var(--paper);font-weight:500}
.story-close{margin-top:auto;padding-top:16px;font-size:23px;color:var(--volt)}

/* values — "What She Stands For" */
.vals-statement{font-size:31px;margin-top:12px}
.planks{margin-top:20px;display:flex;flex-direction:column;gap:13px}
.plank{border-left:3px solid var(--red);padding-left:12px}
.plank-n{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--paper)}
.plank-l{display:block;margin-top:3px;font-size:11px;line-height:1.4;color:var(--mut)}
.vals-note{margin-top:auto;padding-top:16px;font-size:13px;line-height:1.5;color:var(--paper);font-weight:500}
.prov{margin-top:8px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}

/* achievements — "The Record" */
.ach-hero{margin-top:16px}
.ach-badge{margin-bottom:12px}
.ach-hname{font-size:31px;line-height:.96}
.ach-hmeta{margin-top:8px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut)}
.ach-rows{margin-top:20px;display:flex;flex-direction:column}
.ach-row{display:grid;grid-template-columns:40px 1fr auto;gap:10px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line)}
.ach-row:last-child{border-bottom:1px solid var(--line)}
.ach-yr{font-family:'Anton',sans-serif;font-size:13px;color:var(--faint)}
.ach-nm{font-size:12px;font-weight:600;color:var(--paper);line-height:1.3}
.ach-lv{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.ach-foot{margin-top:auto;padding-top:14px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}`;

const SCRIPT = String.raw`(function(){
  "use strict";
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = document.getElementById('stage');
  const cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  const segs  = Array.prototype.slice.call(document.querySelectorAll('#progress b'));
  const N = cards.length;
  let idx = 0;

  /* ---------- count-up ---------- */
  function runCounts(card){
    card.querySelectorAll('[data-count]').forEach(function(el){
      if (el.dataset.done) return;
      el.dataset.done = "1";
      const target = parseFloat(el.dataset.count);
      const dec = el.dataset.fmt === 'dec1' ? 1 : 0;
      if (RM) { el.textContent = dec ? target.toFixed(1) : String(Math.round(target)); return; }
      const t0 = performance.now(), dur = 1100;
      el.textContent = dec ? "0.0" : "0";
      function frame(t){
        let p = Math.min(1, (t - t0) / dur);
        p = 1 - Math.pow(1 - p, 3); /* ease-out cubic */
        const v = target * p;
        el.textContent = dec ? v.toFixed(1) : String(Math.round(v));
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  /* ---------- render ---------- */
  function render(){
    cards.forEach(function(c, i){
      c.classList.toggle('is-active', i === idx);
      c.classList.toggle('is-past',   i <  idx);
      c.classList.toggle('is-next',   i === idx + 1);
      c.classList.toggle('is-far',    i >  idx + 1);
    });
    segs.forEach(function(s, i){
      s.classList.toggle('on',  i <= idx);
      s.classList.toggle('now', i === idx);
    });
    const active = cards[idx];
    /* trigger bar animations + counts shortly after card settles */
    window.setTimeout(function(){
      active.classList.add('is-live');
      runCounts(active);
    }, RM ? 0 : 160);
    document.getElementById('btnPrev').disabled = (idx === 0);
    document.getElementById('btnNext').disabled = (idx === N - 1);
  }

  function bounce(){
    if (RM) return;
    const c = cards[idx];
    c.classList.remove('bounce'); void c.offsetWidth;
    c.classList.add('bounce');
  }
  function next(){ if (idx < N - 1) { idx++; render(); } else bounce(); }
  function prev(){ if (idx > 0)     { idx--; render(); } else bounce(); }

  /* ---------- pointer: drag + tap zones ---------- */
  let drag = null;
  stage.addEventListener('pointerdown', function(e){
    if (e.target.closest('.actions, .progress, button, a')) return;
    drag = { x: e.clientX, dx: 0, id: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch(_){}
  });
  stage.addEventListener('pointermove', function(e){
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    if (Math.abs(drag.dx) > 4 && !RM){
      const c = cards[idx];
      c.classList.add('dragging');
      c.style.transform = 'translateX(' + drag.dx + 'px) rotate(' + (drag.dx * 0.045) + 'deg)';
    }
  });
  function endDrag(e){
    if (!drag || e.pointerId !== drag.id) return;
    const dx = drag.dx, c = cards[idx];
    c.classList.remove('dragging');
    c.style.transform = '';
    if (Math.abs(dx) > 70){
      dx < 0 ? next() : prev();
    } else if (Math.abs(dx) < 8){
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (y < r.height - 92){            /* keep clear of action row */
        x < r.width * 0.32 ? prev() : next();
      }
    }
    drag = null;
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', function(){
    if (drag){ const c = cards[idx]; c.classList.remove('dragging'); c.style.transform=''; drag = null; }
  });

  /* progress segments jump */
  segs.forEach(function(s, i){ s.addEventListener('click', function(){ idx = i; render(); }); });

  /* keyboard */
  window.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  });

  /* ---------- share / toast ---------- */
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  let toastTimer = null;
  function showToast(msg){
    toastMsg.textContent = msg;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function(){ toast.classList.remove('show'); }, 2600);
  }

  const SHARE = {
    title: (typeof __SHARE__ !== "undefined" && __SHARE__.title) ? __SHARE__.title : document.title,
    text:  (typeof __SHARE__ !== "undefined" && __SHARE__.text)  ? __SHARE__.text  : document.title,
    url: window.location.href
  };

  function copyLink(then){
    const s = SHARE.text + ' ' + SHARE.url;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).then(then, function(){ legacyCopy(s); then(); });
    } else { legacyCopy(s); then(); }
  }
  function legacyCopy(s){
    const ta = document.createElement('textarea');
    ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(_){}
    document.body.removeChild(ta);
  }
  function doShare(){
    if (navigator.share){
      navigator.share(SHARE).catch(function(){
        copyLink(function(){ showToast('Kit copied — paste into a text or email'); });
      });
    } else {
      copyLink(function(){ showToast('Kit copied — paste into a text or email'); });
    }
  }

  document.getElementById('btnShare').addEventListener('click', doShare);
  const cta = document.getElementById('ctaShare');
  if (cta) cta.addEventListener('click', doShare);
  document.getElementById('btnMail').addEventListener('click', function(){
    window.location.href = 'mailto:?subject=' + encodeURIComponent(SHARE.title) +
      '&body=' + encodeURIComponent(SHARE.text + '\n' + SHARE.url);
    showToast('Opening email with the kit attached…');
  });
  document.getElementById('btnSms').addEventListener('click', function(){
    window.location.href = 'sms:?&body=' + encodeURIComponent(SHARE.text + ' ' + SHARE.url);
    showToast('Opening messages with the kit…');
  });

  document.getElementById('btnPrev').addEventListener('click', prev);
  document.getElementById('btnNext').addEventListener('click', next);

  /* payments card — package selection + placeholder checkout toast (buttons excluded from swipe) */
  (function(){
    var pkgs = Array.prototype.slice.call(document.querySelectorAll('.pkg'));
    var bl = document.getElementById('bookLabel');
    pkgs.forEach(function(p){ p.addEventListener('click', function(){
      pkgs.forEach(function(q){ q.classList.remove('sel'); q.setAttribute('aria-checked','false'); });
      p.classList.add('sel'); p.setAttribute('aria-checked','true');
      if (bl) bl.innerHTML = 'Book ' + p.getAttribute('data-name') + ' &mdash; ' + p.getAttribute('data-price');
    }); });
    var bb = document.getElementById('bookBtn'), pt = document.getElementById('payToast'), ptt = null;
    if (bb && pt) bb.addEventListener('click', function(){ pt.classList.add('show'); clearTimeout(ptt); ptt = setTimeout(function(){ pt.classList.remove('show'); }, 2600); });
  })();

  /* ticker: duplicate content for a seamless loop */
  const tk = document.getElementById('ticker');
  if (tk) tk.innerHTML += tk.innerHTML;

  render();
})();`;
