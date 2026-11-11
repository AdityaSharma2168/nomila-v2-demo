// OppCard — one What matters card (PR 4, design approved 7 Oct 2026).
//
// Confirmed brand research with an image → a photo card (brand cover under a scrim). Anything else → a NAME POSTER:
// the brand's name in display type on a colour field picked by opportunity TYPE (POSTER_TOKENS), never a guessed
// brand colour and never her photo. One line, one action — INSIDE the card (owner, 8 Oct 2026: no detached "Reply →"
// under it), worded by the server's next step. The brand's logo chip sits top-right on every card that has a logo source
// (its stored logo, else its evidence domain's favicon), photo or poster. Blue appears only as "Waiting N days"
// (overdue). Nothing on the card is email text: the line, the kind and the dates are derived fields.
import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import type { BoardItem } from "../../hooks/use-opportunity-board";
import { Accent, Bold, Fonts } from "../../constants/theme";
import { HOME_V3 } from "../../lib/flags";
import { LogoMark } from "../ui/LogoMark";
import { useNavigation } from "@react-navigation/native";
import { POSTER_TOKENS, cardAction, cardLogo, cardVisual, footLine, kindChip, monogramOf, moveChip, showSetMinimum } from "./oppBoardLogic";
import { useBrandCandidate } from "../../hooks/use-brand-candidate";
import { ConfirmBrandSheet } from "./ConfirmBrandSheet";
import { cardReplyIntent } from "../deals/dealLetterLogic";
import type { ReplyIntent } from "../../../shared/deals";

interface Props {
  item: BoardItem;
  onOpen: (item: BoardItem) => void;
  /** The card's button, when it is a reply: open the reply sheet on this intent in one tap. Absent → the detail. */
  onReply?: (item: BoardItem, intent: ReplyIntent) => void;
}

function Chip({ text, kind }: { text: string; kind: "dark" | "light" | "blue" }) {
  return (
    <View style={[styles.chip, kind === "dark" && styles.chipDark, kind === "blue" && styles.chipBlue]}>
      <Text style={[styles.chipText, kind !== "light" && styles.chipTextOn]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export function OppCard({ item, onOpen, onReply }: Props) {
  const visual = cardVisual(item);
  const tokens = POSTER_TOKENS[item.poster];
  const ink = visual === "photo" ? Bold.onDark : tokens.ink;
  const kc = kindChip(item);
  const mc = moveChip(item);
  const long = item.brand.name.length > 14;
  const monogram = visual === "poster" ? monogramOf(item) : null;
  // "Confirm this is [brand]": only when Nomila has a candidate to offer (none → no tap).
  // Settled by research, her tap or strong evidence (identity_settled; an older server: research only) → no ask.
  const settled = item.brand.identity_settled ?? item.brand.research_confirmed;
  const askConfirm = !settled && !item.brand.is_person && item.brand.id != null;
  const navigation = useNavigation<any>();
  const setMinimum = showSetMinimum(item);
  const candidate = useBrandCandidate(item.brand.id, askConfirm);
  const [confirming, setConfirming] = useState(false);
  const logo = cardLogo(item);
  const action = cardAction(item);
  // A reply button opens the reply sheet straight away (one tap); the card body still opens the detail.
  const replyIntent = onReply ? cardReplyIntent(item) : null;
  const foot = footLine(item);
  const lightPoster = visual === "poster" && tokens.ink !== Bold.onDark;
  const logoChip = logo ? <LogoMark bold logoUrl={logo.logoUrl} domain={logo.domain} name={item.brand.name} size={30} /> : null;

  const body = (
    <View style={styles.inner}>
      {/* The big name on every card; on a photo it sits on the top scrim. */}
      <View style={styles.posterTop}>
        <View style={styles.nameCol}>
          <Text style={[styles.posterName, long && styles.posterNameLong, { color: ink }]} numberOfLines={3}>
            {item.brand.name}
          </Text>
          {item.brand_rollup ? <Text style={[styles.rollup, { color: ink }]} numberOfLines={1}>{item.brand_rollup.line}</Text> : null}
        </View>
        {logoChip}
      </View>
      <View style={styles.foot}>
        <View style={styles.chips}>
          {kc && <Chip text={kc.text} kind={kc.dark ? "dark" : "light"} />}
          {item.via && <Chip text={`via ${item.via}`} kind="light" />}
          {item.pitched_by_you && <Chip text="Pitched by you" kind="light" />}
          {mc && <Chip text={mc.text} kind={mc.overdue ? "blue" : "light"} />}
        </View>
        <Text style={[styles.line, { color: ink }]} numberOfLines={3}>{item.line}</Text>
        <View style={styles.actionRow}>
          <Text style={[styles.cardCaption, { color: ink }]} numberOfLines={1}>{foot}</Text>
          <Pressable
            onPress={() => (replyIntent ? onReply!(item, replyIntent) : onOpen(item))}
            hitSlop={8}
            style={({ pressed }) => [styles.inAction, lightPoster && styles.inActionOnLight, pressed && { transform: [{ scale: Bold.pressScale }] }]}
            accessibilityRole="button"
            accessibilityLabel={`${action}: ${item.brand.name}`}
            testID={`opp-card-action-${item.opportunity_id}`}
          >
            <Text style={styles.inActionT} numberOfLines={1}>{action}</Text>
            <Feather name="arrow-right" size={13} color={HOME_V3 ? Bold.onDark : Bold.ink} />
          </Pressable>
        </View>
        {setMinimum ? (
          <Pressable onPress={() => navigation.navigate("Home", { screen: "YourRates" })} hitSlop={6} style={styles.confirm} accessibilityRole="link" testID={`opp-card-set-minimum-${item.opportunity_id}`}>
            <Feather name="sliders" size={12} color={ink} />
            <Text style={[styles.confirmT, { color: ink }]}>Set your minimum</Text>
          </Pressable>
        ) : null}
        {/* Inside its own card, so it can't read as belonging to the next one. */}
        {askConfirm && candidate.data ? (
          <Pressable onPress={() => setConfirming(true)} hitSlop={6} style={styles.confirm} accessibilityRole="button">
            <Feather name="check-circle" size={12} color={ink} />
            <Text style={[styles.confirmT, { color: ink }]}>Confirm this is {item.brand.name}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onOpen(item)}
        style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: Bold.pressScale }] }]}
        accessibilityRole="button"
        accessibilityLabel={`${item.brand.name}. ${item.brand_rollup ? `${item.brand_rollup.line}. ` : ""}${item.line}`}
      >
        {visual === "photo" ? (
          <>
            <Image source={{ uri: item.brand.image_url! }} style={StyleSheet.absoluteFill} contentFit="cover" />
            {/* The existing dark scrim, top and bottom, so the big name and the line read on any photo. */}
            <LinearGradient colors={[Bold.cardScrim, "rgba(0,0,0,0.5)", Bold.cardScrim]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
          </>
        ) : (
          <>
            <LinearGradient colors={[tokens.from, tokens.mid, tokens.to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            {monogram ? (
              <Text style={[styles.monogram, { color: tokens.ink }]} numberOfLines={1} importantForAccessibility="no" accessibilityElementsHidden>
                {monogram}
              </Text>
            ) : null}
          </>
        )}
        {body}
      </Pressable>
      {confirming && candidate.data && item.brand.id != null ? (
        <ConfirmBrandSheet brandId={item.brand.id} brandName={item.brand.name} candidate={candidate.data} onClose={() => setConfirming(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:           { gap: 8 },
  card:           { minHeight: 170, borderRadius: Bold.radius.card, overflow: "hidden", backgroundColor: Bold.heroBlank },
  inner:          { flex: 1, minHeight: 170, padding: 14, justifyContent: "space-between", gap: 14 },
  posterTop:      { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  monogram:       { position: "absolute", right: -18, bottom: -46, fontFamily: "Outfit_900Black", fontSize: 220, lineHeight: 230, opacity: 0.09, textTransform: "uppercase" },
  confirm:        { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  confirmT:       { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: Bold.ink2 },
  nameCol:        { flex: 1, gap: 4 },
  rollup:         { fontFamily: Fonts.bodySemiBold, fontSize: 12, opacity: 0.85 },
  posterName:     { fontFamily: "Outfit_900Black", fontSize: 30, lineHeight: 30, textTransform: "uppercase", letterSpacing: -0.6 },
  posterNameLong: { fontSize: 23, lineHeight: 24 },
  foot:           { gap: 7 },
  chips:          { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:           { backgroundColor: Bold.paper, borderRadius: Bold.radius.chip, paddingHorizontal: 7, paddingVertical: 4 },
  chipDark:       { backgroundColor: Bold.ink },
  // HOME_V3: the brand colours back as accents — "needs you" (overdue) and the card's ONE action in pink. Off: as before.
  chipBlue:       { backgroundColor: HOME_V3 ? Accent.pink : Bold.blue },
  chipText:       { fontFamily: "Outfit_900Black", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: Bold.ink },
  chipTextOn:     { color: Bold.onDark },
  line:           { fontFamily: Fonts.bodyMedium, fontSize: 13, lineHeight: 17 },
  actionRow:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 2 },
  cardCaption:    { flex: 1, fontFamily: Fonts.body, fontSize: 12, opacity: 0.8 },
  // DESIGN.md §11 Button "small" in its on-photo form: white fill, ink type, corner 4 — the card's ONE action.
  inAction:       { flexDirection: "row", alignItems: "center", gap: 6, height: Bold.buttonSmall, paddingHorizontal: 12, borderRadius: Bold.radius.control, backgroundColor: HOME_V3 ? Accent.pink : Bold.paper },
  inActionOnLight:HOME_V3 ? {} : { borderWidth: 1.5, borderColor: Bold.ink },
  inActionT:      { fontFamily: "Outfit_800ExtraBold", fontSize: 11, letterSpacing: 0.9, textTransform: "uppercase", color: HOME_V3 ? Bold.onDark : Bold.ink },
});
