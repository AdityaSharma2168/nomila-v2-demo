/** TitleCard — a short opening card: the hook, fitted to one line width, over the first shot dimmed (or her accent). */
import React from "react";
import { AbsoluteFill, Img, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fitText } from "@remotion/layout-utils";
import { accentFrom, type TitleCardProps } from "../../../shared/remotionProps";
import { fontFamily } from "./font";

export const TitleCard: React.FC<TitleCardProps> = ({ text, background, palette }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const accent = accentFrom(palette);
  const s = spring({ frame, fps, config: { damping: 200 } });
  // One line when it fits at a readable size; otherwise wrap at the cap.
  const fitted = fitText({ text, withinWidth: 840, fontFamily, fontWeight: 800 }).fontSize;
  const size = Math.max(64, Math.min(132, fitted));
  return (
    <AbsoluteFill style={{ backgroundColor: background ? "#000" : accent, fontFamily }}>
      {background ? (
        <AbsoluteFill style={{ transform: `scale(${1.04 + 0.06 * s})` }}>
          <Img src={background} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.45 }} />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 120px" }}>
        <div style={{ width: 120 * s, height: 8, borderRadius: 4, backgroundColor: background ? accent : "#FFFFFF", marginBottom: 30 }} />
        <div style={{
          color: "#FFFFFF", fontSize: size, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2,
          opacity: s, transform: `translateY(${(1 - s) * 36}px)`,
        }}>{text}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
