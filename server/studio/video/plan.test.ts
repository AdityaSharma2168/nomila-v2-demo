/**
 * plan.test.ts — the planner is pure, so these run with no ffmpeg and no files.
 *
 * They cover the arithmetic and the graph's shape. The proof that the graph actually
 * WORKS lives in stitch.test.ts, against the real binary — a passing test here only
 * means we emitted what we meant to emit.
 */
import { DEFAULT_BED, planStitch, TIMEBASE } from "./plan";
import type { ClipProbe, StitchClip } from "./types";

function probe(over: Partial<ClipProbe> = {}): ClipProbe {
  return {
    width: 640,
    height: 360,
    fps: 30,
    pixFmt: "yuv420p",
    sampleAspectRatio: "1:1",
    durationSec: 2,
    videoCodec: "h264",
    hasAudio: true,
    audioCodec: "aac",
    sampleRate: 48_000,
    channels: 2,
    ...over,
  };
}

const TARGET = { width: 640, height: 360, fps: 30 };

function plan(
  clips: StitchClip[],
  probes: ClipProbe[],
  extra: Partial<Parameters<typeof planStitch>[0]> = {},
) {
  return planStitch({
    clips,
    probes,
    outputPath: "/tmp/out.mp4",
    target: TARGET,
    ...extra,
  });
}

describe("planStitch — normalization", () => {
  it("stitches heterogeneous resolutions to one frame size", () => {
    const p = plan(
      [{ source: "/a.mp4" }, { source: "/b.mp4" }],
      [
        probe({ width: 1920, height: 1080 }),
        probe({ width: 320, height: 240 }),
      ],
    );
    // Both clips scale into the same box and are padded to fill it exactly.
    expect(p.filterGraph).toContain(
      "scale=640:360:force_original_aspect_ratio=decrease",
    );
    expect(p.filterGraph).toContain(
      "pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black",
    );
    expect(p.clips[0].normalization.scaled).toBe(true);
    expect(p.clips[1].normalization.scaled).toBe(true);
    // 320x240 is 4:3 into a 16:9 target, so it genuinely needs bars; 1920x1080 does not.
    expect(p.clips[1].normalization.padded).toBe(true);
    expect(p.clips[0].normalization.padded).toBe(false);
  });

  it("conforms mixed frame rates", () => {
    const p = plan(
      [{ source: "/a.mp4" }, { source: "/b.mp4" }],
      [probe({ fps: 30 }), probe({ fps: 24 })],
    );
    expect(p.filterGraph.match(/fps=30/g)).toHaveLength(2);
    expect(p.clips[0].normalization.fpsChanged).toBe(false);
    expect(p.clips[1].normalization.fpsChanged).toBe(true);
  });

  it("corrects non-square pixel aspect ratio", () => {
    const p = plan(
      [{ source: "/square.mp4" }, { source: "/anamorphic.mp4" }],
      [
        probe({ sampleAspectRatio: "1:1" }),
        probe({ sampleAspectRatio: "2:1", width: 640, height: 480 }),
      ],
    );
    // The squaring step is conditional: only the anamorphic clip gets it.
    expect(p.filterGraph.match(/scale=iw\*sar:ih/g)).toHaveLength(1);
    expect(p.clips[0].normalization.sarCorrected).toBe(false);
    expect(p.clips[1].normalization.sarCorrected).toBe(true);
  });

  it("normalizes pixel format across clips", () => {
    const p = plan(
      [{ source: "/a.mp4" }, { source: "/b.mp4" }],
      [probe({ pixFmt: "yuv420p" }), probe({ pixFmt: "yuv422p" })],
    );
    expect(p.filterGraph.match(/format=yuv420p/g)).toHaveLength(2);
    expect(p.clips[1].normalization.pixFmtChanged).toBe(true);
  });

  it("rebases timestamps after a trim", () => {
    const p = plan([{ source: "/a.mp4", trimStartSec: 0.5 }], [probe()]);
    // Without this the seeked clip keeps its original PTS and lands in the wrong place.
    // Anchored to the VIDEO chain: a bare "setpts=PTS-STARTPTS" is also a substring of the
    // audio chain's "asetpts=PTS-STARTPTS", so the loose form stays green with the video
    // step deleted and proves nothing.
    expect(p.filterGraph).toContain("format=yuv420p,setpts=PTS-STARTPTS");
  });

  it("synthesizes silence for a clip with no audio track", () => {
    const p = plan(
      [{ source: "/withaudio.mp4" }, { source: "/mute.mp4" }],
      [
        probe({ hasAudio: true }),
        probe({
          hasAudio: false,
          durationSec: 1.5,
          audioCodec: null,
          sampleRate: null,
          channels: null,
        }),
      ],
    );
    expect(p.args.join(" ")).toContain(
      "anullsrc=channel_layout=stereo:sample_rate=48000",
    );
    expect(p.clips[1].normalization.silenceSynthesized).toBe(true);
    expect(p.clips[0].normalization.silenceSynthesized).toBe(false);
    // The silence is bounded to the clip it stands in for.
    expect(p.args.join(" ")).toContain("-t 1.5");
  });

  it("produces a video-only output when nothing carries audio", () => {
    const p = plan(
      [{ source: "/a.mp4" }, { source: "/b.mp4" }],
      [probe({ hasAudio: false }), probe({ hasAudio: false })],
    );
    expect(p.hasAudio).toBe(false);
    expect(p.args.join(" ")).not.toContain("anullsrc");
    expect(p.args).not.toContain("-c:a");
  });
});

describe("planStitch — timeline", () => {
  it("adds clip durations on a cut", () => {
    const p = plan(
      [{ source: "/a.mp4" }, { source: "/b.mp4" }, { source: "/c.mp4" }],
      [
        probe({ durationSec: 2 }),
        probe({ durationSec: 1.5 }),
        probe({ durationSec: 1 }),
      ],
    );
    expect(p.expectedDurationSec).toBe(4.5);
  });

  it("crossfade overlaps rather than appends", () => {
    const p = plan(
      [
        { source: "/a.mp4" },
        {
          source: "/b.mp4",
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
        {
          source: "/c.mp4",
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      [
        probe({ durationSec: 2 }),
        probe({ durationSec: 1.5 }),
        probe({ durationSec: 1 }),
      ],
    );
    // 2 + 1.5 + 1 = 4.5 raw, minus 0.5 per fade.
    expect(p.expectedDurationSec).toBe(3.5);
    // Offsets come off the same accumulator: first fade starts at 2.0-0.5, second at 3.0-0.5.
    expect(p.filterGraph).toContain(
      "xfade=transition=fade:duration=0.5:offset=1.5",
    );
    expect(p.filterGraph).toContain(
      "xfade=transition=fade:duration=0.5:offset=2.5",
    );
  });

  it("joins a cut and a crossfade in one chain", () => {
    const p = plan(
      [
        { source: "/a.mp4" },
        { source: "/b.mp4" },
        {
          source: "/c.mp4",
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      [
        probe({ durationSec: 2 }),
        probe({ durationSec: 1.5 }),
        probe({ durationSec: 1 }),
      ],
    );
    expect(p.expectedDurationSec).toBe(4);
    // concat emits timebase 1/1000000 and xfade refuses a mismatch, so the concat node's
    // output must be pinned before the crossfade can consume it.
    expect(p.filterGraph).toContain(`[vc1]settb=${TIMEBASE}`);
    expect(p.filterGraph).toContain(`[ac1]asettb=${TIMEBASE}`);
    // ...and the fade that follows it is offset off the post-cut accumulator (3.5 - 0.5).
    expect(p.filterGraph).toContain("duration=0.5:offset=3[vx2]");
  });

  it("derives trim windows as absolute source timestamps", () => {
    const p = plan(
      [{ source: "/a.mp4", trimStartSec: 0.5, trimEndSec: 1.5 }],
      [probe({ durationSec: 2 })],
    );
    const args = p.args.join(" ");
    expect(args).toContain("-ss 0.5");
    expect(args).toContain("-to 1.5");
    expect(p.expectedDurationSec).toBe(1);
    expect(p.clips[0].effectiveDurationSec).toBe(1);
  });

  it("clamps a trim end past the end of the source", () => {
    const p = plan(
      [{ source: "/a.mp4", trimStartSec: 1, trimEndSec: 99 }],
      [probe({ durationSec: 2 })],
    );
    expect(p.expectedDurationSec).toBe(1);
    expect(p.clips[0].trim).toEqual({ startSec: 1, endSec: 2 });
  });
});

describe("planStitch — rejections", () => {
  it("rejects a crossfade longer than its clips", () => {
    expect(() =>
      plan(
        [
          { source: "/a.mp4" },
          {
            source: "/b.mp4",
            transitionIn: { kind: "crossfade", durationSec: 2 },
          },
        ],
        [probe({ durationSec: 2 }), probe({ durationSec: 1 })],
      ),
    ).toThrow(/does not fit/);
  });

  it("rejects a URL source rather than letting ffmpeg fail deep", () => {
    expect(() =>
      plan(
        [{ source: "https://storage.googleapis.com/x/clip.mp4" }],
        [probe()],
      ),
    ).toThrow(/must be a local file path/);
  });

  it("rejects a trim that leaves no duration", () => {
    expect(() =>
      plan(
        [{ source: "/a.mp4", trimStartSec: 2, trimEndSec: 2 }],
        [probe({ durationSec: 2 })],
      ),
    ).toThrow(/no duration after trim/);
  });

  it("rejects odd target dimensions", () => {
    expect(() =>
      planStitch({
        clips: [{ source: "/a.mp4" }],
        probes: [probe()],
        outputPath: "/tmp/o.mp4",
        target: { width: 641, height: 360, fps: 30 },
      }),
    ).toThrow(/must be even/);
  });

  it("rejects an empty clip list", () => {
    expect(() => plan([], [])).toThrow(/at least one clip/);
  });
});

describe("planStitch — audio bed", () => {
  it("lays the bed under the programme without extending it", () => {
    const p = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: { source: "/bed.m4a", level: 0.3 },
    });
    expect(p.filterGraph).toContain("volume=0.3");
    // duration=first clamps to the programme so a long or looped bed can't lengthen the cut.
    expect(p.filterGraph).toContain(
      "amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    );
    expect(p.args).toContain("-stream_loop");
    expect(p.audioBed).toEqual({
      source: "/bed.m4a",
      level: 0.3,
      ducked: false,
      looped: true,
      coversSec: 2,
    });
  });

  it("ducks the bed under programme audio only when asked", () => {
    const flat = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: { source: "/bed.m4a" },
    });
    expect(flat.filterGraph).not.toContain("sidechaincompress");
    expect(flat.audioBed!.ducked).toBe(false);

    const ducked = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: { source: "/bed.m4a", duck: {} },
    });
    expect(ducked.filterGraph).toContain("sidechaincompress");
    // The programme is split so it can be both heard and used as the sidechain key.
    expect(ducked.filterGraph).toContain("asplit=2[prog][sc]");
    expect(ducked.audioBed!.ducked).toBe(true);
  });

  it("emits no duck when no clip SOUNDS — a silent-clip stitch keeps its flat graph, byte for byte", () => {
    const silent = [probe({ hasAudio: false })];
    const asked = plan([{ source: "/a.mp4" }], silent, {
      audioBed: { source: "/bed.m4a", duck: {} },
    });
    const flat = plan([{ source: "/a.mp4" }], silent, {
      audioBed: { source: "/bed.m4a" },
    });
    expect(asked.filterGraph).toBe(flat.filterGraph);
    expect(asked.args).toEqual(flat.args);
    expect(asked.audioBed!.ducked).toBe(false);

    // Muted is silent, to everything downstream: her mute on the one sounding clip un-ducks it too.
    const muted = plan([{ source: "/a.mp4", muted: true }], [probe()], {
      audioBed: { source: "/bed.m4a", duck: {} },
    });
    expect(muted.filterGraph).not.toContain("sidechaincompress");
  });

  it("converts the duck threshold from dBFS to the linear value sidechaincompress wants", () => {
    const p = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: { source: "/bed.m4a", duck: { thresholdDb: -20 } },
    });
    // 10^(-20/20) = 0.1
    expect(p.filterGraph).toContain("threshold=0.1");
  });

  it("gives a bed its default level and duck shape", () => {
    const p = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: { source: "/bed.m4a", duck: {} },
    });
    expect(p.filterGraph).toContain(`volume=${DEFAULT_BED.level}`);
    expect(p.filterGraph).toContain(`ratio=${DEFAULT_BED.duck.ratio}`);
  });

  it("forces an audio track onto a silent timeline when a bed is present", () => {
    const p = plan([{ source: "/mute.mp4" }], [probe({ hasAudio: false })], {
      audioBed: { source: "/bed.m4a" },
    });
    expect(p.hasAudio).toBe(true);
    expect(p.args.join(" ")).toContain("anullsrc");
  });
});

describe("planStitch — a picture laid over a clip", () => {
  const OV = { source: "/tmp/cap-1.png", y: 252 };

  it("changes NOTHING for a timeline without one — same argv, same graph", () => {
    // The whole safety argument for adding this to a working engine: a stitch she could make
    // yesterday is planned byte-for-byte the same today.
    const clips = [{ source: "/tmp/a.mp4" }, { source: "/tmp/b.mp4" }];
    const probes = [probe(), probe({ hasAudio: false })];
    const bed = { audioBed: { source: "/tmp/bed.m4a" } };
    const before = plan(clips, probes, bed);
    const after = plan(
      clips.map((c) => ({ ...c, overlay: undefined })),
      probes,
      bed,
    );
    expect(after.args).toEqual(before.args);
    expect(before.filterGraph).not.toContain("overlay");
    expect(before.clips.every((c) => !("overlay" in c))).toBe(true);
  });

  it("puts overlay inputs AFTER the clips, the silence and the bed, so no existing index moves", () => {
    const p = plan(
      [
        { source: "/tmp/a.mp4", overlay: OV },
        { source: "/tmp/b.mp4" },
        { source: "/tmp/c.mp4", overlay: { source: "/tmp/cap-2.png", y: 10 } },
      ],
      [probe(), probe({ hasAudio: false }), probe()],
      { audioBed: { source: "/tmp/bed.m4a" } },
    );
    const inputs = p.args.filter((_, i) => p.args[i - 1] === "-i");
    expect(inputs).toEqual([
      "/tmp/a.mp4",
      "/tmp/b.mp4",
      "/tmp/c.mp4",
      expect.stringContaining("anullsrc"),
      "/tmp/bed.m4a",
      "/tmp/cap-1.png",
      "/tmp/cap-2.png",
    ]);
    // 3 clips + 1 silence + 1 bed = the first picture is input 5, the second 6.
    expect(p.filterGraph).toContain("[vb0][5:v]overlay=0:252:format=auto");
    expect(p.filterGraph).toContain("[vb2][6:v]overlay=0:10:format=auto");
    // The bed is still where it was.
    expect(p.filterGraph).toContain("[4:a]");
    // And the clip without one is conformed straight to its label, as before.
    expect(p.filterGraph).toMatch(/\[1:v\][^;]*\[v1\]/);
    expect(p.filterGraph).not.toContain("[vb1]");
  });

  it("lays it over the clip BEFORE the join, so it is cut and crossfaded with its clip", () => {
    const p = plan(
      [
        { source: "/tmp/a.mp4", overlay: OV },
        {
          source: "/tmp/b.mp4",
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      [probe(), probe()],
    );
    const g = p.filterGraph;
    // Present, THEN earlier: indexOf answers -1 for a missing node, and -1 is less than anything —
    // without the first line this passes with the overlay deleted (it did, under revert check).
    expect(g.indexOf("overlay=")).toBeGreaterThanOrEqual(0);
    expect(g.indexOf("overlay=")).toBeLessThan(g.indexOf("xfade="));
    // The join consumes the overlaid label, not the bare one.
    expect(g).toContain("[v0][v1]xfade=");
    // No timeline arithmetic: no enable= window to get wrong.
    expect(g).not.toContain("enable=");
  });

  it("records it in the manifest, and only for the clip that has one", () => {
    const p = plan(
      [{ source: "/tmp/a.mp4", overlay: OV }, { source: "/tmp/b.mp4" }],
      [probe(), probe()],
    );
    expect(p.clips[0].overlay).toEqual(OV);
    expect("overlay" in p.clips[1]).toBe(false);
  });

  it("refuses a URL and a y that is not a whole, non-negative pixel", () => {
    const bad = (overlay: { source: string; y: number }) => () =>
      plan([{ source: "/tmp/a.mp4", overlay }], [probe()]);
    expect(bad({ source: "https://x.test/cap.png", y: 0 })).toThrow(
      /local file path/,
    );
    expect(bad({ source: "/tmp/c.png", y: -2 })).toThrow(/overlay y/);
    expect(bad({ source: "/tmp/c.png", y: 1.5 })).toThrow(/overlay y/);
    expect(bad({ source: "/tmp/c.png", y: Number.NaN })).toThrow(/overlay y/);
  });
});

describe("planStitch — where the bed starts", () => {
  const bedAt = (startSec?: number) =>
    plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: {
        source: "/bed.m4a",
        ...(startSec === undefined ? {} : { startSec }),
      },
    });

  it("changes NOTHING for a bed she did not move — same argv, same graph, same manifest", () => {
    const unmoved = bedAt();
    expect(bedAt(0).args).toEqual(unmoved.args);
    expect(unmoved.filterGraph).not.toContain("atrim");
    expect("startSec" in unmoved.audioBed!).toBe(false);
  });

  it("starts it with a FILTER after the loop, never an input seek", () => {
    // THE ONLY GUARD ON THE FORM. In this graph on ffmpeg 9.0.1 an input `-ss` and `atrim` sound
    // identical (revert check: swapping them left the real-ffmpeg test green), so that test cannot
    // hold this line — it holds the BEHAVIOUR. See plan.ts for why the filter form is the one kept:
    // outside a filter graph the input seek re-seeks on every loop, and a form whose meaning
    // changes with context is not one to rely on across ffmpeg versions.
    const p = bedAt(45.5);
    expect(p.filterGraph).toMatch(
      /\[1:a\]atrim=start=45\.5,asetpts=PTS-STARTPTS,aformat=/,
    );
    // The bed's input is still looped, and carries no seek of its own.
    const i = p.args.indexOf("/bed.m4a");
    expect(p.args.slice(i - 3, i)).toEqual(["-stream_loop", "-1", "-i"]);
    expect(p.audioBed!.startSec).toBe(45.5);
  });

  it("refuses a negative or non-finite start before spawning anything", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bedAt(bad)).toThrow(/startSec/);
    }
  });
});

describe("planStitch — a muted clip", () => {
  it("changes NOTHING when no clip is muted — same argv, same graph", () => {
    const clips = [{ source: "/a.mp4" }, { source: "/b.mp4" }];
    const probes = [probe(), probe()];
    expect(
      plan(
        clips.map((c) => ({ ...c, muted: false })),
        probes,
      ).args,
    ).toEqual(plan(clips, probes).args);
  });

  it("takes the SILENCE path a clip with no audio track already takes — no second mechanism", () => {
    const p = plan(
      [{ source: "/a.mp4", muted: true }, { source: "/b.mp4" }],
      [probe(), probe()],
    );
    // Its audio comes from the synthesized-silence input (index 2), not from its own file...
    expect(p.filterGraph).toContain("[2:a]");
    expect(p.filterGraph).not.toMatch(/\[0:a\]/);
    // ...while its PICTURE still does, and the other clip is untouched.
    expect(p.filterGraph).toMatch(/\[0:v\]/);
    expect(p.filterGraph).toMatch(/\[1:a\]/);
    expect(p.clips[0].normalization.silenceSynthesized).toBe(true);
    expect(p.clips[1].normalization.silenceSynthesized).toBe(false);
  });

  it("makes a video with NO audio stream at all when every clip is muted and there is no bed", () => {
    const p = plan(
      [
        { source: "/a.mp4", muted: true },
        { source: "/b.mp4", muted: true },
      ],
      [probe(), probe()],
    );
    expect(p.hasAudio).toBe(false);
    expect(p.args).not.toContain("-c:a");
  });

  it("still carries the bed when every clip is muted", () => {
    const p = plan([{ source: "/a.mp4", muted: true }], [probe()], {
      audioBed: { source: "/bed.m4a" },
    });
    expect(p.hasAudio).toBe(true);
    expect(p.filterGraph).toContain("[bed]");
  });
});
