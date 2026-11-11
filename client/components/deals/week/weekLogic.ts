// WS5 · 5B The Week — weekLogic: the pure core of the receipt.
//
// Dependency-free (no React, no RN, no hooks) so it's trivially unit-testable and
// TheWeekView stays a thin view over it. Mirrors the spirit of files/dispositionStamp.ts.
//
// The Week is a Sunday RECEIPT, not a to-do list. Two data sources feed it:
//
//   1. `agent_actions` (the co-pilot audit trail, via useAgentActions) → the itemized
//      "Set aside by Nomila" list + the track-record number. Each set-aside line is
//      reversible (Undo) and correctable (Wrong?). May be EMPTY today (no writers wired
//      yet, ISSUE-9) — the receipt must render calmly with nothing set aside.
//
//   2. `deals` (DealItem[] from useDeals) → the three deal-derived motion sections:
//      Arrived · You moved · Still waiting. Derived purely from status + turn + age.
//
// Honesty rules (money-safe + action-honest):
//   - Never claim an auto-decline was SENT. The 24h hold's send-suppression is server-
//     side and not built yet, so the countdown is framed as the *window to undo*, never
//     as "sends in Xh".
//   - The Bar reframes the 0-"great" reality without implying we declined on her behalf
//     beyond what the receipt itemizes.

import type { DealItem, DealStatus } from "../DealCard";
import type { AgentActionRow, AgentActionKind } from "../../../hooks/use-agent-actions";

// ─── Windows ───────────────────────────────────────────────────────────────────

// The recap window: a rolling 30 days ("Last 30 Days"). Weekly was too sparse — a
// month gives the receipt real substance. Everything on the Last-30 screen is scoped
// to this window.
export const RECAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Best-available last-activity timestamp for a deal: last thread message when present
 *  (accurate recency), else detection time. Returns null when unparseable — such deals
 *  never enter aged buckets. */
export function dealActivityMs(deal: DealItem): number | null {
  const src = deal.lastMessageAt ?? deal.detectedAt;
  const ms  = src ? Date.parse(src) : NaN;
  return isFinite(ms) ? ms : null;
}

// ─── Deal-derived motion sections ────────────────────────────────────────────────

export type WeekBucket = "arrived" | "youMoved" | "stillWaiting";

/**
 * Route one deal into a single receipt bucket (or null = not part of this week's
 * motion). Pure; `now` injectable.
 *
 * Precedence (each deal lands in exactly one bucket or none):
 *   - rejected             → null       (a pass; it shows in "Set aside", not here)
 *   - accepted/completed   → youMoved   (you closed it)
 *   - brand's turn, recent → youMoved   (you just replied — ball's in their court)
 *   - brand's turn, stale  → stillWaiting (they've gone quiet on you)
 *   - your turn, recent    → arrived    (landed in your court this week)
 *   - your turn, stale     → null       (older unread; not this week's receipt)
 */
export function categorizeDeal(deal: DealItem, now: number = Date.now()): WeekBucket | null {
  if (deal.status === "rejected") return null;
  if (deal.status === "accepted" || deal.status === "completed") return "youMoved";

  const activity = dealActivityMs(deal);
  const recent   = activity != null && now - activity <= RECAP_WINDOW_MS;
  const brandsTurn = deal.awaitingResponseFrom === "brand";

  if (brandsTurn) return recent ? "youMoved" : "stillWaiting";
  // Her turn / unknown turn, still open (detected / pending / negotiating).
  return recent ? "arrived" : null;
}

export interface DealSections {
  arrived:      DealItem[];
  youMoved:     DealItem[];
  stillWaiting: DealItem[];
}

/** Split the flat deal list into the three motion sections, most-recent first. */
export function sectionDeals(deals: DealItem[], now: number = Date.now()): DealSections {
  const out: DealSections = { arrived: [], youMoved: [], stillWaiting: [] };
  for (const d of deals) {
    const bucket = categorizeDeal(d, now);
    if (bucket) out[bucket].push(d);
  }
  const byRecency = (a: DealItem, b: DealItem) => (dealActivityMs(b) ?? 0) - (dealActivityMs(a) ?? 0);
  out.arrived.sort(byRecency);
  out.youMoved.sort(byRecency);
  out.stillWaiting.sort(byRecency);
  return out;
}

// ─── The 24-hour hold (auto-decline) ─────────────────────────────────────────────

export interface HoldState {
  /** Remaining-time label, framed as the window to undo (never "sends in …"). */
  label:   string;
  /** True once the hold window has elapsed. */
  expired: boolean;
}

/**
 * Format an auto-decline's 24h hold as a countdown. The hold exists so a same-day Undo
 * means the brand never saw a "no"; the actual send-suppression is NOT built server-side
 * yet, so we describe the *undo window* honestly and never promise an automatic send.
 *
 * Returns null when there is no hold to show.
 */
export function formatHoldRemaining(
  heldUntil: string | null | undefined,
  now: number = Date.now(),
): HoldState | null {
  if (!heldUntil) return null;
  const until = Date.parse(heldUntil);
  if (!isFinite(until)) return null;

  const remaining = until - now;
  if (remaining <= 0) return { label: "hold elapsed", expired: true };

  const mins  = Math.floor(remaining / 60_000);
  const hours = Math.floor(mins / 60);
  let human: string;
  if (hours >= 1) {
    const rem = mins % 60;
    human = rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  } else {
    human = `${Math.max(1, mins)}m`;
  }
  return { label: `${human} left to undo`, expired: false };
}

// ─── Set aside by Nomila + track record (from agent_actions) ──────────────────────

// Which action kinds count as "Mila set this aside for you" (the itemized receipt).
const SET_ASIDE_KINDS: ReadonlySet<AgentActionKind> = new Set<AgentActionKind>(["file", "auto_decline", "auto_archive"]);

// Human verb per action kind (row headline).
const ACTION_VERB: Record<AgentActionKind, string> = {
  file:         "Filed",
  auto_decline: "Set aside",
  reclassify:   "Reclassified",
  mute_sender:  "Muted",
  reopen:       "Reopened",
  auto_archive: "Archived",
  confirm_signed: "Marked signed",
  split_deal:   "Split into its own deal",
};

export interface SetAsideItem {
  id:         string;
  action:     AgentActionKind;
  /** e.g. "Set aside" / "Filed" — the verb for the row. */
  verb:       string;
  /** Best-available human label for what was acted on (brand/subject/thread). */
  subject:    string;
  /** Mila's stated reason, if she logged one. */
  reason:     string | null;
  /** Undo is offered only for a reversible action that hasn't already been undone. */
  undoable:   boolean;
  /** Auto-decline hold countdown, if any (null for plain filings). */
  hold:       HoldState | null;
}

/** Pull a display subject out of an action's payload without ever fabricating one. */
function actionSubject(row: AgentActionRow): string {
  const p = row.payload ?? {};
  const candidate =
    (p.brand_name as string | undefined) ??
    (p.brand as string | undefined) ??
    (p.advertiser as string | undefined) ??
    (p.subject as string | undefined) ??
    (p.title as string | undefined);
  const clean = candidate?.trim();
  if (clean) return clean;
  // No brand label logged — stay honest and generic rather than inventing one.
  return row.deal_id ? "a deal" : "a message";
}

export interface TrackRecord {
  /** Total set-aside actions ever filed (file + auto_decline). */
  filed:    number;
  /** How many of those were later reopened (undone). */
  reopened: number;
  /** Accuracy: (filed − reopened) / filed, as a 1-dp string like "99.1". */
  pct:      string;
}

export interface Receipt {
  /** This-week set-aside lines, newest first, excluding ones already undone. */
  setAside:    SetAsideItem[];
  /** Running track record over ALL filed actions; null when nothing has ever been filed. */
  trackRecord: TrackRecord | null;
  /** True when Mila has set nothing aside at all — drives the calm empty state. */
  isEmpty:     boolean;
}

function actionTimeMs(row: AgentActionRow): number | null {
  const ms = row.created_at ? Date.parse(row.created_at) : NaN;
  return isFinite(ms) ? ms : null;
}

/**
 * Build the receipt from the agent-actions feed. `now` injectable for tests.
 *
 * - `setAside`: this-week `file`/`auto_decline` rows NOT yet undone, newest first.
 * - `trackRecord`: computed over ALL filed rows (reopened = filed rows with `undone_at`).
 * - `isEmpty`: no filed rows at all → the calm "nothing set aside" state.
 */
export function buildReceipt(
  actions: AgentActionRow[] | undefined | null,
  now: number = Date.now(),
): Receipt {
  const rows = actions ?? [];
  // Only what Nomila did on her own. A receipt marked as HER act (payload.actor "athlete" — she closed it, or asked Mila
  // to) is hers, never "Set aside by Nomila", and never counted in Nomila's track record.
  const filedRows = rows.filter((r) => SET_ASIDE_KINDS.has(r.action) && r.payload?.actor !== "athlete");

  // Track record over everything ever filed.
  const filed    = filedRows.length;
  const reopened = filedRows.filter((r) => r.undone_at != null).length;
  const trackRecord: TrackRecord | null =
    filed === 0
      ? null
      : { filed, reopened, pct: (((filed - reopened) / filed) * 100).toFixed(1) };

  // This-week, still-standing set-aside lines.
  const setAside: SetAsideItem[] = filedRows
    .filter((r) => r.undone_at == null)
    .filter((r) => {
      const t = actionTimeMs(r);
      return t == null || now - t <= RECAP_WINDOW_MS; // undated rows still show (don't hide work)
    })
    .sort((a, b) => (actionTimeMs(b) ?? 0) - (actionTimeMs(a) ?? 0))
    .map((r) => ({
      id:       r.id,
      action:   r.action,
      verb:     ACTION_VERB[r.action] ?? "Handled",
      subject:  actionSubject(r),
      reason:   r.reason?.trim() || null,
      undoable: r.reversible && r.undone_at == null,
      hold:     r.action === "auto_decline" ? formatHoldRemaining(r.held_until, now) : null,
    }));

  return { setAside, trackRecord, isEmpty: filed === 0 };
}

// ─── The Bar (the 0-"great" reframe) ─────────────────────────────────────────────

/** Strip a money string ("$2,000", "2000") to a number; null when there's no figure. */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) && raw > 0 ? raw : null;
  const digits = raw.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return isFinite(n) && n > 0 ? n : null;
}

/** Format a whole-dollar figure as "$835" / "$1,108". */
export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * The highest offer figure seen across the deals — a fallback "line" to hold when the
 * athlete hasn't set an explicit floor. Returns null when no deal has a number.
 */
export function highestOffer(deals: DealItem[]): number | null {
  let best: number | null = null;
  for (const d of deals) {
    const v = parseMoney(d.offerDisplay) ?? parseMoney(d.offerAmount);
    if (v != null && (best == null || v > best)) best = v;
  }
  return best;
}

export interface TheBar {
  /** The dollar figure being held, formatted (null when no floor known). */
  amount: string | null;
  /** The one-line reframe. */
  line:   string;
  /** True when the figure is Mila's inferred line, not a floor the athlete set. */
  inferred: boolean;
}

/**
 * Reframe the 0-"great" reality as "held your line at $X". Pure and money-safe: it never
 * claims we declined anything on her behalf — it states the floor and whether the week's
 * deals cleared it.
 *
 * @param floor      the athlete's set floor (minimum_rate), or null if unset
 * @param greatCount number of "great"-verdict deals this week (from deals)
 * @param inferred   optional inferred line to fall back on when there's no floor
 */
export function buildTheBar(
  floor: number | null,
  greatCount: number,
  inferred: number | null = null,
): TheBar {
  const figure = floor ?? inferred;
  if (figure == null) {
    return {
      amount: null,
      inferred: false,
      line: "Set a floor and I'll hold it for you — then this is where I show you it held.",
    };
  }
  const amount   = formatMoney(figure);
  const isInferred = floor == null;
  const heldPrefix = isInferred
    ? `Holding your line around ${amount}`
    : `Held your line at ${amount}`;

  const line =
    greatCount === 0
      ? `${heldPrefix}. Nothing this week cleared it — that's the bar doing its job, not a slow week.`
      : `${heldPrefix}. ${greatCount} ${greatCount === 1 ? "offer" : "offers"} cleared it this week.`;

  return { amount, line, inferred: isInferred };
}

/** Count "great"-verdict deals (the ones that clear a high bar). */
export function greatCount(deals: DealItem[]): number {
  return deals.filter((d) => d.verdict === "great").length;
}

// ─── Convenience: does the whole receipt (both sources) have nothing to show? ─────

/** True when there is neither set-aside work nor any deal motion — the fully-quiet week. */
export function weekIsQuiet(receipt: Receipt, sections: DealSections): boolean {
  return (
    receipt.isEmpty &&
    sections.arrived.length === 0 &&
    sections.youMoved.length === 0 &&
    sections.stillWaiting.length === 0
  );
}

// Re-exported for the view's copy.
export { ACTION_VERB };
export type { DealStatus };
