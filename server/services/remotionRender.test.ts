/**
 * remotionRender.test.ts — the motion renderer's contract: the props the brand book sends, the timeline math the
 * compositions use, the media-reference walk the service does, and when a Remotion engine counts as up. Pure: no render,
 * no network, no database.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
// The signer and the service are the provider boundary: both are faked, nothing reaches GCS or Cloud Run.
const mockSignedUrl = jest.fn(async (p: string, ttl: number) => `https://storage.googleapis.com/bucket/${p}?read&ttl=${ttl}`);
const mockSignedUploadUrl = jest.fn(async (p: string, ct: string, ttl: number) => `https://storage.googleapis.com/bucket/${p}?write&ct=${ct}&ttl=${ttl}`);
const mockRequest = jest.fn(async (_req: any) => ({ status: 200, data: { ok: true, durationSec: 12, ms: 900 } }));
jest.mock("../lib/mediaStore", () => ({
  readObject: async () => null, uploadLocalFile: async () => {},
  signedUrl: (p: string, ttl: number) => mockSignedUrl(p, ttl),
  signedUploadUrl: (p: string, ct: string, ttl: number) => mockSignedUploadUrl(p, ct, ttl),
}));
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn(() => ({ getIdTokenClient: async () => ({ request: (req: any) => mockRequest(req) }) })),
}));
import {
  GCS_REF, accentFrom, cardFrames, gcsRef, gcsRefsIn, lineSize, reelFrames, replaceRefs, REMOTION_FPS,
} from "../../shared/remotionProps";
import { reelProps, reelScenes, SCENE_SEC, CROSSFADE_SEC } from "./brandBook/reel";
import { inputPathAllowed, outputPathAllowed, remotionRenderUrl, renderOnRemotion, SIGNED_TTL_MS } from "./remotionRender";
import { ENTRY_ROUTES, routeUp } from "../studio/capabilityRoutes";
import { entryAvailable, liveCapabilityEnv } from "../studio/agent/capabilityBlock";
import { CAPABILITY_ENTRIES } from "../studio/agent/capabilityEntries";
import type { BrandBookData } from "../../shared/brandBook";

const line = (text: string) => ({ text, options: [text] });
const book: BrandBookData = {
  contract: "brand-book/2", version: 3, generatedAt: "2026-10-20T00:00:00Z", firstName: "Ana",
  pages: [
    { id: "cover", title: "The promise", lines: { line: line("You show up first.") }, facts: [], images: ["a/hero.jpg"] },
    { id: "big_idea", title: "The big idea", lines: { line: line("Hold the door.") }, facts: [], images: ["a/two.jpg"] },
    { id: "voice_look", title: "Your voice and look", lines: {}, facts: [], images: [], extra: { palette: ["#F5F5F5", "#1D4ED8"] } },
  ],
};

describe("brand book → Remotion props", () => {
  it("carries the same scenes as bucket references, her palette and the bed", () => {
    const p = reelProps(book, reelScenes(book), "studio/beds/x.m4a");
    expect(p.firstName).toBe("Ana");
    expect(p.scenes).toEqual([
      { image: "gcs:a/hero.jpg", kicker: "ANA", text: "You show up first." },
      { image: "gcs:a/two.jpg", kicker: "THE BIG IDEA", text: "Hold the door." },
    ]);
    expect(p.palette).toEqual(["#F5F5F5", "#1D4ED8"]);
    expect(p.music).toBe("gcs:studio/beds/x.m4a");
    expect([p.sceneSec, p.transitionSec]).toEqual([SCENE_SEC, CROSSFADE_SEC]);
    expect(p.outroSec).toBeGreaterThan(p.transitionSec);
  });

  it("sends silence when there is no bed and no palette when the book has no look page", () => {
    const bare = { ...book, pages: book.pages.filter((x) => x.id !== "voice_look") };
    const p = reelProps(bare, reelScenes(bare), null);
    expect(p.music).toBeNull();
    expect(p.palette).toEqual([]);
  });
});

describe("timeline math", () => {
  it("overlaps scenes by the transition and adds the outro", () => {
    const f = REMOTION_FPS;
    // 5 scenes of 3.2s, 0.5s joins (4 between scenes + 1 into the outro), a 2.2s outro.
    const frames = reelFrames({ scenes: new Array(5).fill({}), sceneSec: 3.2, transitionSec: 0.5, outroSec: 2.2 } as any);
    expect(frames).toBe(5 * Math.round(3.2 * f) + Math.round(2.2 * f) - 5 * Math.round(0.5 * f));
    expect(reelFrames({ scenes: [], sceneSec: 3, transitionSec: 0.5, outroSec: 2 } as any)).toBe(Math.round(2 * f));
    expect(cardFrames(2)).toBe(2 * f);
  });

  it("sets shorter lines bigger", () => {
    expect(lineSize("Short.")).toBeGreaterThan(lineSize("x".repeat(60)));
    expect(lineSize("x".repeat(60))).toBeGreaterThan(lineSize("x".repeat(100)));
  });

  it("takes a readable saturated accent from her palette, else the brand pink", () => {
    expect(accentFrom(["#F5F5F5", "#1D4ED8"])).toBe("#1D4ED8");
    expect(accentFrom(["#FFFFFF", "#111111", "#808080"])).toBe("#E84591");
    expect(accentFrom([])).toBe("#E84591");
    expect(accentFrom(["not a colour"])).toBe("#E84591");
    // The pitch behind her is not her colour.
    expect(accentFrom(["#7A9A2E", "#3B8C3A", "#B3122E"])).toBe("#B3122E");
  });
});

describe("media references", () => {
  it("finds every bucket reference once, in order, and swaps them for local addresses", () => {
    const props = { a: gcsRef("x/1.jpg"), list: [{ img: gcsRef("x/2.jpg") }, { img: gcsRef("x/1.jpg") }], plain: "hello", n: 3 };
    expect(gcsRefsIn(props)).toEqual(["gcs:x/1.jpg", "gcs:x/2.jpg"]);
    const swapped = replaceRefs(props, { "gcs:x/1.jpg": "http://localhost/a/0.jpg", "gcs:x/2.jpg": "http://localhost/a/1.jpg" });
    expect(swapped).toEqual({ a: "http://localhost/a/0.jpg", list: [{ img: "http://localhost/a/1.jpg" }, { img: "http://localhost/a/0.jpg" }], plain: "hello", n: 3 });
    expect(GCS_REF).toBe("gcs:");
  });
});

describe("when Remotion runs", () => {
  it("is on only with REMOTION_RENDER_URL", () => {
    expect(remotionRenderUrl({})).toBeNull();
    expect(remotionRenderUrl({ REMOTION_RENDER_URL: " https://render.example/ " })).toBe("https://render.example");
  });

  it("a Remotion engine is up with the renderer; other media engines still follow their lane", () => {
    expect(routeUp(ENTRY_ROUTES["card.title"], {})).toBe(false);
    expect(routeUp(ENTRY_ROUTES["card.title"], { REMOTION_RENDER_URL: "https://r" })).toBe(true);
    expect(routeUp(ENTRY_ROUTES["image.cutout"], { REMOTION_RENDER_URL: "https://r" })).toBe(false);
    expect(routeUp(ENTRY_ROUTES.caption, {})).toBe(true);
  });

  it("the title and countdown cards still need their own flag before a planner sees them", () => {
    const title = CAPABILITY_ENTRIES.find((e) => e.id === "card.title")!;
    expect(entryAvailable(title, "post_kit", liveCapabilityEnv({ REMOTION_RENDER_URL: "https://r" }))).toBe(false);
    expect(entryAvailable(title, "post_kit", liveCapabilityEnv({ REMOTION_RENDER_URL: "https://r", STUDIO_CAP_CARDS: "true" }))).toBe(true);
  });
});

describe("the render service gets signed URLs, never bucket access (B3)", () => {
  const A = "11111111-2222-3333-4444-555555555555";
  const env = process.env.REMOTION_RENDER_URL;
  beforeEach(() => { process.env.REMOTION_RENDER_URL = "https://render.example"; jest.clearAllMocks(); });
  afterAll(() => { if (env === undefined) delete process.env.REMOTION_RENDER_URL; else process.env.REMOTION_RENDER_URL = env; });

  const props = (image: string, music: string | null = "studio/tracks/status.m4a") =>
    reelProps(book, [{ image, kicker: "ANA", text: "You show up first." }], music);
  const out = { video: `athletes/${A}/studio/brand-book/v3-1/reel.mp4`, poster: `athletes/${A}/studio/brand-book/v3-1/poster.jpg` };

  it("reads only her prefix or the product's shared music / atmosphere; writes only her prefix", () => {
    expect(inputPathAllowed(`athletes/${A}/uploads/x.jpg`, A)).toBe(true);
    expect(inputPathAllowed("studio/tracks/free/x.m4a", A)).toBe(true);
    expect(inputPathAllowed("studio/beds/placeholder-loop.m4a", A)).toBe(true);
    expect(inputPathAllowed("atmosphere/shared/soccer/treated/abc.jpg", A)).toBe(true);
    expect(inputPathAllowed("athletes/someone-else/uploads/x.jpg", A)).toBe(false);
    expect(inputPathAllowed(`athletes/${A}/../other/x.jpg`, A)).toBe(false);
    expect(inputPathAllowed(`athletes/${A}x/uploads/x.jpg`, A)).toBe(false);
    expect(inputPathAllowed("studio/other/x.jpg", A)).toBe(false);
    expect(inputPathAllowed(`athletes/${A}/x.jpg`, "")).toBe(false);
    expect(outputPathAllowed(out.video, A)).toBe(true);
    expect(outputPathAllowed("studio/tracks/x.mp4", A)).toBe(false);
  });

  it("refuses a ref outside the athlete's prefix before anything is signed or sent", async () => {
    await expect(renderOnRemotion(A, "BrandBookReel", props("athletes/someone-else/uploads/x.jpg"), out)).rejects.toThrow(/outside this athlete/);
    await expect(renderOnRemotion(A, "BrandBookReel", props(`athletes/${A}/a.jpg`), { video: "athletes/other/reel.mp4" })).rejects.toThrow(/output outside/);
    expect(mockSignedUrl).not.toHaveBeenCalled();
    expect(mockSignedUploadUrl).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("swaps every ref for a 30-minute signed READ URL and sends fixed-type WRITE URLs for both outputs", async () => {
    const r = await renderOnRemotion(A, "BrandBookReel", props(`athletes/${A}/uploads/hero.jpg`), out);
    expect(r).toEqual({ video: out.video, poster: out.poster, durationSec: 12, ms: 900 });
    expect(mockSignedUrl.mock.calls).toEqual([[`athletes/${A}/uploads/hero.jpg`, SIGNED_TTL_MS], ["studio/tracks/status.m4a", SIGNED_TTL_MS]]);
    expect(SIGNED_TTL_MS).toBe(30 * 60_000);
    expect(mockSignedUploadUrl.mock.calls).toEqual([[out.video, "video/mp4", SIGNED_TTL_MS], [out.poster, "image/jpeg", SIGNED_TTL_MS]]);
    const sent = mockRequest.mock.calls[0][0].data;
    expect(JSON.stringify(sent.inputProps)).not.toContain("gcs:");
    expect(sent.inputProps.scenes[0].image).toBe(`https://storage.googleapis.com/bucket/athletes/${A}/uploads/hero.jpg?read&ttl=${SIGNED_TTL_MS}`);
    expect(sent.inputProps.music).toBe(`https://storage.googleapis.com/bucket/studio/tracks/status.m4a?read&ttl=${SIGNED_TTL_MS}`);
    expect(sent.output.videoPutUrl).toContain("ct=video/mp4");
    expect(sent.output.posterPutUrl).toContain("ct=image/jpeg");
  });

  it("normalisation cannot escape a prefix: dot segments, encoded or doubled slashes, backslashes, case", () => {
    for (const bad of [
      `athletes/${A}/%2e%2e/other/x.jpg`, `athletes/${A}%2Fx.jpg`, `athletes/${A}//x.jpg`, `/athletes/${A}/x.jpg`,
      `athletes\\${A}\\x.jpg`, `athletes/${A}/..`, `Athletes/${A}/x.jpg`, `athletes/${A}/x.jpg`.replace("athletes", "ATHLETES"),
      `studio/tracks/../../athletes/other/x.jpg`, `studio/tracksx/x.m4a`, `atmosphere/shared2/x.jpg`, ` athletes/${A}/x.jpg`,
    ]) expect([bad, inputPathAllowed(bad, A)]).toEqual([bad, false]);
    expect(inputPathAllowed(`athletes/${A}/x.jpg`, `${A}/../other`)).toBe(false);
    const B = "abcdef01-2222-3333-4444-555555555555";
    expect(inputPathAllowed(`athletes/${B.toUpperCase()}/x.jpg`, B)).toBe(false);
    expect(outputPathAllowed(`athletes/${A}//reel.mp4`, A)).toBe(false);
  });

  it("refuses a media prop that is not a ref, and any URL in the props, before anything is signed or sent", async () => {
    const withUrl = { ...props(`athletes/${A}/a.jpg`), firstName: "https:evil.example/x" };
    await expect(renderOnRemotion(A, "BrandBookReel", withUrl, out)).rejects.toThrow(/carry a URL/);
    const rawSlot = props(`athletes/${A}/a.jpg`);
    rawSlot.scenes[0].image = "/assets/other-job/0.jpg";
    await expect(renderOnRemotion(A, "BrandBookReel", rawSlot, out)).rejects.toThrow(/not a media-bucket ref/);
    await expect(renderOnRemotion(A, "TitleCard", { text: "Hi", background: "data:image/png;base64,AA", palette: [], seconds: 2 }, out))
      .rejects.toThrow(/not a media-bucket ref/);
    expect(mockSignedUrl).not.toHaveBeenCalled();
    expect(mockSignedUploadUrl).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("throws (so the caller falls back) when the service fails", async () => {
    mockRequest.mockResolvedValueOnce({ status: 500, data: { ok: false, error: "boom" } } as any);
    await expect(renderOnRemotion(A, "BrandBookReel", props(`athletes/${A}/a.jpg`, null), out)).rejects.toThrow(/render service 500: boom/);
  });
});
