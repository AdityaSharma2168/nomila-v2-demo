/**
 * agent/deals/cards.ts — the chat cards the deal tools show, built by code from what the tools returned (never from
 * model prose). DESIGN.md §16: they render on the Mila card surface.
 */
import type { ChatCard, DealCardBrand, DealCardPayload, DealReplyCardPayload } from "../../../shared/agent";
import { DEAL_TYPE_LABEL, REPLY_INTENT_LABEL, type MoneyState, type ReplyIntent } from "../../../shared/deals";
import type { DealDetailView, DealRow } from "./source";

export const MONEY_WORDS: Record<MoneyState, string> = {
  above_min: "Meets your minimum",
  below_min: "Below your minimum",
  no_min: "No minimum set",
  no_fee: "No fee yet",
  commission_only: "Commission only",
  product_only: "Product only",
  unpaid: "Unpaid",
};

/** The one action a deal card offers, as the words she sends Mila on tap. By the next step's label (opportunityNext). */
const ACTION_BY_LABEL: Array<[RegExp, string, (b: string) => string]> = [
  [/accept or counter/i, "Accept or counter", (b) => `Help me accept or counter ${b}`],
  [/counter/i, "Draft the counter", (b) => `Draft the counter for ${b}`],
  [/ask for terms/i, "Ask for terms", (b) => `Ask ${b} for their terms`],
  [/signed/i, "It's signed", (b) => `The ${b} deal is signed`],
  [/who they are/i, "Ask who they are", (b) => `Ask ${b} who they are`],
  [/decline/i, "Say no nicely", (b) => `Tell ${b} no, nicely`],
  [/reply/i, "Draft a reply", (b) => `Draft a reply to ${b}`],
];

export function cardBrand(r: Pick<DealRow, "brand">): DealCardBrand {
  return { name: r.brand.name, logoUrl: r.brand.logoUrl, domain: r.brand.domain, isPerson: r.brand.isPerson };
}

export function moveLabel(r: DealRow): string {
  if (r.closed) return r.closed.reason === "won" ? "Done" : "Closed";
  if (r.whoseMove === "yours") return "Your move";
  if (r.whoseMove === "theirs") return r.stage && r.stage !== "In progress" ? r.stage : "Waiting on them";
  return r.stage ?? "In motion";
}

export function dealCard(r: DealRow | DealDetailView, runId: string): ChatCard {
  const read = r.read;
  const chips: string[] = [MONEY_WORDS[read?.money.state ?? r.moneyState]];
  if (read) {
    chips.push(read.risk.flags.length ? read.risk.line : "Nothing to flag");
    if (read.goal && !/money only/i.test(read.goal.line)) chips.push("Helps a goal");
  }
  const hit = !r.closed && r.next ? ACTION_BY_LABEL.find(([re]) => re.test(r.next!.label)) : undefined;
  const payload: DealCardPayload = {
    opportunityId: r.id,
    brand: cardBrand(r),
    typeLabel: r.kindLabel ?? (r.type ? DEAL_TYPE_LABEL[r.type] : null),
    moneyLine: read?.money.line ?? r.moneyLine,
    whoseMove: r.whoseMove,
    moveLabel: moveLabel(r),
    chips: chips.slice(0, 3),
    action: hit ? { label: hit[1], message: hit[2](r.brand.name) } : null,
    closed: !!r.closed,
  };
  return {
    id: `deal:${runId}:${r.id}`, kind: "deal", title: r.brand.name, payload,
    links: [{ label: "Open deal", target: { screen: "deal", id: r.id } }], runId,
  };
}

export function replyCardPayload(p: {
  deal: DealDetailView; intent: ReplyIntent; pendingActionId: string; bodySha256: string;
  draft: { body: string; subject: string | null; to: string | null; from: string | null; inbox: DealReplyCardPayload["inbox"]; attachment: string | null; sendable: boolean; whyNotSendable: string | null };
}): DealReplyCardPayload {
  return {
    pendingActionId: p.pendingActionId, bodySha256: p.bodySha256, opportunityId: p.deal.id, dealId: p.deal.dealId ?? "",
    threadId: p.deal.threadId, brand: cardBrand(p.deal), intent: p.intent, intentLabel: REPLY_INTENT_LABEL[p.intent],
    inbox: p.draft.inbox, from: p.draft.from, to: p.draft.to, subject: p.draft.subject, attachment: p.draft.attachment,
    body: p.draft.body, sendable: p.draft.sendable, whyNotSendable: p.draft.whyNotSendable,
  };
}

export function replyCard(payload: DealReplyCardPayload, runId: string): ChatCard {
  return {
    id: `deal-reply:${payload.pendingActionId || runId}`, kind: "deal-reply",
    title: `${payload.intentLabel}: ${payload.brand.name}`, payload,
    links: [{ label: "Open deal", target: { screen: "deal", id: payload.opportunityId } }], runId,
  };
}
