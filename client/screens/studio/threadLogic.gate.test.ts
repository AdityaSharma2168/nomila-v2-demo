/**
 * threadLogic.gate.test.ts — the output gate on the thread (quality-scrappy piece 5, ADI-QS-GO): a failed output
 * carries why onto its card, and a clip whose gate has not landed is still being made — never "made" early.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M5h — pollOutcome ignores a pending gate: "a succeeded clip still being checked keeps the watch going" reds.
 *   M5i — outputFromRun drops the gate: "a failed output carries why onto its card" reds.
 *   MG2 — a card reloaded from history drops it (outputFromAsset): "a failed output reloaded from history says so" reds.
 */
import {
  historyPlanView,
  outputFromRun,
  pollOutcome,
  watchLimitMs,
  type JobRead,
  type WireAsset,
  type WirePlanEntry,
} from "./threadLogic";

const asset = (
  over: Partial<JobRead["assets"][number]> = {},
): JobRead["assets"][number] => ({
  assetId: "a1",
  mediaType: "VIDEO",
  url: "https://signed.example/a1.mp4",
  approvalStatus: "draft",
  ...over,
});
const FAILED = {
  failed: true as const,
  headline: "This didn't come out right",
  lines: ["Part of it is a black screen."],
  corrective: ["black"],
};

describe("outputFromRun", () => {
  it("a failed output carries why onto its card", () => {
    expect(outputFromRun(asset({ gate: FAILED })).gate).toEqual(FAILED);
  });

  it("a pending gate is not a failure, and no gate is no key — the view it was", () => {
    expect("gate" in outputFromRun(asset({ gate: { pending: true } }))).toBe(
      false,
    );
    expect("gate" in outputFromRun(asset())).toBe(false);
  });
});

describe("pollOutcome", () => {
  const read = (assets: JobRead["assets"]): JobRead => ({
    status: "succeeded",
    startedAt: null,
    assets,
  });

  it("a succeeded clip still being checked keeps the watch going — bounded like any wait", () => {
    const t0 = 1_000_000;
    expect(
      pollOutcome(
        read([asset({ gate: { pending: true } })]),
        t0,
        t0 + 1000,
        "video",
      ),
    ).toBe("continue");
    expect(
      pollOutcome(
        read([asset({ gate: { pending: true } })]),
        t0,
        t0 + watchLimitMs("video"),
        "video",
      ),
    ).toBe("stalled");
  });

  it("a failed or absent gate is settled: made (the card then shows the failure)", () => {
    expect(pollOutcome(read([asset({ gate: FAILED })]), 0, 1)).toBe("made");
    expect(pollOutcome(read([asset()]), 0, 1)).toBe("made");
  });
});

// quality-scrappy (ADI-QS-2): a card reloaded from history reads the thread's asset map, not the job route — the gate
// rides there too (server/studio/sessions.ts), and the card shows it as the live one does.
describe("a card reloaded from history", () => {
  const OUT = "00000000-0000-4000-8000-0000000000aa";
  const entry = (): WirePlanEntry =>
    ({
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      createdAt: "2026-09-28T10:00:00.000Z",
      kind: "plan",
      previewId: "00000000-0000-4000-8000-000000000002",
      state: "made",
      preview: null,
      run: {
        jobId: "00000000-0000-4000-8000-000000000003",
        state: "made",
        outputIds: [OUT],
      },
      promptEntryId: null,
      sent: [],
      frameAssetId: null,
      carriedOn: false,
      format: "photo",
    }) as unknown as WirePlanEntry;
  const out = (over: Partial<WireAsset> = {}): WireAsset => ({
    mediaType: "IMAGE",
    thumbUrl: "https://signed.example/t",
    url: "https://signed.example/f",
    approvalStatus: "draft",
    state: "ok",
    ...over,
  });
  const reload = (a: WireAsset) =>
    historyPlanView(entry(), {
      assets: { [OUT]: a },
      prompts: new Map(),
      collapsed: new Set(),
    }).outputs[0];

  it("a failed output reloaded from history says so, and why", () => {
    expect(reload(out({ gate: FAILED })).gate).toEqual(FAILED);
  });

  it("a pending gate, no gate, and a removed output carry none — the card it was", () => {
    expect("gate" in reload(out({ gate: { pending: true } }))).toBe(false);
    expect("gate" in reload(out())).toBe(false);
    expect(
      "gate" in reload(out({ state: "removed", url: null, gate: FAILED })),
    ).toBe(false);
  });
});
