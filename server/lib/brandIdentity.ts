/**
 * brandIdentity.ts — is a brand's external research about the RIGHT company? (BRAND_IDENTITY_GATE)
 *
 * Research used to be written as soon as it came back, so a name-only search could store a different
 * company's profile: Stan Eats became a Seattle food startup, NextGen Prospects became recruiting software
 * with an Under Armour cover, StartX1 (startx1.com) became the StartX accelerator. Every athlete-facing
 * reader — deck, letter, Mila, Studio, the Brain — then showed it.
 *
 * The rule here is a CORRECTNESS GATE, not a judgement: research is `confirmed` only when at least one
 * grounding source is hosted on a domain we hold as evidence for the brand (the sender's own domain, or
 * the advertiser's domain literally present in her mail). Never a domain guessed from the name. The
 * own-domain test is Slice 2's attribution rule (feat/slice2-startx1, counterpartyResearch.ts), lifted.
 *
 * `unconfirmed` is about the RESEARCH, never about the opportunity: a legitimate agency email for a real
 * brand is unconfirmed whenever the email never shows the brand's domain. It must not feed qualification,
 * Verify first, or any judgement of the sender — nothing in this module is read by those.
 */
import { brandDomainOf } from "./senderProfile";
import { googleFaviconUrl, isDeadLogoUrl } from "./brandLogoSources";
import { readLogoCheck } from "./brandLogoCheck";

export function brandIdentityGateEnabled(): boolean {
  return process.env.BRAND_IDENTITY_GATE === "true";
}

export type IdentityStatus = "confirmed" | "unconfirmed";

/** Stored at inbox_brands.enrichment.identity. */
export interface BrandIdentity {
  status: IdentityStatus;
  /** The evidence domain the research was checked against (null = none held). */
  domain: string | null;
  /** Grounding-source hosts on that domain — empty when unconfirmed. */
  own_sources: string[];
  basis: "own_domain_source" | "no_own_domain_source" | "no_domain_evidence";
  checked_at: string;
}

/** A grounding chunk's host. Vertex returns redirect URIs, so the title (usually the site's domain) wins. */
export function hostOf(title: string | null | undefined, uri: string | null | undefined): string | null {
  const t = (title ?? "").toLowerCase().trim().replace(/^www\./, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return t;
  try {
    const h = new URL(uri ?? "").hostname.toLowerCase().replace(/^www\./, "");
    return h.includes("vertexaisearch") ? null : h;
  } catch {
    return null;
  }
}

/** The host is the domain or one of its subdomains. Look-alikes (startx.com vs startx1.com) never match. */
export function onDomain(host: string | null | undefined, domain: string): boolean {
  if (!host || !domain) return false;
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** PURE. The verdict for one research run. */
export function decideIdentity(domain: string | null | undefined, sourceHosts: Array<string | null>, now: Date = new Date()): BrandIdentity {
  const d = brandDomainOf(domain ?? null);
  const checked_at = now.toISOString();
  if (!d) return { status: "unconfirmed", domain: null, own_sources: [], basis: "no_domain_evidence", checked_at };
  const own = [...new Set(sourceHosts.filter((h): h is string => onDomain(h, d)))];
  return own.length
    ? { status: "confirmed", domain: d, own_sources: own, basis: "own_domain_source", checked_at }
    : { status: "unconfirmed", domain: d, own_sources: [], basis: "no_own_domain_source", checked_at };
}

/** The identity record a row carries, if any. */
export function readIdentity(enrichment: unknown): BrandIdentity | null {
  const id = (enrichment as { identity?: Partial<BrandIdentity> } | null)?.identity;
  if (!id || (id.status !== "confirmed" && id.status !== "unconfirmed")) return null;
  return id as BrandIdentity;
}

/**
 * Is this row's research CONFIRMED to describe the right company? The one predicate every athlete-facing reader
 * uses (the board, the detail deck, and every "why she fits" surface): only an own-domain verdict counts. A row
 * never checked, or checked and unconfirmed, is not confirmed, whatever the env flag says.
 */
export function researchConfirmed(enrichment: unknown): boolean {
  return readIdentity(enrichment)?.status === "confirmed";
}

/**
 * Must this row be re-checked? (gate on) — it was never checked, or the domain we hold changed since
 * (an agency email later showed the advertiser's site, so the old "no evidence" verdict is out of date).
 */
export function identityNeedsCheck(row: { enriched_at: Date | string | null; domain: string | null; enrichment: unknown }): boolean {
  if (!row.enriched_at) return false; // never researched: the normal freshness rule already handles it
  const id = readIdentity(row.enrichment);
  if (!id) return true;
  return (id.domain ?? null) !== (brandDomainOf(row.domain) ?? null);
}

/**
 * The advertiser's own domain from the classifier, kept ONLY if it literally occurs in the message and
 * is a real brand domain (not free-mail, an e-sign/payment provider or an ESP — brandDomainOf) and not the
 * sending agency's own domain. Anything else is null: the model may never supply a domain from memory.
 */
export function literalAdvertiserDomain(
  proposed: string | null | undefined,
  messageText: string,
  senderDomain: string | null | undefined,
): string | null {
  const raw = (proposed ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0];
  if (!raw || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return null;
  const d = brandDomainOf(raw);
  if (!d) return null;
  const text = messageText.toLowerCase();
  // Literal presence as a domain token: a link host, an address (@d), or the bare domain — bounded so
  // "x1.com" doesn't match inside "startx1.com".
  const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${esc}(?![a-z0-9-])`, "i").test(text)) return null;
  const sender = brandDomainOf(senderDomain ?? null);
  if (sender && sender === d) return null; // the sender's own domain is already brand_domain
  return d;
}

/**
 * A brand domain from loose input (a URL, "www.x.com/path", an address's host) — the registrable brand domain, or null
 * for anything that is not one (free-mail, e-sign, ESPs, garbage). The one parser the imagery pipeline uses.
 */
export function brandDomainFromInput(raw: string | null | undefined): string | null {
  const host = String(raw ?? "").toLowerCase().trim().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]*@/, "").split(/[/?#\s:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return brandDomainOf(host);
}

// ─── Brand imagery pipeline (Oct 2026): what a row carries besides research ─────────────────────────────
//
// inbox_brands.enrichment holds the research profile, which every research write replaces. Four keys are NOT
// research and survive those writes (carriedEnrichment):
//   athlete_confirmed  an athlete's "Confirm this is [brand]" tap: the domain she confirmed and her assertion's id
//   own_site           imagery fetched from the brand's own domain (source: own_site) and the basis it was fetched on
//   candidate          the domain a name search proposed for her to confirm (never evidence by itself)
//   candidate_lookup   when that search last ran, so a read does not repeat it

/** Imagery taken from the brand's own site. `basis` is why the domain was trusted when it was fetched. */
export interface OwnSiteImagery {
  source: "own_site";
  domain: string;
  cover: string | null;
  logo_url: string | null;
  basis: "identity_confirmed" | "athlete_confirmed" | "system_confirmed";
  fetched_at: string;
}

export interface AthleteConfirmed { domain: string; assertion_id: string; at: string }
export interface BrandCandidate {
  domain: string; name: string | null;
  /** "web_search_verified": one OpenAI web search, the site checked in code (lib/brandSiteSearch); "name_search": the earlier Gemini grounding search. */
  source: "name_search" | "web_search_verified"; proposed_at: string;
  confidence?: "high" | "medium" | null;
  /** What the check saw on the site (its homepage title or site name). */
  evidence?: string | null;
  /** That domain's logo (Yoku when verified, else its favicon): public identity, shown before she confirms. */
  logo_url?: string | null;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function readOwnSite(enrichment: unknown): OwnSiteImagery | null {
  const o = asObj(asObj(enrichment)?.own_site);
  return o && o.source === "own_site" && typeof o.domain === "string" ? (o as unknown as OwnSiteImagery) : null;
}

export function readAthleteConfirmed(enrichment: unknown): AthleteConfirmed | null {
  const o = asObj(asObj(enrichment)?.athlete_confirmed);
  return o && typeof o.domain === "string" && typeof o.at === "string" ? (o as unknown as AthleteConfirmed) : null;
}

export function readCandidate(enrichment: unknown): BrandCandidate | null {
  const o = asObj(asObj(enrichment)?.candidate);
  return o && typeof o.domain === "string" ? (o as unknown as BrandCandidate) : null;
}

/**
 * Who the brand is, settled by the SYSTEM because the evidence was strong (no tap needed): the verified official-site
 * search found the brand's own site under its own name, or the brand wrote from its own domain. Reversible: "Not this
 * brand" withdraws it. It only settles WHO the brand is (the card stops asking her); research, fit text and imagery stay
 * gated on researchConfirmed, which the refresh run on this domain decides.
 */
export interface SystemConfirmed {
  domain: string;
  basis: "verified_official_site" | "sender_domain";
  evidence: string | null;
  at: string;
}

export function readSystemConfirmed(enrichment: unknown): SystemConfirmed | null {
  const o = asObj(asObj(enrichment)?.system_confirmed);
  return o && typeof o.domain === "string" && typeof o.at === "string" ? (o as unknown as SystemConfirmed) : null;
}

/** Words a brand's own homepage title adds after its name ("INIU Official Store") that don't change who it is. */
const GENERIC_SITE_WORDS = new Set([
  "official", "store", "shop", "online", "home", "site", "website", "inc", "co", "company", "llc", "ltd", "us", "usa",
  "the", "brand", "homepage", "and", "&",
]);

const normName = (s: string): string =>
  s.toLowerCase().replace(/[\\/|'’`.,:;!?()[\]{}"-]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * PURE. True when a verified official-site candidate names the brand exactly: high confidence, the check saw the site's
 * own title, and that title is the brand's name, or the name followed only by generic words ("Official Store").
 * "Agentic Phone" for "Insight Labs" is not a match; neither is "Remedy" for "Remedy Organics".
 */
export function strongSiteMatch(brandName: string | null | undefined, candidate: BrandCandidate | null | undefined): boolean {
  if (!brandName || !candidate) return false;
  if (candidate.source !== "web_search_verified" || candidate.confidence !== "high") return false;
  const seen = typeof candidate.evidence === "string" ? candidate.evidence.replace(/^\s*(homepage|site name|title)\s*:\s*/i, "") : "";
  const name = normName(brandName);
  const title = normName(seen);
  if (!name || !title) return false;
  if (title === name) return true;
  if (!title.startsWith(`${name} `)) return false;
  return title.slice(name.length + 1).split(" ").every((w) => GENERIC_SITE_WORDS.has(w));
}

/**
 * Whether WHO the brand is has been settled — by research, by her tap, or by the system on strong evidence. The card's
 * "Confirm this is [brand]" shows only when this is false. Not a gate on research content (see researchConfirmed).
 */
export function identitySettled(enrichment: unknown): boolean {
  return researchConfirmed(enrichment) || !!readAthleteConfirmed(enrichment) || !!readSystemConfirmed(enrichment);
}

export function readCandidateLookupAt(enrichment: unknown): string | null {
  const o = asObj(asObj(enrichment)?.candidate_lookup);
  return o && typeof o.at === "string" ? o.at : null;
}

/**
 * PURE. The non-research keys a research write carries over, given the identity it is about to store.
 * own_site survives an UNCONFIRMED verdict only when an athlete confirmed that same domain: her word outranks a
 * search that found no own-domain source. Otherwise unconfirmed means no imagery, as before.
 */
export function carriedEnrichment(enrichment: unknown, identity: Pick<BrandIdentity, "status" | "domain"> | null): Record<string, unknown> {
  const e = asObj(enrichment) ?? {};
  const out: Record<string, unknown> = {};
  for (const k of ["athlete_confirmed", "system_confirmed", "candidate", "candidate_lookup"]) if (e[k] !== undefined) out[k] = e[k];
  const own = readOwnSite(e);
  if (own) {
    const her = readAthleteConfirmed(e);
    const keep = identity?.status === "confirmed"
      ? own.domain === identity.domain
      : own.basis === "athlete_confirmed" && !!her && her.domain === own.domain && (identity?.domain ?? own.domain) === own.domain;
    if (keep) out.own_site = own;
  }
  return out;
}

/** May imagery be taken from this row's domain? Research confirmed it, or an athlete did. */
export function ownSiteBasis(row: { domain: string | null; enrichment: unknown }): OwnSiteImagery["basis"] | null {
  const d = brandDomainOf(row.domain ?? null);
  if (!d) return null;
  const id = readIdentity(row.enrichment);
  if (id?.status === "confirmed" && id.domain === d) return "identity_confirmed";
  const her = readAthleteConfirmed(row.enrichment);
  if (her && her.domain === d) return "athlete_confirmed";
  // The system settled it on the brand's own site naming the brand (never on a mail domain alone: a site that does not
  // name the brand is not its imagery).
  const sys = readSystemConfirmed(row.enrichment);
  if (sys && sys.domain === d && sys.basis === "verified_official_site") return "system_confirmed";
  return null;
}

/** PURE. The own-site cover, only while the domain it came from is trusted (ownSiteBasis). */
export function trustedOwnCover(row: { domain: string | null; enrichment: unknown }): string | null {
  const own = readOwnSite(row.enrichment);
  return own?.cover && ownSiteBasis(row) && own.domain === brandDomainOf(row.domain ?? null) ? own.cover : null;
}

/**
 * PURE. Does this brand have identity work outstanding for the domain evidence it now holds? Decides whether an
 * ingest event asks for the brand_identity_refresh job, so a brand already checked and pictured costs nothing:
 *   - a domain the identity was never checked against (new evidence), or
 *   - a trusted domain (confirmed by research or by her) whose own-site imagery was never fetched.
 */
export function brandNeedsIdentityWork(row: { domain: string | null; enrichment: unknown; is_agency?: boolean | null }): boolean {
  if (row.is_agency) return false;
  const d = brandDomainOf(row.domain ?? null);
  if (!d) return false;
  const id = readIdentity(row.enrichment);
  if (!id || (id.domain ?? null) !== d) return true;
  if (ownSiteBasis(row) && readOwnSite(row.enrichment)?.domain !== d) return true;
  return false;
}

/**
 * PURE. Whether a domain-less brand should run the name search for a candidate now: not an agency, no domain, and no
 * search within the cap window. Ingest asks this so a new email's brand gets its logo without waiting for a tap.
 */
export function brandNeedsCandidateLookup(
  row: { domain: string | null; enrichment: unknown; is_agency?: boolean | null }, now: Date, capDays: number,
): boolean {
  if (row.is_agency || brandDomainOf(row.domain ?? null)) return false;
  const at = Date.parse(readCandidateLookupAt(row.enrichment) ?? "") || 0;
  return now.getTime() - at >= capDays * 24 * 60 * 60 * 1000;
}

/**
 * PURE. The logo safe to show for a brand before its research is confirmed. A logo is public identity, not a claim:
 * the row's own domain (its stored logo, else that domain's favicon), else the name search's candidate domain (its
 * logo, else its favicon). Nothing when neither exists: the client draws an initial.
 */
export function brandDisplayLogo(row: { domain: string | null; logo_url: string | null; enrichment: unknown }): string | null {
  const d = brandDomainOf(row.domain ?? null);
  if (d) {
    if (readLogoCheck(row.enrichment, d)?.result === "none") return null;   // checked: nothing good enough — the initial
    return row.logo_url && !isDeadLogoUrl(row.logo_url) ? row.logo_url : googleFaviconUrl(d);
  }
  const c = readCandidate(row.enrichment);
  const cd = c ? brandDomainOf(c.domain) : null;
  if (!cd || readLogoCheck(row.enrichment, cd)?.result === "none") return null;
  return c!.logo_url && !isDeadLogoUrl(c!.logo_url) ? c!.logo_url : googleFaviconUrl(cd);
}

/** PURE. The colour of the logo the brand shows (its checked logo's own colour), or null: the card draws on ink. */
export function brandDisplayColor(row: { domain: string | null; enrichment: unknown }): string | null {
  const d = brandDomainOf(row.domain ?? null) ?? brandDomainOf(readCandidate(row.enrichment)?.domain ?? null);
  const c = readLogoCheck(row.enrichment, d);
  return c?.result === "ok" && typeof c.color === "string" && /^#[0-9A-F]{6}$/i.test(c.color) ? c.color : null;
}

/** PURE. True when a logo check found nothing good enough for the domain the brand would show: draw the initial. */
export function brandLogoNone(row: { domain: string | null; enrichment: unknown }): boolean {
  const d = brandDomainOf(row.domain ?? null) ?? brandDomainOf(readCandidate(row.enrichment)?.domain ?? null);
  return readLogoCheck(row.enrichment, d)?.result === "none";
}
