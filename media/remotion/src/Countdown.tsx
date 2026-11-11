/** Countdown — "N days to {moment}": the number counts down into place, the moment fitted under it. */
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fitText } from "@remotion/layout-utils";
import { accentFrom, type CountdownProps } from "../../../shared/remotionProps";
import { fontFamily } from "./font";

export const Countdown: React.FC<CountdownProps> = ({ days, moment, background, palette }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const accent = accentFrom(palette);
  const s = spring({ frame, fps, config: { damping: 200 } });
  // Ticks down from a few above to the real number over the first second.
  const start = days + Math.min(5, Math.max(0, 9 - days));
  const shown = Math.round(interpolate(frame, [0, fps], [start, days], { extrapolateRight: "clamp" }));
  const label = days === 1 ? "DAY TO" : "DAYS TO";
  const momentSize = Math.max(56, Math.min(110, fitText({ text: moment, withinWidth: 860, fontFamily, fontWeight: 800 }).fontSize));
  return (
    <AbsoluteFill style={{ backgroundColor: background ? "#000" : "#0D0B08", fontFamily }}>
      {background ? <Img src={background} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.38 }} /> : null}
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 110px" }}>
        <div style={{ color: accent, fontSize: 460, fontWeight: 900, lineHeight: 0.9, letterSpacing: -20, opacity: s }}>{shown}</div>
        <div style={{ color: "#FFFFFF", fontSize: 40, fontWeight: 600, letterSpacing: 10, margin: "18px 0 14px" }}>{label}</div>
        <div style={{ color: "#FFFFFF", fontSize: momentSize, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2, transform: `translateY(${(1 - s) * 30}px)` }}>{moment}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
