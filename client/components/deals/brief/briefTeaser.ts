// WS-Brief · briefTeaser — the "Your Week" link-card teaser + the "Ask for terms"
// unpriced count. Pure, dependency-free (no React/RN), so it's trivially unit-testable
// and reuses weekLogic's derivations rather than forking them.
//
// The teaser is activity-led and DATA-DRIVEN with a graceful fallback ladder. The one
// hard rule: never surface a fake / zero-y number. When a tier's numbers aren't real,
// we fall DOWN the ladder to a tier whose numbers are.
//
//   full   → "Mila handled {N} this week — {junk} set aside, {asked} asked for terms"
//   sparse → "{arrived} arrived · {needsYou} need you"   (zero clauses dropped)
//   empty  → "Your week so far"
//
// The trailing "→" affordance is drawn by the card (a chevron), not baked into the copy.

import type { DealItem } from "../DealCard";
import type { AgentActionRow } from "../../../hooks/use-agent-actions";
import { sectionDeals, buildReceipt } from "../week/weekLogic";

// ─── Brief visibility (mirrors BriefView's isBriefVisible — live work only) ───────

/** A deal is "open" when it's neither passed nor closed nor filed/archived. */
export function isOpenDeal(d: DealItem): boolean {
  return d.status !== "rejected" && d.status !== "completed" && d.threadStatus !== "archived";
}

// ─── "Needs your reply" — the honest, tightened count ─────────────────────────────
//
// `awaiting_response_from = "athlete"` alone is too broad: it stays set on threads whose
// deadline is long past (a finished "World Cup" campaign) or that have gone cold for
// weeks. Counting those as "asks that need a reply" is what made the Brief say a scary
// "81 need you". A deal only truly NEEDS a reply when it's open, it's your turn, its
// window hasn't closed, and the thread isn't a fossil.

const DAY_MS = 86_400_000;
const REPLY_EXPIRE_DAYS = 21; // deadline this far past → window closed
const REPLY_STALE_DAYS  = 21; // no activity for this long → not a live "reply owed"

function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : Math.max(0, (now - t) / DAY_MS);
}

function deadlineExpired(deadline: string | null | undefined, now: number): boolean {
  const past = daysSince(deadline, now);
  return past != null && past > REPLY_EXPIRE_DAYS;
}

/**
 * True when a deal genuinely needs YOUR reply right now: open, it's the athlete's turn,
 * the deadline (if any) hasn't well-and-truly passed, and the thread isn't 3+ weeks cold.
 * This is the single source of truth for the greeting count, the Brief tab badge, the
 * "Needs your reply" section, and the teaser's "waiting on you".
 */
export function needsReply(d: DealItem, now: number = Date.now()): boolean {
  if (!isOpenDeal(d)) return false;
  if (d.awaitingResponseFrom !== "athlete") return false;
  if (deadlineExpired(d.deadline, now)) return false;
  const age = daysSince(d.lastMessageAt ?? d.detectedAt, now);
  if (age != null && age > REPLY_STALE_DAYS) return false;
  return true;
}

/** Count of deals that genuinely need the athlete's reply (see {@link needsReply}). */
export function needsReplyCount(deals: DealItem[], now: number = Date.now()): number {
  return deals.filter((d) => needsReply(d, now)).length;
}

// ─── "Ask for terms" — unpriced open deals ────────────────────────────────────────

/** True when an open deal has no stated price at all (nothing to counter — only to ask). */
export function isUnpriced(d: DealItem): boolean {
  // A sender we can't verify is never in the one-tap ask-for-terms batch.
  // …nor an interview / press ask or a school request, which is answered, never asked for a budget.
  return isOpenDeal(d) && !d.offerDisplay && !d.offerAmount && d.channel !== "unverifiable"
    && d.sourceCategory !== "MEDIA" && d.sourceCategory !== "SCHOOL_NIL";
}

/** Count open deals where no price was ever named — the "Ask for terms" batch size. */
export function countUnpriced(deals: DealItem[]): number {
  return deals.filter(isUnpriced).length;
}

// ─── Teaser inputs (the five real numbers) ────────────────────────────────────────

export interface TeaserInputs {
  /** Everything Mila + you moved on this week (deal motion + set-aside). */
  handled:  number;
  /** Things Mila set aside for you (filed / auto-declined) this week. */
  setAside: number;
  /** Deals you moved into a negotiation this week (a terms ask / counter). */
  asked:    number;
  /** New deals that landed in your court this week. */
  arrived:  number;
  /** Open deals whose turn is yours (you owe a reply). */
  needsYou: number;
}

/**
 * Derive the five teaser numbers from the deals feed + the agent-actions receipt,
 * reusing weekLogic (sectionDeals + buildReceipt) so nothing is re-derived here.
 * `now` is injectable for deterministic tests.
 */
export function deriveTeaserInputs(
  deals:   DealItem[],
  actions: AgentActionRow[] | undefined | null,
  now:     number = Date.now(),
): TeaserInputs {
  const sections = sectionDeals(deals, now);
  const receipt  = buildReceipt(actions, now);

  const setAside = receipt.setAside.length;
  const asked    = sections.youMoved.filter((d) => d.status === "negotiating").length;
  const handled  = sections.youMoved.length + setAside;
  const arrived  = sections.arrived.length;
  const needsYou = needsReplyCount(deals, now); // tightened — excludes expired/cold threads

  return { handled, setAside, asked, arrived, needsYou };
}

// ─── The ladder ───────────────────────────────────────────────────────────────────

export type TeaserTier = "full" | "sparse" | "empty";

export interface WeekTeaser {
  tier: TeaserTier;
  /** The composed one-liner (no trailing arrow — the card draws the chevron). */
  text: string;
}

/**
 * Choose the richest tier whose numbers are real, and compose its line. The copy
 * leads with Mila's agency (what she did FOR you) so the card reassures rather than
 * dumps a scary backlog number.
 *
 *   - full   whenever Mila actually moved something (handled > 0): "Mila handled N
 *            for you this week" + whichever detail clauses are real (set aside /
 *            moved to terms / new in). No zero clause ever appears.
 *   - sparse nothing handled yet, but there's live movement to name (arrived OR
 *            needsYou > 0); any zero clause is dropped.
 *   - empty  the honest floor — nothing to show yet, said warmly.
 */
export function buildWeekTeaser(input: TeaserInputs): WeekTeaser {
  const { handled, setAside, asked, arrived, needsYou } = input;

  if (handled > 0) {
    const detail: string[] = [];
    if (setAside > 0) detail.push(`${setAside} set aside`);
    if (asked > 0)    detail.push(`${asked} moved to terms`);
    if (arrived > 0)  detail.push(`${arrived} new in`);
    const tail = detail.length ? ` — ${detail.join(", ")}` : "";
    return {
      tier: "full",
      text: `Mila handled ${handled} for you${tail}`,
    };
  }

  // SPARSE — nothing handled yet, but there's live movement. Written as a sentence
  // (hybrid: language carrying the numbers) rather than a bare "N · M" data line. The
  // "Last 30 days" card kicker frames the window, so the copy no longer says "this week".
  if (arrived > 0 || needsYou > 0) {
    if (arrived > 0 && needsYou > 0) {
      return {
        tier: "sparse",
        text: `${arrived} new ${arrived === 1 ? "deal" : "deals"} landed — ${needsYou} still ${needsYou === 1 ? "needs" : "need"} you.`,
      };
    }
    if (arrived > 0) {
      return { tier: "sparse", text: `${arrived} new ${arrived === 1 ? "deal" : "deals"} landed — I've got the rest held.` };
    }
    return { tier: "sparse", text: `${needsYou} ${needsYou === 1 ? "ask is" : "asks are"} waiting on you — everything else is handled.` };
  }

  return { tier: "empty", text: "A quiet stretch so far — I'll keep watch." };
}

/** Convenience: derive + compose in one call (what BriefView uses). */
export function weekTeaser(
  deals:   DealItem[],
  actions: AgentActionRow[] | undefined | null,
  now:     number = Date.now(),
): WeekTeaser {
  return buildWeekTeaser(deriveTeaserInputs(deals, actions, now));
}
