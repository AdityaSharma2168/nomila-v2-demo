// OppDeck — the brand deck at the top of a card's detail (PR 4 detail slice, approved 7 Oct 2026).
//
// CONFIRMED research → the brand's own pages: its images (swipeable) with the identity line, then about / athletes /
// audience panels. Anything else → the NAME POSTER for the opportunity's type (POSTER_TOKENS), with a monogram
// (never for a person), a safe logo when there is one, why there's no research, and "Confirm this is [brand]"
// when Nomila has a candidate. Never her photo.
import React, { useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { Bold, Fonts } from "../../constants/theme";
import { LogoMark } from "../ui/LogoMark";
import { StackHeader } from "../ui/StackHeader";
import type { OpportunityDetail } from "../../hooks/use-opportunity-detail";
import { POSTER_TOKENS, monogramOf } from "./oppBoardLogic";
import { useBrandCandidate } from "../../hooks/use-brand-candidate";
import { ConfirmBrandSheet } from "./ConfirmBrandSheet";
import { OPPS_LABEL } from "../../lib/flags";

const H = Bold.deck.height;
/**
 * The unconfirmed NAME POSTER is about half a deck (owner, 7 Oct 2026): there are no pages to swipe, so the letter starts
 * higher. A floor, not a clamp — a long name or a "Confirm this is …" grows it rather than clipping. A confirmed brand's
 * deck (real pages) keeps the full deck height.
 */
export const POSTER_HEIGHT = Math.round(H / 2);
const BAR = 52; // the pushed-screen bar riding over the top (StackHeader bold)

/** The pushed screen's parent, as the back label reads it (DESIGN.md §11 Shell: "‹ OPPORTUNITIES"). */
export const OPPS_PARENT = OPPS_LABEL;

/**
 * ‹ OPPORTUNITIES over the top of the deck: the shared pushed-screen bar (StackHeader bold — 52 high, 16 gutter), white
 * on a dark page, ink on a light poster. The screen's root is a SafeAreaView, so the bar sits below the status bar.
 */
function Back({ onBack, light, right }: { onBack: () => void; light: boolean; right?: React.ReactNode }) {
  return (
    <View style={styles.top} pointerEvents="box-none">
      <StackHeader title={OPPS_PARENT} bold dark={light} onBack={onBack} right={right} />
    </View>
  );
}

export function OppDeck({ detail, onBack }: { detail: OpportunityDetail; onBack: () => void }) {
  const { width } = useWindowDimensions();
  const { item, deck } = detail;
  const [page, setPage] = useState(0);
  const askConfirm = !deck.confirmed && !item.brand.is_person && item.qualification !== "verify_first" && item.brand.id != null;
  const candidate = useBrandCandidate(item.brand.id, askConfirm);
  const [confirming, setConfirming] = useState(false);

  if (deck.confirmed) {
    // Page 1 is identity (her brand's cover); then one page per research field that exists. Never her photo.
    const cover = deck.images[0] ?? null;
    const panels: Array<{ title: string; body?: string; chips?: string[]; img: string | null }> = [];
    if (deck.description) panels.push({ title: `About ${deck.name}`, body: deck.description, img: deck.images[1] ?? cover });
    if (deck.athletes.length) panels.push({ title: "Athletes they work with", chips: deck.athletes, img: deck.images[2] ?? cover });
    if (deck.audience) panels.push({ title: "Their audience", body: deck.audience, chips: deck.sports, img: deck.images[3] ?? cover });
    const total = 1 + panels.length;
    const bg = (uri: string | null) => (
      <>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        <LinearGradient colors={[Bold.deck.scrimTop, Bold.deck.scrimMid, Bold.deck.scrimFoot]} style={StyleSheet.absoluteFill} />
      </>
    );
    return (
      <View style={{ height: H }}>
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}
                    onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}>
          <View style={{ width, height: H, backgroundColor: Bold.heroBlank }}>{bg(cover)}</View>
          {panels.map((p, k) => (
            <View key={k} style={{ width, height: H, backgroundColor: Bold.heroBlank }}>
              {bg(p.img)}
              <View style={styles.panel}>
                <Text style={styles.panelT}>{p.title}</Text>
                {p.body ? <Text style={styles.panelB} numberOfLines={6}>{p.body}</Text> : null}
                {p.chips?.length ? <View style={styles.panelChips}>{p.chips.slice(0, 8).map((c) => <Text key={c} style={styles.panelChip}>{c}</Text>)}</View> : null}
              </View>
            </View>
          ))}
        </ScrollView>
        <Back onBack={onBack} light right={total > 1 ? <View style={styles.counter}><Text style={styles.counterT}>{page + 1} / {total}</Text></View> : null} />
        {page === 0 ? <View style={styles.ident}>
          <Text style={styles.identName} numberOfLines={2}>{deck.name}</Text>
          {deck.category ? <Text style={styles.identCat}>{deck.category}</Text> : null}
        </View> : null}
      </View>
    );
  }

  const t = POSTER_TOKENS[item.poster];
  const mono = monogramOf(item);
  return (
    <View style={styles.poster} testID="opp-poster">
      <LinearGradient colors={[t.from, t.mid, t.to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {mono ? <Text style={[styles.mono, { color: t.ink }]} importantForAccessibility="no" accessibilityElementsHidden>{mono}</Text> : null}
      <Back onBack={onBack} light={t.ink === Bold.onDark} />
      <View style={styles.posterIn}>
        {item.brand.safe_logo_url ? <LogoMark logoUrl={item.brand.safe_logo_url} name={deck.name} size={36} /> : null}
        <Text style={[styles.posterName, { color: t.ink }]} numberOfLines={2}>
          {item.qualification === "verify_first" ? `“${deck.name}”` : deck.name}
        </Text>
        <View style={styles.noteRow}>
          <Feather name={item.qualification === "verify_first" ? "alert-triangle" : "info"} size={13} color={t.ink} />
          {/* One sentence: the specific reason when the server has one, else the general line — never both. */}
          <Text style={[styles.note, { color: t.ink }]}>{deck.unconfirmed_reason || "Nomila couldn’t confirm who this is yet."}</Text>
        </View>
        {askConfirm && candidate.data ? (
          <Pressable onPress={() => setConfirming(true)} style={[styles.confirm, { borderColor: t.ink }]} accessibilityRole="button">
            <Feather name="check-circle" size={13} color={t.ink} />
            <Text style={[styles.confirmT, { color: t.ink }]}>Confirm this is {deck.name}</Text>
          </Pressable>
        ) : null}
      </View>
      {confirming && candidate.data && item.brand.id != null ? (
        <ConfirmBrandSheet brandId={item.brand.id} brandName={deck.name} candidate={candidate.data} onClose={() => setConfirming(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  top:        { position: "absolute", top: 0, left: 0, right: 0, zIndex: 2 },
  counter:    { backgroundColor: Bold.deck.counter, borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 3 },
  counterT:   { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Bold.onDark },
  ident:      { position: "absolute", left: Bold.gutter, right: Bold.gutter, bottom: Bold.deck.foot, gap: 2 },
  identName:  { fontFamily: "Outfit_900Black", fontSize: 30, color: Bold.onDark, textTransform: "uppercase", letterSpacing: -0.6 },
  identCat:   { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.onDarkSoft },
  panel:      { position: "absolute", left: Bold.gutter, right: Bold.gutter, bottom: Bold.deck.foot, backgroundColor: Bold.deck.panel, borderWidth: 1, borderColor: Bold.deck.panelLine, borderRadius: Bold.radius.card, padding: 12, gap: 6 },
  panelT:     { fontFamily: "Outfit_900Black", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Bold.onDarkLabel },
  panelB:     { fontFamily: Fonts.body, fontSize: 14, lineHeight: 19, color: Bold.onDark },
  panelChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  panelChip:  { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Bold.onDark, borderWidth: 1, borderColor: Bold.deck.chipLine, borderRadius: Bold.radius.chip, paddingHorizontal: 7, paddingVertical: 3 },
  poster:     { minHeight: POSTER_HEIGHT, overflow: "hidden" },
  mono:       { position: "absolute", right: -18, bottom: -46, fontFamily: "Outfit_900Black", fontSize: 220, lineHeight: 230, opacity: 0.08, textTransform: "uppercase" },
  posterIn:   { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingTop: BAR, paddingBottom: Bold.deck.overlap + 12, gap: 6 },
  posterName: { fontFamily: "Outfit_900Black", fontSize: 30, lineHeight: 30, textAlign: "center", textTransform: "uppercase", letterSpacing: -0.6 },
  noteRow:    { flexDirection: "row", alignItems: "center", gap: 6 },
  note:       { fontFamily: Fonts.bodySemiBold, fontSize: 13 },
  why:        { fontFamily: Fonts.body, fontSize: 12, textAlign: "center", opacity: 0.75 },
  confirm:    { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: Bold.radius.control, paddingHorizontal: 10, paddingVertical: 7, marginTop: 4 },
  confirmT:   { fontFamily: Fonts.bodyBold, fontSize: 13 },
});
