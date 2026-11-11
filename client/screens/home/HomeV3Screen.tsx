// Home v3 (EXPO_PUBLIC_HOME_V3; UX flow v3 "one thing, one place", 19 Oct 2026). The Home tab's landing when the flag is
// on; with it off Home is screens/home/HomeScreen.tsx exactly as before. Four pieces under a slim header, top to bottom:
//
//   header        NOMILA · the small M.I.A. ring (today's IntelligenceRing, small; opens Me) · her avatar (opens Me, as
//                 a profile picture does everywhere) with a pink badge counting nice-to-have setup still to do — Me's
//                 Get set up tile carries the same count and opens the checklist
//   circles       This week · Offers · Bookings (when a request waits) · Moments (+ Wins when there is one); a tap
//                 opens that circle's full-screen stories
//   admin row     at most ONE blocking item, "+N more" → the checklist sheet ("Things to sort · x of y done"), the
//                 only door to the checklist on Home
//   briefing      Mila talking (option C): up to three one-sentence messages, each with the item's card and tap-to-answer
//                 chips; a chip opens what the app already has — the post kit, the booking, the Not-for-me sheet, or
//                 Mila's chat as a half-sheet with the ask sent for her (anything that goes out still waits for her
//                 Send); "Later" hides it for today; "N more in your circles" scrolls up to them
//
// What shows and what Mila says is lib/homeV3Logic (pure, tested); the reads are hooks/use-home-v3 (existing routes,
// plus GET /me/agent/wins). "Seen" is kept on the phone per story item. Copy is "you", one line per card.

import React, { useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, Pressable, Modal } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { useAuth } from "../../lib/auth-context";
import { haptics } from "../../lib/haptics";
import { acceptPushAsk } from "../../lib/push";
import { openMe } from "../../navigation/meNav";
import { useHomeV3, useLaterToday, useSeenStories } from "../../hooks/use-home-v3";
import { useMeOverview, useMePhotos } from "../../hooks/use-me-knowledge";
import { avatarPhotoUrl } from "../../lib/myStoryLogic";
import { badgeText, briefing, firstNameOf, firstUnseenIndex, type BriefAct, type BriefMessage, type Circle, type CircleKey, type HomeTarget, type SetupItem, type StoryItem } from "../../lib/homeV3Logic";
import { IntelligenceRing } from "../../components/intelligence/IntelligenceRing";
import { StoryCircles, type CircleFace } from "../../components/homeV3/StoryCircles";
import { StoryViewer } from "../../components/homeV3/StoryViewer";
import { AdminRowView, ChecklistBody } from "../../components/homeV3/HomeV3Pieces";
import { MilaBriefing, type BriefSlot } from "../../components/homeV3/MilaBriefing";
import { KitScreenHost, kitBriefingSlots, useCardSurface } from "../../components/mila/cards/kit/ScreenCards";
import { MILA_CARDS_V2 } from "../../lib/flags";
import { NotForMeSheet } from "../../components/deals/NotForMeSheet";
import { MilaChatSheet, type ChatSeed } from "../../components/homeV3/MilaChatSheet";
import { openHomeTarget } from "../../components/homeV3/homeTargets";
import { useKitPhoto } from "../../components/homeV3/useKitPhoto";
import { useMomentImages } from "../../hooks/use-moment-images";
import { useMiaCard } from "../../components/homeV3/useMiaCard";
import { DetailSheet } from "../../components/me/DetailSheet";
import { Photo } from "../../components/ui/Photo";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { HOME_V3_COPY } from "../../lib/homeV3Logic";

const RING = 34;
const AVATAR = 28;

export function HomeV3Screen() {
  const navigation = useNavigation<any>();
  const { athlete } = useAuth();
  const home = useHomeV3(true);
  const mia = useMiaCard();
  const { seen, see } = useSeenStories(athlete?.id);
  const { later, putOff } = useLaterToday(athlete?.id);
  const scrollRef = useRef<ScrollView>(null);

  const [story, setStory] = useState<{ circle: Circle; start: number } | null>(null);
  const [chat, setChat] = useState<ChatSeed | null>(null);
  const [checklist, setChecklist] = useState(false);
  const [notForMe, setNotForMe] = useState<Extract<BriefAct, { kind: "not_for_me" }> | null>(null);

  const pull = usePullRefresh(() => Promise.all([home.refetch(), mia.refetch()]));

  const push = () => { void acceptPushAsk().then(() => home.refetch()); };
  const go = (t: HomeTarget) => openHomeTarget(navigation, t, { chat: (o) => setChat(o), push });
  const onStoryAction = (item: StoryItem) => { setStory(null); go(item.action.target); };
  const onSetup = (item: SetupItem) => { setChecklist(false); go(item.target); };

  const brief = useMemo(() => briefing({
    ...home.parts, later, hour: new Date().getHours(), firstName: firstNameOf(athlete?.firstName),
  }), [home.parts, later, athlete?.firstName]);
  const act = (m: BriefMessage, a: BriefAct) => {
    if (m.item) see([m.item.id]);
    switch (a.kind) {
      case "open": go(a.target); return;
      case "ask": setChat({ prompt: a.prompt }); return;
      case "chat": setChat({ draft: a.draft, conversationId: a.conversationId }); return;
      case "not_for_me": setNotForMe(a); return;
      case "later": putOff(m.id); return;
    }
  };
  // Back from the chat sheet: what she answered there leaves the briefing.
  const closeChat = () => { setChat(null); void home.refetch(); };

  // Pictures for the circles. This week shows its SECOND post's photo — the big card already shows the first, and her
  // face appears at most twice on a screen (DESIGN.md §9); with one post, the glyph. Offers: the first brand's logo,
  // whole on a white disc (its initial when it has none). Moments: the next one's date as a calendar face.
  const weekCircle = home.circles.find((c) => c.key === "week");
  const momentImages = useMomentImages(home.circles.find((c) => c.key === "moments")?.items ?? []);
  const weekPhoto = useKitPhoto(weekCircle?.items[1]?.kitActionId ?? null);
  const { photoUrl: avatarUrl } = useAvatarPhoto();
  const images = useMemo<Partial<Record<CircleKey, CircleFace | null>>>(() => {
    // Offers: the FIRST offer's own face (Offers 1 of N, the one Mila's line names): its logo, else its initial.
    const first = home.circles.find((c) => c.key === "offers")?.items[0] ?? null;
    const initial = (first?.brandName ?? first?.title ?? "").trim().charAt(0).toUpperCase();
    // A stored logo first (a strong mark), else the brand's cover photo, else the domain's favicon, else the initial.
    const logoFace = first ? { logo: { url: first.logoUrl ?? null, domain: first.logoDomain ?? null, name: first.brandName ?? first.title } } : null;
    const offers: CircleFace | null = !first ? null
      : first.logoUrl ? logoFace
      : first.coverUrl ? { photo: first.coverUrl }
      : first.logoDomain ? logoFace
      : initial ? { initial } : null;
    // Moments: the next moment's picture (its post's photo, its atmosphere image, else its kind's card), not a date.
    const next = home.circles.find((c) => c.key === "moments")?.items[0] ?? null;
    return { week: weekPhoto ? { photo: weekPhoto } : null, offers, moments: next ? { moment: next, imageUrl: momentImages[next.id] ?? null } : null };
  }, [weekPhoto, home.circles, momentImages]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)} testID="home-v3">
        <View style={styles.header}>
          <Text style={styles.wordmark}>NOMILA</Text>
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => { haptics.press(); openMe(navigation); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={mia.score != null ? `M.I.A. ${mia.score}. Open Me` : "Open Me"}
              testID="home-v3-ring"
            >
              <IntelligenceRing score={mia.score} bands={mia.bands} size={RING} quiet={mia.early} outOf={null} />
            </Pressable>
            <SetupAvatar photoUrl={avatarUrl} badge={home.badge} onPress={() => openMe(navigation)} />
          </View>
        </View>

        <StoryCircles
          circles={home.circles}
          seen={seen}
          images={images}
          onOpen={(c) => setStory({ circle: c, start: firstUnseenIndex(c.items, seen) })}
        />

        {home.admin ? <AdminRowView row={home.admin} onItem={onSetup} onMore={() => setChecklist(true)} /> : null}

        {/* The card system v2 (EXPO_PUBLIC_MILA_CARDS_V2): Insight, Idea and Turn-on take the briefing's compact slots,
            collapsed (design v2.2 decision 3); the hero and everything else stay as today. */}
        {MILA_CARDS_V2 ? (
          <HomeKitBriefing onAsk={(text) => setChat({ draft: text })}>
            {(slots) => (
              <MilaBriefing
                briefing={brief}
                momentImages={momentImages}
                onOpen={(m) => act(m, m.open)}
                onChip={(m, c) => act(m, c.act)}
                onMore={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
                slots={slots}
              />
            )}
          </HomeKitBriefing>
        ) : (
          <MilaBriefing
            briefing={brief}
            momentImages={momentImages}
            onOpen={(m) => act(m, m.open)}
            onChip={(m, c) => act(m, c.act)}
            onMore={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          />
        )}
      </ScrollView>

      {story ? (
        <StoryViewer
          circle={story.circle}
          start={story.start}
          avatarUrl={avatarUrl}
          onClose={() => setStory(null)}
          onAction={onStoryAction}
          onSeen={(id) => see([id])}
        />
      ) : null}

      {/* In a Modal so the sheet's scrim covers the tab bar too. */}
      <Modal visible={checklist} transparent animationType="fade" onRequestClose={() => setChecklist(false)}>
        <DetailSheet title={HOME_V3_COPY.checklist.title} onClose={() => setChecklist(false)} testID="home-v3-checklist-sheet">
          <ChecklistBody items={home.checklist} onItem={onSetup} />
        </DetailSheet>
      </Modal>

      {/* Always mounted: closing and reopening the sheet is the same conversation. */}
      <MilaChatSheet seed={chat} onClose={closeChat} />

      {notForMe ? (
        <NotForMeSheet
          dealId={notForMe.dealId}
          threadId={notForMe.threadId}
          brandName={notForMe.brandName}
          onClose={() => setNotForMe(null)}
          onClosed={() => { setNotForMe(null); void home.refetch(); }}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** Her avatar photo (the same one the top bar's avatar shows). */
function useAvatarPhoto(): { photoUrl: string | null } {
  const { data } = useMeOverview();
  const photos = useMePhotos(1);
  return { photoUrl: avatarPhotoUrl(data?.identity.photoUrl, photos) ?? null };
}

/** Her avatar with the pink setup badge; opens Me (where Get set up carries the same count). */
function SetupAvatar({ photoUrl, badge, onPress }: { photoUrl: string | null; badge: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => { haptics.press(); onPress(); }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={badge ? `Open Me, ${badge} to set up` : "Open Me"}
      testID="home-v3-avatar"
    >
      {photoUrl
        ? <Photo uri={photoUrl} style={styles.avatar} transition={0} />
        : <View style={[styles.avatar, styles.avatarEmpty]}><Feather name="user" size={15} color={Bold.ink} /></View>}
      {badge ? (
        <View style={styles.badge} testID="home-v3-avatar-badge"><Text style={styles.badgeText}>{badgeText(badge)}</Text></View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingBottom: 32 },
  header:      { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  wordmark:    { ...BoldType.wordmark, color: Bold.ink },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar:      { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, borderWidth: 1.5, borderColor: Bold.ink },
  avatarEmpty: { backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  badge:       { position: "absolute", top: -5, right: -6, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, backgroundColor: Accent.pink, borderWidth: 1.5, borderColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  badgeText:   { ...BoldType.chip, fontSize: 9, letterSpacing: 0, color: Bold.onDark },
});

/** The v2 cards in Home's briefing slots (EXPO_PUBLIC_MILA_CARDS_V2 only: the hook runs only while the flag is on). */
function HomeKitBriefing({ onAsk, children }: { onAsk: (text: string) => void; children: (slots: BriefSlot[]) => React.ReactNode }) {
  const q = useCardSurface(true);
  return <KitScreenHost onAsk={onAsk}>{children(kitBriefingSlots(q.data?.briefing ?? []))}</KitScreenHost>;
}
