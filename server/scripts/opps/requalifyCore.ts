/**
 * requalifyCore.ts — the read-only core of the Opportunities PR 1 dry-run (requalifyDryRun.ts).
 *
 * For one athlete: take each OPEN deal (detected / pending / negotiating), re-classify the latest
 * INBOUND message of its thread through the classify call (which now carries qualification),
 * enforce the qualification rules in code, and report what OPPS_QUALIFIED_INTAKE would have done
 * with it — keep, file (never minted), or mark verify-first.
 *
 * Writes NOTHING. Every query here is a SELECT; the CLI additionally opens its DB session with
 * `default_transaction_read_only=on`, and the test runs this core under a read-only session to
 * prove no statement writes. The classify provider is injected (`classify`) so the test never
 * reaches a model; the CLI passes the real classifyMessage, behind the existing provider seam.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import type { Classification } from "../../skills/dealDetector";
import {
  enforceQualification,
  intakeActionFor,
  internalTestSenders,
  loadQualificationFloors,
  possibleTestMessage,
  readStoredQualification,
  QUALIFICATION_VERSION,
  type Qualification,
  type StoredQualification,
} from "../../skills/dealQualification";
import { getMailboxAdapter, mailboxProviderOf } from "../../lib/mailbox";
import { mailboxZeroRetentionEnabled } from "../../lib/mailbox/retention";
import { readStoredMessageLive, textWithBrief } from "../../services/liveConversation";
import { notPlaceholderOnly } from "../../lib/integrations/instagramAttachments";

export const OPEN_DEAL_STATUSES = ["detected", "pending", "negotiating"] as const;

export type ClassifyFn = (from: string, subject: string, body: string) => Promise<Classification>;

/** What the flag would do with this deal had it arrived with the flag ON. */
export type FlagAction = "keep" | "file" | "mark_verify" | "unqualified" | "error";

export interface RequalifyRow {
  deal_id:              string;
  thread_id:            string | null;
  brand:                string | null;
  advertiser:           string | null;
  channel:              string | null;
  agency:               string | null;
  status:               string | null;
  thread_status:        string | null;
  category_stored:      string | null;
  category_now:         string | null;
  stored_qualification: Qualification | null;
  qualification:        Qualification | null;
  reason:               string | null;
  floor_check:          StoredQualification["qualification_floor"];
  flag_action:          FlagAction;
  /** Would today's classify gate (NOISE / is_deal=false / confidence<0.6) have skipped it anyway? */
  today_gate_would_skip: boolean | null;
  latest_inbound_at:    string | null;
  /** Set when the latest inbound looks like a developer test (INTERNAL_TEST_SENDERS) — why. */
  possible_test?:       string | null;
  /** The latest inbound's subject — shown for possible tests so a person can confirm them. */
  subject?:             string | null;
  error?:               string;
}

export interface RequalifyReport {
  athlete_id:            string;
  generated_at:          string;
  qualification_version: string;
  open_deals_total:      number;
  examined:              number;
  limit:                 number;
  counts_by_state:       Record<string, number>;
  counts_by_action:      Record<string, number>;
  rows:                  RequalifyRow[];
  /** Deals the flag would treat differently from today (filed or marked). */
  changes:               RequalifyRow[];
  /**
   * Possible developer test emails (sender in INTERNAL_TEST_SENDERS). Listed here only: not
   * classified (no cost), and excluded from every count and from `changes` so they can't distort
   * the review.
   */
  possible_tests:        RequalifyRow[];
  /** How the internal-sender list was configured for this run (counts only, no addresses). */
  test_senders_configured: { addresses: number; domains: number };
}

interface Candidate {
  deal_id:        string;
  brand:          string | null;
  status:         string | null;
  thread_id:      string | null;
  thread_status:  string | null;
  classification: unknown;
}

/** The open deals, newest first, with their thread. Read-only. */
export async function selectOpenDeals(dbx: any, athleteId: string): Promise<Candidate[]> {
  const rows = await dbx
    .select({
      deal_id:        deals.id,
      brand:          deals.brand_name,
      status:         deals.status,
      detected_at:    deals.detected_at,
      thread_id:      inboxThreads.id,
      thread_status:  inboxThreads.status,
      classification: inboxThreads.classification,
    })
    .from(deals)
    .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
    .where(and(eq(deals.athlete_id, athleteId), inArray(deals.status, [...OPEN_DEAL_STATUSES])))
    .orderBy(desc(deals.detected_at), deals.id);
  // One row per deal (a deal has at most one linked thread; be defensive anyway).
  const seen = new Set<string>();
  return (rows as (Candidate & { detected_at: unknown })[]).filter((r) => {
    if (seen.has(r.deal_id)) return false;
    seen.add(r.deal_id);
    return true;
  });
}

interface InboundForClassify {
  sender_email:        string | null;
  sender_name:         string | null;
  subject:             string | null;
  body:                string | null;
  received_at:         Date | null;
  external_message_id: string | null;
}

// The body is read only to re-classify (and to spot a developer test). It never goes into
// RequalifyRow, the JSON dump or the Markdown report: those are a developer review of her
// deals, not a copy of her mail (Google API Limited Use).
/**
 * The latest inbound message, as classify needs it. MAILBOX_LIVE_READS: only its ids
 * come from the DB; headers and text are read live from the mailbox (with any PDF brief,
 * the same merged shape ingest classified). Unreadable → `{ unavailable }`, which the
 * caller reports as an error row. This core writes nothing either way.
 */
async function latestInbound(
  dbx: any,
  threadId: string,
): Promise<InboundForClassify | { unavailable: string } | null> {
  // Ids only here; the stored headers and text are read below ONLY when no live reader
  // applies (flag off, or Instagram) — never on the live path.
  const [m] = await dbx
    .select({
      id:                   inboxMessages.id,
      received_at:          inboxMessages.received_at,
      external_message_id:  inboxMessages.external_message_id,
      platform:             inboxMessages.platform,
      connected_account_id: inboxMessages.connected_account_id,
    })
    .from(inboxMessages)
    // A placeholder-only DM ("[Photo]") is not text to classify: the newest message the sender wrote is.
    .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "inbound"), notPlaceholderOnly))
    .orderBy(desc(inboxMessages.received_at))
    .limit(1);
  if (!m) return null;

  const read = await readStoredMessageLive(m);
  if (!read) {
    // Flag off, or no live reader for this provider (e.g. Instagram): the stored message.
    const [b] = await dbx
      .select({
        sender_email: inboxMessages.sender_email,
        sender_name:  inboxMessages.sender_name,
        subject:      inboxMessages.subject,
        body:         inboxMessages.body,
      })
      .from(inboxMessages)
      .where(eq(inboxMessages.id, m.id))
      .limit(1);
    return {
      ...m,
      sender_email: b?.sender_email ?? null,
      sender_name:  b?.sender_name ?? null,
      subject:      b?.subject ?? null,
      body:         b?.body ?? null,
    };
  }
  if (!read.ok) return { unavailable: read.message };
  const provider = mailboxProviderOf(m.platform ?? "gmail");
  const adapter = provider ? await getMailboxAdapter(provider) : null;
  return {
    ...m,
    sender_email: read.message.fromEmail,
    sender_name:  read.message.fromName,
    subject:      read.message.subject,
    body:         adapter ? await textWithBrief({ adapter }, read.message) : read.message.text,
  };
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** How many classify calls a run would make (one per open deal with an inbound message, capped). */
export async function countCandidates(dbx: any, athleteId: string, limit: number) {
  const all = await selectOpenDeals(dbx, athleteId);
  const withThread = all.filter((c) => c.thread_id);
  return { total: all.length, withThread: withThread.length, willClassify: Math.min(limit, withThread.length) };
}

export async function requalifyAthlete(params: {
  dbx:       any;
  athleteId: string;
  limit:     number;
  classify:  ClassifyFn;
  now?:      Date;
  /** Comma-separated internal addresses/domains; defaults to INTERNAL_TEST_SENDERS. */
  testSenders?: string;
  onProgress?: (done: number, of: number) => void;
}): Promise<RequalifyReport> {
  const { dbx, athleteId, limit, classify } = params;
  const testSenders = params.testSenders ?? process.env.INTERNAL_TEST_SENDERS ?? "";
  const possibleTests: RequalifyRow[] = [];
  const all = await selectOpenDeals(dbx, athleteId);
  const picked = all.filter((c) => c.thread_id).slice(0, limit);
  const floors = await loadQualificationFloors(athleteId, dbx);

  const rows: RequalifyRow[] = [];
  for (const c of picked) {
    const stored = c.classification as Record<string, unknown> | null;
    const base: RequalifyRow = {
      deal_id:               c.deal_id,
      thread_id:             c.thread_id,
      brand:                 c.brand,
      advertiser:            strOrNull(stored?.advertiser),
      channel:               strOrNull(stored?.channel),
      agency:                strOrNull(stored?.agency_name),
      status:                c.status,
      thread_status:         c.thread_status,
      category_stored:       strOrNull(stored?.category),
      category_now:          null,
      stored_qualification:  readStoredQualification(stored)?.qualification ?? null,
      qualification:         null,
      reason:                null,
      floor_check:           null,
      flag_action:           "unqualified",
      today_gate_would_skip: null,
      latest_inbound_at:     null,
    };

    const msg = await latestInbound(dbx, c.thread_id!);
    if (!msg) {
      rows.push({ ...base, error: "no inbound message on the thread" });
      params.onProgress?.(rows.length, picked.length);
      continue;
    }
    if ("unavailable" in msg) {
      rows.push({ ...base, flag_action: "error", error: msg.unavailable });
      params.onProgress?.(rows.length, picked.length);
      continue;
    }
    const from = msg.sender_name ? `${msg.sender_name} <${msg.sender_email ?? ""}>` : (msg.sender_email ?? "");
    base.latest_inbound_at = msg.received_at ? new Date(msg.received_at).toISOString() : null;

    // A developer's test email: listed separately, never classified, never counted.
    const testReason = possibleTestMessage({ from, subject: msg.subject, body: msg.body }, testSenders);
    if (testReason) {
      // Zero retention: the report written to disk carries no subject line either.
      possibleTests.push({ ...base, possible_test: testReason, subject: mailboxZeroRetentionEnabled() ? null : (msg.subject ?? null) });
      continue;
    }

    let cls: Classification;
    try {
      cls = await classify(from, msg.subject ?? "", msg.body ?? "");
    } catch (err: any) {
      rows.push({ ...base, flag_action: "error", error: String(err?.message ?? err).slice(0, 200) });
      params.onProgress?.(rows.length, picked.length);
      continue;
    }
    if (cls.llm_error) {
      rows.push({ ...base, flag_action: "error", error: "classify failed after retries" });
      params.onProgress?.(rows.length, picked.length);
      continue;
    }

    const q = enforceQualification({
      model:        cls.model_qualification ?? null,
      from,
      deliverables: cls.deliverables,
      floors,
      messageId:    msg.external_message_id ?? null,
      category:     cls.category,
    });
    const action = intakeActionFor(q);
    rows.push({
      ...base,
      advertiser:            cls.advertiser ?? base.advertiser,
      channel:               q?.channel ?? base.channel,
      agency:                cls.agency_name ?? base.agency,
      category_now:          cls.category,
      qualification:         q?.qualification ?? null,
      reason:                q?.qualification_reason ?? null,
      floor_check:           q?.qualification_floor ?? null,
      flag_action:           !q ? "unqualified" : action === "file" ? "file" : action === "mint_marked" ? "mark_verify" : "keep",
      today_gate_would_skip: cls.category === "NOISE" || cls.is_deal === false || cls.confidence < 0.6,
    });
    params.onProgress?.(rows.length, picked.length);
  }

  const countBy = (key: (r: RequalifyRow) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => { const k = key(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

  return {
    athlete_id:            athleteId,
    generated_at:          (params.now ?? new Date()).toISOString(),
    qualification_version: QUALIFICATION_VERSION,
    open_deals_total:      all.length,
    examined:              rows.length,
    limit,
    counts_by_state:       countBy((r) => r.qualification ?? (r.error ? "error" : "unqualified")),
    counts_by_action:      countBy((r) => r.flag_action),
    rows,
    changes:               rows.filter((r) => r.flag_action === "file" || r.flag_action === "mark_verify"),
    possible_tests:        possibleTests,
    test_senders_configured: (() => {
      const s = internalTestSenders(testSenders);
      return { addresses: s.addresses.size, domains: s.domains.size };
    })(),
  };
}

const cell = (v: unknown) => (v == null || v === "" ? "—" : String(v).replace(/\|/g, "\\|").replace(/\s+/g, " "));

const ACTION_LABEL: Record<FlagAction, string> = {
  keep:        "keep",
  file:        "file (would not have been minted)",
  mark_verify: "mint, marked verify first",
  unqualified: "no qualification returned",
  error:       "error",
};

export function renderMarkdown(r: RequalifyReport): string {
  const lines: string[] = [];
  lines.push(`# Re-qualification dry-run — ${r.athlete_id}`);
  lines.push("");
  lines.push(`Generated ${r.generated_at} · ${r.qualification_version} · read-only (nothing was written).`);
  lines.push(`Open deals: ${r.open_deals_total} · examined: ${r.examined} · possible test emails set aside: ${r.possible_tests.length} (limit ${r.limit}).`);
  lines.push(
    `Internal test senders (INTERNAL_TEST_SENDERS): ${r.test_senders_configured.addresses} address(es), ${r.test_senders_configured.domains} domain(s)` +
    (r.test_senders_configured.addresses + r.test_senders_configured.domains === 0 ? " — none configured, so no email was treated as a test." : "."),
  );
  lines.push("");
  lines.push("## Summary by qualification");
  lines.push("");
  lines.push("| State | Deals |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(r.counts_by_state).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## What OPPS_QUALIFIED_INTAKE would do");
  lines.push("");
  lines.push("| Action | Deals |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(r.counts_by_action).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${ACTION_LABEL[k as FlagAction] ?? k} | ${v} |`);
  }
  lines.push("");
  lines.push(`## Changes vs today (${r.changes.length})`);
  lines.push("");
  if (r.changes.length === 0) lines.push("None — every examined deal would still be minted as today.");
  else {
    lines.push("| Brand | Advertiser | Channel | Agency | Status | New | Reason | Flag would |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const x of r.changes) {
      lines.push(`| ${cell(x.brand)} | ${cell(x.advertiser)} | ${cell(x.channel)} | ${cell(x.agency)} | ${cell(x.status)} | ${cell(x.qualification)} | ${cell(x.reason)} | ${ACTION_LABEL[x.flag_action]} |`);
    }
  }
  lines.push("");
  lines.push(`## Possible test emails — excluded from every count above (${r.possible_tests.length})`);
  lines.push("");
  if (r.possible_tests.length === 0) lines.push("None.");
  else {
    lines.push("| Brand | Subject | Status / thread | Why flagged |");
    lines.push("|---|---|---|---|---|");
    for (const x of r.possible_tests) {
      lines.push(`| ${cell(x.brand)} | ${cell(x.subject)} | ${cell(x.status)} / ${cell(x.thread_status)} | ${cell(x.possible_test)} |`);
    }
  }
  lines.push("");
  lines.push("## Every examined deal");
  lines.push("");
  lines.push("| Brand | Advertiser | Channel | Agency | Status / thread | Category (stored → now) | Stored qual. | New qualification | Reason | Floor check | Flag would |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of r.rows) {
    const floor = x.floor_check ? `$${x.floor_check.cash} vs $${x.floor_check.floor}×${x.floor_check.units} (${x.floor_check.kind}, ${x.floor_check.source})` : null;
    lines.push(
      `| ${cell(x.brand)} | ${cell(x.advertiser)} | ${cell(x.channel)} | ${cell(x.agency)} | ${cell(x.status)} / ${cell(x.thread_status)} | ${cell(x.category_stored)} → ${cell(x.category_now)} | ${cell(x.stored_qualification)} | ${cell(x.qualification)} | ${cell(x.error ?? x.reason)} | ${cell(floor)} | ${ACTION_LABEL[x.flag_action]} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
