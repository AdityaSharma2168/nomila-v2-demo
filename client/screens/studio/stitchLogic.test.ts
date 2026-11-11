/**
 * stitchLogic.test.ts — the timeline builder's arithmetic, pure.
 *
 * Pipeline 1's thinking lives outside the screen precisely so it can be tested without a renderer,
 * the way every other *Logic file here is. The properties worth breaking:
 *
 *   1. A reorder can never leave a crossfade on position 0 — it has nothing to fade from, and the
 *      server refuses it by field. That state must be impossible rather than merely refused.
 *   2. Seconds are counted over POSITIONS and downloads over UNIQUE ASSETS, matching the server. An
 *      inverted count would refuse a legal timeline in the UI, and she would never learn she was
 *      allowed.
 *   3. Crossfades SHORTEN the output — the same accumulator plan.ts uses for the xfade offsets.
 *   4. The caps come off the wire, never a copy: a mirror that hardcodes them drifts silently.
 */
import {
  TIMELINE_ITEM_FIELDS,
  setClipMuted,
  soundOffsetAt,
  soundStartAfterDrag,
  setCaption,
  timelineSignature,
  addClip,
  clock,
  fineTuneTimeline,
  moveItem,
  normalize,
  removeAt,
  reorderTo,
  setBridgeRequested,
  setCrossfade,
  timelineRefusal,
  timelineTotals,
  toStitchBody,
  MIN_SEGMENT_SEC,
  playedSeconds,
  setTrim,
  splitAt,
  addStill,
  isStill,
  setStillSec,
  type ClipChoice,
  type StillChoice,
  type StitchLimits,
  type TimelineItem,
} from "./stitchLogic";
import { dropIndexFor, trackLayout, xAtTime } from "./timelineGeometry";

const clip = (
  assetId: string,
  durationSec: number | null = 8,
  durationPreciseSec: number | null = null,
): ClipChoice => ({
  assetId,
  videoUrl: `https://signed.test/${assetId}`,
  posterUrl: null,
  durationSec,
  durationPreciseSec,
  origin: "Uploaded",
});

const LIMITS: StitchLimits = {
  maxClips: 12,
  maxSourceBytes: 664 * 1024 * 1024,
  maxTimelineSeconds: 180,
  maxClipBytes: 200 * 1024 * 1024,
  minStillSec: 1,
  maxStillSec: 8,
  defaultStillSec: 2,
};

const build = (...ids: string[]): TimelineItem[] =>
  ids.reduce<TimelineItem[]>((list, id) => addClip(list, clip(id)), []);

// ─── 1. Building ────────────────────────────────────────────────────────────────────────────────

describe("building a timeline", () => {
  it("keys each position separately, so one clip may appear twice", () => {
    const items = build("a", "a");
    expect(items).toHaveLength(2);
    expect(items[0].assetId).toBe(items[1].assetId);
    expect(items[0].key).not.toBe(items[1].key); // the key is the POSITION, not the clip
  });

  it("removes by position, not by asset", () => {
    const items = removeAt(build("a", "b", "a"), 0);
    expect(items.map((i) => i.assetId)).toEqual(["b", "a"]);
  });

  it("moves a position, and does nothing at all when asked to move off the ends", () => {
    const items = build("a", "b", "c");
    expect(moveItem(items, 2, 0).map((i) => i.assetId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    // A no-op rather than a throw: the only caller is a button that should be disabled, and a
    // crash is a worse answer to a double-tap than nothing happening.
    expect(moveItem(items, 0, -1)).toBe(items);
    expect(moveItem(items, 5, 0)).toBe(items);
    expect(moveItem(items, 1, 1)).toBe(items);
  });
});

// ─── 2. The crossfade that cannot survive a reorder ─────────────────────────────────────────────

describe("fineTuneTimeline — the Board's stitched video, arriving on the timeline", () => {
  /**
   * ⚠️ MUTATION: hand over nothing (always null). This reds, and nothing else does.
   *
   * "Fine-tune in Video" lands with the video already on the timeline — with the length the server
   * measured, so the timeline's totals are right from the first frame.
   */
  it("puts the stitched video on an empty timeline, with its measured length", () => {
    const out = fineTuneTimeline(
      [],
      [clip("upload1"), clip("stitched", 20, 19.5)],
      "stitched",
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      assetId: "stitched",
      durationSec: 20,
      durationPreciseSec: 19.5,
    });
  });

  /**
   * ⚠️ MUTATION: answer an empty timeline (`[]`) instead of null while the list lacks the video. This
   * reds, and nothing else does.
   *
   * The caller takes any answer as done and forgets the handoff — so an early "nothing" would land
   * her on an empty timeline with the video she asked for never arriving.
   */
  it("waits for the clip list to hold it — never answers with an empty timeline instead", () => {
    expect(fineTuneTimeline([], undefined, "stitched")).toBeNull();
    expect(fineTuneTimeline([], [clip("upload1")], "stitched")).toBeNull();
  });

  /**
   * ⚠️ MUTATION: drop the empty-timeline guard. This reds, and nothing else does.
   */
  it("never replaces a timeline she has already started", () => {
    const hers = addClip([], clip("upload1"));
    expect(fineTuneTimeline(hers, [clip("stitched")], "stitched")).toBeNull();
  });
});

describe("crossfades", () => {
  it("refuses to sit on position 0, where there is nothing to fade from", () => {
    const items = setCrossfade(build("a", "b"), 0, 0.5);
    expect(items[0].crossfadeSec).toBeUndefined();
  });

  it("is STRIPPED when its clip is moved to the front", () => {
    // ⚠️ THE REVERT CHECK. Without `normalize` after a reorder, position 0 keeps a crossfade it
    // was moved into — an impossible state that reaches the server as a 400 on a field she cannot
    // see, for an action that looked like dragging a row.
    const faded = setCrossfade(build("a", "b"), 1, 0.5);
    expect(faded[1].crossfadeSec).toBe(0.5);

    const moved = normalize(moveItem(faded, 1, 0));
    expect(moved[0].assetId).toBe("b");
    expect(moved[0].crossfadeSec).toBeUndefined();
    expect("crossfadeSec" in moved[0]).toBe(false); // absent, not undefined-valued
  });

  it("clamps to the engine's maximum and clears on null", () => {
    const items = setCrossfade(build("a", "b"), 1, 99);
    expect(items[1].crossfadeSec).toBe(2);
    expect(setCrossfade(items, 1, null)[1].crossfadeSec).toBeUndefined();
    expect(setCrossfade(items, 1, 0)[1].crossfadeSec).toBeUndefined();
  });
});

// ─── 3. Totals ──────────────────────────────────────────────────────────────────────────────────

describe("timelineTotals", () => {
  it("counts seconds over POSITIONS and downloads over UNIQUE ASSETS", () => {
    // The same clip twice: two ffmpeg inputs and two spans of output, but ONE download. Getting
    // this backwards would refuse a legal timeline here while the server accepted it.
    const totals = timelineTotals(build("a", "a", "b"));
    expect(totals.clips).toBe(3);
    expect(totals.seconds).toBe(24);
    expect(totals.downloads).toBe(2);
  });

  it("SUBTRACTS crossfades, because a fade makes the output shorter", () => {
    const plain = timelineTotals(build("a", "b"));
    const faded = timelineTotals(setCrossfade(build("a", "b"), 1, 2));
    expect(plain.seconds).toBe(16);
    expect(faded.seconds).toBe(14);
  });

  it("counts an unknown duration as zero rather than a ceiling — and says why in the header", () => {
    // The one place this file deliberately disagrees with the server's posture. The server charges
    // an unknown at its ceiling because guessing low risks an OOM; this is a label under a picker,
    // and over-stating a length she can see is worse. The server still refuses at the door.
    expect(timelineTotals([...build("a"), ...build()]).seconds).toBe(8);
    const unknown = addClip([], clip("x", null));
    expect(timelineTotals(unknown).seconds).toBe(0);
  });

  it("never goes negative, however the fades are set", () => {
    const items = setCrossfade(addClip(build("a"), clip("b", 1)), 1, 2);
    expect(timelineTotals(items).seconds).toBeGreaterThanOrEqual(0);
  });
});

// ─── 4. The mirror ──────────────────────────────────────────────────────────────────────────────

describe("timelineRefusal", () => {
  it("asks for a clip before anything else", () => {
    expect(timelineRefusal([], LIMITS)).toMatch(/add a clip/i);
  });

  it("says nothing at all while the caps have not arrived — the server is the authority", () => {
    // ⚠️ A mirror that guessed while offline would be a SECOND source of truth. Silence is right:
    // the server re-checks every cap at the door and again at claim time regardless.
    expect(timelineRefusal(build("a"), null)).toBeNull();
  });

  it("names the one cap she hit, not all three", () => {
    const many = Array.from({ length: 13 }, (_, i) => `c${i}`);
    expect(timelineRefusal(build(...many), LIMITS)).toMatch(
      /13 clips.*most.*12/i,
    );

    const long = Array.from({ length: 12 }, (_, i) => `c${i}`).reduce<
      TimelineItem[]
    >((list, id) => addClip(list, clip(id, 20)), []);
    expect(timelineRefusal(long, LIMITS)).toMatch(/4:00.*longest.*3:00/i);
  });

  it("reads the caps off what it was GIVEN, so a moved cap moves the refusal", () => {
    // The drift check: if these were hardcoded here, halving the cap would change nothing.
    const halved = { ...LIMITS, maxClips: 2 };
    expect(timelineRefusal(build("a", "b", "c"), halved)).toMatch(
      /most we can join is 2/i,
    );
    expect(timelineRefusal(build("a", "b", "c"), LIMITS)).toBeNull();
  });
});

describe("clock", () => {
  it("reads the way the server's refusals do", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(8)).toBe("0:08");
    expect(clock(124)).toBe("2:04");
    expect(clock(180)).toBe("3:00");
    expect(clock(-5)).toBe("0:00");
  });
});

// ─── 5. The body ────────────────────────────────────────────────────────────────────────────────

describe("toStitchBody", () => {
  it("sends ids and a target NAME — never a url, a path or a resolution", () => {
    const body = toStitchBody(build("a", "b"), "portrait", null);
    expect(body).toEqual({
      clips: [{ assetId: "a" }, { assetId: "b" }],
      target: "portrait",
    });
    // The picker holds signed urls; none of them may travel. A path in a job row would be a
    // durable file-read primitive.
    expect(JSON.stringify(body)).not.toMatch(/https|signed|1080|libx264/);
  });

  it("omits a crossfade that is not set, and a bed that is not chosen", () => {
    const faded = setCrossfade(build("a", "b"), 1, 0.5);
    expect(toStitchBody(faded, "square", "placeholder")).toEqual({
      clips: [{ assetId: "a" }, { assetId: "b", crossfadeSec: 0.5 }],
      target: "square",
      bed: "placeholder",
    });
    // "No bed" has ONE representation — absent — so the server's parser never sees a null it has
    // to have an opinion about.
    expect("bed" in toStitchBody(faded, "square", null)).toBe(false);
  });

  it("carries no previewId, because a stitch is not a purchase", () => {
    expect(Object.keys(toStitchBody(build("a"), "portrait", null))).toEqual([
      "clips",
      "target",
    ]);
  });
});

describe("the totals mirror the server's two rungs, and only those two", () => {
  it("prefers the PRECISE duration over the integer", () => {
    // resolveClips charges `duration_seconds_precise ?? duration_seconds`. Charging 8 for a clip
    // that is really 8.033 errs in the direction that lets an over-long timeline look legal.
    const items = normalize(addClip([], clip("a", 8, 8.033)));
    expect(timelineTotals(items).seconds).toBeCloseTo(8.033, 9);
  });

  it("falls back to the integer when the row has not been probed", () => {
    expect(
      timelineTotals(normalize(addClip([], clip("a", 8, null)))).seconds,
    ).toBe(8);
  });

  it("still charges an unmeasured clip ZERO, not a placeholder", () => {
    // The one place this file deliberately disagrees with the server, and it is documented: a
    // label under a picker must not claim a length nobody knows.
    expect(
      timelineTotals(normalize(addClip([], clip("a", null, null)))).seconds,
    ).toBe(0);
  });
});

/** One clip, 10 seconds long and known to be. */
const one = () => normalize(addClip([], clip("a", 10, 10)));

describe("trimming a position", () => {
  it("sets the in-point from the start edge", () => {
    const out = setTrim(one(), 0, "start", 2.5, 10);
    expect(out[0].trimStartSec).toBe(2.5);
    expect(out[0].trimEndSec).toBeUndefined();
  });

  it("sets the out-point from the end edge", () => {
    const out = setTrim(one(), 0, "end", 7.5, 10);
    expect(out[0].trimEndSec).toBe(7.5);
    expect(out[0].trimStartSec).toBeUndefined();
  });

  it("⚠️ DELETES the field when an edge goes back to the source's own edge", () => {
    // "Absent means the whole clip" is the spec's one representation of untrimmed. Writing
    // trimStartSec: 0 would make it two, and every never-trimmed timeline would start sending
    // fields it did not send before.
    const trimmed = setTrim(setTrim(one(), 0, "start", 3, 10), 0, "end", 8, 10);
    expect(trimmed[0].trimStartSec).toBe(3);
    expect(trimmed[0].trimEndSec).toBe(8);

    const back = setTrim(setTrim(trimmed, 0, "start", 0, 10), 0, "end", 10, 10);
    expect(back[0].trimStartSec).toBeUndefined();
    expect(back[0].trimEndSec).toBeUndefined();
    expect(toStitchBody(back, "portrait", null)).toEqual(
      toStitchBody(one(), "portrait", null),
    );
  });

  it("⚠️ REFUSES a clip whose duration is unknown, rather than trusting the placeholder", () => {
    // The placeholder is three seconds and the clip might be sixty. Trimming against it would
    // write trimEndSec: 3 onto a minute of footage and throw the rest away.
    const unknown = normalize(addClip([], clip("a", null, null)));
    expect(setTrim(unknown, 0, "end", 2, 0)).toEqual(unknown);
    expect(setTrim(unknown, 0, "end", 2, NaN)).toEqual(unknown);
  });

  it("cannot invert the window — the end always stays STRICTLY after the start", () => {
    /*
     * ⚠️ ASSERTED AGAINST THE SERVER'S RULE, NOT AGAINST OUR OWN CONSTANT. parseStitchSpec refuses
     * `trimEndSec <= trimStartSec` by field, so that is the invariant. An earlier version of this
     * test compared against MIN_SEGMENT_SEC and so RELAXED IN LOCKSTEP when the constant was
     * mutated to 0 — it passed under its own revert check and proved nothing.
     */
    const dragged = setTrim(setTrim(one(), 0, "end", 4, 10), 0, "start", 9, 10);
    expect(dragged[0].trimEndSec!).toBeGreaterThan(dragged[0].trimStartSec!);
    expect(dragged[0].trimEndSec! - dragged[0].trimStartSec!).toBeGreaterThan(
      0,
    );

    const other = setTrim(setTrim(one(), 0, "start", 6, 10), 0, "end", 1, 10);
    expect(other[0].trimEndSec!).toBeGreaterThan(other[0].trimStartSec!);
  });

  it("keeps the two edges a usable distance apart, not merely distinct", () => {
    const out = setTrim(setTrim(one(), 0, "end", 4, 10), 0, "start", 9, 10);
    expect(out[0].trimEndSec! - out[0].trimStartSec!).toBeGreaterThanOrEqual(
      MIN_SEGMENT_SEC,
    );
  });

  it("⚠️ cannot trim PAST THE END of the source", () => {
    /*
     * Nothing on the server refuses this — it has no duration at parse time — so ffmpeg would be
     * asked for frames that do not exist.
     *
     * Asserted through what the clip PLAYS rather than through the field being absent: an
     * un-clamped 99 is dropped by the same "covers the whole source" rule that drops a legitimate
     * 10, so "trimEndSec is undefined" is true either way and catches nothing. With a start-point
     * set, the over-trim becomes visible.
     */
    const out = setTrim(setTrim(one(), 0, "start", 2, 10), 0, "end", 99, 10);
    expect(playedSeconds(out[0])).toBeLessThanOrEqual(10);
    expect(out[0].trimEndSec ?? 10).toBeLessThanOrEqual(10);

    const body = toStitchBody(out, "portrait", null) as {
      clips: { trimEndSec?: number }[];
    };
    expect(body.clips[0].trimEndSec ?? 10).toBeLessThanOrEqual(10);
  });

  it("cannot trim before the start of the source", () => {
    expect(setTrim(one(), 0, "start", -5, 10)[0].trimStartSec).toBeUndefined();
    const out = setTrim(setTrim(one(), 0, "end", 8, 10), 0, "start", -5, 10);
    expect(out[0].trimStartSec ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("leaves every other position alone", () => {
    const two = normalize(
      addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)),
    );
    const out = setTrim(two, 1, "start", 2, 6);
    expect(out[0]).toBe(two[0]);
    expect(out[1].trimStartSec).toBe(2);
  });

  it("is a no-op for an index that is not there", () => {
    const items = one();
    expect(setTrim(items, 5, "start", 1, 10)).toBe(items);
    expect(setTrim(items, -1, "start", 1, 10)).toBe(items);
  });
});

describe("what a trimmed timeline comes to", () => {
  it("⚠️ counts the TRIMMED span, not the clip's whole length", () => {
    // Charging a trimmed clip for footage it no longer plays would refuse timelines the server
    // accepts — and she would never find out she was allowed.
    const items = setTrim(
      setTrim(normalize(addClip([], clip("a", 10, 10))), 0, "start", 2, 10),
      0,
      "end",
      6,
      10,
    );
    expect(playedSeconds(items[0])).toBe(4);
    expect(timelineTotals(items).seconds).toBe(4);
  });

  it("still subtracts the crossfade from the trimmed spans", () => {
    const two = normalize(
      addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)),
    );
    const faded = setCrossfade(setTrim(two, 0, "end", 5, 10), 1, 1);
    // 5s + 6s, less a 1s fade.
    expect(timelineTotals(faded).seconds).toBe(10);
  });
});

describe("trim on the wire", () => {
  it("⚠️ reaches the body, which is the whole point of the handles", () => {
    const items = setTrim(
      setTrim(normalize(addClip([], clip("a", 10, 10))), 0, "start", 1.5, 10),
      0,
      "end",
      8.25,
      10,
    );
    expect(toStitchBody(items, "portrait", null)).toEqual({
      clips: [{ assetId: "a", trimStartSec: 1.5, trimEndSec: 8.25 }],
      target: "portrait",
    });
  });

  it("sends nothing extra for an untrimmed timeline", () => {
    expect(toStitchBody(one(), "portrait", null)).toEqual({
      clips: [{ assetId: "a" }],
      target: "portrait",
    });
  });
});

describe("splitting a position at the playhead", () => {
  it("⚠️ the two segments sum EXACTLY to what the original played", () => {
    // The totals are effective-duration based since checkpoint 4, so a split that re-inflated
    // would charge the cap twice for footage she still has once.
    const before = one();
    const played = playedSeconds(before[0]);

    const after = splitAt(before, 0, 3.5, 10);
    expect(after).toHaveLength(2);
    expect(playedSeconds(after[0]) + playedSeconds(after[1])).toBeCloseTo(
      played,
      9,
    );
  });

  it("⚠️ splits WITHIN an existing trim, not within the source", () => {
    // A clip trimmed to 2–6 cut at 4 becomes 2–4 and 4–6, never 0–4 and 4–8. Using track seconds
    // instead of source seconds is right only for the first untrimmed position on a timeline.
    const trimmed = setTrim(setTrim(one(), 0, "start", 2, 10), 0, "end", 6, 10);
    const after = splitAt(trimmed, 0, 4, 10);

    expect(after[0].trimStartSec).toBe(2);
    expect(after[0].trimEndSec).toBe(4);
    expect(after[1].trimStartSec).toBe(4);
    expect(after[1].trimEndSec).toBe(6);
    expect(playedSeconds(after[0]) + playedSeconds(after[1])).toBeCloseTo(4, 9);
  });

  it("gives both segments the SAME asset, which is what keeps the bytes flat", () => {
    // assertTimelineFits counts clips and seconds over POSITIONS but bytes over UNIQUE ASSETS.
    const after = splitAt(one(), 0, 4, 10);
    expect(after[0].assetId).toBe(after[1].assetId);
    expect(timelineTotals(after).downloads).toBe(1);
    expect(timelineTotals(after).clips).toBe(2);
  });

  it("costs one clip slot, and the totals do not double-count", () => {
    const before = one();
    const after = splitAt(before, 0, 4, 10);
    expect(timelineTotals(after).clips).toBe(timelineTotals(before).clips + 1);
    expect(timelineTotals(after).seconds).toBeCloseTo(
      timelineTotals(before).seconds,
      9,
    );
  });

  it("⚠️ the TAIL gets no crossfade, and the HEAD keeps it", () => {
    // The tail follows the head across what was one continuous shot a moment ago; a fade there
    // would invent a transition she never asked for.
    const two = normalize(
      addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)),
    );
    const faded = setCrossfade(two, 1, 1);
    const after = splitAt(faded, 1, 3, 6);

    expect(after[1].crossfadeSec).toBe(1);
    expect(after[2].crossfadeSec).toBeUndefined();
  });

  it("keeps the original's key on the head, so the selection survives the cut", () => {
    const before = one();
    const after = splitAt(before, 0, 4, 10);
    expect(after[0].key).toBe(before[0].key);
    expect(after[1].key).not.toBe(before[0].key);
  });

  it("⚠️ refuses a cut that would leave a sliver on either side", () => {
    // Not merely "non-positive": a 0.05s segment passes the server's parser and is not a clip.
    const items = one();
    expect(splitAt(items, 0, 0, 10)).toBe(items);
    expect(splitAt(items, 0, 10, 10)).toBe(items);
    expect(splitAt(items, 0, MIN_SEGMENT_SEC / 2, 10)).toBe(items);
    expect(splitAt(items, 0, 10 - MIN_SEGMENT_SEC / 2, 10)).toBe(items);
  });

  it("measures the sliver against the TRIMMED window, not the source", () => {
    // A cut at 2.05 is 0.05 into a clip trimmed to start at 2 — a sliver, even though it is two
    // seconds into the source.
    const trimmed = setTrim(one(), 0, "start", 2, 10);
    expect(splitAt(trimmed, 0, 2 + MIN_SEGMENT_SEC / 2, 10)).toBe(trimmed);
  });

  it("⚠️ refuses a clip whose duration is unknown", () => {
    // The playhead's position inside a placeholder-width clip is fiction — the same hazard
    // setTrim refuses, and the reason no trim handles render on one either.
    const unknown = normalize(addClip([], clip("a", null, null)));
    expect(splitAt(unknown, 0, 1, 0)).toBe(unknown);
    expect(splitAt(unknown, 0, 1, NaN)).toBe(unknown);
  });

  it("is a no-op for an index that is not there", () => {
    const items = one();
    expect(splitAt(items, 9, 4, 10)).toBe(items);
    expect(splitAt(items, -1, 4, 10)).toBe(items);
  });

  it("leaves every other position untouched, in order", () => {
    const two = normalize(
      addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)),
    );
    const after = splitAt(two, 0, 4, 10);
    expect(after.map((i) => i.assetId)).toEqual(["a", "a", "b"]);
    expect(after[2]).toBe(two[1]);
  });

  it("both segments reach the wire as two entries on one asset", () => {
    const after = splitAt(one(), 0, 4, 10);
    expect(toStitchBody(after, "portrait", null)).toEqual({
      clips: [
        { assetId: "a", trimEndSec: 4 },
        { assetId: "a", trimStartSec: 4 },
      ],
      target: "portrait",
    });
  });

  it("a segment can itself be split again", () => {
    // Manual segmentation is repeated cutting; nothing may depend on a clip being whole.
    const once = splitAt(one(), 0, 5, 10);
    const twice = splitAt(once, 1, 7, 10);
    expect(twice).toHaveLength(3);
    expect(twice.reduce((sum, i) => sum + playedSeconds(i), 0)).toBeCloseTo(
      10,
      9,
    );
  });
});

describe("reordering carries everything the position is", () => {
  const two = () =>
    normalize(addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)));

  it("⚠️ a trimmed clip keeps its trim after it is moved", () => {
    // The way this breaks is a reorder implemented by moving ASSET IDS rather than items — the
    // clips end up in the right order carrying the wrong windows.
    const trimmed = setTrim(setTrim(two(), 0, "start", 2, 10), 0, "end", 7, 10);
    const moved = normalize(moveItem(trimmed, 0, 1));

    expect(moved.map((i) => i.assetId)).toEqual(["b", "a"]);
    expect(moved[1].trimStartSec).toBe(2);
    expect(moved[1].trimEndSec).toBe(7);
    expect(playedSeconds(moved[1])).toBe(5);
  });

  it("⚠️ the totals do not change, because order is not length", () => {
    // Also the cheapest way to catch a splice that duplicates rather than moves: the array would
    // grow and the sum with it.
    const trimmed = setTrim(two(), 0, "end", 4, 10);
    const before = timelineTotals(trimmed);
    const after = timelineTotals(normalize(moveItem(trimmed, 0, 1)));

    expect(after.seconds).toBeCloseTo(before.seconds, 9);
    expect(after.clips).toBe(before.clips);
    expect(after.downloads).toBe(before.downloads);
  });

  it("⚠️ strips a crossfade that lands at the front", () => {
    // The rule the arrows already obeyed, and the one a drag must not be the path that forgets:
    // position 0 has nothing to fade FROM and the server refuses it by field.
    const faded = setCrossfade(two(), 1, 1);
    expect(faded[1].crossfadeSec).toBe(1);

    const moved = normalize(moveItem(faded, 1, 0));
    expect(moved[0].assetId).toBe("b");
    expect(moved[0].crossfadeSec).toBeUndefined();
  });

  it("keeps both halves of a split valid when they are dragged apart", () => {
    // Flagged decision: they are two independent positions that happen to share an asset and hold
    // adjacent windows. Separating them is a legal edit, not a broken one.
    const split = splitAt(normalize(addClip([], clip("a", 10, 10))), 0, 4, 10);
    const apart = normalize(moveItem([...split, ...two().slice(1)], 0, 2));

    expect(apart.map((i) => i.assetId)).toEqual(["a", "b", "a"]);
    const body = toStitchBody(apart, "portrait", null) as {
      clips: { assetId: string; trimStartSec?: number; trimEndSec?: number }[];
    };
    // Same asset twice, non-overlapping windows, in whatever order she put them.
    expect(body.clips[0].trimStartSec).toBe(4);
    expect(body.clips[2].trimEndSec).toBe(4);
  });
});

describe("the one reorder path, reached two ways", () => {
  const three = () =>
    normalize(
      addClip(
        addClip(addClip([], clip("a", 10, 10)), clip("b", 6, 6)),
        clip("c", 8, 8),
      ),
    );

  it("an up-arrow moves a clip one position up", () => {
    const items = three();
    const moved = reorderTo(items, items[1].key, 0);
    expect(moved.map((i) => i.assetId)).toEqual(["b", "a", "c"]);
  });

  it("a down-arrow moves a clip one position down", () => {
    const items = three();
    const moved = reorderTo(items, items[1].key, 2);
    expect(moved.map((i) => i.assetId)).toEqual(["a", "c", "b"]);
  });

  it("a moved clip keeps its trimmed window", () => {
    const items = setTrim(setTrim(three(), 2, "start", 1, 8), 2, "end", 5, 8);
    const moved = reorderTo(items, items[2].key, 0);
    expect(moved[0].assetId).toBe("c");
    expect(moved[0].trimStartSec).toBe(1);
    expect(moved[0].trimEndSec).toBe(5);
    expect(playedSeconds(moved[0])).toBe(4);
  });

  it("strips a crossfade that ends up at the front", () => {
    const faded = setCrossfade(three(), 1, 1);
    const moved = reorderTo(faded, faded[1].key, 0);
    expect(moved[0].crossfadeSec).toBeUndefined();
  });

  it("⚠️ up on the FIRST clip is a no-op, and returns the very same array", () => {
    // Not merely an equal one: normalize maps, so it would build a fresh array even when nothing
    // moved — and a new array on every press of a disabled arrow re-renders the timeline.
    const items = three();
    expect(reorderTo(items, items[0].key, -1)).toBe(items);
  });

  it("⚠️ down on the LAST clip is a no-op, and returns the very same array", () => {
    const items = three();
    expect(reorderTo(items, items[2].key, 3)).toBe(items);
  });

  it("is a no-op for a clip that is not on the timeline", () => {
    const items = three();
    expect(reorderTo(items, "gone", 0)).toBe(items);
  });

  it("⚠️ an ARROW and a DROP that choose the same index produce the same timeline", () => {
    /*
     * The property that makes "they cannot diverge" a fact rather than a sentence. Both
     * affordances do exactly one thing — choose a target index — and hand it to this function; the
     * drop's index comes from geometry and the arrow's from arithmetic, and nothing downstream
     * knows or cares which.
     */
    const items = setTrim(setCrossfade(three(), 1, 1), 2, "end", 5, 8);
    const layout = trackLayout(items, new Map(), 10);

    // A drop far to the left resolves to index 0 — the same index an up-arrow would pick for it.
    const fromDrop = reorderTo(
      items,
      items[1].key,
      dropIndexFor(-999, layout, 1),
    );
    const fromArrow = reorderTo(items, items[1].key, 0);

    expect(fromDrop).toEqual(fromArrow);
    expect(fromDrop.map((i) => i.assetId)).toEqual(["b", "a", "c"]);
  });
});

/**
 * ─── THE THIRD JOIN STATE (video V10, card 2) ─────────────────────────────────────────────────
 *
 * `cut` and `crossfade` are ffmpeg filter choices the stitch engine makes for free. A BRIDGE is a
 * clip Kling has to generate, at roughly $0.42 — so it is not a third `StitchTransition` kind, and
 * these tests pin the three consequences of that decision.
 */
describe("setBridgeRequested", () => {
  const two = (): TimelineItem[] => [
    { key: "k1", assetId: "a1", durationSec: 4, durationPreciseSec: null },
    { key: "k2", assetId: "a2", durationSec: 4, durationPreciseSec: null },
  ];

  it("records the ask on a join, and withdraws it", () => {
    const on = setBridgeRequested(two(), 1, true);
    expect(on[1].bridgeRequested).toBe(true);
    // Withdrawn by removing the key, not by setting false — the same representation rule
    // `toStitchBody` relies on for trims: one way to say "no".
    const off = setBridgeRequested(on, 1, false);
    expect("bridgeRequested" in off[1]).toBe(false);
  });

  it("position 0 can never hold one — there is nothing before it to come from", () => {
    expect(
      setBridgeRequested(two(), 0, true)[0].bridgeRequested,
    ).toBeUndefined();
  });

  /**
   * ⚠️ MUTATION: keep `crossfadeSec` when a bridge is asked for. This reds.
   *
   * They are two answers to the same question — what happens between these two clips — and a join
   * carrying both is a request to fade INTO a clip that is itself the transition.
   */
  it("a bridge and a crossfade are mutually exclusive", () => {
    const faded = setCrossfade(two(), 1, 0.5);
    expect(faded[1].crossfadeSec).toBe(0.5);
    const bridged = setBridgeRequested(faded, 1, true);
    expect(bridged[1].bridgeRequested).toBe(true);
    expect(bridged[1].crossfadeSec).toBeUndefined();
  });

  /**
   * ⚠️ MUTATION: leave `bridgeRequested` out of `normalize`'s strip. This reds.
   *
   * A clip dragged to the front with a crossfade carries a state the server rejects BY FIELD. One
   * dragged to the front with a bridge request carries a state the server never sees at all — the
   * request lives only on the client — and the UI would then offer to generate a transition into
   * the first clip, from nothing. Silently wrong beats refused only in the wrong direction.
   */
  it("a reorder to the front clears the ask, like it clears a crossfade", () => {
    const bridged = setBridgeRequested(two(), 1, true);
    // Move the bridged clip to position 0 and normalise, exactly as the screen does.
    const moved = normalize(reorderTo(bridged, "k2", 0));
    expect(moved[0].key).toBe("k2");
    expect(moved[0].bridgeRequested).toBeUndefined();
  });

  /**
   * ⚠️ MUTATION: emit `bridgeRequested` from `toStitchBody`. This reds.
   *
   * The stitch spec has two transition kinds and gains no third. `stitchRunner.test.ts` asserts the
   * stitch runner's import graph reaches nothing that can spend; a field whose only honest handling
   * is to buy a clip has no business on that wire, and `parseStitchSpec` would reject it by name.
   */
  it("never reaches the wire", () => {
    const body = toStitchBody(
      setBridgeRequested(two(), 1, true),
      "portrait",
      null,
    );
    const clips = body.clips as Record<string, unknown>[];
    expect(clips).toHaveLength(2);
    for (const c of clips) expect("bridgeRequested" in c).toBe(false);
    expect(JSON.stringify(body)).not.toContain("bridge");
  });
});

// ─── Captions, and the guard against a field that never travels ─────────────────────────────────

const WORDS = { text: "Game day", position: "top", style: "boxed" };

describe("a caption on a position", () => {
  it("is set on ONE position and leaves the rest alone", () => {
    const items = setCaption(build("a", "b"), 1, WORDS);
    expect(items[1].caption).toEqual(WORDS);
    expect("caption" in items[0]).toBe(false);
  });

  it("clears on null AND on blank text — there is no such thing as an empty caption", () => {
    const set = setCaption(build("a"), 0, WORDS);
    for (const cleared of [
      setCaption(set, 0, null),
      setCaption(set, 0, { ...WORDS, text: "" }),
      setCaption(set, 0, { ...WORDS, text: "   \n " }),
    ]) {
      expect("caption" in cleared[0]).toBe(false);
    }
  });

  it("trims the ends and otherwise keeps exactly what she typed", () => {
    const items = setCaption(build("a"), 0, {
      ...WORDS,
      text: "  Peña — 3:1\nfinal  ",
    });
    expect(items[0].caption?.text).toBe("Peña — 3:1\nfinal");
  });

  it("travels with its position through a reorder", () => {
    const items = moveItem(setCaption(build("a", "b", "c"), 0, WORDS), 0, 1);
    expect(items.map((i) => i.assetId)).toEqual(["b", "a", "c"]);
    expect(items[1].caption).toEqual(WORDS);
    expect("caption" in items[0]).toBe(false);
  });

  it("stays on BOTH halves of a split — a caption that vanished mid-shot would be a mystery", () => {
    const items = splitAt(setCaption(build("a"), 0, WORDS), 0, 3, 8);
    expect(items).toHaveLength(2);
    expect(items[0].caption).toEqual(WORDS);
    expect(items[1].caption).toEqual(WORDS);
    // And removing it from one half is one call, and touches only that half.
    const oneOff = setCaption(items, 1, null);
    expect(oneOff[0].caption).toEqual(WORDS);
    expect("caption" in oneOff[1]).toBe(false);
  });

  it("carries a colour by NAME, and drops it when it is cleared back to the default", () => {
    const tinted = setCaption(build("a"), 0, { ...WORDS, color: "yellow" });
    expect(tinted[0].caption).toEqual({ ...WORDS, color: "yellow" });
    expect(toStitchBody(tinted, "portrait", null).clips).toEqual([
      { assetId: "a", caption: { ...WORDS, color: "yellow" } },
    ]);
    // The editor sends `color: undefined` for the default. It must not survive as a key: the
    // signature of a white caption is the same whether or not she ever touched the colour row.
    const back = setCaption(tinted, 0, { ...WORDS, color: undefined });
    expect("color" in back[0].caption!).toBe(false);
    expect(timelineSignature(back, "portrait", null)).toBe(
      timelineSignature(setCaption(build("a"), 0, WORDS), "portrait", null),
    );
  });

  it("carries a font by NAME, and drops it when it is cleared back to the default (PR 8)", () => {
    const set = setCaption(build("a"), 0, { ...WORDS, font: "anton" });
    expect(toStitchBody(set, "portrait", null).clips).toEqual([
      { assetId: "a", caption: { ...WORDS, font: "anton" } },
    ]);
    const back = setCaption(set, 0, { ...WORDS, font: undefined });
    expect("font" in back[0].caption!).toBe(false);
    expect(timelineSignature(back, "portrait", null)).toBe(
      timelineSignature(setCaption(build("a"), 0, WORDS), "portrait", null),
    );
  });

  it("reaches the body as her words and two names", () => {
    const body = toStitchBody(
      setCaption(build("a", "b"), 1, WORDS),
      "portrait",
      null,
    );
    expect(body.clips).toEqual([
      { assetId: "a" },
      { assetId: "b", caption: WORDS },
    ]);
  });
});

describe("every field of a position is either on the wire or deliberately not", () => {
  // A position with EVERYTHING set. `Required<>` is the point: add a field to TimelineItem and this
  // literal stops compiling until the new field is given a value here — and TIMELINE_ITEM_FIELDS
  // stops compiling until it is classified. (tsconfig.jest.json is what type-checks this file.)
  const full: Required<TimelineItem> = {
    key: "t-full",
    assetId: "a",
    durationSec: 8,
    durationPreciseSec: 8.033,
    trimStartSec: 1,
    trimEndSec: 5,
    crossfadeSec: 0.5,
    bridgeRequested: true,
    caption: WORDS,
    muted: true,
    stillSec: 2,
    stillMotion: "zoom",
    stillFocus: { x: 0.3, y: 0.25 },
  };
  const sent = (
    toStitchBody([{ ...build("z")[0] }, full], "portrait", null)
      .clips as Record<string, unknown>[]
  )[1];

  it("classifies every field, and nothing that is not a field", () => {
    expect(Object.keys(TIMELINE_ITEM_FIELDS).sort()).toEqual(
      Object.keys(full).sort(),
    );
  });

  it.each(
    Object.entries(TIMELINE_ITEM_FIELDS).filter(
      ([, where]) => where === "wire",
    ),
  )("sends %s", (field) => {
    // THE #538 CHECK. A field marked "wire" that does not arrive is a control she can set and see
    // and that the server never hears about.
    expect(sent[field]).toEqual(full[field as keyof TimelineItem]);
  });

  it.each(
    Object.entries(TIMELINE_ITEM_FIELDS).filter(
      ([, where]) => where === "local",
    ),
  )("never sends %s", (field) => {
    expect(field in sent).toBe(false);
  });
});

describe("the bed's level on the wire", () => {
  it("travels beside a bed, by name", () => {
    expect(
      toStitchBody(build("a"), "portrait", "walking-away", "low"),
    ).toMatchObject({
      bed: "walking-away",
      bedLevel: "low",
    });
  });

  it("is dropped with no bed — she may pick a level and then pick None, and the server refuses a volume for nothing", () => {
    expect(
      "bedLevel" in toStitchBody(build("a"), "portrait", null, "low"),
    ).toBe(false);
  });

  it("is absent when not chosen, so the server's default decides", () => {
    expect(
      "bedLevel" in toStitchBody(build("a"), "portrait", "walking-away"),
    ).toBe(false);
    expect(
      "bedLevel" in toStitchBody(build("a"), "portrait", "walking-away", null),
    ).toBe(false);
  });
});

describe("timelineSignature — what a finished result was made from", () => {
  const base = () => setCaption(build("a", "b"), 0, WORDS);
  const sig = (
    items: TimelineItem[],
    bed: string | null = "x",
    level: string | null = "low",
  ) => timelineSignature(items, "portrait", bed, level);

  it("is unchanged by anything that does not change the video", () => {
    const items = base();
    const relabelled = items.map((i) => ({
      ...i,
      key: `${i.key}-other`,
      durationSec: 99,
      durationPreciseSec: 99.5,
    }));
    expect(sig(relabelled)).toBe(sig(items));
    // A level with no bed is not sent, so it is not a difference either.
    expect(sig(items, null, "low")).toBe(sig(items, null, "high"));
  });

  it.each([
    [
      "her words",
      (i: TimelineItem[]) => setCaption(i, 0, { ...WORDS, text: "Match day" }),
    ],
    [
      "a caption's position",
      (i: TimelineItem[]) => setCaption(i, 0, { ...WORDS, position: "bottom" }),
    ],
    [
      "a caption's style",
      (i: TimelineItem[]) => setCaption(i, 0, { ...WORDS, style: "bold" }),
    ],
    [
      "a caption's colour",
      (i: TimelineItem[]) => setCaption(i, 0, { ...WORDS, color: "pink" }),
    ],
    ["a caption removed", (i: TimelineItem[]) => setCaption(i, 0, null)],
    ["a caption added", (i: TimelineItem[]) => setCaption(i, 1, WORDS)],
    ["a trim", (i: TimelineItem[]) => setTrim(i, 0, "end", 4, 8)],
    ["a crossfade", (i: TimelineItem[]) => setCrossfade(i, 1, 0.5)],
    ["the order", (i: TimelineItem[]) => moveItem(i, 0, 1)],
    ["a clip removed", (i: TimelineItem[]) => removeAt(i, 1)],
  ])("changes with %s", (_what, edit) => {
    expect(sig(edit(base()))).not.toBe(sig(base()));
  });

  it("changes with the shape, the track and how loud it sits", () => {
    const items = base();
    expect(timelineSignature(items, "square", "x", "low")).not.toBe(sig(items));
    expect(sig(items, "y")).not.toBe(sig(items));
    expect(sig(items, null)).not.toBe(sig(items));
    expect(sig(items, "x", "high")).not.toBe(sig(items));
  });
});

describe("the sound from one of her own videos, on the wire", () => {
  const V = "11111111-2222-4333-8444-555555555555";

  it("travels as an asset id, with its level and where it starts", () => {
    expect(
      toStitchBody(build("a"), "portrait", null, "low", {
        bedAssetId: V,
        bedStartSec: 12.5,
      }),
    ).toEqual({
      clips: [{ assetId: "a" }],
      target: "portrait",
      bedAssetId: V,
      bedLevel: "low",
      bedStartSec: 12.5,
    });
  });

  it("can NEVER be sent beside a track — the server 400s a body that names two", () => {
    const body = toStitchBody(build("a"), "portrait", "walking-away", null, {
      bedAssetId: V,
    });
    expect(body.bed).toBe("walking-away");
    expect("bedAssetId" in body).toBe(false);
  });

  it("drops a level and a start when there is no sound at all", () => {
    const body = toStitchBody(build("a"), "portrait", null, "high", {
      bedStartSec: 30,
    });
    expect(Object.keys(body)).toEqual(["clips", "target"]);
  });

  it("never sends a start of zero — it means from the top, which absent already says", () => {
    for (const none of [0, null, undefined]) {
      const body = toStitchBody(build("a"), "portrait", "walking-away", null, {
        bedStartSec: none,
      });
      expect("bedStartSec" in body).toBe(false);
    }
  });

  it("starts a curated track partway in too", () => {
    expect(
      toStitchBody(build("a"), "portrait", "walking-away", null, {
        bedStartSec: 45,
      }).bedStartSec,
    ).toBe(45);
  });

  it("makes a finished result stale when the sound, or where it starts, changes", () => {
    const items = build("a");
    const sig = (sound: { bedAssetId?: string; bedStartSec?: number }) =>
      timelineSignature(items, "portrait", null, null, sound);
    expect(sig({ bedAssetId: V })).not.toBe(sig({}));
    expect(sig({ bedAssetId: V, bedStartSec: 5 })).not.toBe(
      sig({ bedAssetId: V }),
    );
    // And a start with no sound is not a difference, because it is not sent.
    expect(sig({ bedStartSec: 5 })).toBe(sig({}));
  });
});

describe("dragging the sound's tile", () => {
  it("starts it LATER when dragged left, and earlier when dragged back", () => {
    // 40 px per second: 80 px to the left is two seconds further into the track.
    expect(soundStartAfterDrag(0, -80, 40, 120)).toBe(2);
    expect(soundStartAfterDrag(10, 80, 40, 120)).toBe(8);
  });

  it("never goes before the top, and leaves a second of the sound to play", () => {
    expect(soundStartAfterDrag(1, 400, 40, 120)).toBe(0);
    expect(soundStartAfterDrag(100, -4000, 40, 120)).toBe(119);
  });

  it("falls back to the server's hour when the sound's length is not known yet", () => {
    expect(soundStartAfterDrag(0, -40 * 5000, 40, null)).toBe(3599);
  });

  it("steps in tenths, so a jittery thumb does not produce 12.483729", () => {
    expect(soundStartAfterDrag(0, -499.3, 40, 120)).toBe(12.5);
  });

  it("does nothing for a drag it cannot make sense of", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(soundStartAfterDrag(7, bad, 40, 120)).toBe(7);
    }
    expect(soundStartAfterDrag(7, -80, 0, 120)).toBe(7);
  });
});

describe("where the sound is, for a moment on the timeline", () => {
  it("is where she started it plus how far into the video we are", () => {
    expect(soundOffsetAt(0, 0, 120)).toBe(0);
    expect(soundOffsetAt(45, 3, 120)).toBe(48);
  });

  it("WRAPS TO THE TOP when the sound runs out — the rule the stitch itself follows", () => {
    // A 6s sound started 3s in: three seconds later it has ended and is back at its opening.
    expect(soundOffsetAt(3, 3, 6)).toBe(0);
    expect(soundOffsetAt(3, 4.5, 6)).toBeCloseTo(1.5, 6);
    expect(soundOffsetAt(3, 10, 6)).toBeCloseTo(1, 6);
  });

  it("is the plain sum when the sound's length is not known", () => {
    expect(soundOffsetAt(10, 400, null)).toBe(410);
  });

  it("never goes negative", () => {
    expect(soundOffsetAt(-5, -2, 120)).toBe(0);
  });
});

describe("muting a clip", () => {
  it("is on ONE position, travels as `muted: true`, and is ABSENT when off", () => {
    const items = setClipMuted(build("a", "b"), 0, true);
    expect(toStitchBody(items, "portrait", null).clips).toEqual([
      { assetId: "a", muted: true },
      { assetId: "b" },
    ]);
    const off = setClipMuted(items, 0, false);
    expect("muted" in off[0]).toBe(false);
    // Off is the same timeline it was before she ever touched the speaker.
    expect(timelineSignature(off, "portrait", null)).toBe(
      timelineSignature(build("a", "b"), "portrait", null),
    );
  });

  it("stays on BOTH halves of a split, and travels through a reorder", () => {
    const halves = splitAt(setClipMuted(build("a"), 0, true), 0, 3, 8);
    expect(halves.map((h) => h.muted)).toEqual([true, true]);
    const moved = moveItem(setClipMuted(build("a", "b"), 0, true), 0, 1);
    expect(moved.map((m) => m.muted)).toEqual([undefined, true]);
  });

  it("makes a finished result stale", () => {
    const items = build("a");
    expect(
      timelineSignature(setClipMuted(items, 0, true), "portrait", null),
    ).not.toBe(timelineSignature(items, "portrait", null));
  });
});

// ─── Stills ─────────────────────────────────────────────────────────────────────────────────────

describe("a still — one of her photos, held for N seconds", () => {
  const photo = (assetId: string): StillChoice => ({
    assetId,
    imageUrl: `https://signed.test/${assetId}.jpg`,
    thumbUrl: `https://signed.test/${assetId}-thumb.jpg`,
    origin: "Uploaded",
  });
  /** A clip, then a photo held for `sec`. */
  const clipThenStill = (sec = 2) => addStill(build("a"), photo("p"), sec);

  it("reaches the wire as its photo and its hold, and nothing else", () => {
    const body = toStitchBody(clipThenStill(2), "portrait", null);
    expect(body.clips).toEqual([
      { assetId: "a" },
      { assetId: "p", stillSec: 2 },
    ]);
  });

  it("is added at the hold it is given, with no durations of its own", () => {
    const [, still] = addStill(build("a"), photo("p"), LIMITS.defaultStillSec);
    expect(still).toMatchObject({
      assetId: "p",
      stillSec: 2,
      durationSec: null,
      durationPreciseSec: null,
    });
    expect(isStill(still)).toBe(true);
    expect(isStill(build("a")[0])).toBe(false);
  });

  it("holds within the server's bounds whatever a control asks, and a clip has no hold to set", () => {
    const items = clipThenStill(2);
    expect(setStillSec(items, 1, 0.2, LIMITS)[1].stillSec).toBe(1);
    expect(setStillSec(items, 1, 12, LIMITS)[1].stillSec).toBe(8);
    expect(setStillSec(items, 1, 3, LIMITS)[1].stillSec).toBe(3);
    expect(setStillSec(items, 1, NaN, LIMITS)).toBe(items);
    expect("stillSec" in setStillSec(items, 0, 3, LIMITS)[0]).toBe(false);
  });

  it("a still cannot be trimmed", () => {
    const items = clipThenStill(2);
    expect(setTrim(items, 1, "end", 1, 2)).toBe(items);
    expect(setTrim(items, 1, "start", 0.5, 2)).toBe(items);
  });

  it("a still cannot be split", () => {
    const items = clipThenStill(2);
    expect(splitAt(items, 1, 1, 2)).toBe(items);
  });

  it("a still cannot be muted — a photo has no sound of its own", () => {
    const items = clipThenStill(2);
    expect("muted" in setClipMuted(items, 1, true)[1]).toBe(false);
  });

  it("plays exactly its hold, and the totals take its fade off like any join", () => {
    const items = setCrossfade(clipThenStill(2), 1, 0.5);
    expect(playedSeconds(items[1])).toBe(2);
    expect(timelineTotals(items)).toEqual({
      clips: 2,
      seconds: 9.5,
      downloads: 2,
    });
  });

  it("counts toward the clip cap like any position", () => {
    const twelve = build(...Array.from({ length: 12 }, (_, i) => `c${i}`));
    expect(timelineRefusal(addStill(twelve, photo("p"), 2), LIMITS)).toMatch(
      /13 clips/,
    );
  });

  it("refuses fades that leave a still no moment of its own — the server's rule, mirrored", () => {
    // The third position is a clip after the still, faded into.
    const withAfter = setCrossfade(
      addClip(
        setCrossfade(addStill(build("a"), photo("p"), 1), 1, 0.5),
        clip("b"),
      ),
      2,
      0.5,
    );
    expect(timelineRefusal(withAfter, LIMITS)).toMatch(
      /held for 1s and its fades take 1s/,
    );
    // Even before the options arrive — it needs no limits.
    expect(timelineRefusal(withAfter, null)).toMatch(/held for 1s/);
    const roomy = setStillSec(withAfter, 1, 2, LIMITS);
    expect(timelineRefusal(roomy, LIMITS)).toBeNull();
  });

  it("is not offered a bridge on either side, and a reorder clears one that lands beside it", () => {
    const items = addClip(clipThenStill(2), clip("b"));
    expect(
      setBridgeRequested(items, 1, true)[1].bridgeRequested,
    ).toBeUndefined();
    expect(
      setBridgeRequested(items, 2, true)[2].bridgeRequested,
    ).toBeUndefined();
    // A bridge asked for between two clips, then the still dragged in front of the bridged clip.
    const bridged = setBridgeRequested(addClip(build("a"), clip("b")), 1, true);
    expect(bridged[1].bridgeRequested).toBe(true);
    const withStill = addStill(bridged, photo("p"), 2);
    const moved = reorderTo(withStill, withStill[2].key, 1);
    expect(moved.map((i) => i.assetId)).toEqual(["a", "p", "b"]);
    expect(moved[2].bridgeRequested).toBeUndefined();
  });

  it("normalize clears a trim, a mute or a bridge a still arrived with", () => {
    const [clipItem] = build("a");
    const odd: TimelineItem = {
      key: "odd",
      assetId: "p",
      durationSec: null,
      durationPreciseSec: null,
      stillSec: 2,
      trimStartSec: 1,
      trimEndSec: 1.5,
      muted: true,
      bridgeRequested: true,
      crossfadeSec: 0.5,
    };
    expect(normalize([clipItem, odd])[1]).toEqual({
      key: "odd",
      assetId: "p",
      durationSec: null,
      durationPreciseSec: null,
      stillSec: 2,
      crossfadeSec: 0.5,
    });
  });

  it("is drawn on the track at exactly its hold", () => {
    const layout = trackLayout(clipThenStill(3), new Map());
    expect(layout.rects[1]).toMatchObject({
      durationSource: "precise",
      wholeSec: 3,
      sourceStartSec: 0,
      sourceEndSec: 3,
    });
    expect(layout.rects[1].width).toBe(xAtTime(3, 40));
  });
});
