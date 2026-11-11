/**
 * scan.test.ts — one weekly moments scan end to end on the in-memory store, the model faked (no provider is reached).
 *
 *   M1 no Brief → skipped, no model call
 *   M2 the call: skill moments v1.0.0 on the fast tier (gpt-6-luna, OpenAI), web_search capped (10, low context), the
 *      moments schema, 6,000 output tokens; the input: the window, the athlete (name, stage, identity fields, what they
 *      told us), their facts (never care, measured or event facts), the moments on file (M-keys, the idea on file) and
 *      the deals (D-keys) — never ids
 *   M3 the write: a moment found again is REFRESHED in place (same id, new source, the old URL kept as also-seen, its
 *      candidate post updated in place); a new moment is written as an event fact (topic moment) with its candidate post
 *      (kind other, detail.kind moment, ranked); a partner moment rests on its deal (source ref); an event fact research
 *      filed under another topic is LINKED, never rewritten; leaked keys are stripped; an unseen URL is held
 *   M4 retiring: what the scan says no longer fits is superseded and its candidate expired — only moments the store owns;
 *      every owned moment whose date has passed is retired too; nothing else is touched
 *   M5 the checks hold: a year-only date, a date outside the window, the same moment twice, "AI", contact details, a
 *      searched moment without a seen page, a schedule moment with nothing behind it; at most twelve moments are read
 *      (moments 1.2.0, a 60-day window; each moment carries one angle and a hook, no format, brief or media needs)
 *   M6 a refresh with no new source keeps the moment's source
 *   M7 budget: the week's moments cap and the day's cap skip the scan; a retried step pays nothing
 *   M16 the idea bank (build step 8): off, the scan files nothing in the bank; on, each candidate post is filed as ONE
 *      time-bound bank entry (written once, refreshed in place while new, left alone once used), and a moment that turns
 *      out to be a care moment has its entry skipped
 *   M17 care, whoever wrote the idea: a reverse-pass idea and a plan-adapted row on the moment are skipped too, and so
 *      are the ideas of a moment whose candidate had already expired; the idea bank never reads a care moment's ideas;
 *      a retire records its reason on the candidate
 *   M18 the search guard (moments 1.2.0): a scan with no web search is retried once, its input led by a note to search
 *      the other kinds first; the first run hands over to the retry, which writes; a retry that still searched nothing
 *      is applied and says so; no retry when the scan searched or the week's cap has no room for a second scan
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Preference } from "../../../shared/agent";
import type { MomentDecisionDetail } from "../../../shared/plan";
import type { IdeaBankEntry } from "../../../shared/postKit";
import { listBank } from "../ideaBank/bank";
import { fakeResponses, unfencedInput, type FakeTransport } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { applyMoments, buildMomentsInput, momentDateOf, periodEnd, runMomentsScan, stripMomentKeys, type MomentDeal, type MomentsRunOutput, type MomentsSources } from "./scan";

const A = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-10-10T13:00:00.000Z");
afterEach(() => { setResponsesTransport(null); });

const DEAL: MomentDeal = { id: "11111111-1111-4111-8111-111111111111", brand: "Acme Hydration", category: "beverage", status: "accepted", termStart: "2026-10-01", termEnd: "2026-12-31", signed: true };
const sources = (deals: MomentDeal[] = [DEAL], prefs: Preference[] = []): MomentsSources => ({ deals: async () => deals, preferences: async () => prefs });
const pref = (statement: string): Preference => ({ id: `p-${statement.length}`, athleteId: A, kind: "avoid", statement, source: "said", status: "active", runId: null, createdAt: "2026-10-01T00:00:00.000Z" });
const src = (path: string) => ({ url: `https://example.org/${path}` });

async function seed(store: AgentStore) {
  await store.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example's sport is rowing.", type: "said", source: { ref: "onboarding/wf#sport" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example rows for Riverside Club.", type: "found", source: src("roster"), date: "2026-09-01", confidence: 0.9, runId: null, topic: "team", field: "team", fieldValue: "Riverside Club" },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "CARE-CLAIM Pat Example missed spring with an injury.", type: "found", source: src("injury"), date: "2026-04-01", confidence: 0.9, runId: null, sensitive: true, careKind: "personal" },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "MEASURED-CLAIM Pat Example has 4,000 followers.", type: "measured", source: { ref: "connected/instagram" }, date: "2026-10-01", confidence: 1, runId: null },
  ]);
  const [opener, gala, past, final, oldCup, openDay] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is on 18 October 2026.", type: "found", source: { url: "https://example.org/schedule", title: "Schedule" }, date: "2026-10-18", confidence: 0.8, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Awards gala" }, claim: "The awards gala is on 5 November 2026.", type: "found", source: src("gala"), date: "2026-11-05", confidence: 0.8, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Preseason camp" }, claim: "The preseason camp was on 2 October 2026.", type: "found", source: src("camp"), date: "2026-10-02", confidence: 0.8, runId: null, topic: "upcoming" },
    { subject: { kind: "event", name: "League final" }, claim: "The league final is on 15 November 2026.", type: "found", source: src("final"), date: "2026-11-15", confidence: 0.9, runId: null, topic: "competition" },
    { subject: { kind: "event", name: "Old cup" }, claim: "Pat Example raced the old cup on 1 September 2026.", type: "found", source: src("cup"), date: "2026-09-01", confidence: 0.9, runId: null, topic: "competition" },
    { subject: { kind: "event", name: "Club open day" }, claim: "The club open day is on 8 November 2026.", type: "found", source: src("open-day"), date: "2026-11-08", confidence: 0.9, runId: null, topic: "team" },
  ]);
  await store.writeBrief(A, {
    summary: "A club rower with a local following.", sections: [], factIds: [], runId: null, internal: { currentSponsors: [], pastSponsors: [] },
    display: { stage: { label: "Club rower", band: "developing", confidence: 0.7, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] } },
  });
  const candidate = (factId: string, name: string, hook: string) => store.insertDecision(A, {
    runId: null, skillId: "moments", kind: "other", suggested: hook, why: "w", evidence: [{ kind: "fact", factId }],
    detail: { kind: "moment", factId, name, date: "2026-10-18", datePrecision: "day", category: "schedule", whyNow: "w", rank: 1, idea: { hook, format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", scannedAt: "2026-10-03T13:00:00.000Z" },
  });
  const decisions = { opener: await candidate(opener.id, "Home opener", "OLD-HOOK"), gala: await candidate(gala.id, "Awards gala", "GALA-HOOK"), past: await candidate(past.id, "Preseason camp", "CAMP-HOOK") };
  return { opener, gala, past, final, oldCup, openDay, decisions };
}

/** The key the input gave a line that contains `text`. */
const keyOf = (input: string, prefix: "F" | "M" | "D", text: string) => {
  const line = input.split("\n").find((l) => l.startsWith(prefix) && l.includes(text));
  return line ? line.split(" | ")[0] : `${prefix}0`;
};

const moment = (over: Record<string, unknown>) => ({
  name: "x", description: "x happens.", date: "2026-10-20", date_precision: "day", category: "schedule", why_now: "It is close.",
  source_url: "", source_title: "", confidence: 0.9, based_on: [], refreshes: null, sensitivity: "none", never_reason: "none",
  idea: { hook: "A hook.", angle: "Home." },
  ...over,
});

function scanModel(build: (input: string) => Record<string, unknown>, seen: string[]): FakeTransport {
  return fakeResponses((body) => ({
    json: build(unfencedInput(body.input)), sources: seen.map((url) => ({ url, title: "page" })), queries: ["upcoming moments"],
    usage: { input: 40_000, cached: 0, output: 2_000, reasoning: 500 },
  }));
}

test("M1: no Brief → skipped, no model call", async () => {
  const store = createMemoryStore();
  const t = fakeResponses(() => { throw new Error("no call expected"); });
  setResponsesTransport(t);
  expect(await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW })).toEqual({ status: "skipped", reason: "no_brief" });
  expect(t.calls).toHaveLength(0);
});

test("M2–M4: the call and its input; refresh, write, link, retire, and the candidate posts", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = scanModel((input) => ({
    moments: [
      moment({
        name: "Riverside home opener", description: "Riverside Club opens its home season on 18 October 2026.", date: "2026-10-18", why_now: "The first home crowd of the season [M1].",
        source_url: "https://example.org/opener-2026?utm_source=openai", source_title: "Club news", refreshes: keyOf(input, "M", "Home opener"), based_on: [keyOf(input, "F", "Riverside Club")],
        idea: { hook: "Back on home water.", angle: "An angle." },
      }),
      moment({ name: "Acme autumn launch", description: "The partner's autumn range launches on 28 October 2026.", date: "2026-10-28", category: "partner_campaign", why_now: "The partner launches this month.", based_on: [keyOf(input, "D", "Acme Hydration")], idea: { hook: "Fuelled for the season.", angle: "An angle." } }),
      moment({ name: "Mental health awareness day", description: "A mental health awareness day falls on 10 October 2026.", date: "2026-10-10", category: "holiday_awareness", source_url: "https://example.org/awareness", why_now: "Fits the club's wellbeing work.", idea: { hook: "Rest is training too.", angle: "An angle." } }),
      moment({ name: "League final", description: "The league final is on 15 November 2026.", date: "2026-11-15", category: "league", source_url: "https://example.org/final", why_now: "The season's last race." }),
      moment({ name: "Harvest festival", description: "A harvest festival.", date: "2026-10-30", category: "cultural_trend", source_url: "https://unseen.example/harvest", why_now: "Seasonal." }),
    ],
    retire: [
      { key: keyOf(input, "M", "Awards gala"), why: "cancelled", reason: "The gala was cancelled." }, { key: keyOf(input, "M", "League final"), why: "not_worth_a_post", reason: "Not for posting." },
      { key: keyOf(input, "M", "Club open day"), why: "wrong", reason: "Not this club's." }, { key: "M99", why: "passed", reason: "x" },
    ],
    path_note: "looked at the schedule and the partner",
  }), ["https://example.org/opener-2026", "https://example.org/awareness", "https://example.org/final"]);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m2:scan", now: NOW });
  expect(out).toMatchObject({ status: "scanned", written: 2, refreshed: 1, linked: 1, retired: 1, passed: 1, held: 4 });

  // M2: the call.
  const body = t.calls[0];
  expect(body.model).toBe("gpt-6-luna");
  expect(body.prompt_cache_key).toBe("nomila:moments@1.2.0");
  expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
  expect(body.max_tool_calls).toBe(10);
  expect(body.max_output_tokens).toBe(6_000);
  expect(body.text.format.name).toBe("moments");
  expect(body.reasoning).toEqual({ effort: "medium" });
  const input = unfencedInput(body.input);
  expect(input).toMatch(/^TODAY: 2026-10-10 \(the window runs to 2026-12-09\)/);
  expect(input).toContain("- name: Pat Example");
  expect(input).toContain("- career stage: Club rower (band developing)");
  expect(input).toContain("- team: Riverside Club");
  expect(input).toContain("- told us: Pat Example's sport is rowing.");
  expect(input).toMatch(/^F\d+ \| athlete: Pat Example \| Pat Example rows for Riverside Club\. \| date 2026-09-01$/m);
  expect(input).not.toMatch(/CARE-CLAIM|MEASURED-CLAIM/);                             // never care facts, never numbers
  expect(input).not.toMatch(/^F\d+ \| event:/m);                                     // event facts are moments, not F-facts
  expect(input).toMatch(/^M1 \| 2026-10-18 \| day \| Home opener \| The home opener is on 18 October 2026\. \| idea on file: OLD-HOOK$/m);
  expect(input).toMatch(/^M\d+ \| 2026-11-15 \| day \| League final \| .* \| no idea on file \| research filed it: keep its date$/m);
  expect(input).not.toContain("Preseason camp");                                     // passed: not on the list
  expect(input).toMatch(/^D1 \| Acme Hydration \| category beverage \| status accepted \| term 2026-10-01 to 2026-12-31 \| signed \| may be a partner moment$/m);
  for (const id of [s.opener.id, s.gala.id, DEAL.id, A]) expect(input).not.toContain(id);

  const runId = (out as any).runId as string;
  const all = await store.listFacts(A);
  const byId = new Map(all.map((f) => [f.id, f]));

  // M3: the opener refreshed in place — same id, new claim and source, the old page kept as also-seen.
  const opener = byId.get(s.opener.id)!;
  expect(opener).toMatchObject({ subject: { kind: "event", name: "Riverside home opener" }, status: "active", claim: "Riverside Club opens its home season on 18 October 2026.", source: { url: "https://example.org/opener-2026", title: "Club news" }, runId, date: "2026-10-18", datePrecision: "day", confidence: 0.9, topic: "moment" });
  expect(opener.alsoSeenAt).toEqual([{ url: "https://example.org/schedule", title: "Schedule" }]);
  expect(all.filter((f) => f.status === "active" && /opener/i.test(f.subject.name))).toHaveLength(1);   // no duplicate

  // New moments: event facts under topic "moment", sourced.
  const written = all.filter((f) => f.runId === runId && f.id !== s.opener.id);
  expect(written.map((f) => [f.subject.kind, f.subject.name, f.topic, f.type, f.date, f.datePrecision])).toEqual([
    ["event", "Acme autumn launch", "moment", "found", "2026-10-28", "day"],
    ["event", "Mental health awareness day", "moment", "found", "2026-10-10", "day"],
  ]);
  expect(written[0].source).toEqual({ ref: `deals/${DEAL.id}`, title: "Your deal with Acme Hydration" });   // rests on the deal
  expect(written[1].source).toEqual({ url: "https://example.org/awareness" });                       // a page the scan saw
  // The league final: research's own event fact, linked and never rewritten.
  expect(byId.get(s.final.id)).toMatchObject({ status: "active", claim: "The league final is on 15 November 2026.", runId: null, topic: "competition" });
  expect(all.some((f) => f.claim === "A harvest festival.")).toBe(false);

  // The candidate posts: one pending per moment, ranked, the opener's updated in place.
  // The idea bank's entries (detail.kind "idea") are filed beside the moments; this checks the moments.
  const candidates = (await store.listDecisions(A, { skillId: "moments", responses: ["pending"] })).filter((d) => d.detail?.kind !== "idea");
  const details = candidates.map((d) => d.detail as unknown as MomentDecisionDetail).sort((a, b) => a.rank - b.rank);
  expect(details.map((d) => [d.rank, d.name, d.category])).toEqual([
    [1, "Riverside home opener", "schedule"], [2, "Acme autumn launch", "partner_campaign"], [3, "Mental health awareness day", "holiday_awareness"], [4, "League final", "league"],
  ]);
  expect(details[3].factId).toBe(s.final.id);
  const openerDecision = candidates.find((d) => d.id === s.decisions.opener.id)!;
  expect(openerDecision).toMatchObject({ suggested: "Back on home water.", why: "The first home crowd of the season.", runId });   // leaked key stripped
  expect(details[0]).toMatchObject({ kind: "moment", factId: s.opener.id, whyNow: "The first home crowd of the season.", idea: { hook: "Back on home water.", angle: "An angle." }, scannedAt: NOW.toISOString() });
  // moments 1.2.0: no format, brief or media needs of its own — the plan picks them.
  expect([details[0].brief, details[0].mediaNeeds, details[0].idea.format]).toEqual([undefined, undefined, undefined]);
  const partner = candidates.find((d) => (d.detail as any).name === "Acme autumn launch")!;
  expect(partner.evidence).toEqual([{ kind: "fact", factId: written[0].id }, { kind: "record", table: "deals", id: DEAL.id }]);

  // M4: the gala retired (the scan said so) and the camp (passed); research's final and its past cup untouched.
  expect(byId.get(s.gala.id)!.status).toBe("superseded");
  expect(byId.get(s.past.id)!.status).toBe("superseded");
  expect(byId.get(s.oldCup.id)!.status).toBe("active");
  expect(byId.get(s.openDay.id)!.status).toBe("active");
  expect((await store.getDecision(A, s.decisions.gala.id))).toMatchObject({ response: "expired", responseReason: "retired by the moments scan: cancelled: The gala was cancelled." });
  expect((await store.getDecision(A, s.decisions.past.id))).toMatchObject({ response: "expired", responseReason: "the moment has passed" });

  // The run keeps what it wrote and what it held, and why.
  const o = (await store.getRun(A, runId))!.output as MomentsRunOutput;
  expect(o.applied!.refreshed).toEqual([{
    factId: s.opener.id,
    before: { name: "Home opener", claim: "The home opener is on 18 October 2026.", date: "2026-10-18", precision: null, source: { url: "https://example.org/schedule", title: "Schedule" }, confidence: 0.8 },
  }]);
  expect(o.applied).toMatchObject({ linked: [s.final.id], retired: [s.gala.id], passed: [s.past.id], expired: [s.decisions.gala.id, s.decisions.past.id] });
  expect(o.held).toEqual([
    { what: "Harvest festival", reason: "its source was not seen by this scan's searches" },
    { what: `retire ${keyOf(input, "M", "League final")}`, reason: "kept by this same scan" },
    { what: `retire ${keyOf(input, "M", "Club open day")}`, reason: "the fact is the athlete's own, confirmed, or research's: kept as written; only its post expired" },
    { what: "retire M99", reason: "not a moment on file" },
  ]);
  expect((await store.getRun(A, runId))).toMatchObject({ skillId: "moments", skillVersion: "1.2.0", trigger: "schedule", status: "completed", parentRef: "workflow:m2:scan" });
});

test("M5: the checks hold — dates, the window, duplicates, words, sources; at most twelve moments are read", async () => {
  const store = createMemoryStore();
  await seed(store);
  const t = scanModel(() => ({
    moments: [
      moment({ name: "Club regatta", description: "The club regatta is on 24 October 2026.", date: "2026-10-24", source_url: "https://example.org/regatta" }),
      moment({ name: "club regatta!", description: "Again.", date: "2026-10-24", source_url: "https://example.org/regatta" }),
      moment({ name: "Year only", description: "Some time in 2026.", date: "2026", source_url: "https://example.org/regatta" }),
      moment({ name: "Winter tour", description: "A winter tour in January.", date: "2027-01-10", source_url: "https://example.org/regatta" }),
      moment({ name: "AI moment", description: "x", date: "2026-10-26", source_url: "https://example.org/regatta", idea: { hook: "Made by AI.", angle: "An angle." } }),
      moment({ name: "Sixth", description: "The sixth is read now.", date: "2026-10-27", source_url: "https://example.org/regatta" }),
      ...Array.from({ length: 6 }, (_, i) => moment({ name: `Extra ${i + 1}`, description: `Extra ${i + 1}.`, date: `2026-11-0${i + 1}`, source_url: "https://example.org/regatta" })),
      moment({ name: "Thirteenth", description: "Never read.", date: "2026-11-20", source_url: "https://example.org/regatta" }),
    ],
    retire: [], path_note: "p",
  }), ["https://example.org/regatta"]);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ status: "scanned", written: 8, held: 4 });
  const o = (await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput;
  expect(o.held).toEqual([
    { what: "club regatta!", reason: "the same moment twice in this scan" },
    { what: "Year only", reason: "no usable date (2026): a day or a month is needed" },
    { what: "Winter tour", reason: "2027-01-10 is outside the window (2026-10-10 to 2026-12-09)" },
    { what: "AI moment", reason: "says \"AI\" or \"brain\"" },
  ]);
  expect((await store.listFacts(A)).some((f) => f.subject.name === "Sixth")).toBe(true);
  expect((await store.listFacts(A)).some((f) => f.subject.name === "Thirteenth")).toBe(false);

  // Sources and contact details, in a second scan.
  const t2 = scanModel(() => ({
    moments: [
      moment({ name: "Derby day", description: "Call 555-123-4567 for tickets to derby day.", date: "2026-10-29", source_url: "https://example.org/derby" }),
      moment({ name: "League media day", description: "League media day.", date: "2026-10-30", category: "league", source_url: "" }),
      moment({ name: "Team trip", description: "A team trip.", date: "2026-10-31", category: "schedule", source_url: "", based_on: ["F99"] }),
      moment({ name: "", description: "No name.", date: "2026-10-31", source_url: "https://example.org/derby" }),
    ],
    retire: [], path_note: "p",
  }), ["https://example.org/derby"]);
  setResponsesTransport(t2);
  const out2 = await runMomentsScan({ store, sources: sources([]), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  const o2 = (await store.getRun(A, (out2 as any).runId))!.output as MomentsRunOutput;
  expect(o2.held).toEqual([
    // Contact details in its words: removed before the run's output is stored, and held without its words.
    { what: "(a moment not stored)", reason: "never-store: contact" },
    { what: "League media day", reason: "no source: a league, holiday, awareness or cultural moment needs a page this scan saw" },
    { what: "Team trip", reason: "no source: no page seen, and no fact of the athlete's behind it" },
    { what: "(unnamed moment)", reason: "incomplete: a name, what it is, why now, a category, a hook and an angle are all needed" },
  ]);
});

test("M6: a moment found again with no new source keeps its own", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  setResponsesTransport(scanModel((input) => ({
    moments: [moment({ name: "Home opener", description: "The home opener moves to the evening on 18 October 2026.", date: "2026-10-18", source_url: "", refreshes: keyOf(input, "M", "Home opener") })],
    retire: [], path_note: "p",
  }), []));
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ refreshed: 1, written: 0 });
  const opener = (await store.getFacts(A, [s.opener.id]))[0];
  expect(opener).toMatchObject({ claim: "The home opener moves to the evening on 18 October 2026.", source: { url: "https://example.org/schedule", title: "Schedule" }, alsoSeenAt: [] });
});

test("M7: the week's and the day's caps skip the scan; a retried step pays nothing", async () => {
  const store = createMemoryStore();
  await seed(store);
  const cost = async (skillId: string, microUsd: number) => {
    const id = await store.startRun({ athleteId: A, skillId, skillVersion: "1.0.0", trigger: "schedule", model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
    await store.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd }, steps: [], evidenceRead: [], output: null, error: null });
  };
  const t = fakeResponses(() => { throw new Error("no call expected"); });
  setResponsesTransport(t);
  await cost("moments", 300_000);                                                    // $0.30 this week: 0.30 + 0.25 > 0.50
  expect(await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: new Date() })).toEqual({ status: "skipped", reason: "week_cap" });
  const other = createMemoryStore();
  await seed(other);
  const id = await other.startRun({ athleteId: A, skillId: "chat", skillVersion: "1.0.0", trigger: "chat", model: { provider: "openai", model: "m", effort: "low" }, parentRef: null });
  await other.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 4_900_000 }, steps: [], evidenceRead: [], output: null, error: null });
  expect(await runMomentsScan({ store: other, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: new Date() })).toEqual({ status: "skipped", reason: "day_cap" });
  expect(t.calls).toHaveLength(0);

  // A retried workflow step: the finished run is the answer, no second call.
  const fresh = createMemoryStore();
  await seed(fresh);
  const once = scanModel(() => ({ moments: [moment({ name: "Club regatta", description: "The club regatta.", date: "2026-10-24", source_url: "https://example.org/regatta" })], retire: [], path_note: "p" }), ["https://example.org/regatta"]);
  setResponsesTransport(once);
  const first = await runMomentsScan({ store: fresh, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m7:scan", now: NOW });
  const again = await runMomentsScan({ store: fresh, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m7:scan", now: NOW });
  expect(again).toEqual({ status: "reused", runId: (first as any).runId, why: "retried_step" });
  expect(once.calls).toHaveLength(1);
});

test("dates and keys: a moment's date as stored, a period's end, keys out of the words", () => {
  expect(momentDateOf("2026-10-18", "day")).toEqual({ date: "2026-10-18", precision: "day" });
  expect(momentDateOf("2026-10-18", "month")).toEqual({ date: "2026-10-01", precision: "month" });   // the coarser wins
  expect(momentDateOf("2026-10", "day")).toEqual({ date: "2026-10-01", precision: "month" });
  expect(momentDateOf("2026-02-30", "day")).toBeNull();                              // no such day
  expect(momentDateOf("2026", "day")).toBeNull();
  expect(momentDateOf("soon", "day")).toBeNull();
  expect(periodEnd("2026-02-01", "month")).toBe("2026-02-28");
  expect(periodEnd("2026-01-01", "year")).toBe("2026-12-31");
  expect(periodEnd("2026-10-18", null)).toBe("2026-10-18");
  const known = new Map([["F1", "Pat Example"], ["M2", "Home opener"], ["D1", "Acme"]]);
  expect(stripMomentKeys("Back home (F1, M2) for D1 day.", known)).toBe("Back home for Acme day.");   // a key inside the sentence: its name
  expect(stripMomentKeys("The M5 motorway closes.", known)).toBe("The M5 motorway closes.");   // not a key this input used
  expect(stripMomentKeys("Per F1, the opener is close.", known)).toBe("The opener is close.");
  expect(stripMomentKeys("See M2: home crowd.", known)).toBe("Home crowd.");
  expect(stripMomentKeys("The date is set, as noted in F1.", known)).toBe("The date is set.");
  expect(stripMomentKeys("F1's first home game.", known)).toBe("The first home game.");
  expect(stripMomentKeys("Pairs with M2 and D1 nicely.", known)).toBe("Pairs with Home opener and Acme nicely.");
  expect(stripMomentKeys("lower case stays lower case.", known)).toBe("lower case stays lower case.");
});

/** A second athlete store for the store-ownership cases: the athlete's own word, a confirmed fact, research's. */
async function seedOwnership(store: AgentStore) {
  const s = await seed(store);
  const [said, confirmed] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "Senior day" }, claim: "Senior day is on 20 October 2026.", type: "said", source: { ref: "chat:x#senior" }, date: "2026-10-20", confidence: 1, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Charity row" }, claim: "The charity row is on 24 October 2026.", type: "found", source: src("charity"), date: "2026-10-24", confidence: 0.8, runId: null, topic: "moment" },
  ]);
  await store.insertReview(A, { factId: confirmed.id, action: "confirm", correction: null, replacementFactId: null, note: null });
  return { ...s, said, confirmed };
}

test("M8: the athlete's corrections are never rewritten or retired — the athlete's own word and confirmed facts are linked, and their date rules", async () => {
  const store = createMemoryStore();
  const s = await seedOwnership(store);
  const t = scanModel((input) => ({
    moments: [
      moment({ name: "Senior day", description: "Senior day honours the final-year rowers in October 2026.", date: "2026-10", date_precision: "month", source_url: "https://example.org/senior", refreshes: keyOf(input, "M", "Senior day") }),
      moment({ name: "Charity row", description: "The charity row moves to 25 October 2026.", date: "2026-10-24", source_url: "https://example.org/charity-2026" }),
    ],
    retire: [{ key: keyOf(input, "M", "Charity row"), why: "cancelled", reason: "Cancelled." }],
    path_note: "p",
  }), ["https://example.org/senior", "https://example.org/charity-2026"]);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ status: "scanned", written: 0, refreshed: 0, linked: 2 });
  const input = String(t.calls[0].input);
  expect(input).toMatch(/\| Senior day \| .* \| the athlete told us: keep its date$/m);
  expect(input).toMatch(/\| Charity row \| .* \| the athlete confirmed it: keep its date$/m);
  // Both facts exactly as the athlete left them.
  const [said, confirmed] = await store.getFacts(A, [s.said.id, s.confirmed.id]);
  expect(said).toMatchObject({ claim: "Senior day is on 20 October 2026.", status: "active", date: "2026-10-20", runId: null });
  expect(confirmed).toMatchObject({ claim: "The charity row is on 24 October 2026.", status: "active", runId: null });
  // The candidate for the athlete's own moment carries the athlete's date, not the scan's month.
  const cand = (await store.listDecisions(A, { skillId: "moments", responses: ["pending"] })).map((d) => d.detail as unknown as MomentDecisionDetail).find((d) => d.factId === s.said.id)!;
  expect([cand.date, cand.datePrecision]).toEqual(["2026-10-20", "day"]);
  const o = (await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput;
  expect(o.held).toEqual([{ what: `retire ${keyOf(input, "M", "Charity row")}`, reason: "kept by this same scan" }]);
});

test("M8b: a retire aimed at a fact the scan does not own keeps the fact and expires only its post", async () => {
  const store = createMemoryStore();
  const s = await seedOwnership(store);
  const c = await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "h", why: "w", evidence: [], detail: { kind: "moment", factId: s.confirmed.id, name: "Charity row", date: "2026-10-24", datePrecision: "day", category: "schedule", whyNow: "w", rank: 1, idea: { hook: "h", format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", scannedAt: "2026-10-03T13:00:00.000Z" } });
  setResponsesTransport(scanModel((input) => ({ moments: [], retire: [{ key: keyOf(input, "M", "Charity row"), why: "wrong", reason: "Not this club." }, { key: keyOf(input, "M", "Senior day"), why: "cancelled", reason: "x" }], path_note: "p" }), []));
  await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  const [said, confirmed] = await store.getFacts(A, [s.said.id, s.confirmed.id]);
  expect([said.status, confirmed.status]).toEqual(["active", "active"]);
  expect(await store.getDecision(A, c.id)).toMatchObject({ response: "expired", responseReason: "the moments scan: wrong: Not this club." });
});

test("M9: privacy — never-store is never stored (nor its words); care is kept as a sensitive fact with no candidate post", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = scanModel((input) => ({
    moments: [
      moment({ name: "PRIVATE-NAME family party", description: "PRIVATE-WORDS at the family home.", date: "2026-10-22", source_url: "https://example.org/p", sensitivity: "never", never_reason: "non_public" }),
      moment({ name: "Memorial row", description: "A memorial row for a former coach is on 30 October 2026.", date: "2026-10-30", source_url: "https://example.org/memorial", sensitivity: "care" }),
      moment({ name: "Home opener", description: "The home opener remembers a former coach on 18 October 2026.", date: "2026-10-18", source_url: "https://example.org/opener-2026", sensitivity: "care", refreshes: keyOf(input, "M", "Home opener") }),
    ],
    retire: [], path_note: "p",
  }), ["https://example.org/p", "https://example.org/memorial", "https://example.org/opener-2026"]);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ written: 1, refreshed: 1 });
  const run = (await store.getRun(A, (out as any).runId))!;
  expect(JSON.stringify(run.output)).not.toMatch(/PRIVATE-NAME|PRIVATE-WORDS/);
  expect((run.output as MomentsRunOutput).held).toEqual([{ what: "(a moment not stored)", reason: "never-store: non_public" }]);
  const facts = await store.listFacts(A);
  expect(facts.some((f) => /PRIVATE/.test(f.claim + f.subject.name))).toBe(false);
  const memorial = facts.find((f) => f.subject.name === "Memorial row")!;
  expect([memorial.sensitive, memorial.careKind]).toEqual([true, "personal"]);
  expect((await store.getFacts(A, [s.opener.id]))[0]).toMatchObject({ sensitive: true, careKind: "personal" });
  const pending = await store.listDecisions(A, { skillId: "moments", responses: ["pending"] });
  expect(pending.map((d) => (d.detail as any).factId)).not.toEqual(expect.arrayContaining([memorial.id]));
  expect(pending.map((d) => d.id)).not.toContain(s.decisions.opener.id);
  expect(await store.getDecision(A, s.decisions.opener.id)).toMatchObject({ response: "expired", responseReason: "a care moment never becomes a post" });
});

test("M10: only a signed or accepted deal sources a partner moment; any other deal is conflict context only", async () => {
  const store = createMemoryStore();
  await seed(store);
  const talking: MomentDeal = { id: "22222222-2222-4222-8222-222222222222", brand: "Talking Brand", category: "snacks", status: "negotiating", termStart: null, termEnd: null, signed: false };
  const t = scanModel((input) => ({
    moments: [
      moment({ name: "Talking Brand launch", description: "Talking Brand launches a snack on 27 October 2026.", date: "2026-10-27", category: "partner_campaign", based_on: [keyOf(input, "D", "Talking Brand")] }),
      moment({ name: "Acme launch", description: "Acme launches on 28 October 2026.", date: "2026-10-28", category: "partner_campaign", based_on: [keyOf(input, "D", "Acme Hydration")] }),
    ],
    retire: [], path_note: "p",
  }), []);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources([DEAL, talking]), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ written: 1 });
  expect(String(t.calls[0].input)).toMatch(/^D2 \| Talking Brand \| .* \| not confirmed signed \| conflict context only: never a partner moment$/m);
  const o = (await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput;
  expect(o.held).toEqual([{ what: "Talking Brand launch", reason: "no source: its deal is not signed or accepted (conflict context only)" }]);
});

test("M11: retire — passed / cancelled / moved / wrong supersede the fact; not_worth_a_post keeps it and expires only its post; a retire with no reason is held", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  setResponsesTransport(scanModel((input) => ({
    moments: [],
    retire: [
      { key: keyOf(input, "M", "Home opener"), why: "not_worth_a_post", reason: "Too small a crowd." },
      { key: keyOf(input, "M", "Awards gala"), why: "moved", reason: "Moved to December." },
      { key: keyOf(input, "M", "Awards gala"), why: "bored", reason: "x" },
    ],
    path_note: "p",
  }), []));
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  const [opener, gala] = await store.getFacts(A, [s.opener.id, s.gala.id]);
  expect([opener.status, gala.status]).toEqual(["active", "superseded"]);
  expect(await store.getDecision(A, s.decisions.opener.id)).toMatchObject({ response: "expired", responseReason: "the moments scan: not_worth_a_post: Too small a crowd." });
  expect(await store.getDecision(A, s.decisions.gala.id)).toMatchObject({ response: "expired", responseReason: "retired by the moments scan: moved: Moved to December." });
  const o = (await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput;
  expect(o.applied!.retired).toEqual([s.gala.id]);
  expect(o.held).toEqual([{ what: expect.stringMatching(/^retire M\d+$/), reason: "no reason from the list (passed, cancelled, moved, wrong, not_worth_a_post)" }]);
});

test("M12: a run that completed (paid) but never wrote is applied on the retry — no cap check, no second call", async () => {
  const store = createMemoryStore();
  await seed(store);
  // The crash: the model answered and the run completed at $0.40 (over the week's room), then the process died.
  const json = { moments: [moment({ name: "Club regatta", description: "The club regatta is on 24 October 2026.", date: "2026-10-24", source_url: "https://example.org/regatta" })], retire: [], path_note: "p" };
  const id = await store.startRun({ athleteId: A, skillId: "moments", skillVersion: "1.0.0", trigger: "schedule", model: { provider: "openai", model: "gpt-6-luna", effort: "medium" }, parentRef: "workflow:m12:scan" });
  await store.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearchCalls: 4, microUsd: 400_000 }, steps: [], evidenceRead: [], output: { json, sources: [{ url: "https://example.org/regatta" }], queries: ["q"] }, error: null });
  const t = fakeResponses(() => { throw new Error("no call expected"); });
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m12:scan", now: NOW });
  expect(out).toMatchObject({ status: "scanned", runId: id, written: 1 });
  expect(t.calls).toHaveLength(0);
  expect(((await store.getRun(A, id))!.output as MomentsRunOutput).applied!.written).toHaveLength(1);
  // And now it has written, a further retry is a plain reuse.
  expect(await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m12:scan", now: NOW })).toEqual({ status: "reused", runId: id, why: "retried_step" });
});

test("M13: a pending candidate whose moment is no longer active, or has ended, expires — owned and linked alike", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const cand = (factId: string, name: string) => store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: name, why: "w", evidence: [], detail: { kind: "moment", factId, name, date: "2026-10-01", datePrecision: "day", category: "schedule", whyNow: "w", rank: 1, idea: { hook: "h", format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", scannedAt: "2026-10-03T13:00:00.000Z" } });
  const onCup = await cand(s.oldCup.id, "Old cup");                                  // linked (research's), ended
  await store.setFactStatus(A, s.final.id, "superseded");                              // research replaced it meanwhile
  const onFinal = await cand(s.final.id, "League final");
  setResponsesTransport(scanModel(() => ({ moments: [], retire: [], path_note: "p" }), []));
  await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(await store.getDecision(A, onCup.id)).toMatchObject({ response: "expired", responseReason: "the moment has passed" });
  expect(await store.getDecision(A, onFinal.id)).toMatchObject({ response: "expired", responseReason: "its moment is no longer on file" });
  expect((await store.getFacts(A, [s.oldCup.id]))[0].status).toBe("active");        // research's fact untouched
  expect((await store.getDecision(A, s.decisions.opener.id))!.response).toBe("pending");   // a live moment's post stays
});

test("M14: mid-month — a month-only moment in the current month is still coming up, not passed, and a new one is accepted", async () => {
  const store = createMemoryStore();
  await seed(store);
  const [month] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Club month" }, claim: "October is the club's open month.", type: "found", source: src("month"), date: "2026-10-01", datePrecision: "month", confidence: 0.8, runId: null, topic: "moment" }]);
  const t = scanModel(() => ({
    moments: [moment({ name: "Rowing awareness month", description: "October 2026 is a rowing awareness month.", date: "2026-10", date_precision: "month", category: "holiday_awareness", source_url: "https://example.org/aw-month" })],
    retire: [], path_note: "p",
  }), ["https://example.org/aw-month"]);
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: new Date("2026-10-15T13:00:00.000Z") });
  expect(out).toMatchObject({ written: 1, passed: 1 });                              // only the camp (owned, ended)
  expect(String(t.calls[0].input)).toMatch(/^M\d+ \| 2026-10 \| month \| Club month \|/m);
  expect((await store.getFacts(A, [month.id]))[0].status).toBe("active");
  expect((await store.listFacts(A)).find((f) => f.subject.name === "Rowing awareness month")).toMatchObject({ date: "2026-10-01", datePrecision: "month", status: "active" });
});

test("M15: the angle and the source title go through the same word checks", async () => {
  const store = createMemoryStore();
  await seed(store);
  setResponsesTransport(scanModel(() => ({
    moments: [
      moment({ name: "Regatta one", description: "Regatta one is on 24 October 2026.", date: "2026-10-24", source_url: "https://example.org/r1", idea: { hook: "Go.", angle: "the AI feed" } }),
      moment({ name: "Regatta two", description: "Regatta two is on 25 October 2026.", date: "2026-10-25", source_url: "https://example.org/r2", source_title: "Tickets: tickets@example.org" }),
    ],
    retire: [], path_note: "p",
  }), ["https://example.org/r1", "https://example.org/r2"]));
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(((await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput).held).toEqual([
    { what: "Regatta one", reason: "says \"AI\" or \"brain\"" },
    { what: "Regatta two", reason: "carries contact details or an address" },
  ]);
});

test("M16: the idea bank — each candidate post filed once as a time-bound entry, refreshed while new, left once used; care skips it", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const entries = async () => (await store.listDecisions(A, { skillId: "moments", kinds: ["other"] })).filter((d) => d.detail?.kind === "idea");
  const scan = (parentRef: string, build: (input: string) => Record<string, unknown>) => {
    setResponsesTransport(scanModel(build, ["https://example.org/opener-2026", "https://example.org/derby"]));
    return runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef, now: NOW });
  };
  const derby = (over: Record<string, unknown> = {}) => moment({ name: "City derby", description: "The city derby is on 25 October 2026.", date: "2026-10-25", category: "league", source_url: "https://example.org/derby", why_now: "The biggest crowd.", ...over });

  // The first scan files the derby's candidate post (the idea bank is always on since 2 Nov 2026).
  await scan("workflow:b0:scan", () => ({ moments: [derby()], retire: [], path_note: "p" }));
  expect(await entries()).toHaveLength(1);

  // The opener (refreshed) and the derby each get one entry, time-bound to their candidate post.
  await scan("workflow:b1:scan", (input) => ({ moments: [
    moment({ name: "Home opener", description: "The home opener is on 18 October 2026.", date: "2026-10-18", refreshes: keyOf(input, "M", "Home opener"), source_url: "https://example.org/opener-2026", idea: { hook: "OPENER-1", angle: "An angle." } }),
    derby({ refreshes: keyOf(input, "M", "City derby"), idea: { hook: "DERBY-1", angle: "An angle." } }),
  ], retire: [], path_note: "p" }));
  const first = await entries();
  expect(first).toHaveLength(2);
  const byMoment = new Map(first.map((d) => [(d.detail as unknown as IdeaBankEntry).momentDecisionId, d]));
  const opener = byMoment.get(s.decisions.opener.id)!;
  expect(opener.detail as unknown as IdeaBankEntry).toEqual({
    kind: "idea", timeBound: true, pillarKey: null, pillarName: null, momentDecisionId: s.decisions.opener.id, expiresOn: "2026-10-18",
    // moments 1.2.0: the hook, and the angle as its caption angle; the format and the rest are the plan's to pick.
    idea: { hook: "OPENER-1", format: null, platform: "", timing: "" },
    brief: { show: "", captionAngle: "An angle.", avoid: "" }, mediaNeeds: "",
    status: "new", usedInDecisionId: null, adaptedFromIdeaId: null,
  });
  expect(opener).toMatchObject({ suggested: "OPENER-1", response: "pending", evidence: [{ kind: "fact", factId: s.opener.id }] });
  const derbyEntry = [...byMoment].find(([id]) => id !== s.decisions.opener.id)![1];
  // The plan uses the derby's idea.
  await store.updateDecision(A, derbyEntry.id, { detail: { ...derbyEntry.detail, status: "used", usedInDecisionId: "action-1" } });

  // Again: the opener's entry refreshed in place (same id); the used derby entry untouched; nothing new written.
  await scan("workflow:b2:scan", (input) => ({ moments: [
    moment({ name: "Home opener", description: "The home opener is on 18 October 2026.", date: "2026-10-18", refreshes: keyOf(input, "M", "Home opener"), source_url: "https://example.org/opener-2026", idea: { hook: "OPENER-2", angle: "An angle." } }),
    derby({ refreshes: keyOf(input, "M", "City derby"), idea: { hook: "DERBY-2", angle: "An angle." } }),
  ], retire: [], path_note: "p" }));
  const second = await entries();
  expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
  expect((await store.getDecision(A, opener.id))!.detail).toMatchObject({ status: "new", idea: { hook: "OPENER-2", format: null } });
  expect((await store.getDecision(A, opener.id))!.suggested).toBe("OPENER-2");
  expect((await store.getDecision(A, derbyEntry.id))!.detail).toMatchObject({ status: "used", usedInDecisionId: "action-1", idea: { hook: "DERBY-1" } });

  // The opener turns out to be a care moment: its candidate post expires and its entry is skipped (never adapted later).
  await scan("workflow:b3:scan", (input) => ({ moments: [
    moment({ name: "Home opener", description: "The home opener is on 18 October 2026.", date: "2026-10-18", refreshes: keyOf(input, "M", "Home opener"), source_url: "https://example.org/opener-2026", sensitivity: "care" }),
  ], retire: [], path_note: "p" }));
  expect((await store.getDecision(A, s.decisions.opener.id))!.response).toBe("expired");
  expect((await store.getDecision(A, opener.id))!.detail).toMatchObject({ status: "skipped" });
});

test("M17: care skips every idea on the moment, whoever wrote it, even after its candidate expired; the bank never reads them", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const idea = (hook: string, over: Partial<IdeaBankEntry> = {}): IdeaBankEntry => ({
    kind: "idea", timeBound: true, pillarKey: null, pillarName: null, momentDecisionId: null, expiresOn: "2026-10-18",
    idea: { hook, format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m",
    status: "new", usedInDecisionId: null, adaptedFromIdeaId: null, ...over,
  });
  const file = (skillId: string, e: IdeaBankEntry, evidence: Array<{ kind: "fact"; factId: string }> = []) =>
    store.insertDecision(A, { runId: null, skillId, kind: "other", suggested: e.idea.hook, why: "w", evidence, detail: e as unknown as Record<string, unknown> });
  // On the opener (candidate pending): a reverse-pass idea bound to its candidate, a plan row adapted to its event.
  const reverse = await file("post-kit/ideas", idea("REVERSE", { momentDecisionId: s.decisions.opener.id }));
  const adapted = await file("plan", idea("ADAPTED", { adaptedFromIdeaId: "some-old-idea" }), [{ kind: "fact", factId: s.opener.id }]);
  // On the gala: its candidate expired earlier (not worth a post), its scan entry still new.
  await store.respondDecision(A, s.decisions.gala.id, "expired", "the moments scan: not_worth_a_post: x");
  const galaEntry = await file("moments", idea("GALA-ENTRY", { momentDecisionId: s.decisions.gala.id, expiresOn: "2026-11-05" }), [{ kind: "fact", factId: s.gala.id }]);
  // Elsewhere: untouched.
  const other = await file("post-kit/ideas", idea("EVERGREEN", { timeBound: false, expiresOn: null }));

  setResponsesTransport(scanModel((input) => ({ moments: [
    moment({ name: "Home opener", description: "The home opener is on 18 October 2026.", date: "2026-10-18", refreshes: keyOf(input, "M", "Home opener"), source_url: "https://example.org/opener-2026", sensitivity: "care" }),
    moment({ name: "Awards gala", description: "The awards gala is on 5 November 2026.", date: "2026-11-05", refreshes: keyOf(input, "M", "Awards gala"), source_url: "https://example.org/gala-2026", sensitivity: "care" }),
  ], retire: [], path_note: "p" }), ["https://example.org/opener-2026", "https://example.org/gala-2026"]));
  await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:c1:scan", now: NOW });

  for (const row of [reverse, adapted, galaEntry]) expect((await store.getDecision(A, row.id))!.detail).toMatchObject({ status: "skipped" });
  expect((await store.getDecision(A, other.id))!.detail).toMatchObject({ status: "new" });
  // The care facts' ideas are never read by the bank, whatever their status.
  expect((await listBank(store, A)).map((b) => b.decisionId)).toEqual([other.id]);
});

test("M17b: a retire records its reason on the candidate (idea bank on)", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  setResponsesTransport(scanModel((input) => ({ moments: [], retire: [{ key: keyOf(input, "M", "Awards gala"), why: "cancelled", reason: "Called off." }], path_note: "p" }), []));
  await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:c2:scan", now: NOW });
  expect(await store.getDecision(A, s.decisions.gala.id)).toMatchObject({ response: "expired", detail: { kind: "moment", retiredWhy: "cancelled" } });
});

// ─── M-G: her guardrails (moments 1.1.0) ─────────────────────────────────────────────────────────────────────────

test("M-G1: the scan's input carries her avoid-list, never-use names, current partners and the Brief's conflicts", async () => {
  const store = createMemoryStore();
  await seed(store);
  await store.writeBrief(A, {
    summary: "A club rower with a local following.", sections: [], factIds: [], runId: null,
    internal: { currentSponsors: [{ name: "Acme Hydration", factIds: [] }], pastSponsors: [], exclusivityConflicts: [{ what: "Acme holds the sports drink category.", blocks: ["other sports drinks"], factIds: [] }] },
    display: { stage: { label: "Club rower", band: "developing", confidence: 0.7, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] } },
  });
  let seen = "";
  setResponsesTransport(scanModel((input) => { seen = input; return { moments: [], retire: [], path_note: "n" }; }, []));
  await runMomentsScan({ store, sources: sources([DEAL], [pref("Never use: Wrenna, Juno"), pref("No energy-drink brands")]), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(seen).toContain("AVOID-LIST (the athlete's own: honour every one)\n- No energy-drink brands\nNever use these names anywhere: Wrenna, Juno");
  expect(seen).toContain("CURRENT PARTNERS\n- Acme Hydration");
  expect(seen).toContain("EXCLUSIVITY AND CATEGORY CONFLICTS (what each blocks)\n- Acme holds the sports drink category. | blocks: other sports drinks");
});

test("M-G2: a moment that names one of her never-use names is held by code, its words never stored", async () => {
  const store = createMemoryStore();
  await seed(store);
  setResponsesTransport(scanModel(() => ({
    moments: [
      moment({ name: "Wrenna's first regatta", description: "Wrenna races her first junior regatta on 20 October 2026.", source_url: "https://example.org/junior", why_now: "A family moment." }),
      moment({ name: "Club sculling race", description: "Riverside Club hosts a sculling race on 24 October 2026.", date: "2026-10-24", source_url: "https://example.org/sculls", why_now: "Home water.", idea: { hook: "Juno would love this one.", angle: "An angle." } }),
      moment({ name: "Autumn head race", description: "The autumn head race is on 25 October 2026.", date: "2026-10-25", source_url: "https://example.org/head", why_now: "The season's first big race." }),
      // Incomplete (no hook) AND naming her: the never-use hold comes first, so the incomplete hold never records the name.
      moment({ name: "Juno's club day", description: "The club day is on 26 October 2026.", date: "2026-10-26", source_url: "https://example.org/head", idea: { hook: "", angle: "An angle." } }),
    ],
    retire: [], path_note: "n",
  }), ["https://example.org/junior", "https://example.org/sculls", "https://example.org/head"]));
  const out = await runMomentsScan({ store, sources: sources([DEAL], [pref("Never use: Wrenna, Juno")]), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ status: "scanned", written: 1 });
  const facts = await store.listFacts(A);
  expect(facts.some((f) => /Wrenna|Juno/.test(`${f.subject.name} ${f.claim}`))).toBe(false);
  expect(facts.some((f) => f.subject.name === "Autumn head race")).toBe(true);
  const run = await store.getRun(A, (out as any).runId);
  const held = ((run?.output ?? {}) as MomentsRunOutput).held ?? [];
  expect(held.filter((h) => h.reason === "uses a name the athlete marked never to use")).toEqual([
    { what: "(a moment not stored)", reason: "uses a name the athlete marked never to use" },
    { what: "(a moment not stored)", reason: "uses a name the athlete marked never to use" },
    { what: "(a moment not stored)", reason: "uses a name the athlete marked never to use" },
  ]);
  // Nowhere in the stored run: not the held list, not the model's JSON (sanitizeMoments drops them before storage).
  expect(JSON.stringify(run?.output ?? {})).not.toMatch(/Wrenna|Juno/);
  // Direct: applyMoments alone (a JSON that reached code unsanitised) still holds an incomplete one without its name.
  const built = await buildMomentsInput(store, sources([DEAL], [pref("Never use: Juno")]), A, NOW);
  const direct = await applyMoments(store, A, "run-x", { moments: [moment({ name: "Juno's club day", idea: { hook: "", angle: "An angle." } })], retire: [] }, { ...built, seen: [], now: NOW });
  expect(direct.held).toEqual([{ what: "(a moment not stored)", reason: "uses a name the athlete marked never to use" }]);
});

// ─── M18: the search guard (moments 1.2.0) ───────────────────────────────────────────────────────────────────────

test("M18: a scan that made no web search is retried once, told to search the other kinds first; the retry's answer is applied", async () => {
  const store = createMemoryStore();
  await seed(store);
  const regatta = { moments: [moment({ name: "Club regatta", description: "The club regatta is on 24 October 2026.", date: "2026-10-24", source_url: "https://example.org/regatta" })], retire: [], path_note: "p" };
  const t: FakeTransport = fakeResponses(() => (t.calls.length === 1
    ? { json: { moments: [], retire: [], path_note: "only the schedule" }, queries: [] }
    : { json: regatta, sources: [{ url: "https://example.org/regatta", title: "page" }], queries: ["league dates"] }));
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m18:scan", now: NOW });
  expect(t.calls).toHaveLength(2);
  expect(unfencedInput(t.calls[0].input)).not.toContain("made no web search");
  expect(unfencedInput(t.calls[1].input)).toMatch(/^NOTE: the last attempt at this scan made no web search\. Before you choose anything, search the web for each of the other kinds first/);
  expect(out).toMatchObject({ status: "scanned", written: 1, searches: 1, retried: true });
  const runs = await store.listRunsSince(A, { since: "2026-01-01T00:00:00.000Z", skillId: "moments" });
  const first = runs.find((r) => r.parentRef === "workflow:m18:scan")!;
  const retry = runs.find((r) => r.parentRef === "workflow:m18:scan:retry")!;
  expect((first.output as MomentsRunOutput).search_guard).toEqual({ searches: 0, retry_run_id: retry.id });
  expect((retry.output as MomentsRunOutput).search_guard).toEqual({ searches: 1, retried: true });
  expect((retry.output as MomentsRunOutput).applied!.written).toHaveLength(1);
  // A retried workflow step finds the retry's written run: a plain reuse, no third call.
  expect(await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:m18:scan", now: NOW })).toEqual({ status: "reused", runId: retry.id, why: "retried_step" });
  expect(t.calls).toHaveLength(2);
});

test("M18b: a retry that still searches nothing is not a failure — its answer is applied and the run says so", async () => {
  const store = createMemoryStore();
  await seed(store);
  const t = fakeResponses(() => ({ json: { moments: [], retire: [], path_note: "nothing searched" }, queries: [] }));
  setResponsesTransport(t);
  const out = await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(t.calls).toHaveLength(2);
  expect(out).toMatchObject({ status: "scanned", searches: 0, retried: true });
  const o = (await store.getRun(A, (out as any).runId))!.output as MomentsRunOutput;
  expect(o.search_guard).toMatchObject({ searches: 0, retried: true, note: expect.stringMatching(/retried once and still made no web search/) });
});

test("M18c: no retry when a scan searched, or when the week's cap leaves no room for a second scan", async () => {
  const store = createMemoryStore();
  await seed(store);
  const searched = scanModel(() => ({ moments: [], retire: [], path_note: "p" }), []);
  setResponsesTransport(searched);
  expect(await runMomentsScan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW })).toMatchObject({ retried: false, searches: 1 });
  expect(searched.calls).toHaveLength(1);

  // A week already near its cap: the first scan fits its reserve, a second would not.
  process.env.AGENT_MOMENTS_WEEK_CAP_USD = "0.25";
  try {
    const other = createMemoryStore();
    await seed(other);
    const none = fakeResponses(() => ({ json: { moments: [], retire: [], path_note: "p" }, queries: [] }));
    setResponsesTransport(none);
    expect(await runMomentsScan({ store: other, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW })).toMatchObject({ status: "scanned", retried: false, searches: 0 });
    expect(none.calls).toHaveLength(1);
  } finally {
    delete process.env.AGENT_MOMENTS_WEEK_CAP_USD;
  }
});
