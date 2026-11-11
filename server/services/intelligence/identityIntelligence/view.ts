/**
 * view.ts — GET /me/story's read model, IdentityIntelligenceView 0.2 (Concept 0.4).
 *
 * The synthesised parts (c) come from the latest unsuperseded `identity_intelligence` ledger row. The rules parts
 * (a/b: athletic identity, proof points, signature moments, voice, audience, direction, guardrails, unresolved, …) and
 * her approved statements are recomputed from the live envelope at read time, so her latest Objective, confirmation or
 * approved words show without a recompute. Read-only: no write, no provider call.
 *
 * A 0.1 row (written before 0.2) is read until the next recompute supersedes it: its identity statement becomes the
 * essence and its positioning statement positioning.current; nothing else of it is carried.
 *
 * pageState: unavailable (flag off) · learning (below sufficiency, or no row yet) · ready (+ `changesPending` / `refreshFailed`,
 * Oct 2026: the stored version answered different inputs than the live ones). `updating` is reserved for
 * the recompute workflow (later PR) and never returned today.
 */
import { identityIntelligenceEnabled } from "./config";
import { composePinned, sufficiencyOf } from "./compose";
import {
  IDENTITY_INTELLIGENCE_CONTRACT, IDENTITY_INTELLIGENCE_CONTRACT_V01, refKey,
  type BasisRef, type IdentityIntelligenceRecord, type IdentityIntelligenceRecordV01, type IdentityIntelligenceView, type IdentityRulesParts, type Synth, type SynthForm,
} from "./contract";
import { buildIdentityEnvelope } from "./envelope";
import { failedBefore, latestIdentityIntelligence, platformOf } from "./run";
import type { AthleteStatement } from "./statements";
import { projectAthleteStatements, type CitationSlots } from "./statementsView";
import type { ResolvedSynthesis } from "./validate";

const NO_SYNTHESIS: ResolvedSynthesis = {
  essence: null, positioningCurrent: null, standsFor: null, pillars: [], differentiators: [], throughline: null,
  chapters: { origin: null, rise: null, defining: null, now: null }, athleticStyle: null, origin: null, values: [], personality: [],
  motivation: null, communities: [], mediaFraming: null, imageGap: null,
};

const EMPTY_RULES: IdentityRulesParts = {
  athleticIdentity: { sport: null, position: null, level: null, team: null, role: null, careerStage: null },
  valuesEvidence: [], causes: [], interests: [], ambitions: [], positioningDesired: null, chaptersNext: null, signatureMoments: [],
  proofPoints: [], voice: { hers: null, observed: { tone: [], platforms: [], basis: [] }, contentThemes: [], signatureCues: [] },
  audience: { platforms: [] }, associations: [], direction: [], howToBeUnderstood: null,
  directives: { preferredEmphasis: [], deEmphasize: [], preferredLanguage: [], avoidLanguage: [] }, guardrails: [], unresolved: [],
};

type Platform = ReturnType<typeof platformOf>;

/** Every part of the platform that carries a basis, by the slot name `athleteStatements[].citedBy` reports. */
export function citationSlotsOf(p: Platform): CitationSlots {
  const slots: CitationSlots = {
    essence: p.essence?.basis, positioningCurrent: p.positioning.current?.basis, positioningDesired: p.positioning.desired?.basis,
    standsFor: p.standsFor?.basis, throughline: p.throughline?.basis,
    "chapters.origin": p.chapters.origin?.basis, "chapters.rise": p.chapters.rise?.basis, "chapters.defining": p.chapters.defining?.basis, "chapters.now": p.chapters.now?.basis,
    athleticStyle: p.athletic.style?.basis, origin: p.origin?.basis, motivation: p.motivation?.basis, mediaFraming: p.mediaFraming?.basis, imageGap: p.imageGap?.basis,
  };
  for (const pillar of p.pillars) slots[`pillar:${pillar.key}`] = pillar.basis;
  p.differentiators.forEach((d, i) => { slots[`differentiator:${i}`] = d.basis; });
  p.values.forEach((v, i) => { slots[`value:${i}`] = v.basis; });
  p.personality.forEach((v, i) => { slots[`personality:${i}`] = v.basis; });
  p.communities.forEach((v, i) => { slots[`community:${i}`] = v.basis; });
  return slots;
}

function viewOf(s: ResolvedSynthesis, rules: IdentityRulesParts, pins: Parameters<typeof platformOf>[2], statements: AthleteStatement[], extra: Pick<IdentityIntelligenceView, "pageState" | "generatedAt" | "overallConfidence" | "sufficiency">): IdentityIntelligenceView {
  const platform = platformOf(s, rules, pins);
  return { contract: IDENTITY_INTELLIGENCE_CONTRACT, ...platform, ...extra, athleteStatements: projectAthleteStatements(statements, citationSlotsOf(platform)) };
}

/** The synthesised parts of a stored row (0.2, or a 0.1 row mapped), with anything citing a since-denied item withheld. */
export function synthesisOfRow(v: IdentityIntelligenceRecord | IdentityIntelligenceRecordV01, denied: ReadonlySet<string>): ResolvedSynthesis {
  const standing = (basis: BasisRef[] | undefined) => !(basis ?? []).some((r) => denied.has(refKey(r)));
  const one = <T extends { basis: BasisRef[] } | null>(x: T | undefined): T | null => (x && standing(x.basis) ? x : null);
  // A stored pinned form is her approved text: it stands only while the live pin does (applied by the caller).
  const form = (f: SynthForm | null | undefined) => (f && !f.pinned ? one(f) : null);
  const many = <T extends { basis: BasisRef[] }>(xs: T[] | undefined) => (xs ?? []).filter((x) => standing(x.basis));
  if (v.contract === IDENTITY_INTELLIGENCE_CONTRACT_V01) {
    const s = v.identityStatement; const p = v.positioningStatement;
    return {
      ...NO_SYNTHESIS,
      essence: s && standing(s.basis) ? { short: s.value, long: s.value, basis: s.basis, strength: s.strength } : null,
      positioningCurrent: p && standing(p.basis) ? { short: p.value, long: p.value, basis: p.basis, strength: "reported" } : null,
      differentiators: many(v.differentiators).map((d): Synth => ({ text: d.value, basis: d.basis, strength: "reported" })),
    };
  }
  const c = v.chapters ?? { origin: null, rise: null, defining: null, now: null };
  return {
    essence: form(v.essence), positioningCurrent: form(v.positioning?.current), standsFor: form(v.standsFor),
    pillars: many(v.pillars), differentiators: many(v.differentiators), throughline: form(v.throughline),
    chapters: { origin: one(c.origin), rise: one(c.rise), defining: one(c.defining), now: one(c.now) },
    athleticStyle: one(v.athletic?.style), origin: one(v.origin), values: many(v.values), personality: many(v.personality),
    motivation: one(v.motivation), communities: many(v.communities), mediaFraming: one(v.mediaFraming), imageGap: one(v.imageGap),
  };
}

export async function buildIdentityIntelligenceView(athleteId: string, now: Date = new Date()): Promise<IdentityIntelligenceView> {
  if (!identityIntelligenceEnabled()) {
    return viewOf(NO_SYNTHESIS, EMPTY_RULES, [], [], { pageState: "unavailable", generatedAt: null, overallConfidence: null, sufficiency: null });
  }

  // `env.statements` IS athleteStatements()' output (gather + select, same rules and caps) — the envelope already holds
  // it, so the projection reuses it rather than reading her words twice.
  const env = await buildIdentityEnvelope(athleteId, now);
  const sufficiency = sufficiencyOf(env.items);
  const row = sufficiency.met ? await latestIdentityIntelligence(athleteId) : null;
  if (!row) return viewOf(NO_SYNTHESIS, env.rules, [], env.statements, { pageState: "learning", generatedAt: null, overallConfidence: null, sufficiency });

  // Precedence: denial > synthesis. A part citing something she has since denied is withheld until the next recompute.
  const pins = composePinned(env);
  const v = row.value;
  // Stale = the live inputs hash differently from what this version answered (a database read; no job state involved).
  const changesPending = !!v.inputVersion && v.inputVersion !== env.inputVersion;
  const refreshFailed = changesPending && await failedBefore(athleteId, env.inputVersion);
  return {
    ...viewOf(synthesisOfRow(v, env.verdicts.denied), env.rules, pins, env.statements, {
      pageState: "ready",
      generatedAt: v.generatedAt ?? row.createdAt.toISOString(),
      overallConfidence: v.overallConfidence ?? null,
      sufficiency,
    }),
    changesPending, refreshFailed,
  };
}
