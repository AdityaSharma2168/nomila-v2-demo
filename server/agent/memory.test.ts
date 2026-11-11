/**
 * memory.test.ts — the four memory layers on PGlite: facts need a source and supersede cleanly, the brief versions with
 * one current, decisions carry her response and the outcome, preferences retire — and nothing crosses athletes.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import {
  addPreference, currentBrief, disputeFact, listDecisions, listFacts, listPreferences, MemoryError, recordDecision, recordOutcome,
  respondToDecision, retirePreference, supersedeFact, writeBrief, writeFact,
} from "./memory";

let a: string;
let b: string;
beforeAll(async () => { await initTestDb(); a = await seedAthlete("Memory A"); b = await seedAthlete("Memory B"); }, 60_000);
afterAll(async () => { await closeTestDb(); });

const fact = (claim: string, source: { url?: string; ref?: string } = { ref: "chat:1" }) =>
  ({ subject: { kind: "athlete" as const, name: "Her" }, claim, type: "said" as const, source, confidence: 0.9 });

test("evidence: a source is required; supersede links old → new; dispute; scoped by athlete", async () => {
  await expect(writeFact(a, fact("No source", {}))).rejects.toBeInstanceOf(MemoryError);
  await expect(writeFact(a, { ...fact("Bad confidence"), confidence: 2 })).rejects.toBeInstanceOf(MemoryError);

  const old = await writeFact(a, fact("Old claim"));
  const next = await supersedeFact(a, old.id, fact("New claim", { url: "https://example.org/x" }));
  const all = await listFacts(a);
  expect(all.find((f) => f.id === old.id)).toMatchObject({ status: "superseded", supersededBy: next.id });
  expect((await listFacts(a, { status: "active" })).map((f) => f.claim)).toEqual(["New claim"]);
  await expect(supersedeFact(a, old.id, fact("Again"))).rejects.toThrow(/already superseded/);
  // Another athlete can neither supersede nor dispute her fact, nor see it.
  await expect(supersedeFact(b, next.id, fact("Hijack"))).rejects.toThrow(/not found/);
  expect(await disputeFact(b, next.id)).toBe(false);
  expect(await listFacts(b)).toEqual([]);
  expect(await disputeFact(a, next.id)).toBe(true);
  expect((await listFacts(a, { status: "disputed" })).map((f) => f.id)).toEqual([next.id]);
});

test("evidence: the store's formatting rules hold for this writer too (agent/factHygiene.ts)", async () => {
  const f = await writeFact(b, fact("Named captain ([example.org](https://example.org/news?utm_source=openai)).", { url: "https://example.org/news?utm_source=openai#top" }));
  expect(f.claim).toBe("Named captain.");
  expect(f.source.url).toBe("https://example.org/news");
  await expect(writeFact(b, fact("A logo", { url: "https://example.org/logo.png" }))).rejects.toThrow(/source_required/);
});

test("brief: versions with exactly one current; fact ids are the union of the sections'", async () => {
  expect(await currentBrief(a)).toBeNull();
  const v1 = await writeBrief(a, { summary: "First read", sections: [{ title: "Now", text: "x", factIds: ["f1"] }] });
  const v2 = await writeBrief(a, { summary: "Second read", sections: [{ title: "Now", text: "y", factIds: ["f1", "f2"] }, { title: "Next", text: "z", factIds: ["f2", "f3"] }] });
  expect([v1.version, v2.version]).toEqual([1, 2]);
  expect(await currentBrief(a)).toMatchObject({ id: v2.id, version: 2, status: "current", summary: "Second read", factIds: ["f1", "f2", "f3"] });
  expect(await currentBrief(b)).toBeNull();
});

test("decisions: suggested → her response → the outcome; scoped by athlete", async () => {
  const d = await recordDecision(a, { skillId: "test/skill", suggested: "Pitch a partner", why: "Fits her goal", evidence: [{ kind: "url", url: "https://example.org" }] });
  expect(d).toMatchObject({ response: "pending", outcome: "unknown" });
  expect(await respondToDecision(b, d.id, "accepted")).toBeNull();
  expect(await respondToDecision(a, d.id, "skipped", "Not this season")).toMatchObject({ response: "skipped", responseReason: "Not this season" });
  expect(await recordOutcome(a, d.id, "mixed", "Replied, no deal")).toMatchObject({ outcome: "mixed", outcomeNote: "Replied, no deal" });
  expect((await listDecisions(a)).map((x) => x.id)).toEqual([d.id]);
  expect(await listDecisions(b)).toEqual([]);
});

test("preferences: active until retired; scoped by athlete", async () => {
  const p = await addPreference(a, { kind: "avoid", statement: "No alcohol brands", source: "said" });
  await addPreference(a, { kind: "voice", statement: "Short and warm", source: "inferred" });
  expect((await listPreferences(a)).map((x) => x.kind).sort()).toEqual(["avoid", "voice"]);
  expect(await retirePreference(b, p.id)).toBe(false);
  expect(await retirePreference(a, p.id)).toBe(true);
  expect((await listPreferences(a)).map((x) => x.kind)).toEqual(["voice"]);
  expect(await listPreferences(b)).toEqual([]);
});
