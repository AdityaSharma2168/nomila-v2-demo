/**
 * studio/direction/decompose — decompose_reference: a reference she pasted or uploaded, read by PR 3's
 * engine (studio/reference/decompose.ts, UNTOUCHED), mapped onto a BriefProposal.
 *
 *   {kind: "image", assetId} | {kind: "text", text}, role  →  decomposeReference (one Flash call, the
 *   engine's own gates: flag, shape, tenancy, bytes)  →  reference-decomposition/1  →  a brief whose
 *   creative direction and `references[0].intent` ARE the decomposition — every line inferred.
 *
 * ─── A DECOMPOSED REFERENCE IS INFERENCE BY DEFINITION ──────────────────────────────────────────────
 *
 * Nothing the engine emits was said by her or by a brand; it is a reading of pixels or of pasted text.
 * So every line here is flagged inferred, its because naming the dimension it was read from, and the
 * proposal says so in a note. The engine's own observed/inferred `basis` per dimension rides inside the
 * intent, where the planner already reads it.
 *
 * ─── WHAT MAPS WHERE ────────────────────────────────────────────────────────────────────────────────
 *
 *   commercial_style[0]        → creative_direction.style   (the same §8 list on both sides)
 *   emotional_tone.summary     → creative_direction.tone    (its clauses, up to six short ones)
 *   motion.tags[0]             → creative_direction.energy  (when the reference moves)
 *   reference_intent           → references[0].intent, under the role she picked, handle `ref_1`
 *   everything else            → null; the objective and its companions the brand flow's defaults
 *
 * ─── A LINK SHE GAVE IS A PICTURE SHE POINTED AT ───────────────────────────────────────────────────
 *
 * {kind: "url"}: the link is attacker-chosen text, so it goes through safeFetch (Lane F: https only,
 * never an internal address, every redirect hop checked and pinned) and nothing else; a direct image
 * only (jpeg / png / webp — a page is a 415, scraping is its own card), at most MAX_REFERENCE_BYTES;
 * stored under her prefix and written as ONE media_assets row under her athlete_id with origin
 * 'reference' (migration 0062) — the marker every reader of her library honours (photoPredicate,
 * mediaSearch, mediaEnrichment, routes/media), so the picture can be named by a plan row and read by
 * the reference engine, and is never offered as her footage. Then it is the image door.
 * Nothing here plans, generates, stitches or quotes.
 */
import { randomUUID } from "node:crypto";
import { mediaAssets } from "../../../shared/schema";
import { db } from "../../db";
import { saveBuffer } from "../../lib/mediaStore";
import { safeFetch, UnsafeUrlError } from "../../lib/safeFetch";
import { createLogger } from "../../logger";
import { REFERENCE_ROLES, type ReferenceRole } from "../reference/schema";
import {
  decomposeReference,
  MAX_BRIEF,
  type DecomposeDeps,
  type DecomposeResult,
} from "../reference/decompose";
import { buildBrief, type KeptLine } from "./brief";
import {
  MAX_BECAUSE,
  MAX_NOTE,
  validateBriefProposal,
  type BriefProposal,
  type InferenceFlag,
} from "./envelope";
import type { SummarizeCost } from "./summarize";
import { capWords } from "../text";

const logger = createLogger("studio/direction/decompose");

export type DecomposeSource =
  | { kind: "image"; assetId: string }
  | { kind: "text"; text: string }
  | { kind: "url"; url: string };

export interface DecomposeInput {
  source: DecomposeSource;
  role?: ReferenceRole;
}

export type DecomposeToolRefusal =
  | "disabled"
  | "invalid_input"
  | StoreRefusal
  | "not_found"
  | "unreadable_image"
  | "model_failed"
  | "invalid_reply";

export type DecomposeToolResult =
  | {
      ok: true;
      proposal: BriefProposal;
      /** The media_assets row a link was stored as (origin 'reference'); null for her own photo or text. */
      storedAssetId: string | null;
      analysisId: string;
      model: string;
      promptVersion: string;
      cost: SummarizeCost;
      droppedTags: string[];
    }
  | {
      ok: false;
      reason: DecomposeToolRefusal;
      issues?: string[];
      cost?: SummarizeCost;
      model?: string;
    };

/** A fetched reference: a direct image only, and no larger than this. */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const REFERENCE_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export type StoreRefusal =
  | "url_refused"
  | "fetch_failed"
  | "not_an_image"
  | "too_large"
  | "store_failed";

export interface StoredReference {
  assetId: string;
  gcsPath: string;
  contentType: string;
  bytes: number;
}

/** Test seams for the URL door: the fetch and the store. Production takes safeFetch and saveBuffer. */
export interface ReferenceDeps {
  fetchUrl?: typeof safeFetch;
  save?: typeof saveBuffer;
}

/**
 * Fetch a link she gave and store it as HER reference asset — origin 'reference', never her footage.
 * ⚠️ MUTATIONS (tripwire.test, routes.test): a bare `fetch` in place of safeFetch — "no direction
 * module calls fetch outside safeFetch" reds; origin 'upload' — "never offered as her footage" reds.
 */
export async function storeReferenceFromUrl(
  athleteId: string,
  url: string,
  deps: ReferenceDeps = {},
): Promise<
  | { ok: true; stored: StoredReference }
  | { ok: false; reason: StoreRefusal; detail?: string }
> {
  let res: Response;
  try {
    res = await (deps.fetchUrl ?? safeFetch)(url);
  } catch (err) {
    if (err instanceof UnsafeUrlError)
      return { ok: false, reason: "url_refused", detail: err.message };
    logger.warn(
      { athleteId, error: String((err as Error).message ?? err).slice(0, 120) },
      "reference fetch failed",
    );
    return { ok: false, reason: "fetch_failed" };
  }
  if (!res.ok)
    return { ok: false, reason: "fetch_failed", detail: `HTTP ${res.status}` };
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!REFERENCE_IMAGE_TYPES.includes(contentType))
    return {
      ok: false,
      reason: "not_an_image",
      detail: contentType || "no content type",
    };
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_REFERENCE_BYTES) return { ok: false, reason: "too_large" };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_REFERENCE_BYTES)
    return { ok: false, reason: "too_large" };

  const basePath = `athletes/${athleteId}/references/${randomUUID()}`;
  let saved: Awaited<ReturnType<typeof saveBuffer>>;
  try {
    saved = await (deps.save ?? saveBuffer)(
      buf,
      basePath,
      contentType,
      MAX_REFERENCE_BYTES,
    );
  } catch (err) {
    logger.warn(
      { athleteId, error: String((err as Error).message ?? err).slice(0, 120) },
      "reference store failed",
    );
    return { ok: false, reason: "store_failed" };
  }
  if ("skipped" in saved) return { ok: false, reason: "too_large" };
  try {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: athleteId,
        platform: "web",
        origin: "reference",
        media_type: "IMAGE",
        status: "stored",
        gcs_path: saved.gcs_path,
        content_type: saved.content_type,
        ingested_at: new Date(),
        metadata: {
          reference: {
            url,
            fetched_at: new Date().toISOString(),
            bytes: saved.bytes,
          },
        },
      })
      .returning({ id: mediaAssets.id });
    return {
      ok: true,
      stored: {
        assetId: row.id,
        gcsPath: saved.gcs_path,
        contentType: saved.content_type,
        bytes: saved.bytes,
      },
    };
  } catch (err) {
    logger.warn(
      { athleteId, error: String((err as Error).message ?? err).slice(0, 120) },
      "reference row failed",
    );
    return { ok: false, reason: "store_failed" };
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TONES = 6;
const MAX_TONE = 40;
const MAX_ENERGY = 40;

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────────────

export function readDecomposeInput(
  raw: unknown,
):
  | { ok: true; value: { source: DecomposeSource; role: ReferenceRole } }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, issues: ["body: an object"] };
  const b = raw as Record<string, unknown>;
  const role: ReferenceRole = (REFERENCE_ROLES as readonly string[]).includes(
    String(b.role ?? "style_reference"),
  )
    ? ((b.role as ReferenceRole | undefined) ?? "style_reference")
    : (issues.push(`role: one of ${REFERENCE_ROLES.join(", ")}`),
      "style_reference");
  const s = b.source;
  let source: DecomposeSource | null = null;
  if (typeof s !== "object" || s === null || Array.isArray(s))
    issues.push("source: { kind: image | text | url, … }");
  else {
    const src = s as Record<string, unknown>;
    if (src.kind === "image") {
      if (typeof src.assetId === "string" && UUID_RE.test(src.assetId))
        source = { kind: "image", assetId: src.assetId.toLowerCase() };
      else issues.push("source.assetId: one of your photos, by id");
    } else if (src.kind === "text") {
      const text = typeof src.text === "string" ? src.text.trim() : "";
      if (text && text.length <= MAX_BRIEF) source = { kind: "text", text };
      else
        issues.push(
          `source.text: a pasted brief of up to ${MAX_BRIEF} characters`,
        );
    } else if (src.kind === "url") {
      if (typeof src.url === "string" && src.url.trim())
        source = { kind: "url", url: src.url.trim() };
      else issues.push("source.url: a link");
    } else issues.push("source.kind: image, text or url");
  }
  if (issues.length || !source) return { ok: false, issues };
  return { ok: true, value: { source, role } };
}

// ─── The mapping ────────────────────────────────────────────────────────────────────────────────────────

type Decomposition = Extract<DecomposeResult, { ok: true }>["decomposition"];

/** Short clauses out of a sentence — the tone words a summary carries, each ≤ 40 characters. */
export function toneClauses(summary: string): string[] {
  return summary
    .split(/[,;.]| and | but /i)
    .map((s) =>
      s
        .trim()
        .replace(
          /^(the\s+)?(overall\s+)?(image|photo|reference|frame|scene|mood|feel|tone|atmosphere|energy)?\s*(is|feels|reads as|conveys|evokes|suggests|inspires|creates)\s+(a\s+sense\s+of\s+)?/i,
          "",
        )
        .replace(/^(a|an|the|with|is|are|feels?|it|very)\s+/i, "")
        .replace(/\.$/, "")
        .toLowerCase(),
    )
    .filter((s) => s.length >= 3 && s.length <= MAX_TONE)
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, MAX_TONES);
}

const because = (dimension: string, summary: string): string =>
  capWords(
    `from the reference's ${dimension.replace(/_/g, " ")}: ${summary}`,
    MAX_BECAUSE,
  );

/** The decomposition onto a brief, every line inferred. Pure: the engine's output in, a proposal out. */
export function proposalFromDecomposition(
  d: Decomposition,
  role: ReferenceRole,
  about: { kind: "image" | "text" | "url"; droppedTags: number },
): unknown {
  const intent = d.reference_intent;
  const kept = new Map<string, KeptLine>();
  const style = d.commercial_style[0];
  if (style)
    kept.set("creative_direction.style", {
      value: style,
      flag: {
        basis: "inferred",
        because: `the reference reads as ${d.commercial_style.join(" / ").replace(/_/g, " ")}`,
      },
    });
  const tones = toneClauses(intent.emotional_tone.summary);
  if (tones.length)
    kept.set("creative_direction.tone", {
      value: tones,
      flag: {
        basis: "inferred",
        because: because("emotional_tone", intent.emotional_tone.summary),
      },
    });
  const motionTag = intent.motion?.tags[0];
  if (motionTag)
    kept.set("creative_direction.energy", {
      value: capWords(motionTag.replace(/_/g, " "), MAX_ENERGY),
      flag: {
        basis: "inferred",
        because: because("motion", intent.motion!.summary),
      },
    });
  const built = buildBrief(kept);
  const observed = Object.values(intent).filter(
    (x) => x && x.basis === "observed",
  ).length;
  const inferred = Object.values(intent).filter(
    (x) => x && x.basis === "inferred",
  ).length;
  const referencesFlag: InferenceFlag = {
    path: "references",
    basis: "inferred",
    because: capWords(
      `the reference, decomposed along ${observed + inferred} dimensions (${observed} observed, ${inferred} inferred)`,
      MAX_BECAUSE,
    ),
  };
  const notes = [
    "A decomposed reference is inference by definition — every line here is inferred.",
    `${about.kind === "image" ? "The image" : about.kind === "url" ? "The picture at her link" : "The pasted text"} read on ${observed + inferred} of 12 dimensions: ${observed} observed, ${inferred} inferred.`,
    ...(about.droppedTags
      ? [
          `${about.droppedTags} off-list tag${about.droppedTags === 1 ? "" : "s"} dropped.`,
        ]
      : []),
  ].map((n) => capWords(n, MAX_NOTE));
  return {
    brief: { ...built.brief, references: [{ ref: "ref_1", role, intent }] },
    flags: [...built.flags, referencesFlag],
    sourceTool: "decompose_reference",
    extras: { constraints: [], notes },
  };
}

// ─── The tool ───────────────────────────────────────────────────────────────────────────────────────────

export async function decomposeToProposal(
  athleteId: string,
  input: DecomposeInput,
  deps: DecomposeDeps & ReferenceDeps = {},
): Promise<DecomposeToolResult> {
  const read = readDecomposeInput(input);
  if (!read.ok)
    return { ok: false, reason: "invalid_input", issues: read.issues };
  const { role } = read.value;
  let source = read.value.source;
  let stored: StoredReference | null = null;
  if (source.kind === "url") {
    const s = await storeReferenceFromUrl(athleteId, source.url, deps);
    if (!s.ok)
      return {
        ok: false,
        reason: s.reason,
        issues: s.detail ? [s.detail] : [],
      };
    stored = s.stored;
    source = { kind: "image", assetId: stored.assetId };
  }

  const r = await decomposeReference(
    athleteId,
    {
      source:
        source.kind === "image"
          ? { kind: "image", assetId: source.assetId }
          : { kind: "brief", text: source.text },
      role,
    },
    deps,
  );
  if (!r.ok) {
    const cost = r.cost
      ? {
          usd: r.cost.usd,
          basis: r.cost.basis,
          inputTokens: r.cost.inputTokens,
          outputTokens: r.cost.outputTokens,
        }
      : undefined;
    return {
      ok: false,
      reason: r.reason === "invalid_request" ? "invalid_input" : r.reason,
      issues: r.issues,
      cost,
      model: r.model,
    };
  }
  const candidate = proposalFromDecomposition(r.decomposition, role, {
    kind: stored ? "url" : source.kind,
    droppedTags: r.droppedTags.length,
  });
  const v = validateBriefProposal(candidate);
  if (!v.ok) {
    logger.warn(
      { athleteId, model: r.model, issues: v.issues.length },
      "decompose_reference mapped an invalid proposal",
    );
    return {
      ok: false,
      reason: "invalid_reply",
      issues: v.issues,
      model: r.model,
    };
  }
  const cost: SummarizeCost = {
    usd: r.cost.usd,
    basis: r.cost.basis,
    inputTokens: r.cost.inputTokens,
    outputTokens: r.cost.outputTokens,
  };
  logger.info(
    {
      athleteId,
      tool: "decompose_reference",
      kind: stored ? "url" : source.kind,
      role,
      model: r.model,
      promptVersion: r.promptVersion,
      usd: cost.usd,
      basis: cost.basis,
      droppedTags: r.droppedTags.length,
      lines: v.proposal.flags.length,
    },
    "decompose_reference answered",
  );
  return {
    ok: true,
    proposal: v.proposal,
    storedAssetId: stored?.assetId ?? null,
    analysisId: r.analysisId,
    model: r.model,
    promptVersion: r.promptVersion,
    cost,
    droppedTags: r.droppedTags,
  };
}
