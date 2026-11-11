/**
 * record-fixtures.ts — regenerate the recorded fixtures the CI grader test reads.
 *
 *   npx tsx evals/agent/fixtures/record-fixtures.ts
 *
 * record.good.json  the FICTIONAL fixture case run through the real stages (runCase) with the fake model
 *                   (--mock's transport), the in-memory store, the stub M.I.A. and the stub judge. No provider, no DB.
 * record.bad.json   the same record with one known defect per grader (listed in BAD_MUTATIONS), so the test can
 *                   assert each grader catches its defect.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setResponsesTransport } from "../../../server/agent/research/llm";
import { createMemoryStore } from "../../../server/agent/research/store";
import { mockJudge, mockMia, mockTransportFor } from "../mock";
import { Budget, runCase, stagesFor } from "../runCase";
import type { CaseRecord, EvalCase } from "../types";

const DIR = join(process.cwd(), "evals", "agent", "fixtures");

export const BAD_MUTATIONS = [
  "research_a ran 12 searches (cap 10)",
  "research_b's JSON has a string where the schema wants a number",
  "a found fact with a personal email address and a URL no search saw",
  "the facts behind e1–e3 removed (recall 2/5)",
  "a found fact belonging to the same-name rower (wrong person)",
  "a Brief line with a gendered pronoun and an invented sponsor; another with a fact key",
  "a family name in the opening message (warn level)",
  "identity resolved, but a disputed #identity fact stands (inconsistent)",
  "the reveal card removed from the opening turn",
  "M.I.A. not_assessed",
  "research_a cost $2.50 (over the $2 cap)",
  "the judge failed no_unsupported_facts",
  "a plan action due after the event it is timed before",
  "the Brief keeps one content pillar, with no fact behind it",
];

export function mutate(good: CaseRecord): CaseRecord {
  const r: CaseRecord = JSON.parse(JSON.stringify(good));
  const a = r.runs.find((x) => x.role === "research_a")!;
  const b = r.runs.find((x) => x.role === "research_b")!;
  a.webSearchCalls = 12;
  (b.json as any).facts[0].confidence = "high";
  r.facts.push({ id: "bad-contact-0000", claim: "Contact Rowan Ellery at rowan.ellery@gmail.com for bookings.", type: "found", status: "active", subject: { kind: "athlete", name: "Rowan Ellery" }, sourceUrl: "https://unseen.example.net/contact", sourceRef: null, sensitive: false, runId: null });
  r.facts = r.facts.filter((f) => !/single sculls|Riverside Boat Club|Example Oars/.test(f.claim));
  r.facts.push({ id: "bad-wrong-0000", claim: "Rowan Ellery won the lightweight double at the 2019 regatta.", type: "found", status: "active", subject: { kind: "athlete", name: "Rowan Ellery" }, sourceUrl: a.sources[0]?.url ?? null, sourceRef: null, sensitive: false, runId: null });
  r.brief!.sections[0].lines.push({ text: "She is sponsored by Brandless Co.", kind: "fact", factIds: [] });
  r.brief!.sections[1].lines.push({ text: "The record (f3) carries the pitch.", kind: "inference", factIds: [] });
  const opening = r.turns.find((t) => t.key === "opening")!;
  opening.message = `${opening.message} Jamie Ellery will be proud.`;
  opening.cards = opening.cards.filter((k) => k.kind !== "reveal");
  r.facts.push({ id: "bad-identity-00", claim: "Research could not yet confirm which public profile belongs to Rowan Ellery (rowing).", type: "made", status: "disputed", subject: { kind: "athlete", name: "Rowan Ellery" }, sourceUrl: null, sourceRef: "agent_runs/x#identity", sensitive: false, runId: null });
  r.mia = { ...r.mia!, status: "not_assessed", score: null };
  a.costMicroUsd = 2_500_000;
  r.judge = { ...r.judge!, no_unsupported_facts: { pass: false, reason: "States a sponsor the facts do not contain.", statements: ["She is sponsored by Brandless Co."] } };
  r.plan!.actions[0] = { ...r.plan!.actions[0], dueOn: "2026-10-20", eventDate: "2026-10-18" };
  r.brief!.contentPillars = [{ key: "P1", name: "One pillar", whyThisAthlete: "Nothing behind it.", factIds: [] }];
  return r;
}

async function main() {
  const c = JSON.parse(readFileSync(join(DIR, "fixture-case.json"), "utf8")) as EvalCase;
  setResponsesTransport(mockTransportFor(c));
  try {
    const { record } = await runCase(c, stagesFor(null), {
      mode: "mock", store: createMemoryStore(), createAthlete: async () => "00000000-0000-4000-8000-00000000f1f1",
      mia: mockMia(c), judge: mockJudge, budget: new Budget(100_000_000), onboardingCapMicroUsd: 2_000_000, log: () => undefined, today: "2026-10-09",
    });
    // Stable across regenerations: fixed clock fields.
    const good: CaseRecord = { ...record, startedAt: "2026-10-09T12:00:00.000Z", wallMs: 1234 };
    writeFileSync(join(DIR, "record.good.json"), `${JSON.stringify(good, null, 2)}\n`);
    writeFileSync(join(DIR, "record.bad.json"), `${JSON.stringify({ ...mutate(good), _mutations: BAD_MUTATIONS }, null, 2)}\n`);
    console.log("wrote record.good.json and record.bad.json");
  } finally {
    setResponsesTransport(null);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
