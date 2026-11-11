// HomeBriefing — the three briefing sections under Home's hero (DESIGN.md "Home", look B), in this order:
//
//   ScoreBlock       "Your marketability": the ONE black block on the screen — the ring glowing with the number inside,
//                    Nomila's served read in full (never clipped), the quiet confidence line, the capital legend, and
//                    "Open My Intelligence"
//   NextList         "What matters next": ONE ranked list across every tab, five rows at most, each opening where it is
//                    handled; "See all N" → Opportunities when more than five wait; empty → "Nothing waiting on you", one
//                    line, and the link to her Plan
//   MilaChips        "Mila can help with…": Mila's frosted chips (DESIGN.md §16) from her open requests + imputed signals;
//                    hidden when empty.
//                    Its heading leads with Mila's idle still (a small plain circle, no ring — the Muse look, DESIGN.md
//                    §16), the same image the Ask Mila overlay shows beside her name
//
// Each is fed served data by HomeScreen; nothing here fetches, decides or answers. BoldType roles only.

import React from "react";
import { View, Text, Pressable, StyleSheet, Image, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { IntelligenceRing, RingLegend } from "../intelligence/IntelligenceRing";
import { ConfidenceLine } from "../intelligence/ConfidenceLine";
import { Card, Eyebrow, IconTile, LinkText, LogoMark, SectionHead, useReducedMotion } from "../ui";
import { Frost } from "../mila/Frost";
import { HOME_COPY, type MilaChip } from "../../lib/strategyLogic";
import { NEXT_COPY, rowCopy, type NextCandidate, type NextKind, type RankedNext } from "../../lib/whatMattersNext";
import type { RingBand } from "../../lib/myIntelligenceLogic";
import { Bold, BoldType } from "../../constants/theme";

type IconName = React.ComponentProps<typeof Feather>["name"];
/** The frosted chip's corner (DESIGN.md §16: Mila's chips are corner 17). */
const MILA_CHIP_RADIUS = 17;
/** Her still (the idle loop's first frame) — the same image as beside "Mila" in the Ask Mila overlay. */
const MILA_STILL = require("../../../assets/mila/mila-still.png");
const MILA_GLYPH = 18;

/**
 * Home's score block. The optional props let the onboarding M.I.A. preview REUSE it as is (owner, 9 Oct 2026: keep the
 * Home ring and build on it): `footer` replaces the "Open My Intelligence" link, and without `onPress` the block is not
 * a button. Home passes neither and is unchanged.
 */
export function ScoreBlock({ score, early, line, confidence, bands, preliminary, preliminaryLine, onPress, footer, style, testID = "home-intelligence" }: {
  score: number | null; early: boolean; line: string | null; confidence: string | null; bands?: RingBand[];
  /** `false` (the reveal card only) hides the preliminary line while keeping the header tag; Home never passes it. */
  preliminary?: boolean; preliminaryLine?: string | null | false; onPress?: () => void;
  footer?: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const tag = early ? HOME_COPY.earlyRead : preliminary && score != null ? HOME_COPY.preliminary : null;
  const Box: React.ElementType = onPress ? Pressable : View;
  return (
    <Box style={[styles.block, style]} {...(onPress ? { onPress, accessibilityRole: "button" } : {})} accessibilityLabel={score != null ? `Your marketability, M.I.A. ${score} out of 850${preliminary ? `, ${HOME_COPY.preliminary.toLowerCase()}` : ""}` : "Your marketability"} testID={testID}>
      <Eyebrow onDark>{`${HOME_COPY.intelligence}${tag ? ` · ${tag}` : ""}`}</Eyebrow>
      <View style={styles.blockRow}>
        <IntelligenceRing score={score} size={156} dark glow quiet={early} bands={early ? undefined : bands} />
        <View style={styles.blockText}>
          {line ? <Text style={styles.read}>{line}</Text> : null}
          {confidence ? <ConfidenceLine text={confidence} onDark /> : null}
          {preliminary && score != null && preliminaryLine !== false ? <Text style={styles.prelim} testID="home-preliminary">{preliminaryLine || HOME_COPY.preliminaryLine}</Text> : null}
        </View>
      </View>
      {bands && bands.length && !early ? <RingLegend dark /> : null}
      {footer !== undefined ? footer : onPress ? <LinkText onPress={onPress} onDark>{HOME_COPY.openIntelligence}</LinkText> : null}
    </Box>
  );
}

/** A row's mark: the brand's logo for a deal, else one black icon tile per kind (DESIGN.md §11 Icon tile). */
const KIND_ICON: Record<NextKind, IconName> = {
  booking_request: "calendar", serious_offer: "briefcase", deal_waiting: "briefcase", payout_setup: "credit-card",
  money_paid: "dollar-sign", card_views: "eye", mila_suggestion: "message-circle",
};

/**
 * "What matters next" (app layout B): ONE ranked list across every tab, five rows at most (lib/whatMattersNext.rankNext).
 * Each row opens the screen where it is handled; nothing here accepts, declines or replies. More than five waiting =>
 * "See all N" (Opportunities). Empty => "Nothing waiting on you", one line, and the link to her Plan.
 */
export function NextList({ ranked, now, onOpen, onSeeAll, onPlan }: { ranked: RankedNext; now: Date; onOpen: (item: NextCandidate) => void; onSeeAll: () => void; onPlan: () => void }) {
  const reduced = useReducedMotion();
  return (
    <View style={styles.section} testID="home-next">
      <SectionHead title={NEXT_COPY.heading} link={ranked.seeAll ? NEXT_COPY.seeAll(ranked.urgent) : null} onLink={onSeeAll} style={styles.in} />
      {ranked.shown.length ? (
        <Card bold style={styles.list}>
          {ranked.shown.map((item, i) => {
            const copy = rowCopy(item, now);
            const last = i === ranked.shown.length - 1;
            const brandMark = (item.kind === "deal_waiting" || item.kind === "serious_offer") && !!item.brandName;
            return (
              <Pressable
                key={item.key}
                onPress={() => onOpen(item)}
                accessibilityRole="button"
                accessibilityLabel={[copy.title, copy.source, copy.clock].filter(Boolean).join(". ")}
                testID={`next-row-${item.key}`}
                style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed, pressed && !reduced && styles.pressed]}
              >
                {brandMark
                  ? <LogoMark bold logoUrl={item.logoUrl} name={item.brandName ?? ""} size={40} />
                  : <IconTile bold="black" icon={KIND_ICON[item.kind]} />}
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={2}>{copy.title}</Text>
                  <Text style={styles.rowMeta} numberOfLines={2}>{copy.source}</Text>
                </View>
                {copy.clock ? <Text style={styles.clock} numberOfLines={2}>{copy.clock}</Text> : null}
                <Feather name="chevron-right" size={18} color={Bold.quiet} />
              </Pressable>
            );
          })}
        </Card>
      ) : (
        <Pressable onPress={onPlan} accessibilityRole="button" accessibilityLabel={`${NEXT_COPY.empty}. ${NEXT_COPY.emptyLine}`} style={({ pressed }) => [pressed && !reduced && styles.pressed]}>
          <Card bold style={styles.empty}>
            <View style={styles.emptyText}>
              <Text style={styles.emptyTitle}>{NEXT_COPY.empty}</Text>
              <Text style={styles.emptyLine}>{NEXT_COPY.emptyLine}</Text>
            </View>
            <LinkText onPress={onPlan}>{NEXT_COPY.emptyLink}</LinkText>
          </Card>
        </Pressable>
      )}
    </View>
  );
}

const CHIP_ICON: Record<MilaChip["kind"], IconName> = { add_contract: "file-text", connect_insights: "link", share_performance: "activity" };

export function MilaChips({ chips, onPress }: { chips: MilaChip[]; onPress: (chip: MilaChip) => void }) {
  const reduced = useReducedMotion();
  if (!chips.length) return null;
  return (
    <View style={[styles.in, styles.chipsWrap]} testID="home-mila-chips">
      <View style={styles.chipsHead}>
        <Image source={MILA_STILL} style={styles.milaGlyph} accessibilityIgnoresInvertColors testID="home-mila-glyph" />
        <Eyebrow>{HOME_COPY.milaHelps}</Eyebrow>
      </View>
      <View style={styles.chips}>
        {chips.map((c) => (
          <Pressable key={c.kind} style={({ pressed }) => [pressed && styles.chipPressed, pressed && !reduced && styles.pressed]} onPress={() => onPress(c)} accessibilityRole="button" accessibilityLabel={c.label}>
            {/* Mila's own surface: the frosted chip of the Ask Mila overlay (DESIGN.md §16), ink text, a quiet glyph. */}
            <Frost radius={MILA_CHIP_RADIUS} style={styles.chip} testID={`home-mila-chip-${c.kind}`}>
              <Feather name={CHIP_ICON[c.kind]} size={14} color={Bold.quiet} />
              <Text style={styles.chipText}>{c.label}</Text>
            </Frost>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block:        { backgroundColor: Bold.ink, paddingHorizontal: Bold.gutter, paddingTop: 18, paddingBottom: 16, gap: 12 },
  blockRow:     { flexDirection: "row", alignItems: "center", gap: 14 },
  blockText:    { flex: 1, minWidth: 0, gap: 6 },
  read:         { ...BoldType.read, color: Bold.onDarkSoft },
  prelim:       { ...BoldType.caption, color: Bold.onDarkMute },
  in:           { paddingHorizontal: Bold.gutter },
  section:      { marginTop: 16, gap: 10 },
  list:         { marginHorizontal: Bold.gutter },
  row:          { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line, backgroundColor: Bold.paper },
  rowLast:      { borderBottomWidth: 0 },
  rowPressed:   { backgroundColor: Bold.ground },
  rowText:      { flex: 1, minWidth: 0, gap: 2 },
  rowTitle:     { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:      { ...BoldType.rowMeta, color: Bold.mute },
  clock:        { ...BoldType.caption, color: Bold.blue, maxWidth: 96, textAlign: "right" },
  empty:        { marginHorizontal: Bold.gutter, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  emptyText:    { flex: 1, gap: 2 },
  emptyTitle:   { ...BoldType.body, color: Bold.ink2 },
  emptyLine:    { ...BoldType.caption, color: Bold.mute },
  chipsWrap:    { marginTop: 18, gap: 10 },
  chipsHead:    { flexDirection: "row", alignItems: "center", gap: 6 },
  milaGlyph:    { width: MILA_GLYPH, height: MILA_GLYPH, borderRadius: MILA_GLYPH / 2, backgroundColor: Bold.ground },
  chips:        { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip:         { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, minHeight: 34 },
  chipText:     { ...BoldType.chipLine, color: Bold.ink },
  chipPressed:  { opacity: 0.8 },
  pressed:      { transform: [{ scale: Bold.pressScale }] },
});
