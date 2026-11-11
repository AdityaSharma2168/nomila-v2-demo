// The brand book (BRAND_BOOK_V1, brand-book/2): the agency's presentation to its own athlete — what we found, the brand
// we'd build and why, how we get there — read FULL SCREEN, one screen per page, like a story: progress segments across
// the top, tap right/left or swipe to turn, swipe down (or ✕) to leave, one quiet Edit pill. Nothing scrolls inside a
// page: shared/bookLayout splits chapters into screens and picks each screen's layout from its content; the page
// templates (components/book) draw them on white or, for the cover and the photo pages, the dark ground. The tab bar
// steps aside (navigation/shellTabs FULL_SCREEN_ROUTES).
//
// Design of record: "Brand book, polished" (https://claude.ai/artifact/NBTHEav4Jy5XZGN8YQzFyZ) and "Templates and motion"
// (https://claude.ai/artifact/QhP12GAJcH24tkkmMRzXNW), drawn in the app's one look since 23 Oct 2026 (owner-approved
// comparison https://claude.ai/artifact/2b1Wp7qqeNEeCxLL9Dznqa, version B): Bold tokens, Outfit only, the raspberry
// for the one action; the reader's chrome turns white over dark pages and ink over white ones (shared/bookLayout pageTone).
//
// States: no book yet (the invitation and one button) · an older-shape book (rewrite it) · Mila writing it (polls) ·
// the book · a failed build (try again).

import React, { useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, FlatList, Image, Modal, ActivityIndicator, PanResponder, useWindowDimensions,
  type LayoutChangeEvent, type ViewToken, type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { openMila } from "../../lib/milaLaunch";
import { saveRemoteAsset } from "../../lib/download-asset";
import { useBrandBook, useChooseLine, useMakeBookReel, useWriteBrandBook } from "../../hooks/use-brand-book";
import { BRAND_BOOK_COPY as C, lineOf } from "../../lib/brandBookLogic";
import { editSlots, isBookEnd, pageTone, readerPages, screenTitle, type ReaderPage } from "../../../shared/bookLayout";
import { BookScreen } from "../../components/book/BookPages";
import { useReduceMotion } from "../../components/book/motion";
import type { BookPage } from "../../../shared/brandBook";

const BOOK_ART = require("../../assets/illustrations/book.jpg");

/** The reader's chrome: progress + header at the top, the Edit pill at the bottom. Page templates keep clear of both. */
const TOP_CHROME = 64;
const BOTTOM_CHROME = 76;
/** The bottom row's lift off the safe area (the reel and Edit pills): a page's Nomila footer lines up with it. */
const BOTTOM_LIFT = 14;

type Edit = { page: BookPage; slots: string[]; slot: string | null } | null;

export function BrandBookScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { width: windowW, height: windowH } = useWindowDimensions();
  const start = Math.max(0, Number(route.params?.start ?? 0) || 0);
  const q = useBrandBook(true);
  const write = useWriteBrandBook();
  const choose = useChooseLine();
  const reel = useMakeBookReel();
  const reduce = useReduceMotion();
  const [index, setIndex] = useState(start);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [edit, setEdit] = useState<Edit>(null);
  const [menu, setMenu] = useState(false);
  const [watching, setWatching] = useState(false);
  const list = useRef<FlatList<ReaderPage>>(null);
  const pageRefs = useRef<Record<string, View | null>>({});
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems[0]?.index != null) setIndex(viewableItems[0].index);
  }).current;

  const data = q.data;
  const book = data?.book ?? null;
  const screens = useMemo(() => (book ? readerPages(book) : []), [book]);
  const byId = useMemo(() => new Map((book?.pages ?? []).map((p) => [p.id, p])), [book]);
  const close = () => { haptics.tap(); navigation.goBack(); };

  // Swipe down anywhere to leave (a vertical drag that clearly isn't a page turn).
  const closeRef = useRef(close);
  closeRef.current = close;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => g.dy > 14 && Math.abs(g.dy) > Math.abs(g.dx) * 1.6,
    onPanResponderRelease: (_, g) => { if (g.dy > 90) closeRef.current(); },
  })).current;

  // ── States before the book ────────────────────────────────────────────────────────────────────────────────────────
  if (q.isLoading) return <View style={[styles.center, { paddingTop: insets.top }]} testID="book-loading"><ActivityIndicator color={Bold.ink} /></View>;
  if (!book || data?.status === "building") {
    const building = data?.status === "building" || write.isPending;
    const failed = data?.status === "failed";
    const line = building ? C.writingLine : failed ? C.failed : data?.stale ? C.staleLine : C.emptyLine;
    return (
      <View style={[styles.intro, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]} testID={building ? "book-building" : "book-empty"}>
        <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={[styles.introClose, { top: insets.top + 12 }]}>
          <Feather name="x" size={22} color={Bold.ink} />
        </Pressable>
        <Image source={BOOK_ART} style={styles.introArt} accessibilityIgnoresInvertColors accessibilityLabel="" />
        <Text style={styles.introKicker}>{C.title}</Text>
        <Text style={styles.introTitle}>{building ? C.writingTitle : C.emptyTitle}</Text>
        <Text style={styles.introLine}>{line}</Text>
        {building
          ? <ActivityIndicator color={Bold.ink} style={{ marginTop: 18 }} />
          : (
            <Pressable onPress={() => { haptics.press(); write.mutate(); }} style={styles.writeBtn} accessibilityRole="button" testID="book-write">
              <Text style={styles.writeText}>{failed || data?.stale ? C.rewrite : C.write}</Text>
            </Pressable>
          )}
      </View>
    );
  }

  const w = box.w || windowW;
  const h = box.h || windowH;
  const current = screens[index];
  const currentPage = current ? byId.get(current.chapter) : undefined;
  // White chrome over a dark top or foot (the cover, a photo page, a photo band); ink chrome over white.
  const tone = current ? pageTone(current) : { top: "dark" as const, bottom: "dark" as const };
  const lightChrome = tone.top === "dark";
  const chromeColor = lightChrome ? Bold.onDark : Bold.ink;
  const footDark = tone.bottom === "dark";
  const footColor = footDark ? Bold.onDark : Bold.ink;
  const reelState = data?.reel?.status ?? null;
  const top = insets.top + TOP_CHROME;
  const bottom = insets.bottom + BOTTOM_CHROME;
  const slotsHere = current && currentPage ? editSlots(current, currentPage) : [];

  const goTo = (i: number) => {
    const n = Math.max(0, Math.min(screens.length - 1, i));
    if (n === index) return;
    haptics.select();
    list.current?.scrollToIndex({ index: n, animated: !reduce });
    setIndex(n);
  };
  // Tap the left edge to go back, anywhere else to go on (lines and buttons take their own taps first).
  const onTap = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX ?? e.nativeEvent.pageX;
    goTo(x < w * 0.28 ? index - 1 : index + 1);
  };
  const go = (r: string, params?: object) => { haptics.tap(); try { navigation.navigate(r, params); } catch { /* not on this stack */ } };
  const openEdit = (slot: string | null) => {
    if (!current || !currentPage || !slotsHere.length) return;
    haptics.tap();
    setEdit({ page: currentPage, slots: slotsHere, slot: slot ?? (slotsHere.length === 1 ? slotsHere[0] : null) });
  };
  const shareThis = async () => {
    const node = current ? pageRefs.current[current.key] : null;
    setMenu(false);
    if (!node) return;
    try {
      const uri = await captureRef(node, { format: "jpg", quality: 0.92, result: "tmpfile" });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "image/jpeg", UTI: "public.jpeg", dialogTitle: C.share });
    } catch { /* she closed the sheet, or sharing is not here */ }
  };
  const onReel = () => {
    haptics.press();
    if (reelState === "ready") { setWatching(true); return; }
    if (reelState !== "rendering") reel.mutate();
  };

  return (
    <View style={styles.screen} testID="book" {...pan.panHandlers}
      onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {box.h > 0 ? (
        <FlatList
          ref={list}
          data={screens}
          keyExtractor={(p) => p.key}
          horizontal
          pagingEnabled
          initialScrollIndex={Math.min(start, screens.length - 1)}
          getItemLayout={(_, i) => ({ length: w, offset: w * i, index: i })}
          showsHorizontalScrollIndicator={false}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          windowSize={3}
          renderItem={({ item, index: i }) => {
            const page = byId.get(item.chapter);
            if (!page) return <View style={{ width: w, height: h }} />;
            return (
              <Pressable onPress={onTap} accessible={false} style={{ width: w, height: h }}>
                <View ref={(r) => { pageRefs.current[item.key] = r; }} collapsable={false}>
                  <BookScreen
                    rp={item} page={page} firstName={book.firstName} active={i === index} reduce={reduce}
                    w={w} h={h} top={top} bottom={bottom} foot={insets.bottom + BOTTOM_LIFT} end={isBookEnd(i, screens.length)} total={screens.length}
                    onLine={(slot) => openEdit(slot)} go={go} onShare={shareThis}
                  />
                </View>
              </Pressable>
            );
          }}
        />
      ) : null}

      {/* Top chrome: progress segments, close, the screen's label, the menu. */}
      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.segments} pointerEvents="none">
          {screens.map((sc, i) => (
            <View key={sc.key} style={[styles.segment, { backgroundColor: lightChrome ? "rgba(255,255,255,0.3)" : "rgba(14,14,14,0.14)" }]}>
              <View style={[styles.segmentFill, { backgroundColor: chromeColor, width: i <= index ? "100%" : "0%" }]} />
            </View>
          ))}
        </View>
        <View style={styles.header} pointerEvents="box-none">
          <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" testID="book-close" style={[styles.headerBtn, !lightChrome && styles.headerBtnPaper]}>
            <Feather name="x" size={18} color={chromeColor} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: chromeColor }]} numberOfLines={1} testID="book-counter">
            {current && currentPage ? screenTitle(current, currentPage.title).toUpperCase() : ""}
          </Text>
          <Pressable onPress={() => { haptics.tap(); setMenu(true); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="More" testID="book-menu" style={[styles.headerBtn, !lightChrome && styles.headerBtnPaper]}>
            <Feather name="more-horizontal" size={18} color={chromeColor} />
          </Pressable>
        </View>
      </View>

      {/* Bottom chrome: the reel on the cover and the last page; the one quiet Edit pill on every page with a line. */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + BOTTOM_LIFT }]} pointerEvents="box-none">
        {isBookEnd(index, screens.length) ? (
          <Pressable onPress={onReel} style={styles.reelBtn} accessibilityRole="button" testID="book-reel" disabled={reelState === "rendering"}>
            {reelState === "rendering" ? <ActivityIndicator color="#fff" size="small" /> : <Feather name={reelState === "ready" ? "play" : "film"} size={15} color="#fff" />}
            <Text style={styles.reelText}>{reelState === "ready" ? C.reelReady : reelState === "rendering" ? C.reelRendering : reelState === "failed" ? C.reelFailed : C.reel}</Text>
          </Pressable>
        ) : <View />}
        {slotsHere.length ? (
          <Pressable onPress={() => openEdit(null)} style={[styles.editPill, footDark ? styles.editPillDark : styles.editPillWhite]} accessibilityRole="button" testID="book-edit">
            <Feather name="edit-2" size={12} color={footColor} />
            <Text style={[styles.editText, { color: footColor }]}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      <EditSheet
        edit={edit}
        onClose={() => setEdit(null)}
        onSlot={(slot) => setEdit((e) => (e ? { ...e, slot } : e))}
        onPick={(slot, i) => { if (edit) choose.mutate({ page: edit.page.id, slot, index: i }); setEdit(null); }}
        onAsk={(slot) => {
          if (!edit) return;
          const text = lineOf(edit.page, slot) ?? "";
          setEdit(null);
          openMila({ draft: `Rewrite this line in my brand book (${edit.page.title}): "${text}"` });
        }}
      />
      <MenuSheet
        visible={menu}
        onClose={() => setMenu(false)}
        onShare={shareThis}
        onReel={() => { setMenu(false); onReel(); }}
        reelLabel={reelState === "ready" ? C.reelReady : C.reel}
        onRewrite={() => { setMenu(false); haptics.press(); write.mutate(); }}
      />
      {watching && data?.reel?.url ? <ReelModal url={data.reel.url} onClose={() => setWatching(false)} /> : null}
    </View>
  );
}

/** Edit: the screen's lines; pick one, then another version of it — or ask Mila to rewrite it. */
function EditSheet({ edit, onClose, onSlot, onPick, onAsk }: {
  edit: Edit; onClose: () => void; onSlot: (slot: string) => void; onPick: (slot: string, i: number) => void; onAsk: (slot: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const slot = edit?.slot ?? null;
  const line = edit && slot ? edit.page.lines[slot] : null;
  return (
    <Modal visible={!!edit} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} testID="book-edit-sheet">
        {!slot ? (
          <>
            <Text style={styles.sheetTitle}>Which line?</Text>
            {(edit?.slots ?? []).map((sl) => (
              <Pressable key={sl} onPress={() => { haptics.select(); onSlot(sl); }} style={styles.option} accessibilityRole="button">
                <Text style={styles.optionText} numberOfLines={2}>{edit?.page.lines[sl]?.text}</Text>
                <Feather name="chevron-right" size={16} color={Bold.ink} />
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <Text style={styles.sheetTitle}>{C.swapTitle}</Text>
            {(line?.options ?? []).map((o, i) => (
              <Pressable key={i} onPress={() => { haptics.select(); onPick(slot, i); }} style={[styles.option, o === line?.text && styles.optionOn]} accessibilityRole="button" testID={`book-option-${i}`}>
                <Text style={styles.optionText}>{o}</Text>
                {o === line?.text ? <Feather name="check" size={16} color={Bold.ink} /> : null}
              </Pressable>
            ))}
            <Pressable onPress={() => onAsk(slot)} style={styles.ask} accessibilityRole="button" testID="book-ask-mila">
              <Feather name="message-circle" size={16} color={Bold.act} />
              <Text style={styles.askText}>{C.askMila}</Text>
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

/** "…": share this page, the reel, and — only here — writing a fresh version of the whole book. */
function MenuSheet({ visible, onClose, onShare, onReel, reelLabel, onRewrite }: {
  visible: boolean; onClose: () => void; onShare: () => void; onReel: () => void; reelLabel: string; onRewrite: () => void;
}) {
  const insets = useSafeAreaInsets();
  const row = (icon: React.ComponentProps<typeof Feather>["name"], label: string, onPress: () => void, testID: string) => (
    <Pressable onPress={onPress} style={styles.menuRow} accessibilityRole="button" testID={testID}>
      <Feather name={icon} size={16} color={Bold.ink} />
      <Text style={styles.optionText}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        {row("share", C.share, onShare, "book-share")}
        {row("film", reelLabel, onReel, "book-menu-reel")}
        {row("refresh-cw", "Write a fresh version", onRewrite, "book-rewrite")}
      </View>
    </Modal>
  );
}

function ReelModal({ url, onClose }: { url: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(url, (p) => { p.loop = true; p.play(); });
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.reelScreen} testID="book-reel-player">
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
        <View style={[styles.reelHeader, { paddingTop: insets.top + 6 }]}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={styles.headerBtn}><Feather name="x" size={20} color={Bold.onDark} /></Pressable>
          <Text style={[styles.headerTitle, { color: Bold.onDark }]}>{C.studioReel.toUpperCase()}</Text>
          <Pressable onPress={() => { haptics.tap(); void saveRemoteAsset(url, "brand-book-reel.mp4").catch(() => undefined); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Save or share" style={styles.headerBtn}>
            <Feather name="download" size={18} color={Bold.onDark} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Bold.ink },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Bold.paper },

  intro: { flex: 1, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, gap: 12 },
  introClose: { position: "absolute", right: 20, width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: Bold.ground },
  introArt: { width: 200, height: 200, borderRadius: Bold.radius.card },
  introKicker: { ...BoldType.label, color: Bold.mute, marginTop: 10 },
  introTitle: { ...BoldType.screenTitleSm, color: Bold.ink, textAlign: "center" },
  introLine: { ...BoldType.body, fontSize: 16, lineHeight: 23, color: Bold.ink2, textAlign: "center", marginBottom: 8 },
  writeBtn: { backgroundColor: Bold.act, borderRadius: Bold.radius.pill, height: Bold.button, paddingHorizontal: 28, alignItems: "center", justifyContent: "center", marginTop: 8 },
  writeText: { ...BoldType.button, color: Bold.onAct },

  top: { position: "absolute", left: 0, right: 0, top: 0, paddingHorizontal: 14 },
  segments: { flexDirection: "row", gap: 3 },
  segment: { flex: 1, height: 2, borderRadius: 1, overflow: "hidden" },
  segmentFill: { height: 2 },
  header: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  headerBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.28)" },
  headerBtnPaper: { backgroundColor: Bold.ground },
  headerTitle: { flex: 1, textAlign: "center", ...BoldType.label, fontFamily: BoldType.rowTitle.fontFamily, fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },

  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reelBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Bold.act, borderRadius: Bold.radius.pill, height: 44, paddingHorizontal: 20 },
  reelText: { ...BoldType.button, color: Bold.onAct },
  editPill: { flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: 18, borderRadius: Bold.radius.pill, borderWidth: 1 },
  editPillDark: { borderColor: "rgba(255,255,255,0.35)", backgroundColor: "rgba(0,0,0,0.35)" },
  editPillWhite: { borderColor: Bold.line, backgroundColor: Bold.paper },
  editText: { ...BoldType.button },

  scrim: { flex: 1, backgroundColor: Bold.sheetScrim },
  sheet: { backgroundColor: Bold.paper, borderTopLeftRadius: Bold.sheetRadius, borderTopRightRadius: Bold.sheetRadius, padding: 20, gap: 10 },
  sheetTitle: { ...BoldType.section, color: Bold.ink, marginBottom: 4 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: Bold.ground, borderRadius: Bold.radius.card, padding: 14, borderWidth: 1.5, borderColor: "transparent" },
  optionOn: { borderColor: Bold.ink },
  optionText: { ...BoldType.body, fontSize: 15, lineHeight: 21, color: Bold.ink, flex: 1 },
  ask: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  askText: { ...BoldType.button, color: Bold.act },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },

  reelScreen: { flex: 1, backgroundColor: "#000" },
  reelHeader: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 8, backgroundColor: "rgba(0,0,0,0.35)" },
});
