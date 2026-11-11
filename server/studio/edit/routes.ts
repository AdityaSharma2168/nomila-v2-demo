/**
 * studio/edit/routes — the typed edit door (PR 9, Lane 1), mounted behind THIS file's caller's gate
 * (routes/studio.ts passes `studioGate` in, the publish routes' pattern) and behind STUDIO_IMAGE_EDIT_OPS:
 * off, every route answers 404 and nothing here is reachable.
 *
 *   POST /studio/edits/recommend        {assetId, briefLines[], brand?} → recs grounded in those lines, or none
 *   POST /studio/edits/quote            {sourceAssetId, op, params, brandId?, batchId?} → the quote
 *   POST /studio/edits/:id/run          spends, once → the preview (a signed url, not a library row)
 *   POST /studio/edits/:id/accept       the one library write → the new asset's id
 *   POST /studio/edits/:id/discard      the preview is deleted
 *   POST /studio/edits/batch/quote      the carousel's itemized quote — rows under one batch id (Lane 4)
 *   POST /studio/edits/batch/:id/run    her Create tap: quotes consumed, jobs queued, the tick kicked — returns at once
 *   POST /studio/edits/batch/:id/reroll one more ad from one reference, quoted afresh (four at most)
 *   POST /studio/edits/batch/:id/accept-all   every ready candidate kept; discarded skipped
 *   GET  /studio/edits/batch/:id        the batch as the screen shows it (polled while running)
 *   GET  /studio/edits/:id              one of hers
 *   GET  /studio/edits?batchId=         hers, newest first (a batch's, when named)
 *   GET  /studio/style-references       her already-read style references (PR 18) — behind STUDIO_STYLE_SPEC
 *                                       alone, not the edit door's flag: Create Anything's Style tile reads it too
 *
 * The body is validated at the engine (ops.ts's zod per op); this file only shapes ids and answers.
 * A refusal is the engine's `{status, error, field}`; a thrown GenerationError is 409 with its message;
 * anything else is a 500 that says nothing about why.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { createLogger } from "../../logger";
import { imageEditOpsEnabled, styleSpecEnabled } from "../config";
import { GenerationError } from "../types";
import {
  acceptEdit,
  discardEdit,
  presentEdit,
  quoteEdit,
  runEdit,
  type EditRefusal,
} from "./engine";
import { listEditPreviews, readEditPreview } from "./previews";
import { recommendMemoized } from "./recommend";
import {
  acceptAllBatch,
  batchView,
  MAX_INITIAL_CANDIDATES,
  MAX_REFS,
  quoteBatch,
  rerollBatch,
  runBatch,
} from "./batch";
import { SOURCE_REFUSAL_COPY, verifiedSource } from "./source";
import { probeBytesFor } from "../autoMask";

const logger = createLogger("studio/edit/routes");

const QUOTE_BODY = z
  .object({
    sourceAssetId: z.string().uuid(),
    op: z.string(),
    params: z.record(z.unknown()).optional(),
    brandId: z.number().int().positive().nullable().optional(),
    batchId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * With STUDIO_STYLE_SPEC on, a quote may name one of her already-read references as a style MODIFIER (PR 18,
 * ADI-GO18 G2). Off, the body is parsed by QUOTE_BODY exactly as before, so the key is refused as unknown.
 */
const QUOTE_BODY_STYLED = QUOTE_BODY.extend({
  styleAssetId: z.string().uuid().nullable().optional(),
}).strict();

const ID = z.string().uuid();

const REC_SHAPE = z
  .object({
    op: z.string(),
    params: z.record(z.unknown()),
    because: z.string().trim().min(1).max(300),
    what: z.string().max(200).optional().default(""),
  })
  .strict();

const BATCH_QUOTE_BODY = z
  .object({
    refs: z
      .array(
        z
          .object({
            assetId: z.string().uuid(),
            variations: z.number().int().min(1).max(MAX_INITIAL_CANDIDATES),
            cleanup: REC_SHAPE.nullable().optional().default(null),
          })
          .strict(),
      )
      .min(1)
      // A 4th reference is refused HERE as well as in the engine: the door and the engine agree.
      .max(MAX_REFS),
    brand: z.string().trim().min(1).max(80),
    campaign: z
      .object({
        product: z.string().trim().min(1).max(120).optional(),
        story: z.string().trim().min(1).max(240).optional(),
        goal: z.string().trim().min(1).max(60).optional(),
      })
      .strict()
      .optional(),
    headline: z.string().trim().min(1).max(24).optional(),
    // The setting is hers to give (Adi, 23 Sep 2026: "the setting can't be optional"): the first ad is
    // set where she says; the other two take settings she did not give, so the three differ.
    setting: z.string().trim().min(1).max(80),
    instruction: z.string().trim().min(1).max(300).optional(),
    briefLines: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
    brandId: z.number().int().positive().nullable().optional(),
  })
  .strict();

const RECOMMEND_BODY = z
  .object({
    assetId: z.string().uuid(),
    /** The confirmed brief's lines, as text. Empty → no call, no recs. */
    briefLines: z.array(z.string().trim().min(1).max(300)).max(12),
    brand: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

function refused(res: Response, r: EditRefusal): void {
  res
    .status(r.status)
    .json({ error: r.error, ...(r.field ? { field: r.field } : {}) });
}

function failed(
  res: Response,
  err: unknown,
  verb: string,
  ctx: Record<string, unknown>,
): void {
  if (err instanceof GenerationError) {
    logger.warn(
      { ...ctx, code: err.code, message: err.message },
      `edit ${verb} refused`,
    );
    res.status(409).json({ error: err.message });
    return;
  }
  logger.error({ ...ctx, err }, `edit ${verb} failed`);
  res.status(500).json({ error: `Couldn't ${verb} that edit right now.` });
}

/** Off, the door is not there: a 404, not a 403, so the flag's state is not readable from outside. */
const requireEditOps: RequestHandler = (_req, res, next) => {
  if (!imageEditOpsEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

/** The style picker's list exists only with STUDIO_STYLE_SPEC on — a 404 otherwise, like the edit door. */
const requireStyleSpec: RequestHandler = (_req, res, next) => {
  if (!styleSpecEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

export function registerEditRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  const guarded = [...gate, requireEditOps] as const;

  // ─── Her already-read style references (PR 18, ADI-GO18 G8) ─────────────────────────────────────
  // The picker's list, for Create Anything's Style tile and the edit sheet's "Match a look". ONLY references
  // she has already had read: nothing here decomposes or spends. Her athlete id is in every predicate
  // (reference/styleStore.ts). Gated on the style flag alone, since the Create Anything tile needs it with the
  // edit door off. The "still reading" refusal stays at both doors as the invariant under this convenience.
  router.get(
    "/studio/style-references",
    ...gate,
    requireStyleSpec,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      try {
        // Loaded here, not at the top: with the flag off this file's import graph is exactly what it was.
        const { listReadStyleReferences } = await import(
          "../reference/styleStore.js"
        );
        const { signedUrl } = await import("../../lib/mediaStore.js");
        const rows = await listReadStyleReferences(athleteId);
        res.json({
          references: await Promise.all(
            rows.map(async (r) => ({
              assetId: r.assetId,
              analysisId: r.analysisId,
              caption: r.caption,
              readAt: r.readAt,
              thumbUrl: await signedUrl(r.gcsPath).catch(() => null),
            })),
          ),
        });
      } catch (err) {
        logger.error(
          { athleteId, err },
          "style references could not be listed",
        );
        res
          .status(500)
          .json({ error: "Couldn't list your references right now." });
      }
    },
  );

  // The recommendation pass behind the popover: reads the photo, never runs an op. A source the gate refuses
  // answers no recs AND the refusal's copy, so the popover shows why the manual path will refuse too.
  router.post(
    "/studio/edits/recommend",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const body = RECOMMEND_BODY.safeParse(req.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        res.status(400).json({
          error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
          field: issue?.path[0],
        });
        return;
      }
      try {
        const src = await verifiedSource(athleteId, body.data.assetId);
        if (!src.ok) {
          if (src.reason === "source_not_found") {
            res
              .status(404)
              .json({ error: SOURCE_REFUSAL_COPY.source_not_found });
            return;
          }
          res.json({
            recs: [],
            skipped: "source",
            refusal: SOURCE_REFUSAL_COPY[src.reason],
          });
          return;
        }
        const out = await recommendMemoized(
          {
            athleteId,
            assetId: src.source.id,
            briefLines: body.data.briefLines,
            brand: body.data.brand ?? null,
          },
          async () => {
            const probe = await probeBytesFor(src.source.gcsPath);
            return probe
              ? { bytes: probe.bytes, mimeType: probe.mimeType }
              : null;
          },
        );
        res.json({ recs: out.recs, skipped: out.skipped, refusal: null });
      } catch (err) {
        failed(res, err, "recommend", {
          athleteId,
          assetId: body.data.assetId,
        });
      }
    },
  );

  // ─── The carousel batch (Lane 4) ──────────────────────────────────────────────────────────────
  router.post(
    "/studio/edits/batch/quote",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const body = BATCH_QUOTE_BODY.safeParse(req.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        res.status(400).json({
          error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
          field: issue?.path[0],
        });
        return;
      }
      try {
        const out = await quoteBatch({
          athleteId,
          refs: body.data.refs.map((r) => ({
            assetId: r.assetId,
            variations: r.variations,
            cleanup: (r.cleanup as never) ?? null,
          })),
          brand: body.data.brand,
          campaign: body.data.campaign,
          headline: body.data.headline,
          setting: body.data.setting,
          instruction: body.data.instruction,
          briefLines: body.data.briefLines,
          brandId: body.data.brandId ?? null,
        });
        if (!out.ok) return refused(res, out);
        res.json({
          batchId: out.batchId,
          lines: out.lines,
          totalUsd: out.totalUsd,
          unpriced: out.unpriced,
        });
      } catch (err) {
        failed(res, err, "quote", { athleteId, batch: true });
      }
    },
  );

  router.post(
    "/studio/edits/batch/:batchId/run",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.batchId);
      if (!id.success) {
        res
          .status(400)
          .json({ error: "batchId must be a uuid", field: "batchId" });
        return;
      }
      try {
        const out = await runBatch({ athleteId, batchId: id.data });
        if (!out.ok) return refused(res, out);
        res.json({ batchId: id.data, queued: out.queued });
      } catch (err) {
        failed(res, err, "run", { athleteId, batchId: id.data });
      }
    },
  );

  router.post(
    "/studio/edits/batch/:batchId/reroll",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.batchId);
      const asset = ID.safeParse((req.body ?? {}).assetId);
      if (!id.success || !asset.success) {
        res.status(400).json({
          error: "batchId and assetId must be uuids",
          field: id.success ? "assetId" : "batchId",
        });
        return;
      }
      try {
        const out = await rerollBatch({
          athleteId,
          batchId: id.data,
          assetId: asset.data,
        });
        if (!out.ok) return refused(res, out);
        res.json({ id: out.id, costUsd: out.costUsd, unpriced: out.unpriced });
      } catch (err) {
        failed(res, err, "reroll", { athleteId, batchId: id.data });
      }
    },
  );

  router.post(
    "/studio/edits/batch/:batchId/accept-all",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.batchId);
      if (!id.success) {
        res
          .status(400)
          .json({ error: "batchId must be a uuid", field: "batchId" });
        return;
      }
      try {
        const out = await acceptAllBatch({ athleteId, batchId: id.data });
        if (!out.ok) return refused(res, out);
        res.json({ assetIds: out.assetIds, skipped: out.skipped });
      } catch (err) {
        failed(res, err, "accept", { athleteId, batchId: id.data });
      }
    },
  );

  router.get(
    "/studio/edits/batch/:batchId",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.batchId);
      if (!id.success) {
        res
          .status(400)
          .json({ error: "batchId must be a uuid", field: "batchId" });
        return;
      }
      res.json(await batchView(athleteId, id.data));
    },
  );

  router.post(
    "/studio/edits/quote",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const body = (
        styleSpecEnabled() ? QUOTE_BODY_STYLED : QUOTE_BODY
      ).safeParse(req.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        res.status(400).json({
          error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
          field: issue?.path[0],
        });
        return;
      }
      const styleAssetId =
        (body.data as { styleAssetId?: string | null }).styleAssetId ?? null;
      try {
        const out = await quoteEdit({
          athleteId,
          sourceAssetId: body.data.sourceAssetId,
          op: body.data.op,
          params: body.data.params ?? {},
          brandId: body.data.brandId ?? null,
          batchId: body.data.batchId ?? null,
          ...(styleAssetId ? { styleAssetId } : {}),
        });
        if (!out.ok) return refused(res, out);
        res.json({ edit: await presentEdit(out.row), quote: out.quote });
      } catch (err) {
        failed(res, err, "quote", { athleteId, op: body.data.op });
      }
    },
  );

  router.post(
    "/studio/edits/:id/run",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "id must be a uuid", field: "id" });
        return;
      }
      try {
        const out = await runEdit({ athleteId, id: id.data });
        if (!out.ok) return refused(res, out);
        res.json({ edit: await presentEdit(out.row) });
      } catch (err) {
        failed(res, err, "run", { athleteId, editPreviewId: id.data });
      }
    },
  );

  router.post(
    "/studio/edits/:id/accept",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "id must be a uuid", field: "id" });
        return;
      }
      try {
        const out = await acceptEdit({ athleteId, id: id.data });
        if (!out.ok) return refused(res, out);
        res.json({ edit: await presentEdit(out.row), assetId: out.assetId });
      } catch (err) {
        failed(res, err, "accept", { athleteId, editPreviewId: id.data });
      }
    },
  );

  router.post(
    "/studio/edits/:id/discard",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "id must be a uuid", field: "id" });
        return;
      }
      try {
        const out = await discardEdit({ athleteId, id: id.data });
        if (!out.ok) return refused(res, out);
        res.json({ edit: await presentEdit(out.row) });
      } catch (err) {
        failed(res, err, "discard", { athleteId, editPreviewId: id.data });
      }
    },
  );

  router.get(
    "/studio/edits/:id",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "id must be a uuid", field: "id" });
        return;
      }
      const row = await readEditPreview(athleteId, id.data);
      if (!row) {
        res.status(404).json({ error: "We couldn't find that edit." });
        return;
      }
      res.json({ edit: await presentEdit(row) });
    },
  );

  router.get(
    "/studio/edits",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const batchId =
        typeof req.query.batchId === "string" ? req.query.batchId : undefined;
      if (batchId && !ID.safeParse(batchId).success) {
        res
          .status(400)
          .json({ error: "batchId must be a uuid", field: "batchId" });
        return;
      }
      const rows = await listEditPreviews(athleteId, { batchId });
      res.json({ edits: await Promise.all(rows.map(presentEdit)) });
    },
  );
}
