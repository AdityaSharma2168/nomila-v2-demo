/**
 * templateScore — how each output of a prompt template scored, per key and version (quality-scrappy piece 10,
 * ADI-QS-3 / ADI-QS-5 (2)). Behind STUDIO_PROMPT_REGISTRY (under the master): it measures the templates the registry
 * serves, and it is observation only — it changes nothing she sees.
 *
 *   creative_qa.checks.text        the name/handle check (qa/text.ts)                    every output
 *   creative_qa.checks.adherence   did the edit do what was asked (qa/adherence.ts)      EDITS only — a generate and a
 *                                                                                        clip run no adherence judge
 *   creative_qa.gate               the output gate's verdict (outputGate.ts, piece 5)    when the gate ran
 *        ──▶ creative_qa.score + one "template score" log line per output, with the template's key and version
 *
 * ─── ON THE ASSET, NEVER ON THE BRIEF ───────────────────────────────────────────────────────────────────
 *
 * The brief is frozen at the quote and a score exists only after the run, so the score sits where the gate's verdict
 * sits (ADI-QS-GO R2): on the asset, one jsonb key, her row only. The frozen brief is never touched (ADI-QS-5 (2)). A
 * pass rate per key and version is a query over the log line — no table (ADI-QS-3: "if you need a table, stop").
 *
 * ─── A SIGNAL THAT WAS NOT MEASURED IS NOT A PASS ───────────────────────────────────────────────────────
 *
 * Each signal is pass, flag, fail or UNMEASURED — a check that did not run (its flag off, a timeout, "unknown") never
 * counts toward a template's pass rate as if it had passed.
 *
 * ⚠️ MUTATIONS (templateScore.test.ts): M10a an unmeasured signal scored as a pass — "a check that did not run is
 * unmeasured, never a pass" reds; M10b adherence read on a generate — "adherence is an edit's alone" reds; M10c the score
 * written over the gate — "the score sits beside the gate and the verdict" reds.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { createLogger } from "../logger";
import { isGateReason, type GateReason } from "./gateVocab";
import type { GateRecord } from "./outputGate";

const logger = createLogger("studio-template-score");

export type SignalScore = "pass" | "flag" | "fail" | "unmeasured";

/** `metadata.creative_qa.score`. */
export interface ScoreRecord {
  version: 1;
  at: string;
  kind: GateRecord["kind"];
  template: GateRecord["template"];
  text: SignalScore;
  /** "n/a" on a generate and a clip: no adherence judge runs on them. */
  adherence: SignalScore | "n/a";
  gate: "pass" | "fail" | "unmeasured";
  gateReasons: GateReason[];
}

const signal = (status: unknown): SignalScore =>
  status === "pass" || status === "flag" || status === "fail"
    ? status
    : "unmeasured";

/** The score of one output, from its `creative_qa` record read by shape. Pure. */
export function scoreOf(
  creativeQa: unknown,
  kind: ScoreRecord["kind"],
  mode: "generate" | "edit",
  template: ScoreRecord["template"],
  at = new Date(),
): ScoreRecord {
  const qa = (creativeQa ?? {}) as {
    checks?: {
      text?: { status?: unknown };
      adherence?: { status?: unknown };
    };
    gate?: { failed?: unknown; reasons?: unknown };
  };
  const gate = qa.gate;
  return {
    version: 1,
    at: at.toISOString(),
    kind,
    template,
    text: signal(qa.checks?.text?.status),
    adherence:
      kind === "image" && mode === "edit"
        ? signal(qa.checks?.adherence?.status)
        : "n/a",
    gate:
      gate && typeof gate.failed === "boolean"
        ? gate.failed
          ? "fail"
          : "pass"
        : "unmeasured",
    gateReasons: Array.isArray(gate?.reasons)
      ? gate.reasons.filter(isGateReason)
      : [],
  };
}

/**
 * Score one stored output and record it — `creative_qa.score`, one key, jsonb_set, her row only — with the log line
 * that counts it per template key and version. Call it LAST, after the checks and the gate have written. Never throws.
 */
export async function recordScore(
  assetId: string,
  athleteId: string,
  kind: ScoreRecord["kind"],
  mode: "generate" | "edit",
  template: ScoreRecord["template"],
): Promise<ScoreRecord | null> {
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
    const record = scoreOf(qa, kind, mode, template);
    await db.execute(sql`
      UPDATE media_assets
         SET metadata = jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{creative_qa}',
               coalesce(metadata -> 'creative_qa', '{}'::jsonb) || jsonb_build_object('score', ${JSON.stringify(record)}::jsonb)
             ),
             metadata_updated_at = now()
       WHERE id = ${assetId} AND athlete_id = ${athleteId}`);
    // THE COUNT, per key AND version: one line per output, so a template's pass rate is a log query away.
    logger.info(
      {
        assetId,
        kind,
        templateKey: template.key,
        templateVersion: template.version,
        templateSource: template.source,
        text: record.text,
        adherence: record.adherence,
        gate: record.gate,
        gateReasons: record.gateReasons,
      },
      "template score",
    );
    return record;
  } catch (err) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "template score could not be recorded — nothing she sees changes",
    );
    return null;
  }
}
