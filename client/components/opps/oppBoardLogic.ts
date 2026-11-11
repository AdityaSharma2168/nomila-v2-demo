// Pure presentation rules for the opportunity board (PR 4). React-free so they are unit-tested.
import type { BoardItem, OpportunityBoard, PosterType } from "../../hooks/use-opportunity-board";
import { messagesLabel } from "../../lib/dealWords";

/**
 * The poster palette (owner, 7 Oct 2026): a brand with no CONFIRMED research gets its name on a colour field.
 * The colour comes from the opportunity TYPE — never a guessed brand colour, never her photo. Tokens, so the owner
 * can tweak them without touching a component. Blue is NOT used: it is reserved for overdue. One look (owner, 23 Oct
 * 2026): paid is ink, never green — no ring colour paints a poster (no brand colour is stored to use instead).
 */
export const POSTER_TOKENS: Record<PosterType, { from: string; mid: string; to: string; ink: string }> = {
  paid:    { from: "#2A2A2A", mid: "#181818", to: "#0E0E0E", ink: "#FFFFFF" },
  request: { from: "#5A5A57", mid: "#2E2E2C", to: "#0E0E0E", ink: "#FFFFFF" },
  product: { from: "#D9D2C5", mid: "#B9B0A1", to: "#8F877A", ink: "#1D1C1A" },
};

/** A photo card only for confirmed research WITH an image; everything else is a name poster. */
export function cardVisual(item: BoardItem): "photo" | "poster" {
  // The server sends image_url only when the brand's imagery is trusted (confirmed research, or its own site once settled).
  return item.brand.image_url ? "photo" : "poster";
}

/** The four qualifications, in her words (owner, 22 Oct 2026). Same categories underneath; wording only. */
const QUAL_CHIP: Record<string, string> = {
  needs_terms: "Needs terms", below_floor: "Below your minimum", workable: "Terms in", verify_first: "Verify first",
};

/** The qualification chip: "Meets your minimum" when terms are in and the offer is at or above her minimum. */
export function qualLabel(item: Pick<BoardItem, "qualification" | "read">): string | null {
  if (!item.qualification) return null;
  if (item.qualification === "workable" && item.read?.money?.state === "above_min") return "Meets your minimum";
  return QUAL_CHIP[item.qualification] ?? null;
}

/** Terms are in but she has no minimum to measure them by: a small "Set your minimum" link to Your rates. */
export function showSetMinimum(item: Pick<BoardItem, "qualification" | "read">): boolean {
  return item.qualification === "workable" && item.read?.money?.state === "no_min";
}

/** The kind chip: a request's own label (Interview · Podcast · …), else the qualification. */
export function kindChip(item: BoardItem): { text: string; dark: boolean } | null {
  if (item.kind_label) return { text: item.kind_label, dark: true };
  const q = qualLabel(item);
  return q ? { text: q, dark: false } : null;
}

/**
 * Whose move: a blue chip ONLY when overdue (her move, waiting more than 7 days). Not overdue → no chip: the card's line
 * already says "Waiting on you since …", and saying it twice is noise.
 */
/** Whole calendar days from `from` to `to` in the device's local time zone (midnight to midnight). Pure. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function moveChip(item: BoardItem, now: Date = new Date()): { text: string; overdue: boolean } | null {
  if (item.awaiting_response_from !== "athlete") return null;
  if (item.overdue && item.her_move_since) {
    // Calendar days on the athlete's own clock (the phone's time zone), so it agrees with the date shown elsewhere
    // ("Sent 13 Oct" on 23 Oct reads 10 days, not the 9 a 24-hour floor gave).
    const days = calendarDaysBetween(new Date(item.her_move_since), now);
    return { text: `Waiting ${days} days`, overdue: true };
  }
  return null;
}

/** The one action on the card, by kind and state. Requests are always answered: Reply. */
export function primaryAction(item: BoardItem): string {
  if (item.kind !== "deal") return "Reply";
  if (item.qualification === "verify_first") return "Verify";
  if (item.qualification === "workable" && !item.stage && item.channel !== "unverifiable") return "Accept or counter";
  switch (item.state) {
    case "needs_terms": return item.channel === "unverifiable" ? "Reply" : "Ask for terms";
    case "below_floor": return "Counter";
    default:            return "Reply";
  }
}

/**
 * The card's logo chip source: the brand's own logo once research is confirmed, else the logo from its evidence domain
 * (safe before research), plus that domain so LogoMark can step down to its favicon. Null → no chip (a name poster with
 * no domain keeps its monogram; Nomila never guesses a domain from a name).
 */
export function cardLogo(item: BoardItem): { logoUrl: string | null; domain: string | null } | null {
  if (item.brand.logo_none) return null;   // checked: no logo good enough — the initial, not a blurry favicon
  const logoUrl = (item.brand.research_confirmed ? item.brand.logo_url ?? item.brand.safe_logo_url : item.brand.safe_logo_url) ?? null;
  const domain = item.brand.domain ?? null;
  return logoUrl || domain ? { logoUrl, domain } : null;
}

/** The card's ONE action, inside the card: the server's next step, else (an older server) the rule above. */
export function cardAction(item: BoardItem): string {
  return item.next?.label ?? primaryAction(item);
}

/**
 * "What matters next" on Opportunities — the SAME heading, list and count Home shows (owner, 8 Oct 2026: Home said
 * "See all 11" while this said "5 of 12 open"). The count is the board's needsYou (Home's "See all N" reads the same
 * number from GET /me/what-matters-next); an older server without it counts the cards shown. Plain words only.
 */
export function whatMattersHead(board: Pick<OpportunityBoard, "whatMatters" | "counts">): { title: string; sub: string | null; count: number } {
  const count = board.counts.needsYou ?? board.whatMatters.length;
  const title = "What matters next";
  if (count === 0) return { title, sub: null, count };
  return { title, sub: count === 1 ? "1 waiting on you." : `${count} waiting on you, most pressing first.`, count };
}

/**
 * One primary per card, driven by the deal state: while "Looks signed — confirm?" is up, "Yes, it’s signed" is the
 * primary and the deal's own action (Reply…) steps down to secondary; once she dismisses the prompt, the action is
 * primary again.
 */
export function actionEmphasis(looksSigned: boolean, dismissed: boolean): "primary" | "secondary" {
  return looksSigned && !dismissed ? "secondary" : "primary";
}

/**
 * The caption under a card: the agency when there is one and the message count. No date: the card's own line ("Waiting
 * on you since Sep 25") and the blue "Waiting N days" chip already say when — the owner's 7 Oct pass removed the third
 * "since …" (DESIGN.md §12a: nothing is said twice).
 */
export function footLine(item: BoardItem): string {
  const parts: string[] = [];
  // The agency is named once, in its chip ("via X"); the foot only says so when there is no chip to say it.
  if (item.channel === "agency" && !item.via) parts.push("via an agency");
  if (item.message_count > 1) parts.push(messagesLabel(item.message_count));
  return parts.join(" · ");
}

/** The poster's oversized watermark letter — never for a person (owner, 7 Oct). */
export function monogramOf(item: BoardItem): string | null {
  if (item.brand.is_person) return null;
  const m = item.brand.name.trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : null;
}

/**
 * Where a "Why it's here" reason came from, in her words — or null when there is nothing meaningful to say. The server
 * sends plain labels ("from their email", "from the sender’s address", "from the dates", "from Nomila’s research");
 * an older server sent pipeline names ("qualification", "the classifier · channel", "timing"), which are mapped here so
 * an internal token never reaches the screen whichever side deploys first. Anything else that looks internal is omitted.
 */
const LEGACY_REASON_SOURCE: Record<string, string> = {
  "the classifier · kind": "from their email",
  "qualification": "from their email",
  "the classifier · channel": "from the sender’s address",
  "the classifier · sender domain": "from the sender’s address",
  "brand research (confirmed)": "from Nomila’s research",
  "timing": "from the dates",
};
const INTERNAL_SOURCE = /classifier|qualification|timing|enrichment|extract|pipeline|\bllm\b|\bmodel\b/i;

export function reasonSource(source: string | null | undefined): string | null {
  const s = source?.trim();
  if (!s) return null;
  const mapped = LEGACY_REASON_SOURCE[s];
  if (mapped) return mapped;
  return INTERNAL_SOURCE.test(s) ? null : s;
}
