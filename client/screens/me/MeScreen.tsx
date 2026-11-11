// Me — "who you are and how the world sees you" (app layout B, agreed 8 Oct 2026). Opened by her avatar (the shell:
// Home › Me, inside the Home tab so the bottom menu stays; classic: MeStack › Me). Me is the ONLY screen with the
// shortcuts; Home is the daily briefing (screens/home/HomeScreen.tsx) and carries none. Top to bottom:
//
//   Hero          MeHero: her photo (her media library; the sign-in avatar never), the greeting, her name, and her
//                 factual identity — "<team> <sport>", "<role> · <position> · <class>", nationality
//   Nomi Card     her public card (PublicCardSection): with EXPO_PUBLIC_PUBLIC_CARD off, the existing My Nomi row →
//                 Brand › Deck; on, "Your public card" (state, link, Review & publish, Preview, Share, Card settings)
//   M.I.A.        ONE compact row — the ring with the number inside, Nomila's one-line read → My Intelligence. The only
//                 thing Home and Me share; Home features the score, Me only points at it
//   Doors         My Story · What Nomila Knows · My Media · My Picks (SHOP_V1). My Strategy is gone (Strategy has its
//                 own tab); My Nomi lives in the card slot above
//   Settings      account and connections (the gear's Settings; classic: the Settings tab)
//
// Reads: GET /me/overview (hero, M.I.A. slot), GET /me/intelligence (the read), GET /me/story (whether My Story is open),
// the media pool (photos). Imagery: ONE pool → meImagery(pool, "home"): the hero, then each door its own photo, never
// twice on the screen; a door with none left shows its icon tile. Facts only: nothing interpretive, never "verified".

import React from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useMeScouting } from "../../hooks/use-me-memory";
import type { MeAgentScreen as MeAgentScreenType } from "./MeAgentScreen";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MeStackParamList } from "../../navigation/MainTabNavigator";
import { leaveMeTo, openSettings, toBrand } from "../../navigation/meNav";
import { useMeOverview, useMePool } from "../../hooks/use-me-knowledge";
import { useMeStory } from "../../hooks/use-me-story";
import { meStoryModel } from "../../lib/meStoryLogic";
import { greetingFor, meIdentityLines } from "../../lib/knowledgeLogic";
import { meImagery, photoUri, thumbUri } from "../../lib/myStoryLogic";
import { useLastHero } from "../../lib/lastHero";
import { useAuth, type Athlete } from "../../lib/auth-context";
import { useMeIntelligence } from "../../hooks/use-me-intelligence";
import { COPY, meCardModel, ringBands } from "../../lib/myIntelligenceLogic";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { PublicCardSection } from "../../components/me/PublicCardSection";
import { IntelligenceRing } from "../../components/intelligence/IntelligenceRing";
import { Card, Row, Button, IconTile, useReducedMotion } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { Bold, BoldType } from "../../constants/theme";
import { Photo } from "../../components/ui/Photo";
import { AGENT_V3, PUBLIC_CARD, SHOP_V1 } from "../../lib/flags";
import { MeWhatMilaCanDo } from "../../components/mila/cards/kit/ScreenCards";
import { RatesDoor } from "../../components/me/RatesDoor";
import { PublishedSection } from "../../components/agent/PublishedSection";
import { BookingsSetupDoor } from "../../components/bookings/BookingsSetupDoor";
import { useAgentOnboarding } from "../../lib/agent/hooks";
import { profileName } from "../../lib/onboardingFront";
import { meetMilaVisible } from "../../lib/agent/onboardingLogic";

type NavProp = NativeStackNavigationProp<MeStackParamList, "Me">;
type IconName = React.ComponentProps<typeof Feather>["name"];

export const DOOR_COPY = {
  // fix/existing-users-skip-onboarding: an existing athlete never did the agent onboarding conversation; this door
  // lets her ask for it. Never auto-shown — only while AGENT_V3 is on, her name and sport are known, and she has
  // never started it (meetMilaVisible).
  meetMila: { title: "Meet Mila", meta: "Talk her through what she knows about you so far" },
  story: { title: "My Story", meta: "How Nomila currently understands you", soon: "Coming soon" },
  knows: { title: "What Nomila Knows", meta: "Your facts, and where each one came from" },
  intelligence: { title: "My Intelligence", meta: "Nomila's read of your marketability" },
  media: { title: "My Media", meta: "Your photos and videos", empty: "Add photos" },
  picks: { title: "My Picks", meta: "Products you use, with your own links" },
  settings: { title: "Settings", meta: "Your account and connections" },
} as const;

/** A door's leading mark: one of her photos when the pool has one left for it (never the hero), else the black icon tile. */
const DoorMark = ({ photo, icon, muted }: { photo?: string | null; icon: IconName; muted?: boolean }) =>
  photo
    ? <Photo uri={photo} style={[styles.doorPhoto, muted && styles.doorMuted]} />
    : <IconTile icon={icon} bold="black" muted={muted} />;

/**
 * Me. With EXPO_PUBLIC_AGENT_V3 on and her memory served (GET /me/scouting not "no_memory"), the agent Me
 * (MeAgentScreen: her public page mini, the Scouting report, What Nomila knows). Otherwise — the flag off, no memory
 * yet, or the read failing — the existing Me below, unchanged.
 */
export function MeScreen({ now = new Date() }: { now?: Date } = {}) {
  if (!AGENT_V3) return <MeClassicScreen now={now} />;
  return <MeAgentGate now={now} />;
}

function MeAgentGate({ now }: { now: Date }) {
  const scouting = useMeScouting(true);
  const d = scouting.data;
  if (scouting.isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.gateLoading} testID="me-loading"><ActivityIndicator color={Bold.ink} /></View>
      </SafeAreaView>
    );
  }
  if (d && d.status !== "no_memory") {
    // Loaded only on this path (the flag on and her memory served), so the classic Me never pulls the page's video parts.
    const { MeAgentScreen } = require("./MeAgentScreen") as { MeAgentScreen: typeof MeAgentScreenType };
    return <MeAgentScreen report={d} onRefresh={() => scouting.refetch()} />;
  }
  return <MeClassicScreen now={now} />;
}

/**
 * "Meet Mila" — on request only, never auto-shown (fix/existing-users-skip-onboarding). Its own component so
 * useAgentOnboarding (react-query) is only ever called while AGENT_V3 is on (the caller mounts it conditionally),
 * exactly like PublishedSection above it.
 */
function MeetMilaDoor({ athlete, onPress }: { athlete: Athlete | null; onPress: () => void }) {
  const agentOnboarding = useAgentOnboarding(true);
  const visible = meetMilaVisible({ agentV3: true, name: profileName(athlete ?? null), sport: athlete?.sport ?? null, everStarted: agentOnboarding.data?.everStarted });
  if (!visible) return null;
  return <Row bold leading={<IconTile icon="message-circle" bold="black" />} value={DOOR_COPY.meetMila.title} meta={DOOR_COPY.meetMila.meta} onPress={onPress} />;
}

export function MeClassicScreen({ now = new Date() }: { now?: Date } = {}) {
  const navigation = useNavigation<NavProp>();
  const reduced = useReducedMotion();
  const overview = useMeOverview();
  const pool = useMePool();
  const story = useMeStory();
  const o = overview.data;
  const img = meImagery(pool, "home");
  const { athlete } = useAuth();
  const shown = useLastHero(athlete?.id, img.hero && photoUri(img.hero) ? { uri: photoUri(img.hero)!, key: img.hero.asset_id } : null);
  // The card slot and the doors each take their own photo, after the hero, never twice.
  const photo = (i: number) => thumbUri(img.others[i]);
  const id = meIdentityLines(o?.identity);
  const st = meStoryModel(story.data);
  const entry = o?.intelligence ?? null;
  const intel = useMeIntelligence(!!entry && entry.score != null);
  const card = meCardModel(entry, intel.data);
  const toMedia = () => leaveMeTo(navigation, "Studio", "MediaLibrary");
  // Swipe down: this screen's reads again — the overview, the story, the score read.
  const pull = usePullRefresh(() => Promise.all([
    overview.refetch?.(),
    story.refetch?.(),
    entry && entry.score != null ? intel.refetch?.() : undefined,
  ]));
  const miaLabel = card.score
    ? `My Intelligence, M.I.A. ${card.score} out of 850${card.line ? `. ${card.line}` : ""}`
    : `My Intelligence. ${card.line ?? DOOR_COPY.intelligence.meta}`;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)}>
        <MeHero
          photoUrl={shown?.uri ?? null}
          photoKey={shown?.key}
          onBack={() => navigation.goBack()}
          loading={overview.isLoading}
          greeting={`${greetingFor(now)},`}
          title={o?.identity.displayName ?? ""}
          minHeight={400}
          subtitle={(
            <View style={styles.identity}>
              {id.primary ? <MeHeroLine strong>{id.primary}</MeHeroLine> : null}
              {id.detail ? <MeHeroLine>{id.detail}</MeHeroLine> : null}
              {id.nationality ? <MeHeroLine>{id.nationality}</MeHeroLine> : null}
              {!id.primary && !id.detail && o ? <MeHeroLine muted>Tell Nomila your team and sport to fill this in.</MeHeroLine> : null}
            </View>
          )}
        >
          {overview.isError ? <Button bold="onHero" onPress={() => overview.refetch()} style={styles.retry}>Retry</Button> : null}
        </MeHero>

        {/* ── her Nomi Card: the public card section (flag on), else the existing My Nomi (deck) row ── */}
        <PublicCardSection
          enabled={PUBLIC_CARD}
          photo={photo(0)}
          onDeck={() => toBrand(navigation, "Deck")}
          onReview={() => navigation.navigate("PublicCardReview")}
          onPreview={() => navigation.navigate("PublicCardPreview")}
          onSettings={() => navigation.navigate("PublicCardSettings")}
        />

        {/* AGENT_V3: what the athlete has published (the Studio library's published items). */}
        {AGENT_V3 ? <PublishedSection /> : null}

        {/* What Mila can do (decision 16): every capability Mila can switch on (MILA_WELCOME off: the route 404s, nothing drawn). */}
        <MeWhatMilaCanDo />

        {/* ── M.I.A.: one compact row (the ring with the number inside, the one-line read) → My Intelligence ── */}
        <Pressable
          style={({ pressed }) => [styles.mia, pressed && styles.miaPressed, pressed && !reduced && styles.pressed]}
          onPress={() => navigation.navigate("Intelligence")}
          accessibilityRole="button"
          accessibilityLabel={miaLabel}
          testID="me-mia"
        >
          <IntelligenceRing
            score={card.score ? Number(card.score) : null}
            bands={card.score && !card.early && intel.data?.assessment ? ringBands(intel.data.assessment) : undefined}
            size={52}
            quiet={card.early}
            outOf={null}
          />
          <View style={styles.miaText}>
            <Text style={styles.miaTitle}>{`${DOOR_COPY.intelligence.title}${card.early ? ` · ${COPY.earlyRead}` : ""}`}</Text>
            <Text style={styles.miaLine} numberOfLines={2}>{card.line ?? DOOR_COPY.intelligence.meta}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>

        {/* ── doors: Meet Mila (on request only) · Story · Knows · Media · Picks ── */}
        <Card bold style={styles.doors}>
          {/* AGENT_V3: mounted only behind the flag, so its own read (useAgentOnboarding, react-query) never runs
              otherwise — same reasoning as PublishedSection above. */}
          {AGENT_V3 ? <MeetMilaDoor athlete={athlete} onPress={() => navigation.navigate("MeetMila")} /> : null}
          {st.ready ? (
            <Row bold leading={<DoorMark photo={photo(1)} icon="book-open" />} value={DOOR_COPY.story.title} meta={DOOR_COPY.story.meta} onPress={() => navigation.navigate("Story")} />
          ) : (
            <Row bold leading={<DoorMark photo={null} icon="book-open" muted />} value={DOOR_COPY.story.title} meta={DOOR_COPY.story.soon} chevron={false} />
          )}
          <Row bold leading={<DoorMark photo={photo(2)} icon="search" />} value={DOOR_COPY.knows.title} meta={DOOR_COPY.knows.meta} onPress={() => navigation.navigate("Knows", {})} />
          <Row bold leading={<DoorMark photo={photo(3)} icon="image" />} value={DOOR_COPY.media.title} meta={pool.length ? DOOR_COPY.media.meta : DOOR_COPY.media.empty} onPress={toMedia} last={!SHOP_V1} />
          {SHOP_V1 ? (
            <Row bold leading={<DoorMark icon="shopping-bag" />} value={DOOR_COPY.picks.title} meta={DOOR_COPY.picks.meta} onPress={() => navigation.navigate("Picks")} last />
          ) : null}
        </Card>

        {/* Bookings v2 mount point: "Sell your time" — renders nothing unless bookings are on for her and nothing is published yet. */}
        <BookingsSetupDoor style={styles.doors} />

        {/* OPPS_V2: Your rates — Mila's suggested ranges, her private minimums, her public booking prices. */}
        <RatesDoor style={styles.doors} onPress={() => navigation.navigate("YourRates")} />

        {/* ── settings: account and connections ── */}
        <Card bold style={styles.doors}>
          <Row bold leading={<IconTile icon="settings" bold="black" />} value={DOOR_COPY.settings.title} meta={DOOR_COPY.settings.meta} onPress={() => openSettings(navigation)} last />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: Bold.paper },
  gateLoading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content:    { paddingBottom: 40 },
  identity:   { gap: 2, marginTop: 2 },
  retry:      { alignSelf: "flex-start" },
  mia:        { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: Bold.gutter, marginTop: 16, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card },
  miaPressed: { backgroundColor: Bold.ground },
  pressed:    { transform: [{ scale: Bold.pressScale }] },
  miaText:    { flex: 1, minWidth: 0, gap: 2 },
  miaTitle:   { ...BoldType.rowTitle, color: Bold.ink },
  miaLine:    { ...BoldType.rowMeta, color: Bold.mute },
  doors:      { marginHorizontal: Bold.gutter, marginTop: 16 },
  doorPhoto:  { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  doorMuted:  { opacity: 0.5 },
});
