/**
 * media/tools.test.ts — check_camera_roll, held to the agent-tool rules (grouped; use / don't-use guidance; enums for
 * every closed choice; actionable errors; a guard on what it may claim) and to its flag.
 *
 *   T1 the flag: registered always, but a skill's run only gets it while CAMERA_ROLL_INTAKE is on (forSkill); with it
 *      off the chat's tools are exactly the ones they were
 *   T2 the description: what it does, Use when, Don't use, and that Nomila cannot see the camera roll; no athlete,
 *      sport, school or brand of its own
 *   T3 the arguments: closed enums, no athlete id, strict-ready
 *   T4 a post: only one of HER post actions that is still open; the error says what to do instead; a reel post looks
 *      at videos
 *   T5 the card: built by code, its link carries the review's filter (shared codec), once a turn
 *   T6 the guard: the result tells the model nothing was looked at
 *
 * ⚠️ MUTATIONS: drop `enabled` — T1 "flag off: not in the chat's run" reds; accept another athlete's action for
 * for_post — T4 reds.
 */
jest.mock("../../db", () => ({ db: {} }));

import { createMemoryStore, type AgentStore } from "../research/store";
import { loadJob } from "../jobs";
import { specOf, strictJsonSchema, type ToolContext, type TurnState } from "../tools";
import { createDefaultRegistry } from "../coreTools";
import { parseCameraRollAsk, CAMERA_ROLL_KINDS, CAMERA_ROLL_SINCE } from "../../../shared/cameraRollIntake";
import { CHECK_CAMERA_ROLL_DESCRIPTION, mediaTools } from "./tools";
import { postAction } from "../postKit/testRows";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let store: AgentStore;
const turn = (): TurnState => ({ factKeys: new Map(), conversationId: "c1", offeredConnectors: [], today: "2026-10-12" });
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ athleteId: A, runId: "run-1", skillId: "chat", turn: turn(), ...over });
const tool = () => mediaTools(store)[0];
const run = (args: Record<string, unknown>, c: ToolContext = ctx()) => tool().execute!(c, args) as Promise<Record<string, any>>;

beforeEach(() => {
  store = createMemoryStore();
  process.env.CAMERA_ROLL_INTAKE = "true";
});
afterAll(() => { delete process.env.CAMERA_ROLL_INTAKE; });

describe("T1: the flag", () => {
  it("on: the chat's run gets it", () => {
    const names = createDefaultRegistry({ store }).forSkill(loadJob("chat")).map((t) => t.name);
    expect(names).toContain("check_camera_roll");
  });

  it("off: not in the chat's run, and every other chat tool is exactly as it was", () => {
    delete process.env.CAMERA_ROLL_INTAKE;
    const names = createDefaultRegistry({ store }).forSkill(loadJob("chat")).map((t) => t.name);
    expect(names).not.toContain("check_camera_roll");
    // (refresh_research, the read tools and the card system v2's producers sit behind their own flags, off here too;
    // the deal, booking and documents tools are always on.)
    const cardTools = process.env.MILA_CARDS_V2 === "true" ? [] : ["share_insight", "ideas_suggest", "offer_capability", "ask_once", "answer_with_sources"];
    const ownFlag = new Set(["check_camera_roll", "refresh_research", "media_search", "posts_performance", "money_summary", "whats_next", ...cardTools]);
    expect(names).toEqual(loadJob("chat").tools.filter((n) => !ownFlag.has(n)));
  });

  it("off: a call that somehow arrives is refused, in words", async () => {
    delete process.env.CAMERA_ROLL_INTAKE;
    expect(await run({})).toEqual({ status: "error", reason: expect.stringMatching(/not available/) });
  });
});

describe("T2: the description", () => {
  it("says what it does, when to use it, when not to, and what it can never claim", () => {
    expect(CHECK_CAMERA_ROLL_DESCRIPTION).toMatch(/Use when:/);
    expect(CHECK_CAMERA_ROLL_DESCRIPTION).toMatch(/Don't use:/);
    expect(CHECK_CAMERA_ROLL_DESCRIPTION).toMatch(/cannot see their camera roll/);
    expect(CHECK_CAMERA_ROLL_DESCRIPTION).toMatch(/Never say you looked at/);
  });

  it("names no athlete, sport, school or brand", () => {
    expect(CHECK_CAMERA_ROLL_DESCRIPTION).not.toMatch(/\b(Mia|soccer|basketball|Stanford|Nike|gorjana)\b/i);
  });
});

describe("T3: the arguments", () => {
  it("closed enums for every closed choice; no athlete id; strict-ready", () => {
    const spec = specOf(tool());
    const props = (spec.schema as any).properties;
    expect(props.kind.enum).toEqual([...CAMERA_ROLL_KINDS]);
    expect(props.since.enum).toEqual([...CAMERA_ROLL_SINCE]);
    expect(Object.keys(props).filter((k) => /athlete/i.test(k))).toEqual([]);
    const strict = strictJsonSchema(spec.schema) as any;
    expect([...strict.required].sort()).toEqual(Object.keys(props).sort());
    expect(strict.additionalProperties).toBe(false);
  });

  it("is read-only and ours", () => {
    expect([tool().kind, tool().permission]).toEqual(["ours", "read"]);
  });
});

describe("T4: for a post", () => {
  const post = async (athleteId: string, over: Record<string, unknown> = {}) =>
    (await store.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: "Post", why: "w", evidence: [], detail: { ...postAction(), ...over } as unknown as Record<string, unknown> })).id;

  it("one of her open post actions: the ask carries it", async () => {
    const id = await post(A);
    const r = await run({ for_post: id });
    expect(r.status).toBe("ok");
    expect(parseCameraRollAsk(r.id)).toEqual({ kind: "all", since: "last_review", forPost: id });
    expect(r.label).toBe("Check your camera roll for this post");
  });

  it("a reel post looks at videos unless told otherwise", async () => {
    const id = await post(A, { post: { format: "reel" } });
    expect(parseCameraRollAsk((await run({ for_post: id })).id)!.kind).toBe("videos");
    expect(parseCameraRollAsk((await run({ for_post: id, kind: "all" })).id)!.kind).toBe("all");
  });

  it("another athlete's action, or not a post: an error that says what to do instead", async () => {
    const theirs = await post(B);
    const r = await run({ for_post: theirs });
    expect(r).toEqual({ status: "error", reason: expect.stringMatching(/call again without for_post/) });
    const goal = (await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "g", why: "w", evidence: [] })).id;
    expect((await run({ for_post: goal })).status).toBe("error");
  });

  it("a post already done: offer a general review instead", async () => {
    const id = await post(A);
    await store.respondDecision(A, id, "accepted", null);
    expect(await run({ for_post: id })).toEqual({ status: "error", reason: expect.stringMatching(/general review/) });
  });
});

describe("T5: the card", () => {
  it("built by code; its link opens the review with the filter", async () => {
    const c = ctx();
    const r = await run({ kind: "videos", since: "7d", why: "  You shot a lot this week. " }, c);
    const card = tool().card!(r, c)!;
    expect(card).toMatchObject({
      kind: "open-screen", title: "Check your camera roll for new videos",
      payload: { screen: "camera-roll", id: "videos.7d", why: "You shot a lot this week." },
      links: [{ label: "Open the review", target: { screen: "camera-roll", id: "videos.7d" } }],
    });
  });

  it("once a turn", async () => {
    const c = ctx();
    expect((await run({}, c)).status).toBe("ok");
    expect(await run({}, c)).toEqual({ status: "error", reason: expect.stringMatching(/already offered/) });
    expect((await run({}, ctx())).status).toBe("ok");   // a new turn
  });
});

describe("T6: the guard", () => {
  it("the result tells the model nothing was looked at", async () => {
    expect((await run({})).note).toMatch(/Nothing has been looked at yet/);
  });
});
