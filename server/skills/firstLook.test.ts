/**
 * firstLook.test.ts — the pure compute behind the first look, on a fixture shaped like Mia's
 * thirty most recent posts. No db, no model.
 */

// The module also exports the loader + writer, which import the db; the compute under test
// touches neither. The mock only needs to keep the import from demanding a DATABASE_URL — so it is
// an inert stub, NOT the PGlite harness.
//
// It used to be `require("../testUtils/pgliteDb")`, which booted a real in-process Postgres for a
// test that has no database work at all, and this file has no init/close hooks to shut it down.
// PGlite then fired a dynamic import after Jest tore the environment down:
//
//   ReferenceError: You are trying to `import` a file after the Jest environment has been torn down.
//   → TypeError: Cannot read properties of undefined (reading 'identifier')  [jest-runtime]
//
// That crashes the WORKER, so the casualty is whichever suite is loading when it lands — reported in
// CI as a "Test suite failed to run" in a neighbouring file, on Linux only. On Windows it arrived
// after results were written, so every test "passed" and the process died afterwards.
jest.mock("../db", () => ({ db: {}, pool: { end: async () => {} } }));

import { computeFirstLook, parseFirstLookModelOutput, FIRST_LOOK_THEMES_SYSTEM, type FirstLook, type PostRow } from "./firstLook";

const NOW = new Date("2026-09-03T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function post(p: Partial<PostRow> & { id: string }): PostRow {
  return { media_type: "VIDEO", caption: null, posted_at: day(1), like_count: 0, comments_count: 0, ...p };
}

const FIXTURE: PostRow[] = [
  post({ id: "a", media_type: "VIDEO",          caption: "excited to join @gorjana Sports Club 🫶🏼 #soccergirl", posted_at: day(9),  like_count: 278,   comments_count: 14 }),
  post({ id: "b", media_type: "CAROUSEL_ALBUM", caption: "coming soon to a stadium near you! #year4",          posted_at: day(32), like_count: 1458,  comments_count: 52 }),
  post({ id: "c", media_type: "CAROUSEL_ALBUM", caption: "glass half full❣️",                                    posted_at: day(75), like_count: 899,   comments_count: 49 }),
  post({ id: "d", media_type: "VIDEO",          caption: "tb to the youth tourneys 🫣 #soccergirl #ecnl",        posted_at: day(119), like_count: 34897, comments_count: 36 }),
  post({ id: "e", media_type: "VIDEO",          caption: "Stanford degrees at 19🎓 Follow & comment!",           posted_at: day(144), like_count: 54085, comments_count: 379 }),
  post({ id: "f", media_type: "IMAGE",          caption: null,                                                    posted_at: day(150), like_count: 12,    comments_count: 0 }),
  post({ id: "g", media_type: "VIDEO",          caption: "@gorjana x @adidas day",                                posted_at: day(160), like_count: 100,   comments_count: 1 }),
];

const PRESENCE = { followers: 22177, engagement_rate: 4.84, posts_last_30d: 1 };

test("format mix counts by media type and excludes nothing it should keep", () => {
  const fl = computeFirstLook("instagram", FIXTURE, PRESENCE, NOW);
  expect(fl.platform).toBe("instagram");
  expect(fl.posts_read).toBe(7);
  expect(fl.format_mix).toEqual({ reel_or_video: 4, carousel: 2, image: 1, other: 0 });
  expect(fl.presence).toEqual(PRESENCE);
});

test("cadence: posts per week over the span, median gap, last post", () => {
  const fl = computeFirstLook("instagram", FIXTURE, PRESENCE, NOW);
  // 7 posts across 151 days → 7/151*7 ≈ 0.32 per week
  expect(fl.cadence.posts_per_week).toBeCloseTo(0.32, 1);
  // gaps: 23, 43, 44, 25, 6, 10 → sorted 6,10,23,25,43,44 → median (23+25)/2 = 24
  expect(fl.cadence.median_gap_days).toBe(24);
  expect(fl.cadence.last_post_at).toBe(day(9).toISOString());
});

test("caption style: lower-case ratio, emoji, hashtags and mentions per captioned post", () => {
  const fl = computeFirstLook("instagram", FIXTURE, PRESENCE, NOW);
  const cs = fl.caption_style;
  expect(cs.with_caption).toBe(6);
  // Two of the six captions carry capitals ("…@gorjana Sports Club…", "Stanford degrees…") → 4/6
  expect(cs.lowercase_ratio).toBeCloseTo(0.67, 2);
  expect(cs.hashtags_per_post).toBeCloseTo(4 / 6, 2);   // #soccergirl, #year4, #soccergirl, #ecnl
  expect(cs.mentions_per_post).toBeCloseTo(3 / 6, 2);   // @gorjana ×2, @adidas
  expect(cs.emoji_per_post).toBeGreaterThan(0.5);        // 🫶🏼 ❣️ 🫣 🎓
  expect(cs.avg_length).toBeGreaterThan(20);
});

test("top posts are ids ranked by likes + comments; tagged handles are counted and lower-cased", () => {
  const fl = computeFirstLook("instagram", FIXTURE, PRESENCE, NOW);
  expect(fl.top_posts.map((p) => p.asset_id)).toEqual(["e", "d", "b", "c", "a"]);
  expect(fl.top_posts[0]).toMatchObject({ likes: 54085, comments: 379, type: "VIDEO" });
  expect(fl.top_posts[0]).not.toHaveProperty("caption");
  expect(fl.tagged).toEqual([{ handle: "gorjana", count: 2 }, { handle: "adidas", count: 1 }]);
  expect(fl.themes).toEqual([]);   // the model fills these; compute never guesses
  expect(fl.tone).toEqual([]);
});

test("edge cases: no posts, one post, no captions", () => {
  const empty = computeFirstLook("tiktok", [], PRESENCE, NOW);
  expect(empty.posts_read).toBe(0);
  expect(empty.cadence).toEqual({ posts_per_week: null, median_gap_days: null, last_post_at: null });
  expect(empty.caption_style.with_caption).toBe(0);
  expect(empty.caption_style.avg_length).toBeNull();
  expect(empty.top_posts).toEqual([]);

  const one = computeFirstLook("tiktok", [post({ id: "only", posted_at: day(3) })], PRESENCE, NOW);
  expect(one.cadence.posts_per_week).toBe(0);
  expect(one.cadence.median_gap_days).toBeNull();
  expect(one.caption_style.lowercase_ratio).toBeNull();
});

test("reads at most thirty posts", () => {
  const many = Array.from({ length: 45 }, (_, i) => post({ id: `p${i}`, posted_at: day(i + 1) }));
  expect(computeFirstLook("instagram", many, PRESENCE, NOW).posts_read).toBe(30);
});

describe("model output (prompt v2): interests, recurring_phrases, causes_mentioned", () => {
  test("parses all five lists, capped and trimmed", () => {
    const out = parseFirstLookModelOutput(JSON.stringify({
      themes: ["a", "b", "c", "d", "e", "f", "g"], tone: ["x", "y", "z", "w"],
      interests: [" cooking ", "travel", "fashion", "music", "gaming", "art", "film"],
      recurring_phrases: ["see you out there", "let's go", "p1", "p2", "p3", "p4"],
      causes_mentioned: ["mental health awareness", "c2", "c3", "c4", "c5", "c6"],
    }));
    expect(out.themes).toHaveLength(6);
    expect(out.tone).toHaveLength(3);
    expect(out.interests).toEqual(["cooking", "travel", "fashion", "music", "gaming", "art"]);
    expect(out.recurring_phrases).toHaveLength(5);
    expect(out.recurring_phrases[0]).toBe("see you out there");
    expect(out.causes_mentioned).toHaveLength(5);
  });

  test("validates: non-strings, empties and case-duplicates dropped; over-long values cut; fenced JSON accepted", () => {
    const out = parseFirstLookModelOutput("```json\n" + JSON.stringify({
      themes: ["training", 3, null, "", "Training"], tone: "casual",
      interests: [{ x: 1 }, "x".repeat(100)], recurring_phrases: ["y".repeat(200)], causes_mentioned: [true],
    }) + "\n```");
    expect(out.themes).toEqual(["training"]);
    expect(out.tone).toEqual([]);
    expect(out.interests).toEqual(["x".repeat(40)]);
    expect(out.recurring_phrases).toEqual(["y".repeat(80)]);
    expect(out.causes_mentioned).toEqual([]);
  });

  test("a v1-shaped answer (themes + tone only) still parses; the new lists are empty", () => {
    expect(parseFirstLookModelOutput('{"themes":["family"],"tone":["grateful"]}')).toEqual({
      themes: ["family"], tone: ["grateful"], interests: [], recurring_phrases: [], causes_mentioned: [],
    });
  });

  test("garbage throws (the caller records the error and stores the look without lists)", () => {
    expect(() => parseFirstLookModelOutput("not json")).toThrow();
  });

  test("the prompt asks for the new lists and keeps the grounding rule", () => {
    for (const k of ["interests", "recurring_phrases", "causes_mentioned"]) expect(FIRST_LOOK_THEMES_SYSTEM).toContain(k);
    expect(FIRST_LOOK_THEMES_SYSTEM).toContain("Use only what the captions show");
  });

  test("an old stored look (no new fields) is still a valid FirstLook", () => {
    const old = computeFirstLook("instagram", FIXTURE, PRESENCE, NOW) as FirstLook;
    expect(old.interests).toBeUndefined();
    expect(old.recurring_phrases ?? []).toEqual([]);
  });
});