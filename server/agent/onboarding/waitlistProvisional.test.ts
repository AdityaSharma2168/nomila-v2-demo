/**
 * waitlistProvisional.test.ts — the wait screen's EARLY facts (waitlistProgress.ts provisionalFindingsFrom): a search
 * pass's own facts, shown as soon as that pass finishes instead of after the merge (~5 minutes sooner on prod's
 * 24 Oct sign-up). Pure: no database, no provider.
 */
jest.mock("../../db", () => ({ db: {} }));

import { provisionalFindingsFrom } from "./waitlistProgress";

const NAME = "Riley Athlete";
const SRC = "https://news.example/riley";
const fact = (over: Record<string, unknown> = {}) => ({
  claim: "Riley Athlete captains the Example State team.", topic: "team", source_url: SRC, source_title: "Example News",
  subject_kind: "athlete", subject_name: NAME, confidence: 0.9, sensitivity: "public", ...over,
});
const pass = (facts: unknown[], resolved = true, sources = [{ url: SRC, title: "Example News" }]) =>
  ({ json: { identity: { resolved, description: "", ambiguity: "" }, facts }, sources });

test("a finished pass's sourced facts about her become findings", () => {
  const out = provisionalFindingsFrom([pass([fact()])], NAME);
  expect(out).toEqual([{ kind: "about", text: "Riley Athlete captains the Example State team.", source: { label: "Example News", url: SRC } }]);
});

test("a pass that could not confirm who she is shows nothing (a namesake's facts are never hers)", () => {
  expect(provisionalFindingsFrom([pass([fact()], false)], NAME)).toEqual([]);
});

test("care facts, facts with a source the pass never saw, and facts about someone else are left out", () => {
  const out = provisionalFindingsFrom([pass([
    fact({ claim: "Riley Athlete had surgery.", sensitivity: "care" }),
    fact({ claim: "Riley Athlete won a title.", topic: "achievement", source_url: "https://elsewhere.example/x" }),
    fact({ claim: "Jordan Other signed with a club.", subject_name: "Jordan Other" }),
  ])], NAME);
  expect(out).toEqual([]);
});

test("both passes count, duplicates are shown once", () => {
  const out = provisionalFindingsFrom([pass([fact()]), pass([fact(), fact({ claim: "Riley Athlete won the conference final.", topic: "achievement" })])], NAME);
  expect(out.map((f) => f.text)).toEqual(["Riley Athlete captains the Example State team.", "Riley Athlete won the conference final."]);
});
