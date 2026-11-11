/**
 * agent/documents/dbSource.ts — the documents port on the app's own services (database, engine, workflow runner). Every
 * statement is scoped to the run's athlete. Reads never start a build: a Nomi Card is read from the cache only
 * (kitCache getCachedKit), so a status question can never start the paid DAG.
 *
 *   brand book    services/brandBook (the brand_books row, read merged with her overrides; chooseLine / writeLine)
 *   public page   the general Nomi Card (media_kits brand 0, card_overrides) + services/publicCard (draft, publish)
 *   pitch         the brand's Nomi Card (media_kits brand N) + services/pitches (shared / opened) + services/kitShare
 *   builds        the document_build workflow (workflow.ts): one run per document at a time, a few a day
 */
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { brandBooks, deals, inboxBrands, inboxThreads, mediaKits, opportunities } from "../../../shared/schema";
import type { BrandBookData } from "../../../shared/brandBook";
import { BRAND_BOOK_CONTRACT } from "../../../shared/brandBook";
import { createLogger } from "../../logger";
import { researchConfirmed } from "../../lib/brandIdentity";
import { signedUrl } from "../../lib/mediaStore";
import { chooseLine, mergedBook } from "../../services/brandBook";
import { pitchGate, swapLine, swapPhoto, writeLine } from "../../services/documents";
import { getCachedKit } from "../../services/kitCache";
import { editableFields } from "../../services/cardOverrides";
import { DOCUMENT_BUILD_PROCESS, DOCUMENT_BUILDS_PER_DAY } from "./config";
import type { DocumentBuildInput } from "./workflow";
import type { BrandLookup, DocBrand, DocChange, DocOverview, DocPage, DocRef, DocSummary, DocumentsSource, Got } from "./source";

const logger = createLogger("agent/documents");
const PUBLIC_BASE = process.env.PUBLIC_CARD_BASE_URL ?? "https://nomila.co";
const PITCHABLE_MAX = 5;

const sign = async (p: unknown): Promise<string | null> => (typeof p === "string" && p ? signedUrl(p).catch(() => null) : null);
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const fail = <T>(error: Exclude<Got<T>, { ok: true }>["error"], detail?: string): Got<T> => ({ ok: false, error, ...(detail ? { detail } : {}) });

/** The build scope of a document (the workflow's one-run-at-a-time key). */
export function scopeOf(ref: DocRef): string {
  return `${DOCUMENT_BUILD_PROCESS}:${ref.kind === "pitch" ? `pitch:${ref.brand.id}` : ref.kind}`;
}

/** The scopes of her builds running now. */
async function buildingScopes(athleteId: string): Promise<Set<string>> {
  const { listRuns } = await import("../../workflow/runner");
  const runs = await listRuns({ athleteId, process: DOCUMENT_BUILD_PROCESS, status: "running", limit: 20 }).catch(() => []);
  return new Set(runs.map((r) => r.active_scope).filter((s): s is string => !!s));
}

// ─── her brands ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Her brands: the brands of her threads, deals, opportunities and pitches (never an agency). */
async function herBrandIds(athleteId: string): Promise<number[]> {
  const [threads, dealRows, opps, kits] = await Promise.all([
    db.selectDistinct({ id: inboxThreads.brand_id }).from(inboxThreads).where(eq(inboxThreads.athlete_id, athleteId)),
    db.selectDistinct({ id: deals.brand_id }).from(deals).where(eq(deals.athlete_id, athleteId)),
    db.selectDistinct({ id: opportunities.brand_id }).from(opportunities).where(eq(opportunities.athlete_id, athleteId)),
    db.select({ id: mediaKits.brand_id }).from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), gt(mediaKits.brand_id, 0))),
  ]);
  return [...new Set([...threads, ...dealRows, ...opps, ...kits].map((r) => r.id).filter((x): x is number => typeof x === "number" && x > 0))];
}

async function brandRows(ids: number[]): Promise<Array<{ id: number; name: string; logoUrl: string | null; enrichment: unknown }>> {
  if (!ids.length) return [];
  return db.select({ id: inboxBrands.id, name: inboxBrands.name, logoUrl: inboxBrands.logo_url, enrichment: inboxBrands.enrichment })
    .from(inboxBrands).where(and(inArray(inboxBrands.id, ids), ne(inboxBrands.is_agency, true)));
}

async function toDocBrand(r: { id: number; name: string; logoUrl: string | null; enrichment: unknown }): Promise<DocBrand> {
  const confirmed = researchConfirmed(r.enrichment);
  // pitchGate also checks there is research to write from (and never spends anything).
  const researched = confirmed ? (await pitchGate(r.id).catch(() => null)) === null : false;
  return { id: r.id, name: r.name, logoUrl: r.logoUrl, confirmed, researched };
}

// ─── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function bookRow(athleteId: string) {
  const [row] = await db.select().from(brandBooks).where(eq(brandBooks.athlete_id, athleteId)).limit(1);
  return row ?? null;
}

async function brandBookSummary(athleteId: string): Promise<DocSummary | null> {
  const row = await bookRow(athleteId);
  const data = row?.data as BrandBookData | null;
  const current = data && data.contract === BRAND_BOOK_CONTRACT ? data : null;
  const state: DocSummary["state"] = !row ? "none" : row.status === "building" ? "building" : current ? "ready" : row.status === "failed" ? "failed" : "none";
  return {
    kind: "brand_book", brand: null, state, updatedAt: iso(row?.generated_at ?? row?.updated_at), thumbUrl: await sign(current?.pages[0]?.images?.[0]),
    shared: null, stale: false, published: null, canPublish: null, blockedReason: null, error: row?.status === "failed" ? row.error ?? null : null,
  };
}

async function kitSummary(athleteId: string, ref: Exclude<DocRef, { kind: "brand_book" }>, building: Set<string>): Promise<DocSummary | null> {
  const brandId = ref.kind === "pitch" ? ref.brand.id : 0;
  const [row] = await db.select({ generatedAt: mediaKits.generated_at }).from(mediaKits)
    .where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, brandId))).limit(1);
  const kit = row ? await getCachedKit(athleteId, { brandId }).catch(() => null) : null;
  const cover = (kit?.cards ?? []).find((c) => c.type === "cover") as { image?: string | null; bg?: string | null } | undefined;
  const state: DocSummary["state"] = building.has(scopeOf(ref)) ? "building" : kit ? "ready" : "none";
  const s: DocSummary = {
    kind: ref.kind, brand: ref.kind === "pitch" ? ref.brand : null, state, updatedAt: iso(row?.generatedAt), thumbUrl: await sign(cover?.image ?? cover?.bg),
    shared: null, stale: false, published: null, canPublish: null, blockedReason: null, error: null,
  };
  if (ref.kind === "pitch" && kit) {
    const { listPitches } = await import("../../services/pitches");
    const p = (await listPitches(athleteId).catch(() => [])).find((x) => x.brandId === brandId);
    if (p) { s.shared = p.status === "sent" || p.status === "opened" ? { opens: p.opensCount } : null; s.stale = p.stale; }
  }
  if (ref.kind === "public_page") {
    const { publicCardEnabled } = await import("../../services/publicCard/flag");
    if (publicCardEnabled()) {
      const { getDraft } = await import("../../services/publicCard/service");
      const d = await getDraft(athleteId).catch(() => null);
      if (d) {
        s.published = d.card.status === "published" ? { version: d.card.publishedVersion } : null;
        s.canPublish = d.canPublish;
        s.blockedReason = d.blockedReason ?? null;
      }
    }
  }
  return s;
}

async function summary(athleteId: string, ref: DocRef, building?: Set<string>): Promise<DocSummary | null> {
  if (ref.kind === "brand_book") return brandBookSummary(athleteId);
  return kitSummary(athleteId, ref, building ?? (await buildingScopes(athleteId)));
}

async function bookPages(athleteId: string): Promise<Got<DocPage[]>> {
  const row = await bookRow(athleteId);
  // The book she sees: her chosen and written lines over the engine's (services/brandBook/overrides.ts).
  const data = mergedBook(row);
  if (!data) return fail(row?.status === "building" ? "building" : "not_built");
  return {
    ok: true,
    value: data.pages.map((p) => ({
      id: p.id, title: p.title, photo: false,
      lines: Object.entries(p.lines).map(([slot, l]) => ({ slot, text: l.text, options: l.options })),
    })),
  };
}

async function kitPages(athleteId: string, ref: Exclude<DocRef, { kind: "brand_book" }>): Promise<Got<DocPage[]>> {
  const brandId = ref.kind === "pitch" ? ref.brand.id : 0;
  const kit = await getCachedKit(athleteId, { brandId });
  if (!kit) return fail("not_built");
  const shown = new Set(kit.deck ?? kit.cards.map((c) => c.id));
  return {
    ok: true,
    value: kit.cards.filter((c) => shown.has(c.id)).map((c) => {
      const card = c as unknown as Record<string, unknown> & { id: string; type: string };
      return {
        id: card.id, title: card.type, photo: !!(card.image || card.bg),
        lines: editableFields(card.type).map((f) => ({
          slot: f.field,
          text: typeof card[f.field] === "string" ? (card[f.field] as string) : "",
          options: kit.copyAlternates?.[card.id]?.[f.slot] ?? [],
        })),
      };
    }),
  };
}

// ─── the port ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const dbDocumentsSource: DocumentsSource = {
  async overview(athleteId): Promise<DocOverview> {
    const building = await buildingScopes(athleteId);
    const [brandBook, publicPage] = await Promise.all([brandBookSummary(athleteId), kitSummary(athleteId, { kind: "public_page" }, building)]);
    const pitches: DocSummary[] = [];
    const pitchable: DocOverview["pitchable"] = [];
    const rows = await brandRows(await herBrandIds(athleteId));
    const kits = new Set((await db.select({ id: mediaKits.brand_id }).from(mediaKits)
      .where(and(eq(mediaKits.athlete_id, athleteId), gt(mediaKits.brand_id, 0)))).map((k) => k.id));
    for (const r of rows.filter((x) => kits.has(x.id) || building.has(`${DOCUMENT_BUILD_PROCESS}:pitch:${x.id}`))) {
      const s = await kitSummary(athleteId, { kind: "pitch", brand: await toDocBrand(r) }, building);
      if (s) pitches.push(s);
    }
    // Brands a pitch could be made for now: confirmed, researched, no pitch yet (a handful, cheapest checks first).
    for (const r of rows.filter((x) => !kits.has(x.id) && researchConfirmed(x.enrichment)).slice(0, PITCHABLE_MAX * 2)) {
      if (pitchable.length >= PITCHABLE_MAX) break;
      if ((await pitchGate(r.id).catch(() => "x")) === null) pitchable.push({ id: r.id, name: r.name });
    }
    const { publicCardEnabled } = await import("../../services/publicCard/flag");
    return { available: { brandBook: true, engine: true, publicPage: publicCardEnabled() }, brandBook, publicPage, pitches, pitchable };
  },

  summary: (athleteId, ref) => summary(athleteId, ref),

  async brand(athleteId, name): Promise<BrandLookup> {
    const rows = await brandRows(await herBrandIds(athleteId));
    const want = norm(name);
    if (!want) return { none: true };
    const exact = rows.filter((r) => norm(r.name) === want);
    const hits = exact.length ? exact : rows.filter((r) => norm(r.name).includes(want) || (want.length >= 4 && want.includes(norm(r.name)) && norm(r.name).length >= 3));
    if (!hits.length) return { none: true };
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.name) };
    return { found: await toDocBrand(hits[0]) };
  },

  pages: (athleteId, ref) => (ref.kind === "brand_book" ? bookPages(athleteId) : kitPages(athleteId, ref)),

  async startBuild(athleteId, ref, p): Promise<Got<{ runId: string; joined: boolean }>> {
    await import("./workflow"); // registers document_build (a no-op once the server has loaded every definition)
    const { listRuns, startRun } = await import("../../workflow/runner");
    const since = Date.now() - 86_400_000;
    const recent = (await listRuns({ athleteId, process: DOCUMENT_BUILD_PROCESS, limit: 50 })).filter((r) => new Date(r.started_at ?? 0).getTime() >= since && r.status !== "failed");
    const input: DocumentBuildInput = {
      kind: ref.kind, brandId: ref.kind === "pitch" ? ref.brand.id : null, brandName: ref.kind === "pitch" ? ref.brand.name.slice(0, 80) : null,
      angles: p.angles.slice(0, 3), askedFrom: p.conversationId ? [p.conversationId] : [],
    };
    // A document already building is joined (startRun returns it), which never counts against the day.
    const running = await buildingScopes(athleteId);
    if (!running.has(scopeOf(ref)) && recent.length >= DOCUMENT_BUILDS_PER_DAY) return fail("daily_limit");
    const { run, created } = await startRun({ process: DOCUMENT_BUILD_PROCESS, athleteId, input, createdBy: "documents:chat", kick: false });
    if (created) {
      void import("../../workflow/runner").then(({ kick }) => kick(run.id))
        .catch((err: any) => logger.warn({ runId: run.id, error: String(err?.message ?? err).slice(0, 200) }, "background kick failed: the tick will run it"));
    }
    return { ok: true, value: { runId: run.id, joined: !created } };
  },

  async edit(athleteId, ref, change: DocChange): Promise<Got<{ text: string | null }>> {
    const doc = ref.kind;
    const brandId = ref.kind === "pitch" ? ref.brand.id : undefined;
    if (change.change === "pick_line") {
      if (doc === "brand_book") return (await chooseLine(athleteId, change.page, change.slot, change.option)) ? { ok: true, value: { text: null } } : fail("not_found", "no such option");
      const r = await swapLine(athleteId, doc, change.page, change.slot, change.option, { brandId });
      return r.ok ? { ok: true, value: { text: null } } : fail(r.code === "feature_off" ? "feature_off" : "not_found", r.message);
    }
    if (change.change === "write_line") {
      const r = await writeLine(athleteId, doc, change.page, change.slot, change.text, { brandId });
      return r.ok ? { ok: true, value: { text: change.text } } : fail(r.code === "bad_input" ? "bad_input" : r.code === "feature_off" ? "feature_off" : "not_found", r.message);
    }
    if (doc === "brand_book") return fail("bad_input", "the brand book's photos are chosen with the book");
    const r = await swapPhoto(athleteId, doc, change.page, "next", { brandId });
    return r.ok ? { ok: true, value: { text: null } } : fail("not_found", r.message);
  },

  async sharePitch(athleteId, brand): Promise<Got<{ url: string }>> {
    if (!(await getCachedKit(athleteId, { brandId: brand.id }))) return fail("not_built");
    const { createShare } = await import("../../services/kitShare");
    const s = await createShare(athleteId, { mode: "live", tailoring: "brand", brandId: brand.id, scope: "public", label: "Shared from Mila" });
    return { ok: true, value: { url: s.url } };
  },

  async publishPage(athleteId): Promise<Got<{ url: string | null; version: number }>> {
    const { publicCardEnabled } = await import("../../services/publicCard/flag");
    if (!publicCardEnabled()) return fail("feature_off", "publishing the public page isn't switched on here");
    const { publishDraft } = await import("../../services/publicCard/service");
    try {
      const r = await publishDraft(athleteId, null);
      return { ok: true, value: { version: r.version, url: r.handle ? `${PUBLIC_BASE}/p/${r.handle}` : null } };
    } catch (err: any) {
      return fail("blocked", String(err?.message ?? "the page can't be published yet").slice(0, 200));
    }
  },
};
