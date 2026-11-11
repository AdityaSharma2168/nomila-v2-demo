import React from "react";
import { Composition } from "remotion";
import {
  REMOTION_FPS, REMOTION_HEIGHT, REMOTION_WIDTH, cardFrames, reelFrames,
  type BrandBookReelProps, type CountdownProps, type TitleCardProps,
} from "../../../shared/remotionProps";
import { BrandBookReel } from "./BrandBookReel";
import { TitleCard } from "./TitleCard";
import { Countdown } from "./Countdown";

// Studio previews only — every render passes real props.
const sampleReel: BrandBookReelProps = {
  firstName: "Alex",
  scenes: [
    { image: "https://picsum.photos/seed/a/1080/1920", kicker: "ALEX", text: "You lead like the game is bigger than the result." },
    { image: "https://picsum.photos/seed/b/1080/1920", kicker: "THE BIG IDEA", text: "The first one through holds the door." },
  ],
  palette: ["#C8102E", "#1B1B1B"], music: null, sceneSec: 3.2, transitionSec: 0.5, outroSec: 2,
};
const sampleTitle: TitleCardProps = { text: "Road trip. Same standard.", background: null, palette: [], seconds: 2 };
const sampleCountdown: CountdownProps = { days: 5, moment: "Home opener", background: null, palette: [], seconds: 2 };

const size = { fps: REMOTION_FPS, width: REMOTION_WIDTH, height: REMOTION_HEIGHT };

export const Root: React.FC = () => (
  <>
    <Composition
      id="BrandBookReel"
      component={BrandBookReel}
      defaultProps={sampleReel}
      durationInFrames={reelFrames(sampleReel)}
      calculateMetadata={({ props }) => ({ ...size, durationInFrames: reelFrames(props) })}
      {...size}
    />
    <Composition
      id="TitleCard"
      component={TitleCard}
      defaultProps={sampleTitle}
      durationInFrames={cardFrames(sampleTitle.seconds)}
      calculateMetadata={({ props }) => ({ ...size, durationInFrames: cardFrames(props.seconds) })}
      {...size}
    />
    <Composition
      id="Countdown"
      component={Countdown}
      defaultProps={sampleCountdown}
      durationInFrames={cardFrames(sampleCountdown.seconds)}
      calculateMetadata={({ props }) => ({ ...size, durationInFrames: cardFrames(props.seconds) })}
      {...size}
    />
  </>
);
