# Athlete media kit + interactive cards — scoping & design

Status: **Design — for review (no code yet).** The COMPOSE layer (Layer 2) on top of the media
library ([media-library-backfill.md](./media-library-backfill.md)). Turns the owned library + stats
into a **shareable athlete media kit** that presents the athlete to brands. Enrichment (Layer 1) and
AI generation (Layer 3) layer in as this defines what they're for.

## Objective
An athlete taps a button and gets a polished, on-brand **media kit** — audience, best content, rates,
brand fit — that they can **share with a brand** (link + PDF). Everything is composed from data we
already own; the kit is the first thing that consumes the whole library end-to-end.

## What we already have (all green)
| Section input | Source | Status |
|---|---|---|
| Name, sport, school | `athletes` | ✅ |
| Followers/subs per platform | `social_analytics_snapshots` | ✅ |
| Demographics (age/gender/country/city, %) | snapshot `demographics` | ✅ |
| Top content (pixels + reach/views/saves/shares) | `media_assets` (+ enrichment) | ✅ |
| Playable top reels | `media_assets` (mp4) | ✅ |
| Rates (per-platform ranges, deal types) | `athletes_current.rate_card` | ✅ |
| Brand voice / content style | captions (Layer-1 tags later) | partial |

**Greenfield:** the assembler + layout + Gemini copy + render/share. Infra installed but unused:
`@google/genai`, `@google-cloud/vertexai` (`puppeteer` was listed here too; removed 3 Nov 2026, see below).

> **Where the PDF render runs (3 Nov 2026).** `puppeteer` was removed from `package.json` while unused
> (it was never imported). When PDF export is built, the headless-browser render must run in the **per-task job
> model** — a Cloud Run job, per the sandbox design (https://claude.ai/artifact/QDZ6mRjZTtjiu8NvhnhUMP) — and
> **never in the API process**. Add the dependency back to that job, not to the API image.

## Deliverable — recommendation
**Web-first, PDF export second.**
- **Shareable web media kit** at a hosted URL (`nomila-dev.web.app/kit/{token}` or similar) — the modern
  format: reels *play*, tabs, live-ish from data. What athletes actually send brands today.
- **PDF export** — a headless browser (Puppeteer), in a Cloud Run job and never the API, renders the *same* template → GCS → download/email attachment (brands still
  ask for a file).
- **"Interactive cards"** = the kit is built from modular **cards** (audience card, top-post card, rate
  card, brand-fit card). Same cards can be shared **individually** (e.g. drop one killer stat-card into a
  brand DM) — so "media kit" and "interactive cards" are one system at two granularities.

## Sections (v1)
1. **Hero** — name · sport · school, best full-grade photo, headline stat (total reach / combined following).
2. **Audience** — followers per platform (with logos) + demographics (age/gender/top geo).
3. **Top content** — 4–6 top posts (mix of photos + playable reels) with their real stats.
4. **Rates** — per-platform ranges + deal types from the rate card.
5. **Brand fit / narrative** — a Gemini-written blurb (content style + brand voice) grounded in real
   captions + stats. *Derive-don't-invent:* the model writes from supplied facts, never fabricates numbers.
6. **Contact / CTA.**

## Selection logic (v1 = stats-driven, no AI needed yet)
- **Hero image:** highest-reach `full`-grade photo (or top carousel cover).
- **Top content:** top N by reach/engagement, **diversified** (don't pick 5 near-identical shots; mix
  photo + reel; platform-aware). All data we already have.
- **Layer 1 later:** aesthetic/brand-fit/athlete-present tagging refines hero choice + diversity + lets a
  brand-specific kit re-rank ("show me her most *lifestyle* content").

## Architecture — 4 pieces
1. **`assembleMediaKit(athleteId)`** — one service that gathers everything into a `MediaKitData` object
   (profile + audience + demographics + top-content-with-signed-urls + rates + Gemini narrative). The single
   source both the web kit and the PDF render from — compose once, render twice.
2. **Web media kit** — a route/page rendering `MediaKitData` (interactive; reels play). Shareable via a
   token URL.
3. **PDF export** — Puppeteer loads the same template (print CSS) → PDF → GCS → signed/public URL. Runs in a
   per-task Cloud Run job (sandbox design), never in the API.
4. **Trigger UX** — a "Create / Share media kit" action in the app; regenerate as data refreshes.

## Generation trigger / UX
- **v1: on-demand** — athlete taps "Create media kit," we assemble + render, they get a share link + PDF.
- Later: auto-refresh on new data; brand-tailored kits (pick a brand → re-ranked content + tuned copy);
  the "Your Playbook" orchestration that offers generation at the right moment.

## Build order
1. **`assembleMediaKit` + `MediaKitData` contract** — the data spine (reuses `/me/media` top-content +
   rate card + snapshot demographics). Testable on Mia immediately.
2. **Web media kit** (one clean template, the 6 sections) + shareable token URL.
3. **PDF export** (Puppeteer, same template; in a Cloud Run job, never the API).
4. **Trigger UX** in-app.
5. *(layers in)* Layer-1 enrichment → smarter selection + brand-tailored kits; Layer-3 generation → AI
   hero/variant imagery.

## Open decisions
- **Format:** web-first + PDF export (rec) · PDF-only · in-app-only?
- **Sharing:** public link vs signed/expiring vs gated (brand enters email)?
- **Templates:** one clean template for v1 (rec), or offer a couple of looks?
- **"Interactive cards":** confirm the modular-cards interpretation (kit = cards; cards also shareable solo).
