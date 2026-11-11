/**
 * tracks.test.ts — every catalogued track is the file we uploaded, measured, and licensed on paper.
 */
import manifest from "./tracks.manifest.json";
import {
  MUSIC_TRACKS,
  TRACK_LICENSES,
  TRACK_MOODS,
  isTrackId,
  type TrackDefinition,
} from "./tracks";

const tracks = Object.entries(MUSIC_TRACKS as Record<string, TrackDefinition>);
const byId = new Map(manifest.map((m) => [m.id, m]));

describe("a catalogued track is the file in the manifest", () => {
  it("has a manifest row, and every manifest row has a track", () => {
    expect(tracks.map(([id]) => id).sort()).toEqual(
      manifest.map((m) => m.id).sort(),
    );
  });

  it("carries the manifest's SHA-256 — named per track, so a re-cut file is caught by name", () => {
    for (const [id, t] of tracks) {
      expect([id, t.sha256]).toEqual([id, byId.get(id)?.sha256]);
    }
  });

  it("lives at studio/tracks/<its id>.m4a, the path the manifest recorded", () => {
    for (const [id, t] of tracks) {
      expect([id, t.gcsPath]).toEqual([id, `studio/tracks/${id}.m4a`]);
      expect([id, t.gcsPath]).toEqual([id, byId.get(id)?.gcsPath]);
    }
  });

  it("records hashes that are hashes", () => {
    for (const m of manifest) {
      expect([m.id, /^[0-9a-f]{64}$/.test(m.sha256)]).toEqual([m.id, true]);
      expect([m.id, /^[0-9a-f]{64}$/.test(m.sourceSha256)]).toEqual([
        m.id,
        true,
      ]);
      expect([m.id, /^[A-Za-z0-9+/]{22}==$/.test(m.md5Base64)]).toEqual([
        m.id,
        true,
      ]);
    }
  });
});

describe("a catalogued track is licensed on paper", () => {
  it("has a licence from the closed set and a date", () => {
    for (const [id, t] of tracks) {
      expect([
        id,
        (TRACK_LICENSES as readonly string[]).includes(t.license),
      ]).toEqual([id, true]);
      expect([id, /^\d{4}-\d{2}-\d{2}$/.test(t.retrievedOn)]).toEqual([
        id,
        true,
      ]);
      expect([id, t.author.trim() !== ""]).toEqual([id, true]);
    }
  });

  it("names a plan holder for a vendor licence, and a page for a public-domain one", () => {
    for (const [id, t] of tracks) {
      if (t.license === "artlist") {
        expect([id, (t.planHolder ?? "").trim() !== ""]).toEqual([id, true]);
      } else {
        expect([id, /^https:\/\/\S+$/.test(t.sourceUrl ?? "")]).toEqual([
          id,
          true,
        ]);
      }
    }
  });

  it("says whether it may go under brand work — a boolean, never absent", () => {
    for (const [id, t] of tracks) {
      expect([id, typeof t.brandSafe]).toEqual([id, "boolean"]);
    }
  });
});

describe("a catalogued track is measured", () => {
  it("runs at least 90 seconds", () => {
    for (const [id, t] of tracks) {
      expect([id, t.durationSec >= 90]).toEqual([id, true]);
    }
  });

  it("has a tempo the detector can report, and a first beat inside one period or null", () => {
    for (const [id, t] of tracks) {
      expect([id, t.bpm >= 60 && t.bpm <= 200]).toEqual([id, true]);
      const fb = t.firstBeatSec;
      expect([id, fb === null || (fb >= 0 && fb < 60 / t.bpm)]).toEqual([
        id,
        true,
      ]);
    }
  });

  it("has moods from the vocabulary, none repeated, and an energy of 1–5", () => {
    for (const [id, t] of tracks) {
      expect([id, t.moods.length > 0]).toEqual([id, true]);
      expect([id, new Set(t.moods).size]).toEqual([id, t.moods.length]);
      for (const m of t.moods) {
        expect([id, (TRACK_MOODS as readonly string[]).includes(m)]).toEqual([
          id,
          true,
        ]);
      }
      expect([
        id,
        Number.isInteger(t.energy) && t.energy >= 1 && t.energy <= 5,
      ]).toEqual([id, true]);
    }
  });
});

describe("the id", () => {
  it("answers false for a near-miss, a path and an inherited key", () => {
    for (const bad of [
      "Save",
      "studio/tracks/save.m4a",
      "",
      null,
      "toString",
    ]) {
      expect(isTrackId(bad)).toBe(false);
    }
    expect(isTrackId("save")).toBe(true);
  });
});
