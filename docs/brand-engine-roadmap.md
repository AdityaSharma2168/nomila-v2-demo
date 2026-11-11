# Nomila Brand Engine — vision, architecture & roadmap

Status: **living strategy doc** (started 2026-07-13). Captures the full ideation behind the athlete
media-kit / card system so nothing is lost, and sequences it into step-by-step execution. Companion
to [media-kit.md](./media-kit.md) (COMPOSE scoping) and [media-library-backfill.md](./media-library-backfill.md) (the OWN layer, shipped).

## 1. The reframe
We didn't build a media kit — we built a **verified athlete brand-intelligence engine**. The shareable
**card stack** is its first surface. Everything below plugs into the same engine.

## 2. Capabilities & innovations (the idea backlog — don't lose these)
- **Per-brand morphing kit** — pick a target brand → re-rank content, re-write copy, re-skin tokens. One kit, every brand.
- **Verified-data moat** — every number nomila-owned + un-fakeable; the Marketability Index as an industry standard ("credit score of NIL").
- **Athlete "Wrapped" mode** — same engine, athlete-facing self-discovery → viral acquisition loop (watermark → signups).
- **Playbook (describe → advise → act)** — the kit prescribes ("post more Reels", "connect YouTube → +$X", "3 brands fit now") and connects to the existing deals pipeline.
- **AI brand mockups** — Imagen/Vertex generate a mock sponsored post (athlete + brand product): show, don't tell.
- **Per-card virality** — each card individually shareable/exportable (image or short clip) → Stories.
- **Two-sided marketplace** — every athlete has a verified kit → brands discover + compare; kit is pitch *and* evaluation surface.
- **On-card Concierge** — per-athlete AI, grounded in real data, guardrailed; brands/fans ask + book.
- **In-card payments** — pay to jump the deal queue (genuine interest signal + revenue), 1-1 sessions, Q&A, mentorship.
- **Dynamic actions** — send message / deal request, wired to the deals system.
- **In-card video playback** — play the owned reels (we already have the mp4s) so brands see content without leaving.
- **Living rings** — the arc-mark logo *is* the 4 capitals; each ring fills to the athlete's subscore → a unique "brand fingerprint." Logo = mission = score.
- **Custom card looks (paid tier)** — beyond the library themes (campaign/broadcast/luxe), the athlete describes their own concept → **Fable generates a bespoke theme** → registers as a renderer (the theme-registry seam already supports it). "Make your own look," monetized. See media-kit-specs Spec 7.
- **Card LIBRARY + editable composition** — beyond the fixed 8 card *types* (not themes): a library of card types, a Strategist-composed **default set** per athlete/brand, and the athlete can **reorder/switch/add/remove** (a good pitch is tight, ~7–9). Candidate new cards: **Payments/"Book her"** (pay/book on the card — placeholder now, Stripe later), **"Why she fits you"** (per-brand pitch — Spec 9), **Story/Arc**, **Values/Cause** (advocacy facet), **Achievements**, **Press**, **Partners**, **Contact/close**. Architecture = the Strategist's `cardOrder` (Spec 2) + the athlete **editor** (currently a stub). Each new card = a `Card` type + a per-theme render fn. Design via a focused **Fable pass** (theme-agnostic card *types*, then productionize per theme) — do it WITH the editor, after the brand builds. Ties to idea-backlog: in-card payments · dynamic actions · concierge.

## 3. Architecture — the layers
Render pipeline (top drives the ones below):
1. **Strategist / Director** (composition brain) — reads the profile → decides *which cards, what order, what to hero, what to omit, which narrative strategy*. Input = **f(tier, capitals-shape, goal_archetype, segment, trajectory, confidence)** — all existing fields (see §4/§5).
2. **Template** — structure per theme, authored design-time (once) by Fable 5 / a designer. Card-type layouts + **emphasis variants** (big-hero vs contextual vs omit) + inclusion thresholds. Knows nothing about a specific athlete; a typed renderer over `MediaKitData`.
3. **Tokens** — identity/theme/brand style layer. **Constrained overrides**: theme owns structure + neutrals + type; identity/brand only drives the *accent* + a couple exposed tokens (keeps designs coherent). Athlete tokens (team/photo palette) cached; brand tokens layered per brand.
4. **Content** — bespoke, produced 3 different ways: **stats = deterministic pull** (real, verifiable, never generated) · **images = select (+ optional enhance/generate)** · **copy = narrate (LLM, grounded)** · tokens = derived. **All cached; generation is event-driven, never per-render.**

Cross-cutting:
- **Capability router (model swap layer)** — features call interfaces (`narrate`, `selectImages`, `editImage`, `generateImage`, `generateVideo`, `concierge`); the model behind each is config. Tier by value (cheap/open default, premium on flagged high-value calls). See §7.
- **Agentic team** the kit is a surface for: **Curator** (media selection/enhancement) · **Narrator** (copy) · **Matchmaker** (brand fit + outreach) · **Negotiator** (existing deals system) · **Concierge** (on-card chat/bookings/payments) · **Coach** (Playbook). Event-driven; the kit is what they maintain and where brands interact.

## 4. Cohesive segmentation (the shared vocabulary)
Reuse what exists — do NOT invent a parallel archetype system.
- **Tier = magnitude** (how hard to flex): `Icon / Elite / Established / Rising / Local` (threshold-based on display score; `computeTierFromDisplay`). Mia = Established. Drives the Director's overall confidence/emphasis.
- **`capitals` shape = profile** (which signal to hero): Audience / Athletic / Brand / Commercial. Two same-tier athletes differ by shape → the "niche / creator / broad-reach" variants are *shapes within a tier*, not new tiers.
- **`goal_archetype` = intent** (from onboarding) → tunes narrative + surfaced capabilities.
- **`segment` = context** (pro/olympic/college) → benchmarks + framing.
- **`ptsToNextTier` = trajectory** → powers "on the rise" narratives for lower tiers.
- **Enhancement to do:** promote each tier from a *score band* → a **brand-building playbook** (what the kit emphasizes, what content strategy, what brand types to target, the growth path). Same segmentation then drives scoring → kit → content recs → brand-matching → Strategist. One language, coordinated.
- **Tier naming (decision):** keep internal keys; fix display so **every tier is worded positively + accurately** (`Local → Emerging`, maybe `Rising → Rising Star`). **Do NOT hide lower tiers** — show them consistently (just don't over-emphasize in brand-facing). Rationale: an accurate, well-named segmentation becomes **common industry vernacular** — the tier becomes a standard the market adopts, like the score itself. The reframe engine still leads with strength *within* any tier. Rejected: follower-count ladder (misrepresents multi-dimensional value) and pure geographic ladder (mis-cues reach vs athletic stature). Research: influencer tiers are follower-only ([The Shelf](https://www.theshelf.com/the-blog/influencer-tiers/), [Sprout Social](https://sproutsocial.com/insights/types-of-influencers/)); NIL platforms rank by $ valuation, no named tiers ([On3 NIL Valuations](https://www.on3.com/nil/rankings/player/nil-valuations/)).

## 5. Data-confidence / cold-start layer (foundational, not an edge case)
Some score dimensions are incomplete at cold start — esp. **Commercial** (deals we don't know: e.g. Mia is Adidas-sponsored but hasn't told us and web search missed it). Today a missing signal renders as a real **0**, conflating *"none"* with *"unknown"* — and reframing that 0 as "first-mover upside" for a sponsored athlete is false + trust-destroying.

Fix — a **provenance/confidence primitive** every layer reads:
- **Tag each signal:** Verified (nomila-measured) · Self-reported (athlete) · Inferred (web/estimate) · Unknown.
- **Score distinguishes low vs unknown:** unknown → neutral prior + wider confidence band or excluded; never a real 0.
- **Fill gaps via athlete input (first-class):** onboarding/flow asks past+current deals, sponsorships, rates (self-reported, marked, incentivized: "complete profile → stronger kit + higher verified rate"). Athlete-set rates are first-class over suggested ranges.
- **Kit respects confidence:** Verified shown proudly (moat) · Self-reported lighter ("athlete-provided") · Unknown omitted (no 0). Only reframe a *confident, true* low as upside. → Mia's kit **omits the Commercial card** until Adidas is known, rather than lying.
- **Completeness = growth mechanic** (ties to `ptsToNextTier` + Playbook).

## 6. Design directions (chosen)
Four themes to offer as options; theme = shell, everything else bespoke per athlete (+ per-brand overlay):
- **Campaign** (chosen hero) — cinematic photo × bold kinetic stats; Nike/On/Alo researched.
- **Immersive** — full-bleed cinematic over photos.
- **Broadcast** — matchday/scoreboard, volt+cardinal, ticker.
- **Luxe-v2** — fashion-house campaign (Chanel/Rolex/Gucci), champagne+noir, athlete-as-muse.
Recurring signal: warm-ink + bone + **Stanford cardinal** appeared independently across agents → likely the natural identity palette.
Open detail work (later): image **selection logic** (prefer real images over video posters for hero; §3 Curator), **legibility-aware** text placement over photos, a dedicated **video-play** card, subject-aware crop, real enhancement (Imagen).

## 7. Tooling / model strategy
Build the **capability router** first; pick defaults, bake off later. Sensible defaults:
| Seam | Default | Bake-off | Premium when |
|---|---|---|---|
| Image select + vision tag | Gemini Flash (GCP credits) | Claude vision | rarely |
| Narrative — routine copy | Kimi / Gemini Flash | GLM (free/open) | — |
| Narrative — money copy | Fable 5 / Claude Sonnet | — | low-volume, high-value |
| Concierge chat | Gemini Flash / GLM | Kimi | escalation |
| Image edit/enhance | Gemini 2.5 Flash Image / Vertex Imagen | Flux, Topaz | — |
| Image generation | Vertex Imagen | Flux | brand hero shots |
| Video generation (later) | Veo (Vertex) | Hunyuan (open) | — |
| Card design system | Fable 5 (design-time, once) | human designer | always (one-time) |
**Principle:** cards are **templated (design-time), rendered deterministically (runtime)** — LLMs supply copy + images only, never per-render layout.

## 8. Phased execution plan (step by step)
- **Phase 0 — Foundations & specs (paper + plumbing).** `MediaKitData` + token schemas · data-confidence/provenance primitive · Strategist composition matrix (tier × shape → recipe) + enriched tier playbooks · capability router interface. *(This doc + the schemas.)*
- **Phase 1 — Data spine.** `assembleMediaKit(athleteId)` (model-agnostic; pull stats + select images + narrate via router) → render the **campaign** theme for Mia, static. Validate on real data.
- **Phase 2 — Director + confidence.** Composition adapts to tier×shape; confidence-aware presentation (omit unknowns, reframe true-lows). Stress-test templates on 2-3 contrasting profiles (star / niche / emerging).
- **Phase 3 — Share + edit.** Public link, per-card export, athlete add/drop/reorder/swap-image.
- **Phase 4 — Per-brand morphing.** Brand tokens + re-ranked content + brand-tuned copy.
- **Phase 5 — Concierge + actions + payments.** On-card chat (guardrailed), message/deal-request, pay-to-signal / bookings.
- **Phase 6 — Generation.** AI brand mockups, real image enhancement, video, living rings; athlete "Wrapped" mode; two-sided brand discovery.
- **Ongoing:** model bake-offs per seam; tier-playbook refinement; benchmarks/percentiles.

## 9. Decisions log
- Themes: campaign (hero) + immersive/broadcast/luxe-v2 as options; warm-night & editorial set aside.
- Sharing: public, via link/text/email; per-card sharing in scope.
- Customization: engine recommends; athlete can add/drop/reorder/move images.
- 1 clean look at a time (theme-selectable).
- Model approach: router + swappable providers; GCP-native defaults; premium reserved for creative peaks.
- Tiers: keep internal keys; word every tier positively/accurately; show consistently (don't hide, don't over-emphasize) to build industry vernacular; reframe engine leads with strength within a tier.
- Cards: templated design-time, deterministic runtime.
- **Copy = facts + a thin crafted layer.** Facts render as bullets/meters; the Narrator writes only fact-free eyebrow + tagline per card and is given a "facts already shown — never repeat" list. (Why the prototypes read clean: "Stanford" is a banner bullet, never a copy line.)
- **Copy quality control:** deterministic **gate** (code, not an LLM) drops options that repeat a fact or overflow length + **generate-N → athlete picks**. **No automated LLM revise loop** (degradation research: mush / unreliable self-critique / reward-hacking). Human is the voice editor. (Spec 4)
- **Share layer + analytics (built + validated).** Spec 6 realized: `card_shares` + `card_share_views` tables, `services/kitShare.ts` (create/resolve/log/dwell/analytics/list/revoke), routes: public `GET /c/:shareId` (live→current canonical, snapshot→frozen; enforces revoke/expiry/recipient scope; logs open + injects a dwell beacon) · `POST /c/:shareId/beat` · authed `POST/GET /api/v1/athletes/:id/shares` · `GET /api/v1/shares/:id/analytics` · revoke. Validated: live/snapshot/recipient-gate/forward-detection/dwell/revoke + HTTP. Snapshots freeze the PATH-kit (signed fresh at serve). UI (the share screens) is the remaining piece — this is the backend it calls.
- **Cache-not-recompute route (built).** `media_kits` cache + `GET /card/:athleteId` (+ `/api/card`, `kit-refresh`); `signKit` mints fresh URLs at serve. Cache hit ~69ms vs ~105s rebuild.
- **Media Intelligence Layer (built + validated).** First embeddings in the codebase (Vertex `multimodalembedding@001`, image+text one space). `enrichAthleteMedia` tags **+ embeds** all owned media (once, incremental); `searchMedia(brief, filters, purpose)` does semantic retrieval + tag filters + purpose ranking (heroScore·views·recency). Validated on Mia: text→image works ("action shot" → action shots top-ranked). Raw multimodal cosine is low-absolute (~0.05–0.2) → **min-max normalize sim** before blending. Decouples enrich (once) from select (per-purpose); shared by Nomi Card, posts, ads. Files: `lib/mediaEmbed.ts`, `services/mediaEnrichment.ts`, `services/mediaSearch.ts`. **Curator now consumes `searchMedia`** (diversity dedupe → distinct shots). **Mia fully backfilled (269/269).** **Auto-enrichment wired:** FU2 = kick on media-download completion (`backfillAthlete`), FU1 = `media-enrich-cron` Cloud Scheduler job (every 15 min, ENABLED) — resumable/idempotent/background. **Video card built** (`searchMedia` playableVideo filter → `<video>` "see in action"; only ~8 playable clips exist, rest are stills).
- **Narrator is multi-model + judge (implemented).** Every kit generates from **Gemini Pro + Kimi + Fable in parallel**; options are gated, **pooled per slot** (deduped), and an **independent JUDGE ranks-and-picks the best per slot as the default** — losers become the athlete's stored alternates. A judge only *ranks* (never rewrites), so it's compatible with the no-revise-loop rule; its pick is only a *default* the athlete overrides. Validated on Mia: 3 models → ~39 pooled tagline options, judge defaults measurably sharper than single-model Pro (e.g. mix "The audience arrived early. The market is catching up."). Configurable via `NARRATOR_MODELS` / `NARRATOR_JUDGE_MODEL`.
- **Commercial state is 3-way** (`none` / `undisclosed` / `active`). `undisclosed` = a partner is *inferred* (e.g. Adidas) but not athlete-confirmed → never claim empty (undersells) *and* never name the unconfirmed partner (it goes to competing brands); shows soft "Emerging / inferred". Flips to `active` only on athlete confirmation. Fixes the "first partner writes the story" falsehood for Mia.
- **Curator recency is a prior, not a filter.** Hero/fit ranked by `heroScore × recency` (18-mo half-life), proof by `views × recency` (48-mo). A decade-old childhood shot ≈ 0.01 weight → can't win the hero. The Strategist can **pin** a specific old asset when a story needs it.
- **DONE — "Strategist owns the deck plan" (2026-07-16, was deferred 2026-07-15).** `deriveDeckPlan(athleteId, brand, signals)` in shotList.ts is now the single owner of COMPOSITION — the ordered deck (`order`), each card's image role, the backdrop demand (`galleryTarget`), and the facet art-direction. The assembler no longer decides the deck: it computes `signals` from data, calls the plan, binds FACTS into the cards, and sets `kit.deck = plan.order` (pruning any planned card whose data was absent, e.g. `video`). Gone: the assembler's `deck` array, the `bgDemand` peek, `nationalPlus`/`achievementsDefault`. Public deck = breadth (closes on `fit`); brand deck = focus (leads with `whyFits`). Validated: brand + public deck order, images, and every de-hardcode win preserved. *(The composition stays DETERMINISTIC inside the plan — the LLM does facets/art-direction only, no new non-determinism.)* Historical context below:
- ~~**DEFERRED — "Strategist owns the whole deck plan" refactor (decided 2026-07-15).**~~ Today composition is split: the Strategist (`deriveShotList`) art-directs the PHOTO cards, while the assembler decides library-card inclusion, the `deck` order, and hands out backdrops via `nextBg()` + a `bgDemand` peek (a small duplication of the inclusion rules — sized so the Curator's gallery covers the deck). The clean end-state: the Strategist emits a full DeckPlan (which cards, order, per-card image role+facet); Curator + Narrator read that plan; the assembler shrinks to binding FACTS only. **Decision: don't do it now** — the pipeline is validated + working, the peek is minor and safe (graceful fallback), and a refactor of working code buys tidiness (image→card mapping would change, needs re-validation) not user value. **Trigger: adopt it the next time we meaningfully grow the card library**, as that work's foundation. Cheap interim option if the duplication nags: extract the inclusion rules into one shared helper both the peek and the card-builder call (output-identical, ~15 min).
- **Card library + editor (built — Spec 10, record 2026-07-15).** The deck is composable: 5 new card TYPES from existing pipes (`payments`/"Book her", `whyFits`, `story`, `values`, `achievements`), a Strategist **default set** (`MediaKitData.deck`) vs an opt-in **library**, and an **editor** (`CardEditorScreen` + `card-editor`/`card-overrides` endpoints) where the athlete drag-reorders (cover pinned), adds/removes library cards, picks the Narrator's alternates (finally consumed — see the gap below, now closed) or writes her own, and swaps photos. Edits = a thin `card_overrides` layer applied at serve (`applyOverrides`); the base kit stays regenerable, facts are never editable, snapshots freeze the resolved deck. **payments** composes packages from the verified rate card with a **placeholder checkout** (Stripe seam). New cards render in **campaign** only for now. Migration: `card_overrides` table created.

## 10. Open questions
- How much of the palette should identity/brand override vs theme-lock? (Leaning: accent + few tokens only.)
- Do we show the Marketability Index/tier to brands for lower-tier athletes, or only emphasis-drive behind the scenes?
- Benchmark source for percentiles (per sport / follower-tier).
- Onboarding UX for self-reported deals/rates (incentive design).
- Which capability to prototype first as the "spearhead" (per-brand morph vs concierge vs living rings).
- **Naming — DECIDED: the athlete brand card is the "Nomi Card"** (was "media kit"). Drawn from the *Claim* well (Nom = the name you claim) + the card format; see `brand-story.md`. User-facing label = "Nomi Card"; internal code (`MediaKitData`/`mediaKitService`/`kitRenderer`) stays stable.

### Known gaps — copy pipeline is ahead of the data model + UI (record 2026-07-14; mostly CLOSED 2026-07-15)
- ~~**Athlete copy-picker UI not built.**~~ **CLOSED (Spec 10).** The editor's copy-picker consumes the gated alternates: `kit.copyAlternates` surfaces the ~5 options per slot; the athlete picks one or writes her own → a `card_overrides.copy` entry applied at serve. Assembly still takes `[0]` as the *default*; the athlete overrides it.
- ~~**`MediaKitData` mix/rates cards have no copy slot.**~~ **CLOSED.** `mix` carries `tagline`/`reframe`, `rates` carries `tagline`; both render.
- ~~**Templates are still prototypes, not renderers.**~~ **CLOSED for campaign.** `kitRenderer.renderCampaign` is a data-bound renderer for all card types incl. the Spec 10 library; broadcast/immersive/luxe render the original 8 (new library cards are campaign-only for now — see Spec 10 follow-ups).
- **Narrator briefs for the new library slots** (`payments.lead`, `story` beat lines, `whyFits` reasons, `values`) are not yet written — those cards use good fallback copy today; the `pick()` seam makes real Narrator copy a drop-in.
