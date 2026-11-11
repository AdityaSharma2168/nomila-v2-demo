// The brand page (docs/design/brand-page-deals.md D5): GET /api/v1/me/opportunities/:id/brand — every deal she has
// with the opportunity's brand, open or signed, each with its status, take, ONE primary action, paperwork and
// conversation. Derived fields only; the email itself is read live from the thread.
import { useQuery } from "@tanstack/react-query";
import type { ContractCandidate, PrimaryAction } from "./use-opportunity-detail";

export interface BrandPaperworkRow {
  thread_id: string;
  /** "meeting": a calendar invite recorded on the deal — label reads "Call · Mon 12 Oct, 11am". */
  event: "signature_requested" | "reminder" | "completed" | "payment_sent" | "payment_received" | "status" | "meeting";
  label: string;
  at: string | null;
  files: Array<{ message_id: string; index: number; filename: string; signed: boolean }>;
}

export interface BrandConversationChain {
  chain_id: string;
  message_count: number;
  first_at: string | null;
  last_at: string | null;
  first_direction: "inbound" | "outbound" | null;
  main: boolean;
}

export interface BrandSection {
  opportunity_id: string;
  opportunity_status: "open" | "won";
  /** A closed deal is history (server); an older server omits it and opportunity_status decides. */
  read_only?: boolean;
  deal_id: string;
  label: string;
  pitched_by_you: boolean;
  take: string;
  primary: { action: PrimaryAction | "open_thread"; label: string };
  needs_her: boolean;
  looks_signed: boolean;
  signed: { at: string; source: string } | null;
  signed_evidence: Array<{ kind: "summary" | "paperwork" | "legacy_esign" | "attachment"; deal_id: string; thread_id: string; at: string | null; filename?: string }>;
  contract_candidate: ContractCandidate | null;
  has_contract: boolean;
  paperwork: BrandPaperworkRow[];
  conversation: { thread_id: string; message_count: number; last_at: string | null; chains: BrandConversationChain[] } | null;
  /** First message of the deal's conversation (its message dates, never a row timestamp). Older servers: absent. */
  started_at?: string | null;
  last_activity_at: string | null;
  shares_opportunity: boolean;
}

export interface BrandPage {
  brand: { id: number | null; name: string };
  sections: BrandSection[];
  open_section: string | null;
}

export const brandPageKey = (opportunityId: string) => `/api/v1/me/opportunities/${opportunityId}/brand`;

export function useBrandPage(opportunityId: string) {
  return useQuery<BrandPage>({ queryKey: [brandPageKey(opportunityId)] });
}
