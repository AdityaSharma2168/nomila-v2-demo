/**
 * beds.test.ts — what may be offered as music, and what has to be written down before it is.
 */
import {
  BED_LEVELS,
  BED_LICENSES,
  DEFAULT_BED_LEVEL,
  STITCH_BEDS,
  bedCatalog,
  bedFor,
  bedPreviewPath,
  isBedLevelName,
  isBedName,
  listedBedNames,
  type BedDefinition,
} from "./beds";
import { DEFAULT_BED } from "./plan";
import {
  MAX_STILL_SEC,
  MIN_STILL_SEC,
  isRefusal,
  parseStitchSpec,
  readStoredSpec,
} from "./spec";
import { MUSIC_TRACKS, type TrackDefinition } from "../music/tracks";
import { snapToBeat } from "../../../client/screens/studio/beatLogic";
import type { TimelineItem } from "../../../client/screens/studio/stitchLogic";

const beds = Object.entries(STITCH_BEDS as Record<string, BedDefinition>);

describe("a listed bed is a recorded bed", () => {
  it("has a licence from the closed set, an artist, its own page, a day and a hash", () => {
    // The gate a track has to pass to reach the picker. It is a TABLE TEST over whatever is listed,
    // so it guards the entry that is added next, not only the ones here today.
    for (const [name, bed] of beds.filter(([, b]) => b.listed)) {
      const p = bed.provenance;
      if (!p) throw new Error(`${name} is listed with no provenance`);
      expect(BED_LICENSES).toContain(p.license);
      // Music offered to an athlete is someone's work: "generated" is for the tone, never for this.
      expect(p.license).not.toBe("generated");
      expect(p.artist.trim()).not.toBe("");
      expect(p.sourceUrl).toMatch(/^https:\/\/[^\s]+$/);
      expect(p.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.retrievedOn))).toBe(false);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("knows how long every listed track runs, so the picker can bound where it starts", () => {
    for (const [name, bed] of beds.filter(([, b]) => b.listed)) {
      expect([name, (bed.durationSec ?? 0) > 30]).toEqual([name, true]);
    }
  });

  it("knows where every listed track's beats fall, so a stills edit can cut on them (PR 5 A2)", () => {
    for (const [name, bed] of beds.filter(([, b]) => b.listed)) {
      const g = bed.beat;
      if (!g) throw new Error(`${name} is listed with no beat grid`);
      // A lo-fi bed's tempo, and beat 0 inside its first period — the shape beatGrid.ts returns.
      expect([name, g.bpm >= 60 && g.bpm <= 140]).toEqual([name, true]);
      expect([
        name,
        g.firstBeatSec >= 0 && g.firstBeatSec < 60 / g.bpm,
      ]).toEqual([name, true]);
    }
  });

  it("serves each listed track's grid to the picker, beside its length", () => {
    // Every catalog entry is a bed or (PR 8) a licensed track — each checked against its own source.
    const tracks = MUSIC_TRACKS as Record<string, TrackDefinition>;
    for (const b of bedCatalog().beds) {
      const t = tracks[b.name];
      expect([b.name, b.beat]).toEqual([
        b.name,
        t
          ? t.firstBeatSec === null
            ? null
            : { bpm: t.bpm, firstBeatSec: t.firstBeatSec }
          : (STITCH_BEDS as Record<string, BedDefinition>)[b.name].beat,
      ]);
    }
  });

  it("would catch a listed bed with nothing written down — the gate is not vacuous", () => {
    // With nothing listed yet the loop above runs zero times, and a test that runs zero times
    // proves nothing. So the same rule is applied here to an entry built to break it.
    const undocumented: BedDefinition = {
      label: "x",
      gcsPath: "studio/beds/x.m4a",
      note: "x",
      listed: true,
      provenance: null,
      durationSec: null,
      beat: null,
    };
    const documented = (b: BedDefinition) => !b.listed || b.provenance !== null;
    expect(documented(undocumented)).toBe(false);
    expect(beds.every(([, b]) => documented(b))).toBe(true);
  });

  it("admits only CC0, public domain, and our own generated tone", () => {
    expect([...BED_LICENSES].sort()).toEqual(["CC0-1.0", "PD", "generated"]);
  });

  it("keeps every object under studio/beds/, as a name and never a URL", () => {
    for (const [, bed] of beds) {
      expect(bed.gcsPath).toMatch(/^studio\/beds\/[a-z0-9-]+\.m4a$/);
    }
  });
});

describe("the placeholder", () => {
  it("is still a valid NAME, so a row that holds it re-parses and runs", () => {
    expect(isBedName("placeholder")).toBe(true);
  });

  it("is not offered — a 220 Hz tone is not music", () => {
    expect(bedCatalog().beds.map((b) => b.name)).not.toContain("placeholder");
  });
});

describe("how loud", () => {
  it("is three names, and medium IS the engine's own default", () => {
    expect(Object.keys(BED_LEVELS)).toEqual(["low", "medium", "high"]);
    expect(DEFAULT_BED_LEVEL).toBe("medium");
    // The two numbers live in two files. If they drift, "absent means medium" becomes false for
    // every stored row at once, silently.
    expect(BED_LEVELS[DEFAULT_BED_LEVEL].gain).toBe(DEFAULT_BED.level);
  });

  it("orders them, and keeps every one UNDER the programme", () => {
    expect(BED_LEVELS.low.gain).toBeLessThan(BED_LEVELS.medium.gain);
    expect(BED_LEVELS.medium.gain).toBeLessThan(BED_LEVELS.high.gain);
    // The bed is mixed flat (ledger D4 — nothing ducks it), so its gain is the only thing keeping
    // it under a clip's own sound. Loud is still well under unity.
    expect(BED_LEVELS.high.gain).toBeLessThanOrEqual(0.5);
  });

  it("answers false for a number, a near-miss and an inherited key", () => {
    for (const bad of [0.25, "Medium", "max", "", null, "toString"]) {
      expect(isBedLevelName(bad)).toBe(false);
    }
  });

  it("offers the levels and the default to the picker", () => {
    const cat = bedCatalog();
    expect(cat.levels.map((l) => l.name)).toEqual(["low", "medium", "high"]);
    expect(cat.defaultLevel).toBe("medium");
    // Names and labels — the gains stay server-side, where they can be corrected.
    expect(JSON.stringify(cat.levels)).not.toMatch(/\d/);
  });
});

describe("the licensed tracks are music a stitch can name (PR 8)", () => {
  const trackIds = Object.keys(MUSIC_TRACKS);
  const READY = process.env.STUDIO_STITCH_BEDS_READY;
  afterEach(() => {
    if (READY === undefined) delete process.env.STUDIO_STITCH_BEDS_READY;
    else process.env.STUDIO_STITCH_BEDS_READY = READY;
  });

  it("shares no name with a bed — one namespace, so a stored name means one file", () => {
    expect(trackIds.filter((id) => id in STITCH_BEDS)).toEqual([]);
  });

  it("is a valid name, offered, and in the picker beside the beds", () => {
    const listed = listedBedNames();
    const inCatalog = bedCatalog().beds.map((b) => b.name);
    for (const id of trackIds) {
      expect([
        id,
        isBedName(id),
        listed.includes(id),
        inCatalog.includes(id),
      ]).toEqual([id, true, true, true]);
    }
  });

  it("is queued by name: a timeline under a track parses and survives the stored round trip", () => {
    for (const id of trackIds) {
      const parsed = parseStitchSpec(
        {
          clips: [
            { assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stillSec: 2 },
          ],
          target: "portrait",
          bed: id,
        },
        false,
      );
      const stored = isRefusal(parsed)
        ? parsed
        : readStoredSpec(JSON.parse(JSON.stringify(parsed)));
      expect([id, isRefusal(stored) ? stored.error : stored.bed]).toEqual([
        id,
        id,
      ]);
    }
  });

  it("resolves to its own object under studio/tracks/ — to fetch and to preview", () => {
    process.env.STUDIO_STITCH_BEDS_READY = "true";
    for (const id of trackIds) {
      const want = `studio/tracks/${id}.m4a`;
      expect([
        id,
        bedFor(id as keyof typeof MUSIC_TRACKS)?.gcsPath,
        bedPreviewPath(id),
      ]).toEqual([id, want, want]);
    }
  });

  it("waits on the same switch as the beds — nothing is fetched before it is on", () => {
    delete process.env.STUDIO_STITCH_BEDS_READY;
    expect(bedFor("save")).toBeNull();
    expect(bedPreviewPath("save")).toBeNull();
  });

  it("cuts a 6-photo edit on Save's 120 BPM grid, straight off the catalog the Board reads", () => {
    const save = bedCatalog().beds.find((b) => b.name === "save");
    expect(save?.beat).toEqual({ bpm: 120, firstBeatSec: 0.092 });
    const grid = save!.beat!;
    const fps = 30;
    // The bounds stitchLimits() serves the Board — spec.ts's own constants.
    const minStillSec = MIN_STILL_SEC;
    const maxStillSec = MAX_STILL_SEC;
    const photos: TimelineItem[] = Array.from({ length: 6 }, (_, i) => ({
      key: `row${i}:still`,
      assetId: `asset-${i}`,
      durationSec: null,
      durationPreciseSec: null,
      stillSec: 2,
    }));
    const placed = snapToBeat(photos, { grid, fps, minStillSec, maxStillSec });

    const P = 60 / grid.bpm;
    const offGrid = (t: number) => {
      const k = Math.round((t - grid.firstBeatSec) / P);
      return Math.abs(t - (grid.firstBeatSec + k * P));
    };
    let end = 0;
    for (const [i, p] of placed.entries()) {
      end = (p.startSec as number) + (p.item.stillSec as number);
      // Every photo ENDS on a beat: all five cuts and the last frame are on the grid.
      expect([i, offGrid(end) <= 0.5 / fps + 1e-9]).toEqual([i, true]);
      // A 2 s hold at 120 BPM is four beats.
      expect([i, p.beats]).toEqual([i, 4]);
    }
    // Rows 2–6 START on a beat. Row 1 starts at 0, 92 ms before Save's beat 0, because the Board
    // starts the track at 0 — carded: start it at firstBeatSec.
    expect(placed.map((p) => p.onBeat)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
