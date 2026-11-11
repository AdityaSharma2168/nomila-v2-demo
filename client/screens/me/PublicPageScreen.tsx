/**
 * PublicPageScreen — her public page full screen, in HER OWN view (Me › the mini's expand, or Edit). Promoted from the
 * approved prototype (PR #900, client/screens/prototypes/PublicPageSection.tsx PublicPageFull).
 *
 *   the bar     ‹ ME, and Edit / Done at the right
 *   the page    the Front Door (components/frontDoor/FrontDoorPage) with the metrics rail on the hero. Only the hero
 *               swipes; the door grid stays pinned at the foot while the page scrolls (owner rule, 10 Oct 2026)
 *   Edit        "What visitors can do" over the page: Ask Mila · Partner requests · Bookings · Picks · M.I.A. on your
 *               page (off by default), each her switch (PATCH /me/public-card/switches, the same switches Card settings
 *               holds), then Review & publish (the existing Review → publish flow; publishing is her tap only). The page
 *               follows the switches as the server answers
 *   a door      in her own view a door says what it does for a visitor (nothing opens or sends from here)
 *
 * Reads: GET /me/public-card/preview + draft, GET /me/public-card/metrics, the atmosphere picker. PUBLIC_CARD only (Me
 * opens it only then).
 */
import React, { useState } from "react";
import { View, Text, Switch, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Button, Card, RuledHead } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";
import { FrontDoorPage } from "../../components/frontDoor/FrontDoorPage";
import { DetailSheet } from "../../components/me/DetailSheet";
import { useMyFrontDoor } from "../../hooks/use-my-front-door";
import { usePublicCardDraft, useSetSwitches } from "../../hooks/use-public-card";
import { doorUnavailable, ERROR_COPY, problemLine, publicCardError, tileExplainer } from "../../lib/publicCardLogic";
import type { PublicCardSwitches } from "../../../shared/publicCard";

type CapKey = "askMila" | "partner" | "book" | "shop" | "showMia";

export const PUBLIC_PAGE_SCREEN_COPY = {
  back: "Me",
  edit: "Edit",
  done: "Done",
  capabilities: "What visitors can do",
  capabilitiesSub: "Turn a door on and it shows on your page.",
  review: "Review & publish",
  doorTitle: (label: string) => `${label}, for visitors`,
  caps: {
    askMila: { title: "Ask Mila", meta: "Mila answers fans and brands for you" },
    partner: { title: "Partner requests", meta: "Brands can send you an offer" },
    book: { title: "Bookings", meta: "Sessions, calls and appearances" },
    shop: { title: "Picks", meta: "Your shop of products you love" },
    showMia: { title: "M.I.A. on your page", meta: "Show your marketability score. Off by default" },
  } as Record<CapKey, { title: string; meta: string }>,
} as const;

const ORDER: CapKey[] = ["askMila", "partner", "book", "shop", "showMia"];

export function PublicPageScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const c = PUBLIC_PAGE_SCREEN_COPY;
  const [edit, setEdit] = useState<boolean>(!!route.params?.edit);
  const [door, setDoor] = useState<{ label: string; text: string } | null>(null);
  const page = useMyFrontDoor();
  const draft = usePublicCardDraft();
  const setSwitches = useSetSwitches();
  const sw = draft.data?.card.switches ?? null;
  const first = page.model?.firstName ?? "";
  const flip = (k: CapKey, v: boolean) => setSwitches.mutate({ [k]: v } as Partial<PublicCardSwitches>);

  return (
    <SafeAreaView style={styles.dark}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.bar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={styles.back} testID="public-page-back">
          <Feather name="chevron-left" size={18} color={Bold.ink} />
          <Text style={styles.backLabel}>{c.back}</Text>
        </Pressable>
        <Pressable onPress={() => setEdit((x) => !x)} accessibilityRole="button" accessibilityState={{ selected: edit }} testID="public-page-edit" style={[styles.editBtn, edit && styles.editBtnOn]}>
          <Feather name={edit ? "check" : "edit-2"} size={14} color={edit ? Bold.onDark : Bold.ink} />
          <Text style={[styles.editText, edit && styles.editTextOn]}>{edit ? c.done : c.edit}</Text>
        </Pressable>
      </View>

      {edit ? (
        <ScrollView style={styles.editScroll} contentContainerStyle={styles.editContent} showsVerticalScrollIndicator={false}>
          <Card bold style={styles.editCard} testID="public-page-capabilities">
            <RuledHead title={c.capabilities} style={styles.ruled} />
            <Text style={styles.capSub}>{c.capabilitiesSub}</Text>
            {ORDER.map((k, i) => {
              const why = draft.data && (k === "book" || k === "shop") ? doorUnavailable(k, draft.data.availability) : null;
              return (
                <View key={k} style={[styles.capRow, i === ORDER.length - 1 && styles.last]} testID={`public-cap-${k}`}>
                  <View style={styles.capText}>
                    <Text style={styles.capTitle}>{c.caps[k].title}</Text>
                    <Text style={styles.capMeta}>{why ?? c.caps[k].meta}</Text>
                  </View>
                  <Switch
                    value={!!sw?.[k]}
                    disabled={!sw || (!!why && !sw[k]) || setSwitches.isPending}
                    onValueChange={(v) => flip(k, v)}
                    trackColor={{ false: Bold.track, true: Bold.ink }}
                    thumbColor={Bold.paper}
                    // react-native-web draws the ON thumb in its own default colour unless told; keep it paper on ink.
                    {...({ activeThumbColor: Bold.paper } as object)}
                    accessibilityLabel={c.caps[k].title}
                    testID={`public-cap-switch-${k}`}
                  />
                </View>
              );
            })}
            {setSwitches.isError ? <Text style={styles.capError}>{problemLine(publicCardError(setSwitches.error))}</Text> : null}
            <View style={styles.actions}><Button bold="primary" onPress={() => navigation.navigate("PublicCardReview")} testID="public-page-review">{c.review}</Button></View>
          </Card>
        </ScrollView>
      ) : null}

      {page.model ? (
        <FrontDoorPage
          model={page.model}
          owner
          metrics={page.metrics}
          verified={page.verified}
          chapterImages={page.chapterImages}
          pinnedDoors
          onDoor={(t) => setDoor({ label: t.label, text: tileExplainer(t.key, first) })}
          onAsk={() => setDoor({ label: "Ask Mila", text: tileExplainer("ask", first) })}
        />
      ) : page.isError ? (
        <View style={styles.state} testID="public-page-error">
          <Text style={styles.stateText}>{problemLine(publicCardError(null))}</Text>
          <Button bold="secondary" onPress={page.refetch} style={styles.self}>{ERROR_COPY.retry}</Button>
        </View>
      ) : (
        <ActivityIndicator style={styles.spinner} color={Bold.ink} accessibilityLabel="Loading your page" testID="public-page-loading" />
      )}

      {door ? (
        <DetailSheet title={c.doorTitle(door.label)} onClose={() => setDoor(null)} testID="public-page-door">
          <Text style={styles.sheetText}>{door.text}</Text>
        </DetailSheet>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // The one look: her page sits on the white ground (the style's name is historic).
  dark:        { flex: 1, backgroundColor: Bold.paper },
  bar:         { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  back:        { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44 },
  backLabel:   { ...BoldType.backLabel, color: Bold.ink },
  editBtn:     { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 12, borderRadius: Bold.radius.pill, borderWidth: 1.5, borderColor: Bold.ink },
  editBtnOn:   { backgroundColor: Bold.ink, borderColor: Bold.ink },
  editText:    { ...BoldType.buttonSmall, color: Bold.ink },
  editTextOn:  { color: Bold.onDark },
  editScroll:  { flexGrow: 0, maxHeight: "55%" },
  editContent: { paddingBottom: 12 },
  editCard:    { marginHorizontal: Bold.gutter },
  ruled:       { marginHorizontal: 14, marginTop: 12 },
  capSub:      { ...BoldType.caption, color: Bold.mute, paddingHorizontal: 14, paddingBottom: 4 },
  capRow:      { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:        { borderBottomWidth: 0 },
  capText:     { flex: 1, minWidth: 0, gap: 2 },
  capTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  capMeta:     { ...BoldType.rowMeta, color: Bold.mute },
  capError:    { ...BoldType.caption, color: Bold.ink, paddingHorizontal: 14, paddingTop: 8 },
  actions:     { padding: 14, paddingTop: 6 },
  state:       { gap: 10, padding: Bold.gutter },
  stateText:   { ...BoldType.body, color: Bold.ink },
  self:        { alignSelf: "flex-start" },
  spinner:     { marginTop: 32 },
  sheetText:   { ...BoldType.body, color: Bold.ink2, paddingHorizontal: Bold.gutter, paddingVertical: 12 },
});
