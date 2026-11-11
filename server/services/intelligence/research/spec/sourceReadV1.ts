/**
 * research/spec/sourceReadV1.ts — `source-read/1`: research v3's capped TARGETED SOURCE READ (identity sources, PR A). Pure.
 *
 * Discovery (Q3, research-spec/1.1) lists `athlete_media`: interviews, features, profiles, podcasts, press conferences in which
 * the athlete is the subject or takes part. The read step picks the best few of THIS run's athlete_media sources
 * deterministically and has the model read each one directly — a web page through URL context, a public YouTube video through
 * native video input — and extract everything useful and attributable from that one source in one pass.
 *
 *   urls        a candidate URL is ONLY one search grounding retrieved during this run's discovery queries (a grounding chunk).
 *               A model athlete_media item is a hint: matched to a chunk (exact URL, or same registrable domain + title overlap,
 *               or strong title overlap — a chunk's "title" being its resolved URL's slug or a video's oEmbed title, since live
 *               grounding titles are only domains) it lends the chunk its participation / medium / outlet; unmatched it is `ungrounded`
 *               and never read. A model-written URL is never read and never becomes provenance. Retrieved pages about the
 *               athlete the model did not list also enter (ranked as mentions).
 *   selection   participation (interview / own words > profile > mention), then a source the search answer showed quoting the
 *               athlete, then outlet authority (SOURCE_TYPE_TIER), identity relevance (grounding lineage), recency; unreadable
 *               URLs (search redirects, audio-only podcast hosts) and sources already read for THIS spec version are skipped;
 *               the read step walks this order until RESEARCH_TARGETED_READ_MAX reads succeed or
 *               RESEARCH_TARGETED_READ_MAX_ATTEMPTS calls are spent.
 *   provenance  every item extracted is lineage `source_read` with source_url = the URL read. The athlete's own verbatim words
 *               become `athlete_statement`; a paraphrase, reported speech, or someone else's words NEVER does — those become
 *               `narrative_claim`. A quote seen only through search grounding is never a statement (it only raises priority).
 *   reuse       a source is read once per (normalized URL, SOURCE_READ_VERSION): a new version may read it again.
 *
 * No provider, no database. The provider call lives in server/lib/research/providers/geminiSourceRead.ts (injected).
 */

import { resolveSourceType } from "../policy";
import { SOURCE_TYPE_TIER, type SourceType } from "../registries";
import { normalizeUrl, hostOf } from "./directLineage";
import type { DirectClaimLineage, DirectSource } from "./directEvidenceV1";
import { ITEM_SHAPES, OUTLET_TYPE_SHAPE, type Finding } from "./directEvidenceV2";
import { mapFinding, type MappedClaim } from "./itemMapping";
import { FORBIDDEN_IN_REQUESTS, SECTIONS, type SectionId } from "./researchSpecV1";

/** The READ spec version: the reuse key's second half. Bump it when the extraction asks for something new (a re-read is then allowed). */
export const SOURCE_READ_VERSION = "source-read/1";
/** research_runs.query_id of the read step's row (0082). */
export const READ_QUERY_ID = "READ" as const;
export type ReadMode = "youtube" | "page";

export const STATEMENT_TOPICS = ["origin", "motivation", "values", "leadership", "ambition", "interests", "style", "community", "other"] as const;
export type StatementTopic = (typeof STATEMENT_TOPICS)[number];

// ── readable URLs ─────────────────────────────────────────────────────────────

/** A Google Search grounding redirect (discovery repeats it as the source URL; the read step resolves it before selection). */
export function isGroundingRedirectUrl(url: string): boolean {
  try { const u = new URL(url.trim()); return u.hostname.toLowerCase() === "vertexaisearch.cloud.google.com" && u.pathname.startsWith("/grounding-api-redirect/"); } catch { return false; }
}

/** Search-result redirects are not the source: never read one (the stored source_url must be the real URL). */
const REDIRECT_HOSTS = ["vertexaisearch.cloud.google.com", "google.com", "news.google.com", "bing.com", "t.co", "lnkd.in", "bit.ly"];
/** Audio-only podcast hosts: without a transcript or video version the appearance stays an appearance (no audio pipeline). */
const AUDIO_HOSTS = ["podcasts.apple.com", "open.spotify.com", "spotify.com", "soundcloud.com", "anchor.fm", "podbean.com", "buzzsprout.com", "megaphone.fm", "simplecast.com", "libsyn.com", "iheart.com", "audioboom.com", "pca.st", "pocketcasts.com", "overcast.fm", "castbox.fm", "podcasts.google.com", "music.amazon.com"];
const AUDIO_FILE = /\.(mp3|m4a|wav|aac|ogg|opus)(\?|$)/i;
const hostIs = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** The canonical watch URL of a public YouTube video (watch, shorts, live, youtu.be, embed), else null. */
export function youtubeVideoUrl(u: string): string | null {
  let x: URL;
  try { x = new URL(u.trim()); } catch { return null; }
  const host = x.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = x.pathname.split("/")[1] || null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (x.pathname === "/watch") id = x.searchParams.get("v");
    else { const m = /^\/(shorts|live|embed|v)\/([^/?#]+)/.exec(x.pathname); id = m ? m[2] : null; }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** How a source can be read, or null when it cannot (redirect, non-http, audio-only podcast without a transcript page). */
export function readModeOf(url: string, medium: string | null | undefined): ReadMode | null {
  if (!/^https?:\/\//i.test(url.trim())) return null;
  if (youtubeVideoUrl(url)) return "youtube";
  const host = (hostOf(url) ?? "").toLowerCase();
  if (!host || hostIs(host, REDIRECT_HOSTS) || hostIs(host, ["youtube.com", "youtu.be"])) return null;   // a channel/search page is not a video
  if (hostIs(host, AUDIO_HOSTS) || AUDIO_FILE.test(url)) return null;
  if (medium === "podcast" && !/transcript/i.test(url)) return null;   // a podcast is read only as a video or a transcript page
  return "page";
}

/** The reuse key's URL half: the canonical YouTube watch URL, else the conservative normalized URL. */
export function readKeyUrl(url: string): string { return youtubeVideoUrl(url) ?? normalizeUrl(url); }

// ── selection ─────────────────────────────────────────────────────────────────

/**
 * One source the read step may read. `url` is ALWAYS a URL search grounding actually retrieved during this workflow run's
 * discovery queries (a grounding chunk's link — usually a grounding redirect, resolved to the real page just before the read);
 * never a URL the discovery model wrote. A model athlete_media item only describes a source: when it matches a grounding chunk
 * (groundedCandidates) the candidate carries its participation / medium / outlet; a retrieved page about the athlete that the
 * model did not list enters with participation unknown (ranked as a mention).
 */
export interface ReadCandidate {
  /** The athlete_media evidence row this source was matched from; null for a retrieved page the model did not list. */
  evidenceId: string | null;
  url: string;
  title: string | null;
  outlet: string | null;
  /** The model's outlet type for the media item (claim.outletType). */
  outletType: string | null;
  /** The stored row's source_type. */
  sourceType: string | null;
  medium: string | null;
  participation: string | null;
  /** The search answer showed a quote of the athlete from this source (never stored as a statement). */
  athleteQuoted: boolean;
  date: string | null;
  /** The discovery row's lineage (identity relevance: bound to a grounded source > retrieved > asserted). */
  lineage: string;
  /** The search-grounding redirect link discovery retrieved, when `url` is the real URL it was resolved to (lineage only). */
  discoveredUrl?: string;
  /** item = matched from a model athlete_media item; grounding = a retrieved page about the athlete the model did not list. */
  origin?: "item" | "grounding";
  /** The grounding chunk's domain (ranking before its redirect is resolved). */
  domain?: string | null;
}
export interface ReadTarget extends ReadCandidate { readUrl: string; key: string; mode: ReadMode; sourceTypeResolved: SourceType; rank: number[] }
/** Skip counts. ungrounded: a model item no grounding chunk matches (never read); video_unavailable: YouTube oEmbed said no (no call). */
export interface ReadSkipped { unreadable: number; alreadyRead: number; duplicate: number; overCap: number; ungrounded?: number; video_unavailable?: number }
export interface ReadSelection { targets: ReadTarget[]; skipped: ReadSkipped }

const PARTICIPATION_RANK: Record<string, number> = { interview: 0, own_words: 0, profile: 1, mention: 2 };
const LINEAGE_RANK: Record<string, number> = { native_supported: 0, cited: 0, native_retrieved: 1, asserted_only: 2 };
const dateMs = (d: string | null) => { const t = d ? Date.parse(d.length === 4 ? `${d}-01-01` : d) : NaN; return Number.isFinite(t) ? t : -Infinity; };

/** The deterministic rank tuple (lower sorts first). A retrieved page the model did not list ranks as a mention. */
export function readRank(c: ReadCandidate, sourceType: SourceType): number[] {
  const participation = c.participation ?? (c.origin === "grounding" ? "mention" : "");
  return [PARTICIPATION_RANK[participation] ?? 3, c.athleteQuoted ? 0 : 1, SOURCE_TYPE_TIER[sourceType] ?? 8, LINEAGE_RANK[c.lineage] ?? 3, -dateMs(c.date)];
}
const cmpRank = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const cmp = (a: ReadTarget, b: ReadTarget) => cmpRank(a.rank, b.rank) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** One candidate whose `url` is a real URL → its read target, or null when it cannot be read. Outlet authority: resolveSourceType on the real URL. */
export function toReadTarget(c: ReadCandidate, knownHandles?: ReadonlyArray<string | null | undefined>): ReadTarget | null {
  const mode = c.url ? readModeOf(c.url, c.medium) : null;
  if (!mode) return null;
  const readUrl = mode === "youtube" ? youtubeVideoUrl(c.url)! : c.url.trim();
  const st = resolveSourceType(c.outletType, hostOf(readUrl), undefined, { urls: [c.url, readUrl], names: [c.outlet], knownHandles });
  return { ...c, readUrl, key: readKeyUrl(readUrl), mode, sourceTypeResolved: st, rank: readRank(c, st) };
}

/**
 * Pick at most `max` sources to read: readable, not already read for SOURCE_READ_VERSION (`alreadyRead` holds readKeyUrl keys),
 * one per URL (the best-ranked mention of it), ranked by participation, quoted-in-search, outlet authority, identity
 * relevance, recency, then the URL. `max` 0 selects nothing.
 */
export function selectReadTargets(candidates: ReadCandidate[], opts: { max: number; alreadyRead: ReadonlySet<string>; /** Handles Nomila holds for the athlete (platform-host ownership; resolveSourceType). */ knownHandles?: ReadonlyArray<string | null | undefined> }): ReadSelection {
  const skipped = { unreadable: 0, alreadyRead: 0, duplicate: 0, overCap: 0 };
  const best = new Map<string, ReadTarget>();
  for (const c of candidates) {
    const t = toReadTarget(c, opts.knownHandles);
    if (!t) { skipped.unreadable++; continue; }
    if (opts.alreadyRead.has(t.key)) { skipped.alreadyRead++; continue; }
    const prev = best.get(t.key);
    if (prev) { skipped.duplicate++; if (cmp(t, prev) < 0) best.set(t.key, t); } else best.set(t.key, t);
  }
  const ranked = [...best.values()].sort(cmp);
  const max = Math.max(0, Math.floor(opts.max));
  skipped.overCap = Math.max(0, ranked.length - max);
  return { targets: ranked.slice(0, max), skipped };
}

// ── grounded candidates: model items are hints; URLs come only from what grounding retrieved ──

/**
 * One grounding chunk retrieved by this run's discovery queries (research_source_payloads.payload.chunks: link, web.domain,
 * web.title). For matching, `title` is the chunk's match text (chunkMatchText): live web.title is only the domain.
 */
export interface GroundedChunk { chunkId: string; url: string; domain: string | null; title: string | null }
/** A model athlete_media item: a hint describing a source. `claimedUrl` is the URL the model wrote — untrusted, never read. */
export interface MediaHint extends Omit<ReadCandidate, "url" | "discoveredUrl" | "origin" | "domain" | "evidenceId"> { evidenceId: string; claimedUrl: string | null }
/** Matching thresholds (config GROUNDED_READ_MATCH), over normalised title tokens. */
export interface GroundedMatchThresholds { domainTitleJaccard: number; domainTitleContainment: number; strongTitleJaccard: number; strongTitleContainment: number; minContainmentTokens: number }

const TITLE_STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "is", "are", "was", "be", "as", "it", "its", "this", "that", "www", "com", "youtube"]);
const fold = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Normalised title tokens: lower case, accents folded, alphanumeric runs of ≥ 2 characters, a few function words dropped. */
export function titleTokens(s: string | null | undefined): Set<string> {
  return new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !TITLE_STOPWORDS.has(w)));
}
/** Token Jaccard, and containment = shared / the smaller set (0 when the smaller set has fewer than `minTokens` tokens). */
export function titleOverlap(a: string | null | undefined, b: string | null | undefined, minTokens = 3): { jaccard: number; containment: number } {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return { jaccard: 0, containment: 0 };
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  const small = Math.min(A.size, B.size);
  return { jaccard: shared / (A.size + B.size - shared), containment: small >= minTokens ? shared / small : 0 };
}

const HOST_ALIASES: Record<string, string> = { "youtu.be": "youtube.com", "youtube-nocookie.com": "youtube.com" };
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "edu.au", "co.nz", "co.jp", "com.br", "co.za", "com.mx", "co.in", "com.sg"]);
/** The registrable domain of a host: its last two labels (three under a common two-part public suffix). Simple and deterministic. */
export function registrableDomain(host: string | null | undefined): string | null {
  const h = (host ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!h.includes(".")) return null;
  const labels = h.split(".");
  const rd = labels.slice(labels.length >= 3 && TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
  return HOST_ALIASES[rd] ?? rd;
}
const urlHost = (u: string | null | undefined): string | null => { try { return u ? new URL(u.trim()).hostname : null; } catch { return null; } };
const alnum = (s: string | null | undefined) => fold(s).replace(/[^a-z0-9]/g, "");

const SLUG_GENERIC = new Set(["stories", "story", "news", "article", "articles", "html", "htm", "php", "aspx", "asp", "index", "en", "us", "amp", "post", "posts", "blog", "blogs", "id", "page", "pages", "content", "default", "sports", "sport", "video", "videos", "watch", "media", "item", "items", "view", "detail", "details"]);
/** The words of a page's URL path (its slug): segments split on / - _ . and decoded; ids, numbers and generic path words dropped. */
export function slugText(url: string | null | undefined): string {
  let path = "";
  try { path = new URL((url ?? "").trim()).pathname; } catch { return ""; }
  let decoded = path; try { decoded = decodeURIComponent(path); } catch { /* keep raw */ }
  return decoded.split(/[\/\-_.\s+]+/).map((w) => fold(w).replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 2 && !/\d/.test(w) && !SLUG_GENERIC.has(w)).join(" ");
}
/** A grounding web.title that is just a domain (what live grounding returns) says nothing about the page. */
export function isDomainTitle(title: string | null | undefined, domain: string | null | undefined): boolean {
  const t = (title ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!t) return true;
  return t === (domain ?? "").trim().toLowerCase().replace(/^www\./, "") || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t);
}
/**
 * The text a grounding chunk is matched on, from grounding-derived data only: its web.title when that is a real title (not just
 * the domain), plus — for a YouTube watch URL — the video title YouTube's oEmbed returned, else the resolved URL's path slug.
 */
export function chunkMatchText(webTitle: string | null | undefined, domain: string | null | undefined, realUrl: string, videoTitle: string | null | undefined): string {
  const parts = [isDomainTitle(webTitle, domain) ? null : webTitle, youtubeVideoUrl(realUrl) ? videoTitle ?? null : slugText(realUrl)];
  return parts.filter((p): p is string => !!p && !!p.trim()).join(" ");
}

/** Same registrable domain: the chunk's domain vs the host of the URL the model wrote, or vs the outlet name (= its domain's first label). */
export function sameSourceDomain(chunkDomain: string | null | undefined, claimedUrl: string | null | undefined, outlet: string | null | undefined): boolean {
  const rd = registrableDomain(chunkDomain);
  if (!rd) return false;
  if (claimedUrl && !isGroundingRedirectUrl(claimedUrl) && registrableDomain(urlHost(claimedUrl)) === rd) return true;
  const label = domainLabel(chunkDomain), o = outletDomainLabel(outlet);
  return !!label && label.length >= 3 && o === label;
}
/** A domain's first registrable label, alphanumeric only ("example-network.com" → "examplenetwork"). */
export function domainLabel(domain: string | null | undefined): string | null { const rd = registrableDomain(domain); return rd ? alnum(rd.split(".")[0]) || null : null; }
/** An outlet name as a domain label ("Example Network" → "examplenetwork"), or null when shorter than 3 characters. */
export function outletDomainLabel(outlet: string | null | undefined): string | null { const o = alnum(outlet); return o.length >= 3 ? o : null; }

/** Exact match: the URL the model wrote equals (normalised) a grounding chunk's link or the real URL that link resolved to. */
function exactUrlMatch(claimedUrl: string | null, chunk: GroundedChunk, resolved: ReadonlyMap<string, string | null>): boolean {
  if (!claimedUrl || !/^https?:\/\//i.test(claimedUrl.trim())) return false;
  if (normalizeUrl(claimedUrl) === normalizeUrl(chunk.url)) return true;
  const real = resolved.get(chunk.url);
  return !!real && readKeyUrl(claimedUrl) === readKeyUrl(real);
}

/**
 * The grounding chunk a model item describes, or null. Deterministic: an exact URL match first; else a chunk with the same
 * registrable domain AND title overlap (Jaccard ≥ domainTitleJaccard or containment ≥ domainTitleContainment), or strong title
 * overlap alone (Jaccard ≥ strongTitleJaccard or containment ≥ strongTitleContainment). Best: domain match, then Jaccard, then
 * containment, then the chunk id.
 */
export function matchHintToChunk(hint: Pick<MediaHint, "claimedUrl" | "title" | "outlet">, chunks: readonly GroundedChunk[], resolved: ReadonlyMap<string, string | null>, th: GroundedMatchThresholds): GroundedChunk | null {
  const byId = (a: GroundedChunk, b: GroundedChunk) => (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);
  const exact = chunks.filter((c) => exactUrlMatch(hint.claimedUrl, c, resolved)).sort(byId);
  if (exact.length) return exact[0];
  let best: { c: GroundedChunk; key: number[] } | null = null;
  for (const c of chunks) {
    const { jaccard, containment } = titleOverlap(hint.title, c.title, th.minContainmentTokens);
    const dm = sameSourceDomain(c.domain, hint.claimedUrl, hint.outlet);
    const ok = (dm && (jaccard >= th.domainTitleJaccard || containment >= th.domainTitleContainment)) || jaccard >= th.strongTitleJaccard || containment >= th.strongTitleContainment;
    if (!ok) continue;
    const key = [dm ? 0 : 1, -jaccard, -containment];
    if (!best || cmpRank(key, best.key) < 0 || (cmpRank(key, best.key) === 0 && byId(c, best.c) < 0)) best = { c, key };
  }
  return best?.c ?? null;
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
/** The athlete's surname token (the last name token, generational suffixes dropped), or null when shorter than 3 characters. */
export function surnameToken(fullName: string | null | undefined): string | null {
  const t = [...titleTokens(fullName)].filter((w) => !NAME_SUFFIXES.has(w));
  const s = t[t.length - 1];
  return s && s.length >= 3 ? s : null;
}
/** A retrieved page is about the athlete when its title carries her surname token, or its domain's first label contains it. */
export function chunkAboutAthlete(chunk: GroundedChunk, surname: string | null): boolean {
  if (!surname) return false;
  return titleTokens(chunk.title).has(surname) || alnum((registrableDomain(chunk.domain) ?? "").split(".")[0]).includes(surname);
}

/**
 * The candidate pool; every candidate URL is a grounding chunk's link. A model item matched to a chunk becomes a candidate with
 * that chunk's link (and the item's participation / medium / outlet); an item no chunk matches is `ungrounded` — never read, no
 * URL repaired or searched for. A chunk no item matched enters when it is about the athlete (participation unknown).
 */
export function groundedCandidates(hints: readonly MediaHint[], chunks: readonly GroundedChunk[], opts: { resolved: ReadonlyMap<string, string | null>; surname: string | null; thresholds: GroundedMatchThresholds }): { candidates: ReadCandidate[]; ungrounded: MediaHint[] } {
  const candidates: ReadCandidate[] = []; const ungrounded: MediaHint[] = [];
  const used = new Set<string>();
  for (const h of hints) {
    const c = matchHintToChunk(h, chunks, opts.resolved, opts.thresholds);
    if (!c) { ungrounded.push(h); continue; }
    used.add(c.url);
    const { claimedUrl: _untrusted, ...rest } = h;   // the model-written URL stops here
    candidates.push({ ...rest, url: c.url, domain: c.domain, origin: "item" });
  }
  for (const c of [...chunks].sort((a, b) => (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))) {
    if (used.has(c.url) || !chunkAboutAthlete(c, opts.surname)) continue;
    used.add(c.url);
    candidates.push({ evidenceId: null, url: c.url, title: c.title, outlet: null, outletType: null, sourceType: null, medium: registrableDomain(c.domain) === "youtube.com" ? "video" : null, participation: null, athleteQuoted: false, date: null, lineage: "native_retrieved", origin: "grounding", domain: c.domain });
  }
  return { candidates, ungrounded };
}

/** Rank the pool BEFORE any link is resolved (outlet authority from the chunk's domain), so links are resolved lazily in rank order. */
export function rankReadCandidates(candidates: readonly ReadCandidate[], knownHandles?: ReadonlyArray<string | null | undefined>): ReadCandidate[] {
  return candidates.map((c) => {
    const st = resolveSourceType(c.outletType, c.domain ?? hostOf(c.url), undefined, { urls: [], names: [c.outlet], knownHandles });
    return { c, rank: readRank(c, st), tie: `${c.url}|${c.evidenceId ?? ""}` };
  }).sort((a, b) => cmpRank(a.rank, b.rank) || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0)).map((k) => k.c);
}

// ── the request ───────────────────────────────────────────────────────────────

/** Items the read may report besides statements: identity and narrative items, plus a few facts a profile or interview states. Generic. */
export const READ_ITEMS = [
  "origin_background", "motivations", "interests", "values_causes", "playing_style", "leadership_mentality", "signature_moments", "storylines",
  "foundations_positions", "brand_themes", "associations", "ventures", "hometown", "current_affiliation", "position_role", "milestones_selections",
  "awards_selections", "results_titles", "partnerships_deals",
] as const;
const SECTION_OF_ITEM: Record<string, SectionId> = Object.fromEntries(SECTIONS.flatMap((s) => s.items.map((i) => [i.id, s.id] as const)));

export const SOURCE_READ_SYSTEM_INSTRUCTION =
  "You are reading ONE public source about ONE athlete for an athlete profile. Use only what this source itself says or shows; " +
  "never add outside knowledge and never search. If the source is not about the athlete identified in the request, or you cannot open it, say so and return nothing else. " +
  "Statements are the athlete's OWN words only: copy them exactly as the athlete said or wrote them in this source, character for character. " +
  "Never paraphrase, summarise, translate or complete a statement; reported speech (\"she said that ...\") and words of anyone else (a coach, a host, a writer) are not statements. " +
  "Describe, do not rate: no scores, tiers or judgements of the athlete, the outlet or the story. Return only the JSON object the request asks for.";

export interface ReadSubject { fullName: string; sport: string; anchor: string; isMinor: boolean }

/** The request for one source. For a page the URL is in the text (URL context reads it); for a video it is also the attached file. */
export function sourceReadRequest(subject: ReadSubject, target: Pick<ReadTarget, "readUrl" | "mode" | "title" | "outlet">, asOf: string): string {
  const items = READ_ITEMS.map((id) => `    "${id}": [ { "value": { ${Object.entries(ITEM_SHAPES[id] ?? { text: "as the source states it" }).map(([k, v]) => `"${k}": "${v}"`).join(", ")} }, "statement": "one sentence as the source states it", "as_of": "YYYY-MM-DD or null" } ]`).join(",\n");
  const head = [
    `Athlete identity anchor: ${subject.anchor}`, `Athlete: ${subject.fullName} — ${subject.sport}`, `As-of date: ${asOf}`,
    subject.isMinor ? "This athlete is a minor: report nothing about home address, contact details, family members' private details or an exact date of birth." : null,
    `Source to read (${target.mode === "youtube" ? "public video, attached" : "web page"}): ${target.readUrl}`,
    target.title || target.outlet ? `Listed as: ${[target.title, target.outlet].filter(Boolean).join(" — ")}` : null,
  ].filter(Boolean).join("\n");
  const ts = target.mode === "youtube" ? `"timestamp": "where in the video the athlete says it, H:MM:SS or MM:SS, or null"` : `"timestamp": null`;
  return `${head}

Read this one source and extract, in one pass, everything useful and attributable from it:
1. statements — the athlete's own words, verbatim, each with its topics.
2. items — facts and descriptions this source states about the athlete (origin, motivations, interests, values and causes, playing
   style and leadership as others describe them, signature moments, ventures, and the listed facts). Only what THIS source states.

Output contract (${SOURCE_READ_VERSION}):
{
  "contract": "${SOURCE_READ_VERSION}",
  "source": { "url": "the URL you read", "title": "...", "outlet": "...", "outlet_type": "${OUTLET_TYPE_SHAPE}", "published_at": "YYYY-MM-DD or null", "medium": "video | article | podcast | press_conference | profile | other", "about_athlete": "yes | no | unsure", "read": "true when you could open and read this source, else false" },
  "statements": [ { "text": "the athlete's exact words", "verbatim": "true only when copied exactly as the athlete said or wrote them", "speaker": "athlete | other", "topics": ["${STATEMENT_TOPICS.join(" | ")}"], ${ts} } ],
  "items": {
${items}
  }
}
Rules: omit an item or a field the source does not state (never invent one to complete the shape); one finding per distinct fact;
a number or date exactly as the source states it; no statement that is not the athlete's own verbatim words.`;
}

/** Words that must never reach a provider (research-spec/1 §4.3). Throws before any call. */
export function assertReadRequestClean(request: string): void {
  for (const re of FORBIDDEN_IN_REQUESTS) if (re.test(request)) throw new Error(`source read request contains a forbidden word (${re})`);
}

// ── parsing ───────────────────────────────────────────────────────────────────

export interface ReadStatement { text: string; verbatim: boolean; speaker: "athlete" | "other" | null; topics: StatementTopic[]; timestamp: string | number | null }
export interface ParsedSourceRead {
  source: { url: string | null; title: string | null; outlet: string | null; outletType: string | null; publishedAt: string | null; medium: string | null; aboutAthlete: "yes" | "no" | "unsure" | null; read: boolean | null };
  statements: ReadStatement[];
  items: Array<{ item: string; value: Record<string, unknown>; statement: string | null; asOf: string | null }>;
  parseError: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const truthy = (v: unknown): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

export function parseSourceRead(text: string): ParsedSourceRead {
  const empty = (e: string): ParsedSourceRead => ({ source: { url: null, title: null, outlet: null, outletType: null, publishedAt: null, medium: null, aboutAthlete: null, read: null }, statements: [], items: [], parseError: e });
  const t = (text ?? "").replace(/^```json\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return empty("no JSON object in the response");
  let j: any;
  try { j = JSON.parse(t.slice(a, b + 1)); } catch (e: any) { return empty(String(e?.message ?? e)); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return empty("top-level JSON is not an object");
  const src = j.source && typeof j.source === "object" ? j.source : {};
  const about = str(src.about_athlete)?.toLowerCase();
  const statements: ReadStatement[] = (Array.isArray(j.statements) ? j.statements : []).filter((x: any) => x && typeof x === "object" && str(x.text)).map((x: any) => {
    const topics = (Array.isArray(x.topics) ? x.topics : [x.topics]).map((v: unknown) => String(v ?? "").trim().toLowerCase()).filter((v: string) => (STATEMENT_TOPICS as readonly string[]).includes(v)) as StatementTopic[];
    const speaker = str(x.speaker)?.toLowerCase();
    return { text: str(x.text)!.slice(0, 1200), verbatim: truthy(x.verbatim) === true, speaker: speaker === "athlete" ? "athlete" : speaker ? "other" : null, topics: [...new Set(topics)], timestamp: typeof x.timestamp === "number" ? x.timestamp : str(x.timestamp) };
  });
  const items: ParsedSourceRead["items"] = [];
  for (const [id, v] of Object.entries(j.items && typeof j.items === "object" ? j.items : {})) {
    if (!(READ_ITEMS as readonly string[]).includes(id)) continue;   // only the items asked
    const list = Array.isArray(v) ? v : Array.isArray((v as any)?.findings) ? (v as any).findings : [];
    for (const f of list) {
      if (!f || typeof f !== "object") continue;
      const value = f.value && typeof f.value === "object" && !Array.isArray(f.value) ? Object.fromEntries(Object.entries(f.value).filter(([, x]) => x != null && x !== "")) : {};
      if (!Object.keys(value).length && !str(f.statement)) continue;
      items.push({ item: id, value, statement: str(f.statement), asOf: typeof f.as_of === "string" && /^\d{4}/.test(f.as_of) ? f.as_of.slice(0, 10) : null });
    }
  }
  return {
    source: { url: str(src.url), title: str(src.title), outlet: str(src.outlet), outletType: str(src.outlet_type)?.toLowerCase() ?? null, publishedAt: typeof src.published_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(src.published_at) ? src.published_at.slice(0, 10) : null, medium: str(src.medium)?.toLowerCase() ?? null, aboutAthlete: about === "yes" || about === "no" || about === "unsure" ? about : null, read: truthy(src.read) },
    statements, items, parseError: null,
  };
}

// ── mapping ───────────────────────────────────────────────────────────────────

/** Reported speech or third-person framing: never the athlete's own words, whatever the model says. */
const REPORTED = /\b(said|says|explained|noted|added|stated|told|recalled|admitted|believes|insisted)\s+that\b|^\s*(she|he|they|the athlete)\s+(said|says|explained|noted|added|stated|told|recalled|admitted|believes|feels|thinks|wants|loves)\b/i;
export function isVerbatimAthleteStatement(s: ReadStatement): boolean {
  return s.verbatim === true && s.speaker === "athlete" && !REPORTED.test(s.text) && s.text.length >= 3;
}

/** "1:02:03" / "12:34" / "754" / "754s" → seconds; null when not determinable. */
export function timestampSeconds(t: string | number | null): number | null {
  if (typeof t === "number") return Number.isFinite(t) && t >= 0 ? Math.floor(t) : null;
  if (!t) return null;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (m) return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  const s = /^(\d+)\s*s?$/.exec(t.trim());
  return s ? Number(s[1]) : null;
}

/** A statement topic → the narrative_claim topic its paraphrase is filed under. */
const PARAPHRASE_TOPIC: Record<StatementTopic, string> = { origin: "origin", motivation: "motivation", values: "values_causes", leadership: "leadership", ambition: "motivation", interests: "interests", style: "playing_style", community: "values_causes", other: "storyline" };

export interface SourceReadMapped { claims: MappedClaim[]; statements: number; paraphrases: number; dropped: string | null }

/**
 * One read's output → evidence claims, all lineage `source_read` bound to the read envelope's single chunk (source_url = the URL
 * read). A source the model says is not about the athlete, or could not read, yields nothing.
 */
export function mapSourceRead(parsed: ParsedSourceRead, target: Pick<ReadTarget, "readUrl" | "mode" | "title" | "outlet" | "outletType">, envelopeId: string): SourceReadMapped {
  if (parsed.parseError) return { claims: [], statements: 0, paraphrases: 0, dropped: `unparseable: ${parsed.parseError.slice(0, 120)}` };
  if (parsed.source.read === false) return { claims: [], statements: 0, paraphrases: 0, dropped: "the model could not read the source" };
  if (parsed.source.aboutAthlete === "no") return { claims: [], statements: 0, paraphrases: 0, dropped: "the source is not about this athlete" };
  const title = parsed.source.title ?? target.title ?? null;
  const outlet = parsed.source.outlet ?? target.outlet ?? null;
  const medium = parsed.source.medium ?? (target.mode === "youtube" ? "video" : null);
  const chunkId = `${envelopeId}:c0`;
  const lineage: DirectClaimLineage = { level: "source_read", match: "none", boundChunkIds: [chunkId], boundSources: [{ url: target.readUrl, domain: hostOf(target.readUrl), title }], detail: target.mode === "youtube" ? "read: public video (native video input)" : "read: web page (URL context)", bindingMethod: "none" };
  const source = (quote: string): DirectSource => ({ url: target.readUrl, title, publishedAt: parsed.source.publishedAt, quote: quote.slice(0, 300), outletType: parsed.source.outletType ?? target.outletType ?? null });
  const base = (item: string, section: SectionId, text: string) => ({ section, item, statement: text, sources: [source(text)], lineage, citation: { chunkIds: [chunkId], quote: text.slice(0, 300) }, confidence: undefined, publishedAt: parsed.source.publishedAt, mappingVersion: SOURCE_READ_VERSION, registryStatus: "unmapped" as const, unmappedFields: [] as string[] });
  const claims: MappedClaim[] = [];
  let statements = 0, paraphrases = 0;
  for (const s of parsed.statements) {
    const topics = s.topics.length ? s.topics : (["other"] as StatementTopic[]);
    if (isVerbatimAthleteStatement(s)) {
      const ts = target.mode === "youtube" ? timestampSeconds(s.timestamp) : null;
      claims.push({ ...base("athlete_statement", "S6", s.text), kind: "athlete_statement", claim: { text: s.text, topics, medium, speaker: "athlete", ...(ts != null ? { timestampSeconds: ts } : {}), sourceTitle: title, outlet, readSpec: SOURCE_READ_VERSION } });
      statements++;
    } else {
      // A paraphrase, reported speech or someone else's words: kept as a description, never as her words.
      claims.push({ ...base("athlete_statement_paraphrase", "S6", s.text), kind: "narrative_claim", claim: { topic: PARAPHRASE_TOPIC[topics[0]], text: s.text, paraphrase: true, speaker: s.speaker ?? "unknown", describedBy: s.speaker === "athlete" ? null : "other", readSpec: SOURCE_READ_VERSION } });
      paraphrases++;
    }
  }
  for (const it of parsed.items) {
    const section = SECTION_OF_ITEM[it.item];
    if (!section) continue;
    const f: Finding = { section, item: it.item, value: it.value, statement: it.statement, asOf: it.asOf, sources: [source(it.statement ?? "")], lineage };
    for (const m of mapFinding(f)) claims.push({ ...m, claim: { ...m.claim, readSpec: SOURCE_READ_VERSION, ...(outlet ? { sourceOutlet: outlet } : {}) } });
  }
  return { claims, statements, paraphrases, dropped: null };
}
