/**
 * prompt.test.ts — guards the load-bearing behavioral guidance in Mila's system
 * prompt. The golden eval can't deterministically force a draft_reply FAILURE or an
 * Outlook/non-sendable draft (it runs the real loop against seeded data, where
 * drafting succeeds and is sendable), so those contracts are pinned here: the
 * guidance must condition the "tap Send" wording on `sendable`, must forbid
 * confabulating a cause on failure, and must forbid pushing an untracked manual send.
 */

import { buildSystemPrompt } from "./prompt";

describe("system prompt — draft_reply sendable conditioning", () => {
  const prompt = buildSystemPrompt();

  it("keys the wording off the tool result's sendable flag", () => {
    expect(prompt).toMatch(/sendable/i);
  });

  it("ties 'tap Send' to sendable:true (the card has a Send button)", () => {
    expect(prompt).toMatch(/when sendable is true/i);
    expect(prompt).toMatch(/tap send/i);
  });

  it("on sendable:false, points to the athlete's own inbox and forbids a Send-tap promise", () => {
    expect(prompt).toMatch(/when sendable is false/i);
    expect(prompt).toMatch(/from their own inbox/i);
    expect(prompt).toMatch(/do not tell them to tap send/i);
  });
});

describe("system prompt — draft_reply failure guidance", () => {
  const prompt = buildSystemPrompt();

  it("directs an honest 'couldn't draft right now' + offer to try again", () => {
    expect(prompt).toMatch(/couldn't draft the reply right now/i);
    expect(prompt).toMatch(/try again/i);
  });

  it("forbids inventing a cause or calling it a glitch/outage", () => {
    expect(prompt).toMatch(/glitch/i);
    expect(prompt).toMatch(/do not invent a reason/i);
    expect(prompt).toMatch(/don't guess/i);
  });

  it("forbids pushing an untracked manual send as a fallback", () => {
    expect(prompt).toMatch(/do not tell them to email/i);
    expect(prompt).toMatch(/manual send isn't tracked/i);
    expect(prompt).toMatch(/nothing was drafted and nothing was sent/i);
  });
});

describe("system prompt — no web-search guidance (MILA_WEB_SEARCH deleted)", () => {
  it("never tells the model it can search the web", () => {
    expect(buildSystemPrompt()).not.toMatch(/search the web/i);
  });
});

describe("system prompt — widget directive declaration", () => {
  const prompt = buildSystemPrompt();

  it("teaches ONE end-of-answer directive, stripped, using EXACT ids", () => {
    expect(prompt).toMatch(/<<widget:deal_list/);
    expect(prompt).toMatch(/<<widget:deal_card/);
    expect(prompt).toMatch(/<<widget:score>>/);
    expect(prompt).toMatch(/exact deal ids/i);
    expect(prompt).toMatch(/stripped before the athlete/i);
    expect(prompt).toMatch(/exactly one/i);
  });

  it("says a reply/draft answer emits NO directive", () => {
    expect(prompt).toMatch(/no directive/i);
  });
});

describe("system prompt — ranking questions don't fan out a tool per deal", () => {
  const prompt = buildSystemPrompt();

  it("tells her to list ONCE, then deep-dive only the top 1-2", () => {
    expect(prompt).toMatch(/ranking questions/i);
    expect(prompt).toMatch(/list_deals once/i);
    expect(prompt).toMatch(/never fan out a tool call per deal/i);
  });

  it("ties the shown card to the recommended deal, not the last opened", () => {
    expect(prompt).toMatch(/not.*whatever you happened to open last/i);
  });
});

describe("system prompt — list_deals is a window, not the portfolio", () => {
  // list_deals returns ~10 rows and the tool's own 4000-char budget pops more
  // beyond that. On the athlete this was traced against — 185 deals, 108
  // brands — the prompt's old claim that ONE call "returns every deal" was
  // simply false, and it is the sentence that makes her state a wrong count and
  // rank a tenth of the portfolio as if it were all of it.
  const prompt = buildSystemPrompt();

  it("no longer claims one call returns every deal", () => {
    expect(prompt).not.toMatch(/it already returns every deal/i);
  });

  it("says outright that the list is capped", () => {
    expect(prompt).toMatch(/only the top handful/i);
  });

  it("forbids stating a deal count or implying completeness", () => {
    expect(prompt).toMatch(/never tell the athlete how many deals they have/i);
    expect(prompt).toMatch(/that's all of them/i);
  });

  it("keeps the no-fan-out rule it is easy to weaken by accident", () => {
    // The cap fix must not become a licence to open deals one by one — that is
    // the latency bug this section originally existed to close.
    expect(prompt).toMatch(/never fan out a tool call per deal/i);
  });

  it("allows a re-query with a different sort or status", () => {
    // The narrow exception to "call it ONCE": aiming the window is not fanning
    // out, and it is the only way to reach a deal outside the default order.
    expect(prompt).toMatch(/sort_by/);
    expect(prompt).toMatch(/calling it again with a DIFFERENT sort/i);
  });

  it("forbids concluding a deal does not exist from its absence", () => {
    expect(prompt).toMatch(/absence from that list is not evidence/i);
  });
});

describe("system prompt — no internal-id / tool-name / bracket-tag leak into prose", () => {
  // Always-on rule (the leak shows up on normal tool results, not just web search).
  const prompt = buildSystemPrompt();

  it("is present in the base prompt", () => {
    expect(prompt).toMatch(/keep the plumbing out of your prose/i);
  });

  it("forbids raw internal ids / UUIDs in the user-facing answer", () => {
    expect(prompt).toMatch(/raw internal identifier/i);
    expect(prompt).toMatch(/uuid/i);
  });

  it("forbids tool names in prose and names the offenders", () => {
    expect(prompt).toMatch(/no tool names/i);
    expect(prompt).toMatch(/get_deal/);
    expect(prompt).toMatch(/get_score/);
  });

  it("directs her to refer to a deal by BRAND NAME, never an id", () => {
    expect(prompt).toMatch(/brand name/i);
    expect(prompt).toMatch(/never by an id/i);
  });

  it("scopes the bracketed [source] citation style to web grounding only", () => {
    expect(prompt).toMatch(/\[source\]/);
    expect(prompt).toMatch(/web-grounding results/i);
    expect(prompt).toMatch(/only/i);
  });

  it("forbids NUMBERED footnote citations ([n]) on internal answers too", () => {
    expect(prompt).toMatch(/numbered footnotes/i);
    expect(prompt).toMatch(/\[1\]/); // names the footnote shape
    expect(prompt).toMatch(/zero brackets of any kind/i);
  });
});

// The contract the prompt enforces, as a concrete detector over answer prose:
// a normal deal answer must contain NO deal/thread UUID, NO tool name, and NO
// bracketed source tag. Validated against the exact leaks from the bug report and
// a clean brand-name answer. (Behavioral verification on the live model is eval:mila.)
describe("deal-answer prose leak detector", () => {
  const UUID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const TOOL_NAME_RE =
    /\b(get_deal|get_score|list_deals|get_rate_card|list_tasks_threads|get_analytics|draft_reply|navigate|get_help|get_brand|get_brand_fit)\b/;
  const BRACKET_TAG_RE = /\[[^\]]+\]/; // any [bracketed tag] — Mila's prose has none

  const leaks = (prose: string): boolean =>
    UUID_RE.test(prose) ||
    TOOL_NAME_RE.test(prose) ||
    BRACKET_TAG_RE.test(prose);

  it("flags the exact leaks from the bug report", () => {
    expect(
      leaks("Your best deal is [402bb00c-8fef-44bd-9f1e-1234567890ab]."),
    ).toBe(true);
    expect(
      leaks(
        "Pulled that from [get_score, 402bb00c-8fef-44bd-9f1e-1234567890ab].",
      ),
    ).toBe(true);
    expect(leaks("Your top deal [Prime Hydration] looks strong.")).toBe(true);
  });

  it("flags NUMBERED footnote citations — the second leak flavor ([n])", () => {
    expect(
      leaks("Your top deals: Prime Hydration [4], Celsius [5], Gymshark [6]."),
    ).toBe(true);
    expect(leaks("Your score is strong [1].")).toBe(true);
  });

  it("passes a clean, brand-name deal answer — no UUID, tool name, or bracket tag", () => {
    const clean =
      "Your strongest deal right now is the Prime Hydration offer — the money's " +
      "solid, so I'd hold firm on usage rights before I give on price.";
    expect(leaks(clean)).toBe(false);
  });

  it("a no-grounding deal/score answer has ZERO bracket markers of any kind", () => {
    const answer =
      "Your top three are the Prime Hydration deal, the Celsius offer, and the " +
      "Gymshark partnership — Prime's strongest on money, so I'd anchor there. " +
      "Your score sits at 512, Rising tier.";
    // No [n], no [uuid], no [tool], no [source] — a normal answer has none.
    expect(answer).not.toMatch(/\[[^\]]+\]/);
    expect(leaks(answer)).toBe(false);
  });
});

describe("system prompt — legacy score and rates retired (phase 1, 8 Oct 2026)", () => {
  const prompt = buildSystemPrompt();

  it("never describes get_score as carrying PAV or a rate card", () => {
    expect(prompt).not.toMatch(/PAV/);
    expect(prompt).not.toMatch(/rate card summary/i);
    expect(prompt).toContain("strengths and room to grow");
  });

  it("forbids stating any per-post / platform rate or projected annual value", () => {
    expect(prompt).toContain("Rates are being rebuilt");
    expect(prompt).toMatch(/NEVER state a per-post rate, a rate for any platform/);
    expect(prompt).toMatch(/projected annual value/);
  });

  it("uses her own floor, called hers, via get_rate_card", () => {
    expect(prompt).toMatch(/call get_rate_card/);
    expect(prompt).toMatch(/THEIR floor/);
  });

  it("explains the score as M.I.A. out of 850, never a tier or the capitals", () => {
    expect(prompt).toMatch(/M\.I\.A\. score, out of 850/);
    expect(prompt).toMatch(/Never mention a tier, 'capitals', or any older score/);
  });
});
