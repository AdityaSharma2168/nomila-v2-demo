/**
 * Studio as the library (EXPO_PUBLIC_AGENT_V3; the Studio tab's root). Look B (DESIGN.md): everything Mila made with the
 * athlete — decks, post kits, pages, media edits — filtered by kind, each row with its status (draft · approved ·
 * published · experimental), its version and the goal it serves. Today it lists the existing decks (the library route
 * falls back to the pitches list until it lands); other kinds appear as they arrive. Published items also show on Me
 * (components/agent/PublishedSection).
 */
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { Bold, BoldType } from "../../constants/theme";
import { Button, Card, Chip } from "../../components/ui";
import { Photo } from "../../components/ui/Photo";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { useAuth } from "../../lib/auth-context";
import { useStudioItems } from "../../lib/agent/hooks";
import { openAgentTarget } from "../../lib/agent/navigate";
import { openMila } from "../../lib/milaLaunch";
import type { StudioItem, StudioItemKind, StudioItemStatus } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export type StudioFilter = "all" | StudioItemKind;
export const STUDIO_FILTERS: ReadonlyArray<{ key: StudioFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "deck", label: "Decks" },
  { key: "post_kit", label: "Posts" },
  { key: "page", label: "Pages" },
  { key: "media_edit", label: "Media" },
];

export const KIND_WORD: Record<StudioItemKind, string> = { deck: "Deck", post_kit: "Post kit", page: "Page", media_edit: "Media edit" };
const KIND_GLYPH: Record<StudioItemKind, string> = { deck: "layers", post_kit: "film", page: "globe", media_edit: "image" };
export const STATUS_WORD: Record<StudioItemStatus, string> = { draft: "Draft", approved: "Approved", published: "Published", experimental: "Experimental" };

export const STUDIO_COPY = {
  title: "Studio",
  lede: "Everything Mila has made with you.",
  emptyAll: "Nothing made yet",
  emptyKind: (word: string) => `No ${word.toLowerCase()}s yet`,
  emptyLine: "Ask Mila for a deck, a post kit or a page, and it lands here.",
  ask: "Ask Mila to make one",
  askDraft: "Make me ",
  error: "Couldn't load your Studio.",
  retry: "Retry",
  version: (n: number) => `v${n}`,
  forGoal: (goal: string) => `For: ${goal}`,
  viewAsFeed: "View as feed",
} as const;

/** Filter, newest first. Pure. */
export function filterItems(items: StudioItem[], filter: StudioFilter): StudioItem[] {
  return items.filter((i) => filter === "all" || i.kind === filter).slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function StatusChip({ status }: { status: StudioItemStatus }) {
  if (status === "experimental") {
    return <View style={styles.experimental} testID="status-experimental"><Text style={styles.experimentalText}>{STATUS_WORD.experimental}</Text></View>;
  }
  return (
    <Chip bold={status === "draft" ? "line" : "dark"} icon={status === "published" ? <Feather name="globe" size={10} color={Bold.onDark} /> : undefined} testID={`status-${status}`}>
      {STATUS_WORD[status]}
    </Chip>
  );
}

export function StudioRow({ item, onOpen, last }: { item: StudioItem; onOpen: (() => void) | null; last: boolean }) {
  const body = (
    <>
      {item.thumbUrl ? (
        <Photo uri={item.thumbUrl} style={styles.thumb} accessibilityLabel={item.title} />
      ) : (
        <View style={[styles.thumb, styles.thumbInk]}><Feather name={KIND_GLYPH[item.kind] as any} size={18} color={Bold.onDark} /></View>
      )}
      <View style={styles.rowText}>
        <Text style={styles.kind}>{KIND_WORD[item.kind]}</Text>
        <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
        <View style={styles.metaRow}>
          <StatusChip status={item.status} />
          <Text style={styles.meta}>{[STUDIO_COPY.version(item.version), item.meta].filter(Boolean).join(" · ")}</Text>
        </View>
        {item.goal ? <Text style={styles.goal} numberOfLines={1}>{STUDIO_COPY.forGoal(item.goal.text)}</Text> : null}
      </View>
      {onOpen ? <Feather name="chevron-right" size={18} color={Bold.quiet} /> : null}
    </>
  );
  const style = [styles.row, !last && styles.rowRule];
  if (!onOpen) return <View style={style} testID={`studio-item-${item.id}`}>{body}</View>;
  return (
    <Pressable
      onPress={() => { haptics.tap(); onOpen(); }}
      accessibilityRole="button"
      accessibilityLabel={`${KIND_WORD[item.kind]}, ${item.title}, ${STATUS_WORD[item.status]}`}
      style={({ pressed }) => [...style, pressed && styles.pressed]}
      testID={`studio-item-${item.id}`}
    >
      {body}
    </Pressable>
  );
}

export function StudioLibraryScreen() {
  const navigation = useNavigation<any>();
  const { athlete } = useAuth();
  const q = useStudioItems(athlete?.id ? String(athlete.id) : undefined);
  const [filter, setFilter] = useState<StudioFilter>("all");
  const pull = usePullRefresh(() => q.refetch());
  const items = useMemo(() => filterItems(q.data ?? [], filter), [q.data, filter]);
  const word = STUDIO_FILTERS.find((f) => f.key === filter)?.label ?? "";

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} refreshControl={pullRefresh(pull)} showsVerticalScrollIndicator={false} testID="agent-studio">
      <View style={styles.head}>
        <Text style={styles.title}>{STUDIO_COPY.title}</Text>
        <Text style={styles.lede}>{STUDIO_COPY.lede}</Text>
      </View>
      <View style={styles.filterRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} style={styles.tabsBar} testID="studio-filters">
          {STUDIO_FILTERS.map((f) => {
            const on = f.key === filter;
            return (
              <Pressable key={f.key} onPress={() => { haptics.select(); setFilter(f.key); }} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[styles.tab, on && styles.tabOn]} testID={`studio-filter-${f.key}`}>
                <Text style={[styles.tabText, on && styles.tabTextOn]}>{f.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {filter === "post_kit" ? (
          <Pressable onPress={() => { haptics.tap(); navigation.navigate("StudioForYou"); }} accessibilityRole="button" accessibilityLabel={STUDIO_COPY.viewAsFeed} style={styles.feedToggle} testID="studio-view-as-feed">
            <Feather name="layers" size={14} color={Bold.ink} />
            <Text style={styles.feedToggleText}>{STUDIO_COPY.viewAsFeed}</Text>
          </Pressable>
        ) : null}
      </View>

      {q.isLoading ? (
        <View style={styles.center} testID="studio-loading"><ActivityIndicator color={Bold.ink} /></View>
      ) : q.isError ? (
        <View style={styles.center} testID="studio-error">
          <Text style={styles.muted}>{STUDIO_COPY.error}</Text>
          <Button bold="small" onPress={() => { void q.refetch(); }}>{STUDIO_COPY.retry}</Button>
        </View>
      ) : items.length === 0 ? (
        <Card bold style={styles.card} testID="studio-empty">
          <View style={styles.center}>
            <Feather name="aperture" size={22} color={Bold.quiet} />
            <Text style={styles.emptyTitle}>{filter === "all" ? STUDIO_COPY.emptyAll : STUDIO_COPY.emptyKind(word.replace(/s$/, ""))}</Text>
            <Text style={styles.muted}>{STUDIO_COPY.emptyLine}</Text>
            <Button bold="small" onPress={() => openMila({ draft: STUDIO_COPY.askDraft })} testID="studio-ask">{STUDIO_COPY.ask}</Button>
          </View>
        </Card>
      ) : (
        <Card bold style={styles.card} testID="studio-list">
          {items.map((it, i) => (
            <StudioRow key={it.id} item={it} last={i === items.length - 1} onOpen={it.open ? () => openAgentTarget(navigation, it.open!) : null} />
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Bold.paper },
  content: { paddingBottom: 40 },
  head: { paddingHorizontal: Bold.gutter, paddingTop: 4, gap: 6 },
  title: { ...BoldType.screenTitle, color: Bold.ink },
  lede: { ...BoldType.lede, color: Bold.mute },
  filterRow: { flexDirection: "row", alignItems: "center", marginTop: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  tabsBar: { flex: 1, flexGrow: 1 },
  tabs: { gap: 18, paddingHorizontal: Bold.gutter },
  feedToggle: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: Bold.gutter, paddingVertical: 10 },
  feedToggleText: { ...BoldType.buttonSmall, color: Bold.ink },
  tab: { paddingTop: 4, paddingBottom: 10, borderBottomWidth: 3, borderBottomColor: "transparent", marginBottom: -1, minHeight: 44, justifyContent: "flex-end" },
  tabOn: { borderBottomColor: Bold.ink },
  tabText: { ...BoldType.segment, color: Bold.quiet },
  tabTextOn: { color: Bold.ink },
  card: { marginHorizontal: Bold.gutter, marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  rowRule: { borderBottomWidth: 1, borderBottomColor: Bold.line },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  thumb: { width: 56, height: 56, borderRadius: Bold.radius.control, overflow: "hidden" },
  thumbInk: { backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, gap: 3 },
  kind: { ...BoldType.label, color: Bold.mute },
  rowTitle: { ...BoldType.rowTitle, color: Bold.ink },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  meta: { ...BoldType.rowMeta, color: Bold.mute },
  goal: { ...BoldType.caption, color: Bold.ink2 },
  experimental: { height: Bold.chip, paddingHorizontal: 8, borderRadius: Bold.radius.chip, borderWidth: 1, borderStyle: "dashed", borderColor: Bold.ink, justifyContent: "center" },
  experimentalText: { ...BoldType.chip, color: Bold.ink },
  center: { alignItems: "center", gap: 8, paddingVertical: 24, paddingHorizontal: 20 },
  muted: { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
  emptyTitle: { ...BoldType.h4, color: Bold.ink },
});
