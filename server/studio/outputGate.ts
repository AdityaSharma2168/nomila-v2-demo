/**
 * outputGate — a clip or image that failed a check is shown as failed, not as done (quality-scrappy piece 5,
 * docs/probes/quality-scrappy.md, ADI-QS-GO). Behind STUDIO_OUTPUT_GATE, opt-in: the master never turns it on.
 *
 *   creative_qa.structure (piece 2)  a fail finding — black, frozen, wrong length or shape, silent where sound was paid
 *   creative_qa.checks.text          the existing name/handle check failed (qa/text.ts: a person's name or handle she
 *                                    did not ask for, legible)
 *        ──▶ creative_qa.gate  { failed, reasons, template } + one "output gate" log line per output, by template key
 *
 * ─── WHAT "FAILED" DOES AND DOES NOT MEAN ───────────────────────────────────────────────────────────────
 *
 * The OUTPUT is failed; the JOB is not (ADI-QS-GO R2). The clip is stored, the money is spent, and `generation_jobs.
 * status` stays `succeeded` — flipping it would tell her "couldn't generate that" about a clip sitting in her library
 * (videoRunner.ts says why at length). What changes is what she is SHOWN: the job read and the generate response carry
 * `gate` on the asset, and the surface says "This didn't come out right" with the reason, instead of presenting it.
 *
 * NOTHING RE-RUNS BY ITSELF. The wire carries the reasons as codes (`corrective`); a surface offers to check the cost
 * again with them, which is a NEW quote through the one preview door (routes/studio.ts, `corrective` in the body), and
 * a spend only on her own Generate tap — the same approval, the same caps, the same day total as any job. No identity
 * threshold is involved anywhere (the biometric decision is Mia's): the gate reads structure and the text check only.
 *
 * ─── WHY NOT UNDER qa/ ──────────────────────────────────────────────────────────────────────────────────
 *
 * It reads the verdict by shape, not by type: the record it reads is a jsonb object, and a type import from qa/ would
 * put the verdict machinery into the graph of everything that reads a gate.
 *
 * ⚠️ MUTATIONS (outputGate.test.ts): ignore the text check — "a name she didn't ask for fails the gate" reds; flip the
 * job to failed — "the job stays succeeded" reds.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { createLogger } from "../logger";
import type { CreativeBrief } from "./brief";
import {
  GATE_REASONS,
  isGateReason,
  type GateReason,
  type GateRecord,
} from "./gateVocab";

// The wire and the record's shape live in gateVocab.ts — no database, no brief — so the thread store (sessions.ts),
// which must reach no spend surface (routes/studioSessions.test.ts), can say a reloaded output failed.
export {
  GATE_PENDING_MS,
  gateWire,
  type GateRecord,
  type GateWire,
} from "./gateVocab";

const logger = createLogger("studio-output-gate");

/** Whether a `creative_qa` record fails the gate, and why. Pure; reads the record by shape. */
export function evaluateGate(creativeQa: unknown): {
  failed: boolean;
  reasons: GateReason[];
} {
  const qa = (creativeQa ?? {}) as {
    structure?: {
      status?: unknown;
      findings?: { reason?: unknown; severity?: unknown }[];
    };
    checks?: { text?: { status?: unknown } };
  };
  const found = new Set<GateReason>();
  if (qa.structure?.status === "fail")
    for (const f of qa.structure.findings ?? [])
      if (f.severity === "fail" && isGateReason(f.reason)) found.add(f.reason);
  if (qa.checks?.text?.status === "fail") found.add("name_or_handle");
  const reasons = GATE_REASONS.filter((r) => found.has(r));
  return { failed: reasons.length > 0, reasons };
}

/** The template an output ran under: the frozen record when there is one, else the planner's key as code. */
export function templateOf(
  brief: CreativeBrief,
  plannedKey: string | null,
): GateRecord["template"] {
  const t = brief.job.template;
  if (t) return { key: t.key, version: t.version, source: t.source };
  return plannedKey
    ? { key: plannedKey, version: null, source: "code" }
    : { key: null, version: null, source: null };
}

/**
 * Evaluate one stored output and record the gate — `creative_qa.gate`, one key, jsonb_set, her row only — with the
 * log line that counts it per template key. Call it AFTER the checks it reads have written. Never throws.
 */
export async function recordGate(
  assetId: string,
  athleteId: string,
  kind: GateRecord["kind"],
  template: GateRecord["template"],
): Promise<GateRecord | null> {
  try {
    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(
        and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
      )
      .limit(1);
    if (!row) return null;
    const qa = (row.metadata as { creative_qa?: unknown } | null)?.creative_qa;
    const { failed, reasons } = evaluateGate(qa);
    const record: GateRecord = {
      version: 1,
      at: new Date().toISOString(),
      kind,
      failed,
      reasons,
      template,
    };
    await db.execute(sql`
      UPDATE media_assets
         SET metadata = jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{creative_qa}',
               coalesce(metadata -> 'creative_qa', '{}'::jsonb) || jsonb_build_object('gate', ${JSON.stringify(record)}::jsonb)
             ),
             metadata_updated_at = now()
       WHERE id = ${assetId} AND athlete_id = ${athleteId}`);
    // THE COUNT. One line per output, keyed by template, so a pass rate per key and version is a log query away.
    logger.info(
      {
        assetId,
        kind,
        templateKey: template.key,
        templateVersion: template.version,
        templateSource: template.source,
        failed,
        reasons,
      },
      "output gate",
    );
    return record;
  } catch (err) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "output gate could not be recorded — the output is shown as it was",
    );
    return null;
  }
}

/** The gate records for a job's outputs, hers only. */
export async function gatesFor(
  athleteId: string,
  assetIds: string[],
): Promise<Map<string, GateRecord | null>> {
  if (!assetIds.length) return new Map();
  const rows = await db
    .select({ id: mediaAssets.id, metadata: mediaAssets.metadata })
    .from(mediaAssets)
    .where(
      and(
        inArray(mediaAssets.id, assetIds),
        eq(mediaAssets.athlete_id, athleteId),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      (r.metadata as { creative_qa?: { gate?: GateRecord } } | null)
        ?.creative_qa?.gate ?? null,
    ]),
  );
}
