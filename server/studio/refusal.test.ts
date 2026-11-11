/**
 * refusal.test.ts — the classification, as wire shapes rather than as a description of them.
 *
 * ─── WHY THE CLASSIFIER IS A PURE FUNCTION AND THIS SUITE HAS NO FETCH ──────────────────────────
 *
 * The thing being decided is whether a job may be asked again. Get it wrong one way and a
 * retryable blip becomes a dead job; get it wrong the other and the runner re-buys a refusal the
 * provider will give every time, on a path where each go costs real money. That is a decision that
 * has to be exercised against every shape either provider can produce, including the malformed
 * ones — which is only possible if deciding it never requires a network.
 *
 * ⚠️ EVERY MARKER UNDER TEST IS ONE THIS PROJECT HAS MEASURED. The Seedance string is the one from
 * docs/probes/kling-moderation.md §1 (6 refusals of 6). There is no case here for a Veo numeric
 * support code, because nobody here has seen one in a real response and a test built on a guessed
 * constant would pin the guess rather than the behaviour.
 */
import {
  describeReasons,
  isRetryableRefusal,
  refusalCodeFor,
  type RefusalSignal,
} from "./refusal";

/** The BytePlus refusal, verbatim from the probe that measured it 6 times. */
const SEEDANCE_REFUSAL =
  "InputImageSensitiveContentDetected.PrivacyInformation: the input image contains sensitive content";

describe("an INPUT the route will not take — never retry", () => {
  it("reads Seedance's stated policy refusal as content_blocked", () => {
    expect(refusalCodeFor({ message: SEEDANCE_REFUSAL })).toBe(
      "content_blocked",
    );
  });

  it("matches the marker whatever case the provider sends it in", () => {
    expect(
      refusalCodeFor({
        message: "inputimagesensitivecontentdetected.privacyinformation",
      }),
    ).toBe("content_blocked");
    expect(
      refusalCodeFor({ message: "INPUTIMAGESENSITIVECONTENTDETECTED" }),
    ).toBe("content_blocked");
  });

  it("finds the marker inside a longer wrapper the adapter added", () => {
    // What openrouter.ts actually throws: its own prefix around the provider's string.
    expect(
      refusalCodeFor({
        message: `Video job abc-123 failed: ${SEEDANCE_REFUSAL}`,
      }),
    ).toBe("content_blocked");
  });

  it("reads INVALID_ARGUMENT as deterministic, by name and by number", () => {
    expect(refusalCodeFor({ status: "INVALID_ARGUMENT" })).toBe(
      "content_blocked",
    );
    expect(refusalCodeFor({ code: 3 })).toBe("content_blocked");
  });

  it("reads FAILED_PRECONDITION the same way", () => {
    expect(refusalCodeFor({ status: "FAILED_PRECONDITION" })).toBe(
      "content_blocked",
    );
    expect(refusalCodeFor({ code: 9 })).toBe("content_blocked");
  });

  it("is never retryable", () => {
    expect(isRetryableRefusal("content_blocked")).toBe(false);
  });
});

describe("an OUTPUT the filter took — the provider ran, so a retry means something", () => {
  /** A DONE operation that returned no videos and said why. */
  const filtered = (over: Partial<RefusalSignal> = {}): RefusalSignal => ({
    completedEmpty: true,
    filteredCount: 1,
    filteredReasons: ["Support Codes: 58061214"],
    ...over,
  });

  it("reads a filtered, empty completion as content_filtered", () => {
    expect(refusalCodeFor(filtered())).toBe("content_filtered");
  });

  it("is the only retryable one", () => {
    expect(isRetryableRefusal("content_filtered")).toBe(true);
    expect(isRetryableRefusal("provider_error")).toBe(false);
  });

  /**
   * ⚠️ BOTH CONDITIONS, AND THE SECOND IS THE ONE THAT IS EASY TO DROP.
   *
   * A filtered COUNT beside a clip we actually received is not a refusal at all — it means one
   * sample of several was dropped and the job has its video. Classifying on the count alone would
   * turn a successful generation into a retry, which is a second clip bought for nothing.
   */
  it("is NOT a refusal when the operation returned something despite filtering a sample", () => {
    expect(refusalCodeFor(filtered({ completedEmpty: false }))).toBe(
      "provider_error",
    );
  });

  it("is not a refusal when nothing was filtered — an empty completion is just empty", () => {
    expect(refusalCodeFor(filtered({ filteredCount: 0 }))).toBe(
      "provider_error",
    );
    expect(refusalCodeFor(filtered({ filteredCount: null }))).toBe(
      "provider_error",
    );
  });
});

describe("the order is the design", () => {
  /**
   * An operation can carry an error AND a filtered count. The error is the stronger statement —
   * it says the operation did not complete, not that its output was withheld — so reading the
   * count first would call an input rejection retryable and spend again on it.
   */
  it("an input rejection outranks a filtered count on the same response", () => {
    expect(
      refusalCodeFor({
        message: SEEDANCE_REFUSAL,
        completedEmpty: true,
        filteredCount: 2,
      }),
    ).toBe("content_blocked");
  });

  it("a deterministic status outranks a filtered count too", () => {
    expect(
      refusalCodeFor({
        status: "INVALID_ARGUMENT",
        completedEmpty: true,
        filteredCount: 2,
      }),
    ).toBe("content_blocked");
  });
});

describe("everything else keeps the behaviour it had before this file existed", () => {
  it.each([
    ["a transient internal error", { status: "INTERNAL", code: 13 }],
    ["an unavailable backend", { status: "UNAVAILABLE", code: 14 }],
    ["a deadline", { status: "DEADLINE_EXCEEDED", code: 4 }],
    ["a resource exhaustion", { status: "RESOURCE_EXHAUSTED", code: 8 }],
    ["an unexplained failure", { message: "no reason given" }],
    ["nothing at all", {}],
    ["an empty message", { message: "" }],
    ["a null message", { message: null }],
  ])("leaves %s as provider_error", (_label, signal) => {
    expect(refusalCodeFor(signal as RefusalSignal)).toBe("provider_error");
  });

  it("does not mistake an unrelated mention of an image for a policy refusal", () => {
    expect(
      refusalCodeFor({ message: "the input image could not be decoded" }),
    ).toBe("provider_error");
  });
});

describe("the provider's prose is reported, capped, and never parsed", () => {
  it("joins the reasons it was given", () => {
    expect(describeReasons(["Support Codes: 1", "Support Codes: 2"])).toBe(
      "Support Codes: 1; Support Codes: 2",
    );
  });

  it("is empty for nothing, rather than the string 'null'", () => {
    expect(describeReasons(null)).toBe("");
    expect(describeReasons(undefined)).toBe("");
    expect(describeReasons([])).toBe("");
  });

  it("caps a provider that returns an essay", () => {
    expect(describeReasons([`${"x".repeat(5_000)}`])).toHaveLength(200);
  });
});
