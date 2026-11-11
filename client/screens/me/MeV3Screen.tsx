// Me v3 — option A (EXPO_PUBLIC_HOME_V3; "Me, Studio and the brand book: options", 19 Oct 2026): the Me tab's root.
// With the flag off Me is screens/me/MeScreen.tsx, opened from the avatar, exactly as before. Top to bottom:
//
//   hero      her photo full-bleed and under the status bar (MeHero, the same photo Home used; its top scrim keeps the
//             clock legible), her name, and ONE factual identity line; the gear (Settings) at the top right
//   M.I.A.    today's dark score block from Home (ScoreBlock: the ring, Nomila's read, the four capitals, "Open My
//             Intelligence")
//   tiles     five illustrated SET-UP tiles, two columns ("Icons and Glass", 20 Oct 2026; lib/meTilesLogic.ts): Brand book (its
//             last chapter is her plan, so it carries the plan's live progress) · Your page · Your rates, each her own
//             content laid onto a frame and flattened to one picture
//             (ComposedTile) · Your bookings · Your shop, one illustration for every athlete. Me is where she sets things
//             up; she runs them in Business (owner, 20 Oct 2026), so no Offers tile and no request counts here. Under each
//             name ONE short line (tileLine): what the tile is, or one live fact; "Turn on" in pink until Bookings / Shop
//             are on. Your bookings opens her bookable sessions inside Me (the booking screens are mounted on Me's stack).
//   rows      plain rows with line icons: Get set up (the checklist sheet; once everything is done the row is
//             Connections instead, and the checklist is gone) · What Nomila knows.
//   can do    What Mila can do: every capability Mila can switch on, on · paused · off (cards/kit/WhatMilaCanDo; the
//             server's MILA_WELCOME is the gate: off, the route 404s and nothing is drawn).
//
// Everything opens INSIDE the Me tab (its stack, MainTabNavigator MeTabStack), so the bar stays under it.

import React, { useRef, useState } from "react";
import { View, Text, SafeAreaView, StatusBar, StyleSheet, Pressable, Modal, Animated, Image, useWindowDimensions, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType, Shadows, outfitFamily } from "../../constants/theme";
import { useAuth } from "../../lib/auth-context";
import { haptics } from "../../lib/haptics";
import { acceptPushAsk } from "../../lib/push";
import { openMila } from "../../lib/milaLaunch";
import { AGENT_V3, SHOP_V1 } from "../../lib/flags";
import { MeWhatMilaCanDo } from "../../components/mila/cards/kit/ScreenCards";
import { useMePool } from "../../hooks/use-me-knowledge";
import { useConnections } from "../../hooks/use-connections";
import { useHomeV3 } from "../../hooks/use-home-v3";
import { identityLine } from "../../lib/knowledgeLogic";
import { meImagery, photoUri, thumbUri } from "../../lib/myStoryLogic";
import { useLastHero } from "../../lib/lastHero";
import { capitalizeParts, checklistProgress, HOME_V3_COPY, ME_TILE_COPY, planTileMeta, setupDone, type SetupItem } from "../../lib/homeV3Logic";
import { openOfferEditor } from "../../navigation/bookingsNav";
import { useOffers } from "../../hooks/use-bookings";
import { useAgentGoalsPlan } from "../../lib/agent/hooks";
import { composedTile, isWide, meTileKeys, ME_TILES_COPY, ratesForTile, tileLine, type ComposedKey, type MeTileKey } from "../../lib/meTilesLogic";
import { ComposedTile } from "../../components/me/ComposedTile";
import { useKitPhoto } from "../../components/homeV3/useKitPhoto";
import { useRates } from "../../hooks/use-rates";
import { useShop } from "../../hooks/use-shop";
import { useBrandBook } from "../../hooks/use-brand-book";
import { bookTile } from "../../lib/brandBookLogic";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { ScoreBlock } from "../../components/home/HomeBriefing";
import { ChecklistBody } from "../../components/homeV3/HomeV3Pieces";
import { openHomeTarget } from "../../components/homeV3/homeTargets";
import { useMiaCard } from "../../components/homeV3/useMiaCard";
import { DetailSheet } from "../../components/me/DetailSheet";
import { Button, StackHeader } from "../../components/ui";
import { GoalsTab } from "../agent/GoalsTabScreen";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";

type IconName = React.ComponentProps<typeof Feather>["name"];

export const ME_V3_COPY = {
  setup: { title: "Get set up" },
  connections: { title: "Connections" },
  knows: { title: "What Nomila knows", meta: ME_TILE_COPY.knows },
} as const;

/** The pictures (lib/meTilesLogic): a frame for her content, or one illustration for every athlete. */
const PICTURE: Record<MeTileKey, ImageSourcePropType> = {
  brand: require("../../assets/illustrations/book.jpg"),
  plan: require("../../assets/illustrations/plan.jpg"),
  page: require("../../assets/illustrations/page.jpg"),
  rates: require("../../assets/illustrations/rates.jpg"),
  offers: require("../../assets/illustrations/offers.jpg"),
  bookings: require("../../assets/illustrations/bookings.jpg"),
  shop: require("../../assets/illustrations/shop.jpg"),
};
const COMPOSED: ReadonlySet<MeTileKey> = new Set<ComposedKey>(["brand", "plan", "page", "rates"]);

/** This week's first three posts' pictures, in plan order (the prints on Your plan). */
function usePlanPhotos(ids: Array<string | null>): string[] {
  const a = useKitPhoto(ids[0] ?? null);
  const b = useKitPhoto(ids[1] ?? null);
  const c = useKitPhoto(ids[2] ?? null);
  return [a, b, c].filter((u): u is string => !!u);
}

interface Row { key: string; title: string; meta: string; icon: IconName; badge: number; onPress: () => void }

export function MeV3Screen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const { athlete } = useAuth();
  const mia = useMiaCard();
  const o = mia.overview.data;
  const pool = useMePool();
  const img = meImagery(pool, "home");
  const shown = useLastHero(athlete?.id, img.hero && photoUri(img.hero) ? { uri: photoUri(img.hero)!, key: img.hero.asset_id } : null);
  const home = useHomeV3(true);
  const conn = useConnections();
  const rates = useRates();
  const shop = useShop(SHOP_V1);
  // The brand book (BRAND_BOOK_V1): null while the server flag is off, and the tile keeps opening the brand screen.
  const book = useBrandBook(true);
  const bookState = bookTile(book.data);
  const { width } = useWindowDimensions();
  const [checklist, setChecklist] = useState(false);
  const pull = usePullRefresh(() => Promise.all([mia.refetch(), home.refetch()]));

  const progress = checklistProgress(home.checklist);
  const allSet = setupDone(home.checklist);
  const toDo = progress.total - progress.done;
  const connected = conn.connections.filter((c) => c.status === "active").length;
  const circle = (key: string) => home.circles.find((c) => c.key === key);
  const planPhotos = usePlanPhotos((circle("week")?.items ?? []).map((i) => i.kitActionId ?? null));
  const library = [shown?.uri, ...img.others.map((p) => thumbUri(p))].filter((u): u is string => !!u);
  const content = {
    firstName: (o?.identity.displayName ?? "").trim().split(/\s+/)[0] ?? "",
    photos: library,
    planPhotos,
    rates: ratesForTile(rates.data?.rows),
  };
  const bookingsEnabled = !!rates.data?.bookings_enabled;
  const offers = useOffers();
  const goals = useAgentGoalsPlan();
  const ready = circle("week")?.items.length ?? 0;
  const facts = {
    book: book.data ? bookState.sub : null,
    plan: goals.data || ready ? planTileMeta(goals.data?.goals.length ?? 0, ready) : null,
    rates: content.rates.length,
    bookingsEnabled,
    sessions: bookingsEnabled ? (offers.data?.length ?? 0) : 0,
    shopPicks: shop.data?.items.length ?? 0,
  };
  const keys = meTileKeys();
  const open: Record<MeTileKey, () => void> = {
    // The brand book (BRAND_BOOK_V1): its own screen. With the server flag off (null) the tile opens the existing
    // scouting / brand screen (Me > Scouting), as before.
    brand: () => navigation.navigate(book.data ? "BrandBook" : "Scouting"),
    plan: () => navigation.navigate("Plan"),
    page: () => navigation.navigate("PublicPage"),
    rates: () => navigation.navigate("YourRates"),
    offers: () => navigation.navigate("Opportunities"),
    // Set up here, run in Business: her bookable sessions (Bookings › Offers, inside Me); not on yet, her first one.
    bookings: () => (bookingsEnabled ? navigation.navigate("Bookings", { tab: "offers", back: "Me" }) : openOfferEditor(navigation, null)),
    shop: () => navigation.navigate("Picks"),
  };
  // Two columns inside the gutter; the picture is square and fills the tile's width.
  const colW = (width - Bold.gutter * 2 - GAP) / 2;
  const onSetup = (item: SetupItem) => {
    setChecklist(false);
    openHomeTarget(navigation, item.target, {
      chat: (c) => openMila({ draft: c.draft, conversationId: c.conversationId }),
      push: () => { void acceptPushAsk().then(() => home.refetch()); },
      settings: () => navigation.navigate("Settings"),
    });
  };

  const rows: Row[] = [
    allSet
      ? { key: "connections", title: ME_V3_COPY.connections.title, meta: ME_TILE_COPY.connected(connected), icon: "link", badge: 0, onPress: () => navigation.navigate("Settings") }
      : { key: "setup", title: ME_V3_COPY.setup.title, meta: ME_TILE_COPY.toDo(toDo), icon: "check-circle", badge: toDo, onPress: () => setChecklist(true) },
    { key: "knows", ...ME_V3_COPY.knows, icon: "info", badge: 0, onPress: () => navigation.navigate(AGENT_V3 ? "KnowsFacts" : "Knows") },
  ];

  return (
    <View style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <Animated.ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={pullRefresh(pull)}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        testID="me-v3"
      >
        <MeHero
          photoUrl={shown?.uri ?? null}
          photoKey={shown?.key}
          loading={mia.overview.isLoading}
          title={o?.identity.displayName ?? ""}
          titleSize="sm"
          minHeight={320 + insets.top}
          style={{ paddingTop: insets.top }}
          topRight={(
            <Pressable onPress={() => { haptics.press(); navigation.navigate("Settings"); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Open Settings" style={styles.gear}>
              <Feather name="settings" size={20} color={Bold.onDark} />
            </Pressable>
          )}
          subtitle={identityLine(o?.identity) ? <MeHeroLine>{capitalizeParts(identityLine(o?.identity))}</MeHeroLine> : undefined}
        >
          {mia.overview.isError ? <Button bold="onHero" onPress={() => mia.overview.refetch()}>Retry</Button> : null}
        </MeHero>

        {mia.entry ? (
          <ScoreBlock
            score={mia.score}
            early={mia.early}
            line={mia.line}
            confidence={mia.confidence}
            bands={mia.bands}
            preliminary={mia.preliminary}
            preliminaryLine={mia.preliminaryLine}
            onPress={() => navigation.navigate("Intelligence")}
            testID="me-v3-mia"
          />
        ) : null}

        <View style={styles.grid} testID="me-v3-grid">
          {keys.map((key, i) => {
            const wide = isWide(keys, i);
            const pic = wide ? Math.min(colW, 200) : colW - TILE_PAD * 2;
            const label = ME_TILES_COPY[key];
            const line = tileLine(key, facts);
            return (
              <Pressable
                key={key}
                onPress={() => { haptics.press(); open[key](); }}
                style={({ pressed }) => [styles.tile, wide ? styles.tileWide : { width: colW }, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${label}, ${line.text}`}
                testID={`me-v3-tile-${key}`}
              >
                {COMPOSED.has(key)
                  ? <ComposedTile tile={composedTile(key as ComposedKey, content)} frame={PICTURE[key]} size={pic} label={label} />
                  : <Image source={PICTURE[key]} style={{ width: pic, height: pic }} accessibilityLabel={label} />}
                <Text style={[styles.tileTitle, wide && styles.tileTitleWide]} numberOfLines={1}>{label}</Text>
                <Text style={[styles.tileSub, line.invite && styles.tileInvite]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} testID={`me-v3-sub-${key}`}>{line.text}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.rows} testID="me-v3-rows">
          {rows.map((r) => (
            <Pressable
              key={r.key}
              onPress={() => { haptics.press(); r.onPress(); }}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${r.title}. ${r.meta}`}
              testID={`me-v3-row-${r.key}`}
            >
              <Feather name={r.icon} size={20} color={Bold.ink} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>{r.title}</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>{r.meta}</Text>
              </View>
              {r.badge ? <View style={styles.badgeInline}><Text style={styles.badgeText}>{r.badge}</Text></View> : null}
              <Feather name="chevron-right" size={18} color={Bold.mute} />
            </Pressable>
          ))}
        </View>

        {/* What Mila can do (decision 16): every capability Mila can switch on, with Turn on (its sheet), Pause and Turn
            off. Not behind a client flag, so no build can strand a capability: MILA_WELCOME off, the route 404s and Me
            reads exactly as today. */}
        <MeWhatMilaCanDo style={styles.canDo} />
      </Animated.ScrollView>

      {/* Once the hero scrolls under it, a dark band behind the status bar so the clock never sits on her name. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.statusBand, { height: insets.top, opacity: scrollY.interpolate({ inputRange: [0, STATUS_BAND_AT, STATUS_BAND_AT + 40], outputRange: [0, 0, 1], extrapolate: "clamp" }) }]}
        testID="me-v3-status-band"
      />

      {/* In a Modal so the sheet's scrim covers the tab bar too; never once everything is done. */}
      <Modal visible={checklist && !allSet} transparent animationType="fade" onRequestClose={() => setChecklist(false)}>
        <DetailSheet title={HOME_V3_COPY.checklist.title} onClose={() => setChecklist(false)} testID="me-v3-checklist-sheet">
          <ChecklistBody items={home.checklist} onItem={onSetup} />
        </DetailSheet>
      </Modal>
    </View>
  );
}

/** "Your plan" (Me › Plan): the Goals screen, moved off the bar into Me, under a ‹ ME back row. */
export function YourPlanScreen() {
  const navigation = useNavigation<any>();
  return (
    <SafeAreaView style={styles.plan} testID="me-v3-plan">
      <StackHeader title="Me" bold onBack={() => navigation.goBack()} />
      <View style={styles.planBody}><GoalsTab title={ME_TILES_COPY.plan} /></View>
    </SafeAreaView>
  );
}

/** How far the page scrolls before the status-bar band fades in (the hero's name is about this far down). */
const STATUS_BAND_AT = 200;
/** Space between tiles, and inside a tile around its picture. */
const GAP = 12;
const TILE_PAD = 8;

const styles = StyleSheet.create({
  statusBand:{ position: "absolute", top: 0, left: 0, right: 0, backgroundColor: Accent.hero },
  plan:      { flex: 1, backgroundColor: Bold.paper },
  planBody:  { flex: 1 },
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingBottom: 32 },
  gear:      { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  grid:      { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", paddingHorizontal: Bold.gutter, marginTop: 16, rowGap: GAP },
  // Airbnb-style tiles: white, big radius, a soft wide low shadow, no border; the picture fills the tile.
  tile:      { backgroundColor: Bold.paper, borderRadius: 20, padding: TILE_PAD, paddingBottom: 12, alignItems: "center", gap: 6, ...Shadows.card },
  tileWide:  { width: "100%", flexDirection: "row", justifyContent: "center", gap: 14 },
  pressed:   { transform: [{ scale: Bold.pressScale }] },
  tileTitle: { ...BoldType.rowTitle, color: Bold.ink, textAlign: "center" },
  tileSub: { ...BoldType.rowMeta, color: Bold.mute, textAlign: "center", marginTop: -2 },
  tileInvite: { color: Accent.pinkDeep, fontFamily: outfitFamily("600") },
  tileTitleWide: { textAlign: "left" },
  badgeInline: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: Accent.pink, alignItems: "center", justifyContent: "center" },
  badgeText: { ...BoldType.caption, color: Bold.onDark, fontFamily: outfitFamily("700") },
  canDo:     { marginTop: 28, marginHorizontal: Bold.gutter },
  rows:      { marginTop: 22, marginHorizontal: Bold.gutter, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  row:       { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Bold.line },
  rowText:   { flex: 1 },
  rowTitle:  { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:   { ...BoldType.caption, color: Bold.mute },
});
