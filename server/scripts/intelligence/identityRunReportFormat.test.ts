/**
 * identityRunReportFormat.test.ts — pure-logic tests for identityRunReport.ts's formatting/diff helpers.
 * Fictional athlete fixtures only; no DB, no provider.
 */
import {
  cap, collectBasisRefs, collectBasisRefsExcluding, compareValueFields, countByKey, countByKindTier, countByTier,
  describeJsonValue, diffKinds, kindsOf, renderMarkdownReport, type IdentityRunReport,
} from "./identityRunReportFormat";

describe("cap", () => {
  it("leaves short text alone", () => { expect(cap("Riley Tam plays midfield")).toBe("Riley Tam plays midfield"); });
  it("truncates with an ellipsis at the limit", () => {
    const s = "a".repeat(50);
    expect(cap(s, 10)).toBe("aaaaaaaaa…");
    expect(cap(s, 10).length).toBe(10);
  });
  it("collapses internal whitespace", () => { expect(cap("a   b\n\tc")).toBe("a b c"); });
});

describe("describeJsonValue", () => {
  it("renders null/undefined as none", () => {
    expect(describeJsonValue(null)).toBe("none");
    expect(describeJsonValue(undefined)).toBe("none");
  });
  it("renders an empty string as none", () => { expect(describeJsonValue("   ")).toBe("none"); });
  it("renders a plain string, capped", () => { expect(describeJsonValue("midfielder for Riverside FC")).toBe("midfielder for Riverside FC"); });
  it("renders numbers and booleans as-is", () => {
    expect(describeJsonValue(42)).toBe("42");
    expect(describeJsonValue(true)).toBe("true");
  });
  it("renders an empty array distinctly from a populated one", () => {
    expect(describeJsonValue([])).toBe("none (0 items)");
    expect(describeJsonValue(["a", "b", "c"])).toContain("[3 items]");
  });
  it("truncates a long array and says how many more", () => {
    const out = describeJsonValue(["a", "b", "c", "d", "e", "f"]);
    expect(out).toContain("+2 more");
  });
  it("prefers an object's value/text/summary/label field when present", () => {
    expect(describeJsonValue({ value: "Riley is a leader on and off the pitch", basis: [1, 2] })).toBe("Riley is a leader on and off the pitch (2 basis)");
  });
  it("falls back to a key list for a plain object", () => {
    expect(describeJsonValue({ foo: 1, bar: 2 })).toBe("{foo, bar}");
  });
  it("marks a truly empty object", () => { expect(describeJsonValue({})).toBe("{} (empty)"); });
});

describe("basis-ref extraction", () => {
  const FIXTURE_VALUE = {
    contract: "identity-intelligence/0.1",
    identityStatement: { value: "Riley Tam, midfielder", basis: [{ kind: "fact", id: "11111111-1111-1111-1111-111111111111" }] },
    themes: [
      { key: "leadership", label: "Leadership", summary: "A vocal captain", basis: [{ kind: "evidence", id: "22222222-2222-2222-2222-222222222222" }], salience: 0.8, strength: "established", media: null },
    ],
    selfPresentation: { themes: ["soccer"], tone: ["warm"], platforms: ["instagram"], basis: [{ kind: "first_look", snapshotId: "33333333-3333-3333-3333-333333333333", platform: "instagram" }] },
    envelope: [
      { ref: { kind: "fact", id: "11111111-1111-1111-1111-111111111111" }, tier: "established" },
      { ref: { kind: "evidence", id: "22222222-2222-2222-2222-222222222222" }, tier: "reported" },
      { ref: { kind: "first_look", snapshotId: "33333333-3333-3333-3333-333333333333", platform: "instagram" }, tier: "reported" },
      { ref: { kind: "social_feature", key: "instagram.followers_latest" }, tier: "established" },
      { ref: { kind: "state_finding", key: "mia.audience_scale" }, tier: "salience" },
    ],
  };

  it("collectBasisRefs finds refs nested anywhere, deduped", () => {
    const refs = collectBasisRefs(FIXTURE_VALUE);
    const kinds = refs.map((r) => r.kind).sort();
    expect(kinds).toEqual(["evidence", "fact", "first_look", "social_feature", "state_finding"].sort());
    expect(refs.length).toBe(5); // the fact and evidence refs each appear twice in the fixture (cited + envelope) but dedupe to one
  });

  it("collectBasisRefsExcluding drops refs that live only under an excluded top-level key", () => {
    const cited = collectBasisRefsExcluding(FIXTURE_VALUE, ["envelope"]);
    const kinds = cited.map((r) => r.kind).sort();
    // social_feature and state_finding appear ONLY in envelope, so they drop out once envelope is excluded.
    expect(kinds).toEqual(["evidence", "fact", "first_look"].sort());
  });

  it("ignores objects that merely happen to have a kind field outside the BasisRef vocabulary", () => {
    const refs = collectBasisRefs({ source: { kind: "web_researched", domain: "example.com" } });
    expect(refs).toEqual([]);
  });
});

describe("counting helpers", () => {
  it("countByKindTier groups a flat list into kind -> tier -> count", () => {
    const out = countByKindTier([
      { kind: "fact", tier: "established" }, { kind: "fact", tier: "established" }, { kind: "evidence", tier: "reported" },
    ]);
    expect(out).toEqual({ fact: { established: 2 }, evidence: { reported: 1 } });
  });

  it("countByTier groups by tier alone", () => {
    expect(countByTier([{ tier: "established" }, { tier: "reported" }, { tier: "established" }])).toEqual({ established: 2, reported: 1 });
  });

  it("countByKey tallies a list of strings", () => {
    expect(countByKey(["origin", "origin", "leadership"])).toEqual({ origin: 2, leadership: 1 });
  });

  it("kindsOf returns the sorted kind list of a kind/tier count map", () => {
    expect(kindsOf({ fact: { established: 1 }, evidence: { reported: 1 } })).toEqual(["evidence", "fact"]);
  });

  it("diffKinds reports what's new and what dropped", () => {
    expect(diffKinds(["fact", "evidence"], ["fact", "deal"])).toEqual({ added: ["deal"], removed: ["evidence"] });
  });
});

describe("compareValueFields", () => {
  it("unions fields from both sides, marks unchanged fields and flags changes", () => {
    const previous = { contract: "identity-intelligence/0.1", identityStatement: { value: "Riley Tam, midfielder" }, overallConfidence: "MEDIUM" };
    const latest = { contract: "identity-intelligence/0.1", identityStatement: { value: "Riley Tam, captain and midfielder" }, overallConfidence: "MEDIUM", differentiators: [{ value: "Bilingual broadcast work", basis: [] }] };
    const diff = compareValueFields(previous, latest);
    const byField = Object.fromEntries(diff.map((d) => [d.field, d]));
    expect(byField.contract).toBeUndefined(); // metadata field excluded
    expect(byField.overallConfidence.changed).toBe(false);
    expect(byField.identityStatement.changed).toBe(true);
    expect(byField.differentiators.previous).toBe("none");
    expect(byField.differentiators.changed).toBe(true);
  });

  it("handles a null previous row (first recompute) without throwing", () => {
    const diff = compareValueFields(null, { identityStatement: { value: "x" } });
    expect(diff.find((d) => d.field === "identityStatement")?.previous).toBe("none");
  });
});

describe("renderMarkdownReport", () => {
  const FICTIONAL_REPORT: IdentityRunReport = {
    athleteId: "aaaaaaaa-0000-0000-0000-000000000000",
    generatedAt: "2026-10-03T00:00:00.000Z",
    research: {
      workflowRunId: "wf-1",
      runs: [
        { id: "run-q1", queryId: "Q1", domain: "refresh", status: "ok", calls: 1, signalCalls: 0, otherCalls: 1, estimatedCostUsd: "0.0100", confidenceOut: "0.80", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:01:00.000Z" },
        { id: "run-read", queryId: "READ", domain: "refresh", status: "ok", calls: 2, signalCalls: null, otherCalls: 2, estimatedCostUsd: "0.0200", confidenceOut: null, startedAt: "2026-10-01T00:02:00.000Z", finishedAt: "2026-10-01T00:03:00.000Z" },
      ],
      athleteMedia: [{ kind: "press_mention", title: "Riverside FC profile", outlet: "Riverside Times", outletType: "regional_news", medium: "article", participation: "interview", date: "2026-09-01", url: "https://example.com/a", athleteQuoted: true }],
      signatureMoments: [{ event: "Scored the winning goal in the regional final", date: "2026-05-01", competition: "Regional Cup" }],
      narrativeTopics: { leadership: 2, origin: 1 },
      sourceTypeDistribution: { regional_news: 1, unknown: 3 },
    },
    targetedRead: {
      readRun: { id: "run-read", queryId: "READ", domain: "refresh", status: "ok", calls: 2, signalCalls: null, otherCalls: 2, estimatedCostUsd: "0.0200", confidenceOut: null, startedAt: "2026-10-01T00:02:00.000Z", finishedAt: "2026-10-01T00:03:00.000Z" },
      readSpec: "source-read/1",
      sources: [{ url: "https://example.com/a", mode: "page", completed: true, refused: false, claims: 3, statements: 1, paraphrases: 1, dropped: null }],
      payloads: [{ id: "payload-1", provider: "gemini_direct", model: "gemini-2.5-flash", endpointFamily: "generate_content", bytes: 2048, fetchedAt: "2026-10-01T00:02:30.000Z", payloadHash: "abcdef0123456789" }],
      athleteStatements: [{ text: "I just want to keep improving every week.", topics: ["motivation"], medium: "article", timestampSeconds: null, outlet: "Riverside Times", sourceTitle: "Riverside FC profile" }],
      otherEvidenceByKind: { narrative_claim: { count: 2, samples: ["She is known for her calm distribution under pressure."] } },
    },
    firstLook: {
      platforms: [{ platform: "instagram", computedAt: "2026-09-30T00:00:00.000Z", themes: ["training", "family"], tone: ["warm", "upbeat"], interests: ["cooking"], recurringPhrases: ["let's go"], causesMentioned: ["youth sports access"] }],
      bios: [{ platform: "instagram", text: "midfielder | Riverside FC | dog mom", sourceClass: "platform_public", asOf: "2026-09-30T00:00:00.000Z" }],
    },
    identityIntelligence: {
      latest: { id: "ledger-2", contract: "identity-intelligence/0.1", createdAt: "2026-10-02T00:00:00.000Z", envelopeCounts: { fact: { established: 2 }, evidence: { reported: 1 } }, claimTierCounts: { established: 1, reported: 1 }, citedKinds: ["fact", "evidence"] },
      previous: { id: "ledger-1", contract: "identity-intelligence/0.1", createdAt: "2026-09-01T00:00:00.000Z", envelopeCounts: { fact: { established: 1 } }, claimTierCounts: { established: 1 }, citedKinds: ["fact"] },
      comparison: {
        fields: [{ field: "identityStatement", previous: "Riley Tam, midfielder", latest: "Riley Tam, captain and midfielder", changed: true }],
        citedCounts: { previous: { fact: { established: 1 } }, latest: { fact: { established: 2 }, evidence: { reported: 1 } } },
        newlyUsedKinds: ["evidence"],
        droppedKinds: [],
      },
      rawValue: { contract: "identity-intelligence/0.1", identityStatement: { value: "Riley Tam, captain and midfielder" } },
    },
    validation: [{ refKey: "fact:11111111-1111-1111-1111-111111111111", kind: "fact", tier: "established", text: "position: midfielder", source: "research/web_researched" }],
  };

  const md = renderMarkdownReport(FICTIONAL_REPORT);

  it("includes all seven numbered sections", () => {
    for (let i = 1; i <= 7; i++) expect(md).toContain(`## ${i}.`);
  });
  it("renders the research query table with Q1 and READ rows", () => {
    expect(md).toContain("| Q1 |");
    expect(md).toContain("| READ |");
  });
  it("renders athlete_media, signature moments and narrative topics", () => {
    expect(md).toContain("Riverside FC profile");
    expect(md).toContain("Scored the winning goal in the regional final");
    expect(md).toContain("leadership: 2");
  });
  it("renders the targeted read's athlete_statement text", () => {
    expect(md).toContain("I just want to keep improving every week.");
  });
  it("renders First Look themes/tone and the bio", () => {
    expect(md).toContain("training, family");
    expect(md).toContain("dog mom");
  });
  it("renders the raw value JSON block", () => {
    expect(md).toContain("```json");
    expect(md).toContain("\"identityStatement\"");
  });
  it("renders the validation table with the resolved fact", () => {
    expect(md).toContain("position: midfielder");
  });
  it("renders the comparison section with newly used kinds", () => {
    expect(md).toContain("newly used: evidence");
  });

  it("tolerates a report with nothing found anywhere (first-ever recompute, no research yet)", () => {
    const empty: IdentityRunReport = {
      athleteId: "bbbbbbbb-0000-0000-0000-000000000000",
      generatedAt: "2026-10-03T00:00:00.000Z",
      research: null,
      targetedRead: null,
      firstLook: { platforms: [], bios: [] },
      identityIntelligence: { latest: null, previous: null, comparison: null, rawValue: null },
      validation: [],
    };
    const out = renderMarkdownReport(empty);
    expect(out).toContain("No research_runs found for this athlete.");
    expect(out).toContain("No identity_intelligence ledger row found for this athlete.");
    expect(out).toContain("No previous ledger row — this is the first recompute on record.");
    expect(() => renderMarkdownReport(empty)).not.toThrow();
  });
});
