/**
 * cards/MilaCardView — one chat v2 card (a `data-mila-card` DTO) drawn with the EXISTING card component for its kind
 * (components/agent/AgentCard: the deal card, the reply approval, the action approval, connect, how-I-got-this …), inside
 * the chat's error boundary, so a bad card never takes the conversation down. Approval cards keep their own flow:
 * the ActionCard's Approve goes through useApprovalTap (POST /api/v1/me/pending-actions/:id/approve, claimed at most once
 * server-side) and shows needs-approval, sent and error itself; the deal reply card goes through approvePendingAction.
 *
 * With EXPO_PUBLIC_MILA_CARDS_V2 on, the card system v2's kinds (Insight, Idea, Turn-on offer, One-time question,
 * Answer, and the deal as a row card) are drawn by the card kit (cards/kit) instead, collapsed, expanding in place.
 *
 * A type with no view (or a DTO that fails the shared schema) draws nothing and is logged once per card id.
 * Knows nothing about the chat library: it takes a plain DTO.
 */
import React from "react";
import { checkMilaCardDto } from "../../../../shared/milaCards";
import { AgentCard } from "../../agent/AgentCard";
import { ErrorBoundary } from "../ErrorBoundary";
import { logger } from "../../../lib/logger";
import { MILA_CARDS_V2 } from "../../../lib/flags";
import { toChatCard } from "./toChatCard";
import { hasKitView, KitCard } from "./kit";

const logged = new Set<string>();

export function MilaCardView({ dto, cardsV2 = MILA_CARDS_V2 }: { dto: unknown; cardsV2?: boolean }) {
  if (cardsV2) {
    const checked = checkMilaCardDto(dto);
    if (checked && hasKitView(checked)) return <ErrorBoundary><KitCard dto={checked} /></ErrorBoundary>;
  }
  const r = toChatCard(dto);
  if (!r.ok) {
    const key = `${r.type}:${String((dto as { data?: { id?: unknown } } | null)?.data?.id ?? "")}`;
    if (!logged.has(key)) {
      logged.add(key);
      logger.warn(`[mila] card not drawn (${r.reason}): ${r.type || "unknown type"}`);
    }
    return null;
  }
  return (
    <ErrorBoundary>
      {/* The server sends the run's how-i-got-this card itself, so the action card never fetches its own. */}
      <AgentCard card={r.card} turnHasHow />
    </ErrorBoundary>
  );
}
