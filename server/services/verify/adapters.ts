/**
 * verify/adapters.ts — the shapes our deliverables come in, as verifyDeliverable's artifacts. Pure.
 *
 *   documentFromDeckHtml   a pitch or public page as the engine renders it (nomiDeck): one section per card, by its
 *                          `k-<kind>` class; every anchor href
 *   documentFromBrandBook  a brand book: one section per chapter, its lines and facts as text
 *   ourHosts               the hosts a document's links may point at: nomila.co and the hosts this server is reached on
 *   answerFromCard         an Answer-with-sources card (agent/milaCards answer_with_sources) as statements + sources
 */
import type { BrandBookData } from "../../../shared/brandBook";
import { apiBaseUrl, publicBaseUrl, webAppUrl } from "../../lib/baseUrls";
import type { AnswerArtifact, DocumentArtifact } from "./deliverable";

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

/** The visible text of an HTML fragment (scripts and styles dropped, tags removed). */
export function visibleText(html: string): string {
  return decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every anchor's href, as written (entity-decoded). Stylesheet <link>s are not links a reader follows. */
export function anchorHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) out.push(decode(m[2] ?? m[3] ?? ""));
  return out;
}

/**
 * A rendered deck (pitch or public page): one section per card kind its `<section class="… k-cover …">` tags open
 * (the public page nests its cards inside an outer <section>, so the tags are read, not paired), plus "page" holding
 * the whole visible text; links by href.
 */
export function documentFromDeckHtml(html: string): DocumentArtifact {
  const kinds = new Set<string>();
  for (const m of html.matchAll(/<section\b[^>]*\bclass\s*=\s*"([^"]*)"/gi)) {
    const kind = /(?:^|\s)k-([a-z0-9_-]+)/i.exec(m[1])?.[1];
    if (kind) kinds.add(kind.toLowerCase());
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return { sections: [...[...kinds].map((id) => ({ id, text: "" })), { id: "page", text: visibleText(body) }], links: anchorHrefs(html) };
}

/** A brand book: one section per chapter (its crafted lines and its facts). Images are bucket paths, not links. */
export function documentFromBrandBook(book: Pick<BrandBookData, "pages">): DocumentArtifact {
  return {
    sections: book.pages.map((p) => ({ id: p.id, text: [p.title, ...Object.values(p.lines ?? {}).map((l) => l.text), ...(p.facts ?? [])].join("\n") })),
    links: [],
  };
}

/** The sections a delivered document must have. A deck always opens on its cover; a brand book always has cover + plan (pagesFor). */
export const REQUIRED_SECTIONS = {
  pitch: ["cover"],
  public_page: ["cover"],
  brand_book: ["cover", "plan"],
} as const;

const hostOf = (u: string | undefined): string | null => {
  if (!u) return null;
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
};

/** Our hosts: nomila.co (and its subdomains), and every base URL this deployment serves pages from. */
export function ourHosts(): string[] {
  const hosts = ["nomila.co", hostOf(apiBaseUrl()), hostOf(publicBaseUrl()), hostOf(webAppUrl()), hostOf(process.env.NOMI_CLAIM_URL)];
  return [...new Set(hosts.filter((h): h is string => !!h))];
}

/**
 * An answer card as the athlete reads it: the headline and line are ONE claim, with every source chip beside it; a
 * list row is a claim of its own, citing its source when it names one and the card's chips when it does not (they sit
 * under the whole card). Stats and tables have no per-row source, so the card's chips are theirs too: nothing to add.
 */
export function answerFromCard(c: {
  headline: string; line: string;
  list?: ReadonlyArray<{ text: string; sourceIx: number | null }> | null;
  sources: ReadonlyArray<{ url: string; label?: string }>;
}): AnswerArtifact {
  const all = c.sources.map((_, i) => i);
  return {
    statements: [
      { text: `${c.headline.trim()} ${c.line.trim()}`.trim(), sourceIx: all },
      ...(c.list ?? []).map((r) => ({ text: r.text, sourceIx: r.sourceIx === null ? all : [r.sourceIx] })),
    ],
    sources: c.sources.map((s) => ({ url: s.url, label: s.label })),
  };
}
