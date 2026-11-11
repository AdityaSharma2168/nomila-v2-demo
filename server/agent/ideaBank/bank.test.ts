/**
 * bank.test.ts — the idea bank's rules (agent/ideaBank/bank.ts) on their own: pure views over rows, and the conditional
 * writes on the in-memory store (no model, no database).
 *
 *   K1 entryOf reads a jsonb row defensively: not an idea, no hook or no format from the list → not an entry
 *   K2 listBank: the event a time-bound idea is for (its own fact, else its moment's), whether its moment is still
 *      pending, the moment's name, how many assets it is built on
 *   K3 planBank: a moment's own entry takes the first I-keys in MOMENTS order; then timely ideas whose event the plan sees
 *      and whose moment is pending, soonest first, then evergreen ones newest first, at most BANK_LINES; never used or
 *      skipped; missed = new timely ideas whose moment went in the last MISSED_DAYS, newest first, at most MISSED_LINES;
 *      a pillar renamed or dropped from the Brief is said so
 *   K4 rewindForDigest undoes only what the plan itself did and nobody acted on; spentMomentIds
 *   K5 planPillars: the newest post action per pillar, matched by name (case and punctuation folded), in the lookback
 *   K6 patchIdea writes only over what it read, re-reads on a race, gives up after WRITE_ATTEMPTS; handBackIdeas only
 *      returns an idea still used by the expired action
 *   K7 the IDEA BANK block reserves SLOTS_PER_KIND for each kind; a kind that is short gives its slots to the other
 *   K8 missed: never a partner campaign's idea, never one whose moment was retired as cancelled or wrong
 *   K9 a moment's entry expires with its period (a month-only moment: the month's last day)
 *   K10 two plan runs racing for one missed idea: only one adapts it (the claim writes its claimant into the row); a
 *      retried apply of the claimant finishes, any other claimant is refused
 *   K11 a crashed claim is taken over (its action expired, a run's claim past CLAIM_LEASE_MS, no claimant recorded); a
 *      live one (a pending action's, a run's inside the lease) is not; a claim taken over before its child row is
 *      written writes no child
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Decision } from "../../../shared/agent";
import type { IdeaBankEntry } from "../../../shared/postKit";
import type { PlanAction } from "../../../shared/plan";
import type { PlanEvent } from "../plan/validate";
import { createMemoryStore, type AgentStore } from "../research/store";
import { applyIdeaMoves, bankSlots, emptyBankApplied, entryOf, filePostIdea, handBackIdeas, listBank, mirrorMoment, patchIdea, planBank, planPillars, rewindForDigest, spentMomentIds, type BankIdea } from "./bank";
import { IDEA_BANK } from "./config";

const A = "00000000-0000-4000-8000-0000000000cc";
const TODAY = "2026-10-10";

const entry = (over: Partial<IdeaBankEntry> = {}): IdeaBankEntry => ({
  kind: "idea", timeBound: false, pillarKey: null, pillarName: null, momentDecisionId: null, expiresOn: null,
  idea: { hook: "A hook.", format: "reel", platform: "instagram", timing: "this week" },
  brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", status: "new", usedInDecisionId: null, adaptedFromIdeaId: null, ...over,
});
const bankIdea = (id: string, over: Partial<IdeaBankEntry> = {}, more: Partial<BankIdea> = {}): BankIdea => ({
  decisionId: id, skillId: "post-kit/ideas", entry: entry({ idea: { hook: `HOOK-${id}`, format: "reel", platform: "instagram", timing: "t" }, ...over }),
  eventFactId: null, momentPending: null, momentName: null, momentCategory: null, momentRetiredWhy: null, assets: 1, createdAt: "2026-10-01T00:00:00.000Z", ...more,
});
const event = (factId: string, label: string, date: string): PlanEvent => ({ factId, label, date, precision: "day", fact: {} as PlanEvent["fact"] });

test("K1: entryOf — only a usable idea", () => {
  expect(entryOf(undefined)).toBeNull();
  expect(entryOf({ kind: "moment" })).toBeNull();
  expect(entryOf({ kind: "idea", idea: { hook: "", format: "reel" } })).toBeNull();
  expect(entryOf({ kind: "idea", idea: { hook: "h", format: "billboard" } })).toBeNull();
  // moments 1.2.0: a moment's own entry carries a hook and an angle (its caption angle), and no format: still an idea.
  expect(entryOf({ kind: "idea", timeBound: true, idea: { hook: "h" }, brief: { show: "", captionAngle: "the angle", avoid: "" } })).toMatchObject({
    idea: { hook: "h", format: null }, brief: { captionAngle: "the angle" },
  });
  // An older row (no pillarName, no status) reads with safe defaults.
  expect(entryOf({ kind: "idea", timeBound: true, idea: { hook: " h ", format: "feed" }, expiresOn: "2026-10-20", status: "bogus" })).toEqual({
    kind: "idea", timeBound: true, pillarKey: null, pillarName: null, momentDecisionId: null, expiresOn: "2026-10-20",
    idea: { hook: "h", format: "feed", platform: "", timing: "" }, brief: { show: "", captionAngle: "", avoid: "" }, mediaNeeds: "",
    status: "new", usedInDecisionId: null, adaptedFromIdeaId: null,
  });
});

test("K2: listBank — its event, its moment, its assets", async () => {
  const store = createMemoryStore();
  const moment = await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "m", why: "w", evidence: [{ kind: "fact", factId: "fact-m" }], detail: { kind: "moment", factId: "fact-m", name: "City derby" } });
  const gone = await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "g", why: "w", evidence: [], detail: { kind: "moment", factId: "fact-g", name: "Old gala" } });
  await store.respondDecision(A, gone.id, "expired", "passed");
  const file = (skillId: string, e: IdeaBankEntry, evidence: Decision["evidence"]) => store.insertDecision(A, { runId: null, skillId, kind: "other", suggested: e.idea.hook, why: "w", evidence, detail: e as unknown as Record<string, unknown> });
  await file("post-kit/ideas", entry({ timeBound: true, momentDecisionId: moment.id }), [{ kind: "record", table: "media_assets", id: "a1" }, { kind: "record", table: "media_assets", id: "a2" }]);
  await file("moments", entry({ timeBound: true, momentDecisionId: gone.id }), [{ kind: "fact", factId: "own-fact" }]);
  await file("plan", entry(), [{ kind: "fact", factId: "f1" }]);
  await store.insertDecision(A, { runId: null, skillId: "goals", kind: "other", suggested: "not an idea", why: "w", evidence: [] });
  const bank = await listBank(store, A);
  expect(bank.map((b) => [b.skillId, b.eventFactId, b.momentPending, b.momentName, b.assets])).toEqual([
    ["post-kit/ideas", "fact-m", true, "City derby", 2],
    ["moments", "own-fact", false, "Old gala", 0],
    ["plan", null, null, null, 0],                                                      // evergreen: no event
  ]);
});

test("K3: planBank — keys, order, caps, missed", () => {
  const events = new Map([["E1", event("f-open", "Home opener", "2026-10-18")], ["E2", event("f-derby", "City derby", "2026-10-25")]]);
  const pillars = new Map([["P1", { key: "P1", name: "Race days" }]]);
  const evergreen = Array.from({ length: IDEA_BANK.BANK_LINES + 2 }, (_, i) => bankIdea(`ever-${i}`, {}, { createdAt: `2026-10-0${i % 9 + 1}T00:00:00.000Z` }));
  const bank: BankIdea[] = [
    bankIdea("own-open", { timeBound: true, momentDecisionId: "m-open" }, { skillId: "moments", eventFactId: "f-open", momentPending: true }),
    bankIdea("own-derby-used", { timeBound: true, momentDecisionId: "m-derby", status: "used" }, { skillId: "moments", eventFactId: "f-derby", momentPending: true }),
    bankIdea("derby-clip", { timeBound: true, momentDecisionId: "m-derby" }, { eventFactId: "f-derby", momentPending: true }),
    bankIdea("open-clip", { timeBound: true, momentDecisionId: "m-open" }, { eventFactId: "f-open", momentPending: true }),
    bankIdea("far", { timeBound: true }, { eventFactId: "f-far", momentPending: null }),                       // its event is not one the plan sees
    bankIdea("old-pillar", { pillarKey: "P1", pillarName: "Training" }, { createdAt: "2026-10-09T12:00:00.000Z" }),
    bankIdea("skipped", { status: "skipped" }, { createdAt: "2026-10-09T13:00:00.000Z" }),
    ...evergreen,
    bankIdea("missed-new", { timeBound: true, expiresOn: "2026-10-30" }, { momentPending: false, momentName: "Autumn gala" }),
    bankIdea("missed-past", { timeBound: true, expiresOn: "2026-10-01" }, { momentPending: true, momentName: "Fall cup" }),
    bankIdea("missed-too-old", { timeBound: true, expiresOn: "2026-08-01" }, { momentPending: false }),
    bankIdea("missed-adapted", { timeBound: true, expiresOn: "2026-10-02", status: "adapted" }, { momentPending: false }),
  ];
  const v = planBank(bank, { today: TODAY, events, shownMomentIds: ["m-derby", "m-open"], pillars });
  // A moment's own entry first (MOMENTS order; the used one gets none); then timely soonest first; then evergreen newest first.
  expect([...v.momentKeys]).toEqual([["m-open", "I1"]]);
  expect([...v.ideas].map(([k, b]) => [k, b.decisionId]).slice(0, 4)).toEqual([["I1", "own-open"], ["I2", "open-clip"], ["I3", "derby-clip"], ["I4", "old-pillar"]]);
  expect(v.ideas.size).toBe(1 + IDEA_BANK.BANK_LINES);
  expect([...v.ideas.values()].some((b) => ["own-derby-used", "far", "skipped"].includes(b.decisionId))).toBe(false);
  expect(v.bankLines[0]).toBe("I2 | timely | E1 Home opener | from the athlete's new photos and clips (1) | hook: HOOK-open-clip | reel on instagram | timing: t");
  expect(v.bankLines).toContain("I4 | evergreen | Training (a pillar no longer in the Brief) | from the athlete's new photos and clips (1) | hook: HOOK-old-pillar | reel on instagram | timing: t");
  expect(v.bankLines.filter((l) => /^I\d+ /.test(l))).toHaveLength(IDEA_BANK.BANK_LINES);
  // Missed: its moment expired, or its date passed; in the window; new only; newest first.
  expect([...v.missed].map(([k, b]) => [k, b.decisionId])).toEqual([["X1", "missed-new"], ["X2", "missed-past"]]);
  expect(v.missedLines[0]).toBe("X1 | missed: Autumn gala (2026-10-30) | hook: HOOK-missed-new | reel on instagram | timing: t");
});

test("K4: rewindForDigest and spentMomentIds", () => {
  const bank = [
    bankIdea("own", { timeBound: true, momentDecisionId: "m1", status: "used", usedInDecisionId: "pending-action" }, { skillId: "moments" }),
    bankIdea("answered", { status: "used", usedInDecisionId: "accepted-action" }),
    bankIdea("adapted", { timeBound: true, status: "adapted" }),
    bankIdea("fresh", { status: "used", usedInDecisionId: "pending-action" }, { skillId: "plan" }),
  ];
  expect(spentMomentIds(bank)).toEqual(new Set(["m1"]));
  const rewound = rewindForDigest(bank, new Set(["pending-action"]));
  expect(rewound.map((b) => [b.decisionId, b.entry.status, b.entry.usedInDecisionId])).toEqual([
    ["own", "new", null], ["answered", "used", "accepted-action"], ["adapted", "new", null],
  ]);
  expect(spentMomentIds(rewound)).toEqual(new Set());
});

test("K5: planPillars — the newest post per pillar, matched by name", () => {
  const post = (createdAt: string, name: string | null) => ({ createdAt, detail: { kind: "post", idea: name ? { ideaId: "i", pillar: { key: "P9", name } } : null } as Record<string, unknown> });
  const p = planPillars(
    [{ key: "P1", name: "Race days", whyThisAthlete: "Champion.", factIds: ["f1"] }, { key: "P2", name: "Training & the work", whyThisAthlete: "w", factIds: [] }],
    [post("2026-10-02T00:00:00.000Z", "race days"), post("2026-10-06T00:00:00.000Z", "Race Days!"), post("2026-10-08T00:00:00.000Z", null)],
    (ids) => ids.map(() => "F3").join(", "),
  );
  expect(p.lines).toEqual([
    "P1 | Race days | why: Champion. | last post: 2026-10-06 [F3]",
    `P2 | Training & the work | why: w | last post: none in the last ${IDEA_BANK.PILLAR_LOOKBACK_DAYS} days`,
  ]);
  expect([...p.pillars.keys()]).toEqual(["P1", "P2"]);
});

test("K6: patchIdea writes over what it read; handBackIdeas returns only an idea still used by the expired action", async () => {
  const store = createMemoryStore();
  const row = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "other", suggested: "h", why: "w", evidence: [], detail: entry({ status: "used", usedInDecisionId: "act-1" }) as unknown as Record<string, unknown> });
  // A writer that lands between the read and the write: the patch re-reads and applies over the newer row.
  let raced = false;
  const racy: AgentStore = {
    ...store,
    async updateDecision(athleteId, id, patch) {
      if (!raced) { raced = true; await store.updateDecision(athleteId, id, { detail: { ...(await store.getDecision(athleteId, id))!.detail, mediaNeeds: "NEWER" } }); }
      return store.updateDecision(athleteId, id, patch);
    },
  };
  const out = emptyBankApplied();
  await handBackIdeas(racy, A, [{ id: "act-2", detail: { idea: { ideaId: row.id, pillar: null } } }], out);   // used by another action
  expect(out.returned).toEqual([]);
  await handBackIdeas(racy, A, [{ id: "act-1", detail: { idea: { ideaId: row.id, pillar: null } } }], out);
  expect(out.returned).toEqual([row.id]);
  expect((await store.getDecision(A, row.id))!.detail).toMatchObject({ status: "new", usedInDecisionId: null, mediaNeeds: "NEWER" });
  // A row that never stops moving: given up after WRITE_ATTEMPTS, nothing written.
  let writes = 0;
  const busy: AgentStore = { ...store, async updateDecision() { writes++; return null; } };
  expect(await patchIdea(busy, A, row.id, (e) => ({ ...e, status: "skipped" }))).toBeNull();
  expect(writes).toBe(IDEA_BANK.WRITE_ATTEMPTS);
  expect((await store.getDecision(A, row.id))!.detail).toMatchObject({ status: "new" });
});

test("K7: slots per kind — reserved, and a short kind gives its spare to the other", () => {
  const n = (k: string, c: number) => Array.from({ length: c }, (_, i) => `${k}${i}`);
  const per = IDEA_BANK.SLOTS_PER_KIND;
  const total = IDEA_BANK.BANK_LINES;
  // Many of both: each kind gets its reserve.
  expect(bankSlots(n("t", 10), n("e", 10))).toEqual({ timely: n("t", per), evergreen: n("e", total - per) });
  // Evergreen starved by a flood of timely ideas no more: timely cannot take the evergreen reserve …
  expect(bankSlots(n("t", 20), n("e", 2)).evergreen).toEqual(n("e", 2));
  expect(bankSlots(n("t", 20), n("e", 2)).timely).toHaveLength(total - 2);
  // … and the other way round.
  expect(bankSlots(n("t", 1), n("e", 20))).toEqual({ timely: n("t", 1), evergreen: n("e", total - 1) });
  // In the plan's view: 10 timely and 10 evergreen ideas → 4 and 4.
  const events = new Map([["E1", event("f1", "Home opener", "2026-10-18")]]);
  const bank = [
    ...Array.from({ length: 10 }, (_, i) => bankIdea(`t${i}`, { timeBound: true }, { eventFactId: "f1", momentPending: true })),
    ...Array.from({ length: 10 }, (_, i) => bankIdea(`e${i}`)),
  ];
  const v = planBank(bank, { today: TODAY, events, shownMomentIds: [], pillars: new Map() });
  const kinds = [...v.ideas.values()].map((b) => (b.entry.timeBound ? "timely" : "evergreen"));
  expect(kinds.filter((k) => k === "timely")).toHaveLength(per);
  expect(kinds.filter((k) => k === "evergreen")).toHaveLength(total - per);
});

test("K8: missed — never a partner campaign's idea, never a cancelled or wrong moment's", () => {
  const missed = (id: string, more: Partial<BankIdea>) => bankIdea(id, { timeBound: true, expiresOn: "2026-10-05" }, { momentPending: false, ...more });
  const v = planBank([
    missed("plain", {}),
    missed("partner", { momentCategory: "partner_campaign" }),
    missed("cancelled", { momentRetiredWhy: "cancelled" }),
    missed("wrong", { momentRetiredWhy: "wrong" }),
    missed("moved", { momentRetiredWhy: "moved" }),
    missed("not-worth", { momentRetiredWhy: "not_worth_a_post" }),
  ], { today: TODAY, events: new Map(), shownMomentIds: [], pillars: new Map() });
  expect([...v.missed.values()].map((b) => b.decisionId).sort()).toEqual(["moved", "not-worth", "plain"]);
});

test("K9: a month-only moment's entry expires on the month's last day", async () => {
  const store = createMemoryStore();
  await mirrorMoment(store, A, "run-1", "moment-1", {
    kind: "moment", factId: "f1", name: "Rivalry month", date: "2026-11-01", datePrecision: "month", category: "league", whyNow: "w", rank: 1,
    idea: { hook: "h", format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m", scannedAt: "2026-10-10T00:00:00.000Z",
  }, undefined);
  const [row] = await store.listDecisions(A, { kinds: ["other"] });
  expect(row.detail).toMatchObject({ expiresOn: "2026-11-30", momentDecisionId: "moment-1" });
});

test("K10: two plan runs racing for one missed idea — only one adapts it (the claim changes the row)", async () => {
  const store = createMemoryStore();
  const missed = await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "MISSED", why: "w", evidence: [{ kind: "fact", factId: "f-old" }], detail: entry({ timeBound: true, expiresOn: "2026-10-05", idea: { hook: "MISSED", format: "reel", platform: "instagram", timing: "t" } }) as unknown as Record<string, unknown> });
  // Both runs finish every read of the plan's rows ("nothing filed for me, no adapted row yet": two listings each)
  // before either writes: the children check alone cannot tell them apart.
  let listings = 0;
  let release: () => void = () => {};
  const bothChecked = new Promise<void>((r) => { release = r; });
  const racing: AgentStore = {
    ...store,
    async listDecisions(athleteId, q) {
      const rows = await store.listDecisions(athleteId, q);
      if (q?.skillId === "plan" && ++listings === 4) release();
      return rows;
    },
    async updateDecision(athleteId, id, patch) {
      await bothChecked;
      return store.updateDecision(athleteId, id, patch);
    },
  };
  const action = (actionId: string): [PlanAction, string] => [{
    goalRef: { kind: "goal", goalId: "g-1" }, kind: "post", what: `Post ${actionId}`, why: "w", dueOn: "2026-10-20", button: "post",
    event: { factId: "f-new", label: "Derby", date: "2026-10-25", precision: "day" },
    deliverable: { type: "post_brief", title: "t", body: "b", target: null, platform: "instagram", thread: null, connector: null }, factIds: ["f-new"],
    post: { hook: `HOOK-${actionId}`, format: "reel", show: "s", captionAngle: "c", avoid: "a", mediaNeeds: "m" },
    source: { from: "adapted", ideaId: missed.id, pillar: null, momentDecisionId: null },
  }, actionId];
  const [outA, outB] = [emptyBankApplied(), emptyBankApplied()];
  const [a, b] = await Promise.all([
    filePostIdea(racing, A, "run-a", ...action("act-a"), outA),
    filePostIdea(racing, A, "run-b", ...action("act-b"), outB),
  ]);
  // Exactly one run filed a row; the other was refused (its action keeps no bank source).
  expect([a, b].filter(Boolean)).toHaveLength(1);
  const children = (await store.listDecisions(A, { kinds: ["other"], skillId: "plan" })).filter((d) => (d.detail as unknown as IdeaBankEntry).adaptedFromIdeaId === missed.id);
  expect(children).toHaveLength(1);
  const winner = a ? "act-a" : "act-b";
  expect((await store.getDecision(A, missed.id))!.detail).toMatchObject({ status: "adapted", adaptedFor: winner });
  // The new row does not carry the old row's claim.
  expect(children[0].detail).toMatchObject({ status: "used", usedInDecisionId: winner });
  expect((children[0].detail as unknown as IdeaBankEntry).adaptedFor).toBeUndefined();
  expect([...outA.written, ...outB.written]).toEqual([children[0].id]);

  // A retried apply of the winner (claimed, row not yet written) finishes; any other claimant is still refused.
  const store2 = createMemoryStore();
  const actA = await store2.insertDecision(A, { runId: "run-a", skillId: "plan", kind: "action", suggested: "Post A", why: "w", evidence: [], detail: {} });
  const claimed = await store2.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "M2", why: "w", evidence: [], detail: entry({ timeBound: true, status: "adapted", adaptedFor: actA.id, adaptedAt: new Date().toISOString() }) as unknown as Record<string, unknown> });
  const adapting = (actionId: string, ideaId: string): [PlanAction, string] => {
    const [a, id] = action(actionId);
    return [{ ...a, source: { from: "adapted", ideaId, pillar: null, momentDecisionId: null } }, id];
  };
  expect(await filePostIdea(store2, A, "run-c", ...adapting("act-c", claimed.id), emptyBankApplied())).toBeNull();
  expect(await filePostIdea(store2, A, "run-a", ...adapting(actA.id, claimed.id), emptyBankApplied())).not.toBeNull();
});

test("K11: a crashed claim on a missed idea is taken over; a live one is not", async () => {
  const store = createMemoryStore();
  const missed = (claim: Partial<IdeaBankEntry>) => store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "M", why: "w", evidence: [], detail: entry({ timeBound: true, status: "adapted", ...claim }) as unknown as Record<string, unknown> });
  const event = { factId: "f-new", label: "Derby", date: "2026-10-25", precision: "day" as const };
  const adapt = (ideaId: string) => ({ move: "adapt" as const, ideaId, event, momentDecisionId: null, timing: "t", why: "w" });
  const childrenOf = async (ideaId: string) => (await store.listDecisions(A, { kinds: ["other"], skillId: "plan" })).filter((d) => (d.detail as unknown as IdeaBankEntry).adaptedFromIdeaId === ideaId);
  const stale = new Date(Date.now() - IDEA_BANK.CLAIM_LEASE_MS - 60_000).toISOString();

  // A post action that claimed it and then crashed before its row: a later plan expired that action, so it is free.
  const crashedAction = await store.insertDecision(A, { runId: "run-1", skillId: "plan", kind: "action", suggested: "Post", why: "w", evidence: [], detail: {} });
  await store.respondDecision(A, crashedAction.id, "expired", "not repeated");
  const a = await missed({ adaptedFor: crashedAction.id, adaptedAt: stale });
  const outA = emptyBankApplied();
  await applyIdeaMoves(store, A, "run-2", [adapt(a.id)], outA);
  expect(outA.adapted).toEqual([a.id]);
  expect(await childrenOf(a.id)).toHaveLength(1);
  expect((await store.getDecision(A, a.id))!.detail).toMatchObject({ status: "adapted", adaptedFor: "run-2" });

  // A run's move claim past the lease (the run crashed mid-apply): taken over.
  const b = await missed({ adaptedFor: "run-crashed", adaptedAt: stale });
  await applyIdeaMoves(store, A, "run-3", [adapt(b.id)], emptyBankApplied());
  expect(await childrenOf(b.id)).toHaveLength(1);

  // Still live — a pending action's claim, or a run's claim inside the lease — nothing is written.
  const pending = await store.insertDecision(A, { runId: "run-4", skillId: "plan", kind: "action", suggested: "Post", why: "w", evidence: [], detail: {} });
  const c = await missed({ adaptedFor: pending.id, adaptedAt: stale });
  const d = await missed({ adaptedFor: "run-in-flight", adaptedAt: new Date().toISOString() });
  const outC = emptyBankApplied();
  await applyIdeaMoves(store, A, "run-5", [adapt(c.id), adapt(d.id)], outC);
  expect(outC.adapted).toEqual([]);
  expect(await childrenOf(c.id)).toHaveLength(0);
  expect(await childrenOf(d.id)).toHaveLength(0);
  // A claim from before claims were recorded (adapted, no claimant, no child) is free too.
  const e = await missed({});
  await applyIdeaMoves(store, A, "run-6", [adapt(e.id)], emptyBankApplied());
  expect(await childrenOf(e.id)).toHaveLength(1);

  // Taken over between this claim and its child row (a slow apply judged crashed): the row no longer names it, so it
  // writes no child — the new holder does.
  const f = await missed({});
  const overtaken: AgentStore = {
    ...store,
    async updateDecision(athleteId, id, patch) {
      const done = await store.updateDecision(athleteId, id, patch);
      if (done && id === f.id) await store.updateDecision(athleteId, id, { detail: { ...done.detail, adaptedFor: "run-took-over" } });
      return done;
    },
  };
  const outF = emptyBankApplied();
  await applyIdeaMoves(overtaken, A, "run-7", [adapt(f.id)], outF);
  expect(outF.adapted).toEqual([]);
  expect(await childrenOf(f.id)).toHaveLength(0);
  expect((await store.getDecision(A, f.id))!.detail).toMatchObject({ adaptedFor: "run-took-over" });
});

test("K2b: listBank never reads an idea whose event fact is a care fact", async () => {
  const store = createMemoryStore();
  const [care, plain] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "Memorial" }, claim: "A memorial.", type: "found", source: { url: "https://example.org/m" }, date: "2026-10-20", confidence: 0.9, runId: null, sensitive: true, careKind: "personal" },
    { subject: { kind: "event", name: "Opener" }, claim: "The opener.", type: "found", source: { url: "https://example.org/o" }, date: "2026-10-21", confidence: 0.9, runId: null },
  ]);
  for (const f of [care, plain]) await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "h", why: "w", evidence: [{ kind: "fact", factId: f.id }], detail: entry({ timeBound: true }) as unknown as Record<string, unknown> });
  expect((await listBank(store, A)).map((b) => b.eventFactId)).toEqual([plain.id]);
});
