/**
 * studio/identity/routes — her identity pack, and what was measured about it (PR 17).
 *
 *   GET  /studio/identity/profile     → { profile, quote }        what is saved, and what a calibration costs
 *   GET  /studio/identity/candidates  → { candidates }            her photographs, each judged by the pack gate
 *   PUT  /studio/identity/pack        { assetIds }  → { profile, refused, overCap }   $0: gate + save
 *   POST /studio/identity/calibrate   → { profile, measured }     her-vs-her band — MODEL CALLS (quoted on GET)
 *
 * ─── OFF IS A 404, AND OFF IS TODAY ─────────────────────────────────────────────────────────────
 *
 * Behind STUDIO_IDENTITY_PACK (studio/config.ts `identityPackEnabled`), default off, paired with the
 * client's EXPO_PUBLIC_STUDIO_IDENTITY_PACK. Off, the door is not there — a 404 before any row is
 * read, the shape qa/routes.ts and edit/routes.ts use. ⚠️ MUTATION (routes.test): answer with the
 * flag off — "pack surface renders with STUDIO_IDENTITY_PACK off" reds by name on the server half.
 *
 * ─── TENANCY ───────────────────────────────────────────────────────────────────────────────────
 *
 * Every media_assets read is under `req.athleteId`; an id she sends that is not hers is simply not
 * in the rows and is reported as `not_yours` beside the others — the same 404-shaped answer as
 * readOwnedImage gives. The profile row is hers by the unique on athlete_id.
 *
 * ─── WHAT THE CALIBRATION DOES NOT DO ──────────────────────────────────────────────────────────
 *
 * It measures HER band (R-4 i) and writes it for the record. It does NOT run the stranger control
 * (R-4 ii) — that reads other athletes' rows, which no request under her id may do — and it never
 * sets control_passed. The control is the probe runner's (probe-out/identity-pack/control.ts), run
 * by Adi. Until it passes, `bandFor` answers null and her identity displays stay flag-only.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { readObject, signedUrl } from "../../lib/mediaStore";
import { createLogger } from "../../logger";
import { identityPackEnabled } from "../config";
import {
  bandOf,
  measureFaces,
  pairwiseDistances,
  quoteMeasure,
} from "./calibrate";
import {
  PACK_REFUSAL_COPY,
  packDecision,
  selectPack,
  type PackRefusal,
} from "./packGate";
import {
  PACK_MAX,
  PACK_MIN,
  readProfile,
  writeBand,
  writeFaceSizes,
  writePack,
  type IdentityProfile,
} from "./profile";

const logger = createLogger("studio/identity/routes");

export const NO_BODY_SHOT_NUDGE =
  "Add a full-length photo so your build carries too — every photo here is a close-up.";

const ID = z.string().uuid();
const PUT_BODY = z.object({ assetIds: z.array(ID).max(60) });

/** Off, the door is not there: a 404, not a 403, so the flag's state is not readable from outside. */
const requirePack: RequestHandler = (_req, res, next) => {
  if (!identityPackEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

export interface CandidateWire {
  assetId: string;
  thumbUrl: string;
  eligible: boolean;
  /** Null when eligible; a `face_partial` candidate is eligible only as a fill-in. */
  refusal: PackRefusal | null;
  reason: string | null;
  inPack: boolean;
}

export interface ProfileWire {
  pack: IdentityProfile["pack"];
  incomplete: boolean;
  min: number;
  max: number;
  band: IdentityProfile["band"];
  controlPassed: boolean | null;
  controlMeasuredAt: string | null;
  embedder: string | null;
  /** The one honest sentence about the band's standing. */
  standing: string;
}

export function presentProfile(p: IdentityProfile | null): ProfileWire {
  const pack = p?.pack ?? [];
  const incomplete = pack.length < PACK_MIN;
  const standing =
    !p || pack.length === 0
      ? "No pack yet."
      : incomplete
        ? `Pack incomplete — ${pack.length} of ${PACK_MIN}. Likeness fill-in is off until it is complete.`
        : !p.band
          ? "Pack saved. Not yet measured."
          : p.controlPassed === true
            ? "Measured, and the stranger control passed: her band is used for her."
            : p.controlPassed === false
              ? "Measured, but the stranger control did not pass: a stranger scored inside her band. Identity stays an observation, never a check."
              : "Measured. The stranger control has not run; the band is on record and not asserted.";
  return {
    pack,
    incomplete,
    min: PACK_MIN,
    max: PACK_MAX,
    band: p?.band ?? null,
    controlPassed: p?.controlPassed ?? null,
    controlMeasuredAt: p?.controlMeasuredAt ?? null,
    embedder: p?.embedder ?? null,
    standing,
  };
}

const prominence = sql<number>`CASE WHEN jsonb_typeof(${mediaAssets.metadata}->'vision'->'athlete_prominence') = 'number' THEN (${mediaAssets.metadata}->'vision'->>'athlete_prominence')::float8 ELSE 0 END`;

/** Her stored photographs. Tenancy in the predicate. */
async function herPhotos(athleteId: string) {
  return db
    .select({
      id: mediaAssets.id,
      origin: mediaAssets.origin,
      metadata: mediaAssets.metadata,
      gcs_path: mediaAssets.gcs_path,
      gcs_thumb_path: mediaAssets.gcs_thumb_path,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.media_type, "IMAGE"),
        eq(mediaAssets.status, "stored"),
        isNotNull(mediaAssets.gcs_path),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .orderBy(desc(prominence), mediaAssets.id)
    .limit(200);
}

export function registerIdentityRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  const guarded = [...gate, requirePack] as const;

  router.get(
    "/studio/identity/profile",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      try {
        const profile = await readProfile(athleteId);
        res.json({
          profile: presentProfile(profile),
          quote: quoteMeasure(profile?.pack.length ?? 0),
        });
      } catch (err) {
        logger.error({ err, athleteId }, "identity profile read failed");
        res.status(500).json({ error: "Couldn't read your pack" });
      }
    },
  );

  router.get(
    "/studio/identity/candidates",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      try {
        const [rows, profile] = await Promise.all([
          herPhotos(athleteId),
          readProfile(athleteId),
        ]);
        const inPack = new Set(profile?.pack.map((e) => e.assetId) ?? []);
        // #584's tiers, for the sheet: usable first, partial fill-ins next, then the refused —
        // unread before someone-else / made-here, rejects last — each tier in prominence order.
        const TIER: Record<string, number> = {
          reference_unread: 1,
          reference_read_failed: 1,
          reference_read_capped: 1,
          not_you: 2,
          generated: 2,
          likeness_not_from_her: 2,
          likeness_no_face: 2,
          rejected: 3,
        };
        const tierOf = (refusal: PackRefusal | null) =>
          refusal === null
            ? -1
            : refusal === "face_partial"
              ? 0
              : (TIER[refusal] ?? 2);
        const unsorted: CandidateWire[] = await Promise.all(
          rows.map(async (r) => {
            const d = packDecision({
              assetId: r.id,
              origin: r.origin,
              metadata: r.metadata,
            });
            return {
              assetId: r.id,
              thumbUrl: await signedUrl(r.gcs_thumb_path ?? r.gcs_path!),
              eligible: d.refusal === null || d.refusal === "face_partial",
              refusal: d.refusal,
              reason: d.refusal ? PACK_REFUSAL_COPY[d.refusal] : null,
              inPack: inPack.has(r.id),
            };
          }),
        );
        const candidates = unsorted
          .map((c, i) => ({ c, i }))
          .sort(
            (a, b) => tierOf(a.c.refusal) - tierOf(b.c.refusal) || a.i - b.i,
          )
          .map((x) => x.c);
        res.json({ candidates });
      } catch (err) {
        logger.error({ err, athleteId }, "identity candidates failed");
        res.status(500).json({ error: "Couldn't list your photos" });
      }
    },
  );

  router.put(
    "/studio/identity/pack",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const body = PUT_BODY.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          error: "assetIds must be a list of uuids",
          field: "assetIds",
        });
        return;
      }
      try {
        const rows = await herPhotos(athleteId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        const notYours: string[] = [];
        const chosen = [];
        for (const id of body.data.assetIds) {
          const r = byId.get(id);
          if (!r) notYours.push(id);
          else
            chosen.push({
              assetId: r.id,
              origin: r.origin,
              metadata: r.metadata,
            });
        }
        const sel = selectPack(chosen);
        await writePack(athleteId, sel.pack);
        const profile = await readProfile(athleteId);
        res.json({
          profile: presentProfile(profile),
          refused: [
            ...sel.refused.map((r) => ({
              assetId: r.assetId,
              refusal: r.refusal,
              reason: PACK_REFUSAL_COPY[r.refusal],
            })),
            // Not hers, or not a stored photo: the same answer as not found, and named here so the
            // surface can say the tile did not make it rather than silently dropping it.
            ...notYours.map((assetId) => ({
              assetId,
              refusal: "not_yours" as const,
              reason: "That photo isn't in your library.",
            })),
          ],
          overCap: sel.overCap,
          partialAdmitted: sel.partialAdmitted,
          // Non-blocking (walk-driven, 24 Sep): the save went through; the sheet shows this line.
          nudge: sel.noBodyShot ? NO_BODY_SHOT_NUDGE : null,
        });
      } catch (err) {
        logger.error({ err, athleteId }, "identity pack write failed");
        res.status(500).json({ error: "Couldn't save your pack" });
      }
    },
  );

  router.post(
    "/studio/identity/calibrate",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      try {
        const profile = await readProfile(athleteId);
        if (!profile || profile.pack.length === 0) {
          res.status(409).json({ error: "Save a pack first." });
          return;
        }
        const rows = await herPhotos(athleteId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        const started = Date.now();
        const photos = [];
        for (const e of profile.pack) {
          const r = byId.get(e.assetId);
          if (!r?.gcs_path) continue;
          const obj = await readObject(r.gcs_path);
          if (!obj) continue;
          photos.push({
            assetId: e.assetId,
            bytes: obj.buf,
            mimeType: obj.contentType,
          });
        }
        const { faces, visionCalls, embedCalls } = await measureFaces(
          photos,
          "identity-pack",
        );
        const { embeddingDistance } = await import("../qa/embed.js");
        const pairs = pairwiseDistances(faces, embeddingDistance);
        const band = bandOf(pairs);
        await writeFaceSizes(
          athleteId,
          Object.fromEntries(faces.map((f) => [f.assetId, f.faceSizeFrac])),
        );
        if (band) await writeBand(athleteId, band);
        const quote = quoteMeasure(photos.length);
        // Not on the cost log: `LoggedTask` (studio/costLog.ts) is a closed union outside this PR's
        // lane. The figure is on the response and on this log line, and the ledger cites it.
        logger.info(
          {
            athleteId,
            photos: photos.length,
            faces: faces.filter((f) => f.vector).length,
            pairs: pairs.length,
            bandMin: band?.min ?? null,
            bandMax: band?.max ?? null,
            visionCalls,
            embedCalls,
            usd: quote.usd,
            ms: Date.now() - started,
          },
          "identity pack measured — band on record, not asserted",
        );
        res.json({
          profile: presentProfile(await readProfile(athleteId)),
          measured: {
            photos: photos.length,
            faces: faces.filter((f) => f.vector).length,
            misses: faces
              .filter((f) => !f.vector)
              .map((f) => ({ assetId: f.assetId, miss: f.miss })),
            pairs: pairs.length,
            band,
            usd: quote.usd,
          },
        });
      } catch (err) {
        logger.error({ err, athleteId }, "identity calibrate failed");
        res.status(500).json({ error: "Couldn't measure your pack" });
      }
    },
  );
}
