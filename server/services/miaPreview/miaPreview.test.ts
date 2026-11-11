/**
 * miaPreview.test.ts — the M.I.A. preview's pure parts: which memory facts become evaluator input and how, the
 * identity rule read from memory, the four groups, preliminary / inputs / sharpen. No database (db mocked as {}), no
 * provider. Fixtures are made-up athletes across stages and sports; nothing here is specific to anyone.
 */
jest.mock("../../db", () => ({ db: {} }));

import { Ring } from "../../../client/constants/ring";
import { blindEvalPromptV02, CANONICAL_EVALUATOR_TEXT, NO_AUTHORITATIVE_SOCIAL_DATA } from "../marketabilityBeta1EvaluatorSpec";
import {
  composeBlock, measuredAccounts, measuredMetricOf, memoryIdentityFrom, MAX_PUBLIC_FACTS, PUBLIC_FACTS_HEADING,
  renderPublicFacts, selectPreviewFacts, type PreviewFact,
} from "./memoryAdapter";
import { inputsFrom, isPreliminary, labelFor, PRELIMINARY_AWAITING_LABEL, PRELIMINARY_LABEL, sharpenFrom } from "./previewMeta";
import { groupsFrom, MIA_GROUPS } from "./preview";

let n = 0;
const fact = (p: Partial<PreviewFact>): PreviewFact => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, type: "found", status: "active", claim: "A claim.",
  subjectKind: "athlete", subjectName: "Rowan Vale", sourceUrl: "https://example.org/a", sourceRef: null, sourceTitle: "Example",
  observedOn: "2026-09-01", confidence: 0.8, sensitive: false, disputes: null, createdAt: `2026-10-0${(n % 9) + 1}T00:00:00.000Z`, ...p,
});

describe("selectPreviewFacts — what the evaluator may see", () => {
  test("public = active, non-sensitive FOUND facts, most confident first; measured = active MEASURED facts", () => {
    const hi = fact({ confidence: 0.95 }), lo = fact({ confidence: 0.4 });
    const said = fact({ type: "said", sourceUrl: null, sourceRef: "onboarding/x#name" });
    const made = fact({ type: "made", sourceUrl: null, sourceRef: "agent_runs/x" });
    const disputed = fact({ status: "disputed" }), superseded = fact({ status: "superseded" }), removed = fact({ status: "removed" });
    const sensitive = fact({ sensitive: true });
    const m = fact({ type: "measured", sourceUrl: null, sourceRef: "social_analytics_snapshots/s1#instagram.followers", confidence: 1 });
    const out = selectPreviewFacts([lo, said, made, disputed, superseded, removed, sensitive, hi, m]);
    expect(out.public.map((f) => f.id)).toEqual([hi.id, lo.id]);
    expect(out.measured.map((f) => f.id)).toEqual([m.id]);
  });

  test("sensitivity 'care' (memory_facts.sensitive) never reaches PUBLIC FACTS NOMILA FOUND; 'never' facts are never stored", () => {
    const care = fact({ claim: "Was briefly suspended last season.", sensitive: true, confidence: 0.99 });
    const plain = fact({ claim: "Won a regional final.", confidence: 0.5 });
    const block = composeBlock([], selectPreviewFacts([care, plain]).public)!;
    expect(block).toContain("Won a regional final.");
    expect(block).not.toContain("suspended");
  });

  test("capped, and the order is stable for equal confidence (the digest only moves when the facts do)", () => {
    const many = Array.from({ length: MAX_PUBLIC_FACTS + 5 }, () => fact({ confidence: 0.7 }));
    const a = selectPreviewFacts(many).public.map((f) => f.id);
    const b = selectPreviewFacts([...many].reverse()).public.map((f) => f.id);
    expect(a).toHaveLength(MAX_PUBLIC_FACTS);
    expect(a).toEqual(b);
  });
});

describe("the evidence block", () => {
  test("no found or measured facts ⇒ no block at all (the prompt is exactly the legacy no-data prompt)", () => {
    expect(composeBlock([], [])).toBeNull();
    expect(renderPublicFacts([])).toBeNull();
  });

  test("public facts only ⇒ the frozen 'no authoritative data' text, then the labelled public-facts section", () => {
    const f = fact({ claim: "Named conference player of the week.\nTwice.", sourceTitle: "Conference site", observedOn: null });
    const brand = fact({ claim: "Has a partnership with a regional sports drink.", subjectKind: "brand", subjectName: "Brand Co" });
    const block = composeBlock([], [f, brand])!;
    expect(block.startsWith(NO_AUTHORITATIVE_SOCIAL_DATA)).toBe(true);
    expect(block).toContain(PUBLIC_FACTS_HEADING);
    expect(block).toContain("not authoritative platform data");
    expect(block).toContain("- Named conference player of the week. Twice. — source: Conference site https://example.org/a; undated; confidence 0.80");
    expect(block).toContain("(about brand Brand Co)");
    // Found facts never appear as authoritative accounts.
    expect(block.split(PUBLIC_FACTS_HEADING)[0]).not.toContain("connected verified");
  });

  test("the frozen rubric is untouched: the prompt is the canonical text with only name, sport and the block filled in", () => {
    const block = composeBlock([], [fact({})])!;
    const prompt = blindEvalPromptV02({ key: "k", name: "Rowan Vale", sport: "Track and field" }, block);
    const [head] = CANONICAL_EVALUATOR_TEXT.split("ATHLETE TO EVALUATE");
    expect(prompt.startsWith(head)).toBe(true);
    expect(prompt).toContain(`Sport: Track and field\n\n${block}`);
  });

  test("measured memory facts become an authoritative connected account, per platform the substrate did not cover", () => {
    const ig = fact({ type: "measured", sourceUrl: null, sourceRef: "social_analytics_snapshots/s1#instagram.followers", claim: "Instagram (@rv) has 2,140 followers.", observedOn: "2026-10-02" });
    const yt = fact({ type: "measured", sourceUrl: null, sourceRef: "social_analytics_snapshots/s2#youtube.followers", claim: "YouTube has 310 subscribers.", observedOn: "2026-10-01" });
    const accounts = measuredAccounts([ig, yt], new Map([["instagram", "rv"]]), new Set(["youtube"]));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].account).toMatchObject({ platform: "instagram", handle: "rv", source: "connected_verified", observedAt: "2026-10-02", identityConfidence: "HIGH" });
    expect(accounts[0].account.metrics).toEqual({ followers: "Instagram (@rv) has 2,140 followers." });
    const block = composeBlock(accounts.map((a) => a.account), [])!;
    expect(block).toContain("AUTHORITATIVE SOCIAL DATA");
    expect(block).toContain("- instagram @rv — source: connected verified; observed 2026-10-02");
    expect(block).toContain("- tiktok: not available (no authoritative route)");
  });

  test("measuredMetricOf reads the platform and metric from a measured source ref", () => {
    expect(measuredMetricOf("social_analytics_snapshots/abc#tiktok.avg_views_per_post")).toEqual({ platform: "tiktok", metric: "avg_views_per_post" });
    expect(measuredMetricOf("onboarding/x#name")).toBeNull();
    expect(measuredMetricOf(null)).toBeNull();
  });
});

describe("identity, from memory", () => {
  const nameAnchor = () => fact({ type: "said", sourceUrl: null, sourceRef: "onboarding/run1#name" });
  test("clear when nothing about identity is disputed", () => {
    expect(memoryIdentityFrom([nameAnchor(), fact({ status: "disputed" })], new Set()).uncertain).toBe(false);
  });
  test("uncertain when a fact disputes her own name/sport, or research's #identity record is disputed", () => {
    const anchor = nameAnchor();
    const conflicting = fact({ status: "disputed", disputes: anchor.id });
    expect(memoryIdentityFrom([anchor, conflicting], new Set())).toMatchObject({ uncertain: true, factIds: [conflicting.id] });
    const record = fact({ type: "made", status: "disputed", sourceUrl: null, sourceRef: "agent_runs/r1#identity" });
    expect(memoryIdentityFrom([record], new Set()).uncertain).toBe(true);
  });
  test("settled when she confirms it, or when it is corrected (superseded) or removed", () => {
    const record = fact({ type: "made", status: "disputed", sourceUrl: null, sourceRef: "agent_runs/r1#identity" });
    expect(memoryIdentityFrom([record], new Set([record.id])).uncertain).toBe(false);
    expect(memoryIdentityFrom([{ ...record, status: "superseded" }], new Set()).uncertain).toBe(false);
    expect(memoryIdentityFrom([{ ...record, status: "removed" }], new Set()).uncertain).toBe(false);
  });
});

describe("the four groups", () => {
  test("pinned to the ring's capitals (client/constants/ring.ts)", () => {
    expect(MIA_GROUPS.map((g) => ({ key: g.key, name: g.name, dimensions: [...g.dimensions] })))
      .toEqual(Ring.capitals.map((c) => ({ key: c.key, name: c.name, dimensions: [...c.dimensions] })));
  });
  test("sum stored contributions and weight-average stored scores; nothing invented for an absent dimension", () => {
    const dim = (key: string, score: number | null, weight: number | null, contribution: number | null) => ({ key, score, weight, contribution, state: score == null ? "unknown" : "strength" }) as any;
    const groups = groupsFrom({ dimensions: [dim("audience_scale", 40, 0.2, 8), dim("engagement_quality", 70, 0.1, 7), dim("athletic_authority", 90, 0.15, 13.5)] });
    expect(groups.map((g) => g.key)).toEqual(["audience", "commercial", "brand", "performance"]);
    expect(groups[0]).toMatchObject({ contribution: 15, score: 50 });
    expect(groups[1]).toMatchObject({ contribution: null, score: null });
    expect(groups[3]).toMatchObject({ contribution: 13.5, score: 90 });
    expect(groupsFrom(null).every((g) => g.score === null && g.dimensions.length === 2)).toBe(true);
  });
});

describe("preliminary, inputs and sharpen", () => {
  const src = (platform: string, accountId: string, sourceClass: string) => ({ platform, accountId, observedAt: "2026-10-01", sourceClass });
  test("preliminary unless measured connected data went in", () => {
    expect(isPreliminary([src("memory", "f1", "web_researched")])).toBe(true);
    expect(isPreliminary([])).toBe(true);
    expect(isPreliminary([src("instagram", "rv", "connected_verified"), src("memory", "f1", "web_researched")])).toBe(false);
  });
  test("inputs split into public vs measured, labelled from the facts", () => {
    const facts = new Map([
      ["f1", { claim: "Won a regional title.", sourceUrl: "https://example.org/r", sourceTitle: "Results", sourceRef: null, observedOn: "2026-05-01" }],
      ["f2", { claim: "TikTok has 900 followers.", sourceUrl: null, sourceTitle: "Connected TikTok account", sourceRef: "social_analytics_snapshots/s#tiktok.followers", observedOn: "2026-10-01" }],
    ]);
    const out = inputsFrom([src("memory", "f1", "web_researched"), src("memory", "f2", "connected_verified"), src("youtube", "chan", "connected_verified"), src("memory", "gone", "web_researched")], facts);
    expect(out.public).toEqual([expect.objectContaining({ kind: "public", factId: "f1", label: "Won a regional title." })]);
    expect(out.measured.map((m) => [m.factId, m.platform])).toEqual([["f2", "tiktok"], [null, "youtube"]]);
  });
  test("sharpen: connect each social account with no measured data; wait for one connected but unread; then the evaluator's gaps", () => {
    const s = sharpenFrom(new Set(["youtube"]), new Set(["tiktok", "gmail"]), ["a", "b", "c", "d"]);
    expect(s).toEqual([
      { kind: "connect", connector: "instagram", service: "Instagram", reason: "measured_audience" },
      { kind: "awaiting_data", connector: "tiktok", service: "TikTok", reason: "connected_not_yet_read" },
      { kind: "evidence", connector: null, text: "a" }, { kind: "evidence", connector: null, text: "b" }, { kind: "evidence", connector: null, text: "c" },
    ]);
    expect(labelFor(true, s)).toBe(PRELIMINARY_LABEL);
    expect(labelFor(true, [{ kind: "awaiting_data", connector: "tiktok", service: "TikTok", reason: "connected_not_yet_read" }])).toBe(PRELIMINARY_AWAITING_LABEL);
    expect(labelFor(false, s)).toBeNull();
  });
});
