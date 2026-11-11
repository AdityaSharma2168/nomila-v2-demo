/**
 * confirm.test.ts — which pending items a spoken "send it" may ever send (confirm.ts classifyForVoice), table-driven over
 * every action kind. Pure: no database, no provider. The rest of confirm_by_voice's rules (drafted in this call, read
 * back, body unchanged, she spoke after) are driven over HTTP in oneMila.db.test.ts.
 *
 * Owner rules (9 Nov 2026; 10 Nov 2026): only an ORDINARY reply Mila drafted, which now includes a polite no and asking
 * for terms or paperwork. Money, a yes to an offer (gift / try / times / logistics), public posts and shares,
 * capability turn-ons, bookings and every queued agent action always need the real tap.
 */
jest.mock("../../db", () => ({ db: {} }));

import { REPLY_INTENTS, FIGURE_INTENTS, ACCEPT_INTENTS, type ReplyIntent } from "../../../shared/deals";
import { ORDINARY_REPLY_INTENTS, REPLY_INTENT_CLASS, bodyNamesMoney, classifyForVoice } from "./confirm";

const reply = (intent: string, extra: Record<string, unknown> = {}) => ({
  kind: "send_reply",
  payload: { body: "Thanks for reaching out. Could you share a bit more about the timing?", reply_intent: intent, source: "mila_chat", drafted_by: "mila", ...extra },
});

/** Every reply intent and what a spoken yes may do with it. */
const EXPECTED: Record<ReplyIntent, "ok" | "money" | "agreement"> = {
  accept_terms: "money", counter: "money", ask_question: "ok", decline: "ok",
  ask_terms: "ok", share_rate: "money",
  accept_gift: "agreement", ask_expectations: "ok", propose_paid: "money",
  accept_to_try: "agreement",
  accept_and_propose_times: "agreement", ask_questions: "ok", ask_questions_in_advance: "ok", redirect_to_pr: "ok",
  accept_and_confirm_logistics: "agreement", ask_details: "ok",
  ask_fee_plus_commission: "money", accept_affiliate: "money",
  ask_term_sheet: "ok",
  ask_licensing_terms: "ok",
  acknowledge: "ok",
  ask_who_they_are: "ok",
};

describe("a reply drafted by Mila, by intent", () => {
  test("the table covers every reply intent", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...REPLY_INTENTS].sort());
    expect(Object.keys(REPLY_INTENT_CLASS).sort()).toEqual([...REPLY_INTENTS].sort());
  });

  test.each(REPLY_INTENTS.map((i) => [i, EXPECTED[i]]))("%s → %s", (intent, want) => {
    const v = classifyForVoice(reply(intent));
    expect(v.ok ? "ok" : v.why).toBe(want);
  });

  test("no figure intent, no accept intent is ever ordinary", () => {
    for (const i of [...FIGURE_INTENTS, ...ACCEPT_INTENTS]) expect(ORDINARY_REPLY_INTENTS).not.toContain(i);
  });
});

describe("a reply, by what else is on the row", () => {
  test.each([
    ["an amount in the body", { body: "Happy to do it for $500." }, "money"],
    ["a date in the body (fails closed)", { body: "Could we talk on the 14th?" }, "money"],
    ["a currency word in the body", { body: "Would 300 dollars work?" }, "money"],
    ["a k-figure in the body", { body: "My rate is 2k a post." }, "money"],
    ["a percentage in the body", { body: "Is the commission 10%?" }, "money"],
    ["an ask-terms batch row", { source: "ask_terms_batch" }, "batch"],
    ["the athlete's own reply (not Mila's draft)", { drafted_by: undefined, source: "inbox" }, "not_mila_draft"],
    ["an attachment", { attachment: "media-kit.pdf" }, "attachment"],
    ["an unknown intent", { reply_intent: "send_money" }, "unknown_intent"],
    ["no intent", { reply_intent: undefined }, "unknown_intent"],
  ] as const)("%s → %s", (_label, extra, want) => {
    const v = classifyForVoice(reply("ask_question", extra as Record<string, unknown>));
    expect(v.ok ? "ok" : v.why).toBe(want);
  });

  test("fails closed: any digit, currency, percentage, money word or spelled-out number is refused", () => {
    for (const body of [
      "Could we talk on March 3?", "Is it 3 posts over 2 weeks?", "See you on the 14th.", "Would 1.5 work?",
      "Happy with £200", "€50 is fine", "10% works", "What's your fee?", "What is the rate?", "Is this paid?",
      "Can you pay for travel?", "Payment terms?", "What's the budget?", "Commission only?", "Any compensation?",
      "Five grand", "five hundred", "twenty posts", "a thousand thanks", "Is it per post?", "300 USD", "two weeks",
    ]) expect([body, bodyNamesMoney(body)]).toEqual([body, true]);
  });

  test("an ordinary question with no number and no money word is not money", () => {
    for (const body of [
      "Thanks for reaching out! Could you share more about the timing and what you have in mind?",
      "Who is the best person to talk to about this?", "Could you send the details for the event?",
      "I'd love one more detail about the campaign.",
    ]) expect([body, bodyNamesMoney(body)]).toEqual([body, false]);
  });
});

describe("every other kind of pending item is tap-only", () => {
  // Anything the policy queued (agent_action): saving memory, marking signed / completed, sharing or publishing a
  // document, answering a booking, turning a capability on, a money tool. And any other kind of row.
  test.each([
    ["agent_action", "remember_preference"],
    ["agent_action", "deals_mark"],
    ["agent_action", "documents_share"],
    ["agent_action", "bookings_respond"],
    ["agent_action", "offer_capability"],
    ["agent_action", "request_payment"],
    ["agent_action", "refresh_plan"],
    ["post_publish", null],
    ["payment", null],
    ["booking", null],
  ] as const)("%s %s", (kind, tool) => {
    const v = classifyForVoice({ kind, payload: { tool, args: {}, body: "Ask about timing", reply_intent: "ask_question", drafted_by: "mila" } });
    expect(v.ok).toBe(false);
    expect(v.ok ? null : v.why).toBe(kind === "agent_action" ? "tap_only_action" : "not_a_reply");
  });
});
