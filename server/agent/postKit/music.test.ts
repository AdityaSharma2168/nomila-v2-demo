/**
 * music.test.ts — a post kit's three suggested tracks (agent/postKit/music.ts): off by default, brand-safe on brand
 * posts, a switch only among the kit's own choices, and a CC-BY credit that follows the selected track in the caption.
 */
import type { PostKit } from "../../../shared/postKit";
import { MUSIC_CATALOGUE } from "../../studio/music/find";
import { TRACK_MOODS } from "../../studio/music/taxonomy";
import { POST_KIT } from "./config";
import {
  agentPostKitMusicChoicesEnabled, chooseMusic, creditLine, defaultSelection, MusicChoiceError, musicChoicesFor, reconcileMusic,
  selectedCredit, selectedTrackFor, withCredit, withMusic,
} from "./music";
import { isLibraryTrackId } from "../../studio/music/library";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const ON = () => { process.env.AGENT_POST_KIT_MUSIC_CHOICES = "true"; process.env.STUDIO_MUSIC_LIBRARY_READY = "true"; };
afterEach(() => { delete process.env.AGENT_POST_KIT_MUSIC_CHOICES; delete process.env.STUDIO_MUSIC_LIBRARY_READY; delete process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS; });
/** The credit machinery is exercised with MUSIC_ALLOW_ATTRIBUTION_TRACKS on; M2 (off, the default) is guarded below. */
const ATTRIBUTION_ON = () => { process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS = "true"; };

const kit = (over: Partial<PostKit> = {}): PostKit => ({
  contract: "post-kit/1", momentDecisionId: null,
  idea: { hook: "h", format: "reel", platform: "instagram", timing: "t" }, formatFromMoment: false,
  brief: { show: "s", captionAngle: "a", avoid: "" }, assets: [], shortlist: [],
  caption: { text: "The work nobody sees.", hashtags: [], edited: false },
  treatmentPlan: { aspect: "9:16", cropToFill: true, order: [], trims: [], stills: [], overlayText: null, lookPreset: "natural", musicMood: "hype", coverFrame: null, totalSec: 12 },
  aiGenerationNeeded: { value: false, reason: "r" },
  match: { runId: null, skillVersion: null, candidates: 0, costMicroUsd: 0, noneFitNote: null },
  builtAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
});

describe("the flag", () => {
  it("is off unless exactly \"true\": no choices, and the kit is untouched", () => {
    expect(agentPostKitMusicChoicesEnabled()).toBe(false);
    expect(musicChoicesFor({ mood: "hype", format: "reel", forBrand: false, totalSec: 12 })).toBeNull();
    const k = kit();
    expect(withMusic(k, null)).toBe(k);
    process.env.AGENT_POST_KIT_MUSIC_CHOICES = "1";
    expect(agentPostKitMusicChoicesEnabled()).toBe(false);
  });
});

describe("the choices", () => {
  beforeEach(ON);

  it("three for every mood on a reel or story, the first selected", () => {
    for (const mood of TRACK_MOODS) for (const format of ["reel", "story"] as const) {
      const m = musicChoicesFor({ mood, format, forBrand: false, totalSec: 15 });
      expect([mood, m?.choices.length]).toEqual([mood, 3]);
      expect(m?.selected).toBe(m?.choices[0].trackId);
    }
  });

  it("none for no mood, \"none\", an unknown word, a feed post or a carousel", () => {
    for (const mood of [null, "none", "epic-ish"]) expect(musicChoicesFor({ mood, format: "reel", forBrand: false, totalSec: 10 })).toBeNull();
    for (const format of ["feed", "carousel"] as const) expect(musicChoicesFor({ mood: "hype", format, forBrand: false, totalSec: null })).toBeNull();
  });

  it("THE GUARD: a brand post's choices are all brand-safe, for every mood", () => {
    for (const mood of TRACK_MOODS) {
      const m = musicChoicesFor({ mood, format: "reel", forBrand: true, totalSec: 20 });
      for (const c of m?.choices ?? []) expect([mood, c.trackId, MUSIC_CATALOGUE[c.trackId].brandSafe]).toEqual([mood, c.trackId, true]);
    }
  });

  it("a selected CC-BY track's credit goes into the caption at build; a CC0 one adds nothing", () => {
    const owes = Object.values(MUSIC_CATALOGUE).find((t) => t.credit)!;
    const cc0 = Object.values(MUSIC_CATALOGUE).find((t) => t.licence === "CC0-1.0")!;
    const c = (t: typeof owes) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit });
    const m = { choices: [c(owes), c(cc0)], selected: owes.id };
    expect(withMusic(kit(), m).caption.text).toBe(`The work nobody sees.

${creditLine(owes.credit!)}`);
    expect(withMusic(kit(), { ...m, selected: cc0.id }).caption.text).toBe("The work nobody sees.");
  });

  it("built choices carry each track's own credit (or none)", () => {
    for (const mood of TRACK_MOODS) {
      for (const ch of musicChoicesFor({ mood, format: "reel", forBrand: false, totalSec: 12 })?.choices ?? []) {
        expect([ch.trackId, ch.credit]).toEqual([ch.trackId, MUSIC_CATALOGUE[ch.trackId].credit]);
      }
    }
  });
});

describe("switching", () => {
  beforeEach(ATTRIBUTION_ON);
  const free = Object.values(MUSIC_CATALOGUE).find((t) => !t.brandSafe && t.credit)!;
  const safe = Object.values(MUSIC_CATALOGUE).find((t) => t.brandSafe && !t.credit)!;
  const c = (t: typeof free) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort, contentIdRegistered: t.contentIdRegistered });
  const k = () => withMusic(kit(), { choices: [c(free), c(safe)], selected: free.id });

  it("moves to another of the kit's choices; the credit line follows the track", () => {
    const before = k();
    expect(before.caption.text).toContain(creditLine(free.credit!));
    const after = chooseMusic(before, safe.id, false, NOW);
    expect(after.music?.selected).toBe(safe.id);
    expect(after.caption.text).toBe("The work nobody sees.");
    expect(after.updatedAt).toBe(NOW.toISOString());
    const back = chooseMusic(after, free.id, false, NOW);
    expect(back.caption.text).toBe(before.caption.text);
    expect(chooseMusic(before, null, false, NOW).caption.text).toBe("The work nobody sees.");
  });

  it("keeps her own words around the credit when she edited the caption", () => {
    const edited = { ...k(), caption: { text: `Mine first.\n\n${creditLine(free.credit!)}\n\n#mine`, hashtags: ["#mine"], edited: true } };
    expect(chooseMusic(edited, safe.id, false, NOW).caption.text).toBe("Mine first.\n\n#mine");
  });

  it("refuses a track that is not one of the choices, and a kit with no choices", () => {
    expect(() => chooseMusic(k(), "status", false, NOW)).toThrow(MusicChoiceError);
    expect(() => chooseMusic(kit(), safe.id, false, NOW)).toThrow("no suggested music");
  });

  it("THE GUARD: refuses a non-brand-safe track on a brand post, and the render never uses one", () => {
    try { chooseMusic(k(), free.id, true, NOW); throw new Error("not refused"); } catch (e) { expect((e as MusicChoiceError).code).toBe("not_brand_safe"); }
    expect(selectedTrackFor(k(), true)).toBeUndefined();
    expect(selectedTrackFor(k(), false)).toBe(free.id);
    expect(selectedTrackFor({ ...k(), music: { ...k().music!, selected: null } }, true)).toBeNull();
    expect(selectedTrackFor(kit(), false)).toBeUndefined();
  });
});

describe("the credit line", () => {
  beforeEach(ATTRIBUTION_ON);
  const forms = { full: "\"T\" by A (site), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)", short: "\"T\" by A, CC BY 4.0" };
  const ok = (r: ReturnType<typeof withCredit>) => { if (!r.ok) throw new Error("no room"); return r.text; };

  it("goes in whole when it fits", () => {
    expect(ok(withCredit("hi", null, forms))).toBe(`hi

${creditLine(forms.full)}`);
  });

  it("near the limit: NEVER cuts her words — the short form when it fits, else a refusal", () => {
    const room = POST_KIT.CAPTION_CHARS - creditLine(forms.short).length - 2;
    const near = "x".repeat(room);
    const out = ok(withCredit(near, null, forms));
    expect(out.startsWith(near)).toBe(true);
    expect(out.endsWith(creditLine(forms.short))).toBe(true);
    expect(out.length).toBeLessThanOrEqual(POST_KIT.CAPTION_CHARS);
    expect(withCredit("x".repeat(room + 1), null, forms)).toEqual({ ok: false });
    // No short form: the full one or nothing.
    expect(withCredit(near, null, { full: forms.full, short: null })).toEqual({ ok: false });
  });

  it("is not added twice, and either form comes out when the track goes", () => {
    const once = ok(withCredit("hi", null, forms));
    expect(ok(withCredit(once, null, forms))).toBe(once);
    expect(ok(withCredit(`hi

${creditLine(forms.short)}`, forms, null))).toBe("hi");
    expect(ok(withCredit(once, forms, null))).toBe("hi");
  });

  it("a switch with no room for the new credit is refused, her caption untouched", () => {
    const free = Object.values(MUSIC_CATALOGUE).find((t) => t.credit)!;
    const safe = Object.values(MUSIC_CATALOGUE).find((t) => !t.credit)!;
    const c = (t: typeof free) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort });
    const full = kit({ caption: { text: "y".repeat(POST_KIT.CAPTION_CHARS), hashtags: [], edited: true }, music: { choices: [c(safe), c(free)], selected: safe.id } });
    try { chooseMusic(full, free.id, false, NOW); throw new Error("not refused"); } catch (e) { expect((e as MusicChoiceError).code).toBe("no_room_for_credit"); }
    // At build, a drafted caption with no room starts on a choice that owes nothing.
    expect(withMusic(kit({ caption: full.caption }), { choices: [c(free), c(safe)], selected: free.id }).music?.selected).toBe(safe.id);
  });
});

describe("Content ID: the default avoids a claim", () => {
  const reg = (id: string, contentIdRegistered: boolean | null) => ({ trackId: id, title: id, artist: "a", reason: "r", licence: "CC0-1.0", credit: null, contentIdRegistered });
  it("selects the first choice that is not Content ID registered; the first when all are", () => {
    const ids = Object.keys(MUSIC_CATALOGUE).slice(0, 3);
    expect(defaultSelection([reg(ids[0], true), reg(ids[1], null), reg(ids[2], false)], false)).toBe(ids[1]);
    expect(defaultSelection([reg(ids[0], true), reg(ids[1], true)], false)).toBe(ids[0]);
    expect(defaultSelection([], false)).toBeNull();
  });

  it("built kits default to a non-registered track whenever one is among the choices", () => {
    ON();
    for (const mood of TRACK_MOODS) {
      const m = musicChoicesFor({ mood, format: "reel", forBrand: false, totalSec: 12 })!;
      const free = m.choices.find((c) => c.contentIdRegistered !== true);
      if (free) expect([mood, m.selected]).toEqual([mood, free.trackId]);
      for (const ch of m.choices) expect(ch.contentIdRegistered).toBe(MUSIC_CATALOGUE[ch.trackId].contentIdRegistered);
    }
  });
});

describe("the readiness gate", () => {
  it("without STUDIO_MUSIC_LIBRARY_READY no library track is suggested", () => {
    process.env.AGENT_POST_KIT_MUSIC_CHOICES = "true";
    for (const mood of TRACK_MOODS) {
      for (const ch of musicChoicesFor({ mood, format: "reel", forBrand: false, totalSec: 12 })?.choices ?? []) expect([ch.trackId, isLibraryTrackId(ch.trackId)]).toEqual([ch.trackId, false]);
    }
  });
});

describe("a stale kit: the post became brand work after the build", () => {
  beforeEach(ATTRIBUTION_ON);
  const owes = Object.values(MUSIC_CATALOGUE).find((t) => !t.brandSafe && t.credit)!;
  const safe = Object.values(MUSIC_CATALOGUE).find((t) => t.brandSafe && !t.credit)!;
  const c = (t: typeof owes) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort });
  const built = () => withMusic(kit(), { choices: [c(owes), c(safe)], selected: owes.id });

  it("the non-brand-safe pick gives way to an allowed one, and its credit leaves the caption", () => {
    const b = built();
    expect(b.caption.text).toContain(creditLine(owes.credit!));
    const r = reconcileMusic(b, true);
    expect(r.music?.selected).toBe(safe.id);
    expect(r.caption.text).toBe("The work nobody sees.");
    expect(selectedCredit(r)).toBeNull();
  });

  it("no allowed choice: none, credit gone; still personal, or already fine: the same object back", () => {
    const only = withMusic(kit(), { choices: [c(owes)], selected: owes.id });
    const r = reconcileMusic(only, true);
    expect([r.music?.selected, r.caption.text]).toEqual([null, "The work nobody sees."]);
    const b = built();
    expect(reconcileMusic(b, false)).toBe(b);
    expect(reconcileMusic(kit(), true)).toEqual(kit());
  });
});

describe("M2: while MUSIC_ALLOW_ATTRIBUTION_TRACKS is off (the default), nothing that needs a credit is offered", () => {
  it("THE GUARD: no kit choice owes a credit, for every mood, personal or brand", () => {
    ON();
    for (const mood of TRACK_MOODS) for (const forBrand of [false, true]) {
      for (const ch of musicChoicesFor({ mood, format: "reel", forBrand, totalSec: 12 })?.choices ?? []) {
        expect([mood, ch.trackId, ch.credit, MUSIC_CATALOGUE[ch.trackId].credit]).toEqual([mood, ch.trackId, null, null]);
      }
    }
  });

  it("every mood still gets three personal choices", () => {
    ON();
    for (const mood of TRACK_MOODS) expect([mood, musicChoicesFor({ mood, format: "reel", forBrand: false, totalSec: 12 })?.choices.length]).toEqual([mood, 3]);
  });

  it("a stored credit-owing pick is moved off and its credit leaves the caption; the render never uses it", () => {
    const owes = Object.values(MUSIC_CATALOGUE).find((t) => t.credit)!;
    const free = Object.values(MUSIC_CATALOGUE).find((t) => !t.credit)!;
    const c = (t: typeof owes) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort });
    const stored = kit({ caption: { text: `Words.

${creditLine(owes.credit!)}`, hashtags: [], edited: false }, music: { choices: [c(owes), c(free)], selected: owes.id } });
    expect(selectedTrackFor(stored, false)).toBeUndefined();
    const r = reconcileMusic(stored, false);
    expect([r.music?.selected, r.caption.text]).toEqual([free.id, "Words."]);
    try { chooseMusic(r, owes.id, false, NOW); throw new Error("not refused"); } catch (e) { expect((e as MusicChoiceError).code).toBe("not_offered"); }
  });
});
