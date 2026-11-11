/**
 * navChips.ts — build read-only navigation chips from a tool result.
 *
 * The agent loop calls `buildNavChip(toolName, result)` after each tool runs and
 * collects the chips (deduped, capped) alongside the answer. A nav-chip is a
 * shortcut to an EXISTING app screen — nothing more:
 *
 *   get_deal (with a linked thread) → "Open this deal"  (its Thread screen)
 *   get_deal (no thread)            → "See all my deals" (Opportunities)
 *   list_deals (>5 rows, overflow)  → "See all my deals" (Opportunities)
 *   get_score   → "See your score"    (Brand tab)
 *   get_profile → "View your profile" (Profile tab)
 *   navigate    → a chip to whichever wired screen the tool resolved (deals,
 *                 score, signals, profile, studio, pitches, media)
 *
 * GROUNDING: chips come only from the tools the model actually called this turn,
 * so they always point at what the answer was about — never a fixed generic set.
 *
 * SCOPE: navigation only. No draft, reply, send, or profile edit ever becomes a
 * nav-chip (that's PR-7); a reply-shaped follow-up is an ask-chip instead. Tools
 * whose destination is ambiguous (get_rate_card, get_analytics, list_tasks_threads)
 * intentionally emit NO chip rather than risk landing on the wrong screen.
 *
 * TENANCY: the only id a chip carries is a threadId that get_deal already scoped
 * to the athlete server-side; the destination screen re-fetches scoped too. Pure +
 * deterministic (no DB, no clock) so it unit-tests without a harness.
 */

import type { MilaNavChip, NavScreen } from "./types";
import { DEAL_LIST_MAX } from "./widgets";

/** Most chips a single answer shows — keeps the pill row tidy. */
export const NAV_CHIP_MAX = 3;

// One label per screen-level target — the single source of truth so a `navigate`
// chip and a derived get_*/list_deals chip to the same screen are byte-identical
// (clean dedupe by target). `deal` (id-bearing) keeps its own inline label.
const NAV_LABEL: Record<NavScreen, string> = {
  deals: "See all my deals",
  score: "See your score",
  signals: "See your signals",
  profile: "View your profile",
  studio: "Open Studio",
  pitches: "See your pitches",
  media: "Open media library",
  deck: "Open your deck",
  rates: "See your floor",
  facts: "See your facts",
  story: "See your story",
};

const isNavScreen = (s: unknown): s is NavScreen =>
  typeof s === "string" && Object.prototype.hasOwnProperty.call(NAV_LABEL, s);

/**
 * Every chip a tool's result yields. Most tools yield at most one (buildNavChip). `waiting_on_you` (Checkpoint 1)
 * yields one chip per waiting request that has a mounted capability behind it — it opens the EXISTING upload surface
 * for that request. An item with no CTA yields no chip: never promise work nothing can do.
 */
export function buildNavChips(toolName: string, result: unknown): MilaNavChip[] {
  if (toolName === "waiting_on_you") {
    if (result === null || typeof result !== "object" || "error" in (result as object)) return [];
    const items = Array.isArray((result as any).items) ? ((result as any).items as Array<Record<string, any>>) : [];
    const chips: MilaNavChip[] = [];
    for (const it of items) {
      const kind = it?.cta?.kind;
      if (typeof it?.requestId !== "string" || (kind !== "add_contract" && kind !== "add_document")) continue;
      chips.push({ label: String(it.cta.label ?? (kind === "add_contract" ? "Add contract" : "Add document")), target: { screen: kind, requestId: it.requestId } });
    }
    return chips;
  }
  const one = buildNavChip(toolName, result);
  return one ? [one] : [];
}

/**
 * Map one tool's result to a single nav-chip, or null when there's nothing safe
 * to link to. `result` is the raw tool output the loop already has in hand.
 */
export function buildNavChip(
  toolName: string,
  result: unknown,
): MilaNavChip | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // A degraded tool surfaces as { error } — never a chip.
  if ("error" in r) return null;

  switch (toolName) {
    case "get_deal": {
      // Not a real deal row (get_deal returns null when not found/owned).
      if (typeof r.id !== "string") return null;
      const brandName =
        typeof r.brand_name === "string" && r.brand_name
          ? r.brand_name
          : undefined;
      // Deal HAS a linked thread → open that exact deal (its Thread screen).
      if (typeof r.thread_id === "string" && r.thread_id) {
        return {
          label: "Open this deal",
          target: { screen: "deal", threadId: r.thread_id, brandName },
        };
      }
      // Deal exists but has no thread → nowhere specific to land, so fall back to
      // the deals list rather than pointing "this deal" at a screen it can't open.
      return { label: NAV_LABEL.deals, target: { screen: "deals" } };
    }

    case "list_deals":
      // list_deals now renders up to 5 rows inline as a deal_list, so the chip is
      // only useful as an OVERFLOW affordance: show it when there were more than
      // those 5 (the rest live on the deals screen). ≤5 → every deal is already a
      // card above, so no redundant link-out.
      //
      // `total` (list_deals' whole-book count) is the right test now that the tool
      // reports one: an athlete with 169 deals seeing 5 cards needs the link-out even
      // when the page itself held only 5. Falls back to the row count for the older
      // bare-array shape.
      {
        const rows = Array.isArray(result)
          ? result
          : (result as { deals?: unknown } | null)?.deals;
        const total = (result as { total?: unknown } | null)?.total;
        const count =
          typeof total === "number" ? total : Array.isArray(rows) ? rows.length : 0;
        return count > DEAL_LIST_MAX
          ? { label: NAV_LABEL.deals, target: { screen: "deals" } }
          : null;
      }

    case "get_score":
      return { label: NAV_LABEL.score, target: { screen: "score" } };

    case "get_profile":
      return { label: NAV_LABEL.profile, target: { screen: "profile" } };

    case "navigate": {
      // The navigate tool already resolved the request to a wired screen-level
      // target (or { navigated:false }). Emit the SAME { label, target } shape
      // every chip uses; an unmapped/false result yields no chip (never a broken
      // target). The `deal` (id-bearing) target is get_deal's job, not navigate's.
      const screen = r.navigated === true ? r.screen : null;
      return isNavScreen(screen)
        ? { label: NAV_LABEL[screen], target: { screen } }
        : null;
    }

    default:
      // get_rate_card, get_analytics, list_tasks_threads, get_help and anything
      // new: no chip until its destination is certain. Silent by design.
      return null;
  }
}

/**
 * Dedupe (by target) and cap a turn's worth of chips. First occurrence wins, so
 * ordering the raw list by relevance before calling this keeps the best chips.
 */
export function dedupeNavChips(chips: MilaNavChip[]): MilaNavChip[] {
  const seen = new Set<string>();
  const out: MilaNavChip[] = [];
  for (const chip of chips) {
    const key = JSON.stringify(chip.target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
    if (out.length >= NAV_CHIP_MAX) break;
  }
  return out;
}
