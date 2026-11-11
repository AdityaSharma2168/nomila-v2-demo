import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Pressable, StyleSheet, Text, Platform } from "react-native";
import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Fonts, Colors, Spacing } from "../constants/theme";
import { withTopBar } from "../components/shell/TopBar";
import { type MainTabParamList, type StrategyStackParamList, INITIAL_TAB, navTargetRoute, shellRoutesFor } from "./shellTabs";
import { HomeV3Screen } from "../screens/home/HomeV3Screen";
import { MeV3Screen, YourPlanScreen } from "../screens/me/MeV3Screen";
import { MilaTabScreen, ShellTabBar, MILA_TAB } from "./milaTab";

import { OpportunitiesScreen } from "../screens/OpportunitiesScreen";
import { ThreadScreen }        from "../screens/ThreadScreen";
import { OpportunityDetailScreen } from "../screens/OpportunityDetailScreen";
import { FinancialsScreen } from "../screens/FinancialsScreen";
import { DealDetailContainer } from "../screens/DealDetailContainer";
import { DealDetailRoute } from "../screens/DealDetailRoute";
import type { DealDetailParams } from "../screens/DealDetailScreen";
import { ErrorBoundary } from "../components/mila/ErrorBoundary";
import { BrandTabScreen }      from "../screens/brand/BrandTabScreen";
import { MeScreen }            from "../screens/me/MeScreen";
import { HomeScreen }          from "../screens/home/HomeScreen";
import { KnowsScreen }         from "../screens/me/KnowsScreen";
import { BrandScreen }         from "../screens/me/BrandScreen";
import { MyIntelligenceScreen }  from "../screens/me/MyIntelligenceScreen";
import { IntelligenceAreasScreen } from "../screens/me/IntelligenceAreasScreen";
import { IntelligenceAreaScreen }  from "../screens/me/IntelligenceAreaScreen";
import { PlatformsMeasuredScreen } from "../screens/me/PlatformsMeasuredScreen";
import { MyPicksScreen } from "../screens/me/MyPicksScreen";
import { PublicCardReviewScreen } from "../screens/me/PublicCardReviewScreen";
import { PublicCardPreviewScreen } from "../screens/me/PublicCardPreviewScreen";
import { PublicCardSettingsScreen } from "../screens/me/PublicCardSettingsScreen";
import { CardChatsScreen } from "../screens/me/CardChatsScreen";
import { PublicPageScreen } from "../screens/me/PublicPageScreen";
import { KnowsFactsScreen } from "../screens/me/KnowsFactsScreen";
import { MeetMilaScreen } from "../screens/agent/MeetMilaScreen";
import { MyStoryScreen }         from "../screens/me/MyStoryScreen";
import { SignalsScreen }       from "../screens/SignalsScreen";
import { DeckScreen }          from "../screens/brand/DeckScreen";
import { RatesScreen }         from "../screens/brand/RatesScreen";
import { subscribeMilaLaunch } from "../lib/milaLaunch";
import { onPushTap, registerPushIfAllowed, setUpPush } from "../lib/push";
import { PushAskSheet } from "../components/push/PushAskSheet";
import { useAuth } from "../lib/auth-context";
import { openAgentTarget } from "../lib/agent/navigate";
import { useCameraRollPrepare } from "../hooks/use-camera-roll-prepare";
import { SettingsScreen }      from "../screens/SettingsScreen";
import { DeleteAccountScreen } from "../screens/settings/DeleteAccountScreen";
import type { MilaContext, MilaNavTarget } from "../screens/MilaSearchOverlay";
import { StudioScreen }        from "../screens/StudioScreen";
import { PitchesListScreen }   from "../screens/PitchesListScreen";
import { PitchDetailScreen }   from "../screens/PitchDetailScreen";
import { MediaLibraryScreen }  from "../screens/MediaLibraryScreen";
import { CampaignWorkspaceScreen } from "../screens/CampaignWorkspaceScreen";
import { StudioHomeScreen }    from "../screens/studio/StudioHomeScreen";
import { CreateAnythingRoute } from "../screens/studio/CreateAnythingScreen";
import { ThreadsScreen }        from "../screens/studio/ThreadsScreen";
import { AgentScreen }          from "../screens/studio/AgentScreen";
import { CarouselCreateScreen } from "../screens/studio/CarouselCreateScreen";
import type { BoardSeed }      from "../screens/studio/storyboardLogic";
import { MakeItRoute }          from "../screens/studio/MakeItScreen";
import { MadeItScreen }         from "../screens/studio/MadeItScreen";
import { BrandPostScreen }      from "../screens/studio/BrandPostScreen";
import type { Attachment, PreviewSeed, StudioFormat } from "../lib/studio-contract";
import { STUDIO_ENABLED, BOOKINGS, OPPS_BOARD, AGENT_V3, OPPS_V2, HOME_V3, webV2On } from "../lib/flags";
import { AllDealsScreen } from "../screens/AllDealsScreen";
import { YourRatesScreen } from "../screens/me/YourRatesScreen";
import { GoalsTab } from "../screens/agent/GoalsTabScreen";
import { StudioLibraryScreen } from "../screens/agent/StudioLibraryScreen";
import { PostKitScreen }       from "../screens/agent/PostKitScreen";
import { StudioForYouScreen }  from "../screens/agent/StudioForYouScreen";
import { StudioV3Screen }      from "../screens/studio/StudioV3Screen";
import { BrandBookScreen }     from "../screens/me/BrandBookScreen";
import { bookingStackScreens, type BookingsStackParamList } from "./bookingsRoutes";
import { BookingSessionScreen } from "../screens/bookings/BookingSessionScreen";
import { BookingAfterSessionScreen } from "../screens/bookings/BookingAfterSessionScreen";
import type { StudioDeliverable, StudioIntent, StudioObjective } from "../hooks/use-studio";
import { MediaDetailScreen }   from "../screens/MediaDetailScreen";
import { CameraRollReviewScreen } from "../screens/CameraRollReviewScreen";
import type { PitchStatus }    from "../hooks/use-pitches";
import type { BriefHandoff } from "../screens/studio/brandLogic";

// ─── Brand stack ──────────────────────────────────────────────────────────────
// BrandOverview is the Brand tab itself (BrandTabScreen: Card · Story · Facts · Growth). The route
// name is unchanged from the legacy Overview screen it replaced, so every navigate("BrandOverview")
// — Mila's chips, the Opportunities bridge, deep links — lands where it always did.
// The Brand tab is gone from the menu: this stack is registered on the ROOT stack as "Brand", pushed
// above the tabs (BrandHeader draws a back chevron there), so every navigate("Brand", { screen })
// still resolves — it bubbles up from any tab to the root.
// v2 shell: the deck swipes in place on BrandOverview (NomiCardHero) — expand is an
// in-place immersive overlay, Edit is a bottom sheet over the card. Neither "NomiCard"
// nor "CardEditor" are pushed destinations anymore (see client/components/brand/NomiCardHero.tsx,
// client/components/card-native/CardImmersiveOverlay.tsx, client/components/card/CardEditSheet.tsx).
// BrandOverview keeps an optional { brandId, brandName } param so cross-tab "Tailor & send"
// (OpportunitiesScreen) can land here and pop the Share sheet pre-targeted at that brand.

export type BrandTabKey = "card" | "story" | "facts" | "growth";
export type BrandStackParamList = {
  // `tab` opens the Brand tab on a specific tab (Mila's navigate chips: story / facts).
  BrandOverview: { brandId?: number; brandName?: string; tab?: BrandTabKey } | undefined;
  Signals:       undefined;
  // The deck full-screen, the score, and rates + floor.
  Deck:          undefined;
  Rates:         undefined;
};

const BrandNativeStack = createNativeStackNavigator<BrandStackParamList>();

function BrandStack() {
  return (
    <BrandNativeStack.Navigator screenOptions={{ headerShown: false }}>
      <BrandNativeStack.Screen name="BrandOverview" component={BrandTabScreen} />
      <BrandNativeStack.Screen name="Signals"       component={SignalsScreen} />
      <BrandNativeStack.Screen name="Deck"          component={DeckScreen} />
      {/* Brand › Rates ("Your floor"): the rates door with OPPS_V2 off (prod: RATES_V1 is off there, so Your rates would 404). */}
      <BrandNativeStack.Screen name="Rates"         component={RatesScreen} />
    </BrandNativeStack.Navigator>
  );
}

// ─── Me screens (Concept 0.4) ─────────────────────────────────────────────────
// Me and its screens (What Nomila Knows, My Story, My Intelligence), opened by the Me avatar
// (client/components/me/MeAvatarButton.tsx → client/navigation/meNav.ts). They live INSIDE the Home tab (HomeStack,
// below) and the Me tab (MeTabStack) so the bottom menu stays under them. The param list is shared by both stacks.

export type MeStackParamList = {
  Me:    undefined;
  // What Nomila Knows, optionally opened on one category.
  Knows: { category?: import("../hooks/use-me-knowledge").CategoryKey } | undefined;
  // One brand from Knows › Brands & business as a deck + letter (the density pass); `key` is the brand group's key.
  KnowsBrand: { key: string };
  // My Story (S1): how Nomila understands her, composed from GET /me/story.
  Story: undefined;
  // My Intelligence, all eight areas, one area.
  Intelligence:      undefined;
  IntelligenceAreas: undefined;
  IntelligenceArea:  { key: import("../hooks/use-me-intelligence").MarketabilityDimension };
  // "Your platforms, measured": what her connected accounts report, as measured, one card per platform.
  Platforms:         undefined;
  // My Picks (Her picks, docs/design/shop-her-picks.md): her product shelf. The door exists only with SHOP_V1.
  Picks:             undefined;
  // Her public card (EXPO_PUBLIC_PUBLIC_CARD; design-public-card-v3 §3 her side): review + publish, the visitor's
  // preview, and its settings (doors, link, M.I.A., search, offline). Opened from PublicCardSection at the top of Me.
  PublicCardReview:   undefined;
  PublicCardPreview:  undefined;
  PublicCardSettings: undefined;
  // "Chats on your card" (public Mila mode, PR 5): visitors' chats with Mila on her public card. Opened from Me's
  // public card area with meNav.openCardChats; the server routes exist only with PUBLIC_CARD.
  CardChats:         undefined;
  // AGENT_V3 Me: her public page full screen, her own view (the mini's expand; `edit` opens it in Edit mode), and What
  // Nomila knows on the agent memory (GET /me/facts). Opened only from the agent Me (screens/me/MeAgentScreen).
  PublicPage:        { edit?: boolean } | undefined;
  KnowsFacts:        undefined;
  // fix/existing-users-skip-onboarding: the "Meet Mila" entry — an existing athlete asking, on request, for the
  // agent onboarding conversation she never had. Opened only from a door she taps (Me); never auto-shown.
  MeetMila:          undefined;
  // "Your rates" — Mila's suggested ranges, her private minimums, her public booking prices (D9). Registered always;
  // every door opens it only with OPPS_V2 on (meNav.openRates), else Brand › Rates ("Your floor").
  YourRates:         undefined;
};


// ─── Opportunities stack ──────────────────────────────────────────────────────

// Full-screen fallback for a Deal Detail render crash — recoverable (back to the
// list) and it surfaces the actual error so a real bug never white-screens silently.
function DealDetailErrorFallback({ error, onBack }: { error: Error | null; onBack: () => void }) {
  return (
    <View style={dealErrStyles.wrap}>
      <Feather name="alert-triangle" size={26} color={Colors.light.textMuted} />
      <Text style={dealErrStyles.title}>Couldn't open this deal</Text>
      <Text style={dealErrStyles.body}>
        Something went wrong rendering the deal detail. Your deals are safe — head back
        and try again.
      </Text>
      {error?.message ? (
        <Text style={dealErrStyles.detail} numberOfLines={4}>{error.message}</Text>
      ) : null}
      <Pressable style={dealErrStyles.btn} onPress={onBack} hitSlop={8}>
        <Feather name="chevron-left" size={16} color={Colors.light.text} />
        <Text style={dealErrStyles.btnText}>Back to opportunities</Text>
      </Pressable>
    </View>
  );
}

const dealErrStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing["3xl"],
    backgroundColor: Colors.light.backgroundRoot,
  },
  title: { fontFamily: Fonts.headingSemiBold, fontSize: 17, color: Colors.light.text, textAlign: "center" },
  body: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, textAlign: "center", lineHeight: 19 },
  detail: {
    fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textSecondary,
    textAlign: "center", opacity: 0.8, marginTop: Spacing.xs,
  },
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: Spacing.sm,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm,
  },
  btnText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.text },
});

export type OpportunitiesStackParamList = {
  OpportunitiesList: undefined;
  Thread: { threadId: string; brandName: string };
  DealDetail: DealDetailParams;
  /** Opportunities PR 4: a card's detail (brand deck + Nomila's letter), behind EXPO_PUBLIC_OPPS_BOARD. */
  OpportunityDetail: { opportunityId: string };
  /** App layout B: her money (payouts, holds, refunds, payout account), pushed from the money strip. */
  Financials: undefined;
  /** OPPS_V2: the header's search — All deals or All bookings (Active · Done · Closed, type chips, filed under Closed). */
  AllDeals: { mode?: "deals" | "bookings"; tab?: "active" | "done" | "closed"; notADeal?: boolean } | undefined;
} & BookingsStackParamList;   // Bookings v2 (EXPO_PUBLIC_BOOKINGS): a section of Opportunities (app layout B)

const OpStack = createNativeStackNavigator<OpportunitiesStackParamList>();

// The shell's top bar above the tab's root screen; the screen itself is unchanged (its own title row stays).
const OpportunitiesListShell = withTopBar(OpportunitiesScreen);

// Financials takes an optional `now` (tests); the route renders it with none.
const FinancialsRoute = () => <FinancialsScreen />;

function OpportunitiesStack() {
  return (
    <OpStack.Navigator screenOptions={{ headerShown: false }}>
      <OpStack.Screen name="OpportunitiesList" component={OpportunitiesListShell} />
      {BOOKINGS ? bookingStackScreens(OpStack) : null}
      <OpStack.Screen
        name="Thread"
        component={({ route, navigation }: any) => (
          <ThreadScreen
            threadId={route.params.threadId}
            brandName={route.params.brandName}
            onBack={() => navigation.goBack()}
          />
        )}
      />
      <OpStack.Screen
        name="OpportunityDetail"
        component={({ route, navigation }: any) => (
          <OpportunityDetailScreen
            opportunityId={route.params.opportunityId}
            onBack={() => navigation.goBack()}
            onOpenThread={(threadId: string, brandName: string) => navigation.navigate("Thread", { threadId, brandName })}
          />
        )}
      />
      <OpStack.Screen
        name="DealDetail"
        component={({ route, navigation }: any) => (
          <ErrorBoundary
            renderError={(err) => (
              <DealDetailErrorFallback error={err} onBack={() => navigation.goBack()} />
            )}
          >
            {/* With the board on, a deal opens its brand's ONE detail (OpportunityDetail); see DealDetailRoute. */}
            <DealDetailRoute dealId={route.params?.dealId} board={OPPS_BOARD}>
              <DealDetailContainer
                dealId={route.params?.dealId}
                section={route.params?.section}
              />
            </DealDetailRoute>
          </ErrorBoundary>
        )}
      />
      <OpStack.Screen name="Financials" component={FinancialsRoute} />
      {OPPS_V2 ? <OpStack.Screen name="AllDeals" component={AllDealsScreen} /> : null}
    </OpStack.Navigator>
  );
}

// ─── Studio stack ─────────────────────────────────────────────────────────────
// The creator workspace: a hub home (StudioScreen), the searchable Pitches list, and
// per-pitch detail. Pitches are keyed by brandId — see docs/studio-pitches-plan.md.

export type StudioStackParamList = {
  /**
   * `seed` is a board the Agent screen hands over — in memory, never stored — with `tab: "board"`
   * to land on it. The Board applies a seed once, by its nonce, and clears it. Both optional, so
   * every existing `navigate("StudioHome")` (the agent's navigate tool, deep links) is unchanged.
   */
  StudioHome:   { tab?: "board"; seed?: BoardSeed } | undefined;
  PitchesList:  { initialFilter?: "all" | PitchStatus | "stale" } | undefined;
  PitchDetail:  { brandId: number; brandName?: string };
  /** A post action's post kit (AGENT_V3 + AGENT_POST_KITS): design "Moments → post kits" §12. */
  PostKit:      { id: string };
  /** The library's "post_kit" filter, as a vertical scroll (design §12 v2): the same data, one card at a time. */
  StudioForYou: { startId?: string } | undefined;
  /** The brand book (BRAND_BOOK_V1), opened from Studio's Decks & pages. */
  BrandBook:    undefined;
  MediaLibrary: undefined;
  MediaDetail:  { assetId: string };
  /**
   * "Review my camera roll" — native only; the library hides its entry on web. With EXPO_PUBLIC_CAMERA_ROLL_INTAKE,
   * "Add from camera roll": `ask` is a targeted review's filter (shared/cameraRollIntake.ts encodeCameraRollAsk — what
   * to look at, how far back, and the post it is for).
   */
  CameraRollReview: { ask?: string; prepared?: boolean } | undefined;
  // Studio Content Engine. Only reachable while STUDIO_ENABLED is on — the route is always
  // registered so the stack's types stay static, but nothing navigates to it when the flag is off.
  // See client/lib/flags.ts.
  // The intent picker sets these; the workspace reads them. `intent` is the ENGINE + MODE fork and
  // is required — the workspace must never have to guess whether it is holding an edit or a
  // generate. `deliverable` is the FORMAT and is a parameter, not a second screen.
  CampaignWorkspace: {
    intent: StudioIntent;
    deliverable?: StudioDeliverable;
    brandId?: number;
    brandName?: string;
    sourceAssetId?: string;
  };

  // The new Studio surface. Reachable only while STUDIO_ENABLED is on — StudioHome renders the old
  // screen otherwise, and there is no path to these from it.
  /**
   * `sessionId` is WHICH thread, and it is still the React key. See CreateAnythingRoute: the screen
   * carries an unsent tray in local state, and RN7's `navigate` pops back to an existing route rather
   * than mounting a second one, so without a new key "New thread" handed you the old thread's
   * attachments. Changing it remounts; omitting it keeps whatever is there. With
   * EXPO_PUBLIC_STUDIO_SESSIONS on it is also the thread's id (`studio_sessions.id`), and omitting it
   * resumes her latest open thread (plan v2 §4, D2a).
   */
  StudioCreateAnything: { sessionId?: string } | undefined;
  StudioThreads: undefined;
  /** The Agent tab (STUDIO_AGENT): she says what she wants, and it plans a board. */
  // The manual Board's agent door carries the board's stored plan (PR 6, 6d): the Agent screen opens it
  // (no planner) and re-plans as its child, keeping a brand board's brief, product, deal and objective.
  StudioAgent:
    | { fromPlanId?: string; fromBrief?: BriefHandoff }
    | undefined;
  StudioBrandPost: undefined;
  /** The Carousel Create screen (PR 9, Lane 4): the chooser's Carousel chip, or the popover's ad chip with ref 1. */
  StudioCarouselCreate:
    | {
        refs?: string[];
        /** Thumbnails for `refs`, by asset id, when the door that opened this screen had them. */
        thumbs?: Record<string, string>;
        brand?: string;
        campaign?: { product?: string; story?: string; goal?: string };
        briefLines?: string[];
        batchId?: string;
      }
    | undefined;
  // The spend boundary. Everything the plan needs travels in params, so the brand flow and the
  // personal flow both land here with their own material and no special case.
  StudioMakeIt: {
    title: string;
    line: string;
    format: StudioFormat;
    attachments: Attachment[];
    brandName?: string | null;
    /** The brand as the SERVER knows it. Decides the objective and tailors the brief. */
    brandId?: number | null;
    /** Her own words, passed through to the model verbatim. */
    direction?: string;
    /**
     * WHICH attachment is the frame being edited — her mark, carried rather than re-derived.
     *
     * It travels because the alternative is Make it working it out again from the tray, and
     * "work it out from the tray" is precisely the bug: the frame used to be whichever
     * `source-frame` sat first in the array, so attaching material before her photograph made the
     * material the frame (sweep 7.2). See `frameFor` in lib/studio-contract.
     */
    frameAssetId?: string | null;
    /**
     * The preview Create anything's send already checked for exactly this job (catch-all through the
     * interpreter, C2): shown rather than asked again. In memory only, like every param here.
     */
    seed?: PreviewSeed;
    /**
     * Reserved. Nothing sets it: the objective is derived from `brandId` rather than asked, because
     * no screen collects it and the server requires the field. Here so a picker can land later
     * without moving the route.
     */
    objective?: StudioObjective;
  };
  StudioMade: {
    title: string;
    format: StudioFormat;
    heroUri: string | null;
    brandName?: string | null;
    /** The asset that was actually made — what clearance and the shelf are keyed on. */
    assetId?: string | null;
  };
};

const StudioNativeStack = createNativeStackNavigator<StudioStackParamList>();

const StudioHome      = STUDIO_ENABLED ? StudioHomeScreen : StudioScreen;
// The shell's top bar above the tab's root screen; the screen itself is unchanged (its own masthead stays).
const StudioHomeShell = withTopBar(StudioHome);
// AGENT_V3: the Studio tab's root is the library (everything made, with status, versions and goals). Same route name.
const StudioLibraryShell = withTopBar(StudioLibraryScreen);
// HOME_V3: the library becomes Studio v3 — shelves, the grid, Play and Create (lib/studioV3Logic). Same route name.
// Studio v3 draws its own top: the feed is full-bleed under the status bar; Browse puts the shell TopBar above its shelves.
const StudioV3Shell = StudioV3Screen;

function StudioStack() {
  return (
    <StudioNativeStack.Navigator screenOptions={{ headerShown: false }}>
      {/* THE SEAM. The ROUTE name never changes — the agent's navigate tool, deep links and
          DealDetailContainer all address "StudioHome" and must keep working either way. Only what
          renders behind it moves. STUDIO_ENABLED is a BUILD-time EXPO_PUBLIC_* var and is unset in
          every environment today, so this is the old screen everywhere until someone sets it. */}
      <StudioNativeStack.Screen
        name="StudioHome"
        component={AGENT_V3 ? (HOME_V3 ? StudioV3Shell : StudioLibraryShell) : StudioHomeShell}
      />
      <StudioNativeStack.Screen name="PitchesList"  component={PitchesListScreen} />
      <StudioNativeStack.Screen name="PitchDetail"  component={PitchDetailScreen} />
      <StudioNativeStack.Screen name="PostKit"      component={PostKitScreen} />
      <StudioNativeStack.Screen name="StudioForYou" component={StudioForYouScreen} />
      <StudioNativeStack.Screen name="MediaLibrary" component={MediaLibraryScreen} />
      <StudioNativeStack.Screen name="MediaDetail"  component={MediaDetailScreen} />
      <StudioNativeStack.Screen name="CameraRollReview" component={CameraRollReviewScreen} />
      <StudioNativeStack.Screen name="CampaignWorkspace" component={CampaignWorkspaceScreen} />
      <StudioNativeStack.Screen name="StudioCreateAnything" component={CreateAnythingRoute} />
      <StudioNativeStack.Screen name="StudioThreads"        component={ThreadsScreen} />
      <StudioNativeStack.Screen name="StudioAgent"          component={AgentScreen} />
      <StudioNativeStack.Screen name="StudioCarouselCreate" component={CarouselCreateScreen} />
      <StudioNativeStack.Screen name="StudioMakeIt"         component={MakeItRoute} />
      <StudioNativeStack.Screen name="StudioMade"           component={MadeItScreen} />
      <StudioNativeStack.Screen name="StudioBrandPost"      component={BrandPostScreen} />
      <StudioNativeStack.Screen name="BrandBook"            component={BrandBookScreen} />
    </StudioNativeStack.Navigator>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
// One layout (client/navigation/shellTabs.ts; the Classic layout switch is gone since stage 1, owner 25 Oct 2026):
//   Home · Strategy · Mila · Opportunities · Studio — a shared top bar (NOMILA · gear → Settings · avatar → Me) on each;
//   with HOME_V3, Home · Business · Mila · Studio · Me. Me, its screens and Settings sit inside the tabs (the menu stays
//   under them); the Brand stack is pushed above the tabs on the root stack.

export type { MainTabParamList } from "./shellTabs";

const Tab = createBottomTabNavigator<MainTabParamList>();

/** The root stack: the tabs, and above them the Brand stack. */
export type RootStackParamList = {
  Tabs:    NavigatorScreenParams<MainTabParamList> | undefined;
  Brand:   NavigatorScreenParams<BrandStackParamList> | undefined;
  // Bookings v2 (EXPO_PUBLIC_BOOKINGS): her side of a session, above the tabs — the call is full
  // screen, and the after-session screen follows it. Opened through navigation/bookingsNav.ts (sessionDoors).
  BookingSession: { bookingId: string };
  BookingAfter:   { bookingId: string };
};

const RootNativeStack = createNativeStackNavigator<RootStackParamList>();

// ─── Home stack (the shell) ───────────────────────────────────────────────────
// The Home tab: the daily briefing (`Landing`, HomeScreen, no back button), and above it — still inside the tab, so the
// bottom menu stays and the tabs keep working — Me from the avatar, Me's own screens, and Settings from the gear. Each
// pushed screen draws its own back control at the top left (MeHero / StackHeader).

export type HomeStackParamList = MeStackParamList & {
  Landing:  undefined;
  Settings: undefined;
  DeleteAccount: undefined;
};

const HomeNativeStack = createNativeStackNavigator<HomeStackParamList>();
// App layout B: Home is its own screen (the daily briefing) and Me its own (the doors); they share no rows.
// HOME_V3: the landing is Home v3 (circles · Mila's line · one admin row · one big card); off, today's briefing.
const HomeLanding = () => (HOME_V3 ? <HomeV3Screen /> : <HomeScreen />);

function HomeStack() {
  return (
    <HomeNativeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeNativeStack.Screen name="Landing"           component={HomeLanding} />
      <HomeNativeStack.Screen name="Me"                component={MeScreen} />
      <HomeNativeStack.Screen name="Knows"             component={KnowsScreen} />
      <HomeNativeStack.Screen name="KnowsBrand"        component={BrandScreen} />
      <HomeNativeStack.Screen name="Story"             component={MyStoryScreen} />
      <HomeNativeStack.Screen name="Intelligence"      component={MyIntelligenceScreen} />
      <HomeNativeStack.Screen name="IntelligenceAreas" component={IntelligenceAreasScreen} />
      <HomeNativeStack.Screen name="IntelligenceArea"  component={IntelligenceAreaScreen} />
      <HomeNativeStack.Screen name="Platforms"         component={PlatformsMeasuredScreen} />
      <HomeNativeStack.Screen name="Picks"             component={MyPicksScreen} />
      <HomeNativeStack.Screen name="PublicCardReview"   component={PublicCardReviewScreen} />
      <HomeNativeStack.Screen name="PublicCardPreview"  component={PublicCardPreviewScreen} />
      <HomeNativeStack.Screen name="PublicCardSettings" component={PublicCardSettingsScreen} />
      <HomeNativeStack.Screen name="CardChats"         component={CardChatsScreen} />
      <HomeNativeStack.Screen name="PublicPage"        component={PublicPageScreen} />
      <HomeNativeStack.Screen name="KnowsFacts"        component={KnowsFactsScreen} />
      <HomeNativeStack.Screen name="MeetMila"          component={MeetMilaScreen} />
      <HomeNativeStack.Screen name="Settings"          component={SettingsScreen} />
      <HomeNativeStack.Screen name="DeleteAccount"     component={DeleteAccountScreen} />
      <HomeNativeStack.Screen name="YourRates" component={YourRatesScreen} />
    </HomeNativeStack.Navigator>
  );
}

// ─── Me tab stack (HOME_V3 only) ──────────────────────────────────────────────
// The bar's fifth tab: Me v3 (her photo, the M.I.A. card, six tiles) and, inside the tab so the bar stays, everything a
// tile opens — Your plan (Goals, moved here), the scouting / brand screen (the Brand book tile's placeholder: today's Me,
// which is the scouting report on the agent memory), My Intelligence, What Nomila knows, her page, rates, Settings.
// Registered only while HOME_V3 is on; with it off nothing here exists.

export type MeTabParamList = MeStackParamList & {
  MeHome:   undefined;
  Plan:     undefined;
  Scouting: undefined;
  Settings: undefined;
  DeleteAccount: undefined;
  BrandBook: undefined;
};

const MeTabNativeStack = createNativeStackNavigator<MeTabParamList>();

function MeTabStack() {
  return (
    <MeTabNativeStack.Navigator screenOptions={{ headerShown: false }}>
      <MeTabNativeStack.Screen name="MeHome"            component={MeV3Screen} />
      <MeTabNativeStack.Screen name="Plan"              component={YourPlanScreen} />
      <MeTabNativeStack.Screen name="Scouting"          component={MeScreen} />
      <MeTabNativeStack.Screen name="BrandBook"         component={BrandBookScreen} />
      <MeTabNativeStack.Screen name="Knows"             component={KnowsScreen} />
      <MeTabNativeStack.Screen name="KnowsBrand"        component={BrandScreen} />
      <MeTabNativeStack.Screen name="Story"             component={MyStoryScreen} />
      <MeTabNativeStack.Screen name="Intelligence"      component={MyIntelligenceScreen} />
      <MeTabNativeStack.Screen name="IntelligenceAreas" component={IntelligenceAreasScreen} />
      <MeTabNativeStack.Screen name="IntelligenceArea"  component={IntelligenceAreaScreen} />
      <MeTabNativeStack.Screen name="Platforms"         component={PlatformsMeasuredScreen} />
      <MeTabNativeStack.Screen name="Picks"             component={MyPicksScreen} />
      <MeTabNativeStack.Screen name="PublicCardReview"   component={PublicCardReviewScreen} />
      <MeTabNativeStack.Screen name="PublicCardPreview"  component={PublicCardPreviewScreen} />
      <MeTabNativeStack.Screen name="PublicCardSettings" component={PublicCardSettingsScreen} />
      <MeTabNativeStack.Screen name="CardChats"         component={CardChatsScreen} />
      <MeTabNativeStack.Screen name="PublicPage"        component={PublicPageScreen} />
      <MeTabNativeStack.Screen name="KnowsFacts"        component={KnowsFactsScreen} />
      <MeTabNativeStack.Screen name="MeetMila"          component={MeetMilaScreen} />
      <MeTabNativeStack.Screen name="Settings"          component={SettingsScreen} />
      <MeTabNativeStack.Screen name="DeleteAccount"     component={DeleteAccountScreen} />
      <MeTabNativeStack.Screen name="YourRates" component={YourRatesScreen} />
      {/* Your bookings is set up in Me (owner, 20 Oct 2026): the booking screens on Me's stack too, so the bar stays. */}
      {BOOKINGS ? bookingStackScreens(MeTabNativeStack) : null}
    </MeTabNativeStack.Navigator>
  );
}

// ─── Strategy stack (the shell) ───────────────────────────────────────────────
// The Strategy route's one screen is Goals (goal · game plan · this week's actions, with the shell's top bar above it and
// no back arrow): the chosen design while the server's AGENT_PLAN serves GET /me/agent/goals, today's GoalsScreen while
// that route is dark (404). The legacy Goals · Plan · Results screens, which read the retired /me/objectives and
// /me/recommendations routes, were removed on 3 Nov 2026.

const StrategyNativeStack = createNativeStackNavigator<StrategyStackParamList>();
const GoalsRootShell      = withTopBar(GoalsTab);

function StrategyStack() {
  return (
    <StrategyNativeStack.Navigator screenOptions={{ headerShown: false }}>
      <StrategyNativeStack.Screen name="StrategyRoot"   component={GoalsRootShell} />
    </StrategyNativeStack.Navigator>
  );
}

// ─── Navigator ────────────────────────────────────────────────────────────────

export function MainTabNavigator({ initialTabName, initialMilaPrompt }: { initialTabName?: keyof MainTabParamList; initialMilaPrompt?: string } = {}) {
  return <ShellNavigator initialTabName={initialTabName} initialMilaPrompt={initialMilaPrompt} />;
}

// `initialTabName` lets the launcher open on a chosen tab — the first entry's "deals"
// door lands on Opportunities. Absent → the web ?connected= rule, else the shell's first tab.
function ShellNavigator({ initialTabName, initialMilaPrompt }: { initialTabName?: keyof MainTabParamList; initialMilaPrompt?: string }) {
  // EXPO_PUBLIC_CAMERA_ROLL_INTAKE: the app-open check — only on photo access she already gave, only while the app is
  // open; it prepares a review Mila can offer in one tap (client/lib/cameraRollPrepared.ts). Inert with the flag off.
  const { athlete: signedIn } = useAuth();
  useCameraRollPrepare(signedIn?.id);
  // The screen Mila was opened from, captured at launch (see the tabBar below).
  const [launchContext, setLaunchContext] = useState<MilaContext | undefined>(
    undefined,
  );
  // A draft for the composer when a screen opens Mila (a record row's "Tell Mila"). Not sent.
  const [launchDraft, setLaunchDraft] = useState<string | undefined>(undefined);
  // A saved chat to open in Mila (a suggestion's push or Home row). Cleared once opened.
  const [launchConversation, setLaunchConversation] = useState<string | undefined>(undefined);
  // A message Mila started, to open that chat ON (a push that names it). Cleared with the conversation.
  const [launchMessage, setLaunchMessage] = useState<string | undefined>(undefined);
  // AGENT_V3: a message Mila is asked once, from the athlete's own "Start" tap (a capability, a goal's action). Cleared
  // as soon as the chat has sent it, so coming back to the tab never sends it again.
  const [launchPrompt, setLaunchPrompt] = useState<string | undefined>(AGENT_V3 ? initialMilaPrompt : undefined);
  // Latest tab navigation object, captured from the tabBar render — how a launch from any screen (and the chat's
  // nav-chips) reach the tab navigator. Read only in handlers, never during render.
  const navRef = useRef<BottomTabBarProps["navigation"] | null>(null);

  /** Leave whatever is open above the tabs (the Brand stack) so the tabs are on top. */
  const popToTabs = useCallback((nav: BottomTabBarProps["navigation"]) => {
    const root: any = nav.getParent();
    const routes = root?.getState?.()?.routes ?? [];
    const top = routes[routes.length - 1]?.name;
    if (root && top && top !== "Tabs" && typeof root.popTo === "function") root.popTo("Tabs");
  }, []);

  /** Open Ask Mila — the centre tab — from wherever she is. */
  const openMilaTab = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    popToTabs(nav);
    nav.navigate(MILA_TAB);
  }, [popToTabs]);

  // "Ask Mila about…" from any screen (Home chips, a record row's "Tell Mila"): its context and draft, then the tab.
  useEffect(() => subscribeMilaLaunch(({ context, draft, prompt, conversationId }) => {
    setLaunchContext(context);
    setLaunchDraft(draft);
    setLaunchPrompt(AGENT_V3 ? prompt : undefined);
    setLaunchConversation(conversationId);
    openMilaTab();
  }), [openMilaTab]);

  // Her phone's notifications (lib/push): set up once she is signed in, and register this phone only if she already
  // allowed notifications (the ask comes later, after her first plan or deal, through PushAskSheet first — never on a
  // cold launch). Re-registered on every profile switch, so the phone follows the profile in use (the server moves the
  // token). A tap opens the screen the notification names.
  const pushAthleteId = useAuth().athlete?.id ?? null;
  useEffect(() => { if (pushAthleteId) void setUpPush().then(() => registerPushIfAllowed()); }, [pushAthleteId]);
  useEffect(() => onPushTap((t) => {
    // A Mila suggestion names the chat its card is in: open that chat.
    // A message Mila started names that message too: the chat opens on it (cold start included: lib/push holds the tap).
    if (t.screen === "mila") { if (t.id) { setLaunchConversation(t.id); setLaunchMessage(t.messageId); } openMilaTab(); return; }
    const nav = navRef.current;
    if (!nav) return;
    popToTabs(nav);
    openAgentTarget(nav, t);
  }), [openMilaTab, popToTabs]);

  // Map a read-only nav-chip target to a navigation call. Targets are semantic (Mila never knows RN
  // route names); shellTabs.navTargetRoute says where each lands in the live shell. Tab-home targets
  // specify their nested screen explicitly so they land there deterministically even when a deeper
  // chip (Signals / Pitches / Media) previously left that stack elsewhere.
  const handleNavigate = useCallback((target: MilaNavTarget) => {
    const nav = navRef.current;
    if (!nav) return;
    const route = navTargetRoute(target);
    if (route.kind === "none") return;
    // The Tabs screen's navigation on the root stack — where the Brand stack lives.
    const root: any = nav.getParent();
    if (route.kind === "root") {
      (root ?? nav).navigate(route.screen, route.nested);
      return;
    }
    // A tab destination: if the Brand stack is open above the tabs, close it first.
    popToTabs(nav);
    nav.navigate(route.tab, route.screen ? { screen: route.screen, params: route.params } : undefined);
  }, [popToTabs]);

  // Web: an OAuth round-trip lands back with ?connected= and should open Settings. Decided once, at mount.
  const [wantsSettings] = useState<boolean>(() => {
    if (Platform.OS !== "web") return false;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.has("connected") || params.has("connected_error");
    } catch { return false; }
  });
  // Lazy initializer runs synchronously before first render so initialRouteName is correct on mount.
  const [initialTab] = useState<keyof MainTabParamList>(() => {
    if (initialTabName) return initialTabName;
    return INITIAL_TAB;
  });

  const settingsOpened = useRef(false);
  useEffect(() => {
    if (!wantsSettings || settingsOpened.current) return;
    settingsOpened.current = true;
    // Settings is not a tab: open it inside Home once the navigator is up.
    navRef.current?.navigate("Home", { screen: "Settings" });
    // With web URLs on (EXPO_PUBLIC_WEB_V2) the navigator owns the address bar and has already written /settings over
    // the ?connected= return; clearing it here would desync the browser history it keeps. Off (today): cleared to "/".
    if (!webV2On(Platform.OS)) { try { window.history.replaceState(null, "", "/"); } catch {} }
  }, [wantsSettings]);

  const milaTab = (
    <MilaTabScreen
      context={launchContext}
      draft={launchDraft}
      prompt={launchPrompt}
      onPromptSent={() => setLaunchPrompt(undefined)}
      onNavigate={handleNavigate}
      conversationId={launchConversation}
      messageId={launchMessage}
      onConversationOpened={() => { setLaunchConversation(undefined); setLaunchMessage(undefined); }}
    />
  );

  const tabs = (
      <Tab.Navigator
        tabBar={(props) => {
          // Capture the live navigation for nav-chips; re-runs on every tab change
          // so props.state is current when the center button is pressed.
          navRef.current = props.navigation;

          // Ask Mila is the centre tab's own screen (client/navigation/milaTab.tsx), so this bar stays under the chat.
          return (
            <ShellTabBar
              state={props.state}
              navigation={props.navigation}
              onLaunch={(context) => {
                setLaunchContext(context);
                setLaunchDraft(undefined);
              }}
            />
          );
        }}
        screenOptions={{ headerShown: false }}
        initialRouteName={initialTab}
      >
        {/* In shellRoutesFor's order: the five with HOME_V3 off; with it on the bar's five
            (Home · Opportunities · Mila · Studio · Me) and then Strategy, registered but on no bar button. */}
        {shellRoutesFor(HOME_V3).map((name) => {
          switch (name) {
            case "Home":          return <Tab.Screen key={name} name="Home"          component={HomeStack} />;
            case "Strategy":      return <Tab.Screen key={name} name="Strategy"      component={StrategyStack} />;
            case "SearchAsk":     return <Tab.Screen key={name} name={MILA_TAB}>{() => milaTab}</Tab.Screen>;
            case "Opportunities": return <Tab.Screen key={name} name="Opportunities" component={OpportunitiesStack} />;
            case "Studio":        return <Tab.Screen key={name} name="Studio"        component={StudioStack} />;
            case "Me":            return <Tab.Screen key={name} name="Me"            component={MeTabStack} />;
            default:              return null;
          }
        })}
      </Tab.Navigator>
  );

  return (
    <>
      <RootNativeStack.Navigator screenOptions={{ headerShown: false }}>
        <RootNativeStack.Screen name="Tabs">{() => tabs}</RootNativeStack.Screen>
        <RootNativeStack.Screen name="Brand"   component={BrandStack} />
        {BOOKINGS ? <RootNativeStack.Screen name="BookingSession" component={BookingSessionScreen} options={{ gestureEnabled: false }} /> : null}
        {BOOKINGS ? <RootNativeStack.Screen name="BookingAfter"   component={BookingAfterSessionScreen} /> : null}
      </RootNativeStack.Navigator>
      <PushAskSheet />

    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
});
