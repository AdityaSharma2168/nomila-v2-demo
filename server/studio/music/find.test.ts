/**
 * find.test.ts — the finder's rules, and THE guard: a brand post is never handed a track that is not brand-safe.
 */
import { availableCatalogue, findMusic, isMusicId, MUSIC_CATALOGUE, MUSIC_USES, type MusicTrack } from "./find";
import { ENERGY_BANDS, NEIGHBOUR_MOODS, TEMPO_BANDS, TRACK_MOODS, tempoBandOf } from "./taxonomy";
import { MUSIC_TRACKS } from "./tracks";
import { LIBRARY_TRACKS } from "./library";

const t = (id: string, over: Partial<MusicTrack> = {}): MusicTrack => ({
  id, title: id, artist: "A", moods: ["hype"], energyLevel: 5, energy: "high", bpm: 128, firstBeatSec: null, genre: "rock",
  themes: [], vocals: "instrumental", durationSec: 150, loops: false, brandSafe: false, licence: "CC-BY-4.0",
  credit: `"${id}" by A`, creditShort: `"${id}" by A, CC BY 4.0`, contentIdRegistered: null, gcsPath: `studio/tracks/free/${id}.m4a`, ...over,
});

describe("THE GUARD: brand use never gets a track that is not brand-safe", () => {
  const lengths = [undefined, 5, 30, 200, 600];
  it("over the real catalogue, for every mood × energy × tempo × length", () => {
    let calls = 0;
    for (const mood of TRACK_MOODS) for (const energy of [undefined, ...ENERGY_BANDS]) for (const tempo of [undefined, ...TEMPO_BANDS]) for (const minLengthSec of lengths) {
      const r = findMusic({ mood, use: "brand", energy, tempo, minLengthSec });
      calls++;
      if (r.ok) for (const f of r.tracks) expect([mood, f.track.id, f.track.brandSafe]).toEqual([mood, f.track.id, true]);
    }
    expect(calls).toBe(TRACK_MOODS.length * 4 * 4 * lengths.length);
  });

  it("over a catalogue where the best matches are all NOT brand-safe", () => {
    const cat = Object.fromEntries([
      ...["a", "b", "c", "d"].map((id) => [id, t(id)]),
      ["safe", t("safe", { brandSafe: true, moods: ["driving"], energy: "low", bpm: 70, credit: null, licence: "CC0-1.0" })],
    ]);
    const r = findMusic({ mood: "hype", use: "brand", energy: "high", tempo: "fast" }, cat);
    expect(r.ok && r.tracks.map((f) => f.track.id)).toEqual(["safe"]);
    const none = findMusic({ mood: "reflective", use: "brand" }, cat);
    expect(none.ok).toBe(false);
  });

  it("brand_safe_only on a personal post narrows the same way", () => {
    for (const mood of TRACK_MOODS) {
      const r = findMusic({ mood, use: "personal", brandSafeOnly: true });
      if (r.ok) for (const f of r.tracks) expect(f.track.brandSafe).toBe(true);
    }
  });
});

describe("the ranking", () => {
  it("returns three by default, best first, and never the same track twice", () => {
    for (const mood of TRACK_MOODS) for (const use of MUSIC_USES) {
      const r = findMusic({ mood, use });
      if (!r.ok) continue;
      expect(r.tracks.length).toBeLessThanOrEqual(3);
      expect(new Set(r.tracks.map((f) => f.track.id)).size).toBe(r.tracks.length);
      const scores = r.tracks.map((f) => f.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
  });

  it("every mood has three personal-use tracks that carry it — no neighbour needed", () => {
    for (const mood of TRACK_MOODS) {
      const r = findMusic({ mood, use: "personal" });
      expect([mood, r.ok && r.tracks.every((f) => f.track.moods.includes(mood))]).toEqual([mood, true]);
      expect([mood, r.ok && r.tracks.length]).toEqual([mood, 3]);
    }
  });

  it("mood is hard: a neighbour comes in only to fill, flagged, and says so", () => {
    const cat = { a: t("a"), b: t("b", { moods: ["driving"] }), c: t("c", { moods: ["reflective"] }) };
    const r = findMusic({ mood: "hype", use: "personal" }, cat);
    expect(r.ok && r.tracks.map((f) => [f.track.id, f.neighbour])).toEqual([["a", false], ["b", true]]);
    expect(r.ok && r.tracks[1].reason).toContain("closest to hype");
    expect(NEIGHBOUR_MOODS.hype).toContain("driving");
  });

  it("energy and tempo pull the closest match up", () => {
    const cat = { slow: t("slow", { energy: "low", bpm: 80 }), fast: t("fast", { energy: "high", bpm: 140 }) };
    const lo = findMusic({ mood: "hype", use: "personal", energy: "low", tempo: "slow" }, cat);
    const hi = findMusic({ mood: "hype", use: "personal", energy: "high", tempo: "fast" }, cat);
    expect(lo.ok && lo.tracks[0].track.id).toBe("slow");
    expect(hi.ok && hi.tracks[0].track.id).toBe("fast");
  });

  it("a track shorter than the cut is ranked down unless it loops", () => {
    const cat = { short: t("short", { durationSec: 20 }), shortLoop: t("shortLoop", { durationSec: 20, loops: true }), long: t("long", { durationSec: 90 }) };
    const r = findMusic({ mood: "hype", use: "personal", minLengthSec: 45 }, cat);
    expect(r.ok && r.tracks.map((f) => f.track.id)).toEqual(["long", "shortLoop", "short"]);
    expect(r.ok && r.tracks[2].reason).toContain("only 0:20");
  });

  it("a reason names only the track's own facts", () => {
    for (const mood of TRACK_MOODS) {
      const r = findMusic({ mood, use: "personal", tempo: "fast", energy: "medium" });
      if (!r.ok) continue;
      for (const f of r.tracks) {
        expect(f.reason).toContain(`${f.track.energy} energy`);
        expect(f.reason).toContain(`${Math.round(f.track.bpm)} BPM`);
        if (f.reason.includes(", fast")) expect(tempoBandOf(f.track.bpm)).toBe("fast");
        for (const m of TRACK_MOODS) if (f.reason.split(" · ")[0].split(/[ ,()]+/).includes(m) && m !== mood) expect([m, f.track.moods.includes(m) || f.neighbour]).toEqual([m, true]);
      }
    }
  });

  it("an empty answer says what to try instead", () => {
    const r = findMusic({ mood: "dark", use: "personal" }, { a: t("a", { moods: ["bright"] }) });
    expect(r).toEqual({ ok: false, reason: 'No track carries "dark" or a mood near it. Try one of: bright.' });
  });
});

describe("the catalogue", () => {
  it("offers the free library only where its files are installed (STUDIO_MUSIC_LIBRARY_READY)", () => {
    expect(Object.keys(availableCatalogue(false, true)).sort()).toEqual(Object.keys(MUSIC_TRACKS).sort());
    expect(Object.keys(availableCatalogue(true, true)).length).toBe(Object.keys(MUSIC_CATALOGUE).length);
  });

  it("M2: unless MUSIC_ALLOW_ATTRIBUTION_TRACKS is on, nothing that needs a credit is offered — the manifest keeps them", () => {
    const owed = Object.values(MUSIC_CATALOGUE).filter((t) => t.credit);
    expect(owed.length).toBeGreaterThan(0);
    const off = availableCatalogue(true);
    for (const t of Object.values(off)) expect([t.id, t.credit]).toEqual([t.id, null]);
    expect(Object.keys(off).length).toBe(Object.keys(MUSIC_CATALOGUE).length - owed.length);
    process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS = "true";
    try { expect(Object.keys(availableCatalogue(true)).length).toBe(Object.keys(MUSIC_CATALOGUE).length); }
    finally { delete process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS; }
  });

  it("a credit owed has a short form (title, author, licence) for a caption with no room", () => {
    for (const m of Object.values(MUSIC_CATALOGUE)) {
      if (!m.credit) { expect([m.id, m.creditShort]).toEqual([m.id, null]); continue; }
      for (const part of [m.title, m.artist, "CC BY"]) expect([m.id, part, (m.creditShort ?? "").includes(part)]).toEqual([m.id, part, true]);
      expect([m.id, m.creditShort!.length < m.credit.length]).toEqual([m.id, true]);
    }
  });

  it("is the licensed tracks and the free library, with no id in both", () => {
    const ids = Object.keys(MUSIC_CATALOGUE);
    expect(ids.length).toBe(Object.keys(MUSIC_TRACKS).length + Object.keys(LIBRARY_TRACKS).length);
    for (const id of Object.keys(MUSIC_TRACKS)) expect(isMusicId(id)).toBe(true);
    expect(isMusicId("toString")).toBe(false);
    expect(isMusicId("studio/tracks/save.m4a")).toBe(false);
  });

  it("a theme pulls a track filed under it up, and its reason says so", () => {
    const cat = { a: t("a"), b: t("b", { themes: ["championships"] }) };
    const r = findMusic({ mood: "hype", use: "personal", theme: "championships" }, cat);
    expect(r.ok && r.tracks[0].track.id).toBe("b");
    expect(r.ok && r.tracks[0].reason).toContain("championships");
  });

  it("prefers a track with no credit to carry, and an instrumental over a sung one, when all else is equal", () => {
    const cat = { owes: t("owes"), free: t("free", { credit: null, licence: "CC0-1.0" }), sung: t("sung", { credit: null, licence: "CC0-1.0", vocals: "vocal" }) };
    const r = findMusic({ mood: "hype", use: "personal" }, cat);
    expect(r.ok && r.tracks.map((f) => f.track.id)).toEqual(["free", "owes", "sung"]);
  });

  it("a track that owes a credit carries it; a CC0 or licensed one carries none", () => {
    for (const m of Object.values(MUSIC_CATALOGUE)) {
      if (m.licence.startsWith("CC-BY")) expect([m.id, typeof m.credit]).toEqual([m.id, "string"]);
      else expect([m.id, m.credit]).toEqual([m.id, null]);
    }
  });
});
