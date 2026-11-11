// CallVideo — one video tile of a booked call (native). CallVideo.web.tsx draws nothing (no call on web).
//
// `fit`: the other person is drawn WHOLE ("contain", letterboxed on the call's black) so a landscape laptop camera on her
// portrait phone isn't cropped to a zoomed-in face; her own small self-view keeps "cover" (the default) to fill its tile.
import React from "react";
import type { ViewStyle } from "react-native";
import { VideoView } from "@livekit/react-native";
import type { VideoTrack } from "livekit-client";

export type CallVideoFit = "cover" | "contain";

export function CallVideo({ track, mirror, fit = "cover", style, zOrder }: { track: unknown; mirror?: boolean; fit?: CallVideoFit; style?: ViewStyle; zOrder?: number }) {
  return <VideoView videoTrack={(track as VideoTrack) ?? undefined} mirror={mirror} objectFit={fit} style={style} zOrder={zOrder} />;
}
