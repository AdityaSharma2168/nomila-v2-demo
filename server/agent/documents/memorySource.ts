/**
 * agent/documents/memorySource.ts — the documents port in memory, for unit tests (documents/tools.test.ts). Made-up
 * brands and documents only; never a database, an engine or a model. What the
 * tools did is kept on the source (builds, edits, shares, publishes) so a test can read it back.
 */
import type { DocumentState } from "../../../shared/agent";
import type { BrandLookup, DocBrand, DocChange, DocPage, DocRef, DocSummary, DocumentsSource, Got } from "./source";

export interface MemoryDocBrand { key: string; name: string; confirmed?: boolean; researched?: boolean }
export interface MemoryDoc { state?: DocumentState; updatedAt?: string; pages?: DocPage[] }
export interface MemoryDocsFixture {
  brands: MemoryDocBrand[];
  /** Absent: switched off here. null: switched on, not made yet. */
  brandBook?: MemoryDoc | null;
  publicPage?: (MemoryDoc & { published?: boolean; version?: number; canPublish?: boolean; blockedReason?: string }) | null;
  pitches?: Array<MemoryDoc & { brand: string; opens?: number | null; stale?: boolean }>;
  /** The engine (public page and pitches) is switched off. */
  engineOff?: boolean;
}

export interface MemoryDocumentsSource extends DocumentsSource {
  builds: Array<{ ref: DocRef; angles: string[]; conversationId: string | null; runId: string }>;
  edits: Array<{ ref: DocRef; change: DocChange }>;
  shares: Array<{ brandId: number; url: string }>;
  publishes: number[];
}

/** A made-up brand's id, from its fixture key (stable across a case). */
export const memoryBrandId = (keys: string[], key: string): number => 1001 + Math.max(0, keys.indexOf(key));

const DEFAULT_KIT_PAGES = (): DocPage[] => [
  { id: "cover", title: "cover", photo: true, lines: [
    { slot: "eyebrow", text: "Athlete · creator", options: ["Athlete · creator", "On and off the field"] },
    { slot: "hook", text: "Built for the long run.", options: ["Built for the long run.", "Every season, the same standard.", "Proof over promises."] },
  ] },
  { id: "story", title: "story", photo: false, lines: [{ slot: "close", text: "The next chapter starts here.", options: ["The next chapter starts here."] }] },
];
const DEFAULT_BOOK_PAGES = (): DocPage[] => [
  { id: "cover", title: "Your brand", photo: false, lines: [{ slot: "line", text: "You make hard work look like joy.", options: ["You make hard work look like joy.", "Your effort is the story."] }] },
  { id: "close", title: "That's your brand", photo: false, lines: [{ slot: "line", text: "Go be exactly this.", options: ["Go be exactly this."] }] },
];

export function createMemoryDocumentsSource(f: MemoryDocsFixture): MemoryDocumentsSource {
  const keys = f.brands.map((b) => b.key);
  const brands: DocBrand[] = f.brands.map((b) => ({ id: memoryBrandId(keys, b.key), name: b.name, logoUrl: null, confirmed: b.confirmed ?? true, researched: b.researched ?? b.confirmed ?? true }));
  const byKey = new Map(f.brands.map((b, i) => [b.key, brands[i]]));
  const book = f.brandBook === undefined ? undefined : f.brandBook ? { state: f.brandBook.state ?? "ready", updatedAt: f.brandBook.updatedAt ?? null, pages: f.brandBook.pages ?? DEFAULT_BOOK_PAGES() } : null;
  const page = f.engineOff || f.publicPage === undefined ? undefined : f.publicPage
    ? { ...f.publicPage, state: f.publicPage.state ?? "ready", updatedAt: f.publicPage.updatedAt ?? null, pages: f.publicPage.pages ?? DEFAULT_KIT_PAGES() } : null;
  const pitches = new Map<number, { state: DocumentState; updatedAt: string | null; pages: DocPage[]; opens: number | null; stale: boolean }>();
  for (const p of f.engineOff ? [] : f.pitches ?? []) {
    const b = byKey.get(p.brand);
    if (b) pitches.set(b.id, { state: p.state ?? "ready", updatedAt: p.updatedAt ?? null, pages: p.pages ?? DEFAULT_KIT_PAGES(), opens: p.opens ?? null, stale: p.stale ?? false });
  }
  const running = new Map<string, string>();
  const scope = (ref: DocRef) => (ref.kind === "pitch" ? `pitch:${ref.brand.id}` : ref.kind);
  const fail = <T>(error: Exclude<Got<T>, { ok: true }>["error"], detail?: string): Got<T> => ({ ok: false, error, ...(detail ? { detail } : {}) });

  const summaryOf = (ref: DocRef): DocSummary | null => {
    const blank = { thumbUrl: null, shared: null, stale: false, published: null, canPublish: null, blockedReason: null, error: null };
    if (ref.kind === "brand_book") {
      if (book === undefined) return null;
      return { ...blank, kind: "brand_book", brand: null, state: running.has("brand_book") ? "building" : book?.state ?? "none", updatedAt: book?.updatedAt ?? null };
    }
    if (ref.kind === "public_page") {
      if (page === undefined) return null;
      return {
        ...blank, kind: "public_page", brand: null, state: running.has("public_page") ? "building" : page?.state ?? "none", updatedAt: page?.updatedAt ?? null,
        published: page?.published ? { version: page.version ?? 1 } : null, canPublish: page ? page.canPublish ?? true : null, blockedReason: page?.blockedReason ?? null,
      };
    }
    if (f.engineOff) return null;
    const p = pitches.get(ref.brand.id);
    return {
      ...blank, kind: "pitch", brand: ref.brand, state: running.has(scope(ref)) ? "building" : p?.state ?? "none", updatedAt: p?.updatedAt ?? null,
      shared: p?.opens != null ? { opens: p.opens } : null, stale: p?.stale ?? false,
    };
  };
  const pagesOf = (ref: DocRef): DocPage[] | null => (ref.kind === "brand_book" ? book?.pages ?? null : ref.kind === "public_page" ? page?.pages ?? null : pitches.get(ref.brand.id)?.pages ?? null);

  const src: MemoryDocumentsSource = {
    builds: [], edits: [], shares: [], publishes: [],
    async overview() {
      return {
        available: { brandBook: book !== undefined, engine: !f.engineOff, publicPage: page !== undefined },
        brandBook: summaryOf({ kind: "brand_book" }),
        publicPage: summaryOf({ kind: "public_page" }),
        pitches: brands.filter((b) => pitches.has(b.id) || running.has(`pitch:${b.id}`)).map((b) => summaryOf({ kind: "pitch", brand: b })!).filter(Boolean),
        pitchable: f.engineOff ? [] : brands.filter((b) => b.confirmed && b.researched && !pitches.has(b.id)).slice(0, 5).map((b) => ({ id: b.id, name: b.name })),
      };
    },
    async summary(_a, ref) { return summaryOf(ref); },
    async brand(_a, name): Promise<BrandLookup> {
      const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const exact = brands.filter((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, "") === n);
      const hits = exact.length ? exact : brands.filter((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(n));
      if (!n || !hits.length) return { none: true };
      return hits.length > 1 ? { ambiguous: hits.map((h) => h.name) } : { found: hits[0] };
    },
    async pages(_a, ref) {
      const s = summaryOf(ref);
      if (!s) return fail("feature_off");
      if (s.state === "building" && !pagesOf(ref)) return fail("building");
      const p = s.state === "none" ? null : pagesOf(ref);
      return p ? { ok: true, value: p } : fail("not_built");
    },
    async startBuild(_a, ref, p) {
      if (!summaryOf(ref)) return fail("feature_off");
      const k = scope(ref);
      const joined = running.has(k);
      const runId = running.get(k) ?? `memrun-${src.builds.length + 1}`;
      running.set(k, runId);
      src.builds.push({ ref, angles: p.angles, conversationId: p.conversationId, runId });
      return { ok: true, value: { runId, joined } };
    },
    async edit(_a, ref, change) {
      const pages = pagesOf(ref);
      const pg = pages?.find((x) => x.id === change.page);
      if (!pg) return fail("not_found");
      src.edits.push({ ref, change });
      if (change.change === "next_photo") return { ok: true, value: { text: null } };
      const line = pg.lines.find((l) => l.slot === change.slot);
      if (!line) return fail("not_found");
      if (change.change === "pick_line") { line.text = line.options[change.option] ?? line.text; return { ok: true, value: { text: line.text } }; }
      line.text = change.text;
      if (!line.options.includes(change.text)) line.options.push(change.text);
      return { ok: true, value: { text: change.text } };
    },
    async sharePitch(_a, brand) {
      if (!pitches.has(brand.id)) return fail("not_built");
      const url = `https://nomila.example/c/mem${brand.id}`;
      src.shares.push({ brandId: brand.id, url });
      const p = pitches.get(brand.id)!;
      p.opens = p.opens ?? 0;
      return { ok: true, value: { url } };
    },
    async publishPage() {
      if (!page) return fail("feature_off");
      if (page.canPublish === false) return fail("blocked", page.blockedReason ?? "the page isn't ready to publish");
      page.version = (page.version ?? 0) + 1;
      page.published = true;
      src.publishes.push(page.version);
      return { ok: true, value: { url: "https://nomila.example/p/athlete", version: page.version } };
    },
  };
  return src;
}
