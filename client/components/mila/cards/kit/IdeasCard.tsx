/**
 * cards/kit/IdeasCard — post ideas from their idea bank (design v2.2 "Idea"; Muse's in-feed promo carousel). Collapsed:
 * a swipeable row of tall cards (photo ≈ 60%, a bold headline of ≤ 3 lines, ONE full-width soft "Make it", which goes
 * straight to Studio). A tap on a card's body expands THAT idea in place under the row (chat): its picture, ⋯ (Not now ·
 * Don't suggest this), the headline, why now, the moment, a raspberry "Make it in Studio" and "Not now". On a screen the
 * body opens it in Studio. Only items scrolled into view are recorded as seen. Nothing posts: Studio makes a draft.
 */
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { IdeaItem, MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { MilaButton } from "../../../agent/parts";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { useCardHost, useExpand } from "./host";
import { CardBody, CardFrame, CardMedia, Chevron, Receipt, styles } from "./parts";

type Ideas = Extract<MilaCardDto, { type: "ideas" }>["data"];
const FORMAT: Record<string, string> = { reel: "Reel", carousel: "Carousel", story: "Story", feed: "Post" };
const formatChip = (i: IdeaItem) => [i.format ? FORMAT[i.format] : null, i.length].filter(Boolean).join(" · ");

export function IdeasCard({ data, initialExpanded = false }: { data: Ideas; initialExpanded?: boolean }) {
  const items = data.fields.items;
  const host = useCardHost();
  const h = useAgentCardHandlers();
  const { width } = useWindowDimensions();
  const cardW = Math.round(Math.min(width, 440) * 0.72);
  const [openIx, setOpenIx] = useState(initialExpanded ? 0 : -1);
  const [, toggle] = useExpand(data.id, initialExpanded);
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [gone, setGone] = useState<Record<string, true>>({});
  const seen = React.useRef(new Set<string>());
  const markSeen = (upTo: number) => {
    for (const it of items.slice(0, upTo + 1)) if (!seen.current.has(it.ideaId)) { seen.current.add(it.ideaId); void host.record({ card: "idea", ref: it.ideaId, outcome: "seen" }); }
  };
  // The first item is in view from the start.
  React.useEffect(() => { markSeen(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => markSeen(Math.floor((e.nativeEvent.contentOffset.x + e.nativeEvent.layoutMeasurement.width - 1) / (cardW + 10)));

  const makeIt = async (it: IdeaItem) => {
    const r = await host.record({ card: "idea", ref: it.ideaId, outcome: "accepted", action: "idea_used" });
    if (r == null) return;
    setReceipts((x) => ({ ...x, [it.ideaId]: r || "Draft started in Studio." }));
    h.openLink?.(it.studio as never);
  };
  const rest = async (it: IdeaItem, outcome: "not_now" | "never") => {
    const r = await host.record({ card: "idea", ref: it.ideaId, outcome });
    if (r == null) return;
    if (outcome === "never") setReceipts((x) => ({ ...x, [it.ideaId]: r || "I won't suggest this one again." }));
    setGone((g) => ({ ...g, [it.ideaId]: true }));
    setOpenIx(-1);
  };
  const live = items.filter((i) => !gone[i.ideaId] || receipts[i.ideaId]);
  const tapBody = (ix: number) => {
    const it = items[ix];
    if (host.surface === "screen") { h.openLink?.(it.studio as never); return; }
    setOpenIx(openIx === ix ? -1 : ix);
    if (openIx === -1 || openIx === ix) toggle();
  };
  const open = openIx >= 0 ? items[openIx] : null;

  return (
    <View style={k.wrap} testID={`card-ideas-${open ? "expanded" : "collapsed"}`}>
      {live.length > 1 || !open ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={cardW + 10} decelerationRate="fast" onScroll={onScroll} scrollEventThrottle={64} contentContainerStyle={k.row} style={k.scroller}>
          {live.map((it) => {
            const ix = items.indexOf(it);
            return (
              <CardFrame key={it.ideaId} style={{ width: live.length === 1 ? undefined : cardW, flex: live.length === 1 ? 1 : undefined }} testID="card-idea-item">
                <CardBody onPress={() => tapBody(ix)} label={`${it.headline}, ${host.surface === "screen" ? "open in Studio" : "see more"}`} expanded={host.surface === "chat" ? openIx === ix : undefined}>
                  <CardMedia media={it.media} shape="promo" kindLabel="Idea" faceKey={`${data.id}:${it.ideaId}`} glyph="film"
                    overlay={formatChip(it) ? <View style={k.formatChip}><Text style={k.formatText}>{formatChip(it)}</Text></View> : null} />
                  <View style={[styles.body, { gap: 10 }]}>
                    <Text style={styles.headline} numberOfLines={3}>{it.headline}</Text>
                  </View>
                </CardBody>
                <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                  {receipts[it.ideaId] ? <Receipt line={receipts[it.ideaId]} /> : (
                    <MilaButton tone="soft" label="Make it" onPress={() => void makeIt(it)} style={styles.fullBtn} testID="card-idea-make" />
                  )}
                </View>
              </CardFrame>
            );
          })}
        </ScrollView>
      ) : null}
      {live.length > 1 ? (
        <View style={k.dots}>{live.map((it, i) => <View key={it.ideaId} style={[k.dot, (openIx < 0 ? i === 0 : items[openIx] === it) && k.dotOn]} />)}</View>
      ) : null}
      {open && host.surface === "chat" ? <IdeaDetail it={open} faceKey={`${data.id}:${open.ideaId}:open`} receipt={receipts[open.ideaId]} onMake={() => void makeIt(open)} onRest={(o) => void rest(open, o)} onClose={() => tapBody(openIx)} /> : null}
    </View>
  );
}

function IdeaDetail({ it, faceKey, receipt, onMake, onRest, onClose }: { it: IdeaItem; faceKey: string; receipt?: string; onMake: () => void; onRest: (o: "not_now" | "never") => void; onClose: () => void }) {
  const [menu, setMenu] = useState(false);
  return (
    <CardFrame testID="card-idea-detail">
      <View>
        <CardMedia media={it.media} shape="band" kindLabel="Idea" faceKey={faceKey} glyph="film" />
        <Pressable onPress={() => setMenu((m) => !m)} accessibilityRole="button" accessibilityLabel="More options" style={k.more} testID="card-idea-menu">
          <Feather name="more-horizontal" size={16} color={Bold.ink} />
        </Pressable>
        {menu ? (
          <View style={k.menu}>
            <Pressable onPress={() => onRest("not_now")} accessibilityRole="button" style={k.menuItem}><Text style={k.menuText}>Not now</Text></Pressable>
            <Pressable onPress={() => onRest("never")} accessibilityRole="button" style={[k.menuItem, k.menuLine]} testID="card-idea-never"><Text style={k.menuText}>Don't suggest this</Text></Pressable>
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <CardBody onPress={onClose} label={`${it.headline}, collapse`} expanded>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
            <Text style={[styles.headline, { flex: 1 }]}>{it.headline}</Text>
            <Chevron open />
          </View>
        </CardBody>
        <Text style={styles.line}>{it.line}</Text>
        {it.moment ? <Text style={styles.meta}>{it.moment.label}</Text> : null}
        {receipt ? <Receipt line={receipt} /> : (
          <View style={styles.acts}>
            <MilaButton tone="primary" label="Make it in Studio" onPress={onMake} testID="card-idea-make-studio" />
            <MilaButton tone="soft" label="Not now" onPress={() => onRest("not_now")} testID="card-idea-not-now" />
          </View>
        )}
      </View>
    </CardFrame>
  );
}

const k = StyleSheet.create({
  wrap: { gap: 10 },
  scroller: { marginHorizontal: -16, overflow: "visible" },
  row: { gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 18 },
  formatChip: { position: "absolute", right: 10, top: 10, borderRadius: 999, backgroundColor: "rgba(14,14,14,0.6)", paddingVertical: 5, paddingHorizontal: 8 },
  formatText: { ...BoldType.cardKind, letterSpacing: 0.6, color: Bold.onDark },
  dots: { flexDirection: "row", gap: 5, justifyContent: "center", marginTop: -8 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.line },
  dotOn: { width: 16, backgroundColor: Bold.ink },
  more: { position: "absolute", right: 8, top: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.88)", alignItems: "center", justifyContent: "center" },
  menu: { position: "absolute", right: 8, top: 40, backgroundColor: Bold.paper, borderRadius: 14, padding: 6, minWidth: 170, shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 15, shadowOffset: { width: 0, height: 10 }, elevation: 4 },
  menuItem: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 9 },
  menuLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  menuText: { ...BoldType.sigLabel, color: Bold.ink },
});
