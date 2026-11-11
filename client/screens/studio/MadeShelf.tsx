/**
 * MadeShelf — the Made tab. Everything she has finished, and where it is in its life.
 *
 * ─── TYPE IS THE SPINE, STATE IS A STRIP ───────────────────────────────────────────────────────
 * The shelf this replaces had two navigation systems stacked: a pill row at the top and category
 * headings in the body, both doing the same job. Worse, the pill row mixed two axes — brand /
 * personal / pitch is WHO IT IS FOR, scheduled is WHERE IT IS IN ITS LIFE — and the little divider
 * before "Scheduled" was the design admitting it.
 *
 * So sections are type, and state is a row of COUNTS above them. Counts are information; a second
 * pill row would have been more chrome. Tapping one narrows the shelf to that state.
 *
 * ─── SEARCH IS AN ICON ─────────────────────────────────────────────────────────────────────────
 * A permanent search field costs a row of prime space for something nobody does at this library
 * size. It opens on demand.
 *
 * ─── WHAT IS REAL HERE ─────────────────────────────────────────────────────────────────────────
 * Content, state, section and title all come from the server now: brand posts sort themselves off
 * the brand named in the job's brief. Pitches and Anything stay empty because neither is a property
 * of the asset (see surfaceOf() in use-studio-pending) — and the shelf renders only the sections
 * that have something in them, so those two simply do not appear.
 *
 * ─── AN EMPTY SHELF AND A BROKEN ONE ARE DIFFERENT SENTENCES ───────────────────────────────────
 * This screen used to read `{ data, isLoading }` and nothing else, which meant a failed read — an
 * empty array, indistinguishable from having made nothing — rendered as "Nothing here yet. Anything
 * you make lands here." That is the worst available answer: it tells her the work is gone. The
 * three outcomes are now three states, matching what StudioContentStrip already does for the same
 * query, and only the genuinely-empty one keeps the friendly copy.
 */
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, Image, ActivityIndicator } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useMadeShelf, type MadeItem, type MadeState } from "../../hooks/use-studio-pending";
import { AssetViewer } from "../../components/studio/AssetViewer";
import { shelfCounts, shelfSections, type Lens } from "./madeShelfLogic";

export function MadeShelf({ onOpenItem }: { onOpenItem: (assetId: string) => void }) {
  const { data, isLoading, isError, isUnavailable } = useMadeShelf(true);
  // Swipe down: every Studio read on screen again (its content, deliverables and edits — all under ["studio"]).
  const qc = useQueryClient();
  const pull = usePullRefresh(() => qc.refetchQueries({ queryKey: ["studio"], type: "active" }));
  const [lens, setLens] = useState<Lens>("all");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<MadeItem | null>(null);

  const counts   = useMemo(() => shelfCounts(data), [data]);
  const sections = useMemo(() => shelfSections(data, lens, query), [data, lens, query]);
  const q = query.trim();

  /**
   * A tap opens THE PICTURE, not a record about the picture.
   *
   * The tile used to go straight to MediaDetail — the library's analysis screen — which is the
   * right destination for a question about an asset and the wrong one for "let me actually look at
   * this". Judging an edit needs pixels at full size, and 132px of tile cannot carry that argument.
   * MediaDetail is not lost: the viewer's ⓘ leads there, so the old door costs one more tap and the
   * common case costs none.
   *
   * A video has no viewer here and an image with no url has nothing to show, so both fall through
   * to MediaDetail exactly as every tile did before.
   */
  const openTile = (item: MadeItem) => {
    if (item.mediaType === "IMAGE" && (item.url ?? item.thumbUrl)) setViewing(item);
    else onOpenItem(item.assetId);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        {searching ? (
          <View style={styles.searchRow}>
            <Feather name="search" size={16} color={Colors.light.tabIconDefault} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search everything you have made…"
              placeholderTextColor={Colors.light.tabIconDefault}
              autoFocus
              returnKeyType="search"
            />
            <HapticPressable
              onPress={() => { setSearching(false); setQuery(""); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close search"
            >
              <Feather name="x" size={16} color={Colors.light.textMuted} />
            </HapticPressable>
          </View>
        ) : (
          <View style={styles.titleRow}>
            <Text style={styles.headTitle} numberOfLines={1}>
              {LENS_TITLE[lens]} · {lens === "archived" ? counts.archived : counts.all}
            </Text>
            <HapticPressable
              style={styles.searchBtn}
              onPress={() => setSearching(true)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Search what you have made"
            >
              <Feather name="search" size={16} color={Colors.light.textSecondary} />
            </HapticPressable>
          </View>
        )}

        <View style={styles.strip}>
          <Stat n={counts.scheduled} label="Scheduled"     on={lens === "scheduled"} tone={Colors.light.primary}
                onPress={() => setLens(lens === "scheduled" ? "all" : "scheduled")} />
          <Stat n={counts.attention} label="Waiting on you" on={lens === "attention"} tone={Colors.light.warning}
                onPress={() => setLens(lens === "attention" ? "all" : "attention")} />
          <Stat n={counts.all}       label="All work"       on={lens === "all"}
                onPress={() => setLens("all")} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)}>
        {isLoading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={Colors.light.primary} />
        ) : isError ? (
          <Unhappy
            icon="alert-circle"
            title="Couldn't load your shelf"
            body="This is us, not you — nothing has been lost. Pull to refresh and try again."
          />
        ) : isUnavailable ? (
          // The server's flag is off. Not a failure, and not an empty shelf either.
          <Unhappy
            icon="cloud-off"
            title="Not switched on yet"
            body="Making posts isn't live on your account yet."
          />
        ) : sections.length === 0 ? (
          <Empty lens={lens} searching={q.length > 0} />
        ) : (
          sections.map((s) => (
            <View key={s.key}>
              <View style={styles.secHead}>
                <Text style={styles.secTitle}>{s.heading}</Text>
                <Text style={styles.secCount}>{s.items.length}</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.row}
              >
                {s.items.map((it) => (
                  <Tile key={it.assetId} item={it} onPress={() => openTile(it)} />
                ))}
              </ScrollView>
            </View>
          ))
        )}

        {/* Findable, never prominent. Only when there is something in it. */}
        {counts.archived > 0 && lens !== "archived" ? (
          <HapticPressable
            style={styles.archiveRow}
            onPress={() => setLens("archived")}
            accessibilityRole="button"
            accessibilityLabel={`Archived, ${counts.archived} items`}
          >
            <Feather name="archive" size={16} color={Colors.light.tabIconDefault} />
            <Text style={styles.archiveTxt}>Archived</Text>
            <Text style={styles.archiveCount}>{counts.archived}</Text>
            <View style={{ flex: 1 }} />
            <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
          </HapticPressable>
        ) : null}

        {lens === "archived" ? (
          <HapticPressable
            style={styles.backRow}
            onPress={() => setLens("all")}
            accessibilityRole="button"
            accessibilityLabel="Back to the shelf"
          >
            <Feather name="chevron-left" size={15} color={Colors.light.primary} />
            <Text style={styles.backTxt}>Back to the shelf</Text>
          </HapticPressable>
        ) : null}
      </ScrollView>

      {/* The SAME signed url the tile just rendered — see AssetViewer's header. Nothing is re-read. */}
      <AssetViewer
        visible={!!viewing}
        uri={viewing ? viewing.url ?? viewing.thumbUrl : null}
        assetId={viewing?.assetId ?? null}
        title={viewing?.title ?? null}
        onClose={() => setViewing(null)}
        onDetails={
          viewing
            ? () => {
                const id = viewing.assetId;
                setViewing(null);
                onOpenItem(id);
              }
            : undefined
        }
      />
    </View>
  );
}

const LENS_TITLE: Record<Lens, string> = {
  all:       "Everything you have made",
  scheduled: "What is coming",
  attention: "Waiting on you",
  archived:  "Archived",
};

function Stat({
  n, label, on, tone, onPress,
}: {
  n: number; label: string; on: boolean; tone?: string; onPress: () => void;
}) {
  return (
    <HapticPressable
      style={[styles.stat, on && styles.statOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${n} ${label}`}
    >
      <Text style={[styles.statN, { color: n ? (tone ?? Colors.light.text) : Colors.light.tabIconDefault }]}>
        {n}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </HapticPressable>
  );
}

function Tile({ item, onPress }: { item: MadeItem; onPress: () => void }) {
  return (
    <HapticPressable
      style={styles.tile}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${STATE_LABEL[item.state]}`}
    >
      <View style={styles.tileImg}>
        {item.thumbUrl || item.url ? (
          <Image source={{ uri: (item.thumbUrl ?? item.url) as string }} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.tileBlank]}>
            <Feather name="image" size={18} color={Colors.light.tabIconDefault} />
          </View>
        )}
        <View style={styles.tileScrim} />
        <View style={styles.tileFoot}>
          <Text style={styles.tileTitle} numberOfLines={1}>{item.title}</Text>
          {item.subtitle ? <Text style={styles.tileSub} numberOfLines={1}>{item.subtitle}</Text> : null}
          <View style={[styles.tag, TAG_STYLE[item.state]]}>
            <Text style={[styles.tagTxt, TAG_TEXT[item.state]]}>{STATE_LABEL[item.state]}</Text>
          </View>
        </View>
      </View>
    </HapticPressable>
  );
}

/**
 * The shelf could not answer. Shares Empty's layout on purpose — this is the same slot saying a
 * different thing, and the icon is what separates "we broke" from "you have nothing".
 */
function Unhappy({
  icon, title, body,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  body: string;
}) {
  return (
    <View style={styles.empty}>
      <Feather name={icon} size={22} color={Colors.light.tabIconDefault} style={{ marginBottom: 9 }} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function Empty({ lens, searching }: { lens: Lens; searching: boolean }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>
        {searching ? "Nothing matches that" : EMPTY_TITLE[lens]}
      </Text>
      <Text style={styles.emptyBody}>
        {searching ? "Try a brand name or a format." : EMPTY_BODY[lens]}
      </Text>
    </View>
  );
}

const EMPTY_TITLE: Record<Lens, string> = {
  all:       "Nothing here yet",
  scheduled: "Nothing scheduled",
  attention: "Nothing waiting on you",
  archived:  "Nothing archived",
};
const EMPTY_BODY: Record<Lens, string> = {
  all:       "Anything you make lands here, posted or not.",
  scheduled: "Schedule a post and it shows up here with its date.",
  attention: "Everything you have made has been dealt with.",
  archived:  "Archived work stays here rather than going anywhere.",
};

const STATE_LABEL: Record<MadeState, string> = {
  awaiting:  "Awaiting you",
  draft:     "Draft",
  making:    "Making",
  scheduled: "Scheduled",
  posted:    "Posted",
  archived:  "Archived",
};

const TAG_STYLE: Record<MadeState, object> = {
  awaiting:  { backgroundColor: Colors.light.warningLight },
  draft:     { backgroundColor: Colors.light.backgroundSecondary },
  making:    { backgroundColor: Colors.light.primaryLight },
  scheduled: { backgroundColor: Colors.light.primaryLight },
  posted:    { backgroundColor: Colors.light.successLight },
  archived:  { backgroundColor: Colors.light.backgroundSecondary },
};
const TAG_TEXT: Record<MadeState, object> = {
  awaiting:  { color: Colors.light.text },
  draft:     { color: Colors.light.textSecondary },
  making:    { color: Colors.light.primary },
  scheduled: { color: Colors.light.primary },
  posted:    { color: Colors.light.text },
  archived:  { color: Colors.light.textMuted },
};

const TILE_W = 112;

const styles = StyleSheet.create({
  head: { paddingHorizontal: Spacing.xl, paddingTop: 10, paddingBottom: 10 },

  titleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  headTitle: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.textMuted },
  searchBtn: {
    width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 999, paddingHorizontal: 14, height: 40,
  },
  searchInput: {
    flex: 1, fontFamily: Fonts.body, fontSize: 13.5, color: Colors.light.text, padding: 0,
  },

  strip: { flexDirection: "row", gap: 7, marginTop: 10 },
  stat: {
    flex: 1, minWidth: 0, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 11,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  statOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  statN: { fontFamily: Fonts.display, fontSize: 20, fontWeight: "800", letterSpacing: -0.5, lineHeight: 22 },
  statLabel: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700",
    color: Colors.light.textMuted, marginTop: 3,
  },

  body: { paddingHorizontal: Spacing.xl, paddingBottom: 30 },

  secHead: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 22, marginBottom: 10 },
  secTitle: {
    fontFamily: Fonts.display, fontSize: 18, fontWeight: "800",
    letterSpacing: -0.4, color: Colors.light.text,
  },
  secCount: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.textMuted },

  row: { gap: 9, paddingBottom: 2 },
  tile: { width: TILE_W },
  tileImg: {
    width: TILE_W, aspectRatio: 3 / 4, borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.backgroundSecondary,
  },
  tileBlank: { alignItems: "center", justifyContent: "center" },
  tileScrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(13,11,8,0.28)" },
  tileFoot: { position: "absolute", left: 7, right: 7, bottom: 7 },
  tileTitle: { fontFamily: Fonts.bodyBold, fontSize: 11, fontWeight: "700", color: Colors.light.buttonText },
  tileSub: { fontFamily: Fonts.body, fontSize: 9.5, color: "rgba(255,255,255,0.8)", marginTop: 1 },
  tag: { alignSelf: "flex-start", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, marginTop: 5 },
  tagTxt: { fontFamily: Fonts.bodyBold, fontSize: 9, fontWeight: "700" },

  archiveRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    marginTop: 26, paddingTop: 18, borderTopWidth: 1, borderTopColor: Colors.light.border,
  },
  archiveTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.textMuted },
  archiveCount: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.tabIconDefault },

  backRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 22 },
  backTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, fontWeight: "600", color: Colors.light.primary },

  empty: { alignItems: "center", paddingTop: 46, paddingHorizontal: 20 },
  emptyTitle: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text },
  emptyBody: {
    fontFamily: Fonts.body, fontSize: 13, lineHeight: 19, color: Colors.light.textMuted,
    marginTop: 5, textAlign: "center", maxWidth: 260,
  },
});
