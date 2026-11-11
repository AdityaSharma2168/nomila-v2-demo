/**
 * agent/research/v2/rank.ts — the RANK + FILTER step (code, no model): cleaned pages → the passages about THIS
 * athlete, best first, within a character budget. This is where most of the "web sludge" never reaches the model.
 *
 *   0. The athlete's own pages (anchored, and their title, URL or structured data names them: a roster, bio or profile
 *      page) are sent WHOLE (up to V2.wholePageChars each, V2.wholePagesShare of the budget), most authoritative first —
 *      their stats and honours rows never repeat the name, so name-only passages lost them. Everything below applies
 *      to the other pages (match reports, lists, roundups that mention the athlete among others).
 *   1. Split each page into passages of a few paragraphs (~V2.passageChars).
 *   2. Keep a passage only if it names the athlete (full name, or surname next to a first-name initial).
 *   3. Judge each page's identity (pageIdentity): anchored pages are kept; pages tying the name to another sport are
 *      wrong-person rejections; pages that say nothing either way are read only beside an anchored page, labelled.
 *   4. Score with BM25 against the anchors (name, sport, team) and a small bonus for authoritative sites; keep the best
 *      V2.maxPassages within V2.maxPassageChars, at most a few per page so no single page crowds out the rest.
 */
import { V2 } from "./config";
import type { CleanPage } from "./fetchClean";
import { distinctiveTeamWords, otherSportTermsOf, sportTermsOf, termMatcher } from "./sportTerms";

export interface Passage {
  /** S1, S2 … in the order given to the extract model. */
  id: string;
  url: string;
  title: string;
  date: string | null;
  text: string;
  score: number;
  /** The page names the athlete but does not itself show it is them (a "neutral" page, read beside anchored ones). */
  unverified?: boolean;
}

export interface RankResult {
  passages: Passage[];
  /** Pages dropped as probably about someone else with the same name. */
  wrongPerson: Array<{ url: string; reason: string }>;
  /** Pages with no passage naming the athlete. */
  unrelated: number;
  chars: number;
  /** Pages that name the athlete but say nothing about identity either way (kept only beside an anchored page). */
  neutralPages: number;
  /** Pages that show this is the athlete (sport, team or handle in structured data, URL, title or near the name). */
  anchoredPages: number;
  /** The athlete's own pages sent whole (isAthletePage), not as passages. */
  wholePages: number;
}

const tokens = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1);

export function namesAthlete(text: string, name: string): boolean {
  const t = text.toLowerCase();
  const n = name.toLowerCase().trim();
  if (!n) return false;
  // Whole words only: "First Last" must not match inside "First Lastname" (another person's page).
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t)) return true;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  const initial = parts[0][0];
  return new RegExp(`\\b${initial}\\.?\\s+${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
}

/** Sign-up (strict): how close to a mention of the name the sport, team or handle must appear. */
const STRICT_NEAR_CHARS = 600;
/** How close to the name another sport must be named for the page to count as about someone else. */
const CONFLICT_NEAR_CHARS = 250;

export interface IdentityAthlete { name: string; sport: string; team?: string | null; handles?: string[] }

/**
 * anchored — the page ties this name to the athlete's sport, team or handle (in its structured data, its URL or
 *            title, or — at sign-up — near the name in its text).
 * other    — the page ties this name to ANOTHER sport and never to theirs: someone else with the same name (rejected).
 * neutral  — neither: the page names the athlete but says nothing either way (a roster or NIL profile without the sport
 *            word, a long roundup where the sport is named far away). Kept only when another page anchors the
 *            athlete, and labelled for the extract model as "this page does not itself show it is them".
 */
export type PageIdentity = { verdict: "anchored" | "neutral"; via: string } | { verdict: "other"; reason: string };

/** Pure: the identity anchors for this athlete — their sport's words, the distinctive words of their team, handles. */
export function anchorsOf(a: IdentityAthlete): { own: RegExp | null; other: RegExp | null; words: string[] } {
  const words = [...sportTermsOf(a.sport), ...distinctiveTeamWords(a.team), ...(a.team ? [a.team.toLowerCase().trim()] : []),
    ...(a.handles ?? []).map((h) => h.toLowerCase().replace(/^@/, "").trim())].filter((x) => x.length > 1);
  return { own: termMatcher(words), other: termMatcher(otherSportTermsOf(a.sport)), words };
}

/** A URL read as words: host and path separators become spaces ("example.com/news/girls-varsity-final" → "example com news girls varsity final"). */
const urlWords = (u: string) => { try { const x = new URL(u); return `${x.hostname} ${decodeURIComponent(x.pathname)}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "); } catch { return u.toLowerCase(); } };

/**
 * Pure: is this page (which names the athlete) about THIS athlete? Generic and record-driven: compares only against
 * the athlete's own sport, team and handles, plus generic sport vocabulary (sportTerms.ts).
 *   1. Structured data (Defuddle's schema.org Person with this name): their sport or team → anchored; another sport
 *      only → other. Team names alone never say "other" (athletes change teams).
 *   2. URL and title: their sport, team word or handle → anchored. A host like "go<team>.com" counts, because the
 *      distinctive team word is matched inside the host.
 *   3. Text: their anchor near the name (strict) or anywhere (refresh) → anchored; another sport near the name and
 *      none of theirs → other; otherwise neutral.
 */
export function pageIdentity(page: Pick<CleanPage, "url" | "title" | "text" | "identityHint">, a: IdentityAthlete, opts: { strict?: boolean } = {}): PageIdentity {
  const { own, other, words } = anchorsOf(a);
  if (!own) return { verdict: "anchored", via: "no anchors to check" };
  const hint = page.identityHint;
  if (hint && hint.names.some((n) => namesAthlete(n, a.name)) && hint.affiliations.length) {
    const strings = hint.affiliations.join(" | ").toLowerCase();
    if (own.test(strings)) return { verdict: "anchored", via: "structured data" };
    const o = other?.exec(strings);
    if (o) return { verdict: "other", reason: `the page's structured data ties this name to ${o[0]}, not ${a.sport}` };
  }
  const host = (() => { try { return new URL(page.url).hostname.toLowerCase(); } catch { return ""; } })();
  if (own.test(urlWords(page.url)) || own.test((page.title ?? "").toLowerCase()) || distinctiveTeamWords(a.team).some((w) => host.includes(w))) {
    return { verdict: "anchored", via: "url or title" };
  }
  const t = page.text.toLowerCase();
  const spans = nameMentions(t, a.name);
  const window = (near: number) => spans.map((i) => t.slice(Math.max(0, i - near), i + a.name.length + near));
  const nearOwn = window(STRICT_NEAR_CHARS).some((w) => own.test(w));
  if (nearOwn || (!opts.strict && own.test(t))) return { verdict: "anchored", via: "text" };
  const conflict = window(CONFLICT_NEAR_CHARS).map((w) => other?.exec(w)?.[0]).find(Boolean);
  if (conflict) return { verdict: "other", reason: `the page ties this name to ${conflict}, never to ${words.slice(0, 3).join(" / ")}` };
  return { verdict: "neutral", via: own.test(t) ? "anchor named far from the name" : "no anchor on the page" };
}

/** Character offsets where the name (full, or initial + surname) is mentioned in lower-cased text. */
function nameMentions(t: string, name: string): number[] {
  const n = name.toLowerCase().trim();
  const parts = n.split(/\s+/);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = parts.length >= 2 ? new RegExp(`${esc(n)}|\\b${esc(parts[0][0])}\\.?\\s+${esc(parts[parts.length - 1])}\\b`, "g") : new RegExp(esc(n), "g");
  return [...t.matchAll(re)].map((m) => m.index ?? 0);
}

/** Pure: does this URL's PATH name the athlete (every part of the name among its words — "…/player/first-last")?
 *  The host is ignored: a site's own name sharing a word with the athlete's says nothing about the page. */
export function urlNamesAthlete(url: string, name: string): boolean {
  let path: string;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return false; }
  const words = new Set(path.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/));
  const parts = tokens(name);
  return parts.length > 0 && parts.every((p) => words.has(p));
}

/**
 * Pure: is this page ABOUT the athlete — their own roster, bio or profile page, or an article headed with their name —
 * rather than a page that mentions them among others? Its title, URL or structured data names them. Such pages (when
 * also anchored) are read whole: they name the athlete once, then list stats and honours in rows that never repeat it.
 */
export function isAthletePage(page: Pick<CleanPage, "url" | "title" | "identityHint">, name: string): boolean {
  return namesAthlete(page.title ?? "", name) || urlNamesAthlete(page.url, name) || !!page.identityHint?.names.some((n) => namesAthlete(n, name));
}

const FILE_OR_SOCIAL = /\.(pdf|jpg|jpeg|png|gif|webp|mp4|mp3|zip|ics|xml|json)(\?|$)|\b(facebook|instagram|tiktok|x|twitter|linkedin|pinterest)\.com\//i;

/**
 * Pure: from the athlete's own pages (anchored and about them), the same-site links worth fetching ourselves instead of
 * paying for more searches — links whose URL or text names the athlete (their roster, bio, stats or career pages; a
 * roster's link to their player page). Not already fetched, no files or social networks, at most `max`, pages from more
 * authoritative sites first. Generic: no site, school or league is named anywhere.
 */
export function pickFollowLinks(
  pages: Array<Pick<CleanPage, "url" | "title" | "identityHint" | "links"> & { quality?: number; anchored: boolean }>,
  name: string,
  already: Iterable<string>,
  max: number = V2.maxFollow,
): string[] {
  const key = (u: string) => { try { const x = new URL(u); x.hash = ""; return x.toString().replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/, ""); } catch { return u; } };
  const seen = new Set([...already].map(key));
  const out: string[] = [];
  const sources = pages.filter((p) => p.anchored && isAthletePage(p, name)).sort((a, b) => (b.quality ?? 1) - (a.quality ?? 1));
  for (const p of sources) {
    for (const l of p.links ?? []) {
      if (out.length >= max) return out;
      if (FILE_OR_SOCIAL.test(l.url) || seen.has(key(l.url))) continue;
      if (!urlNamesAthlete(l.url, name) && !namesAthlete(l.text, name)) continue;
      seen.add(key(l.url));
      out.push(l.url);
    }
  }
  return out;
}

export function splitPassages(text: string, size: number = V2.passageChars): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out;
}

function bm25(docs: string[][], query: string[]): number[] {
  const N = docs.length || 1;
  const avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of query) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
}

export function rankPassages(
  pages: Array<CleanPage & { quality?: number }>,
  athlete: IdentityAthlete,
  opts: { perPage?: number; strict?: boolean } = {},
): RankResult {
  const wrongPerson: RankResult["wrongPerson"] = [];
  let unrelated = 0;
  const candidates: Array<Omit<Passage, "id" | "score"> & { quality: number; tok: string[] }> = [];
  const neutral: typeof candidates = [];
  let anchoredPages = 0;
  const passages: Passage[] = [];
  const wholeUrls = new Set<string>();
  let chars = 0;
  const push = (c: { url: string; title: string; date: string | null; text: string; unverified?: boolean }, score: number) => {
    chars += c.text.length;
    passages.push({ id: `S${passages.length + 1}`, url: c.url, title: c.title, date: c.date, text: c.text, score: Math.round(score * 100) / 100, ...(c.unverified ? { unverified: true } : {}) });
  };
  // The athlete's own pages first, WHOLE (most authoritative site first), within their share of the budget; a page
  // that no longer fits falls back to its passages below.
  const wholeBudget = Math.floor(V2.maxPassageChars * V2.wholePagesShare);
  const judged = pages.map((page) => ({ page, named: namesAthlete(page.text, athlete.name), id: pageIdentity(page, athlete, { strict: opts.strict }) }));
  for (const { page, named, id } of [...judged].sort((a, b) => (b.page.quality ?? 1) - (a.page.quality ?? 1))) {
    if (!named || id.verdict !== "anchored" || !isAthletePage(page, athlete.name) || passages.length >= V2.maxPassages) continue;
    const text = page.text.slice(0, V2.wholePageChars);
    if (chars + text.length > wholeBudget) continue;
    wholeUrls.add(page.url);
    push({ url: page.url, title: page.title, date: page.date, text }, 100);
  }
  for (const { page, named, id } of judged) {
    if (!named) { unrelated++; continue; }
    if (id.verdict === "other") { wrongPerson.push({ url: page.url, reason: id.reason }); continue; }
    if (id.verdict === "anchored") anchoredPages++;
    if (wholeUrls.has(page.url)) continue;
    for (const text of splitPassages(page.text)) {
      if (!namesAthlete(text, athlete.name)) continue;
      (id.verdict === "anchored" ? candidates : neutral).push({ url: page.url, title: page.title, date: page.date, text, quality: page.quality ?? 1, tok: tokens(text), unverified: id.verdict === "neutral" });
    }
  }
  // A page that says nothing either way is read only beside a page that does show who the athlete is.
  const neutralPages = new Set(neutral.map((c) => c.url)).size;
  if (anchoredPages) candidates.push(...neutral);
  const query = tokens([athlete.name, athlete.sport, athlete.team ?? ""].join(" "));
  const scores = bm25(candidates.map((c) => c.tok), query);
  const ranked = candidates.map((c, i) => ({ c, score: scores[i] + 0.5 * (c.quality - 1) - (c.unverified ? 1 : 0) })).sort((a, b) => b.score - a.score);
  const perPage = opts.perPage ?? 3;
  const usedPerPage = new Map<string, number>();
  for (const { c, score } of ranked) {
    if (passages.length >= V2.maxPassages) break;
    if ((usedPerPage.get(c.url) ?? 0) >= perPage) continue;
    if (chars + c.text.length > V2.maxPassageChars) continue;
    usedPerPage.set(c.url, (usedPerPage.get(c.url) ?? 0) + 1);
    push(c, score);
  }
  return { passages, wrongPerson, unrelated, chars, neutralPages, anchoredPages, wholePages: wholeUrls.size };
}
