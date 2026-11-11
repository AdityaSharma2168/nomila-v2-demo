/**
 * agent/proactive/turn.ts — the Mila turn the server runs for a speak-now event (design "Mila on watch", step 3).
 *
 *   input    the event as app updates in our own words (PROACTIVE_LINES, below), no athlete text (the onboarding's
 *            message:null turn, onboarding/milaTurn.ts), the chat's usual CONTEXT, and the definition's proactive part
 *            (mila/proactive.md) as the preface
 *   session  a SEPARATE, fresh session (runMilaTurn `isolated`): never the athlete's live conversation, so a turn they
 *            have running is never disturbed, and its tool calls never clutter their chat
 *   decision the turn ends with one JSON block: SPEAK | SILENT | DEFER, reason, message, cards, evidence (decision.ts).
 *            A third update line lists the refs a SPEAK may cite for this event (refsLine).
 *   checks   code decides whether anything is sent (CowAgent executor.py, MIT: notify only after a real change) and
 *            fails CLOSED: nothing when the decision is SILENT, missing, malformed or ungrounded, or the turn is empty,
 *            stopped or failed; for a "card" rule nothing unless the turn left a card (a drafted reply, an
 *            accept/decline …) or read the event's own subject. DEFER is the dispatcher's (one re-check per event).
 *
 * The turn itself sends nothing anywhere: every outbound step is a card the athlete taps (tap-to-send).
 * Prompt Register entry 79: PROACTIVE_LEAD, PROACTIVE_LINES and refsLine, exact text here; mila/proactive.md.
 */
import { sinkStream } from "../onboarding/milaTurn";
import { CONNECTORS } from "../onboarding/catalog";
import { readProactive } from "../mila/load";
import type { MilaTurnDeps, TurnResult } from "../engine/turnTypes";
import { runMilaTurn } from "../engine";
import type { AthleteEventPayload } from "./events";
import { checkDecision, eventRefs, type TurnOutcome, type Verdict } from "./decision";
import { PROACTIVE_LIMITS, PROACTIVE_RULES, type AthleteEventKind, type ProactiveRule } from "./rules";

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quoted = (label: string | null | undefined, fallback: string) => (label && oneLine(label) ? `"${clip(oneLine(label), 80)}"` : fallback);
const id = (x: unknown) => clip(oneLine(x), 80);
const money = (cents: unknown, currency: unknown) =>
  typeof cents === "number" && Number.isFinite(cents) ? ` of ${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${oneLine(currency || "USD").toUpperCase().slice(0, 3)}` : "";

/** The first update line: what kind of turn this is. Prompt Register entry pending (draft). */
export const PROACTIVE_LEAD = "Nomila started this turn because of the update below; the athlete has not written. Only the message in your decision is added to their chat, unread, and may be the notification they see.";

/** One line per event kind, in our own words. Prompt Register entry pending (draft). */
export const PROACTIVE_LINES: Record<AthleteEventKind, (p: AthleteEventPayload) => string> = {
  deal_new: (p) => `A new deal email arrived from ${quoted(p.label, "a brand")} (deal_id ${id(p.dealId)}). Read it with deals_get, then say what they are asking and the one next move you recommend; if a reply is the move, draft it so it shows as a card.${p.facts?.suspectedScam === true ? " Nomila's checks found scam signals in it: do not engage; warn them or stay silent." : ""}`,
  brand_reply: (p) => `${quoted(p.label, "A brand")} replied on their deal (deal_id ${id(p.dealId)}). Read it with deals_get before you say what it says; then the one next move, with a drafted answer as a card if one is needed.`,
  booking_request: (p) => `A new booking request arrived (booking_id ${id(p.bookingId)}). Read it with bookings_get, then say what was asked and prepare their answer (accept, decline or suggest a time) as a card.`,
  payment_received: (p) => `A payment${money(p.facts?.amountCents, p.facts?.currency)} was filed on their deal with ${quoted(p.label, "a brand")}. Tell them in one or two sentences; nothing needs their tap unless their record shows otherwise.`,
  account_connected: (p) => {
    const platform = String(p.facts?.platform ?? "");
    const service = CONNECTORS.find((c) => c.id === platform)?.service ?? (clip(oneLine(platform), 40) || "an account");
    return `The athlete ${p.facts?.reconnected ? "reconnected" : "connected"} ${service}. Nomila is reading it now, which can take a few minutes. Say what this lets you do for them next, in a line or two.`;
  },
  score_band_moved: (p) => `Their M.I.A. score moved from the ${quoted(String(p.facts?.from ?? ""), "earlier")} band to the ${quoted(String(p.facts?.to ?? ""), "new")} band. Look it up with read_scouting before you say what changed.`,
  video_ready: (p) => `A video they asked for is ready (${id(p.facts?.itemId ?? "no id")}). Say it is ready and what to do next; publishing is their tap.`,
  post_published: (p) => `Their post went live (${id(p.facts?.itemId ?? "no id")}). Say so in a line; add a next step only if their record supports one.`,
  // Not speak-now in the table today; a line each so a rule change needs no code here.
  draft_waiting: () => "A reply draft has been waiting on their tap for a while. Remind them once, briefly.",
  item_expiring: () => "Something waiting on their tap expires within a day. Remind them once, briefly.",
  research_done: (p) => `Research on them finished${typeof p.facts?.newFacts === "number" ? ` with ${p.facts.newFacts} new facts` : ""}. Look them up with recall_facts before you use them.`,
  deal_archived: (p) => `Their deal with ${quoted(p.label, "a brand")} went quiet and was archived (deal_id ${id(p.dealId)}). They can bring it back.`,
  payout_setup_needed: () => "Their payouts are not set up yet, so money can't reach them. Point them to setting it up.",
  event_passed: (p) => {
    const kind = p.facts?.kind === "game" ? "game" : "event";
    const what = p.label && oneLine(p.label) ? `Their ${kind} ${quoted(p.label, "")}` : `Their ${kind}`;
    return `${what} on ${id(p.facts?.date ?? "a recent day")} has passed (fact ${id(p.facts?.factId ?? "")}). Decide whether anything is worth doing for them now. If a post about how it went would help them, ask how it went with ask_once, with a typed answer for the result (a score, a time or a place; typed.event_fact set to that fact); never guess a result. If nothing is worth it, stay silent.`;
  },
};

let _preface: string | null = null;
/** The definition's proactive part (mila/proactive.md, comments out). */
export function proactivePreface(): string {
  return (_preface ??= readProactive());
}

// ─── the checks ────────────────────────────────────────────────────────────────────────────────────────────────────

export { clipAtSentence, type Verdict } from "./decision";

/** Code's decision on a finished turn (decision.ts checkDecision): fails closed on anything missing or ungrounded. */
export function verdictOf(ev: { kind: string; payload: AthleteEventPayload }, rule: ProactiveRule, r: TurnOutcome): Verdict {
  return checkDecision(ev, rule, r, PROACTIVE_LIMITS.maxMessageChars);
}

/** The third update line: the refs a SPEAK may cite for this event (decision.ts eventRefs). Prompt Register entry 79. */
export function refsLine(kind: string, payload: AthleteEventPayload, rule: Pick<ProactiveRule, "check">): string {
  const refs = eventRefs(kind, payload, rule);
  return refs.length
    ? `Evidence refs for this update: ${refs.join(", ")}.`
    : "This update carries no ref of its own: a SPEAK must cite a fact:<id> you read this turn.";
}

// ─── the turn ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProactiveTurnResult { run: TurnResult; verdict: Verdict }

/** Tests pass a fake runTurn (never a model). */
export interface ProactiveTurnDeps extends MilaTurnDeps { runTurn?: typeof runMilaTurn }

export async function runProactiveTurn(
  ev: { athleteId: string; kind: AthleteEventKind; payload: AthleteEventPayload; conversationId: string },
  deps: ProactiveTurnDeps = {},
): Promise<ProactiveTurnResult> {
  const rule = PROACTIVE_RULES[ev.kind];
  const run = await (deps.runTurn ?? runMilaTurn)(
    { athleteId: ev.athleteId, message: null, conversationId: ev.conversationId, sse: sinkStream() },
    deps,
    { trigger: "event", isolated: true, updates: [PROACTIVE_LEAD, PROACTIVE_LINES[ev.kind](ev.payload), refsLine(ev.kind, ev.payload, rule)], preface: () => [proactivePreface()] },
  );
  return { run, verdict: verdictOf(ev, rule, run) };
}
