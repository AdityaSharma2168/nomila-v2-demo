/**
 * buildInfo.test.ts — the startup line says which build answered (PR 4, C1). No git is run here:
 * the runner is injected.
 */
import { buildRevision } from "./buildInfo";

describe("buildRevision — Cloud Run's revision, else the checkout's SHA, else unknown", () => {
  /** ⚠️ MUTATION: ignore K_REVISION — this reds by name. */
  it("Cloud Run's revision wins, and git is never asked", () => {
    const git = jest.fn(() => "abc1234");
    expect(buildRevision({ K_REVISION: "nomila-v2-00412-xyz" }, git)).toEqual({
      revision: "nomila-v2-00412-xyz",
      source: "k_revision",
    });
    expect(git).not.toHaveBeenCalled();
  });

  it("locally, the short SHA of the checkout the server runs from", () => {
    expect(buildRevision({}, () => "6178bcf")).toEqual({
      revision: "6178bcf",
      source: "git",
    });
    // A blank K_REVISION is not a revision.
    expect(buildRevision({ K_REVISION: "  " }, () => "6178bcf").source).toBe(
      "git",
    );
  });

  it("neither: unknown, never guessed", () => {
    expect(buildRevision({}, () => null)).toEqual({
      revision: null,
      source: "unknown",
    });
  });
});
