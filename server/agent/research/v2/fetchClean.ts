/**
 * agent/research/v2/fetchClean.ts — the FETCH + CLEAN step: our server reads each chosen page itself and keeps only
 * its article text. Adopted, not built, and selectable (RESEARCH_V2_CLEANER, compared on dev before choosing):
 *   - "readability": Mozilla Readability (Apache-2.0, the engine behind Firefox Reader View);
 *   - "defuddle": Defuddle (MIT, the Obsidian Web Clipper's extractor) — keeps table rows readable and reads the page's
 *     schema.org data (Person / SportsTeam), which becomes an identity hint for the rank step.
 * Both run on a linkedom document (ISC). No browser: a page that needs JavaScript to show its text comes back too
 * short and is flagged `script_only` (skipped, never guessed at).
 *
 * Polite by default: robots.txt is read once per host and a Disallow for our agent (or *) skips the page; every fetch
 * has a timeout and a size cap; only HTML is read.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import Defuddle from "defuddle";
import { V2, type CleanerId } from "./config";

export interface CleanPage {
  url: string;
  title: string;
  text: string;
  /** published / modified date when the page states one (meta tags). */
  date: string | null;
  /** schema.org Person data on the page (Defuddle only): who the page says it is about, and the sport/team strings
   *  its structured data gives. An identity hint for the rank step; never a fact by itself. */
  identityHint?: IdentityHint | null;
  /** Same-site links on the page (absolute URL + link text), read from the whole page before cleaning. The pipeline
   *  follows a few that lead to the athlete's own roster / bio / stats pages (pickFollowLinks). */
  links?: PageLink[];
}

export interface IdentityHint { names: string[]; affiliations: string[] }
export interface PageLink { url: string; text: string }

const MAX_LINKS = 500;

/** Same-site http(s) links on a page, absolute, without fragments, de-duplicated. */
export function sameSiteLinks(document: any, pageUrl: string): PageLink[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]") ?? []) as any[]) {
    let u: URL;
    try { u = new URL(String(a.getAttribute("href")), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key) || key === base.toString()) continue;
    seen.add(key);
    out.push({ url: key, text: String(a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120) });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

export type SkipReason = "robots" | "not_html" | "http_error" | "timeout" | "script_only" | "too_large" | "error";
export interface FetchOutcome { page: CleanPage | null; skipped: SkipReason | null; url: string; ms: number }

/** Pure: is `path` allowed for our agent by this robots.txt? (Longest matching rule wins; Allow beats Disallow on ties.) */
export function robotsAllows(robotsTxt: string, path: string, agent: string = V2.userAgent): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (val) cur.rules.push({ allow: key === "allow", path: val });
    } else lastWasAgent = false;
  }
  const token = agent.toLowerCase().split("/")[0];
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    const pattern = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (!pattern.test(path)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/** Pure: an HTML string → its article title, text and stated date, or null when there's no article. */
export function cleanHtml(html: string, url: string, cleaner: CleanerId = "readability"): CleanPage | null {
  return cleaner === "defuddle" ? cleanWithDefuddle(html, url) : cleanWithReadability(html, url);
}

function statedDate(document: any): string | null {
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") ?? null;
  const date = meta('meta[property="article:published_time"]') ?? meta('meta[name="date"]') ?? meta('meta[property="article:modified_time"]');
  return date ? String(date).slice(0, 10) : null;
}

const tidy = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

function cleanWithReadability(html: string, url: string): CleanPage | null {
  const { document } = parseHTML(html);
  const date = statedDate(document);
  // Readability edits the document it parses, so the links are read first.
  const links = sameSiteLinks(document, url);
  let article: { title?: string | null; textContent?: string | null } | null = null;
  try { article = new Readability(document as unknown as Document).parse(); } catch { article = null; }
  const text = tidy(article?.textContent ?? "");
  if (!text) return null;
  return { url, title: (article?.title ?? document.title ?? "").trim(), text, date, links };
}

/** Defuddle's main-content HTML → plain text that keeps the shape: one block per paragraph or heading, table rows as
 *  "cell | cell | cell" (stats tables and rosters stay readable rows instead of one run-on string). */
export function htmlToText(contentHtml: string): string {
  // No closing tags written by hand (the prompt-wrapper guard in externalContent.test.ts); the parser closes them.
  const { document } = parseHTML(`<!doctype html><html><body>${contentHtml}`);
  const lines: string[] = [];
  const walk = (el: any) => {
    for (const node of Array.from(el.childNodes ?? []) as any[]) {
      if (node.nodeType !== 1) continue;
      const tag = String(node.tagName ?? "").toLowerCase();
      if (tag === "tr") {
        const cells = (Array.from(node.querySelectorAll("th,td")) as any[]).map((c) => String(c.textContent ?? "").replace(/\s+/g, " ").trim());
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      } else if (/^(p|h[1-6]|li|blockquote|figcaption|dt|dd|pre)$/.test(tag)) {
        const t = String(node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) lines.push(t);
      } else walk(node);
    }
  };
  walk(document.body);
  return tidy(lines.join("\n\n"));
}

/** schema.org Person entries → the names and the sport/team strings they carry (affiliation, memberOf, sport). */
export function identityHintOf(schemaOrgData: unknown): IdentityHint | null {
  const names: string[] = [];
  const affiliations: string[] = [];
  const typeOf = (o: any) => ([] as unknown[]).concat(o?.["@type"] ?? []).map((t) => String(t).toLowerCase());
  const pushText = (v: unknown) => {
    for (const x of ([] as any[]).concat(v ?? [])) {
      if (typeof x === "string") affiliations.push(x);
      else if (x && typeof x === "object") { if (x.name) affiliations.push(String(x.name)); if (x.sport) pushText(x.sport); }
    }
  };
  const visit = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (o["@graph"]) visit(o["@graph"]);
    if (typeOf(o).includes("person")) {
      if (o.name) names.push(String(o.name));
      pushText(o.affiliation); pushText(o.memberOf); pushText(o.sport);
    }
  };
  visit(schemaOrgData);
  return names.length ? { names, affiliations } : null;
}

function cleanWithDefuddle(html: string, url: string): CleanPage | null {
  const { document } = parseHTML(html);
  const date = statedDate(document);
  const links = sameSiteLinks(document, url);
  let out: { title?: string; content?: string; schemaOrgData?: unknown; published?: string } | null = null;
  try { out = new (Defuddle as any)(document, { url }).parse(); } catch { out = null; }
  const text = out?.content ? htmlToText(out.content) : "";
  if (!text) return null;
  const published = date ?? (out?.published ? String(out.published).slice(0, 10) : null);
  return { url, title: (out?.title ?? document.title ?? "").trim(), text, date: published, identityHint: identityHintOf(out?.schemaOrgData), links };
}

async function readCapped(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/** Fetches pages (in parallel, a few at a time) and cleans them. Injectable fetch so tests never reach the network. */
export async function fetchAndClean(urls: string[], fetchImpl: typeof fetch = fetch, opts: { concurrency?: number; cleaner?: CleanerId } = {}): Promise<FetchOutcome[]> {
  const robotsByHost = new Map<string, Promise<string>>();
  const robotsFor = (u: URL) => {
    const key = `${u.protocol}//${u.host}`;
    if (!robotsByHost.has(key)) {
      robotsByHost.set(key, fetchImpl(`${key}/robots.txt`, { headers: { "user-agent": V2.userAgent }, signal: AbortSignal.timeout(4_000) })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => ""));
    }
    return robotsByHost.get(key)!;
  };
  const one = async (url: string): Promise<FetchOutcome> => {
    const t0 = Date.now();
    const done = (page: CleanPage | null, skipped: SkipReason | null): FetchOutcome => ({ page, skipped, url, ms: Date.now() - t0 });
    let parsed: URL;
    try { parsed = new URL(url); } catch { return done(null, "error"); }
    if (!robotsAllows(await robotsFor(parsed), parsed.pathname + parsed.search)) return done(null, "robots");
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": V2.userAgent, accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(V2.fetchTimeoutMs) });
      if (!res.ok) return done(null, "http_error");
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html/i.test(type)) return done(null, "not_html");
      const html = await readCapped(res, V2.maxPageBytes);
      if (html === null) return done(null, "too_large");
      const page = cleanHtml(html, res.url || url, opts.cleaner);
      if (!page || page.text.length < V2.minCleanChars) return done(null, "script_only");
      return done(page, null);
    } catch (err: any) {
      return done(null, err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "error");
    }
  };
  const out: FetchOutcome[] = new Array(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 4, urls.length) }, async () => {
    while (next < urls.length) { const i = next++; out[i] = await one(urls[i]); }
  });
  await Promise.all(workers);
  return out;
}
