/**
 * learning.test.ts — the learning loop (agent/learning): the arithmetic (core.ts) and one athlete's nightly run (job.ts)
 * on the in-memory store with fake loaders, a fake outcome writer and a fake announcer. No database, no provider, no
 * model. Made-up athletes and posts; nothing here names a real person, sport, team or brand.
 *
 *   L1  link: same platform, same format family, ±3 days of the due date (the athlete's day), the action older than the
 *       post; nearest due date; one post per action; skipped / expired never link; never across athletes. L1b–d: the
 *       link pasted with "I posted it" links first (postKeyOf: Instagram, TikTok, YouTube, Facebook ids; other hosts keep
 *       their query); the day they said it went up stands in for a due date — both only with athleteSaid (the flag)
 *   L5b CONTENT_READY_QUEUE only: a link marks a READY kit posted (by "learning") only by the pasted link, or by time
 *       when the post went up after the kit was built and after "Post it"; never a kit not ready or resting; off = as before
 *   L2  baseline + judge: medians of the athlete's settled posts on that platform (stories apart, 90 days, not the post
 *       itself); the minimum sample; worked / mixed / did not work and the plain note; ratios never overstated
 *   L3  summary: platform × format, pillar, event timing, weekday; n and `leads` from 8; linked and unlinked posts; the
 *       lines the plan, Understand and chat read (3+ posts, marked leads or early sign)
 *   L4  exceptional post: ≥ 3× reach or saves with the minimum sample and value; one per post, one a week
 *   L5  the job: off unless AGENT_LEARNING_LOOP; links, judges at 2 and 7 days, writes one summary fact, one message;
 *       an unlinked post still gets the message and counts in the summary
 *   L6  time zone: day of week, "from Friday" and the due-date window use the athlete's phone time zone, UTC without one
 *   L7  the flag is "true" in the dev Cloud Run yaml (once) and absent from prod
 */
jest.mock("../../db", () => ({ db: {} }));
// MILA_WELCOME's choice check (agent/welcome/choices.ts), faked: the database is not used here.
const mockIsAllowed = jest.fn();
jest.mock("../welcome/choices", () => ({ isAllowed: (...a: unknown[]) => mockIsAllowed(...a) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Decision } from "../../../shared/agent";
import { createMemoryStore } from "../research/store";
import {
  baselineFor, EXCEPTIONAL_COPY, exceptionalPost, fmtRatio, formatClass, groupPosts, judge, linkPosts, localDay, median, postActionOf, postKeyOf,
  readingAt, summarise, summaryClaim, WHAT_WORKS_REF, whatWorksHeading, whatWorksLines, whatWorksShown, type ContentObservation, type PostAction, type Reading,
} from "./core";
import { EXCEPTIONAL_DETAIL_KIND, runLearningLoop, whatWorksFrom, type LearningDeps } from "./job";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const T0 = new Date("2026-09-01T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const iso = (days: number) => at(days).toISOString();
const LA = "America/Los_Angeles";

/** Observations of one post: `metrics` read `readAfter` days after it went up. */
function post(entityId: string, postedDay: number, metrics: Reading, o: { athleteId?: string; platform?: string; format?: string | null; readAfter?: number; permalink?: string } = {}): ContentObservation[] {
  return Object.entries(metrics).map(([metricKey, value]) => ({
    athleteId: o.athleteId ?? A, platform: o.platform ?? "instagram", entityId, entityTime: iso(postedDay), entityFormat: o.format === undefined ? "reel" : o.format,
    metricKey, value: value!, observedAt: iso(postedDay + (o.readAfter ?? 7)), ...(o.permalink ? { permalink: o.permalink } : {}),
  }));
}
/** n settled posts of the athlete with the same numbers, posted from `fromDay` one a day. */
const usual = (n: number, metrics: Reading, fromDay: number, o: Parameters<typeof post>[3] = {}) =>
  Array.from({ length: n }, (_, i) => post(`u${fromDay}-${i}`, fromDay + i, metrics, o)).flat();

function action(id: string, o: { athleteId?: string; dueOn?: string | null; platform?: string | null; createdAt?: string; response?: Decision["response"]; format?: string | null; pillar?: string; eventDate?: string; postedLink?: string; postedAt?: string } = {}): PostAction {
  return {
    id, athleteId: o.athleteId ?? A, createdAt: o.createdAt ?? iso(-30), response: o.response ?? "accepted", dueOn: o.dueOn === undefined ? "2026-09-10" : o.dueOn,
    platform: o.platform === undefined ? "instagram" : o.platform, format: o.format === undefined ? "reel" : o.format, published: null,
    pillar: o.pillar ?? null, eventDate: o.eventDate ?? null, postedLink: o.postedLink ?? null, postedAt: o.postedAt ?? null, kitBuilt: false, kitBuiltAt: null, approvedAt: null,
  };
}

// ─── L1 link ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("L1 link", () => {
  const posts = (obs: ContentObservation[]) => groupPosts(A, obs);
  const pairs = (links: ReturnType<typeof linkPosts>) => links.map((l) => [l.actionId, l.post.entityId]);

  it("format families: reel, carousel, story; feed / image / photo / post are one", () => {
    expect(["reel", "carousel", "story", "feed", "image", "photo", "post", null].map(formatClass))
      .toEqual(["reel", "carousel", "story", "feed", "feed", "feed", "feed", null]);
  });

  it("links on platform + format + ±3 days of the due date; the nearest due date wins; each action once", () => {
    // 2026-09-10 is day 9.
    const p = posts([...post("near", 9, { reach: 1 }), ...post("edge", 12, { reach: 1 }), ...post("far", 13, { reach: 1 })]);
    const links = linkPosts(A, p, [action("a1", { dueOn: "2026-09-10" }), action("a2", { dueOn: "2026-09-09" })]);
    // "near" (09-10) is due-day for a1; "edge" (09-13) is 3 days after a1's and 4 after a2's: a1 is taken, a2 too far.
    expect(pairs(links)).toEqual([["a1", "near"]]);
    // Several open actions: the nearest due date wins.
    expect(pairs(linkPosts(A, posts(post("p", 9, { reach: 1 })), [action("far", { dueOn: "2026-09-07" }), action("close", { dueOn: "2026-09-11" })]))).toEqual([["close", "p"]]);
    // "far" (09-14) is 4 days off: never.
    expect(linkPosts(A, posts(post("far", 13, { reach: 1 })), [action("a1")])).toEqual([]);
  });

  it("the format must match (photo ↔ feed links; reel ↔ carousel does not); the platform must match", () => {
    expect(pairs(linkPosts(A, posts(post("ph", 9, { reach: 1 }, { format: "post" })), [action("feed", { format: "feed" })]))).toEqual([["feed", "ph"]]);
    expect(linkPosts(A, posts(post("c", 9, { reach: 1 }, { format: "carousel" })), [action("r", { format: "reel" })])).toEqual([]);
    expect(linkPosts(A, posts(post("t", 9, { reach: 1 }, { platform: "tiktok" })), [action("ig")])).toEqual([]);
    expect(linkPosts(A, posts(post("n", 9, { reach: 1 }, { format: null })), [action("r")])).toEqual([]);
  });

  it("never links a post from before the action, a skipped or expired action, or an undated one", () => {
    const p = posts(post("p", 9, { reach: 1 }));
    expect(linkPosts(A, p, [action("later", { createdAt: iso(10) })])).toEqual([]);
    expect(linkPosts(A, p, [action("s", { response: "skipped" }), action("e", { response: "expired" }), action("u", { dueOn: null })])).toEqual([]);
    expect(pairs(linkPosts(A, p, [action("pending", { response: "pending" })]))).toEqual([["pending", "p"]]);
  });

  it("never links across athletes: another athlete's post or action is ignored", () => {
    expect(groupPosts(A, post("b1", 9, { reach: 1 }, { athleteId: B }))).toEqual([]);
    expect(linkPosts(A, groupPosts(B, post("b1", 9, { reach: 1 }, { athleteId: B })), [action("a1")])).toEqual([]);
    expect(linkPosts(A, posts(post("p1", 9, { reach: 1 })), [action("b-action", { athleteId: B })])).toEqual([]);
  });

  it("L1b \"I posted it\" with a link: links to the post with that link first, whatever its date or format", () => {
    const p = posts([
      ...post("pasted", 20, { reach: 1 }, { format: "carousel", permalink: "https://www.instagram.com/p/AbC_12-x/" }),
      ...post("timely", 9, { reach: 1 }),
    ]);
    // The pasted link names a carousel 10 days off the due date: by link it links anyway; the other action takes the
    // reel on its due day by time.
    const acts = [action("tapped", { postedLink: "https://instagram.com/reel/AbC_12-x?igsh=xyz" }), action("by-time")];
    const links = linkPosts(A, p, acts, null, { athleteSaid: true });
    expect(links.map((l) => [l.actionId, l.post.entityId, l.via])).toEqual([["tapped", "pasted", "link"], ["by-time", "timely", "time"]]);
    // A link that names no synced post yet links nothing by link (and the action can still link by time).
    expect(linkPosts(A, posts(post("timely", 9, { reach: 1 })), [action("tapped", { postedLink: "https://instagram.com/p/NotSyncedYet/" })], null, { athleteSaid: true }).map((l) => l.via)).toEqual(["time"]);
    // CONTENT_READY_QUEUE off (athleteSaid false): no pass by link — exactly the loop as it was.
    expect(linkPosts(A, p, acts).map((l) => [l.actionId, l.via])).toEqual([["tapped", "time"]]);
  });

  it("L1c \"I posted it\" with no due date: the day they said it went up stands in for it", () => {
    const p = posts(post("p", 9, { reach: 1 }));
    expect(linkPosts(A, p, [action("u", { dueOn: null })])).toEqual([]);
    expect(pairs(linkPosts(A, p, [action("u", { dueOn: null, postedAt: iso(8) })], null, { athleteSaid: true }))).toEqual([["u", "p"]]);
    expect(linkPosts(A, p, [action("u", { dueOn: null, postedAt: iso(2) })], null, { athleteSaid: true })).toEqual([]);
    // Off: the stated day is not read.
    expect(linkPosts(A, p, [action("u", { dueOn: null, postedAt: iso(8) })])).toEqual([]);
  });

  it("L1d postKeyOf: a pasted link and a synced permalink compare on what names the post", () => {
    expect(postKeyOf("https://www.instagram.com/p/AbC/")).toBe("instagram:AbC");
    expect(postKeyOf("https://instagram.com/reel/AbC?igsh=1")).toBe("instagram:AbC");
    expect(postKeyOf("https://m.instagram.com/tv/AbC")).toBe("instagram:AbC");
    expect(postKeyOf("https://www.tiktok.com/@someone/video/7312345678901234567?lang=en")).toBe("tiktok:7312345678901234567");
    expect(postKeyOf("https://www.tiktok.com/@someone/video/7312345678901234567?lang=en")).toBe(postKeyOf("https://m.tiktok.com/v/x/video/7312345678901234567"));
    // YouTube: the synced permalink shape (lib/integrations/youtube.ts) and every pasted shape key by the video id.
    expect(postKeyOf("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube:dQw4w9WgXcQ");
    expect(postKeyOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abc")).toBe("youtube:dQw4w9WgXcQ");
    expect(postKeyOf("https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ")).toBe("youtube:dQw4w9WgXcQ");
    expect(postKeyOf("https://youtu.be/dQw4w9WgXcQ?si=xyz")).toBe("youtube:dQw4w9WgXcQ");
    expect(postKeyOf("https://www.youtube.com/shorts/aBcDeF12345")).toBe("youtube:aBcDeF12345");
    expect(postKeyOf("https://youtube.com/watch?v=OTHERvideo1")).not.toBe(postKeyOf("https://youtube.com/watch?v=dQw4w9WgXcQ"));
    expect([postKeyOf("https://youtube.com/watch"), postKeyOf("https://www.youtube.com/@channel")]).toEqual([null, null]);
    // Facebook: by the story / video id.
    expect(postKeyOf("https://www.facebook.com/permalink.php?story_fbid=1234567890&id=111")).toBe("facebook:1234567890");
    expect(postKeyOf("https://m.facebook.com/story.php?story_fbid=1234567890&id=222")).toBe("facebook:1234567890");
    expect(postKeyOf("https://www.facebook.com/watch/?v=987654321")).toBe("facebook:987654321");
    expect(postKeyOf("https://www.facebook.com/SomePage/videos/987654321/")).toBe("facebook:987654321");
    expect(postKeyOf("https://www.facebook.com/SomePage/posts/pfbid0abcDEF")).toBe("facebook:pfbid0abcDEF");
    expect(postKeyOf("https://www.facebook.com/permalink.php?id=111")).toBeNull();
    // Any other host keeps its query: two posts on one path never collide.
    expect(postKeyOf("https://example.com/Posts/1/")).toBe("example.com/posts/1");
    expect(postKeyOf("https://example.com/view?id=2&b=1")).toBe("example.com/view?b=1&id=2");
    expect(postKeyOf("https://example.com/view?id=2")).not.toBe(postKeyOf("https://example.com/view?id=3"));
    // Not a post link: not a URL, not http(s), or carrying a user name / password.
    expect([postKeyOf("not a link"), postKeyOf("ftp://x.com/a"), postKeyOf(null), postKeyOf("https://user:pw@instagram.com/p/AbC/")]).toEqual([null, null, null, null]);
  });

  it("reads a post action from its decision: platform, format, pillar, event", () => {
    const d = {
      id: "d1", athleteId: A, createdAt: iso(0), response: "accepted", kind: "action",
      detail: { kind: "post", dueOn: "2026-09-10", deliverable: { platform: "Instagram Reels" }, post: { format: "reel" },
        idea: { ideaId: null, pillar: { key: "P1", name: "Game days" } }, event: { factId: "f", label: "x", date: "2026-09-12", precision: "day" } },
    } as unknown as Decision;
    const a = postActionOf(d)!;
    expect([a.platform, a.format, a.pillar, a.eventDate, a.dueOn]).toEqual(["instagram", "reel", "Game days", "2026-09-12", "2026-09-10"]);
    expect(postActionOf({ ...d, kind: "goal" } as Decision)).toBeNull();
    expect(postActionOf({ ...d, detail: { ...d.detail, kind: "pitch" } } as Decision)).toBeNull();
  });
});

// ─── L2 baseline + judge ─────────────────────────────────────────────────────────────────────────────────────────

describe("L2 baseline and judge", () => {
  const NOW = at(100);

  it("median", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("a reading at day N is the latest observation up to N + 1 day; a late-only metric uses its first observation", () => {
    const obs = [
      ...post("p", 0, { reach: 100 }, { readAfter: 1 }), ...post("p", 0, { reach: 180 }, { readAfter: 2.5 }),
      ...post("p", 0, { reach: 300 }, { readAfter: 7 }), ...post("p", 0, { save_count: 9 }, { readAfter: 20 }), ...post("p", 0, { save_count: 12 }, { readAfter: 30 }),
    ];
    const [p] = groupPosts(A, obs);
    expect(readingAt(p, 2)).toEqual({ reach: 180, save_count: 9 });
    expect(readingAt(p, 7)).toEqual({ reach: 300, save_count: 9 });
  });

  it("the athlete's usual: settled posts on that platform in 90 days, stories apart, not the post itself", () => {
    const posts = groupPosts(A, [
      ...usual(4, { reach: 100 }, 20), ...post("hi", 30, { reach: 1000 }),          // 5 posts: 100 ×4, 1000
      ...post("old", 5, { reach: 9999 }),                                            // 95 days before NOW: out
      ...post("fresh", 97, { reach: 9999 }),                                         // 3 days old: not settled
      ...post("st", 40, { reach: 9999 }, { format: "story" }),                       // a story: its own usual
      ...post("tt", 40, { reach: 9999 }, { platform: "tiktok" }),                    // another platform
    ]);
    expect(baselineFor(posts, "instagram", "post", NOW)).toEqual({ reach: { median: 100, n: 5 } });
    expect(baselineFor(posts, "instagram", "post", NOW, "hi")).toEqual({ reach: { median: 100, n: 4 } });
    expect(baselineFor(posts, "instagram", "story", NOW)).toEqual({ reach: { median: 9999, n: 1 } });
  });

  it("the minimum sample: under 5 posts behind a metric, it is not judged", () => {
    const posts = groupPosts(A, usual(4, { save_count: 10, reach: 100 }, 20));
    expect(judge({ save_count: 50 }, baselineFor(posts, "instagram", "post", NOW))).toBeNull();
    const five = groupPosts(A, usual(5, { save_count: 10, reach: 100 }, 20));
    expect(judge({ save_count: 50 }, baselineFor(five, "instagram", "post", NOW))?.outcome).toBe("worked");
  });

  it("worked / did not work / mixed, on the median of the ratios, with a plain note", () => {
    const b = baselineFor(groupPosts(A, usual(6, { save_count: 10, reach: 100, share_count: 4 }, 20)), "instagram", "post", NOW);
    expect(judge({ save_count: 21, reach: 140, share_count: 6 }, b)).toMatchObject({ outcome: "worked", note: "2.1× your usual saves" });
    expect(judge({ save_count: 4, reach: 50, share_count: 2 }, b)).toMatchObject({ outcome: "did_not_work", note: "0.4× your usual saves" });
    expect(judge({ save_count: 30, reach: 80, share_count: 4 }, b)).toMatchObject({ outcome: "mixed", note: "3× your usual saves, 0.8× your usual reach" });
  });

  it("ratios are rounded down, never overstated", () => {
    expect([fmtRatio(2.99), fmtRatio(3), fmtRatio(0.46), fmtRatio(12.7)]).toEqual(["2.9×", "3×", "0.4×", "12×"]);
  });
});

// ─── L3 summary ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("L3 the weekly summary", () => {
  const NOW = at(100);

  it("lines by platform × format, pillar, event timing and weekday; n and leads from 8; unlinked posts count", () => {
    const obs = [...usual(8, { save_count: 20, reach: 100 }, 20), ...usual(3, { save_count: 5, reach: 100 }, 40, { format: "carousel" })];
    const posts = groupPosts(A, obs);
    // Only one of the 11 posts is linked to a plan action; the other 10 still count everywhere they can.
    const linked = new Map<string, PostAction>([[`instagram|u20-0`, action("a1", { pillar: "Game days", eventDate: "2026-09-25" })]]);
    const w = summarise(A, posts, linked, NOW);
    expect(w.posts).toBe(11);
    expect(w.baselines.instagram).toEqual({ save_count: { median: 20, n: 11 }, reach: { median: 100, n: 11 } });
    const reel = w.lines.find((l) => l.key === "instagram/reel")!;
    expect(reel).toMatchObject({ dimension: "platform_format", n: 8, leads: true, metrics: { save_count: { ratio: 1, n: 8 }, reach: { ratio: 1, n: 8 } } });
    const carousel = w.lines.find((l) => l.key === "instagram/carousel")!;
    expect(carousel).toMatchObject({ n: 3, leads: false, metrics: { save_count: { ratio: 0.25, n: 3 } } });
    expect(w.lines.find((l) => l.dimension === "pillar")).toMatchObject({ label: "Game days", n: 1, leads: false });
    // u20-0 went up 21 Sep, before the 25 Sep event.
    expect(w.lines.find((l) => l.dimension === "event_timing")).toMatchObject({ key: "before", n: 1 });
    expect(w.lines.filter((l) => l.dimension === "weekday").reduce((s, l) => s + l.n, 0)).toBe(11);
    const claim = summaryClaim(w);
    expect(claim).toContain("Instagram reel: saves 1×, reach 1× (8 posts, the athlete's data leads)");
    expect(claim).toContain("Instagram carousel: saves 0.2×, reach 1× (3 posts, early sign only)");
    expect(claim).not.toMatch(/\b(her|she)\b/i);
    expect(claim.length).toBeLessThanOrEqual(2000);
    // With nothing linked at all, every post still counts.
    expect(summarise(A, posts, new Map(), NOW).posts).toBe(11);
  });

  it("never reads another athlete's posts", () => {
    const posts = [...groupPosts(A, usual(2, { reach: 10 }, 20)), ...groupPosts(B, usual(9, { reach: 10 }, 20, { athleteId: B }))];
    expect(summarise(A, posts, new Map(), NOW).posts).toBe(2);
  });

  it("what the plan, Understand and chat read: lines from 3 posts, marked leads (8+) or early sign; a cap keeps leading lines first", () => {
    const obs = [...usual(8, { save_count: 20, reach: 100 }, 20), ...usual(3, { save_count: 5, reach: 100 }, 40, { format: "carousel" })];
    const linked = new Map<string, PostAction>([[`instagram|u20-0`, action("a1", { pillar: "Game days", eventDate: "2026-09-25" })]]);
    const w = summarise(A, groupPosts(A, obs), linked, NOW);
    const lines = whatWorksLines(w);
    expect(lines).toContain("- Instagram reel | saves 1×, reach 1× the athlete's usual | 8 posts | leads");
    expect(lines).toContain("- Instagram carousel | saves 0.2×, reach 1× the athlete's usual | 3 posts | early sign");
    // The pillar and event-timing lines rest on one post: left out, as is every line under 3.
    expect(lines.join("\n")).not.toMatch(/Game days|before an event/);
    expect(whatWorksShown(w).every((l) => l.n >= 3)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\b(her|she)\b/i);
    // Capped at one: the leading line stays.
    expect(whatWorksLines(w, 1)).toEqual(["- Instagram reel | saves 1×, reach 1× the athlete's usual | 8 posts | leads"]);
    expect(whatWorksLines(null)).toEqual([]);
    expect(whatWorksHeading(w)).toBe(`WHAT WORKS FOR THIS ATHLETE (the athlete's own posts in the last 90 days, each against their usual on that platform; "leads" = 8 or more posts, else an early sign)`);
  });
});

// ─── L4 exceptional post ─────────────────────────────────────────────────────────────────────────────────────────

describe("L4 the exceptional post", () => {
  const NOW = at(100);
  const base = usual(6, { save_count: 10, reach: 1000 }, 50);
  const none = { celebrated: new Set<string>(), lastAt: null };

  it("≥ 3× the athlete's usual saves (or reach), 2–8 days old: the one post", () => {
    const posts = groupPosts(A, [...base, ...post("star", 96, { save_count: 30, reach: 1100 }, { readAfter: 3 })]);
    expect(exceptionalPost(posts, NOW, none)).toMatchObject({ post: { entityId: "star" }, metric: "save_count", ratio: 3, usual: 10 });
  });

  it("not at 2.9×, not under 2 days or over 8 days old, not without 5 posts behind the usual, not under 5 of it", () => {
    expect(exceptionalPost(groupPosts(A, [...base, ...post("p", 96, { save_count: 29 }, { readAfter: 3 })]), NOW, none)).toBeNull();
    expect(exceptionalPost(groupPosts(A, [...base, ...post("p", 99, { save_count: 90 }, { readAfter: 0.5 })]), NOW, none)).toBeNull();
    expect(exceptionalPost(groupPosts(A, [...base, ...post("p", 90, { save_count: 90 }, { readAfter: 3 })]), NOW, none)).toBeNull();
    expect(exceptionalPost(groupPosts(A, [...usual(4, { save_count: 10 }, 50), ...post("p", 96, { save_count: 90 }, { readAfter: 3 })]), NOW, none)).toBeNull();
    expect(exceptionalPost(groupPosts(A, [...usual(6, { save_count: 1 }, 50), ...post("p", 96, { save_count: 4 }, { readAfter: 3 })]), NOW, none)).toBeNull();
  });

  it("at most one per post and one a week", () => {
    const posts = groupPosts(A, [...base, ...post("star", 96, { save_count: 40 }, { readAfter: 3 })]);
    expect(exceptionalPost(posts, NOW, { celebrated: new Set(["instagram|star"]), lastAt: null })).toBeNull();
    expect(exceptionalPost(posts, NOW, { celebrated: new Set(), lastAt: iso(95) })).toBeNull();
    expect(exceptionalPost(posts, NOW, { celebrated: new Set(), lastAt: iso(92) })).not.toBeNull();
  });
});

// ─── L5 the job ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("L5 the nightly job for one athlete", () => {
  const saved = process.env.AGENT_LEARNING_LOOP;
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] }); jest.setSystemTime(T0); });
  afterEach(() => { jest.useRealTimers(); if (saved === undefined) delete process.env.AGENT_LEARNING_LOOP; else process.env.AGENT_LEARNING_LOOP = saved; });

  function setup(obs: ContentObservation[], timeZone: string | null = null) {
    const store = createMemoryStore();
    const outcomes: Array<[string, string, string, string | null]> = [];
    const messages: Array<[string, string]> = [];
    const pushes: unknown[] = [];
    const deps: LearningDeps = {
      store,
      // A loader that ignores the athlete id on purpose: the job must still never use another athlete's rows.
      loadContentObservations: async () => obs,
      loadTimeZone: async () => timeZone,
      recordOutcome: async (athleteId, id, outcome, note) => { outcomes.push([athleteId, id, outcome, note]); },
      announcer: { postMilaMessage: async (athleteId, _title, text) => { messages.push([athleteId, text]); return "conv-1"; }, push: async (_a, e) => { pushes.push(e); } },
    };
    return { store, deps, outcomes, messages, pushes };
  }
  const postDetail = (dueOn: string, format = "reel") => ({
    kind: "post", what: "Post a reel", button: "post", dueOn, event: null, state: "made",
    deliverable: { type: "post_brief", title: "Reel", body: "", target: null, platform: "instagram", thread: null, connector: null },
    post: { format }, idea: { ideaId: null, pillar: { key: "P1", name: "Game days" } },
  });

  it("does nothing unless AGENT_LEARNING_LOOP is exactly \"true\"", async () => {
    const { deps, store } = setup(usual(6, { reach: 1 }, -40));
    for (const v of [undefined, "false", "TRUE", "1"]) {
      if (v === undefined) delete process.env.AGENT_LEARNING_LOOP; else process.env.AGENT_LEARNING_LOOP = v;
      expect(await runLearningLoop(A, deps, at(10))).toMatchObject({ ran: false, linked: 0 });
    }
    expect(await store.listFacts(A)).toEqual([]);
  });

  it("links, judges at 2 and 7 days, writes one summary fact, sends one message — and never twice", async () => {
    process.env.AGENT_LEARNING_LOOP = "true";
    // The athlete's usual: 6 settled reels (saves 10, reach 1000). The plan's reel goes up on its due day (day 3, a
    // Friday) and does about 4× the usual saves; another athlete's post on the same day must never link to the action.
    const obs = [
      ...usual(6, { save_count: 10, reach: 1000 }, -40),
      ...post("mine", 3, { save_count: 38, reach: 1200 }, { readAfter: 2 }),
      ...post("mine", 3, { save_count: 40, reach: 1300 }, { readAfter: 7 }),
      ...post("theirs", 3, { save_count: 400 }, { athleteId: B, readAfter: 2 }),
    ];
    const { store, deps, outcomes, messages, pushes } = setup(obs);
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", suggested: "Post a reel", why: "w", evidence: [], kind: "action", detail: postDetail("2026-09-04") });
    const other = await store.insertDecision(B, { runId: null, skillId: "plan", suggested: "Post", why: "w", evidence: [], kind: "action", detail: postDetail("2026-09-04") });

    // Day 6: 3 days after posting — linked, the 2-day reading judged, the summary written, one message.
    jest.setSystemTime(at(6));
    const r1 = await runLearningLoop(A, deps, at(6));
    expect(r1).toMatchObject({ ran: true, linked: 1, judged: 1, summaryWritten: true });
    const linked = (await store.getDecision(A, d.id))!.detail as any;
    expect(linked.published).toMatchObject({ platform: "instagram", entity_id: "mine", via: "time" });
    expect(linked.published.readings.d2).toMatchObject({ metrics: { save_count: 38, reach: 1200 }, outcome: "worked" });
    expect(outcomes).toEqual([[A, d.id, "worked", "After 2 days: 3.8× your usual saves"]]);
    expect(((await store.getDecision(B, other.id))!.detail as any).published).toBeUndefined();
    const facts = (await store.listFacts(A)).filter((f) => f.source.ref === WHAT_WORKS_REF);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ type: "measured", subject: { kind: "content" } });
    expect(messages).toEqual([[A, "Your Instagram reel from Friday got 3.8× your usual saves. Want another like it this week?"]]);
    expect(pushes).toEqual([expect.objectContaining({ kind: "mila_suggestion", target: { screen: "mila", id: "conv-1" } })]);
    const sent = await store.listDecisions(A, { skillId: "learning" });
    expect(sent).toHaveLength(1);
    expect(sent[0].detail).toMatchObject({ kind: EXCEPTIONAL_DETAIL_KIND, entityId: "mine", conversationId: "conv-1" });

    // Day 11: the 7-day reading is judged; nothing is linked again; no second message; the summary is not due yet.
    jest.setSystemTime(at(11));
    const r2 = await runLearningLoop(A, deps, at(11));
    expect(r2).toMatchObject({ linked: 0, judged: 1, summaryWritten: false, messaged: null });
    expect(outcomes[1]).toEqual([A, d.id, "worked", "4× your usual saves"]);
    expect(messages).toHaveLength(1);

    // Day 13: the summary is a week old: a new one supersedes it (one active).
    jest.setSystemTime(at(13));
    await runLearningLoop(A, deps, at(13));
    const active = (await store.listFacts(A, ["active"])).filter((f) => f.source.ref === WHAT_WORKS_REF);
    expect(active).toHaveLength(1);
    expect(active[0].date).toBe("2026-09-14");
  });

  describe("L5b auto \"posted\" mark (CONTENT_READY_QUEUE)", () => {
    const savedQ = process.env.CONTENT_READY_QUEUE;
    const savedK = process.env.AGENT_POST_KITS;
    beforeEach(() => { process.env.AGENT_LEARNING_LOOP = "true"; process.env.AGENT_POST_KITS = "true"; process.env.CONTENT_READY_QUEUE = "true"; });
    afterEach(() => {
      if (savedQ === undefined) delete process.env.CONTENT_READY_QUEUE; else process.env.CONTENT_READY_QUEUE = savedQ;
      if (savedK === undefined) delete process.env.AGENT_POST_KITS; else process.env.AGENT_POST_KITS = savedK;
    });
    /** A ready kit (made, guarded, with media) built at day `builtDay`; tapped "Post it" at `approvedDay` when given. */
    const kitDetail = (dueOn: string, o: { builtDay?: number; approvedDay?: number; guard?: boolean; resting?: boolean; format?: string } = {}) => ({
      ...postDetail(dueOn, o.format ?? "reel"),
      prepared: { studioItemId: null, postKit: {
        assets: [{ assetId: "a1" }], aiGenerationNeeded: { value: false }, builtAt: iso(o.builtDay ?? -5), idea: { format: o.format ?? "reel" },
        ...(o.guard === false ? {} : { guard: { version: 2, at: iso(-5), disclosure: null } }),
      } },
      ...(o.approvedDay != null ? { approval: { at: iso(o.approvedDay), assetIds: ["a1"], sponsored: null, wordsVersion: "rights/1" } } : {}),
      ...(o.resting ? { cardTap: { state: "not_now", at: iso(0), until: iso(30) } } : {}),
    });
    const insert = (s2: ReturnType<typeof setup>["store"], detail: Record<string, unknown>) =>
      s2.insertDecision(A, { runId: null, skillId: "plan", suggested: "Post", why: "w", evidence: [], kind: "action", detail });
    const reelOn = (day: number, id = "r", permalink?: string) => [...usual(6, { save_count: 10 }, -40), ...post(id, day, { save_count: 12 }, { readAfter: 1, ...(permalink ? { permalink } : {}) })];

    it("a time match marks a ready kit posted only when the post went up after the kit was built AND after Post it", async () => {
      const { store, deps } = setup(reelOn(3, "r", "https://www.instagram.com/reel/KIT1/"));
      const d = await insert(store, kitDetail("2026-09-04", { approvedDay: 2 }));
      jest.setSystemTime(at(7));
      expect(await runLearningLoop(A, deps, at(7))).toMatchObject({ linked: 1 });
      const w = (await store.getDecision(A, d.id))!;
      expect(w).toMatchObject({ response: "accepted", responseReason: "posted" });
      expect(w.detail).toMatchObject({ published: { entity_id: "r", via: "time", permalink: "https://www.instagram.com/reel/KIT1/" }, posted: { by: "learning", at: iso(3) } });
    });

    it("an unrelated reel on Thursday never closes Friday's kit they have not taken to post (measurement only)", async () => {
      // Day 3 is a Friday; the reel went up on day 2 (Thursday), the kit is due Friday and was never tapped "Post it".
      const { store, deps } = setup(reelOn(2));
      const d = await insert(store, kitDetail("2026-09-04"));
      jest.setSystemTime(at(7));
      expect(await runLearningLoop(A, deps, at(7))).toMatchObject({ linked: 1 });
      const w = (await store.getDecision(A, d.id))!;
      expect(w.response).toBe("pending");
      expect(w.detail).toMatchObject({ published: { entity_id: "r", via: "time" } });
      expect(w.detail!.posted).toBeUndefined();
    });

    it("never when the post went up before Post it, or before the kit was built", async () => {
      const before = setup(reelOn(2));
      const d1 = await insert(before.store, kitDetail("2026-09-04", { approvedDay: 2.5 }));
      jest.setSystemTime(at(7));
      await runLearningLoop(A, before.deps, at(7));
      expect((await before.store.getDecision(A, d1.id))!.response).toBe("pending");
      const older = setup(reelOn(2));
      const d2 = await insert(older.store, kitDetail("2026-09-04", { builtDay: 2.5, approvedDay: 2.6 }));
      await runLearningLoop(A, older.deps, at(7));
      expect((await older.store.getDecision(A, d2.id))!.response).toBe("pending");
    });

    it("never a kit that is not ready (before the guard) or is resting (Not now)", async () => {
      for (const o of [{ guard: false }, { resting: true }]) {
        const { store, deps } = setup(reelOn(3));
        const d = await insert(store, kitDetail("2026-09-04", { approvedDay: 1, ...o }));
        jest.setSystemTime(at(7));
        await runLearningLoop(A, deps, at(7));
        const w = (await store.getDecision(A, d.id))!;
        expect(w.response).toBe("pending");
        expect(w.detail!.posted).toBeUndefined();
      }
    });

    it("by the link they pasted: an answered kit is linked to that post, its answer kept", async () => {
      const obs = [...usual(6, { save_count: 10 }, -40), ...post("tappedpost", 5, { save_count: 12 }, { readAfter: 1, format: "carousel", permalink: "https://www.instagram.com/p/TAP2/" })];
      const { store, deps } = setup(obs);
      const t = await insert(store, { ...kitDetail("2026-08-20", { format: "carousel" }), posted: { at: iso(5), link: "https://instagram.com/p/TAP2", by: "athlete" } });
      await store.updateDecision(A, t.id, { response: "accepted", responseReason: "posted" });
      jest.setSystemTime(at(7));
      expect(await runLearningLoop(A, deps, at(7))).toMatchObject({ linked: 1 });
      expect((await store.getDecision(A, t.id))!.detail).toMatchObject({ published: { entity_id: "tappedpost", via: "link" }, posted: { by: "athlete", link: "https://instagram.com/p/TAP2" } });
    });

    it("CONTENT_READY_QUEUE off: nothing is marked posted and nothing links by link (the loop as it was)", async () => {
      delete process.env.CONTENT_READY_QUEUE;
      const { store, deps } = setup(reelOn(3, "r", "https://www.instagram.com/reel/KIT1/"));
      const d = await insert(store, kitDetail("2026-09-04", { approvedDay: 2 }));
      jest.setSystemTime(at(7));
      expect(await runLearningLoop(A, deps, at(7))).toMatchObject({ linked: 1 });
      const w = (await store.getDecision(A, d.id))!;
      expect(w.response).toBe("pending");
      expect(w.detail!.posted).toBeUndefined();
      expect((w.detail as any).published.permalink).toBeUndefined();
    });
  });

  it("an unlinked post (no plan action at all) is still measured: it gets the message and counts in the summary", async () => {
    process.env.AGENT_LEARNING_LOOP = "true";
    const obs = [...usual(6, { save_count: 10 }, -40), ...post("own", 3, { save_count: 50 }, { format: "carousel", readAfter: 2 })];
    const { store, deps, messages, outcomes } = setup(obs);
    jest.setSystemTime(at(6));
    const r = await runLearningLoop(A, deps, at(6));
    expect(r).toMatchObject({ linked: 0, judged: 0 });
    expect(outcomes).toEqual([]);
    expect(messages).toEqual([[A, "Your Instagram carousel from Friday got 5× your usual saves. Want another like it this week?"]]);
    expect((await store.listDecisions(A, { skillId: "learning" }))[0].detail).toMatchObject({ entityId: "own" });
    expect((await whatWorksFrom(deps, A, at(11))).lines.find((l) => l.key === "instagram/carousel")).toMatchObject({ n: 1, metrics: { save_count: { ratio: 5 } } });
  });

  it("MILA_WELCOME on: the \"post took off\" message only after the athlete's yes; measuring and the summary still run", async () => {
    process.env.AGENT_LEARNING_LOOP = "true";
    const savedWelcome = process.env.MILA_WELCOME;
    process.env.MILA_WELCOME = "true";
    try {
      const obs = [...usual(6, { save_count: 10 }, -40), ...post("own", 3, { save_count: 50 }, { readAfter: 2 })];
      jest.setSystemTime(at(6));
      mockIsAllowed.mockResolvedValue({ allowed: false, reason: "unset" });
      const no = setup(obs);
      expect(await runLearningLoop(A, no.deps, at(6))).toMatchObject({ ran: true, summaryWritten: true, messaged: null });
      expect(no.messages).toEqual([]);
      expect(no.pushes).toEqual([]);
      expect(mockIsAllowed).toHaveBeenLastCalledWith(A, "post_took_off", null, "message_post_took_off");

      mockIsAllowed.mockResolvedValue({ allowed: true, reason: "enabled" });
      const yes = setup(obs);
      expect((await runLearningLoop(A, yes.deps, at(6))).messaged).not.toBeNull();
      expect(yes.messages).toHaveLength(1);
    } finally {
      if (savedWelcome === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = savedWelcome;
    }
  });

  it("whatWorksFrom: the athlete's lines, with the linked action's pillar", async () => {
    process.env.AGENT_LEARNING_LOOP = "true";
    const obs = [...usual(6, { save_count: 10 }, -40), ...post("mine", 3, { save_count: 20 }, { readAfter: 7 })];
    const { store, deps } = setup(obs);
    await store.insertDecision(A, { runId: null, skillId: "plan", suggested: "Post", why: "w", evidence: [], kind: "action", detail: postDetail("2026-09-04") });
    jest.setSystemTime(at(11));
    await runLearningLoop(A, deps, at(11));
    const w = await whatWorksFrom(deps, A, at(11));
    expect(w.posts).toBe(7);
    expect(w.lines.find((l) => l.dimension === "pillar")).toMatchObject({ label: "Game days", n: 1, leads: false });
  });
});

// ─── L6 time zone ────────────────────────────────────────────────────────────────────────────────────────────────

describe("L6 the athlete's time zone", () => {
  // 2026-09-05 02:00 UTC is Saturday in UTC and Friday 19:00 in Los Angeles.
  const SAT_UTC = "2026-09-05T02:00:00.000Z";

  it("localDay: the athlete's zone, UTC without one or with an unknown zone", () => {
    expect(localDay(SAT_UTC, LA)).toEqual({ date: "2026-09-04", weekday: 5 });
    expect(localDay(SAT_UTC, null)).toEqual({ date: "2026-09-05", weekday: 6 });
    expect(localDay(SAT_UTC, "Not/AZone")).toEqual({ date: "2026-09-05", weekday: 6 });
  });

  it("day of week in the summary and \"from Friday\" in the message use the zone", () => {
    const NOW = new Date("2026-09-20T12:00:00.000Z");
    const obs: ContentObservation[] = [
      { athleteId: A, platform: "instagram", entityId: "late", entityTime: SAT_UTC, entityFormat: "reel", metricKey: "reach", value: 10, observedAt: "2026-09-12T02:00:00.000Z" },
    ];
    const posts = groupPosts(A, obs);
    expect(summarise(A, posts, new Map(), NOW, LA).lines.find((l) => l.dimension === "weekday")).toMatchObject({ label: "Posted on Friday" });
    expect(summarise(A, posts, new Map(), NOW, null).lines.find((l) => l.dimension === "weekday")).toMatchObject({ label: "Posted on Saturday" });
    const e = { post: posts[0], metric: "save_count" as const, ratio: 3.2, value: 32, usual: 10 };
    expect(EXCEPTIONAL_COPY.message(e, LA)).toBe("Your Instagram reel from Friday got 3.2× your usual saves. Want another like it this week?");
    expect(EXCEPTIONAL_COPY.message(e, null)).toContain("from Saturday");
  });

  it("the due-date window counts the post's day in the zone", () => {
    // 2026-09-08 02:00 UTC = 7 Sep in Los Angeles: 3 days after a 4 Sep due date there, 4 days in UTC.
    const posts = groupPosts(A, [{ athleteId: A, platform: "instagram", entityId: "p", entityTime: "2026-09-08T02:00:00.000Z", entityFormat: "reel", metricKey: "reach", value: 1, observedAt: "2026-09-09T00:00:00.000Z" }]);
    expect(linkPosts(A, posts, [action("a", { dueOn: "2026-09-04" })], LA).map((l) => l.actionId)).toEqual(["a"]);
    expect(linkPosts(A, posts, [action("a", { dueOn: "2026-09-04" })], null)).toEqual([]);
  });
});

// ─── L7 the flag in the yamls ────────────────────────────────────────────────────────────────────────────────────

describe("L7 AGENT_LEARNING_LOOP in the Cloud Run yamls", () => {
  const envOf = (file: string) =>
    (parse(readFileSync(join(__dirname, "..", "..", "..", "gcp", file), "utf8")).spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>);
  it("dev and prod (stage 1, owner 25 Oct 2026): \"true\", exactly once", () => {
    expect(envOf("cloud-run-dev.yaml").filter((e) => e.name === "AGENT_LEARNING_LOOP")).toEqual([{ name: "AGENT_LEARNING_LOOP", value: "true" }]);
    expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "AGENT_LEARNING_LOOP")).toEqual([{ name: "AGENT_LEARNING_LOOP", value: "true" }]);
  });
});
