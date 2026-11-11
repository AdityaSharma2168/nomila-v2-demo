/**
 * milaV2TurnOn.db.test.ts — the turn-on conversation, OFFLINE (CI): the five turn-on scenarios of the Mila v2 golden set,
 * each scripted turn played through the REAL Mila build on Mastra (as milaV2Flows.test.ts), with per-athlete
 * enablement ON and the real consent record (mila_choices, welcome/choices.ts) on PGlite. No provider, no network.
 *
 *   offer      Mila offers a capability only through offer_capability: the Turn-on card, drawn by the registry
 *              (welcome/turnOn.ts offerFor); a second offer within 24 h, or after a no, is refused by the build
 *   words      chat words may decline or pause (setChoice via "chat"), never enable (needs_tap); no turn, right or
 *              wrong, changes their choice
 *   honest     Mila never says something is on when it is not; a tool that is off is not in the turn at all
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
// The card's picture: no storage, no signing (a card without a picture draws its category default).
jest.mock("../../milaCards/media", () => ({
  ...jest.requireActual("../../milaCards/media"),
  dbCardMediaDeps: { sportOf: async () => null, atmosphere: async () => null, library: async () => new Map(), sign: async () => null, brand: async () => null },
}));

import { closeTestDb, initTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { FLOWS, playFlow, worldRegistry, type Flow } from "../../../../evals/agent/mila-v2/flows";
import { failedChecks, gradeTurn, type CheckName } from "../../../../evals/agent/mila-v2/checks";
import { SCENARIOS, type Scenario } from "../../../../evals/agent/mila-v2/scenarios";
import { getChoice, setChoice } from "../../welcome/choices";
import { CARD_SKILLS } from "../../milaCards/config";

const FLAGS: Record<string, string> = { MILA_WELCOME: "true", MILA_CARDS_V2: "true", AGENT_POST_KITS: "true" };
const saved: Record<string, string | undefined> = {};
const CAP = "post_ideas";
const TURN_ON = SCENARIOS.filter((s) => s.area === "turn-on");

beforeAll(async () => {
  for (const [k, v] of Object.entries(FLAGS)) { saved[k] = process.env[k]; process.env[k] = v; }
  await initTestDb();
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await closeTestDb();
});

/** A fresh athlete in the scenario's world: an offer just shown, or a no said in words. */
async function worldFor(s: Scenario, f: Flow) {
  const athleteId = await seedAthlete(`Turn-on ${s.id}`, { sport: "Soccer" } as never);
  const { registry, store } = await worldRegistry(f.world, athleteId);
  if (f.world?.mailbox) await seedConnection({ athleteId, platform: "gmail", email: `${s.id}@example.com` });
  if (f.world?.recentOffer) {
    await store.insertDecision(athleteId, {
      runId: null, skillId: CARD_SKILLS.turnOn, suggested: `Turn on: ${f.world.recentOffer}`, why: "offered a minute ago", evidence: [], kind: "other",
      detail: { kind: "capability_offer", capability: f.world.recentOffer, accountRef: null, state: "unset" },
    });
  }
  if (f.world?.declined) expect(await setChoice({ athleteId, capability: f.world.declined, to: "never", via: "chat" })).toMatchObject({ ok: true });
  return { athleteId, registry };
}

async function playAndCheckChoice(s: Scenario, f: Flow, steps: Flow["right"]) {
  const { athleteId, registry } = await worldFor(s, f);
  const before = await getChoice(athleteId, CAP);
  const t = await playFlow(s, steps, f.world, { registry, athleteId });
  // No turn, right or wrong, changes their choice: only their tap does.
  const after = await getChoice(athleteId, CAP);
  expect([after.state, after.version]).toEqual([before.state, before.version]);
  expect(after.state).not.toBe("enabled");
  return t;
}

test("the five turn-on scenarios are scripted", () => {
  expect(TURN_ON.map((s) => s.id)).toEqual(["turnon-offer-card", "turnon-chat-yes", "turnon-chat-decline", "turnon-off-tool", "turnon-offer-drafts"]);
  for (const s of TURN_ON) expect([s.id, !!FLOWS[s.id]]).toEqual([s.id, true]);
});

describe("chat words may decline or pause, never enable (the consent record itself)", () => {
  it("a yes in words is refused; not now, never and pause are recorded from words", async () => {
    const a = await seedAthlete("Words Example", { sport: "Soccer" } as never);
    expect(await setChoice({ athleteId: a, capability: CAP, to: "enabled", via: "chat" })).toMatchObject({ ok: false, error: "needs_tap" });
    expect((await getChoice(a, CAP)).state).toBe("unset");
    expect(await setChoice({ athleteId: a, capability: CAP, to: "not_now", via: "chat" })).toMatchObject({ ok: true });
    expect(await setChoice({ athleteId: a, capability: CAP, to: "enabled", via: "chat" })).toMatchObject({ ok: false, error: "needs_tap" });
    expect(await setChoice({ athleteId: a, capability: CAP, to: "never", via: "chat" })).toMatchObject({ ok: true });
    const b = await seedAthlete("Pause Example", { sport: "Soccer" } as never);
    expect(await setChoice({ athleteId: b, capability: CAP, to: "enabled", via: "card" })).toMatchObject({ ok: true });
    expect(await setChoice({ athleteId: b, capability: CAP, to: "paused", via: "chat" })).toMatchObject({ ok: true });
    expect((await getChoice(b, CAP)).state).toBe("paused");
    expect(await setChoice({ athleteId: b, capability: CAP, to: "enabled", via: "chat" })).toMatchObject({ ok: false, error: "needs_tap" });
  });
});

describe.each(TURN_ON.map((s) => [s.id, s] as const))("%s", (_id, s) => {
  const f = FLOWS[s.id];

  it("the right turn passes every check through the real build, and their choice is unchanged", async () => {
    const t = await playAndCheckChoice(s, f, f.right);
    expect(t.text.trim().length).toBeGreaterThan(0);
    expect(gradeTurn(f.expect, t, f.world).filter((x) => !x.pass)).toEqual([]);
    // A tool that is off for them is not in the turn at all (welcome/toolGate.ts allowedTools).
    if (s.id === "turnon-off-tool" || s.id === "turnon-offer-drafts") expect(t.offered).not.toContain("deals_draft_reply");
    // Asked for a reply draft while draft replies is off: the Turn-on card for draft_replies, on their own mailbox.
    if (s.id === "turnon-offer-drafts") {
      expect(t.calls.find((c) => c.name === "offer_capability")?.args).toMatchObject({ key: "draft_replies" });
      expect(t.cards).toEqual(["turn-on"]);
    }
  });

  it.each(f.wrong.map((w) => [w.why, w] as const))("a wrong turn fails: %s", async (_why, w) => {
    const t = await playAndCheckChoice(s, f, w.steps);
    const sorted = (xs: readonly CheckName[]) => [...xs].sort();
    expect(sorted(failedChecks(gradeTurn(f.expect, t, f.world)))).toEqual(sorted(w.fails));
    for (const [tool, outcome] of Object.entries(w.guard ?? {})) expect([tool, t.calls.find((c) => c.name === tool)?.outcome]).toEqual([tool, outcome]);
  });
});
