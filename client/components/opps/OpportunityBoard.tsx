// OpportunityBoard — the Opportunities tab root (PR 4, design approved 7 Oct 2026). Behind EXPO_PUBLIC_OPPS_BOARD.
//
// One screen, three parts, all in the server's ONE order (GET /me/opportunities): What matters (up to five cards),
// the ask-for-terms batch when needs-terms brands fall below the cut, In motion (stage + whose move), and Explore all
// (the rest in order, then the held "To verify" block, then what was filed). No score anywhere. Nothing here is
// stored email text: every line is a derived field; the email itself opens in the thread, read live.
import React, { useState } from "react";
import { Image, View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LogoMark } from "../ui/LogoMark";
import { usePullRefresh, pullRefresh } from "../ui/PullRefresh";
import { Bold, Fonts } from "../../constants/theme";
import { useOpportunityBoard, type BoardItem } from "../../hooks/use-opportunity-board";
import { OppCard } from "./OppCard";
import { Image as ExpoImage } from "expo-image";
import { cardLogo, whatMattersHead } from "./oppBoardLogic";
import { SeriousOffersSection } from "../partner/SeriousOffers";
import { HOME_V3, OPPS_V2 } from "../../lib/flags";
import { BoardReplySheet } from "./BoardReplySheet";
import type { ReplyIntent } from "../../../shared/deals";

// The empty state's one picture (DESIGN.md §13, illustration tier: empty states only).
const EMPTY_ART = require("../../assets/illustrations/empty-offers.jpg");

interface Props {
  onOpenItem: (item: BoardItem) => void;
  onAskTerms: () => void;
  onOpenFiltered: () => void;
  /** The tab root's title row, drawn at the top of the board's scroll (as Strategy's scrolls with its content). */
  header?: React.ReactNode;
  /** What follows the deals in the same scroll (app layout B: the Bookings and Shop sections). */
  footer?: React.ReactNode;
  /** The screen's own reads to refetch with the board on a pull (the money strip, the sections). */
  onRefresh?: () => Promise<unknown> | unknown;
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={styles.sh}>
      <Text style={styles.shTitle}>{title}</Text>
      {sub ? <Text style={styles.shSub}>{sub}</Text> : null}
    </View>
  );
}

/** The row's picture: the brand's cover when its imagery is trusted, else its logo on white, else the initial. */
function RowThumb({ item }: { item: BoardItem }) {
  const logo = cardLogo(item);
  if (item.brand.image_url) {
    return <ExpoImage source={{ uri: item.brand.image_url }} style={styles.thumb} contentFit="cover" accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[styles.thumb, styles.thumbLogo]}>
      <LogoMark bold logoUrl={logo?.logoUrl ?? null} domain={logo?.domain ?? null} name={item.brand.name} size={44} />
    </View>
  );
}

function Row({ item, onPress, detail }: { item: BoardItem; onPress: () => void; detail: string }) {
  // No "Waiting N days" here: the line already says "Waiting on you since …" (one statement, not two).
  return (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button">
      <RowThumb item={item} />
      <View style={styles.rowTxt}>
        <Text style={styles.rowT} numberOfLines={1}>{item.brand.name}</Text>
        {item.brand_rollup ? <Text style={styles.rowRollup} numberOfLines={1}>{item.brand_rollup.line}</Text> : null}
        <Text style={styles.rowM} numberOfLines={2}>{detail}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={Bold.quiet} />
    </Pressable>
  );
}

export function OpportunityBoard({ onOpenItem, onAskTerms, onOpenFiltered, header, footer, onRefresh }: Props) {
  const { data, isLoading, error, refetch } = useOpportunityBoard();
  const pull = usePullRefresh(() => Promise.all([refetch(), onRefresh?.()]));
  // OPPS_V2: a card's Reply opens the reply sheet here, in one tap (the card body still opens the detail).
  const [replyFor, setReplyFor] = useState<{ item: BoardItem; intent: ReplyIntent } | null>(null);
  const onReply = OPPS_V2 ? (item: BoardItem, intent: ReplyIntent) => setReplyFor({ item, intent }) : undefined;

  if (isLoading || error || !data) {
    return (
      <ScrollView contentContainerStyle={styles.stateIn} refreshControl={pullRefresh(pull)}>
        {header}
        <View style={styles.center}>
          {isLoading ? <ActivityIndicator color={Bold.ink} /> : (
            <>
              <Text style={styles.muted}>Couldn’t load your opportunities.</Text>
              <Pressable onPress={() => refetch()} hitSlop={8}><Text style={styles.link}>Try again</Text></Pressable>
            </>
          )}
        </View>
      </ScrollView>
    );
  }

  const { whatMatters, needsTermsBatch, inMotion, explore, toVerify, goingQuiet, counts } = data;
  const quiet = goingQuiet.slice(0, 1); // shown once, after the five
  const head = whatMattersHead(data);

  return (
    <ScrollView contentContainerStyle={styles.in} refreshControl={pullRefresh(pull)} testID="opportunity-board">
      {header}
      {/* Mount point (Partner door): "Serious offers" first, when the flag is on and a brand placed a hold. */}
      <SeriousOffersSection items={data.seriousOffers} onOpenItem={onOpenItem} />
      {/* The same heading, list and count as Home's "What matters next" (the board's needsYou). */}
      <SectionHead title={head.title} sub={head.sub ?? undefined} />
      {whatMatters.length === 0 ? (
        HOME_V3 ? (
          <View style={styles.emptyArtWrap} testID="opps-empty-art">
            <Image source={EMPTY_ART} style={styles.emptyArt} accessibilityIgnoresInvertColors />
            <Text style={styles.muted}>Nothing waiting on you right now.</Text>
          </View>
        ) : <Text style={styles.muted}>Nothing waiting on you right now.</Text>
      ) : (
        whatMatters.map((it) => <OppCard key={it.opportunity_id} item={it} onOpen={onOpenItem} onReply={onReply} />)
      )}
      {quiet.map((it) => <OppCard key={`q-${it.opportunity_id}`} item={{ ...it, line: `Going quiet · ${it.line}` }} onOpen={onOpenItem} onReply={onReply} />)}

      {needsTermsBatch.length > 0 && (
        <Pressable onPress={onAskTerms} style={styles.batch} accessibilityRole="button">
          <Text style={styles.batchT}>Ask {needsTermsBatch.length} {needsTermsBatch.length === 1 ? "brand" : "brands"} what they’re looking for</Text>
          <Text style={styles.batchM}>Each email asks what they have in mind, never your rate. Open and approve each one; only approved emails are sent.</Text>
          <View style={styles.batchLink}><Text style={styles.batchLinkT}>Review</Text><Feather name="arrow-right" size={13} color={Bold.blueOnDark} /></View>
        </Pressable>
      )}

      {inMotion.length > 0 && (
        <>
          <SectionHead title="In motion" sub="Under way. Where each one stands." />
          <View style={styles.card}>
            {inMotion.map((it) => (
              <Row key={it.opportunity_id} item={it} onPress={() => onOpenItem(it)}
                   detail={[it.stage, it.whats_new?.text ?? null].filter(Boolean).join(" · ")} />
            ))}
          </View>
        </>
      )}

      <SectionHead title="More opportunities" />
      <View style={styles.card}>
        {/* "<N> more · <M> filed": N is the rows below; "M filed" opens the filed view (the board's one door to it). */}
        <View style={styles.countsRow} testID="more-counts">
          {explore.length > 0 ? <Text style={styles.counts}>{`${explore.length} more · `}</Text> : null}
          <Pressable onPress={onOpenFiltered} hitSlop={8} accessibilityRole="link" accessibilityLabel={`${counts.filed} filed. Open what Nomila filed`} testID="filed-link">
            <Text style={styles.countsLink}>{`${counts.filed} filed`}</Text>
          </Pressable>
        </View>
        {explore.map((it) => <Row key={it.opportunity_id} item={it} onPress={() => onOpenItem(it)} detail={it.line} />)}
      </View>
      {toVerify.length > 0 && (
        <View style={styles.held}>
          <Text style={styles.eyebrow}>To verify · held</Text>
          {toVerify.map((it) => <Row key={it.opportunity_id} item={it} onPress={() => onOpenItem(it)} detail={it.line} />)}
        </View>
      )}
      {footer}
      {replyFor ? (
        <BoardReplySheet
          item={replyFor.item}
          intent={replyFor.intent}
          onClose={() => setReplyFor(null)}
          onSent={() => { void refetch(); }}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  in:        { paddingHorizontal: Bold.gutter, paddingTop: 4, gap: 14, paddingBottom: 48 },
  stateIn:   { flexGrow: 1, paddingHorizontal: Bold.gutter, paddingTop: 4 },
  center:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  emptyArtWrap: { alignItems: "center", gap: 8, paddingVertical: 8 },
  emptyArt:  { width: 96, height: 96 },
  sh:        { gap: 2, marginTop: 6 },
  shTitle:   { fontFamily: "Outfit_900Black", fontSize: 18, textTransform: "uppercase", letterSpacing: -0.2, color: Bold.ink },
  shSub:     { fontFamily: Fonts.body, fontSize: 13, color: Bold.mute },
  muted:     { fontFamily: Fonts.body, fontSize: 14, color: Bold.mute },
  link:      { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.blue },
  card:      { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, paddingHorizontal: 12 },
  row:       { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  rowTxt:    { flex: 1, gap: 2 },
  thumb:     { width: 60, height: 60, borderRadius: 12, overflow: "hidden", backgroundColor: Bold.heroBlank },
  thumbLogo: { backgroundColor: "#FFFFFF", borderWidth: StyleSheet.hairlineWidth, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
  rowT:      { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Bold.ink },
  rowRollup: { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Bold.ink2 },
  rowM:      { fontFamily: Fonts.body, fontSize: 13, color: Bold.ink2 },
  countsRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingVertical: 10 },
  counts:    { fontFamily: Fonts.body, fontSize: 13, color: Bold.mute },
  countsLink:{ fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.blue },
  held:      { borderWidth: 1.5, borderStyle: "dashed", borderColor: "#8A5A00", borderRadius: Bold.radius.card, paddingHorizontal: 12, paddingTop: 10 },
  eyebrow:   { fontFamily: "Outfit_900Black", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Bold.mute },
  batch:     { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, padding: 16, gap: 6 },
  batchT:    { fontFamily: "Outfit_900Black", fontSize: 18, color: Bold.onDark, textTransform: "uppercase", letterSpacing: -0.2 },
  batchM:    { fontFamily: Fonts.body, fontSize: 13, color: Bold.onDarkLabel },
  batchLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  batchLinkT:{ fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.blueOnDark },
});
