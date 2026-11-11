/**
 * Studio v3 (EXPO_PUBLIC_HOME_V3 with AGENT_V3; the Studio tab's root; design "Studio and Home, designed",
 * https://claude.ai/artifact/CPRh4oiAaEMdNEJTNKNrsg, 20 Oct 2026). Opening Studio feels like opening Instagram:
 *
 *   Feed (default)  her posts full-screen, one at a time, swipe up (components/studioV3/StudioFeed): Ready for you →
 *                   Ideas from moments → Posted; a post plays muted in view (tap for sound); one glass panel per card
 *   Browse          the shelves: Ready for you (tall) · Ideas from moments (each with a picture: her post's photo, an
 *                   atmosphere image, else its kind's card; the date a chip) · Decks & pages (her brand book first, then
 *                   3:4 pitch covers in the deck's own cover look) · Posted (a grid, with its one extra line)
 *
 * "Feed · Browse" is a switch in words. Create is always in reach: a pink plus over the feed, a "+ Create" pill in
 * Browse (Post · Ad · Deck · Page, each with its small illustration). Status is a dot (pink ready for you, green posted,
 * grey Mila's working), never "Draft" or "v1". Data: the library's (useStudioItems), Home's moments (momentStories)
 * and the brand book (BRAND_BOOK_V1). Every tap opens an existing screen; nothing here acts on an item.
 */
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Accent, Bold, BoldType, Shadows } from "../../constants/theme";
import { Button, Sheet } from "../../components/ui";
import { Photo } from "../../components/ui/Photo";
import { LogoMark } from "../../components/ui/LogoMark";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { useAuth } from "../../lib/auth-context";
import { useAgentGoalsPlan, useStudioItems } from "../../lib/agent/hooks";
import { openAgentTarget } from "../../lib/agent/navigate";
import { openMila } from "../../lib/milaLaunch";
import { STUDIO_ENABLED } from "../../lib/flags";
import { haptics } from "../../lib/haptics";
import { momentStories } from "../../lib/homeV3Logic";
import { openPublicPage } from "../../navigation/meNav";
import { useBrandBook } from "../../hooks/use-brand-book";
import { useMomentImages } from "../../hooks/use-moment-images";
import { useMeOverview, useMePhotos } from "../../hooks/use-me-knowledge";
import { avatarPhotoUrl } from "../../lib/myStoryLogic";
import { bookStudioItems, isBookItem } from "../../lib/brandBookLogic";
import { StudioFeed } from "../../components/studioV3/StudioFeed";
import { MomentArt } from "../../components/studioV3/MomentArt";
import { DarkGlass } from "../../components/studioV3/DarkGlass";
import { TopBar } from "../../components/shell/TopBar";
import {
  CREATE_ASK, CREATE_KINDS, STUDIO_V3_COPY, coverCaption, coverName, feedEntries, studioEmpty, studioShelves,
  type CreateKind, type FeedEntry, type StudioDot, type StudioShelf, type StudioTile,
} from "../../lib/studioV3Logic";

const ART = {
  post: require("../../assets/illustrations/create-post.jpg"),
  ad: require("../../assets/illustrations/create-ad.jpg"),
  deck: require("../../assets/illustrations/create-deck.jpg"),
  page: require("../../assets/illustrations/create-page.jpg"),
  empty: require("../../assets/illustrations/empty-studio.jpg"),
} as const;

const DOT_COLOR: Record<StudioDot, string> = { ready: Accent.pink, posted: Accent.green, working: Bold.quiet };

type Mode = "feed" | "browse";

export function StudioV3Screen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { athlete } = useAuth();
  const q = useStudioItems(athlete?.id ? String(athlete.id) : undefined);
  // The brand book and its reel (BRAND_BOOK_V1) join Decks & pages; null while the server flag is off.
  const book = useBrandBook(true);
  const items = useMemo(() => [...bookStudioItems(book.data), ...(q.data ?? [])], [book.data, q.data]);
  const goals = useAgentGoalsPlan();
  const overview = useMeOverview();
  const photos = useMePhotos(1);
  const herPhoto = avatarPhotoUrl(overview.data?.identity.photoUrl, photos) ?? null;
  const herName = overview.data?.identity.displayName ?? athlete?.firstName ?? "";
  // Opens on the feed; a link can ask for Browse (route param mode: "browse").
  const route = useRoute<any>();
  const [mode, setMode] = useState<Mode>(route.params?.mode === "browse" ? "browse" : "feed");
  const [startId, setStartId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pull = usePullRefresh(() => Promise.all([q.refetch(), goals.refetch()]));
  const now = useMemo(() => new Date(), [q.data, goals.data]);
  const moments = useMemo(() => momentStories(goals.data, now), [goals.data, now]);
  const momentImages = useMomentImages(moments);
  const shelves = useMemo(() => studioShelves(items, moments, now), [items, moments, now]);
  const feed = useMemo(() => feedEntries(items, moments, now), [items, moments, now]);

  const openTile = (t: StudioTile) => {
    haptics.tap();
    switch (t.open.to) {
      case "feed": setStartId(t.open.id); setMode("feed"); return;
      case "kit": navigation.navigate("PostKit", { id: t.open.id }); return;
      case "item":
        if (isBookItem(t.open.item.id)) { navigation.navigate("BrandBook"); return; }
        if (t.open.item.open) openAgentTarget(navigation, t.open.item.open);
        return;
      case "moment": {
        const target = t.open.story.action.target;
        if (target.screen === "post_kit") navigation.navigate("PostKit", { id: target.id });
        else if (target.screen === "mila") openMila({ draft: target.draft });
        return;
      }
    }
  };
  const onFeedAction = (e: FeedEntry) => {
    if (e.kind === "kit") { navigation.navigate("PostKit", { id: e.item.id }); return; }
    openTile(e.tile);
  };

  const create = (k: CreateKind) => {
    setCreating(false);
    haptics.tap();
    if (k === "deck") { navigation.navigate("PitchesList"); return; }
    if (k === "page") { openPublicPage(navigation); return; }
    if (STUDIO_ENABLED) { navigation.navigate(k === "ad" ? "StudioBrandPost" : "StudioCreateAnything"); return; }
    openMila({ draft: CREATE_ASK[k] });
  };

  const switcher = (dark: boolean) => (
    <ModeSwitch mode={mode} dark={dark} onChange={(m) => { haptics.select(); setStartId(null); setMode(m); }} />
  );

  const createSheet = creating ? (
    <Sheet onClose={() => setCreating(false)} title={STUDIO_V3_COPY.createTitle}>
      <View style={styles.createGrid} testID="studio3-create-sheet">
        {CREATE_KINDS.map((k) => (
          <Pressable key={k} onPress={() => create(k)} accessibilityRole="button" accessibilityLabel={STUDIO_V3_COPY.createOptions[k].label}
            style={({ pressed }) => [styles.createTile, pressed && styles.pressed]} testID={`studio3-create-${k}`}>
            <Image source={ART[k]} style={styles.createArt} accessibilityIgnoresInvertColors />
            <Text style={styles.createLabel}>{STUDIO_V3_COPY.createOptions[k].label}</Text>
            <Text style={styles.createLine} numberOfLines={2}>{STUDIO_V3_COPY.createOptions[k].line}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  ) : null;

  if (q.isLoading) return <View style={[styles.screen, styles.center]} testID="studio3-loading"><ActivityIndicator color={Bold.ink} /></View>;
  if (q.isError) {
    return (
      <View style={[styles.screen, styles.center]} testID="studio3-error">
        <Text style={styles.muted}>{STUDIO_V3_COPY.error}</Text>
        <Button bold="small" onPress={() => { void q.refetch(); }}>{STUDIO_V3_COPY.retry}</Button>
      </View>
    );
  }

  // The feed is the default whenever there is something in it; with nothing to watch, Browse (and its empty state).
  if (mode === "feed" && feed.length) {
    return (
      <View style={styles.feedScreen} testID="studio3">
        <StudioFeed
          entries={feed}
          startId={startId}
          momentImages={momentImages}
          topInset={insets.top}
          onAction={onFeedAction}
          header={(
            <View style={styles.feedHead}>
              {switcher(true)}
              <Pressable onPress={() => { haptics.press(); setCreating(true); }} accessibilityRole="button" accessibilityLabel={STUDIO_V3_COPY.create}
                style={({ pressed }) => [styles.plus, pressed && styles.pressed]} testID="studio3-create">
                <Feather name="plus" size={22} color={Bold.onDark} />
              </Pressable>
            </View>
          )}
        />
        {createSheet}
      </View>
    );
  }

  return (
    <View style={styles.screen} testID="studio3">
      <View style={{ height: insets.top, backgroundColor: Bold.paper }} />
      <TopBar />
      <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }} refreshControl={pullRefresh(pull)} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <Text style={styles.title}>{STUDIO_V3_COPY.title}</Text>
          <Pressable onPress={() => { haptics.press(); setCreating(true); }} accessibilityRole="button" accessibilityLabel={STUDIO_V3_COPY.create}
            style={({ pressed }) => [styles.createPill, pressed && styles.pressed]} testID="studio3-create">
            <Feather name="plus" size={16} color={Bold.onDark} />
            <Text style={styles.createPillText}>{STUDIO_V3_COPY.create}</Text>
          </Pressable>
        </View>
        <View style={styles.switchRow}>{switcher(false)}</View>
        {studioEmpty(shelves) ? (
          <View style={styles.center} testID="studio3-empty">
            <Image source={ART.empty} style={styles.emptyArt} accessibilityIgnoresInvertColors accessibilityLabel="" />
            <Text style={styles.emptyTitle}>{STUDIO_V3_COPY.empty.title}</Text>
            <Text style={styles.muted}>{STUDIO_V3_COPY.empty.line}</Text>
          </View>
        ) : (
          <View style={styles.shelves}>
            {shelves.map((s) => (
              <Shelf key={s.key} shelf={s} onOpen={openTile} momentImages={momentImages} herPhoto={herPhoto} herName={herName} />
            ))}
          </View>
        )}
      </ScrollView>
      {createSheet}
    </View>
  );
}

/** "Feed · Browse", in words: glass over the feed, a soft pill on paper. */
function ModeSwitch({ mode, dark, onChange }: { mode: Mode; dark: boolean; onChange: (m: Mode) => void }) {
  const inner = (
    <View style={styles.switchInner} accessibilityRole="tablist">
      {(["feed", "browse"] as const).map((m) => {
        const on = mode === m;
        return (
          <Pressable key={m} onPress={() => onChange(m)} accessibilityRole="tab" accessibilityState={{ selected: on }} hitSlop={4}
            style={[styles.switchBtn, on && (dark ? styles.switchOnDark : styles.switchOn)]} testID={`studio3-mode-${m}`}>
            <Text style={[styles.switchText, dark && styles.switchTextDark, on && (dark ? styles.switchTextOnDark : styles.switchTextOn)]}>{STUDIO_V3_COPY.views[m]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
  return dark ? <DarkGlass radius={20} testID="studio3-switch">{inner}</DarkGlass> : <View style={styles.switchPaper} testID="studio3-switch">{inner}</View>;
}

function Shelf({ shelf, onOpen, momentImages, herPhoto, herName }: {
  shelf: StudioShelf; onOpen: (t: StudioTile) => void; momentImages: Record<string, string>; herPhoto: string | null; herName: string;
}) {
  const { width } = useWindowDimensions();
  const body = !shelf.tiles.length ? (
    <Text style={styles.shelfEmpty}>{STUDIO_V3_COPY.emptyShelf[shelf.key]}</Text>
  ) : shelf.key === "posted" ? (
    <PostedGrid tiles={shelf.tiles} onOpen={onOpen} width={width} />
  ) : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shelfRow}>
      {shelf.tiles.map((t) => (shelf.key === "decks"
        ? <Cover key={t.id} tile={t} onOpen={onOpen} herPhoto={herPhoto} herName={herName} />
        : <Tall key={t.id} tile={t} onOpen={onOpen} imageUrl={t.story ? momentImages[t.story.id] ?? null : null} />))}
    </ScrollView>
  );
  return (
    <View style={styles.shelf} testID={`studio3-shelf-${shelf.key}`}>
      <Text style={styles.shelfTitle}>{shelf.title}</Text>
      {body}
    </View>
  );
}

/** A post or a moment idea: tall creative, the status dot and its kicker, the title under it. */
function Tall({ tile, onOpen, imageUrl }: { tile: StudioTile; onOpen: (t: StudioTile) => void; imageUrl: string | null }) {
  return (
    <Pressable onPress={() => onOpen(tile)} accessibilityRole="button" accessibilityLabel={`${tile.title}, ${STUDIO_V3_COPY.dot[tile.dot]}`}
      style={({ pressed }) => [styles.tall, pressed && styles.pressed]} testID={`studio3-tile-${tile.id}`}>
      <View style={styles.tallArt}>
        {tile.story ? <MomentArt story={tile.story} imageUrl={imageUrl} style={StyleSheet.absoluteFill} />
          : tile.thumbUrl ? <Photo uri={tile.thumbUrl} style={StyleSheet.absoluteFill} accessibilityLabel={tile.title} />
          : <View style={[StyleSheet.absoluteFill, styles.blankArt]}><Feather name="image" size={20} color={Bold.quiet} /></View>}
      </View>
      <View style={styles.kickerRow}>
        <View style={[styles.dot, { backgroundColor: DOT_COLOR[tile.dot] }]} />
        <Text style={styles.kicker} numberOfLines={1}>{tile.kicker}</Text>
      </View>
      <Text style={styles.tileTitle} numberOfLines={2}>{tile.title}</Text>
    </Pressable>
  );
}

/**
 * A deck or page as the pitch cover sets it (server/services/kitRenderer.ts cover): her photo full-bleed under a scrim,
 * the brand's logo chip × NOMILA, her first name large and the rest quieter beneath; the brand book reads BRAND BOOK.
 * Brand · type · status under the cover.
 */
function Cover({ tile, onOpen, herPhoto, herName }: { tile: StudioTile; onOpen: (t: StudioTile) => void; herPhoto: string | null; herName: string }) {
  const book = tile.open.to === "item" && isBookItem(tile.open.item.id);
  const name = coverName(herName);
  const photo = tile.thumbUrl ?? herPhoto;
  return (
    <Pressable onPress={() => onOpen(tile)} accessibilityRole="button" accessibilityLabel={`${tile.title}. ${coverCaption(tile)}`}
      style={({ pressed }) => [styles.cover, pressed && styles.pressed]} testID={`studio3-tile-${tile.id}`}>
      <View style={styles.coverArt}>
        {photo ? <Photo uri={photo} style={StyleSheet.absoluteFill} /> : null}
        <LinearGradient colors={[Bold.scrimClear, Bold.scrimFoot]} locations={[0.3, 1]} style={StyleSheet.absoluteFill} />
        <View style={styles.lockup}>
          {book ? null : (
            <>
              <View style={styles.logoChip}><LogoMark bold logoUrl={tile.logoUrl ?? null} domain={null} name={tile.title} size={24} /></View>
              <Text style={styles.lockupX}>×</Text>
            </>
          )}
          <Text style={styles.mark}>NOMILA</Text>
        </View>
        <View>
          {book ? <Text style={styles.coverKicker}>{tile.title.toUpperCase()}</Text> : null}
          <Text style={styles.coverFirst} numberOfLines={1} adjustsFontSizeToFit>{name.first}</Text>
          {name.rest ? <Text style={styles.coverRest} numberOfLines={1} adjustsFontSizeToFit>{name.rest}</Text> : null}
        </View>
      </View>
      <View style={styles.kickerRow}>
        <View style={[styles.dot, { backgroundColor: DOT_COLOR[tile.dot] }]} />
        <Text style={styles.kicker} numberOfLines={2}>{coverCaption(tile)}</Text>
      </View>
    </Pressable>
  );
}

/** Posted: an Instagram-style grid, three across, with the post's one extra line ("41 views") on it. */
function PostedGrid({ tiles, onOpen, width }: { tiles: StudioTile[]; onOpen: (t: StudioTile) => void; width: number }) {
  const gap = 3;
  const w = Math.floor((Math.min(width, 520) - Bold.gutter * 2 - gap * 2) / 3);
  return (
    <View style={[styles.grid, { gap }]} testID="studio3-grid">
      {tiles.map((t) => (
        <Pressable key={t.id} onPress={() => onOpen(t)} accessibilityRole="button" accessibilityLabel={t.title} style={{ width: w, height: Math.round(w * 1.25) }} testID={`studio3-cell-${t.id}`}>
          {t.thumbUrl ? <Photo uri={t.thumbUrl} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, styles.blankArt]} />}
          {t.meta ? <Text style={styles.cellMeta} numberOfLines={1}>{t.meta}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const TALL_W = 132;
const COVER_W = 150;

const styles = StyleSheet.create({
  screen:     { flex: 1, backgroundColor: Bold.paper },
  feedScreen: { flex: 1, backgroundColor: Accent.hero },
  center:     { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 40, paddingHorizontal: 24 },
  head:       { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  title:      { ...BoldType.screenTitle, color: Bold.ink },
  createPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: Accent.pink, borderRadius: 20, paddingHorizontal: 14, height: 38, ...Shadows.sm },
  createPillText: { ...BoldType.label, color: Bold.onDark },
  switchRow:  { paddingHorizontal: Bold.gutter, marginTop: 12 },
  switchPaper: { alignSelf: "flex-start", backgroundColor: Bold.paper, borderRadius: 20, ...Shadows.sm },
  switchInner: { flexDirection: "row", padding: 3, gap: 2 },
  switchBtn:  { height: 32, paddingHorizontal: 16, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  switchOn:   { backgroundColor: Bold.ink },
  switchOnDark: { backgroundColor: Bold.paper },
  switchText: { ...BoldType.label, color: Bold.mute },
  switchTextOn: { color: Bold.onDark },
  switchTextDark: { color: Bold.onDarkSoft },
  switchTextOnDark: { color: Bold.ink },
  feedHead:   { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  plus:       { width: 44, height: 44, borderRadius: 22, backgroundColor: Accent.pink, alignItems: "center", justifyContent: "center", ...Shadows.lg },
  shelves:    { gap: 26, marginTop: 18 },
  shelf:      { gap: 10 },
  shelfTitle: { ...BoldType.h4, color: Bold.ink, paddingHorizontal: Bold.gutter },
  shelfRow:   { gap: 12, paddingHorizontal: Bold.gutter, paddingBottom: 6 },
  shelfEmpty: { ...BoldType.lede, color: Bold.mute, paddingHorizontal: Bold.gutter },
  tall:       { width: TALL_W, gap: 6 },
  tallArt:    { width: TALL_W, height: Math.round(TALL_W * 1.25), borderRadius: 16, overflow: "hidden", backgroundColor: Bold.line, ...Shadows.card },
  cover:      { width: COVER_W, gap: 6 },
  coverArt:   { width: COVER_W, height: Math.round((COVER_W * 4) / 3), borderRadius: 14, overflow: "hidden", backgroundColor: Accent.hero, padding: 10, justifyContent: "space-between", ...Shadows.card },
  lockup:     { flexDirection: "row", alignItems: "center", gap: 6 },
  logoChip:   { width: 30, height: 30, borderRadius: 8, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  lockupX:    { ...BoldType.label, color: Bold.onDarkSoft },
  mark:       { ...BoldType.chip, color: Bold.onDark, letterSpacing: 2.2 },
  coverKicker: { ...BoldType.chip, color: Accent.pinkSoft, letterSpacing: 1.6, marginBottom: 2 },
  coverFirst: { ...BoldType.screenTitle, fontSize: 30, lineHeight: 32, color: Bold.onDark, letterSpacing: -0.6 },
  coverRest:  { ...BoldType.screenTitle, fontSize: 22, lineHeight: 24, color: Bold.onDarkSoft, letterSpacing: -0.4, opacity: 0.6 },
  kickerRow:  { flexDirection: "row", alignItems: "center", gap: 6 },
  dot:        { width: 8, height: 8, borderRadius: 4 },
  kicker:     { ...BoldType.label, color: Bold.mute, flexShrink: 1 },
  tileTitle:  { ...BoldType.rowTitle, color: Bold.ink },
  grid:       { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: Bold.gutter },
  cellMeta:   { ...BoldType.chip, position: "absolute", left: 6, bottom: 6, color: Bold.onDark },
  blankArt:   { alignItems: "center", justifyContent: "center", backgroundColor: Bold.line },
  pressed:    { transform: [{ scale: Bold.pressScale }] },
  createGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 4 },
  createTile: { width: "47%", flexGrow: 1, backgroundColor: Bold.paper, borderRadius: 18, padding: 14, alignItems: "center", gap: 4, ...Shadows.card },
  createArt:  { width: 72, height: 72 },
  createLabel: { ...BoldType.h4, color: Bold.ink },
  createLine: { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  emptyArt:   { width: 120, height: 120 },
  emptyTitle: { ...BoldType.h4, color: Bold.ink },
  muted:      { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
});
