/**
 * statementsView.test.ts — the HER WORDS presentation projection for /me/story (projectAthleteStatements), pure.
 *
 *   V1 verbatim: text, provenance, medium, topics, source (outlet / title / platform / URL) pass through unchanged
 *   V2 citation: a story object whose basis cites the statement's ref names it in citedBy; her `said` is cited by the
 *      row it was said about (assertion / objective / an objective event's objective); nothing else relates
 *   V3 truncation: only at a sentence boundary within the cap; a text with no boundary inside the cap stays whole
 * Fixtures are fictional.
 */
jest.mock("../../../db", () => ({ db: {} }));   // pure: nothing here reads the database

import type { AthleteStatement } from "./statements";
import { projectAthleteStatements, truncateAtSentence } from "./statementsView";

const st = (id: string, over: Partial<AthleteStatement>): AthleteStatement => ({
  id, ref: { kind: "media_asset", id }, text: "A statement long enough to count.", provenance: "her_own", medium: "caption", topics: [], at: "2026-09-01T00:00:00.000Z",
  acquisition: {}, intent: false, rank: 0.5, ...over,
});

describe("V1 verbatim pass-through", () => {
  it("carries the text, provenance, medium, topics and the source as stored", () => {
    const quote = st("evidence:q1", {
      ref: { kind: "evidence", id: "q1" }, provenance: "source_read", medium: "video", topics: ["motivation"],
      text: "I row because the quiet of the water clears my head.",
      acquisition: { outlet: "Outlet One", sourceTitle: "Morning interview", sourceUrl: "https://outlet-one.example/i", sourceType: "major_news", timestampSeconds: 95 },
    });
    const caption = st("media_asset:c1", { ref: { kind: "media_asset", id: "c1" }, partner: true, text: "Dawn on the water with the crew.", acquisition: { platform: "instagram", permalink: "https://instagram.example/p/1" } });
    const [q, c] = projectAthleteStatements([quote, caption], {});
    expect(q).toEqual({
      id: "evidence:q1", ref: { kind: "evidence", id: "q1" }, text: "I row because the quiet of the water clears my head.", truncated: false, provenance: "source_read", medium: "video",
      source: { outlet: "Outlet One", title: "Morning interview", platform: null, url: "https://outlet-one.example/i" }, topics: ["motivation"], at: "2026-09-01T00:00:00.000Z", intent: false, partner: false, citedBy: [],
    });
    expect(c.source).toEqual({ outlet: null, title: null, platform: "instagram", url: "https://instagram.example/p/1" });
    expect(c.text).toBe("Dawn on the water with the crew.");
    expect(c.partner).toBe(true);   // 0.7: partner content travels to the screen
  });
});

describe("V2 citation", () => {
  const quote = st("evidence:q1", { ref: { kind: "evidence", id: "q1" }, provenance: "source_read", medium: "article" });
  const said = st("said:assertion:a1", { ref: { kind: "said", source: "assertion", id: "a1" }, medium: "form", topics: ["origin"], text: "I grew up on the harbour, every morning." });
  const goal = st("said:objective:o1", { ref: { kind: "said", source: "objective", id: "o1" }, medium: "objective", topics: ["ambition"], intent: true, text: "Be known as the rower who builds the next crew." });
  const review = st("said:objective_event:e1", { ref: { kind: "said", source: "objective_event", id: "e1" }, medium: "objective_review", topics: ["ambition"], intent: true, acquisition: { objectiveId: "o2", action: "accept" }, text: "Coaching is what I want next." });

  it("names every slot whose basis cites the statement's own ref", () => {
    const out = projectAthleteStatements([quote], {
      motivation: [{ kind: "evidence", id: "q1" }], "pillar:competitor": [{ kind: "fact", id: "f1" }, { kind: "evidence", id: "q1" }], standsFor: null, essence: [{ kind: "fact", id: "f1" }],
    });
    expect(out[0].citedBy).toEqual(["motivation", "pillar:competitor"]);
  });

  it("her said is cited by the row it belongs to: the assertion, the Objective, an event's Objective", () => {
    const out = projectAthleteStatements([said, goal, review], {
      "chapters.origin": [{ kind: "assertion", id: "a1" }], positioningDesired: [{ kind: "objective", id: "o1" }], "chapters.now": [{ kind: "objective", id: "o2" }], throughline: [{ kind: "assertion", id: "a9" }],
    });
    expect(out.map((s) => s.citedBy)).toEqual([["chapters.origin"], ["positioningDesired"], ["chapters.now"]]);
  });

  it("relates nothing by text or topic — only the basis", () => {
    const out = projectAthleteStatements([said], { "chapters.origin": [{ kind: "fact", id: "hometown-fact" }] });
    expect(out[0].citedBy).toEqual([]);
    expect(out[0].topics).toEqual(["origin"]);   // the screen may still place it by topic; the projection does not decide
  });
});

describe("V3 truncation at a sentence boundary", () => {
  it("cuts after the last full sentence inside the cap and says so", () => {
    const text = "First sentence here. Second sentence, a bit longer than the first one! Third sentence that runs past the cap.";
    expect(truncateAtSentence(text, 60)).toEqual({ text: "First sentence here.", truncated: true });
    expect(truncateAtSentence(text, 80)).toEqual({ text: "First sentence here. Second sentence, a bit longer than the first one!", truncated: true });
    expect(truncateAtSentence(text, 500)).toEqual({ text, truncated: false });
  });
  it("keeps a closing quote mark with its sentence, and never cuts a sentence that has no boundary inside the cap", () => {
    expect(truncateAtSentence("“We never stopped.” Then the rest of it went on and on.", 24)).toEqual({ text: "“We never stopped.”", truncated: true });
    const run = "one long breathless sentence with no full stop anywhere near the start of it at all, and it keeps going until it ends.";
    expect(truncateAtSentence(run, 40)).toEqual({ text: run, truncated: false });
    expect(truncateAtSentence("No. 1 in the crew is what she said she wanted.", 10)).toEqual({ text: "No.", truncated: true });
  });
  it("applies the cap through the projection", () => {
    const long = st("x", { text: "Short one. " + "y".repeat(400) + "." });
    const [p] = projectAthleteStatements([long], {});
    expect(p).toMatchObject({ text: "Short one.", truncated: true });
  });
});
