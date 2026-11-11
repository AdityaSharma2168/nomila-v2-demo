/**
 * compose.ts — the rules parts of Identity Intelligence 0.2, deterministic (contract §1 classes a and b).
 *
 * Computed from the envelope BEFORE the synthesis call (proof points and signature moments become input section I,
 * cited by id and never rewritten) and recomputed live at read time by view.ts:
 *
 *   athletic.identity   sport · position · level · team · role · career stage — her assertion first, then current facts
 *   valuesEvidence      research values/causes claims, her brands_causes, impact Objectives, her words on values
 *   causes              First Look causes_mentioned, her brands_causes, research cause organisations
 *   interests           First Look interests, her hobbies, research interests, her words on interests
 *   ambitions           (a) Objectives and her direction verbatim, plus her words on ambition
 *   positioning.desired (a) her positioning Objective, else her direction, verbatim — null when she has none
 *   chapters.next       (b) from her direction, framed as intent
 *   signatureMoments    research career_event (signature) and honours that are "firsts", ranked by tier and salience
 *   proofPoints         honours, national team, captaincy, education, partnerships (earned deals, researched
 *                       endorsements), measured audience
 *   voice               (a) brand_voice; First Look tone, themes, recurring phrases; nicknames
 *   audience.measured   connected audience geography, age, gender, followers, engagement
 *   associations        research associations, partnerships
 *   direction, howToBeUnderstood, directives (a) · guardrails, unresolved (b)
 *
 * Only admissible (Established / Reported), not-denied items are used; Unconfirmed claims become open questions.
 */
import { isAdmissible, normaliseText, withoutTierLabels } from "./claims";
import { IDENTITY_ENVELOPE, IDENTITY_LIMITS, IDENTITY_PROOF, IDENTITY_SUFFICIENCY } from "./config";
import {
  APPROVED_TARGET_FIELD, refKey,
  type AdmissibleTier, type ApprovedField, type AssembledItem, type AthleticIdentity, type AudiencePlatform, type BasisItem, type BasisRef,
  type DesiredPositioning, type DirectionItem, type Guardrail, type IdentityRulesParts, type ProofKind, type ProofPoint, type Sourced,
  type Sufficiency, type UnresolvedItem, type Voice,
} from "./contract";
import type { EnvelopeCore, IdentityEnvelope } from "./envelope";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
const uniq = (xs: string[], n: number) => [...new Map(xs.map((x) => [x.trim().toLowerCase(), x.trim()])).values()].filter(Boolean).slice(0, n);

type Core = Pick<EnvelopeCore, "items" | "verdicts" | "facts" | "evidence" | "asserted" | "objectives" | "howToBeUnderstood" | "firstLooks" | "statements" | "deals" | "audience" | "directives" | "claims">;

/** Items usable as basis: admissible and not denied. */
function usable(core: Pick<Core, "items" | "verdicts">) {
  const byKey = new Map(core.items.map((i) => [i.key, i]));
  const ok = (i: BasisItem | undefined): i is BasisItem => !!i && isAdmissible(i.tier) && !core.verdicts.denied.has(i.key);
  return { byKey, ok, get: (r: BasisRef) => { const i = byKey.get(refKey(r)); return ok(i) ? i : null; } };
}

const tierOf = (i: BasisItem): AdmissibleTier => (i.tier === "established" ? "established" : "reported");
const order = (a: BasisItem, b: BasisItem) => (a.tier === b.tier ? 0 : a.tier === "established" ? -1 : 1) || b.salience - a.salience || a.key.localeCompare(b.key);

function dedupe(entries: AssembledItem[], n: number): AssembledItem[] {
  const seen = new Map<string, AssembledItem>();
  for (const e of entries) {
    const k = normaliseText(e.text);
    if (!k) continue;
    const prev = seen.get(k);
    if (prev) { for (const b of e.basis) if (!prev.basis.some((x) => refKey(x) === refKey(b))) prev.basis.push(b); continue; }
    seen.set(k, { ...e, basis: [...e.basis] });
  }
  return [...seen.values()].slice(0, n);
}

// ── athletic.identity ──────────────────────────────────────────────────────

export function composeAthleticIdentity(core: Core): AthleticIdentity {
  const u = usable(core);
  const assertion = (field: string): { id: string; raw: unknown } | null => {
    const a = core.asserted[field];
    return a && u.get({ kind: "assertion", id: a.id }) ? a : null;
  };
  const said = (field: string, pick: (raw: unknown) => string | null): Sourced | null => {
    const a = assertion(field); const v = a ? pick(a.raw) : null;
    return a && v ? { value: v, basis: [{ kind: "assertion", id: a.id }] } : null;
  };
  const facts = (key: string) => core.facts.filter((f) => f.key === key && f.status === "current" && u.get({ kind: "fact", id: f.id }))
    .sort((a, b) => order(u.byKey.get(`fact:${a.id}`)!, u.byKey.get(`fact:${b.id}`)!));
  const fact = (key: string, pick: (v: Record<string, unknown>) => string | null): Sourced | null => {
    for (const f of facts(key)) { const v = pick((f.value ?? {}) as Record<string, unknown>); if (v) return { value: v, basis: [{ kind: "fact", id: f.id }] }; }
    return null;
  };
  // Her team is ONE item, and its level and role come from that same item or are unknown — never borrowed from another
  // affiliation. Her said list (its primary current team, else her first current one, else her first) wins; then the
  // school she named (a team with no role); then the top current affiliation fact.
  const herTeam = (raw: unknown): Record<string, unknown> | null => {
    const list = (Array.isArray(raw) ? raw : []).filter((t): t is Record<string, unknown> => !!t && typeof t === "object");
    const current = list.filter((t) => !str(t.to));
    return current.find((t) => t.primary === true) ?? current[0] ?? list[0] ?? null;
  };
  const fromTeams = (k: string) => said("affiliations", (raw) => str(herTeam(raw)?.[k]));
  // The school she named still leads (as before); her said team stands in for it when it names the same org.
  const saidSchool = said("school", str)?.value ?? null;
  const saidTeamOrg = fromTeams("org")?.value ?? null;
  const teamSource: "said" | "school" | "fact" | null =
    saidSchool ? (saidTeamOrg && normaliseText(saidTeamOrg) === normaliseText(saidSchool) ? "said" : "school")
      : saidTeamOrg ? "said" : fact("affiliation", (v) => str(v.org)) ? "fact" : null;
  const ofTeam = (k: "org" | "level" | "role"): Sourced | null =>
    teamSource === "said" ? fromTeams(k) : teamSource === "school" ? (k === "org" ? said("school", str) : null) : teamSource === "fact" ? teamFact(k) : null;
  // The top current affiliation fact as one unit: its org, level and role all come from the same row.
  const teamFact = (k: "org" | "level" | "role"): Sourced | null => {
    const f = facts("affiliation").find((x) => str(((x.value ?? {}) as Record<string, unknown>).org));
    const v = f ? str(((f.value ?? {}) as Record<string, unknown>)[k]) : null;
    return f && v ? { value: v, basis: [{ kind: "fact", id: f.id }] } : null;
  };
  const career = (raw: unknown) => {
    if (typeof raw === "string") return str(raw);
    const o = (raw ?? {}) as { status?: unknown; since?: unknown };
    const s = str(o.status)?.replace(/_/g, " ") ?? null;
    return s ? (str(o.since) ? `${s} since ${o.since}` : s) : null;
  };
  return {
    sport: said("sport", str) ?? fact("sport", (v) => str(v.sport)),
    position: said("position", str) ?? fromTeams("position") ?? fact("position", (v) => str(v.text)),
    level: ofTeam("level"),
    team: ofTeam("org"),
    role: ofTeam("role"),
    careerStage: said("career_status", career) ?? said("class_year", str) ?? fact("career_status", (v) => str(v.status)?.replace(/_/g, " ") ?? null) ?? fact("class_year", (v) => str(v.label)),
  };
}

// ── proof points and signature moments ─────────────────────────────────────

function proofKindOf(core: Core, i: BasisItem): ProofKind | null {
  const P = IDENTITY_PROOF;
  if (i.ref.kind === "deal") return "partnership";
  if (i.ref.kind === "social_feature") return P.audienceProofFeatures.some((f) => i.ref.kind === "social_feature" && i.ref.key.endsWith(`.${f}`)) ? "audience" : null;
  let factKey: string | null = null; let value: Record<string, unknown> = {}; let claim: Record<string, unknown> = {};
  if (i.ref.kind === "fact") { const id = i.ref.id; const f = core.facts.find((x) => x.id === id); factKey = f?.key ?? null; value = (f?.value ?? {}) as Record<string, unknown>; }
  if (i.ref.kind === "evidence") { const id = i.ref.id; const e = core.evidence.find((x) => x.id === id); claim = e?.claim ?? {}; factKey = typeof claim.factKey === "string" ? claim.factKey : null; value = (claim.value ?? {}) as Record<string, unknown>; }
  if (factKey === "affiliation") {
    const role = ` ${normaliseText(String(value.role ?? ""))} `;
    return P.captaincyRoles.some((r) => role.includes(` ${normaliseText(r)} `)) ? "captaincy" : null;
  }
  if (factKey && P.proofFactKinds[factKey]) return P.proofFactKinds[factKey] as ProofKind;
  if (claim.captaincy) return "captaincy";
  return null;
}

function isSignature(core: Core, i: BasisItem, kind: ProofKind | null): boolean {
  if (i.ref.kind === "evidence") {
    const id = i.ref.id; const e = core.evidence.find((x) => x.id === id);
    if (e?.kind === "career_event" && IDENTITY_PROOF.signatureEventKinds.includes(String(e.claim.eventKind ?? ""))) return true;
  }
  if (kind === "honour" || kind === "national_team") {
    const text = ` ${normaliseText(withoutTierLabels(i.text))} `;
    return IDENTITY_PROOF.firstWords.some((w) => text.includes(` ${normaliseText(w)} `));
  }
  return false;
}

/** One representative per claim (Established first, then salience, then key), so corroborating copies are one proof. */
function representatives(items: BasisItem[]): BasisItem[] {
  const groups = new Map<string, BasisItem[]>();
  for (const i of items) { const k = i.claimKey ?? `item:${i.key}`; const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]); }
  return [...groups.values()].map((g) => [...g].sort(order)[0]).sort(order);
}

export function composeProof(core: Core): { signatureMoments: ProofPoint[]; proofPoints: ProofPoint[] } {
  const u = usable(core);
  const candidates = core.items.filter((i) => u.ok(i) && !i.intent && !i.statement && i.ref.kind !== "state_finding");
  const sig: BasisItem[] = []; const proof: Array<[BasisItem, ProofKind]> = [];
  for (const i of representatives(candidates)) {
    const kind = proofKindOf(core, i);
    if (isSignature(core, i, kind)) sig.push(i);
    else if (kind) proof.push([i, kind]);
  }
  const groupRefs = (i: BasisItem) => (i.claimKey ? candidates.filter((x) => x.claimKey === i.claimKey).sort(order).map((x) => x.ref) : [i.ref]);
  const pp = (i: BasisItem, kind: ProofKind): ProofPoint => ({ key: i.key, kind, text: i.text, basis: groupRefs(i), strength: tierOf(i), asOf: i.asOf });
  return {
    signatureMoments: sig.slice(0, IDENTITY_ENVELOPE.maxSignatureMoments).map((i) => pp(i, "signature")),
    proofPoints: proof.slice(0, IDENTITY_ENVELOPE.maxProofPoints).map(([i, k]) => pp(i, k)),
  };
}

// ── the rest ───────────────────────────────────────────────────────────────

const statementItems = (core: Core, topics: string[]) => {
  const u = usable(core);
  return core.items.filter((i) => u.ok(i) && i.statement && i.statement.topics.some((t) => topics.includes(t))).sort(order);
};
const evidenceTopic = (core: Core, topics: string[]) => {
  const u = usable(core);
  const ids = new Set(core.evidence.filter((e) => e.kind === "narrative_claim" && topics.includes(String(e.claim.topic ?? ""))).map((e) => `evidence:${e.id}`));
  return core.items.filter((i) => ids.has(i.key) && u.ok(i)).sort(order);
};
const assertionItem = (core: Core, field: string) => {
  const a = core.asserted[field]; if (!a) return null;
  return usable(core).get({ kind: "assertion", id: a.id });
};
const firstLookRef = (f: EnvelopeCore["firstLooks"][number]): BasisRef => ({ kind: "first_look", snapshotId: f.snapshotId, platform: f.platform });
const asItem = (i: BasisItem): AssembledItem => ({ text: i.text, basis: [i.ref], strength: tierOf(i) });

export function composeDirection(env: Pick<EnvelopeCore, "objectives">): DirectionItem[] {
  return env.objectives.map((o) => ({ value: o.value, objectiveId: o.id, domain: o.domain, athleteAuthored: o.athleteAuthored, basis: [{ kind: "objective", id: o.id }] }));
}

export function composePositioningDesired(env: Pick<EnvelopeCore, "objectives" | "howToBeUnderstood">): DesiredPositioning | null {
  const pos = env.objectives.filter((o) => o.domain === "positioning").sort((a, b) => Number(b.athleteAuthored) - Number(a.athleteAuthored) || a.id.localeCompare(b.id))[0];
  if (pos) return { value: pos.value, source: "objective", basis: [{ kind: "objective", id: pos.id }] };
  const h = env.howToBeUnderstood;
  return h ? { value: h.value, source: "direction", basis: [{ kind: "assertion", id: h.assertionId }] } : null;
}

function composeVoice(core: Core): Voice {
  const bv = core.asserted.brand_voice;
  const raw = (bv?.raw ?? null) as { tone?: unknown; phrases?: unknown; avoid?: unknown } | null;
  const nick = assertionItem(core, "nickname") ? str(core.asserted.nickname.raw) : null;
  const aliasNicks = core.facts.filter((f) => f.key === "alias" && f.status === "current" && (f.value as any)?.kind === "nickname").map((f) => str((f.value as any)?.text)).filter((x): x is string => !!x);
  return {
    hers: raw ? { tone: str(raw.tone), phrases: list(raw.phrases), avoid: list(raw.avoid), basis: [{ kind: "assertion", id: bv!.id }] } : null,
    observed: {
      tone: uniq(core.firstLooks.flatMap((f) => f.tone), IDENTITY_ENVELOPE.maxVoiceTone),
      platforms: core.firstLooks.map((f) => f.platform),
      basis: core.firstLooks.map(firstLookRef),
    },
    contentThemes: uniq(core.firstLooks.flatMap((f) => f.themes), IDENTITY_ENVELOPE.maxVoiceThemes),
    signatureCues: uniq([...core.firstLooks.flatMap((f) => f.recurringPhrases), ...(nick ? [nick] : []), ...aliasNicks], IDENTITY_ENVELOPE.maxSignatureCues),
  };
}

function composeAudience(core: Core): { platforms: AudiencePlatform[] } {
  const u = usable(core);
  const by = new Map<string, AudiencePlatform>();
  const buckets = (json: unknown) => (Array.isArray(json) ? json : []).slice(0, IDENTITY_ENVELOPE.maxAudienceBuckets)
    .map((r: any) => ({ bucket: String(r?.bucket ?? "?"), pct: typeof r?.pct === "number" ? r.pct : null }));
  for (const a of core.audience) {
    const ref: BasisRef = { kind: "social_feature", key: a.key };
    if (!u.get(ref)) continue;
    const p = by.get(a.platform) ?? { platform: a.platform, followers: null, engagementPerFollower: null, topGeographies: [], age: [], gender: [], basis: [] };
    if (a.feature === "followers_latest") p.followers = a.value;
    else if (a.feature === "engagement_per_follower_median") p.engagementPerFollower = a.value;
    else if (a.feature === "audience_country_distribution") p.topGeographies = buckets(a.json);
    else if (a.feature === "audience_age_distribution") p.age = buckets(a.json);
    else if (a.feature === "audience_gender_share") p.gender = buckets(a.json);
    p.basis.push(ref);
    by.set(a.platform, p);
  }
  return { platforms: [...by.values()].sort((a, b) => a.platform.localeCompare(b.platform)) };
}

function composeGuardrails(core: Core): Guardrail[] {
  const out: Guardrail[] = [];
  const np = core.asserted.never_post;
  for (const t of list(np?.raw)) out.push({ kind: "never_post", text: t, basis: [{ kind: "assertion", id: np!.id }] });
  const voiceBasis: BasisRef[] = core.asserted.brand_voice ? [{ kind: "assertion", id: core.asserted.brand_voice.id }] : [];
  for (const t of core.directives.avoidLanguage) out.push({ kind: "avoid_language", text: t, basis: voiceBasis });
  for (const d of core.deals) if (d.exclusivity) out.push({ kind: "exclusivity", text: `${d.brand}: ${d.exclusivity}`, basis: [{ kind: "deal", id: d.id }] });
  const byKey = new Map(core.items.map((i) => [i.key, i]));
  for (const k of [...core.verdicts.denied].sort()) {
    const i = byKey.get(k);
    if (i) out.push({ kind: "denied", text: i.text, basis: [i.ref] });
  }
  return out.slice(0, IDENTITY_ENVELOPE.maxGuardrails);
}

const question = (proposition: string) => {
  const max = IDENTITY_LIMITS.question;
  const room = max - "Is this right? “”".length;
  const p = proposition.length > room ? `${proposition.slice(0, room - 1)}…` : proposition;
  return `Is this right? “${p}”`;
};

export function composeUnresolved(env: Pick<EnvelopeCore, "claims" | "items">): UnresolvedItem[] {
  const byKey = new Map(env.items.map((i) => [i.key, i]));
  const out: UnresolvedItem[] = [];
  for (const c of env.claims) {
    if (c.tier !== "unconfirmed" || !c.basis.length) continue;
    const disputed = c.basis.some((r) => byKey.get(refKey(r))?.source?.status === "disputed");
    out.push({ subject: c.proposition, question: question(c.proposition), reason: disputed ? "disputed" : "unconfirmed", evidence: c.basis });
  }
  // Disputed facts first (they are conflicts in the record), then the rest; capped.
  return out.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "disputed" ? -1 : 1)).slice(0, IDENTITY_ENVELOPE.maxUnresolved);
}

/** Every (a)/(b) part, from the envelope core. Deterministic. */
export function composeRules(core: Core): IdentityRulesParts {
  const C = IDENTITY_ENVELOPE;
  const u = usable(core);
  const { signatureMoments, proofPoints } = composeProof(core);

  const bc = assertionItem(core, "brands_causes");
  const impact = core.objectives.filter((o) => o.domain === "impact").map((o) => u.get({ kind: "objective", id: o.id })).filter((i): i is BasisItem => !!i);
  const valuesEvidence = dedupe([
    ...evidenceTopic(core, ["values_causes", "foundation_position"]).map(asItem),
    ...(bc ? [asItem(bc)] : []),
    ...impact.map(asItem),
    ...statementItems(core, ["values", "community"]).map(asItem),
  ], C.maxValuesEvidence);

  const causes = dedupe([
    ...core.firstLooks.flatMap((f) => f.causesMentioned.map((t) => ({ text: t, basis: [firstLookRef(f)], strength: "reported" as AdmissibleTier }))).filter((x) => u.get(x.basis[0])),
    ...(bc ? list(core.asserted.brands_causes.raw).map((t) => ({ text: t, basis: [bc.ref], strength: tierOf(bc) })) : []),
    ...evidenceTopic(core, ["values_causes", "foundation_position"]).flatMap((i) => {
      const id = (i.ref as { id: string }).id; const org = str(core.evidence.find((e) => e.id === id)?.claim.organization);
      return org ? [{ text: org, basis: [i.ref], strength: tierOf(i) }] : [];
    }),
  ], C.maxCauses);

  const hob = assertionItem(core, "hobbies");
  const interests = dedupe([
    ...core.firstLooks.flatMap((f) => f.interests.map((t) => ({ text: t, basis: [firstLookRef(f)], strength: "reported" as AdmissibleTier }))).filter((x) => u.get(x.basis[0])),
    ...(hob ? list(core.asserted.hobbies.raw).map((t) => ({ text: t, basis: [hob.ref], strength: tierOf(hob) })) : []),
    ...evidenceTopic(core, ["interests"]).map(asItem),
    ...statementItems(core, ["interests"]).map(asItem),
  ], C.maxInterests);

  const direction = composeDirection(core);
  const h = core.howToBeUnderstood;
  const ambitions = [
    ...direction.map((d) => ({ text: d.value, source: "objective" as const, basis: d.basis })),
    ...(h ? [{ text: h.value, source: "direction" as const, basis: [{ kind: "assertion", id: h.assertionId } as BasisRef] }] : []),
    ...statementItems(core, ["ambition"]).filter((i) => !(i.ref.kind === "said" && i.ref.source === "objective")).map((i) => ({ text: i.text, source: "statement" as const, basis: [i.ref] })),
  ].slice(0, C.maxAmbitions);

  const positioningDesired = composePositioningDesired(core);
  const nextFrom = positioningDesired ?? (direction[0] ? { value: direction[0].value, basis: direction[0].basis } : null);

  const associations = dedupe([
    ...evidenceTopic(core, ["association"]).map(asItem),
    ...core.deals.map((d) => u.get({ kind: "deal", id: d.id })).filter((i): i is BasisItem => !!i).map(asItem),
  ], C.maxAssociations);

  return {
    athleticIdentity: composeAthleticIdentity(core),
    valuesEvidence, causes, interests, ambitions, positioningDesired,
    chaptersNext: nextFrom ? { text: nextFrom.value, framing: "intent", basis: nextFrom.basis } : null,
    signatureMoments, proofPoints,
    voice: composeVoice(core),
    audience: composeAudience(core),
    associations,
    direction,
    howToBeUnderstood: h ? { value: h.value, said: h.said, basis: [{ kind: "assertion", id: h.assertionId }] } : null,
    directives: core.directives,
    guardrails: composeGuardrails(core),
    unresolved: composeUnresolved(core),
  };
}

/** Her approved statements that still stand (every cited basis in the envelope, admissible, not denied), by 0.2 field. */
export function composePinned(env: Pick<IdentityEnvelope, "approvedStatements" | "items" | "verdicts">): Array<{ field: ApprovedField; text: string; assertionId: string; basis: BasisRef[] }> {
  const byKey = new Map(env.items.map((i) => [i.key, i]));
  return env.approvedStatements.filter((s) => s.basis.every((r) => {
    const i = byKey.get(refKey(r));
    return !!i && isAdmissible(i.tier) && !env.verdicts.denied.has(i.key);
  })).map((s) => ({ field: APPROVED_TARGET_FIELD[s.target], text: s.text, assertionId: s.assertionId, basis: s.basis }));
}

/**
 * The semantic rule: ≥ minAthleticIdentityItems Established items that say who she is as an athlete, and
 * ≥ minOtherKindItems admissible items from a different kind of source.
 */
export function sufficiencyOf(items: BasisItem[], cfg = IDENTITY_SUFFICIENCY): Sufficiency {
  const reasons: string[] = [];
  const athletic = items.filter((i) => i.athleticIdentity && i.tier === "established");
  const kinds = new Set(athletic.map((i) => i.ref.kind));
  const other = items.filter((i) => isAdmissible(i.tier) && !kinds.has(i.ref.kind) && !i.athleticIdentity);
  if (athletic.length < cfg.minAthleticIdentityItems) reasons.push("no established item yet says who the athlete is as an athlete (sport, team or level)");
  if (other.length < cfg.minOtherKindItems) reasons.push("nothing yet from a second kind of source");
  return { met: reasons.length === 0, reasons };
}
