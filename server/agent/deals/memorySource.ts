/**
 * agent/deals/memorySource.ts — DealsSource in memory, for the unit tests and the chat eval's deal cases. Made-up deals
 * only; never a database, a mailbox or a model. The "draft" is a fixed template that states exactly the term asks it
 * was given (the real reply skill is services/dealReply, tested on its own), so the graders can see whether a figure
 * reached a reply.
 */
import { createHash } from "node:crypto";
import { REPLY_INTENT_LABEL, type DealRead, type DealType, type MoneyState, type TermSheet } from "../../../shared/deals";
import { bodySha256 } from "../../../shared/bodyHash";
import { brandMatches, inRange } from "./map";
import { askWords } from "./terms";
import type { BrandView, CloseReason, DealDetailView, DealRow, DealsSource, Got, Mark, WaitingItem } from "./source";

export interface MemoryDeal {
  /** A case-local key ("d1"); the id is derived from it. */
  key: string;
  brand: string;
  brandConfirmed?: boolean;
  /** Research shown by brand_get (confirmed only). */
  research?: { category?: string; about?: string; audience?: string };
  type: DealType | null;
  moneyLine: string;
  moneyState: MoneyState;
  whoseMove: "yours" | "theirs" | "nobody";
  stage?: string | null;
  next?: { label: string; why: string } | null;
  ask?: string | null;
  latestOffer?: string | null;
  /** Derived from brand email: may hold an injection attempt (the eval's injection cases). */
  summary?: string | null;
  read?: DealRead | null;
  terms?: TermSheet | null;
  closed?: { at: string; reason: "won" | "declined" | "expired" | "not_relevant" } | null;
  lastActivity?: string;
  sendable?: boolean;
  inbox?: "gmail" | "outlook" | "instagram" | "nomila";
  /** Another athlete's deal (not_yours). */
  foreign?: boolean;
}

/** A stable uuid-shaped id for a case-local key. */
export function memoryDealId(key: string): string {
  const h = createHash("sha1").update(`deal:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface MemoryDealsSource extends DealsSource {
  deals: MemoryDeal[];
  proposals: Array<{ id: string; dealKey: string; body: string; intent: string; status: "pending" | "approved" | "dismissed" }>;
  closes: Array<{ dealKey: string; reason: CloseReason }>;
  marks: Array<{ dealKey: string; what: Mark }>;
  drafts: Array<{ dealKey: string; intent: string; termAsks: unknown[] }>;
}

export function createMemoryDealsSource(seed: MemoryDeal[], opts: { athleteName?: string } = {}): MemoryDealsSource {
  const deals = seed.map((d) => ({ ...d }));
  const byId = (id: string) => deals.find((d) => memoryDealId(d.key) === id) ?? null;
  const row = (d: MemoryDeal): DealRow => ({
    id: memoryDealId(d.key), dealId: memoryDealId(`${d.key}:deal`), threadId: memoryDealId(`${d.key}:thread`),
    brand: { name: d.brand, logoUrl: null, domain: null, isPerson: false, confirmed: d.brandConfirmed ?? false },
    type: d.type, kindLabel: null, moneyLine: d.moneyLine, moneyState: d.moneyState, read: d.read ?? null,
    whoseMove: d.closed ? "nobody" : d.whoseMove,
    section: d.closed ? "closed" : d.whoseMove === "yours" ? "needs_you" : d.whoseMove === "theirs" ? "waiting_on_them" : "in_motion",
    stage: d.stage ?? null, next: d.closed || !d.next ? null : { ...d.next, due: null },
    startedAt: d.lastActivity ?? null, lastActivityAt: d.lastActivity ?? null, closed: d.closed ?? null,
  });
  const detail = (d: MemoryDeal): DealDetailView => ({
    ...row(d), ask: d.ask ?? null, latestOffer: d.latestOffer ?? null, summary: d.summary ?? null,
    unknowns: d.terms?.unknown.map(String) ?? [],
    replyPath: { sendable: !d.closed && (d.sendable ?? true), inbox: d.inbox ?? "gmail", why: d.closed ? "this deal is closed" : d.sendable === false ? "replies to Outlook mail are sent from Outlook for now" : null },
  });
  const order = (r: DealRow) => (r.whoseMove === "yours" ? 0 : r.closed ? 2 : 1);
  const lookup = (id: string, includeClosed: boolean): Got<MemoryDeal> => {
    const d = byId(id);
    if (!d) return { ok: false, error: "not_found" };
    if (d.foreign) return { ok: false, error: "not_yours" };
    if (d.closed && !includeClosed) return { ok: false, error: "closed" };
    return { ok: true, value: d };
  };

  const src: MemoryDealsSource = {
    deals, proposals: [], closes: [], marks: [], drafts: [],
    async find(_a, q) {
      let rows = deals.filter((d) => !d.foreign).map(row).sort((a, b) => order(a) - order(b));
      if (q.filter === "needs_you") rows = rows.filter((r) => r.whoseMove === "yours");
      else if (q.filter === "in_motion") rows = rows.filter((r) => !r.closed && r.whoseMove !== "yours" && !!r.stage);
      else if (q.filter === "waiting_on_them") rows = rows.filter((r) => !r.closed && r.whoseMove === "theirs");
      else if (q.filter === "closed") rows = rows.filter((r) => !!r.closed);
      rows = rows.filter((r) => brandMatches(r, q.brand) && inRange(r, q.from, q.to));
      return { rows: rows.slice(0, q.limit), total: rows.length };
    },
    async get(_a, id, o) {
      const g = lookup(id, o.includeClosed);
      return g.ok ? { ok: true, value: detail(g.value) } : g;
    },
    async terms(_a, id) {
      const g = lookup(id, true);
      if (!g.ok) return g;
      const t = g.value.terms;
      return { ok: true, value: { rows: t ? Object.entries(t).filter(([k]) => k !== "unknown").map(([k, v]) => ({ term: k, theirs: JSON.stringify(v), yours: null })) : [], unknown: t?.unknown.map(String) ?? [] } };
    },
    async waiting() {
      return src.proposals.filter((p) => p.status === "pending").map((p): WaitingItem => {
        const d = deals.find((x) => x.key === p.dealKey)!;
        return { id: p.id, kind: "reply", opportunityId: memoryDealId(d.key), dealId: memoryDealId(`${d.key}:deal`), brand: d.brand, title: `Reply to ${d.brand}`, createdAt: "2026-10-10T12:00:00.000Z" };
      });
    },
    async draft(_a, deal, p) {
      const d = byId(deal.id)!;
      src.drafts.push({ dealKey: d.key, intent: p.intent, termAsks: p.termAsks });
      const asks = p.termAsks.map(askWords).filter(Boolean);
      const name = opts.athleteName ?? "Me";
      const body = `Hi ${d.brand} team,\n\nThanks for reaching out. ${REPLY_INTENT_LABEL[p.intent]}${asks.length ? `: ${asks.join(", ")}` : ""}.\n\nBest,\n${name}`;
      return {
        ok: true, body, subject: `Re: ${d.brand}`, to: `partners@${d.brand.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`, from: "me@example.com",
        inbox: d.inbox ?? "gmail", attachment: null, sendable: d.sendable ?? true, whyNotSendable: d.sendable === false ? "replies to Outlook mail are sent from Outlook for now" : null,
      };
    },
    async propose(_a, deal, p) {
      const d = byId(deal.id)!;
      const id = memoryDealId(`${d.key}:proposal:${src.proposals.length + 1}`);
      src.proposals.push({ id, dealKey: d.key, body: p.body, intent: p.intent, status: "pending" });
      return { pendingActionId: id, bodySha256: bodySha256(p.body) };
    },
    async close(_a, id, reason) {
      const g = lookup(id, false);
      if (!g.ok) return g;
      src.closes.push({ dealKey: g.value.key, reason });
      g.value.closed = { at: "2026-10-10", reason: reason === "expired" ? "expired" : reason === "not_a_deal" ? "not_relevant" : "declined" };
      return { ok: true, value: { receiptId: memoryDealId(`${g.value.key}:receipt`) } };
    },
    async mark(_a, id, what) {
      const g = lookup(id, true);
      if (!g.ok) return g;
      src.marks.push({ dealKey: g.value.key, what });
      return { ok: true, value: { done: what, receiptId: memoryDealId(`${g.value.key}:mark`) } };
    },
    async brand(_a, ref): Promise<BrandView | null> {
      const d = ref.opportunityId ? byId(ref.opportunityId) : deals.find((x) => !x.foreign && ref.name && x.brand.toLowerCase().includes(ref.name.toLowerCase()));
      if (!d || d.foreign) return null;
      const ok = d.brandConfirmed ?? false;
      return {
        name: d.brand, confirmed: ok, category: ok ? d.research?.category ?? null : null, description: ok ? d.research?.about ?? null : null,
        audience: ok ? d.research?.audience ?? null : null, sports: [], athletes: [], unconfirmedReason: ok ? null : "Nomila couldn't confirm the research describes this company.",
      };
    },
  };
  return src;
}
