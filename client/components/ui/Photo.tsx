// Photo — every remote photo in the app draws through this: expo-image with a memory + disk cache keyed on the photo's
// stable identity (lib/imageCache), so a photo seen once draws at once on the next screen and the next launch, even
// though its signed url changed. Local files (file://, the camera roll) pass through unchanged.

import React from "react";
import { Image, type ImageContentFit, type ImageContentPosition } from "expo-image";
import type { StyleProp, ImageStyle } from "react-native";
import { cachedSource } from "../../lib/imageCache";

export interface PhotoProps {
  uri: string;
  /** A stable id when the caller has one (an asset id); else the url's path is used for signed urls. */
  cacheKey?: string | null;
  style?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
  contentPosition?: ImageContentPosition;
  /** Fade-in in ms; 0 for small marks that should simply appear. */
  transition?: number;
  onError?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}

export function Photo({ uri, cacheKey, style, contentFit = "cover", contentPosition, transition = 120, onError, testID, accessibilityLabel }: PhotoProps) {
  return (
    <Image
      source={cachedSource(uri, cacheKey)}
      style={style}
      contentFit={contentFit}
      contentPosition={contentPosition}
      cachePolicy="memory-disk"
      transition={transition}
      recyclingKey={cacheKey ?? uri}
      onError={onError}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityIgnoresInvertColors
    />
  );
}
