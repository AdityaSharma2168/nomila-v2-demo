/**
 * use-contained-stage — the React half of the contained-stage maths.
 *
 * The arithmetic lives in ./contained-stage, deliberately: it is what was wrong, and this project's
 * jest runs client suites with NO renderer (jest.config.cjs), so anything importing react-native is
 * untestable here. Splitting leaves the part that broke covered and the part that cannot be covered
 * down to three lines of state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { containedRect, stageHeightFor } from "./contained-stage";

export { containedRect, regionToPixels, stageHeightFor, type Rect } from "./contained-stage";

/**
 * Measure a container, learn its photo's aspect, and report where the photo lands inside it.
 *
 * `Image.getSize` is used ONLY to lay the image out. A failure costs the letterbox maths, not
 * correctness — so it falls back to the container's own shape rather than blocking her.
 */
export function useContainedStage(imageUrl: string | null | undefined) {
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    setRatio(null);
    if (!imageUrl) return;
    let alive = true;
    Image.getSize(
      imageUrl,
      (w, h) => {
        if (alive && w > 0 && h > 0) setRatio(w / h);
      },
      () => {
        if (alive) setRatio(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [imageUrl]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setFrame({ w: width, h: height });
  }, []);

  const stageHeight = useMemo(
    () => stageHeightFor(frame?.w ?? null, ratio, windowHeight),
    [ratio, frame?.w, windowHeight],
  );

  const drawn = useMemo(() => containedRect(frame, ratio), [frame, ratio]);

  return { frame, ratio, onLayout, stageHeight, drawn };
}
