/**
 * requalifyRetiredFloorCore.ts — legacy retirement P2-1 (owner decision 8 Oct 2026, item 4).
 *
 * Before phase 1, a cash offer with no floor of HER OWN was measured against the computed v3 rate-card mid
 * (`classification.qualification_floor.source = "rate_card_mid"`), and the stored reason told her the offer was
 * "under your floor ($876 each)". Phase 1 stopped computing that floor and masks the stored verdict at read
 * (`withoutRetiredFloor`). This pass makes it permanent: every thread whose stored floor came from the computed
 * rate is re-judged with the SAME code a fresh qualification uses (`enforceQualification`) against HER floors
 * only — her `deal_preferences.minimum_rates` as they are today.
 *
 *   · she has since set a floor for that kind of work → below_floor / workable against HER floor;
 *   · she has not → workable, "there's no floor set for this kind of work yet".
 *
 * No model call: the stored floor check already carries the terms (kind, cash, units) the classifier read.
 * Only the qualification fields of inbox_threads.classification change; every other key is kept. The update
 * is guarded on the stored source still being "rate_card_mid", so a re-run is a no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  enforceQualification,
  readStoredQualification,
  type QualificationFloors,
  type StoredQualification,
  type WorkKind,
} from "../../skills/dealQualification";

export interface RetiredFloorRow {
  thread_id:  string;
  athlete_id: string;
  deal_id:    string | null;
  before:     StoredQualification;
  after:      StoredQualification;
}

const WORK_KINDS: readonly WorkKind[] = ["social_post", "appearance", "ambassador", "autograph", "licensing", "other"];

/** The verdict a fresh qualification gives the stored terms against her own floors. Pure. */
export function requalifyAgainstHerFloor(
  stored: StoredQualification,
  minimumRates: Record<string, unknown>,
): StoredQualification {
  const f = stored.qualification_floor as any;
  const kind: WorkKind = WORK_KINDS.includes(f?.kind) ? f.kind : "other";
  const cash = Number(f?.cash);
  const units = Number.isFinite(Number(f?.units)) && Number(f?.units) > 0 ? Math.round(Number(f.units)) : 1;
  const next = enforceQualification({
    model: {
      channel:            stored.channel,
      qualification:      "workable",
      reason:             null,
      claims_known_brand: false,
      work_kind:          kind,
      work_units:         units,
      cash_amount:        Number.isFinite(cash) && cash > 0 ? cash : null,
      comp_kind:          "cash",
    },
    from:      null,
    // Her floors only. Cast rather than a typed literal: `suggested` (the computed rate card) leaves the type in P2-5.
    floors:    { minimumRates, suggested: {} } as QualificationFloors,
    messageId: stored.qualification_message_id,
  });
  // enforceQualification only returns null for a null model; keep the stored row as-is in that impossible case.
  return next ?? stored;
}

/** Every thread whose stored floor came from the computed rate card, with the verdict it would now get. Read-only. */
export async function selectRetiredFloorThreads(dbx: any = db): Promise<RetiredFloorRow[]> {
  const res = await dbx.execute(sql`
    SELECT t.id AS thread_id, t.athlete_id, t.deal_id, t.classification,
           a.deal_preferences->'minimum_rates' AS minimum_rates
      FROM inbox_threads t
      JOIN athletes a ON a.id = t.athlete_id
     WHERE t.classification->'qualification_floor'->>'source' = 'rate_card_mid'
     ORDER BY t.athlete_id, t.id
  `);
  const rows: any[] = (res as any).rows ?? res;
  const out: RetiredFloorRow[] = [];
  for (const r of rows) {
    const before = readStoredQualification(r.classification);
    if (!before) continue;
    const minimumRates = r.minimum_rates && typeof r.minimum_rates === "object" ? r.minimum_rates : {};
    out.push({
      thread_id:  r.thread_id,
      athlete_id: r.athlete_id,
      deal_id:    r.deal_id ?? null,
      before,
      after:      requalifyAgainstHerFloor(before, minimumRates),
    });
  }
  return out;
}

/** Write the new qualification fields. Guarded + idempotent: only rows still carrying the computed floor change. */
export async function applyRequalify(rows: RetiredFloorRow[], dbx: any = db): Promise<number> {
  let updated = 0;
  for (const r of rows) {
    const patch = {
      qualification:            r.after.qualification,
      qualification_reason:     r.after.qualification_reason,
      qualification_version:    r.after.qualification_version,
      qualification_floor:      r.after.qualification_floor,
    };
    const res = await dbx.execute(sql`
      UPDATE inbox_threads
         SET classification = classification || ${JSON.stringify(patch)}::jsonb
       WHERE id = ${r.thread_id}
         AND classification->'qualification_floor'->>'source' = 'rate_card_mid'
    `);
    updated += Number((res as any).rowCount ?? (res as any).affectedRows ?? 0);
  }
  return updated;
}
