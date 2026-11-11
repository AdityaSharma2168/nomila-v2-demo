/**
 * reextractBrandDomainsCore.ts — the testable core of reextractBrandDomains.ts (brand imagery pipeline catch-up).
 *
 * Mail that arrived before classify extracted `advertiser_domain` (#790) left advertiser rows with no domain, so
 * they could never be identity-checked or pictured. For each athlete given, per brand behind an OPEN opportunity:
 *
 *   - the row already holds a domain → no model call; it is enqueued only if it has identity work outstanding
 *     (brandNeedsIdentityWork: never checked against that domain, or trusted but never pictured);
 *   - the row has no domain → the opportunity's lead thread's latest INBOUND message is re-read LIVE through the
 *     mailbox interface (never a stored body), the classify call runs ONLY for its advertiser_domain (kept only when
 *     literally present in the mail — literalAdvertiserDomain, inside classifyMessage), and a domain found is
 *     enqueued with the brand_identity_refresh job, which fills it by the usual rule.
 *
 * DRY-RUN (apply=false) writes nothing: `enqueue` is never called and every query here is a SELECT (the CLI also
 * opens its session read-only). The classify calls happen in both modes and are counted. Nothing is hard-coded:
 * the same path serves any athlete.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { inboxBrands, inboxMessages, opportunities } from "../../../shared/schema";
import { brandNeedsIdentityWork } from "../../lib/brandIdentity";
import { brandDomainOf } from "../../lib/senderProfile";
import type { Classification } from "../../skills/dealDetector";

export type ClassifyFn = (from: string, subject: string, body: string) => Promise<Classification>;
export type LatestInbound = { from: string; subject: string; text: string } | { unavailable: string } | null;
export type ReadLatestInboundFn = (athleteId: string, threadId: string) => Promise<LatestInbound>;
export type EnqueueFn = (athleteId: string, brandId: number, domain: string | null) => Promise<{ runId: string } | null>;

export interface ReextractRow {
  athlete_id: string;
  brand_id: number;
  brand: string;
  domain_held: string | null;
  thread_id: string | null;
  found_domain: string | null;
  /** held: the row already had a domain; advertiser_domain: classify found it in the mail now. */
  source: "held" | "advertiser_domain" | null;
  action: "enqueue" | "enqueued" | "none" | "error";
  note: string | null;
}

export interface ReextractReport { apply: boolean; athletes: number; brands: number; classifyCalls: number; enqueued: number; rows: ReextractRow[] }

interface Target { athlete_id: string; brand_id: number; lead_thread_id: string | null }

/** One row per (athlete, brand) behind an open opportunity, the most recently active opportunity's lead thread. */
export async function openOpportunityBrands(dbx: any, athleteIds: string[]): Promise<Target[]> {
  if (!athleteIds.length) return [];
  const rows: Target[] = await dbx.select({ athlete_id: opportunities.athlete_id, brand_id: opportunities.brand_id, lead_thread_id: opportunities.lead_thread_id })
    .from(opportunities)
    .where(and(inArray(opportunities.athlete_id, athleteIds), eq(opportunities.status, "open"), isNotNull(opportunities.brand_id)))
    .orderBy(desc(opportunities.last_activity_at));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.athlete_id}:${r.brand_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How many classify calls a run would make (brands with no domain and a lead thread). */
export async function estimate(dbx: any, athleteIds: string[]): Promise<{ brands: number; classifyCalls: number }> {
  const targets = await openOpportunityBrands(dbx, athleteIds);
  if (!targets.length) return { brands: 0, classifyCalls: 0 };
  const brands = await dbx.select({ id: inboxBrands.id, domain: inboxBrands.domain, is_agency: inboxBrands.is_agency }).from(inboxBrands)
    .where(inArray(inboxBrands.id, [...new Set(targets.map((t) => t.brand_id))]));
  const byId = new Map<number, any>(brands.map((b: any) => [b.id, b]));
  const calls = targets.filter((t) => { const b = byId.get(t.brand_id); return b && !b.is_agency && !brandDomainOf(b.domain) && t.lead_thread_id; }).length;
  return { brands: targets.length, classifyCalls: calls };
}

export async function reextractBrandDomains(p: {
  dbx: any;
  athleteIds: string[];
  apply: boolean;
  classify: ClassifyFn;
  readLatestInbound: ReadLatestInboundFn;
  enqueue: EnqueueFn;
  onProgress?: (row: ReextractRow) => void;
}): Promise<ReextractReport> {
  const targets = await openOpportunityBrands(p.dbx, p.athleteIds);
  const report: ReextractReport = { apply: p.apply, athletes: new Set(targets.map((t) => t.athlete_id)).size, brands: targets.length, classifyCalls: 0, enqueued: 0, rows: [] };
  const brandRows = targets.length
    ? await p.dbx.select().from(inboxBrands).where(inArray(inboxBrands.id, [...new Set(targets.map((t) => t.brand_id))]))
    : [];
  const byId = new Map<number, typeof inboxBrands.$inferSelect>(brandRows.map((b: any) => [b.id, b]));
  // The domains already held, so a found domain another row holds is reported, not enqueued.
  const held = new Map<string, number>();
  for (const b of await p.dbx.select({ id: inboxBrands.id, domain: inboxBrands.domain }).from(inboxBrands).where(isNotNull(inboxBrands.domain))) {
    const d = brandDomainOf(b.domain);
    if (d && !held.has(d)) held.set(d, b.id);
  }

  for (const t of targets) {
    const b = byId.get(t.brand_id);
    if (!b) continue;
    const row: ReextractRow = { athlete_id: t.athlete_id, brand_id: b.id, brand: b.name, domain_held: brandDomainOf(b.domain ?? null), thread_id: t.lead_thread_id, found_domain: null, source: null, action: "none", note: null };
    const done = async () => {
      if (row.action === "enqueue" && p.apply) {
        const r = await p.enqueue(t.athlete_id, b.id, row.source === "advertiser_domain" ? row.found_domain : null);
        if (r) { row.action = "enqueued"; report.enqueued++; } else row.note = "request not started (gate off or failed)";
      }
      report.rows.push(row);
      p.onProgress?.(row);
    };

    if (b.is_agency) { row.note = "agency row — never researched"; await done(); continue; }
    if (row.domain_held) {
      row.found_domain = row.domain_held;
      row.source = "held";
      if (brandNeedsIdentityWork(b)) row.action = "enqueue"; else row.note = "already checked";
      await done();
      continue;
    }
    if (!t.lead_thread_id) { row.note = "no lead thread"; await done(); continue; }

    // Is there an inbound message at all? Ids only — the body is read live, never from the DB.
    const [inbound] = await p.dbx.select({ id: inboxMessages.id }).from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, t.lead_thread_id), eq(inboxMessages.direction, "inbound"))).limit(1);
    if (!inbound) { row.note = "no inbound message"; await done(); continue; }
    const msg = await p.readLatestInbound(t.athlete_id, t.lead_thread_id);
    if (!msg) { row.action = "error"; row.note = "no live reader for this thread (MAILBOX_LIVE_READS off, or not a mailbox)"; await done(); continue; }
    if ("unavailable" in msg) { row.action = "error"; row.note = msg.unavailable; await done(); continue; }

    let cls: Classification;
    report.classifyCalls++;
    try {
      cls = await p.classify(msg.from, msg.subject, msg.text);
    } catch (err: any) {
      row.action = "error"; row.note = String(err?.message ?? err).slice(0, 160); await done(); continue;
    }
    const d = brandDomainOf(cls.advertiser_domain ?? null);
    if (!d) { row.note = cls.llm_error ? "classify failed" : "no advertiser domain in the mail"; await done(); continue; }
    row.found_domain = d;
    row.source = "advertiser_domain";
    const owner = held.get(d);
    if (owner && owner !== b.id) { row.note = `domain held by brand #${owner} — merge question, not enqueued`; await done(); continue; }
    row.action = "enqueue";
    await done();
  }
  return report;
}

/**
 * The production reader: the thread's conversation read LIVE (services/liveConversation), its latest inbound message,
 * with any PDF brief. null when no live reader applies — the caller reports it; there is NO stored-body fallback.
 */
export const readLatestInboundLive: ReadLatestInboundFn = async (athleteId, threadId) => {
  const { readThreadConversation, resolveLiveSource, textWithBrief } = await import("../../services/liveConversation.js");
  const conv = await readThreadConversation(athleteId, threadId);
  if (!conv) return null;
  if (!conv.ok) return { unavailable: conv.message };
  const inbound = conv.messages.filter((m) => m.direction === "inbound");
  const latest = inbound[inbound.length - 1];
  if (!latest) return { unavailable: "no inbound message in the mailbox conversation" };
  const source = await resolveLiveSource(athleteId, threadId);
  const text = source ? await textWithBrief({ adapter: source.adapter }, latest) : latest.text;
  return { from: latest.from, subject: latest.subject, text };
};

export function renderReport(r: ReextractReport): string {
  const lines = [
    `# Brand domain catch-up — ${r.apply ? "APPLY" : "DRY-RUN (nothing written)"}`,
    "",
    `athletes ${r.athletes} · brands ${r.brands} · classify calls ${r.classifyCalls} · ${r.apply ? `enqueued ${r.enqueued}` : `would enqueue ${r.rows.filter((x) => x.action === "enqueue").length}`}`,
    "",
    "| athlete | brand | held | found | source | action | note |",
    "|---|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.athlete_id.slice(0, 8)} | ${x.brand} (#${x.brand_id}) | ${x.domain_held ?? "—"} | ${x.found_domain ?? "—"} | ${x.source ?? "—"} | ${x.action} | ${x.note ?? ""} |`),
  ];
  return lines.join("\n");
}
