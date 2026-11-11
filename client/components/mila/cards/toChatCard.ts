/**
 * cards/toChatCard — a chat v2 card DTO (shared/milaCards.ts, the `data-mila-card` part) as the ChatCard shape the
 * existing card components already draw (components/agent/AgentCard). The DTO is the ChatCard's own fields, checked by
 * the shared schema, so this only puts them back where the components read them:
 *
 *   { type, data: { id, title, links, fields } }  →  { id, kind: type, title, links, payload: fields }
 *
 * plus the one renamed field: the approval card's `pendingActionId` is the ActionCard's `approvalId` (the same
 * pending_actions row, approved through the existing POST /api/v1/me/pending-actions/:id/approve), and an approval's
 * `state` / `stateAt` (a saved chat's card: where its row stands now) become the card's `approval`. Knows nothing about
 * the chat library.
 */
import { checkMilaCardDto, type MilaCardType } from "../../../../shared/milaCards";
import { isKnownKind } from "../../../lib/agent/cardLogic";
import type { AnyChatCard } from "../../../lib/agent/types";
import type { ApprovalCardState } from "../../../../shared/agent";

/** Card types the stream can carry that have no view yet: drawn as nothing (and logged), never as a broken card. */
export const NO_VIEW_YET: ReadonlySet<MilaCardType> = new Set<MilaCardType>(["goal-change", "waitlist-card"]);

export type ToChatCard =
  | { ok: true; card: AnyChatCard }
  | { ok: false; reason: "invalid" | "no_view"; type: string };

/** The wire's `state` / `stateAt` as the card's `approval` (what a saved chat's card says it is now). A waiting card has
 *  no `approval`: it opens as it always has. */
function withApproval(fields: Record<string, unknown>): Record<string, unknown> {
  const { state, stateAt, ...rest } = fields as { state?: ApprovalCardState; stateAt?: string | null };
  if (!state || state === "needs_approval") return rest;
  return { ...rest, approval: { state, at: stateAt ?? null } };
}

export function toChatCard(dto: unknown): ToChatCard {
  const checked = checkMilaCardDto(dto);
  const rawType = typeof (dto as { type?: unknown } | null)?.type === "string" ? String((dto as { type: string }).type) : "";
  if (!checked) return { ok: false, reason: "invalid", type: rawType };
  if (NO_VIEW_YET.has(checked.type) || !isKnownKind(checked.type)) return { ok: false, reason: "no_view", type: checked.type };
  const { id, title, links, fields } = checked.data as { id: string; title: string; links: unknown[]; fields: Record<string, unknown> };
  let payload: Record<string, unknown> = fields;
  if (checked.type === "action") {
    const { pendingActionId, ...rest } = fields as { pendingActionId: string };
    payload = { ...withApproval(rest), approvalId: pendingActionId };
  } else if (checked.type === "deal-reply") {
    payload = withApproval(fields);
  } else if (checked.type === "deal-closed" && fields.politeNo && typeof fields.politeNo === "object") {
    payload = { ...fields, politeNo: withApproval(fields.politeNo as Record<string, unknown>) };
  }
  return { ok: true, card: { id, kind: checked.type, title, links, payload } as unknown as AnyChatCard };
}
