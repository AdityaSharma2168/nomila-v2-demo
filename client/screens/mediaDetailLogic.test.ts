/**
 * mediaDetailLogic.test.ts — "Analyzed" on MediaDetail (PR 9.5, F22 B4; R-5).
 * ⚠️ MUTATION "poster-only video shows Analyzed": key a video on `vision` — the first test reds by name.
 */
import { analyzedOf, analyzedPendingLabel } from "./mediaDetailLogic";

const poster = { athlete_present: true, description: "from the poster" };

describe("analyzedOf (P3)", () => {
  it("a poster-tagged VIDEO — vision present, no beats — is NOT analyzed — 'poster-only video shows Analyzed' reds here", () => {
    expect(analyzedOf({ isVideo: true, vision: poster })).toBe(false);
    expect(
      analyzedOf({ isVideo: true, vision: poster, read: { state: "unread" } }),
    ).toBe(false);
  });
  it("a VIDEO read as a clip is analyzed — beats array of any length, or the server's done", () => {
    expect(
      analyzedOf({ isVideo: true, vision: { ...poster, beats: [] } }),
    ).toBe(true);
    expect(
      analyzedOf({
        isVideo: true,
        vision: { ...poster, beats: [{ start_s: 0, end_s: 3 }] },
      }),
    ).toBe(true);
    expect(
      analyzedOf({ isVideo: true, vision: poster, read: { state: "done" } }),
    ).toBe(true);
  });
  it("an IMAGE with vision is analyzed, unchanged (R-5); without vision it is not", () => {
    expect(analyzedOf({ isVideo: false, vision: poster })).toBe(true);
    expect(analyzedOf({ isVideo: false, vision: null })).toBe(false);
  });
  it("the pending word: a video not being read says 'Not read yet', a running read says 'Analyzing…'", () => {
    expect(analyzedPendingLabel(true, null)).toBe("Not read yet");
    expect(analyzedPendingLabel(true, { state: "unread" })).toBe(
      "Not read yet",
    );
    expect(analyzedPendingLabel(true, { state: "reading" })).toBe("Analyzing…");
    expect(analyzedPendingLabel(false, null)).toBe("Analyzing…");
  });
});
