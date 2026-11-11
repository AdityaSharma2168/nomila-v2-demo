/**
 * research.test.ts — the Research skill's plumbing and safety, on the in-memory store with the model mocked.
 *
 *   R1 a pass keeps only facts whose URL its searches saw (a seen host → lower confidence; anything else dropped)
 *   R2 the merge keeps ONE fact per claim with every source, and both-pass facts keep their confidence
 *   R3 a fact that conflicts with what we hold is written disputed, and the other one too — unless the athlete said it
 *   R4 a duplicate of an existing fact is not written twice; sensitive is carried through
 *   R5 a retried step reuses the finished run: no second model call, no second cost
 *   R6 the cost cap refuses a call at or over the cap
 *   R7 measured facts come from connected data (code), and a newer reading supersedes the older one
 *   R8 the request: native web_search, sources included, strict JSON schema, prompt-cache key without athlete data
 *   R16 (1.8.0) her own connected posts that name a partner reach research and merge; a post-only partnership is stored
 *   R17 (1.8.0) a team, school or club's sponsor is the organization's fact; a sponsor claim must say whose it is
 *   R18 (1.8.0) inline markdown citations leave claims; a junk image URL is no source unless its page was seen
 *   R19 the store layer cleans every writer's facts (claims, source and also-seen URLs)
 *   R20 (merge 1.9.0, 0119) a month- or year-only date keeps its precision; identity fields only on facts about the athlete
 */
jest.mock("../../db", () => ({ db: {} }));

import { FIXTURES, fakeResponses, passAnswer, skillOf } from "../../testUtils/agentModel";
import { setResponsesTransport } from "./llm";
import { checkSource, claimNamesAthlete, mergePasses, POST_MAX_CONFIDENCE, postSource, searchPass, syncMeasured, type JobContext } from "./research";
import { CostCapError } from "./runSkill";
import { createMemoryStore } from "./store";
import { captionMentions, connectedSummaryText, measuredFactsFrom, PARTNER_POSTS_HEADING, partnerPosts, type ConnectedChannel } from "./connected";

afterEach(() => setResponsesTransport(null));

const athleteId = "00000000-0000-4000-8000-000000000001";

function ctx(store = createMemoryStore(), budget?: JobContext["budget"]): JobContext {
  return { store, athleteId, parentPrefix: "workflow:test-run", budget, today: "2026-10-09" };
}

test("R1: unseen URLs are dropped; a seen host is kept at lower confidence", async () => {
  const f = FIXTURES.college;
  const ans = passAnswer(f, {
    extra: [
      { subject_kind: "athlete", subject_name: f.name, claim: "Invented claim.", topic: "other", source_url: "https://never-seen.example.net/x", source_title: "x", date: "", confidence: 0.9, sensitive: false },
      { subject_kind: "athlete", subject_name: f.name, claim: "Same host, other page.", topic: "media", source_url: "https://www.example-swim-news.com/other-page", source_title: "y", date: "2026", confidence: 1, sensitive: false },
    ],
  });
  setResponsesTransport(fakeResponses(() => ans));
  const r = await searchPass(ctx(), { pass: "a", athlete: { name: f.name, sport: f.sport }, connectedSummary: "No accounts connected yet.", existing: [] });
  expect(r.facts.map((x) => x.claim)).not.toContain("Invented claim.");
  expect(r.dropped).toEqual([{ claim: "Invented claim.", reason: "source not seen by this pass" }]);
  expect(r.facts.find((x) => x.claim === "Same host, other page.")!.confidence).toBe(0.8);
  // The tracking parameter the search tool appends does not make a seen page "unseen".
  expect(r.facts.filter((x) => x.confidence === 0.9)).toHaveLength(f.pages.length);
  expect(checkSource("not a url", [{ url: "https://a.example" }]).ok).toBe(false);
});

test("R2–R4: merge de-duplicates, keeps every source, marks conflicts disputed (not overwritten), skips duplicates", async () => {
  const f = FIXTURES.pro;
  const store = createMemoryStore();
  // What we already hold: one fact the athlete said, one found fact, one that the merge says is a duplicate.
  const [said, found, dup] = await store.insertFacts(athleteId, [
    { subject: { kind: "athlete", name: f.name }, claim: `${f.name} plays for a club in another city.`, type: "said", source: { ref: "onboarding/x#correction" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: f.name }, claim: `${f.name} was an all-star in 2025.`, type: "found", source: { url: "https://old.example.org/a" }, date: "2025-02-01", confidence: 0.7, runId: null },
    { subject: { kind: "athlete", name: f.name }, claim: `${f.name} signed a footwear endorsement in 2024.`, type: "found", source: { url: "https://old.example.org/b" }, date: "2024-03-01", confidence: 0.9, runId: null },
  ]);
  const transport = fakeResponses((body) => {
    const skill = skillOf(body);
    if (skill === "research") return passAnswer(f);
    // research/merge: a1+b1 are the same club fact (conflicts with what the athlete SAID), a3+b3 the all-star fact
    // (conflicts with the found e2), a2 duplicates e3, and the family-style detail stays sensitive.
    expect(body.input).toContain("e1 | said");
    return {
      json: {
        facts: [
          { from: ["a1", "b1"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[0].claim, topic: "team", date: "2026-10", confidence: 0.95, sensitive: false, conflicts_with: "e1", duplicate_of: "", note: "club differs" },
          { from: ["a3", "b3"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[2].claim, topic: "achievement", date: "2026-02-10", confidence: 0.9, sensitive: false, conflicts_with: "e2", duplicate_of: "", note: "year differs" },
          { from: ["a2"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[1].claim, topic: "sponsor", date: "2024-03-01", confidence: 0.9, sensitive: false, conflicts_with: "", duplicate_of: "e3", note: "" },
          { from: ["zz9"], subject_kind: "athlete", subject_name: f.name, claim: "No pass fact behind me.", topic: "other", date: "", confidence: 0.9, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" },
        ],
        dropped: [], narrative: "Merged.",
      },
    };
  });
  setResponsesTransport(transport);
  const c = ctx(store);
  const existing = await store.listFacts(athleteId);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing });
  const m = await mergePasses(c, { athlete: f, a, b, existing });

  expect(m.inserted.map((x) => x.claim)).toEqual([f.pages[0].claim, f.pages[2].claim]);
  expect(m.duplicates).toBe(1);
  expect(m.dropped.some((d) => d.reason.includes("no pass fact"))).toBe(true);
  const club = m.inserted[0];
  expect(club.status).toBe("disputed");
  expect(club.disputes).toBe(said.id);
  expect(club.source.url).toBe(f.pages[0].url);                // one fact …
  expect(club.alsoSeenAt).toEqual([]);                          // … both passes cited the same page
  const after = new Map((await store.listFacts(athleteId)).map((x) => [x.id, x]));
  expect(after.get(said.id)!.status).toBe("active");            // what the athlete said is never demoted
  expect(after.get(found.id)!.status).toBe("disputed");         // a found fact in conflict is disputed, not overwritten
  expect(after.get(found.id)!.claim).toBe(`${f.name} was an all-star in 2025.`);
  expect(after.get(dup.id)!.status).toBe("active");
  expect(m.inserted.every((x) => x.type === "found" && !!x.source.url && x.runId === m.runId)).toBe(true);
});

test("R2: merged facts keep every distinct source; private facts are never stored; a single-pass fact never gains confidence", async () => {
  const f = FIXTURES.youth;
  const store = createMemoryStore();
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") {
      // Pass B saw the roster fact on a second page.
      const p = passAnswer(f);
      if (String(body.input).includes("PASS B")) {
        (p.json as any).facts[0].source_url = "https://www.example-local-news.com/sports/roster-story";
        p.sources!.push({ url: "https://www.example-local-news.com/sports/roster-story" });
      }
      return p;
    }
    return { json: { facts: [
      { from: ["a1", "b1"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[0].claim, topic: "team", date: "2026-09", confidence: 0.99, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" },
      { from: ["a2"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[1].claim, topic: "achievement", date: "2025-11-20", confidence: 0.99, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" },
      // The private detail never reached the merge (dropped at the pass): a3 has no pass fact behind it.
      { from: ["a3"], subject_kind: "person", subject_name: "sibling", claim: f.pages[2].claim, topic: "other", date: "2025-06-01", confidence: 0.99, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" },
    ], dropped: [], narrative: "" } };
  }));
  const c = ctx(store);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  const m = await mergePasses(c, { athlete: f, a, b, existing: [] });
  expect(m.inserted[0].source.url).toBe(f.pages[0].url);
  expect(m.inserted[0].alsoSeenAt).toEqual([{ url: "https://www.example-local-news.com/sports/roster-story", title: "Varsity roster" }]);
  expect(m.inserted[0].confidence).toBe(0.99);                  // both passes found it
  expect(m.inserted[1].confidence).toBe(0.9);                   // one pass at 0.9 → never above that
  expect(m.inserted).toHaveLength(2);
  const all = JSON.stringify((store as any).dump());
  expect(all).not.toContain("younger sibling");                 // not in facts, not in any run's stored output
  const passRun = (store as any).dump().runs.find((r: any) => r.id === a.runId);
  expect(passRun.steps.find((x: any) => x.type === "policy")).toMatchObject({ rule: "family_privacy", decision: "deny", reason: expect.stringMatching(/^dropped 1 private/) });
});

test("R5: a retried step reuses the finished run — no second model call, no second cost", async () => {
  const f = FIXTURES.college;
  const transport = fakeResponses(() => passAnswer(f));
  setResponsesTransport(transport);
  const c = ctx();
  const first = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const again = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  expect(transport.calls).toHaveLength(1);
  expect(again.runId).toBe(first.runId);
  expect(again.facts).toEqual(first.facts);
  expect(first.costMicroUsd).toBeGreaterThan(0);
  expect(again.costMicroUsd).toBe(0);
});

test("R6: the cost cap refuses the call", async () => {
  const transport = fakeResponses(() => passAnswer(FIXTURES.pro));
  setResponsesTransport(transport);
  await expect(searchPass(ctx(createMemoryStore(), { spentMicroUsd: 2_000_000, capMicroUsd: 2_000_000 }), { pass: "a", athlete: FIXTURES.pro, connectedSummary: "", existing: [] }))
    .rejects.toBeInstanceOf(CostCapError);
  expect(transport.calls).toHaveLength(0);
});

test("R7: measured facts from connected data; a newer reading supersedes the older one", async () => {
  const store = createMemoryStore();
  const channel = (followers: number, asOf: string, id: string): ConnectedChannel => ({
    platform: "instagram", snapshotId: id, asOf, handle: "made_up_handle", followers, postCount: 40, avgEngagementRate: 4.2,
    avgReachPerPost: null, avgViewsPerPost: null, postsLast30d: 6, totalLikes: null, totalChannelViews: null,
    audience: { age: ["18-24 41%", "25-34 30%"] }, recentPosts: [],
  });
  const first = measuredFactsFrom([channel(1200, "2026-10-01", "s1")], "Jordan Vale");
  expect(first.every((f) => f.type === "measured" && f.source.ref?.startsWith("social_analytics_snapshots/s1#instagram.") && f.confidence === 1)).toBe(true);
  // Every metric is new the first time: each counts as "moved" (the plan step's measured-data trigger).
  expect(await syncMeasured(store, athleteId, first)).toEqual({ inserted: first.length, superseded: 0, moved: first.length });
  expect(await syncMeasured(store, athleteId, first)).toEqual({ inserted: 0, superseded: 0, moved: 0 });   // same reading: no-op
  const second = measuredFactsFrom([channel(1350, "2026-10-08", "s2")], "Jordan Vale");
  const r = await syncMeasured(store, athleteId, second);
  expect(r.inserted).toBe(second.length);                      // every metric re-read on a new day
  expect(r.moved).toBe(1);                                     // followers 1,200 → 1,350 (+12.5%); the rest did not move ≥ 10%
  const active = (await store.listFacts(athleteId, ["active"])).filter((f) => f.type === "measured");
  expect(active.find((f) => f.source.ref!.endsWith("#instagram.followers"))!.claim).toContain("1,350");
  const old = (await store.listFacts(athleteId, ["superseded"])).find((f) => f.claim.includes("1,200"))!;
  expect(old.supersededBy).toBeTruthy();
});

test("R8: the request uses native web_search, asks for sources, a strict schema, and caches on the skill only", async () => {
  const f = FIXTURES.pro;
  const transport = fakeResponses(() => passAnswer(f));
  setResponsesTransport(transport);
  await searchPass(ctx(), { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  const body = transport.calls[0];
  expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
  expect(body.include).toEqual(["web_search_call.action.sources"]);
  expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "research_pass" });
  expect(body.reasoning.effort).toBe("high");
  expect(body.store).toBe(false);
  expect(body.prompt_cache_key).toBe("nomila:research@1.12.0");
  expect(body.prompt_cache_key).not.toContain(f.name);
  // The procedure is the stable prefix (instructions); the athlete is only in the input.
  expect(body.instructions).not.toContain(f.name);
  expect(body.input).toContain(f.name);
});

test("R9: caps are enforced in code and schema — 30 facts per pass, 10 searches", async () => {
  const f = FIXTURES.pro;
  const many = Array.from({ length: 35 }, (_, n) => ({ subject_kind: "athlete", subject_name: f.name, claim: `Fact number ${n + 1}.`, topic: "other", source_url: f.pages[0].url, source_title: "t", date: "2026", confidence: 0.9, sensitive: false }));
  const t = fakeResponses(() => ({ sources: [{ url: f.pages[0].url }], json: { identity: { resolved: true, description: "", ambiguity: "" }, facts: many, gaps: [], narrative: "" } }));
  setResponsesTransport(t);
  const store = createMemoryStore();
  const r = await searchPass(ctx(store), { pass: "a", athlete: f, connectedSummary: "", existing: [], maxSearches: 50 });
  expect(r.facts).toHaveLength(30);
  expect(t.calls[0].max_tool_calls).toBe(10);                    // a caller cannot raise it
  expect(t.calls[0].text.format.schema.properties.facts.maxItems).toBe(30);
  const run = (store as any).dump().runs[0];
  expect(run.output.json.facts).toHaveLength(30);                // the stored output is capped too
  expect(run.steps.some((x: any) => x.type === "policy" && /5 more not stored/.test(x.reason))).toBe(true);
});

test("R11: two athletes with the same name — the merge (medium effort) keeps them apart; the other person is not stored", async () => {
  const f = FIXTURES.college;
  const other = { url: "https://www.example-track-news.com/natarajan-marathon", title: "Marathon result", claim: `${f.name} won a city marathon in 2025.` };
  const store = createMemoryStore();
  const t = fakeResponses((body) => {
    if (skillOf(body) === "research") {
      const p = passAnswer(f);
      // Pass B also found a same-name runner (a different sport) and said so.
      if (String(body.input).includes("PASS B")) {
        (p.json as any).identity.ambiguity = `Another ${f.name} is a distance runner.`;
        (p.json as any).facts.push({ subject_kind: "athlete", subject_name: f.name, claim: other.claim, topic: "achievement", source_url: other.url, source_title: other.title, date: "2025", confidence: 0.6, sensitive: false });
        p.sources!.push({ url: other.url });
      }
      return p;
    }
    expect(body.reasoning.effort).toBe("medium");
    expect(String(body.instructions)).toMatch(/Same name, different person/);
    expect(String(body.input)).toContain(`ambiguity: Another ${f.name} is a distance runner.`);
    const runner = String(body.input).split("\n").find((l) => l.includes("city marathon"))!.split(" | ")[0];
    return { json: {
      facts: [{ from: ["a1", "b1"], subject_kind: "athlete", subject_name: f.name, claim: f.pages[0].claim, topic: "team", date: "2026-09", confidence: 0.95, sensitive: false, conflicts_with: "", duplicate_of: "", note: "" }],
      dropped: [{ key: runner, reason: "different person" }], narrative: "Kept the swimmer; a same-name runner was dropped.",
    } };
  });
  setResponsesTransport(t);
  const c = ctx(store);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  const m = await mergePasses(c, { athlete: f, a, b, existing: [] });
  expect(m.dropped).toEqual([{ key: expect.stringMatching(/^b\d+$/), reason: "different person" }]);
  const facts = await store.listFacts(athleteId);
  expect(facts.map((x) => x.claim)).toEqual([f.pages[0].claim]);
  expect(facts.some((x) => x.claim.includes("marathon"))).toBe(false);
});

test("R10: code catches private FORMATS only — strict emails, phones and street addresses", async () => {
  const { privateFormats } = await import("./privacy");
  expect(privateFormats("Reach the athlete at someone@example.com.")).toEqual(["contact"]);
  expect(privateFormats("Call +1 (555) 010-2030 for bookings.")).toEqual(["contact"]);
  expect(privateFormats("Call 555-010-2030.")).toEqual(["contact"]);
  expect(privateFormats("Call +44 20 7946 0958.")).toEqual(["contact"]);
  expect(privateFormats("The athlete lives at 12 Example Street.")).toEqual(["address"]);
  expect(privateFormats("Office: 450 West Oak Ave, Suite 2.")).toEqual(["address"]);
});

test("R12: no false positives — causes, advocacy, injuries, date ranges and stat runs are kept", async () => {
  const { privateFormats, dropReason } = await import("./privacy");
  const keep = [
    "The athlete is an ambassador for a mental health charity.",
    "The athlete supports a cancer research foundation.",
    "The athlete missed six weeks with a hamstring injury in 2025.",
    "Played for the club 2019 - 2023.",
    "Seasons 2015-2016-2017 brought three titles.",
    "Scored 15 goals in 17 appearances (2022), 123 goals in 224 caps.",
    "Times: 1:52.31, 1:53.04, 1:54.10 across 2024–2026.",
    "Ranked 2 among 1,234 players in 2024.",
    "Won at the 2026 meet, lane 4 of 8.",
  ];
  for (const claim of keep) {
    expect({ claim, formats: privateFormats(claim) }).toEqual({ claim, formats: [] });
    expect({ claim, drop: dropReason({ claim, sensitivity: "none", never_reason: "none" }) }).toEqual({ claim, drop: null });
  }
});

test("R13: never-store is the model's call (plus code formats); drops are recorded by category, reason and URL — never the text", async () => {
  const f = FIXTURES.pro;
  const store = createMemoryStore();
  const p = passAnswer(f);
  (p.json as any).facts.push(
    { subject_kind: "person", subject_name: "x", claim: "A child's name the press printed.", topic: "other", source_url: f.pages[1].url, source_title: "t", date: "", confidence: 0.9, sensitivity: "never", never_reason: "child_identity" },
    { subject_kind: "athlete", subject_name: f.name, claim: "Email the athlete at private@example.com.", topic: "other", source_url: f.pages[2].url, source_title: "t", date: "", confidence: 0.9, sensitivity: "none", never_reason: "none" },
    { subject_kind: "athlete", subject_name: f.name, claim: `${f.name} is an ambassador for a mental health charity.`, topic: "cause", source_url: f.pages[0].url, source_title: "t", date: "2025", confidence: 0.9, sensitivity: "none", never_reason: "none" },
  );
  setResponsesTransport(fakeResponses(() => p));
  const r = await searchPass(ctx(store), { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  expect(r.facts.map((x) => x.claim)).toContain(`${f.name} is an ambassador for a mental health charity.`);
  const run = (store as any).dump().runs[0];
  expect(run.output.privacy_drops).toEqual([
    { category: "child_identity", reason: "the model marked it never-store", source_url: f.pages[1].url },
    { category: "contact", reason: "code found an email address or phone number", source_url: f.pages[2].url },
  ]);
  const stored = JSON.stringify(run);
  expect(stored).not.toContain("A child's name the press printed");
  expect(stored).not.toContain("private@example.com");
  expect(run.steps.find((s: any) => s.type === "policy").reason).toMatch(/dropped 2 private fact\(s\) \(child_identity 1, contact 1\)/);
});

test("R14: public, career-relevant care facts are KEPT (controversy, injury, maternity leave, public family identity); contact info is dropped", async () => {
  const f = FIXTURES.pro;
  const store = createMemoryStore();
  // care_kind (0113): conduct for the confirmed suspension; personal for the rest — one left unkinded reads as personal.
  const care = [
    { claim: `${f.name} was suspended for two games in 2025 after an on-court altercation.`, url: f.pages[0].url, kind: "conduct", want: "conduct" },
    { claim: `${f.name} is out for the season with a torn ACL (club statement, 2026).`, url: f.pages[1].url, kind: "personal", want: "personal" },
    { claim: `${f.name} is on maternity leave for the 2026 season.`, url: f.pages[2].url, kind: "none", want: "personal" },
    { claim: `${f.name} often speaks publicly about being a parent of two.`, url: f.pages[0].url, kind: "personal", want: "personal" },
  ];
  const p = passAnswer(f);
  (p.json as any).facts.push(
    ...care.map((c) => ({ subject_kind: "athlete", subject_name: f.name, claim: c.claim, topic: "other", source_url: c.url, source_title: "t", date: "2026", confidence: 0.9, sensitivity: "care", care_kind: c.kind, never_reason: "none" })),
    { subject_kind: "athlete", subject_name: f.name, claim: "Bookings: call +1 (555) 010-2030.", topic: "other", source_url: f.pages[1].url, source_title: "t", date: "", confidence: 0.9, sensitivity: "none", never_reason: "none" },
  );
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") return p;
    // The merge keeps the passes' facts as they are (A's keys), saying "care" where the pass did.
    const lines = String(body.input).split("\n").filter((l) => /^a\d+ \|/.test(l));
    return { json: { facts: lines.map((l) => ({ from: [l.split(" | ")[0]], subject_kind: "athlete", subject_name: f.name, claim: l.split(" | ")[2], topic: "other", date: "2026", confidence: 0.9, sensitivity: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "" })), dropped: [], narrative: "" } };
  }));
  const c = ctx(store);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  expect(a.facts.filter((x) => x.care).map((x) => x.claim)).toEqual(care.map((x) => x.claim));
  await mergePasses(c, { athlete: f, a, b, existing: [] });
  const stored = await store.listFacts(athleteId);
  for (const x of care) expect(stored.find((s) => s.claim === x.claim)).toMatchObject({ sensitive: true, status: "active", careKind: x.want });  // kept, marked care, with its kind
  expect(stored.filter((s) => !s.sensitive).every((s) => (s.careKind ?? null) === null)).toBe(true);
  expect(stored.some((s) => s.claim.includes("555"))).toBe(false);
  const passRun = (store as any).dump().runs.find((r: any) => r.id === a.runId);
  expect(passRun.output.privacy_drops).toEqual([{ category: "contact", reason: "code found an email address or phone number", source_url: f.pages[1].url }]);
});

test("R15: live research events — sources being read and discoveries as found, kept on the run; care and private facts never shown live", async () => {
  const f = FIXTURES.college;
  const store = createMemoryStore();
  const p = passAnswer(f);
  (p.json as any).facts.push(
    { subject_kind: "athlete", subject_name: f.name, claim: `${f.name} was briefly suspended in 2025.`, topic: "other", source_url: f.pages[0].url, source_title: "t", date: "2025", confidence: 0.9, sensitivity: "care", never_reason: "none" },
    { subject_kind: "athlete", subject_name: f.name, claim: "Contact: someone@example.com.", topic: "other", source_url: f.pages[0].url, source_title: "t", date: "", confidence: 0.9, sensitivity: "none", never_reason: "none" },
  );
  setResponsesTransport(fakeResponses(() => p));
  const r = await searchPass(ctx(store), { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const run = (store as any).dump().runs.find((x: any) => x.id === r.runId);
  const events = run.output.events as any[];
  const reading = events.filter((e) => e.kind === "reading");
  expect(reading.map((e) => e.domain)).toEqual(["example-university-athletics.edu", "example-swim-news.com", "example-brand-press.com"]);
  expect(reading[0]).toMatchObject({ pass: "a", title: "Swimming roster" });
  const found = events.filter((e) => e.kind === "discovery").map((e) => e.text);
  expect(found).toEqual(f.pages.map((x) => x.claim));                         // each once (streamed, then not repeated at the end)
  expect(found.join(" ")).not.toMatch(/suspended|someone@example\.com/);
  expect(events[events.length - 1]).toMatchObject({ kind: "pass_done", pass: "a", facts: f.pages.length + 1 });
});

describe("R9: research's identity verdict is kept in memory (holds the M.I.A. preview while unresolved)", () => {
  const athlete = { name: "Rowan Vale", sport: "Track and field" };
  test("unresolved ⇒ one disputed made fact ending #identity, idempotent per run; resolved later ⇒ superseded", async () => {
    const { recordIdentityOutcome } = await import("./research");
    const store = createMemoryStore();
    expect(await recordIdentityOutcome(store, athleteId, { runId: "run-1", resolved: false, ambiguity: "Two athletes share the name.", athlete })).toEqual({ written: true, superseded: 0 });
    expect(await recordIdentityOutcome(store, athleteId, { runId: "run-1", resolved: false, ambiguity: "Two athletes share the name.", athlete })).toEqual({ written: false, superseded: 0 });
    const open = (await store.listFacts(athleteId)).filter((f) => f.source.ref?.endsWith("#identity"));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: "made", status: "disputed", source: { ref: "agent_runs/run-1#identity" } });
    expect(open[0].claim).toContain("Two athletes share the name.");
    expect(await recordIdentityOutcome(store, athleteId, { runId: "run-2", resolved: true, ambiguity: "", athlete })).toEqual({ written: false, superseded: 1 });
    expect((await store.listFacts(athleteId, ["active", "disputed"])).some((f) => f.source.ref?.endsWith("#identity"))).toBe(false);
  });
  test("resolved with nothing open ⇒ writes nothing", async () => {
    const { recordIdentityOutcome } = await import("./research");
    const store = createMemoryStore();
    expect(await recordIdentityOutcome(store, athleteId, { runId: "run-3", resolved: true, ambiguity: "", athlete })).toEqual({ written: false, superseded: 0 });
    expect(await store.listFacts(athleteId)).toHaveLength(0);
  });
});

test("R13b: a merged care fact's kind — the merge's own answer, else conduct only when every caring pass said conduct", async () => {
  const { mergedCareKind } = await import("./research");
  const pf = (careKind: "personal" | "conduct" | null) => ({ care: careKind !== null, careKind } as any);
  expect(mergedCareKind({ sensitivity: "none" }, [pf(null)])).toBeNull();
  expect(mergedCareKind({ sensitivity: "care", care_kind: "conduct" }, [pf("personal")])).toBe("conduct");
  expect(mergedCareKind({ sensitivity: "care", care_kind: "personal" }, [pf("conduct")])).toBe("personal");
  expect(mergedCareKind({ sensitivity: "care", care_kind: "none" }, [pf("conduct"), pf("conduct")])).toBe("conduct");
  expect(mergedCareKind({ sensitivity: "none" }, [pf("conduct"), pf("personal")])).toBe("personal");
  expect(mergedCareKind({ sensitivity: "care" }, [pf(null)])).toBe("personal");
});

test("R13: research 1.7.0 — each fact's outlet type reaches the merge (unknown ⇒ other); the input names the new angles", async () => {
  const f = FIXTURES.pro;
  const { PASS_ANGLES } = await import("./research");
  const t = fakeResponses((body) => {
    if (skillOf(body) === "research") {
      const p = passAnswer(f);
      (p.json as any).facts[0].source_type = "major_media";
      (p.json as any).facts[1].source_type = "not-a-type";
      return p;
    }
    const lines = String(body.input).split("\n");
    expect(lines.find((l) => l.startsWith("a1 |"))).toContain("| outlet major_media |");
    expect(lines.find((l) => l.startsWith("a2 |"))).toContain("| outlet other |");
    return { json: { facts: [], dropped: [], narrative: "" } };
  });
  setResponsesTransport(t);
  const c = ctx();
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  expect(a.facts.slice(0, 2).map((x) => x.source_type)).toEqual(["major_media", "other"]);
  expect(String(t.calls[0].input)).toContain(`PASS A: ${PASS_ANGLES.a}.`);
  expect(String(t.calls[1].input)).toContain(`PASS B: ${PASS_ANGLES.b}.`);
  // The strict schema asks for it, from the fixed list; the caps are unchanged (30 facts, 10 searches).
  const schema = t.calls[0].text.format.schema.properties.facts;
  expect(schema.items.properties.source_type.enum).toEqual(["official", "major_media", "trade", "local", "social", "other"]);
  expect(schema.items.required).toContain("source_type");
  expect(schema.items.properties.care_kind.enum).toEqual(["none", "personal", "conduct"]);
  expect(schema.items.required).toContain("care_kind");
  expect(schema.maxItems).toBe(30);
  expect(t.calls[0].max_tool_calls).toBe(10);
  await mergePasses(c, { athlete: f, a, b, existing: [] });
  expect(t.calls).toHaveLength(3);
});

// ── research 1.8.0 (the first real run's data-quality fixes). Made-up athletes, teams and brands only. ──────────────

/** A connected channel with recent posts (newest first), for the partner-post tests. */
function postsChannel(posts: Array<{ id: string; date: string; caption: string; permalink?: string | null }>, handle = "rowan.example"): ConnectedChannel {
  return {
    platform: "instagram", snapshotId: "s1", asOf: "2026-10-09", handle, followers: 1000, postCount: 40, avgEngagementRate: 3.2,
    avgReachPerPost: null, avgViewsPerPost: null, postsLast30d: 2, totalLikes: null, totalChannelViews: null, audience: {},
    recentPosts: posts.map((p) => ({ id: p.id, permalink: p.permalink ?? null, date: p.date, format: "IMAGE", likes: 10, comments: 1, views: null, caption: p.caption })),
  };
}

test("R16: her own posts that name a partner reach research and merge; a post-only partnership is stored as current evidence", async () => {
  const f = FIXTURES.college;
  const channel = postsChannel([
    { id: "11111111-1111-4111-8111-111111111111", date: "2026-08-25", caption: "So excited to join the @examplebrand athlete club — a community of women in sport #partner", permalink: "https://www.instagram.com/p/EXAMPLE1/?utm_source=ig_web_copy_link" },
    { id: "22222222-2222-4222-8222-222222222222", date: "2026-08-01", caption: "Game day with the team, photo by @teamphotog" },
    { id: "33333333-3333-4333-8333-333333333333", date: "2026-07-10", caption: "Morning run, thanks to @rowan.example for nothing" },   // her own handle is not a partner
    { id: "44444444-4444-4444-8444-444444444444", date: "2026-06-01", caption: "Thanks to my friends #gifted" },
    { id: "55555555-5555-4555-8555-555555555555", date: "2026-05-01", caption: "Just a sunset" },
  ]);
  const posts = partnerPosts([channel]);
  expect(posts.map((p) => [p.key, p.date, p.mentions, p.partnerTags])).toEqual([
    ["p1", "2026-08-25", ["examplebrand"], ["#partner"]],
    ["p2", "2026-08-01", ["teamphotog"], []],
    ["p3", "2026-06-01", [], ["#gifted"]],
  ]);
  expect(captionMentions("mail me at someone@example.org or @Example_Brand.")).toEqual(["Example_Brand"]);
  const summary = connectedSummaryText([channel]);
  expect(summary).toContain(PARTNER_POSTS_HEADING);
  expect(summary).toContain('p1 | Instagram (@rowan.example) | posted 2026-08-25 | mentions @examplebrand | tags #partner');

  let mergeInput = "";
  let passInput = "";
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") { passInput = String(body.input); return passAnswer(f); }
    mergeInput = String(body.input);
    return { json: { facts: [
      { from: ["p1"], subject_kind: "athlete", subject_name: f.name, claim: `${f.name} announced joining Example Brand's athlete club in their own Instagram post on 2026-08-25.`, topic: "sponsor", date: "2026-08-25", confidence: 0.97, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "" },
      { from: ["p9"], subject_kind: "athlete", subject_name: f.name, claim: "A post that does not exist.", topic: "sponsor", date: "", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "" },
    ], dropped: [], narrative: "Merged." } };
  }));
  const store = createMemoryStore();
  const c = ctx(store);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: summary, existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: summary, existing: [] });
  expect(passInput).toContain(PARTNER_POSTS_HEADING);
  const m = await mergePasses(c, { athlete: f, a, b, existing: [], posts });
  expect(mergeInput).toContain(`${PARTNER_POSTS_HEADING}\np1 | Instagram (@rowan.example) | posted 2026-08-25`);
  expect(m.inserted).toHaveLength(1);
  expect(m.inserted[0]).toMatchObject({
    type: "found", subject: { kind: "athlete", name: f.name }, topic: "sponsor", sourceType: "official", date: "2026-08-25",
    source: { url: "https://www.instagram.com/p/EXAMPLE1/", title: "Your Instagram post (@rowan.example), 2026-08-25" },
  });
  expect(m.inserted[0].confidence).toBe(POST_MAX_CONFIDENCE);           // the post shows the announcement, not the terms
  expect(m.dropped.some((d) => d.key === "p9")).toBe(true);
  // A post with no usable permalink is sourced to its media_assets row.
  expect(postSource({ ...posts[1], url: null })).toEqual({ ref: "media_assets/22222222-2222-4222-8222-222222222222", title: "Your Instagram post (@rowan.example), 2026-08-01" });
});

test("R17: a team, school or club's sponsor is that organization's fact — never the athlete's", async () => {
  const f = FIXTURES.youth;
  const club = { url: "https://www.example-club.org/sponsors", title: "Club sponsors" };
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") {
      const p = passAnswer(f, { extra: [
        // The organization's sponsor, as research 1.8.0 records it.
        { subject_kind: "organization", subject_name: "Example Valley FC", claim: "Example Valley FC lists Example Kit Co. as a club sponsor.", topic: "sponsor", source_url: club.url, source_title: club.title, source_type: "official", date: "", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none" },
        // A sponsor claim filed under the athlete that does not say whose sponsor it is: dropped at the pass.
        { subject_kind: "athlete", subject_name: f.name, claim: "Example Drinks is listed under Sponsors & Affiliates.", topic: "sponsor", source_url: club.url, source_title: club.title, source_type: "official", date: "", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none" },
        // An organization fact with no organization named: never filled in with the athlete's name.
        { subject_kind: "organization", subject_name: "", claim: "The club lists a regional bank as a partner.", topic: "sponsor", source_url: club.url, source_title: club.title, source_type: "official", date: "", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none" },
      ] });
      p.sources!.push(club);
      return p;
    }
    const input = String(body.input);
    const key = (needle: string) => /^(a\d+) \|/m.exec(input.split("\n").find((l) => l.includes(needle)) ?? "")?.[1] ?? "?";
    return { json: { facts: [
      { from: [key("Example Kit Co.")], subject_kind: "organization", subject_name: "Example Valley FC", claim: "Example Valley FC lists Example Kit Co. as a club sponsor.", topic: "sponsor", date: "", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "" },
      // Merge mislabels it as the athlete's: the claim does not name the athlete, so code drops it.
      { from: [key("Example Kit Co.")], subject_kind: "athlete", subject_name: f.name, claim: "Example Kit Co. is a sponsor.", topic: "sponsor", date: "", confidence: 0.95, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "" },
    ], dropped: [], narrative: "" } };
  }));
  const store = createMemoryStore();
  const c = ctx(store);
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  expect(a.facts.find((x) => x.claim.includes("Example Kit Co."))).toMatchObject({ subject_kind: "organization", subject_name: "Example Valley FC" });
  expect(a.dropped).toEqual(expect.arrayContaining([
    { claim: "Example Drinks is listed under Sponsors & Affiliates.", reason: "sponsor claim does not say whose sponsor it is" },
    { claim: "The club lists a regional bank as a partner.", reason: "organization fact does not name its subject" },
  ]));
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  const m = await mergePasses(c, { athlete: f, a, b, existing: [] });
  expect(m.inserted.map((x) => [x.subject.kind, x.subject.name, x.claim])).toEqual([["organization", "Example Valley FC", "Example Valley FC lists Example Kit Co. as a club sponsor."]]);
  expect(m.dropped.map((d) => d.reason)).toContain("sponsor claim does not say whose sponsor it is");
  const stored = await store.listFacts(athleteId);
  expect(stored.some((x) => x.subject.kind === "athlete" && x.topic === "sponsor")).toBe(false);
  // The rule itself: the family name as a word, or the full name.
  expect(claimNamesAthlete("Vale signed with Example Kit Co.", f.name)).toBe(true);
  expect(claimNamesAthlete("Valetta FC signed with Example Kit Co.", f.name)).toBe(false);
});

test("R18: inline markdown citations leave every stored claim; a junk image URL is no source unless its page was seen", async () => {
  const f = FIXTURES.pro;
  const roster = "https://www.example-pro-league.com/teamroster/id/77";
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") {
      const p = passAnswer(f, { extra: [
        { subject_kind: "athlete", subject_name: f.name, claim: `${f.name} is on the 2026 roster. ([example-pro-league.com](${roster}?utm_source=openai))`, topic: "team", source_url: `${roster}/img/colorpicker/alpha-horizontal.png`, source_title: "Roster", source_type: "official", date: "2026", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none" },
        { subject_kind: "athlete", subject_name: f.name, claim: `${f.name} has a logo.`, topic: "other", source_url: "https://cdn.example-unseen.net/logo.png", source_title: "Logo", source_type: "other", date: "", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none" },
      ] });
      p.sources!.push({ url: roster });
      return p;
    }
    return { json: { facts: [], dropped: [], narrative: "" } };
  }));
  const a = await searchPass(ctx(), { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const onRoster = a.facts.find((x) => x.claim.startsWith(`${f.name} is on the 2026 roster`))!;
  expect(onRoster.claim).toBe(`${f.name} is on the 2026 roster.`);
  expect(onRoster.source_url).toBe(roster);                      // the page the junk URL hung off, which the pass saw
  expect(onRoster.confidence).toBe(0.72);                          // 0.9 × 0.8
  expect(a.dropped).toContainEqual({ claim: `${f.name} has a logo.`, reason: "malformed source url" });
});

test("R19: the store layer cleans every writer's facts — claims, source URLs, also-seen URLs; nothing usable ⇒ refused", async () => {
  const store = createMemoryStore();
  const [x] = await store.insertFacts(athleteId, [{
    subject: { kind: "event", name: "Season" }, type: "found", date: null, confidence: 0.9, runId: null,
    claim: "The season opens in October ([example.org](https://example.org/cal?utm_source=openai)).",
    source: { url: "https://example.org/cal/img/banner.jpg", title: "Calendar" },
    alsoSeenAt: [{ url: "https://Example.org/cal?utm_source=openai#top", title: "Calendar" }, { url: "not a url" }],
  }]);
  expect(x.claim).toBe("The season opens in October.");
  expect(x.source.url).toBe("https://example.org/cal");            // the junk primary fell back to the also-seen page
  expect(x.alsoSeenAt).toEqual([]);
  await expect(store.insertFacts(athleteId, [{ subject: { kind: "event", name: "S" }, type: "found", date: null, confidence: 0.9, runId: null, claim: "x", source: { url: "https://example.org/a.png" } }]))
    .rejects.toThrow(/source_required/);
  const [withRef] = await store.insertFacts(athleteId, [{ subject: { kind: "athlete", name: "A" }, type: "found", date: null, confidence: 0.9, runId: null, claim: "y", source: { url: "https://example.org/a.png", ref: "media_assets/1" } }]);
  expect(withRef.source).toEqual({ ref: "media_assets/1" });
});

test("R20: merge 1.9.0 — a month- or year-only date keeps its precision; identity fields stored only for facts about the athlete", async () => {
  const f = FIXTURES.youth;
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) === "research") return passAnswer(f);
    const key = /^(a\d+) \|/m.exec(String(body.input))?.[1] ?? "a1";
    const m = (over: Record<string, unknown>) => ({ from: [key], subject_kind: "athlete", subject_name: f.name, topic: "team", date: "", confidence: 0.9, sensitivity: "none", care_kind: "none", never_reason: "none", conflicts_with: "", duplicate_of: "", note: "", field: "none", field_value: "", ...over });
    return { json: { facts: [
      m({ claim: `${f.name} joined Example Valley FC in September 2026.`, date: "2026-09", field: "team", field_value: "Example Valley FC" }),
      m({ claim: `${f.name} was named to the regional squad in 2025.`, date: "2025", field: "level", field_value: " Regional  squad " }),
      m({ claim: `${f.name} trains on 3 October 2026.`, date: "2026-10-03", topic: "career", field: "position", field_value: "" }),
      m({ subject_kind: "organization", subject_name: "Example Valley FC", claim: "Example Valley FC plays in the regional league.", date: "2026-10-05", field: "league", field_value: "Regional league" }),
      m({ claim: `${f.name} wears number 9.`, date: "2026-10-05", field: "jersey", field_value: "9" }),
    ], dropped: [], narrative: "" } };
  }));
  const c = ctx();
  const a = await searchPass(c, { pass: "a", athlete: f, connectedSummary: "", existing: [] });
  const b = await searchPass(c, { pass: "b", athlete: f, connectedSummary: "", existing: [] });
  const r = await mergePasses(c, { athlete: f, a, b, existing: [] });
  expect(r.inserted.map((x) => [x.date, x.datePrecision ?? null, x.field ?? null, x.fieldValue ?? null])).toEqual([
    ["2026-09-01", "month", "team", "Example Valley FC"],
    ["2025-01-01", "year", "level", "Regional squad"],
    ["2026-10-03", "day", null, null],                     // a field with no value is no field
    ["2026-10-05", "day", null, null],                     // an organization's fact never fills the athlete's identity
    ["2026-10-05", "day", null, null],                     // not an identity field from the list
  ]);
});
