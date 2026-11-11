/**
 * agent/deals/tools.ts — Mila's grouped deals toolset (design "Deals · Bookings · Mila" §6). AGENT_DEALS_TOOLS was retired on 2 Nov 2026 (always on).
 *
 *   deals_find         read     her deals in the board's order; filter needs_you | in_motion | waiting_on_them | closed | all
 *   deals_get          read     one deal: the read, what they asked, the latest offer, whose move, the allowed intents
 *   deals_terms        read     the term sheet row by row, and what's not known yet
 *   deals_waiting      read     her tap queue (drafts and ask-for-terms messages)
 *   deals_draft_reply  draft    the exact reply, shown for her approval (an inert send_reply proposal); never sends
 *   deals_close        draft*   her "no" / "not a deal" / "expired", done at once as HER act with Undo (D1); optional
 *                               polite no, still waiting for her Send
 *   deals_mark         propose  signed | completed | reopen — queued; runs only on her tap
 *   deals_open         read     a tap-to-open card: one deal, the board, or her closed deals
 *   brand_get          read     confirmed brand research only
 *
 * (*) The design's "act (internal, reversible, undo receipt)" is the harness's `draft` level — private to Nomila and
 *     reversible, as the goal tools are (plan/tools.ts). The harness's `act` means "queued for her tap", which D1 says a
 *     close does not need. Nothing in this file sends, approves, or moves money.
 *
 * One shared preamble (prompts.ts) reaches the model once per run, only while these tools are on. No tool takes an
 * athlete id: the athlete is the run's. Every ok result is fenced as outside text by the harness (transport level), so
 * the brand names, asks, offers, summaries and research it quotes are data to the model. Her floor is never a number.
 */
import { z } from "zod";
import type { ChatCard, DealClosedCardPayload, DealsWaitingCardPayload, OpenScreenCardPayload } from "../../../shared/agent";
import {
  DEAL_TYPE_LABEL, FIGURE_INTENTS, INTENTS_BY_TYPE, REPLY_INTENTS, REPLY_INTENT_LABEL, TERM_KEYS, TERM_LABEL, intentAllowed,
  type ReplyIntent, type TermKey,
} from "../../../shared/deals";
import { errorResult, okResult, type AgentTool, type ToolContext, type Toolset } from "../tools";
import { cardBrand, dealCard, MONEY_WORDS, replyCard, replyCardPayload } from "./cards";
import { unsaidNumbers } from "./numbers";
import {
  BRAND_GET_DESCRIPTION, DEALS_CLOSE_DESCRIPTION, DEALS_DRAFT_REPLY_DESCRIPTION, DEALS_FIND_DESCRIPTION, DEALS_GET_DESCRIPTION,
  DEALS_MARK_DESCRIPTION, DEALS_OPEN_DESCRIPTION, DEALS_TERMS_DESCRIPTION, DEALS_TOOLSET_ID, DEALS_WAITING_DESCRIPTION,
} from "./prompts";
import { MONEY_TERMS } from "./terms";
import {
  CLOSE_REASONS, DEAL_FILTERS, MARKS, TONES, type CloseReason, type DealDetailView, type DealRow, type DealsSource, type Got,
  type Mark, type TermAsk, type Tone,
} from "./source";

export const DEALS_TOOLSET: Toolset = { id: DEALS_TOOLSET_ID };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Outside text as the model reads it. The harness fences every ok tool result as outside text (transport level). */
const ext = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const CARDS_FROM_FIND = 3;

const CLOSE_LABEL: Record<CloseReason, string> = { not_interested: "Not interested", not_a_deal: "Not a real deal", expired: "Too late" };
const MARK_TITLE: Record<Mark, string> = { signed: "Mark it signed?", completed: "Mark it completed?", reopen: "Bring it back to your board?" };
const MARK_SUMMARY: Record<Mark, string> = {
  signed: "Nomila marks the deal Signed. You can undo it from the receipt.",
  completed: "Nomila marks the agreed deal Completed. You can undo it from the receipt.",
  reopen: "The deal you set aside goes back on your board. You can undo it from the receipt.",
};

/** Each source error, as the model reads it: what happened and what to do next. */
export function errorFor(e: Got<unknown> & { ok: false }): string {
  switch (e.error) {
    case "not_found": return "not_found: no deal of theirs has that id. Find it with deals_find (a brand name narrows it).";
    case "not_yours": return "not_yours: that id is not one of this athlete's deals. Use only ids from deals_find or deals_get.";
    case "closed": return "closed: this deal is closed. Call deals_get again with include_closed: true to read it as history; it can't be replied to or closed again.";
    case "wrong_state": return `wrong_state: ${e.detail ?? "the deal isn't in a state for that"}.`;
    case "unavailable": return `unavailable: ${e.detail ?? "that isn't available from the chat yet"}. Say so and point them to the deal in the app.`;
  }
}

/** One deal row as the model reads it. Outside text fenced; the floor never appears. */
export function rowForModel(r: DealRow) {
  return {
    id: r.id,
    brand: ext(r.brand.name),
    brand_confirmed: r.brand.confirmed,
    type: r.type,
    type_label: r.kindLabel ?? (r.type ? DEAL_TYPE_LABEL[r.type] : null),
    money: ext(r.moneyLine),
    money_standing: MONEY_WORDS[r.moneyState].toLowerCase(),
    whose_move: r.whoseMove,
    stage: r.stage,
    next_step: r.next ? { label: r.next.label, why: ext(r.next.why), due: r.next.due } : null,
    last_activity: r.lastActivityAt?.slice(0, 10) ?? null,
    ...(r.closed ? { closed: { on: r.closed.at.slice(0, 10), reason: r.closed.reason } } : {}),
  };
}

export function detailForModel(d: DealDetailView) {
  const intents = d.type ? INTENTS_BY_TYPE[d.type] : [];
  return {
    ...rowForModel(d),
    read: d.read ? {
      money: { line: ext(d.read.money.line), standing: MONEY_WORDS[d.read.money.state].toLowerCase(), source: d.read.money.source },
      fit: d.read.fit ? { line: ext(d.read.fit.line), source: d.read.fit.source } : "unknown: the brand isn't confirmed",
      risk: { line: ext(d.read.risk.line), flags: d.read.risk.flags, source: d.read.risk.source },
      goal: d.read.goal ? { line: ext(d.read.goal.line), source: d.read.goal.source } : null,
    } : null,
    they_asked: ext(d.ask),
    latest_offer: ext(d.latestOffer),
    summary: ext(d.summary),
    not_known_yet: d.unknowns,
    reply_intents: d.closed ? [] : intents.map((i) => ({ intent: i, label: REPLY_INTENT_LABEL[i] })),
    can_send_from_app: d.replyPath.sendable,
    ...(d.replyPath.sendable ? {} : { why_not: d.replyPath.why }),
  };
}

export function dealsTools(source: DealsSource): AgentTool[] {
  const base = { kind: "ours" as const, toolset: DEALS_TOOLSET };

  // ── deals_find ─────────────────────────────────────────────────────────────────────────────────────────────────
  const find: AgentTool = {
    ...base, name: "deals_find", permission: "read", description: DEALS_FIND_DESCRIPTION,
    args: z.object({
      filter: z.enum(DEAL_FILTERS).describe("needs_you | in_motion | waiting_on_them | closed | all"),
      brand: z.string().max(80).optional().describe("Part of a brand's name."),
      from: z.string().regex(DAY_RE).optional().describe("YYYY-MM-DD"),
      to: z.string().regex(DAY_RE).optional().describe("YYYY-MM-DD"),
      limit: z.number().int().min(1).max(10).optional().describe("Rows to return (default 5)."),
    }),
    async execute(ctx: ToolContext, a: { filter: (typeof DEAL_FILTERS)[number]; brand?: string; from?: string; to?: string; limit?: number }) {
      const r = await source.find(ctx.athleteId, { filter: a.filter, brand: a.brand, from: a.from, to: a.to, limit: a.limit ?? 5 });
      return okResult({
        total: r.total, shown: r.rows.length, deals: r.rows.map(rowForModel),
        ...(r.total === 0 ? { note: a.filter === "needs_you" ? "nothing needs them right now" : "no deals match" } : {}),
        _rows: r.rows,
      });
    },
    // The first few rows as deal cards, under the answer.
    cards: (result, ctx): ChatCard[] => ((result as { _rows?: DealRow[] })._rows ?? []).slice(0, CARDS_FROM_FIND).map((r) => dealCard(r, ctx.runId)),
  };

  // ── deals_get ──────────────────────────────────────────────────────────────────────────────────────────────────
  const get: AgentTool = {
    ...base, name: "deals_get", permission: "read", description: DEALS_GET_DESCRIPTION,
    args: z.object({
      deal_id: z.string().max(80).describe("The deal's id (from deals_find, or OPENED FROM deal <id>)."),
      include_closed: z.boolean().optional().describe("Read a closed deal as history."),
    }),
    async execute(ctx: ToolContext, a: { deal_id: string; include_closed?: boolean }) {
      const got = await source.get(ctx.athleteId, a.deal_id.trim(), { includeClosed: !!a.include_closed });
      if (!got.ok) return errorResult(errorFor(got));
      return okResult({ deal: detailForModel(got.value), _detail: got.value });
    },
    card(result, ctx) {
      const d = (result as { _detail?: DealDetailView })._detail;
      return d ? dealCard(d, ctx.runId) : null;
    },
  };

  // ── deals_terms ────────────────────────────────────────────────────────────────────────────────────────────────
  const terms: AgentTool = {
    ...base, name: "deals_terms", permission: "read", description: DEALS_TERMS_DESCRIPTION,
    args: z.object({ deal_id: z.string().max(80) }),
    async execute(ctx: ToolContext, a: { deal_id: string }) {
      const got = await source.terms(ctx.athleteId, a.deal_id.trim());
      if (!got.ok) return errorResult(errorFor(got));
      const label = (t: string) => (TERM_LABEL as Record<string, string>)[t] ?? t;
      return okResult({
        terms: got.value.rows.map((r) => ({ term: r.term, label: label(r.term), theirs: ext(r.theirs) ?? "not stated", ...(r.yours ? { yours: r.yours } : {}) })),
        not_known_yet: got.value.unknown.map(label),
      });
    },
  };

  // ── deals_waiting ──────────────────────────────────────────────────────────────────────────────────────────────
  const waiting: AgentTool = {
    ...base, name: "deals_waiting", permission: "read", description: DEALS_WAITING_DESCRIPTION,
    args: z.object({}),
    async execute(ctx: ToolContext) {
      const items = await source.waiting(ctx.athleteId);
      return okResult({
        count: items.length,
        waiting: items.map((i) => ({ kind: i.kind, brand: ext(i.brand), deal_id: i.opportunityId, since: i.createdAt.slice(0, 10) })),
        note: items.length ? "Written, not sent: each goes out only on their tap." : "Nothing is waiting for their tap.",
        _items: items,
      });
    },
    card(result, ctx) {
      const items = (result as { _items?: Awaited<ReturnType<DealsSource["waiting"]>> })._items ?? [];
      if (!items.length) return null;
      const payload: DealsWaitingCardPayload = {
        count: items.length,
        items: items.slice(0, 6).map((i) => ({ pendingActionId: i.id, kind: i.kind, opportunityId: i.opportunityId, brand: i.brand, title: i.title, createdAt: i.createdAt })),
      };
      return { id: `deals-waiting:${ctx.runId}`, kind: "deals-waiting", title: "Waiting for your tap", payload, links: [], runId: ctx.runId };
    },
  };

  // ── deals_draft_reply (draft) ──────────────────────────────────────────────────────────────────────────────────
  const termAskSchema = z.object({
    term: z.enum(TERM_KEYS as unknown as [TermKey, ...TermKey[]]),
    number: z.number().min(0).max(10_000_000).optional().describe("Their number for this term, in its unit."),
    yes: z.boolean().optional().describe("For yes / no terms (posting required, school disclosure, travel covered)."),
  });
  const draftArgs = z.object({
    deal_id: z.string().max(80),
    intent: z.enum(REPLY_INTENTS as unknown as [ReplyIntent, ...ReplyIntent[]]),
    term_asks: z.array(termAskSchema).max(8).optional(),
    tone: z.enum(TONES).optional(),
  });
  type DraftArgs = z.infer<typeof draftArgs>;

  /** The checks a reply passes before any model call: the deal is open, the intent fits its type, every number is hers. */
  async function checkReply(ctx: ToolContext, a: { deal_id: string; intent: ReplyIntent; term_asks?: TermAsk[] }): Promise<{ deal: DealDetailView } | { error: string }> {
    const got = await source.get(ctx.athleteId, a.deal_id.trim(), { includeClosed: false });
    if (!got.ok) return { error: errorFor(got) };
    const deal = got.value;
    const allowed = deal.type ? INTENTS_BY_TYPE[deal.type] : [];
    if (!deal.type || !intentAllowed(deal.type, a.intent)) {
      return { error: allowed.length
        ? `intent_not_allowed: a ${DEAL_TYPE_LABEL[deal.type!].toLowerCase()} deal allows ${allowed.join(", ")}. Pick one of those.`
        : "intent_not_allowed: this deal takes no reply from the chat (paperwork, or not a deal type Nomila knows). Point them to the deal." };
    }
    const asks = a.term_asks ?? [];
    const numbers = asks.flatMap((t) => (t.number != null ? [t.number] : []));
    const unsaid = unsaidNumbers(numbers, ctx.turn?.herWords ?? []);
    if (unsaid.length) return { error: `numbers_not_hers: ${unsaid.join(", ")} ${unsaid.length === 1 ? "was" : "were"} not said by the athlete in this conversation. Ask them for the number; never supply one.` };
    if (!FIGURE_INTENTS.includes(a.intent) && asks.some((t) => MONEY_TERMS.has(t.term) && t.number != null)) {
      return { error: `money_not_for_this_intent: only ${FIGURE_INTENTS.join(", ")} may carry a fee. Drop the fee, or use one of those intents if the deal allows it.` };
    }
    return { deal };
  }

  async function writeReply(ctx: ToolContext, deal: DealDetailView, intent: ReplyIntent, asks: TermAsk[], tone: Tone) {
    const draft = await source.draft(ctx.athleteId, deal, { intent, termAsks: asks, tone });
    if (!draft.ok) return { error: `${draft.reason}: ${draft.message}` } as const;
    const proposed = draft.sendable && deal.threadId
      ? await source.propose(ctx.athleteId, deal, { body: draft.body, intent, subject: draft.subject, to: draft.to })
      : { pendingActionId: "", bodySha256: "" };
    return { payload: replyCardPayload({ deal, intent, ...proposed, draft }) } as const;
  }

  const draftReply: AgentTool<typeof draftArgs> = {
    ...base, name: "deals_draft_reply", permission: "draft", description: DEALS_DRAFT_REPLY_DESCRIPTION,
    args: draftArgs, timeoutMs: 90_000,
    async prepare(ctx, a) {
      const c = await checkReply(ctx, a as DraftArgs & { intent: ReplyIntent });
      return "error" in c ? { error: c.error } : { args: a };
    },
    async execute(ctx, a) {
      const c = await checkReply(ctx, a as DraftArgs & { intent: ReplyIntent });
      if ("error" in c) return errorResult(c.error);
      const w = await writeReply(ctx, c.deal, a.intent as ReplyIntent, (a.term_asks ?? []) as TermAsk[], (a.tone ?? "friendly") as Tone);
      if ("error" in w) return errorResult(`not drafted: ${w.error}`);
      return okResult({
        drafted: true, intent: a.intent, sent: false,
        can_send_from_app: w.payload.sendable,
        ...(w.payload.sendable ? {} : { why_not: w.payload.whyNotSendable }),
        note: w.payload.sendable
          ? "NOT sent. They see the exact email with Send, Edit first and Not now; it goes out only if they tap Send. Don't repeat the email in your text."
          : "NOT sent, and it can't be sent from the app: the card shows the text to send from their own inbox. Say where.",
        _reply: w.payload,
      });
    },
    card(result, ctx) {
      const p = (result as { _reply?: Parameters<typeof replyCard>[0] })._reply;
      return p ? replyCard(p, ctx.runId) : null;
    },
  };

  // ── deals_close (her act, at once, with Undo) ──────────────────────────────────────────────────────────────────
  const closeArgs = z.object({
    deal_id: z.string().max(80),
    reason: z.enum(CLOSE_REASONS).describe("not_interested | not_a_deal | expired"),
    polite_no: z.boolean().optional().describe("Also write a short no for their approval (not sent until they tap Send)."),
  });
  const close: AgentTool<typeof closeArgs> = {
    ...base, name: "deals_close", permission: "draft", description: DEALS_CLOSE_DESCRIPTION,
    args: closeArgs, timeoutMs: 90_000,
    async execute(ctx, a) {
      const got = await source.get(ctx.athleteId, a.deal_id.trim(), { includeClosed: false });
      if (!got.ok) return errorResult(errorFor(got));
      const deal = got.value;
      const closed = await source.close(ctx.athleteId, deal.id, a.reason);
      if (!closed.ok) return errorResult(errorFor(closed));
      // The polite no: written from the deal as it was read, and proposed only after the close landed. Not sent.
      let politeNo: DealClosedCardPayload["politeNo"] = null;
      let politeNote: string | null = null;
      if (a.polite_no && a.reason !== "not_a_deal") {
        if (deal.type && intentAllowed(deal.type, "decline")) {
          const w = await writeReply(ctx, deal, "decline", [], "friendly");
          if ("error" in w) politeNote = `the polite no wasn't written (${w.error})`;
          else politeNo = w.payload;
        } else politeNote = "this kind of deal takes no reply from the chat";
      }
      return okResult({
        closed: true, reason: a.reason, by: "the athlete (their request)", undo: "on the card",
        sent_to_brand: false,
        polite_no: politeNo ? (politeNo.sendable ? "written, waiting for their Send" : "written, but it can't be sent from the app") : politeNote ?? "not asked for",
        _closed: {
          opportunityId: deal.id, brand: cardBrand(deal), reason: a.reason, reasonLabel: CLOSE_LABEL[a.reason],
          receiptId: closed.value.receiptId, actor: "you", politeNo,
        } satisfies DealClosedCardPayload,
      });
    },
    card(result, ctx) {
      const p = (result as { _closed?: DealClosedCardPayload })._closed;
      return p ? { id: `deal-closed:${ctx.runId}:${p.opportunityId}`, kind: "deal-closed", title: `Closed: ${p.brand.name}`, payload: p, links: [], runId: ctx.runId } : null;
    },
  };

  // ── deals_mark (propose: her tap runs it) ──────────────────────────────────────────────────────────────────────
  const markArgs = z.object({
    deal_id: z.string().max(80),
    mark: z.enum(MARKS).describe("signed | completed | reopen"),
    brand_label: z.string().max(80).optional().describe("Leave empty: Nomila fills it."),
  });
  const mark: AgentTool<typeof markArgs> = {
    ...base, name: "deals_mark", permission: "propose", description: DEALS_MARK_DESCRIPTION,
    args: markArgs,
    approval: {
      verb: "other_act",
      title: (a) => `${a.brand_label ? `${a.brand_label}: ` : ""}${MARK_TITLE[a.mark as Mark]}`,
      summary: (a) => MARK_SUMMARY[a.mark as Mark],
    },
    async prepare(ctx, a) {
      const got = await source.get(ctx.athleteId, a.deal_id.trim(), { includeClosed: a.mark === "reopen" });
      if (!got.ok) return { error: errorFor(got) };
      // The card names the brand in plain text (never shown to the model as an instruction).
      return { args: { ...a, deal_id: got.value.id, brand_label: got.value.brand.name.slice(0, 80) } };
    },
    async execute(ctx, a) {
      const r = await source.mark(ctx.athleteId, a.deal_id, a.mark as Mark);
      if (!r.ok) return errorResult(errorFor(r));
      return okResult({ marked: a.mark, receipt: r.value.receiptId });
    },
  };

  // ── deals_open ─────────────────────────────────────────────────────────────────────────────────────────────────
  const openArgs = z.object({
    where: z.enum(["deal", "board", "closed"]),
    deal_id: z.string().max(80).optional().describe("For where: deal."),
    why: z.string().max(200).optional(),
  });
  const open: AgentTool<typeof openArgs> = {
    ...base, name: "deals_open", permission: "read", description: DEALS_OPEN_DESCRIPTION,
    args: openArgs,
    async execute(ctx, a) {
      if (a.where === "deal") {
        if (!a.deal_id) return errorResult("deal_id is needed to open one deal");
        const got = await source.get(ctx.athleteId, a.deal_id.trim(), { includeClosed: true });
        if (!got.ok) return errorResult(errorFor(got));
        return okResult({ screen: "deal", id: got.value.id, label: got.value.brand.name.slice(0, 60), why: a.why ?? "" });
      }
      return okResult({ screen: a.where === "board" ? "deals" : "deals-closed", id: null, label: a.where === "board" ? "Your deals" : "Your past deals", why: a.why ?? "" });
    },
    card(result, ctx) {
      const r = result as { screen?: OpenScreenCardPayload["screen"]; id?: string | null; label?: string; why?: string };
      if (!r.screen) return null;
      const payload: OpenScreenCardPayload = { screen: r.screen, id: r.id ?? null, label: r.label ?? "", why: String(r.why ?? "").replace(/\s+/g, " ").trim() };
      return {
        id: `open:${ctx.runId}:${r.screen}:${r.id ?? ""}`, kind: "open-screen", title: payload.label, payload,
        links: [{ label: `Open ${payload.label}`, target: { screen: r.screen, ...(r.id ? { id: r.id } : {}) } }], runId: ctx.runId,
      };
    },
  };

  // ── brand_get ──────────────────────────────────────────────────────────────────────────────────────────────────
  const brandArgs = z.object({
    deal_id: z.string().max(80).optional(),
    brand_name: z.string().max(80).optional(),
  });
  const brand: AgentTool<typeof brandArgs> = {
    ...base, name: "brand_get", permission: "read", description: BRAND_GET_DESCRIPTION,
    args: brandArgs,
    async execute(ctx, a) {
      if (!a.deal_id && !a.brand_name) return errorResult("pass deal_id (preferred) or brand_name");
      const b = await source.brand(ctx.athleteId, { opportunityId: a.deal_id?.trim(), name: a.brand_name?.trim() });
      if (!b) return errorResult("not_found: no deal of theirs with that brand. Find it with deals_find.");
      if (!b.confirmed) return okResult({ brand: ext(b.name), confirmed: false, why: b.unconfirmedReason ?? "the research isn't confirmed to describe this company", note: "Say you can't judge the fit yet; don't guess." });
      return okResult({
        brand: ext(b.name), confirmed: true, category: ext(b.category), about: ext(b.description), audience: ext(b.audience),
        sports: b.sports.length ? ext(b.sports.join(", ")) : null, athletes: b.athletes.length ? ext(b.athletes.join(", ")) : null,
      });
    },
  };

  return [find, get, terms, waiting, draftReply as unknown as AgentTool, close as unknown as AgentTool, mark as unknown as AgentTool, open as unknown as AgentTool, brand as unknown as AgentTool];
}
