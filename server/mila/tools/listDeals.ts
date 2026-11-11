/**
 * listDeals.ts — Mila read tool: the athlete's deals.
 *
 * Reads `deals` filtered by athlete_id, optionally by status, sorted by value
 * or recency. Amounts (numeric jsonb → string in drizzle) are coerced to numbers.
 *
 * ─── THE ROWS ARE A PAGE, AND THE PAGE SAYS SO ────────────────────────────────────────────────
 * This returned a bare array, capped at ten. Nothing in the result said how many deals existed,
 * so the only number the model could see was the number of rows it was handed — and it reported
 * that as the whole book: "All ten active deals are tracking normally", to an athlete with 206.
 * A cap the reader cannot see is indistinguishable from a total.
 *
 * So the result is now an object: the page, plus `total` and a `by_status` breakdown. Ten rows
 * out of 169 is a fine answer; ten rows described as all of them is not.
 *
 * `by_status` is there for a second reason. 196 of those 206 are `detected` — unqualified inbox
 * hits like "StartX1" and "Unknown Brand" that no one has looked at. Calling those "active deals"
 * is wrong at any cardinality, so the breakdown gives the model the vocabulary to tell the eight
 * live ones from the noise instead of counting rows.
 *
 * ─── ONE DEAL IS ONE ANSWER, WHATEVER ITS THREAD COUNT ────────────────────────────────────────
 * A deal can arrive as several email threads — the negotiation, the e-signature request, the
 * "completed" notice, each reminder — and each one mints its own `deals` row. The detector is
 * right to do that: the Adobe Sign thread is where the SIGNED status lives, and the negotiation
 * thread is where the offer lives. `deal_group_id` is what puts them back together.
 *
 * The app has always collapsed on it (`collapseDealGroups` in server/routes/deals.ts, whose
 * comment names this exact case: "gorjana is six rows under one deal_group_id"). This tool did
 * not, so the same athlete was told "six gorjana deals" by Mila and shown one by the app. Same
 * database, two read paths, one of which never learned about grouping.
 *
 * So the group is the unit here too, and the rules below MIRROR the app's deliberately — a
 * second, subtly different collapse would just move the disagreement rather than end it:
 *   · the representative is the most-advanced-status member, then the most recent;
 *   · the offer is borrowed from a sibling when the representative has none;
 *   · `thread_count` travels with the row, so Mila can say "one deal, across six threads"
 *     instead of having to choose between a wrong number and a missing one.
 */

import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxThreads } from "../../../shared/schema";
import { MILA } from "../config";
import { resolveVoiceOffer } from "../offerMoney";
import type { MilaTool } from "../types";
import { withoutDealScore } from "./modelView";
import { external } from "../../lib/externalContent";

/**
 * A deal row as a model may see it: no retired score, and the brand name — brand-derived text,
 * from the sender's own email — fenced as untrusted data, like get_deal's subject and summary.
 */
function modelRow<T>(row: T): T {
  const r = withoutDealScore(row) as Record<string, unknown>;
  if (!r || typeof r !== "object") return row;
  return (typeof r.brand_name === "string" ? { ...r, brand_name: external(r.brand_name) } : r) as T;
}
import { dealLines, dealPositions, readOpportunityBoard } from "../../services/opportunityBoard";
import { notMaybeDeal } from "../../lib/maybeDeal";


const DEAL_STATUSES = [
  "detected",
  "pending",
  "negotiating",
  "accepted",
  "completed",
  "rejected",
] as const;

const listDealsArgs = z.object({
  status: z
    .enum(DEAL_STATUSES)
    .optional()
    .describe("Only deals in this status."),
  sort_by: z
    .enum(["priority", "value", "recency"])
    .optional()
    .describe(
      "priority (default): what matters most first — the same order as the Opportunities " +
      "screen. value: highest amount first. recency: newest first.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Max deals to return (1-10). Defaults to 10."),
});

/** numeric column → number; null/NaN stay null. */
const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Which member of a cross-thread group speaks for it: most-advanced status, then
 * most recent. Terminal states sort LOW so a live thread represents the deal.
 *
 * Copied deliberately from GROUP_STATUS_RANK in server/routes/deals.ts. The two
 * must agree — if they ever drift, Mila and the Opportunities list start naming
 * different rows as "the gorjana deal", which is the bug this whole collapse
 * exists to end.
 */
const GROUP_STATUS_RANK: Record<string, number> = {
  accepted: 4, negotiating: 3, pending: 2, detected: 1, completed: 0, rejected: -1,
};

export const listDealsTool: MilaTool<typeof listDealsArgs> = {
  name: "list_deals",
  description:
    "List the athlete's deals — brand, amount, status, type, and when each was " +
    "detected. Optionally filter by status (detected, pending, negotiating, " +
    "accepted, completed, rejected). " +
    "RETURNS A PAGE, NOT THE WHOLE BOOK: `deals` holds at most 10 rows, `showing` " +
    "is how many came back, and `total` is how many the athlete actually has. " +
    "NEVER describe the rows as all of them — an athlete with 206 deals gets 10 " +
    "rows, and calling that \"all ten deals\" is wrong. Use `total` for any count. " +
    "`by_status` breaks the total down: treat `detected` as UNQUALIFIED inbox hits " +
    "nobody has looked at, not as active deals. The live book is accepted + " +
    "negotiating. Each row also carries " +
    "`offer`: the money resolved from the live thread rather than the deal row, " +
    "where `offer.moneyState` says whether the figure is confirmed (stated), a " +
    "span (range), present-but-uncorroborated (unverified), or absent because " +
    "nobody has named a price (unstated). Prefer `offer.amount` over `amount` — " +
    "the latter is a detection-time snapshot that goes stale. A null " +
    "`offer.amount` never means the deal is free or small. Each row is ONE deal: " +
    "a deal that arrived on several email threads (a negotiation, an e-signature " +
    "request, its reminders) is returned once, with `thread_count` saying how many " +
    "threads it spans. Never report `thread_count` as a number of deals — say " +
    "\"one deal, across N threads\" when it is above 1. When a row carries `why`, it is the " +
    "Opportunities card's one-line reason for its place: use it rather than inventing one.",
  argsSchema: listDealsArgs,
  // The retired 1–10 score and its verdict never reach a model (owner decision, 5 Oct 2026);
  // the raw rows keep them only for the chat deal_list card ring. See ./modelView. The brand
  // name is fenced for the model (12 Oct 2026); the card renders the raw rows.
  modelView: (result) => {
    const r = result as { deals?: unknown } | null;
    if (!r || typeof r !== "object" || !Array.isArray(r.deals)) return result;
    return { ...r, deals: r.deals.map(modelRow) };
  },
  async execute(athleteId, args) {
    const limit = args.limit ?? 10;

    // Sort in SQL with an explicit `id` tiebreak so the dedupe winner is
    // deterministic: for `value`, the highest-amount row of a duplicate group
    // survives; for `recency`, the most recent. NULLS LAST keeps unpriced /
    // undated rows from crowding out real ones.
    // `priority` is the default because the alternative demonstrably misleads: ordered by
    // recency, Mia's ten newest rows are StartX1, x1, Unknown Brand and six other unqualified
    // detections, while her one ACCEPTED $14,000 deal — detected in July — falls off the page.
    // A greeting built from that page describes noise and omits the only deal that matters.
    const orderBy =
      args.sort_by === "recency"
        ? [
            sql`${deals.detected_at} DESC NULLS LAST`,
            sql`${deals.created_at} DESC NULLS LAST`,
            sql`${deals.id} ASC`,
          ]
        : args.sort_by === "value"
        ? [
            sql`${deals.amount} DESC NULLS LAST`,
            sql`${deals.detected_at} DESC NULLS LAST`,
            sql`${deals.id} ASC`,
          ]
        : [
            sql`case ${deals.status} when 'accepted' then 4 when 'negotiating' then 3 when 'pending' then 2 when 'detected' then 1 when 'completed' then 0 else -1 end DESC`,
            sql`${deals.amount} DESC NULLS LAST`,
            sql`${deals.detected_at} DESC NULLS LAST`,
            sql`${deals.id} ASC`,
          ];

    // A D5 "Maybe" email is not a deal yet (lib/maybeDeal): never in Mila's list.
    const where = args.status
      ? and(eq(deals.athlete_id, athleteId), eq(deals.status, args.status), notMaybeDeal(deals.id))
      : and(eq(deals.athlete_id, athleteId), notMaybeDeal(deals.id));

    const rows = await db
      .select({
        id: deals.id,
        brand_name: deals.brand_name,
        amount: deals.amount,
        status: deals.status,
        deal_type: deals.deal_type,
        detected_at: deals.detected_at,
        // The cross-thread group key. Never returned to the model: it is a join
        // handle, and a deal's identity is its own id.
        deal_group_id: deals.deal_group_id,
        // One key only — see ./getDeal. Never returned.
        raw_data: deals.raw_data,
      })
      .from(deals)
      .where(where)
      .orderBy(...orderBy)
      // Defensive cap: an athlete's deal count is small; fetch enough to dedupe
      // before slicing to `limit`.
      .limit(100);

    // The empty case returns the SAME shape as every other case. Returning a bare
    // array here (as it used to) meant the one path where the answer is "none" was
    // also the one path with no `total` on it — so a caller reading `.deals` got
    // undefined precisely when it was asking about an athlete with nothing.
    if (rows.length === 0) {
      return { deals: [], showing: 0, total: 0, filtered_by_status: args.status ?? null, by_status: {} };
    }

    // Look up each deal's linked thread external id for the dedupe key. Filter
    // by athlete_id too — never resolve a thread outside this athlete's lane.
    const threadRows = await db
      .select({
        deal_id: inboxThreads.deal_id,
        external_thread_id: inboxThreads.external_thread_id,
        // Structured money only — see the note in ./getDeal. Ranking questions
        // are answered from THIS list in one call, so a stale figure here is
        // what makes Mila rank the wrong deal first.
        conversation_state: inboxThreads.conversation_state,
      })
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.athlete_id, athleteId),
          inArray(
            inboxThreads.deal_id,
            rows.map((r) => r.id),
          ),
        ),
      );
    // First thread per deal wins for BOTH the dedupe key and the score, so the
    // two stay consistent (the card's verdict belongs to the same thread whose
    // id keyed the dedupe).
    const threadByDeal = new Map<string, string | null>();
    const convStateByDeal = new Map<string, unknown>();
    for (const t of threadRows) {
      if (t.deal_id && !threadByDeal.has(t.deal_id)) {
        threadByDeal.set(t.deal_id, t.external_thread_id);
        convStateByDeal.set(t.deal_id, t.conversation_state ?? null);
      }
    }

    // Group the rows. `deal_group_id` is the real answer where it exists; the
    // older (brand, thread) key stays as the fallback for rows the grouper has
    // not reached, and an unlinked deal keys on its own id so two genuinely
    // distinct deals can never merge.
    const groups = new Map<string, typeof rows>();
    const order: string[] = [];
    for (const row of rows) {
      const ext = threadByDeal.get(row.id) ?? null;
      const key = row.deal_group_id
        ? `grp::${row.deal_group_id}`
        : ext
          ? `${row.brand_name}::${ext}`
          : `id::${row.id}`;
      const arr = groups.get(key);
      if (arr) arr.push(row);
      else {
        groups.set(key, [row]);
        order.push(key);
      }
    }

    // Pick each group's representative the way the app does. The SQL sort cannot
    // do this: under `recency` the newest member wins, and for a deal whose newest
    // thread is a "waiting for you to sign" reminder that is an unpriced `detected`
    // row standing in for an accepted $14,000 deal.
    const deduped: typeof rows = [];
    const sizeByDeal = new Map<string, number>();
    for (const key of order) {
      const arr = groups.get(key)!;
      const base =
        arr.length === 1
          ? arr[0]
          : [...arr].sort((a, b) => {
              const sr =
                (GROUP_STATUS_RANK[b.status ?? ""] ?? 0) -
                (GROUP_STATUS_RANK[a.status ?? ""] ?? 0);
              if (sr !== 0) return sr;
              return String(b.detected_at ?? "").localeCompare(
                String(a.detected_at ?? ""),
              );
            })[0];

      // Borrow money from a sibling when the representative carries none — the
      // signed thread rarely restates the figure that was agreed on the
      // negotiation thread, and a deal reported without its offer reads as free.
      if (arr.length > 1 && base.amount == null) {
        const richest = arr
          .filter((r) => r.amount != null)
          .sort((a, b) => Number(b.amount) - Number(a.amount))[0];
        if (richest) {
          base.amount = richest.amount;
          if (!convStateByDeal.get(base.id)) {
            convStateByDeal.set(base.id, convStateByDeal.get(richest.id) ?? null);
          }
        }
      }

      sizeByDeal.set(base.id, arr.length);
      deduped.push(base);
    }

    // Default sort: the opportunity board's ONE order (services/opportunityBoard) — the same order and the same
    // card line the Opportunities screen shows. The retired score is never read.
    let lines: Map<string, string> | null = null;
    if ((args.sort_by ?? "priority") === "priority") {
      const board = await readOpportunityBoard(athleteId, new Date());
      const pos = dealPositions(board);
      lines = dealLines(board);
      const at = (d: { id: string }) => pos.get(d.id) ?? Number.MAX_SAFE_INTEGER;
      deduped.sort((a, b) => at(a) - at(b));
    }

    const result = deduped.slice(0, limit).map((row) => {
      return {
        id: row.id,
        brand_name: row.brand_name,
        amount: toNumber(row.amount),
        // See ./getDeal — the speakable figure, from the thread's structured
        // fields. The voice wire maps money from here and drops `amount`.
        offer: resolveVoiceOffer(
          convStateByDeal.get(row.id),
          row.amount != null,
          toNumber(row.amount),
          (row.raw_data as { deliverables?: unknown } | null)?.deliverables,
        ),
        status: row.status,
        deal_type: row.deal_type,
        detected_at: row.detected_at,
        // Structured grid assessment (null when the deal was stored unscored).
        // The 1–10 deal score is retired: nothing is scored any more.
        verdict: null,
        score_numeric: null,
        // How many email threads this ONE deal arrived on. 1 for most. Above 1 it
        // is the difference between "six gorjana deals" and "one, across six
        // threads" — so it is stated rather than left for the model to infer.
        thread_count: sizeByDeal.get(row.id) ?? 1,
        // OPPS_RANKING: why this opportunity sits where it does, in the card's own words.
        ...(lines ? { why: lines.get(row.id) ?? null } : {}),
      };
    });

    // ── How many there are, which the rows alone cannot say ────────────────────
    //
    // A second, deliberately tiny read: three scalar columns for every deal this
    // athlete has. It is the only way the count can agree with the collapse above —
    // counting rows in SQL would report 206 where the page reports groups, and two
    // numbers that disagree are worse than one that is missing.
    const allRows = await db
      .select({ id: deals.id, status: deals.status, group_id: deals.deal_group_id })
      .from(deals)
      .where(eq(deals.athlete_id, athleteId));

    // Group first, then count — one deal is one deal however many threads carried it.
    // A group's status is its most advanced member's, the same rule the page uses.
    const statusByGroup = new Map<string, string>();
    for (const row of allRows) {
      const key = row.group_id ?? row.id;
      const prev = statusByGroup.get(key);
      const st = row.status ?? "detected";
      if (
        prev === undefined ||
        (GROUP_STATUS_RANK[st] ?? 0) > (GROUP_STATUS_RANK[prev] ?? 0)
      ) {
        statusByGroup.set(key, st);
      }
    }
    const byStatus: Record<string, number> = {};
    for (const st of statusByGroup.values()) byStatus[st] = (byStatus[st] ?? 0) + 1;

    // Budget guard: small rows, but never hand the model an oversized payload.
    while (
      result.length > 1 &&
      JSON.stringify(result).length > MILA.TOOL_RESULT_MAX_CHARS
    ) {
      result.pop();
    }

    return {
      deals: result,
      // What this page is, said plainly. `showing` can be below `limit` — the budget
      // guard above drops rows silently — so it is measured, never assumed.
      showing: result.length,
      total: statusByGroup.size,
      filtered_by_status: args.status ?? null,
      by_status: byStatus,
    };
  },
};
