/**
 * dealSigning.ts — "Looks signed — confirm?" and her Yes (docs/design/brand-page-deals.md D1–D3).
 *
 * "Signed" is HER confirmed fact: deals.signed_at (+ signed_source). Nothing here infers it. readSigning only
 * gathers EVIDENCE that an opportunity's deal reads signed, across every member — the summariser's stage on any
 * member thread, an e-sign "completed" paperwork marker matched to a member, a pre-#777 e-sign pseudo-deal that
 * reads signed, or a PDF named signed / executed on any of those threads. The flag is shown; the state changes
 * only in confirmSigned, which runs on her tap:
 *
 *   1. the target deal gets signed_at / signed_source = 'confirmed', and its status is lifted to `accepted` when
 *      it is below it (forward only — never off completed / rejected), so every status reader agrees;
 *   2. the opportunity closes as `won` — the only live won-close. After it, openFor sees no open row for the
 *      brand, so the next new deal from that brand opens its own opportunity;
 *   3. a reversible receipt (agent_actions 'confirm_signed'). Undo clears signed_at, restores the status and
 *      reopens the opportunity (routes/agentActions.ts).
 *
 * The TARGET is never a pseudo-deal: evidence that sits on a legacy e-sign deal or a paperwork marker points at
 * the opportunity's most advanced real member.
 *
 * Tenancy: every query filters the athlete.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxMessages, inboxThreads, opportunities, type InboxAttachment } from "../../shared/schema";
import { isWorkflowDomain } from "../lib/senderProfile";
import { DEAL_STATUS_RANK, observedStageOf } from "../lib/observedStage";
import { readPaperwork, paperworkEvent, type PaperworkEvent } from "./paperwork";
import { lockBrand } from "./opportunities";
import { readMeeting } from "./meetings";
import { writeAgentAction } from "../lib/agentActions";
import { createLogger } from "../logger";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";

const logger = createLogger("skills/dealSigning");

export type EvidenceKind = "summary" | "paperwork" | "legacy_esign" | "attachment";

export interface SignedEvidence {
  kind: EvidenceKind;
  deal_id: string;
  thread_id: string;
  at: string | null;
  filename?: string;
}

/** A file Nomila can offer to read into the deal's terms (her tap; routes/dealContracts from-attachment). */
export interface ContractCandidate {
  thread_id: string;
  message_id: string;
  index: number;
  filename: string;
  at: string | null;
}

export interface OpportunitySigning {
  /** The member deal she confirmed signed, if any. */
  signed: { deal_id: string; at: string; source: string } | null;
  looks_signed: boolean;
  /** The deal her Yes would mark signed: a real member, never a paperwork pseudo-deal. */
  target_deal_id: string | null;
  evidence: SignedEvidence[];
  contract_candidate: ContractCandidate | null;
  /** The target (or signed) deal already holds a contract read from a file. */
  has_contract: boolean;
}

/** A filename that says the document was signed. `unsigned` never matches (word boundary). */
const SIGNED_FILE = /(^|[^a-z])(signed|executed|countersigned|fully[ _-]?executed)([^a-z]|$)/i;
const isPdf = (a: InboxAttachment) => /pdf/i.test(a.content_type ?? "") || /\.pdf$/i.test(a.filename ?? "");
export function looksLikeSignedFile(a: Pick<InboxAttachment, "filename" | "content_type">): boolean {
  return isPdf(a as InboxAttachment) && SIGNED_FILE.test(a.filename ?? "");
}

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** A thread minted as a deal from an e-sign / payment provider before #777: paperwork, not a deal. */
export function isLegacyPaperworkThread(classification: unknown): boolean {
  const c = (classification ?? {}) as Record<string, any>;
  if (c.paperwork) return false;
  const d = typeof c.brand_domain === "string" ? c.brand_domain.toLowerCase() : "";
  return !!d && isWorkflowDomain(d);
}

/**
 * The event a legacy e-sign thread reads as: the provider's own words in the stored subject (null under zero
 * retention) and Nomila's summary, as paperworkEvent reads them; only when those say nothing does the summariser's
 * "signed" stage count as completed. (The summariser read every gorjana e-sign thread as "signed", including the
 * signature requests and reminders, so the stage alone over-reads.)
 */
export function legacyPaperworkEvent(t: { classification: unknown; conversation_state: unknown; summary?: string | null; subject?: string | null }): PaperworkEvent {
  const c = (t.classification ?? {}) as Record<string, any>;
  const event = paperworkEvent(typeof c.brand_domain === "string" ? c.brand_domain : null, t.subject ?? "", t.summary ?? "").event;
  if (event !== "status") return event;
  return observedStageOf(t.conversation_state) === "signed" ? "completed" : "status";
}

export interface MemberDeal {
  id: string; opportunity_id: string; status: string | null; signed_at: Date | string | null; signed_source: string | null;
  term_end: string | null; detected_at: Date | string | null; direction: string | null; raw_data: unknown; brand_name: string | null;
}
export interface MaterialThread {
  id: string; deal_id: string | null; classification: unknown; conversation_state: unknown; summary: string | null;
  /** Server-side only, for reading a legacy e-sign provider's own words; never sent to a client. Null under zero retention. */
  subject: string | null;
  message_count: number | null; last_message_at: Date | string | null; alias_thread_ids: string[] | null;
  /** The real deal this thread belongs to (its own deal, a paperwork / meeting marker's deal, or a legacy pseudo-deal's target). */
  belongs_to: string | null;
  role: "conversation" | "paperwork" | "legacy_paperwork" | "meeting";
}
export interface AttachmentRow { thread_id: string; message_id: string; at: string | null; attachments: InboxAttachment[] }

export interface OpportunityMaterial {
  members: MemberDeal[];
  /** Member deals that are real (not a pre-#777 paperwork pseudo-deal). */
  real: MemberDeal[];
  threads: MaterialThread[];
  attachments: AttachmentRow[];
}

/** Most advanced real member: stored status, then most messages, then newest. */
function bestReal(real: MemberDeal[], threads: MaterialThread[]): MemberDeal | null {
  const msgs = (id: string) => threads.filter((t) => t.deal_id === id).reduce((n, t) => n + (Number(t.message_count) || 0), 0);
  return [...real].sort((a, b) =>
    (DEAL_STATUS_RANK[b.status ?? ""] ?? -1) - (DEAL_STATUS_RANK[a.status ?? ""] ?? -1)
    || msgs(b.id) - msgs(a.id)
    || String(iso(b.detected_at) ?? "").localeCompare(String(iso(a.detected_at) ?? "")))[0] ?? null;
}

/**
 * Everything one or more opportunities hold, for HER only: member deals, their threads, paperwork threads matched
 * to them, and the attachments on all of those (names and refs, never file bytes or email text).
 */
export async function loadOpportunityMaterial(athleteId: string, opportunityIds: string[], dbx: any = db): Promise<OpportunityMaterial> {
  if (!opportunityIds.length) return { members: [], real: [], threads: [], attachments: [] };
  const members: MemberDeal[] = await dbx.select({
    id: deals.id, opportunity_id: deals.opportunity_id, status: deals.status, signed_at: deals.signed_at, signed_source: deals.signed_source,
    term_end: deals.term_end, detected_at: deals.detected_at, direction: deals.direction, raw_data: deals.raw_data, brand_name: deals.brand_name,
  }).from(deals).where(and(eq(deals.athlete_id, athleteId), inArray(deals.opportunity_id, opportunityIds)));
  const memberIds = members.map((m) => m.id);
  const cols = {
    id: inboxThreads.id, deal_id: inboxThreads.deal_id, classification: inboxThreads.classification,
    conversation_state: inboxThreads.conversation_state, summary: inboxThreads.summary,
    // Under zero retention the stored subject is never read (it is NULL anyway); the provider wording then comes from the summary.
    subject: mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject, message_count: inboxThreads.message_count,
    last_message_at: inboxThreads.last_message_at, alias_thread_ids: inboxThreads.alias_thread_ids,
  };
  const own = memberIds.length
    ? await dbx.select(cols).from(inboxThreads).where(and(eq(inboxThreads.athlete_id, athleteId), inArray(inboxThreads.deal_id, memberIds)))
    : [];
  const paper = memberIds.length
    ? await dbx.select(cols).from(inboxThreads).where(and(
        eq(inboxThreads.athlete_id, athleteId),
        inArray(sql`${inboxThreads.classification} -> 'paperwork' ->> 'deal_id'`, memberIds),
      ))
    : [];

  // Calendar invites recorded as meetings on these deals (skills/meetings) — listed, never evidence of signing.
  const meetingRows = memberIds.length
    ? await dbx.select(cols).from(inboxThreads).where(and(
        eq(inboxThreads.athlete_id, athleteId),
        inArray(sql`${inboxThreads.classification} -> 'meeting' ->> 'deal_id'`, memberIds),
      ))
    : [];

  const legacyDealIds = new Set<string>(own.filter((t: any) => isLegacyPaperworkThread(t.classification)).map((t: any) => t.deal_id));
  // A deal is real unless EVERY thread it has is legacy paperwork (a deal with no thread is real: she added it).
  const real = members.filter((m) => !legacyDealIds.has(m.id) || own.some((t: any) => t.deal_id === m.id && !isLegacyPaperworkThread(t.classification)));
  const realIds = new Set(real.map((m) => m.id));

  const threads: MaterialThread[] = [];
  for (const t of own) {
    const legacy = !realIds.has(t.deal_id);
    let belongs: string | null = t.deal_id;
    if (legacy) {
      const m = members.find((x) => x.id === t.deal_id)!;
      belongs = bestReal(real.filter((r) => r.opportunity_id === m.opportunity_id), own)?.id ?? null;
    }
    threads.push({ ...t, belongs_to: belongs, role: legacy ? "legacy_paperwork" : "conversation" });
  }
  for (const t of paper) {
    if (threads.some((x) => x.id === t.id)) continue;
    const pw = readPaperwork(t.classification);
    threads.push({ ...t, belongs_to: pw?.deal_id ?? null, role: "paperwork" });
  }
  for (const t of meetingRows) {
    if (threads.some((x) => x.id === t.id)) continue;
    threads.push({ ...t, belongs_to: readMeeting(t.classification)?.deal_id ?? null, role: "meeting" });
  }

  const threadIds = threads.map((t) => t.id);
  const attachments: AttachmentRow[] = threadIds.length
    ? (await dbx.select({ thread_id: inboxMessages.thread_id, message_id: inboxMessages.id, at: inboxMessages.received_at, attachments: inboxMessages.attachments })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.athlete_id, athleteId), inArray(inboxMessages.thread_id, threadIds), isNotNull(inboxMessages.attachments))))
        .map((r: any) => ({ ...r, at: iso(r.at), attachments: Array.isArray(r.attachments) ? r.attachments : [] }))
    : [];
  return { members, real, threads, attachments };
}

/** Signing state for one opportunity's material. Pure over the loaded rows. */
export function signingFrom(material: OpportunityMaterial, opportunityId: string): OpportunitySigning {
  const real = material.real.filter((m) => m.opportunity_id === opportunityId);
  const realIds = new Set(real.map((m) => m.id));
  const threads = material.threads.filter((t) => t.belongs_to && realIds.has(t.belongs_to) && t.role !== "meeting");
  const signedDeal = real.filter((m) => m.signed_at).sort((a, b) => String(iso(b.signed_at)).localeCompare(String(iso(a.signed_at))))[0] ?? null;

  const evidence: SignedEvidence[] = [];
  for (const t of threads) {
    const at = iso(t.last_message_at);
    if (t.role === "conversation" && observedStageOf(t.conversation_state) === "signed") evidence.push({ kind: "summary", deal_id: t.belongs_to!, thread_id: t.id, at });
    if (t.role === "paperwork" && readPaperwork(t.classification)?.event === "completed") evidence.push({ kind: "paperwork", deal_id: t.belongs_to!, thread_id: t.id, at });
    if (t.role === "legacy_paperwork" && legacyPaperworkEvent(t) === "completed") evidence.push({ kind: "legacy_esign", deal_id: t.belongs_to!, thread_id: t.id, at });
  }
  const files: ContractCandidate[] = [];
  for (const row of material.attachments) {
    const t = threads.find((x) => x.id === row.thread_id);
    if (!t) continue;
    row.attachments.forEach((a, index) => {
      if (!looksLikeSignedFile(a)) return;
      files.push({ thread_id: t.id, message_id: row.message_id, index, filename: a.filename, at: row.at });
      evidence.push({ kind: "attachment", deal_id: t.belongs_to!, thread_id: t.id, at: row.at, filename: a.filename });
    });
  }

  // Evidence on a real deal's own conversation names that deal; anything else lands on the best real member.
  const direct = evidence.filter((e) => e.kind === "summary" || (e.kind === "attachment" && threads.find((t) => t.id === e.thread_id)?.role === "conversation"))
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
  const target = signedDeal?.id ?? direct?.deal_id ?? bestReal(real, material.threads)?.id ?? null;
  const targetRow = real.find((m) => m.id === target) ?? null;
  const contract = (targetRow?.raw_data as any)?.contract;

  files.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return {
    signed: signedDeal ? { deal_id: signedDeal.id, at: iso(signedDeal.signed_at)!, source: signedDeal.signed_source ?? "confirmed" } : null,
    looks_signed: !signedDeal && evidence.length > 0 && !!target,
    target_deal_id: target,
    evidence,
    contract_candidate: files[0] ?? null,
    has_contract: !!(contract && typeof contract === "object"),
  };
}

export async function readSigning(athleteId: string, opportunityId: string, dbx: any = db): Promise<OpportunitySigning> {
  return signingFrom(await loadOpportunityMaterial(athleteId, [opportunityId], dbx), opportunityId);
}

export type ConfirmSignedResult =
  | { ok: true; deal_id: string; opportunity_id: string; receipt_id: string; contract_candidate: ContractCandidate | null }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Her "Yes, it's signed". `dealId` optional: when given it must be a real member of the opportunity.
 * Idempotent in effect: a second Yes on a won opportunity is a 409, never a second receipt.
 */
export async function confirmSigned(athleteId: string, opportunityId: string, dealId?: string | null, now: Date = new Date()): Promise<ConfirmSignedResult> {
  const [opp] = await db.select({ id: opportunities.id, brand_id: opportunities.brand_id, status: opportunities.status })
    .from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId))).limit(1);
  if (!opp) return { ok: false, status: 404, error: "Opportunity not found" };
  if (opp.status !== "open") return { ok: false, status: 409, error: "This engagement is already closed" };

  const material = await loadOpportunityMaterial(athleteId, [opportunityId]);
  const signing = signingFrom(material, opportunityId);
  const target = dealId ?? signing.target_deal_id;
  const deal = material.real.find((m) => m.id === target && m.opportunity_id === opportunityId);
  if (!deal) return { ok: false, status: 404, error: "Deal not found" };
  if (deal.signed_at) return { ok: false, status: 409, error: "Already marked signed" };

  const fromStatus = deal.status ?? null;
  const lift = (DEAL_STATUS_RANK[fromStatus ?? ""] ?? 99) < DEAL_STATUS_RANK.accepted;
  const receipt = await db.transaction(async (tx) => {
    if (opp.brand_id != null) await lockBrand(tx, athleteId, opp.brand_id);
    // Re-check under the lock: a double tap must not close twice.
    const [still] = await tx.select({ status: opportunities.status }).from(opportunities).where(eq(opportunities.id, opportunityId)).for("update").limit(1);
    if (still?.status !== "open") return null;
    await tx.update(deals).set({
      signed_at: now, signed_source: "confirmed",
      ...(lift ? { status: "accepted" } : {}),
    }).where(and(eq(deals.id, deal.id), eq(deals.athlete_id, athleteId)));
    await tx.update(opportunities).set({ status: "closed", close_reason: "won", closed_at: now, going_quiet_at: null })
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId)));
    return writeAgentAction({
      athleteId, action: "confirm_signed", dealId: deal.id, reversible: true,
      reason: "You confirmed it is signed",
      payload: {
        source: "athlete", opportunity_id: opportunityId, deal_id: deal.id,
        // NOT `from_status`: the undo route reads that as a THREAD status.
        from_deal_status: fromStatus, to_deal_status: lift ? "accepted" : fromStatus,
        evidence: signing.evidence.map((e) => ({ kind: e.kind, thread_id: e.thread_id, deal_id: e.deal_id })),
      },
    }, tx);
  });
  if (!receipt) return { ok: false, status: 409, error: "This engagement is already closed" };
  logger.info({ athleteId, opportunityId, dealId: deal.id, lifted: lift }, "Signed confirmed; opportunity closed as won");
  return { ok: true, deal_id: deal.id, opportunity_id: opportunityId, receipt_id: receipt.id, contract_candidate: signing.contract_candidate };
}

/** Undo of a confirm_signed receipt: clear signed, restore the status. (The route reopens the opportunity.) */
export async function undoConfirmSigned(athleteId: string, payload: Record<string, any>, dbx: any = db): Promise<void> {
  const dealId = typeof payload?.deal_id === "string" ? payload.deal_id : null;
  if (!dealId) return;
  await dbx.update(deals).set({
    signed_at: null, signed_source: null,
    ...(payload.from_deal_status !== payload.to_deal_status ? { status: payload.from_deal_status ?? null } : {}),
  }).where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)));
}
