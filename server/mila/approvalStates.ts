/**
 * mila/approvalStates.ts — a saved chat's approval cards, with where each one stands NOW.
 *
 * A chat row keeps the cards exactly as that turn showed them (chat_messages.agent_cards), so an approval card is saved
 * "waiting for your tap" and a reopened chat would ask again for something she already sent. When a conversation is
 * loaded (GET /me/conversations/:id, both the old chat and chat v2 read it), every approval card gets its CURRENT state
 * from its pending_actions row as `payload.approval = { state, at }` (shared/agent.ts ApprovalCardStatus).
 *
 * Ownership: ONE query for the whole conversation, scoped by athlete_id first — `WHERE athlete_id = $me AND (id IN ids
 * OR payload->>'replaces' IN ids)`. A pendingActionId in a card is only ever a lookup key: an id that is not hers (or not
 * a uuid, or gone) matches nothing, and its card is left as it was saved (any `approval` stored on it dropped). Nothing about another athlete's row is
 * read, attached or logged. The stored cards are never changed; this only decorates the response.
 *
 * Cards that carry a pending action: `action` (payload.approvalId), `deal-reply` (payload.pendingActionId) and the
 * polite no inside `deal-closed` (payload.politeNo.pendingActionId). A reply she edited first went out as a NEW row that
 * names the card's row in `payload.replaces` (DealCards ReplyApproval), so that row's send counts as the card's.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { pendingActions } from "../../shared/schema";
import type { ApprovalCardStatus } from "../../shared/agent";
import { createLogger } from "../logger";

const logger = createLogger("mila/approvalStates");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A conversation is bounded, but the lookup is too: never more ids than this in one IN list. */
export const MAX_APPROVAL_LOOKUP = 500;

export interface PendingStateRow {
  id: string;
  status: string;
  replaces: string | null;
  expires_at: Date | null;
  approved_at: Date | null;
  dismissed_at: Date | null;
  executed_at: Date | null;
}

type Card = { kind?: unknown; payload?: unknown };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The payload object that carries a pending action id on this card, and the key it is under (null: none). */
function approvalSlot(card: unknown): { holder: Obj; key: "approvalId" | "pendingActionId" } | null {
  if (!isObj(card) || !isObj((card as Card).payload)) return null;
  const payload = (card as Card).payload as Obj;
  switch ((card as Card).kind) {
    case "action": return { holder: payload, key: "approvalId" };
    case "deal-reply": return { holder: payload, key: "pendingActionId" };
    case "deal-closed": return isObj(payload.politeNo) ? { holder: payload.politeNo, key: "pendingActionId" } : null;
    default: return null;
  }
}

function idOf(card: unknown): string | null {
  const slot = approvalSlot(card);
  const v = slot?.holder[slot.key];
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Every pending action id the cards name (deduplicated, uuids only, at most MAX_APPROVAL_LOOKUP). */
export function approvalIdsOf(cardLists: readonly (readonly unknown[] | null)[]): string[] {
  const ids = new Set<string>();
  for (const cards of cardLists) for (const c of cards ?? []) {
    const id = idOf(c);
    if (id && ids.size < MAX_APPROVAL_LOOKUP) ids.add(id);
  }
  return [...ids];
}

/**
 * One card's state from its own row and any row that replaced it (an edited reply), first match wins: a replacement
 * sent → sent; its own row approved → sent; failed → failed; dismissed → declined (or failed, when the edit that
 * replaced it failed); pending past its expiry → expired; pending → needs_approval. No row → null (leave the card).
 */
export function approvalStateOf(own: PendingStateRow | undefined, replacements: readonly PendingStateRow[], now = new Date()): ApprovalCardStatus | null {
  const replacedSent = replacements.find((r) => r.status === "approved");
  if (replacedSent) return { state: "sent", at: iso(replacedSent.executed_at ?? replacedSent.approved_at) };
  if (!own) return null;
  switch (own.status) {
    case "approved": return { state: "sent", at: iso(own.executed_at ?? own.approved_at) };
    case "failed": return { state: "failed", at: iso(own.executed_at) };
    case "dismissed": {
      const replacedFailed = replacements.find((r) => r.status === "failed");
      return replacedFailed ? { state: "failed", at: iso(replacedFailed.executed_at) } : { state: "declined", at: iso(own.dismissed_at) };
    }
    case "pending":
      return own.expires_at && own.expires_at.getTime() < now.getTime()
        ? { state: "expired", at: iso(own.expires_at) }
        : { state: "needs_approval", at: null };
    default: return null;
  }
}

/** The rows for these ids, hers only: one query, athlete-scoped before anything else. */
export async function loadApprovalRows(athleteId: string, ids: readonly string[]): Promise<PendingStateRow[]> {
  if (!ids.length) return [];
  const replaces = sql<string | null>`${pendingActions.payload}->>'replaces'`;
  return db
    .select({
      id: pendingActions.id,
      status: pendingActions.status,
      replaces,
      expires_at: pendingActions.expires_at,
      approved_at: pendingActions.approved_at,
      dismissed_at: pendingActions.dismissed_at,
      executed_at: pendingActions.executed_at,
    })
    .from(pendingActions)
    .where(and(
      eq(pendingActions.athlete_id, athleteId),
      or(inArray(pendingActions.id, [...ids]), inArray(replaces, [...ids])),
    ));
}

/**
 * The same messages, each approval card with `approval` attached (new card objects: the input is not changed). A card
 * whose id matched none of her rows (or is not a uuid) is returned as it was saved, less any `approval` stored on it.
 */
export async function withApprovalStates<M extends { agentCards: unknown[] | null }>(athleteId: string, messages: M[], now = new Date()): Promise<M[]> {
  const list = approvalIdsOf(messages.map((m) => m.agentCards));
  const ids = new Set(list);
  let rows: PendingStateRow[] = [];
  try {
    rows = await loadApprovalRows(athleteId, list);
  } catch (err) {
    // Reopening the chat must not fail on its decoration: the cards go out waiting (any stored state is still
    // dropped below), and the tap still claims the row at most once server-side.
    logger.warn({ athleteId, error: (err as Error).message }, "approval states not read; cards sent as waiting");
  }
  const own = new Map<string, PendingStateRow>();
  const replacedBy = new Map<string, PendingStateRow[]>();
  for (const r of rows) {
    if (ids.has(String(r.id).toLowerCase())) own.set(String(r.id).toLowerCase(), r);
    const rep = r.replaces ? r.replaces.toLowerCase() : null;
    if (rep && ids.has(rep)) replacedBy.set(rep, [...(replacedBy.get(rep) ?? []), r]);
  }
  // Only this lookup says where a card stands: an `approval` already on a stored card is never passed on.
  const set = (holder: Obj, status: ApprovalCardStatus | null): Obj => {
    const { approval: _stored, ...rest } = holder;
    return status ? { ...rest, approval: status } : rest;
  };
  const decorate = (card: unknown): unknown => {
    const slot = approvalSlot(card);
    if (!slot) return card;
    // A card whose id is unusable (not a uuid, missing) still loses any stored `approval`: it goes out waiting.
    const id = idOf(card);
    const status = id ? approvalStateOf(own.get(id), replacedBy.get(id) ?? [], now) : null;
    const c = card as Card & Obj;
    const payload = c.payload as Obj;
    if (c.kind === "deal-closed") return { ...c, payload: { ...payload, politeNo: set(payload.politeNo as Obj, status) } };
    return { ...c, payload: set(payload, status) };
  };
  return messages.map((m) => (m.agentCards ? { ...m, agentCards: m.agentCards.map(decorate) } : m));
}
