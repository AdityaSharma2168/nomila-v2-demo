import { mergeSocialSources, unionResearch, type ResearchLists } from "./researchMerge";

const connected = {
  instagram: { followers: 22177, engagement_rate: 4.84, posts_last_30d: 1, source: "connected" as const },
  tiktok:    { followers: 15539, engagement_rate: 11.97, posts_last_30d: 0, source: "connected" as const },
};
const discovery = {
  instagram: { followers: 21000, engagement_rate: 1.1, posts_last_30d: 3, source: "business_discovery" as const },
  youtube:   { subscribers: 40, followers: 40, engagement_rate: 0.5, posts_last_30d: 0, source: "data_api" as const },
};

test("connected platforms win; discovery only fills platforms the athlete has not connected", () => {
  const m = mergeSocialSources(connected as any, discovery as any)!;
  expect(m.instagram).toEqual(connected.instagram);            // not the weaker discovery read
  expect(m.tiktok).toEqual(connected.tiktok);
  expect(m.youtube).toEqual(discovery.youtube);                // filled from discovery
  expect(m._computed?.total_followers).toBe(22177 + 15539 + 40);
  expect(m._computed?.data_tier).toBe("discovery");            // mixed → the lower tier, honestly
  expect(mergeSocialSources(connected as any, null)!._computed?.data_tier).toBe("connected");
});

test("no connected accounts → discovery alone still scores; nothing at all → null", () => {
  const d = mergeSocialSources(null, discovery as any)!;
  expect(d.instagram).toEqual(discovery.instagram);
  expect(d._computed?.data_tier).toBe("discovery");
  expect(mergeSocialSources(null, null)).toBeNull();
  expect(mergeSocialSources({} as any, {} as any)).toBeNull();
});

const prior: Partial<ResearchLists> = {
  profile: { sport: "soccer", hometown: "Pittsburgh", position: null },
  social_handles: { instagram: "@rileyathlete", x: null },
  achievements: [{ name: "ACC Champion", year: "2025", level: "conference" }, { name: "All-American", year: "2024", level: "national" }],
  press_mentions: [{ outlet: "ESPN", headline: "Stanford opener" }],
  brand_deals: [{ brand: "adidas", type: "partnership", confidence: 0.6 }],
  nil_valuation_mentions: [{ source: "On3", value: "$120K" }],
  media_assets: { images: [{ url: "https://a/1.jpg" }], videos: [], audio: [] },
  story_arc: "Old arc.",
  sentiment: { positive: 30, negative: 0 },
};

const fresh: ResearchLists = {
  profile: { sport: "soccer", hometown: null, position: "Midfielder" },
  social_handles: { instagram: "@rileyathlete", x: "@mia_b" },
  achievements: [{ name: "acc champion", year: "2025", level: "conference" }, { name: "College Cup", year: "2025", level: "national" }],
  press_mentions: [{ outlet: "espn", headline: "Stanford Opener" }, { outlet: "The Athletic", headline: "Profile" }],
  brand_deals: [{ brand: "Adidas", type: "partnership", confidence: 0.9 }, { brand: "gorjana", type: "partnership", confidence: 0.8 }],
  nil_valuation_mentions: [],
  media_assets: { images: [{ url: "https://a/1.jpg" }, { url: "https://a/2.jpg" }], videos: [], audio: [] },
  story_arc: null,
  sentiment: null,
};

test("per list the richest single run wins (fresh on a tie); never a union across runs", () => {
  const u = unionResearch(prior, fresh);
  // achievements: prior 2 vs fresh 2 → tie → fresh. NOT the 3-item union.
  expect(u.achievements.map((a) => a.name)).toEqual(["acc champion", "College Cup"]);
  // press: prior 1 vs fresh 2 → fresh
  expect(u.press_mentions.map((p) => p.outlet)).toEqual(["espn", "The Athletic"]);
  // brands: prior 1 vs fresh 2 → fresh
  expect(u.brand_deals).toEqual([{ brand: "Adidas", type: "partnership", confidence: 0.9 }, { brand: "gorjana", type: "partnership", confidence: 0.8 }]);
  // NIL mentions: prior 1 vs fresh 0 → prior (a weak run does not erase what a better run found)
  expect(u.nil_valuation_mentions).toEqual([{ source: "On3", value: "$120K" }]);
  expect(u.media_assets.images).toHaveLength(2);
  expect(u.profile).toEqual({ sport: "soccer", hometown: "Pittsburgh", position: "Midfielder" });        // fresh fills, prior kept
  expect(u.social_handles).toEqual({ instagram: "@rileyathlete", x: "@mia_b" });
  expect(u.story_arc).toBe("Old arc.");                                                                 // fresh null → prior
  expect(u.sentiment).toEqual({ positive: 30, negative: 0 });
});

test("a run that found fewer achievements inherits the richer prior list; duplicates within a run collapse", () => {
  const weak = { ...fresh, achievements: [{ name: "ACC CHAMPION", year: "2025" }, { name: "acc champion", year: "2025" }] };
  const u = unionResearch(prior, weak);
  expect(u.achievements.map((a) => a.name)).toEqual(["ACC Champion", "All-American"]);   // prior's 2 beat the weak run's 1 (after dedupe)
  // Bounded: folding many priors never grows past the richest single run.
  const again = unionResearch(u, u);
  expect(again.achievements).toHaveLength(2);
});

test("no prior research → fresh unchanged", () => {
  expect(unionResearch(null, fresh)).toBe(fresh);
});
