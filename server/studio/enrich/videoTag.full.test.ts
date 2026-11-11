/**
 * videoTag.full.test.ts — the FULL clip read (MEDIA_VIDEO_FIXES, media-intake plan fix 2): the same call also writes
 * what is said and how steady each beat is. Held here:
 *
 *   1. OFF IS BYTE-IDENTICAL. Without `full` the prompt is exactly the one the tagger has always sent.
 *   2. The full prompt asks for speech and steadiness, and the answer shape names the keys it asks for.
 *   3. The parse keeps only what was offered: a closed stability list, transcript segments clamped and ordered, a
 *      runaway transcript cut, and an answer with no `speech` key carrying none (every non-full read).
 *
 * ⚠️ MUTATIONS: always append FULL_READ_BLOCK — "off: byte-identical" reds; keep an unknown stability — "a stability
 * not on the list is dropped" reds.
 */
import {
  BEAT_STABILITIES, FULL_READ_BLOCK, MAX_SPEECH_SEGMENTS, parseSpeech, parseVideoTags, tagVideo, videoPromptFor,
  type VideoTagTransport,
} from "./videoTag";

const PROFILE = { name: "Test Athlete", sport: null, team: null };

const beat = (start: number, end: number, extra: Record<string, unknown> = {}) => ({
  start_s: start, end_s: end, description: "b", shot_type: "action", athlete_present: true, athlete_prominence: 0.8,
  setting: "s", attire: "a", vibe: "v", brands_visible: [], aesthetic_quality: 0.7, camera: "c", motion: "m",
  hero_suitability: 0.7, ...extra,
});
const answer = (extra: Record<string, unknown> = {}) => JSON.stringify({
  subject: "the_athlete", athlete_prominence: 0.9, shot_type: "action", description: "a clip", brands_visible: [],
  aesthetic_quality: 0.8, brand_safe: true, content_flags: {}, setting: "s", attire: "a", vibe: "v",
  hero_suitability: 0.8, disposition: "as_is", edit_note: "", reason: "r",
  beats: [beat(0, 2, { stability: "handheld" }), beat(2, 5, { stability: "wobbly" })],
  ...extra,
});

describe("the prompt", () => {
  it("off: byte-identical to the prompt without the option", () => {
    expect(videoPromptFor(PROFILE, { full: false })).toBe(videoPromptFor(PROFILE));
    expect(videoPromptFor(null, {})).toBe(videoPromptFor(null));
    expect(videoPromptFor(PROFILE)).not.toContain("SPEECH");
    expect(videoPromptFor(PROFILE)).not.toContain("stability");
  });

  it("full: asks for speech and steadiness, and the answer shape names both", () => {
    const p = videoPromptFor(PROFILE, { full: true });
    expect(p).toContain(FULL_READ_BLOCK.trim());
    expect(p).toContain('"stability":"steady|handheld|shaky"');
    expect(p).toContain('"speech":{"has_speech":true|false');
    // Still the one tagger: the clip block and the athlete line are untouched.
    expect(p.startsWith(videoPromptFor(PROFILE).split("Respond with STRICT JSON")[0].trimEnd())).toBe(true);
  });

  it("names no athlete, sport, school or brand of its own", () => {
    expect(FULL_READ_BLOCK).not.toMatch(/Mia|soccer|basketball|Stanford|Nike/i);
  });
});

describe("the parse", () => {
  it("keeps a stability on the list and drops one that is not", () => {
    const t = parseVideoTags(answer(), 5, { model: "m" })!;
    expect(t.beats[0].stability).toBe("handheld");
    expect(t.beats[1]).not.toHaveProperty("stability");
    expect(BEAT_STABILITIES).toEqual(["steady", "handheld", "shaky"]);
  });

  it("an answer without speech carries no speech key (every read that is not a full one)", () => {
    expect(parseVideoTags(answer(), 5, { model: "m" })).not.toHaveProperty("speech");
  });

  it("speech: segments clamped to the clip, ordered; empty and inverted ones dropped; language a short code", () => {
    const t = parseVideoTags(answer({
      speech: {
        has_speech: true, language: "en", music_present: true,
        transcript: [
          { start_s: 3, end_s: 9, text: "  second  " },
          { start_s: 0, end_s: 1.5, text: "first" },
          { start_s: 2, end_s: 1, text: "inverted" },
          { start_s: 1, end_s: 2, text: "   " },
        ],
      },
    }), 5, { model: "m" })!;
    expect(t.speech).toEqual({
      has_speech: true, language: "en", music_present: true,
      transcript: [{ start_s: 0, end_s: 1.5, text: "first" }, { start_s: 3, end_s: 5, text: "second" }],
    });
  });

  it("words in the transcript mean someone spoke, whatever has_speech said; an odd language is empty", () => {
    expect(parseSpeech({ has_speech: false, language: "English", transcript: [{ start_s: "00:01", end_s: "00:02.5", text: "go" }] })).toEqual({
      has_speech: true, language: "", music_present: false, transcript: [{ start_s: 1, end_s: 2.5, text: "go" }],
    });
    expect(parseSpeech(null)).toBeNull();
    expect(parseSpeech("nope")).toBeNull();
  });

  it("a runaway transcript is cut, not stored whole", () => {
    const transcript = Array.from({ length: MAX_SPEECH_SEGMENTS + 50 }, (_, i) => ({ start_s: i, end_s: i + 0.5, text: "x".repeat(900) }));
    const s = parseSpeech({ has_speech: true, language: "en", transcript })!;
    expect(s.transcript).toHaveLength(MAX_SPEECH_SEGMENTS);
    expect(s.transcript[0].text.length).toBe(500);
  });
});

describe("tagVideo sends the prompt it was asked for", () => {
  it("full → the full prompt; default → the unchanged one", async () => {
    const prompts: string[] = [];
    const transport: VideoTagTransport = async (_b, _m, prompt) => {
      prompts.push(prompt ?? "");
      return { text: answer(), usage: null, model: "m" };
    };
    await tagVideo(Buffer.from("x"), "a/b.mp4", 5, transport, PROFILE, true);
    await tagVideo(Buffer.from("x"), "a/b.mp4", 5, transport, PROFILE);
    expect(prompts[0]).toBe(videoPromptFor(PROFILE, { full: true }));
    expect(prompts[1]).toBe(videoPromptFor(PROFILE));
  });
});
