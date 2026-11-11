import { Bold } from "../../constants/theme";
import React from "react";
import Svg, { Path, Circle } from "react-native-svg";

/** Minimal line sparkline. Normalizes values to the box; renders nothing for <2 points. */
export function Sparkline({
  values, width = 220, height = 48, color = Bold.ink, strokeWidth = 2,
}: {
  values: number[]; width?: number; height?: number; color?: string; strokeWidth?: number;
}) {
  const pts = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (pts.length < 2) return null;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const pad = 3;
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (pts.length - 1);
  const coords = pts.map((v, i) => ({
    x: pad + i * stepX,
    y: pad + (height - pad * 2) * (1 - (v - min) / span),
  }));
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];

  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={last.x} cy={last.y} r={3} fill={color} />
    </Svg>
  );
}
