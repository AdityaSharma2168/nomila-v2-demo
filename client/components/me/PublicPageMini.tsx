/**
 * PublicPageMini — the TOP of Me (AGENT_V3 + PUBLIC_CARD): a MINI of her own public page itself — the same Front Door
 * layout (components/frontDoor/FrontDoorPage), laid out at phone width and scaled down — in her own view, the metrics
 * rail on its hero. Promoted from the approved prototype (PR #900, client/screens/prototypes/PublicPageSection.tsx).
 *
 * The whole card opens the full page (DESIGN.md §11, the whole card is the target); the expand icon at its top right
 * is the cue. Edit is its own action: it opens the full page in Edit mode. No separate stats row: the metrics are part
 * of the page design. While the page loads, or cannot be drawn, the frame shows a plain state and the card still opens.
 */
import React from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Card, Chip, Eyebrow, LinkText } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { FrontDoorPage, DOOR_GRID_H, type ChapterImages } from "../frontDoor/FrontDoorPage";
import type { FrontDoorModel } from "../../lib/frontDoorLogic";
import type { PublicPageMetrics } from "../../../shared/publicPageStats";

export const PUBLIC_PAGE_COPY = {
  title: "Your public page",
  live: "Live",
  draft: "Draft",
  expand: "Open your page",
  edit: "Edit",
  empty: "Your page draws here once Nomila has your first chapters.",
} as const;

/** The page is laid out at phone width and scaled into the mini. */
const PAGE_W = 390;
const MINI_HERO = 520;
const MINI_SCALE = 0.5;
/** The page's height at phone width: the top bar, the hero, the grid and the footer. */
const PAGE_H = 52 + MINI_HERO + DOOR_GRID_H + 80;

export function PublicPageMini({ model, metrics, verified = false, chapterImages, live, loading = false, onExpand, onEdit }: {
  model: FrontDoorModel | null;
  metrics: PublicPageMetrics | null;
  verified?: boolean;
  chapterImages?: ChapterImages;
  live: boolean;
  loading?: boolean;
  onExpand: () => void;
  onEdit: () => void;
}) {
  const c = PUBLIC_PAGE_COPY;
  return (
    <Pressable onPress={onExpand} accessibilityRole="button" accessibilityLabel={c.expand} style={({ pressed }) => [pressed && styles.pressed]} testID="public-page-mini-open">
      <Card bold style={styles.card} testID="public-page-mini">
        <View style={styles.miniHead}>
          <Eyebrow>{c.title}</Eyebrow>
          <View style={styles.miniHeadRight}>
            <Chip bold={live ? "blue" : "line"}>{live ? c.live : c.draft}</Chip>
            <LinkText onPress={onEdit} arrow={false} testID="public-page-mini-edit">{c.edit}</LinkText>
          </View>
        </View>
        <View style={styles.stage}>
          <View style={[styles.miniFrame, { width: PAGE_W * MINI_SCALE, height: PAGE_H * MINI_SCALE }]} pointerEvents="none">
            {model ? (
              <View style={{ width: PAGE_W, transform: [{ scale: MINI_SCALE }], transformOrigin: "top left" }}>
                <FrontDoorPage model={model} owner metrics={metrics} verified={verified} chapterImages={chapterImages} width={PAGE_W} heroHeight={MINI_HERO} />
              </View>
            ) : (
              <View style={styles.placeholder} testID="public-page-mini-empty">
                {loading ? <ActivityIndicator color={Bold.ink} /> : <Text style={styles.placeholderText}>{c.empty}</Text>}
              </View>
            )}
          </View>
          <View style={styles.expand} testID="public-page-expand"><Feather name="maximize-2" size={16} color={Bold.ink} /></View>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed:         { transform: [{ scale: Bold.pressScale }] },
  card:            { marginHorizontal: Bold.gutter, marginTop: 8 },
  miniHead:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  miniHeadRight:   { flexDirection: "row", alignItems: "center", gap: 14 },
  stage:           { backgroundColor: Bold.ground, alignItems: "center", paddingVertical: 14, borderBottomLeftRadius: Bold.radius.card, borderBottomRightRadius: Bold.radius.card },
  miniFrame:       { overflow: "hidden", borderRadius: Bold.radius.card, backgroundColor: Bold.paper },
  placeholder:     { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  placeholderText: { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  expand:          { position: "absolute", top: 10, right: 10, width: 36, height: 36, borderRadius: Bold.radius.control, backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
});
