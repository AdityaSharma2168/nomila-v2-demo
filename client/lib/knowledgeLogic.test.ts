/**
 * knowledgeLogic.test.ts — the pure helpers behind Concept 0.4 Me / What Nomila Knows.
 *
 * Pinned:
 *   • counts read "N things Nomila knows" — the word "verified" never appears
 *   • each missing-data state has its own wording
 *   • a correctable entry becomes the RecordSheet's entry (same field, shape and raw); a research-only one does not
 *   • the identity line is factual parts only, in order
 */

import { canDispute, entryLogoUri, entryStateText, glanceModel, greetingFor, honourName, identityLine, knowsLine, meIdentityLines, presentEntries, sourceSummary, sourceTint, sportIcon, tierText, toRecordEntry } from "./knowledgeLogic";

test("sportIcon: the avatar's fallback glyph by the KIND of sport, 'activity' for one the families do not place, 'user' with none", () => {
  expect(sportIcon("Women's Soccer")).toBe("disc");
  expect(sportIcon("Basketball")).toBe("disc");
  expect(sportIcon("Swimming & Diving")).toBe("droplet");
  expect(sportIcon("Rowing")).toBe("droplet");
  expect(sportIcon("Track and Field")).toBe("wind");
  expect(sportIcon("Wrestling")).toBe("shield");
  expect(sportIcon("Golf")).toBe("target");
  expect(sportIcon("Gymnastics")).toBe("activity");
  expect(sportIcon("")).toBe("user");
  expect(sportIcon(null)).toBe("user");
});
import type { AthleteKnowledge, KnowledgeEntry } from "../hooks/use-me-knowledge";

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: "position", label: "Position", value: "Striker", state: "present", source: { key: "you", label: "Confirmed by you", detail: null },
  status: "current", stale: false, at: "2026-09-01T00:00:00.000Z", evidence: [], correct: { field: "position", shape: "text", label: "Position" }, ...over,
});

test("greeting by the hour", () => {
  expect(greetingFor(new Date(2026, 8, 30, 8))).toBe("Good morning");
  expect(greetingFor(new Date(2026, 8, 30, 14))).toBe("Good afternoon");
  expect(greetingFor(new Date(2026, 8, 30, 21))).toBe("Good evening");
});

test("counts are things Nomila knows, never verified facts", () => {
  expect(knowsLine(1)).toBe("1 thing Nomila knows");
  expect(knowsLine(12)).toBe("12 things Nomila knows");
  expect(knowsLine(0)).toBe("Nothing yet");
  expect(knowsLine(null)).toBe("Not tracked yet");
  expect([knowsLine(3), sourceSummary({ you: 2, official: 1 })].join(" ").toLowerCase()).not.toContain("verified");
});

test("missing-data wording per state", () => {
  expect(entryStateText({ state: "present" })).toBe("");
  expect(entryStateText({ state: "not_yet_computed" })).toBe("Not researched yet");
  expect(entryStateText({ state: "unavailable" })).toBe("Not available yet");
  expect(entryStateText({ state: "unknown" })).toBe("Not on record");
});

test("source tints and summary order", () => {
  expect(sourceTint("you")).toBe("said");
  expect(sourceTint("proof")).toBe("proof");
  expect(sourceTint("inbox")).toBe("found");   // a model read her inbox; not her confirmation
  expect(sourceSummary({ inbox: 1, proof: 2 })).toBe("2 from deals · 1 from inbox");
  expect(sourceTint("official")).toBe("found");
  expect(sourceTint(null)).toBe("none");
  expect(sourceSummary({ researched: 2, you: 5, official: 3 })).toBe("5 from you · 3 official · 2 researched");
});

test("a correctable entry opens the existing record editor; a research-only one does not", () => {
  const r = toRecordEntry(entry({ correct: { field: "affiliations", shape: "teams", label: "Teams", raw: { index: 0, teams: [] } } }));
  expect(r).toMatchObject({ field: "affiliations", shape: "teams", raw: { index: 0, teams: [] }, editable: true, kind: "said", actions: ["change", "tell_mila", "history"] });
  expect(toRecordEntry(entry({ correct: null }))).toBeNull();
});

test("identity line is factual parts only", () => {
  expect(identityLine({ displayName: "Cole", fullName: "Canon Cole", photoUrl: null, primary: { label: "Canon Soccer", org: "Canon University", orgKind: "school", sport: "Soccer", source: null }, facts: ["Striker", "Junior"] })).toBe("Canon Soccer · Striker · Junior");
  expect(identityLine({ displayName: "A", fullName: "A", photoUrl: null, primary: null, facts: [] })).toBeNull();
});

test("Me identity lines: team + sport, then role · facts, then nationality; nulls when empty", () => {
  const primary = { label: "Canon Soccer", org: "Canon University", orgKind: "school", sport: "Soccer", source: null };
  expect(meIdentityLines({ displayName: "Cole", fullName: "Canon Cole", photoUrl: null, primary, facts: ["Striker", "Junior"], role: "Captain", nationality: "Testland" }))
    .toEqual({ primary: "Canon Soccer", detail: "Captain · Striker · Junior", nationality: "Testland" });
  expect(meIdentityLines({ displayName: "A", fullName: "A", photoUrl: null, primary: null, facts: [] })).toEqual({ primary: null, detail: null, nationality: null });
  expect(meIdentityLines(null)).toEqual({ primary: null, detail: null, nationality: null });
});

// ─── knowledge/3 ───────────────────────────────────────────────────────────────

describe("knowledge/3 helpers", () => {
  const official = { key: "official" as const, label: "Official source", detail: null };
  const researched = { key: "researched" as const, label: "Researched", detail: "news.example" };

  test("tierText: her word, the source, reported / unconfirmed in words; never verified", () => {
    expect(tierText(entry({ tier: "established" }))).toBe("Confirmed by you");
    expect(tierText(entry({ source: official, tier: "established" }))).toBe("Official source");
    expect(tierText(entry({ source: researched, tier: "reported" }))).toBe("Researched · reported");
    expect(tierText(entry({ source: researched, tier: "unconfirmed" }))).toBe("Researched · unconfirmed");
    expect(tierText(entry({ source: official, tier: "unconfirmed", yourDispute: { said: null, at: null } }))).toBe("You said this isn't right");
    expect(tierText(entry({ state: "unknown", value: null, source: null }))).toBeNull();
    const all = ["established", "reported", "unconfirmed"].map((t) => tierText(entry({ source: official, tier: t as any }))).join(" ").toLowerCase();
    expect(all).not.toContain("verified");
  });

  test("entryLogoUri: from logoDomain only; none ⇒ null (the icon)", () => {
    expect(entryLogoUri({ logoDomain: "club.example" })).toContain("club.example");
    expect(entryLogoUri({ logoDomain: null })).toBeNull();
    expect(entryLogoUri({})).toBeNull();
  });

  test("honourName strips the trailing year; canDispute only for present, uncorrectable, undisputed entries", () => {
    expect(honourName({ value: "Player of the Year (2025)" })).toBe("Player of the Year");
    expect(honourName({ value: "#3 national — Body (2024)" })).toBe("#3 national — Body");
    expect(canDispute(entry({ correct: null }))).toBe(true);
    expect(canDispute(entry())).toBe(false);
    expect(canDispute(entry({ correct: null, yourDispute: { said: null, at: null } }))).toBe(false);
    expect(canDispute(entry({ correct: null, state: "unknown" }))).toBe(false);
  });

  test("glanceModel and presentEntries read the served view", () => {
    const k = {
      keyFacts: [
        entry({ id: "name", value: "Sam Example" }), entry({ id: "team_1", label: "School", value: "Example University" }),
        entry({ id: "sport", value: "Example Sport" }), entry({ id: "position", value: "Example Position" }), entry({ id: "hometown", value: "Example City" }),
        entry({ id: "nationality", value: "Testland" }), entry({ id: "class_year", value: "Senior · 2026 season" }),
      ],
      categories: [{ key: "athletics", sections: [{ key: "teams", entries: [entry({ id: "team_1" }), entry({ id: "teams", state: "unknown", value: null })] }] }],
    } as unknown as AthleteKnowledge;
    const g = glanceModel(k);
    expect(g.team?.value).toBe("Example University");
    expect(g.sportLine).toBe("Example Sport · Example Position");
    expect([g.place?.value, g.nationality?.value, g.classYear?.value]).toEqual(["Example City", "Testland", "Senior · 2026 season"]);
    expect(presentEntries(k, "athletics", "teams").map((e) => e.id)).toEqual(["team_1"]);
    expect(presentEntries(k, "academics", "education")).toEqual([]);
    expect(glanceModel(null)).toMatchObject({ team: null, sportLine: null, all: [] });
  });
});
