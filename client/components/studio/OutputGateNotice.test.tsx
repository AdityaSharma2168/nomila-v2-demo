/**
 * OutputGateNotice.test.tsx — the output gate, rendered (quality-scrappy piece 5, ADI-QS-GO): the notice alone, on the
 * workspace's result (GenerationResult) and on the thread's card (PlanCard). What is asserted is what the server tests
 * cannot see: that a failed output is SHOWN as failed, that "try again" only asks for a check with the gate's codes,
 * and that with no gate on the wire nothing new renders.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M5j — the thread's Try again wired to plain Check again (the codes dropped): "Try again carries the gate's codes"
 *         reds.
 *   M5k — GenerationResult ignores the gate: "a failed image is shown as failed, with why" reds.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});
jest.mock("react-native-reanimated", () =>
  require("react-native-reanimated/mock"),
);
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = {
    tap: noop,
    press: noop,
    select: noop,
    success: noop,
    warning: noop,
    error: noop,
  };
  return { ...fns, haptics: fns };
});
// Neighbours that fetch: stood in, they are not what this file is about.
jest.mock("./QaChip", () => ({ QaChip: () => null }));
jest.mock("./AssetViewer", () => ({ AssetViewer: () => null }));
jest.mock("../../screens/studio/MakeItScreen", () => ({
  InterpretationCard: () => null,
}));

import { OutputGateNotice, TRY_AGAIN_LABEL } from "./OutputGateNotice";
import { GenerationResult } from "./GenerationResult";
import { PlanCard } from "../../screens/studio/ThreadCards";
import type { GeneratedAsset } from "../../hooks/use-studio";
import type { PlanCardView } from "../../screens/studio/threadLogic";

const GATE = {
  failed: true as const,
  headline: "This didn't come out right",
  lines: ["Part of it is a black screen.", "Part of it is frozen."],
  corrective: ["black", "frozen"],
};

describe("the notice", () => {
  it("says what went wrong, in sentences, with no number", () => {
    render(<OutputGateNotice headline={GATE.headline} lines={GATE.lines} />);
    expect(screen.getByText(GATE.headline)).toBeTruthy();
    expect(screen.getByText("Part of it is frozen.")).toBeTruthy();
    // The words on screen — not the styles — carry no number.
    const words: string[] = [];
    const walk = (n: unknown): void => {
      if (typeof n === "string") words.push(n);
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object")
        walk((n as { children?: unknown }).children);
    };
    walk(screen.toJSON());
    expect(words.join(" ")).not.toMatch(/\d/);
    expect(screen.queryByText(TRY_AGAIN_LABEL)).toBeNull();
  });

  it("its button only asks — it calls what the surface gave it, nothing else", () => {
    const tryAgain = jest.fn();
    render(
      <OutputGateNotice
        headline={GATE.headline}
        lines={GATE.lines}
        onTryAgain={tryAgain}
      />,
    );
    fireEvent.press(screen.getByTestId("output-gate-try-again"));
    expect(tryAgain).toHaveBeenCalledTimes(1);
  });
});

describe("GenerationResult (the workspace)", () => {
  const asset = (over: Partial<GeneratedAsset> = {}): GeneratedAsset => ({
    assetId: "22222222-2222-4222-8222-222222222222",
    mediaType: "IMAGE",
    url: "https://signed.example/a.png",
    approvalStatus: "draft",
    allowedNext: ["approved", "rejected"],
    ...over,
  });
  const props = { busy: false, note: null, error: null, onDecide: jest.fn() };

  it("a failed image is shown as failed, with why — and Try again hands back the gate's codes", () => {
    const tryAgain = jest.fn();
    render(
      <GenerationResult
        {...props}
        assets={[asset({ gate: GATE })]}
        onTryAgain={tryAgain}
      />,
    );
    expect(screen.getByTestId("output-gate")).toBeTruthy();
    expect(screen.getByText("Part of it is a black screen.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("output-gate-try-again"));
    expect(tryAgain).toHaveBeenCalledWith(["black", "frozen"]);
  });

  it("no gate, or a pending one: the result it was", () => {
    render(
      <GenerationResult
        {...props}
        assets={[asset(), asset({ assetId: "b", gate: { pending: true } })]}
      />,
    );
    expect(screen.queryByTestId("output-gate")).toBeNull();
  });
});

describe("PlanCard (the thread)", () => {
  const view = (gate?: typeof GATE): PlanCardView =>
    ({
      key: "k",
      state: "made",
      collapsed: false,
      headline: "Made",
      note: null,
      lines: null,
      builtFrom: [],
      outputs: [
        {
          assetId: "a1",
          mediaType: "IMAGE",
          uri: "https://signed.example/a1.png",
          removed: false,
          editable: true,
          rejected: false,
          ...(gate ? { gate } : {}),
        },
      ],
      loading: false,
      checkAgain: true,
      teaching: null,
    }) as unknown as PlanCardView;
  const handlers = () => ({
    onCheckAgain: jest.fn(),
    onTryAgain: jest.fn(),
    onOpen: jest.fn(),
    onEdit: jest.fn(),
    onOpenDetail: jest.fn(),
  });

  it("a failed output: the notice, no Edit this, not 'on your Made shelf'", () => {
    const h = handlers();
    render(<PlanCard view={view(GATE)} {...h} />);
    expect(screen.getByTestId("output-gate")).toBeTruthy();
    expect(screen.queryByText("Edit this")).toBeNull();
    expect(screen.queryByText("On your Made shelf")).toBeNull();
  });

  it("Try again carries the gate's codes — a fresh check with the fix, never plain Check again", () => {
    const h = handlers();
    render(<PlanCard view={view(GATE)} {...h} />);
    fireEvent.press(screen.getByTestId("output-gate-try-again"));
    expect(h.onTryAgain).toHaveBeenCalledWith(["black", "frozen"]);
    expect(h.onCheckAgain).not.toHaveBeenCalled();
  });

  it("no gate: the card it was — Edit this, and on your Made shelf", () => {
    const h = handlers();
    render(<PlanCard view={view()} {...h} />);
    expect(screen.queryByTestId("output-gate")).toBeNull();
    expect(screen.getByText("Edit this")).toBeTruthy();
    expect(screen.getByText("On your Made shelf")).toBeTruthy();
  });
});
