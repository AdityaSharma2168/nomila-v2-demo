/**
 * studio/qa/routes — the verdict, read back for the person approving (PR 11, R-4/R-5).
 *
 *   GET /studio/assets/:assetId/qa   → { assetId, verdict, cost }
 *
 * ─── OFF IS A 404, AND OFF IS TODAY ─────────────────────────────────────────────────────────────
 *
 * Behind STUDIO_QA_DISPLAY (studio/config.ts `qaDisplayEnabled`), default off, paired with the
 * client's EXPO_PUBLIC_STUDIO_QA_DISPLAY. Off, the door is not there — a 404 before any row is read,
 * the same shape studio/edit/routes.ts uses, so the flag's state is not readable from outside.
 * ⚠️ MUTATION (routes.test): answer with the flag off — "verdict chip renders with STUDIO_QA_DISPLAY
 * off" reds by name on the server half.
 *
 * ─── ONE READER ────────────────────────────────────────────────────────────────────────────────
 *
 * The verdict is read through `readVerdict` (qa/record.ts) by way of `joinRow` (qa/join.ts) — the
 * same walk the join script prints — and nothing here parses `metadata.creative_qa` itself.
 *
 * ─── WHAT IS SAID, AND WHAT IS NEVER SAID ───────────────────────────────────────────────────────
 *
 * The wire shape is flag-or-pass wording and the cost. It carries no check score, no distance, no
 * threshold: `identityObservation` is captioned as an observation with its own caveat
 * (qa/identity.ts DEAD_RULER_CAVEAT) and its numbers stay on the record, not on the wire. A fail
 * reads as flagged too — this surface exists so she can look, not so a number can decide for her.
 * No loop, no retry, no reroll action: `video/reroll.ts` stays `acted: false`, and nothing here
 * spends.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";

import { createLogger } from "../../logger";
import { qaDisplayEnabled } from "../config";
import { joinRow, type JoinRow } from "./join";
import type { CreativeQaVerdict } from "./verdict";
import {
  STRUCTURE_LINE,
  type StructureRecord,
  type StructureReason,
} from "../video/structureVocab";

const logger = createLogger("studio/qa/routes");

const ID = z.string().uuid();

/** What the card may say. Two words of state, never a score. */
export type QaWording = "pass" | "flag";

export interface QaVerdictWire {
  wording: QaWording;
  /** The sentence beside the chip. Written here, once, so every surface says the same thing. */
  label: string;
  subject: CreativeQaVerdict["subject"];
  at: string;
  /** How many checks could not answer — a count of silence, not a score. */
  unknownChecks: number;
  identityObservation: {
    /** Always this caption. An observation is never a check (qa/verdict.ts, qa/identity.ts). */
    caption: "Observation only, not a check";
    caveat: string;
  } | null;
  /**
   * PR 17 (R-6): the clip's frame-to-frame face observation. Same caption, same posture. `line` is
   * a time and a count — never a distance, a ratio, or a pass/fail word. ABSENT (not null) when the
   * record has none, so an old wire is unchanged. ⚠️ MUTATION (routes.test "drift shown as
   * pass/fail"): word the line with the verdict's vocabulary.
   */
  driftObservation?: {
    caption: "Observation only, not a check";
    line: string;
  };
  /** What the inspection itself cost. */
  spendUsd: number;
}

export interface QaCostWire {
  usd: number;
  basis: "authoritative" | "estimated";
  /** Where the figure came from: the edit row's actual cost, or the job's quote. */
  source: "edit_row" | "job_quote";
}

/**
 * The structure check (quality-scrappy piece 2, video/structure.ts): flag-or-pass, the chip's label for it, and one
 * plain sentence per reason — never a duration, a ratio or a threshold. ABSENT (not null) when the record has none,
 * and when the check could not answer (`unknown` is not a pass, and the chip has no third word for it), so a wire for
 * an asset STUDIO_CLIP_QC never saw is byte-for-byte the wire it was.
 */
export interface QaStructureWire {
  wording: QaWording;
  label: string;
  lines: string[];
}

export interface QaWire {
  assetId: string;
  verdict: QaVerdictWire | null;
  cost: QaCostWire | null;
  structure?: QaStructureWire;
}

/** flag-or-pass, and nothing else. A fail is flagged: the surface shows, it does not decide. */
export const wordingFor = (overall: CreativeQaVerdict["overall"]): QaWording =>
  overall === "pass" ? "pass" : "flag";

export const LABEL: Record<QaWording, string> = {
  pass: "Passed the check",
  flag: "Flagged for a look",
};

export function presentVerdict(v: CreativeQaVerdict): QaVerdictWire {
  const wording = wordingFor(v.overall);
  return {
    wording,
    label: LABEL[wording],
    subject: v.subject,
    at: v.at,
    unknownChecks: v.unknownChecks,
    identityObservation: v.identityObservation
      ? {
          caption: "Observation only, not a check",
          caveat: v.identityObservation.caveat,
        }
      : null,
    // Present ONLY when the record carries one: a wire for a pre-PR-17 record, or with the flag off,
    // is byte-for-byte the wire it was (P-off).
    ...(v.driftObservation
      ? {
          driftObservation: {
            caption: "Observation only, not a check" as const,
            line: driftLine(v.driftObservation),
          },
        }
      : {}),
    spendUsd: v.spend.usd,
  };
}

/** A time and a count. No number that could be read against a line. */
export function driftLine(
  d: NonNullable<CreativeQaVerdict["driftObservation"]>,
): string {
  const faces = d.frames.filter((f) => f.face).length;
  if (faces < 2) return "Face was not measurable across this clip.";
  const at =
    d.maxStepAtSec === null
      ? ""
      : ` Changed most around ${d.maxStepAtSec.toFixed(1)}s.`;
  const her = d.isHer ? " Compared with your pack too." : "";
  return `Face measured across ${faces} frames.${at}${her}`;
}

/**
 * The cost. An accepted typed edit carries its ACTUAL cost on the edit row (studio/edit/engine.ts
 * writes `cost_usd` from what the router returned); its basis is whatever the matching cost line
 * says, estimated when no line is in this instance's log. A generate has only the job's quote, and
 * says so.
 */
export function presentCost(row: JoinRow): QaCostWire | null {
  if (row.edit && row.edit.cost_usd !== null) {
    const line = row.costLines.find((l) => l.editPreviewId === row.edit!.id);
    return {
      usd: Number(row.edit.cost_usd),
      basis: line?.costBasis ?? "estimated",
      source: "edit_row",
    };
  }
  if (row.job && row.job.cost_estimated_usd !== null) {
    return {
      usd: Number(row.job.cost_estimated_usd),
      basis:
        row.job.cost_basis === "authoritative" ? "authoritative" : "estimated",
      source: "job_quote",
    };
  }
  return null;
}

/** The structure record as the chip may show it, or undefined — see QaStructureWire. */
export function presentStructure(
  s: StructureRecord | undefined,
): QaStructureWire | undefined {
  if (!s || s.status === "unknown") return undefined;
  const wording: QaWording = s.status === "pass" ? "pass" : "flag";
  const reasons = [
    ...new Set(s.findings.map((f) => f.reason)),
  ] as StructureReason[];
  return {
    wording,
    label: LABEL[wording],
    lines: reasons.map((r) => STRUCTURE_LINE[r]),
  };
}

/**
 * Whether `creative_qa` holds a vision VERDICT, or only records other writers keep beside one (quality-scrappy:
 * `structure`, `gate`). A stitch, and a clip with STUDIO_CREATIVE_QA off, carry the structure record alone — and
 * presenting that as a verdict would read `overall` and `spend` that are not there.
 */
const isVerdict = (v: unknown): v is CreativeQaVerdict =>
  !!v && typeof (v as CreativeQaVerdict).overall === "string";

export function presentQa(row: JoinRow): QaWire | null {
  if (!row.asset) return null;
  const record = row.verdict as
    | (CreativeQaVerdict & { structure?: StructureRecord })
    | null;
  const structure = presentStructure(record?.structure);
  return {
    assetId: row.asset.id,
    verdict: isVerdict(record) ? presentVerdict(record) : null,
    cost: presentCost(row),
    ...(structure ? { structure } : {}),
  };
}

/** Off, the door is not there: a 404, not a 403, so the flag's state is not readable from outside. */
const requireDisplay: RequestHandler = (_req, res, next) => {
  if (!qaDisplayEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

export function registerQaRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  const guarded = [...gate, requireDisplay] as const;

  router.get(
    "/studio/assets/:assetId/qa",
    ...guarded,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const id = ID.safeParse(req.params.assetId);
      if (!id.success) {
        res
          .status(400)
          .json({ error: "assetId must be a uuid", field: "assetId" });
        return;
      }
      try {
        const wire = presentQa(await joinRow(athleteId, { assetId: id.data }));
        if (!wire) {
          res.status(404).json({ error: "We couldn't find that asset." });
          return;
        }
        res.json(wire);
      } catch (err) {
        logger.error({ err, athleteId, assetId: id.data }, "qa read failed");
        res.status(500).json({ error: "Couldn't read that check" });
      }
    },
  );
}
