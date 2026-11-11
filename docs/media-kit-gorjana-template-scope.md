# Gorjana deck → engine template: Phase 1 & 2 build scope

Turns the hand-built gorjana deck (Claude artifact `8024f578`, now the tracked share
`/c/truE87EaxesM`) into a reusable **brand-ambassador deck** the engine generates.
See the 9-card analysis for the mapping; this is the build spec.

## The 5 places a card lives (the extension pattern)

Every card is **theme-agnostic DATA** rendered two ways. To add or change a card you touch some of:

1. **Union type** — `server/services/mediaKitService.ts` → the `Card` discriminated union (`type: …`).
2. **Assembly** — `assembleMediaKit()` builds the card object from data and pushes it; `kit.deck` sets order.
3. **Copy (Narrator)** — `server/services/narrator.ts`:
   - `defaultCardBriefs(ctx, shotList)` → per-card `{ slots:[eyebrow|tagline|extra], factsShown, intent }` (multi-model gemini/kimi/fable + judge; alternates stored in `kit.copyAlternates` for the editor).
   - **Dedicated generators** for substantive content — e.g. `narrateWhyFits(input) → WhyFitsReasons`. **This is the model for the two new cards.**
4. **HTML renderer** — `server/services/kitRenderer.ts` → a `xCard(c)` function + a `case "x":` in `renderDeck`'s `switch(c.type)`. Themes: `THEMES = { campaign, broadcast, immersive, luxe }` (`themes/*.ts`).
5. **Native renderer** — `client/components/card-native/looks.tsx` → a `case "x": return <XCard .../>` + the component in `card-native/`.

`whyFits` is the reference for a brand-tailored, LLM-generated, image-led card that **auto-enters the deck after cover** (`mediaKitService.ts:403`); the two new cards follow it exactly.

---

## PHASE 1 — Harmonize the 6 data cards (low effort, no new types)

These 6 already exist and are data-backed: **cover · achievements (the record) · content (proof) · audience · rates/payments (the offer) · close**. "Harmonize" = make the engine's output read like the gorjana deck, via three sub-tracks. **No schema, no new union types, no new components.**

### 1A · Copy framing — edit Narrator `intent` prompts (`narrator.ts` → `defaultCardBriefs`)
Tune the existing per-card `intent` strings so the crafted copy matches the gorjana framing. All inputs are already in `NarratorContext` (name, sport, school, tier, audienceFacts, brandFitTags, `ctx.brand.{name,category,audience}`).

| Card | Framing to add (from the deck) |
|---|---|
| `content` (proof) | "A million new buyers. Every single post." — reach as **conversion**, multiples ("60× her following", "2× follower count/post"), "earned, not projected." |
| `audience` | "That isn't a target. It's who **already follows**" — overlay follower demographics against `ctx.brand.audience`; the multi-generational note. |
| `cover` | Brand-anchored hook — "worn by someone whose everyday reaches millions", "prepared for the {brand} team." |
| `achievements` (record) | Dual-anchor lead — "Captain at {school}. Captain for {country}." |
| `close` | Brand sign-off tone ("Jewelry you'll live in"). |

Effort: prompt edits + `factsShown` tweaks. Verify on real data (`/verify`).

### 1B · Visual treatment — the `luxe` theme is ALREADY BUILT ✅
Correction to the earlier assumption: `themes/luxe.ts` is **1,112 lines, fully productionized** ("the couture CSS, card markup… kept faithful and verbatim; same data contract as the campaign renderer — cover, index, mix, audience, content, [video], rates, fit"). It's registered in `THEMES` and renders the data cards in the gold/serif couture look. So the gorjana visual treatment needs **no build** — it's a selectable theme (`kit.tokens.theme = "luxe"`, stored per-athlete in `getOverrides`).
- **Optional (product decision):** default brand kits (`brandId ≠ 0`) to `luxe` when the athlete hasn't chosen a theme — a one-line fallback in `kitCache.getOrBuildKit`. Visible change to existing brand decks → worth a visual look before flipping.

### 1C · Data enrichment (small — data already fetched)
The `content` and `audience` card builders in `assembleMediaKit` may need a few more computed fields the deck shows (saves/shares totals, "N× following" multiples, the brand-target overlay). All derivable from data already pulled (`social_analytics_snapshots`, `media_assets.insights`, `inbox_brands.audience_summary`). Small additions to those two card builders.

**Phase 1 status:** 1A **shipped** (brand-aware Narrator intents for cover/content/audience). 1B **already built** (luxe theme). 1C (content/audience card-shape enrichment — more stats/overlay) **deferred to a visual pass** — it touches all four renderers + native, so it wants a look-see, not a blind change.

---

## PHASE 2 — Two new creative card types + generators (medium; the real unlock)

The creative/strategic cards Mia authored by hand. Both follow the **`whyFits` pattern** (brand-tailored, dedicated LLM generator, auto-insert into deck, image-led). Build each across the 5 extension points.

### New card A · `campaignConcept` (the "Laws of Layering" poster)

**1. Union type** (`mediaKitService.ts`):
```ts
| (CardBase & { type: "campaignConcept";
    title: string;            // "The Laws of Layering"
    line: string;             // "You don't take your identity off when you put the jersey on."
    lineEmphasis: string;     // "You layer it."  (the italic payoff)
    facets: string[];         // ["Athlete","Founder","Scholar","Trailblazer"]
    note: string;             // the narrative paragraph
    image?: string | null; })
```
**2. Generator** (`narrator.ts` → new `narrateCampaignConcept(input)`, mirrors `narrateWhyFits`; multi-model + judge). Inputs:
- Brand: `name`, `category`, **`positioning`/core idea** (gorjana's "pieces mean more together" — see the new brand-data need below), `audience`.
- Athlete: identity facets from `snapshot.research` (sport, school, founder/scholar/other signals), `storyArc`, marquee credential.
- **Prompt intent:** "Invent a campaign concept that fuses {athlete}'s facets with {brand}'s own principle ({positioning}). Return a title, a two-part statement (line + italic payoff), 3–5 one-word facet labels, and a short grounded narrative. Tie it to the brand's idea; never generic."
**3. Assembly:** brand kits only (`if (brand)`) — call the generator, reserve a hero shot (like `whyFitsImg`), push, insert into `kit.deck` (hero slot, e.g. after cover).
**4. HTML renderer** (`kitRenderer.ts`): `campaignConceptCard(c)` + `case`. The deck's CSS already has `.card--poster / .concept-title / .concept-line / .facet-row` — port into `renderCampaign` + `renderLuxe`.
**5. Native:** `card-native/CampaignConceptCard.tsx` + `case "campaignConcept"` in `looks.tsx`.

### New card B · `activationPlan` (the "How this works all year" calendar)

**1. Union type:**
```ts
| (CardBase & { type: "activationPlan";
    headline: string;         // "How this works all year"
    lead: string;             // "The audience doesn't stop at the touchline."
    buckets: Array<{ label: string; audience: string; line: string }>;  // ×3–5
    close: string; })         // "Not one campaign. A calendar."
```
**2. Generator** (`narrator.ts` → `narrateActivationPlan(input)`). Inputs:
- Athlete: sport, school, competition/season context (`research`), community/surfaces.
- Brand: category → product angles (gifting/retail/seasonal).
- **Prompt intent:** "Produce 3–5 year-round activation buckets (a title, the audience it reaches, one concrete line) spanning the athlete's surfaces — field, campus, community, gifting — grounded in her real context ({school} store, ACC schedule, youth clinics). End with one calendar-not-campaign close line."
**3. Assembly / 4. HTML / 5. Native:** same as A. The deck's `.plays` CSS ports directly to the renderer. Deck placement: mid-deck, before the `payments`/`rates` offer.

### The one genuinely new brand-data input
`campaignConcept` needs the brand's **core idea / positioning** to anchor on (gorjana = "pieces mean more together"). Today `inbox_brands` has `description` + `audience_summary` but no distilled positioning. Two options:
- **(a) Extract at enrichment** — an LLM step during brand enrichment writes `positioning` from `description` (no schema change if stored in an existing jsonb; else add `inbox_brands.positioning text`).
- **(b)** Fall back to `description` if absent (concept is weaker but still generates).
This is the highest-leverage new data for auto-generating the creative card.

**Phase 2 files:** `mediaKitService.ts` (2 union types + 2 builders + deck insertion), `narrator.ts` (2 generators + optional briefs), `kitRenderer.ts` (2 renderers + cases; port deck CSS into campaign + luxe), `card-native/` (2 components + 2 cases in `looks.tsx`), brand enrichment (positioning). **Est. ~1–2 weeks** + `/verify` on real athlete/brand data.

---

## Sequencing & notes
- **Phase 1 ships value immediately** (existing decks read richer + get the luxe look) and de-risks Phase 2 (same theme/renderer surface).
- Phase 2's two cards + the existing `whyFits` form the **brand-tailored trio** that makes a brand deck *rebuild for the brand* (Spec 9), not beside it.
- Keep both generators **brand-kit-only** (`brand` present) and grounded — reuse `narrateWhyFits`'s guardrails (no invented facts, brand-specific, judge-ranked).
- The partnership/offer card (Phase 3) stays a `rates`/`payments` proposal; the deliverable-mix composition is a template + rate_card, deferred.
