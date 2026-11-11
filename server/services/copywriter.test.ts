/**
 * copywriter.test.ts — the copywriter (COPYWRITER_V1): the Brief as copy context, the shared craft on post copy and moment
 * hooks, the gate, the editor's pick, and flag off = the kit prompt byte for byte. Never reaches a provider: the model
 * clients are stubbed and polishCopy takes its writer and editor as arguments.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/models", () => ({
  GEMINI: { flash: "stub", flashLite: "stub", pro: "stub" }, KIMI: { vertexModel: "stub", moonshotModel: "stub" },
  genai: () => ({ models: { generateContent: async () => { throw new Error("no provider in tests"); } } }),
}));
jest.mock("../lib/kimi", () => ({ kimiThinking: async () => { throw new Error("no provider in tests"); } }));
jest.mock("./athleteContext", () => ({ getAthleteContext: async () => { throw new Error("not read in these tests"); } }));

import { copyBriefFrom, type CopyFact } from "./copyContext";
import { buildContextBlock, buildUserPrompt, CRAFT, defaultCardBriefs, SYSTEM, type NarratorContext } from "./narrator";
import { CAPTION_SYSTEM, buildCopyPrompt, captionOnly, polishCopy, type MomentCopyIn, type PostCopyIn } from "./copywriter";
import { copywriterEnabled } from "./copywriterFlag";

const brief = {
  summary: "Summary line.",
  sections: [
    { key: "thesis", text: "Leadership that opens doors.\nMarketable now for ambassador work." },
    { key: "brand_now_next", text: "So what: build a focused portfolio.\nMake leadership visible now." },
  ],
  internal: { narrative: "A credible platform for focused partnerships.", currentSponsors: [{ name: "Partner A" }] },
  display: {
    positioning: { from: "From A", to: "To B", statement: "The statement.", pillars: [{ name: "Lead", line: "Leads." }] },
    stage: { label: "Established", band: "established" }, contentPillars: [{ name: "Game day" }],
  },
};
const facts: CopyFact[] = [
  { claim: "Named team captain for the season.", type: "found", topic: "career", date: "2026-08-01", precision: "day", sensitive: false },
  { claim: "Won the conference championship.", type: "found", topic: "career", date: "2025-11-01", precision: "month", sensitive: false },
  { claim: "Likes coffee.", type: "said", topic: "personal", date: "2025-01-01", precision: "day", sensitive: false },
  { claim: "Named in a sensitive matter.", type: "found", topic: "career", date: "2025-02-01", precision: "day", sensitive: true },
  { claim: "Won an award at a sponsor event.", type: "found", topic: "sponsor", date: "2025-03-01", precision: "day", sensitive: false },
  { claim: "Instagram (@x) has 21,733 followers.", type: "measured", topic: null, date: "2026-10-18", precision: "day", sensitive: false },
  { claim: "Instagram (@x) has 20,000 followers.", type: "measured", topic: null, date: "2026-09-01", precision: "day", sensitive: false },
];
const ctx: NarratorContext = {
  name: "Alex Doe", sport: "volleyball", school: "State", storyArc: "legacy arc", signalHighlights: ["legacy signal"], brandFitTags: ["Apparel"], commercial: "none",
};

describe("copyBriefFrom", () => {
  it("is null without a current Brief", () => {
    expect(copyBriefFrom(null, facts)).toBeNull();
  });
  it("reads the arc, positioning, partners, milestones and the latest numbers", () => {
    const b = copyBriefFrom(brief, facts)!;
    expect(b.storyArc).toBe("A credible platform for focused partnerships. | big idea: Leadership that opens doors. | verdict: Marketable now for ambassador work.");
    expect(b.partners).toEqual(["Partner A"]);
    expect(b.lanes).toEqual(["So what: build a focused portfolio.", "Make leadership visible now."]);
    expect(b.stage).toBe("Established (established)");
    expect(b.positioning.pillars).toEqual([{ name: "Lead", line: "Leads." }]);
    expect(b.contentPillars).toEqual(["Game day"]);
    // Generic marker words only; sensitive, sponsor-topic and unmarked facts stay out; newest first.
    expect(b.signals).toEqual(["2026: Named team captain for the season.", "2025: Won the conference championship."]);
    // Only the latest measured day.
    expect(b.headline).toEqual(["Instagram (@x) has 21,733 followers."]);
  });
});

describe("narrator context", () => {
  it("without a Brief, the kit prompt is the legacy prompt", () => {
    const body = buildUserPrompt(ctx, defaultCardBriefs(ctx), 2);
    expect(body).toContain("story_arc: legacy arc\nstandout_signals: legacy signal\nbrand_fit_lanes: Apparel\ncommercial_status: no deals signed yet\n<<<END_ATHLETE_CONTEXT>>>\n\nWrite 2 option(s) per slot.");
    expect(body).not.toContain("positioning_statement");
  });
  it("with a Brief, the Brief replaces the arc, signals, lanes and partners and adds positioning", () => {
    const block = buildContextBlock({ ...ctx, brief: copyBriefFrom(brief, facts) });
    expect(block).toContain("story_arc: A credible platform");
    expect(block).toContain("standout_signals: 2026: Named team captain for the season. · 2025: Won the conference championship.");
    expect(block).toContain("commercial_status: has partners — current: Partner A");
    expect(block).toContain("positioning_statement: The statement.");
    expect(block).toContain("headline_numbers: Instagram (@x) has 21,733 followers.");
    expect(block).not.toContain("legacy arc");
  });
  it("CRAFT is SYSTEM's craft half, and the caption system carries it verbatim", () => {
    expect(SYSTEM).toContain(CRAFT);
    expect(CRAFT.startsWith("CRITICAL — facts vs copy")).toBe(true);
    expect(CAPTION_SYSTEM).toContain(CRAFT);
  });
  it("the flag is off unless set", () => {
    const was = process.env.COPYWRITER_V1;
    delete process.env.COPYWRITER_V1;
    expect(copywriterEnabled()).toBe(false);
    process.env.COPYWRITER_V1 = "true";
    expect(copywriterEnabled()).toBe(true);
    if (was === undefined) delete process.env.COPYWRITER_V1; else process.env.COPYWRITER_V1 = was;
  });
});

describe("captionOnly", () => {
  it("keeps the caption draft, drops production notes", () => {
    expect(captionOnly('Shots: two portraits\nCaption draft: "Proud to lead."\nMusic: upbeat')).toBe("Proud to lead.");
  });
  it("falls back to on-image text, then to the text as it is", () => {
    expect(captionOnly('Overlay: "Next up."\nShots: one')).toBe("Next up.");
    expect(captionOnly("Plain caption.")).toBe("Plain caption.");
  });
});

const post: PostCopyIn = { format: "reel", platform: "instagram", timing: "Thu", event: null, hook: "Next up.", show: "a portrait", captionAngle: "focus", avoid: "strategy", caption: "Caption: \"Next up.\"" };
const moment: MomentCopyIn = { name: "Season opener", date: "2026-11-01", category: "league", whyNow: "it starts", angle: "old angle", hook: "old hook" };

describe("polishCopy", () => {
  it("writes from the shared prompt, drops never-content, and takes the editor's pick", async () => {
    const prompts: string[] = [];
    const write = jest.fn(async (system: string, body: string) => {
      prompts.push(system, body);
      return {
        posts: [{ post: 0, options: [{ hook: "A", caption: "uses Secretname here" }, { hook: "B", caption: "clean one" }, { hook: "C", caption: "clean two" }] }],
        moments: [{ moment: 0, options: [{ angle: "x", hook: "y" }, { angle: "", hook: "missing angle" }] }],
      };
    });
    const rank = jest.fn(async (_p: string) => ({ "post 0": 1 }));
    const out = (await polishCopy(ctx, [post], [moment], { neverTerms: ["Secretname"] }, { write, rank }))!;
    expect(prompts[0]).toBe(CAPTION_SYSTEM);
    expect(prompts[1]).toContain("<<<ATHLETE_CONTEXT purpose=narrator>>>");
    expect(prompts[1]).toContain('current caption (rewrite it): Next up.');
    expect(out.posts[0]!.options.map((o) => o.hook)).toEqual(["B", "C"]);
    expect(out.posts[0]!.picked).toEqual({ hook: "C", caption: "clean two" });
    // One clean option: no choice to rank, it is the pick.
    expect(out.moments[0]!.picked).toEqual({ angle: "x", hook: "y" });
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][0]).not.toContain("moment 0:");
  });
  it("a failed editor leaves the first clean option; no writer answer is null", async () => {
    const write = async () => ({ posts: [{ post: 0, options: [{ hook: "A", caption: "one" }, { hook: "B", caption: "two" }] }] });
    const out = await polishCopy(ctx, [post], [], {}, { write, rank: async () => { throw new Error("down"); } });
    expect(out!.posts[0]!.picked.hook).toBe("A");
    expect(await polishCopy(ctx, [post], [], {}, { write: async () => null, rank: async () => ({}) })).toBeNull();
  });
  it("an item with nothing clean is null", async () => {
    const out = await polishCopy(ctx, [], [moment], {}, { write: async () => ({ moments: [] }), rank: async () => ({}) });
    expect(out!.moments).toEqual([null]);
  });
  it("the prompt asks only for what it was given", () => {
    expect(buildCopyPrompt(ctx, [], [moment])).not.toContain('"posts"');
    expect(buildCopyPrompt(ctx, [post], [])).not.toContain("calendar moment");
  });
});
