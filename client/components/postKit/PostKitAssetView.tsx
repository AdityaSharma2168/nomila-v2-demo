/**
 * PostKitAssetView — the chosen media for a post kit asset: plays a clip's window ONCE (from its clip range's start,
 * pausing at its end; a bumped `token` plays it again) with the same windowed player the Board uses
 * (client/components/studio/BoardClipPlayer.tsx), or shows a photo, or a clip's poster while it is not playing.
 *
 * When the kit's preview render is ready, the screen passes the rendered file for this position (`rendered`, from
 * preview.ts) and it is drawn instead: a rendered video plays whole, once (its poster the cover frame), a rendered
 * slide is shown as itself. Otherwise it draws the chosen asset itself, from the kit's own `media` array
 * (PostKitResponse.media: thumbUrl/videoUrl per asset, `available` false once an asset is gone) — never blocked on the
 * render. The same `previewKind` arithmetic the media library uses (client/components/studio/playerBox.ts) decides
 * image vs. nothing to show.
 *
 * Two shapes:
 *   boxed (default)  the bounded, correctly-shaped box a detail screen uses (playerBox), corner 6, native controls
 *   fill             full-bleed and cover-cropped, NO native controls, fullscreen or PiP (PlayerSurface `fill`) — for
 *                    the Studio "For you" feed, which draws its own buttons over the media
 *
 * `usePlaybackAllowed` is what a screen gates `playing` on: the screen is focused and the app is in the foreground, so
 * nothing keeps playing behind another screen or with the phone locked.
 */
import React, { useEffect, useMemo, useState } from "react";
import { AppState, StyleSheet, Text, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { Photo } from "../ui/Photo";
import { BoardClipPlayer, type BoardClipWindow } from "../studio/BoardClipPlayer";
import { playerBox, previewKind } from "../studio/playerBox";
import { Bold, BoldType } from "../../constants/theme";
import type { PostKitAsset, PostKitResponse } from "../../../shared/postKit";
import type { RenderedFile } from "./preview";

export type PostKitMediaRow = PostKitResponse["media"][number];

/** 9:16 or 4:5 (PostAspect) as width ÷ height. */
export function ratioOf(aspect: "9:16" | "4:5"): number {
  return aspect === "9:16" ? 9 / 16 : 4 / 5;
}

/** The media row for one of a kit's assets (or its shortlist), by id. Pure, so it is unit-tested without a server. */
export function mediaFor(kit: PostKitResponse | null | undefined, assetId: string): PostKitMediaRow | undefined {
  return kit?.media.find((m) => m.assetId === assetId);
}

/** The screen is focused and the app is in the foreground: the only time a post kit's clip may play. */
export function usePlaybackAllowed(): boolean {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState !== "background");
  useEffect(() => {
    // Only the background stops it: "inactive" (a passing system sheet on iOS) is not a reason to restart her clip.
    const sub = AppState.addEventListener("change", (s) => setAppActive(s !== "background"));
    return () => sub.remove();
  }, []);
  return focused && appActive;
}

export const ASSET_VIEW_COPY = { gone: "This one's no longer in your library" } as const;

/** A rendered video plays whole, from its start (a clip's range is already cut into it). Stable, so it never replays on a re-render. */
const WHOLE: BoardClipWindow = { startSec: 0, endSec: null };

export function PostKitAssetView({ asset, media, rendered = null, ratio, playing, muted, token, maxHeight, fill = false, style, testID }: {
  asset: PostKitAsset;
  media: PostKitMediaRow | undefined;
  /**
   * The rendered preview for this position (preview.ts: a reel's video, or a carousel's slide), when it is ready: drawn
   * instead of the raw asset. Null = the raw asset, as before.
   */
  rendered?: RenderedFile | null;
  ratio: number;
  /** Plays the clip's window once (muted autoplay) rather than showing its poster. */
  playing: boolean;
  muted: boolean;
  /** Bumped to play the same window again from its start. */
  token: number;
  maxHeight?: number;
  /** Full-bleed, cover-cropped, no native controls (the feed). */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  // Stable across renders (BoardClipPlayer restarts whenever its `window` object changes identity — a fresh
  // literal every render would replay the clip on every parent re-render, not just a token bump).
  const clipStart = asset.clip?.startSec ?? 0;
  const clipEnd = asset.clip?.endSec ?? 0;
  const window = useMemo(() => ({ startSec: clipStart, endSec: clipEnd }), [clipStart, clipEnd]);
  const box = fill ? styles.fill : [styles.frame, playerBox(ratio, maxHeight)];
  // Nothing to show: on the feed's black ground the blank hero (DESIGN.md §8a), on a white screen the grey tile.
  const empty = fill ? styles.emptyOnDark : styles.empty;
  const glyph = fill ? Bold.onDarkMute : Bold.quiet;

  if (rendered) {
    if (rendered.kind === "video" && playing) {
      return (
        <View style={[fill ? styles.fill : null, style]} testID={testID ?? "post-kit-preview-clip"}>
          <BoardClipPlayer uri={rendered.url} window={WHOLE} muted={muted} token={token} ratio={ratio} maxHeight={maxHeight} fill={fill} radius={Bold.radius.card} />
        </View>
      );
    }
    // A picture slide is itself; a video's poster is its cover frame when it carries it, else the source's own still.
    const still = rendered.kind === "image" ? rendered.url : rendered.posterUrl ?? (media?.available ? media.thumbUrl : null);
    const key = rendered.kind === "image" || rendered.posterUrl ? rendered.assetId : media?.assetId;
    if (still) return <Photo uri={still} cacheKey={key} style={[box, style] as StyleProp<ImageStyle>} testID={testID ?? "post-kit-preview-still"} />;
    return (
      <View style={[box, empty, style]} testID={testID ?? "post-kit-preview-still"}>
        <Feather name="film" size={18} color={glyph} />
      </View>
    );
  }

  if (!media || !media.available) {
    return (
      <View style={[box, empty, style]} testID={testID ?? "post-kit-asset-missing"}>
        <Feather name="slash" size={18} color={glyph} />
        <Text style={[styles.emptyText, fill && styles.emptyTextOnDark]}>{ASSET_VIEW_COPY.gone}</Text>
      </View>
    );
  }
  const kind = previewKind(media);
  if (playing && kind !== "empty" && asset.mediaType === "clip" && media.videoUrl && asset.clip) {
    return (
      <View style={[fill ? styles.fill : null, style]} testID={testID ?? "post-kit-asset-clip"}>
        <BoardClipPlayer uri={media.videoUrl} window={window} muted={muted} token={token} ratio={ratio} maxHeight={maxHeight} fill={fill} radius={Bold.radius.card} />
      </View>
    );
  }
  if (media.thumbUrl) {
    return <Photo uri={media.thumbUrl} cacheKey={media.assetId} style={[box, style] as StyleProp<ImageStyle>} testID={testID ?? "post-kit-asset-photo"} />;
  }
  return (
    <View style={[box, empty, style]} testID={testID ?? "post-kit-asset-empty"}>
      <Feather name={asset.mediaType === "clip" ? "film" : "image"} size={18} color={glyph} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", alignSelf: "center", borderRadius: Bold.radius.card, overflow: "hidden", backgroundColor: Bold.ink },
  fill: { ...StyleSheet.absoluteFill, borderRadius: Bold.radius.none, overflow: "hidden", backgroundColor: Bold.ink },
  empty: { alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Bold.ground, padding: 16 },
  emptyOnDark: { alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Bold.heroBlank, padding: 16 },
  emptyText: { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  emptyTextOnDark: { color: Bold.onDarkMute },
});
