/**
 * claims.ts — the admissibility policy identity-admissibility/0.2, deterministic (Concept 0.4 Part B).
 *
 *   1. Each SOURCE gets its own tier from what it is (sourceTier* below). A source's own tier never changes.
 *   2. Structured items group into CLAIMS by fact key + normalised value; free text groups only on an exact match of
 *      its normalised text (syndicated copies of one story) — never fuzzy matching.
 *   3. A claim's tier comes from its sources, the same rule for every claim (assessClaim):
 *        her denial                                             → excluded
 *        an Established source, or her confirmation             → established
 *        ≥ N independent reputable domains, all retrieved       → established
 *        ≥ N independent reputable domains, any lineage (Q1)    → reported (at least)
 *        any Reported source                                    → reported
 *        otherwise                                              → unconfirmed
 *   The validator uses the same function for a free-text sentence: its tier is assessClaim over the bases it cites.
 */
import { IDENTITY_ADMISSIBILITY, IDENTITY_PROOF } from "./config";
import { refKey, type BasisItem, type BasisRef, type ClaimAssessment, type Tier } from "./contract";

type Policy = typeof IDENTITY_ADMISSIBILITY;

// ── source tiers ────────────────────────────────────────────────────────────

/** athlete_facts: a current or historical canonical fact is Established; a disputed one is Unconfirmed. */
export function sourceTierOfFact(status: string): Tier {
  if (status === "current" || status === "historical") return "established";
  if (status === "disputed") return "unconfirmed";
  return "excluded";
}

/**
 * research_evidence: tier from lineage + source type. Suspect and superseded rows never reach here.
 * 0.2: an `athlete_statement` is her verbatim words only when the targeted read found them (lineage source_read) —
 * then Reported, whatever the outlet; any other lineage (a quote seen through search grounding) is Excluded.
 */
export function sourceTierOfEvidence(e: { lineage: string; sourceType: string; kind?: string }, p: Policy = IDENTITY_ADMISSIBILITY): Tier {
  if (e.kind === "athlete_statement") return e.lineage === p.sourceReadLineage ? "reported" : "excluded";
  if (p.establishedLineages.includes(e.lineage) && p.establishedSourceTypes.includes(e.sourceType)) return "established";
  if (p.retrievedLineages.includes(e.lineage) && p.reportedSourceTypes.includes(e.sourceType)) return "reported";
  return "unconfirmed";
}

/** The text with honour-tier labels ("First Team", "1st team", "first-round" …) blanked out: a tier label is never a
 *  historic "first". Case-insensitive, whole words. */
export function withoutTierLabels(text: string, labels: readonly string[] = IDENTITY_PROOF.tierLabels): string {
  let out = text;
  for (const l of labels) {
    const pattern = l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[\\s-]");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return out;
}

// ── grouping ────────────────────────────────────────────────────────────────

/** Lower case, letters and digits only, single spaces. Exact-match grouping, never similarity. */
export function normaliseText(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const TWO_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.nz", "co.za", "com.au", "com.br", "com.mx", "co.in", "com.sg", "co.kr", "com.tr", "com.cn", "net.au", "org.au"]);

/** eTLD+1 (a small public-suffix list): news.example.com and example.com are ONE independent source. */
export function registrableDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!d || !d.includes(".")) return null;
  const parts = d.split(".");
  const keep = TWO_LABEL_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

// ── claim tier ──────────────────────────────────────────────────────────────

export interface AthleteVerdicts {
  /** refKeys she denied (claim_confirmation answer=no, or a dispute naming the ref). */
  denied: ReadonlySet<string>;
  /** refKeys she confirmed (claim_confirmation answer=yes). */
  confirmed: ReadonlySet<string>;
}
export const NO_VERDICTS: AthleteVerdicts = { denied: new Set(), confirmed: new Set() };

export interface ClaimTier { tier: Tier; independentDomains: number; athleteConfirmed: boolean; confidenceReason: string }

/** The one corroboration rule. `items` are the sources of one claim (or the bases one sentence cites). */
export function assessClaim(items: BasisItem[], v: AthleteVerdicts = NO_VERDICTS, p: Policy = IDENTITY_ADMISSIBILITY): ClaimTier {
  const content = items.filter((i) => i.sourceTier !== "salience");
  const evidence = content.filter((i) => i.ref.kind === "evidence" && i.sourceTier !== "excluded" && p.reputableSourceTypes.includes(i.source?.type ?? ""));
  const domains = new Set(evidence.map((i) => registrableDomain(i.source?.domain)).filter((d): d is string => !!d));
  const retrievedDomains = new Set(evidence.filter((i) => p.retrievedLineages.includes(i.source?.lineage ?? "")).map((i) => registrableDomain(i.source?.domain)).filter((d): d is string => !!d));
  const athleteConfirmed = content.some((i) => v.confirmed.has(i.key));
  const base = { independentDomains: domains.size, athleteConfirmed };

  if (!content.length) return { tier: "excluded", ...base, confidenceReason: "no content basis" };
  if (content.some((i) => v.denied.has(i.key))) return { tier: "excluded", ...base, confidenceReason: "the athlete said this is not right" };
  if (athleteConfirmed) return { tier: "established", ...base, confidenceReason: "the athlete confirmed it" };
  const est = content.find((i) => i.sourceTier === "established");
  if (est) return { tier: "established", ...base, confidenceReason: est.athleteAuthority ? "the athlete's own record" : `established source (${est.ref.kind})` };
  if (retrievedDomains.size >= p.minIndependentDomains) return { tier: "established", ...base, confidenceReason: `${retrievedDomains.size} independent reputable sources, retrieved` };
  if (domains.size >= p.minIndependentDomains) return { tier: "reported", ...base, confidenceReason: `${domains.size} reputable outlets named; ${domains.size - retrievedDomains.size} not retrieved` };
  if (content.some((i) => i.sourceTier === "reported")) return { tier: "reported", ...base, confidenceReason: "one reputable or first-party source" };
  if (content.every((i) => i.sourceTier === "excluded")) return { tier: "excluded", ...base, confidenceReason: "excluded sources only" };
  return { tier: "unconfirmed", ...base, confidenceReason: domains.size ? "one reputable outlet named; page not retrieved" : "no reputable source" };
}

/**
 * Group items into claims and write each item's effective tier (its claim's tier). Items with no claim key are their
 * own claim. Returns the claim list (content items only; State findings are salience, never claims).
 */
export function assessClaims(items: BasisItem[], v: AthleteVerdicts = NO_VERDICTS, p: Policy = IDENTITY_ADMISSIBILITY): ClaimAssessment[] {
  const groups = new Map<string, BasisItem[]>();
  for (const i of items) {
    if (i.sourceTier === "salience") { i.tier = "salience"; continue; }
    const k = i.claimKey ?? `item:${i.key}`;
    const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]);
  }
  const out: ClaimAssessment[] = [];
  for (const g of groups.values()) {
    const t = assessClaim(g, v, p);
    for (const i of g) i.tier = t.tier;
    out.push({
      proposition: g[0].text,
      tier: t.tier,
      basis: g.map((i) => i.ref),
      corroboration: { independentDomains: t.independentDomains, athleteConfirmed: t.athleteConfirmed },
      confidenceReason: t.confidenceReason,
    });
  }
  return out.sort((a, b) => a.proposition.localeCompare(b.proposition) || refKey(a.basis[0]).localeCompare(refKey(b.basis[0])));
}

export const isAdmissible = (t: BasisItem["tier"]): t is "established" | "reported" => t === "established" || t === "reported";

export function refsOf(items: BasisItem[]): BasisRef[] { return items.map((i) => i.ref); }
