/**
 * publicPlatform.test.ts — audience data and the M.I.A. (owner, 26 Oct 2026). Pure; no database, no provider
 * (confirmHandle's lookup is injected where it is exercised in the db suite; here only the pure parts).
 *
 *   P1 web-found audience numbers reach the scorer on the lean path as PUBLIC facts (public evidence to weigh and
 *      verify), never as authoritative data (the reversal of #1142's hold-back)
 *   P2 the handle she confirmed is her own said word (typed, corrected or confirmed), newest first
 *   P3 handles research found become "Is this you?" candidates; a confirmed one is not a candidate
 *   P4 a public API reading becomes a measured fact only for the confirmed handle and an unconnected platform
 *   P5 the block labels a public reading as the platform's API (never connected_verified); connected data wins
 *   P6 precedence in one block: connected > platform API (confirmed handle) > web-found, per platform
 */
jest.mock("../../db", () => ({ db: {} }));
import type { MemoryFact } from "../../../shared/agent";
import { candidateHandlesFrom, cleanHandle, confirmedHandlesFrom, publicMeasuredFactsFrom, PUBLIC_REF_PREFIX, type DiscoveryRow } from "./publicPlatform";
import {
  latestMeasuredPerMetric, measuredAccounts, measuredSourceClassOf, selectFactsOnlyInput, PUBLIC_PLATFORM_IDENTITY_BASIS, type PreviewFact,
} from "../../services/miaPreview/memoryAdapter";
import { factsOnlyInputFor } from "../../services/miaPreview/factsOnlyInMemory";
import { FACTS_HEADING } from "../../services/miaPreview/factsOnlySpec";

const AUTHORITATIVE = "AUTHORITATIVE SOCIAL DATA";
/** The block's public-facts section (FACTS NOMILA HOLDS … up to the authoritative section) and its authoritative section. */
const sections = (block: string) => {
  const at = block.indexOf(AUTHORITATIVE);
  return { publicPart: block.slice(block.indexOf(FACTS_HEADING), at), authoritative: block.slice(at) };
};

const NAME = "Riley Example";
let n = 0;
const preview = (o: Partial<PreviewFact>): PreviewFact => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, type: "found", status: "active", claim: "x", subjectKind: "athlete", subjectName: NAME,
  sourceUrl: "https://news.example.com/a", sourceRef: null, sourceTitle: null, observedOn: "2026-10-01", confidence: 0.9, sensitive: false, careKind: null,
  disputes: null, createdAt: "2026-10-01T00:00:00Z", topic: "stats", ...o,
});
const mem = (o: Partial<MemoryFact>): MemoryFact => ({
  id: `m${++n}`, athleteId: "a1", subject: { kind: "athlete", name: NAME }, claim: "x", type: "found", source: { url: "https://news.example.com/a" },
  date: "2026-10-01", confidence: 0.9, status: "active", supersededBy: null, runId: null, createdAt: "2026-10-01T00:00:00Z", ...o,
}) as MemoryFact;

describe("P1 web-found audience numbers go to the scorer as public facts (lean path)", () => {
  const web = [
    preview({ topic: "audience_growth", claim: "On3 reported 1.4 million social media followers for Riley Example." }),
    preview({ topic: "media", claim: "Riley Example has 3.5 million Instagram followers, according to ESPN." }),
    preview({ topic: "demographics", claim: "Most of Riley Example's audience is women aged 18 to 24." }),
  ];
  const stat = preview({ topic: "stats", claim: "Riley Example scored 12 goals in 2025." });

  test("selectFactsOnlyInput keeps them in the public facts, lean (balanced) or not; none is measured", () => {
    for (const balanced of [false, true]) {
      const s = selectFactsOnlyInput([...web, stat], NAME, { balanced });
      expect(s.public.map((f) => f.id).sort()).toEqual([...web, stat].map((f) => f.id).sort());
      expect(s.measured).toEqual([]);
    }
  });

  test("the lean in-memory scorer (leanRun): in the public-facts section, never in the authoritative section", () => {
    const { block, sources, summary } = factsOnlyInputFor({ name: NAME, facts: [...web, stat], handles: new Map(), balanced: true });
    const { publicPart, authoritative } = sections(block);
    for (const f of web) {
      expect(publicPart).toContain(f.claim);
      expect(authoritative).not.toContain(f.claim);
      expect(sources).toContainEqual(expect.objectContaining({ accountId: f.id, sourceClass: "web_researched" }));
    }
    expect(authoritative).toContain("No authoritative platform data is available");
    expect(summary).toMatchObject({ publicAboutHer: 4, publicSelected: 4, publicCut: 0, measured: 0, measuredPublic: 0 });
    expect(summary).not.toHaveProperty("webAudienceExcluded");
  });
});

describe("P2 the confirmed handle is her own said word", () => {
  test("typed at sign-up, then corrected/confirmed: the newest said fact wins; found facts never count", () => {
    const typed = mem({ type: "said", claim: "Riley Example's Instagram handle is @riley_old.", source: { ref: "onboarding/r1#handle:instagram" }, date: "2026-09-01" });
    const later = mem({ type: "said", claim: "Riley Example's Instagram handle is @riley.example.", source: { ref: "me/handles#handle:instagram" }, date: "2026-10-20" });
    const found = mem({ type: "found", claim: "Riley Example's YouTube handle is @rileyfound." });
    const yt = mem({ type: "said", claim: "Riley Example's YouTube handle is @RileyYT.", source: { ref: "onboarding/r1#handle:youtube" } });
    expect(confirmedHandlesFrom([typed, later, found, yt])).toEqual({ instagram: { handle: "riley.example", factId: later.id }, youtube: { handle: "RileyYT", factId: yt.id } });
    expect(confirmedHandlesFrom([{ ...typed, status: "superseded" } as MemoryFact])).toEqual({});
  });
  test("cleanHandle: @, profile URLs; junk refused", () => {
    expect(cleanHandle("@riley.example")).toBe("riley.example");
    expect(cleanHandle("https://www.instagram.com/riley.example/")).toBe("riley.example");
    expect(cleanHandle("https://www.youtube.com/@RileyYT")).toBe("RileyYT");
    expect(cleanHandle("riley example")).toBeNull();
  });
});

describe("P3 handles research found are candidates for 'Is this you?'", () => {
  test("from a profile link (source or claim) or an @handle beside the platform; post links are not profiles; confirmed ones drop out", () => {
    const facts = [
      mem({ claim: "Riley Example posts training clips on Instagram as @riley.example.", topic: "social" }),
      mem({ claim: "Her channel is youtube.com/@RileyYT.", topic: "social" }),
      mem({ claim: "A post went viral.", source: { url: "https://www.instagram.com/p/abc123/" } }),
      mem({ claim: "Riley Example's profile.", source: { url: "https://www.instagram.com/riley.example/" } }),
    ];
    const c = candidateHandlesFrom(facts, {}, [{ platform: "youtube", handle: "RileyYT", source: "social_identities/1" }]);
    expect(c.map((x) => `${x.platform}:${x.handle}:${x.sources.length}`)).toEqual(["instagram:riley.example:2", "youtube:RileyYT:2"]);
    expect(candidateHandlesFrom(facts, { instagram: { handle: "Riley.Example" } }).map((x) => x.platform)).toEqual(["youtube"]);
  });
});

describe("P4 public API readings become measured facts only for the confirmed handle", () => {
  const row = (o: Partial<DiscoveryRow>): DiscoveryRow => ({
    id: `s${++n}`, platform: "instagram", snapshot_day: "2026-10-25", followers: 12000, post_count: 300, avg_engagement_rate: "4.2", posts_last_30d: 9, total_channel_views: null,
    raw_metrics: { discovery: { platform: "instagram", username: "riley.example", source: "business_discovery" } }, ...o,
  });
  test("the latest row for the confirmed handle; labelled platform_public; dated by the row", () => {
    const old = row({ snapshot_day: "2026-10-01", followers: 11000 });
    const cur = row({});
    const facts = publicMeasuredFactsFrom([old, cur], { instagram: { handle: "Riley.Example" } }, new Set(), NAME);
    expect(facts.map((f) => f.source.ref)).toEqual([
      `${PUBLIC_REF_PREFIX}social_analytics_snapshots/${cur.id}#instagram.followers`,
      `${PUBLIC_REF_PREFIX}social_analytics_snapshots/${cur.id}#instagram.avg_engagement_rate`,
      `${PUBLIC_REF_PREFIX}social_analytics_snapshots/${cur.id}#instagram.posts_last_30d`,
      `${PUBLIC_REF_PREFIX}social_analytics_snapshots/${cur.id}#instagram.post_count`,
    ]);
    expect(facts[0]).toMatchObject({ type: "measured", date: "2026-10-25", claim: "Instagram (@Riley.Example) has 12,000 followers (public profile)." });
  });
  test("a row for another handle (entered or legacy), no confirmed handle, or a CONNECTED platform: nothing", () => {
    const other = row({ raw_metrics: { discovery: { username: "someone_else" } } });
    expect(publicMeasuredFactsFrom([other], { instagram: { handle: "riley.example" } }, new Set(), NAME)).toEqual([]);
    expect(publicMeasuredFactsFrom([row({})], {}, new Set(), NAME)).toEqual([]);
    expect(publicMeasuredFactsFrom([row({})], { instagram: { handle: "riley.example" } }, new Set(["instagram"]), NAME)).toEqual([]);
  });
});

describe("P5 the evidence block: public-platform label, connected data wins", () => {
  const pub = (metric: string, claim: string, platform = "instagram") => preview({ type: "measured", topic: null, sourceUrl: null, sourceRef: `${PUBLIC_REF_PREFIX}social_analytics_snapshots/s1#${platform}.${metric}`, claim });
  const conn = (metric: string, claim: string, platform = "instagram") => preview({ type: "measured", topic: null, sourceUrl: null, sourceRef: `social_analytics_snapshots/c1#${platform}.${metric}`, claim });
  test("a public-only platform is the platform's API source, never connected_verified", () => {
    const f = pub("followers", "Instagram (@riley.example) has 12,000 followers (public profile).");
    const y = pub("followers", "YouTube (@RileyYT) has 900 subscribers (public profile).", "youtube");
    const [ig, yt] = measuredAccounts([f, y].sort((a, b) => a.sourceRef!.localeCompare(b.sourceRef!)), new Map(), new Set()).map((m) => m.account);
    expect(ig).toMatchObject({ platform: "instagram", handle: "riley.example", source: "meta_business_discovery", identityBasis: PUBLIC_PLATFORM_IDENTITY_BASIS });
    expect(yt).toMatchObject({ platform: "youtube", handle: "RileyYT", source: "youtube_data_api" });
    expect(measuredSourceClassOf(f)).toBe("platform_public");
    expect(measuredSourceClassOf(conn("followers", "x"))).toBe("connected_verified");
  });
  test("a platform with a connected reading uses none of its public readings, even newer ones", () => {
    const c = conn("followers", "Instagram (@r) has 10,000 followers.");
    const p = { ...pub("followers", "Instagram (@r) has 12,000 followers (public profile)."), observedOn: "2026-10-30" };
    const p2 = pub("post_count", "Instagram (@r) has 300 posts in total.");
    expect(latestMeasuredPerMetric([c, p, p2]).map((f) => f.id)).toEqual([c.id]);
  });
});

describe("P6 precedence: connected > platform API (confirmed handle) > web-found", () => {
  const measured = (ref: string, claim: string, observedOn = "2026-10-25") => preview({ type: "measured", topic: null, sourceUrl: null, sourceRef: ref, claim, observedOn });
  const igConnected = measured("social_analytics_snapshots/c1#instagram.followers", "Instagram (@riley.connected) has 10,000 followers.", "2026-10-20");
  const igPublic = measured(`${PUBLIC_REF_PREFIX}social_analytics_snapshots/s1#instagram.followers`, "Instagram (@riley.example) has 12,000 followers (public profile).", "2026-10-25");
  const ytPublic = measured(`${PUBLIC_REF_PREFIX}social_analytics_snapshots/s2#youtube.followers`, "YouTube (@RileyYT) has 900 subscribers (public profile).");
  const igWeb = preview({ topic: "media", claim: "Riley Example has 3.5 million Instagram followers, according to ESPN." });
  const ytWeb = preview({ topic: "social", claim: "Riley Example has 50,000 YouTube subscribers, per a fan site." });

  test("authoritative block: connected for a connected platform, else the platform's API; web facts only in public facts", () => {
    const { block, sources } = factsOnlyInputFor({ name: NAME, facts: [igConnected, igPublic, ytPublic, igWeb, ytWeb], handles: new Map([["instagram", "riley.connected"]]), balanced: true });
    const { publicPart, authoritative } = sections(block);
    expect(authoritative).toContain(igConnected.claim);
    expect(authoritative).not.toContain("12,000");             // the public reading of a connected platform is not used, though newer
    expect(authoritative).toContain(ytPublic.claim);            // no connected YouTube: the YouTube Data API reading
    expect(authoritative).toContain("source: youtube data api");
    for (const w of [igWeb, ytWeb]) { expect(authoritative).not.toContain(w.claim); expect(publicPart).toContain(w.claim); }
    const cls = (id: string) => sources.find((x) => x.accountId === id)?.sourceClass;
    expect([cls(igConnected.id), cls(ytPublic.id), cls(igWeb.id), cls(igPublic.id)]).toEqual(["connected_verified", "platform_public", "web_researched", undefined]);
  });

  test("without a connected or confirmed-handle reading, a platform is not available in the authoritative block (web numbers never fill it)", () => {
    const { authoritative } = sections(factsOnlyInputFor({ name: NAME, facts: [igWeb, ytWeb], handles: new Map(), balanced: true }).block);
    expect(authoritative).toContain("No authoritative platform data is available");
    expect(authoritative).not.toMatch(/3\.5 million|50,000/);
  });
});
