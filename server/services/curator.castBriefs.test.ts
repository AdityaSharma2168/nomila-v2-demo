/**
 * castBriefs — each brand book photo slot cast from its own brief: strong match first, a decent one when nothing matches
 * strongly, a photo never used twice, and nothing (type-led) only when no photo passed the gates. searchMedia is mocked:
 * no database, no embedding call.
 */
jest.mock("./mediaSearch", () => ({ searchMedia: jest.fn(), listVisibleBrands: jest.fn(), brandNamesMatch: jest.fn() }));
jest.mock("./athleteContext", () => ({ getAthleteContext: jest.fn() }));
jest.mock("./shotList", () => ({ deriveShotList: jest.fn() }));
jest.mock("./frameText", () => ({ frameHasText: jest.fn() }));

import { searchMedia } from "./mediaSearch";
import { castBriefs, sameMoment } from "./curator";

// `sim` is the RAW brief match the tier is decided on (STRONG_SIM); simN (normalised) no longer decides it.
const hit = (id: string, sim: number, postedAt: string | null = null) => ({ id, sourceId: "", gcsPath: `p/${id}.jpg`, url: null, videoGcsPath: null, videoUrl: null, playable: false, views: 0, ageMonths: 1, tags: null, hero: 0.8, sim, score: 1, simN: 1, postedAt });

describe("castBriefs", () => {
  beforeEach(() => (searchMedia as jest.Mock).mockReset());

  it("takes a strong match over a better-scored decent one, never reuses a photo, and tiers each pick", async () => {
    (searchMedia as jest.Mock)
      .mockResolvedValueOnce([hit("a", 0.03), hit("b", 0.15)])  // cover: b is the strong match
      .mockResolvedValueOnce([hit("b", 0.16), hit("c", 0.05)])  // pillar: b is used → c, decent
      .mockResolvedValueOnce([]);                                // story: nothing passed the gates
    const out = await castBriefs("ath", [{ key: "cover", query: "q", needFace: true }, { key: "pillar.0", query: "q" }, { key: "story", query: "q" }]);
    expect(out.cover).toMatchObject({ gcsPath: "p/b.jpg", tier: "strong" });
    expect(out["pillar.0"]).toMatchObject({ gcsPath: "p/c.jpg", tier: "decent" });
    expect(out.story).toBeNull();
  });

  it("calls the best of a weak set decent — the bar is absolute, not relative to the other candidates", async () => {
    (searchMedia as jest.Mock).mockResolvedValueOnce([hit("a", 0.06), hit("b", 0.04)]);
    const out = await castBriefs("ath", [{ key: "voice.2", query: "off the field" }]);
    expect(out["voice.2"]).toMatchObject({ gcsPath: "p/a.jpg", tier: "decent" });
  });

  it("asks the library for only her, clean, good-enough photos, carousel frames included", async () => {
    (searchMedia as jest.Mock).mockResolvedValue([]);
    await castBriefs("ath", [{ key: "cover", query: "hero portrait", needFace: true }], { avoidBrands: ["Acme"] });
    const [, opts] = (searchMedia as jest.Mock).mock.calls[0];
    expect(opts.brief).toBe("hero portrait");
    expect(opts.filters).toMatchObject({ onlyHer: true, noBurnedText: true, noPromo: true, includeFrames: true, needFace: true, excludeBrandSubject: ["Acme"] });
    expect(opts.filters.minQuality).toBeGreaterThan(0);
  });

  it("tells each later search which photos are already used, so a look-alike (a carousel frame of a used post) is avoided", async () => {
    (searchMedia as jest.Mock).mockResolvedValueOnce([hit("a", 0.9)]).mockResolvedValueOnce([hit("b", 0.9)]);
    await castBriefs("ath", [{ key: "cover", query: "q" }, { key: "story", query: "q" }]);
    expect((searchMedia as jest.Mock).mock.calls[1][1].avoidNear).toEqual(["a"]);
  });

  it("prefers a photo from a different moment over another frame of a moment already shown (same shoot or match)", async () => {
    (searchMedia as jest.Mock)
      .mockResolvedValueOnce([hit("a", 0.15, "2026-09-28T19:10:24Z")])                                          // pillar.0
      .mockResolvedValueOnce([hit("b", 0.16, "2026-09-28T19:10:43Z"), hit("c", 0.12, "2026-05-01T10:00:00Z")])  // close: b is a frame of a's moment
      .mockResolvedValueOnce([hit("d", 0.15, "2026-09-28T19:11:00Z")]);                                        // plan: only that moment left
    const out = await castBriefs("ath", [{ key: "pillar.0", query: "q" }, { key: "close", query: "q", role: "decor" }, { key: "plan", query: "q", role: "decor" }]);
    expect(out.close).toMatchObject({ gcsPath: "p/c.jpg", tier: "strong" });
    // Nothing from a new moment passed: the same moment is still better than a type-led page.
    expect(out.plan).toMatchObject({ gcsPath: "p/d.jpg" });
    expect(sameMoment("2026-09-28T19:40:00Z", [Date.parse("2026-09-28T19:10:24Z")])).toBe(true);
    expect(sameMoment("2026-09-28T20:00:00Z", [Date.parse("2026-09-28T19:10:24Z")])).toBe(false);
    expect(sameMoment(null, [Date.parse("2026-09-28T19:10:24Z")])).toBe(false);
  });

  it("casts key slots first with their best match; a decor slot listed earlier takes what is left", async () => {
    (searchMedia as jest.Mock).mockImplementation(async (_a: string, o: { brief: string; avoidNear: string[] }) =>
      [hit("best", 0.2, "2026-09-28T19:10:00Z"), hit("other", 0.1, "2026-01-01T10:00:00Z")].filter((h) => !o.avoidNear.includes(h.id)));
    const out = await castBriefs("ath", [{ key: "close", query: "close", role: "decor" }, { key: "pillar.0", query: "lead" }]);
    expect(out["pillar.0"]).toMatchObject({ gcsPath: "p/best.jpg" });
    expect(out.close).toMatchObject({ gcsPath: "p/other.jpg" });
    expect(Object.keys(out)).toEqual(["close", "pillar.0"]);
    (searchMedia as jest.Mock).mockReset();
  });

  it("decor first asks for photos that do not even resemble ones already cast, and falls back when that leaves none", async () => {
    (searchMedia as jest.Mock)
      .mockResolvedValueOnce([hit("a", 0.2)])          // pillar.0 (key)
      .mockResolvedValueOnce([])                       // close, strict look-alike bar: nothing
      .mockResolvedValueOnce([hit("b", 0.15)]);        // close, normal bar
    const out = await castBriefs("ath", [{ key: "pillar.0", query: "q" }, { key: "close", query: "q", role: "decor" }]);
    const calls = (searchMedia as jest.Mock).mock.calls;
    expect(calls[0][1].diversityThreshold).toBeUndefined();
    expect(calls[1][1].diversityThreshold).toBe(0.85);
    expect(calls[2][1].diversityThreshold).toBeUndefined();
    expect(out.close).toMatchObject({ gcsPath: "p/b.jpg" });
  });
});
