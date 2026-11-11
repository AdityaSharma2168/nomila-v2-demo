/**
 * run.ts — one Identity Intelligence 0.2 recompute for one athlete (contract "Pipeline").
 *
 *   envelope (sections A–I, rules parts computed BEFORE the call) → skip when inputVersion is unchanged → sufficiency →
 *   synthesis (one call) → validation (one repair attempt, the validator's errors fed back) → composition →
 *   intelligence_ledger
 *
 * Persisted as owner `identity_intelligence`, kind ASSESSMENT, value = the 0.2 record, superseding the latest row —
 * including a 0.1 row (rows are never updated in place beyond the supersession pointer). On a final validation failure
 * NO ledger row is written (the record is atomic): the previous row stays current and the reason is logged and returned.
 * Every model answer — passed or rejected — is kept in identity_intelligence_attempts with the validator's errors, so a
 * failed run can always be inspected. Below sufficiency nothing is written — the read model answers `learning` from the
 * live envelope.
 *
 * Triggers (Oct 2026): the debounced `identity_refresh` workflow (workflow/definitions/identityRefresh.ts), requested by
 * her recorded assertions (recordAssertions: disputes, record and team edits, direction, onboarding), Objective decisions
 * and finished research refreshes; the admin seam can still force a run. First Look and a new M.I.A. row are not triggers yet.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { identityIntelligenceAttempts, intelligenceLedger } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import type { ValueRef } from "../contracts/provenance";
import { IDENTITY_SYNTHESIS } from "./config";
import {
  IDENTITY_ADMISSIBILITY_POLICY, IDENTITY_INTELLIGENCE_CONTRACT, IDENTITY_LEDGER_OWNER, IDENTITY_SYNTHESIS_PROMPT, IDENTITY_VALIDATION_POLICY,
  type ApprovedField, type IdentityIntelligenceRecord, type IdentityIntelligenceRecordV01, type IdentityRulesParts, type SynthForm, type Sufficiency,
} from "./contract";
import { composePinned, sufficiencyOf } from "./compose";
import { buildIdentityEnvelope, type IdentityEnvelope } from "./envelope";
import { aliasesFor, buildRepairPrompt, buildSynthesisPrompt, extractJsonObject, parseDraft, SYNTHESIS_PARAMS, type SynthesisProvider } from "./synthesize";
import { validateSynthesis, type ResolvedSynthesis } from "./validate";

const logger = createLogger("intelligence/identity-intelligence");

export type RunOutcome = "persisted" | "skipped_unchanged" | "skipped_failed_before" | "insufficient" | "validation_failed" | "provider_error";

/**
 * A model answer for exactly these inputs was already judged and none passed: asking again would re-sample the same
 * question. The automatic refresh stops here (the retry cap); an admin `force` still runs. Any change to her inputs or to
 * a prompt / policy version changes `inputVersion`, which re-opens it.
 */
export async function failedBefore(athleteId: string, inputVersion: string): Promise<boolean> {
  const rows = await db.select({ passed: identityIntelligenceAttempts.passed }).from(identityIntelligenceAttempts)
    .where(and(eq(identityIntelligenceAttempts.athlete_id, athleteId), eq(identityIntelligenceAttempts.input_version, inputVersion)));
  return rows.length > 0 && !rows.some((r) => r.passed);
}

export interface IdentityRunResult {
  outcome: RunOutcome;
  athleteId: string;
  inputVersion: string;
  entryId: string | null;
  supersededEntryId: string | null;
  value: IdentityIntelligenceRecord | IdentityIntelligenceRecordV01 | null;
  /** One entry per model answer: the errors the validator found (empty = passed). */
  validation: Array<{ attempt: number; errors: string[] }>;
  /** Groups this run's rows in identity_intelligence_attempts (null when no model call was made). */
  runId: string | null;
  sufficiency: { met: boolean; reasons: string[] };
  reason?: string;
}

export interface LatestIdentityRow { id: string; value: IdentityIntelligenceRecord | IdentityIntelligenceRecordV01; createdAt: Date }

export async function latestIdentityIntelligence(athleteId: string): Promise<LatestIdentityRow | null> {
  const [r] = await db.select({ id: intelligenceLedger.id, value: intelligenceLedger.value, created_at: intelligenceLedger.created_at })
    .from(intelligenceLedger)
    .where(and(eq(intelligenceLedger.subject_type, "athlete"), eq(intelligenceLedger.subject_id, athleteId),
      eq(intelligenceLedger.owner, IDENTITY_LEDGER_OWNER), eq(intelligenceLedger.kind, "ASSESSMENT"), isNull(intelligenceLedger.superseded_by)))
    .orderBy(desc(intelligenceLedger.created_at)).limit(1);
  return r ? { id: r.id, value: r.value as IdentityIntelligenceRecord | IdentityIntelligenceRecordV01, createdAt: r.created_at } : null;
}

/** The prompt for an envelope (exported for tests and the golden harness). */
export function promptFor(env: IdentityEnvelope) {
  const aliases = aliasesFor(env.items);
  const preKinds = new Map<string, string>([
    ...env.rules.signatureMoments.map((p) => [p.key, "signature moment"] as [string, string]),
    ...env.rules.proofPoints.map((p) => [p.key, `proof point · ${p.kind.replace(/_/g, " ")}`] as [string, string]),
  ]);
  const prompt = buildSynthesisPrompt(aliases, env.directives, { approved: env.approvedStatements, preKinds });
  return { aliases, prompt };
}

export async function runIdentityIntelligence(
  athleteId: string,
  deps: { synthesize: SynthesisProvider; now?: Date; force?: boolean; skipIfFailedBefore?: boolean },
): Promise<IdentityRunResult> {
  const now = deps.now ?? new Date();
  const env = await buildIdentityEnvelope(athleteId, now);
  const sufficiency = sufficiencyOf(env.items);
  const base = { athleteId, inputVersion: env.inputVersion, entryId: null, supersededEntryId: null, value: null, validation: [] as IdentityRunResult["validation"], sufficiency, runId: null as string | null };

  const latest = await latestIdentityIntelligence(athleteId);
  if (!deps.force && latest?.value?.inputVersion === env.inputVersion) {
    return { ...base, outcome: "skipped_unchanged", entryId: latest.id, value: latest.value };
  }
  if (!deps.force && deps.skipIfFailedBefore && await failedBefore(athleteId, env.inputVersion)) {
    logger.info({ athleteId, inputVersion: env.inputVersion }, "identity intelligence: these inputs already failed validation; not re-asked, previous version kept");
    return { ...base, outcome: "skipped_failed_before", entryId: latest?.id ?? null, value: latest?.value ?? null };
  }
  if (!sufficiency.met) {
    logger.info({ athleteId, reasons: sufficiency.reasons }, "identity intelligence: below sufficiency, nothing generated");
    return { ...base, outcome: "insufficient" };
  }

  const { aliases, prompt } = promptFor(env);
  const approved = composePinned(env).map((p) => ({ field: p.field, text: p.text }));
  let resolved: ResolvedSynthesis | null = null;
  let model = "unknown"; let modelVersion: string | null = null;
  let current = prompt;
  const runId = randomUUID();
  base.runId = runId;
  for (let attempt = 0; attempt <= IDENTITY_SYNTHESIS.repairAttempts; attempt++) {
    let text: string; let finishReason: string | null = null;
    try {
      const r = await deps.synthesize({ prompt: current, temperature: SYNTHESIS_PARAMS.temperature, maxOutputTokens: SYNTHESIS_PARAMS.maxOutputTokens });
      text = r.text; model = r.model; modelVersion = r.modelVersion ?? null; finishReason = r.finishReason ?? null;
    } catch (err: any) {
      logger.error({ athleteId, attempt, error: err?.message }, "identity intelligence: synthesis call failed; previous version kept");
      return { ...base, outcome: "provider_error", reason: String(err?.message ?? err).slice(0, 300) };
    }
    const parsed = parseDraft(extractJsonObject(text));
    const v = parsed.draft ? validateSynthesis(parsed.draft, aliases, { directives: env.directives, verdicts: env.verdicts, approved }) : null;
    const errors = [...parsed.errors, ...(v?.report.errors ?? [])];
    // Say why an unparseable answer ended (e.g. the output budget ran out), so a failed run explains itself.
    if (!parsed.draft && finishReason && finishReason !== "STOP") errors.push(`the provider stopped with ${finishReason} after ${text.length} characters`);
    base.validation.push({ attempt, errors });
    await recordAttempt({ runId, athleteId, attempt, inputVersion: env.inputVersion, model, finishReason, prompt: attempt === 0 ? prompt : null, response: text, errors });
    if (!errors.length && v?.resolved) { resolved = v.resolved; break; }
    current = buildRepairPrompt(prompt, text, errors);
  }
  if (!resolved) {
    const last = base.validation.at(-1)?.errors ?? [];
    logger.warn({ athleteId, errors: last.slice(0, 10) }, "identity intelligence: validation failed after repair; nothing persisted, previous version kept");
    return { ...base, outcome: "validation_failed", reason: last.slice(0, 5).join("; ") };
  }

  const value = recordOf(env, resolved, sufficiency, model, now);
  const persisted = await persist(env, value, { model, modelVersion });
  logger.info({ athleteId, entryId: persisted.entryId, superseded: persisted.supersededEntryId }, "identity intelligence: persisted");
  return { ...base, outcome: "persisted", entryId: persisted.entryId, supersededEntryId: persisted.supersededEntryId, value };
}

export function overallConfidenceOf(s: Pick<ResolvedSynthesis, "essence" | "pillars">): "HIGH" | "MEDIUM" | "LOW" {
  if (!s.essence) return "LOW";
  const tiers = [s.essence.strength, ...s.pillars.map((p) => p.strength)];
  return tiers.every((t) => t === "established" || t === "athlete_approved") ? "HIGH" : "MEDIUM";
}

/** Her approved statement replaces the synthesised one (short and long) while its basis stands. */
export function applyPinned(form: SynthForm | null, pin: { text: string; basis: SynthForm["basis"] } | undefined): SynthForm | null {
  return pin ? { short: pin.text, long: pin.text, basis: pin.basis, strength: "athlete_approved", pinned: true } : form;
}

/** The synthesised parts (c) laid over the rules parts (a/b) — the brand platform. */
export function platformOf(s: ResolvedSynthesis, rules: IdentityRulesParts, pins: Array<{ field: ApprovedField; text: string; assertionId: string; basis: SynthForm["basis"] }>) {
  const pin = (f: ApprovedField) => pins.find((p) => p.field === f);
  return {
    athletic: { identity: rules.athleticIdentity, style: s.athleticStyle },
    origin: s.origin,
    values: s.values,
    valuesEvidence: rules.valuesEvidence,
    causes: rules.causes,
    interests: rules.interests,
    personality: s.personality,
    motivation: s.motivation,
    ambitions: rules.ambitions,
    essence: applyPinned(s.essence, pin("essence")),
    positioning: { current: applyPinned(s.positioningCurrent, pin("positioningCurrent")), desired: rules.positioningDesired },
    standsFor: s.standsFor,
    pillars: s.pillars,
    differentiators: s.differentiators,
    throughline: s.throughline,
    chapters: { ...s.chapters, next: rules.chaptersNext },
    signatureMoments: rules.signatureMoments,
    proofPoints: rules.proofPoints,
    voice: rules.voice,
    audience: { measured: rules.audience },
    communities: s.communities,
    associations: rules.associations,
    mediaFraming: s.mediaFraming,
    imageGap: s.imageGap,
    direction: rules.direction,
    howToBeUnderstood: rules.howToBeUnderstood,
    directives: rules.directives,
    approved: Object.fromEntries(pins.map((p) => [p.field, p.assertionId])) as Partial<Record<ApprovedField, string>>,
    guardrails: rules.guardrails,
    unresolved: rules.unresolved,
  };
}

export function recordOf(env: IdentityEnvelope, s: ResolvedSynthesis, sufficiency: Sufficiency, model: string, now: Date): IdentityIntelligenceRecord {
  const platform = platformOf(s, env.rules, composePinned(env));
  return {
    contract: IDENTITY_INTELLIGENCE_CONTRACT,
    ...platform,
    overallConfidence: overallConfidenceOf({ essence: platform.essence, pillars: s.pillars }),
    sufficiency,
    generatedAt: now.toISOString(),
    inputVersion: env.inputVersion,
    specVersion: IDENTITY_SYNTHESIS_PROMPT,
    validationVersion: IDENTITY_VALIDATION_POLICY,
    policyVersion: IDENTITY_ADMISSIBILITY_POLICY,
    model,
    claims: env.claims,
    envelope: env.items.map((i) => ({ ref: i.ref, tier: i.tier, ...(i.section ? { section: i.section } : {}) })),
  };
}

/** Keep one model answer and its errors. Diagnostic only: a failed write is logged and never fails the run. */
async function recordAttempt(a: { runId: string; athleteId: string; attempt: number; inputVersion: string; model: string; finishReason: string | null; prompt: string | null; response: string; errors: string[] }): Promise<void> {
  try {
    await db.insert(identityIntelligenceAttempts).values({
      run_id: a.runId, athlete_id: a.athleteId, attempt: a.attempt, input_version: a.inputVersion,
      prompt_version: IDENTITY_SYNTHESIS_PROMPT, validation_version: IDENTITY_VALIDATION_POLICY,
      model: a.model, finish_reason: a.finishReason, prompt: a.prompt, response: a.response, errors: a.errors, passed: a.errors.length === 0,
    });
  } catch (err: any) {
    logger.warn({ athleteId: a.athleteId, runId: a.runId, attempt: a.attempt, error: err?.message }, "identity intelligence: could not record the attempt");
  }
}

async function persist(env: IdentityEnvelope, value: IdentityIntelligenceRecord, m: { model: string; modelVersion: string | null }): Promise<{ entryId: string; supersededEntryId: string | null }> {
  // `inputs` records upstream INTELLIGENCE consumed (contracts/intelligenceLedger.ts) — here the M.I.A. row read for
  // salience. Evidence lineage (the basis refs) travels in `value.envelope` / `value.claims`, never in `inputs`.
  const inputs: ValueRef[] = env.miaEntryId
    ? [{ path: "marketability.assessment", predictionId: env.miaEntryId, owner: "marketability", evidenceClass: "EVALUATED", confidence: "LOW", material: false }]
    : [];
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(intelligenceLedger).values({
      subject_type: "athlete", subject_id: env.athleteId, owner: IDENTITY_LEDGER_OWNER, kind: "ASSESSMENT",
      value: value as unknown as Record<string, unknown>,
      // No versioned band policy maps this engine onto the column; overallConfidence lives in `value` (see 0055).
      confidence: null,
      versions: { contract: IDENTITY_INTELLIGENCE_CONTRACT, policy: IDENTITY_ADMISSIBILITY_POLICY, prompt: IDENTITY_SYNTHESIS_PROMPT, validation: IDENTITY_VALIDATION_POLICY, model: m.model, ...(m.modelVersion ? { modelVersion: m.modelVersion } : {}) },
      inputs, assumptions: [],
      evidence_as_of: new Date(env.evidenceAsOf),
    }).returning({ id: intelligenceLedger.id });
    let superseded: string | null = null;
    const prev = await tx.select({ id: intelligenceLedger.id }).from(intelligenceLedger)
      .where(and(eq(intelligenceLedger.subject_type, "athlete"), eq(intelligenceLedger.subject_id, env.athleteId),
        eq(intelligenceLedger.owner, IDENTITY_LEDGER_OWNER), eq(intelligenceLedger.kind, "ASSESSMENT"), isNull(intelligenceLedger.superseded_by)));
    for (const p of prev) {
      if (p.id === row.id) continue;
      await tx.update(intelligenceLedger).set({ superseded_by: row.id }).where(and(eq(intelligenceLedger.id, p.id), isNull(intelligenceLedger.superseded_by)));
      superseded = superseded ?? p.id;
    }
    return { entryId: row.id, supersededEntryId: superseded };
  });
}
