/**
 * choices.db.test.ts — the athlete's choices per capability on a real (PGlite) Postgres (design "Mila welcome flow" §4 +
 * §12). No provider, no engine. Made-up athletes; nothing here names a real person, sport, team or brand.
 *
 *   C1 transitions: the design's table as a matrix — every allowed move works, every other move is refused; a yes is a
 *      tap (card / Me / Settings), never words in chat; core capabilities are never a choice; planned / flagged-off
 *      capabilities cannot be said yes to
 *   C2 not now: cooldowns 14 → 30 → 60 → 90 (ceiling); repeated not-now never becomes never
 *   C3 uniqueness under concurrency: one row per (athlete, capability, account) — athlete-wide (NULL account) too —
 *      with racing answers; a stale expectedVersion is refused; versions and history stay linear
 *   C4 history reconstruction: replaying mila_choice_history rebuilds the current row; consent copies kept per change
 *   C5 account scope: a yes for one mailbox is not a yes for another; an account of the wrong kind or another
 *      athlete's is refused; reconnecting the same account keeps the choice (unless the athlete disconnected); a new
 *      account never inherits it; disconnect revokes what ran on it
 *   C6 isAllowed: unset / not_now / never / paused / revoked are not allowed; enabled is, within the consent it covered
 *      (an action outside it, or one that always needs a tap, is not); pausing a needed capability stops its dependents
 *   C7 the flag: writes refused while MILA_WELCOME is off
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { and, asc, eq, sql } from "drizzle-orm";
import { connectedAccounts, milaChoiceHistory, milaChoices } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import {
  getChoice, isAllowed, NOT_NOW_COOLDOWN_DAYS, pauseChoice, revokeForAccount, setChoice, TRANSITIONS, type ChoiceState, type PreferenceState,
} from "./choices";
import type { CapabilityEntry } from "./registry";

const FLAGS = ["MILA_WELCOME", "AGENT_POST_KITS", "AGENT_MOMENTS"] as const;
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;
let A = "", B = "";

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Choice Athlete");
  B = await seedAthlete("Other Athlete");
});
afterAll(closeTestDb);
beforeEach(() => {
  for (const k of FLAGS) saved[k] = process.env[k];
  process.env.MILA_WELCOME = "true";
  process.env.AGENT_POST_KITS = "true";
  process.env.AGENT_MOMENTS = "true";
});
afterEach(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

let n = 0;
const fresh = async () => seedAthlete(`Fresh ${++n}`);
const rows = async (athleteId: string) => db.select().from(milaChoices).where(eq(milaChoices.athlete_id, athleteId));
const history = async (athleteId: string) =>
  db.select().from(milaChoiceHistory).where(eq(milaChoiceHistory.athlete_id, athleteId)).orderBy(asc(milaChoiceHistory.capability), asc(milaChoiceHistory.version));

/** Drive an athlete-wide choice into `state` along allowed moves (taps). */
async function reach(athleteId: string, capability: string, state: PreferenceState) {
  const path: Record<PreferenceState, ChoiceState[]> = {
    unset: [], enabled: ["enabled"], not_now: ["not_now"], never: ["never"], paused: ["enabled", "paused"], revoked: ["enabled", "revoked"],
  };
  for (const to of path[state]) expect(await setChoice({ athleteId, capability, to, via: "me", now: NOW })).toMatchObject({ ok: true });
}

describe("C1 transitions", () => {
  const states: PreferenceState[] = ["unset", "enabled", "not_now", "never", "paused", "revoked"];
  const targets: ChoiceState[] = ["enabled", "not_now", "never", "paused", "revoked"];
  const cases = states.flatMap((from) => targets.map((to) => [from, to] as const));

  it.each(cases)("%s → %s follows the table", async (from, to) => {
    const id = await fresh();
    await reach(id, "post_ideas", from);
    const r = await setChoice({ athleteId: id, capability: "post_ideas", to, via: "me", now: NOW });
    if (TRANSITIONS[from].includes(to)) {
      expect(r).toMatchObject({ ok: true });
      expect((await getChoice(id, "post_ideas")).state).toBe(to);
    } else {
      expect(r).toMatchObject({ ok: false, error: "invalid_transition" });
      expect((await getChoice(id, "post_ideas")).state).toBe(from);
    }
  });

  it("no row means unset; the same answer twice changes nothing (no second history row)", async () => {
    const id = await fresh();
    expect(await getChoice(id, "post_ideas")).toMatchObject({ state: "unset", version: 0, consent: null });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "never", via: "chat" })).toMatchObject({ ok: true, changed: true });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "never", via: "chat" })).toMatchObject({ ok: true, changed: false });
    expect(await history(id)).toHaveLength(1);
  });

  it("a yes is a tap: card, Me or Settings — never words in chat; declining, pausing and turning off can be said", async () => {
    const id = await fresh();
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "chat" })).toMatchObject({ ok: false, error: "needs_tap" });
    expect(await getChoice(id, "post_ideas")).toMatchObject({ state: "unset" });
    for (const via of ["card", "me", "settings"] as const) {
      const other = await fresh();
      expect(await setChoice({ athleteId: other, capability: "post_ideas", to: "enabled", via })).toMatchObject({ ok: true });
    }
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "not_now", via: "chat" })).toMatchObject({ ok: true });
    await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card" });
    expect(await pauseChoice(id, "post_ideas", null, "chat")).toMatchObject({ ok: true });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "chat" })).toMatchObject({ ok: false, error: "needs_tap" });
  });

  it("core capabilities are never a choice; unknown, planned or flagged-off ones cannot be said yes to", async () => {
    const id = await fresh();
    expect(await setChoice({ athleteId: id, capability: "deal_watch", accountRef: null, to: "never", via: "me" })).toMatchObject({ ok: false, error: "core_capability" });
    expect(await setChoice({ athleteId: id, capability: "nope", to: "enabled", via: "me" })).toMatchObject({ ok: false, error: "unknown_capability" });
    expect(await setChoice({ athleteId: id, capability: "reminders", to: "enabled", via: "me" })).toMatchObject({ ok: false, error: "not_available" });
    process.env.AGENT_MOMENTS = "false";
    expect(await setChoice({ athleteId: id, capability: "moments_scan", to: "enabled", via: "me" })).toMatchObject({ ok: false, error: "not_available" });
    expect(await setChoice({ athleteId: id, capability: "moments_scan", to: "not_now", via: "card" })).toMatchObject({ ok: true });
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("C2 not now", () => {
  it("cooldowns lengthen 14 → 30 → 60 → 90 and stop there; never becomes never by itself", async () => {
    const id = await fresh();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await setChoice({ athleteId: id, capability: "post_ideas", to: "not_now", via: "card", now: NOW });
      expect(r.ok).toBe(true);
      const c = await getChoice(id, "post_ideas");
      seen.push(Math.round((Date.parse(c.cooldownUntil!) - NOW.getTime()) / DAY));
      expect(c.state).toBe("not_now");
      expect(c.notNowCount).toBe(i + 1);
    }
    expect(seen).toEqual([...NOT_NOW_COOLDOWN_DAYS, 90, 90]);
    await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card", now: NOW });
    expect((await getChoice(id, "post_ideas")).cooldownUntil).toBeNull();
  });
});

describe("C3 uniqueness under concurrency", () => {
  it("racing answers leave one row per key, linear versions and one history row per change", async () => {
    const id = await fresh();
    const answers = await Promise.all(Array.from({ length: 12 }, () => setChoice({ athleteId: id, capability: "post_ideas", to: "not_now", via: "card", now: NOW })));
    expect(answers.every((a) => a.ok)).toBe(true);
    const r = await rows(id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ version: 12, not_now_count: 12, state: "not_now" });
    expect((await history(id)).map((h) => h.version)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("first answers racing on an unset choice create one row", async () => {
    const id = await fresh();
    const out = await Promise.all([
      setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card", expectedVersion: 0 }),
      setChoice({ athleteId: id, capability: "post_ideas", to: "never", via: "card", expectedVersion: 0 }),
    ]);
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.filter((o) => !o.ok)).toEqual([expect.objectContaining({ error: "version_conflict" })]);
    expect(await rows(id)).toHaveLength(1);
    expect(await history(id)).toHaveLength(1);
  });

  it("the database refuses a second row for the same key, NULL account included", async () => {
    const id = await fresh();
    await setChoice({ athleteId: id, capability: "post_ideas", to: "never", via: "card" });
    await expect(db.insert(milaChoices).values({ athlete_id: id, capability: "post_ideas", scope: "athlete", state: "enabled", via: "me", consent_version: "post_ideas/1", consent: {} }))
      .rejects.toThrow();
    // An enabled row with no consent copy, and a per-account row with no account, are refused too.
    await expect(db.insert(milaChoices).values({ athlete_id: id, capability: "moments_scan", scope: "athlete", state: "enabled", via: "me" })).rejects.toThrow();
    await expect(db.insert(milaChoices).values({ athlete_id: id, capability: "draft_replies", scope: "per_account", state: "never", via: "me" })).rejects.toThrow();
  });

  it("a stale expectedVersion is refused and changes nothing", async () => {
    const id = await fresh();
    await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card" });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "paused", via: "me", expectedVersion: 0 })).toMatchObject({ ok: false, error: "version_conflict" });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "paused", via: "me", expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(await getChoice(id, "post_ideas")).toMatchObject({ state: "paused", version: 2 });
  });
});

describe("C4 history reconstruction", () => {
  it("replaying the history rebuilds the current row, with the consent copy each yes covered", async () => {
    const id = await fresh();
    await setChoice({ athleteId: id, capability: "post_ideas", to: "not_now", via: "card", now: NOW });
    await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card", now: new Date(NOW.getTime() + DAY) });
    await setChoice({ athleteId: id, capability: "post_ideas", to: "paused", via: "chat", now: new Date(NOW.getTime() + 2 * DAY) });
    await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "me", now: new Date(NOW.getTime() + 3 * DAY) });
    await setChoice({ athleteId: id, capability: "post_ideas", to: "revoked", via: "settings", now: new Date(NOW.getTime() + 4 * DAY) });

    const h = await history(id);
    expect(h.map((x) => [x.from_state, x.to_state, x.via])).toEqual([
      [null, "not_now", "card"], ["not_now", "enabled", "card"], ["enabled", "paused", "chat"], ["paused", "enabled", "me"], ["enabled", "revoked", "settings"],
    ]);
    // Each row's from_state is the previous row's to_state: the chain is unbroken.
    for (let i = 1; i < h.length; i++) expect(h[i].from_state).toBe(h[i - 1].to_state);
    const yes = h.filter((x) => x.to_state === "enabled");
    expect(yes.every((x) => x.consent_version === "post_ideas/1" && (x.consent as any)?.automatic?.length)).toBe(true);

    const [current] = await rows(id);
    const last = h[h.length - 1];
    const rebuilt = { state: last.to_state, via: last.via, version: last.version, consent_version: last.consent_version, consent: last.consent, not_now_count: last.not_now_count, cooldown_until: last.cooldown_until, decided_at: last.created_at };
    expect(rebuilt).toEqual({ state: current.state, via: current.via, version: current.version, consent_version: current.consent_version, consent: current.consent, not_now_count: current.not_now_count, cooldown_until: current.cooldown_until, decided_at: current.decided_at });
  });
});

describe("C5 account scope", () => {
  it("per mailbox: a yes for one is not a yes for another; wrong kind, another athlete's, or no account is refused", async () => {
    const id = await fresh();
    const m1 = await seedConnection({ athleteId: id, platform: "gmail", email: "one@example.org" });
    const m2 = await seedConnection({ athleteId: id, platform: "outlook", email: "two@example.org" });
    const yt = await seedConnection({ athleteId: id, platform: "youtube" });
    const theirs = await seedConnection({ athleteId: B, platform: "gmail", email: "theirs@example.org" });

    expect(await setChoice({ athleteId: id, capability: "draft_replies", accountRef: m1, to: "enabled", via: "card" })).toMatchObject({ ok: true });
    expect(await isAllowed(id, "draft_replies", m1, "draft_reply")).toMatchObject({ allowed: true });
    expect(await isAllowed(id, "draft_replies", m2, "draft_reply")).toMatchObject({ allowed: false, reason: "unset" });

    expect(await setChoice({ athleteId: id, capability: "draft_replies", to: "enabled", via: "card" })).toMatchObject({ ok: false, error: "scope" });
    expect(await setChoice({ athleteId: id, capability: "post_ideas", accountRef: m1, to: "enabled", via: "card" })).toMatchObject({ ok: false, error: "scope" });
    expect(await setChoice({ athleteId: id, capability: "draft_replies", accountRef: yt, to: "enabled", via: "card" })).toMatchObject({ ok: false, error: "account_does_not_fit" });
    expect(await setChoice({ athleteId: id, capability: "draft_replies", accountRef: theirs, to: "enabled", via: "card" })).toMatchObject({ ok: false, error: "account_not_found" });
    expect(await isAllowed(B, "draft_replies", m1, "draft_reply")).toMatchObject({ allowed: false, reason: "account_not_connected" });
  });

  it("reconnecting: an expired-then-reconnected account keeps its choice; a different account never inherits it; disconnect revokes", async () => {
    const id = await fresh();
    const m1 = await seedConnection({ athleteId: id, platform: "gmail", email: "a@example.org", platformUserId: "acct-a" });
    await setChoice({ athleteId: id, capability: "draft_replies", accountRef: m1, to: "enabled", via: "card" });

    // Token expires: running pauses, the preference does not move.
    await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, m1));
    expect(await isAllowed(id, "draft_replies", m1, "draft_reply")).toMatchObject({ allowed: false, reason: "account_not_connected" });
    expect((await getChoice(id, "draft_replies", m1)).state).toBe("enabled");
    // Reconnect of the same provider account reuses its row (0071): allowed again, no new answer needed.
    await db.update(connectedAccounts).set({ status: "active" }).where(eq(connectedAccounts.id, m1));
    expect(await isAllowed(id, "draft_replies", m1, "draft_reply")).toMatchObject({ allowed: true });

    // The athlete disconnects it and connects a different mailbox on the same platform.
    await db.update(connectedAccounts).set({ status: "revoked" }).where(eq(connectedAccounts.id, m1));
    expect(await revokeForAccount(id, m1, "settings")).toEqual(["draft_replies"]);
    const m2 = await seedConnection({ athleteId: id, platform: "gmail", email: "b@example.org", platformUserId: "acct-b" });
    expect(await isAllowed(id, "draft_replies", m2, "draft_reply")).toMatchObject({ allowed: false, reason: "unset" });
    // Reconnecting the first account later does not turn its capabilities back on.
    await db.update(connectedAccounts).set({ status: "active" }).where(eq(connectedAccounts.id, m1));
    expect(await isAllowed(id, "draft_replies", m1, "draft_reply")).toMatchObject({ allowed: false, reason: "revoked" });
    expect((await rows(id)).map((r) => [r.account_ref, r.state])).toEqual([[m1, "revoked"]]);
  });
});

describe("C6 isAllowed", () => {
  it("only enabled is allowed", async () => {
    for (const s of ["unset", "not_now", "never", "paused", "revoked"] as const) {
      const id = await fresh();
      await reach(id, "post_ideas", s);
      expect(await isAllowed(id, "post_ideas", null, "propose_post_ideas")).toEqual({ allowed: false, reason: s });
    }
    const id = await fresh();
    await reach(id, "post_ideas", "enabled");
    expect(await isAllowed(id, "post_ideas", null, "propose_post_ideas")).toEqual({ allowed: true, reason: "enabled" });
    expect(await isAllowed(id, "post_ideas")).toEqual({ allowed: true, reason: "enabled" });
  });

  it("core is always allowed; a flagged-off or planned capability never is", async () => {
    const id = await fresh();
    expect(await isAllowed(id, "deal_watch")).toEqual({ allowed: true, reason: "core" });
    await reach(id, "moments_scan", "enabled");
    process.env.AGENT_MOMENTS = "false";
    expect(await isAllowed(id, "moments_scan", null, "scan_moments")).toEqual({ allowed: false, reason: "not_available" });
    expect(await isAllowed(id, "reminders")).toEqual({ allowed: false, reason: "not_available" });
  });

  it("within the consent it covered: an action outside it is refused; one that always needs a tap is never automatic", async () => {
    const id = await fresh();
    const m = await seedConnection({ athleteId: id, platform: "gmail", email: "c@example.org" });
    await setChoice({ athleteId: id, capability: "draft_replies", accountRef: m, to: "enabled", via: "card" });
    expect(await isAllowed(id, "draft_replies", m, "draft")).toMatchObject({ allowed: true });
    expect(await isAllowed(id, "draft_replies", m, "send_reply")).toMatchObject({ allowed: false, reason: "needs_approval" });
    expect(await isAllowed(id, "draft_replies", m, "read_new_mail")).toMatchObject({ allowed: false, reason: "action_not_covered" });

    // The yes was given under an older, narrower consent: the newer action is not covered until a new yes.
    await db.update(milaChoices).set({ consent_version: "draft_replies/0", consent: { version: "draft_replies/0", automatic: [], drafts: true, internalRecords: false, alwaysApprove: [], onRevoke: "stop_and_keep" } })
      .where(and(eq(milaChoices.athlete_id, id), eq(milaChoices.capability, "draft_replies")));
    expect(await isAllowed(id, "draft_replies", m, "draft_reply")).toMatchObject({ allowed: false, reason: "action_not_covered" });
    expect(await setChoice({ athleteId: id, capability: "draft_replies", accountRef: m, to: "enabled", via: "card" })).toMatchObject({ ok: true, changed: true });
    expect(await isAllowed(id, "draft_replies", m, "draft_reply")).toMatchObject({ allowed: true });
  });

  it("pausing or turning off a needed capability stops its dependents (the check function)", async () => {
    const consent = (key: string) => ({ version: `${key}/1`, automatic: [{ action: "run", says: "Run" }], drafts: false, internalRecords: false, alwaysApprove: [], onRevoke: "stop_and_keep" as const });
    const entry = (key: string, over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
      key, name: key, core: false, scope: "athlete", needs: null, betterWith: null, unlocks: [], skill: "content", tools: [], workers: [],
      offer: { signals: ["pick_content"], reasonKey: `${key}.reason`, firstSession: false }, consent: consent(key), optInTarget: "choice", status: "built", flag: null, ...over,
    });
    const registry = [entry("base_cap", { unlocks: ["child_cap"] }), entry("child_cap", { needs: { capability: "base_cap" } })];
    const id = await fresh();
    for (const k of ["base_cap", "child_cap"]) expect(await setChoice({ athleteId: id, capability: k, to: "enabled", via: "me" }, { registry })).toMatchObject({ ok: true });
    expect(await isAllowed(id, "child_cap", null, "run", { registry })).toEqual({ allowed: true, reason: "enabled" });
    await setChoice({ athleteId: id, capability: "base_cap", to: "paused", via: "me" }, { registry });
    expect(await isAllowed(id, "child_cap", null, "run", { registry })).toEqual({ allowed: false, reason: "needs_unmet", detail: "base_cap: paused" });
    expect((await getChoice(id, "child_cap")).state).toBe("enabled");   // its own preference is untouched
  });
});

describe("C6b needs: one answer per capability in a walk (hand-made registry)", () => {
  const consent = (key: string) => ({ version: `${key}/1`, automatic: [{ action: "run", says: "Run" }], drafts: false, internalRecords: false, alwaysApprove: [], onRevoke: "stop_and_keep" as const });
  const entry = (key: string, over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
    key, name: key, core: false, scope: "athlete", needs: null, betterWith: null, unlocks: [], skill: "content", tools: [], workers: [],
    offer: { signals: ["pick_content"], reasonKey: `${key}.reason`, firstSession: false }, consent: consent(key), optInTarget: "choice", status: "built", flag: null, ...over,
  });
  // top needs B and C (any / all); B and C both need D: a diamond.
  const diamond = (op: "any" | "all") => [
    entry("top_cap", { needs: { [op]: [{ capability: "b_cap" }, { capability: "c_cap" }] } as CapabilityEntry["needs"] }),
    entry("b_cap", { needs: { capability: "d_cap" } }),
    entry("c_cap", { needs: { capability: "d_cap" } }),
    entry("d_cap", { unlocks: ["b_cap", "c_cap"] }),
  ];
  async function enableAll(id: string, registry: CapabilityEntry[]) {
    for (const e of registry) expect(await setChoice({ athleteId: id, capability: e.key, to: "enabled", via: "me" }, { registry })).toMatchObject({ ok: true });
  }

  for (const op of ["any", "all"] as const) {
    it(`${op}: a shared need that fails fails through BOTH siblings (no allowed-on-revisit)`, async () => {
      const registry = diamond(op);
      const id = await fresh();
      await enableAll(id, registry);
      expect(await isAllowed(id, "top_cap", null, "run", { registry })).toEqual({ allowed: true, reason: "enabled" });
      await setChoice({ athleteId: id, capability: "d_cap", to: "paused", via: "me" }, { registry });
      expect(await isAllowed(id, "top_cap", null, "run", { registry })).toEqual({
        allowed: false, reason: "needs_unmet", detail: op === "any" ? "c_cap: needs_unmet" : "b_cap: needs_unmet",
      });
      expect(await isAllowed(id, "c_cap", null, "run", { registry })).toEqual({ allowed: false, reason: "needs_unmet", detail: "d_cap: paused" });
    });
  }

  it("a cycle fails closed (the validator rejects them; this is the guard)", async () => {
    const registry = [entry("x_cap", { needs: { capability: "y_cap" } }), entry("y_cap", { needs: { capability: "x_cap" } })];
    const id = await fresh();
    await enableAll(id, registry);
    expect(await isAllowed(id, "x_cap", null, "run", { registry })).toEqual({ allowed: false, reason: "needs_unmet", detail: "y_cap: needs_unmet" });
    expect(await isAllowed(id, "y_cap", null, "run", { registry })).toEqual({ allowed: false, reason: "needs_unmet", detail: "x_cap: needs_unmet" });
  });
});

describe("C7 the flag", () => {
  it("writes are refused while MILA_WELCOME is off; nothing is stored", async () => {
    const id = await fresh();
    delete process.env.MILA_WELCOME;
    expect(await setChoice({ athleteId: id, capability: "post_ideas", to: "enabled", via: "card" })).toMatchObject({ ok: false, error: "disabled" });
    expect(await revokeForAccount(id, "x", "settings")).toEqual([]);
    expect(await rows(id)).toEqual([]);
    expect((await db.execute(sql`select count(*)::int as n from mila_choice_history where athlete_id = ${id}`)).rows).toEqual([{ n: 0 }]);
  });
});
