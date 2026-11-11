/**
 * BrandBookReel — the brand book as a vertical motion piece. One scene per crafted line, each over one of her photos:
 * a slow camera move on the photo, the kicker sliding in, the line arriving word by word, an accent rule in her colour;
 * scenes join with a soft fade or slide; it closes on her name over her accent. Safe zones: the words stay clear of the
 * bottom quarter and the right rail (Reels UI).
 */
import React from "react";
import {
  AbsoluteFill, Audio, Img, interpolate, spring, useCurrentFrame, useVideoConfig,
} from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { accentFrom, lineSize, type BrandBookReelProps, type ReelScene } from "../../../shared/remotionProps";
import { fontFamily } from "./font";

const PINK_SOFT = "#F28DBB";

const Words: React.FC<{ text: string; delay: number; size: number }> = ({ text, delay, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: size * 0.26, rowGap: size * 0.04 }}>
      {words.map((w, i) => {
        const s = spring({ frame: frame - delay - i * 2, fps, config: { damping: 200, stiffness: 120 } });
        return (
          <span key={i} style={{
            display: "inline-block", color: "#FFFFFF", fontSize: size, fontWeight: 800, lineHeight: 1.06,
            letterSpacing: -1, opacity: s, transform: `translateY(${(1 - s) * 28}px)`,
          }}>{w}</span>
        );
      })}
    </div>
  );
};

const Scene: React.FC<{ scene: ReelScene; index: number; accent: string }> = ({ scene, index, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  // The camera: alternate a push-in and a slow drift so consecutive scenes never move the same way.
  const t = frame / Math.max(1, durationInFrames);
  const scale = index % 2 === 0 ? interpolate(t, [0, 1], [1.04, 1.16]) : interpolate(t, [0, 1], [1.14, 1.06]);
  const drift = index % 2 === 0 ? 0 : interpolate(t, [0, 1], [-24, 24]);
  const kicker = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const rule = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0B08", fontFamily }}>
      <AbsoluteFill style={{ transform: `scale(${scale}) translateX(${drift}px)` }}>
        <Img src={scene.image} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.62) 72%, rgba(0,0,0,0.82) 100%)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", paddingLeft: 72, paddingRight: 168, paddingBottom: 1920 * 0.25 + 40 }}>
        <div style={{ width: 120 * rule, height: 8, borderRadius: 4, backgroundColor: accent, marginBottom: 26 }} />
        <div style={{
          color: PINK_SOFT, fontSize: 30, fontWeight: 600, letterSpacing: 6, marginBottom: 18,
          opacity: kicker, transform: `translateX(${(1 - kicker) * -30}px)`,
        }}>{scene.kicker}</div>
        <Words text={scene.text} delay={10} size={lineSize(scene.text)} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ firstName: string; accent: string }> = ({ firstName, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ backgroundColor: accent, fontFamily, justifyContent: "center", alignItems: "flex-start", padding: 96 }}>
      <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 34, fontWeight: 600, letterSpacing: 8, opacity: s }}>BRAND BOOK</div>
      <div style={{
        color: "#FFFFFF", fontSize: 168, fontWeight: 900, letterSpacing: -6, lineHeight: 0.95,
        transform: `translateY(${(1 - s) * 40}px)`, opacity: s,
      }}>{firstName}</div>
      <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 30, fontWeight: 600, letterSpacing: 10, marginTop: 28, opacity: s }}>NOMILA</div>
    </AbsoluteFill>
  );
};

export const BrandBookReel: React.FC<BrandBookReelProps> = (p) => {
  const { fps, durationInFrames } = useVideoConfig();
  const accent = accentFrom(p.palette);
  const scene = Math.round(p.sceneSec * fps);
  const trans = Math.round(p.transitionSec * fps);
  const outro = Math.round(p.outroSec * fps);
  const fadeOut = Math.round(1.2 * fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0B08" }}>
      <TransitionSeries>
        {p.scenes.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 ? (
              <TransitionSeries.Transition
                presentation={i % 3 === 0 ? slide({ direction: "from-bottom" }) : fade()}
                timing={linearTiming({ durationInFrames: trans })}
              />
            ) : null}
            <TransitionSeries.Sequence durationInFrames={scene}>
              <Scene scene={s} index={i} accent={accent} />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: trans })} />
        <TransitionSeries.Sequence durationInFrames={Math.max(outro, trans + 1)}>
          <Outro firstName={p.firstName} accent={accent} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      {p.music ? (
        <Audio
          src={p.music}
          loop
          volume={(f) => interpolate(f, [0, fps * 0.8, durationInFrames - fadeOut, durationInFrames], [0, 0.7, 0.7, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
        />
      ) : null}
    </AbsoluteFill>
  );
};
