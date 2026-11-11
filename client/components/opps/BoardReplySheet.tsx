// BoardReplySheet — the reply sheet opened straight from a board card's Reply (one tap, no detail first). It is the
// detail's own ReplySheet: the same deal, thread, type answers and terms, on the intent the card suggested, and Nomila's
// saved draft for the thread when there is one (read from the detail, so a saved draft is shown, not drafted afresh).
import React from "react";
import type { BoardItem } from "../../hooks/use-opportunity-board";
import { useOpportunityDetail } from "../../hooks/use-opportunity-detail";
import { ReplySheet } from "../deals/ReplySheet";
import type { ReplyIntent } from "../../../shared/deals";

interface Props {
  item: BoardItem;
  intent: ReplyIntent;
  onClose: () => void;
  onSent: () => void;
}

export function BoardReplySheet({ item, intent, onClose, onSent }: Props) {
  const { data, isLoading } = useOpportunityDetail(item.opportunity_id);
  // Wait for the saved draft (a failed read just drafts afresh) so the sheet never drafts over one.
  if (isLoading || !item.lead_deal_id) return null;
  return (
    <ReplySheet
      dealId={item.lead_deal_id}
      threadId={item.lead_thread_id}
      brandName={item.brand.name}
      dealType={item.dealType}
      actions={item.actions ?? []}
      terms={item.terms}
      initialIntent={intent}
      seededDraft={data?.draft ?? null}
      onClose={onClose}
      onSent={onSent}
    />
  );
}
