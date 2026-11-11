# Media kit — Phase 0 specs

Status: **draft for review.** The three contracts every later phase plugs into (see
[brand-engine-roadmap.md](./brand-engine-roadmap.md) §8). Types are illustrative TS — the shapes matter, not the syntax.

---

## Spec 1 — `MediaKitData` + tokens (what's templated vs bespoke)

The single typed object the engine **produces** and any theme template **renders**. Theme-agnostic: a
template consumes this and knows nothing about a specific athlete.

```ts
interface MediaKitData {
  athleteId: string;
  identity: {
    name: string; sport: string; school: string;
    segment: 'college' | 'pro' | 'olympic';
    tier: TierKey;            // internal key (scoring), e.g. 'Established'
    tierDisplay: string;      // brand-facing name, e.g. 'Established' / 'Emerging'
    hook: string;             // one-line value prop (generated, cached)
  };
  tokens: KitTokens;          // resolved theme + identity (+ brand) — Spec below
  cards: Card[];              // ONLY the cards the Strategist chose, in order (Spec 2)
  meta: { generatedAt: string; forBrand?: BrandContext; overallConfidence: number };
}

type TierKey = 'Icon' | 'Elite' | 'Established' | 'Rising' | 'Local';

// Cards = discriminated union. Each type has a template component per theme + emphasis modes.
type Card = CoverCard | IndexCard | MixCard | AudienceCard | ContentCard | VideoCard | RatesCard | FitCard;

interface CardBase {
  id: string;
  type: string;
  emphasis: 'hero' | 'standard' | 'quiet';   // Strategist-chosen: how loud the template renders it
  confidence: Confidence;                     // Spec 3 — drives presentation / inclusion
  eyebrow: string;                            // small label
}

interface CoverCard    extends CardBase { type:'cover';    image: MediaRef; nameLines: string[]; meta: string; hook: string }
interface IndexCard    extends CardBase { type:'index';    value:number; max:number; tierDisplay:string; verdict:string;
                                          rings?: CapitalScores }         // rings → reuse ConcentricRingScore (the living rings)
interface MixCard      extends CardBase { type:'mix';      rows: Array<{ key:string; label:string; grade:string; value:number; color:string; framing:string }> }
interface AudienceCard extends CardBase { type:'audience'; headline:string; sub:string; geo:Array<{code:string;pct:number}>; stats:Array<{n:string;k:string}> }
interface ContentCard  extends CardBase { type:'content';  heroStat:{value:string;label:string}; tiles:Array<{image:MediaRef;stat:string}>; note:string }
interface VideoCard    extends CardBase { type:'video';    video:MediaRef; poster:MediaRef; stat:string; caption:string }  // plays an owned reel
interface RatesCard    extends CardBase { type:'rates';    headline:{value:string;range:string}; items:Array<{k:string;sub:string;v:string}> }
interface FitCard      extends CardBase { type:'fit';      image:MediaRef; lead:string; body:string; tags:string[]; cta:CtaAction }

interface MediaRef { url:string; kind:'image'|'video'; grade:'full'|'thumbnail'; focal?:{x:number;y:number} }  // focal = saliency crop
interface CtaAction { label:string; kind:'message'|'deal'|'book'|'pay'; payload?:unknown }
```

**Tokens — the *only* bespoke style, and it's constrained:**
```ts
interface KitTokens {
  theme: 'campaign' | 'immersive' | 'broadcast' | 'luxe';   // THEME-LOCKED: structure, type, neutrals, motion
  accent: string;            // overridable: athlete identity (team/photo palette) OR brand color
  accentSoft?: string;       // overridable
  photoTreatment?: 'cinematic' | 'clean' | 'warm';          // overridable, from a theme-approved set only
  // when meta.forBrand: a second constrained overlay (brand accent) resolves ON TOP
}
```
**Rule:** theme owns everything except `accent` (+ the 2 approved tokens). That's how a kit feels bespoke
(Mia's cardinal, or a brand's color) while staying coherent. Brand-tailoring = swap the accent + regenerate copy; **no new template.**

**What produces each field (the templated / bespoke / generated split):**
| Field | Source | Generated? | Cadence |
|---|---|---|---|
| stats (`value`, `stat`, `items`) | DB pull | never | fresh per render (deterministic) |
| `image`/`video` (`MediaRef`) | Curator selection (+ optional enhance/gen) | select=vision, enhance=image model | cached; on new media / brand |
| `hook`, `verdict`, `framing`, `body`, copy | Narrator (LLM, grounded) | yes | cached; on data change / brand |
| `tokens.accent` | derived (palette/brand) | light | cached |
| which cards + order + `emphasis` | Strategist | logic + light model | on profile change / brand |

---

## Spec 2 — Strategist composition (tier × shape → recipe) + tier playbooks

```ts
function composeKit(profile: AthleteProfile, purpose: KitPurpose): Composition;

interface AthleteProfile {
  // ── quantitative (scoring) ──
  tier: TierKey;
  capitals: CapitalScores;                 // audience/athletic/brand/commercial (0–100)
  dimConfidence: DimensionConfidence[];    // Spec 3
  segment: 'college'|'pro'|'olympic';
  goal: string;                            // goal_archetype
  ptsToNextTier: number;
  benchmarks: Record<string, number>;      // percentile context per metric (TODO source)

  // ── qualitative (researchAthlete: Gemini-grounded → Kimi-extracted) — the ACTUAL shape ──
  research: {
    storyArc: string;                                              // strong narrative (verified good for Mia)
    achievements: Array<{ name:string; year:string; level:string }>;    // e.g. ACC Champion / All-America
    brandMentions: Array<{ brand:string; type:string; confidence:number }>;  // deals/sponsorships (found Adidas!) → Commercial + provenance
    pressMentions: Array<unknown>;
    nilValuationMentions: Array<unknown>;
    sentiment: unknown; profile: unknown; socialHandles: unknown;
    momentum: { googleTrends:number; gdeltArticles:number };
  };
}
```
**How the research profile is used:**
- **Strategist** — uses the *fact-rich lists*: `achievements` (+level) → Athletic hero; `brandMentions` → Commercial hero + **the cold-start fix** (wire into the Commercial capital; `confidence` → provenance, Spec 3); `storyArc` → narrative angle; `momentum` → "on the rise".
- **Narrator** — grounds every line on `research` (storyArc + the lists) so copy is specific + true.
- **Note:** an earlier spec assumed a per-capital `signals` structure — it does **not** exist. The real shape (above) is richer in facts; the Strategist derives capital emphasis from the lists + the `capitals` scores directly.
- **Model note:** research = Gemini 2.5 Flash + Google Search grounding → Kimi K2 (extraction), both on Vertex/credits — working well; do NOT swap for GLM/Fable (they lack native grounded search). Reserve Fable/Claude for the kit's hero *copy* (Narrator), not research.
interface KitPurpose { audience: 'brand'|'athlete'|'fan'; forBrand?: BrandContext }
interface Composition { cardOrder: string[]; hero: string; emphasis: Record<string,'hero'|'standard'|'quiet'>; narrative: NarrativeStrategy }
```

**The logic, in order:**
1. **Magnitude (tier)** sets the *narrative strategy* + how hard to flex numbers.
2. **Shape (capitals + benchmarks)** picks the **hero** = the athlete's single strongest, above-benchmark signal; weak signals get reframed (if confident-low) or **omitted** (if unknown — Spec 3).
3. **Confidence** gates inclusion (never show/hero an unknown).
4. **Goal + purpose** tune copy + which CTA, and brand-mode vs athlete-"Wrapped" vs fan-mode card sets.

**Tier playbooks** (magnitude → strategy; the "band → playbook" upgrade):
| Tier (display) | Narrative strategy | Hero with | Downplay / omit | Growth path (Playbook) | Brand targets |
|---|---|---|---|---|---|
| **Icon** | Flex everything | reach/views, deal portfolio | — | maintain | national/global |
| **Elite** | Numbers-forward | top metric + audience | — | → Icon | national |
| **Established** (Mia) | Balanced numbers + story | strongest capital (her: audience/reach) | thin capitals | → Elite; monetize | category leaders |
| **Rising** | Trajectory-forward (use `ptsToNextTier`) | growth + one standout post | absolute totals | → Established; post cadence | mid-market, category |
| **Local → *Emerging*** | Story / potential / authenticity | best single content + niche audience quality | raw totals; don't hero numbers | → Rising; connect accounts, grow niche | local, first-mover |

**Shape recipes** (which capital heroes, within any tier):
| Strongest capital | Hero card | Framing |
|---|---|---|
| Audience (reach) | Content / Audience | scale + engagement |
| Audience (engagement, small reach) | Audience | "small but mighty," quality over quantity |
| Athletic | Cover / a new Athletic card | pedigree, achievements, press |
| Brand | Fit | aesthetic, brand voice, content quality (play a reel) |
| Commercial | Rates / a deals card | proven partner, existing brands |

---

## Spec 3 — Data-confidence / provenance

Every score dimension carries provenance + completeness; the score and the kit both read it.

```ts
type Provenance = 'verified' | 'self_reported' | 'inferred' | 'unknown';
interface Confidence { level: Provenance; score: number }               // 0–1
interface DimensionConfidence { dimension:'audience'|'athletic'|'brand'|'commercial'; provenance:Provenance; completeness:number }
```

**Scoring rule — distinguish "low" from "unknown":**
- A dimension with no data is **not 0**. It gets a **neutral prior + widened confidence band**, or is **excluded** from the display score — never rendered as a real zero. *(Requires a change in `scoringService`: today Commercial=0 conflates none vs unknown.)*

**Presentation rule — the kit respects provenance:**
| Provenance | In the kit |
|---|---|
| `verified` (nomila-measured) | shown proudly — the moat ("✓ verified") |
| `self_reported` (athlete-provided) | shown, lighter ("athlete-provided") |
| `inferred` (web/estimate) | shown hedged, or as "estimated" |
| `unknown` | **omitted** — never a 0, never reframed |

**Reframe rule:** only reframe a low value as upside when it's **confident/verified** low (we *know* it's low, e.g. a genuinely new athlete). An **unknown** low is omitted, never spun. → Mia's kit **omits the Commercial card** until Adidas is known, instead of lying with a 0 + "first-mover."

**Gap-filling (first-class):**
- Onboarding / a profile flow collects **past + current deals, sponsorships, rates** → `self_reported`, marked, feeds Commercial + rate calibration.
- **Athlete-set rates** are first-class over suggested ranges (marked self-reported).
- **Completeness = growth mechanic:** "complete your profile → stronger kit + higher *verified* rate," tied to `ptsToNextTier` + the Playbook.

**Why it also helps:** strengthens the verified-moat story ("every number here is nomila-verified; the athlete can add more") — a trust feature, not just a fix.

---

## Spec 4 — Agent orchestration + I/O inventory

### Orchestration (a DAG, not a line)
```
① pull profile + stats + candidate media   (deterministic queries, parallel)
                    │
             ┌──────▼──────┐
             │  STRATEGIST │  conductor — runs FIRST; downstream needs its plan
             └──────┬──────┘  → Composition (cards/order/hero/emphasis/strategy + per-slot briefs)
         ┌──────────┴──────────┐   (parallel)
   ┌─────▼─────┐        ┌──────▼──────┐
   │  CURATOR  │        │   NARRATOR  │  each emits N OPTIONS per slot
   │ tag→score→ │        │ write copy  │  (not one answer — variety for the human)
   │ select→enh │        │ (grounded)  │
   └─────┬─────┘        └──────┬──────┘
         └──────────┬──────────┘
                ┌────▼────┐
                │  GATE   │ deterministic validation (code, NOT an LLM critic)
                └────┬────┘ drop options that: repeat a displayed fact · miss a rule ·
                     │       expose a weak/low fact · overflow length · lack an asset
                ┌────▼────┐
                │  MERGE  │ → assemble strongest passing option per slot → MediaKitData
                └────┬────┘
                ┌────▼────┐
                │ ATHLETE │ human-in-the-loop = the VOICE/QUALITY editor:
                └────┬────┘ pick an alternate · edit inline · re-prompt one slot
                ┌────▼────┐
                │ RENDER  │ deterministic template-fill (no agents)
                └─────────┘
```
- **Strategist runs first** (the plan). **Curator ∥ Narrator run in parallel** under it (images vs text — mostly independent).
- **Handoff rule:** the Narrator receives the Curator's *selections* as context so it can write **asset-specific** copy ("this exact reel — 5.4M"); the bulk of copy (story/stats/verdicts) is asset-agnostic and doesn't block on the Curator.
- **Parallelism inside agents:** Curator fans out vision-tagging/scoring across *all* candidate assets; Narrator writes card copy concurrently.
- **Cached + event-driven:** the whole DAG runs on *data change / brand request / athlete edit*, produces `MediaKitData`, caches it. Rendering later is a deterministic template-fill — no agents fire.
- **Router seams:** Strategist = rules + light model · Curator = vision + multimodal embeddings · Narrator = narrative model.

### DECISION — quality control: deterministic gate + generate-N + human editor. **No automated LLM revise loop.**
We deliberately reject a "generate → LLM critic → rewrite → re-critique" loop. The prompting research
we ran flags three failure modes for iterative LLM self-refinement on creative copy: **"corporate mush"**
(refinement sands off the distinctive edge), **unreliable intrinsic self-correction**, and **reward-hacking**
(the model games the critic's stated metric, not true quality) — plus latency/cost and error accumulation.
So quality splits by *kind*:
- **Objective quality** (*did it follow the brief?* — copy repeats a displayed fact · image absent or wrong
  emphasis mode · a weak/low fact is exposed · over length) is **rule-checkable → a deterministic GATE in code**,
  not an LLM. Safe (rules can't degrade output), cheap, and it catches exactly the failures we kept hitting.
  A slot with no passing option triggers a *targeted* regenerate of that one slot, capped.
- **Subjective quality** (*is this punchy? is this her voice?*) is where automated critique degrades and where
  the research is explicit that **humans judge best**. The gate here is the **athlete** — backed by
  **generate-N-then-pick**: each slot ships 2–3 options, so the human gets variety *and* judgment with **zero
  revise-loop**. The athlete can pick an alternate, edit inline, or re-prompt a single slot.

Ranking of the options we considered (evaluated, not assumed):
1. **Human-in-the-loop (athlete)** — primary. Research-backed for creative, zero degradation, gives the athlete
   ownership of her own brand voice. Default.
2. **Director-as-critic (if ever automated)** — beats a standalone editor agent: it already holds the brief +
   strength profile (best context) and is independent of the *generation* (it didn't write the copy, so it's not
   the unreliable self-critique). Add **only if A/B-proven** to beat no-critic; a *different model* than the Narrator.
3. **Separate editor agent** — weakest: loses the Director's context, adds a hop, and its only edge (independence)
   the Director already has. Skipped.

The Director's role therefore stays **upfront (plan + per-slot brief) + a deterministic gate** — it never becomes
an LLM critic in a loop. A **visual gate** (render the card, a VLM checks legibility/composition of text-over-photo)
is a later phase, not v1.

### DECISION — facts vs copy are two layers (why the prototype copy read clean)
On each card, **facts render as their own elements** (name, the meta bullet "Soccer · Stanford · U.S. Youth
International", stat rows, sub-score meters, geo) and **copy is a thin crafted layer on top** (eyebrow/label +
tagline) that **adds meaning and never repeats a displayed fact**. In the campaign/broadcast prototypes "Stanford"
appears *only* as a banner bullet — never in a copy line. The earlier Narrator failure (crammed, résumé-y prose)
came from (a) dumping the full research on it and (b) writing copy **blind to the card** — so it re-stated facts
that were already bullets. Fix: the Narrator writes **eyebrow + tagline per slot, fact-free**, and its brief lists
*"facts already shown on this card — never repeat these."* The numbers come from data, not the copy model.

### DECISION — the facts layer is adaptive per strength profile (Director's call)
The bullets are not fixed. For a small / weak / data-poor athlete the Strategist: **(1)** drops cards whose facts
embarrass (no "Receipts" card if the top post did 5K); **(2)** features the strong bullet, suppresses the weak one,
and **omits unknown data** (confidence layer — no blank bullets); **(3)** frames **relative over absolute**
("top 8% engagement in her conference", "3× growth this season") so modest numbers gain meaning; **(4)** flips the
**emphasis mode** to photo/story-forward (number quiet or absent) and the copy register from "the exact buyer brands
fight for" to "ground floor — the first believer wins." Truly thin data → a **shorter kit** leaning on photo +
athlete-supplied story/goals; never fabricate.

### I/O inventory

**STRATEGIST** *(the conductor — fully specced)*
| Inputs | Outputs (the `Composition`) |
|---|---|
| **Quantitative:** tier · capitals (aud/ath/brand/comm) · `dimConfidence` (provenance per dim) · segment · `goal_archetype` · `ptsToNextTier` · benchmarks *(TODO source)* | `cardOrder` — which card types, in order |
| **Qualitative research:** `storyArc` · `achievements[]` · `brandMentions[]` (+confidence) · `pressMentions[]` · `nilValuationMentions[]` · `sentiment` · `profile` · `momentum` (googleTrends/gdelt) | `hero` — the single lead card/asset |
| **Purpose/context:** audience (`brand`\|`athlete`\|`fan`) · `forBrand?` (BrandContext) | `emphasis` per card (`hero`\|`standard`\|`quiet`) |
| **Asset inventory (light):** what media *exists* (types/counts) — so it knows if a content/video card is even possible (not the selection itself) | `narrativeStrategy` (numbers-forward / story-forward / trajectory…) + tone |
| | **per-slot briefs**: an *image brief* (what kind of shot) + a *copy brief* (angle + which facts) for each card |
| | confidence decisions (omit unknown dims; reframe only confident-lows) |

**CURATOR** *(media intelligence — v1 partial, expand as built)*
| Inputs (planned) | Outputs (planned) |
|---|---|
| candidate media set (library + camera roll) w/ metadata (platform, media_type, views, gcs paths) | **2–3 candidate assets per image slot** (+ focal point for crop, grade) — not one; the athlete picks |
| per-slot **image briefs** from Strategist (hero portrait / proof performers / brand-fit / video) | optional enhanced/generated asset (Imagen) |
| **vision tags + embeddings** per asset (its own enrichment step / cache) | selection rationale + scores (transparency + athlete override) |
| brand aesthetic/embedding (when `forBrand`) | |
| *TODO:* vision tag taxonomy · embedding model · scoring weights (perf × quality × fit × diversity) | |

**NARRATOR** *(copy — v1 partial, expand as built)*
| Inputs (planned) | Outputs (planned) |
|---|---|
| per-slot **copy briefs** from Strategist (angle, tone, **facts-already-shown = do-not-repeat list**) | **2–3 options per slot** of **eyebrow + tagline** — thin, crafted, **fact-free** |
| grounded facts: `research` (storyArc/achievements/brandMentions) · stats · capitals — *for context/angle, not to restate* | never repeats a displayed fact; never invents numbers |
| Curator's **selections** (for asset-specific captions) | passes the deterministic GATE (no fact-repeat / length / weak-fact) before merge |
| voice/tone tokens (theme + athlete) | athlete is the voice editor: pick / edit / re-prompt |
| *TODO:* model routing (Kimi/Pro/Fable per slot) · gate rule set · eyebrow-vs-tagline slot taxonomy per card | |

## Design principle — brand-fit is *context-aware*, not a logo blocklist
Competitor logos in media are only sometimes a conflict. A required team/competition uniform
(e.g. Nike for a US-team or Stanford game while personally Adidas-sponsored) is industry-accepted
and **not** a conflict — she's competing, not endorsing. A rival's product in a *personal/marketing*
shot **is** a conflict. So brand-fit needs: (1) the athlete's **sponsorship structure** as data
(self-reported: which brand governs which context — competition vs personal/appearances/social ads),
and (2) **image-context classification** from the VLM (`shot_type`/`setting`/`attire`/`brands_visible`).
The Strategist combines them; the Curator never applies a blunt "reject competitor logo" filter. This
becomes real with per-brand tailoring (Phase 4).

## Spec 5 — Media Intelligence Layer (enrich ALL, retrieve by purpose)

**Problem.** The Curator today vision-tags only the top-24-by-views and selects from that. Fine for
"hero from best posts", but it **cannot search the whole library** — which every real need requires:
the right shot for a *post*, a brand-fit image/clip for a *proactive ad*, a "see in action" *video*,
or AI content built from the *camera roll*. Tagging a small candidate set on-demand is a v1 shortcut,
not the architecture.

**Principle — decouple ENRICHMENT from SELECTION.**
- **Enrich (once per asset, async/incremental, on ingest):** every owned asset (image *and* video)
  gets vision tags (`shot_type`, `brands_visible`, `attire`, `setting`, `aesthetic`, `brand_safe`,
  `disposition`, `description`) **plus a multimodal EMBEDDING**, stored on the asset. Videos: sample
  key frames → tag + embed representative frames, record duration/has-audio/motion.
- **Select (per purpose, cheap, no model calls):** any process queries the enriched index —
  **semantic search** (embedding similarity to a text brief), **tag filters** (shot_type,
  brands_visible, brand_safe), ranked by **purpose weights** (heroScore · views · recency · brand-fit).

**Consumers (one index, many uses):** Nomi Card Curator (hero/fit/gallery/proof/video by purpose) ·
post generation (image for a caption/theme) · proactive brand ads (brand-safe, brand-fit clips for AI
editing). The Curator becomes a *consumer* of retrieval, not the tagger.

**Components.**
1. **Storage:** `media_assets.metadata.vision` (tags — exists) + a new **embedding** (float[] JSON now
   → pgvector at scale; 177 assets = in-code cosine is fine).
2. **Embedding model:** Vertex `multimodalembedding@001` (image+text in one space → text-query→image
   retrieval). *Not yet wired* — first embedding capability in the codebase.
3. **Enrichment job:** `enrichAthleteMedia(athleteId)` — incremental, tags+embeds *un-enriched* assets,
   bounded-parallel, cached. Runs on ingest / backfill / event. Backfill cost = N vision + N embed calls
   once per athlete (Mia ≈ 177×2), bounded/async.
4. **Retrieval API:** `searchMedia(athleteId, { brief?, filters?, purpose?, k })` → ranked assets.

**Migration:** keep the current Curator working; add enrichment (backfill) + retrieval; then refactor the
Curator to consume `searchMedia`. Diversity/dedupe (near-duplicate camera-roll bursts) uses embedding
distance — solves the repetition problem at the source, not just at render.

### Video card ("see in action")
- New **`video`** card type → renders `<video autoplay muted loop playsinline poster=frame>` with a
  selected clip. Retrieval picks a "see in action" clip (action `shot_type`, has motion, brand-safe,
  strong aesthetic, recent).
- The enrichment indexes videos (frames tagged/embedded + duration), so video is first-class in search.
- **Future — proactive ads:** same retrieval + a generation step (Veo/edit) over brand-safe, brand-fit
  camera-roll clips. The Media Intelligence Layer is the shared foundation; the ad pipeline is a consumer.

### DECISION — Nomi Card cover lockup
Cover shows the **Nomila mark + "Nomi Card"** (no "NOMILA" wordmark). The mark carries the brand; "Nomi"
already echoes Nomila, so the wordmark is redundant. Mark = four arcs from **one shared anchor** (the brand
thesis). Current renderer uses a faithful inline-SVG stand-in — **swap for the official logo asset** when available.

## Spec 6 — Sharing & versioning (live vs snapshot · scope · analytics · UI)

**Principle: separate the KIT from the SHARE.** The canonical kit is the always-current source
(`media_kits` cache + `/card/:athleteId`). A **share** is minted each time the card is *sent*, and
picks a point on **two independent axes**, plus a scope. Nothing about the kit changes; the share
decides how it's exposed.

### The two axes (independent — every combo is valid)
- **Tailoring (content):** `generic` ↔ `per-brand`. A per-brand card foregrounds brand-fit, filters
  competitor conflicts, frames copy/imagery for that brand. One tailored kit per athlete × brand.
- **Binding (freshness):** `live` (renders the *current* canonical kit — updates after sending) ↔
  `snapshot` (a *frozen copy* at share time — never changes).

These are orthogonal — do NOT model them as one list. "Per-brand" is the left↔right (content) move;
"per-deal snapshot" is the top↔bottom (freeze-an-instance) move; a brand can have many snapshots over
time (one per deal), each an instance of a (generic or brand-tailored) kit frozen at a moment.

### The rule of thumb: **live = relationship, snapshot = transaction**
The trigger to freeze is simply *is there a specific offer/rate on the table?*
- **Live** when no fixed terms exist: fan/evergreen, **courting** a brand, an existing partner's
  always-current dashboard, an internal champion circulating her. Currency *helps* (new wins
  strengthen the pitch) and you never re-send.
- **Snapshot** the moment a rate/offer is on the table: freeze exactly what was sent so terms don't
  drift mid-negotiation and it stays consistent as it's forwarded internally.
- Lifecycle of one relationship: *courting Nike →* tailored+**live** · *negotiating a deal →*
  tailored+**snapshot** · *existing partner →* tailored+**live**.

### Scope & gating — **gate only when sensitive**
A Nomi Card's job is to impress on first click, so **default: no email wall, no viewer account.**
Per-recipient *tokenized* links already identify who you sent it to → analytics without friction.
- `public` (default): anyone-with-the-link, forwardable, ungated. Anonymous + tokenized analytics.
  (fans, cold outreach)
- `recipient`: non-transferable, recipient verifies (email/OTP), revocable — for **sensitive rate-card
  snapshots** you don't want forwarded to competitors.
- optional `email-capture`: soft-ask *unknown/forwarded* viewers for email (lead capture) — off by default.
- **Never gate fan links.** Registration/accounts stay on the athlete side only.

### Analytics = headline feature
Per share: opens · unique viewers · dwell · which cards · forwards (new viewers on a per-recipient
link). Turns a share into a sales signal ("Nike reopened your rate card 3×"). This alone justifies
opaque per-share links over the bare athlete URL for brand outreach.

### The share object (`card_shares`)
`share_id` (opaque → `/c/<shareId>`) · `athlete_id` · `mode` (live|snapshot) · `snapshot_data`
(MediaKitData in PATH form, if snapshot) · `snapshot_version` · `tailoring` (generic|brand) ·
`brand_id`/`deal_id` (context) · `scope` (public|recipient) · `gate` (none|email) · `recipient`
(name/email/token) · `label` · `expires_at` · `revoked` · `created_at`/`by`.
Plus `card_share_views`: `share_id` · viewer (token|email|anon) · `opened_at` · `dwell` ·
`cards_seen` · `is_forward`.

**Resolution — `GET /c/:shareId`:** load share → check revoked/expired/scope → *live*: render canonical
(`getOrBuildKit`, latest) · *snapshot*: render `snapshot_data` → sign images fresh → log the view.

**Caveats:** (1) a snapshot references GCS asset *paths* — if the athlete deletes a photo the frozen
card breaks; resolve via copy-on-snapshot / soft-delete protection / graceful degradation (decide
explicitly). (2) **Version the canonical kit** (each rebuild = a version) so a snapshot pins a version
and we can always answer "what did they actually see."

### UI — what the athlete clicks (intent-first · smart defaults · progressive disclosure)
Never expose "live/snapshot/generic/per-brand" as jargon — ask *intent*, derive the fields.

**Tap "Share" →**

**① Two primary choices**
- 🔗 **Share my public card** — "Your always-current link for fans, social & bio." One tap → copies
  `nomila.co/<handle>`. *(generic · live · public · ungated)*
- 📩 **Send to a brand** — "A tracked link you can tailor and lock." → ②

**② Send to a brand**
- **To:** name + email → mints a *per-recipient tracked* link.
- **Brand:** pick/search → if set, ✨ **Tailor to [Brand]** toggle (default on → per-brand content).
- **Mode** (segmented; default *Always current*):
  - **Always current** (live) — "They see your latest every time. Best for staying in touch."
  - **Lock this version** (snapshot) — "Freezes exactly what you send today. Best when a rate/offer is on the table."
- **Attach a deal/rate?** (optional) → auto-selects *Lock this version* + suggests *Only this person*.
- **More options ▾:** Who can open — ⦿ Anyone with the link / ○ Only [contact] (they verify) ·
  ☐ Ask unknown viewers for their email · ☐ Link expires on [date]
- **[Create link]** → copy / text / email, + "Track opens."

**③ After sending — analytics view:** "Sent to Sarah @ Nike · *Always current* — 3 opens · last 2h ago ·
viewed by 2 others (forwarded)" + per-card dwell.

**Intent → fields:** Public card → `{live, public, generic, ungated}` · Send-to-brand (defaults) →
`{live, public, per-brand, tokenized recipient}` · +Lock → `snapshot` · +Only-this-person → `recipient`
scope · +Ask-email → `email` gate · +Attach-deal → `snapshot` + `recipient`.

## Spec 7 — Front-end integration (the athlete's control surface)

**Principle: the card is a web artifact; the app is the control surface.** The Nomi Card is already a
self-contained, swipeable, video-playing HTML page (`renderKitHtml`). In the app the athlete **previews
it in a WebView** pointed at `/card/:athleteId` (or `/c/:shareId`) — pixel-identical to what brands see,
zero re-implementation. The app is where she **previews · shares · sees analytics · edits**; the
brand-facing artifact stays the web link. Do NOT re-build the card in React Native.

### Two visual languages, by design
- **App chrome = Nomila's brand:** warm cream (`#FAF8F5`), pink primary (`#E84591`), Inter. The app
  palette *is* the logo — `ringBlue/green/pink/gold` = the four arc colors. This is the athlete's workspace.
- **The card = the athlete's brand:** dark editorial (ink `#0C0D10`, Archivo + Instrument Serif), with an
  **accent DYNAMIC to the athlete** (school/team/personal color — Stanford cardinal for Mia). The warm app
  *frames* the elevated dark card. **TODO:** the accent is currently hardcoded (`--cardinal` in the renderer
  CSS, not wired to `tokens.accent` or the athlete) — make it derive from athlete identity (school-colors
  source / team data / athlete-set) and inject into the theme variable. App = Nomila brand; card = athlete brand.

### Theme system (multi-look preview — SEAM in place, one look built)
The card is theme-agnostic DATA → any look renders it. `renderKitHtml(kit, theme)` dispatches via a THEME
registry; `GET /card/:id?theme=X`, `/c/:shareId?theme=X` and `GET /api/card/themes` back a preview switcher.
The athlete previews across looks in the WebView (`?theme=`) and picks one; the choice persists on
`tokens.theme` and every share renders it.

**Card looks are a product surface, in three parts:**
1. **Library themes — DONE (4 live).** Fable built the concept prototypes; all four chosen looks are now
   productionized renderers: **campaign · broadcast · immersive · luxe** (`server/services/themes/*.ts`,
   registered in `kitRenderer.THEMES`). All render the same `MediaKitData`; switch via `?theme=`. (editorial
   + warm-night set aside.) Known adaptation across themes: the audience card's giant "%" and the content
   stat-labels have no data field, so they bind to `headline`/`stats` — fine, flagged.
2. **Custom looks — a PAID tier (product idea).** The athlete describes their own concept → **Fable
   generates a bespoke theme** → it registers as just another renderer (the seam already supports this).
   Monetizable ("make your own look").
3. So **Fable's *creative* pass is NOT the card looks** (those exist / are generated on demand) — it's the
   **platform UI / athlete control surface** below.

### Placement & screens
```
Brand tab (existing hub — already renders the ConcentricRingScore / logo motif)
   └── "Your Nomi Card" → NomiCardScreen
          ├── WebView + theme switcher → /card/:athleteId?theme=X   (preview any look, exactly as brands see it)
          ├── [Share] → ShareSheet (Spec 6 UI: public / send-to-brand · live/lock · scope)
          ├── [Track opens] → SharesList + Analytics
          └── [Edit] → Editor/Picker (copy alternates + image pick)   — later
```

### Data / hooks (match the existing React Query pattern: `EXPO_PUBLIC_API_URL` + Bearer)
- `useNomiCard(athleteId)` — preview URL / `/api/card/:id` data
- `useCreateShare(athleteId)` — mutation → `POST /api/v1/athletes/:id/shares`
- `useShares(athleteId)` / `useShareAnalytics(shareId)` → `/api/v1/athletes/:id/shares`, `/shares/:id/analytics`
- **Dependency:** `react-native-webview` (not installed — add it).

### Refresh model (parked — user-in-the-loop; see also FU-kit-refresh)
Draft vs published: new data produces a draft; **facts auto-flow, creative changes stage for one-tap
approval** ("updates ready — review"); a **live** share shows the *latest published* version; **snapshots
stay frozen**. Alive + see-it-first, reusing the facts/copy split and share modes.

### Design process (creativity-first, then fold in)
Fable's creative pass is the **platform UI / control surface** — the card *looks* already exist (see Theme
system) or are generated on demand. Bring **Fable** in for the athlete-facing surfaces (NomiCardScreen frame
· theme switcher · ShareSheet · analytics · editor) — but
**withhold our design tokens/components on the first pass** (they anchor it to "safe/on-system", the same
way few-shot anchored the narrator). Feed it rich *context* (the problem, the athlete's goals, the share
scenarios, `docs/brand-story.md`) and let its creativity run → then *we* harvest the strong ideas into our
system. A **separate later session** gives Fable the full design system for a constrained build pass.
Give it the *problem + meaning*, withhold the *solution constraints*.

**First slice:** Preview + basic Share (WebView + a Share button that mints a public live link → native
share sheet, entry point on the Brand tab). Smallest real, demoable slice; exercises the whole backend.

## Spec 8 — Art direction: the shot-list contract (how the Curator picks the *right* pictures)

**Principle — story-first, not a matching matrix.** A picture editor does NOT cross-match every profile
field against every photo (that's brittle and over-complicated). They work **top-down**: (1) nail the
thesis (her value prop / arc), (2) give each frame a **role** in the story, (3) **cast** the best real
photo for each role. So image selection is a *sequence of focused choices guided by one story*, not an
N×M problem. (Editorial visual-storytelling basis: establishing / action / portrait / detail image roles;
the *set* tells the story, not one hero; every image earns its place; one tonal voice across the set.)

**Image roles (the vocabulary):** `establishing` (context — where she is) · `action` (the doing — on the
pitch) · `portrait` (the person — the emotional deciding factor) · `detail` (texture — cleats, a product)
· `proof` (the receipts — top performers). **The cards ARE the roles:** cover = hero/establishing ·
content = action/proof · audience & fit = portrait/human · (a detail crop where a card highlights a product).

**Facets (the range):** the *sides* of the athlete, mirroring the logo's arcs — for Mia: elite competitor
(Stanford), national-team athlete (US), the person (personal/diaspora), the creator (reach). The Strategist
derives her key facets from the researched profile (arc · achievements · value prop · capitals) and ensures
the deck **spans** them — that's the fix for the "5 Stanford shots" monotony.

### The contract: the Strategist writes a SHOT LIST (one image brief per card)
Derived from the profile — a creative-director brief per card, NOT a field-match:
```
{ card:"fit", role:"portrait", facet:"personal/off-field",
  mood:"warm, approachable, natural light",
  beat:"she belongs in your world — the everyday, off the pitch",
  quality:{ minAesthetic:0.5, allowEnhance:true }, brandSafe:true, excludeBrands:[…] }
```

### The Curator CASTS each brief via the Media Intelligence Layer
Each brief → a `searchMedia` query (embeddings do the semantic casting; tags do the filtering):
```
searchMedia(athleteId, {
  brief:"warm approachable off-field lifestyle portrait, natural light, off the pitch",
  filters:{ athletePresent:true, brandSafe:true, shotTypes:["portrait","lifestyle"], excludeBrands },
  purpose:"fit", k:3 })
```
→ the best real photo for that role/facet/beat. Quality: `aesthetic_quality` floor from the tags; assets
tagged `disposition:"enhance"` are eligible if `allowEnhance` (routed to Imagen later); `reject`/low are out.

### Coherence edit (the "it should all sync")
After casting, one pass ensures: **range** (key facets covered across the deck — swap if a facet is missing)
· **cohesion** (tonally consistent, or the theme's treatment unifies them) · **no redundancy** (no two cards
in the same context) · **sync** (each card's image reinforces its copy + role — the fit card's "belongs in
your world" copy sits on the off-field portrait, not another action shot). **Narrative in sync too:** the
copy deliberately touches different facets, not "elite on the pitch" five ways.

### Per-theme imagery (from a shared pool)
Selection stays theme-agnostic and runs **once** → the Curator returns a facet-diverse *pool* (more than any
one look uses); each **theme features different images/facets** from it per its mood (luxe → portrait ·
broadcast → matchday · immersive → full-bleed hero). Images vary by theme; the expensive casting runs once.

**Why it's worth it:** this is the craft that makes the kit feel *art-directed* (a visual story cast to
roles, in sync with copy + theme) rather than auto-generated — and it rides directly on the embeddings+tags
we already built. Build order: Strategist facet/role derivation → per-card briefs → Curator casting →
coherence edit → per-theme feature-from-pool.

## Facet coverage & per-theme imagery (the rings, in content — detailed in Spec 8 above)
Two related quality gaps (user-flagged): the card shows **one facet on repeat** (all Stanford action) and
drops other sides (US National Team, personal); and it uses the **same images across all themes**.
- **Facet coverage = the Strategist's job (rings in *content*).** The logo says the athlete is many facets
  (athlete · creator · entrepreneur · family · dreamer); the card should embody that through images AND
  narrative. Root cause: the Curator optimizes quality + *near-dup* removal (`diverse` MMR @0.92), not
  **context/facet diversity** — so the best shots (all one context) survive. Fix: the Strategist derives the
  athlete's key facets from research (US team · Stanford · personal) → **facet-targeted retrieval** (a
  `searchMedia` brief per facet) + a stronger MMR threshold; the narrative deliberately touches different sides.
- **Per-theme imagery from a shared pool.** Keep the data theme-agnostic: the Curator returns a facet-diverse
  POOL (more images than any one look uses); each **theme features different images/facets** from it per its
  mood (luxe → portrait/editorial · broadcast → matchday/action · immersive → full-bleed hero). Images vary by
  theme; the expensive selection still runs once. (Do after the current readability/Fable passes settle.)

## Spec 9 — Per-brand cards + the shared Brand Intelligence layer

**Principle — one brand intelligence, many consumers.** "Tailor for [brand]" = a genuinely brand-specific
card (images re-cast · copy re-framed · conflicts filtered), NOT a recipient tag. And it **reuses the brand
layer that already exists** (populated by the deal-scoring/inbox agents) — never re-researches:
- **`researchBrand`** (Gemini web search) → `category · brand_tier · audience_summary · sport_categories ·
  known_athlete_partnerships · description · logo`.
- **`inboxBrands`** stores it; brands already link to athletes via `inboxThreads`/deals.
Deal scoring, card tailoring, and the Opportunities bridge all read the SAME `inboxBrands` profile (mirrors
the Media Intelligence Layer: research once, consume many).

**Brand picker.** Primary source = the athlete's **pipeline brands** (from `inboxBrands` via `inboxThreads`/
deals — already researched, zero new work). Secondary = **search/add a brand** → triggers `researchBrand`
(the same agent) → populates `inboxBrands` → then tailor. (No brand-search surface exists yet — this is the
picker to build.)

**How the card morphs per brand** (inputs from the `inboxBrands` profile):
- **Shot list (images):** bias the facet/role casting toward the brand's `category`/`audience_summary` — a
  wellness brand → her lifestyle/personal facet; sportswear → competitor facet; beauty → portrait/aesthetic.
  Filter **competitor conflicts** from `sport_categories` + the athlete's own sponsor structure (the
  Adidas-vs-Nike logic in the brand-fit design principle).
- **Narrator (copy):** frame her value **for that brand** — audience overlap, category fit, why she's right
  for THEM — passed as brand context into the per-card briefs.
- **Tokens:** keep the athlete's accent by default (the athlete's brand, not the sponsor's).

**Data.** Extend the kit cache: `media_kits.brand_id` (null = generic, set = brand-tailored); a per-brand kit
is `getOrBuildKit(athleteId, { brandId })`, cached per athlete × brand. The shot list + narrator take a
`BrandContext` (from `inboxBrands`).

**Flow.** pick brand → (research if new, else read profile) → `assembleMediaKit(athleteId, { brand })` →
cache per athlete×brand → share (the tailored card). A not-yet-researched brand triggers the shared
`researchBrand` — which also benefits deal scoring. No duplication.

**Single dedup/reuse entry point — `getOrResearchBrand(name, domain)`.** BOTH paths converge here so a brand
is researched once: (a) a **deal comes in** → check `inboxBrands` first (via `brandResolver` normalization),
reuse if present, research only if new; (b) an **athlete picks a brand we don't have** → same function
creates + researches. Never research a brand we already hold.

**Richer profile (given the card + deal use cases).** Beyond the current fields, collect into `enrichment`:
**content style/aesthetic** (clean/bold/luxe/streetwear → informs which THEME + image treatment fits),
**current/recent campaigns** (a timely pitch hook + relevance), **brand values/voice** (copy framing),
**product categories** (image relevance), **competitors** (conflict filtering), **partnership style** (ambassador
vs one-off), **markets/geos** (audience overlap). Extend `researchBrand`'s extraction.

**Freshness (like athletes).** Brands go stale (new campaigns, shifting focus). `enriched_at` + a staleness
window; a **brand-refresh cron** re-researches on a cadence — but SELECTIVELY (below). Also re-check on a new
deal from that brand.

**Selectivity (inbox has junk).** Research is **demand-driven**, not blanket-scan: only enrich brands that are
(a) real advertisers (`is_agency=false`, has a domain / a real deal or thread) OR (b) explicitly athlete-picked.
Junk inbox brands are never auto-researched. The refresh cron only touches pipeline/active brands.

**Assembly timing.** Per-brand assembly is ~90s (shot list + narrator + casts). So **pre-assemble tailored
cards for pipeline brands** in the background (event: deal in → research brand + pre-build its card → ready
instantly when she tailors); **on-demand for a newly searched brand** (with a "preparing your card for [brand]"
wait state).

**The Opportunities bridge falls out of this** — `brand_id` is the JOIN KEY across deals · inboxThreads ·
inboxBrands · brand-tailored cards · share analytics. So: a **deal → "tailor & send a card"** action (one tap,
brand already known + researched); and **share signals → surface back on the matching deal** ("Nike opened
your tailored card 3× → advance"). The card, the deal, the share, and the analytics all reference the same
brand — synchronized by construction. That's the bridge, keyed on brand.

## Spec 10 — Card library + the editor (composition + overrides) — BUILT

The deck is no longer a fixed set: there's a **library** of card TYPES, a Strategist **default set**, and an
**editor** where the athlete composes her own deck. Built end-to-end (backend + client).

**The five new card types** (`server/services/mediaKitService.ts` `Card` union), all from EXISTING data
pipes — no new research surface:

| Card | Source | Notes |
|---|---|---|
| `payments` ("Book her") | verified `rate_card` (same as `rates`) | packages composed from rate primitives (post → The Post; 3-post bundle → The Series "most booked"; `ambassador.monthlyRetainer` → The Season; `appearance.ratePerEvent` → In Person). A `book` CTA → **placeholder checkout** (a toast; the Stripe seam) |
| `whyFits` ("Why she fits you") | `BrandContext` (Spec 9) + verified audience/credibility | brand-tailored kits ONLY; 3 numbered *insights* (audience / credibility / whitespace), each `basis`-tagged |
| `story` ("The Story") | `research.achievements` (dated) | chronological beats + one serif close; opt-in |
| `values` ("What she stands for") | athlete-authored / `research` causes | self-reported, marked; opt-in; only when causes exist |
| `achievements` ("The Record") | `research.achievements` ranked by level | one hero honor at size + a ≤4 ledger |

**Deck composition.** `MediaKitData.deck: string[]` is the ordered DEFAULT set; cards assembled but not in
`deck` are the **library** (addable in the editor). Rules: default = the 8 + `payments` (default-on when rates
verified, placed rates→payments→fit: evidence → transaction → relationship) + `achievements` (conditional:
≥3 verified, ≥1 national+); `story`/`values` opt-in; `whyFits` auto-enters brand-tailored decks after `cover`,
never the generic deck. The renderer renders `deck` order (falls back to raw `cards` order).

**The editor = a thin overrides layer at serve** (`server/services/cardOverrides.ts`, table `card_overrides`
keyed athlete × brand). The base kit stays fully regenerable; edits re-apply after cache-load, before render
(`getOrBuildKit` → `applyOverrides`; pass `raw` to get the un-edited base — the editor needs it, with the full
library + copy alternates). `CardOverrides = { order?, removed?, added?, copy?, images? }`:
- **order / removed / added** — deck sequence + inclusion (cover pinned first, can't be removed).
- **copy** — `{ "${cardId}.${field}": { text, pick? } }`. Only the crafted-copy fields (a whitelist per card
  type in `EDITABLE`) — the Narrator's eyebrow/tagline/extra layer. The ~5 gated alternates (previously unused)
  are surfaced as `kit.copyAlternates` for the picker; the athlete picks one or writes her own.
- **images** — `{ cardId: gcsPath }`, swapped from curated candidates (`kit.imagePool`) only.
- **What she can NEVER override:** the facts layer (stats, meters, rates math, provenance chips). Verified
  means verified — the moat. Snapshots freeze the *resolved* deck (base + overrides).

**Endpoints:** `GET /api/v1/athletes/:id/card-editor?brandId=` (base kit shaped for editing — each card with its
editable slots + alternates + signed image, the deck/library split, saved overrides, signed swap pool) and
`PUT /api/v1/athletes/:id/card-overrides?brandId=` (save; applies at next serve).

**Editor client** (`client/screens/CardEditorScreen.tsx`, `client/hooks/use-card-editor.ts`): drag-reorder
(`react-native-draggable-flatlist`; cover pinned as a fixed header), add/remove from the library, copy-picker
(alternates + "write your own"), photo-swap, diff-based Publish/Reset. Launched from NomiCardScreen's "Edit
details"; on return the WebView cache-busts so published edits show. Warm app chrome (theme.ts), distinct from
the dark card — Spec 7's "two visual languages, by design".

**Follow-ups:** the new library cards render in the **campaign** theme only (broadcast/immersive/luxe skip them
for now); Narrator briefs for the new slots (`payments.lead`, `story` beats, `whyFits` reasons) — the `pick()`
seam makes them drop-in; real Stripe checkout behind the `payments` `book` CTA; `press`/`partners`/`contact`
library slots (designed, marked "Soon").

## Open items for these specs
- `benchmarks` source for percentile framing (per sport / follower-tier).
- Exact neutral-prior / confidence-band math in `scoringService` for unknown dimensions.
- Productionize the new library cards across the broadcast/immersive/luxe themes (campaign done).
- Token override breadth — confirm accent-only vs a slightly wider set per theme.
