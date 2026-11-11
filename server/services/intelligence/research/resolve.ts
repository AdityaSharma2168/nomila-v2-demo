/**
 * research/resolve.ts — evidence → facts by the source-authority policy (design §4.3, R1, R3, R4).
 *
 * Pure. Input: the athlete's existing fact rows, the new evidence candidates of one run (each
 * already validated for lineage and injection), the athlete's assertions, and the policy.
 * Output: insert decisions (with the rows they supersede), refusals, proposals. Nothing here
 * touches the database or a provider.
 *
 * Rules (numbered as in the design):
 *   1. group by fact key + registry-normalized value; suspect and uncited evidence never
 *      establishes a fact (uncited may corroborate; alone it yields a `disputed` row);
 *   2. origin first: athlete_proof > athlete_asserted > connection > research; an assertion
 *      wins its key and supersedes conflicting researched rows;
 *   3. within research: rank by best source tier, then corroboration (distinct domains), then
 *      recency, then confidence — newer + higher confidence alone never displaces a higher tier;
 *   4. displacement of a current value: better tier, or tier ≤ 2, or (current past its TTL and
 *      ≥ minCorroboration independent domains); otherwise the candidate is `disputed`;
 *   5. time: valid_to in the past → historical; class_year is current only for its season;
 *      dated achievements are historical facts;
 *   6. insert + supersede, never overwrite;
 *   7. affiliations for an athlete with no said/proof rows: tier ≤ 2 with a season/date, or two
 *      independent tier ≤ 3 domains agreeing on org + season, establish a current (and primary)
 *      affiliation; otherwise a proposal. With said/proof rows, research only proposes.
 *   R1: `inferred` / `imputed` source classes are refused as fact sources.
 */

import { getFactDefinition, isRegisteredKey, RegistryError, validateFactValue, valueTextFor, FACT_REGISTRY_VERSION } from "./factRegistry";
import { AUTHORITATIVE_TIER, CORROBORATING_TIER, SOURCE_TYPE_TIER, type FactOrigin, type FactSourceClass, type FactStatus, type FreshnessFamily, type LineageStatus, type SourceType } from "./registries";

export const RESOLVER_VERSION = "v3";   // v3: a newer affiliation ends or outranks her current one only when the change is established (a stated start or independent corroboration); v2 (registry v3): an affiliation re-established without a role keeps the same org + season row's role
const DAY = 86_400_000;

export interface Provenance { evidenceIds: string[]; assertedId?: string | null; proofId?: string | null; connectionId?: string | null; domains?: string[]; corroboration?: number; note?: string }

export interface FactRow {
  id: string; factKey: string; value: any; valueText: string; status: FactStatus; origin: FactOrigin; sourceClass: FactSourceClass | null;
  authorityTier: number | null; confidence: number; retrievedAt: string; observedAt: string | null; validFrom: string | null; validTo: string | null; provenance: Provenance;
}

export interface Candidate {
  factKey: string; value: unknown; evidenceId: string;
  sourceClass: string;                 // canonical; inferred/imputed are refused
  sourceType: SourceType; sourceDomain: string | null; lineageStatus: LineageStatus; suspect: boolean;
  confidence: number; publishedAt: string | null; retrievedAt: string;
  origin?: "research" | "backfill" | "connection";
}

export interface Assertion { factKey: string; value: unknown; assertedId: string; kind: "asserted" | "proof"; at: string }

export interface ResolvePolicy {
  asOf: string;
  ttlDays: Record<FreshnessFamily, number | null>;
  minCorroboration: number;
  uncitedConfidenceCap: number;
  /** The athlete has said/proof affiliation rows in the ledger: research only proposes (rule 7). */
  hasAssertedAffiliations: boolean;
}

export interface NewFact {
  factKey: string; value: any; valueText: string; status: FactStatus; origin: FactOrigin; sourceClass: FactSourceClass | null; authorityTier: number | null;
  confidence: number; observedAt: string | null; retrievedAt: string; validFrom: string | null; validTo: string | null; provenance: Provenance;
  freshnessFamily: FreshnessFamily; resolverVersion: string; registryVersion: string;
}

export type Decision =
  | { action: "insert"; fact: NewFact; supersedes: string[] }
  | { action: "refuse"; factKey: string; evidenceId: string; reason: string }
  | { action: "noop"; factKey: string; reason: string; evidenceIds: string[] }
  | { action: "propose"; factKey: "affiliation"; value: any; evidenceIds: string[]; tier: number; corroboration: number; reason: string };

export interface ResolveResult { decisions: Decision[]; disputedKeys: string[]; establishedAffiliations: number }

interface Group {
  factKey: string; valueText: string; value: any; evidenceIds: string[]; domains: Set<string>; tier: number; cited: boolean; confidence: number;
  latest: string; publishedAt: string | null; sourceClass: FactSourceClass; origin: "research" | "backfill" | "connection";
}

const later = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : new Date(a) > new Date(b) ? a : b);

function groupCandidates(cands: Candidate[], policy: ResolvePolicy): { groups: Group[]; refusals: Decision[] } {
  const refusals: Decision[] = [];
  const map = new Map<string, Group>();
  for (const c of cands) {
    if (c.sourceClass === "inferred" || c.sourceClass === "imputed") { refusals.push({ action: "refuse", factKey: c.factKey, evidenceId: c.evidenceId, reason: `source_class ${c.sourceClass} can never source a fact (R1)` }); continue; }
    if (!["connected_verified", "platform_public", "web_researched"].includes(c.sourceClass)) { refusals.push({ action: "refuse", factKey: c.factKey, evidenceId: c.evidenceId, reason: `unknown source_class ${c.sourceClass}` }); continue; }
    if (c.suspect) { refusals.push({ action: "refuse", factKey: c.factKey, evidenceId: c.evidenceId, reason: "suspect: instruction-like text in the claim" }); continue; }
    if (!isRegisteredKey(c.factKey)) { refusals.push({ action: "refuse", factKey: c.factKey, evidenceId: c.evidenceId, reason: `unregistered fact key (registry ${FACT_REGISTRY_VERSION})` }); continue; }
    let value: any;
    try { value = validateFactValue(c.factKey, c.value); } catch (e: any) { refusals.push({ action: "refuse", factKey: c.factKey, evidenceId: c.evidenceId, reason: e instanceof RegistryError ? e.message : String(e) }); continue; }
    const valueText = valueTextFor(c.factKey, value);
    const key = `${c.factKey}|${valueText}`;
    const tier = SOURCE_TYPE_TIER[c.sourceType] ?? 8;
    const cited = c.lineageStatus === "cited";
    const conf = cited ? c.confidence : Math.min(c.confidence, policy.uncitedConfidenceCap);
    const g = map.get(key);
    if (!g) map.set(key, { factKey: c.factKey, valueText, value, evidenceIds: [c.evidenceId], domains: new Set(cited && c.sourceDomain ? [c.sourceDomain] : []), tier: cited ? tier : 8, cited, confidence: conf, latest: c.retrievedAt, publishedAt: c.publishedAt, sourceClass: c.sourceClass as FactSourceClass, origin: c.origin ?? "research" });
    else {
      g.evidenceIds.push(c.evidenceId);
      if (cited) { if (c.sourceDomain) g.domains.add(c.sourceDomain); g.tier = Math.min(g.tier, tier); g.cited = true; }
      g.confidence = Math.max(g.confidence, conf); g.latest = later(g.latest, c.retrievedAt)!; g.publishedAt = later(g.publishedAt, c.publishedAt);
      if (c.sourceClass === "connected_verified") g.sourceClass = "connected_verified";
    }
  }
  return { groups: [...map.values()], refusals };
}

const rankGroups = (a: Group, b: Group) => (a.tier - b.tier) || (b.domains.size - a.domains.size) || (new Date(later(b.publishedAt, b.latest)!).getTime() - new Date(later(a.publishedAt, a.latest)!).getTime()) || (b.confidence - a.confidence);

function isStale(row: FactRow, family: FreshnessFamily, policy: ResolvePolicy): boolean {
  const ttl = policy.ttlDays[family];
  if (ttl == null) return false;
  return new Date(policy.asOf).getTime() - new Date(row.retrievedAt).getTime() > ttl * DAY;
}

/** Rule 5: a class-year label is current only for the season it names; academic labels roll over in August. */
export function classYearValidity(season: number, asOf: string): { status: "current" | "historical"; validFrom: string; validTo: string } {
  const d = new Date(asOf);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const current = season === y || (m >= 8 && season === y + 1);
  return { status: current ? "current" : "historical", validFrom: `${season - 1}-08-01`, validTo: `${season}-12-31` };
}

function timeFor(factKey: string, value: any, policy: ResolvePolicy): { status: FactStatus; validFrom: string | null; validTo: string | null } {
  if (factKey === "class_year") return classYearValidity(value.season, policy.asOf);
  const def = getFactDefinition(factKey);
  if (def.cardinality === "dated_multi" && factKey !== "affiliation") {
    const date = value.date ?? (value.year ? `${value.year}-01-01` : null);
    return { status: date ? "historical" : "current", validFrom: date, validTo: date ? (value.date ?? `${value.year}-12-31`) : null };
  }
  return { status: "current", validFrom: null, validTo: null };
}

function mk(g: Group, status: FactStatus, provenance: Provenance, policy: ResolvePolicy, overrides: Partial<NewFact> = {}): NewFact {
  const def = getFactDefinition(g.factKey);
  const t = timeFor(g.factKey, g.value, policy);
  return { factKey: g.factKey, value: g.value, valueText: g.valueText, status: status === "current" ? t.status : status, origin: g.origin, sourceClass: g.sourceClass, authorityTier: g.cited ? g.tier : null,
    confidence: g.confidence, observedAt: g.publishedAt, retrievedAt: g.latest, validFrom: t.validFrom, validTo: t.validTo, provenance, freshnessFamily: def.freshnessFamily, resolverVersion: RESOLVER_VERSION, registryVersion: FACT_REGISTRY_VERSION, ...overrides };
}
const prov = (g: Group, extra: Partial<Provenance> = {}): Provenance => ({ evidenceIds: g.evidenceIds, domains: [...g.domains], corroboration: g.domains.size, ...extra });

export function resolveFacts(existing: FactRow[], candidates: Candidate[], assertions: Assertion[], policy: ResolvePolicy): ResolveResult {
  const { groups, refusals } = groupCandidates(candidates, policy);
  const decisions: Decision[] = [...refusals];
  const disputed = new Set<string>();
  let established = 0;
  const byKey = new Map<string, Group[]>();
  for (const g of groups) (byKey.get(g.factKey) ?? byKey.set(g.factKey, []).get(g.factKey)!).push(g);
  const currentOf = (key: string) => existing.filter((r) => r.factKey === key && r.status === "current");

  // ── rule 2: assertions win their key ──
  const assertedKeys = new Set<string>();
  for (const a of assertions) {
    if (!isRegisteredKey(a.factKey)) continue;
    let value: any; try { value = validateFactValue(a.factKey, a.value); } catch (e: any) { decisions.push({ action: "refuse", factKey: a.factKey, evidenceId: a.assertedId, reason: e.message }); continue; }
    assertedKeys.add(a.factKey);
    const def = getFactDefinition(a.factKey);
    const valueText = def.normalizer(value);
    const same = currentOf(a.factKey).find((r) => r.valueText === valueText && (r.origin === "athlete_asserted" || r.origin === "athlete_proof"));
    if (same) { decisions.push({ action: "noop", factKey: a.factKey, reason: "assertion already current", evidenceIds: [] }); continue; }
    // The athlete's word settles the key: conflicting current rows AND earlier disputed rows are superseded (R2/R4).
    const supersedes = existing.filter((r) => r.factKey === a.factKey && (r.status === "current" || r.status === "disputed") && (r.valueText !== valueText || r.origin === "research" || r.origin === "backfill")).map((r) => r.id);
    const t = timeFor(a.factKey, value, policy);
    decisions.push({ action: "insert", supersedes, fact: { factKey: a.factKey, value, valueText, status: t.status, origin: a.kind === "proof" ? "athlete_proof" : "athlete_asserted", sourceClass: null, authorityTier: null, confidence: 1, observedAt: a.at, retrievedAt: a.at, validFrom: t.validFrom, validTo: t.validTo, provenance: { evidenceIds: [], assertedId: a.kind === "asserted" ? a.assertedId : null, proofId: a.kind === "proof" ? a.assertedId : null }, freshnessFamily: def.freshnessFamily, resolverVersion: RESOLVER_VERSION, registryVersion: FACT_REGISTRY_VERSION } });
  }

  for (const [key, gs] of byKey) {
    const def = getFactDefinition(key);
    if (assertedKeys.has(key) || (key === "affiliation" && policy.hasAssertedAffiliations && def.resolver === "affiliation")) {
      // The athlete's word stands; researched candidates only corroborate or propose.
      if (key === "affiliation") for (const g of gs.sort(rankGroups)) decisions.push({ action: "propose", factKey: "affiliation", value: g.value, evidenceIds: g.evidenceIds, tier: g.tier, corroboration: g.domains.size, reason: "athlete has said/proof affiliations; research proposes only" });
      else decisions.push({ action: "noop", factKey: key, reason: "overridden by the athlete's assertion", evidenceIds: gs.flatMap((g) => g.evidenceIds) });
      continue;
    }
    const cur = currentOf(key);
    switch (def.resolver) {
      case "affiliation": {
        const ranked = gs.sort(rankGroups);
        const asserted = cur.filter((r) => r.origin === "athlete_asserted" || r.origin === "athlete_proof");
        for (const g of ranked) {
          const dated = g.value.season != null || g.value.from != null;
          const establish = g.cited && ((g.tier <= AUTHORITATIVE_TIER && dated) || (g.domains.size >= policy.minCorroboration && g.tier <= CORROBORATING_TIER && dated)) && asserted.length === 0;
          if (!establish) { decisions.push({ action: "propose", factKey: "affiliation", value: g.value, evidenceIds: g.evidenceIds, tier: g.tier, corroboration: g.domains.size, reason: g.cited ? "below the establishing bar (rule 7)" : "uncited evidence cannot establish an affiliation" }); continue; }
          const sameOrg = cur.filter((r) => r.factKey === "affiliation" && getFactDefinition("affiliation").normalizer({ ...r.value, season: null, from: null }) === def.normalizer({ ...g.value, season: null, from: null }));
          const seasonOf = (v: any) => v.season ?? (v.from ? Number(String(v.from).slice(0, 4)) : null);
          const newer = seasonOf(g.value);
          const supersedes: string[] = [];
          const others = cur.filter((r) => !sameOrg.includes(r));
          // A newer affiliation replaces her current one only when the evidence establishes the CHANGE: a stated start
          // (`from`, e.g. "joined in 2026") or independent corroboration. One source seeing a team as current in a later
          // season is not that — the new team is added alongside, not made primary, and nothing is ended.
          const changeEstablished = g.value.from != null || g.domains.size >= policy.minCorroboration;
          let primary = changeEstablished || !others.some((o) => o.status === "current");
          for (const o of others) { const s = seasonOf(o.value); if (s != null && newer != null && s > newer) primary = false; }
          for (const r of sameOrg) supersedes.push(r.id);
          // v2: a role (e.g. an officially sourced captaincy) on the same org + season row survives a re-statement that states no role
          const carried = g.value.role ? null : sameOrg.find((r) => r.valueText === def.normalizer(g.value) && r.value?.role);
          const roleFields = carried ? Object.fromEntries(["role", "roleSince", "roleSeason"].filter((k) => carried.value[k] != null).map((k) => [k, carried.value[k]])) : {};
          const fact = mk(g, "current", prov(g, { note: "established by rule 7" }), policy, { value: { ...g.value, ...roleFields, primary }, valueText: def.normalizer(g.value) });
          decisions.push({ action: "insert", fact, supersedes });
          established++;
          // An older current affiliation of a different org becomes historical when this one is newer (its own season ended)
          // — only when the change is established (above).
          if (changeEstablished) for (const o of others) { const s = seasonOf(o.value); if (s != null && newer != null && s < newer && o.status === "current") decisions.push({ action: "insert", supersedes: [o.id], fact: { ...rowToNew(o), status: "historical", validTo: `${s}-12-31`, provenance: { ...o.provenance, note: `ended: superseded by ${g.value.org} ${newer}` } } }); }
        }
        break;
      }
      case "dated_event": {
        for (const g of gs) {
          const dup = existing.find((r) => r.factKey === key && r.valueText === g.valueText && r.status !== "superseded");
          if (dup) { decisions.push({ action: "noop", factKey: key, reason: "already recorded", evidenceIds: g.evidenceIds }); continue; }
          if (!g.cited) { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: "uncited: not established" }), policy), supersedes: [] }); disputed.add(key); continue; }
          decisions.push({ action: "insert", fact: mk(g, "current", prov(g), policy), supersedes: [] });
        }
        break;
      }
      default: {
        if (def.cardinality === "multi") {
          for (const g of gs) {
            const same = cur.find((r) => r.valueText === g.valueText);
            if (same) { decisions.push({ action: "insert", fact: mk(g, "current", prov(g, { evidenceIds: [...same.provenance.evidenceIds, ...g.evidenceIds] }), policy, { authorityTier: Math.min(same.authorityTier ?? 8, g.cited ? g.tier : 8), confidence: Math.max(same.confidence, g.confidence) }), supersedes: [same.id] }); continue; }
            if (!g.cited) { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: "uncited: not established" }), policy), supersedes: [] }); disputed.add(key); continue; }
            decisions.push({ action: "insert", fact: mk(g, "current", prov(g), policy), supersedes: [] });
          }
          break;
        }
        // single-valued: authority_default (rules 3–4)
        const ranked = gs.sort(rankGroups);
        const best = ranked[0];
        const current = cur[0] ?? null;
        for (const g of ranked) {
          if (current && g.valueText === current.valueText) {
            // confirmation: same value → new current row with merged provenance, old superseded
            decisions.push({ action: "insert", fact: mk(g, "current", prov(g, { evidenceIds: [...current.provenance.evidenceIds, ...g.evidenceIds], domains: [...new Set([...(current.provenance.domains ?? []), ...g.domains])] }), policy, { authorityTier: Math.min(current.authorityTier ?? 8, g.cited ? g.tier : 8), confidence: Math.max(current.confidence, g.confidence), origin: current.origin === "connection" ? "connection" : g.origin }), supersedes: [current.id] });
            continue;
          }
          if (!g.cited) { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: "uncited: cannot establish a current fact" }), policy), supersedes: [] }); disputed.add(key); continue; }
          if (!current) {
            if (g === best) decisions.push({ action: "insert", fact: mk(g, "current", prov(g), policy), supersedes: [] });
            else { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: "outranked by another candidate" }), policy), supersedes: [] }); disputed.add(key); }
            continue;
          }
          if (current.origin === "connection" && g.sourceClass !== "connected_verified") { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: "current value comes from a connection" }), policy), supersedes: [] }); disputed.add(key); continue; }
          const curTier = current.authorityTier ?? 8;
          const displace = g === best && (g.tier < curTier || g.tier <= AUTHORITATIVE_TIER || (isStale(current, def.freshnessFamily, policy) && g.domains.size >= policy.minCorroboration));
          if (displace) { decisions.push({ action: "insert", fact: mk(g, "current", prov(g, { note: `displaced tier ${curTier} value "${current.valueText}"` }), policy), supersedes: [current.id] }); }
          else { decisions.push({ action: "insert", fact: mk(g, "disputed", prov(g, { note: `does not outrank current tier ${curTier} value` }), policy), supersedes: [] }); disputed.add(key); }
        }
      }
    }
  }
  return { decisions, disputedKeys: [...disputed], establishedAffiliations: established };
}

function rowToNew(r: FactRow): NewFact {
  const def = getFactDefinition(r.factKey);
  return { factKey: r.factKey, value: r.value, valueText: r.valueText, status: r.status, origin: r.origin, sourceClass: r.sourceClass, authorityTier: r.authorityTier, confidence: r.confidence, observedAt: r.observedAt, retrievedAt: r.retrievedAt, validFrom: r.validFrom, validTo: r.validTo, provenance: r.provenance, freshnessFamily: def.freshnessFamily, resolverVersion: RESOLVER_VERSION, registryVersion: FACT_REGISTRY_VERSION };
}
