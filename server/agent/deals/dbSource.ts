/**
 * agent/deals/dbSource.ts — DealsSource on the app's own services. Every call is scoped to the run's athlete; nothing
 * here writes outside what her own taps already write.
 *
 *   find      the board (services/opportunityBoard — the ONE reader, so Mila's order is the screen's order) for open
 *             deals; All deals search (services/opportunitySearch) for done and closed ones
 *   get       the detail (services/opportunityDetail; a closed one read-only under DEALS_BOARD_V2)
 *   terms     the stored term sheet (DEALS_READ) row by row, and what is not known yet
 *   waiting   her pending send_reply proposals (drafts and ask-for-terms) still approvable
 *   draft     the type-aware reply skill (services/dealReply draftDealReply, OpenAI) — no send
 *   propose   ONE inert pending_actions send_reply row: her Send tap approves it with the body's hash
 *   close     services/dealDispose (the same code as her "Not for me" tap), receipt hers, with Undo
 *   mark      signed → skills/dealSigning confirmSigned; completed / reopen → services/dealMark (from her tap only)
 *   brand     the detail's brand deck: confirmed research only
 */
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxMessages, inboxThreads, opportunities, pendingActions } from "../../../shared/schema";
import { mailboxZeroRetentionEnabled } from "../../lib/mailbox/retention";
import { bodySha256 } from "../../../shared/bodyHash";
import { TERMS_BY_TYPE, TERM_KEYS, FIGURE_INTENTS, type TermKey } from "../../../shared/deals";
import { readOpportunityBoard } from "../../services/opportunityBoard";
import { readOpportunityDetail, type OpportunityDetail } from "../../services/opportunityDetail";
import { searchDeals } from "../../services/opportunitySearch";
import { draftDealReply } from "../../services/dealReply";
import { disposeDeal } from "../../services/dealDispose";
import { markDeal } from "../../services/dealMark";
import { confirmSigned } from "../../skills/dealSigning";
import { resolveThreadInbox } from "../../services/threadInbox";
import { resolveReplyEnvelope } from "../../services/replyEnvelope";
import { isStructurallySendable } from "../../lib/sendGate";
import { replyPlatform } from "../../lib/replyPlatforms";
import { AGENT } from "../config";
import { brandMatches, inRange, readOf, rowFromItem, rowFromSearch, termsOf } from "./map";
import { askWords, MONEY_TERMS, theirLine } from "./terms";
import type { DealDetailView, DealRow, DealsSource, DraftOutcome, Got, InboxKind, TermRow, WaitingItem } from "./source";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INBOXES: ReadonlySet<string> = new Set(["gmail", "outlook", "instagram", "nomila"]);
const HISTORY_LIMIT = 50;

/** Not hers: does the id exist for someone else? (Says only "not one of yours" — never anything about it.) */
async function existsForSomeoneElse(id: string): Promise<boolean> {
  const [o] = await db.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.id, id)).limit(1);
  return !!o;
}

function detailView(d: OpportunityDetail): DealDetailView {
  const row = rowFromItem(d.item);
  const ext = d as OpportunityDetail & { read_only?: boolean; closed?: { reason: string | null; at: string | null } | null; read?: DealDetailView["read"] };
  const closedReason = ext.closed?.reason;
  const reason = closedReason === "won" || closedReason === "declined" || closedReason === "expired" || closedReason === "not_relevant" ? closedReason : "declined";
  return {
    ...row,
    ...(ext.read_only ? { closed: { at: ext.closed?.at ?? "", reason }, section: "closed", whoseMove: "nobody", next: null } : {}),
    ask: d.ask,
    latestOffer: d.terms,
    read: ext.read ?? readOf(d.item),
    summary: d.item.whats_new?.text ?? null,
    unknowns: d.unknowns,
    replyPath: { sendable: false, inbox: null, why: null },
  };
}

async function replyPathOf(athleteId: string, threadId: string | null): Promise<{ sendable: boolean; inbox: InboxKind | null; why: string | null; inbound: Array<any> }> {
  if (!threadId) return { sendable: false, inbox: null, why: "there is no conversation to reply in", inbound: [] };
  const inbound = await db.select({
    sender_email: inboxMessages.sender_email, platform: inboxMessages.platform, external_message_id: inboxMessages.external_message_id,
    connected_account_id: inboxMessages.connected_account_id, gmail_thread_id: inboxMessages.gmail_thread_id,
    gmail_message_id_header: inboxMessages.gmail_message_id_header, received_at: inboxMessages.received_at,
  }).from(inboxMessages)
    .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "inbound")))
    .orderBy(desc(inboxMessages.received_at)).limit(10);
  const platform = inbound[0]?.platform ?? "gmail";
  const structural = isStructurallySendable({ threadId, hasInbound: inbound.length > 0, platform });
  const inbox = INBOXES.has(platform) ? (platform as InboxKind) : null;
  // The reply-platform table (lib/replyPlatforms.ts) that the send path dispatches through also says why a
  // card can't send: the platform's switch is off (Outlook without OUTLOOK_SEND), or — for a platform with a
  // per-grant send scope — the receiving inbox's grant can't send, so the tap would only meet "reconnect".
  const entry = replyPlatform(platform);
  let grantWhy: string | null = null;
  if (structural && entry?.grantCanSend && entry.reconnectWhy) {
    const stored = await resolveThreadInbox(athleteId, threadId).catch(() => null);
    if (stored && stored.platform === platform && stored.status === "active" && !stored.can_send) grantWhy = entry.reconnectWhy;
  }
  const sendable = structural && grantWhy === null;
  const why = sendable ? null
    : !inbound.length ? "they haven't written in this conversation yet"
    : grantWhy ?? (entry && !entry.enabled() && entry.offWhy ? entry.offWhy : "this conversation can't be answered from the app");
  return { sendable, inbox, why, inbound };
}

export const dbDealsSource: DealsSource = {
  async find(athleteId, q) {
    let rows: DealRow[] = [];
    if (q.filter !== "closed") {
      const board = await readOpportunityBoard(athleteId);
      const open = [...board.seriousOffers, ...board.needsYou, ...board.needsTermsBatch, ...board.inMotion, ...board.explore, ...board.goingQuiet];
      const seen = new Set<string>();
      for (const item of open) {
        if (seen.has(item.opportunity_id)) continue;
        seen.add(item.opportunity_id);
        rows.push(rowFromItem(item));
      }
      // The board's own order (Serious offers, What matters, the batch, In motion, Explore, To verify).
      const pos = new Map(board.order.map((id, i) => [id, i]));
      rows.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
      if (q.filter === "needs_you") rows = rows.filter((r) => r.whoseMove === "yours");
      if (q.filter === "in_motion") rows = rows.filter((r) => r.whoseMove !== "yours" && !!r.stage);
      if (q.filter === "waiting_on_them") rows = rows.filter((r) => r.section === "waiting_on_them");
    }
    if (q.filter === "closed" || q.filter === "all") {
      for (const tab of ["done", "closed"] as const) {
        const r = await searchDeals(athleteId, { q: q.brand ?? "", tab, limit: HISTORY_LIMIT });
        rows.push(...r.rows.map(rowFromSearch));
      }
    }
    rows = rows.filter((r) => brandMatches(r, q.brand) && inRange(r, q.from, q.to));
    return { rows: rows.slice(0, q.limit), total: rows.length };
  },

  async get(athleteId, id, opts) {
    if (!UUID.test(id)) return { ok: false, error: "not_found" };
    const d = await readOpportunityDetail(athleteId, id);
    if (d) {
      const view = detailView(d);
      if (view.closed && !opts.includeClosed) return { ok: false, error: "closed" };
      const path = await replyPathOf(athleteId, d.lead_thread_id);
      return { ok: true, value: { ...view, replyPath: { sendable: path.sendable && !view.closed, inbox: path.inbox, why: view.closed ? "this deal is closed" : path.why } } };
    }
    const [mine] = await db.select({ status: opportunities.status }).from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.athlete_id, athleteId))).limit(1);
    if (!mine) return { ok: false, error: (await existsForSomeoneElse(id)) ? "not_yours" : "not_found" };
    if (mine.status !== "closed") return { ok: false, error: "not_found" };
    if (!opts.includeClosed) return { ok: false, error: "closed" };
    // Closed, and the read-only detail is off (DEALS_BOARD_V2): the history row from All deals.
    for (const tab of ["done", "closed"] as const) {
      const r = await searchDeals(athleteId, { q: "", tab, limit: 500 });
      const hit = r.rows.find((x: { opportunity_id: string }) => x.opportunity_id === id);
      if (hit) {
        return { ok: true, value: { ...rowFromSearch(hit), ask: hit.ask, latestOffer: null, summary: null, unknowns: [], replyPath: { sendable: false, inbox: null, why: "this deal is closed" } } };
      }
    }
    return { ok: false, error: "not_found" };
  },

  async terms(athleteId, id) {
    const got = await this.get(athleteId, id, { includeClosed: true });
    if (!got.ok) return got;
    const d = await readOpportunityDetail(athleteId, id);
    const sheet = d ? termsOf(d.item) : null;
    const keys: readonly TermKey[] = got.value.type ? TERMS_BY_TYPE[got.value.type] : TERM_KEYS;
    const rows: TermRow[] = keys.map((k) => ({ term: k, theirs: sheet ? theirLine(k, sheet) : null, yours: null }));
    const unknown = sheet ? sheet.unknown.map(String) : got.value.unknowns;
    return { ok: true, value: { rows: sheet ? rows : [{ term: "offer", theirs: got.value.latestOffer, yours: null }], unknown } };
  },

  async waiting(athleteId) {
    const now = new Date();
    const rows = await db.select({
      id: pendingActions.id, payload: pendingActions.payload, created_at: pendingActions.created_at, deal_id: pendingActions.deal_id,
      brand_name: deals.brand_name, opportunity_id: deals.opportunity_id,
    }).from(pendingActions)
      .leftJoin(deals, eq(deals.id, pendingActions.deal_id))
      .where(and(
        eq(pendingActions.athlete_id, athleteId), eq(pendingActions.status, "pending"), eq(pendingActions.kind, "send_reply"),
        or(isNull(pendingActions.expires_at), gt(pendingActions.expires_at, now)),
      ))
      .orderBy(desc(pendingActions.created_at)).limit(25);
    return rows.map((r): WaitingItem => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const brand = r.brand_name ?? null;
      const askTerms = p.source === "ask_terms_batch";
      return {
        id: r.id, kind: askTerms ? "ask_terms" : "reply", opportunityId: r.opportunity_id ?? null, dealId: r.deal_id ?? null, brand,
        title: askTerms ? `Ask ${brand ?? "them"} for terms` : `Reply to ${brand ?? "them"}`,
        createdAt: (r.created_at ?? now).toISOString(),
      };
    });
  },

  async draft(athleteId, deal, p) {
    if (!deal.dealId) return { ok: false, reason: "no_thread", message: "this deal has no conversation to reply in" };
    const termAsks = p.termAsks.flatMap((a) => { const ask = askWords(a); return ask ? [{ term: a.term, ask }] : []; });
    const figure = FIGURE_INTENTS.includes(p.intent)
      ? p.termAsks.find((a) => MONEY_TERMS.has(a.term) && a.number != null)?.number ?? null
      : null;
    const r = await draftDealReply({ athleteId, dealId: deal.dealId, intent: p.intent, style: p.tone, termAsks, figure, threadId: deal.threadId });
    if (!r.ok) {
      const out: DraftOutcome = r.reason === "refusal" ? { ok: false, reason: "refused", message: r.message }
        : r.reason === "mailbox_unavailable" ? { ok: false, reason: "mailbox_unavailable", message: r.message }
        : r.reason === "not_found" ? { ok: false, reason: "no_thread", message: "the deal could not be found" }
        : r.reason === "intent_not_allowed" ? { ok: false, reason: "refused", message: `that reply doesn't fit this deal; allowed: ${r.allowed.join(", ")}` }
        : { ok: false, reason: "failed", message: "the reply could not be written" };
      return out;
    }
    const threadId = r.threadId ?? deal.threadId;
    const path = await replyPathOf(athleteId, threadId);
    const inbox = threadId ? await resolveThreadInbox(athleteId, threadId).catch(() => null) : null;
    // The same subject rule as the real send (threadReply): the thread's stored subject unless zero retention, then a
    // live read fills what's missing. Passing null here left the card's subject empty whenever the live read failed.
    const storedSubject = threadId && !mailboxZeroRetentionEnabled()
      ? (await db.select({ subject: inboxThreads.subject }).from(inboxThreads).where(eq(inboxThreads.id, threadId)).limit(1))[0]?.subject ?? null
      : null;
    const env = path.inbound.length && (path.inbox === "gmail" || path.inbox === "outlook")
      ? await resolveReplyEnvelope(storedSubject, path.inbound).catch(() => ({ toEmail: null, subject: storedSubject }))
      : { toEmail: null, subject: storedSubject };
    return {
      ok: true, body: r.fullText, subject: env.subject ? (/^re:/i.test(env.subject) ? env.subject : `Re: ${env.subject}`) : null,
      to: env.toEmail, from: inbox?.email ?? null, inbox: path.inbox, attachment: null,
      sendable: path.sendable, whyNotSendable: path.why,
    };
  },

  async propose(athleteId, deal, p) {
    const [row] = await db.insert(pendingActions).values({
      athlete_id: athleteId, deal_id: deal.dealId, thread_id: deal.threadId, kind: "send_reply", status: "pending",
      // reply_intent: D4 (skills/dealAgree) reads it when an approved accept should move the deal to Agreed.
      payload: { body: p.body, reply_intent: p.intent, source: "mila_chat", drafted_by: "mila", ...(p.subject ? { subject: p.subject } : {}) },
      expires_at: new Date(Date.now() + AGENT.APPROVAL_TTL_DAYS * 86_400_000),
    }).returning({ id: pendingActions.id });
    return { pendingActionId: row.id, bodySha256: bodySha256(p.body) };
  },

  async close(athleteId, id, reason) {
    const got = await this.get(athleteId, id, { includeClosed: false });
    if (!got.ok) return got;
    if (!got.value.dealId) return { ok: false, error: "not_found", detail: "this opportunity has no deal" };
    const r = await disposeDeal(athleteId, got.value.dealId, reason);
    return r.ok ? { ok: true, value: { receiptId: r.receiptId } } : { ok: false, error: "not_found" };
  },

  async mark(athleteId, id, what) {
    if (!UUID.test(id)) return { ok: false, error: "not_found" };
    if (what === "signed") {
      const r = await confirmSigned(athleteId, id);
      if (r.ok) return { ok: true, value: { done: what, receiptId: r.receipt_id } };
      return { ok: false, error: r.status === 404 ? "not_found" : "wrong_state", detail: r.error };
    }
    const r = await markDeal(athleteId, id, what);
    return r.ok ? { ok: true, value: { done: what, receiptId: r.receiptId } } : { ok: false, error: r.error, detail: r.detail };
  },

  async brand(athleteId, ref) {
    let id = ref.opportunityId ?? null;
    if (!id && ref.name) {
      const found = await this.find(athleteId, { filter: "all", brand: ref.name, limit: 1 });
      id = found.rows[0]?.id ?? null;
    }
    if (!id || !UUID.test(id)) return null;
    const d = await readOpportunityDetail(athleteId, id);
    if (!d) return null;
    const k = d.deck;
    return {
      name: k.name, confirmed: k.confirmed, category: k.category, description: k.description, audience: k.audience,
      sports: k.sports, athletes: k.athletes, unconfirmedReason: k.unconfirmed_reason,
    };
  },
};
