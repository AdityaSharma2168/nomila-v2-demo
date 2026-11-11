# Feasibility Audit — Five Product Concepts vs. the Codebase (2026-07-11)

Staff-engineer read of what `nomila-v2` can support **today**. Every claim cites a file or
table. Grades are feasibility-now (1–5), not attractiveness.

---

## 0. Orientation — corrections to the brief's premises

**The `users` / `athlete_profiles` split does not exist in this repo.** `shared/schema.ts`
has exactly 18 tables; the identity root is **`athletes`** (`schema.ts:63`) which holds auth
(`auth_provider`, `auth_id` — Firebase), billing (`stripe_customer_id`, `plan`), identity
facts (sport/school/division/conference), and onboarding goals (`goal_archetype`,
`secondary_goals`, `brand_voice`, `deal_preferences`). **`athletes_current`**
(`schema.ts:133`) is a 1:1 latest-state projection (display_score, tier, capitals, pav,
deal_type_rates, rate_card, follower counts, story_arc, insights). Roles live in
`account_roles` (`schema.ts:414`), where `athletes.id` doubles as the account id. The
scoring engine is gated on `athletes.id` — **there is no users-table migration to wait
for.** Any concept plan that sequences behind that migration is sequencing behind a
non-existent gate.

**Score history EXISTS — this brief's "if we only store current values" hedge resolves
YES-history.** `athlete_snapshots.score` JSONB (`schema.ts:123`) stores per-snapshot
`displayScore`, `tier`, `capitals`, `momentum`, `pav`, `dealTypeRates` (verified in prod:
Mia has 11 snapshots, 2026-06-09 → 2026-07-10, displayScore 455 → 500 → 551, all 11 with
score payloads). Additionally `social_analytics_snapshots` (`schema.ts:497`) holds **daily**
per-platform metric rows (one per athlete × platform × UTC day; 36 IG / 12 TikTok / 2 YT
rows in prod). Cadence caveat: `athlete_snapshots` is event-driven (connect, re-enrich,
scheduled refresh writes only on change — `refreshScores.ts` skips `unchanged`), so score
series are irregular; the daily analytics table is the uniform time base.

**Key pipelines (by name):**
- **Inbox ingestion:** `registry.ts:29–33` INBOX = gmail, outlook, instagram.
  Gmail = Pub/Sub push (`gmail.ts:393–421`) with `gmail_history_id` cursor advanced
  after-processing (`webhooks.ts:105–151`) + cron fallback (`inboxCronSync.ts`) + 90-day
  backfill on connect. IG DMs = webhook (`webhooks.ts:215–316`) + poll
  (`instagram.ts:528–585`) — **no cursor**; `connected_accounts.sync_cursor`
  (`schema.ts:402`) is declared but never read/written.
- **Deal detection:** `dealDetector.ts:145` `detectDeal()` — preFilter → Kimi classify
  (categorical `PAID|MEDIA|EDITORIAL|GIFTING|FAN|SCHOOL_NIL|NOISE` + confidence +
  `offer_amount`) → `resolveBrandIdentity()` → thread+message upsert (idempotent on
  `(thread_id, external_message_id)`, `schema.ts:291`) → `scoreDeal()`
  (`dealDetector.ts:687–858`).
- **Derive-don't-emit: real.** `dealScoreGrid.ts:1–10`: "The 1–10 score is DERIVED here,
  not emitted by the LLM." Kimi emits categorical fit ratings + a structured
  `OfferStruct`; `economicsBand()` positions the offer **inside the athlete's own rate
  card** (`ABOVE/UPPER/LOWER/BELOW`), `composeScore()` indexes a fixed grid. The
  1–10 lives in `inbox_threads.score` JSONB (`dealDetector.ts:430`) — **not** on `deals`.
- **M.I.A. scoring:** `scoringService.ts` `computeScore()` → capitals (audience /
  athletic / brand / commercial [+ narrative for rates]) from `snapshot.social` +
  research + Trends + GDELT; written per-snapshot and projected to `athletes_current`.
  Rate card v3.1 (`rateService.ts`) rides the same path.
- **Media/content:** **read-only references only.** `research.media_assets` = external
  URLs from Gemini research (`researchAthlete.ts:73–75`);
  `raw_metrics.recent_media[]` = **ephemeral IG CDN links** with an explicit "re-download
  to GCS when the media kit is built" future-note (`schema.ts:451–453`). **No upload
  endpoint, no GCS/S3 client, no camera-roll ingestion anywhere in client/ or server/.**
  `tasks.type` enum already reserves `media_kit` and `brand_stories`
  (`schema.ts:311–324`) but **no handler populates `athletes_current.brand_stories`**
  today (only a `include_media_kit` flag on a deals route, `deals.ts:235–345`).
- **Brand identity:** `inbox_brands` keyed on UNIQUE `normalized_name`, nullable
  canonical `domain`, `is_agency`, `brand_tier`, `category`, `sport_categories`,
  `enrichment` (`schema.ts:221–241`). `brandResolver.ts` = 4-strategy resolve (domain →
  domain-root → Levenshtein ≥ 0.75 → create) + **hardcoded** `AGENCY_DOMAINS` set
  (`brandResolver.ts:35–41`). Threads carry `brand_id` FK; `deals.brand_name` is
  **denormalized text with no FK** (`schema.ts:168`).
- **Outbound send paths that exist:** `sendGmailReply` (`gmail.ts:326`, hits
  `messages/send`; `gmail.send` is a **Google-restricted scope**, noted at `gmail.ts:25`)
  and `sendInstagramDM` (`instagram.ts:638`). Both are reply-shaped, inside existing
  threads.

Prod volume (grounding, 2026-07-11): 167 `deals` rows across 3 athletes, 99 distinct
brand_names, **24 with `amount`**; 199 threads / 273 messages / 106 senders / 102 brands.

---

## 1. REVERSE PITCH ENGINE — outbound brand pitches

**BUILDS ON**
- Pricing: `athletes_current.rate_card` (v3.1, per-platform + per-deal-type ranges,
  `rateService.ts`) — the "suggested pricing" input exists and is calibrated.
- Fit evidence: `athletes_current.capitals` + `display_score` + `story_arc`;
  `inbox_brands.category / sport_categories / brand_tier / enrichment` for matching.
- Narrative: `research` JSONB (achievements, press, story_arc) via `researchAthlete.ts`.
- Send rail: `sendGmailReply` (`gmail.ts:326`) proves the Gmail send path + scope.
- Draft plumbing: `inbox_threads.latest_draft` JSONB (`schema.ts:262`) — drafting
  pattern exists for replies.

**MISSING**
- *Pipeline gap:* **new-thread outbound compose.** Both send functions are
  reply-in-thread. Cold pitch = new message to a new recipient — new function, plus
  deliverability/spam posture.
- *Data-never-touched gap:* **brand contact discovery.** `inbox_senders` only has
  contacts for brands that already wrote in. Cold brands have no contact source — needs
  enrichment (external API or research).
- *Data-never-touched gap (partial):* "campaign concept from athlete media" — media is
  ephemeral CDN links; no durable asset library to build a visual pitch from.
- *Schema gap (minor):* nothing records outbound pitches/outcomes (a `pitches` table or
  `deals.source='outbound'` extension — note `deals_source_check` doesn't include an
  outbound value today, `schema.ts:186`).

**LANDMINES**
- `gmail.send` is a **restricted Google scope**; cold outbound at volume from athlete
  Gmail accounts risks the OAuth verification and spam reputation. Sending *as Nomila*
  instead means an email-infra build (domain, warm-up, CAN-SPAM).
- Consent: pitching *on behalf of* an athlete needs explicit athlete approval flow —
  the `deals.pending_action` approve-before-execute pattern (`schema.ts:178`) is the
  right precedent and should be reused.
- No users-migration gate (doesn't exist).

**SMALLEST REAL SLICE (<2 weeks): yes** — "pitch pack, athlete-sends." Generate the
pitch (concept + fit evidence + rate-card pricing) from existing data for a brand
**already in `inbox_brands`** (warm, has a sender email), render as a draft the athlete
copies/sends themselves (or via `sendGmailReply` when the brand thread already exists).
Skips cold-contact discovery, new-thread send, and deliverability entirely.

**GRADE: 3/5** — every *input* (pricing, fit, narrative, brand profiles) exists in
queryable form today, but the two hard parts — cold contacts and a compliant outbound
send rail — are absent, and `deals_source_check` doesn't even admit an outbound deal yet.

---

## 2. NIL RATE INDEX — aggregated deal pricing + underpriced flags

**BUILDS ON**
- **The per-deal half already ships.** `dealScoreGrid.economicsBand()` positions every
  inbound offer against the athlete's own rate card (`ABOVE/UPPER/LOWER/BELOW`) —
  i.e., "underpriced-deal flags" exist per-deal in `inbox_threads.score` and drive the
  recommendation via `reconcileRecommendation()`. Counter drafting: `latest_draft` +
  `negotiation_state` already exist.
- Raw pricing rows: `deals.amount` (numeric, populated from inbox by
  `dealDetector.ts:441,453`), `deal_type`, `status`; richer `offer_struct`
  (amount/unit/deliverable_counts) in `inbox_threads.conversation_state.key_details`.
- Dimensions: sport/division on `athletes`, score band on `athletes_current`,
  brand category via `inbox_threads.brand_id → inbox_brands.category`.

**MISSING**
- *Schema gap:* no aggregation layer — no anonymized fact table
  (deal × sport × level × score-band × category × unit-normalized amount). The
  offer_struct needed for unit normalization lives in **thread JSONB**, not on `deals`,
  and `deals` has **no brand FK** (text `brand_name`) — joins for category go through
  the thread.
- *Pipeline gap:* `rateVsMarket` is deliberately `null` (`dealDetector.ts:792–797`,
  "Phase 1 does no deterministic market-% compute") — the market comparison hook exists
  but is intentionally unfilled.
- *Data-volume gap (the killer):* **24 deals with amounts, from 3 athletes.** An
  "index queryable by sport/level/score band/category" on n=24 from 3 inboxes is not an
  index; it's an anecdote. This is a scale problem no schema fixes.

**LANDMINES**
- **Privacy/consent:** amounts are extracted from athletes' *private inboxes*. Aggregating
  them into a cross-athlete product — even anonymized — is beyond what connect-consent
  plausibly covered; with 3 athletes, k-anonymity is impossible (any sport/level cell is
  identifying). Needs explicit ToS/consent language *before* any cross-athlete surface.
- Cross-athlete aggregation strains current shapes: everything is keyed per-athlete;
  amounts are unit-heterogeneous (`per_post` vs `total` vs `monthly` —
  `OfferUnit`, `dealScoreGrid.ts:22–24`) so naive AVG(amount) is meaningless without the
  unit normalization that lives in thread JSONB.

**SMALLEST REAL SLICE (<2 weeks): yes — internal-only.** (a) Copy `offer_struct` onto
`deals` (or a view extracting it from thread JSONB), (b) a nightly job materializing an
internal `deal_pricing_facts` table with unit-normalized per-post amounts, (c) surface the
already-computed EconBand flags in the athlete UI ("this offer is BELOW your card").
No cross-athlete product until volume + consent exist.

**GRADE: 3/5** — the per-athlete machinery is genuinely done (grid, bands, rate cards),
but the *index* part is gated on data volume (24 priced deals) and consent, neither of
which code can conjure.

---

## 3. THE SEASON — weekly serialized athlete episodes

**BUILDS ON**
- Narrative raw material: `story_arc` + `research` (press, achievements) +
  `chat_messages` (athlete voice in text) + daily `social_analytics_snapshots` for
  "what happened this week" numbers.
- Job infra: `tasks` table with LISTEN/NOTIFY progress (`schema.ts:306–324`) and
  node-cron scheduling (`server/index.ts`) could host a weekly assembly job.

**MISSING — three data classes we have never touched**
- *Data-never-touched:* **results/schedule ingestion.** Zero sports-data integration
  (all `schedule|game|score` greps are false positives: `scheduled_refresh` enum,
  prompt strings, Capital-Score). Needs an external sports-data API + team/opponent
  mapping — a whole new ingestion domain.
- *Data-never-touched:* **voice-memo input.** No audio upload, no storage, no
  transcription path anywhere.
- *Data-never-touched / pipeline:* **durable media.** Episodes assembled from
  `recent_media` ephemeral CDN URLs will rot; the GCS re-download is explicitly
  flagged as unbuilt (`schema.ts:451–453`). Also no video assembly/rendering anything.
- *Schema gap:* nothing to hold episodes (table, states, publish targets).

**LANDMINES**
- Compounding freshness: weekly episodes demand schedule-aware timing and reliable weekly
  media — IG media fetch is best-effort and Business-Discovery-gated for unconnected
  athletes (Advanced Access still pending). A missed week is visible product failure.
- This is a *content production* pipeline (curation, rendering, tone) — a different
  engineering species from everything else in the repo, which is analysis-shaped.

**SMALLEST REAL SLICE: none honestly shippable in <2 weeks.** A text-only "Week in
Review" card (analytics deltas + press hits) is shippable but is not "The Season" — it's
a newsletter, and calling it an episode over-promises. The concept's identity depends on
media + results, both absent.

**GRADE: 1/5** — three of its four inputs (results, voice memo, durable media) are
data classes the codebase has never ingested; only the narrative text layer exists.

---

## 4. FAN LEDGER — per-fan engagement history + tiered access

**BUILDS ON**
- `inbox_messages.sender_ig_user_id` (`schema.ts:286`) — IG DM senders are identified;
  `inbox_senders` (email-keyed, `message_count`, `first_seen_at`, `schema.ts:296–304`)
  is a working *sender* ledger pattern to copy.
- The `FAN` classification category already exists in the Kimi classifier
  (`dealDetector.ts:78–92`) — fan DMs are being labeled today (and currently dropped
  as noise).

**MISSING**
- *Data-never-touched:* **comment mining.** We store comment **counts only**
  (`avg_comments`, `comments_count` — `instagram.ts:235–439`). Per-comment text +
  author ingestion doesn't exist, and would require the
  `instagram_business_manage_comments` scope — **not held, not in the current App
  Review plan** (only basic/insights/messages are).
- *Data-impossible (flag):* **"early-follower status" cannot be built.** No Instagram
  API we hold (or can request) returns follower *lists* or follow *dates* — follower
  identities simply aren't exposed. Comment/DM tenure (`first_seen_at`) is the only
  lawful proxy.
- *Schema gap:* a `fans` identity table (IG user id keyed, cross-thread), streak/tenure
  aggregates, and the entire tiered-access grant model (nothing exists).
- *Pipeline gap:* a comment-ingestion job + per-fan rollups.

**LANDMINES**
- **Privacy:** mining fan identities from DMs/comments into a ledger with access tiers is
  processing third parties' personal data — those fans never consented to Nomila.
  App-Review optics for `manage_comments` with "we build fan dossiers" as the use case
  are poor; expect rejection unless framed as engagement analytics.
- The DM-side data lives behind the **messaging Advanced Access review** (weeks–months,
  strictest track) — this concept is double-gated on Meta.

**SMALLEST REAL SLICE (<2 weeks): borderline.** A DM-only "top supporters" card from
existing rows: `sender_ig_user_id` + `first_seen_at` + message counts across
FAN-classified threads. Shippable, but thin — comments are where fan engagement actually
lives, so it materially undersells the concept.

**GRADE: 2/5** — DM sender identity exists, but the core substrate (comments) was never
ingested, needs a scope we haven't requested, and one advertised feature
(early-follower status) is not obtainable from any API we can get.

---

## 5. EARNINGS REPORTS — recurring shareable visual report

**BUILDS ON (nearly everything)**
- **M.I.A. movement over time: exists.** `athlete_snapshots.score` per-snapshot history
  (displayScore/capitals/momentum, verified 455→500→551 for Mia) + daily
  `social_analytics_snapshots` series + the `/history` trends endpoint
  (`routes/analytics.ts:72–101`) already computing 7d/30d deltas.
- Deal activity: `deals` (status lifecycle, amounts, `detected_at`) + thread scores.
- Highlights: top posts already stored in `raw_metrics.recent_media` (permalinks are
  durable even though CDN thumbnails rot).
- Rate card + PAV for the "earnings" framing; `insights` and `story_arc` fields for copy.
- Trigger infra: `tasks.type` already enumerates `media_kit`-style generation jobs;
  cron exists for recurrence.

**MISSING**
- *Pipeline gap:* the **renderer + share surface** — no report generator, no share-link
  infra, no PDF/image export anywhere (client is RN; a server-rendered share page or
  image needs building). This is the whole build, but it's presentation-layer, not data.
- *Schema gap (minor):* a `reports` table (id, athlete_id, period, payload, share_token)
  if reports are persisted/shareable rather than rendered live.
- *Cadence caveat:* score snapshots are event-driven; a weekly report must tolerate
  "no change this week" gracefully (the daily analytics table fills that hole).

**LANDMINES**
- "Earnings" naming vs. data honesty: `deals.amount` is stated-offer, not confirmed paid
  income (24/167 have amounts). Report copy must say "deal activity," not revenue, or
  it invites disputes.
- Sharing publicly leaks inbox-derived info (brand names in negotiation) — the share
  view needs a redaction pass (show counts/stages, not brand names, unless accepted).

**SMALLEST REAL SLICE (<2 weeks): yes, comfortably.** A monthly server-rendered share
page per athlete: score trend (snapshots), follower/engagement deltas (analytics
history), deals detected/negotiating counts, top-3 posts by reach. All queries exist;
the work is one route + one template + a share token.

**GRADE: 4/5** — the only concept where every data input verifiably exists today; the
gap is purely a rendering/share layer, which is real work but zero-risk work.

---

## Ranking (feasibility × reuse of existing pipelines)

| # | Concept | Grade | Reuse density | Why |
|---|---|---|---|---|
| 1 | **Earnings Reports** | 4/5 | Very high — score history, analytics history, deals, rate card all queryable now | Pure presentation gap |
| 2 | **NIL Rate Index (internal half)** | 3/5 | Very high — `dealScoreGrid` EconBand *is* the underpriced flag | Index half gated on volume (n=24) + consent |
| 3 | **Reverse Pitch Engine** | 3/5 | High — pricing/fit/narrative/brand layer + Gmail send rail | Cold contacts + outbound compose missing |
| 4 | **Fan Ledger** | 2/5 | Low — DM sender ids only | Comments never ingested; scope not requested; follower-dates impossible |
| 5 | **The Season** | 1/5 | Minimal — narrative text only | Results, voice memo, durable media: all never-touched |

## The single unblocking build: a durable media/asset layer

**Media ingestion + storage (GCS re-hosting of IG media, plus an upload endpoint) is the
one piece that unblocks the most concepts at once.** It is the named-but-unbuilt
dependency in the schema itself (`schema.ts:451–453` "re-download to GCS when the media
kit is built"), and it feeds: Reverse Pitch (campaign concepts from real content), The
Season (episode assets), Earnings Reports (highlight images that don't rot), the
already-enum'd `media_kit` task type, and any future pitch-deck/brand-story rendering.
Score history — the other candidate — **already exists**, and a cross-athlete
aggregation layer unblocks only the Rate Index (which is data-volume-gated anyway).

## Where the brief assumed data we do NOT have

1. **`users` / `athlete_profiles` split + migration gate** — neither table exists;
   auth+billing+identity are one `athletes` table. No migration to sequence behind.
2. **The Season:** results/schedule data (no sports-data ingestion exists) and
   voice-memo input (no audio path exists).
3. **Fan Ledger:** "early-follower status" — follower lists/dates are not exposed by
   any Instagram API tier we can obtain; comment tenure is the only proxy, and comment
   ingestion itself doesn't exist yet (counts only, scope not requested).
4. **Rate Index:** assumes priced-deal volume; prod has **24 amounts across 3
   athletes** — an index isn't statistically possible yet (and cross-athlete use of
   inbox-derived pricing needs consent language that doesn't exist today).
5. **Reverse Pitch:** "athlete media" as pitch input — only ephemeral CDN URLs today;
   also no brand-contact source for brands that never emailed us.
6. *(Inverse — assumed missing but actually present:)* score **history** exists
   per-snapshot, and the **underpriced-deal flag** already ships inside
   `inbox_threads.score` via `dealScoreGrid`.
