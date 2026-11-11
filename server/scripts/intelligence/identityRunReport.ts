/**
 * identityRunReport.ts — READ-ONLY report of one athlete's latest Research v3 refresh, First Look refresh and
 * Identity Intelligence recompute.
 *
 *   npx tsx --require dotenv/config server/scripts/intelligence/identityRunReport.ts --athlete <uuid> --out <dir>
 *
 * READ-ONLY, by construction: the pool's session is put into `default_transaction_read_only` before any query
 * runs (any INSERT/UPDATE/DELETE a future edit might add would fail), no provider is called and no HTTP request
 * is made. Writes two files to --out: a full JSON dump and a readable Markdown summary covering —
 *
 *   1. Research discovery for the athlete's latest workflow run (research_runs Q1–Q6/READ/signals; athlete_media;
 *      signature_moments; narrative_claim topics; outlet source_type distribution).
 *   2. The targeted read (READ step): which sources were read and what each one produced (athlete_statement rows,
 *      other source_read evidence by kind).
 *   3. First Look's latest snapshot per platform, and the social_features profile.bio per platform.
 *   4. The latest identity_intelligence ledger row: contract version, envelope/claim counts by kind/tier.
 *   5. That row's raw value JSON.
 *   6. Validation: every basis ref in the latest row resolved to its underlying text, tier and source.
 *   7. A comparison with the previous identity_intelligence row (contract-agnostic field diff + cited-basis
 *      counts + newly used / dropped basis kinds).
 *
 * Tolerant of missing pieces throughout (no READ row, no 0.2 contract yet, no bios, …) — every section says
 * "none" rather than throwing. Reads the ledger `value` column as untyped JSON and detects the contract version
 * from `value.contract`, so it works whether the athlete's latest row is identity-intelligence/0.1 or a later one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../db";
import {
  athleteAsserted, athleteFacts, athleteSnapshots, deals, intelligenceLedger, mediaAssets, objectives,
  researchEvidence, researchRuns, researchSourcePayloads, socialFeatures,
} from "../../../shared/schema";
import type { FirstLook } from "../../skills/firstLook";
import { parseBasisRef, refKey, type BasisRef } from "../../services/intelligence/identityIntelligence/contract";
import {
  collectBasisRefsExcluding, compareValueFields, countByKey, countByKindTier, countByTier, diffKinds, kindsOf,
  renderMarkdownReport,
  type AthleteMediaItem, type AthleteStatementItem, type BasisResolution, type BioRow, type ComparisonResult,
  type FirstLookPlatform, type IdentityRunReport, type LedgerRowSummary, type PayloadSummary, type ReadSourceSummary,
  type ResearchDiscovery, type RunSummary, type SignatureMoment, type TargetedRead,
} from "./identityRunReportFormat";

// ─── read-only enforcement: every pooled connection starts its session read-only ──
pool.on("connect", (client) => {
  client.query("SET default_transaction_read_only = on").catch((err: unknown) => {
    // If this fails the connection is unusable for our purpose; surface loudly rather than risk a write.
    // eslint-disable-next-line no-console
    console.error("could not set the session read-only; refusing to proceed", err);
    process.exit(1);
  });
});

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const QUERY_ORDER: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, Q5: 5, Q6: 6, READ: 7 };

// ─── 1. Research discovery ──────────────────────────────────────────────────────

async function researchDiscoveryFor(athleteId: string): Promise<ResearchDiscovery | null> {
  const [latest] = await db.select({ workflow_run_id: researchRuns.workflow_run_id })
    .from(researchRuns)
    .where(and(eq(researchRuns.athlete_id, athleteId), sql`${researchRuns.workflow_run_id} IS NOT NULL`))
    .orderBy(desc(researchRuns.started_at)).limit(1);

  // Legacy fallback: no workflow-linked run at all. Report on the single latest run instead of nothing.
  const workflowRunId = latest?.workflow_run_id ?? null;
  const runRows = workflowRunId
    ? await db.select().from(researchRuns).where(eq(researchRuns.workflow_run_id, workflowRunId))
    : await db.select().from(researchRuns).where(eq(researchRuns.athlete_id, athleteId)).orderBy(desc(researchRuns.started_at)).limit(1);
  if (!runRows.length) return null;

  const runs: RunSummary[] = runRows
    .map((r): RunSummary => ({
      id: r.id, queryId: r.query_id, domain: r.domain, status: r.status, calls: r.calls,
      signalCalls: r.signal_calls, otherCalls: r.other_calls,
      estimatedCostUsd: r.estimated_cost_usd, confidenceOut: r.confidence_out,
      startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    }))
    .sort((a, b) => (QUERY_ORDER[a.queryId ?? ""] ?? 0) - (QUERY_ORDER[b.queryId ?? ""] ?? 0));

  const runIds = runRows.map((r) => r.id);
  const evidence = runIds.length
    ? await db.select().from(researchEvidence).where(inArray(researchEvidence.run_id, runIds))
    : [];

  const athleteMedia: AthleteMediaItem[] = evidence
    .filter((e) => e.kind === "press_mention" || e.kind === "crossover_appearance")
    .map((e) => {
      const c = (e.claim ?? {}) as Record<string, unknown>;
      return {
        kind: e.kind,
        title: (c.title as string) ?? (c.headline as string) ?? null,
        outlet: (c.outlet as string) ?? null,
        outletType: (c.outletType as string) ?? null,
        medium: (c.medium as string) ?? null,
        participation: (c.participation as string) ?? null,
        date: (c.date as string) ?? null,
        url: (c.url as string) ?? e.source_url ?? null,
        athleteQuoted: typeof c.athleteQuoted === "boolean" ? c.athleteQuoted : null,
      };
    });

  const signatureMoments: SignatureMoment[] = evidence
    .filter((e) => e.kind === "career_event" && ((e.claim as any)?.eventKind === "signature"))
    .map((e) => {
      const c = (e.claim ?? {}) as Record<string, unknown>;
      return { event: (c.event as string) ?? null, date: (c.date as string) ?? null, competition: (c.competition as string) ?? null };
    });

  const narrativeTopics = countByKey(
    evidence.filter((e) => e.kind === "narrative_claim").map((e) => ((e.claim as any)?.topic as string) ?? "(no topic)"),
  );

  const sourceTypeDistribution = countByKey(evidence.map((e) => e.source_type ?? "unknown"));

  return { workflowRunId, runs, athleteMedia, signatureMoments, narrativeTopics, sourceTypeDistribution };
}

// ─── 2. Targeted read ───────────────────────────────────────────────────────────

async function targetedReadFor(workflowRunId: string | null): Promise<TargetedRead | null> {
  if (!workflowRunId) return null;
  const [readRun] = await db.select().from(researchRuns)
    .where(and(eq(researchRuns.workflow_run_id, workflowRunId), eq(researchRuns.query_id, "READ")));
  if (!readRun) return null;

  const summary = (readRun.summary ?? {}) as any;
  const readRecord = summary?.step?.read ?? summary?.read ?? null;
  const sources: ReadSourceSummary[] = Array.isArray(readRecord?.sources)
    ? readRecord.sources.map((s: any) => ({
        url: s?.url ?? null, mode: s?.mode ?? null, completed: s?.completed ?? null, refused: s?.refused ?? null,
        claims: s?.claims ?? null, statements: s?.statements ?? null, paraphrases: s?.paraphrases ?? null, dropped: s?.dropped ?? null,
      }))
    : [];
  const readSpec: string | null = readRecord?.spec ?? null;

  const payloadRows = await db.select().from(researchSourcePayloads).where(eq(researchSourcePayloads.run_id, readRun.id));
  const payloads: PayloadSummary[] = payloadRows.map((p) => ({
    id: p.id, provider: p.provider, model: p.model, endpointFamily: p.endpoint_family,
    bytes: p.bytes ?? null, fetchedAt: new Date(p.fetched_at).toISOString(), payloadHash: p.payload_hash,
  }));

  const evidence = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, readRun.id));

  const athleteStatements: AthleteStatementItem[] = evidence
    .filter((e) => e.kind === "athlete_statement")
    .map((e) => {
      const c = (e.claim ?? {}) as Record<string, unknown>;
      return {
        text: (c.text as string) ?? "",
        topics: Array.isArray(c.topics) ? (c.topics as string[]) : [],
        medium: (c.medium as string) ?? null,
        timestampSeconds: typeof c.timestampSeconds === "number" ? (c.timestampSeconds as number) : null,
        outlet: (c.outlet as string) ?? null,
        sourceTitle: (c.sourceTitle as string) ?? null,
      };
    });

  const otherEvidence = evidence.filter((e) => e.kind !== "athlete_statement");
  const otherEvidenceByKind: Record<string, { count: number; samples: string[] }> = {};
  for (const e of otherEvidence) {
    const c = (e.claim ?? {}) as Record<string, unknown>;
    const text = (c.text as string) ?? (c.statement as string) ?? (c.event as string) ?? (c.headline as string) ?? JSON.stringify(c).slice(0, 80);
    const bucket = (otherEvidenceByKind[e.kind] ??= { count: 0, samples: [] });
    bucket.count++;
    if (bucket.samples.length < 3) bucket.samples.push(String(text).slice(0, 100));
  }

  const runSummary: RunSummary = {
    id: readRun.id, queryId: readRun.query_id, domain: readRun.domain, status: readRun.status, calls: readRun.calls,
    signalCalls: readRun.signal_calls, otherCalls: readRun.other_calls,
    estimatedCostUsd: readRun.estimated_cost_usd, confidenceOut: readRun.confidence_out,
    startedAt: new Date(readRun.started_at).toISOString(), finishedAt: readRun.finished_at ? new Date(readRun.finished_at).toISOString() : null,
  };

  return { readRun: runSummary, readSpec, sources, payloads, athleteStatements, otherEvidenceByKind };
}

// ─── 3. First Look + bios ───────────────────────────────────────────────────────

async function firstLookFor(athleteId: string) {
  const snapshots = await db.select({ id: athleteSnapshots.id, first_look: athleteSnapshots.first_look, created_at: athleteSnapshots.created_at })
    .from(athleteSnapshots)
    .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.first_look} IS NOT NULL`))
    .orderBy(desc(athleteSnapshots.created_at)).limit(50);

  const seen = new Set<string>();
  const platforms: FirstLookPlatform[] = [];
  for (const s of snapshots) {
    const fl = s.first_look as FirstLook | null;
    if (!fl?.platform || seen.has(fl.platform)) continue;
    seen.add(fl.platform);
    platforms.push({
      platform: fl.platform,
      computedAt: fl.computed_at ?? (s.created_at ? new Date(s.created_at).toISOString() : null),
      themes: fl.themes ?? [],
      tone: fl.tone ?? [],
      interests: fl.interests ?? [],
      recurringPhrases: fl.recurring_phrases ?? [],
      causesMentioned: fl.causes_mentioned ?? [],
    });
  }

  const bioRows = await db.select().from(socialFeatures)
    .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, "profile.bio")))
    .orderBy(desc(socialFeatures.as_of));
  const seenPlatform = new Set<string>();
  const bios: BioRow[] = [];
  for (const b of bioRows) {
    const key = b.platform ?? "(all)";
    if (seenPlatform.has(key)) continue;
    seenPlatform.add(key);
    const text = (b.value_json as any)?.text;
    if (typeof text !== "string" || !text.trim()) continue;
    bios.push({ platform: b.platform, text, sourceClass: b.source_class, asOf: new Date(b.as_of).toISOString() });
  }

  return { platforms, bios };
}

// ─── 4/5/7. Identity Intelligence ledger ───────────────────────────────────────

interface LedgerRow { id: string; value: Record<string, unknown>; createdAt: string }

async function ledgerRowsFor(athleteId: string): Promise<LedgerRow[]> {
  const rows = await db.select({ id: intelligenceLedger.id, value: intelligenceLedger.value, created_at: intelligenceLedger.created_at })
    .from(intelligenceLedger)
    .where(and(eq(intelligenceLedger.subject_type, "athlete"), eq(intelligenceLedger.subject_id, athleteId),
      eq(intelligenceLedger.owner, "identity_intelligence"), eq(intelligenceLedger.kind, "ASSESSMENT")))
    .orderBy(desc(intelligenceLedger.created_at)).limit(2);
  return rows.map((r) => ({ id: r.id, value: (r.value ?? {}) as Record<string, unknown>, createdAt: new Date(r.created_at).toISOString() }));
}

function envelopeArrayOf(value: Record<string, unknown>): Array<{ ref: BasisRef; tier: string }> {
  const raw = Array.isArray(value.envelope) ? (value.envelope as any[]) : [];
  const out: Array<{ ref: BasisRef; tier: string }> = [];
  for (const e of raw) {
    const ref = parseBasisRef(e?.ref);
    if (ref && typeof e?.tier === "string") out.push({ ref, tier: e.tier });
  }
  return out;
}

function claimsArrayOf(value: Record<string, unknown>): Array<{ tier: string }> {
  const raw = Array.isArray(value.claims) ? (value.claims as any[]) : [];
  return raw.filter((c) => typeof c?.tier === "string").map((c) => ({ tier: c.tier as string }));
}

function summarize(row: LedgerRow): LedgerRowSummary {
  const envelope = envelopeArrayOf(row.value);
  const citedRefs = collectBasisRefsExcluding(row.value, ["envelope"]);
  const citedKinds = [...new Set(citedRefs.map((r) => r.kind))].sort();
  return {
    id: row.id,
    contract: typeof row.value.contract === "string" ? (row.value.contract as string) : null,
    createdAt: row.createdAt,
    envelopeCounts: countByKindTier(envelope.map((e) => ({ kind: e.ref.kind, tier: e.tier }))),
    claimTierCounts: countByTier(claimsArrayOf(row.value)),
    citedKinds,
  };
}

function comparisonOf(previous: LedgerRow, latest: LedgerRow): ComparisonResult {
  const prevEnv = envelopeArrayOf(previous.value);
  const prevTier = new Map(prevEnv.map((e) => [refKey(e.ref), e.tier]));
  const latestEnv = envelopeArrayOf(latest.value);
  const latestTier = new Map(latestEnv.map((e) => [refKey(e.ref), e.tier]));

  const prevCited = collectBasisRefsExcluding(previous.value, ["envelope"]);
  const latestCited = collectBasisRefsExcluding(latest.value, ["envelope"]);

  const citedCounts = {
    previous: countByKindTier(prevCited.map((r) => ({ kind: r.kind, tier: prevTier.get(refKey(r)) ?? "unknown" }))),
    latest: countByKindTier(latestCited.map((r) => ({ kind: r.kind, tier: latestTier.get(refKey(r)) ?? "unknown" }))),
  };
  const kd = diffKinds(kindsOf(citedCounts.previous), kindsOf(citedCounts.latest));

  return {
    fields: compareValueFields(previous.value, latest.value),
    citedCounts,
    newlyUsedKinds: kd.added,
    droppedKinds: kd.removed,
  };
}

// ─── 6. Validation — resolve every basis ref in the latest row ─────────────────

async function resolveBasisRefs(athleteId: string, refs: BasisRef[], tierOf: (r: BasisRef) => string): Promise<BasisResolution[]> {
  const byKind = new Map<string, BasisRef[]>();
  for (const r of refs) { const list = byKind.get(r.kind) ?? []; list.push(r); byKind.set(r.kind, list); }
  const out: BasisResolution[] = [];

  const factIds = (byKind.get("fact") ?? []).map((r) => (r as any).id);
  const factRows = factIds.length ? await db.select().from(athleteFacts).where(inArray(athleteFacts.id, factIds)) : [];
  const factById = new Map(factRows.map((f) => [f.id, f]));

  const evidenceIds = (byKind.get("evidence") ?? []).map((r) => (r as any).id);
  const evidenceRows = evidenceIds.length ? await db.select().from(researchEvidence).where(inArray(researchEvidence.id, evidenceIds)) : [];
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));

  const assertionIds = (byKind.get("assertion") ?? []).map((r) => (r as any).id);
  const assertionRows = assertionIds.length ? await db.select().from(athleteAsserted).where(inArray(athleteAsserted.id, assertionIds)) : [];
  const assertionById = new Map(assertionRows.map((a) => [a.id, a]));

  const objectiveIds = (byKind.get("objective") ?? []).map((r) => (r as any).id);
  const objectiveRows = objectiveIds.length ? await db.select().from(objectives).where(inArray(objectives.id, objectiveIds)) : [];
  const objectiveById = new Map(objectiveRows.map((o) => [o.id, o]));

  const mediaIds = (byKind.get("media_asset") ?? []).map((r) => (r as any).id);
  const mediaRows = mediaIds.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, mediaIds)) : [];
  const mediaById = new Map(mediaRows.map((m) => [m.id, m]));

  const snapshotIds = [...new Set((byKind.get("first_look") ?? []).map((r) => (r as any).snapshotId))];
  const snapshotRows = snapshotIds.length ? await db.select({ id: athleteSnapshots.id, first_look: athleteSnapshots.first_look }).from(athleteSnapshots).where(inArray(athleteSnapshots.id, snapshotIds)) : [];
  const snapshotById = new Map(snapshotRows.map((s) => [s.id, s]));

  const dealIds = (byKind.get("deal") ?? []).map((r) => (r as any).id);
  const dealRows = dealIds.length ? await db.select().from(deals).where(inArray(deals.id, dealIds)) : [];
  const dealById = new Map(dealRows.map((d) => [d.id, d]));

  const featureRows = (byKind.get("social_feature") ?? []).length
    ? await db.select().from(socialFeatures).where(eq(socialFeatures.athlete_id, athleteId)).orderBy(desc(socialFeatures.as_of))
    : [];

  for (const ref of refs) {
    const key = refKey(ref);
    const tier = tierOf(ref);
    if (ref.kind === "fact") {
      const f = factById.get(ref.id);
      out.push({ refKey: key, kind: ref.kind, tier, text: f ? `${f.fact_key}: ${f.value_text}` : "(fact not found)", source: f ? `${f.origin}${f.source_class ? `/${f.source_class}` : ""}` : "unknown" });
    } else if (ref.kind === "evidence") {
      const e = evidenceById.get(ref.id);
      const c = (e?.claim ?? {}) as Record<string, unknown>;
      const text = (c.text as string) ?? (c.statement as string) ?? (c.headline as string) ?? (c.event as string) ?? (c.name as string) ?? (c.title as string) ?? JSON.stringify(c).slice(0, 150);
      out.push({ refKey: key, kind: ref.kind, tier, text: e ? text : "(evidence not found)", source: e ? `${e.source_domain ?? "?"} (${e.source_type}, ${e.lineage_status})` : "unknown" });
    } else if (ref.kind === "assertion") {
      const a = assertionById.get(ref.id);
      out.push({ refKey: key, kind: ref.kind, tier, text: a ? (a.said ?? JSON.stringify(a.value)) : "(assertion not found)", source: a ? `athlete_asserted/${a.source}` : "unknown" });
    } else if (ref.kind === "objective") {
      const o = objectiveById.get(ref.id);
      const v = (o?.desired_state as any)?.value;
      out.push({ refKey: key, kind: ref.kind, tier, text: o ? String(v ?? JSON.stringify(o.desired_state)) : "(objective not found)", source: o ? `objective/${o.origin}` : "unknown" });
    } else if (ref.kind === "media_asset") {
      const m = mediaById.get(ref.id);
      out.push({ refKey: key, kind: ref.kind, tier, text: m ? (m.caption ?? "") : "(media asset not found)", source: m ? `${m.platform} caption` : "unknown" });
    } else if (ref.kind === "first_look") {
      const s = snapshotById.get(ref.snapshotId);
      const fl = (s?.first_look as FirstLook | null) ?? null;
      out.push({ refKey: key, kind: ref.kind, tier, text: fl ? `themes ${fl.themes?.join(", ") || "—"}; tone ${fl.tone?.join(", ") || "—"}` : "(first look snapshot not found)", source: `first_look/${ref.platform}` });
    } else if (ref.kind === "social_feature") {
      const match = featureRows.find((f) => `${f.platform ?? "all"}.${f.feature_key}` === ref.key);
      out.push({ refKey: key, kind: ref.kind, tier, text: match ? `${Number(match.value)} ${match.unit}` : "(social feature not found)", source: match ? `social_features/${match.source_class}` : "unknown" });
    } else if (ref.kind === "deal") {
      const d = dealById.get(ref.id);
      out.push({ refKey: key, kind: ref.kind, tier, text: d ? `${d.brand_name}${d.deal_type ? ` (${d.deal_type})` : ""}` : "(deal not found)", source: d ? `deal/${d.status}` : "unknown" });
    } else {
      out.push({ refKey: key, kind: ref.kind, tier, text: "[state finding — salience only, no content]", source: "intelligence_ledger/marketability" });
    }
  }
  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const athleteId = arg("--athlete");
  const outDir = arg("--out");
  if (!athleteId || !outDir) throw new Error("usage: identityRunReport.ts --athlete <uuid> --out <dir>");

  const research = await researchDiscoveryFor(athleteId);
  const targetedRead = await targetedReadFor(research?.workflowRunId ?? null);
  const firstLook = await firstLookFor(athleteId);
  const ledgerRows = await ledgerRowsFor(athleteId);
  const [latestRow, previousRow] = ledgerRows;

  const latestSummary = latestRow ? summarize(latestRow) : null;
  const previousSummary = previousRow ? summarize(previousRow) : null;
  const comparison = latestRow && previousRow ? comparisonOf(previousRow, latestRow) : null;

  let validation: BasisResolution[] = [];
  if (latestRow) {
    const envelope = envelopeArrayOf(latestRow.value);
    const tierByKey = new Map(envelope.map((e) => [refKey(e.ref), e.tier]));
    const refs = collectBasisRefsExcluding(latestRow.value, []); // include envelope here: validation covers every ref in the row
    validation = await resolveBasisRefs(athleteId, refs, (r) => tierByKey.get(refKey(r)) ?? "unknown");
  }

  const report: IdentityRunReport = {
    athleteId,
    generatedAt: new Date().toISOString(),
    research,
    targetedRead,
    firstLook,
    identityIntelligence: {
      latest: latestSummary,
      previous: previousSummary,
      comparison,
      rawValue: latestRow?.value ?? null,
    },
    validation,
  };

  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const base = `identity-run-report-${athleteId}`;
  const jsonPath = join(dir, `${base}.json`);
  const mdPath = join(dir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdownReport(report));

  // eslint-disable-next-line no-console
  console.log(`wrote ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${mdPath}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.message ?? err);
    pool.end().finally(() => process.exit(1));
  });
