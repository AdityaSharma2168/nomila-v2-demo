import { sql } from "drizzle-orm";
import { pgTable, text, serial, integer, smallint, boolean, timestamp, jsonb, numeric, uuid, doublePrecision, date, bigint, index, uniqueIndex, check, primaryKey, unique, foreignKey } from "drizzle-orm/pg-core";
// Needed for media_assets.derived_from_asset_id, which points back at its own table.
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// ─── JSONB shape documentation ───────────────────────────────────────────────
//
// SocialSnapshot: the exact shape stored in athlete_snapshots.social
// §5 contract: Performance Capital reads _computed fields from up to 8 historical
// snapshots. Missing snapshots fall back to baseline (0.5) per §5 edge-case rule.
//
//   computeContentConsistency()    reads: _computed.content_frequency    (needs 8)
//   computeEngagementStability()   reads: _computed.avg_engagement_rate  (needs 8)
//   computeFollowerGrowthRate()    reads: _computed.total_followers       (needs 2)
//   computeCrossPlatformConsistency() reads: _computed.cross_platform_consistency (needs 1)
//   computeEngagementVelocity()    reads: _computed.avg_engagement_rate  (needs 4)

export type SocialSnapshot = {
  instagram?: {
    handle: string;
    followers: number;
    engagement_rate: number;
    posts_last_30d: number;
    avg_likes: number;
    avg_comments: number;
    verified: boolean;
    fetched_at: string;
  };
  tiktok?: {
    handle: string;
    followers: number;
    engagement_rate: number;
    posts_last_30d: number;
    avg_views: number;
    verified: boolean;
    fetched_at: string;
  };
  x?: { handle: string; followers: number; fetched_at: string };
  youtube?: { subscribers: number; fetched_at: string };
  spotify?: { monthly_listeners: number; fetched_at: string };
  _computed: {
    total_followers: number;
    content_frequency: number;
    avg_engagement_rate: number;
    platform_count: number;
    cross_platform_consistency: number;
  };
};

export type SnapshotSources = {
  apis_called: string[];
  kimi_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
  };
};

// ─── 1. athletes ─────────────────────────────────────────────────────────────

export const athletes = pgTable("athletes", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  full_name:            text("full_name").notNull(),
  first_name:           text("first_name"),
  last_name:            text("last_name"),
  sport:                text("sport"),
  // 0122: the athlete's OTHER sports, in the order they picked them (the onboarding sport grid). `sport` stays the main
  // sport for every reader; this never repeats it. Empty = one sport, or nobody has said.
  other_sports:         text("other_sports").array().notNull().default(sql`'{}'::text[]`),
  // school / division / conference are a PROJECTION of the primary current athlete_affiliations
  // row (server/services/affiliations.ts). Read the rows for anything new; these stay for the
  // readers that predate them.
  school:               text("school"),
  division:             text("division"),
  conference:           text("conference"),
  // Declared by the athlete (landing step, Mila, Facts) — never inferred from an empty team list.
  career_status:        text("career_status").notNull().default("active"),
  // GENERATED ALWAYS AS (CASE ... END) STORED
  // 'pro' requires division='Pro' explicitly — school alone no longer implies pro
  segment: text("segment").generatedAlwaysAs(
    sql`CASE
      WHEN "division" IN ('D1','FBS','FCS','D2','D3','NAIA','JUCO','NJCAA') THEN 'college'
      WHEN "division" IN ('HS','High School') THEN 'high_school'
      WHEN "division" IN ('Youth','Club','AAU') THEN 'youth'
      WHEN "division" = 'Pro' THEN 'pro'
      WHEN "division" = 'Olympic'
        OR "school" ILIKE '%olympic%'
        OR "school" ILIKE '%team usa%'
        OR "school" ILIKE '%national team%' THEN 'olympic'
      ELSE 'unknown'
    END`,
  ),
  status:               text("status").notNull().default("raw"),
  // Account deletion phase 1 (0145): set when the athlete asks to delete the account. From then on requireAuth refuses
  // their requests, no workflow run starts for them and no Mila turn writes for them; phase 2 (the account_deletion
  // workflow) purges their rows, this one last. NULL for every live account.
  deletion_requested_at: timestamp("deletion_requested_at", { withTimezone: true }),
  auth_provider:        text("auth_provider"),
  auth_id:              text("auth_id"),
  email:                text("email"),
  photo_url:            text("photo_url"),
  // Landing-page capture fields (status='waitlisted' until admin activates).
  // { instagram?, tiktok?, youtube?, twitter? } — non-empty handle count drives waitlist rank.
  socials:              jsonb("socials").notNull().default(sql`'{}'::jsonb`),
  referral_code:        text("referral_code"),
  stripe_customer_id:   text("stripe_customer_id"),
  plan:                 text("plan").default("free"),
  goal_archetype:       text("goal_archetype"),
  secondary_goals:      jsonb("secondary_goals"),
  brand_voice:          jsonb("brand_voice"),
  deal_preferences:     jsonb("deal_preferences"),
  created_at:           timestamp("created_at", { withTimezone: true }).defaultNow(),
  claimed_at:           timestamp("claimed_at", { withTimezone: true }),
  enriched_at:          timestamp("enriched_at", { withTimezone: true }),
  // One-time acknowledgment that uploaded media is theirs/rights-cleared (gates camera-roll upload).
  media_rights_ack_at:  timestamp("media_rights_ack_at", { withTimezone: true }),
  // 0124: true only for an athlete created through the new agent-onboarding front, or who later opted in explicitly
  // (POST /agent/onboarding/start, optIn: true). Written once at signup (server/routes/auth.ts); the gate in
  // server/agent/onboarding/service.ts reads it ONLY while no agent_onboarding run exists yet — once a run exists
  // it is read from the run instead. Defaults false, so every pre-existing athlete skips the new onboarding.
  agent_onboarding_required: boolean("agent_onboarding_required").notNull().default(false),
  // 0139 (anti-fake plan, 24 Oct 2026): signals for the admin list, never a block. Keyed by flag
  // (disposable_email · same_network_burst · no_athlete_footprint), each { at, ...detail }; written by lib/signupFlags.ts at
  // account creation (and by the footprint check). NULL = no flags. Never holds an IP or anything in the clear about one.
  signup_flags:         jsonb("signup_flags"),
}, (table) => [
  check("athletes_status_check", sql`${table.status} IN ('waitlisted','raw','enriched','claimed','active')`),
  check("athletes_plan_check",   sql`${table.plan} IN ('free','studio','agent')`),
  check("athletes_career_status_check", sql`${table.career_status} IN ('active','between_teams','out_this_season','retired')`),
  // Step 2c closure (0049): one user id on at most one athlete row (rows without a user unconstrained).
  uniqueIndex("athletes_auth_id_uq").on(table.auth_id).where(sql`auth_id IS NOT NULL`),
]);

// ─── 2. athlete_snapshots ────────────────────────────────────────────────────

export const athleteSnapshots = pgTable("athlete_snapshots", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id),
  created_at:           timestamp("created_at", { withTimezone: true }).defaultNow(),
  trigger:              text("trigger").notNull(),
  research:             jsonb("research"),
  google_trends_score:  numeric("google_trends_score"),
  gdelt_article_count:  integer("gdelt_article_count"),
  // Shape: SocialSnapshot (see type above) — _computed fields required for scoring
  social:               jsonb("social"),
  deals:                jsonb("deals"),
  // (score — the legacy v7.2 score result — dropped by 0127, legacy retirement.)
  // Shape: SnapshotSources — { apis_called: string[], kimi_usage?: { prompt_tokens, completion_tokens, total_cost_usd } }
  sources:              jsonb("sources"),
  // Shape: FirstLook (server/skills/firstLook.ts) — what the athlete's own posts say about them,
  // written once per connect on the social_connect row. NOT a scoring input.
  first_look:           jsonb("first_look"),
  // Phase A (migration 0043). The instant the evidence set behind this snapshot is "current
  // at" (Commercial Intelligence spec §21.1). NULL on every row today — a reader treats NULL
  // as created_at, so no backfill is required.
  as_of:                timestamp("as_of", { withTimezone: true }),
  // The PRIMARY engine/result associated with this snapshot, e.g. 'marketability=v1.0-beta.1'.
  // NULL on rows written by the retired v7 engine (its scoring_weights table was dropped by 0127). Multi-engine
  // lineage (rate, opportunity, earnings versions) belongs in the structured result, not here.
  engine_version:       text("engine_version"),
}, (table) => [
  check("snapshots_trigger_check", sql`${table.trigger} IN ('signup','social_connect','inbox_connect','scheduled_refresh','manual','re_enrich','first_look')`),
  index("idx_snapshots_athlete").on(table.athlete_id, table.created_at),
]);

// ─── 3. athletes_current ────────────────────────────────────────────────────

export const athletesCurrent = pgTable("athletes_current", {
  athlete_id:             uuid("athlete_id").primaryKey().references(() => athletes.id),
  story_arc:              text("story_arc"),
  // (brand_stories / insights — v1 columns never written or read in v2 — dropped by 0091.)
  // (The legacy /850 score, tier, capitals, v3 rate card / PAV / deal-type rates, the follower and research-count
  //  copies, latest_snapshot_id, score/social timestamps and spotify_listeners — dropped by 0126, legacy retirement.)
  research_updated_at:    timestamp("research_updated_at", { withTimezone: true }),
  updated_at:             timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── 4. deals ────────────────────────────────────────────────────────────────

export const deals = pgTable("deals", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id),
  brand_name:           text("brand_name").notNull(),
  // Real brand identity (docs/opportunity-pitch-content-model.md §5). `brand_id` is the
  // ADVERTISER; nullable during the transition (legacy rows keep `brand_name` as the display
  // fallback). `broker_brand_id` is the agency/MCN brokering the deal, if any (P1).
  brand_id:             integer("brand_id").references(() => inboxBrands.id),
  broker_brand_id:      integer("broker_brand_id").references(() => inboxBrands.id),
  deal_type:            text("deal_type"),
  // TOTAL guaranteed value: amount_cash + amount_product. Commission is excluded — it is
  // contingent on sales that have not happened, so counting it would be inventing a number.
  amount:               numeric("amount"),
  // The split, mirroring the summarizer's offer_struct, which is its single source. All
  // three are written in the same statement as `amount`, so none can drift from the total.
  //
  // The distinction is not cosmetic. A clinic offering "treatments worth USD 2,000" for a
  // visit the athlete must fly to Korea to make stores as a $2,000 total, which reads
  // identically to $2,000 cash in every surface that shows a number. With the split, Mila
  // can say "in treatments, no cash", and ranking can use amount_cash where hard money is
  // what matters.
  amount_cash:          numeric("amount_cash"),
  // What the brand STATED a product / gifting / service component is worth — a ceiling, not
  // an assessment. See OfferStruct.product_value for why no discount is applied.
  amount_product:       numeric("amount_product"),
  // Percentage of sales, when offered. Deliberately outside `amount`: real money that
  // matters at PAYMENT time once actual sales are known, and speculative before then.
  commission_pct:       numeric("commission_pct"),
  // The contract TERM — when the engagement runs, not when a deliverable is due. The
  // summarizer's key_details.deadlines[] are POST-BY dates; a contract with six posts has
  // six of those and one expiry, and only the expiry says whether the deal is still live.
  // Calendar dates, not timestamps: "through 31 Dec 2026" is true in every timezone, and
  // midnight-UTC would render as the 30th for an athlete on the US west coast.
  // NULL = not recorded. Never read a null term_end as perpetual, or as expired.
  term_start:           date("term_start"),
  term_end:             date("term_end"),
  // 6 states: detected → pending → negotiating → accepted/rejected/completed
  status:               text("status").default("detected"),
  detected_at:          timestamp("detected_at", { withTimezone: true }),
  source:               text("source"),
  // Which way intent flows — 'inbound' (brand → athlete) | 'outbound' (athlete/agent → brand).
  // Static provenance, orthogonal to `status`/`source` (docs §4).
  direction:            text("direction"),
  // "Signed" is HER confirmed fact, not a status (migrations/0094; docs/design/brand-page-deals.md D1):
  // when she said it is signed — her "Yes, it's signed" ('confirmed') or a contract she saved marked signed
  // ('contract'). Set only by those taps; the summariser, paperwork and every model path never write it.
  // NULL = not confirmed (never "unsigned").
  signed_at:            timestamp("signed_at", { withTimezone: true }),
  signed_source:        text("signed_source"),
  raw_data:             jsonb("raw_data"),
  // Accumulated negotiation preferences across turns; expires_at handles TTL
  negotiation_state:    jsonb("negotiation_state"),
  // Agent creates pending action; athlete must approve before execution
  pending_action:       jsonb("pending_action"),
  // Athlete bookmarked this deal for later (cross-cutting flag, not a lifecycle status)
  saved:                boolean("saved").default(false),
  // Commission-engine escrow state (payments-commission-engine.md §6) — kept SEPARATE
  // from `status` (the negotiation lifecycle); payment state never overloads that enum.
  payment_status:       text("payment_status").default("none"),
  // Seriousness-deposit state — drives the "✓ Verified serious" badge + inbox ranking boost.
  deposit_status:       text("deposit_status").default("none"),
  // Cross-thread grouping: multiple deals (each its own email thread) that are the SAME
  // underlying deal share one group id — e.g. gorjana's contract-signature + executed-
  // agreement threads. NULL = ungrouped (the deal is its own group). Set deliberately by
  // the grouping script (server/scripts/groupDeals.ts); rolled up read-side in loadRankedDeals.
  deal_group_id:        uuid("deal_group_id"),
  // The opportunity this deal belongs to (Opportunities PR 2, migrations/0084): every thread
  // about one brand lands under one opportunity. Threads reach it through thread.deal_id, so
  // there is no copy on inbox_threads to keep in sync. NULL = not placed yet (pre-backfill).
  opportunity_id:       uuid("opportunity_id").references((): AnyPgColumn => opportunities.id, { onDelete: "set null" }),
  created_at:           timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_deals_opportunity").on(table.opportunity_id),
  check("deals_type_check",   sql`${table.deal_type} IN ('social_post','appearance','ambassador','autograph','licensing','other')`),
  check("deals_status_check", sql`${table.status} IN ('detected','pending','negotiating','accepted','completed','rejected')`),
  check("deals_source_check", sql`${table.source} IN ('inbox_scan','self_reported','contract_upload','api','public_profile','outbound_agent')`),
  check("deals_direction_check", sql`${table.direction} IS NULL OR ${table.direction} IN ('inbound','outbound')`),
  check("deals_signed_check", sql`(${table.signed_at} IS NULL AND ${table.signed_source} IS NULL) OR (${table.signed_at} IS NOT NULL AND ${table.signed_source} IS NOT NULL AND ${table.signed_source} IN ('confirmed','contract'))`),
  check("deals_payment_status_check", sql`${table.payment_status} IN ('none','payment_requested','funded','delivered_pending_confirmation','settled','refunded','disputed')`),
  // 'credited' (0103): a Serious-offer hold captured when she agreed the deal, counted toward the brand's first payment.
  check("deals_deposit_status_check", sql`${table.deposit_status} IN ('none','held','released','expired','credited')`),
]);

// ─── 4a. opportunities ───────────────────────────────────────────────────────

/**
 * One opportunity per brand (Opportunities PR 2, migrations/0084). A thin row ABOVE deals: every
 * email about one advertiser — the pitch, the signature requests, the payment mail — sits under
 * one opportunity. Everything a deal already holds (money, contract, status) stays on the deal;
 * the stage is derived from the most advanced member deal. Written by server/skills/opportunities.ts.
 *
 * One OPEN row per (athlete, brand) is enforced in code under pg_advisory_xact_lock(athlete, brand),
 * not by a unique index: a clearly separate engagement with the same brand is allowed a second row.
 */
export const OPPORTUNITY_CLOSE_REASONS = ["won", "declined", "expired", "not_relevant"] as const;

export const opportunities = pgTable("opportunities", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // The advertiser. For an agency that has not named its advertiser it is the agency's own row
  // (inbox_brands.is_agency) — one open opportunity per agency. NULL = no brand resolved at all.
  brand_id:         integer("brand_id").references(() => inboxBrands.id, { onDelete: "set null" }),
  status:           text("status").notNull().default("open"),
  // Honest history: "filed: no activity" (expired) is not "you declined".
  close_reason:     text("close_reason"),
  closed_at:        timestamp("closed_at", { withTimezone: true }),
  opened_at:        timestamp("opened_at", { withTimezone: true }).notNull(),
  // The SENT time of the newest member message (inbox_messages.received_at), not ingest time
  // (inbox_threads.last_message_at is ingest time). Drives the dormancy sweep.
  last_activity_at: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  // The thread Mila replies on and whose summary leads the card. The first email stays the lead.
  lead_thread_id:   uuid("lead_thread_id").references((): AnyPgColumn => inboxThreads.id, { onDelete: "set null" }),
  // Set once by the sweep when a VALUABLE opportunity passes the dormancy window instead of being
  // closed ("going quiet", shown by PR 4); cleared by any new activity, so it marks each quiet spell once.
  going_quiet_at:   timestamp("going_quiet_at", { withTimezone: true }),
}, (table) => [
  check("opportunities_status_check", sql`${table.status} IN ('open','closed')`),
  check("opportunities_close_reason_check", sql`${table.close_reason} IS NULL OR ${table.close_reason} IN ('won','declined','expired','not_relevant')`),
  // closed_at and close_reason are NULL exactly when the row is open.
  check("opportunities_closed_check", sql`(${table.status} = 'open' AND ${table.closed_at} IS NULL AND ${table.close_reason} IS NULL) OR (${table.status} = 'closed' AND ${table.closed_at} IS NOT NULL AND ${table.close_reason} IS NOT NULL)`),
  // The attach lookup ("an open opportunity for this brand?"). Deliberately NOT unique — see above.
  index("opportunities_open_brand_idx").on(table.athlete_id, table.brand_id).where(sql`status = 'open'`),
  // The daily dormancy sweep.
  index("opportunities_sweep_idx").on(table.status, table.last_activity_at),
]);

export type Opportunity = typeof opportunities.$inferSelect;


// ─── 4b. deal_periods / deal_installments ────────────────────────────────────

/**
 * One PERIOD of a deal: the contract's own unit of value, usually a Contract Year.
 *
 * A deal used to be one number. A real endorsement is a schedule — adidas pays $20,000,
 * $20,000, $15,000 and $10,000 across four NIL years, then a separate retainer for the
 * professional years — and no single figure answers "how much is this deal worth" without
 * being wrong for most of the questions asked of it. So the schedule is stored, and every
 * metric (total, current year, average, remaining) is DERIVED from it. Nothing derived is
 * stored: that is the discipline offerMoney already applies to the single-figure case,
 * after a denormalized copy went stale and was spoken aloud as \$200 on a \$950 deal.
 *
 * Money is INTEGER CENTS, matching payments. deals.amount is legacy NUMERIC DOLLARS and
 * money.ts already owns that boundary; a third representation would be strictly worse.
 */
export const dealPeriods = pgTable("deal_periods", {
  id:         uuid("id").primaryKey().defaultRandom(),
  deal_id:    uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  /** 1-based ordinal within the contract. The identity of a period — never its array index. */
  seq:        integer("seq").notNull(),
  /** The contract's OWN label ("NIL Contract Year 2"), not a name we invented for it. */
  label:      text("label"),
  starts_on:  date("starts_on"),
  ends_on:    date("ends_on"),
  cash_cents: bigint("cash_cents", { mode: "number" }),
  /** Product/merchandise credit that IS compensation — she receives and keeps it. */
  product_cents: bigint("product_cents", { mode: "number" }),
  /**
   * Value she DIRECTS but never receives — adidas grants \$15,000/yr of product for
   * charitable use. It is real and worth showing, and counting it as compensation would
   * inflate the agreement by \$60,000 across the term, flow into her commercial capital,
   * and via escrow into what a brand is invoiced. A column rather than a second period row,
   * because two rows for one contract year would stop seq meaning the contract year and
   * would double-count that year in any per-year average.
   */
  product_directed_cents: bigint("product_directed_cents", { mode: "number" }),
  currency:   text("currency").notNull().default("usd"),
  /**
   * FALSE means the money is conditional — a professional-year retainer that only applies
   * if she turns professional, or a year marked "*if applicable*". Never summed into a
   * guaranteed total.
   */
  guaranteed: boolean("guaranteed").notNull().default(true),
  /** The contract's own words for the condition. Required in spirit whenever guaranteed is false. */
  condition:  text("condition"),
  /** Verbatim clause this period was read from — the audit trail, and a hallucination check. */
  source_quote: text("source_quote"),
  note:       text("note"),
  /**
   * Amendments INSERT new rows and stamp the old ones, never UPDATE in place.
   *
   * Rewriting a period destroys what year 3 was worth when a score snapshot was taken, and
   * this codebase already carries the mirror of that bug — offer tracking frozen on the
   * first proposal. Readers filter on NULL.
   */
  superseded_at: timestamp("superseded_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  // Partial: a superseded row keeps its seq, so uniqueness applies only to live rows.
  uniqueIndex("deal_periods_deal_seq_uniq").on(table.deal_id, table.seq).where(sql`superseded_at IS NULL`),
  index("idx_deal_periods_deal").on(table.deal_id),
]);

/**
 * When money actually MOVES within a period.
 *
 * Separate from the period because they are different facts: a product credit is value with
 * no payment event at all, so installments alone cannot hold it; and payment timing can be
 * amended without the value changing. adidas pays each annual amount in two installments,
 * and so does gorjana — this is the normal shape, not an edge case.
 */
export const dealInstallments = pgTable("deal_installments", {
  id:         uuid("id").primaryKey().defaultRandom(),
  period_id:  uuid("period_id").notNull().references(() => dealPeriods.id, { onDelete: "cascade" }),
  seq:        integer("seq").notNull(),
  amount_cents: bigint("amount_cents", { mode: "number" }),
  due_on:     date("due_on"),
  /** 'scheduled' — a normal installment; 'bonus' — an incentive; 'reimbursement' — never income. */
  kind:       text("kind").notNull().default("scheduled"),
  /** True when WE split an amount ("two equal installments"), not when the contract stated each. */
  derived:    boolean("derived").notNull().default(false),
  note:       text("note"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("deal_installments_period_seq_uniq").on(table.period_id, table.seq),
  check("deal_installments_kind_check", sql`${table.kind} IN ('scheduled','bonus','reimbursement')`),
]);

// ─── 4c. deal_deliverables ───────────────────────────────────────────────────
//
/**
 * What she OWES a brand. The third leg beside the two above, and a different fact from both:
 *
 *   deal_periods       what the deal is WORTH        (a unit of value)
 *   deal_installments  money MOVING                  (a payment event)
 *   deal_deliverables  what she has to MAKE          (an obligation)  ← this
 *
 * Nothing held this before. `deals` has no deliverable column, and `generation_jobs.deliverable`
 * is a FORMAT string describing one render ("post", "reel") — not a commitment, with no quantity,
 * no due date and no deal behind it. So "what do I owe gorjana" had no answer, which is why the
 * Now feed's OWED rows, the calendar's DUE entries and the Made shelf's "Ad 2 of 3" were all stuck
 * behind the same gap.
 *
 * `deals.term_end` already states the distinction this table depends on: the contract TERM is when
 * the engagement runs, not when a deliverable is due. A contract with six posts has six of these
 * and one expiry.
 *
 * ─── FORMAT AND KIND ARE BOTH HERE, AND THAT IS NOT REDUNDANT ────────────────
 * `format` is the contract's OWN words and is what the athlete is shown — "Reel · 9:16", "1x static
 * IG post". `kind` is OUR normalized vocabulary, matching generation_jobs.deliverable, and exists
 * so a future auto-match has something stable to join on. Rendering the normalized value instead
 * would put words in the brand's mouth; matching on the free text would not work at all.
 *
 * ─── QUANTITY, NOT N ROWS ────────────────────────────────────────────────────
 * "Three posts" is ONE obligation with a count. Three rows would stop `seq` meaning the commitment
 * and would leave "2 of 3" with nothing to count against.
 *
 * ─── AMENDMENTS INSERT AND STAMP ─────────────────────────────────────────────
 * `superseded_at`, and the partial unique index that goes with it, are 0030's pattern held to here
 * for the same reason. A brand amending "3 posts" to "5" must not rewrite the row: she was measured
 * against 3, and a score snapshot or a delivered count taken while that was true has to stay
 * explicable. Readers filter `superseded_at IS NULL`; a superseded row keeps its seq.
 *
 * ─── NOT ENFORCED ────────────────────────────────────────────────────────────
 * No CHECK that the deliverables reconcile against anything on the deal. The writer will be a model
 * reading a contract PDF, and a misread must not become a write failure that loses the whole
 * upload — the same posture 0030 takes on installments summing to their period.
 */
export const dealDeliverables = pgTable("deal_deliverables", {
  id:         uuid("id").primaryKey().defaultRandom(),
  deal_id:    uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  /** 1-based ordinal within the contract. The identity of an obligation — never its array index. */
  seq:        integer("seq").notNull(),
  /** The contract's name for what this belongs to ("Fall Campaign"). Null falls back to the brand. */
  campaign:   text("campaign"),
  /** The contract's OWN words, rendered verbatim. Never our vocabulary — see the header. */
  format:     text("format").notNull(),
  /** OURS, for matching. Mirrors generation_jobs.deliverable plus the non-content obligations. */
  kind:       text("kind").notNull().default("other"),
  /** How many of `format` are owed. "2 of 3" counts against this. */
  quantity:   integer("quantity").notNull().default(1),
  /**
   * The POST-BY date. A calendar day, not an instant — same reasoning as deals.term_start/term_end,
   * and the same trap: midnight-UTC renders as the previous day for an athlete on the US west coast.
   *
   * Drizzle's `date()` with no mode is PgDateString, so this arrives as "YYYY-MM-DD". It must be
   * passed through as that string. Putting it through `new Date()` anywhere on the way to a screen
   * re-introduces exactly the off-by-one this column's type is chosen to avoid — see localDay() in
   * client/screens/studio/nowLogic.ts, which is where that was actually being got wrong.
   */
  due_on:     date("due_on"),
  /** Nice-to-have work. Never gets a countdown — a deadline nobody is waiting on is manufactured. */
  optional:   boolean("optional").notNull().default(false),
  status:     text("status").notNull().default("open"),
  /** The contract line this row was read from. Provenance for a model-extracted obligation. */
  source_quote: text("source_quote"),
  note:       text("note"),
  /** Amendments insert new rows and stamp the old. Readers filter on NULL. */
  superseded_at: timestamp("superseded_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("deal_deliverables_deal_seq_uniq").on(table.deal_id, table.seq).where(sql`superseded_at IS NULL`),
  // ONE composite rather than two: deal_id is the leftmost prefix so it serves the lookup, and
  // due_on serves the ordering the Now feed and the calendar both ask for.
  index("idx_deal_deliverables_deal_due").on(table.deal_id, table.due_on).where(sql`superseded_at IS NULL`),
  check("deal_deliverables_kind_check", sql`${table.kind} IN ('post','story','reel','carousel','ad','clip','appearance','other')`),
  check("deal_deliverables_status_check", sql`${table.status} IN ('open','fulfilled','waived','cancelled')`),
  check("deal_deliverables_qty_check", sql`${table.quantity} > 0`),
]);

// ─── 5. scoring_weights — DROPPED by 0127 (legacy retirement): the retired v7.2 engine's weights. ───

// ─── 5b. model_params — the versioned parameter store (Phase A, migration 0043) ───
// One table for every engine family the Commercial Intelligence spec versions: marketability
// weights, signal lookups, priors, cohorts, research freshness, commercial-proof policy, rate
// benchmarks, opportunity and earnings mixes. Generalises the (dropped, 0127) scoring_weights' one-active-row
// pattern.
//
// `version` is the PARAMETER SET ('v1.0-beta.1'); `schema_version` is the CONFIG SHAPE
// ('marketability-config/1'). They change independently and are never conflated.
// `family` has no CHECK on purpose — the closed list is ParamFamily in
// server/services/intelligence/types.ts (same reasoning as LOCKED_PROMPTS, see 0033).
// Rows are never edited in place; draft rows are never returned by the active lookup.

export const modelParams = pgTable("model_params", {
  id:             uuid("id").primaryKey().defaultRandom(),
  family:         text("family").notNull(),
  version:        text("version").notNull(),
  schema_version: text("schema_version").notNull(),
  status:         text("status").notNull().default("draft"),
  config:         jsonb("config").notNull(),
  hash:           text("hash").notNull(),
  note:           text("note"),
  created_by:     text("created_by"),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activated_at:   timestamp("activated_at", { withTimezone: true }),
}, (table) => [
  check("model_params_status_check", sql`${table.status} IN ('draft','active','inactive','archived')`),
  uniqueIndex("model_params_family_version_uq").on(table.family, table.version),
  // One live version per family, enforced by the database.
  uniqueIndex("model_params_one_active_uq").on(table.family).where(sql`status = 'active'`),
  index("model_params_family_created_idx").on(table.family, table.created_at),
]);

export type ModelParamsRow    = typeof modelParams.$inferSelect;
export type NewModelParamsRow = typeof modelParams.$inferInsert;

// ─── 5c. content_playbooks — the shared content playbook (design "Moments → post kits" §5, migration 0125) ───
// Lasting best-practice guidance for authentic growth (formats, hooks, ideal length, default cadence, cross-platform
// reuse) — NEVER a dated item. One row per (sport, stage, platform) key that actually exists in the roster, refreshed
// monthly by server/agent/playbook, behind AGENT_PLAYBOOK. Copies model_params' one-active-row pattern (above) with a
// composite key instead of a single `family`.
//
// `sport` and `platform` carry no CHECK on purpose (same reasoning as model_params.family, see 0043): `sport` is free
// text as the athlete gave it, and the platform list grows with the connectors in server/lib/integrations/registry.ts
// without a migration. `stage` DOES carry a CHECK — it is the Brief's own small, closed band vocabulary
// (shared/plan.ts PLAN_STAGE_BANDS) minus "unclear" (shared/playbook.ts PLAYBOOK_STAGES): an athlete whose stage is
// not yet known is in no playbook key.

export const contentPlaybooks = pgTable("content_playbooks", {
  id:           uuid("id").primaryKey().defaultRandom(),
  sport:        text("sport").notNull(),
  stage:        text("stage").notNull(),
  platform:     text("platform").notNull(),
  version:      text("version").notNull(),
  status:       text("status").notNull().default("draft"),
  config:       jsonb("config").notNull(),   // PlaybookConfig (shared/playbook.ts): formats, hooks, idealLengthSec,
                                              // cadence.postsPerWeek, crossPlatformReuse, sources, refreshedAt
  hash:         text("hash").notNull(),
  note:         text("note"),
  created_by:   text("created_by"),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activated_at: timestamp("activated_at", { withTimezone: true }),
}, (table) => [
  check("content_playbooks_status_check", sql`${table.status} IN ('draft','active','archived')`),
  check("content_playbooks_stage_check", sql`${table.stage} IN ('early','developing','established','elite','retired')`),
  uniqueIndex("content_playbooks_key_version_uq").on(table.sport, table.stage, table.platform, table.version),
  // One live version per key, enforced by the database — the same device model_params.family already relies on.
  uniqueIndex("content_playbooks_one_active_uq").on(table.sport, table.stage, table.platform).where(sql`status = 'active'`),
  index("content_playbooks_key_created_idx").on(table.sport, table.stage, table.platform, table.created_at),
]);

export type ContentPlaybookRow    = typeof contentPlaybooks.$inferSelect;
export type NewContentPlaybookRow = typeof contentPlaybooks.$inferInsert;

// ─── 6. golden_athletes ──────────────────────────────────────────────────────

export const goldenAthletes = pgTable("golden_athletes", {
  id:                 serial("id").primaryKey(),
  athlete_id:         uuid("athlete_id").references(() => athletes.id),
  ground_truth_pav:   numeric("ground_truth_pav"),
  ground_truth_source: text("ground_truth_source"),   // 'on3' | 'forbes' | 'opendorse' | 'manual'
  notes:              text("notes"),
  active:             boolean("active").default(true),
}, (table) => [
  uniqueIndex("idx_golden_athletes_athlete").on(table.athlete_id),
]);

// ─── 7. inbox_brands ─────────────────────────────────────────────────────────
// v1 had ~183 brand rows with multi-domain arrays (domains[]).
// v2 flattens to ~220-250 rows: one row per domain, one domain per row.
// Seed: explode v1 domains[] arrays → INSERT one row per domain.

export const inboxBrands = pgTable("inbox_brands", {
  id:          serial("id").primaryKey(),
  // Identity is the normalized advertiser name (model A). Domain is now NULLABLE —
  // canonical when known (direct/researched), null for agency-only advertisers.
  normalized_name: text("normalized_name").unique(),
  domain:      text("domain"),
  name:        text("name").notNull(),
  logo_url:    text("logo_url"),
  // A real brand image (og:image / product-shot) captured from the homepage during research —
  // richer than the square logo for brand cards. `image_url` is the chosen cover; `images` is the
  // ranked set (best-first) used by the deal-detail brand-deck hero. Source URLs only, like
  // logo_url; GCS-rehosting the binary is the durable upgrade (see server/lib/brandImage.ts).
  image_url:   text("image_url"),
  images:      jsonb("images").$type<string[]>(),
  category:    text("category"),
  // How this brand entered the catalog. `inbox_brands` is already a general brand-identity
  // table (not inbox-scoped) — this promotes it in place so outbound/self-added brands live
  // here too, without the physical rename (docs/opportunity-pitch-content-model.md §11).
  origin:      text("origin").default("detected"),   // 'detected' | 'athlete_added' | 'directory'
  created_at:  timestamp("created_at", { withTimezone: true }).defaultNow(),
  description:                text("description"),
  brand_tier:                 text("brand_tier"),
  audience_summary:           text("audience_summary"),
  sport_categories:           text("sport_categories").array(),
  known_athlete_partnerships: text("known_athlete_partnerships").array(),
  enriched_at:                timestamp("enriched_at", { withTimezone: true }),
  enrichment:                 jsonb("enrichment"),
  // True when this row is an agency/MCN/platform (not a real advertiser) — excluded
  // from brand identity & future marketability votes. Set by brandResolver §2.
  is_agency:                  boolean("is_agency").default(false),
});

// ─── 8. inbox_threads ────────────────────────────────────────────────────────

export const inboxThreads = pgTable("inbox_threads", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id),
  brand_id:         integer("brand_id").references(() => inboxBrands.id),
  subject:          text("subject"),
  last_message_at:  timestamp("last_message_at", { withTimezone: true }),
  message_count:    integer("message_count").default(0),
  status:           text("status").default("unread"),
  deal_id:            uuid("deal_id").references(() => deals.id),
  external_thread_id: text("external_thread_id"),
  // Which connected inbox received this thread — replies must send through it
  // (a Gmail threadId only exists inside the mailbox that owns it). SET NULL on
  // delete: disconnecting an inbox keeps the thread, it just needs re-resolution.
  connected_account_id: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
  classification:    jsonb("classification"),
  summary:           text("summary"),
  conversation_state: jsonb("conversation_state"), // re-generated on every new message via threadSummarizer
  latest_draft:      jsonb("latest_draft"),
  // Cross-mailbox thread aliases: secondary Gmail (per-mailbox) thread ids that
  // resolve to THIS logical conversation. Moved out of the classification JSONB
  // (H1/H4) so a re-classification can't clobber a registered alias, and appends
  // are a single atomic array UPDATE instead of a read-modify-write.
  alias_thread_ids:  text("alias_thread_ids").array(),
  created_at:        timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("inbox_threads_status_check", sql`${table.status} IN ('unread','read','starred','archived','deal_detected')`),
  index("idx_threads_external_thread_id").on(table.external_thread_id),
  // One thread per (athlete, external thread) — closes the connect-time race where
  // backfill + webhook both insert a thread for the same email. NULL external_thread_id
  // stays distinct under Postgres semantics, so null-thread platforms are unaffected.
  uniqueIndex("uniq_threads_athlete_external").on(table.athlete_id, table.external_thread_id),
  // Backs findThreadByExternalId's alias lookup (`gmailThreadId = ANY(alias_thread_ids)`).
  index("idx_threads_alias_gin").using("gin", table.alias_thread_ids),
]);

// ─── 9. inbox_messages ───────────────────────────────────────────────────────

/**
 * One PDF attachment carried by an inbox message, rehosted into the inbox-attachments
 * bucket at ingest. `parsed` records whether its text made it into the message body —
 * a PDF can be stored but unread (over the parse size cap), and the deal card should
 * be able to say so rather than implying we read something we didn't.
 */
export interface InboxAttachment {
  filename:     string;
  content_type: string;
  bytes:        number;
  /**
   * Object path inside the inbox-attachments bucket. Never sent to the client.
   * Absent for mail ingested under MAILBOX_LIVE_READS: the file stays in the mailbox
   * and is read live through `attachment_ref`.
   */
  gcs_path?:    string;
  /** Opaque mailbox attachment ref (adapter-defined) for a file NOT rehosted. */
  attachment_ref?: string;
  parsed:       boolean;
  /**
   * Instagram DMs only (server/lib/integrations/instagramAttachments.ts): the webhook attachment type
   * (image, video, file, share, story_reply …) and the Graph media id when Meta sent one, kept for the
   * later download step. The Graph CDN url is never stored (it expires and is signed); attachment_ref stays unset.
   * Not rehosted yet (bytes 0).
   */
  ig_type?:     string;
  ig_media_id?: string;
  /**
   * True when the message has no text of its own: its body is only this attachment's placeholder ("[Photo]").
   * Readers that need what the sender WROTE (the classifier, requalify) skip such rows.
   */
  placeholder?: boolean;
}

export const inboxMessages = pgTable("inbox_messages", {
  id:                      uuid("id").primaryKey().defaultRandom(),
  thread_id:               uuid("thread_id").notNull().references(() => inboxThreads.id),
  athlete_id:              uuid("athlete_id").notNull().references(() => athletes.id),
  sender_email:            text("sender_email"),
  sender_name:             text("sender_name"),
  direction:               text("direction"),
  subject:                 text("subject"),
  body:                    text("body"),
  // SHA-256 (lowercase hex) of the trimmed message text — server/lib/inboxBodyFingerprint.ts (0086).
  // Written on every insert; the echo gate matches on it. NULL on legacy rows only.
  body_sha256:             text("body_sha256"),
  received_at:             timestamp("received_at", { withTimezone: true }),
  external_message_id:     text("external_message_id"),
  platform:                text("platform").default("gmail"),          // 'gmail' | 'instagram'
  gmail_thread_id:         text("gmail_thread_id"),                    // Gmail threadId for RFC 2822 reply threading
  gmail_message_id_header: text("gmail_message_id_header"),            // Message-ID header value for In-Reply-To
  sender_ig_user_id:       text("sender_ig_user_id"),                  // Instagram-scoped user ID for DM replies
  connected_account_id:    uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }), // inbox that received this message
  // PDF attachments rehosted to GCS at ingest — see InboxAttachment. NULL when the
  // message had none. Gmail's own attachment ids die with the access token, so the
  // file has to be ours for the deal card to link to it later.
  attachments:             jsonb("attachments").$type<InboxAttachment[]>(),
  // Relay moderation (0103), set ONLY for platform 'nomila' (Nomila-relayed partner-request messages): pending →
  // clean | held | blocked, with the reason. NULL for every mail / DM row. Held and blocked messages are never delivered.
  moderation:              text("moderation"),
  moderation_reason:       text("moderation_reason"),
  // A held / blocked relayed message keeps its text HERE and body stays NULL, so no reader of `body` (deal detail,
  // Mila, the summariser) can show text that was never delivered. Released → moved into body.
  held_body:               text("held_body"),
  created_at:              timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("inbox_messages_direction_check", sql`${table.direction} IN ('inbound','outbound')`),
  check("inbox_messages_moderation_check", sql`${table.moderation} IS NULL OR (${table.platform} = 'nomila' AND ${table.moderation} IN ('pending','clean','held','blocked'))`),
  check("inbox_messages_held_body_check", sql`${table.held_body} IS NULL OR ${table.moderation} IN ('held','blocked')`),
  unique("inbox_messages_thread_external_uniq").on(table.thread_id, table.external_message_id),
  // Backs the idempotency gate in detectDeal (was an unindexed scan on external_message_id).
  index("idx_messages_athlete_external").on(table.athlete_id, table.external_message_id),
  // The RFC 2822 Message-ID is stable across mailboxes, so one email delivered to two
  // connected inboxes must resolve to ONE row. detectDeal's echo gate reads before it
  // writes, and the Pub/Sub webhook holds no advisory lock — so two mailboxes' webhooks
  // raced and both rows landed. This makes the database the arbiter instead of that read.
  // Partial: a NULL header carries no identity, and 77 legacy rows have none.
  uniqueIndex("inbox_messages_athlete_msgid_uniq")
    .on(table.athlete_id, table.gmail_message_id_header)
    .where(sql`${table.gmail_message_id_header} IS NOT NULL`),
]);

// ─── 9b. gmail_dead_letters ──────────────────────────────────────────────────
// Messages the Gmail webhook dropped (detectDeal threw) after it advanced the
// cursor past them. The inbox cron retries these so a dropped read/older message
// isn't lost forever (previously only logged).

export const gmailDeadLetters = pgTable("gmail_dead_letters", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  connected_account_id: uuid("connected_account_id").notNull().references(() => connectedAccounts.id, { onDelete: "cascade" }),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id),
  gmail_message_id:     text("gmail_message_id").notNull(),
  error:                text("error"),
  attempts:             integer("attempts").notNull().default(0),
  created_at:           timestamp("created_at", { withTimezone: true }).defaultNow(),
  last_attempt_at:      timestamp("last_attempt_at", { withTimezone: true }),
}, (table) => [
  unique("gmail_dead_letters_conn_msg_uniq").on(table.connected_account_id, table.gmail_message_id),
]);

// ─── 10. inbox_senders ───────────────────────────────────────────────────────

export const inboxSenders = pgTable("inbox_senders", {
  id:            serial("id").primaryKey(),
  email:         text("email").notNull().unique(),
  name:          text("name"),
  brand_id:      integer("brand_id").references(() => inboxBrands.id),
  athlete_id:    uuid("athlete_id").references(() => athletes.id),
  message_count: integer("message_count").default(0),
  first_seen_at: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
});

// ─── 12. notification_log ────────────────────────────────────────────────────

export const notificationLog = pgTable("notification_log", {
  id:         uuid("id").primaryKey().defaultRandom(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id),
  type:       text("type").notNull(),
  title:      text("title"),
  body:       text("body"),
  sent:       boolean("sent").default(false),
  sent_at:    timestamp("sent_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  // 'score_milestone' left the list in 0128 (legacy retirement): nothing ever produced it.
  check("notif_type_check", sql`${table.type} IN ('new_deal','weekly_brief','brand_match','promotion')`),
  index("idx_notif_athlete_type").on(table.athlete_id, table.type, table.created_at),
]);

// ─── 12b. push notifications (0130; server/services/push) ────────────────────
// push_devices: one row per phone (the Expo push token, unique: a phone signing in as someone else moves to them).
// push_preferences: her choices, absent = the defaults (on, every kind on, quiet 22:00–08:00 in the phone's zone).
// push_sends: one row per notification decided, keyed (athlete, dedupe_key) so one event is never pushed twice. No text.

export const pushDevices = pgTable("push_devices", {
  id:           uuid("id").primaryKey().defaultRandom(),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  token:        text("token").notNull(),
  platform:     text("platform").notNull(),
  time_zone:    text("time_zone"),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("push_devices_token").on(t.token),
  index("idx_push_devices_athlete").on(t.athlete_id),
]);

export const pushPreferences = pgTable("push_preferences", {
  athlete_id:  uuid("athlete_id").primaryKey().references(() => athletes.id, { onDelete: "cascade" }),
  enabled:     boolean("enabled").notNull().default(true),
  plan_ready:  boolean("plan_ready").notNull().default(true),
  brand_reply: boolean("brand_reply").notNull().default(true),
  waiting:     boolean("waiting").notNull().default(true),
  // 0135: "Mila's suggestions" — a suggested change to her strategy from a research refresh.
  mila_suggestion: boolean("mila_suggestion").notNull().default(true),
  quiet_hours: boolean("quiet_hours").notNull().default(true),
  // Minutes after local midnight: 1320 = 22:00, 480 = 08:00 (a window may cross midnight).
  quiet_start: smallint("quiet_start").notNull().default(1320),
  quiet_end:   smallint("quiet_end").notNull().default(480),
  // Lock-screen privacy: a brand's name shows in a notification only when she turns this on.
  show_brand_names: boolean("show_brand_names").notNull().default(false),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── 12c. Mila's voice and language (0152; server/services/milaVoice) ─────────
// One row per athlete, absent = the defaults: Mila's default voice, talk in whatever language they use, no "post in"
// languages chosen. `voice` is a catalogue id (server/services/milaVoice/catalogue.ts), never a provider voice name, so
// the catalogue can re-map a voice without touching a row; the API validates it, the database does not (a catalogue
// change must never need a migration). `post_languages` is stored for captions and not read by anything yet.
export const milaVoiceSettings = pgTable("mila_voice_settings", {
  athlete_id:            uuid("athlete_id").primaryKey().references(() => athletes.id, { onDelete: "cascade" }),
  voice:                 text("voice"),
  conversation_language: text("conversation_language").notNull().default("auto"),
  post_languages:        text("post_languages").array().notNull().default(sql`'{}'::text[]`),
  updated_at:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSends = pgTable("push_sends", {
  id:         uuid("id").primaryKey().defaultRandom(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  kind:       text("kind").notNull(),
  dedupe_key: text("dedupe_key").notNull(),
  quiet:      boolean("quiet").notNull().default(false),
  devices:    integer("devices").notNull().default(0),
  error:      text("error"),
  // 1, or 2 after the one retry a failed send allows.
  attempts:   smallint("attempts").notNull().default(1),
  // Expo's ticket ids ([{ id, token }]) until the receipts cron reads them.
  tickets:    jsonb("tickets"),
  receipts_checked_at: timestamp("receipts_checked_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("push_sends_dedupe").on(t.athlete_id, t.dedupe_key),
  index("idx_push_sends_athlete").on(t.athlete_id, t.created_at),
]);

// ─── 13. chat_messages ───────────────────────────────────────────────────────

export const chatMessages = pgTable("chat_messages", {
  id:                uuid("id").primaryKey().defaultRandom(),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id),
  role:              text("role").notNull(),
  content:           text("content"),
  tool_call_id:      text("tool_call_id"),
  // Kimi thinking tokens — stored but not shown in UI
  reasoning_content: text("reasoning_content"),
  widget:            jsonb("widget"),
  app_actions:       jsonb("app_actions"),
  // Groups a continuing Ask Mila conversation (Phase 1 memory). NULLABLE: existing
  // rows and the v1/flag-off chat path leave it NULL. See migrations/0014.
  conversation_id:   uuid("conversation_id"),
  // Which channel produced this turn: 'voice' for a transcribed spoken turn, NULL
  // for the text path and for every row written before voice existed. Voice and
  // text share one conversation_id, so the athlete reads ONE transcript.
  //
  // Deliberately NO check constraint (see migrations/0018): a CHECK would need a
  // DROP + ADD pair to admit a third channel, and that pair is what raced itself
  // and broke the deploy twice. The writer enforces the vocabulary instead.
  //
  // `role` is unchanged — a voice turn is still 'user' or 'assistant' — so
  // chat_role_check above needs no edit.
  source:            text("source"),
  // AGENT_V3 chat (0123): the cards an assistant turn showed (shared/agent.ts ChatCard[], built by code from what its
  // tools did) and the agent run that produced it. The next turn reads them so Mila knows what was shown. NULL on every
  // other row. agent_run_id is a plain uuid (no FK), like conversation_id: deleting runs never blocks on chat rows.
  agent_cards:       jsonb("agent_cards"),
  agent_run_id:      uuid("agent_run_id"),
  // Mila started this message (0143, MILA_PROACTIVE): an app event, not a reply to the athlete. seen_at: when
  // the athlete saw it (NULL = unread; the Mila tab's dot counts these).
  mila_started:      boolean("mila_started").notNull().default(false),
  seen_at:           timestamp("seen_at", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("chat_role_check", sql`${table.role} IN ('user','assistant','tool','system')`),
  index("idx_chat_athlete").on(table.athlete_id, table.created_at),
  // Backs loadHistory's per-conversation load.
  index("idx_chat_conversation").on(table.athlete_id, table.conversation_id, table.created_at),
  // Backs the unread count: Mila-started messages the athlete has not seen.
  index("idx_chat_mila_unread").on(table.athlete_id).where(sql`${table.mila_started} AND ${table.seen_at} IS NULL`),
  // 0150: today's voice minutes, every athlete (server/voice/voiceMinutes.ts → the platform-wide day total).
  index("idx_chat_voice_created").on(table.created_at).where(sql`source = 'voice'`),
]);

// ─── 13b. conversations (Phase 2 memory: rolling summary + saved chats) ────────
// One row per continuing Ask Mila conversation. `id` IS the client-minted
// conversation uuid (== chat_messages.conversation_id) — the row is upserted on
// the conversation's first persisted message, so the two always share a key.
//
// TYPING ONLY: this table has NO drizzle migration. The CREATE TABLE ships via the
// deploy.yml DDL block separately (Mia merges) — same split as chat_messages'
// conversation_id column. Do not `db:push` this or generate a migration for it.
//
// Powers BOTH consumers through server/mila/conversations.ts:
//   • the rolling per-conversation summary (summary + summary_through_message_id)
//   • the saved-chats list (title + updated_at recency)
// `summary_through_message_id` is the newest chat_messages row already folded into
// `summary`; load replays the summary (as delimited system-prompt DATA) plus the
// un-summarized tail after it. Kept a bare uuid (no FK) to match the approved DDL.
export const conversations = pgTable("conversations", {
  id:                         uuid("id").primaryKey().defaultRandom(),
  athlete_id:                 uuid("athlete_id").notNull().references(() => athletes.id),
  // First user message, one-lined + truncated. Saved-chats list label.
  title:                      text("title"),
  // Rolling summary of the folded (older) turns. NULL until the first fold.
  summary:                    text("summary"),
  // Watermark: newest chat_messages.id folded into `summary`. NULL until the first fold.
  summary_through_message_id: uuid("summary_through_message_id"),
  created_at:                 timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at:                 timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  // Backs listConversations (this athlete's chats, most-recent first).
  index("idx_conversations_athlete_updated").on(table.athlete_id, table.updated_at),
]);

// ─── 13c. voice_context (Phase 3 memory: structured voice state) ─────────────
// One row per conversation, holding what a voice session DISCUSSED and DECIDED —
// so a later session can be seeded without replaying transcript prose.
//
// TYPING ONLY: like `conversations` above, this table has no drizzle migration
// that actually runs. migrations/0018 documents it; the CREATE TABLE ships via the
// deploy.yml DDL block (Mia merges). Do not `db:push` this.
//
// ── Why it is structured, and why that is a security boundary ────────────────
// chat_messages holds brand- and email-derived text (draft bodies, quoted threads,
// get_brand's <external_content>). Anything seeded into a voice session is spoken
// aloud by a TTS layer, where prompt delimiters mean nothing — the same reasoning
// that keeps free text off server/voice/dealRoutes.ts and brandBriefRoute.ts. So a
// voice seed is REBUILT FROM STRUCTURE, never quoted from history, and this table
// is that structure.
//
// ── The jsonb trade-off, stated where the writer can see it ──────────────────
// The three jsonb columns are read whole, bounded by one conversation, and never
// queried into, so child tables would cost three objects and buy nothing. The cost
// is that jsonb is UNTYPED: the schema cannot enforce what lands in them. They
// must contain ONLY ids, closed-vocabulary enums and timestamps — never prose,
// never a brand string, never a model-written sentence. That invariant lives in
// server/voice/** and its tests, because nothing here can hold it.
export const voiceContext = pgTable("voice_context", {
  // The conversation this voice state belongs to == chat_messages.conversation_id
  // == conversations.id. Bare uuid (no FK) to match the approved DDL, same as
  // conversations.summary_through_message_id.
  conversation_id:  uuid("conversation_id").primaryKey(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id),
  // [{ dealId, brandId, recommendationGiven, spokenAt }] — ids + enums only.
  deals_discussed:  jsonb("deals_discussed").notNull().default([]),
  // [{ brandId, hadDeal, spokenAt }] — ids + booleans only.
  brands_discussed: jsonb("brands_discussed").notNull().default([]),
  // [{ topic, dealId }] — topic is a closed vocabulary, never free text.
  open_threads:     jsonb("open_threads").notNull().default([]),
  // [{ dealId, brandName, replyIntent, channel, at }] — ids, enums and ONE name.
  // `brandName` is deals.brand_name for a deal this athlete owns, which already
  // crosses the voice wire in list_deals; it is stored rather than resolved at
  // read time because the seed runs on the session-start path. See migrations/0023.
  drafts_opened:    jsonb("drafts_opened").notNull().default([]),
  last_voice_at:    timestamp("last_voice_at", { withTimezone: true }),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  // "Has this athlete spoken recently, and about what" without a conversation id.
  index("idx_voice_context_athlete").on(table.athlete_id, table.last_voice_at),
]);

// ─── 13d. brand_fit_narratives (precomputed voice brand-fit copy) ────────────
// One row per (athlete, brand): the three angles narrateWhyFits produced. Read on
// the voice brand path so an answer costs no model call; written by the
// fire-and-forget fill after a cold ask.
//
// TYPING ONLY: like `conversations` and `voice_context`, this table has no
// drizzle migration that runs. migrations/0019 documents it; the CREATE TABLE
// ships via the deploy.yml DDL block. Do not `db:push` this.
//
// The composite key IS the identity — a narrative is written FROM one athlete's
// sport and audience FOR one brand — so it is the primary key rather than a
// surrogate, and no secondary index exists because every access is by both halves.
// The three angles are NOT NULL: all three or none, enforced by the schema rather
// than only by server/voice/brandFitStore.ts.
export const brandFitNarratives = pgTable("brand_fit_narratives", {
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  brand_id:    integer("brand_id").notNull().references(() => inboxBrands.id, { onDelete: "cascade" }),
  audience:    text("audience").notNull(),
  credibility: text("credibility").notNull(),
  whitespace:  text("whitespace").notNull(),
  created_at:  timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.brand_id] }),
]);

// ─── 13e. athlete_rate_ranges (0132): Mila's suggested range per athlete × rate type ──────────
// The "Suggested $350–550" on Your rates, the Money line's "inside your suggested range" and Mila's counter
// suggestions all read this ONE table (deals design §5c / §8, D9 approved 12 Oct 2026). For launch the ranges are the
// ones onboarding already produces and validates (agent/onboarding/turn.ts rate_ranges), saved when shown; the
// rate-eval 2.0 model is NOT used. One row per (athlete, rate type from shared/deals.ts RATE_TYPES): the latest shown
// range wins. Shown to HER only, never to a brand. Her own minimums stay in athletes.deal_preferences.minimum_rates.
export const athleteRateRanges = pgTable("athlete_rate_ranges", {
  athlete_id:    uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  rate_type:     text("rate_type").notNull(),                       // shared/deals.ts RATE_TYPES (checked in code)
  low:           integer("low").notNull(),                          // whole currency units
  high:          integer("high").notNull(),
  currency:      text("currency").notNull().default("USD"),
  confidence:    text("confidence").notNull(),                      // low | medium | high
  drivers:       jsonb("drivers").notNull().default(sql`'[]'::jsonb`), // string[]: what the range rests on
  label:         text("label").notNull(),                           // the deliverable as onboarding named it
  source:        text("source").notNull().default("onboarding"),    // brief (understand 1.13.0) | onboarding | onboarding_backfill
  source_run_id: uuid("source_run_id"),                             // the agent run that produced it (no FK: runs may be pruned)
  shown_at:      timestamp("shown_at", { withTimezone: true }).notNull().defaultNow(),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.rate_type] }),
  check("athlete_rate_ranges_confidence_check", sql`${table.confidence} IN ('low','medium','high')`),
  check("athlete_rate_ranges_range_check", sql`${table.low} >= 0 AND ${table.high} >= ${table.low}`),
]);

// ─── 13f. deal_reads (0133): the model half of a deal's four-line read ─────────────────────────────────────────
// The deal read (deals design §5 "The read") is four lines: Money and Risk are worked out in code on every read;
// Fit ("why this brand fits you", confirmed research only) and Goal ("helps your goal: …") come from ONE small OpenAI
// call (skill deal-read) and are stored here once per athlete + deal (the deal carries its brand). `inputs_key` is a
// digest of what the call read — the brand's research and identity verdict, her goals, the deal's ask — so a change to
// any of them makes the row stale on the next read (it is then not served, and is refilled). Behind DEALS_READ_MODEL.
export const dealReads = pgTable("deal_reads", {
  athlete_id:    uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  deal_id:       uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  brand_id:      integer("brand_id").references(() => inboxBrands.id, { onDelete: "set null" }),
  fit_line:      text("fit_line"),                                  // null: brand unconfirmed, or nothing grounded to say
  goal_id:       uuid("goal_id"),                                   // memory_goals.id the deal serves; null = none
  goal_line:     text("goal_line"),                                 // null: she has no goals yet
  inputs_key:    text("inputs_key").notNull(),
  skill_version: text("skill_version"),                             // null when no call was needed (nothing to ask)
  run_id:        uuid("run_id"),                                    // the agent run (no FK: runs may be pruned)
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.deal_id] }),
  index("idx_deal_reads_brand").on(table.brand_id),
]);

// ─── 16. connected_accounts ──────────────────────────────────────────────────
// One row per (athlete, provider account), for the account's whole life
// (docs/plans/connection-identity-fix.md §3, migration 0071). An athlete may hold
// several rows per platform (two Gmail mailboxes), but never two for the SAME
// provider account: connected_accounts_account_uq enforces it on platform_user_id
// (Google sub, Microsoft id, Instagram user id, TikTok open_id, YouTube channel id,
// Spotify id). Reconnecting updates that row in place (activateConnection);
// disconnecting revokes and empties it but keeps it, so every thread, message,
// snapshot and sync run keeps pointing at the same id. Tokens stored directly.

export const connectedAccounts = pgTable("connected_accounts", {
  id:                      uuid("id").primaryKey().defaultRandom(),
  athlete_id:              uuid("athlete_id").notNull().references(() => athletes.id),
  platform:                text("platform").notNull(),
  alias:                   text("alias"),
  status:                  text("status").default("pending"),
  // Direct OAuth token storage
  access_token:            text("access_token"),
  refresh_token:           text("refresh_token"),
  token_expires_at:        timestamp("token_expires_at", { withTimezone: true }),
  platform_user_id:        text("platform_user_id"),
  platform_username:       text("platform_username"),
  /** Phase A Step 3a: the user who performed the OAuth (self today; a representative later). NULL on rows older than 0051 until backfilled. */
  connected_by_user_id:    uuid("connected_by_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  ig_page_id:              text("ig_page_id"),         // LEGACY (Facebook-Login era): Page ID backing the IG account. Unused under Instagram Login — always null on new connections. Kept nullable to avoid a migration; drop in a future cleanup.
  scopes:                  text("scopes"),
  gmail_history_id:        text("gmail_history_id"),  // Gmail push: last processed historyId
  sync_cursor:             text("sync_cursor"),        // Instagram DM pagination cursor
  last_fetched_at:         timestamp("last_fetched_at", { withTimezone: true }),
  created_at:              timestamp("created_at", { withTimezone: true }).defaultNow(),
  /** The latest successful connect (0071). The connect generation: workflow idempotency keys carry it, so a real reconnect re-runs first_look/social_sync. NULL while pending. */
  connected_at:            timestamp("connected_at", { withTimezone: true }),
}, (table) => [
  check("connected_accounts_status_check", sql`${table.status} IN ('pending','active','expired','revoked')`),
  index("idx_connected_athlete_platform").on(table.athlete_id, table.platform),
  // THE INVARIANT (0071): one row per provider account per athlete. Partial: a pending row has no id yet.
  uniqueIndex("connected_accounts_account_uq")
    .on(table.athlete_id, table.platform, table.platform_user_id)
    .where(sql`platform_user_id IS NOT NULL`),
]);

// ─── 16a. connection_merge_log (0071) ────────────────────────────────────────
// Every connection row 0071 folded into a survivor, deleted as stale pending, or
// filled with a platform_user_id — with the old row (minus its tokens) and how
// many rows of each referencing table moved, so any merge can be reversed by hand.
// No foreign keys on purpose: old_id names a row that no longer exists.

export const connectionMergeLog = pgTable("connection_merge_log", {
  id:          uuid("id").primaryKey().defaultRandom(),
  old_id:      uuid("old_id").notNull(),
  survivor_id: uuid("survivor_id"),
  athlete_id:  uuid("athlete_id").notNull(),
  platform:    text("platform").notNull(),
  reason:      text("reason").notNull(),
  repointed:   jsonb("repointed"),
  old_row:     jsonb("old_row"),
  merged_at:   timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("connection_merge_log_reason_check", sql`${table.reason} IN ('duplicate_account','stale_pending','filled_platform_user_id')`),
  index("idx_connection_merge_log_old").on(table.old_id),
  index("idx_connection_merge_log_survivor").on(table.survivor_id),
]);

// ─── 16b. outlook_subscriptions (0085) ───────────────────────────────────────
// One Microsoft Graph change-notification subscription per Outlook connection (OUTLOOK_PUSH).
// A notification is only a "sync now" signal: the webhook stamps sync_requested_at and a
// debounced worker runs the existing delta sync (connected_accounts.sync_cursor stays the cursor).
// See server/lib/integrations/outlookPush.ts.

export const outlookSubscriptions = pgTable("outlook_subscriptions", {
  id:                    uuid("id").primaryKey().defaultRandom(),
  // The connection whose delta sync a notification triggers. Cascade: a deleted connection takes its subscription row.
  connected_account_id:  uuid("connected_account_id").notNull().references(() => connectedAccounts.id, { onDelete: "cascade" }),
  // Graph's id: how an incoming notification finds its row, and the target of PATCH (renew) / DELETE.
  graph_subscription_id: text("graph_subscription_id").notNull(),
  // What was subscribed. Renewal recreates instead of patching when it differs from the current resource.
  resource:              text("resource").notNull(),
  // Graph's expirationDateTime. The renewal cron picks rows expiring within 48 h.
  expires_at:            timestamp("expires_at", { withTimezone: true }).notNull(),
  // sha256 of the clientState sent at creation — never the raw value. Verifying against the hash keeps
  // existing subscriptions valid across an OUTLOOK_WEBHOOK_SECRET rotation (the secret is used only to mint).
  client_state_hash:     text("client_state_hash").notNull(),
  // active | reauthorize_required | removed — the last two are durable lifecycle work the cron retries.
  status:                text("status").notNull().default("active"),
  // Last verified notification (operational: "is push actually arriving?").
  last_notification_at:  timestamp("last_notification_at", { withTimezone: true }),
  // THE QUEUE: set by a notification (first one in a burst wins), cleared when a worker claims the sync.
  sync_requested_at:     timestamp("sync_requested_at", { withTimezone: true }),
  // Lease: a worker on any instance owns the sync while this is recent, so two instances never replay one deltaLink at once.
  sync_started_at:       timestamp("sync_started_at", { withTimezone: true }),
  created_at:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("outlook_subscriptions_status_check", sql`${table.status} IN ('active','reauthorize_required','removed')`),
  uniqueIndex("outlook_subscriptions_connection_uq").on(table.connected_account_id),
  uniqueIndex("outlook_subscriptions_graph_id_uq").on(table.graph_subscription_id),
  index("outlook_subscriptions_expires_idx").on(table.expires_at),
]);

export type OutlookSubscription = typeof outlookSubscriptions.$inferSelect;

// ─── 17. account_roles ───────────────────────────────────────────────────────
// Lightweight join: one row per (account, role). athletes.id IS the account_id
// for v2 — no identity table rename until Stage 2. FK direction: role → athlete.
// Backfilled with 'athlete' for all existing rows at Stage 0.

export const accountRoles = pgTable("account_roles", {
  account_id: uuid("account_id").notNull().references(() => athletes.id),
  role:       text("role").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.account_id, table.role] }),
  check("account_roles_role_check", sql`${table.role} IN ('athlete','fan','brand','school_admin','admin')`),
]);

// NOTE: The standalone `waitlist` table was removed in favour of one-table,
// auth-first signup — landing-page signups now create an `athletes` row with
// status='waitlisted' (auth_id set from Firebase). See migration 0004.

// ─── 18. social_analytics_snapshots ──────────────────────────────────────────
// Time-series of Graph/TikTok account analytics (reach, profile views, per-post
// insights, audience demographics) for a CONNECTED account. Separate from
// athlete_snapshots on purpose: this is a display/trend layer and is NEVER read
// by scoringService — a failed insights pull can degrade to null without ever
// touching the Capital Score. One row per connected account per UTC day.

// Shape of social_analytics_snapshots.raw_metrics (full-fidelity escape hatch).
// recent_media[] is captured media-kit-ready: `permalink` is the durable handle,
// media_url/thumbnail_url are ephemeral IG CDN links (display now, re-download to
// GCS when the media kit is built). See §"out of scope".
export type SocialAnalyticsRaw = {
  account?:          Record<string, unknown>;   // raw profile payload
  account_insights?: Record<string, unknown>;   // raw /insights payload (audit trail)
  demographics?: {
    country?: Array<{ key: string; value: number; pct: number }>;
    city?:    Array<{ key: string; value: number; pct: number }>;
    age?:     Array<{ key: string; value: number; pct: number }>;
    gender?:  Array<{ key: string; value: number; pct: number }>;
  };
  recent_media?: Array<{
    id:             string;
    permalink:      string;            // STABLE — durable across CDN URL expiry
    media_type:     string;            // IMAGE | VIDEO | REELS | CAROUSEL_ALBUM
    caption:        string | null;
    timestamp:      string;
    media_url:      string | null;     // ephemeral CDN link
    thumbnail_url:  string | null;     // ephemeral CDN link
    like_count:     number | null;
    comments_count: number | null;
    is_shared_to_feed?: boolean | null; // raw Graph flag: false = Reel not cross-posted to the grid (the default)
    is_discovery?:      boolean | null; // CONFIRMED Trial/Discovery reel: not on grid AND reach ≥ 2× followers
    insights: {                        // per-post (best-effort, may be null)
      reach?:              number;
      saved?:              number;
      shares?:             number;
      video_views?:        number;
      total_interactions?: number;
    } | null;
    children?: Array<{                 // CAROUSEL_ALBUM items (ephemeral CDN links)
      id:            string;
      media_type:    string;           // IMAGE | VIDEO
      media_url:     string | null;
      thumbnail_url: string | null;
    }>;
  }>;
  // Reels distributed to NON-followers (Trial Reels / discovery) — segmented out of core reach so
  // their spiky non-follower reach doesn't inflate avg_reach_per_post. Detected as: not on grid
  // (is_shared_to_feed=false) AND reach ≥ 2× followers (arithmetically majority non-follower).
  discovery?: { reels: number; total_reach: number; avg_reach: number | null };
  // YouTube Analytics API extras (owner-OAuth, yt-analytics.readonly). Headline metrics map to
  // the flat columns; these richer breakdowns live here.
  youtube?: {
    views_30d?:           number;
    minutes_watched_30d?: number;
    avg_view_pct?:        number;   // averageViewPercentage — retention
    subs_gained_30d?:     number;
    subs_lost_30d?:       number;
    subs_net_30d?:        number;
    age_gender?: Array<{ age: string; gender: string; pct: number }>;
    countries?: Array<{ key: string; value: number; pct: number }>;
    traffic?:   Array<{ key: string; value: number; pct: number }>;
    devices?:   Array<{ key: string; value: number; pct: number }>;
  };
};

export const socialAnalyticsSnapshots = pgTable("social_analytics_snapshots", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // NULL for non-connected sources (discovery / research / provider) — the athlete never OAuth-connected.
  // SET NULL (not cascade): a snapshot is durable analytics history keyed on athlete×platform×day.
  // The connection row is permanent per provider account (reconnects update it in place — 0071), but
  // deleting one must still NOT delete the athlete's analytics — just drop the provenance pointer.
  // (athlete_id above stays cascade: deleting the athlete themselves should remove their own data.)
  connected_account_id: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
  // Row provenance, highest→lowest fidelity: connected > provider > discovery > research.
  source:               text("source").notNull().default("connected"),
  platform:             text("platform").notNull(),                                   // 'instagram' | 'tiktok' | 'youtube'
  snapshot_date:        timestamp("snapshot_date", { withTimezone: true }).notNull().defaultNow(),  // precise capture instant
  snapshot_day:         date("snapshot_day").notNull(),                               // UTC calendar day, app-set; dedup key (date_trunc on timestamptz isn't IMMUTABLE → can't index it)

  // ── Profile counts ─────────────────────────────────────────────
  followers:            integer("followers"),
  following:            integer("following"),
  post_count:           integer("post_count"),
  total_likes:          integer("total_likes"),              // TikTok lifetime likes
  total_channel_views:  integer("total_channel_views"),      // YouTube
  is_verified:          boolean("is_verified").default(false),

  // ── Account-level insights (IG /insights) ──────────────────────
  reach:                integer("reach"),
  impressions:          integer("impressions"),              // deprecated on Graph v22 → may hold `views`
  profile_views:        integer("profile_views"),

  // ── Derived per-post / per-video aggregates ────────────────────
  avg_engagement_rate:  doublePrecision("avg_engagement_rate"),
  avg_reach_per_post:   integer("avg_reach_per_post"),
  avg_views_per_post:   integer("avg_views_per_post"),
  avg_shares_per_post:  integer("avg_shares_per_post"),
  avg_saves_per_post:   integer("avg_saves_per_post"),
  avg_watch_time_sec:   doublePrecision("avg_watch_time_sec"),
  content_frequency:    doublePrecision("content_frequency"),  // posts/week
  posts_last_30d:       integer("posts_last_30d"),             // exact 30-day count — the field scoring expects

  // ── Audience demographics (top values; full breakdown in raw_metrics) ──
  top_audience_country:   text("top_audience_country"),
  top_audience_city:      text("top_audience_city"),
  top_audience_age_range: text("top_audience_age_range"),
  top_audience_gender:    text("top_audience_gender"),

  raw_metrics:          jsonb("raw_metrics").$type<SocialAnalyticsRaw>(),

  created_at:           timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("sas_platform_check", sql`${table.platform} IN ('instagram','tiktok','youtube')`),
  check("sas_source_check", sql`${table.source} IN ('connected','discovery','research','provider')`),
  index("idx_sas_athlete_platform_date").on(table.athlete_id, table.platform, table.snapshot_date.desc()),
  // Dedup identity: one row per athlete × platform × UTC day — works for connected AND non-connected sources.
  uniqueIndex("idx_sas_athlete_platform_day").on(table.athlete_id, table.platform, table.snapshot_day),
]);

// ─── 18b. Social substrate (Phase A Step 1a, migration 0044) ───────────────────
// The social intelligence data layer of Commercial Intelligence Beta.1 §22.3 / §28.3: identities,
// sync runs, sanitized raw payloads, metric observations, audience distributions and versioned
// features. Written only when SOCIAL_SUBSTRATE_WRITE=true, beside the daily snapshot above,
// which is unchanged. athlete_id is the domain owner everywhere (ADR-015); source_class on
// every row keeps private (connected_verified) and public evidence separable (ADR-016).
// Uniqueness includes definition_version and the window bounds, NULLS NOT DISTINCT, so the same
// evidence can be re-adapted under a later definition and both interpretations coexist.

export const SOCIAL_SOURCE_CLASSES = ["connected_verified", "platform_public", "web_researched", "inferred", "imputed"] as const;

export const socialIdentities = pgTable("social_identities", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:             text("platform").notNull(),
  account_id:           text("account_id").notNull(),
  account_id_kind:      text("account_id_kind").notNull().default("platform_id"),
  handle:               text("handle"),
  canonical_url:        text("canonical_url"),
  handle_history:       jsonb("handle_history").notNull().default(sql`'[]'::jsonb`),
  source_class:         text("source_class").notNull(),
  source_method:        text("source_method").notNull(),
  confidence:           numeric("confidence", { precision: 3, scale: 2 }).notNull().default("1.00"),
  status:               text("status").notNull().default("active"),
  connected_account_id: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
  discovered_at:        timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  last_verified_at:     timestamp("last_verified_at", { withTimezone: true }),
  evidence:             jsonb("evidence"),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("social_identities_platform_check", sql`${t.platform} IN ('instagram','tiktok','youtube','x')`),
  check("social_identities_kind_check",     sql`${t.account_id_kind} IN ('platform_id','handle')`),
  check("social_identities_source_check",   sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  check("social_identities_status_check",   sql`${t.status} IN ('active','superseded','unverified','rejected')`),
  unique("social_identities_account_uq").on(t.athlete_id, t.platform, t.account_id),
  index("social_identities_athlete_platform_idx").on(t.athlete_id, t.platform, t.status),
  // Phase A Step 3a (D-13): one active canonical owner per account, across athletes.
  uniqueIndex("social_identities_owner_uq").on(t.platform, t.account_id).where(sql`${t.source_class} = 'connected_verified' AND ${t.status} = 'active'`),
]);

export const socialSyncRuns = pgTable("social_sync_runs", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  identity_id:          uuid("identity_id").references(() => socialIdentities.id, { onDelete: "set null" }),
  platform:             text("platform").notNull(),
  provider:             text("provider").notNull(),
  endpoint_family:      text("endpoint_family").notNull(),
  api_version:          text("api_version"),
  source_class:         text("source_class").notNull(),
  trigger:              text("trigger").notNull(),
  status:               text("status").notNull().default("running"),
  started_at:           timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finished_at:          timestamp("finished_at", { withTimezone: true }),
  pages:                integer("pages").notNull().default(0),
  items:                integer("items").notNull().default(0),
  pagination_state:     jsonb("pagination_state"),
  error:                jsonb("error"),
  connected_account_id: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("social_sync_runs_source_check",  sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  check("social_sync_runs_trigger_check", sql`${t.trigger} IN ('connect','nightly','backfill','discovery','manual','fixture','stories')`),   // 0045 adds 'stories'
  check("social_sync_runs_status_check",  sql`${t.status} IN ('running','ok','partial','failed')`),
  index("social_sync_runs_athlete_idx").on(t.athlete_id, t.platform, t.started_at),
  index("social_sync_runs_identity_idx").on(t.identity_id, t.endpoint_family, t.started_at),
]);

export const rawSourcePayloads = pgTable("raw_source_payloads", {
  id:                uuid("id").primaryKey().defaultRandom(),
  sync_run_id:       uuid("sync_run_id").notNull().references(() => socialSyncRuns.id, { onDelete: "cascade" }),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:          text("platform").notNull(),
  provider:          text("provider").notNull(),
  endpoint_family:   text("endpoint_family").notNull(),
  page_index:        integer("page_index").notNull().default(0),
  source_class:      text("source_class").notNull(),
  request:           jsonb("request"),
  payload:           jsonb("payload").notNull(),
  payload_hash:      text("payload_hash").notNull(),
  bytes:             integer("bytes"),
  sanitizer_version: text("sanitizer_version").notNull(),
  fetched_at:        timestamp("fetched_at", { withTimezone: true }).notNull(),
  retained_until:    timestamp("retained_until", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("raw_source_payloads_athlete_idx").on(t.athlete_id, t.platform, t.fetched_at),
  index("raw_source_payloads_run_idx").on(t.sync_run_id),
  index("raw_source_payloads_retention_idx").on(t.retained_until).where(sql`retained_until IS NOT NULL`),
]);

export const socialMetricObservations = pgTable("social_metric_observations", {
  id:                 bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:           text("platform").notNull(),
  identity_id:        uuid("identity_id").notNull().references(() => socialIdentities.id, { onDelete: "cascade" }),
  entity_type:        text("entity_type").notNull(),
  entity_id:          text("entity_id").notNull(),
  entity_time:        timestamp("entity_time", { withTimezone: true }),
  entity_format:      text("entity_format"),
  asset_id:           uuid("asset_id").references((): AnyPgColumn => mediaAssets.id, { onDelete: "set null" }),
  metric_key:         text("metric_key").notNull(),
  value:              numeric("value").notNull(),
  unit:               text("unit").notNull(),
  source_class:       text("source_class").notNull(),
  source_method:      text("source_method").notNull(),
  provider:           text("provider").notNull(),
  confidence:         numeric("confidence", { precision: 3, scale: 2 }).notNull().default("1.00"),
  observed_at:        timestamp("observed_at", { withTimezone: true }).notNull(),
  window_start:       timestamp("window_start", { withTimezone: true }),
  window_end:         timestamp("window_end", { withTimezone: true }),
  definition_version: text("definition_version").notNull(),
  sync_run_id:        uuid("sync_run_id").references(() => socialSyncRuns.id, { onDelete: "set null" }),
  payload_id:         uuid("payload_id").references(() => rawSourcePayloads.id, { onDelete: "set null" }),
  created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("smo_entity_check", sql`${t.entity_type} IN ('account','content','audience')`),
  check("smo_source_check", sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  unique("smo_identity_uq").on(t.identity_id, t.entity_type, t.entity_id, t.metric_key, t.definition_version, t.source_method, t.observed_at, t.window_start, t.window_end).nullsNotDistinct(),
  index("smo_identity_metric_idx").on(t.identity_id, t.metric_key, t.observed_at),
  index("smo_athlete_idx").on(t.athlete_id, t.platform, t.entity_type, t.observed_at),
  index("smo_asset_idx").on(t.asset_id).where(sql`asset_id IS NOT NULL`),
]);

export const socialAudienceDistributions = pgTable("social_audience_distributions", {
  id:                 bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:           text("platform").notNull(),
  identity_id:        uuid("identity_id").notNull().references(() => socialIdentities.id, { onDelete: "cascade" }),
  dimension:          text("dimension").notNull(),
  bucket:             text("bucket").notNull(),
  value:              numeric("value"),
  pct:                numeric("pct"),
  basis:              text("basis").notNull(),
  source_class:       text("source_class").notNull(),
  source_method:      text("source_method").notNull(),
  provider:           text("provider").notNull(),
  confidence:         numeric("confidence", { precision: 3, scale: 2 }).notNull().default("1.00"),
  observed_at:        timestamp("observed_at", { withTimezone: true }).notNull(),
  window_start:       timestamp("window_start", { withTimezone: true }),
  window_end:         timestamp("window_end", { withTimezone: true }),
  definition_version: text("definition_version").notNull(),
  sync_run_id:        uuid("sync_run_id").references(() => socialSyncRuns.id, { onDelete: "set null" }),
  payload_id:         uuid("payload_id").references(() => rawSourcePayloads.id, { onDelete: "set null" }),
  created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("sad_dimension_check", sql`${t.dimension} IN ('country','city','age','gender','age_gender','traffic_source','device')`),
  check("sad_basis_check",     sql`${t.basis} IN ('followers','viewers','views')`),
  check("sad_source_check",    sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  unique("sad_identity_uq").on(t.identity_id, t.dimension, t.bucket, t.basis, t.definition_version, t.source_method, t.observed_at, t.window_start, t.window_end).nullsNotDistinct(),
  index("sad_identity_dimension_idx").on(t.identity_id, t.dimension, t.observed_at),
]);

export const socialFeatures = pgTable("social_features", {
  id:                  bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:            text("platform"),
  identity_id:         uuid("identity_id").references(() => socialIdentities.id, { onDelete: "cascade" }),
  feature_key:         text("feature_key").notNull(),
  value:               numeric("value"),
  value_json:          jsonb("value_json"),
  unit:                text("unit").notNull(),
  n:                   integer("n"),
  window_days:         integer("window_days").notNull(),
  as_of:               timestamp("as_of", { withTimezone: true }).notNull(),
  source_class:        text("source_class").notNull(),
  confidence:          numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  imputed:             boolean("imputed").notNull().default(false),
  /** Privacy class of the INPUTS, independent of authority: includes_athlete_private when any input is connected_verified evidence. */
  input_access_class:  text("input_access_class").notNull().default("public_only"),
  calculation_version: text("calculation_version").notNull(),
  inputs:              jsonb("inputs").notNull(),
  computed_at:         timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("sf_source_check", sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  check("sf_access_check", sql`${t.input_access_class} IN ('public_only','includes_athlete_private')`),
  unique("sf_feature_uq").on(t.athlete_id, t.platform, t.identity_id, t.feature_key, t.window_days, t.as_of, t.calculation_version).nullsNotDistinct(),
  index("sf_athlete_asof_idx").on(t.athlete_id, t.as_of),
]);

export type SocialIdentity              = typeof socialIdentities.$inferSelect;
export type NewSocialIdentity           = typeof socialIdentities.$inferInsert;
export type SocialSyncRun               = typeof socialSyncRuns.$inferSelect;
export type RawSourcePayload            = typeof rawSourcePayloads.$inferSelect;
export type SocialMetricObservation     = typeof socialMetricObservations.$inferSelect;
export type NewSocialMetricObservation  = typeof socialMetricObservations.$inferInsert;
export type SocialAudienceDistribution  = typeof socialAudienceDistributions.$inferSelect;
export type NewSocialAudienceDistribution = typeof socialAudienceDistributions.$inferInsert;
export type SocialFeature               = typeof socialFeatures.$inferSelect;
export type NewSocialFeature            = typeof socialFeatures.$inferInsert;

// ─── 18c. Research substrate (Phase A Step 2a, migration 0046) ─────────────────
// Evidence → facts → inferences with the research lifecycle per athlete. Keyed on athlete_id;
// no user/organization/tenant column (ADR-015/016). Writes gated by RESEARCH_SUBSTRATE_WRITE.
// Provenance is two fields: origin (who put a fact forward) and source_class (authority of the
// evidence). The canonical SourceClass vocabulary stays global and five-valued
// (SOCIAL_SOURCE_CLASSES / intelligence/types SOURCE_CLASSES); research_evidence admits all five.
// athlete_facts INTENTIONALLY admits only connected_verified | platform_public | web_researched |
// NULL — inferred and imputed are invalid for facts by design (R1); NULL is reserved for the
// athlete's own assertion/proof. Connection status is derived at read time and never stored in
// athlete_research_state (R2).

export const researchRuns = pgTable("research_runs", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  domain:             text("domain").notNull(),
  trigger:            text("trigger").notNull(),
  providers:          jsonb("providers").notNull().default(sql`'[]'::jsonb`),
  identity_hints:     jsonb("identity_hints"),
  hints_hash:         text("hints_hash"),
  status:             text("status").notNull().default("running"),
  started_at:         timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finished_at:        timestamp("finished_at", { withTimezone: true }),
  calls:              integer("calls").notNull().default(0),
  tokens_in:          integer("tokens_in"),
  tokens_out:         integer("tokens_out"),
  tokens_cached:      integer("tokens_cached"),
  latency_ms:         integer("latency_ms"),
  estimated_cost_usd: numeric("estimated_cost_usd", { precision: 10, scale: 4 }),
  confidence_out:     numeric("confidence_out", { precision: 3, scale: 2 }),
  summary:            jsonb("summary"),
  error:              jsonb("error"),
  // Step 2b (0047): workflow link, the monotonic freshness key, per-run lane counters (§5.1).
  workflow_run_id:    uuid("workflow_run_id"),
  as_of:              timestamp("as_of", { withTimezone: true }),
  llm_attempts:       integer("llm_attempts").notNull().default(0),
  signal_calls:       integer("signal_calls").notNull().default(0),
  other_calls:        integer("other_calls").notNull().default(0),
  // PR E2a (0081): the research-spec/1 query (Q1–Q6) a research_refresh v3 row persists. NULL for legacy, v2 and
  // direct-CLI rows, and for a v3 run's signals row (the run's single NULL slot).
  // 0082: `READ` = the run's targeted source-read step (one row per workflow run).
  query_id:           text("query_id"),
}, (t) => [
  check("research_runs_trigger_check", sql`${t.trigger} IN ('signup','identity_confirmed','ttl','event','manual','backfill','dual_write')`),
  check("research_runs_status_check", sql`${t.status} IN ('running','ok','partial','failed')`),
  check("research_runs_domain_check", sql`${t.domain} IN ('identity','profile','affiliations','achievements','press','brand_mentions','narrative','social_handles','signals','full','refresh')`),
  index("research_runs_athlete_idx").on(t.athlete_id, t.started_at),
  index("research_runs_started_idx").on(t.started_at),
  check("research_runs_query_id_check", sql`${t.query_id} IS NULL OR ${t.query_id} IN ('Q1','Q2','Q3','Q4','Q5','Q6','READ')`),
  // At most ONE successful canonical run per (workflow run, query) (at-least-once step safety; 0081 widened 0047's key).
  uniqueIndex("research_runs_workflow_success").on(t.workflow_run_id, sql`COALESCE(${t.query_id}, '')`).where(sql`workflow_run_id IS NOT NULL AND status IN ('ok','partial')`),
]);

export const researchSourcePayloads = pgTable("research_source_payloads", {
  id:                uuid("id").primaryKey().defaultRandom(),
  run_id:            uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  provider:          text("provider").notNull(),
  model:             text("model"),
  endpoint_family:   text("endpoint_family").notNull(),
  request:           jsonb("request"),
  payload:           jsonb("payload").notNull(),
  payload_hash:      text("payload_hash").notNull(),
  bytes:             integer("bytes"),
  sanitizer_version: text("sanitizer_version").notNull(),
  fetched_at:        timestamp("fetched_at", { withTimezone: true }).notNull(),
  retained_until:    timestamp("retained_until", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("research_payloads_run_idx").on(t.run_id),
]);

export const researchEvidence = pgTable("research_evidence", {
  id:                        uuid("id").primaryKey().defaultRandom(),
  athlete_id:                uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  run_id:                    uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  payload_id:                uuid("payload_id").references(() => researchSourcePayloads.id, { onDelete: "set null" }),
  kind:                      text("kind").notNull(),
  claim:                     jsonb("claim").notNull(),
  support:                   jsonb("support"),
  lineage_status:            text("lineage_status").notNull(),
  source_url:                text("source_url"),
  source_domain:             text("source_domain"),
  source_type:               text("source_type").notNull().default("unknown"),
  published_at:              timestamp("published_at", { withTimezone: true }),
  retrieved_at:              timestamp("retrieved_at", { withTimezone: true }).notNull(),
  extractor:                 text("extractor"),
  extraction_schema_version: text("extraction_schema_version"),
  confidence:                numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
  source_class:              text("source_class").notNull().default("web_researched"),
  about_identity_confidence: numeric("about_identity_confidence", { precision: 3, scale: 2 }),
  suspect:                   boolean("suspect").notNull().default(false),
  dedupe_key:                text("dedupe_key").notNull(),
  superseded_by:             uuid("superseded_by").references((): AnyPgColumn => researchEvidence.id, { onDelete: "set null" }),
  created_at:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("research_evidence_kind_check", sql`${t.kind} IN ('achievement','press_mention','brand_mention','affiliation','profile_attribute','social_handle','nil_mention','sentiment','media_asset','identity_signal','signal','career_event','reputation_event','social_metric_claim','representation','venture','crossover_appearance','narrative_claim','research_finding','athlete_statement')`),
  check("research_evidence_lineage_check", sql`${t.lineage_status} IN ('cited','uncited','conflicting','native_supported','native_retrieved','asserted_only','source_read')`),
  check("research_evidence_source_type_check", sql`${t.source_type} IN ('official_governing_body','official_team_or_school','major_news','reference','regional_news','athlete_authored_public','aggregator_or_blog','unknown')`),
  check("research_evidence_source_class_check", sql`${t.source_class} IN ('connected_verified','platform_public','web_researched','inferred','imputed')`),
  index("research_evidence_athlete_kind_idx").on(t.athlete_id, t.kind, t.retrieved_at),
  index("research_evidence_dedupe_idx").on(t.athlete_id, t.dedupe_key),
]);

export const athleteFacts = pgTable("athlete_facts", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  fact_key:         text("fact_key").notNull(),
  value:            jsonb("value").notNull(),
  value_text:       text("value_text").notNull(),
  status:           text("status").notNull(),
  valid_from:       date("valid_from"),
  valid_to:         date("valid_to"),
  observed_at:      timestamp("observed_at", { withTimezone: true }),
  retrieved_at:     timestamp("retrieved_at", { withTimezone: true }).notNull(),
  origin:           text("origin").notNull(),
  source_class:     text("source_class"),
  authority_tier:   smallint("authority_tier"),
  confidence:       numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  provenance:       jsonb("provenance").notNull(),
  freshness_family: text("freshness_family").notNull(),
  resolver_version: text("resolver_version").notNull(),
  registry_version: text("registry_version").notNull(),
  superseded_by:    uuid("superseded_by").references((): AnyPgColumn => athleteFacts.id, { onDelete: "set null" }),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("athlete_facts_status_check", sql`${t.status} IN ('current','historical','superseded','retracted','disputed')`),
  check("athlete_facts_origin_check", sql`${t.origin} IN ('athlete_asserted','athlete_proof','connection','research','backfill')`),
  check("athlete_facts_source_class_check", sql`${t.source_class} IS NULL OR ${t.source_class} IN ('connected_verified','platform_public','web_researched')`),
  check("athlete_facts_assertion_class_check", sql`(${t.origin} IN ('athlete_asserted','athlete_proof')) = (${t.source_class} IS NULL)`),
  index("athlete_facts_athlete_key_idx").on(t.athlete_id, t.fact_key, t.status),
]);

export const athleteInferences = pgTable("athlete_inferences", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  inference_key:    text("inference_key").notNull(),
  value:            jsonb("value").notNull(),
  taxonomy_version: text("taxonomy_version"),
  producer:         text("producer").notNull(),
  lineage:          jsonb("lineage").notNull(),
  confidence:       numeric("confidence", { precision: 3, scale: 2 }),
  computed_at:      timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  superseded_by:    uuid("superseded_by").references((): AnyPgColumn => athleteInferences.id, { onDelete: "set null" }),
}, (t) => [
  index("athlete_inferences_athlete_key_idx").on(t.athlete_id, t.inference_key, t.computed_at),
]);

export const athleteResearchState = pgTable("athlete_research_state", {
  athlete_id:           uuid("athlete_id").primaryKey().references(() => athletes.id, { onDelete: "cascade" }),
  research_status:      text("research_status").notNull().default("seed_only"),
  identity_confidence:  numeric("identity_confidence", { precision: 3, scale: 2 }).notNull().default("0.00"),
  identity_resolved_at: timestamp("identity_resolved_at", { withTimezone: true }),
  domains:              jsonb("domains").notNull().default(sql`'{}'::jsonb`),
  disputed_domains:     jsonb("disputed_domains").notNull().default(sql`'[]'::jsonb`),
  last_researched_at:   timestamp("last_researched_at", { withTimezone: true }),
  next_due_at:          timestamp("next_due_at", { withTimezone: true }),
  total_cost_usd:       numeric("total_cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  search_hints:         jsonb("search_hints"),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Step 2b (0047): event queue, failure back-off, planning marks. Written ONLY when the execution gate is true.
  pending:              jsonb("pending").notNull().default(sql`'[]'::jsonb`),            // [{domain, trigger, reason, requestedAt}]
  refresh_failures:     jsonb("refresh_failures").notNull().default(sql`'{}'::jsonb`),   // {domain: {count, lastOutcome, lastError, deferredUntil, disputeRechecks}}
  last_planned_at:      timestamp("last_planned_at", { withTimezone: true }),
  // PR E1 (0080): athlete-level public-identity resolution — WHO the research concerns. NULL = no determination
  // recorded (historical; NOT pending). Never derived from identity_confidence / identity_resolved_at /
  // research_status, which are ACCOUNT-ownership signals. Written only by research/identityResolution.ts.
  identity_resolution:        text("identity_resolution"),
  identity_resolution_detail: jsonb("identity_resolution_detail"),   // provenance: the in-force determination + `previous`
}, (t) => [
  check("athlete_research_state_status_check", sql`${t.research_status} IN ('seed_only','identity_resolved','research_partial','research_complete','research_stale')`),
  check("athlete_research_state_identity_resolution_check", sql`${t.identity_resolution} IS NULL OR ${t.identity_resolution} IN ('pending','resolved','ambiguous','failed')`),
  check("athlete_research_state_identity_detail_check", sql`(${t.identity_resolution} IS NULL) = (${t.identity_resolution_detail} IS NULL)`),
]);

// ── Step 2b: planner telemetry and the atomic per-day budget ledger (0047) ──
// research_planner_runs: one row per planner pass; in dry_run the ONLY table the planner writes.
export const researchPlannerRuns = pgTable("research_planner_runs", {
  id:                uuid("id").primaryKey().defaultRandom(),
  started_at:        timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finished_at:       timestamp("finished_at", { withTimezone: true }),
  status:            text("status").notNull().default("running"),
  mode:              text("mode").notNull(),
  as_of:             timestamp("as_of", { withTimezone: true }).notNull(),
  policy_version:    text("policy_version").notNull(),
  evaluated:         integer("evaluated").notNull().default(0),
  would_materialize: integer("would_materialize").notNull().default(0),
  transitions:       jsonb("transitions").notNull().default(sql`'{}'::jsonb`),
  candidates:        integer("candidates").notNull().default(0),
  admitted:          integer("admitted").notNull().default(0),
  deferred:          jsonb("deferred").notNull().default(sql`'{}'::jsonb`),
  budget:            jsonb("budget").notNull().default(sql`'{}'::jsonb`),
  plans:             jsonb("plans").notNull().default(sql`'[]'::jsonb`),
  leak_refusals:     integer("leak_refusals").notNull().default(0),
  error:             jsonb("error"),
}, (t) => [
  check("research_planner_runs_status_check", sql`${t.status} IN ('running','ok','failed','skipped')`),
  check("research_planner_runs_mode_check", sql`${t.mode} IN ('dry_run','enqueue')`),
  index("research_planner_runs_started_idx").on(t.started_at),
]);

// research_budget_days: the authoritative per-UTC-day counters, reserved atomically by
// reserveLlmCall() (one conditional UPDATE) before every Gemini/Kimi attempt, retries included.
export const researchBudgetDays = pgTable("research_budget_days", {
  day:          date("day").primaryKey(),
  llm_attempts: integer("llm_attempts").notNull().default(0),
  signal_calls: integer("signal_calls").notNull().default(0),
  other_calls:  integer("other_calls").notNull().default(0),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Step 2c: Athlete Index match telemetry (0048). The view athlete_index_v is deliberately not
// declared here (the drift gate iterates pgTable exports only); its column set is pinned in
// server/services/intelligence/identity/index.ts and checked at runtime and in tests.
export const athleteIndexMatches = pgTable("athlete_index_matches", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  at:                 timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  path:               text("path").notNull(),
  query:              jsonb("query").notNull(),
  candidates:         jsonb("candidates").notNull().default(sql`'[]'::jsonb`),
  tier:               text("tier").notNull(),
  claim_proof:        text("claim_proof").notNull(),
  decision:           text("decision").notNull(),
  chosen_athlete_id:  uuid("chosen_athlete_id").references(() => athletes.id, { onDelete: "set null" }),
  created_athlete_id: uuid("created_athlete_id").references(() => athletes.id, { onDelete: "set null" }),
  policy_version:     text("policy_version").notNull(),
}, (t) => [
  check("athlete_index_matches_tier_check", sql`${t.tier} IN ('auto_match','candidate','new')`),
  check("athlete_index_matches_proof_check", sql`${t.claim_proof} IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')`),
  check("athlete_index_matches_decision_check", sql`${t.decision} IN ('linked_by_auth','linked_by_verified_email','linked_by_ownership','linked_by_operator','possible_duplicate','new')`),
  index("athlete_index_matches_at_idx").on(t.at),
]);
export type AthleteIndexMatch   = typeof athleteIndexMatches.$inferSelect;

export type ResearchPlannerRun  = typeof researchPlannerRuns.$inferSelect;
export type ResearchBudgetDay   = typeof researchBudgetDays.$inferSelect;

export type ResearchRun          = typeof researchRuns.$inferSelect;
export type ResearchEvidenceRow  = typeof researchEvidence.$inferSelect;
export type AthleteFactRow       = typeof athleteFacts.$inferSelect;
export type AthleteInferenceRow  = typeof athleteInferences.$inferSelect;
export type AthleteResearchState = typeof athleteResearchState.$inferSelect;

// ─── media_assets ────────────────────────────────────────────────────────────
// Durable owned copy of athlete post media. IG hands us ephemeral CDN URLs
// (`recent_media` in the snapshot) that expire in hours; this table + a GCS bucket
// are the re-hosted, owned pixels the media-kit / pitch-deck / generation features
// build on. Shaped as a unified asset library: `origin` is extensible (later
// 'upload'/'generated'), `derived_from_asset_id` carries lineage, `metadata` is
// reserved for Layer-1 enrichment. See docs/durable-media-rehosting.md.
export const mediaAssets = pgTable("media_assets", {
  id:                    uuid("id").primaryKey().defaultRandom(),
  athlete_id:            uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:              text("platform").notNull(),          // 'instagram' (extensible)
  origin:                text("origin").notNull(),            // 'connected' | 'discovery' | 'upload' | 'generated' | 'reference' (a link she gave; never her footage)
  source_media_id:       text("source_media_id"),             // IG media id; NULL for upload/generated
  parent_media_id:       text("parent_media_id"),             // carousel album's media id (set on child rows)
  // Lineage for generated/derived variants: the frame an EDIT preserved. NULL for `generate`, which
  // by definition has no source frame. ON DELETE SET NULL is deliberate — RESTRICT would break the
  // athlete-level cascade above (offboarding/GDPR), and CASCADE would let one bad delete take out a
  // whole lineage tree. Losing a pointer is recoverable; losing the asset is not.
  derived_from_asset_id: uuid("derived_from_asset_id")
    .references((): AnyPgColumn => mediaAssets.id, { onDelete: "set null" }),
  media_type:            text("media_type").notNull(),        // IMAGE | VIDEO | REELS | CAROUSEL_ALBUM | CAROUSEL_CHILD
  permalink:             text("permalink"),                   // durable IG link
  caption:               text("caption"),
  posted_at:             timestamp("posted_at", { withTimezone: true }),
  like_count:            integer("like_count"),
  comments_count:        integer("comments_count"),
  insights:              jsonb("insights"),                   // per-post reach/saved/shares (connected only)
  gcs_path:              text("gcs_path"),                    // re-hosted still (image or video poster); NULL if no pixels
  gcs_thumb_path:        text("gcs_thumb_path"),
  content_type:          text("content_type"),
  bytes:                 bigint("bytes", { mode: "number" }),
  width:                 integer("width"),
  height:                integer("height"),
  duration_seconds:      integer("duration_seconds"),          // videos only (from the client picker on upload)
  // The REAL length, measured (migration 0058). duration_seconds above is an INTEGER and three
  // writers round a fraction away to fit it — including one that rounds SILENTLY, via Postgres's
  // int4 cast. This column is the measured figure: ffprobe's at upload, the stitch manifest's for
  // generated output, the picker's fraction when nothing could be measured. NULL means "not
  // measured", never "zero" — most Instagram video rows hold only a poster JPEG, so there are no
  // video bytes on our side to probe and they stay NULL by construction.
  //
  // NOT a widening of duration_seconds, and NOT backfilled from it in either direction: a rounded
  // integer is not evidence about a fraction. duration_seconds keeps its meaning and its readers
  // (the picker, fmtDur in the library grid) exactly as they are. See 0058's header for why
  // additive beat an in-place ALTER, and why double precision beat numeric.
  duration_seconds_precise: doublePrecision("duration_seconds_precise"),
  // Phase A Step 1a (migration 0044, decision D1): media_assets is the durable SOCIAL CONTENT
  // entity. `native` holds platform-native immutable fields the adapter preserves (sanitized,
  // no signed URLs); `content_format` is the canonical format; `native_version` the adapter
  // version that wrote it. like_count / comments_count / insights stay DISPLAY projections —
  // metric history lives in social_metric_observations and the feature calculator never reads
  // these columns.
  social_identity_id:    uuid("social_identity_id").references((): AnyPgColumn => socialIdentities.id, { onDelete: "set null" }),
  native:                jsonb("native"),
  content_format:        text("content_format"),              // post | reel | story | carousel | carousel_frame | video | short | long_form
  native_version:        text("native_version"),
  first_seen_at:         timestamp("first_seen_at", { withTimezone: true }),
  status:                text("status").notNull(),            // 'stored' | 'failed' | 'skipped_size'
  metadata:              jsonb("metadata"),                   // reserved: Layer-1 enrichment (tags, embedding ref)
  ingested_at:           timestamp("ingested_at", { withTimezone: true }),
  metadata_updated_at:   timestamp("metadata_updated_at", { withTimezone: true }),
  // Brand-deal linkage + lifecycle (docs/opportunity-pitch-content-model.md §5 Stage 3). Brand
  // association is M:N (see content_brands), NOT a column here. deal_id = the deal this content was
  // ORIGINATED under (provenance, immutable; reuse is tracked via content_posts). approval_status
  // gates embed/post for generated/brand content (NULL = ungated, e.g. ingested IG posts). deleted_at
  // = soft delete (a referenced asset is soft-deleted, never hard-deleted).
  deal_id:               uuid("deal_id").references(() => deals.id),
  approval_status:       text("approval_status"),            // NULL | 'draft' | 'approved' | 'rejected'
  deleted_at:            timestamp("deleted_at", { withTimezone: true }),
  // The generation job that produced this asset (studio/jobs.ts). One job → many assets, so approval
  // is per-asset, not per-job. Declared WITHOUT .references() because media_assets and
  // generation_jobs point at each other; the FK is added by studio/sql/studioGenerationDdl.sql,
  // which both the migration and the PGlite tests apply.
  generation_job_id:     uuid("generation_job_id"),
  /**
   * ⚠️ NO CODE WRITES THIS YET. Read that before building anything on it.
   *
   * Populating it is a SEPARATE PR. `recordGeneratedAsset` (studio/jobs.ts) does not set it, nothing
   * publishes Studio output into content_posts, and the Studio client has never held a deal id at
   * all — so today this column is NULL on every row in the table, without exception.
   *
   * That is not a bug and it does not need working around. `delivered` on a deliverable is DERIVED
   * by counting the assets pointing here, so with nothing written the count is 0 — and 0 is TRUE:
   * nothing has been attributed to that obligation yet. "0 of 3 delivered" is an accurate sentence.
   * Do not add a denormalized counter to avoid the join; that is `deals.amount` again, the copy
   * that went stale badly enough that dealVoice now opens with "NEVER speak deals.amount".
   *
   * The column lands NOW so the migration does not have to happen underneath a populated table
   * later — the same argument 0030 makes for payments.installment_id, which shipped nullable,
   * indexed and unused for exactly this reason.
   *
   * ON DELETE SET NULL, never cascade: editing a deal's schedule must never delete her work.
   *
   * Whoever writes it has one real decision to make first, and it is a product decision rather
   * than a schema one: WHEN does a piece count as delivered — at generation, at approval, or at
   * posting? The read currently assumes approval as a proxy (studio/dealDeliverables.ts).
   */
  deal_deliverable_id:   uuid("deal_deliverable_id").references(() => dealDeliverables.id, { onDelete: "set null" }),
  created_at:            timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("media_assets_status_check", sql`${table.status} IN ('stored','failed','skipped_size')`),
  index("idx_media_assets_deliverable").on(table.deal_deliverable_id).where(sql`deal_deliverable_id IS NOT NULL`),
  check("media_assets_approval_check", sql`${table.approval_status} IS NULL OR ${table.approval_status} IN ('draft','approved','rejected')`),
  // The origin vocabulary was documented in a comment and enforced by nothing. Live data is only
  // 'connected' (561) and 'upload' (3), both listed, so adding this validates instantly.
  // 'reference' (0062): a picture she POINTED AT — fetched from a link she gave the direction engine
  // (PR 7, Lane C) and stored under her prefix so a plan row can name it. Not her footage: every
  // library reader excludes it (studio/photoPredicate.ts, services/mediaEnrichment.ts,
  // routes/media.ts); only the reference engine reads it, by id, under her athlete_id.
  check("media_assets_origin_check", sql`${table.origin} IN ('connected','discovery','upload','generated','reference')`),
  // one row per athlete × platform × source media id (NULLs distinct → upload/generated rows allowed)
  uniqueIndex("idx_media_assets_source").on(table.athlete_id, table.platform, table.source_media_id),
  index("idx_media_assets_athlete").on(table.athlete_id, table.posted_at.desc()),
  // "what came from this frame" — partial, because only generated rows carry a parent.
  index("idx_media_assets_derived_from").on(table.derived_from_asset_id)
    .where(sql`derived_from_asset_id IS NOT NULL`),
  index("idx_media_assets_generation_job").on(table.generation_job_id)
    .where(sql`generation_job_id IS NOT NULL`),
]);

/**
 * The athlete's word that they may post their media (content engine step 2, owner decision 9 Nov 2026; migration 0151;
 * server/agent/ready/rights.ts). Asked on "Post it", only for what is missing, then remembered:
 *   own_posts  ONCE PER SOURCE ASSET: "these are my photos and clips" — covers their own posts only. asset_ref (and asset_id
 *              while the asset exists) set.
 *   sponsored  ONCE PER DEAL: the rights to use them in a sponsored post for that partner. deal_key set: the matching
 *              deal / gift / affiliate record ("deal:<id>" / "shop:<id>"), or "brand:<name>" when there is no record.
 * Revocable: revoked_at set (the row is kept as the record of what was said and when); a new word is a new row. At most
 * one live row per (athlete, asset) and per (athlete, deal). `words` is the exact line the sheet showed, at `words_version`.
 * The word outlives its photo or clip (owner decision 10 Nov 2026): deleting the asset sets asset_id NULL and the row
 * stays, with asset_ref / asset_kind saying which asset it was. A row with a NULL asset_id confirms nothing: it can never
 * match a new asset (lookups and the live-asset index read asset_id only).
 */
export const mediaRightsAttestations = pgTable("media_rights_attestations", {
  id:            uuid("id").primaryKey().defaultRandom(),
  athlete_id:    uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  scope:         text("scope").notNull(),
  asset_id:      uuid("asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
  /** own_posts: which asset it was, kept after the asset is deleted — "<platform>:<media_assets id>". */
  asset_ref:     text("asset_ref"),
  /** own_posts: "photo" | "clip", kept likewise. */
  asset_kind:    text("asset_kind"),
  deal_key:      text("deal_key"),
  brand:         text("brand"),
  /** The ready item (memory_decisions id) it was given on; no FK: a decision row may be pruned, the word stands. */
  item_id:       uuid("item_id"),
  words:         text("words").notNull(),
  words_version: text("words_version").notNull(),
  attested_at:   timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  revoked_at:    timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  check("media_rights_attestations_scope_check", sql`(${table.scope} = 'own_posts' AND ${table.asset_ref} IS NOT NULL AND ${table.deal_key} IS NULL) OR (${table.scope} = 'sponsored' AND ${table.deal_key} IS NOT NULL AND ${table.asset_id} IS NULL AND ${table.asset_ref} IS NULL)`),
  uniqueIndex("uq_media_rights_live_asset").on(table.athlete_id, table.asset_id).where(sql`scope = 'own_posts' AND revoked_at IS NULL AND asset_id IS NOT NULL`),
  uniqueIndex("uq_media_rights_live_deal").on(table.athlete_id, table.deal_key).where(sql`scope = 'sponsored' AND revoked_at IS NULL`),
  index("idx_media_rights_athlete").on(table.athlete_id, table.attested_at),
]);

// Per-athlete × platform pagination checkpoint for the full-history media backfill.
// Resumable + throttled: each cron tick fetches a bounded chunk from `cursor`, ingests
// into media_assets, and advances the cursor; `status='complete'` when the history is
// exhausted. See docs/media-library-backfill.md.
export const mediaBackfillState = pgTable("media_backfill_state", {
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:    text("platform").notNull(),                 // 'instagram' | 'tiktok' | 'youtube'
  cursor:      text("cursor"),                             // resume token (IG after / TikTok cursor / YT pageToken); NULL = from start
  status:      text("status").notNull().default("pending"), // 'pending' | 'running' | 'complete' | 'error'
  items_seen:  integer("items_seen").notNull().default(0), // paginated so far (backstop guard)
  last_error:  text("last_error"),
  updated_at:  timestamp("updated_at", { withTimezone: true }).defaultNow(),
  created_at:  timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.platform] }),
]);

// Cached Nomi Card — the assembled MediaKitData (with GCS PATHS, not signed URLs). The expensive
// agent DAG runs on events and writes here; the /card route reads this and signs images fresh at
// serve (1h URLs would break an hour after caching). See services/kitCache.ts.
export const mediaKits = pgTable("media_kits", {
  // Surrogate PK (docs/opportunity-pitch-content-model.md §5, O4). Pitch identity is
  // (athlete_id, brand_id, opportunity_id), enforced by the two PARTIAL unique indexes below —
  // a plain composite PK can't include a nullable opportunity_id.
  id:             uuid("id").primaryKey().defaultRandom(),
  athlete_id:     uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  brand_id:       integer("brand_id").notNull().default(0),   // 0 = generic card; else inbox_brands.id (tailored)
  // Anchors a pitch to a specific opportunity (deal/campaign). NULL = the general pitch per brand
  // (and brand_id 0 + NULL = the public card). Lets many opportunity-scoped pitches to one brand coexist.
  opportunity_id: uuid("opportunity_id").references(() => deals.id),
  data:           jsonb("data").notNull(),                    // MediaKitData (paths, not signed URLs)
  theme:          text("theme"),
  generated_at:   timestamp("generated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  // one pitch per (brand, opportunity) …
  uniqueIndex("media_kits_brand_opportunity_uniq")
    .on(table.athlete_id, table.brand_id, table.opportunity_id).where(sql`opportunity_id IS NOT NULL`),
  // … and exactly one "general" pitch per brand (the NULL-opportunity bucket collapses to a singleton)
  uniqueIndex("media_kits_brand_general_uniq")
    .on(table.athlete_id, table.brand_id).where(sql`opportunity_id IS NULL`),
]);

// ── Content relationship tables (docs/opportunity-pitch-content-model.md §5 Stage 3) ──

// M:N brand tags on a content asset — "this content depicts/serves brand X" (O1). A piece can be
// co-branded; absence of any row = personal/unbranded. Cross-brand embedding is governed by
// clearance, not by these tags.
export const contentBrands = pgTable("content_brands", {
  asset_id:   uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  brand_id:   integer("brand_id").notNull().references(() => inboxBrands.id, { onDelete: "cascade" }),
  role:       text("role"),   // NULL | 'primary' | 'featured'
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.asset_id, table.brand_id] }),
  check("content_brands_role_check", sql`${table.role} IS NULL OR ${table.role} IN ('primary','featured')`),
]);

// Embed-by-reference (D7): a content asset placed into a media kit / pitch at a position. One asset
// → many kits, one kit → many assets. Editing the asset propagates to the working kit; sent
// snapshots freeze separately (card_shares.snapshot_data).
export const kitContent = pgTable("kit_content", {
  id:           uuid("id").primaryKey().defaultRandom(),
  media_kit_id: uuid("media_kit_id").notNull().references(() => mediaKits.id, { onDelete: "cascade" }),
  asset_id:     uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  position:     integer("position").notNull().default(0),
  created_at:   timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("kit_content_kit_asset_uniq").on(table.media_kit_id, table.asset_id),
]);

// Publish records (P4): one asset → many posts across platforms/reposts. Delivery-under-a-deal is
// recorded here (not on the asset), so content reused in a later campaign attributes correctly.
export const contentPosts = pgTable("content_posts", {
  id:         uuid("id").primaryKey().defaultRandom(),
  asset_id:   uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  platform:   text("platform").notNull(),   // 'instagram' | 'tiktok' | 'youtube' | …
  permalink:  text("permalink"),
  insights:   jsonb("insights"),
  deal_id:    uuid("deal_id").references(() => deals.id),   // delivered-under (nullable)
  posted_at:  timestamp("posted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_content_posts_asset").on(table.asset_id),
  index("idx_content_posts_deal").on(table.deal_id).where(sql`deal_id IS NOT NULL`),
  // One publish record per real post — re-running a sync must not double-count a post.
  uniqueIndex("content_posts_platform_permalink_uniq").on(table.platform, table.permalink)
    .where(sql`permalink IS NOT NULL`),
]);

// ── Studio generation jobs ───────────────────────────────────────────────────
// One row per content job the Studio ran: the frozen CreativeBrief that was asked for, the route it
// resolved to, what it was quoted, and how it ended. The output assets point back here via
// media_assets.generation_job_id.
//
// ⚠️  NO LEASING — READ BEFORE ADDING A POLLER.
// There is deliberately no lease_expires_at, no worker_id, no SELECT ... FOR UPDATE SKIP LOCKED.
// This used to say that was safe "because Studio generation runs on one instance", which was never
// true of the deployment — gcp/cloud-run-dev.yaml sets minScale 1 / maxScale 3. What keeps it safe is
// narrower: NOTHING POLLS status='pending'. Generation runs inline in the request
// (server/studio/generate.ts). Add a background runner without building leasing first and, with
// three instances, two of them will claim the same row and BOTH WILL SPEND — real money, twice.
// Note also that claimJob is not a double-tap guard: every createGenerationJob call INSERTs a new
// row, so two taps are two job ids. The single-spend guarantee lives on the approval instead, in
// studio_generation_previews.consumed_at.
//
// Lifecycle shape is copied from media_backfill_state (status + last_error + timestamps); the
// propose→approve→execute discipline is copied from pending_actions. Retry/backoff is deliberately
// absent — a failed job is failed, and re-running is a NEW row with its own cost line.
export const generationJobs = pgTable("generation_jobs", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  brand_id:           integer("brand_id").references(() => inboxBrands.id),

  // Denormalised out of the brief so the common queries never open the jsonb.
  origin:             text("origin").notNull(),        // 'system' | 'inbound'  (BriefOrigin)
  mode:               text("mode").notNull(),          // 'edit' | 'generate'   (BriefMode)
  objective:          text("objective").notNull(),
  deliverable:        text("deliverable").notNull(),

  // The frozen CreativeBrief — the immutable record of exactly what was asked, including every
  // reference that went in. This is the lineage record for INPUTS; a generation_inputs join table
  // would only model the asset-shaped subset and need a second mechanism for the rest.
  brief:              jsonb("brief").notNull(),

  // edit mode only — the frame the output must stay pixel-continuous with.
  source_asset_id:    uuid("source_asset_id").references(() => mediaAssets.id),

  status:             text("status").notNull().default("pending"),
  last_error:         text("last_error"),

  // What it routed to and what it was QUOTED. cost_basis is carried, never recomputed, so an
  // estimate is never displayed as a billed figure (studio/preview.ts).
  provider:           text("provider"),
  model:              text("model"),
  cost_estimated_usd: numeric("cost_estimated_usd"),
  cost_basis:         text("cost_basis"),
  // What the provider's result said it cost, written ONCE at succeed (studio/jobs.ts succeedJob; PR 13,
  // migrations/0066_studio_plan_memory.sql). Null until then, and forever on a path with no figure in
  // hand (video). Never summed by the day cap — spentTodayUsd reads the quote above.
  cost_usd:           numeric("cost_usd"),

  // ─── The detached execution model (A6.1) ──────────────────────────────────────────────────────
  //
  // Only video uses these. An image job is generated INLINE inside the request and never queues, so
  // every column below stays NULL for it — which is also why they are all nullable and why the
  // indexes that read them are partial.
  //
  // WHY THEY LIVE HERE rather than in a queue table of their own: this row already carries the
  // athlete, the frozen brief, the route and the quoted cost, and studio/generate.ts + the job route
  // already read it. A second table would need its own tenancy predicate and its own join to say
  // anything useful, and the two could disagree about which job is running.

  /** Who is working this job right now, and until when. NULL ⇒ nobody holds it. */
  lease_until:        timestamp("lease_until", { withTimezone: true }),
  lease_holder:       text("lease_holder"),
  /** How many times this job has been claimed. Bounds reclaim loops — see studio/videoJobs.ts. */
  attempts:           integer("attempts").notNull().default(0),

  /**
   * THE SUBMIT-ONCE PAIR. This is the guard that makes a lease handoff free instead of double-billed.
   *
   * `submit_attempted_at` is written BEFORE the provider call; `provider_operation_name` AFTER it.
   * A runner that takes over a job only submits when BOTH are NULL — if the operation name is
   * present it resumes polling that operation instead, so the work already paid for is collected
   * rather than bought again.
   *
   * The pair (attempted, still no name) is the ORPHAN WINDOW: an instance that died between the two
   * writes may or may not have reached Vertex. That case FAILS CLOSED — never re-submitted — because
   * over-charging is the dangerous direction and a rare false failure is not.
   */
  submit_attempted_at:     timestamp("submit_attempted_at", { withTimezone: true }),
  provider_operation_name: text("provider_operation_name"),

  /** Poll bookkeeping. Observability only — nothing branches on either. */
  poll_count:         integer("poll_count").notNull().default(0),
  last_polled_at:     timestamp("last_polled_at", { withTimezone: true }),

  /** 0072: provenance, not authorization — the creative intent this job serves (nullable for history). */
  creative_intent_id: uuid("creative_intent_id"),
  /** 0073 (#570 §6): campaign fulfilment/audit lineage — which scope version and which unit of scope this job serves. */
  source_spec_id:     uuid("source_spec_id"),
  source_spec_version: integer("source_spec_version"),
  campaign_deliverable_id: uuid("campaign_deliverable_id"),

  created_at:         timestamp("created_at", { withTimezone: true }).defaultNow(),
  started_at:         timestamp("started_at", { withTimezone: true }),
  completed_at:       timestamp("completed_at", { withTimezone: true }),
  updated_at:         timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("generation_jobs_origin_check", sql`${table.origin} IN ('system','inbound','athlete')`),
  check("generation_jobs_mode_check",   sql`${table.mode} IN ('edit','generate')`),
  // `queued` = the approval is spent and the job is owed, but NO provider call has been made yet.
  // It is the state that lets POST /studio/generate return without blocking on a 60s+ video.
  check("generation_jobs_status_check", sql`${table.status} IN ('pending','queued','running','succeeded','failed','canceled')`),
  // The edit/generate fork, enforced by the database and not only by assembleBrief: an edit without
  // a frame to preserve is a re-render wearing the wrong label.
  check("generation_jobs_edit_needs_source", sql`
    (${table.mode} = 'edit' AND ${table.source_asset_id} IS NOT NULL) OR
    (${table.mode} = 'generate' AND ${table.source_asset_id} IS NULL)`),
  // Tenancy first: every read is "this athlete's jobs, newest first".
  index("idx_generation_jobs_athlete").on(table.athlete_id, table.created_at.desc()),
  // `queued` joins the partial predicate: without it a job that is owed but not yet started falls
  // out of the index that exists to find in-flight work.
  index("idx_generation_jobs_status").on(table.status, table.created_at)
    .where(sql`status IN ('pending','queued','running')`),
  index("idx_generation_jobs_source").on(table.source_asset_id).where(sql`source_asset_id IS NOT NULL`),
  // 0150: the platform-wide day total (server/lib/platformSpend.ts) sums every athlete's jobs since UTC midnight.
  index("idx_generation_jobs_created").on(table.created_at),
  // 0072: lineage to the creative intent a job serves (the migration has always created it; declared here so a push matches).
  index("idx_generation_jobs_creative_intent").on(table.creative_intent_id).where(sql`creative_intent_id IS NOT NULL`),
  // 0072's inline REFERENCES, under the name Postgres gave it on every deployed database (…_fkey).
  foreignKey({ name: "generation_jobs_creative_intent_id_fkey", columns: [table.creative_intent_id], foreignColumns: [creativeIntents.id] }).onDelete("set null"),

  // ONE PROVIDER OPERATION PER JOB, enforced by the database rather than only by the conditional
  // UPDATE in studio/videoJobs.ts. The application guard is the first layer; this is the one that
  // still holds against a bug, a script, or code not yet written. Partial because every image job —
  // the overwhelming majority of rows — leaves it NULL.
  uniqueIndex("idx_generation_jobs_operation").on(table.provider_operation_name)
    .where(sql`provider_operation_name IS NOT NULL`),
  // The claim query's index: queued rows, oldest first.
  index("idx_generation_jobs_claim").on(table.status, table.created_at).where(sql`status = 'queued'`),
  // The reaper's index: running rows whose lease has lapsed.
  index("idx_generation_jobs_lease").on(table.lease_until).where(sql`status = 'running'`),
]);

// The record of a pre-generation check the athlete was SHOWN, and of the spend it authorizes.
//
// WHY THIS TABLE EXISTS. Spend is gated on `preview.cost <= approvedCostUsd` (studio/concept.ts).
// Until U2 that ceiling was a bare function argument, which means that if a route ever reads it from
// a request body the client becomes the authority on what the athlete agreed to: a body carrying
// `approvedCostUsd: 999` authorizes a spend nobody ever saw. Note the direction — a LOW figure fails
// safe (the job is refused); an INFLATED one is the forgery that costs money.
//
// So the ceiling is not sent. It is READ BACK from this row, which is written by the preview the
// athlete actually looked at. The generate request carries `{ previewId }` and no number at all,
// and there is consequently nothing in the request to forge. The server re-assembles from the
// FROZEN `brief` below and re-derives the verdict and the cost fresh (studio/preview.ts is
// re-entrant and cheap — no network, no writes), then requires the fresh quote to be within the
// figure on this row. A brief that got more expensive between the two calls is refused rather than
// silently spending the difference.
//
// `consumed_at` IS THE IDEMPOTENCY MECHANISM, and it is why no lock is needed. Claiming a preview
// is one atomic guarded UPDATE (SET consumed_at WHERE consumed_at IS NULL), so a double-tapped
// Generate — or two requests landing on two of the three Cloud Run instances — resolves to exactly
// one winner. The loser reads `consumed_by_job_id` and returns THAT job, so both taps answer with
// the same jobId and only one generation is ever paid for. Contrast generation_jobs, where every
// call INSERTS a new row: two taps there are two jobs and two charges, which is precisely the hole
// this column closes.
//
// Rows are disposable history, not content: `expires_at` bounds how long an approval stays good, so
// a preview cannot be banked and spent against a much later, much dearer price list.
export const studioGenerationPreviews = pgTable("studio_generation_previews", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),

  // The FROZEN brief this preview was rendered from — the same jsonb generation_jobs carries, and
  // for the same reason. Generation re-assembles from THIS, never from the request, so the job that
  // runs is the job that was quoted.
  brief:              jsonb("brief").notNull(),
  // The resolved route as shown. Advisory: re-derived at generate time and not trusted from here.
  plan:               jsonb("plan"),

  // What she was SHOWN. `cost_basis` is carried, never recomputed — a preview can only ever hold an
  // estimate, so this must never be read as a billed figure (studio/preview.ts).
  cost_usd:           numeric("cost_usd"),
  cost_basis:         text("cost_basis"),
  // True ⇒ no price is configured for that model. Generation REFUSES rather than treating it as $0.
  unpriced:           boolean("unpriced").notNull().default(false),
  status:             text("status").notNull(),          // 'ready' | 'blocked' (PreviewStatus)

  consumed_at:        timestamp("consumed_at", { withTimezone: true }),
  consumed_by_job_id: uuid("consumed_by_job_id").references(() => generationJobs.id),

  created_at:         timestamp("created_at", { withTimezone: true }).defaultNow(),
  expires_at:         timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("studio_previews_status_check", sql`${table.status} IN ('ready','blocked')`),
  // Tenancy first, like generation_jobs: every read is "this athlete's previews, newest first".
  index("idx_studio_previews_athlete").on(table.athlete_id, table.created_at.desc()),
  // The sweep for expired, never-consumed rows.
  index("idx_studio_previews_expiry").on(table.expires_at).where(sql`consumed_at IS NULL`),
]);

// ── Studio sessions: the Create Anything thread (migrations/0054) ─────────────
// One thread and what was said in it, in order. server/studio/sessions.ts is the only writer and reader, behind
// STUDIO_SESSIONS (default off). See docs/plans/studio-sessions-plan-v2.md §2.
//
// WHAT IS NOT HERE, ON PURPOSE. No status column: a plan's state is DERIVED at read from the preview and job rows
// (the job row IS the status, and the only writer that knows "done" is the generate request, which this never
// touches). No output entry: the image is reached plan → preview → consumed_by_job_id → job → assets, so the spend
// path does zero writes here. No CHECK on `kind`: widening a CHECK is a DROP + ADD pair (chat_messages.source).
//
// TENANCY IS STRUCTURAL. `studio_sessions_id_athlete_uniq` exists so the composite FK below can point at it: an
// entry's (session_id, athlete_id) must name a session of THAT athlete, so no write can put a row in another
// athlete's thread, whatever the application does. Both tables cascade from athletes (ownership); nothing else
// cascades (plan v2 §5, tombstones).
//
// `payload` is jsonb and UNTYPED, like voice_context's: ids and closed codes only, never prose. Her words live in
// `text` (prompt entries only, ≤ 2000). The invariant lives in server/studio/sessions.ts and its tests.
//
// ⚠️ A FUTURE SWEEP OF studio_generation_previews must spare previews an entry references (`preview_id`), or accept
// the tombstone: ON DELETE SET NULL, and the thread says "That check is no longer available".
export const studioSessions = pgTable("studio_sessions", {
  // Normally client-minted, and claimed by the thread's first append — an abandoned thread leaves no row.
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  title:       text("title"),                                   // her first prompt, one line, ≤ 80
  archived_at: timestamp("archived_at", { withTimezone: true }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Bumped per append: the list's order, and which thread the door resumes.
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("studio_sessions_id_athlete_uniq").on(table.id, table.athlete_id),
  index("idx_studio_sessions_athlete_updated").on(table.athlete_id, table.updated_at.desc()),
]);

export const studioSessionEntries = pgTable("studio_session_entries", {
  // Client-minted, so a retried append is a no-op.
  id:         uuid("id").primaryKey().defaultRandom(),
  // Insertion order IS thread order: the client serialises appends per thread.
  seq:        bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  session_id: uuid("session_id").notNull(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  kind:       text("kind").notNull(),                            // 'prompt' | 'plan' | 'ask' (writer-enforced)
  text:       text("text"),                                      // prompt only
  payload:    jsonb("payload").notNull().default({}),            // ids + closed codes only
  // Plan only: the preview she was shown. SET NULL, never cascade — her words outlive a swept check.
  preview_id: uuid("preview_id").references(() => studioGenerationPreviews.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "studio_session_entries_session_fk",
    columns: [table.session_id, table.athlete_id],
    foreignColumns: [studioSessions.id, studioSessions.athlete_id],
  }).onDelete("cascade"),
  index("idx_studio_session_entries_session").on(table.session_id, table.seq),
  uniqueIndex("uq_studio_session_entries_preview").on(table.preview_id).where(sql`preview_id IS NOT NULL`),
]);

export type StudioSession      = typeof studioSessions.$inferSelect;
export type StudioSessionEntry = typeof studioSessionEntries.$inferSelect;

// ── Studio stitch jobs: assembling clips into one video (migrations/0057) ─────
//
// One row per STITCH — an ordered index of clips, joined by ffmpeg into a single file, with an
// optional music bed under it. The assembly UI (V7) queues one; a leased runner works it.
//
// ─── WHY THIS IS NOT A ROW IN generation_jobs ───────────────────────────────────────────────────
//
// It looks like one. It has an athlete, a frozen spec, a status, a lease and attempts, and the
// detached shape is copied from video generation deliberately. It is still a different table, and
// the reason is not tidiness:
//
//   1. THE VIDEO CLAIM HAS NO DISCRIMINATOR. studio/videoJobs.ts claimVideoJobs is
//      `UPDATE generation_jobs … WHERE status = 'queued' … FOR UPDATE SKIP LOCKED` and nothing
//      else. A queued stitch row in that table is claimed by the VIDEO runner and handed to
//      submitVideoOperation — a paid Vertex call carrying a brief that does not exist. Sharing the
//      table would mean maintaining an exclusion inside the money path's claim query, where a
//      missed filter spends money.
//   2. THE REAPER WOULD LIE. reapExpiredLeases fails a lapsed row with "we can't tell whether the
//      provider started… that could charge twice", and keeps provider_operation_name on the
//      back-edge so the next runner resumes work already paid for. Every clause of that is false
//      for a stitch.
//   3. THE TWO NEED OPPOSITE REAPERS. A video job is NOT re-runnable — the submit-once pair exists
//      because a second submit buys a second clip. A stitch is IDEMPOTENTLY RETRYABLE: re-running
//      costs ffmpeg CPU and nothing else. So there is no orphan window here and no fail-closed
//      posture; a lapsed lease simply goes back to the queue.
//   4. FIVE NOT NULL COLUMNS HAVE NO HONEST VALUE. generation_jobs requires origin, mode,
//      objective, deliverable and the frozen brief, and a CHECK ties mode to source_asset_id. A
//      stitch has many sources and no brief. Sharing means writing fabricated values that
//      studio/sessions.ts and studio/content.ts would then read back as real.
//
// ⚠️  THE SEVEN ABSENT COLUMNS ARE THE DESIGN. There is no provider, no model, no
// cost_estimated_usd, no cost_basis, no submit_attempted_at, no provider_operation_name and no
// poll_count. A stitch spends nothing, so this table is structurally incapable of opening a spend
// surface — and spentTodayUsd (studio/jobs.ts), which sums generation_jobs.cost_estimated_usd,
// cannot be moved by anything here. It is also NOT behind STUDIO_VIDEO_ENABLED: that flag guards
// exactly one seam (studio/generate.ts, task === "video.generate"), and assembly works with
// generation still dark.
//
// ─── THE OUTPUT POINTER GOES THE OTHER WAY ──────────────────────────────────────────────────────
//
// media_assets.generation_job_id carries a real FK to generation_jobs (studio/sql/generationGuards.sql),
// so a stitched asset cannot use it — and must not, since it was not generated by a provider. A
// generation is one job → MANY assets, which is why its pointer lives on the asset side. A stitch
// is one job → exactly ONE file, so the pointer lives here. Cardinality, not workaround.
//
// The asset still lands on the Made shelf with no change to studio/content.ts: that query LEFT
// JOINs generation_jobs and filters on origin='generated' AND status='stored', so a stitched asset
// with a NULL generation_job_id appears, with a null brand.
export const studioStitchJobs = pgTable("studio_stitch_jobs", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),

  // THE FROZEN TIMELINE: { clips: [{ assetId, trimStartSec?, trimEndSec?, transitionIn? }], bed?, target }.
  // ASSET IDS, NEVER PATHS. The runner resolves each id against athlete_id at claim time, so a
  // client-supplied path is never stored and never reaches ffmpeg — a path in a job row would be a
  // durable file-read primitive. Frozen for the same reason generation_jobs.brief is: the stitch
  // that runs is the stitch that was asked for, even if the library changes underneath it.
  spec:            jsonb("spec").notNull(),

  // Born 'queued' — there is no inline path for a stitch, so 'pending' has no meaning here.
  status:          text("status").notNull().default("queued"),
  last_error:      text("last_error"),

  // ─── The lease. Same mechanism as video (0056), different failure posture ────────────────────
  // Who holds this job and until when; NULL ⇒ nobody. `attempts` bounds reclaim loops. There is
  // deliberately no submit-once pair: see (3) above.
  lease_until:     timestamp("lease_until", { withTimezone: true }),
  lease_holder:    text("lease_holder"),
  attempts:        integer("attempts").notNull().default(0),

  /** The single file this job produced. SET NULL, never cascade — a swept asset must not delete the record of the run. */
  output_asset_id: uuid("output_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),

  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  started_at:      timestamp("started_at", { withTimezone: true }),
  completed_at:    timestamp("completed_at", { withTimezone: true }),
  updated_at:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // No 'pending': a stitch is queued the moment it is asked for.
  check("studio_stitch_jobs_status_check", sql`${table.status} IN ('queued','running','succeeded','failed','canceled')`),
  // Tenancy first: every read is "this athlete's stitches, newest first".
  index("idx_studio_stitch_jobs_athlete").on(table.athlete_id, table.created_at.desc()),
  // The claim query's index: queued rows, oldest first.
  index("idx_studio_stitch_jobs_claim").on(table.status, table.created_at).where(sql`status = 'queued'`),
  // The reaper's index: running rows whose lease has lapsed.
  index("idx_studio_stitch_jobs_lease").on(table.lease_until).where(sql`status = 'running'`),
]);

export type StudioStitchJob = typeof studioStitchJobs.$inferSelect;

// ── Studio publish jobs: posting a finished video to her own account (migrations/0059) ─────
//
// One row per time she pressed "post". THIS IS THE QUEUE; content_posts stays the record of a post
// that exists. A row here that never posted writes nothing there.
//
// ─── IT LOOKS LIKE studio_stitch_jobs AND MUST NOT BEHAVE LIKE IT ───────────────────────────────
//
// The lease columns are 0057's. The failure posture is 0056's, and the difference is the design:
//
//   a stitch is IDEMPOTENTLY RETRYABLE — re-running costs ffmpeg CPU, so its reaper requeues a
//   lapsed job ALWAYS. Copy that here and an instance that dies between Instagram accepting the
//   publish and us writing the handle is requeued, and the next runner POSTS THE SAME VIDEO TO HER
//   REAL ACCOUNT A SECOND TIME. Nothing about that is recoverable: a post is public the moment it
//   exists, and deleting it is a thing her followers watch happen.
//
// So this table carries video's submit-once pair under its own names, and the rule the runner holds
// is stronger than video's: THE PUBLISH CALL IS MADE AT MOST ONCE PER ROW, EVER.
//
//   publish_attempted_at   written BEFORE the publish call
//   ig_media_id            written AFTER it
//
// (attempted, no media id) is the orphan window. Unlike a Veo submit we are not blind inside it —
// the container can be READ, and Instagram moves it to PUBLISHED when the post exists — so the
// runner reads, and succeeds the job if it posted. If it cannot tell, the job FAILS CLOSED with
// "this may have posted — check Instagram" and is never re-sent. Her retry is her own tap, which is
// a new row and a new decision. See studio/publish/jobs.ts.
//
// CREATING A CONTAINER NEEDS NO SUCH PAIR, deliberately. A container is an upload, not a post: one
// that is never published is invisible to everyone and expires by itself in 24 hours. A crash
// between creating it and storing `container_id` costs one orphaned upload. What `container_id`
// buys is the other direction — a runner that finds one RESUMES it instead of starting again, so a
// handoff does not make Instagram fetch the whole file a second time.
//
// ─── WHAT IS FROZEN AT THE TAP ──────────────────────────────────────────────────────────────────
//
// `connected_account_id` and `mode` are both written by the route and never re-derived by the
// runner. The account, because the confirm step told her "this posts to @handle now" and an athlete
// may hold more than one Instagram row — the account she confirmed is the account that posts.
// The mode, because a row queued while STUDIO_PUBLISH_MODE=dry must never go out for real because
// the variable was flipped while it waited: a live send needs the ROW to say live AND the process
// to say live. Two keys, and either one alone posts nothing.
//
// ─── WHY TWO FOREIGN KEYS ARE NULLABLE ──────────────────────────────────────────────────────────
//
// SET NULL, never cascade, and that needs a nullable column. "We posted this to her Instagram" has
// to outlive both the asset being swept and the account being disconnected — it is the only record
// on our side that a public post came from here. The route always writes both; a runner that claims
// a row with either one gone fails it with a plain sentence.
//
// NO CHECK ON `platform`, on purpose. It is the one vocabulary here that will certainly grow, and
// widening a CHECK is the DROP + ADD pair 0056 documents as two production outages. The route
// accepts a closed list and the runner refuses a platform it has no publisher for.
export const studioPublishJobs = pgTable("studio_publish_jobs", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),

  /** The video being posted. An id, never a path — the runner resolves it against athlete_id at claim time. */
  asset_id:             uuid("asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
  /** THE ACCOUNT SHE CONFIRMED. Pinned by the route; the runner never picks one. */
  connected_account_id: uuid("connected_account_id"),

  platform:             text("platform").notNull(),   // 'instagram' today; closed list in the route
  caption:              text("caption").notNull().default(""),
  /** 'dry' | 'live', frozen from STUDIO_PUBLISH_MODE at the tap. A dry row can never be sent. */
  mode:                 text("mode").notNull(),

  status:               text("status").notNull().default("queued"),
  last_error:           text("last_error"),
  /** A closed code beside the sentence, so the client can offer the right next step (reconnect, put it together again). */
  error_code:           text("error_code"),

  // ─── The resume handle. Not a guard — see the header ──────────────────────────────────────────
  container_id:         text("container_id"),
  container_created_at: timestamp("container_created_at", { withTimezone: true }),
  poll_count:           integer("poll_count").notNull().default(0),

  // ─── THE SUBMIT-ONCE PAIR. The order of these two writes is the whole guarantee ───────────────
  publish_attempted_at: timestamp("publish_attempted_at", { withTimezone: true }),
  ig_media_id:          text("ig_media_id"),
  permalink:            text("permalink"),

  // ─── The lease. Same mechanism as 0056/0057 ───────────────────────────────────────────────────
  lease_until:          timestamp("lease_until", { withTimezone: true }),
  lease_holder:         text("lease_holder"),
  attempts:             integer("attempts").notNull().default(0),

  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  started_at:           timestamp("started_at", { withTimezone: true }),
  completed_at:         timestamp("completed_at", { withTimezone: true }),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Named by hand: drizzle's generated name for this one is 65 characters and Postgres would
  // silently truncate it to 63, which is drift nobody chose.
  foreignKey({
    name: "studio_publish_jobs_connected_account_fk",
    columns: [table.connected_account_id],
    foreignColumns: [connectedAccounts.id],
  }).onDelete("set null"),
  check("studio_publish_jobs_status_check", sql`${table.status} IN ('queued','running','succeeded','failed','canceled')`),
  check("studio_publish_jobs_mode_check", sql`${table.mode} IN ('dry','live')`),
  // Tenancy first: every read is "this athlete's posts, newest first".
  index("idx_studio_publish_jobs_athlete").on(table.athlete_id, table.created_at.desc()),
  // The claim query's index: queued rows, oldest first.
  index("idx_studio_publish_jobs_claim").on(table.status, table.created_at).where(sql`status = 'queued'`),
  // The reaper's index: running rows whose lease has lapsed.
  index("idx_studio_publish_jobs_lease").on(table.lease_until).where(sql`status = 'running'`),
  // THE DOUBLE-TAP GUARD. One live job per video per platform: two taps are one post, enforced
  // where a race between two requests cannot get past it. A finished row does not hold the slot,
  // so posting the same video again later stays possible and stays her decision.
  uniqueIndex("uq_studio_publish_jobs_live").on(table.asset_id, table.platform)
    .where(sql`status IN ('queued','running')`),
]);

export type StudioPublishJob = typeof studioPublishJobs.$inferSelect;

// ─── Studio brand profiles, and the reference analyses under them (migration 0060) ──────────────
//
// Spec: docs/specs/creative-architecture.md §5–§7. A brand profile is HERS: athlete-scoped, because
// inbox_brands is global and a profile built from one athlete's screenshots must never steer another
// athlete's generations for that brand. A "reference set" is the analyses sharing a
// brand_profile_id; there is no set table.
//
// An analysis can only hang under a profile OF THE SAME ATHLETE. The composite FK
// (brand_profile_id, athlete_id) → (id, athlete_id) is what holds that, so a bug in code cannot
// file one athlete's reference under another's brand. Analyses are immutable: a re-analysis is a
// new row. Their cost is recorded here and does NOT count toward the day cap (spentTodayUsd sums
// generation_jobs only), as with the interpreter's and creative QA's vision calls.
//
// NO CHECK on source_kind or role, on purpose: both vocabularies will grow, and widening a CHECK
// is the DROP + ADD pair 0056 documents as two outages. The closed lists live in
// server/studio/reference/.
export const studioBrandProfiles = pgTable("studio_brand_profiles", {
  id:         uuid("id").primaryKey().defaultRandom(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  /** The catalog brand, when there is one. SET NULL: her profile outlives a catalog merge. */
  brand_id:   integer("brand_id").references(() => inboxBrands.id, { onDelete: "set null" }),
  name:       text("name").notNull(),
  /** Spec §5 brand.brand_attributes — short words ("premium", "athletic"). */
  attributes: jsonb("attributes").$type<string[]>().notNull().default([]),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // The target of the analyses' composite FK — what lets the database refuse a cross-athlete filing.
  unique("studio_brand_profiles_id_athlete_unique").on(table.id, table.athlete_id),
  // Tenancy first: every read is "her profiles, newest first".
  index("idx_studio_brand_profiles_athlete").on(table.athlete_id, table.created_at.desc()),
  // One profile per catalog brand, per athlete. A brand-less profile is not held to it.
  uniqueIndex("uq_studio_brand_profiles_brand").on(table.athlete_id, table.brand_id)
    .where(sql`brand_id IS NOT NULL`),
]);

export type StudioBrandProfile = typeof studioBrandProfiles.$inferSelect;

export const studioReferenceAnalyses = pgTable("studio_reference_analyses", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  /** Nullable: "something like this" can be decomposed without filing it under a brand. */
  brand_profile_id:   uuid("brand_profile_id"),

  source_kind:        text("source_kind").notNull(),   // 'image' | 'brief'; closed list in code
  /** Exactly one of these two (CHECK). An id, never a path. CASCADE: her photo gone, its reading goes. */
  source_asset_id:    uuid("source_asset_id").references(() => mediaAssets.id, { onDelete: "cascade" }),
  source_text:        text("source_text"),

  role:               text("role").notNull(),          // spec §6: 'style_reference' | 'composition_reference'
  /** The §7 decomposition, as server/studio/reference/schema.ts validated it. */
  decomposition:      jsonb("decomposition").notNull(),

  prompt_version:     text("prompt_version").notNull(),
  model:              text("model").notNull(),
  cost_estimated_usd: numeric("cost_estimated_usd"),
  cost_basis:         text("cost_basis"),

  created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "studio_reference_analyses_profile_fk",
    columns: [table.brand_profile_id, table.athlete_id],
    foreignColumns: [studioBrandProfiles.id, studioBrandProfiles.athlete_id],
  }).onDelete("cascade"),
  check("studio_reference_analyses_one_source_check", sql`num_nonnulls(${table.source_asset_id}, ${table.source_text}) = 1`),
  // Tenancy first: "her analyses, newest first".
  index("idx_studio_reference_analyses_athlete").on(table.athlete_id, table.created_at.desc()),
  // A profile's set, and the index the profile cascade walks.
  index("idx_studio_reference_analyses_profile").on(table.brand_profile_id),
]);

export type StudioReferenceAnalysis = typeof studioReferenceAnalyses.$inferSelect;

// A plan is a stored, versioned object (Studio PR 6, 6a3; migrations/0061_studio_plans.sql). A
// regenerate writes a CHILD row (version + 1, parent_plan_id); rows are never edited. The parent FK is
// composite, (parent_plan_id, athlete_id) → (id, athlete_id), so a child can only descend from a plan
// of the SAME athlete. NO ACTION on it: Drizzle cannot declare SET NULL (column), and a bare SET NULL
// on this key would null athlete_id — see the migration header. jsonb shapes are validated in code.
export const studioPlans = pgTable("studio_plans", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  /** The row this one was regenerated from, or null for a first plan. */
  parent_plan_id:      uuid("parent_plan_id"),
  /** 1 for a first plan; the parent's + 1 for a regenerate. */
  version:             integer("version").notNull().default(1),
  /** The CampaignBrief it was planned from (server/studio/campaign/brief.ts), or null. */
  brief:               jsonb("brief"),
  /** Her uploaded brief, under studio-briefs/<athleteId>/ — PR 7 reads it. Or null. */
  brief_file_path:     text("brief_file_path"),
  /** The concept she picked (lane 6c), or null. */
  concept:             jsonb("concept"),
  /** The plan as the route answered it: items with their reasons, gaps, look, music. */
  plan:                jsonb("plan").notNull(),
  /** The deal deliverable this plan is for, or null. SET NULL: her plan outlives the deal row. */
  deal_deliverable_id: uuid("deal_deliverable_id").references(() => dealDeliverables.id, { onDelete: "set null" }),
  // What it was planned FROM (PR 13; migrations/0066_studio_plan_memory.sql) — written once, at
  // savePlan, so a regenerate can start from her own words. All null on a pre-0066 row: no backfill,
  // and such a row is re-planned from its brief exactly as before.
  /** Her words, as the route validated them. */
  prompt:              text("prompt"),
  /** Her feel line, or null when she gave none. */
  aesthetic:           text("aesthetic"),
  /** The purpose the plan was made for — one of the route's OBJECTIVES. */
  objective:           text("objective"),
  /** The confirm step's flags (studio/direction/envelope.ts InferenceFlag[]), or null without a brief. */
  confirm:             jsonb("confirm"),
  /** 0072: provenance, not authorization — the creative intent this plan interprets (nullable for history). */
  creative_intent_id:  uuid("creative_intent_id"),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // The target of the parent FK — what lets the database refuse a cross-athlete lineage.
  unique("studio_plans_id_athlete_unique").on(table.id, table.athlete_id),
  foreignKey({
    name: "studio_plans_parent_fk",
    columns: [table.parent_plan_id, table.athlete_id],
    foreignColumns: [table.id, table.athlete_id],
  }),
  // Tenancy first: every read is "her plans, newest first".
  index("idx_studio_plans_athlete_created").on(table.athlete_id, table.created_at.desc()),
  // A plan's children — partial: a first plan has no parent to look up.
  index("studio_plans_parent_idx").on(table.parent_plan_id).where(sql`parent_plan_id IS NOT NULL`),
  // 0072: lineage to the creative intent a plan serves (the migration has always created it; declared here so a push matches).
  index("idx_studio_plans_creative_intent").on(table.creative_intent_id).where(sql`creative_intent_id IS NOT NULL`),
  // 0072's inline REFERENCES, under the name Postgres gave it on every deployed database (…_fkey).
  foreignKey({ name: "studio_plans_creative_intent_id_fkey", columns: [table.creative_intent_id], foreignColumns: [creativeIntents.id] }).onDelete("set null"),
]);

export type StudioPlan = typeof studioPlans.$inferSelect;

// An edit's result is held as a PREVIEW, never as a library row, until she accepts it (Studio PR 9,
// Lane 1; migrations/0063_studio_edit_previews.sql). One row per typed op on one of her photos: the
// op and its params, the quote it was priced under, the job that ran it, where the result bytes sit
// while she decides (under studio/edit-previews/, not her library), and the one media_assets row
// accept wrote. `status` is the whole story: quoted → running → ready → accepted | discarded, or
// failed. `batch_id` groups the candidates one quote bought from one source (the ad carousel).
export const STUDIO_EDIT_OPS = ["recolour", "garment", "product", "background_clean", "ad"] as const;
export type StudioEditOp = (typeof STUDIO_EDIT_OPS)[number];
export const STUDIO_EDIT_PREVIEW_STATUSES = ["quoted", "running", "ready", "accepted", "discarded", "failed"] as const;
export type StudioEditPreviewStatus = (typeof STUDIO_EDIT_PREVIEW_STATUSES)[number];

export const studioEditPreviews = pgTable("studio_edit_previews", {
  id:                uuid("id").primaryKey().defaultRandom(),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  /** The photo the op transforms. Hers (herPhoto), verified before the quote. */
  source_asset_id:   uuid("source_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  /** The typed op — one of STUDIO_EDIT_OPS; a sixth is a migration, on purpose. */
  op:                text("op").notNull(),
  /** The op's params, validated in code per op (server/studio/edit/ops.ts). */
  params:            jsonb("params").notNull().default({}),
  /** The candidates one quote bought from one source (Lane 4), or null for a single edit. */
  batch_id:          uuid("batch_id"),
  /** The quote this row was priced under, or null once that row is gone. FK named by hand below: the generated name is over 63 chars. */
  preview_id:        uuid("preview_id"),
  /** The generation job that ran it, or null before the run / once the job row is gone. */
  job_id:            uuid("job_id").references(() => generationJobs.id, { onDelete: "set null" }),
  status:            text("status").notNull().default("quoted"),
  /** The result bytes, under athletes/<id>/studio/edit-previews/ — NEVER a library path. */
  gcs_path:          text("gcs_path"),
  content_type:      text("content_type"),
  bytes:             integer("bytes"),
  width:             integer("width"),
  height:            integer("height"),
  cost_quoted_usd:   numeric("cost_quoted_usd"),
  cost_usd:          numeric("cost_usd"),
  /** The media_assets row accept wrote, or null. */
  accepted_asset_id: uuid("accepted_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
  error:             text("error"),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ran_at:            timestamp("ran_at", { withTimezone: true }),
  decided_at:        timestamp("decided_at", { withTimezone: true }),
  expires_at:        timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  // Named by hand: "studio_edit_previews_preview_id_studio_generation_previews_id_fk" is 65 chars, which
  // Postgres would truncate to 63 — and a truncated name is one the parity test cannot match.
  foreignKey({
    name: "studio_edit_previews_preview_fk",
    columns: [table.preview_id],
    foreignColumns: [studioGenerationPreviews.id],
  }).onDelete("set null"),
  check("studio_edit_previews_op_check", sql`${table.op} IN ('recolour', 'garment', 'product', 'background_clean', 'ad')`),
  check("studio_edit_previews_status_check", sql`${table.status} IN ('quoted', 'running', 'ready', 'accepted', 'discarded', 'failed')`),
  // Tenancy first: every read is "her edit previews, newest first".
  index("idx_studio_edit_previews_athlete_created").on(table.athlete_id, table.created_at.desc()),
  // A batch's candidates — partial: a single edit has no batch to look up.
  index("studio_edit_previews_batch_idx").on(table.batch_id).where(sql`batch_id IS NOT NULL`),
]);

export type StudioEditPreview = typeof studioEditPreviews.$inferSelect;

// The athlete's EDITS to a Nomi Card (docs/media-kit-specs.md Spec 8 — the editor). A thin overrides
// layer applied at SERVE time over the regenerable base kit: order / removed / added cards, chosen
// copy alternates (or custom text), and image swaps. Keyed per athlete × brand (0 = generic), same
// as media_kits. The base kit stays fully regenerable — edits never mutate the source.
export const cardOverrides = pgTable("card_overrides", {
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  brand_id:   integer("brand_id").notNull().default(0),
  data:       jsonb("data").notNull(),   // CardOverrides (see mediaKitService)
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.brand_id] }),
]);

// A SHARE of a Nomi Card (docs/media-kit-specs.md Spec 6). Decouples "how it's sent" from the
// canonical kit: mode=live renders the current cached kit; mode=snapshot freezes a copy here.
// scope/gate control forwarding + email capture; recipient_token makes a per-recipient tracked link.
export const cardShares = pgTable("card_shares", {
  id:               text("id").primaryKey(),                     // opaque shareId → /c/<id>
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  mode:             text("mode").notNull().default("live"),      // 'live' | 'snapshot'
  snapshot_data:    jsonb("snapshot_data"),                      // frozen MediaKitData (PATH form) if snapshot
  snapshot_version: text("snapshot_version"),
  // An EXTERNAL / hand-built deck served verbatim at /c/<id> (not a MediaKitData kit) — lets a
  // bespoke HTML deck live inside the share system so it gets the same open/dwell/forward tracking.
  custom_html:      text("custom_html"),
  tailoring:        text("tailoring").notNull().default("generic"), // 'generic' | 'brand'
  brand_id:         text("brand_id"),
  deal_id:          text("deal_id"),
  scope:            text("scope").notNull().default("public"),   // 'public' | 'recipient'
  gate:             text("gate").notNull().default("none"),      // 'none' | 'email'
  recipient_name:   text("recipient_name"),
  recipient_email:  text("recipient_email"),
  recipient_token:  text("recipient_token"),                     // per-recipient link token (?t=)
  label:            text("label"),
  expires_at:       timestamp("expires_at", { withTimezone: true }),
  revoked:          boolean("revoked").notNull().default(false),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_card_shares_athlete").on(table.athlete_id, table.created_at.desc()),
]);

// One view of a shared card — the analytics event stream (opens, dwell, forwards).
export const cardShareViews = pgTable("card_share_views", {
  id:           uuid("id").primaryKey().defaultRandom(),
  share_id:     text("share_id").notNull().references(() => cardShares.id, { onDelete: "cascade" }),
  viewer_token: text("viewer_token"),
  viewer_email: text("viewer_email"),
  is_forward:   boolean("is_forward").notNull().default(false),  // opened without the recipient token
  dwell_ms:     integer("dwell_ms"),
  opened_at:    timestamp("opened_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_card_share_views_share").on(table.share_id, table.opened_at.desc()),
]);

// ─── Payments: brand commission engine ───────────────────────────────────────
// See docs/plans/payments-commission-engine.md. Money is INTEGER CENTS.
// This is a per-deal commission engine, not a paywall — athletes.plan is unused here.

// Athlete payout accounts (Stripe Connect). 1:1 with athletes. Payout is hard-gated
// on payouts_enabled + the transfers capability — never pay out before onboarding.
export const connectAccounts = pgTable("connect_accounts", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id).unique(),
  stripe_account_id:  text("stripe_account_id").notNull().unique(),
  // Which connected-account API this row was created with: 'v2_recipient' (Accounts v2)
  // or 'classic' (express/custom fallback). SCT works on either (plan §2.5 / §14.4).
  account_kind:       text("account_kind").notNull().default("classic"),
  details_submitted:  boolean("details_submitted").notNull().default(false),
  charges_enabled:    boolean("charges_enabled").notNull().default(false),
  payouts_enabled:    boolean("payouts_enabled").notNull().default(false),
  transfers_active:   boolean("transfers_active").notNull().default(false), // the stripe_transfers capability
  requirements_due:   jsonb("requirements_due"),
  created_at:         timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at:         timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("connect_accounts_kind_check", sql`${table.account_kind} IN ('v2_recipient','classic')`),
]);

// One row per money-movement attempt, tied to exactly ONE subject (payments_subject_check):
//   'deposit'         seriousness auth-hold on a deal (manual capture, card-only), released on accept/decline.
//   'deal_payment'    deal escrow: captured to the platform balance, transferred to the athlete on delivery.
//   'booking_payment' a paid booking (0098, Bookings v2): the buyer pays her price + the Nomila service fee,
//                     captured to the platform balance and transferred to her (100% of her price) on release.
// For a booking the deal-named amount columns are reused, not renamed underneath live money:
//   deal_value_cents = her price (what she receives) · commission_cents = the buyer's service fee ·
//   processing_fee_cents = Stripe's ESTIMATED fee (absorbed by Nomila, informational) ·
//   brand_total_cents = what the buyer was charged · brand_email stays NULL (the buyer lives on bookings).
// Deal code narrows with assertDealPayment() (server/services/payments/dealPayment.ts).
export const payments = pgTable("payments", {
  id:                         uuid("id").primaryKey().defaultRandom(),
  deal_id:                    uuid("deal_id").references(() => deals.id),     // NULL only for booking_payment
  // NO cascade: payments is the ledger. One payment per booking (uq_payments_booking).
  booking_id:                 uuid("booking_id").references((): AnyPgColumn => bookings.id),
  athlete_id:                 uuid("athlete_id").notNull().references(() => athletes.id),
  kind:                       text("kind").notNull(),                         // deposit | deal_payment | booking_payment
  rail:                       text("rail"),                                   // card | bank (null until known)
  status:                     text("status").notNull().default("pending"),
  // Amounts (INTEGER CENTS). For a deposit, brand_total_cents is the hold amount.
  deal_value_cents:           integer("deal_value_cents"),                    // what the athlete receives (deal_payment)
  commission_cents:           integer("commission_cents"),
  processing_fee_cents:       integer("processing_fee_cents"),
  brand_total_cents:          integer("brand_total_cents"),                   // what the brand is charged
  currency:                   text("currency").notNull().default("usd"),
  // Stripe object ids
  stripe_payment_intent_id:   text("stripe_payment_intent_id").unique(),
  stripe_checkout_session_id: text("stripe_checkout_session_id"),
  checkout_expires_at:        timestamp("checkout_expires_at", { withTimezone: true }), // when that Checkout session lapses (0095): one live session per payment
  stripe_charge_id:          text("stripe_charge_id"),
  stripe_transfer_id:         text("stripe_transfer_id"),
  stripe_refund_id:           text("stripe_refund_id"),
  destination_account_id:     text("destination_account_id"),                // athlete's Connect account (payee)
  brand_email:                text("brand_email"),                           // captured at Checkout (account-less brand)
  // SHA-256 of the brand-only delivery-confirmation token (0097). The token is emailed to brand_email when the
  // athlete marks delivered and is never stored or returned to her; only this hash is kept (brandToken.ts).
  brand_confirm_token_hash:   text("brand_confirm_token_hash"),
  // Refunds / chargebacks / transfer reversals (0098). A refund is a payment action: only a human tap (the athlete
  // before release, an admin any time) or Stripe itself (dashboard refund, chargeback) writes these.
  refunded_cents:              integer("refunded_cents"),                     // total refunded to the brand (charge.amount_refunded)
  refunded_at:                 timestamp("refunded_at", { withTimezone: true }),
  refund_reason:               text("refund_reason"),
  refund_requested_by:         text("refund_requested_by"),                   // athlete | admin | stripe
  stripe_transfer_reversal_id: text("stripe_transfer_reversal_id"),           // money pulled back from the athlete after release
  stripe_dispute_id:           text("stripe_dispute_id"),                     // a card-network chargeback (not the brand's delivery dispute)
  dispute_status:              text("dispute_status"),                        // Stripe's dispute.status, mirrored
  // Deposit lifecycle bookkeeping (day-6 re-auth + 14-day window)
  reauth_count:               integer("reauth_count").notNull().default(0),
  reauth_at:                  timestamp("reauth_at", { withTimezone: true }),
  expires_at:                 timestamp("expires_at", { withTimezone: true }),
  // Delivery confirmation (deal_payment) — dual confirm gates the transfer (§7); the
  // window auto-releases to the athlete if the brand goes silent.
  athlete_confirmed_at:       timestamp("athlete_confirmed_at", { withTimezone: true }),
  brand_confirmed_at:         timestamp("brand_confirmed_at", { withTimezone: true }),
  delivery_window_ends_at:    timestamp("delivery_window_ends_at", { withTimezone: true }),
  failure_reason:             text("failure_reason"),
  metadata:                   jsonb("metadata"),
  /**
   * Which scheduled installment this payment settles. Nullable, and unused until escrow is
   * reworked — requestDealPayment currently looks up payments by deal_id LIMIT 1, so a
   * second installment would collide with the first. The column lands now so the migration
   * does not have to happen underneath live money later.
   *
   * SET NULL, never cascade: payments is the ledger, and editing a schedule must never take
   * a money record with it.
   */
  installment_id:             uuid("installment_id").references(() => dealInstallments.id, { onDelete: "set null" }),
  // Serious offer (0103): a 'deposit' hold placed from a public partner request BEFORE the request is confirmed (no
  // deal yet). deal_id is filled when she gets the request. NO cascade: payments is the ledger.
  partner_request_id:         uuid("partner_request_id").references((): AnyPgColumn => partnerRequests.id),
  // On a deal_payment: the captured Serious-offer hold credited against this (first) payment — the brand is charged
  // that much less, and settlement pays her the credited part from the hold's own charge.
  credit_cents:               integer("credit_cents"),
  credit_payment_id:          uuid("credit_payment_id").references((): AnyPgColumn => payments.id),
  created_at:                 timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at:                 timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_payments_installment").on(table.installment_id),
  check("payments_kind_check",   sql`${table.kind} IN ('deposit','deal_payment','booking_payment')`),
  check("payments_subject_check", sql`(${table.kind} = 'booking_payment' AND ${table.booking_id} IS NOT NULL AND ${table.deal_id} IS NULL AND ${table.partner_request_id} IS NULL) OR (${table.kind} = 'deal_payment' AND ${table.deal_id} IS NOT NULL AND ${table.booking_id} IS NULL AND ${table.partner_request_id} IS NULL) OR (${table.kind} = 'deposit' AND ${table.booking_id} IS NULL AND (${table.deal_id} IS NOT NULL OR ${table.partner_request_id} IS NOT NULL))`),
  uniqueIndex("uq_payments_booking").on(table.booking_id).where(sql`booking_id IS NOT NULL`),
  uniqueIndex("uq_payments_partner_request").on(table.partner_request_id).where(sql`partner_request_id IS NOT NULL`),
  check("payments_credit_check", sql`(${table.credit_cents} IS NULL AND ${table.credit_payment_id} IS NULL) OR (${table.kind} = 'deal_payment' AND ${table.credit_cents} > 0 AND ${table.credit_payment_id} IS NOT NULL)`),
  check("payments_rail_check",   sql`${table.rail} IS NULL OR ${table.rail} IN ('card','bank')`),
  check("payments_status_check", sql`${table.status} IN ('pending','requires_action','authorized','reauthorized','funded','settled','released','expired','refunded','canceled','failed','disputed','charged_back')`),
  index("idx_payments_deal").on(table.deal_id),
  index("idx_payments_athlete").on(table.athlete_id),
]);

// Stripe webhook idempotency + audit ledger. id = the Stripe event id; a duplicate
// delivery is a no-op (insert-or-ignore claims the event before processing).
export const paymentEvents = pgTable("payment_events", {
  id:           text("id").primaryKey(),           // Stripe event id (evt_...)
  type:         text("type").notNull(),
  payload:      jsonb("payload"),
  received_at:  timestamp("received_at", { withTimezone: true }).defaultNow(),
  processed_at: timestamp("processed_at", { withTimezone: true }),
});

// De-identified financial ledger (0087). When an athlete deletes her account, each of her payments in which money
// moved or was held leaves ONE row here and the payment itself is deleted (server/lib/privacy/financialRecords.ts).
// Amounts, currency, status and the Stripe ids an accountant reconciles against Stripe (the system of record) —
// nothing that names her, her deal, the brand or her Connect account, and no foreign keys. Kept for the
// financial_record retention period (FINANCIAL_RECORD_RETENTION_DAYS, TBD pending counsel/accountant), then purged
// by server/scripts/privacy/purgeExpiredFinancialRecords.ts.
export const financialLedgerRecords = pgTable("financial_ledger_records", {
  id:                       uuid("id").primaryKey().defaultRandom(),
  kind:                     text("kind").notNull(),                       // deposit | deal_payment
  status:                   text("status").notNull(),                     // the payment's status when it was de-identified
  deal_value_cents:         integer("deal_value_cents"),
  commission_cents:         integer("commission_cents"),
  processing_fee_cents:     integer("processing_fee_cents"),
  brand_total_cents:        integer("brand_total_cents"),
  currency:                 text("currency").notNull(),
  stripe_payment_intent_id: text("stripe_payment_intent_id"),
  stripe_charge_id:         text("stripe_charge_id"),
  stripe_transfer_id:       text("stripe_transfer_id"),
  stripe_refund_id:         text("stripe_refund_id"),
  // 0098: refunds, chargebacks and transfer reversals carried onto the ledger (amounts + Stripe ids only).
  refunded_cents:              integer("refunded_cents"),
  stripe_transfer_reversal_id: text("stripe_transfer_reversal_id"),
  stripe_dispute_id:           text("stripe_dispute_id"),
  payment_created_at:       timestamp("payment_created_at", { withTimezone: true }),
  deidentified_at:          timestamp("deidentified_at", { withTimezone: true }).notNull().defaultNow(),
  retention_category:       text("retention_category").notNull().default("financial_record"),
});

// ─── Bookings v2 (0099): paid bookings sold from her public card ──────────────────────────────────────────────
// Everything here is dark behind BOOKINGS_ENABLED (off). She sets her price and receives 100% of it; the BUYER pays
// ONE Nomila service fee on top (15% of her price + the card-processing pass-through, v2.1), shown all-in before checkout (quoteBookingCharge, server/services/bookings/money.ts).
// The money itself is one `payments` row (kind 'booking_payment'); these tables hold the human story.
// Money is INTEGER CENTS.

// What she sells. public_id (random) is the only id a public URL ever carries.
export const offers = pgTable("offers", {
  id:                      uuid("id").primaryKey().defaultRandom(),
  athlete_id:              uuid("athlete_id").notNull().references(() => athletes.id),
  public_id:               text("public_id").notNull().unique(),
  format:                  text("format").notNull(),                       // video_call | appearance | clinic | custom
  title:                   text("title").notNull(),
  description:             text("description"),
  price_cents:             integer("price_cents").notNull(),               // HER price: she receives all of it
  currency:                text("currency").notNull().default("usd"),
  duration_minutes:        integer("duration_minutes").notNull(),
  location_mode:           text("location_mode").notNull(),                // virtual | in_person
  video_mode:              text("video_mode"),                             // virtual only: livekit (in-app) | link (pasted)
  // Her rules. In person ALWAYS requires ID + selfie (offers_in_person_id_check); never her home address.
  venue:                   text("venue"),                                  // her chosen venue / public place (in person)
  require_id_verification: boolean("require_id_verification").notNull().default(false),
  allow_minor_attendees:   boolean("allow_minor_attendees").notNull().default(false), // only with a parent present
  returning_buyers_only:   boolean("returning_buyers_only").notNull().default(false),
  scheduling_mode:         text("scheduling_mode").notNull().default("request"), // slots | request
  available_from:          date("available_from"),
  available_until:         date("available_until"),
  // v2.1: the cancellation window is HERS, per offer (default 24h; BOOKINGS.freeCancelHoursOptions lists the choices).
  // policy_key versions the rules text the window plugs into; both are snapshotted onto each booking.
  free_cancel_hours:       integer("free_cancel_hours").notNull().default(24),
  policy_key:              text("policy_key").notNull().default("athlete_window_v1"),
  status:                  text("status").notNull().default("draft"),      // draft | published | paused | archived
  paused_reason:           text("paused_reason"),                          // athlete | no_show_review | support (only while paused)
  // 0102: her own "I'm 18 or older" at first publish, and her tick that the venue is a public place / her usual venue,
  // not her home (in person). Publish refuses without them.
  adult_attested_at:       timestamp("adult_attested_at", { withTimezone: true }),
  venue_confirmed_at:      timestamp("venue_confirmed_at", { withTimezone: true }),
  /** Her own time zone (IANA), for her notices and reminders; null → her phone's zone, then UTC (0137). */
  time_zone:               text("time_zone"),
  // 0153 group sessions: who it's for. one = 1:1 (every offer before 0153); private_group = ONE fan books the whole
  // time for themselves + friends (1..max_people); open_group = strangers each book (and pay for) their own spot until
  // max_people is reached. price_cents is PER PERSON; a booking's charge is price × party size.
  audience:                text("audience").notNull().default("one"),
  max_people:              integer("max_people").notNull().default(1),
  // 0154: open groups only — her "Approve each spot" setting. Off (the default) = as before: a fan's card hold confirms
  // the spot by itself. On = each spot is a request she accepts (or declines) like a 1:1; capacity still holds.
  approve_each_spot:       boolean("approve_each_spot").notNull().default(false),
  // 0155 flexible hours: her weekly hours ({ version: 1, preset, blocks: [{ day 0–6, start, end }] }, minutes after
  // midnight in time_zone, 15-minute steps) so the app's hours editor can reopen them. The open times fans book are
  // still offer_slots; null = request mode or an offer from before flexible hours. Validated in
  // server/services/bookings/availability.ts.
  availability:            jsonb("availability"),
  created_at:              timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:              timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_offers_athlete_status").on(table.athlete_id, table.status),
  check("offers_audience_check",        sql`${table.audience} IN ('one','private_group','open_group')`),
  check("offers_availability_check",    sql`${table.availability} IS NULL OR jsonb_typeof(${table.availability}) = 'object'`),
  check("offers_max_people_check",      sql`(${table.audience} = 'one' AND ${table.max_people} = 1) OR (${table.audience} <> 'one' AND ${table.max_people} BETWEEN 2 AND 20)`),
  check("offers_open_group_slots_check", sql`${table.audience} <> 'open_group' OR ${table.scheduling_mode} = 'slots'`),
  check("offers_format_check",          sql`${table.format} IN ('video_call','appearance','clinic','custom')`),
  check("offers_location_mode_check",   sql`${table.location_mode} IN ('virtual','in_person')`),
  check("offers_video_mode_check",      sql`${table.video_mode} IS NULL OR ${table.video_mode} IN ('livekit','link')`),
  check("offers_scheduling_mode_check", sql`${table.scheduling_mode} IN ('slots','request')`),
  check("offers_status_check",          sql`${table.status} IN ('draft','published','paused','archived')`),
  check("offers_price_check",           sql`${table.price_cents} > 0`),
  check("offers_duration_check",        sql`${table.duration_minutes} > 0`),
  check("offers_in_person_id_check",    sql`${table.location_mode} <> 'in_person' OR ${table.require_id_verification}`),
  check("offers_free_cancel_hours_check", sql`${table.free_cancel_hours} > 0 AND ${table.free_cancel_hours} <= 720`),
  check("offers_paused_reason_check",   sql`${table.paused_reason} IS NULL OR (${table.status} = 'paused' AND ${table.paused_reason} IN ('athlete','no_show_review','support'))`),
]);

// The concrete times she offers (slots mode). "Taken" is derived from bookings.slot_id, so there is no back-reference.
export const offerSlots = pgTable("offer_slots", {
  id:           uuid("id").primaryKey().defaultRandom(),
  offer_id:     uuid("offer_id").notNull().references(() => offers.id),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id),
  starts_at:    timestamp("starts_at", { withTimezone: true }).notNull(),
  ends_at:      timestamp("ends_at", { withTimezone: true }).notNull(),
  withdrawn_at: timestamp("withdrawn_at", { withTimezone: true }),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_offer_slots_offer").on(table.offer_id, table.starts_at),
  check("offer_slots_time_check", sql`${table.ends_at} > ${table.starts_at}`),
]);

// One buyer request, start to finish. Snapshots keep what was agreed even if the offer changes later.
// Buyer contact (email, phone) is NEVER shown to her unless she chooses to share contact; messages are relayed.
// Buyer data is minimised on its own clock (buyer_redacted_at): the buyer is not a Nomila user.
export const bookings = pgTable("bookings", {
  id:                         uuid("id").primaryKey().defaultRandom(),
  athlete_id:                 uuid("athlete_id").notNull().references(() => athletes.id),
  offer_id:                   uuid("offer_id").notNull().references(() => offers.id),
  slot_id:                    uuid("slot_id").references(() => offerSlots.id),
  status:                     text("status").notNull().default("unverified"),
  // snapshots
  format:                     text("format").notNull(),
  title:                      text("title").notNull(),
  duration_minutes:           integer("duration_minutes").notNull(),
  location_mode:              text("location_mode").notNull(),
  policy_key:                 text("policy_key").notNull(),
  free_cancel_hours:          integer("free_cancel_hours").notNull(),      // her window at booking time, shown before paying
  price_cents:                integer("price_cents").notNull(),            // her price × party_size = what she receives
  // 0153 group sessions (snapshots): who the offer was for, how many people this booking covers, and her per-person
  // price at booking time (price_cents = unit_price_cents × party_size). NULL unit price = a pre-0153 booking (party 1).
  audience:                   text("audience").notNull().default("one"),
  party_size:                 integer("party_size").notNull().default(1),
  unit_price_cents:           integer("unit_price_cents"),
  // 0154 (snapshot): the offer's approve_each_spot when the spot was taken. An open-group booking with it on waits for
  // her Accept instead of confirming itself.
  approve_each_spot:          boolean("approve_each_spot").notNull().default(false),
  service_fee_cents:          integer("service_fee_cents").notNull(),      // the buyer's ONE Nomila service fee (15% + processing pass-through)
  buyer_total_cents:          integer("buyer_total_cents").notNull(),      // all-in: what the buyer pays
  currency:                   text("currency").notNull().default("usd"),
  // buyer (minimal)
  buyer_kind:                 text("buyer_kind").notNull().default("fan"), // fan | brand (the NIL Go seam groups brand payers)
  buyer_org_name:             text("buyer_org_name"),
  buyer_name:                 text("buyer_name").notNull(),
  buyer_email:                text("buyer_email").notNull(),
  buyer_phone:                text("buyer_phone"),
  buyer_email_hash:           text("buyer_email_hash").notNull(),          // keyed hash: blocks, returning buyers, rate caps
  buyer_phone_hash:           text("buyer_phone_hash"),
  buyer_message:              text("buyer_message"),
  buyer_timezone:             text("buyer_timezone"),
  buyer_adult_attested:       boolean("buyer_adult_attested").notNull().default(false),
  minor_attendee:             boolean("minor_attendee").notNull().default(false),
  parent_present_attested:    boolean("parent_present_attested").notNull().default(false),
  buyer_token_hash:           text("buyer_token_hash").notNull().unique(), // sha256 of the manage-link token
  // verification (controls, not guarantees)
  otp_channel:                text("otp_channel"),                         // email | phone: the one pending code
  otp_hash:                   text("otp_hash"),
  otp_expires_at:             timestamp("otp_expires_at", { withTimezone: true }),
  otp_attempts:               integer("otp_attempts").notNull().default(0),
  email_verified_at:          timestamp("email_verified_at", { withTimezone: true }),
  phone_verified_at:          timestamp("phone_verified_at", { withTimezone: true }),
  identity_required:          boolean("identity_required").notNull().default(false),
  identity_status:            text("identity_status"),                     // Stripe Identity: pending | verified | requires_input | canceled
  stripe_identity_session_id: text("stripe_identity_session_id"),
  identity_verified_at:       timestamp("identity_verified_at", { withTimezone: true }),
  contact_shared_at:          timestamp("contact_shared_at", { withTimezone: true }), // she chose to share contact
  // scheduling + where
  proposed_note:              text("proposed_note"),                       // request mode: the buyer's suggested date/place
  // 0102: request mode — the buyer's 1–3 suggested times [{start, tz}]; starts_at is set when she picks one.
  proposed_times:             jsonb("proposed_times"),
  // 0102: her counter-offer ("propose another time"): 1–3 times; the buyer picks one, then she accepts as usual.
  athlete_proposed_times:     jsonb("athlete_proposed_times"),
  minor_first_name:           text("minor_first_name"),                    // 0102: a parent booking for a child (her offer allows minors)
  starts_at:                  timestamp("starts_at", { withTimezone: true }),
  ends_at:                    timestamp("ends_at", { withTimezone: true }),
  meeting_mode:               text("meeting_mode"),                        // livekit | link | in_person
  meeting_link:               text("meeting_link"),                        // pasted fallback link; shown only after payment
  venue:                      text("venue"),                               // revealed only after payment; never her home
  // clocks
  respond_by:                 timestamp("respond_by", { withTimezone: true }),
  pay_by:                     timestamp("pay_by", { withTimezone: true }),
  accepted_at:                timestamp("accepted_at", { withTimezone: true }),
  confirmed_at:               timestamp("confirmed_at", { withTimezone: true }),
  athlete_done_at:            timestamp("athlete_done_at", { withTimezone: true }),    // "Session done": notifies, never releases
  buyer_confirmed_at:         timestamp("buyer_confirmed_at", { withTimezone: true }), // "It happened": releases
  release_due_at:             timestamp("release_due_at", { withTimezone: true }),     // ends_at + 48h; releases only with no open issue
  released_at:                timestamp("released_at", { withTimezone: true }),
  canceled_at:                timestamp("canceled_at", { withTimezone: true }),
  canceled_by:                text("canceled_by"),
  refund_outcome:             text("refund_outcome"),                      // full (incl. fee) | price_only (fee kept) | none
  // no-shows (v2.1; logic in B5): after the grace, she taps "Buyer didn't show" (buyer) or the buyer reports her (athlete)
  no_show_by:                 text("no_show_by"),                          // buyer | athlete
  no_show_marked_at:          timestamp("no_show_marked_at", { withTimezone: true }),
  buyer_redacted_at:          timestamp("buyer_redacted_at", { withTimezone: true }),
  created_at:                 timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:                 timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_bookings_athlete_status").on(table.athlete_id, table.status),
  index("idx_bookings_status_release").on(table.status, table.release_due_at),
  index("idx_bookings_buyer_email_hash").on(table.buyer_email_hash),
  index("idx_bookings_athlete_no_show").on(table.athlete_id).where(sql`no_show_by = 'athlete'`), // counts toward the pause threshold
  // 0102: widened to unverified + requested — a slot is held from the moment a buyer starts a request (the unverified
  // hold lapses after BOOKINGS.unverifiedHoldMinutes) through her answer to the end of the booking.
  // 0153: open group sessions are excluded — many fans hold spots in one slot; capacity (the sum of live party sizes ≤
  // the offer's max_people) is enforced in code under a lock on the slot row (buyer.ts insertUnverified).
  uniqueIndex("uq_bookings_live_slot").on(table.slot_id)
    .where(sql`slot_id IS NOT NULL AND status IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed') AND audience <> 'open_group'`),
  index("idx_bookings_slot").on(table.slot_id).where(sql`slot_id IS NOT NULL`),   // 0153: a slot's live spots
  index("idx_bookings_status_respond").on(table.status, table.respond_by), // 0102: the respond_by sweeper
  check("bookings_status_check",          sql`${table.status} IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed','released','declined','withdrawn','expired','canceled','refunded')`),
  check("bookings_format_check",          sql`${table.format} IN ('video_call','appearance','clinic','custom')`),
  check("bookings_location_mode_check",   sql`${table.location_mode} IN ('virtual','in_person')`),
  check("bookings_buyer_kind_check",      sql`${table.buyer_kind} IN ('fan','brand')`),
  check("bookings_otp_channel_check",     sql`${table.otp_channel} IS NULL OR ${table.otp_channel} IN ('email','phone')`),
  check("bookings_identity_status_check", sql`${table.identity_status} IS NULL OR ${table.identity_status} IN ('pending','verified','requires_input','canceled')`),
  check("bookings_meeting_mode_check",    sql`${table.meeting_mode} IS NULL OR ${table.meeting_mode} IN ('livekit','link','in_person')`),
  check("bookings_canceled_by_check",     sql`${table.canceled_by} IS NULL OR ${table.canceled_by} IN ('buyer','athlete','system','admin')`),
  check("bookings_refund_outcome_check",  sql`${table.refund_outcome} IS NULL OR ${table.refund_outcome} IN ('full','price_only','none')`),
  check("bookings_amounts_check",         sql`${table.price_cents} > 0 AND ${table.service_fee_cents} >= 0 AND ${table.buyer_total_cents} = ${table.price_cents} + ${table.service_fee_cents}`),
  check("bookings_in_person_id_check",    sql`${table.location_mode} <> 'in_person' OR ${table.identity_required}`),
  check("bookings_minor_parent_check",    sql`NOT ${table.minor_attendee} OR ${table.parent_present_attested}`),
  check("bookings_free_cancel_hours_check", sql`${table.free_cancel_hours} > 0 AND ${table.free_cancel_hours} <= 720`),
  check("bookings_no_show_by_check",      sql`${table.no_show_by} IS NULL OR ${table.no_show_by} IN ('buyer','athlete')`),
  check("bookings_no_show_marked_check",  sql`(${table.no_show_by} IS NULL) = (${table.no_show_marked_at} IS NULL)`),
  check("bookings_proposed_times_check",  sql`${table.proposed_times} IS NULL OR (jsonb_typeof(${table.proposed_times}) = 'array' AND jsonb_array_length(${table.proposed_times}) BETWEEN 1 AND 3)`),
  check("bookings_athlete_proposed_times_check", sql`${table.athlete_proposed_times} IS NULL OR (jsonb_typeof(${table.athlete_proposed_times}) = 'array' AND jsonb_array_length(${table.athlete_proposed_times}) BETWEEN 1 AND 3)`),
  check("bookings_minor_name_check",      sql`${table.minor_first_name} IS NULL OR ${table.minor_attendee}`),
  check("bookings_audience_check",        sql`${table.audience} IN ('one','private_group','open_group')`),
  check("bookings_party_size_check",      sql`${table.party_size} BETWEEN 1 AND 20 AND (${table.audience} = 'private_group' OR ${table.party_size} = 1)`),
  check("bookings_unit_price_check",      sql`${table.unit_price_cents} IS NULL OR (${table.unit_price_cents} > 0 AND ${table.price_cents} = ${table.unit_price_cents} * ${table.party_size})`),
]);

// 0153: the friends a private-group booker invites (up to party_size − 1). Guests never pay and see nothing of the
// booker beyond the athlete and the session; each gets their OWN signed call link (/s/:token, purpose "guest", minted
// from this row's id, never stored). Revoking sets revoked_at: the link stops working and the row stays as history.
// Minimised with the booking's buyer data (buyer_redacted_at).
export const bookingGuests = pgTable("booking_guests", {
  id:          uuid("id").primaryKey().defaultRandom(),
  booking_id:  uuid("booking_id").notNull().references(() => bookings.id),
  name:        text("name"),                               // first name only, optional (the call shows it, else "Guest")
  email:       text("email").notNull(),
  email_hash:  text("email_hash").notNull(),               // keyed hash (tokens.emailHash): one live invite per address
  invited_at:  timestamp("invited_at", { withTimezone: true }),
  revoked_at:  timestamp("revoked_at", { withTimezone: true }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_booking_guests_booking").on(table.booking_id),
  uniqueIndex("uq_booking_guests_live_email").on(table.booking_id, table.email_hash).where(sql`revoked_at IS NULL`),
]);

// Append-only history: status changes, LiveKit attendance (EVIDENCE ONLY, never releases money), flagged
// messages, safety actions. No buyer contact details in `data`.
export const bookingEvents = pgTable("booking_events", {
  id:          uuid("id").primaryKey().defaultRandom(),
  booking_id:  uuid("booking_id").notNull().references(() => bookings.id),
  kind:        text("kind").notNull(),                 // status | attendance | no_show | message | safety | payment | note
  actor:       text("actor").notNull(),                // buyer | athlete | system | stripe | livekit | admin
  from_status: text("from_status"),
  to_status:   text("to_status"),
  data:        jsonb("data"),
  at:          timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_booking_events_booking").on(table.booking_id, table.at),
  check("booking_events_kind_check",  sql`${table.kind} IN ('status','attendance','no_show','message','safety','payment','note')`),
  check("booking_events_actor_check", sql`${table.actor} IN ('buyer','athlete','system','stripe','livekit','admin')`),
]);

// Nomila-relayed messages between her and the buyer (no contact details exchanged unless she shares them).
// Every message passes moderation before delivery; held or blocked ones never reach the other side.
export const bookingMessages = pgTable("booking_messages", {
  id:                uuid("id").primaryKey().defaultRandom(),
  booking_id:        uuid("booking_id").notNull().references(() => bookings.id),
  sender:            text("sender").notNull(),          // buyer | athlete | nomila
  body:              text("body").notNull(),
  moderation:        text("moderation").notNull().default("pending"), // pending | clean | held | blocked
  moderation_reason: text("moderation_reason"),
  delivered_at:      timestamp("delivered_at", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_booking_messages_booking").on(table.booking_id, table.created_at),
  check("booking_messages_sender_check",     sql`${table.sender} IN ('buyer','athlete','nomila')`),
  check("booking_messages_moderation_check", sql`${table.moderation} IN ('pending','clean','held','blocked')`),
]);

// The trust-and-safety review queue: every report, issue and dispute lands here AND emails SUPPORT_EMAIL.
// An open row (open | in_review) freezes the 48h auto-release.
export const bookingReports = pgTable("booking_reports", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  booking_id:          uuid("booking_id").notNull().references(() => bookings.id),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id),
  reported_by:         text("reported_by").notNull(),    // buyer | athlete | admin | system
  category:            text("category").notNull(),       // safety | no_show | not_as_described | harassment | fraud | payment | other
  details:             text("details"),
  status:              text("status").notNull().default("open"), // open | in_review | resolved
  resolution:          text("resolution"),               // release | refund | no_action | ban
  resolution_note:     text("resolution_note"),
  assigned_to:         text("assigned_to"),
  support_notified_at: timestamp("support_notified_at", { withTimezone: true }),
  opened_at:           timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  resolved_at:         timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  index("idx_booking_reports_status").on(table.status, table.opened_at),
  index("idx_booking_reports_booking").on(table.booking_id),
  check("booking_reports_reported_by_check", sql`${table.reported_by} IN ('buyer','athlete','admin','system')`),
  check("booking_reports_category_check",    sql`${table.category} IN ('safety','no_show','not_as_described','harassment','fraud','payment','other')`),
  check("booking_reports_status_check",      sql`${table.status} IN ('open','in_review','resolved')`),
  check("booking_reports_resolution_check",  sql`${table.resolution} IS NULL OR ${table.resolution} IN ('release','refund','no_action','ban')`),
  check("booking_reports_resolved_check",    sql`(${table.status} = 'resolved') = (${table.resolution} IS NOT NULL)`),
]);

// Blocks and bans, stored ONLY as keyed hashes (email / phone) or Stripe card fingerprints, never the raw value.
//   scope 'athlete'  : her own block (athlete_id set); this buyer cannot request from her again.
//   scope 'platform' : a trust-and-safety ban (athlete_id NULL); the buyer cannot book anyone on Nomila.
export const safetyBlocks = pgTable("safety_blocks", {
  id:         uuid("id").primaryKey().defaultRandom(),
  scope:      text("scope").notNull(),                 // athlete | platform
  athlete_id: uuid("athlete_id").references(() => athletes.id),
  kind:       text("kind").notNull(),                  // email | phone | card_fingerprint
  value_hash: text("value_hash").notNull(),
  reason:     text("reason"),
  created_by: text("created_by").notNull(),            // athlete | admin
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lifted_at:  timestamp("lifted_at", { withTimezone: true }),
}, (table) => [
  index("idx_safety_blocks_lookup").on(table.kind, table.value_hash),
  check("safety_blocks_scope_check",         sql`${table.scope} IN ('athlete','platform')`),
  check("safety_blocks_kind_check",          sql`${table.kind} IN ('email','phone','card_fingerprint')`),
  check("safety_blocks_created_by_check",    sql`${table.created_by} IN ('athlete','admin')`),
  check("safety_blocks_scope_athlete_check", sql`(${table.scope} = 'athlete') = (${table.athlete_id} IS NOT NULL)`),
]);

// 0154: the fans SHE blocked. One row per blocked person, keyed by keyed hashes only (tokens.emailHash / phoneHash, the
// same as bookings.buyer_email_hash), never the raw address. A live row (removed_at NULL) means this person can't book
// her, request her, be invited as a friend to her sessions, or get a join token for one of her calls; they are never
// told why. Not booking-specific: `source` says where she blocked them (a booking, a friend in a group call, later a
// Live); booking_id is the booking she did it from (history only). first_name is what her list shows ("Jordan").
// Unblocking sets removed_at; blocking again inserts a new row. Platform bans stay in safety_blocks.
export const fanBlocks = pgTable("fan_blocks", {
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id),
  email_hash:  text("email_hash").notNull(),
  phone_hash:  text("phone_hash"),
  first_name:  text("first_name"),
  reason:      text("reason"),                                // her own words, optional; only she sees it
  source:      text("source").notNull().default("booking"),   // booking | guest | live
  booking_id:  uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  removed_at:  timestamp("removed_at", { withTimezone: true }),
}, (table) => [
  index("idx_fan_blocks_athlete").on(table.athlete_id, table.created_at),
  uniqueIndex("uq_fan_blocks_live_email").on(table.athlete_id, table.email_hash).where(sql`removed_at IS NULL`),
  index("idx_fan_blocks_live_phone").on(table.athlete_id, table.phone_hash).where(sql`phone_hash IS NOT NULL AND removed_at IS NULL`),
  check("fan_blocks_source_check", sql`${table.source} IN ('booking','guest','live')`),
]);

// What she owes back when SHE causes a refund (she cancels or doesn't show): the buyer gets everything back, including
// the service fee, and Stripe keeps its processing fee, so that cost (the ACTUAL fee from the charge's balance
// transaction, never a hard-coded rate) is deducted from her next payout. Her FIRST athlete-caused cancellation is
// free (status 'waived'; uq_athlete_adjustments_first_waiver allows exactly one). Buyer-caused refunds never land here.
export const athletePayoutAdjustments = pgTable("athlete_payout_adjustments", {
  id:                            uuid("id").primaryKey().defaultRandom(),
  athlete_id:                    uuid("athlete_id").notNull().references(() => athletes.id),
  booking_id:                    uuid("booking_id").notNull().references(() => bookings.id),
  kind:                          text("kind").notNull().default("athlete_cancel_processing_fee"),
  amount_cents:                  integer("amount_cents").notNull(),
  currency:                      text("currency").notNull().default("usd"),
  status:                        text("status").notNull().default("owed"), // owed | waived | recovered | written_off
  stripe_balance_transaction_id: text("stripe_balance_transaction_id"),    // where the actual fee was read from
  recovered_payment_id:     uuid("recovered_payment_id").references(() => payments.id),
  created_at:                    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settled_at:                    timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  index("idx_athlete_adjustments_owed").on(table.athlete_id, table.status),
  uniqueIndex("uq_athlete_adjustments_booking").on(table.booking_id, table.kind),
  uniqueIndex("uq_athlete_adjustments_first_waiver").on(table.athlete_id, table.kind).where(sql`status = 'waived'`),
  check("athlete_adjustments_kind_check",   sql`${table.kind} IN ('athlete_cancel_processing_fee')`),
  check("athlete_adjustments_status_check", sql`${table.status} IN ('owed','waived','recovered','written_off')`),
  check("athlete_adjustments_amount_check", sql`${table.amount_cents} >= 0`),
]);

export type Offer          = typeof offers.$inferSelect;
export type OfferSlot      = typeof offerSlots.$inferSelect;
export type Booking        = typeof bookings.$inferSelect;
export type NewBooking     = typeof bookings.$inferInsert;
export type BookingGuest   = typeof bookingGuests.$inferSelect;
export type BookingEvent   = typeof bookingEvents.$inferSelect;
export type BookingMessage = typeof bookingMessages.$inferSelect;
export type BookingReport  = typeof bookingReports.$inferSelect;
export type SafetyBlock    = typeof safetyBlocks.$inferSelect;
export type FanBlock       = typeof fanBlocks.$inferSelect;
export type AthletePayoutAdjustment = typeof athletePayoutAdjustments.$inferSelect;

export type ConnectAccount    = typeof connectAccounts.$inferSelect;
export type NewConnectAccount = typeof connectAccounts.$inferInsert;
export type Payment           = typeof payments.$inferSelect;
export type NewPayment        = typeof payments.$inferInsert;
export type PaymentEvent      = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent   = typeof paymentEvents.$inferInsert;

// ─── 19. pending_actions ─────────────────────────────────────────────────────
// The co-pilot spine (WS3 §3.6): Mila PROPOSES an action, the athlete APPROVES it,
// and only approval executes it. Nothing here ever auto-sends. A row is created in
// `pending` and moves to exactly one terminal state — `approved` (executed on the
// athlete's say-so), `failed` (approved but the underlying send errored), or
// `dismissed` (the athlete declined). The `deals.pending_action` JSONB column is the
// spec's shorthand for a single proposal; this table generalizes it into a durable,
// auditable lifecycle (multiple/historical actions, timestamps per transition) that
// the WS2 buttons drive and the WS5 receipt can later read.
export const pendingActions = pgTable("pending_actions", {
  id:           uuid("id").primaryKey().defaultRandom(),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id),
  // What the action operates on. A send_reply targets a thread; deal_id is the
  // co-pilot surface it was proposed from. Both nullable so the shape can grow
  // (a future kind may reference neither), but send_reply requires thread_id.
  deal_id:      uuid("deal_id").references(() => deals.id),
  thread_id:    uuid("thread_id").references(() => inboxThreads.id),
  // The verb. v1 ships `send_reply`; extend the check as kinds are added.
  kind:         text("kind").notNull(),
  status:       text("status").notNull().default("pending"),
  // The proposed action itself — e.g. { body, reply_intent, style, voice } for a
  // send_reply. Read verbatim by the executor at approval time.
  payload:      jsonb("payload").notNull(),
  // Executor output on approval (e.g. { sent: true }) — audit trail for WS5.
  result:       jsonb("result"),
  // Populated when status = 'failed' (the underlying send errored).
  error:        text("error"),
  created_at:   timestamp("created_at", { withTimezone: true }).defaultNow(),
  // Optional TTL — a stale proposal shouldn't be approvable forever.
  expires_at:   timestamp("expires_at", { withTimezone: true }),
  approved_at:  timestamp("approved_at", { withTimezone: true }),
  dismissed_at: timestamp("dismissed_at", { withTimezone: true }),
  executed_at:  timestamp("executed_at", { withTimezone: true }),
}, (table) => [
  // agent_action (0105): an act-level agent tool call waiting for her tap (shared/agent.ts ApprovalItem).
  check("pending_actions_kind_check",   sql`${table.kind} IN ('send_reply','agent_action')`),
  check("pending_actions_status_check", sql`${table.status} IN ('pending','approved','dismissed','failed')`),
  // The co-pilot inbox: "what's awaiting my approval" for an athlete.
  index("idx_pending_actions_athlete_status").on(table.athlete_id, table.status, table.created_at),
  index("idx_pending_actions_deal").on(table.deal_id),
]);

// ─── 20. agent_actions ───────────────────────────────────────────────────────
// The receipt log (WS5 §5B): an append-only, reversible audit trail of every
// action Nomila took ON THE ATHLETE'S BEHALF — the source The Week renders from
// ("Set aside by Nomila", each line Undo/Wrong?) and the co-pilot trail reads.
//
// APPEND-ONLY: a row is never deleted and its identity/payload never mutates.
// The ONLY writes after insert are the two reversal stamps — `undone_at` (an Undo
// flipped the effect back) and `result` (executor output). A reversal does NOT
// delete the row; the receipt keeps showing "filed, then reopened".
//
// `held_until` is the 24-hour auto-decline hold: the row is written when Nomila
// DECIDES to decline, but the decline only actually SENDS once `held_until` passes
// (so a same-day Undo means the brand never saw a "no"). Distinct from
// pending_actions (which never auto-sends and needs explicit approval) — this table
// records actions already taken/scheduled, for accountability after the fact.
//
// Reversal contract: a `reversible` filing stores { from_status, to_status } in
// `payload`; Undo (POST /agent-actions/:id/undo) sets the thread back to
// `from_status` and stamps `undone_at`. Non-reversible rows are receipt-only.
export const agentActions = pgTable("agent_actions", {
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id),
  // The verb Nomila performed. Extend the check as auto-actions are wired.
  action:      text("action").notNull(),
  // What it operated on. A filing/reclassify targets a thread; deal_id is the
  // surface it relates to. Both nullable so the shape can grow.
  deal_id:     uuid("deal_id").references(() => deals.id),
  thread_id:   uuid("thread_id").references(() => inboxThreads.id),
  // One line of Mila's rationale — shown verbatim on the receipt.
  reason:      text("reason"),
  // Whether Undo can reverse the effect (a filing) vs receipt-only.
  reversible:  boolean("reversible").notNull().default(false),
  // The 24h auto-decline hold — the effect is not final until this passes.
  held_until:  timestamp("held_until", { withTimezone: true }),
  // Stamped when an Undo reverses the effect. Append-only: the row stays.
  undone_at:   timestamp("undone_at", { withTimezone: true }),
  // The action's inputs — e.g. { from_status, to_status } for a reversible filing.
  payload:     jsonb("payload"),
  // Executor output (e.g. { sent: true } once a held decline actually sends).
  result:      jsonb("result"),
  created_at:  timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("agent_actions_action_check", sql`${table.action} IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write','confirm_signed','split_deal')`),
  // The receipt feed: an athlete's actions newest-first (The Week / co-pilot trail).
  index("idx_agent_actions_athlete_created").on(table.athlete_id, table.created_at),
  index("idx_agent_actions_deal").on(table.deal_id),
]);

// ─── athlete_asserted — what the athlete told us, one fact per row ────────────
// PR 3 (first entry). Written ONLY from the athlete's own words in a conversation
// (onboarding first; chat/voice later), never from research or a model guess. Every
// row is attributed (mode, run), receipted (agent_actions 'profile_write') and
// undoable (retracted_at). A table, not a jsonb document: facts accumulate and get
// superseded one at a time, and the receipt joins to the exact row it can undo.
// Vocabulary for `field` lives in server/mila/onboarding.ts (ASSERTED_FIELDS).
export const ATHLETE_ASSERTED_SOURCES = ["onboarding", "chat", "voice", "settings"] as const;

export const athleteAsserted = pgTable("athlete_asserted", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id),
  field:            text("field").notNull(),
  value:            jsonb("value").notNull(),
  said:             text("said"),
  source:           text("source").notNull().default("onboarding"),
  mode:             text("mode"),
  // No FK on purpose: runs may be pruned; the fact outlives the run that recorded it.
  run_id:           uuid("run_id"),
  agent_action_id:  uuid("agent_action_id").references(() => agentActions.id),
  superseded_by:    uuid("superseded_by").references((): AnyPgColumn => athleteAsserted.id),
  retracted_at:     timestamp("retracted_at", { withTimezone: true }),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  check("athlete_asserted_source_check", sql`${table.source} IN ('onboarding','chat','voice','settings')`),
  check("athlete_asserted_mode_check", sql`${table.mode} IS NULL OR ${table.mode} IN ('chat','voice','form')`),
  index("idx_athlete_asserted_athlete_field").on(table.athlete_id, table.field, table.created_at),
]);

/**
 * athlete_affiliations — teams as dated facts (migration 0041). One row per team per athlete;
 * ended_on NULL = current; exactly one primary current row (partial unique index). The athlete's
 * said list is one ledger fact (`affiliations`); found rows come from research; proof from a
 * contract that names the team. athletes.school/division/conference project the primary row.
 */
export const athleteAffiliations = pgTable("athlete_affiliations", {
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id),
  org_name:    text("org_name").notNull(),
  org_kind:    text("org_kind").notNull(),
  level:       text("level"),
  conference:  text("conference"),
  role:        text("role"),
  position:    text("position"),
  started_on:  date("started_on"),
  ended_on:    date("ended_on"),
  is_primary:  boolean("is_primary").notNull().default(false),
  kind:        text("kind").notNull().default("said"),
  source:      text("source"),
  asserted_id: uuid("asserted_id").references(() => athleteAsserted.id),
  /** Phase A Step 2d-6 (0050): the athlete_facts row a found affiliation was synced from (kind=found, source=fact); NULL for said/proof rows and legacy found rows. */
  fact_id:     uuid("fact_id").references(() => athleteFacts.id, { onDelete: "set null" }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_affiliations_fact").on(table.fact_id).where(sql`${table.fact_id} IS NOT NULL`),
  check("athlete_affiliations_org_kind_check", sql`${table.org_kind} IN ('school','club','pro','national','olympic')`),
  check("athlete_affiliations_kind_check", sql`${table.kind} IN ('said','found','proof')`),
  index("idx_affiliations_athlete_current").on(table.athlete_id, table.ended_on),
  uniqueIndex("idx_affiliations_one_primary_current").on(table.athlete_id).where(sql`${table.is_primary} AND ${table.ended_on} IS NULL`),
]);

// ─── Phase A Step 3a — Identity: users, memberships, claims, roles (ADR-015; design step3 §3) ────────────
/** The authenticated person. provider_uid is the identity-provider uid exactly as athletes.auth_id holds it. */
export const users = pgTable("users", {
  id:             uuid("id").primaryKey().defaultRandom(),
  provider:       text("provider").notNull(),
  provider_uid:   text("provider_uid").notNull(),
  email:          text("email"),
  email_verified: boolean("email_verified").notNull().default(false),
  display_name:   text("display_name"),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  last_seen_at:   timestamp("last_seen_at", { withTimezone: true }),
  disabled_at:    timestamp("disabled_at", { withTimezone: true }),
}, (t) => [
  check("users_provider_check", sql`${t.provider} IN ('firebase','microsoft')`),
  unique("users_provider_uid_uq").on(t.provider, t.provider_uid),
  index("users_email_lower_idx").on(sql`lower(${t.email})`).where(sql`${t.email} IS NOT NULL`),
]);

/** The claim lifecycle state (D-14). 3a creates it and writes only collision claims (§3a-C); the "Is this you?" flow is 3b. */
export const identityClaims = pgTable("identity_claims", {
  id:          uuid("id").primaryKey().defaultRandom(),
  user_id:     uuid("user_id").notNull().references(() => users.id),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id),
  match_id:    uuid("match_id").references(() => athleteIndexMatches.id, { onDelete: "set null" }),
  proof:       text("proof").notNull(),
  status:      text("status").notNull().default("proposed"),
  proposed_at: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
  decided_at:  timestamp("decided_at", { withTimezone: true }),
  decided_by:  text("decided_by"),
  note:        jsonb("note"),
  /** Phase A Step 3b: one UUID per candidate-selection interaction, identical on every claim proposed in it; NULL for §3a-C collision claims. Workflow state — never a match id. */
  claim_session_id: uuid("claim_session_id"),
}, (t) => [
  index("identity_claims_user_session_idx").on(t.user_id, t.claim_session_id, t.status),
  uniqueIndex("identity_claims_session_proposed_uq").on(t.user_id, t.athlete_id, t.claim_session_id).where(sql`${t.status} = 'proposed' AND ${t.claim_session_id} IS NOT NULL`),
  check("identity_claims_proof_check",   sql`${t.proof} IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')`),
  check("identity_claims_status_check",  sql`${t.status} IN ('proposed','confirmed','rejected','expired','superseded')`),
  check("identity_claims_decided_check", sql`${t.decided_by} IS NULL OR ${t.decided_by} IN ('user','operator','system')`),
  index("identity_claims_athlete_idx").on(t.athlete_id, t.status),
  index("identity_claims_user_idx").on(t.user_id, t.status),
]);

/** The membership: User ↔ Athlete. relation locked to 'self' (D-1); one active self per athlete (D-2). */
export const athleteUsers = pgTable("athlete_users", {
  id:             uuid("id").primaryKey().defaultRandom(),
  athlete_id:     uuid("athlete_id").notNull().references(() => athletes.id),
  user_id:        uuid("user_id").notNull().references(() => users.id),
  relation:       text("relation").notNull().default("self"),
  proof:          text("proof").notNull(),
  claim_id:       uuid("claim_id").references(() => identityClaims.id, { onDelete: "set null" }),
  note:           text("note"),
  established_at: timestamp("established_at", { withTimezone: true }).notNull().defaultNow(),
  revoked_at:     timestamp("revoked_at", { withTimezone: true }),
  revoked_reason: text("revoked_reason"),
}, (t) => [
  check("athlete_users_relation_check", sql`${t.relation} IN ('self')`),
  check("athlete_users_proof_check",    sql`${t.proof} IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation')`),
  uniqueIndex("athlete_users_active_uq").on(t.athlete_id, t.user_id).where(sql`${t.revoked_at} IS NULL`),
  uniqueIndex("athlete_users_one_self_uq").on(t.athlete_id).where(sql`${t.relation} = 'self' AND ${t.revoked_at} IS NULL`),
  index("athlete_users_user_idx").on(t.user_id).where(sql`${t.revoked_at} IS NULL`),
]);

/** A role belongs to a person (D-11). account_roles stays for the compatibility read until 3d. */
export const userRoles = pgTable("user_roles", {
  user_id:    uuid("user_id").notNull().references(() => users.id),
  role:       text("role").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.user_id, t.role] }),
  check("user_roles_role_check", sql`${t.role} IN ('athlete','fan','brand','school_admin','admin')`),
]);

// ─── Drizzle type exports ─────────────────────────────────────────────────────

export type Athlete            = typeof athletes.$inferSelect;
export type NewAthlete         = typeof athletes.$inferInsert;
export type AthleteSnapshot    = typeof athleteSnapshots.$inferSelect;
export type NewAthleteSnapshot = typeof athleteSnapshots.$inferInsert;
export type AthleteCurrent     = typeof athletesCurrent.$inferSelect;
export type Deal               = typeof deals.$inferSelect;
export type NewDeal            = typeof deals.$inferInsert;
export type ChatMessage            = typeof chatMessages.$inferSelect;
export type NewChatMessage         = typeof chatMessages.$inferInsert;
export type ConnectedAccount       = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount    = typeof connectedAccounts.$inferInsert;
export type AccountRole            = typeof accountRoles.$inferSelect;
export type SocialAnalyticsSnapshot    = typeof socialAnalyticsSnapshots.$inferSelect;
export type NewSocialAnalyticsSnapshot = typeof socialAnalyticsSnapshots.$inferInsert;
export type MediaAsset             = typeof mediaAssets.$inferSelect;
export type NewMediaAsset          = typeof mediaAssets.$inferInsert;
export type MediaBackfillState     = typeof mediaBackfillState.$inferSelect;
export type GenerationJob          = typeof generationJobs.$inferSelect;
export type NewGenerationJob       = typeof generationJobs.$inferInsert;
export type ContentPost            = typeof contentPosts.$inferSelect;
export type NewContentPost         = typeof contentPosts.$inferInsert;
export type PendingAction          = typeof pendingActions.$inferSelect;
export type NewPendingAction       = typeof pendingActions.$inferInsert;
export type AgentAction            = typeof agentActions.$inferSelect;
export type AthleteAsserted        = typeof athleteAsserted.$inferSelect;
export type NewAthleteAsserted     = typeof athleteAsserted.$inferInsert;
export type NewAgentAction         = typeof agentActions.$inferInsert;

// ─── Prompt registry (phase 1.4) ─────────────────────────────────────────────
// One row per VERSION of a prompt. Nothing is ever edited in place: publishing writes a new
// row and demotes the old one, so a prompt that made a decision last week is still readable
// this week. That is the whole point — a run in Langfuse is only explicable if the prompt it
// ran under can still be retrieved.
export const prompts = pgTable("prompts", {
  id:      uuid("id").primaryKey().defaultRandom(),
  // Stable dotted identifier the code asks for, e.g. "classify.system". Never renamed —
  // renaming a key silently detaches every historical version from its call site.
  key:     text("key").notNull(),
  version: integer("version").notNull(),
  body:    text("body").notNull(),
  // draft → published → archived. The resolver reads ONLY published rows, so a half-written
  // draft can sit in the table without any chance of reaching a model.
  status:  text("status").notNull().default("draft"),
  // NO `locked` column, deliberately. Money and compliance prompts — the classifier, the
  // scorer, the contract extractor — are refused live edits by LOCKED_PROMPTS in
  // server/lib/promptRegistry.ts, which is consulted BEFORE this table is queried. A column
  // here would be read by nothing, and an inert flag that looks authoritative is worse than
  // no flag: someone sets it false, expects a prompt to become editable, and nothing happens.
  // First 12 of sha1(body). Matches what evalClassifier.ts already computes for its cache
  // key, so an eval result and a registry row can be lined up by eye.
  hash:    text("hash").notNull(),
  // Why this version exists — shown beside it in the history.
  note:         text("note"),
  created_by:   text("created_by"),
  created_at:   timestamp("created_at",   { withTimezone: true }).notNull().defaultNow(),
  published_at: timestamp("published_at", { withTimezone: true }),
}, (t) => ({
  keyVersion: uniqueIndex("prompts_key_version_uq").on(t.key, t.version),
  // At most one published version per key, enforced by the DATABASE rather than by
  // application care. Two published rows would make resolution order arbitrary, and the
  // resulting bug — a prompt that changes depending on row order — is close to undebuggable.
  onePublished: uniqueIndex("prompts_one_published_uq").on(t.key).where(sql`status = 'published'`),
}));

export type Prompt    = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;

// ─── M.I.A. evaluator service (migration 0055) ──────────────────────────────────────
// Three append-only records, separate on purpose: when a score moves we must be able to say whether the INPUTS moved,
// the EVALUATOR moved, or the SCORING moved. No tenancy column — ADR-015/ADR-016 make organisational access an
// authorisation relationship resolved at the service boundary, not ownership of the intelligence row.

/** What we SENT: identity + the authoritative social block, digested. The evaluator's only Nomila-supplied input. */
export const miaEvidenceSnapshots = pgTable("mia_evidence_snapshots", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  name:            text("name").notNull(),
  sport:           text("sport").notNull(),
  social_block:    text("social_block"),
  social_sources:  jsonb("social_sources").notNull().default(sql`'[]'::jsonb`),
  /** Max observation date of Nomila-supplied evidence — the supersession ordering key, never completion time. */
  evidence_as_of:  timestamp("evidence_as_of", { withTimezone: true }).notNull(),
  digest:          text("digest").notNull(),
  /** Recorded, NEVER sent: an orchestration fact is not evidence (ADR-002). */
  trigger_reason:  text("trigger_reason").notNull(),
  built_at:        timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mia_evidence_snapshots_athlete_idx").on(t.athlete_id, t.evidence_as_of),
  index("mia_evidence_snapshots_digest_idx").on(t.athlete_id, t.digest),
]);

/** What came BACK: the provider envelope and the parsed judgements. A failed run never produces a ledger entry. */
export const miaEvaluationRuns = pgTable("mia_evaluation_runs", {
  id:                uuid("id").primaryKey().defaultRandom(),
  snapshot_id:       uuid("snapshot_id").notNull().references(() => miaEvidenceSnapshots.id, { onDelete: "cascade" }),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  status:            text("status").notNull(),
  evaluator_version: text("evaluator_version").notNull(),
  provider:          text("provider").notNull(),
  model:             text("model").notNull(),
  raw:               jsonb("raw"),
  judgements:        jsonb("judgements"),
  judgements_digest: text("judgements_digest"),
  attempt:           integer("attempt").notNull().default(1),
  cost_usd:          numeric("cost_usd", { precision: 10, scale: 4 }),
  latency_ms:        integer("latency_ms"),
  usage:             jsonb("usage"),
  error:             text("error"),
  started_at:        timestamp("started_at", { withTimezone: true }).notNull(),
  finished_at:       timestamp("finished_at", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mia_evaluation_runs_athlete_idx").on(t.athlete_id, t.created_at),
  index("mia_evaluation_runs_snapshot_idx").on(t.snapshot_id),
]);

/**
 * The judgement of record, shared by every intelligence engine and distinguished by `kind`.
 * ASSESSMENT (marketability) has no commensurable future observation; ESTIMATE / FORECAST / RECOMMENDATION do — the
 * contract types enforce that an assessment cannot be paired with an outcome to produce an error (ADR-011).
 */
export const intelligenceLedger = pgTable("intelligence_ledger", {
  id:                uuid("id").primaryKey().defaultRandom(),
  subject_type:      text("subject_type").notNull(),
  subject_id:        uuid("subject_id").notNull(),
  owner:             text("owner").notNull(),
  kind:              text("kind").notNull(),
  value:             jsonb("value").notNull(),
  confidence:        text("confidence"),  /** NULL until a band policy is versioned — see 0055. */
  versions:          jsonb("versions").notNull().default(sql`'{}'::jsonb`),
  inputs:            jsonb("inputs").notNull().default(sql`'[]'::jsonb`),
  assumptions:       jsonb("assumptions").notNull().default(sql`'[]'::jsonb`),
  evidence_as_of:    timestamp("evidence_as_of", { withTimezone: true }).notNull(),
  horizon_at:        timestamp("horizon_at", { withTimezone: true }),
  evaluation_run_id: uuid("evaluation_run_id").references(() => miaEvaluationRuns.id, { onDelete: "set null" }),
  /** Corrections supersede; rows are never updated in place. The point of the row is what we believed THEN. */
  superseded_by:     uuid("superseded_by").references((): AnyPgColumn => intelligenceLedger.id, { onDelete: "set null" }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intelligence_ledger_owner_idx").on(t.owner, t.created_at),
  index("intelligence_ledger_run_idx").on(t.evaluation_run_id),
]);

/**
 * Every model answer of an Identity Intelligence recompute, passed or rejected, with the validator's errors — so a failed
 * run can always be inspected (the ledger row is atomic: a rejected run writes none). `prompt` is stored on attempt 0
 * only (its numbered items give the cited ids their meaning; a repair prompt is that prompt + the previous answer +
 * the errors). Diagnostic history: nothing reads it to decide anything.
 */
export const identityIntelligenceAttempts = pgTable("identity_intelligence_attempts", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  run_id:             uuid("run_id").notNull(),
  athlete_id:         uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  attempt:            integer("attempt").notNull(),
  input_version:      text("input_version").notNull(),
  prompt_version:     text("prompt_version").notNull(),
  validation_version: text("validation_version").notNull(),
  model:              text("model"),
  finish_reason:      text("finish_reason"),
  prompt:             text("prompt"),
  response:           text("response").notNull(),
  errors:             jsonb("errors").notNull().default(sql`'[]'::jsonb`),
  passed:             boolean("passed").notNull(),
  created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("identity_intelligence_attempts_athlete_idx").on(t.athlete_id, t.created_at),
  index("identity_intelligence_attempts_run_idx").on(t.run_id),
]);

export type MiaEvidenceSnapshot = typeof miaEvidenceSnapshots.$inferSelect;
export type MiaEvaluationRun    = typeof miaEvaluationRuns.$inferSelect;
export type IntelligenceLedgerRow = typeof intelligenceLedger.$inferSelect;

// ─── Objectives — the live entity and its event log (PR3b-1, migration 0063; 0065 widens the action CHECK) ──
// objectives-pr3b-design.md. Three tables: the evaluator's proposal sets (immutable), the durable Objective
// (immutable fields written once; mutable fields are a projection of events), and the append-only events.
// No code path updates a proposal set or an event, and none deletes any of the three.

export const objectiveProposalSets = pgTable("objective_proposal_sets", {
  id:                     uuid("id").primaryKey().defaultRandom(),
  athlete_id:             uuid("athlete_id").notNull().references(() => athletes.id),
  as_of:                  timestamp("as_of", { withTimezone: true }).notNull(),
  spec_version:           text("spec_version").notNull(),
  canonical_sha256:       text("canonical_sha256").notNull(),
  state_as_of:            timestamp("state_as_of", { withTimezone: true }).notNull(),
  opportunity_map_as_of:  timestamp("opportunity_map_as_of", { withTimezone: true }).notNull(),
  /** The ObjectiveProposalSet exactly as normalised. Never edited. */
  set:                    jsonb("set").notNull(),
  /** The run record (digests, usage, raw text, gate verdicts) so the set is auditable without the docs artifact. */
  record:                 jsonb("record").notNull(),
  /**
   * 0068 (L0): the structured AthleteState and OpportunityMap the evaluator was shown, byte for byte. Provenance,
   * review and audit resolve citations against these; the rendered blocks in `record` remain what was SENT.
   * Nullable only for rows written before 0068; the writer refuses a set without them.
   */
  state_snapshot:         jsonb("state_snapshot"),
  opportunity_map:        jsonb("opportunity_map"),
  created_at:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("objective_proposal_sets_athlete_idx").on(t.athlete_id, t.as_of),
]);

export const objectives = pgTable("objectives", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id),
  version:          text("version").notNull(),
  /** Derived from provenance at creation. Immutable. */
  origin:           text("origin").notNull(),
  domain:           text("domain").notNull(),
  desired_state:    jsonb("desired_state").notNull(),
  current_state:    jsonb("current_state"),
  provenance:       jsonb("provenance").notNull(),
  success:          jsonb("success").notNull(),
  horizon:          jsonb("horizon"),
  athlete_stance:   jsonb("athlete_stance"),
  confidence:       text("confidence").notNull(),
  disposition:      text("disposition").notNull(),
  lifecycle:        text("lifecycle").notNull(),
  modified_from:    jsonb("modified_from"),
  from_proposal:    jsonb("from_proposal"),
  /** 0069 (L1): strategic lineage, computed at creation, immutable. NULL only for rows created before L1. */
  lineage:          jsonb("lineage"),
  /** 0070 (L2): the deferral's kind while deferred; NULL before L2 is read as `information`. */
  deferral:         jsonb("deferral"),
  proposal_set_id:  uuid("proposal_set_id").references(() => objectiveProposalSets.id),
  /** The proposal's key within its set — with proposal_set_id, one row per proposal, ever. */
  proposal_key:     text("proposal_key"),
  superseded_by:    uuid("superseded_by").references((): AnyPgColumn => objectives.id),
  /** The Objective exactly as created. Immutable. The rebuild test folds the events over this and expects the row. */
  created_snapshot: jsonb("created_snapshot").notNull(),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull(),
  reviewed_at:      timestamp("reviewed_at", { withTimezone: true }),
  activated_at:     timestamp("activated_at", { withTimezone: true }),
  closed_at:        timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  check("objectives_origin_check", sql`${t.origin} IN ('athlete','nomila','joint')`),
  check("objectives_disposition_check", sql`${t.disposition} IN ('unreviewed','accepted','declined','deferred','modified')`),
  check("objectives_lifecycle_check", sql`${t.lifecycle} IN ('proposed','active','achieved','abandoned','superseded')`),
  check("objectives_active_needs_yes", sql`${t.lifecycle} <> 'active' OR ${t.disposition} IN ('accepted','modified')`),
  index("objectives_athlete_live_idx").on(t.athlete_id, t.lifecycle, t.disposition),
  uniqueIndex("objectives_one_per_proposal").on(t.proposal_set_id, t.proposal_key).where(sql`${t.proposal_set_id} IS NOT NULL`),
]);

export const objectiveEvents = pgTable("objective_events", {
  id:             uuid("id").primaryKey().defaultRandom(),
  objective_id:   uuid("objective_id").notNull().references(() => objectives.id),
  athlete_id:     uuid("athlete_id").notNull().references(() => athletes.id),
  at:             timestamp("at", { withTimezone: true }).notNull(),
  /** ADR-015: the USER who acted. NULL only for the system (materialisation). */
  actor_user_id:  uuid("actor_user_id").references(() => users.id),
  actor_role:     text("actor_role").notNull(),
  action:         text("action").notNull(),
  /** Her words, verbatim. */
  said:           text("said"),
  delta:          jsonb("delta"),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("objective_events_role_check", sql`${t.actor_role} IN ('athlete','admin','system')`),
  // 0065 widened this with reconciliation's three system events (PR3b-2).
  // 0069 widened this again with reconciliation 2.0's three findings (L1).
  // 0079 widened this with change_assessed, the saved change assessment of her wording edit (Slice 3 B), and
  // success_confirmed, her answer keeping her success line (Slice 3 A).
  check("objective_events_action_check", sql`${t.action} IN ('presented','created','accept','modify','decline','defer','abandon','achieve','supersede','reaffirmed_by_run','re_proposed_while_declined','re_surfaced','spans_live','splits_live','may_relate','change_assessed','success_confirmed')`),
  check("objective_events_system_has_no_user", sql`(${t.actor_role} = 'system') = (${t.actor_user_id} IS NULL)`),
  index("objective_events_objective_idx").on(t.objective_id, t.at),
]);

export type ObjectiveProposalSetRow = typeof objectiveProposalSets.$inferSelect;
export type ObjectiveRow            = typeof objectives.$inferSelect;
export type ObjectiveEventRow       = typeof objectiveEvents.$inferSelect;

// ─── Studio identity profile (PR 17; migrations/0067_identity_profile.sql) ──────────────────────
// One row per athlete: which of her photographs make up her identity PACK and what was MEASURED
// about it. Asset ids and numbers only — NEVER an embedding, template, crop or box on this row
// (qa/identity.ts, "Legal"). `control_passed` is the only thing that lets her band be asserted.
export const identityProfiles = pgTable("identity_profiles", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  /** [{ assetId, faceSizeFrac, prominence, faceVisibility }] — server/studio/identity/profile.ts. */
  pack:                jsonb("pack"),
  band_min:            numeric("band_min"),
  band_max:            numeric("band_max"),
  band_pairs:          integer("band_pairs"),
  band_measured_at:    timestamp("band_measured_at", { withTimezone: true }),
  /** True only when every stranger distance landed above band_max; null until the control ran. */
  control_passed:      boolean("control_passed"),
  control_measured_at: timestamp("control_measured_at", { withTimezone: true }),
  embedder:            text("embedder"),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("identity_profiles_athlete_unique").on(t.athlete_id),
]);

export type IdentityProfileRow = typeof identityProfiles.$inferSelect;

// ─── Workflow runner (durable process layer) — see shared/schemaWorkflow.ts ─────────
export * from "./schemaWorkflow";

// ── Creative intents (migrations/0072_creative_intents.sql) ─────────────────────────────────────────
// ONE creative-intent contract before conception: her words / a campaign deliverable / a planner commission, with why,
// constraints and lineage. NO mutable status — state is derived from downstream records through creative_intent_id;
// `withdrawn_at` is the only mutable column. `intent_key` is the idempotency identity.
export const creativeIntents = pgTable("creative_intents", {
  id:             uuid("id").primaryKey().defaultRandom(),
  athlete_id:     uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:        text("version").notNull(),
  intent_key:     text("intent_key").notNull(),
  source_kind:    text("source_kind").notNull(),
  source_ref:     text("source_ref").notNull(),
  purpose:        text("purpose").notNull(),
  why:            text("why"),
  audience_role:  text("audience_role"),
  brand_id:       integer("brand_id"),
  format:         jsonb("format").notNull().default(sql`'{"class":null,"quantity":null,"dueOn":null,"fixedBy":null}'::jsonb`),
  channel:        text("channel"),
  timing:         text("timing"),
  constraints:    jsonb("constraints").notNull().default(sql`'[]'::jsonb`),
  ask:            jsonb("ask"),
  lineage:        jsonb("lineage").notNull().default(sql`'{}'::jsonb`),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  withdrawn_at:   timestamp("withdrawn_at", { withTimezone: true }),
}, (table) => [
  check("creative_intents_source_kind_check", sql`${table.source_kind} IN ('planner','campaign','athlete')`),
  uniqueIndex("creative_intents_athlete_key").on(table.athlete_id, table.intent_key),
  index("idx_creative_intents_athlete_created").on(table.athlete_id, table.created_at.desc()),
]);

// Creative Intelligence's output for one intent: the existing BriefProposal shape and its InferenceFlags, versioned per
// intent, confirmed by the athlete. A confirmation may establish `confirmed_format_class` when the ask fixed none.
export const creativeInterpretations = pgTable("creative_interpretations", {
  id:                     uuid("id").primaryKey().defaultRandom(),
  athlete_id:             uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  creative_intent_id:     uuid("creative_intent_id").notNull().references(() => creativeIntents.id, { onDelete: "cascade" }),
  version:                integer("version").notNull().default(1),
  supersedes:             uuid("supersedes"),
  source_tool:            text("source_tool").notNull(),
  proposal:               jsonb("proposal").notNull(),
  flags:                  jsonb("flags").notNull().default(sql`'[]'::jsonb`),
  created_at:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmed_at:           timestamp("confirmed_at", { withTimezone: true }),
  confirmed_concept:      jsonb("confirmed_concept"),
  confirmed_format_class: text("confirmed_format_class"),
  confirmed_flags:        jsonb("confirmed_flags"),
}, (table) => [
  index("idx_creative_interpretations_intent").on(table.creative_intent_id, table.version.desc()),
]);

// ── Campaigns (migrations/0073_campaigns.sql; #570 C1 as amended) ───────────────────────────────────
export const campaigns = pgTable("campaigns", {
  id:                      uuid("id").primaryKey().defaultRandom(),
  athlete_id:              uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:                 text("version").notNull(),
  origin_door:             text("origin_door").notNull(),
  /** The origin's sentence. Never rewritten by Nomila (#570 §7). */
  purpose:                 text("purpose").notNull(),
  recommendation_ids:      jsonb("recommendation_ids").notNull().default(sql`'[]'::jsonb`),
  objective_ids:           jsonb("objective_ids").notNull().default(sql`'[]'::jsonb`),
  deal_ids:                jsonb("deal_ids").notNull().default(sql`'[]'::jsonb`),
  brand_ids:               jsonb("brand_ids").notNull().default(sql`'[]'::jsonb`),
  participant_athlete_ids: jsonb("participant_athlete_ids").notNull().default(sql`'[]'::jsonb`),
  /** The RESOLVED reason to end: { startsOn, endsOn, endsWith, endsRef } (Amendment 1). Never from prose. */
  period:                  jsonb("period").notNull(),
  evidence:                jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
  status:                  text("status").notNull(),
  ended_because:           text("ended_because"),
  current_spec_version:    integer("current_spec_version").notNull().default(1),
  created_at:              timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  started_at:              timestamp("started_at", { withTimezone: true }),
  ended_at:                timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  check("campaigns_origin_door_check", sql`${table.origin_door} IN ('recommendation','deal','athlete','observed')`),
  check("campaigns_status_check", sql`${table.status} IN ('planning','approved','ended')`),
  check("campaigns_ended_because_check", sql`${table.ended_because} IS NULL OR ${table.ended_because} IN ('fulfilled','expired','cancelled')`),
  index("idx_campaigns_athlete_created").on(table.athlete_id, table.created_at.desc()),
]);

// Immutable versioned scope. Approval is the trigger for creative materialisation; it authorizes nothing else.
export const campaignSpecs = pgTable("campaign_specs", {
  id:              uuid("id").primaryKey().defaultRandom(),
  campaign_id:     uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:         integer("version").notNull(),
  purpose:         text("purpose").notNull(),
  /** The deliverables in scope for this version, by campaign_deliverables id — identity spans versions. */
  deliverable_ids: jsonb("deliverable_ids").notNull().default(sql`'[]'::jsonb`),
  period:          jsonb("period").notNull(),
  constraints:     jsonb("constraints").notNull().default(sql`'[]'::jsonb`),
  approval:        text("approval").notNull().default("draft"),
  provenance:      jsonb("provenance").notNull(),
  supersedes:      integer("supersedes"),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approved_at:     timestamp("approved_at", { withTimezone: true }),
  approved_by:     text("approved_by"),
}, (table) => [
  check("campaign_specs_approval_check", sql`${table.approval} IN ('draft','athlete','brand','contractual')`),
  unique("campaign_specs_campaign_version_unique").on(table.campaign_id, table.version),
]);

// Tracked obligations whose identity spans spec versions (introduced in one, superseded by a later one). Only
// category `content` ever becomes a CreativeIntent; everything else is tracked here and never briefed.
export const campaignDeliverables = pgTable("campaign_deliverables", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  campaign_id:         uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  introduced_version:  integer("introduced_version").notNull(),
  superseded_version:  integer("superseded_version"),
  seq:                 integer("seq").notNull(),
  /** DeliverableIntent (#570 §4.1): category, contentFormat?, sourceQuote, quantity, dueOn, optional, brandId?. */
  intent:              jsonb("intent").notNull(),
  status:              text("status").notNull().default("open"),
  deal_deliverable_id: uuid("deal_deliverable_id"),
  /** 0075: an external confirmation IS an outcome observation — who confirmed it, when, and what it points at. */
  confirmed_by:        text("confirmed_by"),
  confirmed_at:        timestamp("confirmed_at", { withTimezone: true }),
  confirmation_ref:    text("confirmation_ref"),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  superseded_at:       timestamp("superseded_at", { withTimezone: true }),
}, (table) => [
  check("campaign_deliverables_status_check", sql`${table.status} IN ('open','fulfilled','waived','cancelled')`),
  index("idx_campaign_deliverables_campaign").on(table.campaign_id, table.introduced_version, table.seq),
]);

// ── Published asset identities (migrations/0075_outcome_observation_links.sql) ──────────────────────
// THE PUBLISH → OBSERVATION JOIN. A Studio-published asset and the metric observations ingested for that post were
// unconnectable: publishing records the platform's media id on the publish job, observations are keyed by the platform's
// own entity id. One row per (asset, platform) publication, from the platform's OWN id where there is one; `source` says
// how the identity was established so a weaker association is never mistaken for the authoritative one. No metric value
// is copied — social_metric_observations stays authoritative. Deliberately NOT media_assets.source_media_id: that column
// belongs to ingest, and a generated asset carrying one would read as a connected post.
export const publishedAssetIdentities = pgTable("published_asset_identities", {
  id:                uuid("id").primaryKey().defaultRandom(),
  athlete_id:        uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  asset_id:          uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  platform:          text("platform").notNull(),
  platform_media_id: text("platform_media_id"),
  permalink:         text("permalink"),
  publish_job_id:    uuid("publish_job_id"),
  source:            text("source").notNull(),
  recorded_at:       timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("published_asset_identities_source_check", sql`${table.source} IN ('platform_media_id','provider_mapping','permalink')`),
  check("published_asset_identities_has_identity", sql`${table.platform_media_id} IS NOT NULL OR ${table.permalink} IS NOT NULL`),
  uniqueIndex("published_asset_identities_asset_platform").on(table.asset_id, table.platform),
  uniqueIndex("published_asset_identities_platform_media").on(table.platform, table.platform_media_id).where(sql`platform_media_id IS NOT NULL`),
  index("idx_published_asset_identities_athlete").on(table.athlete_id, table.recorded_at.desc()),
]);

// ─── Her picks: the athlete's product shelf (0096; docs/design/shop-her-picks.md) ────────────────────────────
// Model A only: every link is HERS (her Amazon tag, LTK, ShopMy, a brand code, any shop link), stored and redirected
// exactly as she gave it. Nomila holds no affiliate account, takes nothing and moves no money — there is no
// commission or payout table, by design. Named shop_* because "product" already means the Studio product photo,
// the Studio edit op and product-as-compensation.

/** One pick on her shelf. `blurb` is HER words only; `blurb_suggestion` (Mila's) is never public. */
export const shopItems = pgTable("shop_items", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // The opaque code in /go/<code> — never an item or athlete id.
  code:                text("code").notNull(),
  // Her link exactly as she gave it (http/https only).
  url:                 text("url").notNull(),
  url_host:            text("url_host").notNull(),
  // amazon | shopify | ltk | shopmy | link — display only. No CHECK: the list grows (route-validated).
  source:              text("source").notNull(),
  network_tag:         text("network_tag"),
  title:               text("title").notNull(),
  image_url:           text("image_url"),
  price_cents:         integer("price_cents"),
  currency:            text("currency"),
  merchant:            text("merchant"),
  // No CHECK: the category list grows; the route validates.
  category:            text("category"),
  blurb:               text("blurb"),
  blurb_suggestion:    text("blurb_suggestion"),
  discount_code:       text("discount_code"),
  status:              text("status").notNull().default("draft"),
  position:            integer("position").notNull().default(0),
  warnings_ack_at:     timestamp("warnings_ack_at", { withTimezone: true }),
  published_at:        timestamp("published_at", { withTimezone: true }),
  metadata_fetched_at: timestamp("metadata_fetched_at", { withTimezone: true }),
  // 0100: a pick she chose from a brand's catalog (the Shopify catalog app). NULL for a pasted link; SET NULL when the
  // brand's catalog row goes (uninstall / product deleted) — her pick keeps its plain link.
  catalog_product_id:  uuid("catalog_product_id").references((): AnyPgColumn => shopCatalogProducts.id, { onDelete: "set null" }),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("shop_items_status_check", sql`${table.status} IN ('draft','live','hidden')`),
  uniqueIndex("shop_items_code_uq").on(table.code),
  uniqueIndex("shop_items_athlete_url_uq").on(table.athlete_id, table.url),
  index("idx_shop_items_athlete").on(table.athlete_id, table.position),
]);

/** Clicks per pick per day — the whole of the analytics. No IP, user agent or referrer is ever stored. */
export const shopClickDays = pgTable("shop_click_days", {
  item_id: uuid("item_id").notNull().references(() => shopItems.id, { onDelete: "cascade" }),
  day:     date("day").notNull(),
  clicks:  integer("clicks").notNull().default(0),
}, (table) => [
  primaryKey({ name: "shop_click_days_pk", columns: [table.item_id, table.day] }),
]);

/** Her answers that open the shelf (all self-declared), one row per athlete. */
export const shopSettings = pgTable("shop_settings", {
  athlete_id:             uuid("athlete_id").primaryKey().references(() => athletes.id, { onDelete: "cascade" }),
  adult_confirmed_at:     timestamp("adult_confirmed_at", { withTimezone: true }),
  // NULL = not answered yet. Never inferred from nationality or anything else.
  international_student:  boolean("international_student"),
  international_ack_at:   timestamp("international_ack_at", { withTimezone: true }),
  supplements_opt_in_at:  timestamp("supplements_opt_in_at", { withTimezone: true }),
  // What SHE told us; optional. No list of schools or sponsors exists in code.
  school_apparel_sponsor: text("school_apparel_sponsor"),
  created_at:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:             timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── The Shopify catalog app (0100; docs/design/shop-her-picks.md §12) ──────────────────────────────────────────
// Catalog only: scope read_products, no orders, no customers, no money. A brand installs the app on its store; its
// products land in shop_catalog_products; the brand approves which athletes may feature them (shop_brand_approvals).

/** One installed (or once-installed) store. Brand data, not athlete data. The token is ALWAYS a kms1: envelope. */
export const shopifyShops = pgTable("shopify_shops", {
  id:             uuid("id").primaryKey().defaultRandom(),
  // <name>.myshopify.com — Shopify's own id for the store.
  shop_domain:    text("shop_domain").notNull(),
  primary_domain: text("primary_domain"),
  name:           text("name"),
  brand_id:       integer("brand_id").references(() => inboxBrands.id),
  // Sealed with tokenCrypto (kms1:…) — never plaintext; NULL once uninstalled.
  access_token:   text("access_token"),
  scopes:         text("scopes"),
  status:         text("status").notNull().default("installed"),
  installed_at:   timestamp("installed_at", { withTimezone: true }),
  uninstalled_at: timestamp("uninstalled_at", { withTimezone: true }),
  last_synced_at: timestamp("last_synced_at", { withTimezone: true }),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("shopify_shops_domain_uq").on(table.shop_domain),
  check("shopify_shops_status_check", sql`${table.status} IN ('installed','uninstalled')`),
  check("shopify_shops_token_sealed_check", sql`${table.access_token} IS NULL OR ${table.access_token} LIKE 'kms1:%'`),
]);

/** A brand's product, as its store reports it. Shared brand data. */
export const shopCatalogProducts = pgTable("shop_catalog_products", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  shop_id:            uuid("shop_id").notNull().references(() => shopifyShops.id, { onDelete: "cascade" }),
  shopify_product_id: text("shopify_product_id").notNull(),
  handle:             text("handle").notNull(),
  title:              text("title").notNull(),
  vendor:             text("vendor"),
  product_type:       text("product_type"),
  product_url:        text("product_url").notNull(),
  image_url:          text("image_url"),
  price_cents:        integer("price_cents"),
  currency:           text("currency"),
  available:          boolean("available").notNull().default(true),
  // Shopify's own status (active / draft / archived) — no CHECK: Shopify's vocabulary, not ours.
  product_status:     text("product_status"),
  synced_at:          timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("shop_catalog_products_shop_product_uq").on(table.shop_id, table.shopify_product_id),
  index("idx_shop_catalog_products_shop").on(table.shop_id, table.title),
]);

/** Whether a brand lets her feature its products, and the code it gave her. Hers (manifest). */
export const shopBrandApprovals = pgTable("shop_brand_approvals", {
  id:           uuid("id").primaryKey().defaultRandom(),
  shop_id:      uuid("shop_id").notNull().references(() => shopifyShops.id, { onDelete: "cascade" }),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  status:       text("status").notNull().default("pending"),
  code:         text("code"),
  requested_at: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decided_at:   timestamp("decided_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("shop_brand_approvals_shop_athlete_uq").on(table.shop_id, table.athlete_id),
  check("shop_brand_approvals_status_check", sql`${table.status} IN ('pending','approved','declined','revoked')`),
]);

// ─── Public Nomi Card (0101; design-public-card-v3 §10–§11) ───────────────────────────────────────────────────
// Her public profile serves ONE thing: the frozen snapshot she published. Nothing on the public path reads any other
// table (publicCardReader.ts + its boundary test). Dark behind PUBLIC_CARD (off everywhere).

/** One per athlete: her handle, publish state, her draft decisions and her switches. */
export const publicCards = pgTable("public_cards", {
  athlete_id:        uuid("athlete_id").primaryKey().references(() => athletes.id, { onDelete: "cascade" }),
  // Lower-case, 3–30 of a-z 0-9 and single inner hyphens (route- and service-validated; the CHECK is the backstop).
  // NULL until she picks one (or the first publish proposes one from her name).
  handle:            text("handle").unique(),
  // When she last CHANGED it (the first pick is free): one change per 30 days.
  handle_changed_at: timestamp("handle_changed_at", { withTimezone: true }),
  status:            text("status").notNull().default("draft"),   // draft | published | unpublished
  // The version the public URL serves. Set iff status = 'published'.
  published_version: integer("published_version"),
  // The highest version ever written. Versions never repeat, even after unpublish deletes the snapshots.
  last_version:      integer("last_version").notNull().default(0),
  // Her review decisions (approve / hide / order / titles / chosen stats). Never public; the draft builder reads it.
  draft:             jsonb("draft").notNull().default({}),
  // Her switches. Partner, Ask Mila and Create are on until she turns them off; Book and Shop wait until she is ready.
  door_partner:      boolean("door_partner").notNull().default(true),
  door_book:         boolean("door_book").notNull().default(false),
  door_shop:         boolean("door_shop").notNull().default(false),
  door_create:       boolean("door_create").notNull().default(true),
  door_ask_mila:     boolean("door_ask_mila").notNull().default(true),
  // Her M.I.A. number and band on Highlights (owner decision 8 Oct: her choice, off by default).
  show_mia:          boolean("show_mia").notNull().default(false),
  // "Let search engines find my card": noindex unless she turns it on.
  indexable:         boolean("indexable").notNull().default(false),
  published_at:      timestamp("published_at", { withTimezone: true }),
  unpublished_at:    timestamp("unpublished_at", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("public_cards_status_check", sql`${table.status} IN ('draft','published','unpublished')`),
  check("public_cards_handle_check", sql`${table.handle} IS NULL OR ${table.handle} ~ '^[a-z0-9](-?[a-z0-9])+$' AND length(${table.handle}) BETWEEN 3 AND 30`),
  check("public_cards_published_check", sql`(${table.status} = 'published') = (${table.published_version} IS NOT NULL)`),
]);

/**
 * Immutable, versioned copies of exactly what is public. `content` is the page (no internal ids); `sources` is the
 * manifest of where every item came from (never served). kind: full (her publish) · numbers_only (a stat refresh) ·
 * removal (something was pulled; removals never add). No code updates a row (publicCard.boundary.test.ts).
 */
export const publicCardSnapshots = pgTable("public_card_snapshots", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:             integer("version").notNull(),
  kind:                text("kind").notNull().default("full"),
  content:             jsonb("content").notNull(),
  sources:             jsonb("sources").notNull(),
  // Server-only: each published media key → the stored object it stands for ({ path, kind }). The media proxy
  // (/p/:handle/m/:key) reads ONE entry of it for the published version; the page only ever sees the opaque key.
  media:               jsonb("media").notNull().default({}),
  // sha256 of the canonical content JSON (the ETag seed).
  content_sha256:      text("content_sha256").notNull(),
  // Why a removal happened, in words she is shown. NULL for her own publishes.
  note:                text("note"),
  // Who tapped Publish. NULL for a removal or a numbers refresh (no tap involved).
  approved_by_user_id: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  published_at:        timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("public_card_snapshots_athlete_version_uq").on(table.athlete_id, table.version),
  check("public_card_snapshots_kind_check", sql`${table.kind} IN ('full','numbers_only','removal')`),
  check("public_card_snapshots_version_check", sql`${table.version} > 0`),
]);

/** Her old handles, each redirecting to her current one for 90 days and closed to everyone else until then. */
export const publicCardHandleRedirects = pgTable("public_card_handle_redirects", {
  handle:     text("handle").primaryKey(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_public_card_handle_redirects_athlete").on(table.athlete_id),
]);

export type PublicCard          = typeof publicCards.$inferSelect;
export type PublicCardSnapshot  = typeof publicCardSnapshots.$inferSelect;
export type PublicCardRedirect  = typeof publicCardHandleRedirects.$inferSelect;
// ─── Partner intake (public profile: brand + press requests, relay threads, Serious offer; migrations/0103) ───

/** What a visitor chose on the Partner door ("What kind of request?"). Mapped to the deal vocabulary in code. */
export const PARTNER_REQUEST_KINDS = ["sponsorship", "content", "endorsement", "appearance", "press", "other"] as const;
export type PartnerRequestKind = typeof PARTNER_REQUEST_KINDS[number];

/**
 * One request sent to her from her public profile (brand or press). Drafted by the visitor, confirmed by an email
 * link, then it lands on her board as a deal (source 'public_profile') with its thread on the opportunity. Tokens are
 * never stored: only their SHA-256 (draft, confirm, status, reply-to); the confirm/status/reply tokens are derived
 * from token_nonce with the server key, so a later notice can link the same status page. Hers (manifest).
 */
export const partnerRequests = pgTable("partner_requests", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  athlete_id:           uuid("athlete_id").notNull().references(() => athletes.id),
  public_ref:           text("public_ref").notNull(),
  kind:                 text("kind").notNull(),
  status:               text("status").notNull().default("drafting"),
  // Her decision, by her tap: agreed (the hold is captured toward the first payment) or declined (released).
  outcome:              text("outcome"),
  snapshot_version:     integer("snapshot_version"),
  website:              text("website"),
  domain:               text("domain"),
  // The brand's name (press: the outlet), as the visitor gave it.
  brand_name:           text("brand_name").notNull(),
  // Her first name as her published card showed it to the visitor ("[First]" in every visitor email and page).
  display_name:         text("display_name").notNull(),
  site_meta:            jsonb("site_meta"),
  fit_preview:          jsonb("fit_preview"),
  brief:                jsonb("brief").notNull(),
  contact_name:         text("contact_name"),
  contact_email:        text("contact_email"),
  contact_email_hash:   text("contact_email_hash").notNull(),
  email_domain_match:   boolean("email_domain_match").notNull().default(false),
  draft_token_hash:     text("draft_token_hash").notNull(),
  token_nonce:          text("token_nonce").notNull(),
  confirm_token_hash:   text("confirm_token_hash"),
  status_token_hash:    text("status_token_hash"),
  reply_token_hash:     text("reply_token_hash"),
  deal_id:              uuid("deal_id").references(() => deals.id),
  inbox_thread_id:      uuid("inbox_thread_id").references(() => inboxThreads.id),
  expires_at:           timestamp("expires_at", { withTimezone: true }).notNull(),
  sent_at:              timestamp("sent_at", { withTimezone: true }),
  confirmed_at:         timestamp("confirmed_at", { withTimezone: true }),
  brief_seen_at:        timestamp("brief_seen_at", { withTimezone: true }),
  first_reply_at:       timestamp("first_reply_at", { withTimezone: true }),
  decided_at:           timestamp("decided_at", { withTimezone: true }),
  contact_redacted_at:  timestamp("contact_redacted_at", { withTimezone: true }),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("partner_requests_public_ref_uq").on(table.public_ref),
  uniqueIndex("partner_requests_draft_token_uq").on(table.draft_token_hash),
  uniqueIndex("partner_requests_confirm_token_uq").on(table.confirm_token_hash).where(sql`confirm_token_hash IS NOT NULL`),
  uniqueIndex("partner_requests_status_token_uq").on(table.status_token_hash).where(sql`status_token_hash IS NOT NULL`),
  uniqueIndex("partner_requests_reply_token_uq").on(table.reply_token_hash).where(sql`reply_token_hash IS NOT NULL`),
  uniqueIndex("partner_requests_deal_uq").on(table.deal_id).where(sql`deal_id IS NOT NULL`),
  index("idx_partner_requests_athlete_status").on(table.athlete_id, table.status),
  index("idx_partner_requests_email_hash").on(table.contact_email_hash),
  index("idx_partner_requests_status_expires").on(table.status, table.expires_at),
  check("partner_requests_kind_check", sql`${table.kind} IN ('sponsorship','content','endorsement','appearance','press','other')`),
  check("partner_requests_status_check", sql`${table.status} IN ('drafting','awaiting_email','confirmed','expired')`),
  check("partner_requests_outcome_check", sql`${table.outcome} IS NULL OR (${table.outcome} IN ('agreed','declined') AND ${table.status} = 'confirmed' AND ${table.decided_at} IS NOT NULL)`),
  check("partner_requests_confirmed_check", sql`${table.status} <> 'confirmed' OR (${table.deal_id} IS NOT NULL AND ${table.confirmed_at} IS NOT NULL AND ${table.status_token_hash} IS NOT NULL)`),
]);

export type PartnerRequest = typeof partnerRequests.$inferSelect;

/** Her Partner settings: the Serious offer switch and amount (on by default, $50). Hers (manifest). */
export const partnerSettings = pgTable("partner_settings", {
  athlete_id:            uuid("athlete_id").primaryKey().references(() => athletes.id),
  serious_offer_enabled: boolean("serious_offer_enabled").notNull().default(true),
  serious_offer_cents:   integer("serious_offer_cents").notNull().default(5000),
  updated_at:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("partner_settings_amount_check", sql`${table.serious_offer_cents} IN (5000,10000,15000,25000)`),
]);

/** The light read of a brand's homepage (title, description, og tags), cached 7 days. Brand data, no athlete. */
export const brandSitePreviews = pgTable("brand_site_previews", {
  domain:     text("domain").primaryKey(),
  readable:   boolean("readable").notNull(),
  site_meta:  jsonb("site_meta"),
  fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mila's first read ("why she fits"), cached by (athlete, published card version, domain) for 7 days. Hers. */
export const partnerFitPreviews = pgTable("partner_fit_previews", {
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id),
  snapshot_version: integer("snapshot_version").notNull(),
  domain:           text("domain").notNull(),
  lines:            jsonb("lines").notNull(),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.athlete_id, table.snapshot_version, table.domain] }),
]);

/** Database-backed rate counters for public routes (keyed hashes only; no IP is stored). */
export const publicRateCounters = pgTable("public_rate_counters", {
  bucket:       text("bucket").notNull(),
  window_start: timestamp("window_start", { withTimezone: true }).notNull(),
  count:        integer("count").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.bucket, table.window_start] }),
]);

/** A 6-digit email code a visitor asked for ("Your requests", the forwarded-link re-check). Hashes only. */
export const partnerVisitorCodes = pgTable("partner_visitor_codes", {
  id:         uuid("id").primaryKey().defaultRandom(),
  email_hash: text("email_hash").notNull(),
  code_hash:  text("code_hash").notNull(),
  attempts:   integer("attempts").notNull().default(0),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  used_at:    timestamp("used_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_partner_visitor_codes_email").on(table.email_hash, table.created_at),
]);

// ─── Ask Mila on the public card (0104; design-public-card-v3 §4, PR 5) ───────────────────────────────────────
// A visitor's chat with Mila in PUBLIC MODE on /p/:handle. Dark behind ASK_MILA_PUBLIC (+ PUBLIC_CARD), off everywhere.
// No IP, no user agent, no visitor identity is stored with a chat: the only visitor key is a DAILY-SALTED hash in the
// counter table below, which cannot be linked across days. Chats are kept 90 days; she can read and delete them.

/** One visitor chat on her card. The session token is stored only as its sha256 (the visitor holds the token). */
export const askMilaSessions = pgTable("ask_mila_sessions", {
  id:               uuid("id").primaryKey().defaultRandom(),
  athlete_id:       uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // The published version the chat opened on (Mila answers from whichever version is published at each turn).
  snapshot_version: integer("snapshot_version").notNull(),
  intent:           text("intent").notNull().default("ask"),           // ask | partner | book | shop
  token_sha256:     text("token_sha256").notNull(),
  // Visitor turns taken (a turn = one visitor message and Mila's answer). Capped by ASK_MILA.sessionMaxTurns.
  turn_count:       integer("turn_count").notNull().default(0),
  status:           text("status").notNull().default("open"),          // open | ended
  ended_reason:     text("ended_reason"),                              // idle | turn_limit
  started_at:       timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  last_turn_at:     timestamp("last_turn_at", { withTimezone: true }).notNull().defaultNow(),
  ended_at:         timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  index("idx_ask_mila_sessions_athlete_started").on(table.athlete_id, table.started_at),
  index("idx_ask_mila_sessions_started").on(table.started_at),
  check("ask_mila_sessions_intent_check", sql`${table.intent} IN ('ask','partner','book','shop')`),
  check("ask_mila_sessions_status_check", sql`${table.status} IN ('open','ended')`),
  check("ask_mila_sessions_ended_check", sql`(${table.status} = 'ended') = (${table.ended_at} IS NOT NULL) AND (${table.ended_reason} IS NULL OR ${table.ended_reason} IN ('idle','turn_limit'))`),
  check("ask_mila_sessions_turns_check", sql`${table.turn_count} >= 0`),
]);

/**
 * The transcript, one row per message. `text` is exactly what the visitor typed or what the visitor was shown (Mila's
 * answer AFTER the output gate). A blocked draft is never stored: `gate` records only that it was blocked and why.
 */
export const askMilaTurns = pgTable("ask_mila_turns", {
  id:         uuid("id").primaryKey().defaultRandom(),
  session_id: uuid("session_id").notNull().references(() => askMilaSessions.id, { onDelete: "cascade" }),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  seq:        integer("seq").notNull(),
  role:       text("role").notNull(),                                  // visitor | mila
  text:       text("text").notNull(),
  // The published chapter Mila's answer came from (its key), when it came from one.
  chapter:    text("chapter"),
  // A structured card shown with the answer (picks, published times, a request to tap). Ids from her snapshot only.
  widget:     jsonb("widget"),
  // Mila rows only: passed | blocked:<reason> | limited | error.
  gate:       text("gate"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("ask_mila_turns_session_seq_uq").on(table.session_id, table.seq),
  index("idx_ask_mila_turns_athlete_created").on(table.athlete_id, table.created_at),
  check("ask_mila_turns_role_check", sql`${table.role} IN ('visitor','mila')`),
  check("ask_mila_turns_text_check", sql`length(${table.text}) BETWEEN 1 AND 2000`),
]);

/** Visitor turns per day, keyed by a DAILY-SALTED hash of the IP (the salt changes every UTC day). The limit's only use. */
export const askMilaVisitorDays = pgTable("ask_mila_visitor_days", {
  day:          date("day").notNull(),
  visitor_hash: text("visitor_hash").notNull(),
  turns:        integer("turns").notNull().default(0),
}, (table) => [
  primaryKey({ name: "ask_mila_visitor_days_pk", columns: [table.day, table.visitor_hash] }),
]);

/** Turns per athlete per day (every visitor on her card together). */
export const askMilaAthleteDays = pgTable("ask_mila_athlete_days", {
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  day:        date("day").notNull(),
  turns:      integer("turns").notNull().default(0),
}, (table) => [
  primaryKey({ name: "ask_mila_athlete_days_pk", columns: [table.athlete_id, table.day] }),
]);

/** The global daily spend of public Mila, in micro-dollars, against ASK_MILA_DAILY_SPEND_CAP_USD. No athlete column. */
export const askMilaSpendDays = pgTable("ask_mila_spend_days", {
  day:        date("day").primaryKey(),
  turns:      integer("turns").notNull().default(0),
  micro_usd:  bigint("micro_usd", { mode: "number" }).notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AskMilaSession = typeof askMilaSessions.$inferSelect;
export type AskMilaTurn    = typeof askMilaTurns.$inferSelect;

// ─── Agent harness (0105) ─────────────────────────────────────────────────────────────────────────────────────────
// The new agent's own tables (agent build plan v2; the contract is shared/agent.ts). CLEAN START: nothing is migrated
// into them. agent_runs is the trace of every run; the four memory_* tables are the four memory layers. Everything is
// keyed by athlete_id and goes with the account (athleteDataManifest). Nothing here names an athlete, sport or brand.

/** One run of the agent: skill, model, status, what it cost, and its trace (steps / tools called / evidence read). */
export const agentRuns = pgTable("agent_runs", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  skill_id:            text("skill_id").notNull(),
  skill_version:       text("skill_version").notNull(),
  trigger:             text("trigger").notNull(),                       // chat | schedule | event | approval | test
  provider:            text("provider").notNull(),                      // openai | gemini
  model:               text("model").notNull(),
  effort:              text("effort").notNull(),                        // minimal | low | medium | high
  status:              text("status").notNull().default("running"),     // running | completed | failed | stopped
  stop_reason:         text("stop_reason"),                             // cost_cap_run | cost_cap_day | max_steps | policy | aborted | error
  conversation_id:     uuid("conversation_id"),
  input_tokens:        integer("input_tokens").notNull().default(0),
  cached_input_tokens: integer("cached_input_tokens").notNull().default(0),
  output_tokens:       integer("output_tokens").notNull().default(0),
  reasoning_tokens:    integer("reasoning_tokens").notNull().default(0),
  web_search_calls:    integer("web_search_calls").notNull().default(0),
  // Micro-dollars (1 USD = 1,000,000). The per-day cap sums this over her runs since UTC midnight.
  cost_micro_usd:      bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  steps:               jsonb("steps").notNull().default(sql`'[]'::jsonb`),          // TraceStep[]
  tools_called:        jsonb("tools_called").notNull().default(sql`'[]'::jsonb`),   // ToolCallRecord[]
  evidence_read:       jsonb("evidence_read").notNull().default(sql`'[]'::jsonb`),  // EvidenceRef[]
  error:               text("error"),
  // 0106: the run's structured result (a skill's JSON output) and what started it ("workflow:<run id>:<step>"), so a
  // retried workflow step reuses a finished run instead of paying for it twice.
  output:              jsonb("output"),
  parent_ref:          text("parent_ref"),
  // 0144: where the run's approval cards stand, apart from `status` (which says how the model turn itself ended, and
  // which the cost cap, the workflow reuse and the plan readers rely on). NULL = the run queued nothing for a tap.
  //   awaiting_approval  the turn ended with at least one card waiting on the athlete's tap
  //   resumed            the athlete approved; the queued tool is running
  //   completed          every card is settled and at least one approved action ran
  //   cancelled          every card was declined (nothing ran)
  //   failed             an approved action failed
  approval_state:      text("approval_state"),
  started_at:          timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  ended_at:            timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  index("idx_agent_runs_athlete_started").on(table.athlete_id, table.started_at),
  index("idx_agent_runs_parent_ref").on(table.parent_ref),
  // 0150: the platform-wide day total (server/lib/platformSpend.ts) sums every athlete's runs since UTC midnight.
  index("idx_agent_runs_started").on(table.started_at),
  check("agent_runs_trigger_check", sql`${table.trigger} IN ('chat','schedule','event','approval','test')`),
  check("agent_runs_status_check", sql`${table.status} IN ('running','completed','failed','stopped')`),
  check("agent_runs_effort_check", sql`${table.effort} IN ('minimal','low','medium','high')`),
  check("agent_runs_stop_reason_check", sql`${table.stop_reason} IS NULL OR ${table.stop_reason} IN ('cost_cap_run','cost_cap_day','max_steps','policy','aborted','error')`),
  check("agent_runs_ended_check", sql`(${table.status} = 'running') = (${table.ended_at} IS NULL)`),
  check("agent_runs_cost_check", sql`${table.cost_micro_usd} >= 0`),
  check("agent_runs_approval_state_check", sql`${table.approval_state} IS NULL OR ${table.approval_state} IN ('awaiting_approval','resumed','completed','cancelled','failed')`),
]);

// ─── Mila on TrueForge (0141, docs/design/mila-on-trueforge-step2.md) ─────────────────────────────────────────────
// Used only while MILA_TF_CHAT is on (dev). Empty and unread when it is off. TrueForge keeps the conversation itself;
// these two tables keep what is ours: which TrueForge session is which conversation, the tools' shared state across its
// turns, app events Mila has not been told yet, and what a turn's tool calls left for the app (cards, approvals, evidence).

/** One TrueForge session per app conversation. Its id is the athlete pass's `sid`. */
export const milaTfSessions = pgTable("mila_tf_sessions", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // The app's conversation (client-minted uuid). NULL: the app sent none, so the row is never reused.
  conversation_id: uuid("conversation_id"),
  tf_session_id:   text("tf_session_id").notNull(),
  // The tools' state shared across this conversation's turns: { factKeys: {F1: factId}, offeredConnectors: [], herWords: [] }.
  tool_state:      jsonb("tool_state").notNull().default(sql`'{}'::jsonb`),
  // Compare-and-set counter for tool_state, so two tool calls of one turn never overwrite each other's keys.
  state_version:   integer("state_version").notNull().default(0),
  // App events Mila has not been told yet (an approval tapped or declined), delivered with her next turn.
  pending_events:  jsonb("pending_events").notNull().default(sql`'[]'::jsonb`),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // (0147) The Mastra turn running on this conversation (agent_runs id) and when it took the row: one turn at a time per
  // conversation, across instances. A new turn takes the row and the running one stops (as TrueForge cancels a running
  // turn when another starts in its session). NULL: none running. Older than the turn timeout: stale (a dead instance).
  running_run_id:  uuid("running_run_id"),
  running_at:      timestamp("running_at", { withTimezone: true }),
  // (0147) The engine that ran this conversation's last turn ("trueforge" | "mastra"). NULL: before 0147, read from
  // tf_session_id ("mastra:" prefix = Mastra). When it changes, the new engine starts the conversation over, seeded
  // with the recent chat rows (docs/release/mila-engine-mastra-cutover.md, Rollback).
  last_engine:     text("last_engine"),
}, (table) => [
  uniqueIndex("uq_mila_tf_sessions_conversation").on(table.athlete_id, table.conversation_id),
  uniqueIndex("uq_mila_tf_sessions_tf_session").on(table.tf_session_id),
]);

/** What one turn's tool calls left for the app, taken (and deleted) by the chat endpoint when the turn ends. */
export const milaTfTurnItems = pgTable("mila_tf_turn_items", {
  id:         serial("id").primaryKey(),                                 // call order within the run
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  run_id:     uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  kind:       text("kind").notNull(),                                    // card | approval | evidence | tool
  payload:    jsonb("payload").notNull(),
}, (table) => [
  index("idx_mila_tf_turn_items_run").on(table.run_id, table.id),
  check("mila_tf_turn_items_kind_check", sql`${table.kind} IN ('card','approval','evidence','tool')`),
]);

// ─── Mila starts the conversation (0143, design "Mila on watch", 27 Oct 2026) ─────────────────────────────────────
// Used only while MILA_PROACTIVE is on (dev, off for now). Empty and unread when it is off.

/**
 * One app event Mila may act on (a deal email, a booking request, a payment …), written once per (athlete, dedupe_key):
 * a repeat of the same news is ignored. The dispatcher (server/agent/proactive) sorts it into speak_now · reminder ·
 * brief · silent and records what happened. payload holds ids and short labels only, never email text.
 */
export const athleteEvents = pgTable("athlete_events", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  kind:            text("kind").notNull(),
  dedupe_key:      text("dedupe_key").notNull(),
  payload:         jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set once the dispatcher has decided; outcome is its word (spoke, silent, brief, reminded, capped, …; the writer
  // keeps the vocabulary, no CHECK, like chat_messages.source).
  dispatched_at:   timestamp("dispatched_at", { withTimezone: true }),
  outcome:         text("outcome"),
  // Where Mila's message went (speak_now only): the chat and the chat_messages row.
  conversation_id: uuid("conversation_id"),
  message_id:      uuid("message_id"),
}, (table) => [
  uniqueIndex("uq_athlete_events_dedupe").on(table.athlete_id, table.dedupe_key),
  index("idx_athlete_events_athlete").on(table.athlete_id, table.created_at),
]);

// ─── What the athlete chose for each Mila capability (0146, design "Mila welcome flow" §4 + §12, 28 Oct 2026) ───────
// Read and written only while MILA_WELCOME is on (server/agent/welcome). Empty when it is off.

/**
 * The canonical preference and consent record: one row per (athlete, capability, account) the athlete has answered.
 * No row = unset (never asked, or never answered). Only the athlete moves `state` (server/agent/welcome/choices.ts
 * setChoice): connections, expired tokens, failures and Nomila's own flags never write here. `account_ref` is the
 * connected_accounts.id for a per-account capability (that row is one provider account for life, 0071), so a yes
 * for one mailbox is never a yes for another; NULL for an athlete-wide capability. `consent` is a copy of the
 * registry's consent block the athlete said yes to, at `consent_version`. `version` is bumped on every change (the
 * optimistic-concurrency check) and each change is also appended to mila_choice_history. No email content here.
 */
export const milaChoices = pgTable("mila_choices", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  capability:      text("capability").notNull(),                       // registry key (server/agent/welcome/registry.ts)
  account_ref:     text("account_ref"),                                // connected_accounts.id; NULL = athlete-wide
  scope:           text("scope").notNull(),                            // athlete | per_account (the registry's, at the time)
  state:           text("state").notNull(),
  via:             text("via").notNull(),                              // where the athlete answered
  consent_version: text("consent_version"),                            // the registry consent.version said yes to
  consent:         jsonb("consent"),                                   // the copy of what that yes covers
  not_now_count:   smallint("not_now_count").notNull().default(0),
  cooldown_until:  timestamp("cooldown_until", { withTimezone: true }), // not_now only
  version:         integer("version").notNull().default(1),
  decided_at:      timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_mila_choices_key").on(table.athlete_id, table.capability, sql`coalesce(${table.account_ref}, '')`),
  check("mila_choices_state_check", sql`${table.state} IN ('enabled','not_now','never','paused','revoked')`),
  check("mila_choices_via_check", sql`${table.via} IN ('card','chat','me','settings')`),
  check("mila_choices_scope_check", sql`(${table.scope} = 'athlete' AND ${table.account_ref} IS NULL) OR (${table.scope} = 'per_account' AND ${table.account_ref} IS NOT NULL)`),
  check("mila_choices_enabled_consent_check", sql`${table.state} <> 'enabled' OR (${table.consent_version} IS NOT NULL AND ${table.consent} IS NOT NULL)`),
]);

/**
 * Append-only: every change to a mila_choices row, with the row as it became (`version` = the row's version after the
 * change; `from_state` NULL = it was unset). Replaying a choice's rows in version order rebuilds the current row, so
 * what the athlete agreed to, when and where is reconstructable. Nothing updates or deletes these rows except the
 * athlete's account deletion (cascade).
 */
export const milaChoiceHistory = pgTable("mila_choice_history", {
  id:              uuid("id").primaryKey().defaultRandom(),
  choice_id:       uuid("choice_id").notNull().references(() => milaChoices.id, { onDelete: "cascade" }),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  capability:      text("capability").notNull(),
  account_ref:     text("account_ref"),
  version:         integer("version").notNull(),
  from_state:      text("from_state"),
  to_state:        text("to_state").notNull(),
  via:             text("via").notNull(),
  consent_version: text("consent_version"),
  consent:         jsonb("consent"),
  not_now_count:   smallint("not_now_count").notNull(),
  cooldown_until:  timestamp("cooldown_until", { withTimezone: true }),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_mila_choice_history_version").on(table.choice_id, table.version),
  index("idx_mila_choice_history_athlete").on(table.athlete_id, table.created_at),
]);

/** Evidence: one sourced fact. Every fact has a source (url or ref) — the database refuses a claim without one. */
export const memoryFacts = pgTable("memory_facts", {
  id:            uuid("id").primaryKey().defaultRandom(),
  athlete_id:    uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  subject_kind:  text("subject_kind").notNull(),                        // athlete | brand | organization | person | event | content | other
  subject_name:  text("subject_name").notNull(),
  subject_id:    text("subject_id"),
  claim:         text("claim").notNull(),
  type:          text("type").notNull(),                                // said | found | measured | made
  source_url:    text("source_url"),
  source_ref:    text("source_ref"),
  source_title:  text("source_title"),
  observed_on:   date("observed_on"),
  confidence:    doublePrecision("confidence").notNull(),
  status:        text("status").notNull().default("active"),            // active | superseded | disputed
  superseded_by: uuid("superseded_by").references((): AnyPgColumn => memoryFacts.id, { onDelete: "set null" }),
  run_id:        uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0106: status = disputed → the fact it conflicts with; the other sources that say the same thing; private-life detail
  // the athlete told us themselves (family_privacy: never used in content). Research never stores such facts at all.
  disputes:      uuid("disputes").references((): AnyPgColumn => memoryFacts.id, { onDelete: "set null" }),
  also_seen_at:  jsonb("also_seen_at").notNull().default(sql`'[]'::jsonb`),   // Array<{ url, title? }>
  sensitive:     boolean("sensitive").notNull().default(false),
  // 0113: which kind of care a care fact is — personal (M.I.A. momentum only) | conduct (may inform brand safety and
  // momentum). NULL when the fact is not care, or was written before 0113 (read as personal, the stricter rule).
  care_kind:     text("care_kind"),
  // 0115: what the fact is about (the research topic: career, sponsor, media …) and its source's outlet type
  // (official | major_media | trade | local | social | other), written by research and merge. NULL where they do not
  // apply (said, measured, made) and for facts written before 0115.
  topic:         text("topic"),
  source_type:   text("source_type"),
  // 0119: how precise observed_on is (day | month | year; NULL = day, or written before 0119) — research stores "2026-12"
  // as the 1st of the month and this keeps that it was a month. And, for an identity fact about the athlete, which
  // identity field it states (sport | team | position | level | class_year | school | league, labelled by the merge
  // model) with that field's value in a few words. NULL otherwise; field and field_value are written together.
  date_precision: text("date_precision"),
  field:          text("field"),
  field_value:    text("field_value"),
}, (table) => [
  index("idx_memory_facts_athlete_status").on(table.athlete_id, table.status, table.created_at),
  index("idx_memory_facts_athlete_field").on(table.athlete_id, table.field).where(sql`${table.field} IS NOT NULL`),
  check("memory_facts_type_check", sql`${table.type} IN ('said','found','measured','made')`),
  check("memory_facts_status_check", sql`${table.status} IN ('active','superseded','disputed','removed')`),
  check("memory_facts_subject_kind_check", sql`${table.subject_kind} IN ('athlete','brand','organization','person','event','content','other')`),
  check("memory_facts_source_check", sql`${table.source_url} IS NOT NULL OR ${table.source_ref} IS NOT NULL`),
  check("memory_facts_confidence_check", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  check("memory_facts_claim_check", sql`length(${table.claim}) BETWEEN 1 AND 2000`),
  check("memory_facts_care_kind_check", sql`${table.care_kind} IS NULL OR ${table.care_kind} IN ('personal','conduct')`),
  check("memory_facts_source_type_check", sql`${table.source_type} IS NULL OR ${table.source_type} IN ('official','major_media','trade','local','social','other')`),
  check("memory_facts_date_precision_check", sql`${table.date_precision} IS NULL OR ${table.date_precision} IN ('day','month','year')`),
  check("memory_facts_field_check", sql`${table.field} IS NULL OR ${table.field} IN ('sport','team','position','level','class_year','school','league')`),
  check("memory_facts_field_value_check", sql`(${table.field} IS NULL) = (${table.field_value} IS NULL)`),
]);

/** Brief: the current read of the athlete, versioned. Exactly one 'current' per athlete. */
export const memoryBriefs = pgTable("memory_briefs", {
  id:         uuid("id").primaryKey().defaultRandom(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:    integer("version").notNull(),
  status:     text("status").notNull().default("current"),              // current | superseded
  summary:    text("summary").notNull(),
  sections:   jsonb("sections").notNull().default(sql`'[]'::jsonb`),    // BriefSection[]
  fact_ids:   jsonb("fact_ids").notNull().default(sql`'[]'::jsonb`),    // uuid[]
  // 0106: the internal read (sponsors, current kept apart from past; no scores since understand 1.7.0 — the M.I.A. is
  // the only score). NEVER returned by an athlete-facing route.
  internal:   jsonb("internal"),
  // 0114: the structured display fields as Understand returned them — stage { label, band, confidence, why, factIds }
  // and positioning { from, to, statement, pillars, factIds } (BriefDisplay). Shown to the athlete. Null before 0114.
  display:    jsonb("display"),
  run_id:     uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("memory_briefs_athlete_version_uq").on(table.athlete_id, table.version),
  uniqueIndex("memory_briefs_one_current_uq").on(table.athlete_id).where(sql`${table.status} = 'current'`),
  check("memory_briefs_status_check", sql`${table.status} IN ('current','superseded')`),
  check("memory_briefs_version_check", sql`${table.version} >= 1`),
]);

/** Decisions + outcomes: what Mila suggested, why, on what evidence, what she did, what happened. */
export const memoryDecisions = pgTable("memory_decisions", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  run_id:          uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  skill_id:        text("skill_id").notNull(),
  suggested:       text("suggested").notNull(),
  why:             text("why").notNull(),
  evidence:        jsonb("evidence").notNull().default(sql`'[]'::jsonb`),   // EvidenceRef[]
  response:        text("response").notNull().default("pending"),           // pending | accepted | edited | skipped | expired
  response_reason: text("response_reason"),
  responded_at:    timestamp("responded_at", { withTimezone: true }),
  outcome:         text("outcome").notNull().default("unknown"),            // unknown | worked | mixed | did_not_work
  outcome_note:    text("outcome_note"),
  outcome_at:      timestamp("outcome_at", { withTimezone: true }),
  approval_id:     uuid("approval_id").references(() => pendingActions.id, { onDelete: "set null" }),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 0106: the goal this decision (or the action it became) serves. SET NULL: a goal's removal keeps the history.
  goal_id:         uuid("goal_id").references((): AnyPgColumn => memoryGoals.id, { onDelete: "set null" }),
  // 0118 (the plan step): what the decision is about — a recommended goal, an action toward a goal, or anything else
  // (every row before 0118) — its structured detail (shared/plan.ts GoalDecisionDetail / ActionDecisionDetail /
  // GoalChangeDetail), and, for an action held for a RECOMMENDED goal, that goal's decision (its goal_id is set when the
  // athlete keeps the goal). SET NULL: removing a decision keeps its children's history.
  kind:               text("kind").notNull().default("other"),
  detail:             jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  parent_decision_id: uuid("parent_decision_id").references((): AnyPgColumn => memoryDecisions.id, { onDelete: "set null" }),
}, (table) => [
  index("idx_memory_decisions_athlete_created").on(table.athlete_id, table.created_at),
  index("idx_memory_decisions_goal").on(table.goal_id),
  index("idx_memory_decisions_parent").on(table.parent_decision_id),
  check("memory_decisions_response_check", sql`${table.response} IN ('pending','accepted','edited','skipped','expired')`),
  check("memory_decisions_outcome_check", sql`${table.outcome} IN ('unknown','worked','mixed','did_not_work')`),
  check("memory_decisions_kind_check", sql`${table.kind} IN ('goal','action','other')`),
]);

/** Preferences: voice, things to avoid, standing rules, style. */
export const memoryPreferences = pgTable("memory_preferences", {
  id:         uuid("id").primaryKey().defaultRandom(),
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  kind:       text("kind").notNull(),                                    // voice | avoid | standing_rule | style
  statement:  text("statement").notNull(),
  source:     text("source").notNull(),                                  // said | inferred
  status:     text("status").notNull().default("active"),                // active | retired
  run_id:     uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retired_at: timestamp("retired_at", { withTimezone: true }),
}, (table) => [
  index("idx_memory_preferences_athlete_status").on(table.athlete_id, table.status),
  check("memory_preferences_kind_check", sql`${table.kind} IN ('voice','avoid','standing_rule','style')`),
  check("memory_preferences_source_check", sql`${table.source} IN ('said','inferred')`),
  check("memory_preferences_status_check", sql`${table.status} IN ('active','retired')`),
  check("memory_preferences_statement_check", sql`length(${table.statement}) BETWEEN 1 AND 1000`),
]);

export type AgentRunRow         = typeof agentRuns.$inferSelect;
export type MemoryFactRow       = typeof memoryFacts.$inferSelect;
export type MemoryBriefRow      = typeof memoryBriefs.$inferSelect;
export type MemoryDecisionRow   = typeof memoryDecisions.$inferSelect;
export type MemoryPreferenceRow = typeof memoryPreferences.$inferSelect;

// ─── Agent onboarding (0106) ──────────────────────────────────────────────────────────────────────────────────────
// What the athlete did with each fact when reviewing it, and the goals they hold. Nothing here names an athlete,
// sport or brand.

/** One review of one fact: confirm / correct (→ a new "said" fact) / remove (the fact is kept, status 'removed'). */
export const memoryFactReviews = pgTable("memory_fact_reviews", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  athlete_id:          uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  fact_id:             uuid("fact_id").notNull().references(() => memoryFacts.id, { onDelete: "cascade" }),
  action:              text("action").notNull(),                          // confirm | correct | remove | restore | dispute (0117)
  correction:          text("correction"),
  replacement_fact_id: uuid("replacement_fact_id").references(() => memoryFacts.id, { onDelete: "set null" }),
  note:                text("note"),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_memory_fact_reviews_athlete_fact").on(table.athlete_id, table.fact_id, table.created_at),
  check("memory_fact_reviews_action_check", sql`${table.action} IN ('confirm','correct','remove','restore','dispute')`),
  check("memory_fact_reviews_correction_check", sql`(${table.action} = 'correct') = (${table.correction} IS NOT NULL)`),
]);

/** A goal in the athlete's words — the Goals screen. Typed (said), or a Mila proposal the athlete accepted or edited. */
export const memoryGoals = pgTable("memory_goals", {
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  text:        text("text").notNull(),
  source:      text("source").notNull(),                                  // said | proposed_accepted
  status:      text("status").notNull().default("active"),                // active | paused | done | dropped
  priority:    integer("priority"),                                       // 1 = first; null = unordered
  game_plan:   text("game_plan"),                                         // how, in 1–2 plain lines
  decision_id: uuid("decision_id").references((): AnyPgColumn => memoryDecisions.id, { onDelete: "set null" }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0118 (the plan step): when the goal belongs (now = this month · next = this season · later = the year ahead; NULL =
  // nobody has said), and who wrote the game plan — a plan run rewrites it only while it is Mila's.
  horizon:      text("horizon"),
  game_plan_by: text("game_plan_by").notNull().default("mila"),
  // 0119: what the goal is about, from the closed goal-domain list (shared/agent.ts GOAL_DOMAINS); the plan writes it.
  // NULL = nobody has said.
  domain:       text("domain"),
}, (table) => [
  index("idx_memory_goals_athlete_status").on(table.athlete_id, table.status),
  check("memory_goals_source_check", sql`${table.source} IN ('said','proposed_accepted')`),
  check("memory_goals_status_check", sql`${table.status} IN ('active','paused','done','dropped')`),
  check("memory_goals_text_check", sql`length(${table.text}) BETWEEN 1 AND 500`),
  check("memory_goals_priority_check", sql`${table.priority} IS NULL OR ${table.priority} >= 1`),
  check("memory_goals_horizon_check", sql`${table.horizon} IS NULL OR ${table.horizon} IN ('now','next','later')`),
  check("memory_goals_game_plan_by_check", sql`${table.game_plan_by} IN ('mila','athlete')`),
  check("memory_goals_domain_check", sql`${table.domain} IS NULL OR ${table.domain} IN ('audience','content','positioning','athletic','commercial','relationships','owned_venture','impact','career')`),
]);

/**
 * The onboarding conversation's required checkpoints (shared/agent.ts ONBOARDING_CHECKPOINTS), one row per checkpoint
 * per onboarding run. The model chooses the order and the words; code holds this state, so onboarding resumes where it
 * stopped and finishes only when every checkpoint is met. `detail` keeps per-item state (e.g. each connection offered:
 * offers, declines, the turn it was last offered on) and is how re-offers are capped.
 */
export const agentOnboardingCheckpoints = pgTable("agent_onboarding_checkpoints", {
  id:              uuid("id").primaryKey().defaultRandom(),
  athlete_id:      uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  // The agent_onboarding workflow run (no FK: workflow_runs lives in schemaWorkflow.ts; the athlete cascade covers deletion).
  workflow_run_id: uuid("workflow_run_id").notNull(),
  checkpoint:      text("checkpoint").notNull(),                 // name_sport | reveal | facts_review | connect_offers | goal | capabilities | consent
  status:          text("status").notNull().default("pending"),  // pending | offered | done | declined
  offers:          integer("offers").notNull().default(0),
  last_turn:       integer("last_turn"),
  detail:          jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  updated_at:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("agent_onboarding_checkpoints_run_checkpoint_uq").on(table.workflow_run_id, table.checkpoint),
  index("idx_agent_onboarding_checkpoints_athlete").on(table.athlete_id),
  check("agent_onboarding_checkpoints_checkpoint_check", sql`${table.checkpoint} IN ('name_sport','reveal','facts_review','connect_offers','goal','capabilities','consent')`),
  check("agent_onboarding_checkpoints_status_check", sql`${table.status} IN ('pending','offered','done','declined')`),
  check("agent_onboarding_checkpoints_offers_check", sql`${table.offers} >= 0`),
]);

export type AgentOnboardingCheckpointRow = typeof agentOnboardingCheckpoints.$inferSelect;
export type MemoryFactReviewRow = typeof memoryFactReviews.$inferSelect;
export type MemoryGoalRow       = typeof memoryGoals.$inferSelect;

// ─── Atmosphere imagery (0116; DESIGN.md §9) ──────────────────────────────────────────────────────────────────────
// Atmosphere images for everything not about the athlete (section headers, empty states, goal, suggestion and pitch
// backgrounds, thin profiles): venues, surfaces, equipment, light and texture, never a person, a logo or text. Our own
// stored copies of Pixabay photos (with their credit line) or a generated fallback. Behind ATMOSPHERE_IMAGERY, off in
// dev and prod. Nothing here names an athlete, sport or brand: every row is keyed by the id the picker was handed.

/**
 * One candidate the image check looked at, per athlete. ACCEPTED rows are stored in our bucket (gcs_path) and reused
 * by the picker; REJECTED rows keep only the source, the check's answer and the reason, so the same candidate is never
 * downloaded or checked twice for that athlete. `cost_micro_usd` is what this row cost (its check, plus the generation
 * for a generated image).
 */
export const atmosphereImages = pgTable("atmosphere_images", {
  id:             uuid("id").primaryKey().defaultRandom(),
  athlete_id:     uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  source:         text("source").notNull(),                       // pixabay | generated
  source_id:      text("source_id"),                              // the Pixabay image id; null for a generated image
  source_url:     text("source_url"),                             // the Pixabay page; null for a generated image
  status:         text("status").notNull(),                       // accepted | rejected
  gcs_path:       text("gcs_path"),                               // our copy; set exactly when accepted
  content_type:   text("content_type"),
  width:          integer("width"),
  height:         integer("height"),
  bytes:          integer("bytes"),
  credit:         text("credit").notNull(),                       // the credit line shown on the image
  licence:        text("licence").notNull(),                      // pixabay-content-license | generated
  query:          text("query").notNull(),                        // the search query, or the generation prompt
  slot_type:      text("slot_type").notNull(),
  purpose:        text("purpose").notNull(),
  purpose_key:    text("purpose_key").notNull(),                  // the purpose, normalized: what reuse matches on
  check_result:   jsonb("check_result").notNull(),                // the image check's answers, model and skill version
  reject_reason:  text("reject_reason"),                          // person,face,logo,text,watermark,off_purpose,…; null when accepted
  cost_micro_usd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_atmosphere_images_athlete_purpose").on(table.athlete_id, table.purpose_key, table.status),
  uniqueIndex("atmosphere_images_athlete_source_uq").on(table.athlete_id, table.source, table.source_id).where(sql`source_id IS NOT NULL`),
  check("atmosphere_images_source_check", sql`${table.source} IN ('pixabay','generated')`),
  check("atmosphere_images_status_check", sql`${table.status} IN ('accepted','rejected')`),
  check("atmosphere_images_stored_check", sql`(${table.status} = 'accepted') = (${table.gcs_path} IS NOT NULL) AND (${table.status} = 'accepted') = (${table.reject_reason} IS NULL)`),
  check("atmosphere_images_cost_check", sql`${table.cost_micro_usd} >= 0`),
]);

/**
 * Which image a screen's slot shows. One row per (athlete, screen, slot): the choice is made once and kept, so a slot
 * shows the same image every time; one image at most once per screen (the second unique index).
 */
export const atmospherePlacements = pgTable("atmosphere_placements", {
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  screen:     text("screen").notNull(),
  slot_key:   text("slot_key").notNull(),
  image_id:   uuid("image_id").notNull().references(() => atmosphereImages.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "atmosphere_placements_pk", columns: [table.athlete_id, table.screen, table.slot_key] }),
  uniqueIndex("atmosphere_placements_screen_image_uq").on(table.athlete_id, table.screen, table.image_id),
]);

/** Atmosphere spend per athlete per UTC day (micro-dollars), and what it bought. The caps sum this table. */
export const atmosphereSpendDays = pgTable("atmosphere_spend_days", {
  athlete_id:    uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  day:           date("day").notNull(),
  micro_usd:     bigint("micro_usd", { mode: "number" }).notNull().default(0),
  model_calls:   integer("model_calls").notNull().default(0),
  pixabay_calls: integer("pixabay_calls").notNull().default(0),
  generations:   integer("generations").notNull().default(0),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "atmosphere_spend_days_pk", columns: [table.athlete_id, table.day] }),
]);

export type AtmosphereImageRow = typeof atmosphereImages.$inferSelect;

// ─── Atmosphere library (0120; DESIGN.md §9; owner decision 10 Oct 2026) ────────────────────────────────────
// ONE shared, curated library reused by every athlete: individual Unsplash (Unsplash License) or Pexels (Pexels
// License) photos downloaded once, resized to WebP and stored in our media bucket under
// atmosphere/shared/<sport|general|signin>/<id>.webp. No search at request time, no generation, no per-athlete spend.
// The per-athlete tables above (0116) are superseded and stay empty. Nothing here names an athlete; `sport` is the
// sport id from the one sport list (shared/sports.ts), set by the import scripts, never by code.

/**
 * One photo in the shared library. Not athlete data. `photographer` / `source_url` are kept for our records only
 * (neither licence needs attribution, so no credit is shown in the app). `check_result` says who or what checked
 * the image (the vision check's answers, or a person's review). `curated` = a person approved it; `active` = false
 * retires it (the picker stops choosing it).
 */
export const atmosphereLibrary = pgTable("atmosphere_library", {
  id:               uuid("id").primaryKey().defaultRandom(),
  source:           text("source").notNull(),                       // unsplash | pexels
  source_id:        text("source_id").notNull(),                    // the source's photo id (Unsplash: slug's last segment; Pexels: numeric)
  source_url:       text("source_url").notNull(),                   // the unsplash.com/photos/… or pexels.com/photo/… page
  photographer:     text("photographer"),
  photographer_url: text("photographer_url"),
  licence:          text("licence").notNull(),                      // "Unsplash License" | "Pexels License"
  category:         text("category").notNull(),                     // sport | general | signin
  sport:            text("sport"),                                  // the sport id; set exactly when category = sport
  purposes:         text("purposes").array().notNull().default(sql`'{}'::text[]`),
  tags:             text("tags").array().notNull().default(sql`'{}'::text[]`),
  gcs_path:         text("gcs_path").notNull(),
  content_type:     text("content_type").notNull(),
  width:            integer("width").notNull(),
  height:           integer("height").notNull(),
  bytes:            integer("bytes").notNull(),
  check_result:     jsonb("check_result").notNull(),
  curated:          boolean("curated").notNull().default(false),
  active:           boolean("active").notNull().default(true),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("atmosphere_library_source_uq").on(table.source, table.source_id),
  index("idx_atmosphere_library_pool").on(table.category, table.sport, table.active),
  check("atmosphere_library_source_check", sql`${table.source} IN ('unsplash','pexels')`),
  check("atmosphere_library_category_check", sql`${table.category} IN ('sport','general','signin')`),
  check("atmosphere_library_sport_check", sql`(${table.category} = 'sport') = (${table.sport} IS NOT NULL)`),
]);

/**
 * Which library image a screen's slot shows for an athlete (her data: deleted and exported with her account). Chosen
 * once and kept; an image at most once per screen. A retired image's placement is replaced on the next pick.
 */
export const atmosphereLibraryPlacements = pgTable("atmosphere_library_placements", {
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  screen:     text("screen").notNull(),
  slot_key:   text("slot_key").notNull(),
  library_id: uuid("library_id").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "atmosphere_library_placements_pk", columns: [table.athlete_id, table.screen, table.slot_key] }),
  // Named by hand: the generated name is longer than Postgres's 63-character limit.
  foreignKey({ name: "atmosphere_library_placements_library_fk", columns: [table.library_id], foreignColumns: [atmosphereLibrary.id] }).onDelete("cascade"),
  uniqueIndex("atmosphere_library_placements_screen_image_uq").on(table.athlete_id, table.screen, table.library_id),
]);

export type AtmosphereLibraryRow = typeof atmosphereLibrary.$inferSelect;

// ─── Public page stats (0121; the Front Door page, /p/:handle) ─────────────────────────────────────────────────────
// What the athlete's own view of the page counts (the metrics rail: views · likes · requests · bookings · shop, last 30
// days). Requests, bookings and shop clicks already have their tables (partner_requests, bookings, shop_click_days);
// these two add the rest. Nothing about a visitor is stored: views are a count per day, and a like keeps only a keyed
// hash of the visitor's own random token (HMAC with a server secret and the athlete id), so it cannot be linked to a
// person, an IP, a device or a like on another athlete's page.

/** Page views per athlete per UTC day: one count, no visitor data at all. */
export const publicPageViewDays = pgTable("public_page_view_days", {
  athlete_id: uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  day:        date("day").notNull(),
  views:      integer("views").notNull().default(0),
}, (table) => [
  primaryKey({ name: "public_page_view_days_pk", columns: [table.athlete_id, table.day] }),
  check("public_page_view_days_views_check", sql`${table.views} >= 0`),
]);

/** One like per visitor per page. `visitor_hash` = HMAC(secret, athlete id ‖ the visitor's random token); taking it back deletes the row. */
export const publicPageLikes = pgTable("public_page_likes", {
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  visitor_hash: text("visitor_hash").notNull(),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "public_page_likes_pk", columns: [table.athlete_id, table.visitor_hash] }),
  index("idx_public_page_likes_athlete_created").on(table.athlete_id, table.created_at),
]);

// ─── Sign in with a 6-digit email code (0129; design "Sign in with email", 12 Oct 2026) ─────────────────────────────
// One row per code sent by POST /api/v1/auth/email-code/start, behind EMAIL_CODE_SIGNIN. Nothing is stored in the
// clear: the email, the code and the caller's IP are each an HMAC keyed with EMAIL_CODE_SECRET (server/lib/emailCode.ts),
// so the table names no one and holds no usable code. It is also the per-email and per-IP rate counter (Cloud Run
// instances share no memory). Only the newest row for an email can be used; a code lives 10 minutes, takes 5 tries and
// is spent once (consumed_at). Rows are purged two days after they are made. No athlete column: the email may belong to
// no athlete yet (athleteDataManifest NOT_ATHLETE_DATA).
export const emailSigninCodes = pgTable("email_signin_codes", {
  id:          uuid("id").primaryKey().defaultRandom(),
  email_hmac:  text("email_hmac").notNull(),
  code_hmac:   text("code_hmac").notNull(),
  ip_hmac:     text("ip_hmac").notNull(),
  attempts:    integer("attempts").notNull().default(0),
  expires_at:  timestamp("expires_at", { withTimezone: true }).notNull(),
  consumed_at: timestamp("consumed_at", { withTimezone: true }),
  /** When the 5th wrong try locked this code, and the HMAC of the IP that made it (the lockout and the backoff). */
  locked_at:      timestamp("locked_at", { withTimezone: true }),
  locked_ip_hmac: text("locked_ip_hmac"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_email_signin_codes_email").on(table.email_hmac, table.created_at),
  index("idx_email_signin_codes_ip").on(table.ip_hmac, table.created_at),
  index("idx_email_signin_codes_created").on(table.created_at),
]);

// ─── Camera-roll intake: scored previews (0131; design "Media Intake Plan", 12 Oct 2026) ────────────────────────────
// One row per small preview the phone sent for scoring in a review session, behind CAMERA_ROLL_INTAKE: the content
// check, the tagger, the embedding and the "is it her" check. Import carries a ticked item's tags and embedding over
// from HERE (the server's own record, never the phone's) and then scrubs the session's rows (tags, embedding, likeness,
// moderation NULL; scrubbed_at). Rows made today are the daily preview cap. Deleted two days after they are made.
export const mediaReviewItems = pgTable("media_review_items", {
  id:          uuid("id").primaryKey().defaultRandom(),
  athlete_id:  uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  session_id:  text("session_id").notNull(),
  item_id:     text("item_id").notNull(),
  kind:        text("kind").notNull(),
  tags:        jsonb("tags"),
  embedding:   jsonb("embedding"),
  likeness:    doublePrecision("likeness"),
  moderation:  jsonb("moderation"),
  fit:         doublePrecision("fit"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  scrubbed_at: timestamp("scrubbed_at", { withTimezone: true }),
}, (table) => [
  check("media_review_items_kind_check", sql`${table.kind} IN ('photo','video')`),
  uniqueIndex("uq_media_review_items_item").on(table.athlete_id, table.session_id, table.item_id),
  index("idx_media_review_items_athlete_created").on(table.athlete_id, table.created_at),
  index("idx_media_review_items_created").on(table.created_at),
]);

// ── Brand book (BRAND_BOOK_V1) ──────────────────────────────────────────────────────────────────────────────────────
// The athlete's brand book: ten pages written to her as "you" (server/services/brandBook). One row per athlete; a
// regenerate bumps `version` and replaces `data` (the book is rebuilt from her current memory, so nothing is lost).
// `data` holds media PATHS, never signed URLs; `reel` is the motion version's state ({ status, assetId, gcsPath, … }).
export const brandBooks = pgTable("brand_books", {
  id:           uuid("id").primaryKey().defaultRandom(),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  version:      integer("version").notNull().default(0),
  status:       text("status").notNull().default("building"),   // building | ready | failed
  data:         jsonb("data"),
  reel:         jsonb("reel"),
  overrides:    jsonb("overrides"),   // her chosen / written lines over `data` (services/brandBook/overrides.ts, 0149)
  error:        text("error"),
  generated_at: timestamp("generated_at", { withTimezone: true }),
  updated_at:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("brand_books_athlete_uniq").on(table.athlete_id),
  check("brand_books_status_check", sql`${table.status} IN ('building','ready','failed')`),
]);

/**
 * OAuth connect states (0138): one row per connect started at POST /api/v1/me/connect/:platform, so the callback
 * accepts a signed state ONCE, only for the athlete and platform it was issued for, before it expires, and — for a
 * browser connect — only from the browser that started it (binding_hash = sha256 of the HttpOnly cookie set on the
 * connect response). nonce_hash is sha256 of the state's nonce; nothing usable is stored. 10-minute life; rows are
 * pruned a day after expiry (server/lib/oauthConnectState.ts). Deleted with the athlete (athleteDataManifest).
 */
export const oauthConnectStates = pgTable("oauth_connect_states", {
  id:           uuid("id").primaryKey().defaultRandom(),
  nonce_hash:   text("nonce_hash").notNull(),
  athlete_id:   uuid("athlete_id").notNull().references(() => athletes.id, { onDelete: "cascade" }),
  platform:     text("platform").notNull(),
  binding_hash: text("binding_hash"),
  expires_at:   timestamp("expires_at", { withTimezone: true }).notNull(),
  used_at:      timestamp("used_at", { withTimezone: true }),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_oauth_connect_states_nonce").on(table.nonce_hash),
  index("idx_oauth_connect_states_athlete").on(table.athlete_id),
  index("idx_oauth_connect_states_expires").on(table.expires_at),
]);

// ─── Account deletion reconciliation (0145, server/services/privacy/deleteAthleteAccount.ts) ──────────────────────
// One row per thing an account deletion must clean up outside its row purge (a TrueForge session, a storage prefix or
// object, the sign-in user, the Langfuse traces, a provider grant), and one per manifest table it purged (rows counted).
// Status: pending → confirmed (verified gone) | failed (gave up) | skipped (not ours to delete here, e.g. an id that is
// not a TrueForge session). No athlete column and no foreign key: refs are opaque ids / paths, and the rows are removed
// once the deletion is verified complete (the receipt keeps counts only). Not athlete data (NOT_ATHLETE_DATA).
export const accountDeletionItems = pgTable("account_deletion_items", {
  id:         serial("id").primaryKey(),
  run_id:     uuid("run_id").notNull(),
  system:     text("system").notNull(),
  ref:        text("ref").notNull(),
  status:     text("status").notNull().default("pending"),
  outcome:    text("outcome"),
  rows:       integer("rows").notNull().default(0),
  attempts:   integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_account_deletion_items_ref").on(table.run_id, table.system, table.ref),
  check("account_deletion_items_status_check", sql`${table.status} IN ('pending', 'confirmed', 'failed', 'skipped')`),
]);
