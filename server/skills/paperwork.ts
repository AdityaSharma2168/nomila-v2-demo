/**
 * paperwork.ts — e-sign / payment mail (WORKFLOW_DOMAINS) is an OBSERVATION about a deal that
 * already exists. It never mints a deal and never opens an opportunity, in any path.
 *
 * Matching is deterministic, in this order, and only ever lands on one of HER opportunities:
 *   1. name          — a brand named in the subject / document title / attachment name, or in the
 *                      body's "X sent you a document" line: the exact same-name key the brand
 *                      resolver uses (sameNameKey), never a look-alike.
 *   2. sender_domain — the envelope sender's organisation domain, when the body states it
 *                      (an address in the body whose registrable domain is a brand row's domain).
 *   3. only_contract_deal — she has EXACTLY ONE open opportunity with a deal in a contract-ish
 *                      stage (negotiating / accepted, read as max(status, observed)), and nothing
 *                      in the mail names or points at any brand.
 * Two candidates at any step is a contradiction: the mail is held, never guessed.
 *
 * Matched → the thread is linked to the worked deal through its classification
 * (`paperwork.deal_id`), the opportunity's activity advances, and the deal row is NOT touched:
 * no status, no contract state. Unmatched → held as "paperwork to match"; no opportunity, no deal,
 * nothing that interrupts her.
 *
 * Why a classification link and not inbox_threads.deal_id: one thread per deal is assumed by every
 * reader that joins threads to deals (the deals list's LEFT JOIN would list the deal twice) and by
 * every `where deal_id = X limit 1` that picks the thread a reply goes to (askTerms, drafts, sends)
 * — the e-sign provider's no-reply thread must never be that target. alias_thread_ids is a
 * different thing: the SAME conversation seen from a second mailbox.
 *
 * Never throws into the caller.
 */

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { connectedAccounts, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { brandDomainOf, isPaymentWorkflowDomain, WORKFLOW_DOMAINS } from "../lib/senderProfile";
import { sameNameKey } from "../lib/brandName";
import { DEAL_STATUS_RANK, effectiveDealStatus } from "../lib/observedStage";
import { lockBrand, WORKED_DEAL_STATUSES } from "./opportunities";
import { createLogger } from "../logger";
import { pushPaymentReceived } from "../services/push/events";

const logger = createLogger("skills/paperwork");

export type PaperworkKind  = "signature_request" | "status" | "payment";
/** payment_received: a company's own remittance / payment advice paying her (lib/emailFilters isPaymentToAthlete). */
export type PaperworkEvent = "signature_requested" | "reminder" | "completed" | "payment_sent" | "payment_received" | "status";
/** legacy_fold: a pre-#777 e-sign pseudo-deal folded into paperwork by scripts/opps/foldPaperworkAndSplit. */
export type PaperworkMatch = "name" | "sender_domain" | "only_contract_deal" | "legacy_fold";

export interface PaperworkMarker {
  state:              "matched" | "unmatched";
  kind:               PaperworkKind;
  event:              PaperworkEvent;
  deal_id?:           string;
  opportunity_id?:    string;
  brand_id?:          number;
  matched_by?:        PaperworkMatch;
  /** inbox_messages ids on this thread the observation was read from (provenance). */
  source_message_ids: string[];
  /** payment_received: the amount the notice states (cents), when it states one, and its currency. */
  amount_cents?:      number;
  currency?:          string;
  /** payment_received: when the notice arrived (ISO) — the date the money is shown as paid. */
  paid_at?:           string;
  observed_at:        string;
}

/** Stages a deal is in when paperwork is expected for it (rule 3). */
const CONTRACT_STAGES = ["negotiating", "accepted"];

// ─── Pure reads of the mail ───────────────────────────────────────────────────

/** What the mail says happened. Deterministic; the provider's own words. */
export function paperworkEvent(senderDomain: string | null, subject: string, body: string): { kind: PaperworkKind; event: PaperworkEvent } {
  if (senderDomain && isPaymentWorkflowDomain(senderDomain)) return { kind: "payment", event: "payment_sent" };
  const text = `${subject}\n${(body ?? "").slice(0, 1500)}`;
  if (/\bcompleted\b|all parties have signed|has been (fully )?signed|\bfully executed\b/i.test(text)) {
    return { kind: "status", event: "completed" };
  }
  if (/\breminder\b/i.test(text)) return { kind: "signature_request", event: "reminder" };
  if (/signature request|signature requested|please (docu)?sign|review and sign|ready for your signature|sent you (a|an) (new )?(document|agreement|envelope|contract)/i.test(text)) {
    return { kind: "signature_request", event: "signature_requested" };
  }
  return { kind: "status", event: "status" };
}

/** Provider names are never a brand (a "DocuSign" row must not catch every envelope). */
const PROVIDER_KEYS = new Set([
  ...[...WORKFLOW_DOMAINS].map((d) => d.split(".")[0]),
  "adobe", "acrobat", "acrobatsign", "adobeacrobatsign", "adobesign", "dropbox", "dropboxsign",
]);

const SENT_YOU = /([^\n]{1,120}?)\s+(?:has\s+)?sent you (?:a |an )?(?:new )?(?:document|agreement|envelope|contract)/gi;

/**
 * Same-name keys for every 1–4 word run of the subject, attachment names and "X sent you a
 * document" lines. Each is looked up EXACTLY — a run either is a brand's whole name or nothing.
 */
export function nameCandidateKeys(subject: string, body: string, attachmentNames: string[] = []): string[] {
  const sources = [subject, ...attachmentNames];
  for (const m of (body ?? "").matchAll(SENT_YOU)) sources.push(m[1]);
  const keys = new Set<string>();
  for (const src of sources) {
    const words = (src ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 4 && i + n <= words.length; n++) {
        const key = sameNameKey(words.slice(i, i + n).join(" "));
        if (key.length >= 3 && !PROVIDER_KEYS.has(key)) keys.add(key);
      }
    }
  }
  return [...keys];
}

/** Organisation domains the body states (addresses in it), as brand identity domains. */
export function statedDomains(body: string): string[] {
  const out = new Set<string>();
  for (const m of (body ?? "").matchAll(/[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const d = brandDomainOf(m[1].toLowerCase());
    if (d) out.add(d);
  }
  return [...out];
}

// ─── Placement ────────────────────────────────────────────────────────────────

/** Her own mailboxes' domains — her address in an envelope is never the sender's org. */
async function ownDomains(athleteId: string): Promise<Set<string>> {
  const rows = await db
    .select({ u: connectedAccounts.platform_username })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.athlete_id, athleteId));
  const out = new Set<string>();
  for (const r of rows) {
    const d = brandDomainOf(String(r.u ?? "").split("@")[1] ?? null);
    if (d) out.add(d);
  }
  return out;
}

interface Member { dealId: string; opportunityId: string; status: string | null; detectedAt: Date | null }

export interface PaperworkInput {
  athleteId:        string;
  senderDomain:     string | null;
  subject:          string;
  body:             string;
  attachmentNames?: string[];
  /**
   * Set for a company's own payment notice (not an e-sign / payout provider): the sender's domain is the payer's,
   * rule 3 (the only contract deal) never applies — a payment is never guessed onto a deal — and the stated amount
   * rides on the marker.
   */
  payment?:         { amountCents: number | null; currency: string } | null;
  /** Deals never matched (a deal minted from this very notice, being set aside). */
  excludeDealIds?:  string[];
}

/**
 * Where paperwork belongs, read only: the opportunity + deal it matches, or — for a payment notice with no deal to
 * land on — the one brand row it names (`brandOnly`), else nothing.
 */
export async function matchPaperwork(p: PaperworkInput) {
  const { athleteId } = p;
  const payment = p.payment ?? null;
  const ev = payment ? { kind: "payment" as const, event: "payment_received" as const } : paperworkEvent(p.senderDomain, p.subject, p.body);
  const { kind, event } = ev;
  {

    // Every brand the mail names or points at — globally, so a named brand she has no
    // opportunity with still counts as a contradiction for rule 3.
    const keys = nameCandidateKeys(p.subject, p.body, p.attachmentNames);
    const own = await ownDomains(athleteId);
    // A company's own payment notice comes from the payer's own domain; an e-sign envelope's sender is the provider.
    const senderOrg = payment && p.senderDomain ? brandDomainOf(p.senderDomain) : null;
    const domains = [...new Set([...statedDomains(p.body), ...(senderOrg ? [senderOrg] : [])])].filter((d) => !own.has(d));
    const nameHits = keys.length
      ? await db.select({ id: inboxBrands.id }).from(inboxBrands)
          .where(or(
            inArray(sql`replace(coalesce(${inboxBrands.normalized_name}, ''), ' ', '')`, keys),
            // Rows written before normalized_name existed: the bare alphanumeric name.
            and(isNull(inboxBrands.normalized_name), inArray(sql`regexp_replace(lower(${inboxBrands.name}), '[^a-z0-9]', '', 'g')`, keys)),
          ))
      : [];
    const domainHits = domains.length
      ? await db.select({ id: inboxBrands.id }).from(inboxBrands).where(inArray(inboxBrands.domain, domains))
      : [];

    const opps = await db
      .select({
        id: opportunities.id, brand_id: opportunities.brand_id, status: opportunities.status,
        close_reason: opportunities.close_reason, last_activity_at: opportunities.last_activity_at,
      })
      .from(opportunities)
      .where(eq(opportunities.athlete_id, athleteId));
    const memberRows = await db
      .select({
        dealId: deals.id, opportunityId: deals.opportunity_id, status: deals.status,
        detectedAt: deals.detected_at, cs: inboxThreads.conversation_state,
      })
      .from(deals)
      .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
      .where(and(eq(deals.athlete_id, athleteId), isNotNull(deals.opportunity_id)));
    // max(status, observed): this PROTECTS (where the observation lands), it never writes status.
    const excluded = new Set(p.excludeDealIds ?? []);
    const members: Member[] = memberRows.filter((m) => !excluded.has(m.dealId)).map((m) => ({
      dealId: m.dealId, opportunityId: m.opportunityId!, detectedAt: m.detectedAt,
      status: effectiveDealStatus(m.status, m.cs),
    }));
    const membersOf = (oppId: string) => members.filter((m) => m.opportunityId === oppId);

    const oppBrands = new Set(opps.map((o) => o.brand_id).filter((b): b is number => b != null));
    const uniq = (xs: { id: number }[]) => [...new Set(xs.map((x) => x.id))];
    const nameIds = uniq(nameHits).filter((id) => oppBrands.has(id));
    const domainIds = uniq(domainHits).filter((id) => oppBrands.has(id));

    let matchedBy: PaperworkMatch | null = null;
    let brandId: number | null = null;
    let opp: (typeof opps)[number] | null = null;
    if (nameIds.length === 1) {
      matchedBy = "name"; brandId = nameIds[0];
    } else if (nameIds.length === 0 && domainIds.length === 1) {
      matchedBy = "sender_domain"; brandId = domainIds[0];
    } else if (!payment && !nameHits.length && !domainHits.length) {
      const contractish = opps.filter((o) => o.status === "open"
        && membersOf(o.id).some((m) => CONTRACT_STAGES.includes(m.status ?? "")));
      if (contractish.length === 1) { matchedBy = "only_contract_deal"; opp = contractish[0]; brandId = opp.brand_id; }
    }
    if (brandId != null && !opp) {
      // An opportunity with a deal first (one holding only the excluded deal — say, the deal minted from this very
      // notice — has nothing to land on), then the open one, then the one being worked, then the latest.
      const worked = (id: string) => membersOf(id).some((m) => WORKED_DEAL_STATUSES.includes(m.status ?? ""));
      const hasDeal = (id: string) => membersOf(id).length > 0;
      opp = opps
        .filter((o) => o.brand_id === brandId)
        .sort((a, b) =>
          Number(hasDeal(b.id)) - Number(hasDeal(a.id))
          || Number(b.status === "open") - Number(a.status === "open")
          || Number(worked(b.id)) - Number(worked(a.id))
          || new Date(b.last_activity_at ?? 0).getTime() - new Date(a.last_activity_at ?? 0).getTime())[0] ?? null;
    }
    // The deal it belongs to: the most advanced member (max(status, observed)), then the newest.
    const deal = opp
      ? membersOf(opp.id).sort((a, b) =>
          (DEAL_STATUS_RANK[b.status ?? ""] ?? -1) - (DEAL_STATUS_RANK[a.status ?? ""] ?? -1)
          || new Date(b.detectedAt ?? 0).getTime() - new Date(a.detectedAt ?? 0).getTime())[0] ?? null
      : null;
    // A payment notice with no deal to land on still belongs to the payer's brand record when exactly one names it.
    const allHits = [...new Set([...uniq(nameHits), ...uniq(domainHits)])];
    const brandOnly = payment && !(opp && deal && matchedBy) && allHits.length === 1 ? allHits[0] : null;
    return { kind, event, matchedBy, brandId, opp, deal, brandOnly };
  }
}

/**
 * Match one paperwork thread and record the observation on its classification. Returns the marker
 * written, or null on failure (the thread then simply carries no marker).
 */
export async function placePaperwork(p: PaperworkInput & { threadId: string }): Promise<PaperworkMarker | null> {
  const { athleteId, threadId } = p;
  try {
    const { kind, event, matchedBy, brandId: matchedBrand, opp, deal, brandOnly } = await matchPaperwork(p);
    const brandId = matchedBrand ?? brandOnly;

    const msgs = await db
      .select({ id: inboxMessages.id, at: inboxMessages.received_at })
      .from(inboxMessages)
      .where(eq(inboxMessages.thread_id, threadId))
      .orderBy(inboxMessages.received_at);
    const lastAt = msgs.length ? new Date(msgs[msgs.length - 1].at ?? Date.now()) : new Date();
    const paid = p.payment
      ? { ...(p.payment.amountCents != null ? { amount_cents: p.payment.amountCents, currency: p.payment.currency } : {}), paid_at: lastAt.toISOString() }
      : {};
    const base = { kind, event, source_message_ids: msgs.map((m) => m.id), observed_at: new Date().toISOString(), ...paid };

    const marker: PaperworkMarker = opp && deal && matchedBy
      ? { state: "matched", ...base, deal_id: deal.dealId, opportunity_id: opp.id, brand_id: brandId ?? undefined, matched_by: matchedBy }
      : { state: "unmatched", ...base, ...(brandOnly != null ? { brand_id: brandOnly } : {}) };

    await db.transaction(async (tx) => {
      if (marker.state === "matched") {
        if (brandId != null) await lockBrand(tx, athleteId, brandId);
        // A late "Completed" revives an opportunity the sweep filed as expired — never one she
        // declined or won. A payment never does: money in is the end of the work, not a new ask on her.
        // The deal row itself is not touched.
        if (kind !== "payment" && opp!.status === "closed" && opp!.close_reason === "expired") {
          await tx.update(opportunities)
            .set({ status: "open", closed_at: null, close_reason: null })
            .where(eq(opportunities.id, opp!.id));
        }
        await tx.update(opportunities)
          .set({
            last_activity_at: sql`greatest(${opportunities.last_activity_at}, ${lastAt.toISOString()}::timestamptz)`,
            going_quiet_at:   null,
          })
          .where(eq(opportunities.id, opp!.id));
        if (brandId != null) await tx.update(inboxThreads).set({ brand_id: brandId }).where(eq(inboxThreads.id, threadId));
      } else if (brandOnly != null) {
        await tx.update(inboxThreads).set({ brand_id: brandOnly }).where(eq(inboxThreads.id, threadId));
      }
      // Merge-only: nothing else kept on the classification is touched.
      await tx.update(inboxThreads)
        .set({ classification: sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) || ${JSON.stringify({ paperwork: marker })}::jsonb` })
        .where(eq(inboxThreads.id, threadId));
    });

    logger.info({ athleteId, threadId, state: marker.state, event, matchedBy, dealId: marker.deal_id }, "Paperwork observed");
    // A payment filed on her deal is news: "{Brand} paid you $X" (dev switch; fresh notices only; once per thread).
    if (marker.state === "matched" && event === "payment_received" && marker.opportunity_id) {
      const [b] = brandId != null
        ? await db.select({ name: inboxBrands.name }).from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1)
        : [];
      pushPaymentReceived(athleteId, {
        threadId, opportunityId: marker.opportunity_id, brand: b?.name ?? null,
        amountCents: marker.amount_cents ?? null, currency: marker.currency, paidAt: marker.paid_at ? new Date(marker.paid_at) : null,
      });
    }
    return marker;
  } catch (e: any) {
    logger.warn({ threadId, err: e?.message }, "Paperwork placement skipped");
    return null;
  }
}

/** The paperwork marker on a thread's classification, if any. */
export function readPaperwork(classification: unknown): PaperworkMarker | null {
  const pw = (classification as { paperwork?: unknown } | null | undefined)?.paperwork;
  return pw && typeof pw === "object" && "state" in (pw as object) ? (pw as PaperworkMarker) : null;
}

/** Recent paperwork observations linked to these deals, newest first — for the deals API. */
export async function paperworkForDeals(athleteId: string, dealIds: string[]): Promise<Map<string, { thread_id: string; event: PaperworkEvent; at: string }[]>> {
  const out = new Map<string, { thread_id: string; event: PaperworkEvent; at: string }[]>();
  if (!dealIds.length) return out;
  const rows = await db
    .select({ id: inboxThreads.id, classification: inboxThreads.classification, at: inboxThreads.last_message_at })
    .from(inboxThreads)
    .where(and(
      eq(inboxThreads.athlete_id, athleteId),
      inArray(sql`${inboxThreads.classification} -> 'paperwork' ->> 'deal_id'`, dealIds),
    ))
    .orderBy(desc(inboxThreads.last_message_at));
  for (const r of rows) {
    const pw = readPaperwork(r.classification);
    if (!pw?.deal_id) continue;
    const list = out.get(pw.deal_id) ?? [];
    list.push({ thread_id: r.id, event: pw.event, at: new Date(r.at ?? pw.observed_at).toISOString() });
    out.set(pw.deal_id, list);
  }
  return out;
}
