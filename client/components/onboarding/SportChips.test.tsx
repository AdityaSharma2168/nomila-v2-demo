/**
 * SportChips.test — Mila's chat variant of the sport grid (not wired into the chat yet): the eight common sports as icon
 * chips with the grid's Main / pick rules, "More sports" opening the full list in a sheet (search filters every sport,
 * words matching none offer "Add … as your sport"), "Other" opening the same sheet, and picks the chips do not show
 * drawn as removable pills. No network, no provider.
 */
import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { COMMON_SPORTS, SportChips } from "./SportChips";
import { FRONT_COPY } from "../../screens/onboarding/frontCopy";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Feather: () => null, MaterialCommunityIcons: ({ name }: { name: string }) => React.createElement(View, { testID: `mdi-${name}` }) };
});
jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View } = require("react-native");
  const Svg = (p: Record<string, unknown>) => React.createElement(View, { testID: p.testID });
  const Stub = () => null;
  return { __esModule: true, default: Svg, G: Stub, Path: Stub, Rect: Stub, Circle: Stub };
});
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/query-client", () => ({ getApiUrl: () => "http://localhost" }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const picks: { current: string[] } = { current: [] };
function Harness({ initial = [] as string[] }) {
  const [v, setV] = useState<string[]>(initial);
  picks.current = v;
  return <SportChips value={v} onChange={setV} />;
}
const chip = (s: string) => screen.getByTestId(`chip-${s}`);

it("draws the eight common sports with their icons, and More sports and Other", () => {
  render(<Harness />);
  expect(COMMON_SPORTS).toHaveLength(8);
  for (const s of COMMON_SPORTS) expect(chip(s)).toBeTruthy();
  expect(within(chip("Soccer")).getByTestId("mdi-soccer")).toBeTruthy();
  expect(screen.getByText(FRONT_COPY.sport.more)).toBeTruthy();
  expect(screen.getByText(FRONT_COPY.sport.otherShort)).toBeTruthy();
  expect(screen.queryByTestId("sport-sheet")).toBeNull();
});

it("first pick is Main, the next a check; turning Main off promotes the next", () => {
  render(<Harness />);
  fireEvent.press(chip("Soccer"));
  fireEvent.press(chip("Track and field"));
  expect(within(chip("Soccer")).getByTestId("sport-main-badge")).toBeTruthy();
  expect(within(chip("Track and field")).getByTestId("sport-check-Track and field")).toBeTruthy();
  expect(chip("Soccer").props.accessibilityLabel).toBe("Soccer, main sport, selected");
  fireEvent.press(chip("Soccer"));
  expect(picks.current).toEqual(["Track and field"]);
  expect(within(chip("Track and field")).getByTestId("sport-main-badge")).toBeTruthy();
});

it("More sports opens every sport with search; a pick there shows as a pill under the chips", () => {
  render(<Harness initial={["Soccer"]} />);
  fireEvent.press(screen.getByTestId("chip-more"));
  expect(screen.getByTestId("sheet-Lacrosse")).toBeTruthy();
  expect(within(screen.getByTestId("sheet-Pickleball")).getByTestId("sport-glyph-pickleball")).toBeTruthy();
  fireEvent.changeText(screen.getByTestId("sport-sheet-search"), "vol");
  expect(screen.getByTestId("sheet-Beach volleyball")).toBeTruthy();
  expect(screen.queryByTestId("sheet-Lacrosse")).toBeNull();
  expect(screen.queryByTestId("sport-sheet-add")).toBeNull();
  fireEvent.press(screen.getByTestId("sheet-Beach volleyball"));
  fireEvent.press(screen.getByTestId("sport-sheet-done"));
  expect(screen.queryByTestId("sport-sheet")).toBeNull();
  expect(picks.current).toEqual(["Soccer", "Beach volleyball"]);
  expect(screen.getByTestId("chip-picked-Beach volleyball")).toBeTruthy();
});

it("Other: words matching no sport are added as your sport; the pill's ✕ removes it", () => {
  render(<Harness />);
  fireEvent.press(screen.getByTestId("chip-other"));
  fireEvent.changeText(screen.getByTestId("sport-sheet-search"), "Ultimate frisbee");
  fireEvent.press(screen.getByTestId("sport-sheet-add"));
  expect(picks.current).toEqual(["Ultimate frisbee"]);
  fireEvent.press(screen.getByTestId("sport-sheet-done"));
  const pill = screen.getByTestId("chip-picked-Ultimate frisbee");
  expect(within(pill).getByText(`${FRONT_COPY.sport.main} · Ultimate frisbee`)).toBeTruthy();
  fireEvent.press(pill);
  expect(picks.current).toEqual([]);
});
