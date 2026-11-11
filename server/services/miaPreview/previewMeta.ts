/**
 * miaPreview/previewMeta.ts — what an M.I.A. read of record WAS BUILT FROM, recovered from its own lineage
 * (ledger entry → evaluation run → evidence snapshot), so a preview is reproducible and nothing is stored twice:
 *
 *   inputs       which inputs were public (found facts) and which measured (connected accounts / measured facts)
 *   preliminary  true unless measured audience data from at least one connected account went into it
 *   sharpen      what would sharpen it: connect a social account that has no measured data yet, wait for an account
 *                that is connected but not yet read, and the evidence the evaluator itself said it was missing
 *
 * Reads only: intelligence_ledger, mia_evaluation_runs, mia_evidence_snapshots, memory_facts, connected_accounts.
 * Never a retiring table. Copy-free apart from `label`, the one line the brief asked the API to carry.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts, intelligenceLedger, memoryFacts, miaEvaluationRuns, miaEvidenceSnapshots } from "../../../shared/schema";
import { CONNECTORS } from "../../agent/onboarding/catalog";
import type { MiaPreviewInput, MiaSharpenStep } from "../../../shared/agent";
import { FOUND_SOURCE_CLASS, MEASURED_SOURCE_CLASS, MEMORY_SOURCE_PLATFORM, measuredMetricOf } from "./memoryAdapter";

export type { MiaPreviewInput } from "../../../shared/agent";
/** What would sharpen a preview: each step names the connector it needs (null for evidence). */
export type MiaSharpen = MiaSharpenStep;

export const PRELIMINARY_LABEL = "Preliminary — connect to sharpen";
export const PRELIMINARY_AWAITING_LABEL = "Preliminary — sharpening with your connected accounts";

export interface PreviewMeta {
  preliminary: boolean;
  label: string | null;
  inputs: { public: MiaPreviewInput[]; measured: MiaPreviewInput[] };
  sharpen: MiaSharpen[];
  provenance: { ledgerEntryId: string; evaluationRunId: string | null; snapshotId: string | null; digest: string | null; evidenceAsOf: string } | null;
}

interface SourceRow { platform: string; accountId: string; observedAt: string | null; sourceClass: string }

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);

/** Pure: which inputs a snapshot's sources name, labelled from the facts they point at. */
export function inputsFrom(sources: SourceRow[], facts: Map<string, { claim: string; sourceUrl: string | null; sourceTitle: string | null; sourceRef: string | null; observedOn: string | null }>): PreviewMeta["inputs"] {
  const pub: MiaPreviewInput[] = [];
  const measured: MiaPreviewInput[] = [];
  for (const s of sources) {
    if (s.platform === MEMORY_SOURCE_PLATFORM) {
      const f = facts.get(s.accountId);
      if (!f) continue;
      const input = {
        factId: s.accountId, label: f.claim, observedAt: f.observedOn ?? s.observedAt ?? null,
        source: { url: f.sourceUrl, title: f.sourceTitle, ref: f.sourceRef },
      };
      if (s.sourceClass === FOUND_SOURCE_CLASS) pub.push({ kind: "public", platform: null, ...input });
      else if (s.sourceClass === MEASURED_SOURCE_CLASS) measured.push({ kind: "measured", platform: measuredMetricOf(f.sourceRef)?.platform ?? null, ...input });
    } else if (s.sourceClass === MEASURED_SOURCE_CLASS) {
      measured.push({
        kind: "measured", factId: null, platform: s.platform,
        label: `Connected ${s.platform} account${s.accountId && s.accountId !== s.platform ? ` (@${s.accountId.replace(/^@+/, "")})` : ""}`,
        source: { url: null, title: "Connected account", ref: null }, observedAt: s.observedAt ?? null,
      });
    }
  }
  return { public: pub, measured };
}

/** Pure: preliminary unless measured data from at least one connected account went in. */
export const isPreliminary = (sources: SourceRow[]): boolean => !sources.some((s) => s.sourceClass === MEASURED_SOURCE_CLASS);

/** Pure: what would sharpen it. Social connectors only (the ones that carry audience data), in the catalog's order. */
export function sharpenFrom(measuredPlatforms: ReadonlySet<string>, connected: ReadonlySet<string>, missingEvidence: string[]): MiaSharpen[] {
  const out: MiaSharpen[] = [];
  for (const c of CONNECTORS.filter((x) => x.kind === "social")) {
    if (measuredPlatforms.has(c.id)) continue;
    out.push(connected.has(c.id)
      ? { kind: "awaiting_data", connector: c.id, service: c.service, reason: "connected_not_yet_read" }
      : { kind: "connect", connector: c.id, service: c.service, reason: "measured_audience" });
  }
  for (const text of missingEvidence.slice(0, 3)) out.push({ kind: "evidence", connector: null, text });
  return out;
}

export function labelFor(preliminary: boolean, sharpen: MiaSharpen[]): string | null {
  if (!preliminary) return null;
  return sharpen.some((s) => s.kind === "connect") ? PRELIMINARY_LABEL : PRELIMINARY_AWAITING_LABEL;
}

async function connectedSet(athleteId: string): Promise<Set<string>> {
  const rows = await db.select({ platform: connectedAccounts.platform }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  return new Set(rows.map((r) => r.platform));
}

/**
 * The meta for an athlete's read of record (`record` = getMarketability()), or for no read at all (record null:
 * preliminary, nothing used yet, everything that would sharpen it).
 */
export async function readPreviewMeta(athleteId: string, record: { entryId: string; evidenceAsOf: string; value: Record<string, unknown> } | null): Promise<PreviewMeta> {
  const connected = await connectedSet(athleteId);
  if (!record) {
    const sharpen = sharpenFrom(new Set(), connected, []);
    return { preliminary: true, label: labelFor(true, sharpen), inputs: { public: [], measured: [] }, sharpen, provenance: null };
  }
  const [lineage] = await db.select({ runId: intelligenceLedger.evaluation_run_id, snapshotId: miaEvaluationRuns.snapshot_id, sources: miaEvidenceSnapshots.social_sources, digest: miaEvidenceSnapshots.digest })
    .from(intelligenceLedger)
    .leftJoin(miaEvaluationRuns, eq(miaEvaluationRuns.id, intelligenceLedger.evaluation_run_id))
    .leftJoin(miaEvidenceSnapshots, eq(miaEvidenceSnapshots.id, miaEvaluationRuns.snapshot_id))
    .where(and(eq(intelligenceLedger.id, record.entryId), eq(intelligenceLedger.subject_id, athleteId)))
    .limit(1);
  const sources: SourceRow[] = (Array.isArray(lineage?.sources) ? lineage!.sources : [])
    .filter((s: any) => s && typeof s.platform === "string")
    .map((s: any) => ({ platform: String(s.platform), accountId: String(s.accountId ?? ""), observedAt: typeof s.observedAt === "string" ? s.observedAt : null, sourceClass: String(s.sourceClass ?? "") }));
  const factIds = sources.filter((s) => s.platform === MEMORY_SOURCE_PLATFORM && /^[0-9a-f-]{36}$/i.test(s.accountId)).map((s) => s.accountId);
  const factRows = factIds.length
    ? await db.select({ id: memoryFacts.id, claim: memoryFacts.claim, sourceUrl: memoryFacts.source_url, sourceTitle: memoryFacts.source_title, sourceRef: memoryFacts.source_ref, observedOn: memoryFacts.observed_on })
      .from(memoryFacts).where(and(eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.id, factIds)))
    : [];
  const inputs = inputsFrom(sources, new Map(factRows.map((f) => [f.id, f])));
  const preliminary = isPreliminary(sources);
  const measuredPlatforms = new Set(inputs.measured.map((m) => m.platform).filter((p): p is string => !!p));
  const sharpen = sharpenFrom(measuredPlatforms, connected, strings(record.value?.importantMissingData));
  return {
    preliminary, label: labelFor(preliminary, sharpen), inputs, sharpen,
    provenance: { ledgerEntryId: record.entryId, evaluationRunId: lineage?.runId ?? null, snapshotId: lineage?.snapshotId ?? null, digest: lineage?.digest ?? null, evidenceAsOf: record.evidenceAsOf },
  };
}
