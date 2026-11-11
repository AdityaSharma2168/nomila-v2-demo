/**
 * opportunityNext.ts — what an opportunity needs from her NEXT, decided once from the deal's own state and read by every
 * surface: the board's cards (the in-card action), the detail's letter, the brand page's sections and Home's "What matters
 * next" rows (owner, 8 Oct 2026: "one row model"). Pure; no I/O.
 *
 *   action  the ONE thing to do, from the deal state, in this order:
 *             looks signed (paperwork / a signed PDF / the summariser reads it signed, and she hasn't said) → confirm it
 *             verify first (an unverifiable sender claiming a known brand)                                → check who they are
 *             under way and their move is hers                                                            → reply
 *             an interview / school request                                                               → reply
 *             no fee named (and the sender is verifiable)                                                 → ask for terms
 *             a cash offer under her minimum                                                              → counter
 *             anything else                                                                               → reply
 *   why     the reason in the deal's OWN data: the signing evidence, what's new, their ask, the qualification as she reads
 *           it — and, when none of those exists, the deal's "What's next" line (takeFor). Never a template keyed on a brand.
 *   due     a deadline the classifier read from their email (YYYY-MM-DD) that is still ahead.
 *   hers    the move is hers: it looks signed, they wrote last, or it is a new opportunity she hasn't answered.
 *
 * The words are fixed per ACTION (an enum), never per brand, sport or person.
 */
import type { BoardItem } from "../services/opportunityBoard";

export type PrimaryAction = "ask_for_terms" | "accept_or_counter" | "counter" | "reply" | "decline";
export type NextAction = "confirm_signed" | "verify" | PrimaryAction;

export interface NextStep {
  action: NextAction;
  /** The button / the row's verb phrase: "Confirm it’s signed", "Ask for terms", "Reply"… */
  label: string;
  /** Why, from the deal's own data. Never empty: the deal's "What's next" line is the floor. */
  why: string;
  /** A deadline still ahead (YYYY-MM-DD), else null. */
  due: string | null;
  /** Her move. */
  hers: boolean;
}

export const NEXT_LABEL: Record<NextAction, string> = {
  confirm_signed: "Confirm it’s signed",
  verify:         "Check who they are",
  ask_for_terms:  "Ask for terms",
  accept_or_counter: "Accept or counter",
  counter:        "Counter",
  reply:          "Reply",
  decline:        "Decline",
};

type ItemFacts = Pick<BoardItem, "stage" | "qualification" | "kind" | "channel" | "state">;

/** Nomila's take — the deal's "What's next" line: one or two sentences of judgement, never a recap (owner, 7 Oct). */
export function takeFor(item: ItemFacts, opts: { looksSigned: boolean }): string {
  if (opts.looksSigned) return "If it’s signed, confirm it and Nomila marks it Signed. If it isn’t, nothing changes.";
  if (item.stage === "Signed") return "Signed. Keep the deliverables on schedule; anything new from them is a new deal.";
  if (item.qualification === "verify_first") return "Don’t engage on terms. Ask who they are, or decline.";
  if (item.stage) {
    return item.stage === "Agreed" || item.stage === "Completed"
      ? "The deal is running. Settle anything new before any number."
      : "Keep it moving: answer what they asked, and hold your number until the scope is clear.";
  }
  if (item.kind === "school") return "Answer what your school needs. It isn’t a paid offer.";
  if (item.kind === "interview") return "Worth a short reply to learn where it runs and who sees it before you agree to anything.";
  if (item.channel === "unverifiable") return "Find out who they are before anything else.";
  switch (item.state) {
    case "needs_terms": return "Ask what they need before any number.";
    case "below_floor": return "Worth one counter at your rate. If they can’t move, decline and keep the door open.";
    // Product only or commission only (one state, owner 23 Oct 2026): no cash either way, so one take fits both.
    case "product":     return "No cash on the table. Take it only if it’s a brand you’d post for anyway.";
    case "cash":        return "The terms are on the table. Check usage and exclusivity before you say yes.";
    default:            return "Read what they sent, then decide whether it’s worth a reply.";
  }
}

/** ONE primary action; secondaries are subordinate. Verify first: Decline primary, Verify secondary. */
export function actionsFor(item: ItemFacts): { primary: { action: PrimaryAction; label: string }; secondary: Array<{ action: "decline" | "verify"; label: string }> } {
  if (item.qualification === "verify_first") {
    return { primary: { action: "decline", label: "Decline" }, secondary: [{ action: "verify", label: "Ask who they are" }] };
  }
  const decline = { action: "decline" as const, label: "Decline" };
  // Under way: Reply. (There is no second deal screen to open — the brand page holds the paperwork and the thread.)
  if (item.stage) return { primary: { action: "reply", label: "Reply" }, secondary: [] };
  if (item.kind !== "deal") return { primary: { action: "reply", label: "Reply" }, secondary: [decline] };
  if (item.state === "needs_terms" && item.channel !== "unverifiable") return { primary: { action: "ask_for_terms", label: "Ask for terms" }, secondary: [decline] };
  if (item.state === "below_floor") return { primary: { action: "counter", label: "Counter" }, secondary: [decline] };
  // Terms are in (owner, 22 Oct): one button that opens the reply on accept, with counter beside it in the sheet.
  // Never "accept" from a sender we could not verify: they get a Reply.
  if (item.qualification === "workable" && item.channel !== "unverifiable") return { primary: { action: "accept_or_counter", label: "Accept or counter" }, secondary: [decline] };
  return { primary: { action: "reply", label: "Reply" }, secondary: [decline] };
}

/** Why "Looks signed" shows, in plain words, from the evidence KINDS (never email text). */
export function signedWhy(kinds: Iterable<string>): string {
  const k = new Set(kinds);
  if (k.has("paperwork") || k.has("legacy_esign")) return "An e-signature email says every party has signed.";
  if (k.has("attachment")) return "A signed copy of the agreement arrived by email.";
  return "The conversation reads like a signed agreement.";
}

const sentence = (s: string): string => {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return t;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
};

/** A YYYY-MM-DD (or ISO) date still ahead of `now` (same day counts), normalised to YYYY-MM-DD; else null. */
export function dueAhead(raw: unknown, now: Date): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  const day = new Date(t).toISOString().slice(0, 10);
  return day >= now.toISOString().slice(0, 10) ? day : null;
}

export interface NextFacts extends ItemFacts {
  inMotion: boolean;
  awaiting: string | null;
  looksSigned: boolean;
  signedEvidenceKinds: string[];
  whatsNew: string | null;
  ask: string | null;
  /** The qualification as she reads it (dealQualification.plainQualificationReason). */
  reason: string | null;
  deadline: unknown;
}

/** The one next step for an opportunity. Pure. */
export function nextStepFor(f: NextFacts, now: Date): NextStep {
  const due = dueAhead(f.deadline, now);
  const take = takeFor(f, { looksSigned: f.looksSigned });
  const ask = f.ask?.trim() ? `Their ask: ${sentence(f.ask)}` : null;
  const notFiled = f.qualification !== "verify_first" && f.qualification !== "not_relevant";
  const fresh = !f.inMotion && f.state !== "unqualified" && f.awaiting !== "brand";
  const hers = notFiled && (f.looksSigned || f.awaiting === "athlete" || fresh);

  let action: NextAction;
  let why: string | null;
  if (f.looksSigned) {
    action = "confirm_signed";
    why = signedWhy(f.signedEvidenceKinds);
  } else if (f.qualification === "verify_first") {
    action = "verify";
    why = f.reason;
  } else if (f.inMotion) {
    action = "reply";
    why = f.whatsNew ? sentence(f.whatsNew) : ask;
  } else {
    action = actionsFor(f).primary.action;
    why = action === "ask_for_terms" || f.kind !== "deal" ? ask ?? f.reason : f.reason ?? ask;
  }
  return { action, label: NEXT_LABEL[action], why: why?.trim() ? why.trim() : take, due, hers };
}
