/**
 * beatPoster.test.ts — a frame from inside a beat's window: grabbed once, cached in GCS, never a
 * refusal.
 *
 * ⚠️ MUTATION, red here by name: skip the `headObject` check (always grab) — "a second ask for the
 * same window grabs nothing" reds. Make a grab failure throw instead of returning null — "a grab
 * that fails returns null" reds.
 */
jest.mock("../../lib/mediaStore", () => ({
  headObject: jest.fn(),
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  uploadLocalFile: jest.fn(),
}));

import {
  beatPosterAt,
  beatPosterPath,
  beatPosterUrl,
  type BeatPosterStore,
} from "./beatPoster";

const ATH = "33333333-1111-4444-8555-666666666666";
const ASSET = "aaaaaaaa-1111-4444-8555-666666666666";

const store = (
  existing: Set<string>,
): BeatPosterStore & { uploads: string[] } => {
  const uploads: string[] = [];
  return {
    uploads,
    headObject: jest.fn(async (p: string) =>
      existing.has(p) ? { bytes: 1, contentType: "image/jpeg" } : null,
    ),
    signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
    uploadLocalFile: jest.fn(async (_local: string, p: string) => {
      uploads.push(p);
      existing.add(p);
    }),
  };
};

describe("beatPosterUrl", () => {
  const given = {
    athleteId: ATH,
    assetId: ASSET,
    videoPath: `athletes/${ATH}/uploads/clip.mp4`,
    window: { startSec: 9.5, endSec: 14.5 },
  };

  it("names the object by the window, to a tenth, and takes the frame at its midpoint", () => {
    expect(beatPosterPath(ATH, ASSET, { startSec: 9.5, endSec: 14.5 })).toBe(
      `athletes/${ATH}/studio/beats/${ASSET}/9.5-14.5.jpg`,
    );
    expect(beatPosterPath(ATH, ASSET, { startSec: 0, endSec: 9.5 })).toBe(
      `athletes/${ATH}/studio/beats/${ASSET}/0.0-9.5.jpg`,
    );
    expect(beatPosterAt({ startSec: 9.5, endSec: 14.5 })).toBe(12);
    expect(beatPosterAt({ startSec: 20.5, endSec: 30.5 })).toBe(25.5);
  });

  it("grabs from the SIGNED mp4 at the midpoint, uploads once, and signs; a second ask for the same window grabs nothing", async () => {
    const s = store(new Set());
    const grab = jest.fn<Promise<void>, [string, number, string]>(
      async () => undefined,
    );
    const url = await beatPosterUrl(given, { grab, store: s });
    const path = beatPosterPath(ATH, ASSET, given.window);
    expect(url).toBe(`https://signed.example/${path}`);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][0]).toBe(
      `https://signed.example/${given.videoPath}`,
    );
    expect(grab.mock.calls[0][1]).toBe(12);
    expect(s.uploads).toEqual([path]);

    const again = await beatPosterUrl(given, { grab, store: s });
    expect(again).toBe(url);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(s.uploads).toHaveLength(1);
  });

  it("a different window of the same clip is its own object", async () => {
    const s = store(new Set());
    const grab = jest.fn(async () => undefined);
    await beatPosterUrl(given, { grab, store: s });
    await beatPosterUrl(
      { ...given, window: { startSec: 14.5, endSec: 20.5 } },
      { grab, store: s },
    );
    expect(grab).toHaveBeenCalledTimes(2);
    expect(s.uploads).toHaveLength(2);
  });

  it("a grab that fails returns null — the clip's poster stands — and nothing is uploaded", async () => {
    const s = store(new Set());
    const grab = jest.fn(async () => {
      throw new Error("ffmpeg: no");
    });
    expect(await beatPosterUrl(given, { grab, store: s })).toBeNull();
    expect(s.uploads).toEqual([]);
  });

  it("an empty or inverted window is refused without a grab", async () => {
    const s = store(new Set());
    const grab = jest.fn(async () => undefined);
    expect(
      await beatPosterUrl(
        { ...given, window: { startSec: 5, endSec: 5 } },
        { grab, store: s },
      ),
    ).toBeNull();
    expect(grab).not.toHaveBeenCalled();
  });
});
