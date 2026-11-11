/**
 * milaOpeners — pure-function unit tests (no React, no RN). Covers the fresh-chat
 * greeting resolution per launch context, the {brand} interpolation + its blank
 * fallbacks, and the never-blank default.
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/screens milaOpeners
 */

import { greetingFor, openersFor, emptySubtitleFor, DEFAULT_GREETING, AGENT_DEFAULT_OPENERS, AGENT_DEAL_OPENERS, AGENT_ONE_DEAL_OPENERS } from "./milaOpeners";
import type { MilaContext } from "../hooks/use-mila-chat";

const ctx = (
  over: Partial<MilaContext> & { type: MilaContext["type"] },
): MilaContext => over;

describe("greetingFor", () => {
  it("Deals tab (deals-list) → deals greeting", () => {
    expect(greetingFor(ctx({ type: "deals-list" }))).toBe(
      "Want to go over your deals?",
    );
  });

  it("Brand tab (brand) → score greeting (the reachable score surface)", () => {
    expect(greetingFor(ctx({ type: "brand" }))).toBe(
      "Curious about your score?",
    );
  });

  it("score context → score greeting", () => {
    expect(greetingFor(ctx({ type: "score" }))).toBe(
      "Curious about your score?",
    );
  });

  describe("deal context", () => {
    it("interpolates the brand name when present", () => {
      expect(greetingFor(ctx({ type: "deal", brandName: "Gymshark" }))).toBe(
        "Questions about the Gymshark deal?",
      );
    });

    it("trims surrounding whitespace in the brand name", () => {
      expect(greetingFor(ctx({ type: "deal", brandName: "  Prime  " }))).toBe(
        "Questions about the Prime deal?",
      );
    });

    it("falls back when brandName is undefined", () => {
      expect(greetingFor(ctx({ type: "deal" }))).toBe(
        "Questions about this deal?",
      );
    });

    it("falls back when brandName is empty string (never 'the  deal?')", () => {
      expect(greetingFor(ctx({ type: "deal", brandName: "" }))).toBe(
        "Questions about this deal?",
      );
    });

    it("falls back when brandName is only whitespace", () => {
      expect(greetingFor(ctx({ type: "deal", brandName: "   " }))).toBe(
        "Questions about this deal?",
      );
    });
  });

  it("home / no context → the current generic greeting", () => {
    expect(greetingFor(undefined)).toBe(DEFAULT_GREETING);
    expect(DEFAULT_GREETING).toBe("What can I do for you?");
  });

  it("unmapped contexts (studio, profile) → the default greeting", () => {
    expect(greetingFor(ctx({ type: "studio" }))).toBe(DEFAULT_GREETING);
    expect(greetingFor(ctx({ type: "profile" }))).toBe(DEFAULT_GREETING);
  });

  it("never returns a blank line for any context type", () => {
    const types: MilaContext["type"][] = [
      "deal",
      "score",
      "deals-list",
      "brand",
      "studio",
      "profile",
    ];
    for (const type of types) {
      expect(greetingFor(ctx({ type })).trim().length).toBeGreaterThan(0);
    }
    expect(greetingFor(undefined).trim().length).toBeGreaterThan(0);
  });
});

describe("openersFor (moved unchanged — smoke)", () => {
  it("returns the context set for a mapped type", () => {
    expect(openersFor(ctx({ type: "deals-list" }))[0]).toBe(
      "Which deal should I prioritize?",
    );
  });

  it("falls back to the default openers for no context", () => {
    expect(openersFor(undefined)[0]).toBe("Find my top deal");
  });
});

describe("honest openers on the new agent (AGENT_V3)", () => {
  const off = { agentV3: true, dealsTools: false };
  const on = { agentV3: true, dealsTools: true };
  const dealWords = /deal|\$|in play|pass on|brand fit|waiting on brands|my tap/i;

  it("without deal tools: no opener, greeting or subtitle mentions deals, from any context", () => {
    for (const c of [undefined, ctx({ type: "deals-list" }), ctx({ type: "deal", brandName: "Acme" }), ctx({ type: "brand" })]) {
      expect(openersFor(c, off)).toEqual(AGENT_DEFAULT_OPENERS);
      for (const o of openersFor(c, off)) expect(o).not.toMatch(dealWords);
      expect(greetingFor(c, off)).not.toMatch(/deal/i);
    }
    expect(emptySubtitleFor(off)).not.toMatch(/deal/i);
  });

  it("with deal tools: deal openers from the board, the one-deal set from a deal", () => {
    expect(openersFor(undefined, on)).toEqual(AGENT_DEAL_OPENERS);
    expect(openersFor(ctx({ type: "deals-list" }), on)).toEqual(AGENT_DEAL_OPENERS);
    expect(openersFor(ctx({ type: "deal", brandName: "Acme" }), on)).toEqual(AGENT_ONE_DEAL_OPENERS);
    expect(greetingFor(ctx({ type: "deal", brandName: "Acme" }), on)).toBe("Questions about the Acme deal?");
  });

  it("the old loop keeps its own rows", () => {
    expect(openersFor(undefined, { agentV3: false, dealsTools: false })[0]).toBe("Find my top deal");
    expect(emptySubtitleFor({ agentV3: false, dealsTools: false })).toMatch(/Your deals/);
  });
});
