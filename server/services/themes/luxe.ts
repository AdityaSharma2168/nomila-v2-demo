/**
 * luxe — the "luxe Nomi Card" theme, productionized. The prototype (nomila-kit-luxe-v2.html) IS the
 * design: its couture CSS, card markup, and swipe/tap/keyboard/share JS are kept faithful and
 * verbatim (String.raw below); only the per-card *content* is generated from `MediaKitData` instead
 * of the prototype's hardcoded values. Same data contract as the campaign renderer
 * (kitRenderer.renderCampaign) — cover, index, mix, audience, content, [video], rates, fit.
 *
 * Self-contained by design: its own esc()/photo()/clamp() helpers + the full luxe CSS/JS. The only
 * import is the MediaKitData type. Returns a complete standalone HTML document.
 */
import type { MediaKitData } from "../mediaKitService";

type Kit = MediaKitData;
type AnyCard = Kit["cards"][number];

// The official Nomila mark (four concentric arcs — the facets). Reused from kitRenderer; the faint
// tracks are re-inked to the luxe ivory (--ivory) so the mark reads on the noir card.
const NOMILA_MARK = `<svg class="nomila-mark" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <circle cx="56" cy="56" r="50" stroke="#F4EEE2" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="38" stroke="#F4EEE2" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="26" stroke="#F4EEE2" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="14" stroke="#F4EEE2" stroke-width="4" stroke-opacity="0.14"/>
    <path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0" stroke="#2D8EFF" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke="#2DC87C" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke="#E84591" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0" stroke="#E8A215" stroke-width="5" stroke-linecap="round" fill="none"/>
  </svg>`;

// The faint rings watermark (owner, 23 Oct 2026: every look carries the Nomila mark treatment): the mark's four
// tracks in the luxe champagne, top-right on the text-led cards, under the content and over the photo plate.
const RINGS_WM = `<svg class="rings-wm" viewBox="0 0 112 112" fill="none" aria-hidden="true"><circle cx="56" cy="56" r="50" stroke="#D3B07A" stroke-width="1.4" stroke-opacity="0.22"/><circle cx="56" cy="56" r="38" stroke="#D3B07A" stroke-width="1.4" stroke-opacity="0.22"/><circle cx="56" cy="56" r="26" stroke="#D3B07A" stroke-width="1.4" stroke-opacity="0.22"/><circle cx="56" cy="56" r="14" stroke="#D3B07A" stroke-width="1.4" stroke-opacity="0.22"/></svg>`;

// ── helpers (self-contained) ────────────────────────────────────────────────────
const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, isFinite(n) ? n : 0));

// The luxe card "plate": full-bleed photo (already-signed URL, or photo-less over the noir card)
// wrapped in the couture grade / sheen sweep / hairline frame. heavyGrade darkens for the closer.
function photo(url: string | null | undefined, alt: string, objPos: string, heavyGrade = false): string {
  const im = url
    ? `<img src="${esc(url)}" alt="${esc(alt)}"${objPos ? ` style="object-position:${objPos}"` : ""}>`
    : "";
  return `<div class="photo">${im}</div>
      <div class="grade"${heavyGrade ? ` style="opacity:1"` : ""}></div><div class="sheen"></div><div class="frame"></div>`;
}

// ── per-card renderers (faithful prototype markup, data-bound) ───────────────────
function coverCard(c: Extract<AnyCard, { type: "cover" }>): string {
  const lines = c.nameLines.length ? c.nameLines : [c.nameLines.join(" ") || ""];
  const first = lines[0] ?? "";
  const rest = lines.slice(1).join(" ");
  const sub = c.meta
    ? c.meta.split(" · ").map((p) => esc(p)).join(' <i>·</i> ')
    : "";
  const stats = c.stats
    .map((s) => `<span><b>${esc(s.value)}</b><br>${esc(s.label)}</span>`)
    .join("");
  return `<article class="card" data-title="Cover" aria-label="Cover — ${esc(first)} ${esc(rest)}">
      ${photo(c.image, c.nameLines.join(" "), "50% 18%")}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h1 class="rv cover-name"><span class="cn1">${esc(first)}</span>${rest ? `<br><em>${esc(rest)}</em>` : ""}</h1>
        ${sub ? `<div class="rv cover-sub">${sub}</div>` : ""}
        <div class="rv hairline"></div>
        ${stats ? `<div class="rv cover-meta">${stats}</div>` : ""}
      </div>
    </article>`;
}

function indexCard(c: Extract<AnyCard, { type: "index" }>): string {
  const pct = c.max ? clamp((c.value / c.max) * 100) : 0;
  return `<article class="card" data-title="The Index" aria-label="M.I.A. — ${c.value} of ${c.max}">
      ${photo(c.bg ?? null, "", "50% 22%")}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <div class="rv didone-num">${esc(c.value)}<small>/ ${esc(c.max)}</small></div>
        <div class="rv">
          <div class="meter" style="--w:${pct.toFixed(1)}%"><b></b></div>
          <div class="meter-scale"><span>0</span><span>${esc(c.max)}</span></div>
        </div>
        <p class="rv lede" style="margin-top:12px">${esc(c.verdict)}</p>
      </div>
    </article>`;
}


function audienceCard(c: Extract<AnyCard, { type: "audience" }>): string {
  const heroN = c.share != null ? `${c.share}%` : (c.stats[0]?.n ?? c.headline);
  const gridStats = c.stats.slice(1);
  const grid = gridStats
    .map((s) => `<div class="stat"><div class="n">${esc(s.n)}</div><div class="l">${esc(s.k)}</div></div>`)
    .join("");
  const geo = c.geo.map((g) => {
    const w = g.pct == null ? 0 : clamp(g.pct);
    const p = g.pct == null ? "" : `${Math.round(g.pct)}%`;
    return `<div class="g"><span class="c">${esc(g.label)}</span><span class="bar" style="--w:${w}%"><b></b></span><span class="p">${p}</span></div>`;
  }).join("\n          ");
  const genders = (c.genders ?? []).map((g) => `${g.pct}% ${esc(g.label.toLowerCase())}`).join(" &middot; ");
  const maxAge = Math.max(1, ...(c.ages ?? []).map((a) => a.pct));
  const ages = (c.ages ?? []).map((a) => `<div class="ac"><span class="av">${a.pct}%</span><i style="--h:${Math.round((a.pct / maxAge) * 100)}%"></i><span class="al">${esc(a.label)}</span></div>`).join("");
  const plats = (c.platforms ?? []).filter((p) => p.pct > 0);
  const kfmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)).replace(/\.0([KM])$/, "$1");
  const plat = plats.length
    ? `<div class="rv plat"><div class="pbar">${plats.map((p, i) => `<i class="p${i}" style="--w:${p.pct}%"></i>`).join("")}</div><div class="plab">${plats.map((p, i) => `<span><b class="pd p${i}"></b>${esc(p.label)} ${kfmt(p.n)}</span>`).join("")}</div></div>`
    : "";
  const lede = c.headline
    ? `${esc(c.headline)}${c.sub ? ` <span class="ital">${esc(c.sub)}</span>` : ""}`
    : (c.sub ? `<span class="ital">${esc(c.sub)}</span>` : "");
  return `<article class="card" data-title="The Audience" aria-label="The audience — ${esc(c.headline)}">
      ${photo(c.bg ?? null, "", "50% 15%")}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <div class="rv didone-num" style="font-size:88px">${esc(heroN)}</div>
        ${lede ? `<p class="rv lede" style="margin-top:6px">${lede}</p>` : ""}
        ${genders ? `<p class="rv aud-gender">${genders}</p>` : ""}
        ${ages ? `<div class="rv ages-l">Age</div><div class="rv ages">${ages}</div>` : (grid ? `<div class="rv statgrid" style="grid-template-columns:1fr 1fr; margin-top:16px">${grid}</div>` : "")}
        <div class="rv geo">
          ${geo}
        </div>
        ${plat}
      </div>
    </article>`;
}

function contentCard(c: Extract<AnyCard, { type: "content" }>): string {
  const unit = String(c.heroStat.label ?? "").split(" ")[0] || "views";
  // hero photo = the #1 post's thumbnail; the grid shows the remaining top posts (each a view count).
  const heroImg = c.tiles[0]?.image ?? c.bg ?? null;
  const rest = c.tiles.slice(1);
  const cols = rest.length >= 3 ? "1fr 1fr 1fr" : "1fr 1fr";
  const grid = rest
    .map((t) => `<div class="stat"><div class="n">${esc(t.stat)}</div><div class="l">views</div></div>`)
    .join("");
  return `<article class="card" data-title="The Work" aria-label="The work — top content">
      ${photo(heroImg, "", "50% 18%")}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <div class="rv didone-num" style="font-size:92px">${esc(c.heroStat.value)}<small>${esc(unit)}</small></div>
        ${c.note ? `<p class="rv lede" style="margin-top:4px">${esc(c.note)}</p>` : ""}
        <div class="rv hairline"></div>
        ${grid ? `<div class="rv statgrid" style="grid-template-columns:${cols}">${grid}</div>` : ""}
      </div>
    </article>`;
}

function videoCard(c: Extract<AnyCard, { type: "video" }>): string {
  // The prototype has no video card; this reuses the luxe card chrome (grade / sheen / frame) with a
  // full-bleed autoplaying clip in place of the still, and the note set as a didone closing line.
  return `<article class="card" data-title="In Motion" aria-label="In motion — autoplaying clip">
      <div class="photo"><video autoplay muted loop playsinline preload="metadata"${c.posterUrl ? ` poster="${esc(c.posterUrl)}"` : ""}><source src="${esc(c.videoUrl)}" type="video/mp4"></video></div>
      <div class="grade"></div><div class="sheen"></div><div class="frame"></div>
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.note, 40)}px; line-height:1.06">${esc(c.note)}</h2>
      </div>
    </article>`;
}


function fitCard(c: Extract<AnyCard, { type: "fit" }>, name: string): string {
  const chips = c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  return `<article class="card" data-title="The Invitation" aria-label="The invitation — brand fit">
      ${photo(c.image, "", "50% 8%", true)}
      <div class="content" style="padding-bottom:124px">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.lead, 39)}px; line-height:1.08">${esc(c.lead)}</h2>
        ${c.body ? `<p class="rv lede" style="margin-top:12px">${esc(c.body)}</p>` : ""}
        ${chips ? `<div class="rv chips">${chips}</div>` : ""}
        <button class="rv cta" id="ctaShare">Share this kit</button>
        <div class="rv cta-note">${esc(name)} · via Nomila</div>
      </div>
    </article>`;
}

// ── card library (Spec 8/9) — same couture chrome as the cards above: photo() gives the full-bleed
// grade/sheen/hairline-frame plate (its own photo-less state when bg is null, no special-casing
// needed), and .rv gives the staggered reveal already used by every card. ──

function whyFitsCard(c: Extract<AnyCard, { type: "whyFits" }>): string {
  const reasons = c.reasons.map((r, i) => `<div class="why-row">
          <span class="why-n">${String(i + 1).padStart(2, "0")}</span>
          <div><div class="why-h">${esc(r.head)}</div><div class="why-i">${esc(r.insight)}</div></div>
        </div>`).join("\n        ");
  const cobrand = `<div class="rv cobrand">
        ${c.brand.logo
          ? `<span class="logo-chip"><img class="brand-logo" src="${esc(c.brand.logo)}" alt="${esc(c.brand.name)}"></span>`
          : `<span class="brand-namemark">${esc(c.brand.name)}</span>`}
        <span class="cobrand-x">&times;</span>
        ${NOMILA_MARK}
      </div>`;
  return `<article class="card" data-title="Why She Fits" aria-label="Why she fits ${esc(c.brand.name)}">
      ${photo(c.bg ?? null, "", "50% 16%")}
      ${RINGS_WM}
      <div class="content">
        ${cobrand}
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.lead, 35)}px; line-height:1.05">${esc(c.lead)}</h2>
        <div class="rv why-list">
          ${reasons}
        </div>
        <div class="rv why-foot">${esc(c.brand.name)}${c.brand.category ? ` &middot; ${esc(c.brand.category)}` : ""}${c.confidence.level === "inferred" ? " &middot; inferred from public signals" : ""}</div>
      </div>
    </article>`;
}

function storyCard(c: Extract<AnyCard, { type: "story" }>): string {
  const beats = c.beats.map((b) => `<div class="beat${b.current ? " now" : ""}">
          <span class="beat-yr">${esc(b.year)}</span>
          <div><div class="beat-w">${esc(b.where)}</div><div class="beat-l">${esc(b.line)}</div></div>
        </div>`).join("\n        ");
  return `<article class="card" data-title="The Story" aria-label="The story">
      ${photo(c.bg ?? null, "", "50% 18%")}
      ${RINGS_WM}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <div class="rv story-rail">
          ${beats}
        </div>
        <p class="rv didone-xl" style="font-size:${fitSize(c.close, 27)}px; line-height:1.16; margin-top:14px">${esc(c.close)}</p>
      </div>
    </article>`;
}

function valuesCard(c: Extract<AnyCard, { type: "values" }>): string {
  const planks = c.planks.map((p) => `<div class="plank"><span class="plank-n">${esc(p.name)}</span>${p.line ? `<span class="plank-l">${esc(p.line)}</span>` : ""}</div>`).join("\n        ");
  return `<article class="card" data-title="What She Stands For" aria-label="What she stands for">
      ${photo(c.bg ?? null, "", "50% 16%")}
      ${RINGS_WM}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.statement, 31)}px; line-height:1.12">${esc(c.statement)}</h2>
        <div class="rv planks">
          ${planks}
        </div>
        <p class="rv lede" style="margin-top:12px">${esc(c.note)}</p>
        ${c.confidence.level === "self_reported" ? `<div class="rv prov">Self-declared &mdash; the athlete&rsquo;s own words, not a Nomila claim.</div>` : ""}
      </div>
    </article>`;
}

function achievementsCard(c: Extract<AnyCard, { type: "achievements" }>): string {
  const rows = c.entries.map((e) => `<div class="ach-row"><span class="ach-yr">${esc(e.year)}</span><span class="ach-nm">${esc(e.name)}</span>${e.level ? `<span class="ach-lv">${esc(e.level)}</span>` : ""}</div>`).join("\n        ");
  return `<article class="card" data-title="The Record" aria-label="The record">
      ${photo(c.bg ?? null, "", "50% 18%")}
      ${RINGS_WM}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        ${c.heroEntry.badge ? `<div class="rv tier-pill" style="border-color:var(--rouge)">${esc(c.heroEntry.badge)}</div>` : ""}
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.heroEntry.name, 37)}px; line-height:1.04; margin-top:10px">${esc(c.heroEntry.name)}</h2>
        <p class="rv lede" style="margin-top:4px">${[esc(c.heroEntry.year), esc(c.heroEntry.detail)].filter(Boolean).join(" &middot; ")}</p>
        <div class="rv ach-rows">
          ${rows}
        </div>
        <p class="rv lede" style="margin-top:10px">${esc(c.footnote)}</p>
      </div>
    </article>`;
}

/** A display title's font size that fits the card: full size up to `fits` characters, then shrinking with the length,
 *  never below `min`. The record's marquee line can be one word or a sentence. */
function fitSize(text: string, max: number, min = 20, fits = Math.round(1800 / max)): number {
  const n = String(text ?? "").length;
  return n <= fits ? max : Math.max(min, Math.round(max * Math.sqrt(fits / n)));
}

// Render in DECK order (mirrors kitRenderer.renderCampaign) — cards not listed in kit.deck are the
// "library" (assembled but not shown by default); falls back to raw card order if deck is absent.
function deckOrder(kit: Kit): string[] {
  return kit.deck?.length ? kit.deck : kit.cards.map((c) => c.id);
}

// ── Brand-tailored creative cards (gorjana template, Phase 2) — composed from the existing luxe
//    couture components (photo plate · eyebrow · didone-xl · chips · why-list) so they read native. ──
function campaignConceptCard(c: Extract<AnyCard, { type: "campaignConcept" }>): string {
  const facets = c.facets.map((f) => `<span class="chip">${esc(f)}</span>`).join("");
  return `<article class="card" data-title="The Concept" aria-label="Campaign concept — ${esc(c.title)}">
      ${photo(c.image, "", "50% 18%", true)}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.title, 42)}px; line-height:1.0">${esc(c.title)}</h2>
        <p class="rv lede" style="margin-top:12px">${esc(c.line)} <em class="cc-em">${esc(c.lineEmphasis)}</em></p>
        ${facets ? `<div class="rv chips">${facets}</div>` : ""}
        ${c.note ? `<p class="rv cc-note">${esc(c.note)}</p>` : ""}
      </div>
    </article>`;
}

function signatureIdeaCard(c: Extract<AnyCard, { type: "signatureIdea" }>): string {
  const facets = c.facets.map((f) => `<span class="chip">${esc(f)}</span>`).join("");
  return `<article class="card" data-title="The Idea" aria-label="The idea — ${esc(c.title)}">
      ${photo(c.image, "", "50% 18%", true)}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.title, 42)}px; line-height:1.0">${esc(c.title)}</h2>
        <p class="rv lede" style="margin-top:12px">${esc(c.line)} <em class="cc-em">${esc(c.lineEmphasis)}</em></p>
        ${facets ? `<div class="rv chips">${facets}</div>` : ""}
        ${c.note ? `<p class="rv cc-note">${esc(c.note)}</p>` : ""}
      </div>
    </article>`;
}

function activationPlanCard(c: Extract<AnyCard, { type: "activationPlan" }>): string {
  const rows = c.buckets.map((b) => `<div class="why-row">
          <span class="why-n">&mdash;</span>
          <div><div class="why-h">${esc(b.label)}<span class="ap-aud">${esc(b.audience)}</span></div><div class="why-i">${esc(b.line)}</div></div>
        </div>`).join("\n        ");
  return `<article class="card" data-title="All Year" aria-label="How this works all year — ${esc(c.lead)}">
      ${photo(c.brandImage ?? c.bg ?? null, "", "50% 16%")}
      ${RINGS_WM}
      <div class="content">
        <div class="rv eyebrow">${esc(c.eyebrow)}</div>
        <h2 class="rv didone-xl" style="font-size:${fitSize(c.lead, 33)}px; line-height:1.08">${esc(c.lead)}</h2>
        <div class="rv why-list">
          ${rows}
        </div>
        <div class="rv why-foot">${esc(c.close)}</div>
      </div>
    </article>`;
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
      case "fit":          return fitCard(c, kit.identity.name);
      case "campaignConcept": return campaignConceptCard(c);
      case "activationPlan":  return activationPlanCard(c);
      case "signatureIdea":   return signatureIdeaCard(c);
      default:             return "";
    }
  }).join("\n\n    ");
}

// Share pitch — built from identity + the key stats (cover meta/stats, index, rates), same shape as
// the campaign renderer's __PITCH__ injection. Wired into the prototype's share() below.
function pitchText(kit: Kit): string {
  const cover = kit.cards.find((c) => c.type === "cover") as Extract<AnyCard, { type: "cover" }> | undefined;
  const index = kit.cards.find((c) => c.type === "index") as Extract<AnyCard, { type: "index" }> | undefined;
  const meta = cover?.meta || [kit.identity.sport, kit.identity.school].filter(Boolean).join(" · ");
  const lines = [
    `${kit.identity.name} — ${meta}.`,
    cover?.stats?.length ? cover.stats.map((s) => `${s.value} ${String(s.label).toLowerCase()}`).join(" · ") + "." : null,
    index ? `Nomila M.I.A. ${index.value}/${index.max}.` : null,
    "See the full Nomi Card at Nomila.",
  ].filter(Boolean);
  return lines.join("\n");
}

export function renderLuxe(kit: MediaKitData): string {
  const name = kit.identity.name;
  const order = deckOrder(kit);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(name)} — Media Kit · Nomila</title>
<style>
${CSS}
</style>
</head>
<body>

<div class="wall" aria-hidden="true"><span>Nomila</span></div>

<div class="phone" id="phone" role="region" aria-label="${esc(name)} media kit — swipeable cards" aria-roledescription="carousel">

  <div class="progress" id="progress" aria-hidden="true"></div>
  <div class="brandmark">${NOMILA_MARK}<span class="bm-label"><b>Nomi</b>&nbsp;Card</span></div>
  <div class="serial" id="serial">Nº 1 / ${order.length}</div>

  <div class="deck" id="deck">

    ${renderDeck(kit)}

  </div>

  <div class="actions">
    <button class="btn-nav" id="btnPrev" aria-label="Previous card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <button class="btn-share" id="btnShare" aria-label="Share this media kit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13"/>
      </svg>
      <span class="btn-label">Share</span>
    </button>
    <button class="btn-nav" id="btnNext" aria-label="Next card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
    </button>
  </div>

  <div class="toast" id="toast" role="status">Link copied — <b>share by text or email</b></div>

</div>

<div class="stage-caption">${esc(name)} · Media Kit — <b>Nomila</b></div>

<script>
var __PITCH__ = ${JSON.stringify(pitchText(kit))};
${SCRIPT}
</script>
</body>
</html>`;
}

// ── Verbatim design from the luxe prototype (nomila-kit-luxe-v2.html) ────────────────
const CSS = String.raw`@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900&family=Jost:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&display=swap');

/* ————— PALETTE —————
   Noir        #0C0A07   base black, warm
   Champagne   #CDA96B   gold accents / hairlines
   Or Pâle     #E8CF9E   bright gold highlights
   Ivory       #F4EEE2   principal text
   Rouge Nº    #9E2B33   single red accent, used once per deck
*/

:root{
  --noir:#0C0A07;
  --champagne:#CDA96B;
  --or:#E8CF9E;
  --ivory:#F4EEE2;
  --rouge:#9E2B33;
  --hair:rgba(205,169,107,.55);
  --hair-dim:rgba(205,169,107,.28);
  --didone:'Bodoni Moda', 'Didot', serif;
  --sans:'Jost', 'Futura', sans-serif;
}

*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}

html,body{height:100%;}
body{
  background:
    radial-gradient(1200px 800px at 50% -10%, rgba(205,169,107,.10), transparent 55%),
    radial-gradient(900px 700px at 50% 115%, rgba(158,43,51,.06), transparent 60%),
    var(--noir);
  color:var(--ivory);
  font-family:var(--sans);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:24px 12px;
  overflow-x:hidden;
}

/* faint boutique wall lettering behind the phone */
.wall{
  position:fixed; inset:0; pointer-events:none; z-index:0;
  display:flex; align-items:center; justify-content:center;
  overflow:hidden;
}
.wall span{
  font-family:var(--didone);
  font-style:italic;
  font-weight:400;
  font-size:min(20vw,190px);
  letter-spacing:.08em;
  color:transparent;
  -webkit-text-stroke:1px rgba(205,169,107,.07);
  white-space:nowrap;
  user-select:none;
}

.stage-caption{
  position:relative; z-index:2;
  margin-top:16px;
  font-family:var(--sans);
  font-weight:300;
  font-size:10px;
  letter-spacing:.42em;
  text-transform:uppercase;
  color:rgba(244,238,226,.42);
}
.stage-caption b{color:var(--champagne);font-weight:400;}

/* ————— PHONE ————— */
.phone{
  position:relative; z-index:2;
  width:352px; height:618px;
  border-radius:30px;
  background:#000;
  box-shadow:
    0 0 0 1px rgba(205,169,107,.32),
    0 0 0 7px rgba(8,6,4,.9),
    0 0 0 8px rgba(205,169,107,.16),
    0 40px 90px -20px rgba(0,0,0,.85),
    0 0 120px -30px rgba(205,169,107,.22);
  overflow:hidden;
  touch-action:pan-y;
  user-select:none;
}

/* ————— PROGRESS BARS ————— */
.progress{
  position:absolute; top:12px; left:14px; right:14px;
  display:flex; gap:5px; z-index:40; pointer-events:none;
}
.progress i{
  flex:1; height:2px; border-radius:2px;
  background:rgba(244,238,226,.22);
  overflow:hidden; position:relative;
}
.progress i::after{
  content:''; position:absolute; inset:0;
  background:linear-gradient(90deg,var(--champagne),var(--or));
  transform:scaleX(0); transform-origin:left;
  transition:transform .45s cubic-bezier(.2,.7,.2,1);
}
.progress i.done::after{transform:scaleX(1);}
.progress i.live::after{transform:scaleX(1);}
.progress i.live{box-shadow:0 0 8px rgba(232,207,158,.5);}

/* card serial Nº */
.serial{
  position:absolute; top:24px; right:18px; z-index:40; pointer-events:none;
  font-family:var(--didone); font-style:italic; font-weight:500;
  font-size:12px; letter-spacing:.14em;
  color:rgba(232,207,158,.9);
  text-shadow:0 1px 8px rgba(0,0,0,.6);
}
.brandmark{
  position:absolute; top:20px; left:18px; z-index:40; pointer-events:none;
  display:flex; align-items:center; gap:8px;
  font-family:var(--sans); font-weight:400;
  font-size:9px; letter-spacing:.32em; text-transform:uppercase;
  color:rgba(244,238,226,.85);
  text-shadow:0 1px 8px rgba(0,0,0,.6);
}
.brandmark .nomila-mark{width:19px; height:19px; flex:none;}
.brandmark b{color:var(--or);font-weight:500;}

/* ————— CARD STACK ————— */
.deck{position:absolute; inset:0;}
.card{
  position:absolute; inset:0;
  border-radius:30px;
  overflow:hidden;
  background:var(--noir);
  opacity:0; pointer-events:none;
  transform:translateX(0) rotate(0deg) scale(.93);
  transition:transform .55s cubic-bezier(.22,.8,.24,1), opacity .45s ease;
  will-change:transform,opacity;
}
.card.is-next{opacity:1; transform:scale(.94); filter:brightness(.5);}
.card.is-current{
  opacity:1; pointer-events:auto; z-index:20;
  transform:none; filter:none;
  transition:transform .55s cubic-bezier(.22,.8,.24,1), opacity .45s ease, filter .5s ease;
}
.card.dragging{transition:none;}
.card.exit-left{transform:translateX(-120%) rotate(-7deg); opacity:0;}
.card.exit-right{transform:translateX(120%) rotate(7deg); opacity:0;}

/* photography */
.card .photo{
  position:absolute; inset:0;
}
.card .photo img,.card .photo video{
  width:100%; height:100%; object-fit:cover; display:block;
  filter:saturate(1.06) contrast(1.08) brightness(.96) sepia(.08);
}
.card.is-current .photo img{animation:kenburns 16s ease-in-out infinite alternate;}
@keyframes kenburns{
  from{transform:scale(1.02) translateY(0);}
  to{transform:scale(1.1) translateY(-8px);}
}

/* cinematic grade: warm shadow lift + editorial scrims */
.card .grade{
  position:absolute; inset:0; pointer-events:none;
  background:
    linear-gradient(180deg, rgba(12,10,7,.58) 0%, rgba(12,10,7,.12) 22%, rgba(12,10,7,0) 40%),
    linear-gradient(180deg, rgba(12,10,7,0) 30%, rgba(12,10,7,.40) 48%, rgba(12,10,7,.72) 66%, rgba(10,8,5,.92) 84%, rgba(8,6,4,.98) 100%),
    radial-gradient(120% 90% at 50% 20%, transparent 50%, rgba(12,10,7,.46) 100%);
}
.card .grade::after{ /* warm gold cast, like tungsten campaign lighting */
  content:''; position:absolute; inset:0;
  background:linear-gradient(160deg, rgba(232,207,158,.10), transparent 45%, rgba(158,43,51,.05));
  mix-blend-mode:soft-light;
}

/* glossy sheen sweep on card entry */
.card .sheen{
  position:absolute; inset:-40%; pointer-events:none; z-index:6;
  background:linear-gradient(115deg, transparent 42%, rgba(244,238,226,.14) 50%, rgba(232,207,158,.20) 52%, transparent 60%);
  transform:translateX(-120%) rotate(0.001deg);
  opacity:0;
}
.card.is-current .sheen{animation:sweep 1.9s .25s cubic-bezier(.35,0,.25,1) 1;}
@keyframes sweep{
  0%{transform:translateX(-120%); opacity:0;}
  12%{opacity:1;}
  85%{opacity:1;}
  100%{transform:translateX(120%); opacity:0;}
}

/* couture hairline frame */
.frame{
  position:absolute; inset:11px; z-index:5; pointer-events:none;
  border:1px solid var(--hair-dim);
  border-radius:22px;
}
.frame::before,.frame::after{
  content:''; position:absolute; width:22px; height:22px;
  border-color:var(--hair); border-style:solid;
}
.frame::before{top:-1px; left:-1px; border-width:1px 0 0 1px; border-top-left-radius:22px;}
.frame::after{bottom:-1px; right:-1px; border-width:0 1px 1px 0; border-bottom-right-radius:22px;}

/* ————— CARD CONTENT ————— */
.rings-wm{position:absolute; right:-118px; top:-96px; width:330px; height:330px; z-index:7; pointer-events:none;}
.content{
  position:absolute; inset:0; z-index:10;
  /* Bottom-anchored, but never above the masthead: the first line takes the free space (margin-top:auto), so a long
     card grows into the space under it instead of climbing over "NOMI CARD · Nº" at the top. */
  display:flex; flex-direction:column; justify-content:flex-start;
  padding:62px 26px 118px;
  /* inherited by every overlaid line so copy stays legible over photography */
  text-shadow:0 1px 12px rgba(0,0,0,.6), 0 1px 2px rgba(0,0,0,.45);
}
.content > :first-child{ margin-top:auto; }
.eyebrow{
  font-family:var(--sans); font-weight:400;
  font-size:9px; letter-spacing:.46em; text-transform:uppercase;
  color:var(--or);
  display:flex; align-items:center; gap:12px;
  margin-bottom:12px;
}
.eyebrow::before{content:''; width:26px; height:1px; background:var(--hair); flex:none;}

.didone-xl{
  font-family:var(--didone); font-weight:500;
  font-size:64px; line-height:.96; letter-spacing:.01em;
  color:var(--ivory);
  text-shadow:0 2px 30px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.55);
}
.didone-num{
  font-family:var(--didone); font-weight:400;
  font-size:104px; line-height:.9; letter-spacing:0;
  color:var(--ivory);
  text-shadow:0 2px 34px rgba(0,0,0,.6), 0 1px 3px rgba(0,0,0,.55);
  font-feature-settings:'lnum';
}
.didone-num small{
  font-size:26px; font-style:italic; font-weight:500;
  color:var(--champagne); letter-spacing:.05em;
  vertical-align:18px; margin-left:6px;
}
.ital{
  font-family:var(--didone); font-style:italic; font-weight:500;
  color:var(--or);
}
.lede{
  font-family:var(--sans); font-weight:300;
  font-size:12.5px; letter-spacing:.14em; line-height:1.65;
  color:rgba(244,238,226,.88);
}
.hairline{width:100%; height:1px; background:linear-gradient(90deg,var(--hair), transparent); margin:14px 0;}

/* staggered reveal */
.rv{opacity:0; transform:translateY(14px); transition:opacity .7s ease, transform .7s cubic-bezier(.2,.7,.2,1);}
.card.is-current .rv{opacity:1; transform:none;}
.card.is-current .rv:nth-child(1){transition-delay:.15s;}
.card.is-current .rv:nth-child(2){transition-delay:.28s;}
.card.is-current .rv:nth-child(3){transition-delay:.41s;}
.card.is-current .rv:nth-child(4){transition-delay:.54s;}
.card.is-current .rv:nth-child(5){transition-delay:.67s;}
.card.is-current .rv:nth-child(6){transition-delay:.8s;}
.card.is-current .rv:nth-child(7){transition-delay:.93s;}

/* — cover — */
.cover-name{
  font-family:var(--didone); font-weight:600; font-size:76px; line-height:.88;
  letter-spacing:.005em; color:var(--ivory);
  text-shadow:0 3px 40px rgba(0,0,0,.6), 0 1px 3px rgba(0,0,0,.55);
}
.cover-name .cn1{text-transform:uppercase;}
.cover-name em{font-style:italic; font-weight:400; color:var(--or);}
.cover-sub{
  margin-top:14px;
  font-size:10.5px; font-weight:400; letter-spacing:.32em; text-transform:uppercase;
  color:rgba(244,238,226,.92);
}
.cover-sub i{color:var(--champagne); font-style:normal; padding:0 4px;}
.cover-meta{
  margin-top:16px; display:flex; align-items:baseline; gap:14px;
  font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:rgba(244,238,226,.6);
}
.cover-meta b{
  font-family:var(--didone); font-style:italic; font-weight:500;
  font-size:19px; letter-spacing:.02em; color:var(--or); text-transform:none;
}

/* — index card ring/bar — */
.tier-pill{
  display:inline-flex; align-items:center; gap:10px;
  border:1px solid var(--hair); border-radius:999px;
  padding:7px 18px; margin-top:14px; width:max-content;
  font-size:9.5px; letter-spacing:.42em; text-transform:uppercase;
  color:var(--or);
  background:rgba(12,10,7,.42);
  backdrop-filter:blur(6px);
}
.tier-pill::before{content:''; width:5px; height:5px; border-radius:50%; background:var(--rouge); box-shadow:0 0 10px rgba(158,43,51,.8);}
.meter{
  margin-top:16px; height:2px; background:rgba(244,238,226,.18); border-radius:2px; overflow:visible; position:relative;
}
.meter b{
  display:block; height:100%; border-radius:2px;
  background:linear-gradient(90deg, var(--champagne), var(--or));
  width:0; transition:width 1.4s .5s cubic-bezier(.2,.7,.2,1);
  box-shadow:0 0 12px rgba(232,207,158,.55);
  position:relative;
}
.meter b::after{
  content:''; position:absolute; right:-3px; top:-3px; width:8px; height:8px; border-radius:50%;
  background:var(--or); box-shadow:0 0 10px rgba(232,207,158,.9);
}
.card.is-current .meter b{width:var(--w,64.8%);}
.meter-scale{
  display:flex; justify-content:space-between; margin-top:8px;
  font-size:9px; letter-spacing:.24em; color:rgba(244,238,226,.5); text-transform:uppercase;
}

/* — score rows (the mix) — */
.score{margin-top:13px;}
.score .row1{
  display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;
}
.score .lbl{font-size:9.5px; letter-spacing:.34em; text-transform:uppercase; color:rgba(244,238,226,.9);}
.score .lbl i{font-family:var(--didone); font-style:italic; font-size:12.5px; letter-spacing:.04em; text-transform:none; color:var(--or); margin-left:8px;}
.score .val{font-family:var(--didone); font-weight:500; font-size:21px; color:var(--ivory);}
.score .bar{height:1.5px; background:rgba(244,238,226,.16); border-radius:2px;}
.score .bar b{
  display:block; height:100%; width:0; border-radius:2px;
  background:linear-gradient(90deg,var(--champagne),var(--or));
  transition:width 1.2s cubic-bezier(.2,.7,.2,1);
  box-shadow:0 0 8px rgba(232,207,158,.4);
}
.card.is-current .score .bar b{width:var(--w);}
.card.is-current .score:nth-of-type(1) .bar b{transition-delay:.45s;}
.card.is-current .score:nth-of-type(2) .bar b{transition-delay:.6s;}
.card.is-current .score:nth-of-type(3) .bar b{transition-delay:.75s;}
.card.is-current .score:nth-of-type(4) .bar b{transition-delay:.9s;}
.score .open-note{
  font-family:var(--didone); font-style:italic; font-size:13px; color:var(--or);
  margin-top:5px; letter-spacing:.03em;
}
.score .bar.open{border:1px dashed var(--hair-dim); height:5px; background:transparent; border-radius:3px;}

/* — stat grids — */
.statgrid{display:grid; grid-template-columns:1fr 1fr; gap:12px 18px; margin-top:14px;}
.stat .n{
  font-family:var(--didone); font-weight:500; font-size:29px; line-height:1; color:var(--ivory);
  text-shadow:0 2px 18px rgba(0,0,0,.6), 0 1px 2px rgba(0,0,0,.5);
}
.stat .n em{font-style:italic; font-size:16px; color:var(--or);}
.stat .l{margin-top:5px; font-size:8.5px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.62);}

/* — geo rows — */
.aud-gender{margin-top:6px; font-size:9px; letter-spacing:.22em; text-transform:uppercase; color:rgba(244,238,226,.7);}
.ages-l{margin-top:14px; font-size:8.5px; letter-spacing:.3em; text-transform:uppercase; color:var(--champagne);}
.ages{margin-top:6px; height:54px; display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:6px; align-items:end;}
.ac{height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center;}
.ac i{display:block; width:100%; height:var(--h); min-height:2px; border-radius:2px 2px 0 0; background:linear-gradient(180deg,var(--or),var(--champagne));}
.ac .av{font-family:var(--didone); font-style:italic; font-size:10px; color:var(--or); margin-bottom:2px;}
.ac .al{margin-top:3px; font-size:7px; letter-spacing:.08em; color:rgba(244,238,226,.6); white-space:nowrap;}
.plat{margin-top:12px;}
.pbar{display:flex; height:6px; border-radius:3px; overflow:hidden; background:rgba(244,238,226,.12);}
.pbar i{display:block; height:100%; width:var(--w);}
.p0{background:var(--or);}.p1{background:var(--champagne);}.p2{background:rgba(244,238,226,.45);}.p3{background:rgba(244,238,226,.25);}
.plab{margin-top:6px; display:flex; flex-wrap:wrap; gap:4px 14px; font-size:8.5px; letter-spacing:.22em; text-transform:uppercase; color:rgba(244,238,226,.85);}
.plab .pd{display:inline-block; width:7px; height:7px; border-radius:1px; margin-right:6px;}
.geo{margin-top:12px;}
.geo .g{display:flex; align-items:center; gap:12px; margin-top:9px;}
.geo .c{width:64px; flex:none; font-size:9.5px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.85);}
.geo .bar{flex:1; height:1.5px; background:rgba(244,238,226,.15); border-radius:2px;}
.geo .bar b{display:block; height:100%; width:0; background:linear-gradient(90deg,var(--champagne),var(--or)); transition:width 1.1s .5s cubic-bezier(.2,.7,.2,1); box-shadow:0 0 6px rgba(232,207,158,.35);}
.card.is-current .geo .bar b{width:var(--w);}
.geo .p{width:38px; flex:none; text-align:right; font-family:var(--didone); font-style:italic; font-weight:500; font-size:15px; color:var(--or);}

/* — rate list — */
.rates{margin-top:8px;}
.rate{
  display:flex; align-items:baseline; gap:10px; padding:11px 0;
  border-bottom:1px solid rgba(205,169,107,.18);
}
.rate:last-child{border-bottom:none;}
.rate .svc{font-size:10px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.9); flex:none;}
.rate .dots{flex:1; border-bottom:1px dotted rgba(205,169,107,.35); transform:translateY(-4px);}
.rate .amt{font-family:var(--didone); font-weight:500; font-size:23px; color:var(--ivory); flex:none;}
.rate .amt i{font-style:italic; font-size:12px; color:var(--champagne); margin-left:4px; letter-spacing:.05em;}

.annual{
  margin-top:14px; padding:14px 18px;
  border:1px solid var(--hair-dim); border-radius:14px;
  background:rgba(12,10,7,.5); backdrop-filter:blur(8px);
  display:flex; align-items:center; justify-content:space-between; gap:12px;
}
.annual .t{font-size:8.5px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.7); line-height:1.7;}
.annual .v{font-family:var(--didone); font-weight:500; font-size:31px; color:var(--or); text-shadow:0 0 24px rgba(232,207,158,.35);}
.annual .v small{font-family:var(--sans); font-weight:300; font-size:9.5px; letter-spacing:.14em; color:rgba(244,238,226,.6); display:block; text-align:right; margin-top:2px;}

/* — fit chips + CTA — */
.chips{display:flex; flex-wrap:wrap; gap:8px; margin-top:14px;}
.chip{
  border:1px solid var(--hair); border-radius:999px;
  padding:7px 16px;
  font-family:var(--didone); font-style:italic; font-weight:500;
  font-size:13.5px; letter-spacing:.06em; color:var(--ivory);
  background:rgba(12,10,7,.45); backdrop-filter:blur(6px);
}
.cta{
  margin-top:18px; display:block; width:100%;
  border:none; cursor:pointer; border-radius:999px;
  padding:16px 20px;
  background:linear-gradient(120deg, #B08D50, var(--or) 45%, #B08D50);
  background-size:200% 100%;
  color:#191307;
  font-family:var(--sans); font-weight:600;
  font-size:11px; letter-spacing:.4em; text-transform:uppercase; text-indent:.4em;
  box-shadow:0 10px 34px -8px rgba(205,169,107,.55), inset 0 1px 0 rgba(255,244,214,.7);
  transition:background-position .8s ease, transform .25s ease;
}
.cta:hover{background-position:100% 0; transform:translateY(-1px);}
.cta-note{
  margin-top:11px; text-align:center;
  font-size:9px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.55);
}

/* ————— ACTION ROW ————— */
.actions{
  position:absolute; left:0; right:0; bottom:20px; z-index:45;
  display:flex; align-items:center; justify-content:center; gap:22px;
  pointer-events:none;
}
.actions button{
  pointer-events:auto; cursor:pointer;
  border-radius:50%; display:flex; align-items:center; justify-content:center;
  transition:transform .25s cubic-bezier(.2,.7,.3,1.4), box-shadow .3s ease, border-color .3s ease;
}
.actions button:active{transform:scale(.9);}
.btn-nav{
  width:46px; height:46px;
  background:rgba(12,10,7,.55); backdrop-filter:blur(10px);
  border:1px solid rgba(244,238,226,.3);
  color:var(--ivory);
}
.btn-nav:hover{border-color:var(--champagne); color:var(--or); transform:translateY(-2px);}
.btn-nav svg{width:16px; height:16px;}
.btn-share{
  width:68px; height:68px; position:relative;
  background:radial-gradient(120% 120% at 30% 25%, #F2DCAB, var(--champagne) 55%, #A8823F);
  border:1px solid rgba(255,244,214,.75);
  color:#1B1408;
  box-shadow:0 14px 40px -8px rgba(205,169,107,.7), 0 0 0 1px rgba(12,10,7,.4), inset 0 2px 3px rgba(255,250,235,.7);
}
.btn-share:hover{transform:translateY(-3px) scale(1.04);}
.btn-share svg{width:24px; height:24px;}
.btn-share::after{
  content:''; position:absolute; inset:-7px; border-radius:50%;
  border:1px solid rgba(232,207,158,.5);
  animation:halo 2.6s ease-out infinite;
}
@keyframes halo{
  0%{transform:scale(.92); opacity:.9;}
  70%{transform:scale(1.22); opacity:0;}
  100%{transform:scale(1.22); opacity:0;}
}
.btn-label{
  position:absolute; bottom:-16px; left:50%; transform:translateX(-50%);
  font-family:var(--sans); font-weight:500; font-size:7.5px; letter-spacing:.4em; text-indent:.4em;
  text-transform:uppercase; color:var(--or); white-space:nowrap;
  text-shadow:0 1px 6px rgba(0,0,0,.8);
}

/* ————— TOAST ————— */
.toast{
  position:absolute; left:50%; bottom:108px; z-index:60;
  transform:translate(-50%, 16px);
  opacity:0; pointer-events:none;
  background:rgba(14,11,7,.9); backdrop-filter:blur(12px);
  border:1px solid var(--hair);
  border-radius:999px; padding:11px 22px;
  font-size:9.5px; letter-spacing:.24em; text-transform:uppercase; color:var(--ivory);
  white-space:nowrap;
  transition:opacity .4s ease, transform .4s cubic-bezier(.2,.7,.2,1);
  box-shadow:0 12px 40px rgba(0,0,0,.6);
}
.toast.show{opacity:1; transform:translate(-50%,0);}
.toast b{color:var(--or); font-weight:500;}

/* tap-zone hint cursor */
.card.is-current{cursor:grab;}
.card.is-current.dragging{cursor:grabbing;}

/* ————— REDUCED MOTION ————— */
@media (prefers-reduced-motion: reduce){
  .card.is-current .photo img{animation:none;}
  .card.is-current .sheen{animation:none;}
  .btn-share::after{animation:none;}
  .card,.rv,.meter b,.score .bar b,.geo .bar b,.progress i::after{transition-duration:.01s !important; transition-delay:0s !important;}
}

@media (max-height:700px){
  body{padding:12px;}
  .stage-caption{display:none;}
}

/* ————— CARD LIBRARY (payments / whyFits / story / values / achievements) ————— */
.pkglist{ display:flex; flex-direction:column; margin-top:2px; }
.pkg{ position:relative; text-align:left; background:none; border:none; border-top:1px solid var(--hair-dim); padding:12px 4px; cursor:pointer; color:var(--ivory); font-family:var(--sans); width:100%; transition:background .2s ease; }
.pkg:last-of-type{ border-bottom:1px solid var(--hair-dim); }
.pkg::before{ content:''; position:absolute; left:-2px; top:10px; bottom:10px; width:2px; background:transparent; transition:background .2s ease; }
.pkg.sel{ background:rgba(232,207,158,.07); }
.pkg.sel::before{ background:linear-gradient(var(--champagne),var(--or)); }
.pkg-top{ display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
.pkg-nm{ font-family:var(--didone); font-style:italic; font-weight:500; font-size:15px; letter-spacing:.03em; color:var(--ivory); }
.pkg-pr{ font-family:var(--didone); font-weight:500; font-size:21px; color:var(--ivory); display:flex; align-items:baseline; gap:6px; }
.pkg-pr i{ font-style:italic; font-family:var(--sans); font-size:9.5px; color:var(--champagne); letter-spacing:.08em; }
.pkg-inc{ margin-top:4px; font-size:10.5px; font-weight:300; letter-spacing:.03em; line-height:1.4; color:rgba(244,238,226,.62); max-width:250px; }
.pkg-badge{ position:absolute; top:-7px; left:4px; font-size:7.5px; font-weight:600; letter-spacing:.24em; text-transform:uppercase; padding:3px 9px; border-radius:999px; background:var(--champagne); color:#1B1408; }
.cta-note{ margin-top:11px; text-align:center; font-size:9px; letter-spacing:.3em; text-transform:uppercase; color:rgba(244,238,226,.55); }

.cobrand{ display:flex; align-items:center; gap:11px; margin-bottom:14px; }
.cobrand .logo-chip{ background:#fff; border-radius:3px; padding:5px 11px; display:inline-flex; align-items:center; box-shadow:0 4px 16px rgba(0,0,0,.4); }
.cobrand .brand-logo{ height:17px; max-width:96px; object-fit:contain; display:block; }
.cobrand .brand-namemark{ font-family:var(--didone); font-style:italic; font-weight:500; font-size:15px; letter-spacing:.03em; color:var(--ivory); }
.cobrand .cobrand-x{ font-family:var(--sans); font-size:11px; color:var(--champagne); }
.cobrand .nomila-mark{ width:18px; height:18px; flex:none; }
.why-list{ margin-top:4px; display:flex; flex-direction:column; gap:14px; }
.why-row{ display:flex; gap:12px; align-items:flex-start; }
.why-n{ font-family:var(--didone); font-style:italic; font-weight:500; font-size:14px; color:var(--or); flex:none; width:20px; padding-top:1px; }
.why-h{ font-size:10px; letter-spacing:.24em; text-transform:uppercase; color:rgba(244,238,226,.92); }
.why-i{ margin-top:4px; font-size:11.5px; font-weight:300; line-height:1.5; color:rgba(244,238,226,.72); }
.why-foot{ margin-top:14px; font-size:8.5px; letter-spacing:.28em; text-transform:uppercase; color:rgba(244,238,226,.5); }
/* Phase 2 creative cards — campaignConcept + activationPlan */
.cc-em{ font-family:var(--didone); font-style:italic; color:var(--or); }
.cc-note{ margin-top:16px; font-size:11.5px; font-weight:300; line-height:1.55; color:rgba(244,238,226,.66); max-width:40ch; }
.ap-aud{ margin-left:8px; font-size:8.5px; letter-spacing:.2em; color:var(--champagne); }

.story-rail{ margin-top:6px; display:flex; flex-direction:column; }
.beat{ display:grid; grid-template-columns:38px 1fr; gap:10px; padding:9px 0; border-top:1px solid var(--hair-dim); align-items:start; }
.beat:first-child{ border-top:none; }
.beat-yr{ font-family:var(--didone); font-style:italic; font-weight:500; font-size:13px; color:var(--champagne); }
.beat.now .beat-yr{ color:var(--or); }
.beat-w{ font-size:8.5px; letter-spacing:.24em; text-transform:uppercase; color:rgba(244,238,226,.55); }
.beat-l{ margin-top:2px; font-size:11.5px; font-weight:300; line-height:1.4; color:var(--ivory); }

.plank{ border-left:1px solid var(--champagne); padding-left:12px; }
.plank-n{ display:block; font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--ivory); }
.plank-l{ display:block; margin-top:3px; font-size:10.5px; font-weight:300; line-height:1.4; color:rgba(244,238,226,.62); }
.rv.planks{ display:flex; flex-direction:column; gap:12px; margin-top:14px; }
.prov{ margin-top:9px; font-size:8px; letter-spacing:.24em; text-transform:uppercase; color:rgba(244,238,226,.5); }

.ach-rows{ margin-top:14px; display:flex; flex-direction:column; }
.ach-row{ display:grid; grid-template-columns:36px 1fr auto; gap:10px; align-items:baseline; padding:8px 0; border-top:1px solid var(--hair-dim); }
.ach-row:last-child{ border-bottom:1px solid var(--hair-dim); }
.ach-yr{ font-family:var(--didone); font-style:italic; font-weight:500; font-size:12px; color:var(--champagne); }
.ach-nm{ font-size:11px; font-weight:300; color:var(--ivory); line-height:1.3; }
.ach-lv{ font-size:8px; letter-spacing:.2em; text-transform:uppercase; color:rgba(244,238,226,.5); }`;

const SCRIPT = String.raw`(function(){
  'use strict';
  var deck = document.getElementById('deck');
  var cards = Array.prototype.slice.call(deck.querySelectorAll('.card'));
  var progress = document.getElementById('progress');
  var serial = document.getElementById('serial');
  var toast = document.getElementById('toast');
  var phone = document.getElementById('phone');
  var N = cards.length;
  var idx = 0;

  // build progress segments
  for (var i = 0; i < N; i++) {
    progress.appendChild(document.createElement('i'));
  }
  var segs = Array.prototype.slice.call(progress.children);

  function render(dir){
    cards.forEach(function(c, i){
      c.classList.remove('is-current','is-next','exit-left','exit-right','dragging');
      c.style.transform = '';
      if (i === idx) {
        c.classList.add('is-current');
        // restart sheen sweep
        var sh = c.querySelector('.sheen');
        if (sh) { sh.style.animation = 'none'; void sh.offsetWidth; sh.style.animation = ''; }
      } else if (i === idx + 1) {
        c.classList.add('is-next');
      } else if (dir && i === idx - dir) {
        // card we just left exits in the direction of travel
        c.classList.add(dir > 0 ? 'exit-left' : 'exit-right');
      }
    });
    segs.forEach(function(s, i){
      s.classList.toggle('done', i < idx);
      s.classList.toggle('live', i === idx);
    });
    serial.textContent = 'Nº ' + (idx + 1) + ' / ' + N;
  }

  function go(dir){
    var t = idx + dir;
    if (t < 0 || t >= N) {
      // gentle bounce at the edges
      var c = cards[idx];
      c.style.transition = 'transform .18s ease';
      c.style.transform = 'translateX(' + (dir * -14) + 'px)';
      setTimeout(function(){ c.style.transform = ''; setTimeout(function(){ c.style.transition = ''; }, 200); }, 180);
      return;
    }
    idx = t;
    render(dir);
  }

  // ——— drag / swipe ———
  var drag = null;
  deck.addEventListener('pointerdown', function(e){
    if (e.target.closest('button')) return;
    var cur = cards[idx];
    drag = { x0: e.clientX, y0: e.clientY, dx: 0, moved: false, el: cur };
    cur.classList.add('dragging');
    deck.setPointerCapture && deck.setPointerCapture(e.pointerId);
  });
  deck.addEventListener('pointermove', function(e){
    if (!drag) return;
    drag.dx = e.clientX - drag.x0;
    if (Math.abs(drag.dx) > 6) drag.moved = true;
    var r = drag.dx / 22;
    drag.el.style.transform = 'translateX(' + drag.dx + 'px) rotate(' + r + 'deg)';
    var nxt = cards[idx + 1];
    if (nxt && drag.dx < 0) {
      var p = Math.min(Math.abs(drag.dx) / 220, 1);
      nxt.style.transform = 'scale(' + (0.94 + 0.06 * p) + ')';
      nxt.style.filter = 'brightness(' + (0.5 + 0.5 * p) + ')';
    }
  });
  function endDrag(e){
    if (!drag) return;
    var d = drag; drag = null;
    d.el.classList.remove('dragging');
    var nxt = cards[idx + 1];
    if (nxt) { nxt.style.transform = ''; nxt.style.filter = ''; }
    if (d.moved && Math.abs(d.dx) > 70) {
      d.el.style.transform = '';
      go(d.dx < 0 ? 1 : -1);
      return;
    }
    d.el.style.transform = '';
    if (!d.moved) {
      // tap zones: left third = back, rest = forward
      var rect = phone.getBoundingClientRect();
      var x = e.clientX - rect.left;
      go(x < rect.width * 0.34 ? -1 : 1);
    }
  }
  deck.addEventListener('pointerup', endDrag);
  deck.addEventListener('pointercancel', function(){
    if (!drag) return;
    drag.el.classList.remove('dragging');
    drag.el.style.transform = '';
    var nxt = cards[idx + 1];
    if (nxt) { nxt.style.transform = ''; nxt.style.filter = ''; }
    drag = null;
  });

  // ——— buttons / keys ———
  document.getElementById('btnPrev').addEventListener('click', function(){ go(-1); });
  document.getElementById('btnNext').addEventListener('click', function(){ go(1); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });

  // ——— share ———
  var toastTimer = null;
  function showToast(){
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.classList.remove('show'); }, 2600);
  }
  var PITCH = (typeof __PITCH__ !== 'undefined') ? __PITCH__ : document.title;
  function share(){
    var payload = {
      title: document.title,
      text: PITCH,
      url: location.href
    };
    if (navigator.share) {
      navigator.share(payload).catch(function(){ showToast(); });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload.text + ' ' + payload.url)
        .then(showToast, showToast);
    } else {
      showToast();
    }
  }
  document.getElementById('btnShare').addEventListener('click', share);
  var cta = document.getElementById('ctaShare');
  if (cta) cta.addEventListener('click', function(e){ e.stopPropagation(); share(); });

  // payments card — package selection + placeholder checkout toast (buttons excluded from swipe)
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

  render(0);
})();`;
