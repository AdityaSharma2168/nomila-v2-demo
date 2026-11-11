/**
 * marketabilityCitationLineage.ts — was a source M.I.A. cited actually retrieved?
 *
 * The evaluator runs under Google Search grounding and writes its own `evidence[]` list: an id, a claim and a URL per
 * source. Those URLs are the MODEL's words. The provider separately reports what it retrieved (grounding chunks, each
 * a redirect URI plus the source's domain and title) and which answer spans those chunks support. The run stores that
 * metadata; until now nothing read it, so a URL the model wrote from memory (Mia's run cited Wikipedia and
 * girlssoccernetwork with no chunk from either domain) reached every reader looking exactly like a retrieved one.
 *
 * This module classifies each citation against the stored grounding and the evidence snapshot, at ledger-mapping
 * time, reusing the research path's deterministic binder (research/spec/directLineage.ts) rather than a parallel one:
 *   1. nomila_supplied  — Nomila supplied an authoritative social block, and the citation restates it: it names a
 *                         supplied account's handle, or repeats a metric value that appears verbatim in the block.
 *                         Checked against what Nomila actually sent, never the evaluator's `source_type: "platform"`.
 *   2. unsupported      — no web URL, and not Nomila's block (e.g. a pseudo-URL the model invented).
 *   3. native_supported — `bindGeminiFinding` binds the claim to a grounding support whose chunks include the cited
 *                         URL's domain. (In practice the supports annotate the prose, not the JSON evidence list, so
 *                         this is rare; it is here so the vocabulary means the same thing on both paths.)
 *   4. native_retrieved — the cited URL's host is (a subdomain of) a retrieved chunk's domain. `match: "domain"`:
 *                         chunk URIs are redirects, so the exact page can never be confirmed from stored data.
 *   5. asserted_only    — a web URL no retrieved chunk corroborates, even by domain. Not support.
 * No fuzzy, semantic or LLM matching. Pure: no provider call, no database.
 *
 * It also validates the ids findings cite: an id that is not in the evidence list is moved to `danglingEvidence`,
 * never silently kept as support.
 */
import {
  bindGeminiFinding, hostOf,
  type GroundingChunkLike, type GroundingSupportLike,
} from "./intelligence/research/spec/directLineage";
import type {
  LedgerCitationLineage, LedgerEvidenceCitation, LedgerFinding,
} from "./intelligence/contracts/intelligenceLedger";
import type { SourceClass } from "./intelligence/types";
import { allowedFromSources, isFactsOnlyBlock } from "./miaPreview/factsOnlySpec";

/** What the classifier reads: the run's stored response + grounding, and what Nomila put in the snapshot. */
export interface CitationGroundingContext {
  /** The evaluator's full response text — the prose the grounding supports' index ranges point into. */
  text: string;
  /** `raw.native` as the evaluator stored it. */
  native: { groundingChunks?: GroundingChunkLike[]; groundingSupports?: GroundingSupportLike[] } | null | undefined;
  /** The AUTHORITATIVE SOCIAL DATA block Nomila sent, verbatim, or null when none was sent. */
  socialBlock: string | null;
  /** The accounts that block was built from. */
  socialSources: Array<{ platform: string; accountId: string }>;
  /**
   * Facts-only snapshots (facts-eval-spec) only: the memory-fact ids Nomila supplied and the platforms of its
   * authoritative block. A citation whose id is one of them restates what Nomila supplied. Absent for every other
   * snapshot, so the frozen path classifies exactly as before.
   */
  suppliedFacts?: ReadonlySet<string>;
  suppliedPlatforms?: ReadonlySet<string>;
}

/** The grounding context of a stored run, or null when the run did not store grounding metadata at all. */
export function groundingContextFor(
  raw: unknown,
  snapshot: { social_block?: string | null; social_sources?: unknown },
): CitationGroundingContext | null {
  const r = raw as any;
  if (!r || typeof r !== "object" || !r.native || typeof r.native !== "object") return null;
  const sources = Array.isArray(snapshot.social_sources) ? snapshot.social_sources : [];
  const facts = isFactsOnlyBlock(snapshot.social_block) ? allowedFromSources(sources) : null;
  return {
    text: typeof r.text === "string" ? r.text : "",
    native: r.native,
    socialBlock: typeof snapshot.social_block === "string" && snapshot.social_block.trim() ? snapshot.social_block : null,
    socialSources: sources
      .filter((s: any) => s && typeof s.platform === "string")
      .map((s: any) => ({ platform: String(s.platform), accountId: String(s.accountId ?? "") })),
    ...(facts ? { suppliedFacts: facts.factIds, suppliedPlatforms: facts.platforms } : {}),
  };
}

const REDIRECT_HOST = /(^|\.)vertexaisearch\.cloud\.google\.com$/;
const isHostLike = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
const bareHost = (h: string) => h.trim().toLowerCase().replace(/^www\./, "");

/**
 * A chunk's source domain. Gemini gives `web.domain` (and usually a domain-shaped `web.title`); the URI is a
 * vertexaisearch redirect and says nothing about the source, so it is used only when it is not one.
 */
function chunkDomain(c: GroundingChunkLike): string | null {
  const d = c.web?.domain;
  if (d && isHostLike(d.trim())) return bareHost(d);
  const t = c.web?.title;
  if (t && isHostLike(t.trim())) return bareHost(t);
  const h = hostOf(c.web?.uri ?? "");
  return h && !REDIRECT_HOST.test(h) ? bareHost(h) : null;
}

/** The cited host is the retrieved domain or a subdomain of it (en.wikipedia.org ⊂ wikipedia.org). Never the reverse. */
const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function webHost(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url.trim())) return null;
  const h = hostOf(url.trim());
  return h && isHostLike(h) ? bareHost(h) : null;
}

const PLATFORM_HOSTS: Record<string, string[]> = {
  instagram: ["instagram.com"], tiktok: ["tiktok.com"], youtube: ["youtube.com", "youtu.be"], x: ["x.com", "twitter.com"],
};

/**
 * Metric-shaped tokens: a number with a thousands separator, a decimal or a percent sign, or at least three digits —
 * and never a bare year, which the block carries as observation dates and a web claim would carry for other reasons.
 */
function metricTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? [])
    .map((t) => t.replace(/,$/, ""))
    .filter((t) => /[,.%]/.test(t) || t.replace(/\D/g, "").length >= 3)
    .filter((t) => !/^(19|20)\d\d$/.test(t));
}

/** Does this citation restate what Nomila supplied? Judged against the snapshot, never the model's own label. */
function restatesSnapshot(e: LedgerEvidenceCitation, ctx: CitationGroundingContext): string | null {
  const block = ctx.socialBlock;
  if (!block || !ctx.socialSources.length) return null;
  const host = webHost(e.sourceUrl);
  const handles = ctx.socialSources.map((s) => ({ platform: s.platform.toLowerCase(), handle: s.accountId.replace(/^@+/, "").toLowerCase() })).filter((s) => s.handle);
  // A web URL only counts as Nomila's when it is a supplied account's own profile page.
  if (host) {
    const path = (() => { try { return new URL(e.sourceUrl!.trim()).pathname.toLowerCase(); } catch { return ""; } })();
    const own = handles.find((h) => (PLATFORM_HOSTS[h.platform] ?? []).some((p) => hostMatches(host, p)) && path.includes(h.handle));
    return own ? `the supplied ${own.platform} account's own page` : null;
  }
  const text = `${e.claim ?? ""} ${e.sourceTitle ?? ""} ${e.sourceUrl ?? ""}`;
  const lower = text.toLowerCase();
  const handle = handles.find((h) => lower.includes(`@${h.handle}`));
  if (handle) return `names the supplied ${handle.platform} account @${handle.handle}`;
  const repeated = metricTokens(text).filter((t) => block.includes(t));
  return repeated.length ? `repeats supplied metric values (${[...new Set(repeated)].slice(0, 4).join(", ")})` : null;
}

/** Classify one citation. See the module header for the order and what each level means. */
export function classifyCitation(e: LedgerEvidenceCitation, ctx: CitationGroundingContext): LedgerCitationLineage {
  // Facts-only runs cite Nomila's own fact ids (and platform:<p> for its authoritative block): supplied, by id.
  if (ctx.suppliedFacts?.has(e.id)) return { level: "nomila_supplied", match: "snapshot", detail: `cites memory fact ${e.id}, supplied by Nomila` };
  const platform = /^platform:(.+)$/.exec(e.id)?.[1];
  if (platform && ctx.suppliedPlatforms?.has(platform)) return { level: "nomila_supplied", match: "snapshot", detail: `cites the supplied ${platform} account` };
  const snap = restatesSnapshot(e, ctx);
  if (snap) return { level: "nomila_supplied", match: "snapshot", detail: snap };

  const host = webHost(e.sourceUrl);
  if (!host) return { level: "unsupported", match: "none", detail: e.sourceUrl ? `not a web URL and not Nomila-supplied: ${e.sourceUrl}` : "no source URL" };

  const chunks = Array.isArray(ctx.native?.groundingChunks) ? ctx.native!.groundingChunks! : [];
  const supports = Array.isArray(ctx.native?.groundingSupports) ? ctx.native!.groundingSupports! : [];
  const domainOf = chunks.map(chunkDomain);
  const matched = [...new Set(domainOf.filter((d): d is string => !!d && hostMatches(host, d)))];

  // The research path's binder, unchanged: the claim text must occur exactly once in the response and sit inside a
  // grounding support's index range. Counted as grounded only when a chunk it binds to is the cited source's domain.
  const bound = bindGeminiFinding({ quote: e.claim, statement: null }, ctx.text, supports, chunks, "mia");
  if (bound.level === "native_supported") {
    const boundDomains = bound.boundChunkIds.map((id) => domainOf[Number(id.split(":c").pop())]).filter((d): d is string => !!d);
    const hit = [...new Set(boundDomains.filter((d) => hostMatches(host, d)))];
    if (hit.length) return { level: "native_supported", match: "index_support", retrievedDomains: hit, detail: bound.detail };
  }

  if (matched.length) {
    return {
      level: "native_retrieved", match: "domain", retrievedDomains: matched,
      detail: "a chunk from this domain was retrieved; the exact page cannot be confirmed (chunk URIs are redirects) and no grounding support binds this claim",
    };
  }
  return {
    level: "asserted_only", match: "none",
    detail: chunks.length ? `no retrieved chunk is from ${host}` : "the run retrieved no grounding chunks",
  };
}

/**
 * The source class of one scored judgement, from the lineage of what it cites (buildBeta1Dimensions' `sourceOf`):
 *   every cited id restates the block Nomila supplied (nomila_supplied) → that block's class: connected_verified when
 *                                                                          every supplied account is connected, else
 *                                                                          platform_public
 *   no cited id                                                         → inferred
 *   anything else, unclassified evidence included                       → web_researched (the frozen default)
 * `evidence` is the run's citations AFTER groundCitations; `suppliedClasses` the snapshot's social source classes.
 */
export function judgementSourceOf(
  evidence: LedgerEvidenceCitation[],
  suppliedClasses: string[],
  /** Facts-only runs: Nomila's researched memory facts. Citing one is web research (Nomila's), never platform data. */
  researchedFactIds?: ReadonlySet<string>,
): (j: { evidenceIds: string[] }) => SourceClass {
  const level = new Map(evidence.map((e) => [e.id, e.lineage?.level ?? null]));
  const supplied: SourceClass = suppliedClasses.length && suppliedClasses.every((c) => c === "connected_verified") ? "connected_verified" : "platform_public";
  return (j) => {
    const ids = j.evidenceIds ?? [];
    if (!ids.length) return "inferred";
    if (researchedFactIds && ids.some((id) => researchedFactIds.has(id))) return "web_researched";
    return ids.every((id) => level.get(id) === "nomila_supplied") ? supplied : "web_researched";
  };
}

/**
 * Validate the ids findings cite and, where the run's grounding is available, classify every citation.
 *
 * Dangling ids — cited but absent from `evidence` — move from `citedEvidence` to `danglingEvidence` on the component
 * and the finding. That happens with or without grounding: an id that resolves to nothing is never support.
 * With no grounding context the citations are left unclassified (unknown), never guessed.
 */
export function groundCitations(
  findings: LedgerFinding[],
  evidence: LedgerEvidenceCitation[],
  ctx: CitationGroundingContext | null,
): { findings: LedgerFinding[]; evidence: LedgerEvidenceCitation[] } {
  const known = new Set(evidence.map((e) => e.id));
  const split = (ids: string[] | undefined) => {
    const all = ids ?? [];
    return { cited: all.filter((id) => known.has(id)), dangling: [...new Set(all.filter((id) => !known.has(id)))].sort() };
  };

  const outFindings = findings.map((f) => {
    const components = f.components?.map((c) => {
      const { cited, dangling } = split(c.citedEvidence);
      return { ...c, citedEvidence: cited, ...(dangling.length ? { danglingEvidence: dangling } : {}) };
    });
    const own = split(f.citedEvidence);
    const dangling = [...new Set([...own.dangling, ...(components ?? []).flatMap((c) => c.danglingEvidence ?? [])])].sort();
    return {
      ...f,
      citedEvidence: own.cited,
      ...(dangling.length ? { danglingEvidence: dangling } : {}),
      ...(components ? { components } : {}),
    };
  });

  return {
    findings: outFindings,
    evidence: ctx ? evidence.map((e) => ({ ...e, lineage: classifyCitation(e, ctx) })) : evidence,
  };
}
