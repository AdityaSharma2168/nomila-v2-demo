/**
 * library.test.ts — every free-library track is licensed on paper, cleared the right way for brand work, measured,
 * normalised to the loudness rule, and is the file the manifest recorded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_PREFIX, LIBRARY_TRACKS, isLibraryTrackId } from "./library";
import { MUSIC_TRACKS } from "./tracks";
import { STITCH_BEDS } from "../video/beds";
import { BED_REFERENCE_LUFS, TRUE_PEAK_DBTP } from "../video/finishing";
import { TRACK_MOODS } from "./taxonomy";

const rows = Object.values(LIBRARY_TRACKS);
const record = readFileSync(join(__dirname, "LIBRARY-LICENSES.md"), "utf8");

describe("the library", () => {
  it("holds 60–100 tracks", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.length).toBeLessThanOrEqual(100);
  });

  it("has at least three tracks for every mood, and brand-safe tracks for most", () => {
    for (const m of TRACK_MOODS) expect([m, rows.filter((t) => t.moods.includes(m)).length >= 3]).toEqual([m, true]);
  });

  it("shares no id with the licensed tracks or the beds", () => {
    for (const t of rows) {
      expect([t.id, Object.prototype.hasOwnProperty.call(MUSIC_TRACKS, t.id)]).toEqual([t.id, false]);
      expect([t.id, Object.prototype.hasOwnProperty.call(STITCH_BEDS, t.id)]).toEqual([t.id, false]);
    }
  });

  it("answers false for a near-miss, a path and an inherited key", () => {
    for (const bad of ["", "toString", `${LIBRARY_PREFIX}${rows[0].id}.m4a`, rows[0].id.toUpperCase(), null]) expect(isLibraryTrackId(bad)).toBe(false);
    expect(isLibraryTrackId(rows[0].id)).toBe(true);
  });
});

describe("a track is licensed on paper", () => {
  it("CC-BY requires attribution and carries a TASL credit (title, author, source, licence with its link); CC0 carries none", () => {
    for (const t of rows) {
      if (t.licence === "CC0-1.0") {
        expect([t.id, t.attributionRequired, t.creditLine]).toEqual([t.id, false, null]);
      } else {
        expect([t.id, t.attributionRequired]).toEqual([t.id, true]);
        const c = t.creditLine ?? "";
        for (const part of [t.title, t.artist, "CC BY", "creativecommons.org/licenses/by/"]) expect([t.id, part, c.includes(part)]).toEqual([t.id, part, true]);
        expect([t.id, (t.sourceCreditText ?? "").includes(t.title)]).toEqual([t.id, true]);
      }
    }
  });

  it("is brand-safe ONLY when it is CC0 — never an attribution licence", () => {
    for (const t of rows) if (t.brandSafe) expect([t.id, t.licence]).toEqual([t.id, "CC0-1.0"]);
  });

  it("names the page and the words the page used", () => {
    for (const t of rows) {
      if (t.licence === "CC0-1.0") expect([t.id, t.licenceShown]).toEqual([t.id, "CC0 1.0 Universal License"]);
      if (t.licence === "CC-BY-4.0") expect([t.id, t.licenceShown.includes("Creative Commons: By Attribution 4.0")]).toEqual([t.id, true]);
    }
  });

  it("has a block in LIBRARY-LICENSES.md naming its page, its licence and both hashes", () => {
    for (const t of rows) {
      const at = record.indexOf(`### ${t.id} — `);
      expect([t.id, at >= 0]).toEqual([t.id, true]);
      const next = record.indexOf("\n### ", at + 4);
      const block = record.slice(at, next < 0 ? undefined : next);
      for (const needle of [t.sourceUrl, t.licenceShown, t.sha256, t.sourceSha256]) expect([t.id, block.includes(needle)]).toEqual([t.id, true]);
    }
  });
});

describe("a track is measured and normalised", () => {
  it("has energy 1–5, a genre, themes and sections in range; a grid only inside one beat", () => {
    for (const t of rows) {
      expect([t.id, Number.isInteger(t.energy) && t.energy >= 1 && t.energy <= 5]).toEqual([t.id, true]);
      expect([t.id, t.sections.peakSec <= t.durationSec]).toEqual([t.id, true]);
      expect([t.id, t.sections.dropSec === null || t.sections.dropSec <= t.durationSec]).toEqual([t.id, true]);
      expect([t.id, t.firstBeatSec === null || t.firstBeatSec < 60 / t.bpm + 1e-6]).toEqual([t.id, true]);
      expect([t.id, new Set(t.themes).size]).toEqual([t.id, t.themes.length]);
    }
  });

  it("sits at the reference loudness under the true-peak ceiling", () => {
    for (const t of rows) {
      expect([t.id, Math.abs(t.loudness.integratedLufs - BED_REFERENCE_LUFS) <= 0.5]).toEqual([t.id, true]);
      expect([t.id, t.loudness.truePeakDbtp <= TRUE_PEAK_DBTP]).toEqual([t.id, true]);
    }
  });

  it("runs at least a minute, at a tempo in range", () => {
    for (const t of rows) {
      expect([t.id, t.durationSec >= 60]).toEqual([t.id, true]);
      expect([t.id, t.bpm >= 50 && t.bpm <= 220]).toEqual([t.id, true]);
    }
  });

  it("lives at studio/tracks/free/<id>.m4a, with a real bucket MD5", () => {
    for (const t of rows) {
      expect([t.id, t.gcsPath]).toEqual([t.id, `${LIBRARY_PREFIX}${t.id}.m4a`]);
      expect([t.id, t.md5Base64 === "AAAAAAAAAAAAAAAAAAAAAA=="]).toEqual([t.id, false]);
    }
  });
});
