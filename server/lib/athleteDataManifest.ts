/**
 * athleteDataManifest.ts — THE ONE LIST of every table that holds an athlete's data.
 *
 * Why it exists (launch correctness, 7 Oct 2026): the privacy policy (landing/privacy-policy.html) promises account
 * deletion and data export. Before this file, DELETE /api/v1/me/account named 15 tables by hand and missed about 14
 * (athlete_asserted, objectives, pending_actions, agent_actions, conversations, voice_context, payments …), and
 * there was no export at all. Four lists (delete, export, the "Your data" screen, Mila's "what do you remember")
 * would each drift on their own; this manifest is the single source all four walk.
 *
 * What each entry records:
 *   - how the table is keyed to the athlete (`key`): her id in a column, or through a parent entry, or a custom
 *     predicate for the few tables keyed some other way (users via membership, the intelligence ledger by subject);
 *   - its DELETE ORDER: the array order. Children come before parents, so the account delete (phase 2, in batches,
 *     services/privacy/accountDeletionSteps.ts) can delete the whole
 *     list top to bottom without tripping a foreign key (the guard test proves every NO ACTION FK is respected);
 *   - its category for the export and the "Your data" screen;
 *   - whether it is exported (rows / references only / not at all) and that it is deleted with the account.
 *
 * Guard: athleteDataManifest.test.ts FAILS when shared/schema.ts gains a table with an athlete_id column (or a
 * foreign key to any table here) that is not in this manifest, and when any table is neither here nor in
 * NOT_ATHLETE_DATA with a reason. A new table therefore cannot reach main without being classified.
 *
 * Nothing here hard-codes an athlete. Everything is keyed by the id handed in.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as s from "../../shared/schema";

// ─── Categories (the export's sections and the "Your data" groups) ────────────────────────────────────────────

export const DATA_CATEGORIES = {
  account:       { label: "Your account",              description: "Your sign-in, your account record and how it was linked to you." },
  profile:       { label: "About you",                 description: "Facts about you, each with where it came from: you said it, Nomila found it, or Nomila worked it out." },
  goals:         { label: "Your goals",                description: "Goals you added or accepted, and their history." },
  bookings:      { label: "Bookings you sold",         description: "Your offers, the times you offered, and each booking: what was agreed, its history, relayed messages and reports. The buyer's email and phone are not included (Nomila kept them private from you unless you chose to share contact). Payments for bookings are listed with your other payments." },
  deals:         { label: "Opportunities and deals",   description: "Brands, money, dates, terms, payments and the payout account behind them. When you delete your account your payments are deleted; for money that moved, Nomila keeps a de-identified ledger record (amounts and Stripe references, nothing that names you) for the financial-record retention period." },
  brands:        { label: "Brands",                    description: "Brand fit, outreach plans and your per-brand card. Brands you confirmed are the deals you reported or proved with a contract." },
  connections:   { label: "Connected accounts",        description: "Which accounts you connected and the statistics read from them. Never the access tokens." },
  inbox:         { label: "Inbox",                     description: "The conversations Nomila tracked as deals, with Nomila's own summaries. Not the email or DM text." },
  drafts:        { label: "Drafts waiting to send",    description: "Replies and actions Mila proposed for your approval." },
  chats:         { label: "Chats with Mila",           description: "Your messages and Mila's answers, voice and text, and onboarding chats." },
  media:         { label: "Your photos and videos",    description: "Your media library and where each item was posted." },
  research:      { label: "What Nomila found",         description: "Research runs and the public sources behind the facts Nomila found." },
  intelligence:  { label: "What Nomila worked out",    description: "Scores, assessments and recommendations computed from the rest of your data." },
  studio:        { label: "Studio",                    description: "Creative briefs, plans, generations, edits and campaigns." },
  receipts:      { label: "What Nomila did for you",   description: "Receipts for every action Nomila took on your behalf." },
  system:        { label: "Background work",           description: "Notifications sent to you and the background jobs that ran for you." },
} as const;

export type DataCategory = keyof typeof DATA_CATEGORIES;

// ─── Entry shape ──────────────────────────────────────────────────────────────────────────────────────────────

/** Who the deletion / export is for. `userIds` are the sign-in users that belong ONLY to this athlete. */
export interface AthleteScope {
  athleteId: string;
  userIds:   string[];
}

export type AthleteKey =
  /** The athlete's id sits in `column` of this table. */
  | { by: "athlete_column"; column: string }
  /** The row belongs to her through `column` → `parent`.id, and `parent` is itself a manifest entry. */
  | { by: "parent"; column: string; parent: string }
  /** Keyed some other way. `dependsOn` names the entries the predicate reads, which must be deleted AFTER this one. */
  | { by: "custom"; describe: string; dependsOn: string[]; where: (scope: AthleteScope) => SQL };

export type ExportRule =
  /** Every column except `omit` (secrets, other people's data, stored email text). `redact` rewrites one row. */
  | { mode: "rows"; omit?: string[]; redact?: (row: Record<string, unknown>) => Record<string, unknown>; why?: string }
  /** Only these columns: the row is listed, its contents are not. */
  | { mode: "references"; columns: string[]; why: string }
  | { mode: "none"; why: string };

export interface ManifestEntry {
  /** The table's SQL name (the guard test checks it against the drizzle table). */
  name:      string;
  table:     PgTable;
  key:       AthleteKey;
  category:  DataCategory;
  export:    ExportRule;
  /** Every manifest table is deleted with the account. "keep" would need `keptBecause` (the guard test enforces it). */
  retention: "delete" | "keep";
  keptBecause?: string;
  note?:     string;
}

const byAthlete = (column = "athlete_id"): AthleteKey => ({ by: "athlete_column", column });
const via = (column: string, parent: string): AthleteKey => ({ by: "parent", column, parent });
const rows = (omit?: string[], extra?: Partial<Extract<ExportRule, { mode: "rows" }>>): ExportRule => ({ mode: "rows", ...(omit ? { omit } : {}), ...(extra ?? {}) });

function uuidList(ids: string[]): SQL {
  return ids.length ? sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`(NULL::uuid)`;
}

/**
 * Intelligence-ledger subjects that are hers, mapped to the manifest table that holds them. `brand` and `brief`
 * are absent on purpose: a brand is shared research, and no brief subject is written today.
 */
const LEDGER_SUBJECT_TABLES: Record<string, string> = {
  athlete: "athletes", objective: "objectives", deal: "deals", opportunity: "opportunities", campaign: "campaigns",
  asset: "media_assets", thread: "inbox_threads",
  campaign_deliverable: "campaign_deliverables", creative_intent: "creative_intents",
};

// ─── The manifest. ARRAY ORDER IS THE DELETE ORDER: children first, `athletes` and `users` last. ──────────────

export const ATHLETE_DATA_MANIFEST: readonly ManifestEntry[] = [
  // Judgements about her and about her deals, goals, assets … — keyed by subject, no FK, so it reads the
  // subject tables below and must go first.
  { name: "intelligence_ledger", table: s.intelligenceLedger, category: "intelligence", retention: "delete", export: rows(),
    key: { by: "custom", describe: "subject_type/subject_id names her, or one of her objectives, deals, opportunities, campaigns, assets, outreach plans, threads, campaign deliverables or creative intents",
      dependsOn: Object.values(LEDGER_SUBJECT_TABLES),
      where: (sc) => sql.join(Object.entries(LEDGER_SUBJECT_TABLES).map(([kind, table]) => kind === "athlete"
        ? sql`(subject_type = 'athlete' AND subject_id = ${sc.athleteId}::uuid)`
        : sql`(subject_type = ${kind} AND subject_id IN (SELECT "id" FROM ${sql.identifier(table)} WHERE ${athleteWhereByName(table, sc)}))`), sql` OR `) } },

  // ── background work ──
  { name: "workflow_steps", table: s.workflowSteps, key: via("run_id", "workflow_runs"), category: "system", retention: "delete", export: rows(["lease_owner", "lease_token"]) },
  { name: "workflow_runs",  table: s.workflowRuns,  key: byAthlete(), category: "system", retention: "delete", export: rows(),
    note: "Runs with athlete_id NULL are shared (and the account-deletion receipt itself); they are not hers." },

  // ── her picks (0096, docs/design/shop-her-picks.md): her shelf, its daily click counts, her shop answers ──
  // shop_click_days holds no fan data at all (a count per pick per day), so it is exported whole.
  // 0100: a brand's yes / no to her featuring its products, and the code it gave her (the Shopify catalog app).
  { name: "shop_brand_approvals", table: s.shopBrandApprovals, key: byAthlete(), category: "brands", retention: "delete", export: rows() },
  { name: "shop_click_days", table: s.shopClickDays, key: via("item_id", "shop_items"), category: "profile", retention: "delete", export: rows() },
  { name: "shop_items",      table: s.shopItems,     key: byAthlete(), category: "profile", retention: "delete", export: rows() },
  { name: "shop_settings",   table: s.shopSettings,  key: byAthlete(), category: "profile", retention: "delete", export: rows() },

  // ── her public card (0101, design-public-card-v3 §10–§11): what she published, her old handles, her card row ──
  { name: "public_card_snapshots",        table: s.publicCardSnapshots,       key: byAthlete(), category: "profile", retention: "delete", export: rows(),
    note: "Every version she published (and each removal), with the manifest of where each line came from." },
  { name: "public_card_handle_redirects", table: s.publicCardHandleRedirects, key: byAthlete(), category: "profile", retention: "delete", export: rows() },
  { name: "public_cards",                 table: s.publicCards,               key: byAthlete(), category: "profile", retention: "delete", export: rows(),
    note: "Her handle, publish state, draft decisions and switches. Deleting the account takes the page down (the reader answers 404)." },
  // ── her page's own counts (0121, the Front Door metrics rail): views per day and visitors' likes. No visitor data:
  // a like keeps only a keyed hash of the visitor's random token, which is the visitor's, not hers, so it is not exported.
  { name: "public_page_view_days", table: s.publicPageViewDays, key: byAthlete(), category: "profile", retention: "delete", export: rows() },
  { name: "public_page_likes",     table: s.publicPageLikes,    key: byAthlete(), category: "profile", retention: "delete",
    export: rows(["visitor_hash"], { why: "The keyed hash of a visitor's own random token: the visitor's, not hers. Each like is listed by its date." }) },

  // ── Ask Mila on her card (0104, design-public-card-v3 §4): visitors' chats with Mila and her daily turn counter ──
  // No visitor identity is stored with a chat (no IP, user agent or contact); she reads them under "Chats on your card".
  { name: "ask_mila_turns",        table: s.askMilaTurns,       key: byAthlete(), category: "chats", retention: "delete", export: rows(),
    note: "What visitors asked Mila on her public card and what Mila answered (after the output gate). Kept 90 days; she can delete any chat." },
  { name: "ask_mila_sessions",     table: s.askMilaSessions,    key: byAthlete(), category: "chats", retention: "delete",
    export: rows(["token_sha256"], { why: "The session token's hash is a visitor's credential for that chat, not her data." }) },
  { name: "ask_mila_athlete_days", table: s.askMilaAthleteDays, key: byAthlete(), category: "chats", retention: "delete", export: rows() },

  // ── card shares + per-brand card ──
  { name: "card_share_views", table: s.cardShareViews, key: via("share_id", "card_shares"), category: "profile", retention: "delete",
    export: rows(["viewer_token", "viewer_email"], { why: "Who viewed a shared card is the viewer's data; only the view itself is exported." }) },
  { name: "card_shares",    table: s.cardShares,    key: byAthlete(), category: "profile", retention: "delete",
    export: rows(["recipient_token"], { why: "The recipient's link token is a credential." }) },
  { name: "card_overrides", table: s.cardOverrides, key: byAthlete(), category: "brands",  retention: "delete", export: rows() },

  // ── media kits + media links ──
  { name: "kit_content",  table: s.kitContent,  key: via("media_kit_id", "media_kits"), category: "deals", retention: "delete", export: rows() },
  { name: "media_kits",   table: s.mediaKits,   key: byAthlete(), category: "deals", retention: "delete", export: rows() },
  { name: "brand_books",  table: s.brandBooks,  key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "content_brands", table: s.contentBrands, key: via("asset_id", "media_assets"), category: "media", retention: "delete", export: rows() },
  { name: "content_posts",  table: s.contentPosts,  key: via("asset_id", "media_assets"), category: "media", retention: "delete", export: rows() },
  { name: "published_asset_identities", table: s.publishedAssetIdentities, key: byAthlete(), category: "media", retention: "delete", export: rows() },

  // ── Studio ──
  { name: "studio_publish_jobs",       table: s.studioPublishJobs,       key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_session_entries",    table: s.studioSessionEntries,    key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_sessions",           table: s.studioSessions,          key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_reference_analyses", table: s.studioReferenceAnalyses, key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_brand_profiles",     table: s.studioBrandProfiles,     key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_edit_previews",      table: s.studioEditPreviews,      key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_generation_previews", table: s.studioGenerationPreviews, key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_stitch_jobs",        table: s.studioStitchJobs,        key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "studio_plans",              table: s.studioPlans,             key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "generation_jobs",           table: s.generationJobs,          key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "campaign_deliverables",     table: s.campaignDeliverables,    key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "campaign_specs",            table: s.campaignSpecs,           key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "campaigns",                 table: s.campaigns,               key: byAthlete(), category: "studio", retention: "delete",
    export: rows(["participant_athlete_ids"], { why: "Other athletes' ids are not hers to export." }) },
  { name: "creative_interpretations",  table: s.creativeInterpretations, key: byAthlete(), category: "studio", retention: "delete", export: rows() },
  { name: "creative_intents",          table: s.creativeIntents,         key: byAthlete(), category: "studio", retention: "delete", export: rows() },

  // ── social substrate (read from her connected accounts) ──
  { name: "social_metric_observations",    table: s.socialMetricObservations,    key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "social_audience_distributions", table: s.socialAudienceDistributions, key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "social_features",               table: s.socialFeatures,              key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "raw_source_payloads",           table: s.rawSourcePayloads,           key: byAthlete(), category: "connections", retention: "delete",
    export: { mode: "references", columns: ["id", "sync_run_id", "platform", "provider", "endpoint_family", "page_index", "source_class", "payload_hash", "bytes", "fetched_at", "retained_until"],
      why: "Raw provider API pages; the statistics read from them are exported in full." } },
  { name: "social_sync_runs",              table: s.socialSyncRuns,              key: byAthlete(), category: "connections", retention: "delete", export: rows() },

  // ── atmosphere imagery (0116, DESIGN.md §9): stock or generated scene images chosen for her screens, never her ──
  { name: "atmosphere_placements", table: s.atmospherePlacements, key: byAthlete(), category: "media", retention: "delete", export: rows() },
  { name: "atmosphere_images",     table: s.atmosphereImages,     key: byAthlete(), category: "media", retention: "delete", export: rows(),
    note: "Stored copies live in GCS under athletes/<id>/atmosphere/ (ATHLETE_STORAGE)." },
  { name: "atmosphere_spend_days", table: s.atmosphereSpendDays,  key: byAthlete(), category: "system", retention: "delete", export: rows() },
  // ── atmosphere library placements (0120): which SHARED library photo each of her slots shows. The library itself
  //    (atmosphere_library, atmosphere/shared/ in the media bucket) is shared and not hers: NOT_ATHLETE_DATA. ──
  { name: "atmosphere_library_placements", table: s.atmosphereLibraryPlacements, key: byAthlete(), category: "media", retention: "delete", export: rows() },

  // ── media library ──
  // Their word that they may post their media (0151, CONTENT_READY_QUEUE): once per asset for their own posts, once per
  // deal for a sponsored one; revoked rows kept as the record. Before media_assets (its FK).
  { name: "media_rights_attestations", table: s.mediaRightsAttestations, key: byAthlete(), category: "media", retention: "delete", export: rows() },
  { name: "media_assets",       table: s.mediaAssets,        key: byAthlete(), category: "media", retention: "delete", export: rows(),
    note: "Pixels live in GCS (ATHLETE_STORAGE); the row's gcs_path / gcs_thumb_path are also purged explicitly." },
  // Camera-roll review previews as scored (0131): a preview's tags, embedding and content check — never the photo.
  // Scrubbed on import, deleted two days after they are made; the export lists them without their contents.
  { name: "media_review_items", table: s.mediaReviewItems, key: byAthlete(), category: "media", retention: "delete",
    export: { mode: "references", columns: ["session_id", "item_id", "kind", "created_at", "scrubbed_at"], why: "What a camera-roll review scored, listed by item. The scores of photos you did not import are working data, deleted within two days." } },
  { name: "media_backfill_state", table: s.mediaBackfillState, key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "social_identities",   table: s.socialIdentities,   key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "social_analytics_snapshots", table: s.socialAnalyticsSnapshots, key: byAthlete(), category: "connections", retention: "delete", export: rows() },

  // ── agent onboarding (0106): her reviews of facts and her goals (before the facts and decisions they point at) ──
  { name: "memory_fact_reviews", table: s.memoryFactReviews, key: byAthlete(), category: "profile",     retention: "delete", export: rows(),
    note: "Each fact you confirmed, corrected or removed, and the fact a correction became." },
  { name: "memory_goals",        table: s.memoryGoals,       key: byAthlete(), category: "profile",     retention: "delete", export: rows(),
    note: "Your goals, in your words: typed by you, or proposed by Mila and accepted or edited by you." },
  { name: "agent_onboarding_checkpoints", table: s.agentOnboardingCheckpoints, key: byAthlete(), category: "system", retention: "delete", export: rows(),
    note: "Where your onboarding conversation got to: what Mila showed you, offered and what you agreed to." },
  // ── the agent harness (0105): the four memory layers, then the runs they point at (run_id SET NULL) ──
  { name: "memory_facts",       table: s.memoryFacts,       key: byAthlete(), category: "profile",      retention: "delete", export: rows(),
    note: "Evidence: each fact with its source, type (said / found / measured / made), date and confidence." },
  { name: "memory_briefs",      table: s.memoryBriefs,      key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "memory_decisions",   table: s.memoryDecisions,   key: byAthlete(), category: "intelligence", retention: "delete", export: rows(),
    note: "What Mila suggested, why, what you did and what happened. approval_id points at pending_actions (SET NULL)." },
  { name: "memory_preferences", table: s.memoryPreferences, key: byAthlete(), category: "profile",      retention: "delete", export: rows() },
  // Mila's turns (0141, first written for TrueForge; the Mastra engine's now): what a turn's tool calls left for the
  // app, kept seconds (taken and deleted when the turn ends). Before agent_runs (run_id CASCADE).
  { name: "mila_tf_turn_items", table: s.milaTfTurnItems,  key: byAthlete(), category: "chats",        retention: "delete", export: rows() },
  { name: "agent_runs",         table: s.agentRuns,        key: byAthlete(), category: "system",       retention: "delete", export: rows(),
    note: "Every run of the agent and its trace: the steps, tools called, sources read and what it cost." },
  { name: "brand_fit_narratives",  table: s.brandFitNarratives,   key: byAthlete(), category: "brands",       retention: "delete", export: rows() },
  // Your rates (0132): Mila's suggested range per kind of work, saved from onboarding's rate-range card.
  { name: "athlete_rate_ranges",   table: s.athleteRateRanges,    key: byAthlete(), category: "deals",        retention: "delete", export: rows() },
  // The deal read's stored lines (0133): "why this brand fits you" and the goal a deal serves, per deal.
  { name: "deal_reads",            table: s.dealReads,            key: byAthlete(), category: "deals",        retention: "delete", export: rows() },
  { name: "mia_evaluation_runs",   table: s.miaEvaluationRuns,    key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "mia_evidence_snapshots", table: s.miaEvidenceSnapshots, key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "identity_intelligence_attempts", table: s.identityIntelligenceAttempts, key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "identity_profiles",     table: s.identityProfiles,     key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "golden_athletes",       table: s.goldenAthletes,       key: byAthlete(), category: "intelligence", retention: "delete", export: rows(),
    note: "Calibration ground truth an operator recorded about her; hers, so it goes with the account." },

  // ── research (what Nomila found) ──
  { name: "research_evidence",        table: s.researchEvidence,       key: byAthlete(), category: "research", retention: "delete", export: rows() },
  { name: "research_source_payloads", table: s.researchSourcePayloads, key: byAthlete(), category: "research", retention: "delete",
    export: { mode: "references", columns: ["id", "run_id", "provider", "model", "endpoint_family", "payload_hash", "bytes", "fetched_at", "retained_until"],
      why: "Copies of third-party pages and provider answers; the evidence and facts drawn from them are exported in full." } },
  { name: "research_runs",            table: s.researchRuns,           key: byAthlete(), category: "research", retention: "delete", export: rows() },
  { name: "athlete_research_state",   table: s.athleteResearchState,   key: byAthlete(), category: "research", retention: "delete", export: rows() },

  // ── about you ──
  { name: "athlete_inferences",   table: s.athleteInferences,   key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "athlete_affiliations", table: s.athleteAffiliations, key: byAthlete(), category: "profile", retention: "delete", export: rows() },
  { name: "athlete_asserted",     table: s.athleteAsserted,     key: byAthlete(), category: "profile", retention: "delete", export: rows() },
  { name: "athlete_facts",        table: s.athleteFacts,        key: byAthlete(), category: "profile", retention: "delete", export: rows() },

  // ── goals ──
  { name: "objective_events",        table: s.objectiveEvents,       key: byAthlete(), category: "goals", retention: "delete", export: rows() },
  { name: "objectives",              table: s.objectives,            key: byAthlete(), category: "goals", retention: "delete", export: rows() },
  { name: "objective_proposal_sets", table: s.objectiveProposalSets, key: byAthlete(), category: "goals", retention: "delete", export: rows() },

  // ── drafts, receipts, money — all point at deals / threads, so before them ──
  { name: "pending_actions", table: s.pendingActions, key: byAthlete(), category: "drafts",   retention: "delete", export: rows() },
  { name: "agent_actions",   table: s.agentActions,   key: byAthlete(), category: "receipts", retention: "delete", export: rows() },
  // Bookings v2: references payments and bookings, so it goes before both.
  { name: "athlete_payout_adjustments", table: s.athletePayoutAdjustments, key: byAthlete(), category: "bookings", retention: "delete", export: rows(),
    note: "What she owed back for refunds she caused (the actual Stripe fee). Deleted with her account; an unrecovered 'owed' amount is written off." },
  { name: "payments",        table: s.payments,       key: byAthlete(), category: "deals",    retention: "delete",
    export: rows(["brand_confirm_token_hash"], { why: "The brand's confirm-link credential (0097) — the brand's, and a credential." }),
    note: "Deleted. First (one short transaction, exactly once per deletion), each payment in which money moved or was held leaves one de-identified financial_ledger_records row (amounts, currency, status, Stripe ids; no athlete, deal, Connect account or brand email), and payment_events payloads that name her are cut to a whitelist — both kept for the financial_record retention period (TBD; server/lib/privacy/financialRecords.ts). Stripe remains the system of record. Deletion is refused while a payment is still in flight. Exported with every column, including checkout_expires_at (0095, when the pay link's one Checkout session lapses), metadata.duplicate_charges (a second payment flagged for refund) and the refund / chargeback / transfer-reversal record (0098: refunded_cents, refunded_at, refund_reason, refund_requested_by, stripe_transfer_reversal_id, stripe_dispute_id, dispute_status)." },

  // ── bookings (Bookings v2, 0099). After `payments` (payments.booking_id → bookings), children before parents ──
  { name: "booking_events",   table: s.bookingEvents,   key: via("booking_id", "bookings"), category: "bookings", retention: "delete", export: rows() },
  { name: "booking_messages", table: s.bookingMessages, key: via("booking_id", "bookings"), category: "bookings", retention: "delete",
    export: rows(undefined, { why: "Held or blocked messages never reached the other side; they are exported as withheld, not as text.",
      redact: (row) => row.moderation === "held" || row.moderation === "blocked" ? { ...row, body: null, body_omitted: "withheld by moderation" } : row }) },
  { name: "booking_guests",   table: s.bookingGuests,   key: via("booking_id", "bookings"), category: "bookings", retention: "delete",
    export: rows(["email", "email_hash"], { why: "A guest's email address is the guest's (the booker gave it to Nomila to send the guest a call link); she gets the first name she sees in the call." }) },
  { name: "fan_blocks",       table: s.fanBlocks,       key: byAthlete(), category: "bookings", retention: "delete",
    export: rows(["email_hash", "phone_hash"], { why: "A keyed hash of someone else's email or phone; she gets the first name she blocked and when." }),
    note: "Her blocks (0154). Before bookings: booking_id references bookings (ON DELETE SET NULL)." },
  { name: "booking_reports",  table: s.bookingReports,  key: byAthlete(), category: "bookings", retention: "delete",
    export: { mode: "references", columns: ["id", "booking_id", "reported_by", "category", "status", "resolution", "opened_at", "resolved_at"],
      why: "A report's text is the reporter's own account and may name them; the report itself and its outcome are listed." } },
  { name: "bookings",         table: s.bookings,        key: byAthlete(), category: "bookings", retention: "delete",
    export: rows(["buyer_email", "buyer_phone", "buyer_email_hash", "buyer_phone_hash", "buyer_token_hash", "otp_hash", "stripe_identity_session_id"],
      { why: "The buyer's contact details and verification credentials are the buyer's; she gets the name and message she already saw." }),
    note: "Deletion is refused while a booking payment is in flight (funded / disputed), like deals. Buyer data also has its own minimisation clock (buyer_redacted_at)." },
  { name: "offer_slots",      table: s.offerSlots,      key: byAthlete(), category: "bookings", retention: "delete", export: rows() },
  { name: "offers",           table: s.offers,          key: byAthlete(), category: "bookings", retention: "delete", export: rows() },
  { name: "safety_blocks",    table: s.safetyBlocks,    key: byAthlete(), category: "bookings", retention: "delete",
    export: rows(["value_hash"], { why: "A keyed hash of someone else's email, phone or card." }),
    note: "Only her own blocks (scope 'athlete'). Platform bans have athlete_id NULL: they are trust-and-safety records, not hers, and stay." },

  // ── Partner door (0103): requests sent from her public card. After `payments` (payments.partner_request_id), before
  //    `inbox_threads` and `deals` (partner_requests references both) ──
  { name: "partner_requests", table: s.partnerRequests, key: byAthlete(), category: "deals", retention: "delete",
    export: rows(["contact_email", "contact_email_hash", "draft_token_hash", "token_nonce", "confirm_token_hash", "status_token_hash", "reply_token_hash"],
      { why: "The sender's email address is theirs (Nomila relays every message so it stays private from her), and the token hashes are their credentials; she gets the request, the sender's name and every message." }),
    note: "Brand contact details are redacted 180 days after the deal's opportunity closes, and 7 days after an unconfirmed request expires (services/partner/sweep.ts)." },
  { name: "partner_fit_previews", table: s.partnerFitPreviews, key: byAthlete(), category: "deals", retention: "delete", export: rows() },
  { name: "partner_settings", table: s.partnerSettings, key: byAthlete(), category: "deals", retention: "delete", export: rows() },

  // ── inbox (zero retention: only the deal survives; email text is never exported) ──
  { name: "inbox_messages", table: s.inboxMessages, key: byAthlete(), category: "inbox", retention: "delete",
    export: { mode: "references", columns: ["id", "thread_id", "direction", "platform", "received_at", "external_message_id", "connected_account_id", "created_at"],
      why: "Email and DM text is not kept under zero retention; a legacy row that still holds a subject, body, sender or attachment is listed by reference only." } },
  { name: "inbox_threads",  table: s.inboxThreads,  key: byAthlete(), category: "inbox", retention: "delete",
    export: rows(["subject"], { why: "The subject line is email text; Nomila's own summary and draft are exported." }) },
  { name: "inbox_senders",  table: s.inboxSenders,  key: byAthlete(), category: "inbox", retention: "delete",
    export: { mode: "references", columns: ["id", "brand_id", "message_count", "first_seen_at"], why: "A sender's name and address are the sender's, read from mail." } },

  // ── deals ──
  { name: "deal_installments", table: s.dealInstallments, key: via("period_id", "deal_periods"), category: "deals", retention: "delete", export: rows() },
  { name: "deal_periods",      table: s.dealPeriods,      key: via("deal_id", "deals"),          category: "deals", retention: "delete", export: rows() },
  { name: "deal_deliverables", table: s.dealDeliverables, key: via("deal_id", "deals"),          category: "deals", retention: "delete", export: rows() },
  { name: "deals",             table: s.deals,            key: byAthlete(), category: "deals", retention: "delete", export: rows(),
    note: "Contract files live in GCS under athletes/<id>/contracts/ (ATHLETE_STORAGE)." },
  { name: "opportunities",     table: s.opportunities,    key: byAthlete(), category: "deals", retention: "delete", export: rows() },
  { name: "connect_accounts",  table: s.connectAccounts,  key: byAthlete(), category: "deals", retention: "delete", export: rows(),
    note: "The Stripe Connect account itself stays with Stripe (EXTERNAL_STORES)." },

  // ── chats ──
  { name: "voice_context", table: s.voiceContext, key: byAthlete(), category: "chats", retention: "delete", export: rows() },
  { name: "chat_messages", table: s.chatMessages, key: byAthlete(), category: "chats", retention: "delete",
    export: rows(undefined, {
      why: "A tool result can carry mail the tool read before results were stubbed to ids; those are exported without their content.",
      redact: (row) => row.role === "tool" ? { ...row, content: null, content_omitted: "tool result (may quote email text)" } : row,
    }) },
  { name: "conversations",       table: s.conversations,      key: byAthlete(), category: "chats",  retention: "delete", export: rows() },
  // Mila's sessions (0141, first written for TrueForge; the Mastra engine's now): which engine thread holds each
  // conversation, the tools' state across its turns (fact keys, connectors offered, her own words) and app events Mila has not been told yet.
  { name: "mila_tf_sessions",    table: s.milaTfSessions,     key: byAthlete(), category: "chats",  retention: "delete", export: rows() },
  // Mila starts the conversation (0143, MILA_PROACTIVE, dev only): the app events Mila may act on (ids and short labels,
  // no email text) and what the dispatcher decided for each.
  { name: "athlete_events",      table: s.athleteEvents,      key: byAthlete(), category: "chats",  retention: "delete", export: rows() },
  // What the athlete chose for each Mila capability (0146, MILA_WELCOME): yes / not now / never / paused / off, per
  // account where scoped, with a copy of what each yes covered, and every change (history before choices: its FK).
  { name: "mila_choice_history", table: s.milaChoiceHistory,  key: byAthlete(), category: "account", retention: "delete", export: rows() },
  { name: "mila_choices",        table: s.milaChoices,        key: byAthlete(), category: "account", retention: "delete", export: rows() },
  // Mila's voice and language (0152): the voice they picked, the language they talk to Mila in, their "post in" languages.
  { name: "mila_voice_settings", table: s.milaVoiceSettings,  key: byAthlete(), category: "account", retention: "delete", export: rows() },
  { name: "notification_log",    table: s.notificationLog,    key: byAthlete(), category: "system", retention: "delete", export: rows() },
  // Push notifications (0130): her phones' push tokens (a device credential: listed, never exported), her choices, and
  // which notifications were sent (kinds and keys, no text).
  { name: "push_devices",     table: s.pushDevices,     key: byAthlete(), category: "system", retention: "delete",
    export: rows(["token"], { why: "A push token is a device credential." }) },
  { name: "push_preferences", table: s.pushPreferences, key: byAthlete(), category: "system", retention: "delete", export: rows() },
  { name: "push_sends",       table: s.pushSends,       key: byAthlete(), category: "system", retention: "delete",
    export: rows(["tickets"], { why: "Expo delivery-ticket ids, kept only until their receipts are read: delivery plumbing tied to a phone." }) },

  // ── connections (tokens are never exported) ──
  { name: "gmail_dead_letters",    table: s.gmailDeadLetters,    key: byAthlete(), category: "connections", retention: "delete", export: rows() },
  { name: "oauth_connect_states",  table: s.oauthConnectStates,  key: byAthlete(), category: "connections", retention: "delete",
    export: { mode: "none", why: "Short-lived security records for a connect in progress (hashes only, 10-minute life, pruned a day after expiry)." } },
  { name: "outlook_subscriptions", table: s.outlookSubscriptions, key: via("connected_account_id", "connected_accounts"), category: "connections", retention: "delete",
    export: rows(["client_state_hash", "graph_subscription_id"], { why: "Push-channel credentials." }) },
  { name: "connection_merge_log",  table: s.connectionMergeLog,  key: byAthlete(), category: "connections", retention: "delete", export: rows(),
    note: "No FK by design (0071); old_row already excludes tokens." },
  { name: "connected_accounts",    table: s.connectedAccounts,   key: byAthlete(), category: "connections", retention: "delete",
    export: rows(["access_token", "refresh_token"], { why: "Access tokens are secrets." }),
    note: "Provider grants are revoked BEFORE this row (and its tokens) is deleted." },

  // ── profile snapshots ──
  { name: "athletes_current",  table: s.athletesCurrent,  key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },
  { name: "athlete_snapshots", table: s.athleteSnapshots, key: byAthlete(), category: "intelligence", retention: "delete", export: rows() },

  // ── account + identity ──
  { name: "account_roles",  table: s.accountRoles,  key: byAthlete("account_id"), category: "account", retention: "delete", export: rows() },
  { name: "athlete_users",  table: s.athleteUsers,  key: byAthlete(), category: "account", retention: "delete", export: rows() },
  { name: "identity_claims", table: s.identityClaims, category: "account", retention: "delete", export: rows(),
    key: { by: "custom", describe: "athlete_id is hers, or user_id is one of her sign-in users", dependsOn: ["users"],
      where: (sc) => sql`(athlete_id = ${sc.athleteId}::uuid OR user_id IN ${uuidList(sc.userIds)})` } },
  { name: "athlete_index_matches", table: s.athleteIndexMatches, category: "account", retention: "delete",
    export: rows(["candidates"], { why: "The candidate list names other athletes." }),
    key: { by: "custom", describe: "chosen_athlete_id or created_athlete_id is hers (the FKs only SET NULL, which would leave her search query behind)", dependsOn: [],
      where: (sc) => sql`(chosen_athlete_id = ${sc.athleteId}::uuid OR created_athlete_id = ${sc.athleteId}::uuid)` } },
  { name: "user_roles", table: s.userRoles, category: "account", retention: "delete", export: rows(),
    key: { by: "custom", describe: "user_id is one of her sign-in users", dependsOn: ["users"], where: (sc) => sql`user_id IN ${uuidList(sc.userIds)}` } },
  { name: "athletes",   table: s.athletes,  category: "account", retention: "delete", export: rows(),
    key: { by: "custom", describe: "id is hers", dependsOn: [], where: (sc) => sql`"id" = ${sc.athleteId}::uuid` } },
  { name: "users",      table: s.users,     category: "account", retention: "delete", export: rows(),
    key: { by: "custom", describe: "her sign-in users: members of athlete_users for her, or the user signed in as athletes.auth_id; never a user who also belongs to another athlete (resolved up front into AthleteScope.userIds)", dependsOn: [],
      where: (sc) => sql`"id" IN ${uuidList(sc.userIds)}` } },
];

// ─── Tables that are NOT athlete data (each with its reason). Every other table must be in the manifest. ─────

/**
 * `financial_record`: kept after account deletion only in de-identified form, for a period set by
 * FINANCIAL_RECORD_RETENTION_DAYS (TBD pending counsel/accountant confirmation; financialRecordRetentionDays()), then
 * purged by server/scripts/privacy/purgeExpiredFinancialRecords.ts. Never indefinite.
 *
 * `deletion_record`: exists only while an account deletion is not yet verified complete (opaque external ids and
 * paths it still has to clean up, and counts); removed by the deletion run's finish step once everything is confirmed.
 */
export const NOT_ATHLETE_DATA: Record<string, { reason: string; retention: "shared" | "financial_record" | "deletion_record" }> = {
  account_deletion_items: { retention: "deletion_record", reason: "The reconciliation ledger of an account deletion (0145): what it still has to clean up outside its row purge (storage prefixes / object paths, the Firebase uid, Langfuse, provider-grant connection ids) and per-table row counts, each pending / confirmed / failed / skipped. No athlete column and no foreign key; the rows are removed when the deletion is verified complete (the receipt keeps counts only), and stay only while something is unconfirmed, for an operator to finish." },
  inbox_brands:          { retention: "shared", reason: "Shared brand research, one row per brand for every athlete. Her links to a brand (deals, opportunities, card_overrides, brand_fit_narratives …) are hers and are in the manifest. known_athlete_partnerships holds public partnership names, not account data." },
  model_params:          { retention: "shared", reason: "Versioned model parameters." },
  prompts:               { retention: "shared", reason: "Versioned prompt text." },
  content_playbooks:     { retention: "shared", reason: "The shared content playbook (0125): lasting best practice per sport × stage × platform, shared by every athlete in that key. No athlete column; built from web pages, never from her data." },
  research_budget_days:  { retention: "shared", reason: "Per-day spend counters, no athlete reference." },
  ask_mila_spend_days:   { retention: "shared", reason: "Public Mila's global daily spend (the spend cap), one row per day, no athlete reference." },
  ask_mila_visitor_days: { retention: "shared", reason: "Public Mila's per-visitor daily turn counter, keyed by a daily-salted IP hash (unlinkable across days), no athlete reference." },
  research_planner_runs: { retention: "shared", reason: "Planner telemetry across all athletes (one row per nightly pass, not per athlete). Its plans jsonb lists athlete ids (no FK): account deletion SCRUBS her out of it (SCRUBBED_REFERENCES) rather than deleting the pass, which also describes other athletes." },
  shopify_shops:         { retention: "shared", reason: "A brand's Shopify store that installed the catalog-only app (read_products): its domain, name, brand link and sealed token. Brand data, no athlete column; her approvals are shop_brand_approvals (manifest)." },
  shop_catalog_products: { retention: "shared", reason: "A brand's products as its store reports them. Brand data, no athlete column. A pick of hers that came from it keeps its own row in shop_items (SET NULL here)." },
  brand_site_previews:   { retention: "shared", reason: "The light read of a brand's own homepage (title, description, og tags) for the Partner door, one row per domain, 7-day cache. Brand data, no athlete column." },
  atmosphere_library:    { retention: "shared", reason: "The shared atmosphere photo library (0120): Unsplash or Pexels photos stored once under atmosphere/shared/ and reused by every athlete. No athlete column; which photo her slots show is atmosphere_library_placements (manifest)." },
  public_rate_counters:  { retention: "shared", reason: "Database-backed rate counters for the public Partner routes: a keyed hash per bucket and a count per window, no athlete column, no IP, no email. Pruned after two weeks." },
  partner_visitor_codes: { retention: "shared", reason: "A visitor's 6-digit email code for \"Your requests\": a keyed hash of THEIR email and of the code, 15-minute life, pruned a day after expiry. The visitor's, not the athlete's; no athlete column." },
  email_signin_codes:    { retention: "shared", reason: "Sign-in codes sent by email (0129): keyed hashes (HMAC with EMAIL_CODE_SECRET) of the address, the 6-digit code and the caller's IP, an attempt count and timestamps. Made before anyone is signed in, so there is no athlete column and nothing in the clear names her; 10-minute life, purged two days after it is made (the lockout looks back 48 h)." },
  payment_events:        { retention: "financial_record", reason: "Stripe webhook idempotency + audit ledger, keyed by Stripe event id, no athlete column. On account deletion every payload that names her (her ids, her payments' Stripe ids, her Connect account) is cut to data.object {id, object, amount*, currency, status, created}, dropping Connect account details, billing details and emails. Rows are purged by received_at once the financial_record period (TBD) has passed." },
  financial_ledger_records: { retention: "financial_record", reason: "De-identified ledger rows written by account deletion, one per payment in which money moved or was held: amounts (incl. refunded_cents), currency, status (incl. charged_back) and Stripe ids (incl. refund, transfer reversal and chargeback ids, 0098) for reconciliation against Stripe. No athlete, deal, installment, Connect account or brand email column and no foreign key. Purged by deidentified_at once the financial_record period (TBD) has passed." },
};

// ─── Shared rows the delete scrubs instead of deleting ─────────────────────────────────────────────────────────

/**
 * Tables that are NOT athlete data (NOT_ATHLETE_DATA) but whose jsonb can name her id without a foreign key. The
 * delete scrubs them right after its row purge: `dropArrayEntries` removes array elements whose `entryKey` is her id
 * (the per-athlete plan of a planner pass), then every remaining mention of her id in `columns` is replaced by
 * DELETED_ATHLETE_MARKER. Aggregate counters (evaluated / admitted …) stay: they name no one.
 *
 * Scrub rather than delete: one research_planner_runs row is a whole nightly pass over every athlete, so deleting
 * the rows that mention her would erase other athletes' telemetry too.
 */
export const DELETED_ATHLETE_MARKER = "deleted-athlete";

export const SCRUBBED_REFERENCES: readonly { table: string; columns: string[]; dropArrayEntries?: { column: string; entryKey: string } }[] = [
  { table: "research_planner_runs", columns: ["plans", "transitions", "error"], dropArrayEntries: { column: "plans", entryKey: "athleteId" } },
];

// ─── Files and external stores ───────────────────────────────────────────────────────────────────────────────

export const mediaBucketName      = (): string => process.env.MEDIA_BUCKET ?? "nomila-v2-athlete-media";             // server/lib/mediaStore.ts
export const attachmentBucketName = (): string => process.env.INBOX_ATTACHMENT_BUCKET ?? "nomila-v2-inbox-attachments"; // server/lib/inboxAttachmentStore.ts

export interface StoragePrefix { bucket: () => string; prefix: (athleteId: string) => string; holds: string }

/** Every GCS prefix that holds her objects. Deleted (and re-listed to verify) by account deletion phase 2. */
export const ATHLETE_STORAGE: readonly StoragePrefix[] = [
  { bucket: mediaBucketName, prefix: (id) => `athletes/${id}/`,
    holds: "Media library: Instagram rehosts, uploads, review frames, posters, Studio generations / edits / stitched videos, beat posters, atmosphere images." },
  { bucket: attachmentBucketName, prefix: (id) => `athletes/${id}/`,
    holds: "Inbox attachments (legacy rehosts) and contracts she uploaded or saved." },
  { bucket: attachmentBucketName, prefix: (id) => `studio-briefs/${id}/`,
    holds: "Brand briefs (PDF) uploaded to Studio." },
];

/**
 * Columns that name an object directly. A path outside the prefixes above (legacy layouts) is deleted one by one;
 * a path inside them is already covered.
 */
export const ATHLETE_STORAGE_COLUMNS: readonly { table: string; column: string; bucket: () => string }[] = [
  { table: "media_assets",         column: "gcs_path",        bucket: mediaBucketName },
  { table: "media_assets",         column: "gcs_thumb_path",  bucket: mediaBucketName },
  { table: "studio_edit_previews", column: "gcs_path",        bucket: mediaBucketName },
  { table: "studio_plans",         column: "brief_file_path", bucket: attachmentBucketName },
];

export interface ExternalStore { name: string; holds: string; onDelete: string; deletableByUs: boolean; exported?: string }

export const EXTERNAL_STORES: readonly ExternalStore[] = [
  { name: "Firebase Authentication", holds: "Her sign-in user.", onDelete: "Deleted (Microsoft sign-ins have no Firebase user).", deletableByUs: true },
  { name: "Google OAuth (Gmail, YouTube)", holds: "The grant behind the stored tokens.", onDelete: "Revoked at https://oauth2.googleapis.com/revoke before the tokens are deleted.", deletableByUs: true },
  { name: "Microsoft Graph (Outlook)", holds: "A change-notification subscription and the grant.", onDelete: "Subscription deleted. Microsoft has no per-app revoke an app can call for a personal account (revokeSignInSessions would sign her out of everything), so deleting the token is what severs access; she can also remove Nomila at account.live.com/consent.", deletableByUs: false },
  { name: "Instagram (Instagram Login)", holds: "The webhook subscription and the grant.", onDelete: "Webhooks unsubscribed (DELETE /me/subscribed_apps). Meta exposes no app-side revoke for Instagram Login tokens; deleting the token severs access; she can also remove Nomila under Instagram → Settings → Apps and websites.", deletableByUs: false },
  { name: "Stripe", holds: "Her Connect account, charges, transfers and refunds.", onDelete: "Not deleted: Stripe keeps financial records under its own legal obligations.", deletableByUs: false },
  { name: "TikTok (Login Kit)", holds: "The grant behind the stored access token.", onDelete: "Revoked at https://open.tiktokapis.com/v2/oauth/revoke/ (client_key + client_secret + access token) before the token is deleted.", deletableByUs: true },
  { name: "Langfuse", holds: "LLM traces (prompts and responses), which can quote her data. Every trace started inside her request or one of her workflow steps carries userId = her athlete id (server/lib/tracing.ts withTraceAthlete).",
    onDelete: "When LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are set, her traces are found by userId (GET /api/public/v2/observations) and deleted (DELETE /api/public/traces); the outcome is the receipt's purge_traces step. Traces written before userId tagging, or by background work outside her request / workflow context, carry no userId and cannot be found per athlete: they age out under the Langfuse project's data-retention setting.",
    deletableByUs: true },
  { name: "LiveKit Cloud", holds: "Session and analytics logs for each voice room (room name, participant identity, timings). The participant identity is an opaque per-athlete pseudonym (server/voice/webTokenRoute.ts voiceIdentityFor), not her athlete id; the agent-dispatch metadata still carries her athlete id because the voice worker (mila-voice) reads it from there. Nomila records no audio (no egress). "
      + "Bookings v2 session video (person to person, no worker): the same kind of logs for each booking's room, whose name and both participant identities are keyed pseudonyms of the booking (server/services/bookings/session/sessionRoom.ts), never a booking, athlete or buyer id or name. Her and the buyer's camera and microphone pass through LiveKit's media servers live and are not recorded (no egress, no recording grant). The join and leave times LiveKit reports come back to Nomila as booking_events attendance rows (evidence for a reviewer, never a payment trigger), which are exported and deleted with her bookings.",
    onDelete: "Not deletable by us: LiveKit Cloud keeps session logs under its own retention. After deletion the pseudonyms (voice and booking rooms alike) no longer map to anything Nomila holds.", deletableByUs: false },
  { name: "fal.ai (Studio segmentation)", holds: "Image crops of her photos sent as data URIs (never a signed URL) to fal.run for masks.",
    onDelete: "Not deletable by us: fal exposes no per-user or per-request deletion API. Per fal's docs, generated media stays on the fal CDN for at least 7 days by default; request payloads are retained under fal's own terms.", deletableByUs: false },
  { name: "OpenRouter (Studio image / video)", holds: "Prompts and reference images of her (data URIs or short-lived signed GCS URLs) for Studio generations; outputs are rehosted to GCS.",
    onDelete: "Not deletable by us: OpenRouter exposes no deletion API. It does not keep prompt / completion content unless the account opts into prompt logging, but keeps request metadata; the upstream model provider it routes to retains under its own policy.", deletableByUs: false },
  { name: "TrueForge (Mila's former agent runtime, dev only)", holds: "Nothing new. Until 9 Nov 2026, while MILA_TF_CHAT was on (dev only; never in production), the transcript of each Mila chat conversation (her messages, Mila's replies, tool calls and their results) in TrueForge's own database, one session per conversation. Mila runs only on the Mastra engine now (our own database, below) and the app no longer calls TrueForge.",
    onDelete: "Not deleted by the account delete any more: the app's TrueForge client was removed with TrueForge (Mastra-only, PR 3), so phase 2 no longer records or deletes TrueForge sessions (a run that recorded one before is skipped as trueforge_removed). What the dev TrueForge instance still holds goes when that instance and its database are decommissioned; its Postgres backups age out under that instance's backup retention.", deletableByUs: false },
  { name: "Mastra engine store (Mila's agent runtime)", holds: "In OUR database, schema \"mastra\" (0147, not a manifest table): each Mila conversation's thread (thread id = their mila_tf_sessions row id, resource = their athlete id) and its messages (their messages, Mila's replies, tool calls and their results). Working memory and every other automatic Mastra memory are off, so no profile of them is kept there.",
    onDelete: "Deleted: account deletion purge_rows deletes every row of the schema that names them as resource or one of their threads, BEFORE their session rows go (server/agent/engine/mastra/lifecycle.ts); verify recounts it with the manifest tables and purges stragglers. Counted on the receipt as database mastra.<table>.", deletableByUs: true,
    exported: "Exported (services/privacy/exportMastraData.ts, 3 Nov 2026): the SAME athlete→thread mapping and the SAME information_schema discovery as the delete sweep above (but exclusive: a row in their thread that Mastra attributes to another resource, or a session-keyed thread naming another resource, is not exported), so every table she has rows in — her threads, her messages, and working memory / observational memory if ever turned on — comes out under export.mastra_engine (automatic for tables keyed by resource or thread id; a table with neither is classified in lifecycle.ts MASTRA_NOT_ATHLETE_TABLES, enforced by a schema guard test), and a database without the schema (prod today) reports present: false with a plain note instead of erroring. No separate table exists yet for chat-v2 card outcomes (the card DTO is part of the message content, already exported with it), identity re-check runs (workflow_runs rows, created_by identity_recheck — already a manifest table above) or attachment analysis (no such table in shared/schema.ts). The chat gap-seed cursor (mila_tf_sessions.tool_state.chatSeen: a timestamp + ids of their own chat rows) is exported with that row: it is processing state about their own messages, holds no secret and names no one else." },
  { name: "Model providers (Vertex AI / Gemini, Kimi, Anthropic, OpenAI)", holds: "Request logs, if any, under each provider's terms.", onDelete: "Not deletable by us.", deletableByUs: false },
  { name: "Backups", holds: "Cloud SQL backups + point-in-time recovery; GCS soft delete.", onDelete: "Age out automatically within 7 days.", deletableByUs: false },
];

// ─── Lookups + the scope predicate ───────────────────────────────────────────────────────────────────────────

const BY_NAME = new Map(ATHLETE_DATA_MANIFEST.map((e) => [e.name, e]));

export function manifestEntry(name: string): ManifestEntry {
  const e = BY_NAME.get(name);
  if (!e) throw new Error(`athleteDataManifest: no entry for table ${name}`);
  return e;
}

/** The entry's position in the delete order (0 = deleted first). */
export const deleteOrderOf = (name: string): number => ATHLETE_DATA_MANIFEST.indexOf(manifestEntry(name));

/** The SQL predicate selecting her rows of `entry` (unqualified column names, for `… FROM <table> WHERE <this>`). */
export function athleteWhere(entry: ManifestEntry, scope: AthleteScope): SQL {
  const k = entry.key;
  if (k.by === "athlete_column") return sql`${sql.identifier(k.column)} = ${scope.athleteId}::uuid`;
  if (k.by === "parent") {
    const parent = manifestEntry(k.parent);
    return sql`${sql.identifier(k.column)} IN (SELECT "id" FROM ${parent.table} WHERE ${athleteWhere(parent, scope)})`;
  }
  return k.where(scope);
}

function athleteWhereByName(name: string, scope: AthleteScope): SQL {
  return athleteWhere(manifestEntry(name), scope);
}

/** Tables an entry's predicate reads (its parent chain or `dependsOn`), which must be deleted after it. */
export function readsFrom(entry: ManifestEntry): string[] {
  if (entry.key.by === "athlete_column") return [];
  if (entry.key.by === "parent") return [entry.key.parent];
  return entry.key.dependsOn;
}

export function categoryCounts(): Record<DataCategory, number> {
  const out = Object.fromEntries(Object.keys(DATA_CATEGORIES).map((c) => [c, 0])) as Record<DataCategory, number>;
  for (const e of ATHLETE_DATA_MANIFEST) out[e.category]++;
  return out;
}
