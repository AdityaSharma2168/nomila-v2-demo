/**
 * visionTag.test.ts — pure unit tests for heroScore's zeroing rules.
 *
 * The product rule (from the founder): a good shot doesn't stop being a good shot because a rival
 * brand's logo is in frame — brand safety is applied as a LENS at the moment of use (mediaSearch's
 * excludeBrands/preferBrandSafe), never as a blanket zero on the library-wide score. So heroScore
 * must zero on !athlete_present, but must NOT zero on !brand_safe.
 */
import {
  applyFaceRole, faceOf, roleOf, heroScore, hasHardSafetyFlag, FACE_ROLE_LINE, type AssetTags,
} from "./visionTag";

function tags(overrides: Partial<AssetTags> = {}): AssetTags {
  return {
    athlete_present: true, athlete_prominence: 0.8, shot_type: "action",
    description: "d", brands_visible: [], aesthetic_quality: 0.8, brand_safe: true,
    setting: "s", attire: "a", vibe: "v", hero_suitability: 0.8,
    disposition: "as_is", edit_note: "", reason: "r",
    ...overrides,
  };
}

describe("heroScore", () => {
  it("scores a normal, brand-safe shot as before", () => {
    const t = tags();
    expect(heroScore(t)).toBeCloseTo(0.45 * 0.8 + 0.30 * 0.8 + 0.25 * 0.8, 6);
  });

  it("no longer zeroes when brand_safe is false — a good shot stays a good shot", () => {
    const safe = tags({ brand_safe: true });
    const unsafe = tags({ brand_safe: false });
    expect(heroScore(unsafe)).toBeGreaterThan(0);
    expect(heroScore(unsafe)).toBeCloseTo(heroScore(safe), 6);
  });

  it("still zeroes when the athlete isn't present", () => {
    expect(heroScore(tags({ athlete_present: false }))).toBe(0);
    expect(heroScore(tags({ athlete_present: false, brand_safe: false }))).toBe(0);
  });

  it("still gives text_graphic the flat 0.05 regardless of brand_safe", () => {
    expect(heroScore(tags({ shot_type: "text_graphic" }))).toBe(0.05);
    expect(heroScore(tags({ shot_type: "text_graphic", brand_safe: false }))).toBe(0.05);
  });
});

describe("hard safety flags — the one case where zeroing stays", () => {
  it("hasHardSafetyFlag is true only for hateful / sexual / self_harm", () => {
    expect(hasHardSafetyFlag({ content_flags: { hateful: true } })).toBe(true);
    expect(hasHardSafetyFlag({ content_flags: { sexual: true } })).toBe(true);
    expect(hasHardSafetyFlag({ content_flags: { self_harm: true } })).toBe(true);
    // Recorded-only flags don't trip the hard override.
    expect(hasHardSafetyFlag({ content_flags: { violence_or_weapons: true } })).toBe(false);
    expect(hasHardSafetyFlag({ content_flags: { drugs_or_alcohol: true } })).toBe(false);
    expect(hasHardSafetyFlag({ content_flags: { obscene_gesture: true } })).toBe(false);
    expect(hasHardSafetyFlag({})).toBe(false);
    expect(hasHardSafetyFlag({ content_flags: undefined })).toBe(false);
  });

  it("heroScore zeroes outright when a hard safety flag is set, even if the asset otherwise scores well", () => {
    const flagged = tags({ content_flags: { hateful: true }, athlete_present: true, hero_suitability: 1, aesthetic_quality: 1, athlete_prominence: 1 });
    expect(heroScore(flagged)).toBe(0);
  });

  it("a merely not-brand-safe (rival logo) shot with no hard flag still scores normally", () => {
    const t = tags({ brand_safe: false, content_flags: { violence_or_weapons: false } });
    expect(heroScore(t)).toBeGreaterThan(0);
  });
});

/**
 * ─── THE ATHLETE, NAMED (22 Sep 2026) ─────────────────────────────────────────────────────────
 * ⚠️ MUTATION, red here by name: make `applySubject` set `athlete_present = true` whenever a
 * subject is present (collapse the ternary) — "another_person → false" and "nobody → false" red.
 */
import { applySubject, profileBlock, promptFor } from "./visionTag";

describe("applySubject — the ternary decides athlete_present", () => {
  it.each([
    ["the_athlete", true],
    ["another_person", false],
    ["nobody", false],
  ])("%s → athlete_present %s, and the ternary is kept beside it", (subject, present) => {
    const out = applySubject({ subject, athlete_present: !present, description: "x" });
    expect(out.athlete_present).toBe(present);
    expect(out.subject).toBe(subject);
  });

  it("without a valid subject the boolean the model gave stands, coerced, and no subject key is stored", () => {
    expect(applySubject({ athlete_present: true })).toEqual({ athlete_present: true });
    expect(applySubject({ athlete_present: "yes" as unknown as boolean })).toEqual({ athlete_present: false });
    expect(applySubject({ athlete_present: true, subject: "her" })).toEqual({ athlete_present: true });
  });
});

describe("promptFor — the two lines that name her", () => {
  it("names her, her sport and her team, calls everyone else ANOTHER PERSON, and asks for the ternary — and never her name back", () => {
    const p = promptFor({ name: "Test Athlete", sport: "Soccer", team: "Test University" });
    // Her SPORT is not in the line: with it, a photo of her in another sport's kit read as another person (22 Sep 2026).
    expect(p).toContain("THE ATHLETE is Test Athlete, an athlete, at Test University.");
    expect(p).not.toContain("Soccer athlete");
    expect(p).toContain("is ANOTHER PERSON");
    expect(p).toContain('"subject":"the_athlete|another_person|nobody"');
    expect(p).toContain("Never write their name");
    expect(p).not.toContain('"athlete_present":true|false');
  });

  it("without a profile the block is empty and the prompt still asks the ternary", () => {
    expect(profileBlock(null)).toBe("");
    expect(promptFor(null)).not.toContain("THE ATHLETE is");
    expect(promptFor(null)).toContain('"subject":');
    expect(profileBlock({ name: "N", sport: null, team: null })).toContain("THE ATHLETE is N, an athlete.");
  });
});

describe("face_visibility + role — PR 12's two questions (docs/probes/library-fields.md)", () => {
  /** ⚠️ MUTATION "the tagger's prompt stops asking for face_visibility": drop the two keys from the JSON shape, or the definitions — reds. */
  it("asks both, defines both in the prompt's own words, and offers exactly the enums the readers know", () => {
    const p = promptFor({ name: "N", sport: null, team: null });
    expect(p).toContain('"face_visibility":"none|partial|clear"');
    expect(p).toContain('"role":"identity|product|scene|other"');
    expect(p).toContain(FACE_ROLE_LINE);
    // No `style`: a look was a reference tag once and was removed (ReferencePicker.tsx).
    expect(p).not.toMatch(/"role":"[^"]*style/);
  });

  /** ⚠️ MUTATION "an unknown face_visibility value is stored as given": applyFaceRole returns its input — reds. */
  it("keeps an answer inside the enum and DROPS one outside it, so a stored row never carries a word no reader knows", () => {
    expect(applyFaceRole(tags({ face_visibility: "clear", role: "identity" }))).toMatchObject({ face_visibility: "clear", role: "identity" });
    const odd = applyFaceRole({ ...tags(), face_visibility: "excellent", role: "style" } as unknown as AssetTags);
    expect(odd).not.toHaveProperty("face_visibility");
    expect(odd).not.toHaveProperty("role");
    expect(odd.hero_suitability).toBe(0.8); // nothing else touched
  });

  /** ⚠️ MUTATION "an old row without face_visibility is refused": faceOf returns null when the key is absent — the three fallback rows red. */
  it("faceOf: the key when present; else hers → partial, anyone else or nobody → none; unread → null (R-3)", () => {
    expect(faceOf({ face_visibility: "none", subject: "the_athlete" })).toBe("none");
    expect(faceOf({ subject: "the_athlete" })).toBe("partial");
    expect(faceOf({ athlete_present: true })).toBe("partial"); // pre-ternary row
    expect(faceOf({ subject: "another_person" })).toBe("none");
    expect(faceOf({ subject: "nobody" })).toBe("none");
    expect(faceOf({ athlete_present: false })).toBe("none");
    expect(faceOf({ face_visibility: "excellent", subject: "the_athlete" })).toBe("partial"); // unknown word → fallback
    expect(faceOf(null)).toBeNull();
    expect(faceOf(undefined)).toBeNull();
  });

  it("roleOf: the key when present; else hers → identity, nobody → scene, anyone else → other; unread → null", () => {
    expect(roleOf({ role: "product", subject: "nobody" })).toBe("product");
    expect(roleOf({ subject: "the_athlete" })).toBe("identity");
    expect(roleOf({ athlete_present: true })).toBe("identity");
    expect(roleOf({ subject: "nobody" })).toBe("scene");
    expect(roleOf({ subject: "another_person" })).toBe("other");
    expect(roleOf(null)).toBeNull();
  });
});

import { isTheAthlete } from "./visionTag";

describe("isTheAthlete — only the profile-aware tagger's answer casts a photo as her", () => {
  it("subject the_athlete is her", () => {
    expect(isTheAthlete({ subject: "the_athlete" })).toBe(true);
  });
  it("another_person and nobody are not her", () => {
    expect(isTheAthlete({ subject: "another_person" })).toBe(false);
    expect(isTheAthlete({ subject: "nobody" })).toBe(false);
  });
  it("a legacy athlete_present row is not her (unsure until re-tagged)", () => {
    expect(isTheAthlete({ athlete_present: true } as { subject?: unknown })).toBe(false);
  });
  it("an untagged row is not her", () => {
    expect(isTheAthlete(null)).toBe(false);
    expect(isTheAthlete(undefined)).toBe(false);
  });
});

import { isProofOfHer } from "./visionTag";

describe("isProofOfHer — one predicate for every proof surface", () => {
  const her = { subject: "the_athlete", shot_type: "action", description: "The athlete dribbles past two defenders." };
  it("her own clean shot is proof", () => {
    expect(isProofOfHer(her)).toBe(true);
  });
  it("a group or text-overlay post is not proof of her", () => {
    expect(isProofOfHer({ ...her, shot_type: "text_graphic" })).toBe(false);
    expect(isProofOfHer({ ...her, shot_type: "lifestyle", beats: [{ shot_type: "group", description: "The team celebrates." }] })).toBe(false);
    expect(isProofOfHer({ ...her, description: "Athlete on the field, with a meme text overlay." })).toBe(false);
    expect(isProofOfHer({ ...her, edit_note: "Remove text overlay 'My Eras'" })).toBe(false);
    expect(isProofOfHer({ ...her, role: "other" })).toBe(false);
  });
  it("someone else, or an untagged post, is never proof of her", () => {
    expect(isProofOfHer({ ...her, subject: "other_person" })).toBe(false);
    expect(isProofOfHer(null)).toBe(false);
  });
});

import { applyFrameKeys, burnedTextOf } from "./visionTag";

describe("frame keys — where her face is, and text burned into the picture (21 Oct 2026)", () => {
  it("keeps a face box inside the frame and an explicit null", () => {
    expect(applyFrameKeys({ face_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.25 } }).face_box).toEqual({ x: 0.4, y: 0.1, w: 0.2, h: 0.25 });
    expect(applyFrameKeys({ face_box: null }).face_box).toBeNull();
  });
  it("a face box outside the frame is dropped", () => {
    expect("face_box" in applyFrameKeys({ face_box: { x: 0.9, y: 0.1, w: 0.5, h: 0.2 } })).toBe(false);
    expect("face_box" in applyFrameKeys({ face_box: { x: "a", y: 0, w: 0.1, h: 0.1 } })).toBe(false);
  });
  it("clamps text share and zeroes it when absent; drops a malformed answer", () => {
    expect(applyFrameKeys({ text_in_image: { present: true, share: 3 } }).text_in_image).toEqual({ present: true, share: 1 });
    expect(applyFrameKeys({ text_in_image: { present: false, share: 0.4 } }).text_in_image).toEqual({ present: false, share: 0 });
    expect("text_in_image" in applyFrameKeys({ text_in_image: { present: "yes" } })).toBe(false);
  });
  it("burnedTextOf reads the tagger's answer, ignores a speck, and is null for an older row", () => {
    expect(burnedTextOf({ text_in_image: { present: true, share: 0.2 } })).toBe(true);
    expect(burnedTextOf({ text_in_image: { present: true, share: 0.002 } })).toBe(false);
    expect(burnedTextOf({ text_in_image: { present: false, share: 0 } })).toBe(false);
    expect(burnedTextOf({ description: "her on the pitch" })).toBeNull();
  });
  it("isProofOfHer trusts text_in_image over the description when the row has it", () => {
    const base = { subject: "the_athlete", shot_type: "action", role: "identity" };
    expect(isProofOfHer({ ...base, description: "game action", text_in_image: { present: true, share: 0.15 } })).toBe(false);
    expect(isProofOfHer({ ...base, description: "a meme of the match", text_in_image: { present: false, share: 0 } })).toBe(true);
  });
  it("the prompt asks both questions, and scene text is not burned-in text", () => {
    const p = promptFor(null);
    expect(p).toContain("face_box");
    expect(p).toContain("text_in_image");
    expect(p).toMatch(/NOT text that is part of the scene/);
  });
});
