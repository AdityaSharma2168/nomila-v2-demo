/**
 * discovery.parity.test.ts — the three public-discovery callers, pinned on recorded-shape provider responses.
 *
 * Instagram Business Discovery and the YouTube Data API were called from three places (the substrate keeper in
 * lib/integrations/discovery.ts, the legacy lib/platformDiscovery.ts fetchers and the dormant M.I.A. copy in
 * marketabilityBeta1SocialBlock.ts). They now share one client. This suite is the parity proof: the snapshot file was
 * written by the PRE-consolidation code and the consolidated code must reproduce it byte for byte, for every caller:
 *   - what each caller returns (keeper DiscoveryFetch, legacy SnapshotSocial, M.I.A. accounts + candidates),
 *   - the M.I.A. rendered block and its evaluator digest (snapshotDigest), so the M.I.A. digest cannot move,
 *   - the requests each caller sends (path + params, credentials stripped), so no provider sees a different call.
 *
 * NO PROVIDER IS EVER REACHED: global fetch is replaced by a router over the fixtures below and throws on any host it
 * does not know.
 */

jest.mock("../../db", () => ({ db: {} }));

// Credentials must exist before the legacy module reads them at load time; they are fakes and never leave this file.
process.env.DISCOVERY_IG_TOKEN = "test-ig-token";
process.env.DISCOVERY_IG_BUSINESS_ID = "17840000000000000";
process.env.YOUTUBE_DATA_API_KEY = "test-yt-key";

/* eslint-disable @typescript-eslint/no-var-requires */
const keeper = require("./discovery") as typeof import("./discovery");
const legacy = require("../platformDiscovery") as typeof import("../platformDiscovery");
const mia = require("../../services/marketabilityBeta1SocialBlock") as typeof import("../../services/marketabilityBeta1SocialBlock");
const miaSnapshot = require("../../services/marketabilityBeta1Snapshot") as typeof import("../../services/marketabilityBeta1Snapshot");

const NOW = new Date("2026-09-15T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 864e5).toISOString().replace(".000Z", "+0000");

type Reply = { status: number; body: unknown } | "network" | "unparseable";

// ─── Recorded-shape fixtures ────────────────────────────────────────────────────────────────────────────────────────

const graphError = (status: number, error: Record<string, unknown>): Reply => ({ status, body: { error: { type: "OAuthException", fbtrace_id: "Afake", ...error } } });

const igBusiness = (name: string | null): Reply => ({
  status: 200,
  body: {
    business_discovery: {
      id: "17841400000000001", username: "jordan.example", ...(name == null ? {} : { name }),
      biography: "Athlete.", website: "https://example.com", followers_count: 12_480, follows_count: 512, media_count: 318,
      media: { data: [
        { id: "m1", like_count: 640, comments_count: 31, timestamp: daysAgo(2), media_type: "IMAGE", media_product_type: "FEED" },
        { id: "m2", like_count: 1_210, comments_count: 58, timestamp: daysAgo(9), media_type: "VIDEO", media_product_type: "REELS" },
        { id: "m3", like_count: 402, comments_count: 12, timestamp: daysAgo(21), media_type: "CAROUSEL_ALBUM", media_product_type: "FEED" },
        { id: "m4", like_count: 515, comments_count: 20, timestamp: daysAgo(44), media_type: "IMAGE", media_product_type: "FEED" },
        { id: "m5", comments_count: 4, timestamp: daysAgo(60), media_type: "IMAGE", media_product_type: "FEED" }, // like count hidden
      ], paging: { cursors: { after: "QVFIUfake" } } },
    },
    id: "17840000000000000",
  },
});

const IG_CASES: Record<string, (fields: string) => Reply> = {
  business_account:       () => igBusiness("Jordan Example"),
  name_does_not_match:    () => igBusiness("Someone Else"),
  no_profile_name:        () => igBusiness(null),
  not_business_account:   () => graphError(400, { message: "Invalid user id", code: 110, error_subcode: 2207013, error_user_title: "Cannot find User", error_user_msg: "The user with username: jordan.example cannot be found." }),
  not_found:              () => ({ status: 200, body: { id: "17840000000000000" } }),
  rate_limited:           () => graphError(400, { message: "(#4) Application request limit reached", code: 4, is_transient: true }),
  token_expired:          () => graphError(400, { message: "Error validating access token: Session has expired on Tuesday, 15-Sep-26 04:00:00 PDT.", code: 190, error_subcode: 463 }),
  // media nested field refused, profile-only request succeeds (the legacy fetcher retries; the others do not)
  media_permission_error: (fields) => fields.includes("media.limit")
    ? graphError(400, { message: "(#10) Application does not have permission for this action", code: 10 })
    : { status: 200, body: { business_discovery: { id: "17841400000000001", username: "jordan.example", website: "https://example.com", followers_count: 12_480, media_count: 318 }, id: "17840000000000000" } },
  network_error:          () => "network",
  unparseable_response:   () => "unparseable",
};

const channel = (statistics: Record<string, unknown>, id = "UCabcdefghijklmnopqrstuv"): Reply => ({
  status: 200,
  body: { kind: "youtube#channelListResponse", etag: "e", pageInfo: { totalResults: 1, resultsPerPage: 5 }, items: [{
    kind: "youtube#channel", etag: "e", id,
    snippet: { title: "Jordan Example", description: "", customUrl: "@jordanexample", publishedAt: "2019-04-02T17:11:05Z" },
    contentDetails: { relatedPlaylists: { likes: "", uploads: "UUabcdefghijklmnopqrstuv" } },
    statistics,
  }] },
});
const VISIBLE = { viewCount: "1834220", subscriberCount: "8410", hiddenSubscriberCount: false, videoCount: "142" };
const playlistItems: Reply = { status: 200, body: { kind: "youtube#playlistItemListResponse", items: [
  { id: "p1", snippet: { publishedAt: daysAgo(3), title: "a", resourceId: { kind: "youtube#video", videoId: "vid1" } }, contentDetails: { videoId: "vid1", videoPublishedAt: daysAgo(3) } },
  { id: "p2", snippet: { publishedAt: daysAgo(12), title: "b", resourceId: { kind: "youtube#video", videoId: "vid2" } }, contentDetails: { videoId: "vid2", videoPublishedAt: daysAgo(12) } },
  { id: "p3", snippet: { publishedAt: daysAgo(40), title: "c", resourceId: { kind: "youtube#video", videoId: "vid3" } }, contentDetails: { videoId: "vid3", videoPublishedAt: daysAgo(40) } },
], pageInfo: { totalResults: 142, resultsPerPage: 10 } } };
const videos: Reply = { status: 200, body: { kind: "youtube#videoListResponse", items: [
  { id: "vid1", snippet: { publishedAt: daysAgo(3), title: "a" }, contentDetails: { duration: "PT45S" }, statistics: { viewCount: "5210", likeCount: "390", commentCount: "22" }, topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Sport", "https://en.wikipedia.org/wiki/Lifestyle_(sociology)"] } },
  { id: "vid2", snippet: { publishedAt: daysAgo(12), title: "b" }, contentDetails: { duration: "PT3M10S" }, statistics: { viewCount: "12004", likeCount: "811", commentCount: "64" }, topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Sport"] } },
  { id: "vid3", snippet: { publishedAt: daysAgo(40), title: "c" }, contentDetails: { duration: "PT1H2M3S" }, statistics: { viewCount: "2400", commentCount: "9" } }, // likes hidden
] } };
const ytError = (status: number, reason: string, message: string): Reply => ({ status, body: { error: { code: status, message, errors: [{ message, domain: "youtube.quota", reason }], status: status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT" } } });

interface YtCase { channels: Reply; playlistItems?: Reply; videos?: Reply; handle?: string }
const YT_CASES: Record<string, YtCase> = {
  visible_subscribers:          { channels: channel(VISIBLE), playlistItems, videos },
  hidden_subscribers_zero:      { channels: channel({ viewCount: "1834220", subscriberCount: "0", hiddenSubscriberCount: true, videoCount: "142" }), playlistItems, videos },
  hidden_subscribers_absent:    { channels: channel({ viewCount: "1834220", hiddenSubscriberCount: true, videoCount: "142" }), playlistItems, videos },
  channel_id_handle:            { channels: channel(VISIBLE), playlistItems, videos, handle: "UCabcdefghijklmnopqrstuv" },
  not_found:                    { channels: { status: 200, body: { kind: "youtube#channelListResponse", etag: "e", pageInfo: { totalResults: 0, resultsPerPage: 5 } } } },
  rate_limited:                 { channels: ytError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.") },
  token_expired:                { channels: ytError(400, "badRequest", "API key expired. Please renew the API key.") },
  uploads_playlist_fails:       { channels: channel(VISIBLE), playlistItems: ytError(404, "playlistNotFound", "The playlist identified with the request's playlistId parameter cannot be found."), videos },
  videos_fail:                  { channels: channel(VISIBLE), playlistItems, videos: ytError(403, "quotaExceeded", "quota") },
  network_error:                { channels: "network" },
  unparseable_response:         { channels: "unparseable" },
  uploads_network_error:        { channels: channel(VISIBLE), playlistItems: "network", videos },
};

// ─── The fetch router (the only "network" this suite has) ───────────────────────────────────────────────────────────

let igCase: (fields: string) => Reply = () => { throw new Error("no IG case selected"); };
let ytCase: YtCase = { channels: "network" };
let requests: string[] = [];

/** A request as the provider would see it, credentials removed so the snapshot never holds one. */
function describe_(u: URL): string {
  const params = [...u.searchParams.entries()].filter(([k]) => k !== "access_token" && k !== "key").map(([k, v]) => `${k}=${v}`).sort();
  const path = u.hostname === "graph.facebook.com" ? u.pathname.replace(/\/\d+$/, "/{biz}") : u.pathname;
  return `GET ${u.hostname}${path} ${params.join("&")}`;
}

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  (global as any).fetch = jest.fn(async (input: unknown) => {
    const u = new URL(String(input));
    requests.push(describe_(u));
    let r: Reply | undefined;
    if (u.hostname === "graph.facebook.com") r = igCase(u.searchParams.get("fields") ?? "");
    else if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/channels") r = ytCase.channels;
    else if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/playlistItems") r = ytCase.playlistItems;
    else if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/videos") r = ytCase.videos;
    if (!r) throw new Error(`unrouted request (a test must never reach a provider): ${u.hostname}${u.pathname}`);
    if (r === "network") throw new TypeError("fetch failed");
    const reply = r;
    const status = reply === "unparseable" ? 502 : reply.status;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => (reply === "unparseable" ? JSON.parse("<html>Bad Gateway</html>") : JSON.parse(JSON.stringify(reply.body))),
    } as unknown as Response;
  });
});
afterAll(() => jest.useRealTimers());
beforeEach(() => { requests = []; });

const athlete = { key: "test-athlete", name: "Jordan Example", sport: "Track and Field" };

/** Run a caller and capture either its value or the error it throws (a throw is behaviour too). */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T } | { threw: string }> {
  try { return { value: await fn() }; } catch (e: any) { return { threw: String(e?.message ?? e) }; }
}

async function miaRun(platform: "instagram" | "youtube", handle: string) {
  const rec = { athlete, accounts: [] as any[], unavailable: [] as any[], candidates: [] as any[], text: "" };
  const out = await capture(() => mia.discoveryBlock(athlete, [{ platform, handle }], rec));
  if ("value" in out) rec.accounts.push(...out.value);
  // Mirror buildEvidenceSnapshot: unresolved platforms are stated as unavailable, then the block is rendered + digested.
  for (const p of ["instagram", "youtube", "tiktok", "x"]) {
    if (!rec.accounts.some((x) => x.platform === p)) rec.unavailable.push({ platform: p, reason: p === "tiktok" || p === "x" ? "no authoritative route" : "no confidently resolved account" });
  }
  const text = mia.renderBlock(rec);
  return { result: out, candidates: rec.candidates, block: text, digest: miaSnapshot.snapshotDigest({ name: athlete.name, sport: athlete.sport, socialBlock: text }) };
}

describe("Instagram Business Discovery — every caller, every recorded response shape", () => {
  for (const [name, reply] of Object.entries(IG_CASES)) {
    test(name, async () => {
      igCase = reply;
      const handle = "@jordan.example";

      requests = [];
      const keeperOut = await capture(() => keeper.fetchInstagramDiscovery(handle));
      const keeperRequests = requests;

      requests = [];
      const legacyOut = await capture(() => legacy.runPlatformDiscovery({ instagram: handle }));
      const legacyRequests = requests;

      requests = [];
      const miaOut = await miaRun("instagram", "jordan.example");
      const miaRequests = requests;

      expect({ keeper: keeperOut, keeperRequests, legacy: legacyOut, legacyRequests, mia: miaOut, miaRequests }).toMatchSnapshot();
    });
  }
});

describe("YouTube Data API — every caller, every recorded response shape", () => {
  for (const [name, c] of Object.entries(YT_CASES)) {
    test(name, async () => {
      ytCase = c;
      const handle = c.handle ?? "@jordanexample";

      requests = [];
      const keeperOut = await capture(() => keeper.fetchYouTubeDiscovery(handle));
      const keeperRequests = requests;

      requests = [];
      const legacyOut = await capture(() => legacy.runPlatformDiscovery({ youtube: handle }));
      const legacyRequests = requests;

      requests = [];
      const miaOut = await miaRun("youtube", handle.replace(/^@/, ""));
      const miaRequests = requests;

      expect({ keeper: keeperOut, keeperRequests, legacy: legacyOut, legacyRequests, mia: miaOut, miaRequests }).toMatchSnapshot();
    });
  }
});

test("the hidden YouTube subscriber count stays 0 in the legacy output (the frozen legacy score reads it)", async () => {
  ytCase = YT_CASES.hidden_subscribers_zero;
  const out = await legacy.runPlatformDiscovery({ youtube: "@jordanexample" });
  expect(out?.youtube?.subscribers).toBe(0);
  expect(out?._computed?.total_followers).toBe(0);
});

test("the M.I.A. block omits a hidden subscriber count rather than stating 0", async () => {
  ytCase = YT_CASES.hidden_subscribers_zero;
  const out = await miaRun("youtube", "jordanexample");
  expect(out.block).not.toMatch(/subscribers:/);
  expect(out.block).toMatch(/total channel views: 1,834,220/);
});

describe("the one client's raw results", () => {
  const auth = { igBusinessId: "17840000000000000", token: "test-ig-token" };

  test("returns the profile name when the field set asks for it", async () => {
    igCase = IG_CASES.business_account;
    const call = await keeper.requestInstagramBusinessDiscovery("jordan.example", { auth, fields: keeper.IG_FIELDS.identity });
    expect(call.kind === "response" && call.name).toBe("Jordan Example");
    expect(call.kind === "response" && call.error).toBeNull();
  });

  test("classifies Graph errors and a missing node", async () => {
    for (const [c, want] of [["not_business_account", "not_business_account"], ["rate_limited", "rate_limited"], ["token_expired", "token_expired"], ["not_found", "not_found"]] as const) {
      igCase = IG_CASES[c];
      const call = await keeper.requestInstagramBusinessDiscovery("jordan.example", { auth, fields: keeper.IG_FIELDS.substrate });
      expect(call.kind === "response" && call.error).toBe(want);
    }
  });

  test("a hidden YouTube subscriber count is null, never 0", async () => {
    for (const c of ["hidden_subscribers_zero", "hidden_subscribers_absent"]) {
      ytCase = YT_CASES[c];
      const call = await keeper.requestYouTubeChannel("jordanexample", { key: "test-yt-key", part: "snippet,statistics" });
      expect(call.kind === "response" && call.hiddenSubscriberCount).toBe(true);
      expect(call.kind === "response" && call.subscribers).toBeNull();
    }
    ytCase = YT_CASES.visible_subscribers;
    const visible = await keeper.requestYouTubeChannel("jordanexample", { key: "test-yt-key", part: "snippet,statistics" });
    expect(visible.kind === "response" && visible.subscribers).toBe(8410);
  });

  test("never throws: transport and parse failures come back as values", async () => {
    igCase = IG_CASES.network_error;
    expect((await keeper.requestInstagramBusinessDiscovery("x", { auth, fields: keeper.IG_FIELDS.substrate })).kind).toBe("network");
    ytCase = YT_CASES.unparseable_response;
    expect((await keeper.requestYouTubeChannel("x", { key: "k", part: "snippet" })).kind).toBe("unparseable");
  });

  test("one Graph API version, and no other discovery code pins one", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    expect(keeper.GRAPH_API_VERSION).toMatch(/^v\d+\.0$/);
    for (const f of ["../platformDiscovery.ts", "../../services/marketabilityBeta1SocialBlock.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(src).not.toMatch(/graph\.facebook\.com|googleapis\.com|v\d+\.0/);
    }
  });
});
