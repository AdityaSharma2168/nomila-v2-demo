/**
 * VideoEntry.gate.test.tsx — a clip the output gate failed, on a surface that shows the gate (quality-scrappy, ADI-QS-2):
 * the Board passes `gate`, so a failed clip is said to have failed — and why — with a fresh check that carries the
 * gate's codes; a surface that does not pass it (the Video tab, carded) draws the entry exactly as before.
 *
 * ⚠️ MUTATION MG4 (docs/probes/quality-scrappy.md): VideoEntry ignores the prop — "on a surface that shows the gate, a
 * failed clip says so" reds by name.
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
jest.mock("./ClipPlayer", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    ClipPlayer: () => React.createElement(Text, null, "player"),
    ClipMissing: () => React.createElement(Text, null, "missing"),
  };
});

import { VideoEntry } from "./VideoEntry";
import { TRY_AGAIN_LABEL } from "./OutputGateNotice";
import { videoEntry } from "../../screens/studio/videoEntryLogic";

const FAILED = {
  failed: true as const,
  headline: "This didn't come out right",
  lines: ["Part of it is a black screen."],
  corrective: ["black"],
};
const view = videoEntry("ready", [
  {
    assetId: "a1",
    mediaType: "VIDEO",
    uri: "https://signed.example/a1.mp4",
    removed: false,
    editable: false,
    rejected: false,
    gate: FAILED,
  },
]);

it("on a surface that shows the gate, a failed clip says so, and why — and Try again carries the gate's codes", () => {
  const onTryAgain = jest.fn();
  render(<VideoEntry view={view} gate={{ onTryAgain }} />);
  expect(screen.getByTestId("output-gate")).toBeTruthy();
  expect(screen.getByText(FAILED.headline)).toBeTruthy();
  expect(screen.getByText(FAILED.lines[0])).toBeTruthy();
  fireEvent.press(screen.getByLabelText(TRY_AGAIN_LABEL));
  expect(onTryAgain).toHaveBeenCalledWith(["black"]);
  // The clip is still there to see: failed is said first, not hidden.
  expect(screen.getByText("player")).toBeTruthy();
});

it("a surface that does not pass the gate draws the entry as it always did (the Video tab, carded)", () => {
  render(<VideoEntry view={view} />);
  expect(screen.queryByTestId("output-gate")).toBeNull();
  expect(screen.getByText("player")).toBeTruthy();
});
