/**
 * publishLogic.test.ts — the pill's words and its state machine.
 *
 * REVERT CHECKS, red by name:
 *   RC-U1  let `confirm` send from any step          → "NEVER ONE TAP: the only way into sending is confirm, from confirming"
 *   RC-U2  let `open` go straight to confirming       → "NEVER ONE TAP: the pill opens the caption box, not the confirm step"
 *   RC-U3  draw the pill with the mode off            → "draws NOTHING with the switch off…"
 *   RC-U4  'Post' when the token cannot post          → "missing scope: the pill reads 'Reconnect to post'…"
 *   RC-U5  'Try again' after may_have_posted          → "'it may have posted' is never an invitation to try again"
 *   RC-U6  always send approve:true                   → "asks to approve ONLY a draft…"
 *   RC-U7  a dry run reads as a post                  → "a dry run never reads as a post"
 */
import {
  captionState,
  confirmView,
  nextStep,
  pillView,
  pollMs,
  toPublishBody,
  type PublishAction,
  type PublishJobWire,
  type PublishOptionsWire,
  type PublishStep,
} from "./publishLogic";

const OPTIONS: PublishOptionsWire = {
  mode: "live",
  instagram: { connected: true, handle: "synthetic_handle", canPublish: true },
  limits: { captionMaxChars: 2200, minSeconds: 3, maxBytes: 300_000_000 },
  asset: { postable: true, approvalStatus: "approved", needsApproval: false },
  latest: null,
};

const job = (over: Partial<PublishJobWire> = {}): PublishJobWire => ({
  publishId: "p-1",
  assetId: "a-1",
  platform: "instagram",
  status: "queued",
  posted: false,
  dryRun: false,
  permalink: null,
  error: null,
  errorCode: null,
  ...over,
});

const STEPS: PublishStep[] = ["idle", "composing", "confirming", "sending"];
const ACTIONS: PublishAction[] = [
  "open",
  "review",
  "back",
  "confirm",
  "cancel",
  "sent",
];

describe("nextStep — never one tap", () => {
  /** RC-U1. Exhaustive: every (step, action) pair, not the ones I thought of. */
  it("NEVER ONE TAP: the only way into sending is confirm, from confirming", () => {
    const into: string[] = [];
    for (const step of STEPS)
      for (const action of ACTIONS)
        if (step !== "sending" && nextStep(step, action) === "sending")
          into.push(`${step}+${action}`);
    expect(into).toEqual(["confirming+confirm"]);
  });

  /** RC-U2. */
  it("NEVER ONE TAP: the pill opens the caption box, not the confirm step", () => {
    expect(nextStep("idle", "open")).toBe("composing");
    // Tapping the pill again, however fast, goes nowhere.
    expect(nextStep(nextStep("idle", "open"), "open")).toBe("composing");
    // Three taps of the same thing never reach the send.
    let step: PublishStep = "idle";
    for (const a of ["open", "open", "open", "confirm", "confirm"] as const)
      step = nextStep(step, a);
    expect(step).toBe("composing");
  });

  it("walks idle → composing → confirming → sending → idle, and back is back", () => {
    expect(nextStep("composing", "review")).toBe("confirming");
    expect(nextStep("confirming", "back")).toBe("composing");
    expect(nextStep("confirming", "confirm")).toBe("sending");
    expect(nextStep("sending", "sent")).toBe("idle");
  });

  it("cancel closes it from anywhere — except mid-send, where there is nothing left to cancel", () => {
    expect(nextStep("composing", "cancel")).toBe("idle");
    expect(nextStep("confirming", "cancel")).toBe("idle");
    expect(nextStep("sending", "cancel")).toBe("sending");
  });
});

describe("pillView", () => {
  /** RC-U3. */
  it("draws NOTHING with the switch off, the route missing, or the answer not in yet", () => {
    for (const o of [
      undefined,
      "unavailable" as const,
      { mode: "off" as const },
    ])
      expect(pillView(o, null)).toMatchObject({
        kind: "hidden",
        label: null,
        canOpen: false,
      });
    // Even with a live job on record: off is off.
    expect(pillView({ mode: "off" }, job())).toMatchObject({ kind: "hidden" });
    // AND WHATEVER ELSE ARRIVES WITH IT. Today's server sends nothing but the mode, so a second
    // guard ("no account block → hidden") was hiding this one: the first version of this test
    // passed with the `mode === "off"` check deleted. A server that one day sends the account
    // facts alongside `off` must still draw nothing.
    expect(pillView({ ...OPTIONS, mode: "off" }, null)).toMatchObject({
      kind: "hidden",
      label: null,
      canOpen: false,
    });
  });

  it("the ordinary pill reads 'Post to Instagram' and may open", () => {
    expect(pillView(OPTIONS, null)).toEqual({
      kind: "post",
      label: "Post to Instagram",
      note: null,
      permalink: null,
      canOpen: true,
    });
  });

  /** RC-U4. */
  it("missing scope: the pill reads 'Reconnect to post' and cannot open the flow", () => {
    const v = pillView(
      { ...OPTIONS, instagram: { ...OPTIONS.instagram!, canPublish: false } },
      null,
    );
    expect(v).toMatchObject({
      kind: "reconnect",
      label: "Reconnect to post",
      canOpen: false,
    });
  });

  it("a job Meta refused for permission turns the pill into 'Reconnect to post' — our records were wrong", () => {
    const v = pillView(
      OPTIONS, // our records still say canPublish: true
      job({
        status: "failed",
        errorCode: "reconnect",
        error: "Reconnect Instagram to allow posting.",
      }),
    );
    expect(v).toMatchObject({
      kind: "reconnect",
      label: "Reconnect to post",
      note: "Reconnect Instagram to allow posting.",
      canOpen: false,
    });
  });

  it("no account at all asks her to connect one", () => {
    const v = pillView(
      {
        ...OPTIONS,
        instagram: { connected: false, handle: null, canPublish: false },
      },
      null,
    );
    expect(v).toMatchObject({
      kind: "connect",
      label: "Connect Instagram to post",
      canOpen: false,
    });
  });

  it("a video that cannot be posted shows the SERVER'S sentence and no button", () => {
    const message =
      "Instagram takes videos up to 300 MB and this one is 640 MB. We can put together bigger videos than Instagram accepts — make this one shorter, then post it.";
    const v = pillView(
      {
        ...OPTIONS,
        asset: { postable: false, refusal: { code: "too_big", message } },
      },
      null,
    );
    expect(v).toEqual({
      kind: "refused",
      label: null,
      note: message,
      permalink: null,
      canOpen: false,
    });
  });

  it("while a job is queued or running it reads 'Posting…' and cannot be pressed", () => {
    for (const status of ["queued", "running"] as const)
      expect(pillView(OPTIONS, job({ status }))).toMatchObject({
        kind: "posting",
        label: "Posting…",
        canOpen: false,
      });
  });

  it("a real post shows its link; a recovered one with no link still says it posted", () => {
    expect(
      pillView(
        OPTIONS,
        job({
          status: "succeeded",
          posted: true,
          permalink: "https://example.test/reel/1",
        }),
      ),
    ).toEqual({
      kind: "done",
      label: "See it on Instagram",
      note: "Posted.",
      permalink: "https://example.test/reel/1",
      canOpen: false,
    });
    expect(
      pillView(OPTIONS, job({ status: "succeeded", posted: true })),
    ).toMatchObject({
      kind: "done",
      label: null,
      note: "Posted. Open Instagram to see it.",
      canOpen: false,
    });
  });

  /** RC-U7. */
  it("a dry run never reads as a post", () => {
    const v = pillView(
      { ...OPTIONS, mode: "dry" },
      job({ status: "succeeded", dryRun: true }),
    );
    expect(v.note).toBe("Dry run finished — nothing was posted.");
    expect(v.note).not.toMatch(/^Posted/);
    expect(v.permalink).toBeNull();
    expect(v.canOpen).toBe(true); // she can run it again
  });

  it("an ordinary failure shows the server's sentence and offers another try", () => {
    const error =
      "Instagram couldn't read this video file. Put it together again, then post the new one.";
    expect(
      pillView(
        OPTIONS,
        job({ status: "failed", errorCode: "restitch", error }),
      ),
    ).toMatchObject({
      kind: "post",
      label: "Try again",
      note: error,
      canOpen: true,
    });
  });

  /** RC-U5. */
  it("'it may have posted' is never an invitation to try again", () => {
    const error =
      "We asked Instagram to post this and lost the answer, so it may have posted. Check Instagram before posting it again.";
    const v = pillView(
      OPTIONS,
      job({ status: "failed", errorCode: "may_have_posted", error }),
    );
    expect(v.label).toBe("Post to Instagram");
    expect(v.label).not.toMatch(/again/i);
    expect(v.note).toBe(error);
    // And if she does go again, the confirm step warns her first.
    expect(
      confirmView(
        OPTIONS,
        job({ status: "failed", errorCode: "may_have_posted", error }),
      ).warning,
    ).toMatch(/may already have posted.*twice/);
  });
});

describe("confirmView", () => {
  it("names the account before anything is sent", () => {
    expect(confirmView(OPTIONS, null)).toEqual({
      sentence: "This posts to @synthetic_handle now.",
      button: "Post now",
      approve: false,
      warning: null,
      dryRun: false,
    });
  });

  /** RC-U6. */
  it("asks to approve ONLY a draft, and says so on the button", () => {
    const draft = confirmView(
      {
        ...OPTIONS,
        asset: { postable: true, approvalStatus: "draft", needsApproval: true },
      },
      null,
    );
    expect(draft).toMatchObject({ button: "Approve and post", approve: true });
    expect(confirmView(OPTIONS, null).approve).toBe(false);
    expect(toPublishBody("a-1", " hi ", draft.approve)).toEqual({
      assetId: "a-1",
      platform: "instagram",
      caption: "hi",
      approve: true,
    });
    expect(toPublishBody("a-1", "hi", false)).toEqual({
      assetId: "a-1",
      platform: "instagram",
      caption: "hi",
    });
  });

  it("a dry run says it posts nothing, on the sentence AND the button", () => {
    const v = confirmView({ ...OPTIONS, mode: "dry" }, null);
    expect(v.sentence).toMatch(/posts nothing/);
    expect(v.button).toBe("Run the dry run");
    expect(v.dryRun).toBe(true);
  });

  it("falls back to plain words when the handle is unknown — never '@null'", () => {
    const v = confirmView(
      {
        ...OPTIONS,
        instagram: { connected: true, handle: null, canPublish: true },
      },
      null,
    );
    expect(v.sentence).toBe("This posts to your Instagram account now.");
  });

  it("the body never carries an account, a handle or an athlete — the server resolves those", () => {
    expect(Object.keys(toPublishBody("a-1", "x", true)).sort()).toEqual([
      "approve",
      "assetId",
      "caption",
      "platform",
    ]);
  });
});

describe("the caption and the poll", () => {
  it("counts the way the server counts, and says when it is over", () => {
    expect(captionState("hello")).toMatchObject({
      count: 5,
      over: false,
      counter: "5 of 2,200",
    });
    expect(captionState("x".repeat(2200)).over).toBe(false);
    expect(captionState("x".repeat(2201))).toMatchObject({
      over: true,
      counter: "2,201 of 2,200",
    });
    expect(captionState("   padded   ").count).toBe(6);
    expect(captionState("abc", 2).over).toBe(true);
  });

  it("polls only while a job is live — a read, and it stops", () => {
    expect(pollMs(job({ status: "queued" }))).toBe(3000);
    expect(pollMs(job({ status: "running" }))).toBe(3000);
    for (const status of ["succeeded", "failed", "canceled"] as const)
      expect(pollMs(job({ status }))).toBe(false);
    expect(pollMs(null)).toBe(false);
  });
});
