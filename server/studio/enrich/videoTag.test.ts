/**
 * videoTag.test.ts — the pure half: text → tags, beats clamped to the clip.
 *
 * Nothing here touches Vertex. What is under test is the parse contract Half B will read beats
 * through: ordered, inside [0, duration], no inverted beats, and the whole-clip fields in the exact
 * `AssetTags` shape the photo readers expect.
 */
import {
  mergeMicroBeats,
  parseVideoTags,
  secondsOf,
  tagVideo,
  VIDEO_PROMPT,
  type VideoBeat,
} from "./videoTag";
import { mimeFor } from "../../lib/visionTag";

const whole = {
  athlete_present: true,
  athlete_prominence: 0.9,
  shot_type: "action",
  description: "she sprints",
  brands_visible: ["Adidas"],
  aesthetic_quality: 0.8,
  brand_safe: true,
  content_flags: {
    hateful: false,
    sexual: false,
    violence_or_weapons: false,
    drugs_or_alcohol: false,
    self_harm: false,
    obscene_gesture: false,
  },
  setting: "track",
  attire: "kit",
  vibe: "fast",
  hero_suitability: 0.7,
  disposition: "as_is",
  edit_note: "",
  reason: "clear subject",
};
const beat = (
  start_s: unknown,
  end_s: unknown,
  over: Record<string, unknown> = {},
) => ({
  start_s,
  end_s,
  description: "b",
  shot_type: "action",
  athlete_present: true,
  athlete_prominence: 0.9,
  setting: "track",
  attire: "kit",
  vibe: "fast",
  brands_visible: [],
  aesthetic_quality: 0.8,
  camera: "tracking side-on",
  motion: "she sprints left to right",
  hero_suitability: 0.7,
  ...over,
});
const META = {
  model: "test-model",
  taggedAt: new Date("2026-09-22T00:00:00Z"),
};

describe("parseVideoTags — whole-clip fields keep the photo shape", () => {
  it("returns AssetTags fields verbatim plus beats/video, and records the model that read the clip", () => {
    const t = parseVideoTags(
      JSON.stringify({ ...whole, beats: [beat(0, 3.5)] }),
      8,
      META,
    )!;
    expect(t).toMatchObject({
      ...whole,
      video: {
        source: "clip",
        model: "test-model",
        sampled_fps: 1,
        duration_s: 8,
        tagged_at: "2026-09-22T00:00:00.000Z",
      },
    });
    expect(t.beats).toEqual([
      expect.objectContaining({
        start_s: 0,
        end_s: 3.5,
        camera: "tracking side-on",
      }),
    ]);
  });

  it("is null on prose, and null on JSON that is not a clip's tags", () => {
    expect(parseVideoTags("Sure! Here are the tags…", 8, META)).toBeNull();
    expect(parseVideoTags(JSON.stringify({ beats: [] }), 8, META)).toBeNull();
  });

  it("applies the same hard-safety override as the photo tagger — a flagged clip is rejected and unsafe whatever the model said", () => {
    const t = parseVideoTags(
      JSON.stringify({
        ...whole,
        disposition: "as_is",
        brand_safe: true,
        content_flags: { sexual: true },
        beats: [],
      }),
      8,
      META,
    )!;
    expect(t.disposition).toBe("reject");
    expect(t.brand_safe).toBe(false);
  });
});

describe("parseVideoTags — beats are clamped to the clip", () => {
  it("clamps to [0, duration], drops an inverted beat, drops a beat without times, and orders by start", () => {
    const text = JSON.stringify({
      ...whole,
      beats: [
        beat(5, 12), // runs past the 8 s clip → clamped to 8
        beat(3, 1), // inverted → dropped
        beat("x", 2), // unparseable start → dropped
        beat(-1, 2.5), // before the clip → clamped to 0
      ],
    });
    const t = parseVideoTags(text, 8, META)!;
    expect(t.beats.map((b) => [b.start_s, b.end_s])).toEqual([
      [0, 2.5],
      [5, 8],
    ]);
  });

  it("reads MM:SS timestamps when the model answers in its native form", () => {
    expect(secondsOf("01:05")).toBe(65);
    expect(secondsOf("00:03.5")).toBe(3.5);
    expect(secondsOf("1:00:01")).toBe(3601);
    expect(secondsOf("7")).toBe(7);
    expect(secondsOf("soon")).toBeNull();
    const t = parseVideoTags(
      JSON.stringify({ ...whole, beats: [beat("00:02", "00:04")] }),
      8,
      META,
    )!;
    expect(t.beats[0]).toMatchObject({ start_s: 2, end_s: 4 });
  });

  it("with an unknown duration, beats are kept unclamped above and video.duration_s is null — not zero", () => {
    const t = parseVideoTags(
      JSON.stringify({ ...whole, beats: [beat(0, 90)] }),
      0,
      META,
    )!;
    expect(t.beats[0].end_s).toBe(90);
    expect(t.video.duration_s).toBeNull();
  });

  it("a clip whose beats all fail is still a valid whole-clip read with beats: []", () => {
    const t = parseVideoTags(
      JSON.stringify({ ...whole, beats: [beat(4, 4)] }),
      8,
      META,
    )!;
    expect(t.beats).toEqual([]);
    expect(t.description).toBe("she sprints");
  });
});

describe("tagVideo — the transport is handed the clip's real MIME type", () => {
  it("sends video/mp4 for an mp4 and video/quicktime for a mov (mimeFor used to answer image/jpeg for both)", async () => {
    const seen: string[] = [];
    const transport = async (_b: Buffer, mime: string) => {
      seen.push(mime);
      return {
        text: JSON.stringify({ ...whole, beats: [] }),
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "m",
      };
    };
    await tagVideo(
      Buffer.from("x"),
      "athletes/a/uploads/clip.mp4",
      5,
      transport,
    );
    await tagVideo(
      Buffer.from("x"),
      "athletes/a/uploads/clip.MOV",
      5,
      transport,
    );
    expect(seen).toEqual(["video/mp4", "video/quicktime"]);
    expect(mimeFor("a/b.jpg")).toBe("image/jpeg");
    expect(mimeFor("a/b.png")).toBe("image/png");
  });

  it("the prompt carries no caller text — it is a constant, so nothing untrusted can enter it", () => {
    expect(typeof VIDEO_PROMPT).toBe("string");
    expect(VIDEO_PROMPT).toContain("BEATS");
    expect(VIDEO_PROMPT).not.toMatch(/\$\{/);
  });
});

/**
 * ─── PHANTOM SPLITS (enrichment eval grid-1, 22 Sep 2026) ─────────────────────────────────────
 *
 * Fixtures are the five convicted cells' STORED beat sets (times, shot, presence, and paraphrased
 * descriptions), exhibit A's six owner-verified beats, and P006's two real beats.
 *
 * ⚠️ MUTATION, red here by name: make `mergeMicroBeats` return `[...beats]` unconditionally — the
 * five "collapses" cases red; exhibit A and P006 stay green, because they hold the NO-OP and must
 * be green either way. The discriminating tests are the five.
 */

const mk = (
  start_s: number,
  end_s: number,
  description: string,
  over: Partial<VideoBeat> = {},
): VideoBeat => ({
  start_s,
  end_s,
  description,
  shot_type: "other",
  athlete_present: false,
  athlete_prominence: 0,
  setting: "field",
  attire: "none",
  vibe: "quiet",
  brands_visible: [],
  aesthetic_quality: 0.7,
  camera: "static wide",
  motion: "still",
  hero_suitability: 0.5,
  ...over,
});

/** The stored beat sets, as `parseVideoTags` would receive them from the model. */
const PHANTOMS: Record<string, { duration: number; beats: VideoBeat[] }> = {
  P030: {
    duration: 4,
    beats: [
      mk(0, 1, "A ball sits on an empty court before launching upwards.", {
        camera: "static medium shot",
        motion: "ball launches",
      }),
      mk(1, 2, "The ball flies high into a cloudy sky.", {
        camera: "tilt up",
        motion: "ball flies upward",
      }),
      mk(
        2,
        3,
        "The ball floats in space with the curve of the Earth behind it.",
        { camera: "static wide shot", motion: "ball floats" },
      ),
    ],
  },
  P041: {
    duration: 4,
    beats: [
      mk(0, 1, "An empty goal stands on a green pitch under fog."),
      mk(1, 2, "A ball flies through the air towards the goal.", {
        motion: "ball flies",
      }),
      mk(2, 3, "The ball hits the back of the net.", {
        motion: "ball hits the net",
      }),
      mk(3, 4, "The ball settles on the grass inside the goal.", {
        motion: "ball rolls to a stop",
      }),
    ],
  },
  P088: {
    duration: 4,
    beats: [
      mk(0, 1, "Two gold beaded bracelets rest on a white marble surface.", {
        camera: "static close-up",
      }),
      mk(1, 2, "The bracelets are lifted upwards out of the frame.", {
        camera: "static close-up",
        motion: "bracelets move upwards",
      }),
      mk(2, 3, "The empty white marble surface is shown.", {
        camera: "static close-up",
      }),
    ],
  },
  P114: {
    duration: 4,
    beats: [
      mk(
        0,
        1,
        "She poses with both hands on her hips, smiling at the camera.",
        { shot_type: "portrait", athlete_present: true, athlete_prominence: 1 },
      ),
      mk(1, 2, "She adjusts her hair with her right hand.", {
        shot_type: "portrait",
        athlete_present: true,
        athlete_prominence: 1,
      }),
      mk(2, 3, "She waves her right hand towards the camera.", {
        shot_type: "portrait",
        athlete_present: true,
        athlete_prominence: 1,
      }),
      mk(3, 4, "She rests her right hand on her thigh.", {
        shot_type: "portrait",
        athlete_present: true,
        athlete_prominence: 1,
      }),
    ],
  },
  P117: {
    duration: 4,
    beats: [
      mk(0, 1, "She throws the ball up into the air.", {
        shot_type: "action",
        athlete_present: true,
        brands_visible: ["Adidas"],
      }),
      mk(1, 2, "She headers the ball as it comes down.", {
        shot_type: "action",
        athlete_present: true,
      }),
      mk(2, 3, "She watches the ball and resets her stance.", {
        shot_type: "action",
        athlete_present: true,
      }),
    ],
  },
};

/** Exhibit A — six beats, every one ≥ 5 s, on a 51.48 s clip. */
const EXHIBIT_A: VideoBeat[] = [
  mk(0, 9.5, "Sits on the grass, tying her cleats and talking.", {
    shot_type: "lifestyle",
    athlete_present: true,
  }),
  mk(9.5, 14.5, "Stands up and performs a forward bend stretch.", {
    shot_type: "lifestyle",
    athlete_present: true,
  }),
  mk(14.5, 20.5, "Stands with hands on hips, then jogs past the camera.", {
    shot_type: "lifestyle",
    athlete_present: true,
  }),
  mk(20.5, 30.5, "Runs onto the field and starts dribbling.", {
    shot_type: "action",
    athlete_present: true,
  }),
  mk(30.5, 42.5, "Juggles the ball with feet and thighs, then kicks it.", {
    shot_type: "action",
    athlete_present: true,
  }),
  mk(42.5, 50, "Walks back smiling, retrieves the ball from the net.", {
    shot_type: "lifestyle",
    athlete_present: true,
  }),
];

/** P006 — two real beats on a 4 s clip, 1.5 s and 2 s: neither is micro. */
const P006: VideoBeat[] = [
  mk(0, 1.5, "Hands hold the bottle against a green field.", {
    shot_type: "lifestyle",
    athlete_present: true,
    camera: "static close-up",
  }),
  mk(1.5, 3.5, "Hands squeeze the bottle, water spraying.", {
    shot_type: "lifestyle",
    athlete_present: true,
    camera: "static close-up",
  }),
];

const asReply = (beats: VideoBeat[]) =>
  JSON.stringify({
    athlete_present: beats[0]?.athlete_present ?? false,
    athlete_prominence: 0.5,
    shot_type: "other",
    description: "a short clip",
    brands_visible: [],
    aesthetic_quality: 0.7,
    brand_safe: true,
    setting: "field",
    attire: "none",
    vibe: "quiet",
    hero_suitability: 0.5,
    disposition: "as_is",
    edit_note: "",
    reason: "",
    beats,
  });

describe("mergeMicroBeats — phantom splits on short clips collapse, real beats do not", () => {
  it.each(Object.entries(PHANTOMS))(
    "%s collapses to ONE beat through parseVideoTags — first start, last end, nothing the model said thrown away",
    (_code, { duration, beats }) => {
      const tags = parseVideoTags(asReply(beats), duration, { model: "m" });
      expect(tags!.beats).toHaveLength(1);
      const [only] = tags!.beats;
      expect(only.start_s).toBe(beats[0].start_s);
      expect(only.end_s).toBe(beats[beats.length - 1].end_s);
      for (const b of beats) expect(only.description).toContain(b.description);
      expect(only.shot_type).toBe(beats[0].shot_type);
      expect(only.athlete_present).toBe(beats[0].athlete_present);
    },
  );

  it("P117's brands unite and its prominence is the max of the run", () => {
    const [only] = mergeMicroBeats(PHANTOMS.P117.beats, 4);
    expect(only.brands_visible).toEqual(["Adidas"]);
    expect(only.camera).toBe("static wide");
    expect(only.motion).toBe("still");
  });

  it("exhibit A: six beats on a 51.48 s clip are deep-equal through the rule", () => {
    expect(mergeMicroBeats(EXHIBIT_A, 51.48)).toEqual(EXHIBIT_A);
    expect(
      parseVideoTags(asReply(EXHIBIT_A), 51.48, { model: "m" })!.beats,
    ).toEqual(EXHIBIT_A);
  });

  it("P006: 1.5 s and 2 s beats on a 4 s clip are not micro — untouched", () => {
    expect(mergeMicroBeats(P006, 4)).toEqual(P006);
  });

  it("a micro-beat merges only with a micro NEIGHBOUR of the same shape: a shot change or a real beat between them keeps them apart", () => {
    const shape = mergeMicroBeats(
      [
        mk(0, 1, "a", { shot_type: "action" }),
        mk(1, 2, "b", { shot_type: "portrait" }),
        mk(2, 3, "c", { shot_type: "portrait" }),
      ],
      4,
    );
    expect(shape.map((b) => [b.start_s, b.end_s])).toEqual([
      [0, 1],
      [1, 3],
    ]);
    const real = mergeMicroBeats(
      [mk(0, 1, "a"), mk(1, 3, "b"), mk(3, 4, "c")],
      4,
    );
    expect(real.map((b) => [b.start_s, b.end_s])).toEqual([
      [0, 1],
      [1, 3],
      [3, 4],
    ]);
  });

  it("a long clip is never looked at, and an unknown duration is not a short clip", () => {
    const micro = [mk(0, 1, "a"), mk(1, 2, "b")];
    expect(mergeMicroBeats(micro, 9)).toEqual(micro);
    expect(mergeMicroBeats(micro, null)).toEqual(micro);
    expect(mergeMicroBeats(micro, 4)).toHaveLength(1);
  });
});

/**
 * ─── THE ATHLETE, NAMED (22 Sep 2026) ─────────────────────────────────────────────────────────
 * ⚠️ MUTATION, red here by name: collapse the ternary in lib/visionTag.ts `applySubject` —
 * "another_person → athlete_present false" reds.
 */
describe("parseVideoTags — the whole-clip subject decides athlete_present", () => {
  const reply = (over: Record<string, unknown>) =>
    JSON.stringify({
      athlete_prominence: 0.9,
      shot_type: "action",
      description: "a clip",
      brands_visible: [],
      aesthetic_quality: 0.8,
      brand_safe: true,
      setting: "pitch",
      attire: "kit",
      vibe: "fast",
      hero_suitability: 0.8,
      disposition: "as_is",
      edit_note: "",
      reason: "",
      beats: [],
      ...over,
    });

  it("another_person → athlete_present false, the ternary stored; the_athlete → true", () => {
    const other = parseVideoTags(reply({ subject: "another_person" }), 6, {
      model: "m",
    });
    expect(other!.athlete_present).toBe(false);
    expect(other!.subject).toBe("another_person");
    const her = parseVideoTags(reply({ subject: "the_athlete" }), 6, {
      model: "m",
    });
    expect(her!.athlete_present).toBe(true);
    expect(her!.subject).toBe("the_athlete");
    expect(
      parseVideoTags(reply({ subject: "nobody" }), 6, { model: "m" })!
        .athlete_present,
    ).toBe(false);
  });

  it("an older answer with the boolean and no subject still parses; one with neither is null", () => {
    const old = parseVideoTags(reply({ athlete_present: true }), 6, {
      model: "m",
    });
    expect(old!.athlete_present).toBe(true);
    expect(old!.subject).toBeUndefined();
    expect(parseVideoTags(reply({}), 6, { model: "m" })).toBeNull();
  });

  it("tagVideo hands the transport the prompt that names her, and the profile-less one without a profile", async () => {
    const prompts: string[] = [];
    const transport = async (_b: Buffer, _m: string, prompt?: string) => {
      prompts.push(prompt ?? "");
      return {
        text: reply({ subject: "the_athlete" }),
        usage: null,
        model: "m",
      };
    };
    await tagVideo(Buffer.from("x"), "a.mp4", 6, transport, {
      name: "Test Athlete",
      sport: "Soccer",
      team: null,
    });
    await tagVideo(Buffer.from("x"), "a.mp4", 6, transport, null);
    expect(prompts[0]).toContain(
      "THE ATHLETE is Test Athlete, an athlete.",
    );
    expect(prompts[0]).toContain(
      '"subject":"the_athlete|another_person|nobody"',
    );
    expect(prompts[1]).toBe(VIDEO_PROMPT);
    expect(prompts[1]).not.toContain("THE ATHLETE is");
  });
});
