/**
 * tools.test.ts — the post-kit tool group: find_music's interface (enums, not free text; use / don't-use guidance; no
 * athlete id), its results and errors, and a small eval of realistic asks graded on what a person would check.
 */
import { specOf, strictJsonSchema } from "../tools";
import { ENERGY_BANDS, TEMPO_BANDS, TRACK_MOODS, TRACK_THEMES } from "../../studio/music/taxonomy";
import { MUSIC_CATALOGUE } from "../../studio/music/find";
import { isLibraryTrackId } from "../../studio/music/library";
import { FIND_MUSIC_DESCRIPTION, findMusicTool, postKitTools } from "./tools";

const ctx = { athleteId: "a", runId: "r", skillId: "s" };
// The free library counts as installed here unless a test says otherwise (STUDIO_MUSIC_LIBRARY_READY).
beforeEach(() => { process.env.STUDIO_MUSIC_LIBRARY_READY = "true"; });
afterEach(() => { delete process.env.STUDIO_MUSIC_LIBRARY_READY; });
const run = (args: Record<string, unknown>) => findMusicTool().execute!(ctx, findMusicTool().args.parse(args)) as Promise<any>;

describe("find_music: the interface", () => {
  const spec = specOf(findMusicTool());

  it("is a read tool in the post-kit group, with every filter a fixed list", () => {
    expect(postKitTools().map((t) => [t.name, t.kind, t.permission])).toEqual([["find_music", "ours", "read"]]);
    const p = spec.schema.properties as Record<string, any>;
    expect(p.mood.enum).toEqual([...TRACK_MOODS]);
    expect(p.use.enum).toEqual(["personal", "brand"]);
    expect(p.energy.enum).toEqual([...ENERGY_BANDS]);
    expect(p.tempo.enum).toEqual([...TEMPO_BANDS]);
    expect(p.theme.enum).toEqual([...TRACK_THEMES]);
    expect(spec.schema.required).toEqual(["mood", "use"]);
    expect(Object.keys(p).filter((k) => /athlete/i.test(k))).toEqual([]);
    expect(strictJsonSchema(spec.schema).additionalProperties).toBe(false);
  });

  it("says what it does, when to use it and when not, and gives an example", () => {
    for (const part of ["Use when:", "Don't use:", "Example:", "brand-safe", "credit", "trending", "content_id_registered"]) expect(FIND_MUSIC_DESCRIPTION).toContain(part);
  });

  it("refuses free text where a list is required", () => {
    expect(findMusicTool().args.safeParse({ mood: "epic vibes", use: "personal" }).success).toBe(false);
    expect(findMusicTool().args.safeParse({ mood: "hype", use: "sponsor" }).success).toBe(false);
  });
});

describe("find_music: results and errors", () => {
  it("answers ok with three tracks, each with its reason, licence, credit and brand-safety", async () => {
    const r = await run({ mood: "bright", use: "personal", min_length_sec: 20 });
    expect(r.status).toBe("ok");
    expect(r.tracks).toHaveLength(3);
    for (const t of r.tracks) {
      expect(Object.keys(t)).toEqual(expect.arrayContaining(["track_id", "reason", "licence", "credit", "brand_safe", "bpm", "length_sec", "loops", "genre", "vocals", "energy_level", "content_id_registered"]));
      expect(t.content_id_registered).toBe(MUSIC_CATALOGUE[t.track_id].contentIdRegistered);
      expect(MUSIC_CATALOGUE[t.track_id]).toBeDefined();
    }
  });

  it("never returns a track whose file is not installed here", async () => {
    delete process.env.STUDIO_MUSIC_LIBRARY_READY;
    for (const mood of TRACK_MOODS) {
      const r = await run({ mood, use: "personal" });
      if (r.status === "ok") for (const t of r.tracks) expect([t.track_id, isLibraryTrackId(t.track_id)]).toEqual([t.track_id, false]);
    }
  });

  it("M2 through the tool: with MUSIC_ALLOW_ATTRIBUTION_TRACKS off (the default) no track needs a credit", async () => {
    for (const mood of TRACK_MOODS) for (const use of ["personal", "brand"]) {
      const r = await run({ mood, use });
      if (r.status === "ok") for (const t of r.tracks) expect([mood, use, t.track_id, t.credit]).toEqual([mood, use, t.track_id, null]);
    }
  });

  it("THE GUARD through the tool: brand use returns only brand-safe tracks", async () => {
    for (const mood of TRACK_MOODS) {
      const r = await run({ mood, use: "brand" });
      if (r.status === "ok") for (const t of r.tracks) expect([mood, t.track_id, t.brand_safe]).toEqual([mood, t.track_id, true]);
      else expect(r.reason).toMatch(/Try one of|No track/);
    }
  });
});

/**
 * THE EVAL — realistic asks a creative agent makes for a post, each graded on the checks a person would make: the
 * mood is right, a brand post is brand-safe, the energy is not the opposite of what was asked, the music outlasts the
 * cut (or loops), and a credit is attached where one is owed. The score is printed; the bar is every case passing.
 */
describe("find_music: eval", () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "game-winner hype reel, own account", args: { mood: "hype", use: "personal", energy: "high", min_length_sec: 20 } },
    { name: "training montage, driving, fast", args: { mood: "driving", use: "personal", tempo: "fast", theme: "workout", min_length_sec: 25 } },
    { name: "slow-motion finish, reflective", args: { mood: "reflective", use: "personal", theme: "slow-motion", min_length_sec: 15 } },
    { name: "brand launch reel, upbeat", args: { mood: "uplifting", use: "brand", energy: "high", theme: "championships", min_length_sec: 15 } },
    { name: "sponsored story, bright", args: { mood: "bright", use: "brand", min_length_sec: 10 } },
    { name: "recovery day, calm", args: { mood: "reflective", use: "personal", energy: "low", tempo: "slow", min_length_sec: 20 } },
    { name: "behind the scenes, playful", args: { mood: "playful", use: "personal", energy: "medium", min_length_sec: 15 } },
    { name: "golden-hour walk-off, warm", args: { mood: "warm", use: "personal", energy: "low", min_length_sec: 30 } },
    { name: "rivalry week, dark", args: { mood: "dark", use: "personal", energy: "high", min_length_sec: 20 } },
    { name: "brand partner, warm lifestyle", args: { mood: "warm", use: "brand", min_length_sec: 20 } },
    { name: "season recap, uplifting", args: { mood: "uplifting", use: "personal", min_length_sec: 30 } },
    { name: "brand gear drop, hype", args: { mood: "hype", use: "brand", energy: "high", min_length_sec: 15 } },
    { name: "day in the life, bright mid tempo", args: { mood: "bright", use: "personal", tempo: "mid", min_length_sec: 25 } },
  ];
  const OPPOSITE = { low: "high", high: "low", medium: null } as const;

  it("every case passes every check", async () => {
    const failures: string[] = [];
    for (const c of cases) {
      const r = await run(c.args);
      if (r.status !== "ok") { failures.push(`${c.name}: ${r.reason}`); continue; }
      const brand = c.args.use === "brand";
      for (const t of r.tracks) {
        const why = (k: string) => failures.push(`${c.name}: ${t.track_id} ${k}`);
        if (!t.moods.includes(c.args.mood) && !t.nearest_mood_only) why("wrong mood");
        if (brand && !t.brand_safe) why("not brand-safe on a brand post");
        if (c.args.energy && t.energy === OPPOSITE[c.args.energy as "low" | "medium" | "high"]) why("opposite energy");
        if (c.args.min_length_sec && t.length_sec < (c.args.min_length_sec as number) && !t.loops) why("shorter than the cut");
        if (String(t.licence).startsWith("CC-BY") && !t.credit) why("owes a credit but carries none");
      }
      if (!brand && r.tracks.length < 3) failures.push(`${c.name}: only ${r.tracks.length} choices`);
    }
    // eslint-disable-next-line no-console
    console.log(`find_music eval: ${cases.length - new Set(failures.map((f) => f.split(":")[0])).size}/${cases.length} cases clean`);
    expect(failures).toEqual([]);
  });
});
