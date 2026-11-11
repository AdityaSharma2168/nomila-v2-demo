/**
 * tell.test.ts — the plan run's tell step (design "Goals tab post details + plan ready", 12 Oct 2026), on the in-memory
 * store with a fake chats port and a fake plan/ready writer (tests never reach providers).
 *
 *   T1 the facts: all good · needs media · held (never-content, and the final guard by its block) · unchanged · skipped
 *      (week cap) — counts, kits, previews, next plan
 *   T2 the checks: an invented number, a number word, a name not in the facts, a code, too long → the plain line
 *   T3 the plain lines; the card's stats line
 *   T4 the step: no chat asked (a weekly run) → nothing, no model call; one row per asking chat, the progress card
 *      flipped in place; a run joined from two chats tells both; a second pass writes nothing and calls no model; a
 *      model error → the plain line
 *   T5 refresh_plan: the progress card carries the run id; a refusal carries the weekly-limit facts
 */
jest.mock("../../db", () => ({ db: {} }));

import type { ChatCard } from "../../../shared/agent";
import type { ActionDecisionDetail } from "../../../shared/plan";
import { createMemoryStore, type AgentStore } from "../research/store";
import { dayWords } from "./goals";
import { assembleFacts, lineProblem, plainLine, planReadyCardId, statsLine, tellPlanReady, type PlanReadyFacts, type TellChats } from "./tell";
import { planProgressCard, refusalFacts } from "./tools";

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const RUN = "wf-run-1";

const kit = (assets: number, preview?: { status: "queued" | "ready" | "failed"; requestedAt: string }) => ({
  contract: "post-kit/1", idea: { format: "reel" }, brief: { show: "s" }, assets: Array.from({ length: assets }, (_, i) => ({ assetId: `a${i}` })),
  aiGenerationNeeded: { value: assets === 0, reason: "" }, ...(preview ? { preview } : {}),
});

async function seedPosts(store: AgentStore, now: Date, over: Array<Partial<ActionDecisionDetail> & Record<string, unknown>>) {
  const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  let i = 0;
  for (const o of over) {
    i++;
    await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: `Post ${i}`, why: "-", evidence: [], goalId: goal.id, detail: {
      kind: "post", what: `Post ${i}`, button: "post", dueOn: `2026-10-1${4 + i}`, event: null, state: "to_start",
      deliverable: { type: "post_brief", title: "", body: "", target: null, platform: "instagram", thread: null, connector: null },
      post: { hook: `Hook ${i}`, format: i === 2 ? "carousel" : i === 3 ? "story" : "reel", show: "s", captionAngle: "c", avoid: "", mediaNeeds: "a clip of you talking to camera" },
      ...o,
    } });
  }
  // One pitch (another kind of action) toward the same goal.
  await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Pitch", why: "-", evidence: [], goalId: goal.id, detail: { kind: "pitch", what: "Pitch", button: "send", dueOn: null, event: null, state: "to_start", deliverable: { type: "pitch", title: "", body: "", target: null, platform: null, thread: null, connector: null } } });
  void now;
  return goal;
}

const planned = { status: "planned", runId: "r", recommended: 1, actions: 4, held: 0, expired: 0, costMicroUsd: 1 };

describe("T1: the facts", () => {
  it("all good: 3 posts, 3 kits, 2 previews ready and 1 being made", async () => {
    const store = createMemoryStore();
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const goal = await seedPosts(store, now, [
      { prepared: { postKit: kit(2, { status: "ready", requestedAt: fresh }) as any } },
      { prepared: { postKit: kit(3, { status: "queued", requestedAt: fresh }) as any } },
      { prepared: { postKit: kit(1, { status: "ready", requestedAt: fresh }) as any } },
    ]);
    const f = await assembleFacts(store, A, { outputs: { plan: planned, post_kits: { status: "done", built: 3, skipped: {}, failed: 0 } }, goalId: goal.id }, now);
    expect(f).toMatchObject({ outcome: "planned", skippedWhy: null, forGoal: "Grow my audience", kitsStep: "done", heldWhy: [], nextPlanOn: null });
    expect(f.counts).toEqual({ posts: 3, kitsBuilt: 3, kitsNeedMedia: 0, kitsHeld: 0, kitsNotBuilt: 0, previewsReady: 2, previewsPreparing: 1, previewsFailed: 0, otherActions: 1, newGoalIdeas: 1 });
    expect(f.posts.map((p) => [p.format, p.hook, p.kit, p.preview])).toEqual([["reel", "Hook 1", "built", "ready"], ["carousel", "Hook 2", "built", "preparing"], ["story", "Hook 3", "built", "ready"]]);
    expect(f.posts[0].due).toBe(dayWords("2026-10-15"));
  });

  it("needs media, held and the weekly kit limit: what is missing comes from the plan's own words", async () => {
    const store = createMemoryStore();
    const now = new Date();
    await seedPosts(store, now, [{ prepared: { postKit: kit(2) as any } }, { prepared: { postKit: kit(0) as any } }, {}]);
    const f = await assembleFacts(store, A, { outputs: { plan: planned, post_kits: { status: "done", built: 1, skipped: { never_content: 1, week_count: 1 }, failed: 0 } }, goalId: null }, now);
    expect(f.counts).toMatchObject({ posts: 3, kitsBuilt: 1, kitsNeedMedia: 1, kitsNotBuilt: 1, kitsHeld: 1 });
    expect(f.posts[1]).toMatchObject({ kit: "needs_media", mediaNeeds: "a clip of you talking to camera", preview: "none" });
    expect(f.posts[0].mediaNeeds).toBeNull();
    expect(f).toMatchObject({ kitsStep: "weekly_kit_limit", heldWhy: ["it touches something you asked to keep out of your posts"], forGoal: null });
  });

  it("holds made THIS run are counted and told, each with its plain reason; a hold from an earlier run is not re-told", async () => {
    const store = createMemoryStore();
    const now = new Date();
    await seedPosts(store, now, [{}, {}, {}]);
    const held = [{ reason: "final_guard", block: "number_is_the_point" }, { reason: "final_guard", block: "on_card" }, { reason: "final_guard", block: "nothing_left" }, { reason: "never_content", block: null }];
    const f = await assembleFacts(store, A, { outputs: { plan: planned, post_kits: { status: "done", built: 0, skipped: { final_guard: 3, never_content: 1 }, failed: 0, held } }, goalId: null }, now);
    expect(f.counts).toMatchObject({ kitsHeld: 4 });
    expect(f.heldWhy).toEqual([
      "it leans on a number Mila couldn't check against your facts",
      "its opening line has a price, a contact detail or the M.I.A., which can't go on a post",
      "nothing would be left to post once the parts Mila couldn't check came out",
      "it touches something you asked to keep out of your posts",
    ]);
    // The next run answers those holds from their rows (nothing changed): nothing held this run, nothing told.
    const hold = { prepared: { postKitHold: { reason: "final_guard", block: "on_card", inputsKey: "k", at: now.toISOString() } } as any };
    const store2 = createMemoryStore();
    await seedPosts(store2, now, [hold]);
    const g = await assembleFacts(store2, A, { outputs: { plan: planned, post_kits: { status: "done", built: 0, skipped: {}, failed: 0, held: [] } }, goalId: null }, now);
    expect(g.counts).toMatchObject({ kitsHeld: 0 });
    expect(g.heldWhy).toEqual([]);
  });

  it("unchanged, skipped (week cap → weekly budget), post kits off; the next plan from the last scheduled run", async () => {
    const store = createMemoryStore();
    const now = new Date();
    const sched = await store.startRun({ athleteId: A, skillId: "plan", skillVersion: "1", trigger: "schedule", model: { provider: "openai", model: "m", effort: "low" }, parentRef: null });
    const startedAt = (await store.getRun(A, sched))!.startedAt;
    const u = await assembleFacts(store, A, { outputs: { plan: { status: "reused", runId: "r", why: "unchanged_input" }, post_kits: { status: "off" } }, goalId: null }, now);
    expect(u).toMatchObject({ outcome: "unchanged", kitsStep: "off", nextPlanOn: dayWords(new Date(Date.parse(startedAt) + 7 * 86_400_000).toISOString()) });
    const s = await assembleFacts(store, A, { outputs: { plan: { status: "skipped", reason: "week_cap" } }, goalId: null }, now);
    expect(s).toMatchObject({ outcome: "skipped", skippedWhy: "weekly_budget", kitsStep: "off" });
    // A retried plan step that reused its own finished run is still a plan.
    expect((await assembleFacts(store, A, { outputs: { plan: { status: "reused", runId: "r", why: "retried_step" } }, goalId: null }, now)).outcome).toBe("planned");
  });
});

const FACTS: PlanReadyFacts = {
  outcome: "planned", skippedWhy: null, forGoal: "Grow my audience",
  posts: [
    { format: "reel", hook: "Nobody sees the early part.", timedFor: "Home opener", pillar: "Behind the scenes", due: "Sun 18 Oct", kit: "built", preview: "ready", mediaNeeds: null },
    { format: "carousel", hook: "Three things on every trip.", timedFor: null, pillar: "Behind the scenes", due: "Thu 15 Oct", kit: "built", preview: "preparing", mediaNeeds: null },
    { format: "story", hook: "Ask me anything.", timedFor: null, pillar: "Your community", due: "Sat 17 Oct", kit: "needs_media", preview: "none", mediaNeeds: "a clip of you talking to camera" },
  ],
  counts: { posts: 3, kitsBuilt: 2, kitsNeedMedia: 1, kitsHeld: 0, kitsNotBuilt: 0, previewsReady: 1, previewsPreparing: 1, previewsFailed: 0, otherActions: 1, newGoalIdeas: 0 },
  kitsStep: "done", heldWhy: [], nextPlanOn: null,
};

describe("T2: the checks", () => {
  // FACTS: 3 posts (a reel, a carousel, a story), 2 kits built, 1 needs media, 1 preview ready, 1 preparing, 1 other action.
  it("passes a line that only says what the facts hold", () => {
    for (const ok of [
      "I planned 3 posts for this week. 2 kits are ready; the story needs a clip of you talking to camera.",
      "Your plan's ready: 3 posts, and the reel before Home opener is ready to watch.",
      "Your plan's ready: three posts this week, two post kits built and 1 preview ready to watch.",
      "Your plan has 3 posts: 1 reel, 1 carousel and 1 story. The first is due Thu 15 Oct.",
      "Your plan's ready: all 3 posts are planned, and the reel is due on 18 Oct.",
      "Your plan's ready, with 1 more thing to do this week.",
    ]) expect({ ok, problem: lineProblem(ok, FACTS) }).toEqual({ ok, problem: null });
  });

  it("ties each number to its noun: N posts is the post count; N kits is one kit count; previews likewise", () => {
    expect(lineProblem("Your plan's ready: 5 posts this week.", FACTS)).toBe("number:5 posts");
    expect(lineProblem("Your plan's ready: seven posts this week.", FACTS)).toBe("number:seven posts");
    expect(lineProblem("Your plan's ready: 2 posts this week.", FACTS)).toBe("number:2 posts");          // 2 is a kit count, not the post count
    expect(lineProblem("I planned 3 posts and built 3 kits.", FACTS)).toBe("number:3 kits");            // 3 is the post count, not a kit count
    expect(lineProblem("3 posts, 2 kits and 2 previews ready.", FACTS)).toBe("number:2 previews ready");
    expect(lineProblem("3 posts, including 2 reels.", FACTS)).toBe("number:2 reels");
    expect(lineProblem("Your 3 new posts are planned.", FACTS)).toBeNull();                              // a word between is fine
    // A list: "and 1 still preparing" counts what the number before it counts (the live eval's pr01 line).
    expect(lineProblem("3 posts this week: 2 kits built, 1 preview ready and 1 still preparing.", FACTS)).toBeNull();
    expect(lineProblem("3 posts this week: 2 kits built, 1 preview ready and 2 still preparing.", FACTS)).toBe("number:2 previews preparing");
  });

  it("a number with no noun, a range or a vague quantity is refused", () => {
    expect(lineProblem("Your plan's ready: 3 this week.", FACTS)).toBe("number_unbound:3");
    expect(lineProblem("Your plan's ready: two this week.", FACTS)).toBe("number_unbound:two");
    // "one" as a pronoun is not a number.
    expect(lineProblem("3 posts; the story needs a clip, and there isn't one in your library yet.", FACTS)).toBeNull();
    expect(lineProblem("Your plan's ready: 2 to 3 posts this week.", FACTS)).toMatch(/^range:/);
    expect(lineProblem("Your plan's ready: 2-3 posts this week.", FACTS)).toMatch(/^range:/);
    expect(lineProblem("Your plan's ready: a few posts this week.", FACTS)).toBe("vague:a few");
    expect(lineProblem("Your plan's ready: several posts this week.", FACTS)).toBe("vague:several");
    expect(lineProblem("Most of your kits are built.", FACTS)).toBe("vague:most");
    expect(lineProblem("A couple of kits are ready.", FACTS)).toBe("vague:a couple");
  });

  it("dates: a number next to a month or weekday must be a date the facts hold", () => {
    expect(lineProblem("Your plan's ready: 3 posts, the first due Thu 15 Oct.", FACTS)).toBeNull();
    expect(lineProblem("Your plan's ready: 3 posts, the first due October 15.", FACTS)).toBeNull();
    expect(lineProblem("Your plan's ready: 3 posts, the first due Thu 16 Oct.", FACTS)).toBe("date:16");
    expect(lineProblem("Your plan's ready: 3 posts, the first due 15 Nov.", FACTS)).toBe("date:15");
  });

  it("all / every / both + a noun is a claim about the whole set, true only when it is", () => {
    expect(lineProblem("Your plan's ready: 3 posts, and all 3 kits are built.", FACTS)).toBe("claim:all 3 kits");   // 2 of 3
    expect(lineProblem("Your plan's ready: 3 posts, and every kit is built.", FACTS)).toBe("claim:every kit");
    expect(lineProblem("All your previews are ready to watch.", FACTS)).toBe("claim:All your previews");
    expect(lineProblem("Both posts are planned.", FACTS)).toBe("claim:Both posts");                          // there are 3
    const allBuilt = { ...FACTS, counts: { ...FACTS.counts, kitsBuilt: 3, kitsNeedMedia: 0 } };
    expect(lineProblem("Your plan's ready: 3 posts, and all 3 kits are built.", allBuilt)).toBeNull();
  });

  it("nothing went out: posted, published, sent, went live, shared, goes out, went out, will go out are refused; a negation is the truth", () => {
    for (const verb of ["posted", "published", "sent", "went live", "shared", "went out"]) {
      expect(lineProblem(`Your plan's ready: 3 posts, and 1 already ${verb}.`, FACTS)).toBe(`claims_out:${verb}`);
    }
    expect(lineProblem("Your plan's ready: 3 posts, and the reel goes out on Sun 18 Oct.", FACTS)).toBe("claims_out:goes out");
    expect(lineProblem("Your plan's ready: 3 posts, and the reel will go out on Sun 18 Oct.", FACTS)).toBe("claims_out:will go out");
    expect(lineProblem("Your plan's ready: 3 posts. Nothing went out; the kits wait for you.", FACTS)).toBeNull();
    expect(lineProblem("Your plan's ready: 3 posts, and nothing goes out until you tap.", FACTS)).toBeNull();
    // A negation counts only in the verb's own clause: one in an earlier clause does not excuse the claim.
    expect(lineProblem("No worries, I posted your reel.", FACTS)).toBe("claims_out:posted");
    expect(lineProblem("Don't worry, I sent the kits.", FACTS)).toBe("claims_out:sent");
    expect(lineProblem("Your plan's ready: 3 posts. Nothing has been posted yet.", FACTS)).toBeNull();
    // The other forms of going out / going live.
    expect(lineProblem("Your 3 posts are going out on Sun 18 Oct.", FACTS)).toBe("claims_out:going out");
    expect(lineProblem("Your 3 posts will be live soon.", FACTS)).toBe("claims_out:will be live");
    expect(lineProblem("Your plan's ready: 3 posts, and the reel is live.", FACTS)).toBe("claims_out:is live");
  });

  it("number words past twelve are read (or refused), and half / a couple / a dozen are vague", () => {
    expect(lineProblem("Your plan's ready: twenty posts this week.", FACTS)).toBe("number:twenty posts");
    expect(lineProblem("Your plan's ready: thirteen posts this week.", FACTS)).toBe("number:thirteen posts");
    expect(lineProblem("Your plan's ready: twenty-one posts this week.", FACTS)).toBe("number:twenty one posts");
    expect(lineProblem("Your plan's ready: a thousand posts this week.", FACTS)).toBe("number_unreadable:thousand");
    expect(lineProblem("Your plan's ready, and half of your kits are built.", FACTS)).toBe("vague:half");
    expect(lineProblem("Your plan's ready, and a couple of kits are built.", FACTS)).toBe("vague:a couple");
    expect(lineProblem("Your plan's ready, with a dozen ideas.", FACTS)).toBe("vague:a dozen");
  });

  it("the state after a noun is tied to its own count; no / none + a noun is 0", () => {
    // FACTS: kitsBuilt 2, kitsNeedMedia 1, previewsReady 1, previewsPreparing 1.
    expect(lineProblem("3 posts, 1 kit built.", FACTS)).toBe("number:1 kits built");
    expect(lineProblem("3 posts, 0 kits built.", FACTS)).toBe("number:0 kits built");
    expect(lineProblem("Your plan's ready: 3 posts. No kits are built yet.", FACTS)).toBe("number:no kits built");
    expect(lineProblem("3 posts; none of your kits are built.", FACTS)).toBe("number:none of kits built");
    expect(lineProblem("3 posts: 1 preview is ready while 1 kit needs a clip.", FACTS)).toBeNull();
    expect(lineProblem("3 posts: 2 previews are ready while 1 kit needs a clip.", FACTS)).toBe("number:2 previews ready");
    expect(lineProblem("3 posts: 1 preview is ready while 2 kits need a clip.", FACTS)).toBe("number:2 kits need");
    expect(lineProblem("3 posts, 2 kits are already built.", FACTS)).toBeNull();
    const noPreviews = { ...FACTS, counts: { ...FACTS.counts, previewsReady: 0 } };
    expect(lineProblem("3 posts, 2 kits built and no previews ready yet.", noPreviews)).toBeNull();
  });

  it("names: every capitalised word, a sentence start included, is a plain word or a whole word of the facts", () => {
    expect(lineProblem("Your plan's ready, with a post for Brand Z.", FACTS)).toBe("name:Brand");
    expect(lineProblem("Acme loved your last post. Your plan's ready: 3 posts.", FACTS)).toBe("name:Acme");   // a sentence start
    expect(lineProblem("Your plan's ready: 3 posts, the first before Home opener.", FACTS)).toBeNull();
    expect(lineProblem("Your plan's ready: 3 posts, the first before Homecoming.", FACTS)).toBe("name:Homecoming"); // whole tokens only
  });

  it("refuses codes, an empty line and a long one", () => {
    expect(lineProblem("Your plan's ready: kit needs_media.", FACTS)).toBe("code_or_key");
    expect(lineProblem("   ", FACTS)).toBe("empty");
    expect(lineProblem("Your plan's ready. ".repeat(20), FACTS)).toBe("too_long");
  });
});

describe("T3: the plain lines and the card", () => {
  it("one plain line per outcome", () => {
    expect(plainLine(FACTS)).toBe("Your plan's ready: 3 posts, 2 kits built.");
    expect(plainLine({ ...FACTS, kitsStep: "off" })).toBe("Your plan's ready: 3 posts.");
    expect(plainLine({ ...FACTS, outcome: "unchanged" })).toBe("Nothing new came in, so your plan stays as it is.");
    expect(plainLine({ ...FACTS, outcome: "skipped" })).toBe("I couldn't refresh your plan this time; your current plan still stands.");
    expect(statsLine(FACTS)).toBe("3 posts · 2 kits built · 1 needs media · 1 preview ready");
  });
});

/** The chats port in memory: rows with conversation, cards and content. */
function memoryChats(rows: Array<{ id: string; athleteId: string; conversationId: string; content: string; cards: ChatCard[] }>): TellChats & { rows: typeof rows } {
  let n = 0;
  const hasProgress = (r: (typeof rows)[number], runId: string) => r.cards.some((c) => c.kind === "progress" && c.payload.planRunId === runId);
  return {
    rows,
    async asking(athleteId, runId) {
      const seen = new Set<string>();
      return [...rows].reverse().filter((r) => r.athleteId === athleteId && hasProgress(r, runId) && !seen.has(r.conversationId) && !!seen.add(r.conversationId))
        .map((r) => ({ rowId: r.id, conversationId: r.conversationId, cards: r.cards }));
    },
    async hasCard(athleteId, conversationId, cardId) { return rows.some((r) => r.athleteId === athleteId && r.conversationId === conversationId && r.cards.some((c) => c.id === cardId)); },
    async setCards(athleteId, rowId, cards) { const r = rows.find((x) => x.id === rowId && x.athleteId === athleteId); if (r) r.cards = cards; },
    async insert(athleteId, conversationId, row) { rows.push({ id: `new-${++n}`, athleteId, conversationId, content: row.content, cards: row.cards }); },
  };
}

const progress = (runId: string) => planProgressCard(runId, { athleteId: A, runId: "chat-run", skillId: "chat" }, true);

describe("T4: the step", () => {
  const outputs = { plan: planned, post_kits: { status: "done", built: 0, skipped: {}, failed: 0 } };

  it("a run no chat asked for (weekly, a new deal) leaves no message and calls no model", async () => {
    const store = createMemoryStore();
    const chats = memoryChats([{ id: "x", athleteId: A, conversationId: "c1", content: "hi", cards: [] }]);
    const write = jest.fn();
    expect(await tellPlanReady({ store, chats, write }, A, { runId: RUN, outputs, goalId: null })).toEqual({ status: "none", chats: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(chats.rows).toHaveLength(1);
  });

  it("one row per asking chat; a joined run tells both; the progress card flips to done; another athlete's chat never", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), [{ prepared: { postKit: kit(2) as any } }]);
    const chats = memoryChats([
      { id: "p1", athleteId: A, conversationId: "c1", content: "On it.", cards: [progress(RUN)] },
      { id: "p2", athleteId: A, conversationId: "c2", content: "Already on it.", cards: [progress(RUN)] },
      { id: "pb", athleteId: B, conversationId: "cb", content: "On it.", cards: [progress(RUN)] },
    ]);
    const write = jest.fn(async () => ({ line: "Your plan's ready: 1 post this week, and its kit is built.", runId: "agent-run-1" }));
    const r = await tellPlanReady({ store, chats, write }, A, { runId: RUN, outputs, goalId: null });
    expect(r).toMatchObject({ status: "told", chats: 2, line: "model", asked: ["c2", "c1"] });
    expect(write).toHaveBeenCalledTimes(1);
    const added = chats.rows.filter((x) => x.id.startsWith("new-"));
    expect(added.map((x) => [x.conversationId, x.content])).toEqual([
      ["c2", "Your plan's ready: 1 post this week, and its kit is built."], ["c1", "Your plan's ready: 1 post this week, and its kit is built."],
    ]);
    expect(added[0].cards).toEqual([expect.objectContaining({ id: planReadyCardId(RUN), kind: "open-screen", title: "This week's plan", payload: { screen: "goals", id: null, label: "your goals", why: "1 post · 1 kit built" }, links: [{ label: "See your goals", target: { screen: "goals" } }] })]);
    const flipped = chats.rows.find((x) => x.id === "p1")!.cards[0];
    expect(flipped).toMatchObject({ kind: "progress", payload: { state: "done", step: 2, of: 2, steps: [{ state: "done" }, { state: "done" }] } });
    // Another athlete's chat holding the same run id is never touched.
    expect(chats.rows.find((x) => x.id === "pb")!.cards[0]).toMatchObject({ payload: { state: "running" } });
    expect(chats.rows.filter((x) => x.conversationId === "cb")).toHaveLength(1);

    // A retry (or a second pass) writes nothing new and pays for nothing.
    const again = await tellPlanReady({ store, chats, write }, A, { runId: RUN, outputs, goalId: null });
    expect(again).toEqual({ status: "told", chats: 0, asked: ["c2", "c1"] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(chats.rows.filter((x) => x.id.startsWith("new-"))).toHaveLength(2);
  });

  it("her phone hears of every plan, asked for or not, once per pass, with the facts (PR D); a failed push changes nothing", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), [{ prepared: { postKit: kit(2) as any } }]);
    const pushed: PlanReadyFacts[] = [];
    const push = async (f: PlanReadyFacts) => { pushed.push(f); };
    const write = jest.fn();
    // PUSH_NOTIFICATIONS off: the push is never asked, not even for the facts.
    delete process.env.PUSH_NOTIFICATIONS;
    await tellPlanReady({ store, chats: memoryChats([]), write, push }, A, { runId: RUN, outputs, goalId: null });
    expect(pushed).toEqual([]);
    process.env.PUSH_NOTIFICATIONS = "true";
    // No chat asked: no message, no model call, but the push hears the facts.
    expect(await tellPlanReady({ store, chats: memoryChats([]), write, push }, A, { runId: RUN, outputs, goalId: null })).toEqual({ status: "none", chats: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(pushed.map((f) => [f.outcome, f.counts.posts, f.counts.kitsBuilt])).toEqual([["planned", 1, 1]]);
    // A chat asked: the message and the push.
    const chats = memoryChats([{ id: "p1", athleteId: A, conversationId: "c1", content: "On it.", cards: [progress(RUN)] }]);
    const r = await tellPlanReady({ store, chats, write: async () => ({ line: "Your plan's ready.", runId: "x" }), push: async (f) => { pushed.push(f); throw new Error("push down"); } }, A, { runId: RUN, outputs, goalId: null });
    expect(r).toMatchObject({ status: "told", chats: 1 });
    expect(pushed).toHaveLength(2);
    // A retry after the chat was written (the step failed before the push went out): the push is asked again; its
    // dedupe key keeps it to one notification.
    const again = await tellPlanReady({ store, chats, write: jest.fn(), push }, A, { runId: RUN, outputs, goalId: null });
    expect(again).toEqual({ status: "told", chats: 0, asked: ["c1"] });
    expect(pushed).toHaveLength(3);
    // A push whose facts cannot even be built never fails the step.
    const broken = { ...store, listDecisions: async () => { throw new Error("db down"); } } as AgentStore;
    await expect(tellPlanReady({ store: broken, chats: memoryChats([]), write, push }, A, { runId: RUN, outputs, goalId: null })).resolves.toEqual({ status: "none", chats: 0 });
    delete process.env.PUSH_NOTIFICATIONS;
  });

  it("a model error, or a line that fails a check, puts the plain line in", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), [{ prepared: { postKit: kit(2) as any } }]);
    const chats = memoryChats([{ id: "p1", athleteId: A, conversationId: "c1", content: "On it.", cards: [progress(RUN)] }]);
    const r1 = await tellPlanReady({ store, chats, write: async () => { throw new Error("provider down"); } }, A, { runId: RUN, outputs, goalId: null });
    expect(r1).toMatchObject({ line: "plain", why: "model_failed" });
    expect(chats.rows.at(-1)!.content).toBe("Your plan's ready: 1 post, 1 kit built.");

    const chats2 = memoryChats([{ id: "p1", athleteId: A, conversationId: "c1", content: "On it.", cards: [progress("wf-run-2")] }]);
    const r2 = await tellPlanReady({ store, chats: chats2, write: async () => ({ line: "Your plan's ready: 4 posts this week.", runId: "agent-run-2" }) }, A, { runId: "wf-run-2", outputs, goalId: null });
    expect(r2).toMatchObject({ line: "plain", why: "number:4 posts" });
    expect(chats2.rows.at(-1)!.content).toBe("Your plan's ready: 1 post, 1 kit built.");
  });
});

describe("T5: refresh_plan's card and refusal facts", () => {
  it("the progress card carries the plan run id and its steps (one step while post kits are off)", () => {
    expect(progress(RUN)).toEqual({
      id: `plan-progress:${RUN}`, kind: "progress", title: "Updating your plan", links: [], runId: "chat-run",
      payload: { step: 1, of: 2, label: "Planning your week", state: "running", planRunId: RUN, steps: [{ label: "Planning your week", state: "running" }, { label: "Getting your post kits ready", state: "pending" }] },
    });
    expect(planProgressCard(RUN, { athleteId: A, runId: "x", skillId: "chat" }, false).payload).toMatchObject({ of: 1, steps: [{ label: "Planning your week" }] });
  });

  it("a refusal at the weekly limit says how many were used, the limit and when the next plan comes", async () => {
    const store = createMemoryStore();
    const model = { provider: "openai" as const, model: "m", effort: "low" as const };
    await store.startRun({ athleteId: A, skillId: "plan", skillVersion: "1", trigger: "schedule", model, parentRef: null });
    for (let i = 0; i < 4; i++) await store.startRun({ athleteId: A, skillId: "plan", skillVersion: "1", trigger: i % 2 ? "chat" : "event", model, parentRef: null });
    const f = await refusalFacts(store, A, "event_cap");
    expect(f).toMatchObject({ refused: "weekly_limit", used: 4, limit: 4 });
    expect(f.next_plan_on).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
    expect(await refusalFacts(store, B, "no_brief")).toEqual({ refused: "no_brief", used: 0, limit: 4, next_plan_on: null });
  });
});

describe("T6: review fixes", () => {
  it("counts every pending post, though the facts list only the first 6", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), Array.from({ length: 8 }, (_, i) => (i % 2 ? { prepared: { postKit: kit(1) as any } } : {})));
    const f = await assembleFacts(store, A, { outputs: { plan: planned, post_kits: { status: "done", built: 4, skipped: {}, failed: 0 } }, goalId: null }, new Date());
    expect(f.posts).toHaveLength(6);
    expect(f.counts).toMatchObject({ posts: 8, kitsBuilt: 4, kitsNotBuilt: 4 });
  });

  it("a kits step that failed says nothing about kits (off), and the plan line still goes", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), [{}]);
    const f = await assembleFacts(store, A, { outputs: { plan: planned, post_kits: { status: "failed" } }, goalId: null }, new Date());
    expect(f.kitsStep).toBe("off");
    expect(plainLine(f)).toBe("Your plan's ready: 1 post.");
  });

  it("one chat that cannot be written never stops another, and never fails the step", async () => {
    const store = createMemoryStore();
    await seedPosts(store, new Date(), [{ prepared: { postKit: kit(2) as any } }]);
    const chats = memoryChats([
      { id: "p1", athleteId: A, conversationId: "c1", content: "On it.", cards: [progress(RUN)] },
      { id: "p2", athleteId: A, conversationId: "c2", content: "On it.", cards: [progress(RUN)] },
    ]);
    const insert = chats.insert.bind(chats);
    chats.insert = async (athleteId, conversationId, row) => { if (conversationId === "c2") throw new Error("db down"); return insert(athleteId, conversationId, row); };
    const r = await tellPlanReady({ store, chats, write: async () => ({ line: "Your plan's ready.", runId: "x" }) }, A, { runId: RUN, outputs: { plan: planned }, goalId: null });
    expect(r).toMatchObject({ status: "told", chats: 1 });
    expect(chats.rows.filter((x) => x.id.startsWith("new-")).map((x) => x.conversationId)).toEqual(["c1"]);
  });
});
