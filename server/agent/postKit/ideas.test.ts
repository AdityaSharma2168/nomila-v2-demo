/**
 * ideas.test.ts — the reverse direction (agent/postKit/ideas.ts): new, unused media → post ideas in the idea bank, on
 * the in-memory store and library port, with a fake Gemini client (no provider, no database).
 *
 *   I1 nothing new or nothing usable: no call
 *   I2 ideas written in the design's shape (memory_decisions kind other, detail.kind idea): time-bound to an open moment
 *      (expiresOn = its date) or evergreen; the assets are the evidence; status new
 *   I3 the answer checked: only refs it was shown, each asset in one idea, a valid format, the athlete's own platform,
 *      no never-content, at most IDEAS_MAX_PER_PASS
 *   I4 an asset behind an idea, or in a kit, is not offered again; the same day's pass reuses its run and writes nothing
 *   I5 the sweep is a no-op while AGENT_POST_KITS is off
 *   I6 the content pillars (idea bank, build step 8): shown from the Brief; an evergreen idea takes the
 *      pillar the model named (key and name), a timely one never does, an unknown ref is no pillar; a retried pass reads
 *      the pillars its own run was shown
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { IdeaBankEntry } from "../../../shared/postKit";
import type { CastableRow } from "../../studio/agent/cast";
import { setGeminiClient } from "../geminiProvider";
import { createMemoryStore, type AgentStore } from "../research/store";
import { IDEAS_SKILL_ID, POST_KIT } from "./config";
import { lastPass, parseIdeas, platformsFor, runPostIdeas, sweepPostIdeas, type IdeasDeps } from "./ideas";
import { momentOf } from "./kit";
import { fakeGemini, fakeMedia, refsWith, row } from "./testRows";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00Z");

let store: AgentStore;
let library: Map<string, CastableRow[]>;
let prefs: Array<{ kind: string; statement: string; status: string }>;

const deps = (): IdeasDeps => ({
  store, media: fakeMedia(library).media, preferences: async () => prefs as never, now: NOW,
  connected: async () => [{ id: "tiktok", lastReadAt: null }, { id: "gmail", lastReadAt: null }],
});
const ideaRows = () => store.listDecisions(A, { kinds: ["other"], skillId: IDEAS_SKILL_ID });

const idea = (refs: string[], over: Record<string, unknown> = {}) => ({
  asset_refs: refs, moment_ref: "", hook: "A strong hook.", format: "reel", platform: "tiktok", timing: "this week",
  show: "the sprint, then the finish", caption_angle: "the work", avoid: "anything staged", media_needs: "an action clip", ...over,
});

beforeEach(() => { store = createMemoryStore(); library = new Map(); prefs = []; });
afterEach(() => { setGeminiClient(null); delete process.env.AGENT_POST_KITS; });

describe("I1: nothing to look at", () => {
  it("no media, or only media that can't be used: no call", async () => {
    const calls = fakeGemini(() => { throw new Error("must not be called"); });
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null })).toEqual({ status: "nothing_new" });
    library.set(A, [row({ provenance: "made-here" }), row({ vision: { brand_safe: false } }), row({ vision: null })]);
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null })).toEqual({ status: "nothing_new" });
    expect(calls).toHaveLength(0);
  });
});

describe("I2: ideas in the design's shape", () => {
  it("one bound to an open moment, one evergreen; the assets are the evidence", async () => {
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Season opener" }, claim: "The opener.", type: "found", source: { url: "https://example.org/s" }, date: "2026-10-20", confidence: 0.9, runId: null }]);
    const moment = await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Season opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }], detail: { kind: "moment", idea: { hook: "Ten days out." }, mediaNeeds: "a calm portrait" } });
    // A past moment is not open.
    const [old] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Old final" }, claim: "Done.", type: "found", source: { url: "https://example.org/o" }, date: "2026-09-01", confidence: 0.9, runId: null }]);
    await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Old final", why: "w", evidence: [{ kind: "fact", factId: old.id }], detail: { kind: "moment" } });

    const portrait = row({ vision: { description: "a calm portrait of the athlete" } });
    const sprint = row({ vision: { description: "the athlete sprinting" } });
    library.set(A, [portrait, sprint]);
    const calls = fakeGemini((input) => ({ ideas: [
      idea(refsWith(input.assets, "calm portrait"), { moment_ref: "M1", format: "feed", platform: "instagram" }),
      idea(refsWith(input.assets, "sprinting")),
    ] }));

    const out = await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:2026-10-11" });
    expect(out).toMatchObject({ status: "proposed", ideas: 2, costMicroUsd: 4800 });
    expect(calls[0].skillId).toBe(IDEAS_SKILL_ID);
    expect(calls[0].input.moments).toEqual([{ ref: "M1", name: "Season opener", date: "2026-10-20", hook: "Ten days out.", angle: null, media_needs: "a calm portrait" }]);
    expect(calls[0].input.platforms).toEqual(["tiktok"]);
    expect(calls[0].input.pillars).toEqual([]);                                  // no Brief pillars here: none
    expect(calls[0].input.max_ideas).toBe(POST_KIT.IDEAS_MAX_PER_PASS);

    const rows = await ideaRows();
    expect(rows.map((d) => [d.kind, d.response, d.suggested])).toEqual([["other", "pending", "A strong hook."], ["other", "pending", "A strong hook."]]);
    const [bound, evergreen] = rows.map((d) => d.detail as unknown as IdeaBankEntry);
    expect(bound).toEqual({
      kind: "idea", timeBound: true, pillarKey: null, pillarName: null, momentDecisionId: moment.id, expiresOn: "2026-10-20",
      // Not one of the athlete's platforms: the first of theirs instead.
      idea: { hook: "A strong hook.", format: "feed", platform: "tiktok", timing: "this week" },
      brief: { show: "the sprint, then the finish", captionAngle: "the work", avoid: "anything staged" }, mediaNeeds: "an action clip",
      status: "new", usedInDecisionId: null, adaptedFromIdeaId: null,
    });
    expect(evergreen).toMatchObject({ timeBound: false, momentDecisionId: null, expiresOn: null, pillarKey: null, status: "new" });
    expect(rows[0].evidence).toEqual([{ kind: "record", table: "media_assets", id: portrait.id }]);
    expect(rows[1].evidence).toEqual([{ kind: "record", table: "media_assets", id: sprint.id }]);
    expect(rows[0].why).toBe("Fits Season opener (2026-10-20).");
  });

  it("a month-only moment stays open through its month (mid-month), a past month does not", async () => {
    const [oct, sep] = await store.insertFacts(A, [
      { subject: { kind: "event", name: "Rivalry month" }, claim: "October is rivalry month.", type: "found", source: { url: "https://example.org/r" }, date: "2026-10-01", datePrecision: "month", confidence: 0.9, runId: null },
      { subject: { kind: "event", name: "September cup" }, claim: "The September cup.", type: "found", source: { url: "https://example.org/c" }, date: "2026-09-01", datePrecision: "month", confidence: 0.9, runId: null },
    ]);
    for (const f of [oct, sep]) await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: f.subject.name, why: "w", evidence: [{ kind: "fact", factId: f.id }], detail: { kind: "moment", idea: { hook: "h" } } });
    library.set(A, [row({ vision: { description: "a calm portrait of the athlete" } })]);
    const calls = fakeGemini(() => ({ ideas: [] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null });
    expect(calls[0].input.moments.map((m: { name: string }) => m.name)).toEqual(["Rivalry month"]);
  });
});

describe("I3: the answer checked", () => {
  const a1 = row(); const a2 = row(); const a3 = row();
  const assets = new Map([["A1", a1], ["A2", a2], ["A3", a3]]);
  const moment = momentOf("m1", { kind: "moment" }, null)!;

  it("drops unknown refs, repeats, bad formats, empty hooks and never-content; caps the count", () => {
    const out = parseIdeas({ ideas: [
      idea(["A9"]),                                     // no such asset
      idea(["A1"], { format: "billboard" }),            // not a format
      idea(["A1"], { hook: "" }),                       // no hook
      idea(["A1"], { show: "with Pat Private" }),       // never-use name
      idea(["A1", "A1", "A2"], { moment_ref: "M7" }),   // kept: A1 once, A2; no such moment → evergreen
      idea(["A2", "A3"]),                               // kept: A3 only (A2 is taken)
      idea(["A3"]),                                     // A3 taken: dropped
    ] }, assets, new Map([["M1", moment]]), ["instagram"], ["Pat Private"]);
    expect(out.map((o) => o.assets.map((a) => a.id))).toEqual([[a1.id, a2.id], [a3.id]]);
    expect(out[0].entry).toMatchObject({ timeBound: false, momentDecisionId: null });
    expect(parseIdeas({ ideas: [idea(["A1"]), idea(["A2"]), idea(["A3"]), idea(["A1"])] }, new Map([...assets, ["A4", row()]]), new Map(), ["instagram"], []).length)
      .toBeLessThanOrEqual(POST_KIT.IDEAS_MAX_PER_PASS);
    expect(parseIdeas("nonsense", assets, new Map(), ["instagram"], [])).toEqual([]);
  });

  it("platforms: the athlete's connected social accounts, else every social connector — never an inbox", () => {
    expect(platformsFor([{ id: "gmail" }, { id: "youtube" }])).toEqual(["youtube"]);
    expect(platformsFor([{ id: "gmail" }])).toEqual(["instagram", "tiktok", "youtube"]);
  });
});

describe("I4: not offered twice", () => {
  it("an asset behind an idea is not offered again; the same day's pass reuses its run and writes nothing", async () => {
    const a = row({ vision: { description: "shot a" } });
    library.set(A, [a]);
    const calls = fakeGemini((input) => ({ ideas: [idea(refsWith(input.assets, "shot a"))] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:2026-10-11" });
    expect(await ideaRows()).toHaveLength(1);
    // The same day again: the finished run is the answer; its idea is already written.
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:2026-10-11" })).toMatchObject({ status: "proposed", ideas: 0, costMicroUsd: 0 });
    // Another pass with nothing tagged since the cursor: nothing new, no call.
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null })).toEqual({ status: "nothing_new" });
    const b = row({ vision: { description: "shot b" } });
    library.set(A, [a, b]);
    // Same day, new media: the finished run is reused (never paid twice) and nothing is written again.
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:2026-10-11" })).toMatchObject({ status: "proposed", ideas: 0, costMicroUsd: 0 });
    expect(calls).toHaveLength(1);
    expect(await ideaRows()).toHaveLength(1);
    // The next day: only the new asset is offered.
    const next = fakeGemini((input) => ({ ideas: [idea(refsWith(input.assets, "shot b"))] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:2026-10-12" });
    expect(next[0].input.assets.map((x: any) => x.description)).toEqual(["shot b"]);
  });

  it("a retried pass writes the ideas missing for its run, read against what THAT run was shown", async () => {
    const a = row({ vision: { description: "shot a" } });
    const b = row({ vision: { description: "shot b" } });
    library.set(A, [a, b]);
    const calls = fakeGemini((input) => ({ ideas: [idea(refsWith(input.assets, "shot a")), idea(refsWith(input.assets, "shot b"))] }));
    // The first attempt dies after the model answered and one idea was written.
    const real = store;
    let inserts = 0;
    store = { ...real, insertDecision: async (...args: Parameters<AgentStore["insertDecision"]>) => { if (++inserts === 2) throw new Error("connection lost"); return real.insertDecision(...args); } };
    await expect(runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:r" })).rejects.toThrow(/connection lost/);
    store = real;
    expect(await ideaRows()).toHaveLength(1);
    // The library's order changed meanwhile: the refs still mean what the run was shown, in its order.
    library.set(A, [b, a]);
    const again = await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:r" });
    expect(again).toMatchObject({ status: "proposed", ideas: 1, costMicroUsd: 0 });
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:r" })).toMatchObject({ ideas: 0 });
    expect(calls).toHaveLength(1);
    expect((await ideaRows()).map((d) => d.evidence[0])).toEqual([{ kind: "record", table: "media_assets", id: a.id }, { kind: "record", table: "media_assets", id: b.id }]);
  });

  it("a backlog is paged, never dropped: each pass takes the oldest IDEAS_MAX_ASSETS and the next pass the rest", async () => {
    const backlog = Array.from({ length: POST_KIT.IDEAS_MAX_ASSETS + 5 }, (_, i) => row({ vision: { description: `backlog shot ${i}` } }));
    library.set(A, backlog);
    const seen: string[][] = [];
    fakeGemini((input) => { seen.push(input.assets.map((x: any) => x.description)); return { ideas: [] }; });
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:p1" });
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:p2" });
    expect(seen[0]).toEqual(backlog.slice(0, POST_KIT.IDEAS_MAX_ASSETS).map((_, i) => `backlog shot ${i}`));
    expect(seen[1]).toEqual(backlog.slice(POST_KIT.IDEAS_MAX_ASSETS).map((_, i) => `backlog shot ${POST_KIT.IDEAS_MAX_ASSETS + i}`));
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:p3" })).toEqual({ status: "nothing_new" });
  });

  it("new media that can't be used: no call, but a zero-cost checked run moves the cursor past it", async () => {
    library.set(A, [row({ provenance: "made-here" }), row({ vision: { brand_safe: false } })]);
    const calls = fakeGemini(() => { throw new Error("must not be called"); });
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null })).toEqual({ status: "nothing_new" });
    const runs = await store.listRunsSince(A, { since: new Date(0).toISOString(), skillId: IDEAS_SKILL_ID });
    expect(runs.map((r) => [r.status, r.cost.microUsd, (r.output as any).status, (r.output as any).looked])).toEqual([["completed", 0, "nothing_new", 2]]);
    expect(await lastPass(store, A, NOW)).toMatchObject({ cursor: { id: library.get(A)![1].id } });
    // The next pass has nothing new to read at all.
    expect(await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null })).toEqual({ status: "nothing_new" });
    expect(await store.listRunsSince(A, { since: new Date(0).toISOString(), skillId: IDEAS_SKILL_ID })).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe("I5: the sweep", () => {
  it("is a no-op while AGENT_POST_KITS is off", async () => {
    expect(await sweepPostIdeas(deps())).toEqual({ enabled: false, checked: 0, proposed: 0, ideas: 0, skipped: {}, failed: 0 });
  });
});

describe("I6: content pillars", () => {
  const brief = async () => store.writeBrief(A, {
    summary: "s", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null,
    display: {
      stage: { label: "l", band: "developing", confidence: 0.8, why: "w", factIds: [] },
      positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] },
      contentPillars: [
        { key: "P1", name: "Training and the work", whyThisAthlete: "w", factIds: ["f1"] },
        { key: "P2", name: "Race days", whyThisAthlete: "w", factIds: ["f2"] },
      ],
    },
  });

  it("with the idea bank on: an evergreen idea takes the pillar named; a timely one and an unknown ref take none", async () => {
    await brief();
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Season opener" }, claim: "The opener.", type: "found", source: { url: "https://example.org/s" }, date: "2026-10-20", confidence: 0.9, runId: null }]);
    await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Season opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }], detail: { kind: "moment", idea: { hook: "Ten days out." } } });
    library.set(A, [row({ vision: { description: "shot a" } }), row({ vision: { description: "shot b" } }), row({ vision: { description: "shot c" } })]);
    const calls = fakeGemini((input) => ({ ideas: [
      idea(refsWith(input.assets, "shot a"), { pillar_ref: "P2" }),
      idea(refsWith(input.assets, "shot b"), { moment_ref: "M1", pillar_ref: "P1" }),
      idea(refsWith(input.assets, "shot c"), { pillar_ref: "P9" }),
    ] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:pillars" });
    expect(calls[0].input.pillars).toEqual([{ ref: "P1", name: "Training and the work" }, { ref: "P2", name: "Race days" }]);
    const entries = (await ideaRows()).map((d) => d.detail as unknown as IdeaBankEntry);
    expect(entries.map((e) => [e.timeBound, e.pillarKey, e.pillarName])).toEqual([[false, "P2", "Race days"], [true, null, null], [false, null, null]]);
  });

  it("a retried pass reads the pillars its own run was shown, not the Brief's current ones", async () => {
    await brief();
    library.set(A, [row({ vision: { description: "shot a" } }), row({ vision: { description: "shot b" } })]);
    const calls = fakeGemini((input) => ({ ideas: [idea(refsWith(input.assets, "shot a"), { pillar_ref: "P2" }), idea(refsWith(input.assets, "shot b"), { pillar_ref: "P1" })] }));
    const real = store;
    let inserts = 0;
    store = { ...real, insertDecision: async (...args: Parameters<AgentStore["insertDecision"]>) => { if (++inserts === 2) throw new Error("connection lost"); return real.insertDecision(...args); } };
    await expect(runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:r6" })).rejects.toThrow(/connection lost/);
    store = real;
    // A new Brief renumbers its pillars meanwhile: the retried pass still files what its run was shown.
    await store.writeBrief(A, {
      summary: "s2", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null,
      display: { stage: { label: "l", band: "developing", confidence: 0.8, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] }, contentPillars: [{ key: "P1", name: "Something new", whyThisAthlete: "w", factIds: [] }] },
    });
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: "post-ideas:r6" });
    expect(calls).toHaveLength(1);
    expect((await ideaRows()).map((d) => (d.detail as unknown as IdeaBankEntry).pillarName)).toEqual(["Race days", "Training and the work"]);
  });
});

describe("I7: her guardrails reach the ideas skill (post-kit/ideas 1.2.0)", () => {
  it("the input carries her avoid-list, never-use names, current partners and the Brief's conflicts — the plan's own sources", async () => {
    prefs = [
      { kind: "avoid", statement: "Never use: Wrenna", status: "active" },
      { kind: "avoid", statement: "No energy-drink brands", status: "active" },
      { kind: "avoid", statement: "Retired rule", status: "retired" },
      { kind: "voice", statement: "Short captions", status: "active" },
    ];
    await store.writeBrief(A, {
      summary: "s", sections: [], factIds: [], runId: null,
      internal: { currentSponsors: [{ name: "Acme Hydration", factIds: [] }], pastSponsors: [], exclusivityConflicts: [{ what: "Acme holds the sports drink category.", blocks: ["other sports drinks"], factIds: [] }] },
      display: { stage: { label: "l", band: "developing", confidence: 0.8, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] } },
    });
    library.set(A, [row({ vision: { description: "the athlete sprinting" } })]);
    const calls = fakeGemini(() => ({ ideas: [] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      avoid: ["No energy-drink brands"],
      never_use: ["Wrenna"],
      partners: ["Acme Hydration"],
      conflicts: [{ what: "Acme holds the sports drink category.", blocks: ["other sports drinks"] }],
    });
  });

  it("with no Brief and no preferences the guardrails are present and empty", async () => {
    library.set(A, [row({ vision: { description: "the athlete sprinting" } })]);
    const calls = fakeGemini(() => ({ ideas: [] }));
    await runPostIdeas(deps(), A, { trigger: "schedule", parentRef: null });
    expect(calls[0].input).toMatchObject({ avoid: [], never_use: [], partners: [], conflicts: [] });
  });
});
