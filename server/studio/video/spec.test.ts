/**
 * spec.test.ts — the Shape pill is not decoration: it reaches ffmpeg's argv.
 *
 * ⚠️  THE FAILURE THIS EXISTS TO CATCH is a UI control the pipeline ignores. Every step between the
 * pill and the encoder is a place the choice can be dropped — the request body, the jsonb column,
 * the re-parse at claim time, the expansion from NAME to dimensions — and nothing downstream would
 * complain: a stitch made in the wrong shape succeeds. It just comes back wrong.
 *
 * So this walks the WHOLE seam with the REAL functions, ending at the actual filter graph rather
 * than at an intermediate object. The client half (that the pill emits the NAME) is pinned in
 * client/screens/studio/stitchLogic.test.ts; this is everything after it.
 */
import { planStitch } from "./plan";
import { SHOT_SLOTS } from "../types";
import { chooseJoin } from "../../../client/screens/studio/joinLogic";
import {
  droppedSlotReason,
  type StoryboardRow,
} from "../../../client/screens/studio/storyboardLogic";
import {
  DEFAULT_STILL_SEC,
  DROPPED_SLOT_REASONS,
  isRefusal,
  JOIN_REASONS,
  MAX_STILL_SEC,
  MIN_STILL_SEC,
  parseStitchSpec,
  readStoredSpec,
  STITCH_TARGETS,
  toStitchRequest,
} from "./spec";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A 1080x1920 portrait source, so a landscape target has to visibly reshape it. */
const probe = {
  width: 1080,
  height: 1920,
  fps: 30,
  pixFmt: "yuv420p",
  sampleAspectRatio: "1:1",
  durationSec: 8,
  videoCodec: "h264",
  hasAudio: true,
  audioCodec: "aac",
  sampleRate: 48000,
  channels: 2,
};

/** Body → parse → jsonb round trip → re-parse → expand → plan. Every real step, in order. */
function throughTheWholeSeam(target: string) {
  const body = { clips: [{ assetId: A }, { assetId: B }], target };

  const parsed = parseStitchSpec(body);
  if (isRefusal(parsed)) throw new Error(`route refused: ${parsed.error}`);

  // What the jsonb column does to it. Not cosmetic — a value that does not survive JSON is a value
  // the runner will not see.
  const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
  if (isRefusal(stored)) throw new Error(`runner refused: ${stored.error}`);

  const req = toStitchRequest(
    stored,
    new Map([
      [A, "/tmp/a.mp4"],
      [B, "/tmp/b.mp4"],
    ]),
    "/tmp/out.mp4",
  );
  const plan = planStitch({
    clips: req.clips,
    probes: [probe, probe],
    outputPath: req.outputPath,
    target: req.target,
  });
  return { stored, req, plan };
}

describe("the Shape reaches the encoder", () => {
  it.each([
    ["portrait", 1080, 1920],
    ["square", 1080, 1080],
    ["landscape", 1920, 1080],
  ])("%s becomes scale=%i:%i in the real filter graph", (target, w, h) => {
    const { stored, req, plan } = throughTheWholeSeam(target as string);

    // The stored row holds the NAME, never the dimensions — so a preset can be corrected later.
    expect((stored as { target: string }).target).toBe(target);
    expect(JSON.stringify(stored)).not.toMatch(/\d{3,4}/);

    // The engine is handed the dimensions.
    expect(req.target).toMatchObject({ width: w, height: h, fps: 30 });

    // And ffmpeg is actually told to make that shape. This is the assertion that cannot be
    // satisfied by a pill wired to nothing.
    expect(plan.filterGraph).toContain(`scale=${w}:${h}`);
    expect(plan.filterGraph).toContain(`pad=${w}:${h}`);
    expect(plan.args.join(" ")).toContain("/tmp/out.mp4");
  });

  it("gives the three shapes three DIFFERENT graphs", () => {
    // The weakest way to break this is for every target to expand to the same thing. Three
    // assertions that each pass in isolation would not catch it; comparing them does.
    const graphs = ["portrait", "square", "landscape"].map(
      (t) => throughTheWholeSeam(t).plan.filterGraph,
    );
    expect(new Set(graphs).size).toBe(3);
  });

  it("reshapes a portrait source when landscape is chosen — not just relabels it", () => {
    // The source is 1080x1920. Landscape must letterbox it into 1920x1080, which means the scale
    // and the pad disagree — that disagreement IS the reshaping.
    const { plan } = throughTheWholeSeam("landscape");
    expect(plan.filterGraph).toContain(
      "scale=1920:1080:force_original_aspect_ratio=decrease",
    );
    expect(plan.filterGraph).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    expect(plan.clips[0].normalization.scaled).toBe(true);
    expect(plan.clips[0].normalization.padded).toBe(true);
  });

  it("refuses a shape that is not on the list, rather than defaulting to one", () => {
    // A silent default is how a pill becomes decoration: an unknown name would produce a stitch in
    // SOME shape and look like it worked.
    for (const bad of [
      "1080x1920",
      "Portrait",
      "",
      null,
      { width: 1920, height: 1080 },
    ]) {
      const out = parseStitchSpec({ clips: [{ assetId: A }], target: bad });
      expect(isRefusal(out)).toBe(true);
    }
  });

  it("declares exactly the three the client offers", () => {
    expect(Object.keys(STITCH_TARGETS).sort()).toEqual([
      "landscape",
      "portrait",
      "square",
    ]);
  });
});

describe("a caption on a clip", () => {
  const withCaption = (caption: unknown, i = 0) => ({
    clips: [{ assetId: A }, { assetId: B }].map((c, k) =>
      k === i ? { ...c, caption } : c,
    ),
    target: "portrait",
  });
  const good = { text: "Game day", position: "bottom", style: "clean" };

  it("is stored as her words and two NAMES, and survives the jsonb round trip unchanged", () => {
    const parsed = parseStitchSpec(withCaption(good, 1));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);

    expect(stored.clips[1].caption).toEqual(good);
    // Only the position she captioned carries one: absent is the one representation of "none".
    expect("caption" in stored.clips[0]).toBe(false);
    // Names, never the geometry they expand to — so a preset can be corrected for queued rows.
    expect(JSON.stringify(stored.clips[1].caption)).not.toMatch(/\d/);
  });

  it("stores the text NORMALISED, so the run renders the stored string as it stands", () => {
    const parsed = parseStitchSpec(
      withCaption({ ...good, text: "  Peña \r\n wins  " }),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    expect(parsed.clips[0].caption?.text).toBe("Peña\nwins");
    // And re-reading the stored row changes nothing: normalising is idempotent.
    const again = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(again)) throw new Error(again.error);
    expect(again.clips[0].caption?.text).toBe("Peña\nwins");
  });

  it("refuses an unknown caption style by name, rather than defaulting to one", () => {
    for (const bad of ["Clean", "neon", "", null, 3, { weight: 800 }]) {
      const out = parseStitchSpec(withCaption({ ...good, style: bad }));
      expect(isRefusal(out) && out.field).toBe("clips[0].caption.style");
    }
  });

  it("refuses an unknown caption position by name, rather than defaulting to one", () => {
    for (const bad of ["Bottom", "centre", "", null, 0.8, { y: 100 }]) {
      const out = parseStitchSpec(withCaption({ ...good, position: bad }, 1));
      expect(isRefusal(out) && out.field).toBe("clips[1].caption.position");
    }
  });

  it("refuses text the font cannot draw, with the sentence that says what IS allowed", () => {
    for (const bad of [
      "go 🔥",
      "日本語",
      "",
      "   ",
      "x".repeat(61),
      "a\nb\nc",
      9,
    ]) {
      const out = parseStitchSpec(withCaption({ ...good, text: bad }));
      if (!isRefusal(out)) throw new Error(`accepted ${JSON.stringify(bad)}`);
      expect(out.field).toBe("clips[0].caption.text");
      expect(out.error).toMatch(
        /letters \(accents included\), numbers and punctuation/,
      );
    }
  });

  it("stores a colour by NAME, never white, and never a hex", () => {
    const stored = (color: unknown) => {
      const out = parseStitchSpec(withCaption({ ...good, color }));
      if (isRefusal(out)) throw new Error(out.error);
      return out.clips[0].caption!;
    };
    expect(stored("yellow").color).toBe("yellow");
    expect(JSON.stringify(stored("yellow"))).not.toContain("#");
    // White, null and absent are one thing, and it has one representation: absent.
    for (const plain of ["white", null, undefined]) {
      expect("color" in stored(plain)).toBe(false);
    }
  });

  it("refuses an unknown caption colour by name — a hex most of all", () => {
    for (const bad of ["#FF0000", "red", "Yellow", "", 3, { hex: "#fff" }]) {
      const out = parseStitchSpec(withCaption({ ...good, color: bad }));
      expect(isRefusal(out) && out.field).toBe("clips[0].caption.color");
    }
  });

  it("stores a font by NAME only when it is not Outfit (PR 8)", () => {
    const set = parseStitchSpec(withCaption({ ...good, font: "anton" }));
    if (isRefusal(set)) throw new Error(set.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(set)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips[0].caption).toEqual({ ...good, font: "anton" });
    for (const def of ["outfit", null, undefined]) {
      const out = parseStitchSpec(withCaption({ ...good, font: def }));
      if (isRefusal(out)) throw new Error(out.error);
      expect([def, "font" in out.clips[0].caption!]).toEqual([def, false]);
    }
  });

  it("refuses an unknown font by name, rather than defaulting to one — a file path most of all", () => {
    for (const bad of [
      "Anton",
      "big-shoulders-display",
      "/etc/passwd",
      "",
      3,
    ]) {
      const out = parseStitchSpec(withCaption({ ...good, font: bad }));
      expect([bad, isRefusal(out) && out.field]).toEqual([
        bad,
        "clips[0].caption.font",
      ]);
    }
  });

  it("refuses words the chosen font would draw as boxes, naming them — and only in that font", () => {
    const words = { ...good, text: "½ time ± 2" };
    const out = parseStitchSpec(
      withCaption({ ...words, font: "instrument-serif" }),
    );
    expect(isRefusal(out) && out.field).toBe("clips[0].caption.text");
    expect(isRefusal(out) && out.error).toContain(
      "Instrument Serif can't draw ½ ±",
    );
    // The same words in Outfit (no font) are what they always were: allowed.
    expect(isRefusal(parseStitchSpec(withCaption(words)))).toBe(false);
    expect(
      isRefusal(parseStitchSpec(withCaption({ ...words, font: "anton" }))),
    ).toBe(false);
  });

  it("treats null as no caption, and refuses a caption that is not an object", () => {
    const cleared = parseStitchSpec(withCaption(null));
    if (isRefusal(cleared)) throw new Error(cleared.error);
    expect("caption" in cleared.clips[0]).toBe(false);

    for (const bad of ["Game day", ["Game day"], 1, true]) {
      expect(isRefusal(parseStitchSpec(withCaption(bad)))).toBe(true);
    }
  });

  it("stores the three known fields and nothing else a body put inside the caption", () => {
    const parsed = parseStitchSpec(
      withCaption({
        ...good,
        fontfile: "/etc/passwd",
        size: 400,
        hex: "#f00",
      }),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    // An unknown COLOUR is refused outright (above), so it is not one of the strays here: these are
    // keys the parser has no opinion about, and they must simply not be stored.
    expect(Object.keys(parsed.clips[0].caption!).sort()).toEqual([
      "position",
      "style",
      "text",
    ]);
  });
});

describe("how loud the music sits", () => {
  const withBed = (over: Record<string, unknown>) => ({
    clips: [{ assetId: A }],
    target: "portrait",
    bed: "placeholder",
    ...over,
  });
  const request = (body: unknown) => {
    const parsed = parseStitchSpec(body, false);
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    return {
      stored,
      req: toStitchRequest(
        stored,
        new Map([[A, "/tmp/a.mp4"]]),
        "/tmp/out.mp4",
        undefined,
        "/tmp/bed.m4a",
      ),
    };
  };

  it("reaches the engine as the gain its NAME stands for", () => {
    expect(request(withBed({ bedLevel: "low" })).req.audioBed?.level).toBe(
      0.15,
    );
    expect(request(withBed({ bedLevel: "high" })).req.audioBed?.level).toBe(
      0.4,
    );
  });

  it("never stores medium, and leaves the engine's own default to decide it", () => {
    for (const body of [
      withBed({}),
      withBed({ bedLevel: "medium" }),
      withBed({ bedLevel: null }),
    ]) {
      const { stored, req } = request(body);
      expect("bedLevel" in stored).toBe(false);
      expect(req.audioBed).toEqual({ source: "/tmp/bed.m4a", duck: {} });
    }
  });

  it("stores the NAME, never the gain", () => {
    const { stored } = request(withBed({ bedLevel: "high" }));
    expect(stored.bedLevel).toBe("high");
    expect(JSON.stringify(stored)).not.toContain("0.4");
  });

  it("refuses an unknown level by name — a number most of all", () => {
    for (const bad of [0.4, "0.4", "Loud", "max", "", {}, true]) {
      const out = parseStitchSpec(withBed({ bedLevel: bad }), false);
      expect(isRefusal(out) && out.field).toBe("bedLevel");
    }
  });

  it("refuses a level with no music to set the level of", () => {
    const out = parseStitchSpec({
      clips: [{ assetId: A }],
      target: "portrait",
      bedLevel: "low",
    });
    expect(isRefusal(out) && out.field).toBe("bedLevel");
  });

  it("always asks the engine to duck the bed — whether it DOES is plan.ts's call (ledger D4)", () => {
    // The request cannot know whether a clip sounds (that takes a probe), so it asks every time and
    // the engine emits the sidechain only under a clip that actually has sound. This used to pin
    // the opposite: no duck was ever asked for, and the bed sat flat over whatever a clip said.
    expect(request(withBed({ bedLevel: "high" })).req.audioBed).toHaveProperty(
      "duck",
      {},
    );
  });
});

describe("the sound from one of her own videos", () => {
  const body = (over: Record<string, unknown>) => ({
    clips: [{ assetId: A }],
    target: "portrait",
    ...over,
  });

  it("is stored as an ASSET ID and nothing else, and survives the jsonb round trip", () => {
    const parsed = parseStitchSpec(body({ bedAssetId: B }));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.bedAssetId).toBe(B);
    expect("bed" in stored).toBe(false);
    // An id, never a path or a url: it is resolved against the athlete on the row at run time.
    expect(JSON.stringify(stored)).not.toMatch(/https?:|gs:|\.mp4|athletes\//);
  });

  it("does not wait on the product's tracks being installed — her video is already hers", () => {
    // bedsReady() is false in this suite. A curated `bed` is refused at the door for it; this is not.
    expect(isRefusal(parseStitchSpec(body({ bed: "walking-away" })))).toBe(
      true,
    );
    expect(isRefusal(parseStitchSpec(body({ bedAssetId: B })))).toBe(false);
  });

  it("refuses a track AND a video's sound together, rather than picking one", () => {
    const out = parseStitchSpec(
      body({ bed: "walking-away", bedAssetId: B }),
      false,
    );
    expect(isRefusal(out) && out.field).toBe("bedAssetId");
  });

  it("refuses anything that is not an asset id — a path and a url most of all", () => {
    for (const bad of [
      "athletes/x/uploads/y.mp4",
      "https://storage.googleapis.com/b/o.mp4",
      "../../etc/passwd",
      "not-a-uuid",
      "",
      7,
      { id: B },
    ]) {
      const out = parseStitchSpec(body({ bedAssetId: bad }));
      expect(isRefusal(out) && out.field).toBe("bedAssetId");
    }
  });

  it("THROWS when the engine's request is built without her sound — never a silent downgrade", () => {
    const parsed = parseStitchSpec(body({ bedAssetId: B, bedLevel: "high" }));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const paths = new Map([[A, "/tmp/a.mp4"]]);
    expect(() => toStitchRequest(parsed, paths, "/tmp/out.mp4")).toThrow(
      /takes its sound from/,
    );
    // And with it, the engine gets the file and the level her NAME stands for.
    const req = toStitchRequest(
      parsed,
      paths,
      "/tmp/out.mp4",
      undefined,
      "/tmp/b.mp4",
    );
    expect(req.audioBed).toEqual({
      source: "/tmp/b.mp4",
      duck: {},
      level: 0.4,
    });
  });

  it("treats null as not chosen, and takes a level beside it like any other bed", () => {
    const none = parseStitchSpec(body({ bedAssetId: null }));
    if (isRefusal(none)) throw new Error(none.error);
    expect("bedAssetId" in none).toBe(false);

    const quiet = parseStitchSpec(body({ bedAssetId: B, bedLevel: "low" }));
    if (isRefusal(quiet)) throw new Error(quiet.error);
    expect(quiet.bedLevel).toBe("low");
    const medium = parseStitchSpec(body({ bedAssetId: B, bedLevel: "medium" }));
    if (isRefusal(medium)) throw new Error(medium.error);
    expect("bedLevel" in medium).toBe(false);
  });
});

describe("where the music starts", () => {
  const body = (over: Record<string, unknown>) => ({
    clips: [{ assetId: A }],
    target: "portrait",
    ...over,
  });
  const engine = (over: Record<string, unknown>) => {
    const parsed = parseStitchSpec(body(over), false);
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    return {
      stored,
      bed: toStitchRequest(
        stored,
        new Map([[A, "/tmp/a.mp4"]]),
        "/tmp/out.mp4",
        undefined,
        "/tmp/bed",
      ).audioBed,
    };
  };

  it("reaches the engine for a curated track AND for her own video", () => {
    expect(engine({ bed: "walking-away", bedStartSec: 45 }).bed?.startSec).toBe(
      45,
    );
    expect(engine({ bedAssetId: B, bedStartSec: 12.5 }).bed?.startSec).toBe(
      12.5,
    );
  });

  it("never stores zero — absent already means from the beginning", () => {
    for (const none of [0, null, undefined]) {
      const { stored, bed } = engine({
        bed: "walking-away",
        bedStartSec: none,
      });
      expect("bedStartSec" in stored).toBe(false);
      expect(bed).toEqual({ source: "/tmp/bed", duck: {} });
    }
  });

  it("refuses a string, a negative, NaN and anything past the hour, by field", () => {
    for (const bad of ["45", -1, Number.NaN, 3601, {}, true]) {
      const out = parseStitchSpec(
        body({ bed: "walking-away", bedStartSec: bad }),
        false,
      );
      expect(isRefusal(out) && out.field).toBe("bedStartSec");
    }
  });

  it("refuses a start with no music to start", () => {
    const out = parseStitchSpec(body({ bedStartSec: 10 }));
    expect(isRefusal(out) && out.field).toBe("bedStartSec");
  });
});

describe("muting a clip", () => {
  const body = (muted: unknown) => ({
    clips: [{ assetId: A, muted }, { assetId: B }],
    target: "portrait",
  });

  it("is stored only when TRUE, and reaches the engine for that clip alone", () => {
    const parsed = parseStitchSpec(body(true));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips[0].muted).toBe(true);
    expect("muted" in stored.clips[1]).toBe(false);

    const req = toStitchRequest(
      stored,
      new Map([
        [A, "/tmp/a.mp4"],
        [B, "/tmp/b.mp4"],
      ]),
      "/tmp/out.mp4",
    );
    expect(req.clips[0].muted).toBe(true);
    expect("muted" in req.clips[1]).toBe(false);
  });

  it("treats false and null as not muted — one representation of the default", () => {
    for (const off of [false, null, undefined]) {
      const parsed = parseStitchSpec(body(off));
      if (isRefusal(parsed)) throw new Error(parsed.error);
      expect("muted" in parsed.clips[0]).toBe(false);
    }
  });

  it("refuses anything that is not a boolean, rather than coercing it", () => {
    for (const bad of ["true", "yes", 1, 0, {}, []]) {
      const out = parseStitchSpec(body(bad));
      expect(isRefusal(out) && out.field).toBe("clips[0].muted");
    }
  });
});

describe("a still — one of her photos, held for N seconds", () => {
  const body = (clips: Record<string, unknown>[]) => ({
    clips,
    target: "portrait",
  });
  const refusal = (clips: Record<string, unknown>[]) => {
    const out = parseStitchSpec(body(clips));
    return isRefusal(out) ? out.field : null;
  };

  it("is stored as `stillSec` on the position, and survives the jsonb round trip", () => {
    const parsed = parseStitchSpec(
      body([{ assetId: A, stillSec: 2 }, { assetId: B }]),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips).toEqual([{ assetId: A, stillSec: 2 }, { assetId: B }]);
  });

  it("accepts both ends of the hold, a second and eight", () => {
    expect(refusal([{ assetId: A, stillSec: MIN_STILL_SEC }])).toBeNull();
    expect(refusal([{ assetId: A, stillSec: MAX_STILL_SEC }])).toBeNull();
    expect([MIN_STILL_SEC, MAX_STILL_SEC, DEFAULT_STILL_SEC]).toEqual([
      1, 8, 2,
    ]);
  });

  it("refuses a still held longer than 8 seconds, by field", () => {
    for (const long of [8.01, 9, 60]) {
      expect(refusal([{ assetId: A, stillSec: long }])).toBe(
        "clips[0].stillSec",
      );
    }
  });

  it("refuses a still shorter than a second, and anything that is not a number, by field", () => {
    for (const bad of [0.99, 0, -1, "2", NaN, Infinity, true, {}]) {
      expect(refusal([{ assetId: A, stillSec: bad }])).toBe(
        "clips[0].stillSec",
      );
    }
  });

  it("treats null as not a still — one representation of a clip", () => {
    const parsed = parseStitchSpec(body([{ assetId: A, stillSec: null }]));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    expect("stillSec" in parsed.clips[0]).toBe(false);
  });

  it("refuses a trim or a mute on a photo — there is no footage to trim and no sound to mute", () => {
    expect(refusal([{ assetId: A, stillSec: 2, trimStartSec: 1 }])).toBe(
      "clips[0].trimStartSec",
    );
    expect(refusal([{ assetId: A, stillSec: 2, trimEndSec: 1 }])).toBe(
      "clips[0].trimEndSec",
    );
    expect(refusal([{ assetId: A, stillSec: 2, muted: true }])).toBe(
      "clips[0].muted",
    );
    // `false` is the default, not an instruction — the same reading a clip gets.
    expect(refusal([{ assetId: A, stillSec: 2, muted: false }])).toBeNull();
  });

  it("refuses fades that leave a still no moment of its own", () => {
    // In and out both eat into a one-second photo: nothing of it is on screen alone.
    expect(
      refusal([
        { assetId: B },
        { assetId: A, stillSec: 1, crossfadeSec: 0.5 },
        { assetId: B, crossfadeSec: 0.5 },
      ]),
    ).toBe("clips[2].crossfadeSec");
    // A fade INTO it as long as the hold — the engine's own "does not fit".
    expect(
      refusal([{ assetId: B }, { assetId: A, stillSec: 2, crossfadeSec: 2 }]),
    ).toBe("clips[1].crossfadeSec");
    // First on the timeline, faded OUT of for as long as it is held.
    expect(
      refusal([
        { assetId: A, stillSec: 1 },
        { assetId: B, crossfadeSec: 1 },
      ]),
    ).toBe("clips[1].crossfadeSec");
  });

  it("allows the Board's own fades either side of a two-second still", () => {
    expect(
      refusal([
        { assetId: B },
        { assetId: A, stillSec: 2, crossfadeSec: 0.5 },
        { assetId: B, crossfadeSec: 0.5 },
      ]),
    ).toBeNull();
  });

  it("takes a caption like any position — a title card", () => {
    const parsed = parseStitchSpec(
      body([
        {
          assetId: A,
          stillSec: 3,
          caption: { text: "Game day", position: "middle", style: "clean" },
        },
      ]),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    expect(parsed.clips[0]).toMatchObject({
      stillSec: 3,
      caption: { text: "Game day" },
    });
  });

  it("hands the engine the position's ENCODED clip for a still — never the photo's path", () => {
    const parsed = parseStitchSpec(
      body([
        { assetId: A, stillSec: 2 },
        { assetId: B, crossfadeSec: 0.5 },
      ]),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const req = toStitchRequest(
      parsed,
      new Map([[B, "/w/b.mp4"]]),
      "/w/out.mp4",
      undefined,
      undefined,
      undefined,
      new Map([[0, "/w/still-0.mp4"]]),
    );
    expect(req.clips.map((c) => c.source)).toEqual([
      "/w/still-0.mp4",
      "/w/b.mp4",
    ]);
    expect(req.clips[0]).not.toHaveProperty("trimStartSec");
    expect(req.clips[0]).not.toHaveProperty("muted");
  });

  it("throws rather than hand the engine a photo, even when the photo's own file is in the workspace", () => {
    const parsed = parseStitchSpec(body([{ assetId: A, stillSec: 2 }]));
    if (isRefusal(parsed)) throw new Error(parsed.error);
    expect(() =>
      toStitchRequest(parsed, new Map([[A, "/w/photo.jpg"]]), "/w/out.mp4"),
    ).toThrow(/No encoded still for position 0/);
  });

  it("leaves a timeline with no still exactly as it parsed before stills existed", () => {
    const parsed = parseStitchSpec(
      body([
        { assetId: A, trimStartSec: 1 },
        { assetId: B, crossfadeSec: 0.5 },
      ]),
    );
    expect(parsed).toEqual({
      clips: [
        { assetId: A, trimStartSec: 1 },
        { assetId: B, crossfadeSec: 0.5 },
      ],
      target: "portrait",
    });
  });
});

describe("a still's push-in — `stillMotion` on the position (C3, D2)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const body = (clips: Record<string, unknown>[]) => ({
    clips,
    target: "portrait",
  });
  const refusal = (clips: Record<string, unknown>[]) => {
    const out = parseStitchSpec(body(clips));
    return isRefusal(out) ? out.field : null;
  };

  /**
   * ⚠️ MUTATIONS: store `stillMotion` whatever `stillSec` says — "refused on a clip" reds by name;
   * accept any string — "refused for a motion that is not one of the four" reds.
   */
  it("is stored on a still, survives the jsonb round trip, and null is 'dead still' like absent", () => {
    const parsed = parseStitchSpec(
      body([
        { assetId: A, stillSec: 4, stillMotion: "dolly" },
        { assetId: B, stillSec: 2, stillMotion: null },
      ]),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips).toEqual([
      { assetId: A, stillSec: 4, stillMotion: "dolly" },
      { assetId: B, stillSec: 2 },
    ]);
  });

  /** ⚠️ MUTATION: drop `pan` from ./stillMotion's aliases — this case reds by name. */
  it('alias dropped: a spec stored before PR 6 with stillMotion "pan" still reads, as dolly', () => {
    const stored = readStoredSpec(
      JSON.parse(
        JSON.stringify(body([{ assetId: A, stillSec: 4, stillMotion: "pan" }])),
      ),
    );
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips).toEqual([
      { assetId: A, stillSec: 4, stillMotion: "dolly" },
    ]);
  });

  it("refused on a clip — a clip has its own motion — by field", () => {
    expect(refusal([{ assetId: A, stillMotion: "dolly" }])).toBe(
      "clips[0].stillMotion",
    );
    expect(
      refusal([
        { assetId: A, trimStartSec: 1, trimEndSec: 3, stillMotion: "dolly" },
      ]),
    ).toBe("clips[0].stillMotion");
  });

  it("refused for a motion that is not one of the four, by field", () => {
    // "zoom" was on this list until A1 made it a motion; the rule is the same — a name or nothing.
    for (const bad of ["tilt", "Zoom", "PAN", "ken-burns", 1, true, {}]) {
      expect(refusal([{ assetId: A, stillSec: 2, stillMotion: bad }])).toBe(
        "clips[0].stillMotion",
      );
    }
  });
});

describe("a move toward a point — `stillFocus` beside zoom, sweep, punch (PR 5, A1)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const body = (clips: Record<string, unknown>[]) => ({
    clips,
    target: "portrait",
  });
  const refusal = (clips: Record<string, unknown>[]) => {
    const out = parseStitchSpec(body(clips));
    return isRefusal(out) ? out.field : null;
  };

  it("the three moves are stored with their point, rebuilt from x and y; null is 'the photo's own point'", () => {
    const parsed = parseStitchSpec(
      body([
        {
          assetId: A,
          stillSec: 3,
          stillMotion: "zoom",
          stillFocus: { x: 0.3, y: 0.25, extra: "dropped" },
        },
        { assetId: B, stillSec: 2, stillMotion: "sweep", stillFocus: null },
        {
          assetId: A,
          stillSec: 2,
          stillMotion: "punch",
          stillFocus: { x: 0, y: 1 },
        },
      ]),
    );
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.clips).toEqual([
      {
        assetId: A,
        stillSec: 3,
        stillMotion: "zoom",
        stillFocus: { x: 0.3, y: 0.25 },
      },
      { assetId: B, stillSec: 2, stillMotion: "sweep" },
      {
        assetId: A,
        stillSec: 2,
        stillMotion: "punch",
        stillFocus: { x: 0, y: 1 },
      },
    ]);
  });

  it("a point beside a push-in, a dead still or a clip would do nothing, so it is refused by field", () => {
    const f = { x: 0.5, y: 0.5 };
    expect(
      refusal([
        { assetId: A, stillSec: 2, stillMotion: "dolly", stillFocus: f },
      ]),
    ).toBe("clips[0].stillFocus");
    expect(refusal([{ assetId: A, stillSec: 2, stillFocus: f }])).toBe(
      "clips[0].stillFocus",
    );
    expect(refusal([{ assetId: A, stillFocus: f }])).toBe(
      "clips[0].stillFocus",
    );
  });

  it("a point off the photo, or not two numbers, is refused by field", () => {
    for (const bad of [
      { x: 1.2, y: 0.5 },
      { x: -0.1, y: 0.5 },
      { x: "0.5", y: 0.5 },
      { x: 0.5 },
      [0.5, 0.5],
      "centre",
      { x: NaN, y: 0.5 },
    ]) {
      expect(
        refusal([
          { assetId: A, stillSec: 2, stillMotion: "zoom", stillFocus: bad },
        ]),
      ).toBe("clips[0].stillFocus");
    }
  });
});

describe("one look across the set — `look` on the spec (PR 5, A3)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("is stored by name beside photos, survives the round trip, and null is 'as they are'", () => {
    const parsed = parseStitchSpec({
      clips: [{ assetId: A, stillSec: 2 }, { assetId: B }],
      target: "portrait",
      look: "teal-orange",
    });
    if (isRefusal(parsed)) throw new Error(parsed.error);
    const stored = readStoredSpec(JSON.parse(JSON.stringify(parsed)));
    if (isRefusal(stored)) throw new Error(stored.error);
    expect(stored.look).toBe("teal-orange");
    const none = parseStitchSpec({
      clips: [{ assetId: A, stillSec: 2 }],
      target: "portrait",
      look: null,
    });
    expect("look" in none).toBe(false);
  });

  it("refused by field when it is not a look, or when there is no photo for it to fall on", () => {
    for (const bad of ["sepia", "Warm", 1, {}]) {
      const out = parseStitchSpec({
        clips: [{ assetId: A, stillSec: 2 }],
        target: "portrait",
        look: bad,
      });
      expect(isRefusal(out) ? out.field : null).toBe("look");
    }
    const clipsOnly = parseStitchSpec({
      clips: [{ assetId: A }],
      target: "portrait",
      look: "warm",
    });
    expect(isRefusal(clipsOnly) ? clipsOnly.field : null).toBe("look");
  });
});

// ─── The composer's record (PR 15.1, R-4 / D-1 / D-3, docs/probes/composer-boundary.md) ─────────

describe("the composer's record on the spec", () => {
  const PLAN = "0b0b0b0b-1111-4222-8333-444444444444";
  const body = (composer: unknown) => ({
    target: "portrait",
    clips: [{ assetId: A }, { assetId: B, crossfadeSec: 0.5 }],
    composer,
  });
  const good = {
    joins: [
      { key: "agent:n:0:clip", kind: "cut", reason: "position-0" },
      { key: "agent:n:1:clip", kind: "fade", reason: "default-fade" },
    ],
    dropped: [
      {
        row: "agent:n:1",
        slot: "framing",
        value: "wide",
        reason: "photo-decides",
      },
    ],
    planId: PLAN.toUpperCase(),
  };

  it("with the composer on it is stored, rebuilt from known fields, the plan id lower-cased", () => {
    const spec = parseStitchSpec(
      body({
        ...good,
        extra: "never stored",
        joins: good.joins.map((j) => ({ ...j, x: 1 })),
      }),
      true,
      true,
    );
    if (isRefusal(spec)) throw new Error(spec.error);
    expect(spec.composer).toEqual({ ...good, planId: PLAN });
  });

  it("with the composer off it is ignored exactly as an unknown key always was — byte-identical", () => {
    const off = parseStitchSpec(body(good), true, false);
    const none = parseStitchSpec(body(undefined), true, false);
    expect(JSON.stringify(off)).toBe(JSON.stringify(none));
    // …and so is a malformed one: the flag-off door answers exactly as it did before PR 15.1.
    expect(
      isRefusal(parseStitchSpec(body({ joins: "nope" }), true, false)),
    ).toBe(false);
  });

  it("the runner's re-read never parses it — a record must never fail a job she is waiting on", () => {
    const stored = { ...body(good), composer: { joins: [] } }; // stale or malformed on the row
    expect(isRefusal(readStoredSpec(stored))).toBe(false);
  });

  /** ⚠️ MUTATION: accept any string as a join reason — this reds by name. */
  it("a join reason outside the closed set is stored — never: it is a 400 naming the field", () => {
    const bad = (over: object, field: string) => {
      const out = parseStitchSpec(body({ ...good, ...over }), true, true);
      expect(out).toMatchObject({ field });
    };
    bad(
      { joins: [good.joins[0], { ...good.joins[1], reason: "vibes" }] },
      "composer.joins[1].reason",
    );
    bad(
      { joins: [good.joins[0], { ...good.joins[1], kind: "wipe" }] },
      "composer.joins[1].kind",
    );
    bad(
      { joins: [good.joins[0], { ...good.joins[1], key: "<script>" }] },
      "composer.joins[1].key",
    );
    bad({ joins: [good.joins[0]] }, "composer.joins"); // one per clip, or the index is no key
    bad(
      { dropped: [{ ...good.dropped[0], slot: "mood" }] },
      "composer.dropped[0].slot",
    );
    bad(
      { dropped: [{ ...good.dropped[0], value: "fisheye" }] },
      "composer.dropped[0].value",
    );
    bad(
      { dropped: [{ ...good.dropped[0], reason: "because" }] },
      "composer.dropped[0].reason",
    );
    bad({ dropped: "all of them" }, "composer.dropped");
    bad({ planId: "plan-1" }, "composer.planId");
    expect(parseStitchSpec(body([]), true, true)).toMatchObject({
      field: "composer",
    });
  });

  /**
   * THE DRIFT TEST (D-1). The client's join rule and dropped-slot reasons are closed sets on the
   * client; the server copies them. Every answer the client's own functions can give must parse here,
   * and every name here must be one the client can give — so a reason added on one side and not the
   * other reds before it can refuse a stitch.
   */
  it("the client's join reasons and dropped-slot reasons are exactly the server's", () => {
    const joins = new Set<string>();
    for (const index of [0, 1])
      for (const cutIn of [true, false])
        for (const piece of [
          "still",
          "own",
          "clip",
          "bridge",
          "passthrough",
        ] as const)
          for (const afterOwnBridge of [true, false])
            for (const continuation of [true, false])
              for (const onBeat of [true, false])
                for (const rhythm of ["fast", "slow", null] as const) {
                  const d = chooseJoin({
                    index,
                    cutIn,
                    piece,
                    afterOwnBridge,
                    continuation,
                    onBeat,
                    rhythm,
                  });
                  joins.add(d.reason);
                  const out = parseStitchSpec(
                    body({
                      joins: [
                        { key: "k:0", kind: "cut", reason: "position-0" },
                        { key: "k:1", kind: d.kind, reason: d.reason },
                      ],
                      dropped: [],
                    }),
                    true,
                    true,
                  );
                  expect([d.reason, isRefusal(out)]).toEqual([d.reason, false]);
                }
    expect([...joins].sort()).toEqual([...JOIN_REASONS].sort());

    const dropped = new Set<string>();
    const rows: StoryboardRow[] = [
      {
        key: "s",
        assetId: "p",
        thumbUrl: null,
        prompt: "",
        kind: "still",
        hasPerson: false,
        stillSec: 2,
      },
      {
        key: "c",
        assetId: "v",
        thumbUrl: null,
        prompt: "",
        kind: "clip",
        hasPerson: false,
      },
      {
        key: "m",
        assetId: "p",
        thumbUrl: null,
        prompt: "x",
        kind: "motion",
        hasPerson: true,
      },
      {
        key: "b",
        assetId: null,
        thumbUrl: null,
        prompt: "x",
        kind: "broll",
        hasPerson: false,
      },
    ];
    for (const row of rows)
      for (const slot of Object.keys(
        SHOT_SLOTS,
      ) as (keyof typeof SHOT_SLOTS)[]) {
        const reason = droppedSlotReason(row, slot);
        if (reason) dropped.add(reason);
      }
    expect([...dropped].sort()).toEqual([...DROPPED_SLOT_REASONS].sort());
  });
});
