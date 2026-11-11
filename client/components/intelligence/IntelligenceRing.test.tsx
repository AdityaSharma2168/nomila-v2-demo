/**
 * IntelligenceRing — the look B ring: eight arcs from the stored contributions in the capital order, two tones per
 * capital, the neutral track for the rest, the number inside; the glow copies only on black; one ink arc when a server
 * serves no contributions; an empty track with no number when there is no score.
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";

jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View } = require("react-native");
  const El = (p: any) => React.createElement(View, { testID: p.testID, accessibilityLabel: p.stroke, accessibilityHint: String(p.strokeWidth ?? "") }, p.children);
  return { __esModule: true, default: (p: any) => React.createElement(View, null, p.children), Path: El, Circle: El };
});

import { IntelligenceRing, RingLegend, arcPath } from "./IntelligenceRing";
import { ringBands } from "../../lib/myIntelligenceLogic";
import { Ring } from "../../constants/ring";

const dim = (key: string, contribution: number | null) => ({ key, contribution } as any);
const assessment = {
  dimensions: [
    dim("athletic_authority", 11.25), dim("audience_scale", 6), dim("engagement_quality", 11.7), dim("cultural_relevance", 5.7),
    dim("narrative_power", 9), dim("brand_fit", 8.4), dim("commercial_proof", 10.35), dim("momentum", 3.4),
  ],
} as any;

test("eight arcs in the ring's order, each in its capital's tone, then the neutral track; the number and OF 850 inside", () => {
  render(<IntelligenceRing score={608} bands={ringBands(assessment)} size={132} />);
  const keys = ["audience_scale", "engagement_quality", "commercial_proof", "brand_fit", "narrative_power", "cultural_relevance", "athletic_authority", "momentum"];
  const tones = Ring.capitals.flatMap((c) => [...c.tones]);
  keys.forEach((k, i) => {
    const arc = screen.getByTestId(`ring-arc-${k}`);
    expect(arc.props.accessibilityLabel).toBe(tones[i]);
    expect(arc.props.accessibilityHint).toBe("12");                   // stroke ≈ 9% of 132
  });
  expect(screen.getByTestId("ring-track").props.accessibilityLabel).toBe("#E9E9E7");
  expect(screen.queryByTestId("ring-single")).toBeNull();
  expect(screen.getByText("608")).toBeTruthy();
  expect(screen.getByText("of 850")).toBeTruthy();
  expect(screen.getByTestId("intelligence-ring").props.accessibilityLabel).toBe("M.I.A. 608 out of 850, 8 bands");
});

test("on black with glow: the track lifts to the dark line, and each arc gets two wider low-opacity copies under it", () => {
  render(<IntelligenceRing score={608} bands={ringBands(assessment)} size={156} dark glow />);
  expect(screen.getByTestId("ring-track").props.accessibilityLabel).toBe("rgba(255,255,255,0.14)");
  // 8 arcs + 16 glow copies + 1 track = 25 strokes; the glow copies are wider than the 14 stroke (host views only —
  // the mock's composite element carries the same props).
  const host = (hint: string) => screen.UNSAFE_getAllByProps({ accessibilityHint: hint }).filter((i) => typeof i.type === "string").length;
  expect(host("24")).toBe(8);
  expect(host("18")).toBe(8);
  expect(host("14")).toBe(9);
});

test("no stored contributions: one ink arc of the score's share of 850 on a full track; no score: the track alone, no number", () => {
  const { rerender } = render(<IntelligenceRing score={425} />);
  expect(screen.getByTestId("ring-single").props.accessibilityLabel).toBe("#0E0E0E");
  expect(screen.getByTestId("ring-track")).toBeTruthy();
  expect(screen.getByText("425")).toBeTruthy();
  rerender(<IntelligenceRing score={null} />);
  expect(screen.queryByTestId("ring-single")).toBeNull();
  expect(screen.queryByText("425")).toBeNull();
  expect(screen.getByTestId("intelligence-ring").props.accessibilityLabel).toBe("M.I.A. not ready yet");
});

test("a band with no contribution is simply absent; the legend names the four capitals and their pairs", () => {
  const partial = { dimensions: assessment.dimensions.map((d: any) => (d.key === "momentum" ? dim("momentum", null) : d)) } as any;
  render(<><IntelligenceRing score={600} bands={ringBands(partial)} /><RingLegend /></>);
  expect(screen.queryByTestId("ring-arc-momentum")).toBeNull();
  expect(screen.getByTestId("ring-arc-athletic_authority")).toBeTruthy();
  for (const c of Ring.capitals) {
    expect(screen.getByText(c.name)).toBeTruthy();
    expect(screen.getByText(c.sub)).toBeTruthy();
  }
});

test("arcPath: clockwise from 12 o'clock, the large-arc flag past 180°", () => {
  expect(arcPath(50, 50, 40, 0, 90)).toBe("M50.00 10.00A40 40 0 0 1 90.00 50.00");
  expect(arcPath(50, 50, 40, 0, 270)).toBe("M50.00 10.00A40 40 0 1 1 10.00 50.00");
});
