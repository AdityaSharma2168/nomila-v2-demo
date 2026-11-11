/**
 * MusicChoices — the post kit's three suggested tracks (AGENT_POST_KIT_MUSIC_CHOICES): hear each one with the preview,
 * then pick the one that goes in the post.
 *
 * Listening never chooses (the Studio Board's rule, components/studio/TimelineBuilder.tsx): play starts the track and
 * asks the screen to restart the preview — muted, as it always plays — so she hears the music against the cut. "Use
 * this" saves the pick; the preview is then made again with that track under it. A track that owes a credit (CC BY)
 * says its credit stays in her caption while it is the one in use (the server keeps it there). Trending and platform
 * sounds (TikTok's Commercial Music Library, Meta's Sound Collection) are added in those apps — a line says so; they
 * are never in this list. A track picked on a Content ID-registered recording says a YouTube claim is possible and how
 * to clear it. A choice that is no longer allowed (the post became brand work after the kit was built) shows why and
 * cannot be used. Losing focus or going to the background stops the music.
 *
 * One player for the card; the latest tap wins (a slow link for one track never starts over the next one).
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Button, Card, Eyebrow } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { POST_KIT_COPY } from "./copy";
import type { PostKitMusicView } from "../../../shared/postKit";

export function MusicChoices({ music, editable, busy, active, onUse, onListen }: {
  music: PostKitMusicView;
  /** The screen is in view and the app in the foreground (PostKitAssetView usePlaybackAllowed): false pauses. */
  active: boolean;
  editable: boolean;
  /** A music write is in flight: the choices wait. */
  busy: boolean;
  onUse: (trackId: string | null) => void;
  /** Listening started (true) or stopped (false): the screen restarts the preview on true. */
  onListen: (on: boolean) => void;
}) {
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<string | null>(null);

  // It ran to the end: the button goes back to play.
  useEffect(() => {
    if (status.didJustFinish) { setPlaying(null); onListen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onListen is the screen's, stable enough for a stop
  }, [status.didJustFinish]);
  // The screen lost focus (another screen on top) or the app went to the background: the music stops. The card is
  // still mounted here, so its player is alive and pausing it is safe.
  useEffect(() => {
    if (active || playing === null) return;
    player.pause();
    setPlaying(null);
    onListen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of focus stops it
  }, [active]);
  // Unmounting stops the music too: useAudioPlayer releases the player on unmount, which stops it. Its cleanup
  // runs before any declared here, so a pause() here would call into a released native object and throw.

  const onPlay = useCallback((trackId: string, url: string | null) => {
    if (!url || !active) return;
    if (playing === trackId) {
      player.pause();
      setPlaying(null);
      onListen(false);
      return;
    }
    haptics.select();
    player.pause();
    player.replace({ uri: url });
    player.play();
    setPlaying(trackId);
    onListen(true);
  }, [playing, player, onListen, active]);

  const selected = music.choices.find((c) => c.selected) ?? null;
  return (
    <Card bold style={styles.card} testID="post-kit-music">
      <Eyebrow>{POST_KIT_COPY.music}</Eyebrow>
      {editable ? <Text style={styles.hint}>{POST_KIT_COPY.musicHint}</Text> : null}
      {music.choices.map((c, i) => {
        const on = playing === c.trackId;
        return (
          <View key={c.trackId} style={[styles.row, i > 0 && styles.rowLine]} testID={`post-kit-music-${c.trackId}`}>
            <Pressable
              onPress={() => onPlay(c.trackId, c.listenUrl)}
              disabled={!c.listenUrl}
              style={({ pressed }) => [styles.play, on && styles.playOn, !c.listenUrl && styles.disabled, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={on ? POST_KIT_COPY.musicStop(c.title) : c.listenUrl ? POST_KIT_COPY.musicPlay(c.title) : POST_KIT_COPY.musicUnavailable}
              accessibilityState={{ disabled: !c.listenUrl }}
              hitSlop={6}
              testID={`post-kit-music-play-${c.trackId}`}
            >
              <Feather name={on ? "pause" : "play"} size={16} color={on ? Bold.onDark : Bold.ink} />
            </Pressable>
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={1}>{c.title}</Text>
              <Text style={styles.meta} numberOfLines={1}>{c.artist}</Text>
              <Text style={styles.reason} numberOfLines={2}>{c.reason}</Text>
            </View>
            {c.selected ? (
              <View style={styles.inUse} testID={`post-kit-music-in-use-${c.trackId}`}>
                <Feather name="check" size={14} color={Bold.ink} />
                <Text style={styles.inUseText}>{POST_KIT_COPY.musicInUse}</Text>
              </View>
            ) : !c.allowed ? (
              <Text style={styles.notAllowed} testID={`post-kit-music-not-allowed-${c.trackId}`}>{POST_KIT_COPY.musicNotForBrand}</Text>
            ) : editable ? (
              <Button bold="small" onPress={() => onUse(c.trackId)} disabled={busy} accessibilityLabel={POST_KIT_COPY.musicUseLabel(c.title)} testID={`post-kit-music-use-${c.trackId}`}>{POST_KIT_COPY.musicUse}</Button>
            ) : null}
          </View>
        );
      })}
      {selected?.credit ? (
        <View style={styles.credit} testID="post-kit-music-credit">
          <Feather name="info" size={13} color={Bold.mute} />
          <Text style={styles.creditText}>{POST_KIT_COPY.musicCredit}</Text>
        </View>
      ) : null}
      {selected?.contentIdRegistered ? (
        <View style={styles.credit} testID="post-kit-music-content-id">
          <Feather name="youtube" size={13} color={Bold.mute} />
          <Text style={styles.creditText}>{POST_KIT_COPY.musicContentId}</Text>
        </View>
      ) : null}
      {editable ? <Text style={styles.hint} testID="post-kit-music-in-app">{POST_KIT_COPY.musicInApp}</Text> : null}
      {editable && selected ? (
        <Button bold="small" onPress={() => onUse(null)} disabled={busy} style={styles.none} testID="post-kit-music-none">{POST_KIT_COPY.musicNone}</Button>
      ) : null}
      {busy ? <ActivityIndicator color={Bold.ink} testID="post-kit-music-busy" /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: Bold.gutter, marginTop: 16, padding: 14, gap: 8 },
  hint: { ...BoldType.caption, color: Bold.mute },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  rowLine: { borderTopWidth: 1, borderTopColor: Bold.line },
  play: {
    width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: Bold.line, backgroundColor: Bold.paper,
    alignItems: "center", justifyContent: "center",
  },
  playOn: { backgroundColor: Bold.ink, borderColor: Bold.ink },
  disabled: { opacity: 0.4 },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  text: { flex: 1, gap: 2 },
  title: { ...BoldType.rowTitle, color: Bold.ink },
  meta: { ...BoldType.rowMeta, color: Bold.ink2 },
  reason: { ...BoldType.caption, color: Bold.mute },
  inUse: { flexDirection: "row", alignItems: "center", gap: 4 },
  inUseText: { ...BoldType.caption, color: Bold.ink },
  credit: { flexDirection: "row", alignItems: "center", gap: 6 },
  creditText: { ...BoldType.caption, color: Bold.mute, flex: 1 },
  none: { alignSelf: "flex-start" },
  notAllowed: { ...BoldType.caption, color: Bold.mute, maxWidth: 96, textAlign: "right" },
});
