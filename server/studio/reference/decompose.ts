/**
 * studio/reference/decompose — a brand reference in, a spec §7 decomposition out (docs/specs/creative-architecture.md).
 *
 *   one of her images, or a pasted brief  →  ONE model call  →  reference-decomposition/1  →  one analysis row
 *
 * ─── THE ORDER IS THE GUARANTEE ─────────────────────────────────────────────────────────────────────────
 *
 * Every refusal that can be decided without spending is decided BEFORE the call, in this order:
 *
 *   1. the flag (STUDIO_BRAND_PROFILES). Off means nothing is read, called or written.
 *   2. the request's own shape: role, source kind, brief length, id syntax.
 *   3. TENANCY: the brand profile, and the source image, are looked up under `athleteId`. Another athlete's id is
 *      not-found, indistinguishable from a missing one, and costs $0.
 *   4. the image's bytes, upright and probe-sized (probeBytesFor). Unreadable is a refusal, not a call on nothing.
 *
 * Then exactly ONE call, never retried: a malformed reply is a refusal, and she can ask again. Then the reply is
 * read (below), and only a reply that passes the strict schema is stored.
 *
 * ─── READING THE REPLY ──────────────────────────────────────────────────────────────────────────────────
 *
 * Lenient about ONE thing only: a tag outside its dimension's §8 list is DROPPED AND COUNTED, not fatal. A good
 * reading of the light should not be thrown away because the model reached for "moody". Everything else is
 * strict, via reference/schema.ts: a missing or null REQUIRED dimension, a missing key, an unknown key, a URL,
 * handle or hashtag in a summary. Each is a refusal whose issues name the field.
 *
 * ─── SPEND ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Each result carries its model and its estimated cost: the provider's reported tokens at the Flash rates in
 * qa/cost.ts, basis "estimated". When the provider reports no usage, the cost is null with basis "unreported",
 * never a confident $0. The cost is recorded on the row, and it does NOT count toward the day cap
 * (spentTodayUsd sums generation_jobs only), as with the interpreter and creative QA (decided 22 Sep 2026).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets, studioReferenceAnalyses } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { probeBytesFor } from "../autoMask";
import { brandProfilesEnabled } from "../config";
import { SpendMeter } from "../qa/cost";
import {
  REFERENCE_PROMPT_VERSION,
  briefReferencePrompt,
  imageReferencePrompt,
} from "./prompt";
import {
  COMMERCIAL_STYLES,
  DIMENSIONS,
  DIMENSION_VOCAB,
  MAX_TAGS,
  REFERENCE_ROLES,
  REFERENCE_SCHEMA,
  describeIssues,
  referenceDecompositionSchema,
  type ReferenceDecomposition,
  type ReferenceRole,
} from "./schema";
import { getBrandProfile } from "./store";
import {
  geminiReferenceTransport,
  type ReferenceTransport,
  type ReferenceTransportUsage,
} from "./transport";

const logger = createLogger("studio/reference/decompose");

/** A pasted brief, at most. The same ceiling the preview route puts on her direction. */
export const MAX_BRIEF = 2000;
export const MAX_COMMERCIAL_STYLES = 3;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReferenceSource =
  | { kind: "image"; assetId: string }
  | { kind: "brief"; text: string };

export interface DecomposeRequest {
  source: ReferenceSource;
  role: ReferenceRole;
  /** File it under one of HER profiles, or under none. */
  brandProfileId?: string | null;
}

export interface DecomposeDeps {
  transport?: ReferenceTransport;
  /** Her image's bytes by storage path — authorized by the caller. Tests stand in for GCS here. */
  loadImage?: (
    gcsPath: string,
  ) => Promise<{ bytes: Buffer; mimeType: string } | null>;
}

export interface ReferenceCost {
  usd: number | null;
  basis: "estimated" | "unreported";
  inputTokens: number;
  outputTokens: number;
}

export type DecomposeRefusal =
  | "disabled"
  | "invalid_request"
  | "not_found"
  | "unreadable_image"
  | "model_failed"
  | "invalid_reply";

export type DecomposeResult =
  | {
      ok: true;
      analysisId: string;
      decomposition: ReferenceDecomposition;
      model: string;
      promptVersion: string;
      cost: ReferenceCost;
      /** `dimension:tag` for every off-list tag the reply carried. Dropped, not fatal. */
      droppedTags: string[];
    }
  | {
      ok: false;
      reason: DecomposeRefusal;
      /** For invalid_reply and invalid_request: each issue names its field. */
      issues?: string[];
      /** Present once the call was made. A refused reply still cost money. */
      cost?: ReferenceCost;
      model?: string;
    };

// ─── The reply ──────────────────────────────────────────────────────────────────────────────────────────

export type ReplyReading =
  | { ok: true; decomposition: ReferenceDecomposition; droppedTags: string[] }
  | { ok: false; issues: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "Low angle" / "low-angle" → "low_angle". The ids are §8's words in snake_case. */
const normalizeTag = (t: unknown) =>
  String(t)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** Keep the on-list tags (deduplicated, capped); record the rest as dropped. Non-arrays are left for the schema. */
function keepTags(
  raw: unknown,
  allowed: readonly string[],
  cap: number,
  label: string,
  dropped: string[],
): unknown {
  if (!Array.isArray(raw)) return raw;
  const kept: string[] = [];
  for (const t of raw) {
    const id = normalizeTag(t);
    if (allowed.includes(id) && !kept.includes(id) && kept.length < cap)
      kept.push(id);
    else if (!kept.includes(id)) dropped.push(`${label}:${String(t)}`);
  }
  return kept;
}

/** The model's reply text → a stored-shape decomposition, or the named reasons it is not one. Pure. */
export function readReferenceReply(text: string): ReplyReading {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { ok: false, issues: ["(root): the reply is not JSON"] };
  }
  if (!isRecord(raw))
    return { ok: false, issues: ["(root): the reply is not a JSON object"] };

  const dropped: string[] = [];
  const intent = raw.reference_intent;
  if (isRecord(intent)) {
    for (const d of DIMENSIONS) {
      const reading = intent[d];
      if (isRecord(reading) && "tags" in reading)
        reading.tags = keepTags(
          reading.tags,
          DIMENSION_VOCAB[d] ?? [],
          MAX_TAGS,
          d,
          dropped,
        );
    }
  }
  const styles = keepTags(
    raw.commercial_style,
    COMMERCIAL_STYLES,
    MAX_COMMERCIAL_STYLES,
    "commercial_style",
    dropped,
  );

  // `schema` is ours to set, never the model's to claim.
  const parsed = referenceDecompositionSchema.safeParse({
    ...raw,
    commercial_style: styles,
    schema: REFERENCE_SCHEMA,
  });
  if (!parsed.success)
    return { ok: false, issues: describeIssues(parsed.error) };
  return { ok: true, decomposition: parsed.data, droppedTags: dropped };
}

/** One call's cost from its reported usage — exported so a probe prices exactly as the engine does. */
export function costOf(usage: ReferenceTransportUsage | null): ReferenceCost {
  if (!usage)
    return { usd: null, basis: "unreported", inputTokens: 0, outputTokens: 0 };
  const meter = new SpendMeter();
  meter.vision(usage);
  return {
    usd: meter.total().usd,
    basis: "estimated",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

// ─── The engine ─────────────────────────────────────────────────────────────────────────────────────────

function checkRequest(
  req: DecomposeRequest,
): { ok: true; brief: string | null } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!(REFERENCE_ROLES as readonly string[]).includes(req.role))
    issues.push(`role: must be one of ${REFERENCE_ROLES.join(", ")}`);
  if (
    req.brandProfileId != null &&
    (typeof req.brandProfileId !== "string" ||
      !UUID_RE.test(req.brandProfileId))
  )
    issues.push("brandProfileId: not an id");
  let brief: string | null = null;
  if (req.source?.kind === "brief") {
    brief = typeof req.source.text === "string" ? req.source.text.trim() : "";
    if (!brief) issues.push("source.text: empty");
    else if (brief.length > MAX_BRIEF)
      issues.push(`source.text: longer than ${MAX_BRIEF} characters`);
  } else if (req.source?.kind === "image") {
    if (
      typeof req.source.assetId !== "string" ||
      !UUID_RE.test(req.source.assetId)
    )
      issues.push("source.assetId: not an id");
  } else {
    issues.push("source.kind: must be image or brief");
  }
  return issues.length ? { ok: false, issues } : { ok: true, brief };
}

/**
 * Decompose ONE reference for `athleteId`, who is ALWAYS `req.athleteId` or the in-process equivalent. See the
 * module header for the order of refusals and why it is the guarantee.
 */
export async function decomposeReference(
  athleteId: string,
  req: DecomposeRequest,
  deps: DecomposeDeps = {},
): Promise<DecomposeResult> {
  if (!brandProfilesEnabled()) return { ok: false, reason: "disabled" };

  const checked = checkRequest(req);
  if (!checked.ok)
    return { ok: false, reason: "invalid_request", issues: checked.issues };

  const profileId = req.brandProfileId ?? null;
  if (profileId && !(await getBrandProfile(athleteId, profileId)))
    return { ok: false, reason: "not_found" };

  let prompt: string;
  let image: { bytes: Buffer; mimeType: string } | null = null;
  let sourceAssetId: string | null = null;
  if (req.source.kind === "image") {
    const [asset] = await db
      .select({
        id: mediaAssets.id,
        gcs_path: mediaAssets.gcs_path,
        media_type: mediaAssets.media_type,
      })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, req.source.assetId),
          eq(mediaAssets.athlete_id, athleteId),
        ),
      )
      .limit(1);
    if (!asset) return { ok: false, reason: "not_found" };
    if (asset.media_type !== "IMAGE" || !asset.gcs_path)
      return { ok: false, reason: "unreadable_image" };
    image = await (deps.loadImage ?? probeBytesFor)(asset.gcs_path);
    if (!image) return { ok: false, reason: "unreadable_image" };
    sourceAssetId = asset.id;
    prompt = imageReferencePrompt();
  } else {
    prompt = briefReferencePrompt(checked.brief ?? "");
  }

  const transport = deps.transport ?? geminiReferenceTransport;
  let reply;
  try {
    reply = await transport({ prompt, image });
  } catch (err) {
    // The message only — never the error object, which can carry request content (her photo, her brief).
    logger.warn(
      {
        kind: req.source.kind,
        error: err instanceof Error ? err.message : String(err),
      },
      "reference decomposition call failed",
    );
    return { ok: false, reason: "model_failed" };
  }
  const cost = costOf(reply.usage);

  const reading = readReferenceReply(reply.text);
  if (!reading.ok) {
    // Issue PATHS and codes only: a summary is model-written text about her reference.
    logger.warn(
      {
        kind: req.source.kind,
        model: reply.model,
        issues: reading.issues.map((i) => i.split(":")[0]),
      },
      "reference decomposition reply refused",
    );
    return {
      ok: false,
      reason: "invalid_reply",
      issues: reading.issues,
      cost,
      model: reply.model,
    };
  }

  const [row] = await db
    .insert(studioReferenceAnalyses)
    .values({
      athlete_id: athleteId,
      brand_profile_id: profileId,
      source_kind: req.source.kind,
      source_asset_id: sourceAssetId,
      source_text: req.source.kind === "brief" ? checked.brief : null,
      role: req.role,
      decomposition: reading.decomposition,
      prompt_version: REFERENCE_PROMPT_VERSION,
      model: reply.model,
      cost_estimated_usd: cost.usd == null ? null : String(cost.usd),
      cost_basis: cost.basis,
    })
    .returning({ id: studioReferenceAnalyses.id });

  logger.info(
    {
      kind: req.source.kind,
      model: reply.model,
      usd: cost.usd,
      droppedTags: reading.droppedTags.length,
    },
    "reference decomposed",
  );
  return {
    ok: true,
    analysisId: row.id,
    decomposition: reading.decomposition,
    model: reply.model,
    promptVersion: REFERENCE_PROMPT_VERSION,
    cost,
    droppedTags: reading.droppedTags,
  };
}
