// Filtered / not-a-deal — filteredLogic: the pure core of the "what I filed as junk" view.
//
// Dependency-free (no React, no RN, no hooks) so it's trivially unit-testable and
// FilteredView stays a thin view over it. Mirrors weekLogic.ts in spirit.
//
// SOURCE: the non-deals Nomila files are `agent_actions` rows with action='file' and a
// payload of `{ kind: 'junk', category, brand_name, confidence, external_message_id }`,
// plus a `reason` (the noise_reason — e.g. "affiliate program recruitment"). This is a
// SUBSET of the "file" action: only kind==='junk' is a non-deal we filed as noise. Other
// filings (a real deal the athlete filed) are NOT junk and never appear here.
//
// Honesty: we never fabricate a sender or reason. Missing labels degrade to honest
// generics ("Unknown sender" / "Filtered as noise") rather than inventing detail.

import type { AgentActionRow } from "../../../hooks/use-agent-actions";

// ─── Row + group shapes ──────────────────────────────────────────────────────────

/** One filed non-deal, ready to render. */
export interface FilteredItem {
  /** agent_actions.id — the handle a future "recover" would act on. */
  id:        string;
  /** Best-available sender/brand label, never fabricated. */
  sender:    string;
  /** Mila's noise_reason for filing it (already the group key when grouped). */
  reason:    string;
  /** Coarse category from the payload, if logged (e.g. "affiliate"). */
  category:  string | null;
  /** Short human date ("Aug 12"), or null when the row is undated. */
  dateLabel: string | null;
  /** Sort key (ms), null when undated. */
  ts:        number | null;
}

/** A reason-bucket: every non-deal filed for the same reason, newest first. */
export interface FilteredGroup {
  reason: string;
  items:  FilteredItem[];
}

export interface Filtered {
  /** Reason-grouped, groups ordered by size (biggest first) then most-recent. */
  groups:  FilteredGroup[];
  /** Flat newest-first list (handy for counts / a future ungrouped mode). */
  items:   FilteredItem[];
  /** Total filed non-deals shown. */
  total:   number;
  /** True when nothing has been filed as junk — drives the warm empty state. */
  isEmpty: boolean;
}

// ─── Extractors (never fabricate) ─────────────────────────────────────────────────

/** True when this agent action is a filed NON-DEAL (junk), not a real filed deal. */
export function isJunkFiling(row: AgentActionRow): boolean {
  return row.action === "file" && (row.payload?.kind === "junk");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function timeMs(row: AgentActionRow): number | null {
  const ms = row.created_at ? Date.parse(row.created_at) : NaN;
  return isFinite(ms) ? ms : null;
}

function dateLabel(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function sender(row: AgentActionRow): string {
  const p = row.payload ?? {};
  const candidate =
    (p.brand_name as string | undefined) ??
    (p.brand as string | undefined) ??
    (p.sender as string | undefined) ??
    (p.from as string | undefined);
  const clean = candidate?.trim();
  return clean || "Unknown sender";
}

function reasonOf(row: AgentActionRow): string {
  const fromReason = row.reason?.trim();
  if (fromReason) return fromReason;
  const cat = (row.payload?.category as string | undefined)?.trim();
  if (cat) return cat;
  return "Filtered as noise";
}

function categoryOf(row: AgentActionRow): string | null {
  const cat = (row.payload?.category as string | undefined)?.trim();
  return cat || null;
}

/** Sentence-case a reason for a group heading ("affiliate program recruitment" → "Affiliate program recruitment"). */
export function titleizeReason(reason: string): string {
  if (!reason) return reason;
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

// ─── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build the filtered view from the agent-actions feed. `now` injectable for tests.
 *
 * - Keeps only junk filings (action='file', payload.kind='junk') that haven't been undone.
 * - Groups by reason (case-insensitive key), biggest group first, then most recent.
 */
export function buildFiltered(
  actions: AgentActionRow[] | undefined | null,
  _now: number = Date.now(),
): Filtered {
  const rows = (actions ?? []).filter(isJunkFiling).filter((r) => r.undone_at == null);

  const items: FilteredItem[] = rows
    .map((r) => {
      const ts = timeMs(r);
      return {
        id:        r.id,
        sender:    sender(r),
        reason:    reasonOf(r),
        category:  categoryOf(r),
        dateLabel: dateLabel(ts),
        ts,
      };
    })
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  // Group by reason (case-insensitive), preserving the first-seen display casing.
  const byKey = new Map<string, FilteredGroup>();
  for (const it of items) {
    const key = it.reason.toLowerCase();
    const g = byKey.get(key);
    if (g) g.items.push(it);
    else byKey.set(key, { reason: titleizeReason(it.reason), items: [it] });
  }

  const groups = [...byKey.values()].sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return (b.items[0]?.ts ?? 0) - (a.items[0]?.ts ?? 0);
  });

  return { groups, items, total: items.length, isEmpty: items.length === 0 };
}
