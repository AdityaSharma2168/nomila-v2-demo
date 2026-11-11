// The deal letter's rules (deals design §5, §5b, §7: the Harrison Szep detail, before → after). React-free, unit-tested.
//
//   readRows(read, item)       the four-line read: Money · Fit · Risk · Goal, each with its plain source. It replaces
//                              "Why it's here" and "Nomila's take". Fit waits when the brand isn't confirmed; Goal says
//                              so when nothing matches — never a blank line.
//   letterActions(item, next)  the actions of the deal's TYPE (shared/deals INTENTS_BY_TYPE, served on the item): one
//                              primary, at most one outlined secondary (Counter), then links: one more ask, "Not for me",
//                              and Ask Mila's slot. "Decline" is never a reply chip here: saying no is the Not-for-me sheet.
//   closedLine(closed)         a closed deal's one line ("Declined · 12 Oct 2026"), shown instead of any action.
import {
  ACCEPT_INTENTS, REPLY_INTENT_LABEL,
  type DealRead, type ReplyIntent,
} from "../../../shared/deals";
import type { BoardItem, NextAction } from "../../hooks/use-opportunity-board";

export interface ReadRow {
  key: "money" | "fit" | "risk" | "goal";
  label: string;
  line: string;
  source: string;
  /** Risk with a flag set: the one row that may carry the blue "needs you" emphasis. */
  flagged: boolean;
}

const FIT_WAITS = "Can’t judge yet: Nomila hasn’t confirmed this brand.";
const FIT_WAITS_PERSON = "Can’t judge yet: a person, not a confirmed brand.";

/** The four rows, in the design's order. Pure. */
export function readRows(read: DealRead, item: Pick<BoardItem, "brand">): ReadRow[] {
  return [
    { key: "money", label: "Money", line: read.money.line, source: read.money.source, flagged: false },
    read.fit
      ? { key: "fit", label: "Fit", line: read.fit.line, source: read.fit.source, flagged: false }
      : {
          key: "fit", label: "Fit",
          line: item.brand.is_person ? FIT_WAITS_PERSON : FIT_WAITS,
          source: item.brand.is_person ? "Nomila’s research · no brand found" : "Nomila’s research · not confirmed",
          flagged: false,
        },
    { key: "risk", label: "Risk", line: read.risk.line, source: read.risk.source, flagged: read.risk.flags.length > 0 },
    read.goal
      ? { key: "goal", label: "Goal", line: read.goal.line, source: read.goal.source, flagged: false }
      : { key: "goal", label: "Goal", line: "Doesn’t connect to a goal you’ve set", source: "Your goals", flagged: false },
  ];
}

export interface LetterAction { intent: ReplyIntent; label: string }

export interface LetterActions {
  /** The ONE black button. Null when the type offers nothing to reply (paperwork). */
  primary: LetterAction | null;
  /** The outlined button under it (Counter on a paid deal), or null. */
  secondary: LetterAction | null;
  /** One more reply as a text link ("Ask questions first"). */
  link: LetterAction | null;
  /** "Not for me" — her way to say no (the Not-for-me sheet). False when the type has no decline. */
  notForMe: boolean;
}

/** The type's intents, from the item (server) — an older server sends none. */
function offered(item: Pick<BoardItem, "actions">): LetterAction[] {
  return (item.actions ?? []).filter((a) => !!a && typeof a.intent === "string");
}

/** The intent the server's next step points at, among the ones this type offers. */
function intentForNext(next: NextAction | undefined, acts: LetterAction[]): LetterAction | null {
  const has = (i: ReplyIntent) => acts.find((a) => a.intent === i) ?? null;
  switch (next) {
    case "counter":       return has("counter");
    // Terms are in: the sheet opens on accepting them; counter sits beside it in the same sheet.
    case "accept_or_counter": return acts.find((a) => ACCEPT_INTENTS.includes(a.intent)) ?? has("counter");
    case "ask_for_terms": return acts.find((a) => a.intent.startsWith("ask_")) ?? null;
    case "verify":        return has("ask_who_they_are");
    default:              return null;
  }
}

/**
 * The letter's actions for one deal. Pure.
 *
 *   · a type that can be countered (paid, appearance, ambassador, licensing…): primary "Reply" (it opens the sheet on
 *     the type's first answer, switchable), secondary "Counter" — unless the server's next step IS the counter, then
 *     Counter leads and Reply steps down;
 *   · any other type: primary = the step the server points at, else the type's first answer ("Accept and suggest
 *     times"); the link = the next answer that isn't the primary ("Ask questions first");
 *   · "Decline" never shows as a reply here: "Not for me" closes it, with an optional polite no.
 */
export function letterActions(item: Pick<BoardItem, "actions" | "next">): LetterActions {
  const acts = offered(item);
  const notForMe = acts.some((a) => a.intent === "decline");
  const answers = acts.filter((a) => a.intent !== "decline");
  if (!answers.length) return { primary: null, secondary: null, link: null, notForMe };

  const counter = answers.find((a) => a.intent === "counter") ?? null;
  const pointed = intentForNext(item.next?.action, answers);

  if (item.next?.action === "accept_or_counter" && pointed) {
    return { primary: { intent: pointed.intent, label: "Accept or counter" }, secondary: null, link: null, notForMe };
  }

  if (counter) {
    const reply = answers.find((a) => a.intent !== "counter") ?? null;
    const replyAction: LetterAction | null = reply ? { intent: reply.intent, label: "Reply" } : null;
    if (pointed?.intent === "counter" || !replyAction) {
      return { primary: counter, secondary: replyAction, link: null, notForMe };
    }
    return { primary: replyAction, secondary: counter, link: null, notForMe };
  }

  const primary = pointed ?? answers[0];
  const link = answers.find((a) => a.intent !== primary.intent) ?? null;
  return { primary, secondary: null, link, notForMe };
}

/**
 * The intent the board card's ONE button opens the reply sheet on, or null when that button is not a reply (confirm
 * signed, verify, decline) or the type offers nothing to reply — then the card opens the detail as before. The server's
 * next step picks it among the type's answers; else the letter's own primary. Pure.
 */
export function cardReplyIntent(item: Pick<BoardItem, "actions" | "next" | "lead_deal_id">): ReplyIntent | null {
  if (!item.lead_deal_id) return null;
  const step = item.next?.action;
  if (step !== "reply" && step !== "counter" && step !== "ask_for_terms" && step !== "accept_or_counter") return null;
  const answers = offered(item).filter((a) => a.intent !== "decline");
  return intentForNext(step, answers)?.intent ?? letterActions(item).primary?.intent ?? null;
}

/** The label a reply intent shows (the server's label first, the shared one as the fallback). */
export function intentLabel(intent: ReplyIntent, item?: Pick<BoardItem, "actions">): string {
  return item?.actions?.find((a) => a.intent === intent)?.label ?? REPLY_INTENT_LABEL[intent] ?? intent;
}

export function isAcceptIntent(intent: ReplyIntent): boolean {
  return ACCEPT_INTENTS.includes(intent);
}

const CLOSE_WORD: Record<string, string> = { won: "Done", declined: "Declined", expired: "Expired", not_relevant: "Not a deal" };

const fmtDay = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** "Declined · Oct 12, 2026" — a closed deal's one line, in place of any action. Pure. */
export function closedLine(closed: { reason: string | null; at: string | null } | null | undefined): string {
  const word = CLOSE_WORD[closed?.reason ?? ""] ?? "Closed";
  const day = fmtDay(closed?.at);
  return day ? `${word} · ${day}` : word;
}
