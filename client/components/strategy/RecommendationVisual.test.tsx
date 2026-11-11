/**
 * RecommendationVisual — the photo card's image and the CATEGORY DEFAULT (look B): the black ground, the category word
 * outlined and running off the edge, its Feather icon, and ONE blue geometric mark per category — Impact a diagonal
 * band, Positioning a dot grid, Audience rising bars, Commercial a corner block, Performance a chevron. Every goal
 * domain maps to one of the five; the photo, when there is one, takes precedence; a platform item adds its mark.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View, Text } = require("react-native");
  const El = (p: any) => React.createElement(View, { testID: p.testID, accessibilityLabel: p.fill ?? p.stroke }, p.children);
  return {
    __esModule: true,
    default: (p: any) => React.createElement(View, { testID: p.testID }, p.children),
    Circle: El, Polygon: El, Rect: El, ClipPath: El, Defs: El,
    Text: (p: any) => React.createElement(Text, { accessibilityLabel: p.stroke }, p.children),
  };
});

import { CategoryDefault, DOMAIN_MARK, DOMAIN_ICON, domainTile, RecommendationVisual } from "./RecommendationVisual";
import { Bold } from "../../constants/theme";

const layout = (w = 236, h = 200) => fireEvent(screen.getByTestId("visual-default"), "layout", { nativeEvent: { layout: { width: w, height: h } } });

test("every goal domain maps to one of the five marks and one Feather glyph; an unknown domain gets the target and no mark", () => {
  expect(Object.keys(DOMAIN_MARK).sort()).toEqual(Object.keys(DOMAIN_ICON).sort());
  expect(new Set(Object.values(DOMAIN_MARK))).toEqual(new Set(["impact", "positioning", "audience", "commercial", "performance"]));
  expect(domainTile("impact")).toEqual({ icon: "heart", mark: "impact" });
  expect(domainTile("positioning")).toEqual({ icon: "layers", mark: "positioning" });
  expect(domainTile("audience")).toEqual({ icon: "users", mark: "audience" });
  expect(domainTile("content")).toEqual({ icon: "film", mark: "audience" });
  expect(domainTile("commercial")).toEqual({ icon: "briefcase", mark: "commercial" });
  expect(domainTile("owned_venture")).toEqual({ icon: "box", mark: "commercial" });
  expect(domainTile("athletic")).toEqual({ icon: "activity", mark: "performance" });
  expect(domainTile("career")).toEqual({ icon: "award", mark: "performance" });
  expect(domainTile("nope")).toEqual({ icon: "target", mark: null });
  expect(domainTile(null)).toEqual({ icon: "target", mark: null });
});

test.each([
  ["impact", "IMPACT", "icon:heart"],
  ["positioning", "POSITIONING", "icon:layers"],
  ["audience", "AUDIENCE", "icon:users"],
  ["commercial", "COMMERCIAL", "icon:briefcase"],
  ["athletic", "ATHLETIC", "icon:activity"],
])("the %s category default: its mark on the ink tile, the word outlined in white, the glyph", (domain, word, icon) => {
  render(<CategoryDefault domain={domain} height={200} />);
  expect(screen.queryByText(word)).toBeNull();                     // nothing before the tile knows its width
  layout();
  const mark = domainTile(domain).mark!;
  expect(screen.getByTestId(`catd-${mark}`)).toBeTruthy();
  expect(screen.getByText(word).props.accessibilityLabel).toBe("rgba(255,255,255,0.3)");
  expect(screen.getByText(icon)).toBeTruthy();
  // The mark is in the on-dark link colour (it sits on the ink tile; Bold.blue is ink since the one look).
  const fills = screen.UNSAFE_getAllByProps({ accessibilityLabel: Bold.blueOnDark });
  expect(fills.length).toBeGreaterThan(0);
});

test("the visual: her photo wins over the default; a brand cover wins over both; a platform item adds its mark; the default keeps its testID", () => {
  const goal = { kind: "goal_tile", domain: "impact" } as any;
  const { rerender } = render(<RecommendationVisual visual={goal} photoUrl="https://x/p.jpg" height={150} />);
  expect(screen.getByTestId("visual-photo")).toBeTruthy();
  expect(screen.queryByTestId("visual-default")).toBeNull();
  rerender(<RecommendationVisual visual={goal} photoUrl={null} height={150} />);
  expect(screen.getByTestId("visual-default")).toBeTruthy();
  expect(screen.getByTestId("visual-goal_tile")).toBeTruthy();
  rerender(<RecommendationVisual visual={{ kind: "brand", domain: "impact", brandImageUrl: "https://b/c.jpg" } as any} photoUrl="https://x/p.jpg" height={150} />);
  expect(screen.getByTestId("visual-brand-image")).toBeTruthy();
  rerender(<RecommendationVisual visual={{ kind: "platform", platform: "tiktok", domain: "audience" } as any} photoUrl={null} height={150} />);
  expect(screen.getByTestId("visual-platform")).toBeTruthy();
  expect(screen.getByLabelText("tiktok")).toBeTruthy();
});

test("a brand / organisation / team card without a cover: its logo alone, else the default — NEVER her photo, even when one is offered", () => {
  const logo = { kind: "logo", logoUrl: "https://www.google.com/s2/favicons?domain=riversiderovers.com&sz=128", name: "Riverside Rovers", site: "riversiderovers.com", domain: "career" } as any;
  const { rerender } = render(<RecommendationVisual visual={logo} photoUrl="https://x/p.jpg" height={150} />);
  expect(screen.getByTestId("visual-logo-panel")).toBeTruthy();
  expect(screen.getByLabelText("Riverside Rovers")).toBeTruthy();
  expect(screen.queryByTestId("visual-photo")).toBeNull();
  rerender(<RecommendationVisual visual={{ ...logo, logoUrl: null, site: null }} photoUrl="https://x/p.jpg" height={150} />);
  expect(screen.getByTestId("visual-default")).toBeTruthy();
  expect(screen.queryByTestId("visual-photo")).toBeNull();
});
