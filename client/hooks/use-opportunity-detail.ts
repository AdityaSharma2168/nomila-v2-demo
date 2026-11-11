// The card's detail (Opportunities PR 4): GET /api/v1/me/opportunities/:id — the brand deck + Nomila's letter.
// Every field is derived; the email itself is read live from the thread (Conversation), never from here.
import { useQuery } from "@tanstack/react-query";
import type { BoardItem } from "./use-opportunity-board";
import type { DealRead } from "../../shared/deals";

/** A signed PDF on file Nomila can offer to read into the deal's terms (her tap). */
export interface ContractCandidate { thread_id: string; message_id: string; index: number; filename: string; at: string | null }

export type PrimaryAction = "ask_for_terms" | "accept_or_counter" | "counter" | "reply" | "decline";

export interface OpportunityDetail {
  item: BoardItem;
  /** A closed opportunity, shown as history: no action to take (DEALS_BOARD_V2). */
  read_only?: boolean;
  /** Why and when it closed (won · declined · expired · not_relevant). */
  closed?: { reason: string | null; at: string | null } | null;
  /** The four-line read; replaces "Why it's here" and "Nomila's take" on screen. Absent while DEALS_READ is off. */
  read?: DealRead;
  ask: string | null;
  reasons: Array<{ text: string; source: string }>;
  unknowns: string[];
  take: string;
  primary: { action: PrimaryAction; label: string };
  secondary: Array<{ action: "decline" | "verify" | "open_deal"; label: string }>;
  draft: string | null;
  terms: string | null;
  looks_signed: boolean;
  signed_evidence: Array<{ kind: "summary" | "paperwork" | "legacy_esign" | "attachment"; deal_id: string; thread_id: string; at: string | null; filename?: string }>;
  signed_target_deal_id: string | null;
  signed: { deal_id: string; at: string; source: string } | null;
  contract_candidate: ContractCandidate | null;
  has_contract: boolean;
  lead_deal_id: string | null;
  lead_thread_id: string | null;
  deck: {
    confirmed: boolean;
    name: string;
    category: string | null;
    description: string | null;
    audience: string | null;
    sports: string[];
    athletes: string[];
    images: string[];
    unconfirmed_reason: string | null;
  };
}

export const opportunityDetailKey = (id: string) => `/api/v1/me/opportunities/${id}`;

export function useOpportunityDetail(id: string) {
  return useQuery<OpportunityDetail>({ queryKey: [opportunityDetailKey(id)] });
}
