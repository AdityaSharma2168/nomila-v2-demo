// Studio's default view (design "Studio and Home, designed", 20 Oct 2026): her content full-screen, one at a time,
// swipe up for the next — Ready for you → Ideas from moments → Posted (lib/studioV3Logic feedEntries). A post plays
// muted when in view (tap for sound); only the card in view plays, and only while Studio is focused and the app is in
// the foreground. Over each card ONE minimal dark-glass panel: a status chip, the title, one line, one action and
// "Not now" (the next card). Nothing here acts on an item: the action opens the kit (Review & post / See it) or, for a
// moment idea, the moment's own target (its kit, or Mila asked to make it).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ListRenderItemInfo, type ViewToken } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { Photo } from "../ui/Photo";
import { mediaFor, PostKitAssetView, usePlaybackAllowed } from "../postKit/PostKitAssetView";
import { renderedReel, renderedSlide } from "../postKit/preview";
import { usePostKit } from "../../lib/agent/hooks";
import { DarkGlass } from "./DarkGlass";
import { MomentArt } from "./MomentArt";
import { STUDIO_V3_COPY, feedAction, feedChip, feedLine, type FeedEntry, type StudioDot } from "../../lib/studioV3Logic";

const DOT: Record<StudioDot, string> = { ready: Accent.pink, posted: Accent.green, working: Bold.quiet };

export function StudioFeed({ entries, startId, momentImages, topInset, onAction, header }: {
  entries: FeedEntry[];
  /** Open on this entry (a tap in Browse); else the top. */
  startId: string | null;
  momentImages: Record<string, string>;
  topInset: number;
  onAction: (e: FeedEntry) => void;
  /** The Feed · Browse switch and Create, laid over the top of the feed. */
  header: React.ReactNode;
}) {
  const playable = usePlaybackAllowed();
  const listRef = useRef<FlatList<FeedEntry>>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0 && h !== height) setHeight(h);
  };
  // Jump to the entry tapped in Browse once the list has its height.
  useEffect(() => {
    if (!height || !startId) return;
    const i = entries.findIndex((e) => e.id === startId);
    if (i > 0) { listRef.current?.scrollToOffset({ offset: height * i, animated: false }); setActive(i); }
  }, [startId, height]); // eslint-disable-line react-hooks/exhaustive-deps

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const top = viewableItems.find((v) => v.isViewable);
    if (top && typeof top.index === "number") setActive(top.index);
  }).current;
  const viewability = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const next = (i: number) => {
    haptics.tap();
    if (height && i + 1 < entries.length) listRef.current?.scrollToOffset({ offset: height * (i + 1), animated: true });
  };

  const renderItem = useCallback(({ item, index }: ListRenderItemInfo<FeedEntry>) => (
    <FeedCard
      entry={item}
      height={height ?? 0}
      topInset={topInset}
      active={index === active && playable}
      muted={muted}
      imageUrl={item.kind === "idea" ? momentImages[item.id] ?? null : null}
      onToggleSound={() => setMuted((m) => !m)}
      onAction={() => { haptics.press(); onAction(item); }}
      onNotNow={() => next(index)}
    />
  ), [height, topInset, active, playable, muted, momentImages, onAction]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.root} onLayout={onLayout} testID="studio3-feed">
      {height ? (
        <FlatList
          ref={listRef}
          data={entries}
          keyExtractor={(e) => e.id}
          renderItem={renderItem}
          extraData={[active, muted, height, momentImages]}
          pagingEnabled
          snapToInterval={height}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={viewability}
          testID="studio3-feed-list"
        />
      ) : null}
      <View style={[styles.header, { paddingTop: topInset + 8 }]} pointerEvents="box-none">{header}</View>
    </View>
  );
}

function FeedCard({ entry, height, topInset, active, muted, imageUrl, onToggleSound, onAction, onNotNow }: {
  entry: FeedEntry; height: number; topInset: number; active: boolean; muted: boolean; imageUrl: string | null;
  onToggleSound: () => void; onAction: () => void; onNotNow: () => void;
}) {
  const chip = feedChip(entry);
  const line = feedLine(entry);
  return (
    <View style={[styles.card, { height }]} testID={`studio3-feed-card-${entry.id}`}>
      <Pressable onPress={entry.kind === "kit" ? onToggleSound : undefined} style={StyleSheet.absoluteFill} accessibilityLabel={entry.kind === "kit" ? (muted ? STUDIO_V3_COPY.action.sound : STUDIO_V3_COPY.action.mute) : undefined}>
        {entry.kind === "kit" ? <KitMedia entry={entry} active={active} muted={muted} /> : (
          <MomentArt story={entry.story} imageUrl={imageUrl} size="full" style={StyleSheet.absoluteFill} />
        )}
      </Pressable>
      <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear]} style={[styles.scrimTop, { height: topInset + 110 }]} pointerEvents="none" />
      <LinearGradient colors={[Bold.scrimClear, Bold.scrimFoot]} locations={[0, 0.7]} style={styles.scrimFoot} pointerEvents="none" />
      {entry.kind === "kit" && active && entry.item.format === "reel" ? (
        <View style={[styles.sound, { top: topInset + 64 }]} pointerEvents="none">
          <Feather name={muted ? "volume-x" : "volume-2"} size={14} color={Bold.onDark} />
        </View>
      ) : null}
      <DarkGlass radius={22} style={styles.panel} testID={`studio3-feed-panel-${entry.id}`}>
        <View style={styles.chip}>
          <View style={[styles.dot, { backgroundColor: DOT[chip.dot] }]} />
          <Text style={styles.chipText} numberOfLines={1}>{chip.text}</Text>
        </View>
        <Text style={styles.title} numberOfLines={3}>{entry.kind === "idea" ? (entry.story.moment?.hook ? `“${entry.story.moment.hook}”` : entry.story.title) : entry.tile.title}</Text>
        {line ? <Text style={styles.line} numberOfLines={2}>{line}</Text> : null}
        <View style={styles.actions}>
          <Pressable onPress={onAction} style={({ pressed }) => [styles.primary, pressed && styles.pressed]} accessibilityRole="button" testID={`studio3-feed-action-${entry.id}`}>
            <Text style={styles.primaryText}>{feedAction(entry)}</Text>
          </Pressable>
          <Pressable onPress={onNotNow} hitSlop={8} style={styles.quiet} accessibilityRole="button" testID={`studio3-feed-notnow-${entry.id}`}>
            <Text style={styles.quietText}>{STUDIO_V3_COPY.action.notNow}</Text>
          </Pressable>
        </View>
      </DarkGlass>
    </View>
  );
}

/** A kit's picture in the feed: the rendered preview or its first asset (playing when in view); else the thumbnail. */
function KitMedia({ entry, active, muted }: { entry: Extract<FeedEntry, { kind: "kit" }>; active: boolean; muted: boolean }) {
  const q = usePostKit(entry.item.id, { enabled: active, poll: active });
  const kit = q.data ?? null;
  const asset = kit?.kit?.assets[0] ?? null;
  if (asset) {
    const rendered = renderedReel(kit) ?? renderedSlide(kit, asset.assetId);
    return <PostKitAssetView asset={asset} media={mediaFor(kit, asset.assetId)} rendered={rendered} ratio={9 / 16} playing={active} muted={muted} token={0} fill />;
  }
  if (entry.item.thumbUrl) return <Photo uri={entry.item.thumbUrl} style={StyleSheet.absoluteFill} />;
  return <View style={[StyleSheet.absoluteFill, styles.blank]}><Feather name="film" size={22} color={Bold.onDarkMute} /></View>;
}

const styles = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Accent.hero },
  header:    { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: Bold.gutter },
  card:      { width: "100%", backgroundColor: Accent.hero, justifyContent: "flex-end" },
  blank:     { backgroundColor: Bold.heroBlank, alignItems: "center", justifyContent: "center" },
  scrimTop:  { position: "absolute", top: 0, left: 0, right: 0 },
  scrimFoot: { position: "absolute", left: 0, right: 0, bottom: 0, height: "45%" },
  sound:     { position: "absolute", right: Bold.gutter, width: 28, height: 28, borderRadius: 14, backgroundColor: Accent.closeDisc, alignItems: "center", justifyContent: "center" },
  panel:     { marginHorizontal: 12, marginBottom: 14, padding: 14, gap: 6 },
  chip:      { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: Accent.glassLight, borderRadius: 11, paddingHorizontal: 9, height: 22 },
  dot:       { width: 7, height: 7, borderRadius: 4 },
  chipText:  { ...BoldType.chip, color: Bold.onDark },
  title:     { ...BoldType.goalSm, color: Bold.onDark },
  line:      { ...BoldType.caption, color: Bold.onDarkSoft },
  actions:   { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 6 },
  primary:   { backgroundColor: Accent.pink, borderRadius: 20, height: 40, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  primaryText: { ...BoldType.label, color: Bold.onDark },
  quiet:     { height: 40, justifyContent: "center" },
  quietText: { ...BoldType.label, color: Bold.onDark },
  pressed:   { transform: [{ scale: Bold.pressScale }] },
});
