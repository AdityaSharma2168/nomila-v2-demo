/**
 * use-clip-durations — mounted, because the part that can go wrong is the WIRING.
 *
 * `measureDuration.test.ts` proves HOW a duration is got out of a runtime (and that the web path
 * cannot use the player, which is the bug that made this whole hook a no-op in Chrome).
 * `timelineGeometry.test.ts` proves what a duration MEANS. What is left, and what only a mount can
 * reach, is the bookkeeping: one probe per clip, four at a time, a stuck one released, and nothing
 * outliving the screen.
 */
import { act, render } from "@testing-library/react-native";
import React from "react";
import { Text } from "react-native";
import {
  MAX_CONCURRENT_PROBES,
  MEASURE_TIMEOUT_MS,
  useClipDurations,
  type MeasurableClip,
} from "./use-clip-durations";

interface FakeProbe {
  uri: string;
  promise: Promise<number | null>;
  answer: (seconds: number | null) => void;
  cancelled: number;
}

const probes: FakeProbe[] = [];
jest.mock("./measureDuration", () => ({
  measureDuration: (uri: string) => {
    let settle!: (v: number | null) => void;
    const promise = new Promise<number | null>((r) => {
      settle = r;
    });
    const probe: FakeProbe & { cancel: () => void } = {
      uri,
      promise,
      cancelled: 0,
      answer: settle,
      cancel: () => {
        probe.cancelled += 1;
        settle(null);
      },
    };
    probes.push(probe);
    return probe;
  },
}));

/** Let a probe answer, and let React process what follows. */
async function answer(probe: FakeProbe, seconds: number | null) {
  await act(async () => {
    probe.answer(seconds);
    await Promise.resolve();
  });
}

function Probe({ clips }: { clips: MeasurableClip[] }) {
  const measured = useClipDurations(clips);
  return <Text testID="out">{JSON.stringify([...measured.entries()])}</Text>;
}

const clip = (assetId: string): MeasurableClip => ({
  assetId,
  videoUrl: `https://example.test/${assetId}.mp4`,
});

beforeEach(() => {
  probes.length = 0;
});

describe("measuring the clips on the timeline", () => {
  it("reports a duration once it has one", async () => {
    const view = render(<Probe clips={[clip("a")]} />);
    expect(probes).toHaveLength(1);
    await answer(probes[0], 7.4);
    expect(view.getByTestId("out")).toHaveTextContent('[["a",7.4]]');
  });

  it("opens one probe per clip, not one per render", () => {
    const clips = [clip("a")];
    const view = render(<Probe clips={clips} />);
    // A parent that rebuilds the same list every render is every parent.
    view.rerender(<Probe clips={[{ ...clips[0] }]} />);
    view.rerender(<Probe clips={[{ ...clips[0] }]} />);
    expect(probes).toHaveLength(1);
  });

  it("records nothing for a clip that could not be measured", async () => {
    const view = render(<Probe clips={[clip("a")]} />);
    await answer(probes[0], null);
    expect(view.getByTestId("out")).toHaveTextContent("[]");
  });

  it("does not retry a clip it has already settled", async () => {
    const view = render(<Probe clips={[clip("a")]} />);
    await answer(probes[0], null);
    view.rerender(<Probe clips={[clip("a")]} />);
    expect(probes).toHaveLength(1);
  });

  it("⚠️ never opens a decoder for a clip the server has already probed", () => {
    // duration_seconds_precise arrived with the clip. Decoding it again is paying twice for the
    // same number, on the commonest case now that uploads are probed at registration.
    render(<Probe clips={[{ ...clip("a"), knownSec: 8.033 }]} />);
    expect(probes).toHaveLength(0);
  });

  it("still measures a clip whose precise value is null or nonsense", () => {
    // Null is load-bearing on the wire: it means "nothing has measured this row", which is exactly
    // when the decoder is the only thing that can answer.
    render(
      <Probe
        clips={[
          { ...clip("a"), knownSec: null },
          { ...clip("b"), knownSec: 0 },
        ]}
      />,
    );
    expect(probes.map((p) => p.uri)).toEqual([
      "https://example.test/a.mp4",
      "https://example.test/b.mp4",
    ]);
  });

  it("skips a clip with no playable bytes", () => {
    render(<Probe clips={[{ assetId: "a", videoUrl: null }]} />);
    expect(probes).toHaveLength(0);
  });

  it("cancels whatever is in flight when the screen goes away", () => {
    const view = render(<Probe clips={[clip("a")]} />);
    expect(probes[0].cancelled).toBe(0);
    view.unmount();
    expect(probes[0].cancelled).toBe(1);
  });
});

describe("how many at once", () => {
  const many = ["a", "b", "c", "d", "e", "f"].map(clip);

  it("opens no more than the cap", () => {
    render(<Probe clips={many} />);
    expect(probes).toHaveLength(MAX_CONCURRENT_PROBES);
  });

  it("starts the next as a slot frees, so it does not stall at the cap", async () => {
    render(<Probe clips={many} />);
    await answer(probes[0], 2);
    expect(probes).toHaveLength(MAX_CONCURRENT_PROBES + 1);
    await answer(probes[1], 2);
    expect(probes).toHaveLength(MAX_CONCURRENT_PROBES + 2);
  });

  it("eventually measures every clip it was given", async () => {
    const view = render(<Probe clips={many} />);
    for (let guard = 0; guard < 20; guard++) {
      const next = probes.find((p) => !("done" in p));
      if (!next) break;
      Object.assign(next, { done: true });
      await answer(next, 1.5);
    }
    const out = JSON.parse(view.getByTestId("out").props.children as string);
    expect(out.map((e: [string, number]) => e[0]).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});

describe("a probe that never answers", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("⚠️ gives up, so it cannot hold its slot for the life of the screen", async () => {
    // A dead url, a codec the browser will not open, or a stalled network answers NOTHING rather
    // than answering an error. Four of those and no clip is ever measured again.
    const many = ["a", "b", "c", "d", "e"].map(clip);
    render(<Probe clips={many} />);
    expect(probes).toHaveLength(MAX_CONCURRENT_PROBES);

    await act(async () => {
      jest.advanceTimersByTime(MEASURE_TIMEOUT_MS + 1);
      await Promise.resolve();
    });

    expect(probes[0].cancelled).toBe(1);
    // …and the freed slot is taken by the clip that was waiting behind it.
    expect(probes.length).toBeGreaterThan(MAX_CONCURRENT_PROBES);
  });
});
