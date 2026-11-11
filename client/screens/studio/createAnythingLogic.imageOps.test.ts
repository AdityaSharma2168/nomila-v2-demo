/**
 * PR 19's client twin (EXPO_PUBLIC_STUDIO_IMAGE_OPS) against the server's REAL classifier — each case crosses the
 * client/server boundary in one test: `route` (server/studio/classify.ts, STUDIO_IMAGE_OPS on) answers, and the client
 * logic decides what Create Anything does with that answer.
 *
 *   the vague ask keeps her frame   (M-x1: drop `vague` from the client's edit-shaped asks — reds by name)
 *   a pose from a marked frame is a generate, never an edit the freeze would refuse (M-x2: let the verb list win)
 *   "This makes a new image" on every generate reached from a marked frame (K-IO12; M-K12)
 */
import type { StudioClassification } from "../../hooks/use-studio";
import type { Attachment } from "../../lib/studio-contract";
import { plannedIntent, routeMarked } from "../../lib/studio-contract";
import { route } from "../../../server/studio/classify";
import { interpretable } from "../../../server/studio/interpret/eligibility";
import { autoMarkShape, resolveSend } from "./createAnythingLogic";
import { adGate } from "../../../server/studio/interpret/ad";
import type { GenerationPreview } from "../../hooks/use-studio";
import { livePlanFrom, livePlanView, type SheetJob } from "./threadLogic";

const you: Attachment = {
  id: "you-a1",
  role: "source-frame",
  name: "me",
  uri: null,
  assetId: "a1",
};
const NEW_IMAGE =
  "This makes a new image. Your photo is a reference for how you look — tap it to edit that photo instead.";

/** What POST /studio/classify answers for her sentence, as the route shapes it (routes/studio.ts). */
function classified(sentence: string): StudioClassification {
  const r = route(sentence, true, { objects: 0 });
  return {
    ...r,
    op: r.steps[0]?.op ?? null,
    targets: r.steps[0]?.targets ?? [],
    interpretable: false,
  } as unknown as StudioClassification;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.STUDIO_IMAGE_OPS;
  process.env.STUDIO_IMAGE_OPS = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env.STUDIO_IMAGE_OPS;
  else process.env.STUDIO_IMAGE_OPS = saved;
});

describe("the vague ask, client and server together", () => {
  it("the vague ask keeps her frame: auto-mark reads it as about this photo", () => {
    const answer = classified("make it pop");
    expect([answer.initialPath, answer.reason]).toEqual(["ASK", "vague"]);
    expect(autoMarkShape(true, answer, "make it pop", [you], true)).toBe(true);
    // The twin off: today's answer — an unknown code leaves her photo her likeness.
    expect(autoMarkShape(true, answer, "make it pop", [you], false)).toBe(
      false,
    );
  });

  it("the look pointer's ask keeps her frame too", () => {
    const answer = classified("match this look");
    expect(answer.reason).toBe("style_reference_missing");
    expect(autoMarkShape(true, answer, "match this look", [you], true)).toBe(
      true,
    );
  });

  it("carries the op chips the server sent", () => {
    expect(classified("make it pop").suggestions?.length).toBeGreaterThan(0);
  });
});

describe("a pose from a marked frame (R-8), client and server together", () => {
  it("change my pose from a marked frame is a generate", () => {
    const answer = classified("change my pose");
    expect(answer.initialPath).toBe("GENERATE");
    // Her frame marked; the old verb list reads "change" as an edit.
    const on = routeMarked(
      "photo",
      answer,
      "change my pose",
      [you],
      "a1",
      false,
      true,
    );
    expect([on.intent, on.editBase]).toEqual(["image.generate", null]);
    // The twin off: today's routing, the verb list's edit — which the freeze refuses (generate_on_edit).
    expect(
      routeMarked("photo", answer, "change my pose", [you], "a1", false, false)
        .intent,
    ).toBe("image.edit");
  });
});

describe("W-3: an ad of her photo is main's ad edit — tagged, read by the interpreter, one image (ADI-R19-W3)", () => {
  // The walk's ad sentences, verbatim — known brands, the only ones main's ad treatment reads (interpret/ad.ts).
  const ADS = [
    "make this an ad for adidas",
    "turn this into an ad for adidas",
    "make an ad for adidas",
    'make this an ad for adidas that says "OWN THE MOMENT"',
  ];
  /** What /studio/classify answers with STUDIO_INTERPRETER on: the real rules, and the server's own eligibility. */
  const answerOf = (sentence: string): StudioClassification => {
    const r = route(sentence, true, { objects: 0 });
    return {
      ...classified(sentence),
      interpretable:
        r.initialPath === "ASK" &&
        interpretable({
          enabled: true,
          nativeEdit: true,
          hasFrame: true,
          drawn: false,
          origin: "system",
          sentence,
          routed: r,
        }),
    };
  };
  /** The interpreter's ad reading, ready and priced — the fields the send reads (the ad treatment's C lines). */
  const AD_READING = {
    previewId: "pv-ad",
    status: "ready",
    plan: null,
    references: [],
    cost: { amountUsd: 0.271, currency: "USD", basis: "estimated" },
    unpriced: false,
    blockers: [],
    warnings: [],
    verdict: { canGenerate: true, headline: "Ready", reason: null },
    unavailable: null,
    interpretation: {
      lines: [
        { text: "Change my jersey to an adidas jersey", source: "brand" },
        {
          text: 'Add the headline "OWN THE PITCH" across the top',
          source: "suggested",
        },
        {
          text: "Change the background to the modern training facility",
          source: "suggested",
        },
      ],
    },
    brief: {
      job: {
        editIntent: {
          steps: [
            { op: "REPLACE_OBJECT" },
            { op: "DISPLAY_TEXT" },
            { op: "CHANGE_BACKGROUND" },
          ],
          changes: [],
        },
      },
    },
  } as unknown as GenerationPreview;

  /**
   * ⚠️ MUTATION M-adGenerate: drop rule 0's ad line (classify.ts) — "make an ad for adidas" is a generate of her
   * again, and this reds by name.
   */
  it.each(ADS)(
    "%s — an interpretable ask that main's ad gate reads as an ad, never rule 0's generate",
    (sentence) => {
      const r = route(sentence, true, { objects: 0 });
      expect(r.initialPath).toBe("ASK");
      expect(answerOf(sentence).interpretable).toBe(true);
      expect(adGate(sentence, null)).toMatchObject({
        kind: "ad",
        brand: "adidas",
      });
    },
  );

  it.each(ADS)(
    "%s — her photo carries the edit tag, the interpreter reads it once at send, and the reading goes to the sheet as an edit of her photo",
    async (sentence) => {
      expect(
        autoMarkShape(true, answerOf(sentence), sentence, [you], true),
      ).toBe(true);
      const preview = jest.fn(async () => AD_READING);
      const out = await resolveSend({
        text: sentence,
        routing: true,
        current: () => ({
          tray: [you],
          mark: { frameAssetId: null, autoOff: false },
          mediaTypes: {},
        }),
        ask: async (t: string) => answerOf(t),
        interpreter: true,
        imageOps: true,
        preview,
      });
      expect(preview).toHaveBeenCalledTimes(1);
      expect(out.kind === "send" && out.frameAssetId).toBe("a1");
      expect(out.kind === "send" && out.seed?.preview.previewId).toBe("pv-ad");
    },
  );

  it("no photo: an ad request is a new image, as on main", () => {
    expect(route("make an ad for adidas", false).initialPath).toBe("GENERATE");
  });
});

describe("K-IO12: 'This makes a new image' on every generate reached from a marked frame", () => {
  const job = (frameAssetId: string | null): SheetJob =>
    ({
      key: "k1",
      promptEntryId: "p1",
      prompt: "x",
      attachments: [you],
      frameAssetId,
      carriedOn: false,
      format: "photo",
    }) as SheetJob;
  const plan = (intent?: string) => ({
    previewId: "pv1",
    canGenerate: true,
    jobCostUsd: 0.1344,
    unpriced: false,
    blockers: [],
    interpretation: null,
    card: null,
    ...(intent ? { intent } : {}),
  });
  const teaching = (j: SheetJob, p: ReturnType<typeof plan>) =>
    livePlanView(livePlanFrom("e1", j, p), {
      collapsed: new Set(),
      mediaTypes: {},
    }).teaching;

  it("pose from a marked frame says This makes a new image", () => {
    const answer = classified("make me jump");
    const routed = routeMarked(
      "photo",
      answer,
      "make me jump",
      [you],
      "a1",
      false,
      true,
    );
    expect(teaching(job("a1"), plan(plannedIntent(routed.intent, null)))).toBe(
      NEW_IMAGE,
    );
  });

  it("the interpreter's new-image reading from a marked frame says it too: it runs as a generate", () => {
    // Her frame is marked, the ask is interpreted, and the server answers newImage (interpret/5).
    expect(
      teaching(
        job("a1"),
        plan(plannedIntent("image.edit", { newImage: true })),
      ),
    ).toBe(NEW_IMAGE);
  });

  it("an edit of her marked frame says nothing, as today", () => {
    expect(teaching(job("a1"), plan("image.edit"))).toBeNull();
    // …and a plan from before this flag (no intent) is read exactly as it was.
    expect(teaching(job("a1"), plan())).toBeNull();
  });
});
