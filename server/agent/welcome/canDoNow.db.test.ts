/**
 * canDoNow.db.test.ts — CAN DO NOW tells Mila each optional capability's REAL state for this athlete, and agrees with
 * the tools the turn actually gets (6 Nov 2026 dev verification: the whole Deals area counted as on, so Mila said "Yes,
 * I can draft a reply" while draft replies was off). Real chat skill tools (the app registry over in-memory stores),
 * the real per-athlete gate (toolGate.ts allowedTools / capabilityOverview) and the real consent record (mila_choices)
 * on PGlite. No model, no provider. Made-up athletes.
 *
 *   C1 nothing turned on: no optional tool in the turn, and no line names one as on; draft replies needs a mailbox first
 *   C2 with a mailbox, draft replies is listed as one to offer with offer_capability, and Deals does not claim drafting
 *   C3 turned on (the card's tap): it is listed as on, its tools are in the turn, and Deals/Goals name the work again
 *   C4 every capability with tools: the gate allows them exactly when CAN DO NOW lists it as on (refusedTools), and an
 *      off one's tools are never in the turn
 *   C5 said never / turned off: listed as Me-only, never as one to offer
 *   C6 MILA_WELCOME off: no capability lines (the line reads as before)
 *   C7 voice sending (default-on, voice-only): listed only on the voice surface, never in chat
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { closeTestDb, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { canDoNow } from "../engine/context";
import { passSkill, visibleTools } from "../engine/tools/registry";
import { CHAT_SCOPES } from "../engine/turnTypes";
import { loadJob } from "../jobs";
import { worldRegistry } from "../../../evals/agent/mila-v2/flows";
import { revokeChoice, setChoice } from "./choices";
import { capability, splitToolName } from "./registry";
import { allowedTools, capabilityOverview, refusedTools } from "./toolGate";

const FLAGS = ["MILA_WELCOME", "MILA_CARDS_V2", "AGENT_MOMENTS", "AGENT_POST_KITS", "AGENT_PLAN", "AGENT_LEARNING_LOOP", "AGENT_RESEARCH_REFRESH"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of FLAGS) { saved[k] = process.env[k]; process.env[k] = "true"; }
  await initTestDb();
});
afterAll(async () => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});

/** The turn's tools and its CAN DO NOW line, as the Mastra turn assembles them. */
async function turnFor(athleteId: string) {
  const { registry } = await worldRegistry(undefined, athleteId);
  const visible = await allowedTools(athleteId, visibleTools(passSkill(loadJob("chat"), registry), registry, { scopes: [...CHAT_SCOPES] }));
  const caps = await capabilityOverview(athleteId);
  return { tools: visible.map((t) => t.name), caps, line: canDoNow(visible, caps) };
}
const keys = (cs: ReadonlyArray<{ key: string }> | undefined) => (cs ?? []).map((c) => c.key);
const onSentence = (line: string) => /Turned on for them: ([^.]*)\./.exec(line)?.[1] ?? "";
const offerSentence = (line: string) => /Off, can be turned on: ([^.]*)\./.exec(line)?.[1] ?? "";

test("C1: nothing turned on — no optional tool, nothing listed as on; draft replies waits for a mailbox", async () => {
  const a = await seedAthlete("CanDo One", { sport: "Rowing" } as never);
  const t = await turnFor(a);
  expect(t.caps!.on).toEqual([]);
  expect(t.tools).not.toContain("deals_draft_reply");
  expect(t.tools).not.toContain("refresh_research");
  expect(t.line).not.toMatch(/Turned on for them/);
  expect(t.line).not.toMatch(/draft replies;/);
  expect(t.line).toMatch(/Deals: read offers and terms; nothing is sent without their tap\./);
  expect(keys(t.caps!.connect)).toContain("draft_replies");
  expect(offerSentence(t.line)).toContain("profile_refresh (Research refreshed monthly)");
  expect(offerSentence(t.line)).not.toContain("draft_replies");
  expect(t.line).toMatch(/offer it with offer_capability \(that key\); never say you can do it\./);
});

test("C2: with a mailbox, draft replies is one to offer, and Deals does not claim drafting", async () => {
  const a = await seedAthlete("CanDo Two", { sport: "Rowing" } as never);
  await seedConnection({ athleteId: a, platform: "gmail", email: "two@example.com" });
  const t = await turnFor(a);
  expect(keys(t.caps!.offer)).toContain("draft_replies");
  expect(offerSentence(t.line)).toContain("draft_replies (Draft replies to brands)");
  expect(t.tools).not.toContain("deals_draft_reply");
  expect(t.line).not.toMatch(/draft replies;/);
});

test("C3: turned on with their tap — listed as on, its tools in the turn, the area names the work", async () => {
  const a = await seedAthlete("CanDo Three", { sport: "Rowing" } as never);
  const mailbox = await seedConnection({ athleteId: a, platform: "gmail", email: "three@example.com" });
  expect(await setChoice({ athleteId: a, capability: "draft_replies", accountRef: mailbox, to: "enabled", via: "card" })).toMatchObject({ ok: true });
  expect(await setChoice({ athleteId: a, capability: "plan_refresh", to: "enabled", via: "card" })).toMatchObject({ ok: true });
  const t = await turnFor(a);
  expect(keys(t.caps!.on).sort()).toEqual(["draft_replies", "plan_refresh"]);
  expect(onSentence(t.line)).toBe("draft_replies (Draft replies to brands), plan_refresh (Your plan, refreshed weekly)");
  expect(t.tools).toEqual(expect.arrayContaining(["deals_draft_reply", "refresh_plan"]));
  expect(t.line).toMatch(/Deals: read offers and terms, draft replies;/);
  expect(t.line).toMatch(/refresh the plan\./);
  expect(offerSentence(t.line)).not.toMatch(/draft_replies|plan_refresh/);
});

test("C4: for every capability with whole tools, the gate allows them exactly when CAN DO NOW lists it as on", async () => {
  const a = await seedAthlete("CanDo Four", { sport: "Rowing" } as never);
  const mailbox = await seedConnection({ athleteId: a, platform: "gmail", email: "four@example.com" });
  for (const state of ["off", "on"] as const) {
    if (state === "on") {
      for (const k of ["draft_replies", "profile_refresh", "plan_refresh"]) {
        expect(await setChoice({ athleteId: a, capability: k, accountRef: capability(k)!.scope === "per_account" ? mailbox : null, to: "enabled", via: "card" })).toMatchObject({ ok: true });
      }
    }
    const t = await turnFor(a);
    const listed = [...t.caps!.on, ...t.caps!.offer, ...t.caps!.connect, ...t.caps!.inMe];
    for (const c of listed) {
      const whole = c.tools.filter((n) => !splitToolName(n).kind);
      const isOn = keys(t.caps!.on).includes(c.key);
      // The gate's own answer for the tool (whether or not the chat skill lists it), and the turn's tools.
      const refused = await refusedTools(a, whole);
      for (const n of whole) {
        expect([state, c.key, n, !refused.has(n)]).toEqual([state, c.key, n, isOn]);
        if (!isOn) expect([c.key, n, t.tools.includes(n)]).toEqual([c.key, n, false]);
      }
      expect([c.key, onSentence(t.line).includes(`${c.key} (`)]).toEqual([c.key, isOn]);
    }
  }
});

test("C5: said never or turned off — Me only, never one to offer", async () => {
  const a = await seedAthlete("CanDo Five", { sport: "Rowing" } as never);
  expect(await setChoice({ athleteId: a, capability: "profile_refresh", to: "never", via: "chat" })).toMatchObject({ ok: true });
  expect(await setChoice({ athleteId: a, capability: "plan_refresh", to: "enabled", via: "card" })).toMatchObject({ ok: true });
  expect(await revokeChoice(a, "plan_refresh", null, "me")).toMatchObject({ ok: true });
  const t = await turnFor(a);
  expect(keys(t.caps!.inMe)).toEqual(expect.arrayContaining(["profile_refresh", "plan_refresh"]));
  expect(offerSentence(t.line)).not.toMatch(/profile_refresh|plan_refresh/);
  expect(t.line).toMatch(/Off, only they turn it on in Me \(do not offer\): [^.]*profile_refresh/);
});

test("C6: MILA_WELCOME off — no capability lines", async () => {
  const a = await seedAthlete("CanDo Six", { sport: "Rowing" } as never);
  process.env.MILA_WELCOME = "false";
  try {
    const t = await turnFor(a);
    expect(t.caps).toBeNull();
    expect(t.line).not.toMatch(/Turned on for them|can be turned on|only they turn it on in Me/);
  } finally {
    process.env.MILA_WELCOME = "true";
  }
});

test("C7: voice sending (on by default) is named only on the voice surface, never in chat; turned off, it says so there", async () => {
  const a = await seedAthlete("CanDo Seven", { sport: "Rowing" } as never);
  const chat = await turnFor(a);
  expect([...keys(chat.caps!.on), ...keys(chat.caps!.offer), ...keys(chat.caps!.connect), ...keys(chat.caps!.inMe)]).not.toContain("voice_send");
  expect(chat.line).not.toMatch(/voice_send|by voice/);
  const voice = await capabilityOverview(a, { surface: "voice" });
  expect(keys(voice!.on)).toContain("voice_send");
  expect(onSentence(canDoNow([], voice))).toContain("voice_send (Send ordinary replies by voice)");
  expect(await revokeChoice(a, "voice_send", null, "me")).toMatchObject({ ok: true });
  const off = await capabilityOverview(a, { surface: "voice" });
  expect(keys(off!.on)).not.toContain("voice_send");
  expect(keys(off!.inMe)).toContain("voice_send");
  expect(keys((await capabilityOverview(a))!.inMe)).not.toContain("voice_send");
});
