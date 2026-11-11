import React, { useMemo, useState } from "react";
import { DECK_LOOK_LABEL, resolveDeckLook } from "../../shared/deckLooks";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, Modal, Alert,
} from "react-native";
import { usePullRefresh, pullRefresh } from "../components/ui/PullRefresh";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import { useMyPitches } from "../hooks/use-pitches";
import { useAthleteCard } from "../hooks/use-card";
import { PitchDeckTile } from "../components/pitch/PitchDeckTile";
import { PublicCardTile } from "../components/pitch/PublicCardTile";
import { CreatePitchFlow } from "../components/pitch/CreatePitchFlow";
import { isNeedsRefresh } from "../components/pitch/pitchStatus";
import { STUDIO_ENABLED } from "../lib/flags";
import { IntentPicker } from "../components/studio/IntentPicker";
import { StudioContentStrip } from "../components/studio/StudioContentStrip";
import { useStudioContent, type StudioIntent } from "../hooks/use-studio";
import { Bold, Colors, Fonts, Spacing } from "../constants/theme";

const TILE_W = 120;  // unified media-tile footprint (120×160) — ~3 cards per screen

export function StudioScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { athlete } = useAuth();
  const { pitches, isLoading, refetch } = useMyPitches(athlete?.id);
  const pull = usePullRefresh(async () => refetch());
  const { kit } = useAthleteCard(athlete?.id);

  const counts = useMemo(() => ({
    opened: pitches.filter((p) => p.status === "opened").length,
    sent:   pitches.filter((p) => p.status === "sent").length,
    ready:  pitches.filter((p) => p.status === "ready").length,
    stale:  pitches.filter(isNeedsRefresh).length,
  }), [pitches]);

  const lookName  = kit?.tokens?.theme ? DECK_LOOK_LABEL[resolveDeckLook(kit.tokens.theme)] : null;
  const coverImg  = (kit?.cards as any[] | undefined)?.find((c) => c.type === "cover")?.image ?? null;

  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The real Posts & Ads content. Only fetched on the flag-ON path — with the flag off this hook is
  // disabled and the strip below shows a plain coming-soon tile.
  const { items: content, state: contentState } = useStudioContent(STUDIO_ENABLED);

  const onCreate     = () => setCreating(true);
  const openBrandTab = () => nav.getParent()?.navigate("Brand" as never);
  const soon = (label: string) => Alert.alert(label, "Coming soon to Studio.");
  // Studio Content Engine entry point. Guarded by the flag at every call site rather than inside,
  // so with STUDIO_ENABLED off this screen has no path to the workspace at all.
  //
  // ONE workspace, configured by the intent — not one screen per intent. The picker decides the
  // engine + mode fork; format, brand and goal are parameters edited inside the workspace.
  const openWorkspace = (intent: StudioIntent) => nav.navigate("CampaignWorkspace", { intent });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={pullRefresh(pull)}
      >
        {/* masthead */}
        <View style={styles.masthead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>CREATOR WORKSPACE</Text>
            <Text style={styles.title}>Studio</Text>
            <Text style={styles.sub}>Everything you make — pitches, media, posts.</Text>
          </View>
          <View style={styles.mastIcons}>
            <Pressable style={styles.iconBtn} onPress={() => nav.navigate("PitchesList", undefined)} hitSlop={6}>
              <Feather name="search" size={19} color={Colors.light.text} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => nav.navigate("MediaLibrary")} hitSlop={6}>
              <Feather name="image" size={19} color={Colors.light.text} />
            </Pressable>
            <Pressable
              style={styles.plus}
              onPress={() => (STUDIO_ENABLED ? setPickerOpen(true) : setMenuOpen(true))}
              hitSlop={6}
            >
              <Feather name="plus" size={22} color={Colors.light.buttonText} />
            </Pressable>
          </View>
        </View>

        {/* ── Pitches ─────────────────────────────────────────── */}
        <View style={styles.secHead}>
          <Text style={styles.secTitle}>Pitches</Text>
          {pitches.length > 0 ? <Text style={styles.secCount}>· {pitches.length}</Text> : null}
          {pitches.length > 0 ? (
            <Pressable style={styles.headSeeAll} onPress={() => nav.navigate("PitchesList", undefined)}>
              <Text style={styles.headSeeAllTxt}>See all</Text>
              <Feather name="arrow-right" size={14} color={Colors.light.primary} />
            </Pressable>
          ) : null}
        </View>

        {/* status sort-pills */}
        {pitches.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.summary}>
            {counts.opened > 0 ? <StatusPill count={counts.opened} label="opened" dotColor={Bold.ink} onPress={() => nav.navigate("PitchesList", { initialFilter: "opened" })} /> : null}
            {counts.sent   > 0 ? <StatusPill count={counts.sent}   label="sent"   dotColor={Bold.mute} onPress={() => nav.navigate("PitchesList", { initialFilter: "sent" })} /> : null}
            {counts.ready  > 0 ? <StatusPill count={counts.ready}  label="ready"  dotColor="#C5BFB8"        onPress={() => nav.navigate("PitchesList", { initialFilter: "ready" })} /> : null}
            {counts.stale  > 0 ? <StatusPill count={counts.stale}  label="needs refresh" dotColor={Colors.light.warning} onPress={() => nav.navigate("PitchesList", { initialFilter: "stale" })} /> : null}
          </ScrollView>
        ) : null}

        {/* one same-row cards shelf: public card → divider → brand pitches, inline group labels */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cardsShelf}>
          <View style={styles.csGroup}>
            <Text style={styles.csLabel}>Your public profile</Text>
            <PublicCardTile width={TILE_W} coverImage={coverImg} lookName={lookName} onPress={openBrandTab} />
          </View>

          <View style={styles.csDivider} />

          <View style={styles.csGroup}>
            <Text style={styles.csLabel}>Brand pitches</Text>
            <View style={styles.csRow}>
              <Pressable style={styles.createTile} onPress={onCreate}>
                <View style={styles.createCirc}><Feather name="plus" size={20} color={Colors.light.primary} /></View>
                <Text style={styles.createLbl}>New pitch</Text>
                <Text style={styles.createLbl2}>any brand</Text>
              </Pressable>
              {pitches.slice(0, 8).map((p) => (
                <PitchDeckTile
                  key={p.brandId}
                  pitch={p}
                  width={TILE_W}
                  onPress={() =>
                    p.hostedUrl
                      ? WebBrowser.openBrowserAsync(p.hostedUrl, {
                          presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
                          controlsColor: Colors.light.primary,
                        })
                      : nav.navigate("PitchDetail", { brandId: p.brandId, brandName: p.brandName })
                  }
                />
              ))}
            </View>
          </View>
        </ScrollView>

        {/* ── Posts & Ads ─────────────────────────────────────── */}
        <View style={styles.secHead}>
          <Text style={styles.secTitle}>Posts &amp; Ads</Text>
          <View style={styles.newTag}><Text style={styles.newTagTxt}>NEW</Text></View>
          {STUDIO_ENABLED ? null : (
            <Pressable style={styles.headSeeAll} onPress={() => soon("Posts & Ads")}>
              <Text style={styles.headSeeAllTxt}>See all</Text>
              <Feather name="arrow-right" size={14} color={Colors.light.primary} />
            </Pressable>
          )}
        </View>
        <Text style={styles.secSub}>
          {STUDIO_ENABLED
            ? "Turn what you already own into a post, an ad or a clip."
            : "Spin a pitch into a social post or a paid ad."}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pstrip}>
          <Pressable
            style={styles.createTile}
            onPress={STUDIO_ENABLED ? () => setPickerOpen(true) : () => soon("New post / ad")}
          >
            <View style={styles.createCirc}><Feather name="plus" size={20} color={Colors.light.primary} /></View>
            <Text style={styles.createLbl}>New</Text>
            <Text style={styles.createLbl2}>post / ad</Text>
          </Pressable>
          {/* THE FLAG SEAM. Flag ON reads the real content store; flag OFF shows one honest
              coming-soon tile — no sample athlete, brand or partnership. */}
          {STUDIO_ENABLED
            ? (
              <StudioContentStrip
                items={content}
                state={contentState}
                onPressItem={(item) => nav.navigate("MediaDetail", { assetId: item.assetId })}
              />
            )
            : <ComingSoonTile onPress={() => soon("Posts & Ads")} />}
        </ScrollView>
      </ScrollView>

      {/* The front door, flag-ON. One workspace, configured by whichever intent she picks. */}
      <IntentPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPickIntent={openWorkspace}
        onPickDeck={() => setCreating(true)}
      />

      {/* The pre-flag quick-create menu (masthead ＋).
          UNREACHABLE when STUDIO_ENABLED is on — the ＋ opens the IntentPicker instead — so what
          used to be its flag-ON branches are gone and every item renders its flag-OFF form. With
          the flag off, which is how production runs, this is bit-for-bit what shipped before. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuCard}>
            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); setCreating(true); }}>
              <Feather name="edit-3" size={16} color={Colors.light.text} />
              <Text style={styles.menuItemTxt}>New pitch</Text>
            </Pressable>
            <View style={styles.menuDiv} />
            <Pressable
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); soon("New post"); }}
            >
              <Feather name="send" size={16} color={Colors.light.textMuted} />
              <Text style={[styles.menuItemTxt, styles.menuSoon]}>New post</Text>
              <Text style={styles.soonTag}>Soon</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); soon("Generate media"); }}
            >
              <Feather name="zap" size={16} color={Colors.light.textMuted} />
              <Text style={[styles.menuItemTxt, styles.menuSoon]}>Generate media</Text>
              <Text style={styles.soonTag}>Soon</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <CreatePitchFlow
        visible={creating}
        athleteId={athlete?.id}
        onClose={() => setCreating(false)}
        onCreated={(brandId, brandName) => {
          setCreating(false);
          refetch();
          nav.navigate("PitchDetail", { brandId, brandName });
        }}
      />
    </SafeAreaView>
  );
}

function StatusPill({ count, label, dotColor, onPress }: { count: number; label: string; dotColor: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.ssSeg}>
      <View style={[styles.ssDot, { backgroundColor: dotColor }]} />
      <Text style={styles.ssCount}>{count}</Text>
      <Text style={styles.ssLabel}>{label}</Text>
    </Pressable>
  );
}

// The flag-OFF Posts & Ads placeholder: what the strip will hold, with nothing invented in it.
function ComingSoonTile({ onPress }: { onPress: () => void }) {
  return (
    <Pressable style={styles.soonTile} onPress={onPress}>
      <Feather name="film" size={20} color={Colors.light.textMuted} />
      <Text style={styles.soonTileTitle}>Your posts and ads will appear here</Text>
      <Text style={styles.soonTileSub}>Coming soon</Text>
    </Pressable>
  );
}


const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  masthead: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: 12 },
  eyebrow: { fontFamily: Fonts.bodyBold, fontSize: 10.5, letterSpacing: 1.6, color: Colors.light.textMuted, fontWeight: "700" },
  title: { fontFamily: Fonts.display, fontSize: 30, fontWeight: "800", letterSpacing: -0.6, color: Colors.light.text, marginTop: 2 },
  sub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, marginTop: 3 },
  mastIcons: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  iconBtn: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border },
  plus: {
    width: 42, height: 42, borderRadius: 15, backgroundColor: Colors.light.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: Colors.light.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  secHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: Spacing.xl, paddingTop: 24 },
  secTitle: { fontFamily: Fonts.display, fontSize: 21, fontWeight: "800", letterSpacing: -0.3, color: Colors.light.text },
  secCount: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.textMuted },
  headSeeAll: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 4 },
  headSeeAllTxt: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.primary },
  secSub: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.textMuted, paddingHorizontal: Spacing.xl, marginTop: 3 },
  summary: { flexDirection: "row", gap: 7, paddingHorizontal: Spacing.xl, paddingTop: 10 },
  ssSeg: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  ssDot: { width: 8, height: 8, borderRadius: 4 },
  ssCount: { fontFamily: Fonts.bodyBold, fontWeight: "800", fontSize: 12.5, color: Colors.light.text },
  ssLabel: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted },
  // same-row cards shelf
  cardsShelf: { paddingHorizontal: Spacing.xl, paddingTop: 14, paddingBottom: 6, alignItems: "flex-start" },
  csGroup: { gap: 8 },
  csLabel: { fontFamily: Fonts.bodyBold, fontSize: 10.5, letterSpacing: 0.8, textTransform: "uppercase", color: Colors.light.textMuted, fontWeight: "700" },
  csRow: { flexDirection: "row", gap: 12 },
  csDivider: { width: 1, alignSelf: "stretch", backgroundColor: Colors.light.border, marginHorizontal: 14, marginTop: 22 },
  createTile: {
    width: TILE_W, height: Math.round((TILE_W * 4) / 3), borderRadius: 18, borderWidth: 1.6, borderStyle: "dashed",
    borderColor: Colors.light.primary, backgroundColor: Colors.light.card, alignItems: "center", justifyContent: "center", gap: 8,
  },
  createCirc: { width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.light.primaryLight, alignItems: "center", justifyContent: "center" },
  createLbl: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.text },
  createLbl2: { fontFamily: Fonts.body, fontSize: 10, color: Colors.light.textMuted, marginTop: -5 },

  // Posts & Ads strip
  newTag: { backgroundColor: Colors.light.primaryLight, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  newTagTxt: { fontFamily: Fonts.bodyBold, fontSize: 9, fontWeight: "800", letterSpacing: 0.5, color: Colors.light.primary },
  pstrip: { gap: 12, paddingHorizontal: Spacing.xl, paddingTop: 12, paddingBottom: 4 },
  soonTile: {
    width: TILE_W * 2, height: Math.round((TILE_W * 4) / 3), borderRadius: 18, borderWidth: 1, borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSecondary, alignItems: "flex-start", justifyContent: "flex-end", padding: 14, gap: 6,
  },
  soonTileTitle: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, fontWeight: "600", color: Colors.light.text, lineHeight: 18 },
  soonTileSub: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted },
  // create menu
  menuBackdrop: { flex: 1, alignItems: "flex-end", paddingTop: 98, paddingHorizontal: Spacing.xl },
  menuCard: { minWidth: 208, backgroundColor: Colors.light.card, borderRadius: 16, borderWidth: 1, borderColor: Colors.light.border, paddingVertical: 6, ...cardShadow() },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 14, paddingVertical: 12 },
  menuItemTxt: { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 15, fontWeight: "600", color: Colors.light.text },
  menuSoon: { color: Colors.light.textMuted },
  menuDiv: { height: 1, backgroundColor: Colors.light.borderLight, marginVertical: 2 },
  soonTag: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", color: Colors.light.textMuted, backgroundColor: Colors.light.backgroundSecondary, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden" },
});

function cardShadow() {
  return { shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 20, elevation: 8 } as const;
}
