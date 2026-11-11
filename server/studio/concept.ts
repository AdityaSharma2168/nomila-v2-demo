/**
 * studio/concept — a campaign concept, from brief to deck slot. The first feature that drives the
 * whole Studio stack end to end, and therefore the first real exercise of A2.5's gate and A3.1's
 * clearance machine.
 *
 *   assembleBrief → previewGeneration → [a person approves the spend] → generation_jobs
 *   → router → GCS → media_assets(origin='generated', approval_status='draft')
 *   → [a person approves the CONTENT] → kit_content + card_overrides → the deck renders it
 *
 * TWO DOORS, DELIBERATELY NOT ONE. `runConceptGeneration` makes the picture; `embedConceptInDeck`
 * puts it in the deck. They are separate functions because a human decision sits between them — the
 * A3.1 approval — and a single "generate and place it" call would have nowhere to put that decision.
 *
 * ── THE DECK BOUNDARY, AND WHY IT IS SHAPED LIKE THIS ────────────────────────────────────────────
 *
 * The pitch-deck engine (mediaKitService / curator / narrator / kitCache) is out of this lane to
 * modify, and nothing in it changes for this feature. The deck already builds a `campaignConcept`
 * card whose `image` is a RECYCLED athlete photo (mediaKitService: `heroImg ?? whyFitsImg ?? null`).
 * A3.2 replaces that stand-in. Two writes do it, and the ORDER is the safety property:
 *
 *   1. kit_content   — the canonical embed-by-reference record (migration 0022 D7). It carries a
 *                      real asset_id, so the database can GUARD it: generationGuards.sql §3 refuses
 *                      any row whose asset is generated-and-not-approved. Nothing reads this table
 *                      yet; it is written first precisely BECAUSE it is the guardable one.
 *   2. card_overrides.data.images.campaignConcept
 *                    — the mechanism the renderer actually honours today. cardOverrides.applyOverrides
 *                      already routes `images[cardId]` onto a card's `image` field, and
 *                      kitCache.signKit already signs `campaignConcept.image`. So this write lands
 *                      the asset on screen with ZERO lines changed in the deck engine.
 *
 * Write 1 must commit before write 2 runs. A draft asset is refused by Postgres before the picture
 * can reach the deck. These cannot share a transaction — getOverrides/saveOverrides bind the
 * module-level `db` and live in the deck engine, which is out of lane to change — so if write 2
 * fails after write 1 succeeds, the embed is RECORDED but not RENDERED. That failure direction is
 * chosen: a missing picture, never an unapproved one.
 *
 * When the deck engine eventually reads kit_content itself, write 2 becomes redundant and is deleted.
 * The record left behind is already correct.
 *
 * THIS IS `generate`, NOT `edit`. A concept is net-new: there is no source frame to stay continuous
 * with, so `mode: "generate"` → `image.generate`, and `media_assets.derived_from_asset_id` stays
 * NULL by definition. Lineage is `generation_job_id` plus the frozen brief. The edit/composite path
 * (a real frame, edit regions, a masked composite, `derived_from_asset_id` set) is A4 and is not
 * built here — see the table in docs/plans/studio-a32-campaign-concept-plan.md §4.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { kitContent, mediaAssets, mediaKits } from "../../shared/schema";
import { getOverrides, saveOverrides } from "../services/cardOverrides";
import { saveBuffer, rehostFromUrl, signedUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";
import { assembleBrief, type BriefDeliverable, type InboundAsk } from "./brief";
import { createGenerationJob, claimJob, failJob, succeedJob, recordGeneratedAsset } from "./jobs";
import { previewGeneration, runGeneration, type GenerationPreview, type PlannedReference, type PreviewOptions } from "./preview";
import { GenerationError, type GeneratedAsset, type ImageRef } from "./types";

const logger = createLogger("studio/concept");

/** The deck card a concept fills. Must match the card id mediaKitService assembles. */
export const CONCEPT_CARD_ID = "campaignConcept";

/**
 * A concept is a still, and the deck card renders it as a portrait photo plate, so 4:5 (the `post`
 * entry in preview.ts's ASPECT table) is the shape that fits. Overridable per call; not a constant
 * anyone should need to change to make the feature work.
 */
const DEFAULT_DELIVERABLE: BriefDeliverable = "post";

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────

export interface ConceptInput {
  /**
   * TENANCY: must come from `req.athleteId`. Never from a client body, a query string, or a model
   * tool call — every read and write below is scoped by it, so a borrowed id would resolve to
   * another athlete's deck. Same contract assembleBrief states for the same reason.
   */
  athleteId: string;
  /**
   * The brand this concept pitches. REQUIRED and non-zero: the deck only builds a campaignConcept
   * card `if (brand && cc)`, so an untailored (brand_id 0) deck has no slot for the result to land
   * in. Generating one anyway would spend money on a picture with nowhere to go.
   */
  brandId: number;
  /** An ask somebody brought us. Present ⇒ origin "inbound" and the direction travels as untrusted. */
  ask?: InboundAsk;
  /** Defaults to "post" (4:5). */
  deliverable?: BriefDeliverable;
}

export interface RunConceptOptions extends PreviewOptions {
  /**
   * The ceiling the athlete agreed to spend, in USD.
   *
   * Spend approval is NOT persisted anywhere — A3.1's header is explicit that it is a third state
   * concept with no home yet, and U2 owns giving it one. Until then it is an argument every caller
   * must state, re-checked here against the freshly derived quote. An unpriced model is refused
   * outright: there is no number to compare a ceiling to, and "unknown" must never spend as if it
   * were $0.
   */
  approvedCostUsd: number;
}

export interface ConceptGeneration {
  jobId: string;
  preview: GenerationPreview;
  /** One row per asset produced, each already `draft`. Approval is per asset, not per job. */
  assets: Array<{ id: string; gcsPath: string | null; approvalStatus: string | null }>;
}

// ─── Brief → preview ────────────────────────────────────────────────────────────────────────────

function briefInputFor(input: ConceptInput) {
  const inbound = !!input.ask?.ask?.trim();
  return {
    athleteId: input.athleteId,
    brandId: input.brandId,
    origin: inbound ? ("inbound" as const) : ("system" as const),
    objective: "concept" as const,
    deliverable: input.deliverable ?? DEFAULT_DELIVERABLE,
    // The fork, stated rather than inferred. A concept has no frame to preserve.
    mode: "generate" as const,
    ...(inbound ? { ask: input.ask } : {}),
  };
}

/**
 * What a concept generation WOULD do, and whether it may. No spend, no network, no writes.
 *
 * Returns the verdict rather than throwing, because every refusal here is one a person has to read —
 * the same contract previewGeneration itself keeps.
 */
export async function previewConcept(input: ConceptInput, opts: PreviewOptions = {}): Promise<GenerationPreview> {
  assertBrandScoped(input.brandId);
  const brief = await assembleBrief(briefInputFor(input));
  return previewGeneration(brief, opts);
}

// ─── Generation ─────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a stored reference into something a provider can read.
 *
 * preview.ts's default is a pass-through, which is right for brand imagery (real https urls) and
 * wrong for a GCS path — and the concept path can carry both (brand cover/gallery images are urls;
 * a supplied product photograph would be an owned path). So the fork is on the ref itself.
 */
async function resolveConceptReference(r: PlannedReference): Promise<ImageRef> {
  if (/^https?:\/\//i.test(r.ref)) return { kind: "url", url: r.ref };
  return { kind: "url", url: await signedUrl(r.ref) };
}

/** Where a job's output lives. Mirrors mediaStore.uploadObjectPath's `athletes/<id>/…` convention. */
export const conceptObjectBase = (athleteId: string, jobId: string, index: number): string =>
  `athletes/${athleteId}/studio/${jobId}/${index}`;

/** Persist one produced asset's pixels. Handles both provider shapes — images come back as inline
 *  bytes, an async video job comes back as a fetchable url — through one return type. */
async function storeAsset(asset: GeneratedAsset, basePath: string) {
  const stored = asset.bytes
    ? await saveBuffer(asset.bytes, basePath, asset.mimeType)
    : asset.url
      ? await rehostFromUrl(asset.url, basePath)
      : null;

  if (!stored) {
    throw new GenerationError("The provider returned an asset with neither bytes nor a url", "provider_error");
  }
  if ("skipped" in stored) {
    throw new GenerationError(`Generated asset is over the media size cap and was not stored`, "provider_error");
  }
  return stored;
}

/**
 * Generate a campaign concept and record it — job row, pixels, asset row, all lineage.
 *
 * The output lands in `draft`. This function NEVER approves anything and never touches the deck:
 * clearance is a human act, and it happens between this call and embedConceptInDeck.
 *
 * Every refusal path leaves the job row telling the truth — a failed generation is `failed` with its
 * error, not a silently missing row, and it is never retried in place (a re-run is a NEW job with
 * its own cost line, which is why there is no retry loop here).
 */
export async function runConceptGeneration(
  input: ConceptInput,
  opts: RunConceptOptions,
): Promise<ConceptGeneration> {
  const preview = await previewConcept(input, opts);

  // The gate, first. runGeneration re-derives it too — this refusal exists so a blocked job never
  // even opens a row, and so the caller gets the blocker list rather than a bare throw.
  if (preview.status === "blocked" || !preview.plan) {
    throw new GenerationError(
      `Refusing to generate a concept — ${preview.blockers.length} blocking gap(s): ` +
        preview.blockers.map((b) => `${b.field}: ${b.note}`).join(" | "),
      "invalid_input",
    );
  }

  // The spend gate. Derived fresh from this preview, never from a number the caller passed in.
  if (preview.unpriced || !preview.cost) {
    throw new GenerationError(
      `Refusing to generate — no price is configured for ${preview.plan.model}, so there is nothing to check ` +
        "the approved ceiling against. An unknown cost must never spend as if it were $0.",
      "invalid_input",
    );
  }
  if (preview.cost.amountUsd > opts.approvedCostUsd) {
    throw new GenerationError(
      `Refusing to generate — this job quotes $${preview.cost.amountUsd.toFixed(4)}, above the approved ` +
        `ceiling of $${opts.approvedCostUsd.toFixed(4)}. Re-approve at the higher figure to proceed.`,
      "invalid_input",
    );
  }

  const job = await createGenerationJob(preview);
  const athleteId = input.athleteId;

  if (!(await claimJob(job.id, athleteId))) {
    throw new GenerationError(`Job ${job.id} could not be claimed — it was not pending`, "invalid_input");
  }

  // The ceiling is this module's concept, not the router's — it does not travel any further.
  const { approvedCostUsd: _ceiling, ...providerOpts } = opts;

  const assets: ConceptGeneration["assets"] = [];
  try {
    const result = await runGeneration(preview.brief, {
      resolveReference: resolveConceptReference,
      ...providerOpts,
      // Reference ids reach the cost log so a spend line can be traced back to what went into it.
      // Paths only — never the signed urls resolveConceptReference mints, whose query string IS the
      // credential (the rule costLog.safeRef exists to keep).
      refIds: providerOpts.refIds ?? preview.references.map((r) => r.ref),
      // The join keys (PR 11): the job this concept opened and the preview it was quoted under.
      attribution: { jobId: job.id, previewId: preview.previewId },
    });

    for (const [i, asset] of result.assets.entries()) {
      const stored = await storeAsset(asset, conceptObjectBase(athleteId, job.id, i));
      const row = await recordGeneratedAsset({
        athleteId,
        jobId: job.id,
        gcsPath: stored.gcs_path,
        contentType: stored.content_type,
        mediaType: asset.mimeType.startsWith("video/") ? "VIDEO" : "IMAGE",
        width: asset.width ?? null,
        height: asset.height ?? null,
        bytes: stored.bytes,
        // The pixels we already hold, so the thumbnail costs no second download. Same reason as
        // the generate path — a concept asset is a generated asset and needs the thumb just as much.
        bytes_buffer: asset.bytes,
        durationSeconds: asset.durationSeconds ?? null,
        // GENERATE mode: there is no frame this came from. Stated, not defaulted.
        derivedFromAssetId: null,
      });
      assets.push({ id: row.id, gcsPath: row.gcs_path, approvalStatus: row.approval_status });
    }

    await succeedJob(job.id, athleteId, result.cost.amountUsd);
  } catch (err) {
    await failJob(job.id, athleteId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  logger.info(
    { jobId: job.id, athleteId, brandId: input.brandId, assets: assets.length, quotedUsd: preview.cost.amountUsd },
    "campaign concept generated — awaiting approval",
  );
  return { jobId: job.id, preview, assets };
}

// ─── The deck boundary ──────────────────────────────────────────────────────────────────────────

/** The shape this module reads out of the deck's cached kit. Structural on purpose: importing the
 *  deck engine's own types would couple this file to a module it is not allowed to change. */
interface CachedKitCard { id: string; type: string; image?: string | null }
interface CachedKit { cards?: CachedKitCard[] }

export interface DeckConceptSlot {
  mediaKitId: string;
  /** The concept card as currently cached, or null when the deck has no concept card at all. */
  card: CachedKitCard | null;
}

/**
 * Read the deck's concept slot. A PURE SELECT, and that is load-bearing.
 *
 * Deliberately NOT kitCache.getOrBuildKit: that function BUILDS on a cache miss, which runs the
 * whole Strategist/Curator/Narrator DAG and spends model money. Reading the deck must never cause
 * the deck to be rebuilt.
 *
 * Returns null when there is no kit row for this (athlete, brand) at all. `card: null` is the other
 * case worth distinguishing: the kit exists but narrateCampaignConcept returned nothing when it was
 * built, so there is no card for an override to attach to.
 */
export async function readDeckConceptSlot(athleteId: string, brandId: number): Promise<DeckConceptSlot | null> {
  const [row] = await db
    .select({ id: mediaKits.id, data: mediaKits.data })
    .from(mediaKits)
    .where(and(
      eq(mediaKits.athlete_id, athleteId),
      eq(mediaKits.brand_id, brandId),
      // The GENERAL pitch per brand. Opportunity-scoped pitches are a different row and a different
      // feature; picking one arbitrarily here would embed into a deck nobody asked about.
      isNull(mediaKits.opportunity_id),
    ))
    .limit(1);

  if (!row) return null;
  const cards = (row.data as CachedKit)?.cards ?? [];
  return { mediaKitId: row.id, card: cards.find((c) => c.id === CONCEPT_CARD_ID) ?? null };
}

export interface EmbedConceptInput {
  /** TENANCY: from `req.athleteId`. Part of every predicate below. */
  athleteId: string;
  brandId: number;
  assetId: string;
  position?: number;
}

export interface EmbedResult {
  assetId: string;
  mediaKitId: string;
  gcsPath: string;
  position: number;
}

function assertBrandScoped(brandId: number): void {
  if (!Number.isInteger(brandId) || brandId <= 0) {
    throw new GenerationError(
      `A campaign concept needs a real brand (got brand_id ${brandId}) — the deck only builds a ` +
        "campaignConcept card for a brand-tailored kit, so brand 0 has no slot to fill",
      "invalid_input",
    );
  }
}

/**
 * Put an APPROVED generated concept into the deck's concept slot.
 *
 * The refusals below are the application half of the guarantee. The other half is in the database
 * (generationGuards.sql §3), and it is the half that matters: it holds against a psql session, a
 * script, and code not written yet. Both exist on purpose — this one so a caller gets a sentence it
 * can render, that one so no caller can get around it.
 */
export async function embedConceptInDeck(input: EmbedConceptInput): Promise<EmbedResult> {
  const { athleteId, brandId, assetId } = input;
  assertBrandScoped(brandId);

  const [asset] = await db
    .select({
      id: mediaAssets.id,
      origin: mediaAssets.origin,
      status: mediaAssets.approval_status,
      deletedAt: mediaAssets.deleted_at,
      gcsPath: mediaAssets.gcs_path,
    })
    .from(mediaAssets)
    // Tenancy is part of the predicate, not a check afterwards: another athlete's asset id resolves
    // to no row rather than to their content.
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);

  if (!asset) {
    throw new GenerationError(`No asset ${assetId} for this athlete`, "invalid_input");
  }
  if (asset.origin !== "generated") {
    throw new GenerationError(
      `Asset ${assetId} has origin "${asset.origin}" — this door places Studio output. Ingested media ` +
        "reaches the deck through the Curator, which casts it from her library.",
      "invalid_input",
    );
  }
  if (asset.deletedAt) {
    throw new GenerationError(`Asset ${assetId} is deleted and cannot be embedded`, "invalid_input");
  }
  if (asset.status !== "approved") {
    throw new GenerationError(
      `Asset ${assetId} is "${asset.status ?? "ungated"}" and has not been approved — a pitch deck goes to ` +
        "a brand, so an unapproved concept in one has already reached the outside",
      "invalid_input",
    );
  }
  if (!asset.gcsPath) {
    throw new GenerationError(`Asset ${assetId} has no stored file to render`, "invalid_input");
  }

  const slot = await readDeckConceptSlot(athleteId, brandId);
  if (!slot) {
    throw new GenerationError(
      `No pitch deck exists for this athlete and brand ${brandId} yet — build the deck before embedding into it`,
      "invalid_input",
    );
  }
  if (!slot.card) {
    // Refuse loudly rather than writing an override for a card that does not exist: applyOverrides
    // only maps over cards the assembler built, so that write would be a silent no-op.
    throw new GenerationError(
      `The deck for brand ${brandId} has no "${CONCEPT_CARD_ID}" card, so there is no slot to fill. ` +
        "The card is only built when the Narrator produced a concept for this brand.",
      "invalid_input",
    );
  }

  const position = input.position ?? 0;

  // ── Write 1: the guarded record. If the asset is not approved, the trigger raises HERE and write
  //    2 never runs. onConflictDoUpdate rather than DoNothing so a re-embed is re-checked by the
  //    trigger (it fires BEFORE INSERT OR UPDATE) instead of being waved through by the unique index.
  await db
    .insert(kitContent)
    .values({ media_kit_id: slot.mediaKitId, asset_id: assetId, position } as never)
    .onConflictDoUpdate({ target: [kitContent.media_kit_id, kitContent.asset_id], set: { position } });

  // ── Write 2: the render mechanism. Read-modify-write, because saveOverrides replaces the whole
  //    jsonb — the athlete's own edits (copy, order, theme, other image swaps) must survive this.
  const existing = await getOverrides(athleteId, brandId);
  await saveOverrides(athleteId, brandId, {
    ...(existing ?? {}),
    images: { ...(existing?.images ?? {}), [CONCEPT_CARD_ID]: asset.gcsPath },
  });

  logger.info(
    { athleteId, brandId, assetId, mediaKitId: slot.mediaKitId, position },
    "approved concept embedded in the deck's concept slot",
  );
  return { assetId, mediaKitId: slot.mediaKitId, gcsPath: asset.gcsPath, position };
}

/**
 * Take an embedded concept back out of the deck. The explicit retraction the §4 guard requires.
 *
 * THE WRITES ARE THE MIRROR OF embedConceptInDeck, AND THE ORDER IS AGAIN THE POINT. Embedding
 * writes the record first (so the trigger can refuse it) and the picture second. Retracting writes
 * the PICTURE first and the record second, so that a failure in between leaves the embed RECORDED
 * but no longer RENDERED — the same fail-safe direction both ways round: a missing picture, never
 * an unapproved one.
 *
 * Removing the kit_content row is not "deleting content to express a decision" — the asset row, its
 * job, its brief and its approval history all stay. What goes away is one placement.
 */
export async function unembedConceptFromDeck(input: EmbedConceptInput): Promise<{ assetId: string; mediaKitId: string } | null> {
  const { athleteId, brandId, assetId } = input;
  assertBrandScoped(brandId);

  const slot = await readDeckConceptSlot(athleteId, brandId);
  if (!slot) return null;

  // Write 1 — stop rendering it. Only clears the override if it is THIS asset's path, so a retraction
  // never wipes a different picture the athlete has since chosen for the slot.
  const [asset] = await db
    .select({ gcsPath: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);

  const existing = await getOverrides(athleteId, brandId);
  if (asset?.gcsPath && existing?.images?.[CONCEPT_CARD_ID] === asset.gcsPath) {
    const images = { ...existing.images };
    delete images[CONCEPT_CARD_ID];
    await saveOverrides(athleteId, brandId, { ...existing, images });
  }

  // Write 2 — remove the placement record. Scoped to this kit and this asset; nothing else moves.
  const removed = await db
    .delete(kitContent)
    .where(and(eq(kitContent.media_kit_id, slot.mediaKitId), eq(kitContent.asset_id, assetId)))
    .returning({ id: kitContent.id });

  if (!removed.length) return null;
  logger.info({ athleteId, brandId, assetId, mediaKitId: slot.mediaKitId }, "concept retracted from the deck slot");
  return { assetId, mediaKitId: slot.mediaKitId };
}

/** Every deck this asset is currently placed in. What a caller must clear before withdrawing
 *  clearance — and what studio/approval.ts reads to explain the §4 refusal in a sentence. */
export async function decksEmbedding(athleteId: string, assetId: string) {
  return db
    .select({ mediaKitId: kitContent.media_kit_id, brandId: mediaKits.brand_id, position: kitContent.position })
    .from(kitContent)
    .innerJoin(mediaKits, eq(mediaKits.id, kitContent.media_kit_id))
    .where(and(eq(kitContent.asset_id, assetId), eq(mediaKits.athlete_id, athleteId)));
}

/** What is currently embedded in one deck, newest position first. Tenancy-scoped via the kit. */
export async function embeddedConceptAssets(athleteId: string, brandId: number) {
  const slot = await readDeckConceptSlot(athleteId, brandId);
  if (!slot) return [];
  return db
    .select({ assetId: kitContent.asset_id, position: kitContent.position, gcsPath: mediaAssets.gcs_path })
    .from(kitContent)
    .innerJoin(mediaAssets, eq(mediaAssets.id, kitContent.asset_id))
    .where(and(eq(kitContent.media_kit_id, slot.mediaKitId), eq(mediaAssets.athlete_id, athleteId)));
}
