/**
 * research/benchmark/evidence.ts — derive evidence, facts, item coverage and follower mentions from one arm, in memory.
 *
 * The SAME rules persist.ts applies when it writes a run — lineage validation, suspect screening,
 * denied domains, source-type tiers assigned by Nomila's policy from the cited domain (never by the
 * provider), the resolver with the effective policy — with no database. Extended for cited-claims/3:
 * the seven evidence-only kinds are recorded and grouped by ResearchSpec section but never reach the
 * resolver; item coverage is derived from cited claims next to what the extractor reported; and, since
 * 13 Sep 2026, a versioned deterministic canonicalization (`claim-canonicalization/2`) runs between the
 * parsed claim and the STRICT registry, with the raw value, the canonical value and the rules applied kept
 * on the evidence record. Anything the rules cannot safely handle stays refused by the registry.
 */

import { valueTextFor, getFactDefinition, isRegisteredKey, validateFactValue } from "../factRegistry";
import { claimIsSuspect, domainAllowed } from "../injection";
import { validateCitation } from "../lineage";
import { classifySourceType, type ResearchPolicy } from "../policy";
import type { SearchEnvelope } from "../providers";
import { KIND_DOMAIN, SOURCE_TYPE_TIER, type EvidenceKind, type ResearchDomain } from "../registries";
import { canonicalizeValue } from "../spec/canonicalize";
import { EVIDENCE_KINDS_V3, NEW_KIND_DOMAIN, sectionCoverage, sectionOf, sectionsFor, type ClaimView, type EvidenceKindV3, type ExtractedClaimV3 } from "../spec/researchSpecV1";
import { extractionDegenerate } from "./recovery";
import { ACCEPTED_LEVELS, type AcceptancePolicy, type DirectClaim } from "../spec/directEvidenceV1";
import type { ArmRun, DerivedArm, EvidenceRecord, FollowerMention } from "./types";

const norm = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Comparison text for claims with no registered fact key. */
export function kindValueText(kind: EvidenceKindV3, claim: Record<string, unknown>): string {
  switch (kind) {
    case "press_mention": return [norm(claim.outlet), norm(claim.headline)].filter(Boolean).join(" | ");
    case "brand_mention": return [norm(claim.brand), norm(claim.type)].filter(Boolean).join(" | ");
    case "social_handle": return `${norm(claim.platform)}:@${norm(claim.handle).replace(/^@/, "")}`;
    case "social_metric_claim": return `${norm(claim.platform)}:${norm(claim.metric)}=${norm(claim.metricValue)}@${norm(claim.statedOn)}`;
    case "career_event": return `${norm(claim.eventKind)}:${norm(claim.event)}@${norm(claim.date)}`;
    case "reputation_event": return `${norm(claim.stage)}:${norm(claim.event)}@${norm(claim.date)}`;
    case "representation": return `${norm(claim.agency)}${claim.agent ? ` (${norm(claim.agent)})` : ""}`;
    case "venture": return `${norm(claim.name)}:${norm(claim.ventureKind)}`;
    case "crossover_appearance": return `${norm(claim.medium)}:${norm(claim.title)}`;
    case "narrative_claim": return `${norm(claim.topic)}:${norm(claim.text)}`;
    case "media_asset": return norm(claim.url ?? claim.title ?? claim);
    default: return norm(claim.value ?? claim);
  }
}

export function evidenceValueText(kind: EvidenceKindV3, factKey: string | null, claim: Record<string, unknown>): string {
  if (factKey && "value" in claim) { try { const t = valueTextFor(factKey, claim.value); if (typeof t === "string" && t.trim()) return t; } catch { /* unregistered shape: fall through */ } }
  if (kind === "profile_attribute" && claim.factKey === "birth_year") return norm((claim.value as any)?.year ?? claim.value);
  return kindValueText(kind, claim);
}

export function deriveEvidence(arm: ArmRun, policy: ResearchPolicy, acceptance: AcceptancePolicy = "retrieved"): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const claims: ExtractedClaimV3[] = arm.extraction?.claims ?? [];
  const direct = arm.extraction?.extractionMode === "provider_direct";
  for (const [idx, c] of claims.entries()) {
    if (!(EVIDENCE_KINDS_V3 as readonly string[]).includes(c.kind) || !c.claim || typeof c.claim !== "object") continue;
    const kind = c.kind as EvidenceKindV3;
    const rawClaim = c.claim as Record<string, unknown>;
    const claimedFactKey = typeof rawClaim.factKey === "string" ? rawClaim.factKey : null;
    const factKey = claimedFactKey && isRegisteredKey(claimedFactKey) ? claimedFactKey : null;
    // Canonicalization sits between the parsed claim and the strict registry; the raw value is kept beside it.
    let claim = rawClaim;
    let canonicalization: EvidenceRecord["canonicalization"] = null;
    let registry: EvidenceRecord["registry"] = { status: "not_applicable", reason: null };
    if (factKey && "value" in rawClaim) {
      const cz = canonicalizeValue(factKey, rawClaim.value);
      claim = { ...rawClaim, value: cz.value };
      canonicalization = { version: cz.version, applied: cz.applied, rawValue: cz.raw, canonicalValue: cz.value };
      try { validateFactValue(factKey, cz.value); registry = { status: cz.applied.length ? "accepted_canonicalized" : "accepted", reason: null }; }
      catch (e: any) { registry = { status: "refused", reason: String(e?.message ?? e).slice(0, 200) }; }
    }
    const domain: ResearchDomain = factKey ? getFactDefinition(factKey).domain : (KIND_DOMAIN[kind as EvidenceKind] ?? NEW_KIND_DOMAIN[kind] ?? "profile");
    // Path B: lineage is the deterministic native-lineage level judged under the acceptance policy; path A: the citation check.
    const dl = direct ? (c as DirectClaim).lineage : null;
    const check = direct
      ? (() => { const ok = !!dl && ACCEPTED_LEVELS[acceptance].includes(dl.level); const bound = dl?.boundChunkIds.map((id) => arm.search.flatMap((e) => e.chunks).find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x) ?? []; return { status: (ok && bound.length ? "cited" : "uncited") as "cited" | "uncited", chunk: bound[0] ?? null, reason: dl ? `${dl.level}${dl.detail ? `: ${dl.detail}` : ""}` : "no lineage", quoteKind: bound[0] ? (bound[0].textKind === "source_excerpt" ? "source_excerpt" : "provider_answer") : null }; })()
      : validateCitation(c.citation, arm.search);
    const suspect = claimIsSuspect({ claim, citation: c.citation });
    const chunk = check.chunk;
    if (chunk && !domainAllowed(chunk.domain, policy.domains)) continue;
    const sourceType = chunk ? classifySourceType(chunk.domain, policy) : "unknown";
    const envelope = chunk ? arm.search.find((e) => e.chunks.some((x) => x.id === chunk.id)) : undefined;
    out.push({
      id: `${arm.provider}:e${idx}`, kind, claimedFactKey, factKey, claim, valueText: evidenceValueText(kind, factKey, claim), section: sectionOf(kind, claimedFactKey), domain,
      canonicalization, registry, provenanceLevel: dl?.level ?? null, provenanceMatch: dl?.match ?? null, acceptancePolicy: direct ? acceptance : null,
      lineage: check.status, lineageReason: check.reason, suspect,
      sourceUrl: chunk?.url ?? null, sourceDomain: chunk?.domain ?? null, sourceType, tier: SOURCE_TYPE_TIER[sourceType],
      confidence: Math.max(0, Math.min(1, c.confidence ?? 0.5)), publishedAt: c.publishedAt ?? null,
      quote: c.citation?.quote ? c.citation.quote.slice(0, 300) : null, quoteKind: check.quoteKind, queryName: envelope?.queryName ?? null,
    });
  }
  return out;
}

/** Only REGISTERED fact keys reach the resolver (with their canonicalized value); evidence-only kinds and v3 keys never become facts. */
export function deriveFacts(evidence: EvidenceRecord[], policy: ResearchPolicy, asOf: string, retrievedAt: string): { facts: NewFact[]; refused: Array<{ factKey: string; reason: string }>; proposals: number; disputedKeys: string[] } {
  // Path B: a claim whose provenance level is not accepted under the policy (asserted_only / unsupported, or native_retrieved
  // under strict) never reaches the resolver — it can never become a canonical fact. Path A keeps the substrate rule
  // (an uncited Kimi claim reaches the resolver with its confidence capped).
  const candidates: Candidate[] = evidence.filter((e) => e.factKey && "value" in e.claim && !(e.acceptancePolicy && e.lineage !== "cited")).map((e) => ({
    factKey: e.factKey!, value: e.claim.value, evidenceId: e.id, sourceClass: "web_researched", sourceType: e.sourceType, sourceDomain: e.sourceDomain,
    lineageStatus: e.lineage, suspect: e.suspect, confidence: e.confidence, publishedAt: e.publishedAt, retrievedAt, origin: "research",
  }));
  const r = resolveFacts([], candidates, [], { asOf, ttlDays: policy.ttlDays, minCorroboration: policy.minCorroboration, uncitedConfidenceCap: policy.uncitedConfidenceCap, hasAssertedAffiliations: false });
  const facts: NewFact[] = []; const refused: Array<{ factKey: string; reason: string }> = []; let proposals = 0;
  for (const d of r.decisions) {
    if (d.action === "insert") facts.push(d.fact);
    else if (d.action === "refuse") refused.push({ factKey: d.factKey, reason: d.reason });
    else if (d.action === "propose") proposals++;
  }
  return { facts, refused, proposals, disputedKeys: r.disputedKeys };
}

import { resolveFacts, type Candidate, type NewFact } from "../resolve";

const FOLLOWER_RE = /(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k|m|thousand|million)?\s*\+?\s*(followers|subscribers)\b/gi;
const PLATFORM_RE = /\b(instagram|tiktok|youtube|twitter|x\.com|threads|facebook|snapchat)\b/i;

function parseCount(num: string, unit: string | undefined): number {
  const n = Number(num.replace(/,/g, "").replace(/\.(?=\d{3}\b)/g, ""));
  const u = (unit ?? "").toLowerCase();
  return Math.round(n * (u === "k" || u === "thousand" ? 1e3 : u === "m" || u === "million" ? 1e6 : 1));
}

/** Follower-count statements in provider chunk text — a regex cross-check on `social_metric_claim` extraction. Never a fact, never a signal. */
export function followerMentions(search: SearchEnvelope[]): FollowerMention[] {
  const out: FollowerMention[] = [];
  for (const e of search) for (const c of e.chunks) {
    const text = c.text || "";
    let m: RegExpExecArray | null;
    FOLLOWER_RE.lastIndex = 0;
    while ((m = FOLLOWER_RE.exec(text))) {
      const count = parseCount(m[1], m[2]);
      if (!Number.isFinite(count) || count <= 0) continue;
      const window = text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + m[0].length + 40));
      const platform = PLATFORM_RE.exec(window)?.[1]?.toLowerCase().replace("x.com", "x") ?? null;
      out.push({ chunkId: c.id, url: c.url, domain: c.domain, platform, count, quote: window.trim().slice(0, 200) });
    }
  }
  return out;
}

export function deriveArm(arm: ArmRun, policy: ResearchPolicy, isMinor = false, acceptance: AcceptancePolicy = "retrieved"): DerivedArm {
  const evidence = deriveEvidence(arm, policy, acceptance);
  const retrievedAt = arm.finishedAt || arm.asOf;
  const f = deriveFacts(evidence, policy, arm.asOf, retrievedAt);
  const sectionOutcomes = arm.extraction?.sectionOutcomes ?? {};
  const views: ClaimView[] = evidence.map((e) => ({ kind: e.kind, claimedFactKey: e.claimedFactKey, claim: e.claim, cited: e.lineage === "cited" && !e.suspect }));
  const coverage = sectionsFor(isMinor).map((section) => sectionCoverage(section, views.filter((v) => sectionOf(v.kind, v.claimedFactKey) === section.id), sectionOutcomes[section.id]));
  const rawAic = (arm.extraction?.raw as any)?.aboutIdentityConfidence;
  const reg = { accepted: 0, acceptedCanonicalized: 0, refused: 0, notApplicable: 0, rulesApplied: {} as Record<string, number>, refusalReasons: {} as Record<string, number> };
  for (const e of evidence) {
    if (e.registry.status === "accepted") reg.accepted++; else if (e.registry.status === "accepted_canonicalized") reg.acceptedCanonicalized++; else if (e.registry.status === "refused") { reg.refused++; const k = (e.registry.reason ?? "").split(":").slice(0, 2).join(":").slice(0, 60); reg.refusalReasons[k] = (reg.refusalReasons[k] ?? 0) + 1; } else reg.notApplicable++;
    for (const r of e.canonicalization?.applied ?? []) { const k = r.split(":").slice(0, 2).join(":"); reg.rulesApplied[k] = (reg.rulesApplied[k] ?? 0) + 1; }
  }
  return {
    provider: arm.provider, evidence, facts: f.facts, refused: f.refused, proposals: f.proposals, disputedKeys: f.disputedKeys,
    followerMentions: followerMentions(arm.search), sectionOutcomes, coverage, registry: reg,
    aboutIdentityConfidence: typeof rawAic === "number" ? rawAic : null,
    extractionFailed: !arm.extraction || arm.extraction.errors.length > 0 || extractionDegenerate(arm, isMinor).degenerate,
  };
}
