/**
 * policy.test.ts — the fixed rules, as pure functions: the skill's toolset, tenancy, family/children details in drafts,
 * tap-to-send for act tools, money always queued, the cost caps (run and day), and a source for every fact.
 */
jest.mock("../db", () => ({ db: {} }));

import { z } from "zod";
import { checkCost, checkFactSource, checkToolCall, findNeverContent } from "./policy";
import { neverTermsFrom } from "./memory";
import type { AgentTool } from "./tools";

const tool = (over: Partial<AgentTool>): AgentTool => ({
  name: "t", description: "d", kind: "ours", permission: "read", args: z.object({ text: z.string().optional() }),
  execute: async () => ({}), ...over,
});
const skill = (tools: string[]) => ({ id: "test/skill", tools });

describe("checkToolCall", () => {
  it("allows a read tool the skill lists", () => {
    expect(checkToolCall({ skill: skill(["t"]), tool: tool({}), name: "t", args: {} })).toMatchObject({ decision: "allow", rule: null });
  });

  it("denies a tool the skill does not list, and an unknown tool (skill_toolset)", () => {
    expect(checkToolCall({ skill: skill(["other"]), tool: tool({}), name: "t", args: {} })).toMatchObject({ decision: "deny", rule: "skill_toolset" });
    expect(checkToolCall({ skill: skill(["t"]), tool: undefined, name: "t", args: {} })).toMatchObject({ decision: "deny", rule: "skill_toolset" });
  });

  it.each([{ athleteId: "x" }, { athlete_id: "x" }, { nested: { athleteid: "x" } }, { list: [{ ATHLETE_ID: "x" }] }])(
    "denies arguments naming an athlete anywhere (tenancy): %j", (args) => {
      expect(checkToolCall({ skill: skill(["t"]), tool: tool({}), name: "t", args })).toMatchObject({ decision: "deny", rule: "tenancy" });
    });

  it("queues an act tool (tap_to_send) and anything with money (money), whatever its permission", () => {
    expect(checkToolCall({ skill: skill(["t"]), tool: tool({ permission: "act" }), name: "t", args: {} })).toMatchObject({ decision: "queue", rule: "tap_to_send" });
    expect(checkToolCall({ skill: skill(["t"]), tool: tool({ permission: "propose", money: true }), name: "t", args: {} })).toMatchObject({ decision: "queue", rule: "money" });
  });

  it("allows family mentions; denies never-content (contact formats, known never terms) in draft / propose / act, not in reads", () => {
    for (const permission of ["draft", "propose", "act"] as const) {
      const t = tool({ permission });
      expect(checkToolCall({ skill: skill(["t"]), tool: t, name: "t", args: { text: "Thanks to my family for every early drive to practice." } }).decision)
        .not.toBe("deny");
      expect(checkToolCall({ skill: skill(["t"]), tool: t, name: "t", args: { text: "Book me: call +1 (555) 010-2030." } }))
        .toMatchObject({ decision: "deny", rule: "family_privacy" });
      expect(checkToolCall({ skill: skill(["t"]), tool: t, name: "t", args: { text: "Write to someone@example.com." } }))
        .toMatchObject({ decision: "deny", rule: "family_privacy" });
      expect(checkToolCall({ skill: skill(["t"]), tool: t, name: "t", args: { text: "Game day with Rowan in the stands!" }, neverTerms: ["Rowan"] }))
        .toMatchObject({ decision: "deny", rule: "family_privacy", reason: expect.stringContaining("never_term") });
    }
    expect(checkToolCall({ skill: skill(["t"]), tool: tool({ permission: "read" }), name: "t", args: { text: "call +1 (555) 010-2030" } })).toMatchObject({ decision: "allow" });
  });
});

describe("findNeverContent", () => {
  it.each([
    "Thanks to my husband for the support",
    "their kids were at the game",
    "A family-owned brand from the coast",
    "Played for the club 2019 - 2023",
    "Scored 15 goals in 17 appearances",
    "Rowanberry jam sponsor",                // a never term inside a longer word is not a match
  ])("allows %s", (text) => expect(findNeverContent(text, ["Rowan"])).toEqual([]));

  it.each([
    ["Call 555-010-2030", "contact"],
    ["Visit 12 Example Street", "address"],
    ["Rowan cheered from the stands", "never_term"],
    ["Proud of rowan today", "never_term"],
  ])("blocks %s", (text, kind) => expect(findNeverContent(text, ["Rowan"])).toContain(kind));
});

describe("neverTermsFrom (the athlete's never-use terms, from avoid preferences)", () => {
  it("reads 'Never use: Name[, Name]' avoid preferences only", () => {
    expect(neverTermsFrom([
      { kind: "avoid", statement: "Never use: Rowan, Ellis", status: "active" },
      { kind: "avoid", statement: "never name: Juno", status: "active" },
      { kind: "avoid", statement: "Never use: Old", status: "retired" },
      { kind: "voice", statement: "Never use: Nope", status: "active" },
      { kind: "avoid", statement: "Avoid betting brands", status: "active" },
    ])).toEqual(["Rowan", "Ellis", "Juno"]);
  });
});

describe("checkCost", () => {
  const caps = { runCap: 500_000, dayCap: 5_000_000 };
  it("allows under both caps", () => expect(checkCost({ runMicroUsd: 499_999, dayMicroUsd: 4_999_999, ...caps })).toMatchObject({ decision: "allow" }));
  it("stops at the run cap", () => expect(checkCost({ runMicroUsd: 500_000, dayMicroUsd: 0, ...caps })).toMatchObject({ decision: "deny", rule: "cost_cap", stop: "cost_cap_run" }));
  it("stops at the day cap, which wins over the run cap", () =>
    expect(checkCost({ runMicroUsd: 600_000, dayMicroUsd: 5_000_000, ...caps })).toMatchObject({ decision: "deny", rule: "cost_cap", stop: "cost_cap_day" }));
});

describe("checkFactSource", () => {
  it("needs a url or a reference", () => {
    expect(checkFactSource({})).toMatchObject({ decision: "deny", rule: "source_required" });
    expect(checkFactSource({ url: "  ", ref: "" })).toMatchObject({ decision: "deny", rule: "source_required" });
    expect(checkFactSource({ ref: "chat:123" })).toMatchObject({ decision: "allow" });
    expect(checkFactSource({ url: "https://example.org/a" })).toMatchObject({ decision: "allow" });
  });
  it("a url must be http(s)", () => expect(checkFactSource({ url: "javascript:alert(1)" })).toMatchObject({ decision: "deny", rule: "source_required" }));
});
