/**
 * agent/deals/prompts.ts — each deals tool's description, as the model reads it. Registered verbatim in the Prompt
 * Register ("Mila deals toolset"); a change here is a change there. The area's rules are the deals playbook
 * (mila/skills/deals/SKILL.md), which replaced the toolset preamble on 3 Nov 2026.
 */

export const DEALS_TOOLSET_ID = "deals";

export const DEALS_FIND_DESCRIPTION =
  "List their deals in the board's own order (their money and their move first). Filters: needs_you (their move), in_motion (under way, waiting on nobody urgent), waiting_on_them (the brand owes a reply), closed (done, declined, expired, filed), all. Narrow with brand (part of the name) and from / to (YYYY-MM-DD, by last activity or the day it closed). Each row has the Money line, whose move it is and the next step. Shows the first few as deal cards. " +
  "Use for: \"what needs me?\", \"anything new?\", \"what's waiting on brands?\", \"what did I do with <brand> last spring?\" (closed or all, with brand and dates). " +
  "Don't use: for one deal you already have the id of (deals_get), or for their tap queue (deals_waiting).";

export const DEALS_GET_DESCRIPTION =
  "One deal in full: the brand, the type, the four-line read (Money, Fit, Risk, Goal, each with its source), what they asked, the latest offer, whose move it is, the next step, what's not known yet, the reply intents this type allows, and whether a reply can go out from the app. Shows the deal card. " +
  "Use before you judge a deal (\"is it worth it?\"), before any reply, and when OPENED FROM names a deal. " +
  "Errors: not_found (check the id with deals_find), not_yours (never one of theirs), closed (call again with include_closed: true to read it as history).";

export const DEALS_TERMS_DESCRIPTION =
  "The deal's term sheet, row by row: each term and what they stated, plus the terms that matter for this type and aren't stated yet. " +
  "Use when they ask about usage, exclusivity, payment, deliverables or what to push on, or before a counter. Don't use for the headline money (deals_get has it).";

export const DEALS_WAITING_DESCRIPTION =
  "Their queue: replies and ask-for-terms messages that are written and waiting for their tap. Shows the waiting card. " +
  "Use for \"what's waiting for me?\" or before drafting something that may already be waiting. Nothing in it has been sent.";

export const DEALS_DRAFT_REPLY_DESCRIPTION =
  "Write a reply to a deal and show it for their approval: the exact email (from, to, subject, body) with Send, Edit first and Not now. It sends nothing; it goes out only if they tap Send. " +
  "intent: one of the intents deals_get lists for this deal (another returns an error naming the allowed ones). " +
  "term_asks: the terms they want in the reply, each a term and their number (fee in dollars; usage, paid usage (whitelisting) and exclusivity in months, 0 = none; approval rounds; payment days; logistics hours; commission percent) or yes / no. Only numbers they said in this conversation; a fee only with counter, share_rate or propose_paid. tone: friendly (default) or professional. " +
  "Use when they ask for a reply or say yes to your suggestion of one. Don't use to send, to answer a booking, or when a reply to this deal is already waiting (deals_waiting).";

export const DEALS_CLOSE_DESCRIPTION =
  "Close a deal for them, internally, when THEY asked in this conversation to say no to it, drop it or file it: reason not_interested (a real offer they don't want), not_a_deal (spam, mass mail, a scam), expired (the moment passed). It's done at once, as their own action, with Undo on the card; nothing is sent to the brand. polite_no: true also writes a short no for their approval (it still needs their Send). " +
  "Don't use on your own judgement, for a deal they only hesitated about, or to reply (deals_draft_reply with decline is a no that keeps the deal open).";

export const DEALS_MARK_DESCRIPTION =
  "Ask them to confirm a change to a deal's stage: signed (the contract is signed), completed (an agreed deal is done), reopen (bring back one they set aside). NOT done by this call: they see a card and it happens only if they tap. " +
  "Use when they tell you it's signed, done, or that they want one back.";

export const DEALS_OPEN_DESCRIPTION =
  "Show a tap-to-open card for a deal (pass deal_id), their deals board (board), or their closed and past deals (closed). " +
  "Use when they'd rather see it in the app, or after you answered and they want to act there.";

export const BRAND_GET_DESCRIPTION =
  "What Nomila's research says about the brand behind a deal: category, what it does, its audience, its sports and athletes. Confirmed research only: when the research isn't confirmed to be this company it returns why, and you say you can't judge the fit yet. " +
  "Use for \"who are they?\" or before a Fit line. Pass deal_id (preferred) or brand_name.";
