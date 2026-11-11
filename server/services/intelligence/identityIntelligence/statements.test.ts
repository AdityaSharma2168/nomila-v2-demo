/**
 * statements.test.ts — athleteStatements() ranking and caps, pure (rankStatement / selectStatements).
 *
 *   R1 provenance, medium, recency and length sanity rank deterministically
 *   R2 per-topic caps (untopiced statements bucket by medium), the total cap, duplicate text, the topic filter
 *   R3 (0.7) the partner-content disclosure marker (the deal and brand-tag sources are in the integration test, S2)
 * Fixtures are fictional.
 */
jest.mock("../../../db", () => ({ db: {} }));   // pure: nothing here reads the database

import { hasDisclosureMarker, rankStatement, selectStatements, type AthleteStatement } from "./statements";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const st = (id: string, over: Partial<AthleteStatement>): AthleteStatement => {
  const s = { id, ref: { kind: "media_asset", id } as const, text: "A statement long enough to count.", provenance: "her_own" as const, medium: "caption", topics: [], at: "2026-09-01T00:00:00.000Z", acquisition: {}, intent: false, rank: 0, ...over };
  return { ...s, rank: rankStatement(s, NOW) };
};

describe("R1 ranking", () => {
  it("source_read > her own form words > caption; recent > old; too short is penalised", () => {
    const read = st("a", { provenance: "source_read", medium: "video" });
    const form = st("b", { medium: "form" });
    const caption = st("c", {});
    const oldCaption = st("d", { at: "2020-01-01T00:00:00.000Z" });
    const short = st("e", { text: "gm" });
    expect([read, form, caption, oldCaption, short].map((s) => s.rank)).toEqual([0.7, 0.65, 0.5, 0.3, 0.2]);
  });
});

describe("R2 selection", () => {
  const pool = [
    st("m1", { provenance: "source_read", medium: "video", topics: ["motivation"] }),
    st("m2", { provenance: "source_read", medium: "article", topics: ["motivation"], at: "2026-08-01T00:00:00.000Z", text: "Another statement long enough." }),
    st("m3", { provenance: "source_read", medium: "article", topics: ["motivation", "values"], at: "2026-07-01T00:00:00.000Z", text: "A third statement long enough." }),
    st("c1", { text: "Caption one long enough to count." }),
    st("c2", { text: "Caption two long enough to count.", at: "2026-08-01T00:00:00.000Z" }),
    st("dup", { text: "Caption one long enough to count.", at: "2026-01-01T00:00:00.000Z" }),
  ];
  it("caps per topic, buckets untopiced by medium, drops duplicate text, and orders by rank then recency", () => {
    const out = selectStatements(pool, { limitPerTopic: 1, maxTotal: 10 });
    // m1 fills motivation; m3 still fits through values; one caption.
    expect(out.map((s) => s.id)).toEqual(["m1", "m3", "c1"]);
    expect(selectStatements(pool, { limitPerTopic: 5, maxTotal: 3 }).map((s) => s.id)).toEqual(["m1", "m2", "m3"]);
    expect(selectStatements(pool, { limitPerTopic: 5, maxTotal: 10 }).map((s) => s.id)).not.toContain("dup");
  });
  it("filters by topic", () => {
    expect(selectStatements(pool, { topics: ["values"], limitPerTopic: 5, maxTotal: 10 }).map((s) => s.id)).toEqual(["m3"]);
  });
});

describe("R3 partner content (0.7): the disclosure marker", () => {
  it("matches #ad, #sponsored and \"paid partnership\" in any case; never a hashtag that only starts with one", () => {
    for (const c of ["Race day #ad", "#AD race day", "New kit (#Sponsored)", "Paid Partnership with a gym", "in paid partnership with a club"]) expect(hasDisclosureMarker(c)).toBe(true);
    for (const c of ["#adventure on the water", "#adidasish", "#sponsoredby", "sponsored by nobody", "a partnership with my team", "#advice"]) expect(hasDisclosureMarker(c)).toBe(false);
  });
});
