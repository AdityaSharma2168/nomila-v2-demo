/**
 * agent/evals/offline/toolChoice.cases.ts — "did Mila reach for the right tool?" for the athlete's top questions, as
 * OFFLINE fixtures. Each case is the question, what a right answer must do (the first tool and its arguments, tools that
 * must appear, tools that must never appear, and an order), and two SCRIPTED model outputs: `scripted` (a right turn)
 * and `wrong` (a plausible wrong one the grader must reject). Scripted, not captured: they pin the grader; the paid run
 * (`npm run evals:live`, by hand only) grades a live model's first step with the same grader.
 *
 * Every tool name is checked against the real registry and the chat skill's own tool list, and every argument against
 * the tool's own zod schema (toolChoice.test.ts), so a renamed tool or a changed argument reds CI here. Every athlete,
 * brand and id is made up.
 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolChoiceCase {
  id: string;
  question: string;
  expect: {
    /** The first call must be one of these. */
    first: readonly string[];
    /** The first call's arguments: each key's value must be one of these. */
    firstArgs?: Readonly<Record<string, readonly unknown[]>>;
    /** Each must be called somewhere in the turn. */
    must?: readonly string[];
    /** None of these may be called. */
    never: readonly string[];
    /** [a, b]: a is called before b. */
    order?: ReadonlyArray<readonly [string, string]>;
  };
  scripted: ToolCall[];
  wrong: ToolCall[];
}

/** Tools that act, send or spend: never the answer to a question. */
const ACTS = ["deals_mark", "deals_close", "documents_share", "bookings_respond"] as const;

export const TOOL_CHOICE_CASES: readonly ToolChoiceCase[] = [
  {
    id: "photo-for-northpeak",
    question: "Which photo should I use for my Northpeak pitch?",
    expect: {
      first: ["documents_status"],
      firstArgs: { document: ["pitch"], brand: ["Northpeak", "northpeak", "Northpeak Apparel"], detail: ["pages"] },
      never: ["web_search", "documents_make", ...ACTS],
    },
    scripted: [{ name: "documents_status", args: { document: "pitch", brand: "Northpeak", detail: "pages" } }],
    wrong: [{ name: "documents_make", args: { document: "pitch", brand: "Northpeak" } }],
  },
  {
    id: "how-did-my-posts-do",
    question: "How did my posts do?",
    expect: {
      first: ["recall_facts", "read_scouting"],
      never: ["web_search", "deals_find", ...ACTS],
    },
    scripted: [{ name: "recall_facts", args: { query: "posts", topic: "media" } }],
    wrong: [{ name: "web_search", args: {} }],
  },
  {
    id: "how-much-have-i-earned",
    question: "How much have I earned so far?",
    expect: {
      first: ["deals_find"],
      firstArgs: { filter: ["closed", "all"] },
      never: ["web_search", ...ACTS],
    },
    scripted: [{ name: "deals_find", args: { filter: "closed", limit: 10 } }],
    wrong: [{ name: "deals_find", args: { filter: "needs_you" } }],
  },
  {
    id: "whats-due",
    question: "What's due?",
    expect: {
      first: ["deals_find", "deals_waiting", "bookings_list", "list_goals"],
      never: ["deals_draft_reply", "web_search", ...ACTS],
    },
    scripted: [
      { name: "deals_find", args: { filter: "needs_you" } },
      { name: "bookings_list", args: { view: "upcoming" } },
    ],
    wrong: [{ name: "deals_draft_reply", args: { deal_id: "opp-1", intent: "acknowledge" } }],
  },
  {
    id: "draft-a-reply",
    question: "Draft a reply to Northpeak saying I'm interested and asking what they need.",
    expect: {
      first: ["deals_find"],
      firstArgs: { brand: ["Northpeak", "northpeak", "Northpeak Apparel"] },
      must: ["deals_get", "deals_draft_reply"],
      never: ["web_search", ...ACTS],
      order: [["deals_find", "deals_get"], ["deals_get", "deals_draft_reply"]],
    },
    scripted: [
      { name: "deals_find", args: { filter: "all", brand: "Northpeak" } },
      { name: "deals_get", args: { deal_id: "opp-northpeak-1" } },
      { name: "deals_draft_reply", args: { deal_id: "opp-northpeak-1", intent: "ask_questions", tone: "friendly" } },
    ],
    wrong: [{ name: "deals_draft_reply", args: { deal_id: "opp-northpeak-1", intent: "ask_questions" } }],
  },
];
