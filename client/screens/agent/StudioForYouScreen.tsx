/**
 * StudioForYouScreen (AGENT_V3 + AGENT_POST_KITS; design "Moments → post kits" §12, v2, build step 10) — a vertical,
 * one-card-at-a-time scroll of the post kits still to post, over the SAME data the Studio library's "Posts" filter
 * shows (client/lib/agent/hooks.tsx useStudioItems, kind "post_kit"), reached from that filter's "View as feed"
 * toggle (StudioLibraryScreen.tsx). Newest first. A kit she already marked posted is not in the feed (it stays in the
 * library, as published).
 *
 * Each card fills the screen: the rendered preview when it is ready (the reel itself, or a carousel's first slide), else
 * the chosen media — full-bleed and cover-cropped with no native controls (PostKitAssetView `fill`) — the top and foot
 * scrims (DESIGN.md §2c), a quiet "Preparing your preview" line while the render runs (or "Try again" when it failed),
 * the caption, and three actions:
 *   Post       the ONE Share / Save flow (components/postKit/sharePostKit.ts): copies the caption and saves the media —
 *              she posts it herself; nothing is ever posted for her
 *   Edit       opens the kit screen (swap, caption, "I posted it")
 *   More info  the goal and, when there is one, the moment and its why_now (a ui/Sheet)
 *
 * Only the card in view plays, and only while this screen is focused and the app is in the foreground.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type ListRenderItemInfo, type ViewToken } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Sheet, StackHeader } from "../../components/ui";
import { Photo } from "../../components/ui/Photo";
import { mediaFor, PostKitAssetView, usePlaybackAllowed } from "../../components/postKit/PostKitAssetView";
import { POST_KIT_COPY, writeFailLine } from "../../components/postKit/copy";
import { renderedReel, renderedSlide, retryChangedNothing, usePreviewState } from "../../components/postKit/preview";
import { SHARE_COPY, sharePostKit } from "../../components/postKit/sharePostKit";
import { Bold, BoldType } from "../../constants/theme";
import { useAuth } from "../../lib/auth-context";
import { useFreshPostKit, usePostKit, usePostKitWrite, useStudioItems } from "../../lib/agent/hooks";
import type { StudioItem } from "../../lib/agent/types";
import type { PostKitResponse } from "../../../shared/postKit";
import { feedStartIndex } from "../../lib/studioV3Logic";

export const FOR_YOU_COPY = {
  back: "Studio",
  empty: "No post kits yet",
  emptyLine: "Post kits come from your plan. When one of your goals has a post on it, its kit lands here.",
  error: "Couldn't load your post kits.",
  retry: "Retry",
  post: "Post",
  postLabel: (title: string) => `Save ${title} to post it yourself, and copy its caption`,
  noCaption: "No caption yet — ask Mila",
  edit: "Edit",
  editLabel: (title: string) => `Edit ${title}`,
  moreInfo: "More info",
  moreInfoLabel: (title: string) => `More info about ${title}`,
  why: "Why this",
  forGoal: "For",
  timedFor: "Timed for",
  infoError: "Couldn't load the details for this one.",
} as const;

/** The post kits still to post, newest first — the library's own sort (StudioLibraryScreen.tsx filterItems). */
export function forYouItems(items: StudioItem[]): StudioItem[] {
  return items
    .filter((i) => i.kind === "post_kit" && i.status !== "published")
    .slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function MoreInfoSheet({ item, onClose }: { item: StudioItem; onClose: () => void }) {
  const q = usePostKit(item.id);
  const kit = q.data;
  const nothing = !kit?.goal && !kit?.moment && !kit?.why;
  return (
    <Sheet onClose={onClose} title={item.title}>
      <View style={styles.infoBody} testID="for-you-info-sheet">
        {q.isLoading ? <ActivityIndicator color={Bold.ink} /> : q.isError ? (
          <Text style={styles.infoText}>{FOR_YOU_COPY.infoError}</Text>
        ) : (
          <>
            {kit?.goal ? (
              <View style={styles.infoBlock}>
                <Text style={styles.infoLabel}>{FOR_YOU_COPY.forGoal}</Text>
                <Text style={styles.infoText}>{kit.goal.text}</Text>
              </View>
            ) : null}
            {kit?.moment ? (
              <View style={styles.infoBlock}>
                <Text style={styles.infoLabel}>{FOR_YOU_COPY.timedFor}</Text>
                <Text style={styles.infoText}>{kit.moment.name}{kit.moment.whyNow ? ` — ${kit.moment.whyNow}` : ""}</Text>
              </View>
            ) : null}
            {kit?.why ? (
              <View style={styles.infoBlock}>
                <Text style={styles.infoLabel}>{FOR_YOU_COPY.why}</Text>
                <Text style={styles.infoText}>{kit.why}</Text>
              </View>
            ) : null}
            {nothing ? <Text style={styles.infoText}>{item.title}</Text> : null}
          </>
        )}
      </View>
    </Sheet>
  );
}

function ForYouCard({ item, active, height, topInset, onEdit, onInfo }: {
  item: StudioItem; active: boolean; height: number; topInset: number; onEdit: () => void; onInfo: () => void;
}) {
  // Read the kit for the card in view (and keep what was read): the others show the library's thumbnail. `active` is
  // already "in view, screen focused, app in the foreground", so only this card polls while its preview is made.
  const q = usePostKit(item.id, { enabled: active, poll: active });
  const write = usePostKitWrite();
  const freshKit = useFreshPostKit();
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const kit = q.data ?? null;
  const asset = kit?.kit?.assets[0] ?? null;
  const media = asset ? mediaFor(kit, asset.assetId) : undefined;
  // The rendered preview when ready: the reel itself, or the first slide; else the chosen asset as it is.
  const rendered = asset ? renderedReel(kit) ?? renderedSlide(kit, asset.assetId) : null;
  const state = usePreviewState(kit);
  const previewState = asset ? state : "none";
  // An empty caption (plan 1.7.0 never fills one with the brief) says so plainly rather than showing nothing.
  const caption = kit?.kit ? kit.kit.caption.text.trim() || FOR_YOU_COPY.noCaption : item.title;

  // Shares a fresh read: the signed URLs on screen may have expired.
  const onPost = async () => {
    if (!kit) return;
    setSaving(true); setLine(null);
    try {
      let current: PostKitResponse | null;
      try { current = await freshKit(item.id); } catch { current = null; }
      if (!current?.kit) { setLine(SHARE_COPY.failed); return; }
      const r = await sharePostKit(current);
      setLine("note" in r ? r.note : r.fail);
    } finally {
      setSaving(false);
    }
  };
  // A stalled preview's "Try again" re-queues it (polling restarts); the same stalled ask back says so in the notice.
  const onRetryPreview = () => {
    setLine(null);
    const before = kit;
    write.mutate({ op: "preview", id: item.id }, {
      onSuccess: (r) => { if (retryChangedNothing(before, r.read)) setLine(POST_KIT_COPY.previewStillMaking); },
      onError: (err) => setLine(writeFailLine("preview", err)),
    });
  };

  return (
    <View style={[styles.card, { height }]} testID={`for-you-card-${item.id}`}>
      {asset ? (
        <PostKitAssetView asset={asset} media={media} rendered={rendered} ratio={9 / 16} playing={active} muted token={0} fill />
      ) : item.thumbUrl ? (
        <Photo uri={item.thumbUrl} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.mediaEmpty]}><Feather name="film" size={22} color={Bold.onDarkMute} /></View>
      )}
      <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear]} style={[styles.scrimTop, { height: topInset + 96 }]} pointerEvents="none" />
      <LinearGradient colors={[Bold.scrimClear, Bold.scrimFoot]} locations={[0, 0.55]} style={styles.scrimFoot} pointerEvents="none" />

      <View style={styles.foot}>
        {line ? <View style={styles.notice} accessibilityLiveRegion="polite" testID={`for-you-notice-${item.id}`}><Text style={styles.noticeText}>{line}</Text></View> : null}
        {previewState === "preparing" ? (
          <View style={styles.previewLine} accessibilityLiveRegion="polite" testID={`for-you-preview-preparing-${item.id}`}>
            <ActivityIndicator size="small" color={Bold.onDarkSoft} />
            <Text style={styles.previewText}>{POST_KIT_COPY.previewPreparing}</Text>
          </View>
        ) : previewState === "failed" ? (
          <View style={styles.previewLine} accessibilityLiveRegion="polite" testID={`for-you-preview-failed-${item.id}`}>
            <Feather name="alert-circle" size={15} color={Bold.onDark} />
            <Text style={styles.previewText}>{POST_KIT_COPY.previewFailed}</Text>
            <Button bold="small" onPress={onRetryPreview} disabled={write.isPending} loading={write.isPending} testID={`for-you-preview-retry-${item.id}`}>{POST_KIT_COPY.previewRetry}</Button>
          </View>
        ) : null}
        <Text style={styles.captionText} numberOfLines={3} testID={`for-you-caption-${item.id}`}>{caption}</Text>
        <View style={styles.actionsRow}>
          <Button bold="onHero" onPress={() => { void onPost(); }} loading={saving} disabled={!kit} accessibilityLabel={FOR_YOU_COPY.postLabel(item.title)} style={styles.postBtn} testID={`for-you-post-${item.id}`}>{FOR_YOU_COPY.post}</Button>
          <Button bold="small" onPress={onEdit} accessibilityLabel={FOR_YOU_COPY.editLabel(item.title)} testID={`for-you-edit-${item.id}`}>{FOR_YOU_COPY.edit}</Button>
          <Button bold="small" onPress={onInfo} accessibilityLabel={FOR_YOU_COPY.moreInfoLabel(item.title)} testID={`for-you-more-info-${item.id}`}>{FOR_YOU_COPY.moreInfo}</Button>
        </View>
      </View>
    </View>
  );
}

export function StudioForYouScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { athlete } = useAuth();
  const q = useStudioItems(athlete?.id ? String(athlete.id) : undefined);
  const items = forYouItems(q.data ?? []);
  const playable = usePlaybackAllowed();
  // Studio v3's tap on a post opens the feed ON that post (route param startId); the library's toggle opens it at the top.
  const route = useRoute<any>();
  const startId: string | undefined = route.params?.startId;
  const listRef = useRef<FlatList<StudioItem>>(null);
  const startedAt = useRef<string | null>(null);

  // The list's real height (the screen above the tab bar), measured — the window height until the first layout.
  const [measured, setMeasured] = useState<number | null>(null);
  const height = measured ?? window.height;
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0 && h !== measured) setMeasured(h);
  };
  // Once the list has its real height and its items, jump to the tapped post (once per startId).
  useEffect(() => {
    if (!startId || !measured || !items.length || startedAt.current === startId) return;
    startedAt.current = startId;
    const index = feedStartIndex(items.map((i) => i.id), startId);
    if (index > 0) listRef.current?.scrollToOffset({ offset: measured * index, animated: false });
  }, [startId, measured, items]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [infoFor, setInfoFor] = useState<StudioItem | null>(null);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const top = viewableItems.find((v) => v.isViewable);
    if (top && typeof top.index === "number") setActiveIndex(top.index);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const renderItem = useCallback(({ item, index }: ListRenderItemInfo<StudioItem>) => (
    <ForYouCard
      item={item}
      active={index === activeIndex && playable}
      height={height}
      topInset={insets.top}
      onEdit={() => navigation.navigate("PostKit", { id: item.id })}
      onInfo={() => setInfoFor(item)}
    />
  ), [activeIndex, playable, height, insets.top, navigation]);

  return (
    <View style={styles.root} onLayout={onLayout} testID="studio-for-you">
      {q.isLoading ? (
        <View style={styles.center} testID="for-you-loading"><ActivityIndicator color={Bold.onDark} /></View>
      ) : q.isError ? (
        <View style={styles.center} testID="for-you-error">
          <Text style={styles.muted}>{FOR_YOU_COPY.error}</Text>
          <Button bold="small" onPress={() => { void q.refetch(); }} testID="for-you-retry">{FOR_YOU_COPY.retry}</Button>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center} testID="for-you-empty">
          <Feather name="film" size={22} color={Bold.onDarkMute} />
          <Text style={styles.emptyTitle}>{FOR_YOU_COPY.empty}</Text>
          <Text style={styles.muted}>{FOR_YOU_COPY.emptyLine}</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          extraData={height}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={height}
          decelerationRate="fast"
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          testID="for-you-list"
        />
      )}

      {/* The pushed-screen bar, white over the media, inside the safe area (DESIGN.md §11 Shell). */}
      <View style={[styles.bar, { paddingTop: insets.top }]} pointerEvents="box-none">
        <StackHeader title={FOR_YOU_COPY.back} bold dark />
      </View>

      {infoFor ? <MoreInfoSheet item={infoFor} onClose={() => setInfoFor(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Bold.ink },
  bar: { position: "absolute", top: 0, left: 0, right: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  emptyTitle: { ...BoldType.h4, color: Bold.onDark, textAlign: "center" },
  muted: { ...BoldType.lede, color: Bold.onDarkSoft, textAlign: "center" },
  card: { width: "100%", justifyContent: "flex-end", backgroundColor: Bold.ink },
  mediaEmpty: { backgroundColor: Bold.heroBlank, alignItems: "center", justifyContent: "center" },
  scrimTop: { position: "absolute", top: 0, left: 0, right: 0 },
  scrimFoot: { position: "absolute", left: 0, right: 0, bottom: 0, height: "45%" },
  foot: { paddingHorizontal: Bold.gutter, paddingBottom: 16, gap: 12 },
  captionText: { ...BoldType.goalSm, color: Bold.onDark },
  previewLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  previewText: { ...BoldType.caption, color: Bold.onDarkSoft, flex: 1 },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  postBtn: { flex: 1 },
  notice: { alignSelf: "stretch", backgroundColor: Bold.paper, borderRadius: Bold.radius.control, paddingVertical: 8, paddingHorizontal: 12 },
  noticeText: { ...BoldType.caption, color: Bold.ink, textAlign: "center" },
  infoBody: { gap: 14, paddingTop: 8 },
  infoBlock: { gap: 4 },
  infoLabel: { ...BoldType.label, color: Bold.mute },
  infoText: { ...BoldType.body, color: Bold.ink },
});
