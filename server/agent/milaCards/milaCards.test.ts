/**
 * milaCards.test.ts — the card system v2's server side (MILA_CARDS_V2): each producer's display rule, the image chooser
 * (the server picks every image; ≤ 2 faces across a turn), the text budgets, and what each tap records. In memory: no
 * database, no GCS, no provider (CardMediaDeps is faked). Fictional athlete and brands only.
 */
jest.mock("../../db", () => ({ db: {} }));
// The Welcome registry's choice record, in memory (choices.ts is DB-backed; its own tests run it on PGlite). The real
// turnOn.ts (offerFor, turnOnFromCard, declineFromCard) runs on top of it.
type MockChoice = { state: string; via: string; version: number; cooldownUntil: string | null };
const mockChoices = new Map<string, MockChoice>();
const mockSets: Array<Record<string, unknown>> = [];
jest.mock("../welcome/choices", () => ({
  getChoice: async (athleteId: string, capability: string) => {
    const c = mockChoices.get(`${athleteId}|${capability}`);
    return { athleteId, capability, accountRef: null, state: c?.state ?? "unset", via: c?.via ?? null, consentVersion: null, consent: null, notNowCount: 0, cooldownUntil: c?.cooldownUntil ?? null, version: c?.version ?? 0, decidedAt: null };
  },
  setChoice: async (i: { athleteId: string; capability: string; to: string; via: string; expectedVersion?: number }) => {
    mockSets.push(i);
    const k = `${i.athleteId}|${i.capability}`;
    const cur = mockChoices.get(k);
    const version = cur?.version ?? 0;
    if (i.expectedVersion !== undefined && i.expectedVersion !== version) return { ok: false, error: "version_conflict", message: "the choice moved" };
    const cooldownUntil = i.to === "not_now" ? new Date(Date.now() + 14 * 86_400_000).toISOString() : null;
    mockChoices.set(k, { state: i.to, via: i.via, version: version + 1, cooldownUntil });
    return { ok: true, changed: true, choice: {} };
  },
}));

import { MILA_CARD_SCHEMAS, toMilaCardDto } from "../../../shared/milaCards";
import type { IdeaBankEntry } from "../../../shared/postKit";
import { createMemoryStore, type AgentStore } from "../research/store";
import type { ToolContext, TurnState } from "../tools";
import { budgetFor, libraryMedia, type CardMediaDeps } from "./media";
import { expireIgnored, pausedPillars, recordOutcome } from "./outcomes";
import { MILA_CARD_TOOL_DESCRIPTIONS } from "./prompts";
import { fit, milaCardTools } from "./tools";
import { cardSurface } from "./surface";

const A = "00000000-0000-4000-8000-0000000000aa";
// The real clock: the memory store stamps rows with the wall clock, so a fixed date here would drift past it.
const NOW = new Date();
const ENV = process.env.MILA_CARDS_V2;
beforeAll(() => { process.env.MILA_CARDS_V2 = "true"; });
afterAll(() => { process.env.MILA_CARDS_V2 = ENV; });

function fakeMedia(over: Partial<CardMediaDeps> = {}): CardMediaDeps {
  return {
    sportOf: async () => "volleyball",
    atmosphere: async (_s, slot, used) => (used.has("atm1") ? { id: "atm2", gcsPath: "atm/2.jpg" } : { id: "atm1", gcsPath: `atm/1-${slot.key}.jpg` }),
    library: async (_a, ids) => new Map(ids.map((id) => [id, { id, athletePresent: !id.startsWith("noface"), gcsPath: `lib/${id}.jpg`, mediaType: "photo" }])),
    sign: async (p) => `https://signed.example/${p}`,
    brand: async (name) => (name === "Cobaltwave Hydration" ? { name, domain: "cobaltwave.example", logoUrl: null, coverUrl: "https://cdn.example/cover.jpg" } : null),
    ...over,
  };
}
const turn = (keys: Record<string, string> = {}, conversationId = "conv-1"): TurnState => ({ factKeys: new Map(Object.entries(keys)), conversationId, offeredConnectors: [], today: "2026-11-03" });
const ctxOf = (t: TurnState): ToolContext => ({ athleteId: A, runId: "run-1", skillId: "chat", turn: t });
function tools(store: AgentStore, media = fakeMedia()) {
  const all = milaCardTools(store, { media, now: () => NOW });
  return Object.fromEntries(all.map((t) => [t.name, t]));
}
async function run(store: AgentStore, name: string, args: unknown, t = turn(), media = fakeMedia()) {
  const tool = tools(store, media)[name];
  const parsed = tool.args.safeParse(args);
  if (!parsed.success) return { result: { status: "error", reason: "invalid args" } as Record<string, unknown>, card: null };
  const ctx = ctxOf(t);
  const result = (await tool.execute!(ctx, parsed.data)) as Record<string, unknown>;
  const card = result.status === "ok" ? tool.card!(result, ctx) : null;
  return { result, card };
}
const dto = (card: unknown) => {
  const r = toMilaCardDto(card);
  if (!r.ok) throw new Error(`card failed its schema: ${r.kind} ${r.reason}`);
  return r.dto;
};

const idea = (over: Partial<IdeaBankEntry> = {}): IdeaBankEntry => ({
  kind: "idea", timeBound: false, pillarKey: "P1", pillarName: "Training days", momentDecisionId: null, expiresOn: null,
  idea: { hook: "Game-day routine in 15 seconds", format: "reel", platform: "instagram", timing: "Before your home opener" },
  brief: { show: "warm-up", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", status: "new", usedInDecisionId: null, adaptedFromIdeaId: null, ...over,
});
async function fileIdea(store: AgentStore, over: Partial<IdeaBankEntry> = {}, media: string[] = []) {
  return store.insertDecision(A, {
    runId: null, skillId: "post-kit/ideas", kind: "other", suggested: "h", why: "w",
    evidence: media.map((id) => ({ kind: "record" as const, table: "media_assets", id })), detail: idea(over) as unknown as Record<string, unknown>,
  });
}

describe("the producers' descriptions are the design page's words", () => {
  test("each has its model-facing line, then Use when and Don't use when", () => {
    expect(Object.keys(MILA_CARD_TOOL_DESCRIPTIONS)).toEqual(["share_insight", "ideas_suggest", "offer_capability", "ask_once", "answer_with_sources"]);
    for (const d of Object.values(MILA_CARD_TOOL_DESCRIPTIONS)) expect(d).toMatch(/\n\nUse when:\n- .+\n\nDon't use when:\n- /s);
    expect(MILA_CARD_TOOL_DESCRIPTIONS.share_insight.startsWith("Show one thing that changed in the athlete's own data.")).toBe(true);
    expect(MILA_CARD_TOOL_DESCRIPTIONS.offer_capability).toContain("A yes in words is not a yes: show the card.");
  });
  test("flag off: every producer is left out of the run", () => {
    process.env.MILA_CARDS_V2 = "false";
    expect(milaCardTools(createMemoryStore()).map((t) => t.enabled!())).toEqual([false, false, false, false, false]);
    process.env.MILA_CARDS_V2 = "true";
  });
});

describe("text budgets are the schema's", () => {
  test("a 14-word headline is refused by the tool and by the DTO", async () => {
    const store = createMemoryStore();
    const long = "Your training reels are being saved twice as often as they were in September";
    const { result } = await run(store, "answer_with_sources", { headline: long, line: "x", sources: [{ label: "S", url: "https://a.example/x" }] });
    expect(result.status).toBe("error");
    const bad = MILA_CARD_SCHEMAS.answer.shape.fields.shape.headline.safeParse(long);
    expect(bad.success).toBe(false);
    expect(MILA_CARD_SCHEMAS.answer.shape.fields.shape.line.safeParse("x".repeat(91)).success).toBe(false);
    expect(MILA_CARD_SCHEMAS.answer.shape.fields.shape.line.safeParse("x".repeat(90)).success).toBe(true);
  });
  test("an image URL the model passes is stripped: the server resolves media", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "answer_with_sources", {
      headline: "Yes, they run real athlete campaigns", line: "Since 2024, mostly with college runners and swimmers.", brand_name: "Cobaltwave Hydration",
      image_url: "https://evil.example/x.png", sources: [{ label: "Press", url: "https://cobaltwave.example/press" }],
    });
    const d = dto(card);
    expect(JSON.stringify(d)).not.toContain("evil.example");
    expect(d.type === "answer" && d.data.fields.media).toMatchObject({ kind: "brand_cover", url: "https://cdn.example/cover.jpg" });
  });
  test("fit cuts an old hook at a word", () => {
    expect(fit("A very long hook that goes well past the forty eight character budget", 48).length).toBeLessThanOrEqual(48);
  });
});

describe("share_insight", () => {
  async function facts(store: AgentStore, sensitive = false) {
    return store.insertFacts(A, [
      { subject: { kind: "athlete", name: "Sam Rivera" }, claim: "Reel saves were 1940 in October, up 96% from 990 in September.", type: "measured", source: { url: "https://instagram.com/x", title: "Instagram" }, date: "2026-11-01", confidence: 1, runId: null, ...(sensitive ? { sensitive: true, careKind: "personal" as const } : {}) },
    ]);
  }
  const args = { angle: "change", headline: "Your reel saves doubled this month", line: "Gear and nutrition brands look for saves before reaching out.", fact_keys: ["F1"], series: [990, 1940], figures: [{ label: "Saves", value: "1,940", note: "+96%" }] };

  test("a sourced change: a chart card, a decision row, and a DTO", async () => {
    const store = createMemoryStore();
    const [f] = await facts(store);
    const { result, card } = await run(store, "share_insight", args, turn({ F1: f.id }));
    expect(result.status).toBe("ok");
    const d = dto(card);
    expect(d.type).toBe("insight");
    if (d.type !== "insight") return;
    expect(d.data.fields.media.kind).toBe("chart");
    expect(d.data.fields.media.chart).toMatchObject({ points: [990, 1940], highlight: 1, big: "1,940", delta: "+96%" });
    expect(d.data.fields.sources[0]).toMatchObject({ label: "Instagram", site: "instagram.com" });
    expect((await store.getDecision(A, d.data.fields.decisionId))?.skillId).toBe("insight");
  });
  test("a number in the headline, line or a figure's note that no cited fact states is refused", async () => {
    const store = createMemoryStore();
    const [f] = await facts(store);
    for (const over of [{ headline: "Your reel saves tripled: up 300%" }, { line: "Brands paid 4,000 for reels like these." }, { figures: [{ label: "Saves", value: "1,940", note: "+250%" }] }]) {
      expect((await run(store, "share_insight", { ...args, ...over }, turn({ F1: f.id }))).result).toMatchObject({ status: "error", reason: expect.stringContaining("not found in the facts") });
    }
  });
  test("a figure no cited fact states is refused", async () => {
    const store = createMemoryStore();
    const [f] = await facts(store);
    const { result } = await run(store, "share_insight", { ...args, series: [990, 2500] }, turn({ F1: f.id }));
    expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("2500") });
  });
  test("a care fact, or the same angle within 14 days, shows no card", async () => {
    const care = createMemoryStore();
    const [c] = await facts(care, true);
    expect((await run(care, "share_insight", args, turn({ F1: c.id }))).result.status).toBe("error");
    const store = createMemoryStore();
    const [f] = await facts(store);
    expect((await run(store, "share_insight", args, turn({ F1: f.id }))).result.status).toBe("ok");
    expect((await run(store, "share_insight", args, turn({ F1: f.id }))).result).toMatchObject({ status: "error", reason: expect.stringContaining("14 days") });
  });
  test("no fact behind it: no card", async () => {
    expect((await run(createMemoryStore(), "share_insight", args, turn({}))).result.status).toBe("error");
  });
});

describe("ideas_suggest", () => {
  test("live ideas become one carousel; the third thumbnail is face-free after two faces", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store, {}, ["face1"]);
    const b = await fileIdea(store, { idea: { hook: "Five serves, slowed down", format: "carousel", platform: "instagram", timing: "t" } }, ["face2"]);
    const c = await fileIdea(store, { idea: { hook: "Your locker room playlist, as a story", format: "story", platform: "instagram", timing: "t" } }, ["face3", "noface3"]);
    const { card } = await run(store, "ideas_suggest", { idea_ids: [a.id, b.id, c.id] });
    const d = dto(card);
    if (d.type !== "ideas") throw new Error("not ideas");
    expect(d.data.fields.items.map((i) => i.media.hasFace)).toEqual([true, true, false]);
    expect(d.data.fields.items[2].media.mediaId).toBe("noface3");
  });
  test("an id outside the bank is refused (never invent an idea)", async () => {
    const store = createMemoryStore();
    await fileIdea(store);
    expect((await run(store, "ideas_suggest", { idea_ids: ["not-an-idea"] })).result.status).toBe("error");
  });
  test("one set per chat per day", async () => {
    const store = createMemoryStore();
    await fileIdea(store);
    expect((await run(store, "ideas_suggest", {})).result.status).toBe("ok");
    expect((await run(store, "ideas_suggest", {})).result).toMatchObject({ status: "error", reason: expect.stringContaining("already shown") });
  });
  test("Don't suggest this pauses the pillar for 30 days: its ideas are not shown", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store);
    await fileIdea(store, { idea: { hook: "Another training-day idea", format: "reel", platform: "instagram", timing: "t" } });
    const r = await recordOutcome(store, A, { card: "idea", ref: a.id, outcome: "never" }, { addPreference: async () => null, now: () => NOW });
    expect(r).toEqual({ ok: true, receipt: "I won't suggest this one again." });
    expect([...(await pausedPillars(store, A, NOW))]).toEqual(["training days"]);
    expect((await run(store, "ideas_suggest", {}, turn({}, "conv-2"))).result.status).toBe("error");
    expect((await pausedPillars(store, A, new Date(NOW.getTime() + 31 * 86_400_000))).size).toBe(0);
  });
  test("Don't suggest this twice pauses ONE pillar; the idea cannot be brought back by a later tap", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store);
    const deps = { addPreference: async () => null, now: () => NOW };
    await recordOutcome(store, A, { card: "idea", ref: a.id, outcome: "never" }, deps);
    expect(await recordOutcome(store, A, { card: "idea", ref: a.id, outcome: "never" }, deps)).toEqual({ ok: true, receipt: "I won't suggest this one again." });
    expect(await store.listDecisions(A, { skillId: "mila-cards/pillar-pause" })).toHaveLength(1);
    expect(await recordOutcome(store, A, { card: "idea", ref: a.id, outcome: "accepted", action: "idea_used" }, deps)).toMatchObject({ ok: false, status: 409 });
  });
  test("one athlete cannot record a tap on another athlete's card", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store);
    const B = "00000000-0000-4000-8000-0000000000bb";
    expect(await recordOutcome(store, B, { card: "idea", ref: a.id, outcome: "never" }, { addPreference: async () => null, now: () => NOW })).toMatchObject({ ok: false, status: 404 });
    expect((await store.getDecision(A, a.id))?.detail?.cardTap).toBeUndefined();
    expect(await store.listDecisions(B, { skillId: "mila-cards/pillar-pause" })).toHaveLength(0);
  });
});

describe("offer_capability → the Welcome registry (mila_choices)", () => {
  const WELCOME = process.env.MILA_WELCOME, KITS = process.env.AGENT_POST_KITS;
  beforeAll(() => { process.env.MILA_WELCOME = "true"; process.env.AGENT_POST_KITS = "true"; });
  afterAll(() => { process.env.MILA_WELCOME = WELCOME; process.env.AGENT_POST_KITS = KITS; });
  beforeEach(() => { mockChoices.clear(); mockSets.length = 0; });

  test("a registry capability with a presentation: the registry's consent words and version on the card", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const d = dto(card);
    if (d.type !== "turn-on") throw new Error("not turn-on");
    expect(d.data.fields.sheet.rows.map((r) => r.title)).toEqual(["Ideas from your own shots", "You choose what Mila can do", "Keep an eye on it"]);
    expect(d.data.fields.state).toBe("unset");
    expect(d.data.fields.consentVersion).toBe("post_ideas/1");
    expect(d.data.fields.consent).toEqual({ reads: ["Look at your newly tagged photos and videos and suggest posts"], drafts: false, alwaysAsks: ["Posting anything"], onRevoke: "stop_and_keep" });
    expect(d.data.fields.choiceVersion).toBe(0);
  });
  test("the card and sheet promise only what post_ideas/1 covers: no schedule, no calendar, no 'every game'", async () => {
    const { PRESENTATIONS } = await import("./capabilities");
    const p = PRESENTATIONS.find((x) => x.key === "post_ideas")!;
    const copy = [p.headline, p.line, ...p.consentShort, p.sheet.purpose, ...p.sheet.rows.flatMap((r) => [r.title, r.line]), p.sheet.legal].join(" ");
    expect(copy).not.toMatch(/schedule|calendar|every game/i);
  });
  test("refused while MILA_WELCOME is off (no legacy 'consented' path)", async () => {
    delete process.env.MILA_WELCOME;
    expect((await run(createMemoryStore(), "offer_capability", { key: "post_ideas" })).result).toMatchObject({ status: "error", reason: expect.stringContaining("off") });
    process.env.MILA_WELCOME = "true";
  });
  test("at most one offer in 24 h; Never is recorded in mila_choices and is final", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    expect((await run(store, "offer_capability", { key: "post_ideas" })).result.status).toBe("error");
    const ref = (card!.payload as { decisionId: string }).decisionId;
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "never" }, { addPreference: async () => null })).toMatchObject({ ok: true });
    expect((await store.getDecision(A, ref))).toMatchObject({ response: "skipped", responseReason: "never" });
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "never", via: "card" });
    const later = milaCardTools(store, { media: fakeMedia(), now: () => new Date(NOW.getTime() + 2 * 86_400_000) }).find((t) => t.name === "offer_capability")!;
    expect(await later.execute!(ctxOf(turn({}, "conv-5")), { key: "post_ideas" })).toMatchObject({ status: "error", reason: expect.stringContaining("never") });
  });
  test("Turn on: only the sheet's button with the version it showed; it ENABLES the capability through setChoice", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    const deps = { addPreference: async () => null };
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "accepted" }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "accepted", action: "enabled" }, deps)).toMatchObject({ ok: false, status: 409 });
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "accepted", action: "enabled", consentVersion: "post_ideas/0" }, deps)).toMatchObject({ ok: false, status: 409 });
    expect((await store.getDecision(A, ref))?.response).toBe("pending");
    expect(mockSets).toHaveLength(0);
    const tap = { card: "turn-on" as const, ref, outcome: "accepted" as const, action: "enabled" as const, consentVersion: "post_ideas/1" };
    expect(await recordOutcome(store, A, tap, deps)).toEqual({ ok: true, receipt: "On. Turn it off any time in Me." });
    expect(mockSets).toEqual([expect.objectContaining({ athleteId: A, capability: "post_ideas", to: "enabled", via: "card", expectedVersion: 0 })]);
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "enabled" });
    expect(await store.getDecision(A, ref)).toMatchObject({ response: "accepted", responseReason: "enabled" });
    // A double tap is the same answer (idempotent, one yes); a later "Not now" cannot undo it silently.
    expect(await recordOutcome(store, A, tap, deps)).toMatchObject({ ok: true });
    expect(mockSets).toHaveLength(1);
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toMatchObject({ ok: false, status: 409 });
    const later = milaCardTools(store, { media: fakeMedia(), now: () => new Date(NOW.getTime() + 2 * 86_400_000) }).find((t) => t.name === "offer_capability")!;
    expect(await later.execute!(ctxOf(turn({}, "conv-5")), { key: "post_ideas" })).toMatchObject({ status: "error", reason: expect.stringContaining("already on") });
  });
  test("a choice that moved since the card was drawn is refused (no stale yes)", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    mockChoices.set(`${A}|post_ideas`, { state: "never", via: "me", version: 1, cooldownUntil: null });
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "accepted", action: "enabled", consentVersion: "post_ideas/1" }, { addPreference: async () => null })).toMatchObject({ ok: false, status: 409 });
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "never" });
  });
  test("a card already answered Not now (or expired) cannot switch it on: 409 and nothing written to the registry", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, { addPreference: async () => null })).toMatchObject({ ok: true });
    mockSets.length = 0;
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "accepted", action: "enabled", consentVersion: "post_ideas/1" }, { addPreference: async () => null }))
      .toEqual({ ok: false, status: 409, error: "already skipped" });
    expect(mockSets.filter((x: any) => x.to === "enabled")).toEqual([]);
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "not_now" });
  });
  test("Not now: a decline the registry does not record is an error and the card stays pending; the retry records it", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    let fail = true;
    const declines: string[] = [];
    const turnOn = {
      enable: async () => ({ ok: true as const }),
      stateOf: async () => "unset",
      decline: async (_a: string, _k: string, _r: string | null, to: string) => {
        declines.push(to);
        return fail ? { ok: false as const, error: "version_conflict", message: "the choice moved" } : { ok: true as const };
      },
    };
    const deps = { addPreference: async () => null, turnOn };
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toEqual({ ok: false, status: 500, error: "Could not save that. Try again." });
    expect((await store.getDecision(A, ref))?.response).toBe("pending");
    fail = false;
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toEqual({ ok: true, receipt: "OK. I'll ask again only if it comes up." });
    expect(await store.getDecision(A, ref)).toMatchObject({ response: "skipped", responseReason: "not_now" });
    expect(declines).toEqual(["not_now", "not_now"]);
  });
  test("an already-declined card: the same answer is ok without a second decline; another answer is 409", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    const deps = { addPreference: async () => null };
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toMatchObject({ ok: true });
    expect(mockSets).toHaveLength(1);
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toEqual({ ok: true, receipt: "OK. I'll ask again only if it comes up." });
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "never" }, deps)).toEqual({ ok: false, status: 409, error: "already skipped" });
    expect(mockSets).toHaveLength(1);   // one decline, one cooldown step
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "not_now", version: 1 });
  });
  test("a stale card for something already on: Not now / Never close it as superseded and never turn it off", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    mockChoices.set(`${A}|post_ideas`, { state: "enabled", via: "me", version: 1, cooldownUntil: null });
    const deps = { addPreference: async () => null };
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toEqual({ ok: true, receipt: "It's already on. You can change it in Me." });
    expect(await store.getDecision(A, ref)).toMatchObject({ response: "skipped", responseReason: "already_on" });
    expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "never" }, deps)).toEqual({ ok: true, receipt: "It's already on. You can change it in Me." });
    expect(mockSets).toEqual([]);
    expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state: "enabled", version: 1 });
  });
  for (const state of ["paused", "revoked"] as const) {
    test(`a stale card for something ${state} in Me: Not now / Never close it as decided in Me, nothing declined`, async () => {
      const store = createMemoryStore();
      const { card } = await run(store, "offer_capability", { key: "post_ideas" });
      const ref = (card!.payload as { decisionId: string }).decisionId;
      mockChoices.set(`${A}|post_ideas`, { state, via: "me", version: 2, cooldownUntil: null });
      const deps = { addPreference: async () => null };
      expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "never" }, deps)).toEqual({ ok: true, receipt: "You've already set this in Me." });
      expect(await store.getDecision(A, ref)).toMatchObject({ response: "skipped", responseReason: "decided_in_me" });
      expect(await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, deps)).toEqual({ ok: true, receipt: "You've already set this in Me." });
      expect(mockSets).toEqual([]);
      expect(mockChoices.get(`${A}|post_ideas`)).toMatchObject({ state, version: 2 });
    });
  }
  test("Not now starts the 14-day cooldown (the registry's)", async () => {
    const store = createMemoryStore();
    const { card } = await run(store, "offer_capability", { key: "post_ideas" });
    const ref = (card!.payload as { decisionId: string }).decisionId;
    await recordOutcome(store, A, { card: "turn-on", ref, outcome: "not_now" }, { addPreference: async () => null });
    const later = (days: number) => milaCardTools(store, { media: fakeMedia(), now: () => new Date(Date.now() + days * 86_400_000) }).find((t) => t.name === "offer_capability")!;
    const ctx = ctxOf(turn({}, "conv-7"));
    expect(await later(10).execute!(ctx, { key: "post_ideas" })).toMatchObject({ status: "error", reason: expect.stringContaining("not now") });
    expect(await later(15).execute!(ctx, { key: "post_ideas" })).toMatchObject({ status: "ok" });
  });
});

describe("ask_once", () => {
  const args = {
    question: "That's the second brand this month offering free product only. What should I do with these?",
    context: "2 product-only offers this month", key: "product_only_offers", save_as: "standing_rule", topic: "Free-product offers",
    brand_names: ["Brightleaf Foods", "Kitewear"],
    choices: [
      { label: "Always show me", rule: "Always show me product-only offers." },
      { label: "Only brands I already use", rule: "Only show product offers from brands you already use." },
      { label: "Set them aside", rule: "Set product-only offers aside." },
    ],
  };
  test("a quick-question card with the once block, the brands' logos and Something else…", async () => {
    const store = createMemoryStore();
    const d = dto((await run(store, "ask_once", args)).card);
    if (d.type !== "quick-question") throw new Error("not a question");
    expect(d.data.fields.once).toMatchObject({ key: "product_only_offers", somethingElse: true, prefill: "Free-product offers: " });
    expect(d.data.fields.media).toMatchObject({ kind: "brand_logo", brands: [{ name: "Brightleaf Foods" }, { name: "Kitewear" }] });
  });
  test("a double tap (or a retry) saves ONE rule; a second, different answer is a conflict", async () => {
    const store = createMemoryStore();
    const d = dto((await run(store, "ask_once", args)).card);
    if (d.type !== "quick-question") throw new Error("not a question");
    const saved: unknown[] = [];
    const deps = { addPreference: async (_a: string, p: unknown) => { saved.push(p); } };
    const ref = d.data.fields.once!.decisionId;
    const [r1, r2] = await Promise.all([
      recordOutcome(store, A, { card: "once", ref, outcome: "accepted", choice: 0 }, deps),
      recordOutcome(store, A, { card: "once", ref, outcome: "accepted", choice: 0 }, deps),
    ]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    expect(saved).toHaveLength(1);
    expect(await recordOutcome(store, A, { card: "once", ref, outcome: "edited" }, deps)).toMatchObject({ ok: false, status: 409 });
  });
  test("a rule that fails to save leaves the question open for their next tap", async () => {
    const store = createMemoryStore();
    const d = dto((await run(store, "ask_once", args)).card);
    if (d.type !== "quick-question") throw new Error("not a question");
    const ref = d.data.fields.once!.decisionId;
    await expect(recordOutcome(store, A, { card: "once", ref, outcome: "accepted", choice: 0 }, { addPreference: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
    expect((await store.getDecision(A, ref))?.response).toBe("pending");
  });
  test("a choice saves the STORED rule as a preference; the key is answered and never asked again", async () => {
    const store = createMemoryStore();
    const d = dto((await run(store, "ask_once", args)).card);
    if (d.type !== "quick-question") throw new Error("not a question");
    const saved: unknown[] = [];
    const r = await recordOutcome(store, A, { card: "once", ref: d.data.fields.once!.decisionId, outcome: "accepted", choice: 1 }, { addPreference: async (_a, p) => { saved.push(p); } });
    expect(r).toEqual({ ok: true, receipt: "Saved as your rule." });
    expect(saved).toEqual([{ kind: "standing_rule", statement: "Only show product offers from brands you already use.", source: "said" }]);
    expect((await run(store, "ask_once", args, turn({}, "conv-9"))).result).toMatchObject({ status: "error", reason: expect.stringContaining("already answered") });
  });
  test("an option that would send is refused; one question per chat", async () => {
    const store = createMemoryStore();
    expect((await run(store, "ask_once", { ...args, choices: [{ label: "Reply for me", rule: "Send a yes." }, args.choices[0]] })).result.status).toBe("error");
    expect((await run(store, "ask_once", args)).result.status).toBe("ok");
    expect((await run(store, "ask_once", { ...args, key: "other_key" })).result).toMatchObject({ status: "error", reason: expect.stringContaining("this chat") });
  });
});

describe("answer_with_sources", () => {
  test("no https source: words only, no card", async () => {
    expect((await run(createMemoryStore(), "answer_with_sources", { headline: "Nothing found", line: "x", sources: [{ label: "x", url: "javascript:alert(1)" }] })).result.status).toBe("error");
  });
  test("stats with no brand: a chart from the figures", async () => {
    const d = dto((await run(createMemoryStore(), "answer_with_sources", {
      headline: "Your reels did well this month", line: "Saves led the way.", stats: [{ label: "Saves", value: "1,940" }, { label: "Shares", value: "310" }],
      sources: [{ label: "Instagram", url: "https://instagram.com/insights" }],
    })).card);
    expect(d.type === "answer" && d.data.fields.media.kind).toBe("chart");
  });
  test("a list row keeps citing ITS page when a non-https source before it is dropped", async () => {
    const d = dto((await run(createMemoryStore(), "answer_with_sources", {
      headline: "Cobaltwave looks legit", line: "Two college deals this year.",
      list: [{ lead: "Mar", text: "Signed a setter", source: 2 }, { lead: "Jun", text: "Signed a libero", source: 0 }],
      sources: [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Press", url: "https://cobaltwave.example/press" }, { label: "News", url: "https://collegesportsdaily.example/refill" }],
    })).card);
    const f = d.type === "answer" ? d.data.fields : null;
    expect(f?.sources.map((s) => s.label)).toEqual(["Press", "News"]);
    // Row 1 named source 2 (News), now index 1; row 2 named the dropped source: it cites the card's chips (null).
    expect(f?.more?.kind === "list" && f.more.items.map((i) => i.sourceIx)).toEqual([1, null]);
  });
});

describe("the image chooser", () => {
  test("at most two faces per turn; then a face-free frame, else atmosphere", async () => {
    const t = turn();
    const b = budgetFor(t);
    const deps = fakeMedia();
    const m1 = await libraryMedia(deps, A, b, ["f1"], "a", { key: "1" });
    const m2 = await libraryMedia(deps, A, b, ["f2"], "a", { key: "2" });
    const m3 = await libraryMedia(deps, A, b, ["f3"], "a", { key: "3" });
    expect([m1.hasFace, m2.hasFace, m3.kind, m3.hasFace]).toEqual([true, true, "atmosphere", false]);
    expect(budgetFor(t).faces).toBe(2);
  });
  test("an untagged photo counts as a face (never guessed away)", async () => {
    const b = { faces: 0, atmosphere: new Set<string>() };
    const deps = fakeMedia({ library: async (_a, ids) => new Map(ids.map((id) => [id, { id, athletePresent: null, gcsPath: "x", mediaType: "photo" }])) });
    expect((await libraryMedia(deps, A, b, ["u"], "a", { key: "u" })).hasFace).toBe(true);
  });
  test("no library, no atmosphere: the category default, never a broken image", async () => {
    const deps = fakeMedia({ atmosphere: async () => null });
    expect(await libraryMedia(deps, A, { faces: 0, atmosphere: new Set() }, [], "a", { key: "x" })).toMatchObject({ kind: "atmosphere", url: null });
  });
});

describe("what a tap records", () => {
  test("insight: accepted · asked, then later taps are kept; a seen card untouched for 7 days expires", async () => {
    const store = createMemoryStore();
    const d = await store.insertDecision(A, { runId: null, skillId: "insight", suggested: "s", why: "w", evidence: [], kind: "other", detail: { kind: "insight_card" } });
    expect(await recordOutcome(store, A, { card: "insight", ref: d.id, outcome: "accepted", action: "asked" }, { addPreference: async () => null })).toEqual({ ok: true, receipt: "Asked Mila." });
    expect(await store.getDecision(A, d.id)).toMatchObject({ response: "accepted", responseReason: "asked" });
    const e = await store.insertDecision(A, { runId: null, skillId: "insight", suggested: "s", why: "w", evidence: [], kind: "other", detail: { kind: "insight_card" } });
    await recordOutcome(store, A, { card: "insight", ref: e.id, outcome: "seen" }, { addPreference: async () => null, now: () => NOW });
    expect(await expireIgnored(store, A, new Date(NOW.getTime() + 6 * 86_400_000))).toBe(0);
    expect(await expireIgnored(store, A, new Date(NOW.getTime() + 8 * 86_400_000))).toBe(1);
    expect(await store.getDecision(A, e.id)).toMatchObject({ response: "expired", responseReason: "ignored" });
  });
  test("an unseen card is never 'ignored'; an Answer never expires", async () => {
    const store = createMemoryStore();
    await store.insertDecision(A, { runId: null, skillId: "insight", suggested: "s", why: "w", evidence: [], kind: "other", detail: {} });
    await store.insertDecision(A, { runId: null, skillId: "mila-cards/answer", suggested: "s", why: "w", evidence: [], kind: "other", detail: { seenAt: "2026-01-01T00:00:00Z" } });
    expect(await expireIgnored(store, A, new Date(NOW.getTime() + 30 * 86_400_000))).toBe(0);
  });
  test("an idea's tap lives in detail.cardTap; its response is never touched", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store);
    await recordOutcome(store, A, { card: "idea", ref: a.id, outcome: "accepted", action: "idea_used" }, { addPreference: async () => null, now: () => NOW });
    const row = await store.getDecision(A, a.id);
    expect(row?.response).toBe("pending");
    expect(row?.detail?.cardTap).toMatchObject({ state: "accepted", action: "idea_used" });
  });
  test("a ref that is not this card kind's row is 404", async () => {
    const store = createMemoryStore();
    const a = await fileIdea(store);
    expect(await recordOutcome(store, A, { card: "insight", ref: a.id, outcome: "accepted" }, { addPreference: async () => null })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the app screens' cards (GET /me/mila/cards/surface)", () => {
  const WELCOME = process.env.MILA_WELCOME, KITS = process.env.AGENT_POST_KITS;
  beforeAll(() => { process.env.MILA_WELCOME = "true"; process.env.AGENT_POST_KITS = "true"; });
  afterAll(() => { process.env.MILA_WELCOME = WELCOME; process.env.AGENT_POST_KITS = KITS; });
  beforeEach(() => { mockChoices.clear(); mockSets.length = 0; });
  test("Home's briefing: the idea set first, then the open insight, ≤ 3, at most one face; Me's list is not here", async () => {
    const store = createMemoryStore();
    await fileIdea(store, {}, ["face1"]);
    await fileIdea(store, { idea: { hook: "Five serves, slowed down", format: "carousel", platform: "instagram", timing: "t" } }, ["face2"]);
    const [f] = await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Sam Rivera" }, claim: "Reel saves were 1940 in October, up 96% from 990 in September.", type: "measured", source: { url: "https://instagram.com/x", title: "Instagram" }, date: "2026-11-01", confidence: 1, runId: null }]);
    await run(store, "share_insight", { angle: "change", headline: "Your reel saves doubled this month", line: "Brands look for saves.", fact_keys: ["F1"], series: [990, 1940] }, turn({ F1: f.id }));
    const s = await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false });
    expect(s.briefing.map((d) => d.type)).toEqual(["ideas", "insight"]);
    const ideas = s.briefing[0];
    if (ideas.type !== "ideas") throw new Error("no ideas");
    expect(ideas.data.fields.items.filter((i) => i.media.hasFace)).toHaveLength(1);
    // Me › What Mila can do reads GET /me/mila/capabilities (routes/milaChoices.db.test.ts); the surface keeps an empty list.
    expect(s.capabilities).toEqual([]);
  });
  test("the idea set goes through the shared per-call path: no ideas for a fenced athlete (or a failing fence check)", async () => {
    const store = createMemoryStore();
    await fileIdea(store, {}, ["face1"]);
    expect((await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false })).briefing.map((d) => d.type)).toContain("ideas");
    expect((await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => true })).briefing.map((d) => d.type)).not.toContain("ideas");
    expect((await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => { throw new Error("db down"); } })).briefing.map((d) => d.type)).not.toContain("ideas");
  });
  test("a stored atmosphere picture is signed again when Home reads it (the producer's URL lasted an hour)", async () => {
    const store = createMemoryStore();
    const [f] = await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Sam Rivera" }, claim: "Reel saves were 1940 in October.", type: "measured", source: { url: "https://instagram.com/x", title: "Instagram" }, date: "2026-11-01", confidence: 1, runId: null }]);
    // No series: the insight leads with atmosphere, signed at the time it was made.
    await run(store, "share_insight", { angle: "strength", headline: "Your reel saves are strong", line: "Brands look for saves.", fact_keys: ["F1"] }, turn({ F1: f.id }), fakeMedia({ sign: async (p) => `https://signed.example/old/${p}` }));
    const s = await cardSurface(store, A, { media: fakeMedia({ sign: async (p) => `https://signed.example/new/${p}` }), now: () => NOW, isDeleting: async () => false });
    const insight = s.briefing.find((d) => d.type === "insight");
    expect(insight?.type === "insight" && insight.data.fields.media).toMatchObject({ kind: "atmosphere", url: expect.stringContaining("/new/") });
  });
  test("Me lists nothing while MILA_WELCOME is off (a Turn on would be refused)", async () => {
    delete process.env.MILA_WELCOME;
    const s = await cardSurface(createMemoryStore(), A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false });
    process.env.MILA_WELCOME = "true";
    expect(s.capabilities).toEqual([]);
  });
  test("Home: a chat offer already answered elsewhere (on in Me) leaves the briefing", async () => {
    const store = createMemoryStore();
    await run(store, "offer_capability", { key: "post_ideas" });
    expect((await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false })).briefing.map((d) => d.type)).toContain("turn-on");
    mockChoices.set(`${A}|post_ideas`, { state: "enabled", via: "me", version: 1, cooldownUntil: null });
    expect((await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false })).briefing.map((d) => d.type)).not.toContain("turn-on");
  });
  test("reading the surface makes no Turn-on row of its own, so a chat offer is never blocked by it", async () => {
    const store = createMemoryStore();
    await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false });
    await cardSurface(store, A, { media: fakeMedia(), now: () => NOW, isDeleting: async () => false });
    expect(await store.listDecisions(A, { skillId: "mila-cards/turn-on" })).toHaveLength(0);
    expect((await run(store, "offer_capability", { key: "post_ideas" })).result.status).toBe("ok");
  });
});
