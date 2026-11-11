/**
 * propose.test — propose_campaign with the model and her library stood in. What the tool does with a
 * reply IS the product: every line inferred with a why, her inputs the only literal lines, the claim gate,
 * the distinctness gate, the prior-context fence and the because that names it (Lane S's proof), the
 * concept in the plan call's own shape.
 */
jest.mock("../../logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { readConcept } from "../agent/concepts";
import { LIBRARY_CLOSE, LIBRARY_OPEN } from "../agent/plan";
import { DEFAULT_BECAUSE } from "./brief";
import {
  unflaggedPaths,
  validateBriefProposal,
  type BriefProposal,
} from "./envelope";
import { jaccard } from "./measure";
import {
  composeAskFromBrief,
  readProposal,
} from "../../../client/screens/studio/directionLogic";
import { JANE_STREET_WIRE } from "../../../client/screens/studio/fixtures/janeStreetBrief";
import {
  claimHits,
  librarySentence,
  priorReference,
  proposeCampaign,
  readConceptLike,
  readInput,
  type LibrarySummary,
} from "./propose";
import {
  OBJECTIVE_GLOSS,
  PRIOR_CLOSE,
  PRIOR_OPEN,
  PROPOSE_PATHS,
} from "./proposePrompt";
import type {
  DirectionTransport,
  DirectionTransportRequest,
} from "./transport";

const HER = "33333333-1111-4444-8555-777777777777";

/** Two lines of her library, as the planner's libraryLine would render them. */
const LIB: LibrarySummary = {
  lines: [
    "a1 | person_in_frame: yes | shot: action | setting: a floodlit pitch | vibe: focused | brands: none seen | from: her upload (verified) | sport: soccer | shows: she strikes a ball at dusk, floodlights behind her",
    "a2 | person_in_frame: yes | shot: portrait | setting: a locker room | vibe: quiet | brands: none seen | from: her upload (verified) | sport: soccer | shows: she laces her boots on a bench, head down",
  ],
  sport: "soccer",
};
const library = async () => LIB;

function transportOf(
  reply: unknown,
  usage: { inputTokens: number; outputTokens: number } | null = {
    inputTokens: 2000,
    outputTokens: 600,
  },
) {
  const requests: DirectionTransportRequest[] = [];
  const transport: DirectionTransport = async (req) => {
    requests.push(req);
    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage,
      model: req.model,
    };
  };
  return { transport, requests };
}

interface ReplyLine {
  path: string;
  value: unknown;
  because?: string;
}
interface ReplyProposal {
  concept: { angle: string; feeling: string; line: string };
  lines: ReplyLine[];
}

const feel = (tone: string[], energy: string, story: string): ReplyLine[] => [
  {
    path: "creative_direction.tone",
    value: tone,
    because: "the feel her library already carries",
  },
  {
    path: "creative_direction.energy",
    value: energy,
    because: "the pace of what she filmed",
  },
  {
    path: "story",
    value: story,
    because: "what the objective asks of her week",
  },
  {
    path: "output.type",
    value: "video",
    because: "the form that grows a following",
  },
  { path: "output.aspect_ratio", value: "9:16", because: "a reel" },
  {
    path: "output.platform",
    value: "instagram",
    because: "where her audience is",
  },
  { path: "subject.sport", value: "soccer", because: "her sport" },
];

/** Three distinct proposals for grow-following, no brand. */
const goodReply = (): { proposals: ReplyProposal[]; notes: string[] } => ({
  proposals: [
    {
      concept: {
        angle: "the hour before floodlights",
        feeling: "quiet, then electric",
        line: "Nobody sees the boots go on; everybody sees the strike under the lights.",
      },
      lines: feel(
        ["quiet", "electric"],
        "rising",
        "the walk from the locker room to the pitch",
      ),
    },
    {
      concept: {
        angle: "a week of touches, counted",
        feeling: "playful, obsessive",
        line: "Ten thousand touches on the ball this week, and she counts every one out loud.",
      },
      lines: feel(
        ["playful", "relentless"],
        "brisk",
        "a running tally across seven mornings",
      ),
    },
    {
      concept: {
        angle: "what the pitch looks like from the ground",
        feeling: "intimate",
        line: "The camera stays on the grass while the game happens above it.",
      },
      lines: feel(
        ["intimate", "unhurried"],
        "slow",
        "a low angle on a full match day",
      ),
    },
  ],
  notes: [],
});

const input = { objective: "grow-following" };

beforeEach(() => {
  process.env.STUDIO_BRAND_PROFILES = "true";
});
afterEach(() => {
  delete process.env.STUDIO_BRAND_PROFILES;
});

describe("propose_campaign — three proposals for grow-following, no brand", () => {
  it("every non-input line is inferred with a because, the objective is her literal line, brand and product are absent, and each is a valid envelope", async () => {
    const { transport, requests } = transportOf(goodReply());
    const r = await proposeCampaign(HER, input, { transport, library });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposals).toHaveLength(3);
    expect(r.dropped).toEqual([]);
    expect(r.libraryLines).toBe(2);
    for (const p of r.proposals) {
      expect(validateBriefProposal(p).ok).toBe(true);
      expect(p.sourceTool).toBe("propose_campaign");
      expect(unflaggedPaths(p)).toEqual([]);
      expect(p.brief.brand).toBeNull();
      expect(p.brief.product).toBeNull();
      expect(p.brief.objective.goal).toBe("grow-following");
      expect(p.brief.creative_direction.tone.length).toBeGreaterThan(0); // feel present…
      const literal = p.flags.filter((f) => f.basis === "literal");
      expect(literal).toEqual([
        { path: "objective.goal", basis: "literal", quote: "grow-following" },
      ]);
      for (const f of p.flags)
        if (f.basis === "inferred") expect(typeof f.because).toBe("string"); // …and inferred, every one
      expect(
        p.flags.find((f) => f.path === "creative_direction.tone")?.basis,
      ).toBe("inferred");
      expect(p.flags.find((f) => f.path === "objective.type")).toEqual({
        path: "objective.type",
        basis: "inferred",
        because: DEFAULT_BECAUSE,
      });
      expect(p.extras.concept).toBeDefined();
      expect(p.flags.find((f) => f.path === "extras.concept")?.because).toBe(
        "proposed for grow-following",
      );
    }
    // Pro, at the concept step's temperature, words only, priced from the tokens reported.
    expect(requests[0].model).toBe("gemini-3.1-pro-preview");
    expect(requests[0].temperature).toBe(0.6);
    expect(requests[0].document).toBeNull();
    expect(r.cost).toEqual({
      usd: 0.0112,
      basis: "estimated",
      inputTokens: 2000,
      outputTokens: 600,
    });
  });

  it("distinct: pairwise line overlap under 0.5 across all three, as the runner measures it", async () => {
    const { transport } = transportOf(goodReply());
    const r = await proposeCampaign(HER, input, { transport, library });
    if (!r.ok) throw new Error("expected ok");
    const lines = r.proposals.map((p) => p.extras.concept!.line);
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++)
        expect(jaccard(lines[i], lines[j])).toBeLessThan(0.5);
  });

  it("a picked proposal's concept is a PlanConcept: the plan call's own reader accepts it with an id", async () => {
    const { transport } = transportOf(goodReply());
    const r = await proposeCampaign(HER, input, { transport, library });
    if (!r.ok) throw new Error("expected ok");
    const picked = r.proposals[1].extras.concept!;
    expect(readConcept({ id: "B", ...picked })).toEqual({ id: "B", ...picked });
    expect(readConceptLike({ angle: "a", feeling: "b" })).toBeNull(); // half a concept is no concept
  });
});

describe("propose_campaign — what the model is shown", () => {
  it("her library enters the instruction only inside the LIBRARY fence, her sport inline, and the objective's gloss is the search sentence", async () => {
    const { transport, requests } = transportOf(goodReply());
    const sentences: string[] = [];
    await proposeCampaign(
      HER,
      { objective: "grow-following", occasion: "the derby week" },
      {
        transport,
        library: async (_id, sentence) => {
          sentences.push(sentence);
          return LIB;
        },
      },
    );
    expect(sentences).toEqual([
      `${OBJECTIVE_GLOSS["grow-following"]} — the derby week`,
    ]);
    const text = requests[0].instruction;
    const open = text.indexOf(LIBRARY_OPEN);
    const close = text.indexOf(LIBRARY_CLOSE);
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    expect(text.slice(open, close)).toContain("she laces her boots on a bench");
    expect(text.slice(0, open)).not.toContain("she laces her boots");
    expect(text).toContain("her sport: soccer");
    expect(text).toContain("occasion: the derby week");
    expect(text).toContain("brand: none named");
    for (const p of PROPOSE_PATHS) expect(text).toContain(`- ${p} —`);
    expect(text).not.toContain("- constraints —");
    expect(text).toMatch(/built or designed to do, what it keeps/); // 6c's rule, shared
  });

  it("a library that cannot be read is a note, not a refusal", async () => {
    const { transport, requests } = transportOf(goodReply());
    const r = await proposeCampaign(HER, input, {
      transport,
      library: async () => {
        throw new Error("search down");
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.libraryLines).toBe(0);
    expect(r.notes[0]).toMatch(/library could not be read/);
    expect(requests[0].instruction).toContain("nothing could be read of it");
    expect(r.proposals[0].extras.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/library could not be read/),
      ]),
    );
  });
});

describe("propose_campaign — prior context (the stacking hook, B2 / Lane S)", () => {
  const moment = {
    sourceTool: "research_moment",
    lines: [
      "Rivalry fixture: vs Crosstown United, Saturday 4 Oct, at home",
      "Angle the moment offers: the derby week, the town picking sides",
    ],
  };
  const replyOnMoment = () => {
    const r = goodReply();
    r.proposals[0] = {
      concept: {
        angle: "derby week, from the inside",
        feeling: "charged, loyal",
        line: "Seven days to Crosstown, and the whole town is picking sides; she shows hers.",
      },
      lines: feel(
        ["charged", "loyal"],
        "building",
        "the week before the derby, counted down",
      ),
    };
    return r;
  };

  /** ⚠️ MUTATION "prior_context ignored": drop the PRIOR markers from proposeInstruction, or `priorReference` — this reds by name. */
  it("prior context enters the instruction only inside its fence, and a proposal that builds on it says so in its because", async () => {
    const { transport, requests } = transportOf(replyOnMoment());
    const r = await proposeCampaign(
      HER,
      { ...input, priorContext: moment },
      { transport, library },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = requests[0].instruction;
    const open = text.indexOf(PRIOR_OPEN);
    const close = text.indexOf(PRIOR_CLOSE);
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    expect(text.slice(open, close)).toContain("vs Crosstown United");
    expect(text.slice(0, open)).not.toContain("Crosstown");
    expect(text).toContain("source: research_moment");
    // At least one proposal references the moment, and its concept's because names the source.
    const onMoment = r.proposals.filter((p) =>
      p.flags
        .find((f) => f.path === "extras.concept")
        ?.because?.startsWith("from research_moment:"),
    );
    expect(onMoment.length).toBeGreaterThanOrEqual(1);
    expect(onMoment[0].extras.concept!.angle).toMatch(/derby/i);
    expect(
      onMoment[0].flags.find((f) => f.path === "extras.concept")?.because,
    ).toBe(
      "from research_moment: Rivalry fixture: vs Crosstown United, Saturday 4 Oct, at home",
    );
    // The others stand on her objective.
    const others = r.proposals.filter((p) => !onMoment.includes(p));
    for (const p of others)
      expect(p.flags.find((f) => f.path === "extras.concept")?.because).toBe(
        "proposed for grow-following",
      );
  });

  it("priorReference picks up a distinctive word, not a common one", () => {
    expect(priorReference(["seven days to the derby"], moment)).toBe(
      moment.lines[1],
    );
    expect(priorReference(["a quiet morning at home"], moment)).toBeNull(); // "home" is four letters: not distinctive
    expect(
      priorReference(["vs Crosstown, and the whole town watching"], moment),
    ).toBe(moment.lines[0]);
  });
});

describe("propose_campaign — the gates", () => {
  /** ⚠️ MUTATION: skip `claimHits` — this reds by name. */
  it("a proposal that sells the product is dropped at the route, not shown — unless the words are hers", async () => {
    const r1 = goodReply();
    r1.proposals[1].concept.line =
      "A bottle built to keep drinks cold for 24 hours, and her whole day around it.";
    const a = await proposeCampaign(HER, input, {
      transport: transportOf(r1).transport,
      library,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.proposals).toHaveLength(2);
    expect(a.dropped).toEqual([
      {
        index: 1,
        reason: expect.stringMatching(/^claim: built to keep drinks cold/),
      },
    ]);
    expect(JSON.stringify(a.proposals)).not.toMatch(/24 hours|built to/);
    // Her own words are not a claim the model made: the same phrase in her occasion lets it through.
    const b = await proposeCampaign(
      HER,
      { ...input, occasion: "built to keep drinks cold — the launch line" },
      { transport: transportOf(r1).transport, library },
    );
    expect(b.ok && b.proposals).toHaveLength(3);
    // The lexicon is what it says it is.
    expect(claimHits("she keeps her focus through the whole set", "")).toEqual(
      [],
    ); // about her, not a product
    expect(
      claimHits(
        "engineered for the cold; leak-proof; clinically proven; 12 hours hot",
        "",
      ),
    ).toHaveLength(4);
  });

  it("two proposals that say the same thing are one: pairwise overlap at or over 0.5 drops the later; fewer than two left is a refusal, not a thin answer", async () => {
    const r = goodReply();
    r.proposals[2].concept.line =
      "Nobody sees the boots go on; everybody sees the strike under the lights again.";
    const two = await proposeCampaign(HER, input, {
      transport: transportOf(r).transport,
      library,
    });
    expect(two.ok && two.proposals).toHaveLength(2);
    expect(two.ok && two.dropped).toEqual([
      { index: 2, reason: "overlap ≥ 0.5 with proposal 0" },
    ]);
    r.proposals[1].concept.line =
      "Nobody sees the boots go on; everybody sees the strike under the lights, twice.";
    const one = await proposeCampaign(HER, input, {
      transport: transportOf(r).transport,
      library,
    });
    expect(one).toMatchObject({
      ok: false,
      reason: "too_few",
      cost: { usd: 0.0112 },
    });
  });

  it("a brand named: brand.name is her literal line, the model's brand lines are ignored, and a product line may stand", async () => {
    const r = goodReply();
    r.proposals[0].lines.push(
      { path: "brand.name", value: "Somebody Else", because: "x" },
      {
        path: "product.line",
        value: "the slate-blue bottle",
        because: "the brand's product",
      },
      { path: "brand.brand_attributes", value: ["clean"], because: "y" },
    );
    const a = await proposeCampaign(
      HER,
      { ...input, brand: "Harbor Hydration" },
      { transport: transportOf(r).transport, library },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const p = a.proposals[0];
    expect(p.brief.brand).toEqual({
      name: "Harbor Hydration",
      brand_attributes: ["clean"],
      profile: null,
    });
    expect(p.flags.find((f) => f.path === "brand.name")).toEqual({
      path: "brand.name",
      basis: "literal",
      quote: "Harbor Hydration",
    });
    expect(p.brief.product).toEqual({
      ref: null,
      fidelity: "high",
      line: "the slate-blue bottle",
    });
    expect(p.flags.find((f) => f.path === "product.fidelity")?.because).toBe(
      DEFAULT_BECAUSE,
    );
    // With no brand, the same lines are dropped and counted.
    const b = await proposeCampaign(HER, input, {
      transport: transportOf(r).transport,
      library,
    });
    expect(b.ok && b.proposals[0].brief.brand).toBeNull();
    expect(b.ok && b.dropped.map((d) => d.reason)).toEqual(
      expect.arrayContaining([
        "brand.name with no brand named",
        "product.line with no brand named",
      ]),
    );
  });
});

describe("propose_campaign — input and refusals", () => {
  it("reads the input strictly: the objective on the list, short lines, a prior context of at most eight lines", () => {
    expect(readInput({ objective: "grow-following" })).toEqual({
      ok: true,
      value: {
        objective: "grow-following",
        brand: null,
        occasion: null,
        prior: null,
      },
    });
    expect(readInput({ objective: "sell-more" })).toMatchObject({
      ok: false,
      issues: [expect.stringMatching(/^objective: one of/)],
    });
    expect(
      readInput({ objective: "recap", brand: "x".repeat(81) }),
    ).toMatchObject({ ok: false });
    expect(
      readInput({
        objective: "recap",
        priorContext: { sourceTool: "Research Moment!", lines: ["a"] },
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.stringMatching(/sourceTool/)],
    });
    expect(
      readInput({
        objective: "recap",
        priorContext: { sourceTool: "research_moment", lines: [] },
      }),
    ).toMatchObject({ ok: false, issues: [expect.stringMatching(/lines/)] });
    expect(
      readInput({
        objective: "recap",
        priorContext: {
          sourceTool: "research_moment",
          lines: Array(9).fill("a"),
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      librarySentence({
        objective: "recap",
        brand: "B",
        occasion: "O",
        prior: null,
      }),
    ).toBe(`${OBJECTIVE_GLOSS.recap} — O — B`);
  });

  it("refuses before any call with the flag off or a bad input; a model that fails or answers prose is a refusal that carries its cost", async () => {
    const { transport, requests } = transportOf(goodReply());
    delete process.env.STUDIO_BRAND_PROFILES;
    expect(await proposeCampaign(HER, input, { transport, library })).toEqual({
      ok: false,
      reason: "disabled",
    });
    process.env.STUDIO_BRAND_PROFILES = "true";
    expect(
      await proposeCampaign(HER, { objective: "nope" }, { transport, library }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(requests).toHaveLength(0);
    const prose = await proposeCampaign(HER, input, {
      transport: transportOf("Three ideas: …").transport,
      library,
    });
    expect(prose).toMatchObject({
      ok: false,
      reason: "invalid_reply",
      cost: { usd: 0.0112 },
    });
    const failing: DirectionTransport = async () => {
      throw new Error("429");
    };
    expect(
      await proposeCampaign(HER, input, { transport: failing, library }),
    ).toEqual({
      ok: false,
      reason: "model_failed",
      model: "gemini-3.1-pro-preview",
    });
  });

  it("the model is a setting: STUDIO_PROPOSE_MODEL moves the call", async () => {
    process.env.STUDIO_PROPOSE_MODEL = "gemini-3.5-flash";
    try {
      const { transport, requests } = transportOf(goodReply());
      const r = await proposeCampaign(HER, input, { transport, library });
      expect(r.ok && r.model).toBe("gemini-3.5-flash");
      expect(requests[0].model).toBe("gemini-3.5-flash");
    } finally {
      delete process.env.STUDIO_PROPOSE_MODEL;
    }
  });
});

// A BriefProposal's concept is what a plan call takes — pinned as a type, not only a value.
const _typeCheck = (p: BriefProposal) =>
  p.extras.concept ? readConcept({ id: "A", ...p.extras.concept }) : null;
void _typeCheck;

describe("the composed ask stays inside the claim lexicon's rule", () => {
  it("the Jane Street ask carries no claim-lexicon token its inputs do not carry", () => {
    const p = readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))!;
    const { prompt } = composeAskFromBrief(p, "Jane Street");
    const inputs = JSON.stringify(p.brief);
    expect(claimHits(prompt, inputs)).toEqual([]);
    // And the rule still bites on a sentence the brief never said.
    expect(
      claimHits(`${prompt} Built to keep you focused all season.`, inputs),
    ).not.toEqual([]);
  });
});
