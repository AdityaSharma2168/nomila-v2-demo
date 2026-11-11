/**
 * envelope.test — the BriefProposal contract, held line by line.
 *
 * What is pinned here and nowhere else: the closed list of tools that may sign a proposal. A lane that
 * adds a tool adds it to SOURCE_TOOLS AND to the list below — the second edit is the moment it says,
 * in a test, that its output is flagged. ⚠️ MUTATION: append a name to SOURCE_TOOLS alone — "only the
 * tools this PR has built may sign a proposal" reds by name.
 */
import { echoBrief } from "./echo";
import {
  leafPaths,
  SOURCE_TOOLS,
  unflaggedPaths,
  validateBriefProposal,
  type BriefProposal,
} from "./envelope";

const proposal = (): BriefProposal =>
  echoBrief({ brand: "Solstice", productLine: "the matte-black bottle" });

const withFlags = (flags: unknown) => ({ ...proposal(), flags });

describe("the BriefProposal envelope", () => {
  it("only the tools this PR has built may sign a proposal", () => {
    // Pinned. Each lane extends BOTH lists in the same commit.
    expect([...SOURCE_TOOLS]).toEqual([
      "echo_brief",
      "summarize_brief",
      "propose_campaign",
      "decompose_reference",
      "research_moment",
    ]);
    const signed = { ...proposal(), sourceTool: "research_trend" };
    const v = validateBriefProposal(signed);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.join("\n")).toMatch(/sourceTool/);
  });

  it("a constraint and a concept are lines too — each flagged by its own path, and unflagged when not", () => {
    const p = proposal();
    const withExtras = {
      ...p,
      extras: {
        constraints: ["Do not show competitor logos.", "No health claims."],
        concept: {
          angle: "the quiet hour",
          feeling: "calm",
          line: "Her, before anyone else is up, and the bottle beside her.",
        },
      },
    };
    expect(unflaggedPaths(withExtras)).toEqual([
      "extras.constraints.0",
      "extras.constraints.1",
      "extras.concept",
    ]);
    // A concept is a PlanConcept minus its id — strict, so a half concept is refused.
    expect(
      validateBriefProposal({
        ...p,
        extras: { constraints: [], concept: { angle: "x" } },
      }).ok,
    ).toBe(false);
    const flagged = {
      ...withExtras,
      flags: [
        ...p.flags,
        {
          path: "extras.constraints.0",
          basis: "literal",
          quote: "Do not show competitor logos.",
        },
        {
          path: "extras.constraints.1",
          basis: "inferred",
          because: "the brief's health-claims rule, shortened",
        },
        { path: "extras.concept", basis: "inferred", because: "proposed" },
      ],
    };
    expect(validateBriefProposal(flagged).ok).toBe(true);
    expect(unflaggedPaths(flagged as BriefProposal)).toEqual([]);
    // A flag on a constraint that does not exist is refused like any flag on nothing.
    const onNothing = {
      ...p,
      flags: [
        ...p.flags,
        { path: "extras.constraints.0", basis: "inferred", because: "x" },
      ],
    };
    const v = validateBriefProposal(onNothing);
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.issues.join("\n")).toMatch(
        /no filled line at extras\.constraints\.0/,
      );
    // Notes are the tool's words, not lines: they need no flag, and there are at most four short ones.
    expect(
      validateBriefProposal({
        ...p,
        extras: { constraints: [], notes: ["read 3 pages"] },
      }).ok,
    ).toBe(true);
    expect(
      validateBriefProposal({
        ...p,
        extras: { constraints: [], notes: ["a", "b", "c", "d", "e"] },
      }).ok,
    ).toBe(false);
  });

  it("the spike's proposal is valid, and every filled line of it is flagged", () => {
    const v = validateBriefProposal(proposal());
    expect(v.ok).toBe(true);
    expect(unflaggedPaths(proposal())).toEqual([]);
  });

  it("a literal line carries its quote, an inferred line its because — neither is optional", () => {
    const noQuote = withFlags([{ path: "brand.name", basis: "literal" }]);
    const noBecause = withFlags([{ path: "brand.name", basis: "inferred" }]);
    const a = validateBriefProposal(noQuote);
    const b = validateBriefProposal(noBecause);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok)
      expect(a.issues.join("\n")).toMatch(
        /flags\.0\.quote: a literal line carries the quote/,
      );
    if (!b.ok)
      expect(b.issues.join("\n")).toMatch(
        /flags\.0\.because: an inferred line says why/,
      );
  });

  it("a flag names a filled line — not an empty one, not a missing one, and never the same line twice", () => {
    const onNothing = withFlags([
      { path: "story", basis: "inferred", because: "x" },
    ]); // story is null
    const onNoSuch = withFlags([
      { path: "brand.slogan", basis: "inferred", because: "x" },
    ]);
    const twice = withFlags([
      { path: "brand.name", basis: "literal", quote: "Solstice" },
      { path: "brand.name", basis: "inferred", because: "x" },
    ]);
    for (const [raw, re] of [
      [onNothing, /flags\.0\.path: no filled line at story/],
      [onNoSuch, /flags\.0\.path: no filled line at brand\.slogan/],
      [twice, /flags\.1\.path: brand\.name is flagged twice/],
    ] as const) {
      const v = validateBriefProposal(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues.join("\n")).toMatch(re);
    }
  });

  it("an invalid brief inside a proposal is a refusal that names the brief's own path", () => {
    const p = proposal();
    const bad = {
      ...p,
      brief: { ...p.brief, subject: { ...p.brief.subject, athlete_id: "x" } },
    };
    const v = validateBriefProposal(bad);
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.issues.join("\n")).toMatch(/brief\.subject: .*\[athlete_id\]/);
  });

  it("an unknown key on the envelope is refused, strict as the brief", () => {
    const v = validateBriefProposal({ ...proposal(), athleteId: "x" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.join("\n")).toMatch(/\(root\): .*\[athleteId\]/);
  });

  it("leafPaths is every filled line, once — arrays as one line, nulls and empties as none, never the version tag", () => {
    const paths = leafPaths(proposal().brief);
    expect(paths).toEqual([
      "objective.type",
      "objective.goal",
      "brand.name",
      "subject.identity_priority",
      "product.fidelity",
      "product.line",
      "creative_direction.tone",
      "creative_direction.energy",
      "output.type",
      "output.aspect_ratio",
      "output.platform",
    ]);
    expect(paths).not.toContain("schema");
    expect(paths).not.toContain("story"); // null
    expect(paths).not.toContain("brand.brand_attributes"); // []
    expect(paths).not.toContain("references"); // []
  });

  it("unflaggedPaths names exactly the filled lines no flag speaks for", () => {
    const p = proposal();
    const dropped = {
      ...p,
      flags: p.flags.filter((f) => f.path !== "creative_direction.tone"),
    };
    expect(unflaggedPaths(dropped)).toEqual(["creative_direction.tone"]);
  });
});
