/**
 * validate.test.ts — the deterministic validator (identity-validation/1, contract §5) and the prompt (0.4), pure.
 *
 *   V1 a well-supported draft passes; strengths come from the cited items; pillar proof resolves to proof point keys
 *   V2 contract: unknown id · denied item · the HARD limits (essence short form, pillar label, counts) · the sanity
 *      ceiling · a missing essence · pillar proof that is not PRE-ASSEMBLED; the length TARGETS no longer reject
 *   V3 strength: MARKETABILITY CONTEXT alone cannot carry an output
 *   V4 no vocabulary policing: superlatives, "historic"/"trailblazer" and titles are the prompt's judgement, not a
 *      word match — the validator neither rejects them nor reads them (support is about meaning, principle 2)
 *   V5 direction: positioningCurrent may not rest on DIRECTION alone (her intent is never her present)
 *   V6 an avoided phrase is rejected
 *   V7 motivation must cite HER WORDS · imageGap needs direction and mediaFraming · nullable/empty fields are accepted
 *      · NO pronoun check · approved text passes as is
 *   V8 the prompt (0.5, simplified): the approved text, the principles, no word examples, the limits, sections
 *      A–I with section ids, Unconfirmed never shown, the athlete never named; 0.7: second person to the athlete
 *   V9 (0.7) partner content: tagged in the prompt; standsFor / values / motivation may not rest on it alone
 *   V10 (0.7) qualifiers: a verbatim "first"/"only" claim keeps its "for …" scope (principle 5)
 *   V11 (0.7) strength: citing one copy of a corroborated or Established claim carries that claim's tier
 * Fixtures are fictional.
 */
import { refKey, type BasisItem, type BasisRef, type EnvelopeSection } from "./contract";
import { aliasesFor, buildSynthesisPrompt, parseDraft, PROMPT_TEXT, type ModelDraft } from "./synthesize";
import { droppedScope, validateSynthesis } from "./validate";

const mk = (ref: BasisRef, text: string, tier: BasisItem["tier"], section: EnvelopeSection | undefined, salience = 0.5, extra: Partial<BasisItem> = {}): BasisItem =>
  ({ key: refKey(ref), ref, text, sourceTier: tier, tier, claimKey: null, athleteAuthority: false, athleticIdentity: false, asOf: null, salience, section, ...extra });

const items: BasisItem[] = [
  mk({ kind: "fact", id: "f-sport" }, "Sport: Rowing", "established", "established", 0.9),
  mk({ kind: "fact", id: "f-team" }, "Team: Lakeside College, school, varsity, captain", "established", "established", 0.8),
  mk({ kind: "evidence", id: "e-first" }, "First rower from the town to make the national squad", "established", "pre_assembled", 0.7),
  mk({ kind: "deal", id: "d-1" }, "Brand partnership: Brand Oak", "established", "pre_assembled", 0.6),
  mk({ kind: "media_asset", id: "m-1" }, "early mornings on the water", "reported", "her_words", 0.4, { statement: { provenance: "her_own", medium: "caption", topics: [], platform: "instagram" } }),
  mk({ kind: "said", source: "assertion", id: "a-1" }, "The water is where I feel most myself", "established", "her_words", 0.6, { athleteAuthority: true, statement: { provenance: "her_own", medium: "form", topics: ["motivation"] } }),
  mk({ kind: "objective", id: "o-1" }, "The athlete's positioning goal (intent, not a title): be known as a coach and founder", "established", "direction", 0.6, { intent: true, athleteAuthority: true }),
  mk({ kind: "evidence", id: "e-rep" }, "Called the first coach-rower in the region", "reported", "reported", 0.3),
  mk({ kind: "evidence", id: "e-press" }, "Profiled as a patient, technical rower", "reported", "reported", 0.35),
  mk({ kind: "evidence", id: "e-blog" }, "Rumoured transfer", "unconfirmed", undefined, 0.2),
  mk({ kind: "state_finding", key: "mia.narrative_power" }, "Marketability assessment: narrative power reads as a strength", "salience", "marketability", 0.5),
];
const aliases = aliasesFor(items);
const A = (id: string) => [...aliases.entries()].find(([, i]) => (i.ref as any).id === id || (i.ref as any).key === id)![0];
const env = (avoid: string[] = [], denied: string[] = [], approved: Array<{ field: "essence" | "positioningCurrent"; text: string }> = []) =>
  ({ directives: { preferredEmphasis: [], deEmphasize: [], preferredLanguage: [], avoidLanguage: avoid }, verdicts: { denied: new Set(denied), confirmed: new Set<string>() }, approved });

const NULL_CHAPTERS = { origin: null, rise: null, defining: null, now: null };
const good = (): ModelDraft => ({
  essence: { short: "Varsity rower and crew captain", long: "A varsity rower and crew captain at Lakeside College, shaped by early mornings on the water.", basis: [A("f-sport"), A("f-team"), A("m-1")] },
  positioningCurrent: { short: "A technical rower with a patient, steady style", long: "Described in coverage as a patient, technical rower; a varsity athlete whose own posts show the daily work.", basis: [A("e-press"), A("f-team"), A("m-1")] },
  standsFor: null,
  pillars: [
    { key: "Competitor", label: "Competitor", definition: "A varsity rower selected for the national squad.", proof: [A("e-first")], basis: [A("f-sport")] },
    { key: "partner", label: "Brand partner", definition: "Trusted by a brand partner.", proof: [A("d-1")], basis: [A("f-team"), A("mia.narrative_power")] },
  ],
  differentiators: [{ text: "The first rower from the town on the national squad.", basis: [A("e-first")] }],
  throughline: { short: "Patience on the water, carried into everything", long: "From early mornings on the water to the national squad, patience is the thread.", basis: [A("m-1"), A("e-first")] },
  chapters: { ...NULL_CHAPTERS, now: { text: "Varsity rower at Lakeside College.", basis: [A("f-team")] } },
  athleticStyle: null, origin: null,
  values: [{ text: "Patience", basis: [A("m-1")] }],
  personality: [{ text: "Steady", basis: [A("e-press")] }],
  motivation: { text: "Rowing is where the athlete feels most at home.", basis: [A("a-1")] },
  communities: [], mediaFraming: null, imageGap: null,
});

const run = (d: ModelDraft, e = env()) => validateSynthesis(d, aliases, e);
const errs = (d: ModelDraft, e = env()) => run(d, e).report.errors.join("\n");

describe("V1 a supported draft passes", () => {
  it("passes, resolves ids, takes strength from the cited items, and resolves pillar proof to proof point keys", () => {
    const { report, resolved } = run(good());
    expect(report.errors).toEqual([]);
    expect(resolved!.essence).toMatchObject({ short: "Varsity rower and crew captain", strength: "established" });
    expect(resolved!.essence!.basis).toEqual([{ kind: "fact", id: "f-sport" }, { kind: "fact", id: "f-team" }, { kind: "media_asset", id: "m-1" }]);
    expect(resolved!.values[0].strength).toBe("reported");   // rests on her caption only
    expect(resolved!.pillars.map((p) => p.key)).toEqual(["competitor", "partner"]);   // rules salience order
    expect(resolved!.pillars[0].proof).toEqual(["evidence:e-first"]);
    expect(resolved!.motivation!.basis).toEqual([{ kind: "said", source: "assertion", id: "a-1" }]);
  });
  it("parseDraft refuses a non-object answer", () => {
    expect(parseDraft("nope").errors).toEqual(["the answer is not a JSON object"]);
  });
});

describe("V2 basis and structure", () => {
  it("rejects an unknown id", () => {
    const d = good(); d.essence!.basis = ["E99"];
    expect(errs(d)).toMatch(/essence cites E99, which is not a supplied item id/);
  });
  it("rejects an item the athlete denied", () => {
    expect(errs(good(), env([], ["fact:f-team"]))).toMatch(/the athlete said is not right/);
  });
  it("never shows an Unconfirmed item to the model, so it cannot be cited", () => {
    expect([...aliases.values()].some((i) => i.tier === "unconfirmed")).toBe(false);
  });
  it("enforces the HARD limits: essence short form, pillar label, counts; and a missing essence", () => {
    const d = good();
    d.essence!.short = "x".repeat(61);
    d.pillars[0].label = "Three word label";
    d.values = ["a", "b", "c", "d", "e"].map((t) => ({ text: t, basis: [A("m-1")] }));
    const e = errs(d);
    expect(e).toMatch(/essence\.short is 61 characters; the limit is 60/);
    expect(e).toMatch(/pillars\[0\]\.label must be 1–2 words/);
    expect(e).toMatch(/5 values; at most 4/);
    expect(errs({ ...good(), essence: null })).toMatch(/essence is required/);
  });
  it("length TARGETS no longer reject; the sanity ceiling does", () => {
    const d = good();
    d.values = [{ text: "patience under real pressure", basis: [A("m-1")] }];        // a 4-word value
    d.differentiators[0].text = `The first rower from the town on the national squad, ${"y".repeat(150)}.`;   // well past the 120 target
    d.standsFor = { short: "Rowing as patience", long: "z".repeat(143), basis: [A("m-1")] };          // the 90 target
    expect(run(d).report.errors).toEqual([]);
    d.imageGap = null; d.origin = { text: "w".repeat(401), basis: [A("a-1")] };
    expect(errs(d)).toMatch(/origin is 401 characters; the ceiling is 400/);
  });
  it("pillar proof must be PRE-ASSEMBLED; a pillar on one supporting item is the prompt's guidance, not a rejection", () => {
    const d = good(); d.pillars[0].proof = [A("f-team")];
    expect(errs(d)).toMatch(/pillars\[0\]\.proof cites E\d+, which is not a PRE-ASSEMBLED/);
    const d2 = good(); d2.pillars[0] = { ...d2.pillars[0], basis: [] };
    expect(run(d2).report.errors).toEqual([]);
  });
});

describe("V3 claim class", () => {
  it("MARKETABILITY CONTEXT alone cannot carry an output", () => {
    const d = good(); d.differentiators = [{ text: "A compelling story.", basis: [A("mia.narrative_power")] }];
    expect(errs(d)).toMatch(/differentiators\[0\] rests only on MARKETABILITY CONTEXT/);
  });
});

describe("V4 no vocabulary policing", () => {
  it("superlatives and characterisations are the prompt's judgement: the validator does not match words", () => {
    const d = good();
    d.essence = { short: "A historic first for the town", long: "The town's historic first on the national squad.", basis: [A("f-sport"), A("e-first")] };
    d.differentiators = [{ text: "A trailblazer: the first coach-rower in the region.", basis: [A("e-rep")] }];
    d.mediaFraming = { text: "The best technical rower in regional coverage.", basis: [A("e-press")] };
    expect(run(d).report.errors).toEqual([]);
  });
  it("the strength still comes from what is cited: a Reported-only output is stored as reported", () => {
    const d = good(); d.differentiators = [{ text: "The region's first coach-rower.", basis: [A("e-rep")] }];
    const { report, resolved } = run(d);
    expect(report.errors).toEqual([]);
    expect(resolved!.differentiators[0]).toMatchObject({ strength: "reported", basis: [{ kind: "evidence", id: "e-rep" }] });
  });
  it("titles are not word-matched either; provenance still is (an uncited or unknown basis fails)", () => {
    const d = good(); d.chapters.now = { text: "Crew captain at Lakeside College.", basis: [A("f-team")] };
    expect(run(d).report.errors).toEqual([]);
    d.chapters.now = { text: "Crew captain at Lakeside College.", basis: [] };
    expect(errs(d)).toMatch(/chapters\.now cites no item/);
  });
});

describe("V5 direction", () => {
  it("positioningCurrent may not rest on DIRECTION alone; other fields may draw on it (the prompt keeps it intent)", () => {
    const d = good(); d.positioningCurrent = { short: "Building toward coaching", long: "Building toward a coaching business.", basis: [A("o-1")] };
    expect(errs(d)).toMatch(/positioningCurrent rests only on DIRECTION/);
    const d2 = good(); d2.chapters.now = { text: "Building toward a coaching business.", basis: [A("o-1")] };
    expect(run(d2).report.errors).toEqual([]);
  });
});

describe("V6 athlete authority", () => {
  it("rejects a phrase she asked to avoid", () => {
    expect(errs(good(), env(["Early Mornings"]))).toMatch(/uses "early mornings", which the athlete asked to avoid/);
  });
});

describe("V7 structural governance and her authority", () => {
  it("motivation must cite at least one HER WORDS item", () => {
    const d = good(); d.motivation = { text: "Driven by the national squad.", basis: [A("e-first")] };
    expect(errs(d)).toMatch(/motivation must cite at least one HER WORDS item/);
  });
  it("positioningCurrent may not rest on DIRECTION alone", () => {
    const d = good(); d.positioningCurrent = { short: "Building toward coaching", long: "Building toward a coaching business.", basis: [A("o-1")] };
    expect(errs(d)).toMatch(/positioningCurrent rests only on DIRECTION/);
    d.positioningCurrent.basis = [A("o-1"), A("f-team")];
    expect(run(d).report.errors).toEqual([]);
  });
  it("imageGap needs a stated direction AND a mediaFraming", () => {
    const d = good(); d.imageGap = { text: "Coverage frames technique; the athlete's direction is coaching.", basis: [A("e-press"), A("o-1")] };
    expect(errs(d)).toMatch(/imageGap must be null without a stated DIRECTION and a mediaFraming/);
    d.mediaFraming = { text: "Described in coverage as a patient, technical rower.", basis: [A("e-press")] };
    expect(run(d).report.errors).toEqual([]);
  });
  it("accepts the nullable / empty fields", () => {
    const d: ModelDraft = { ...good(), standsFor: null, athleticStyle: null, origin: null, motivation: null, communities: [], mediaFraming: null, imageGap: null, pillars: [], differentiators: [], values: [], personality: [], chapters: NULL_CHAPTERS };
    const { report, resolved } = run(d);
    expect(report.errors).toEqual([]);
    expect(resolved).toMatchObject({ standsFor: null, motivation: null, communities: [], imageGap: null, pillars: [] });
  });
  it("has no pronoun check: second-person wording is not rejected", () => {
    const d = good(); d.essence = { short: "You row for Lakeside College", long: "You row for Lakeside College.", basis: [A("f-sport"), A("f-team")] };
    expect(run(d).report.errors).toEqual([]);
  });
  it("her approved essence, returned unchanged, is not re-checked", () => {
    const text = "Lakeside rower, crew captain and mentor";
    const d = good(); d.essence = { short: text, long: text, basis: ["E99"] };
    expect(errs(d)).toMatch(/essence cites E99, which is not a supplied item id/);
    expect(run(d, env([], [], [{ field: "essence", text }])).report.errors).toEqual([]);
  });
});

describe("V8 the prompt", () => {
  const p = buildSynthesisPrompt(aliases, env(["hype"]).directives, { approved: [{ target: "identityStatement", text: "Approved words." }], preKinds: new Map([["evidence:e-first", "signature moment"]]) });
  it("carries the approved prompt text: the principles, the limits, one chapter text", () => {
    expect(p.startsWith(PROMPT_TEXT)).toBe(true);
    expect(PROMPT_TEXT).toContain("You are a senior brand strategist at a top athlete-management agency.");
    expect(PROMPT_TEXT).toMatch(/Say what the evidence\s+supports,\s+in precise, vivid words — never stronger than the evidence\./);
    expect(PROMPT_TEXT).not.toMatch(/strongest words/);
    for (const n of ["\n1. Use only the numbered items", "\n2. HER DIRECTION is intent", "\n3. A specific claim resting only on REPORTED items", "\n4. Follow HER DIRECTIVES"]) expect(PROMPT_TEXT).toContain(n);
    expect(PROMPT_TEXT).toMatch(/Write to the athlete in the second person \("you", "your"\) — never as the athlete \("I"\), never about the athlete as\s+"she", "he" or "they"/);
    expect(PROMPT_TEXT).not.toMatch(/third person/);
    expect(PROMPT_TEXT).toContain("Attribute the claim, not the field");
    expect(PROMPT_TEXT).toContain("LIMITS: essence short ≤ 60 chars; pillar label 1–2 words; at most 5 pillars, 3 differentiators, 4 values,");
    expect(PROMPT_TEXT).toContain("no text over 400 chars.");
    expect(PROMPT_TEXT).toContain('"chapters": {"origin":{"text","basis"}');
  });
  it("0.6: mediaFraming comes from press and public coverage among the items, null only when there is none", () => {
    expect(PROMPT_TEXT).toMatch(/mediaFraming: how press and public coverage among the items frames the athlete, in the terms that coverage itself\s+uses; cite those items\. Null only when no item is press or public coverage\./);
  });
  it("names no example words for the model to echo, and no meta-instructions about the program", () => {
    expect(PROMPT_TEXT).not.toMatch(/historic|trailblazer|pioneer|elite|star\b|economist|athleteFacingText|program checks|LENGTH TARGETS/i);
    expect(PROMPT_TEXT.split(/\s+/).length).toBeLessThan(650);
  });
  it("lays out sections A–I with section ids; Unconfirmed never; directives and approved statements in E", () => {
    for (const h of ["A. ESTABLISHED KNOWLEDGE", "B. REPORTED KNOWLEDGE", "C. HER WORDS", "D. HER DIRECTION", "E. HER DIRECTIVES", "F. SELF-PRESENTATION", "G. MEASURED AUDIENCE", "H. MARKETABILITY CONTEXT", "I. PRE-ASSEMBLED"]) expect(p).toContain(h);
    expect(p).toContain("\nE1 [fact] Sport: Rowing");
    expect(p).toMatch(/\nW\d+ \[her_own · caption · instagram\] "early mornings on the water"/);
    expect(p).toMatch(/\nD1 \[goal\] The athlete's positioning goal/);
    expect(p).toMatch(/\nP\d+ \[signature moment\] First rower/);
    expect(p).toMatch(/\nH1 \[assessment\] Marketability assessment/);
    expect(p).not.toContain("Rumoured transfer");
    expect(p).toContain('Never use: "hype"');
    expect(p).toContain('APPROVED statement for essence (return unchanged as both short and long): "Approved words."');
    expect(p).toContain("(prompt identity-synthesis-prompt/0.7)");
  });
});

describe("V9 partner content (0.7)", () => {
  const partner = mk({ kind: "media_asset", id: "m-partner" }, "Fuelled by Brand Oak before every session #ad", "reported", "her_words", 0.5, { statement: { provenance: "her_own", medium: "caption", topics: [], platform: "instagram", partner: true } });
  const pAliases = aliasesFor([...items, partner]);
  const P = (id: string) => [...pAliases.entries()].find(([, i]) => (i.ref as any).id === id || (i.ref as any).key === id)![0];
  const pRun = (d: ModelDraft) => validateSynthesis(d, pAliases, env());
  /** good(), its aliases re-mapped onto pAliases. */
  const base = (): ModelDraft => {
    const d = good();
    const remap = (ids: string[]) => ids.map((a) => { const r = aliases.get(a)!.ref as any; return P(r.id ?? r.key); });
    for (const f of [d.essence!, d.positioningCurrent!, d.throughline!]) f.basis = remap(f.basis);
    d.pillars = d.pillars.map((p) => ({ ...p, proof: remap(p.proof), basis: remap(p.basis) }));
    for (const t of [...d.differentiators, ...d.values, ...d.personality, d.motivation!, d.chapters.now!]) t.basis = remap(t.basis);
    return d;
  };
  it("the prompt tags it partner content, not her_own, and says what it may show", () => {
    expect(buildSynthesisPrompt(pAliases, env().directives)).toMatch(/\nW\d+ \[partner content · caption · instagram\] "Fuelled by Brand Oak/);
    expect(PROMPT_TEXT).toMatch(/6\. An item tagged partner content is a brand's message the athlete published: it may show a partnership, never the\s+athlete's values, standsFor or motivation\./);
  });
  it("standsFor, values and motivation may not rest on partner content alone", () => {
    expect(pRun(base()).report.errors).toEqual([]);
    const d = base();
    d.standsFor = { short: "Fuel for the work", long: "Fuel for the daily work.", basis: [P("m-partner")] };
    d.values = [{ text: "Fuel", basis: [P("m-partner")] }];
    d.motivation = { text: "Fuelled before every session.", basis: [P("m-partner")] };
    const e = pRun(d).report.errors.join("\n");
    expect(e).toMatch(/standsFor rests only on partner content/);
    expect(e).toMatch(/values\[0\] rests only on partner content/);
    expect(e).toMatch(/motivation rests only on partner content/);
    expect(e).toMatch(/motivation must cite at least one HER WORDS item \(W…\) that is not partner content/);
  });
  it("partner content may still support other outputs, or sit beside her own words", () => {
    const d = base();
    d.chapters.now = { text: "In a partnership with Brand Oak.", basis: [P("m-partner")] };
    d.values = [{ text: "Patience", basis: [P("m-1"), P("m-partner")] }];
    expect(pRun(d).report.errors).toEqual([]);
  });
});

/** good(), trimmed to outputs whose bases exist in `al`, with `differentiators` replaced. */
function trimmed(al: ReturnType<typeof aliasesFor>, differentiators: ModelDraft["differentiators"]): ModelDraft {
  const X = (id: string) => [...al.entries()].find(([, i]) => (i.ref as any).id === id)![0];
  const d = good();
  d.essence = { ...d.essence!, basis: [X("f-sport"), X("f-team")] };
  d.positioningCurrent = { ...d.positioningCurrent!, basis: [X("e-press"), X("f-team")] };
  d.throughline = { ...d.throughline!, basis: [X("e-first")] };
  d.motivation = { ...d.motivation!, basis: [X("a-1")] };
  d.pillars = []; d.values = []; d.personality = []; d.chapters = NULL_CHAPTERS;
  d.differentiators = differentiators;
  return d;
}

describe("V10 qualifiers (0.7)", () => {
  const scoped = mk({ kind: "evidence", id: "e-scope" }, "The first player from the valley to compete in a world final for the national team", "established", "established", 0.6);
  const sAliases = aliasesFor([...items, scoped]);
  const S = [...sAliases.entries()].find(([, i]) => (i.ref as any).id === "e-scope")![0];
  const sRun = (text: string) => validateSynthesis(trimmed(sAliases, [{ text, basis: [S] }]), sAliases, env()).report.errors.join("\n");
  it("the prompt keeps qualifiers (principle 5)", () => {
    expect(PROMPT_TEXT).toMatch(/5\. Keep every qualifier a claim carries — for whom, at what level, when, in which competition\. Never widen a "first"\s+or "only" by dropping its scope\./);
  });
  it("rejects a verbatim first claim that drops its 'for …' scope; keeping it, or a paraphrase, passes", () => {
    expect(sRun("The first player from the valley to compete in a world final.")).toMatch(/differentiators\[0\] repeats the "first"\/"only" claim in E\d+ without its qualifier "for the national team"; keep it/);
    expect(sRun("The first player from the valley to compete in a world final for the national team.")).toBe("");
    expect(sRun("A valley native who reached a world final with the national team.")).toBe("");
  });
  it("droppedScope ignores short heads and claims with no 'for' scope", () => {
    expect(droppedScope("The first goal of the season.", "Scored first for the club")).toBeNull();
    expect(droppedScope("The only rower in the crew to row both sides.", "The only rower in the crew to row both sides")).toBeNull();
  });
});

describe("V11 strength follows the claim (0.7)", () => {
  it("one copy of a corroborated claim carries the claim's Reported tier; one copy of an Established claim, Established", () => {
    // Two outlets, neither page retrieved: each source is Unconfirmed alone, the claim (≥ 2 domains) is Reported.
    const copy = mk({ kind: "evidence", id: "e-copy" }, "Named to the regional crew", "unconfirmed", "reported", 0.4, { tier: "reported", source: { type: "major_news", domain: "one.example", lineage: "asserted_only" } } as any);
    // The evidence copy of an Established fact: Reported as a source, Established as a claim.
    const factCopy = mk({ kind: "evidence", id: "e-fact-copy" }, "Rows for Lakeside College", "reported", "established", 0.4, { tier: "established", source: { type: "regional_news", domain: "two.example", lineage: "cited" } } as any);
    const cAliases = aliasesFor([...items, copy, factCopy]);
    const C = (id: string) => [...cAliases.entries()].find(([, i]) => (i.ref as any).id === id)![0];
    const d = trimmed(cAliases, [{ text: "Named to the regional crew.", basis: [C("e-copy")] }, { text: "Rows for Lakeside College.", basis: [C("e-fact-copy")] }]);
    const { report, resolved } = validateSynthesis(d, cAliases, env());
    expect(report.errors).toEqual([]);
    expect(resolved!.differentiators.map((x) => x.strength)).toEqual(["reported", "established"]);
  });
  it("an item whose claim is Unconfirmed is still never shown, so it cannot be cited", () => {
    const copy = mk({ kind: "evidence", id: "e-copy" }, "Named to the regional crew", "unconfirmed", "reported", 0.4, { tier: "unconfirmed", source: { type: "major_news", domain: "one.example", lineage: "asserted_only" } } as any);
    const cAliases = aliasesFor([...items, copy]);
    expect([...cAliases.values()].some((i) => i.key === "evidence:e-copy")).toBe(false);
  });
});
