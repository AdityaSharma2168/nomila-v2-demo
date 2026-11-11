/**
 * studio.ts — the Studio Content Engine's surface. Compose, check, generate, clear.
 *
 *   POST /api/v1/me/studio/preview                what would run, what it would cost, and whether we
 *                                                 may. Spends nothing. PERSISTS the verdict, because
 *                                                 that row is what later authorizes a spend.
 *   GET  /api/v1/me/studio/content                what this athlete's Studio has actually made
 *   GET  /api/v1/me/studio/deliverables           what she still OWES a brand. OUTSTANDING only —
 *                                                 not a deal-history read; see dealDeliverables.ts
 *   POST /api/v1/me/studio/previews/:id/interpretation/reject
 *                                                 "Not what I meant": she refuses the interpreter's
 *                                                 reading, and that preview can no longer be spent
 *   POST /api/v1/me/studio/generate               THE ONLY DOOR THAT SPENDS. Body: { previewId }.
 *   GET  /api/v1/me/studio/jobs/:jobId            watch one run. Reconnect/refresh only — never the
 *                                                 execution mechanism.
 *   POST /api/v1/me/studio/assets/:id/approve     clearance: draft → approved
 *   POST /api/v1/me/studio/assets/:id/reject      clearance: → rejected, un-embedding first (§11)
 *   POST /api/v1/me/studio/assets/:id/reopen      clearance: rejected → draft
 *
 * ─── WHAT AUTHORIZES A SPEND ───────────────────────────────────────────────────────────────────
 *
 * The generate request carries a previewId and NO COST FIELD. The ceiling is read back off the
 * server's own preview row — the one written when the athlete was shown the figure — so there is
 * nothing in the request to forge. An `approvedCostUsd` or `cost` a client invents is read by
 * nothing. The dangerous forgery was always an INFLATED ceiling (a low one merely refuses the job),
 * and it is now unreachable rather than merely checked. See studio/previewStore.ts.
 *
 * A THIN HANDLER, DELIBERATELY. All the thinking already exists: `assembleBrief` builds the brief,
 * `previewGeneration` renders the verdict, `listStudioContent` does the read. This file validates
 * untrusted input, resolves scope server-side, and calls them. It re-implements none of them.
 *
 * ─── THE TENANCY CONTRACT ──────────────────────────────────────────────────────────────────────
 *
 * The athlete is ALWAYS `req.athleteId`, resolved by requireAuth from the Firebase token. There is
 * no `athleteId` field in any request type on this router — not optional, not ignored-if-present,
 * absent. A client cannot name a subject, so it cannot borrow one.
 *
 * Two client-supplied ids DO exist, and both are re-resolved under the authenticated athlete before
 * they are trusted with anything:
 *
 *   sourceAssetId  re-read from media_assets WITH `athlete_id = req.athleteId`. The ref, width and
 *                  height on the brief come from THAT ROW, never from the body. Without the
 *                  predicate, a client could point an edit at another athlete's photo and read its
 *                  storage path back out of `preview.references`.
 *   brandId        checked for EXISTENCE only, deliberately — see the note on resolveBrand().
 *
 * ─── NOTHING RUNS ──────────────────────────────────────────────────────────────────────────────
 *
 * `previewGeneration` makes no network call and spends nothing; the preview route's only write is
 * the approval record itself. Generation is INLINE — it runs inside the generate request, and the
 * job route exists so a client that navigated away can find out what happened. Nothing polls, so
 * there is no second runner to race across the three Cloud Run instances, and the one shared thing
 * (the approval) is claimed with a single atomic UPDATE. `video.generate` is no longer held: it is
 * QUEUED at the fork in studio/generate.ts and worked by the leased runner in studio/videoRunner.ts.
 */
import { runsBackgroundWork } from "../lib/backgroundHost";
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { db } from "../db";
import { athletes, athletesCurrent, mediaAssets } from "../../shared/schema";
import {
  agentEnabled,
  brandProfilesEnabled,
  styleSpecEnabled,
  studioVideoEnabled,
  interpreterEnabled,
  maxClipSeconds,
  maxDayUsd,
  maxJobUsd,
  nativeEditEnabled,
  refCapacityFor,
  routeFor,
  studioEnabled,
  studioServerRouting,
  libraryFieldsEnabled,
  briefCarrierEnabled,
  imageOpsEnabled,
  outputGateEnabled,
} from "../studio/config";
import {
  CLASSIFY_PURPOSES,
  route as classifyRequest,
  routeAs,
  type ClassifyPurpose,
  type EditPath,
  type Routed,
} from "../studio/classify";
import {
  assembleBrief,
  type BriefDeliverable,
  type BriefInput,
  type BriefObjective,
  type CreativeBrief,
  type JobLastFrame,
  type JobReference,
  type ReferenceRole,
  type SourceAsset,
} from "../studio/brief";
import { intentsAgree, readNativeIntent } from "../studio/nativeEdit";
import {
  attachedIn,
  blockedOnAsk,
  detectionTextFor,
  withNativeEditIntent,
} from "../studio/nativeIntent";
import { describeIntent, type DescribedLine } from "../studio/compile";
import {
  NEW_IMAGE_ASK,
  frozenConstraints,
  provenanceFor,
  type AthleteRegister,
} from "../studio/interpret/core";
import { interpretable } from "../studio/interpret/eligibility";
import {
  interpretForPreview,
  type PreviewAsk,
  type PreviewInterpretation,
} from "../studio/interpret/forPreview";
import type { InterpretationRecord } from "../studio/interpret/interpret";
import { previewGeneration, type GenerationPreview } from "../studio/preview";
import { withPromptTemplate } from "../studio/templates/freeze";
import { gatesFor, gateWire, type GateWire } from "../studio/outputGate";
import { isGateReason, type GateReason } from "../studio/gateVocab";
import {
  mapRegions,
  MAX_LABEL_LEN,
  MAX_REGIONS,
  NATIVE_REGION_MIN_PX,
  type RegionFraction,
} from "../studio/geometry";
import { probeImageSize } from "../studio/imageSize";
import { detectRegionsMemoized, probeBytesFor } from "../studio/autoMask";
import { listStudioContent, MAX_LIMIT, DEFAULT_LIMIT } from "../studio/content";
import { listOutstandingDeliverables } from "../studio/dealDeliverables";
import {
  savePreview,
  loadPreview,
  approvalRefusal,
  rejectInterpretation,
} from "../studio/previewStore";
import {
  runStudioGeneration,
  readJob,
  VIDEO_NOT_ENABLED,
} from "../studio/generate";
import { assetsForJob, spentTodayUsd } from "../studio/jobs";
import {
  assertPlanWithinCaps,
  type PlanItemQuote,
} from "../studio/spendCaps";
import { queueStitch, readStitchJob } from "../studio/stitchJobs";
import { registerPublishRoutes } from "../studio/publish/routes";
import { registerDirectionRoutes } from "../studio/direction/routes";
import { registerCreativeRoutes } from "../studio/creative/routes";
import { registerCampaignGovernanceRoutes } from "./campaignGovernance";
import { resolveCreativeIntentForBrief, type ResolvedCreativeIntent } from "../studio/creative/resolve";
import { creativeIntentsEnabled } from "../studio/config";
import { registerEditRoutes } from "../studio/edit/routes";
import { resolveStyleReference } from "../studio/reference/styleStore";
import { registerClipReadRoutes } from "../studio/enrich/routes";
import { registerQaRoutes } from "../studio/qa/routes";
import { registerIdentityRoutes } from "../studio/identity/routes";
import { isRefusal, isTargetName, parseCaption, parseStitchSpec, STITCH_TARGETS } from "../studio/video/spec";
import { renderCaptionBand } from "../studio/video/captionRender";
import { BED_PREVIEW_TTL_MS, bedCatalog, bedPreviewPath } from "../studio/video/beds";
import { brandSignalsFrom, suggestMusic } from "../studio/music/suggest";
import { captionCatalog } from "../studio/video/captions";
import {
  assertTimelineFits,
  describeLimits,
  MaterializeError,
  resolveTimeline,
  stitchLimits,
  STILL_CONTENT_TYPES,
} from "../studio/video/materialize";
import { herClip, herPhoto } from "../studio/photoPredicate";
import {
  decodeMediaCursor,
  encodeMediaCursor,
  MEDIA_COLUMNS,
  cursorFits,
  mediaAfter,
  mediaOrder,
  mediaOrderFor,
  rankedList,
  MEDIA_SEARCH_LIMIT,
  MEDIA_SEARCH_UNAVAILABLE,
  mediaPredicate,
  parseMediaLimit,
  parseMediaIds,
  parseMediaQuery,
  rankBySimilarity,
  shapeMediaRow,
} from "../studio/mediaList";
import {
  IDENTITY_BOUND_SQL,
  likenessDecision,
  REFERENCE_REFUSAL_COPY,
  unreadRefusal,
  type ReferenceRefusal,
} from "../studio/referenceGate";

/**
 * How long the price check waits to read a photo it would otherwise refuse as unread (PR 19, ADI-R19-BOARD4): one tag
 * and one embed, queued behind any enrichment run already in this process. Past it the door answers as it did.
 */
const READ_NOW_TIMEOUT_MS = Number(process.env.STUDIO_READ_NOW_TIMEOUT_MS ?? 20_000);
import { withTimeout } from "../lib/withTimeout";

import { setApprovalStatus, allowedNext, type ApprovalStatus } from "../studio/approval";
import { decksEmbedding, unembedConceptFromDeck } from "../studio/concept";
import { signedUrl } from "../lib/mediaStore";
import { getBrandContext } from "../services/shotList";
import {
  GenerationError,
  MAX_ADMIT_PIECES,
  SHOT_SLOTS,
  normalizeShotSpec,
  type ShotSpec,
} from "../studio/types";
// Types and one constant only — studio/agent/types.ts imports nothing but studio/types.ts, so this
// static import drags no model, search or storage client into the router (see the dynamic imports
// in POST /studio/agent/plan for the ones that would).
import { MAX_PLAN_PRODUCTS } from "../studio/agent/types";
import { createLogger } from "../logger";
import { buildRevision } from "../studio/buildInfo";

const logger = createLogger("routes/studio");

// Which build answers — once, at startup (studio/buildInfo.ts; PR 4, C1). `grep "studio router
// ready"` on the server log names the revision before any acceptance run believes a result.
logger.info(buildRevision(), "studio router ready");

/** How long her words may take to embed before GET /studio/media/search says it is unavailable. */
const MEDIA_SEARCH_EMBED_TIMEOUT_MS = 10_000;
const router = Router();

// ─── Gates ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The feature flag, enforced server-side. 404 rather than 403: with STUDIO_ENABLED off this surface
 * does not exist, and an unreleased route should not be discoverable by the shape of its refusal.
 *
 * Mirrors the client's STUDIO_ENABLED (client/lib/flags.ts). Those two flags are set independently
 * — the client's is a BUILD-time EXPO_PUBLIC_* var, this one is a RUNTIME env var — so a client
 * built with the flag on can meet a server with it off. That is a 404 the client must render as
 * "unavailable", not as an error. See useStudioContent().
 */
function requireStudio(_req: Request, res: Response, next: NextFunction): void {
  if (!studioEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

/**
 * Belt and braces on the boundary that matters most.
 *
 * requireAuth DOES guarantee an athleteId today — it 401s on a missing/invalid token AND on a valid
 * token whose uid maps to no athletes row (server/lib/auth.ts). But `Request.athleteId` is declared
 * OPTIONAL, so a future re-mount behind a gate that does not guarantee it — requireAdmin, for one,
 * explicitly tolerates a missing athletes row — would compile clean and silently degrade every
 * predicate below into `eq(athlete_id, undefined)`. Two lines make that impossible instead of
 * unlikely, and let every handler below read a plain string rather than a `!`.
 */
function requireAthlete(req: Request, res: Response, next: NextFunction): void {
  if (!req.athleteId) {
    logger.warn({ path: req.path }, "authenticated principal reached studio with no athleteId");
    res.status(403).json({ error: "This account is not an athlete account" });
    return;
  }
  next();
}

const studioGate = [requireStudio, requireAuth, requireAthlete] as const;

// ─── Vocabulary, validated ──────────────────────────────────────────────────────────────────────
//
// The client sends strings. These allowlists are the only way one becomes a typed value — nothing
// is passed through to assembleBrief on the strength of "the client said so".

/** The three arms of the intent picker. Mirrors GenerationTask in studio/types.ts. */
const INTENTS = ["image.generate", "image.edit", "video.generate"] as const;
type StudioIntent = (typeof INTENTS)[number];

const OBJECTIVES: readonly BriefObjective[] = [
  "announce", "showcase-product", "grow-following", "concept", "recap", "thank-partner",
];

const DELIVERABLES: readonly BriefDeliverable[] = ["post", "story", "reel", "carousel", "ad", "clip"];

/**
 * The tags on the reference picker. Same allowlist discipline as every other string on this
 * router: a role becomes a typed value here or it does not become one at all.
 *
 * There is deliberately NO DEFAULT. A reference with no role is a 400, not a `person` — the role
 * decides what the model is told to take from a photo, and picking on her behalf is a decision she
 * never made.
 *
 * A tag, `influence`, was accepted here and is now refused like any other unknown string.
 * A stale client that still sends it gets a 400 rather than a silently reinterpreted reference,
 * which is the right answer: see ReferenceRole in studio/brief.ts for why it went.
 *
 * `object` is the newest member and is NOT a synonym for `product`. Both route to the provider's
 * object slot; they carry different manifest lines, because "the piece this job is about" and "the
 * thing to put in the frame" are different instructions. See ReferenceRole in studio/brief.ts.
 */
const REFERENCE_ROLES: readonly ReferenceRole[] = ["person", "product", "object"];
/**
 * PR 18 (ADI-GO18 G3, the carve-out): `style_reference` joins the allowlist only with STUDIO_STYLE_SPEC on. Off,
 * it is refused exactly as `influence` is, the same 400 at the same line. It is an already-read reference whose
 * READING rides the brief; its image is never planned or sent (studio/preview.ts PLANNED_ROLE).
 */
const referenceRoles = (): readonly ReferenceRole[] =>
  styleSpecEnabled() ? [...REFERENCE_ROLES, "style_reference"] : REFERENCE_ROLES;

/**
 * The TOTAL reference ceiling, read from the same config table the engine plans against so the two
 * cannot disagree about the number in the error message.
 *
 * This is the payload guard and it is checked BEFORE any database read — an unbounded array here
 * would otherwise turn one request into N queries. The per-ROLE caps are the engine's (studio/
 * preview.ts) and surface as readable blocking gaps rather than as a 400, because "you added a
 * fourth photo of yourself" is a thing she can see and fix on the screen she is already looking at.
 */
const maxReferences = (intent: StudioIntent): number => refCapacityFor(routeFor(intent).model).total;

/** Must stay identical to VIDEO_DELIVERABLES in studio/preview.ts — the pair check below depends on it. */
const VIDEO_DELIVERABLES = new Set<BriefDeliverable>(["clip", "reel"]);

/**
 * Clip length. Video bills per SECOND, so an unbounded duration is a spend vector U2 would inherit.
 *
 * ─── THE CEILING IS DERIVED, AND IT USED TO BE A NUMBER NOTHING SERVED ──────────────────
 *
 * This was `const MAX_CLIP_SECONDS = 60`, and 60 is a length no reachable model will make: Veo on
 * Vertex serves 4, 6 and 8 seconds and nothing else. That gap was a live spend hole rather than a
 * cosmetic one — at the with-audio SKU's $0.40/s a 60s clip quotes $24.00, and the per-job cap
 * underneath it was a placeholder 30, so the quote would have passed both money guards.
 *
 * `maxClipSeconds()` reads the list off the model actually behind `video.generate`, so flipping
 * STUDIO_VIDEO_MODEL moves this with it instead of silently refusing clips the new model handles.
 * It is clamped at HARD_MAX_CLIP_SECONDS (60) so no env override can walk it back to the $24 clip.
 *
 * This is the coarse INPUT bound. It is a function, not a constant, because the route it derives
 * from is read at call time — a module-level constant would freeze whichever model happened to be
 * configured when this file was first imported.
 */
const MIN_CLIP_SECONDS = 1;
const maxClip = () => maxClipSeconds();

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/**
 * The single consistency rule between the picker's intent and the format pill.
 *
 * Re-derives the task the way studio/preview.ts's taskFor() will, and demands it equal the declared
 * intent. That catches "image.generate + reel" and "video.generate + post" with one assertion
 * instead of a matrix, and it cannot drift from the engine's own fork:
 *
 *   edit      → image.edit        (a video edit is refused outright — the masked-composite path is
 *                                  image-only, and downgrading it to a re-render is the exact
 *                                  failure the edit/generate fork exists to prevent)
 *   generate  → video.generate when the deliverable is motion, else image.generate
 */
function taskForPair(intent: StudioIntent, deliverable: BriefDeliverable): StudioIntent {
  if (intent === "image.edit") return "image.edit";
  return VIDEO_DELIVERABLES.has(deliverable) ? "video.generate" : "image.generate";
}

// ─── Request ────────────────────────────────────────────────────────────────────────────────────

interface PreviewBody {
  intent: StudioIntent;
  deliverable: BriefDeliverable;
  objective: BriefObjective;
  direction?: string;
  brandId?: number | null;
  sourceAssetId?: string;
  /**
   * The regions to change, as FRACTIONS of the source frame (0..1) — never pixels. See
   * studio/geometry.ts for why the wire is scale-invariant. Only meaningful for an edit.
   */
  regions?: RegionFraction[];
  durationSeconds?: number;
  /** She asked for sound on this clip. Strictly `true`; anything else is off. */
  audio?: true;
  /**
   * The structured shot slots (studio/types.ts `ShotSpec`). Names and values from closed sets;
   * anything else is a 400. Absent ⇒ every existing caller is byte-identical.
   */
  shot?: ShotSpec;
  /**
   * The tagged references this job is built from. ASSET IDS ONLY — never paths. Each one is
   * re-read under the authenticated athlete before anything about it is trusted (resolveReferences).
   */
  references?: { assetId: string; role: ReferenceRole; label?: string }[];
  /**
   * The frame a CLIP must arrive at — `GenerationInputs.lastFrame`, as an ASSET ID.
   *
   * ⚠️ AN ID, NEVER A PATH, for the reason `references` states: what leaves this route carries a
   * `ref` that came out of the ROW. A client naming a storage path could point a generation at
   * another athlete's photograph. Resolved through `readOwnedImage` — same predicate, same 404.
   *
   * ⚠️ VIDEO ONLY, AND THE ROUTE DOES NOT ENFORCE THAT — `plannedInputs` does, behind its `isVideo`
   * guard. A second rule here would be the same rule twice, and the two would eventually disagree.
   *
   * Absent ⇒ every existing caller is byte-identical.
   */
  lastFrameAssetId?: string;
  /**
   * The stored plan this clip belongs to (PR 14, behind STUDIO_BRIEF_CARRIER) — an ID, never a brief.
   * The route reads the row under HER athlete id (`readPlan`, the music-suggest precedent) and freezes
   * the carrier onto the brief; a plan that is not hers is a 404 before anything is called. A posted
   * `campaign` object is an unknown field, always: nothing on a brief comes from a request body.
   */
  planId?: string;
  /**
   * quality-scrappy piece 5: the reasons a previous output of hers failed the gate, as CODES from gateVocab's closed
   * set — never text. Compiled into the prompt as that target's fix (studio/gateVocab.ts). Honoured only under
   * STUDIO_OUTPUT_GATE; off, it is parsed for shape and dropped, and the brief is what it was.
   */
  corrective?: GateReason[];
}

type BadRequest = { error: string; field: string };

function parsePreviewBody(raw: unknown): PreviewBody | BadRequest {
  const b = (raw ?? {}) as Record<string, unknown>;

  // ⚠️ A CAMPAIGN IS NEVER POSTED HERE (PR 14). The carrier is built from the plan ROW the route reads
  // under her athlete id; an object in the body would be a client writing the brief a generation runs
  // on. ⚠️ MUTATION (studio.generate.test): drop this — "a client-posted campaign object is accepted" reds.
  if (b.campaign !== undefined) return { error: "unknown field", field: "campaign" };
  if (b.planId !== undefined && (typeof b.planId !== "string" || !UUID_RE.test(b.planId))) {
    return { error: "planId must be a plan id", field: "planId" };
  }

  const intent = oneOf(INTENTS, b.intent);
  if (!intent) return { error: `intent must be one of: ${INTENTS.join(", ")}`, field: "intent" };

  const deliverable = oneOf(DELIVERABLES, b.deliverable);
  if (!deliverable) return { error: `deliverable must be one of: ${DELIVERABLES.join(", ")}`, field: "deliverable" };

  const objective = oneOf(OBJECTIVES, b.objective);
  if (!objective) return { error: `objective must be one of: ${OBJECTIVES.join(", ")}`, field: "objective" };

  if (taskForPair(intent, deliverable) !== intent) {
    return {
      error: `a "${deliverable}" cannot be made by ${intent} — ${
        VIDEO_DELIVERABLES.has(deliverable) ? "motion needs video.generate" : "a still needs image.generate"
      }`,
      field: "deliverable",
    };
  }

  // mode is DERIVED from intent, never sent. Two fields that can disagree eventually will.
  if (intent === "image.edit" && typeof b.sourceAssetId !== "string") {
    return { error: "editing needs the photo you want to edit", field: "sourceAssetId" };
  }
  if (intent !== "image.edit" && b.sourceAssetId !== undefined) {
    return { error: "only an edit carries a source photo", field: "sourceAssetId" };
  }

  // Regions are SHAPE-checked here and VALUE-checked in resolveSource, once the frame they have to
  // fit inside is known. Splitting it that way keeps the only place that turns fractions into
  // pixels the same place that authorized the photo they are measured against.
  if (intent !== "image.edit" && b.regions !== undefined) {
    return { error: "only an edit carries regions", field: "regions" };
  }
  let regions: RegionFraction[] | undefined;
  if (b.regions !== undefined) {
    if (!Array.isArray(b.regions)) {
      return { error: "regions must be a list of boxes", field: "regions" };
    }
    if (b.regions.length > MAX_REGIONS) {
      return { error: `Up to ${MAX_REGIONS} regions per edit.`, field: "regions" };
    }
    for (const r of b.regions) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return { error: "each region must be a box", field: "regions" };
      }
    }
    regions = b.regions as RegionFraction[];
  }

  if (b.direction !== undefined && typeof b.direction !== "string") {
    return { error: "direction must be text", field: "direction" };
  }
  if (b.brandId !== undefined && b.brandId !== null && !Number.isInteger(b.brandId)) {
    return { error: "brandId must be an integer", field: "brandId" };
  }

  // References. Shape and vocabulary here; ownership in resolveReferences, which is the only place
  // an id becomes a path. Both halves are required — this one cannot check whose asset it is, and
  // that one should not be reached by a body that is not even the right shape.
  let references: PreviewBody["references"];
  if (b.references !== undefined) {
    if (!Array.isArray(b.references)) {
      return { error: "references must be a list of photos", field: "references" };
    }
    const cap = maxReferences(intent);
    if (b.references.length > cap) {
      return { error: `Up to ${cap} references on one image.`, field: "references" };
    }
    const parsedRefs: NonNullable<PreviewBody["references"]> = [];
    const seen = new Set<string>();
    for (const raw of b.references) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: "each reference must be a photo and a tag", field: "references" };
      }
      const r = raw as Record<string, unknown>;
      if (typeof r.assetId !== "string" || !UUID_RE.test(r.assetId)) {
        return { error: "each reference needs the photo it refers to", field: "references" };
      }
      // The same photo twice would bill twice for one input and confuse the manifest's numbering.
      if (seen.has(r.assetId)) {
        return { error: "That photo is already on this list.", field: "references" };
      }
      seen.add(r.assetId);
      const role = oneOf(referenceRoles(), r.role);
      if (!role) {
        return { error: "Say what each photo is for.", field: "references" };
      }
      if (r.label !== undefined && typeof r.label !== "string") {
        return { error: "a reference label must be text", field: "references" };
      }
      const label = typeof r.label === "string" ? r.label.trim() : "";
      // Capped because it rides into the prompt verbatim, exactly like a mask region's label.
      if (label.length > MAX_LABEL_LEN) {
        return { error: `Keep each label under ${MAX_LABEL_LEN} characters.`, field: "references" };
      }
      parsedRefs.push({ assetId: r.assetId, role, ...(label ? { label } : {}) });
    }
    references = parsedRefs;
  }

  let durationSeconds: number | undefined;
  if (b.durationSeconds !== undefined) {
    const n = Number(b.durationSeconds);
    if (!Number.isFinite(n) || n < MIN_CLIP_SECONDS || n > maxClip()) {
      return { error: `durationSeconds must be between ${MIN_CLIP_SECONDS} and ${maxClip()}`, field: "durationSeconds" };
    }
    durationSeconds = Math.round(n);
  }

  // STRICTLY a boolean. "true", 1 and "on" are a client bug, and guessing at one here would turn a
  // typo into a doubled price.
  if (b.audio !== undefined && typeof b.audio !== "boolean") {
    return { error: "audio must be true or false", field: "audio" };
  }

  // quality-scrappy piece 5: CODES from a closed set, or a 400 — a corrective is never text a client wrote.
  let corrective: GateReason[] | undefined;
  if (b.corrective !== undefined) {
    if (!Array.isArray(b.corrective) || b.corrective.length > 8 || !b.corrective.every(isGateReason)) {
      return { error: "corrective must be a list of the gate's reason codes", field: "corrective" };
    }
    corrective = [...new Set(b.corrective as GateReason[])];
  }

  // ─── THE SHOT SLOTS — CLOSED SETS, AND AN UNKNOWN VALUE IS A 400 ─────────────────────────────
  //
  // ⚠️ NOT A PASS-THROUGH AND NOT A SILENT DROP. This return literal is an allow-list: a key it does
  // not name vanishes with a 200, which is exactly how `kind` died on its way to the brief. And a
  // VALUE it does not know must not be dropped either — she would tap a chip, be quoted, and get a
  // clip that ignored it. So every slot is checked against the vocabulary in studio/types.ts, and
  // an unknown slot NAME is refused too: a client newer than this server is a 400, not a shrug.
  let shot: ShotSpec | undefined;
  if (b.shot !== undefined && b.shot !== null) {
    if (typeof b.shot !== "object" || Array.isArray(b.shot))
      return { error: "shot must be an object of shot slots", field: "shot" };
    const given = b.shot as Record<string, unknown>;
    const parsedShot: Record<string, string> = {};
    for (const [slot, value] of Object.entries(given)) {
      if (value === undefined || value === null) continue;
      const allowed = (SHOT_SLOTS as Record<string, readonly string[]>)[slot];
      if (!allowed)
        return { error: `shot.${slot} is not a shot slot`, field: `shot.${slot}` };
      const v = oneOf(allowed, value);
      if (v === null)
        return { error: `shot.${slot} must be one of: ${allowed.join(", ")}`, field: `shot.${slot}` };
      parsedShot[slot] = v;
    }
    shot = normalizeShotSpec(parsedShot as ShotSpec);
  }

  return {
    intent,
    deliverable,
    objective,
    shot,
    direction: typeof b.direction === "string" ? b.direction : undefined,
    brandId: typeof b.brandId === "number" ? b.brandId : null,
    sourceAssetId: typeof b.sourceAssetId === "string" ? b.sourceAssetId : undefined,
    regions,
    durationSeconds,
    ...(b.audio === true ? { audio: true as const } : {}),
    references,
    // Shape only, exactly like sourceAssetId. OWNERSHIP is decided in the handler.
    ...(typeof b.planId === "string" ? { planId: b.planId.toLowerCase() } : {}),
    lastFrameAssetId:
      typeof b.lastFrameAssetId === "string" ? b.lastFrameAssetId : undefined,
    ...(corrective?.length ? { corrective } : {}),
  };
}

// ─── Resolving the two client-supplied ids ──────────────────────────────────────────────────────

/**
 * The source frame for an edit, re-read under the authenticated athlete, with the marked regions
 * mapped into its ORIGINAL pixel space.
 *
 * Everything on the returned SourceAsset comes from the ROW or from the object's own BYTES, never
 * from the request. `ref` is the stored GCS PATH and never a signed url — a signed url's query
 * string is the credential, and this object is logged and frozen into generation_jobs.brief (see
 * the SourceAsset docs in studio/brief.ts).
 *
 * THIS IS THE ONLY PLACE FRACTIONS BECOME PIXELS, and it is here rather than anywhere else because
 * this function already owns "re-read this asset under the authenticated athlete". The geometry is
 * therefore always checked against a frame the caller has been authorized for, and the pixels that
 * reach assembleBrief — and get frozen into the preview row, and replayed by /studio/generate —
 * were computed by the server, every time. There is no second path and no client-supplied pixel.
 *
 * THE DIMENSIONS COME FROM THE BYTES, NOT THE ROW. `media_assets.width/height` cannot be trusted:
 * skills/rehostAthleteMedia.ts never writes them (so they are NULL for every ingested photo), and
 * routes/media.ts stores whatever an uploading client asserted. probeImageSize reads the real ones
 * out of the object's header. If it cannot, the edit is REFUSED — never clamped, never guessed,
 * never quietly fallen back to the row — because an unbounded region is exactly the loose mask the
 * spike warned moves features that should not move.
 */
type SourceRefusal = { error: string; field: string };

/**
 * ONE image, under the authenticated athlete. The single predicate both the source frame and every
 * tagged reference are read through.
 *
 * It is one function rather than two identical queries on purpose: the predicate below IS the
 * tenancy boundary for this router's asset handling, and two copies of it is one copy that later
 * loses a clause. `athlete_id` is the whole ballgame; `status`/`deleted_at` keep a half-uploaded or
 * removed object from being generated against.
 *
 * Returns null for BOTH "no such asset" and "not yours", so the caller answers one 404 and a probe
 * cannot learn that another athlete's id exists.
 *
 * It selects only what both callers need. It briefly also returned `metadata`, to read the upload's
 * existing vision tags for the look-reference people warning; that warning went with the look
 * reference itself, so the column went with it rather than being left selected for nobody.
 */
async function readOwnedImage(athleteId: string, assetId: string) {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      // PR 12: back, for the reference gate (studio/referenceGate.ts) — the tagger's answer on the row
      // decides whether it may be a person or product reference. Read here, never returned to a client.
      metadata: mediaAssets.metadata,
      // Ruling 24 Sep: the row's provenance, and its job's identity_bound, for the gate's rule 3.
      origin: mediaAssets.origin,
      identityBound: sql<boolean | null>`(${sql.raw(IDENTITY_BOUND_SQL)})`,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.id, assetId),
        eq(mediaAssets.athlete_id, athleteId), // ← the whole ballgame
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .limit(1);
  return row?.gcs_path ? row : null;
}

/**
 * The tagged references, re-resolved under the authenticated athlete.
 *
 * TENANCY — this is the function the whole reference feature's tenancy rests on. What arrives is an
 * ASSET ID and a role. What leaves carries a `ref` that came out of the ROW, never out of the
 * request, so a client cannot name a storage path and cannot point a generation at another
 * athlete's photo. The id is re-read through `readOwnedImage`, the same predicate the source frame
 * uses, and a miss is the same 404 as a nonexistent id.
 *
 * Reads are sequential rather than parallel because the count is already bounded to a handful by
 * parsePreviewBody, and stopping at the first miss means a probe with a long list of guessed ids
 * costs one query, not N.
 */
async function resolveReferences(
  athleteId: string,
  refs: NonNullable<PreviewBody["references"]>,
): Promise<JobReference[] | null | { refusal: ReferenceRefusal }> {
  const out: JobReference[] = [];
  for (const r of refs) {
    const row = await readOwnedImage(athleteId, r.assetId);
    if (!row) return null;   // not found and not yours are one answer
    // PR 18 (ADI-GO18 G3): a style reference is her image's newest style READING, read under her id. Unread, it
    // is refused (R-8, G8): the picker lists only read ones, and this is the invariant under that convenience.
    // The reason is this door's existing "still reading" code, so the handler is untouched (ADI-GO18 G3: the carve-out,
    // no handler logic; G8: the refusal is the invariant at this door, since the picker lists read references only).
    if (r.role === "style_reference") {
      const style = await resolveStyleReference(athleteId, row.id, row);
      if (!style.ok)
        return style.reason === "style_unread" ? { refusal: "reference_unread" } : null;
      out.push(style.reference);
      continue;
    }
    // PR 12 (R-5, STUDIO_LIBRARY_FIELDS): the casting law at this door. An unread photo is not a
    // person or product reference; a no-face photo is not a likeness. Tenancy is settled above — the
    // row is hers — so the refusal can say why without telling a prober anything. ⚠️ MUTATIONS
    // (routes/studio.test): skip this — "an unclassified image reaches a generation call" and "a
    // no-face photo is accepted as a person likeness ref" red by name.
    if (libraryFieldsEnabled()) {
      // PR 19 (ADI-R19-FACE): with STUDIO_IMAGE_OPS on, face visibility never rejects — a real photo of her with an
      // unclear face is used for what she asked. (Since ADI-R19-BOARD3 made-here doesn't either; an unread photo is read here.)
      // ⚠️ MUTATION M-face: pass faceRejects true again — "a real photo of her with an unclear face is never refused" reds.
      // PR 19 (ADI-R19-BOARD3): what she chose runs as she set it — "Made here · not from you" is a label, never a refusal
      // here. ⚠️ MUTATION M-madeHere: pass madeHereRefuses true again — "a made-here still she chose runs" reds by name.
      // PR 19 (ADI-R19-BOARD4): a refusal never changes her shot — fix the cause. A photo not read YET is read HERE, by
      // the enrichment cron's own unit of work (services/mediaEnrichment.ts `enrichOnePhoto`: same fields, same door,
      // skipped once done) — the read the cron would have made, made now, never a second one. A read that fails or runs
      // past READ_NOW_TIMEOUT_MS leaves the row as it was, and the door answers as before. A row the cron has SET DOWN
      // (oversize, attempts) is never retried here. ⚠️ MUTATION M-readNow: skip the read — "an unread photo of hers is
      // read on the spot, then prices and runs" reds by name.
      let metadata = row.metadata;
      if (unreadRefusal(metadata) === "reference_unread" && (r.role === "person" || r.role === "product")) {
        const { enrichOnePhoto } = await import("../services/mediaEnrichment.js");
        const fresh = await withTimeout(
          enrichOnePhoto({ athleteId, assetId: row.id }),
          READ_NOW_TIMEOUT_MS,
          "reference read",
        ).catch(() => null);
        if (fresh) metadata = fresh;
      }
      const refusal = likenessDecision(
        metadata,
        r.role,
        { origin: row.origin, identityBound: row.identityBound },
        { faceRejects: !imageOpsEnabled(), madeHereRefuses: false },
      );
      if (refusal) return { refusal };
    }
    out.push({
      role: r.role,
      ref: row.gcs_path!,    // FROM THE ROW. Never from the body.
      mediaAssetId: row.id,
      ...(r.label ? { label: r.label } : {}),
    });
  }
  return out;
}

async function resolveSource(
  athleteId: string,
  assetId: string,
  regions: RegionFraction[] | undefined,
  /**
   * Her instruction, when there is one and she drew no box. Present ⇒ this is the Create-anything
   * path and the region is derived from her sentence rather than her finger.
   */
  instruction?: string,
  /**
   * Measure the frame even with no regions — an add (PR C′), which has none by design and still
   * needs the frame's dimensions for its ratio and its size. Everything else keeps the old rule.
   */
  opts: { measureWithoutRegions?: boolean } = {},
): Promise<{ source: SourceAsset; looseNote: string | null; derived: RegionFraction[] | null } | SourceRefusal | null> {
  const row = await readOwnedImage(athleteId, assetId);

  // null (not a refusal) so the caller answers 404 — the same answer a nonexistent id gets, so a
  // probe cannot learn that somebody else's asset exists.
  if (!row) return null;

  // ─── AUTO-MASK: her sentence becomes the region, when she drew nothing ─────────────────────
  //
  // Only when she drew NOTHING. A box she marked herself is a statement about which pixels she
  // means, and asking a model to second-guess it would be the one place in this path where her own
  // input is not authoritative.
  //
  // ⚠️ THIS SPENDS, AND IT IS THE FIRST THING ON THE PREVIEW PATH THAT DOES. It sits here, in the
  // ROUTE, and not inside previewGeneration — whose contract is "no network, no spend, no writes"
  // and on which studio/generate.ts's whole re-derivation argument rests. It is memoized on
  // (athlete, photo, instruction) so that re-checking a brief stays free, which is the property
  // useGenerationPlan depends on when it re-runs the check on every fingerprint change.
  let effective = regions;
  let derived: RegionFraction[] | null = null;
  if (!effective?.length && instruction?.trim()) {
    const found = await detectRegionsMemoized(
      { athleteId, sourceAssetId: row.id, instruction },
      async () => {
        const probe = await probeBytesFor(row.gcs_path!);
        return probe ? { frameBytes: probe.bytes, mimeType: probe.mimeType, instruction } : null;
      },
    );
    if (!found.ok) {
      // A refusal she can read, and a nudge toward the manual editor, which still works and is
      // strictly more control than a guess. Not a blocked preview: nothing is written, so there is
      // no row that could later authorize a spend against a mask we never found.
      return { error: found.message, field: "regions" };
    }
    effective = found.regions;
    derived = found.regions;
  }

  // No regions and nothing to derive them from: hand back the frame with an empty mask and let
  // assembleBrief raise its own blocking gap. She has picked a photo and not yet said what to change,
  // which is a step she has not taken rather than an error — and measuring the frame for a check she
  // cannot pass wastes a read.
  if (!effective?.length && !opts.measureWithoutRegions) {
    return {
      source: { mediaAssetId: row.id, ref: row.gcs_path!, width: null, height: null, editRegions: [] },
      looseNote: null,
      derived: null,
    };
  }

  const frame = await probeImageSize(row.gcs_path!);
  if (!frame) {
    // Deliberately says nothing about the storage path. She gets a fact about her photo, not ours.
    return {
      error:
        "We couldn't read this photo's dimensions, so we can't place an edit on it accurately. " +
        "Try another photo, or re-upload this one.",
      field: "sourceAssetId",
    };
  }

  // An add: measured, and deliberately no regions. assembleBrief still raises its "no edit regions"
  // gap, and only the add's own frozen intent answers it (studio/preview.ts, waivedByIntent).
  if (!effective?.length) {
    return {
      derived: null,
      source: {
        mediaAssetId: row.id,
        ref: row.gcs_path!,
        width: frame.width,
        height: frame.height,
        orientation: frame.orientation,
        editRegions: [],
      },
      looseNote: null,
    };
  }

  // ─── THE PIXEL FLOOR IS A MASKED-PATH RULE (guard scope, G.2) ──────────────────────────────────
  //
  // A region detected from her sentence, with STUDIO_NATIVE_EDIT on, freezes native or blocks —
  // withNativeEditIntent's own condition, `nativeEditEnabled() && regions === "derived"`, and it never
  // falls back to masked. The native call sends no region, so MIN_REGION_PX was refusing "change my
  // earrings…" as too small for a crop that job never makes. Such a region keeps a one-pixel floor; a
  // box she drew, and anything with the flag off, keep the masked floor (studio/geometry.ts).
  const mapped = mapRegions(
    effective,
    frame,
    derived && nativeEditEnabled() ? { minRegionPx: NATIVE_REGION_MIN_PX } : {},
  );
  if ("message" in mapped) return { error: mapped.message, field: mapped.field };

  return {
    derived,
    source: {
      mediaAssetId: row.id,
      ref: row.gcs_path!,
      // The MEASURED dimensions, not the row's. Frozen into the brief alongside the regions, so the
      // exact geometry basis that produced a job stays recoverable after the fact.
      width: frame.width,
      height: frame.height,
      // Frozen for the same reason, and used: studio/generate.ts reads it to decide whether the
      // pixels have to be normalized before the provider sees them (see studio/orient.ts).
      orientation: frame.orientation,
      editRegions: mapped.regions,
    },
    looseNote: mapped.looseNote,
  };
}

/**
 * HER SPORT — read only when an ad has no brand row to draw a setting from (card 3, A).
 *
 * TENANCY: keyed on `athleteId`, which is `req.athleteId!`. `athletes.sport` is her own row. Nothing here can return
 * another athlete's field. The legacy `athletes_current.tier` "level" is no longer read (legacy retirement P2-2, owner
 * decision 6, 8 Oct 2026).
 *
 * Everything this returns is sanitised downstream (`resolveRegister`), and her SPORT is dropped there
 * when her own sentence names one.
 */
async function athleteRegisterFor(athleteId: string): Promise<AthleteRegister | null> {
  const [row] = await db
    .select({ sport: athletes.sport })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return null;
  return row.sport === null ? null : { sport: row.sport };
}

/**
 * Has her profile been put together yet (does she have an `athletes_current` row — research has run)?
 *
 * History: `getAthleteContext` used to THROW without that row, and this check turned the 500 into an answer she can
 * read. Since the legacy retirement (P2-3) the context tolerates a missing row, so this is no longer a crash guard;
 * it stays as the product rule it became — Studio waits for her first research pass rather than generating from an
 * empty profile. It reads only the row's existence (no legacy score column).
 */
async function hasBeenScored(athleteId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: athletesCurrent.athlete_id })
    .from(athletesCurrent)
    .where(eq(athletesCurrent.athlete_id, athleteId))
    .limit(1);
  return !!row;
}

/**
 * The brand. EXISTENCE ONLY — not "is this one of her brands", and that is a considered decision.
 *
 * `getBrandContext` and `readBrandExtras` read a single `inbox_brands` row, which has no athlete_id
 * and is documented in shared/schema.ts as "a general brand-identity table (not inbox-scoped)".
 * Everything they return is brand-public research — name, logo, category, tier, audience summary,
 * sport categories, publicly-known partnerships, enrichment. No deal terms, no notes, nothing
 * belonging to another athlete.
 *
 * So restricting this to brands she already has a relationship with would buy zero tenancy safety
 * and would break spec-pitch — the product's "pitch any brand" flow, which is exactly the case
 * Studio should serve. If this function is ever changed to return anything athlete-scoped, the
 * restriction has to come back with it.
 */
async function resolveBrand(brandId: number): Promise<boolean> {
  return (await getBrandContext(brandId)) !== null;
}

// ─── Blocked-because-we-cannot vs blocked-because-your-material-has-a-gap ───────────────────────

/** The engine's field name for "this edit has no mask". */
const NO_MASK_FIELD = "job.source.editRegions";

/**
 * The loose-mask warning, folded onto the preview she is about to read AND onto the row that is
 * about to be frozen.
 *
 * It rides `warnings` — the array PreviewPanel already renders — rather than becoming a new field,
 * so no client contract changes. `degraded`, never `blocking`: a large region is a judgement call
 * she is allowed to make, and U3 blocks nothing on it. Folded in here rather than inside
 * previewGeneration because the geometry that produced it lives in the route's mapping step, and
 * studio/preview.ts is the engine.
 */
function withLooseMaskNote(preview: GenerationPreview, note: string | null): GenerationPreview {
  if (!note) return preview;
  return {
    ...preview,
    warnings: [...preview.warnings, { field: NO_MASK_FIELD, note, severity: "degraded" }],
  };
}

/**
 * Two blocked states look identical in the data and could not feel more different to a person.
 *
 *   "the charm you named has no reference photo"  → HER gap. She can fix it. Show it as a blocker.
 *   "no edit regions measured"                    → OUR gap. U1 ships no mask UI, so every edit is
 *                                                   blocked on it. She cannot fix that, and telling
 *                                                   her the campaign has a problem is a lie.
 *
 * The engine note is right and stays right — it is what the log and U2's mask UI need. This
 * translates it for the surface, and hoists an explicit `unavailable` so the client can render a
 * neutral "not ready yet" state instead of a red refusal.
 */
export interface PreviewResponse extends GenerationPreview {
  /** Set when the block is a capability WE are missing, not a gap in her material. */
  unavailable: { reason: string } | null;
}

/**
 * The card an interpreted preview carries — "Here's what we'll do" (the interpreter, I.5; v1 §1). The lines
 * are the FROZEN intent's, each tagged by where it came from (compile/describe.ts): what she reads is what
 * compiles. Only on a preview the interpreter proposed; absent on every other.
 */
export interface InterpretationCard {
  lines: DescribedLine[];
}

/**
 * U3 CHANGED WHOSE GAP THIS IS.
 *
 * Until now "no edit regions measured" meant WE could not do it — nothing in the app could produce
 * a region, so every edit blocked on a capability she could not supply, and telling her the brief
 * had a problem would have been a lie. That is why this used to hoist `unavailable` and overwrite
 * the note with "photo editing isn't available yet".
 *
 * The mask editor now produces regions, so an empty mask means she has not drawn one yet — a step
 * she can take, on a screen that is asking her to take it. It reads as a normal blocker with an
 * instruction, and `unavailable` goes back to meaning only what its name says.
 *
 * The engine note stays right for the log; this is still the surface's wording. The `unavailable`
 * FIELD is deliberately kept on the response shape — the client already reads it and a stale build
 * must not start seeing `undefined`.
 */
const NEEDS_A_REGION =
  "Mark the part of the photo you want changed — drag a box around it, and say what should change " +
  "there. Everything outside your box stays exactly as it is.";

/**
 * ─── ⚠️  A PREVIEW MUST NOT PRICE SOMETHING THAT STRUCTURALLY CANNOT RUN ───────────────────────
 *
 * `assertVideoEnabled` lived in `runStudioGeneration` alone, so with STUDIO_VIDEO_ENABLED off a clip
 * previewed clean: ready, quoted, button enabled — and refused the instant she approved. A two-shot
 * storyboard said $1.60 and told her it was ready, and only the press found the wall.
 *
 * That is the preview lying by omission. Its whole job is "can this run, and what will it cost", and
 * a figure for a job that cannot run answers the second while silently failing the first.
 *
 * ⚠️ IT IS `unavailable` — that field's own header: "set when the block is a capability WE are
 * missing, not a gap in her material". She cannot fix this one, and a red refusal about her brief
 * would be the lie the field was invented to stop.
 *
 * ⚠️ AND THE COST IS DROPPED. A ceiling beside "not available" is a number for a job that will not
 * happen, and the storyboard sums whatever it is handed. `unpriced` rather than zero: $0.00 reads as
 * free.
 *
 * Additive: with the flag ON this returns the preview untouched.
 */
function withVideoAvailability(preview: PreviewResponse): PreviewResponse {
  const isVideo = preview.plan?.task === "video.generate";
  if (!isVideo || studioVideoEnabled()) return preview;
  return {
    ...preview,
    status: "blocked",
    plan: null,
    cost: null,
    unpriced: true,
    verdict: {
      canGenerate: false,
      headline: "Not available yet",
      reason: VIDEO_NOT_ENABLED,
    },
    unavailable: { reason: VIDEO_NOT_ENABLED },
  };
}

function humanize(preview: GenerationPreview): PreviewResponse {
  const hasNoMask = preview.blockers.some((b) => b.field === NO_MASK_FIELD);
  if (!hasNoMask)
    return withVideoAvailability({ ...preview, unavailable: null });

  return withVideoAvailability({
    ...preview,
    blockers: preview.blockers.map((b) =>
      b.field === NO_MASK_FIELD ? { ...b, note: NEEDS_A_REGION } : b,
    ),
    verdict: {
      ...preview.verdict,
      headline: "Mark what to change",
      reason: NEEDS_A_REGION,
    },
    unavailable: null,
  });
}

// ─── U2 helpers: ids, results, and refusals a person can read ───────────────────────────────────

/** Path ids are validated before they reach a query — a non-uuid is a 404, never a cast error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One produced asset, ready to render. Urls are signed at serve (~1h) and never persisted. */
interface ResultAsset {
  assetId: string;
  mediaType: string;
  url: string | null;
  approvalStatus: string | null;
  /** What she may legally do to it right now, so the UI renders only real buttons. */
  allowedNext: ApprovalStatus[];
  /**
   * quality-scrappy piece 5 (STUDIO_OUTPUT_GATE, opt-in): still being checked, or failed with its reasons and the codes
   * a re-quote sends back. ABSENT when the output passed, and always absent with the flag off — the wire it was.
   */
  gate?: GateWire;
}

/**
 * The output gate on a job's shaped assets (studio/outputGate.ts) — the assets untouched with STUDIO_OUTPUT_GATE off.
 * `completedAt` bounds "still being checked": past GATE_PENDING_MS a missing record reads as nothing to say.
 */
async function withGates(
  assets: ResultAsset[],
  athleteId: string,
  completedAt: Date | null,
): Promise<ResultAsset[]> {
  if (!outputGateEnabled() || !assets.length) return assets;
  const gates = await gatesFor(athleteId, assets.map((a) => a.assetId));
  return assets.map((a) => {
    const gate = gateWire(gates.get(a.assetId) ?? null, completedAt);
    return gate ? { ...a, gate } : a;
  });
}

async function shapeAssets(rows: { id: string; media_type: string; gcs_path: string | null; approval_status: string | null }[]): Promise<ResultAsset[]> {
  return Promise.all(rows.map(async (r) => ({
    assetId: r.id,
    mediaType: r.media_type,
    url: r.gcs_path ? await signedUrl(r.gcs_path) : null,
    approvalStatus: r.approval_status,
    allowedNext: allowedNext(r.approval_status as ApprovalStatus | null),
  })));
}

/** Does this asset belong to this athlete? Lets a clearance route answer 404 before 409. */
async function ownsAsset(athleteId: string, assetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);
  return !!row;
}

/**
 * The embed refusal, recognised from either of its two sources.
 *
 * studio/approval.ts refuses in the application with a readable sentence; generationGuards.sql §4
 * refuses in the database with `check_violation` and a message naming the asset uuid. Both are
 * correct, and NEITHER may be shown to an athlete: one hands her a chore ("remove it from the deck
 * first") that the reject route has already done for her, and the other shows her our schema.
 *
 * Reaching this after the un-embed loop means a deck acquired the asset in between — a real race,
 * rare, and recoverable by re-reading. That is what she is told.
 */
const EMBED_RACE =
  "That was put back into a pitch deck while we were taking it out. Open it again and retry — " +
  "nothing has changed.";

function isEmbedRefusal(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /embedded in .* pitch deck|is embedded in a pitch deck|remove it from the deck/i.test(m);
}

/**
 * Answer a clearance failure without ever forwarding a database string.
 *
 * A GenerationError from studio/approval.ts is already a sentence written for a person (it names
 * both states and the legal moves), so it passes through. Anything else — a raw pg error, a trigger
 * refusal, a bug — is logged in full and answered generically: the athlete gets no stack, no uuid
 * and no constraint name.
 */
function respondClearanceError(res: Response, err: unknown, verb: string, ctx: Record<string, unknown>): void {
  if (isEmbedRefusal(err)) {
    logger.warn({ ...ctx, err }, "clearance blocked by a live embed");
    res.status(409).json({ error: EMBED_RACE });
    return;
  }
  if (err instanceof GenerationError) {
    res.status(409).json({ error: err.message });
    return;
  }
  logger.error({ ...ctx, err }, `studio ${verb} failed`);
  res.status(500).json({ error: `Couldn't ${verb} that right now.` });
}

// ─── The interpreter's record, on the row (the interpreter, I.5) ───────────────────────────────────

/**
 * The interpreter's record onto the brief the preview row stores (`BriefJob.interpretation`) — display and
 * record only. When it proposed and C froze, the card's lines ride with it, rendered from the FROZEN intent
 * (compile/describe.ts) and tagged by the edit or constraint that made each one, so what she reads is what
 * compiles. When her named brand had no row, the preview says so in place of the generic no-brand note.
 * No record — the ad gate asked before any call — and the brief is as it came.
 */
function withInterpretation(
  brief: CreativeBrief,
  record: InterpretationRecord | null,
  interpreted: Extract<PreviewInterpretation, { kind: "proposal" }> | null,
): CreativeBrief {
  if (!record) return brief;
  const intent = brief.job.editIntent;
  const lines =
    interpreted && intent
      ? describeIntent(intent, provenanceFor(intent, interpreted.proposal))
      : [];
  const note = interpreted?.brandNote ?? null;
  const gaps = note
    ? brief.gaps.some((g) => g.field === "brand")
      ? brief.gaps.map((g) => (g.field === "brand" ? { ...g, note } : g))
      : [...brief.gaps, { field: "brand", note, severity: "degraded" as const }]
    : brief.gaps;
  return {
    ...brief,
    gaps,
    job: { ...brief.job, interpretation: { ...record, lines } },
  };
}

/**
 * THE CARD, ON A PREVIEW THE RULES READ WITH HER KEEP BESIDE THEM (A3b; studio/keepVocab.ts).
 *
 * "make it warmer, dont change anything about me" routes, and her keep froze beside the look as
 * `preserve_person`. That is a promise, and it should look like the same promise an interpreted preview
 * makes: the card's lines from the FROZEN intent (compile/describe.ts), every one tagged hers — she typed
 * every word the rules read. No record, and nothing to refuse: nothing was interpreted, so "Not what I
 * meant" has no reading to take back. Display only (`BriefJob.card`). A brief the interpreter read, or one
 * with no constraint frozen, is returned as it came.
 */
function withRoutedCard(brief: CreativeBrief): CreativeBrief {
  const intent = brief.job.editIntent;
  if (brief.job.interpretation || !intent?.constraints?.length) return brief;
  const lines = describeIntent(intent, {
    changes: intent.changes.map(() => ({ source: "yours" as const })),
    constraints: intent.constraints.map(() => "yours" as const),
  });
  return { ...brief, job: { ...brief.job, card: { lines } } };
}

// ─── POST /studio/preview ───────────────────────────────────────────────────────────────────────

router.post("/studio/preview", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  // ─── A CREATIVE INTENT (0072): the last adapter, before the body is parsed ───────────────────────
  //
  // With `creativeIntentId`, the objective comes from her CONFIRMED interpretation, the deliverable from the
  // confirmed format (or her own words), the brand from the intent, the origin from its source — and the body
  // may not override any of them. Off, the field is unknown (400). Not hers 404; withdrawn or unconfirmed 409;
  // a format Studio has no executor for 422. Every gate below this line is exactly as it was: provenance, not
  // authorization.
  let creative: ResolvedCreativeIntent | null = null;
  const bodyIn: Record<string, unknown> = (req.body && typeof req.body === "object" && !Array.isArray(req.body)) ? { ...(req.body as Record<string, unknown>) } : {};
  if (bodyIn.creativeIntentId !== undefined) {
    if (!creativeIntentsEnabled()) { res.status(400).json({ error: "unknown field", field: "creativeIntentId" }); return; }
    const cid = bodyIn.creativeIntentId;
    if (typeof cid !== "string" || !UUID_RE.test(cid)) { res.status(400).json({ error: "creativeIntentId must be an intent id", field: "creativeIntentId" }); return; }
    for (const f of ["objective", "deliverable", "brandId", "origin"]) if (bodyIn[f] !== undefined) { res.status(400).json({ error: `${f} comes from the confirmed creative request, not the body`, field: f }); return; }
    const r = await resolveCreativeIntentForBrief(db, athleteId, cid);
    if ("status" in r) { res.status(r.status).json({ error: r.error, field: r.field }); return; }
    creative = r;
    delete bodyIn.creativeIntentId;
    bodyIn.objective = r.objective;
    bodyIn.deliverable = r.deliverable;
    if (bodyIn.intent === undefined) bodyIn.intent = VIDEO_DELIVERABLES.has(r.deliverable) ? "video.generate" : "image.generate";
    if (r.brandId !== null) bodyIn.brandId = r.brandId;
    if (bodyIn.direction === undefined && r.direction) bodyIn.direction = r.direction;
  }

  const parsed = parsePreviewBody(bodyIn);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }

  // ─── THE CARRIER (PR 14): the plan this clip belongs to, read under HER id, before anything runs ──
  //
  // Behind STUDIO_BRIEF_CARRIER: off, `planId` is an unknown field (a client newer than this server is
  // a 400, not a shrug) and no row is read. On, the row is hers or a 404 — the music-suggest precedent,
  // verbatim — and the carrier is built from the ROW (studio/campaign/carrier.ts), never the body. The
  // campaign parts need STUDIO_BRAND_PROFILES; her typed feel, the purpose and the concept ride anyway.
  // ⚠️ MUTATIONS (studio.generate.test): drop the flag check — "carrier renders with STUDIO_BRIEF_CARRIER
  // off" reds; read the row by id alone — "a clip request with another athlete's planId is served" reds.
  if (parsed.planId !== undefined && !briefCarrierEnabled()) {
    res.status(400).json({ error: "unknown field", field: "planId" });
    return;
  }
  let carrier: import("../studio/campaign/carrier").JobCampaign | null = null;
  // Slice 4 M4: the plan's creative intent, read from the ROW under her id — audit lineage only, never authorization.
  let planIntentId: string | null = null;
  if (parsed.planId !== undefined) {
    const { readPlan } = await import("../studio/agent/plans.js");
    const row = await readPlan(athleteId, parsed.planId);
    if (!row) {
      res.status(404).json({ error: "That plan isn't one of yours.", field: "planId" });
      return;
    }
    if (row.creative_intent_id && !creative) {
      const { getCreativeIntent } = await import("../services/intelligence/creative/store.js");
      const ci = await getCreativeIntent(db, athleteId, row.creative_intent_id);
      if (ci?.withdrawnAt) { res.status(409).json({ error: "That creative request was withdrawn — nothing more is prepared from it.", field: "planId" }); return; }
      planIntentId = ci?.id ?? null;
    }
    const { carrierFromPlan } = await import("../studio/campaign/carrier.js");
    carrier = carrierFromPlan(row, brandProfilesEnabled());
  }

  try {
    if (!(await hasBeenScored(athleteId))) {
      res.status(409).json({
        error: "Your profile is still being put together — check back shortly and Studio will be ready.",
        field: "athlete",
      });
      return;
    }

    // ─── THE INTERPRETER (the interpreter, I.5) ────────────────────────────────────────────────
    //
    // Only where the rules ASKED about her sentence with a code a paraphrase might answer, both flags are
    // on, and she drew no box (studio/interpret/eligibility.ts). Before detection, because detection reads
    // its answer: on a proposal the preview continues exactly as if she had typed C — detection on C, the
    // brief's direction C, the freeze and the compile — so the spend-time re-check reads C and agrees by
    // construction. On an ask it blocks with the ask's line, and detection never runs on her sentence.
    //
    // On a NEW IMAGE (interpret/5) — she asked for a new picture of her, not an edit of this photograph — it
    // blocks the same way, with the new-image line in place of her sentence's ask, and the response says
    // `newImage: true` so a screen can tell it from a decline without reading copy.
    //
    // With STUDIO_INTERPRETER off nothing below is reached — not even the classifier — and `direction` and
    // `brandId` are the request's own, so every preview is the one main builds.
    const attached = attachedIn(parsed.references);
    let direction = parsed.direction;
    let brandId = parsed.brandId;
    let interpreted: Extract<
      PreviewInterpretation,
      { kind: "proposal" }
    > | null = null;
    let interpreterAsk: Extract<
      PreviewInterpretation,
      { kind: "ask" }
    > | null = null;
    let newImage = false;
    // The interpreter's record for a new-image exit — carried onto the brief like a proposal's.
    let newImageRecord: InterpretationRecord | null = null;
    // The frame she marked, re-read as her likeness. Set only on a new-image exit (card 1).
    let frameAsLikeness: JobReference | null = null;
    const routedS =
      interpreterEnabled() &&
      parsed.intent === "image.edit" &&
      parsed.direction !== undefined
        ? classifyRequest(parsed.direction, true, attached)
        : null;
    if (
      routedS &&
      parsed.sourceAssetId &&
      parsed.direction !== undefined &&
      interpretable({
        enabled: interpreterEnabled(),
        nativeEdit: nativeEditEnabled(),
        hasFrame: true,
        drawn: !!parsed.regions?.length,
        origin: "system",
        sentence: parsed.direction,
        routed: routedS,
      })
    ) {
      // Her frame, under HER athlete id, before any call reads it — the same predicate and the same 404 as
      // resolveSource. The model is never shown a photograph that is not hers.
      const frameRow = await readOwnedImage(athleteId, parsed.sourceAssetId);
      if (!frameRow) {
        res.status(404).json({
          error: "That photo isn't in your library",
          field: "sourceAssetId",
        });
        return;
      }
      let brand: PreviewAsk["brand"] = null;
      if (parsed.brandId != null) {
        const ctx = await getBrandContext(parsed.brandId);
        if (!ctx) {
          res.status(404).json({ error: "No such brand", field: "brandId" });
          return;
        }
        // The tone fields ride along rather than being re-fetched: this row is already in hand, and
        // the interpreter's `<brand>` block is their only reader (wave C card 3).
        brand = {
          id: ctx.id, name: ctx.name, category: ctx.category,
          contentStyle: ctx.contentStyle ?? null,
          audience: ctx.audience,
          recentCampaigns: ctx.recentCampaigns ?? [],
        };
      }
      const out = await interpretForPreview({
        athleteId,
        sourceAssetId: frameRow.id,
        frame: () => probeBytesFor(frameRow.gcs_path!),
        sentence: parsed.direction,
        attached,
        brand,
        routed: routedS,
        register: () => athleteRegisterFor(athleteId),
      });
      if (out.kind === "proposal") {
        interpreted = out;
        direction = out.proposal.canonical;
        brandId = out.brandId;
      } else if (out.kind === "new_image") {
        // ─── A NEW IMAGE EXITS TO GENERATE, IT DOES NOT BLOCK (wave D, card 1) ──────────────────
        //
        // The interpreter answered that she asked for a NEW PICTURE OF HER rather than an edit of
        // this photograph. Blocking on an ask was a dead end: "me on a beach at sunset" and "give me
        // another picture like this but at night" both reached this line with the right verdict on
        // the log and still came back `mode: edit, status: blocked`, so the one thing she asked for
        // was the one thing the preview would not do (acceptance F3, D7).
        //
        // So the verdict is HONOURED: the preview becomes a generate of her, quoted at the generate
        // price and approved the way every generate is. Nothing is frozen, nothing is detected, and
        // her sentence travels as the direction exactly as she typed it.
        //
        // ⚠️ THE FRAME SHE TAPPED BECOMES HER LIKENESS, not the thing being edited. A generate with
        // no `person` reference does not reliably render HER (the identity probe: no-reference
        // generates come back as literal Instagram UI), and the frame is the one photograph of
        // herself this request is certain to have. `role: "person"` is already defined as "her
        // photograph, whether it is the frame being changed or an identity anchor for a net-new
        // image" — see the ClassifyBody note below — so this is that role's second reading, not a
        // new meaning for it.
        //
        // ⚠️ AND ONLY WHEN SHE ATTACHED NO LIKENESS OF HER OWN. A You photo she picked is a choice;
        // the marked frame is a fallback for when there is none, and never a fourth reference added
        // on top of hers.
        //
        // ⚠️ A MOTION DELIVERABLE DOES NOT TAKE THIS EXIT, and the reason is that the answer it
        // already had is better. `image.edit` + "clip" passes the request's own pair check (an edit's
        // task is its intent whatever the deliverable), and `taskFor` then blocks it with copy that
        // says the useful thing: "Editing a clip is not supported — Generate it as a new clip, or
        // edit a still instead." Turning the mode to `generate` here would satisfy `taskFor` instead
        // of tripping it, so the preview would come back READY as a `video.generate`, quoted at video
        // prices — and she would get a clip she never asked for instead of the sentence that told
        // her what to do. (Before video was wired this was a 503 from `assertRunnableInline`; the
        // reason for keeping the ask is the same, and is now about the wrong OUTPUT rather than a
        // refusal.) So a motion deliverable keeps
        // the ask, exactly as it did before this card. (Caught by nomila-v2-3a, whose video spend-cap
        // work sits on the other side of this seam.)
        newImage = !VIDEO_DELIVERABLES.has(parsed.deliverable);
        if (!newImage) {
          interpreterAsk = {
            kind: "ask",
            askReason: NEW_IMAGE_ASK,
            record: out.record,
          };
        } else {
          newImageRecord = out.record;
          frameAsLikeness = parsed.references?.some((r) => r.role === "person")
            ? null
            : { role: "person", ref: frameRow.gcs_path!, mediaAssetId: frameRow.id };
        }
      } else {
        interpreterAsk = out;
      }
    }

    let source: SourceAsset | undefined;
    let looseNote: string | null = null;
    let derivedRegions: RegionFraction[] | null = null;
    // ─── AN ADD IS MEASURED, NEVER DETECTED (PR C′) ───────────────────────────────────────────
    //
    // The thing she wants added is not in the frame, so detection has nothing to find: it answers
    // not-found, or — when the place names her, "on top of her head" — refuses on its own person
    // rule, and either way she gets a 400 about a region nobody asked for. So an add skips it and
    // pays nothing for it. The frame is still MEASURED, because the ratio and the size are pinned
    // from it. A box she drew is never second-guessed, so an add only takes this arm without one.
    //
    // ─── AND DETECTION READS ONLY WHAT NAMES A THING IN THE FRAME (composition, decision 3) ──────
    //
    // A composed sentence ("make her jersey blue and change the background to a stadium") is sent
    // as its region-bearing clauses alone — "make her jersey blue" — because detection given the
    // whole would answer the background and drop the jersey, or refuse an add's place ("at her feet")
    // on its person rule. One with no such clause takes the add's arm above. Every other sentence is
    // sent exactly as it came. studio/nativeIntent.ts, `detectionTextFor`.
    //
    // What she attached beside the frame is part of the question since replace with reference: "change
    // my earrings to these gold hoops" names a thing in the frame only with her Object photo attached,
    // and asks without one. The count is the list resolveReferences reads below — a miss there is a 404.
    //
    // An interpreted sentence is C by now (above), so detection reads C's clauses — never her words. And
    // when the interpreter asked, nothing is detected at all: the preview only blocks.
    const detectFrom =
      direction === undefined || interpreterAsk || newImage
        ? undefined
        : detectionTextFor(direction, attached);
    const regionFree =
      parsed.intent === "image.edit" &&
      !newImage &&
      !parsed.regions?.length &&
      detectFrom === null;
    // A new-image exit has no frame to find anything in and nothing to keep continuous with, so the
    // photograph she tapped is never resolved as a SOURCE — it is re-read below as her likeness.
    if (parsed.sourceAssetId && !newImage) {
      // Her own words are what the region is derived FROM, so they only travel on an edit. A
      // generate has no frame to find anything in.
      const resolved = await resolveSource(
        athleteId,
        parsed.sourceAssetId,
        parsed.regions,
        parsed.intent === "image.edit" && !regionFree ? (detectFrom ?? undefined) : undefined,
        { measureWithoutRegions: regionFree },
      );
      if (!resolved) {
        // Not found AND not yours are the same answer on purpose: a different one would confirm
        // that somebody else's asset id exists.
        res.status(404).json({ error: "That photo isn't in your library", field: "sourceAssetId" });
        return;
      }
      // A region that does not fit the frame, or a frame we could not measure. Her input is wrong
      // in a way she can act on, so it is a 400 rather than a blocked preview — and nothing is
      // written, so there is no row that could later authorize a spend on a bad mask.
      if ("error" in resolved) {
        res.status(400).json({ error: resolved.error, field: resolved.field });
        return;
      }
      source = resolved.source;
      looseNote = resolved.looseNote;
      derivedRegions = resolved.derived;
    }

    if (brandId != null && !(await resolveBrand(brandId))) {
      res.status(404).json({ error: "No such brand", field: "brandId" });
      return;
    }

    // Every reference re-read under HER athlete id. A miss is the same 404 the source frame gets,
    // and for the same reason — a different answer would confirm another athlete's asset exists.
    let references: JobReference[] | undefined;
    if (parsed.references?.length) {
      const resolved = await resolveReferences(athleteId, parsed.references);
      if (!resolved) {
        res.status(404).json({ error: "One of those photos isn't in your library", field: "references" });
        return;
      }
      if ("refusal" in resolved) {
        res.status(422).json({ error: REFERENCE_REFUSAL_COPY[resolved.refusal], field: "references", reason: resolved.refusal });
        return;
      }
      references = resolved;
    }
    // ─── ⚠️  THE LAST FRAME, RE-READ UNDER HER ATHLETE ID ──────────────────────────────────────
    //
    // Same predicate as every other client-supplied id here, same 404 on a miss, and the ref comes
    // OUT OF THE ROW. Not a formality: this id names a photograph sent to a paid provider as the
    // frame a clip renders toward. A distinct message would tell a prober that somebody else's
    // asset exists, so the sentence is the one a bad reference gets.
    let lastFrame: JobLastFrame | undefined;
    if (parsed.lastFrameAssetId) {
      const row = await readOwnedImage(athleteId, parsed.lastFrameAssetId);
      if (!row) {
        res.status(404).json({
          error: "One of those photos isn't in your library",
          field: "lastFrameAssetId",
        });
        return;
      }
      lastFrame = { mediaAssetId: row.id, ref: row.gcs_path! };
    }

    // ─── THE MARKED FRAME, AS HER LIKENESS (wave D, card 1) ────────────────────────────────────
    //
    // Only on a new-image exit, only when she attached no photograph of herself, and read from the
    // row the interpreter block already fetched under HER athlete id — never from the body.
    if (newImage && frameAsLikeness) {
      references = [...(references ?? []), frameAsLikeness];
    }

    const input: BriefInput = {
      athleteId,                                       // from the token. Never from the body.
      // The request's brand — or, on an interpreted ad, the row the brand she named resolved to (M7).
      brandId,
      // This door is hers; `inbound` is the brand-ask path. With a creative intent (0072) the origin is the intent's
      // source — `athlete` for her own request — and the intent id rides the brief as provenance.
      origin: creative?.origin ?? "system",
      ...(creative ? { creativeIntentId: creative.intent.id } : planIntentId ? { creativeIntentId: planIntentId } : {}),
      ...(creative?.campaignLineage ? { campaignLineage: creative.campaignLineage } : {}),
      // A campaign intent worded by a contract is `inbound`: the contract's words travel as the untrusted ask Studio requires.
      ...(creative?.ask ? { ask: { ask: creative.ask } } : {}),
      objective: parsed.objective,
      deliverable: parsed.deliverable,
      // A new-image exit is a GENERATE however the request arrived — that is card 1's whole point.
      mode: parsed.intent === "image.edit" && !newImage ? "edit" : "generate",
      source,
      // Her words — or C, when the interpreter proposed it: the sentence the rest of the preview reads.
      direction,
      // Server-resolved paths only — resolveReferences fills `ref` from the row, never from the body.
      references,
      // ⚠️ ON THE BRIEF, NOT AN OPTION. The spend leg replays this object alone, so a last frame
      // passed any other way is dropped between the quote and the run — and it decides the routed
      // model and therefore the price. See JobLastFrame.
      ...(lastFrame ? { lastFrame } : {}),
      // On the brief, not a preview option — the spend leg replays the brief and nothing else.
      // Motion only: a still that happened to send a duration freezes no such key.
      ...(parsed.durationSeconds !== undefined &&
      VIDEO_DELIVERABLES.has(parsed.deliverable)
        ? { durationSeconds: parsed.durationSeconds }
        : {}),
      // On the brief for the same reason, and motion only for the same reason: it doubles the Veo
      // rate, and an option the spend leg replays without is quoted with sound and run silent.
      ...(parsed.audio && VIDEO_DELIVERABLES.has(parsed.deliverable)
        ? { audio: true as const }
        : {}),
      // Motion only, for the same reason: a still has no camera to move.
      ...(parsed.shot && VIDEO_DELIVERABLES.has(parsed.deliverable)
        ? { shot: parsed.shot }
        : {}),
      // On the brief, for the same reason (PR 14): built from her plan row above, never from the body.
      ...(carrier ? { campaign: carrier } : {}),
      // quality-scrappy piece 5: a re-quote's corrective codes — opt-in, STUDIO_OUTPUT_GATE; off, dropped.
      ...(parsed.corrective?.length && outputGateEnabled() ? { corrective: parsed.corrective } : {}),
    };

    // ─── THE NATIVE EDIT INTENT IS FROZEN HERE, WHEN SHE IS QUOTED, OR NOWHERE ─────────────────
    //
    // With STUDIO_NATIVE_EDIT on, an edit whose regions came from her sentence has that sentence
    // classified NOW and the answer frozen onto the brief this preview row stores — so the intent she
    // approves a cost against is the one that runs. It is classified from `input` (her typed words,
    // via explicitAsk), never from the assembled brief's statement, which can be our boilerplate. A
    // box she DREW routes masked, permanently, and is left alone. Flag off: the brief, untouched.
    // See studio/nativeIntent.ts.
    const assembled = await assembleBrief(input);
    const framed = interpreterAsk
      ? withInterpretation(
          blockedOnAsk(assembled, interpreterAsk.askReason),
          interpreterAsk.record,
          null,
        )
      : newImage
        // A generate has no edit intent to freeze, so nothing is frozen onto it — but the record of
        // what the interpreter read still rides on the brief, exactly as a proposal's does (card 1).
        ? withInterpretation(assembled, newImageRecord, null)
        : withInterpretation(
          withNativeEditIntent(assembled, input, {
            regions: regionFree
              ? "region-free"
              : derivedRegions
                ? "derived"
                : parsed.regions?.length
                  ? "drawn"
                  : "none",
            // The interpreter's conditions, frozen beside C (version 2) — only on a proposal.
            ...(interpreted
              ? {
                  constraints: frozenConstraints(
                    interpreted.proposal.constraints,
                  ),
                }
              : {}),
          }),
          interpreted?.record ?? null,
          interpreted,
        );
    // Her keep, frozen beside the rules' steps (A3b): the same card, and nothing to refuse. (A crop's standing is the
    // chain rule's now — referenceGate.ts CHAIN_IDENTITY_BOUND_SQL walks it; nothing is stamped at the quote.)
    // quality-scrappy piece 4 (STUDIO_PROMPT_REGISTRY): the template this brief compiles from, frozen onto it HERE, when
    // she is quoted — a published row's body verbatim, or the literal's key — so the run renders what she was quoted
    // against (studio/templates/freeze.ts). Flag off: the brief, untouched.
    const brief = await withPromptTemplate(withRoutedCard(framed));

    const preview = withLooseMaskNote(
      previewGeneration(brief, {}),
      looseNote,
    );

    // Persist the verdict she is about to be shown. This row — not anything the client later sends
    // — is what authorizes a spend, so the id returned below is the DB row's, not the in-memory one
    // previewGeneration minted. A blocked verdict is stored too: it is a real thing that happened,
    // and /studio/generate needs to be able to say "that check said no" rather than "no such check".
    const previewId = await savePreview(athleteId, preview);

    // The derived box travels back so the mask editor can be SEEDED with it — she sees what will
    // change and can correct it before she approves. Absent when she drew the box herself (there is
    // nothing to tell her) and when this is a generate.
    const card: InterpretationCard | null =
      brief.job.interpretation && interpreted
        ? { lines: brief.job.interpretation.lines }
        : null;
    // A preview the rules read with her keep beside them shows the same card, with nothing to refuse (A3b).
    const routedCard: InterpretationCard | null = brief.job.card ?? null;
    res.json({
      ...humanize(preview),
      previewId,
      ...(derivedRegions ? { derivedRegions } : {}),
      ...(card ? { interpretation: card } : {}),
      ...(routedCard ? { card: routedCard } : {}),
      // She asked for a new picture of her (interpret/5): present only then — never on a decline or any other ask.
      ...(newImage ? { newImage: true } : {}),
    });
  } catch (err) {
    // A foreseeable refusal from the assembler (bad fork, missing ask) is the caller's fault, not a
    // 500. previewGeneration itself renders refusals rather than throwing.
    if (err instanceof GenerationError && err.code === "invalid_input") {
      res.status(400).json({ error: err.message, field: "intent" });
      return;
    }
    logger.error(
      { err, athleteId, intent: parsed.intent, references: parsed.references?.length ?? 0 },
      "studio preview failed",
    );
    res.status(500).json({ error: "Couldn't build the preview" });
  }
});

// ─── POST /studio/classify ──────────────────────────────────────────────────────────────────────

/**
 * WHAT SHE ASKED FOR, AS AN OPERATION — the routing decision, moved off the client.
 *
 * ─── WHY THIS ROUTE EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * `engineIntentFor` (client/lib/studio-contract.ts) decided between editing a photograph and
 * replacing one by testing her sentence against a list of edit verbs. That list cannot be made
 * right: "change the color of the socks to red" and "make the socks blue" ask for the same picture,
 * and only the first carries a verb from it. The second fell through to `image.generate` and the
 * frame was replaced. See the header of studio/classify.ts for the matrix that retired the idea.
 *
 * So the decision moves here, where it holds for every caller rather than for the one that happens
 * to come through the client.
 *
 * ─── IT SPENDS NOTHING, WRITES NOTHING, AND READS NO ROW ───────────────────────────────────────
 *
 * `route()` is pure regex work over her sentence — there is no model call on this path and no
 * database query, so THERE IS NO TENANCY PREDICATE TO WRITE HERE. That is worth saying out loud
 * rather than leaving a reader to notice the absence: the athlete id is still required (the route
 * sits behind the same `studioGate` as every other one) and is still unused, because the answer
 * depends on her words and nothing else. The moment this route reads a row, that stops being true
 * and the predicate goes in with it.
 *
 * ⚠️ HER SENTENCE IS NEVER LOGGED, on any branch including the error one. A direction can arrive
 * from an inbox message or a brand email, so it is untrusted text that does not belong in a log
 * line — the same rule `detectRegions` and `logFallThrough` already keep. The reason code and the
 * extracted determiner/phrase tokens are what get recorded, and classify.ts does that itself.
 */
interface ClassifyBody {
  /** Her own words. The only input the answer depends on, beside the flag below. */
  direction: string;
  /**
   * Whether there is a photograph in this request that could be EDITED.
   *
   * ⚠️ THE CLIENT IS THE ONLY THING THAT KNOWS THIS, and that is not a hole in the design. A
   * `role: "person"` reference is her photograph either way; whether it is the frame being changed
   * or an identity anchor for a net-new image is a fact about which tray tile she filled, and the
   * server cannot see the tray. Reading it off the references here would decide the documented
   * `source-frame` collision (the TODO on ENGINE_ROLE) by guess, and would break "put me on a
   * rooftop at dusk" — a legitimate generate with her photo attached.
   *
   * ─── THE CONTRACT THAT REPLACED THAT COLLISION — 2026-09-09, PR R ──────────────────────────
   *
   * The paragraph above stands as written: it is still true that the server must not guess, and it
   * is the reason this field exists. What has changed is that the tray now has an answer to give,
   * so "the server cannot see the tray" is no longer the end of the sentence.
   *
   * ONE TILE CARRIED THREE MEANINGS — the frame being edited, an identity anchor, and an object
   * library to pull a thing out of. The third had no tile at all, which is why a soccer ball ended
   * up tagged "Your media" and, being first in the array, became the frame (sweep 7.2). Three
   * things resolve it, and none of them is a guess made here:
   *
   *   1. `object` is a real role (studio/brief.ts), so material has somewhere to go that is not
   *      "a photograph of hers".
   *   2. The frame is HER EXPLICIT MARK, carried in tray state and shown as a badge she can move
   *      (`frameFor` / `nextFrameAssetId`, client/lib/studio-contract.ts). It is never array order,
   *      and a second attachment asks her rather than reassigning.
   *   3. A second photograph of hers is therefore a QUESTION at the moment it is attached, not an
   *      inference at request time.
   *
   * So the remaining two meanings on the "Your media" tile — the frame, and an identity anchor —
   * stay one tile ON PURPOSE. They are the same photograph, and which one it is depends on the
   * sentence; the cutover moved that decision to her words, and splitting the tile would move it
   * back to attach time. "put me on a rooftop at dusk" is still the case that proves it: one
   * attachment, no edit verb, and it is the CLASSIFIER that calls it BACKGROUND and edits her
   * photograph. Nothing about the reference list decided that, here or anywhere.
   *
   * ─── 2026-09-16, FRAME DEFAULTING: TRUE MEANS SHE MARKED ONE ───────────────────────────────
   *
   * The paragraph above no longer describes the client. The tray marked her first photograph the
   * moment it was attached and sent `true` whenever any photo of hers was there, so a reference
   * pack could never be a generate: "generate a pic of me playing soccer" with photos of her came
   * back ASK, and an edit refuses photos of her anyway. Now the client sends `true` only when she
   * MARKED a photograph as the one to edit (the EDITING badge, Edit this, a thread's continuation
   * — `markedFrame` / `routeMarked`, client/lib/studio-contract.ts). An unmarked photo of hers is
   * her likeness, and `false` is the truthful answer beside it: "put me on a rooftop at dusk" with
   * an unmarked photo is a GENERATE, and marked it is still the BACKGROUND edit above. Nothing on
   * this side changed: the server still cannot see the tray, and still does not guess. Item 3
   * moved too: a photo of hers beside a MARKED one is asked about when she sends (edit the marked
   * one, or a new image from all of them), no longer when she attaches it.
   *
   * A client that lies in the SAFE direction (true with no photo) gets an edit operation it cannot
   * use, which is a 400 later. A client that lies in the UNSAFE direction (false with a photo) gets
   * GENERATE — which is exactly the pre-cutover behaviour it would have had anyway, and is why the
   * generate route re-classifies the frozen brief rather than trusting this answer. See
   * `runStudioGeneration`'s call site below.
   */
  hasSourcePhoto: boolean;
  /**
   * How many OBJECT photos her tray carries (the Object tile) — replace with reference, 2026-09-11.
   *
   * One reading depends on it: "change my earrings to these gold hoops" points at a photo, and routes
   * with one attached and ASKS without (classify.ts, `route`). The same trust rule as `hasSourcePhoto`:
   * only the client can see the tray, and nothing it says here can spend. Overstated, the preview it
   * unlocks refuses at the freeze, which counts the server-resolved references. Understated, she is
   * asked for a photo she attached. OPTIONAL and 0 when absent — the side that asks rather than routes,
   * so a client that predates the field never unlocks a replacement pointing at nothing.
   */
  objectPhotos: number;
  /**
   * PR 19 (B): how many STYLE references go with the job — "match this look" points at one. Only with
   * STUDIO_IMAGE_OPS on (off, the field is unknown and refused, PR 14's precedent); absent is 0, which asks.
   */
  stylePhotos?: number;
  /**
   * WHY THE CLIENT ASKED, when it is not the plan's routing decision — auto-mark, 2026-09-16.
   *
   * Create anything asks while she types (`draft`) and at send (`shape`) whether one photo of hers should be the
   * frame (client/screens/studio/createAnythingLogic.ts). Neither answer is shown to her, so neither may read as
   * one in the classifier's fall-through log: a draft call logs nothing, a shape call's lines are tagged
   * (studio/classify.ts, `routeAs`). OPTIONAL — absent is every call before this, logged as it always was. It
   * changes no answer, and nothing it says can spend.
   */
  purpose?: ClassifyPurpose;
}

/**
 * A bound on her sentence, so an unbounded body cannot be handed to a dozen regexes.
 *
 * Generous rather than tight: the direction is prose she typed, and the longest real one in the
 * fixtures is under 200 characters. This refuses the pathological case without ever refusing a
 * request a person actually made.
 */
const MAX_DIRECTION_LEN = 2000;

function parseClassifyBody(raw: unknown): ClassifyBody | BadRequest {
  const b = (raw ?? {}) as Record<string, unknown>;

  if (typeof b.direction !== "string") {
    return { error: "classify needs the words you typed", field: "direction" };
  }
  if (!b.direction.trim()) {
    return { error: "classify needs the words you typed", field: "direction" };
  }
  if (b.direction.length > MAX_DIRECTION_LEN) {
    return { error: `Keep it under ${MAX_DIRECTION_LEN} characters.`, field: "direction" };
  }
  // Explicitly required rather than defaulted. A default here would be a default for the guard —
  // and the safe default (`true`) is the one that withholds GENERATE, so a caller that forgot the
  // field would silently lose net-new generation instead of being told it is missing.
  if (typeof b.hasSourcePhoto !== "boolean") {
    return { error: "hasSourcePhoto must be true or false", field: "hasSourcePhoto" };
  }
  // Optional, unlike hasSourcePhoto: absent is 0, which asks — the safe side (see the field's note).
  // Bounded by the cap an edit's reference list has, so it cannot claim more than one could carry.
  const objectPhotos = b.objectPhotos === undefined ? 0 : b.objectPhotos;
  if (
    typeof objectPhotos !== "number" ||
    !Number.isInteger(objectPhotos) ||
    objectPhotos < 0 ||
    objectPhotos > maxReferences("image.edit")
  ) {
    return {
      error: "objectPhotos must be a count of photos",
      field: "objectPhotos",
    };
  }

  // PR 19 (B): optional, only with STUDIO_IMAGE_OPS on, bounded like objectPhotos.
  if (b.stylePhotos !== undefined) {
    if (!imageOpsEnabled()) {
      return { error: "unknown field", field: "stylePhotos" };
    }
    if (
      typeof b.stylePhotos !== "number" ||
      !Number.isInteger(b.stylePhotos) ||
      b.stylePhotos < 0 ||
      b.stylePhotos > maxReferences("image.edit")
    ) {
      return { error: "stylePhotos must be a count of photos", field: "stylePhotos" };
    }
  }

  // Optional, and one of two words: an unknown purpose is refused rather than logged as a request she was shown.
  if (
    b.purpose !== undefined &&
    !CLASSIFY_PURPOSES.includes(b.purpose as ClassifyPurpose)
  ) {
    return { error: "purpose must be draft or shape", field: "purpose" };
  }

  return {
    direction: b.direction,
    hasSourcePhoto: b.hasSourcePhoto,
    objectPhotos,
    ...(typeof b.stylePhotos === "number" && b.stylePhotos > 0
      ? { stylePhotos: b.stylePhotos }
      : {}),
    ...(b.purpose !== undefined
      ? { purpose: b.purpose as ClassifyPurpose }
      : {}),
  };
}

/**
 * The wire shape. `Routed` plus the first step flattened onto it.
 *
 * ⚠️ `op` AND `targets` ARE `steps[0]`'S, AND `steps` TRAVELS WHOLE BESIDE THEM. A multi-step
 * answer is real — "make my jersey a blue adidas kit" is RECOLOR then APPLY_DESIGN — so a response
 * carrying only the first step would drop the second at the boundary. The flattened pair is there
 * because the single-step case is every deterministic case today and reading `steps[0]?.op` at
 * three call sites is how the optional chain gets forgotten at the fourth.
 *
 * ⚠️ 2026-09-10: not every deterministic case any more. A brand change (classify.ts, rule 4c) is one
 * REPLACE_OBJECT step per item — `op` is still the one op, but `targets` is the FIRST item's only.
 * And the blue adidas kit above is no longer two steps: 4c routes it as ONE REPLACE, "blue adidas
 * jersey".
 */
export interface ClassifyResponse extends Routed {
  /** The first step's operation. Null on ASK, which has no steps at all. */
  op: string | null;
  /** The first step's targets. Empty on ASK, and empty on a GLOBAL step that names no region. */
  targets: string[];
  /**
   * May the preview interpret this ask (the interpreter, I.5)? The same deterministic answer the preview
   * route acts on (studio/interpret/eligibility.ts, `interpretable`): an ask whose code a paraphrase might
   * answer, both flags on, a photo to edit. Pure — no call, no row. Always false with STUDIO_INTERPRETER
   * off, and false on every routed answer. The client sends such an ask to the preview as an edit of her
   * frame; nothing here spends.
   */
  interpretable: boolean;
}

router.post("/studio/classify", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = parseClassifyBody(req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }

  // `routeAs` with no purpose is `route` itself — the plan's call, logged as it always was.
  const routed = routeAs(
    parsed.purpose,
    parsed.direction,
    parsed.hasSourcePhoto,
    {
      objects: parsed.objectPhotos,
      ...(parsed.stylePhotos ? { styles: parsed.stylePhotos } : {}),
    },
  );

  // `reason` is spread through UNTOUCHED and undefined on a routed answer, which is what keeps
  // `person_target` and `fast_path_declined` distinguishable at the other end. They want different
  // UI — one is "we won't do that", the other is "which did you mean" — and the classifier already
  // did the work of telling them apart. Collapsing them into a generic decline here would throw
  // that work away at the last moment the wire could carry it.
  const body: ClassifyResponse = {
    ...routed,
    op: routed.steps[0]?.op ?? null,
    targets: routed.steps[0]?.targets ?? [],
    // No box can be drawn before this answer, and this door is always hers.
    interpretable: interpretable({
      enabled: interpreterEnabled(),
      nativeEdit: nativeEditEnabled(),
      hasFrame: parsed.hasSourcePhoto,
      drawn: false,
      origin: "system",
      sentence: parsed.direction,
      routed,
    }),
  };
  res.json(body);
});

// ─── GET /studio/content ────────────────────────────────────────────────────────────────────────

router.get("/studio/content", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  // Clamped server-side. listStudioContent clamps again; a client-named page size is never honoured
  // on trust, and an unparseable one falls back rather than becoming NaN.
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(1, Math.trunc(asked)), MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const items = await listStudioContent(athleteId, { limit });
    res.json({ items });
  } catch (err) {
    logger.error({ err, athleteId }, "studio content read failed");
    res.status(500).json({ error: "Couldn't load your content" });
  }
});

// ─── GET /studio/deliverables ───────────────────────────────────────────────────────────────────
//
// What she still OWES her brands. Backs the Now feed's OWED rows, the calendar's DUE entries and
// the brand-post brief picker.
//
// OUTSTANDING, NOT ALL — see the header on studio/dealDeliverables.ts. Fulfilled, waived, cancelled
// and superseded rows are filtered out, as are deals she rejected. A deal-history view needs the
// unfiltered read and must not be built on this one.
//
// TENANCY: a deliverable has no athlete_id of its own. It hangs off a deal, and the deal is what
// belongs to somebody — so the whole scoping decision is `deals.athlete_id = req.athleteId` inside
// the query's own JOIN, and there is deliberately no deliverableId or dealId on this route to
// borrow. `brandId` is the one client-supplied value and it can only NARROW her own set.

router.get("/studio/deliverables", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  // Validated to an integer or dropped entirely — never passed through as NaN, which would silently
  // match nothing and read to her as "you owe this brand nothing" rather than as a bad request.
  const asked = req.query.brandId;
  let brandId: number | null = null;
  if (asked !== undefined) {
    const n = Number(asked);
    if (!Number.isInteger(n)) {
      res.status(400).json({ error: "brandId must be an integer", field: "brandId" });
      return;
    }
    brandId = n;
  }

  try {
    const items = await listOutstandingDeliverables(athleteId, { brandId });
    res.json({ items });
  } catch (err) {
    logger.error({ err, athleteId, brandId }, "studio deliverables read failed");
    res.status(500).json({ error: "Couldn't load what you owe" });
  }
});

// ─── POST /studio/previews/:id/interpretation/reject ────────────────────────────────────────────────
//
// "Not what I meant" (the interpreter, I.5; plan v1 A6). She refuses the interpreter's reading of her
// sentence: the rejection is recorded on that preview row and the row is blocked, so the approval it
// carried can never be spent. Her words go back to the composer on the client; nothing is re-asked here.
//
// TENANCY is in the store's predicate (`rejectInterpretation`): another athlete's preview id changes
// nothing and answers the same 404 a nonexistent one does. A preview Generate already spent, or one the
// interpreter never read, is a 409 she cannot cause from the card — the card only exists on an unspent,
// interpreted preview.
router.post("/studio/previews/:previewId/interpretation/reject", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const previewId = req.params.previewId;
  if (!UUID_RE.test(previewId)) { res.status(404).json({ error: "No such cost check" }); return; }

  try {
    const outcome = await rejectInterpretation(athleteId, previewId);
    switch (outcome) {
      case "rejected":
        res.json({ previewId, rejected: true });
        return;
      case "not_found":
        res.status(404).json({ error: "No such cost check" });
        return;
      case "consumed":
        res
          .status(409)
          .json({ error: "That was already generated.", field: "previewId" });
        return;
      case "not_interpreted":
        res.status(409).json({
          error: "That check wasn't a reading of your words.",
          field: "previewId",
        });
        return;
    }
  } catch (err) {
    logger.error(
      { err, athleteId, previewId },
      "studio interpretation reject failed",
    );
    res.status(500).json({ error: "Couldn't record that right now." });
  }
});

// ─── POST /studio/generate ──────────────────────────────────────────────────────────────────────
//
// THE ONLY DOOR THAT SPENDS MONEY, AND THE ONE PLACE IN THIS FILE TO READ CAREFULLY.
//
// The body is `{ previewId }` and nothing else. In particular there is NO approved-cost field, and
// an `approvedCostUsd` or `cost` a client invents is not read by anything below — the ceiling is
// read back off the server's own preview row, written when the athlete was shown the figure. That
// is what makes the forgery impossible rather than merely detected: there is no number in the
// request to lie about. Note which direction actually mattered — a lowballed ceiling would just
// refuse the job; an INFLATED one would authorize a spend she never saw.
//
// The brief is likewise the FROZEN one off that row, never re-built from this request, so the job
// that runs is the job that was quoted. runStudioGeneration then re-derives the whole verdict from
// it before anything billable — a client that never called /studio/preview has nothing to present
// here, and one that presents a stale approval is caught by the fresh quote.
/**
 * THE CLASSIFIER'S REFUSAL, RE-DERIVED FROM THE FROZEN BRIEF AT SPEND TIME.
 *
 * ─── WHY THIS IS NOT THE CLIENT'S ANSWER, RE-SENT ──────────────────────────────────────────────
 *
 * /studio/classify tells the CLIENT what to do with her sentence. This tells the SERVER whether to
 * spend. They are the same function over the same words and they are deliberately not the same
 * call: a client that never asked, a retry, a cron, or any future API arrives here with the client
 * guard already behind it. That is the entire argument for the classifier being server-side, and it
 * only pays off if the server actually consults it on the path that spends money.
 *
 * It reads the FROZEN brief — the one the quote was taken against — for the same reason
 * `runStudioGeneration` re-derives the whole verdict from it: the job that runs must be the job
 * that was checked.
 *
 * ─── WHAT IT THREADS, AND THE MUCH LARGER THING IT DELIBERATELY DOES NOT ───────────────────────
 *
 * ⚠️ ONLY AN ASK IS PASSED THROUGH — THE SERVER GETS TO SAY NO, NOT TO SAY SOMETHING DIFFERENT. A
 * routed answer returns `{}` and `opts.path` stays undefined, so `usesMaskedPath` keeps deducing
 * from brief shape exactly as it always has.
 *
 * DO NOT "COMPLETE" THIS BY PASSING `routed.initialPath` THROUGH. It looks like the obvious missing
 * half and it is a correctness bug, for a reason that outranks the tidiness:
 *
 *   A BOX SHE DREW IS AN EXPLICIT INSTRUCTION. She marked those pixels to say where the edit goes.
 *   The classifier's path is an INFERENCE FROM TEXT — it reads her sentence and guesses at an
 *   operation. Inference does not override an explicit action by the person the software works for.
 *   `resolveSource` already states this rule for the derivation side ("a box she marked herself is a
 *   statement about which pixels she means", never second-guessed); this is the same rule at the
 *   spend boundary.
 *
 *   Concretely: ROUTE maps RECOLOR to FULL_IMAGE, so threading the path would hand "make the socks
 *   blue" a FULL_IMAGE verdict that silently discards the mask she drew, and re-render the whole
 *   frame she had asked to touch in one place. Nothing would report a problem. Both steps succeed.
 *
 * That is the same split the person guard keeps, and it is worth naming because it is the shape of
 * every safe answer in this file: a guard that refuses is bounded — the worst case is she is told
 * no and says it again. A guard that REDIRECTS is unbounded, because it acts on its own reading of
 * her sentence and she finds out afterwards, from the picture.
 *
 * ⚠️ AND IT CANNOT SEE THE CASE THE CUTOVER IS NAMED FOR. A brief whose mode is `generate` has no
 * `source`, so `hasSourcePhoto` is false, so `allowedOps` returns `["GENERATE"]` and rule 0 selects
 * it — no refusal. That is correct for a real generate and useless against a mis-routed one, and it
 * is why the client half of this cutover is not redundant with this function. The remaining hole is
 * written up in full on the classify route above (`ClassifyBody.hasSourcePhoto`).
 */
function refusalFor(brief: CreativeBrief): { path?: EditPath; askReason?: string } {
  if (!studioServerRouting()) return {};

  const routed = classifyRequest(
    brief.job.direction.statement,
    Boolean(brief.job.source),
    // The frozen brief's own Object photos, by role — the count it was quoted with (replace with reference).
    attachedIn(brief.job.references),
  );
  if (routed.initialPath !== "ASK") return {};

  return { path: "ASK", askReason: routed.reason ?? "unspecified" };
}

/**
 * THE FROZEN NATIVE INTENT, RE-CHECKED AT SPEND TIME — and refused on any disagreement.
 *
 * A native edit runs on the intent frozen when she was quoted (studio/nativeIntent.ts). This is the
 * existing re-check — the same classifier over the frozen brief's statement, the same thing
 * `refusalFor` reads — kept as a GUARD over it. If the two answers differ in path, operation,
 * targets, value or scope, the job refuses before anything is opened or claimed, and the difference
 * is logged. It is never resolved: not by trusting the frozen answer (the brief may be something the
 * quote did not describe), and not by trusting the fresh one (that would run a job nobody priced).
 *
 * ⚠️ IT RUNS WHETHER OR NOT STUDIO_SERVER_ROUTING IS ON. `refusalFor` is that flag's half of the
 * cutover; this belongs to the native path, whose whole premise is that a classified intent is what
 * runs. A frozen intent with no re-check behind it would be trusted on the strength of a jsonb row.
 *
 * For a typed edit the two agree by construction — `directionFor` makes the statement her trimmed
 * words, which are exactly what `explicitAsk` froze from — so a disagreement means something moved
 * between the quote and the spend: the classifier (a deploy inside the 30-minute window), or the
 * brief. Either way the answer is a fresh check.
 */
export const NATIVE_INTENT_CHANGED =
  "Something changed since your cost check, so it no longer describes this edit. Check the cost " +
  "again — nothing was spent.";

function nativeRecheck(brief: CreativeBrief, ctx: { athleteId: string; previewId: string }): string | null {
  const native = readNativeIntent(brief);
  if (native.kind !== "native") return null;

  // With the frozen brief's own Object photos, as the freeze counted them: a replacement she pointed at
  // her photo for re-checks as that replacement only with the photo still on the brief.
  const recheck = classifyRequest(
    brief.job.direction.statement,
    Boolean(brief.job.source),
    attachedIn(brief.job.references),
  );
  if (intentsAgree(native.intent, recheck)) return null;

  // Operations, paths and the extracted target tokens — the fields classify.ts already logs. Never
  // her sentence, and never a value, which can be a longer fragment of it.
  logger.warn(
    {
      event: "native_intent_mismatch",
      ...ctx,
      frozen: {
        path: native.intent.initialPath,
        steps: native.intent.steps.map((s) => ({ op: s.op, targets: s.targets })),
      },
      recheck: {
        path: recheck.initialPath,
        reason: recheck.reason ?? null,
        steps: recheck.steps.map((s) => ({ op: s.op, targets: s.targets })),
      },
    },
    "frozen native intent and the spend-time re-check disagree — refusing, not resolving",
  );
  return NATIVE_INTENT_CHANGED;
}

// ─── POST /studio/plan/admit ────────────────────────────────────────────────────────────────────
//
// MAY THIS PLAN BE PUT IN FRONT OF HER TO APPROVE? Asked once, about N cost checks at a time,
// BEFORE anything is approved and before anything spends.
//
// ─── WHY A ROUTE OF ITS OWN, AND NOT A FLAG ON /studio/generate ────────────────────────────────
//
// /studio/generate is the door that SPENDS, and it spends one preview at a time. By the time it is
// called the decision to run a plan has already been taken. A plan that cannot fit inside the day
// has to be refused while it is still a plan — which is to say, before the first of its items is
// generated, not partway down the list once three of them have been bought.
//
// ⚠️ IT CONSUMES NOTHING AND SPENDS NOTHING. No preview is claimed, no job row is opened, no
// provider is called. Calling it twice is calling it twice; it is a read and an arithmetic answer.
//
// ⚠️ IT IS ADMISSION, NOT A RESERVATION, and a caller must not read a 200 as a promise. Nothing
// here holds the money it counted: between this answering and the last item spending, another tab,
// another device or the storyboard can put a job on the same athlete's day. This narrows the window
// from N spends wide to one decision wide. Closing it needs a reservation row — a write, and
// therefore a migration — which is deliberately not here. See studio/spendCaps.ts.
//
// TENANCY: every preview is read with `loadPreview(athleteId, id)`, which carries the athlete id in
// the PREDICATE. Another athlete's previewId resolves to no row and is answered as a 404 by
// POSITION — never with their model, their figure or the fact that their row exists.
router.post("/studio/plan/admit", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  // ── Shape, before anything is read ────────────────────────────────────────────────────────────
  const previewIds = (req.body ?? {})?.previewIds;
  if (!Array.isArray(previewIds)) {
    res.status(400).json({ error: "admit needs the previewIds of the plan's items", field: "previewIds" });
    return;
  }
  if (previewIds.length === 0) {
    res.status(400).json({ error: "There is nothing in this plan to run.", field: "previewIds" });
    return;
  }
  // The largest BOARD — eight shots and seven bridges — not the planner's six. See MAX_ADMIT_PIECES.
  if (previewIds.length > MAX_ADMIT_PIECES) {
    res.status(400).json({
      error: `A plan holds at most ${MAX_ADMIT_PIECES} pieces.`,
      field: "previewIds",
    });
    return;
  }
  const badAt = previewIds.findIndex((id: unknown) => typeof id !== "string" || !UUID_RE.test(id));
  if (badAt !== -1) {
    res.status(400).json({ error: "each item names the previewId from its cost check", field: `previewIds[${badAt}]` });
    return;
  }
  // A repeated id would be counted twice in the total and then spent once — the plan would be
  // admitted against money it does not actually cost, which is an over-count rather than an
  // under-count, but it also means the plan on screen is not the plan being priced.
  if (new Set(previewIds.map((id: string) => id.toLowerCase())).size !== previewIds.length) {
    res.status(400).json({ error: "the same cost check appears twice in this plan", field: "previewIds" });
    return;
  }

  try {
    // ── Read every item, under her athlete id, before deciding anything ─────────────────────────
    const quotes: PlanItemQuote[] = [];
    for (const [i, previewId] of (previewIds as string[]).entries()) {
      const at = `item ${i + 1} of ${previewIds.length}`;

      const stored = await loadPreview(athleteId, previewId);
      if (!stored) {
        res.status(404).json({
          error: `${at} isn't a cost check of yours, or has been swept.`,
          field: `previewIds[${i}]`,
        });
        return;
      }

      // The same refusals /studio/generate would give this preview, asked now rather than N taps
      // later: blocked by its own check, expired, or unpriced. A plan holding one of these cannot
      // run, and finding that out item by item is the half-execution this route exists to prevent.
      const refusal = approvalRefusal(stored);
      if (refusal) {
        res.status(409).json({ error: `${at}: ${refusal}`, field: `previewIds[${i}]` });
        return;
      }

      // ALREADY SPENT. `approvalRefusal` does not look at this and should not — for one generate
      // the consume race is the authority and a double tap is answered with the winner's job. For a
      // PLAN it is different: an item carrying a job id means this plan has already run, wholly or
      // in part, and re-admitting it would be admitting a second charge for work she has.
      if (stored.consumedByJobId) {
        res.status(409).json({
          error: `${at} has already been run. Plan it again to make another.`,
          field: `previewIds[${i}]`,
        });
        return;
      }

      // OFF OUR OWN ROW, every field. `approvedCostUsd` is the figure the check wrote when she was
      // shown it — never a number re-derived here, and never one off the request body.
      quotes.push({
        model: stored.routedModel,
        unpriced: stored.unpriced,
        amountUsd: stored.approvedCostUsd,
      });
    }

    // ── The money, once ─────────────────────────────────────────────────────────────────────────
    //
    // One read of the day's running total for the whole plan, not one per item: N reads would each
    // see a different instant, and the sum they were compared against would not be a number that
    // was ever true.
    const spent = await spentTodayUsd(athleteId);
    const totalUsd = assertPlanWithinCaps(quotes, {
      maxJobUsd: maxJobUsd(),
      maxDayUsd: maxDayUsd(),
      spentTodayUsd: spent,
    });

    logger.info(
      { athleteId, items: quotes.length, totalUsd, spentTodayUsd: spent },
      "plan admitted",
    );

    // The caps travel with the answer so a surface can render the ceiling it is measured against
    // rather than carrying its own copy of the number. The Board reads `maxJobUsd` from here after
    // every quote (client/screens/studio/StoryboardTab.tsx); it used to hold a placeholder.
    res.status(200).json({
      ok: true,
      itemCount: quotes.length,
      totalUsd,
      spentTodayUsd: spent,
      maxJobUsd: maxJobUsd(),
      maxDayUsd: maxDayUsd(),
    });
  } catch (err) {
    if (err instanceof GenerationError && err.code === "invalid_input") {
      // The gate's message verbatim — it names both sides of whichever comparison refused, and the
      // env knob when it was the day ceiling.
      res.status(409).json({ error: err.message, field: "previewIds" });
      return;
    }
    logger.error({ err, athleteId }, "plan admission failed");
    res.status(500).json({ error: "Couldn't check what this plan costs" });
  }
});

// ─── POST /studio/agent/plan ────────────────────────────────────────────────────────────────────
//
// Her sentence (and what she picked) → a PLAN, cast from her own photographs. The Agent tab's
// server half, behind STUDIO_AGENT (default off).
//
// ─── ⚠️  IT SPENDS NOTHING, AND IT QUOTES NOTHING ─────────────────────────────────────────────
//
// No preview is written, nothing is admitted, no job is opened. It returns the plan and which of
// her photographs each item is made from — nothing else. Pricing is the BOARD's: the Agent screen
// turns these items into Board rows and quotes them through the same boardRequests/previewNow the
// Board uses, so there is one copy of the brief-building code and one copy of the price. "Make the
// board", behind admission, stays the only door that spends.
//
// What it does call: to describe her library to the planner, one searchMedia (photos of her) and one
// scene ranking (studio/agent/cast.ts `rankWithoutHer` — scenes are CONTEXT for b-roll, which is made
// from words and never cast); ONE planner call (studio/agent/config.ts — the only model call, never
// retried); and one search per i2v item whose named photo could not be used. Each of those is one
// embedText. At most nine small calls; no generation.
//
// ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
//
// Every asset she names — her products, the photos she picked — is loaded through the caster's own
// athlete-scoped predicate (studio/agent/cast.ts `loadCastable`) BEFORE any model is called. Another
// athlete's id, a deleted one, a video, and one that does not exist are the same 404, and the
// planner is never asked. The planner itself names no asset: it returns queries, and the caster
// resolves them against her library.
//
// ─── UNTRUSTED CONTENT ──────────────────────────────────────────────────────────────────────────
//
// Her sentence is hers (studio/agent/types.ts `PlanAsk.prompt`). The library descriptions are
// model-written text going back into a model, fenced and labelled as data by the planner. Her
// sentence and the beats are never logged — ids and counts only.

/** Photographs she may hand-pick for one plan — the tray's own ceiling. */
const AGENT_MAX_PICKED = 12;
const AGENT_BODY_KEYS = ["prompt", "objective", "aesthetic", "assetIds", "productAssetIds", "parentPlanId", "campaign", "stage", "concept", "dealDeliverableId", "briefFilePath", "confirm", "creativeIntentId"];

// The POST handler is a FUNCTION of the body (PR 13) so the replan route below can call it with a
// body composed from a stored row. The POST path itself is unchanged: `req.body` in, the same checks
// in the same order, the same row out (studio.agent.test, "the POST path is byte-identical").
router.post("/studio/agent/plan", ...studioGate, (req: Request, res: Response): Promise<void> =>
  planFromBody(req, res, req.body),
);

async function planFromBody(req: Request, res: Response, body: Request["body"]): Promise<void> {
  // ⚠️ FIRST, before the body is read and before anything is called. Off is a 404 — the surface
  // does not exist — and a 404 here means no model and no search has run.
  if (!agentEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const athleteId = req.athleteId as string;

  // ── Shape ─────────────────────────────────────────────────────────────────────────────────────
  const b = body;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    res.status(400).json({ error: "the body must be an object", field: "body" });
    return;
  }
  const extra = Object.keys(b).find((k) => !AGENT_BODY_KEYS.includes(k));
  if (extra) {
    res.status(400).json({ error: "unknown field", field: extra });
    return;
  }
  // A creative intent (0072): provenance on the plan row. Off ⇒ unknown field. Slice 4 M3: the plan is made from her
  // CONFIRMED interpretation, through the same adapter /studio/preview uses — the objective comes from it and the body
  // may not override it; not hers 404; withdrawn or unconfirmed 409; a format Studio has no executor for 422. A plan
  // never confirms anything itself. It authorizes nothing.
  let creativeIntentId: string | null = null;
  let confirmedObjective: BriefObjective | null = null;
  if (b.creativeIntentId !== undefined) {
    if (!creativeIntentsEnabled()) { res.status(400).json({ error: "unknown field", field: "creativeIntentId" }); return; }
    if (typeof b.creativeIntentId !== "string" || !UUID_RE.test(b.creativeIntentId)) { res.status(400).json({ error: "creativeIntentId must be an intent id", field: "creativeIntentId" }); return; }
    if (b.objective !== undefined) { res.status(400).json({ error: "objective comes from the confirmed creative request, not the body", field: "objective" }); return; }
    const r = await resolveCreativeIntentForBrief(db, athleteId, b.creativeIntentId);
    if ("status" in r) { res.status(r.status).json({ error: r.error, field: r.field }); return; }
    creativeIntentId = r.intent.id;
    confirmedObjective = r.objective;
  }
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt || prompt.length > 2000) {
    res.status(400).json({ error: "say what you want made, in up to 2000 characters", field: "prompt" });
    return;
  }
  const objective = confirmedObjective ?? oneOf(OBJECTIVES, b.objective);
  if (!objective) {
    res.status(400).json({ error: `objective must be one of: ${OBJECTIVES.join(", ")}`, field: "objective" });
    return;
  }
  if (b.aesthetic !== undefined && (typeof b.aesthetic !== "string" || b.aesthetic.length > 200)) {
    res.status(400).json({ error: "aesthetic is a short line of your own, up to 200 characters", field: "aesthetic" });
    return;
  }
  const aesthetic = typeof b.aesthetic === "string" && b.aesthetic.trim() ? b.aesthetic.trim() : undefined;
  if (
    b.assetIds !== undefined &&
    (!Array.isArray(b.assetIds) ||
      b.assetIds.length > AGENT_MAX_PICKED ||
      b.assetIds.some((id: unknown) => typeof id !== "string" || !UUID_RE.test(id)))
  ) {
    res.status(400).json({ error: `assetIds is a list of up to ${AGENT_MAX_PICKED} of your photos`, field: "assetIds" });
    return;
  }
  const picked: string[] = [...new Set<string>((b.assetIds ?? []).map((id: string) => id.toLowerCase()))];
  if (
    b.productAssetIds !== undefined &&
    (!Array.isArray(b.productAssetIds) ||
      b.productAssetIds.length > MAX_PLAN_PRODUCTS ||
      b.productAssetIds.some((id: unknown) => typeof id !== "string" || !UUID_RE.test(id)))
  ) {
    res.status(400).json({
      error: `productAssetIds is a list of up to ${MAX_PLAN_PRODUCTS} of your photos`,
      field: "productAssetIds",
    });
    return;
  }
  // In the order she picked them — the order product items take them in (studio/agent/cast.ts).
  const productIds: string[] = [
    ...new Set<string>((b.productAssetIds ?? []).map((id: string) => id.toLowerCase())),
  ];
  // A regenerate (PR 6, 6a3): the stored plan this one comes from. Checked as HERS below, before
  // anything is called; the new row is its child, version + 1.
  if (b.parentPlanId !== undefined && (typeof b.parentPlanId !== "string" || !UUID_RE.test(b.parentPlanId))) {
    res.status(400).json({ error: "parentPlanId is the id of one of your plans", field: "parentPlanId" });
    return;
  }
  const parentPlanId: string | null = typeof b.parentPlanId === "string" ? b.parentPlanId.toLowerCase() : null;
  // The campaign brief (PR 6, 6b), behind STUDIO_BRAND_PROFILES: with the flag off the field does not
  // exist — an unknown field, exactly as before — and nothing else about the plan changes. With it on,
  // a CampaignBrief, strict (studio/campaign/brief.ts): no athlete id, opaque handles only.
  // ⚠️ MUTATION (studio.agent.test): drop the flag check — "with the flag off a campaign is an unknown
  // field, and nothing is called" reds by name.
  if (b.campaign !== undefined && !brandProfilesEnabled()) {
    res.status(400).json({ error: "unknown field", field: "campaign" });
    return;
  }
  let campaign: import("../studio/campaign/brief").CampaignBrief | undefined;
  if (b.campaign !== undefined) {
    const { validateCampaignBrief } = await import("../studio/campaign/brief.js");
    const { postsReferenceAsset, resolveReferenceAssets } = await import("../studio/campaign/resolveRefs.js");
    // A reference's asset is RESOLVED here (PR 14, R-6), never posted: an id from a client is never trusted.
    // ⚠️ MUTATION (studio.agent.test): drop this — "a client-posted reference assetId is stored" reds by name.
    if (postsReferenceAsset(b.campaign)) {
      res.status(400).json({ error: "a reference's asset is resolved here, never sent", field: "campaign" });
      return;
    }
    const v = validateCampaignBrief(b.campaign);
    if (!v.ok) {
      res.status(400).json({ error: "that campaign brief isn't one I can read", field: "campaign", issues: v.issues });
      return;
    }
    // Its product handle names one of HER picked products, by position — "product_2" is the second.
    const handle = v.brief.product?.ref ?? null;
    const n = handle ? Number(/_(\d+)$/.exec(handle)?.[1] ?? 0) : 0;
    if (handle && (!Number.isInteger(n) || n < 1 || n > productIds.length)) {
      res.status(400).json({ error: "the campaign names a product photo you didn't pick", field: "campaign" });
      return;
    }
    // ref_N → the asset its reading was made from, under her id, ONCE, so the stored row is self-contained
    // (studio/campaign/resolveRefs.ts). Unresolvable stays as it was: the handle and its reading.
    // ⚠️ MUTATION (studio.agent.test): skip this — "ref_N handle reaches compile unresolved" reds by name.
    campaign = await resolveReferenceAssets(athleteId, v.brief);
  }
  // THE CONFIRM STEP'S FLAGS (PR 13): which brief lines were literal and which inferred, with their
  // quotes and becauses — stored on the plan row for display, consumed by nothing here. The same door
  // as `campaign`: an unknown field with STUDIO_BRAND_PROFILES off, and with it on the direction
  // envelope's own flag schema (studio/direction/envelope.ts), strict. ⚠️ MUTATION (studio.agent.test):
  // drop the save of `confirm` — "confirm flags lost at save" reds by name.
  if (b.confirm !== undefined && !brandProfilesEnabled()) {
    res.status(400).json({ error: "unknown field", field: "confirm" });
    return;
  }
  let confirm: import("../studio/direction/envelope").InferenceFlag[] | undefined;
  if (b.confirm !== undefined) {
    const { inferenceFlagSchema, MAX_FLAGS } = await import("../studio/direction/envelope.js");
    const { z } = await import("zod");
    const parsed = z.array(inferenceFlagSchema).max(MAX_FLAGS).safeParse(b.confirm);
    if (!parsed.success) {
      res.status(400).json({ error: "confirm is the list of lines you confirmed", field: "confirm" });
      return;
    }
    confirm = parsed.data;
  }
  // CONCEPT BEFORE COVERAGE (PR 6, 6c): `stage: "concepts"` answers two or three concepts and plans
  // nothing; `concept` is the one she picked, carried into the plan. One or the other.
  if (b.stage !== undefined && b.stage !== "concepts") {
    res.status(400).json({ error: 'stage is "concepts" or absent', field: "stage" });
    return;
  }
  const conceptsOnly = b.stage === "concepts";
  // THE BRAND FLOW'S LINKAGE (PR 6, 6d): the deal deliverable this plan is for, and the brief she
  // uploaded. Both stored on the plan row, never in the brief (decision 4). The deliverable is checked
  // as HERS below, before anything is called; the path must sit under her own prefix.
  if (b.dealDeliverableId !== undefined && (typeof b.dealDeliverableId !== "string" || !UUID_RE.test(b.dealDeliverableId))) {
    res.status(400).json({ error: "dealDeliverableId is one of your deliverables", field: "dealDeliverableId" });
    return;
  }
  const dealDeliverableId: string | null =
    typeof b.dealDeliverableId === "string" ? b.dealDeliverableId.toLowerCase() : null;
  let briefFilePath: string | null = null;
  if (b.briefFilePath !== undefined) {
    const { isHerBriefPath } = await import("../studio/agent/plans.js");
    if (!isHerBriefPath(athleteId, b.briefFilePath)) {
      res.status(400).json({ error: "briefFilePath is a brief you uploaded", field: "briefFilePath" });
      return;
    }
    briefFilePath = b.briefFilePath;
  }
  let concept: import("../studio/agent/types").PlanConcept | undefined;
  if (b.concept !== undefined) {
    const { readConcept } = await import("../studio/agent/concepts.js");
    const read = readConcept(b.concept);
    if (!read || conceptsOnly) {
      res.status(400).json({ error: "concept is one of the concepts you were shown", field: "concept" });
      return;
    }
    concept = read;
  }

  try {
    // ⚠️ DYNAMIC, FOR THE REASON studio/videoRunner.ts gives: cast.ts reaches services/mediaSearch →
    // lib/mediaEmbed, which builds a GCS client AT MODULE LOAD. A static import would build it in
    // every suite that imports this router, and one such suite has already lost its jest worker to
    // exactly that. Loaded here, only once the flag is on and the body is well-formed.
    const { asPick, castPlan, loadCastable } = await import("../studio/agent/cast.js");
    const { assembleLibrary } = await import("../studio/agent/library.js");
    const { brandsToAvoid } = await import("../studio/agent/brands.js");
    const { derivePlan } = await import("../studio/agent/plan.js");
    const { asksForOwnFootage } = await import("../studio/agent/footageAsk.js");
    const { ownsDeliverable, readPlan, savePlan } = await import("../studio/agent/plans.js");
    if (dealDeliverableId && !(await ownsDeliverable(athleteId, dealDeliverableId))) {
      res.status(404).json({ error: "That deliverable isn't one of yours.", field: "dealDeliverableId" });
      return;
    }

    // ── A regenerate's parent is hers, or nothing is called ───────────────────────────────────────
    if (parentPlanId && !(await readPlan(athleteId, parentPlanId))) {
      res.status(404).json({ error: "That plan isn't one of yours.", field: "parentPlanId" });
      return;
    }

    // ── Everything she named is hers, a photograph, and here — or nothing is called ─────────────
    const named = await loadCastable(athleteId, [...picked, ...productIds]);
    if (productIds.some((id) => !named.has(id))) {
      res.status(404).json({ error: "One of those product photos isn't in your library.", field: "productAssetIds" });
      return;
    }
    if (picked.some((id) => !named.has(id))) {
      res.status(404).json({ error: "One of those photos isn't in your library.", field: "assetIds" });
      return;
    }
    // A product is animated from its PHOTO (image-to-video, so her actual product appears). A clip
    // in the products tray is a clip, and has its own kind; refused by name, before any model.
    if (productIds.some((id) => named.get(id)!.mediaType === "clip")) {
      res.status(400).json({ error: "A product is a photo — a video goes in with your photos instead.", field: "productAssetIds" });
      return;
    }

    // ── What the planner is shown: her picks, then photos of her, scenes, clips — three rooms, each
    // capped, assembled in studio/agent/library.ts so the plan eval hands the planner the very same
    // view. What each ref names is held in `byRef`, never sent: a ref is a handle into rows the
    // predicate already loaded under her athlete id, and the caster casts only through that map.
    const { library, byRef, sport } = await assembleLibrary(athleteId, { prompt, picked, productIds, named });

    // ── Step 1, when asked: concepts from her ask, her sport and the campaign — none of the library ──
    // (studio/agent/concepts.ts). The library above is read for her SPORT alone, the identity fact the
    // planner already gets; not one line of it reaches this prompt (concepts.test holds that).
    if (conceptsOnly) {
      const { deriveConcepts } = await import("../studio/agent/concepts.js");
      const concepts = await deriveConcepts(athleteId, {
        prompt,
        objective,
        ...(aesthetic ? { aesthetic } : {}),
        sport,
        ...(campaign ? { campaign } : {}),
      });
      if (!concepts) {
        res.status(502).json({ error: "I couldn't find an idea in that — try saying it another way. Nothing was spent." });
        return;
      }
      res.status(200).json({ concepts });
      return;
    }

    // ── The one model call ────────────────────────────────────────────────────────────────────────
    const plan = await derivePlan(athleteId, {
      prompt,
      objective,
      ...(aesthetic ? { aesthetic } : {}),
      // The sport the plan is for — her sentence's, else her profile's (studio/agent/library.ts).
      sport,
      library,
      products: productIds.map((id, i) => ({
        ref: `p${i + 1}`,
        description: String(named.get(id)!.vision?.description ?? ""),
      })),
      ...(campaign ? { campaign } : {}),
      ...(concept ? { concept } : {}),
      // The deal, for the music's brand rule (PR 10, R-2) — with the campaign, what decides it.
      dealLinked: dealDeliverableId !== null,
    });
    if (!plan) {
      res.status(502).json({ error: "I couldn't turn that into a plan — try saying it another way. Nothing was spent." });
      return;
    }

    // ── Cast ──────────────────────────────────────────────────────────────────────────────────────
    // The caster's own shape for a row she picked — signed, with its beats if it is a clip.
    const given = async (id: string) => asPick(named.get(id)!);
    const cast = await castPlan(athleteId, plan, {
      products: await Promise.all(productIds.map(given)),
      // The photo each item's direction was written about, by the ref the planner named.
      library: byRef,
      // Her picks fill an item whose named photo could not be used, before any search — a pick
      // beats a hit.
      picks: await Promise.all(picked.map(given)),
      // The sportswear brands her sentence did not name: a photo showing one is flagged, and a clean
      // one is preferred where it fits as well (studio/agent/brands.ts).
      avoid: brandsToAvoid(prompt),
      // Her sentence asks for her own footage — the same reading the planner was given (B1) — so a
      // made-here still is refused for every photo kind unless she picked it (S1b).
      ownFootage: asksForOwnFootage(prompt),
    });
    if (cast.castCount === 0) {
      // Only a plan in which NOTHING can be made is refused — one with gaps is shown with its gaps. A
      // b-roll item is made from words, so a plan with any b-roll in it is never refused here.
      res.status(422).json({ error: "Nothing in your library fits this plan yet. Nothing was spent." });
      return;
    }
    // Her picks the tagger did not see her in. After b-roll went to words, a photo without her can be
    // no shot of its own — i2v needs her in frame, and only the products tray is ever a product — so
    // the Agent screen says so by name when one is left out, instead of a line that explains nothing.
    const picksWithoutHer = picked.filter((id) => named.get(id)!.athletePresent !== true);

    logger.info(
      {
        athleteId,
        items: cast.items.length,
        cast: cast.castCount,
        fromWords: cast.items.filter((i) => i.assetId === null && i.uncast === null).length,
        dropped: cast.items.length - cast.castCount,
        // Each left-out item's reason (studio/agent/cast.ts `LeftOut`) — a count alone said nothing
        // when three beats of one clip were refused on device (22 Sep 2026).
        leftOut: cast.leftOut,
        // Each item's cast row by short id, with where it came from — so "which asset was that
        // lookalike" is read off the line, never chased (22 Sep 2026).
        castTo: cast.items.map((i) =>
          i.assetId ? `${i.assetId.slice(0, 8)}:${i.provenance ?? "?"}${i.trim ? `@${i.trim.startSec}-${i.trim.endSec}` : ""}` : null,
        ),
        library: library.length,
        picked: picked.length,
        products: productIds.length,
        flagged: cast.items.filter((i) => i.brandFlag !== null).length,
        swapped: cast.items.filter((i) => i.swapped !== null).length,
      },
      "agent plan cast",
    );
    // The plan is a stored object (PR 6, 6a3): one row, signed urls stripped — the Board seeds from
    // its id and re-opening renders it without a re-plan. A failed write is logged and the plan she
    // paid for is still answered, with no id: losing the plan over its bookkeeping would be worse.
    const look = plan.look ?? null;
    const music = plan.music ?? null;
    let saved: { id: string; version: number } | null = null;
    try {
      saved = await savePlan(athleteId, {
        plan: { items: cast.items, castCount: cast.castCount, picksWithoutHer, gaps: plan.gaps, look, music },
        parentPlanId,
        // The brief it was planned from, as validated — stored on the plan row (0061), never an id.
        brief: campaign ?? null,
        // The concept she picked (6c), or null.
        concept: concept ?? null,
        // The brand flow's linkage (6d), or null.
        dealDeliverableId,
        briefFilePath,
        // What it was planned FROM (PR 13, 0066): her words, her feel, the purpose, the confirm
        // step's flags — written once, here, so a regenerate can start from them.
        prompt,
        aesthetic: aesthetic ?? null,
        objective,
        confirm: confirm ?? null,
        creativeIntentId,
      });
    } catch (err) {
      logger.error({ err, athleteId }, "agent plan not saved");
    }
    // The plan-level choices (PR 6, 6a2): one look over every held photo and one track or bed, each
    // with its reason — or null. Parsed fail-closed (studio/agent/entryPrompt.ts): brand work never
    // carries a track that is not brandSafe.
    res.status(200).json({
      items: cast.items,
      castCount: cast.castCount,
      picksWithoutHer,
      look,
      music,
      gaps: plan.gaps,
      planId: saved?.id ?? null,
      version: saved?.version ?? null,
      parentPlanId,
      concept: concept ?? null,
      dealDeliverableId,
    });
  } catch (err) {
    logger.error({ err, athleteId }, "agent plan failed");
    res.status(500).json({ error: "Couldn't plan that right now. Nothing was spent." });
  }
}

/**
 * A stored plan, re-opened (PR 6, 6a3): the object the planner answered, with fresh urls — no
 * planner, no search, no spend. Hers or a 404: the id alone never reads another athlete's row
 * (studio/agent/plans.ts `readPlan`).
 */
/**
 * A brand brief she uploads (PR 6, 6d; decision 5), mirroring the contract upload
 * (routes/dealContracts.ts): the server mints a path under studio-briefs/<her id>/ and a short-lived
 * signed WRITE url, and the client PUTs the PDF straight to storage — the API never carries the file.
 * Nothing reads it yet: the plan row keeps its path for PR 7's summarize_brief. PDF only. Behind
 * STUDIO_BRAND_PROFILES. Signing needs a service-account key, so this works deployed, not on a laptop's
 * user credentials — the contract upload's own limitation.
 */
const MAX_BRIEF_BYTES = 20 * 1024 * 1024;
router.post("/studio/briefs/upload-url", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  if (!brandProfilesEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const athleteId = req.athleteId as string;
  const { contentType, bytes } = req.body ?? {};
  if (String(contentType ?? "").split(";")[0].trim() !== "application/pdf") {
    res.status(415).json({ error: "A brief is a PDF" });
    return;
  }
  if (typeof bytes === "number" && bytes > MAX_BRIEF_BYTES) {
    res.status(413).json({ error: `Too large — max ${MAX_BRIEF_BYTES / 1048576}MB` });
    return;
  }
  try {
    const { briefPrefix } = await import("../studio/agent/plans.js");
    const { signedAttachmentUploadUrl } = await import("../lib/inboxAttachmentStore.js");
    const briefFilePath = `${briefPrefix(athleteId)}${randomUUID()}.pdf`;
    const uploadUrl = await signedAttachmentUploadUrl(briefFilePath, "application/pdf");
    // One greppable line per upload path (PR 7, Lane E): here the signed url served.
    logger.info({ athleteId, path: "signed-url" }, "brief upload path: signed-url");
    res.status(200).json({ briefFilePath, uploadUrl, contentType: "application/pdf" });
  } catch (err) {
    // No signer in this runtime (ADC without a `client_email` — a laptop, never Cloud Run): a capability
    // answer, not a failure. The client falls back to the raw application/pdf route, which stores under
    // the same prefix and hands summarize_brief the same kind of path. ⚠️ MUTATION (studio.agent.test):
    // answer 500 here — "signer absent: 501 signing_unavailable, never a 500" reds by name.
    if ((err as { name?: string })?.name === "SigningError") {
      logger.warn({ athleteId, path: "raw-fallback" }, "brief upload-url: no signer in this runtime — the raw route serves");
      res.status(501).json({ error: "signing_unavailable", fallback: "raw" });
      return;
    }
    logger.error({ err, athleteId }, "brief upload-url mint failed");
    res.status(500).json({ error: "Couldn't start the upload" });
  }
});

router.get("/studio/agent/plans/:id", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  if (!agentEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const athleteId = req.athleteId as string;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "No such plan" });
    return;
  }
  try {
    const { readPlan, resignItems } = await import("../studio/agent/plans.js");
    const row = await readPlan(athleteId, id.toLowerCase());
    if (!row) {
      res.status(404).json({ error: "No such plan" });
      return;
    }
    const body = row.plan as import("../studio/agent/plans").StoredPlanBody;
    res.status(200).json({
      planId: row.id,
      version: row.version,
      parentPlanId: row.parent_plan_id,
      items: await resignItems(athleteId, body.items),
      castCount: body.castCount,
      picksWithoutHer: body.picksWithoutHer,
      gaps: body.gaps,
      look: body.look,
      music: body.music,
      brief: row.brief,
      concept: row.concept,
      dealDeliverableId: row.deal_deliverable_id,
      // What it was planned FROM (PR 13, 0066) — all null on a pre-0066 row, and the client then
      // inherits exactly as it did before (agentLogic `inheritFromStoredPlan`).
      prompt: row.prompt,
      aesthetic: row.aesthetic,
      objective: row.objective,
      confirm: row.confirm,
      createdAt: row.created_at,
    });
  } catch (err) {
    logger.error({ err, athleteId }, "agent plan read failed");
    res.status(500).json({ error: "Couldn't open that plan right now." });
  }
});

/**
 * RE-PLAN A STORED PLAN FROM WHAT IT REMEMBERS (PR 13, R-3). POST /studio/agent/plans/:id/replan
 * plans the row's CHILD (version + 1, parent_plan_id = :id) from the row itself: her words, her feel,
 * the purpose, the brief it was planned from, her concept, her product photos (the plan's product
 * items, in order), the brief file and the deal. Anything posted overrides the stored value; a posted
 * `campaign` takes the existing posted-campaign path unchanged. The body is otherwise the plan body,
 * minus `parentPlanId` (the parent is the path) and `stage` (a re-plan plans).
 *
 * TENANCY: the row is read under HER athlete id first (studio/agent/plans.ts `readPlan`) — not hers
 * is a 404 before the body is read and before anything is called. ⚠️ MUTATION (studio.agent.test):
 * read the parent by id alone — "replan plans another athlete's stored brief" reds by name.
 *
 * A PRE-0066 ROW remembers no words and no purpose. It is never planned from a server-invented line:
 * with neither stored nor posted, this is a 400 naming the field, and the client falls back to the
 * posted-campaign re-plan it made before this route existed (agentLogic `inheritFromStoredPlan`).
 * ⚠️ MUTATION (studio.agent.test): fall back to a line here — "an old row with null objective
 * re-plans with no objective" reds by name.
 */
const REPLAN_BODY_KEYS = AGENT_BODY_KEYS.filter((k) => k !== "parentPlanId" && k !== "stage");

router.post("/studio/agent/plans/:id/replan", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  if (!agentEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const athleteId = req.athleteId as string;
  const id = String(req.params.id ?? "").toLowerCase();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "No such plan" });
    return;
  }
  const b = req.body ?? {};
  if (typeof b !== "object" || Array.isArray(b)) {
    res.status(400).json({ error: "the body must be an object", field: "body" });
    return;
  }
  const extra = Object.keys(b).find((k) => !REPLAN_BODY_KEYS.includes(k));
  if (extra) {
    res.status(400).json({ error: "unknown field", field: extra });
    return;
  }
  let row: import("../../shared/schema").StudioPlan | null;
  try {
    const { readPlan } = await import("../studio/agent/plans.js");
    row = await readPlan(athleteId, id);
  } catch (err) {
    logger.error({ err, athleteId }, "agent replan read failed");
    res.status(500).json({ error: "Couldn't plan that right now. Nothing was spent." });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "That plan isn't one of yours.", field: "parentPlanId" });
    return;
  }
  // What the row remembers, only where it remembers it; a null column contributes no field, so a
  // posted value is the only value and a missing one is refused by the plan body's own checks below.
  const stored = row.plan as import("../studio/agent/plans").StoredPlanBody;
  const productAssetIds = [
    ...new Set(stored.items.flatMap((i) => (i.kind === "product" && i.assetId ? [i.assetId] : []))),
  ];
  const remembered: Record<string, unknown> = {
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.objective !== null ? { objective: row.objective } : {}),
    ...(row.aesthetic !== null ? { aesthetic: row.aesthetic } : {}),
    ...(productAssetIds.length ? { productAssetIds } : {}),
    // The stored brief, minus the assets the parent resolved (PR 14): the child re-resolves on its own save.
    ...(row.brief !== null
      ? { campaign: (await import("../studio/campaign/resolveRefs.js")).stripReferenceAssets(row.brief) }
      : {}),
    ...(row.concept !== null ? { concept: row.concept } : {}),
    ...(row.deal_deliverable_id !== null ? { dealDeliverableId: row.deal_deliverable_id } : {}),
    ...(row.brief_file_path !== null ? { briefFilePath: row.brief_file_path } : {}),
    ...(row.confirm !== null ? { confirm: row.confirm } : {}),
  };
  const composed = { ...remembered, ...b, parentPlanId: id };
  // The two fields a plan cannot be made without, named before anything is called: a pre-0066 row
  // has neither, and the client's fallback path is the answer, not a line of ours.
  for (const field of ["prompt", "objective"] as const) {
    if (composed[field] === undefined) {
      res.status(400).json({
        error: `This plan was saved before it remembered its ${field === "prompt" ? "words" : "purpose"} — say it again.`,
        field,
      });
      return;
    }
  }
  await planFromBody(req, res, composed);
});

router.post("/studio/generate", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  const previewId = (req.body ?? {})?.previewId;
  if (typeof previewId !== "string" || !UUID_RE.test(previewId)) {
    res.status(400).json({ error: "generate needs the previewId from a cost check", field: "previewId" });
    return;
  }

  try {
    // Tenancy is in the predicate: another athlete's previewId resolves to nothing, which is the
    // same 404 a nonexistent one gets. A different answer would confirm their preview exists.
    const stored = await loadPreview(athleteId, previewId);
    if (!stored) {
      res.status(404).json({ error: "That cost check isn't yours or has expired", field: "previewId" });
      return;
    }

    const refusal = approvalRefusal(stored);
    if (refusal) {
      res.status(409).json({ error: refusal, field: "previewId" });
      return;
    }

    // Before runStudioGeneration, so a disagreement opens no job row and leaves the approval unclaimed.
    const changed = nativeRecheck(stored.brief, { athleteId, previewId: stored.id });
    if (changed) {
      res.status(409).json({ error: changed, field: "previewId" });
      return;
    }

    const out = await runStudioGeneration(
      {
        athleteId,
        brief: stored.brief,
        previewId: stored.id,
        // Read from OUR row. This is the whole point of the table.
        approvedCostUsd: stored.approvedCostUsd as number,
      },
      refusalFor(stored.brief),
    );

    // `spent: false` means an identical tap already bought this — same jobId, one charge. A 200 with
    // the winner's job is the honest answer: from the athlete's side her Generate worked.
    //
    // Assets are read back and shaped through the SAME path the job route uses, so the result view
    // gets one shape from both doors, with signed urls and the legal next moves already on it.
    // THREE OUTCOMES, and they are genuinely different things:
    //   queued          — a video job is on the runner's queue. Nothing generated yet; poll the job.
    //   succeeded       — an image ran inline and its drafts are in `assets`.
    //   already_running — an identical tap already bought this. Same jobId, one charge.
    const status = out.queued
      ? "queued"
      : out.spent
        ? "succeeded"
        : "already_running";
    res.status(200).json({
      jobId: out.jobId,
      status,
      // quality-scrappy piece 5: an inline image's gate is recorded before this answer (studio/generate.ts).
      assets: await withGates(
        await shapeAssets(await assetsForJob(out.jobId, athleteId)),
        athleteId,
        new Date(),
      ),
      // A PARTIAL edit: some of what she asked for landed and some did not. Named, because "we
      // changed two of the three things" is only honest if it says which one is missing — and
      // because the retry she needs is a new edit for that one target, not the whole instruction
      // again. Absent entirely on a clean run.
      ...(out.failedTargets?.length ? { failedTargets: out.failedTargets } : {}),
    });

    // Kick the runner so a clip starts now rather than at the next scheduled tick. AFTER the
    // response, unawaited and swallowed: the job is durably queued, so a failed kick costs latency
    // and never the job. Mirrors workflow.kick's reason for existing.
    if (out.queued) {
      if (runsBackgroundWork()) void import("../studio/videoRunner")
        .then(({ videoTick }) => videoTick())
        .catch((err) =>
          logger.warn(
            { err, jobId: out.jobId },
            "video kick failed — the scheduled tick will pick it up",
          ),
        );
    }
  } catch (err) {
    if (err instanceof GenerationError) {
      // A held capability (video, today) is not her fault and not a failure of her brief.
      if (err.code === "unsupported_task") {
        res.status(503).json({ error: err.message, field: "deliverable", unavailable: true });
        return;
      }
      if (err.code === "invalid_input") {
        res.status(409).json({ error: err.message, field: "previewId" });
        return;
      }
    }
    logger.error({ err, athleteId, previewId }, "studio generate failed");
    res.status(500).json({ error: "Couldn't generate that" });
  }
});

// ─── GET /studio/jobs/:jobId ────────────────────────────────────────────────────────────────────
//
// The watcher's read: pending → queued → running → succeeded/failed, plus whatever the job has
// produced so far.
//
// POLLING THIS NEVER STARTS, RESUMES OR ADVANCES WORK — that is still true, and it is worth keeping
// true. For an IMAGE the generation already happened inline in the request above, so this is pure
// reconnect-and-refresh. For a VIDEO the work is done by the leased runner
// (server/studio/videoRunner.ts, driven by /api/internal/studio-video-tick); this route only reports
// what that runner has got to. Making the client's poll drive execution would put a paid provider
// call behind an unauthenticated-in-effect retry loop, which is the whole reason it does not.
router.get("/studio/jobs/:jobId", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const jobId = req.params.jobId;
  if (!UUID_RE.test(jobId)) { res.status(404).json({ error: "No such job" }); return; }

  try {
    const job = await readJob(athleteId, jobId);
    // Not-found and not-yours are the same answer, deliberately — see resolveSource().
    if (!job) { res.status(404).json({ error: "No such job" }); return; }

    res.json({
      jobId: job.id,
      status: job.status,
      mode: job.mode,
      deliverable: job.deliverable,
      model: job.model,
      // What it was QUOTED. `cost_basis` is carried, never recomputed, so an estimate is never
      // rendered as a billed figure.
      quotedUsd: job.cost_estimated_usd == null ? null : Number(job.cost_estimated_usd),
      costBasis: job.cost_basis,
      error: job.last_error,
      startedAt: job.started_at?.toISOString() ?? null,
      completedAt: job.completed_at?.toISOString() ?? null,
      // quality-scrappy piece 5: a clip's gate lands after `succeeded` (the runner checks it past succeedJob), so a
      // gated read says "pending" until it does, and a watcher keeps polling instead of presenting it as done.
      assets: await withGates(
        await shapeAssets(await assetsForJob(jobId, athleteId)),
        athleteId,
        job.completed_at ?? null,
      ),
    });
  } catch (err) {
    logger.error({ err, athleteId, jobId }, "studio job read failed");
    res.status(500).json({ error: "Couldn't read that job" });
  }
});

// ─── POST /studio/stitch ────────────────────────────────────────────────────────────────────────
//
// Queue a timeline. Answers 202 with an id to poll — never the finished file, because joining clips
// is an ffmpeg run that outlives a request, and a request held open with no bytes flowing is the
// shape Google's load balancer drops.
//
// NOT GATED ON STUDIO_VIDEO_ENABLED, deliberately: that flag guards one seam — the paid
// `video.generate` task in studio/generate.ts — and assembly is reachable with generation dark.
// studioGate (STUDIO_ENABLED + auth + athlete) is the whole gate, as it is for every route here.
//
// ⚠️  THIS SPENDS NOTHING. No preview, no approval, no cost row: studio/video/stitch.ts is one
// ffmpeg call and 0057 gives studio_stitch_jobs no column that could express a charge. Which is
// why there is no `previewId` in the body and must never be one — a stitch is not a purchase.
//
// THE REFUSALS HAPPEN HERE, BEFORE A ROW EXISTS. Queue-then-fail would be honest and useless: she
// would wait for a runner to tell her something the request already knew. The caps are named in
// full ("up to 12 clips, 664 MB of video and 3:00 of footage") rather than reporting only the wall
// she hit, so the answer describes what a legal timeline is.
router.post("/studio/stitch", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;

  // Shape first, and nothing from the wire reaches an ffmpeg argv: `target` is a NAME from an
  // allowlist, expanded server-side at run time. See studio/video/spec.ts.
  const spec = parseStitchSpec(req.body);
  if (isRefusal(spec)) {
    res.status(400).json({ error: spec.error, field: spec.field });
    return;
  }

  try {
    // THE COMPOSER'S PLAN ID (PR 15.1, D-2): a client-supplied id is never stored until it is shown to
    // be hers — not-hers and not-found are one 404, as on music/suggest. Present only with STUDIO_COMPOSER
    // on (the parser ignores the record otherwise), so this read never runs with the flag off.
    // ⚠️ MUTATION (studio.stitch.test): skip this — "a plan id that is not hers is stored on a stitch" reds.
    if (spec.composer?.planId) {
      const { readPlan } = await import("../studio/agent/plans.js");
      if (!(await readPlan(athleteId, spec.composer.planId))) {
        res.status(404).json({ error: "That plan isn't one of yours.", field: "composer.planId" });
        return;
      }
    }

    // THE SAME resolve the runner uses, with the athlete off the REQUEST here and off the CLAIMED
    // ROW there. Not-yours and not-found are one answer, so a spec cannot probe another athlete's
    // library. A parallel validation would be a second source of truth; there is exactly one.
    // Her sound video, if she chose one, goes through the SAME resolve with the same athlete and is
    // charged its real bytes in the same budget — see resolveTimeline. Not-hers and not-found are
    // one answer for it too.
    // The POSITIONS, not bare ids: a position with `stillSec` is one of her photos and is resolved
    // through the photo predicate (materialize.ts resolveStills), never the video one.
    const resolved = await resolveTimeline(
      athleteId,
      spec.clips,
      spec.bedAssetId,
    );
    assertTimelineFits(spec.clips, resolved);

    const stitchId = await queueStitch(athleteId, spec);
    res.status(202).json({
      stitchId,
      status: "queued",
      // Handed back on every answer so the assembly UI can state the ceiling BEFORE she hits it.
      limits: stitchLimits(),
    });

    // Kick the runner so a timeline starts now rather than at the next scheduled tick. AFTER the
    // response, unawaited and swallowed: the job is durably queued, so a failed kick costs latency
    // and never the job. The tick itself returns without waiting for ffmpeg, and its own capacity
    // guard is what stops this racing the scheduler into two workspaces on one instance.
    void import("../studio/stitchRunner")
      .then(({ stitchTick }) => stitchTick())
      .catch((err) =>
        logger.warn({ err, stitchId }, "stitch kick failed — the scheduled tick will pick it up"),
      );
  } catch (err) {
    if (err instanceof MaterializeError) {
      // not_found covers "isn't yours" by construction — see resolveClips.
      const status = err.code === "not_found" ? 404 : 409;
      // Pointed at the control she has to change: her sound video is under Music, not on the track.
      res.status(status).json({ error: err.message, field: err.subject === "sound" ? "bedAssetId" : "clips" });
      return;
    }
    logger.error({ err, athleteId }, "studio stitch queue failed");
    res.status(500).json({ error: "Couldn't start that" });
  }
});

// ─── GET /studio/stitch/beds/:name/preview ──────────────────────────────────────────────────────
//
// A short-lived link so she can LISTEN to a track before she lays it under a video. Without it the
// picker is a list of names, and the first time she hears "Pantheon" is after the stitch.
//
// The name is the whole input and it is checked against the allowlist (studio/video/beds.ts): this
// can only ever sign one of the product's own objects under studio/beds/ or studio/tracks/. Nothing of hers is read,
// so there is no athlete to scope by — the gate is that she is signed in to the Studio at all.
// Signed ON DEMAND rather than put in /options: that route is static and cached for the session,
// and a signed URL is neither.
//
// Three segments, so it cannot collide with /studio/stitch/:stitchId whatever order they are in.
router.get("/studio/stitch/beds/:name/preview", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const path = bedPreviewPath(req.params.name);
  if (!path) { res.status(404).json({ error: "No such track" }); return; }
  try {
    res.json({ url: await signedUrl(path, BED_PREVIEW_TTL_MS), expiresInSec: BED_PREVIEW_TTL_MS / 1000 });
  } catch (err) {
    logger.error({ err, bed: req.params.name }, "studio bed preview failed");
    res.status(500).json({ error: "We couldn't load that track" });
  }
});

// ─── GET /studio/stitch/sound/:assetId/preview ──────────────────────────────────────────────────
//
// The same listen button a curated track has, for the sound of one of HER videos — so she can hear
// what she is about to lay under the timeline before she does.
//
// ⚠️  UNLIKE the curated one, this reads something of hers, so it is athlete-scoped: the id goes
// through resolveTimeline → resolveClips with the athlete off the REQUEST, exactly as it will when
// the stitch is queued. Another athlete's video and one that does not exist are one 404. A photo is
// a 409. It never signs a path that did not come off HER row.
router.get("/studio/stitch/sound/:assetId/preview", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const assetId = req.params.assetId;
  if (!UUID_RE.test(assetId)) { res.status(404).json({ error: "No such video" }); return; }
  try {
    const [video] = await resolveTimeline(athleteId, [assetId]);
    res.json({ url: await signedUrl(video.gcsPath, BED_PREVIEW_TTL_MS), expiresInSec: BED_PREVIEW_TTL_MS / 1000 });
  } catch (err) {
    if (err instanceof MaterializeError) {
      res.status(err.code === "not_found" ? 404 : 409).json({ error: err.code === "not_found" ? "No such video" : err.message });
      return;
    }
    logger.error({ err, athleteId }, "studio sound preview failed");
    res.status(500).json({ error: "We couldn't load that video's sound" });
  }
});

// ─── POST /studio/stitch/caption-preview ────────────────────────────────────────────────────────
//
// Draws ONE caption and hands back the picture — the same band, from the same function
// (studio/video/captionRender.ts), that the runner burns in. So what she sees over the preview is
// not an approximation of the caption: it IS the caption, placed by the same `y`.
//
// Why not draw it on the client: the renderer breaks long words and SHRINKS the text until it is
// two lines, by measuring. A client-side <Text> cannot know which size that lands on, so its
// preview would be most wrong exactly where it matters — long captions.
//
// ⚠️  THIS SPENDS NOTHING AND STORES NOTHING. No database, no provider, no job row, no asset ids:
// satori and sharp on local CPU, a few milliseconds. `parseCaption` is THE SAME parser the queue
// uses, so a caption this will draw is a caption POST /studio/stitch will accept, and the reverse.
// The words are not logged.
router.post("/studio/stitch/caption-preview", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isTargetName(body.target)) {
    res.status(400).json({ error: `A stitch needs a shape: ${Object.keys(STITCH_TARGETS).join(", ")}`, field: "target" });
    return;
  }
  const caption = parseCaption(body.caption, "caption");
  if ("error" in caption) {
    res.status(400).json({ error: caption.error, field: caption.field });
    return;
  }
  try {
    const frame = STITCH_TARGETS[body.target];
    const band = await renderCaptionBand(caption, frame);
    res.json({
      // A data URI rather than a second authed GET: an <Image> cannot send the bearer token on web,
      // and the band is 5–15 KB.
      uri: `data:image/png;base64,${band.png.toString("base64")}`,
      // FRACTIONS of the frame, so the client places it in a box of any size with no arithmetic
      // about 1080 or 1920 of its own.
      top: band.y / frame.height,
      height: band.height / frame.height,
    });
  } catch (err) {
    logger.error({ err, athleteId: req.athleteId }, "studio caption preview failed");
    res.status(500).json({ error: "We couldn't draw that caption" });
  }
});

// ─── GET /studio/stitch/options ─────────────────────────────────────────────────────────────────
//
// What a timeline may be, and what it may be scored with. Static: no database, no model, no spend.
//
// ⚠️  DECLARED BEFORE /studio/stitch/:stitchId ON PURPOSE. Express matches in order, and "options"
// is not a uuid — so with the parameterised route first this would 404 through its UUID_RE guard
// and the mistake would look like a missing feature rather than a routing bug.
//
// It exists because the alternative is worse: the bed list would otherwise have to be duplicated
// in the client to render a picker, and a duplicated allowlist is one that drifts. The caps ride
// along so the assembly UI can state the ceiling before she builds a timeline that breaks it.
router.get("/studio/stitch/options", ...studioGate, async (_req: Request, res: Response): Promise<void> => {
  // `captions` is the closed vocabulary AND the geometry the client draws its preview from — served
  // rather than hardcoded there, for the reason the limits are: two copies is two rules.
  res.json({ limits: stitchLimits(), ...bedCatalog(), captions: captionCatalog() });
});

// ─── POST /studio/stitch/music/suggest ──────────────────────────────────────────────────────────
//
// The Board's "Suggested" track for the words on her board (studio/music/suggest.ts): her row
// sentences and the board's objective in, the recommender's top pick and its one-line reason out.
// Pure — no database, no model, no spend, nothing stored. Brand work is decided fail-closed off the
// objective, so a track that is not brandSafe is never offered to one. POST because the body is her
// prose; three segments, so it cannot collide with /studio/stitch/:stitchId.
router.post("/studio/stitch/music/suggest", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  // Brand-ness off HER STORED PLAN (PR 10, R-2): its brief and its deal, the same derivation the planner
  // used — never the purpose chip while either exists. A plan id that is not hers is not found.
  const athleteId = req.athleteId as string;
  const planId = typeof req.body?.planId === "string" && UUID_RE.test(req.body.planId) ? req.body.planId.toLowerCase() : null;
  let brand: ReturnType<typeof brandSignalsFrom> | undefined;
  if (planId) {
    const { readPlan } = await import("../studio/agent/plans.js");
    const row = await readPlan(athleteId, planId);
    if (!row) { res.status(404).json({ error: "That plan isn't one of yours." }); return; }
    brand = brandSignalsFrom(row.brief, row.deal_deliverable_id !== null);
  }
  const out = suggestMusic(req.body, undefined, brand);
  if ("error" in out) { res.status(400).json({ error: out.error }); return; }
  res.json(out);
});

// ─── POST /studio/stitch/caption/suggest ────────────────────────────────────────────────────────
//
// A caption she can start from, by rule (studio/video/captionSuggest.ts; PR 15, R-5): the Board's row
// sentences in, the first sentence's leading clause out — bounded by the stitch spec's own caption
// rule, never a model, never stored, $0. Behind STUDIO_COMPOSER: off, the door is not there (404).
// POST because the body is her prose; three segments, so it cannot collide with /studio/stitch/:id.
// ⚠️ MUTATION (studio.caption.test): answer with the flag off — "composer renders with STUDIO_COMPOSER
// off" reds by name.
router.post("/studio/stitch/caption/suggest", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const { composerEnabled } = await import("../studio/config.js");
  if (!composerEnabled()) { res.status(404).json({ error: "Not found" }); return; }
  const { suggestCaption } = await import("../studio/video/captionSuggest.js");
  const out = suggestCaption(req.body);
  if ("error" in out) { res.status(400).json({ error: out.error }); return; }
  res.json(out);
});

// ─── GET /studio/stitch/clips ───────────────────────────────────────────────────────────────────
//
// The clips she can put on a timeline — Studio's own list, because the shared one hid hers.
//
// ─── WHY NOT GET /me/media?type=videos, WHICH THE PICKER READ UNTIL NOW ─────────────────────────
//
// That route orders by `posted_at DESC NULLS LAST, id DESC` and serves 24. A generated clip has no
// `posted_at` — nothing of hers was ever POSTED — so every clip made in Studio sorts after every
// dated video, and among themselves by a random uuid. Measured 2026-09-21 on one athlete: 31
// generated clips, 2 uploads, and 9 of the 31 were not offered at all — which 9 being random, so a
// clip she had just made on the Board could be the one missing. Asking for page 2 would not reach
// them either: a page that ends on an undated row hands back a null cursor.
//
// The shared route is not ours to re-sort (it also serves the photo picker, with its own cursor),
// and stamping `posted_at` on generated rows would change what the column means for every reader —
// `searchMedia`'s recency among them. So the picker gets a list of its own.
//
// ─── THE ORDER: EACH ROW BY ITS OWN DATE ────────────────────────────────────────────────────────
//
// `COALESCE(posted_at, ingested_at)`: an upload by its capture date (what `postedAtFrom` stores), a
// synced post by when it was posted, a generated clip by when it was recorded. So what she just
// made sits at the top, and an old shoot sits where its date puts it.
//
// ─── ELIGIBILITY IS THE STITCH'S OWN ────────────────────────────────────────────────────────────
//
// Hers, stored, top-level, not deleted, a stitchable type (the SAME list `resolveClips` refuses
// against), with mp4 bytes behind `gcs_path` — `herClip` (studio/photoPredicate.ts), which the shared
// picker's GET /studio/media reads too. An Instagram video row that holds only its poster is not a
// clip — offering it would queue a stitch the server refuses at resolve time. That last rule used to
// be a client-side filter applied AFTER the page of 24 was cut, which is how a poster-only row could
// take a slot and then vanish.
//
// Declared before /studio/stitch/:stitchId, for the reason /options is.
export const STITCH_CLIPS_LIMIT = 60; // the newest 60; a timeline holds at most 12 (materialize.ts maxClips)

router.get("/studio/stitch/clips", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  try {
    const rows = await db
      .select({
        id: mediaAssets.id,
        gcs_path: mediaAssets.gcs_path,
        gcs_thumb_path: mediaAssets.gcs_thumb_path,
        origin: mediaAssets.origin,
        duration_seconds: mediaAssets.duration_seconds,
        duration_seconds_precise: mediaAssets.duration_seconds_precise,
      })
      .from(mediaAssets)
      .where(herClip(athleteId))
      .orderBy(sql`COALESCE(${mediaAssets.posted_at}, ${mediaAssets.ingested_at}) DESC NULLS LAST`, desc(mediaAssets.id))
      .limit(STITCH_CLIPS_LIMIT);

    const clips = await Promise.all(
      rows.map(async (r) => ({
        assetId: r.id,
        videoUrl: await signedUrl(r.gcs_path!),
        // The poster when one has been made — and null until then, never the mp4: an <Image> handed
        // a video url is an empty tile (the rule routes/media.ts states for the same column).
        posterUrl: r.gcs_thumb_path ? await signedUrl(r.gcs_thumb_path) : null,
        durationSec: r.duration_seconds ?? null,
        // NULL IS AN ANSWER — "nothing measured this row" — and is served as null, not as the integer.
        durationPreciseSec: r.duration_seconds_precise ?? null,
        // The column's word. The client owns what she reads ("Made here", "Uploaded").
        origin: r.origin,
      })),
    );
    res.json({ clips });
  } catch (err) {
    logger.error({ err, athleteId }, "stitch clip list failed");
    res.status(500).json({ error: "Couldn't load your clips" });
  }
});

// ─── GET /studio/stitch/stills ──────────────────────────────────────────────────────────────────
//
// The photos she can HOLD on a timeline — Studio's own list, for the reasons /stitch/clips is one.
//
// GET /me/media?type=photos would have handed the picker three defects at once: it serves one page of
// 24 and the pickers never ask for the next (docs/studio-agent-open-cards.md card 3); it sorts
// `posted_at DESC NULLS LAST`, so a photo made in Studio (no `posted_at`) sorts after every dated
// photo and can fall off the page; and it offers HEIC, which the stitch then refuses. The shared
// route is not ours to change. This list inherits none of the three.
//
// ELIGIBILITY IS THE STILL RESOLVER'S OWN: studio/photoPredicate.ts (hers · stored · not deleted ·
// top-level · a photograph), bytes behind `gcs_path`, and a type the runner can turn into a frame
// (STILL_CONTENT_TYPES). So nothing offered here is refused at the door. Ordered each row by its own
// date, as the clips are.
//
// Declared before /studio/stitch/:stitchId, for the reason /options is.
export const STITCH_STILLS_LIMIT = 60; // the newest 60; a timeline holds at most 12 positions

router.get("/studio/stitch/stills", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  try {
    const rows = await db
      .select({
        id: mediaAssets.id,
        gcs_path: mediaAssets.gcs_path,
        gcs_thumb_path: mediaAssets.gcs_thumb_path,
        origin: mediaAssets.origin,
      })
      .from(mediaAssets)
      .where(
        herPhoto(
          athleteId,
          isNotNull(mediaAssets.gcs_path),
          inArray(mediaAssets.content_type, STILL_CONTENT_TYPES),
        ),
      )
      .orderBy(sql`COALESCE(${mediaAssets.posted_at}, ${mediaAssets.ingested_at}) DESC NULLS LAST`, desc(mediaAssets.id))
      .limit(STITCH_STILLS_LIMIT);

    const stills = await Promise.all(
      rows.map(async (r) => ({
        assetId: r.id,
        // The full photo, for the preview she holds it in. The thumbnail, for the tiles.
        imageUrl: await signedUrl(r.gcs_path!),
        thumbUrl: await signedUrl(r.gcs_thumb_path ?? r.gcs_path!),
        // The column's word. The client owns what she reads, as for the clips.
        origin: r.origin,
      })),
    );
    res.json({ stills });
  } catch (err) {
    logger.error({ err, athleteId }, "stitch still list failed");
    res.status(500).json({ error: "Couldn't load your photos" });
  }
});

// ─── GET /studio/media ──────────────────────────────────────────────────────────────────────────
//
// The shared Studio picker's list (client/components/studio/StudioMediaPicker.tsx): the Board's
// photos, the Agent's photos, products and videos, the Video tab's clips and stills. Its first page
// is the compact strip; "View more" pages through the rest with `nextCursor`.
//
//   ?kind=photos|clips  &still=1  &origin=upload,generated,synced  &limit=1..60  &cursor=…
//   …&ids=<uuid>,…  — a lookup through the same predicate, never paged (quality-scrappy, Investigation 12)
//
// Everything that decides WHAT is offered and IN WHAT ORDER is studio/mediaList.ts — our own
// predicates (herPhoto / herClip) narrowed by the mount, and a keyset cursor that walks through the
// undated tail and carries microseconds. Read its header before changing either. /me/media is shared
// and untouched; this inherits none of its three defects (no deleted-row filter, posted_at-only order,
// a cursor that loses an undated row).
router.get("/studio/media", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const q = parseMediaQuery(req.query);
  if ("error" in q) { res.status(400).json(q); return; }
  const limit = parseMediaLimit(req.query.limit);
  if (typeof limit !== "number") { res.status(400).json(limit); return; }
  const cursor = decodeMediaCursor(req.query.cursor);
  // PR 12: a cursor from the other order (ranked vs by date — mediaList.ts `cursorFits`) is the same 400.
  if (cursor === null || (cursor && !cursorFits(cursor, q.kind))) { res.status(400).json({ error: "that cursor isn't one this list handed out", field: "cursor" }); return; }
  // quality-scrappy (Investigation 12): `ids` asks whether THIS mount can use these rows — the same predicate, hers
  // only, never paged. A row that is not hers, or that the mount cannot hold, is simply not in the answer.
  const byId = parseMediaIds(req.query.ids);
  if (byId !== undefined && !Array.isArray(byId)) { res.status(400).json(byId); return; }
  if (byId && cursor) { res.status(400).json({ error: "ids is a lookup, not a page — it takes no cursor", field: "ids" }); return; }

  try {
    if (byId) {
      const found = await db
        .select(MEDIA_COLUMNS)
        .from(mediaAssets)
        .where(mediaPredicate(athleteId, q, inArray(mediaAssets.id, byId)))
        .orderBy(...mediaOrderFor(q.kind));
      res.json({ items: await Promise.all(found.map((r) => shapeMediaRow(q.kind, r))), nextCursor: null });
      return;
    }
    const rows = await db
      .select(MEDIA_COLUMNS)
      .from(mediaAssets)
      .where(mediaPredicate(athleteId, q, ...(cursor ? [mediaAfter(cursor)] : [])))
      .orderBy(...mediaOrderFor(q.kind))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = await Promise.all(page.map((r) => shapeMediaRow(q.kind, r)));
    res.json({
      items,
      nextCursor: rows.length > limit && last
        ? encodeMediaCursor({ k: last.sortKey, id: last.id, ...(rankedList(q.kind) ? { h: Number(last.rank) } : {}) })
        : null,
    });
  } catch (err) {
    logger.error({ err, athleteId, kind: q.kind }, "studio media list failed");
    res.status(500).json({ error: "Couldn't load your library" });
  }
});

// ─── GET /studio/media/search ───────────────────────────────────────────────────────────────────
//
// Her words → her library, closest first: ?q=…&kind=photos|clips&still=1&origin=… — the browse list's
// own filters, through the browse list's own predicate, so a search can never offer what browsing
// would not.
//
// ─── ⚠️  RANKED HERE, NOT BY searchMedia (decided 21 Sep 2026) ─────────────────────────────────
//
// searchMedia (services/mediaSearch.ts) is shared and is not changed. It is the wrong ranker for a
// person choosing by eye, for three reasons, each of which decides part of this route:
//
//   1. IT CUTS BEFORE WE CAN FILTER. It returns a fixed top k and knows nothing of media_type,
//      deleted_at or origin, so every filter a mount needs would apply AFTER the cut and shrink a fixed
//      page. An uploads-only Board search on a library of synced posts could come back near-empty while
//      her uploads sat just below the cut. So the predicate runs FIRST, and only what passed is ranked.
//   2. IT FAILS QUIETLY INTO A POPULARITY LIST. embedText returns null on failure, and searchMedia then
//      ranks by hero score and views — a list with nothing to do with her words, served as an answer to
//      them. So a failed or timed-out embed is a 503 with a sentence, never a list.
//   3. 30% OF ITS SCORE IS NOT HER WORDS. 0.7·similarity + 0.3·(hero, views) suits curation, where her
//      best-performing shot should win. For a person looking for "the red dress", a popular post that is
//      not the red dress must not outrank one that is. So the score is similarity and nothing else.
//
// One embedText, then cosine over the eligible rows' stored embeddings — studio/agent/cast.ts
// `rankWithoutHer`'s shape, for the same kind of reason. A row with no embedding ranks after every row
// with one, newest first among themselves. Untagged rows are offered: she is choosing by eye.
//
// ─── COST, AND WHY THERE IS NO CURSOR ───────────────────────────────────────────────────────────
//
// At most ONE embedText (Vertex multimodalembedding@001, one text instance) per request, and none when
// nothing is eligible; the picker sends one request per SUBMITTED search, never per keystroke. No
// generation, so no cap. No price for a text embed is recorded in this repo — the nearest figure is
// ~$0.001 for an IMAGE embed (docs/plans/studio-generation-identity-plan.md). Reads every eligible
// row's stored embedding, as searchMedia and rankWithoutHer already do.
//
// The top MEDIA_SEARCH_LIMIT (60), `nextCursor: null` always: nothing caches an embedding, so page two
// would be a second embed. Browsing pages; a search is for finding.
//
// Her words are never logged — counts only, the agent route's rule. mediaEmbed is imported
// DYNAMICALLY, for the reason POST /studio/agent/plan gives: it builds a GCS client at module load.
router.get("/studio/media/search", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const q = parseMediaQuery(req.query);
  if ("error" in q) { res.status(400).json(q); return; }
  const words = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (words.length < 2 || words.length > 200) {
    res.status(400).json({ error: "say what you're looking for, in 2 to 200 characters", field: "q" });
    return;
  }

  try {
    const eligible = await db
      .select({ ...MEDIA_COLUMNS, embedding: sql<unknown>`${mediaAssets.metadata} -> 'embedding'` })
      .from(mediaAssets)
      .where(mediaPredicate(athleteId, q))
      .orderBy(...mediaOrder);
    if (eligible.length === 0) { res.json({ items: [], nextCursor: null }); return; }

    const { embedText, cosine } = await import("../lib/mediaEmbed.js");
    const vector = await withTimeout(embedText(words), MEDIA_SEARCH_EMBED_TIMEOUT_MS, "media search embed").catch(() => null);
    if (!vector) {
      logger.warn({ athleteId, kind: q.kind, eligible: eligible.length }, "media search: her words could not be embedded");
      res.status(503).json({ error: MEDIA_SEARCH_UNAVAILABLE });
      return;
    }

    const ranked = rankBySimilarity(eligible, (e) => cosine(vector, e)).slice(0, MEDIA_SEARCH_LIMIT);
    const items = await Promise.all(ranked.map((r) => shapeMediaRow(q.kind, r)));
    logger.info({ athleteId, kind: q.kind, eligible: eligible.length, served: items.length }, "media search");
    res.json({ items, nextCursor: null });
  } catch (err) {
    logger.error({ err, athleteId, kind: q.kind }, "studio media search failed");
    res.status(500).json({ error: "Couldn't search your library" });
  }
});

// ─── GET /studio/stitch/:stitchId ───────────────────────────────────────────────────────────────
//
// The watcher's read: queued → running → succeeded/failed, plus the finished clip once there is
// one. POLLING THIS NEVER STARTS, RESUMES OR ADVANCES WORK — the same rule GET /studio/jobs/:jobId
// keeps, and worth keeping even though a stitch is free: a poll that drives execution puts an
// ffmpeg run behind a client retry loop, and the memory that bounds is this instance's.
router.get("/studio/stitch/:stitchId", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const stitchId = req.params.stitchId;
  if (!UUID_RE.test(stitchId)) { res.status(404).json({ error: "No such stitch" }); return; }

  try {
    const job = await readStitchJob(athleteId, stitchId);
    // Not-found and not-yours are the same answer, deliberately — the predicate makes them so.
    if (!job) { res.status(404).json({ error: "No such stitch" }); return; }

    // One asset at most, and it is read back through the SAME shaping the generate routes use, so
    // the client gets one shape from every door — signed url, approval status, legal next moves.
    const assets = job.output_asset_id
      ? await shapeAssets(
          await db
            .select({
              id: mediaAssets.id,
              media_type: mediaAssets.media_type,
              gcs_path: mediaAssets.gcs_path,
              approval_status: mediaAssets.approval_status,
            })
            .from(mediaAssets)
            .where(
              and(
                eq(mediaAssets.id, job.output_asset_id),
                eq(mediaAssets.athlete_id, athleteId),
                isNull(mediaAssets.deleted_at),
              ),
            ),
        )
      : [];

    res.json({
      stitchId: job.id,
      status: job.status,
      error: job.last_error,
      startedAt: job.started_at?.toISOString() ?? null,
      completedAt: job.completed_at?.toISOString() ?? null,
      asset: assets[0] ?? null,
      limits: stitchLimits(),
    });
  } catch (err) {
    logger.error({ err, athleteId, stitchId }, "studio stitch read failed");
    res.status(500).json({ error: "Couldn't read that" });
  }
});

// ─── POST /studio/assets/:assetId/approve ───────────────────────────────────────────────────────
//
// Clearance, forwards. draft → approved, through the one door allowed to move approval_status.
router.post("/studio/assets/:assetId/approve", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const assetId = req.params.assetId;
  if (!UUID_RE.test(assetId)) { res.status(404).json({ error: "No such asset" }); return; }

  try {
    // Not-yours resolves to the same 404 a nonexistent id gets, before any state is revealed.
    if (!(await ownsAsset(athleteId, assetId))) { res.status(404).json({ error: "No such asset" }); return; }
    const moved = await setApprovalStatus(athleteId, assetId, "approved");
    res.json({ assetId: moved.assetId, approvalStatus: moved.to, allowedNext: allowedNext(moved.to) });
  } catch (err) {
    respondClearanceError(res, err, "approve", { athleteId, assetId });
  }
});

// ─── POST /studio/assets/:assetId/reject ────────────────────────────────────────────────────────
//
// §11 — "REMOVE FROM DECK AND REJECT" AS ONE GESTURE.
//
// Rejecting a still-embedded concept is TWO database acts, and the database enforces the order:
// generationGuards.sql §4 refuses to withdraw clearance while a live embed exists, because a deck
// is in front of a brand right now and un-approving in place would leave it rendering content whose
// clearance was revoked. studio/approval.ts refuses first with a readable sentence; the trigger is
// the copy that cannot be bypassed.
//
// That ordering is real and stays. What must NOT reach the athlete is the ordering itself: a person
// who taps Reject and is told "asset ... is embedded in a pitch deck" has been shown our schema and
// handed a chore. So this route does both acts — un-embed every deck (picture first, then the
// record, the mirror of embedding), then withdraw clearance — and answers with one sentence about
// what happened.
router.post("/studio/assets/:assetId/reject", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const assetId = req.params.assetId;
  if (!UUID_RE.test(assetId)) { res.status(404).json({ error: "No such asset" }); return; }

  try {
    if (!(await ownsAsset(athleteId, assetId))) { res.status(404).json({ error: "No such asset" }); return; }

    // Every deck holding it. decksEmbedding returns the brandId each unembed needs, and is already
    // scoped through media_kits.athlete_id.
    const decks = await decksEmbedding(athleteId, assetId);
    for (const deck of decks) {
      await unembedConceptFromDeck({ athleteId, brandId: deck.brandId, assetId });
    }

    const moved = await setApprovalStatus(athleteId, assetId, "rejected");

    res.json({
      assetId: moved.assetId,
      approvalStatus: moved.to,
      removedFromDecks: decks.length,
      allowedNext: allowedNext(moved.to),
      message: decks.length
        ? `Removed from ${decks.length} deck${decks.length === 1 ? "" : "s"} and rejected.`
        : "Rejected.",
    });
  } catch (err) {
    respondClearanceError(res, err, "reject", { athleteId, assetId });
  }
});

// ─── POST /studio/assets/:assetId/reopen ────────────────────────────────────────────────────────
//
// rejected → draft. The only way back: there is deliberately no one-step rehabilitation, so
// re-approving something previously refused is always two acts (studio/approval.ts).
router.post("/studio/assets/:assetId/reopen", ...studioGate, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId as string;
  const assetId = req.params.assetId;
  if (!UUID_RE.test(assetId)) { res.status(404).json({ error: "No such asset" }); return; }

  try {
    if (!(await ownsAsset(athleteId, assetId))) { res.status(404).json({ error: "No such asset" }); return; }
    const moved = await setApprovalStatus(athleteId, assetId, "draft");
    res.json({ assetId: moved.assetId, approvalStatus: moved.to, allowedNext: allowedNext(moved.to) });
  } catch (err) {
    respondClearanceError(res, err, "reopen", { athleteId, assetId });
  }
});

// ─── Posting a finished video (studio/publish) ──────────────────────────────────────────────────
// GET /studio/publish/options · POST /studio/publish · GET /studio/publish/:publishId — defined in
// server/studio/publish/routes.ts so the feature reads, and reverts, in one folder. Mounted behind
// THIS file's gate, passed in, so it cannot end up behind a different one. STUDIO_PUBLISH_MODE
// (off | dry | live, default off) is its own switch: with it off these answer 404.
registerPublishRoutes(router, studioGate);

// ─── The direction tools (studio/direction) ─────────────────────────────────────────────────────
// POST /studio/direction/echo (the spike, PR 7 commit 1); the brief-producing tools follow lane by
// lane. Defined in server/studio/direction/routes.ts, mounted behind THIS file's gate, and behind
// STUDIO_BRAND_PROFILES, the campaign brief's own switch. A tool answers a BriefProposal and never
// plans, generates, stitches or quotes — the hard gate its tripwire holds.
registerDirectionRoutes(router, studioGate);
registerCreativeRoutes(router, studioGate);
// Campaign governance (Amendment 3): hers, behind its own flag; not a Studio surface, so not behind STUDIO_ENABLED.
registerCampaignGovernanceRoutes(router, [requireAuth, requireAthlete] as const);

// ─── Typed edit ops (studio/edit, PR 9) ───────────────────────────────────────────────────────────
// POST /studio/edits/quote · /:id/run · /:id/accept · /:id/discard · GET /studio/edits[/:id] — defined in
// server/studio/edit/routes.ts, behind THIS gate and STUDIO_IMAGE_EDIT_OPS (off: 404).
registerEditRoutes(router, studioGate);

// ─── One clip, read on demand (studio/enrich, PR 9.5) ─────────────────────────────────────────────
// POST /studio/media/:id/read — defined in server/studio/enrich/routes.ts, behind THIS gate and
// STUDIO_CLIP_READ + STUDIO_VIDEO_ENRICH (off: 404). The read state rides on GET /studio/media rows.
registerClipReadRoutes(router, studioGate);

// ─── The verdict, read back (studio/qa, PR 11) ───────────────────────────────────────────────────
// GET /studio/assets/:assetId/qa — defined in server/studio/qa/routes.ts, behind THIS gate and
// STUDIO_QA_DISPLAY (off: 404). Flag-or-pass wording and the cost; reads, never runs.
registerQaRoutes(router, studioGate);

// ─── Her identity pack (studio/identity, PR 17) ──────────────────────────────────────────────────
// GET/PUT /studio/identity/* — defined in server/studio/identity/routes.ts, behind THIS gate and
// STUDIO_IDENTITY_PACK (off: 404). Ids and numbers only; the stranger control is the probe runner's.
registerIdentityRoutes(router, studioGate);

export default router;
