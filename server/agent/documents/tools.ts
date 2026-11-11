/**
 * agent/documents/tools.ts — Mila's grouped documents toolset (design "Mila and the documents", 23 Oct 2026), behind
 * AGENT_DOCUMENTS_TOOLS. Four tools, by job:
 *
 *   documents_status  read   where the brand book, the public page and each pitch stand; one document's pages and the
 *                            lines that can change (detail: pages). Free.
 *   documents_make    draft  build or rebuild one whole document in the BACKGROUND (the document_build workflow): a
 *                            progress card, and Mila comes back in this chat when it is ready. Private; a pitch ~$0.20.
 *   documents_edit    draft  one line (a stored option, or new words Mila writes) or one photo on a private draft, saved
 *                            at once. Free.
 *   documents_share   act    a live link to a pitch, or publishing the public page — QUEUED: runs only on her tap
 *                            (POST /pending-actions/:id/approve → executeAgentAction). Free.
 *
 * Every check that can be made at call time is made before anything is spent or queued (`prepare`): the brand is one of
 * hers, confirmed and researched for a pitch; the document exists before an edit or a share; the page and slot exist
 * for an edit; the public page can be published. Each refusal says what to do next. No tool takes an athlete id or a
 * brand id: a pitch's brand is a name, resolved in code to one of HER brands. One shared preamble (prompts.ts, the
 * documents skill) reaches the model once per run, only while these tools are on.
 */
import { z } from "zod";
import type { ChatCard, DocumentKind } from "../../../shared/agent";
import { errorResult, okResult, type AgentTool, type ToolContext, type Toolset } from "../tools";
import { buildProgressCard, docTitle, documentCard } from "./cards";
import {
  DOCUMENTS_EDIT_DESCRIPTION, DOCUMENTS_MAKE_DESCRIPTION, DOCUMENTS_SHARE_DESCRIPTION, DOCUMENTS_STATUS_DESCRIPTION,
  DOCUMENTS_TOOLSET_ID,
} from "./prompts";
import { CHANGES, DOC_KINDS, type DocChange, type DocPage, type DocRef, type DocSummary, type DocumentsSource, type Got } from "./source";

export const DOCUMENTS_TOOLSET: Toolset = { id: DOCUMENTS_TOOLSET_ID };

/** Each source error, as the model reads it: what happened and what to do next. Never a brand's own text. */
export function errorFor(e: Got<unknown> & { ok: false }): string {
  switch (e.error) {
    case "feature_off": return `feature_off: ${e.detail ?? "that document isn't switched on here"}. Say it isn't available yet; don't retry.`;
    case "not_found": return `not_found: ${e.detail ?? "no such document, page or line"}. Check with documents_status (detail: pages).`;
    case "not_built": return "not_built: that document hasn't been made yet. Offer to make it with documents_make.";
    case "building": return "building: that document is being made right now. Say you'll tell them here when it's ready.";
    case "brand_not_confirmed": return "brand_not_confirmed: Nomila hasn't confirmed this brand is the right company yet, so no pitch is written for it. They can confirm the brand on its deal or in Pitches; then ask again.";
    case "no_research": return "no_research: the brand is confirmed but Nomila has no research on it yet, so a pitch would have nothing to stand on. Say so; it can be researched from Pitches.";
    case "bad_input": return `bad_input: ${e.detail ?? "the request didn't fit this document"}.`;
    case "daily_limit": return "daily_limit: enough documents were made in the last 24 hours. Say it can be made again tomorrow; don't retry.";
    case "blocked": return `blocked: ${e.detail ?? "it can't go out yet"}. Say what's missing in one line.`;
    case "failed": return `failed: ${e.detail ?? "it didn't go through"}. Say plainly it didn't happen; they can ask again later.`;
  }
}

const brandArg = z.string().max(80).optional().describe("Part of the brand's name (document: pitch only).");
const ext = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The document a call is about. A pitch needs `brand`, resolved to ONE of her brands; `purpose` "make" also requires the
 * brand to be confirmed and researched, before anything is spent.
 */
async function refFor(
  source: DocumentsSource, ctx: ToolContext, a: { document: DocumentKind; brand?: string }, purpose: "read" | "make",
): Promise<{ ref: DocRef } | { error: string }> {
  if (a.document !== "pitch") return { ref: { kind: a.document } };
  const name = a.brand?.trim();
  if (!name) return { error: "bad_input: a pitch needs brand (part of the brand's name). Ask which brand if it isn't clear." };
  const found = await source.brand(ctx.athleteId, name);
  if ("none" in found) return { error: "not_found: none of their brands matches that name. Their brands come from their inbox, deals and pitches; a new brand is added in Pitches (Create pitch). Check the spelling or ask." };
  if ("ambiguous" in found) return { error: `ambiguous: that name matches ${found.ambiguous.length} of their brands. Ask which one: ${found.ambiguous.slice(0, 5).join(", ")}.` };
  const brand = found.found;
  if (purpose === "make") {
    if (!brand.confirmed) return { error: errorFor({ ok: false, error: "brand_not_confirmed" }) };
    if (!brand.researched) return { error: errorFor({ ok: false, error: "no_research" }) };
  }
  return { ref: { kind: "pitch", brand } };
}

function summaryForModel(s: DocSummary | null, kind: DocumentKind) {
  if (!s) return { state: "none" as const };
  return {
    ...(kind === "pitch" && s.brand ? { brand: ext(s.brand.name), brand_confirmed: s.brand.confirmed } : {}),
    state: s.state,
    updated: s.updatedAt?.slice(0, 10) ?? null,
    ...(kind === "pitch" ? { shared: !!s.shared, opens: s.shared?.opens ?? 0, out_of_date: s.stale } : {}),
    ...(kind === "public_page" ? { published: !!s.published, version: s.published?.version ?? null, can_publish: s.canPublish, ...(s.blockedReason ? { why_not: ext(s.blockedReason) } : {}) } : {}),
    ...(s.error ? { last_error: ext(s.error) } : {}),
  };
}

function pagesForModel(pages: DocPage[]) {
  return pages.map((p) => ({
    page: p.id,
    title: ext(p.title),
    photo: p.photo,
    lines: p.lines.map((l) => ({
      slot: l.slot,
      text: ext(clip(l.text, 200)),
      options: l.options.slice(0, 4).map((o, i) => ({ option: i, text: ext(clip(o, 120)) })),
    })),
  }));
}

/**
 * What documents_status tells the model about its cards: a card is drawn only for a document that exists, so with none
 * the reply must not point at one (6 Nov 2026: "see the status in the card" with no card shown).
 */
export function cardsShownNote(n: number): string {
  return n ? `${n} document card${n === 1 ? "" : "s"} shown under your reply` : "no card is shown (none of these documents exists yet): say it in words";
}

export function documentsTools(source: DocumentsSource): AgentTool[] {
  const base = { kind: "ours" as const, toolset: DOCUMENTS_TOOLSET };

  // ── documents_status (read) ────────────────────────────────────────────────────────────────────────────────────
  const statusArgs = z.object({
    document: z.enum(["all", ...DOC_KINDS]).describe("all | brand_book | public_page | pitch"),
    brand: brandArg,
    detail: z.enum(["summary", "pages"]).optional().describe("pages: one document's pages and the lines that can change (not with all)."),
    page: z.string().max(60).optional().describe("With detail: pages, only this page (its id)."),
  });
  const status: AgentTool<typeof statusArgs> = {
    ...base, name: "documents_status", permission: "read", description: DOCUMENTS_STATUS_DESCRIPTION, args: statusArgs,
    async execute(ctx, a) {
      if (a.document === "all") {
        if (a.detail === "pages") return errorResult("bad_input: detail: pages needs one document (brand_book, public_page or pitch with brand).");
        const o = await source.overview(ctx.athleteId);
        const docs = [o.brandBook, o.publicPage, ...o.pitches].filter((d): d is DocSummary => !!d && d.state !== "none");
        return okResult({
          brand_book: o.available.brandBook ? summaryForModel(o.brandBook, "brand_book") : "not switched on here",
          public_page: o.available.engine ? summaryForModel(o.publicPage, "public_page") : "not switched on here",
          pitches: o.available.engine ? o.pitches.map((p) => summaryForModel(p, "pitch")) : "not switched on here",
          pitch_ready_brands: o.pitchable.map((b) => ext(b.name)),
          cards: cardsShownNote(Math.min(docs.length, 4)),
          _docs: docs,
        });
      }
      const r = await refFor(source, ctx, { document: a.document, brand: a.brand }, "read");
      if ("error" in r) return errorResult(r.error);
      const s = await source.summary(ctx.athleteId, r.ref);
      const one = s && s.state !== "none" ? [s] : [];
      if (a.detail !== "pages") return okResult({ document: a.document, ...summaryForModel(s, a.document), cards: cardsShownNote(one.length), _docs: one });
      const pages = await source.pages(ctx.athleteId, r.ref);
      if (!pages.ok) return errorResult(errorFor(pages));
      const wanted = a.page?.trim();
      const list = wanted ? pages.value.filter((p) => p.id === wanted) : pages.value;
      if (wanted && !list.length) return errorResult(`not_found: no page "${clip(wanted, 40)}". Pages: ${pages.value.map((p) => p.id).join(", ")}.`);
      return okResult({ document: a.document, ...summaryForModel(s, a.document), pages: pagesForModel(list), cards: cardsShownNote(one.length), _docs: one });
    },
    cards: (result, ctx): ChatCard[] => ((result as { _docs?: DocSummary[] })._docs ?? []).slice(0, 4).map((d) => documentCard(d, ctx.runId)),
  };

  // ── documents_make (draft; background) ─────────────────────────────────────────────────────────────────────────
  const makeArgs = z.object({
    document: z.enum(DOC_KINDS).describe("brand_book | public_page | pitch"),
    brand: brandArg,
    angles: z.array(z.string().min(2).max(80)).max(3).optional().describe("Up to 3 angles they want a pitch to lead with, in their words."),
  });
  const make: AgentTool<typeof makeArgs> = {
    ...base, name: "documents_make", permission: "draft", description: DOCUMENTS_MAKE_DESCRIPTION, args: makeArgs,
    async prepare(ctx, a) {
      if (a.angles?.length && a.document !== "pitch") return { error: "bad_input: angles are for a pitch only. Drop them." };
      const r = await refFor(source, ctx, a, "make");
      return "error" in r ? { error: r.error } : { args: a };
    },
    async execute(ctx, a) {
      const r = await refFor(source, ctx, a, "make");
      if ("error" in r) return errorResult(r.error);
      const started = await source.startBuild(ctx.athleteId, r.ref, { angles: (a.angles ?? []).map((x) => x.trim()).filter(Boolean), conversationId: ctx.turn?.conversationId ?? null });
      if (!started.ok) return errorResult(errorFor(started));
      return okResult({
        started: true, joined: started.value.joined, document: a.document,
        ...(r.ref.kind === "pitch" ? { brand: ext(r.ref.brand.name) } : {}),
        note: started.value.joined
          ? "It was already being made: this joins it. Nothing new is paid. Say you'll tell them here when it's ready."
          : "It's being made in the background; they can leave. Say you'll tell them here when it's ready. It is NOT ready yet.",
        _progress: { workflowRunId: started.value.runId, ref: r.ref },
      });
    },
    card(result, ctx) {
      const p = (result as { _progress?: { workflowRunId: string; ref: DocRef } })._progress;
      return p ? buildProgressCard(p.workflowRunId, p.ref, ctx.runId) : null;
    },
  };

  // ── documents_edit (draft; at once) ────────────────────────────────────────────────────────────────────────────
  const editArgs = z.object({
    document: z.enum(DOC_KINDS).describe("brand_book | public_page | pitch"),
    brand: brandArg,
    change: z.enum(CHANGES).describe("pick_line | write_line | next_photo"),
    page: z.string().min(1).max(60).describe("The page's id from documents_status (detail: pages)."),
    slot: z.string().max(60).optional().describe("The line's slot (pick_line, write_line)."),
    option: z.number().int().min(0).max(20).optional().describe("pick_line: the stored option's index."),
    text: z.string().max(240).optional().describe("write_line: the new words, from what the page, CONTEXT or they say."),
  });
  type EditArgs = z.infer<typeof editArgs>;

  /** The change the arguments describe, or why they don't describe one. */
  function changeOf(a: EditArgs): DocChange | { error: string } {
    const slot = a.slot?.trim();
    if (a.change === "next_photo") {
      if (a.document === "brand_book") return { error: "bad_input: the brand book's photos are chosen with the book. Offer to rewrite it (documents_make), or they can open it on Me." };
      return { change: "next_photo", page: a.page.trim() };
    }
    if (!slot) return { error: `bad_input: ${a.change} needs slot (from documents_status, detail: pages).` };
    if (a.change === "pick_line") {
      if (a.option == null) return { error: "bad_input: pick_line needs option (the stored option's index from documents_status pages)." };
      return { change: "pick_line", page: a.page.trim(), slot, option: a.option };
    }
    const text = a.text?.replace(/\s+/g, " ").trim();
    if (!text) return { error: "bad_input: write_line needs text (the new words)." };
    return { change: "write_line", page: a.page.trim(), slot, text };
  }

  /** The checks an edit passes before it runs: the change is well formed, the document exists and has that page and line. */
  async function checkEdit(ctx: ToolContext, a: EditArgs): Promise<{ ref: DocRef; change: DocChange; picked?: string } | { error: string }> {
    const change = changeOf(a);
    if ("error" in change) return change;
    const r = await refFor(source, ctx, a, "read");
    if ("error" in r) return r;
    const s = await source.summary(ctx.athleteId, r.ref);
    if (!s || s.state === "none") return { error: errorFor({ ok: false, error: "not_built" }) };
    const pages = await source.pages(ctx.athleteId, r.ref);
    if (!pages.ok) return { error: errorFor(pages) };
    const page = pages.value.find((p) => p.id === change.page);
    if (!page) return { error: `not_found: no page "${clip(change.page, 40)}". Pages: ${pages.value.map((p) => p.id).join(", ")}.` };
    if (change.change === "next_photo") {
      if (!page.photo) return { error: "bad_input: that page has no photo to swap. Pick a page with photo: true." };
      return { ref: r.ref, change };
    }
    const line = page.lines.find((l) => l.slot === change.slot);
    if (!line) return { error: `not_found: no line "${clip(change.slot, 40)}" on that page. Lines: ${page.lines.map((l) => l.slot).join(", ") || "none"}.` };
    if (change.change === "pick_line" && change.option >= line.options.length) return { error: `not_found: that line has ${line.options.length} stored options (0 to ${Math.max(0, line.options.length - 1)}). Pick one of those or write_line.` };
    return { ref: r.ref, change, ...(change.change === "pick_line" ? { picked: line.options[change.option] } : {}) };
  }

  const edit: AgentTool<typeof editArgs> = {
    ...base, name: "documents_edit", permission: "draft", description: DOCUMENTS_EDIT_DESCRIPTION, args: editArgs,
    async prepare(ctx, a) {
      const c = await checkEdit(ctx, a);
      return "error" in c ? { error: c.error } : { args: a };
    },
    async execute(ctx, a) {
      const c = await checkEdit(ctx, a);
      if ("error" in c) return errorResult(c.error);
      const done = await source.edit(ctx.athleteId, c.ref, c.change);
      if (!done.ok) return errorResult(errorFor(done));
      const after = await source.summary(ctx.athleteId, c.ref);
      return okResult({
        changed: true, change: c.change.change, page: c.change.page,
        ...("slot" in c.change ? { slot: c.change.slot } : {}),
        ...((done.value.text ?? c.picked) ? { now_reads: ext(clip((done.value.text ?? c.picked)!, 200)) } : {}),
        note: "Saved on their private draft. Nothing went out.",
        _docs: after ? [after] : [],
      });
    },
    cards: (result, ctx): ChatCard[] => ((result as { _docs?: DocSummary[] })._docs ?? []).map((d) => documentCard(d, ctx.runId)),
  };

  // ── documents_share (act: her tap runs it) ─────────────────────────────────────────────────────────────────────
  const shareArgs = z.object({
    document: z.enum(["pitch", "public_page"]).describe("pitch | public_page"),
    brand: brandArg,
    brand_label: z.string().max(80).optional().describe("Leave empty: Nomila fills it."),
  });
  type ShareArgs = z.infer<typeof shareArgs>;
  const share: AgentTool<typeof shareArgs> = {
    ...base, name: "documents_share", permission: "act", description: DOCUMENTS_SHARE_DESCRIPTION, args: shareArgs,
    approval: {
      verb: "publish",
      title: (a: ShareArgs) => (a.document === "pitch" ? `Create a link to your ${a.brand_label ?? "brand"} pitch?` : "Publish your public page?"),
      summary: (a: ShareArgs) => (a.document === "pitch"
        ? "Nomila makes a live link to this pitch. Anyone with the link can open it, and you'll see when it's opened. You send the link yourself; nothing is emailed."
        : "Your page goes live at your link exactly as the preview shows it now. You can unpublish it from Me."),
    },
    async prepare(ctx, a) {
      const r = await refFor(source, ctx, a, "read");
      if ("error" in r) return { error: r.error };
      const s = await source.summary(ctx.athleteId, r.ref);
      if (!s || s.state === "none") return { error: errorFor({ ok: false, error: "not_built" }) };
      if (s.state === "building") return { error: errorFor({ ok: false, error: "building" }) };
      if (r.ref.kind === "public_page" && s.canPublish === false) return { error: errorFor({ ok: false, error: "blocked", detail: s.blockedReason ?? "the page isn't ready to publish" }) };
      // The card names the brand in plain text (from her own brand list, never shown to the model as an instruction).
      return { args: { ...a, brand: r.ref.kind === "pitch" ? r.ref.brand.name.slice(0, 80) : undefined, brand_label: r.ref.kind === "pitch" ? r.ref.brand.name.slice(0, 80) : undefined } };
    },
    // Runs ONLY from her approve tap (executeAgentAction): the harness queues every act call.
    async execute(ctx, a) {
      const r = await refFor(source, ctx, a, "read");
      if ("error" in r) return errorResult(r.error);
      if (r.ref.kind === "pitch") {
        const got = await source.sharePitch(ctx.athleteId, r.ref.brand);
        if (!got.ok) return errorResult(errorFor(got));
        return okResult({ shared: true, document: "pitch", url: got.value.url });
      }
      const got = await source.publishPage(ctx.athleteId);
      if (!got.ok) return errorResult(errorFor(got));
      return okResult({ published: true, document: "public_page", version: got.value.version, url: got.value.url });
    },
  };

  return [status as unknown as AgentTool, make as unknown as AgentTool, edit as unknown as AgentTool, share as unknown as AgentTool];
}

/** Every documents tool's name, in order (the guard test and the chat skill list them). */
export const DOCUMENTS_TOOL_NAMES = ["documents_status", "documents_make", "documents_edit", "documents_share"] as const;

export { docTitle };
