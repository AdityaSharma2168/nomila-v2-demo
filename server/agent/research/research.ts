/**
 * agent/research/research.ts — the RESEARCH skill: two independent web-search passes, then a merge.
 *
 *   searchPass  one pass of jobs/research.md (native web_search, high effort). Its facts must carry a URL the pass
 *               actually saw; a URL it never saw is dropped (a host it saw is kept at lower confidence).
 *   mergePasses jobs/research/merge.md: de-duplicates, resolves conflicts from the sources, keeps every source, and
 *               flags conflicts with what we already hold. A conflicting fact is written DISPUTED (and the fact it
 *               conflicts with is marked disputed too, unless the athlete said it); nothing is overwritten. Since
 *               1.8.0 it also reads her own connected posts that name a partner, and may cite one as evidence that a
 *               partnership is current; every merged fact stores its topic and its source's outlet type (0115).
 *   syncMeasured measured facts from connected accounts (code, not a model): a newer reading of the same metric
 *               supersedes the older one.
 *
 * Models drive the judgement; this file is plumbing and safety (sources, keys, statuses, and whose fact it is: a fact
 * about anyone but the athlete must name its subject, and a sponsor claim must say whose sponsor it is — subjectOf).
 */
import { IDENTITY_FIELDS, SUBJECT_KINDS, type DatePrecision, type IdentityField, type MemoryFact } from "../../../shared/agent";
import { normalizeUrl } from "./llm";
import { runSkill } from "./runSkill";
import { FACT_TOPICS, MERGE_COMPACT_SCHEMA, MERGE_SCHEMA, RESEARCH_PASS_SCHEMA, SOURCE_TYPES, type SourceType } from "./schemas";
import { metricOf, partnerPostLine, PARTNER_POSTS_HEADING, type ConnectedPostEvidence } from "./connected";
import { cleanClaim, cleanNewFact, normalizeSourceUrl } from "../factHygiene";
import { careKindOf, dropPrivate, isCare, mustNotStore } from "./privacy";
import type { ResearchEvent } from "../../../shared/agent";
import type { AgentStore, NewFact } from "./store";

/** Code-enforced caps (also in the response schemas and the skill text). */
export const PASS_MAX_FACTS = 30;
export const PASS_MAX_SEARCHES = 10;
export const MERGE_MAX_FACTS = 60;

export interface AthleteIdentity {
  name: string;
  sport: string;
}

export interface PassFact {
  key: string;
  subject_kind: MemoryFact["subject"]["kind"];
  subject_name: string;
  claim: string;
  topic: string;
  source_url: string;
  source_title: string;
  /** The source's outlet type (research 1.7.0); "other" when the pass gave none or an unknown one. */
  source_type: SourceType;
  date: string;
  confidence: number;
  /** Public but delicate (sensitivity "care"): kept, handled with care downstream. */
  care: boolean;
  /** care only: personal | conduct (a care fact the pass gave no kind is personal). */
  careKind: "personal" | "conduct" | null;
}

export interface PassResult {
  runId: string;
  pass: "a" | "b";
  identity: { resolved: boolean; description: string; ambiguity: string };
  facts: PassFact[];
  gaps: string[];
  narrative: string;
  dropped: Array<{ claim: string; reason: string }>;
  costMicroUsd: number;
  /** True when the pass was stopped at its time budget: these are the facts it had streamed by then. */
  cut?: boolean;
}

/**
 * Pure: what a research pass had streamed before it was stopped — its identity object (the schema's first field) once
 * complete, and every COMPLETE fact object in its facts array. An unfinished object is never guessed at. Null when
 * nothing complete had streamed (the model was still searching or thinking). No gaps or narrative: never invented.
 */
export function salvagePassJson(text: string): { identity?: unknown; facts: unknown[]; gaps: string[]; narrative: string } | null {
  const facts: unknown[] = [];
  let identity: unknown;
  let depth = 0, inStr = false, esc = false, strStart = -1, lastStr = "", topKey: string | null = null, valStart = -1, objStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') { inStr = false; lastStr = text.slice(strStart, i + 1); }
      continue;
    }
    if (c === '"') { inStr = true; strStart = i; continue; }
    if (c === ":" && depth === 1) { try { topKey = JSON.parse(lastStr); } catch { topKey = null; } valStart = i + 1; continue; }
    if (c === "{" || c === "[") { depth++; if (topKey === "facts" && depth === 3 && c === "{") objStart = i; continue; }
    if (c === "}" || c === "]") {
      if (topKey === "facts" && depth === 3 && c === "}" && objStart >= 0) {
        try { facts.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* not a whole object: left out */ }
        objStart = -1;
      }
      depth--;
      if (depth === 1 && topKey === "identity" && valStart >= 0 && identity === undefined) {
        try { identity = JSON.parse(text.slice(valStart, i + 1)); } catch { /* incomplete */ }
      }
    }
  }
  if (!facts.length && identity === undefined) return null;
  return { ...(identity !== undefined ? { identity } : {}), facts, gaps: [], narrative: "" };
}

export interface JobContext {
  store: AgentStore;
  athleteId: string;
  /** "workflow:<run id>" — each skill run is keyed under it, so a retried step reuses a finished run. */
  parentPrefix: string | null;
  budget?: { spentMicroUsd: number; capMicroUsd: number };
  today?: string;
}

const sourceTypeOf = (v: unknown): SourceType => ((SOURCE_TYPES as readonly string[]).includes(String(v)) ? (v as SourceType) : "other");
/** Each pass's angle, as the input names it (the skill text holds the full list for each). */
export const PASS_ANGLES: Record<"a" | "b", string> = {
  a: "career, role, representation, results, status, media over time, story, controversies, and current sponsors with their deal terms",
  b: "audience and its growth, engagement, demographics, search and conversation, comparable athletes, brand presence, partners, community, upcoming events and commercial context",
};
const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
const parentRef = (ctx: JobContext, step: string) => (ctx.parentPrefix ? `${ctx.parentPrefix}:${step}` : null);
const today = (ctx: JobContext) => ctx.today ?? new Date().toISOString().slice(0, 10);

/** "2024", "2024-05", "2024-05-17" → an ISO date (first of the period); anything else → null. */
export function toIsoDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  return null;
}

/** How precise a raw research date is: "2026-12-05" day, "2026-12" month, "2026" year; null when it is not a date. */
export function datePrecisionOf(raw: string | null | undefined): DatePrecision | null {
  const s = (raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "day";
  if (/^\d{4}-\d{2}$/.test(s)) return "month";
  if (/^\d{4}$/.test(s)) return "year";
  return null;
}

/** The first raw date that parses, as stored (the 1st of a month-only date) with its precision kept. */
export function datedOf(...raws: Array<string | null | undefined>): { date: string | null; datePrecision: DatePrecision | null } {
  for (const raw of raws) {
    const date = toIsoDate(raw);
    if (date) return { date, datePrecision: datePrecisionOf(raw) };
  }
  return { date: null, datePrecision: null };
}

/**
 * The identity field a merged fact states (research/merge 1.9.0: the model labels it), kept only for a fact about the
 * athlete with a value: a team's or a teammate's facts never fill the athlete's identity line.
 */
export function identityFieldOf(m: any, subjectKind: string): { field: IdentityField | null; fieldValue: string | null } {
  const field = (IDENTITY_FIELDS as readonly string[]).includes(String(m?.field)) ? (m.field as IdentityField) : null;
  const value = typeof m?.field_value === "string" ? cleanClaim(m.field_value).replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return field && value && subjectKind === "athlete" ? { field, fieldValue: value } : { field: null, fieldValue: null };
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };

/** A topic from the research vocabulary, or "other". */
export const topicOf = (v: unknown): string => ((FACT_TOPICS as readonly string[]).includes(String(v)) ? String(v) : "other");

/** Topics whose facts are about a sponsor or partnership: the claim must say WHOSE sponsor it is. */
const SPONSOR_TOPICS = new Set(["sponsor", "commerce", "business"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** True when the claim names the athlete (the full name, or the family name as a word). */
export function claimNamesAthlete(claim: string, athleteName: string): boolean {
  const name = words(athleteName);
  if (!name.length) return true;
  const c = words(claim);
  const last = name[name.length - 1];
  return c.includes(last) || name.every((t) => c.includes(t));
}

/**
 * The subject of a pass or merged fact, or why it cannot be stored (research 1.8.0):
 *   - the subject kind must be one of SUBJECT_KINDS (else "athlete", as before);
 *   - a fact about anyone or anything other than the athlete must name its subject (a team, school or club's
 *     sponsor is the ORGANIZATION's fact, with the organization's name) — the athlete's name is never put in for it;
 *   - a sponsor or partnership fact filed under the athlete must name the athlete in the claim: a claim that does not
 *     say whose sponsor it is cannot be stored as the athlete's (the first real run stored a club's sponsors under
 *     the athlete's sponsor topic).
 */
export function subjectOf(f: any, athlete: AthleteIdentity, claim: string, topic: string): { kind: MemoryFact["subject"]["kind"]; name: string } | { reason: string } {
  const kind = (SUBJECT_KINDS as readonly string[]).includes(f?.subject_kind) ? (f.subject_kind as MemoryFact["subject"]["kind"]) : "athlete";
  const name = String(f?.subject_name ?? "").trim();
  if (kind !== "athlete") return name ? { kind, name: name.slice(0, 300) } : { reason: `${kind} fact does not name its subject` };
  if (SPONSOR_TOPICS.has(topic) && !claimNamesAthlete(claim, athlete.name)) return { reason: "sponsor claim does not say whose sponsor it is" };
  return { kind, name: name || athlete.name };
}

/**
 * Keep a fact only when its URL was seen by the run (search sources or citations). A URL on a host the run saw, but
 * not the exact page, is kept at 0.8× confidence. Any other URL — or none — is dropped. When the provider reported no
 * sources at all (it should), facts are kept but capped at 0.6 confidence.
 */
export function checkSource(url: string, seen: Array<{ url: string }>): { ok: boolean; url: string; factor: number; reason?: string } {
  if (!/^https?:\/\//i.test(url ?? "")) return { ok: false, url, factor: 0, reason: "no source url" };
  const keyOf = (u: string) => normalizeUrl(normalizeSourceUrl(u) ?? u);
  // A URL that is not a usable source (an image or other page asset, markdown residue, no real host) is no source —
  // unless the run saw the page it hangs off (a page URL the junk one starts with): then that page is the source.
  const clean = normalizeSourceUrl(url);
  if (!clean) {
    const raw = normalizeUrl(url);
    const page = seen.map((s) => normalizeSourceUrl(s.url)).filter((u): u is string => !!u)
      .filter((u) => raw.startsWith(`${keyOf(u)}/`)).sort((a, b) => b.length - a.length)[0];
    return page ? { ok: true, url: page, factor: 0.8 } : { ok: false, url, factor: 0, reason: "malformed source url" };
  }
  const n = normalizeUrl(clean);
  if (!seen.length) return { ok: true, url: clean, factor: 0.6 };
  const set = new Set(seen.map((s) => keyOf(s.url)));
  if (set.has(n)) return { ok: true, url: clean, factor: 1 };
  const hosts = new Set(seen.map((s) => hostOf(keyOf(s.url))).filter(Boolean));
  const h = hostOf(n);
  if (h && hosts.has(h)) return { ok: true, url: clean, factor: 0.8 };
  return { ok: false, url: clean, factor: 0, reason: "source not seen by this pass" };
}

function knownFactsText(facts: MemoryFact[]): string {
  const said = facts.filter((f) => f.type === "said" && f.status === "active");
  return said.length ? said.map((f) => `- ${f.claim}`).join("\n") : "- (none yet)";
}

const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/**
 * Live events for one pass: "reading" for each source a completed search returns, and "discovery" for each fact as the
 * model writes it (read from the streamed JSON; a never-store fact is never emitted). When the provider only returns
 * at the end, onDone emits the discoveries from the final facts instead, plus "pass_done".
 */
export function liveResearchEvents(pass: "a" | "b") {
  const seenUrls = new Set<string>();
  const seenClaims = new Set<string>();
  // Facts stream as objects in schema order: … "claim":"…","topic":"…","source_url":"…","source_title":"…", …
  const FACT_RE = /"claim"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"topic"\s*:\s*"[^"]*"\s*,\s*"source_url"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"source_title"\s*:\s*"((?:[^"\\]|\\.)*)"(?:[^}]*?"sensitivity"\s*:\s*"(\w+)")?/g;
  const unescape = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
  const discovery = (claim: string, url: string, title: string): ResearchEvent[] => {
    if (!claim || seenClaims.has(claim) || mustNotStore({ claim })) return [];
    seenClaims.add(claim);
    return [{ kind: "discovery", at: new Date().toISOString(), pass, text: claim.slice(0, 240), source: { domain: domainOf(url), url, ...(title ? { title } : {}) } }];
  };
  return {
    onSearch: (s: { sources: Array<{ url: string; title?: string }> }): ResearchEvent[] => s.sources
      .filter((x) => !seenUrls.has(x.url) && seenUrls.add(x.url))
      .slice(0, 8)
      .map((x) => ({ kind: "reading" as const, at: new Date().toISOString(), pass, domain: domainOf(x.url), url: x.url, ...(x.title ? { title: x.title } : {}) })),
    onText: (text: string): ResearchEvent[] => {
      const out: ResearchEvent[] = [];
      for (const m of text.matchAll(FACT_RE)) {
        // Only a complete object tells us its sensitivity; a fact whose sensitivity is not yet streamed waits for onDone.
        if (!m[4] || m[4] === "never") continue;
        if (m[4] === "care") { seenClaims.add(unescape(m[1])); continue; }   // care facts are never shown live
        out.push(...discovery(unescape(m[1]), unescape(m[2]), unescape(m[3])));
      }
      return out;
    },
    onDone: (json: any): ResearchEvent[] => {
      const facts: any[] = Array.isArray(json?.facts) ? json.facts : [];
      const out: ResearchEvent[] = [];
      for (const f of facts) if (!isCare(f)) out.push(...discovery(String(f?.claim ?? ""), String(f?.source_url ?? ""), String(f?.source_title ?? "")));
      out.push({ kind: "pass_done", at: new Date().toISOString(), pass, facts: facts.length });
      return out;
    },
  };
}

/** One independent search pass. */
export async function searchPass(ctx: JobContext, opts: {
  pass: "a" | "b"; athlete: AthleteIdentity; connectedSummary: string; existing: MemoryFact[]; maxSearches?: number;
  /** Stop the pass early (a time budget): asked every `everyMs`; the pass keeps the facts it had streamed (salvagePassJson). */
  stopWhen?: { check: () => Promise<boolean>; everyMs: number };
}): Promise<PassResult> {
  const input = [
    `ATHLETE`,
    `- Name: ${opts.athlete.name}`,
    `- Sport: ${opts.athlete.sport}`,
    ``,
    `WHAT THE ATHLETE HAS TOLD US (said; anchors identity)`,
    knownFactsText(opts.existing),
    ``,
    `CONNECTED ACCOUNTS`,
    opts.connectedSummary,
    ``,
    `Today is ${today(ctx)}. You are PASS ${opts.pass.toUpperCase()}: ${PASS_ANGLES[opts.pass]}. Search on your own.`,
  ].join("\n");
  const r = await runSkill({
    store: ctx.store, athleteId: ctx.athleteId, skillId: "research", trigger: "event", parentRef: parentRef(ctx, `research_${opts.pass}`),
    input, schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA,
    webSearch: { maxCalls: Math.min(opts.maxSearches ?? PASS_MAX_SEARCHES, PASS_MAX_SEARCHES), contextSize: "medium" }, maxOutputTokens: 16_000, budget: ctx.budget,
    sanitize: (json) => dropPrivate(json, "facts", PASS_MAX_FACTS),
    live: liveResearchEvents(opts.pass),
    ...(opts.stopWhen ? { cut: { ...opts.stopWhen, salvage: salvagePassJson } } : {}),
  });
  return passResultFrom(r, opts.athlete, opts.pass);
}

/**
 * The checks every research pass's answer goes through, whoever produced it (the web-search pass above, or the narrow
 * pipeline's extract step, research/v2): a fact needs a claim, must not be private, must cite a URL the run actually
 * saw (a host it saw is kept at lower confidence), and must name its subject. `keyPrefix` keys the facts (a1, a2 …).
 */
export function passResultFrom(
  r: { runId: string; json: unknown; sources: Array<{ url: string; title?: string }>; reused: boolean; cost: { microUsd: number }; cut?: boolean },
  athlete: AthleteIdentity,
  pass: "a" | "b",
  keyPrefix: string = pass,
  /** The most facts read from the answer. Only the extract-all variant (v2/extractAll.ts: lean research, the bake-off) raises it. */
  maxFacts: number = PASS_MAX_FACTS,
): PassResult {
  const j = (r.json ?? {}) as any;
  const facts: PassFact[] = [];
  const dropped: PassResult["dropped"] = [];
  let i = 0;
  for (const f of (Array.isArray(j.facts) ? j.facts : []).slice(0, maxFacts)) {
    const claim = typeof f?.claim === "string" ? cleanClaim(f.claim) : "";
    if (!claim || mustNotStore(f)) continue;
    const src = checkSource(String(f.source_url ?? ""), r.sources);
    if (!src.ok) { dropped.push({ claim, reason: src.reason ?? "no source" }); continue; }
    const subject = subjectOf(f, athlete, claim, String(f.topic ?? ""));
    if ("reason" in subject) { dropped.push({ claim, reason: subject.reason }); continue; }
    facts.push({
      key: `${keyPrefix}${++i}`, subject_kind: subject.kind, subject_name: subject.name,
      claim: claim.slice(0, 2000), topic: topicOf(f.topic), source_url: src.url, source_title: String(f.source_title ?? ""),
      source_type: sourceTypeOf(f.source_type), date: String(f.date ?? ""), confidence: Math.round(clamp01(f.confidence) * src.factor * 100) / 100, care: isCare(f), careKind: careKindOf(f),
    });
  }
  return {
    runId: r.runId, pass,
    identity: { resolved: j.identity?.resolved === true, description: String(j.identity?.description ?? ""), ambiguity: String(j.identity?.ambiguity ?? "") },
    facts, gaps: Array.isArray(j.gaps) ? j.gaps.map(String) : [], narrative: String(j.narrative ?? ""), dropped, costMicroUsd: r.reused ? 0 : r.cost.microUsd,
    ...(r.cut ? { cut: true } : {}),
  };
}

/**
 * The kind of a merged care fact: the merge's own answer when it gives one, else the passes' (conduct only when a pass
 * said conduct and none said personal). Anything unclear is personal — the stricter rule. Null when not care at all.
 */
export function mergedCareKind(m: any, from: PassFact[]): "personal" | "conduct" | null {
  if (!isCare(m) && !from.some((f) => f.care)) return null;
  if (isCare(m) && (m?.care_kind === "conduct" || m?.care_kind === "personal")) return m.care_kind;
  const kinds = from.filter((f) => f.care).map((f) => f.careKind);
  return kinds.length && kinds.every((k) => k === "conduct") ? "conduct" : "personal";
}

const passLine = (f: PassFact) =>
  `${f.key} | ${f.subject_kind}: ${f.subject_name} | ${f.claim} | topic ${f.topic} | date ${f.date || "-"} | conf ${f.confidence}${f.care ? ` | CARE ${(f.careKind ?? "personal").toUpperCase()}` : ""} | outlet ${f.source_type} | source ${f.source_title ? `${f.source_title} ` : ""}<${f.source_url}>`;
const existingLine = (key: string, f: MemoryFact) =>
  `${key} | ${f.type} | ${f.status} | ${f.subject.kind}: ${f.subject.name} | ${f.claim} | date ${f.date ?? "-"} | source ${f.source.url ?? f.source.title ?? f.source.ref ?? "-"}`;

export interface MergeResult {
  runId: string;
  inserted: MemoryFact[];
  disputed: number;
  duplicates: number;
  dropped: Array<{ key: string; reason: string }>;
  narrative: string;
  gaps: string[];
  identity: PassResult["identity"];
  costMicroUsd: number;
}

/**
 * RESEARCH_MERGE_COMPACT=true (default OFF; dev only until its equivalence check passed): the merge runs
 * jobs/research/merge-compact.md, the same judgement answered by key — each merged fact names its pass-fact keys and
 * returns only the fields it changes (its `set` list; anything left out keeps the first pass fact's value), instead of
 * re-writing every field of every fact. The output tokens were most of the merge's cost. Code rebuilds the full merged fact (expandCompactMerge) BEFORE the run's
 * output is stored and before anything reads it, so the stored run, the facts written and every reader are unchanged.
 */
export function researchMergeCompact(): boolean {
  return process.env.RESEARCH_MERGE_COMPACT === "true";
}
export const MERGE_SKILL_ID = "research/merge";
export const MERGE_COMPACT_SKILL_ID = "research/merge-compact";

/**
 * A compact merge answer (MERGE_COMPACT_SCHEMA) → the full MERGE_SCHEMA answer. Each field the fact's `set` list does
 * not change takes the value of the FIRST pass fact named in `from` (sensitivity: "care" when any named pass fact is
 * care, else "none"); the rest default as the full answer would leave them (care kind and never reason "none", no
 * conflict, no duplicate, no note, no identity field). A fact naming no pass fact (posts only) keeps what it set, empty
 * where it set nothing — the merge's own checks then treat it exactly as they treat a full answer. Pure.
 */
export function expandCompactMerge(json: any, byKey: ReadonlyMap<string, PassFact>): any {
  const facts: any[] = Array.isArray(json?.facts) ? json.facts : [];
  return {
    ...(json ?? {}),
    facts: facts.map((m) => {
      const keys: string[] = (Array.isArray(m?.from) ? m.from : []).map(String);
      const named = keys.map((k) => byKey.get(k)).filter((f): f is PassFact => !!f);
      const base = named[0];
      const set = new Map<string, string>();
      for (const e of Array.isArray(m?.set) ? m.set : []) if (typeof e?.key === "string" && typeof e?.value === "string") set.set(e.key, e.value);
      const pick = (k: string, fallback: string) => set.get(k) ?? fallback;
      return {
        from: keys,
        subject_kind: pick("subject_kind", base?.subject_kind ?? "athlete"),
        subject_name: pick("subject_name", base?.subject_name ?? ""),
        claim: pick("claim", base?.claim ?? ""),
        topic: pick("topic", base?.topic ?? "other"),
        date: pick("date", base?.date ?? ""),
        confidence: m?.confidence,
        sensitivity: pick("sensitivity", named.some((f) => f.care) ? "care" : "none"),
        care_kind: pick("care_kind", "none"),
        never_reason: pick("never_reason", "none"),
        conflicts_with: pick("conflicts_with", ""),
        duplicate_of: pick("duplicate_of", ""),
        note: pick("note", ""),
        field: pick("field", "none"),
        field_value: pick("field_value", ""),
      };
    }),
  };
}

/** A connected post as evidence for a merged fact: its permalink when usable, else a ref to the media_assets row. */
export function postSource(p: ConnectedPostEvidence): { url?: string; ref?: string; title: string } {
  const url = normalizeSourceUrl(p.url);
  const label = p.platform.charAt(0).toUpperCase() + p.platform.slice(1);
  const title = `Your ${label} post${p.handle ? ` (@${p.handle})` : ""}, ${p.date}`;
  if (url) return { url, title };
  return { ref: p.mediaId ? `media_assets/${p.mediaId}` : `connected_posts/${p.platform}/${p.date}#${p.key}`, title };
}

/** A fact resting only on the athlete's own post is capped here: it shows they announced it, not its terms. */
export const POST_MAX_CONFIDENCE = 0.9;

/**
 * Merge two passes against what we already hold, and write the merged facts.
 *
 * `posts` (research 1.8.0): the athlete's own connected posts that name a partner (connected.partnerPosts), keyed
 * p1 …. Merge may cite a post in `from` as evidence that a partnership is current as of the post's date; a fact resting
 * only on posts is sourced to the post (its permalink, or the media_assets row) with outlet type "official" (the
 * athlete's own verified account) and confidence at most POST_MAX_CONFIDENCE.
 */
export async function mergePasses(ctx: JobContext, opts: { athlete: AthleteIdentity; a: PassResult; b: PassResult; existing: MemoryFact[]; posts?: ConnectedPostEvidence[] }): Promise<MergeResult> {
  const byKey = new Map<string, PassFact>([...opts.a.facts, ...opts.b.facts].map((f) => [f.key, f]));
  const postByKey = new Map<string, ConnectedPostEvidence>((opts.posts ?? []).map((p) => [p.key, p]));
  const backed = (k: unknown) => byKey.has(String(k)) || postByKey.has(String(k));
  const existingKeys = new Map<string, MemoryFact>();
  const relevant = opts.existing.filter((f) => f.status === "active" || f.status === "disputed");
  relevant.forEach((f, n) => existingKeys.set(`e${n + 1}`, f));

  const input = [
    `ATHLETE: ${opts.athlete.name} (${opts.athlete.sport})`,
    ``,
    `PASS A — identity: ${opts.a.identity.description || "-"}${opts.a.identity.ambiguity ? ` (ambiguity: ${opts.a.identity.ambiguity})` : ""}`,
    ...opts.a.facts.map(passLine),
    `PASS A gaps: ${opts.a.gaps.join("; ") || "-"}`,
    ``,
    `PASS B — identity: ${opts.b.identity.description || "-"}${opts.b.identity.ambiguity ? ` (ambiguity: ${opts.b.identity.ambiguity})` : ""}`,
    ...opts.b.facts.map(passLine),
    `PASS B gaps: ${opts.b.gaps.join("; ") || "-"}`,
    ``,
    PARTNER_POSTS_HEADING,
    ...(postByKey.size ? [...postByKey.values()].map(partnerPostLine) : ["- (none)"]),
    ``,
    `EXISTING FACTS WE HOLD`,
    ...(existingKeys.size ? [...existingKeys].map(([k, f]) => existingLine(k, f)) : ["- (none)"]),
  ].join("\n");

  const compact = researchMergeCompact();
  const r = await runSkill({
    store: ctx.store, athleteId: ctx.athleteId, skillId: compact ? MERGE_COMPACT_SKILL_ID : MERGE_SKILL_ID, trigger: "event", parentRef: parentRef(ctx, "research_merge"),
    input, schemaName: "research_merge", schema: compact ? MERGE_COMPACT_SCHEMA : MERGE_SCHEMA, maxOutputTokens: 24_000, budget: ctx.budget,
    sanitize: (answer) => {
      // A compact answer is rebuilt into the full one first: everything below (and the stored output) is unchanged.
      const json = compact ? expandCompactMerge(answer, byKey) : answer;
      // A merged fact with no pass fact or post behind it is not evidence: it is removed before the output is stored
      // (by key, never by text), then private facts are dropped with their first source's URL for the audit record.
      const all: any[] = Array.isArray(json?.facts) ? json.facts : [];
      const supported = all.filter((m) => (Array.isArray(m?.from) ? m.from : []).some(backed));
      const unsupported = all.filter((m) => !supported.includes(m)).map((m) => ({ key: String((m?.from ?? [])[0] ?? "?"), reason: "merged fact has no pass fact behind it" }));
      const firstUrl = (m: any) => {
        const k = String(m.from.find(backed));
        return byKey.get(k)?.source_url ?? postByKey.get(k)?.url ?? null;
      };
      const withUrl = supported.map((m) => ({ ...m, source_url: firstUrl(m) }));
      const d = dropPrivate({ ...(json ?? {}), facts: withUrl, dropped: [...(Array.isArray(json?.dropped) ? json.dropped : []), ...unsupported] }, "facts", MERGE_MAX_FACTS);
      return { ...d, json: { ...d.json, facts: d.json.facts.map(({ source_url: _u, ...m }: any) => m) } };
    },
    evidenceRead: [...existingKeys.values()].map((f) => ({ kind: "fact" as const, factId: f.id })),
  });
  const j = r.json ?? {};

  // Idempotent on retry: a reused merge run already wrote its facts.
  if (r.reused) {
    const inserted = (await ctx.store.listFacts(ctx.athleteId)).filter((f) => f.runId === r.runId);
    return { runId: r.runId, inserted, disputed: inserted.filter((f) => f.status === "disputed").length, duplicates: 0, dropped: [], narrative: String(j.narrative ?? ""), gaps: [...opts.a.gaps, ...opts.b.gaps], identity: opts.a.identity.resolved ? opts.a.identity : opts.b.identity, costMicroUsd: 0 };
  }

  const toInsert: Array<{ fact: NewFact; conflictsWith: MemoryFact | null }> = [];
  const dropped: MergeResult["dropped"] = Array.isArray(j.dropped) ? j.dropped.map((d: any) => ({ key: String(d?.key ?? ""), reason: String(d?.reason ?? "") })) : [];
  let duplicates = 0;
  for (const m of Array.isArray(j.facts) ? j.facts : []) {
    const keys: string[] = (Array.isArray(m?.from) ? m.from : []).map(String);
    const from: PassFact[] = keys.map((k) => byKey.get(k)).filter((f): f is PassFact => !!f);
    const posts: ConnectedPostEvidence[] = keys.map((k) => postByKey.get(k)).filter((p): p is ConnectedPostEvidence => !!p);
    const claim = typeof m?.claim === "string" ? cleanClaim(m.claim) : "";
    const firstKey = keys[0] ?? "?";
    if ((!from.length && !posts.length) || !claim) { dropped.push({ key: firstKey, reason: "merged fact has no pass fact behind it" }); continue; }
    if (mustNotStore(m)) continue;   // never stored (sanitize already removed it from the run's output)
    const dup = m.duplicate_of ? existingKeys.get(String(m.duplicate_of)) : undefined;
    if (dup) { duplicates++; continue; }
    const topic = topicOf(m.topic ?? from[0]?.topic);
    // The subject as merge gave it, else the first pass fact's; a post-only fact is the athlete's own word.
    const subject = subjectOf(
      { subject_kind: m.subject_kind ?? from[0]?.subject_kind ?? "athlete", subject_name: m.subject_name || from[0]?.subject_name || "" },
      opts.athlete, claim, topic,
    );
    if ("reason" in subject) { dropped.push({ key: firstKey, reason: subject.reason }); continue; }
    const sources: Array<{ url?: string; ref?: string; title?: string; sourceType: SourceType }> = [];
    for (const f of [...from].sort((x, y) => y.confidence - x.confidence)) {
      if (!sources.some((s) => s.url && normalizeUrl(s.url) === normalizeUrl(f.source_url))) sources.push({ url: f.source_url, ...(f.source_title ? { title: f.source_title } : {}), sourceType: f.source_type });
    }
    for (const p of posts) {
      const s = postSource(p);
      if (!sources.some((x) => (s.url && x.url && normalizeUrl(x.url) === normalizeUrl(s.url)) || (s.ref && x.ref === s.ref))) sources.push({ ...s, sourceType: "official" });
    }
    const primary = sources[0];
    const conflictsWith = m.conflicts_with ? existingKeys.get(String(m.conflicts_with)) ?? null : null;
    const bothPasses = from.some((f) => f.key.startsWith("a")) && from.some((f) => f.key.startsWith("b"));
    // The model's confidence, never above the best source-checked pass confidence unless both passes found it; a
    // fact only the athlete's own post supports is capped (it shows they announced it, not the terms).
    const ceiling = bothPasses ? 1 : from.length ? Math.max(...from.map((f) => f.confidence), posts.length ? POST_MAX_CONFIDENCE : 0) : POST_MAX_CONFIDENCE;
    const fact: NewFact = {
      subject, claim: claim.slice(0, 2000), type: "found",
      source: { ...(primary.url ? { url: primary.url } : {}), ...(primary.ref ? { ref: primary.ref } : {}), ...(primary.title ? { title: primary.title } : {}) },
      alsoSeenAt: sources.slice(1).filter((s): s is typeof s & { url: string } => !!s.url).map((s) => ({ url: s.url, ...(s.title ? { title: s.title } : {}) })),
      ...datedOf(m.date, from[0]?.date, posts[0]?.date),
      ...identityFieldOf(m, subject.kind),
      confidence: Math.round(Math.min(clamp01(m.confidence), ceiling) * 100) / 100,
      // Care if the merge or either pass said so: kept, and handled with care downstream.
      sensitive: isCare(m) || from.some((f) => f.care),
      careKind: mergedCareKind(m, from),
      topic, sourceType: primary.sourceType,
      status: conflictsWith ? "disputed" : "active",
      disputes: conflictsWith?.id ?? null,
      runId: r.runId,
    };
    // The store's formatting rules, applied here first so one bad source drops one fact, never the whole write.
    try { toInsert.push({ conflictsWith, fact: cleanNewFact(fact) }); } catch (err) { dropped.push({ key: firstKey, reason: String((err as Error).message) }); }
  }
  const inserted = await ctx.store.insertFacts(ctx.athleteId, toInsert.map((t) => t.fact));
  let disputed = 0;
  for (let n = 0; n < inserted.length; n++) {
    const other = toInsert[n].conflictsWith;
    if (!other) continue;
    disputed++;
    // Neither is overwritten. What the athlete said stays active (their account); anything else becomes disputed too.
    if (other.type !== "said" && other.status === "active") {
      await ctx.store.setFactStatus(ctx.athleteId, other.id, "disputed", { disputes: inserted[n].id });
    }
  }
  return {
    runId: r.runId, inserted, disputed, duplicates, dropped, narrative: String(j.narrative ?? ""),
    gaps: [...new Set([...opts.a.gaps, ...opts.b.gaps])], identity: opts.a.identity.resolved ? opts.a.identity : opts.b.identity,
    costMicroUsd: r.cost.microUsd,
  };
}

/** Write measured facts from connected data; a newer reading of the same metric supersedes the older one. */
/** The last number in a measured claim ("… followers: 12,345." → 12345; "1.2K" → 1200; "4.8%" → 4.8), or null. */
export function measuredValueOf(claim: string): number | null {
  const all = [...String(claim ?? "").matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*([KkMm])?(?![\d.])/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * (/k/i.test(m[2]) ? 1e3 : 1e6) : n;
}

/** A metric moved enough to replan: new, or its number changed by ≥ 10% (the plan step's measured-data trigger). */
export function movedEnough(oldClaim: string | null, newClaim: string): boolean {
  if (oldClaim == null) return true;
  const a = measuredValueOf(oldClaim);
  const b = measuredValueOf(newClaim);
  if (a == null || b == null) return false;
  if (a === 0) return b !== 0;
  return Math.abs(b - a) / Math.abs(a) >= 0.1;
}

export async function syncMeasured(store: AgentStore, athleteId: string, measured: NewFact[]): Promise<{ inserted: number; superseded: number; moved?: number }> {
  const current = (await store.listFacts(athleteId, ["active"])).filter((f) => f.type === "measured");
  const byMetric = new Map(current.map((f) => [metricOf(f.source.ref), f]));
  const fresh = measured.filter((m) => {
    const old = byMetric.get(metricOf(m.source.ref));
    return !old || old.claim !== m.claim || old.date !== m.date;
  });
  if (!fresh.length) return { inserted: 0, superseded: 0, moved: 0 };
  // How many metrics are new or moved ≥ 10% (read before the old facts are superseded).
  const moved = fresh.filter((m) => movedEnough(byMetric.get(metricOf(m.source.ref))?.claim ?? null, m.claim)).length;
  const inserted = await store.insertFacts(athleteId, fresh);
  let superseded = 0;
  for (const f of inserted) {
    const old = byMetric.get(metricOf(f.source.ref));
    if (old) { await store.setFactStatus(athleteId, old.id, "superseded", { supersededBy: f.id }); superseded++; }
  }
  return { inserted: inserted.length, superseded, moved };
}

/**
 * Research's IDENTITY verdict, kept in memory (Oct 2026, M.I.A. preview): when neither pass could tell which public
 * person the athlete is, a MADE fact records it as DISPUTED with a source ref ending "#identity". It is the memory
 * signal that holds M.I.A. (the evaluation gate and Home withhold while it stands; miaPreview/memoryAdapter.ts) — the
 * new agent's replacement for athlete_research_state. The athlete settles it in the facts review (confirm, correct or
 * remove). A later run that resolves identity supersedes any open one; a later run that still cannot tell replaces it
 * (its own verdict supersedes the older one, so one stands). Idempotent per research run.
 */
export const IDENTITY_REF_SUFFIX = "#identity";

/** An OPEN identity verdict: a made fact, still active or disputed, whose source ref ends "#identity". The one definition. */
export const isOpenIdentityFact = (f: Pick<MemoryFact, "type" | "status" | "source">): boolean =>
  f.type === "made" && (f.status === "active" || f.status === "disputed") && (f.source.ref ?? "").endsWith(IDENTITY_REF_SUFFIX);

export async function recordIdentityOutcome(
  store: AgentStore,
  athleteId: string,
  o: { runId: string; resolved: boolean; ambiguity: string; athlete: AthleteIdentity },
): Promise<{ written: boolean; superseded: number }> {
  const open = (await store.listFacts(athleteId, ["active", "disputed"])).filter(isOpenIdentityFact);
  const ref = `agent_runs/${o.runId}${IDENTITY_REF_SUFFIX}`;
  if (o.resolved) {
    for (const f of open) await store.setFactStatus(athleteId, f.id, "superseded");
    return { written: false, superseded: open.length };
  }
  if (open.some((f) => f.source.ref === ref)) return { written: false, superseded: 0 };
  const why = o.ambiguity.replace(/\s+/g, " ").trim().slice(0, 600);
  const [fresh] = await store.insertFacts(athleteId, [{
    subject: { kind: "athlete", name: o.athlete.name },
    claim: `Research could not yet confirm which public profile belongs to ${o.athlete.name} (${o.athlete.sport})${why ? `: ${why}` : "."}`,
    type: "made", source: { ref, title: "Nomila research" }, date: new Date().toISOString().slice(0, 10),
    confidence: 0.5, status: "disputed", runId: o.runId,
  }]);
  // A re-check that still cannot tell replaces the older verdict: one open "#identity" fact, never a pile of them.
  if (fresh) for (const f of open) await store.setFactStatus(athleteId, f.id, "superseded", { supersededBy: fresh.id });
  return { written: true, superseded: fresh ? open.length : 0 };
}
