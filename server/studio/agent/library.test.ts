/**
 * library.test.ts — the brief's sport and where it comes from, and the disagreement the log warns on.
 *
 * The assembly itself is held end to end by routes/studio.agent.test.ts (P2, P5, P5b). This holds
 * the three pure pieces beside it. library.ts reaches services/mediaSearch and lib/mediaEmbed at
 * load, so the three network-edge imports are stood in, as brands.test.ts does.
 *
 * ⚠️ MUTATIONS, red here by name: make `sportDisagreement` return 0 — "the share of her rows that
 * name another sport" reds; put the profile before the library's majority in `briefSport` — the
 * route's P5b reds; let a plurality through in `briefSport` ("sport tie silently resolves against
 * row") — "a tie never resolves by search order" reds; `sportDisagrees` strict (`>`) — "at exactly
 * one half — a tie" reds and the tie test with it. `db` is stood in with ONE query shape — the
 * athlete row `briefSport` reads when the library gives it no majority — set per test.
 */
const mockProfileRows: { sport: string | null }[] = [];
jest.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => mockProfileRows }),
      }),
    }),
  },
}));
jest.mock("../../logger", () => {
  const make = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
  return { createLogger: jest.fn(make) };
});
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(),
  cosine: jest.fn(),
}));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn() }));

import type { CastableRow } from "./cast";
import {
  briefSport,
  majoritySport,
  SPORT_DISAGREEMENT_WARN,
  sportDisagreement,
  sportDisagrees,
  sportOf,
} from "./library";

/** library.ts's own logger — by the module name it was created with, not the last one made. */
const libraryWarn = (): jest.Mock => {
  const { createLogger } = jest.requireMock("../../logger");
  const i = createLogger.mock.calls.findIndex(
    (c: unknown[]) => c[0] === "studio/agent/library",
  );
  return createLogger.mock.results[i].value.warn as jest.Mock;
};

const row = (description: string, setting = ""): CastableRow => ({
  id: description,
  athletePresent: true,
  gcsPath: null,
  videoPath: null,
  provenanceSignal: null,
  vision: { description, setting },
  provenance: "camera",
  platform: "upload",
  mediaType: "photo",
  durationSeconds: null,
  beats: [],
  editNote: null,
  identityBound: null,
  meta: false,
});

const soccer = (n: number) =>
  Array.from({ length: n }, (_, i) => row(`she strikes a soccer ball ${i}`));
const basketball = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    row(`she dribbles on the court ${i}`, "outdoor basketball court"),
  );

describe("sportOf / majoritySport", () => {
  it("reads the sport off description, setting or attire, and the majority is the sport most rows name", () => {
    expect(
      sportOf({ description: "a portrait", setting: "a basketball court" }),
    ).toBe("basketball");
    expect(
      sportOf({ description: "a portrait", attire: "soccer cleats" }),
    ).toBe("soccer");
    expect(sportOf({ description: "a portrait" })).toBeNull();
    expect(majoritySport([...soccer(3), ...basketball(1)])).toBe("soccer");
    expect(majoritySport([row("a portrait")])).toBeNull();
    expect(majoritySport([])).toBeNull();
  });
});

describe("briefSport — her sentence, else her library's majority; the source rides with it", () => {
  it("her sentence first, whatever the library shows", async () => {
    await expect(
      briefSport("x", "a basketball ad", soccer(5)),
    ).resolves.toEqual({
      sport: "basketball",
      source: "prompt",
      split: 0,
    });
  });

  it("then the library's majority — never the profile while the library has one (22 Sep 2026: a wrong row inverted the demotion)", async () => {
    await expect(
      briefSport("x", "a recap of this week", [...soccer(3), ...basketball(1)]),
    ).resolves.toEqual({ sport: "soccer", source: "library", split: 0.25 });
  });
});

describe("briefSport — a plurality is not a majority (23 Sep 2026: a 50/50 slice went to the search order, in silence)", () => {
  beforeEach(() => {
    mockProfileRows.length = 0;
    libraryWarn().mockClear();
  });

  it("a tie never resolves by search order: the athlete row decides, the split rides on the answer, and the log says so", async () => {
    mockProfileRows.push({ sport: "Women's Soccer" });
    // Basketball FIRST in the search order — the plurality's tie-break — and the row says soccer.
    await expect(
      briefSport("x", "a recap of this week", [...basketball(2), ...soccer(2)]),
    ).resolves.toEqual({ sport: "soccer", source: "profile", split: 0.5 });
    expect(libraryWarn()).toHaveBeenCalledTimes(1);
    expect(libraryWarn().mock.calls[0][0]).toMatchObject({
      plurality: "basketball",
      split: 0.5,
      named: 4,
      sport: "soccer",
      source: "profile",
    });
    expect(libraryWarn().mock.calls[0][1]).toMatch(
      /resolved to the athlete row/,
    );
  });

  it("a split the row cannot settle picks nothing — null, logged — never the first seen", async () => {
    await expect(
      briefSport("x", "a recap of this week", [
        ...basketball(2),
        ...soccer(1),
        row("she serves on the tennis court"),
      ]),
    ).resolves.toEqual({ sport: null, source: null, split: 0.5 });
    expect(libraryWarn()).toHaveBeenCalledTimes(1);
    expect(libraryWarn().mock.calls[0][1]).toMatch(/no sport picked/);
  });

  it("more than half IS a majority and still beats the row — 22 Sep's decision stands, and nothing is logged", async () => {
    mockProfileRows.push({ sport: "Basketball" });
    await expect(
      briefSport("x", "a recap of this week", [...soccer(3), ...basketball(2)]),
    ).resolves.toEqual({ sport: "soccer", source: "library", split: 0.4 });
    expect(libraryWarn()).not.toHaveBeenCalled();
  });

  it("at exactly one half — a tie — the share is a disagreement; just under it is not", () => {
    expect(sportDisagrees(SPORT_DISAGREEMENT_WARN)).toBe(true);
    expect(sportDisagrees(0.5)).toBe(true);
    expect(sportDisagrees(0.49)).toBe(false);
    expect(sportDisagrees(0)).toBe(false);
  });
});

describe("sportDisagreement — the share of her rows that name another sport", () => {
  it("counts only rows that name a sport; 0 with no brief sport; over one half is the warning", () => {
    const rows = [...soccer(3), ...basketball(1), row("a portrait")];
    expect(sportDisagreement(rows, "soccer")).toBe(0.25);
    expect(sportDisagreement(rows, "basketball")).toBe(0.75);
    expect(sportDisagreement(rows, null)).toBe(0);
    expect(sportDisagreement([row("a portrait")], "soccer")).toBe(0);
    expect(sportDisagreement(rows, "basketball")).toBeGreaterThan(
      SPORT_DISAGREEMENT_WARN,
    );
    expect(sportDisagreement(rows, "soccer")).toBeLessThan(
      SPORT_DISAGREEMENT_WARN,
    );
  });
});
