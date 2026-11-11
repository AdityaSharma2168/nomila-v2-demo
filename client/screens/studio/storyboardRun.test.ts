/**
 * What a board ASKS FOR — the point where it becomes money.
 *
 * Which asset anchors a clip and which one it arrives at decides the routed model and therefore the
 * price, so these are pinned for the same reason the quote arithmetic is.
 */
import {
  boardRequests,
  bridgeRequestFor,
  clipRequestFor,
  priceBoard,
  quoteRowPieces,
  rowActionView,
  rowPiecesSignature,
  rowQuoteFrom,
  rowRequests,
  runBoardPieces,
  runRowPieces,
  withRowFix,
  type BoardPiece,
  type BoardRunIo,
  type PiecesQuote,
} from "./storyboardRun";
import {
  rowSignature,
  setAudio,
  setBridge,
  setPrompt,
  type StoryboardRow,
  heldPhotoRow,
  heldClipRow,
} from "./storyboardLogic";
import { seedRowsFrom } from "./agentLogic";
import type {
  AgentPlanItem,
  GenerationPreview,
  PreviewRequest,
} from "../../hooks/use-studio";

const row = (over: Partial<StoryboardRow> = {}): StoryboardRow => ({
  key: "k1",
  assetId: "a1",
  thumbUrl: null,
  prompt: "She walks into the light.",
  kind: "motion",
  hasPerson: false,
  ...over,
});

const board = (): StoryboardRow[] => [
  row({ key: "k1", assetId: "a1" }),
  row({ key: "k2", assetId: "a2" }),
  row({ key: "k3", assetId: "a3" }),
];

/**
 * ⚠️ MUTATION (PR 14): drop `planId` from clipRequestFor / bridgeRequestFor — "a brief do-not absent
 * from the clip request" reds by name: the server can only freeze the plan's constraints onto a clip
 * that names its plan.
 */
describe("the carrier: a planned Board's requests name their plan", () => {
  const PLAN = "00000000-0000-4000-8000-000000000014";

  it("every clip request carries planId when one is given, and none when it is not", () => {
    const rows = board();
    expect(clipRequestFor(rows[0], "grow-following", PLAN).planId).toBe(PLAN);
    expect("planId" in clipRequestFor(rows[0], "grow-following")).toBe(false);
    expect("planId" in clipRequestFor(rows[0], "grow-following", null)).toBe(
      false,
    );
    const all = boardRequests(rows, "grow-following", PLAN);
    expect(all.map((r) => r.request.planId)).toEqual([PLAN, PLAN, PLAN]);
    expect(
      boardRequests(rows, "grow-following").map((r) => r.request.planId),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("a bridge carries it too — the plan's constraints bind a bridge", () => {
    const [a, b] = board();
    const withBridge = { ...b, bridgeRequested: true };
    expect(
      bridgeRequestFor(withBridge, a, "grow-following", PLAN)!.planId,
    ).toBe(PLAN);
    expect("planId" in bridgeRequestFor(withBridge, a, "grow-following")!).toBe(
      false,
    );
    const reqs = boardRequests([a, withBridge], "grow-following", PLAN);
    expect(reqs.map((r) => [r.kind, r.request.planId])).toEqual([
      ["clip", PLAN],
      ["bridge", PLAN],
      ["clip", PLAN],
    ]);
  });

  it("with no plan the body is exactly what it always was", () => {
    expect(clipRequestFor(row(), "grow-following", null)).toEqual(
      clipRequestFor(row(), "grow-following"),
    );
  });
});

describe("clipRequestFor", () => {
  it("anchors the clip on the row's own still, and carries her sentence", () => {
    const r = clipRequestFor(row(), "grow-following");
    expect(r.intent).toBe("video.generate");
    expect(r.deliverable).toBe("clip");
    expect(r.references).toEqual([{ assetId: "a1", role: "person" }]);
    expect(r.direction).toBe("She walks into the light.");
    // ⚠️ AN ORDINARY CLIP NAMES NO DESTINATION. Sending one here would make every row a transition
    // and route the whole board to Kling.
    expect(r.lastFrameAssetId).toBeUndefined();
  });

  /**
   * ⚠️ SOUND IS A PRICE, AND ON A PERSON ROW IT IS DOUBLE. Veo's audio SKU is 2x its silent one
   * ($0.40/s against $0.20/s); on a b-roll row it is free, because seedance is priced per video
   * token and `video_tokens_without_audio` equals `video_tokens`. Either way the server decides the
   * arm — this pins only that her tap travels.
   *
   * MUTATION: drop the `audio` spread from `clipRequestFor`. This reds.
   */
  it("carries sound when she asked for it", () => {
    expect(clipRequestFor(row({ audio: true }), "grow-following").audio).toBe(
      true,
    );
  });

  // Only `true` travels, so a silent row sends the body it always sent — and a brief frozen before
  // any of this existed plans identically to one frozen with sound off.
  it("sends no audio KEY when she did not", () => {
    expect("audio" in clipRequestFor(row(), "grow-following")).toBe(false);
  });

  it("trims her sentence, so whitespace is not a direction", () => {
    expect(
      clipRequestFor(row({ prompt: "  hi  " }), "grow-following").direction,
    ).toBe("hi");
  });
});

/**
 * ⚠️ THE MONEY TEST. Two paid boards ran every b-roll shot on Veo at $0.80 — a 2.18x overcharge
 * against seedance's $0.3667 — because `clipRequestFor` hardcoded `role: "person"` and never read
 * `row.kind` at all. `shotTypeFor` returns `identity` for any brief carrying a person role, and
 * `videoRouteFor("identity")` is Veo. The pill changed the label and nothing else.
 */
describe("the shot kind decides the reference role", () => {
  it("a product row travels as `object`, which is what routes it to seedance — the bytes a photo-bearing b-roll row sent before b-roll became words", () => {
    const r = clipRequestFor(
      row({ kind: "product", hasPerson: false }),
      "grow-following",
    );
    expect(r.references).toEqual([{ assetId: "a1", role: "object" }]);
    // Re-pinned 22 Sep 2026: the request is identical under either name — only the Board's word
    // for it changed, so a quote made for one is a quote for the other.
    expect(r).toEqual(
      clipRequestFor(
        row({ kind: "broll", hasPerson: false }),
        "grow-following",
      ),
    );
  });

  it("a motion row travels as `person`, which is what routes it to Veo", () => {
    const r = clipRequestFor(
      row({ kind: "motion", hasPerson: true }),
      "grow-following",
    );
    expect(r.references).toEqual([{ assetId: "a1", role: "person" }]);
  });

  /**
   * Routing-inert — a `lastFrame` forces `transition` whatever the references say — but the brief is
   * the provenance record now, and a frozen brief claiming a photograph of a ball is her likeness is
   * false on the record even when nothing reads it.
   */
  it("a bridge carries the PREVIOUS row's kind, not a hardcoded person", () => {
    const a = row({
      key: "k1",
      assetId: "a1",
      kind: "product",
      hasPerson: false,
    });
    const b = row({ key: "k2", assetId: "a2", bridgeRequested: true });
    expect(bridgeRequestFor(b, a, "grow-following")!.references).toEqual([
      { assetId: "a1", role: "object" },
    ]);
  });
});

describe("bridgeRequestFor", () => {
  /**
   * ⚠️ MUTATION: swap the two assets — `references: [row]` and `lastFrameAssetId: previous`. This
   * reds, and the clip would run backwards: it would start where it was meant to arrive.
   */
  it("starts at the PREVIOUS still and arrives at this row's", () => {
    const [a, b] = board();
    const r = bridgeRequestFor(
      { ...b, bridgeRequested: true },
      a,
      "grow-following",
    )!;
    expect(r.references).toEqual([{ assetId: "a1", role: "person" }]);
    expect(r.lastFrameAssetId).toBe("a2");
  });

  it("carries NO direction of its own", () => {
    const [a, b] = board();
    const r = bridgeRequestFor(
      { ...b, bridgeRequested: true },
      a,
      "grow-following",
    )!;
    // The transition template names no destination on purpose — the last frame is the destination —
    // and a sentence borrowed from either neighbour could disagree with the frame it was handed.
    expect(r.direction).toBe("");
  });

  it("is null when nothing was asked for, and null at the front of the board", () => {
    const [a, b] = board();
    expect(bridgeRequestFor(b, a, "grow-following")).toBeNull();
    expect(
      bridgeRequestFor(
        { ...a, bridgeRequested: true },
        undefined,
        "grow-following",
      ),
    ).toBeNull();
  });
});

describe("boardRequests", () => {
  it("is one clip per row when no bridge is asked for", () => {
    const out = boardRequests(board(), "grow-following");
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.kind === "clip")).toBe(true);
    expect(out.map((o) => o.key)).toEqual(["k1", "k2", "k3"]);
  });

  /**
   * ⚠️ MUTATION: emit the clip before its bridge. This reds.
   *
   * A bridge PLAYS before the clip it arrives at, and the run is sequential — so a board that
   * stopped halfway would leave the finished pieces out of order on the timeline.
   */
  it("emits a bridge BEFORE the clip it arrives at", () => {
    const out = boardRequests(setBridge(board(), 1, true), "grow-following");
    expect(out.map((o) => `${o.key}:${o.kind}`)).toEqual([
      "k1:clip",
      "k2:bridge",
      "k2:clip",
      "k3:clip",
    ]);
  });

  it("a bridge on every eligible join is three pieces for two shots", () => {
    const rows = setBridge(setBridge(board(), 1, true), 2, true);
    const out = boardRequests(rows, "grow-following");
    expect(out.filter((o) => o.kind === "bridge")).toHaveLength(2);
    expect(out).toHaveLength(5);
  });

  it("never emits a bridge for row 0, whatever the row says", () => {
    // Belt and braces over `normalizeBoard`: even a row that somehow carries the flag at position 0
    // has nothing before it, so there is no request to make.
    const rows = board();
    rows[0] = { ...rows[0], bridgeRequested: true };
    const out = boardRequests(rows, "grow-following");
    expect(out.filter((o) => o.kind === "bridge")).toHaveLength(0);
  });
});

describe("a still row asks for nothing", () => {
  const still = (key: string) => heldPhotoRow(key, `asset-${key}`, null, 2);

  /**
   * ⚠️ RC-C1b-2 — MUTATION: let `boardRequests` push a clip for a still row (drop the early return).
   * This reds — and so does everything that makes a still $0, because a request is a preview, a
   * quote, an admission and a spend.
   */
  it("boardRequests skips a still — no clip, no bridge, and the shots around it are untouched", () => {
    const rows = [row({ key: "k1" }), still("s"), row({ key: "k3" })];
    const out = boardRequests(rows, "grow-following");
    expect(out.map((o) => `${o.key}:${o.kind}`)).toEqual([
      "k1:clip",
      "k3:clip",
    ]);
    expect(boardRequests([still("a"), still("b")], "grow-following")).toEqual(
      [],
    );
  });

  it("a bridge is never built into or out of a still, whatever the row says", () => {
    const flagged = { ...still("s"), bridgeRequested: true };
    expect(
      bridgeRequestFor(flagged, row({ key: "k1" }), "grow-following"),
    ).toBeNull();
    expect(
      bridgeRequestFor(
        { ...row({ key: "k2" }), bridgeRequested: true },
        still("s"),
        "grow-following",
      ),
    ).toBeNull();
  });

  it("clipRequestFor refuses a still outright rather than pricing a photo nobody animates", () => {
    expect(() => clipRequestFor(still("s"), "grow-following")).toThrow(/still/);
  });
});

/**
 * ─── PR A'S PROMISE, ENFORCED BY A TEST INSTEAD OF BY CONSTRUCTION ─────────────────────────────
 *
 * The admission body is the preview ids of `boardRequests`, in order, and `runBoardPieces` admits
 * exactly those before the first spend. Until C1b that was true by construction only. The fixture
 * below was RECORDED FROM MAIN at 35a6ca2 (the media-picker merge, before any still existed) by
 * running main's own `boardRequests` and `runBoardPieces` on this board; the branch's code must
 * produce the same bytes for the same board, and the same admit log — a still-free board is not
 * allowed to notice that stills exist.
 */
describe("a board without stills asks for exactly what it asked for before stills existed", () => {
  const stillFree = (): StoryboardRow[] => [
    row({
      key: "k1",
      assetId: "a1",
      prompt: "She walks into the light.",
      kind: "motion",
      hasPerson: true,
      audio: true,
      shot: { movement: "orbit" },
    }),
    row({
      key: "k2",
      assetId: "a2",
      prompt: "The ball rolls.",
      // `product` since 22 Sep 2026 — the row main called "broll with a photo". Same bytes: the
      // fixture below is unchanged, which is the point of recording it.
      kind: "product",
      hasPerson: false,
      bridgeRequested: true,
    }),
    row({
      key: "k3",
      assetId: null,
      prompt: "Rain on a bench.",
      kind: "broll",
      hasPerson: false,
      shot: { environment: "gym", framing: "wide" },
    }),
  ];
  const RECORDED_ON_MAIN =
    '[{"key":"k1","kind":"clip","request":{"intent":"video.generate","deliverable":"clip","objective":"grow-following","direction":"She walks into the light.","references":[{"assetId":"a1","role":"person"}],"shot":{"movement":"orbit"},"audio":true}},{"key":"k2","kind":"bridge","request":{"intent":"video.generate","deliverable":"clip","objective":"grow-following","direction":"","references":[{"assetId":"a1","role":"person"}],"lastFrameAssetId":"a2"}},{"key":"k2","kind":"clip","request":{"intent":"video.generate","deliverable":"clip","objective":"grow-following","direction":"The ball rolls.","references":[{"assetId":"a2","role":"object"}]}},{"key":"k3","kind":"clip","request":{"intent":"video.generate","deliverable":"clip","objective":"grow-following","direction":"Rain on a bench.","references":[],"shot":{"environment":"gym","framing":"wide"}}}]';
  const ADMIT_LOG_ON_MAIN =
    "admit:p0,p1,p2,p3|generate:p0|generate:p1|generate:p2|generate:p3";

  const runLog = async (rows: StoryboardRow[]) => {
    const reqs = boardRequests(rows, "grow-following");
    const pieces: BoardPiece[] = reqs.map((r) => ({
      key: r.key,
      kind: r.kind,
      label: `${r.key}:${r.kind}`,
    }));
    const previews: Record<string, string> = {};
    reqs.forEach((r, i) => (previews[`${r.key}:${r.kind}`] = `p${i}`));
    const log: string[] = [];
    await runBoardPieces(pieces, previews, {
      admit: async (ids) => {
        log.push(`admit:${ids.join(",")}`);
        return { maxJobUsd: 10 };
      },
      generate: async (id) => {
        log.push(`generate:${id}`);
        return { jobId: `j-${id}` };
      },
      onPiece: () => {},
    });
    return log.join("|");
  };

  it("the requests are byte-identical to main's, and so is the admit-then-spend log", async () => {
    expect(JSON.stringify(boardRequests(stillFree(), "grow-following"))).toBe(
      RECORDED_ON_MAIN,
    );
    expect(await runLog(stillFree())).toBe(ADMIT_LOG_ON_MAIN);
  });

  /**
   * ⚠️ RC-C1b-6 — MUTATION: let `runBoardPieces` admit an empty piece list (drop its empty guard,
   * or have the guard call `io.admit([])` first). This reds.
   *
   * An all-still board has no pieces: nothing to price, nothing to admit, nothing to spend. It
   * never reaches admission — the stitch panel is its button, not "Make the board".
   */
  it("an all-still board never calls admit — there is nothing to admit", async () => {
    const stills = [
      heldPhotoRow("s1", "a1", null, 2),
      heldPhotoRow("s2", "a2", null, 5),
    ];
    const reqs = boardRequests(stills, "grow-following");
    expect(reqs).toEqual([]);
    const log: string[] = [];
    const out = await runBoardPieces(
      [],
      {},
      {
        admit: async (ids) => {
          log.push(`admit:${ids.join(",")}`);
          return { maxJobUsd: 10 };
        },
        generate: async (id) => {
          log.push(`generate:${id}`);
          return { jobId: `j-${id}` };
        },
        onPiece: () => {},
      },
    );
    expect(out.ran).toBe(false);
    expect(log).toEqual([]);
  });

  it("a still between two shots changes nothing about what the shots ask for, or what is admitted", async () => {
    const [k1, k2, k3] = stillFree();
    // After k2, not before it: k2's bridge starts from k1's photo, and a still dragged between
    // them takes that bridge away (normalizeBoard, and bridgeRequestFor's own guard) — which is the
    // rule, not a regression. Between k2 and k3 there is no bridge to disturb.
    const withStill = [k1, k2, heldPhotoRow("s", "photo", null, 3), k3];
    expect(JSON.stringify(boardRequests(withStill, "grow-following"))).toBe(
      RECORDED_ON_MAIN,
    );
    expect(await runLog(withStill)).toBe(ADMIT_LOG_ON_MAIN);
  });
});

describe("an image-less row is text-to-video", () => {
  const textRow = (over = {}) =>
    row({ assetId: null, kind: "broll" as const, hasPerson: false, ...over });

  /**
   * ⚠️ MUTATION: send a reference with a null assetId, or fall back to some placeholder. This reds.
   *
   * No references at all is what MAKES it t2v. The chain tolerates the empty array end to end —
   * measured — and quotes the same as i2v b-roll.
   */
  it("sends no references at all", () => {
    const r = clipRequestFor(textRow(), "grow-following");
    expect(r.references).toEqual([]);
    expect(r.intent).toBe("video.generate");
    expect(r.direction).toBe("She walks into the light.");
  });

  /**
   * ⚠️ MUTATION: allow a bridge whose previous row has no image. This reds.
   *
   * A bridge needs somewhere to START. From an image-less row there is no frame, so the "bridge"
   * would be an ordinary t2v clip wearing a transition's name — the exact mislabelling shotType.ts
   * refused to ship a transition for.
   */
  it("cannot be bridged FROM — there is no frame to start at", () => {
    const prev = textRow({ key: "k1" });
    const next = row({ key: "k2", assetId: "a2", bridgeRequested: true });
    expect(bridgeRequestFor(next, prev, "grow-following")).toBeNull();
  });

  it("cannot be bridged INTO either — there is no frame to arrive at", () => {
    const prev = row({ key: "k1", assetId: "a1" });
    const next = textRow({ key: "k2", bridgeRequested: true });
    expect(bridgeRequestFor(next, prev, "grow-following")).toBeNull();
  });

  it("still contributes its clip to the board's requests", () => {
    const out = boardRequests(
      [row({ key: "k1", assetId: "a1" }), textRow({ key: "k2" })],
      "grow-following",
    );
    expect(out.map((o) => `${o.key}:${o.kind}`)).toEqual([
      "k1:clip",
      "k2:clip",
    ]);
    expect(out[1].request.references).toEqual([]);
  });
});

/**
 * ─── THE SHOT SLOTS TRAVEL — THE HOP WHERE `kind` DIED ─────────────────────────────────────────
 *
 * `clipRequestFor` builds its request field by field, so a row field it does not name does not
 * travel and nothing errors. That is exactly how the shot kind never left the client (485cb6f).
 *
 * MUTATION: remove `...shotFor(row)` from `clipRequestFor`. "a row's slots travel" reds.
 * MUTATION: make `shotFor` return the row's spec unfiltered. "a photo row sends movement and
 * nothing else" reds.
 */
describe("the shot slots travel with the clip", () => {
  const textRow = (over: Partial<StoryboardRow> = {}) =>
    row({ assetId: null, kind: "broll", hasPerson: false, ...over });

  it("a row's slots travel on its clip request", () => {
    const shot = {
      framing: "wide",
      movement: "orbit",
      lighting: "overcast",
      environment: "gym",
    } as const;
    expect(clipRequestFor(textRow({ shot }), "grow-following").shot).toEqual(
      shot,
    );
  });

  it("a row with none sends NO `shot` key — absent means byte-identical", () => {
    expect("shot" in clipRequestFor(row(), "grow-following")).toBe(false);
    expect("shot" in clipRequestFor(row({ shot: {} }), "grow-following")).toBe(
      false,
    );
  });

  // The second lock: a row that reached here without going through `setShotSlot`.
  it("a photo row sends movement and nothing else, whatever the row object holds", () => {
    const stale = row({
      shot: { movement: "push-in", lighting: "stadium", framing: "close" },
    });
    expect(clipRequestFor(stale, "grow-following").shot).toEqual({
      movement: "push-in",
    });
  });

  it("a BRIDGE carries no slots — a transition refuses every one of them", () => {
    const [a, b] = board();
    const r = bridgeRequestFor(
      { ...b, bridgeRequested: true, shot: { movement: "orbit" } },
      a,
      "grow-following",
    );
    // Not null first: `"shot" in null` throws, and a bridge that silently stopped being built would
    // otherwise read as "carries no slots".
    expect(r).not.toBeNull();
    expect("shot" in (r as object)).toBe(false);
  });
});

/**
 * ⚠️ THE #538 ASSERTION, IN THE TERM THAT CHANGES WHAT SHE IS CHARGED.
 *
 * "Make the board" runs the previewIds the last quote stored. A field that travels in the request
 * but is missing from `rowSignature` re-quotes nothing: the stored previewId still points at a brief
 * frozen BEFORE the tap, and that is the brief that runs. Nothing errors — the quote matches the run
 * perfectly, and both are for a clip she is no longer looking at. That shipped once already, for the
 * shot slots: she tapped Tracking, the board did not re-quote, and the job ran with no `shot` key.
 *
 * Sound is the worst field for it to happen to, because it is the only one that can DOUBLE the bill:
 * she would tap sound, see the old price, approve it, and be charged the new one.
 *
 * MUTATION: drop `r.audio` from `rowSignature`. This reds, and so does the structural test below.
 */
describe("tapping sound re-quotes the board", () => {
  it("moves the signature, on a row that costs more and on one that does not", () => {
    for (const base of [row(), row({ assetId: null, kind: "broll" })]) {
      const off = rowSignature([base]);
      const on = rowSignature(setAudio([base], 0, true));
      expect(on).not.toBe(off);
      // And back off is back to where it started — `setAudio` deletes the key rather than writing
      // `false`, so turning it off is not a third state that re-quotes a third time.
      expect(rowSignature(setAudio(setAudio([base], 0, true), 0, false))).toBe(
        off,
      );
    }
  });

  // A bridge is Kling, which bills more for audio against a flat quote — the server never offers it
  // there. `bridgeRequestFor` builds its own request, so this is pinned rather than assumed.
  it("and a bridge never carries sound, whatever the row says", () => {
    const r = bridgeRequestFor(
      row({ key: "k2", assetId: "a2", audio: true, bridgeRequested: true }),
      row({ key: "k1", assetId: "a1" }),
      "grow-following",
    );
    expect(r).not.toBeNull();
    expect("audio" in (r as object)).toBe(false);
  });
});

/**
 * ─── THE STRUCTURAL VERSION: IF THE BOARD WOULD ASK FOR SOMETHING DIFFERENT, IT MUST RE-QUOTE ──
 *
 * `rowSignature`'s own tests name the fields that exist today. This one does not know what the
 * fields are: it takes boards that differ, and demands that whenever `boardRequests` — the thing
 * that actually travels — comes out different, the signature does too. So the NEXT field added to
 * the row and to the request, and forgotten in the signature, reds here without anyone having
 * remembered to write a test for it. That is exactly the omission that shipped for the shot slots.
 *
 * MUTATION: drop `r.shot` from `rowSignature`. This reds.
 */
describe("a board that would ask for something different has a different signature", () => {
  const variants: StoryboardRow[][] = [
    [row()],
    [row({ prompt: "She turns to the light." })],
    [row({ kind: "broll" })],
    [row({ assetId: "a9" })],
    [row({ assetId: null, kind: "broll" })],
    [row({ audio: true })],
    [row({ assetId: null, kind: "broll", audio: true })],
    [row({ shot: { movement: "orbit" } })],
    [row({ shot: { movement: "tracking" } })],
    [row({ assetId: null, kind: "broll", shot: { lighting: "overcast" } })],
    [
      row({
        assetId: null,
        kind: "broll",
        shot: { environment: "gym", framing: "wide" },
      }),
    ],
    [row({ key: "k1" }), row({ key: "k2", assetId: "a2" })],
    [
      row({ key: "k1" }),
      row({ key: "k2", assetId: "a2", bridgeRequested: true }),
    ],
  ];

  it("no two boards that travel differently share a signature", () => {
    const asked = variants.map((rows) =>
      JSON.stringify(boardRequests(rows, "grow-following")),
    );
    const sigs = variants.map((rows) => rowSignature(rows));
    for (let i = 0; i < variants.length; i++)
      for (let j = i + 1; j < variants.length; j++)
        if (asked[i] !== asked[j])
          expect([i, j, sigs[i] !== sigs[j]]).toEqual([i, j, true]);
  });
});

/**
 * ─── THE COMPOSER'S SLOTS REACH THE REQUEST (PR 15.1, R-1) ─────────────────────────────────────
 *
 * PR 15 set composition and action on a photo-less row at seed (`withPlannedShot`, composer on) and
 * `shotFor` stripped both on the way out, because it called `slotsAllowed(row)` with no flag. Every
 * PR 15 test sat on one side of that hop, so none saw it. These go from the plan item, through the
 * ONE mapping, to the request the Board sends — both sides in one test.
 *
 * ⚠️ MUTATION: filter `composition` out in `shotFor` — "composition is stripped…" reds by name.
 * ⚠️ MUTATION: filter `motion` out in `shotFor` — "motion is stripped…" reds by name.
 * ⚠️ MUTATION: `slotsAllowed(row)` in `shotFor` (PR 15's code) — "slotsAllowed is called without…" reds.
 */
describe("the composer's slots reach a Board clip request (PR 15.1)", () => {
  const SIX = {
    framing: "low-angle",
    movement: "crane",
    lighting: "rim-light",
    environment: "gym",
    composition: "rule-of-thirds",
    motion: "slow-motion",
  } as const;
  const words: AgentPlanItem = {
    kind: "broll",
    beat: "the gym before anyone",
    direction: "An empty gym at dawn, light on the floor.",
    assetId: null,
    thumbUrl: null,
    athletePresent: null,
    sound: false,
    brandFlag: null,
    swapped: null,
    uncast: null,
    shot: SIX,
  };
  const sent = (composer: boolean) =>
    boardRequests(
      seedRowsFrom([words], "n1", 2, composer),
      "grow-following",
      null,
      composer,
    )[0].request;

  it("composition is stripped before a Board clip request — never: a seeded photo-less row sends its composition", () => {
    expect(sent(true).shot?.composition).toBe("rule-of-thirds");
  });

  it("motion is stripped before a Board clip request — never: a seeded photo-less row sends its action", () => {
    expect(sent(true).shot?.motion).toBe("slow-motion");
  });

  it("slotsAllowed is called without the composer flag — never: the request carries all six slots the seed kept", () => {
    const rows = seedRowsFrom([words], "n1", 2, true);
    expect(rows[0].shot).toEqual(SIX);
    expect(
      boardRequests(rows, "grow-following", null, true)[0].request.shot,
    ).toEqual(SIX);
  });

  it("with the composer off the request is today's: four slots, no composition, no action", () => {
    const off = sent(false);
    expect(off.shot).toEqual({
      framing: "low-angle",
      movement: "crane",
      lighting: "rim-light",
      environment: "gym",
    });
    // And the default IS off: a caller that passes nothing asks for exactly what it always did.
    const rows = seedRowsFrom([words], "n1", 2, true);
    expect(boardRequests(rows, "grow-following")).toEqual(
      boardRequests(rows, "grow-following", null, false),
    );
  });

  it("a photo row still sends movement and nothing else, composer or not", () => {
    const photo = {
      ...words,
      kind: "i2v" as const,
      assetId: "a1",
      athletePresent: true,
    };
    for (const composer of [true, false])
      expect(
        boardRequests(
          seedRowsFrom([photo], "n1", 2, composer),
          "grow-following",
          null,
          composer,
        )[0].request.shot,
      ).toEqual({ movement: "crane" });
  });
});

/**
 * ─── N1 (PR 15.1 Phase R): WHAT NOW TRAVELS MUST RE-QUOTE ──────────────────────────────────────
 *
 * Once composition and action ride the request, a chip tap on either changes what the Board would
 * spend on — so it must move the quote key, or "Make the board" runs a preview frozen before the tap.
 * `rowSignature` named four slots; the structural test above calls `boardRequests` with the flag off,
 * so it could not see the two new ones. This is its composer twin.
 *
 * ⚠️ MUTATION: `rowSignature` back to the four slots — "a composition change does not re-quote the
 * board" reds by name.
 */
describe("with the composer on, a board that would ask for something different has a different signature", () => {
  const t2v = (shot: StoryboardRow["shot"]) => [
    row({ assetId: null, kind: "broll", shot }),
  ];
  const variants: StoryboardRow[][] = [
    t2v({ framing: "wide" }),
    t2v({ framing: "wide", composition: "centered" }),
    t2v({ framing: "wide", composition: "symmetrical" }),
    t2v({ framing: "wide", motion: "running" }),
    t2v({ framing: "wide", motion: "walking" }),
    t2v({ framing: "wide", composition: "centered", motion: "running" }),
    t2v({ composition: "centered" }),
    t2v({ motion: "running" }),
  ];

  it("a composition change does not re-quote the board — never: every composition or action change moves the signature", () => {
    const asked = variants.map((rows) =>
      JSON.stringify(boardRequests(rows, "grow-following", null, true)),
    );
    const sigs = variants.map((rows) => rowSignature(rows));
    // Every variant asks for something different, or the test proves nothing.
    expect(new Set(asked).size).toBe(variants.length);
    for (let i = 0; i < variants.length; i++)
      for (let j = i + 1; j < variants.length; j++)
        if (asked[i] !== asked[j])
          expect([i, j, sigs[i] !== sigs[j]]).toEqual([i, j, true]);
  });

  it("and a board with neither keys exactly as it did before PR 15.1", () => {
    // The four-slot shape, byte for byte: no trailing terms for slots nothing set.
    expect(rowSignature(t2v({ framing: "wide" }))).toBe(
      JSON.stringify([
        [
          "k1",
          null,
          "She walks into the light.",
          "broll",
          null,
          null,
          ["wide", null, null, null],
        ],
      ]),
    );
  });
});

describe("runBoardPieces — admitted whole, then spent one piece at a time", () => {
  const PIECES: BoardPiece[] = [
    { key: "k1", kind: "clip", label: "Shot 1" },
    { key: "k2", kind: "bridge", label: "Bridge into shot 2" },
    { key: "k2", kind: "clip", label: "Shot 2" },
  ];
  const PREVIEWS: Record<string, string> = {
    "k1:clip": "p1",
    "k2:bridge": "p2",
    "k2:clip": "p3",
  };

  /** A recording double: every call lands in one ordered log, so ORDER is assertable. */
  const io = (behave: Partial<Pick<BoardRunIo, "admit" | "generate">> = {}) => {
    const log: string[] = [];
    const outcomes: [string, string, string | undefined][] = [];
    const calls: BoardRunIo = {
      admit: async (ids) => {
        log.push(`admit:${ids.join(",")}`);
        return behave.admit?.(ids);
      },
      generate: async (id) => {
        log.push(`generate:${id}`);
        return behave.generate ? behave.generate(id) : { jobId: `job-${id}` };
      },
      onPiece: (p, outcome, jobId) => {
        outcomes.push([p.label, outcome, jobId]);
      },
    };
    return { io: calls, log, outcomes };
  };

  /**
   * ⚠️ MUTATION: fall through a refused admission into the loop instead of returning. This reds,
   * and nothing else in the suite does.
   *
   * The half-execution this whole path exists to prevent: every piece under the per-job cap, the
   * board over the day. Refused at the door, NOTHING is generated — not the first piece, not any.
   */
  it("a refused admission spends nothing, and hands back the server's own sentence", async () => {
    const refusal =
      "Refusing to run this plan — 3 items quote $1.32 together, over the $25.00 daily ceiling.";
    const { io: calls, log } = io({
      admit: async () => {
        throw new Error(refusal);
      },
    });

    const result = await runBoardPieces(PIECES, PREVIEWS, calls);

    expect(result).toEqual({ ran: false, refusal });
    expect(log.filter((l) => l.startsWith("generate"))).toEqual([]);
  });

  it("admits every piece once, in playing order, before the first thing spends", async () => {
    const { io: calls, log, outcomes } = io();

    const result = await runBoardPieces(PIECES, PREVIEWS, calls);

    expect(result).toEqual({ ran: true });
    expect(log).toEqual([
      "admit:p1,p2,p3",
      "generate:p1",
      "generate:p2",
      "generate:p3",
    ]);
    expect(outcomes).toEqual([
      ["Shot 1", "ok", "job-p1"],
      ["Bridge into shot 2", "ok", "job-p2"],
      ["Shot 2", "ok", "job-p3"],
    ]);
  });

  it("refuses the whole board when one piece was never quoted — it used to skip that piece and run the rest", async () => {
    const { io: calls, log } = io();
    const { "k2:bridge": _unquoted, ...partial } = PREVIEWS;

    const result = await runBoardPieces(PIECES, partial, calls);

    expect(result.ran).toBe(false);
    // Neither admitted nor spent: a board minus a piece is not the board on her screen.
    expect(log).toEqual([]);
  });

  it("once admitted, a piece that fails does not stop the ones behind it", async () => {
    const {
      io: calls,
      log,
      outcomes,
    } = io({
      generate: async (id) => {
        if (id === "p2") throw new Error("That clip was withheld.");
        return { jobId: `job-${id}` };
      },
    });

    await runBoardPieces(PIECES, PREVIEWS, calls);

    expect(log.filter((l) => l.startsWith("generate"))).toEqual([
      "generate:p1",
      "generate:p2",
      "generate:p3",
    ]);
    expect(outcomes[1]).toEqual([
      "Bridge into shot 2",
      "That clip was withheld.",
      undefined,
    ]);
    expect(outcomes[2]).toEqual(["Shot 2", "ok", "job-p3"]);
  });
});

/**
 * The ONE mapping from a server preview to a quote — the Board's quote round and the Agent screen's
 * estimate both go through it, so the two numbers are made the same way.
 */
describe("rowQuoteFrom", () => {
  const preview = (cost: { amountUsd: number } | null, unpriced = false) =>
    ({
      previewId: "p1",
      cost: cost ? { ...cost, currency: "USD", basis: "estimated" } : null,
      unpriced,
    }) as never;

  it("takes the server's one figure, as both numbers", () => {
    expect(rowQuoteFrom("k1", preview({ amountUsd: 0.63 }))).toEqual({
      key: "k1",
      ceilingUsd: 0.63,
      expectedUsd: 0.63,
    });
  });

  it("marks a missing cost and an explicit unpriced the same way — never as $0", () => {
    expect(rowQuoteFrom("k1", preview(null)).unpriced).toBe(true);
    expect(rowQuoteFrom("k1", preview({ amountUsd: 0 }, true)).unpriced).toBe(
      true,
    );
  });
});

// ─── One row: "Redo this shot" / "Make just this one" ────────────────────────────────────────────
//
// REVERT CHECKS, red by name:
//   RC-B1  runRowPieces skips the admit call        → "one clip is still admitted — a single-row run asks admission about its own fresh pieces before it spends"
//   RC-B2  rowActionView drops the signature stamp   → "a quote made for an earlier version of the row cannot spend — a tap prices the row she has"
//   RC-B3  quoteRowPieces previews only the clip       → "a row is priced fresh — a new preview for every piece, never an id from an earlier quote"

describe("one row — the board's machinery on one row's pieces", () => {
  const two = (): StoryboardRow[] => [
    row({ key: "k1", assetId: "a1" }),
    row({ key: "k2", assetId: "a2", bridgeRequested: true }),
  ];
  const fakePreview = (id: string, amountUsd: number) =>
    ({
      previewId: id,
      cost: { amountUsd, currency: "USD", basis: "estimated" },
      unpriced: false,
    }) as never;

  it("takes one row's pieces in the board's order — the bridge into it, then its clip", () => {
    const reqs = boardRequests(two(), "grow-following");
    expect(rowRequests(reqs, "k2").map((r) => r.kind)).toEqual([
      "bridge",
      "clip",
    ]);
    expect(rowRequests(reqs, "k1").map((r) => r.kind)).toEqual(["clip"]);
  });

  it("a row's signature moves with its own edits, the row before it and the objective — and not with any other row", () => {
    const b = two();
    const sig = (
      rows: StoryboardRow[],
      o: "grow-following" | "showcase-product" = "grow-following",
    ) => rowPiecesSignature(boardRequests(rows, o), "k1");
    const k2sig = (rows: StoryboardRow[]) =>
      rowPiecesSignature(boardRequests(rows, "grow-following"), "k2");

    expect(sig(setPrompt(b, 0, "Something else."))).not.toBe(sig(b));
    expect(sig(b, "showcase-product")).not.toBe(sig(b));
    expect(sig(setPrompt(b, 1, "Something else."))).toBe(sig(b));
    // The bridge into k2 starts from k1's photo, so a different k1 photo is a different k2.
    const moved = [{ ...b[0], assetId: "a9" }, b[1]];
    expect(k2sig(moved)).not.toBe(k2sig(b));
  });

  it("a row is priced fresh — a new preview for every piece, never an id from an earlier quote", async () => {
    const reqs = rowRequests(boardRequests(two(), "grow-following"), "k2");
    let n = 0;
    const previewed: unknown[] = [];
    const admitted: string[][] = [];
    const q = await quoteRowPieces(reqs, "SIG", {
      preview: async (req) => {
        previewed.push(req);
        n += 1;
        return fakePreview(`fresh-${n}`, 0.4);
      },
      admit: async (ids) => {
        admitted.push(ids);
        return { maxJobUsd: 5 };
      },
    });

    expect(previewed).toEqual(reqs.map((r) => r.request));
    expect(q.previews).toEqual({
      "k2:bridge": "fresh-1",
      "k2:clip": "fresh-2",
    });
    expect(admitted).toEqual([["fresh-1", "fresh-2"]]);
    expect(q).toMatchObject({
      quotedFor: "SIG",
      limits: { maxJobUsd: 5 },
      admissionRefusal: null,
    });
  });

  it("one clip is still admitted — a single-row run asks admission about its own fresh pieces before it spends", async () => {
    const log: string[] = [];
    const io: BoardRunIo = {
      admit: async (ids) => {
        log.push(`admit:${ids.join(",")}`);
      },
      generate: async (id) => {
        log.push(`generate:${id}`);
        return { jobId: `job-${id}` };
      },
      onPiece: () => {},
    };
    const result = await runRowPieces(
      [{ key: "k1", kind: "clip", label: "Shot 1" }],
      { "k1:clip": "fresh-9" },
      io,
    );

    expect(result).toEqual({ ran: true });
    expect(log).toEqual(["admit:fresh-9", "generate:fresh-9"]);
  });

  it("a single-row run the day ceiling refuses spends nothing, and says so in the server's words", async () => {
    const sentence =
      "Refusing to run this plan — 1 item quotes $0.80, over the $25.00 daily ceiling.";
    const log: string[] = [];
    const result = await runRowPieces(
      [{ key: "k1", kind: "clip", label: "Shot 1" }],
      { "k1:clip": "fresh-9" },
      {
        admit: async () => {
          throw new Error(sentence);
        },
        generate: async (id) => {
          log.push(id);
          return { jobId: "x" };
        },
        onPiece: () => {},
      },
    );
    expect(result).toEqual({ ran: false, refusal: sentence });
    expect(log).toEqual([]);
  });

  describe("the row's button", () => {
    const r = row({ key: "k1" });
    const quote = (over: Partial<PiecesQuote> = {}): PiecesQuote => ({
      clips: [{ key: "k1", ceilingUsd: 0.8, expectedUsd: 0.8 }],
      bridges: [],
      previews: { "k1:clip": "fresh-1" },
      limits: { maxJobUsd: 5 },
      admissionRefusal: null,
      quotedFor: "SIG",
      ...over,
    });
    const base = {
      row: r,
      signature: "SIG",
      otherBusy: false,
      boardRunning: false,
      working: false,
    };

    it("says what it will do before a run, and redo after one", () => {
      expect(rowActionView({ ...base, madeFor: undefined })).toMatchObject({
        label: "Make just this one",
        step: "price",
        stale: false,
      });
      expect(rowActionView({ ...base, madeFor: "SIG" })).toMatchObject({
        label: "Redo this shot",
        step: "price",
      });
    });

    it("puts the fresh price on the button", () => {
      const run = { busy: null, quote: quote(), error: null };
      expect(rowActionView({ ...base, madeFor: "SIG", run })).toMatchObject({
        label: "Redo · $0.80",
        step: "run",
        disabled: false,
      });
      expect(rowActionView({ ...base, madeFor: undefined, run })?.label).toBe(
        "Make just this one · $0.80",
      );
    });

    it("a quote made for an earlier version of the row cannot spend — a tap prices the row she has", () => {
      const run = {
        busy: null,
        quote: quote({ quotedFor: "OLD" }),
        error: null,
      };
      expect(rowActionView({ ...base, madeFor: "SIG", run })).toMatchObject({
        label: "Redo this shot",
        step: "price",
        refusal: null,
      });
    });

    it("editing a prompt after a run marks the row's clip stale and arms the redo", () => {
      const before = [r];
      const madeFor = rowPiecesSignature(
        boardRequests(before, "grow-following"),
        "k1",
      );
      const after = setPrompt(before, 0, "She turns and runs.");
      const now = rowPiecesSignature(
        boardRequests(after, "grow-following"),
        "k1",
      );

      expect(
        rowActionView({ ...base, row: after[0], madeFor, signature: now }),
      ).toMatchObject({
        label: "Redo this shot",
        step: "price",
        stale: true,
      });
    });

    it("the day ceiling's refusal is shown on the row in the server's own words, as on the board", () => {
      const sentence =
        "Refusing to run this plan — 1 item quotes $0.80, over the $25.00 daily ceiling.";
      const run = {
        busy: null,
        quote: quote({ limits: null, admissionRefusal: sentence }),
        error: null,
      };
      expect(rowActionView({ ...base, madeFor: "SIG", run })).toMatchObject({
        step: "price",
        refusal: sentence,
      });
      // And a refusal at RUN time (admission asked again at the tap) lands the same way.
      expect(
        rowActionView({
          ...base,
          madeFor: "SIG",
          run: { busy: null, quote: null, error: sentence },
        })?.refusal,
      ).toBe(sentence);
    });

    it("an unfinished row is not priced — its gap is shown instead", () => {
      expect(
        rowActionView({
          ...base,
          row: row({ key: "k1", prompt: "  " }),
          madeFor: undefined,
        }),
      ).toMatchObject({
        disabled: true,
        refusal: "One shot still needs a line about what happens in it.",
      });
    });

    it("offers nothing while the board runs or while this row is still being made, and waits while another row spends", () => {
      expect(
        rowActionView({ ...base, madeFor: "SIG", boardRunning: true }),
      ).toBeNull();
      expect(
        rowActionView({ ...base, madeFor: "SIG", working: true }),
      ).toBeNull();
      const run = { busy: null, quote: quote(), error: null };
      expect(
        rowActionView({ ...base, madeFor: "SIG", run, otherBusy: true })
          ?.disabled,
      ).toBe(true);
    });
  });
});

describe("a still and the one-row button", () => {
  const still = heldPhotoRow("s", "photo", null, 2);

  it("a still has no button — nothing to make, nothing to redo", () => {
    expect(
      rowActionView({
        row: still,
        madeFor: undefined,
        signature: "sig",
        otherBusy: false,
        boardRunning: false,
        working: false,
      }),
    ).toBeNull();
  });

  /**
   * The ruling's addition: a redo on a GENERATING row must still work on a board that also holds
   * stills, and its admission is that row's pieces only — a still's key is never among them.
   */
  it("redo on a shot beside a still admits that shot's pieces alone, and the still's key is never among them", async () => {
    const rows: StoryboardRow[] = [
      row({ key: "k1", assetId: "a1" }),
      still,
      row({ key: "k2", assetId: "a2" }),
    ];
    const requests = boardRequests(rows, "grow-following");
    expect(rowRequests(requests, "s")).toEqual([]);
    const mine = rowRequests(requests, "k2");
    expect(mine.map((r) => `${r.key}:${r.kind}`)).toEqual(["k2:clip"]);
    expect(
      rowActionView({
        row: rows[2],
        madeFor: "old",
        signature: "new",
        otherBusy: false,
        boardRunning: false,
        working: false,
      }),
    ).toMatchObject({ label: "Redo this shot", step: "price", stale: true });
    const log: string[] = [];
    const pieces: BoardPiece[] = mine.map((r) => ({
      key: r.key,
      kind: r.kind,
      label: "Shot 3",
    }));
    const out = await runRowPieces(
      pieces,
      { "k2:clip": "fresh-k2" },
      {
        admit: async (ids) => {
          log.push(`admit:${ids.join(",")}`);
          return { maxJobUsd: 10 };
        },
        generate: async (id) => {
          log.push(`generate:${id}`);
          return { jobId: `j-${id}` };
        },
        onPiece: () => {},
      },
    );
    expect(out.ran).toBe(true);
    expect(log).toEqual(["admit:fresh-k2", "generate:fresh-k2"]);
  });
});

// ─── One of her clips asks for nothing (C2 Half B) ─────────────────────────────────────────────

describe("a clip row asks for nothing", () => {
  const clip = heldClipRow(
    "c1",
    "clip-1",
    null,
    { startSec: 0, endSec: 3 },
    6.5,
    true,
  );

  /**
   * ⚠️ MUTATION: let `boardRequests` build a clip request for a clip row, or a bridge into one.
   * This reds — and so would her money: a placed clip is not a request.
   */
  it("is not a piece, not a bridge, has no request and no action — the shots around it are unchanged", () => {
    const rows = [
      row({ key: "k1" }),
      { ...clip, bridgeRequested: true },
      row({ key: "k3", bridgeRequested: true }),
    ];
    expect(
      boardRequests(rows, "grow-following").map((r) => [r.key, r.kind]),
    ).toEqual([
      ["k1", "clip"],
      ["k3", "clip"],
    ]);
    expect(() => clipRequestFor(clip, "grow-following")).toThrow(/clip row/);
    expect(
      bridgeRequestFor(row({ key: "k3" }), clip, "grow-following"),
    ).toBeNull();
    expect(
      rowActionView({
        row: clip,
        madeFor: undefined,
        signature: "s",
        otherBusy: false,
        boardRunning: false,
        working: false,
      }),
    ).toBeNull();
  });
});

/**
 * PR 19 (ADI-R19-BOARD4): a refusal never changes her shot. Video off is a switched-off feature, not a shot problem —
 * one board-level line, and every row stays exactly as she set it.
 */
describe("the board's quote round (ADI-R19-BOARD4)", () => {
  const VIDEO_OFF = "Video isn't switched on yet.";
  const answer = (id: string, off: boolean) =>
    ({
      previewId: id,
      status: off ? "blocked" : "ready",
      cost: off
        ? null
        : { amountUsd: 0.73, currency: "USD", basis: "estimated" },
      unpriced: off,
      unavailable: off ? { reason: VIDEO_OFF } : null,
    }) as unknown as GenerationPreview;

  /** ⚠️ MUTATION M-videoOff: drop the `videoOff` arm in priceBoard — this reds by name. */
  it("video off is one board-level message, and no shot changes", async () => {
    const b = board();
    const before = JSON.stringify(b);
    const server = jest.fn(async () => answer("p", true));
    const priced = await priceBoard(
      boardRequests(b, "grow-following"),
      server,
      {
        videoOff: true,
      },
    );
    expect(priced).toEqual({ off: VIDEO_OFF });
    // One answer is enough to know the feature is off: nothing more is asked.
    expect(server).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(b)).toBe(before);
  });

  it("video on: every piece quoted in playing order, as the tab's loop always did", async () => {
    let n = 0;
    const priced = await priceBoard(
      boardRequests(
        [
          row({ key: "k1", assetId: "a1" }),
          row({ key: "k2", assetId: "a2", bridgeRequested: true }),
        ],
        "grow-following",
      ),
      async () => answer(`p${++n}`, false),
      { videoOff: true },
    );
    expect(priced).toMatchObject({
      off: null,
      previews: { "k1:clip": "p1", "k2:bridge": "p2", "k2:clip": "p3" },
    });
  });

  it("with STUDIO_LIBRARY_FIELDS off, video off is quoted piece by piece as before (admission names it)", async () => {
    const priced = await priceBoard(
      boardRequests(board(), "grow-following"),
      async () => answer("p", true),
      { videoOff: false },
    );
    expect(priced).toMatchObject({ off: null });
    expect(priced && priced.off === null && priced.clips).toHaveLength(3);
  });

  it("an error still stops the round, as it always did", async () => {
    await expect(
      priceBoard(
        boardRequests(board(), "grow-following"),
        async () => {
          throw new Error("That photo isn't in your library");
        },
        { videoOff: true },
      ),
    ).rejects.toThrow("isn't in your library");
  });
});

// quality-scrappy (ADI-QS-2): the Board's "Check the cost to try again" re-prices the row with the gate's fix on the ONE
// piece whose clip failed. ⚠️ MUTATION MG3: the fix put on every piece — "only the piece that failed" reds by name.
describe("withRowFix", () => {
  const pieces: {
    key: string;
    kind: "bridge" | "clip";
    request: PreviewRequest;
  }[] = [
    {
      key: "r1",
      kind: "bridge",
      request: { direction: "b" } as PreviewRequest,
    },
    { key: "r1", kind: "clip", request: { direction: "c" } as PreviewRequest },
  ];

  it("only the piece that failed carries the codes; the other asks exactly what it asked", () => {
    const fixed = withRowFix(pieces, { kind: "clip", corrective: ["black"] });
    expect(fixed[1].request.corrective).toEqual(["black"]);
    expect(fixed[0]).toEqual(pieces[0]);
  });

  it("no fix, or an empty one, is the row's requests as they were", () => {
    expect(withRowFix(pieces)).toEqual(pieces);
    expect(withRowFix(pieces, { kind: "clip", corrective: [] })).toEqual(
      pieces,
    );
  });
});
