/**
 * voice/oneMila/confirm.ts — the athlete's spoken "send it", for ORDINARY replies only (owner, 9 Nov 2026; Q4 10 Nov
 * 2026; security review of #1251, 10 Nov 2026). The SERVER decides whether a spoken yes counts, from the pending row
 * and the call's own record; the model's words never do.
 *
 * Two voice-only tools (not registry tools: the policy queues every act-level registry call for a tap, which is the
 * point of the registry; this is the one deliberate exception, and it lives here, narrow):
 *
 *   read_back({ pending_id })        the exact reply Mila is about to read out: the address the send would go to, the
 *                                    subject, the body, and whether a spoken yes can send it. Recorded (call key, the
 *                                    body's hash, the turn, the DB time) on the conversation's session row.
 *   confirm_by_voice({ pending_id }) sends it, through the ONE send path (services/sendReplyApproval.ts, the same
 *                                    checks and at-most-once claim as her tap; receipt mode "voice" with the call, the
 *                                    turn and the transcript row), only when ALL of:
 *     0. voice sending is on for the athlete (the welcome capability voice_send: ON by default, owner 10 Nov 2026,
 *        until they turn it off in Me or Settings): off ⇒ "tap Send on the card". While MILA_WELCOME is off there is
 *        no switch for them to turn it off with, so nothing is sent by voice at all (welcome_off);
 *     1. the row is hers, a send_reply, still pending and unexpired;
 *     2. it is an ordinary reply (classifyForVoice below): Mila drafted it (deals_draft_reply), its intent is one of
 *        ORDINARY_REPLY_INTENTS, it is not an ask-terms batch row, it carries no attachment, and its body holds no
 *        digit at all and none of the money words (fails closed: a date or a count also needs the tap);
 *     3. it was drafted in THIS call (the proxy recorded the draft card's pending id under the call key);
 *     4. it was read back in this call, in an EARLIER turn, and the body is still exactly the one read back;
 *     5. the athlete's own transcript turn is on record for THIS confirm's turn (a different, later turn than the
 *        read-back's): a user voice row of this conversation, written through the grant-bound transcript route with
 *        this call's turn id, created after the read-back. A late transcript of the turn that asked for the draft can
 *        never stand in for the yes (it carries the read-back's turn id, or an earlier one).
 *   Anything else: "needs_tap" with a plain reason, and nothing is sent.
 *
 * What this does NOT prove (residual trust, said plainly): the transcript is the worker's transcription. A worker
 * holding the service secret and a live grant can still write a user turn saying "yes", and the microphone can pick up
 * Mila's own voice or someone else in the room. The rules above stop the model, a stale turn and another call from
 * standing in for her; they do not authenticate her voice. That is why the class of replies is so narrow, why she can
 * turn voice sending off, and why the receipt names the transcript row it relied on.
 *
 * Never by voice, whatever is said (always the real tap): money (a fee, a counter, a rate, any number in the body, any
 * money tool or payment), a yes to an offer (accept_gift, accept_to_try, accept_and_propose_times,
 * accept_and_confirm_logistics: owner Q4), marking a deal signed or completed, public posts and shares
 * (documents_share), capability turn-ons, bookings, and every agent_action card (anything the policy queued). A polite
 * no (decline) and asking for terms or paperwork (ask_term_sheet, ask_licensing_terms, acknowledge) may go by voice
 * (owner, 10 Nov 2026), still under the fail-closed money check.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { inboxMessages, pendingActions } from "../../../shared/schema";
import { REPLY_INTENT_LABEL, isReplyIntent, type ReplyIntent } from "../../../shared/deals";
import { bodySha256 } from "../../../shared/bodyHash";
import { external } from "../../lib/externalContent";
import { createLogger } from "../../logger";
import { approveSendReply, ASK_TERMS_SOURCE, type PendingRow } from "../../services/sendReplyApproval";
import { resolveReplyEnvelope } from "../../services/replyEnvelope";
import { isAllowed } from "../../agent/welcome/choices";
import { milaWelcomeEnabled } from "../../agent/welcome/config";
import type { MilaSessionRow } from "../../agent/engine/sessions";
import { heardYes, readVoiceConfirm, recordReadBack } from "./state";

const logger = createLogger("voice/oneMila/confirm");

/** The welcome capability a spoken send needs (agent/welcome/registry.ts). */
export const VOICE_SEND_CAPABILITY = "voice_send";

/** What a reply intent is, for a spoken yes. Exhaustive: a new intent does not typecheck until it is classed here. */
export type VoiceReplyClass = "ordinary" | "money" | "agreement";
export const REPLY_INTENT_CLASS: Readonly<Record<ReplyIntent, VoiceReplyClass>> = {
  ask_question: "ordinary",
  ask_terms: "ordinary",
  ask_expectations: "ordinary",
  ask_questions: "ordinary",
  ask_questions_in_advance: "ordinary",
  redirect_to_pr: "ordinary",
  ask_details: "ordinary",
  ask_who_they_are: "ordinary",
  // Owner, 10 Nov 2026: a polite no and asking for terms or paperwork may go by voice (the money check still applies).
  decline: "ordinary",
  ask_term_sheet: "ordinary",
  ask_licensing_terms: "ordinary",
  acknowledge: "ordinary",
  // Money: a figure, a rate, a fee or a commission (shared/deals.ts FIGURE_INTENTS and the paid yeses).
  counter: "money",
  share_rate: "money",
  propose_paid: "money",
  accept_terms: "money",
  accept_affiliate: "money",
  ask_fee_plus_commission: "money",
  // A yes to an offer moves the deal to Agreed (D4): a tap, even with no money in it (owner Q4, 10 Nov 2026).
  accept_gift: "agreement",
  accept_to_try: "agreement",
  accept_and_propose_times: "agreement",
  accept_and_confirm_logistics: "agreement",
};
export const ORDINARY_REPLY_INTENTS: readonly ReplyIntent[] = (Object.keys(REPLY_INTENT_CLASS) as ReplyIntent[]).filter((i) => REPLY_INTENT_CLASS[i] === "ordinary");

/**
 * Fails closed: ANY digit, a currency sign or code, a percentage, or a money word (fee, rate, pay, budget, commission,
 * compensation, grand, k, per post …) or a spelled-out number (two … ninety, hundred, thousand, million …). A reply
 * with a date or a count in it therefore needs the tap too; that is the price of never letting an amount through.
 * "one" alone is left out (it is not an amount on its own; "one hundred" is caught by "hundred").
 */
const MONEY_IN_BODY = new RegExp([
  String.raw`\d`, String.raw`[$€£¥₹₩₦¢%]`,
  String.raw`\b(usd|eur|gbp|cad|aud|nzd|inr|jpy|chf)\b`,
  String.raw`\b(dollars?|bucks|euros?|pounds?|quid|cents?|pence)\b`,
  String.raw`\b(fees?|rates?|paid|pay|pays|paying|payment|payments|payout|budget|budgets|commission|commissions|compensation|compensate|stipend|honorarium|retainer|invoice|price|pricing|cost|costs|cash|money|grand|per\s*cent|percent|percentage)\b`,
  String.raw`\bper\s+(post|reel|story|video|deliverable|month|hour|appearance)\b`,
  String.raw`\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)\b`,
].join("|"), "i");
export const bodyNamesMoney = (body: string): boolean => MONEY_IN_BODY.test(body);

export type VoiceConfirmRefusal =
  | "not_a_reply" | "tap_only_action" | "batch" | "not_mila_draft" | "attachment" | "money" | "agreement" | "unknown_intent";

/** Whether a pending row could ever be sent by a spoken yes (rule 2). Pure: the table-driven tests pin every row kind. */
export function classifyForVoice(row: { kind: string; payload: unknown }): { ok: true; intent: ReplyIntent } | { ok: false; why: VoiceConfirmRefusal } {
  if (row.kind === "agent_action") return { ok: false, why: "tap_only_action" };
  if (row.kind !== "send_reply") return { ok: false, why: "not_a_reply" };
  const p = (row.payload ?? {}) as Record<string, unknown>;
  if (p.source === ASK_TERMS_SOURCE) return { ok: false, why: "batch" };
  if (p.drafted_by !== "mila") return { ok: false, why: "not_mila_draft" };
  if (p.attachment != null && p.attachment !== "") return { ok: false, why: "attachment" };
  const intent = p.reply_intent;
  if (!isReplyIntent(intent)) return { ok: false, why: "unknown_intent" };
  const cls = REPLY_INTENT_CLASS[intent];
  if (cls !== "ordinary") return { ok: false, why: cls };
  if (bodyNamesMoney(String(p.body ?? ""))) return { ok: false, why: "money" };
  return { ok: true, intent };
}

/** The plain reason the model reads when a spoken yes does not count. Prompt Register: "Mila voice — confirm_by_voice". */
export const NEEDS_TAP_REASON: Readonly<Record<VoiceConfirmRefusal | "not_found" | "not_pending" | "not_drafted_here" | "not_read_back" | "same_turn" | "changed" | "not_heard" | "no_conversation" | "not_opted_in" | "welcome_off" | "send_failed", string>> = {
  not_found: "there is no reply waiting with that id",
  not_pending: "that reply is no longer waiting (it was sent, declined or has expired)",
  not_a_reply: "only a reply to a brand can be sent by voice",
  tap_only_action: "this one needs their tap in the app: only an ordinary reply can be sent by voice",
  batch: "this is one of a batch of messages, and each needs their tap in the app",
  not_mila_draft: "you didn't draft this reply, so it needs their tap in the app",
  attachment: "it carries an attachment, so it needs their tap in the app",
  money: "it mentions money or a number, so it needs their tap in the app",
  agreement: "it says yes to the offer, so it needs their tap in the app",
  unknown_intent: "this reply needs their tap in the app",
  not_drafted_here: "only a reply you drafted in this call can be sent by voice; this one needs their tap in the app",
  not_read_back: "read it back to them first with read_back, then ask",
  same_turn: "ask them whether to send it, and wait for their answer before you confirm",
  changed: "the reply changed since you read it back: read it back again before they confirm",
  not_heard: "their answer was not heard yet: ask them again whether to send it",
  no_conversation: "this call has no conversation to record it in, so it needs their tap in the app",
  not_opted_in: "they turned sending by voice off, so ask them to tap Send on the card",
  welcome_off: "sending by voice isn't available yet, so ask them to tap Send on the card",
  send_failed: "it could not be sent",
};

const err = (reason: string, extra: Record<string, unknown> = {}) => JSON.stringify({ status: "error", reason, ...extra });

async function pendingRow(athleteId: string, id: string): Promise<PendingRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(pendingActions).where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId))).limit(1);
  return row ?? null;
}

const stillPending = (row: PendingRow) => row.status === "pending" && !(row.expires_at && row.expires_at.getTime() < Date.now());

/** The address the send would reply to: the thread's inbound rows, newest first, through the same resolver as the send. */
async function recipientOf(athleteId: string, threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const inbound = await db.select({
    sender_email: inboxMessages.sender_email, platform: inboxMessages.platform, external_message_id: inboxMessages.external_message_id,
    gmail_thread_id: inboxMessages.gmail_thread_id, gmail_message_id_header: inboxMessages.gmail_message_id_header,
    connected_account_id: inboxMessages.connected_account_id,
  }).from(inboxMessages)
    .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.direction, "inbound")))
    .orderBy(desc(inboxMessages.received_at));
  if (!inbound.length) return null;
  // The subject is not needed here, so none is asked for (a stored sender answers without a live read).
  return (await resolveReplyEnvelope("", inbound).catch(() => ({ toEmail: null }))).toEmail;
}

export interface ConfirmCall {
  athleteId: string; conversationId: string; callKey: string; session: MilaSessionRow | null; pendingId: string;
  /** The worker's turn id of this tool call: the read-back's turn, or the turn of her answer. */
  turnId: string;
}

export interface ConfirmDeps {
  /** How long to wait for her transcript turn to land (PR C writes it before forwarding the confirm). */
  heardWaitMs?: number;
  approve?: typeof approveSendReply;
  /** Is voice sending on for the athlete? Default: the voice_send capability (agent/welcome; on unless turned off). */
  voiceSendAllowed?: (athleteId: string) => Promise<boolean>;
}

const defaultVoiceSendAllowed = async (athleteId: string) => (await isAllowed(athleteId, VOICE_SEND_CAPABILITY)).allowed;
/** Why a spoken send is off for this athlete right now, or null when it is on. */
async function voiceSendOff(athleteId: string, deps: ConfirmDeps): Promise<"welcome_off" | "not_opted_in" | null> {
  if (!milaWelcomeEnabled()) return "welcome_off";
  return (await (deps.voiceSendAllowed ?? defaultVoiceSendAllowed)(athleteId).catch(() => false)) ? null : "not_opted_in";
}

/**
 * read_back: the reply's content fenced as outside text (the subject and the recipient come from the brand's email),
 * and OUR verdict and note outside the fence, so they read as ours.
 */
export async function readBack(c: ConfirmCall, deps: ConfirmDeps = {}): Promise<{ text: string; isError: boolean }> {
  const row = await pendingRow(c.athleteId, c.pendingId);
  if (!row || (row.kind !== "send_reply" && row.kind !== "agent_action")) return { text: err(NEEDS_TAP_REASON.not_found), isError: true };
  if (!stillPending(row)) return { text: err(NEEDS_TAP_REASON.not_pending), isError: true };
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const verdict = classifyForVoice(row);
  const state = c.session ? await readVoiceConfirm(c.session) : null;
  const drafted = state?.drafted[row.id]?.call === c.callKey;
  const off = await voiceSendOff(c.athleteId, deps);
  const why = !verdict.ok ? NEEDS_TAP_REASON[verdict.why] : !drafted ? NEEDS_TAP_REASON.not_drafted_here
    : !c.session ? NEEDS_TAP_REASON.no_conversation : off ? NEEDS_TAP_REASON[off] : null;
  if (row.kind === "send_reply" && c.session) await recordReadBack(c.session, row.id, c.callKey, bodySha256(String(p.body ?? "")), c.turnId);
  const content = row.kind === "send_reply"
    ? {
      kind: "reply",
      to: (await recipientOf(c.athleteId, row.thread_id).catch(() => null)) ?? state?.drafted[row.id]?.to ?? null,
      subject: p.subject ?? null,
      what: isReplyIntent(p.reply_intent) ? REPLY_INTENT_LABEL[p.reply_intent] : null,
      body: String(p.body ?? ""),
    }
    : { kind: "action", title: p.title ?? null, summary: p.summary ?? null };
  const ours = {
    status: "ok",
    send_by_voice: why === null,
    note: why === null
      ? "Read who it goes to and the gist out loud, then ask whether to send it. Only after they answer yes, call confirm_by_voice."
      : `Read the gist out loud. It can't be sent by voice: ${why}. Tell them it's waiting for their tap in the app.`,
  };
  return { text: `${JSON.stringify(ours)}\n${external(JSON.stringify(content), {}, { newlines: true })!}`, isError: false };
}

/** confirm_by_voice: every rule in the header, then the one send path. */
export async function confirmByVoice(c: ConfirmCall, deps: ConfirmDeps = {}): Promise<{ text: string; isError: boolean; sent: boolean }> {
  const refuse = (k: keyof typeof NEEDS_TAP_REASON, extra: Record<string, unknown> = {}) => {
    logger.info({ athleteId: c.athleteId, pendingActionId: c.pendingId, why: k }, "voice confirm refused");
    return { text: err(NEEDS_TAP_REASON[k], { needs_tap: true, ...extra }), isError: true, sent: false };
  };
  const row = await pendingRow(c.athleteId, c.pendingId);
  if (!row) return refuse("not_found");
  if (!stillPending(row)) return refuse("not_pending");
  const verdict = classifyForVoice(row);
  if (!verdict.ok) return refuse(verdict.why);
  const off = await voiceSendOff(c.athleteId, deps);
  if (off) return refuse(off);
  if (!c.session || !/^[0-9a-f-]{36}$/i.test(c.conversationId)) return refuse("no_conversation");
  let state = await readVoiceConfirm(c.session);
  if (state.drafted[row.id]?.call !== c.callKey) return refuse("not_drafted_here");
  const rb = state.readBacks[row.id];
  if (!rb || rb.call !== c.callKey) return refuse("not_read_back");
  if (rb.turnId === c.turnId) return refuse("same_turn");
  const body = String(((row.payload ?? {}) as Record<string, unknown>).body ?? "");
  if (rb.bodySha256 !== bodySha256(body)) return refuse("changed");
  // Her answer must be on record for THIS turn (rule 5). The worker writes her turn first (PR C), so wait a moment.
  const until = Date.now() + Math.max(0, deps.heardWaitMs ?? 1_500);
  let heard = await heardYes({ athleteId: c.athleteId, conversationId: c.conversationId, state, callKey: c.callKey, turnId: c.turnId, readBack: rb });
  while (!heard && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    state = await readVoiceConfirm(c.session);
    heard = await heardYes({ athleteId: c.athleteId, conversationId: c.conversationId, state, callKey: c.callKey, turnId: c.turnId, readBack: rb });
  }
  if (!heard) return refuse("not_heard");
  // The body she heard, by its hash (what was read back), through the same path as her tap; the claim itself re-checks
  // the stored body against that hash (sendReplyApproval.ts), so an edit during the wait cannot slip through.
  const out = await (deps.approve ?? approveSendReply)(c.athleteId, row, {
    bodySha256: rb.bodySha256, mode: "voice",
    voice: { call: c.callKey, turnId: heard.turnId, transcriptMessageId: heard.messageId, readBackTurnId: rb.turnId },
  });
  if (out.status === 200) {
    logger.info({ athleteId: c.athleteId, pendingActionId: row.id, transcriptMessageId: heard.messageId }, "voice confirm: sent");
    return { text: JSON.stringify({ status: "ok", sent: true, note: "Sent. Tell them in one short line." }), isError: false, sent: true };
  }
  const code = typeof out.body.code === "string" ? out.body.code : null;
  logger.warn({ athleteId: c.athleteId, pendingActionId: row.id, status: out.status, code }, "voice confirm: the send path refused or failed");
  if (code === "BODY_MISMATCH") return refuse("changed");
  const said = typeof out.body.error === "string" ? out.body.error : NEEDS_TAP_REASON.send_failed;
  return { text: err(`${NEEDS_TAP_REASON.send_failed}: ${said}`, { needs_tap: true }), isError: true, sent: false };
}
