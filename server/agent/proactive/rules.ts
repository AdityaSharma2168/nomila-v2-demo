/**
 * agent/proactive/rules.ts — THE one table that decides how loud each app event is (design "Mila on watch", 27 Oct 2026,
 * "How Mila decides what to interrupt for"). Adding a kind of event is one row here plus one emit call at its source;
 * tuning is editing a row, never the sources. Owner-approved defaults (27 Oct 2026), easy to change:
 *
 *   speak_now  Mila writes a message now (a server-run turn in its own session), it lands in the athlete's chat unread,
 *              and one notification goes out (unless `push` is false, the cap is reached, or the athlete is in the app)
 *   reminder   no model call: the event's own fixed-copy notification, once (its dedupe key), never repeated
 *   brief      nothing now: held for the next chat (engine/events.ts queues what Mila hears there) or the later morning
 *              brief (not built in phase 1)
 *   silent     recorded, nothing else
 *
 * Code checks before anything is sent (CowAgent executor.py: notify only after a real change, MIT): `check` says what a
 * speak_now message must carry to count — "card" (a card from the turn: a drafted reply, an accept/decline …) or a read
 * of the event's own subject (`subjectTool`, e.g. deals_get on that deal); "text" (the event is itself the news: a
 * payment, a connect), any words that are not SILENT.
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import type { PushPreferencesView } from "../../services/push/push";

export type ProactiveOutcome = "speak_now" | "reminder" | "brief" | "silent";

/** Where a speak_now message goes: the deal's or booking's own conversation, or that day's conversation. */
export type Placement = "deal" | "booking" | "day";

/** The per-type switch in Settings a Mila notification for this event obeys (the athlete's existing choices). */
export type PushPref = keyof Pick<PushPreferencesView, "brandReply" | "waiting" | "milaSuggestion" | "planReady">;

export interface ProactiveRule {
  outcome: ProactiveOutcome;
  /** speak_now: where the message goes. */
  placement?: Placement;
  /** speak_now: whether the phone is told (false: the message waits in the chat, unread, e.g. they are in the app). */
  push?: boolean;
  /** speak_now: the athlete's switch that must be on for the notification. */
  pref?: PushPref;
  /** speak_now: what the message must carry to be sent (see the header). */
  check?: "card" | "text";
  /** check "card": a read of the event's subject also counts (tool name, and the arg holding the subject id). */
  subjectTool?: { name: string; arg: string };
  /** speak_now: no second Mila message about the same subject within this window (a burst of replies is one message). */
  coalesceMs?: number;
  /** The lock-screen words when the athlete has not turned "Show brand names in notifications" on: fixed copy. */
  pushBody?: string;
  /**
   * An important business event or something the athlete asked for (owner rule, 28 Oct 2026): never held back by
   * pacing or fatigue (the daily Mila notification cap). Their own switches and quiet hours still apply.
   */
  important?: boolean;
}

const HOUR = 3_600_000;

export const ATHLETE_EVENT_KINDS = [
  "deal_new", "brand_reply", "booking_request", "payment_received", "account_connected", "score_band_moved", "video_ready", "post_published",
  "draft_waiting", "item_expiring",
  "research_done", "deal_archived", "payout_setup_needed",
  "event_passed",
] as const;
export type AthleteEventKind = (typeof ATHLETE_EVENT_KINDS)[number];
export const isAthleteEventKind = (x: unknown): x is AthleteEventKind => typeof x === "string" && (ATHLETE_EVENT_KINDS as readonly string[]).includes(x);

export const PROACTIVE_RULES: Record<AthleteEventKind, ProactiveRule> = {
  // ── speak now ──
  deal_new:          { outcome: "speak_now", placement: "deal", push: true, pref: "brandReply", check: "card", subjectTool: { name: "deals_get", arg: "deal_id" }, pushBody: "Mila looked at a new deal email for you.", important: true },
  brand_reply:       { outcome: "speak_now", placement: "deal", push: true, pref: "brandReply", check: "card", subjectTool: { name: "deals_get", arg: "deal_id" }, coalesceMs: 3 * HOUR, pushBody: "A brand replied. Mila has the next step ready.", important: true },
  booking_request:   { outcome: "speak_now", placement: "booking", push: true, pref: "waiting", check: "card", subjectTool: { name: "bookings_get", arg: "booking_id" }, pushBody: "Someone asked to book you. Mila has it ready for your answer.", important: true },
  payment_received:  { outcome: "speak_now", placement: "day", push: true, pref: "brandReply", check: "text", pushBody: "You got paid. Mila has the details.", important: true },
  // They are in the app when they connect: the message shows in the chat, the phone stays quiet.
  account_connected: { outcome: "speak_now", placement: "day", push: false, check: "text" },
  score_band_moved:  { outcome: "speak_now", placement: "day", push: true, pref: "milaSuggestion", check: "text", pushBody: "Your score moved. Mila can tell you what changed." },
  // Something they asked for (a video they ordered, a post they published): important too.
  video_ready:       { outcome: "speak_now", placement: "day", push: true, pref: "planReady", check: "card", pushBody: "Your video is ready to look at.", important: true },
  post_published:    { outcome: "speak_now", placement: "day", push: true, pref: "planReady", check: "text", pushBody: "Your post is live.", important: true },
  // ── reminder (fixed copy, once) ──
  draft_waiting:     { outcome: "reminder" },
  item_expiring:     { outcome: "reminder" },
  // ── brief only / next chat ──
  research_done:       { outcome: "brief" },
  deal_archived:       { outcome: "brief" },
  payout_setup_needed: { outcome: "brief" },
  // A game they play in just passed (agent/events/games.ts). Mila decides: often SILENT; a message only with a card
  // (the typed "final score" question, or another proposal) — never text alone. Their Mila-suggestion switch applies.
  event_passed:        { outcome: "speak_now", placement: "day", push: true, pref: "milaSuggestion", check: "card", pushBody: "Mila has a question about your event." },
};

/** The limits around the rules (owner defaults, 27 Oct 2026). */
export const PROACTIVE_LIMITS = {
  /**
   * At most this many Mila-started notifications per athlete in any 24 hours (the overall push cap of 8 still applies).
   * Rules marked `important` are exempt (owner rule, 28 Oct 2026); they still count towards it.
   */
  dailyMilaPushCap: 5,
  /** A Mila-started message whose words match one already in their chats this recently is not sent again. */
  duplicateWindowMs: 7 * 24 * HOUR,
  /** The athlete counts as in the app when they wrote to Mila or saw a Mila message this recently: no buzz. */
  activeHoldMs: 3 * 60_000,
  /** At most this many of Mila's own started messages are remembered in one conversation's session (CowAgent). */
  rememberedPerConversation: 3,
  /** The longest a Mila-started message may be (characters); a longer reply is clipped at a sentence. */
  maxMessageChars: 1200,
} as const;
