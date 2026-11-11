/**
 * switchOnWalk.db.test.ts — what switching MILA_WELCOME on would block, on a real (PGlite) Postgres. No model, no
 * workflow, no provider: tools are fakes carrying the real names, run through the real callTool gate. Made-up athletes.
 *
 *   W1 nothing is silently blocked: every optional tool and every optional job belongs to a built capability that a
 *      card can offer and Me lists (a Turn-on presentation, a choice switch); planned capabilities get no card
 *   W2 the walk, for EVERY built switch: offer → turn on (the sheet's tap) → its tools and jobs are allowed → turn off
 *      → refused again (and the offer is refused: they turned it off; Me turns it back on)
 *   W3 pause stops it, resume (a tap) starts it again
 *   W4 documents: reading where things stand works for anyone; making, editing or sharing a pitch needs pitch_deck, a
 *      brand book needs brand_book, the public page draft needs neither (publishing waits for their own tap)
 *   W5 MILA_WELCOME off: nothing above is refused
 *   W6 their tap re-checks per document too: a pitch share queued while pitch_deck was on is refused once it is off;
 *      a public page publish is never refused by it
 *   W7 open to some athletes only: bookings is offered (and listed in Me) only to an athlete on the bookings pilot;
 *      shop is planned (a yes would guard nothing yet), so it is never offered
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { z } from "zod";
import { closeTestDb, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { callTool } from "../callTool";
import type { AgentTool, ToolContext } from "../tools";
import { presentation } from "../milaCards/capabilities";
import { pauseChoice, revokeChoice, setChoice } from "./choices";
import { jobAllowed, OPTIONAL_JOBS, type OptionalJob } from "./gate";
import { availableNow, CAPABILITIES, capability, optionalToolCapabilities, splitToolName } from "./registry";
import { refusedTools } from "./toolGate";
import { offerFor, turnOnFromCard, turnOnKeys } from "./turnOn";

const FLAGS = ["MILA_WELCOME", "MILA_CARDS_V2", "AGENT_MOMENTS", "AGENT_POST_KITS", "AGENT_PLAN", "AGENT_LEARNING_LOOP", "AGENT_RESEARCH_REFRESH", "BOOKINGS_ENABLED", "SHOP_V1", "PUBLIC_CARD"] as const;
const saved: Record<string, string | undefined> = {};
const on = () => { for (const k of FLAGS) process.env[k] = "true"; };
let A = "", MAILBOX = "";
let savedPilot: string | undefined;

beforeAll(async () => {
  for (const k of FLAGS) saved[k] = process.env[k];
  await initTestDb();
  A = await seedAthlete("Walk Example", { sport: "Rowing" } as any);
  MAILBOX = await seedConnection({ athleteId: A, platform: "gmail", email: "walk@example.com" });
  savedPilot = process.env.BOOKINGS_PILOT_ATHLETE_IDS;
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = A;   // the walk's athlete is on the bookings pilot (W7 covers who is not)
});
afterAll(async () => {
  if (savedPilot === undefined) delete process.env.BOOKINGS_PILOT_ATHLETE_IDS; else process.env.BOOKINGS_PILOT_ATHLETE_IDS = savedPilot;
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});
beforeEach(on);

const BUILT_SWITCHES = turnOnKeys(CAPABILITIES).filter((k) => capability(k)!.status !== "planned");
const jobsOf = (key: string) => (Object.entries(OPTIONAL_JOBS) as Array<[OptionalJob, { capability: string }]>).filter(([, j]) => j.capability === key).map(([job]) => job);
const toolsOf = (key: string) => capability(key)!.tools;

/** A tool use through the real gate (callTool): ran or refused with capability_off. */
async function use(athleteId: string, qualified: string): Promise<"ran" | "refused"> {
  const { tool: name, kind } = splitToolName(qualified);
  const ran = jest.fn(async () => ({ status: "ok" }));
  const tool = { name, description: name, kind: "ours", permission: "draft", args: z.object({ document: z.string().optional() }), execute: ran } as unknown as AgentTool;
  const ctx: ToolContext = { athleteId, runId: "00000000-0000-4000-8000-000000000002", skillId: "chat" };
  const out = await callTool({ skill: { id: "chat", tools: [name] }, tool, name, args: kind ? { document: kind } : {}, ctx, neverTerms: [], queueApproval: async () => { throw new Error("no queue"); }, citing: false });
  if (out.outcome === "denied" && (out as { rule?: string }).rule === "capability_off") return "refused";
  expect(ran).toHaveBeenCalled();
  return "ran";
}
async function reach(key: string): Promise<Record<string, string | boolean>> {
  const out: Record<string, string | boolean> = {};
  for (const t of toolsOf(key)) out[t] = await use(A, t);
  for (const j of jobsOf(key)) out[j] = await jobAllowed(j, A);
  return out;
}
const all = (key: string, v: "ran" | "refused") => Object.fromEntries([...toolsOf(key).map((t) => [t, v]), ...jobsOf(key).map((j) => [j, v === "ran"])]);

describe("W1 nothing is silently blocked", () => {
  it("every built switch has a Turn-on presentation, and nothing else does", () => {
    expect(BUILT_SWITCHES.filter((k) => !presentation(k))).toEqual([]);
    const planned = CAPABILITIES.filter((c) => c.status === "planned").map((c) => c.key);
    expect(planned.filter((k) => presentation(k))).toEqual([]);
    const notSwitches = CAPABILITIES.filter((c) => !turnOnKeys([c]).length).map((c) => c.key);
    expect(notSwitches.filter((k) => presentation(k))).toEqual([]);
  });
  it("every optional tool and every optional job is owned by a built switch (a card and Me can turn it on)", () => {
    const owners = [...optionalToolCapabilities().values()].flat();
    const jobOwners = Object.values(OPTIONAL_JOBS).map((j) => j.capability);
    expect([...owners, ...jobOwners].filter((k) => !BUILT_SWITCHES.includes(k))).toEqual([]);
    // the four the audit named: draft replies, documents, booking replies and the optional jobs
    for (const k of ["draft_replies", "pitch_deck", "brand_book", "bookings", "moments_scan", "post_ideas", "plan_refresh", "post_took_off", "auto_archive", "profile_refresh"]) {
      expect(BUILT_SWITCHES).toContain(k);
    }
  });
  it("with the dev flags on, every built switch is available (Me lists it)", () => {
    expect(BUILT_SWITCHES.filter((k) => !availableNow(capability(k)!))).toEqual([]);
  });
});

describe("W2 the walk: offer → turn on → allowed → turn off → refused", () => {
  it.each(BUILT_SWITCHES)("%s", async (key) => {
    const entry = capability(key)!;
    const accountRef = entry.scope === "per_account" ? MAILBOX : null;
    expect(await reach(key)).toEqual(all(key, "refused"));

    const offer = await offerFor(A, key, accountRef);
    expect(offer).toMatchObject({ ok: true });
    const yes = await turnOnFromCard({ athleteId: A, key, accountRef, consentVersion: entry.consent.version, expectedVersion: offer.ok ? offer.choice.version : 0 });
    expect(yes).toMatchObject({ ok: true, choice: { state: "enabled", via: "card" } });
    expect(await reach(key)).toEqual(all(key, "ran"));
    expect(await offerFor(A, key, accountRef)).toMatchObject({ ok: false, reason: "already_on" });

    expect(await revokeChoice(A, key, accountRef, "me")).toMatchObject({ ok: true });
    expect(await reach(key)).toEqual(all(key, "refused"));
    expect(await offerFor(A, key, accountRef)).toMatchObject({ ok: false, reason: "turned_off" });
    // Me turns it back on (a tap), and it runs again
    expect(await setChoice({ athleteId: A, capability: key, accountRef, to: "enabled", via: "me" })).toMatchObject({ ok: true });
    expect(await reach(key)).toEqual(all(key, "ran"));
    expect(await revokeChoice(A, key, accountRef, "me")).toMatchObject({ ok: true });
  });
});

describe("W3 pause and resume", () => {
  it("pausing a capability stops its tools and jobs; resuming starts them again", async () => {
    for (const key of ["plan_refresh", "pitch_deck"]) {
      expect(await setChoice({ athleteId: A, capability: key, to: "enabled", via: "me" })).toMatchObject({ ok: true });
      expect(await reach(key)).toEqual(all(key, "ran"));
      expect(await pauseChoice(A, key, null, "me")).toMatchObject({ ok: true, choice: { state: "paused" } });
      expect(await reach(key)).toEqual(all(key, "refused"));
      expect(await offerFor(A, key)).toMatchObject({ ok: false, reason: "paused" });
      expect(await setChoice({ athleteId: A, capability: key, to: "enabled", via: "me" })).toMatchObject({ ok: true });
      expect(await reach(key)).toEqual(all(key, "ran"));
      expect(await revokeChoice(A, key, null, "me")).toMatchObject({ ok: true });
    }
  });
});

describe("W4 documents are owned per document", () => {
  it("status for anyone; pitch needs pitch_deck; brand book needs brand_book; public page needs neither", async () => {
    const B = await seedAthlete("Docs Example", { sport: "Rowing" } as any);
    for (const kind of ["all", "pitch", "brand_book", "public_page"]) expect(await use(B, `documents_status:${kind}`)).toBe("ran");
    for (const t of ["documents_make", "documents_edit", "documents_share"]) {
      expect(await use(B, `${t}:public_page`)).toBe("ran");
      expect(await use(B, `${t}:pitch`)).toBe("refused");
      expect(await use(B, `${t}:brand_book`)).toBe("refused");
    }
    // The per-turn list keeps the tools (a public page draft is always allowed); the call decides.
    expect([...(await refusedTools(B, ["documents_status", "documents_make", "documents_edit", "documents_share"])).keys()]).toEqual([]);

    expect(await setChoice({ athleteId: B, capability: "pitch_deck", to: "enabled", via: "card" })).toMatchObject({ ok: true });
    for (const t of ["documents_make", "documents_edit", "documents_share"]) {
      expect(await use(B, `${t}:pitch`)).toBe("ran");
      expect(await use(B, `${t}:brand_book`)).toBe("refused");
    }
  });
  it("the refusal names the document and offers the right card", async () => {
    const C = await seedAthlete("Docs Refusal", { sport: "Rowing" } as any);
    const { toolRefusal } = await import("./toolGate");
    const r = await toolRefusal(C, "documents_make", undefined, { document: "brand_book" });
    expect(r).toContain("documents_make (document: brand_book) is off");
    expect(r).toContain("offer_capability (key: brand_book)");
    expect(await toolRefusal(C, "documents_make", undefined, { document: "public_page" })).toBeNull();
    expect(await toolRefusal(C, "documents_status", undefined, { document: "pitch" })).toBeNull();
  });
});

describe("W5 MILA_WELCOME off: transparent", () => {
  it("nothing is refused and every job runs", async () => {
    delete process.env.MILA_WELCOME;
    const D = await seedAthlete("Flag Off", { sport: "Rowing" } as any);
    for (const key of BUILT_SWITCHES) {
      for (const t of toolsOf(key)) expect(await use(D, t)).toBe("ran");
      for (const j of jobsOf(key)) expect(await jobAllowed(j, D)).toBe(true);
    }
    expect(await offerFor(D, "pitch_deck")).toMatchObject({ ok: false, reason: "welcome_off" });
  });
});

describe("W6 the tap re-checks per document", () => {
  it("a queued pitch share is refused at the tap once pitch_deck is off; the public page publish is not", async () => {
    const { tapRefusal } = await import("./toolGate");
    const E = await seedAthlete("Tap Example", { sport: "Rowing" } as any);
    expect(await tapRefusal(E, "documents_share", { document: "public_page" })).toBeNull();
    expect(await tapRefusal(E, "documents_share", { document: "pitch" })).toContain("Pitch card is turned off now");
    expect(await setChoice({ athleteId: E, capability: "pitch_deck", to: "enabled", via: "me" })).toMatchObject({ ok: true });
    expect(await tapRefusal(E, "documents_share", { document: "pitch" })).toBeNull();
    expect(await revokeChoice(E, "pitch_deck", null, "me")).toMatchObject({ ok: true });
    expect(await tapRefusal(E, "documents_share", { document: "pitch" })).not.toBeNull();
    expect(await tapRefusal(E, "documents_share", { document: "brand_book" })).toContain("Brand book is turned off now");
  });
});

describe("W7 open to some athletes only", () => {
  it("bookings is offered only to an athlete on the pilot; shop is never offered", async () => {
    const F = await seedAthlete("Not Piloted", { sport: "Rowing" } as any);
    expect(await offerFor(F, "bookings")).toMatchObject({ ok: false, reason: "not_available" });
    const G = await seedAthlete("Piloted", { sport: "Rowing" } as any);
    const pilot = process.env.BOOKINGS_PILOT_ATHLETE_IDS;
    process.env.BOOKINGS_PILOT_ATHLETE_IDS = `${A},${G}`;
    try {
      expect(await offerFor(G, "bookings")).toMatchObject({ ok: true });
      delete process.env.BOOKINGS_ENABLED;
      expect(await offerFor(G, "bookings")).toMatchObject({ ok: false, reason: "not_available" });
    } finally {
      process.env.BOOKINGS_ENABLED = "true";
      process.env.BOOKINGS_PILOT_ATHLETE_IDS = pilot;
    }
    expect(BUILT_SWITCHES).not.toContain("shop");
    expect(presentation("shop")).toBeNull();
    expect(await offerFor(A, "shop")).toMatchObject({ ok: false, reason: "not_available" });
  });
});
