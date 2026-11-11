/**
 * StudioHomeScreen — the Studio tab, flag-ON.
 *
 * ─── HOW THIS REPLACES THE OLD SCREEN ──────────────────────────────────────────────────────────
 * It does not. `screens/StudioScreen.tsx` is untouched and still renders wherever STUDIO_ENABLED is
 * off, which today is every environment (the flag is unset in .env, eas.json, app.json and
 * cloud-run-v2.yaml). MainTabNavigator picks between the two for the `StudioHome` ROUTE, so the
 * route name survives and the agent's navigate tool, deep links and DealDetailContainer's jump to
 * PitchDetail all keep working either way.
 *
 * ─── TWO SCREENS, NOT ONE ──────────────────────────────────────────────────────────────────────
 * Now is what is happening: the in-progress card, what is owed, what is worth making. Made is the
 * library of everything finished, by type. They are tabs rather than one scroll because the second
 * one is an archive — you go to it deliberately, and putting it under the first buried it.
 *
 * The count on Now is deadlines and moments, not a ledger of everything. Made carries no badge: an
 * archive that nags is a worse archive.
 *
 * ─── WHAT IS NOT HERE YET ──────────────────────────────────────────────────────────────────────
 * The Now feed, and the brand/personal flows. Made, Create anything and Edit a photo are wired.
 * Each door lands on the existing surface where one exists (pitches, and the mask workspace for
 * an edit) and is inert where it does not, rather than navigating somewhere half-built.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useNavigationState, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { useAuth } from "../../lib/auth-context";
import { HapticPressable } from "../../components/HapticPressable";
import { CreatePitchFlow } from "../../components/pitch/CreatePitchFlow";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { CreateMenuSheet, type CreateDoor } from "./CreateMenuSheet";
import { MadeShelf } from "./MadeShelf";
import { NowFeed } from "./NowFeed";
import { StoryboardTab } from "./StoryboardTab";
import { STUDIO_AGENT, STUDIO_IDENTITY_PACK } from "../../lib/flags";
import { IdentityPackSheet } from "../../components/studio/IdentityPackSheet";
import { VideoTab } from "./VideoTab";

/**
 * ⚠️ "video" IS PROVISIONAL (video V4). An isolation surface for watching the detached video
 * pipeline — queued → running → succeeded — without touching Now or Made. The clips' eventual home
 * is the content surface: MadeShelf and ThreadCards already branch on a non-IMAGE asset and
 * `listStudioContent` already returns VIDEO rows. Migrating there, and deleting this tab, is a
 * V7-era task. Nothing else may come to depend on it.
 */
/**
 * ⚠️ "board" IS THE STORYBOARD (video V10). Rows of stills, a line and a shot kind each; every row
 * becomes a clip and the clips land back on the row that asked for one. It owns no transitions —
 * Cut / Fade / Bridge already exist per join on the timeline — and no price table.
 */
type StudioTab = "now" | "made" | "video" | "board";

export function StudioHomeScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { athlete } = useAuth();
  const [tab, setTab] = useState<StudioTab>("now");
  // Her likeness pack's door (PR 17) — drawn only in a build with EXPO_PUBLIC_STUDIO_IDENTITY_PACK on.
  const [packOpen, setPackOpen] = useState(false);

  // ─── A PLAN FROM THE AGENT SCREEN ──────────────────────────────────────────────────────────────
  // It arrives in route params (in memory, never stored): land on the Board, and hand it the seed.
  // The Board takes it once, by nonce, and calls back — and the param is cleared so a later visit
  // does not carry it.
  const route = useRoute<RouteProp<StudioStackParamList, "StudioHome">>();
  const seed = route.params?.seed ?? null;
  useEffect(() => {
    if (route.params?.tab === "board") setTab("board");
  }, [route.params?.tab, seed?.nonce]);
  const onSeedHandled = useCallback(() => nav.setParams({ seed: undefined, tab: undefined }), [nav]);
  // The screen directly beneath this one. "Put it on the board" PUSHES this screen above the Agent's
  // (React Navigation 7), so when that is what is beneath, Back to the plan is a pop to a plan she left.
  const beneath = useNavigationState((s) => s.routes[s.index - 1]?.name);

  // ─── "FINE-TUNE IN VIDEO" ──────────────────────────────────────────────────────────────────────
  // The Board's stitched video, handed to the Video tab's timeline. Cleared once it is on it, so
  // coming back to the tab later does not put it there again.
  const [fineTune, setFineTune] = useState<{
    assetId: string;
    /** The Board's words and purpose for the caption suggestion (PR 15, R-5), when it sent them. */
    captions: { feel: string[]; objective: string } | null;
  } | null>(null);
  const onFineTune = useCallback(
    (assetId: string, captions?: { feel: string[]; objective: string }) => {
      setFineTune({ assetId, captions: captions ?? null });
      setTab("video");
    },
    [],
  );
  const onFineTuneTaken = useCallback(() => setFineTune(null), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingPitch, setCreatingPitch] = useState(false);

  /**
   * The edit door is the one that leaves this surface.
   *
   * `CampaignWorkspace` is the older workspace, and it is the ONLY screen in the app that renders
   * the mask editor. It had no door once this sheet replaced the ＋ menu — the picker that used to
   * open it lives inside StudioScreen, which only mounts while STUDIO_ENABLED is OFF, so with the
   * flag on nothing reached it. Every "change this one thing in my photo" therefore fell through to
   * the generate doors, which cannot express an edit, and came back a full re-render.
   *
   * It is passed the intent explicitly rather than letting the workspace guess: the engine + mode
   * fork is the one thing that screen does not let you change, by design (see its header).
   */
  const onPick = (door: CreateDoor) => {
    if (door === "pitch") setCreatingPitch(true);
    else if (door === "anything") nav.navigate("StudioCreateAnything");
    // Personal posts go to Create anything too — one door for her own words (Adi, 23 Sep 2026).
    else if (door === "personal") nav.navigate("StudioCreateAnything");
    else nav.navigate("StudioBrandPost");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.masthead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>CREATOR WORKSPACE</Text>
          <Text style={styles.title}>Studio</Text>
        </View>
        <View style={styles.mastIcons}>
          {STUDIO_IDENTITY_PACK ? (
            <HapticPressable
              style={styles.iconBtn}
              onPress={() => setPackOpen(true)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Your likeness pack"
            >
              <Feather name="user" size={19} color={Colors.light.text} />
            </HapticPressable>
          ) : null}
          <HapticPressable
            style={styles.iconBtn}
            onPress={() => nav.navigate("MediaLibrary")}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Media library"
          >
            <Feather name="image" size={19} color={Colors.light.text} />
          </HapticPressable>
          <HapticPressable
            style={styles.plus}
            onPress={() => setMenuOpen(true)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Make something"
          >
            <Feather name="plus" size={22} color={Colors.light.buttonText} />
          </HapticPressable>
        </View>
      </View>

      <View style={styles.tabs}>
        <Tab label="Now"  count={3} active={tab === "now"}  onPress={() => setTab("now")} />
        <Tab label="Made"           active={tab === "made"} onPress={() => setTab("made")} />
        <Tab label="Video"          active={tab === "video"} onPress={() => setTab("video")} />
        <Tab label="Board"          active={tab === "board"} onPress={() => setTab("board")} />
      </View>

      {tab === "board" ? (
        <StoryboardTab
          onOpenDetail={(assetId) => nav.navigate("MediaDetail", { assetId })}
          // The Agent's door, drawn only in a build with EXPO_PUBLIC_STUDIO_AGENT on. The server's
          // 404 is the real gate; this decides only whether the door exists.
          // A planned board hands its stored plan to the Agent (PR 6, 6d): a brand board's brief, deal,
          // product and objective survive the door. A hand-built board has none and opens a fresh ask.
          onOpenAgent={
            STUDIO_AGENT
              ? ({ fromPlanId }) =>
                  nav.navigate("StudioAgent", fromPlanId ? { fromPlanId } : undefined)
              : undefined
          }
          seed={seed}
          onSeedHandled={onSeedHandled}
          onFineTune={onFineTune}
          onBackToPlan={beneath === "StudioAgent" ? () => nav.goBack() : undefined}
        />
      ) : tab === "video" ? (
        <VideoTab
          onOpenDetail={(assetId) => nav.navigate("MediaDetail", { assetId })}
          initialClipId={fineTune?.assetId ?? null}
          onInitialClipTaken={onFineTuneTaken}
          captionFeel={fineTune?.captions ?? null}
        />
      ) : tab === "made" ? (
        <MadeShelf onOpenItem={(assetId) => nav.navigate("MediaDetail", { assetId })} />
      ) : (
        <NowFeed
          onOpenItem={(assetId) => nav.navigate("MediaDetail", { assetId })}
          onMakeFor={() => nav.navigate("StudioBrandPost")}
          onStart={() => nav.navigate("StudioBrandPost")}
          onOpenCarousel={(batchId) => nav.navigate("StudioCarouselCreate", { batchId })}
        />
      )}

      <IdentityPackSheet visible={packOpen} onClose={() => setPackOpen(false)} />
      <CreateMenuSheet visible={menuOpen} onClose={() => setMenuOpen(false)} onPick={onPick} />

      <CreatePitchFlow
        visible={creatingPitch}
        athleteId={athlete?.id}
        onClose={() => setCreatingPitch(false)}
        onCreated={(brandId: number, brandName: string) => {
          setCreatingPitch(false);
          nav.navigate("PitchDetail", { brandId, brandName });
        }}
      />
    </SafeAreaView>
  );
}

/** An underlined tab. The count is on Now because Now is the thing with deadlines in it. */
function Tab({
  label, count, active, onPress,
}: {
  label: string; count?: number; active: boolean; onPress: () => void;
}) {
  return (
    <HapticPressable
      style={styles.tab}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count ? `${label}, ${count} items` : label}
    >
      <View style={styles.tabRow}>
        <Text style={[styles.tabLabel, active && styles.tabLabelOn]}>{label}</Text>
        {count ? (
          <View style={styles.badge}><Text style={styles.badgeTxt}>{count}</Text></View>
        ) : null}
      </View>
      <View style={[styles.underline, active && styles.underlineOn]} />
    </HapticPressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },

  masthead: {
    flexDirection: "row", alignItems: "flex-start",
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: 12,
  },
  eyebrow: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, letterSpacing: 1.6,
    color: Colors.light.textMuted, fontWeight: "700",
  },
  title: {
    fontFamily: Fonts.display, fontSize: 30, fontWeight: "800",
    letterSpacing: -0.6, color: Colors.light.text, marginTop: 2,
  },
  mastIcons: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  iconBtn: {
    width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  plus: {
    width: 42, height: 42, borderRadius: 15, backgroundColor: Colors.light.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: Colors.light.primary, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },

  tabs: {
    flexDirection: "row", gap: Spacing.xl,
    paddingHorizontal: Spacing.xl, paddingTop: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.light.border,
  },
  tab: { paddingBottom: 9 },
  tabRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tabLabel: {
    fontFamily: Fonts.bodySemiBold, fontSize: 14.5, fontWeight: "600",
    color: Colors.light.textMuted,
  },
  tabLabelOn: { fontFamily: Fonts.bodyBold, fontWeight: "800", color: Colors.light.text },
  badge: {
    minWidth: 17, height: 17, borderRadius: 99, paddingHorizontal: 5,
    backgroundColor: Colors.light.primary, alignItems: "center", justifyContent: "center",
  },
  badgeTxt: {
    fontFamily: Fonts.bodyBold, fontSize: 10, fontWeight: "800",
    color: Colors.light.buttonText,
  },
  underline: {
    position: "absolute", left: 0, right: 0, bottom: -1, height: 2,
    backgroundColor: "transparent",
  },
  underlineOn: { backgroundColor: Colors.light.primary },

});
