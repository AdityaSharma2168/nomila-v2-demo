/**
 * firstLook.refresh.test.ts â€” the nightly First Look refresh against a real (PGlite) Postgres:
 * which (athlete, platform) pairs are due (age / new posts / missing / cap), that a refresh is
 * written on a NEW 'first_look' row that every reader takes as the latest for its platform, that
 * scoring readers skip that row, and that a model failure stores the look without the lists.
 *
 * The model is mocked at its boundary (lib/models) â€” no provider is ever reached.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/promptRegistry", () => ({ resolvePrompt: async (_k: string, fallback: string) => fallback }));

const generateContent = jest.fn();
jest.mock("../lib/models", () => ({
  GEMINI: { flash: "test-flash" },
  genai: () => ({ models: { generateContent: (...a: unknown[]) => generateContent(...a) } }),
}));

import { and, desc, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { athleteSnapshots, mediaAssets } from "../../shared/schema";
import { scoringSnapshotsOf } from "../lib/snapshotRows";
import { latestFirstLooks } from "../mila/onboarding";
import { getFirstLookTool } from "../mila/tools/getFirstLook";
import {
  firstLookRefreshConfig, refreshDueFirstLooks, refreshFirstLook, selectDueFirstLooks, type FirstLook,
} from "./firstLook";

const NOW = new Date("2026-10-03T05:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const CFG = { maxAgeDays: 30, minNewPosts: 10, maxAthletesPerNight: 50 };

const MODEL_JSON = JSON.stringify({
  themes: ["training", "family"], tone: ["casual"],
  interests: ["cooking", "travel"], recurring_phrases: ["see you out there"], causes_mentioned: ["mental health awareness"],
});

beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(() => { generateContent.mockReset(); generateContent.mockResolvedValue({ text: MODEL_JSON }); });

let postSeq = 0;
async function seedPosts(athleteId: string, platform: string, postedAt: Date[]): Promise<void> {
  for (const d of postedAt) {
    await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform, origin: "connected", status: "stored", source_media_id: `m-${++postSeq}`,
      media_type: "VIDEO", caption: `caption ${postSeq} see you out there`, posted_at: d, like_count: 1, comments_count: 0,
    } as any);
  }
}

function look(platform: string, computedAt: Date, extra: Partial<FirstLook> = {}): FirstLook {
  return {
    platform, computed_at: computedAt.toISOString(), posts_read: 3,
    presence: { followers: 10, engagement_rate: null, posts_last_30d: null },
    format_mix: { reel_or_video: 3, carousel: 0, image: 0, other: 0 },
    cadence: { posts_per_week: 1, median_gap_days: 7, last_post_at: null },
    caption_style: { with_caption: 3, avg_length: 10, lowercase_ratio: 1, emoji_per_post: 0, hashtags_per_post: 0, mentions_per_post: 0 },
    top_posts: [], tagged: [], themes: ["old theme"], tone: ["old tone"], ...extra,
  };
}

/** A connect-time snapshot carrying a first look and a social block (as fetchSocialData + runFirstLook leave it). */
async function seedConnectLook(athleteId: string, platform: string, computedAt: Date): Promise<string> {
  const [row] = await db.insert(athleteSnapshots).values({
    athlete_id: athleteId, trigger: "social_connect", created_at: computedAt,
    social: { [platform]: { followers: 1234, engagement_rate: 2.5, posts_last_30d: 4 } } as any,
    first_look: look(platform, computedAt) as any,
  }).returning({ id: athleteSnapshots.id });
  return row.id;
}

describe("selection", () => {
  test("age: a look older than FIRST_LOOK_REFRESH_DAYS is due; a fresh one with few new posts is not", async () => {
    const stale = await seedAthlete("Stale Look");
    await seedConnection({ athleteId: stale, platform: "tiktok" });
    await seedConnectLook(stale, "tiktok", daysAgo(31));
    await seedPosts(stale, "tiktok", [daysAgo(40)]);

    const fresh = await seedAthlete("Fresh Look");
    await seedConnection({ athleteId: fresh, platform: "tiktok" });
    await seedConnectLook(fresh, "tiktok", daysAgo(5));
    await seedPosts(fresh, "tiktok", [daysAgo(3), daysAgo(2), daysAgo(1)]);   // 3 < 10

    const due = await selectDueFirstLooks(NOW, CFG);
    expect(due.find((d) => d.athleteId === stale)).toMatchObject({ platform: "tiktok", reason: "age" });
    expect(due.find((d) => d.athleteId === fresh)).toBeUndefined();
  });

  test("new posts: â‰¥ FIRST_LOOK_REFRESH_MIN_NEW_POSTS top-level posts since the look was computed", async () => {
    const a = await seedAthlete("Prolific");
    await seedConnection({ athleteId: a, platform: "youtube" });
    await seedConnectLook(a, "youtube", daysAgo(10));
    await seedPosts(a, "youtube", [daysAgo(20)]);                                     // before the look: not new
    await seedPosts(a, "youtube", Array.from({ length: 10 }, (_, i) => daysAgo(9 - i * 0.5)));
    // A carousel child and a deleted post never count.
    await db.insert(mediaAssets).values({ athlete_id: a, platform: "youtube", origin: "connected", status: "stored", media_type: "CAROUSEL_CHILD", posted_at: daysAgo(1), parent_media_id: "x" } as any);

    const due = (await selectDueFirstLooks(NOW, CFG)).find((d) => d.athleteId === a);
    expect(due).toMatchObject({ platform: "youtube", reason: "new_posts", newPosts: 10 });
    expect((await selectDueFirstLooks(NOW, { ...CFG, minNewPosts: 11 })).find((d) => d.athleteId === a)).toBeUndefined();
  });

  test("missing: a connected platform with stored posts but no look yet is due; with no posts it is not", async () => {
    const a = await seedAthlete("Never Looked");
    await seedConnection({ athleteId: a, platform: "instagram" });
    await seedPosts(a, "instagram", [daysAgo(2)]);
    const b = await seedAthlete("No Posts");
    await seedConnection({ athleteId: b, platform: "instagram" });

    const due = await selectDueFirstLooks(NOW, CFG);
    expect(due.find((d) => d.athleteId === a)).toMatchObject({ platform: "instagram", reason: "missing", lastComputedAt: null });
    expect(due.find((d) => d.athleteId === b)).toBeUndefined();
  });

  test("only ACTIVE connections are considered", async () => {
    const a = await seedAthlete("Expired Conn");
    await seedConnection({ athleteId: a, platform: "tiktok", status: "expired" });
    await seedConnectLook(a, "tiktok", daysAgo(90));
    expect((await selectDueFirstLooks(NOW, CFG)).find((d) => d.athleteId === a)).toBeUndefined();
  });

  test("cap: at most FIRST_LOOK_REFRESH_MAX_PER_NIGHT athletes, stalest first", async () => {
    const all = await selectDueFirstLooks(NOW, CFG);
    const athletes = [...new Set(all.map((d) => d.athleteId))];
    expect(athletes.length).toBeGreaterThan(1);
    const capped = await selectDueFirstLooks(NOW, { ...CFG, maxAthletesPerNight: 1 });
    expect(new Set(capped.map((d) => d.athleteId)).size).toBe(1);
    // Never-computed counts as stalest.
    expect(capped[0].reason).toBe("missing");
  });

  test("config defaults are in code; env overrides them; junk falls back", () => {
    expect(firstLookRefreshConfig({} as any)).toEqual({ maxAgeDays: 30, minNewPosts: 10, maxAthletesPerNight: 50 });
    expect(firstLookRefreshConfig({ FIRST_LOOK_REFRESH_DAYS: "14", FIRST_LOOK_REFRESH_MIN_NEW_POSTS: "5", FIRST_LOOK_REFRESH_MAX_PER_NIGHT: "7" } as any))
      .toEqual({ maxAgeDays: 14, minNewPosts: 5, maxAthletesPerNight: 7 });
    expect(firstLookRefreshConfig({ FIRST_LOOK_REFRESH_DAYS: "abc", FIRST_LOOK_REFRESH_MAX_PER_NIGHT: "0" } as any).maxAgeDays).toBe(30);
  });
});

describe("refresh write", () => {
  test("a refresh is a NEW 'first_look' row that readers take as latest for the platform; other platforms and scoring readers are untouched", async () => {
    const a = await seedAthlete("Refresh Me");
    await seedConnection({ athleteId: a, platform: "tiktok" });
    await seedConnection({ athleteId: a, platform: "youtube" });
    const ttConnect = await seedConnectLook(a, "tiktok", daysAgo(40));
    await seedConnectLook(a, "youtube", daysAgo(35));
    await seedPosts(a, "tiktok", [daysAgo(3), daysAgo(2)]);

    const r = await refreshFirstLook(a, "tiktok");
    expect(generateContent).toHaveBeenCalledTimes(1);   // one model call per platform

    const [row] = await db.select().from(athleteSnapshots).where(eq(athleteSnapshots.id, r.snapshot_id));
    expect(row.trigger).toBe("first_look");
    expect(row.social).toBeNull();
    const fl = row.first_look as FirstLook;
    expect(fl.posts_read).toBe(2);
    expect(fl.presence).toEqual({ followers: 1234, engagement_rate: 2.5, posts_last_30d: 4 });   // from the newest scoring snapshot
    expect(fl.interests).toEqual(["cooking", "travel"]);
    expect(fl.recurring_phrases).toEqual(["see you out there"]);
    expect(fl.causes_mentioned).toEqual(["mental health awareness"]);
    expect(fl.model).toEqual({ key: "first_look.themes", version: 2 });

    // The connect-time row keeps its earlier look (history preserved).
    const [old] = await db.select().from(athleteSnapshots).where(eq(athleteSnapshots.id, ttConnect));
    expect((old.first_look as FirstLook).themes).toEqual(["old theme"]);

    // Readers: newest per platform.
    const looks = await latestFirstLooks(a);
    expect(looks.find((l) => l.platform === "tiktok")?.themes).toEqual(["training", "family"]);
    expect(looks.find((l) => l.platform === "youtube")?.themes).toEqual(["old theme"]);
    const tool = await getFirstLookTool.execute(a, {} as any) as { looks: any[] };
    expect(tool.looks.find((l) => l.platform === "tiktok")).toMatchObject({ themes: ["training", "family"], interests: ["cooking", "travel"], recurring_phrases: ["see you out there"], causes_mentioned: ["mental health awareness"] });
    // An old (v1) look reads with empty new fields.
    expect(tool.looks.find((l) => l.platform === "youtube")).toMatchObject({ interests: [], recurring_phrases: [], causes_mentioned: [] });

    // Scoring readers never see the refresh row as "the latest snapshot".
    const [latestScoring] = await db.select().from(athleteSnapshots).where(scoringSnapshotsOf(a)).orderBy(desc(athleteSnapshots.created_at)).limit(1);
    expect(latestScoring.trigger).toBe("social_connect");
    expect(latestScoring.social).not.toBeNull();
  });

  test("a model failure stores the look without the lists and records why; afterwards the pair is no longer due", async () => {
    const a = await seedAthlete("Model Down");
    await seedConnection({ athleteId: a, platform: "instagram" });
    await seedPosts(a, "instagram", [daysAgo(1)]);
    generateContent.mockRejectedValueOnce(new Error("model unavailable"));

    const r = await refreshFirstLook(a, "instagram");
    const [row] = await db.select().from(athleteSnapshots).where(eq(athleteSnapshots.id, r.snapshot_id));
    const fl = row.first_look as FirstLook;
    expect(row.trigger).toBe("first_look");
    expect(fl.themes).toEqual([]);
    expect(fl.interests).toBeUndefined();
    expect(fl.model?.error).toBe("model unavailable");
    expect(fl.presence).toEqual({ followers: null, engagement_rate: null, posts_last_30d: null });   // no scoring snapshot yet
    // computed_at is wall-clock now, with no newer posts: nothing is due for it.
    expect((await selectDueFirstLooks(new Date(), CFG)).find((d) => d.athleteId === a)).toBeUndefined();
  });

  test("the nightly pass: one failing pair is logged and skipped; the rest still run; one model call per pair", async () => {
    const a = await seedAthlete("Pass One");
    await seedConnection({ athleteId: a, platform: "tiktok" });
    await seedPosts(a, "tiktok", [daysAgo(1)]);
    const b = await seedAthlete("Pass Two");
    await seedConnection({ athleteId: b, platform: "youtube" });
    await seedPosts(b, "youtube", [daysAgo(1)]);
    const due = await selectDueFirstLooks(NOW, { ...CFG, maxAthletesPerNight: 500 });
    expect(due.length).toBeGreaterThan(1);

    // The first insert of the pass blows up; the pass carries on.
    const spy = jest.spyOn(db, "insert");
    spy.mockImplementationOnce(() => { throw new Error("db write failed"); });
    const res = await refreshDueFirstLooks(NOW, { ...CFG, maxAthletesPerNight: 500 });
    spy.mockRestore();
    expect(res).toEqual({ due: due.length, refreshed: due.length - 1, failed: 1 });
    // At most one model call per pair (none for a pair with no captioned posts, e.g. an aged look on an empty channel).
    expect(generateContent.mock.calls.length).toBeLessThanOrEqual(due.length);
    expect(generateContent.mock.calls.length).toBeGreaterThan(0);
  });
});
