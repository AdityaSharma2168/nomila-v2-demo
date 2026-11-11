/**
 * recommend.test.ts — the right kind of track leads, brand work never sees a track it may not use,
 * and every reason is true of the track it is attached to.
 */
import {
  FEEL_WORDS,
  readFeel,
  recommend,
  tempoOf,
  type RecommendRequest,
} from "./recommend";
import { MUSIC_TRACKS, TRACK_MOODS, type TrackDefinition } from "./tracks";

const real = MUSIC_TRACKS as Record<string, TrackDefinition>;

const base: Omit<TrackDefinition, "moods" | "bpm" | "energy" | "brandSafe"> = {
  title: "x",
  author: "x",
  license: "CC0-1.0",
  planHolder: null,
  sourceUrl: "https://example.test/x",
  retrievedOn: "2026-09-22",
  gcsPath: "studio/tracks/x.m4a",
  sha256: "0".repeat(64),
  durationSec: 120,
  firstBeatSec: 0,
};

/** "star" is the perfect match for a hype edit, and is NOT cleared for brand work. */
const synthetic: Record<string, TrackDefinition> = {
  star: {
    ...base,
    moods: ["hype", "bright"],
    bpm: 124,
    energy: 5,
    brandSafe: false,
  },
  cleared: {
    ...base,
    moods: ["driving"],
    bpm: 118,
    energy: 4,
    brandSafe: true,
  },
  calm: {
    ...base,
    moods: ["warm", "reflective"],
    bpm: 82,
    energy: 2,
    brandSafe: true,
  },
};

const ask = (feel: string, extra: Partial<RecommendRequest> = {}) =>
  recommend({ feel: [feel], forBrand: false, ...extra });

describe("the right kind of track leads", () => {
  it("warm, slow, golden light → a warm track under 100 BPM first", () => {
    const [first] = ask("warm, slow, golden light");
    const t = real[first.id];
    expect([first.id, t.moods.includes("warm"), t.bpm < 100]).toEqual([
      first.id,
      true,
      true,
    ]);
  });

  it("hype, fast → a track at 110 BPM or more first", () => {
    const [first] = ask("hype, fast");
    expect([first.id, real[first.id].bpm >= 110]).toEqual([first.id, true]);
  });

  it("no feel at all → ordered by distance from middle energy, nearest first", () => {
    const ranked = recommend({ feel: [], forBrand: false });
    expect(ranked).toHaveLength(Object.keys(real).length);
    const distances = ranked.map((r) => Math.abs(real[r.id].energy - 3));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("breaks a tie by id, so the same request always gives the same order", () => {
    const a = recommend({ feel: [], forBrand: false }).map((r) => r.id);
    const b = recommend({ feel: [], forBrand: false }).map((r) => r.id);
    expect(a).toEqual(b);
  });

  it("lets an explicit tempo win over a tempo word in her feel", () => {
    const [first] = recommend(
      { feel: ["slow"], tempo: "fast", forBrand: false },
      synthetic,
    );
    expect(tempoOf(synthetic[first.id].bpm)).toBe("fast");
  });
});

describe("brand work never sees a track that is not brandSafe", () => {
  it("drops it from the list entirely — not ranked low, absent", () => {
    const forBrand = recommend(
      { feel: ["hype"], tempo: "fast", forBrand: true },
      synthetic,
    ).map((r) => r.id);
    expect(["star", forBrand.includes("star")]).toEqual(["star", false]);
    expect(forBrand).toEqual(["cleared", "calm"]);
  });

  it("still offers it for her own content, where it is the best match", () => {
    const own = recommend(
      { feel: ["hype"], tempo: "fast", forBrand: false },
      synthetic,
    );
    expect(own[0].id).toBe("star");
  });

  it("holds for every request shape, not just the one above", () => {
    const feels = [[], ["hype"], ["warm", "slow"], ["bright", "fast"]];
    for (const feel of feels) {
      for (const energy of [undefined, 1, 5] as const) {
        const ids = recommend({ feel, energy, forBrand: true }, synthetic).map(
          (r) => r.id,
        );
        expect([feel.join(","), energy, ids.includes("star")]).toEqual([
          feel.join(","),
          energy,
          false,
        ]);
      }
    }
  });
});

describe("a reason is true of its track", () => {
  it("names only moods the track carries — for every mood asked, on both catalogues", () => {
    const moodWord = new RegExp(`\\b(${TRACK_MOODS.join("|")})\\b`, "g");
    const requests: string[][] = [
      [],
      ...TRACK_MOODS.map((m) => [m]),
      ["warm, slow, golden light"],
      ["hype, fast"],
      [...TRACK_MOODS],
    ];
    for (const cat of [real, synthetic]) {
      for (const feel of requests) {
        for (const r of recommend({ feel, forBrand: false }, cat)) {
          for (const named of r.reason.match(moodWord) ?? []) {
            expect([
              r.id,
              named,
              (cat[r.id].moods as readonly string[]).includes(named),
            ]).toEqual([r.id, named, true]);
          }
        }
      }
    }
  });

  it("states the track's own tempo and energy", () => {
    for (const r of ask("warm")) {
      expect(r.reason).toContain(`${Math.round(real[r.id].bpm)} BPM`);
      expect(r.reason).toContain(`energy ${real[r.id].energy}/5`);
    }
  });
});

describe("reading her words", () => {
  it("maps synonyms, picks up a tempo word, and ignores what it does not know", () => {
    expect(readFeel(["Golden, cozy — SLOW please, like a dream"])).toEqual({
      moods: ["warm"],
      tempo: "slow",
    });
  });

  it("does not read an inherited key as a feel word", () => {
    expect(readFeel(["constructor toString"])).toEqual({
      moods: [],
      tempo: undefined,
    });
  });

  it("maps every word only to a mood in the vocabulary or a tempo", () => {
    for (const [word, v] of Object.entries(FEEL_WORDS)) {
      expect([
        word,
        (TRACK_MOODS as readonly string[]).includes(v) ||
          ["slow", "mid", "fast"].includes(v),
      ]).toEqual([word, true]);
    }
  });
});
