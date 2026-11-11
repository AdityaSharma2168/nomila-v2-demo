/**
 * documents — the athlete's three documents (brand book, pitch, public page) as plain service functions with typed
 * inputs and outputs, so the app's routes AND a Mila chat tool can call the same thing (22 Oct 2026). Nothing here is
 * reachable only through a route handler or the client. Every failure is a typed, actionable error, never a throw for
 * an expected state.
 *
 *   getDocument(athleteId, kind, opts)           the document as the athlete would see it (status + data, or HTML)
 *   createPitch(athleteId, brandId, focus?)      build (or rebuild) the pitch tailored to one confirmed brand
 *   rebuildPage(athleteId, doc, page)            rewrite one page / card (brand book page or Nomi Card card)
 *   swapLine(athleteId, doc, page, slot, pick)   another stored option (index, $0) or an instruction (queued for Mila)
 *   swapPhoto(athleteId, doc, slot, assetId|"next")  her photo of choice, or the next-best ranked one
 *   previewPublicPage(athleteId, opts)           the public page in the engine's craft, owner-only preview HTML
 *   writeLine(athleteId, doc, page, slot, text)  her own words for one line (Mila wrote them in the chat), $0, no model
 *   buildDocument(athleteId, doc, opts)          build or rebuild one whole document NOW (awaited): the documents
 *                                                workflow's build step (Mila in the chat); the app keeps its own routes
 *   pitchGate(brandId)                           why a pitch can't be written for a brand yet, or null
 *   verifyBuiltDocument(athleteId, doc, opts)    check before deliver (services/verify): the document as she would see
 *                                                it has its required sections, no placeholder tokens, and only links a
 *                                                reader of hers should follow (ours, her accounts, her facts' pages, a
 *                                                profile on a well-known platform)
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { inboxBrands, mediaAssets } from "../../../shared/schema";
import { researchConfirmed } from "../../lib/brandIdentity";
import { chooseLine, readBrandBook, startBrandBook, completeBrandBook, markBrandBookBuilding, writeLine as writeBookLine } from "../brandBook";
import { getOrBuildKit, buildAndCacheKit } from "../kitCache";
import { getOverrides, saveOverrides, editableFields } from "../cardOverrides";
import { loadBrandResearch, parseFocus } from "../pitchConcept";
import { isTheAthlete } from "../../lib/visionTag";
import { renderNomiForWeb } from "../nomiDeck";
import { verifyDeliverable, type VerifyResult } from "../verify/deliverable";
import { documentFromBrandBook, documentFromDeckHtml, ourHosts, REQUIRED_SECTIONS } from "../verify/adapters";
import { loadHerLinks } from "../verify/herLinks";
import { createLogger } from "../../logger";

const logger = createLogger("services/documents");

export type DocKind = "brand_book" | "pitch" | "public_page";

export type DocError =
  | { ok: false; code: "feature_off"; message: string }
  | { ok: false; code: "brand_not_confirmed"; message: string }
  | { ok: false; code: "no_research"; message: string }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "bad_input"; message: string }
  | { ok: false; code: "failed"; message: string };

const err = <C extends DocError["code"]>(code: C, message: string) => ({ ok: false as const, code, message }) as Extract<DocError, { code: C }>;

/** Why a tailored pitch can't be written for this brand yet (unknown, not confirmed, not researched), or null. No spend. */
export async function pitchGate(brandId: number): Promise<DocError | null> {
  const [b] = await db.select({ id: inboxBrands.id, name: inboxBrands.name, enrichment: inboxBrands.enrichment }).from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  if (!b) return err("not_found", `No brand ${brandId} on file.`);
  if (!researchConfirmed(b.enrichment)) return err("brand_not_confirmed", `Confirm ${b.name} is the right company first; a tailored pitch is written only for a confirmed brand.`);
  const r = await loadBrandResearch(brandId);
  if (!r || !(r.description || r.values || r.audience || r.recentCampaigns.length)) return err("no_research", `${b.name} has no research yet; research the brand before writing a pitch for it.`);
  return null;
}

/** The document as the athlete sees it. brand_book → its data; pitch / public_page → engine HTML (owner preview). */
export async function getDocument(
  athleteId: string, kind: DocKind, opts: { brandId?: number; theme?: string } = {},
): Promise<{ ok: true; kind: DocKind; status: string; data?: unknown; html?: string } | DocError> {
  if (kind === "brand_book") {
    const r = await readBrandBook(athleteId);
    return { ok: true, kind, status: r.status, data: r };
  }
  if (kind === "pitch") {
    if (!opts.brandId) return err("bad_input", "A pitch needs a brandId.");
    const gate = await pitchGate(opts.brandId);
    if (gate) return gate;
  }
  const kit = await getOrBuildKit(athleteId, kind === "pitch" ? { brandId: opts.brandId } : {});
  const html = kind === "public_page"
    ? await (await import("../nomiDeck/publicPage")).renderOwnerPublicPage(athleteId, kit, opts.theme)
    : await renderNomiForWeb(kit, { theme: opts.theme, mode: "deck" });
  return { ok: true, kind, status: "ready", html };
}

/** Build (or rebuild) the pitch for one confirmed brand. `focus` = the angles she chose (CreatePitchFlow). Costs ~$0.20 (concept step). */
export async function createPitch(athleteId: string, brandId: number, focus?: unknown): Promise<{ ok: true; brandId: number; cards: number } | DocError> {
  if (!Number.isInteger(brandId) || brandId <= 0) return err("bad_input", "brandId must be a positive integer.");
  const gate = await pitchGate(brandId);
  if (gate) return gate;
  const kit = await buildAndCacheKit(athleteId, { brandId, angles: parseFocus(focus) });
  return { ok: true, brandId, cards: kit.cards.length };
}

/** Rewrite one page. Brand book: the whole book is one model run today, so this rewrites the book (pages she locked keep their words). Nomi Card: rebuilds that card's kit. */
export async function rebuildPage(athleteId: string, doc: DocKind, page: string, opts: { brandId?: number } = {}): Promise<{ ok: true; started: true; scope: "book" | "card" } | DocError> {
  if (doc === "brand_book") {
    await startBrandBook(athleteId);
    return { ok: true, started: true, scope: "book" };
  }
  if (!page) return err("bad_input", "Name the card to rebuild.");
  if (doc === "pitch" && opts.brandId) {
    const gate = await pitchGate(opts.brandId);
    if (gate) return gate;
  }
  await buildAndCacheKit(athleteId, { brandId: doc === "pitch" ? opts.brandId : undefined });
  return { ok: true, started: true, scope: "card" };
}

/**
 * Another wording for one line. `pick` = an index into the stored options ($0, instant), or `{ instruction }` = what she
 * wants changed — returned as a request for Mila (the chat tool writes it; this function never calls a model itself).
 */
export async function swapLine(
  athleteId: string, doc: DocKind, page: string, slot: string, pick: number | { instruction: string }, opts: { brandId?: number } = {},
): Promise<{ ok: true; applied: true } | { ok: true; applied: false; needsWriter: { doc: DocKind; page: string; slot: string; instruction: string } } | DocError> {
  if (typeof pick === "object") {
    const instruction = String(pick.instruction ?? "").trim();
    if (!instruction) return err("bad_input", "Say what should change in the line.");
    return { ok: true, applied: false, needsWriter: { doc, page, slot, instruction } };
  }
  if (doc === "brand_book") {
    return (await chooseLine(athleteId, page, slot, pick)) ? { ok: true, applied: true } : err("not_found", `No option ${pick} for ${page} · ${slot}.`);
  }
  const brandId = doc === "pitch" ? opts.brandId ?? 0 : 0;
  const kit = await getOrBuildKit(athleteId, { brandId, raw: true });
  const card = kit.cards.find((c) => c.id === page);
  const field = card ? editableFields(card.type).find((f) => f.field === slot || f.slot === slot) : undefined;
  const options = card ? kit.copyAlternates?.[card.id]?.[field?.slot ?? "tagline"] ?? [] : [];
  if (!card || !field || !Number.isInteger(pick) || pick < 0 || pick >= options.length) return err("not_found", `No option ${pick} for ${page} · ${slot}.`);
  const ov = (await getOverrides(athleteId, brandId)) ?? {};
  ov.copy = { ...(ov.copy ?? {}), [`${card.id}.${field.field}`]: { text: options[pick], pick } };
  await saveOverrides(athleteId, brandId, ov);
  return { ok: true, applied: true };
}

/** Put one of HER photos on a card slot (only a photo tagged as her), or `"next"` — the next-best ranked photo the card has not used. */
export async function swapPhoto(
  athleteId: string, doc: Exclude<DocKind, "brand_book">, slot: string, asset: string | "next", opts: { brandId?: number } = {},
): Promise<{ ok: true; gcsPath: string } | DocError> {
  const brandId = doc === "pitch" ? opts.brandId ?? 0 : 0;
  const kit = await getOrBuildKit(athleteId, { brandId, raw: true });
  const card = kit.cards.find((c) => c.id === slot);
  if (!card) return err("not_found", `No card ${slot}.`);
  let path: string | null = null;
  if (asset === "next") {
    const used = new Set(kit.cards.map((c: any) => c.image ?? c.bg).filter(Boolean));
    path = (kit.imagePool ?? []).map((p) => p.gcsPath).find((p) => p && !used.has(p)) ?? null;
    if (!path) return err("not_found", "No other ranked photo left for this card; add photos from the camera roll.");
  } else {
    const [row] = await db.select({ gcs_path: mediaAssets.gcs_path, metadata: mediaAssets.metadata }).from(mediaAssets)
      .where(and(eq(mediaAssets.id, asset), eq(mediaAssets.athlete_id, athleteId))).limit(1);
    if (!row?.gcs_path) return err("not_found", "That photo isn't in her library.");
    if (!isTheAthlete((row.metadata as any)?.vision)) return err("bad_input", "That photo isn't tagged as her; pick one of her own photos.");
    path = row.gcs_path;
  }
  const ov = (await getOverrides(athleteId, brandId)) ?? {};
  ov.images = { ...(ov.images ?? {}), [card.id]: path };
  await saveOverrides(athleteId, brandId, ov);
  return { ok: true, gcsPath: path };
}

/** The public page in the engine's craft — an owner-only preview (nothing is published by this). */
export async function previewPublicPage(athleteId: string, opts: { theme?: string } = {}): Promise<{ ok: true; html: string } | DocError> {
  const r = await getDocument(athleteId, "public_page", opts);
  if (!r.ok) return r;
  return { ok: true, html: r.html ?? "" };
}

/**
 * Her own words for one line, written by Mila at her request (the chat's write_line). Brand book: the slot shows the
 * text and keeps its earlier options. Nomi Card (public page / pitch): the same override the editor writes for a
 * crafted-copy field — the facts layer is never touched. No model, no cost.
 */
export async function writeLine(
  athleteId: string, doc: DocKind, page: string, slot: string, text: string, opts: { brandId?: number } = {},
): Promise<{ ok: true; applied: true } | DocError> {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return err("bad_input", "Say the new words for the line.");
  if (clean.length > 240) return err("bad_input", "Keep the line under 240 characters.");
  if (doc === "brand_book") {
    return (await writeBookLine(athleteId, page, slot, clean)) ? { ok: true, applied: true } : err("not_found", `No line ${page} · ${slot} in the brand book.`);
  }
  const brandId = doc === "pitch" ? opts.brandId ?? 0 : 0;
  const kit = await getOrBuildKit(athleteId, { brandId, raw: true });
  const card = kit.cards.find((c) => c.id === page);
  const field = card ? editableFields(card.type).find((f) => f.field === slot || f.slot === slot) : undefined;
  if (!card || !field) return err("not_found", `No line ${page} · ${slot} on this card.`);
  const ov = (await getOverrides(athleteId, brandId)) ?? {};
  ov.copy = { ...(ov.copy ?? {}), [`${card.id}.${field.field}`]: { text: clean } };
  await saveOverrides(athleteId, brandId, ov);
  return { ok: true, applied: true };
}

/**
 * Build (or rebuild) one whole document now, awaited — the documents workflow's build step. pitch: the tailored deck
 * for one confirmed, researched brand (~$0.20, the concept step). public_page: the general Nomi Card every page and
 * general pitch is drawn from. brand_book: the ten chapters (a few cents); one already being written is not started twice.
 */
export async function buildDocument(
  athleteId: string, doc: DocKind, opts: { brandId?: number; angles?: unknown } = {},
): Promise<{ ok: true; doc: DocKind; detail: "built" | "already_building" } | DocError> {
  if (doc === "brand_book") {
    const m = await markBrandBookBuilding(athleteId);
    if (!m.started) return { ok: true, doc, detail: "already_building" };
    return (await completeBrandBook(athleteId, m.version, m.hadData)) ? { ok: true, doc, detail: "built" } : err("failed", "The brand book could not be written this time.");
  }
  if (doc === "pitch") {
    const r = await createPitch(athleteId, opts.brandId ?? 0, opts.angles);
    return r.ok ? { ok: true, doc, detail: "built" } : r;
  }
  await buildAndCacheKit(athleteId, {});
  return { ok: true, doc, detail: "built" };
}

/**
 * Check before deliver (A4): the document exactly as she would be shown it (getDocument) — its required sections, no
 * placeholder tokens ([Name], [amount], TODO …), and only links that are ours or hers (deliverable.ts linkVerdict). Free: no model, no spend. A document
 * that can't be read back at all fails as "sections". The documents workflow's build step calls it after a build.
 */
export async function verifyBuiltDocument(athleteId: string, doc: DocKind, opts: { brandId?: number } = {}): Promise<VerifyResult> {
  // A read that throws is a document she couldn't be shown either: it fails as "sections", never as a retry (spend).
  const got = await getDocument(athleteId, doc, opts).catch(() => ({ ok: false as const }));
  const book = got.ok && doc === "brand_book" ? ((got.data as { book?: { pages?: unknown } } | undefined)?.book ?? null) : null;
  const artifact = !got.ok
    ? { sections: [], links: [] }
    : doc === "brand_book"
      ? (book && Array.isArray((book as { pages?: unknown }).pages) ? documentFromBrandBook(book as Parameters<typeof documentFromBrandBook>[0]) : { sections: [], links: [] })
      : documentFromDeckHtml(got.html ?? "");
  // Her own links (accounts, the pages her facts came from) widen what passes. A read that fails leaves them out — the
  // check is then only stricter about outside links, never looser — and says so in the log.
  const her = await loadHerLinks(athleteId).catch((e) => {
    logger.warn({ athleteId, doc, error: String(e?.message ?? e).slice(0, 160) }, "her links could not be read — checking against our hosts and the profile platforms only");
    return undefined;
  });
  return verifyDeliverable("document", artifact, { requiredSections: REQUIRED_SECTIONS[doc], allowedHosts: ourHosts(), her });
}
