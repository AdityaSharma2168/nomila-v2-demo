/**
 * nomila — the Nomila look for the shareable deck (owner decision, 23 Oct 2026): the app's one look (DESIGN.md) on a
 * public document. White ground, Outfit only (display 800–900 in caps), ONE raspberry highlight per card, text cards
 * and tiles at corner 16, photo-led full-bleed covers under the DESIGN.md §2c scrims, the M.I.A. card DARK with the
 * ring, and the Nomila mark treatment: the cardmark on the cover, a faint rings watermark on the text-led cards, and
 * the brand logo × Nomila mark lockup on why-she-fits and the concept.
 *
 * It is the default look and the fallback for a deck saved with a retired one (campaign, immersive), so it draws
 * EVERY card type the assembler makes, the brand creative cards included: a Nomila deck is 100% Nomila.
 * Mirrors the native look in client/components/card-native/nomila/ card for card.
 *
 * Self-contained like the other themes: its own helpers, CSS and swipe/tap/keyboard/share script; the only import
 * is the MediaKitData type. Returns a complete standalone HTML document.
 */
import type { MediaKitData } from "../mediaKitService";

type Kit = MediaKitData;
type AnyCard = Kit["cards"][number];

const RING = { audience: "#2D8EFF", commercial: "#2DC87C", brand: "#E84591", performance: "#E8A215" };

/** The official Nomila mark: four concentric arcs over faint tracks. `track` inks the tracks for the ground. */
const mark = (track: string, cls = "nomila-mark"): string => `<svg class="${cls}" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <circle cx="56" cy="56" r="50" stroke="${track}" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="38" stroke="${track}" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="26" stroke="${track}" stroke-width="4" stroke-opacity="0.14"/>
    <circle cx="56" cy="56" r="14" stroke="${track}" stroke-width="4" stroke-opacity="0.14"/>
    <path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0" stroke="${RING.audience}" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke="${RING.commercial}" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke="${RING.brand}" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0" stroke="${RING.performance}" stroke-width="5" stroke-linecap="round" fill="none"/>
  </svg>`;
const MARK_ON_DARK = mark("#FFFFFF");
const MARK_ON_LIGHT = mark("#0E0E0E");

/** The faint rings watermark: the mark's arc tracks in ink with the outer arc in its colour, oversized off the card's
 *  foot-right, behind the text-led cards — the same treatment as the brand book (client/components/book/mark.tsx). */
const WATERMARK = `<svg class="rings-wm" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <circle cx="56" cy="56" r="50" stroke="#0E0E0E" stroke-width="1.2" stroke-opacity="0.05"/>
    <circle cx="56" cy="56" r="38" stroke="#0E0E0E" stroke-width="1.2" stroke-opacity="0.05"/>
    <circle cx="56" cy="56" r="26" stroke="#0E0E0E" stroke-width="1.2" stroke-opacity="0.05"/>
    <circle cx="56" cy="56" r="14" stroke="#0E0E0E" stroke-width="1.2" stroke-opacity="0.05"/>
    <path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0" stroke="${RING.audience}" stroke-width="1.4" stroke-opacity="0.14" stroke-linecap="round" fill="none"/>
  </svg>`;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const photo = (url: string | null | undefined, pos = "50% 30%"): string =>
  url ? `<div class="bg"><img src="${esc(url)}" alt="" style="object-position:${pos}"></div>` : `<div class="bg blank"></div>`;
/** A long display line steps down so it never runs off the card. */
const fit = (text: string, max: number, min: number, fits: number): number => {
  const n = String(text ?? "").length;
  return n <= fits ? max : Math.max(min, Math.round(max * Math.sqrt(fits / n)));
};
const compactN = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)).replace(/\.0([KM])$/, "$1");

function cobrand(brand: { name: string; logo?: string | null }): string {
  return `<div class="cobrand rise">
        ${brand.logo
          ? `<span class="logo-chip"><img class="brand-logo" src="${esc(brand.logo)}" alt="${esc(brand.name)}"></span>`
          : `<span class="brand-namemark">${esc(brand.name)}</span>`}
        <span class="cobrand-x">&times;</span>
        ${MARK_ON_LIGHT}
      </div>`;
}

// ── cards ───────────────────────────────────────────────────────────────────────
function coverCard(c: Extract<AnyCard, { type: "cover" }>): string {
  const name = c.nameLines.join(" ").trim();
  const size = fit(name, 64, 40, 12);
  const stats = c.stats.map((s) => `<div class="cs"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("");
  return `<article class="card dark c-cover" data-tone="dark" aria-label="Cover — ${esc(name)}">
  ${photo(c.image, "50% 22%")}
  <div class="scrim s-hero"></div>
  <div class="inner end">
    <div class="cardmark rise">${MARK_ON_DARK}<span class="cardmark-label">Nomila &middot; Nomi Card</span></div>
    <h1 class="cover-name rise d1" style="font-size:${size}px">${c.nameLines.map(esc).join("<br>")}</h1>
    ${c.hook ? `<p class="cover-hook rise d2">${esc(c.hook)}</p>` : ""}
    ${c.meta ? `<div class="cover-meta rise d3">${esc(c.meta)}</div>` : ""}
    ${stats ? `<div class="cover-stats rise d4">${stats}</div>` : ""}
  </div>
</article>`;
}

/** The M.I.A. ring on the dark card: one white arc of the score's share on the white track, with a soft glow
 *  (DESIGN.md §10 — no stored contributions on a kit, so one arc, never invented bands). */
function ring(value: number, max: number): string {
  const pct = max ? clamp((value / max) * 100) / 100 : 0;
  const r = 70, c = 2 * Math.PI * r;
  return `<svg class="mia-ring" viewBox="0 0 168 168" aria-hidden="true">
      <circle cx="84" cy="84" r="${r}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="14"/>
      <circle class="arc glow" cx="84" cy="84" r="${r}" fill="none" stroke="#FFFFFF" stroke-opacity=".18" stroke-width="22" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 84 84)"/>
      <circle class="arc" cx="84" cy="84" r="${r}" fill="none" stroke="#FFFFFF" stroke-width="14" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 84 84)"/>
    </svg>`;
}

function indexCard(c: Extract<AnyCard, { type: "index" }>): string {
  return `<article class="card black c-index" data-tone="dark" aria-label="M.I.A. — ${c.value} of ${c.max}">
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    <div class="ring-wrap rise d1">
      ${ring(c.value, c.max)}
      <div class="ring-num"><b data-count="${c.value}">${c.value}</b><span>of ${c.max}</span></div>
    </div>
    ${c.verdict ? `<p class="index-verdict rise d2">${esc(c.verdict)}</p>` : ""}
    <p class="caption on-dark rise d3">M.I.A. &mdash; Nomila&rsquo;s read of her marketability, out of ${c.max}.</p>
    <div class="index-mark rise d4">${MARK_ON_DARK}<span>Nomila</span></div>
  </div>
</article>`;
}

function audienceCard(c: Extract<AnyCard, { type: "audience" }>): string {
  const ages = c.ages ?? [];
  const maxAge = Math.max(1, ...ages.map((a) => a.pct));
  const plats = (c.platforms ?? []).filter((p) => p.pct > 0);
  const charted = ages.length > 0 || plats.length > 0;
  const genders = (c.genders ?? []).map((g) => `${g.pct}% ${esc(g.label.toLowerCase())}`).join(" &middot; ");
  const geo = (charted ? c.geo.slice(0, 3) : c.geo).map((g) => {
    const w = g.pct == null ? 0 : clamp(g.pct);
    return `<div class="bar-row"><span class="bl">${esc(g.label)}</span><span class="bt"><i style="--w:${w}%"></i></span><span class="bv">${g.pct == null ? "" : `${Math.round(g.pct)}%`}</span></div>`;
  }).join("");
  const ageCols = ages.length
    ? `<div class="label sm">Age</div><div class="ages">${ages.map((a) => `<div class="ac"><span class="av">${a.pct}%</span><i style="--h:${Math.round((a.pct / maxAge) * 100)}%"></i><span class="al">${esc(a.label)}</span></div>`).join("")}</div>`
    : "";
  const platforms = plats.length
    ? `<div class="plat"><div class="pbar">${plats.map((p, i) => `<i class="p${Math.min(i, 3)}" style="--w:${p.pct}%"></i>`).join("")}</div><div class="plab">${plats.map((p, i) => `<span><b class="pd p${Math.min(i, 3)}"></b>${esc(p.label)} ${compactN(p.n)}</span>`).join("")}</div></div>`
    : "";
  const foot = c.stats.map((s) => `<div class="fs"><b>${esc(s.n)}</b><span>${esc(s.k)}</span></div>`).join("");
  return `<article class="card light c-aud" data-tone="light" aria-label="Audience — ${esc(c.headline)}">
  <div class="aud-photo">${c.bg ? `<img src="${esc(c.bg)}" alt="">` : ""}<span class="chip on-photo rise">${esc(c.eyebrow)}</span></div>
  <div class="aud-panel">
    <div class="aud-big rise d1">${c.share != null ? `<b data-count="${c.share}" data-suffix="%">${c.share}%</b>` : ""}<span>${esc(c.headline)}</span></div>
    ${genders ? `<div class="caption rise d1">${genders}</div>` : ""}
    ${c.sub ? `<div class="label sm rise d2">${esc(c.sub)}</div>` : ""}
    ${ageCols ? `<div class="rise d3">${ageCols}</div>` : ""}
    ${geo ? `<div class="bars rise d3">${geo}</div>` : ""}
    <div class="foot rise d4">${charted && platforms ? platforms : foot}</div>
  </div>
</article>`;
}

function contentCard(c: Extract<AnyCard, { type: "content" }>): string {
  const tiles = c.tiles.map((t, i) => `<div class="tile">
      ${t.image ? `<img src="${esc(t.image)}" alt="">` : ""}
      ${i === 0 ? `<span class="rank">#1 post</span>` : ""}
      <div class="tv"><b>${esc(t.stat)}</b><span>views</span></div>
    </div>`).join("");
  return `<article class="card light c-content" data-tone="light" aria-label="Top content">
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    ${c.heroStat?.value ? `<div class="hero-stat rise d1"><b>${esc(c.heroStat.value)}</b><span>${esc(c.heroStat.label)}</span></div>` : ""}
    ${c.note ? `<p class="lead rise d1">${esc(c.note)}</p>` : ""}
    <div class="tiles rise d2${c.tiles.length === 3 ? " n3" : ""}">${tiles}</div>
  </div>
</article>`;
}

function videoCard(c: Extract<AnyCard, { type: "video" }>): string {
  return `<article class="card dark c-video" data-tone="dark" aria-label="In motion — autoplaying clip">
  <div class="bg vid">
    <video autoplay muted loop playsinline preload="metadata"${c.posterUrl ? ` poster="${esc(c.posterUrl)}"` : ""}>
      <source src="${esc(c.videoUrl)}" type="video/mp4">
    </video>
  </div>
  <span class="motion-dot" aria-hidden="true"></span>
  <div class="scrim s-foot"></div>
  <div class="inner end">
    <div class="label on-dark rise">${esc(c.eyebrow)}</div>
    <p class="photo-line rise d1">${esc(c.note)}</p>
  </div>
</article>`;
}

function whyFitsCard(c: Extract<AnyCard, { type: "whyFits" }>): string {
  const reasons = c.reasons.map((r, i) => `<div class="num-row rise d${Math.min(i + 2, 5)}">
        <span class="nr-n">${String(i + 1).padStart(2, "0")}</span>
        <div><div class="nr-h">${esc(r.head)}</div><div class="nr-i">${esc(r.insight)}</div></div>
      </div>`).join("");
  return `<article class="card light c-why" data-tone="light" aria-label="Why she fits ${esc(c.brand.name)}">
  ${WATERMARK}
  <div class="inner">
    ${cobrand(c.brand)}
    <div class="label rise">${esc(c.eyebrow)}</div>
    <p class="lead rise d1">${esc(c.lead)}</p>
    <div class="num-list">${reasons}</div>
    <div class="caption foot-line rise d5">${esc(c.brand.name)}${c.brand.category ? ` &middot; ${esc(c.brand.category)}` : ""} &middot; ${c.confidence.level === "inferred" ? "inferred from public signals" : "matched by Nomila"}</div>
  </div>
</article>`;
}

function storyCard(c: Extract<AnyCard, { type: "story" }>): string {
  const beats = c.beats.map((b, i) => `<div class="beat${b.current ? " now" : ""} rise d${Math.min(i + 2, 5)}">
        <span class="beat-yr">${esc(b.year)}</span><span class="beat-dot"></span>
        <div><div class="beat-where">${esc(b.where)}</div><div class="beat-line">${esc(b.line)}</div></div>
      </div>`).join("");
  return `<article class="card light c-story" data-tone="light" aria-label="The story">
  ${WATERMARK}
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    <div class="rail">${beats}</div>
    ${c.close ? `<p class="lead close rise d5">${esc(c.close)}</p>` : ""}
  </div>
</article>`;
}

function valuesCard(c: Extract<AnyCard, { type: "values" }>): string {
  const planks = c.planks.map((p, i) => `<div class="plank rise d${Math.min(i + 2, 5)}"><b>${esc(p.name)}</b>${p.line ? `<span>${esc(p.line)}</span>` : ""}</div>`).join("");
  return `<article class="card light c-vals" data-tone="light" aria-label="What she stands for">
  ${WATERMARK}
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    <h2 class="statement rise d1" style="font-size:${fit(c.statement, 26, 18, 60)}px">${esc(c.statement)}</h2>
    <div class="planks">${planks}</div>
    ${c.note ? `<div class="caption foot-line rise d5">${esc(c.note)}</div>` : ""}
    ${c.confidence.level === "self_reported" ? `<div class="caption prov rise d5">Self-declared &mdash; the athlete&rsquo;s own words, not a Nomila claim.</div>` : ""}
  </div>
</article>`;
}

function achievementsCard(c: Extract<AnyCard, { type: "achievements" }>): string {
  const rows = c.entries.map((e, i) => `<div class="rec-row rise d${Math.min(i + 2, 5)}"><span class="ry">${esc(e.year)}</span><span class="rn">${esc(e.name)}</span>${e.level ? `<span class="rl">${esc(e.level)}</span>` : ""}</div>`).join("");
  return `<article class="card light c-ach" data-tone="light" aria-label="The record">
  ${WATERMARK}
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    <div class="ach-hero rise d1">
      ${c.heroEntry.badge ? `<span class="chip act">${esc(c.heroEntry.badge)}</span>` : ""}
      <div class="ach-name">${esc(c.heroEntry.name)}</div>
      <div class="caption">${[esc(c.heroEntry.year), esc(c.heroEntry.detail)].filter(Boolean).join(" &middot; ")}</div>
    </div>
    <div class="rec-rows">${rows}</div>
    ${c.footnote ? `<div class="caption foot-line rise d5">${esc(c.footnote)}</div>` : ""}
  </div>
</article>`;
}

function fitCard(c: Extract<AnyCard, { type: "fit" }>, firstName: string): string {
  const chips = c.tags.map((t) => `<span class="chip on-photo">${esc(t)}</span>`).join("");
  return `<article class="card dark c-fit" data-tone="dark" aria-label="Brand fit">
  ${photo(c.image)}
  <div class="scrim s-deep"></div>
  <div class="inner end">
    <div class="label on-dark rise">${esc(c.eyebrow)}</div>
    <h2 class="photo-title rise d1" style="font-size:${fit(c.lead, 30, 20, 40)}px">${esc(c.lead)}</h2>
    ${chips ? `<div class="chips rise d2">${chips}</div>` : ""}
    <button class="cta rise d3" id="ctaShare">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>
      Partner with ${esc(firstName)}
    </button>
    <div class="caption on-dark center rise d4">Share this Nomi Card by text or email</div>
  </div>
</article>`;
}

function ideaCard(
  c: { eyebrow: string; title: string; line: string; lineEmphasis: string; facets: string[]; note: string },
  image: string | null | undefined, brand: { name: string; logo?: string | null } | null, label: string,
): string {
  const facets = c.facets.map((f) => `<span class="chip on-photo">${esc(f)}</span>`).join("");
  return `<article class="card dark c-idea" data-tone="dark" aria-label="${label} — ${esc(c.title)}">
  ${photo(image)}
  <div class="scrim s-deep"></div>
  <div class="inner end">
    ${brand ? `<div class="idea-top">${cobrand(brand).replace(MARK_ON_LIGHT, MARK_ON_DARK).replace('class="cobrand rise"', 'class="cobrand on-dark rise"')}</div>` : ""}
    <div class="label on-dark rise">${esc(c.eyebrow)}</div>
    <h2 class="photo-title rise d1" style="font-size:${fit(c.title, 34, 22, 24)}px">${esc(c.title)}</h2>
    <p class="photo-line rise d2">${esc(c.line)} <b>${esc(c.lineEmphasis)}</b></p>
    ${facets ? `<div class="chips rise d3">${facets}</div>` : ""}
    ${c.note ? `<div class="caption on-dark rise d4">${esc(c.note)}</div>` : ""}
  </div>
</article>`;
}

function activationPlanCard(c: Extract<AnyCard, { type: "activationPlan" }>): string {
  const rows = c.buckets.map((b, i) => `<div class="num-row rise d${Math.min(i + 2, 5)}">
        <span class="nr-n">${String(i + 1).padStart(2, "0")}</span>
        <div><div class="nr-h">${esc(b.label)} <span class="nr-aud">${esc(b.audience)}</span></div><div class="nr-i">${esc(b.line)}</div></div>
      </div>`).join("");
  return `<article class="card light c-plan" data-tone="light" aria-label="All year — ${esc(c.lead)}">
  ${WATERMARK}
  <div class="inner">
    <div class="label rise">${esc(c.eyebrow)}</div>
    <p class="lead rise d1">${esc(c.lead)}</p>
    <div class="num-list">${rows}</div>
    ${c.close ? `<div class="caption foot-line rise d5">${esc(c.close)}</div>` : ""}
  </div>
</article>`;
}

function renderDeck(kit: Kit): string {
  const firstName = kit.identity.name.split(" ")[0] || kit.identity.name;
  const byId = new Map(kit.cards.map((c) => [c.id, c]));
  const order = kit.deck?.length ? kit.deck : kit.cards.map((c) => c.id);
  return order.map((id) => {
    const c = byId.get(id);
    if (!c) return "";
    switch (c.type) {
      case "cover":           return coverCard(c);
      case "index":           return indexCard(c);
      case "audience":        return audienceCard(c);
      case "content":         return contentCard(c);
      case "video":           return videoCard(c);
      case "whyFits":         return whyFitsCard(c);
      case "story":           return storyCard(c);
      case "values":          return valuesCard(c);
      case "achievements":    return achievementsCard(c);
      case "fit":             return fitCard(c, firstName);
      case "campaignConcept": return ideaCard(c, c.image ?? c.brandImage ?? null, c.brand, "Campaign concept");
      case "signatureIdea":   return ideaCard(c, c.image, null, "The idea");
      case "activationPlan":  return activationPlanCard(c);
      default:                return "";
    }
  }).join("\n\n      ");
}

function pitchText(kit: Kit): string {
  const cover = kit.cards.find((c) => c.type === "cover") as Extract<AnyCard, { type: "cover" }> | undefined;
  const index = kit.cards.find((c) => c.type === "index") as Extract<AnyCard, { type: "index" }> | undefined;
  return [
    `${kit.identity.name} — ${cover?.meta ?? [kit.identity.sport, kit.identity.school].filter(Boolean).join(" · ")}.`,
    cover?.stats?.length ? cover.stats.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(" · ") + "." : null,
    index ? `Nomila M.I.A. ${index.value}/${index.max}.` : null,
    "See the full Nomi Card at Nomila.",
  ].filter(Boolean).join("\n");
}

export function renderNomila(kit: Kit): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<title>${esc(kit.identity.name)} — Nomi Card · Nomila</title>
<style>
${CSS}
</style>
</head>
<body>

<div class="stage">
  <div class="frame" id="frame">
    <div class="progress" id="progress" aria-hidden="true"></div>
    <div class="deck" id="deck">

      ${renderDeck(kit)}

    </div><!-- /deck -->
    <div class="actions">
      <button class="abtn" id="btnPrev" aria-label="Previous card"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
      <button class="abtn share" id="btnShare" aria-label="Share this Nomi Card"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg></button>
      <button class="abtn" id="btnNext" aria-label="Next card"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="toast" id="toast">Link copied &mdash; share it by text or email</div>
  </div><!-- /frame -->
  <div class="stage-cap">${MARK_ON_LIGHT}<span>Nomila &middot; swipe or tap through the Nomi Card</span></div>
</div>

<script>
var __PITCH__ = ${JSON.stringify(pitchText(kit)).replace(/</g, "\\u003c")};
${SCRIPT}
</script>
</body>
</html>`;
}

// ── The look (DESIGN.md: Bold palette, Outfit roles, corners, scrims) ──────────────────────────────
const CSS = String.raw`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');
:root{--ink:#0E0E0E;--ink2:#3A3A3A;--mute:#6B6B6B;--quiet:#9A9A98;--line:#E4E4E2;--ground:#F3F3F1;--paper:#FFFFFF;--track:#E9E9E7;--act:#C8325A;--act-soft:#FCEEF2;--act-ink:#9B1F45;--r:16px;--sans:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{height:100%;}
body{font-family:var(--sans);background:var(--ground);color:var(--ink);display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;-webkit-font-smoothing:antialiased;}
.stage{display:flex;flex-direction:column;align-items:center;gap:14px;}
.stage-cap{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);}
.stage-cap .nomila-mark{width:16px;height:16px;}
.frame{position:relative;width:min(354px, calc(100vw - 20px));height:min(630px, calc(100vh - 64px));border-radius:var(--r);background:var(--paper);box-shadow:0 24px 60px -24px rgba(14,14,14,.28),0 2px 10px rgba(14,14,14,.06);overflow:hidden;touch-action:pan-y;user-select:none;-webkit-user-select:none;}
.progress{position:absolute;top:12px;left:14px;right:14px;z-index:40;display:flex;gap:4px;pointer-events:none;}
.seg{flex:1;height:3px;border-radius:99px;background:rgba(255,255,255,.34);overflow:hidden;position:relative;}
.seg::after{content:"";position:absolute;inset:0;border-radius:99px;background:#FFFFFF;transform:scaleX(0);transform-origin:left;transition:transform .45s cubic-bezier(.22,.9,.24,1);}
.seg.on::after{transform:scaleX(1);}
.frame.on-light .seg{background:rgba(14,14,14,.12);}
.frame.on-light .seg::after{background:var(--ink);}
.deck{position:absolute;inset:0;cursor:grab;}
.deck:active{cursor:grabbing;}
.card{position:absolute;inset:0;overflow:hidden;background:var(--paper);transition:transform .55s cubic-bezier(.32,.9,.28,1), opacity .4s ease;will-change:transform;}
.card.dark{background:#2A2A2A;}
.card.black{background:var(--ink);}
.card.gone{transform:translateX(-118%) rotate(-6deg);}
.card.active{transform:none;z-index:10;}
.card.under{transform:scale(.95) translateY(10px);z-index:5;filter:brightness(.92);}
.card.deep{transform:scale(.9) translateY(18px);opacity:0;z-index:1;}
.card.dragging{transition:none;}
.bg{position:absolute;inset:0;overflow:hidden;}
.bg.blank{background:#2A2A2A;}
.bg img{width:100%;height:100%;object-fit:cover;display:block;}
.card.live .bg img{animation:push 16s ease-out both;}
@keyframes push{from{transform:scale(1.06);}to{transform:scale(1);}}
.scrim{position:absolute;inset:0;}
.scrim.s-hero{background:linear-gradient(180deg,rgba(0,0,0,.45) 0%,rgba(0,0,0,0) 32%,rgba(0,0,0,.08) 52%,rgba(0,0,0,.86) 100%);}
.scrim.s-deep{background:linear-gradient(180deg,rgba(0,0,0,.45) 0%,rgba(0,0,0,.1) 30%,rgba(0,0,0,.55) 58%,rgba(0,0,0,.9) 100%);}
.scrim.s-foot{background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,0) 38%,rgba(0,0,0,.82) 100%);}
.inner{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;padding:40px 22px 92px;overflow-y:auto;scrollbar-width:none;}
.inner::-webkit-scrollbar{display:none;}
.inner.end{justify-content:flex-end;}
.rise{opacity:0;transform:translateY(16px);}
.card.live .rise{opacity:1;transform:none;transition:opacity .55s ease, transform .65s cubic-bezier(.2,.85,.25,1);}
.card.live .rise.d1{transition-delay:.08s;}.card.live .rise.d2{transition-delay:.18s;}.card.live .rise.d3{transition-delay:.3s;}.card.live .rise.d4{transition-delay:.42s;}.card.live .rise.d5{transition-delay:.54s;}
/* type roles (DESIGN.md §3b) */
.label{font-size:11px;font-weight:800;letter-spacing:.12em;line-height:13px;text-transform:uppercase;color:var(--mute);}
.label.sm{font-size:10px;margin-top:12px;}
.label.on-dark,.caption.on-dark{color:rgba(255,255,255,.72);}
.caption{font-size:12px;font-weight:500;line-height:16px;color:var(--mute);}
.caption.center{text-align:center;margin-top:10px;}
.lead{margin-top:10px;font-size:20px;font-weight:800;line-height:1.2;letter-spacing:-.2px;color:var(--ink);}
.statement{margin-top:10px;font-weight:900;line-height:1.08;letter-spacing:-.5px;text-transform:uppercase;color:var(--ink);}
.photo-title{margin-top:10px;font-weight:900;line-height:1;letter-spacing:-.6px;text-transform:uppercase;color:#FFFFFF;text-wrap:balance;}
.photo-line{margin-top:10px;font-size:17px;font-weight:600;line-height:1.3;color:rgba(255,255,255,.94);}
.photo-line b{font-weight:900;color:#FFFFFF;box-shadow:inset 0 -2px 0 rgba(255,255,255,.9);}
.foot-line{margin-top:auto;padding-top:16px;}
.chip{display:inline-flex;align-items:center;height:24px;padding:0 11px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;background:var(--ground);color:var(--ink);}
.chip.on-photo{background:#FFFFFF;color:var(--ink);}
.chip.act{background:var(--act);color:#FFFFFF;}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
/* the mark treatment */
.cardmark{display:flex;align-items:center;gap:9px;margin-bottom:10px;}
.cardmark .nomila-mark{width:24px;height:24px;flex:none;}
.cardmark-label{font-size:11px;font-weight:800;letter-spacing:.26em;text-transform:uppercase;color:#FFFFFF;}
.rings-wm{position:absolute;right:-38%;bottom:-15%;width:120%;aspect-ratio:1;z-index:1;pointer-events:none;}
.cobrand{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
.logo-chip{background:#FFFFFF;border:1px solid var(--line);border-radius:999px;height:36px;padding:0 14px;display:inline-flex;align-items:center;}
.logo-chip .brand-logo{height:20px;max-width:110px;object-fit:contain;display:block;}
.brand-namemark{font-size:15px;font-weight:900;letter-spacing:.02em;text-transform:uppercase;color:var(--ink);}
.cobrand-x{font-size:14px;font-weight:600;color:var(--quiet);}
.cobrand .nomila-mark{width:24px;height:24px;flex:none;}
.cobrand.on-dark .logo-chip{border-color:transparent;}
.cobrand.on-dark .brand-namemark{color:#FFFFFF;}
.cobrand.on-dark .cobrand-x{color:rgba(255,255,255,.7);}
.idea-top{position:absolute;top:34px;left:22px;right:22px;}
/* cover */
.cover-name{font-weight:900;line-height:.9;letter-spacing:-2px;text-transform:uppercase;color:#FFFFFF;}
.cover-hook{margin-top:12px;font-size:17px;font-weight:700;line-height:1.28;color:#FFFFFF;max-width:300px;}
.cover-meta{margin-top:14px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.72);}
.cover-stats{display:flex;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.2);}
.cover-stats .cs{flex:1;}
.cover-stats .cs + .cs{padding-left:12px;border-left:1px solid rgba(255,255,255,.2);}
.cs b{display:block;font-size:22px;font-weight:900;line-height:1;color:#FFFFFF;letter-spacing:-.5px;}
.cs span{display:block;margin-top:4px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.62);}
/* M.I.A. — the dark card */
.c-index .inner{justify-content:center;align-items:center;text-align:center;}
.ring-wrap{position:relative;width:200px;height:200px;margin:22px auto 0;}
.mia-ring{width:100%;height:100%;}
.mia-ring .arc{transition:stroke-dasharray 1.1s cubic-bezier(.25,.9,.3,1);}
.ring-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.ring-num b{font-size:60px;font-weight:900;letter-spacing:-2.5px;line-height:1;color:#FFFFFF;}
.ring-num span{margin-top:4px;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.6);}
.index-verdict{margin-top:22px;font-size:20px;font-weight:800;line-height:1.22;color:#FFFFFF;max-width:290px;}
.c-index .caption{margin-top:10px;max-width:260px;}
.index-mark{margin-top:22px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:900;letter-spacing:.34em;text-transform:uppercase;color:#FFFFFF;}
.index-mark .nomila-mark{width:18px;height:18px;}
/* audience */
.aud-photo{position:absolute;top:0;left:0;right:0;height:36%;overflow:hidden;background:#2A2A2A;}
.aud-photo img{width:100%;height:100%;object-fit:cover;display:block;}
.aud-photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.4) 0%,rgba(0,0,0,0) 45%);}
.aud-photo .chip{position:absolute;top:30px;left:22px;z-index:2;}
.aud-panel{position:absolute;left:0;right:0;bottom:0;top:36%;z-index:2;padding:18px 22px 92px;display:flex;flex-direction:column;overflow-y:auto;scrollbar-width:none;}
.aud-big{display:flex;align-items:baseline;gap:10px;}
.aud-big b{font-size:64px;font-weight:900;letter-spacing:-2.5px;line-height:.9;color:var(--ink);}
.aud-big span{font-size:17px;font-weight:900;line-height:1.05;letter-spacing:.02em;text-transform:uppercase;color:var(--ink);}
.bars{margin-top:12px;display:flex;flex-direction:column;gap:8px;}
.bar-row{display:grid;grid-template-columns:72px 1fr 38px;align-items:center;gap:10px;}
.bar-row .bl{font-size:13px;font-weight:600;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar-row .bt{height:6px;border-radius:3px;background:var(--track);overflow:hidden;}
.bar-row .bt i{display:block;height:100%;width:0;border-radius:3px;background:var(--ink);transition:width .9s cubic-bezier(.25,.9,.3,1) .3s;}
.card.live .bar-row .bt i{width:var(--w);}
.bar-row .bv{font-size:13px;font-weight:800;text-align:right;color:var(--ink);}
.ages{margin-top:6px;height:56px;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:6px;align-items:end;}
.ac{height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;}
.ac i{display:block;width:100%;height:var(--h);min-height:2px;border-radius:4px 4px 2px 2px;background:var(--ink);}
.ac .av{font-size:10px;font-weight:800;color:var(--ink);margin-bottom:2px;}
.ac .al{margin-top:3px;font-size:9px;font-weight:700;color:var(--mute);white-space:nowrap;}
.foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--line);display:flex;}
.foot .fs{flex:1;}
.foot .fs + .fs{border-left:1px solid var(--line);padding-left:12px;}
.fs b{display:block;font-size:20px;font-weight:900;letter-spacing:-.5px;line-height:1;color:var(--ink);}
.fs span{display:block;margin-top:4px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);}
.plat{width:100%;}
.pbar{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--track);}
.pbar i{display:block;height:100%;width:var(--w);}
.p0{background:var(--ink);}.p1{background:#6B6B6B;}.p2{background:#9A9A98;}.p3{background:#CFCFCC;}
.plab{margin-top:7px;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);}
.plab .pd{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:-1px;}
/* content */
.hero-stat{margin-top:12px;display:flex;align-items:baseline;gap:8px;}
.hero-stat b{font-size:44px;font-weight:900;letter-spacing:-2px;line-height:1;color:var(--ink);}
.hero-stat span{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);}
.c-content .lead{font-size:17px;font-weight:700;}
.tiles{flex:1;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;min-height:220px;}
.tiles.n3{grid-template-rows:1.15fr 1fr;}
.tiles.n3 .tile:first-child{grid-column:1 / -1;}
.tile{position:relative;border-radius:var(--r);overflow:hidden;background:var(--ground);}
.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.tile::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 45%,rgba(0,0,0,.78) 100%);}
.tile .tv{position:absolute;left:10px;right:8px;bottom:9px;z-index:2;}
.tile .tv b{display:block;font-size:24px;font-weight:900;letter-spacing:-.8px;line-height:1;color:#FFFFFF;}
.tile .tv span{display:block;margin-top:2px;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.75);}
.tile .rank{position:absolute;top:8px;left:8px;z-index:2;height:22px;display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;background:var(--act);color:#FFFFFF;font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;}
/* video */
.bg.vid video{width:100%;height:100%;object-fit:cover;display:block;}
.motion-dot{position:absolute;top:28px;right:22px;z-index:7;width:9px;height:9px;border-radius:50%;background:var(--act);box-shadow:0 0 0 0 rgba(200,50,90,.55);animation:motionpulse 2s ease-out infinite;}
@keyframes motionpulse{0%{box-shadow:0 0 0 0 rgba(200,50,90,.55);}70%{box-shadow:0 0 0 9px rgba(200,50,90,0);}100%{box-shadow:0 0 0 0 rgba(200,50,90,0);}}
/* numbered lists (why she fits, all year) */
.num-list{margin-top:18px;display:flex;flex-direction:column;gap:14px;}
.num-row{display:flex;gap:12px;align-items:flex-start;}
.nr-n{flex:none;width:24px;font-size:15px;font-weight:900;color:var(--act);padding-top:1px;}
.num-row:not(:first-child) .nr-n{color:var(--ink);}
.nr-h{font-size:15px;font-weight:800;line-height:19px;color:var(--ink);}
.nr-aud{margin-left:4px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);}
.nr-i{margin-top:2px;font-size:14px;font-weight:400;line-height:20px;color:var(--ink2);}
/* story */
.rail{margin-top:16px;display:flex;flex-direction:column;}
.beat{display:grid;grid-template-columns:44px 14px 1fr;gap:10px;align-items:start;padding:9px 0;position:relative;}
.beat-yr{font-size:15px;font-weight:900;color:var(--ink);letter-spacing:-.3px;}
.beat-dot{width:10px;height:10px;border-radius:50%;background:var(--line);margin:4px auto 0;}
.beat::before{content:"";position:absolute;left:51px;top:16px;bottom:-9px;width:1px;background:var(--line);}
.beat:last-child::before{display:none;}
.beat.now .beat-dot{background:var(--act);box-shadow:0 0 0 4px var(--act-soft);}
.beat-where{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);}
.beat-line{margin-top:2px;font-size:15px;font-weight:600;line-height:20px;color:var(--ink);}
.lead.close{margin-top:auto;padding-top:16px;font-size:18px;}
/* values */
.planks{margin-top:16px;display:flex;flex-direction:column;gap:8px;}
.plank{background:var(--ground);border-radius:var(--r);padding:12px 14px;}
.plank b{display:block;font-size:15px;font-weight:800;color:var(--ink);}
.plank span{display:block;margin-top:2px;font-size:14px;line-height:20px;color:var(--ink2);}
.prov{margin-top:6px;}
/* achievements */
.ach-hero{margin-top:14px;background:var(--ground);border-radius:var(--r);padding:14px;}
.ach-hero .chip{margin-bottom:10px;}
.ach-name{font-size:24px;font-weight:900;line-height:1.02;letter-spacing:-.5px;text-transform:uppercase;color:var(--ink);margin-bottom:6px;}
.rec-rows{margin-top:12px;display:flex;flex-direction:column;}
.rec-row{display:grid;grid-template-columns:46px 1fr auto;gap:10px;align-items:baseline;padding:10px 0;border-top:1px solid var(--line);}
.rec-row:last-child{border-bottom:1px solid var(--line);}
.ry{font-size:14px;font-weight:900;color:var(--ink);}
.rn{font-size:14px;font-weight:600;line-height:19px;color:var(--ink);}
.rl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);}
/* fit */
.cta{margin-top:18px;display:flex;align-items:center;justify-content:center;gap:9px;width:100%;height:48px;border-radius:999px;border:none;cursor:pointer;background:var(--act);color:#FFFFFF;font-family:var(--sans);font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;transition:transform .15s ease;}
.cta:active{transform:scale(.98);}
/* the deck's own controls: grey, with Share as the black pill (the one raspberry is on the cards) */
.actions{position:absolute;left:0;right:0;bottom:16px;z-index:45;display:flex;align-items:center;justify-content:center;gap:16px;}
.abtn{width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,.9);color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.14);transition:transform .15s ease, opacity .3s ease;}
.frame.on-light .abtn{background:var(--ground);box-shadow:none;}
.abtn:active{transform:scale(.96);}
.abtn:disabled{opacity:.35;cursor:default;}
.abtn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;}
.abtn.share,.frame.on-light .abtn.share{width:56px;height:56px;background:var(--ink);color:#FFFFFF;box-shadow:0 10px 24px -8px rgba(0,0,0,.45);}
.abtn.share svg{width:21px;height:21px;}
.toast{position:absolute;left:50%;bottom:86px;z-index:60;transform:translate(-50%,14px);opacity:0;pointer-events:none;background:var(--ink);color:#FFFFFF;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:11px 18px;border-radius:999px;white-space:nowrap;transition:transform .35s cubic-bezier(.2,.9,.3,1), opacity .35s ease;}
.toast.show{transform:translate(-50%,0);opacity:1;}
@media (prefers-reduced-motion: reduce){*{animation:none !important;transition-duration:.01ms !important;}.rise{opacity:1 !important;transform:none !important;}}
@media (max-height:660px){.ring-wrap{width:170px;height:170px;}}`;

const SCRIPT = String.raw`(function(){
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var frame   = document.getElementById("frame");
  var deck    = document.getElementById("deck");
  var cards   = Array.prototype.slice.call(deck.querySelectorAll(".card"));
  var N       = cards.length;
  var idx     = 0;
  var progress = document.getElementById("progress");
  for (var i = 0; i < N; i++){ var s = document.createElement("div"); s.className = "seg"; progress.appendChild(s); }
  var segs = Array.prototype.slice.call(progress.children);
  function runCounters(card){
    Array.prototype.forEach.call(card.querySelectorAll("[data-count]"), function(el){
      var target = parseFloat(el.getAttribute("data-count")); var suffix = el.getAttribute("data-suffix") || "";
      if (reduced){ el.textContent = target + suffix; return; }
      var dur = 1100, t0 = null;
      function step(t){ if (!t0) t0 = t; var p = Math.min((t - t0) / dur, 1); el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))) + suffix; if (p < 1) requestAnimationFrame(step); }
      requestAnimationFrame(step);
    });
  }
  function render(){
    if (!N) return;
    cards.forEach(function(c, i){
      c.classList.remove("gone","active","under","deep","live"); c.style.transform = "";
      if (i < idx) c.classList.add("gone"); else if (i === idx) c.classList.add("active");
      else if (i === idx + 1) c.classList.add("under"); else c.classList.add("deep");
    });
    segs.forEach(function(s, i){ s.classList.toggle("on", i <= idx); });
    frame.classList.toggle("on-light", cards[idx].getAttribute("data-tone") === "light");
    document.getElementById("btnPrev").disabled = (idx === 0);
    document.getElementById("btnNext").disabled = (idx === N - 1);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ cards[idx].classList.add("live"); runCounters(cards[idx]); }); });
  }
  function next(){ if (idx < N - 1){ idx++; render(); } }
  function prev(){ if (idx > 0){ idx--; render(); } }
  var dragging = false, startX = 0, startY = 0, dx = 0, moved = false;
  deck.addEventListener("pointerdown", function(e){ if (!N || e.target.closest("button, a")) return; dragging = true; moved = false; startX = e.clientX; startY = e.clientY; dx = 0; cards[idx].classList.add("dragging"); deck.setPointerCapture(e.pointerId); });
  deck.addEventListener("pointermove", function(e){ if (!dragging) return; dx = e.clientX - startX; var dy = e.clientY - startY; if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true; var d = dx; if ((idx === 0 && dx > 0) || (idx === N - 1 && dx < 0)) d = dx * 0.28; cards[idx].style.transform = "translateX(" + d + "px) rotate(" + (d / 26) + "deg)"; });
  function endDrag(e){
    if (!dragging) return; dragging = false; var card = cards[idx]; card.classList.remove("dragging"); card.style.transform = "";
    if (dx < -70 && idx < N - 1) next();
    else if (dx > 70 && idx > 0) prev();
    else if (!moved && e && e.type === "pointerup" && !e.target.closest("button, a")){ var rect = deck.getBoundingClientRect(); if ((e.clientX - rect.left) / rect.width < 0.32) prev(); else next(); }
    dx = 0;
  }
  deck.addEventListener("pointerup", endDrag);
  deck.addEventListener("pointercancel", endDrag);
  document.getElementById("btnPrev").addEventListener("click", prev);
  document.getElementById("btnNext").addEventListener("click", next);
  document.addEventListener("keydown", function(e){ if (e.key === "ArrowRight") next(); if (e.key === "ArrowLeft") prev(); });
  var toast = document.getElementById("toast"), toastTimer = null;
  function showToast(){ toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(function(){ toast.classList.remove("show"); }, 2800); }
  var PITCH = (typeof __PITCH__ !== "undefined") ? __PITCH__ : document.title;
  function share(){ if (navigator.share){ navigator.share({ title: document.title, text: PITCH, url: location.href }).then(showToast).catch(function(err){ if (err && err.name !== "AbortError") copyFallback(); }); } else { copyFallback(); } }
  function copyFallback(){ if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(location.href).then(showToast, showToast); } else { showToast(); } }
  document.getElementById("btnShare").addEventListener("click", share);
  var cta = document.getElementById("ctaShare"); if (cta) cta.addEventListener("click", share);
  render();
})();`;
