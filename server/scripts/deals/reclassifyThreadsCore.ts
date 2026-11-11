/**
 * reclassifyThreadsCore.ts — re-run the CURRENT classifier over one athlete's threads that carry a given stored
 * category, after the classifier prompt changed what that category means.
 *
 * Why: the 8 Oct prompt separates press (MEDIA — an outlet's coverage OF her) from a content collaboration (making
 * content WITH her → PAID). Threads classified before that were read under the old wording, which listed a video
 * "day in the life" as MEDIA, so a creator's collaboration could sit on her board as an "Interview". Nothing here
 * decides what an email is: the model does, through services/reclassifyThread — the same re-read and the same write
 * as her "reclassify" tap. No keyword, no name.
 *
 * Dry run: classifies each thread (a model call each) and reports what WOULD change; writes nothing. Apply: writes only
 * the threads whose category or media_kind changes, reusing the dry run's classification (no second model call per
 * thread). A change that would set a deal aside (re-read as NOISE / FAN → "demoted") is NOT written unless
 * `allowDemote`: the re-read uses the thread's LATEST inbound message, which on a long thread can be a scheduling
 * reply rather than the ask, so a demotion needs a person's look first. Reports carry ids, categories and outcomes
 * only — never message text.
 */
import { and, eq, sql } from "drizzle-orm";
import { inboxThreads } from "../../../shared/schema";
import { reclassifyThread, type ClassifyFn } from "../../services/reclassifyThread";

export interface ReclassifyRow {
  thread_id: string;
  deal_id: string | null;
  from_category: string | null;
  to_category: string | null;
  from_media_kind: string | null;
  to_media_kind: string | null;
  /** promoted / demoted / updated: what the write does to the deal (see services/reclassifyThread). */
  outcome: string | null;
  changed: boolean;
  written: boolean;
  /** Set when a change was held back (a demotion without allowDemote). */
  held?: string;
  /** The structural rule that decided the re-read, when one did (see ReclassifyResult.structural). */
  structural?: string;
  /** A payment notice: where it lands as payment paperwork (deal / brand) or null (stays noise). */
  payment?: "deal" | "brand" | null;
  error?: string;
}

export interface ReclassifyReport {
  athlete_id: string;
  category: string;
  generated_at: string;
  mode: "dry-run" | "apply";
  rows: ReclassifyRow[];
  counts: { examined: number; changed: number; category_changed: number; written: number; held: number; errors: number; by_new_category: Record<string, number> };
}

/** The athlete's threads whose stored classification category is `category`. */
export async function selectThreads(dbx: any, athleteId: string, category: string): Promise<Array<{ id: string; deal_id: string | null }>> {
  return dbx.select({ id: inboxThreads.id, deal_id: inboxThreads.deal_id }).from(inboxThreads)
    .where(and(eq(inboxThreads.athlete_id, athleteId), sql`${inboxThreads.classification} ->> 'category' = ${category}`))
    .orderBy(inboxThreads.id);
}

export async function reclassifyAthlete(
  dbx: any,
  athleteId: string,
  o: { category: string; apply: boolean; classify: ClassifyFn; allowDemote?: boolean; now?: Date },
): Promise<ReclassifyReport> {
  const threads = await selectThreads(dbx, athleteId, o.category);
  const rows: ReclassifyRow[] = [];
  for (const t of threads) {
    const base = { thread_id: t.id, deal_id: t.deal_id ?? null };
    try {
      const seen = await reclassifyThread(athleteId, t.id, { classify: o.classify, dryRun: true });
      if (!seen.ok) { rows.push({ ...base, from_category: o.category, to_category: null, from_media_kind: null, to_media_kind: null, outcome: null, changed: false, written: false, error: seen.error }); continue; }
      const to = seen.classification;
      const changed = to.category !== seen.previous_category || (to.media_kind ?? null) !== seen.previous_media_kind;
      let written = false;
      // A demotion the deterministic non-deal rules decided on a one-message thread (the deal was minted from that
      // message) is applied like any other change; every other demotion still needs --allow-demote.
      const held = changed && seen.outcome === "demoted" && !o.allowDemote && !seen.structural ? "would set the deal aside: needs --allow-demote" : undefined;
      if (o.apply && changed && !to.llm_error && !held) {
        const w = await reclassifyThread(athleteId, t.id, { classify: async () => to });
        if (!w.ok) throw new Error(w.error);
        written = true;
      }
      rows.push({
        ...base, from_category: seen.previous_category, to_category: to.category, from_media_kind: seen.previous_media_kind,
        to_media_kind: to.media_kind ?? null, outcome: seen.outcome, changed, written, ...(held ? { held } : {}), ...(seen.structural ? { structural: seen.structural } : {}), ...(seen.payment !== undefined ? { payment: seen.payment } : {}), ...(to.llm_error ? { error: "classifier error" } : {}),
      });
    } catch (e: any) {
      rows.push({ ...base, from_category: o.category, to_category: null, from_media_kind: null, to_media_kind: null, outcome: null, changed: false, written: false, error: e?.message ?? String(e) });
    }
  }
  const by_new_category: Record<string, number> = {};
  for (const r of rows) if (r.to_category && r.to_category !== r.from_category) by_new_category[r.to_category] = (by_new_category[r.to_category] ?? 0) + 1;
  return {
    athlete_id: athleteId, category: o.category, generated_at: (o.now ?? new Date()).toISOString(), mode: o.apply ? "apply" : "dry-run", rows,
    counts: {
      examined: rows.length,
      changed: rows.filter((r) => r.changed).length,
      category_changed: rows.filter((r) => r.to_category && r.to_category !== r.from_category).length,
      written: rows.filter((r) => r.written).length,
      held: rows.filter((r) => r.held).length,
      errors: rows.filter((r) => r.error).length,
      by_new_category,
    },
  };
}

export function renderMarkdown(r: ReclassifyReport): string {
  return [
    `# Reclassify ${r.category} threads — ${r.mode} — athlete \`${r.athlete_id}\``,
    "",
    `Generated ${r.generated_at}. Examined ${r.counts.examined}; category changes ${r.counts.category_changed} ${JSON.stringify(r.counts.by_new_category)}; written ${r.counts.written}; held ${r.counts.held}; errors ${r.counts.errors}.`,
    "",
    "| thread | deal | category | media_kind | outcome | written |",
    "|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| \`${x.thread_id}\` | ${x.deal_id ? `\`${x.deal_id}\`` : "—"} | ${x.from_category ?? "—"} → ${x.to_category ?? "—"} | ${x.from_media_kind ?? "—"} → ${x.to_media_kind ?? "—"} | ${x.error ? `error: ${x.error}` : x.held ? `${x.outcome} (held)` : x.outcome ?? "—"}${x.structural ? " · billing rule" : ""}${x.payment !== undefined ? ` · payment → ${x.payment ?? "noise"}` : ""} | ${x.written ? "yes" : "no"} |`),
    "",
  ].join("\n");
}
