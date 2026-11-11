/**
 * boardStitch.test.ts — the Board's pieces joined into one video, and what she is told first.
 *
 * The body is asserted on the WIRE (what `toStitchBody` emits), because that is what the stitch
 * runner acts on: a crossfade that exists in a local object and not in the body is a promise the
 * Board made and the video breaks.
 */
import { boardStitch, type StitchPiece } from "./boardStitch";
import { DEFAULT_CROSSFADE_SEC } from "./stitchLogic";
import {
  heldClipRow,
  heldPhotoRow,
  setStillFocus,
  setCut,
  type StoryboardRow,
} from "./storyboardLogic";
import type { VideoEntryView } from "./videoEntryLogic";

const ready = (assetId: string): VideoEntryView =>
  ({
    phase: "ready",
    label: "Ready",
    working: false,
    clips: [
      {
        assetId,
        mediaType: "VIDEO",
        uri: null,
        removed: false,
        editable: false,
        rejected: false,
      },
    ],
  }) as VideoEntryView;
const failed: VideoEntryView = {
  phase: "failed",
  label: "That one didn't work",
  working: false,
  clips: [],
};

const clip = (key: string, n: number): StitchPiece => ({
  key,
  kind: "clip",
  label: `Shot ${n}`,
});
const bridge = (key: string, n: number): StitchPiece => ({
  key,
  kind: "bridge",
  label: `Bridge into shot ${n}`,
});

const wire = (body: Record<string, unknown> | null) =>
  (body?.clips as {
    assetId: string;
    crossfadeSec?: number;
    stillSec?: number;
    trimStartSec?: number;
    trimEndSec?: number;
    muted?: true;
  }[]) ?? [];

/** A shot row for a piece key — what the run's pieces were made from. */
const shot = (key: string): StoryboardRow => ({
  key,
  assetId: `photo-${key}`,
  thumbUrl: null,
  prompt: "Something happens.",
  kind: "motion",
  hasPerson: true,
});
/** Rows for a piece list: one shot per distinct key, in first-seen order. */
const rowsOf = (pieces: StitchPiece[]): StoryboardRow[] =>
  [...new Set(pieces.map((p) => p.key))].map(shot);
/** The old call shape — rows derived from the pieces — for the tests written before stills. */
const stitchPieces = (
  pieces: StitchPiece[],
  views: Record<string, VideoEntryView>,
  passthrough: { assetId: string; posterUrl: string | null }[],
  maxClips: number | null,
) => boardStitch(rowsOf(pieces), pieces, views, passthrough, maxClips);

describe("boardStitch", () => {
  /**
   * ⚠️ MUTATION: drop the crossfade on unbridged joins. This reds, and nothing else does.
   *
   * The Board says "Crossfade · free" on every join she did not bridge. The stitch body must ask for
   * exactly that — a cut would be the Board breaking its own word in the finished video.
   */
  it("every join she did not bridge fades, exactly as the Board promised — the first clip does not", () => {
    const out = stitchPieces(
      [clip("k1", 1), clip("k2", 2), clip("k3", 3)],
      {
        "k1:clip": ready("a1"),
        "k2:clip": ready("a2"),
        "k3:clip": ready("a3"),
      },
      [],
      12,
    );
    expect(wire(out.body)).toEqual([
      { assetId: "a1" },
      { assetId: "a2", crossfadeSec: DEFAULT_CROSSFADE_SEC },
      { assetId: "a3", crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
    expect(out.body?.target).toBe("portrait");
    expect(out.label).toBe("Stitch these 3 clips");
  });

  it("a made bridge is the join — cuts on both its edges, never a fade across it", () => {
    const out = stitchPieces(
      [clip("k1", 1), bridge("k2", 2), clip("k2", 2)],
      {
        "k1:clip": ready("a1"),
        "k2:bridge": ready("b2"),
        "k2:clip": ready("a2"),
      },
      [],
      12,
    );
    expect(wire(out.body)).toEqual([
      { assetId: "a1" },
      { assetId: "b2" },
      { assetId: "a2" },
    ]);
  });

  it("stitches what was made, counts it on the button and names every piece left out", () => {
    const out = stitchPieces(
      [clip("k1", 1), bridge("k2", 2), clip("k2", 2), clip("k3", 3)],
      {
        "k1:clip": ready("a1"),
        "k2:bridge": failed,
        "k2:clip": ready("a2"),
        "k3:clip": failed,
      },
      [],
      12,
    );
    expect(out.label).toBe("Stitch 2 of 4");
    expect(out.skipped).toEqual(["Bridge into shot 2", "Shot 3"]);
    // What was made, in playing order — the missing pieces are named above, never silently skipped.
    // (The failed bridge's join falls back to the free crossfade; the fade itself is pinned by the
    // first test, so this one holds only WHICH clips go in.)
    expect(wire(out.body).map((c) => c.assetId)).toEqual(["a1", "a2"]);
  });

  it("puts her videos at the end, in the order she picked them, on free joins", () => {
    const out = stitchPieces(
      [clip("k1", 1)],
      { "k1:clip": ready("a1") },
      [
        { assetId: "v2", posterUrl: null },
        { assetId: "v1", posterUrl: null },
      ],
      12,
    );
    expect(wire(out.body)).toEqual([
      { assetId: "a1" },
      { assetId: "v2", crossfadeSec: DEFAULT_CROSSFADE_SEC },
      { assetId: "v1", crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
    expect(out.label).toBe("Stitch these 3 clips");
  });

  it("re-checks the clip limit at the button — and sends nothing over it", () => {
    const pieces = [clip("k1", 1), clip("k2", 2)];
    const views = { "k1:clip": ready("a1"), "k2:clip": ready("a2") };
    const videos = [{ assetId: "v1", posterUrl: null }];
    expect(stitchPieces(pieces, views, videos, 3).refusal).toBeNull();
    const over = stitchPieces(pieces, views, videos, 2);
    expect(over.refusal).toMatch(/3 clips — one video can join up to 2/);
    expect(over.body).toBeNull();
  });

  it("refuses when nothing on the board was made — her videos alone are not the Board's to stitch", () => {
    const out = stitchPieces(
      [clip("k1", 1)],
      { "k1:clip": failed },
      [{ assetId: "v1", posterUrl: null }],
      12,
    );
    expect(out.refusal).toMatch(/nothing to stitch/);
    expect(out.body).toBeNull();
  });
});

describe("boardStitch with stills — a piece that always exists, at its row", () => {
  const still = (key: string, stillSec = 2, assetId = `photo-${key}`) =>
    heldPhotoRow(key, assetId, null, stillSec);

  /**
   * ⚠️ RC-C1b-9 — MUTATION: place the stills after the generated pieces (or before them) instead
   * of at their rows. This reds.
   *
   * A still is slotted where she put it. "Product close-up · 2s" at beat 3 is at beat 3 in the video,
   * between the shots on either side of it — not tacked on the end like her videos.
   */
  it("stills slot in row order, between the shots around them, held for their seconds", () => {
    const rows = [shot("k1"), still("s", 3), shot("k2")];
    const out = boardStitch(
      rows,
      [clip("k1", 1), clip("k2", 3)],
      { "k1:clip": ready("a1"), "k2:clip": ready("a2") },
      [],
      12,
    );
    expect(wire(out.body)).toEqual([
      { assetId: "a1" },
      { assetId: "photo-s", stillSec: 3, crossfadeSec: DEFAULT_CROSSFADE_SEC },
      { assetId: "a2", crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
    expect(out.label).toBe("Stitch these 3 clips");
    expect(out.made).toBe(3);
    expect(out.total).toBe(3);
  });

  it("a still survives a failed neighbour — the shot is named as left out, the still stays put", () => {
    const rows = [shot("k1"), still("s"), shot("k2")];
    const out = boardStitch(
      rows,
      [clip("k1", 1), clip("k2", 3)],
      { "k1:clip": failed, "k2:clip": ready("a2") },
      [],
      12,
    );
    expect(out.skipped).toEqual(["Shot 1"]);
    expect(out.label).toBe("Stitch 2 of 3");
    expect(wire(out.body).map((c) => c.assetId)).toEqual(["photo-s", "a2"]);
    // First in the video now, so it fades from nothing.
    expect(wire(out.body)[0].crossfadeSec).toBeUndefined();
  });

  it("an all-still board stitches — no run, no pieces, nothing left out", () => {
    const rows = [still("a", 2), still("b", 5)];
    const out = boardStitch(rows, [], {}, [], 12);
    expect(out.refusal).toBeNull();
    expect(wire(out.body)).toEqual([
      { assetId: "photo-a", stillSec: 2 },
      { assetId: "photo-b", stillSec: 5, crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
    expect(out.label).toBe("Stitch these 2 clips");
  });

  it("a Cut beside a still is a cut on the wire, in and out; Fade is the free crossfade", () => {
    const rows = setCut(
      setCut([shot("k1"), still("s"), shot("k2")], 1, true),
      2,
      true,
    );
    const out = boardStitch(
      rows,
      [clip("k1", 1), clip("k2", 3)],
      { "k1:clip": ready("a1"), "k2:clip": ready("a2") },
      [],
      12,
    );
    expect(wire(out.body)).toEqual([
      { assetId: "a1" },
      { assetId: "photo-s", stillSec: 2 },
      { assetId: "a2" },
    ]);
  });

  it("a 1 s still fading both ways is refused in the server's words, and a Cut on one side clears it", () => {
    const rows = [shot("k1"), still("s", 1), shot("k2")];
    const pieces = [clip("k1", 1), clip("k2", 3)];
    const views = { "k1:clip": ready("a1"), "k2:clip": ready("a2") };
    const refused = boardStitch(rows, pieces, views, [], 12);
    expect(refused.refusal).toMatch(/held for 1s and its fades take 1s/);
    expect(refused.body).toBeNull();
    const cut = boardStitch(setCut(rows, 2, true), pieces, views, [], 12);
    expect(cut.refusal).toBeNull();
  });

  it("her videos still go last, after the stills, and every kind counts against the clip limit", () => {
    const rows = [still("a"), shot("k1")];
    const pieces = [clip("k1", 2)];
    const views = { "k1:clip": ready("a1") };
    const videos = [{ assetId: "v1", posterUrl: null }];
    const out = boardStitch(rows, pieces, views, videos, 3);
    expect(wire(out.body).map((c) => c.assetId)).toEqual([
      "photo-a",
      "a1",
      "v1",
    ]);
    expect(out.refusal).toBeNull();
    const over = boardStitch(rows, pieces, views, videos, 2);
    expect(over.refusal).toMatch(/3 clips — one video can join up to 2/);
    expect(over.body).toBeNull();
  });
});

// ─── One of her clips at its row (C2 Half B) ───────────────────────────────────────────────────

describe("boardStitch with her own clips — a piece that always exists, at its row, with its window", () => {
  const own = (
    key: string,
    trim: { startSec: number; endSec: number } | null,
    keepSound: boolean,
  ) => heldClipRow(key, `clip-${key}`, null, trim, 6.5, keepSound);

  /**
   * ⚠️ MUTATION: drop the trim from the clip's position, or send it unmuted when she muted it, or
   * place it at the end with her videos. Each reds here.
   */
  it("goes in at its row as a video position: the beat's window on the wire, muted unless she kept its sound, on the free fade", () => {
    const rows = [
      shot("k1"),
      own("c1", { startSec: 3, endSec: 6.5 }, false),
      own("c2", null, true),
      shot("k3"),
    ];
    const pieces = [clip("k1", 1), clip("k3", 3)];
    const out = boardStitch(
      rows,
      pieces,
      { "k1:clip": ready("m1"), "k3:clip": ready("m3") },
      [],
      12,
    );
    expect(out.refusal).toBeNull();
    expect(wire(out.body)).toEqual([
      { assetId: "m1" },
      {
        assetId: "clip-c1",
        trimStartSec: 3,
        trimEndSec: 6.5,
        muted: true,
        crossfadeSec: DEFAULT_CROSSFADE_SEC,
      },
      { assetId: "clip-c2", crossfadeSec: DEFAULT_CROSSFADE_SEC },
      { assetId: "m3", crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
    expect(out).toMatchObject({
      made: 4,
      total: 4,
      skipped: [],
      label: "Stitch these 4 clips",
    });
  });

  it("a clip-only board stitches — nothing to run; and a Cut beside it is a cut on the wire", () => {
    const rows = setCut(
      [own("c1", null, true), own("c2", null, true)],
      1,
      true,
    );
    const out = boardStitch(rows, [], {}, [], 12);
    expect(out.refusal).toBeNull();
    expect(wire(out.body)).toEqual([
      { assetId: "clip-c1" },
      { assetId: "clip-c2" },
    ]);
    expect(out.label).toBe("Stitch these 2 clips");
  });

  it("survives a failed neighbour, and counts against the clip limit like every kind", () => {
    const rows = [shot("k1"), own("c1", null, true)];
    const out = boardStitch(
      rows,
      [clip("k1", 1)],
      { "k1:clip": failed },
      [{ assetId: "v1", posterUrl: null }],
      2,
    );
    expect(out.skipped).toEqual(["Shot 1"]);
    expect(wire(out.body).map((c) => c.assetId)).toEqual(["clip-c1", "v1"]);
    expect(out.label).toBe("Stitch 2 of 3");
    expect(
      boardStitch(
        rows,
        [clip("k1", 1)],
        { "k1:clip": ready("m1") },
        [{ assetId: "v1", posterUrl: null }],
        2,
      ).refusal,
    ).toMatch(/up to 2/);
  });
});

describe("boardStitch with a pushed-in still — the motion rides the position (C3, D2)", () => {
  /** ⚠️ MUTATION: drop `stillMotion` from the still position in boardStitch — this reds by name. */
  it("a still row with a push-in sends stillMotion beside its hold; a dead still sends none", () => {
    const rows = [
      heldPhotoRow("s1", "photo-1", null, 4, "dolly"),
      heldPhotoRow("s2", "photo-2", null, 2),
    ];
    const out = boardStitch(rows, [], {}, [], 12);
    expect(wire(out.body)).toEqual([
      { assetId: "photo-1", stillSec: 4, stillMotion: "dolly" },
      { assetId: "photo-2", stillSec: 2, crossfadeSec: DEFAULT_CROSSFADE_SEC },
    ]);
  });
});

describe("boardStitch with a move toward a point — the point rides the position (PR 5, A1)", () => {
  /** ⚠️ MUTATION: drop `stillFocus` from the still position in boardStitch — this reds by name. */
  it("a zoom with her point sends motion and point; a punch with none sends the motion alone", () => {
    const rows = setStillFocus(
      [
        heldPhotoRow("s1", "photo-1", null, 3, "zoom"),
        heldPhotoRow("s2", "photo-2", null, 2, "punch"),
      ],
      0,
      { x: 0.3, y: 0.25 },
    );
    const out = boardStitch(rows, [], {}, [], 12);
    expect(wire(out.body)).toEqual([
      {
        assetId: "photo-1",
        stillSec: 3,
        stillMotion: "zoom",
        stillFocus: { x: 0.3, y: 0.25 },
      },
      {
        assetId: "photo-2",
        stillSec: 2,
        stillMotion: "punch",
        crossfadeSec: DEFAULT_CROSSFADE_SEC,
      },
    ]);
  });
});

describe("boardStitch with music — a track by name, and a stills edit cut on its beat (PR 5, A2)", () => {
  const grid = { bpm: 85, firstBeatSec: 0.004 };
  const limits = { minStillSec: 1, maxStillSec: 8 };
  const stills = () => [
    heldPhotoRow("s1", "photo-1", null, 2, "zoom"),
    heldPhotoRow("s2", "photo-2", null, 2),
    heldPhotoRow("s3", "photo-3", null, 3, "punch"),
  ];

  /**
   * ⚠️ MUTATION "grid ignored": boardStitch skips the snap — this reds by name (holds 2, 2, 3 and the
   * fades still in the body; no row on the beat).
   */
  it("on the beat: the bed rides by name, the holds are whole beats in whole frames, the joins are cuts, every row is on the beat", () => {
    const out = boardStitch(
      stills(),
      [],
      {},
      [],
      12,
      { bed: "doodles", grid, onBeat: true },
      limits,
    );
    expect(out.body).toMatchObject({ bed: "doodles" });
    const clips = wire(out.body);
    // 3 beats of 0.7059 s ends nearest 2 s; 4 beats nearest 3 s — each end rounded to a frame.
    expect(clips.map((c) => c.stillSec)).toEqual([64 / 30, 63 / 30, 85 / 30]);
    expect(clips.some((c) => "crossfadeSec" in c)).toBe(false);
    expect(Object.keys(out.beat)).toEqual(["s1", "s2", "s3"]);
    expect(Object.values(out.beat).every((b) => b.onBeat)).toBe(true);
    expect(out.beat.s1.beats).toBe(3);
    expect(out.beat.s3.beats).toBe(4);
  });

  it("music without the beat: the bed rides by name and her holds and fades are exactly hers", () => {
    const out = boardStitch(
      stills(),
      [],
      {},
      [],
      12,
      { bed: "doodles", grid, onBeat: false },
      limits,
    );
    expect(out.body).toMatchObject({ bed: "doodles" });
    expect(wire(out.body).map((c) => [c.stillSec, c.crossfadeSec])).toEqual([
      [2, undefined],
      [2, DEFAULT_CROSSFADE_SEC],
      [3, DEFAULT_CROSSFADE_SEC],
    ]);
    expect(out.beat).toEqual({});
  });

  it("a bed nobody has measured can be laid under the video but not cut to", () => {
    const out = boardStitch(
      stills(),
      [],
      {},
      [],
      12,
      { bed: "doodles", grid: null, onBeat: true },
      limits,
    );
    expect(wire(out.body).map((c) => c.stillSec)).toEqual([2, 2, 3]);
    expect(out.beat).toEqual({});
  });
});

describe("boardStitch with a look — one grade over every photo, by name (PR 5, A3)", () => {
  /** ⚠️ MUTATION: boardStitch drops the look from the body — this reds by name. */
  it("a look rides the body beside photos; with no photo on the board it is not sent", () => {
    const withPhotos = boardStitch(
      [heldPhotoRow("s1", "photo-1", null, 2)],
      [],
      {},
      [],
      12,
      null,
      null,
      "teal-orange",
    );
    expect(withPhotos.body).toMatchObject({ look: "teal-orange" });
    const asIs = boardStitch(
      [heldPhotoRow("s1", "photo-1", null, 2)],
      [],
      {},
      [],
      12,
    );
    expect(asIs.body && "look" in asIs.body).toBe(false);
  });
});

// ─── THE COMPOSER (PR 15, R-1, docs/probes/composer.md) ─────────────────────────────────────────

describe("boardStitch with the composer — joins by rule, each with its reason", () => {
  const A = ready("clip-a");
  const B = ready("clip-b");
  const C = ready("clip-c");
  const two = [clip("k1", 1), clip("k2", 2), clip("k3", 3)];
  const views = { "k1:clip": A, "k2:clip": B, "k3:clip": C };
  /** A bed with a trusted grid, as /stitch/options serves one. */
  const bedOnBeat = {
    bed: "walking-around",
    grid: { bpm: 120, firstBeatSec: 0 },
    onBeat: true,
  };
  const limits = { minStillSec: 1, maxStillSec: 8 };

  /**
   * P-off / ⚠️ MUTATION: route the joins through `chooseJoin` with `composer` null — "composer
   * renders with STUDIO_COMPOSER off" reds by name: the body must be byte-identical to today's.
   */
  it("composer renders with STUDIO_COMPOSER off — never: with `composer` null the body is byte-identical and `joins` is empty", () => {
    const rows = rowsOf(two);
    const before = boardStitch(rows, two, views, [], null);
    const off = boardStitch(rows, two, views, [], null, null, null, null, null);
    expect(JSON.stringify(off.body)).toBe(JSON.stringify(before.body));
    expect(off.joins).toEqual({});
    // And on: a slow reading gives the same wire (every free join a fade) — with reasons now. Since
    // PR 15.1 the body also carries the composer's RECORD (never read by ffmpeg); everything else in
    // it is byte-identical, and the record is the only extra key.
    const on = boardStitch(rows, two, views, [], null, null, null, null, {
      rhythm: { pace: "slow", matched: "long takes", ref: "ref_1" },
    });
    const { composer: record, ...wireOnly } = on.body as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(wireOnly)).toBe(JSON.stringify(before.body));
    expect(record).toBeDefined();
    expect(on.joins).toEqual({
      "k1:clip": { kind: "cut", reason: "position-0" },
      "k2:clip": { kind: "fade", reason: "rhythm-slow" },
      "k3:clip": { kind: "fade", reason: "rhythm-slow" },
    });
  });

  /** ⚠️ MUTATION: ignore `composer.rhythm` in `joinInto` — this reds by name. */
  it("editing_rhythm never chooses a join — it does (P-join): a fast reading turns today's fades into cuts, each recorded", () => {
    const rows = rowsOf(two);
    const flat = boardStitch(rows, two, views, [], null);
    expect(wire(flat.body).map((c) => c.crossfadeSec)).toEqual([
      undefined,
      DEFAULT_CROSSFADE_SEC,
      DEFAULT_CROSSFADE_SEC,
    ]);
    const fast = boardStitch(rows, two, views, [], null, null, null, null, {
      rhythm: { pace: "fast", matched: "fast cuts", ref: "ref_1" },
    });
    expect(wire(fast.body).map((c) => c.crossfadeSec)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(fast.joins).toEqual({
      "k1:clip": { kind: "cut", reason: "position-0" },
      "k2:clip": { kind: "cut", reason: "rhythm-fast" },
      "k3:clip": { kind: "cut", reason: "rhythm-fast" },
    });
    for (const j of Object.values(fast.joins)) expect(j.reason).not.toBe("");
  });

  /** ⚠️ MUTATION: compute `onBeatEdit` without `music.onBeat` — this reds by name. */
  it("on-beat toggle ignored at a cut — never: with a track on the beat every free join is a cut, and off the beat the same board fades", () => {
    const rows = rowsOf(two);
    const on = boardStitch(
      rows,
      two,
      views,
      [],
      null,
      bedOnBeat,
      limits,
      null,
      {
        rhythm: null,
      },
    );
    expect(wire(on.body).map((c) => c.crossfadeSec)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(on.joins["k2:clip"]).toEqual({ kind: "cut", reason: "on-beat" });
    const off = boardStitch(
      rows,
      two,
      views,
      [],
      null,
      { ...bedOnBeat, onBeat: false },
      limits,
      null,
      { rhythm: null },
    );
    expect(wire(off.body).map((c) => c.crossfadeSec)).toEqual([
      undefined,
      DEFAULT_CROSSFADE_SEC,
      DEFAULT_CROSSFADE_SEC,
    ]);
    expect(off.joins["k2:clip"]).toEqual({
      kind: "fade",
      reason: "default-fade",
    });
    // A bed nobody has measured cannot be cut to: no grid, no on-beat cuts.
    const noGrid = boardStitch(
      rows,
      two,
      views,
      [],
      null,
      { ...bedOnBeat, grid: null },
      limits,
      null,
      { rhythm: null },
    );
    expect(noGrid.joins["k2:clip"]).toEqual({
      kind: "fade",
      reason: "default-fade",
    });
  });

  /** ⚠️ MUTATION: pass `cutIn: false` from the still site — this reds by name. */
  it("her explicit Cut is overridden — never (P-cut): a Cut beside a still stays a cut under a slow reading, and a Fade there is the reading's", () => {
    const still = heldPhotoRow("s1", "photo-s1", null, 2);
    const rows = [shot("k1"), still, shot("k2")];
    const pieces = [clip("k1", 1), clip("k2", 2)];
    const v = { "k1:clip": A, "k2:clip": B };
    const slow = {
      rhythm: { pace: "slow" as const, matched: "long takes", ref: "" },
    };
    const cut = boardStitch(
      setCut(rows, 1, true),
      pieces,
      v,
      [],
      null,
      null,
      null,
      null,
      slow,
    );
    expect(wire(cut.body)[1].crossfadeSec).toBeUndefined();
    expect(cut.joins["s1:still"]).toEqual({ kind: "cut", reason: "her-cut" });
    const faded = boardStitch(
      rows,
      pieces,
      v,
      [],
      null,
      null,
      null,
      null,
      slow,
    );
    expect(wire(faded.body)[1].crossfadeSec).toBe(DEFAULT_CROSSFADE_SEC);
    expect(faded.joins["s1:still"]).toEqual({
      kind: "fade",
      reason: "rhythm-slow",
    });
    // Her Cut also beats the music's beat and a fast reading — it is hers.
    const cutOnBeat = boardStitch(
      setCut(rows, 1, true),
      pieces,
      v,
      [],
      null,
      bedOnBeat,
      limits,
      null,
      { rhythm: { pace: "fast", matched: "fast cuts", ref: "" } },
    );
    expect(cutOnBeat.joins["s1:still"]).toEqual({
      kind: "cut",
      reason: "her-cut",
    });
  });

  /** ⚠️ MUTATION: fade position 0 with the composer on — this reds by name. */
  it("position 0 gets a crossfade — never: the first position is 'position-0' under every reading", () => {
    const rows = rowsOf(two);
    for (const rhythm of [null, "fast", "slow"] as const) {
      const out = boardStitch(rows, two, views, [], null, null, null, null, {
        rhythm: rhythm ? { pace: rhythm, matched: "x", ref: "" } : null,
      });
      expect(wire(out.body)[0].crossfadeSec).toBeUndefined();
      expect(out.joins["k1:clip"]).toEqual({
        kind: "cut",
        reason: "position-0",
      });
    }
  });

  /** ⚠️ MUTATION: pass `piece: "clip"` for a bridge, or `afterOwnBridge: false` — this reds by name. */
  it("a generated bridge's join is overridden — never: the bridge's edges and the clip after it are cuts under a slow reading", () => {
    const pieces = [clip("k1", 1), bridge("k2", 2), clip("k2", 2)];
    const v = { "k1:clip": A, "k2:bridge": ready("bridge-2"), "k2:clip": B };
    const out = boardStitch(
      rowsOf(pieces),
      pieces,
      v,
      [],
      null,
      null,
      null,
      null,
      {
        rhythm: { pace: "slow", matched: "long takes", ref: "" },
      },
    );
    expect(wire(out.body).map((c) => c.crossfadeSec)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(out.joins["k2:bridge"]).toEqual({
      kind: "cut",
      reason: "bridge-edge",
    });
    expect(out.joins["k2:clip"]).toEqual({
      kind: "cut",
      reason: "after-own-bridge",
    });
  });

  it("a continuation is a cut: a still followed by its own animation, and two beats of one clip", () => {
    // The still of photo-k2, then the clip made from photo-k2.
    const still = heldPhotoRow("s2", "photo-k2", null, 2);
    const rows = [shot("k1"), still, shot("k2")];
    const pieces = [clip("k1", 1), clip("k2", 2)];
    const v = { "k1:clip": A, "k2:clip": B };
    const out = boardStitch(rows, pieces, v, [], null, null, null, null, {
      rhythm: null,
    });
    expect(out.joins["s2:still"]).toEqual({
      kind: "fade",
      reason: "default-fade",
    });
    expect(out.joins["k2:clip"]).toEqual({
      kind: "cut",
      reason: "continuation",
    });
    // Two beats of one clip, at their rows.
    const beat1 = heldClipRow(
      "c1",
      "clip-x",
      null,
      { startSec: 0, endSec: 3 },
      10,
      false,
      null,
    );
    const beat2 = heldClipRow(
      "c2",
      "clip-x",
      null,
      { startSec: 3, endSec: 6 },
      10,
      false,
      null,
    );
    const clips = boardStitch(
      [beat1, beat2],
      [],
      {},
      [],
      null,
      null,
      null,
      null,
      {
        rhythm: null,
      },
    );
    expect(clips.joins["c2:own"]).toEqual({
      kind: "cut",
      reason: "continuation",
    });
    expect(wire(clips.body)[1].crossfadeSec).toBeUndefined();
  });

  it("her appended videos take the rule too — a fast reading cuts them in, and the default fades them", () => {
    const rows = rowsOf([clip("k1", 1)]);
    const pass = [{ assetId: "own-1", posterUrl: null }];
    const fast = boardStitch(
      rows,
      [clip("k1", 1)],
      { "k1:clip": A },
      pass,
      null,
      null,
      null,
      null,
      {
        rhythm: { pace: "fast", matched: "fast cuts", ref: "" },
      },
    );
    expect(fast.joins["passthrough:own-1"]).toEqual({
      kind: "cut",
      reason: "rhythm-fast",
    });
    const plain = boardStitch(
      rows,
      [clip("k1", 1)],
      { "k1:clip": A },
      pass,
      null,
      null,
      null,
      null,
      {
        rhythm: null,
      },
    );
    expect(plain.joins["passthrough:own-1"]).toEqual({
      kind: "fade",
      reason: "default-fade",
    });
    expect(wire(plain.body)[1].crossfadeSec).toBe(DEFAULT_CROSSFADE_SEC);
  });
});

// ─── THE RECORD LEAVES THE CLIENT (PR 15.1, R-4, docs/probes/composer-boundary.md) ─────────────

describe("boardStitch with the composer — the record rides the body", () => {
  const PLAN = "0b0b0b0b-1111-4222-8333-444444444444";
  const views = { "k2:clip": ready("clip-b"), "k2:bridge": ready("bridge-b") };
  const rows: StoryboardRow[] = [
    {
      ...heldPhotoRow("k1", "photo-1", null, 3),
      droppedSlots: [
        { slot: "composition", value: "centered", reason: "nothing-filmed" },
      ],
    },
    {
      ...shot("k2"),
      bridgeRequested: true,
      droppedSlots: [
        { slot: "framing", value: "wide", reason: "photo-decides" },
        { slot: "motion", value: "running", reason: "in-her-sentence" },
      ],
    },
  ];
  const pieces = [bridge("k2", 2), clip("k2", 2)];

  it("carries one join per clip, in playing order, agreeing with the wire — and every row's dropped slots, and the plan", () => {
    const out = boardStitch(rows, pieces, views, [], null, null, null, null, {
      rhythm: null,
      planId: PLAN,
    });
    const body = out.body as Record<string, unknown>;
    const record = body.composer as {
      joins: { key: string; kind: string; reason: string }[];
      dropped: unknown[];
      planId?: string;
    };
    const clips = wire(out.body);
    expect(record.joins.map((j) => j.key)).toEqual([
      "k1:still",
      "k2:bridge",
      "k2:clip",
    ]);
    expect(record.joins).toHaveLength(clips.length);
    // The record describes the wire it rides with: a fade exactly where the wire crossfades.
    record.joins.forEach((j, i) =>
      expect([i, j.kind]).toEqual([
        i,
        clips[i].crossfadeSec !== undefined ? "fade" : "cut",
      ]),
    );
    expect(record.joins.map((j) => j.reason)).toEqual([
      "position-0",
      "bridge-edge",
      "after-own-bridge",
    ]);
    expect(record.dropped).toEqual([
      {
        row: "k1",
        slot: "composition",
        value: "centered",
        reason: "nothing-filmed",
      },
      { row: "k2", slot: "framing", value: "wide", reason: "photo-decides" },
      {
        row: "k2",
        slot: "motion",
        value: "running",
        reason: "in-her-sentence",
      },
    ]);
    expect(record.planId).toBe(PLAN);
  });

  it("a hand-built board carries no plan id, and a board with no drops an empty list", () => {
    const out = boardStitch(
      [shot("k2")],
      [clip("k2", 2)],
      views,
      [],
      null,
      null,
      null,
      null,
      { rhythm: null },
    );
    expect((out.body as Record<string, unknown>).composer).toEqual({
      joins: [{ key: "k2:clip", kind: "cut", reason: "position-0" }],
      dropped: [],
    });
  });

  it("with the composer off the body has no record, even on rows that dropped slots", () => {
    const out = boardStitch(rows, pieces, views, [], null);
    expect(out.body).not.toHaveProperty("composer");
  });
});
